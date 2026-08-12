// P3-B r1 — Orchestrator KPI hai nguồn dạng DEPENDENCY INJECTION (audit 23/07:
// module thưởng không được chỉ dựa code-inspection — mọi side-effect phải có
// test đếm số lần gọi). File này THUẦN (không server-only, không import
// supabaseAdmin/BQ) → unit test import được; actuals.ts dựng real deps.
// Return contract: success | snapshot_preserved (giữ số cũ + lý do) | failed.

import type { AffiliateSyncHealth } from '@/lib/affiliate/health'
import { readOfflineSource } from '@/lib/kpi/offlineSource'
import {
  buildCampaignSnapshot, buildCustomerSnapshot, buildOrderAovSnapshot, effectiveEndISO,
  vnDayRange, vnTodayISO,
  type ActualRowPayload, type DailyRowPayload, type OrderAovActualPayload,
  type OrderAovDailyPayload, type TargetRow,
} from '@/lib/kpi/engine'

export type SyncCampaignResult =
  // warnings (mig 103): bất thường KHÔNG chặn ghi (vd cross-store account) —
  // syncBatch nối vào logLines; manual sync bỏ qua.
  | { status: 'success'; campaignId: string; upserted: number; dailyRows: number; unmatched: string[]; warnings?: string[] }
  | { status: 'snapshot_preserved'; campaignId: string; reason: string }
  | { status: 'failed'; campaignId: string; error: string }

export interface CampaignConfig {
  id: string
  start_date: string
  end_date: string
  // Mig 103: DISCRIMINATOR — branch TRƯỚC khi nhìn 2 boolean (customer
  // campaign có metric_affiliate=true theo contract cột, không được để nhánh
  // GMV-affiliate vận hành nhầm). Giá trị lạ → failed (fail-closed, không đoán).
  metric_type: string
  metric_offline: boolean
  metric_affiliate: boolean
}

export interface StoreRow { id: string; code: string | null; store_type: string; is_active: boolean }
export interface AffiliateAggRow { store_id: string; vn_date: string; gmv: number }
// Kết quả rpc_aggregate_affiliate_customers (jsonb — mig 103): daily rows +
// tổng đối chiếu + diagnostics cross-store trong CÙNG MVCC snapshot.
export interface CustomerAggResult {
  rows: { store_id: string; vn_date: string; customer_count: number }[]
  total_customers: number
  // mig 104: identity = phone → đổi tên field cho đúng ngữ nghĩa; sample là
  // phone ĐÃ MASK trong DB (0905***560) — không log PII đầy đủ.
  cross_store_customer_count: number
  cross_store_sample: string[]
}
type DbResult<T> = { data: T | null; error: { message: string } | null }

export interface SyncCampaignDeps {
  loadCampaign(campaignId: string): Promise<DbResult<CampaignConfig>>
  loadTargets(campaignId: string): Promise<DbResult<TargetRow[]>>
  loadStores(storeIds: string[]): Promise<DbResult<StoreRow[]>>
  getAffiliateHealth(storeIds: string[]): Promise<AffiliateSyncHealth>
  aggregateAffiliate(storeIds: string[], from: string, to: string): Promise<DbResult<AffiliateAggRow[]>>
  // Mig 103: aggregate SỐ KHÁCH — campaign customer KHÔNG đụng BQ deps
  // (test đếm 0 call).
  aggregateAffiliateCustomers(storeIds: string[], from: string, to: string): Promise<DbResult<CustomerAggResult>>
  loadBqServiceAccount(): unknown | null
  runBqChunk(sa: unknown, chunkStart: string, chunkEnd: string): Promise<Record<string, unknown>[]>
  // Mig 106: payload campaign Chất lượng bán hàng có SHAPE RIÊNG (chỉ số thô —
  // RPC tự tính phần còn lại) nên dep nhận union, không ép về ActualRowPayload.
  replaceActuals(
    campaignId: string,
    daily: (DailyRowPayload | OrderAovDailyPayload)[],
    actuals: (ActualRowPayload | OrderAovActualPayload)[],
  ): Promise<DbResult<number>>
  nowMs(): number
  // r1.2 (audit P1 flag boundary): trạng thái KPI_AFFILIATE_ENABLED — campaign
  // có metric_affiliate khi flag TẮT không được vận hành (kể cả hybrid).
  isAffiliateFeatureEnabled(): boolean
  // Mig 103: KPI_AFFILIATE_CUSTOMER_ENABLED — gate DUY NHẤT của campaign
  // customer, ĐỘC LẬP với isAffiliateFeatureEnabled (test khóa 2 chiều).
  isAffiliateCustomerFeatureEnabled(): boolean
  // Mig 106: KPI_ORDER_AOV_CAMPAIGN_ENABLED — gate DUY NHẤT của campaign
  // Chất lượng bán hàng, độc lập 2 flag affiliate ở trên.
  isOrderAovFeatureEnabled(): boolean
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

