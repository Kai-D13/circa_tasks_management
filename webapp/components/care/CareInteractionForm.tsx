'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ImagePlus, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { CARE_OUTCOMES, CARE_OUTCOME_META, type CareOutcome } from '@/lib/care/outcome'
import { CARE_NOTE_MAX, CARE_PROOF_MAX, CARE_PROOF_MAX_BYTES, CARE_RECORD_MESSAGES, isCareProofMime, validateInteractionInput } from '@/lib/care/my'
import { cn } from '@/lib/utils'
import { uploadViaGcs } from '@/lib/storage/uploadClient'

// Form ghi một lượt chăm sóc (SPEC B4 §3). Sáu outcome từ lib/care/outcome.ts; ghi chú
// 1–500 bắt buộc; UNREACHABLE/CALLBACK bắt buộc ngày hẹn hôm nay..hết tháng task (giờ VN);
// outcome kết thúc không nhận ngày. Ảnh TÙY CHỌN (≤5), upload lỗi vẫn cho bỏ ảnh và lưu.
// Chống gửi đôi bằng ref; RPC lỗi ⇒ giữ nguyên nội dung form. Server/RPC 114 quyết cuối.

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
        router.push(doneHref)
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

  return (
    <form onSubmit={submit} className="space-y-5" data-testid="care-interaction-form" noValidate>
      <p className="text-sm text-muted-foreground">Khách: <span className="font-medium text-foreground">{customerName}</span></p>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">Kết quả chăm sóc</legend>
        <div className="grid gap-2" role="radiogroup" aria-label="Kết quả chăm sóc">
          {CARE_OUTCOMES.map((o) => {
            const m = CARE_OUTCOME_META[o]
            const active = outcome === o
            return (
              <label key={o} className={cn('flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm',
                active && 'border-primary bg-primary/5')}>
                <input type="radio" name="outcome" value={o} checked={active} className="size-5 accent-[var(--primary)]"
                  onChange={() => { setOutcome(o); setFieldError(null); if (!m.requiresNextActionDate) setDate('') }} />
                <span className="flex-1">{m.label}</span>
                {m.terminal ? <StatusBadge tone="success">Kết thúc</StatusBadge> : <StatusBadge tone="info">Hẹn lại</StatusBadge>}
              </label>
            )
          })}
        </div>
      </fieldset>

      {meta?.requiresNextActionDate && (
        <div className="space-y-1">
          <label htmlFor="care-next-date" className="text-sm font-medium">Ngày hẹn chăm sóc lại (bắt buộc)</label>
          <Input id="care-next-date" type="date" min={todayISO} max={dueDate} value={date} onChange={(e) => setDate(e.target.value)}
            className="h-[44px] text-[16px] md:text-sm" />
          <p className="text-xs text-muted-foreground">Từ hôm nay đến hết tháng ({dueDate.slice(8, 10)}/{dueDate.slice(5, 7)}).</p>
        </div>
      )}
      {meta?.recordsStoreRefusal && (
        <p className="rounded-lg border border-status-warning/40 bg-status-warning-bg p-3 text-sm" role="note">
          Khách từ chối sẽ không được giao chăm sóc lại tại cửa hàng này.
        </p>
      )}

      <div className="space-y-1">
        <label htmlFor="care-note" className="text-sm font-medium">Ghi chú (bắt buộc)</label>
        <Textarea id="care-note" rows={4} maxLength={CARE_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)}
          className="text-[16px] md:text-sm" placeholder="Nội dung trao đổi với khách…" />
        <p className="text-right text-xs text-muted-foreground">{note.trim().length}/{CARE_NOTE_MAX}</p>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Ảnh minh chứng <span className="font-normal text-muted-foreground">(không bắt buộc, tối đa {CARE_PROOF_MAX})</span></p>
        {photos.length > 0 && (
          <ul className="grid grid-cols-3 gap-2" aria-label="Ảnh đã chọn">
            {photos.map((p) => (
              <li key={p.id} className="relative overflow-hidden rounded-lg border bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element -- preview cục bộ (blob:) */}
                <img src={p.preview} alt={p.name} className="aspect-square w-full object-cover" />
                <div className="absolute inset-x-0 bottom-0 bg-background/85 px-1 py-0.5 text-[11px]">
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
        {proofDisabled && (
          <p className="rounded-lg border border-status-warning/40 bg-status-warning-bg p-3 text-sm" role="note">
            Chế độ QA: không tải ảnh minh chứng — lượt chăm sóc vẫn lưu bình thường.
          </p>
        )}
        {!proofDisabled && photos.length < CARE_PROOF_MAX && (
          <>
            <input ref={fileRef} id="care-proof-input" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple className="sr-only"
              onChange={(e) => void addFiles(e.target.files)} />
            <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => fileRef.current?.click()}>
              <ImagePlus className="size-4" /> Thêm ảnh
            </Button>
          </>
        )}
        <p className="text-xs text-muted-foreground">Chỉ chụp đủ để minh chứng việc liên hệ; tránh chụp CCCD, đơn thuốc hay thông tin sức khoẻ không cần thiết.</p>
        {photos.some((p) => p.state === 'error') && (
          <p className="text-xs text-muted-foreground">Ảnh lỗi sẽ không được gửi — có thể bỏ ảnh và vẫn lưu lượt chăm sóc.</p>
        )}
      </div>

      {fieldError && <p role="alert" className="text-sm text-status-danger">{fieldError}</p>}
      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}

      <Button type="submit" className="min-h-[44px] w-full" disabled={busy || uploading}>
        {busy && <Loader2 className="size-4 animate-spin" />} {uploading ? 'Đang tải ảnh…' : 'Lưu lượt chăm sóc'}
      </Button>
    </form>
  )
}
