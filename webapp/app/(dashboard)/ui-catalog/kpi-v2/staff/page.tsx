import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import {
  ManagerTargetsView, StaffCampaignView, StaffPeriodView, StaffStateView,
  type PeriodSummary, type StaffQr, type StaffReferral,
} from '@/components/kpi/StaffTargetsView'
import type { CampaignView, DailyPoint } from '@/components/kpi/CampaignKpiView'
import { orderBonusView } from '@/lib/kpi/orderBonus'
import { parseCampaignRange } from '@/lib/kpi/campaignDateRange'

// Dev-only fixture K-6 (canvas M1–M5) cho nhánh staff + QLCH của /targets — render ĐÚNG StaffCampaignView /
// StaffPeriodView / StaffStateView / ManagerTargetsView của route thật, dữ liệu giả cố định (không truy vấn, không RPC,
// không action; bọc KpiFixtureBoundary như mọi fixture KPI). Số điện thoại referral đều giả. Cổng như /ui-catalog:
// UI_CATALOG=1 (prod 404) + super admin.
// ?fx= list · list-long · detail-gmv · detail-customer · detail-quality · detail-quality-aov · detail-unsynced
//      · detail-ended · detail-long (kỳ 01/06–31/10: bảng đủ 137 ngày tới hôm nay) · detail-achieved · detail-ended-daily
//      · detail-unsynced-daily (chưa có snapshot nhưng đã có điểm ngày ⇒ KHÔNG đường cần/ngày)
//      · detail-long-ended (01/03–31/08, đã kết thúc) · detail-long-early (01/09–31/12, mới chạy 45 ngày) · period-week · period-day · period-month · period-empty · no-store · error
//      · manager-detail · manager-list · manager-empty · referral-error · referral-phone · qr-error

const TODAY = '2026-10-15'
const SYNC = '2026-10-15T09:15:00Z'
const STORE = 'CIRCA CENTRAL'

const base = (o: Partial<CampaignView> & Pick<CampaignView, 'id' | 'name'>): CampaignView => ({
  start_date: '2026-10-01', end_date: '2026-10-31', kpi_target: 393_000_000, store_kpi_group: 'Nhỏ hơn 500 triệu',
  tiers: [
    { tier_order: 1, threshold_pct: 90, commission_amount: 15_000_000 },
    { tier_order: 2, threshold_pct: 100, commission_amount: 25_000_000 },
    { tier_order: 3, threshold_pct: 110, commission_amount: 35_000_000 },
  ],
  actual_value: 157_921_521, run_rate: null, remaining_target: 235_078_479, achieved_tier_order: null,
  store_commission_pool: 0, synced_at: SYNC, metric_offline: true, metric_affiliate: true,
  actual_offline: 143_959_221, actual_affiliate: 13_962_300, offline_order_count: 1_092,
  offline_synced_at: SYNC, affiliate_synced_at: SYNC, metric_type: 'gmv', order_target: null, aov_target: null,
  order_bonus: null,
  ...o,
})

