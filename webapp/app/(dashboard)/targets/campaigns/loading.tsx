import { Skeleton } from '@/components/ui/skeleton'

// UI v2 Phase 2 · K-1: khung chờ desktop của /targets/campaigns (trước đây dùng targets/loading.tsx — skeleton
// mobile max-w-xl). Bố cục theo CampaignListView: tiêu đề + nút, tab, 5 thẻ lọc, bảng. Chỉ trình bày.
export default function CampaignsLoading() {
  return (
    <div data-ui-v2="page" data-route-loading="campaigns" className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-v2-control" />
          <Skeleton className="h-6 w-40" />
        </div>
        <Skeleton className="h-[44px] md:h-[36px] w-36 rounded-v2-control" />
      </div>
      <Skeleton className="h-[52px] md:h-[38px] w-48 rounded-v2-control" />
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[76px] rounded-v2-panel" />)}
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
