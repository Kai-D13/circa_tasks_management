'use client'

import { usePathname } from 'next/navigation'
import { campaignsLoadingKind } from '@/lib/kpi/campaignList'
import { CampaignDetailSkeleton, CampaignListSkeleton } from '@/components/kpi/CampaignRouteSkeletons'

// Khung chờ theo pathname cho ranh giới CẤP CAO (targets/loading.tsx, campaigns/loading.tsx) — lối vào từ ngoài
// segment. Đường dẫn ngoài bảng (new/affiliate — chưa chuyển v2, /targets) ⇒ `fallback` của caller.
export function CampaignsRouteLoading({ fallback }: { fallback: React.ReactNode }) {
  const kind = campaignsLoadingKind(usePathname())
  if (kind === 'detail') return <CampaignDetailSkeleton />
  if (kind === 'list') return <CampaignListSkeleton />
  return <>{fallback}</>
}
