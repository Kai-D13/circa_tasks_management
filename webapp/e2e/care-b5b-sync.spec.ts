import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import { BigQueryError } from '../lib/bigquery/query'
import { CARE_N3_MAX_WINDOWS, CARE_N3_WINDOWS_PER_QUERY, CareN3SourceError, collectN3Orders, runN3Preflight, type CareN3Window } from '../lib/care/orders/source'
import {
  CARE_SYNC_DB_TIMEOUT_MS, CARE_SYNC_RPC_TIMEOUT_MS, CARE_SYNC_SNAPSHOT_MAX_AGE_MS,
  careSyncSourceCode, parseSyncApply, parseSyncCandidates, runCareOrdersSync,
  type CareOrdersSyncDeps, type CareSyncCandidates,
} from '../lib/care/orders/sync'
import { normalizeN3Timestamp } from '../lib/care/orders/n3'
import { fakeBq, type ViewRow } from './careN3Fake'

// CRM-CSKH B5b.2 — cron care-orders-sync (SPEC §B5b.2): (1) điều phối thuần với deps giả; (2) end-to-end trên
// PGlite với 3 RPC THẬT của migration 114 + BigQuery giả; (3) nguồn route cron. Cờ OFF; không BigQuery/DB thật.

const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')
const HAS_PGLITE = fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite'))
const TABLE = 'qa-proj-123.qa_ds.qa_completed_order'
const SNAP = '2026-10-09T12:00:00.000000Z'

function fakeDeps(over: Partial<CareOrdersSyncDeps> = {}) {
  const log: string[] = []
  const cand: CareSyncCandidates = { snapshotAt: SNAP, windows: 2, customers: 2, items: [
    { customerExternalId: 'QA-K1', lo: '2026-10-05T03:00:00Z', hi: null }, { customerExternalId: 'QA-K2', lo: '2026-10-06T03:00:00Z', hi: null }] }
  const deps: CareOrdersSyncDeps = {
    candidates: async () => { log.push('candidates'); return cand },
    preflight: async () => { log.push('preflight'); return { futureCount: 0, maxAgeMinutes: 25, bytesProcessed: 1 } },
    fetchOrders: async () => {
      log.push('fetch')
      return { orders: [{ customer_external_id: 'QA-K1', order_key: 'DHC-1', ordered_at: '2026-10-06T00:00:00.000000Z' }], duplicatesDropped: 0,
        stats: { windows: 2, customers: 2, emptyWindows: 0, jobs: 1, pages: 1, rows: 1, bytesProcessed: 2_000_000, elapsedMs: 5 } }
    },
    apply: async (orders, snap) => { log.push(`apply:${orders.length}:${snap}`); return { orders: orders.length, ordersWritten: orders.length, attribution: { scope: 1, upserted: 1, deleted: 0 }, queueDrained: 0 } },
    fail: async (code, snap) => { log.push(`fail:${code}:${snap}`); return true },
    now: () => 1_000,
  }
  // Hàm override cũng ghi tên bước vào log (trừ apply/fail — đã ghi kèm tham số ở bản gốc hoặc test tự kiểm).
  for (const [k, fn] of Object.entries(over) as [keyof CareOrdersSyncDeps, (...a: unknown[]) => unknown][]) {
    ;(deps as unknown as Record<string, unknown>)[k] = k === 'now' ? fn : (...a: unknown[]) => { log.push(k === 'fetchOrders' ? 'fetch' : k); return fn(...a) }
  }
  return { deps, log }
}

