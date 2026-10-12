'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarDays, ImagePlus, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { StickyActionBar } from '@/components/ds/StickyActionBar'
import { CARE_OUTCOMES, CARE_OUTCOME_META, CARE_TERMINAL_OUTCOMES, type CareOutcome } from '@/lib/care/outcome'
import { CARE_NOTE_MAX, CARE_PROOF_MAX, CARE_PROOF_MAX_BYTES, CARE_RECORD_MESSAGES, careDateLabel, careNextDatePresets, isCareProofMime, validateInteractionInput } from '@/lib/care/my'
import { cn } from '@/lib/utils'
import { uploadViaGcs } from '@/lib/storage/uploadClient'

// Form ghi một lượt chăm sóc (SPEC B4 §3). Sáu outcome từ lib/care/outcome.ts; ghi chú
// 1–500 bắt buộc; UNREACHABLE/CALLBACK bắt buộc ngày hẹn hôm nay..hết tháng task (giờ VN);
// outcome kết thúc không nhận ngày. Ảnh TÙY CHỌN (≤5), upload lỗi vẫn cho bỏ ảnh và lưu.
// Chống gửi đôi bằng ref; RPC lỗi ⇒ giữ nguyên nội dung form. Server/RPC 114 quyết cuối.
// B7-ui (M05/M01): outcome chia 2 nhóm hiển thị (vẫn MỘT radiogroup) theo `terminal`; ngày hẹn
// có nút nhanh trong [hôm nay, hạn]; nút Lưu ở thanh đáy, KHÔNG disable vì thiếu trường (Q-108) —
// dòng "Còn thiếu…" gợi ý, lỗi vẫn báo khi bấm.
// B7-ui r2 (artboard 10): mỗi nhóm là khối liền, dòng chọn tô nhạt; khung ngày hẹn ngay dưới nhóm
// "Cần liên hệ lại", hiện "dd/mm/yyyy (Thứ …)" — ô date native (giữ min/max) phủ trong suốt lên trên
// vì ô native có thể hiện mm/dd; ảnh dạng ô 84px. Không thêm câu ghi chú mẫu (Q-108).

const OUTCOME_GROUPS: { key: string; title: string; hint: string; items: readonly CareOutcome[] }[] = [
  { key: 'again', title: 'Cần liên hệ lại', hint: 'Bắt buộc chọn ngày hẹn trong tháng — khách vẫn mở.', items: CARE_OUTCOMES.filter((o) => !CARE_OUTCOME_META[o].terminal) },
  { key: 'end', title: 'Kết thúc chăm sóc khách này', hint: 'Khách chuyển sang Hoàn thành — không ghi thêm lượt.', items: CARE_TERMINAL_OUTCOMES },
]

export type CareRecordFn = (input: { taskId: string; outcome: string; note: string; nextActionDate: string | null; proofUrls: string[] }) =>
  Promise<{ ok: true; status: 'open' | 'completed' } | { ok: false; code: string; message: string }>
export type CareProofUploadFn = (file: File, taskId: string) => Promise<{ url: string } | { error: string }>

/** Upload thật: GCS qua createUploadUrl purpose care_proof (server kiểm quyền + key opaque). */
const defaultUploadProof: CareProofUploadFn = async (file, taskId) => {
  const r = await uploadViaGcs(file, { purpose: 'care_proof', taskId, filename: 'proof' })
  if (r === 'fallback') return { error: 'Kho ảnh chưa bật — có thể lưu không kèm ảnh' }
  return 'error' in r ? { error: r.error } : { url: r.url }
}

type Photo = { id: string; name: string; state: 'uploading' | 'done' | 'error'; url?: string; error?: string; preview: string }

