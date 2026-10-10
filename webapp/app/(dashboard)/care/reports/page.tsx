import { BarChart3, Store } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { ErrorState } from '@/components/ds/ErrorState'
import { EmptyState } from '@/components/ds/EmptyState'
import { CareFiltersBar } from '@/components/care/CareFiltersBar'
import { CareReportView } from '@/components/care/CareReportView'
import { careFilterHref, parseCareFilters, recentCarePeriods } from '@/lib/care/browse'
import { CARE_REPORT_STORE_OUT_OF_SCOPE } from '@/lib/care/reports'
import { carePeriodOf } from '@/lib/care/time'
import { loadCareReport } from '@/lib/care/server/reports'
import { requireCareViewer } from '@/lib/care/server/pageGuard'

// /care/reports — Báo cáo CSKH (SPEC §B5a.2): super/care admin toàn chuỗi, SM theo vùng; QLCH/staff/FS
// 404 (requireCareViewer). Số liệu từ care_report (DEFINER, scope server); filter URL chỉ thu hẹp.
export default async function CareReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const g = await requireCareViewer()
  const header = <PageHeader title="Báo cáo chăm sóc khách hàng" subtitle="Theo tháng chăm sóc — khách có đơn ghi vào tháng của lượt Hoàn thành" icon={BarChart3} />
  if (g.kind === 'unavailable') {
    return <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">{header}<ErrorState message="Hệ thống CRM chưa sẵn sàng." hint="Cơ sở dữ liệu chưa có cấu hình CRM — báo quản trị." /></div>
  }
  const current = carePeriodOf(new Date())
  const f = parseCareFilters(await searchParams, current)
  try {
    const d = await loadCareReport(g.perms, f)
    const scoped = { month: f.month, storeId: d.storeId, assigneeId: f.assigneeId }
    return (
      <div data-layout-width="fluid" className="space-y-6 p-4 md:p-6">
        {header}
        <CareFiltersBar path="/care/reports" filters={{ ...f, storeId: d.storeId, status: null, page: 1 }} months={recentCarePeriods(current)} stores={d.stores} staff={d.staff} />
        {d.storeOutOfScope ? (
          // Filter cửa hàng ngoài scope ⇒ báo rõ, KHÔNG âm thầm hiện toàn scope (SPEC §B5a r1.1).
          <EmptyState icon={Store} title={CARE_REPORT_STORE_OUT_OF_SCOPE} hint="Chọn lại cửa hàng trong bộ lọc." />
        ) : (
          <CareReportView monthLabel={`${f.month.slice(5, 7)}/${f.month.slice(0, 4)}`} lines={d.lines} totals={d.totals}
            orderState={d.orderState} exportHref={careFilterHref('/api/export/care', scoped)} />
        )}
      </div>
    )
  } catch {
    return (
      <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">
        {header}
        <ErrorState message="Không tải được báo cáo chăm sóc." hint="Thử tải lại trang." />
      </div>
    )
  }
}
