// Affiliate Order drill-down (contract 28/07) — contract THUẦN cho phân trang
// keyset + điều kiện mở expand + đối soát parent-child (test khóa ở
// e2e/affiliate-orders.spec.ts). KHÔNG import DB/component.
//
// Nguồn dữ liệu = rpc_list_affiliate_orders (mig 099): filter cố định
// DELIVERED + source_active + completed_time ∈ [from, to) — CÙNG điều kiện
// với rpc_aggregate_affiliate_gmv nuôi số parent → child phải đối soát được
// tuyệt đối với parent (kể cả đơn total_price âm, rule đã LOCK).

export const ORDERS_PAGE_SIZE = 50 // khớp clamp ≤50 trong RPC 099
export const ORDERS_MAX_RANGE_DAYS = 366 // khớp guard interval trong RPC 099

// r1 (audit P2#3): validate khoảng ngày Ở APP trước khi dựng timestamptz —
// regex không bắt được ngày lịch không tồn tại (2026-02-31) lẫn khoảng đảo/
// quá dài; RPC 099 có guard tương đương trong DB (2 lớp cùng luật).
export function validOrdersRange(from: string, to: string): { ok: true } | { ok: false; reason: string } {
  const cal = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
    const d = new Date(`${s}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
  }
  if (!cal(from) || !cal(to)) return { ok: false, reason: 'Khoảng ngày không hợp lệ' }
  if (from > to) return { ok: false, reason: 'Khoảng ngày không hợp lệ (từ ngày phải trước đến ngày)' }
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000 + 1
  if (days > ORDERS_MAX_RANGE_DAYS) return { ok: false, reason: `Khoảng ngày vượt giới hạn ${ORDERS_MAX_RANGE_DAYS} ngày` }
  return { ok: true }
}

// r1 (audit P2#4): schema cho phép MỘT store có NHIỀU partner mapping (unique
// theo partner_code, không unique store_id) — bảng overview phải group theo
// STORE, partner codes thành metadata; không group → store lặp dòng, số
// GMV/order lặp trực quan, mỗi dòng mở lại cùng tập đơn.
export interface StoreMappingGroup {
  store_id: string
  name: string | null
  code: string | null
  partnerCodes: string[]
  hasFs: boolean
}

export function groupMappingsByStore(mappings: {
  partner_code: string
  partner_type: string
  store_id: string
  stores: { name: string; code: string | null } | null
}[]): StoreMappingGroup[] {
  const byStore = new Map<string, StoreMappingGroup>()
  for (const m of mappings) {
    const g = byStore.get(m.store_id) ?? {
      store_id: m.store_id,
      name: m.stores?.name ?? null,
      code: m.stores?.code ?? null,
      partnerCodes: [],
      hasFs: false,
    }
    if (!g.partnerCodes.includes(m.partner_code)) g.partnerCodes.push(m.partner_code)
    if (m.partner_type === 'fs') g.hasFs = true
    if (g.name === null && m.stores?.name) { g.name = m.stores.name; g.code = m.stores.code ?? null }
    byStore.set(m.store_id, g)
  }
  return [...byStore.values()]
}

// ── FS-expansion (contract 06/08) — ROW MODEL 2 ENTITY của overview ─────────
// OS / FS-có-store: group theo STORE (như cũ); FS KHÔNG store (đối tác, mapping
// fs + store_id NULL): mỗi partner_code là MỘT row riêng — không tạo store giả.
export type OverviewEntity =
  | { kind: 'store'; store_id: string; name: string | null; code: string | null; partnerCodes: string[]; isFs: boolean }
  | { kind: 'partner'; partner_code: string; display_name: string }

export interface OverviewMappingRow {
  partner_code: string
  partner_type: string
  store_id: string | null
  display_name: string | null
  stores: { name: string; code: string | null } | null
}

export function buildOverviewEntities(mappings: OverviewMappingRow[]): OverviewEntity[] {
  const storeRows = mappings.filter((m): m is OverviewMappingRow & { store_id: string } => m.store_id !== null)
  const stores: OverviewEntity[] = groupMappingsByStore(storeRows).map((g) => ({
    kind: 'store', store_id: g.store_id, name: g.name, code: g.code,
    partnerCodes: g.partnerCodes, isFs: g.hasFs,
  }))
  // FS partner (store_id NULL): 1 row / partner_code; display_name trống →
  // fallback chính partner_code (chốt stakeholder 06/08).
  const partners: OverviewEntity[] = mappings
    .filter((m) => m.store_id === null && m.partner_type === 'fs')
    .map((m) => ({
      kind: 'partner',
      partner_code: m.partner_code,
      display_name: (m.display_name ?? '').trim() || m.partner_code,
    }))
  return [...stores, ...partners]
}

// Filter Loại (Tất cả/OS/FS): store thuần OS → 'os'; store có mapping fs HOẶC
// partner-row → 'fs'.
export type OverviewTypeFilter = 'all' | 'os' | 'fs'
export function filterEntitiesByType(entities: OverviewEntity[], type: OverviewTypeFilter): OverviewEntity[] {
  if (type === 'all') return entities
  return entities.filter((e) =>
    type === 'fs'
      ? (e.kind === 'partner' || e.isFs)
      : (e.kind === 'store' && !e.isFs))
}

export interface AffiliateOrderRow {
  id: string
  pos_order_code: string | null
  sale_order_status: string | null
  partner_code: string
  status_norm: string
  total_price: number
  customer_name: string | null
  customer_phone: string | null
  created_time: string
  completed_time: string
}

export interface OrdersCursor { completedTime: string; id: string }

// Keyset: trang đầy (== pageSize) → có thể còn trang sau, cursor = row cuối
// (RPC sort completed_time DESC, id DESC). Trang vơi → hết dữ liệu.
export function nextCursorFrom(
  rows: { completed_time: string; id: string }[],
  pageSize: number,
): OrdersCursor | null {
  if (rows.length < pageSize) return null
  const last = rows[rows.length - 1]
  return { completedTime: last.completed_time, id: last.id }
}

// Chevron CHỈ mở khi số parent là số THẬT: health READY + aggregate OK
// (blocked=false — cùng cờ ẩn số '—' của trang) và store có ≥1 đơn trong
// khoảng. Nguồn !ready → khóa expand cùng lúc với parent (không bao giờ
// hiển thị dữ liệu cũ như dữ liệu mới).
export function drilldownEnabled(p: { blocked: boolean; orders: number }): boolean {
  return !p.blocked && p.orders > 0
}

// Đối soát parent-child (acceptance): khi ĐÃ TẢI HẾT các trang, tổng
// total_price + số đơn phải khớp CHÍNH XÁC số parent (epsilon 0.005 cho
// numeric→float qua JSON; count phải bằng tuyệt đối).
export type ReconcileState = 'loading' | 'match' | 'mismatch'
export function reconcileState(p: {
  loadedAll: boolean
  loadedCount: number
  loadedSum: number
  expectedOrders: number
  expectedGmv: number
}): ReconcileState {
  if (!p.loadedAll) return 'loading'
  return p.loadedCount === p.expectedOrders && Math.abs(p.loadedSum - p.expectedGmv) < 0.005
    ? 'match'
    : 'mismatch'
}
