import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { campaignDailyQuery, loadServiceAccount, runBigQuery } from '@/lib/targets/bigquery'
import { getAffiliateSyncHealth, supabaseAffiliateHealthDb } from '@/lib/affiliate/health'
import {
  buildCampaignSnapshot, effectiveEndISO, monthChunks, vnDayRange, vnTodayISO,
  type TargetRow,
} from '@/lib/kpi/engine'

// P3-B — KPI orchestrator HAI NGUỒN (audit 23/07). Contract mới: caller chỉ
// truyền campaignId; engine tự đọc cấu hình chuẩn từ DB (metric flags, dates,
// targets, tiers) — không nhận metric/date từ caller (audit #1).
// Ba nhánh:
//   • Offline-only  → CHỈ BigQuery, hành vi + số liệu cũ giữ nguyên tuyệt đối.
//   • Affiliate-only→ KHÔNG load BigQuery key; health gate → rpc_aggregate.
//   • Both          → Affiliate health TRƯỚC, rồi mới pull BQ; một nguồn không
//                     sẵn sàng → KHÔNG ghi gì (snapshot_preserved).
// Ghi DUY NHẤT 1 lần qua rpc_replace_campaign_actuals (atomic — 092 validate
// tổng = offline + affiliate, exact target set, daily khớp aggregate).
// Return contract: success | snapshot_preserved (giữ số cũ, kèm lý do) | failed.

export type SyncCampaignResult =
  | { status: 'success'; campaignId: string; upserted: number; dailyRows: number; unmatched: string[] }
  | { status: 'snapshot_preserved'; campaignId: string; reason: string }
  | { status: 'failed'; campaignId: string; error: string }

