// Pure normalization/validation cho đơn affiliate từ Mongo — KHÔNG gọi DB
// (stakeholder F2 plan #2). Contract F1 (RPC finish enforce): mọi row upsert
// phải hợp lệ; row thiếu/sai field bắt buộc bị REJECT và đếm vào `rejected`,
// không bao giờ ghi doanh số 0 âm thầm (total_price NOT NULL không default).

// Known-set 7 giá trị đo thật 21-22/07 (D0 + fixture 148 đơn). Giá trị mới
// chưa biết → 'other': cron vẫn chạy, UI badge neutral, sync run ghi cảnh báo.
const STATUS_NORM: Record<string, string> = {
  DELIVERED:        'delivered',
  DELIVERING:       'delivering',
  WAIT_FOR_PAYMENT: 'waiting',
  WAIT_FOR_PURCHASE:'waiting',
  PROCESSING:       'processing',
  FAIL_TO_DELIVER:  'fail_to_deliver',
  CANCELED:         'canceled',
}

export function normalizeStatus(raw: string): string {
  return STATUS_NORM[raw] ?? 'other'
}

// Quy tắc đếm (PM chốt 21/07): mọi đơn trừ CANCELED; FAIL_TO_DELIVER VẪN tính
// (user tái xác nhận 22/07). UI dùng nhãn "Doanh số Affiliate ghi nhận".
export function isCountedStatus(rawStatus: string): boolean {
  return normalizeStatus(rawStatus) !== 'canceled'
}

// Doc Mongo (snake_case — KHÔNG phải camelCase của API layer).
export interface SourceOrderDoc {
  order_id?: unknown
  order_code?: unknown
  pos_order_code?: unknown
  affiliate_partner_code?: unknown
  status?: unknown
  sale_order_status?: unknown
  total_price?: unknown
  total_item?: unknown
  first_item?: { product_name?: unknown } | null
  customer_name?: unknown
  customer_phone?: unknown
  created_time?: unknown
  confirmed_time?: unknown
  last_updated_time?: unknown
}

export interface AffiliateOrderRow {
  order_id: number
  order_code: string | null
  pos_order_code: string | null
  partner_code: string
  raw_status: string
  status_norm: string
  sale_order_status: string | null
  total_price: number
  total_item: number | null
  first_product_name: string | null
  customer_name: string | null
  customer_phone: string | null
  created_time: string
  confirmed_time: string | null
  last_updated_time: string | null
}

export type NormalizeResult =
  | { ok: true; row: AffiliateOrderRow }
  | { ok: false; orderId: unknown; reason: string }

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

// BSON Date qua driver = JS Date; fixture JSON = chuỗi ISO — nhận cả hai.
const isoOrNull = (v: unknown): string | null => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString()
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return new Date(t).toISOString()
  }
  return null
}

// Validate 1 doc nguồn. Field BẮT BUỘC: order_id (số nguyên dương),
// affiliate_partner_code, status, created_time, total_price (số hữu hạn —
// SỐ ÂM VẪN HỢP LỆ, user chốt 22/07: giữ để phát hiện và QA thực tế).
export function validateSourceOrder(doc: SourceOrderDoc): NormalizeResult {
  const orderIdRaw = doc.order_id
  const orderId = typeof orderIdRaw === 'number' ? orderIdRaw : NaN
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return { ok: false, orderId: orderIdRaw, reason: 'order_id thiếu/không phải số nguyên dương' }
  }
  const partnerCode = str(doc.affiliate_partner_code)
  if (!partnerCode) return { ok: false, orderId, reason: 'affiliate_partner_code rỗng' }

  const rawStatus = str(doc.status)
  if (!rawStatus) return { ok: false, orderId, reason: 'status rỗng' }

  const createdTime = isoOrNull(doc.created_time)
  if (!createdTime) return { ok: false, orderId, reason: 'created_time thiếu/không parse được' }

  const tp = doc.total_price
  if (typeof tp !== 'number' || !Number.isFinite(tp)) {
    return { ok: false, orderId, reason: 'total_price thiếu/không phải số' }
  }

  const totalItem = typeof doc.total_item === 'number' && Number.isInteger(doc.total_item)
    ? doc.total_item : null

  return {
    ok: true,
    row: {
      order_id: orderId,
      order_code: str(doc.order_code),
      pos_order_code: str(doc.pos_order_code),
      partner_code: partnerCode,
      raw_status: rawStatus,
      status_norm: normalizeStatus(rawStatus),
      sale_order_status: str(doc.sale_order_status),
      total_price: tp,
      total_item: totalItem,
      first_product_name: str(doc.first_item?.product_name),
      customer_name: str(doc.customer_name),
      customer_phone: str(doc.customer_phone),
      created_time: createdTime,
      confirmed_time: isoOrNull(doc.confirmed_time),
      last_updated_time: isoOrNull(doc.last_updated_time),
    },
  }
}

// Dedupe theo order_id TRƯỚC khi validate/đếm (contract F2): trùng → giữ bản
// có last_updated_time mới nhất (thiếu thì bản gặp sau thắng). Trả thêm số
// bản trùng đã loại để report.
export function dedupeByOrderId(docs: SourceOrderDoc[]): { unique: SourceOrderDoc[]; duplicates: number } {
  const byId = new Map<unknown, SourceOrderDoc>()
  let duplicates = 0
  for (const doc of docs) {
    const id = doc.order_id
    const prev = byId.get(id)
    if (prev === undefined) { byId.set(id, doc); continue }
    duplicates++
    const prevT = isoOrNull(prev.last_updated_time) ?? ''
    const curT = isoOrNull(doc.last_updated_time) ?? ''
    if (curT >= prevT) byId.set(id, doc)
  }
  return { unique: [...byId.values()], duplicates }
}
