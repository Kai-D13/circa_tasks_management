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
    <div className="inline-flex rounded-lg border bg-muted/40 p-0.5 text-sm">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={`/targets?period=${t.key}`}
          className={cn(
            'px-4 py-1.5 rounded-md font-medium transition-colors',
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
