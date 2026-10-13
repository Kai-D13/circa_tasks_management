import { BarChart3, Store } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { ErrorState } from '@/components/ds/ErrorState'
import { EmptyState } from '@/components/ds/EmptyState'
import { CareFiltersBar } from '@/components/care/CareFiltersBar'
import { CareReportExportLink, CareReportView } from '@/components/care/CareReportView'
import { CareContactedKpiLive, CareContactedPaceLive, CareReportExtrasProvider, CareReportOutcomesLive } from '@/components/care/CareReportExtras'
import { loadCareReportExtras } from '@/app/actions/careReports'
import { careFilterHref, parseCareFilters, periodDue, recentCarePeriods } from '@/lib/care/browse'
import { CARE_REPORT_STORE_OUT_OF_SCOPE, carePeriodElapsed, careReportExtrasKey } from '@/lib/care/reports'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import { loadCareReport } from '@/lib/care/server/reports'
import { requireCareViewer } from '@/lib/care/server/pageGuard'

// /care/reports — Báo cáo CSKH (SPEC §B5a.2; B8.2 theo artboard 13): super/care admin toàn chuỗi, SM theo vùng;
// QLCH/staff/FS 404 (requireCareViewer). Số liệu từ care_report (DEFINER, scope server) + "Đã liên hệ" qua
// session/RLS; filter URL chỉ thu hẹp. Header gom Kỳ/Cửa hàng/Dược sĩ/Xuất Excel; "Đã liên hệ"/"Kết quả" tải sau khi hiện.
export default async function CareReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const g = await requireCareViewer()
  const header = <PageHeader title="Báo cáo chăm sóc khách hàng" subtitle="Theo tháng chăm sóc — khách có đơn ghi vào tháng của lượt Hoàn thành" icon={BarChart3} />
  if (g.kind === 'unavailable') {
    return <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">{header}<ErrorState message="Hệ thống CRM chưa sẵn sàng." hint="Cơ sở dữ liệu chưa có cấu hình CRM — báo quản trị." /></div>
  }
  const now = new Date()
  const current = carePeriodOf(now)
  const today = vnDateISO(now)
  const f = parseCareFilters(await searchParams, current)
  try {
    const d = await loadCareReport(g.perms, f)
    const scoped = { month: f.month, storeId: d.storeId, assigneeId: f.assigneeId }
    const due = periodDue(f.month)
    const extras = { month: f.month.slice(0, 7), store: scoped.storeId, assignee: scoped.assigneeId }
    return (
      <div data-layout-width="fluid" data-care-browse className="space-y-4 p-4 md:p-6">
        <PageHeader title="Báo cáo chăm sóc khách hàng" subtitle="Theo tháng chăm sóc — khách có đơn ghi vào tháng của lượt Hoàn thành" icon={BarChart3}
          actions={(
            <div className="flex flex-wrap items-center gap-2">
              <CareFiltersBar path="/care/reports" filters={{ ...f, storeId: d.storeId, status: null, page: 1 }} months={recentCarePeriods(current)} stores={d.stores} staff={d.staff} />
              <CareReportExportLink href={careFilterHref('/api/export/care', scoped)} />
            </div>
          )} />
        {d.storeOutOfScope ? (
          // Filter cửa hàng ngoài scope ⇒ báo rõ, KHÔNG âm thầm hiện toàn scope (SPEC §B5a r1.1).
          <EmptyState icon={Store} title={CARE_REPORT_STORE_OUT_OF_SCOPE} hint="Chọn lại cửa hàng trong bộ lọc." />
        ) : (
          // "Đã liên hệ" (Q-113) + "Kết quả liên hệ" (Q-117) tải SAU khi trang hiện, một server action (không tranh
          // pool với render khung trang — đo 14/10).
          // `key` theo bộ lọc ⇒ đổi kỳ/store/dược sĩ là provider mới, không mang số của bộ lọc cũ (PM B8.2 r1).
          <CareReportExtrasProvider key={careReportExtrasKey(extras)} load={loadCareReportExtras} params={extras}>
            <CareReportView monthLabel={`${f.month.slice(5, 7)}/${f.month.slice(0, 4)}`} lines={d.lines} totals={d.totals}
              contacted={{ kpi: <CareContactedKpiLive tasks={d.totals.tasks} />, pace: <CareContactedPaceLive tasks={d.totals.tasks} /> }}
              orderState={d.orderState} elapsed={carePeriodElapsed(f.month, today)}
              dueLabel={`${due.slice(8, 10)}/${due.slice(5, 7)}/${due.slice(0, 4)}`} scope={scoped}
              outcomes={<CareReportOutcomesLive />} />
          </CareReportExtrasProvider>
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
