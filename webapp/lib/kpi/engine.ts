// P3-B — KPI engine THUẦN (không IO): dựng daily + aggregate snapshot cho
// campaign từ 2 nguồn Offline (BigQuery, key = pos_code) và Affiliate
// (Supabase, key = store_id). Toàn bộ số học thưởng nằm ở đây để unit-test
// được; actuals.ts chỉ làm IO/orchestration.
// Bất biến (audit P3-B): actual_value = actual_offline + actual_affiliate;
// run_rate/tier/commission/remaining tính trên TỔNG; metric tắt → phần actual
// tương ứng = 0 (khớp validation của rpc_replace_campaign_actuals 092).

export interface TierRow { tier_order: number; threshold_pct: number; commission_amount: number }
export interface TargetRow {
  store_id: string
  pos_code: string | null
  kpi_target: number
  tiers: TierRow[]
}

export interface SnapshotInput {
  campaignId: string
  targets: TargetRow[]
  metricOffline: boolean
  metricAffiliate: boolean
  // ⚠ Contract 30/07: "gmv" offline = Net Revenue (alias giữ nguyên từ
  // campaignDailyQuery — SUM(net_revenue)); công thức/payload không đổi.
  offlineByPos: Map<string, Map<string, number>>     // pos_code → date VN → offline actual (BQ net_revenue)
  affiliateByStore: Map<string, Map<string, number>> // store_id → date VN → gmv (rpc_aggregate)
  snapshotTs: string                                  // thời điểm GHI snapshot
  offlineSyncedAt: string | null                      // thời điểm pull BQ (null nếu metric tắt)
  affiliateSyncedAt: string | null                    // health.lastSuccessAt (null nếu metric tắt)
}

export interface DailyRowPayload {
  campaign_id: string; store_id: string; date: string
  gmv: number; gmv_affiliate: number; synced_at: string
  // Mig 103 (metric Số khách) — OPTIONAL: path GMV KHÔNG set key này (payload
  // GMV giữ nguyên từng byte; RPC coalesce 0). Chỉ buildCustomerSnapshot set.
  affiliate_customer_count?: number
}
export interface ActualRowPayload {
  campaign_id: string; store_id: string
  actual_value: number; actual_offline: number; actual_affiliate: number
  run_rate: number | null; remaining_target: number
  achieved_tier_order: number | null; store_commission_pool: number | null
  // CONTRACT (chốt audit P3-B r1): raw_row_count = SỐ DÒNG DAILY SNAPSHOT SAU
  // MERGE (union ngày của 2 nguồn) — tức "số ngày có dữ liệu" của store, KHÔNG
  // còn là số row BigQuery thuần. Export/UI phải diễn giải theo nghĩa này.
  raw_row_count: number
  offline_synced_at: string | null; affiliate_synced_at: string | null; synced_at: string
  // Mig 103 — OPTIONAL như trên: chỉ campaign customer set.
  actual_customer_count?: number
}

const DAY = 86400_000

export const vnTodayISO = (nowMs: number): string =>
  new Date(nowMs + 7 * 3600_000).toISOString().slice(0, 10)

export const effectiveEndISO = (endDate: string, todayVn: string): string =>
  endDate < todayVn ? endDate : todayVn

export const nextDayISO = (dateISO: string): string =>
  new Date(Date.parse(`${dateISO}T00:00:00Z`) + DAY).toISOString().slice(0, 10)

// Cửa sổ Affiliate theo giờ VN: p_from inclusive 00:00 ngày start, p_to
// EXCLUSIVE 00:00 ngày SAU effectiveEnd (audit P3-B #9).
export const vnDayRange = (startISO: string, effEndISO: string): { from: string; to: string } => ({
  from: `${startISO}T00:00:00+07:00`,
  to: `${nextDayISO(effEndISO)}T00:00:00+07:00`,
})

// Chia [start, end] thành cửa sổ theo tháng lịch (BQ cap 1000 row/query —
// 26 store × 31 ngày ≈ 806/chunk). Giữ nguyên logic đã chạy production.
export function monthChunks(startISO: string, endISO: string): [string, string][] {
  const chunks: [string, string][] = []
  let cursor = Date.parse(`${startISO}T00:00:00Z`)
  const end = Date.parse(`${endISO}T00:00:00Z`)
  while (cursor <= end) {
    const d = new Date(cursor)
    const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
    const chunkEnd = Math.min(monthEnd, end)
    chunks.push([new Date(cursor).toISOString().slice(0, 10), new Date(chunkEnd).toISOString().slice(0, 10)])
    cursor = chunkEnd + DAY
  }
  return chunks
}

// Số học thưởng DÙNG CHUNG cho mọi metric (GMV lẫn Số khách) — trích từ
// buildCampaignSnapshot (refactor thuần, hành vi khóa bởi kpi-engine.spec):
// run_rate làm tròn 2 chữ số; bậc = tier CAO NHẤT có threshold ≤ run_rate;
// remaining = max(target − actual, 0); pool = commission bậc đạt (null nếu chưa).
export function computeTierAchievement(target: number, actualValue: number, tiers: TierRow[]): {
  runRate: number | null
  remainingTarget: number
  achievedTierOrder: number | null
  commissionPool: number | null
} {
  const runRate = target > 0 ? Math.round((actualValue / target) * 100 * 100) / 100 : null
  const achieved = [...tiers]
    .filter((x) => runRate !== null && Number(x.threshold_pct) <= runRate)
    .sort((a, b) => b.tier_order - a.tier_order)[0] ?? null
  return {
    runRate,
    remainingTarget: Math.max(target - actualValue, 0),
    achievedTierOrder: achieved?.tier_order ?? null,
    commissionPool: achieved ? Number(achieved.commission_amount) : null,
  }
}

