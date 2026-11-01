import Link from 'next/link'
import { cn } from '@/lib/utils'

// CMS P1-d (UI §4.1, U15) — segmented 2 mục trên /targets cho staff / QLCH: "KPI chiến dịch | CMS sản phẩm". Server Link,
// aria-current; chỉ render khi cờ CMS_PROGRAM_ENABLED bật (page quyết). Không đổi BottomNav.
export function CmsTargetsSegment({ active }: { active: 'kpi' | 'cms' }) {
  const items = [
    { key: 'kpi' as const, label: 'KPI chiến dịch', href: '/targets' },
    { key: 'cms' as const, label: 'CMS sản phẩm', href: '/targets?tab=cms' },
  ]
  return (
    <nav aria-label="Mục tiêu" data-cms-targets-segment={active} className="grid w-full grid-cols-2 gap-1 rounded-v2-control bg-muted p-1 sm:w-fit">
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? 'page' : undefined}
          className={cn(
            'inline-flex min-h-[44px] md:min-h-0 md:h-[32px] items-center justify-center whitespace-nowrap rounded-[8px] px-3.5 text-[13px]',
            active === t.key ? 'border border-input bg-card font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}
