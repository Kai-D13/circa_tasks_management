import { Package, User } from 'lucide-react'
import { StatusBadge, type StatusTone } from '@/components/ds/StatusBadge'
import { EmptyState } from '@/components/ds/EmptyState'
import { careTaskState, CARE_STATUS_LABELS, type CareInteractionPage } from '@/lib/care/browse'
import { formatDateTime } from '@/lib/dateUtils'
import { CareProductGallery, type CareProductView } from './CareProductGallery'
import { CareTimeline, type CareLoadMoreInteractions, type CareTimelineEvent } from './CareTimeline'

// Chi tiết task browser, CHỈ ĐỌC (SPEC B3 §2): snapshot khách/kỳ/hạn/owner/store/
// trạng thái; sản phẩm của task từ file import hiện hành; dòng thời gian lượt chăm
// sóc + chuyển giao theo RLS (lịch sử khách theo helper B1). Không phải lịch sử mua.

export interface CareDetailViewData {
  task: {
    customer_name: string; phone_raw: string; phone_norm: string; period_month: string; due_date: string
    status: 'open' | 'completed' | 'closed_unfinished'; last_interaction_at: string | null; next_action_date: string | null
    first_overdue_on: string | null; completed_at: string | null; closed_at: string | null
    store: { code: string; name: string } | null; assignee: { full_name: string } | null
  }
  products: CareProductView[]
  /** Trang đầu lịch sử lượt (Q-78: 10 lượt mới nhất) — "Xem thêm" qua loadMore. */
  interactions: CareInteractionPage
  events: CareTimelineEvent[]
}

const STATE_TONE: Record<string, StatusTone> = { not_cared: 'neutral', following: 'warning', completed: 'success', closed_unfinished: 'danger' }
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

export function CareTaskDetailView({ taskId, data, todayISO, actions, loadMore, qa = false, layout = 'page' }: {
  taskId: string; data: CareDetailViewData; todayISO: string; actions?: React.ReactNode; loadMore?: CareLoadMoreInteractions
  /** Q-107: chế độ QA local vẫn là link tel: (số task is_test của batch marker) — chỉ thêm dòng nhận biết số giả. */
  qa?: boolean
  /** B8.1: 'panel' = drawer hẹp cạnh bảng /care/tasks — một cột, không chia đôi sản phẩm/lịch sử theo viewport. */
  layout?: 'page' | 'panel'
}) {
  const t = data.task
  const st = careTaskState(t, todayISO)
  const panel = layout === 'panel'
  return (
    <div className={panel ? 'space-y-5' : 'space-y-6'} data-testid="care-task-detail">
      <section className={panel ? 'space-y-3' : 'rounded-lg border bg-card p-4'}>
        <div className={panel ? 'flex flex-wrap items-center gap-2' : 'mb-3 flex flex-wrap items-center gap-2'}>
          {!panel && <User className="size-4 text-muted-foreground" />}
          <h2 className={panel ? 'text-lg font-semibold' : 'text-base font-semibold'}>{t.customer_name}</h2>
          <StatusBadge tone={STATE_TONE[st.key]}>{CARE_STATUS_LABELS[st.key]}</StatusBadge>
          {st.overdueOpen && <StatusBadge tone="danger">Quá hạn</StatusBadge>}
          {!st.overdueOpen && t.first_overdue_on && <StatusBadge tone="warning">Từng trễ hẹn ({dmy(t.first_overdue_on)})</StatusBadge>}
          {actions && <div className={panel ? 'flex w-full flex-wrap gap-2' : 'ml-auto'}>{actions}</div>}
        </div>
        <dl className={panel ? 'grid grid-cols-2 gap-3' : 'grid grid-cols-2 gap-3 md:grid-cols-4'}>
          <Field label="Số điện thoại">
            <a href={`tel:${t.phone_norm}`} className="inline-flex min-h-[44px] items-center text-primary hover:underline md:min-h-0">{t.phone_raw}</a>
            {qa && <span data-testid="care-contact-qa" className="block text-xs text-status-warning">Chế độ QA: số của khách QA giả</span>}
          </Field>
          <Field label="Kỳ / hạn">{dmy(t.period_month).slice(3)} · hạn {dmy(t.due_date)}</Field>
          <Field label="Cửa hàng">{t.store ? `${t.store.code} · ${t.store.name}` : '—'}</Field>
          <Field label="Dược sĩ phụ trách">{t.assignee?.full_name ?? '—'}</Field>
          <Field label="Hẹn chăm sóc lại">{t.next_action_date ? dmy(t.next_action_date) : '—'}</Field>
          <Field label="Lượt gần nhất">{t.last_interaction_at ? formatDateTime(t.last_interaction_at) : 'Chưa có'}</Field>
          {t.completed_at && <Field label="Hoàn thành lúc">{formatDateTime(t.completed_at)}</Field>}
          {t.closed_at && <Field label="Đóng kỳ lúc">{formatDateTime(t.closed_at)}</Field>}
        </dl>
      </section>

      {/* B7-ui: desktop rộng — sản phẩm và lịch sử đặt cạnh nhau (trước đây thẻ sản phẩm chiếm nửa hàng, nửa còn lại trống). */}
      <div className={panel ? 'space-y-5' : 'grid gap-6 lg:grid-cols-2 lg:items-start'}>
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-base font-semibold"><Package className="size-4" /> Sản phẩm cần chăm sóc ({data.products.length})</h2>
          {data.products.length ? <CareProductGallery products={data.products} columns={panel ? 'single' : 'auto'} /> : <EmptyState title="Không có sản phẩm" />}
        </section>

        <CareTimeline taskId={taskId} initial={data.interactions} events={data.events} loadMore={loadMore} />
      </div>
    </div>
  )
}
