import Link from 'next/link'
import { ChartNoAxesCombined, Target } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/ds/PageHeader'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { AffiliateQrCard } from '@/components/affiliate/AffiliateQrCard'
import { AffiliateGmvCard } from '@/components/affiliate/AffiliateGmvCard'
import { ReferralCard, type ReferralItem } from '@/components/referral/ReferralCard'
import { PeriodTabs, type TargetPeriod } from '@/components/targets/PeriodTabs'
import { CampaignCardList } from '@/components/kpi/CampaignCardList'
import { CampaignKpiView, type CampaignView, type DailyPoint, type DailySeries } from '@/components/kpi/CampaignKpiView'
import { CampaignResultSummary } from '@/components/kpi/CampaignResultSummary'
import { CampaignDateRangeFilter } from '@/components/kpi/CampaignDateRangeFilter'
import type { CampaignRange } from '@/lib/kpi/campaignDateRange'
import { formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'

// UI v2 Phase 2 · K-6 (canvas M1–M5) — phần TRÌNH BÀY nhánh staff + QLCH của /targets. page.tsx giữ nguyên auth, truy
// vấn (campaign views, daily, lọc khoảng, QR, GMV Affiliate, referral, store_kpi_targets) và mọi luật số; view chỉ
// nhận dữ liệu đã tính. Route thật và fixture /ui-catalog/kpi-v2/staff dùng chung. Chữ giữ nguyên bản cũ. Gốc
// data-ui-v2="page" + data-staff-targets. Staff giữ khung mobile max-w-xl; QLCH giữ khung desktop fluid 2 cột.

const vnd = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${new Intl.NumberFormat('vi-VN').format(Math.round(n))}₫`
const BACK_LINK = 'inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground min-h-[44px] md:min-h-0 -my-2.5 md:my-0'

type StaffKind = 'campaign-list' | 'campaign-detail' | 'period' | 'no-store' | 'error'
function StaffShell({ kind, children }: { kind: StaffKind; children: React.ReactNode }) {
  return (
    <div data-ui-v2="page" data-staff-targets={kind} className="p-4 space-y-4 max-w-xl mx-auto v2:space-y-3">
      {children}
    </div>
  )
}

/** Props của AffiliateQrCard (P3-H) + key để reset state khi đổi store/ảnh (qrCardKey). null ⇒ không render. */
export interface StaffQr {
  cardKey: string
  storeName: string
  partnerCode: string | null
  imageUrl: string | null
  destinationUrl: string | null
  queryError: boolean
}
function QrCard({ qr }: { qr: StaffQr | null }) {
  if (!qr) return null
  return (
    <AffiliateQrCard
      key={qr.cardKey}
      storeName={qr.storeName}
      partnerCode={qr.partnerCode}
      imageUrl={qr.imageUrl}
      destinationUrl={qr.destinationUrl}
      queryError={qr.queryError}
    />
  )
}

/** "Giới thiệu bạn bè" (staff_referrals) — 3 trạng thái cũ: có dữ liệu / lỗi / cờ bật nhưng thiếu SĐT. */
export interface StaffReferral {
  referral: { total: number; success: number; sameDay: number; noOrder: number; items: ReferralItem[] } | null
  error: boolean
  /** REFERRAL_ENABLED bật nhưng tài khoản chưa có số điện thoại. */
  phoneMissing: boolean
}
function ReferralBlock({ r }: { r: StaffReferral }) {
  return (
    <>
      {r.referral && <ReferralCard {...r.referral} />}
      {r.error && (
        <ErrorState message="Không tải được dữ liệu chương trình giới thiệu" hint="Vui lòng thử lại sau hoặc báo Admin." />
      )}
      {r.phoneMissing && (
        <Card className="rounded-lg">
          <CardContent className="py-4 text-sm text-muted-foreground">
            Cập nhật <span className="font-medium">số điện thoại</span> (biểu tượng &ldquo;Sửa thông tin&rdquo; ở đầu trang) để xem chương trình giới thiệu bạn bè.
          </CardContent>
        </Card>
      )}
    </>
  )
}

/** Dữ liệu CampaignKpiView (chi tiết) — y như page truyền. */
export interface StaffKpiProps {
  selectedId?: string
  daily: DailyPoint[]
  dailyError: boolean
  todayISO: string
  series: DailySeries
  seriesHrefBase?: string
}

/** Staff · chế độ chiến dịch (M1 danh sách / M2–M4 chi tiết). QR + Giới thiệu bạn bè chỉ ở landing (không ?campaign=). */
export function StaffCampaignView({ storeName, items, showList, hrefFor, listHref, kpi, landing, qr, referral }: {
  storeName: string
  items: CampaignView[]
  showList: boolean
  hrefFor: (id: string) => string
  listHref: string
  kpi: StaffKpiProps
  /** true khi KHÔNG có ?campaign= (landing): mới render QR + Giới thiệu bạn bè. */
  landing: boolean
  qr: StaffQr | null
  referral: StaffReferral
}) {
  return (
    <StaffShell kind={showList ? 'campaign-list' : 'campaign-detail'}>
      <PageHeader title="Doanh số chiến dịch" icon={ChartNoAxesCombined} />
      {showList ? (
        <CampaignCardList items={items} hrefFor={hrefFor} />
      ) : (
        <>
          <Link href={listHref} className={BACK_LINK}>← Danh sách chiến dịch</Link>
          <CampaignKpiView
            items={items} selectedId={kpi.selectedId} daily={kpi.daily}
            dailyError={kpi.dailyError} roleLabel="Dược sĩ" todayISO={kpi.todayISO}
            storeName={storeName}
            series={kpi.series} seriesHrefBase={kpi.seriesHrefBase}
          />
        </>
      )}
      {landing && (
        <>
          <QrCard qr={qr} />
          <ReferralBlock r={referral} />
        </>
      )}
    </StaffShell>
  )
}

/** Thẻ KPI kỳ (ngày/tuần/tháng) — chuyển nguyên từ targets/page.tsx (chữ + luật "không mục tiêu ⇒ không đã/chưa đạt"). */
function GoalBadge({ status, hasGoal = true }: { status: string | null; hasGoal?: boolean }) {
  const s = status?.toLowerCase()
  const known = s === 'achieved' || s === 'not achieved'
  if (!hasGoal || !known) {
    return (
      <span className="text-xs px-2 py-0.5 rounded font-medium bg-white/20 text-white whitespace-nowrap v2:rounded-v2-chip v2:bg-status-neutral-bg v2:text-status-neutral">
        Chưa có mục tiêu
      </span>
    )
  }
  const achieved = s === 'achieved'
  return (
    <span className={cn(
      'text-xs px-2 py-0.5 rounded font-medium whitespace-nowrap v2:rounded-v2-chip',
      achieved ? 'bg-white text-primary v2:bg-status-success-bg v2:text-status-success' : 'bg-white/20 text-white v2:bg-status-warning-bg v2:text-status-warning',
    )}>
      {achieved ? 'Đã đạt mục tiêu' : 'Chưa đạt mục tiêu'}
    </span>
  )
}

export interface PeriodSummary {
  noun: string
  label: string
  status: string | null
  hasGoal: boolean
  actual: number
  goal: number
  pct: number
  remaining: number | null
  achieved: boolean
  refreshedAt: string
}

// UI v2 (M5): ngoài v2 giữ thẻ gradient cũ; trong v2 = thẻ nền card, chữ thường, thanh màu chuỗi, 2 ô Đã đạt / Mục tiêu.
export function KpiSummaryCard({ noun, label, status, hasGoal, actual, goal, pct, remaining, achieved }: Omit<PeriodSummary, 'refreshedAt'>) {
  return (
    <div data-kpi-summary className="rounded-xl bg-gradient-to-br from-primary to-orange-600 text-white p-4 space-y-4 shadow-sm v2:rounded-v2-panel v2:border v2:bg-none v2:bg-card v2:text-foreground v2:shadow-none v2:p-5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 font-semibold text-sm uppercase tracking-wide v2:normal-case v2:tracking-normal v2:text-[15px]">
            <Target className="h-4 w-4 v2:hidden" />
            KPI {noun}
          </p>
          <p className="text-xs text-white/80 mt-0.5 v2:text-[12px] v2:text-muted-foreground">{label}</p>
        </div>
        <GoalBadge status={status} hasGoal={hasGoal} />
      </div>

      <div>
        <p className="text-xs uppercase text-white/80 v2:normal-case v2:text-[13px] v2:text-muted-foreground">Còn thiếu</p>
        <p className="text-3xl font-bold leading-tight v2:text-[30px] v2:tracking-[-0.01em]">
          {!hasGoal ? '—' : achieved ? '0₫' : vnd(remaining)}
        </p>
        <p className="text-xs text-white/80 mt-0.5 v2:text-[13px] v2:text-muted-foreground">để đạt mục tiêu {noun}</p>
      </div>

      <div className="space-y-1.5 v2:space-y-2.5">
        <p className="text-right text-xs font-semibold v2:text-left v2:text-[13px]">{pct.toFixed(1)}%</p>
        <div className="h-2.5 w-full rounded-full bg-white/25 overflow-hidden v2:bg-muted">
          <div className="h-full rounded-full bg-white v2:bg-primary" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
        </div>
        <div className="flex items-end justify-between text-xs v2:grid v2:grid-cols-2 v2:gap-2.5">
          <div className="v2:flex v2:flex-col-reverse v2:rounded-v2-control v2:bg-muted v2:p-3">
            <p className="font-semibold text-sm v2:mt-1 v2:text-[15px]">{vnd(actual)}</p>
            <p className="text-white/80 v2:text-muted-foreground v2:text-[12px]">Đã đạt</p>
          </div>
          <div className="text-right v2:flex v2:flex-col-reverse v2:rounded-v2-control v2:bg-muted v2:p-3 v2:text-left">
            <p className="font-semibold text-sm v2:mt-1 v2:text-[15px]">{hasGoal ? vnd(goal) : 'Chưa cập nhật'}</p>
            <p className="text-white/80 v2:text-muted-foreground v2:text-[12px]">Mục tiêu {noun}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Staff · không có chiến dịch ⇒ Ngày/Tuần/Tháng (M5). */
export function StaffPeriodView({ title, storeName, period, current, emptyMsg, qr, referral }: {
  title: string
  storeName: string
  period: TargetPeriod
  /** null ⇒ chưa có dữ liệu kỳ hiện tại (EmptyState emptyMsg). */
  current: PeriodSummary | null
  emptyMsg: string
  qr: StaffQr | null
  referral: StaffReferral
}) {
  return (
    <StaffShell kind="period">
      <PageHeader
        title={title}
        icon={ChartNoAxesCombined}
        actions={<span className="text-sm text-muted-foreground v2:rounded-v2-chip v2:bg-muted v2:px-2.5 v2:py-1 v2:text-[12px] v2:font-medium">{storeName}</span>}
      />
      <PeriodTabs period={period} />
      {!current ? (
        <EmptyState className="py-12" icon={ChartNoAxesCombined} title={emptyMsg} />
      ) : (
        <>
          <KpiSummaryCard
            noun={current.noun} label={current.label} status={current.status} hasGoal={current.hasGoal}
            actual={current.actual} goal={current.goal} pct={current.pct} remaining={current.remaining} achieved={current.achieved}
          />
          <p className="text-[11px] text-muted-foreground v2:text-[12px] v2:text-v2-text-3">
            Cập nhật lúc {formatDateTime(current.refreshedAt)} · Nguồn: báo cáo BI · * Không bao gồm đơn online
          </p>
        </>
      )}
      <QrCard qr={qr} />
      <ReferralBlock r={referral} />
    </StaffShell>
  )
}

/** Staff chưa gán cửa hàng / lỗi truy vấn store_kpi_targets — y như cũ. */
export function StaffStateView({ kind }: { kind: 'no-store' | 'error' }) {
  return (
    <StaffShell kind={kind}>
      <PageHeader title="Doanh số" icon={ChartNoAxesCombined} />
      {kind === 'no-store'
        ? <EmptyState title="Tài khoản chưa được gán cửa hàng" hint="Vui lòng liên hệ Admin." />
        : <ErrorState message="Không tải được dữ liệu doanh số" hint="Vui lòng thử lại sau hoặc báo Admin." />}
    </StaffShell>
  )
}

/** Dải GMV Affiliate của QLCH (bản card, cột phụ) — CHÍNH props AffiliateGmvCard. */
export interface ManagerGmv {
  monthLabel: string
  gmv: number
  orders: number
  syncedAt: string | null
  error: boolean
  sourceWarning: string | null
}

/** QLCH (store_manager) — khung desktop fluid, md+ 2 cột (nội dung chiến dịch + cột phụ QR/GMV), mobile 1 cột. */
export function ManagerTargetsView({ storeName, items, showList, hrefFor, listHref, kpi, selected, range, qr, gmv }: {
  storeName: string
  items: CampaignView[]
  showList: boolean
  hrefFor: (id: string) => string
  listHref: string
  kpi: StaffKpiProps
  /** Chiến dịch đang xem (CampaignResultSummary) — bắt buộc khi !showList và có chiến dịch. */
  selected: CampaignView | null
  /** Bộ lọc khoảng (QLCH được lọc) — null ⇒ không render. */
  range: { campaignStart: string; campaignEnd: string; range: CampaignRange; keepParams: Record<string, string | undefined>; note: string | null } | null
  qr: StaffQr | null
  gmv: ManagerGmv | null
}) {
  const side = qr || gmv
  return (
    <div data-ui-v2="page" data-layout-width="fluid" data-staff-targets={items.length === 0 ? 'manager-empty' : showList ? 'manager-list' : 'manager-detail'} className="p-4 md:p-6 space-y-4 v2:space-y-3 md:v2:space-y-[18px]">
      <PageHeader
        title="Doanh số chiến dịch"
        icon={ChartNoAxesCombined}
        /* Campaign view carries its own store pill (r3) — avoid duplicating */
        actions={items.length === 0 ? <span className="text-sm text-muted-foreground">{storeName}</span> : undefined}
      />
      <div className={cn('grid grid-cols-1 gap-4 items-start', side && 'md:grid-cols-[minmax(0,1fr)_340px]')}>
        <div className="space-y-4 min-w-0 v2:space-y-3">
          {items.length === 0 ? (
            <EmptyState className="py-12" icon={ChartNoAxesCombined} title="Hiện chưa có chiến dịch doanh số đang áp dụng." />
          ) : showList ? (
            <CampaignCardList items={items} hrefFor={hrefFor} />
          ) : (
            <>
              <Link href={listHref} className={BACK_LINK}>← Danh sách chiến dịch</Link>
              {selected && <CampaignResultSummary campaign={selected} todayISO={kpi.todayISO} />}
              {range && (
                <CampaignDateRangeFilter
                  action="/targets"
                  campaignStart={range.campaignStart}
                  campaignEnd={range.campaignEnd}
                  range={range.range}
                  keepParams={range.keepParams}
                  note={range.note}
                />
              )}
              <CampaignKpiView
                items={items} selectedId={kpi.selectedId} daily={kpi.daily}
                dailyError={kpi.dailyError} roleLabel="Quản lý" todayISO={kpi.todayISO}
                storeName={storeName} showTierRemaining
                series={kpi.series} seriesHrefBase={kpi.seriesHrefBase}
              />
            </>
          )}
        </div>
        {side && (
          <div className="space-y-4 min-w-0 v2:space-y-3">
            <QrCard qr={qr} />
            {gmv && (
              <AffiliateGmvCard
                monthLabel={gmv.monthLabel}
                gmv={gmv.gmv}
                orders={gmv.orders}
                syncedAt={gmv.syncedAt}
                error={gmv.error}
                sourceWarning={gmv.sourceWarning}
                detailHref="/targets/campaigns/affiliate"
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