const GMV = base({
  id: 'fx-k1', name: 'KPI tháng 10/2026',
  order_bonus: orderBonusView({ minimum_order_target: 1_300, order_bonus_per_staff: 200_000, bonus_order_count: 1_092, order_bonus_achieved: false, synced: true }),
})
const QUALITY = base({
  id: 'fx-k2', name: 'KPI W3 T10-2026', start_date: '2026-10-12', end_date: '2026-10-18', metric_type: 'offline_order_aov',
  metric_affiliate: false, kpi_target: 100, actual_value: 45, remaining_target: null, actual_affiliate: null,
  actual_offline: 11_437_200, offline_order_count: 81, order_target: 180, aov_target: 135_000,
  tiers: [{ tier_order: 1, threshold_pct: 100, commission_amount: 2_000_000 }], store_kpi_group: null,
})
const CUSTOMER = base({
  id: 'fx-k3', name: 'Số khách Affiliate tháng 10/2026', metric_type: 'affiliate_customer_count', metric_offline: false,
  kpi_target: 150, actual_value: 61, remaining_target: 89, actual_offline: null, actual_affiliate: null, offline_order_count: null,
  tiers: [{ tier_order: 1, threshold_pct: 100, commission_amount: 3_000_000 }],
})
const UNSYNCED = base({
  id: 'fx-k4', name: 'Doanh số tuần 3 T10-2026', start_date: '2026-10-15', end_date: '2026-10-21', kpi_target: 92_500_000,
  actual_value: null, remaining_target: null, synced_at: null, actual_offline: null, actual_affiliate: null,
  offline_order_count: null, offline_synced_at: null, affiliate_synced_at: null,
})
const ENDED = base({
  id: 'fx-k5', name: 'KPI tháng 09/2026', start_date: '2026-09-01', end_date: '2026-09-30', kpi_target: 380_000_000,
  actual_value: 402_300_000, remaining_target: 0, achieved_tier_order: 2, store_commission_pool: 25_000_000,
  actual_offline: 389_100_000, actual_affiliate: 13_200_000,
})
// pm-auditor K-6 P1: kỳ dài (> 92 ngày), đã đạt, đã kết thúc CÓ điểm ngày, chưa có snapshot nhưng CÓ điểm ngày.
const LONG_PERIOD = base({ id: 'fx-k7', name: 'KPI quý 3–4/2026', start_date: '2026-06-01', end_date: '2026-10-31', kpi_target: 1_500_000_000, actual_value: 640_000_000, remaining_target: 860_000_000 })
const LONG_DAILY: DailyPoint[] = [
  { date: '2026-06-01', gmv: 7_000_000, gmv_affiliate: 0 },
  { date: '2026-10-15', gmv: 13_300_000, gmv_affiliate: 900_000 },
]
// Q-134: kỳ dài ĐÃ KẾT THÚC (cửa sổ biểu đồ = 92 ngày cuối kỳ) và kỳ dài MỚI CHẠY (cửa sổ = 92 ngày đầu, có hôm nay).
const LONG_ENDED = base({ id: 'fx-k10', name: 'KPI 6 tháng đầu mùa (đã kết thúc)', start_date: '2026-03-01', end_date: '2026-08-31', kpi_target: 2_400_000_000, actual_value: 2_100_000_000, remaining_target: 300_000_000 })
const LONG_ENDED_DAILY: DailyPoint[] = [
  { date: '2026-03-01', gmv: 9_000_000, gmv_affiliate: 0 },
  { date: '2026-08-31', gmv: 15_500_000, gmv_affiliate: 500_000 },
]
const LONG_EARLY = base({ id: 'fx-k11', name: 'KPI quý 4/2026 mở rộng', start_date: '2026-09-01', end_date: '2026-12-31', kpi_target: 1_600_000_000, actual_value: 520_000_000, remaining_target: 1_080_000_000 })
const LONG_EARLY_DAILY: DailyPoint[] = [
  { date: '2026-09-01', gmv: 10_000_000, gmv_affiliate: 0 },
  { date: '2026-10-15', gmv: 13_300_000, gmv_affiliate: 900_000 },
]
const ACHIEVED = base({ id: 'fx-k8', name: 'KPI tháng 10/2026 (đã đạt)', actual_value: 401_000_000, remaining_target: 0, achieved_tier_order: 2, store_commission_pool: 25_000_000 })
const UNSYNCED_DAILY = base({ id: 'fx-k9', name: 'KPI tháng 10/2026 (chưa có snapshot)', actual_value: null, remaining_target: null, synced_at: null, actual_offline: null, actual_affiliate: null, offline_order_count: null })
const ENDED_DAILY: DailyPoint[] = [
  { date: '2026-09-28', gmv: 14_000_000, gmv_affiliate: 500_000 },
  { date: '2026-09-29', gmv: 12_000_000, gmv_affiliate: 400_000 },
  { date: '2026-09-30', gmv: 15_000_000, gmv_affiliate: 700_000 },
]
const LONG = base({ id: 'fx-k6', name: 'Chiến dịch tăng trưởng doanh số mùa cao điểm cuối năm 2026 — áp dụng toàn hệ thống nhà thuốc (đợt 2, có điều chỉnh mục tiêu)' })

