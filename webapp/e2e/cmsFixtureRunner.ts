// CMS — runner FIXTURE (SPEC §1, §9): CHỈ cho test (nằm trong e2e/, không bao giờ vào bundle app) với dữ liệu
// GIẢ. Mô phỏng đúng ngữ nghĩa SQL của adapter (lọc kỳ + ProductID, trả mọi
// giá trị dạng chuỗi) để kiểm adapter end-to-end không cần BigQuery.
// KHÔNG BAO GIỜ là fallback production: NODE_ENV=production ⇒ throw.

import { BigQueryError, type BqQueryResult } from '../lib/bigquery/query'
import type { CmsBqRunner } from '../lib/cms/source/bigquery'
import { CMS_PRODUCT_COLUMNS, CMS_SALES_COLUMNS, type CmsRawRow } from '../lib/cms/source/contract'
import { parseUtcMicros } from '../lib/cms/time'

export interface CmsFixtureSource {
  products?: CmsRawRow[]
  sales?: CmsRawRow[]
  /** Giả lập view thiếu cột (kiểm SCHEMA_MISMATCH). */
  dropFields?: string[]
  /** Giả lập totalRows nguồn báo khác số dòng trả (kiểm INCOMPLETE_PAGES). */
  totalRowsDelta?: number
  /** Giả lập lỗi nguồn. */
  fail?: Error
}

function assertNotProduction(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CMS: fixture runner bị cấm ở production (không fallback JSON)')
  }
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

export function createCmsFixtureRunner(src: CmsFixtureSource): CmsBqRunner {
  assertNotProduction()
  return async (_sql, params, opts) => {
    assertNotProduction()
    if (src.fail) throw src.fail
    const p = new Map(params.map((x) => [x.name, x]))
    const isSales = p.has('product_ids')
    let rows: CmsRawRow[]
    if (isSales) {
      const fromP = p.get('from_ts'), toP = p.get('to_ts'), idsP = p.get('product_ids'), limP = p.get('row_limit')
      const from = parseUtcMicros(String(fromP && 'value' in fromP ? fromP.value : ''))
      const to = parseUtcMicros(String(toP && 'value' in toP ? toP.value : ''))
      const ids = new Set((idsP && 'values' in idsP ? idsP.values : []).map(String))
      const limit = Number(limP && 'value' in limP ? limP.value : Infinity)
      rows = (src.sales ?? []).filter((r) => {
        const at = parseUtcMicros(String(r.completed_at ?? ''))
        // completed_at NULL / sai ⇒ không khớp WHERE (giống SQL so sánh với NULL).
        return at !== null && from !== null && to !== null && at >= from && at < to && ids.has(String(r.product_id ?? '').trim())
      }).slice(0, limit)
    } else {
      rows = src.products ?? []
    }
    const fields = (isSales ? CMS_SALES_COLUMNS : CMS_PRODUCT_COLUMNS).filter((c) => !(src.dropFields ?? []).includes(c))
    const out = rows.map((r) => Object.fromEntries(fields.map((f) => [f, str(r[f])]))) as Record<string, string | null>[]
    if (out.length > opts.maxRows) {
      throw new BigQueryError('row_limit', `fixture: ${out.length} > ${opts.maxRows}`)
    }
    const result: BqQueryResult = {
      rows: out, fields: [...fields], totalRows: out.length + (src.totalRowsDelta ?? 0),
      jobId: 'fixture', pages: 1, totalBytesProcessed: null,
    }
    return result
  }
}

/** Cột VẬT LÝ của hai view BI (PM 04/11 — work order tích hợp nguồn §2.2): dòng đơn dùng `employee_email`, app SELECT AS seller_email. */
export const CMS_FX_VIEW_SALES_COLUMNS = ['order_line_id', 'order_id', 'order_code', 'product_id', 'employee_email', 'pos_code', 'order_type',
  'order_status', 'completed_at', 'quantity_raw', 'uom_raw', 'base_quantity', 'gmv_amount', 'source_updated_at'] as const
