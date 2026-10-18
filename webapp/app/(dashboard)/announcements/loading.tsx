import { Skeleton } from '@/components/ui/skeleton'

// Shown while /announcements fetches. Mirrors the feed shell (title + cards).
// UI v2 A1: cùng gốc v2 + page-root centered `max-w-3xl mx-auto` như AnnouncementsListView ⇒ không nhảy bề ngang khi
// trang thật thay khung chờ (server-compatible, không truy vấn).
export default function AnnouncementsLoading() {
  return (
    <div data-ui-v2="page" data-route-loading="announcements" className="mx-auto max-w-3xl space-y-4 p-4 md:p-6 v2:space-y-[18px]">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-v2-control" />
        <Skeleton className="h-6 w-32" />
      </div>

      <div className="space-y-2.5">
        <Skeleton className="h-3 w-20" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex gap-3 rounded-v2-panel border bg-card p-4">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-48 max-w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-40 max-w-full" />
            </div>
            {i % 2 === 0 && <Skeleton className="size-[72px] shrink-0 rounded-[10px] md:size-[88px]" />}
          </div>
        ))}
      </div>
    </div>
  )
}