// Doanh số ngày 01–15/10 (GMV hai nguồn); 09/10 thiếu điểm ngày ⇒ bảng '—' (không phải 0).
const GMV_DAILY: DailyPoint[] = Array.from({ length: 15 }, (_, i) => i + 1).filter((d) => d !== 9).map((d) => ({
  date: `2026-10-${String(d).padStart(2, '0')}`,
  gmv: [8_100_000, 9_400_000, 10_200_000, 6_300_000, 11_800_000, 9_900_000, 10_400_000, 0, 0, 12_100_000, 10_700_000, 9_600_000, 11_200_000, 10_100_000, 13_300_000][d - 1],
  gmv_affiliate: [900_000, 0, 1_200_000, 400_000, 1_000_000, 700_000, 1_100_000, 0, 0, 1_300_000, 800_000, 1_100_000, 1_400_000, 900_000, 900_000][d - 1],
  offline_order_count: 70 + d,
}))
const QUALITY_DAILY: DailyPoint[] = [
  { date: '2026-10-12', gmv: 2_682_000, gmv_affiliate: 0, offline_order_count: 19 },
  { date: '2026-10-13', gmv: 3_243_000, gmv_affiliate: 0, offline_order_count: 23 },
  { date: '2026-10-14', gmv: 2_538_000, gmv_affiliate: 0, offline_order_count: 18 },
  { date: '2026-10-15', gmv: 2_974_200, gmv_affiliate: 0, offline_order_count: null },
]
const CUSTOMER_DAILY: DailyPoint[] = Array.from({ length: 15 }, (_, i) => ({
  date: `2026-10-${String(i + 1).padStart(2, '0')}`, gmv: 0, gmv_affiliate: 0, affiliate_customer_count: [3, 5, 4, 6, 2, 4, 5, 3, 4, 6, 5, 3, 4, 3, 4][i],
}))

const QR: StaffQr = { cardKey: 'fx', storeName: STORE, partnerCode: 'CIRCA_CTR_009', imageUrl: null, destinationUrl: 'https://circa.vn', queryError: false }
const REFERRAL: StaffReferral = {
  referral: {
    total: 3, success: 2, sameDay: 2, noOrder: 1,
    items: [
      { referred_phone: '09xx xxx 201', status: 'SUCCESS', referral_date: '14/10/2026', same_day_order: true },
      { referred_phone: '09xx xxx 202', status: 'SUCCESS', referral_date: '12/10/2026', same_day_order: true },
      { referred_phone: '09xx xxx 203', status: 'PENDING', referral_date: '10/10/2026', same_day_order: false },
    ],
  },
  error: false, phoneMissing: false,
}
const NO_REFERRAL: StaffReferral = { referral: null, error: false, phoneMissing: false }

const PERIOD: Record<'day' | 'week' | 'month', PeriodSummary> = {
  week: { noun: 'tuần', label: 'Tuần 12/10 – 18/10', status: 'not achieved', hasGoal: true, actual: 61_080_000, goal: 92_500_000, pct: (61_080_000 / 92_500_000) * 100, remaining: 31_420_000, achieved: false, refreshedAt: SYNC },
  day: { noun: 'ngày', label: 'Hôm nay · 15/10/2026', status: null, hasGoal: false, actual: 8_240_000, goal: 0, pct: 0, remaining: null, achieved: false, refreshedAt: SYNC },
  month: { noun: 'tháng', label: 'Tháng 10/2026', status: 'achieved', hasGoal: true, actual: 402_300_000, goal: 380_000_000, pct: (402_300_000 / 380_000_000) * 100, remaining: 0, achieved: true, refreshedAt: SYNC },
}
const TITLE = { day: 'Doanh số hôm nay', week: 'Doanh số tuần', month: 'Doanh số tháng' } as const

