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
import { cn } from '@/lib/utils'
import { cmsFileSize } from '@/lib/cms/display'
import {
  CMS_IMPORT_CHECKS, CMS_IMPORT_COLUMN_HELP, CMS_REUPLOAD_CODES, cmsCommitLabel, type CmsPreviewResult, type CmsRouteError,
} from '@/lib/cms/importView'

// CMS P1-c — A2 bước 2–4 + /[id]/import (UI §3.2; r2 U4 / U16; SPEC §4.5–§4.7). Hai bước qua Route Handler P1-b:
//   (1) "Chạy xử lý" = POST /api/cms/import/preview ⇒ lưu import run, hiện Kết quả (KHÔNG ghi danh mục);
//   (2) "Xác nhận ghi" = POST /api/cms/import/commit gửi lại CHÍNH file + run_id + sha256 ⇒ server parse lại; khác preview
//       ⇒ 409 ⇒ "Dữ liệu đã thay đổi — kiểm tra lại file", quay về Upload. Kích hoạt là bước riêng ở A3 (U6).
// "Hủy lần chạy" chỉ bỏ kết quả phía client (run previewed không được ghi) — KHÔNG huỷ chương trình (H8).
// Mọi request ghi / tải file lỗi hỏi useFixtureActionBlocked() trước (fixture /ui-catalog/cms-v2: 0 request ghi).

const MAX_FILE = 5 * 1024 * 1024
type Step = 'upload' | 'running' | 'result'
const RUN_STEPS = ['Đọc file và sheet IMPORT_CMS', 'Kiểm tra cột và kiểu ô', 'Tra Product Master', 'Kiểm tra nhóm và thang bậc', 'Kiểm tra trùng chương trình đang chạy']

function errorText(body: CmsRouteError | null): string {
  if (!body) return 'Máy chủ không phản hồi đúng — thử lại'
  const base = body.message ?? 'Không xử lý được file'
  return body.missing?.length ? `${base}: ${body.missing.join(', ')}` : base
}

