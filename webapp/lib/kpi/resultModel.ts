// SM Dashboard r1 (stakeholder 27/07) — RESULT MODEL dùng chung Super Admin ↔
// SM: một nguồn công thức duy nhất cho màn Kết quả campaign (màn tiền — hai
// giao diện không bao giờ được lệch số). THUẦN: không import component/DB;
// công thức COPY NGUYÊN VĂN từ tab Kết quả của super
// (targets/campaigns/[id]/page.tsx trước refactor) — test khóa.
//
// Cùng input → cùng output ở mọi role; SM đưa vào tập rows RLS-scoped (chỉ
// store được phân công) → totals tự là tổng đúng phạm vi SM.

import { campaignPerformance, requiredPerDay } from '@/lib/kpi/performance'
import {
  ORDER_AOV_STATUS_LABEL, aovFromSnapshot, orderAovDualView, orderAovStatus,
  qualityKpiPass as isQualityKpiPass, type OrderAovDualView, type OrderAovStatus,
} from '@/lib/kpi/orderAov'

// Mig 106: gom phần Chất lượng bán hàng của 1 dòng store. Campaign loại khác →
// mọi field null/false (UI không đổi 1 bit).
function buildQualityFields(t: ResultTargetRow, a: ResultActualRow | null): {
  orderAovView: OrderAovDualView | null
  qualityKpiPass: boolean
  qualityStatus: OrderAovStatus | null
  qualityStatusLabel: string | null
} {
  // Commit 5: HAI chỉ số độc lập, mỗi cái % riêng — nguồn DUY NHẤT cho bảng và
  // card sau khi bỏ điểm gộp khỏi UI. `synced` bám actual_value (điểm do RPC
  // ghi) chứ không bám số đơn: snapshot partial còn số đơn của kỳ trước.
  const view = orderAovDualView({
    actualOrder: a?.offline_order_count ?? null,
    actualNet: a?.actual_offline ?? null,
    orderTarget: t.order_target, aovTarget: t.aov_target,
    synced: a?.actual_value != null,
  })
  if (!view) {
    return { orderAovView: null, qualityKpiPass: false, qualityStatus: null, qualityStatusLabel: null }
  }
  const orders = a?.offline_order_count ?? null
  const aov = aovFromSnapshot(a?.actual_offline, orders)
  // Chưa sync (không có actual) → KHÔNG suy trạng thái, UI hiện '—'.
  const status = a == null || orders == null ? null : orderAovStatus({
    actualOrder: orders,
    orderPass: orders >= Number(t.order_target),
    aovPass: aov !== null && aov >= Number(t.aov_target),
  })
  return {
    orderAovView: view,
    // completion >= 100 ⟺ đạt CẢ HAI mục tiêu (min của 2 tỉ lệ) — RPC giữ
    // invariant này nên đọc từ actual_value là đủ và không thể lệch.
    qualityKpiPass: isQualityKpiPass(a?.actual_value),
    qualityStatus: status,
    qualityStatusLabel: status ? ORDER_AOV_STATUS_LABEL[status] : null,
  }
}

export interface ResultTierRow { tier_order: number; threshold_pct: number; commission_amount: number }

export interface ResultTargetRow {
  id: string
  store_id: string
  pos_code: string | null
  kpi_target: number
  store_kpi_group: string | null
  stores: { name: string } | null
  kpi_campaign_store_tiers: ResultTierRow[]
  // Mig 106 — chỉ campaign Chất lượng bán hàng (NULL với 2 loại cũ).
  order_target?: number | null
  aov_target?: number | null
}

export interface ResultActualRow {
  store_id: string
  actual_value: number
  run_rate: number | null
  remaining_target: number | null
  achieved_tier_order: number | null
  store_commission_pool: number | null
  synced_at: string
  actual_offline: number | null
  actual_affiliate: number | null
  // 105: số đơn Offline (BQ no_order). NULL = nguồn/snapshot chưa có số đơn —
  // KHÁC 0; UI phải hiện '—', KHÔNG hiện "0 đơn".
  offline_order_count: number | null
  offline_synced_at: string | null
  affiliate_synced_at: string | null
}

