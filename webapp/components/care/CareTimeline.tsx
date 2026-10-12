'use client'

import { useRef, useState } from 'react'
import { History, ImageOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { EmptyState } from '@/components/ds/EmptyState'
import { CARE_OUTCOME_META, isCareOutcome } from '@/lib/care/outcome'
import type { CareInteractionPage, CareInteractionRow } from '@/lib/care/browse'
import { formatDateTime } from '@/lib/dateUtils'
import { isCareProofDisplayUrl } from '@/lib/care/my'

// Dòng thời gian lượt chăm sóc + chuyển giao (SPEC B3 §2, Q-78): lượt chăm sóc tải 10
// lượt mới nhất mỗi lần, "Xem thêm" gọi action (kiểm lại cờ/quyền/RLS mỗi lần). Event
// giao/chuyển giao của task ít ⇒ tải đủ; khi còn lượt cũ chưa nạp, chỉ hiện event KHÔNG
// cũ hơn lượt cũ nhất đã có để thứ tự thời gian không gây hiểu nhầm.

export interface CareTimelineEvent {
  id: number; kind: 'assigned' | 'transferred'; note: string | null; created_at: string
  from_user: { full_name: string } | null; to_user: { full_name: string } | null; actor: { full_name: string } | null
  from_store: { code: string } | null; to_store: { code: string } | null
}
export type CareLoadMoreInteractions = (input: { taskId: string; beforeId: number }) =>
  Promise<{ ok: true; page: CareInteractionPage } | { ok: false; message: string }>

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

function InteractionItem({ i }: { i: CareInteractionRow }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={isCareOutcome(i.outcome) && CARE_OUTCOME_META[i.outcome].terminal ? 'success' : 'info'}>
          {isCareOutcome(i.outcome) ? CARE_OUTCOME_META[i.outcome].label : i.outcome}
        </StatusBadge>
        {!i.isThisTask && <StatusBadge tone="neutral">Kỳ trước / dược sĩ trước</StatusBadge>}
        <span className="text-xs text-muted-foreground">{i.actor?.full_name ?? '—'} · {formatDateTime(i.created_at)}</span>
      </div>
      <p className="whitespace-pre-line break-words text-sm">{i.note}</p>
      {i.next_action_date && <p className="text-xs text-muted-foreground">Hẹn chăm sóc lại: {dmy(i.next_action_date)}</p>}
      <ProofThumbs proof={i.proof} expired={i.proofExpired} />
    </div>
  )
}

/**
 * Ảnh minh chứng (B4): chỉ URL đúng kho care-proof; lazy, mở tab mới để xem lớn, no-referrer.
 * Q-85: lượt có ảnh đã quá 90 ngày (server tính và đã bỏ URL) ⇒ chỉ báo hết thời hạn lưu.
 */
function ProofThumbs({ proof, expired }: { proof?: { url: string }[] | null; expired?: boolean }) {
  if (expired) {
    return (
      <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground" data-testid="care-proof-expired">
        <ImageOff className="size-3.5 shrink-0" aria-hidden /> Ảnh minh chứng đã hết thời hạn lưu
      </p>
    )
  }
  const urls = (proof ?? []).map((p) => p?.url).filter((u): u is string => isCareProofDisplayUrl(u))
  if (urls.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 pt-1" aria-label="Ảnh minh chứng">
      {urls.map((u, k) => <ProofThumb key={u} url={u} n={k + 1} />)}
    </div>
  )
}

