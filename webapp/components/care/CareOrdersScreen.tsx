import { notFound } from 'next/navigation'
import { Receipt, Store } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { ErrorState } from '@/components/ds/ErrorState'
import { EmptyState } from '@/components/ds/EmptyState'
import { FilterTabs } from '@/components/ds/FilterTabs'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { CareFiltersBar } from '@/components/care/CareFiltersBar'
import { CareUnavailableState } from '@/components/care/CareUnavailableState'
import { CareConversionTable, CareImportOrdersTable } from '@/components/care/CareOrdersTable'
import { loadMoreConversion, loadMoreImportOrders } from '@/app/actions/careOrders'
import { careFilterHref, parseCareFilters, recentCarePeriods } from '@/lib/care/browse'
import { CARE_REPORT_STORE_OUT_OF_SCOPE, careStoreFilterInScope } from '@/lib/care/reports'
import { careImportPartialText, carePeriodCloseText, careVnTime } from '@/lib/care/orderLinks/view'
import { carePeriodOf } from '@/lib/care/time'
import { loadScopeStores } from '@/lib/care/server/browse'
import { careOrderLinksUiOn, loadConversionList, loadImportOrderList } from '@/lib/care/server/orderLinks'
import { requireCareViewer } from '@/lib/care/server/pageGuard'

// E3 — /care/orders (thiết kế E0 r3.4 §9): super / care admin toàn chuỗi, SM theo vùng (requireCareViewer); dược sĩ dùng
// chip trên /care/my. Cờ CARE_ORDER_LINKS_UI_ENABLED OFF ⇒ 404. Hai cơ sở:
//   · import (/care/orders): task của kỳ có đơn N3 hoàn tất SAU mốc import (task đích duy nhất của khách trong kỳ);
//   · care (/care/orders/care): cohort "Khách có đơn sau chăm sóc" — CÙNG vị từ với care_report (KPI 114 không đổi).
// Bộ lọc kỳ / cửa hàng / dược sĩ qua URL (không PII); trang sau qua server action (cursor ký, không URL).
export async function CareOrdersScreen({ basis, searchParams }: { basis: 'import' | 'care'; searchParams: Record<string, string | string[] | undefined> }) {
  const g = await requireCareViewer()
  if (!careOrderLinksUiOn()) notFound()
  const title = basis === 'import' ? 'Đơn xác thực sau import' : 'Khách có đơn sau chăm sóc'
  const subtitle = basis === 'import'
    ? 'Đơn N3 hoàn tất sau mốc import của task — đối chiếu bằng mã đơn trên POS'
    : 'Theo báo cáo: đơn N3 sau lượt chăm sóc Hoàn thành, ghi vào tháng của lượt'
  const header = <PageHeader title={title} subtitle={subtitle} icon={Receipt} />
  if (g.kind === 'unavailable') return <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">{header}<CareUnavailableState /></div>
  const current = carePeriodOf(new Date())
  const f = parseCareFilters(searchParams, current)
  const path = basis === 'import' ? '/care/orders' : '/care/orders/care'
  const scoped = { month: f.month, storeId: f.storeId, assigneeId: f.assigneeId }
  const tabs = [
    { key: 'import', label: 'Đơn sau import', href: careFilterHref('/care/orders', scoped) },
    { key: 'care', label: 'Có đơn sau chăm sóc', href: careFilterHref('/care/orders/care', scoped) },
  ]
  try {
    const stores = await loadScopeStores(g.perms)
    const bar = (
      <div className="flex flex-wrap items-center gap-2">
        <CareFiltersBar path={path} filters={{ ...f, status: null, page: 1 }} months={recentCarePeriods(current)} stores={stores} clearable />
      </div>
    )
    const shell = (body: React.ReactNode) => (
      <div data-layout-width="fluid" data-care-browse className="space-y-4 p-4 md:p-6">
        <PageHeader title={title} subtitle={subtitle} icon={Receipt} actions={bar} />
        <FilterTabs tabs={tabs} activeKey={basis} ariaLabel="Cơ sở danh sách đơn" />
        {body}
      </div>
    )
    if (!careStoreFilterInScope(f.storeId, stores)) return shell(<EmptyState icon={Store} title={CARE_REPORT_STORE_OUT_OF_SCOPE} hint="Chọn lại cửa hàng trong bộ lọc." />)

    if (basis === 'import') {
      const { list, next } = await loadImportOrderList(g.userId, scoped)
      const partial = careImportPartialText(list)
      const close = carePeriodCloseText(list)
      return shell(
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="care-orders-state">
            {close && <StatusBadge tone={close.tone}>{close.label}</StatusBadge>}
            {list.isCurrentPeriod && !list.lastSuccessAt && <StatusBadge tone="neutral">Chưa có dữ liệu đơn</StatusBadge>}
            <span className="text-muted-foreground">
              {list.summary.withOrders.toLocaleString('vi-VN')} / {list.summary.tasks.toLocaleString('vi-VN')} task có đơn sau import
              {list.isCurrentPeriod && list.lastSuccessAt && <> · cập nhật lúc {careVnTime(list.lastSuccessAt)}</>}
            </span>
          </div>
          {close && <p className="text-sm break-words text-muted-foreground">{close.text}</p>}
          {partial && <p role="note" data-testid="care-orders-partial" className="rounded-lg border border-status-warning/40 bg-status-warning-bg p-3 text-sm break-words text-status-warning">{partial}</p>}
          {list.rows.length === 0
            ? <EmptyState icon={Receipt} title="Chưa có task có đơn sau import" hint={list.summary.covered === 0 ? 'Chưa có dữ liệu đơn cho kỳ này.' : 'Không thấy đơn theo dữ liệu đã quét.'} />
            : <CareImportOrdersTable key={path + JSON.stringify(scoped)} initial={list.rows} next={next} filter={scoped} loadMore={loadMoreImportOrders} />}
        </>,
      )
    }
    const { list, next } = await loadConversionList(g.userId, scoped)
    return shell(
      <>
        <p className="text-sm text-muted-foreground" data-testid="care-conversion-totals">
          {list.cohortTotal.toLocaleString('vi-VN')} task theo báo cáo; {list.visibleTotal.toLocaleString('vi-VN')} task bạn còn quyền xem
          {list.cohortTotal !== list.visibleTotal && ' (task đã chuyển giao ra ngoài phạm vi vẫn được tính trong báo cáo)'}.
        </p>
        {list.rows.length === 0
          ? <EmptyState icon={Receipt} title="Chưa có khách có đơn sau chăm sóc" />
          : <CareConversionTable key={path + JSON.stringify(scoped)} initial={list.rows} next={next} filter={scoped} loadMore={loadMoreConversion} />}
      </>,
    )
  } catch {
    return <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">{header}<ErrorState message="Không tải được danh sách đơn." hint="Thử tải lại trang." /></div>
  }
}
