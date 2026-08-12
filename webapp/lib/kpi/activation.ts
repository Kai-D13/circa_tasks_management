// P3-D r1 — Đánh giá điều kiện kích hoạt campaign (THUẦN, DI — audit: wiring
// phải có test đếm call, không chỉ helper). App chạy evaluate này TRƯỚC, rồi
// gọi rpc_activate_kpi_campaign (093) — RPC là chốt chặn race trong DB
// (lock row + expected updated_at + expected affiliate run id).
// Offline-only: KHÔNG gọi health/store (không phụ thuộc Mongo). Health throw
// → fail-closed thành lỗi có cấu trúc.

import type { AffiliateSyncHealth } from '@/lib/affiliate/health'
import { activationBlockReason } from '@/lib/kpi/campaignConfig'

export interface ActivationCampaign {
  id: string
  status: string
  updated_at: string
  // Mig 103: discriminator — campaign Số khách gate bằng flag customer RIÊNG;
  // các check OS-active + health dùng chung nhánh metric_affiliate (contract
  // cột customer ép metric_affiliate=true). Overlap check nằm trong RPC 103
  // (+ EXCLUDE constraint backstop) — app không lặp lại.
  metric_type: string
  metric_affiliate: boolean
}
export interface ActivationTarget { store_id: string; pos_code: string | null }
export interface ActivationStore { id: string; code: string | null; store_type: string; is_active: boolean }
type DbResult<T> = { data: T | null; error: { message: string } | null }

export interface ActivationDeps {
  loadCampaign(campaignId: string): Promise<DbResult<ActivationCampaign>>
  loadTargets(campaignId: string): Promise<DbResult<ActivationTarget[]>>
  loadStores(storeIds: string[]): Promise<DbResult<ActivationStore[]>>
  getHealth(storeIds: string[]): Promise<AffiliateSyncHealth>
}

export type ActivationEvaluation =
  | { ok: true; expectedUpdatedAt: string; expectedRunId: string | null }
  | { ok: false; error: string }

export async function evaluateActivation(
  deps: ActivationDeps,
  campaignId: string,
  flags: { affiliate: boolean; customer: boolean; orderAov: boolean },
): Promise<ActivationEvaluation> {
  const fail = (error: string): ActivationEvaluation => ({ ok: false, error })

  const { data: c, error: cErr } = await deps.loadCampaign(campaignId)
  if (cErr) return fail(`Không đọc được chiến dịch: ${cErr.message}`)
  if (!c) return fail('Không tìm thấy chiến dịch')
  if (c.status === 'active') return fail('Chiến dịch đang chạy')
  if (c.status !== 'draft' && c.status !== 'paused') return fail('Chiến dịch đã kết thúc')
  // Mig 103: campaign Số khách — gate flag customer, dừng sớm như nhánh dưới;
  // metric_type lạ → fail-closed (app cũ hơn DB, không đoán).
  if (c.metric_type !== 'gmv' && c.metric_type !== 'affiliate_customer_count'
      && c.metric_type !== 'offline_order_aov') {
    return fail(`Loại chiến dịch không hỗ trợ: ${c.metric_type}`)
  }
  if (c.metric_type === 'affiliate_customer_count' && !flags.customer) {
    return fail('Chiến dịch Số khách Affiliate đang tắt trên hệ thống (KPI_AFFILIATE_CUSTOMER_ENABLED) — không thể kích hoạt')
  }
  // Mig 106: gate riêng của Chất lượng bán hàng (độc lập 2 flag affiliate).
  if (c.metric_type === 'offline_order_aov' && !flags.orderAov) {
    return fail('Chiến dịch Chất lượng bán hàng đang tắt trên hệ thống (KPI_ORDER_AOV_CAMPAIGN_ENABLED) — không thể kích hoạt')
  }
  // r1.2 (audit P1 flag boundary): flag tắt → KHÔNG kích hoạt campaign
  // affiliate — dừng ngay sau load campaign, không load targets/stores/health.
  // (Pause campaign affiliate đang active KHÔNG đi qua hàm này — vẫn pause
  // được để xử lý sự cố.) Mig 103: CHỈ áp cho campaign GMV — customer có
  // metric_affiliate=true theo contract cột nhưng gate bằng flag riêng ở trên.
  if (c.metric_type === 'gmv' && c.metric_affiliate && !flags.affiliate) {
    return fail('Chỉ số GMV Affiliate đang tắt trên hệ thống (KPI_AFFILIATE_ENABLED) — không thể kích hoạt chiến dịch affiliate')
  }

  const { data: targets, error: tErr } = await deps.loadTargets(campaignId)
  if (tErr) return fail(`Không kiểm tra được target: ${tErr.message}`)
  const targetRows = targets ?? []

  let invalidStores: string[] = []
  let health: AffiliateSyncHealth | null = null
  if (c.metric_affiliate && targetRows.length > 0) {
    const storeIds = targetRows.map((t) => t.store_id)
    const { data: stores, error: sErr } = await deps.loadStores(storeIds)
    if (sErr) return fail(`Không kiểm tra được store: ${sErr.message}`)
    const byId = new Map((stores ?? []).map((s) => [s.id, s]))
    invalidStores = targetRows
      .filter((t) => {
        const s = byId.get(t.store_id)
        return !s || s.store_type !== 'os' || s.is_active !== true
      })
      .map((t) => {
        const s = byId.get(t.store_id)
        return `${t.pos_code ?? t.store_id}${!s ? ' (không tồn tại)' : s.store_type !== 'os' ? ` (${s.store_type})` : ' (ngưng hoạt động)'}`
      })
    // Store không hợp lệ → DỪNG trước khi đụng health (không gọi nguồn thừa).
    if (invalidStores.length === 0) {
      try {
        health = await deps.getHealth(storeIds)
      } catch (e) {
        // Health throw = không xác nhận được nguồn → fail-closed (audit r1).
        return fail(`Không kiểm tra được nguồn affiliate: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  const reason = activationBlockReason({
    metricAffiliate: c.metric_affiliate,
    targetCount: targetRows.length,
    invalidStores,
    health,
  })
  if (reason) return { ok: false, error: reason }

  return {
    ok: true,
    expectedUpdatedAt: c.updated_at,
    expectedRunId: c.metric_affiliate ? (health?.runId ?? null) : null,
  }
}
