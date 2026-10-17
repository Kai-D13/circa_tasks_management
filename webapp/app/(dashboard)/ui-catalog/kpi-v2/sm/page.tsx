import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { SmTargetsDetailView, SmTargetsErrorView, SmTargetsLandingView, SmTargetsOutOfScopeView, type SmGmvStrip } from '@/components/kpi/SmTargetsView'
import type { RegionalCampaignItem } from '@/components/kpi/RegionalCampaignOverviewList'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { buildCampaignResultModel, type ResultActualRow, type ResultCampaign, type ResultTargetRow } from '@/lib/kpi/resultModel'
import { parseCampaignRange } from '@/lib/kpi/campaignDateRange'

// Dev-only fixture K-5 (canvas K6 desktop / M6 mobile) cho nhánh SM của /targets — render ĐÚNG SmTargetsLandingView /
// SmTargetsDetailView / SmTargetsErrorView / SmTargetsOutOfScopeView của route thật; model qua CHÍNH
// buildCampaignResultModel, bộ lọc qua CHÍNH parseCampaignRange. Dữ liệu giả cố định (không truy vấn, không RPC, không
// action; bọc KpiFixtureBoundary như mọi fixture KPI). Cổng như /ui-catalog: UI_CATALOG=1 (prod 404) + super admin.
// ?fx= list (mặc định) · one · empty · long · gmv-warning · gmv-error · gmv-off · stores-error · data-error · out-of-scope
//      · detail (GMV, có bộ lọc) · detail-quality · detail-unsynced · detail-range (đang xem khoảng)

const TODAY = '2026-10-14'
const SYNC = '2026-10-15T09:15:00Z'
const STORES = ['CIRCA CENTRAL', 'CIRCA URBAN', 'CIRCA LUMINA', 'CIRCA MIZUKI', 'CIRCA SUNRISE', 'CIRCA ELANA']
  .map((name, i) => ({ id: `fx-s${i}`, name }))
const LONG_STORES = [
  ...STORES,
  ...Array.from({ length: 19 }, (_, i) => ({ id: `fx-l${i}`, name: `CIRCA CHI NHÁNH SỐ ${i + 7} — ĐƯỜNG RẤT DÀI` })),
]
const TIERS = [
  { tier_order: 1, threshold_pct: 90, commission_amount: 3_000_000 },
  { tier_order: 2, threshold_pct: 100, commission_amount: 5_000_000 },
]

type Seed = {
  id: string; name: string; start: string; end: string; status: 'active' | 'ended'
  metric: 'gmv' | 'affiliate_customer_count' | 'offline_order_aov'
  /** Tỷ lệ đạt từng cửa hàng (actual = target × r); null ⇒ chưa đồng bộ (không có actual). */
  ratios: number[] | null
  target: number
}
const SEEDS: Seed[] = [
  { id: 'fx-sm1', name: 'KPI tháng 10/2026', start: '2026-10-01', end: '2026-10-31', status: 'active', metric: 'gmv', target: 510_000_000, ratios: [0.52, 0.44, 0.31, 0.36, 0.29, 0.40] },
  { id: 'fx-sm2', name: 'Số khách Affiliate tháng 10/2026', start: '2026-10-01', end: '2026-10-31', status: 'active', metric: 'affiliate_customer_count', target: 75, ratios: [0.82, 1.05, 0.4, 1.12, 0.3, 0.5] },
  { id: 'fx-sm3', name: 'Chất lượng bán hàng tháng 10/2026', start: '2026-10-01', end: '2026-10-31', status: 'active', metric: 'offline_order_aov', target: 100, ratios: [1.12, 0.96, 0.71, 1.04, 0.58, 0.88] },
  { id: 'fx-sm4', name: 'Doanh số tuần 3 T10-2026 (chưa đồng bộ)', start: '2026-10-15', end: '2026-10-21', status: 'active', metric: 'gmv', target: 120_000_000, ratios: null },
  { id: 'fx-sm5', name: 'KPI W2 T10-2026', start: '2026-10-08', end: '2026-10-14', status: 'ended', metric: 'gmv', target: 115_000_000, ratios: [0.9, 0.85, 0.8, 0.88, 0.82, 0.81] },
  { id: 'fx-sm6', name: 'KPI tháng 09/2026', start: '2026-09-01', end: '2026-09-30', status: 'ended', metric: 'gmv', target: 426_000_000, ratios: [1.08, 1.02, 1.11, 1.05, 0.99, 1.06] },
]
const LONG_NAME = 'Chiến dịch tăng trưởng doanh số mùa cao điểm cuối năm 2026 — áp dụng toàn vùng Hồ Chí Minh mở rộng (đợt 2, có điều chỉnh mục tiêu)'

