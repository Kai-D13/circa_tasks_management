import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { bqQueryAll, type BqTransport } from '../lib/bigquery/query'
import { CMS_RETURN_COLUMNS, normalizeReturnRow } from '../lib/cms/calc/returns'
import { cmsBqContractMaxBytes, cmsBqReturnsTable } from '../lib/cms/config'
import { cmsCalcFlagsFromEnv } from '../lib/cms/flags'
import type { CmsBqRunner } from '../lib/cms/source/bigquery'
import { CMS_SALES_COLUMNS, type CmsRawRow } from '../lib/cms/source/contract'
import {
  buildCmsContractQuery, cmsContractReturnInScope, cmsContractSourceErrorCode, createCmsBqContractProvider, CMS_CONTRACT_SOURCE_COLUMNS,
  CMS_RETURN_NOT_EFFECTIVE_STATUSES,
  type CmsContractScope, type CmsContractSourceResult,
} from '../lib/cms/source/contractSource'
import { parseUtcMicros } from '../lib/cms/time'
import { createCmsContractFixtureProvider } from './cmsContractFixture'

// CMS-CALC-RET-2 P3 — provider nguồn run contract (thiết kế Dev r2 §4.3; plan PM 13/11 §2.1–§2.3). Provider BigQuery chạy QUA lõi thật
// `bqQueryAll` (POST jobs.query → poll → getQueryResults theo jobId + pageToken) với transport giả — không bypass parser / page reader.
// Dữ liệu hoàn toàn giả. Không mạng / DB.

const ROOT = path.resolve(__dirname, '..')
const HAS_PGLITE = fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite'))
const SALES = 'qa-proj.qa_ds.cms_order_view'
const RETURNS = 'qa-proj.qa_ds.cms_return_view'
const P1 = '2004764', P2 = '2004765'
const us = (iso: string) => parseUtcMicros(iso)!
const SCOPE: CmsContractScope = {
  fromMicros: us('2026-11-01T00:00:00.000000Z'), toMicrosExclusive: us('2026-12-01T00:00:00.000000Z'), productIds: [P2, P1, P1],
  asOfMicros: us('2026-11-14T03:00:00.000000Z'), withReturns: true, deadlineMs: 30_000,
}

type Cell = string | null | number | { nested: true }
const saleRow = (o: Partial<Record<string, Cell>> = {}): Record<string, Cell> => ({
  src_kind: 'S', order_line_id: '9001', order_id: 'O1', order_code: 'POS-1', product_id: P1, seller_email: 'ds1@example.invalid', pos_code: 'QAOS01',
  order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: '2026-11-03T02:00:00.000000Z', quantity_raw: '2', uom_raw: 'Hộp',
  base_quantity: '20', gmv_amount: '200000', source_updated_at: '2026-11-03T02:00:00.000000Z', ...o,
})
const retRow = (o: Partial<Record<string, Cell>> = {}): Record<string, Cell> => ({
  src_kind: 'R', return_event_id: 'RT1', return_document_id: 'RD1', return_code: 'RT-1', return_status: 'COMPLETED',
  return_recorded_at: '2026-11-05T02:00:00.000000Z', original_order_line_id: '9001', original_order_id: 'O1', product_id: P1,
  return_base_quantity: '10', return_gmv_amount: '100000', original_completed_at: '2026-11-03T02:00:00.000000Z', original_order_type: 'OFFLINE',
  original_order_status: 'COMPLETED', original_seller_email: 'ds1@example.invalid', original_pos_code: 'QAOS01', original_base_quantity: '20',
  original_gmv_amount: '200000', original_quantity_raw: '2', original_uom_raw: 'Hộp', source_updated_at: null, ...o,
})

