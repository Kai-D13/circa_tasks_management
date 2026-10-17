import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { Panel } from '@/components/ds/Panel'
import { CampaignDetailView, type DetailCampaign, type DetailRun, type DetailTargetRow } from '@/components/kpi/CampaignDetailView'
import { CampaignImportPreview, type CampaignImportPreviewData } from '@/components/kpi/CampaignImport'
import { CampaignDetailSkeleton } from '@/components/kpi/CampaignRouteSkeletons'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { parseCampaignRange, rangeFilterVisibleForRole } from '@/lib/kpi/campaignDateRange'
import { buildCampaignResultModel, type ResultActualRow, type ResultCampaign, type ResultTargetRow } from '@/lib/kpi/resultModel'

// Dev-only fixture K-2 (canvas K2 Kết quả / K3 Cấu hình) cho /targets/campaigns/[id] — render ĐÚNG CampaignDetailView
// của route thật; model qua CHÍNH buildCampaignResultModel, bộ lọc theo CHÍNH rangeFilterVisibleForRole/
// parseCampaignRange. Dữ liệu giả cố định (không truy vấn). Cổng như /ui-catalog: UI_CATALOG=1 (prod 404) + super.
// Bọc KpiFixtureBoundary ⇒ trạng thái / chỉ số / nạp file / đồng bộ / xuất không gọi máy chủ (PM 17/10 P1).
// ?fx= result-gmv · result-offline · result-customer · result-quality · result-bonus · result-unsynced · result-ended
//      · result-range · result-range-error · result-range-note · result-empty · sm · error
//      · config-draft · config-active · config-empty · config-customer · import-preview · loading

const TODAY = '2026-10-15'
const SYNC = '2026-10-15T09:15:00Z'
const TIERS = [
  { tier_order: 1, threshold_pct: 90, commission_amount: 3_000_000 },
  { tier_order: 2, threshold_pct: 100, commission_amount: 5_000_000 },
  { tier_order: 3, threshold_pct: 110, commission_amount: 8_000_000 },
]
const STORES: { name: string; pos: string; group: string | null; target: number; offline: number; aff: number; orders: number }[] = [
  { name: 'CIRCA CENTRAL — Nhà thuốc trung tâm quận 1 (chi nhánh Nguyễn Thị Minh Khai mở rộng)', pos: 'POS0009', group: 'A', target: 620_000_000, offline: 402_150_300, aff: 13_962_300, orders: 2_918 },
  { name: 'CIRCA URBAN', pos: 'POS0012', group: 'A', target: 540_000_000, offline: 512_480_000, aff: 9_100_000, orders: 3_811 },
  { name: 'CIRCA LUMINA', pos: 'POS0015', group: 'B', target: 410_000_000, offline: 168_204_000, aff: 2_400_000, orders: 1_302 },
  { name: 'CIRCA MIZUKI', pos: 'POS0018', group: null, target: 380_000_000, offline: 421_900_500, aff: 6_700_000, orders: 3_102 },
  { name: 'CIRCA SUNRISE', pos: 'POS0021', group: 'B', target: 300_000_000, offline: 121_000_000, aff: 0, orders: 980 },
  { name: 'CIRCA ELANA', pos: 'POS0024', group: null, target: 260_000_000, offline: 98_400_000, aff: 1_150_000, orders: 774 },
]

type Kind = 'gmv' | 'offline' | 'customer' | 'quality'
function campaignOf(kind: Kind, status: string, over: Partial<DetailCampaign> = {}): DetailCampaign {
  return {
    id: 'fx-detail', name: kind === 'quality' ? 'Chất lượng bán hàng tháng 10/2026' : kind === 'customer' ? 'Số khách Affiliate tháng 10/2026' : 'KPI tháng 10/2026',
    start_date: '2026-10-01', end_date: '2026-10-31', status, is_test: false,
    metric_type: kind === 'quality' ? 'offline_order_aov' : kind === 'customer' ? 'affiliate_customer_count' : 'gmv',
    metric_offline: kind !== 'customer', metric_affiliate: kind === 'gmv' || kind === 'customer',
    ...over,
  }
}

