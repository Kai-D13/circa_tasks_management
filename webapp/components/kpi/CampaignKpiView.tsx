import { Card, CardContent } from '@/components/ui/card'
import { breakdownModel, campaignFootnote, metricPresentation, orderAovMetricLines } from '@/lib/kpi/campaignDisplay'
import { ORDER_AOV_STATUS_LABEL, orderAovStatus, qualityKpiPass } from '@/lib/kpi/orderAov'
import { buildTierProgress, type TierProgress } from '@/lib/kpi/resultModel'
import { CampaignDailyChart } from '@/components/kpi/CampaignDailyChart'
import { CampaignPicker } from '@/components/kpi/CampaignPicker'
import { requiredPerDay } from '@/lib/kpi/performance'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { Target, CalendarDays, TrendingUp, Wallet, Info, Gift, Store, Link2 as LinkIcon } from 'lucide-react'

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
  actual_value: number | null        // null = chưa đồng bộ; = offline + affiliate (P3-E)
  run_rate: number | null
  remaining_target: number | null
  achieved_tier_order: number | null
  store_commission_pool: number | null
  synced_at: string | null
  // P3-E: metric flags + breakdown 2 nguồn + timestamp TỪNG nguồn.
  // Campaign 1 metric → layout cũ giữ nguyên; cả 2 → thêm khối "Phân loại theo
  // chỉ số". Legacy row (chưa sync dưới schema mới) có offline = actual_value.
  metric_offline: boolean
  metric_affiliate: boolean
  actual_offline: number | null
  actual_affiliate: number | null
  // 105: số đơn Offline (BQ no_order) — NULL = chưa có số đơn (KHÁC 0).
  // CHỈ dùng cho khối "Kết quả" của QLCH; card Staff KHÔNG đổi.
  offline_order_count?: number | null
  offline_synced_at: string | null
  affiliate_synced_at: string | null
  // Mig 103: 'affiliate_customer_count' → label/đơn vị KHÁCH qua
  // metricPresentation; thiếu (caller cũ) = gmv, hiển thị y nguyên.
  metric_type?: string
  // Mig 106 (Chất lượng bán hàng): 2 sàn + 2 mục tiêu + kết quả 2 sàn.
  order_floor?: number | null
  aov_floor?: number | null
  order_target?: number | null
  aov_target?: number | null
  quality_floor_pass?: boolean | null
}
// gmv = Offline, gmv_affiliate = Affiliate — chart hiển thị TỔNG, giữ riêng
// 2 nguồn cho tooltip breakdown + stacked chart sau này.
export interface DailyPoint { date: string; gmv: number; gmv_affiliate: number; affiliate_customer_count?: number }

// Short dd/MM for the campaign-chip date range.
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

