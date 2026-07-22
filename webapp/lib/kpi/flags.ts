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
