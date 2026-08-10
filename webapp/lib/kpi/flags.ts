import 'server-only'

// Feature gate for the KPI Campaign module (Phase 1, build-time safety). Read
// server-side only; the Sidebar (client) receives the value as a prop from the
// dashboard layout (no NEXT_PUBLIC_ var needed). Keep OFF in production until QA.
export function isKpiCampaignEnabled(): boolean {
  return process.env.KPI_CAMPAIGN_ENABLED === 'true'
}

// When on, newly created campaigns default to is_test=true (extra isolation from
// Staff/Store Manager during QA).
export function isKpiCampaignTestMode(): boolean {
  return process.env.KPI_CAMPAIGN_TEST_MODE === 'true'
}

// GMV Affiliate metric trong KPI Campaign (plan v1.1 22/07). OFF = checkbox
// "GMV Affiliate" ẩn khỏi wizard → deploy code an toàn TRƯỚC khi chạy migration
// 092 + backfill affiliate_orders (rollout bước 1). Chỉ bật sau khi backfill +
// đối soát pass. Server-only; truyền xuống client qua prop như KPI_CAMPAIGN.
export function isKpiAffiliateEnabled(): boolean {
  return process.env.KPI_AFFILIATE_ENABLED === 'true'
}

// Metric "Số khách Affiliate" (metric_type='affiliate_customer_count', mig
// 103 — handoff 06/08). OFF = option ẩn khỏi wizard + engine preserve + tạo
// campaign customer bị từ chối → deploy schema/code TRƯỚC, bật SAU khi
// backfill identity (customer_phone_norm, mig 104) + đối soát pass. GATE DUY
// NHẤT của campaign customer —
// ĐỘC LẬP với KPI_AFFILIATE_ENABLED (flag đó chỉ gate chỉ số GMV Affiliate
// trong campaign GMV; test khóa 2 chiều). Server-only, truyền prop như trên.
export function isKpiAffiliateCustomerEnabled(): boolean {
  return process.env.KPI_AFFILIATE_CUSTOMER_ENABLED === 'true'
}
