import { LoadingState } from '@/components/ds/LoadingState'
import { CampaignsRouteLoading } from '@/components/kpi/CampaignsRouteLoading'

// /targets lands on either the campaign card list (staff/SM/store manager) or
// the period card — a short list skeleton fits both without a layout jump.
// UI v2 K-1/K-2: vào /targets/campaigns hoặc chi tiết chiến dịch từ NGOÀI /targets thì ranh giới chờ gần nhất là
// file này (cấp targets) ⇒ chọn khung theo đường dẫn (campaignsLoadingKind), tránh nhảy max-w-xl → fluid v2.
// Mọi đường dẫn khác (/targets, new, affiliate) giữ nguyên khung cũ.
export default function TargetsLoading() {
  return (
    <CampaignsRouteLoading
      fallback={(
        <div className="p-4 space-y-4 max-w-xl mx-auto">
          <div className="h-7 w-56 rounded bg-muted animate-pulse" />
          <LoadingState variant="list" rows={3} />
        </div>
      )}
    />
  )
}
