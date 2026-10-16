import { cn } from '@/lib/utils'

// Bề mặt một khối nội dung (thẻ phẳng, viền mảnh, không đổ bóng) — thay các <Card> tự chế ở trang.
// Ngoài [data-ui-v2]: thẻ ds 8px; trong v2: panel 12px (docs/ui/UI_V2_TASKS.md).
// `title` = h2 của khối; `titleStyle="eyebrow"` = nhãn nhỏ in hoa (vd "MÔ TẢ").
// `flush` = thân không padding (bảng/danh sách sát mép; header tự có padding + vạch kẻ dưới).
export function Panel({
  title, titleStyle = 'section', actions, flush = false, className, bodyClassName, children,
}: {
  title?: React.ReactNode
  titleStyle?: 'section' | 'eyebrow'
  actions?: React.ReactNode
  flush?: boolean
  className?: string
  bodyClassName?: string
  children: React.ReactNode
}) {
  const heading = title ? (
    <h2 className={cn(
      'min-w-0 flex-1',
      titleStyle === 'eyebrow'
        ? 'text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground v2:text-[12px] v2:text-v2-text-3'
        : 'text-sm font-semibold v2:text-[15px]',
    )}>{title}</h2>
  ) : null
  const header = heading || actions ? (
    // v2 mobile: header flush thấp (link phụ đã tự cao 44px), desktop 16px.
    <div className={cn('flex items-center gap-3', flush && 'border-b px-4 py-3 v2:px-5 v2:py-1.5 md:v2:py-4')}>
      {heading}
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  ) : null
  return (
    <section className={cn('rounded-lg border bg-card text-card-foreground v2:rounded-v2-panel', !flush && 'space-y-3 p-4 v2:px-5 v2:py-[18px]', flush && 'overflow-hidden', className)}>
      {header}
      {flush ? <div className={bodyClassName}>{children}</div> : <div className={cn('min-w-0', bodyClassName)}>{children}</div>}
    </section>
  )
}
