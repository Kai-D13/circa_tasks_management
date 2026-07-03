import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { Target, CheckCircle2, Circle } from 'lucide-react'

// Staff / Store Manager campaign KPI view: campaign tabs (replace the old
// Ngày/Tuần/Tháng tabs when campaigns exist) + one gradient KPI card + the tier
// ladder ("các bậc thưởng"). Server component — tabs are plain links
// (?campaign=<id>), no client JS.

export interface CampaignTierView { tier_order: number; threshold_pct: number; commission_amount: number }
export interface CampaignView {
  id: string
  name: string
  start_date: string
  end_date: string
  kpi_target: number
  store_kpi_group: string | null     // policy classification label (email 07/2026)
  tiers: CampaignTierView[]
  actual_value: number | null        // null = chưa đồng bộ
  run_rate: number | null
  remaining_target: number | null
  achieved_tier_order: number | null
  store_commission_pool: number | null
  synced_at: string | null
}

const vnd = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${new Intl.NumberFormat('vi-VN').format(Math.round(n))}₫`

export function CampaignKpiView({ items, selectedId }: { items: CampaignView[]; selectedId?: string }) {
  const sel = items.find((i) => i.id === selectedId) ?? items[0]
  const target = sel.kpi_target
  const actual = sel.actual_value ?? 0
  const pct = sel.run_rate ?? (target > 0 ? (actual / target) * 100 : 0)
  const remaining = sel.remaining_target ?? Math.max(target - actual, 0)
  const achieved = target > 0 && actual >= target
  const tiers = [...sel.tiers].sort((a, b) => a.tier_order - b.tier_order)
  // Highest tier reached (from snapshot if synced; else derived from run rate).
  const reachedOrder = sel.achieved_tier_order
    ?? tiers.filter((t) => t.threshold_pct <= pct).map((t) => t.tier_order).pop()
    ?? null
  const reachedTier = tiers.find((t) => t.tier_order === reachedOrder) ?? null
  const expectedPool = sel.store_commission_pool ?? reachedTier?.commission_amount ?? 0
  const nextTier = tiers.find((t) => t.threshold_pct > pct) ?? null

  return (
    <div className="space-y-4">
      {/* Campaign tabs — one per active campaign of this store */}
      {items.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {items.map((i) => (
            <Link
              key={i.id}
              href={`/targets?campaign=${i.id}`}
              className={cn(
                'text-xs px-3 py-1.5 rounded-full border font-medium transition-colors',
                i.id === sel.id
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {i.name}
            </Link>
          ))}
        </div>
      )}

      {/* Gradient KPI card (mirrors the day/week/month card style) */}
      <div className="rounded-xl bg-gradient-to-br from-primary to-orange-600 text-white p-4 space-y-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 font-semibold text-sm uppercase tracking-wide">
              <Target className="h-4 w-4 shrink-0" />
              <span className="truncate">{sel.name}</span>
            </p>
            <p className="text-xs text-white/80 mt-0.5">
              {formatDate(sel.start_date)} – {formatDate(sel.end_date)}
              {sel.store_kpi_group ? ` · Nhóm: ${sel.store_kpi_group}` : ''}
            </p>
          </div>
          {/* "Đạt KPI 100%" (not "mục tiêu") — a store at 90–99% already earns a
              tier-90 pool, so a generic "chưa đạt" badge would read as a dispute. */}
          <span className={cn(
            'text-xs px-2 py-0.5 rounded font-medium shrink-0',
            achieved ? 'bg-green-100 text-green-700' : 'bg-white/20 text-white',
          )}>
            {achieved ? 'Đạt KPI 100%' : 'Chưa đạt KPI 100%'}
          </span>
        </div>

        <div>
          <p className="text-xs uppercase text-white/80">Còn thiếu</p>
          <p className="text-3xl font-bold leading-tight">{achieved ? '0₫' : vnd(remaining)}</p>
          <p className="text-xs text-white/80 mt-0.5">để đạt KPI chiến dịch</p>
        </div>

        <div className="space-y-1.5">
          <p className="text-right text-xs font-semibold">{pct.toFixed(1)}%</p>
          <div className="h-2.5 w-full rounded-full bg-white/25 overflow-hidden">
            <div className="h-full rounded-full bg-white" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
          </div>
          <div className="flex items-end justify-between text-xs">
            <div>
              <p className="font-semibold text-sm">{sel.actual_value === null ? 'Chưa đồng bộ' : vnd(actual)}</p>
              <p className="text-white/80">Đã đạt</p>
            </div>
            <div className="text-right">
              <p className="font-semibold text-sm">{vnd(target)}</p>
              <p className="text-white/80">KPI target</p>
            </div>
          </div>
        </div>
      </div>

      {/* Tier ladder — các bậc thưởng */}
      {tiers.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-2.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="font-semibold text-sm">Các bậc thưởng</p>
              <p className="text-sm">
                <span className="text-muted-foreground">Quỹ thưởng Store dự kiến: </span>
                <span className={cn('font-bold', expectedPool > 0 ? 'text-green-600' : 'text-muted-foreground')}>
                  {vnd(expectedPool)}
                </span>
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              Đây là <span className="font-medium">tổng quỹ commission của Store</span>, chưa phải commission cá nhân — quỹ sẽ được phân bổ cho Dược sĩ theo thực công trong tháng.
            </p>
            <div className="space-y-1.5">
              {tiers.map((t) => {
                const reached = reachedOrder !== null && t.tier_order <= reachedOrder
                const isNext = nextTier?.tier_order === t.tier_order
                const gapToTier = Math.max((target * t.threshold_pct) / 100 - actual, 0)
                return (
                  <div
                    key={t.tier_order}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm',
                      reached ? 'border-green-200 bg-green-50' : isNext ? 'border-primary/40 bg-primary/5' : 'bg-muted/20',
                    )}
                  >
                    {reached
                      ? <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                      : <Circle className="h-4 w-4 text-muted-foreground/50 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <p className={cn('font-medium', reached && 'text-green-700')}>
                        Đạt {t.threshold_pct}% KPI → quỹ thưởng {vnd(t.commission_amount)}
                      </p>
                      {isNext && !achieved && gapToTier > 0 && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Còn thiếu {vnd(gapToTier)} để chạm bậc này
                        </p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-[11px] text-muted-foreground">
        {sel.synced_at ? `Cập nhật lúc ${formatDateTime(sel.synced_at)}` : 'Doanh số chưa được đồng bộ'} · Nguồn: báo cáo BI · * Không bao gồm đơn online
      </p>
    </div>
  )
}
