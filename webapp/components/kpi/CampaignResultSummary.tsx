import { Card, CardContent } from '@/components/ui/card'
import type { CampaignView } from '@/components/kpi/CampaignKpiView'
import { cn } from '@/lib/utils'
import { campaignPerformance, performanceTone } from '@/lib/kpi/performance'
import { metricPresentation, offlineOrderLine, REVENUE_LABELS } from '@/lib/kpi/campaignDisplay'
import { Target, TrendingUp, Percent, Wallet, Award, CalendarDays, Gauge, ClipboardCheck, Store as StoreIcon, Link2 as LinkIcon, type LucideIcon } from 'lucide-react'

// Store Manager "Kết quả" management block (r3): the same 6-card summary idiom
// as the super-admin campaign detail Result tab, but scoped to the manager's OWN
// store (one actual row). Read-only — SM has no config access. Reuses the
// already-fetched selected CampaignView, so no extra query.

export function CampaignResultSummary({ campaign, todayISO }: { campaign: CampaignView; todayISO: string }) {
  // Mig 103: format/label qua metricPresentation — gmv BYTE-EQUAL vnd cũ.
  const pres = metricPresentation(campaign.metric_type)
  const vnd = (n: number) => pres.value(n)
  // Commission LUÔN tiền (kể cả campaign Số khách).
  const money = (n: number) => metricPresentation('gmv').value(n)
  const target = campaign.kpi_target
  const synced = campaign.actual_value !== null
  const actual = campaign.actual_value ?? 0
  const pct = campaign.run_rate ?? (target > 0 ? (actual / target) * 100 : 0)
  const pool = campaign.store_commission_pool ?? 0
  const tierCount = campaign.tiers.length
  const reached = campaign.achieved_tier_order

  const daysLeft = Math.floor((Date.parse(campaign.end_date) - Date.parse(todayISO)) / 86400_000) + 1
  const deadlineLabel = daysLeft <= 0 ? 'Đã kết thúc' : `Còn ${daysLeft} ngày`
  const perf = campaignPerformance(target, campaign.actual_value, campaign.start_date, campaign.end_date, todayISO)

  const cards: { label: string; value: string; icon: LucideIcon; tile: string; valueCls?: string; bar?: boolean; sub?: string | null }[] = [
    { label: 'KPI target', value: vnd(target), icon: Target, tile: 'bg-primary/10 text-primary' },
    { label: pres.actualColumnLabel, value: synced ? vnd(actual) : '—', icon: TrendingUp,
      // 105: campaign offline-only → dòng phụ số đơn · AOV ở card này (hybrid
      // có card GMV Offline riêng bên dưới); campaign khách KHÔNG hiện.
      sub: synced && campaign.metric_offline && !campaign.metric_affiliate
        ? offlineOrderLine(campaign.actual_offline ?? actual, campaign.offline_order_count ?? null) : null,
      tile: synced && actual > 0 ? 'bg-status-success-bg text-status-success' : 'bg-muted text-muted-foreground' },
    // P3-E: breakdown 2 nguồn — CHỈ khi campaign bật cả 2 chỉ số (1 metric giữ
    // layout cũ nguyên vẹn).
    ...(campaign.metric_offline && campaign.metric_affiliate ? [
      { label: REVENUE_LABELS.offline, value: synced ? vnd(campaign.actual_offline ?? 0) : '—', icon: StoreIcon as LucideIcon,
        // 105: dòng phụ số đơn · AOV cho QLCH (cùng formatter Super/SM).
        sub: synced ? offlineOrderLine(campaign.actual_offline ?? 0, campaign.offline_order_count ?? null) : null,
        tile: 'bg-primary/10 text-primary' },
      { label: REVENUE_LABELS.affiliate, value: synced ? vnd(campaign.actual_affiliate ?? 0) : '—', icon: LinkIcon as LucideIcon,
        tile: 'bg-muted text-muted-foreground' },
    ] : []),
    { label: 'Hoàn thành', value: synced ? `${pct.toFixed(1)}%` : '—', icon: Percent,
      tile: 'bg-primary/10 text-primary', bar: true,
      valueCls: !synced ? undefined : pct >= 100 ? 'text-status-success' : 'text-primary' },
    { label: 'Commission Store dự kiến', value: synced ? money(pool) : '—', icon: Wallet,
      tile: synced && pool > 0 ? 'bg-status-success-bg text-status-success' : 'bg-muted text-muted-foreground',
      valueCls: synced && pool > 0 ? 'text-status-success' : undefined },
    { label: 'Bậc đạt', value: reached != null ? `Bậc ${reached}/${tierCount}` : (synced ? 'Chưa đạt' : '—'), icon: Award,
      tile: reached != null ? 'bg-status-success-bg text-status-success' : 'bg-muted text-muted-foreground' },
    { label: 'Nhịp độ (Performance)', value: perf != null ? `${perf.toFixed(1)}%` : '—', icon: Gauge,
      tile: 'bg-primary/10 text-primary', valueCls: perf != null ? performanceTone(perf) : undefined },
    { label: 'Thời hạn', value: deadlineLabel, icon: CalendarDays, tile: 'bg-muted text-muted-foreground' },
  ]

  return (
    <Card className="rounded-lg">
      <CardContent className="p-4 space-y-3">
        <p className="flex items-center gap-1.5 font-semibold text-sm">
          <ClipboardCheck className="h-4 w-4 text-primary" /> Kết quả chiến dịch · Quản lý cửa hàng
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
          {cards.map((card) => (
            <div key={card.label} className="rounded-lg border p-2.5">
              <div className="flex items-start gap-2">
                <span className={cn('h-7 w-7 rounded-full flex items-center justify-center shrink-0', card.tile)}>
                  <card.icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] text-muted-foreground uppercase leading-tight truncate">{card.label}</p>
                  <p className={cn('text-sm font-bold mt-0.5 leading-tight', card.valueCls)}>{card.value}</p>
                  {/* 105: dòng phụ số đơn · AOV Offline */}
                  {card.sub && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{card.sub}</p>}
                  {card.bar && synced && (
                    <div className="mt-1 h-1 rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn('h-full rounded-full', pct >= 100 ? 'bg-status-success' : 'bg-primary')}
                        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
