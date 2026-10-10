import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft, NotebookPen } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { ErrorState } from '@/components/ds/ErrorState'
import { buttonVariants } from '@/components/ui/button'
import { CareInteractionForm } from '@/components/care/CareInteractionForm'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import { careStaffTaskBlock } from '@/lib/care/my'
import { createClient } from '@/lib/supabase/server'
import { requireCareStaff } from '@/lib/care/server/my'
import { careDataScope } from '@/lib/care/server/qaUi'
import { withCareScope } from '@/lib/care/scope'
import { recordCareInteraction } from '@/app/actions/careMy'
import { cn } from '@/lib/utils'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// /care/my/[id]/update — form ghi lượt (SPEC B4 §3). Chỉ assignee + task mở kỳ hiện tại;
// còn lại hiện thông báo chỉ đọc. RPC care_record_interaction là chốt cuối (kể cả khi task
// vừa được chuyển giao/đổi kỳ giữa lúc mở form).
export default async function CareMyUpdatePage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireCareStaff()
  const { id } = await params
  if (!UUID_RE.test(id)) notFound()
  const back = <Link href={`/care/my/${id}`} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'min-h-[44px]')}><ChevronLeft className="size-4" /> Quay lại</Link>
  const header = <PageHeader title="Ghi nhận chăm sóc" icon={NotebookPen} actions={back} />
  const supabase = await createClient()
  const scope = careDataScope()
  const { data: t, error } = await withCareScope(supabase.from('care_tasks')
    .select('id, customer_name, assignee_id, store_id, status, period_month, due_date').eq('id', id), scope).maybeSingle()
  if (error) {
    return <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">{header}<ErrorState message="Hệ thống chăm sóc khách hàng chưa sẵn sàng." /></div>
  }
  if (!t) notFound()
  const now = new Date()
  // Q-82: assignee + đúng store task + mở + kỳ hiện tại (cùng điều kiện action/upload/RPC).
  const open = careStaffTaskBlock(t, me, carePeriodOf(now)) === null
  return (
    <div data-layout-width="fluid" className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
      {header}
      {open ? (
        <CareInteractionForm taskId={t.id} customerName={t.customer_name} todayISO={vnDateISO(now)} dueDate={t.due_date}
          record={recordCareInteraction} doneHref={`/care/my/${t.id}`} proofDisabled={scope.kind === 'qa'} />
      ) : (
        <ErrorState message="Khách này không còn mở để ghi nhận." hint="Đã hoàn thành, đã qua kỳ hoặc vừa được chuyển cho dược sĩ khác." />
      )}
    </div>
  )
}
