'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { claimFsSession, submitFsItem } from '@/app/actions/fsSessions'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { FS_PHOTO_BOXES, FS_ITEM_STATUS, FS_DIM_MAX_MM, FS_DIM_HINT } from '@/lib/fs/constants'
import { FsBoxUpload } from '@/components/fs/FsBoxUpload'
import { Lock, HandMetal, PackageCheck } from 'lucide-react'

interface Photo { box_key: number; storage_path: string }
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

  const sorted = [...items].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9))
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
      toast.success('Đã nhận phiên')
      router.refresh()
    })
  }

  function currentUrl(it: FsProcessItem, boxKey: number): string | null {
    return uploaded[boxKey]?.url ?? it.photos.find((p) => p.box_key === boxKey)?.storage_path ?? null
  }
  function parseDim(s: string): number | null {
    const t = s.trim()
    // Integer millimetres only — reject decimals / non-numeric (no silent 12.5→12).
    return /^\d+$/.test(t) ? Number(t) : null
  }
  const dimsValid = [dimL, dimW, dimH].every((s) => {
    const n = parseDim(s); return n != null && n > 0 && n <= FS_DIM_MAX_MM
  })
  const box12Ready = selected ? !!currentUrl(selected, 1) && !!currentUrl(selected, 2) : false
  const canSubmit = !!selected && dimsValid && box12Ready && !pending

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
        <p className="text-sm font-medium">Phiên đang được xử lý bởi {claimerLabel ?? 'người khác'}</p>
        <p className="text-xs text-muted-foreground">Chỉ một người xử lý một phiên tại một thời điểm. Vui lòng chờ hoặc liên hệ quản lý để được gỡ.</p>
      </div>
    )
  }

  if (!claimedByMe) {
    return (
      <div className="rounded-md border bg-muted/30 px-4 py-6 text-center space-y-3">
        <p className="text-sm text-muted-foreground">Nhận phiên để bắt đầu chụp ảnh & nhập kích thước sản phẩm.</p>
        <Button size="sm" className="gap-1.5" onClick={doClaim} disabled={pending}>
          <HandMetal className="h-4 w-4" /> Nhận phiên xử lý
        </Button>
      </div>
    )
  }

  // ── Owner mode: item queue + inline editor ────────────────────────────────
  return (
    <div className="space-y-2">
      {sorted.map((it) => {
        const im = FS_ITEM_STATUS[it.status] ?? { label: it.status, cls: 'bg-muted text-muted-foreground' }
        const isOpen = selectedId === it.id
        // A 'done' item is reference-only — reopened only by an admin resubmit (r1).
        const editable = it.status !== 'done'
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
              {editable && (
                <Button size="sm" variant={isOpen ? 'outline' : 'default'} onClick={() => (isOpen ? setSelectedId(null) : openItem(it))} disabled={pending}>
                  {isOpen ? 'Đóng' : 'Xử lý'}
                </Button>
              )}
            </div>

            {isOpen && selected && selected.id === it.id && (
              <div className="border-t px-3 py-3 space-y-3 bg-muted/10">
                <div>
                  <p className="text-xs font-medium mb-1.5">Ảnh sản phẩm — nền trắng (Mặt trước & Mặt sau bắt buộc)</p>
                  <div className="flex flex-wrap gap-3">
                    {FS_PHOTO_BOXES.map((b) => (
                      <FsBoxUpload
                        key={b.key}
                        itemId={it.id}
                        box={b}
                        currentUrl={currentUrl(it, b.key)}
                        onUploaded={(bk, url, ct, size) => setUploaded((prev) => ({ ...prev, [bk]: { url, ct, size } }))}
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

                <div className="flex items-center gap-3">
                  <Button size="sm" className="gap-1.5" onClick={doSubmit} disabled={!canSubmit}>
                    <PackageCheck className="h-4 w-4" /> Hoàn thành sản phẩm
                  </Button>
                  {!box12Ready && <span className="text-xs text-amber-600">Cần ảnh Mặt trước & Mặt sau</span>}
                  {box12Ready && !dimsValid && <span className="text-xs text-amber-600">Nhập đủ kích thước hợp lệ (mm)</span>}
                </div>
              </div>
            )}
          </div>
        )
      })}
      {sorted.length === 0 && <p className="text-sm text-muted-foreground text-center py-8">Phiên chưa có sản phẩm.</p>}
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
