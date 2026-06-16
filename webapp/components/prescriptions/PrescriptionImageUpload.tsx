'use client'

import { useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { safeStorageName } from '@/lib/storage'
import { toast } from 'sonner'
import { Camera, Plus, X, Loader2 } from 'lucide-react'
import { PRESCRIPTION_BUCKET } from '@/lib/prescriptions/constants'
import { compressImage } from '@/lib/prescriptions/compressImage'

export interface PrescriptionImage {
  path:       string  // storage_path for server (stored in DB)
  previewUrl: string  // public/signed URL for client preview only
  name:       string
  type:       string
  size:       number
}

interface Props {
  submissionId: string
  storeId:      string
  value:        PrescriptionImage[]
  onChange:     (imgs: PrescriptionImage[]) => void
}

const MAX_COUNT     = 10
const MAX_RAW       = 25 * 1024 * 1024 // pre-compression guard: don't load absurd files into a canvas
const MAX_PER_IMAGE = 5 * 1024 * 1024  // post-compression cap actually uploaded
const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']

export function PrescriptionImageUpload({ submissionId, storeId, value, onChange }: Props) {
  const [uploading, setUploading] = useState(false)
  const galleryRef = useRef<HTMLInputElement>(null)
  const cameraRef  = useRef<HTMLInputElement>(null)

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const fileArr = Array.from(files)

    if (value.length + fileArr.length > MAX_COUNT) {
      toast.error(`Tối đa ${MAX_COUNT} ảnh toa thuốc`)
      return
    }

    // Validate the ORIGINAL by type + a generous raw cap. Per-image size is checked
    // after compression below, so large camera photos aren't rejected up front.
    const validFiles = fileArr.filter((f) => {
      if (!ALLOWED_TYPES.includes(f.type)) {
        toast.error(`${f.name}: chỉ hỗ trợ jpg, png, webp`)
        return false
      }
      if (f.size > MAX_RAW) {
        toast.error(`${f.name}: file quá lớn (tối đa 25MB)`)
        return false
      }
      return true
    })
    if (!validFiles.length) return

    setUploading(true)
    const supabase  = createClient()
    const uploaded: PrescriptionImage[] = []

    for (const original of validFiles) {
      try {
        // Downscale/re-encode large photos client-side before upload (faster on
        // mobile data, smaller storage). Falls back to the original on any failure.
        const file = await compressImage(original)
        if (file.size > MAX_PER_IMAGE) {
          toast.error(`${original.name}: ảnh quá lớn sau khi nén (tối đa 5MB)`)
          continue
        }
        // Path includes store_id for store-level isolation. Sanitize the key —
        // Supabase rejects non-ASCII keys (InvalidKey); original name kept below.
        const path = `prescriptions/${storeId}/${submissionId}/${Date.now()}_${safeStorageName(file.name)}`
        const { error } = await supabase.storage
          .from(PRESCRIPTION_BUCKET)
          .upload(path, file, { upsert: false })
        if (error) throw error

        // Get preview URL (public for task-uploads; replace with signed URL when using private bucket)
        const { data: { publicUrl } } = supabase.storage
          .from(PRESCRIPTION_BUCKET)
          .getPublicUrl(path)

        uploaded.push({ path, previewUrl: publicUrl, name: file.name, type: file.type, size: file.size })
      } catch {
        toast.error(`Tải lên thất bại: ${original.name}`)
      }
    }

    if (uploaded.length) {
      onChange([...value, ...uploaded])
      toast.success(`Đã tải ${uploaded.length} ảnh`)
    }
    setUploading(false)
    if (galleryRef.current) galleryRef.current.value = ''
    if (cameraRef.current)  cameraRef.current.value  = ''
  }

  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i))
  }

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {value.map((img, i) => (
            <div key={img.path} className="relative group aspect-square rounded border overflow-hidden bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.previewUrl} alt={img.name} className="w-full h-full object-cover" />
              <button
                type="button"
                aria-label="Xóa ảnh"
                onClick={() => remove(i)}
                className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {value.length < MAX_COUNT && (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={uploading}
            onClick={() => galleryRef.current?.click()}
            className="flex-1 flex items-center justify-center gap-2 border-2 border-dashed rounded-md py-4 text-sm text-muted-foreground hover:bg-muted/40 transition-colors disabled:opacity-50"
          >
            {uploading
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <><Plus className="h-4 w-4" />{value.length === 0 ? 'Chọn ảnh' : 'Thêm ảnh'}</>
            }
          </button>
          <button
            type="button"
            disabled={uploading}
            onClick={() => cameraRef.current?.click()}
            title="Chụp ảnh bằng camera"
            className="flex items-center justify-center border rounded-md px-4 text-muted-foreground hover:bg-muted/40 disabled:opacity-50"
          >
            <Camera className="h-5 w-5" />
          </button>
        </div>
      )}

      {value.length === 0 && !uploading && (
        <p className="text-xs text-muted-foreground">Tối đa {MAX_COUNT} ảnh · ảnh lớn sẽ tự động nén · jpg, png, webp</p>
      )}

      <input ref={galleryRef} aria-label="Chọn ảnh từ thư viện" type="file" multiple accept="image/jpeg,image/jpg,image/png,image/webp" className="hidden" onChange={(e) => handleFiles(e.target.files)} disabled={uploading} />
      <input ref={cameraRef}  aria-label="Chụp ảnh bằng camera" type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => handleFiles(e.target.files)} disabled={uploading} />
    </div>
  )
}
