'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowRight, CheckCircle2, FileSpreadsheet, Info, Loader2, Upload, X } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { ErrorState } from '@/components/ds/ErrorState'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { CareKpiTile } from '@/components/care/CareReportView'
import {
  CareImportAssign, CareImportChanges, CareImportCustomers, CareImportIssues, CareImportRequirements, CareImportStepper,
  INSET, PANEL, dateLabel, fmt, monthLabel,
} from '@/components/care/CareImportPanels'
import { CARE_ERROR_LABELS, type CareRowError, type CareRowErrorCode } from '@/lib/care/import/contract'
import type { CarePreview, CarePreviewCounts } from '@/lib/care/import/preview'
import { careAssignmentTable } from '@/lib/care/import/review'
import { CARE_QA_ISSUE_LABELS } from '@/lib/care/qa/labels'
import { cn } from '@/lib/utils'

// Wizard Phân công CRM (SPEC B2 §3; B8.3 theo artboard 11): Tải file → Kiểm tra → Phân công (chỉ xem) → Xác nhận.
// Preview CHỈ ĐỌC; commit gửi lại đúng file + sha256 + kỳ, server tính lại và RPC finalize (114) quyết định kết
// quả. Q-110: lỗi bất kỳ chặn CẢ file (không import phần hợp lệ), bảng lỗi có cột chỉ khi chắc chắn, không giá trị
// ô. Không dò gần đúng dược sĩ, không ghi chú lần import. Tên/SĐT chỉ hiện trên màn hình người có quyền import.

type PreviewPayload = Omit<CarePreview, 'errors'> & {
  errorCount: number
  errors: CareRowError[]
  /** Đếm theo mã trên TOÀN BỘ lỗi (server); danh sách chi tiết có thể bị cắt. */
  errorCounts?: Partial<Record<CareRowErrorCode, number>>
}
/** B6-qa-ui: chỉ có trên dev server QA local — server quyết file có được import (is_test) hay không. */
type QaInfo = { commitAllowed: boolean; issues: string[] }
type CommitResult =
  | { status: 'committed'; batch_id: string; idempotent?: boolean } & Partial<CarePreviewCounts>
  | { status: 'duplicate'; batch_id: string; duplicate_of: string }
  | { status: 'rejected'; batch_id: string; error_count: number; errors: CareRowError[] }

/** Chừa chỗ cho phần bao multipart khi so với trần byte của server. */
const MULTIPART_RESERVE = 64 * 1024

const SERVER_MESSAGES: Record<string, string> = {
  NOT_FOUND: 'Chức năng chưa được bật.',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết — đăng nhập lại.',
  FORBIDDEN: 'Tài khoản không có quyền import CRM.',
  UNAVAILABLE: 'Hệ thống CRM chưa sẵn sàng — báo quản trị.',
  LOOKUP_FAILED: 'Không đọc được dữ liệu đối chiếu — thử lại sau.',
  LENGTH_REQUIRED: 'Trình duyệt không gửi kích thước file — tải lại.',
  PAYLOAD_TOO_LARGE: 'File vượt dung lượng cho phép.',
  BODY_INCOMPLETE: 'File gửi lên không trọn vẹn — tải lại.',
  MULTIPART_INVALID: 'Dữ liệu gửi lên không hợp lệ — tải lại.',
  FILE_REQUIRED: 'Chọn đúng một file .csv.',
  FILE_TYPE: 'Chỉ nhận file CSV (.csv) — trong Excel chọn Lưu thành "CSV UTF-8 (Comma delimited)".',
  SHA_MISMATCH: 'File đã thay đổi so với lúc kiểm tra — kiểm tra lại.',
  PERIOD_CHANGED: 'Đã sang tháng mới so với lúc kiểm tra — kiểm tra lại để lấy kỳ mới.',
  HAS_ERRORS: 'File còn lỗi — sửa file rồi kiểm tra lại.',
  STAGING_FAILED: 'Không lưu được dữ liệu tạm — không có gì được ghi. Thử lại.',
  FINALIZE_FAILED: 'Import thất bại — không có task nào được tạo. Thử lại hoặc báo quản trị.',
}
const messageFor = (code: string | undefined) =>
  (code && (SERVER_MESSAGES[code] ?? (CARE_ERROR_LABELS as Record<string, string>)[code] ?? (CARE_QA_ISSUE_LABELS as Record<string, string>)[code]))
  || 'Có lỗi không xác định — thử lại.'