test.describe('care B5b.2 — điều phối một lượt đồng bộ (deps giả) @desktop', () => {
  test('thành công: ứng viên ⇒ preflight ⇒ đọc ⇒ apply với snapshot của DB; báo riêng số khoảng/khách; không ID trong kết quả', async () => {
    const { deps, log } = fakeDeps()
    const r = await runCareOrdersSync(deps)
    expect(log).toEqual(['candidates', 'preflight', 'fetch', `apply:1:${SNAP}`])
    expect(r).toMatchObject({ ok: true, snapshotAt: SNAP, windows: 2, customers: 2, orders: 1, ordersWritten: 1, jobs: 1, bytesProcessed: 2_000_000,
      preflight: { futureCount: 0, maxAgeMinutes: 25 }, attribution: { upserted: 1 }, failRecorded: null })
    expect(JSON.stringify(r)).not.toMatch(/QA-K|DHC-/)
  })

  test('không ứng viên ⇒ KHÔNG gọi BigQuery, apply lô rỗng (đã đọc đủ phạm vi ⇒ thành công)', async () => {
    const { deps, log } = fakeDeps({ candidates: async () => ({ snapshotAt: SNAP, windows: 0, customers: 0, items: [] }) })
    const r = await runCareOrdersSync(deps)
    expect(log).toEqual(['candidates', `apply:0:${SNAP}`])
    expect(r.ok).toBe(true)
  })

  test('fail-closed: quá trần / mốc tương lai / lỗi nguồn (kể cả lô cuối) / lỗi apply / lỗi ứng viên ⇒ chỉ ghi MÃ, không apply', async () => {
    const cases: [string, Partial<CareOrdersSyncDeps>, string, string[]][] = [
      ['quá trần khoảng (Q-98)', { candidates: async () => ({ snapshotAt: SNAP, windows: 3, customers: 1, items: [] }) }, 'CANDIDATES_OVER_CAP', []],
      ['mốc hoàn tất ở tương lai (Q-100)', { preflight: async () => ({ futureCount: 1035, maxAgeMinutes: -367, bytesProcessed: 1 }) }, 'SOURCE_TIME_FUTURE', ['preflight']],
      ['preflight lỗi quyền', { preflight: async () => { throw new BigQueryError('http', 'raw', 403) } }, 'SOURCE_ACCESS_DENIED', ['preflight']],
      ['lô cuối lỗi', { fetchOrders: async () => { throw new CareN3SourceError('timeout') } }, 'SOURCE_TIMEOUT', ['preflight', 'fetch']],
      ['parser lỗi', { fetchOrders: async () => { throw new CareN3SourceError('parse_failed', ['ORDER_KEY_CONFLICT']) } }, 'SOURCE_PARSE_FAILED', ['preflight', 'fetch']],
      ['apply lỗi (rollback DB)', { apply: async () => { throw new Error('db') } }, 'DB_APPLY_FAILED', ['preflight', 'fetch', 'apply']],
    ]
    for (const [why, over, code, steps] of cases) {
      const { deps, log } = fakeDeps(over)
      const r = await runCareOrdersSync(deps, why.startsWith('quá trần') ? 2 : undefined)
      expect(r, why).toMatchObject({ ok: false, code, failRecorded: true })
      expect(log.filter((x) => !x.startsWith('candidates') && !x.startsWith('fail')), why).toEqual(steps)
      expect(log.at(-1), why).toBe(`fail:${code}:${SNAP}`)
    }
    const { deps, log } = fakeDeps({ candidates: async () => { throw new Error('db down') } })
    const r = await runCareOrdersSync(deps)
    expect(r).toMatchObject({ ok: false, code: 'DB_CANDIDATES_FAILED', snapshotAt: null })
    expect(log).toEqual(['candidates', `fail:DB_CANDIDATES_FAILED:${new Date(1_000).toISOString()}`])
    // Ghi mã cũng lỗi ⇒ không ném, failRecorded=false.
    const swallow = await runCareOrdersSync(fakeDeps({ apply: async () => { throw new Error('x') }, fail: async () => { throw new Error('y') } }).deps)
    expect(swallow).toMatchObject({ ok: false, code: 'DB_APPLY_FAILED', failRecorded: false })
  })

  test('mã lưu DB khớp CHECK care_sync_state.last_error; parse jsonb RPC fail-closed', () => {
    for (const c of ['access_denied', 'timeout', 'row_limit', 'schema_mismatch', 'parse_failed', 'table_missing'] as const) {
      expect(careSyncSourceCode(c)).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/)
    }
    expect(parseSyncCandidates({ snapshot_at: SNAP, windows: 1, customers: 1, items: [['QA-K1', '2026-10-05T03:00:00.000000Z', null]] }))
      .toEqual({ snapshotAt: SNAP, windows: 1, customers: 1, items: [{ customerExternalId: 'QA-K1', lo: '2026-10-05T03:00:00.000000Z', hi: null }] })
    for (const bad of [null, [], { snapshot_at: '2026-10-09', windows: 0, customers: 0, items: [] }, { snapshot_at: SNAP, windows: -1, customers: 0, items: [] },
      { snapshot_at: SNAP, windows: 1, customers: 1, items: [['QA', 1, null]] }, { snapshot_at: SNAP, windows: 1, customers: 1, items: [['QA', SNAP]] }]) {
      expect(() => parseSyncCandidates(bad), JSON.stringify(bad)).toThrow()
    }
    expect(parseSyncApply({ orders: 2, orders_written: 1, attribution: { scope: 2, upserted: 1, deleted: 0 }, queue_drained: 3 }))
      .toEqual({ orders: 2, ordersWritten: 1, attribution: { scope: 2, upserted: 1, deleted: 0 }, queueDrained: 3 })
    expect(() => parseSyncApply({ orders: 2 })).toThrow()
  })
})

