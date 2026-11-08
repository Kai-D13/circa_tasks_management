import Link from 'next/link'
import { cn } from '@/lib/utils'
import { cmsNavHref, type CmsNav } from '@/lib/cms/fixtureNav'

// CMS P1-d (UI §4.1, U15) — segmented 2 mục trên /targets cho staff / QLCH: "KPI chiến dịch | CMS sản phẩm". Server Link,
// aria-current; chỉ render khi cờ CMS_PROGRAM_ENABLED bật (page quyết). Không đổi BottomNav.
// CMS đơn giản S3 (PM r1 08/11 §6 — ngoại lệ có phạm vi CHỈ segment này + tab chương trình D3): tab đang chọn nền action brand
// (`bg-primary text-primary-foreground` — trong v2: #C94A16 / trắng, tối #F3743F / #141210), tab còn lại chữ `text-foreground`;
// khung nền card có viền. Không đổi globals / Sidebar / BottomNav / module khác.
export function CmsTargetsSegment({ active, nav }: { active: 'kpi' | 'cms'; nav?: CmsNav }) {
  const items = [
    { key: 'kpi' as const, label: 'KPI chiến dịch', href: cmsNavHref(nav, '/targets') },
    { key: 'cms' as const, label: 'CMS sản phẩm', href: cmsNavHref(nav, '/targets?tab=cms') },
  ]
  return (
    <nav aria-label="Mục tiêu" data-cms-targets-segment={active} className="grid w-full grid-cols-2 gap-1 rounded-v2-control border bg-card p-1 sm:w-fit">
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? 'page' : undefined}
          className={cn(
            'inline-flex min-h-[44px] md:min-h-0 md:h-[32px] items-center justify-center whitespace-nowrap rounded-[8px] px-3.5 text-[13px]',
            active === t.key ? 'bg-primary font-semibold text-primary-foreground' : 'font-medium text-foreground hover:bg-muted',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}