/** Một ảnh: lỗi tải (object đã xoá/mạng) ⇒ ô chữ nhẹ thay icon ảnh vỡ, không còn link. */
function ProofThumb({ url, n }: { url: string; n: number }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span className="inline-flex h-14 min-h-[44px] items-center gap-1.5 rounded border bg-muted px-2 text-xs text-muted-foreground" data-testid="care-proof-failed">
        <ImageOff className="size-3.5 shrink-0" aria-hidden /> Không tải được ảnh
      </span>
    )
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
      className="block size-14 min-h-[44px] overflow-hidden rounded border bg-muted" aria-label={`Xem ảnh minh chứng ${n}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- ảnh GCS ngoài next/image */}
      <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover"
        onError={() => setFailed(true)}
        // Ảnh SSR có thể lỗi trước khi hydrate (onError không bắn lại) ⇒ kiểm trạng thái khi gắn.
        ref={(el) => { if (el && el.complete && el.naturalWidth === 0) setFailed(true) }} />
    </a>
  )
}

function EventItem({ e }: { e: CareTimelineEvent }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="neutral">{e.kind === 'assigned' ? 'Phân công từ file' : 'Chuyển giao'}</StatusBadge>
        <span className="text-xs text-muted-foreground">{e.actor?.full_name ?? '—'} · {formatDateTime(e.created_at)}</span>
      </div>
      <p className="text-sm">
        {e.kind === 'transferred'
          ? <>{e.from_user?.full_name ?? '—'} ({e.from_store?.code ?? '—'}) → {e.to_user?.full_name ?? '—'} ({e.to_store?.code ?? '—'})</>
          : <>Giao cho {e.to_user?.full_name ?? '—'} ({e.to_store?.code ?? '—'})</>}
      </p>
      {e.note && <p className="whitespace-pre-line break-words text-sm text-muted-foreground">Ghi chú: {e.note}</p>}
    </div>
  )
}

export function CareTimeline({ taskId, initial, events, loadMore, showHeading = true }: {
  taskId: string
  initial: CareInteractionPage
  events: CareTimelineEvent[]
  loadMore?: CareLoadMoreInteractions
  /** B7-ui r2: màn dược sĩ — tab "Lịch sử" đã là tiêu đề ⇒ ẩn tiêu đề khỏi mắt (giữ cho trình đọc màn hình). */
  showHeading?: boolean
}) {
  const [rows, setRows] = useState<CareInteractionRow[]>(initial.rows)
  const [next, setNext] = useState<number | null>(initial.hasMore ? initial.nextBefore : null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef(false)

  async function more() {
    if (!loadMore || next === null || inflight.current) return
    inflight.current = true
    setBusy(true); setError(null)
    try {
      const r = await loadMore({ taskId, beforeId: next })
      if (r.ok) {
        // Keyset theo id ⇒ không trùng; vẫn lọc phòng khi bấm lại sau lỗi mạng.
        setRows((cur) => { const seen = new Set(cur.map((x) => x.id)); return [...cur, ...r.page.rows.filter((x) => !seen.has(x.id))] })
        setNext(r.page.hasMore ? r.page.nextBefore : null)
      } else setError(r.message)
    } catch {
      setError('Không tải được lịch sử — thử lại.')
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  const oldestLoaded = next !== null && rows.length ? rows.reduce((m, r) => (r.created_at < m ? r.created_at : m), rows[0].created_at) : null
  const shownEvents = oldestLoaded ? events.filter((e) => e.created_at >= oldestLoaded) : events
  const items = [
    ...rows.map((i) => ({ at: i.created_at, key: `i${i.id}`, node: <InteractionItem i={i} /> })),
    ...shownEvents.map((e) => ({ at: e.created_at, key: `e${e.id}`, node: <EventItem e={e} /> })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

  return (
    <section className="space-y-3" data-testid="care-timeline">
      <h2 className={showHeading ? 'flex items-center gap-2 text-base font-semibold' : 'sr-only'}><History className="size-4" /> Lịch sử chăm sóc &amp; chuyển giao</h2>
      {items.length === 0 ? <EmptyState title="Chưa có lượt chăm sóc nào" /> : (
        <ol className="space-y-3 border-l pl-4">
          {items.map((it) => <li key={it.key} className="relative before:absolute before:-left-[21px] before:top-1.5 before:size-2.5 before:rounded-full before:bg-border">{it.node}</li>)}
        </ol>
      )}
      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
      {next !== null && loadMore && (
        <Button type="button" variant="outline" className="min-h-[44px] md:min-h-0" disabled={busy} onClick={more}>
          {busy && <Loader2 className="size-4 animate-spin" />} Xem thêm lượt cũ hơn
        </Button>
      )}
    </section>
  )
}
