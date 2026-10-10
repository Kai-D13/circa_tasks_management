import { ClipboardList } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { ErrorState } from '@/components/ds/ErrorState'
import { CareFiltersBar } from '@/components/care/CareFiltersBar'
import { CareTaskTable } from '@/components/care/CareTaskTable'
import { careFilterHref, parseCareFilters, recentCarePeriods } from '@/lib/care/browse'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import { CARE_TASK_PAGE_SIZE, loadCareTaskPage, loadScopeStaff, loadScopeStores } from '@/lib/care/server/browse'
import { requireCareViewer } from '@/lib/care/server/pageGuard'
import { listCareTransferTargets, searchCareTasks, transferCareTasks } from '@/app/actions/care'

// /care/tasks — Chăm sóc (SPEC B3 §2–3): danh sách task theo phạm vi RLS, phân trang
// server; chuyển giao có ghi chú cho SM/super (task đang mở kỳ hiện tại).
export default async function CareTasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const g = await requireCareViewer()
  const header = <PageHeader title="Chăm sóc khách hàng" subtitle="Danh sách khách cần chăm sóc theo kỳ" icon={ClipboardList} />
  if (g.kind === 'unavailable') {
    return <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">{header}<ErrorState message="Hệ thống CRM chưa sẵn sàng." hint="Cơ sở dữ liệu chưa có cấu hình CRM — báo quản trị." /></div>
  }
  const now = new Date()
  const current = carePeriodOf(now)
  const today = vnDateISO(now)
  const f = parseCareFilters(await searchParams, current)

  let content: React.ReactNode
  let stores: Awaited<ReturnType<typeof loadScopeStores>> = []
  let staff: Awaited<ReturnType<typeof loadScopeStaff>> = []
  try {
    stores = await loadScopeStores(g.perms)
    staff = await loadScopeStaff(stores)
    const { rows, total } = await loadCareTaskPage(f, today)
    content = (
      <CareTaskTable
        key={careFilterHref('/care/tasks', f)}
        rows={rows}
        total={total}
        pageSize={CARE_TASK_PAGE_SIZE}
        filters={f}
        path="/care/tasks"
        todayISO={today}
        canTransfer={g.perms.canTransfer}
        isCurrentPeriod={f.month === current}
        search={searchCareTasks}
        loadTargets={listCareTransferTargets}
        transfer={transferCareTasks}
      />
    )
  } catch {
    content = <ErrorState message="Không tải được danh sách khách." hint="Thử tải lại trang." />
  }

  return (
    <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">
      {header}
      <CareFiltersBar path="/care/tasks" filters={f} months={recentCarePeriods(current)} stores={stores} staff={staff} showStatus />
      {content}
    </div>
  )
}
