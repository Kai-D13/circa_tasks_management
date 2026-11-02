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
