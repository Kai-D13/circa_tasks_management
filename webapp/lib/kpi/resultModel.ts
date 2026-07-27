// SM Dashboard r1 (stakeholder 27/07) — RESULT MODEL dùng chung Super Admin ↔
// SM: một nguồn công thức duy nhất cho màn Kết quả campaign (màn tiền — hai
// giao diện không bao giờ được lệch số). THUẦN: không import component/DB;
// công thức COPY NGUYÊN VĂN từ tab Kết quả của super
// (targets/campaigns/[id]/page.tsx trước refactor) — test khóa.
//
// Cùng input → cùng output ở mọi role; SM đưa vào tập rows RLS-scoped (chỉ
// store được phân công) → totals tự là tổng đúng phạm vi SM.

import { campaignPerformance } from '@/lib/kpi/performance'

export interface ResultTierRow { tier_order: number; threshold_pct: number; commission_amount: number }

export interface ResultTargetRow {
  id: string
  store_id: string
  pos_code: string | null
  kpi_target: number
  store_kpi_group: string | null
  stores: { name: string } | null
  kpi_campaign_store_tiers: ResultTierRow[]
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
}

export interface CampaignResultModel {
  campaign: ResultCampaign
  showBreakdown: boolean          // CHỈ khi campaign bật CẢ 2 chỉ số (P3-E)
  lastSyncedAt: string | null     // null = chưa đồng bộ → mọi số tiền hiện '—'
  storeCount: number
  totalTarget: number
  totalActual: number
  totalOffline: number
  totalAffiliate: number
  completionPct: number           // totalActual/totalTarget×100 (target 0 → 0)
  totalCommission: number
  reachedStoreCount: number
  performance: number | null      // nhịp độ toàn phạm vi; null khi chưa sync
  deadlineLabel: string           // Tạm dừng / Đã kết thúc / Còn N ngày
  rows: StoreResultRow[]
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
    }
  })

  return {
    campaign,
    showBreakdown: campaign.metric_offline === true && campaign.metric_affiliate === true,
    lastSyncedAt,
    storeCount: targets.length,
    totalTarget, totalActual, totalOffline, totalAffiliate,
    completionPct, totalCommission, reachedStoreCount, performance, deadlineLabel,
    rows,
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
