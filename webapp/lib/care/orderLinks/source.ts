// CRM-CSKH E — nguồn N3 cho "đơn xác thực sau import" (thiết kế E0 r3.4 §4.1 bước 4–5). THUẦN (IO tiêm qua `runQuery`).
// Một job = ≤ 10.000 task của MỘT lượt (DB chia theo external_id COLLATE "C"); tham số BigQuery là mảng song song
// customer_ids / from_ts lấy NGUYÊN từ RPC care_order_links_run_job (không tự sắp xếp, không qua JS Date) và được băm
// cùng thuật toán với DB (care__order_links_params_sha) ⇒ job_done chứng minh đã đọc đúng tập task.
// Cửa sổ mỗi task: (lo, upper_bound] — lượt chốt nghiêm ngặt < upper_bound (= P_end). Mỗi khách lấy tối đa cap + 1 dòng
// (QUALIFY) ⇒ thấy cap + 1 ⇒ CUSTOMER_ROWS_OVER_CAP (fail-closed). Tất cả-hoặc-không: lỗi bất kỳ ⇒ ném, không trả gì.
import { createHash } from 'node:crypto'
import { BigQueryError, type BqParam } from '../../bigquery/query'
import { CARE_N3_PROJECTION, CareN3SourceError, assertN3Fields, careN3ErrorCode, careN3SourceCte, type CareN3RunQuery } from '../orders/source'
import { parseN3Rows, type CareN3Order } from '../orders/n3'

/** Trần tạm (Q-180 — chốt sau phép đo E0 §4.3). DB ép riêng: ≤ 10.000 task / job, chunk ≤ 2.000 khách / ≤ 5.000 đơn. */
// TODO(Q-180): chốt trần sau đo tải 1.384 / 10.000 / 20.000 task.
export const CARE_ORDER_LINKS_LIMITS = {
  maxTasksRun: 20_000,
  maxRowsRun: 100_000,
  perCustomerCap: 5_000,
  chunkCustomers: 2_000,
  chunkOrders: 5_000,
} as const

/** Hạn tổng mỗi job BigQuery (poll + mọi trang) — như 114; đo lại khi trial. */
export const CARE_ORDER_LINKS_QUERY_DEADLINE_MS = 120_000

/** Mốc thời gian chuẩn µs UTC do DB trả (care__utc_us) — so sánh chuỗi = so sánh thời gian. */
export const CARE_US_TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/

export type CareOrderLinksSourceCode = 'PARAMS_MISMATCH' | 'ROWS_OVER_CAP' | 'CUSTOMER_ROWS_OVER_CAP' | 'ORDER_KEY_CONFLICT' | 'ORDER_OUT_OF_WINDOW'

/** Lỗi riêng của E (ngoài mã nguồn N3 dùng chung). Chỉ mã — không giá trị. */
export class CareOrderLinksSourceError extends Error {
  readonly code: CareOrderLinksSourceCode
  constructor(code: CareOrderLinksSourceCode) {
    super(`care_order_links_source:${code}`)
    this.name = 'CareOrderLinksSourceError'
    this.code = code
  }
}

export interface CareOrderLinksJob {
  runId: number
  jobNo: number
  tasks: number
  paramsSha256: string
  upperBound: string
  isClose: boolean
  perCustomerCap: number
  minLo: string
  customerIds: string[]
  fromTs: string[]
}

const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

