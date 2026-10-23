import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import { BigQueryError, type BqParam, type BqRow } from '../lib/bigquery/query'
import { CARE_N3_COMPLETED_UTC, CARE_N3_VIEW_LAG_HOURS, CareN3SourceError, runN3Preflight, type CareN3RunQuery } from '../lib/care/orders/source'
import { careOrderLinksFlagsFromEnv } from '../lib/care/config'
import {
  CARE_ORDER_LINKS_LIMITS, CareOrderLinksSourceError, buildOrderLinksSql, orderLinksParamsSha, parseRunJob, planOrderLinksChunks,
  readOrderLinksJob, type CareOrderLinksJob,
} from '../lib/care/orderLinks/source'
import {
  CARE_ORDER_LINKS_BUSY_BACKOFF_MS, CareOrderLinksDbError, parseBeginOpen, parseBeginSelect, parseChunk, parseCloseRetryHeader, parseComplete,
  runCareOrderLinks, type CareOrderLinksDeps,
} from '../lib/care/orderLinks/run'
import { appendNewById, careImportCountState, careImportStale, careMyOrdersView, parseMyOrderTasks, parseTaskOrderCounts } from '../lib/care/orderLinks/view'
import {
  CARE_MY_ORDER_SEARCH_MAX_IDS, CareOrderCursorError, CareOrderSearchTooBroadError, myOrderSearchPage, myOrderTaskPage, type CareOrderRpc,
} from '../lib/care/orderLinks/my'

// CRM-CSKH E2 — lượt "đơn xác thực sau import" (thiết kế E0 r3.4 §4): (1) nguồn BigQuery + băm tham số + chia chunk (thuần);
// (2) điều phối với deps giả (busy / skipped / lỗi / backoff); (3) đầu–cuối PGlite với RPC 116 THẬT + BigQuery giả hiểu đúng
// SQL E (QUALIFY trần / khách, −7 giờ Q-100); (4) chip "Có đơn xác thực" của dược sĩ (E3 r1.1: keyset + tìm trong nhóm);
// (5) nguồn route + cờ. Không BigQuery / DB thật.

const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')
const HAS_PGLITE = fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite'))
const TABLE = 'qa-proj-123.qa_ds.qa_completed_order'
const LAG_MS = CARE_N3_VIEW_LAG_HOURS * 3_600_000

/** ISO µs UTC + ms (giữ 3 chữ số µs cuối) — đồng hồ của BigQuery giả chính xác tới µs. */
function shiftUs(iso: string, ms: number): string {
  const head = Date.parse(iso.slice(0, 23) + 'Z') + ms
  return new Date(head).toISOString().replace(/Z$/, iso.slice(23, 26) + 'Z')
}

interface ViewRow { entity_id: string; order_code: string; completed_at: string; type?: string }
/** BigQuery giả: VIEW lưu completed_at +7 giờ (Q-100); chỉ khi SQL có đúng biểu thức chuẩn hoá thì trừ lại. */
function fakeBq(view: ViewRow[], opts: { now?: string } = {}) {
  const calls: { sql: string; params: BqParam[] }[] = []
  const run: CareN3RunQuery = async (sql, params, o) => {
    calls.push({ sql, params })
    const fix = sql.includes(CARE_N3_COMPLETED_UTC) ? -LAG_MS : 0
    const utc = (v: ViewRow) => shiftUs(v.completed_at, fix)
    const live = view.filter((v) => ['ONLINE', 'OFFLINE'].includes(v.type ?? 'OFFLINE'))
    let rows: BqRow[]
    if (sql.includes('future_count')) {
      const now = Date.parse(opts.now ?? new Date().toISOString())
      const ts = live.map((v) => Date.parse(utc(v)))
      rows = [{ future_count: String(ts.filter((t) => t > now + 5 * 60_000).length), max_age_minutes: ts.length ? String(Math.floor((now - Math.max(...ts)) / 60_000)) : null }]
    } else {
      const p = (n: string) => params.find((x) => x.name === n) as { value?: unknown; values?: unknown[] }
      const ids = p('customer_ids').values as string[], los = p('from_ts').values as string[]
      const minLo = p('min_lo').value as string, upper = p('upper_bound').value as string, isClose = p('is_close').value as boolean
      const cap = p('per_customer_cap').value as number
      const lo = new Map(ids.map((id, i) => [id, los[i]]))
      const picked = live.map((v) => ({ v, t: utc(v) })).filter(({ v, t }) => lo.has(v.entity_id) && t > minLo && t > lo.get(v.entity_id)!
        && t <= upper && (!isClose || t < upper))
        .sort((a, b) => (a.v.entity_id < b.v.entity_id ? -1 : a.v.entity_id > b.v.entity_id ? 1 : a.t < b.t ? -1 : a.t > b.t ? 1 : a.v.order_code < b.v.order_code ? -1 : 1))
      const seen = new Map<string, number>()
      rows = picked.filter(({ v }) => { const k = (seen.get(v.entity_id) ?? 0) + 1; seen.set(v.entity_id, k); return k <= cap + 1 })
        .map(({ v, t }) => ({ customer_external_id: v.entity_id, order_key: v.order_code, ordered_at: t }))
      if (rows.length > o.maxRows) throw new BigQueryError('row_limit', `vượt ${o.maxRows}`)
    }
    return { rows, fields: rows.length ? Object.keys(rows[0]) : ['customer_external_id', 'order_key', 'ordered_at'], totalRows: rows.length, jobId: 'qa', pages: 1, totalBytesProcessed: 1000 }
  }
  return { run, calls }
}

const JOB: CareOrderLinksJob = {
  runId: 7, jobNo: 1, tasks: 2, paramsSha256: '', upperBound: '2030-01-10T05:00:00.000000Z', isClose: false, perCustomerCap: 3,
  minLo: '2030-01-05T03:00:00.000000Z', customerIds: ['K1', 'K2'], fromTs: ['2030-01-05T03:00:00.000000Z', '2030-01-06T03:00:00.000000Z'],
}
JOB.paramsSha256 = orderLinksParamsSha(JOB)

