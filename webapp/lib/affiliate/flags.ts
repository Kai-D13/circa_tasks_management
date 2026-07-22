import 'server-only'

// Two INDEPENDENT feature gates (stakeholder audit P2): turning Affiliate off
// must never re-enable Referral, and vice versa. Server-side only — client
// components receive the values as props from the dashboard layout (no
// NEXT_PUBLIC_ vars). Both default OFF: a deploy with neither env set hides
// Referral (program has ended) and keeps Affiliate dark until backfill +
// đối soát are done (rollout plan F5).

// Affiliate program — UI surfaces (sidebar, /affiliate, AffiliateOrdersCard).
export function isAffiliateEnabled(): boolean {
  return process.env.AFFILIATE_ENABLED === 'true'
}

// Affiliate SYNC (cron pull-affiliate-orders) — tách khỏi AFFILIATE_ENABLED
// có chủ đích: trình tự rollout F5 đã duyệt là "deploy UI tắt → chạy backfill
// → đối soát → bật UI". Nếu cron gate bằng AFFILIATE_ENABLED thì không thể
// backfill khi UI còn tối. Nêu rõ cho stakeholder audit F2.
export function isAffiliateSyncEnabled(): boolean {
  return process.env.AFFILIATE_SYNC_ENABLED === 'true'
}

// Legacy "Giới thiệu bạn bè" — program has STOPPED. The flag gates every entry
// point (page, staff card, upload action, pull-referrals cron), not just nav.
// Data/tables/parser stay intact so it can be re-enabled without a migration.
export function isReferralEnabled(): boolean {
  return process.env.REFERRAL_ENABLED === 'true'
}
