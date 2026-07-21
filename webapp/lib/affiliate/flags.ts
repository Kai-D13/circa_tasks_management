import 'server-only'

// Two INDEPENDENT feature gates (stakeholder audit P2): turning Affiliate off
// must never re-enable Referral, and vice versa. Server-side only — client
// components receive the values as props from the dashboard layout (no
// NEXT_PUBLIC_ vars). Both default OFF: a deploy with neither env set hides
// Referral (program has ended) and keeps Affiliate dark until backfill +
// đối soát are done (rollout plan F5).

// Affiliate program (orders synced from Circa Online MongoDB).
export function isAffiliateEnabled(): boolean {
  return process.env.AFFILIATE_ENABLED === 'true'
}

// Legacy "Giới thiệu bạn bè" — program has STOPPED. The flag gates every entry
// point (page, staff card, upload action, pull-referrals cron), not just nav.
// Data/tables/parser stay intact so it can be re-enabled without a migration.
export function isReferralEnabled(): boolean {
  return process.env.REFERRAL_ENABLED === 'true'
}
