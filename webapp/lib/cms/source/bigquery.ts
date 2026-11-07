// CMS — adapter BigQuery cho 2 nguồn logic (SPEC §1, §6). Thuần: nhận một
// runner tiêm vào (thật: lib/cms/source/bigqueryRunner.ts → runBigQueryPaged;
// test: e2e/cmsFixtureRunner.ts / transport giả). Nguyên tắc:
//  · Tên view chỉ từ env đã validate (lib/cms/config.ts); mọi giá trị khác đi
//    bằng query parameter, không nội suy.
//  · Ép kiểu ở SQL: NUMERIC/ID → STRING, TIMESTAMP → ISO UTC 6 chữ số micro giây.
//  · Dòng đơn: lọc kỳ + ProductID ở SQL; KHÔNG lọc order_type/status ở SQL để
//    app phát hiện thiếu trường (adapter production từ chối, không tự điền).
//  · Đọc đủ trang; vượt trần ⇒ OVER_CAP (không lấy một phần); thiếu cột ⇒
//    SCHEMA_MISMATCH; lỗi nguồn ⇒ SOURCE_ERROR. Không fallback JSON/Sheet.
//  · Tên cột VẬT LÝ của view BI có thể khác tên chuẩn (CMS_SALES_SOURCE_COLUMN — operator chốt 04/11 BI giữ
//    `employee_email`): đổi tên DUY NHẤT ở SELECT `CAST(employee_email AS STRING) AS seller_email`; runner / normalizer / DB /
//    engine / file đối soát vẫn dùng tên chuẩn. View thiếu cột vật lý ⇒ BigQuery lỗi truy vấn ⇒ SOURCE_ERROR (giữ snapshot cũ),
//    KHÔNG tự thử cột khác.
//  · Product Master: `is_active` là hằng tương thích nội bộ `CAST(TRUE AS STRING) AS is_active` (CMS_PRODUCT_DERIVED_COLUMN —
//    operator bỏ trạng thái SP 04/11); view chỉ cần 6 cột vật lý. Trùng product_id vẫn held DUPLICATE_PRODUCT (productSync) —
//    KHÔNG chọn MAX / MIN / dòng đầu để vượt lỗi.
//  · Lỗi trả về CHỈ là mã cố định + số đếm / HTTP status — KHÔNG mang message
//    thô của BigQuery/Google (có thể chứa giá trị dòng nguồn, email, URL, tên
//    view nội bộ) để không rò ra log / UI / DB (security review P0-a P1-1).

import { BigQueryError, type BqParam, type BqQueryResult } from '../../bigquery/query'
import { isSafeBqTableName } from '../../care/config'
import { CMS_SALES_ROW_CAP } from '../quality'
import { formatUtcMicros } from '../time'
import {
  CMS_PRODUCT_COLUMNS, CMS_SALES_COLUMNS, normalizeProductRow, normalizeSalesRow,
  type CmsProductMasterRow, type CmsRowIssue, type CmsSalesLine,
} from './contract'

/** Cột vật lý trên view dòng đơn khi khác tên chuẩn của app (PM 04/11 — work order tích hợp nguồn BI §2.1). */
export const CMS_SALES_SOURCE_COLUMN: Readonly<Partial<Record<(typeof CMS_SALES_COLUMNS)[number], string>>> = { seller_email: 'employee_email' }
/** Tên cột vật lý (dùng khi lọc ngay trên view — vd. SQL xuất đối soát N4b). */
export const cmsSalesSourceColumn = (c: (typeof CMS_SALES_COLUMNS)[number]): string => CMS_SALES_SOURCE_COLUMN[c] ?? c

/**
 * Cột chuẩn Product Master do adapter TẠO bằng hằng — KHÔNG đọc trên view (PM 04/11 `2026-11-04-cms-bi-product-master-pm.md` §2,
 * quyết định operator bỏ trạng thái SP). `is_active` = 'true' nghĩa là "CMS không áp dụng kiểm tra trạng thái kinh doanh", KHÔNG phải
 * bằng chứng SP đang bán ở nguồn; không hiển thị "đang kinh doanh" dựa vào hằng này. Output chuẩn / normalizer / RPC vẫn 7 cột.
 */
export const CMS_PRODUCT_DERIVED_COLUMN: Readonly<Partial<Record<(typeof CMS_PRODUCT_COLUMNS)[number], string>>> = { is_active: 'CAST(TRUE AS STRING)' }
/** Cột VẬT LÝ view Product Master phải có (6) — thiếu cột nào trong số này ⇒ BigQuery lỗi ⇒ SOURCE_ERROR, không tạo output giả. */
export const CMS_PRODUCT_SOURCE_COLUMNS: readonly string[] = CMS_PRODUCT_COLUMNS.filter((c) => !CMS_PRODUCT_DERIVED_COLUMN[c])

