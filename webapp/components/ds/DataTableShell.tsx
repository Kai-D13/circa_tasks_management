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
    // UI v2 (chỉ trong [data-ui-v2]): panel 12px sát bảng (bỏ py của Card), band header đặc.
    <Card className={cn('rounded-lg overflow-hidden v2:rounded-v2-panel v2:ring-border v2:py-0', className)}>
      <CardContent
        className={cn(
          'p-0',
          '[&_thead]:bg-muted/50',
          '[&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground',
          '[&_td]:py-3',
          'v2:[&_thead]:bg-muted v2:[&_th]:text-[12px]',
        )}
      >
        {children}
      </CardContent>
    </Card>
  )
}
