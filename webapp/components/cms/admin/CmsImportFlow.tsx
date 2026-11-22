'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Circle, FileSpreadsheet, Loader2, Upload } from 'lucide-react'
import { useFixtureActionBlocked } from '@/components/kpi/KpiFixtureBoundary'
import { Notice } from '@/components/ds/Notice'
import { Button, buttonVariants } from '@/components/ui/button'
import { CmsStepper } from '@/components/cms/admin/CmsStepper'
import { CmsImportResult } from '@/components/cms/admin/CmsImportResult'
import { CmsKCheckPanel } from '@/components/cms/admin/CmsKCheckPanel'
import { CmsImportCommitSummary } from '@/components/cms/admin/CmsImportCommitSummary'
import { cn } from '@/lib/utils'
import { cmsFileSize } from '@/lib/cms/display'
import {
  CMS_IMPORT_CHECKS, CMS_IMPORT_COLUMN_HELP, CMS_REUPLOAD_CODES, CMS_SIMPLE_CHECKS, CMS_SIMPLE_COLUMN_HELP, cmsCommitLabel,
  type CmsPreviewResult, type CmsRouteError,
} from '@/lib/cms/importView'
import {
  cmsCommitGate, cmsImportPlan, cmsKAckPayload, cmsKDirty, cmsKNotApplied, cmsKPending, type CmsKAckDraft, type CmsKAckPayloadItem,
} from '@/lib/cms/kAckPlan'
import { CmsBasisBadges } from '@/components/cms/CmsBasisBadges'
import type { CmsProgramBasis } from '@/lib/cms/calc/basisUi'

// CMS P1-c — A2 bước 2–4 + /[id]/import (UI §3.2; r2 U4 / U16; SPEC §4.5–§4.7). Hai bước qua Route Handler P1-b:
//   (1) "Chạy xử lý" = POST /api/cms/import/preview ⇒ lưu import run, hiện Kết quả (KHÔNG ghi danh mục);
//   (2) "Xác nhận ghi" = POST /api/cms/import/commit gửi lại CHÍNH file + run_id + sha256 ⇒ server parse lại; khác preview
//       ⇒ 409 ⇒ "Dữ liệu đã thay đổi — kiểm tra lại file", quay về Upload. Kích hoạt là bước riêng ở A3 (U6).
// "Hủy lần chạy" chỉ bỏ kết quả phía client (run previewed không được ghi) — KHÔNG huỷ chương trình (H8).
// Mọi request ghi / tải file lỗi hỏi useFixtureActionBlocked() trước (fixture /ui-catalog/cms-v2: 0 request ghi).
// CMS đơn giản S1 / S2 (PM r1 08/11 §4–§5; chỉ khi `v2` = cờ CMS_IMPORT_V2_ENABLED): chọn TƯỜNG MINH loại file (9 cột nhiều bậc /
// 7 cột mức cố định) — server parse + kiểm theo loại đã lưu trong lần kiểm, commit không nhận loại khác; bảng kiểm K + xác nhận tay
// (gửi lại preview kèm ý định, server gắn người / giờ). v2 OFF ⇒ request y như trước (không gửi format / k_acks).
// UX-KACK-1 (PM 15/11 §4): còn ý định xác nhận K đã tick mà preview chưa nhận lại ⇒ KHOÁ nút ghi (không ghi preview cũ); gửi lại lỗi /
// hết giờ GIỮ nguyên nháp (vẫn khoá); gửi lại thành công ⇒ nháp bỏ, báo ý định server không gắn được. Ghi một phần ⇒ phải tick xác nhận
// đúng số SP bị bỏ (theo kết quả server) trước khi nút ghi mở. Server commit vẫn tự kiểm (không đổi hợp đồng).
// CMS-IMPORT-UI-1 (PM 22/11 §3.3–§3.4): Upload = cột thao tác (loại file, chọn file, tên / kích thước, file mẫu) 2 phần | cột hướng dẫn
// (cấu trúc cột + các kiểm tra) 1 phần khi nội dung khung ≥ 960px, xếp dọc bên dưới; Kết quả không có cột hướng dẫn — bảng dùng toàn
// chiều ngang, tóm tắt trước khi ghi nằm sát nút ghi. Chỉ đổi bố cục; không thêm request.