test.describe('care E2 — nguồn BigQuery + băm tham số + chia chunk @desktop', () => {
  test('SQL: CTE −7 giờ dùng chung 114, cửa sổ (lo, upper], chốt nghiêm ngặt, QUALIFY cap + 1, ORDER BY ổn định', () => {
    const sql = buildOrderLinksSql(TABLE)
    expect(sql).toContain(CARE_N3_COMPLETED_UTC)
    expect(sql).toContain('s.completed_utc > c.lo')
    expect(sql).toContain('s.completed_utc <= @upper_bound')
    expect(sql).toContain('(NOT @is_close OR s.completed_utc < @upper_bound)')
    expect(sql).toContain('QUALIFY ROW_NUMBER() OVER (PARTITION BY s.entity_id ORDER BY s.completed_utc, s.order_code) <= @per_customer_cap + 1')
    expect(sql).not.toMatch(/v\.completed_at\s*[<>=]/) // không so cột thô với mốc UTC
    expect(() => buildOrderLinksSql('bad table`')).toThrow(CareN3SourceError)
  })

  test('băm tham số: đổi thứ tự / lo / upper / cap / is_close ⇒ khác; độ dài byte UTF-8 chống mơ hồ', () => {
    const base = orderLinksParamsSha(JOB)
    expect(orderLinksParamsSha({ ...JOB, customerIds: ['K2', 'K1'] })).not.toBe(base)
    expect(orderLinksParamsSha({ ...JOB, fromTs: [JOB.fromTs[0], '2030-01-06T03:00:00.000001Z'] })).not.toBe(base)
    expect(orderLinksParamsSha({ ...JOB, isClose: true })).not.toBe(base)
    expect(orderLinksParamsSha({ ...JOB, perCustomerCap: 4 })).not.toBe(base)
    expect(orderLinksParamsSha({ ...JOB, customerIds: ['K1|x', 'K2'] })).not.toBe(orderLinksParamsSha({ ...JOB, customerIds: ['K1', 'x|K2'] }))
  })

  test('đọc job: khử trùng y hệt; trùng khác ⇒ ORDER_KEY_CONFLICT; > cap ⇒ CUSTOMER_ROWS_OVER_CAP; vượt trần dòng ⇒ ROWS_OVER_CAP; sha lệch ⇒ PARAMS_MISMATCH', async () => {
    const v = (e: string, c: string, at: string) => ({ entity_id: e, order_code: c, completed_at: shiftUs(at, LAG_MS) })
    const ok = await readOrderLinksJob(TABLE, JOB, fakeBq([
      v('K1', 'D1', '2030-01-05T03:00:00.000000Z'), // = lo ⇒ không lấy
      v('K1', 'D2', '2030-01-05T03:00:00.000001Z'), v('K1', 'D2', '2030-01-05T03:00:00.000001Z'), // trùng y hệt
      v('K2', 'D3', '2030-01-10T05:00:00.000000Z'), // = upper ⇒ lấy (lượt thường)
      v('K2', 'D4', '2030-01-10T05:00:00.000001Z'), v('K9', 'D5', '2030-01-07T00:00:00.000000Z'),
    ]).run, { maxRows: 100 })
    expect(ok).toMatchObject({ bqTotalRows: 3, duplicatesDropped: 1 })
    expect(ok.orders.map((o) => o.order_key)).toEqual(['D2', 'D3'])
    await expect(readOrderLinksJob(TABLE, JOB, fakeBq([v('K1', 'X', '2030-01-06T00:00:00.000000Z'), v('K2', 'X', '2030-01-07T00:00:00.000000Z')]).run, { maxRows: 100 }))
      .rejects.toMatchObject({ code: 'ORDER_KEY_CONFLICT' })
    const many = Array.from({ length: 5 }, (_, i) => v('K1', `M${i}`, `2030-01-06T00:00:0${i}.000000Z`))
    await expect(readOrderLinksJob(TABLE, JOB, fakeBq(many).run, { maxRows: 100 })).rejects.toMatchObject({ code: 'CUSTOMER_ROWS_OVER_CAP' })
    await expect(readOrderLinksJob(TABLE, JOB, fakeBq(many.slice(0, 3)).run, { maxRows: 2 })).rejects.toMatchObject({ code: 'ROWS_OVER_CAP' })
    await expect(readOrderLinksJob(TABLE, { ...JOB, paramsSha256: '0'.repeat(64) }, fakeBq([]).run, { maxRows: 100 })).rejects.toMatchObject({ code: 'PARAMS_MISMATCH' })
    const close = { ...JOB, isClose: true }
    close.paramsSha256 = orderLinksParamsSha(close)
    const c = await readOrderLinksJob(TABLE, close, fakeBq([v('K2', 'E1', '2030-01-10T05:00:00.000000Z'), v('K2', 'E0', '2030-01-10T04:59:59.999999Z')]).run, { maxRows: 100 })
    expect(c.orders.map((o) => o.order_key)).toEqual(['E0']) // chốt: < upper nghiêm ngặt
    const inj: CareN3RunQuery = async () => ({ rows: [{ customer_external_id: 'K1', order_key: 'Z', ordered_at: '2030-01-04T00:00:00.000000Z' }], fields: ['customer_external_id', 'order_key', 'ordered_at'], totalRows: 1, jobId: 'x', pages: 1, totalBytesProcessed: null })
    await expect(readOrderLinksJob(TABLE, JOB, inj, { maxRows: 100 })).rejects.toMatchObject({ code: 'ORDER_OUT_OF_WINDOW' })
  })

  test('chia chunk: ≤ 2.000 khách, ≤ 5.000 đơn, đơn của một khách không tách, mọi khách (kể cả 0 đơn) đúng một chunk', () => {
    const ids = Array.from({ length: 4_500 }, (_, i) => `C${String(i).padStart(5, '0')}`)
    const orders = ids.slice(0, 10).flatMap((id) => Array.from({ length: 600 }, (_, k) => ({ customer_external_id: id, order_key: `${id}-${k}`, ordered_at: '2030-01-06T00:00:00.000000Z' })))
    const chunks = planOrderLinksChunks({ customerIds: ids }, orders)
    expect(chunks.every((c) => c.customerIds.length <= CARE_ORDER_LINKS_LIMITS.chunkCustomers && c.orders.length <= CARE_ORDER_LINKS_LIMITS.chunkOrders)).toBe(true)
    expect(chunks.flatMap((c) => c.customerIds)).toEqual(ids)
    expect(chunks.reduce((s, c) => s + c.orders.length, 0)).toBe(orders.length)
    for (const c of chunks) for (const o of c.orders) expect(c.customerIds).toContain(o.customer_external_id)
    expect(chunks[0].orders.length).toBe(4_800) // 8 khách × 600, khách thứ 9 sang chunk sau
  })

  test('parse jsonb RPC fail-closed; header chạy lại', () => {
    expect(() => parseRunJob({ ...JOB })).toThrow()
    expect(parseBeginOpen({ status: 'busy', code: 'RUN_IN_PROGRESS' })).toEqual({ status: 'busy', code: 'RUN_IN_PROGRESS' })
    expect(() => parseBeginOpen({ status: 'ok', run_id: 1, period_month: '2030-01-01', snapshot_at: '2030-01-01T00:00:00Z', upper_bound: 'x', is_close: false })).toThrow()
    expect(() => parseBeginSelect({ status: 'running', tasks: 10_001, jobs: 1 })).toThrow()
    expect(parseChunk({ status: 'busy', code: 'CHUNK_BUSY' }).status).toBe('busy')
    expect(() => parseComplete({ status: 'failed', code: 'bad code' })).toThrow()
    expect(parseCloseRetryHeader(null)).toBeNull()
    expect(parseCloseRetryHeader('2026-10')).toBe('2026-10-01')
    for (const v of ['2026-13', '2026-1', '202610', '2026-10-01', '']) expect(parseCloseRetryHeader(v)).toBe('invalid')
    expect(new CareOrderLinksDbError('CHUNK', 'CHUNK_TASK_MISSING — care_order_links_apply_chunk: x').dbCode).toBe('CHUNK_TASK_MISSING')
    expect(new CareOrderLinksDbError('CHUNK', 'permission denied for function x').dbCode).toBeNull()
  })
})

