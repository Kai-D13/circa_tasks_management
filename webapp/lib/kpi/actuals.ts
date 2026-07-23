import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { campaignDailyQuery, loadServiceAccount, runBigQuery } from '@/lib/targets/bigquery'
import { getAffiliateSyncHealth, supabaseAffiliateHealthDb } from '@/lib/affiliate/health'
import {
  syncCampaignWithDeps,
  type SyncCampaignDeps, type SyncCampaignResult,
} from '@/lib/kpi/syncCampaignCore'
import type { TargetRow } from '@/lib/kpi/engine'

// P3-B r1 — actuals.ts giờ CHỈ dựng real dependencies (IO) và ủy quyền cho
// orchestrator thuần syncCampaignWithDeps (lib/kpi/syncCampaignCore.ts — nơi
// chứa toàn bộ luồng 3 nhánh + rule audit, unit-test bằng mock deps).
// Caller (cron + manual action) dùng chung syncCampaign(campaignId).

export type { SyncCampaignResult }

function realDeps(): SyncCampaignDeps {
  return {
    loadCampaign: async (id) => {
      const { data, error } = await supabaseAdmin
        .from('kpi_campaigns')
        .select('id, start_date, end_date, metric_offline, metric_affiliate')
        .eq('id', id)
        .maybeSingle()
      return { data, error }
    },
    loadTargets: async (id) => {
      const { data, error } = await supabaseAdmin
        .from('kpi_campaign_store_targets')
        .select('store_id, pos_code, kpi_target, kpi_campaign_store_tiers(tier_order, threshold_pct, commission_amount)')
        .eq('campaign_id', id)
      if (error) return { data: null, error }
      const rows: TargetRow[] = (data ?? []).map((t) => ({
        store_id: t.store_id as string,
        pos_code: (t.pos_code as string | null) ?? null,
        kpi_target: Number(t.kpi_target) || 0,
        tiers: (t.kpi_campaign_store_tiers ?? []) as TargetRow['tiers'],
      }))
      return { data: rows, error: null }
    },
    loadStores: async (storeIds) => {
      const { data, error } = await supabaseAdmin
        .from('stores').select('id, code, store_type, is_active').in('id', storeIds)
      return { data, error }
    },
    getAffiliateHealth: (storeIds) =>
      getAffiliateSyncHealth(supabaseAffiliateHealthDb(supabaseAdmin), storeIds),
    aggregateAffiliate: async (storeIds, from, to) => {
      const { data, error } = await supabaseAdmin
        .rpc('rpc_aggregate_affiliate_gmv', { p_store_ids: storeIds, p_from: from, p_to: to })
      return { data, error }
    },
    loadBqServiceAccount: () => loadServiceAccount(),
    runBqChunk: (sa, chunkStart, chunkEnd) =>
      runBigQuery(sa as Parameters<typeof runBigQuery>[0], campaignDailyQuery(chunkStart, chunkEnd)),
    replaceActuals: async (campaignId, daily, actuals) => {
      const { data, error } = await supabaseAdmin.rpc('rpc_replace_campaign_actuals', {
        p_campaign_id: campaignId,
        p_daily: daily,
        p_actuals: actuals,
      })
      return { data: data as number | null, error }
    },
    nowMs: () => Date.now(),
  }
}

export async function syncCampaign(campaignId: string): Promise<SyncCampaignResult> {
  return syncCampaignWithDeps(campaignId, realDeps())
}
