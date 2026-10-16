import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// Rendered by the PAGE when a fetch returned zero rows (state ownership:
// pages decide, ds components never take isLoading/isError flags).
// UI v2 (chỉ trong [data-ui-v2]): icon trong ô 44px nền muted, tiêu đề 14px đậm. Ngoài phạm vi ô bọc
// là `contents` ⇒ hiển thị y hệt bản cũ.
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
      {Icon && (
        <span className="contents v2:mx-auto v2:mb-3 v2:flex v2:size-11 v2:items-center v2:justify-center v2:rounded-v2-control v2:bg-muted">
          <Icon className="h-8 w-8 mx-auto text-muted-foreground/60 mb-2 v2:size-5 v2:m-0 v2:text-muted-foreground" />
        </span>
      )}
      <p className="text-sm font-medium v2:text-[14px] v2:font-semibold">{title}</p>
      {hint && <p className="text-xs text-muted-foreground mt-1 v2:text-[13px]">{hint}</p>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  )
}