export function buildCampaignSnapshot(input: SnapshotInput): {
  daily: DailyRowPayload[]
  actuals: ActualRowPayload[]
  unmatchedPos: string[]
} {
  const {
    campaignId, targets, metricOffline, metricAffiliate,
    offlineByPos, affiliateByStore, snapshotTs, offlineSyncedAt, affiliateSyncedAt,
  } = input

  const daily: DailyRowPayload[] = []
  const actuals: ActualRowPayload[] = []
  const unmatchedPos: string[] = []

  for (const t of targets) {
    const pos = (t.pos_code ?? '').trim().toUpperCase()
    // unmatched = có target nhưng BQ không có row nào trong range — CHỈ có
    // nghĩa khi metric Offline bật (giữ nguyên semantics cũ).
    const offDays = metricOffline && pos ? offlineByPos.get(pos) : undefined
    if (metricOffline && pos && !offDays) unmatchedPos.push(pos)
    const affDays = metricAffiliate ? affiliateByStore.get(t.store_id) : undefined

    // Merge theo khóa store_id + date (union 2 nguồn) — audit P3-B #10.
    const dates = new Set<string>([...(offDays?.keys() ?? []), ...(affDays?.keys() ?? [])])
    let actualOffline = 0
    let actualAffiliate = 0
    let rowCount = 0
    for (const date of [...dates].sort()) {
      const off = offDays?.get(date) ?? 0
      const aff = affDays?.get(date) ?? 0
      actualOffline += off
      actualAffiliate += aff
      rowCount++
      daily.push({ campaign_id: campaignId, store_id: t.store_id, date, gmv: off, gmv_affiliate: aff, synced_at: snapshotTs })
    }

    const actualValue = actualOffline + actualAffiliate
    const target = Number(t.kpi_target) || 0
    const ach = computeTierAchievement(target, actualValue, t.tiers)

    actuals.push({
      campaign_id: campaignId,
      store_id: t.store_id,
      actual_value: actualValue,
      actual_offline: actualOffline,
      actual_affiliate: actualAffiliate,
      run_rate: ach.runRate,
      remaining_target: ach.remainingTarget,
      achieved_tier_order: ach.achievedTierOrder,
      store_commission_pool: ach.commissionPool,
      raw_row_count: rowCount,
      offline_synced_at: metricOffline ? offlineSyncedAt : null,
      affiliate_synced_at: metricAffiliate ? affiliateSyncedAt : null,
      synced_at: snapshotTs,
    })
  }

  return { daily, actuals, unmatchedPos }
}

// ── Metric "Số khách Affiliate" (mig 103) — snapshot builder RIÊNG ──────────
// KHÔNG đụng buildCampaignSnapshot (GMV path zero-touch). Nguồn duy nhất =
// rpc_aggregate_affiliate_customers (đã dedup toàn scope trong DB: 1 account
// = 1 khách tại (store, ngày VN) của đơn DELIVERED sớm nhất) → ở đây CHỈ số
// học: actual_value = actual_customer_count = Σ daily count; offline/affiliate
// = 0 (contract 103 — RPC replace validate); tier math dùng chung
// computeTierAchievement (tier % trên SỐ KHÁCH, commission vẫn tiền cố định).
export interface CustomerSnapshotInput {
  campaignId: string
  targets: TargetRow[]
  customerByStore: Map<string, Map<string, number>> // store_id → vn_date → customer_count
  snapshotTs: string
  affiliateSyncedAt: string | null                  // health.lastSuccessAt
}

export function buildCustomerSnapshot(input: CustomerSnapshotInput): {
  daily: DailyRowPayload[]
  actuals: ActualRowPayload[]
} {
  const { campaignId, targets, customerByStore, snapshotTs, affiliateSyncedAt } = input
  const daily: DailyRowPayload[] = []
  const actuals: ActualRowPayload[] = []

  for (const t of targets) {
    const days = customerByStore.get(t.store_id)
    let total = 0
    let rowCount = 0
    for (const date of [...(days?.keys() ?? [])].sort()) {
      const count = days?.get(date) ?? 0
      total += count
      rowCount++
      daily.push({
        campaign_id: campaignId, store_id: t.store_id, date,
        gmv: 0, gmv_affiliate: 0, affiliate_customer_count: count, synced_at: snapshotTs,
      })
    }

    const target = Number(t.kpi_target) || 0
    const ach = computeTierAchievement(target, total, t.tiers)
    actuals.push({
      campaign_id: campaignId,
      store_id: t.store_id,
      actual_value: total,
      actual_offline: 0,
      actual_affiliate: 0,
      actual_customer_count: total,
      run_rate: ach.runRate,
      remaining_target: ach.remainingTarget,
      achieved_tier_order: ach.achievedTierOrder,
      store_commission_pool: ach.commissionPool,
      raw_row_count: rowCount,
      offline_synced_at: null,
      affiliate_synced_at: affiliateSyncedAt,
      synced_at: snapshotTs,
    })
  }

  return { daily, actuals }
}
