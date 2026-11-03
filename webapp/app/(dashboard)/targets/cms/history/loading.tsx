import { Skeleton } from '@/components/ui/skeleton'

// CMS P2-c — khung chờ D3 (gốc v2, cột giữa; không số giả).
export default function Loading() {
  return (
    <div data-ui-v2="page" data-layout-width="centered" data-cms-skeleton="staff-history" aria-busy="true" className="mx-auto max-w-2xl p-4 space-y-4">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-[52px] w-full" />
      <Skeleton className="h-[150px] w-full" />
      {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[72px] w-full" />)}
    </div>
  )
}
