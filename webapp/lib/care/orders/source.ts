// CRM-CSKH B5b.1 + B5b.3 — adapter nguồn N3 (THUẦN, IO tiêm qua `runQuery`) theo SPEC §B5b/§B5b.3 + Q-96/Q-98/Q-100.
// Nguồn: VIEW BI (`CARE_BQ_ORDERS_TABLE`, Q-96) bốn cột entity_id/order_code/completed_at/type — SELECT
// đúng ba alias N3. Mỗi lượt terminal CHƯA Có đơn là một khoảng (lo, hi]: lo = lượt đó, hi = lượt terminal
// kế tiếp cùng khách (không có ⇒ mốc mở). Đơn bằng `lo` không tính (strict `<` của attribution), bằng
// `hi` vẫn thuộc lượt trước. Khoảng chỉ là bộ lọc lấy dữ liệu; DB `care_recompute_attribution` vẫn quyết
// định ghi công. Q-100 (quyết định mới, SPEC §B5b.3): VIEW giữ nguyên nhưng trả completed_at muộn hơn UTC
// thật 7 giờ ⇒ MỘT phép trừ cố định trong CTE `src` (CARE_N3_COMPLETED_UTC); chiếu ordered_at, lọc
// @min_care_at, khoảng (lo, hi], ORDER BY, mẫu QA và preflight đều chỉ dùng completed_utc — không chỗ nào so
// v.completed_at thô với mốc care UTC. Preflight chặn khi còn mốc (đã trừ) ở tương lai (> now + 5 phút).
//
// Tất cả-hoặc-không: đọc + kiểm TOÀN BỘ các lô trước khi trả; bất kỳ lô nào lỗi/quá trần/sai schema/
// parser lỗi ⇒ ném CareN3SourceError (mã an toàn, không giá trị) ⇒ caller không ghi gì.

import { BigQueryError, type BqParam, type BqQueryResult } from '../../bigquery/query'
import { isSafeBqTableName } from '../config'
import { CARE_N3_COLUMNS, CARE_N3_MAX_ROWS, normalizeN3Timestamp, parseN3Rows, type CareN3Error, type CareN3Order } from './n3'

/** Mốc "mở" khi lượt chưa có lượt terminal kế tiếp — TIMESTAMP lớn nhất của BigQuery (ARRAY không nhận NULL). */
export const CARE_N3_OPEN_HI = '9999-12-31T23:59:59.999999Z'
/**
 * Trần khoảng mỗi lượt sync — SPEC §B5b/Q-98: fail-closed `CANDIDATES_OVER_CAP` khi SỐ KHOẢNG > 20.000 (cùng
 * trần đơn của parser/RPC); số khách duy nhất báo riêng. TODO(Q-98): đổi nếu PM tách trần khách/khoảng.
 */
export const CARE_N3_MAX_WINDOWS = CARE_N3_MAX_ROWS
/** Số khoảng tối đa mỗi job BigQuery (kích thước tham số nhỏ, ≤ 2 job ở trần) — mặc định Dev. */
export const CARE_N3_WINDOWS_PER_QUERY = 10_000
/**
 * Preflight: mốc hoàn tất muộn hơn hiện tại quá ngưỡng này ⇒ nguồn sai thời gian ⇒ dừng sync. Chỉ là điều kiện
 * CẦN (lúc ít đơn, lệch múi giờ vẫn có thể cho 0) — gate cuối Q-100 là 2 DHC khớp UTC raw (SPEC §B5b.3).
 */
export const CARE_N3_FUTURE_TOLERANCE_MINUTES = 5
/**
 * Q-100 (SPEC §B5b.3): VIEW `tech__circa_completed_order` gắn nhãn UTC cho giờ VN ⇒ muộn hơn UTC thật 7 giờ
 * (2 DHC đối chiếu raw, lệch < 1 giây sau khi trừ). TRỪ, không cộng. Không env offset, không nhánh song song.
 * BI đổi cách biểu diễn completed_at ⇒ tắt CARE_SYNC_ENABLED và bỏ phép trừ này trước lượt sync kế tiếp.
 */
