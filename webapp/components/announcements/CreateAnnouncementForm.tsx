'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Search } from 'lucide-react'
import { RichTextEditor } from '@/components/tasks/RichTextEditor'
import { AnnouncementImageUpload } from '@/components/announcements/AnnouncementImageUpload'
import { useAnnouncementFixtureBlocked } from '@/components/announcements/AnnouncementFixtureBoundary'
import { Panel } from '@/components/ds/Panel'
import { Notice } from '@/components/ds/Notice'
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
  /** UI v2 A3: truy vấn cửa hàng lỗi ⇒ báo lỗi trong khối "Gửi cho", KHÔNG hiện bộ chọn rỗng giả "Chưa có cửa hàng." */
  storesError?: boolean
}

// Bỏ dấu + chữ thường để lọc cửa hàng tại client (chỉ trên mảng `stores` đã tải — PM §3.6).
const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()
const viDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '')

// Reusable create/edit form for announcements (Bảng tin).
// UI v2 A3 (artboard B3) — chỉ trình bày: 3 khối Nội dung / Hình ảnh / Gửi cho; editor một viền (RichTextEditor flush);
// lọc cửa hàng tại client (giữ lựa chọn khi đổi từ khóa); thanh hành động dính đáy SAU nội dung trong DOM, tóm tắt gửi
// lấy từ state. Payload, validation, toast, điều hướng, upload GIỮ NGUYÊN. Guard fixture ngay đầu submit (trước
// validate + createAnnouncement/updateAnnouncement) — route thật: fixtureBlocked() = false.
export function CreateAnnouncementForm({ stores, mode = 'create', announcementId, initial, storesError = false }: Props) {
  const router = useRouter()
  const fixtureBlocked = useAnnouncementFixtureBlocked()
  // Path key for image uploads: the real id (edit) or a stable client temp id (create).
  const [assetKeyId] = useState(() => announcementId ?? crypto.randomUUID())
  const [title, setTitle]           = useState(initial?.title ?? '')
  const [body, setBody]             = useState(initial?.body ?? '')
  const [visibility, setVisibility] = useState<'all' | 'stores'>(initial?.visibility ?? 'all')
  const [storeIds, setStoreIds]     = useState<Set<string>>(new Set(initial?.storeIds ?? []))
  const [expiresAt, setExpiresAt]   = useState(initial?.expiresAt ?? '')
  const [cover, setCover]           = useState<string[]>(initial?.coverUrl ? [initial.coverUrl] : [])
  const [carousel, setCarousel]     = useState<string[]>(initial?.carouselUrls ?? [])
  const [storeQuery, setStoreQuery] = useState('')
  const [pending, start]            = useTransition()

  const shownStores = useMemo(() => {
    const q = fold(storeQuery.trim())
    return q ? stores.filter((s) => fold(s.name).includes(q)) : stores
  }, [stores, storeQuery])

  function toggleStore(id: string) {
    setStoreIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }

  function submit() {
    if (fixtureBlocked()) return
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

  // Tóm tắt thanh dưới — CHỈ từ state (không số giả): Tất cả / số cửa hàng đã chọn; hạn chỉ khi đã nhập.
  const summary = `${visibility === 'all' ? 'Gửi đến tất cả' : `Gửi đến ${storeIds.size} cửa hàng`}${expiresAt && viDate(expiresAt) ? ` · hết hạn ${viDate(expiresAt)}` : ''}`

  return (
    <div data-ann-form={mode} className="space-y-4 v2:space-y-[18px]">
      <Panel title="Nội dung" bodyClassName="space-y-4">
        <div>
          <label htmlFor="ann-title" className="block text-sm font-medium">Tiêu đề <span aria-hidden="true" className="text-destructive">*</span></label>
          <Input id="ann-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Tiêu đề thông báo" required aria-required="true"
            className="mt-1 h-[44px] text-[16px] md:h-10 md:text-sm" />
        </div>
        <div>
          <p className="text-sm font-medium">Nội dung</p>
          {/* Một viền duy nhất: khung ngoài có viền; editor flush bỏ viền-trên của thanh công cụ (không sửa component Tasks). */}
          <div data-ann-editor className="mt-1 overflow-hidden rounded-md border bg-background v2:rounded-v2-control [&>div>div:first-child]:border-t-0 [&>div:empty]:border-t-0">
            <RichTextEditor value={body} onChange={setBody} flush />
          </div>
          <p className="mt-1.5 text-[12px] text-muted-foreground">Có thể dán bảng từ Excel. Cần nội dung hoặc ít nhất một ảnh.</p>
        </div>
      </Panel>

      <Panel title="Hình ảnh" bodyClassName="space-y-4">
        <AnnouncementImageUpload announcementId={assetKeyId} value={cover} onChange={setCover} max={1} label="Ảnh bìa (tùy chọn)" kind="cover" />
        <AnnouncementImageUpload announcementId={assetKeyId} value={carousel} onChange={setCarousel} max={5} label="Ảnh carousel (tối đa 5, tùy chọn)" kind="carousel" />
        <p className="text-[12px] text-muted-foreground">jpg, png, webp · ảnh được nén tự động</p>
      </Panel>

      <Panel title="Gửi cho" bodyClassName="space-y-3">
        <div role="group" aria-label="Gửi cho" className="inline-flex gap-1 rounded-md bg-muted p-[3px] v2:rounded-v2-control">
          {([['all', 'Tất cả'], ['stores', 'Chọn cửa hàng']] as const).map(([v, l]) => (
            // R1-01: không tải được danh sách cửa hàng ⇒ CHỈ gửi được "Tất cả" (khớp Notice) — tắt "Chọn cửa hàng".
            <button key={v} type="button" onClick={() => setVisibility(v)} aria-pressed={visibility === v} data-ann-visibility={v}
              disabled={v === 'stores' && storesError}
              className={cn(
                'min-h-[44px] rounded-[8px] px-3 text-sm md:min-h-[36px]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                visibility === v ? 'border border-input bg-card font-semibold text-foreground' : 'text-muted-foreground enabled:hover:text-foreground',
              )}>
              {l}
            </button>
          ))}
        </div>

        {storesError && (
          <Notice tone="warning" role="status" title="Không tải được danh sách cửa hàng — chỉ có thể gửi cho “Tất cả”. Thử lại sau hoặc báo Admin." />
        )}

        {visibility === 'stores' && !storesError && (
          <div data-ann-store-picker className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative min-w-0 flex-1">
                <span className="sr-only">Lọc cửa hàng</span>
                <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={storeQuery} onChange={(e) => setStoreQuery(e.target.value)} placeholder="Lọc cửa hàng…" data-ann-store-filter
                  className="h-[44px] pl-9 text-[16px] md:h-9 md:text-sm" />
              </label>
              <span data-ann-store-count className="shrink-0 text-[13px] text-muted-foreground tabular-nums">
                Đã chọn <b className="font-semibold text-foreground">{storeIds.size}</b>/{stores.length}
              </span>
            </div>
            <div className="max-h-64 divide-y overflow-y-auto rounded-md border v2:rounded-v2-control">
              {shownStores.map((s) => (
                <label key={s.id} data-ann-store-option={s.id}
                  className={cn('flex min-h-[44px] cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50 md:min-h-0', storeIds.has(s.id) && 'bg-accent/60')}>
                  <input type="checkbox" checked={storeIds.has(s.id)} onChange={() => toggleStore(s.id)} className="accent-primary h-4 w-4 shrink-0" />
                  <span className="min-w-0 break-words">{s.name}</span>
                </label>
              ))}
              {stores.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">Chưa có cửa hàng.</p>}
              {stores.length > 0 && shownStores.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">Không có cửa hàng khớp.</p>}
            </div>
          </div>
        )}

        <div>
          <label htmlFor="ann-expires" className="block text-sm font-medium">Ngày hết hạn <span className="text-muted-foreground font-normal">(tùy chọn)</span></label>
          <Input id="ann-expires" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="mt-1 h-[44px] w-fit text-[16px] md:h-10 md:text-sm" />
          <p className="text-xs text-muted-foreground mt-1">Sau ngày này, Staff/Store sẽ không còn thấy thông báo. Để trống = không hết hạn.</p>
        </div>
      </Panel>

      {/* Thanh hành động dính đáy vùng cuộn <main> (mobile: <main> đã chừa chỗ cho bottom nav). Nằm SAU nội dung trong DOM. */}
      <div data-ann-form-bar
        className="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t bg-card/95 px-4 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom))] backdrop-blur md:mx-0 md:rounded-lg md:border md:px-4 md:py-3 v2:md:rounded-v2-panel">
        <span data-ann-form-summary className="min-w-0 flex-[1_1_180px] text-[13px] text-muted-foreground">{summary}</span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => router.back()} disabled={pending} className="h-[44px] md:h-9">Hủy</Button>
          <Button onClick={submit} disabled={pending} data-ann-submit className="h-[44px] md:h-9">
            {pending ? 'Đang lưu...' : mode === 'edit' ? 'Lưu thay đổi' : 'Tạo thông báo'}
          </Button>
        </div>
      </div>
    </div>
  )
}
