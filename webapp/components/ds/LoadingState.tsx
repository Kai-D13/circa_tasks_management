import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

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
          <Card key={i} className="rounded-lg"><CardContent className="p-3 space-y-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-7 w-10" />
          </CardContent></Card>
        ))}
      </div>
    )
  }
  if (variant === 'table') {
    return (
      <Card className={cn('rounded-lg', className)}><CardContent className="p-0">
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
        <Card key={i} className="rounded-lg"><CardContent className="p-3.5 space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </CardContent></Card>
      ))}
    </div>
  )
}
