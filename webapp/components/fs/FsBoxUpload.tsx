'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { uploadViaGcs } from '@/lib/storage/uploadClient'
import { cn } from '@/lib/utils'
import { Camera, Loader2, RotateCcw } from 'lucide-react'

interface Box { key: 1 | 2 | 3 | 4 | 5; label: string; slug: string; required: boolean }

// One product photo box → direct-to-GCS upload (purpose 'fs_product', GCS-only:
// a Supabase fallback is treated as an error since FS requires GCS). Reports the
// resulting public URL up to the wizard.
export function FsBoxUpload({
  itemId, box, currentUrl, onUploaded,
}: {
  itemId: string
  box: Box
  currentUrl: string | null
  onUploaded: (boxKey: number, url: string, contentType: string, sizeBytes: number) => void
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
      <label
        htmlFor={inputId}
        className={cn(
          'aspect-square rounded-md border-2 border-dashed flex items-center justify-center overflow-hidden cursor-pointer relative bg-muted/30 hover:bg-muted/50',
          box.required && !currentUrl && 'border-amber-300',
        )}
      >
        {uploading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : currentUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={currentUrl} alt={box.label} className="h-full w-full object-cover" />
            <span className="absolute bottom-1 right-1 bg-black/50 text-white rounded p-0.5">
              <RotateCcw className="h-3 w-3" />
            </span>
          </>
        ) : (
          <Camera className="h-5 w-5 text-muted-foreground/60" />
        )}
      </label>
      <input id={inputId} type="file" accept="image/*" className="sr-only"
        aria-label={box.label}
        onClick={(e) => { (e.currentTarget as HTMLInputElement).value = '' }}
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        disabled={uploading}
      />
      <p className="text-[11px] text-muted-foreground truncate">
        {box.label}{box.required && <span className="text-amber-600"> *</span>}
      </p>
    </div>
  )
}