// % completion ring (server-rendered SVG, theme-aware via stroke tokens).
// Green is reserved for a REACHED commission tier (or >=100%) — on a
// commission screen, a green 8% would read as "already achieved".
function Ring({ pct, tierReached }: { pct: number; tierReached: boolean }) {
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
        <span className={cn('text-lg font-bold leading-none', tierReached ? 'text-status-success' : clamped > 0 && 'text-primary')}>
          {Math.round(pct)}%
        </span>
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
  items, selectedId, daily, dailyError = false, roleLabel, todayISO, storeName,
  showTierRemaining = false,
}: {
  items: CampaignView[]
  selectedId?: string
  daily: DailyPoint[]
  dailyError?: boolean
  roleLabel: string
  todayISO: string
  storeName: string
  // Tier progress (28/07): QLCH desktop ≥1024px thêm "Còn thiếu" vào từng ô
  // Mốc thưởng; Staff dùng chung component nhưng prop TẮT → UI Staff không
  // đổi; mobile mọi role giữ nguyên (dòng bổ sung hidden dưới lg).
  showTierRemaining?: boolean
}) {
  const sel = items.find((i) => i.id === selectedId) ?? items[0]
  // Mig 103: format/label tập trung — gmv cho output BYTE-EQUAL vnd cũ.
  const pres = metricPresentation(sel.metric_type)
  // Mig 106: dòng "thực tế / mục tiêu · sàn" + trạng thái — dùng CHUNG helper
  // với bảng desktop để Staff và Super không bao giờ đọc ra 2 con số khác nhau.
  const qualityLines = orderAovMetricLines({
    actualOrder: sel.offline_order_count ?? null,
    actualNet: sel.actual_offline,
    orderFloor: sel.order_floor, orderTarget: sel.order_target,
    aovFloor: sel.aov_floor, aovTarget: sel.aov_target,
  })
  const qualityPass = qualityKpiPass(sel.quality_floor_pass, sel.actual_value)
  const qualityStatus = qualityLines && sel.actual_value !== null && sel.offline_order_count != null
    ? orderAovStatus({
      actualOrder: sel.offline_order_count,
      orderFloorPass: sel.offline_order_count >= Number(sel.order_floor),
      aovFloorPass: sel.offline_order_count > 0
        && (Number(sel.actual_offline) || 0) / sel.offline_order_count >= Number(sel.aov_floor),
      completionPct: Number(sel.actual_value) || 0,
    })
    : null
  const qualityLabel = qualityStatus ? ORDER_AOV_STATUS_LABEL[qualityStatus] : null
  const vnd = pres.value
  // Commission LUÔN là tiền (kể cả campaign Số khách — tier thưởng bằng VNĐ).
  const money = metricPresentation('gmv').value
  const isCustomer = pres.kind === 'affiliate_customer_count'
  const target = sel.kpi_target
  const actual = sel.actual_value ?? 0
  const pct = sel.run_rate ?? (target > 0 ? (actual / target) * 100 : 0)
  const remaining = sel.remaining_target ?? Math.max(target - actual, 0)
  const achieved = target > 0 && actual >= target

  // Metric cards.
  const daysLeft = Math.floor((Date.parse(sel.end_date) - Date.parse(todayISO)) / 86400_000) + 1
  const campaignOver = daysLeft <= 0
  // 10/08: công thức chuyển vào lib/kpi/performance (dùng chung với bảng kết
  // quả Super/SM) — truyền ĐÚNG `remaining` mà hero đang hiển thị
  // (remaining_target backend ưu tiên) để 2 khối trên cùng màn không lệch.
  // `?? 0` giữ giá trị số BẤT BIẾN như trước; JSX vẫn tự render 'Đã kết thúc'
  // → '—' khi campaignOver và pres.zero khi đã đạt (không đổi).
  const needPerDay = achieved ? 0 : (requiredPerDay({
    kpiTarget: target, actual: sel.actual_value ?? 0,
    remainingTarget: sel.remaining_target, endISO: sel.end_date, todayISO,
  }) ?? 0)
  // P3-E: "GMV hôm nay" = TỔNG 2 nguồn của ngày hôm nay.
  const todayPoint = daily.find((d) => d.date === todayISO)
  const todayGmv = todayPoint
    ? (isCustomer ? (todayPoint.affiliate_customer_count ?? 0) : todayPoint.gmv + todayPoint.gmv_affiliate)
    : null

  // P3-E r1: contract breakdown/footnote nằm trong lib/kpi/campaignDisplay
  // (THUẦN, có test khóa) — 1 chỉ số → layout hiện tại giữ nguyên tuyệt đối.
  const bd = breakdownModel(sel)
  const showBreakdown = bd.show

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

  // Tier progress (28/07): CÙNG công thức với bảng Super/SM (buildTierProgress
  // — resultModel): target bậc = ceil(kpi_target × pct/100); backend đã xác
  // nhận đạt → remaining ép 0; CHƯA SYNC → null (hiện '—', không phải 0).
  const tierProgressByOrder = new Map<number, TierProgress>(
    showTierRemaining
      ? buildTierProgress(
          target,
          sel.actual_value === null
            ? null
            : { actual_value: sel.actual_value, achieved_tier_order: sel.achieved_tier_order },
          tiers,
        ).map((tp) => [tp.tier_order, tp])
      : [],
  )
  const tierRemainingLine = (order: number) => {
    if (!showTierRemaining) return null
    const tp = tierProgressByOrder.get(order)
    if (!tp) return null
    return (
      <p className="hidden lg:block text-[10px] mt-0.5">
        {tp.remaining_amount === null ? (
          <span className="text-muted-foreground">Còn thiếu: —</span>
        ) : tp.reached ? (
          <span className="font-semibold text-status-success">Đã đạt</span>
        ) : (
          <span className="text-muted-foreground">Còn thiếu: <span className="font-semibold text-primary">{vnd(tp.remaining_amount)}</span></span>
        )}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {/* ── Campaign header (review r3, per mockup): the SELECTED campaign is
             the screen's focus — its name is the title, with a date pill that
             opens the picker (scales to 3-5 long-named campaigns where the old
             chip row broke down) and a store pill. ── */}
      <div className="space-y-2">
        <h2 className="text-lg font-bold leading-snug">{sel.name}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <CampaignPicker
            items={items.map((i) => {
              const dl = Math.floor((Date.parse(i.end_date) - Date.parse(todayISO)) / 86400_000) + 1
              return {
                id: i.id,
                name: i.name,
                rangeLabel: `${dm(i.start_date)} – ${dm(i.end_date)}`,
                statusLabel: dl <= 0 ? 'Đã kết thúc' : `Còn ${dl} ngày`,
                pctLabel: i.run_rate !== null ? `${Math.round(i.run_rate)}%` : null,
              }
            })}
            selectedId={sel.id}
          />
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground max-w-[220px]">
            <Store className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="truncate">{storeName}</span>
          </span>
        </div>
      </div>

      {/* ── Hero: mục tiêu / đã đạt / progress / ring / còn thiếu ──
          Brand-tinted flat background (template hero is a warm cream card;
          guide says no heavy gradients) */}
      <Card className="rounded-lg border-primary/20 bg-secondary">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">{pres.targetLabel}</p>
              <p className="text-2xl font-bold text-primary leading-tight">{vnd(target)}</p>
              <p className="text-xs text-muted-foreground mt-2">Đã đạt</p>
              <p className="text-2xl font-bold text-status-success leading-tight">
                {sel.actual_value === null ? 'Chưa đồng bộ' : vnd(actual)}
              </p>
            </div>
            <Ring pct={pct} tierReached={reachedOrder !== null || pct >= 100} />
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
            <span className="font-bold text-primary">{achieved ? pres.zero : vnd(remaining)}</span>
          </p>
        </CardContent>
      </Card>

      {/* ── Mig 106: Chất lượng bán hàng — 2 chỉ số với SÀN bắt buộc.
             Hero phía trên đã là ĐIỂM hoàn thành (%); khối này cho biết vì sao:
             số đơn/AOV thực tế so với mục tiêu và SÀN + trạng thái. ── */}
      {qualityLines && (
        <Card className="rounded-lg">
          <CardContent className="p-4 space-y-2.5">
            <p className="text-sm font-semibold">Chất lượng bán hàng</p>
            <div className="space-y-1.5 text-sm">
              <div className="flex items-start justify-between gap-3">
                <span className="text-muted-foreground shrink-0">Số đơn</span>
                <span className="text-right font-medium">{qualityLines.order}</span>
              </div>
              <div className="flex items-start justify-between gap-3">
                <span className="text-muted-foreground shrink-0">AOV</span>
                <span className="text-right font-medium">{qualityLines.aov}</span>
              </div>
            </div>
            {qualityLabel && (
              <p className="text-xs">
                <span className={cn(
                  'inline-block px-2 py-0.5 rounded-full font-medium',
                  qualityPass ? 'bg-green-100 text-green-700'
                    : sel.quality_floor_pass ? 'bg-primary/10 text-primary'
                    : 'bg-amber-100 text-amber-700',
                )}>{qualityLabel}</span>
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">
              Điểm hoàn thành = 90% số đơn + 10% AOV (so với sàn). Phải đạt CẢ HAI sàn mới được xét bậc thưởng.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── P3-E: Phân loại theo chỉ số (CHỈ khi campaign bật cả 2 nguồn) —
             mỗi nguồn: giá trị · % trên CÙNG kpi_target · mốc đồng bộ riêng.
             Không chevron (chưa có trang chi tiết — audit P3-E). ── */}
      {showBreakdown && (
        <Card className="rounded-lg">
          <CardContent className="p-4 space-y-3">
            <p className="font-semibold text-sm">Phân loại theo chỉ số</p>
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Store className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-tight">GMV Offline</p>
                <p className="text-xs text-muted-foreground">Doanh số bán tại cửa hàng{sel.offline_synced_at ? ` · đồng bộ ${formatDateTime(sel.offline_synced_at)}` : ''}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-bold text-primary">{vnd(sel.actual_offline)}</p>
                <p className="text-xs text-muted-foreground">{bd.offlinePct !== null ? `${bd.offlinePct}% / ${vnd(target)}` : '—'}</p>
              </div>
            </div>
            <div className="flex items-start gap-3 border-t pt-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#a3b2bf]/20 text-[#5b6b7a] dark:text-[#a3b2bf]">
                <LinkIcon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-tight">GMV Affiliate</p>
                <p className="text-xs text-muted-foreground">Doanh số từ Circa Online (theo mã đối tác){sel.affiliate_synced_at ? ` · đồng bộ ${formatDateTime(sel.affiliate_synced_at)}` : ''}</p>
              </div>
              {/* Stakeholder 24/07: dòng Affiliate KHÔNG hiện "% / target"
                  (share chung kpi_target → % luôn ≈0 gây hiểu nhầm). */}
              <div className="text-right shrink-0">
                <p className="text-sm font-bold">{vnd(sel.actual_affiliate)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── 3 metric cards — solid colored icon circles per template
             (brand triad: blue-grey / coral / green) ── */}
      <div className="grid grid-cols-3 gap-2">
        <Card className="rounded-lg">
          <CardContent className="p-3 text-center">
            <span className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <CalendarDays className="h-4 w-4" />
            </span>
            {/* Inclusive rule (today counts — the store still sells today), so the
                label says "ngày bán" to keep the TB/ngày math uncontested. */}
            <p className="text-[11px] text-muted-foreground mt-1.5">Số ngày bán còn lại</p>
            <p className="text-sm font-bold mt-0.5">{campaignOver ? 'Đã kết thúc' : `${daysLeft} ngày`}</p>
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardContent className="p-3 text-center">
            <span className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <TrendingUp className="h-4 w-4" />
            </span>
            <p className="text-[11px] text-muted-foreground mt-1.5">Trung bình/ngày cần đạt</p>
            <p className="text-sm font-bold mt-0.5 text-primary">{achieved ? pres.zero : campaignOver ? '—' : vnd(needPerDay)}</p>
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardContent className="p-3 text-center">
            <span className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-status-success-bg text-status-success">
              <Wallet className="h-4 w-4" />
            </span>
            <p className="text-[11px] text-muted-foreground mt-1.5">{pres.todayLabel}</p>
            <p className={cn('text-sm font-bold mt-0.5', todayGmv !== null && todayGmv > 0 && 'text-status-success')}>
              {todayGmv !== null ? vnd(todayGmv) : '—'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Tiến độ theo ngày ── */}
      <Card className="rounded-lg">
        <CardContent className="p-4">
          <p className="font-semibold text-sm mb-2">Tiến độ theo ngày</p>
          {daily.length > 0 ? (
            <CampaignDailyChart start={sel.start_date} end={sel.end_date} daily={daily} todayISO={todayISO} breakdown={showBreakdown} metricType={sel.metric_type} />
          ) : (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {dailyError
                ? 'Chưa tải được tiến độ theo ngày, vui lòng thử lại sau.'
                : isCustomer ? 'Chưa có dữ liệu số khách theo ngày.' : 'Chưa có dữ liệu doanh số theo ngày.'}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Thông tin áp dụng ── */}
      <Card className="rounded-lg">
        <CardContent className="p-4">
          <p className="flex items-center gap-1.5 font-semibold text-sm mb-2">
            <Info className="h-4 w-4 text-primary" /> Thông tin áp dụng
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 text-sm">
            <p className="py-1"><span className="text-muted-foreground">Chiến dịch: </span><span className="font-medium text-primary">{sel.name}</span></p>
            <p className="py-1"><span className="text-muted-foreground">Phân loại store: </span><span className="font-medium">{sel.store_kpi_group ?? '—'}</span></p>
            <p className="py-1"><span className="text-muted-foreground">Thời gian áp dụng: </span><span className="font-medium text-primary">{formatDate(sel.start_date)} – {formatDate(sel.end_date)}</span></p>
            <p className="py-1"><span className="text-muted-foreground">Vị trí của bạn: </span><span className="font-medium">{roleLabel}</span></p>
          </div>
        </CardContent>
      </Card>

      {/* ── Mốc thưởng (horizontal milestones) ── */}
      {tiers.length > 0 && (
        <Card className="rounded-lg">
          <CardContent className="p-4 space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="flex items-center gap-1.5 font-semibold text-sm">
                <Gift className="h-4 w-4 text-primary" /> Mốc thưởng
              </p>
              <p className="text-sm">
                <span className="text-muted-foreground">Commission Store dự kiến: </span>
                <span className={cn('font-bold', expectedPool > 0 ? 'text-status-success' : 'text-muted-foreground')}>
                  {money(expectedPool)}
                </span>
              </p>
            </div>

            {/* Track + nodes + current marker */}
            <div className="px-2 pt-6 pb-1">
              <div className="relative">
                <span
                  className="absolute -top-6 -translate-x-1/2 whitespace-nowrap rounded-full bg-status-success text-background text-[10px] font-semibold px-2 py-0.5"
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

            {/* Tier boxes — grid up to 4 tiers (template layout); 5+ tiers fall
                back to a vertical list so 360px never gets unreadable slivers */}
            {tiers.length <= 4 ? (
              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(tiers.length, 4)}, minmax(0, 1fr))` }}>
                {tiers.map((t) => {
                  const reached = reachedOrder !== null && t.tier_order <= reachedOrder
                  const isNext = nextTier?.tier_order === t.tier_order
                  return (
                    <div
                      key={t.tier_order}
                      className={cn(
                        'rounded-lg border p-2 text-center',
                        reached ? 'border-status-success/40 bg-status-success-bg' : isNext ? 'border-primary bg-secondary' : 'bg-muted/20',
                      )}
                    >
                      <p className={cn('text-base font-bold', reached ? 'text-status-success' : isNext ? 'text-primary' : '')}>{t.threshold_pct}%</p>
                      <p className="text-[10px] text-muted-foreground">Thưởng: <span className={cn('font-semibold', isNext ? 'text-primary' : 'text-foreground')}>{money(t.commission_amount)}</span></p>
                      {tierRemainingLine(t.tier_order)}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="space-y-1.5">
                {tiers.map((t) => {
                  const reached = reachedOrder !== null && t.tier_order <= reachedOrder
                  const isNext = nextTier?.tier_order === t.tier_order
                  return (
                    <div
                      key={t.tier_order}
                      className={cn(
                        'flex items-center justify-between gap-2 rounded-lg border px-3 py-2',
                        reached ? 'border-status-success/40 bg-status-success-bg' : isNext ? 'border-primary bg-secondary' : 'bg-muted/20',
                      )}
                    >
                      <p className={cn('text-sm font-bold', reached ? 'text-status-success' : isNext ? 'text-primary' : '')}>{t.threshold_pct}%</p>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Thưởng: <span className={cn('font-semibold', isNext ? 'text-primary' : 'text-foreground')}>{money(t.commission_amount)}</span></p>
                        {tierRemainingLine(t.tier_order)}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Đây là <span className="font-medium">tổng commission của Store</span>, chưa phải commission cá nhân — sẽ được phân bổ cho Dược sĩ theo thực công trong tháng.
            </p>
          </CardContent>
        </Card>
      )}

      {/* P3-E r1: chú thích nguồn từ campaignFootnote (contract có test) —
          offline-only giữ nguyên câu cũ; có affiliate → rule DELIVERED-only. */}
      <p className="text-[11px] text-muted-foreground">
        {sel.synced_at ? `Cập nhật lúc ${formatDateTime(sel.synced_at)}` : 'Doanh số chưa được đồng bộ'} · {campaignFootnote(sel)}
      </p>
    </div>
  )
}
