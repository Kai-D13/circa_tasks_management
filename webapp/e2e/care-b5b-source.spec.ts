import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { BigQueryError, type BqParam } from '../lib/bigquery/query'
import {
  CARE_N3_MAX_WINDOWS, CARE_N3_OPEN_HI, CareN3SourceError, assertN3Fields, buildN3OrdersSql, buildN3PreflightSql,
  buildN3SampleSql, careN3ErrorCode, collectN3Orders, prepareN3Windows, runN3Preflight,
  type CareN3RunQuery, type CareN3Window,
} from '../lib/care/orders/source'
import { CARE_N3_QA_FAKE_ID, careN3QaGate, runCareN3Qa } from '../lib/care/orders/qaView'
import { fakeBq, type ViewRow } from './careN3Fake'

// CRM-CSKH B5b.1 — adapter N3 trên VIEW Q-96 (SPEC §B5b, finding P1-2): SQL khoảng (lo, hi] + EXISTS, ba mảng
// named params cùng offset, đọc đủ mọi lô trước khi trả, fail-closed bằng mã an toàn; route QA đọc VIEW thật
// chỉ ở development. BigQuery được mô phỏng TRONG BỘ NHỚ: mock áp đúng vị từ SQL (type, min_care_at, khoảng)
// lên dữ liệu giả để kiểm luôn cách ghép tham số. Không dữ liệu khách thật.

const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')
const TABLE = 'qa-proj-123.qa_ds.qa_completed_order'

// Dữ liệu VIEW giả: K1 care 05/10 03:00:00.000400 (lo) và lượt kế tiếp 10/10 03:00 (hi).
const VIEW: ViewRow[] = [
  { entity_id: 'QA-K1', order_code: 'DHC-EQLO', completed_at: '2026-10-05T03:00:00.000Z', type: 'OFFLINE' },  // trước lo (ms) ⇒ loại
  { entity_id: 'QA-K1', order_code: 'DHC-POS1', completed_at: '2026-10-06T01:00:00.000Z', type: 'OFFLINE' },  // trong khoảng (POS)
  { entity_id: 'QA-K1', order_code: 'DHC-ONL1', completed_at: '2026-10-07T01:00:00.000Z', type: 'ONLINE' },   // trong khoảng (online)
  { entity_id: 'QA-K1', order_code: 'DHC-EQHI', completed_at: '2026-10-10T03:00:00.000Z', type: 'OFFLINE' },  // = hi ⇒ LẤY
  { entity_id: 'QA-K1', order_code: 'DHC-AFTER', completed_at: '2026-10-10T03:00:01.000Z', type: 'OFFLINE' }, // sau hi ⇒ thuộc lượt sau, loại
  { entity_id: 'QA-K2', order_code: 'DHC-K2', completed_at: '2026-10-08T00:00:00.000Z', type: 'OFFLINE' },
  { entity_id: 'QA-K9', order_code: 'DHC-OTHER', completed_at: '2026-10-08T00:00:00.000Z', type: 'OFFLINE' }, // khách không phải ứng viên
  { entity_id: 'QA-K2', order_code: 'DHC-B2B', completed_at: '2026-10-08T00:00:00.000Z', type: 'B2B' },       // type ngoài VIEW ⇒ loại
]
const W: CareN3Window[] = [
  { customerExternalId: 'QA-K1', lo: '2026-10-05T03:00:00.000400Z', hi: '2026-10-10T03:00:00Z' },
  { customerExternalId: 'QA-K2', lo: '2026-10-07T00:00:00Z', hi: null },
]

