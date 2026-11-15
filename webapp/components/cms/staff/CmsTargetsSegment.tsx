import Link from 'next/link'
import { cn } from '@/lib/utils'
import { cmsNavHref, type CmsNav } from '@/lib/cms/fixtureNav'
import { NavWatchdog } from '@/components/common/NavWatchdog'

// CMS P1-d (UI §4.1, U15) — segmented 2 mục trên /targets cho staff / QLCH: "KPI chiến dịch | CMS sản phẩm". Server Link,
// aria-current; chỉ render khi cờ CMS_PROGRAM_ENABLED bật (page quyết). Không đổi BottomNav.
// CMS đơn giản S3 (PM r1 08/11 §6 — ngoại lệ có phạm vi CHỈ segment này + tab chương trình D3): tab đang chọn nền action brand
// (`bg-primary text-primary-foreground` — trong v2: #C94A16 / trắng, tối #F3743F / #141210), tab còn lại chữ `text-foreground`;
// khung nền card có viền. Không đổi globals / Sidebar / BottomNav / module khác.
// NAV-2 (PM 08/11, work order cms-nav2-guides-next-actions §1–2): chạm segment có lúc treo như NAV-1 (RSC về đủ, URL đứng yên) ⇒
// mỗi link có con client `NavWatchdog` (không render DOM) nhận ĐÚNG href đã render: còn pending quá NAV_WATCHDOG_MS lúc trang hiển
// thị ⇒ tải cứng đích một lần. Hai trang gọi segment (/targets KPI, CMS dược sĩ) không có dữ liệu nhập dở. Đây là cách thoát treo,
// không phải sửa nguyên nhân gốc của transition.
// NAV-REPEAT-1 (PM 15/11, work order 2026-11-15-nav-repeat-1-work-order-pm.md §2): KPI → CMS sau một vòng CMS → KPI mềm treo
// tất định (RSC về đủ, link vẫn pending ⇒ watchdog tải cứng ở 6 s; có cả trên main 0a95570). Riêng hướng này (đang ở KPI, chạm
// "CMS sản phẩm") dùng <a> thường ⇒ điều hướng TÀI LIỆU chủ động ngay lúc chạm, không đi transition RSC, không chờ watchdog.
// Đổi có chủ đích soft → full document cho đúng một link; không phải sửa gốc React / Next. Chiều CMS → KPI và link trang hiện tại
// giữ <Link> + NavWatchdog. Không đổi href / nhãn / thứ tự / aria-current / class; trang KPI không có dữ liệu nhập dở.
export function CmsTargetsSegment({ active, nav }: { active: 'kpi' | 'cms'; nav?: CmsNav }) {
  const items = [
    { key: 'kpi' as const, label: 'KPI chiến dịch', href: cmsNavHref(nav, '/targets') },
    { key: 'cms' as const, label: 'CMS sản phẩm', href: cmsNavHref(nav, '/targets?tab=cms') },
  ]
  return (
    <nav aria-label="Mục tiêu" data-cms-targets-segment={active} className="grid w-full grid-cols-2 gap-1 rounded-v2-control border bg-card p-1 sm:w-fit">
      {items.map((t) => {
        const className = cn(
          'inline-flex min-h-[44px] md:min-h-0 md:h-[32px] items-center justify-center whitespace-nowrap rounded-[8px] px-3.5 text-[13px]',
          active === t.key ? 'bg-primary font-semibold text-primary-foreground' : 'font-medium text-foreground hover:bg-muted',
        )
        const current = active === t.key ? 'page' : undefined
        if (active === 'kpi' && t.key === 'cms') {
          return (
            // Có chủ đích (NAV-REPEAT-1): <a> thay <Link> ⇒ document navigation, không soft transition.
            <a key={t.key} href={t.href} aria-current={current} data-cms-nav="document" className={className}>
              {t.label}
            </a>
          )
        }
        return (
          <Link key={t.key} href={t.href} aria-current={current} className={className}>
            {t.label}
            <NavWatchdog href={t.href} />
          </Link>
        )
      })}
    </nav>
  )
}