function fakeDeps(over: Partial<CareOrderLinksDeps> = {}) {
  const log: string[] = []
  const deps: CareOrderLinksDeps = {
    beginOpen: async () => { log.push('open'); return { status: 'ok', runId: 5, periodMonth: '2030-01-01', snapshotAt: JOB.upperBound, upperBound: JOB.upperBound, isClose: false } },
    preflight: async () => { log.push('preflight'); return { futureCount: 0, maxAgeMinutes: 25, bytesProcessed: 10 } },
    beginSelect: async () => { log.push('select'); return { tasks: 2, jobs: 1 } },
    runJob: async () => { log.push('job'); return JOB },
    readJob: async () => { log.push('read'); return { jobNo: 1, orders: [{ customer_external_id: 'K1', order_key: 'D1', ordered_at: '2030-01-06T00:00:00.000000Z' }], bqTotalRows: 1, duplicatesDropped: 0, pages: 1, bytesProcessed: 100 } },
    jobDone: async () => { log.push('done') },
    applyChunk: async () => { log.push('chunk'); return { status: 'ok', linksInserted: 1, linksUpdated: 0, relinkRefused: 0 } },
    complete: async () => { log.push('complete'); return { status: 'complete', tasks: 2, chunks: 1 } },
    fail: async (_id, code) => { log.push(`fail:${code}`); return true },
    sleep: async (ms) => { log.push(`sleep:${ms}`) },
    now: () => 0,
  }
  return { deps: { ...deps, ...over }, log }
}

