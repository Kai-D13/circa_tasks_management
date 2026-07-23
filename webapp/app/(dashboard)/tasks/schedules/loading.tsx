import { LoadingState } from '@/components/ds/LoadingState'

// Schedules is a table route — the /tasks card/tab skeleton doesn't match its
// layout, so give it a dedicated table skeleton (title + DataTableShell rows).
export default function SchedulesLoading() {
  return (
    <div className="p-4 space-y-4">
      <div className="h-7 w-40 rounded bg-muted animate-pulse" />
      <LoadingState variant="table" rows={6} />
    </div>
  )
}
