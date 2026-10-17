'use client'

import { usePathname } from 'next/navigation'
import { campaignsLoadingKind } from '@/lib/kpi/campaignList'
import { CampaignDetailSkeleton, CampaignListSkeleton } from '@/components/kpi/CampaignRouteSkeletons'
import { AffiliateOverviewSkeleton } from '@/components/affiliate/AffiliateOverviewSkeleton'

// Khung chờ theo pathname cho ranh giới CẤP CAO (targets/loading.tsx, campaigns/loading.tsx) — lối vào từ ngoài
// segment. Affiliate (K-4): lối vào sidebar của admin phòng ban. Đường dẫn ngoài bảng (new, /targets) ⇒ `fallback`.
export function CampaignsRouteLoading({ fallback }: { fallback: React.ReactNode }) {
  const kind = campaignsLoadingKind(usePathname())
  if (kind === 'detail') return <CampaignDetailSkeleton />
  if (kind === 'list') return <CampaignListSkeleton />
  if (kind === 'affiliate') return <AffiliateOverviewSkeleton />
  return <>{fallback}</>
}
