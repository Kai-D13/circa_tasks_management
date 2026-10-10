import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft, HeartHandshake } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { ErrorState } from '@/components/ds/ErrorState'
import { buttonVariants } from '@/components/ui/button'
import { CareMyTaskDetail } from '@/components/care/CareMyTaskDetail'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import { careStaffTaskBlock } from '@/lib/care/my'
import { loadCareTaskDetail } from '@/lib/care/server/browse'
import { requireCareStaff } from '@/lib/care/server/my'
import { loadMoreMyCareInteractions } from '@/app/actions/careMy'
import { cn } from '@/lib/utils'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// /care/my/[id] — chi tiết khách cho dược sĩ (SPEC B4 §2). RLS quyết thấy task không:
// không thấy (không giao/đã chuyển đi) ⇒ 404. Chỉ assignee + task mở kỳ hiện tại mới có nút ghi.
export default async function CareMyTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireCareStaff()
  const { id } = await params
  if (!UUID_RE.test(id)) notFound()
  const back = <Link href="/care/my" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'min-h-[44px]')}><ChevronLeft className="size-4" /> Danh sách</Link>
  const header = <PageHeader title="Chăm sóc khách" icon={HeartHandshake} actions={back} />
  let detail: Awaited<ReturnType<typeof loadCareTaskDetail>>
  try {
    detail = await loadCareTaskDetail(id)
  } catch {
    return <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">{header}<ErrorState message="Không tải được thông tin khách." hint="Thử tải lại trang." /></div>
  }
  if (!detail) notFound()
  const now = new Date()
  const t = detail.task
  // Q-82: cùng điều kiện với action/upload/RPC (assignee + đúng store task + mở + kỳ hiện tại).
  const canRecord = careStaffTaskBlock(t, me, carePeriodOf(now)) === null
  return (
    <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">
      {header}
      <CareMyTaskDetail
        todayISO={vnDateISO(now)}
        canRecord={canRecord}
        updateHref={`/care/my/${t.id}/update`}
        loadMore={loadMoreMyCareInteractions}
        data={{ task: t, products: detail.products, interactions: detail.interactions, events: detail.events }}
      />
    </div>
  )
}
