import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// Rendered by the PAGE when a fetch returned zero rows (state ownership:
// pages decide, ds components never take isLoading/isError flags).
export function EmptyState({
  icon: Icon, title, hint, action, className,
}: {
  icon?: LucideIcon
  title: string
  hint?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('text-center py-10 px-4', className)}>
      {Icon && <Icon className="h-8 w-8 mx-auto text-muted-foreground/60 mb-2" />}
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  )
}
