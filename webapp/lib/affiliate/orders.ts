// Affiliate Order drill-down (contract 28/07) — contract THUẦN cho phân trang
// keyset + điều kiện mở expand + đối soát parent-child (test khóa ở
// e2e/affiliate-orders.spec.ts). KHÔNG import DB/component.
//
// Nguồn dữ liệu = rpc_list_affiliate_orders (mig 099): filter cố định
// DELIVERED + source_active + completed_time ∈ [from, to) — CÙNG điều kiện
// với rpc_aggregate_affiliate_gmv nuôi số parent → child phải đối soát được
// tuyệt đối với parent (kể cả đơn total_price âm, rule đã LOCK).

export const ORDERS_PAGE_SIZE = 50 // khớp clamp ≤50 trong RPC 099

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
