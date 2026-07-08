'use client'

import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { uploadViaGcs } from '@/lib/storage/uploadClient'
import { compressImage } from '@/lib/prescriptions/compressImage'
import { cn } from '@/lib/utils'
import { Camera, Loader2, X, Images } from 'lucide-react'

interface Box { key: 1 | 2 | 3 | 4 | 5; label: string; slug: string; required: boolean }

const MAX_RAW = 25 * 1024 * 1024   // pre-compress guard — big camera photos are allowed in
const MAX_FINAL = 5 * 1024 * 1024  // real cap, enforced on the COMPRESSED result (server matches)

// One product photo box → direct-to-GCS upload (purpose 'fs_product', GCS-only).
// Mobile-first: the tile opens the REAR camera (capture="environment"); a small
// "Thư viện" button picks from gallery. Every photo is compressed client-side
// (reuse compressImage — EXIF-safe, ~1600px/0.8) so phone photos don't fail the
// 5MB cap and bandwidth stays low. A staged (unsaved) photo shows an 'X'; a box
// the admin flagged 'redo' shows a badge until re-shot.
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
  const cameraRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)

  async function onFile(f: File | null) {
    if (!f) return
    if (!f.type.startsWith('image/')) { toast.error('Chỉ chấp nhận ảnh'); return }
    if (f.type === 'image/svg+xml') { toast.error('Không hỗ trợ ảnh SVG'); return }
    if (f.size > MAX_RAW) { toast.error('Ảnh quá lớn (>25MB)'); return }
    setUploading(true)
    try {
      const file = await compressImage(f) // returns a File (jpg); failure-safe → original
      if (file.size > MAX_FINAL) { toast.error('Ảnh vẫn vượt 5MB sau khi nén'); return }
      const r = await uploadViaGcs(file, { purpose: 'fs_product', itemId, boxKey: box.key, filename: file.name, contentType: file.type })
      if (r === 'fallback') { toast.error('GCS chưa bật — không thể tải ảnh FS'); return }
      if ('error' in r) { toast.error(r.error); return }
      onUploaded(box.key, r.url, file.type, file.size)
    } finally {
      setUploading(false)
    }
  }

  const resetInput = (e: React.MouseEvent<HTMLInputElement>) => { (e.currentTarget as HTMLInputElement).value = '' }

  return (
    <div className="w-32 space-y-1">
      <div className={cn(
        'aspect-square rounded-md border-2 border-dashed relative bg-muted/30',
        isRedo && 'border-amber-400',
        box.required && !currentUrl && !isRedo && 'border-amber-300',
      )}>
        <button
          type="button"
          disabled={uploading || disabled}
          onClick={() => cameraRef.current?.click()}
          aria-label={`Chụp ${box.label}`}
          className="absolute inset-0 flex items-center justify-center rounded-md hover:bg-muted/40 disabled:cursor-not-allowed"
        >
          {uploading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : currentUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={currentUrl} alt={box.label} className="h-full w-full object-cover rounded-md" />
          ) : (
            <Camera className="h-6 w-6 text-muted-foreground/60" />
          )}
        </button>
        {isRedo && !isStaged && (
          <span className="absolute top-1 left-1 bg-amber-500 text-white rounded px-1 py-0.5 text-[9px] font-medium">Cần chụp lại</span>
        )}
        {isStaged && !uploading && (
          <button
            type="button"
            aria-label="Xoá ảnh vừa chụp"
            onClick={() => onRemoveStaged(box.key)}
            className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-1.5 hover:bg-black/80"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-1">
        <p className="text-[11px] text-muted-foreground truncate">
          {box.label}{box.required && <span className="text-amber-600"> *</span>}
        </p>
        <button
          type="button"
          disabled={uploading || disabled}
          onClick={() => galleryRef.current?.click()}
          className="shrink-0 inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <Images className="h-3 w-3" /> Thư viện
        </button>
      </div>
      {isRedo && note && <p className="text-[10px] text-amber-700 leading-tight">{note}</p>}

      {/* Rear camera on mobile; desktop ignores `capture` → normal file dialog. */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only"
        aria-label={`Chụp ${box.label}`} onClick={resetInput} onChange={(e) => onFile(e.target.files?.[0] ?? null)} disabled={uploading || disabled} />
      {/* Gallery fallback. */}
      <input ref={galleryRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only"
        aria-label={`Chọn ảnh ${box.label} từ thư viện`} onClick={resetInput} onChange={(e) => onFile(e.target.files?.[0] ?? null)} disabled={uploading || disabled} />
    </div>
  )
}
