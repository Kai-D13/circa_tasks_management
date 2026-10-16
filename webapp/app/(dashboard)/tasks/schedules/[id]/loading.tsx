import { Skeleton } from '@/components/ui/skeleton'

// UI v2 P1.5: khung chờ riêng cho chi tiết lịch (trước đây dùng skeleton bảng của route cha). Bố cục theo
// ScheduleDetailView — back-link, tiêu đề + badge, Cấu hình lịch | Nội dung task, Cửa hàng, Lịch sử chạy |
// Task đã tạo. Chỉ trình bày; không truy vấn.
const PANEL = 'rounded-v2-panel border bg-card'

export default function ScheduleDetailLoading() {
  return (
    <div data-ui-v2="page" data-route-loading="schedule-detail" className="p-4 md:px-6 md:pt-5 md:pb-8 space-y-4 md:space-y-[18px]">
      <Skeleton className="h-4 w-20" />
      <div className="space-y-2.5 border-b pb-[18px]">
        <Skeleton className="h-7 w-2/3 max-w-[520px]" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-28 rounded-v2-chip" />
          <Skeleton className="h-5 w-20 rounded-v2-chip" />
        </div>
        <Skeleton className="h-4 w-56" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[10, 5].map((rows, i) => (
          <div key={i} className={PANEL}>
            <div className="border-b px-4 md:px-5 py-3 md:py-4"><Skeleton className="h-4 w-28" /></div>
            <div className="space-y-3 px-4 md:px-5 py-4">
              {Array.from({ length: rows }, (_, r) => <Skeleton key={r} className="h-4 w-full" />)}
            </div>
          </div>
        ))}
      </div>
      <div className={`${PANEL} space-y-3 px-4 md:px-5 py-4`}>
        <Skeleton className="h-4 w-44" />
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-6 w-24 rounded-v2-chip" />)}
        </div>
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-2">
        {[4, 4].map((rows, i) => (
          <div key={i} className={PANEL}>
            <div className="border-b px-4 md:px-5 py-3 md:py-4"><Skeleton className="h-4 w-36" /></div>
            <div className="divide-y">
              {Array.from({ length: rows }, (_, r) => <div key={r} className="px-4 md:px-5 py-3"><Skeleton className="h-4 w-full" /></div>)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
