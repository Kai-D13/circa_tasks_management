import { notFound, redirect } from 'next/navigation'
import { Receipt } from 'lucide-react'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { PageHeader } from '@/components/ds/PageHeader'
import { FilterTabs } from '@/components/ds/FilterTabs'
import { CareTaskOrdersSection } from '@/components/care/CareTaskOrdersSection'
import { CareImportOrdersBlock } from '@/components/care/CareImportOrdersBlock'
import { CareConversionTable, CareImportOrdersTable } from '@/components/care/CareOrdersTable'
import {
  careImportPartialText, type CareConversionRow, type CareImportOrderList, type CareImportOrderRow, type CareImportOrderState,
  type CareTaskOrder, type CareTaskOrdersView,
} from '@/lib/care/orderLinks/view'

// Dev-only bàn thử UI "đơn xác thực sau import" (E3, thiết kế E0 r3.4 §5 / §9). 100% DỮ LIỆU GIẢ (mã đơn DHC-QA…, khách
// "KH QA …"). Cùng cổng /ui-catalog: UI_CATALOG=1 (Coolify không đặt ⇒ prod 404) + super. Action giả tự kiểm cổng.

const catalogOn = () => process.env.UI_CATALOG === '1'
async function gate(): Promise<boolean> {
  if (!catalogOn()) return false
  const { user, profile } = await getSessionProfile()
  return !!user && profile?.role === 'admin' && isSuperAdminEmail(user.email)
}

const S = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const order = (i: number): CareTaskOrder => ({
  orderCode: `DHC-QA-${String(7000 + i).padStart(6, '0')}`, completedAt: `2026-10-${String(15 - (i % 10)).padStart(2, '0')}T0${i % 9}:30:00.000000Z`, linkId: 100 - i,
})
const base = {
  found: true as const, hasMore: false, coverage: true, coveredUntil: '2026-10-15T02:30:00.000000Z', periodMonth: '2026-10-01', isCurrentPeriod: true,
  periodStatus: 'active' as const, closedAt: null, closedThrough: null, lagging: false,
}
const CASES: { key: string; title: string; view: CareTaskOrdersView; next: string | null }[] = [
  { key: 'orders', title: 'Kỳ hiện tại — có đơn, còn trang sau', view: { ...base, orders: [order(1), order(2), order(3)], ordersCount: 23, hasMore: true }, next: 'catalog-cursor' },
  { key: 'zero', title: 'Kỳ hiện tại — đã quét, chưa thấy đơn', view: { ...base, orders: [], ordersCount: 0 }, next: null },
  { key: 'nocov', title: 'Kỳ hiện tại — chưa có dữ liệu đơn', view: { ...base, orders: [], ordersCount: 0, coverage: false, coveredUntil: null }, next: null },
  { key: 'lagging', title: 'Kỳ hiện tại — chưa cập nhật (> 24 h)', view: { ...base, orders: [order(4)], ordersCount: 1, lagging: true }, next: null },
  { key: 'closed', title: 'Kỳ trước — đã chốt, có đơn', view: { ...base, isCurrentPeriod: false, periodMonth: '2026-09-01', periodStatus: 'closed', orders: [order(5)], ordersCount: 1,
    coveredUntil: '2026-09-30T17:00:00.000000Z', closedAt: '2026-09-30T17:40:12.000000Z', closedThrough: '2026-09-30T17:00:00.000000Z' }, next: null },
  { key: 'closed0', title: 'Kỳ trước — đã chốt, 0 đơn', view: { ...base, isCurrentPeriod: false, periodMonth: '2026-09-01', periodStatus: 'closed', orders: [], ordersCount: 0,
    coveredUntil: '2026-09-30T17:00:00.000000Z', closedAt: '2026-09-30T17:40:12.000000Z', closedThrough: '2026-09-30T17:00:00.000000Z' }, next: null },
  { key: 'waiting', title: 'Kỳ trước — đang chờ chốt kỳ', view: { ...base, isCurrentPeriod: false, periodMonth: '2026-09-01', periodStatus: 'active', orders: [order(6)], ordersCount: 1 }, next: null },
  { key: 'failed', title: 'Kỳ trước — chưa chốt đủ dữ liệu đơn', view: { ...base, isCurrentPeriod: false, periodMonth: '2026-09-01', periodStatus: 'close_failed', orders: [], ordersCount: 0 }, next: null },
  { key: 'pre', title: 'Kỳ trước go-live E', view: { ...base, isCurrentPeriod: false, periodMonth: '2026-08-01', periodStatus: 'none', orders: [], ordersCount: 0, coverage: false, coveredUntil: null }, next: null },
]

async function fakeMoreOrders(input: { taskId: string; cursor: string }) {
  'use server'
  if (!(await gate())) return { ok: false as const, message: 'Không có quyền.' }
  await new Promise((r) => setTimeout(r, 400))
  return input.cursor === 'catalog-cursor' ? { ok: true as const, orders: [order(7), order(8)], next: null } : { ok: false as const, message: 'Không tải được đơn — tải lại trang.' }
}