const MAX_FILE = 5 * 1024 * 1024
type Step = 'upload' | 'running' | 'result'
const RUN_STEPS = ['Đọc file và sheet IMPORT_CMS', 'Kiểm tra cột và kiểu ô', 'Tra Product Master', 'Kiểm tra nhóm và thang bậc', 'Kiểm tra trùng chương trình đang chạy']
const RUN_STEPS_SIMPLE = ['Đọc file mức cố định (sheet đầu tiên)', 'Kiểm tra 7 cột và kiểu ô', 'Tra Product Master', 'Kiểm tra mỗi sản phẩm một mức', 'Kiểm tra trùng chương trình đang chạy']
type Format = 'tiers' | 'simple'
// Hạn chờ "Kiểm tra lại với xác nhận" phía client: > hạn đọc nguồn bán của server (CMS_BQ_DEFAULT_DEADLINE_MS 120 s) + đọc / kiểm file.
const RECHECK_TIMEOUT_MS = 180_000
const RECHECK_TIMEOUT_TEXT = 'Kiểm tra lại quá thời gian chờ — xác nhận đã tick vẫn giữ, thử lại sau'

function errorText(body: CmsRouteError | null): string {
  if (!body) return 'Máy chủ không phản hồi đúng — thử lại'
  const base = body.message ?? 'Không xử lý được file'
  if (body.missing?.length) return `${base}: ${body.missing.join(', ')}`
  if (body.column) return `${base} (cột "${body.column}")`
  return body.duplicate?.length ? `${base}: ${body.duplicate.join(', ')}` : base
}