function targetsOf(kind: Kind, bonus = false): DetailTargetRow[] {
  return STORES.map((s, i) => ({
    id: `t${i}`, store_id: `s${i}`, pos_code: s.pos, store_kpi_group: s.group, stores: { name: s.name },
    kpi_target: kind === 'quality' ? 100 : kind === 'customer' ? Math.round(s.target / 4_000_000) : s.target,
    kpi_campaign_store_tiers: kind === 'quality' ? [{ tier_order: 1, threshold_pct: 100, commission_amount: 2_500_000 }] : TIERS,
    order_target: kind === 'quality' ? Math.round(s.orders * 1.1) : null,
    aov_target: kind === 'quality' ? 135_000 : null,
    minimum_order_target: bonus ? 2_500 : null,
    order_bonus_per_staff: bonus ? 200_000 : null,
  }))
}

function actualsOf(kind: Kind, targets: DetailTargetRow[], opts: { scale?: number; bonus?: boolean } = {}): ResultActualRow[] {
  const k = opts.scale ?? 1
  return STORES.map((s, i) => {
    const t = targets[i]
    const offline = Math.round(s.offline * k)
    const aff = kind === 'offline' ? 0 : Math.round(s.aff * k)
    const value = kind === 'quality'
      ? [112.4, 96.1, 71.0, 104.3, 58.2, 88.8][i]
      : kind === 'customer' ? Math.round(t.kpi_target * [0.82, 1.05, 0.4, 1.12, 0.3, 0.5][i] * k) : offline + aff
    const pct = kind === 'quality' ? value : (value / t.kpi_target) * 100
    const tier = [...t.kpi_campaign_store_tiers].reverse().find((x) => pct >= x.threshold_pct) ?? null
    const orders = Math.round(s.orders * k)
    return {
      store_id: `s${i}`, actual_value: value, run_rate: kind === 'quality' ? null : pct,
      remaining_target: kind === 'quality' ? null : Math.max(0, t.kpi_target - value),
      achieved_tier_order: tier?.tier_order ?? null, store_commission_pool: tier?.commission_amount ?? null,
      synced_at: SYNC, actual_offline: kind === 'customer' ? null : offline, actual_affiliate: kind === 'gmv' ? aff : null,
      offline_order_count: kind === 'customer' ? null : orders,
      offline_synced_at: SYNC, affiliate_synced_at: SYNC,
      affiliate_order_count: opts.bonus ? 120 : null,
      bonus_order_count: opts.bonus ? orders + 120 : null,
      order_bonus_achieved: opts.bonus ? orders + 120 >= 2_500 : null,
    }
  })
}

const RUNS: DetailRun[] = [
  { file_name: 'target_T10_2026_v2.xlsx', row_count: 6, success_count: 6, created_at: '2026-10-14T11:20:00Z' },
  { file_name: 'target_T10_2026.xlsx', row_count: 6, success_count: 0, created_at: '2026-10-14T10:02:00Z' },
]
const PREVIEWS: { label: string; data: CampaignImportPreviewData; metricType?: string }[] = [
  { label: 'Hợp lệ', data: { validCount: 3, invalid: [], unmatched: [], preview: [
    { pos_code: 'POS0009', kpi_target: 620_000_000, store_kpi_group: 'A', tiers: [{ threshold_pct: 90, commission_amount: 3_000_000 }, { threshold_pct: 100, commission_amount: 5_000_000 }] },
    { pos_code: 'POS0012', kpi_target: 540_000_000, store_kpi_group: null, tiers: [{ threshold_pct: 100, commission_amount: 5_000_000 }] },
    { pos_code: 'POS0015', kpi_target: 410_000_000, store_kpi_group: 'B', tiers: [{ threshold_pct: 100, commission_amount: 4_000_000 }] },
  ] } },
  { label: 'Lỗi + POS không khớp + thưởng thêm', data: { validCount: 23, unmatched: ['POS0099'], invalid: [
    { row: 14, pos_code: 'POS0021', error: 'tier_2_threshold_pct phải lớn hơn tier_1' },
    { row: 25, pos_code: 'POS0099', error: 'POS không khớp cửa hàng nào' },
  ], preview: [
    { pos_code: 'POS0009', kpi_target: 620_000_000, store_kpi_group: null, tiers: [{ threshold_pct: 100, commission_amount: 5_000_000 }], minimum_order_target: 2_500, order_bonus_per_staff: 200_000 },
  ] } },
]