/** Trần dòng Product Master / lượt (đọc đầy đủ; vượt ⇒ OVER_CAP — đo quy mô thật ở P0, SPEC §1.1). */
export const CMS_PRODUCTS_ROW_CAP = 200_000
/** Hạn tổng mặc định cho một truy vấn (poll + mọi trang). */
export const CMS_BQ_DEFAULT_DEADLINE_MS = 120_000

export type CmsBqRunner = (
  sql: string,
  params: BqParam[],
  opts: { maxRows: number; deadlineMs?: number },
) => Promise<BqQueryResult>

export type CmsSourceFailure =
  | { ok: false; reason: 'CONFIG' }
  | { ok: false; reason: 'SCHEMA_MISMATCH'; missing: string[] }
  | { ok: false; reason: 'OVER_CAP'; cap: number }
  | { ok: false; reason: 'INCOMPLETE_PAGES'; read: number | null; total: number | null }
  | { ok: false; reason: 'SOURCE_ERROR'; kind: string; status: number | null }

export interface CmsRowIssueAt {
  /** Thứ tự dòng trong kết quả nguồn (0-based) — không mang dữ liệu dòng. */
  index: number
  issues: CmsRowIssue[]
}

const TS = (col: string) => `FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', ${col}, 'UTC') AS ${col}`
const STR = (col: string) => `CAST(${col} AS STRING) AS ${col}`

function assertTable(table: string): void {
  // Không đưa tên view vào message (hạ tầng nội bộ).
  if (!isSafeBqTableName(table)) throw new BigQueryError('config', 'CMS: tên view nguồn không hợp lệ')
}

function rowLimitParam(cap: number): BqParam {
  // cap + 1 để PHÁT HIỆN vượt trần thay vì lặng lẽ cắt.
  return { name: 'row_limit', type: 'INT64', value: cap + 1 }
}

export function buildCmsProductsQuery(table: string, cap: number = CMS_PRODUCTS_ROW_CAP): { sql: string; params: BqParam[]; cap: number } {
  assertTable(table)
  const cols = CMS_PRODUCT_COLUMNS.map((c) => (CMS_PRODUCT_DERIVED_COLUMN[c] ? `${CMS_PRODUCT_DERIVED_COLUMN[c]} AS ${c}`
    : c === 'source_updated_at' ? TS(c) : STR(c)))
  return { sql: `SELECT ${cols.join(', ')}\nFROM \`${table}\`\nLIMIT @row_limit`, params: [rowLimitParam(cap)], cap }
}

export interface CmsSalesQueryArgs {
  table: string
  /** Cửa sổ kỳ (micro giây UTC) từ vnProgramWindowMicros. */
  fromMicros: bigint
  toMicrosExclusive: bigint
  /** ProductID canonical của chương trình (≥ 1). */
  productIds: readonly string[]
  cap?: number
  deadlineMs?: number
}

export function buildCmsSalesQuery(a: CmsSalesQueryArgs): { sql: string; params: BqParam[]; cap: number } {
  assertTable(a.table)
  if (a.productIds.length === 0) throw new BigQueryError('config', 'CMS: chương trình chưa có ProductID')
  if (a.toMicrosExclusive <= a.fromMicros) throw new BigQueryError('config', 'CMS: cửa sổ kỳ rỗng')
  const cap = a.cap ?? CMS_SALES_ROW_CAP
  const cols = CMS_SALES_COLUMNS.map((c) => (c === 'completed_at' || c === 'source_updated_at' ? TS(c)
    : CMS_SALES_SOURCE_COLUMN[c] ? `CAST(${CMS_SALES_SOURCE_COLUMN[c]} AS STRING) AS ${c}` : STR(c)))
  const sql = [
    `SELECT ${cols.join(', ')}`,
    `FROM \`${a.table}\``,
    'WHERE completed_at >= @from_ts AND completed_at < @to_ts',
    '  AND CAST(product_id AS STRING) IN UNNEST(@product_ids)',
    'LIMIT @row_limit',
  ].join('\n')
  const params: BqParam[] = [
    { name: 'from_ts', type: 'TIMESTAMP', value: formatUtcMicros(a.fromMicros) },
    { name: 'to_ts', type: 'TIMESTAMP', value: formatUtcMicros(a.toMicrosExclusive) },
    { name: 'product_ids', type: 'ARRAY', arrayType: 'STRING', values: [...new Set(a.productIds)].sort() },
    rowLimitParam(cap),
  ]
  return { sql, params, cap }
}

function missingColumns(fields: readonly string[], expected: readonly string[]): string[] {
  const have = new Set(fields)
  return expected.filter((c) => !have.has(c))
}