/* eslint-disable @typescript-eslint/no-explicit-any */
test.describe('care B5b.2 — end-to-end PGlite (RPC 114 thật + BigQuery giả) @desktop', () => {
  test.skip(!HAS_PGLITE, 'chưa cài PGlite — npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')

  test('đơn đến VIEW muộn · lặp idempotent · lỗi lô cuối giữ dữ liệu cũ · mốc tương lai chặn · quá trần · chạy chồng không lùi mốc', async () => {
    test.setTimeout(300_000)
    const { PGlite } = await import('@electric-sql/pglite')
    const L: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
    const db: any = await L.freshDb(PGlite)
    const U = L.U, P10 = '2026-10-01'
    const svc = async (sql: string, params: unknown[] = []) => L.as(db, null, async () => (await db.query(sql, params)).rows[0].r, 'service_role')
    expect((await L.finalize(db, await L.stage(db, [L.row('QA-S1', 'QAOS01', L.EA, 'P1'), L.row('QA-S2', 'QAOS01', L.EA, 'P1'), L.row('QA-S3', 'QAOS02', L.EC, 'P1')], { period: P10 }), U.mkt, '2026-10-01')).status).toBe('committed')
    const term = async (ext: string, at: string) => db.query(`
      INSERT INTO public.care_interactions (task_id, customer_id, actor_id, assignee_id, store_id, period_month, outcome, is_terminal, note, is_test, created_at)
      SELECT t.id, t.customer_id, t.assignee_id, t.assignee_id, t.store_id, t.period_month, 'INTERESTED', true, 'QA', t.is_test, $2::timestamptz
      FROM public.care_tasks t JOIN public.care_customers c ON c.id = t.customer_id WHERE c.external_id = $1`, [ext, at])
    await term('QA-S1', '2026-10-02T03:00:00Z')
    await term('QA-S2', '2026-10-03T03:00:00Z')
    await term('QA-S3', '2026-10-04T03:00:00Z')
    const view: ViewRow[] = [
      { entity_id: 'QA-S1', order_code: 'DHC-S1', completed_at: '2026-10-05T00:00:00.000Z', type: 'OFFLINE' },
      { entity_id: 'QA-S2', order_code: 'DHC-S2-BEFORE', completed_at: '2026-10-01T00:00:00.000Z', type: 'OFFLINE' }, // trước care ⇒ không lấy
    ]
    const nowIso = new Date().toISOString()
    const depsFor = (bq: ReturnType<typeof fakeBq>, perQuery?: number): CareOrdersSyncDeps => ({
      candidates: async (cap) => parseSyncCandidates(await svc(`SELECT public.care_order_sync_candidates($1) r`, [cap])),
      preflight: () => runN3Preflight(TABLE, bq.run),
      fetchOrders: (w: CareN3Window[]) => collectN3Orders(TABLE, w, bq.run, { perQuery }),
      apply: async (orders, snap) => parseSyncApply(await svc(`SELECT public.care_order_sync_apply($1::jsonb, $2::timestamptz) r`, [JSON.stringify(orders), snap])),
      fail: async (code, snap) => svc(`SELECT public.care_order_sync_fail($1, $2::timestamptz) r`, [code, snap]),
      now: () => Date.now(),
    })
    const conv = async () => L.count(db, `SELECT count(DISTINCT task_id) FROM public.care_order_attributions`)
    const state = async () => L.one(db, `SELECT last_success_at, last_error FROM public.care_sync_state WHERE source = 'n3_orders'`)

    // Lượt 1: 3 khoảng / 3 khách; chỉ S1 có đơn sau care.
    let r = await runCareOrdersSync(depsFor(fakeBq(view, { now: nowIso })))
    expect(r).toMatchObject({ ok: true, windows: 3, customers: 3, orders: 1, ordersWritten: 1, attribution: { upserted: 1 } })
    expect(await conv()).toBe(1)
    const s1 = (await state()).last_success_at
    expect(s1).not.toBeNull()

    // Lượt 2: đơn S2 (hoàn tất sau care) mới tới VIEW ⇒ Có đơn; S1 đã Có nên rời ứng viên (2 khoảng).
    view.push({ entity_id: 'QA-S2', order_code: 'DHC-S2', completed_at: '2026-10-06T00:00:00.000Z', type: 'ONLINE' })
    r = await runCareOrdersSync(depsFor(fakeBq(view, { now: nowIso })))
    expect(r).toMatchObject({ ok: true, windows: 2, customers: 2, orders: 1, ordersWritten: 1 })
    expect(await conv()).toBe(2)

    // Lượt 3: không gì mới ⇒ 0 ghi (idempotent), vẫn thành công.
    r = await runCareOrdersSync(depsFor(fakeBq(view, { now: nowIso })))
    expect(r).toMatchObject({ ok: true, windows: 1, orders: 0, ordersWritten: 0 })

    // Lượt 4: đơn S3 có trong VIEW nhưng lô CUỐI lỗi ⇒ không apply, ghi mã, Có đơn & mốc thành công giữ nguyên.
    view.push({ entity_id: 'QA-S3', order_code: 'DHC-S3', completed_at: '2026-10-07T00:00:00.000Z', type: 'OFFLINE' })
    const okBefore = (await state()).last_success_at
    r = await runCareOrdersSync(depsFor(fakeBq(view, { now: nowIso, failOnCall: 2 }), 1)) // call 1 = preflight, 2 = lô duy nhất
    expect(r).toMatchObject({ ok: false, code: 'SOURCE_ACCESS_DENIED', failRecorded: true })
    expect(await conv()).toBe(2)
    expect(await L.count(db, `SELECT count(*) FROM public.care_orders WHERE order_key = 'DHC-S3'`)).toBe(0)
    expect(String((await state()).last_success_at)).toBe(String(okBefore))
    expect((await state()).last_error).toBe('SOURCE_ACCESS_DENIED')
    const status = await L.as(db, U.super, async () => (await db.query(`SELECT has_synced, last_failed FROM public.care_order_sync_status()`)).rows[0])
    expect(status).toEqual({ has_synced: true, last_failed: true })

    // Lượt 5: VIEW còn mốc ở tương lai (kiểu lỗi múi giờ Q-100) ⇒ dừng trước khi đọc đơn.
    const futureBq = fakeBq([...view, { entity_id: 'QA-X', order_code: 'DHC-FUT', completed_at: new Date(Date.now() + 6 * 3600_000).toISOString(), type: 'OFFLINE' }], { now: nowIso })
    r = await runCareOrdersSync(depsFor(futureBq))
    expect(r).toMatchObject({ ok: false, code: 'SOURCE_TIME_FUTURE', preflight: { futureCount: 1 } })
    expect(futureBq.calls).toHaveLength(1)
    expect(await conv()).toBe(2)

    // Lượt 6: quá trần (cap = 0) ⇒ CANDIDATES_OVER_CAP, không gọi BigQuery.
    const capBq = fakeBq(view, { now: nowIso })
    r = await runCareOrdersSync(depsFor(capBq), 0)
    expect(r).toMatchObject({ ok: false, code: 'CANDIDATES_OVER_CAP', windows: 1 })
    expect(capBq.calls).toHaveLength(0)

    // Lượt 6b: apply bị PostgREST huỷ do statement_timeout 8 s (57014). PGlite không tự huỷ ⇒ chạy RPC THẬT
    // trong transaction rồi ROLLBACK (đúng điều Postgres làm khi huỷ câu lệnh) và ném lỗi như PostgREST.
    const okBeforeTimeout = String((await state()).last_success_at)
    const timeoutDeps = depsFor(fakeBq(view, { now: nowIso }))
    r = await runCareOrdersSync({ ...timeoutDeps, apply: async (orders, snap) => {
      await L.as(db, null, async () => {
        await db.exec('BEGIN')
        try { await db.query(`SELECT public.care_order_sync_apply($1::jsonb, $2::timestamptz)`, [JSON.stringify(orders), snap]) } finally { await db.exec('ROLLBACK') }
      }, 'service_role')
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    } })
    expect(r).toMatchObject({ ok: false, code: 'DB_APPLY_FAILED', failRecorded: true, orders: 1 })
    expect(await L.count(db, `SELECT count(*) FROM public.care_orders WHERE order_key = 'DHC-S3'`)).toBe(0)
    expect(await conv()).toBe(2)
    expect((await state()).last_error).toBe('DB_APPLY_FAILED')
    expect(String((await state()).last_success_at)).toBe(okBeforeTimeout)
    expect(JSON.stringify(r)).not.toMatch(/canceling|57014|QA-S|DHC-/)

    // Lượt 7 + chạy chồng: lượt A chụp ứng viên TRƯỚC, lượt B chạy trọn và thành công, rồi A mới apply ⇒ mốc
    // thành công không lùi về A; Có đơn của S3 được ghi (B), A lặp lại cùng dữ liệu ⇒ 0 ghi.
    const candA = parseSyncCandidates(await svc(`SELECT public.care_order_sync_candidates(20000) r`))
    await new Promise((res) => setTimeout(res, 20))
    r = await runCareOrdersSync(depsFor(fakeBq(view, { now: nowIso })))
    expect(r).toMatchObject({ ok: true, ordersWritten: 1 })
    expect(await conv()).toBe(3)
    expect((await state()).last_error).toBeNull()
    const sB = String((await state()).last_success_at)
    const late = await runCareOrdersSync({ ...depsFor(fakeBq(view, { now: nowIso })), candidates: async () => candA })
    expect(late).toMatchObject({ ok: true, ordersWritten: 0 })
    expect(String((await state()).last_success_at)).toBe(sB)
    expect(JSON.stringify([r, late])).not.toMatch(/QA-S|DHC-/)
    await db.close()
  })
})