export default async function UiCatalogKpiDetailPage({ searchParams }: { searchParams: Promise<{ fx?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'result-gmv' } = await searchParams

  if (fx === 'loading') return <div data-testid="ui-catalog-kpi-detail" data-fx="loading"><CampaignDetailSkeleton /></div>
  if (fx === 'import-preview') {
    return (
      <div data-testid="ui-catalog-kpi-detail" data-fx="import-preview">
        <div data-ui-v2="page" className="p-4 md:p-6 space-y-4">
          {PREVIEWS.map((p) => (
            <Panel key={p.label} title={`Xem trước — ${p.label}`}>
              <CampaignImportPreview preview={p.data} metricType={p.metricType} />
            </Panel>
          ))}
        </div>
      </div>
    )
  }

  const kind: Kind = fx.endsWith('quality') ? 'quality' : fx.endsWith('customer') ? 'customer' : fx === 'result-offline' ? 'offline' : 'gmv'
  const isConfig = fx.startsWith('config-')
  const status = fx === 'config-draft' || fx === 'config-empty' || fx === 'config-customer' ? 'draft'
    : fx === 'result-ended' ? 'ended' : 'active'
  const campaign = campaignOf(kind, status, fx === 'result-ended' ? { start_date: '2026-09-01', end_date: '2026-09-30', name: 'KPI tháng 09/2026' } : {})
  const bonus = fx === 'result-bonus' || fx === 'config-draft'
  const empty = fx === 'result-empty' || fx === 'config-empty'
  const targets = empty ? [] : targetsOf(kind, bonus)
  const actuals = empty || fx === 'result-unsynced' || isConfig ? []
    : actualsOf(kind, targets, { scale: fx === 'result-ended' ? 2.1 : 1, bonus })
  const role = fx === 'sm' ? 'sm' : 'admin'
  const canManage = role === 'admin'
  const canFilter = rangeFilterVisibleForRole({ role, isSuperAdmin: true })
  const range = parseCampaignRange({
    from: fx === 'result-range' ? '2026-10-01' : fx === 'result-range-error' ? '2026-10-12' : undefined,
    to: fx === 'result-range' ? '2026-10-10' : fx === 'result-range-error' ? '2026-10-05' : undefined,
    campaignStart: campaign.start_date, campaignEnd: campaign.end_date, metricType: campaign.metric_type,
  })
  const model = buildCampaignResultModel(campaign as ResultCampaign, targets as unknown as ResultTargetRow[], actuals, TODAY)
  const lastSynced = actuals.reduce<string | null>((max, a) => (!max || a.synced_at > max ? a.synced_at : max), null)

  return (
    <KpiFixtureBoundary>
    <div data-testid="ui-catalog-kpi-detail" data-fx={fx}>
      <CampaignDetailView
        campaign={campaign}
        canManage={canManage}
        tab={isConfig ? 'config' : 'result'}
        targets={targets}
        runs={isConfig && canManage && !empty ? RUNS : []}
        queryError={fx === 'error' ? 'canceling statement due to statement timeout' : null}
        affiliateEnabled
        model={model}
        lastSynced={lastSynced}
        filter={canFilter ? { range, note: fx === 'result-range-note' ? 'nguồn affiliate chưa sẵn sàng' : null } : null}
      />
    </div>
    </KpiFixtureBoundary>
  )
}
