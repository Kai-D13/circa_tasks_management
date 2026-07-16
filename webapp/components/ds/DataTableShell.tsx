import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

// Surface + header-band styling for shadcn <Table> children (admin.v2 table
// language: muted header band, airy rows, thin dividers). Scroll ownership
// stays with ui/table.tsx's own data-slot="table-container" (overflow-x-auto)
// — this shell adds NO second scroll wrapper (r2: double-scroll ban).
export function DataTableShell({
  children, className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    // rounded-lg — DS surfaces cap at 8px (base ui/card is rounded-xl).
    <Card className={cn('rounded-lg overflow-hidden', className)}>
      <CardContent
        className={cn(
          'p-0',
          '[&_thead]:bg-muted/50',
          '[&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground',
          '[&_td]:py-3',
        )}
      >
        {children}
      </CardContent>
    </Card>
  )
}