export interface ResultCampaign {
  id: string
  name: string
  start_date: string
  end_date: string
  status: string
  metric_offline: boolean
  metric_affiliate: boolean
  // Mig 103: pass-through cho UI/export chọn presentation (số học model KHÔNG
  // phụ thuộc — thuần số); thiếu (caller cũ) = gmv.
  metric_type?: string
}

// ── Tier Progress (contract 28/07 — desktop ≥1024px) ────────────────────────
// Tiến độ THEO TỪNG BẬC của một store, render động theo N tier của file import
// (KHÔNG hardcode 3 bậc). Công thức chốt:
//   target_amount = ceil(kpi_target × threshold_pct / 100)
//   remaining     = max(target_amount − actual_value, 0)
// reached lấy từ BACKEND (achieved_tier_order do sync engine ghi) — backend
// xác nhận đã đạt thì ÉP remaining = 0 (tránh lệch do làm tròn run_rate).
// Chưa sync (actual null) → remaining_amount = null — UI hiện '—', KHÔNG
// bao giờ coi là 0 (màn tiền không suy diễn từ dữ liệu thiếu).
export interface TierProgress {
  tier_order: number
  threshold_pct: number
  commission_amount: number
  target_amount: number
  reached: boolean
  remaining_amount: number | null   // null = chưa đồng bộ
}

export function buildTierProgress(
  kpiTarget: number,
  actual: { actual_value: number; achieved_tier_order: number | null } | null,
  tiers: ResultTierRow[],
): TierProgress[] {
  return [...tiers]
    .sort((a, b) => a.tier_order - b.tier_order)
    .map((t) => {
      const target_amount = Math.ceil(((Number(kpiTarget) || 0) * (Number(t.threshold_pct) || 0)) / 100)
      const base = {
        tier_order: t.tier_order,
        threshold_pct: Number(t.threshold_pct) || 0,
        commission_amount: Number(t.commission_amount) || 0,
        target_amount,
      }
      if (!actual) return { ...base, reached: false, remaining_amount: null }
      const reached = actual.achieved_tier_order !== null && t.tier_order <= actual.achieved_tier_order
      return {
        ...base,
        reached,
        remaining_amount: reached ? 0 : Math.max(target_amount - (Number(actual.actual_value) || 0), 0),
      }
    })
}

export interface StoreResultRow {
  targetId: string
  storeId: string
  storeName: string | null
  posCode: string | null
  group: string | null
  kpiTarget: number
  actual: ResultActualRow | null
  performance: number | null
  // 10/08: "Trung bình/ngày cần đạt" — CÙNG công thức card Staff (lib/kpi/
  // performance.requiredPerDay). null = chưa sync / campaign hết ngày → '—'.
  requiredPerDay: number | null
  // 105: số đơn Offline + AOV (= actual_offline / offline_order_count).
  // null khi chưa có count hoặc count = 0 (chia 0) → UI '—'.
  offlineOrderCount: number | null
  offlineAov: number | null
  // ── Mig 106 (chỉ campaign Chất lượng bán hàng; null với 2 loại cũ) ──
  // 2 dòng gộp CÙNG một nhóm cột (không đẻ cột ngang mới).
  orderAovView: OrderAovDualView | null   // commit 5: Số đơn và AOV tách rời
  qualityKpiPass: boolean          // completion >= 100 (KHÔNG suy từ tier)
  qualityStatus: OrderAovStatus | null
  qualityStatusLabel: string | null
  // Tier progress (28/07): tiers ĐÃ SORT theo tier_order kèm target/remaining/
  // reached — nguồn duy nhất cho cột động desktop (Super ↔ SM cùng công thức).
  tierProgress: TierProgress[]
}

