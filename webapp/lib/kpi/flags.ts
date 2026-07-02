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
