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
// nguyên trong SUM (rule engine hiện hành — chờ stakeholder xác nhận riêng).
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

// Ai thấy gì (quyết định user 24/07):
//   super            → 'full'   (tab Affiliate /targets/campaigns: OS + FS)
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
