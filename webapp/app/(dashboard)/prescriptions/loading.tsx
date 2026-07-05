import { Skeleton } from '@/components/ui/skeleton'

// Shown while /prescriptions fetches. Mirrors the page shell (title + actions,
// filter row, list rows) so navigation feels instant on the staff mobile path.
export default function PrescriptionsLoading() {
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-7 w-36" />
        <Skeleton className="h-8 w-32" />
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-10 w-full sm:w-44 md:h-8" />
        <Skeleton className="h-10 w-32 md:h-8" />
        <Skeleton className="h-10 w-20 md:h-8" />
      </div>

      {/* Rows */}
      <div className="rounded-xl border divide-y">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="p-3.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-5 w-20" />
            </div>
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </div>
    </div>
  )
}
