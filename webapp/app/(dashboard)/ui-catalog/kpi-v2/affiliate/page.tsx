import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { Panel } from '@/components/ds/Panel'
import { AffiliateOverviewView, type AffiliateOverviewBody, type AffiliateOverviewRow } from '@/components/affiliate/AffiliateOverviewView'
import { AffiliateOrdersPanel } from '@/components/affiliate/AffiliateStoreOrdersRow'
import type { AffiliateOrderRow, OverviewEntity } from '@/lib/affiliate/orders'
import type { OverviewDataState, OverviewPageScope } from '@/lib/affiliate/overview'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'

// Dev-only fixture K-4 (canvas K5) cho /targets/campaigns/affiliate — render ĐÚNG AffiliateOverviewView của route thật
// với dữ liệu giả cố định (không truy vấn, không gọi RPC). Khối drill-down dựng bằng CHÍNH AffiliateOrdersPanel (không
// gọi server action). Chevron của bảng vẫn là AffiliateStoreOrdersRow thật; bọc KpiFixtureBoundary ⇒ bấm chevron KHÔNG
// gọi action (PM 17/10 P1). Cổng như /ui-catalog: UI_CATALOG=1 (prod 404) + super admin. Số điện thoại/khách đều giả.
// ?fx= super · ops · sm · qlch · not-ready · agg-error · mapping-error · empty · clamped · drill

const STORES: OverviewEntity[] = [
  { kind: 'store', store_id: '00000000-0000-4000-8000-000000000a01', name: 'CIRCA CENTRAL — Nhà thuốc trung tâm quận 1 (chi nhánh mở rộng)', code: 'POS0009', partnerCodes: ['CIRCA_CTR_009', 'CIRCA_CTR_009B'], isFs: false },
  { kind: 'store', store_id: '00000000-0000-4000-8000-000000000a02', name: 'CIRCA URBAN', code: 'POS0012', partnerCodes: ['CIRCA_URB_012'], isFs: false },
  { kind: 'store', store_id: '00000000-0000-4000-8000-000000000a03', name: 'CIRCA LUMINA', code: 'POS0015', partnerCodes: ['CIRCA_LUM_015'], isFs: false },
  { kind: 'store', store_id: '00000000-0000-4000-8000-000000000a04', name: 'NHÀ THUỐC ĐỐI TÁC FS AN KHANG', code: 'FS0003', partnerCodes: ['FS_ANKHANG_03'], isFs: true },
]
const PARTNER: OverviewEntity = { kind: 'partner', partner_code: 'FS_PARTNER_77', display_name: 'Đối tác FS Minh Châu' }
const AGG = [
  { gmv: 13_962_300, orders: 76, lastDate: '2026-10-15' },
  { gmv: 9_100_000, orders: 51, lastDate: '2026-10-14' },
  { gmv: 0, orders: 0, lastDate: null },
  { gmv: 2_400_000, orders: 12, lastDate: '2026-10-11' },
]

function bodyOf(entities: OverviewEntity[], state: OverviewDataState = 'ok', clamped = false): AffiliateOverviewBody {
  const rows: AffiliateOverviewRow[] = entities
    .map((e, i) => ({ entity: e, agg: e.kind === 'partner' ? { gmv: 1_150_000, orders: 6, lastDate: '2026-10-09' } : AGG[i] ?? { gmv: 0, orders: 0, lastDate: null } }))
    .sort((a, b) => b.agg.gmv - a.agg.gmv)
  const totals = rows.reduce((t, r) => ({ gmv: t.gmv + r.agg.gmv, orders: t.orders + r.agg.orders, points: t.points + (r.agg.orders > 0 ? 1 : 0) }), { gmv: 0, orders: 0, points: 0 })
  return {
    kind: 'data', clamped, dataState: state, totals, rows, filteredCount: entities.length,
    aggErrorMsg: state === 'aggregate-error' ? 'canceling statement due to statement timeout' : null,
    healthReason: state === 'source-not-ready' ? 'canary stale 182 phút' : null,
    healthLastSuccessAt: state === 'source-not-ready' ? '2026-10-15T05:12:00Z' : null,
  }
}

