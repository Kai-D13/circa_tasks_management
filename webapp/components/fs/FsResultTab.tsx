'use client'

import { Fragment, useState, useTransition } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { resubmitFsItems, resubmitFsBox, closeFsSession, removeFsItem, updateFsItem, getFsItemEvents } from '@/app/actions/fsSessions'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { FS_PHOTO_BOXES, FS_ITEM_STATUS } from '@/lib/fs/constants'
import { ChevronDown, Search, RotateCcw, CheckCircle2, XCircle, ImageOff, Trash2, Pencil, History, Loader2, X } from 'lucide-react'

const FS_EVENT_LABEL: Record<string, string> = {
  session_created: 'Tạo phiên', session_claimed: 'Nhận xử lý', session_released: 'Bàn giao/Gỡ',
  session_completed: 'Chốt phiên', session_cancelled: 'Huỷ phiên',
  item_submitted: 'Hoàn thành sản phẩm', item_resubmit_requested: 'Yêu cầu làm lại (cả SP)',
  box_resubmit_requested: 'Yêu cầu chụp lại box', box_reuploaded: 'Tải lại ảnh box',
  gcs_delete_failed: 'Lỗi xoá ảnh cũ', item_removed: 'Xoá khỏi phiên', item_edited: 'Chỉnh sửa',
}
const fmtDT = (iso: string) => { const d = new Date(Date.parse(iso) + 7 * 3600_000); const p = (n: number) => String(n).padStart(2, '0'); return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` }

interface Photo { box_key: number; storage_path: string; status: string; resubmit_note: string | null }
export interface FsReviewItem {
  id: string; product_id: string; product_name: string; status: string
  dim_length_mm: number | null; dim_width_mm: number | null; dim_height_mm: number | null
  resubmit_note: string | null; photos: Photo[]
}

const dims = (l: number | null, w: number | null, h: number | null) =>
  l || w || h ? `${l ?? '—'} × ${w ?? '—'} × ${h ?? '—'} mm` : '—'

// Note modal — a light controlled overlay (base-ui dialog avoided to keep this
// self-contained). onConfirm receives the trimmed note.
function NoteModal({ title, placeholder = 'Lý do yêu cầu làm lại (bắt buộc)', confirmLabel = 'Xác nhận', open, pending, onConfirm, onClose }: {
  title: string; placeholder?: string; confirmLabel?: string; open: boolean; pending: boolean
  onConfirm: (note: string) => void; onClose: () => void
}) {
  const [note, setNote] = useState('')
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg bg-background p-4 shadow-lg space-y-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold text-sm">{title}</h3>
        <textarea
          autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
          placeholder={placeholder}
          className="w-full h-24 rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose} disabled={pending}>Huỷ</Button>
          <Button size="sm" onClick={() => onConfirm(note.trim())} disabled={pending || !note.trim()}>
            {pending ? 'Đang gửi…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

// Edit item modal — product_name always; product_id only when the item is
// pending AND has no photos (mirrors the DB guard, so the input is disabled
// otherwise with a hint).
function EditItemModal({ item, pending, onSave, onClose }: {
  item: FsReviewItem; pending: boolean
  onSave: (productName: string, productId: string) => void; onClose: () => void
}) {
  const [name, setName] = useState(item.product_name)
  const [pid, setPid] = useState(item.product_id)
  const idEditable = item.status === 'pending' && item.photos.length === 0
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg bg-background p-4 shadow-lg space-y-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold text-sm">Chỉnh sửa sản phẩm</h3>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">product_id</label>
          <input value={pid} onChange={(e) => setPid(e.target.value)} disabled={!idEditable}
            className="w-full h-9 rounded-md border bg-background px-3 text-sm font-mono disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-primary/30" />
          {!idEditable && <p className="text-[11px] text-muted-foreground">Chỉ sửa mã khi chưa xử lý và chưa có ảnh.</p>}
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Tên sản phẩm</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={300}
            className="w-full h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose} disabled={pending}>Huỷ</Button>
          <Button size="sm" onClick={() => onSave(name.trim(), idEditable ? pid.trim() : item.product_id)} disabled={pending || !name.trim()}>
            {pending ? 'Đang lưu…' : 'Lưu'}
          </Button>
        </div>
      </div>
    </div>
  )
}

interface FsEvent { id: string; event_type: string; box_key: number | null; note: string | null; created_at: string; actor_name: string | null }

// History drawer — lazy-loads fs_item_events for one item.
function HistoryDrawer({ productId, events, loading, onClose }: {
  productId: string; events: FsEvent[] | null; loading: boolean; onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="w-full max-w-sm h-full bg-background shadow-lg p-4 space-y-3 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm">Lịch sử · <span className="font-mono">{productId}</span></h3>
          <button type="button" aria-label="Đóng" onClick={onClose} className="p-1 rounded hover:bg-muted"><X className="h-4 w-4" /></button>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center"><Loader2 className="h-4 w-4 animate-spin" /> Đang tải…</div>
        ) : !events || events.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Chưa có lịch sử.</p>
        ) : (
          <ul className="space-y-2">
            {events.map((e) => (
              <li key={e.id} className="border-l-2 border-primary/30 pl-3 py-0.5">
                <div className="text-sm font-medium">
                  {FS_EVENT_LABEL[e.event_type] ?? e.event_type}{e.box_key ? ` · box ${e.box_key}` : ''}
                </div>
                <div className="text-xs text-muted-foreground">{fmtDT(e.created_at)}{e.actor_name ? ` · ${e.actor_name}` : ''}</div>
                {e.note && <div className="text-xs text-amber-700 mt-0.5">{e.note}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export function FsResultTab({
  sessionId, isActive, canComplete, items, page, totalPages, filteredCount, q, status,
}: {
  sessionId: string
  isActive: boolean
  canComplete: boolean   // every item done (no pending/redo) → session can be finalised
  items: FsReviewItem[]
  page: number
  totalPages: number
  filteredCount: number
  q: string
  status: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  const [search, setSearch] = useState(q)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Active note modal: resubmit (bulk/item/box) or remove-item.
  const [modal, setModal] = useState<null | { kind: 'bulk' } | { kind: 'item'; id: string } | { kind: 'box'; id: string; box: number } | { kind: 'remove'; id: string }>(null)
  const [editing, setEditing] = useState<FsReviewItem | null>(null)
  const [history, setHistory] = useState<{ productId: string } | null>(null)
  const [historyEvents, setHistoryEvents] = useState<FsEvent[] | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)

  function setParam(overrides: Record<string, string | number | undefined>) {
    const sp = new URLSearchParams(searchParams.toString())
    sp.set('tab', 'result')
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined || v === '') sp.delete(k)
      else sp.set(k, String(v))
    }
    router.push(`${pathname}?${sp.toString()}`)
  }

  const doneItems = items.filter((i) => i.status === 'done')
  const allDoneSelected = doneItems.length > 0 && doneItems.every((i) => selected.has(i.id))
  function toggleSelectAll() {
    setSelected(allDoneSelected ? new Set() : new Set(doneItems.map((i) => i.id)))
  }
  function toggleOne(id: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function toggleExpand(id: string) {
    setExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  function confirmNote(note: string) {
    if (!modal) return
    startTransition(async () => {
      let r: { error?: string; success?: boolean; count?: number }
      if (modal.kind === 'bulk') r = await resubmitFsItems(sessionId, [...selected], note)
      else if (modal.kind === 'item') r = await resubmitFsItems(sessionId, [modal.id], note)
      else if (modal.kind === 'box') r = await resubmitFsBox(sessionId, modal.id, modal.box, note)
      else r = await removeFsItem(sessionId, modal.id, note)
      if (r.error) { toast.error(r.error); return }
      toast.success(modal.kind === 'remove' ? 'Đã xoá sản phẩm khỏi phiên' : 'Đã gửi yêu cầu làm lại')
      setModal(null); setSelected(new Set())
      router.refresh()
    })
  }

  function doEdit(productName: string, productId: string) {
    if (!editing) return
    startTransition(async () => {
      const r = await updateFsItem(sessionId, editing.id, { productName, productId })
      if (r.error) { toast.error(r.error); return }
      toast.success('Đã cập nhật sản phẩm')
      setEditing(null); router.refresh()
    })
  }

  function openHistory(it: FsReviewItem) {
    setHistory({ productId: it.product_id }); setHistoryEvents(null); setHistoryLoading(true)
    getFsItemEvents(it.id).then((r) => {
      setHistoryLoading(false)
      if ('error' in r && r.error) { toast.error(r.error); setHistory(null); return }
      setHistoryEvents((r as { events: FsEvent[] }).events)
    })
  }

  function doClose(next: 'completed' | 'cancelled') {
    const msg = next === 'completed' ? 'Chốt phiên (đánh dấu hoàn thành)?' : 'Huỷ phiên này?'
    if (!window.confirm(msg)) return
    startTransition(async () => {
      const r = await closeFsSession(sessionId, next)
      if (r.error) { toast.error(r.error); return }
      toast.success(next === 'completed' ? 'Đã chốt phiên' : 'Đã huỷ phiên')
      router.refresh()
    })
  }

  const STATUS_TABS = [
    { key: '', label: 'Tất cả' },
    { key: 'pending', label: 'Chưa xử lý' },
    { key: 'done', label: 'Hoàn thành' },
    { key: 'redo', label: 'Cần làm lại' },
  ]

  return (
    <div className="space-y-3">
      {/* Session actions */}
      {isActive && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => doClose('completed')} disabled={pending || !canComplete}>
            <CheckCircle2 className="h-4 w-4" /> Chốt phiên
          </Button>
          <Button size="sm" variant="ghost" className="gap-1.5 text-red-600 hover:text-red-700" onClick={() => doClose('cancelled')} disabled={pending}>
            <XCircle className="h-4 w-4" /> Huỷ phiên
          </Button>
          {!canComplete && <span className="text-xs text-muted-foreground">Chỉ chốt khi toàn bộ sản phẩm đã hoàn thành.</span>}
        </div>
      )}

      {/* Toolbar: search + status filter */}
      <div className="flex flex-wrap items-center gap-2">
        <form
          onSubmit={(e) => { e.preventDefault(); setParam({ q: search || undefined, page: undefined }) }}
          className="flex items-center gap-1"
        >
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm product_id / tên"
              aria-label="Tìm sản phẩm"
              className="h-9 w-56 rounded-md border bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <Button size="sm" variant="outline" type="submit">Tìm</Button>
        </form>
        <div className="flex flex-wrap gap-1">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setParam({ status: t.key || undefined, page: undefined })}
              className={cn('px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
                status === t.key ? 'border-primary bg-primary/10 text-primary' : 'border-transparent bg-muted text-muted-foreground hover:text-foreground')}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk bar */}
      {isActive && selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span>Đã chọn <b>{selected.size}</b> sản phẩm</span>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setModal({ kind: 'bulk' })} disabled={pending}>
            <RotateCcw className="h-3.5 w-3.5" /> Yêu cầu làm lại
          </Button>
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setSelected(new Set())}>Bỏ chọn</button>
        </div>
      )}

      {/* Table */}
      <div className="rounded border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr className="text-left text-muted-foreground">
              {isActive && (
                <th className="px-3 py-2.5 w-8">
                  <input type="checkbox" aria-label="Chọn tất cả sản phẩm hoàn thành" checked={allDoneSelected} onChange={toggleSelectAll} disabled={doneItems.length === 0} />
                </th>
              )}
              <th className="px-3 py-2.5 font-medium w-28">product_id</th>
              <th className="px-3 py-2.5 font-medium">Tên sản phẩm</th>
              <th className="px-3 py-2.5 font-medium">Kích thước</th>
              <th className="px-3 py-2.5 font-medium">Trạng thái</th>
              <th className="px-3 py-2.5 font-medium text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((it) => {
              const im = FS_ITEM_STATUS[it.status] ?? { label: it.status, cls: 'bg-muted text-muted-foreground' }
              const isOpen = expanded.has(it.id)
              const canResubmit = isActive && it.status === 'done'
              const photoByBox = new Map(it.photos.map((p) => [p.box_key, p]))
              return (
                <Fragment key={it.id}>
                  <tr className={cn(isOpen && 'bg-muted/20')}>
                    {isActive && (
                      <td className="px-3 py-2.5">
                        <input type="checkbox" aria-label={`Chọn ${it.product_id}`} checked={selected.has(it.id)} onChange={() => toggleOne(it.id)} disabled={it.status !== 'done'} />
                      </td>
                    )}
                    <td className="px-3 py-2.5 font-mono">{it.product_id}</td>
                    <td className="px-3 py-2.5">
                      {it.product_name}
                      {it.resubmit_note && <div className="text-xs text-amber-700 mt-0.5">Ghi chú làm lại: {it.resubmit_note}</div>}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{dims(it.dim_length_mm, it.dim_width_mm, it.dim_height_mm)}</td>
                    <td className="px-3 py-2.5"><Badge className={cn('text-[10px]', im.cls)}>{im.label}</Badge></td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-0.5 justify-end">
                        {isActive && (
                          <>
                            <button type="button" aria-label="Chỉnh sửa" onClick={() => setEditing(it)} className="p-1 rounded hover:bg-muted text-muted-foreground"><Pencil className="h-3.5 w-3.5" /></button>
                            <button type="button" aria-label="Xoá khỏi phiên" onClick={() => setModal({ kind: 'remove', id: it.id })} className="p-1 rounded hover:bg-red-50 text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                          </>
                        )}
                        <button type="button" aria-label="Lịch sử" onClick={() => openHistory(it)} className="p-1 rounded hover:bg-muted text-muted-foreground"><History className="h-3.5 w-3.5" /></button>
                        <button type="button" aria-label="Xem ảnh" onClick={() => toggleExpand(it.id)} className="p-1 rounded hover:bg-muted">
                          <ChevronDown className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-180')} />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={it.id + '-boxes'}>
                      <td colSpan={isActive ? 6 : 5} className="px-3 py-3 bg-muted/10">
                        <div className="flex flex-wrap gap-3">
                          {FS_PHOTO_BOXES.map((b) => {
                            const photo = photoByBox.get(b.key)
                            return (
                              <div key={b.key} className="w-32 space-y-1">
                                <div className="aspect-square rounded-md border bg-muted/40 flex items-center justify-center overflow-hidden">
                                  {photo?.storage_path ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={photo.storage_path} alt={b.label} loading="lazy" className="h-full w-full object-cover" />
                                  ) : (
                                    <ImageOff className="h-5 w-5 text-muted-foreground/50" />
                                  )}
                                </div>
                                <div className="flex items-center justify-between gap-1">
                                  <span className="text-[11px] text-muted-foreground truncate">{b.label}{b.required ? ' *' : ''}</span>
                                  {photo?.status === 'redo' && <Badge className="bg-amber-100 text-amber-700 text-[9px] shrink-0">làm lại</Badge>}
                                </div>
                                {/* Only offer per-box resubmit for a box that HAS a photo (option 1,
                                    reviewer) — an empty optional box has nothing to "chụp lại". */}
                                {canResubmit && photo && (
                                  <button
                                    type="button"
                                    onClick={() => setModal({ kind: 'box', id: it.id, box: b.key })}
                                    className="w-full text-[11px] text-primary hover:underline text-left"
                                  >
                                    Chụp lại box này
                                  </button>
                                )}
                              </div>
                            )
                          })}
                        </div>
                        {canResubmit && (
                          <div className="mt-3">
                            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setModal({ kind: 'item', id: it.id })} disabled={pending}>
                              <RotateCcw className="h-3.5 w-3.5" /> Làm lại cả sản phẩm
                            </Button>
                          </div>
                        )}
                        {!canResubmit && it.status === 'pending' && (
                          <p className="mt-2 text-xs text-muted-foreground">Sản phẩm chưa được xử lý — chưa có ảnh để yêu cầu làm lại.</p>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {items.length === 0 && (
              <tr><td colSpan={isActive ? 6 : 5} className="text-center text-muted-foreground py-8">Không có sản phẩm khớp bộ lọc.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Trang {page}/{totalPages} · {filteredCount} sản phẩm</span>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={page <= 1 || pending} onClick={() => setParam({ page: page - 1 })}>Trước</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages || pending} onClick={() => setParam({ page: page + 1 })}>Sau</Button>
          </div>
        </div>
      )}

      <NoteModal
        key={modal ? `${modal.kind}:${'id' in modal ? modal.id : ''}` : 'closed'}
        open={modal !== null}
        pending={pending}
        title={modal?.kind === 'remove' ? 'Xoá sản phẩm khỏi phiên' : modal?.kind === 'box' ? 'Yêu cầu chụp lại box ảnh' : 'Yêu cầu làm lại sản phẩm'}
        placeholder={modal?.kind === 'remove' ? 'Lý do xoá (bắt buộc) — ví dụ: sản phẩm đã bán hết, không còn tồn' : 'Lý do yêu cầu làm lại (bắt buộc)'}
        confirmLabel={modal?.kind === 'remove' ? 'Xoá' : 'Xác nhận'}
        onConfirm={confirmNote}
        onClose={() => setModal(null)}
      />
      {editing && (
        <EditItemModal item={editing} pending={pending} onSave={doEdit} onClose={() => setEditing(null)} />
      )}
      {history && (
        <HistoryDrawer productId={history.productId} events={historyEvents} loading={historyLoading} onClose={() => setHistory(null)} />
      )}
    </div>
  )
}
