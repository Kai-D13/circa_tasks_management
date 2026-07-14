'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { claimFsSession, submitFsItem, deleteFsStagedPhoto, deleteFsStagedPhotos, releaseFsClaimSelf } from '@/app/actions/fsSessions'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { FS_PHOTO_BOXES, FS_ITEM_STATUS, FS_DIM_MAX_MM, FS_DIM_HINT } from '@/lib/fs/constants'
import { FsBoxUpload } from '@/components/fs/FsBoxUpload'
import { Lock, HandMetal, PackageCheck, Search, LogOut, UserCheck } from 'lucide-react'

interface Photo { box_key: number; storage_path: string; status: string; resubmit_note: string | null }
export interface FsProcessItem {
  id: string; product_id: string; product_name: string; status: string
  dim_length_mm: number | null; dim_width_mm: number | null; dim_height_mm: number | null
  resubmit_note: string | null; approved_at: string | null; photos: Photo[]
}

// redo first (needs rework), then pending, then done (reference).
const ORDER: Record<string, number> = { redo: 0, pending: 1, done: 2 }

export function FsProcessWizard({
  sessionId, claimedByMe, claimedByOther, claimerLabel, items,
}: {
  sessionId: string
  claimedByMe: boolean
  claimedByOther: boolean
  claimerLabel: string | null
  items: FsProcessItem[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Boxes (re)uploaded in THIS editing session: box_key → {url, ct, size}.
  const [uploaded, setUploaded] = useState<Record<number, { url: string; ct: string; size: number }>>({})
  const [dimL, setDimL] = useState(''); const [dimW, setDimW] = useState(''); const [dimH, setDimH] = useState('')
  const [search, setSearch] = useState('')

  const sorted = [...items].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9))
  // Client-side search (product_id / name) so staff jump to a code without scrolling.
  const q = search.trim().toLowerCase()
  const filtered = q
    ? sorted.filter((i) => i.product_id.toLowerCase().includes(q) || i.product_name.toLowerCase().includes(q))
    : sorted
  const selected = items.find((i) => i.id === selectedId) ?? null

  function openItem(it: FsProcessItem) {
    setSelectedId(it.id)
    setUploaded({})
    setDimL(it.dim_length_mm != null ? String(it.dim_length_mm) : '')
    setDimW(it.dim_width_mm != null ? String(it.dim_width_mm) : '')
    setDimH(it.dim_height_mm != null ? String(it.dim_height_mm) : '')
  }

  function doClaim() {
    startTransition(async () => {
      const r = await claimFsSession(sessionId)
      if (r.error) { toast.error(r.error); return }
      toast.success('Đã bắt đầu xử lý')
      router.refresh()
    })
  }

  // Hand the list back so it isn't stuck if the staff steps away. Discards any
  // staged (unsaved) photos first; done items stay done.
  function doRelease() {
    if (!window.confirm('Bàn giao danh sách này để người khác xử lý tiếp? Ảnh chưa lưu sẽ bị huỷ.')) return
    const urls = Object.values(uploaded).map((u) => u.url)
    startTransition(async () => {
      if (urls.length > 0) await deleteFsStagedPhotos(urls)
      const r = await releaseFsClaimSelf(sessionId)
      if (r.error) { toast.error(r.error); return }
      toast.success('Đã bàn giao danh sách')
      router.push('/fs/products')
    })
  }

  function savedPhoto(it: FsProcessItem, boxKey: number): Photo | null {
    return it.photos.find((p) => p.box_key === boxKey) ?? null
  }
  function currentUrl(it: FsProcessItem, boxKey: number): string | null {
    return uploaded[boxKey]?.url ?? savedPhoto(it, boxKey)?.storage_path ?? null
  }
  // A box the admin flagged 'redo' that hasn't been re-shot this session.
  function isRedoBox(it: FsProcessItem, boxKey: number): boolean {
    return !uploaded[boxKey] && savedPhoto(it, boxKey)?.status === 'redo'
  }
  function parseDim(s: string): number | null {
    const t = s.trim()
    // Integer millimetres only — reject decimals / non-numeric (no silent 12.5→12).
    return /^\d+$/.test(t) ? Number(t) : null
  }

  // Replacing a staged box supersedes its GCS object → delete the old one.
  function handleUploaded(bk: number, url: string, ct: string, size: number) {
    const prev = uploaded[bk]
    if (prev && prev.url !== url) deleteFsStagedPhoto(prev.url).catch(() => {})
    setUploaded((p) => ({ ...p, [bk]: { url, ct, size } }))
  }
  function removeStaged(bk: number) {
    const u = uploaded[bk]
    if (!u) return
    startTransition(async () => {
      const r = await deleteFsStagedPhoto(u.url)
      if (r.error) { toast.error(r.error); return }
      setUploaded((p) => { const n = { ...p }; delete n[bk]; return n })
    })
  }
  // Closing with staged (unsaved) photos → confirm + discard the GCS objects in
  // ONE batch call (fewer requests); surface any that failed to delete.
  function closeEditor() {
    const urls = Object.values(uploaded).map((u) => u.url)
    if (urls.length === 0) { setSelectedId(null); return }
    if (!window.confirm('Ảnh vừa chụp chưa được lưu. Huỷ các ảnh tạm này?')) return
    startTransition(async () => {
      const r = await deleteFsStagedPhotos(urls)
      const failedCount = ('failed' in r ? r.failed?.length : 0) ?? 0
      if (failedCount > 0) toast.error(`Không xoá được ${failedCount} ảnh tạm`)
      setSelectedId(null); setUploaded({})
    })
  }

  const dimsValid = [dimL, dimW, dimH].every((s) => {
    const n = parseDim(s); return n != null && n > 0 && n <= FS_DIM_MAX_MM
  })
  const box12Ready = selected ? !!currentUrl(selected, 1) && !!currentUrl(selected, 2) : false
  const redoLeft = selected ? selected.photos.some((p) => p.status === 'redo' && !uploaded[p.box_key]) : false
  const canSubmit = !!selected && dimsValid && box12Ready && !redoLeft && !pending

  // The single most relevant blocker, in priority order (photos → redo → dims).
  function submitHint(it: FsProcessItem): string | null {
    if (!currentUrl(it, 1) && !currentUrl(it, 2)) return 'Cần ảnh Mặt trước & Mặt sau'
    if (!currentUrl(it, 1)) return 'Cần ảnh Mặt trước'
    if (!currentUrl(it, 2)) return 'Cần ảnh Mặt sau'
    if (it.photos.some((p) => p.status === 'redo' && !uploaded[p.box_key])) return 'Còn box cần chụp lại'
    const missDims = ([['Dài', dimL], ['Rộng', dimW], ['Cao', dimH]] as [string, string][])
      .filter(([, s]) => { const n = parseDim(s); return !(n != null && n > 0 && n <= FS_DIM_MAX_MM) })
      .map(([l]) => l)
    if (missDims.length) return `Nhập đủ: ${missDims.join(' / ')}`
    return null
  }

  function doSubmit() {
    if (!selected) return
    const photos = Object.entries(uploaded).map(([box_key, v]) => ({
      box_key: Number(box_key), storage_path: v.url, content_type: v.ct, size_bytes: v.size,
    }))
    startTransition(async () => {
      const r = await submitFsItem({
        sessionId, itemId: selected.id,
        length: parseDim(dimL)!, width: parseDim(dimW)!, height: parseDim(dimH)!,
        photos,
      })
      if (r.error) { toast.error(r.error); return }
      toast.success('Đã hoàn thành sản phẩm')
      setSelectedId(null); setUploaded({})
      router.refresh()
    })
  }

  // ── Claim states ──────────────────────────────────────────────────────────
  if (claimedByOther) {
    return (
      <div className="rounded-md border bg-muted/30 px-4 py-6 text-center space-y-1">
        <Lock className="h-5 w-5 mx-auto text-muted-foreground" />
        <p className="text-sm font-medium">Danh sách đang được xử lý bởi {claimerLabel ?? 'người khác'}</p>
        <p className="text-xs text-muted-foreground">Chỉ một người xử lý một danh sách tại một thời điểm. Vui lòng chờ hoặc liên hệ quản lý để được gỡ.</p>
      </div>
    )
  }

  if (!claimedByMe) {
    return (
      <div className="rounded-md border bg-muted/30 px-4 py-6 text-center space-y-3">
        <p className="text-sm text-muted-foreground">Bắt đầu để bổ sung ảnh & kích thước sản phẩm.</p>
        <Button size="sm" className="gap-1.5" onClick={doClaim} disabled={pending}>
          <HandMetal className="h-4 w-4" /> Bắt đầu xử lý
        </Button>
      </div>
    )
  }

  // ── Owner mode: item queue + inline editor ────────────────────────────────
  return (
    <div className="space-y-2">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          <UserCheck className="h-4 w-4 text-primary shrink-0" /> Bạn đang xử lý danh sách này
        </span>
        <Button size="sm" variant="outline" className="gap-1.5 w-full sm:w-auto border-primary/40 text-primary hover:bg-primary/10 hover:text-primary" onClick={doRelease} disabled={pending}>
          <LogOut className="h-3.5 w-3.5" /> Bàn giao phiên
        </Button>
      </div>
      {sorted.length > 0 && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="search"
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm product_id hoặc tên sản phẩm"
            aria-label="Tìm sản phẩm"
            className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      )}
      {filtered.map((it) => {
        const im = FS_ITEM_STATUS[it.status] ?? { label: it.status, cls: 'bg-muted text-muted-foreground' }
        const isOpen = selectedId === it.id
        return (
          <div key={it.id} className={cn('rounded-md border', isOpen && 'ring-1 ring-primary/40')}>
            {/* Two stable columns (review r2): identity left (id on its own line,
                name up to 2 lines — no more one-line truncate hiding long names),
                fixed action column right so the button never gets pushed around.
                No tooltip/popup — this is a mobile flow. */}
            <div className="flex items-start gap-3 px-3 py-2.5">
              <div className="flex-1 min-w-0">
                <div className="font-mono text-xs text-muted-foreground">{it.product_id}</div>
                <div className="font-medium text-sm line-clamp-2 break-words">{it.product_name}</div>
                {it.resubmit_note && it.status === 'redo' && (
                  <div className="text-xs text-amber-700 mt-0.5">Yêu cầu làm lại: {it.resubmit_note}</div>
                )}
              </div>
              <div className="flex flex-col items-end gap-1.5 shrink-0">
                <Badge className={cn('text-[10px]', im.cls)}>{im.label}</Badge>
                {/* An APPROVED item is locked (Batch E) — staff can't edit; only an
                    admin resubmit re-opens it. Otherwise editable by the claimer
                    while active (incl. a 'done' item self-correction, r4). */}
                {it.approved_at ? (
                  <Badge className="bg-green-100 text-green-700 text-[10px]">Đã duyệt</Badge>
                ) : (
                  <Button size="sm" variant={isOpen || it.status === 'done' ? 'outline' : 'default'} onClick={() => (isOpen ? closeEditor() : openItem(it))} disabled={pending}>
                    {isOpen ? 'Đóng' : it.status === 'done' ? 'Sửa thông tin' : 'Xử lý'}
                  </Button>
                )}
              </div>
            </div>

            {isOpen && selected && selected.id === it.id && (
              <div className="border-t px-3 py-3 space-y-3 bg-muted/10">
                {/* Full identity while editing — the closed row clamps the name
                    to 2 lines; here it wraps completely (review r2). */}
                <div>
                  <p className="font-mono text-xs text-muted-foreground">{it.product_id}</p>
                  <p className="text-sm font-medium break-words">{it.product_name}</p>
                </div>

                <div>
                  <p className="text-xs font-medium mb-1.5">Ảnh sản phẩm — nền trắng (Mặt trước & Mặt sau bắt buộc)</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                    {FS_PHOTO_BOXES.map((b) => (
                      <FsBoxUpload
                        key={b.key}
                        itemId={it.id}
                        box={b}
                        currentUrl={currentUrl(it, b.key)}
                        isStaged={!!uploaded[b.key]}
                        isRedo={isRedoBox(it, b.key)}
                        note={savedPhoto(it, b.key)?.resubmit_note ?? null}
                        disabled={pending}
                        onUploaded={handleUploaded}
                        onRemoveStaged={removeStaged}
                      />
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-xs font-medium mb-1">Kích thước (mm) — bắt buộc</p>
                  <div className="grid grid-cols-3 gap-2">
                    <DimInput label="Dài" value={dimL} onChange={setDimL} />
                    <DimInput label="Rộng" value={dimW} onChange={setDimW} />
                    <DimInput label="Cao" value={dimH} onChange={setDimH} />
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">{FS_DIM_HINT}</p>
                </div>

                {/* Static footer at the end of the editor (after all 5 boxes + dims).
                    NOT sticky — a nested sticky panel overlapped the boxes on scroll
                    (r5). Vertical so the primary CTA gets its own full-width row. */}
                <div className="border-t pt-3 space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    Đã có {FS_PHOTO_BOXES.filter((b) => currentUrl(it, b.key)).length}/5 ảnh
                  </p>
                  <div className="flex flex-col md:flex-row md:items-center gap-2">
                    <Button className="gap-1.5 w-full md:w-auto h-11 md:h-9" onClick={doSubmit} disabled={!canSubmit}>
                      <PackageCheck className="h-4 w-4" /> Hoàn thành sản phẩm
                    </Button>
                    {submitHint(it) && <span className="text-xs text-amber-600">{submitHint(it)}</span>}
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}
      {filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          {sorted.length === 0 ? 'Chưa có sản phẩm.' : 'Không tìm thấy sản phẩm khớp.'}
        </p>
      )}
    </div>
  )
}

function DimInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    // Label on top + full-width input; text-base = 16px so iOS Safari does NOT
    // auto-zoom on focus (the zoom bug happened with <16px inputs).
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label} (mm)</span>
      <input
        type="number" inputMode="numeric" min={1} max={FS_DIM_MAX_MM} value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`Kích thước ${label} (mm)`}
        className="h-10 w-full rounded-md border bg-background px-2 text-base focus:outline-none focus:ring-2 focus:ring-primary/30"
      />
    </label>
  )
}
