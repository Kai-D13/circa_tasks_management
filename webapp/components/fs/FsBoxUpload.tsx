'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { uploadViaGcs } from '@/lib/storage/uploadClient'
import { cn } from '@/lib/utils'
import { Camera, Loader2, X } from 'lucide-react'

interface Box { key: 1 | 2 | 3 | 4 | 5; label: string; slug: string; required: boolean }

// One product photo box → direct-to-GCS upload (purpose 'fs_product', GCS-only:
// a Supabase fallback is an error since FS requires GCS). A STAGED photo (uploaded
// but not yet submitted) shows an 'X' so it can be discarded (deleting the GCS
// object). A box the admin flagged 'redo' shows a badge until re-shot.
export function FsBoxUpload({
  itemId, box, currentUrl, isStaged, isRedo, note, disabled, onUploaded, onRemoveStaged,
}: {
  itemId: string
  box: Box
  currentUrl: string | null
  isStaged: boolean
  isRedo: boolean
  note: string | null
  disabled?: boolean
  onUploaded: (boxKey: number, url: string, contentType: string, sizeBytes: number) => void
  onRemoveStaged: (boxKey: number) => void
}) {
  const [uploading, setUploading] = useState(false)

  async function onFile(f: File | null) {
    if (!f) return
    if (!f.type.startsWith('image/')) { toast.error('Chỉ chấp nhận ảnh'); return }
    if (f.type === 'image/svg+xml') { toast.error('Không hỗ trợ ảnh SVG'); return }
    if (f.size > 5 * 1024 * 1024) { toast.error('Ảnh vượt 5MB'); return }
    setUploading(true)
    try {
      const r = await uploadViaGcs(f, { purpose: 'fs_product', itemId, boxKey: box.key, filename: f.name, contentType: f.type })
      if (r === 'fallback') { toast.error('GCS chưa bật — không thể tải ảnh FS'); return }
      if ('error' in r) { toast.error(r.error); return }
      onUploaded(box.key, r.url, f.type, f.size)
    } finally {
      setUploading(false)
    }
  }

  const inputId = `fs-box-${itemId}-${box.key}`
  return (
    <div className="w-32 space-y-1">
      <div className={cn(
        'aspect-square rounded-md border-2 border-dashed flex items-center justify-center overflow-hidden relative bg-muted/30',
        isRedo && 'border-amber-400',
        box.required && !currentUrl && !isRedo && 'border-amber-300',
      )}>
        <label htmlFor={inputId} className={cn('absolute inset-0 flex items-center justify-center', disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-muted/40')}>
          {uploading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : currentUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={currentUrl} alt={box.label} className="h-full w-full object-cover" />
          ) : (
            <Camera className="h-5 w-5 text-muted-foreground/60" />
          )}
        </label>
        {isRedo && !isStaged && (
          <span className="absolute top-1 left-1 bg-amber-500 text-white rounded px-1 py-0.5 text-[9px] font-medium">Cần chụp lại</span>
        )}
        {isStaged && !uploading && (
          <button
            type="button"
            aria-label="Xoá ảnh vừa chụp"
            onClick={() => onRemoveStaged(box.key)}
            className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-0.5 hover:bg-black/80"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <input id={inputId} type="file" accept="image/*" className="sr-only"
        aria-label={box.label}
        onClick={(e) => { (e.currentTarget as HTMLInputElement).value = '' }}
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        disabled={uploading || disabled}
      />
      <p className="text-[11px] text-muted-foreground truncate">
        {box.label}{box.required && <span className="text-amber-600"> *</span>}
      </p>
      {isRedo && note && <p className="text-[10px] text-amber-700 leading-tight">{note}</p>}
    </div>
  )
}
