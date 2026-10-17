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
    <div className="flex gap-2 v2:w-fit v2:max-w-full v2:gap-1 v2:rounded-v2-control v2:bg-muted v2:p-1">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? 'page' : undefined}
          className={cn(
            'shrink-0 whitespace-nowrap text-sm px-3.5 inline-flex items-center min-h-[44px] md:min-h-0 md:py-1.5 rounded-full border font-medium transition-colors',
            'v2:rounded-[8px] v2:text-[13px] md:v2:h-[30px] md:v2:py-0',
            active === t.key
              ? 'border-primary bg-primary text-primary-foreground shadow-sm v2:border-input v2:bg-card v2:font-semibold v2:text-foreground v2:shadow-none'
              : 'border-border text-muted-foreground hover:text-primary hover:bg-primary/5 v2:border-transparent v2:hover:bg-transparent v2:hover:text-foreground',
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  )
}
