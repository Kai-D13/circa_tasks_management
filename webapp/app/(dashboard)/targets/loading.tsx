import { LoadingState } from '@/components/ds/LoadingState'

// /targets lands on either the campaign card list (staff/SM/store manager) or
// the period card — a short list skeleton fits both without a layout jump.
export default function TargetsLoading() {
  return (
    <div className="p-4 space-y-4 max-w-xl mx-auto">
      <div className="h-7 w-56 rounded bg-muted animate-pulse" />
      <LoadingState variant="list" rows={3} />
    </div>
  )
}
