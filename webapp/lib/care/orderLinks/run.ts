// CRM-CSKH E — điều phối MỘT lượt "đơn xác thực sau import" (thiết kế E0 r3.4 §4.1). THUẦN: IO tiêm qua deps.
//   1. begin_open (DB, dưới L): busy ⇒ RUN_IN_PROGRESS (không ghi gì); lượt chốt ngoài khung / không đủ điều kiện ⇒
//      skipped CLOSE_NOT_ELIGIBLE — CHƯA có IO BigQuery.
//   2. preflight VIEW (Q-100): mốc tương lai ⇒ SOURCE_TIME_FUTURE; ghi max_age_minutes vào run.
//   3. begin_select (DB chọn MỌI task của kỳ run, chia job). Vượt trần ⇒ TASKS_OVER_CAP.
//   4. ĐỌC HẾT mọi job (BigQuery) + job_done từng job (DB so băm tham số) — lỗi bất kỳ ⇒ fail, chưa chunk nào được áp.
//   5. áp chunk (≤ 2.000 khách / ≤ 5.000 đơn); CHUNK_BUSY ⇒ backoff tổng ≥ 8 s rồi mới fail.
//   6. complete: thường ⇒ complete; chốt ⇒ closed hoặc failed (hậu kiểm DB) — DB đã ghi close_failed cùng transaction.
// Mọi thất bại sau khi có run ⇒ fail(run, mã) (no-op nếu run đã kết thúc). Kết quả chỉ số đếm / mã: không ID khách, DHC,
// thời điểm đơn, message thô.
import type { CareN3Order } from '../orders/n3'
import { CareN3SourceError, careN3ErrorCode, type CareN3Preflight } from '../orders/source'
import { CARE_ORDER_LINKS_LIMITS, CARE_US_TS, CareOrderLinksSourceError, planOrderLinksChunks, type CareOrderLinksJob, type CareOrderLinksJobRead } from './source'

export type CareOrderLinksKind = 'regular' | 'close'
export type CareOrderLinksMode = 'apply' | 'trial'

/** Backoff khi chunk bận (khoá kỳ / L / KEY SHARE): tổng 8 s (E0 §15.2) rồi fail CHUNK_BUSY. */
export const CARE_ORDER_LINKS_BUSY_BACKOFF_MS = [1_000, 2_000, 5_000] as const

/** Mã DB RAISE ở đầu message (`MÃ — mô tả`) mà app nhận ra; còn lại ⇒ DB_<BƯỚC>_FAILED. */
export const CARE_ORDER_LINKS_DB_CODES = [
  'RUN_NOT_PREPARING', 'RUN_NOT_RUNNING', 'RUN_NOT_FOUND', 'TASKS_OVER_CAP', 'JOB_NOT_FOUND', 'JOB_COUNTS_INVALID', 'JOB_PARAMS_MISMATCH',
  'JOB_ALREADY_DONE', 'JOBS_NOT_DONE', 'CHUNK_INVALID', 'CHUNK_DUPLICATE_ORDER_KEY', 'CHUNK_ORDER_OUT_OF_WINDOW', 'CHUNK_CONFLICT',
  'CHUNK_CUSTOMERS_INVALID', 'CHUNK_TASK_MISSING', 'TARGET_INVARIANT_BROKEN', 'PERIOD_CLOSED_FOR_ORDERS', 'CLOSE_STATE_MISSING',
] as const
export type CareOrderLinksDbCode = (typeof CARE_ORDER_LINKS_DB_CODES)[number]

export type CareOrderLinksStep = 'OPEN' | 'SELECT' | 'JOB' | 'CHUNK' | 'COMPLETE'

/** Lỗi RPC: bước + mã DB nếu message bắt đầu bằng mã đã biết (không giữ message thô). */
export class CareOrderLinksDbError extends Error {
  readonly step: CareOrderLinksStep
  readonly dbCode: CareOrderLinksDbCode | null
  constructor(step: CareOrderLinksStep, message: string | null | undefined) {
    super(`care_order_links_db:${step}`)
    this.name = 'CareOrderLinksDbError'
    this.step = step
    const m = /^([A-Z][A-Z0-9_]{2,63}) —/.exec(message ?? '')
    this.dbCode = m && (CARE_ORDER_LINKS_DB_CODES as readonly string[]).includes(m[1]) ? (m[1] as CareOrderLinksDbCode) : null
  }
}