  // ── Mig 103: DISCRIMINATOR metric_type — branch TRƯỚC mọi check boolean.
  // Giá trị lạ → failed (engine version cũ hơn DB / data hỏng — không đoán);
  // customer → flow riêng, KHÔNG chạm một dòng nào của flow GMV bên dưới.
  if (c.metric_type !== 'gmv' && c.metric_type !== 'affiliate_customer_count'
      && c.metric_type !== 'offline_order_aov') {
    return failed(`metric_type không hỗ trợ: ${c.metric_type} — engine từ chối vận hành (fail-closed)`)
  }
  if (c.metric_type === 'affiliate_customer_count') {
    return syncCustomerCampaign(campaignId, c, deps, failed, preserved)
  }
  // Mig 106: Chất lượng bán hàng — flow BQ-only, KHÔNG chạm nguồn affiliate.
  if (c.metric_type === 'offline_order_aov') {
    return syncOrderAovCampaign(campaignId, c, deps, failed, preserved)
  }

  // ── Từ đây: metric_type='gmv' — flow production GIỮ NGUYÊN TỪNG DÒNG ──
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

  // P3-G (audit 24/07): campaign CHƯA ĐẾN KỲ (start_date > hôm nay VN) →
  // không vận hành: không load targets, không gọi health/Mongo/BigQuery,
  // không ghi snapshot 0đ, không cập nhật timestamp sync. Ngày bắt đầu
  // (start == today) chạy bình thường.
  const todayVn = vnTodayISO(deps.nowMs())
  if (c.start_date > todayVn) {
    return preserved(`campaign chưa đến kỳ (bắt đầu ${c.start_date}, hôm nay ${todayVn}) — không gọi nguồn dữ liệu, giữ snapshot`)
  }

