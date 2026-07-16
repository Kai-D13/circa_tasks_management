import Link from 'next/link'
import { cn } from '@/lib/utils'

// Count-pill tabs (admin.v2 "Tất Cả (3189) · Nháp (105)…") — pure server <Link>s
// preserving URL params via the caller-built hrefs. Scrolls horizontally on
// mobile; touch targets ≥44px via py padding + hit area.
export function FilterTabs({
  tabs, activeKey, ariaLabel = 'Bộ lọc', className,
}: {
  tabs: { key: string; label: string; count?: number; href: string }[]
  activeKey?: string
  ariaLabel?: string
  className?: string
}) {
  return (
    // <nav> + aria-current="page" (P1 r1 semantics). Touch target dùng PIXEL
    // LITERAL [44px]: root font-size là 15px nên min-h-11 (2.75rem) chỉ ra
    // 41.25px thật — guardrail test đo computed height bắt được. Desktop compact.
    <nav aria-label={ariaLabel} className={cn('flex gap-1.5 overflow-x-auto pb-0.5', className)}>
      {tabs.map((t) => {
        const active = t.key === activeKey
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'shrink-0 inline-flex items-center px-3.5 min-h-[44px] md:min-h-9 rounded-full border text-sm font-medium transition-colors',
              active
                ? 'bg-primary text-primary-foreground border-primary'
                : 'text-muted-foreground hover:text-foreground bg-background',
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