const ORDERS: AffiliateOrderRow[] = Array.from({ length: 3 }, (_, i) => ({
  id: `fx-o${i}`, pos_order_code: `DHC0${4521 + i}`, partner_code: 'CIRCA_CTR_009', sale_order_status: 'Đã giao',
  status_norm: 'delivered', total_price: [204_000, 188_400, 220_000][i], customer_name: ['Nguyễn Văn A', 'Trần Thị B', 'Lê Văn C'][i],
  customer_phone: ['090***1234', '091***5678', '093***9012'][i],
  created_time: `2026-10-1${i + 2}T03:${10 + i}:00Z`, completed_time: `2026-10-1${i + 3}T07:${20 + i}:00Z`,
} as unknown as AffiliateOrderRow))

export default async function UiCatalogKpiAffiliatePage({ searchParams }: { searchParams: Promise<{ fx?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'super' } = await searchParams

  const scope: Exclude<OverviewPageScope, 'denied'> = fx === 'ops' ? 'os-all' : fx === 'sm' ? 'os-assigned' : fx === 'qlch' ? 'os-own' : 'os-fs'
  const entities = scope === 'os-fs' ? [...STORES, PARTNER] : scope === 'os-own' ? [STORES[0]] : STORES.slice(0, 3)
  const filter = { from: '2026-10-01', to: fx === 'clamped' ? '2026-10-15' : '2026-10-15', typeFilter: (scope === 'os-fs' ? 'all' : 'os') as 'all' | 'os', options: entities }
  const body: AffiliateOverviewBody = fx === 'mapping-error' ? { kind: 'mapping-error', message: 'permission denied for table affiliate_partner_mappings' }
    : fx === 'empty' ? { kind: 'empty' }
    : bodyOf(entities, fx === 'not-ready' ? 'source-not-ready' : fx === 'agg-error' ? 'aggregate-error' : 'ok', fx === 'clamped')

  return (
    <KpiFixtureBoundary>
    <div data-testid="ui-catalog-kpi-affiliate" data-fx={fx}>
      <AffiliateOverviewView scope={scope} filter={fx === 'mapping-error' ? null : filter} body={body} />
      {fx === 'drill' && (
        <div data-ui-v2="page" className="px-4 pb-6 md:px-6 space-y-4">
          <Panel title="Drill-down — đủ trang, khớp số tổng hợp">
            <div data-fx-drill="match"><AffiliateOrdersPanel rows={ORDERS} fetched cursor={null} error={null} pending={false} expectedOrders={3} expectedGmv={612_400} /></div>
          </Panel>
          <Panel title="Drill-down — còn trang sau (Tải thêm)">
            <div data-fx-drill="more"><AffiliateOrdersPanel rows={ORDERS} fetched cursor={{ completedTime: '2026-10-13T07:20:00Z', id: 'fx-o0' }} error={null} pending={false} expectedOrders={76} expectedGmv={13_962_300} /></div>
          </Panel>
          <Panel title="Drill-down — lệch số tổng hợp">
            <div data-fx-drill="mismatch"><AffiliateOrdersPanel rows={ORDERS} fetched cursor={null} error={null} pending={false} expectedOrders={4} expectedGmv={700_000} /></div>
          </Panel>
          <Panel title="Drill-down — rỗng / đang tải / lỗi">
            <div className="space-y-2">
              <div data-fx-drill="empty"><AffiliateOrdersPanel rows={[]} fetched cursor={null} error={null} pending={false} expectedOrders={0} expectedGmv={0} /></div>
              <div data-fx-drill="loading"><AffiliateOrdersPanel rows={[]} fetched={false} cursor={null} error={null} pending expectedOrders={5} expectedGmv={1_000_000} /></div>
              <div data-fx-drill="error"><AffiliateOrdersPanel rows={[]} fetched={false} cursor={null} error="permission denied" pending={false} expectedOrders={5} expectedGmv={1_000_000} /></div>
            </div>
          </Panel>
        </div>
      )}
    </div>
    </KpiFixtureBoundary>
  )
}
