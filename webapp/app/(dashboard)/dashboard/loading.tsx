import { Skeleton } from '@/components/ui/skeleton'
import { LoadingState } from '@/components/ds/LoadingState'

// UI v2 (P1.1): khung chờ của /dashboard theo bố cục trang — tiêu đề, 4 ô KPI, bảng hoạt động.
// Chỉ trình bày; không truy vấn.
export default function DashboardLoading() {
  return (
    <div data-ui-v2="page" className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-v2-control" />
        <Skeleton className="h-6 w-36" />
      </div>
      <LoadingState variant="cards" rows={4} className="md:grid-cols-4" />
      <LoadingState variant="table" rows={6} />
    </div>
  )
}
