import { cn } from '@/lib/utils'

// UI v2 (chỉ trong [data-ui-v2]): control lọc ĐANG có giá trị (khác "Tất cả…") — viền + nền + chữ
// accent để thấy ngay bộ lọc nào đang bật. Trang tự gắn khi giá trị hiện tại khác mặc định; ngoài
// phạm vi class vô hiệu.
export const FILTER_ACTIVE = 'v2:border-v2-selected-line v2:bg-accent v2:text-accent-foreground'

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
