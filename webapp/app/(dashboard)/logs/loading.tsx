import { LoadingState } from '@/components/ds/LoadingState'

// /logs is a filter-form + table route — mirror that shape while it loads.
export default function LogsLoading() {
  return (
    <div className="p-4 space-y-4">
      <div className="h-7 w-48 rounded bg-muted animate-pulse" />
      <div className="h-16 w-full rounded bg-muted/60 animate-pulse" />
      <LoadingState variant="table" rows={8} />
    </div>
  )
}
