// Pure normalization/validation cho đơn affiliate từ Mongo — KHÔNG gọi DB
// (stakeholder F2 plan #2). Contract F1 (RPC finish enforce): mọi row upsert
// phải hợp lệ; row thiếu/sai field bắt buộc bị REJECT và đếm vào `rejected`,
// không bao giờ ghi doanh số 0 âm thầm (total_price NOT NULL không default).

// Known-set 7 giá trị đo thật 21-22/07 (D0 + fixture 148 đơn) + WAIT_TO_DELIVER
// (xuất hiện trong nguồn 27/07 — run success_with_notes; phân loại 'waiting'
// = đơn CHỜ GIAO, không tính GMV, không đổi rule DELIVERED-only). Giá trị mới
// chưa biết → 'other': cron vẫn chạy, UI badge neutral, sync run ghi cảnh báo
// + health gate chặn READY tới khi được phân loại (fail-closed đúng thiết kế).
const STATUS_NORM: Record<string, string> = {
  DELIVERED:        'delivered',
  DELIVERING:       'delivering',
  WAIT_FOR_PAYMENT: 'waiting',
  WAIT_FOR_PURCHASE:'waiting',
  WAIT_TO_DELIVER:  'waiting',
  PROCESSING:       'processing',
  FAIL_TO_DELIVER:  'fail_to_deliver',
  CANCELED:         'canceled',
}

export function normalizeStatus(raw: string): string {
  return STATUS_NORM[raw] ?? 'other'
}

// Quy tắc đếm KPI (audit 22/07 — THAY THẾ rule cũ "mọi đơn trừ CANCELED"):
// CHỈ đơn giao thành công (DELIVERED) được tính GMV Affiliate trong KPI
// Campaign. Ingestion (F2) vẫn LƯU đầy đủ mọi status — không lọc lúc pull, vì
// PROCESSING→DELIVERED phải cộng và DELIVERED→CANCELED phải trừ ở sync sau;
// việc lọc chỉ diễn ra ở tầng aggregate (rpc_aggregate_affiliate_gmv).
export function isKpiAffiliateCountedStatus(rawStatus: string): boolean {
  return normalizeStatus(rawStatus) === 'delivered'
}

// Doc Mongo (snake_case — KHÔNG phải camelCase của API layer).
export interface SourceOrderDoc {
  order_id?: unknown
  order_code?: unknown
  pos_order_code?: unknown
  account_id?: unknown
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
  completed_time?: unknown
  last_updated_time?: unknown
}

export interface AffiliateOrderRow {
  order_id: number
  order_code: string | null
  pos_order_code: string | null
  // Identity khách (metric affiliate_customer_count, mig 103). NULLABLE —
  // thiếu/hỏng KHÔNG reject row (mirror completed_time): ingest vẫn lưu đủ,
  // fail-closed nằm ở rpc_aggregate_affiliate_customers + canary report cron.
  account_id: number | null
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
  // Mốc giao thành công (KPI date basis — chốt 22/07). Optional trong nguồn:
  // đơn chưa giao chưa có; DELIVERED thiếu → aggregation tự loại (canary QA).
  completed_time: string | null
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

// ── BSON-safe numeric coercion (audit F2 P1) ────────────────────────────────
// mongo.ts đặt promoteLongs:false → int64 tới đây là Long object (duck-type
// .toNumber()); Decimal128 không bao giờ được driver tự convert. Số vượt
// Number.MAX_SAFE_INTEGER → null → caller reject (không im lặng mất chính xác).
type BsonNumericLike = { toNumber?: () => number; toString: () => string; _bsontype?: string }

const toFiniteNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'object' && v !== null) {
    const o = v as BsonNumericLike
    if (o._bsontype === 'Decimal128') {
      const n = Number(o.toString())
      return Number.isFinite(n) ? n : null
    }
    if (typeof o.toNumber === 'function') {
      const n = o.toNumber()
      return Number.isFinite(n) ? n : null
    }
  }
  return null
}

