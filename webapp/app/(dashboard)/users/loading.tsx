import { LoadingState } from '@/components/ds/LoadingState'

// /users is a stat-cards + table route — mirror that shape while it loads.
export default function UsersLoading() {
  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="h-7 w-52 rounded bg-muted animate-pulse" />
      <LoadingState variant="cards" rows={4} />
      <LoadingState variant="table" rows={8} />
    </div>
  )
}
