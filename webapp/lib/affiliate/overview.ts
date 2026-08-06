// P3-I — contract Affiliate Overview (THUẦN, test khóa ở
// e2e/affiliate-overview.spec.ts). Overview CHỈ ĐỌC dữ liệu đã sync trong
// Supabase (qua rpc_aggregate_affiliate_gmv) — KHÔNG nút đồng bộ trên UI,
// không đụng Mongo (quyết định user 24/07, tránh ảnh hưởng vận hành).

export interface AffiliateAggInput {
  store_id: string
  vn_date: string      // 'YYYY-MM-DD' (ngày VN của completed_time)
  gmv: number          // SUM total_price DELIVERED+active (có thể âm)
  order_count: number
}

export interface StoreAffiliateAgg { gmv: number; orders: number; lastDate: string | null }

// Reduce rows (store × ngày) của RPC → per-store + totals. Giá trị ÂM giữ
// nguyên trong SUM (rule ĐÃ CHỐT 24/07: GMV = SUM(total_price) DELIVERED +
// source_active, BAO GỒM total_price < 0 — đơn âm làm giảm GMV nhưng vẫn
// tính vào số đơn delivered).
export function reduceAffiliateAgg(rows: AffiliateAggInput[]): {
  byStore: Map<string, StoreAffiliateAgg>
  totals: { gmv: number; orders: number; storesWithSales: number }
} {
  const byStore = new Map<string, StoreAffiliateAgg>()
  for (const r of rows) {
    const a = byStore.get(r.store_id) ?? { gmv: 0, orders: 0, lastDate: null }
    a.gmv += Number(r.gmv) || 0
    a.orders += Number(r.order_count) || 0
    const d = String(r.vn_date).slice(0, 10)
    if (!a.lastDate || d > a.lastDate) a.lastDate = d
    byStore.set(r.store_id, a)
  }
  let gmv = 0, orders = 0, storesWithSales = 0
  for (const a of byStore.values()) {
    gmv += a.gmv
    orders += a.orders
    if (a.orders > 0) storesWithSales += 1
  }
  return { byStore, totals: { gmv, orders, storesWithSales } }
}

// Cửa sổ tháng VN hiện tại theo vnTodayISO ('YYYY-MM-DD') → cặp ngày ISO
// [đầu tháng, cuối tháng] — đưa vào vnDayRange(from, to) để ra timestamptz.
export function currentVnMonthISO(todayISO: string): { from: string; to: string } {
  const y = Number(todayISO.slice(0, 4))
  const m = Number(todayISO.slice(5, 7))
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate() // ngày cuối tháng m
  return { from: `${todayISO.slice(0, 7)}-01`, to: `${todayISO.slice(0, 7)}-${String(lastDay).padStart(2, '0')}` }
}

// r1 (audit P1 #1): SM/Store Manager CHỈ xem GMV Affiliate của store OS active.
// RPC aggregate chạy service-role (RLS không cứu được lớp này) → caller BẮT
// BUỘC verify store trước khi gọi; FS store / store ngưng hoạt động → false.
export function canShowOwnOsGmv(
  store: { store_type: string; is_active: boolean } | null | undefined,
): boolean {
  return !!store && store.store_type === 'os' && store.is_active === true
}

