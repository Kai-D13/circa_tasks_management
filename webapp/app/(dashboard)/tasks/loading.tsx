// Shown while the /tasks server component fetches. Mirrors the page shell (title,
// tab strip, a few rows) so navigation feels instant on the staff mobile hot path.
export default function TasksLoading() {
  return (
    <div className="p-4 space-y-4 animate-pulse">
      <div className="h-7 w-44 rounded bg-muted" />

      {/* View tab strip */}
      <div className="h-9 w-full sm:w-64 rounded-lg bg-muted/70" />

      {/* Rows */}
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="h-4 w-32 rounded bg-muted" />
              <div className="h-5 w-16 rounded bg-muted/70" />
            </div>
            <div className="h-3 w-48 rounded bg-muted/60" />
            <div className="h-3 w-24 rounded bg-muted/60" />
          </div>
        ))}
      </div>
    </div>
  )
}