export interface CampaignResultModel {
  campaign: ResultCampaign
  showBreakdown: boolean          // CHỈ khi campaign bật CẢ 2 chỉ số (P3-E)
  // 107: "Phân loại" là TÙY CHỌN. Nếu MỌI store của campaign đều trống thì cột
  // biến mất hoàn toàn (cả <th> lẫn <td>). Quyết định nằm Ở ĐÂY, một nguồn duy
  // nhất cho header và body — tách hai nơi là lệch cột ngay lần đầu ai đó sửa
  // một phía (đúng lỗi đã xảy ra khi bỏ cột 'Nhịp độ' ở commit 5).
  showGroup: boolean
  lastSyncedAt: string | null     // null = chưa đồng bộ → mọi số tiền hiện '—'
  storeCount: number
  totalTarget: number
  totalActual: number
  totalOffline: number
  totalAffiliate: number
  // 105: tổng số đơn Offline + AOV WEIGHTED toàn phạm vi (totalOffline /
  // totalOfflineOrders — TUYỆT ĐỐI không average AOV từng store: đo thật
  // 08/2026 lệch 1.445đ). null khi CHỈ CẦN MỘT store thiếu count (tử số đủ /
  // mẫu số thiếu ⇒ AOV tổng sai có hệ thống) → fail-visible '—'.
  totalOfflineOrders: number | null
  totalOfflineAov: number | null
  // Mig 106: "X/Y cửa hàng đạt" — Y = storeCount. Đếm theo KPI pass, TUYỆT ĐỐI
  // không theo achieved_tier_order (bậc 1 có thể ở 90% ⇒ đạt bậc ≠ đạt KPI).
  qualityPassCount: number
  completionPct: number           // totalActual/totalTarget×100 (target 0 → 0)
  totalCommission: number
  reachedStoreCount: number
  performance: number | null      // nhịp độ toàn phạm vi; null khi chưa sync
  deadlineLabel: string           // Tạm dừng / Đã kết thúc / Còn N ngày
  rows: StoreResultRow[]
  maxTierCount: number            // số cột Bậc động trên desktop (max theo store)
}

