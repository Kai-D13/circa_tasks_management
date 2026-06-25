'use client'

import { useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { safeStorageName } from '@/lib/storage'
import { uploadViaGcs } from '@/lib/storage/uploadClient'
import { compressImage } from '@/lib/prescriptions/compressImage'
import { toast } from 'sonner'
import { Plus, X, Loader2 } from 'lucide-react'

const BUCKET = 'task-uploads' // public bucket (shared); GCS used first when enabled
const MAX_RAW = 25 * 1024 * 1024
const MAX_PER = 5 * 1024 * 1024
const ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']

interface Props {
  announcementId: string      // real id (edit) or client temp id (create) — keys the path
  value:          string[]    // uploaded public URLs
  onChange:       (urls: string[]) => void
  max:            number
  label:          string
}

export function AnnouncementImageUpload({ announcementId, value, onChange, max, label }: Props) {
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return
    const arr = Array.from(files)
    if (value.length + arr.length > max) { toast.error(`Tối đa ${max} ảnh`); return }
    const valid = arr.filter((f) => {
      if (!ALLOWED.includes(f.type)) { toast.error(`${f.name}: chỉ jpg, png, webp`); return false }
      if (f.size > MAX_RAW) { toast.error(`${f.name}: file quá lớn (>25MB)`); return false }
      return true
    })
    if (!valid.length) return

    setUploading(true)
    const supabase = createClient()
    const out: string[] = []
    for (const original of valid) {
      try {
        const file = await compressImage(original)
        if (file.size > MAX_PER) { toast.error(`${original.name}: ảnh quá lớn sau nén (>5MB)`); continue }
        const g = await uploadViaGcs(file, { purpose: 'announcement_asset', announcementId, filename: file.name })
        if (g !== 'fallback') {
          if ('error' in g) { toast.error(`Tải lên thất bại: ${original.name}`); continue }
          out.push(g.url); continue
        }
        // Supabase fallback (GCS off): same public bucket, announcement_assets prefix.
        const path = `announcement_assets/${announcementId}/${Date.now()}_${safeStorageName(file.name)}`
        const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false })
        if (error) throw error
        const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(path)
        out.push(publicUrl)
      } catch {
        toast.error(`Tải lên thất bại: ${original.name}`)
      }
    }
    if (out.length) { onChange([...value, ...out].slice(0, max)); toast.success(`Đã tải ${out.length} ảnh`) }
    setUploading(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  function remove(i: number) { onChange(value.filter((_, idx) => idx !== i)) }

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{label}</label>
      {value.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {value.map((url, i) => (
            <div key={url} className="relative group aspect-video rounded border overflow-hidden bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" className="w-full h-full object-cover" />
              <button type="button" aria-label="Xóa ảnh" onClick={() => remove(i)}
                className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {value.length < max && (
        <button type="button" disabled={uploading} onClick={() => inputRef.current?.click()}
          className="flex items-center justify-center gap-2 border-2 border-dashed rounded-md py-3 px-4 text-sm text-muted-foreground hover:bg-muted/40 transition-colors disabled:opacity-50 w-full">
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="h-4 w-4" />{value.length === 0 ? 'Thêm ảnh' : 'Thêm ảnh khác'}</>}
        </button>
      )}
      <input ref={inputRef} type="file" multiple accept="image/jpeg,image/jpg,image/png,image/webp"
        className="hidden" onChange={(e) => handleFiles(e.target.files)} disabled={uploading} aria-label={label} />
    </div>
  )
}
