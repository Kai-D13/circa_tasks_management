// CRM-CSKH B5a r1.1 — hợp đồng BA cột N3 r3.4 (SPEC §B5a r1.1, Q-91/Q-93) + parser/validator THUẦN.
// Không import Next/Supabase/BigQuery ⇒ test trực tiếp bằng fixture. Adapter nguồn thật (query, cron)
// là B5b — CHƯA GO; parser này không suy đoán tên cột nguồn (entity_id, completed_at, code…): adapter
// B5b phải trả ĐÚNG ba cột dưới đây. BI chỉ xuất đơn POS/online status='COMPLETED' (app không có cột
// status) ⇒ mỗi dòng hợp lệ = một đơn hoàn tất. GĐ1 chỉ đo task "Có đơn": KHÔNG tiền/số đơn/pos_code/
// source_updated_at.
//
// Hợp đồng giá trị (BqRow trả mọi ô dạng chuỗi):
//   · customer_external_id: chuỗi 1–100 ký tự, không khoảng trắng đầu/cuối (khớp CHÍNH XÁC ID N1 —
//     care_customers.external_id = btrim; Q-92 ID N1 = N3). Không nối bằng SĐT.
//   · order_key: chuỗi 1–200 ký tự, không khoảng trắng đầu/cuối, duy nhất POS + online (ứng viên
//     order_order.code — Q-92; KHÔNG hardcode tên cột raw ở app).
//   · ordered_at: = completed_at UTC (Q-93), ISO-8601 CÓ múi giờ (Z hoặc ±hh:mm), tối đa 6 chữ số thập
//     phân giây. Adapter B5b nên FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', col, 'UTC') — dạng giây số
//     thực mặc định của BigQuery REST bị từ chối (không đoán đơn vị). NULL ⇒ lỗi (không ghi đơn thiếu mốc).
// Trùng order_key: payload giống hệt ⇒ bỏ bản trùng; khác nhau ⇒ lỗi CẢ batch (không chọn bừa).

export const CARE_N3_COLUMNS = ['customer_external_id', 'order_key', 'ordered_at'] as const
export type CareN3Column = (typeof CARE_N3_COLUMNS)[number]

/** Một đơn COMPLETED đã chuẩn hoá — đúng cột nghiệp vụ của bảng care_orders (114). */
export interface CareN3Order {
  order_key: string
  customer_external_id: string
  /** completed_at — ISO UTC chuẩn hoá `YYYY-MM-DDTHH:MM:SS.ffffffZ` (giữ micro giây). */
  ordered_at: string
}

export type CareN3ErrorCode =
  | 'TOO_MANY_ROWS' | 'ROW_NOT_OBJECT' | 'COLUMNS_MISMATCH'
  | 'CUSTOMER_ID_INVALID' | 'ORDER_KEY_INVALID' | 'ORDERED_AT_INVALID' | 'ORDER_KEY_CONFLICT'

/** `row` = vị trí 0-based trong lô; không chứa giá trị (không đưa PII/mã đơn vào log). */
export interface CareN3Error { row: number; code: CareN3ErrorCode }

export type CareN3ParseResult =
  | { ok: true; orders: CareN3Order[]; duplicatesDropped: number }
  | { ok: false; errors: CareN3Error[] }

/** Trần một lô — khớp giới hạn care_recompute_attribution (20.000 đơn). */
export const CARE_N3_MAX_ROWS = 20_000

const ISO_TS_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})$/

const pad = (n: number, w: number) => String(n).padStart(w, '0')

