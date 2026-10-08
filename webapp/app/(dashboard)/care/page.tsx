import { HeartHandshake } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { ErrorState } from '@/components/ds/ErrorState'
import { CareFiltersBar } from '@/components/care/CareFiltersBar'
import { CareDashboardView } from '@/components/care/CareDashboardView'
import {
  careOutcomeDistribution, careReportByStore, careReportTotals, isPastPeriod, parseCareFilters, recentCarePeriods,
} from '@/lib/care/browse'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import { loadCareDashboard, loadScopeStores } from '@/lib/care/server/browse'
import { requireCareViewer } from '@/lib/care/server/pageGuard'

// /care — Khách hàng (SPEC B3 §2): tổng quan kỳ theo phạm vi người xem (RLS/care_report).
export default async function CarePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const g = await requireCareViewer()
  const header = <PageHeader title="Chăm sóc khách hàng" subtitle="Tổng quan theo kỳ — mỗi khách một task trong tháng" icon={HeartHandshake} />
  if (g.kind === 'unavailable') {
    return <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">{header}<ErrorState message="Hệ thống CRM chưa sẵn sàng." hint="Cơ sở dữ liệu chưa có cấu hình CRM — báo quản trị." /></div>
  }
  const now = new Date()
  const current = carePeriodOf(now)
  const today = vnDateISO(now)
  const f = parseCareFilters(await searchParams, current)
  const isPast = isPastPeriod(f.month, current)

  let body: React.ReactNode
  let stores: Awaited<ReturnType<typeof loadScopeStores>> = []
  try {
    stores = await loadScopeStores(g.perms)
    const scoped = f.storeId && !stores.some((s) => s.id === f.storeId) ? { ...f, storeId: null } : f
    const d = await loadCareDashboard(scoped, today, !isPast)
    const byCode = new Map(stores.map((s) => [s.id, s]))
    body = (
      <CareDashboardView
        monthLabel={`${f.month.slice(5, 7)}/${f.month.slice(0, 4)}`}
        isPast={isPast}
        totals={careReportTotals(d.rows)}
        overdueOpen={d.overdueOpen}
        stores={careReportByStore(d.rows)
          .map((s) => ({ code: byCode.get(s.storeId)?.code ?? '—', name: byCode.get(s.storeId)?.name ?? '', totals: s.totals }))
          .sort((a, b) => a.code.localeCompare(b.code))}
        outcomes={careOutcomeDistribution(d.outcomes)}
      />
    )
  } catch {
    body = <ErrorState message="Không tải được số liệu chăm sóc." hint="Thử tải lại trang." />
  }

  return (
    <div data-layout-width="fluid" className="space-y-6 p-4 md:p-6">
      {header}
      <CareFiltersBar path="/care" filters={f} months={recentCarePeriods(current)} stores={stores} />
      {body}
    </div>
  )
}
