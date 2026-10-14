import { ArrowRightLeft } from 'lucide-react'
import { careTransferEvents } from '@/lib/care/browse'
import { formatDateTime } from '@/lib/dateUtils'
import type { CareTimelineEvent } from './CareTimeline'

// B8.5 — "Lịch sử chuyển giao" trên chi tiết khách browser (trang đầy đủ + drawer /care/tasks): mỗi lần SM/super
// chuyển task từ dược sĩ/cửa hàng A sang B, mới nhất trước — thời gian VN, người chuyển, ghi chú. Dữ liệu là
// `care_assignment_events` loại `transferred` mà loader chi tiết đã đọc qua session/RLS (114) — không query mới.

const who = (u: { full_name: string } | null, s: { code: string } | null) => `${u?.full_name ?? '—'} (${s?.code ?? '—'})`

export function CareTransferHistory({ events }: { events: CareTimelineEvent[] }) {
  const list = careTransferEvents(events)
  return (
    <section className="space-y-2" aria-label="Lịch sử chuyển giao" data-testid="care-transfer-history">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <ArrowRightLeft className="size-4 text-muted-foreground" aria-hidden /> Lịch sử chuyển giao
        {list.length > 0 && <span className="font-normal text-muted-foreground">({list.length})</span>}
      </h3>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">Chưa có lần chuyển giao</p>
      ) : (
        <ol className="space-y-2">
          {list.map((e) => (
            <li key={e.id} className="rounded-md border bg-muted/30 px-3 py-2" data-testid="care-transfer-item">
              <p className="text-sm font-medium break-words">
                {who(e.from_user, e.from_store)} <span aria-hidden>→</span><span className="sr-only">sang</span> {who(e.to_user, e.to_store)}
              </p>
              <p className="text-xs text-muted-foreground">{formatDateTime(e.created_at)} · Người chuyển: {e.actor?.full_name ?? '—'}</p>
              {e.note && <p className="text-xs whitespace-pre-line break-words text-muted-foreground">Ghi chú: {e.note}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