export const CARE_N3_VIEW_LAG_HOURS = 7
export const CARE_N3_COMPLETED_UTC = `TIMESTAMP_SUB(v.completed_at, INTERVAL ${CARE_N3_VIEW_LAG_HOURS} HOUR)`

export type CareN3SourceCode =
  | 'table_missing' | 'table_invalid' | 'windows_invalid' | 'windows_over_cap'
  | 'config' | 'access_denied' | 'not_found' | 'bad_query' | 'http' | 'timeout' | 'row_limit' | 'malformed'
  | 'schema_mismatch' | 'parse_failed' | 'source_time_future' | 'no_data' | 'unknown'

export class CareN3SourceError extends Error {
  readonly code: CareN3SourceCode
  /** Chỉ mã lỗi parser (không giá trị/vị trí) khi code = parse_failed. */
  readonly parseCodes?: string[]
  constructor(code: CareN3SourceCode, parseCodes?: string[]) {
    super(`care_n3_source:${code}`)
    this.name = 'CareN3SourceError'
    this.code = code
    this.parseCodes = parseCodes
  }
}

/** Ánh xạ lỗi bất kỳ ⇒ mã an toàn (KHÔNG mang message thô của BigQuery — có thể chứa SQL/tên bảng). */
export function careN3ErrorCode(err: unknown): CareN3SourceCode {
  if (err instanceof CareN3SourceError) return err.code
  if (err instanceof BigQueryError) {
    if (err.kind === 'http') {
      if (err.status === 403) return 'access_denied'
      if (err.status === 404) return 'not_found'
      if (err.status === 400) return 'bad_query'
      return 'http'
    }
    return err.kind
  }
  return 'unknown'
}

/** Một khoảng ứng viên do RPC care_order_sync_candidates trả (B5b.2). `hi` null ⇒ mở. */
export interface CareN3Window { customerExternalId: string; lo: string; hi: string | null }

const quoted = (table: string) => {
  if (!isSafeBqTableName(table)) throw new CareN3SourceError('table_invalid')
  return `\`${table}\``
}
/** Nguồn đã chuẩn hoá: định nghĩa completed_utc MỘT lần; mọi phần sau chỉ đọc src. */
const srcCte = (table: string) => `src AS (
  SELECT v.entity_id, v.order_code, ${CARE_N3_COMPLETED_UTC} AS completed_utc
  FROM ${quoted(table)} AS v
  WHERE v.type IN ('ONLINE', 'OFFLINE')
)`
const PROJECTION = `s.entity_id AS customer_external_id,
       s.order_code AS order_key,
       FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', s.completed_utc, 'UTC') AS ordered_at`

/** SQL production (SPEC §B5b): ba alias, khoảng (lo, hi] qua ba mảng named params cùng offset + EXISTS. */
export function buildN3OrdersSql(table: string): string {
  return `WITH windows AS (
  SELECT id, lo, hi
  FROM UNNEST(@customer_ids) AS id WITH OFFSET i
  JOIN UNNEST(@from_ts) AS lo WITH OFFSET j ON i = j
  JOIN UNNEST(@to_ts) AS hi WITH OFFSET k ON i = k
),
${srcCte(table)}
SELECT ${PROJECTION}
FROM src AS s
WHERE s.completed_utc > @min_care_at
  AND EXISTS (
    SELECT 1 FROM windows AS w
    WHERE w.id = s.entity_id
      AND s.completed_utc > w.lo
      AND s.completed_utc <= w.hi
  )
ORDER BY s.completed_utc, s.order_code`
}

/** Mẫu ≤ `limit` dòng, cùng phép chiếu (QA đọc VIEW thật — không dùng cho sync). */
export function buildN3SampleSql(table: string, limit = 5): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new CareN3SourceError('config')
  return `WITH ${srcCte(table)}
SELECT ${PROJECTION}
FROM src AS s
LIMIT ${limit}`
}