async function runSafely(
  run: CmsBqRunner, sql: string, params: BqParam[], cap: number, deadlineMs: number,
): Promise<{ ok: true; result: BqQueryResult } | CmsSourceFailure> {
  try {
    return { ok: true, result: await run(sql, params, { maxRows: cap + 1, deadlineMs }) }
  } catch (e) {
    if (e instanceof BigQueryError) {
      if (e.kind === 'row_limit') return { ok: false, reason: 'OVER_CAP', cap }
      if (e.kind === 'malformed') return { ok: false, reason: 'INCOMPLETE_PAGES', read: null, total: null }
      if (e.kind === 'config') return { ok: false, reason: 'CONFIG' }
      return { ok: false, reason: 'SOURCE_ERROR', kind: e.kind, status: typeof e.status === 'number' ? e.status : null }
    }
    return { ok: false, reason: 'SOURCE_ERROR', kind: 'unknown', status: null }
  }
}

/** Kiểm cấu trúc kết quả chung cho 2 nguồn; null = hợp lệ. */
function checkResult(result: BqQueryResult, expected: readonly string[], cap: number): CmsSourceFailure | null {
  const missing = missingColumns(result.fields, expected)
  if (missing.length) return { ok: false, reason: 'SCHEMA_MISMATCH', missing }
  if (result.rows.length > cap || result.totalRows > cap) return { ok: false, reason: 'OVER_CAP', cap }
  if (result.rows.length !== result.totalRows) {
    return { ok: false, reason: 'INCOMPLETE_PAGES', read: result.rows.length, total: result.totalRows }
  }
  return null
}

export interface CmsProductsFetch {
  ok: true
  rows: CmsProductMasterRow[]
  rowIssues: CmsRowIssueAt[]
  rowsRead: number
  totalRowsReported: number
  bytesProcessed: number | null
}

/** Product Master đầy đủ (SPEC §1.1: bản đầu pull đầy đủ, đọc đủ trang). */
export async function fetchCmsProducts(
  run: CmsBqRunner, table: string, opts: { cap?: number; deadlineMs?: number } = {},
): Promise<CmsProductsFetch | CmsSourceFailure> {
  let q: ReturnType<typeof buildCmsProductsQuery>
  try { q = buildCmsProductsQuery(table, opts.cap) } catch { return { ok: false, reason: 'CONFIG' } }
  const r = await runSafely(run, q.sql, q.params, q.cap, opts.deadlineMs ?? CMS_BQ_DEFAULT_DEADLINE_MS)
  if (!r.ok) return r
  const bad = checkResult(r.result, CMS_PRODUCT_COLUMNS, q.cap)
  if (bad) return bad
  const rows: CmsProductMasterRow[] = []
  const rowIssues: CmsRowIssueAt[] = []
  r.result.rows.forEach((raw, index) => {
    const n = normalizeProductRow(raw)
    if (n.ok) rows.push(n.value)
    else rowIssues.push({ index, issues: n.issues })
  })
  return {
    ok: true, rows, rowIssues,
    rowsRead: r.result.rows.length, totalRowsReported: r.result.totalRows, bytesProcessed: r.result.totalBytesProcessed,
  }
}

export interface CmsSalesFetch {
  ok: true
  lines: CmsSalesLine[]
  rowIssues: CmsRowIssueAt[]
  rowsRead: number
  totalRowsReported: number
  bytesProcessed: number | null
}

/** Toàn kỳ của MỘT chương trình (SPEC §6: đọc lại toàn kỳ, không watermark). */
export async function fetchCmsSalesSnapshot(
  run: CmsBqRunner, args: CmsSalesQueryArgs,
): Promise<CmsSalesFetch | CmsSourceFailure> {
  let q: ReturnType<typeof buildCmsSalesQuery>
  try { q = buildCmsSalesQuery(args) } catch { return { ok: false, reason: 'CONFIG' } }
  const r = await runSafely(run, q.sql, q.params, q.cap, args.deadlineMs ?? CMS_BQ_DEFAULT_DEADLINE_MS)
  if (!r.ok) return r
  const bad = checkResult(r.result, CMS_SALES_COLUMNS, q.cap)
  if (bad) return bad
  const lines: CmsSalesLine[] = []
  const rowIssues: CmsRowIssueAt[] = []
  r.result.rows.forEach((raw, index) => {
    const n = normalizeSalesRow(raw)
    if (n.ok) lines.push(n.value)
    else rowIssues.push({ index, issues: n.issues })
  })
  return {
    ok: true, lines, rowIssues,
    rowsRead: r.result.rows.length, totalRowsReported: r.result.totalRows, bytesProcessed: r.result.totalBytesProcessed,
  }
}
