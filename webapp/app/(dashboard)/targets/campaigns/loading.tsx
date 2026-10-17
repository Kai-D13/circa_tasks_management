import { CampaignListSkeleton } from '@/components/kpi/CampaignRouteSkeletons'
import { CampaignsRouteLoading } from '@/components/kpi/CampaignsRouteLoading'

// UI v2 Phase 2 · K-1/K-2/K-4: khung chờ của /targets/campaigns/*. Vào CHI TIẾT hoặc AFFILIATE từ /targets (cùng segment
// targets) thì ranh giới gần nhất là file này ⇒ chọn khung theo pathname; còn lại (list, new) giữ khung danh sách K-1.
export default function CampaignsLoading() {
  return <CampaignsRouteLoading fallback={<CampaignListSkeleton />} />
}