  const { data: targets, error: tErr } = await deps.loadTargets(campaignId)
  if (tErr) return failed(`Không đọc được targets: ${tErr.message}`)
  if (!targets || targets.length === 0) {
    // Không target → KHÔNG ghi (replace-all payload rỗng sẽ xóa snapshot cũ).
    return preserved('campaign chưa có target — không ghi dữ liệu')
  }
  const storeIds = targets.map((t) => t.store_id)

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
  // Nguồn Offline (BigQuery) — CHỈ khi metric bật (affiliate-only tuyệt đối
  // không đụng credential, audit #5). Toàn bộ guard + canary nằm trong
  // readOfflineSource (dùng chung với campaign Chất lượng bán hàng, khác nhau
  // đúng tham số `strict`).
  let offlineByPos = new Map<string, Map<string, number>>()
  // 105: số đơn Offline theo (pos, ngày) — chỉ số PHỤ của campaign GMV.
  let offlineOrdersByPos = new Map<string, Map<string, number>>()
  // Cảnh báo KHÔNG chặn ghi tiền (mirror warnings nhánh customer).
  const offlineWarnings: string[] = []
  let offlineSyncedAt: string | null = null
  if (metricOffline) {
    const sa = deps.loadBqServiceAccount()
    if (!sa) return failed('Chưa cấu hình BigQuery key cho môi trường này. Kiểm tra BQ_SERVICE_ACCOUNT_KEY rồi thử lại.')
    if (rangeValid) {
      const src = await readOfflineSource({
        sa,
        startISO: c.start_date,
        effEndISO: effEnd,
        targetPosCodes: targets.map((t) => t.pos_code),
        // GMV: số đơn/AOV là chỉ số PHỤ → DEGRADE POS lỗi, KHÔNG đóng băng tiền.
        strict: false,
        runBqChunk: deps.runBqChunk,
      })
      if (!src.ok) return preserved(src.reason)
      offlineByPos = src.offlineByPos
      offlineOrdersByPos = src.ordersByPos
      offlineWarnings.push(...src.warnings)
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
    offlineOrdersByPos,
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
    // r1.3: nguồn số đơn hỏng ở vài pos → cảnh báo (KHÔNG chặn ghi tiền).
    ...(offlineWarnings.length > 0 ? { warnings: offlineWarnings } : {}),
  }
}

// ── Mig 103: flow campaign "Số khách Affiliate" — TÁCH RIÊNG hoàn toàn ──────
// Mirror đúng bộ guard của flow GMV (flag → chưa-đến-kỳ → targets → OS-active
// → health before → aggregate → health after + runId) nhưng nguồn DUY NHẤT =
// rpc_aggregate_affiliate_customers; TUYỆT ĐỐI không đụng BQ deps (test đếm
// 0 call). Nguồn stale/identity thiếu/aggregate lỗi → snapshot_preserved.
async function syncCustomerCampaign(
  campaignId: string,
  c: CampaignConfig,
  deps: SyncCampaignDeps,
  failed: (error: string) => SyncCampaignResult,
  preserved: (reason: string) => SyncCampaignResult,
): Promise<SyncCampaignResult> {
  // Gate DUY NHẤT = KPI_AFFILIATE_CUSTOMER_ENABLED (KHÔNG đi qua
  // isAffiliateFeatureEnabled — flag đó gate chỉ số GMV Affiliate; độc lập).
  if (!deps.isAffiliateCustomerFeatureEnabled()) {
    return preserved('KPI_AFFILIATE_CUSTOMER_ENABLED đang tắt — campaign Số khách không vận hành, giữ snapshot cũ')
  }
  // Contract cột (CHECK chk_kpi_campaigns_customer_contract trong DB — engine
  // vẫn fail-closed, không dựng payload ở trạng thái lệch).
  if (c.metric_offline !== false || c.metric_affiliate !== true) {
    return failed('Campaign Số khách sai contract cột (cần metric_offline=false + metric_affiliate=true) — kiểm tra dữ liệu')
  }

  const todayVn = vnTodayISO(deps.nowMs())
  if (c.start_date > todayVn) {
    return preserved(`campaign chưa đến kỳ (bắt đầu ${c.start_date}, hôm nay ${todayVn}) — không gọi nguồn dữ liệu, giữ snapshot`)
  }

  const { data: targets, error: tErr } = await deps.loadTargets(campaignId)
  if (tErr) return failed(`Không đọc được targets: ${tErr.message}`)
  if (!targets || targets.length === 0) {
    return preserved('campaign chưa có target — không ghi dữ liệu')
  }
  const storeIds = targets.map((t) => t.store_id)

  const { data: stores, error: sErr } = await deps.loadStores(storeIds)
  if (sErr) return failed(`Không đọc được stores để validate targets: ${sErr.message}`)
  const byId = new Map((stores ?? []).map((s) => [s.id, s]))
  const badTargets = targets.filter((t) => {
    const s = byId.get(t.store_id)
    return !s || s.store_type !== 'os' || s.is_active !== true
  })
  if (badTargets.length > 0) {
    return preserved(`target không phải OS store active: ${badTargets.map((t) => t.pos_code ?? t.store_id).join(', ')} — không aggregate số khách`)
  }

  // DOUBLE-CHECK health (mirror r1.1 flow GMV): before READY (runId=A) →
  // aggregate → after READY & runId==A; lệch → giữ snapshot, không ghi.
  const healthBefore = await deps.getAffiliateHealth(storeIds)
  if (!healthBefore.ready) return preserved(`nguồn affiliate chưa sẵn sàng: ${healthBefore.reason}`)
  const affiliateSyncedAt = healthBefore.lastSuccessAt

  const effEnd = effectiveEndISO(c.end_date, todayVn)
  const rangeValid = c.start_date <= effEnd
  const customerByStore = new Map<string, Map<string, number>>()
  const warnings: string[] = []
  if (rangeValid) {
    const range = vnDayRange(c.start_date, effEnd)
    const { data: agg, error: aggErr } = await deps.aggregateAffiliateCustomers(storeIds, range.from, range.to)
    if (aggErr) return preserved(`rpc_aggregate_affiliate_customers lỗi: ${aggErr.message}`)
    if (!agg) return preserved('rpc_aggregate_affiliate_customers trả rỗng — giữ snapshot cũ')

    // Đối chiếu nội bộ CÙNG snapshot: SUM(daily) phải = total (RPC dedup
    // DISTINCT ON đảm bảo bằng nhau — lệch nghĩa là nguồn/RPC tự mâu thuẫn).
    let sum = 0
    for (const r of agg.rows) {
      sum += r.customer_count
      if (!customerByStore.has(r.store_id)) customerByStore.set(r.store_id, new Map())
      customerByStore.get(r.store_id)!.set(r.vn_date, r.customer_count)
    }
    if (sum !== agg.total_customers) {
      return preserved(`aggregate số khách tự mâu thuẫn: SUM(daily)=${sum} <> total_customers=${agg.total_customers} — giữ snapshot cũ`)
    }
    if (agg.cross_store_customer_count > 0) {
      // Bất thường dữ liệu (khách mua ở >1 store trong kỳ) — KHÔNG chặn ghi:
      // RPC đã dedup 1 SĐT = 1 khách tại đơn DELIVERED sớm nhất; chỉ cảnh báo.
      warnings.push(`cross_store_customer_count=${agg.cross_store_customer_count} (SĐT khách xuất hiện dưới >1 store — đã dedup theo đơn DELIVERED sớm nhất; sample: ${agg.cross_store_sample.join(', ')})`)
    }

    const healthAfter = await deps.getAffiliateHealth(storeIds)
    if (!healthAfter.ready) {
      return preserved(`nguồn affiliate đổi trạng thái trong lúc aggregate: ${healthAfter.reason}`)
    }
    if (healthAfter.runId !== healthBefore.runId) {
      return preserved(`sync affiliate mới bắt đầu trong lúc aggregate (runId ${healthBefore.runId} → ${healthAfter.runId}) — dữ liệu vừa đọc có thể trộn 2 phiên, thử lại lượt sau`)
    }
  }

  const snapshotTs = new Date(deps.nowMs()).toISOString()
  const { daily, actuals } = buildCustomerSnapshot({
    campaignId, targets, customerByStore, snapshotTs, affiliateSyncedAt,
  })

  const { data: count, error: rpcErr } = await deps.replaceActuals(campaignId, daily, actuals)
  if (rpcErr) return failed(`Ghi actuals lỗi: ${rpcErr.message}`)

  return {
    status: 'success',
    campaignId,
    upserted: count ?? actuals.length,
    dailyRows: daily.length,
    unmatched: [],
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

// ── Mig 106: flow campaign "Chất lượng bán hàng" (offline_order_aov) ────────
// KHÁC BIỆT CỐT LÕI với campaign GMV:
//   · Nguồn DUY NHẤT = BigQuery Offline. KHÔNG gọi affiliate health/aggregate
//     (test đếm 0 call) — loại này không có chỉ số affiliate.
//   · STRICT: số đơn + AOV CHÍNH LÀ KPI ⇒ mọi canary lỗi (thiếu alias, số đơn
//     lẻ/âm, lệch NULL, có doanh thu mà 0 đơn) đều PRESERVE toàn snapshot;
//     tuyệt đối không degrade như campaign GMV.
//   · Payload gửi RPC chỉ có SỐ THÔ (Net Revenue + số đơn, theo ngày và theo
//     kỳ). Điểm/floor/bậc/commission do RPC 106 tự tính — app không gửi.
async function syncOrderAovCampaign(
  campaignId: string,
  c: CampaignConfig,
  deps: SyncCampaignDeps,
  failed: (error: string) => SyncCampaignResult,
  preserved: (reason: string) => SyncCampaignResult,
): Promise<SyncCampaignResult> {
  // Gate DUY NHẤT của loại này (độc lập 2 flag affiliate).
  if (!deps.isOrderAovFeatureEnabled()) {
    return preserved('KPI_ORDER_AOV_CAMPAIGN_ENABLED đang tắt — campaign Chất lượng bán hàng không vận hành, giữ snapshot cũ')
  }
  // Contract cột (CHECK chk_kpi_campaigns_order_aov_contract trong DB — engine
  // vẫn fail-closed, không dựng payload ở trạng thái lệch).
  if (c.metric_offline !== true || c.metric_affiliate !== false) {
    return failed('Campaign Chất lượng bán hàng sai contract cột (cần metric_offline=true + metric_affiliate=false) — kiểm tra dữ liệu')
  }

  const todayVn = vnTodayISO(deps.nowMs())
  if (c.start_date > todayVn) {
    return preserved(`campaign chưa đến kỳ (bắt đầu ${c.start_date}, hôm nay ${todayVn}) — không gọi nguồn dữ liệu, giữ snapshot`)
  }

  const { data: targets, error: tErr } = await deps.loadTargets(campaignId)
  if (tErr) return failed(`Không đọc được targets: ${tErr.message}`)
  if (!targets || targets.length === 0) {
    return preserved('campaign chưa có target — không ghi dữ liệu')
  }

  const sa = deps.loadBqServiceAccount()
  if (!sa) return failed('Chưa cấu hình BigQuery key cho môi trường này. Kiểm tra BQ_SERVICE_ACCOUNT_KEY rồi thử lại.')

  const effEnd = effectiveEndISO(c.end_date, todayVn)
  if (c.start_date > effEnd) {
    // Kỳ chưa có ngày nào hợp lệ → không ghi (giữ snapshot, không tạo 0 đơn giả).
    return preserved(`kỳ chưa có ngày dữ liệu hợp lệ (${c.start_date} → ${effEnd}) — giữ snapshot cũ`)
  }

  const src = await readOfflineSource({
    sa,
    startISO: c.start_date,
    effEndISO: effEnd,
    targetPosCodes: targets.map((t) => t.pos_code),
    // STRICT: số đơn LÀ KPI — canary lỗi = preserve, không degrade.
    strict: true,
    runBqChunk: deps.runBqChunk,
  })
  if (!src.ok) return preserved(src.reason)

  const snapshotTs = new Date(deps.nowMs()).toISOString()
  const built = buildOrderAovSnapshot({
    campaignId,
    targets,
    offlineByPos: src.offlineByPos,
    ordersByPos: src.ordersByPos,
    snapshotTs,
    offlineSyncedAt: snapshotTs,
  })
  if (!built.ok) return preserved(built.reason)

  const { data: count, error: rpcErr } = await deps.replaceActuals(campaignId, built.daily, built.actuals)
  if (rpcErr) return failed(`Ghi actuals lỗi: ${rpcErr.message}`)

  return {
    status: 'success',
    campaignId,
    upserted: count ?? built.actuals.length,
    dailyRows: built.daily.length,
    // unmatched chỉ có nghĩa với campaign GMV (POS có target mà BQ không có
    // row); ở đây thiếu row đã là PRESERVE nên luôn rỗng.
    unmatched: [],
  }
}