export function CmsImportFlow({ program, mode, fromNew, fixture, v2 = false, basis }: {
  program: { id: string; name: string }
  /** CMS-CALC-RET-2 P5.1: cách tính của chương trình (undefined = DB trước 130 ⇒ không hiện; null = không đọc được). */
  basis?: CmsProgramBasis | null
  mode: 'replace' | 'append'
  fromNew: boolean
  /**
   * Chỉ fixture /ui-catalog: bắt đầu ở bước / kết quả dựng sẵn. `recheck` (UX-KACK-1): MÔ PHỎNG kết quả "Kiểm tra lại với xác nhận"
   * SAU khi useFixtureActionBlocked đã chặn (0 request) — lỗi HTTP / mất kết nối / thành công với kết quả dựng sẵn — để kiểm luồng
   * giữ / bỏ nháp. Route thật không truyền.
   */
  fixture?: {
    step: Step; result?: CmsPreviewResult; fileName?: string; fileBytes?: number; format?: Format
    recheck?: { kind: 'http-error' } | { kind: 'network' } | { kind: 'timeout' } | { kind: 'ok'; result: CmsPreviewResult }
    /** F-B: lỗi route dựng sẵn (vd. WRONG_FORMAT) — hiện như phản hồi lỗi thật ở bước tải file. */
    error?: CmsRouteError
  }
  /** Cờ CMS_IMPORT_V2_ENABLED (server quyết; page truyền xuống). */
  v2?: boolean
}) {
  const router = useRouter()
  const fixtureBlocked = useFixtureActionBlocked()
  const [step, setStep] = useState<Step>(fixture?.step ?? 'upload')
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<CmsPreviewResult | null>(fixture?.result ?? null)
  const [error, setError] = useState<string | null>(fixture?.error ? errorText(fixture.error) : null)
  const [committing, setCommitting] = useState(false)
  const [format, setFormat] = useState<Format>(fixture?.format ?? fixture?.result?.format ?? 'tiers')
  const [drafts, setDrafts] = useState<CmsKAckDraft>({})
  const [rechecking, setRechecking] = useState(false)
  // Xác nhận "U SP sẽ không được ghi" — gắn với MỘT kết quả preview (mỗi preview mới ⇒ phải xác nhận lại).
  const [partialConfirmed, setPartialConfirmed] = useState(false)
  // Ý định đã gửi ở lần kiểm tra lại gần nhất mà server không gắn được (null = chưa gửi lại).
  const [notApplied, setNotApplied] = useState<string[] | null>(null)
  const abort = useRef<AbortController | null>(null)
  const fileName = file?.name ?? fixture?.fileName ?? null
  const fileBytes = file?.size ?? fixture?.fileBytes ?? null
  // P5.1: nháp chưa chọn cách tính ⇒ không chạy xử lý (route cũng trả 409 BASIS_NOT_SET).
  const basisPending = basis !== undefined && basis !== null && basis.basis === null

  function pick(f: File | null) {
    setError(null)
    if (!f) { setFile(null); return }
    if (!/\.xlsx$/i.test(f.name)) { setError('Chỉ nhận file .xlsx'); setFile(null); return }
    if (f.size > MAX_FILE) { setError('File vượt 5 MiB'); setFile(null); return }
    setFile(f)
  }

  function reset(keepFile: boolean) {
    abort.current?.abort()
    setResult(null)
    setDrafts({})
    setPartialConfirmed(false)
    setNotApplied(null)
    setStep('upload')
    if (!keepFile) setFile(null)
  }

  function pickFormat(f: Format) {
    if (f === format) return
    setFormat(f)
    setResult(null)
    setDrafts({})
    setPartialConfirmed(false)
    setNotApplied(null)
  }

  /** Preview mới từ server ⇒ nháp / xác nhận ghi một phần của preview cũ không còn đúng (AC6). `sent` = ý định vừa gửi lại. */
  function acceptPreview(body: CmsPreviewResult, sent: CmsKAckPayloadItem[] | null) {
    setResult(body)
    setDrafts({})
    setPartialConfirmed(false)
    setNotApplied(sent ? cmsKNotApplied(sent, body) : null)
    setStep('result')
  }

  /** `withAcks`: gửi lại CHÍNH file kèm ý định xác nhận K (chỉ SP được phép xác nhận + có nguồn). Lỗi ⇒ GIỮ nháp (nút ghi vẫn khoá). */
  async function runPreview(withAcks = false) {
    const sent = v2 && withAcks && result?.kCheck ? cmsKAckPayload(result.kCheck.products, drafts) : null
    if (fixtureBlocked()) {
      const sim = withAcks ? fixture?.recheck : undefined
      if (sim?.kind === 'ok') acceptPreview(sim.result, sent)
      else if (sim?.kind === 'http-error') setError(errorText(null))
      else if (sim?.kind === 'network') setError('Không kết nối được máy chủ — thử lại')
      else if (sim?.kind === 'timeout') setError(RECHECK_TIMEOUT_TEXT)
      return
    }
    if (!file) { if (withAcks) setError('Chọn lại file để kiểm tra lại'); return }
    setError(null)
    if (withAcks) setRechecking(true); else setStep('running')
    const ac = new AbortController()
    abort.current = ac
    // Kiểm tra lại có hạn chờ phía client (nút Hủy / Upload khác bị khoá khi đang gửi): hết giờ ⇒ báo lỗi, GIỮ nháp (AC1).
    let timedOut = false
    const timer = withAcks ? setTimeout(() => { timedOut = true; ac.abort() }, RECHECK_TIMEOUT_MS) : null
    const fd = new FormData()
    fd.append('program_id', program.id)
    fd.append('file', file)
    if (v2) fd.append('format', format)
    if (sent) fd.append('k_acks', JSON.stringify(sent))
    try {
      const res = await fetch('/api/cms/import/preview', { method: 'POST', body: fd, signal: ac.signal })
      const body = (await res.json().catch(() => null)) as CmsPreviewResult | CmsRouteError | null
      if (timedOut) { setError(RECHECK_TIMEOUT_TEXT); return }
      if (ac.signal.aborted) return
      if (!res.ok || !body || !body.ok) { setError(errorText(body as CmsRouteError | null)); if (!withAcks) setStep('upload'); return }
      acceptPreview(body, sent)
    } catch {
      if (timedOut) { setError(RECHECK_TIMEOUT_TEXT); return }
      if (ac.signal.aborted) return
      setError('Không kết nối được máy chủ — thử lại')
      if (!withAcks) setStep('upload')
    } finally {
      if (timer) clearTimeout(timer)
      if (withAcks) setRechecking(false)
    }
  }

  async function commit() {
    if (!result) return
    // Phòng thủ (nút đã khoá): còn ý định chưa gửi / chưa xác nhận số SP bị bỏ ⇒ không ghi preview này.
    if (commitBlock !== 'NONE') return
    if (fixtureBlocked()) return
    if (!file) { setError('Chọn lại file để xác nhận ghi'); reset(false); return }
    setError(null)
    setCommitting(true)
    const fd = new FormData()
    fd.append('run_id', result.runId)
    fd.append('sha256', result.sha256)
    fd.append('file', file)
    if (v2) fd.append('format', result.format ?? 'tiers')
    try {
      const res = await fetch('/api/cms/import/commit', { method: 'POST', body: fd })
      const body = (await res.json().catch(() => null)) as ({ ok: true } | CmsRouteError | null)
      if (res.ok && body?.ok) {
        toast.success(result.mode === 'replace' ? 'Đã nạp danh mục' : 'Đã thêm sản phẩm')
        router.push(`/targets/campaigns/cms/${program.id}`)
        router.refresh()
        return
      }
      const err = body && !body.ok ? body : null
      if (err && CMS_REUPLOAD_CODES.has(err.code)) {
        setError('Dữ liệu đã thay đổi — kiểm tra lại file')
        reset(true)
      } else {
        setError(errorText(err))
      }
    } catch {
      setError('Không kết nối được máy chủ — thử lại')
    } finally {
      setCommitting(false)
    }
  }

  const current = step === 'upload' ? 1 : step === 'running' ? 2 : 3
  const commitLabel = result ? cmsCommitLabel(result.mode, result.groupsOk.length) : null
  const kRows = result?.kCheck?.products ?? []
  const plan = result ? cmsImportPlan(result) : null
  const pendingCount = (() => { const p = cmsKPending(kRows, drafts); return p.ready.length + p.incomplete.length })()
  const commitBlock = plan
    ? cmsCommitGate({ write: plan.write, skip: plan.skip, dirty: cmsKDirty(kRows, drafts), busy: committing || rechecking, partialConfirmed })
    : 'NOTHING'

  return (
    <div data-cms-import-flow={step} className="min-w-0 space-y-[16px]">
      <CmsStepper current={current} skipFirst={!fromNew} />
      <Notice tone="info">
        {mode === 'replace'
          ? 'Nạp toàn bộ: danh mục hiện có của chương trình sẽ được thay bằng các sản phẩm hợp lệ trong file.'
          : 'Chương trình đã bắt đầu: chỉ thêm sản phẩm mới (tính hồi tố từ ngày bắt đầu); sản phẩm đã có không sửa được.'}
      </Notice>
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
      {basis !== undefined && (
        <div data-cms-import-basis={basis?.basis ?? (basis ? 'pending' : 'unknown')} className="flex flex-wrap items-center gap-1.5 text-[13px]">
          <span className="text-muted-foreground">Cách tính của chương trình:</span>
          <CmsBasisBadges basis={basis} />
          {basis?.basis === 'cms_unit' && (
            <span className="basis-full text-[12px] text-muted-foreground">Tính nguyên: unit_CMS phải đúng tên đơn vị trên đơn bán (không phân biệt hoa thường). Loại file và cách tính độc lập nhau.</span>
          )}
        </div>
      )}
      {basis !== undefined && basis !== null && basis.basis === null && (
        <Notice tone="danger" role="alert" title="Chương trình chưa chọn cách tính">
          Mở <Link href={`/targets/campaigns/cms/${program.id}/edit`} className="inline-flex min-h-[44px] min-w-[44px] items-center underline md:inline md:min-h-0 md:min-w-0">Sửa thông tin</Link>, chọn cách tính rồi quay lại nạp file.
        </Notice>
      )}

      {step === 'upload' && (
        <div data-cms-upload-grid className="grid min-w-0 gap-[16px] md:gap-[24px] @min-[960px]/cms-wizard:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] @min-[960px]/cms-wizard:items-start">
          <div data-cms-upload-main className="min-w-0 space-y-3">
            {v2 && (
              <fieldset data-cms-import-format={format} className="space-y-1.5">
                <legend className="text-[13px] font-semibold">Loại file</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {([['simple', 'Mức cố định', 'Mỗi sản phẩm một mức CMS / đơn vị, không target (7 cột)'], ['tiers', 'Nhiều bậc / có target', 'Mẫu IMPORT_CMS 9 cột']] as const).map(([f, t, d]) => (
                    <label key={f} className={cn('flex min-h-[44px] cursor-pointer items-start gap-2.5 rounded-v2-control border bg-card p-3', format === f && 'border-v2-selected-line bg-accent')}>
                      <input type="radio" name="cms-import-format" value={f} checked={format === f} onChange={() => pickFormat(f)} className="mt-0.5 h-4 w-4" />
                      <span className="min-w-0"><span className="block text-[13px] font-semibold">{t}</span><span className="block text-[12px] text-muted-foreground">{d}</span></span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <label data-cms-file-pick className="flex min-h-[160px] cursor-pointer flex-col items-center justify-center gap-2 rounded-v2-panel border border-dashed border-input bg-card p-6 text-center hover:border-primary has-[:focus-visible]:border-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
              <Upload aria-hidden="true" className="h-6 w-6 text-muted-foreground" />
              <span className="font-semibold">{format === 'simple' ? 'Chọn file .xlsx mức cố định (sheet đầu tiên)' : 'Chọn file .xlsx (sheet IMPORT_CMS)'}</span>
              <span className="text-[12px] text-muted-foreground">{format === 'simple' ? 'Tối đa 5 MiB · 2.000 dòng · 7 cột + 2 cột bổ sung' : 'Tối đa 5 MiB · 2.000 dòng · 9 cột'}</span>
              <input
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                onChange={(e) => pick(e.target.files?.[0] ?? null)}
              />
            </label>
            {format === 'simple' ? (
              <a href="/templates/Circa_Import_CMS_muc_co_dinh.xlsx" download className="inline-flex min-h-[44px] items-center gap-1.5 text-[13px] font-medium underline-offset-2 hover:underline">
                <FileSpreadsheet className="h-4 w-4" /> Tải file mẫu mức cố định
              </a>
            ) : (
              <a href="/templates/Circa_Import_CMS.xlsx" download className="inline-flex min-h-[44px] items-center gap-1.5 text-[13px] font-medium underline-offset-2 hover:underline">
                <FileSpreadsheet className="h-4 w-4" /> Tải file mẫu (9 cột)
              </a>
            )}
            {fileName && (
              <div data-cms-file className="flex items-start gap-3 rounded-v2-panel border bg-card p-3">
                <FileSpreadsheet aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 text-[13px] font-medium [overflow-wrap:anywhere]">{fileName}</span>
                {fileBytes !== null && <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">{cmsFileSize(fileBytes)}</span>}
              </div>
            )}
          </div>
          <div data-cms-upload-guide className="min-w-0 space-y-[16px]">
          <div className="min-w-0 space-y-2 rounded-v2-panel border bg-card p-4">
            <p className="text-[13px] font-semibold">Hệ thống sẽ kiểm tra</p>
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
              {(format === 'simple' ? CMS_SIMPLE_CHECKS : CMS_IMPORT_CHECKS).map((c) => <li key={c}>{c}</li>)}
              {v2 && <li>K (quy đổi đơn vị) đối chiếu với dữ liệu bán; chưa có bằng chứng ⇒ cần super xác nhận kèm nguồn</li>}
            </ul>
            <p className="text-[12px] text-muted-foreground">Một dòng lỗi làm loại cả nhóm ProductID; nhóm hợp lệ khác vẫn được nạp.</p>
          </div>
            <div className="overflow-hidden rounded-v2-panel border bg-card">
              <div className="overflow-x-auto">
                <table data-cms-column-help className="w-full min-w-[320px] text-[13px]">
                  <thead className="bg-muted">
                    <tr className="text-left"><th className="pl-4 pr-3 py-2 text-[12px] font-medium text-muted-foreground">Cột</th><th className="pl-3 pr-4 py-2 text-[12px] font-medium text-muted-foreground">Ý nghĩa</th></tr>
                  </thead>
                  <tbody>
                    {(format === 'simple' ? CMS_SIMPLE_COLUMN_HELP : CMS_IMPORT_COLUMN_HELP).map(([c, m]) => (
                      <tr key={c} className="border-t"><td className="pl-4 pr-3 py-2 align-top font-mono text-[12px] whitespace-nowrap">{c}</td><td className="pl-3 pr-4 py-2 text-muted-foreground">{m}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div data-cms-flow-actions className="flex flex-col gap-2 sm:flex-row sm:justify-end @min-[960px]/cms-wizard:col-span-2">
            <Link href={`/targets/campaigns/cms/${program.id}`} className={cn(buttonVariants({ variant: 'ghost' }), 'h-[44px] md:h-[36px]')}>Quay lại</Link>
            <Button type="button" disabled={!file || basisPending} onClick={() => runPreview(false)} className="h-[44px] md:h-[36px] font-semibold">Chạy xử lý</Button>
          </div>
        </div>
      )}

      {step === 'running' && (
        <div className="space-y-3 rounded-v2-panel border bg-card p-4 md:p-5">
          <div role="progressbar" aria-label="Đang kiểm tra file" aria-busy="true" className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-v2-series" />
          </div>
          <ul className="space-y-1.5 text-[13px]">
            {/* Một lần POST preview (không stream): bước đầu "đang chạy", các bước sau "chờ" — kết quả từng bước hiện ở Kết quả. */}
            {(format === 'simple' ? RUN_STEPS_SIMPLE : RUN_STEPS).map((s, i) => (
              <li key={s} data-cms-run-step={i === 0 ? 'running' : 'pending'} className={cn('flex items-center gap-2', i === 0 ? 'text-foreground' : 'text-muted-foreground')}>
                {i === 0 ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Circle aria-hidden="true" className="h-4 w-4" />}
                {s}<span className="sr-only">{i === 0 ? ' — đang chạy' : ' — chờ'}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={() => reset(true)} className="h-[44px] md:h-[36px]">Hủy lần chạy</Button>
          </div>
        </div>
      )}

      {step === 'result' && result && (
        <div className="space-y-4">
          <CmsImportResult result={result} />
          {notApplied !== null && notApplied.length > 0 && (
            <Notice tone="warning" role="status">
              <span data-cms-k-not-applied={notApplied.length}>
                {notApplied.length} xác nhận vừa gửi không được áp vì trạng thái K của sản phẩm đã đổi ở lần kiểm này: {notApplied.join(', ')}. Xem lại bảng Kiểm K.
              </span>
            </Notice>
          )}
          {result.kCheck && (
            <CmsKCheckPanel
              // Preview mới ⇒ dựng lại bảng: bộ lọc / nguồn chung / xác nhận áp của lần kiểm trước không mang sang (AC5 / AC6).
              key={result.runId}
              kCheck={result.kCheck}
              drafts={drafts}
              onDrafts={setDrafts}
              onRecheck={() => runPreview(true)}
              busy={rechecking || committing}
              otherErrorIds={plan?.ackableWithOtherErrors}
            />
          )}
          {plan && (
            <CmsImportCommitSummary
              plan={plan}
              mode={result.mode}
              block={commitBlock}
              pendingCount={pendingCount}
              partialConfirmed={partialConfirmed}
              onPartialConfirmed={setPartialConfirmed}
              hasKCheck={!!result.kCheck}
              busy={committing || rechecking}
            />
          )}
          <div data-cms-flow-actions className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => reset(false)} disabled={committing || rechecking} className="h-[44px] md:h-[36px]">Hủy lần chạy</Button>
            <Button type="button" variant="outline" onClick={() => reset(false)} disabled={committing || rechecking} className="h-[44px] md:h-[36px]">Upload file khác</Button>
            {commitLabel && (
              <Button
                type="button" onClick={commit} disabled={commitBlock !== 'NONE'} data-cms-commit={result.mode} data-cms-commit-block={commitBlock}
                className="h-[44px] md:h-[36px] font-semibold"
              >
                {committing && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}{commitLabel}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