/** jsonb của care_order_links_run_job ⇒ job; sai dạng ⇒ throw (fail-closed). */
export function parseRunJob(raw: unknown): CareOrderLinksJob {
  const r = raw as Record<string, unknown> | null
  const bad = () => new Error('care_order_links_job_malformed')
  if (!r || typeof r !== 'object') throw bad()
  const ids = r.customer_ids, ts = r.from_ts
  if (!isPosInt(r.run_id) || !isPosInt(r.job_no) || !isPosInt(r.tasks) || typeof r.params_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.params_sha256)
      || typeof r.upper_bound !== 'string' || !CARE_US_TS.test(r.upper_bound) || typeof r.is_close !== 'boolean'
      || !isPosInt(r.per_customer_cap) || typeof r.min_lo !== 'string' || !CARE_US_TS.test(r.min_lo)
      || !Array.isArray(ids) || !Array.isArray(ts) || ids.length !== r.tasks || ts.length !== r.tasks
      || !ids.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= 100)
      || !ts.every((x) => typeof x === 'string' && CARE_US_TS.test(x))) {
    throw bad()
  }
  return {
    runId: r.run_id, jobNo: r.job_no, tasks: r.tasks, paramsSha256: r.params_sha256, upperBound: r.upper_bound, isClose: r.is_close,
    perCustomerCap: r.per_customer_cap, minLo: r.min_lo, customerIds: ids as string[], fromTs: ts as string[],
  }
}