function modelOf(seed: Seed): RegionalCampaignItem {
  const quality = seed.metric === 'offline_order_aov'
  const campaign: ResultCampaign = {
    id: seed.id, name: seed.name, start_date: seed.start, end_date: seed.end, status: seed.status,
    metric_type: seed.metric, metric_offline: seed.metric !== 'affiliate_customer_count', metric_affiliate: seed.metric !== 'offline_order_aov',
  }
  const targets: ResultTargetRow[] = STORES.map((s, i) => ({
    id: `${seed.id}-t${i}`, store_id: s.id, pos_code: `POS00${10 + i}`, store_kpi_group: null, stores: { name: s.name },
    kpi_target: seed.target,
    kpi_campaign_store_tiers: quality ? [{ tier_order: 1, threshold_pct: 100, commission_amount: 2_500_000 }] : TIERS,
    order_target: quality ? 1_000 : null,
    aov_target: quality ? 135_000 : null,
  }))
  const actuals: ResultActualRow[] = seed.ratios === null ? [] : STORES.map((s, i) => {
    const r = seed.ratios![i]
    const value = quality ? Math.round(r * 100 * 10) / 10 : Math.round(seed.target * r)
    const orders = quality ? Math.round(1_000 * r) : Math.round(value / 140_000)
    const pct = quality ? value : r * 100
    const tier = [...targets[i].kpi_campaign_store_tiers].reverse().find((x) => pct >= x.threshold_pct) ?? null
    return {
      store_id: s.id, actual_value: value, run_rate: quality ? null : pct,
      remaining_target: quality ? null : Math.max(0, seed.target - value),
      achieved_tier_order: tier?.tier_order ?? null, store_commission_pool: tier?.commission_amount ?? null,
      synced_at: SYNC,
      actual_offline: seed.metric === 'affiliate_customer_count' ? null : quality ? orders * 140_000 : Math.round(value * 0.96),
      actual_affiliate: seed.metric === 'gmv' ? Math.round(value * 0.04) : null,
      offline_order_count: seed.metric === 'affiliate_customer_count' ? null : orders,
      offline_synced_at: SYNC, affiliate_synced_at: SYNC,
    }
  })
  return { id: seed.id, model: buildCampaignResultModel(campaign, targets, actuals, TODAY) }
}

const GMV: SmGmvStrip = {
  monthLabel: 'Tháng 10/2026', gmv: 24_913_200, orders: 148, storesWithSales: 5, storeCount: STORES.length,
  syncedAt: '2026-10-15T09:00:00Z', error: false, sourceWarning: null,
}

export default async function UiCatalogKpiSmPage({ searchParams }: { searchParams: Promise<{ fx?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'list' } = await searchParams

  const body = (() => {
    if (fx.startsWith('detail')) {
      const seed = fx === 'detail-quality' ? SEEDS[2] : fx === 'detail-unsynced' ? SEEDS[3] : SEEDS[0]
      const { model } = modelOf(seed)
      const range = parseCampaignRange({
        from: fx === 'detail-range' ? '2026-10-01' : undefined,
        to: fx === 'detail-range' ? '2026-10-10' : undefined,
        campaignStart: seed.start, campaignEnd: seed.end, metricType: seed.metric,
      })
      return <SmTargetsDetailView campaign={model.campaign} storeCount={STORES.length} model={model} filter={{ range, note: null, campaignParam: seed.id }} />
    }
    if (fx === 'stores-error') {
      return <SmTargetsErrorView message="Không tải được danh sách cửa hàng được phân công" hint="permission denied for table sm_store_assignments — thử tải lại hoặc báo Admin." />
    }
    if (fx === 'data-error') {
      return <SmTargetsErrorView message="Không tải được dữ liệu chiến dịch" hint="canceling statement due to statement timeout — thử tải lại hoặc báo Admin." />
    }
    if (fx === 'out-of-scope') return <SmTargetsOutOfScopeView />
    const seeds = fx === 'empty' ? [] : fx === 'one' ? SEEDS.slice(0, 1)
      : fx === 'long' ? [{ ...SEEDS[0], name: LONG_NAME }, ...SEEDS.slice(1)] : SEEDS
    // Hạn gần nhất lên đầu — như page.tsx.
    const items = seeds.map(modelOf).sort((x, y) => x.model.campaign.end_date.localeCompare(y.model.campaign.end_date))
    const gmv = fx === 'gmv-off' ? null
      : fx === 'gmv-warning' ? { ...GMV, sourceWarning: 'đồng bộ Circa Online quá 6 giờ chưa chạy lại' }
      : fx === 'gmv-error' ? { ...GMV, error: true }
      : fx === 'long' ? { ...GMV, gmv: 1_284_913_200, orders: 12_148, storesWithSales: 23, storeCount: LONG_STORES.length }
      : GMV
    return <SmTargetsLandingView stores={fx === 'long' ? LONG_STORES : STORES} gmv={gmv} items={items} />
  })()

  return (
    <KpiFixtureBoundary>
    <div data-testid="ui-catalog-kpi-sm" data-fx={fx}>{body}</div>
    </KpiFixtureBoundary>
  )
}
