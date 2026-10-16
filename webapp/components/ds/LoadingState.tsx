import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

// UI v2 (chỉ trong [data-ui-v2]): khung skeleton theo panel 12px, sát mép như StatCard/DataTableShell
// v2 (bỏ py của Card); ngoài phạm vi giữ 8px.
const SURFACE = 'rounded-lg v2:rounded-v2-panel v2:ring-border v2:py-0'

// Route loading.tsx building block — three shapes cover the app's lists,
// tables and stat-card grids (replaces the copy-pasted loading files).
export function LoadingState({
  variant, rows = 6, className,
}: {
  variant: 'list' | 'table' | 'cards'
  rows?: number
  className?: string
}) {
  if (variant === 'cards') {
    return (
      <div className={cn('grid grid-cols-2 sm:grid-cols-4 gap-3', className)}>
        {Array.from({ length: rows }, (_, i) => (
          <Card key={i} className={SURFACE}><CardContent className="p-3 space-y-2 v2:px-[18px] v2:py-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-7 w-10" />
          </CardContent></Card>
        ))}
      </div>
    )
  }
  if (variant === 'table') {
    return (
      <Card className={cn(SURFACE, className)}><CardContent className="p-0">
        <Skeleton className="h-9 w-full rounded-none" />
        <div className="divide-y">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="px-4 py-3"><Skeleton className="h-4 w-full" /></div>
          ))}
        </div>
      </CardContent></Card>
    )
  }
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Card key={i} className={SURFACE}><CardContent className="p-3.5 space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </CardContent></Card>
      ))}
    </div>
  )
}
