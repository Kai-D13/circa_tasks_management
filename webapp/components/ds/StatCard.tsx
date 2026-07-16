import type { LucideIcon } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

const TONE_TILE: Record<string, string> = {
  default: 'bg-muted text-foreground',
  success: 'bg-status-success-bg text-status-success',
  warning: 'bg-status-warning-bg text-status-warning',
  danger:  'bg-status-danger-bg text-status-danger',
}

// Summary stat card (grid layout owned by the page: e.g. grid-cols-2 sm:grid-cols-4).
export function StatCard({
  label, value, icon: Icon, tone = 'default', hint, className,
}: {
  label: string
  value: React.ReactNode
  icon?: LucideIcon
  tone?: 'default' | 'success' | 'warning' | 'danger'
  hint?: string
  className?: string
}) {
  return (
    // rounded-lg override — base ui/card is rounded-xl (12px); DS surfaces cap
    // at 8px per UI_FOUNDATION_SPEC (P1 r1). Base card stays untouched (would
    // restyle every un-migrated route).
    <Card className={cn('rounded-lg', className)}>
      <CardContent className="p-3 flex items-center gap-3">
        {Icon && (
          <span className={cn('h-9 w-9 rounded-lg flex items-center justify-center shrink-0', TONE_TILE[tone])}>
            <Icon className="h-4 w-4" />
          </span>
        )}
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground truncate">{label}</p>
          <p className="text-2xl font-semibold tabular-nums leading-none mt-0.5">{value}</p>
          {hint && <p className="text-[11px] text-muted-foreground mt-1 truncate">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  )
}
