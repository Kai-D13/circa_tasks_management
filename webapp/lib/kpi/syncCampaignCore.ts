// P3-B r1 — Orchestrator KPI hai nguồn dạng DEPENDENCY INJECTION (audit 23/07:
// module thưởng không được chỉ dựa code-inspection — mọi side-effect phải có
// test đếm số lần gọi). File này THUẦN (không server-only, không import
// supabaseAdmin/BQ) → unit test import được; actuals.ts dựng real deps.
// Return contract: success | snapshot_preserved (giữ số cũ + lý do) | failed.

import type { AffiliateSyncHealth } from '@/lib/affiliate/health'
import {
  buildCampaignSnapshot, effectiveEndISO, monthChunks, vnDayRange, vnTodayISO,
  type ActualRowPayload, type DailyRowPayload, type TargetRow,
} from '@/lib/kpi/engine'

export type SyncCampaignResult =
  | { status: 'success'; campaignId: string; upserted: number; dailyRows: number; unmatched: string[] }
  | { status: 'snapshot_preserved'; campaignId: string; reason: string }
  | { status: 'failed'; campaignId: string; error: string }

export interface CampaignConfig {
  id: string
  start_date: string
  end_date: string
  metric_offline: boolean
  metric_affiliate: boolean
}

export interface StoreRow { id: string; code: string | null; store_type: string; is_active: boolean }
export interface AffiliateAggRow { store_id: string; vn_date: string; gmv: number }
type DbResult<T> = { data: T | null; error: { message: string } | null }

export interface SyncCampaignDeps {
  loadCampaign(campaignId: string): Promise<DbResult<CampaignConfig>>
  loadTargets(campaignId: string): Promise<DbResult<TargetRow[]>>
  loadStores(storeIds: string[]): Promise<DbResult<StoreRow[]>>
  getAffiliateHealth(storeIds: string[]): Promise<AffiliateSyncHealth>
  aggregateAffiliate(storeIds: string[], from: string, to: string): Promise<DbResult<AffiliateAggRow[]>>
  loadBqServiceAccount(): unknown | null
  runBqChunk(sa: unknown, chunkStart: string, chunkEnd: string): Promise<Record<string, unknown>[]>
  replaceActuals(campaignId: string, daily: DailyRowPayload[], actuals: ActualRowPayload[]): Promise<DbResult<number>>
  nowMs(): number
  // r1.2 (audit P1 flag boundary): trạng thái KPI_AFFILIATE_ENABLED — campaign
  // có metric_affiliate khi flag TẮT không được vận hành (kể cả hybrid).
  isAffiliateFeatureEnabled(): boolean
}