/** Preflight (Q-100): số đơn có mốc hoàn tất (ĐÃ chuẩn hoá) ở tương lai + tuổi đơn mới nhất (chỉ là metric). */
export function buildN3PreflightSql(table: string): string {
  return `WITH ${srcCte(table)}
SELECT
  COUNTIF(s.completed_utc > TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL ${CARE_N3_FUTURE_TOLERANCE_MINUTES} MINUTE)) AS future_count,
  TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(s.completed_utc), MINUTE) AS max_age_minutes
FROM src AS s`
}

export interface CareN3PreparedWindows {
  params: BqParam[]
  /** Khoảng thực sự gửi đi (lo < hi). */
  windows: number
  /** Khách duy nhất trong các khoảng gửi đi. */
  customers: number
  /** Khoảng rỗng bị bỏ (lo ≥ hi — hai lượt cùng mốc: lượt id nhỏ không thể chuyển đổi). */
  emptyWindows: number
}

function validId(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 100 && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v)
}

/** Kiểm + chuẩn hoá danh sách khoảng ⇒ named params (ba mảng song song + @min_care_at). */
export function prepareN3Windows(windows: readonly CareN3Window[]): CareN3PreparedWindows {
  if (windows.length > CARE_N3_MAX_WINDOWS) throw new CareN3SourceError('windows_over_cap')
  const ids: string[] = [], los: string[] = [], his: string[] = []
  let emptyWindows = 0
  for (const w of windows) {
    const lo = normalizeN3Timestamp(w?.lo)
    const hi = w?.hi === null ? CARE_N3_OPEN_HI : normalizeN3Timestamp(w?.hi)
    if (!validId(w?.customerExternalId) || lo === null || hi === null) throw new CareN3SourceError('windows_invalid')
    if (lo >= hi) { emptyWindows++; continue } // chuỗi ISO cùng định dạng ⇒ so sánh chuỗi = so sánh thời gian
    ids.push(w.customerExternalId); los.push(lo); his.push(hi)
  }
  const minCareAt = los.reduce<string | null>((m, x) => (m === null || x < m ? x : m), null)
  return {
    params: ids.length === 0 ? [] : [
      { name: 'customer_ids', type: 'ARRAY', arrayType: 'STRING', values: ids },
      { name: 'from_ts', type: 'ARRAY', arrayType: 'TIMESTAMP', values: los },
      { name: 'to_ts', type: 'ARRAY', arrayType: 'TIMESTAMP', values: his },
      { name: 'min_care_at', type: 'TIMESTAMP', value: minCareAt },
    ],
    windows: ids.length,
    customers: new Set(ids).size,
    emptyWindows,
  }
}

export function assertN3Fields(fields: readonly string[]): void {
  if (fields.length !== CARE_N3_COLUMNS.length || CARE_N3_COLUMNS.some((c, i) => fields[i] !== c)) {
    throw new CareN3SourceError('schema_mismatch')
  }
}

export type CareN3RunQuery = (
  sql: string, params: BqParam[], opts: { maxRows: number; pageSize?: number; deadlineMs?: number },
) => Promise<BqQueryResult>

export interface CareN3FetchStats {
  windows: number
  customers: number
  emptyWindows: number
  jobs: number
  pages: number
  rows: number
  bytesProcessed: number | null
  elapsedMs: number
}

export interface CareN3FetchResult { orders: CareN3Order[]; duplicatesDropped: number; stats: CareN3FetchStats }

/**
 * Đọc đơn cho mọi khoảng: chia lô ≤ CARE_N3_WINDOWS_PER_QUERY khoảng/job, đọc đủ trang, tổng dòng ≤ 20.000,
 * kiểm schema từng job, rồi parse TOÀN BỘ một lần. Không có khoảng ⇒ không gọi BigQuery.
 */
