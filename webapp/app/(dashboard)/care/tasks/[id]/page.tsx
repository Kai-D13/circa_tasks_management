import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft, ClipboardList } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { ErrorState } from '@/components/ds/ErrorState'
import { CareUnavailableState } from '@/components/care/CareUnavailableState'
import { buttonVariants } from '@/components/ui/button'
import { CareTaskDetailView } from '@/components/care/CareTaskDetailView'
import { CareTaskTransferButton } from '@/components/care/CareTaskTransferButton'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import { loadCareTaskDetail } from '@/lib/care/server/browse'
import { requireCareViewer } from '@/lib/care/server/pageGuard'
import { isCareQaActive } from '@/lib/care/server/qaUi'
import { listCareTransferTargets, loadMoreCareInteractions, transferCareTasks } from '@/app/actions/care'
import { cn } from '@/lib/utils'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// /care/tasks/[id] — chi tiết CHỈ ĐỌC trên browser (SPEC B3 §2). RLS quyết định có
// thấy task không (không thấy ⇒ 404). Chuyển giao một task cho SM/super khi task mở kỳ hiện tại.
export default async function CareTaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const g = await requireCareViewer()
  const { id } = await params
  const back = <Link href="/care/tasks" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'min-h-[44px] md:min-h-0')}><ChevronLeft className="size-4" /> Danh sách</Link>
  const header = <PageHeader title="Chi tiết chăm sóc" icon={ClipboardList} actions={back} />
  if (g.kind === 'unavailable') {
    return <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">{header}<CareUnavailableState /></div>
  }
  if (!UUID_RE.test(id)) notFound()
  let detail: Awaited<ReturnType<typeof loadCareTaskDetail>>
  try {
    detail = await loadCareTaskDetail(id)
  } catch {
    return <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">{header}<ErrorState message="Không tải được chi tiết." hint="Thử tải lại trang." /></div>
  }
  if (!detail) notFound()
  const now = new Date()
  const t = detail.task
  const transferable = g.perms.canTransfer && t.status === 'open' && t.period_month === carePeriodOf(now)
  return (
    <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">
      {header}
      <CareTaskDetailView
        taskId={t.id}
        todayISO={vnDateISO(now)}
        loadMore={loadMoreCareInteractions}
        qa={isCareQaActive()}
        data={{
          task: t,
          products: detail.products,
          interactions: detail.interactions,
          events: detail.events,
        }}
        actions={transferable ? (
          <CareTaskTransferButton
            task={{ id: t.id, customerName: t.customer_name, storeId: t.store_id, storeCode: t.store?.code ?? '—', assigneeId: t.assignee_id, assigneeName: t.assignee?.full_name ?? '—' }}
            loadTargets={listCareTransferTargets}
            transfer={transferCareTasks}
          />
        ) : undefined}
      />
    </div>
  )
}
