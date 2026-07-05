import { Skeleton } from '@/components/ui/skeleton'

// Shown while the /inventory hub (or a submodule) fetches.
export default function InventoryLoading() {
  return (
    <div className="p-4 md:p-6 space-y-4 max-w-3xl">
      <Skeleton className="h-7 w-28" />

      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-xl border p-4 flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-40" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
