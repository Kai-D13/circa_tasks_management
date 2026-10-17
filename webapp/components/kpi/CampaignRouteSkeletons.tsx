import { Skeleton } from '@/components/ui/skeleton'

// UI v2 Phase 2 — khung chờ các route /targets/campaigns/*. Next hiện loading.tsx của SEGMENT CAO NHẤT bị thay khi
// điều hướng: vào chi tiết từ /targets dùng campaigns/loading.tsx, từ ngoài /targets dùng targets/loading.tsx ⇒ cả hai
// file chọn khung theo pathname (CampaignsRouteLoading — file client riêng) để mọi lối vào ra cùng một khung.
// Module này KHÔNG 'use client': loading.tsx server (vd [id]/loading.tsx) render được ngay, không phải chờ chunk JS
// (khung chờ client mà chunk chưa tải ⇒ chính khung chờ bị treo, main trống — đo được ở K-2).

export function CampaignListSkeleton() {
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

// Bố cục theo CampaignDetailView: back-link + tiêu đề + tab, thanh công cụ, hero + 4 ô, bảng.
export function CampaignDetailSkeleton() {
  return (
    <div data-ui-v2="page" data-route-loading="campaign-detail" className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <div className="space-y-2">
        <Skeleton className="h-4 w-28" />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-7 w-64 max-w-full" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
          <Skeleton className="h-[44px] md:h-[40px] w-56 rounded-v2-control" />
        </div>
      </div>
      <Skeleton className="h-[60px] w-full rounded-v2-panel" />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Skeleton className="h-[172px] rounded-v2-panel" />
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[80px] rounded-v2-panel" />)}
        </div>
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

// UI v2 K-6: khung chờ /targets (landing SM / staff / QLCH — cùng pathname nên KHÔNG phân biệt vai): tiêu đề + 3 thẻ.
// Fluid như SM/QLCH; staff mobile-only nên tự hẹp theo màn hình. Thay khung cũ max-w-xl của targets/loading.tsx.
export function TargetsLandingSkeleton() {
  return (
    <div data-ui-v2="page" data-route-loading="targets" className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-v2-control" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-48 max-w-full" />
          <Skeleton className="h-4 w-36 max-w-full" />
        </div>
      </div>
      {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[132px] rounded-v2-panel" />)}
    </div>
  )
}
