import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { CampaignDailyChart } from '@/components/kpi/CampaignDailyChart'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { Target, CalendarDays, TrendingUp, Wallet, Info, Gift } from 'lucide-react'

// Staff / Store Manager campaign view (stakeholder mockup):
//   hero (Mục tiêu GMV · Đã đạt · progress + % ring · Còn thiếu)
//   3 metric cards (Số ngày còn lại · Trung bình/ngày cần đạt · GMV hôm nay)
//   daily GMV chart · Thông tin áp dụng · Mốc thưởng (horizontal milestones)
// Server component — campaign tabs are links (?campaign=), no client JS.
// NO "Xem chi tiết KPI" button (explicit stakeholder note).

export interface CampaignTierView { tier_order: number; threshold_pct: number; commission_amount: number }
export interface CampaignView {
  id: string
  name: string
  start_date: string
  end_date: string
  kpi_target: number
  store_kpi_group: string | null
  tiers: CampaignTierView[]
  actual_value: number | null        // null = chưa đồng bộ
  run_rate: number | null
  remaining_target: number | null
  achieved_tier_order: number | null
  store_commission_pool: number | null
  synced_at: string | null
}
export interface DailyPoint { date: string; gmv: number }

const vnd = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${new Intl.NumberFormat('vi-VN').format(Math.round(n))}₫`

// % completion ring (server-rendered SVG, theme-aware via stroke tokens).
function Ring({ pct }: { pct: number }) {
  const r = 34
  const c = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="relative h-[92px] w-[92px] shrink-0">
      <svg width="92" height="92" viewBox="0 0 92 92" className="-rotate-90">
        <circle cx="46" cy="46" r={r} fill="none" strokeWidth="8" className="stroke-muted" />
        <circle
          cx="46" cy="46" r={r} fill="none" strokeWidth="8" strokeLinecap="round"
          className="stroke-primary"
          strokeDasharray={`${(clamped / 100) * c} ${c}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-bold leading-none">{Math.round(pct)}%</span>
        <span className="text-[9px] text-muted-foreground mt-0.5">hoàn thành</span>
      </div>
    </div>
  )
}

// Milestone position: tiers sit at even intervals; the "Hiện tại" marker is
// piecewise-interpolated between neighbouring thresholds so 72% lands visually
// between the nodes it is between numerically.
function markerFraction(pct: number, thresholds: number[], positions: number[]): number {
  if (thresholds.length === 0) return 0
  if (pct <= 0) return 0
  if (pct < thresholds[0]) return (pct / thresholds[0]) * positions[0]
  if (pct >= thresholds[thresholds.length - 1]) {
    const last = positions[positions.length - 1]
    const over = (pct - thresholds[thresholds.length - 1]) / Math.max(thresholds[thresholds.length - 1], 1)
    return Math.min(1, last + over * (1 - last))
  }
  for (let j = 0; j < thresholds.length - 1; j++) {
    if (pct >= thresholds[j] && pct < thresholds[j + 1]) {
      const f = (pct - thresholds[j]) / (thresholds[j + 1] - thresholds[j])
      return positions[j] + f * (positions[j + 1] - positions[j])
    }
  }
  return positions[positions.length - 1]
}

