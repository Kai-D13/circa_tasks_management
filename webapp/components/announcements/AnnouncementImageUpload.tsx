'use client'

import { useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { safeStorageName } from '@/lib/storage'
import { uploadViaGcs } from '@/lib/storage/uploadClient'
import { compressImage } from '@/lib/prescriptions/compressImage'
import { toast } from 'sonner'
import { useAnnouncementFixtureBlocked } from '@/components/announcements/AnnouncementFixtureBoundary'
import { AnnouncementImageAddTile, AnnouncementImageTile, AnnouncementImageUploadingTile } from '@/components/announcements/AnnouncementImageTile'

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
  /** UI v2 A3: tên riêng cho nút xoá — 'cover' ⇒ "Xóa ảnh bìa", 'carousel' ⇒ "Xóa ảnh carousel N". */
  kind?:          'cover' | 'carousel'
}

// UI v2 A3 (artboard B3): logic tải lên GIỮ NGUYÊN (giới hạn số ảnh / loại / 25MB thô / nén / 5MB sau nén / GCS trước,
// Supabase fallback cùng bucket + prefix). Mới: (1) ô ảnh A0 — nút xoá LUÔN hiện, vùng bấm 44px, aria-label riêng;
// (2) guard fixture NGAY ĐẦU handleFiles, trước nén / uploadViaGcs (createUploadUrl) / storage.upload — fixture
// /ui-catalog/announcements-v2 không bao giờ tải file thật; route thật: fixtureBlocked() = false ⇒ luồng cũ.
export function AnnouncementImageUpload({ announcementId, value, onChange, max, label, kind = 'carousel' }: Props) {
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const fixtureBlocked = useAnnouncementFixtureBlocked()

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return
    if (fixtureBlocked()) { if (inputRef.current) inputRef.current.value = ''; return }
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
    <div data-ann-upload={kind} className="space-y-2">
      <p className="text-sm font-medium">
        {label}
        {max > 1 && <span data-ann-upload-count className="font-normal text-muted-foreground tabular-nums"> · {value.length}/{max}</span>}
      </p>
      <div className="grid grid-cols-3 gap-2">
        {value.map((url, i) => (
          <AnnouncementImageTile
            key={url}
            url={url}
            removeLabel={kind === 'cover' ? 'Xóa ảnh bìa' : `Xóa ảnh carousel ${i + 1}`}
            onRemove={() => remove(i)}
            disabled={uploading}
          />
        ))}
        {uploading && <AnnouncementImageUploadingTile />}
        {!uploading && value.length < max && (
          <AnnouncementImageAddTile label={value.length === 0 ? 'Thêm ảnh' : 'Thêm ảnh khác'} onClick={() => inputRef.current?.click()} />
        )}
      </div>
      <input ref={inputRef} type="file" multiple accept="image/jpeg,image/jpg,image/png,image/webp"
        className="hidden" onChange={(e) => handleFiles(e.target.files)} disabled={uploading} aria-label={label} />
    </div>
  )
}
