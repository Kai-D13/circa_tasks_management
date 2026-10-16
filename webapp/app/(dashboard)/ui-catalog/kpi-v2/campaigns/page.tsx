import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { CampaignListView, type CampaignListRow, type CampaignListCounts } from '@/components/kpi/CampaignListView'
import { campaignOverviewValue } from '@/lib/kpi/campaignDisplay'
import { campaignListPct, campaignListReached } from '@/lib/kpi/campaignList'
import { parseCampaignStatus } from '@/lib/kpi/campaignAccess'
import CampaignsLoading from '@/app/(dashboard)/targets/campaigns/loading'

// Dev-only fixture K-1 (canvas K1) cho /targets/campaigns — render ĐÚNG CampaignListView của route thật với dữ
// liệu giả cố định (không truy vấn). Giá trị/% đi qua campaignOverviewValue y như page.tsx (một nguồn). Cổng như
// /ui-catalog: UI_CATALOG=1 (prod 404) + super admin. ?fx=
//   super (mặc định) · sm (chỉ đọc, active/ended) · empty · filter-empty (&status=) · error (truy vấn chính lỗi)
//   · side-error (target/actual lỗi) · loading (khung chờ loading.tsx)

type Seed = Omit<CampaignListRow, 'ov' | 'stores' | 'lastSync' | 'reached' | 'progress'> & {
  stores: number; target: number; actual: number; pass?: number; synced: boolean
}
const SYNC = '2026-01-15T03:05:00Z'
const LONG = 'Chiến dịch Tết Nguyên Đán 2026 — tăng tốc doanh số toàn chuỗi khu vực Hồ Chí Minh và các tỉnh lân cận (đợt 2)'
const SEEDS: Seed[] = [
  { id: 'fx-c1', name: LONG, start_date: '2026-01-01', end_date: '2026-01-31', status: 'active', is_test: false, metric_type: 'gmv', stores: 24, target: 9_430_000_000, actual: 3_790_116_504, synced: true },
  // Số khách ĐÚNG 100% (đạt) — vượt 100 là fx-c7 (112%).
  { id: 'fx-c2', name: 'Affiliate tháng 1 — khách mới', start_date: '2026-01-01', end_date: '2026-01-31', status: 'active', is_test: false, metric_type: 'affiliate_customer_count', stores: 12, target: 450, actual: 450, synced: true },
  { id: 'fx-c3', name: 'Chất lượng bán hàng Q1', start_date: '2026-01-01', end_date: '2026-03-31', status: 'active', is_test: false, metric_type: 'offline_order_aov', stores: 8, target: 800, actual: 640, pass: 3, synced: true },
  // 99,6% chưa đạt ⇒ chữ "99,6%" + màu chuỗi (PM P1 K-1); 99,96% làm tròn 1 chữ số thành 100 ⇒ "<100%".
  { id: 'fx-c8', name: 'Doanh số tuần 3 (gần đạt)', start_date: '2026-01-12', end_date: '2026-01-18', status: 'active', is_test: false, metric_type: 'gmv', stores: 24, target: 2_000_000_000, actual: 1_992_000_000, synced: true },
  { id: 'fx-c9', name: 'Doanh số tuần 4 (sát mục tiêu)', start_date: '2026-01-19', end_date: '2026-01-25', status: 'active', is_test: false, metric_type: 'gmv', stores: 24, target: 10_000_000_000, actual: 9_996_000_000, synced: true },
  { id: 'fx-c4', name: 'Doanh số tháng 2 (chưa đồng bộ)', start_date: '2026-02-01', end_date: '2026-02-28', status: 'paused', is_test: false, metric_type: 'gmv', stores: 18, target: 6_200_000_000, actual: 0, synced: false },
  { id: 'fx-c5', name: 'Nháp thử nghiệm', start_date: '2026-03-01', end_date: '2026-03-31', status: 'draft', is_test: true, metric_type: 'gmv', stores: 3, target: 900_000_000, actual: 0, synced: false },
  { id: 'fx-c6', name: 'Doanh số tháng 12/2025', start_date: '2025-12-01', end_date: '2025-12-31', status: 'ended', is_test: false, metric_type: 'gmv', stores: 24, target: 8_800_000_000, actual: 8_096_000_000, synced: true },
  { id: 'fx-c7', name: 'Doanh số tháng 11/2025', start_date: '2025-11-01', end_date: '2025-11-30', status: 'ended', is_test: false, metric_type: 'gmv', stores: 24, target: 8_000_000_000, actual: 8_960_000_000, synced: true },
]

function toRow(s: Seed, broken = false): CampaignListRow {
  // broken = target lỗi ⇒ page.tsx gộp như không có target (0 cửa hàng, mục tiêu 0) — view phải che bằng '—'.
  const stores = broken ? 0 : s.stores
  const target = broken ? 0 : s.target
  const lastSync = s.synced ? SYNC : null
  const input = {
    metricType: s.metric_type, synced: lastSync !== null, storeCount: stores,
    totalTarget: target, totalActual: s.actual, qualityPassCount: s.pass ?? 0,
  }
  return {
    id: s.id, name: s.name, start_date: s.start_date, end_date: s.end_date, status: s.status, is_test: s.is_test,
    metric_type: s.metric_type, stores, lastSync, ov: campaignOverviewValue(input), reached: campaignListReached(input),
    progress: campaignListPct(input),
  }
}
function countsOf(list: { status: string }[]): CampaignListCounts {
  const n = (st: string) => list.filter((c) => c.status === st).length
  return { total: list.length, active: n('active'), paused: n('paused'), draft: n('draft'), ended: n('ended') }
}

export default async function UiCatalogKpiCampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ fx?: string; status?: string }>
}) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'super', status } = await searchParams

  if (fx === 'loading') return <div data-testid="ui-catalog-kpi-campaigns" data-fx="loading"><CampaignsLoading /></div>

  const canManage = fx !== 'sm'
  const seeds = canManage ? SEEDS : SEEDS.filter((s) => s.status === 'active' || s.status === 'ended')
  const all = fx === 'empty' || fx === 'error' ? [] : seeds
  const statusFilter = fx === 'filter-empty' ? parseCampaignStatus(status ?? 'paused', canManage) : parseCampaignStatus(status, canManage)
  const pool = fx === 'filter-empty' ? all.filter((s) => s.status !== statusFilter) : all
  const shown = statusFilter === 'all' ? pool : pool.filter((s) => s.status === statusFilter)

  return (
    <div data-testid="ui-catalog-kpi-campaigns" data-fx={fx}>
      <CampaignListView
        canManage={canManage}
        affiliateEnabled
        statusFilter={statusFilter}
        counts={countsOf(pool)}
        hasAny={pool.length > 0}
        campaignsError={fx === 'error' ? 'canceling statement due to statement timeout' : null}
        sideError={fx === 'side-error' ? 'relation "kpi_campaign_store_targets" timeout' : null}
        rows={shown.map((s) => toRow(s, fx === 'side-error'))}
      />
    </div>
  )
}
