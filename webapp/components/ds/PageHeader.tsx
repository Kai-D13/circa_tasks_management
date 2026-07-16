import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// The page's single <h1> (compact operations-dashboard heading — admin.v2
// language). Actions sit right and wrap under the title on mobile.
export function PageHeader({
  title, subtitle, icon: Icon, actions, className,
}: {
  title: string
  subtitle?: string
  icon?: LucideIcon
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-start justify-between flex-wrap gap-2', className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="h-5 w-5 text-primary shrink-0" />}
          <h1 className="text-xl font-semibold truncate">{title}</h1>
        </div>
        {subtitle && <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  )
}
