import { Skeleton } from '@/components/ui/skeleton'

// UI v2 Phase 2 · K-4: khung chờ trang Doanh số Affiliate. Module server-compatible (không 'use client') dùng cho CẢ
// affiliate/loading.tsx (lối vào tab "Affiliate" ở danh sách — cùng segment campaigns) lẫn bộ chọn theo pathname
// CampaignsRouteLoading (lối vào từ sidebar ngoài /targets ⇒ targets/loading.tsx; từ /targets ⇒ campaigns/loading.tsx).
// Bố cục theo AffiliateOverviewView: tiêu đề, tab, bộ lọc, 3 ô, bảng.
export function AffiliateOverviewSkeleton() {
  return (
    <div data-ui-v2="page" data-route-loading="campaign-affiliate" className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-v2-control" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-64 max-w-full" />
          <Skeleton className="h-4 w-56 max-w-full" />
        </div>
      </div>
      <Skeleton className="h-[52px] md:h-[38px] w-48 rounded-v2-control" />
      <div className="flex flex-wrap gap-2.5">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[44px] md:h-[40px] w-40 rounded-v2-control" />)}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[92px] rounded-v2-panel" />)}
      </div>
      <div className="overflow-hidden rounded-v2-panel border bg-card">
        <Skeleton className="h-10 w-full rounded-none" />
        <div className="divide-y">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="px-5 py-3.5"><Skeleton className="h-5 w-full" /></div>)}
        </div>
      </div>
    </div>
  )
}
