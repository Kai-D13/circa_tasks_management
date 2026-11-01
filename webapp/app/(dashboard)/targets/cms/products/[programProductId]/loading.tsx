import { Skeleton } from '@/components/ui/skeleton'

// CMS P1-d — khung chờ D2 (gốc v2, cột giữa; không số giả).
export default function Loading() {
  return (
    <div data-ui-v2="page" data-layout-width="centered" data-cms-skeleton="staff-product" aria-busy="true" className="mx-auto max-w-2xl p-4 space-y-4">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-[204px] w-full" />
      <Skeleton className="h-7 w-3/4" />
      <Skeleton className="h-[96px] w-full" />
      <Skeleton className="h-[140px] w-full" />
    </div>
  )
}
