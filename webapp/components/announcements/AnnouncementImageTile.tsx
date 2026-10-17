'use client'

import { Loader2, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// UI v2 Phase 3 · Bảng tin (A0, artboard B0 "Ảnh tải lên" / B3) — ô ảnh của form tạo/sửa, CHỈ trình bày.
// Logic tải lên (nén, GCS / Supabase fallback, giới hạn số ảnh, loại file) vẫn ở AnnouncementImageUpload, không đổi.
// Sửa lỗi bản cũ: nút xoá chỉ hiện khi rê chuột ⇒ không bấm được trên điện thoại. Ở đây nút LUÔN hiện, vùng bấm
// 44×44px (vòng tròn nhìn thấy 28px), aria-label riêng từng ảnh do caller truyền.

const TILE = 'relative aspect-video overflow-hidden rounded-md border bg-muted v2:rounded-[10px]'

export function AnnouncementImageTile({
  url, removeLabel, onRemove, disabled,
}: {
  url: string
  /** Tên riêng của nút xoá, vd "Xóa ảnh bìa", "Xóa ảnh carousel 2". */
  removeLabel: string
  onRemove?: () => void
  disabled?: boolean
}) {
  return (
    <div data-ann-image-tile className={TILE}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="" className="h-full w-full object-cover" />
      <button
        type="button"
        aria-label={removeLabel}
        data-ann-image-remove
        onClick={onRemove}
        disabled={disabled}
        className="absolute right-0 top-0 inline-flex size-[44px] items-center justify-center focus-visible:outline-none disabled:opacity-50 group/rm"
      >
        <span
          aria-hidden="true"
          className="inline-flex size-7 items-center justify-center rounded-full bg-black/60 text-white group-focus-visible/rm:ring-2 group-focus-visible/rm:ring-white"
        >
          <X className="size-[13px]" strokeWidth={2.4} />
        </span>
      </button>
    </div>
  )
}

export function AnnouncementImageUploadingTile() {
  return (
    <div data-ann-image-uploading role="status" className={cn(TILE, 'flex items-center justify-center gap-1.5 text-[12px] text-muted-foreground')}>
      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      <span>Đang tải…</span>
    </div>
  )
}

export function AnnouncementImageAddTile({
  label, onClick, disabled,
}: {
  /** Chữ hiện hành: "Thêm ảnh" (chưa có ảnh) / "Thêm ảnh khác". */
  label: string
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      data-ann-image-add
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex aspect-video min-h-[44px] items-center justify-center gap-1.5 rounded-md border-[1.5px] border-dashed border-input',
        'text-[13px] text-muted-foreground transition-colors hover:bg-muted/40 disabled:opacity-50 v2:rounded-[10px]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <Plus aria-hidden="true" className="size-4" />
      {label}
    </button>
  )
}