const toSafeInt = (v: unknown): number | null => {
  const n = toFiniteNumber(v)
  return n !== null && Number.isSafeInteger(n) ? n : null
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
  const orderId = toSafeInt(doc.order_id)
  if (orderId === null || orderId <= 0) {
    return { ok: false, orderId: doc.order_id, reason: 'order_id thiếu/không phải số nguyên dương an toàn (safe integer)' }
  }
  const partnerCode = str(doc.affiliate_partner_code)
  if (!partnerCode) return { ok: false, orderId, reason: 'affiliate_partner_code rỗng' }

  const rawStatus = str(doc.status)
  if (!rawStatus) return { ok: false, orderId, reason: 'status rỗng' }

  const createdTime = isoOrNull(doc.created_time)
  if (!createdTime) return { ok: false, orderId, reason: 'created_time thiếu/không parse được' }

  const tp = toFiniteNumber(doc.total_price)
  if (tp === null) {
    return { ok: false, orderId, reason: 'total_price thiếu/không phải số (hoặc BSON type không convert được)' }
  }

  const totalItem = toSafeInt(doc.total_item)
  // account_id: BSON Long qua toSafeInt (vượt safe-int/hỏng → null, KHÔNG
  // biến thành 0); phải DƯƠNG — id ≤ 0 coi như thiếu.
  const accountIdRaw = toSafeInt(doc.account_id)
  const accountId = accountIdRaw !== null && accountIdRaw > 0 ? accountIdRaw : null

  return {
    ok: true,
    row: {
      order_id: orderId,
      order_code: str(doc.order_code),
      pos_order_code: str(doc.pos_order_code),
      account_id: accountId,
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
      completed_time: isoOrNull(doc.completed_time),
      last_updated_time: isoOrNull(doc.last_updated_time),
    },
  }
}

// ── Contract partner_code THỐNG NHẤT (FS-expansion r1, audit 06/08 P1#1) ────
// Dùng chung: cron auto-create (lọc candidate trước khi gọi RPC ensure) +
// server action drill-down partner. Production CÓ mã chứa khoảng trắng và
// Unicode ('NT THIÊN') — TUYỆT ĐỐI không giới hạn ASCII. Luật: string đã
// trim, không rỗng, ≤64 ký tự, không control character (newline/tab/…). Mọi
// đường SQL đều parameterized (RPC args) — không cần regex ASCII để chống
// injection. DB mirror cùng luật trong rpc_ensure_fs_partner_mappings (102).
export const PARTNER_CODE_MAX_LEN = 64
export function isValidPartnerCode(code: unknown): code is string {
  return typeof code === 'string'
    && code.length > 0
    && code === code.trim()
    && code.length <= PARTNER_CODE_MAX_LEN
    // eslint-disable-next-line no-control-regex
    && !/[\u0000-\u001F\u007F]/.test(code)
}

// ── Resolver mapping DÙNG CHUNG cho dry-run và real run (audit F2 r1 P1 —
// hai luồng không được lệch logic). Pure: mappings do caller đọc từ DB. ──────
export interface PartnerMappingRow {
  partner_code: string
  store_id: string | null
  partner_type: string
  is_active: boolean
}

// FS-expansion (contract 05-06/08, mig 102): hết khái niệm external trên
// luồng vận hành — mọi mã ngoài whitelist OS là FS (được phép store_id NULL,
// group theo partner_code trên overview, chỉ super drill-down).
export interface ResolveReport {
  matched_os: number          // đơn map store OS (mapping os + store_id)
  matched_fs: number          // đơn map mapping FS (CÓ hoặc KHÔNG store_id)
  unmatched_codes: string[]   // code KHÔNG có mapping HOẶC mapping sai cấu hình
                              // (type lạ/os thiếu store) → store_id NULL + health chặn
  inactive_codes: string[]    // code có mapping nhưng is_active=false → store_id NULL
  null_store_orders: number   // tổng đơn nằm store_id NULL (fs-partner+unmatched+inactive)
  negative_price_count: number
  negative_price_sample: number[] // tối đa 10 order_id
}

