import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft, HeartHandshake } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { ErrorState } from '@/components/ds/ErrorState'
import { buttonVariants } from '@/components/ui/button'
import { CareMyTaskDetail } from '@/components/care/CareMyTaskDetail'
import { CareMyHeader } from '@/components/care/CareMyHeader'
import { CareMyScreen } from '@/components/care/CareMyScreen'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import { careMyBackTarget, careStaffTaskBlock } from '@/lib/care/my'
import { isCareZaloLinkEnabled } from '@/lib/care/flags'
import { loadCareTaskDetail } from '@/lib/care/server/browse'
import { requireCareStaff } from '@/lib/care/server/my'
import { isCareQaActive } from '@/lib/care/server/qaUi'
import { loadMoreMyCareInteractions } from '@/app/actions/careMy'
import { loadMoreTaskOrders } from '@/app/actions/careOrders'
import { CareTaskOrdersSection } from '@/components/care/CareTaskOrdersSection'
import { careOrderLinksUiOn, loadTaskOrders } from '@/lib/care/server/orderLinks'
import { cn } from '@/lib/utils'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// B7-ui r2 (artboard 09): gốc trang CareMyScreen (thanh "Ghi nhận chăm sóc" sát đáy kể cả khi nội dung
// ngắn); header riêng CareMyHeader thay MobileHeader.

// /care/my/[id] — chi tiết khách cho dược sĩ (SPEC B4 §2). RLS quyết thấy task không:
// không thấy (không giao/đã chuyển đi) ⇒ 404. Chỉ assignee + task mở kỳ hiện tại mới có nút ghi.
export default async function CareMyTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireCareStaff()
  const { id } = await params
  if (!UUID_RE.test(id)) notFound()
  const back = <Link href="/care/my" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'hidden min-h-[44px] md:inline-flex')}><ChevronLeft className="size-4" /> Danh sách</Link>
  const header = (
    <>
      <CareMyHeader screen="detail" back={careMyBackTarget(`/care/my/${id}`) ?? undefined} qa={isCareQaActive()} />
      <PageHeader title="Chăm sóc khách" icon={HeartHandshake} actions={back} className="hidden md:flex" />
    </>
  )
  let detail: Awaited<ReturnType<typeof loadCareTaskDetail>>
  try {
    detail = await loadCareTaskDetail(id)
  } catch {
    return <CareMyScreen screen="detail">{header}<div className="p-4 md:p-0"><ErrorState message="Không tải được thông tin khách." hint="Thử tải lại trang." /></div></CareMyScreen>
  }
  if (!detail) notFound()
  const now = new Date()
  const t = detail.task
  // Q-82: cùng điều kiện với action/upload/RPC (assignee + đúng store task + mở + kỳ hiện tại).
  const canRecord = careStaffTaskBlock(t, me, carePeriodOf(now)) === null
  // E3: đơn xác thực sau import ở tab Tổng quan (cờ UI) — lỗi đọc ⇒ không có khối.
  const orders = careOrderLinksUiOn() ? await loadTaskOrders(me.userId, t.id).catch(() => null) : null
  return (
    <CareMyScreen screen="detail">
      {header}
      <CareMyTaskDetail
        zalo={isCareZaloLinkEnabled()}
        todayISO={vnDateISO(now)}
        canRecord={canRecord}
        updateHref={`/care/my/${t.id}/update`}
        loadMore={loadMoreMyCareInteractions}
        qa={isCareQaActive()}
        orders={orders ? <CareTaskOrdersSection taskId={t.id} initial={orders.view} next={orders.next} loadMore={loadMoreTaskOrders} compact /> : undefined}
        data={{ task: t, products: detail.products, interactions: detail.interactions, events: detail.events }}
      />
    </CareMyScreen>
  )
}
