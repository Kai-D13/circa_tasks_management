'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { ExternalLink, Loader2, X } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ErrorState } from '@/components/ds/ErrorState'
import { cn } from '@/lib/utils'
import { CareTaskDetailView, type CareDetailViewData } from './CareTaskDetailView'
import { CareTaskTransferButton } from './CareTaskTransferButton'
import type { CareLoadMoreInteractions } from './CareTimeline'
import type { CareTransferActionResult, CareTransferTarget, CareTransferTaskRef } from './CareTransferDialog'
import { CareTaskOrdersSection } from './CareTaskOrdersSection'
import { loadMoreTaskOrders } from '@/app/actions/careOrders'
import type { CareTaskOrdersView } from '@/lib/care/orderLinks/view'

// B8.1 — khung chi tiết khách bên phải /care/tasks (`?open=<uuid>`, artboard 12). Dữ liệu đọc
// qua action (trang thật: session/RLS như trang chi tiết; catalog: action giả) MỖI lần mở — không
// prefetch, danh sách không mang số đầy đủ. ≥1280px nằm cạnh bảng; hẹp hơn là hộp thoại phủ phải
// (bẫy focus, Esc/X đóng, focus trả về tên khách). "Mở trang đầy đủ" giữ route /care/tasks/[id].

export type CareTaskPanelResult =
  | { ok: true; taskId: string; data: CareDetailViewData; transfer: CareTransferTaskRef | null; qa: boolean
      /** E3: chỉ khi CARE_ORDER_LINKS_UI_ENABLED; lỗi đọc đơn ⇒ null (không chặn chi tiết). */
      orders?: { view: CareTaskOrdersView; next: string | null } | null }
  | { ok: false; code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID' | 'FAILED'; message: string }
export type CareTaskPanelLoader = (input: { taskId: string }) => Promise<CareTaskPanelResult>

const WIDE = '(min-width: 1280px)'
function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(WIDE); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb) },
    () => window.matchMedia(WIDE).matches,
    () => false,
  )
}

export function CareTaskDrawer({
  taskId, onClose, load, loadMore, loadTargets, transfer, todayISO,
}: {
  taskId: string
  onClose: () => void
  load: CareTaskPanelLoader
  loadMore?: CareLoadMoreInteractions
  loadTargets: () => Promise<{ ok: true; staff: CareTransferTarget[] } | { ok: false; message: string }>
  transfer: (input: { taskIds: string[]; toUserId: string; note: string }) => Promise<CareTransferActionResult>
  todayISO: string
}) {
  const wide = useWide()
  const [state, setState] = useState<{ id: string; result: CareTaskPanelResult | null }>({ id: taskId, result: null })
  const [reload, setReload] = useState(0)
  const seq = useRef(0)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    // Phản hồi cũ (đổi khách nhanh) không ghi đè khách đang mở.
    const my = ++seq.current
    setState({ id: taskId, result: null })
    load({ taskId })
      .then((r) => { if (my === seq.current) setState({ id: taskId, result: r }) })
      .catch(() => { if (my === seq.current) setState({ id: taskId, result: { ok: false, code: 'FAILED', message: 'Không tải được chi tiết — thử lại.' } }) })
  }, [taskId, load, reload])

  // Màn rộng: đưa focus vào khung khi mở/đổi khách (hộp thoại tự quản focus).
  useEffect(() => { if (wide) headingRef.current?.focus() }, [wide, taskId])

  const r = state.id === taskId ? state.result : null
  const titleCls = 'text-sm font-semibold text-muted-foreground outline-none'
  const body = (
    <div className="flex h-full min-h-0 flex-col" data-testid="care-task-drawer">
      <div className="flex items-center gap-1 border-b border-care-line px-4 py-2">
        {wide
          ? <h2 ref={headingRef} tabIndex={-1} className={titleCls}>Chi tiết khách</h2>
          : <DialogTitle className={titleCls}>Chi tiết khách</DialogTitle>}
        <Link href={`/care/tasks/${taskId}`} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'ml-auto min-h-[44px] md:min-h-0')}>
          Mở trang đầy đủ <ExternalLink className="size-3.5" />
        </Link>
        <Button variant="ghost" size="icon-sm" className="size-[44px] md:size-8" aria-label="Đóng chi tiết" onClick={onClose}><X className="size-4" /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4" aria-busy={!r}>
        {!r ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải chi tiết…</p>
        ) : !r.ok ? (
          <ErrorState message={r.message} />
        ) : (
          <CareTaskDetailView taskId={r.taskId} todayISO={todayISO} data={r.data} loadMore={loadMore} qa={r.qa} layout="panel"
            orders={r.orders ? <CareTaskOrdersSection taskId={r.taskId} initial={r.orders.view} next={r.orders.next} loadMore={loadMoreTaskOrders} compact /> : undefined}
            actions={r.transfer ? <CareTaskTransferButton task={r.transfer} loadTargets={loadTargets} transfer={transfer} onDone={() => setReload((n) => n + 1)} /> : undefined} />
        )}
      </div>
    </div>
  )

  if (wide) {
    return (
      <aside aria-label="Chi tiết khách"
        className="sticky top-4 flex max-h-[calc(100dvh-2rem)] w-[400px] shrink-0 flex-col overflow-hidden rounded-care-panel border border-care-line bg-card"
        onKeyDown={(e) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('[role="dialog"]')) { e.stopPropagation(); onClose() } }}>
        {body}
      </aside>
    )
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent showCloseButton={false}
        className="top-0 right-0 left-auto h-dvh max-h-dvh w-full max-w-[420px] translate-x-0 translate-y-0 gap-0 rounded-none p-0 sm:max-w-[420px] data-open:zoom-in-100 data-closed:zoom-out-100">
        {body}
      </DialogContent>
    </Dialog>
  )
}