// WHERE nhánh trả do buildCmsContractQuery sinh cho scope s, đổi GoogleSQL ⇒ Postgres bằng bảng thay thế cố định (chỉ CAST … AS STRING /
// IN UNNEST / NOT IN UNNEST / @tham số — token GoogleSQL khác còn sót ⇒ fail), chạy trên PGlite với các dòng thô; trả ID giữ lại (sắp xếp).
async function runReturnWhereOnPg(s: CmsContractScope, raw: CmsRawRow[]): Promise<string[]> {
  const q = buildCmsContractQuery({ salesTable: SALES, returnsTable: RETURNS, fromMicros: s.fromMicros, toMicrosExclusive: s.toMicrosExclusive,
    productIds: s.productIds, asOfMicros: s.asOfMicros })
  const arm = q.sql.split('UNION ALL')[1]
  const where = arm.slice(arm.indexOf('\nWHERE ') + 7, arm.indexOf('\nLIMIT @returns_limit'))
  expect(where).toContain('original_completed_at IS NULL')
  expect(where).toContain("NULLIF(TRIM(CAST(product_id AS STRING)), '') IS NULL")
  const names = ['from_ts', 'to_ts', 'as_of', 'product_ids', 'not_effective_statuses']
  let pg = where.split(' AS STRING)').join(' AS TEXT)')
    .split('NOT IN UNNEST(@not_effective_statuses)').join('<> ALL(@not_effective_statuses)')
    .split('IN UNNEST(@product_ids)').join('= ANY(@product_ids)')
  expect(pg).not.toMatch(/UNNEST|STRING|`|FORMAT_TIMESTAMP/)
  pg = pg.replace(/@([a-z_]+)/g, (_, n: string) => { const i = names.indexOf(n); expect(i, n).toBeGreaterThanOrEqual(0); return `$${i + 1}` })
  const pv = (n: string) => q.params.find((p) => p.name === n) as { value?: unknown; values?: unknown[] }
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await db.exec(`CREATE TABLE r (return_event_id text, return_status text, product_id text, original_completed_at timestamptz,
      return_recorded_at timestamptz)`)
    for (const x of raw) {
      await db.query('INSERT INTO r VALUES ($1, $2, $3, $4, $5)', [x.return_event_id, x.return_status, x.product_id, x.original_completed_at, x.return_recorded_at])
    }
    const got = await db.query<{ id: string }>(`SELECT return_event_id id FROM r WHERE ${pg} ORDER BY 1`,
      [pv('from_ts').value, pv('to_ts').value, pv('as_of').value, pv('product_ids').values, pv('not_effective_statuses').values])
    return got.rows.map((x) => x.id)
  } finally {
    await db.close()
  }
}

interface Script {
  rows?: Record<string, Cell>[]
  fields?: string[]
  pageSize?: number
  totalRowsDelta?: number
  jobId?: string | null
  http?: { status: number; body: string }
  neverComplete?: boolean
}

function fake(s: Script) {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = []
  let clock = 0
  const fields = s.fields ?? [...CMS_CONTRACT_SOURCE_COLUMNS]
  const rows = s.rows ?? []
  const size = s.pageSize ?? 2
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } })
  const transport: BqTransport = {
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    getToken: async () => 'tok-qa',
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (s.http) return new Response(s.http.body, { status: s.http.status })
      const job = s.jobId === undefined ? 'job_qa_1' : s.jobId
      if (s.neverComplete) { clock += 11_000; return json({ jobReference: { jobId: job, location: 'asia-southeast1' }, jobComplete: false }) }
      const tok = new URL(String(url)).searchParams.get('pageToken')
      const idx = tok ? Number(tok) : 0
      const page = rows.slice(idx * size, idx * size + size)
      const more = (idx + 1) * size < rows.length
      return json({
        jobReference: job === null ? {} : { jobId: job, location: 'asia-southeast1' }, jobComplete: true,
        schema: { fields: fields.map((name) => ({ name })) }, totalRows: String(rows.length + (s.totalRowsDelta ?? 0)),
        rows: page.map((r) => ({ f: fields.map((f) => ({ v: r[f] ?? null })) })), ...(more ? { pageToken: String(idx + 1) } : {}),
        totalBytesProcessed: '4096',
      })
    }) as typeof fetch,
  }
  const runner: CmsBqRunner = (sql, params, opts) => bqQueryAll(transport, {
    projectId: 'qa-proj', sql, params, maxRows: opts.maxRows, deadlineMs: opts.deadlineMs, maximumBytesBilled: opts.maximumBytesBilled, pageSize: size,
  })
  return { runner, calls }
}

const provider = (runner: CmsBqRunner, o: { returnsTable?: string | null; maxBytesBilled?: number; salesCap?: number; returnsCap?: number } = {}) =>
  createCmsBqContractProvider({ runner, salesTable: SALES, returnsTable: o.returnsTable === undefined ? RETURNS : o.returnsTable, maxBytesBilled: o.maxBytesBilled,
    salesCap: o.salesCap, returnsCap: o.returnsCap })
const failCode = (r: CmsContractSourceResult) => (r.ok ? 'READY' : r.code)

/** Alias cột theo thứ tự trong một nhánh SELECT. */
const aliases = (arm: string) => [...arm.matchAll(/(?:\)|') AS ([a-z_]+)/g)].map((m) => m[1])

test.describe('CMS-CALC-RET-2 P3 · provider nguồn run contract @desktop', () => {
  test('query: MỘT job (bán) UNION ALL (trả), cùng bố cục cột theo thứ tự; lọc as_of / ngày bán gốc; giá trị chỉ qua tham số', () => {
    const q = buildCmsContractQuery({ salesTable: SALES, returnsTable: RETURNS, fromMicros: SCOPE.fromMicros, toMicrosExclusive: SCOPE.toMicrosExclusive,
      productIds: SCOPE.productIds, asOfMicros: SCOPE.asOfMicros, salesCap: 5, returnsCap: 3 })
    const arms = q.sql.split('UNION ALL')
    expect(arms).toHaveLength(2)
    expect(aliases(arms[0])).toEqual([...CMS_CONTRACT_SOURCE_COLUMNS])
    expect(aliases(arms[1])).toEqual([...CMS_CONTRACT_SOURCE_COLUMNS])
    expect(arms[0]).toContain(`FROM \`${SALES}\``)
    expect(arms[0]).toContain('CAST(employee_email AS STRING) AS seller_email')
    expect(arms[0]).toContain('completed_at <= @as_of')
    expect(arms[1]).toContain(`FROM \`${RETURNS}\``)
    expect(arms[1]).toContain('original_completed_at >= @from_ts AND original_completed_at < @to_ts')
    expect(arms[1]).toContain('(return_recorded_at IS NULL OR return_recorded_at <= @as_of)')
    expect(q.sql).not.toContain(P1)
    expect(q.sql).not.toContain('2026-11')
    expect(q.params.map((p) => `${p.name}:${p.type}`)).toEqual(['from_ts:TIMESTAMP', 'to_ts:TIMESTAMP', 'as_of:TIMESTAMP', 'product_ids:ARRAY',
      'sales_limit:INT64', 'returns_limit:INT64', 'not_effective_statuses:ARRAY'])
    expect(q.params.find((p) => p.name === 'not_effective_statuses')).toMatchObject({ arrayType: 'STRING', values: ['APPROVED'] })
    expect(q.params.find((p) => p.name === 'product_ids')).toMatchObject({ values: [P1, P2] })
    expect(q.params.find((p) => p.name === 'as_of')).toMatchObject({ value: '2026-11-14T03:00:00.000000Z' })
    expect(q.params.find((p) => p.name === 'sales_limit')).toMatchObject({ value: 6 })
    expect(q.params.find((p) => p.name === 'returns_limit')).toMatchObject({ value: 4 })
    // Sales-only: không đọc view trả, không tham số trả.
    const s = buildCmsContractQuery({ salesTable: SALES, returnsTable: null, fromMicros: SCOPE.fromMicros, toMicrosExclusive: SCOPE.toMicrosExclusive,
      productIds: [P1], asOfMicros: SCOPE.asOfMicros })
    expect(s.sql).not.toContain('UNION ALL')
    expect(s.sql).not.toContain(RETURNS)
    expect(s.params.map((p) => p.name)).not.toContain('returns_limit')
    expect(s.params.map((p) => p.name)).not.toContain('not_effective_statuses')
    // FQN / phạm vi sai ⇒ lỗi cấu hình (không nội suy).
    for (const bad of [{ salesTable: 'qa-proj.qa_ds.v`; DROP' }, { returnsTable: 'a.b' }, { productIds: [] }, { toMicrosExclusive: SCOPE.fromMicros }]) {
      expect(() => buildCmsContractQuery({ salesTable: SALES, returnsTable: RETURNS, fromMicros: SCOPE.fromMicros, toMicrosExclusive: SCOPE.toMicrosExclusive,
        productIds: [P1], asOfMicros: SCOPE.asOfMicros, ...bad })).toThrow()
    }
  })

  // RET2-SRC-01 (PM audit r4 14/11 §3): WHERE nhánh trả không được loại phiếu thiếu ngày bán gốc / ProductID trước parser. Không dừng ở
  // mock trả mảng: lấy CHÍNH đoạn WHERE do buildCmsContractQuery sinh, đổi cú pháp GoogleSQL ⇒ Postgres bằng bảng thay thế cố định (chỉ
  // CAST … AS STRING / IN UNNEST / NOT IN UNNEST / @tham số — token GoogleSQL khác còn sót ⇒ fail), chạy trên PGlite với 14 dòng giả;
  // tập giữ lại = luật TS dùng chung (fixture) = kỳ vọng từng dòng; dòng thiếu ngữ cảnh đi tới normalizer ⇒ issue (HOLD cả lượt).
  test('RET2-SRC-01: WHERE trả giữ phiếu thiếu ngày bán gốc / ProductID (PGlite chạy đúng WHERE sinh ra = luật fixture); normalizer HOLD', async () => {
    test.skip(!HAS_PGLITE, 'chưa cài PGlite — npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')

    // Kỳ 01/11–01/12, as_of 14/11 03:00. Kỳ vọng: true = vào job.
    const IN_D = '2026-11-03T02:00:00.000000Z', REC = '2026-11-05T02:00:00.000000Z'
    const rows: [string, Partial<Record<string, Cell>>, boolean, string][] = [
      ['R01', {}, true, 'đủ ngữ cảnh trong kỳ'],
      ['R02', { return_recorded_at: '2026-11-14T03:00:01.000000Z' }, false, 'ghi nhận sau as_of'],
      ['R03', { return_status: 'APPROVED', return_recorded_at: null }, true, 'APPROVED trong phạm vi (normalizer: chưa hiệu lực)'],
      ['R04', { original_completed_at: '2026-10-30T00:00:00.000000Z' }, false, 'ngày bán gốc ngoài kỳ'],
      ['R05', { original_completed_at: null }, true, 'COMPLETED cùng SP, ngày bán gốc NULL'],
      ['R06', { product_id: null }, true, 'ProductID NULL, ngày bán gốc trong kỳ'],
      ['R07', { product_id: '  ', original_completed_at: null, return_recorded_at: null }, true, 'ProductID rỗng + ngày NULL + ghi nhận NULL'],
      ['R08', { original_completed_at: null, return_recorded_at: '2026-10-31T23:59:59.999999Z' }, false, 'ngày NULL nhưng trả trước đầu kỳ'],
      ['R09', { return_status: 'APPROVED', product_id: null, original_completed_at: null, return_recorded_at: null }, false, 'APPROVED không xác định phạm vi'],
      ['R10', { return_status: 'CANCELLED', product_id: null, original_completed_at: null, return_recorded_at: null }, true, 'trạng thái lạ không phạm vi'],
      ['R11', { product_id: '9999999', original_completed_at: null }, false, 'SP có thật ngoài chương trình'],
      ['R12', { product_id: null, original_completed_at: '2026-12-01T00:00:00.000000Z' }, false, 'ProductID NULL, ngày bán gốc ngoài kỳ'],
      ['R13', { return_status: null, original_completed_at: null }, true, 'trạng thái NULL, ngày NULL'],
      ['R14', { original_completed_at: null, return_recorded_at: null }, true, 'COMPLETED, ngày bán gốc + ngày trả NULL'],
    ]
    const raw = rows.map(([id, o]) => retRow({ return_event_id: id, original_completed_at: IN_D, return_recorded_at: REC, ...o }) as CmsRawRow)
    const expected = rows.filter((r) => r[2]).map((r) => r[0])

    expect(await runReturnWhereOnPg(SCOPE, raw), 'WHERE sinh ra (chạy trên Postgres)').toEqual(expected)
    const ids = new Set(SCOPE.productIds)
    expect(raw.filter((x) => cmsContractReturnInScope(x, { ...SCOPE, productIds: ids })).map((x) => x.return_event_id), 'luật TS dùng chung').toEqual(expected)
    const fx = await createCmsContractFixtureProvider({ returns: raw }).read(SCOPE)
    expect(fx.ok && fx.returnsRaw?.map((x) => x.return_event_id), 'fixture provider').toEqual(expected)
    expect(CMS_RETURN_NOT_EFFECTIVE_STATUSES).toEqual(['APPROVED'])

    // Dòng thiếu ngữ cảnh đi tới normalizer ⇒ issue (worker HOLD RETURN_ROW_ISSUES cả lượt), không thành "0 phiếu trả".
    const issue = (id: string) => { const n = normalizeReturnRow(raw.find((x) => x.return_event_id === id)!); return n.ok ? 'OK' : n.issues.map((i) => `${i.kind}:${i.field}`).join(',') }
    expect(issue('R05')).toBe('MISSING_FIELD:original_completed_at')
    expect(issue('R06')).toBe('MISSING_FIELD:product_id')
    expect(issue('R10')).toBe('UNKNOWN_STATUS:return_status')
    expect(issue('R13')).toBe('MISSING_FIELD:return_status')
    expect(issue('R14')).toContain('MISSING_FIELD:return_recorded_at')
    expect(normalizeReturnRow(raw[2])).toMatchObject({ ok: true, value: { kind: 'NOT_EFFECTIVE' } })
  })

  // PM audit r4.1 §3 (14/11) — phạm vi HOLD khi mất ngữ cảnh: không có cận "ngày trả < ngày kết thúc kỳ" (trả muộn có thể thuộc kỳ cũ) ⇒
  // chương trình net kỳ đã kết thúc vẫn HOLD; ngày trả trước đầu kỳ ⇒ loại; thiếu cả ngày trả ⇒ giữ; APPROVED ≠ trạng thái lạ / NULL.
  test('RET2-SRC-01 biên phạm vi HOLD: kỳ đã kết thúc + trả muộn giữ; trả trước đầu kỳ loại; thiếu ngày trả giữ; APPROVED ≠ lạ / NULL', async () => {
    test.skip(!HAS_PGLITE, 'chưa cài PGlite — npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
    const OCT: CmsContractScope = { ...SCOPE, fromMicros: us('2026-10-01T00:00:00.000000Z'), toMicrosExclusive: us('2026-11-01T00:00:00.000000Z') }
    const NONE = { product_id: null, original_completed_at: null }
    const rows: [string, Partial<Record<string, Cell>>, boolean, string, string][] = [
      ['B01', { ...NONE, return_recorded_at: '2026-11-05T02:00:00.000000Z' }, true, '(a) thiếu cả hai, trả SAU kết thúc kỳ, ≤ as_of', 'MISSING_FIELD:product_id'],
      ['B02', { ...NONE, return_recorded_at: '2026-10-31T16:59:59.999999Z' }, true, '(a) thiếu cả hai, trả trong kỳ', 'MISSING_FIELD:product_id'],
      ['B03', { ...NONE, return_recorded_at: '2026-09-30T23:59:59.999999Z' }, false, '(b) thiếu cả hai, trả TRƯỚC đầu kỳ', ''],
      ['B04', { product_id: P1, original_completed_at: null, return_recorded_at: '2026-09-30T23:59:59.999999Z' }, false, '(b) SP trong chương trình, ngày gốc NULL, trả trước đầu kỳ', ''],
      ['B05', { ...NONE, return_recorded_at: null }, true, '(c) thiếu cả ngày trả ⇒ không có mốc để loại', 'MISSING_FIELD:product_id'],
      ['B06', { ...NONE, return_recorded_at: '2026-11-14T03:00:00.000001Z' }, false, 'thiếu cả hai, trả sau as_of', ''],
      ['B07', { ...NONE, return_recorded_at: null, return_status: 'APPROVED' }, false, '(d) APPROVED đã biết chưa hiệu lực ⇒ loại', ''],
      ['B08', { ...NONE, return_recorded_at: null, return_status: 'CANCELLED' }, true, '(d) trạng thái lạ KHÔNG bị coi là APPROVED', 'UNKNOWN_STATUS:return_status'],
      ['B09', { ...NONE, return_recorded_at: null, return_status: null }, true, '(d) trạng thái NULL không bị coi là APPROVED', 'MISSING_FIELD:return_status'],
      ['B10', { ...NONE, return_recorded_at: '2026-11-05T02:00:00.000000Z', return_status: 'approved' }, true, '(d) khác hoa thường = lạ, không phải APPROVED', 'UNKNOWN_STATUS:return_status'],
      ['B11', { product_id: P1, original_completed_at: null, return_recorded_at: '2026-11-05T02:00:00.000000Z' }, true, 'SP trong chương trình, ngày gốc NULL, trả muộn', 'MISSING_FIELD:original_completed_at'],
      ['B12', { product_id: null, original_completed_at: '2026-10-20T02:00:00.000000Z', return_recorded_at: '2026-11-05T02:00:00.000000Z' }, true, 'ngày gốc trong kỳ cũ, SP NULL, trả muộn', 'MISSING_FIELD:product_id'],
      ['B13', { original_completed_at: '2026-10-20T02:00:00.000000Z', return_recorded_at: '2026-11-05T02:00:00.000000Z' }, true, 'đủ ngữ cảnh kỳ cũ, trả muộn (nhánh 1)', 'OK'],
      ['B14', { product_id: null, original_completed_at: '2026-11-03T02:00:00.000000Z', return_recorded_at: '2026-11-05T02:00:00.000000Z' }, false, 'SP NULL nhưng ngày gốc có thật ngoài kỳ ⇒ loại', ''],
    ]
    const raw = rows.map(([id, o]) => retRow({ return_event_id: id, ...o }) as CmsRawRow)
    const expected = rows.filter((r) => r[2]).map((r) => r[0])
    expect(await runReturnWhereOnPg(OCT, raw), 'WHERE sinh ra (chạy trên Postgres), kỳ tháng 10 đã kết thúc').toEqual(expected)
    const ids = new Set(OCT.productIds)
    expect(raw.filter((x) => cmsContractReturnInScope(x, { ...OCT, productIds: ids })).map((x) => x.return_event_id), 'luật TS dùng chung').toEqual(expected)
    const fx = await createCmsContractFixtureProvider({ returns: raw }).read(OCT)
    expect(fx.ok && fx.returnsRaw?.map((x) => x.return_event_id), 'fixture provider').toEqual(expected)
    // Dòng được giữ đi tới normalizer ⇒ issue (worker HOLD RETURN_ROW_ISSUES, giữ snapshot cuối) — không thành phiếu trừ tiền.
    for (const [id, , keep, why, want] of rows) {
      if (!keep) continue
      const n = normalizeReturnRow(raw.find((x) => x.return_event_id === id)!)
      const got = n.ok ? 'OK' : n.issues.map((i) => `${i.kind}:${i.field}`).join(',')
      expect(got, `${id} ${why}`).toContain(want)
    }
    // APPROVED đúng từ điển ⇒ normalizer NOT_EFFECTIVE (không issue) khi có đủ ngữ cảnh; lạ ⇒ issue.
    expect(normalizeReturnRow(retRow({ return_status: 'APPROVED', return_recorded_at: null }) as CmsRawRow)).toMatchObject({ ok: true, value: { kind: 'NOT_EFFECTIVE' } })
    expect(normalizeReturnRow(retRow({ return_status: 'CANCELLED' }) as CmsRawRow).ok).toBe(false)
  })

  test('đọc đủ: nhiều trang cùng jobId, tách bán / trả theo src_kind, decimal giữ nguyên chuỗi, pin job + as_of; trần byte chỉ khi cấu hình', async () => {
    const big = '123456789012345678.123456789'
    const f = fake({ rows: [saleRow(), retRow(), saleRow({ order_line_id: '9002', gmv_amount: big }), retRow({ return_event_id: 'RT2', return_status: 'APPROVED',
      return_recorded_at: null }), saleRow({ order_line_id: '9003', product_id: P2 })], pageSize: 2 })
    const r = await provider(f.runner, { maxBytesBilled: 2_000_000_000 }).read(SCOPE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r).toMatchObject({ provider: 'bq', jobId: 'job_qa_1', asOfMicros: SCOPE.asOfMicros, bytesProcessed: 4096 })
    expect(r.snapshotId).toBeUndefined()
    expect(r.salesRaw.map((x) => x.order_line_id)).toEqual(['9001', '9002', '9003'])
    expect(Object.keys(r.salesRaw[0])).toEqual([...CMS_SALES_COLUMNS])
    expect(r.salesRaw[1].gmv_amount).toBe(big)
    expect(r.returnsRaw?.map((x) => `${x.return_event_id}:${x.return_status}`)).toEqual(['RT1:COMPLETED', 'RT2:APPROVED'])
    expect(Object.keys(r.returnsRaw![0])).toEqual([...CMS_RETURN_COLUMNS])
    // 1 POST + 2 trang sau (3 trang) — mọi GET theo cùng jobId.
    expect(f.calls.map((c) => c.method)).toEqual(['POST', 'GET', 'GET'])
    expect(f.calls.slice(1).every((c) => c.url.includes('/queries/job_qa_1?'))).toBe(true)
    expect(f.calls[0].body).toMatchObject({ maximumBytesBilled: '2000000000', parameterMode: 'NAMED' })
    const g = fake({ rows: [saleRow()] })
    await provider(g.runner).read(SCOPE)
    expect(g.calls[0].body).not.toHaveProperty('maximumBytesBilled')
  })

  test('rỗng hợp lệ chỉ khi job thành công; sales-only ⇒ returnsRaw null (không phải []); phần trả trong job sales-only ⇒ CONTRACT_MISMATCH', async () => {
    const e = await provider(fake({ rows: [] }).runner).read(SCOPE)
    expect(e).toMatchObject({ ok: true, salesRaw: [], returnsRaw: [] })
    const so = await provider(fake({ rows: [saleRow()] }).runner).read({ ...SCOPE, withReturns: false })
    expect(so).toMatchObject({ ok: true, returnsRaw: null })
    const sneak = await provider(fake({ rows: [saleRow(), retRow()] }).runner).read({ ...SCOPE, withReturns: false })
    expect(failCode(sneak)).toBe('CONTRACT_MISMATCH')
    const odd = await provider(fake({ rows: [saleRow({ src_kind: 'X' })] }).runner).read(SCOPE)
    expect(failCode(odd)).toBe('CONTRACT_MISMATCH')
  })

  test('view trả chưa cấu hình + chương trình net ⇒ NOT_CONFIGURED, KHÔNG gửi job; sales-only vẫn đọc được', async () => {
    const f = fake({ rows: [saleRow()] })
    const r = await provider(f.runner, { returnsTable: null }).read(SCOPE)
    expect(r).toMatchObject({ ok: false, code: 'NOT_CONFIGURED', part: 'returns' })
    expect(f.calls).toHaveLength(0)
    expect((await provider(f.runner, { returnsTable: null }).read({ ...SCOPE, withReturns: false })).ok).toBe(true)
    const nos = await createCmsBqContractProvider({ runner: f.runner, salesTable: null, returnsTable: RETURNS }).read(SCOPE)
    expect(nos).toMatchObject({ ok: false, code: 'NOT_CONFIGURED', part: 'sales' })
  })

  test('lỗi nguồn ⇒ mã cố định, không message thô / tên view / email: 403 · 404 · 400 invalidQuery · 400 bytes · 500 · timeout', async () => {
    const leak = `{"error":{"code":403,"message":"Access Denied: Table ${RETURNS}: user ds1@example.invalid","errors":[{"reason":"accessDenied"}]}}`
    const cases: [Script, string][] = [
      [{ http: { status: 403, body: leak } }, 'PERMISSION_DENIED'],
      [{ http: { status: 404, body: `{"error":{"message":"Not found: Table ${RETURNS}","errors":[{"reason":"notFound"}]}}` } }, 'NOT_CONFIGURED'],
      [{ http: { status: 400, body: '{"error":{"message":"Unrecognized name: return_status_v2","errors":[{"reason":"invalidQuery"}]}}' } }, 'CONTRACT_MISMATCH'],
      [{ http: { status: 400, body: '{"error":{"errors":[{"reason":"bytesBilledLimitExceeded"}]}}' } }, 'BYTES_LIMIT'],
      [{ http: { status: 400, body: '{"error":{"errors":[{"reason":"accessDenied"}]}}' } }, 'PERMISSION_DENIED'],
      [{ http: { status: 400, body: '{"error":{"errors":[{"reason":"somethingElse"}]}}' } }, 'SOURCE_ERROR'],
      [{ http: { status: 500, body: 'backend' } }, 'SOURCE_ERROR'],
      [{ neverComplete: true }, 'TIMEOUT'],
    ]
    for (const [s, want] of cases) {
      const r = await provider(fake(s).runner).read({ ...SCOPE, deadlineMs: 5_000 })
      expect(failCode(r), JSON.stringify(s).slice(0, 80)).toBe(want)
      const txt = JSON.stringify(r)
      expect(txt).not.toContain('example.invalid')
      expect(txt).not.toContain(RETURNS)
      expect(txt).not.toContain('Unrecognized')
      expect(r).not.toHaveProperty('returnsRaw')
    }
    expect(cmsContractSourceErrorCode(new Error('x'))).toEqual({ code: 'SOURCE_ERROR', status: null })
  })

  test('cấu trúc kết quả: thiếu cột ⇒ CONTRACT_MISMATCH (tên cột); thiếu trang / totalRows lệch / jobId rỗng / giá trị số JSON ⇒ INCOMPLETE', async () => {
    const miss = await provider(fake({ rows: [saleRow()], fields: CMS_CONTRACT_SOURCE_COLUMNS.filter((c) => c !== 'original_uom_raw') }).runner).read(SCOPE)
    expect(miss).toMatchObject({ ok: false, code: 'CONTRACT_MISMATCH', missing: ['original_uom_raw'] })
    expect(failCode(await provider(fake({ rows: [saleRow(), saleRow({ order_line_id: '9002' })], totalRowsDelta: 1 }).runner).read(SCOPE))).toBe('INCOMPLETE')
    expect(failCode(await provider(fake({ rows: [saleRow()], jobId: null }).runner).read(SCOPE))).toBe('INCOMPLETE')
    // NUMERIC bị đổi thành số JSON (mất chính xác) ⇒ parser chặn, không làm tròn.
    expect(failCode(await provider(fake({ rows: [saleRow({ gmv_amount: 200000.1 })] }).runner).read(SCOPE))).toBe('INCOMPLETE')
    expect(failCode(await provider(fake({ rows: [saleRow({ gmv_amount: { nested: true } })] }).runner).read(SCOPE))).toBe('INCOMPLETE')
  })

  test('trần từng phần: bán > trần ⇒ OVER_CAP sales; trả > trần ⇒ OVER_CAP returns; tổng > maxRows của job ⇒ OVER_CAP', async () => {
    const s3 = [saleRow(), saleRow({ order_line_id: '9002' }), saleRow({ order_line_id: '9003' })]
    expect(await provider(fake({ rows: s3 }).runner, { salesCap: 2 }).read(SCOPE)).toMatchObject({ ok: false, code: 'OVER_CAP', part: 'sales', cap: 2 })
    const r3 = [retRow(), retRow({ return_event_id: 'RT2' }), retRow({ return_event_id: 'RT3' })]
    expect(await provider(fake({ rows: r3 }).runner, { returnsCap: 2 }).read(SCOPE)).toMatchObject({ ok: false, code: 'OVER_CAP', part: 'returns' })
    // maxRows của job = (2 + 1) + (1 + 1) = 5 ⇒ 6 dòng ⇒ bqQueryAll row_limit.
    const six = [...s3, ...r3]
    expect(failCode(await provider(fake({ rows: six }).runner, { salesCap: 2, returnsCap: 1 }).read(SCOPE))).toBe('OVER_CAP')
  })

  test('fixture provider: cùng ngữ nghĩa lọc job (as_of / ngày bán gốc / ProductID); sales-only ⇒ null; chỉ chuỗi', async () => {
    const calls: CmsContractScope[] = []
    const sales: CmsRawRow[] = [saleRow() as CmsRawRow, saleRow({ order_line_id: '9002', completed_at: '2026-11-14T03:00:01.000000Z' }) as CmsRawRow,
      saleRow({ order_line_id: '9003', product_id: '9999999' }) as CmsRawRow, saleRow({ order_line_id: '9004', completed_at: '2026-10-31T23:59:59.999999Z' }) as CmsRawRow]
    const returns: CmsRawRow[] = [retRow() as CmsRawRow, retRow({ return_event_id: 'RT2', return_recorded_at: '2026-11-14T03:00:01.000000Z' }) as CmsRawRow,
      retRow({ return_event_id: 'RT3', return_status: 'APPROVED', return_recorded_at: null }) as CmsRawRow,
      retRow({ return_event_id: 'RT4', original_completed_at: '2026-10-30T00:00:00.000000Z' }) as CmsRawRow]
    const fx = createCmsContractFixtureProvider({ sales, returns, calls })
    const r = await fx.read(SCOPE)
    expect(r.ok && r.salesRaw.map((x) => x.order_line_id)).toEqual(['9001'])
    expect(r.ok && r.returnsRaw?.map((x) => x.return_event_id)).toEqual(['RT1', 'RT3'])
    expect(r).toMatchObject({ provider: 'fixture', snapshotId: 'qa-fixture-snapshot' })
    expect(r.ok && r.jobId).toBeUndefined()
    const so = await fx.read({ ...SCOPE, withReturns: false })
    expect(so.ok && so.returnsRaw).toBeNull()
    expect(calls).toHaveLength(2)
  })

  test('cấu hình: CMS_BQ_RETURNS_TABLE / CMS_BQ_CONTRACT_MAX_BYTES validate; hai cờ mặc định OFF, cần program + earnings', () => {
    expect(cmsBqReturnsTable({})).toBeNull()
    expect(cmsBqReturnsTable({ CMS_BQ_RETURNS_TABLE: ` ${RETURNS} ` })).toBe(RETURNS)
    expect(() => cmsBqReturnsTable({ CMS_BQ_RETURNS_TABLE: 'bad name' })).toThrow(/CMS_BQ_RETURNS_TABLE/)
    expect(cmsBqContractMaxBytes({})).toBeUndefined()
    expect(cmsBqContractMaxBytes({ CMS_BQ_CONTRACT_MAX_BYTES: '2000000000' })).toBe(2_000_000_000)
    for (const bad of ['0', '-1', '1.5', '1e9', 'abc', '99999999999999999999']) expect(() => cmsBqContractMaxBytes({ CMS_BQ_CONTRACT_MAX_BYTES: bad })).toThrow()
    const base = { CMS_PROGRAM_ENABLED: 'true', CMS_EARNINGS_ENABLED: 'true' }
    expect(cmsCalcFlagsFromEnv({})).toEqual({ modes: false, returns: false })
    expect(cmsCalcFlagsFromEnv({ ...base, CMS_CALC_MODES_ENABLED: 'true', CMS_RETURNS_ENABLED: 'true' })).toEqual({ modes: true, returns: true })
    expect(cmsCalcFlagsFromEnv({ CMS_PROGRAM_ENABLED: 'true', CMS_CALC_MODES_ENABLED: 'true', CMS_RETURNS_ENABLED: 'true' })).toEqual({ modes: false, returns: false })
    expect(cmsCalcFlagsFromEnv({ ...base, CMS_CALC_MODES_ENABLED: 'TRUE', CMS_RETURNS_ENABLED: '1' })).toEqual({ modes: false, returns: false })
  })
})
