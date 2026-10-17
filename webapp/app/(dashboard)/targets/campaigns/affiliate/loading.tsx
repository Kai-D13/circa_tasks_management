import { AffiliateOverviewSkeleton } from '@/components/affiliate/AffiliateOverviewSkeleton'

// UI v2 Phase 2 · K-4: khung chờ trang Doanh số Affiliate cho lối vào tab "Affiliate" ở danh sách chiến dịch (cùng
// segment campaigns ⇒ ranh giới này). Server component; skeleton dùng chung với bộ chọn theo pathname (lối vào sidebar).
export default function AffiliateOverviewLoading() {
  return <AffiliateOverviewSkeleton />
}