export async function syncCampaignWithDeps(
  campaignId: string,
  deps: SyncCampaignDeps,
): Promise<SyncCampaignResult> {
  const failed = (error: string): SyncCampaignResult => ({ status: 'failed', campaignId, error })
  const preserved = (reason: string): SyncCampaignResult => ({ status: 'snapshot_preserved', campaignId, reason })

  // ── Cấu hình campaign chuẩn từ DB (audit #1-2) ──
  const { data: c, error: cErr } = await deps.loadCampaign(campaignId)
  if (cErr) return failed(`Không đọc được campaign: ${cErr.message}`)
  if (!c) return failed('Campaign không tồn tại')
  const metricOffline = c.metric_offline === true
  const metricAffiliate = c.metric_affiliate === true
  // r1.1 (audit P2): DB đã CHECK ≥1 metric nhưng orchestrator vẫn fail-closed —
  // không bao giờ dựng payload zero/gọi replace ở trạng thái này.
  if (!metricOffline && !metricAffiliate) {
    return failed('Campaign không bật chỉ số doanh số nào (metric_offline + metric_affiliate đều tắt)')
  }
  // r1.2 (audit P1): flag KPI_AFFILIATE_ENABLED tắt → campaign có affiliate
  // (kể cả HYBRID) không vận hành — giữ TOÀN BỘ snapshot, không load targets,
  // không health/BQ/replace, không ghi partial offline gây lệch nhất quán.
  // Offline-only không bị ảnh hưởng.
  if (metricAffiliate && !deps.isAffiliateFeatureEnabled()) {
    return preserved('KPI_AFFILIATE_ENABLED đang tắt — campaign có chỉ số affiliate không vận hành, giữ snapshot cũ')
  }

  const { data: targets, error: tErr } = await deps.loadTargets(campaignId)
  if (tErr) return failed(`Không đọc được targets: ${tErr.message}`)
  if (!targets || targets.length === 0) {
    // Không target → KHÔNG ghi (replace-all payload rỗng sẽ xóa snapshot cũ).
    return preserved('campaign chưa có target — không ghi dữ liệu')
  }
  const storeIds = targets.map((t) => t.store_id)

  const todayVn = vnTodayISO(deps.nowMs())
  const effEnd = effectiveEndISO(c.end_date, todayVn)
  const rangeValid = c.start_date <= effEnd

  // ── Nhánh Affiliate: validate OS-active → HEALTH GATE (trước BQ, audit #6-7)
  //    → aggregate trong DB ──
  const affiliateByStore = new Map<string, Map<string, number>>()
  let affiliateSyncedAt: string | null = null
  if (metricAffiliate) {
    const { data: stores, error: sErr } = await deps.loadStores(storeIds)
    if (sErr) return failed(`Không đọc được stores để validate targets: ${sErr.message}`)
    const byId = new Map((stores ?? []).map((s) => [s.id, s]))
    const badTargets = targets.filter((t) => {
      const s = byId.get(t.store_id)
      return !s || s.store_type !== 'os' || s.is_active !== true
    })
    if (badTargets.length > 0) {
      return preserved(`target không phải OS store active: ${badTargets.map((t) => t.pos_code ?? t.store_id).join(', ')} — không aggregate affiliate`)
    }

    // r1.1 (audit P1 — race giữa cron affiliate và KPI aggregate): DOUBLE-CHECK
    //   healthBefore READY (runId=A) → aggregate → healthAfter READY & runId==A
    // Aggregate RPC là 1 statement (MVCC snapshot nhất quán); nếu một phiên sync
    // bắt đầu/kết thúc TRONG lúc aggregate thì healthAfter sẽ lộ (running/failed
    // hoặc runId đổi) → giữ snapshot cũ, không đụng BigQuery/replace.
    const healthBefore = await deps.getAffiliateHealth(storeIds)
    if (!healthBefore.ready) return preserved(`nguồn affiliate chưa sẵn sàng: ${healthBefore.reason}`)
    affiliateSyncedAt = healthBefore.lastSuccessAt

    if (rangeValid) {
      const { from, to } = vnDayRange(c.start_date, effEnd)
      const { data: aggRows, error: aggErr } = await deps.aggregateAffiliate(storeIds, from, to)
      if (aggErr) return preserved(`rpc_aggregate_affiliate_gmv lỗi: ${aggErr.message}`)
      for (const r of aggRows ?? []) {
        if (!affiliateByStore.has(r.store_id)) affiliateByStore.set(r.store_id, new Map())
        affiliateByStore.get(r.store_id)!.set(String(r.vn_date).slice(0, 10), Number(r.gmv) || 0)
      }

      const healthAfter = await deps.getAffiliateHealth(storeIds)
      if (!healthAfter.ready) {
        return preserved(`nguồn affiliate đổi trạng thái trong lúc aggregate: ${healthAfter.reason}`)
      }
      if (healthAfter.runId !== healthBefore.runId) {
        return preserved(`sync affiliate mới bắt đầu trong lúc aggregate (runId ${healthBefore.runId} → ${healthAfter.runId}) — dữ liệu vừa đọc có thể trộn 2 phiên, thử lại lượt sau`)
      }
    }
  }

  // ── Nhánh Offline: BigQuery — CHỈ khi metric bật (affiliate-only tuyệt đối
  //    không đụng credential, audit #5) ──
  const offlineByPos = new Map<string, Map<string, number>>()
  let offlineSyncedAt: string | null = null
  if (metricOffline) {
    const sa = deps.loadBqServiceAccount()
    if (!sa) return failed('Chưa cấu hình BigQuery key cho môi trường này. Kiểm tra BQ_SERVICE_ACCOUNT_KEY rồi thử lại.')
    if (rangeValid) {
      for (const [chunkStart, chunkEnd] of monthChunks(c.start_date, effEnd)) {
        let rows: Record<string, unknown>[]
        try {
          rows = await deps.runBqChunk(sa, chunkStart, chunkEnd)
        } catch (err) {
          // Nguồn BQ trục trặc → giữ snapshot cũ, không partial (QA gate).
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
    offlineSyncedAt = new Date(deps.nowMs()).toISOString()
  }

  // ── Payload (pure) + ghi atomic ĐÚNG MỘT LẦN (audit #13-14) ──
  const snapshotTs = new Date(deps.nowMs()).toISOString()
  const { daily, actuals, unmatchedPos } = buildCampaignSnapshot({
    campaignId,
    targets,
    metricOffline,
    metricAffiliate,
    offlineByPos,
    affiliateByStore,
    snapshotTs,
    offlineSyncedAt,
    affiliateSyncedAt,
  })

  const { data: count, error: rpcErr } = await deps.replaceActuals(campaignId, daily, actuals)
  if (rpcErr) return failed(`Ghi actuals lỗi: ${rpcErr.message}`)

  return {
    status: 'success',
    campaignId,
    upserted: count ?? actuals.length,
    dailyRows: daily.length,
    unmatched: unmatchedPos,
  }
}