// Danh sách code có VẤN ĐỀ NGUỒN (chưa map + mapping inactive) — F2 hợp nhất
// vào p_unmatched của rpc_finish để affiliate_sync_runs lưu đủ (health gate
// P3-A đọc từ đó; inactive_codes không có cột riêng — quyết định audit 23/07,
// không cần migration).
export function sourceIssueCodes(report: ResolveReport): string[] {
  return [...new Set([...report.unmatched_codes, ...report.inactive_codes])]
}

export function resolveStores(
  rows: AffiliateOrderRow[],
  mappings: PartnerMappingRow[],
): { resolved: (AffiliateOrderRow & { store_id: string | null })[]; report: ResolveReport } {
  const byCode = new Map(mappings.map((m) => [m.partner_code, m]))
  const unmatched = new Set<string>()
  const inactive = new Set<string>()
  const report: ResolveReport = {
    matched_os: 0, matched_fs: 0,
    unmatched_codes: [], inactive_codes: [], null_store_orders: 0,
    negative_price_count: 0, negative_price_sample: [],
  }
  const resolved = rows.map((r) => {
    const m = byCode.get(r.partner_code)
    let storeId: string | null = null
    if (!m) {
      unmatched.add(r.partner_code)
    } else if (!m.is_active) {
      inactive.add(r.partner_code)
    } else if (m.partner_type === 'os' && m.store_id) {
      storeId = m.store_id; report.matched_os++
    } else if (m.partner_type === 'fs') {
      // FS được phép store_id NULL (đối tác không phải cửa hàng thật) —
      // đơn giữ store_id NULL, aggregate/drill-down đi theo partner_code.
      storeId = m.store_id ?? null; report.matched_fs++
    } else {
      // Mapping sai cấu hình (type 'external' còn sót sau 102 / os thiếu
      // store_id) → coi như unmatched: fail-visible qua health, không đoán.
      unmatched.add(r.partner_code)
    }
    if (storeId === null) report.null_store_orders++
    if (r.total_price < 0) {
      report.negative_price_count++
      if (report.negative_price_sample.length < 10) report.negative_price_sample.push(r.order_id)
    }
    return { ...r, store_id: storeId }
  })
  report.unmatched_codes = [...unmatched]
  report.inactive_codes = [...inactive]
  return { resolved, report }
}

// Dedupe theo order_id TRƯỚC khi validate/đếm (contract F2): trùng → giữ bản
// có last_updated_time mới nhất (thiếu thì bản gặp sau thắng). Khóa dedupe =
// GIÁ TRỊ số canonical (toSafeInt) — number/Int32/Long cùng giá trị phải chung
// 1 key (audit r1.1 P1: Long là object, dùng raw làm Map key thì 2 Long cùng
// ID vẫn là 2 key → không dedupe → ON CONFLICT đụng cùng row 2 lần trong 1
// batch upsert). Row KHÔNG có order_id hợp lệ giữ RIÊNG từng row (không gom
// chung 1 key undefined) để validate phía sau đếm đủ rejected.
export function dedupeByOrderId(docs: SourceOrderDoc[]): { unique: SourceOrderDoc[]; duplicates: number } {
  const byId = new Map<number, SourceOrderDoc>()
  const invalidId: SourceOrderDoc[] = []
  let duplicates = 0
  for (const doc of docs) {
    const id = toSafeInt(doc.order_id)
    if (id === null) { invalidId.push(doc); continue }
    const prev = byId.get(id)
    if (prev === undefined) { byId.set(id, doc); continue }
    duplicates++
    const prevT = isoOrNull(prev.last_updated_time) ?? ''
    const curT = isoOrNull(doc.last_updated_time) ?? ''
    if (curT >= prevT) byId.set(id, doc)
  }
  return { unique: [...byId.values(), ...invalidId], duplicates }
}
