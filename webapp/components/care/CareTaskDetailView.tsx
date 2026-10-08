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

export function CareTaskDetailView({ taskId, data, todayISO, actions, loadMore }: {
  taskId: string; data: CareDetailViewData; todayISO: string; actions?: React.ReactNode; loadMore?: CareLoadMoreInteractions
}) {
  const t = data.task
  const st = careTaskState(t, todayISO)
  return (
    <div className="space-y-6" data-testid="care-task-detail">
      <section className="rounded-lg border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <User className="size-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">{t.customer_name}</h2>
          <StatusBadge tone={STATE_TONE[st.key]}>{CARE_STATUS_LABELS[st.key]}</StatusBadge>
          {st.overdueOpen && <StatusBadge tone="danger">Quá hạn</StatusBadge>}
          {!st.overdueOpen && t.first_overdue_on && <StatusBadge tone="warning">Từng trễ hẹn ({dmy(t.first_overdue_on)})</StatusBadge>}
          {actions && <div className="ml-auto">{actions}</div>}
        </div>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Số điện thoại"><a href={`tel:${t.phone_norm}`} className="inline-flex min-h-[44px] items-center text-primary hover:underline md:min-h-0">{t.phone_raw}</a></Field>
          <Field label="Kỳ / hạn">{dmy(t.period_month).slice(3)} · hạn {dmy(t.due_date)}</Field>
          <Field label="Cửa hàng">{t.store ? `${t.store.code} · ${t.store.name}` : '—'}</Field>
          <Field label="Dược sĩ phụ trách">{t.assignee?.full_name ?? '—'}</Field>
          <Field label="Hẹn chăm sóc lại">{t.next_action_date ? dmy(t.next_action_date) : '—'}</Field>
          <Field label="Lượt gần nhất">{t.last_interaction_at ? formatDateTime(t.last_interaction_at) : 'Chưa có'}</Field>
          {t.completed_at && <Field label="Hoàn thành lúc">{formatDateTime(t.completed_at)}</Field>}
          {t.closed_at && <Field label="Đóng kỳ lúc">{formatDateTime(t.closed_at)}</Field>}
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-base font-semibold"><Package className="size-4" /> Sản phẩm cần chăm sóc ({data.products.length})</h2>
        {data.products.length ? <CareProductGallery products={data.products} /> : <EmptyState title="Không có sản phẩm" />}
      </section>

      <CareTimeline taskId={taskId} initial={data.interactions} events={data.events} loadMore={loadMore} />
    </div>
  )
}