export async function syncCampaign(campaignId: string): Promise<SyncCampaignResult> {
  const failed = (error: string): SyncCampaignResult => ({ status: 'failed', campaignId, error })
  const preserved = (reason: string): SyncCampaignResult => ({ status: 'snapshot_preserved', campaignId, reason })

  // ── Cấu hình campaign chuẩn từ DB ──
  const { data: c, error: cErr } = await supabaseAdmin
    .from('kpi_campaigns')
    .select('id, start_date, end_date, metric_offline, metric_affiliate')
    .eq('id', campaignId)
    .maybeSingle()
  if (cErr) return failed(`Không đọc được campaign: ${cErr.message}`)
  if (!c) return failed('Campaign không tồn tại')
  const metricOffline = c.metric_offline === true
  const metricAffiliate = c.metric_affiliate === true

  const { data: targets, error: tErr } = await supabaseAdmin
    .from('kpi_campaign_store_targets')
    .select('store_id, pos_code, kpi_target, kpi_campaign_store_tiers(tier_order, threshold_pct, commission_amount)')
    .eq('campaign_id', campaignId)
  if (tErr) return failed(`Không đọc được targets: ${tErr.message}`)
  if (!targets || targets.length === 0) {
    // Không có target → không ghi gì (QA gate: replace-all với payload rỗng sẽ
    // xóa snapshot — tuyệt đối tránh).
    return preserved('campaign chưa có target — không ghi dữ liệu')
  }
  const targetRows: TargetRow[] = targets.map((t) => ({
    store_id: t.store_id as string,
    pos_code: (t.pos_code as string | null) ?? null,
    kpi_target: Number(t.kpi_target) || 0,
    tiers: (t.kpi_campaign_store_tiers ?? []) as TargetRow['tiers'],
  }))
  const storeIds = targetRows.map((t) => t.store_id)

  const todayVn = vnTodayISO(Date.now())
  const effEnd = effectiveEndISO(c.end_date, todayVn)
  const rangeValid = c.start_date <= effEnd

  // ── Nhánh Affiliate: validate targets OS active → health gate → aggregate ──
  const affiliateByStore = new Map<string, Map<string, number>>()
  let affiliateSyncedAt: string | null = null
  if (metricAffiliate) {
    const { data: stores, error: sErr } = await supabaseAdmin
      .from('stores').select('id, code, store_type, is_active').in('id', storeIds)
    if (sErr) return failed(`Không đọc được stores để validate targets: ${sErr.message}`)
    const byId = new Map((stores ?? []).map((s) => [s.id, s]))
    const badTargets = targetRows.filter((t) => {
      const s = byId.get(t.store_id)
      return !s || s.store_type !== 'os' || s.is_active !== true
    })
    if (badTargets.length > 0) {
      return preserved(`target không phải OS store active: ${badTargets.map((t) => t.pos_code ?? t.store_id).join(', ')} — không aggregate affiliate`)
    }

    const health = await getAffiliateSyncHealth(supabaseAffiliateHealthDb(supabaseAdmin), storeIds)
    if (!health.ready) {
      return preserved(`nguồn affiliate chưa sẵn sàng: ${health.reason}`)
    }
    affiliateSyncedAt = health.lastSuccessAt

    if (rangeValid) {
      const { from, to } = vnDayRange(c.start_date, effEnd)
      const { data: aggRows, error: aggErr } = await supabaseAdmin
        .rpc('rpc_aggregate_affiliate_gmv', { p_store_ids: storeIds, p_from: from, p_to: to })
      if (aggErr) return preserved(`rpc_aggregate_affiliate_gmv lỗi: ${aggErr.message}`)
      for (const r of (aggRows ?? []) as { store_id: string; vn_date: string; gmv: number }[]) {
        if (!affiliateByStore.has(r.store_id)) affiliateByStore.set(r.store_id, new Map())
        affiliateByStore.get(r.store_id)!.set(String(r.vn_date).slice(0, 10), Number(r.gmv) || 0)
      }
    }
  }

  // ── Nhánh Offline: BigQuery (CHỈ khi metric bật — affiliate-only không đụng
  //    credential, audit #5) ──
  const offlineByPos = new Map<string, Map<string, number>>()
  let offlineSyncedAt: string | null = null
  if (metricOffline) {
    const sa = loadServiceAccount()
    if (!sa) return failed('Chưa cấu hình BigQuery key cho môi trường này. Kiểm tra BQ_SERVICE_ACCOUNT_KEY rồi thử lại.')
    if (rangeValid) {
      for (const [chunkStart, chunkEnd] of monthChunks(c.start_date, effEnd)) {
        let rows: Record<string, unknown>[]
        try {
          rows = await runBigQuery(sa, campaignDailyQuery(chunkStart, chunkEnd))
        } catch (err) {
          // Nguồn BQ trục trặc → giữ snapshot cũ (QA gate), không ghi partial.
          return preserved(`BigQuery lỗi: ${err instanceof Error ? err.message : String(err)}`)
        }
        for (const r of rows) {
          const pos = String(r.pos_code ?? '').trim().toUpperCase()
          const date = String(r.date ?? '').slice(0, 10)
          if (!pos || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
          if (!offlineByPos.has(pos)) offlineByPos.set(pos, new Map())
          offlineByPos.get(pos)!.set(date, Number(r.gmv ?? 0) || 0)
        }
      }
    }
    offlineSyncedAt = new Date().toISOString()
  }

  // ── Dựng payload (pure) + ghi atomic ĐÚNG MỘT LẦN ──
  const snapshotTs = new Date().toISOString()
  const { daily, actuals, unmatchedPos } = buildCampaignSnapshot({
    campaignId,
    targets: targetRows,
    metricOffline,
    metricAffiliate,
    offlineByPos,
    affiliateByStore,
    snapshotTs,
    offlineSyncedAt,
    affiliateSyncedAt,
  })

  const { data: count, error: rpcErr } = await supabaseAdmin.rpc('rpc_replace_campaign_actuals', {
    p_campaign_id: campaignId,
    p_daily: daily,
    p_actuals: actuals,
  })
  if (rpcErr) return failed(`Ghi actuals lỗi: ${rpcErr.message}`)

  return {
    status: 'success',
    campaignId,
    upserted: (count as number | null) ?? actuals.length,
    dailyRows: daily.length,
    unmatched: unmatchedPos,
  }
}