export type CareOrderLinksOpen =
  | { status: 'ok'; runId: number; periodMonth: string; snapshotAt: string; upperBound: string; isClose: boolean }
  | { status: 'busy'; code: 'RUN_IN_PROGRESS' }
  | { status: 'skipped'; code: 'CLOSE_NOT_ELIGIBLE'; periodMonth: string | null; periodStatus: string | null }

export interface CareOrderLinksChunkResult { status: 'ok' | 'duplicate' | 'busy'; linksInserted: number; linksUpdated: number; relinkRefused: number }

export type CareOrderLinksComplete =
  | { status: 'complete' | 'closed'; tasks: number; chunks: number }
  | { status: 'trial'; tasks: number; tasksWithOrders: number; orders: number; checksum: string }
  | { status: 'failed'; code: string }
  | { status: 'noop'; runStatus: string }

export interface CareOrderLinksDeps {
  beginOpen(kind: CareOrderLinksKind, mode: CareOrderLinksMode, retryPeriod: string | null, perCustomerCap: number): Promise<CareOrderLinksOpen>
  preflight(): Promise<CareN3Preflight>
  beginSelect(runId: number, maxTasks: number, maxAgeMinutes: number | null): Promise<{ tasks: number; jobs: number }>
  runJob(runId: number, jobNo: number): Promise<CareOrderLinksJob>
  readJob(job: CareOrderLinksJob, maxRows: number): Promise<CareOrderLinksJobRead>
  jobDone(runId: number, jobNo: number, bqTotalRows: number, duplicatesDropped: number, paramsSha256: string): Promise<void>
  applyChunk(runId: number, jobNo: number, chunkNo: number, customerIds: string[], orders: CareN3Order[]): Promise<CareOrderLinksChunkResult>
  complete(runId: number): Promise<CareOrderLinksComplete>
  fail(runId: number, code: string): Promise<boolean>
  sleep(ms: number): Promise<void>
  now(): number
}

export interface CareOrderLinksRunResult {
  ok: boolean
  kind: CareOrderLinksKind
  mode: CareOrderLinksMode
  /** complete / closed / trial (thành công) · busy / skipped (không chạy) · failed. */
  status: 'complete' | 'closed' | 'trial' | 'busy' | 'skipped' | 'failed'
  code?: string
  periodMonth: string | null
  periodStatus: string | null
  tasks: number | null
  jobs: number
  chunks: number
  rows: number
  duplicatesDropped: number
  linksInserted: number
  linksUpdated: number
  relinkRefused: number
  busyRetries: number
  bytesProcessed: number | null
  maxAgeMinutes: number | null
  trial: { tasksWithOrders: number; orders: number; checksum: string } | null
  /** Chỉ khi thất bại sau khi có run: mã đã được ghi vào DB chưa (false = run đã kết thúc / ghi lỗi). */
  failRecorded: boolean | null
  elapsedMs: number
}

export interface CareOrderLinksRunOptions {
  kind: CareOrderLinksKind
  mode: CareOrderLinksMode
  /** Chỉ lượt chốt apply: kỳ `YYYY-MM-01` từ header X-Care-Close-Retry. */
  retryPeriod?: string | null
  limits?: Partial<typeof CARE_ORDER_LINKS_LIMITS>
}

const sourceCode = (err: unknown): string => {
  if (err instanceof CareOrderLinksSourceError) return err.code
  return `SOURCE_${careN3ErrorCode(err).toUpperCase()}`
}
const dbCode = (err: unknown, step: CareOrderLinksStep): string =>
  (err instanceof CareOrderLinksDbError && err.dbCode) ? err.dbCode : `DB_${step}_FAILED`

