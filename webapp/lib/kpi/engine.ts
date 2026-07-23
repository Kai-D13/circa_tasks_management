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
  offlineByPos: Map<string, Map<string, number>>     // pos_code → date VN → gmv (BQ)
  affiliateByStore: Map<string, Map<string, number>> // store_id → date VN → gmv (rpc_aggregate)
  snapshotTs: string                                  // thời điểm GHI snapshot
  offlineSyncedAt: string | null                      // thời điểm pull BQ (null nếu metric tắt)
  affiliateSyncedAt: string | null                    // health.lastSuccessAt (null nếu metric tắt)
}

export interface DailyRowPayload {
  campaign_id: string; store_id: string; date: string
  gmv: number; gmv_affiliate: number; synced_at: string
}
export interface ActualRowPayload {
  campaign_id: string; store_id: string
  actual_value: number; actual_offline: number; actual_affiliate: number
  run_rate: number | null; remaining_target: number
  achieved_tier_order: number | null; store_commission_pool: number | null
  raw_row_count: number
  offline_synced_at: string | null; affiliate_synced_at: string | null; synced_at: string
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
    const runRate = target > 0 ? Math.round((actualValue / target) * 100 * 100) / 100 : null
    const achieved = [...t.tiers]
      .filter((x) => runRate !== null && Number(x.threshold_pct) <= runRate)
      .sort((a, b) => b.tier_order - a.tier_order)[0] ?? null

    actuals.push({
      campaign_id: campaignId,
      store_id: t.store_id,
      actual_value: actualValue,
      actual_offline: actualOffline,
      actual_affiliate: actualAffiliate,
      run_rate: runRate,
      remaining_target: Math.max(target - actualValue, 0),
      achieved_tier_order: achieved?.tier_order ?? null,
      store_commission_pool: achieved ? Number(achieved.commission_amount) : null,
      raw_row_count: rowCount,
      offline_synced_at: metricOffline ? offlineSyncedAt : null,
      affiliate_synced_at: metricAffiliate ? affiliateSyncedAt : null,
      synced_at: snapshotTs,
    })
  }

  return { daily, actuals, unmatchedPos }
}
