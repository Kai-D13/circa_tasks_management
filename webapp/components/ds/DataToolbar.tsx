import { cn } from '@/lib/utils'

// Filter-toolbar LAYOUT only (admin.v2: search + filters left, actions right).
// Owns no form logic — pages keep their existing <form method="GET"> and pass
// the pieces in; this just standardizes arrangement + wrapping.
export function DataToolbar({
  search, filters, actions, className,
}: {
  search?: React.ReactNode
  filters?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-end gap-2', className)}>
      {search}
      {filters}
      {actions && <div className="ml-auto flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  )
}
