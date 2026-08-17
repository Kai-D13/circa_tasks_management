// Tầng ĐỌC số liệu campaign theo khoảng (17/08) — chỉ đọc, không ghi gì.
//
// Deps được tiêm để test được toàn bộ luật điều phối mà không cần DB (cùng
// pattern syncCampaignCore). Quy tắc bất di bất dịch:
//   · store IDs LUÔN derive server-side từ campaign targets dưới RLS —
//     KHÔNG BAO GIỜ nhận từ query string.
//   · RPC service-role chỉ được gọi SAU khi đã có tập store hợp lệ.
//   · Lỗi là FAIL-VISIBLE. Không bao giờ âm thầm rơi về snapshot toàn kỳ:
//     người dùng đang gõ một khoảng cụ thể, trả về số của khoảng khác mà không
//     nói gì là kiểu sai tệ nhất trên màn hoa hồng.

import { vnDayRange } from '@/lib/kpi/engine'
import { rangeAggregationMode } from '@/lib/kpi/campaignDateRange'
import type { CampaignRange } from '@/lib/kpi/campaignDateRange'
import {
  buildRangeStoreActuals, buildRangeTotals,
  type CampaignDailyRow, type RangeStoreActual, type RangeTotals,
} from '@/lib/kpi/campaignRangeModel'

export interface RangeCustomerActual {
  store_id: string
  customers: number
}

interface DbResult<T> { data: T | null; error: { message: string } | null }

export interface CustomerRangeRows {
  rows: { store_id: string; vn_date: string; customer_count: number }[]
  total_customers: number
}

export interface RangeReadDeps {
  // Dưới RLS của người đang đăng nhập — đây là chỗ quyết định phạm vi dữ liệu.
  loadTargetStoreIds: (campaignId: string) => Promise<DbResult<string[]>>
  loadDaily: (
    campaignId: string, storeIds: string[], from: string, to: string,
  ) => Promise<DbResult<CampaignDailyRow[]>>
  // service-role (RPC grant service_role only) — chỉ gọi sau khi có storeIds.
  aggregateCustomers: (
    storeIds: string[], fromTs: string, toTs: string,
  ) => Promise<DbResult<CustomerRangeRows>>
}

export type RangeReadResult =
  | { ok: true; mode: 'daily'; stores: RangeStoreActual[]; totals: RangeTotals }
  | { ok: true; mode: 'customer'; stores: RangeCustomerActual[]; totalCustomers: number; storeCount: number }
  | { ok: false; error: string }

export async function loadCampaignRangeActuals(
  deps: RangeReadDeps,
  p: { campaignId: string; range: CampaignRange; metricType?: string | null },
): Promise<RangeReadResult> {
  // Chốt cứng: hàm này CHỈ chạy khi có khoảng thật. Gọi lúc range không active
  // là bug ở caller — và với campaign khách nó còn nghĩa là gọi RPC vô ích.
  if (!p.range.active || !p.range.from || !p.range.to) {
    return { ok: false, error: 'Khoảng ngày chưa hợp lệ — không truy vấn.' }
  }

  const targets = await deps.loadTargetStoreIds(p.campaignId)
  if (targets.error) return { ok: false, error: `Không đọc được danh sách cửa hàng: ${targets.error.message}` }
  const storeIds = targets.data ?? []
  if (storeIds.length === 0) {
    return { ok: false, error: 'Chiến dịch chưa có cửa hàng nào trong phạm vi bạn xem được.' }
  }

  if (rangeAggregationMode(p.metricType) === 'customer-rpc') {
    // Cửa sổ giờ VN half-open: [from 00:00+07, ngày SAU to 00:00+07).
    // Dùng lại vnDayRange của engine — cùng một hàm mà cron đang dùng, nên số
    // trên UI và số đã sync không thể lệch nhau vì lệch định nghĩa biên ngày.
    const { from, to } = vnDayRange(p.range.from, p.range.to)
    const agg = await deps.aggregateCustomers(storeIds, from, to)
    if (agg.error) return { ok: false, error: `Không tính được số khách trong khoảng: ${agg.error.message}` }

    // RPC chỉ trả (store, ngày) CÓ khách ⇒ phải map vào ĐỦ tập target, store
    // không có dòng nào là 0 khách. Nếu không, store 0 khách biến mất khỏi bảng
    // và mẫu số "X/Y cửa hàng" sai.
    const byStore = new Map<string, number>(storeIds.map((id) => [id, 0]))
    for (const r of agg.data?.rows ?? []) {
      if (!byStore.has(r.store_id)) continue          // ngoài scope → bỏ
      // Cộng qua ngày là ĐÚNG ở đây: RPC đã DISTINCT ON (phone) trước khi group
      // theo (store, ngày), nên mỗi khách chỉ nằm trong đúng một ô.
      byStore.set(r.store_id, (byStore.get(r.store_id) ?? 0) + (Number(r.customer_count) || 0))
    }
    const stores = [...byStore.entries()].map(([store_id, customers]) => ({ store_id, customers }))
    return {
      ok: true,
      mode: 'customer',
      stores,
      totalCustomers: stores.reduce((s, x) => s + x.customers, 0),
      storeCount: storeIds.length,
    }
  }

  const daily = await deps.loadDaily(p.campaignId, storeIds, p.range.from, p.range.to)
  if (daily.error) return { ok: false, error: `Không đọc được số liệu theo ngày: ${daily.error.message}` }

  const stores = buildRangeStoreActuals(daily.data ?? [], storeIds)
  return { ok: true, mode: 'daily', stores, totals: buildRangeTotals(stores) }
}