// r1 (audit P2 #3): ngày phải là NGÀY LỊCH THẬT — '2026-02-31'/'2026-99-99'
// round-trip qua Date sẽ lệch/NaN → loại.
export function isRealISODate(s: string | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export const OVERVIEW_MAX_RANGE_DAYS = 366

// Parse range từ URL: sai/thiếu → tháng VN hiện tại; from > to → hoán vị;
// cửa sổ > 366 ngày → clamp from = to − 365 (chống query URL phá range).
export function parseOverviewRange(
  fromParam: string | undefined,
  toParam: string | undefined,
  todayISO: string,
): { from: string; to: string; clamped: boolean } {
  const month = currentVnMonthISO(todayISO)
  let from = isRealISODate(fromParam) ? fromParam : month.from
  let to = isRealISODate(toParam) ? toParam : month.to
  if (from > to) [from, to] = [to, from]
  const toMs = Date.parse(`${to}T00:00:00Z`)
  const days = Math.floor((toMs - Date.parse(`${from}T00:00:00Z`)) / 86400_000) + 1
  let clamped = false
  if (days > OVERVIEW_MAX_RANGE_DAYS) {
    from = new Date(toMs - (OVERVIEW_MAX_RANGE_DAYS - 1) * 86400_000).toISOString().slice(0, 10)
    clamped = true
  }
  return { from, to, clamped }
}

// r1.1 (audit): HEALTH FAIL-CLOSED — số tài chính CHỈ hiển thị khi nguồn sync
// READY (run success + không rejected/unmatched/unknown/note + không stale
// >180' + canary completed_time sạch + lookup không lỗi — evaluate đầy đủ ở
// lib/affiliate/health.ts). Page gọi health TRƯỚC; !ready → KHÔNG gọi
// aggregate, summary/bảng/card hiện '—' + lý do cụ thể + lần sync thành công
// gần nhất (nếu có). Aggregate lỗi (kể cả RAISE fail-closed) → 'aggregate-error'.
export type OverviewDataState = 'ok' | 'source-not-ready' | 'aggregate-error'
export function overviewDataState(healthReady: boolean, aggregateError: boolean): OverviewDataState {
  if (!healthReady) return 'source-not-ready'
  if (aggregateError) return 'aggregate-error'
  return 'ok'
}

// P3-I.2 — quyền vào MÀN TỔNG HỢP /targets/campaigns/affiliate (user chốt
// 24/07, đảo chiếu RLS 090/096):
//   super                       → 'os-fs'       (toàn bộ OS + FS)
//   admin phòng được cấp quyền  → 'os-all'      (toàn bộ OS — FS/external chỉ super)
//   sm                          → 'os-assigned' (store OS được phân công)
//   store_manager               → 'os-own'      (store mình)
//   staff / admin thường / khác → 'denied' · flag tắt → 'denied' TẤT CẢ.
// Data scoping thực thi = RLS (mappings đọc qua session client) — hàm này chỉ
// quyết định gate route + biến thể UI; storeIds cho RPC derive từ rows RLS trả.
// SM r5 (handoff 27/07): card GMV Affiliate REGIONAL trên landing /targets của
// SM — flag bật + có ≥1 store active-OS được phân công (đã validate server-side
// từ sm_store_assignments, KHÔNG nhận store từ query string) + KHÔNG ở campaign
// detail. Hiện CẢ khi store không có campaign active. Flag off → false (không
// query, không render). Health-first + 1 aggregate call toàn vùng do page lo.
export function smRegionalGmvVisible(p: {
  flagEnabled: boolean
  storeCount: number
  inCampaignDetail: boolean
}): boolean {
  return p.flagEnabled && p.storeCount > 0 && !p.inCampaignDetail
}

// r1.2b (audit P2): SM chỉ được vào overview khi có ÍT NHẤT MỘT store OS
// ACTIVE trong danh sách phân công — assignment toàn FS/inactive cũng chặn
// (đúng contract "không có store OS active → notFound", không mở route rồi
// rơi empty state). activeOsCount = null nghĩa là query stores LỖI → fail-closed.
export function smOverviewAllowed(assignedCount: number, activeOsCount: number | null): boolean {
  return assignedCount > 0 && activeOsCount !== null && activeOsCount > 0
}

// r1.2a (audit P2#1): item sidebar "Affiliate" CHỈ cho admin phòng được cấp
// quyền KHÔNG PHẢI super (super đi qua Chiến dịch KPI → tab — không nhân đôi nav).
export function opsSidebarVisible(p: {
  flagEnabled: boolean
  role: string | null | undefined
  isSuper: boolean
  isDeptAdmin: boolean
}): boolean {
  return p.flagEnabled && p.role === 'admin' && !p.isSuper && p.isDeptAdmin
}

export type OverviewPageScope = 'os-fs' | 'os-all' | 'os-assigned' | 'os-own' | 'denied'
export function overviewPageScope(p: {
  flagEnabled: boolean
  isSuper: boolean
  isAffiliateDeptAdmin: boolean
  role: string | null | undefined
}): OverviewPageScope {
  if (!p.flagEnabled) return 'denied'
  if (p.isSuper) return 'os-fs'
  if (p.role === 'admin' && p.isAffiliateDeptAdmin) return 'os-all'
  if (p.role === 'sm') return 'os-assigned'
  if (p.role === 'store_manager') return 'os-own'
  return 'denied'
}

// Ai thấy gì trên LANDING /targets (card GMV — quyết định user 24/07):
//   super            → 'full'   (dùng màn tổng hợp, không card)
//   sm/store_manager → 'own-os' (card GMV tháng trên landing /targets, store scope mình)
//   staff / admin thường / role khác → 'none'
//   flag KPI_AFFILIATE_ENABLED tắt → 'none' cho TẤT CẢ.
export type OverviewAccess = 'full' | 'own-os' | 'none'
export function overviewVisibleFor(p: {
  isSuper: boolean
  role: string | null | undefined
  flagEnabled: boolean
}): OverviewAccess {
  if (!p.flagEnabled) return 'none'
  if (p.isSuper) return 'full'
  if (p.role === 'sm' || p.role === 'store_manager') return 'own-os'
  return 'none'
}

// ── FS-expansion (contract 06/08) ───────────────────────────────────────────
// Filter Loại của overview: CHỈ super ('os-fs') được chọn; mọi scope khác ÉP
// 'os' — query-string không vượt được RBAC (OPS/SM/QLCH giữ OS-scope).
export function parseOverviewType(
  raw: string | undefined,
  scope: OverviewPageScope,
): 'all' | 'os' | 'fs' {
  if (scope !== 'os-fs') return 'os'
  return raw === 'os' || raw === 'fs' ? raw : 'all'
}

// Label card thứ 3: đếm ĐIỂM ghi nhận (store + đối tác FS) khi view có FS;
// giữ chữ "Store" khi chỉ xem OS.
export function salesPointsLabel(type: 'all' | 'os' | 'fs'): string {
  return type === 'os' ? 'Store có doanh số' : 'Điểm có doanh số'
}

// Reduce aggregate theo PARTNER_CODE (rpc_aggregate_affiliate_partner_gmv) —
// mirror reduceAffiliateAgg: giữ giá trị ÂM, lastDate = max vn_date.
export interface PartnerAggInput { partner_code: string; vn_date: string; gmv: number; order_count: number }
export function reduceAffiliatePartnerAgg(rows: PartnerAggInput[]): {
  byPartner: Map<string, StoreAffiliateAgg>
  totals: { gmv: number; orders: number; pointsWithSales: number }
} {
  const byPartner = new Map<string, StoreAffiliateAgg>()
  for (const r of rows) {
    const cur = byPartner.get(r.partner_code) ?? { gmv: 0, orders: 0, lastDate: null }
    cur.gmv += Number(r.gmv) || 0
    cur.orders += Number(r.order_count) || 0
    if (!cur.lastDate || r.vn_date > cur.lastDate) cur.lastDate = r.vn_date
    byPartner.set(r.partner_code, cur)
  }
  let gmv = 0; let orders = 0; let pointsWithSales = 0
  for (const v of byPartner.values()) {
    gmv += v.gmv; orders += v.orders
    if (v.orders > 0) pointsWithSales++
  }
  return { byPartner, totals: { gmv, orders, pointsWithSales } }
}
