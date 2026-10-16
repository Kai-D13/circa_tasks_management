import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// The page's single <h1> (compact operations-dashboard heading — admin.v2
// language). Actions sit right and wrap under the title on mobile.
// UI v2 (chỉ trong [data-ui-v2]): icon thành ô 40px nền selected bên trái khối tiêu đề + phụ đề
// (grid; khối flex bên trong thành `contents`). Ngoài phạm vi, ô bọc icon là `contents` ⇒ hiển thị
// y hệt bản cũ.
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
    <div className={cn('flex items-start justify-between flex-wrap gap-2 v2:gap-3', className)}>
      {/* v2: lưới icon | (tiêu đề + phụ đề) CHỈ khi có icon — không icon thì tiêu đề và phụ đề xếp dọc như cũ. */}
      <div className={cn('min-w-0', Icon && 'v2:grid v2:grid-cols-[auto_minmax(0,1fr)] v2:items-center v2:gap-x-3 v2:gap-y-0.5')}>
        <div className="flex items-center gap-2 v2:contents">
          {Icon && (
            <span className={cn(
              'contents v2:inline-flex v2:size-10 v2:items-center v2:justify-center v2:rounded-v2-control v2:bg-accent v2:text-accent-foreground',
              subtitle && 'v2:row-span-2',
            )}>
              <Icon className="h-5 w-5 text-primary shrink-0 v2:text-current" />
            </span>
          )}
          <h1 className="text-xl font-semibold truncate v2:text-[22px] v2:font-bold v2:tracking-[-0.01em]">{title}</h1>
        </div>
        {subtitle && <p className={cn('text-sm text-muted-foreground mt-0.5 v2:mt-0 v2:text-[13px]', Icon && 'v2:col-start-2')}>{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  )
}