/** ISO-8601 có múi giờ ⇒ ISO UTC micro giây; sai/thiếu múi giờ/ngày không tồn tại ⇒ null. */
export function normalizeN3Timestamp(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = ISO_TS_RE.exec(v)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number)
  // Năm ngoài 1970–2100 ⇒ dữ liệu hỏng (Date.UTC còn tự đổi năm 0–99 thành 1900–1999).
  if (y < 1970 || y > 2100) return null
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null           // 30/02, 31/04… ⇒ không tồn tại
  let offsetMin = 0
  if (m[8] !== 'Z') {
    const om = /^([+-])(\d{2}):?(\d{2})$/.exec(m[8])!
    const oh = Number(om[2]), ommin = Number(om[3])
    if (oh > 14 || ommin > 59) return null
    offsetMin = (om[1] === '+' ? 1 : -1) * (oh * 60 + ommin)
  }
  // Lệch múi giờ là bội số nguyên phút ⇒ chỉ dịch phần giây nguyên; phần lẻ (micro giây) giữ nguyên.
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s) - offsetMin * 60_000)
  if (!Number.isFinite(dt.getTime())) return null
  const frac = (m[7] ?? '').padEnd(6, '0')
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1, 2)}-${pad(dt.getUTCDate(), 2)}T`
    + `${pad(dt.getUTCHours(), 2)}:${pad(dt.getUTCMinutes(), 2)}:${pad(dt.getUTCSeconds(), 2)}.${frac}Z`
}

function textId(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length < 1 || v.length > max || v !== v.trim()) return null
  return /[\u0000-\u001f\u007f]/.test(v) ? null : v
}

const sameOrder = (a: CareN3Order, b: CareN3Order) =>
  a.customer_external_id === b.customer_external_id && a.ordered_at === b.ordered_at

/**
 * Kiểm + chuẩn hoá một lô dòng N3. Lỗi ở BẤT KỲ dòng nào ⇒ `ok:false` cho cả lô (caller không ghi gì,
 * giữ snapshot cũ — AGENTS.md §4.7). Lỗi chỉ mang vị trí + mã, không mang giá trị.
 */
export function parseN3Rows(rows: readonly unknown[], maxRows = CARE_N3_MAX_ROWS): CareN3ParseResult {
  if (rows.length > maxRows) return { ok: false, errors: [{ row: maxRows, code: 'TOO_MANY_ROWS' }] }
  const errors: CareN3Error[] = []
  const byKey = new Map<string, { order: CareN3Order; row: number }>()
  const orders: CareN3Order[] = []
  let duplicatesDropped = 0
  const conflicted = new Set<string>()
  rows.forEach((raw, row) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { errors.push({ row, code: 'ROW_NOT_OBJECT' }); return }
    const r = raw as Record<string, unknown>
    const keys = Object.keys(r)
    if (keys.length !== CARE_N3_COLUMNS.length || !CARE_N3_COLUMNS.every((c) => Object.prototype.hasOwnProperty.call(r, c))) {
      errors.push({ row, code: 'COLUMNS_MISMATCH' }); return
    }
    const customer = textId(r.customer_external_id, 100)
    const key = textId(r.order_key, 200)
    const orderedAt = normalizeN3Timestamp(r.ordered_at)
    const before = errors.length
    if (customer === null) errors.push({ row, code: 'CUSTOMER_ID_INVALID' })
    if (key === null) errors.push({ row, code: 'ORDER_KEY_INVALID' })
    if (orderedAt === null) errors.push({ row, code: 'ORDERED_AT_INVALID' })
    if (errors.length > before) return
    const order: CareN3Order = { order_key: key!, customer_external_id: customer!, ordered_at: orderedAt! }
    const prev = byKey.get(order.order_key)
    if (!prev) { byKey.set(order.order_key, { order, row }); orders.push(order); return }
    if (sameOrder(prev.order, order)) { duplicatesDropped++; return }
    if (!conflicted.has(order.order_key)) { conflicted.add(order.order_key); errors.push({ row: prev.row, code: 'ORDER_KEY_CONFLICT' }) }
    errors.push({ row, code: 'ORDER_KEY_CONFLICT' })
  })
  return errors.length ? { ok: false, errors } : { ok: true, orders, duplicatesDropped }
}
