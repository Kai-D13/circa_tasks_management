import { HeartHandshake, Store } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { ErrorState } from '@/components/ds/ErrorState'
import { CareUnavailableState } from '@/components/care/CareUnavailableState'
import { EmptyState } from '@/components/ds/EmptyState'
import { CareFiltersBar } from '@/components/care/CareFiltersBar'
import { CareDashboardView } from '@/components/care/CareDashboardView'
import {
  careOutcomeDistribution, careReportByStore, careReportTotals, isPastPeriod, parseCareFilters, recentCarePeriods,
} from '@/lib/care/browse'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import { loadCareDashboard, loadScopeStores } from '@/lib/care/server/browse'
import { loadOrderDataState } from '@/lib/care/server/reports'
import {
  CARE_REPORT_STORE_OUT_OF_SCOPE, careReportConvertedTotal, careStoreFilterInScope, type CareOrderDataState,
} from '@/lib/care/reports'
import { requireCareViewer } from '@/lib/care/server/pageGuard'

// /care — Khách hàng (SPEC B3 §2): tổng quan kỳ theo phạm vi người xem (RLS/care_report).
// B8.4 (artboard 05): bộ lọc kỳ/cửa hàng trên header; ô KPI cùng tập là link /care/tasks giữ kỳ + cửa hàng.
export default async function CarePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const g = await requireCareViewer()
  const title = { title: 'Chăm sóc khách hàng', subtitle: 'Tổng quan theo kỳ — mỗi khách một task trong tháng', icon: HeartHandshake }
  if (g.kind === 'unavailable') {
    return <div data-layout-width="fluid" data-care-browse className="space-y-4 p-4 md:p-6"><PageHeader {...title} /><CareUnavailableState /></div>
  }
  const now = new Date()
  const current = carePeriodOf(now)
  const today = vnDateISO(now)
  const f = parseCareFilters(await searchParams, current)
  const isPast = isPastPeriod(f.month, current)

  let body: React.ReactNode
  let stores: Awaited<ReturnType<typeof loadScopeStores>> = []
  let outOfScope = false
  const dashboardBody = async () => {
    // Trạng thái đơn lỗi ⇒ dashboard vẫn hiện số task, phần đơn về "Chưa có dữ liệu đơn" (không hiện số);
    // trang /care/reports thì fail-closed.
    const [d, orderState] = await Promise.all([
      loadCareDashboard(f, today, !isPast),
      loadOrderDataState().catch((): CareOrderDataState => ({ kind: 'none' })),
    ])
    const byCode = new Map(stores.map((s) => [s.id, s]))
    return (
      <CareDashboardView
        monthLabel={`${f.month.slice(5, 7)}/${f.month.slice(0, 4)}`}
        isPast={isPast}
        totals={careReportTotals(d.rows)}
        overdueOpen={d.overdueOpen}
        stores={careReportByStore(d.rows)
          .map((s) => ({ code: byCode.get(s.storeId)?.code ?? '—', name: byCode.get(s.storeId)?.name ?? '', totals: s.totals }))
          .sort((a, b) => a.code.localeCompare(b.code))}
        outcomes={careOutcomeDistribution(d.outcomes)}
        orders={{ state: orderState, convertedTasks: careReportConvertedTotal(d.rows) }}
        scope={{ month: f.month, storeId: f.storeId }}
        assignees={new Set(d.rows.filter((r) => r.tasks_total > 0).map((r) => r.assignee_id)).size}
      />
    )
  }
  try {
    stores = await loadScopeStores(g.perms)
    // Filter cửa hàng ngoài scope ⇒ báo rõ, KHÔNG âm thầm hiện toàn scope (SPEC §B5a r1.1).
    outOfScope = !careStoreFilterInScope(f.storeId, stores)
    body = outOfScope
      ? <EmptyState icon={Store} title={CARE_REPORT_STORE_OUT_OF_SCOPE} hint="Chọn lại cửa hàng trong bộ lọc." />
      : await dashboardBody()
  } catch {
    body = <ErrorState message="Không tải được số liệu chăm sóc." hint="Thử tải lại trang." />
  }

  return (
    <div data-layout-width="fluid" data-care-browse className="space-y-4 p-4 md:p-6">
      <PageHeader {...title}
        actions={<CareFiltersBar path="/care" filters={outOfScope ? { ...f, storeId: null } : f} months={recentCarePeriods(current)} stores={stores} />} />
      {body}
    </div>
  )
}