/** Product Master: 6 cột vật lý — view KHÔNG có `is_active` (operator bỏ 04/11; adapter tạo hằng `CAST(TRUE AS STRING) AS is_active`). */
export const CMS_FX_VIEW_PRODUCT_COLUMNS = CMS_PRODUCT_COLUMNS.filter((c) => c !== 'is_active')

/**
 * Runner giả lập VIEW BigQuery theo SCHEMA VẬT LÝ (chỉ test): giải nghĩa danh sách SELECT của adapter (`CAST(<cột> AS STRING) AS <alias>`,
 * `CAST(TRUE|FALSE AS STRING) AS <alias>` (hằng — BigQuery trả 'true' / 'false', không đọc cột nào), `FORMAT_TIMESTAMP(…, <cột>, 'UTC') AS <alias>`)
 * và các cột ở WHERE — cột không có trên view ⇒ lỗi như BigQuery ("Unrecognized name", HTTP 400). Dòng vào mang TÊN VẬT LÝ; dòng ra mang
 * alias (tên chuẩn của app); giá trị nguồn trùng tên alias của hằng bị bỏ qua (như SELECT hằng). Lọc kỳ + ProductID như SQL; ép chuỗi như CAST.
 */
export function createCmsViewRunner(rows: CmsRawRow[], physical: readonly string[], calls: string[] = []): CmsBqRunner {
  assertNotProduction()
  return async (sql, params, opts) => {
    assertNotProduction()
    calls.push(sql)
    const lines = sql.split('\n')
    const exprs = lines[0].replace(/^SELECT /, '').split(/, (?=CAST\(|FORMAT_TIMESTAMP\()/)
    const cols = exprs.map((e) => {
      const m = /^(?:CAST\((\w+) AS STRING\)|FORMAT_TIMESTAMP\('[^']+', (\w+), 'UTC'\)) AS (\w+)$/.exec(e)
      if (!m) throw new Error(`fixture: biểu thức SELECT lạ: ${e}`)
      const src = m[1] ?? m[2]
      // Hằng BOOL viết HOA (TRUE / FALSE) — tên cột của adapter luôn chữ thường.
      return src === 'TRUE' || src === 'FALSE' ? { src: null, constant: src.toLowerCase(), alias: m[3] } : { src, constant: null, alias: m[3] }
    })
    const whereCols = lines.slice(2).join(' ').match(/\b[a-z_]+(?=\)\) IN UNNEST|\s+AS STRING\) IN UNNEST|\s*>=|\s*<\s)/g) ?? []
    for (const c of [...cols.flatMap((x) => (x.src === null ? [] : [x.src])), ...whereCols]) {
      if (!physical.includes(c)) throw new BigQueryError('http', `BigQuery HTTP 400: Unrecognized name: ${c} at [1:8]`, 400)
    }
    const p = new Map(params.map((x) => [x.name, x]))
    let src = rows
    if (p.has('product_ids')) {
      const fromP = p.get('from_ts'), toP = p.get('to_ts'), idsP = p.get('product_ids')
      const from = parseUtcMicros(String(fromP && 'value' in fromP ? fromP.value : ''))
      const to = parseUtcMicros(String(toP && 'value' in toP ? toP.value : ''))
      const ids = new Set((idsP && 'values' in idsP ? idsP.values : []).map(String))
      src = rows.filter((r) => {
        const at = parseUtcMicros(String(r.completed_at ?? ''))
        return at !== null && from !== null && to !== null && at >= from && at < to && ids.has(String(r.product_id ?? ''))
      })
    }
    const out = src.map((r) => Object.fromEntries(cols.map((c) => [c.alias, c.src === null ? c.constant : str(r[c.src])]))) as Record<string, string | null>[]
    if (out.length > opts.maxRows) throw new BigQueryError('row_limit', `fixture: ${out.length} > ${opts.maxRows}`)
    const result: BqQueryResult = { rows: out, fields: cols.map((c) => c.alias), totalRows: out.length, jobId: 'fixture-view', pages: 1, totalBytesProcessed: null }
    return result
  }
}
