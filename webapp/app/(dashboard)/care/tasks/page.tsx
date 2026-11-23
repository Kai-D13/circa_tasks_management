import { Suspense } from 'react'
import { ClipboardList } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { ErrorState } from '@/components/ds/ErrorState'
import { CareUnavailableState } from '@/components/care/CareUnavailableState'
import { CareFiltersBar } from '@/components/care/CareFiltersBar'
import { CareStatusChips, CareStatusChipsBare } from '@/components/care/CareStatusChips'
import { CareTaskTable } from '@/components/care/CareTaskTable'
import { careFilterHref, parseCareFilters, parseCareOpenParam, parseCareReason, periodDue, recentCarePeriods } from '@/lib/care/browse'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import { CARE_TASK_PAGE_SIZE, loadCareReasonOptions, loadCareTaskPage, loadScopeStaff, loadScopeStores } from '@/lib/care/server/browse'
import { requireCareViewer } from '@/lib/care/server/pageGuard'
import { listCareTransferTargets, loadCareTaskPanel, loadMoreCareInteractions, searchCareTasks, transferCareTasks } from '@/app/actions/care'

// /care/tasks — Chăm sóc (SPEC B3 §2–3; B8.1 theo artboard 12): danh sách task theo phạm vi RLS,
// phân trang server; chip trạng thái có số (cùng kỳ/store/dược sĩ/lý do, không áp từ khoá tìm); nhãn + lọc Lý do
// (PM 22/11, sản phẩm hiện hành); drawer
// chi tiết `?open=<uuid>`; chuyển giao có ghi chú cho SM/super (task đang mở kỳ hiện tại).
export default async function CareTasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const g = await requireCareViewer()
  const sp = await searchParams
  const now = new Date()
  const current = carePeriodOf(now)
  const today = vnDateISO(now)
  // PM 22/11: lọc lý do chỉ có ở trang này — đọc riêng, không nằm trong parseCareFilters dùng chung với tổng quan / báo cáo.
  const f = { ...parseCareFilters(sp, current), reason: parseCareReason(sp) }
  const due = periodDue(f.month)
  const subtitle = `Danh sách khách cần chăm sóc theo kỳ · hạn ${due.slice(8, 10)}/${due.slice(5, 7)}/${due.slice(0, 4)}`
  if (g.kind === 'unavailable') {
    const header = <PageHeader title="Chăm sóc khách hàng" subtitle="Danh sách khách cần chăm sóc theo kỳ" icon={ClipboardList} />
    return <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">{header}<CareUnavailableState /></div>
  }
  const header = (
    <PageHeader title="Chăm sóc khách hàng" subtitle={subtitle} icon={ClipboardList}
      actions={<CareFiltersBar path="/care/tasks" filters={f} months={recentCarePeriods(current)} />} />
  )

  let content: React.ReactNode
  let chips: React.ReactNode = null
  try {
    // Danh sách + phạm vi store chạy song song; số đếm chip stream SAU (Suspense) để không tranh pool với danh sách.
    const [stores, page] = await Promise.all([loadScopeStores(g.perms), loadCareTaskPage(f, today)])
    const [staff, reasons] = await Promise.all([loadScopeStaff(stores), loadCareReasonOptions(f.month)])
    chips = (
      <Suspense fallback={<CareStatusChipsBare path="/care/tasks" filters={f} />}>
        <CareStatusChips path="/care/tasks" filters={f} todayISO={today} />
      </Suspense>
    )
    content = (
      <CareTaskTable
        key={careFilterHref('/care/tasks', f)}
        rows={page.rows}
        total={page.total}
        pageSize={CARE_TASK_PAGE_SIZE}
        filters={f}
        path="/care/tasks"
        todayISO={today}
        canTransfer={g.perms.canTransfer}
        isCurrentPeriod={f.month === current}
        search={searchCareTasks}
        loadTargets={listCareTransferTargets}
        transfer={transferCareTasks}
        loadPanel={loadCareTaskPanel}
        loadMore={loadMoreCareInteractions}
        initialOpenId={parseCareOpenParam(sp)}
        toolbar={<CareFiltersBar path="/care/tasks" filters={f} stores={stores} staff={staff} reasons={reasons ?? []} clearable />}
      />
    )
  } catch {
    content = <ErrorState message="Không tải được danh sách khách." hint="Thử tải lại trang." />
  }

  return (
    <div data-layout-width="fluid" data-care-browse className="space-y-4 p-4 md:p-6">
      {header}
      {chips}
      {content}
    </div>
  )
}