const STORE = ['QAOS01', 'QAOS02']
const IMPORT_ROWS: CareImportOrderRow[] = Array.from({ length: 4 }, (_, i) => ({
  taskId: S(600 + i), customerName: i === 0 ? 'KH QA tên rất dài để kiểm tra cắt chữ trong bảng danh sách đơn sau import' : `KH QA 0000${i + 1}`,
  storeId: S(101 + (i % 2)), assigneeId: S(901 + i), storeCode: STORE[i % 2], assigneeName: `QA Dược sĩ 0${i + 1}`, status: 'open',
  ordersCount: 4 - i, latestCompletedAt: `2026-10-1${4 - i}T03:00:00.000000Z`, coveredUntil: '2026-10-15T02:30:00.000000Z', lagging: i === 3,
}))
const CONV_ROWS: CareConversionRow[] = IMPORT_ROWS.slice(0, 3).map((r) => ({ ...r, orders: r.ordersCount }))
async function fakeMoreImport() {
  'use server'
  if (!(await gate())) return { ok: false as const, message: 'Không có quyền.' }
  return { ok: true as const, rows: [{ ...IMPORT_ROWS[1], taskId: S(699), customerName: 'KH QA trang 2' }], next: null }
}
async function fakeMoreConv() {
  'use server'
  if (!(await gate())) return { ok: false as const, message: 'Không có quyền.' }
  return { ok: true as const, rows: [{ ...CONV_ROWS[0], taskId: S(698), customerName: 'KH QA trang 2' }], next: null }
}
const LIST: CareImportOrderList = {
  periodMonth: '2026-10-01', isCurrentPeriod: true, periodStatus: 'active', closedAt: null, closedThrough: null, lastSuccessAt: '2026-10-15T02:30:00.000000Z',
  summary: { tasks: 120, covered: 112, withOrders: 4, notCovered: 8, lagging: 1, minCoveredUntil: '2026-10-14T12:30:00.000000Z', maxCoveredUntil: '2026-10-15T02:30:00.000000Z' },
  partial: true, rows: IMPORT_ROWS, hasMore: true,
}
const STATES: { key: string; state: CareImportOrderState }[] = [
  { key: 'none', state: { periodMonth: '2026-10-01', isCurrentPeriod: true, hasSynced: false, lastSuccessAt: null, lastFailed: false, periodStatus: 'active', closedAt: null, closedThrough: null, chain: null } },
  { key: 'synced', state: { periodMonth: '2026-10-01', isCurrentPeriod: true, hasSynced: true, lastSuccessAt: '2026-10-15T02:30:00.000000Z', lastFailed: false, periodStatus: 'active', closedAt: null, closedThrough: null,
    chain: { tasks: 1384, covered: 1380, withOrders: 212 } } },
  { key: 'stale', state: { periodMonth: '2026-10-01', isCurrentPeriod: true, hasSynced: true, lastSuccessAt: '2026-10-14T02:30:00.000000Z', lastFailed: true, periodStatus: 'active', closedAt: null, closedThrough: null, chain: null } },
  { key: 'closed', state: { periodMonth: '2026-09-01', isCurrentPeriod: false, hasSynced: true, lastSuccessAt: '2026-10-15T02:30:00.000000Z', lastFailed: false, periodStatus: 'closed',
    closedAt: '2026-09-30T17:40:12.000000Z', closedThrough: '2026-09-30T17:00:00.000000Z', chain: { tasks: 1290, covered: 1290, withOrders: 301 } } },
]

export default async function CareOrdersCatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!catalogOn()) notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const sp = await searchParams
  const filter = { month: '2026-10-01', storeId: null, assigneeId: null }
  if (sp.frame === 'orders' || sp.frame === 'conversion') {
    const basis = sp.frame === 'orders' ? 'import' : 'care'
    const partial = careImportPartialText(LIST)
    return (
      <div data-layout-width="fluid" data-care-browse className="space-y-4 p-4 md:p-6" data-testid={`catalog-frame-${sp.frame}`}>
        <PageHeader title={basis === 'import' ? 'Đơn xác thực sau import' : 'Khách có đơn sau chăm sóc'} icon={Receipt} />
        <FilterTabs ariaLabel="Cơ sở danh sách đơn" activeKey={basis} tabs={[
          { key: 'import', label: 'Đơn sau import', href: '/ui-catalog/care-orders?frame=orders' },
          { key: 'care', label: 'Có đơn sau chăm sóc', href: '/ui-catalog/care-orders?frame=conversion' }]} />
        {basis === 'import' ? (
          <>
            {partial && <p role="note" data-testid="care-orders-partial" className="rounded-lg border border-status-warning/40 bg-status-warning-bg p-3 text-sm break-words text-status-warning">{partial}</p>}
            <CareImportOrdersTable initial={LIST.rows} next="catalog-cursor" filter={filter} loadMore={fakeMoreImport} />
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground" data-testid="care-conversion-totals">5 task theo báo cáo; 3 task bạn còn quyền xem (task đã chuyển giao ra ngoài phạm vi vẫn được tính trong báo cáo).</p>
            <CareConversionTable initial={CONV_ROWS} next="catalog-cursor" filter={filter} loadMore={fakeMoreConv} />
          </>
        )}
      </div>
    )
  }
  return (
    <div data-layout-width="fluid" className="space-y-6 p-4 md:p-6" data-testid="catalog-care-orders">
      <PageHeader title="Đơn xác thực sau import — catalog" subtitle="Dữ liệu giả · các trạng thái E0 §5" icon={Receipt} />
      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Khối trên /care/reports</h2>
        {STATES.map((s) => <div key={s.key} data-testid={`catalog-block-${s.key}`}><CareImportOrdersBlock state={s.state} href="/ui-catalog/care-orders?frame=orders" /></div>)}
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Chi tiết task</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {CASES.map((c) => (
            <div key={c.key} className="space-y-1" data-testid={`catalog-orders-${c.key}`}>
              <p className="text-xs text-muted-foreground">{c.title}</p>
              <CareTaskOrdersSection taskId={S(500)} initial={c.view} next={c.next} loadMore={fakeMoreOrders} />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
