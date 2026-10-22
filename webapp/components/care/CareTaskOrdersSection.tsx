'use client'

import { useRef, useState } from 'react'
import { Check, Copy, Loader2, Receipt } from 'lucide-react'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { Button } from '@/components/ui/button'
import { careOrderStateNote, careVnTime, type CareTaskOrder, type CareTaskOrdersView } from '@/lib/care/orderLinks/view'
import { cn } from '@/lib/utils'

// E3 (thiết kế E0 r3.4 §9) — "Đơn xác thực sau import" trong tab Tổng quan (/care/my/[id]) và chi tiết browser
// (/care/tasks/[id], drawer). Mỗi đơn: mã DHC + giờ hoàn tất VN + "Sao chép mã đơn" (≥ 44 px, thông báo aria-live, không
// sao chép được ⇒ chọn sẵn mã để người dùng tự sao chép). "Xem thêm" qua server action (cursor ký HMAC, không URL).
// Bảo mật: mã đơn chỉ là nội dung chữ — KHÔNG vào URL / title / data-* / aria-label / log.

export type CareLoadMoreTaskOrders = (input: { taskId: string; cursor: string }) =>
  Promise<{ ok: true; orders: CareTaskOrder[]; next: string | null } | { ok: false; message: string }>

export function CareTaskOrdersSection({ taskId, initial, next, loadMore, compact = false }: {
  taskId: string
  initial: CareTaskOrdersView
  next: string | null
  loadMore: CareLoadMoreTaskOrders
  /** Drawer / panel hẹp: không viền thẻ. */
  compact?: boolean
}) {
  const [orders, setOrders] = useState<CareTaskOrder[]>(initial.found ? initial.orders : [])
  const [cursor, setCursor] = useState<string | null>(next)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState('')
  const [copied, setCopied] = useState<number | null>(null)
  const codeRefs = useRef(new Map<number, HTMLSpanElement>())
  if (!initial.found) return null
  const note = careOrderStateNote(initial)

  const more = async () => {
    if (!cursor || busy) return
    setBusy(true); setError(null)
    const r = await loadMore({ taskId, cursor })
    setBusy(false)
    if (!r.ok) { setError(r.message); return }
    setOrders((cur) => [...cur, ...r.orders])
    setCursor(r.next)
  }
  const copy = async (o: CareTaskOrder) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no_clipboard')
      await navigator.clipboard.writeText(o.orderCode)
      setCopied(o.linkId)
      setLive('Đã sao chép mã đơn.')
    } catch {
      // Dự phòng: chọn sẵn mã để người dùng tự sao chép (nhấn giữ / Ctrl+C).
      const el = codeRefs.current.get(o.linkId)
      const sel = typeof window !== 'undefined' ? window.getSelection() : null
      if (el && sel) { const range = document.createRange(); range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range) }
      setCopied(null)
      setLive('Không sao chép tự động được — mã đơn đã được chọn, hãy sao chép thủ công.')
    }
  }

  return (
    <section aria-label="Đơn xác thực sau import" data-testid="care-task-orders"
      className={cn('space-y-3', !compact && 'rounded-lg border bg-card p-4')}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Receipt className="size-4 text-muted-foreground" aria-hidden /> Đơn xác thực sau import</h3>
        <StatusBadge tone={note.tone}>{note.label}</StatusBadge>
        {note.lagging && <StatusBadge tone="warning">Chưa cập nhật</StatusBadge>}
      </div>
      {orders.length > 0 && (
        <ul className="divide-y rounded-md border" data-testid="care-task-order-list">
          {orders.map((o) => (
            <li key={o.linkId} className="flex items-center gap-3 px-3 py-1">
              <div className="min-w-0 flex-1 py-2">
                <span ref={(el) => { if (el) codeRefs.current.set(o.linkId, el); else codeRefs.current.delete(o.linkId) }}
                  className="block font-mono text-sm font-semibold break-all select-all">{o.orderCode}</span>
                <span className="text-xs text-muted-foreground tabular-nums">Hoàn tất {careVnTime(o.completedAt)}</span>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => copy(o)}
                className="min-h-[44px] shrink-0 gap-1.5 md:h-[36px] md:min-h-[36px]">
                {copied === o.linkId ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                {copied === o.linkId ? 'Đã sao chép' : 'Sao chép mã đơn'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs break-words text-muted-foreground">{note.text}</p>
      {cursor && (
        <Button type="button" variant="ghost" size="sm" onClick={more} disabled={busy} className="min-h-[44px] w-full md:w-auto">
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden />} Xem thêm đơn
        </Button>
      )}
      {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
      <p aria-live="polite" className="sr-only">{live}</p>
    </section>
  )
}
