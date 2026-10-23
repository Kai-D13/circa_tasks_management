import { HeartHandshake } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { ErrorState } from '@/components/ds/ErrorState'
import { CareMyHome } from '@/components/care/CareMyHome'
import { CareMyHeader } from '@/components/care/CareMyHeader'
import { CareMyScreen } from '@/components/care/CareMyScreen'
import { CARE_MY_PAGE_SIZE, parseMyFilters } from '@/lib/care/my'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import { loadMySummary, loadMyTaskPage, loadMyTasksByIds, requireCareStaff } from '@/lib/care/server/my'
import { careOrderLinksUiOn, isCareOrderQaScope, loadImportOrderState, loadMyOrderSummary, loadMyOrderTaskIds } from '@/lib/care/server/orderLinks'
import { careMyOrdersView } from '@/lib/care/orderLinks/view'
import { isCareQaActive } from '@/lib/care/server/qaUi'
import { searchMyCareTasks } from '@/app/actions/careMy'
import { loadMoreMyOrderTasks } from '@/app/actions/careOrders'

// /care/my — "Khách hàng của tôi" (SPEC B4 §2): dược sĩ OS, task kỳ hiện tại giao cho mình.
// Cờ OFF ⇒ 404 trước mọi đọc; role khác ⇒ 404. Đọc bằng session + RLS 114.
// B7-ui r2 (artboard 08): mobile dùng header riêng (CareMyHeader) — PageHeader chỉ từ md.
export default async function CareMyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireCareStaff()
  const header = (
    <>
      <CareMyHeader screen="list" qa={isCareQaActive()} />
      <PageHeader title="Khách hàng của tôi" icon={HeartHandshake} className="hidden md:flex" />
    </>
  )
  const now = new Date()
  const today = vnDateISO(now)
  const sp = await searchParams
  const f = parseMyFilters(sp)
  // E3 (cờ UI): chip "Có đơn xác thực" — task kỳ hiện tại của mình có ≥ 1 đơn N3 sau import, mới nhất trước; 20 / trang,
  // "Xem thêm" bằng keyset (cursor ký, POST). Tổng = số trên chip (care_my_order_summary); tìm trong nhóm giữ điều kiện có đơn.
  const ui = careOrderLinksUiOn()
  const ordersView = ui && sp.filter === 'orders'
  const period = carePeriodOf(now)
  const qaScope = ui && isCareOrderQaScope()
  try {
    // PM 22/10 F1: tóm tắt của mình + trạng thái lượt đồng bộ (RPC 116 care_import_order_state, session — không `chain`) đọc SONG
    // SONG; lỗi một nguồn KHÔNG làm hỏng trang (task vẫn dùng được) — chỉ phần số đơn fail-closed ('none').
    const [summary, list, orderSummary, orderStatus] = await Promise.all([
      loadMySummary(me),
      ordersView
        ? loadMyOrderTaskIds(me.userId, period).then(async (o) => ({ rows: await loadMyTasksByIds(me, period, o.taskIds, today), total: null, next: o.next }))
        : loadMyTaskPage(me, period, f.filter, f.page, today).then((p) => ({ ...p, next: null })),
      ui ? loadMyOrderSummary().catch(() => null) : Promise.resolve(null),
      ui && !qaScope ? loadImportOrderState(period).catch(() => 'error' as const) : Promise.resolve(null),
    ])
    // PM 22/10 P1 "số 0 giả": chưa quét / không đọc được / lệch kỳ ('none') ⇒ ẩn chip (trừ khi đang ở chip) và không đếm;
    // một phần / lượt lỗi / quá 24 giờ ('partial') ⇒ số kèm ghi chú mốc.
    const orders = careMyOrdersView({ summary: orderSummary, status: orderStatus, period, now, qa: qaScope })
    const ordersState = orders.state
    const ordersTotal = orderSummary && ordersState !== 'none' ? orderSummary.tasksWithOrders : null
    return (
      <CareMyScreen screen="list">
        {header}
        <div className="px-4 pt-1 pb-4 md:p-0">
          <CareMyHome key={`${ordersView ? 'orders' : f.filter}:${f.page}`} summary={summary} rows={list.rows}
            total={list.total ?? ordersTotal ?? list.rows.length} filter={f.filter} page={ordersView ? 1 : f.page}
            pageSize={CARE_MY_PAGE_SIZE} todayISO={today} search={searchMyCareTasks}
            ordersChip={ui && ((orderSummary && ordersState !== 'none') || ordersView) ? { count: ordersTotal ?? undefined, active: ordersView } : undefined}
            ordersList={ordersView ? { next: list.next, total: ordersTotal, loadMore: loadMoreMyOrderTasks, state: ordersState } : undefined}
            ordersNote={ui ? orders.note : null} />
        </div>
      </CareMyScreen>
    )
  } catch {
    return (
      <CareMyScreen screen="list">
        {header}
        <div className="px-4 pt-1 pb-4 md:p-0">
          <ErrorState message="Hệ thống chăm sóc khách hàng chưa sẵn sàng." hint="Thử tải lại trang; nếu vẫn lỗi, báo quản lý." />
        </div>
      </CareMyScreen>
    )
  }
}
