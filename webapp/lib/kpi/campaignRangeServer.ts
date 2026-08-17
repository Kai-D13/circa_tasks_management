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

export interface RangeHealth {
  ready: boolean
  reason?: string
  runId?: string | null
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
  // Sức khoẻ nguồn Affiliate — MIRROR đúng flow của syncCampaignCore: đọc
  // TRƯỚC và SAU aggregate, runId đổi giữa hai lần nghĩa là một phiên sync mới
  // đã chen vào và số vừa đọc có thể trộn hai phiên.
  getAffiliateHealth: (storeIds: string[]) => Promise<RangeHealth>
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
    // ── HEALTH GATE TRƯỚC (mirror syncCampaignCore) ───────────────────────
    // Nguồn đang sync dở hoặc stale mà vẫn đọc thì ra một con số trông hợp lệ
    // nhưng thuộc về trạng thái nguồn khác. Màn này để đối soát hoa hồng.
    const before = await deps.getAffiliateHealth(storeIds)
    if (!before.ready) {
      return { ok: false, error: `Nguồn Affiliate chưa sẵn sàng: ${before.reason ?? 'không rõ lý do'}` }
    }

    // Cửa sổ giờ VN half-open: [from 00:00+07, ngày SAU to 00:00+07).
    // Dùng lại vnDayRange của engine — cùng một hàm mà cron đang dùng, nên số
    // trên UI và số đã sync không thể lệch nhau vì lệch định nghĩa biên ngày.
    const { from, to } = vnDayRange(p.range.from, p.range.to)
    const agg = await deps.aggregateCustomers(storeIds, from, to)
    if (agg.error) return { ok: false, error: `Không tính được số khách trong khoảng: ${agg.error.message}` }
    // data null mà không có error là payload BẤT THƯỜNG — trước đây `?? []`
    // biến nó thành "0 khách" cho mọi store, tức fail-OPEN trên màn tiền.
    if (!agg.data) return { ok: false, error: 'Nguồn Affiliate trả dữ liệu rỗng bất thường — chưa thể hiện số theo khoảng.' }

    // RPC chỉ trả (store, ngày) CÓ khách ⇒ map vào ĐỦ tập target, store không
    // có dòng nào là 0 khách. Nếu không, store 0 khách biến mất khỏi bảng và
    // mẫu số "X/Y cửa hàng" sai.
    const byStore = new Map<string, number>(storeIds.map((id) => [id, 0]))
    let sum = 0
    for (const r of agg.data.rows ?? []) {
      // RPC nhận ĐÚNG storeIds này, nên row lạ = RPC/nguồn tự mâu thuẫn, KHÔNG
      // phải dữ liệu hợp lệ để bỏ qua âm thầm.
      if (!byStore.has(r.store_id)) {
        return { ok: false, error: `Nguồn Affiliate trả cửa hàng ngoài phạm vi (${r.store_id}) — số liệu không đáng tin.` }
      }
      const n = Number(r.customer_count)
      if (!Number.isInteger(n) || n < 0) {
        return { ok: false, error: `Số khách không hợp lệ từ nguồn (${String(r.customer_count)}) — chưa thể hiện số theo khoảng.` }
      }
      sum += n
      byStore.set(r.store_id, (byStore.get(r.store_id) ?? 0) + n)
    }
    // Cùng kỷ luật đối soát của sync: RPC dedup DISTINCT ON nên SUM(rows) buộc
    // phải bằng total_customers; lệch là nguồn tự mâu thuẫn.
    if (Number.isFinite(agg.data.total_customers) && sum !== Number(agg.data.total_customers)) {
      return {
        ok: false,
        error: `Số khách tự mâu thuẫn: tổng theo cửa hàng ${sum} ≠ tổng nguồn ${agg.data.total_customers}.`,
      }
    }

    // ── HEALTH GATE SAU: runId đổi = một phiên sync chen vào giữa chừng ───
    const after = await deps.getAffiliateHealth(storeIds)
    if (!after.ready) {
      return { ok: false, error: `Nguồn Affiliate đổi trạng thái trong lúc tính: ${after.reason ?? 'không rõ lý do'}` }
    }
    if (after.runId !== before.runId) {
      return {
        ok: false,
        error: 'Nguồn Affiliate vừa đồng bộ lại trong lúc tính — số có thể trộn hai phiên. Vui lòng thử lại.',
      }
    }

    const stores = [...byStore.entries()].map(([store_id, customers]) => ({ store_id, customers }))
    return { ok: true, mode: 'customer', stores, totalCustomers: sum, storeCount: storeIds.length }
  }

  const daily = await deps.loadDaily(p.campaignId, storeIds, p.range.from, p.range.to)
  if (daily.error) return { ok: false, error: `Không đọc được số liệu theo ngày: ${daily.error.message}` }
  // Cùng lý do với nhánh khách: null ≠ "không có dòng nào".
  if (!daily.data) return { ok: false, error: 'Không đọc được số liệu theo ngày — nguồn trả rỗng bất thường.' }

  const stores = buildRangeStoreActuals(daily.data, storeIds)
  return { ok: true, mode: 'daily', stores, totals: buildRangeTotals(stores) }
}
