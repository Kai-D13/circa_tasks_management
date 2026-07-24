import Link from 'next/link'
import { cn } from '@/lib/utils'

// P3-I — tab row dùng chung cho /targets/campaigns ("Chiến dịch") và
// /targets/campaigns/affiliate ("Affiliate"). Server Link, không client JS.
// Tab Affiliate CHỈ hiện khi KPI_AFFILIATE_ENABLED (prop từ page — flag tắt
// thì trang campaigns giữ nguyên như cũ, không render hàng tab).
export function CampaignsTabs({ active, affiliateEnabled }: {
  active: 'campaigns' | 'affiliate'
  affiliateEnabled: boolean
}) {
  if (!affiliateEnabled) return null
  const tabs = [
    { key: 'campaigns' as const, label: 'Chiến dịch', href: '/targets/campaigns' },
    { key: 'affiliate' as const, label: 'Affiliate', href: '/targets/campaigns/affiliate' },
  ]
  return (
    <div className="flex gap-2">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? 'page' : undefined}
          className={cn(
            'shrink-0 whitespace-nowrap text-sm px-3.5 inline-flex items-center min-h-[44px] md:min-h-0 md:py-1.5 rounded-full border font-medium transition-colors',
            active === t.key
              ? 'border-primary bg-primary text-primary-foreground shadow-sm'
              : 'border-border text-muted-foreground hover:text-primary hover:bg-primary/5',
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  )
}
