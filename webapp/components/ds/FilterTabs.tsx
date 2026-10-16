import Link from 'next/link'
import { cn } from '@/lib/utils'

// Count-pill tabs (admin.v2 "Tất Cả (3189) · Nháp (105)…") — pure server <Link>s
// preserving URL params via the caller-built hrefs. Scrolls horizontally on
// mobile; touch targets ≥44px via py padding + hit area.
export function FilterTabs({
  tabs, activeKey, ariaLabel = 'Bộ lọc', className, variant = 'pill',
}: {
  tabs: { key: string; label: string; count?: number; href: string }[]
  activeKey?: string
  ariaLabel?: string
  className?: string
  /** 'chip' (B7-ui r2, màn dược sĩ CSKH): viên 36px trong vùng chạm 44px, đang chọn nền tối, số đếm nhạt không ngoặc. */
  variant?: 'pill' | 'chip'
}) {
  if (variant === 'chip') {
    return (
      <nav aria-label={ariaLabel} className={cn('flex gap-2 overflow-x-auto [scrollbar-width:none]', className)}>
        {tabs.map((t) => {
          const active = t.key === activeKey
          return (
            <Link key={t.key} href={t.href} aria-current={active ? 'page' : undefined}
              className="group flex min-h-[44px] shrink-0 items-center">
              <span className={cn('inline-flex h-[36px] items-center rounded-full border px-3.5 text-sm font-medium whitespace-nowrap transition-colors',
                active ? 'border-foreground bg-foreground text-background' : 'border-input bg-card text-foreground/80 group-hover:text-foreground')}>
                {t.label}
                {typeof t.count === 'number' && <>{' '}<span className={cn('ml-0.5 tabular-nums', active ? 'text-background/70' : 'text-muted-foreground')}>{t.count}</span></>}
              </span>
            </Link>
          )
        })}
      </nav>
    )
  }
  return (
    // <nav> + aria-current="page" (P1 r1 semantics). Touch target dùng PIXEL
    // LITERAL [44px]: root font-size là 15px nên min-h-11 (2.75rem) chỉ ra
    // 41.25px thật — guardrail test đo computed height bắt được. Desktop compact.
    // UI v2 (chỉ trong [data-ui-v2], PM duyệt 16/10): segmented — rãnh muted, tab đang chọn TRUNG
    // TÍNH (nền panel + viền line-strong), cam chỉ dành cho hành động. Ngoài phạm vi giữ pill cam.
    <nav aria-label={ariaLabel} className={cn('flex gap-1.5 overflow-x-auto pb-0.5 v2:w-fit v2:max-w-full v2:gap-1 v2:rounded-v2-control v2:bg-muted v2:p-1', className)}>
      {tabs.map((t) => {
        const active = t.key === activeKey
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'shrink-0 inline-flex items-center px-3.5 min-h-[44px] md:min-h-9 rounded-full border text-sm font-medium transition-colors',
              'v2:rounded-[8px] v2:text-[13px] md:v2:min-h-[30px]',
              active
                ? 'bg-primary text-primary-foreground border-primary v2:bg-card v2:text-foreground v2:border-input v2:font-semibold'
                : 'text-muted-foreground hover:text-foreground bg-background v2:bg-transparent v2:border-transparent',
            )}
          >
            {t.label}
            {typeof t.count === 'number' && <span className="ml-1 tabular-nums">({t.count})</span>}
          </Link>
        )
      })}
    </nav>
  )
}