export function CmsImportFlow({ program, mode, fromNew, fixture }: {
  program: { id: string; name: string }
  mode: 'replace' | 'append'
  fromNew: boolean
  /** Chỉ fixture /ui-catalog: bắt đầu ở bước / kết quả dựng sẵn. */
  fixture?: { step: Step; result?: CmsPreviewResult; fileName?: string; fileBytes?: number }
}) {
  const router = useRouter()
  const fixtureBlocked = useFixtureActionBlocked()
  const [step, setStep] = useState<Step>(fixture?.step ?? 'upload')
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<CmsPreviewResult | null>(fixture?.result ?? null)
  const [error, setError] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const fileName = file?.name ?? fixture?.fileName ?? null
  const fileBytes = file?.size ?? fixture?.fileBytes ?? null

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
    setStep('upload')
    if (!keepFile) setFile(null)
  }

  async function runPreview() {
    if (!file) return
    if (fixtureBlocked()) return
    setError(null)
    setStep('running')
    const ac = new AbortController()
    abort.current = ac
    const fd = new FormData()
    fd.append('program_id', program.id)
    fd.append('file', file)
    try {
      const res = await fetch('/api/cms/import/preview', { method: 'POST', body: fd, signal: ac.signal })
      const body = (await res.json().catch(() => null)) as CmsPreviewResult | CmsRouteError | null
      if (ac.signal.aborted) return
      if (!res.ok || !body || !body.ok) { setError(errorText(body as CmsRouteError | null)); setStep('upload'); return }
      setResult(body)
      setStep('result')
    } catch {
      if (ac.signal.aborted) return
      setError('Không kết nối được máy chủ — thử lại')
      setStep('upload')
    }
  }

  async function commit() {
    if (!result) return
    if (fixtureBlocked()) return
    if (!file) { setError('Chọn lại file để xác nhận ghi'); reset(false); return }
    setError(null)
    setCommitting(true)
    const fd = new FormData()
    fd.append('run_id', result.runId)
    fd.append('sha256', result.sha256)
    fd.append('file', file)
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

  return (
    <div data-cms-import-flow={step} className="space-y-4">
      <CmsStepper current={current} skipFirst={!fromNew} />
      <Notice tone="info">
        {mode === 'replace'
          ? 'Nạp toàn bộ: danh mục hiện có của chương trình sẽ được thay bằng các sản phẩm hợp lệ trong file.'
          : 'Chương trình đã bắt đầu: chỉ thêm sản phẩm mới (tính hồi tố từ ngày bắt đầu); sản phẩm đã có không sửa được.'}
      </Notice>
      {error && <Notice tone="danger" role="alert">{error}</Notice>}

      {step === 'upload' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-3">
            <label className="flex min-h-[160px] cursor-pointer flex-col items-center justify-center gap-2 rounded-v2-panel border border-dashed border-input bg-card p-6 text-center">
              <Upload aria-hidden="true" className="h-6 w-6 text-muted-foreground" />
              <span className="font-semibold">Chọn file .xlsx (sheet IMPORT_CMS)</span>
              <span className="text-[12px] text-muted-foreground">Tối đa 5 MiB · 2.000 dòng · 9 cột</span>
              <input
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                onChange={(e) => pick(e.target.files?.[0] ?? null)}
              />
            </label>
            <a href="/templates/Circa_Import_CMS.xlsx" download className="inline-flex min-h-[44px] items-center gap-1.5 text-[13px] font-medium underline-offset-2 hover:underline">
              <FileSpreadsheet className="h-4 w-4" /> Tải file mẫu (9 cột)
            </a>
            {fileName && (
              <div data-cms-file className="flex items-center gap-3 rounded-v2-panel border bg-card p-3">
                <FileSpreadsheet aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{fileName}</span>
                {fileBytes !== null && <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">{cmsFileSize(fileBytes)}</span>}
              </div>
            )}
            <div className="overflow-hidden rounded-v2-panel border bg-card">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-[13px]">
                  <thead className="bg-muted">
                    <tr className="text-left"><th className="pl-4 pr-3 py-2 text-[12px] font-medium text-muted-foreground">Cột</th><th className="pl-3 pr-4 py-2 text-[12px] font-medium text-muted-foreground">Ý nghĩa</th></tr>
                  </thead>
                  <tbody>
                    {CMS_IMPORT_COLUMN_HELP.map(([c, m]) => (
                      <tr key={c} className="border-t"><td className="pl-4 pr-3 py-2 font-mono text-[12px] whitespace-nowrap">{c}</td><td className="pl-3 pr-4 py-2 text-muted-foreground">{m}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div className="min-w-0 space-y-2 rounded-v2-panel border bg-card p-4">
            <p className="text-[13px] font-semibold">Hệ thống sẽ kiểm tra</p>
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
              {CMS_IMPORT_CHECKS.map((c) => <li key={c}>{c}</li>)}
            </ul>
            <p className="text-[12px] text-muted-foreground">Một dòng lỗi làm loại cả nhóm ProductID; nhóm hợp lệ khác vẫn được nạp.</p>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end lg:col-span-2">
            <Link href={`/targets/campaigns/cms/${program.id}`} className={cn(buttonVariants({ variant: 'ghost' }), 'h-[44px] md:h-[36px]')}>Quay lại</Link>
            <Button type="button" disabled={!file} onClick={runPreview} className="h-[44px] md:h-[36px] font-semibold">Chạy xử lý</Button>
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
            {RUN_STEPS.map((s, i) => (
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
          {result.groupsOk.length === 0 && (
            <Notice tone="warning">Không có sản phẩm hợp lệ để ghi — sửa file theo danh sách lỗi rồi kiểm tra lại.</Notice>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => reset(false)} disabled={committing} className="h-[44px] md:h-[36px]">Hủy lần chạy</Button>
            <Button type="button" variant="outline" onClick={() => reset(false)} disabled={committing} className="h-[44px] md:h-[36px]">Upload file khác</Button>
            {commitLabel && (
              <Button type="button" onClick={commit} disabled={committing} data-cms-commit={result.mode} className="h-[44px] md:h-[36px] font-semibold">
                {committing && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}{commitLabel}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