export async function runCareOrderLinks(deps: CareOrderLinksDeps, opts: CareOrderLinksRunOptions): Promise<CareOrderLinksRunResult> {
  const t0 = deps.now()
  const lim = { ...CARE_ORDER_LINKS_LIMITS, ...opts.limits }
  const res: CareOrderLinksRunResult = {
    ok: false, kind: opts.kind, mode: opts.mode, status: 'failed', periodMonth: null, periodStatus: null, tasks: null, jobs: 0, chunks: 0,
    rows: 0, duplicatesDropped: 0, linksInserted: 0, linksUpdated: 0, relinkRefused: 0, busyRetries: 0, bytesProcessed: null,
    maxAgeMinutes: null, trial: null, failRecorded: null, elapsedMs: 0,
  }
  const finish = () => { res.elapsedMs = deps.now() - t0; return res }

  let open: CareOrderLinksOpen
  try {
    open = await deps.beginOpen(opts.kind, opts.mode, opts.retryPeriod ?? null, lim.perCustomerCap)
  } catch (err) {
    res.code = dbCode(err, 'OPEN')
    return finish()
  }
  if (open.status === 'busy') { res.status = 'busy'; res.code = open.code; return finish() }
  if (open.status === 'skipped') {
    res.status = 'skipped'; res.code = open.code; res.periodMonth = open.periodMonth; res.periodStatus = open.periodStatus
    return finish()
  }
  const runId = open.runId
  res.periodMonth = open.periodMonth
  const failWith = async (code: string) => {
    res.ok = false
    res.status = 'failed'
    res.code = code
    try { res.failRecorded = await deps.fail(runId, code) } catch { res.failRecorded = false }
    return finish()
  }

  try {
    const pre = await deps.preflight()
    res.maxAgeMinutes = pre.maxAgeMinutes
    if (pre.bytesProcessed !== null) res.bytesProcessed = pre.bytesProcessed
    if (pre.futureCount > 0) return failWith('SOURCE_TIME_FUTURE')
  } catch (err) {
    return failWith(sourceCode(err))
  }

  let sel: { tasks: number; jobs: number }
  try {
    sel = await deps.beginSelect(runId, lim.maxTasksRun, res.maxAgeMinutes)
  } catch (err) {
    return failWith(dbCode(err, 'SELECT'))
  }
  res.tasks = sel.tasks

  // Đọc HẾT rồi mới ghi.
  const reads: { job: CareOrderLinksJob; read: CareOrderLinksJobRead }[] = []
  for (let n = 1; n <= sel.jobs; n++) {
    let job: CareOrderLinksJob
    try { job = await deps.runJob(runId, n) } catch (err) { return failWith(dbCode(err, 'JOB')) }
    let read: CareOrderLinksJobRead
    try {
      read = await deps.readJob(job, lim.maxRowsRun - res.rows - res.duplicatesDropped)
    } catch (err) {
      return failWith(err instanceof CareOrderLinksSourceError || err instanceof CareN3SourceError ? sourceCode(err) : 'SOURCE_UNKNOWN')
    }
    res.jobs++
    res.rows += read.orders.length
    res.duplicatesDropped += read.duplicatesDropped
    if (read.bytesProcessed !== null) res.bytesProcessed = (res.bytesProcessed ?? 0) + read.bytesProcessed
    try { await deps.jobDone(runId, n, read.bqTotalRows, read.duplicatesDropped, job.paramsSha256) } catch (err) { return failWith(dbCode(err, 'JOB')) }
    reads.push({ job, read })
  }

  let chunkNo = 0
  for (const { job, read } of reads) {
    let chunks
    try { chunks = planOrderLinksChunks(job, read.orders, lim) } catch (err) { return failWith(sourceCode(err)) }
    for (const ch of chunks) {
      chunkNo++
      let r: CareOrderLinksChunkResult | null = null
      for (let attempt = 0; ; attempt++) {
        try { r = await deps.applyChunk(runId, job.jobNo, chunkNo, ch.customerIds, ch.orders) } catch (err) { return failWith(dbCode(err, 'CHUNK')) }
        if (r.status !== 'busy') break
        if (attempt >= CARE_ORDER_LINKS_BUSY_BACKOFF_MS.length) return failWith('CHUNK_BUSY')
        res.busyRetries++
        await deps.sleep(CARE_ORDER_LINKS_BUSY_BACKOFF_MS[attempt])
      }
      res.chunks++
      res.linksInserted += r.linksInserted
      res.linksUpdated += r.linksUpdated
      res.relinkRefused += r.relinkRefused
    }
  }

  let done: CareOrderLinksComplete
  try { done = await deps.complete(runId) } catch (err) { return failWith(dbCode(err, 'COMPLETE')) }
  if (done.status === 'failed') {
    // DB đã ghi run failed + trạng thái (close_failed / last_error) cùng transaction.
    res.status = 'failed'; res.code = done.code; res.failRecorded = true
    return finish()
  }
  if (done.status === 'noop') return failWith('RUN_NOT_RUNNING')
  if (done.status === 'trial') res.trial = { tasksWithOrders: done.tasksWithOrders, orders: done.orders, checksum: done.checksum }
  res.ok = true
  res.status = done.status
  return finish()
}

