import { Skeleton } from '@/components/ui/skeleton'

// Shown while /announcements fetches. Mirrors the feed shell (title + cards).
export default function AnnouncementsLoading() {
  return (
    <div className="p-4 md:p-6 space-y-4 max-w-3xl">
      <Skeleton className="h-7 w-32" />

      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-5 w-12" />
            </div>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-40" />
          </div>
        ))}
      </div>
    </div>
  )
}