export default async function UiCatalogKpiStaffPage({ searchParams }: { searchParams: Promise<{ fx?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'list' } = await searchParams

  const hrefFor = (id: string) => `/ui-catalog/kpi-v2/staff?fx=detail-gmv&c=${id}`
  const listHref = '/ui-catalog/kpi-v2/staff?fx=list'
  const kpiOf = (sel: CampaignView, daily: DailyPoint[], series: 'orders' | 'aov' = 'orders') => ({
    selectedId: sel.id, daily, dailyError: false, todayISO: TODAY, series,
    seriesHrefBase: `/ui-catalog/kpi-v2/staff?fx=detail-quality`,
  })

  const body = (() => {
    if (fx === 'no-store' || fx === 'error') return <StaffStateView kind={fx} />
    if (fx.startsWith('period')) {
      const p = fx === 'period-day' ? 'day' : fx === 'period-month' ? 'month' : 'week'
      return (
        <StaffPeriodView
          title={TITLE[p]} storeName={STORE} period={p}
          current={fx === 'period-empty' ? null : PERIOD[p]}
          emptyMsg="Chưa có dữ liệu doanh số tuần cho cửa hàng của bạn."
          qr={QR} referral={NO_REFERRAL}
        />
      )
    }
    if (fx.startsWith('manager')) {
      const items = fx === 'manager-empty' ? [] : [GMV, QUALITY]
      return (
        <ManagerTargetsView
          storeName={STORE} items={items} showList={fx === 'manager-list'} hrefFor={hrefFor} listHref={listHref}
          kpi={kpiOf(GMV, GMV_DAILY)} selected={fx === 'manager-detail' ? GMV : null}
          range={fx === 'manager-detail' ? {
            campaignStart: GMV.start_date, campaignEnd: GMV.end_date, note: null,
            range: parseCampaignRange({ campaignStart: GMV.start_date, campaignEnd: GMV.end_date, metricType: 'gmv' }),
            keepParams: { campaign: GMV.id },
          } : null}
          qr={QR}
          gmv={{ monthLabel: 'Tháng 10/2026', gmv: 13_962_300, orders: 76, syncedAt: SYNC, error: false, sourceWarning: null }}
        />
      )
    }
    if (fx.startsWith('detail')) {
      const [sel, daily, series] = fx === 'detail-customer' ? [CUSTOMER, CUSTOMER_DAILY, 'orders'] as const
        : fx === 'detail-quality' ? [QUALITY, QUALITY_DAILY, 'orders'] as const
        : fx === 'detail-quality-aov' ? [QUALITY, QUALITY_DAILY, 'aov'] as const
        : fx === 'detail-unsynced' ? [UNSYNCED, [] as DailyPoint[], 'orders'] as const
        : fx === 'detail-ended' ? [ENDED, [] as DailyPoint[], 'orders'] as const
        : fx === 'detail-long' ? [LONG_PERIOD, LONG_DAILY, 'orders'] as const
        : fx === 'detail-long-ended' ? [LONG_ENDED, LONG_ENDED_DAILY, 'orders'] as const
        : fx === 'detail-long-early' ? [LONG_EARLY, LONG_EARLY_DAILY, 'orders'] as const
        : fx === 'detail-achieved' ? [ACHIEVED, GMV_DAILY, 'orders'] as const
        : fx === 'detail-ended-daily' ? [ENDED, ENDED_DAILY, 'orders'] as const
        : fx === 'detail-unsynced-daily' ? [UNSYNCED_DAILY, GMV_DAILY, 'orders'] as const
        : [GMV, GMV_DAILY, 'orders'] as const
      return (
        <StaffCampaignView
          storeName={STORE} items={[sel, ...[GMV, QUALITY].filter((c) => c.id !== sel.id)]} showList={false}
          hrefFor={hrefFor} listHref={listHref} kpi={kpiOf(sel, daily, series)} landing={false}
          qr={QR} referral={REFERRAL}
        />
      )
    }
    const items = fx === 'list-long' ? [LONG, GMV, QUALITY, CUSTOMER, UNSYNCED, ENDED] : [GMV, QUALITY, CUSTOMER]
    return (
      <StaffCampaignView
        storeName={STORE} items={items} showList hrefFor={hrefFor} listHref={listHref}
        kpi={kpiOf(GMV, GMV_DAILY)} landing
        qr={fx === 'qr-error' ? { ...QR, queryError: true } : QR}
        referral={fx === 'referral-error' ? { referral: null, error: true, phoneMissing: false }
          : fx === 'referral-phone' ? { referral: null, error: false, phoneMissing: true } : REFERRAL}
      />
    )
  })()

  return (
    <KpiFixtureBoundary>
    <div data-testid="ui-catalog-kpi-staff" data-fx={fx}>{body}</div>
    </KpiFixtureBoundary>
  )
}