// ── Kiểm dạng jsonb của RPC (server deps dùng; thuần để test) ───────────────────────────────────────────────────────
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const isPeriod = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-01$/.test(v)
const malformed = () => new Error('care_order_links_result_malformed')

export function parseBeginOpen(raw: unknown): CareOrderLinksOpen {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object') throw malformed()
  if (r.status === 'busy' && r.code === 'RUN_IN_PROGRESS') return { status: 'busy', code: 'RUN_IN_PROGRESS' }
  if (r.status === 'skipped' && r.code === 'CLOSE_NOT_ELIGIBLE') {
    return { status: 'skipped', code: 'CLOSE_NOT_ELIGIBLE', periodMonth: isPeriod(r.period_month) ? r.period_month : null,
      periodStatus: typeof r.period_status === 'string' ? r.period_status : null }
  }
  if (r.status !== 'ok' || !isCount(r.run_id) || r.run_id < 1 || !isPeriod(r.period_month) || typeof r.snapshot_at !== 'string'
      || !CARE_US_TS.test(r.snapshot_at) || typeof r.upper_bound !== 'string' || !CARE_US_TS.test(r.upper_bound) || typeof r.is_close !== 'boolean') {
    throw malformed()
  }
  return { status: 'ok', runId: r.run_id, periodMonth: r.period_month, snapshotAt: r.snapshot_at, upperBound: r.upper_bound, isClose: r.is_close }
}

export function parseBeginSelect(raw: unknown): { tasks: number; jobs: number } {
  const r = raw as Record<string, unknown> | null
  if (!r || r.status !== 'running' || !isCount(r.tasks) || !isCount(r.jobs) || r.jobs !== Math.ceil(r.tasks / 10_000)) throw malformed()
  return { tasks: r.tasks, jobs: r.jobs }
}

export function parseChunk(raw: unknown): CareOrderLinksChunkResult {
  const r = raw as Record<string, unknown> | null
  if (!r) throw malformed()
  if (r.status === 'busy' && r.code === 'CHUNK_BUSY') return { status: 'busy', linksInserted: 0, linksUpdated: 0, relinkRefused: 0 }
  if (r.status === 'duplicate') return { status: 'duplicate', linksInserted: 0, linksUpdated: 0, relinkRefused: 0 }
  if (r.status !== 'ok') throw malformed()
  if (r.mode === 'trial') return { status: 'ok', linksInserted: 0, linksUpdated: 0, relinkRefused: 0 }
  if (!isCount(r.links_inserted) || !isCount(r.links_updated) || !isCount(r.relink_refused)) throw malformed()
  return { status: 'ok', linksInserted: r.links_inserted, linksUpdated: r.links_updated, relinkRefused: r.relink_refused }
}

export function parseComplete(raw: unknown): CareOrderLinksComplete {
  const r = raw as Record<string, unknown> | null
  if (!r) throw malformed()
  if (r.status === 'failed' && typeof r.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(r.code)) return { status: 'failed', code: r.code }
  if (r.status === 'noop' && typeof r.run_status === 'string') return { status: 'noop', runStatus: r.run_status }
  if (r.status === 'complete' && r.mode === 'trial') {
    if (!isCount(r.tasks) || !isCount(r.tasks_with_orders) || !isCount(r.orders) || typeof r.checksum !== 'string') throw malformed()
    return { status: 'trial', tasks: r.tasks, tasksWithOrders: r.tasks_with_orders, orders: r.orders, checksum: r.checksum }
  }
  if ((r.status === 'complete' || r.status === 'closed') && isCount(r.tasks) && isCount(r.chunks)) return { status: r.status, tasks: r.tasks, chunks: r.chunks }
  throw malformed()
}

/** Header X-Care-Close-Retry: `YYYY-MM` ⇒ `YYYY-MM-01`; thiếu ⇒ null; sai dạng ⇒ 'invalid'. */
export function parseCloseRetryHeader(v: string | null): string | null | 'invalid' {
  if (v === null) return null
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(v.trim())
  return m ? `${m[1]}-${m[2]}-01` : 'invalid'
}
