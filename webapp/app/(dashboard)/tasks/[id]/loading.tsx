import { Skeleton } from '@/components/ui/skeleton'

// UI v2 (nợ trước RC): khung chờ riêng cho /tasks/[id] — trước đây route dùng skeleton danh sách của
// /tasks/loading.tsx. Bố cục theo trang P1.3: header (mã + tiêu đề + tag), mobile ô Deadline/Ưu tiên,
// desktop 2 cột (nội dung | metadata 340px). Chỉ trình bày; không truy vấn.
const PANEL = 'rounded-v2-panel border bg-card'

export default function TaskDetailLoading() {
  return (
    <div data-ui-v2="page" data-route-loading="task-detail" className="flex flex-col lg:h-full">
      <div className="px-4 pt-4 pb-4 md:px-6 md:pt-5 border-b shrink-0 space-y-2.5">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-7 w-3/4 max-w-[560px]" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-20 rounded-v2-chip" />
          <Skeleton className="h-5 w-24 rounded-v2-chip" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 px-4 pt-4 lg:hidden">
        <Skeleton className="h-[58px] rounded-v2-panel" />
        <Skeleton className="h-[58px] rounded-v2-panel" />
      </div>
      <div className="flex flex-col lg:flex-row lg:flex-1 lg:min-h-0 w-full">
        <div className="flex-[2] min-w-0 px-4 py-4 md:px-6 space-y-4 lg:border-r">
          {[5, 3].map((rows, i) => (
            <div key={i} className={`${PANEL} space-y-3 px-4 md:px-5 py-4`}>
              <Skeleton className="h-3.5 w-24" />
              {Array.from({ length: rows }, (_, r) => <Skeleton key={r} className="h-4 w-full" />)}
            </div>
          ))}
        </div>
        <div className="lg:w-[340px] lg:shrink-0 px-4 py-4 md:px-5 lg:border-l">
          <div className={`${PANEL} space-y-3 px-4 py-4`}>
            {Array.from({ length: 6 }, (_, r) => <Skeleton key={r} className="h-4 w-full" />)}
          </div>
        </div>
      </div>
    </div>
  )
}
