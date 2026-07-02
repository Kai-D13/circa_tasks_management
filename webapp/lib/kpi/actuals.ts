import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { campaignRangeQuery, loadServiceAccount, runBigQuery } from '@/lib/targets/bigquery'

// KPI Campaign actual-GMV sync. For one campaign: pull SUM(gmv) per pos_code over
// [start_date, end_date] from BigQuery, join to the campaign's store targets, and
// snapshot everything the display needs into kpi_campaign_store_actuals:
//   actual_gmv, run_rate = actual/final_target*100,
//   remaining_target = max(target-actual, 0),
//   achieved tier = HIGHEST tier with threshold_pct <= run_rate (not cumulative),
//   achieved_commission_amount = that tier's fixed amount.
// Shared by the 2h cron (/api/cron/sync-kpi-campaign-actuals) and the super-admin
// "Đồng bộ ngay" action. Service-role writes (no write RLS on the table).

interface CampaignRef { id: string; start_date: string; end_date: string }

export interface SyncResult { upserted: number; unmatched: string[] }

export async function syncCampaign(campaign: CampaignRef): Promise<SyncResult | { error: string }> {
  const sa = loadServiceAccount()
  if (!sa) return { error: 'BQ_SERVICE_ACCOUNT_KEY chưa hợp lệ' }

  // Targets + tiers of this campaign (tiers needed to grade the achieved tier).
  const { data: targets, error: tErr } = await supabaseAdmin
    .from('kpi_campaign_store_targets')
    .select('store_id, pos_code, final_target, kpi_campaign_store_tiers(tier_order, threshold_pct, commission_amount)')
    .eq('campaign_id', campaign.id)
  if (tErr) return { error: `Không đọc được targets: ${tErr.message}` }
  if (!targets || targets.length === 0) return { upserted: 0, unmatched: [] }

  let bqRows: Record<string, unknown>[]
  try {
    bqRows = await runBigQuery(sa, campaignRangeQuery(campaign.start_date, campaign.end_date))
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  const actualByPos = new Map<string, { gmv: number; rows: number }>()
  for (const r of bqRows) {
    const pos = String(r.pos_code ?? '').trim().toUpperCase()
    if (!pos) continue
    actualByPos.set(pos, { gmv: Number(r.actual_gmv ?? 0) || 0, rows: Number(r.row_count ?? 0) || 0 })
  }

  const syncedAt = new Date().toISOString()
  const unmatched: string[] = []
  const payload = targets.map((t) => {
    const pos = String(t.pos_code ?? '').trim().toUpperCase()
    const hit = pos ? actualByPos.get(pos) : undefined
    if (pos && !hit) unmatched.push(pos) // store has a target but no BQ rows yet
    const actual = hit?.gmv ?? 0
    const target = Number(t.final_target) || 0
    const runRate = target > 0 ? Math.round((actual / target) * 100 * 100) / 100 : null
    const tiers = ((t.kpi_campaign_store_tiers ?? []) as { tier_order: number; threshold_pct: number; commission_amount: number }[])
      .filter((x) => runRate !== null && Number(x.threshold_pct) <= runRate)
      .sort((a, b) => b.tier_order - a.tier_order)
    const achieved = tiers[0] ?? null
    return {
      campaign_id: campaign.id,
      store_id: t.store_id,
      actual_gmv: actual,
      run_rate: runRate,
      remaining_target: Math.max(target - actual, 0),
      achieved_tier_order: achieved?.tier_order ?? null,
      achieved_commission_amount: achieved ? Number(achieved.commission_amount) : null,
      raw_row_count: hit?.rows ?? 0,
      synced_at: syncedAt,
    }
  })

  const { error: upErr } = await supabaseAdmin
    .from('kpi_campaign_store_actuals')
    .upsert(payload, { onConflict: 'campaign_id,store_id' })
  if (upErr) return { error: `Ghi actuals lỗi: ${upErr.message}` }

  return { upserted: payload.length, unmatched }
}
