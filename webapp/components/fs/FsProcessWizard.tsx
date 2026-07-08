'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { claimFsSession, submitFsItem, deleteFsStagedPhoto, deleteFsStagedPhotos } from '@/app/actions/fsSessions'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { FS_PHOTO_BOXES, FS_ITEM_STATUS, FS_DIM_MAX_MM, FS_DIM_HINT } from '@/lib/fs/constants'
import { FsBoxUpload } from '@/components/fs/FsBoxUpload'
import { Lock, HandMetal, PackageCheck, Search } from 'lucide-react'

interface Photo { box_key: number; storage_path: string; status: string; resubmit_note: string | null }
export interface FsProcessItem {
  id: string; product_id: string; product_name: string; status: string
  dim_length_mm: number | null; dim_width_mm: number | null; dim_height_mm: number | null
  resubmit_note: string | null; photos: Photo[]
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
      {sorted.length > 5 && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm mã hoặc tên sản phẩm"
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
            <div className="flex items-center gap-3 px-3 py-2.5">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate">
                  <span className="font-mono text-xs text-muted-foreground mr-1.5">{it.product_id}</span>
                  {it.product_name}
                </div>
                {it.resubmit_note && it.status === 'redo' && (
                  <div className="text-xs text-amber-700 mt-0.5">Yêu cầu làm lại: {it.resubmit_note}</div>
                )}
              </div>
              <Badge className={cn('text-[10px] shrink-0', im.cls)}>{im.label}</Badge>
              {/* Any item is editable by the claimer while the session is active —
                  incl. a 'done' item the staff wants to self-correct (r4). */}
              <Button size="sm" variant={isOpen || it.status === 'done' ? 'outline' : 'default'} onClick={() => (isOpen ? closeEditor() : openItem(it))} disabled={pending}>
                {isOpen ? 'Đóng' : it.status === 'done' ? 'Sửa thông tin' : 'Xử lý'}
              </Button>
            </div>

            {isOpen && selected && selected.id === it.id && (
              <div className="border-t px-3 py-3 space-y-3 bg-muted/10">
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
                  <div className="flex flex-wrap gap-2">
                    <DimInput label="Dài" value={dimL} onChange={setDimL} />
                    <DimInput label="Rộng" value={dimW} onChange={setDimW} />
                    <DimInput label="Cao" value={dimH} onChange={setDimH} />
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">{FS_DIM_HINT}</p>
                </div>

                {/* Sticky above the floating BottomNav on mobile; vertical layout so
                    the primary CTA gets its own full-width row (no cramped wrap). */}
                <div className="sticky bottom-[calc(4.5rem_+_env(safe-area-inset-bottom))] md:static -mx-3 px-3 py-2 border-t bg-background/95 backdrop-blur md:mx-0 md:px-0 md:py-0 md:border-t-0 md:bg-transparent z-10 space-y-1.5">
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
    <label className="flex items-center gap-1.5 text-sm">
      <span className="text-muted-foreground w-10">{label}</span>
      <input
        type="number" inputMode="numeric" min={1} max={FS_DIM_MAX_MM} value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`Kích thước ${label} (mm)`}
        className="h-9 w-24 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
      />
      <span className="text-muted-foreground text-xs">mm</span>
    </label>
  )
}
