'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { RichTextEditor } from '@/components/tasks/RichTextEditor'
import { AnnouncementImageUpload } from '@/components/announcements/AnnouncementImageUpload'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createAnnouncement, updateAnnouncement } from '@/app/actions/announcements'
import { cn } from '@/lib/utils'

interface Initial {
  title: string
  body: string
  visibility: 'all' | 'stores'
  storeIds: string[]
  expiresAt: string          // 'YYYY-MM-DD' or ''
  coverUrl: string | null
  carouselUrls: string[]
}

interface Props {
  stores: { id: string; name: string }[]
  mode?: 'create' | 'edit'
  announcementId?: string    // required for edit
  initial?: Initial
}

// Reusable create/edit form for announcements (Bảng tin).
export function CreateAnnouncementForm({ stores, mode = 'create', announcementId, initial }: Props) {
  const router = useRouter()
  // Path key for image uploads: the real id (edit) or a stable client temp id (create).
  const [assetKeyId] = useState(() => announcementId ?? crypto.randomUUID())
  const [title, setTitle]           = useState(initial?.title ?? '')
  const [body, setBody]             = useState(initial?.body ?? '')
  const [visibility, setVisibility] = useState<'all' | 'stores'>(initial?.visibility ?? 'all')
  const [storeIds, setStoreIds]     = useState<Set<string>>(new Set(initial?.storeIds ?? []))
  const [expiresAt, setExpiresAt]   = useState(initial?.expiresAt ?? '')
  const [cover, setCover]           = useState<string[]>(initial?.coverUrl ? [initial.coverUrl] : [])
  const [carousel, setCarousel]     = useState<string[]>(initial?.carouselUrls ?? [])
  const [pending, start]            = useTransition()

  function toggleStore(id: string) {
    setStoreIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }

  function submit() {
    if (!title.trim()) { toast.error('Vui lòng nhập tiêu đề'); return }
    if (visibility === 'stores' && storeIds.size === 0) { toast.error('Chọn ít nhất một cửa hàng'); return }
    const payload = {
      title, body, visibility,
      storeIds: [...storeIds],
      expiresAt: expiresAt || null,
      coverUrl: cover[0] ?? null,
      carouselUrls: carousel,
    }
    start(async () => {
      const r = mode === 'edit' && announcementId
        ? await updateAnnouncement(announcementId, payload)
        : await createAnnouncement(payload)
      if ('error' in r) { toast.error(r.error); return }
      toast.success(mode === 'edit' ? 'Đã cập nhật thông báo' : 'Đã tạo thông báo')
      router.push(mode === 'edit' && announcementId ? `/announcements/${announcementId}` : '/announcements')
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium">Tiêu đề</label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Tiêu đề thông báo" className="mt-1" />
      </div>

      <AnnouncementImageUpload announcementId={assetKeyId} value={cover} onChange={setCover} max={1} label="Ảnh bìa (tùy chọn)" />
      <AnnouncementImageUpload announcementId={assetKeyId} value={carousel} onChange={setCarousel} max={5} label="Ảnh carousel (tối đa 5, tùy chọn)" />

      <div>
        <label className="text-sm font-medium">Nội dung</label>
        <div className="mt-1 rounded-md border"><RichTextEditor value={body} onChange={setBody} /></div>
      </div>

      <div>
        <label className="text-sm font-medium">Gửi cho</label>
        <div className="mt-1 flex rounded-[4px] border overflow-hidden w-fit">
          {([['all', 'Tất cả'], ['stores', 'Chọn cửa hàng']] as const).map(([v, l]) => (
            <button key={v} type="button" onClick={() => setVisibility(v)}
              className={cn('px-3 py-1.5 text-sm font-medium', visibility === v ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted')}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {visibility === 'stores' && (
        <div className="rounded border max-h-56 overflow-y-auto divide-y">
          {stores.map((s) => (
            <label key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-muted/50">
              <input type="checkbox" checked={storeIds.has(s.id)} onChange={() => toggleStore(s.id)} className="accent-primary h-4 w-4 shrink-0" />
              {s.name}
            </label>
          ))}
          {stores.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">Chưa có cửa hàng.</p>}
        </div>
      )}

      <div>
        <label className="text-sm font-medium">Ngày hết hạn <span className="text-muted-foreground font-normal">(tùy chọn)</span></label>
        <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="mt-1 w-fit" />
        <p className="text-xs text-muted-foreground mt-1">Sau ngày này, Staff/Store sẽ không còn thấy thông báo. Để trống = không hết hạn.</p>
      </div>

      <div className="flex gap-2">
        <Button onClick={submit} disabled={pending}>
          {pending ? 'Đang lưu...' : mode === 'edit' ? 'Lưu thay đổi' : 'Tạo thông báo'}
        </Button>
        <Button variant="outline" onClick={() => router.back()} disabled={pending}>Hủy</Button>
      </div>
    </div>
  )
}
