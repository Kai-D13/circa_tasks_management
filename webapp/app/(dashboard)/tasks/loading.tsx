// Shown while the /tasks server component fetches. Mirrors the page shell (title,
// tab strip, a few rows) so navigation feels instant on the staff mobile hot path.
// UI v2 P1.2: gốc data-ui-v2="page" (nền canvas), tab segmented + thẻ panel 12px như trang.
export default function TasksLoading() {
  return (
    <div data-ui-v2="page" className="p-4 md:p-6 space-y-4 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="size-10 rounded-v2-control bg-muted" />
        <div className="h-6 w-44 rounded bg-muted" />
      </div>

      {/* View tab strip */}
      <div className="h-[52px] sm:h-[38px] w-full sm:w-64 rounded-v2-control bg-muted" />

      {/* Rows */}
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-v2-panel border bg-card px-3.5 py-3 space-y-2">
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