export async function collectN3Orders(
  table: string, windows: readonly CareN3Window[], runQuery: CareN3RunQuery,
  opts: { now?: () => number; perQuery?: number; deadlineMs?: number } = {},
): Promise<CareN3FetchResult> {
  const now = opts.now ?? (() => Date.now())
  const t0 = now()
  const sql = buildN3OrdersSql(table) // kiểm tên bảng trước mọi IO
  const all = prepareN3Windows(windows)
  const per = opts.perQuery ?? CARE_N3_WINDOWS_PER_QUERY
  const ids = (all.params[0]?.type === 'ARRAY' ? all.params[0].values : []) as string[]
  const los = (all.params[1]?.type === 'ARRAY' ? all.params[1].values : []) as string[]
  const his = (all.params[2]?.type === 'ARRAY' ? all.params[2].values : []) as string[]
  const stats: CareN3FetchStats = {
    windows: all.windows, customers: all.customers, emptyWindows: all.emptyWindows,
    jobs: 0, pages: 0, rows: 0, bytesProcessed: null, elapsedMs: 0,
  }
  const rows: unknown[] = []
  try {
    for (let s = 0; s < ids.length; s += per) {
      const lot = prepareN3Windows(ids.slice(s, s + per).map((id, k) => ({
        customerExternalId: id, lo: los[s + k], hi: his[s + k] === CARE_N3_OPEN_HI ? null : his[s + k],
      })))
      // Đã gom đúng trần vẫn PHẢI chạy các lô còn lại với maxRows = 0: lô rỗng ⇒ hợp lệ (tổng không vượt
      // trần); lô có ≥ 1 dòng ⇒ BigQuery báo row_limit (PM audit Lô 3 P2 — không từ chối nhầm 20.000 + 0).
      const left = CARE_N3_MAX_ROWS - rows.length
      const res = await runQuery(sql, lot.params, { maxRows: left, pageSize: 10_000, deadlineMs: opts.deadlineMs })
      assertN3Fields(res.fields)
      stats.jobs++
      stats.pages += res.pages
      if (res.totalBytesProcessed !== null) stats.bytesProcessed = (stats.bytesProcessed ?? 0) + res.totalBytesProcessed
      rows.push(...res.rows)
      if (rows.length > CARE_N3_MAX_ROWS) throw new CareN3SourceError('row_limit')
    }
  } catch (err) {
    throw err instanceof CareN3SourceError ? err : new CareN3SourceError(careN3ErrorCode(err))
  }
  const parsed = parseN3Rows(rows)
  if (!parsed.ok) throw new CareN3SourceError('parse_failed', [...new Set(parsed.errors.map((e: CareN3Error) => e.code))])
  stats.rows = rows.length
  stats.elapsedMs = now() - t0
  return { orders: parsed.orders, duplicatesDropped: parsed.duplicatesDropped, stats }
}

export interface CareN3Preflight { futureCount: number; maxAgeMinutes: number | null; bytesProcessed: number | null }

/** Chạy preflight; `futureCount > 0` ⇒ caller (cron) dừng với `source_time_future`. */
export async function runN3Preflight(table: string, runQuery: CareN3RunQuery): Promise<CareN3Preflight> {
  let res: BqQueryResult
  try {
    res = await runQuery(buildN3PreflightSql(table), [], { maxRows: 1 })
  } catch (err) {
    throw err instanceof CareN3SourceError ? err : new CareN3SourceError(careN3ErrorCode(err))
  }
  const r = res.rows[0]
  const future = Number(r?.future_count)
  const age = r?.max_age_minutes === null || r?.max_age_minutes === undefined ? null : Number(r.max_age_minutes)
  if (!Number.isSafeInteger(future) || future < 0 || (age !== null && !Number.isSafeInteger(age))) throw new CareN3SourceError('malformed')
  return { futureCount: future, maxAgeMinutes: age, bytesProcessed: res.totalBytesProcessed }
}

// E (đơn sau import, lib/care/orderLinks): dùng chung CTE nguồn đã chuẩn hoá −7 giờ (Q-100) + phép chiếu ba cột — một chỗ định nghĩa.
export { srcCte as careN3SourceCte, PROJECTION as CARE_N3_PROJECTION }