export function CampaignKpiView({
  items, selectedId, daily, roleLabel, todayISO,
}: {
  items: CampaignView[]
  selectedId?: string
  daily: DailyPoint[]
  roleLabel: string
  todayISO: string
}) {
  const sel = items.find((i) => i.id === selectedId) ?? items[0]
  const target = sel.kpi_target
  const actual = sel.actual_value ?? 0
  const pct = sel.run_rate ?? (target > 0 ? (actual / target) * 100 : 0)
  const remaining = sel.remaining_target ?? Math.max(target - actual, 0)
  const achieved = target > 0 && actual >= target

  // Metric cards.
  const daysLeft = Math.floor((Date.parse(sel.end_date) - Date.parse(todayISO)) / 86400_000) + 1
  const campaignOver = daysLeft <= 0
  const needPerDay = campaignOver || achieved ? 0 : remaining / Math.max(daysLeft, 1)
  const todayGmv = daily.find((d) => d.date === todayISO)?.gmv ?? null

  // Tier milestones.
  const tiers = [...sel.tiers].sort((a, b) => a.tier_order - b.tier_order)
  const thresholds = tiers.map((t) => t.threshold_pct)
  const positions = tiers.map((_, i) => (i + 1) / (tiers.length + 1))
  const frac = markerFraction(pct, thresholds, positions)
  const reachedOrder = sel.achieved_tier_order
    ?? tiers.filter((t) => t.threshold_pct <= pct).map((t) => t.tier_order).pop()
    ?? null
  const reachedTier = tiers.find((t) => t.tier_order === reachedOrder) ?? null
  const expectedPool = sel.store_commission_pool ?? reachedTier?.commission_amount ?? 0
  const nextTier = tiers.find((t) => t.threshold_pct > pct) ?? null

  return (
    <div className="space-y-4">
      {/* Campaign tabs */}
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

      {/* ── Hero: mục tiêu / đã đạt / progress / ring / còn thiếu ── */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">Mục tiêu GMV</p>
              <p className="text-2xl font-bold text-primary leading-tight">{vnd(target)}</p>
              <p className="text-xs text-muted-foreground mt-2">Đã đạt</p>
              <p className="text-2xl font-bold text-green-600 leading-tight">
                {sel.actual_value === null ? 'Chưa đồng bộ' : vnd(actual)}
              </p>
            </div>
            <Ring pct={pct} />
          </div>
          <div className="flex items-center gap-2">
            <div className="h-2.5 flex-1 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
            </div>
            <span className="text-xs font-semibold">{pct.toFixed(0)}%</span>
          </div>
          <p className="flex items-center gap-1.5 text-sm border-t pt-3">
            <Target className="h-4 w-4 text-primary shrink-0" />
            <span className="text-muted-foreground">Còn thiếu:</span>
            <span className="font-bold text-primary">{achieved ? '0₫' : vnd(remaining)}</span>
          </p>
        </CardContent>
      </Card>

      {/* ── 3 metric cards ── */}
      <div className="grid grid-cols-3 gap-2">
        <Card>
          <CardContent className="p-3 text-center">
            <CalendarDays className="h-4 w-4 mx-auto text-primary" />
            <p className="text-[10px] text-muted-foreground mt-1">Số ngày còn lại</p>
            <p className="text-sm font-bold mt-0.5">{campaignOver ? 'Đã kết thúc' : `${daysLeft} ngày`}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <TrendingUp className="h-4 w-4 mx-auto text-primary" />
            <p className="text-[10px] text-muted-foreground mt-1">Trung bình/ngày cần đạt</p>
            <p className="text-sm font-bold mt-0.5">{achieved ? '0₫' : campaignOver ? '—' : vnd(needPerDay)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <Wallet className="h-4 w-4 mx-auto text-green-600" />
            <p className="text-[10px] text-muted-foreground mt-1">GMV hôm nay</p>
            <p className="text-sm font-bold mt-0.5">{todayGmv !== null ? vnd(todayGmv) : '—'}</p>
          </CardContent>
        </Card>
      </div>

      {/* ── Tiến độ theo ngày ── */}
      <Card>
        <CardContent className="p-4">
          <p className="font-semibold text-sm mb-2">Tiến độ theo ngày</p>
          {daily.length > 0 ? (
            <CampaignDailyChart start={sel.start_date} end={sel.end_date} daily={daily} todayISO={todayISO} />
          ) : (
            <p className="text-sm text-muted-foreground py-6 text-center">Chưa có dữ liệu doanh số theo ngày.</p>
          )}
        </CardContent>
      </Card>

      {/* ── Thông tin áp dụng ── */}
      <Card>
        <CardContent className="p-4">
          <p className="flex items-center gap-1.5 font-semibold text-sm mb-2">
            <Info className="h-4 w-4 text-primary" /> Thông tin áp dụng
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 text-sm">
            <p className="py-1"><span className="text-muted-foreground">Chiến dịch: </span><span className="font-medium text-primary">{sel.name}</span></p>
            <p className="py-1"><span className="text-muted-foreground">Phân loại store: </span><span className="font-medium">{sel.store_kpi_group ?? '—'}</span></p>
            <p className="py-1"><span className="text-muted-foreground">Thời gian áp dụng: </span><span className="font-medium">{formatDate(sel.start_date)} – {formatDate(sel.end_date)}</span></p>
            <p className="py-1"><span className="text-muted-foreground">Vị trí của bạn: </span><span className="font-medium">{roleLabel}</span></p>
          </div>
        </CardContent>
      </Card>

      {/* ── Mốc thưởng (horizontal milestones) ── */}
      {tiers.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="flex items-center gap-1.5 font-semibold text-sm">
                <Gift className="h-4 w-4 text-primary" /> Mốc thưởng
              </p>
              <p className="text-sm">
                <span className="text-muted-foreground">Commission Store dự kiến: </span>
                <span className={cn('font-bold', expectedPool > 0 ? 'text-green-600' : 'text-muted-foreground')}>
                  {vnd(expectedPool)}
                </span>
              </p>
            </div>

            {/* Track + nodes + current marker */}
            <div className="px-2 pt-6 pb-1">
              <div className="relative">
                <span
                  className="absolute -top-6 -translate-x-1/2 whitespace-nowrap rounded-full bg-green-600 text-white text-[10px] font-semibold px-2 py-0.5"
                  style={{ left: `${frac * 100}%` }}
                >
                  Hiện tại: {pct.toFixed(0)}%
                </span>
                <div className="h-1.5 rounded-full bg-muted" />
                <div className="absolute top-0 h-1.5 rounded-full bg-primary" style={{ width: `${frac * 100}%` }} />
                {tiers.map((t, i) => {
                  const reached = reachedOrder !== null && t.tier_order <= reachedOrder
                  return (
                    <span
                      key={t.tier_order}
                      className={cn(
                        'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-3.5 w-3.5 rounded-full border-2',
                        reached ? 'bg-primary border-primary' : 'bg-background border-muted-foreground/40',
                      )}
                      style={{ left: `${positions[i] * 100}%` }}
                    />
                  )
                })}
              </div>
            </div>

            {/* Tier boxes */}
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(tiers.length, 4)}, minmax(0, 1fr))` }}>
              {tiers.map((t) => {
                const reached = reachedOrder !== null && t.tier_order <= reachedOrder
                const isNext = nextTier?.tier_order === t.tier_order
                return (
                  <div
                    key={t.tier_order}
                    className={cn(
                      'rounded-lg border p-2 text-center',
                      reached ? 'border-green-300 bg-green-50' : isNext ? 'border-primary/50 bg-primary/5' : 'bg-muted/20',
                    )}
                  >
                    <p className={cn('text-base font-bold', reached ? 'text-green-700' : isNext ? 'text-primary' : '')}>{t.threshold_pct}%</p>
                    <p className="text-[10px] text-muted-foreground">Thưởng: <span className="font-semibold text-foreground">{vnd(t.commission_amount)}</span></p>
                  </div>
                )
              })}
            </div>

            <p className="text-xs text-muted-foreground">
              Đây là <span className="font-medium">tổng commission của Store</span>, chưa phải commission cá nhân — sẽ được phân bổ cho Dược sĩ theo thực công trong tháng.
            </p>
          </CardContent>
        </Card>
      )}

      <p className="text-[11px] text-muted-foreground">
        {sel.synced_at ? `Cập nhật lúc ${formatDateTime(sel.synced_at)}` : 'Doanh số chưa được đồng bộ'} · Nguồn: báo cáo BI · * Không bao gồm đơn online
      </p>
    </div>
  )
}