test.describe('care B5b.2 — nguồn cron care-orders-sync @desktop', () => {
  test('route: Bearer CRON_SECRET → CARE_ENABLED + CARE_SYNC_ENABLED (503) trước mọi IO; log chỉ số/mã', () => {
    const route = read('app/api/cron/care-orders-sync/route.ts')
    const body = /export async function GET\(request: NextRequest\) \{\n([\s\S]*?)\n\}/.exec(route)![1]
    expect(body.trimStart()).toMatch(/^const secret = request\.headers\.get\('authorization'\)/)
    expect(body.indexOf("{ status: 401 }")).toBeLessThan(body.indexOf('isCareEnabled()'))
    expect(body).toMatch(/if \(!isCareEnabled\(\) \|\| !isCareSyncEnabled\(\)\) \{\s*return NextResponse\.json\([\s\S]*?\{ status: 503 \}\)\s*\}/)
    expect(body.indexOf('isCareSyncEnabled()')).toBeLessThan(body.indexOf('syncCareOrders()'))
    expect(route).not.toMatch(/console\.(log|warn|error)\([^)]*\b(err|error|e\.message|message)\b/)
    expect(route).toContain("revalidatePath('/care/reports')")
    const server = read('lib/care/server/orderSync.ts')
    expect(server).toMatch(/^import 'server-only'/)
    for (const rpc of ['care_order_sync_candidates', 'care_order_sync_apply', 'care_order_sync_fail']) expect(server).toContain(`supabaseAdmin.rpc('${rpc}'`)
    expect(server).not.toMatch(/console\./)
    expect(read('lib/care/orders/sync.ts')).not.toMatch(/from ['"](next|@supabase|@\/lib\/supabase|server-only)/)
    expect(read('.env.example')).toMatch(/^CARE_SYNC_ENABLED=false$/m)
  })

  test('dạng ordered_at app gửi ⊂ dạng apply nhận (regex SQL) — mọi đầu vào hợp lệ của parser N3', () => {
    const sql = read('../supabase/migrations/114_care_crm_foundation.sql')
    const m = /e ->> 'ordered_at' !~ '([^']+)' END\) THEN/.exec(sql)
    expect(m, 'không thấy regex ordered_at trong care_order_sync_apply').not.toBeNull()
    const dbRe = new RegExp(m![1]) // cú pháp con dùng chung JS/POSIX: [0-9]{n}, [.], ^…$
    for (const v of ['2026-10-08T07:00:00+07:00', '2026-10-08T00:00:00Z', '2026-10-08T00:00:00.1Z', '2026-10-08T00:00:00.123456Z',
      '2026-10-08T00:00:00.123-0530', '2026-02-28T23:59:59.999999+14:00']) {
      const out = normalizeN3Timestamp(v)
      expect(out, v).not.toBeNull()
      expect(dbRe.test(out!), `${v} ⇒ ${out}`).toBe(true)
    }
    for (const bad of ['now', '-infinity', '2026-10-08T00:00:00', '2026-10-08T00:00:00.000Z']) expect(dbRe.test(bad), bad).toBe(false)
  })

  test('timeout (lệnh PM Lô 4): DB 8 s là chốt chính; mỗi RPC có trần app; một lượt tối đa ≪ biên snapshot 2 giờ của SQL', () => {
    // PGlite KHÔNG thi hành statement_timeout ⇒ hành vi khi bị huỷ kiểm ở test PGlite (57014 ⇒ rollback); thời
    // gian thật đo bằng scripts/bench-care-sync-114.mjs (ngân sách 8 s) và đo lại trên prod ở B6.
    expect(CARE_SYNC_DB_TIMEOUT_MS).toBe(8_000)
    expect(CARE_SYNC_RPC_TIMEOUT_MS).toBeGreaterThan(CARE_SYNC_DB_TIMEOUT_MS)
    const server = read('lib/care/server/orderSync.ts')
    expect(server).toContain('const rpcSignal = () => AbortSignal.timeout(CARE_SYNC_RPC_TIMEOUT_MS)')
    for (const rpc of ['care_order_sync_candidates', 'care_order_sync_apply', 'care_order_sync_fail']) {
      expect(server).toContain(`supabaseAdmin.rpc('${rpc}'`)
      const call = server.slice(server.indexOf(`supabaseAdmin.rpc('${rpc}'`)).split('\n')[0]
      expect(call).toMatch(/\)\.abortSignal\(rpcSignal\(\)\)$/)
    }
    const deadline = Number(/CARE_N3_QUERY_DEADLINE_MS = ([\d_]+)/.exec(read('lib/care/server/n3Source.ts'))![1].replace(/_/g, ''))
    const jobs = Math.ceil(CARE_N3_MAX_WINDOWS / CARE_N3_WINDOWS_PER_QUERY)
    const worst = (1 + jobs) * deadline + 3 * CARE_SYNC_RPC_TIMEOUT_MS // preflight + mọi lô + 3 RPC
    expect(worst).toBeLessThan(CARE_SYNC_SNAPSHOT_MAX_AGE_MS / 10)
    const sql = read('../supabase/migrations/114_care_crm_foundation.sql')
    for (const fn of ['care_order_sync_apply', 'care_order_sync_fail']) {
      const at = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`)
      const body = sql.slice(at, sql.indexOf('$$;', at))
      expect(body.length).toBeGreaterThan(100)
      expect(body).toContain(`p_snapshot_at < now() - interval '${CARE_SYNC_SNAPSHOT_MAX_AGE_MS / 3600_000} hours'`)
    }
  })
})
