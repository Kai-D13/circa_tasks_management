import { cn } from '@/lib/utils'

// Header của một màn mobile (nền sáng, dính đầu vùng cuộn <main>) — dùng khi màn tự dựng header
// thay MobileHeader chung (B7-ui r2: 3 màn dược sĩ CSKH theo artboard). Chỉ mobile (md:hidden):
// desktop dùng PageHeader. `leading` = nút quay lại/đóng 44px (màn con); `trailing` = thao tác phụ.
// Màn gốc tab: tiêu đề 20px đậm; màn con: 17px + dòng phụ 12px (vd tên khách).
export function MobileScreenHeader({
  title, subtitle, leading, trailing, root = false, className,
}: {
  title: string
  subtitle?: string
  leading?: React.ReactNode
  trailing?: React.ReactNode
  /** Màn gốc của tab (không có nút quay lại). */
  root?: boolean
  className?: string
}) {
  return (
    <header className={cn('sticky top-0 z-30 flex h-[52px] shrink-0 items-center gap-1 bg-background/95 backdrop-blur md:hidden',
      root ? 'px-4' : 'border-b pr-2 pl-1', className)}>
      {leading}
      <div className={cn('min-w-0 flex-1', !root && leading ? 'pl-1' : null)}>
        <h1 className={cn('truncate', root ? 'text-[20px] font-bold tracking-tight' : 'text-[17px] leading-tight font-semibold')}>{title}</h1>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-1">{trailing}</div>}
    </header>
  )
}
