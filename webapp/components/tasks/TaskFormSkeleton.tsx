import { Skeleton } from '@/components/ui/skeleton'

// UI v2 (nợ trước RC): khung chờ của form tạo/sửa task (/tasks/new, /tasks/[id]/edit) theo bố cục P1.4 —
// header 64px, cột trái 3 panel, panel "Cấu hình task" 360px (desktop). Trước đây 2 route này dùng skeleton
// danh sách /tasks hoặc chi tiết task. Chỉ trình bày; không truy vấn.
const PANEL = 'rounded-v2-panel border bg-card'

export function TaskFormSkeleton({ marker }: { marker: string }) {
  return (
    <div data-ui-v2="page" data-route-loading={marker} className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 md:px-6 py-2 sm:py-0 sm:h-[64px] border-b bg-card shrink-0">
        <Skeleton className="h-6 w-36 basis-full sm:basis-auto" />
        <div className="ml-auto flex gap-2">
          <Skeleton className="h-[44px] md:h-[36px] w-16 rounded-v2-control" />
          <Skeleton className="h-[44px] md:h-[36px] w-24 rounded-v2-control" />
        </div>
      </div>
      <div className="flex flex-1 min-h-0 flex-col lg:flex-row">
        <div className="flex-1 min-w-0 space-y-4 p-4 md:p-6">
          <div className={`${PANEL} space-y-3 px-4 md:px-5 py-[18px]`}>
            <Skeleton className="h-[44px] md:h-[38px] w-full max-w-[420px] rounded-v2-control" />
            <Skeleton className="h-[44px] md:h-[36px] w-full rounded-v2-control" />
          </div>
          <div className={PANEL}>
            <div className="px-4 md:px-5 pt-[18px] pb-3"><Skeleton className="h-6 w-1/2" /></div>
            <Skeleton className="h-[44px] md:h-[40px] w-full rounded-none" />
            <div className="h-[180px]" />
          </div>
          <div className={`${PANEL} px-2.5 py-1.5`}><Skeleton className="h-[44px] md:h-[32px] w-48 rounded-[8px]" /></div>
        </div>
        <div className="hidden lg:block lg:w-[360px] lg:shrink-0 lg:border-l bg-card px-5 py-5 space-y-5">
          <Skeleton className="h-3 w-28" />
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-[36px] w-full rounded-v2-control" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
