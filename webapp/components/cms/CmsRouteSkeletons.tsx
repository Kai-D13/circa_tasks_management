import { Skeleton } from '@/components/ui/skeleton'

// CMS — khung chờ loading.tsx cho nhánh /targets/campaigns/cms (gốc v2 để token đúng khi chờ; không số giả).
export function CmsListSkeleton() {
  return (
    <div data-ui-v2="page" data-layout-width="fluid" data-cms-skeleton="list" aria-busy="true" className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-10 w-72" />
      <div className="grid grid-cols-2 gap-2.5 md:max-w-xl">
        <Skeleton className="h-[76px]" />
        <Skeleton className="h-[76px]" />
      </div>
      <Skeleton className="h-[44px] w-full md:w-[520px]" />
      <div className="space-y-2">
        {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[60px] w-full" />)}
      </div>
    </div>
  )
}

export function CmsDetailSkeleton() {
  return (
    <div data-ui-v2="page" data-layout-width="fluid" data-cms-skeleton="detail" aria-busy="true" className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-8 w-80 max-w-full" />
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[76px]" />)}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[72px] w-full" />)}
      </div>
    </div>
  )
}