/** Băm tham số như DB care__order_links_params_sha: dòng = <độ dài byte UTF-8>:<id>|<lo µs UTC>, theo đúng thứ tự DB trả. */
export function orderLinksParamsSha(job: Pick<CareOrderLinksJob, 'upperBound' | 'isClose' | 'perCustomerCap' | 'customerIds' | 'fromTs'>): string {
  const lines = job.customerIds.map((id, i) => `${Buffer.byteLength(id, 'utf8')}:${id}|${job.fromTs[i]}`)
  const canonical = ['care-order-links/v1', job.upperBound, job.isClose ? '1' : '0', String(job.perCustomerCap), lines.join('\n')].join('\n')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/** SQL E0 §4.1 bước 4 — dùng chung CTE nguồn −7 giờ (Q-100) + phép chiếu ba cột với 114. */
export function buildOrderLinksSql(table: string): string {
  return `WITH cust AS (
  SELECT id, lo
  FROM UNNEST(@customer_ids) AS id WITH OFFSET i
  JOIN UNNEST(@from_ts) AS lo WITH OFFSET j ON i = j
),
${careN3SourceCte(table)}
SELECT ${CARE_N3_PROJECTION}
FROM src AS s
JOIN cust AS c ON c.id = s.entity_id
WHERE s.completed_utc > @min_lo
  AND s.completed_utc > c.lo
  AND s.completed_utc <= @upper_bound
  AND (NOT @is_close OR s.completed_utc < @upper_bound)
QUALIFY ROW_NUMBER() OVER (PARTITION BY s.entity_id ORDER BY s.completed_utc, s.order_code) <= @per_customer_cap + 1
ORDER BY s.entity_id, s.completed_utc, s.order_code`
}

export function orderLinksParams(job: CareOrderLinksJob): BqParam[] {
  return [
    { name: 'customer_ids', type: 'ARRAY', arrayType: 'STRING', values: job.customerIds },
    { name: 'from_ts', type: 'ARRAY', arrayType: 'TIMESTAMP', values: job.fromTs },
    { name: 'min_lo', type: 'TIMESTAMP', value: job.minLo },
    { name: 'upper_bound', type: 'TIMESTAMP', value: job.upperBound },
    { name: 'is_close', type: 'BOOL', value: job.isClose },
    { name: 'per_customer_cap', type: 'INT64', value: job.perCustomerCap },
  ]
}

export interface CareOrderLinksJobRead {
  jobNo: number
  orders: CareN3Order[]
  /** Số dòng BigQuery trả (trước khử trùng) — DB đối chiếu với Σ rows_received + duplicates_dropped. */
  bqTotalRows: number
  duplicatesDropped: number
  pages: number
  bytesProcessed: number | null
}

/**
 * Đọc MỘT job: kiểm băm tham số, đọc đủ trang (≤ maxRows), kiểm schema, trần đơn / khách, parse + khử trùng y hệt
 * (khác nhau ⇒ ORDER_KEY_CONFLICT), kiểm lại cửa sổ phía app (DB vẫn kiểm lần nữa trong apply_chunk).
 */
export async function readOrderLinksJob(table: string, job: CareOrderLinksJob, runQuery: CareN3RunQuery,
  opts: { maxRows: number; deadlineMs?: number }): Promise<CareOrderLinksJobRead> {
  if (orderLinksParamsSha(job) !== job.paramsSha256) throw new CareOrderLinksSourceError('PARAMS_MISMATCH')
  const sql = buildOrderLinksSql(table) // kiểm tên bảng trước IO
  let res
  try {
    res = await runQuery(sql, orderLinksParams(job), { maxRows: Math.max(0, opts.maxRows), pageSize: 10_000, deadlineMs: opts.deadlineMs })
  } catch (err) {
    if (err instanceof BigQueryError && err.kind === 'row_limit') throw new CareOrderLinksSourceError('ROWS_OVER_CAP')
    throw err instanceof CareN3SourceError ? err : new CareN3SourceError(careN3ErrorCode(err))
  }
  assertN3Fields(res.fields)
  const perCustomer = new Map<string, number>()
  for (const row of res.rows) {
    const id = row.customer_external_id ?? ''
    const k = (perCustomer.get(id) ?? 0) + 1
    if (k > job.perCustomerCap) throw new CareOrderLinksSourceError('CUSTOMER_ROWS_OVER_CAP')
    perCustomer.set(id, k)
  }
  const parsed = parseN3Rows(res.rows, Math.max(0, opts.maxRows))
  if (!parsed.ok) {
    if (parsed.errors.some((e) => e.code === 'ORDER_KEY_CONFLICT')) throw new CareOrderLinksSourceError('ORDER_KEY_CONFLICT')
    if (parsed.errors.some((e) => e.code === 'TOO_MANY_ROWS')) throw new CareOrderLinksSourceError('ROWS_OVER_CAP')
    throw new CareN3SourceError('parse_failed', [...new Set(parsed.errors.map((e) => e.code))])
  }
  const lo = new Map(job.customerIds.map((id, i) => [id, job.fromTs[i]]))
  for (const o of parsed.orders) {
    const l = lo.get(o.customer_external_id)
    if (l === undefined || !(o.ordered_at > l) || o.ordered_at > job.upperBound || (job.isClose && o.ordered_at >= job.upperBound)) {
      throw new CareOrderLinksSourceError('ORDER_OUT_OF_WINDOW')
    }
  }
  return { jobNo: job.jobNo, orders: parsed.orders, bqTotalRows: res.rows.length, duplicatesDropped: parsed.duplicatesDropped, pages: res.pages, bytesProcessed: res.totalBytesProcessed }
}

export interface CareOrderLinksChunk { customerIds: string[]; orders: CareN3Order[] }

/**
 * Chia khách của job thành chunk theo đúng thứ tự DB: ≤ chunkCustomers khách và ≤ chunkOrders đơn; đơn của một khách
 * không bị tách (một khách ≤ perCustomerCap ≤ chunkOrders đơn). Mọi khách (kể cả 0 đơn) đều vào đúng một chunk.
 */
export function planOrderLinksChunks(job: Pick<CareOrderLinksJob, 'customerIds'>, orders: readonly CareN3Order[],
  limits: { chunkCustomers: number; chunkOrders: number } = CARE_ORDER_LINKS_LIMITS): CareOrderLinksChunk[] {
  const byCustomer = new Map<string, CareN3Order[]>()
  for (const o of orders) {
    const list = byCustomer.get(o.customer_external_id)
    if (list) list.push(o); else byCustomer.set(o.customer_external_id, [o])
  }
  const out: CareOrderLinksChunk[] = []
  let cur: CareOrderLinksChunk = { customerIds: [], orders: [] }
  for (const id of job.customerIds) {
    const mine = byCustomer.get(id) ?? []
    if (mine.length > limits.chunkOrders) throw new CareOrderLinksSourceError('CUSTOMER_ROWS_OVER_CAP')
    if (cur.customerIds.length > 0 && (cur.customerIds.length + 1 > limits.chunkCustomers || cur.orders.length + mine.length > limits.chunkOrders)) {
      out.push(cur)
      cur = { customerIds: [], orders: [] }
    }
    cur.customerIds.push(id)
    cur.orders.push(...mine)
  }
  if (cur.customerIds.length > 0) out.push(cur)
  return out
}
