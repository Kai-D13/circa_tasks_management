'use client'

import { useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Camera, Plus, X, Loader2, Image as ImageIcon } from 'lucide-react'

export interface ImageAttachment {
  url:  string
  name: string
  type: string
  size: number
}

interface Props {
  taskId: string
  value: ImageAttachment[]
  onChange: (atts: ImageAttachment[]) => void
}

const MAX_COUNT      = 20
const MAX_PER_IMAGE  = 5  * 1024 * 1024
const MAX_TOTAL      = 30 * 1024 * 1024
const ALLOWED_TYPES  = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']

export function MultiImageUpload({ taskId, value, onChange }: Props) {
  const [uploading, setUploading]     = useState(false)
  const galleryRef = useRef<HTMLInputElement>(null)
  const cameraRef  = useRef<HTMLInputElement>(null)

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return

    const fileArr = Array.from(files)

    if (value.length + fileArr.length > MAX_COUNT) {
      toast.error(`Tối đa ${MAX_COUNT} ảnh mỗi task`)
      return
    }

    const totalCurrent = value.reduce((s, a) => s + a.size, 0)
    const totalNew      = fileArr.reduce((s, f) => s + f.size, 0)
    if (totalCurrent + totalNew > MAX_TOTAL) {
      toast.error('Tổng dung lượng ảnh vượt 30MB')
      return
    }

    const validFiles = fileArr.filter((file) => {
      if (!ALLOWED_TYPES.includes(file.type)) {
        toast.error(`${file.name}: Chỉ hỗ trợ jpg, png, webp`)
        return false
      }
      if (file.size > MAX_PER_IMAGE) {
        toast.error(`${file.name}: Ảnh quá lớn (tối đa 5MB)`)
        return false
      }
      return true
    })
    if (!validFiles.length) return

    setUploading(true)
    const supabase = createClient()
    const uploaded: ImageAttachment[] = []

    for (const file of validFiles) {
      try {
        const path = `tasks/${taskId}/image/${Date.now()}_${file.name}`
        const { error } = await supabase.storage
          .from('task-uploads')
          .upload(path, file, { upsert: false })
        if (error) throw error
        const { data: { publicUrl } } = supabase.storage
          .from('task-uploads')
          .getPublicUrl(path)
        uploaded.push({ url: publicUrl, name: file.name, type: file.type, size: file.size })
      } catch {
        toast.error(`Tải lên thất bại: ${file.name}`)
      }
    }

    if (uploaded.length) {
      onChange([...value, ...uploaded])
      toast.success(`Đã tải lên ${uploaded.length} ảnh`)
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
      {/* Thumbnail grid */}
      {value.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {value.map((att, i) => (
            <div key={i} className="relative group aspect-square rounded border overflow-hidden bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={att.url}
                alt={att.name}
                className="w-full h-full object-cover"
              />
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

      {/* Upload buttons */}
      {value.length < MAX_COUNT && (
        <div className="flex gap-2">
          {/* Gallery picker */}
          <button
            type="button"
            disabled={uploading}
            onClick={() => galleryRef.current?.click()}
            className="flex-1 flex items-center justify-center gap-2 border-2 border-dashed rounded-md py-3 text-sm text-muted-foreground hover:bg-muted/40 transition-colors disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Plus className="h-4 w-4" />
                {value.length === 0 ? 'Chọn ảnh' : 'Thêm ảnh'}
              </>
            )}
          </button>

          {/* Camera button (useful on mobile) */}
          <button
            type="button"
            disabled={uploading}
            onClick={() => cameraRef.current?.click()}
            title="Chụp ảnh"
            className="flex items-center justify-center gap-1.5 border rounded-md px-3 text-sm text-muted-foreground hover:bg-muted/40 transition-colors disabled:opacity-50"
          >
            <Camera className="h-4 w-4" />
          </button>
        </div>
      )}

      {value.length === 0 && !uploading && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <ImageIcon className="h-3.5 w-3.5" />
          Tối đa {MAX_COUNT} ảnh · 5MB/ảnh · jpg, png, webp
        </p>
      )}

      {/* Hidden file inputs */}
      <input
        ref={galleryRef}
        type="file"
        multiple
        accept="image/jpeg,image/jpg,image/png,image/webp"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
        disabled={uploading}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
        disabled={uploading}
      />
    </div>
  )
}