export function CareInteractionForm({ taskId, customerName, todayISO, dueDate, record, uploadProof = defaultUploadProof, doneHref, proofDisabled = false }: {
  taskId: string
  customerName: string
  todayISO: string
  dueDate: string
  record: CareRecordFn
  uploadProof?: CareProofUploadFn
  doneHref: string
  /** B6-qa-ui: chế độ QA local không tải ảnh (server cũng chặn). */
  proofDisabled?: boolean
}) {
  const router = useRouter()
  const [outcome, setOutcome] = useState<CareOutcome | ''>('')
  const [note, setNote] = useState('')
  const [date, setDate] = useState('')
  const [photos, setPhotos] = useState<Photo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const sending = useRef(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const meta = outcome ? CARE_OUTCOME_META[outcome] : null
  const uploading = photos.some((p) => p.state === 'uploading')
  const doneUrls = photos.filter((p) => p.state === 'done' && p.url).map((p) => p.url!)
  const missing = [!outcome && 'kết quả', meta?.requiresNextActionDate && !date && 'ngày hẹn', !note.trim() && 'ghi chú']
    .filter((x): x is string => typeof x === 'string')

  async function addFiles(list: FileList | null) {
    if (!list) return
    const room = CARE_PROOF_MAX - photos.length
    const files = Array.from(list).slice(0, Math.max(0, room))
    for (const f of files) {
      const id = crypto.randomUUID()
      const ok = isCareProofMime(f.type) && f.size > 0 && f.size <= CARE_PROOF_MAX_BYTES
      // Không giữ tên file gốc (có thể chứa tên/SĐT khách) — chỉ đánh số.
      const photo: Photo = { id, name: `Ảnh ${photos.length + files.indexOf(f) + 1}`, state: ok ? 'uploading' : 'error',
        error: ok ? undefined : 'Chỉ nhận ảnh JPG/PNG/WebP/HEIC ≤ 5MB', preview: URL.createObjectURL(f) }
      setPhotos((cur) => [...cur, photo])
      if (!ok) continue
      try {
        const r = await uploadProof(f, taskId)
        setPhotos((cur) => cur.map((p) => p.id === id ? ('url' in r ? { ...p, state: 'done', url: r.url } : { ...p, state: 'error', error: r.error }) : p))
      } catch {
        setPhotos((cur) => cur.map((p) => p.id === id ? { ...p, state: 'error', error: 'Tải ảnh thất bại' } : p))
      }
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  function removePhoto(id: string) {
    setPhotos((cur) => { const p = cur.find((x) => x.id === id); if (p) URL.revokeObjectURL(p.preview); return cur.filter((x) => x.id !== id) })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (sending.current || busy || uploading) return
    setError(null); setFieldError(null)
    // Ảnh lỗi bị bỏ qua (tùy chọn) — chỉ gửi ảnh đã tải xong.
    const v = validateInteractionInput(
      { outcome, note, nextActionDate: meta?.requiresNextActionDate ? date : '', proofUrls: doneUrls },
      { taskId, todayISO, dueDate })
    if (!v.ok) { setFieldError(CARE_RECORD_MESSAGES[v.code]); return }
    sending.current = true
    setBusy(true)
    let saved = false
    try {
      const r = await record({ taskId, outcome: v.outcome, note: v.note, nextActionDate: v.nextActionDate, proofUrls: doneUrls })
      if (r.ok) {
        // Không gọi router.refresh() ngay sau push (huỷ điều hướng); action đã revalidatePath
        // và trang chi tiết là dynamic ⇒ dữ liệu mới. Đã lưu ⇒ GIỮ khoá tới khi rời trang
        // (bấm thêm trong lúc chuyển trang không tạo lượt trùng).
        saved = true
        // replace (không push): bấm "Quay lại" sau khi lưu không mở lại form vừa gửi.
        router.replace(doneHref)
        return
      }
      setError(r.message)   // giữ nguyên nội dung để sửa/thử lại
    } catch {
      // Có thể server đã lưu trước khi mạng rớt — RPC chặn lượt trùng 2 phút nên gửi lại không nhân đôi.
      setError('Không chắc đã lưu (mạng chập chờn). Mở tab Lịch sử để kiểm tra; gửi lại trong 2 phút sẽ không tạo lượt trùng.')
    } finally {
      if (!saved) { sending.current = false; setBusy(false) }
    }
  }

  const dateBlock = meta?.requiresNextActionDate && (
    <div className="space-y-2.5 rounded-care-ctl bg-status-info-bg p-3.5">
      <label htmlFor="care-next-date" className="block text-sm font-semibold text-status-info">Ngày hẹn chăm sóc lại (bắt buộc)</label>
      {/* Ô hiển thị (aria-hidden) + ô date native trong suốt phủ lên: bấm vẫn mở bộ chọn ngày của máy. */}
      <div className="relative rounded-care-field has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50">
        <div aria-hidden className="flex h-[44px] items-center justify-between rounded-care-field border border-status-info/30 bg-card px-3.5 text-[16px] md:text-sm">
          <span className={date ? 'font-medium' : 'text-muted-foreground'}>{date ? careDateLabel(date) : 'Chọn ngày'}</span>
          <CalendarDays className="size-[18px] text-muted-foreground" />
        </div>
        <input id="care-next-date" type="date" min={todayISO} max={dueDate} value={date}
          onChange={(e) => { setDate(e.target.value); setFieldError(null) }}
          onClick={(e) => { try { e.currentTarget.showPicker() } catch { /* trình duyệt không hỗ trợ ⇒ mở theo mặc định */ } }}
          className="absolute inset-0 size-full cursor-pointer opacity-0 text-[16px]" />
      </div>
      <div className="flex flex-wrap gap-x-1.5" role="group" aria-label="Chọn nhanh ngày hẹn">
        {careNextDatePresets(todayISO, dueDate).map((p) => (
          <button key={p.label} type="button" disabled={p.disabled} aria-pressed={date === p.value} onClick={() => { setDate(p.value); setFieldError(null) }}
            className="group flex min-h-[44px] items-center disabled:cursor-not-allowed">
            <span className={cn('inline-flex h-[34px] items-center rounded-full border px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors group-disabled:opacity-40',
              date === p.value ? 'border-status-info bg-status-info text-background' : 'border-care-line-strong bg-card text-foreground/80')}>
              {p.label}
            </span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Từ hôm nay đến hết tháng ({dueDate.slice(8, 10)}/{dueDate.slice(5, 7)}).</p>
    </div>
  )

  return (
    <form onSubmit={submit} className="flex flex-1 flex-col" data-testid="care-interaction-form" noValidate>
      <div className="flex-1 space-y-6 px-4 pt-4 pb-6 md:space-y-5 md:p-0">
        {/* Mobile: tên khách đã ở dòng phụ header riêng (CareMyHeader). */}
        <p className="hidden text-sm text-muted-foreground md:block">Khách: <span className="font-medium text-foreground">{customerName}</span></p>

        <fieldset className="space-y-3">
          <legend className="mb-1 px-1 text-[16px] font-semibold md:text-sm">Kết quả chăm sóc <span aria-hidden className="text-status-danger">*</span></legend>
          <div className="space-y-4" role="radiogroup" aria-label="Kết quả chăm sóc">
            {OUTCOME_GROUPS.map((g) => (
              <div key={g.key} className="space-y-2">
                <div className="px-1">
                  <p className="text-[13px] font-semibold text-muted-foreground">{g.title}</p>
                  <p className="text-xs text-muted-foreground">{g.hint}</p>
                </div>
                <div className="divide-y divide-care-line overflow-hidden rounded-care-ctl border border-care-line bg-card">
                  {g.items.map((o) => {
                    const m = CARE_OUTCOME_META[o]
                    const active = outcome === o
                    return (
                      <label key={o} className={cn('flex min-h-[52px] cursor-pointer items-center gap-3 px-3.5 py-2 text-[15px] md:min-h-[44px] md:text-sm',
                        active && 'bg-care-select font-semibold ring-1 ring-care-select-line ring-inset')}>
                        <input type="radio" name="outcome" value={o} checked={active} className="size-5 shrink-0 accent-[var(--care-cta)]"
                          onChange={() => { setOutcome(o); setFieldError(null); if (!m.requiresNextActionDate) setDate('') }} />
                        <span className="flex-1">{m.label}</span>
                      </label>
                    )
                  })}
                </div>
                {g.key === 'again' && dateBlock}
              </div>
            ))}
          </div>
        </fieldset>

        {meta?.recordsStoreRefusal && (
          <p className="rounded-care-ctl border border-status-warning/40 bg-status-warning-bg p-3 text-sm" role="note">
            Khách từ chối sẽ không được giao chăm sóc lại tại cửa hàng này.
          </p>
        )}

        <div className="space-y-1.5">
          <label htmlFor="care-note" className="block px-1 text-[16px] font-semibold md:text-sm">Ghi chú (bắt buộc)</label>
          <Textarea id="care-note" rows={4} maxLength={CARE_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)}
            className="min-h-[96px] rounded-care-ctl border-care-line-strong bg-card px-3.5 py-3 text-[16px] md:text-sm" placeholder="Nội dung trao đổi với khách…" />
          <p className="px-1 text-right text-xs tabular-nums text-muted-foreground">{note.trim().length}/{CARE_NOTE_MAX}</p>
        </div>

        <div className="space-y-2">
          <p className="px-1 text-[16px] font-semibold md:text-sm">Ảnh minh chứng <span className="text-[13px] font-normal text-muted-foreground">· không bắt buộc, tối đa {CARE_PROOF_MAX}</span></p>
          <p className="px-1 text-[13px] text-muted-foreground">Chỉ chụp đủ để minh chứng việc liên hệ; tránh chụp CCCD, đơn thuốc hay thông tin sức khoẻ không cần thiết.</p>
          {proofDisabled ? (
            <p className="px-1 text-xs text-status-warning" role="note">
              Chế độ QA: không tải ảnh minh chứng — lượt chăm sóc vẫn lưu bình thường.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {photos.length > 0 && (
                <ul className="flex flex-wrap gap-2" aria-label="Ảnh đã chọn">
                  {photos.map((p) => (
                    <li key={p.id} className="relative size-[84px] overflow-hidden rounded-care-field border bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element -- preview cục bộ (blob:) */}
                      <img src={p.preview} alt={p.name} className="size-full object-cover" />
                      <div className="absolute inset-x-0 bottom-0 bg-background/85 px-1 py-0.5 text-[11px] leading-tight">
                        {p.state === 'uploading' ? <span className="inline-flex items-center gap-1"><Loader2 className="size-3 animate-spin" />Đang tải</span>
                          : p.state === 'error' ? <span className="text-status-danger">{p.error ?? 'Lỗi'}</span> : 'Đã tải'}
                      </div>
                      <button type="button" onClick={() => removePhoto(p.id)} aria-label={`Bỏ ${p.name}`} disabled={p.state === 'uploading'}
                        className="absolute top-0 right-0 flex size-[44px] items-start justify-end p-1">
                        <span className="rounded-full bg-background/90 p-0.5 shadow"><X className="size-4" /></span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {photos.length < CARE_PROOF_MAX && (
                <>
                  <input ref={fileRef} id="care-proof-input" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple className="sr-only"
                    onChange={(e) => void addFiles(e.target.files)} />
                  <button type="button" onClick={() => fileRef.current?.click()}
                    className="flex size-[84px] flex-col items-center justify-center gap-1 rounded-care-ctl border-[1.5px] border-dashed border-care-line-strong bg-card text-xs font-medium text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-muted">
                    <ImagePlus className="size-[22px]" aria-hidden /> Thêm ảnh
                  </button>
                </>
              )}
            </div>
          )}
          {photos.some((p) => p.state === 'error') && (
            <p className="px-1 text-xs text-muted-foreground">Ảnh lỗi sẽ không được gửi — có thể bỏ ảnh và vẫn lưu lượt chăm sóc.</p>
          )}
        </div>

        {fieldError && <p role="alert" className="text-sm text-status-danger">{fieldError}</p>}
        {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
      </div>

      <StickyActionBar className="mx-0 mt-auto border-care-line bg-card px-4 pt-2.5 pb-[calc(12px+env(safe-area-inset-bottom))] backdrop-blur-none"
        hint={missing.length > 0 && !busy ? `Còn thiếu: ${missing.join(', ')}` : undefined}>
        <Button type="submit" disabled={busy || uploading}
          className="min-h-[50px] w-full rounded-care-ctl bg-care-cta text-[16px] font-semibold text-care-cta-foreground hover:bg-care-cta/90 md:min-h-[44px] md:text-sm">
          {busy && <Loader2 className="size-4 animate-spin" />} {uploading ? 'Đang tải ảnh…' : 'Lưu lượt chăm sóc'}
        </Button>
      </StickyActionBar>
    </form>
  )
}