const sizeLabel = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB`)
const timeLabel = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })}`
const BTN = 'min-h-[44px] md:min-h-0'

export function CareImportWizard({ maxBytes, period, tasksHref = null }: {
  maxBytes: number
  /** Kỳ hiện tại (YYYY-MM-01, giờ VN) để mô tả bước trước khi có preview; kỳ thật do server tính khi kiểm tra. */
  period: string
  /** Link danh sách chăm sóc sau khi import — chỉ khi người dùng có quyền xem (phòng chỉ-import thì null). */
  tasksHref?: string | null
}) {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewPayload | null>(null)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [qa, setQa] = useState<QaInfo | null>(null)
  const [sha, setSha] = useState<string>('')
  const [result, setResult] = useState<CommitResult | null>(null)
  const [focusRow, setFocusRow] = useState<number | null>(null)
  const committing = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // PM B8.3 R1-01: mỗi lần chọn/bỏ file hoặc gửi kiểm tra là một "thế hệ" mới. Phản hồi preview chỉ được áp dụng
  // (preview/sha/QA/bước/lỗi/busy) khi vẫn đúng thế hệ đã gửi; request cũ bị huỷ và nếu về muộn thì bỏ qua.
  const gen = useRef(0)
  const inflight = useRef<AbortController | null>(null)
  const invalidate = () => { gen.current++; inflight.current?.abort(); inflight.current = null }
  const fileLimit = maxBytes - MULTIPART_RESERVE
  const limitLabel = `${(fileLimit / 1048576).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB`

  const reset = () => {
    invalidate()
    setStep(0); setFile(null); setPreview(null); setQa(null); setSha(''); setResult(null); setError(null); setFocusRow(null); setCheckedAt(null); setBusy(false)
    if (inputRef.current) inputRef.current.value = ''
  }
  const choose = (f: File | null) => {
    invalidate()
    setFile(f); setPreview(null); setResult(null); setFocusRow(null); setBusy(false)
    setError(f && f.size > fileLimit ? `File ${sizeLabel(f.size)} vượt giới hạn ${limitLabel}.` : null)
  }

  async function runPreview() {
    if (!file) return
    if (file.size > fileLimit) { setError(`File ${sizeLabel(file.size)} vượt giới hạn ${limitLabel}.`); return }
    invalidate()
    const my = gen.current
    const ctl = new AbortController()
    inflight.current = ctl
    setBusy(true); setError(null); setResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/care/import/preview', { method: 'POST', body: fd, signal: ctl.signal })
      const body = await res.json().catch(() => null)
      if (my !== gen.current) return
      if (!res.ok || !body?.ok) { setError(messageFor(body?.code)); return }
      setPreview(body.preview); setQa(body.qa ?? null); setSha(body.sha256); setFocusRow(null); setCheckedAt(new Date()); setStep(1)
    } catch {
      if (my !== gen.current) return
      setError('Không gửi được file — kiểm tra mạng rồi thử lại.')
    } finally {
      if (my === gen.current) { inflight.current = null; setBusy(false) }
    }
  }

  async function runCommit() {
    if (!file || !preview || committing.current || preview.errorCount > 0 || (qa && !qa.commitAllowed)) return
    committing.current = true
    setBusy(true); setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('sha256', sha)
      fd.append('period', preview.period)
      const res = await fetch('/api/care/import/commit', { method: 'POST', body: fd })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.ok) {
        if (body?.code === 'HAS_ERRORS' && Array.isArray(body.errors)) {
          setPreview({ ...preview, errorCount: body.errorCount ?? body.errors.length, errors: body.errors, errorCounts: body.errorCounts }); setStep(1)
        }
        setError(messageFor(body?.code))
        return
      }
      setResult(body.result)
      router.refresh()
    } catch {
      setError('Không gửi được yêu cầu — kiểm tra lịch sử import trước khi thử lại để tránh nạp hai lần.')
    } finally {
      committing.current = false
      setBusy(false)
    }
  }

  const hasErrors = (preview?.errorCount ?? 0) > 0
  const qaBlocked = qa !== null && !qa.commitAllowed
  const committed = result?.status === 'committed'
  const assign = preview && step >= 2 ? careAssignmentTable(preview.customers) : null
  const steps = [
    { label: 'Tải file', desc: file ? file.name : 'CSV UTF-8 theo mẫu' },
    { label: 'Kiểm tra dữ liệu', desc: preview ? `${fmt(preview.customerCount)} khách · ${hasErrors ? `${fmt(preview.errorCount)} lỗi` : 'không lỗi'}` : 'Lỗi bất kỳ chặn cả file' },
    { label: 'Phân công', desc: 'Dược sĩ theo email trong file' },
    { label: 'Xác nhận', desc: `Tạo task kỳ ${monthLabel(preview?.period ?? period)}` },
  ]

  return (
    <section className={cn(PANEL, 'overflow-hidden')} data-testid="care-import-wizard">
      <CareImportStepper steps={steps} step={step} allDone={committed} canGo={!busy && !result} onGo={(i) => { setStep(i); setError(null) }} />

      <div className="space-y-4 p-4 md:p-5">
        {error && <ErrorState message={error} />}

        {step === 0 && (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="flex flex-col gap-3">
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv"
                aria-label="Chọn file CSV"
                className="sr-only"
                tabIndex={-1}
                onChange={(e) => choose(e.target.files?.[0] ?? null)}
              />
              {!file ? (
                <div
                  data-testid="care-import-dropzone"
                  data-dragging={dragging || undefined}
                  onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files?.[0] ?? null) }}
                  className={cn('flex min-h-[220px] flex-col items-center justify-center gap-2.5 rounded-lg border-[1.5px] border-dashed p-6 text-center transition-colors',
                    dragging ? 'border-primary bg-primary/5' : 'border-care-line-strong bg-care-surface')}
                >
                  <span className="flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary"><Upload className="size-5" aria-hidden /></span>
                  <p className="text-[15px] font-semibold">Kéo thả file CSV vào đây</p>
                  <p className="text-sm text-muted-foreground">.csv UTF-8 · dấu phẩy · tối đa {limitLabel}</p>
                  <Button variant="outline" className={cn(BTN, 'mt-1')} onClick={() => inputRef.current?.click()}>Chọn file từ máy</Button>
                </div>
              ) : (
                <div className={cn(INSET, 'flex items-center gap-3.5 p-4')} data-testid="care-import-file">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-status-success-bg text-status-success"><FileSpreadsheet className="size-5" aria-hidden /></span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-semibold" title={file.name}>{file.name}</span>
                    <span className="text-xs text-muted-foreground">{sizeLabel(file.size)} · CSV</span>
                  </span>
                  <Button variant="ghost" size="icon" className="size-[44px] shrink-0" aria-label="Bỏ file" onClick={reset}><X className="size-4" /></Button>
                </div>
              )}
              <div className="flex justify-end">
                <Button className={BTN} disabled={!file || busy || file.size > fileLimit} onClick={runPreview}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null} Kiểm tra file {!busy && <ArrowRight className="size-4" />}
                </Button>
              </div>
            </div>
            <CareImportRequirements />
          </div>
        )}

        {step === 1 && preview && (
          <div className="space-y-4">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <FileSpreadsheet className="size-4" aria-hidden />
              {file && <span className="max-w-[260px] truncate font-medium text-foreground" title={file.name}>{file.name}</span>}
              {checkedAt && <span>· kiểm tra lúc {timeLabel(checkedAt)}</span>}
              <span>· kỳ dự kiến <strong className="text-foreground">{monthLabel(preview.period)}</strong>, hạn <strong className="text-foreground">{dateLabel(preview.dueDate)}</strong></span>
            </p>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <CareKpiTile label="Dòng trong file" value={fmt(preview.rowCount)} hint="dòng sản phẩm" />
              <CareKpiTile label="Khách (task)" value={fmt(preview.customerCount)} hint="gộp theo mã khách" />
              <CareKpiTile label="Cửa hàng trong file" value={`${fmt(preview.storeCodesInFile)}/${fmt(preview.activeOsStoreCount)}`}
                hint="so với cửa hàng OS đang hoạt động" dot={preview.activeOsStoresMissing.length ? 'bg-status-warning' : undefined} />
              <CareKpiTile label="Lỗi" value={fmt(preview.errorCount)} hint={hasErrors ? 'chặn cả file' : 'không có lỗi'}
                dot={hasErrors ? 'bg-status-danger' : 'bg-status-success'} />
            </div>
            {qa && (
              <p role="note" data-testid="care-import-qa" className="rounded-lg border border-status-warning/40 bg-status-warning-bg p-3 text-sm">
                {qa.commitAllowed ? 'Chế độ QA: đúng bản QA đã chuẩn bị — import sẽ ghi dữ liệu thử nghiệm (is_test).' : messageFor(qa.issues[0])}
              </p>
            )}
            {preview.activeOsStoresMissing.length > 0 && (
              // B7-ui: danh sách mã có thể dài (tới ~25) ⇒ thu gọn, mở xem khi cần.
              <details className="rounded-lg border border-care-line bg-card px-3 text-sm">
                <summary className="flex min-h-[44px] cursor-pointer flex-wrap items-center gap-2 md:min-h-10">
                  <StatusBadge tone="warning">{fmt(preview.activeOsStoresMissing.length)} cửa hàng OS không có khách trong file</StatusBadge>
                  <span className="text-xs text-muted-foreground">Xem danh sách mã</span>
                </summary>
                <p className="max-h-32 overflow-y-auto pb-3 text-muted-foreground">{preview.activeOsStoresMissing.map((s) => s.code).join(', ')}</p>
              </details>
            )}
            {hasErrors && (
              <>
                <div role="alert" data-testid="care-import-blocked" className="flex gap-2.5 rounded-lg border border-status-danger/40 bg-status-danger-bg p-3 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-danger" aria-hidden />
                  <span>
                    File còn <b>{fmt(preview.errorCount)} lỗi</b> — <b>không import được phần nào</b>, kể cả các dòng hợp lệ.
                    Sửa file gốc theo bảng dưới rồi chọn lại file để kiểm tra.
                  </span>
                </div>
                <CareImportIssues errors={preview.errors} total={preview.errorCount} counts={preview.errorCounts} onPick={setFocusRow} />
              </>
            )}
            <CareImportCustomers customers={preview.customers} focusRow={focusRow} onClearFocus={() => setFocusRow(null)} />
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="outline" className={BTN} onClick={reset}>{hasErrors ? 'Chọn file đã sửa' : 'Chọn file khác'}</Button>
              <Button className={BTN} disabled={hasErrors} onClick={() => setStep(2)}>
                {hasErrors ? 'Sửa file rồi kiểm tra lại' : <>Tiếp: xem phân công <ArrowRight className="size-4" /></>}
              </Button>
            </div>
          </div>
        )}

        {step === 2 && preview && (
          <div className="space-y-4">
            <CareImportAssign customers={preview.customers} />
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="outline" className={BTN} onClick={() => setStep(1)}>Quay lại kiểm tra</Button>
              <Button className={BTN} onClick={() => setStep(3)}>Tiếp: xác nhận <ArrowRight className="size-4" /></Button>
            </div>
          </div>
        )}

        {step === 3 && preview && !result && (
          <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <section aria-label="Tóm tắt" className={cn(INSET, 'space-y-3 p-4')}>
                <h3 className="text-sm font-semibold">Tóm tắt</h3>
                <dl className="grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Kỳ</dt><dd className="font-medium">Tháng {monthLabel(preview.period)}</dd>
                  <dt className="text-muted-foreground">Hạn chăm sóc</dt><dd className="font-medium">{dateLabel(preview.dueDate)} (cuối kỳ, giờ VN)</dd>
                  <dt className="text-muted-foreground">Cửa hàng</dt>
                  <dd className="font-medium">
                    {fmt(preview.storeCodesInFile)} cửa hàng
                    {preview.activeOsStoresMissing.length > 0 && <span className="font-normal text-muted-foreground"> · {fmt(preview.activeOsStoresMissing.length)} cửa hàng OS không có khách</span>}
                  </dd>
                  <dt className="text-muted-foreground">Dược sĩ nhận</dt><dd className="font-medium">{fmt(assign?.assignees ?? 0)} dược sĩ</dd>
                  <dt className="text-muted-foreground">File</dt><dd className="font-medium">{fmt(preview.rowCount)} dòng · {fmt(preview.customerCount)} khách</dd>
                </dl>
              </section>
              <CareImportChanges counts={preview.counts} />
            </div>
            <p className="flex gap-2.5 rounded-lg border border-status-info/30 bg-status-info-bg p-3 text-sm">
              <Info className="mt-0.5 size-4 shrink-0 text-status-info" aria-hidden />
              <span>
                Sau khi xác nhận, dược sĩ thấy khách mới trong mục Chăm sóc khách hàng trên app. Khách đã có lượt chăm sóc trong kỳ được giữ nguyên.
                Số liệu trên là dự kiến — hệ thống kiểm lại khi ghi; phát sinh lỗi thì không task nào được ghi.
              </span>
            </p>
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="outline" className={BTN} disabled={busy} onClick={() => setStep(2)}>Quay lại phân công</Button>
              <Button className={BTN} disabled={busy || hasErrors || qaBlocked} onClick={runCommit}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Xác nhận import {fmt(preview.customerCount)} khách
              </Button>
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-3" data-testid="care-import-result">
            {result.status === 'committed' && (
              <div className="flex flex-col items-center gap-2.5 py-6 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-status-success-bg text-status-success"><CheckCircle2 className="size-6" aria-hidden /></span>
                <p className="text-lg font-bold">
                  {result.idempotent ? 'File này đã được import trước đó' : <>Đã import file cho kỳ {preview ? monthLabel(preview.period) : ''}</>}
                </p>
                <p className="text-sm text-muted-foreground">
                  Tạo mới <strong className="text-foreground">{fmt(result.created ?? 0)}</strong> · cập nhật <strong className="text-foreground">{fmt(result.updated ?? 0)}</strong> ·
                  không đổi <strong className="text-foreground">{fmt(result.unchanged ?? 0)}</strong> · giữ nguyên vì đã có lượt <strong className="text-foreground">{fmt(result.skipped_has_interaction ?? 0)}</strong> ·
                  đóng task kỳ trước <strong className="text-foreground">{fmt(result.closed_previous_period ?? 0)}</strong>
                  {preview && <> · hạn {dateLabel(preview.dueDate)}</>}.
                </p>
                {preview && (result.created !== preview.counts.created || result.updated !== preview.counts.updated) && (
                  <p className="text-sm text-muted-foreground">
                    Kết quả thực tế khác bản kiểm tra vì dữ liệu đã thay đổi trong lúc chờ (vd. dược sĩ vừa ghi lượt chăm sóc).
                  </p>
                )}
                <div className="mt-1 flex flex-wrap justify-center gap-2">
                  {tasksHref && <Link href={tasksHref} className={cn(buttonVariants(), BTN)}>Xem danh sách chăm sóc</Link>}
                  <Button variant="outline" className={BTN} onClick={reset}>Import file khác</Button>
                </div>
              </div>
            )}
            {result.status === 'duplicate' && (
              <>
                <StatusBadge tone="neutral" size="md">Không tạo task mới</StatusBadge>
                <p className="text-sm">File giống hệt đã được import trong kỳ này — hệ thống không tạo hay sửa task nào.</p>
              </>
            )}
            {result.status === 'rejected' && (
              <>
                <StatusBadge tone="danger" size="md">Bị từ chối — không có task nào được ghi</StatusBadge>
                <p className="text-sm">Dữ liệu đã thay đổi sau khi kiểm tra (vd. khách vừa từ chối chăm sóc). Sửa file theo các lỗi dưới đây rồi import lại.</p>
                <CareImportIssues errors={result.errors} total={result.error_count} />
              </>
            )}
            {result.status !== 'committed' && (
              <div className="flex justify-end">
                <Button variant="outline" className={BTN} onClick={reset}>Import file khác</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