export function buildCampaignResultModel(
  campaign: ResultCampaign,
  targets: ResultTargetRow[],
  actuals: ResultActualRow[],
  todayISO: string,
): CampaignResultModel {
  const actualByStore = new Map(actuals.map((a) => [a.store_id, a]))
  const lastSyncedAt = actuals.reduce<string | null>(
    (max, a) => (!max || a.synced_at > max ? a.synced_at : max), null)

  // Thời hạn: paused → Tạm dừng; quá end/ended → Đã kết thúc; else Còn N ngày
  // (tính cả hôm nay).
  const daysLeft = Math.floor((Date.parse(campaign.end_date) - Date.parse(todayISO)) / 86400_000) + 1
  const deadlineLabel = campaign.status === 'paused'
    ? 'Tạm dừng'
    : (campaign.status === 'ended' || daysLeft <= 0) ? 'Đã kết thúc' : `Còn ${daysLeft} ngày`

  const totalTarget = targets.reduce((sum, t) => sum + (Number(t.kpi_target) || 0), 0)
  const totalActual = actuals.reduce((sum, a) => sum + (Number(a.actual_value) || 0), 0)
  const totalOffline = actuals.reduce((sum, a) => sum + (Number(a.actual_offline) || 0), 0)
  const totalAffiliate = actuals.reduce((sum, a) => sum + (Number(a.actual_affiliate) || 0), 0)
  // 105 r1.1 (audit P2): completeness tính theo TẬP TARGET, KHÔNG theo
  // actuals.length — 2 target mà chỉ 1 có actual thì `actuals.every(...)` vẫn
  // true và dashboard hiện tổng đơn/AOV của riêng store đó như thể toàn
  // campaign đã đủ dữ liệu. Tổng cũng reduce qua targets → actualByStore để
  // đúng phạm vi hiển thị (bỏ qua actual lạc ngoài targets nếu có).
  const allHaveOrderCount = targets.length > 0
    && targets.every((t) => actualByStore.get(t.store_id)?.offline_order_count != null)
  const totalOfflineOrders = allHaveOrderCount
    ? targets.reduce((sum, t) => sum + (Number(actualByStore.get(t.store_id)?.offline_order_count) || 0), 0)
    : null
  // AOV phải lấy TỬ SỐ cùng phạm vi với mẫu số (targets) — dùng totalOffline
  // toàn cục trong khi số đơn chỉ tính targets sẽ cho AOV cao giả nếu tồn tại
  // actual lạc ngoài targets. `totalOffline` (card GMV Offline) giữ NGUYÊN
  // định nghĩa cũ để không đổi số đang chạy.
  const offlineInTargets = targets.reduce(
    (sum, t) => sum + (Number(actualByStore.get(t.store_id)?.actual_offline) || 0), 0)
  const totalOfflineAov = totalOfflineOrders !== null && totalOfflineOrders > 0
    ? offlineInTargets / totalOfflineOrders
    : null
  const completionPct = totalTarget > 0 ? (totalActual / totalTarget) * 100 : 0
  const totalCommission = actuals.reduce((sum, a) => sum + (Number(a.store_commission_pool) || 0), 0)
  const reachedStoreCount = actuals.filter((a) => a.achieved_tier_order !== null).length
  const performance = lastSyncedAt
    ? campaignPerformance(totalTarget, totalActual, campaign.start_date, campaign.end_date, todayISO)
    : null

  const rows: StoreResultRow[] = targets.map((t) => {
    const a = actualByStore.get(t.store_id) ?? null
    return {
      targetId: t.id,
      storeId: t.store_id,
      storeName: t.stores?.name ?? null,
      posCode: t.pos_code,
      group: t.store_kpi_group,
      kpiTarget: Number(t.kpi_target) || 0,
      actual: a,
      performance: campaignPerformance(
        t.kpi_target, a?.actual_value ?? null, campaign.start_date, campaign.end_date, todayISO),
      offlineOrderCount: a?.offline_order_count ?? null,
      ...buildQualityFields(t, a),
      offlineAov: a?.offline_order_count != null && a.offline_order_count > 0
        ? (Number(a.actual_offline) || 0) / a.offline_order_count
        : null,
      requiredPerDay: requiredPerDay({
        kpiTarget: Number(t.kpi_target) || 0,
        actual: a?.actual_value ?? null,
        // r1.1 (audit P1): ưu tiên remaining_target của engine — cùng nguồn
        // với hero Staff, tránh lệch số trên màn tiền.
        remainingTarget: a?.remaining_target ?? null,
        endISO: campaign.end_date,
        todayISO,
      }),
      tierProgress: buildTierProgress(
        Number(t.kpi_target) || 0,
        a ? { actual_value: Number(a.actual_value) || 0, achieved_tier_order: a.achieved_tier_order } : null,
        t.kpi_campaign_store_tiers ?? [],
      ),
    }
  })

  return {
    campaign,
    showBreakdown: campaign.metric_offline === true && campaign.metric_affiliate === true,
    showGroup: rows.some((r) => (r.group ?? '').trim().length > 0),
    lastSyncedAt,
    storeCount: targets.length,
    totalTarget, totalActual, totalOffline, totalAffiliate,
    totalOfflineOrders, totalOfflineAov,
    qualityPassCount: rows.filter((r) => r.qualityKpiPass).length,
    completionPct, totalCommission, reachedStoreCount, performance, deadlineLabel,
    rows,
    maxTierCount: rows.reduce((max, r) => Math.max(max, r.tierProgress.length), 0),
  }
}

// r3 (error boundary) + r6 (handoff 27/07 — BỎ filter ?store=): trạng thái
// scope của SM khi vào dashboard qua URL — campaign ngoài phạm vi → forbidden,
// TUYỆT ĐỐI không fallback sang campaign khác. Dashboard LUÔN tổng hợp toàn bộ
// store thuộc campaign ∩ phạm vi SM (URL cũ mang ?store= được page redirect
// canonicalize về chỉ còn ?campaign=).
export type SmScopeState = 'ok' | 'campaign-out-of-scope'
export function smScopeState(campaignInScope: boolean): SmScopeState {
  return campaignInScope ? 'ok' : 'campaign-out-of-scope'
}