test.describe('care E2 — điều phối lượt (deps giả) @desktop', () => {
  test('thành công: đọc hết rồi mới ghi; thứ tự bước', async () => {
    const { deps, log } = fakeDeps()
    const r = await runCareOrderLinks(deps, { kind: 'regular', mode: 'apply' })
    expect(r).toMatchObject({ ok: true, status: 'complete', tasks: 2, jobs: 1, chunks: 1, rows: 1, linksInserted: 1, maxAgeMinutes: 25 })
    expect(log).toEqual(['open', 'preflight', 'select', 'job', 'read', 'done', 'chunk', 'complete'])
  })
  test('busy / skipped: không IO BigQuery, không fail', async () => {
    let f = fakeDeps({ beginOpen: async () => ({ status: 'busy', code: 'RUN_IN_PROGRESS' }) })
    expect(await runCareOrderLinks(f.deps, { kind: 'regular', mode: 'apply' })).toMatchObject({ ok: false, status: 'busy', code: 'RUN_IN_PROGRESS', failRecorded: null })
    expect(f.log).toEqual([])
    f = fakeDeps({ beginOpen: async () => ({ status: 'skipped', code: 'CLOSE_NOT_ELIGIBLE', periodMonth: '2030-01-01', periodStatus: 'closed' }) })
    expect(await runCareOrderLinks(f.deps, { kind: 'close', mode: 'apply' })).toMatchObject({ status: 'skipped', periodStatus: 'closed' })
    expect(f.log).toEqual([])
  })
  test('lỗi ⇒ fail(mã) và không ghi chunk nào khi lỗi ở pha đọc', async () => {
    const cases: [Partial<CareOrderLinksDeps>, string][] = [
      [{ preflight: async () => ({ futureCount: 2, maxAgeMinutes: 0, bytesProcessed: null }) }, 'SOURCE_TIME_FUTURE'],
      [{ preflight: async () => { throw new BigQueryError('http', 'Access Denied raw', 403) } }, 'SOURCE_ACCESS_DENIED'],
      [{ beginSelect: async () => { throw new CareOrderLinksDbError('SELECT', 'TASKS_OVER_CAP — x') } }, 'TASKS_OVER_CAP'],
      [{ readJob: async () => { throw new CareOrderLinksSourceError('CUSTOMER_ROWS_OVER_CAP') } }, 'CUSTOMER_ROWS_OVER_CAP'],
      [{ jobDone: async () => { throw new CareOrderLinksDbError('JOB', 'JOB_PARAMS_MISMATCH — x') } }, 'JOB_PARAMS_MISMATCH'],
      [{ applyChunk: async () => { throw new CareOrderLinksDbError('CHUNK', 'lỗi lạ') } }, 'DB_CHUNK_FAILED'],
    ]
    for (const [over, code] of cases) {
      const { deps, log } = fakeDeps(over)
      const r = await runCareOrderLinks(deps, { kind: 'regular', mode: 'apply' })
      expect(r).toMatchObject({ ok: false, status: 'failed', code, failRecorded: true })
      expect(log.at(-1)).toBe(`fail:${code}`)
      if (code !== 'DB_CHUNK_FAILED') expect(log).not.toContain('chunk')
      expect(JSON.stringify(r)).not.toContain('raw')
    }
  })
  test('CHUNK_BUSY: backoff 1 s + 2 s + 5 s (tổng 8 s) rồi mới fail; bận rồi thông ⇒ tiếp tục', async () => {
    let calls = 0
    let f = fakeDeps({ applyChunk: async () => { calls++; return { status: 'busy', linksInserted: 0, linksUpdated: 0, relinkRefused: 0 } } })
    const r = await runCareOrderLinks(f.deps, { kind: 'regular', mode: 'apply' })
    expect(r).toMatchObject({ status: 'failed', code: 'CHUNK_BUSY', busyRetries: 3 })
    expect(f.log.filter((x) => x.startsWith('sleep'))).toEqual(CARE_ORDER_LINKS_BUSY_BACKOFF_MS.map((ms) => `sleep:${ms}`))
    expect(CARE_ORDER_LINKS_BUSY_BACKOFF_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(8_000)
    expect(calls).toBe(4)
    calls = 0
    f = fakeDeps({ applyChunk: async () => (++calls < 3 ? { status: 'busy', linksInserted: 0, linksUpdated: 0, relinkRefused: 0 } : { status: 'ok', linksInserted: 1, linksUpdated: 0, relinkRefused: 0 }) })
    expect(await runCareOrderLinks(f.deps, { kind: 'regular', mode: 'apply' })).toMatchObject({ ok: true, busyRetries: 2 })
  })
  test('complete failed (hậu kiểm chốt) ⇒ mã của DB, không gọi fail lần nữa; noop ⇒ RUN_NOT_RUNNING', async () => {
    let f = fakeDeps({ complete: async () => ({ status: 'failed', code: 'CLOSE_COVERAGE_INCOMPLETE' }) })
    expect(await runCareOrderLinks(f.deps, { kind: 'close', mode: 'apply' })).toMatchObject({ ok: false, code: 'CLOSE_COVERAGE_INCOMPLETE', failRecorded: true })
    expect(f.log).not.toContain('fail:CLOSE_COVERAGE_INCOMPLETE')
    f = fakeDeps({ complete: async () => ({ status: 'noop', runStatus: 'abandoned' }) })
    expect(await runCareOrderLinks(f.deps, { kind: 'regular', mode: 'apply' })).toMatchObject({ ok: false, code: 'RUN_NOT_RUNNING' })
  })
})

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Deps của lượt đồng bộ trên PGlite: RPC 116 thật bằng service_role + BigQuery giả. */
function pgliteSyncDeps(db: any, L: any, bq: ReturnType<typeof fakeBq>) {
  const svc = async (sql: string, params: unknown[] = []) => L.as(db, null, async () => (await db.query(sql, params)).rows[0].r, 'service_role')
  const wrapErr = (step: any) => (e: any) => { throw new CareOrderLinksDbError(step, e?.message) }
  const deps: CareOrderLinksDeps = {
    beginOpen: async (kind, mode, retry, cap) => parseBeginOpen(await svc(`SELECT public.care_order_links_begin_open($1, $2, $3::date, $4) r`, [kind, mode, retry, cap]).catch(wrapErr('OPEN'))),
    preflight: () => runN3Preflight(TABLE, bq.run),
    beginSelect: async (id, max, age) => parseBeginSelect(await svc(`SELECT public.care_order_links_begin_select($1, $2, $3) r`, [id, max, age]).catch(wrapErr('SELECT'))),
    runJob: async (id, n) => parseRunJob(await svc(`SELECT public.care_order_links_run_job($1, $2) r`, [id, n]).catch(wrapErr('JOB'))),
    readJob: (job, maxRows) => readOrderLinksJob(TABLE, job, bq.run, { maxRows }),
    jobDone: async (id, n, total, dup, sha) => { await svc(`SELECT public.care_order_links_job_done($1, $2, $3, $4, $5) r`, [id, n, total, dup, sha]).catch(wrapErr('JOB')) },
    applyChunk: async (id, n, c, ids, orders) => parseChunk(await svc(`SELECT public.care_order_links_apply_chunk($1, $2, $3, $4::text[], $5::jsonb) r`, [id, n, c, ids, JSON.stringify(orders)]).catch(wrapErr('CHUNK'))),
    complete: async (id) => parseComplete(await svc(`SELECT public.care_order_links_complete($1) r`, [id]).catch(wrapErr('COMPLETE'))),
    fail: async (id, code) => (await svc(`SELECT public.care_order_links_fail($1, $2) r`, [id, code])).status === 'failed',
    sleep: async () => {},
    now: () => Date.now(),
  }
  return { svc, deps }
}

test.describe('care E2 — đầu–cuối PGlite (RPC 116 thật + BigQuery giả) @desktop', () => {
  test.skip(!HAS_PGLITE, 'chưa cài PGlite — npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')

  test('lượt thường gắn đơn sau mốc import; chạy lại idempotent; trial không ghi; lượt chốt ngoài khung skipped 0 IO', async () => {
    test.setTimeout(300_000)
    const { PGlite } = await import('@electric-sql/pglite')
    const L: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
    const db: any = await L.freshDb(PGlite)
    const todayVN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())
    const P = `${todayVN.slice(0, 7)}-01`
    expect((await L.finalize(db, await L.stage(db, [L.row('QA-E1', 'QAOS01', L.EA, 'P1'), L.row('QA-E2', 'QAOS01', L.EA, 'P1'), L.row('QA-E3', 'QAOS02', L.EC, 'P1')], { period: P }), L.U.mkt, todayVN)).status).toBe('committed')
    const lo = async (ext: string, us = 0) => (await db.query(`SELECT public.care__utc_us(t.created_at + make_interval(secs => $2::double precision / 1e6)) AS u
      FROM public.care_tasks t JOIN public.care_customers c ON c.id = t.customer_id WHERE c.external_id = $1`, [ext, us])).rows[0].u
    const lo1p = await lo('QA-E1', 1), lo2 = await lo('QA-E2')
    const viewOf = (e: string, c: string, utcAt: string) => ({ entity_id: e, order_code: c, completed_at: shiftUs(utcAt, LAG_MS) })
    const view = [viewOf('QA-E1', 'DHC-E1', lo1p), // mốc import + 1 µs
      viewOf('QA-E2', 'DHC-E2-BEFORE', shiftUs(lo2, -60_000)), viewOf('QA-E2', 'DHC-E2', shiftUs(lo2, 1)), { ...viewOf('QA-E3', 'DHC-E3-X', shiftUs(lo2, 2)), type: 'OTHER' }]
    const bq = fakeBq(view)
    const { svc, deps } = pgliteSyncDeps(db, L, bq)
    const links = async () => (await db.query(`SELECT order_key FROM public.care_order_links ORDER BY order_key`)).rows.map((r: any) => r.order_key)
    let r = await runCareOrderLinks(deps, { kind: 'regular', mode: 'apply' })
    expect(r).toMatchObject({ ok: true, status: 'complete', periodMonth: P, tasks: 3, jobs: 1, chunks: 1, rows: 2, linksInserted: 2 })
    expect(await links()).toEqual(['DHC-E1', 'DHC-E2'])
    expect(await L.count(db, `SELECT count(*) FROM public.care_order_task_coverage`)).toBe(3)
    // Băm tham số app = DB cho job thật (đã chứng minh qua job_done) và lặp lại idempotent.
    r = await runCareOrderLinks(deps, { kind: 'regular', mode: 'apply' })
    expect(r).toMatchObject({ ok: true, linksInserted: 0, linksUpdated: 0 })
    const h = await L.one(db, `SELECT md5(string_agg(order_key || task_id::text, ',' ORDER BY order_key)) h FROM public.care_order_links`)
    const tr = await runCareOrderLinks(deps, { kind: 'regular', mode: 'trial' })
    expect(tr).toMatchObject({ ok: true, status: 'trial', trial: { tasksWithOrders: 2, orders: 2 } })
    expect((await L.one(db, `SELECT md5(string_agg(order_key || task_id::text, ',' ORDER BY order_key)) h FROM public.care_order_links`)).h).toBe(h.h)
    expect((await svc(`SELECT public.care_order_links_trial_cleanup() r`)).remaining_trial_runs).toBe(0)
    const before = bq.calls.length
    const cl = await runCareOrderLinks(deps, { kind: 'close', mode: 'apply' })
    expect(cl).toMatchObject({ ok: false, status: 'skipped', code: 'CLOSE_NOT_ELIGIBLE' })
    expect(bq.calls.length).toBe(before) // 0 IO BigQuery
    // Lượt có lỗi nguồn (sha lệch giả) ⇒ fail ghi last_error, last_success giữ.
    const ok0 = await L.one(db, `SELECT public.care__utc_us(last_success_at) s FROM public.care_sync_state WHERE source = 'n3_import_orders'`)
    const bad = await runCareOrderLinks({ ...deps, readJob: async () => { throw new CareOrderLinksSourceError('PARAMS_MISMATCH') } }, { kind: 'regular', mode: 'apply' })
    expect(bad).toMatchObject({ ok: false, code: 'PARAMS_MISMATCH', failRecorded: true })
    const st = await L.one(db, `SELECT public.care__utc_us(last_success_at) s, last_error e FROM public.care_sync_state WHERE source = 'n3_import_orders'`)
    expect(st).toEqual({ s: ok0.s, e: 'PARAMS_MISMATCH' })
  })
})

