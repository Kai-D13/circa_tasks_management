import { BigQueryError, type BqParam, type BqQueryResult, type BqRow } from '../lib/bigquery/query'
import { CARE_N3_COMPLETED_UTC, CARE_N3_VIEW_LAG_HOURS, type CareN3RunQuery } from '../lib/care/orders/source'

// BigQuery GIẢ trong bộ nhớ cho adapter N3 (B5b): hiểu 3 dạng SQL của lib/care/orders/source.ts (production
// theo khoảng / mẫu LIMIT / preflight) và áp ĐÚNG vị từ của chúng (type ONLINE/OFFLINE, @min_care_at, khoảng
// (lo, hi] ghép từ 3 mảng cùng offset) lên dữ liệu VIEW giả — để test kiểm luôn cách ghép tham số. Độ chính xác
// thời gian của mock = mili giây (Date.parse). Không dữ liệu khách thật.
//
// Q-100 (SPEC §B5b.3): VIEW thật trả completed_at MUỘN hơn UTC thật 7 giờ. Mock mô phỏng đúng điều đó: dòng giả
// ghi `completed_at` theo UTC THẬT (mặc định) và VIEW giả lưu +7 giờ; chỉ khi SQL có đúng biểu thức chuẩn hoá
// CARE_N3_COMPLETED_UTC thì mock mới trừ lại ⇒ adapter quên trừ (hoặc trừ sai chiều) làm kết quả lệch 7 giờ.
// `rawView: true` ⇒ `completed_at` của dòng giả đã là giá trị VIEW thô (dùng cho mẫu DHC đối chiếu raw).

export interface ViewRow { entity_id: string | null; order_code: string | null; completed_at: string | null; type: string }

const LAG_MS = CARE_N3_VIEW_LAG_HOURS * 3_600_000
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z') // ms ⇒ micro giây

export interface FakeBqOptions {
  /** Lần gọi thứ N (1-based) ném lỗi. */
  failOnCall?: number
  failWith?: Error
  /** Thêm cột `type` vào kết quả ⇒ schema lệch. */
  extraField?: boolean
  pageSize?: number
  /** Đồng hồ của BigQuery giả (preflight). */
  now?: string
  /** `completed_at` của dòng giả là giá trị VIEW thô (đã lệch +7 giờ), không phải UTC thật. */
  rawView?: boolean
}

export function fakeBq(view: ViewRow[], opts: FakeBqOptions = {}) {
  const calls: { sql: string; params: BqParam[]; maxRows: number }[] = []
  const run: CareN3RunQuery = async (sql, params, o) => {
    calls.push({ sql, params, maxRows: o.maxRows })
    if (opts.failOnCall === calls.length) throw opts.failWith ?? new BigQueryError('http', 'Access Denied: Table x.y.z: raw message', 403)
    // Giá trị VIEW (+7 giờ so với UTC thật) rồi trừ lại CHỈ khi SQL chuẩn hoá đúng như adapter phải làm.
    const shift = sql.includes(CARE_N3_COMPLETED_UTC) ? LAG_MS : 0
    const utcMs = (v: ViewRow) => (v.completed_at ? Date.parse(v.completed_at) + (opts.rawView ? 0 : LAG_MS) - shift : NaN)
    let rows: BqRow[]
    if (sql.includes('future_count')) {
      const now = Date.parse(opts.now ?? '2026-10-09T12:00:00Z')
      const ts = view.filter((v) => v.completed_at && ['ONLINE', 'OFFLINE'].includes(v.type)).map(utcMs)
      rows = [{ future_count: String(ts.filter((t) => t > now + 5 * 60_000).length), max_age_minutes: ts.length ? String(Math.floor((now - Math.max(...ts)) / 60_000)) : null }]
    } else {
      const arr = (n: string) => (params.find((p) => p.name === n) as Extract<BqParam, { type: 'ARRAY' }> | undefined)?.values as string[] | undefined
      const ids = arr('customer_ids'), los = arr('from_ts'), his = arr('to_ts')
      const min = (params.find((p) => p.name === 'min_care_at') as { value: string } | undefined)?.value
      const picked = view.filter((v) => ['ONLINE', 'OFFLINE'].includes(v.type)).filter((v) => {
        if (!ids) return true // mẫu
        const t = utcMs(v)
        if (!(t > Date.parse(min!))) return false
        return ids.some((id, i) => id === v.entity_id && t > Date.parse(los![i]) && t <= Date.parse(his![i]))
      })
      const limit = /LIMIT (\d+)/.exec(sql)
      rows = (limit ? picked.slice(0, Number(limit[1])) : picked)
        .sort((a, b) => (utcMs(a) || 0) - (utcMs(b) || 0) || (a.order_code ?? '').localeCompare(b.order_code ?? ''))
        .map((v) => ({ customer_external_id: v.entity_id, order_key: v.order_code, ordered_at: v.completed_at ? iso(utcMs(v)) : null, ...(opts.extraField ? { type: v.type } : {}) }))
      if (rows.length > o.maxRows) throw new BigQueryError('row_limit', `kết quả ${rows.length} dòng vượt trần ${o.maxRows}`)
    }
    const fields = Object.keys(rows[0] ?? (sql.includes('future_count') ? { future_count: 0, max_age_minutes: 0 } : { customer_external_id: 0, order_key: 0, ordered_at: 0 }))
    const pageSize = opts.pageSize ?? 10_000
    return { rows, fields, totalRows: rows.length, jobId: `job${calls.length}`, pages: Math.max(1, Math.ceil(rows.length / pageSize)), totalBytesProcessed: 2_000_000 } satisfies BqQueryResult
  }
  return { run, calls }
}
