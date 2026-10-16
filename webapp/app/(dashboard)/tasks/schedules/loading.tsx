import { Skeleton } from '@/components/ui/skeleton'
import { LoadingState } from '@/components/ds/LoadingState'

// Schedules is a table route — the /tasks card/tab skeleton doesn't match its
// layout, so give it a dedicated table skeleton (title + DataTableShell rows).
// UI v2 P1.5: gốc data-ui-v2="page" (nền canvas), tiêu đề có ô icon + nút, bảng panel 12px như trang.
export default function SchedulesLoading() {
  return (
    <div data-ui-v2="page" data-route-loading="schedules" className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-v2-control" />
          <Skeleton className="h-6 w-40" />
        </div>
        <Skeleton className="h-[44px] md:h-[36px] w-32 rounded-v2-control" />
      </div>
      <LoadingState variant="table" rows={6} />
    </div>
  )
}
