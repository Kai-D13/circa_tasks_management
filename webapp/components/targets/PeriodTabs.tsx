import Link from 'next/link'
import { cn } from '@/lib/utils'

// Day / Week / Month switcher for /targets. Server-rendered links (?period=) so
// there's no client JS — matches the no-JS card philosophy of the page.
export type TargetPeriod = 'day' | 'week' | 'month'

const TABS: { key: TargetPeriod; label: string }[] = [
  { key: 'day', label: 'Ngày' },
  { key: 'week', label: 'Tuần' },
  { key: 'month', label: 'Tháng' },
]

export function PeriodTabs({ period }: { period: TargetPeriod }) {
  return (
    // UI v2 K-6 (M5): segmented 3 ô chia đều cả bề ngang trong v2; ô đang chọn nền card (trung tính, như tab v2).
    <div className="inline-flex rounded-lg border bg-muted/40 p-0.5 text-sm v2:grid v2:w-full v2:grid-cols-3 v2:rounded-v2-control v2:border-0 v2:bg-muted v2:p-1">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={`/targets?period=${t.key}`}
          aria-current={period === t.key ? 'page' : undefined}
          className={cn(
            // [44px] PIXEL touch height on mobile (root 15px → rem lies);
            // desktop keeps the compact strip.
            'px-4 inline-flex items-center justify-center min-h-[44px] md:min-h-0 md:py-1.5 rounded-md font-medium transition-colors v2:rounded-[8px] v2:text-[14px]',
            period === t.key
              ? 'bg-background shadow-sm text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  )
}