test.describe('care B5b.1 — SQL + tham số khoảng (lo, hi] @desktop', () => {
  test('SQL production: ba alias, EXISTS theo khoảng, tham số NAMED, không created_at/đổi múi giờ; tên bảng kiểm lại', () => {
    const sql = buildN3OrdersSql(TABLE)
    expect(sql).toContain('FROM `qa-proj-123.qa_ds.qa_completed_order` AS v')
    for (const s of ['UNNEST(@customer_ids) AS id WITH OFFSET i', 'JOIN UNNEST(@from_ts) AS lo WITH OFFSET j ON i = j', 'JOIN UNNEST(@to_ts) AS hi WITH OFFSET k ON i = k',
      "WHERE v.type IN ('ONLINE', 'OFFLINE')", 'AND v.completed_at > @min_care_at', 'AND v.completed_at > w.lo', 'AND v.completed_at <= w.hi',
      'v.entity_id AS customer_external_id', 'v.order_code AS order_key', "FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', v.completed_at, 'UTC') AS ordered_at",
      'ORDER BY v.completed_at, v.order_code']) expect(sql, s).toContain(s)
    expect(sql).toMatch(/AND EXISTS \(\s*SELECT 1 FROM windows AS w/)
    expect(sql).not.toMatch(/created_at|Asia\/Ho_Chi_Minh|INTERVAL 7 HOUR|TIMESTAMP_SUB|DATETIME\(/) // Q-100 A: không đổi giờ trong app
    expect(sql).not.toMatch(/SELECT \*|v\.type AS/)
    for (const bad of ['p.d.t`; DROP', 'a.b', 'qa-proj-123.ds.t$20261001', 'qa-proj-123.ds.t x']) {
      expect(() => buildN3OrdersSql(bad), bad).toThrow(CareN3SourceError)
    }
    expect(buildN3SampleSql(TABLE)).toMatch(/LIMIT 5$/)
    expect(() => buildN3SampleSql(TABLE, 50)).toThrow()
    expect(buildN3PreflightSql(TABLE)).toContain('TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL 5 MINUTE)')
    expect(buildN3PreflightSql(TABLE)).toContain('TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(v.completed_at), MINUTE) AS max_age_minutes')
  })

  test('tham số: ba mảng cùng độ dài/thứ tự, ISO micro giây, hi mở = sentinel, khoảng rỗng bị bỏ, đếm khách/khoảng riêng', () => {
    const p = prepareN3Windows([
      ...W,
      { customerExternalId: 'QA-K1', lo: '2026-10-10T03:00:00Z', hi: null },                         // khoảng thứ 2 cùng khách (nhiều tháng)
      { customerExternalId: 'QA-K3', lo: '2026-10-08T00:00:00Z', hi: '2026-10-08T00:00:00Z' },        // hai lượt cùng mốc ⇒ rỗng
      { customerExternalId: 'QA-K4', lo: '2026-10-08T07:00:00+07:00', hi: '2026-10-09T00:00:00Z' },   // offset ⇒ UTC
    ])
    expect(p.windows).toBe(4)
    expect(p.customers).toBe(3)
    expect(p.emptyWindows).toBe(1)
    const v = (n: string) => (p.params.find((x) => x.name === n) as Extract<BqParam, { type: 'ARRAY' }>).values
    expect(v('customer_ids')).toEqual(['QA-K1', 'QA-K2', 'QA-K1', 'QA-K4'])
    expect(v('from_ts')).toEqual(['2026-10-05T03:00:00.000400Z', '2026-10-07T00:00:00.000000Z', '2026-10-10T03:00:00.000000Z', '2026-10-08T00:00:00.000000Z'])
    expect(v('to_ts')).toEqual(['2026-10-10T03:00:00.000000Z', CARE_N3_OPEN_HI, CARE_N3_OPEN_HI, '2026-10-09T00:00:00.000000Z'])
    expect(p.params.find((x) => x.name === 'min_care_at')).toEqual({ name: 'min_care_at', type: 'TIMESTAMP', value: '2026-10-05T03:00:00.000400Z' })
    expect(p.params.find((x) => x.name === 'from_ts')).toMatchObject({ type: 'ARRAY', arrayType: 'TIMESTAMP' })
    expect(prepareN3Windows([]).params).toEqual([])
    for (const bad of [{ customerExternalId: ' QA', lo: W[0].lo, hi: null }, { customerExternalId: 'QA', lo: '2026-10-05', hi: null },
      { customerExternalId: 'QA', lo: W[0].lo, hi: 'x' }, { customerExternalId: '', lo: W[0].lo, hi: null }]) {
      expect(() => prepareN3Windows([bad]), JSON.stringify(bad)).toThrow(CareN3SourceError)
    }
    const many = Array.from({ length: CARE_N3_MAX_WINDOWS + 1 }, (_, i) => ({ customerExternalId: `K${i}`, lo: W[0].lo, hi: null }))
    expect(() => prepareN3Windows(many)).toThrow(expect.objectContaining({ code: 'windows_over_cap' }))
  })
})

test.describe('care B5b.1 — collectN3Orders (BigQuery giả) @desktop', () => {
  test('biên: = lo loại, = hi lấy, sau hi loại; POS + online; khách lạ/type khác loại; đọc rồi parse một lần', async () => {
    const bq = fakeBq(VIEW)
    const r = await collectN3Orders(TABLE, W, bq.run)
    expect(r.orders.map((o) => o.order_key)).toEqual(['DHC-POS1', 'DHC-ONL1', 'DHC-K2', 'DHC-EQHI'])
    expect(r.orders.find((o) => o.order_key === 'DHC-EQHI')!.ordered_at).toBe('2026-10-10T03:00:00.000000Z')
    expect(r.stats).toMatchObject({ windows: 2, customers: 2, emptyWindows: 0, jobs: 1, pages: 1, rows: 4, bytesProcessed: 2_000_000 })
    expect(bq.calls).toHaveLength(1)
    // Lô thứ 2 (khoảng sau của K1) lấy đúng DHC-AFTER — đơn không lặp giữa hai khoảng.
    const r2 = await collectN3Orders(TABLE, [...W, { customerExternalId: 'QA-K1', lo: '2026-10-10T03:00:00Z', hi: null }], fakeBq(VIEW).run)
    expect(r2.orders.map((o) => o.order_key).sort()).toEqual(['DHC-AFTER', 'DHC-EQHI', 'DHC-K2', 'DHC-ONL1', 'DHC-POS1'])
  })

  test('chia lô: mọi lô đọc xong mới trả; lô CUỐI lỗi ⇒ ném mã an toàn, không trả dữ liệu lô đầu', async () => {
    const ok = fakeBq(VIEW)
    const r = await collectN3Orders(TABLE, W, ok.run, { perQuery: 1 })
    expect(ok.calls).toHaveLength(2)
    expect(ok.calls.map((c) => (c.params.find((p) => p.name === 'customer_ids') as { values: string[] }).values)).toEqual([['QA-K1'], ['QA-K2']])
    expect(ok.calls.map((c) => (c.params.find((p) => p.name === 'min_care_at') as { value: string }).value)).toEqual(['2026-10-05T03:00:00.000400Z', '2026-10-07T00:00:00.000000Z'])
    expect(r.orders).toHaveLength(4)
    for (const [failWith, code] of [
      [new BigQueryError('http', 'Access Denied: raw', 403), 'access_denied'], [new BigQueryError('http', 'Not found: raw', 404), 'not_found'],
      [new BigQueryError('http', 'Syntax error: raw', 400), 'bad_query'], [new BigQueryError('http', 'boom', 503), 'http'],
      [new BigQueryError('timeout', 'quá hạn'), 'timeout'], [new BigQueryError('malformed', 'thiếu trang'), 'malformed'], [new Error('ECONNRESET'), 'unknown'],
    ] as const) {
      const bad = fakeBq(VIEW, { failOnCall: 2, failWith })
      const err = await collectN3Orders(TABLE, W, bad.run, { perQuery: 1 }).catch((e) => e)
      expect(err, code).toBeInstanceOf(CareN3SourceError)
      expect(err.code).toBe(code)
      expect(String(err.message)).not.toMatch(/raw|Access Denied|Syntax/) // không mang message thô
    }
  })

  test('không khoảng nào ⇒ không gọi BigQuery; khoảng rỗng ⇒ bỏ', async () => {
    const bq = fakeBq(VIEW)
    const r = await collectN3Orders(TABLE, [{ customerExternalId: 'QA-K3', lo: '2026-10-08T00:00:00Z', hi: '2026-10-08T00:00:00Z' }], bq.run)
    expect(bq.calls).toHaveLength(0)
    expect(r.orders).toEqual([])
    expect(r.stats).toMatchObject({ windows: 0, emptyWindows: 1, jobs: 0 })
  })

  test('schema dư/thiếu ⇒ schema_mismatch; NULL / trùng DHC mâu thuẫn ⇒ parse_failed (chỉ mã); trùng y hệt ⇒ bỏ; vượt trần ⇒ row_limit', async () => {
    await expect(collectN3Orders(TABLE, W, fakeBq(VIEW, { extraField: true }).run)).rejects.toMatchObject({ code: 'schema_mismatch' })
    expect(() => assertN3Fields(['customer_external_id', 'order_key'])).toThrow(CareN3SourceError)
    expect(() => assertN3Fields(['order_key', 'customer_external_id', 'ordered_at'])).toThrow(CareN3SourceError)
    const withNull = fakeBq([...VIEW, { entity_id: 'QA-K2', order_code: null, completed_at: '2026-10-08T01:00:00.000Z', type: 'OFFLINE' }])
    const e1 = await collectN3Orders(TABLE, W, withNull.run).catch((e) => e)
    expect(e1).toMatchObject({ code: 'parse_failed', parseCodes: ['ORDER_KEY_INVALID'] })
    const conflict = fakeBq([...VIEW, { entity_id: 'QA-K2', order_code: 'DHC-K2', completed_at: '2026-10-08T05:00:00.000Z', type: 'OFFLINE' }])
    await expect(collectN3Orders(TABLE, W, conflict.run)).rejects.toMatchObject({ code: 'parse_failed', parseCodes: ['ORDER_KEY_CONFLICT'] })
    const same = await collectN3Orders(TABLE, W, fakeBq([...VIEW, { ...VIEW[5] }]).run)
    expect(same.duplicatesDropped).toBe(1)
    expect(JSON.stringify(e1)).not.toMatch(/QA-K|DHC-/)
    const many: ViewRow[] = Array.from({ length: 20_001 }, (_, i) => ({ entity_id: 'QA-K2', order_code: `DHC-${i}`, completed_at: '2026-10-08T00:00:00.000Z', type: 'OFFLINE' }))
    await expect(collectN3Orders(TABLE, W, fakeBq(many).run)).rejects.toMatchObject({ code: 'row_limit' })
  })

  test('biên trần (PM audit Lô 3 P2): 20.000 + lô sau rỗng ⇒ THÀNH CÔNG; 20.000 + 1 ⇒ row_limit; 20.001 một lô ⇒ row_limit', async () => {
    test.setTimeout(120_000)
    const k1: ViewRow[] = Array.from({ length: 20_000 }, (_, i) => ({ entity_id: 'QA-K1', order_code: `DHC-${i}`, completed_at: '2026-10-06T00:00:00.000Z', type: 'OFFLINE' }))
    const exact = fakeBq(k1) // K2 không có đơn ⇒ lô 2 rỗng
    const r = await collectN3Orders(TABLE, W, exact.run, { perQuery: 1 })
    expect(r.orders).toHaveLength(20_000)
    expect(exact.calls.map((c) => c.maxRows)).toEqual([20_000, 0]) // lô 2 vẫn chạy với maxRows 0
    const over = fakeBq([...k1, { entity_id: 'QA-K2', order_code: 'DHC-K2', completed_at: '2026-10-08T00:00:00.000Z', type: 'OFFLINE' }])
    await expect(collectN3Orders(TABLE, W, over.run, { perQuery: 1 })).rejects.toMatchObject({ code: 'row_limit' })
    const single = fakeBq([...k1, { entity_id: 'QA-K1', order_code: 'DHC-X', completed_at: '2026-10-06T00:00:00.000Z', type: 'OFFLINE' }])
    await expect(collectN3Orders(TABLE, W, single.run)).rejects.toMatchObject({ code: 'row_limit' })
  })

  test('maxRows của từng job giảm theo số dòng đã đọc (tổng ≤ 20.000)', async () => {
    const bq = fakeBq(VIEW)
    await collectN3Orders(TABLE, W, bq.run, { perQuery: 1 })
    expect(bq.calls.map((c) => c.maxRows)).toEqual([20_000, 20_000 - 3])
  })

  test('preflight Q-100: đơn ở tương lai > 5 phút được đếm; tuổi đơn mới nhất chỉ là metric', async () => {
    const p = await runN3Preflight(TABLE, fakeBq(VIEW, { now: '2026-10-10T03:10:00.000Z' }).run)
    expect(p).toEqual({ futureCount: 0, maxAgeMinutes: 9, bytesProcessed: 2_000_000 })
    // Đồng hồ 20:00Z: hai đơn 10/10 03:00Z nằm sau hiện tại > 5 phút (kiểu lỗi +7h của Q-100).
    const fut = await runN3Preflight(TABLE, fakeBq(VIEW, { now: '2026-10-09T20:00:00.000Z' }).run)
    expect(fut.futureCount).toBe(2)
    // Trong ngưỡng 5 phút ⇒ không tính là tương lai.
    expect((await runN3Preflight(TABLE, fakeBq(VIEW, { now: '2026-10-10T02:56:00.000Z' }).run)).futureCount).toBe(0)
    await expect(runN3Preflight(TABLE, fakeBq(VIEW, { failOnCall: 1 }).run)).rejects.toMatchObject({ code: 'access_denied' })
    expect(careN3ErrorCode(new CareN3SourceError('no_data'))).toBe('no_data')
  })
})

test.describe('care B5b.1 — QA đọc VIEW thật (logic route) @desktop', () => {
  test('cổng: 404 ngoài development hoặc thiếu UI_CATALOG (kể cả đúng secret); 401 sai/thiếu secret', () => {
    const env = { NODE_ENV: 'development', UI_CATALOG: '1', CRON_SECRET: 's3cret' }
    expect(careN3QaGate(env, 'Bearer s3cret')).toEqual({ status: 'ok' })
    expect(careN3QaGate({ ...env, NODE_ENV: 'production' }, 'Bearer s3cret')).toEqual({ status: 404 })
    expect(careN3QaGate({ ...env, NODE_ENV: 'test' }, 'Bearer s3cret')).toEqual({ status: 404 })
    expect(careN3QaGate({ ...env, UI_CATALOG: undefined }, 'Bearer s3cret')).toEqual({ status: 404 })
    expect(careN3QaGate(env, 'Bearer sai')).toEqual({ status: 401 })
    expect(careN3QaGate(env, null)).toEqual({ status: 401 })
    expect(careN3QaGate({ ...env, CRON_SECRET: '' }, 'Bearer ')).toEqual({ status: 401 })
    expect(careN3QaGate(env, 'Bearer s3cres')).toEqual({ status: 401 }) // cùng độ dài, khác 1 ký tự
    expect(careN3QaGate(env, 'bearer s3cret')).toEqual({ status: 401 })
  })

  test('báo cáo QA: mẫu + đường tham số ID giả (0 dòng) + preflight; không ID/DHC/timestamp/message thô trong JSON', async () => {
    const good = await runCareN3Qa(TABLE, fakeBq(VIEW, { now: '2026-10-10T03:10:00Z' }).run)
    expect(good.readyForSyncNote).toMatch(/kiểm tra TỰ ĐỘNG[\s\S]*KHÔNG phải duyệt đồng bộ[\s\S]*Q-100/)
    expect(good).toMatchObject({ ok: true, readyForSync: true, fields: ['customer_external_id', 'order_key', 'ordered_at'], sampleCount: 5, pages: 1, bytesProcessed: 2_000_000,
      paramQuery: { ok: true, rows: 0 }, freshness: { ok: true, futureCount: 0 } })
    const json = JSON.stringify(good)
    expect(json).not.toMatch(/QA-K|DHC-|2026-10-|T0\d:/)
    expect(json).not.toContain(CARE_N3_QA_FAKE_ID)
    const empty = await runCareN3Qa(TABLE, fakeBq([]).run)
    expect(empty).toMatchObject({ ok: false, code: 'no_data', sampleCount: 0 })
    const denied = await runCareN3Qa(TABLE, fakeBq(VIEW, { failOnCall: 1 }).run)
    expect(denied).toMatchObject({ ok: false, code: 'access_denied' })
    expect(JSON.stringify(denied)).not.toMatch(/raw|Access Denied/)
    const future = await runCareN3Qa(TABLE, fakeBq(VIEW, { now: '2026-10-09T20:00:00Z' }).run)
    expect(future).toMatchObject({ ok: true, readyForSync: false, freshness: { ok: false, code: 'source_time_future', futureCount: 2 } })
    expect(empty.readyForSync).toBe(false)
  })

  test('nguồn: route chỉ dev + UI_CATALOG + Bearer; không Supabase; proxy bỏ qua đăng nhập đúng một pathname khi development', () => {
    const route = read('app/api/qa/care-n3-view/route.ts')
    const body = /export async function GET\(request: NextRequest\) \{\n([\s\S]*?)\n\}/.exec(route)![1]
    expect(body.trimStart()).toMatch(/^const gate = careN3QaGate\(process\.env, request\.headers\.get\('authorization'\)\)/)
    expect(body.indexOf("gate.status === 404")).toBeLessThan(body.indexOf('careN3Table()'))
    const code = route.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
    expect(code).not.toMatch(/supabase|createClient|isCareEnabled|isCareSyncEnabled|lib\/care\/flags/i)
    expect(route).not.toMatch(/console\.(log|warn|error)\([^)]*(rows|orders|err\b|message)/)
    const proxy = read('proxy.ts')
    expect(proxy).toContain("if (process.env.NODE_ENV === 'development' && pathname === '/api/qa/care-n3-view') return NextResponse.next()")
    expect(proxy.match(/\/api\/qa\//g)).toHaveLength(1)
    expect(fs.existsSync(path.join(ROOT, 'app/api/cron/qa-care-n3-view'))).toBe(false)
    // Adapter thuần: không Next/Supabase/server-only; server wrapper mới dùng SA.
    for (const f of ['lib/care/orders/source.ts', 'lib/care/orders/qaView.ts']) {
      expect(read(f), f).not.toMatch(/from ['"](next|@supabase|@\/lib\/supabase|server-only|@\/lib\/bigquery\/client)/)
    }
    expect(read('lib/care/server/n3Source.ts')).toMatch(/^import 'server-only'/)
    expect(read('lib/care/server/n3Source.ts')).toContain("runBigQueryPaged(sql, params, opts)")
  })
})
