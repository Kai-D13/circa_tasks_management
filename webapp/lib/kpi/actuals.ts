import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { campaignDailyQuery, loadServiceAccount, runBigQuery } from '@/lib/targets/bigquery'

// KPI Campaign actual sync (metric_type='gmv' this phase). ONE BigQuery pull per
// campaign — PER-DAY rows (GROUP BY pos_code, date), chunked by month so a long
// campaign never exceeds runBigQuery's 1000-row cap (26 stores × 31 days ≈ 806
// per chunk). The daily rows feed the staff "Tiến độ theo ngày" chart, and the
// aggregate snapshot is SUMMED FROM THEM app-side, so chart and totals can never
// disagree. Pull range is capped at today (future days carry no realized GMV).
//
// Snapshot per store (kpi_campaign_store_actuals):
//   actual_value = Σ daily gmv, run_rate = actual/kpi_target*100,
//   remaining_target = max(target-actual, 0),
//   achieved tier = HIGHEST tier with threshold_pct <= run_rate (not cumulative),
//   store_commission_pool = that tier's fixed amount (STORE pool, not personal).
// Shared by the 2h cron (/api/cron/sync-kpi-campaign-actuals) and the super-admin
// "Đồng bộ doanh số từ BI" action. Service-role writes.

interface CampaignRef { id: string; start_date: string; end_date: string }

export interface SyncResult { upserted: number; unmatched: string[]; dailyRows: number }

const DAY = 86400_000

// Split [start, end] (ISO dates, inclusive) into calendar-month windows.
function monthChunks(startISO: string, endISO: string): [string, string][] {
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

export async function syncCampaign(campaign: CampaignRef): Promise<SyncResult | { error: string }> {
  const sa = loadServiceAccount()
  if (!sa) return { error: 'Chưa cấu hình BigQuery key cho môi trường này. Kiểm tra BQ_SERVICE_ACCOUNT_KEY rồi thử lại.' }

  // Targets + tiers of this campaign (tiers needed to grade the achieved tier).
  const { data: targets, error: tErr } = await supabaseAdmin
    .from('kpi_campaign_store_targets')
    .select('store_id, pos_code, kpi_target, kpi_campaign_store_tiers(tier_order, threshold_pct, commission_amount)')
    .eq('campaign_id', campaign.id)
  if (tErr) return { error: `Không đọc được targets: ${tErr.message}` }
  if (!targets || targets.length === 0) return { upserted: 0, unmatched: [], dailyRows: 0 }

  // Pull daily gmv per pos over [start, min(end, today)] in month chunks.
  const vnTodayISO = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
  const effectiveEnd = campaign.end_date < vnTodayISO ? campaign.end_date : vnTodayISO
  const dailyByPos = new Map<string, Map<string, number>>() // pos → (date → gmv)
  if (campaign.start_date <= effectiveEnd) {
    for (const [chunkStart, chunkEnd] of monthChunks(campaign.start_date, effectiveEnd)) {
      let rows: Record<string, unknown>[]
      try {
        rows = await runBigQuery(sa, campaignDailyQuery(chunkStart, chunkEnd))
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
      for (const r of rows) {
        const pos = String(r.pos_code ?? '').trim().toUpperCase()
        const date = String(r.date ?? '').slice(0, 10)
        if (!pos || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
        if (!dailyByPos.has(pos)) dailyByPos.set(pos, new Map())
        dailyByPos.get(pos)!.set(date, Number(r.gmv ?? 0) || 0)
      }
    }
  }

  const syncedAt = new Date().toISOString()
  const unmatched: string[] = []
  const dailyPayload: Record<string, unknown>[] = []

  const payload = targets.map((t) => {
    const pos = String(t.pos_code ?? '').trim().toUpperCase()
    const days = pos ? dailyByPos.get(pos) : undefined
    if (pos && !days) unmatched.push(pos) // target exists but zero BQ rows in range
    let actual = 0
    let rowCount = 0
    if (days) {
      for (const [date, gmv] of days) {
        actual += gmv
        rowCount++
        dailyPayload.push({ campaign_id: campaign.id, store_id: t.store_id, date, gmv, synced_at: syncedAt })
      }
    }
    const target = Number(t.kpi_target) || 0
    const runRate = target > 0 ? Math.round((actual / target) * 100 * 100) / 100 : null
    const tiers = ((t.kpi_campaign_store_tiers ?? []) as { tier_order: number; threshold_pct: number; commission_amount: number }[])
      .filter((x) => runRate !== null && Number(x.threshold_pct) <= runRate)
      .sort((a, b) => b.tier_order - a.tier_order)
    const achieved = tiers[0] ?? null
    return {
      campaign_id: campaign.id,
      store_id: t.store_id,
      actual_value: actual,
      run_rate: runRate,
      remaining_target: Math.max(target - actual, 0),
      achieved_tier_order: achieved?.tier_order ?? null,
      store_commission_pool: achieved ? Number(achieved.commission_amount) : null,
      raw_row_count: rowCount,
      synced_at: syncedAt,
    }
  })

  // REPLACE-ALL daily rows for this campaign: BI corrections, a changed date
  // range, or a day that no longer returns from BQ must never leave ghost bars
  // (the chart and the aggregate are not allowed to disagree). Delete carries a
  // WHERE (pg_safeupdate-safe) and runs even when the new payload is EMPTY.
  // Not one transaction with the insert — worst case a failed insert leaves an
  // empty chart until the next sync (error is returned, admin re-syncs).
  const { error: delErr } = await supabaseAdmin
    .from('kpi_campaign_store_daily_actuals')
    .delete()
    .eq('campaign_id', campaign.id)
  if (delErr) return { error: `Xoá daily actuals cũ lỗi: ${delErr.message}` }

  for (let i = 0; i < dailyPayload.length; i += 500) {
    const { error: dErr } = await supabaseAdmin
      .from('kpi_campaign_store_daily_actuals')
      .upsert(dailyPayload.slice(i, i + 500), { onConflict: 'campaign_id,store_id,date' })
    if (dErr) return { error: `Ghi daily actuals lỗi: ${dErr.message}` }
  }

  const { error: upErr } = await supabaseAdmin
    .from('kpi_campaign_store_actuals')
    .upsert(payload, { onConflict: 'campaign_id,store_id' })
  if (upErr) return { error: `Ghi actuals lỗi: ${upErr.message}` }

  return { upserted: payload.length, unmatched, dailyRows: dailyPayload.length }
}