const T = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
/** ISO µs UTC + us micro giây (BigInt — giữ đủ 6 chữ số). */
function plusUs(iso: string, us: number): string {
  const [head, frac] = iso.slice(0, -1).split('.')
  const K = BigInt(1000)
  const v = BigInt(Date.parse(head + 'Z')) * K + BigInt(frac) + BigInt(us)
  return new Date(Number(v / K)).toISOString().replace(/\.(\d{3})Z$/, (_, d) => `.${d}${String(v % K).padStart(3, '0')}Z`)
}

test.describe('care E — PM 22/10 P1 "số 0 giả": số đơn chỉ hiện khi phạm vi đã quét @desktop', () => {
  test('thuần careImportCountState: trước sync / sang kỳ chưa quét ⇒ none; quét một phần ⇒ partial; quét đủ 0 đơn ⇒ full (0 thật)', () => {
    const at = '2026-10-22T09:40:00.000000Z'
    const cur = (p: Partial<Parameters<typeof careImportCountState>[0]>) => careImportCountState({ isCurrentPeriod: true, lastSuccessAt: at, tasks: 1381, covered: 1381, ...p })
    expect(cur({ lastSuccessAt: null, covered: 0 }), 'trước lượt sync E đầu').toBe('none')
    expect(cur({ lastSuccessAt: null }), 'chưa có lượt thành công ⇒ none dù có coverage').toBe('none')
    expect(cur({ covered: 0 }), 'đã từng sync (kỳ trước) nhưng kỳ này chưa quét task nào').toBe('none')
    expect(cur({ covered: 900 }), 'quét một phần').toBe('partial')
    expect(cur({ partial: true }), 'RPC báo partial (task chậm / lượt lỗi giữ mốc cũ)').toBe('partial')
    expect(cur({}), 'quét đủ — kể cả 0 đơn thật').toBe('full')
    expect(cur({ tasks: 0, covered: 0 }), 'không có task ⇒ 0 / 0 là thật').toBe('full')
    const past = (p: Partial<Parameters<typeof careImportCountState>[0]>) => careImportCountState({ isCurrentPeriod: false, periodStatus: 'closed', lastSuccessAt: at, tasks: 10, covered: 10, ...p })
    expect(past({ periodStatus: 'none', covered: 0 }), 'kỳ cũ trước go-live E').toBe('none')
    expect(past({}), 'kỳ cũ đã chốt đủ').toBe('full')
    expect(past({ periodStatus: 'close_failed', covered: 7 }), 'kỳ cũ chốt lỗi một phần').toBe('partial')
    // F1: truyền `now` ⇒ kỳ hiện tại quá 24 giờ từ lần thành công = một phần; kỳ cũ không xét thời gian.
    const now = new Date('2026-10-23T09:40:01Z')
    expect(cur({ now }), 'đúng 24 giờ + 1 s').toBe('partial')
    expect(cur({ now: new Date('2026-10-23T09:39:59Z') }), 'chưa tới 24 giờ').toBe('full')
    expect(past({ now }), 'kỳ cũ không xét 24 giờ').toBe('full')
    expect(careImportStale(null, now)).toBe(false)
  })
  test('thuần careMyOrdersView (/care/my F1): gộp tóm tắt + trạng thái lượt CÙNG kỳ; nguồn lỗi / lệch kỳ ⇒ không kết luận; QA bỏ trạng thái thật', () => {
    const at = '2026-10-22T09:40:00.000000Z'
    const now = new Date('2026-10-22T12:00:00Z')
    const summary = { tasks: 40, covered: 40, tasksWithOrders: 0, orders: 0, lastSuccessAt: at }
    const status = { periodMonth: '2026-10-01', isCurrentPeriod: true, hasSynced: true, lastSuccessAt: at, lastFailed: false,
      periodStatus: 'active' as const, closedAt: null, closedThrough: null, chain: null }
    const v = (p: Partial<Parameters<typeof careMyOrdersView>[0]>) => careMyOrdersView({ summary, status, period: '2026-10-01', now, qa: false, ...p })
    expect(v({}), 'quét đủ, lượt OK, 0 đơn THẬT').toEqual({ state: 'full', note: null })
    expect(v({ summary: null }).state, 'tóm tắt lỗi').toBe('none')
    expect(v({ status: 'error' }), 'RPC trạng thái lỗi ⇒ không kết luận + thử lại').toEqual({ state: 'none', note: 'Không đọc được trạng thái đồng bộ đơn — tải lại trang để thử lại.' })
    expect(v({ status: null }).state, 'RPC trạng thái null').toBe('none')
    expect(v({ status: { ...status, periodMonth: '2026-09-01' } }).state, 'lệch kỳ').toBe('none')
    expect(v({ status: { ...status, isCurrentPeriod: false } }).state, 'trạng thái không phải kỳ hiện tại').toBe('none')
    expect(v({ summary: { ...summary, covered: 0, lastSuccessAt: null } }).state, 'trước sync').toBe('none')
    const failed = v({ status: { ...status, lastFailed: true } })
    expect(failed.state).toBe('partial')
    const DONE = 'Lượt đồng bộ hoàn tất gần nhất: 16:40 22/10/2026; số đang hiện có thể gồm task đã cập nhật sau mốc này, chưa phải số đầy đủ của cả kỳ.'
    expect(failed.note).toBe(`Chưa cập nhật — lượt đồng bộ đơn gần nhất chưa thành công. ${DONE}`)
    const stale = v({ now: new Date('2026-10-23T10:00:00Z') })
    expect(stale.state).toBe('partial')
    expect(stale.note).toBe(`Chưa cập nhật quá 24 giờ. ${DONE}`)
    const part = v({ summary: { ...summary, covered: 30 } })
    expect(part.state).toBe('partial')
    expect(part.note).toBe(`Đang cập nhật một phần — còn khách chưa được quét đơn. ${DONE}`)
    // PM 23/10 P1-1: hoàn tất T0 = 200 task có đơn → lượt T1 ghi chunk thêm 5 task rồi lỗi ⇒ đọc 205; hiện như một phần, KHÔNG nói
    // 205 là số "theo" mốc T0.
    const t1 = v({ summary: { ...summary, tasks: 400, covered: 400, tasksWithOrders: 205, orders: 260 }, status: { ...status, lastFailed: true } })
    expect(t1.state).toBe('partial')
    expect(t1.note).toContain('Lượt đồng bộ hoàn tất gần nhất: 16:40 22/10/2026')
    expect(t1.note).toContain('có thể gồm task đã cập nhật sau mốc này')
    expect(t1.note).not.toMatch(/theo lần thành công|số theo|cập nhật lúc/)
    // QA (fixture is_test): không đọc / không áp trạng thái lượt THẬT — lượt thật lỗi hay quá hạn không đổi kết quả fixture.
    expect(v({ qa: true, status: null }), 'QA bỏ trạng thái thật').toEqual({ state: 'full', note: null })
    expect(v({ qa: true, status: 'error', now: new Date('2026-10-25T00:00:00Z') }).state, 'QA không xét 24 giờ của lượt thật').toBe('full')
    expect(v({ qa: true, status: null, summary: { ...summary, covered: 0 } }).state, 'QA fixture chưa quét').toBe('none')
  })
  test('nguồn: 3 bề mặt E (/care/my, /care/orders, /care/reports) đều qua careImportCountState trước khi hiện số', () => {
    const rd = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8')
    const my = rd('app/(dashboard)/care/my/page.tsx')
    expect(my).toMatch(/careMyOrdersView\(\{ summary: orderSummary, status: orderStatus, period, now, qa: qaScope \}\)/)
    expect(my).toMatch(/ui && !qaScope \? loadImportOrderState\(period\)\.catch\(\(\) => 'error' as const\)/)
    expect(my).toMatch(/ordersState !== 'none'/)
    const orders = rd('components/care/CareOrdersScreen.tsx')
    expect(orders).toMatch(/<CareImportOrdersSummary /)
    // audit vòng 2 P1-2: nối dây trạng thái lượt (bàn thử không bắt được nếu trang bỏ status / catch).
    expect(orders).toMatch(/loadImportOrderState\(scoped\.month\)\.catch\(\(\) => 'error' as const\)/)
    expect(orders).toMatch(/<CareImportOrdersSummary list=\{list\} status=\{status\} now=\{new Date\(\)\}/)
    const reports = rd('app/(dashboard)/care/reports/page.tsx')
    expect(reports).toMatch(/loadImportOrderState\(f\.month\)\.catch\(\(\) => 'error' as const\)/)
    expect(reports).toMatch(/<CareImportOrdersBlock state=\{importState\} /)
    // PM 23/10 P1-1: không bề mặt E nào gán số cho mốc thành công cũ.
    for (const f of ['lib/care/orderLinks/view.ts', 'components/care/CareImportOrdersSummary.tsx', 'components/care/CareImportOrdersBlock.tsx']) {
      expect(rd(f), f).not.toMatch(/theo lần thành công|giữ dữ liệu đến lần thành công/)
    }
    expect(rd('components/care/CareOrdersScreen.tsx')).not.toMatch(/task có đơn sau import/)
    expect(rd('components/care/CareImportOrdersSummary.tsx')).toMatch(/careImportCountState\(/)
    expect(rd('components/care/CareImportOrdersBlock.tsx')).toMatch(/state\.chain && cs !== 'none'/)
  })
})

test.describe('care E3 r1.1 — chip "Có đơn xác thực" của dược sĩ: keyset + tìm trong nhóm (PM E1–E3 r1 P1) @desktop', () => {
  test('thuần: nối trang bỏ trùng; parse fail-closed; counts chia khối ≤ 50, cùng thứ tự RPC, trang theo số', async () => {
    const r = (id: string) => ({ id })
    expect(appendNewById([r('a'), r('b')], [r('b'), r('c'), r('c')]).map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(parseMyOrderTasks(null)).toEqual({ rows: [], hasMore: false })
    for (const bad of [{ has_more: false }, { rows: [{ task_id: 'x', latest_completed_at: '2030-01-01T00:00:00.000000Z' }], has_more: false },
      { rows: [{ task_id: T(1), latest_completed_at: '2030-01-01T00:00:00Z' }], has_more: false }, { rows: [], has_more: 'false' }]) {
      expect(() => parseMyOrderTasks(bad), JSON.stringify(bad)).toThrow('care_order_view_malformed')
    }
    for (const bad of [{}, null, [{ task_id: T(1), orders_count: -1, latest_completed_at: null }], [{ task_id: T(1), orders_count: 1, latest_completed_at: 'x' }]]) {
      expect(() => parseTaskOrderCounts(bad), JSON.stringify(bad)).toThrow('care_order_view_malformed')
    }
    // RPC giả: id chẵn có đơn (latest hoà theo n % 7 ⇒ thứ tự phụ theo task_id DESC); 120 id ⇒ 50 + 50 + 20.
    const ids = Array.from({ length: 120 }, (_, i) => T(i + 1))
    const sizes: number[] = []
    const rpc: CareOrderRpc = async (fn, args) => {
      expect(fn).toBe('care_task_order_counts')
      const a = args.p_task_ids as string[]
      sizes.push(a.length)
      return a.map((id) => {
        const n = Number(id.slice(-4))
        return { task_id: id, orders_count: n % 2 === 0 ? 1 : 0, latest_completed_at: n % 2 === 0 ? `2030-01-01T00:00:0${n % 7}.000000Z` : null }
      })
    }
    const pages = [await myOrderSearchPage(rpc, ids, 1), await myOrderSearchPage(rpc, ids, 2), await myOrderSearchPage(rpc, ids, 3), await myOrderSearchPage(rpc, ids, 4)]
    expect(sizes.slice(0, 3)).toEqual([50, 50, 20])
    expect(pages.map((p) => [p.total, p.pageIds.length])).toEqual([[60, 20], [60, 20], [60, 20], [60, 0]])
    const flat = pages.flatMap((p) => p.pageIds)
    const key = (id: string) => { const n = Number(id.slice(-4)); return `${n % 7}|${id}` }
    expect(new Set(flat).size).toBe(60)
    expect(flat).toEqual([...flat].sort((x, y) => (key(x) < key(y) ? 1 : -1)))
    expect(await myOrderSearchPage(rpc, [], 1)).toEqual({ pageIds: [], total: 0 })
    // TODO(Q-200): quá trần ⇒ báo thu hẹp từ khoá, 0 lần gọi RPC (không cắt kết quả).
    const before = sizes.length
    const many = Array.from({ length: CARE_MY_ORDER_SEARCH_MAX_IDS + 1 }, (_, i) => T(i + 1))
    await expect(myOrderSearchPage(rpc, many, 1)).rejects.toBeInstanceOf(CareOrderSearchTooBroadError)
    expect(sizes.length).toBe(before)
    expect((await myOrderSearchPage(rpc, many.slice(0, CARE_MY_ORDER_SEARCH_MAX_IDS), 1)).total).toBe(CARE_MY_ORDER_SEARCH_MAX_IDS / 2)
  })

  test('PGlite 21 / 41 task: myOrderTaskPage đi hết bằng cursor ký (không lặp / mất); cursor khác người / kỳ / phạm vi / khoá / bị sửa ⇒ lỗi; tìm trong nhóm', async () => {
    test.skip(!HAS_PGLITE, 'chưa cài PGlite — npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
    test.setTimeout(300_000)
    const { PGlite } = await import('@electric-sql/pglite')
    const L: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
    const db: any = await L.freshDb(PGlite)
    const todayVN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())
    const P = `${todayVN.slice(0, 7)}-01`
    const pad = (i: number) => String(i).padStart(2, '0')
    const rows = [
      ...Array.from({ length: 41 }, (_, i) => L.row(`QA-MA${pad(i)}`, 'QAOS01', L.EA, 'P1')),
      ...Array.from({ length: 15 }, (_, i) => L.row(`QA-MN${pad(i)}`, 'QAOS01', L.EA, 'P1')),
      ...Array.from({ length: 21 }, (_, i) => L.row(`QA-MB${pad(i)}`, 'QAOS01', L.EB, 'P1')),
    ]
    expect((await L.finalize(db, await L.stage(db, rows, { period: P }), L.U.mkt, todayVN)).status).toBe('committed')
    const lo = (await L.one(db, `SELECT public.care__utc_us(max(created_at)) AS u FROM public.care_tasks`)).u
    const viewOf = (e: string, c: string, utcAt: string) => ({ entity_id: e, order_code: c, completed_at: shiftUs(utcAt, LAG_MS) })
    // MA-19 / MA-20 cùng mốc (hoà đúng biên trang 20).
    const view = [
      ...Array.from({ length: 41 }, (_, i) => viewOf(`QA-MA${pad(i)}`, `DHC-MA${i}`, plusUs(lo, 1000 - (i === 20 ? 19 : i)))),
      ...Array.from({ length: 21 }, (_, i) => viewOf(`QA-MB${pad(i)}`, `DHC-MB${i}`, plusUs(lo, 500 - i))),
    ]
    const { deps } = pgliteSyncDeps(db, L, fakeBq(view))
    expect(await runCareOrderLinks(deps, { kind: 'regular', mode: 'apply' })).toMatchObject({ ok: true, status: 'complete', linksInserted: 62 })
    const rpcAs = (uid: string): CareOrderRpc => async (fn, a) => L.as(db, uid, async () => {
      if (fn === 'care_my_order_tasks') {
        return (await db.query(`SELECT public.care_my_order_tasks($1::uuid, $2::timestamptz, $3::uuid, $4::int) r`,
          [a.p_qa_batch_id, a.p_after_latest, a.p_after_task_id, a.p_limit])).rows[0].r
      }
      if (fn === 'care_task_order_counts') return (await db.query(`SELECT public.care_task_order_counts($1::uuid[]) r`, [a.p_task_ids])).rows[0].r
      throw new Error(`rpc lạ: ${fn}`)
    })
    const KEY = 'qa-cursor-key'
    const walk = async (uid: string) => {
      const pages: string[][] = []
      let cur: string | null = null
      for (let k = 0; k < 10; k++) {
        const p = await myOrderTaskPage(rpcAs(uid), KEY, uid, P, null, cur)
        pages.push(p.taskIds)
        if (!p.next) break
        cur = p.next
      }
      return pages
    }
    const idsOf = async (prefix: string) => (await db.query(`SELECT t.id FROM public.care_tasks t JOIN public.care_customers c ON c.id = t.customer_id
      WHERE c.external_id LIKE $1 ORDER BY t.id`, [prefix + '%'])).rows.map((x: any) => x.id as string)
    const idsMA = await idsOf('QA-MA'), idsMN = await idsOf('QA-MN'), idsMB = await idsOf('QA-MB')
    const pA = await walk(L.U.A), pB = await walk(L.U.B)
    expect(pA.map((x) => x.length)).toEqual([20, 20, 1])
    expect(pB.map((x) => x.length)).toEqual([20, 1])
    expect(new Set(pA.flat()).size).toBe(41)
    expect([...pA.flat()].sort()).toEqual([...idsMA].sort())
    expect([...pB.flat()].sort()).toEqual([...idsMB].sort())
    // Cursor gắn user + kỳ + phạm vi QA + khoá; sửa một ký tự ⇒ lỗi (không đoán trang).
    const first = await myOrderTaskPage(rpcAs(L.U.A), KEY, L.U.A, P, null)
    const nextP = `${Number(P.slice(0, 4)) + 1}${P.slice(4)}`
    const tampered = first.next!.slice(0, -2) + (first.next!.endsWith('AA') ? 'BB' : 'AA')
    for (const [who, period, qa, key, cur] of [[L.U.B, P, null, KEY, first.next], [L.U.A, nextP, null, KEY, first.next], [L.U.A, P, T(4242), KEY, first.next],
      [L.U.A, P, null, 'khoa-khac', first.next], [L.U.A, P, null, KEY, tampered]] as const) {
      await expect(myOrderTaskPage(rpcAs(who), key, who, period, qa, cur)).rejects.toBeInstanceOf(CareOrderCursorError)
    }
    // Tìm trong nhóm: 41 + 15 + 21 id (kể cả id của B) ⇒ chỉ 41 task có đơn của A, cùng thứ tự với danh sách chip.
    const all = [...idsMA, ...idsMN, ...idsMB]
    const s = [await myOrderSearchPage(rpcAs(L.U.A), all, 1), await myOrderSearchPage(rpcAs(L.U.A), all, 2), await myOrderSearchPage(rpcAs(L.U.A), all, 3)]
    expect(s.map((p) => [p.total, p.pageIds.length])).toEqual([[41, 20], [41, 20], [41, 1]])
    expect(s.flatMap((p) => p.pageIds)).toEqual(pA.flat())
    expect((await myOrderSearchPage(rpcAs(L.U.B), idsMA, 1)).total).toBe(0)
  })
})

test.describe('care E2 — cờ + nguồn route @desktop', () => {
  test('cờ: chỉ đúng chuỗi "true"; .env.example khai 3 cờ = false', () => {
    for (const v of [undefined, '', '1', 'TRUE', ' true', 'yes']) {
      expect(careOrderLinksFlagsFromEnv({ CARE_ORDER_LINKS_SYNC_ENABLED: v, CARE_ORDER_LINKS_UI_ENABLED: v, CARE_ORDER_LINKS_TRIAL_ENABLED: v })).toEqual({ sync: false, ui: false, trial: false })
    }
    expect(careOrderLinksFlagsFromEnv({ CARE_ORDER_LINKS_UI_ENABLED: 'true' })).toEqual({ sync: false, ui: true, trial: false })
    const ex = read('.env.example')
    for (const k of ['CARE_ORDER_LINKS_SYNC_ENABLED', 'CARE_ORDER_LINKS_UI_ENABLED', 'CARE_ORDER_LINKS_TRIAL_ENABLED']) expect(ex).toMatch(new RegExp(`^${k}=false$`, 'm'))
  })
  test('route: Bearer CRON_SECRET trước cờ; cờ OFF ⇒ 503 không IO; log / response không message thô', () => {
    for (const f of ['care-order-links-sync', 'care-order-links-close', 'care-order-links-trial']) {
      const src = read(`app/api/cron/${f}/route.ts`)
      const auth = src.indexOf("secret !== process.env.CRON_SECRET"), flag = src.search(/isCareOrderLinks(Sync|Trial)Enabled\(\)\)/), run = src.search(/runCareOrderLinksSync\(|cleanupCareOrderLinksTrial\(/)
      expect(auth).toBeGreaterThan(0)
      expect(flag).toBeGreaterThan(auth)
      expect(run).toBeGreaterThan(flag)
      expect(src).toContain('status: 503')
      expect(src).not.toMatch(/error\.message|err\.message|e\.message/)
    }
    expect(read('app/api/cron/care-order-links-close/route.ts')).toContain("request.headers.get('x-care-close-retry')")
    const lib = read('lib/care/server/orderLinksSync.ts')
    expect(lib).toContain("import 'server-only'")
    expect(lib).not.toMatch(/console\.(log|warn|error)\(.*message/)
  })
})
