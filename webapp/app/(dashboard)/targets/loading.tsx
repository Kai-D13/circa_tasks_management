import { CampaignsRouteLoading } from '@/components/kpi/CampaignsRouteLoading'
import { TargetsLandingSkeleton } from '@/components/kpi/CampaignRouteSkeletons'

// /targets lands on either the campaign card list (staff/SM/store manager) or
// the period card — a short list skeleton fits both without a layout jump.
// UI v2 K-1/K-2/K-4: vào /targets/campaigns, chi tiết chiến dịch hoặc Affiliate (sidebar admin phòng ban) từ NGOÀI
// /targets thì ranh giới chờ gần nhất là file này (cấp targets) ⇒ chọn khung theo đường dẫn (campaignsLoadingKind),
// tránh nhảy max-w-xl → fluid v2. K-6: các đường dẫn còn lại (/targets — SM/staff/QLCH, new) ⇒ khung v2 chung
// TargetsLandingSkeleton (module server-compatible).
export default function TargetsLoading() {
  return <CampaignsRouteLoading fallback={<TargetsLandingSkeleton />} />
}
