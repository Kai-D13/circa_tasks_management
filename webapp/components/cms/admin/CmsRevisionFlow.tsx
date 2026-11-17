'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { FileSpreadsheet, History, Loader2, Upload } from 'lucide-react'
import { useFixtureActionBlocked } from '@/components/kpi/KpiFixtureBoundary'
import { Notice } from '@/components/ds/Notice'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { Button, buttonVariants } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CmsImportIssueSummary } from '@/components/cms/admin/CmsImportIssueSummary'
import { CmsKCheckPanel } from '@/components/cms/admin/CmsKCheckPanel'
import { CmsRevisionDiffTable } from '@/components/cms/admin/CmsRevisionDiffTable'
import { CmsRevisionImpactPanel } from '@/components/cms/admin/CmsRevisionImpactPanel'
import { cn } from '@/lib/utils'
import { cmsDateTime, cmsFileSize } from '@/lib/cms/display'
import { cmsKAckPayload, cmsKDirty, type CmsKAckDraft } from '@/lib/cms/kAckPlan'
import { cmsRevisionReasonOk, type CmsRevisionCommitReply } from '@/lib/cms/revision/model'
import {
  CMS_REVISION_BLOCK_TEXT, cmsRevisionCommitGate, type CmsRevisionAnalysis, type CmsRevisionErrorBody, type CmsRevisionPreviewBody,
} from '@/lib/cms/revision/view'

// F-A (PM spec 17/11 §2) — luồng sửa danh mục / K / mức CMS của chương trình đang chạy:
//   (1) chọn file (CÙNG mẫu / parser / kiểm K của import) → POST /api/cms/revision/preview: server kiểm file, file phải là TOÀN BỘ danh
//       mục mong muốn (còn lỗi ⇒ hiện tóm tắt lỗi + kiểm K, không lập revision), dự toán trước / sau cùng nguồn, RPC preview (diff DB);
//   (2) xem diff theo ProductID + tác động; nhập lý do + tick (KHÔNG tick sẵn; preview mới ⇒ tick lại) → POST /api/cms/revision/commit
//       với revision_id + config_version + digest + idempotency key (giữ nguyên khi gửi lại do mất mạng). Không gửi lại file.
// Không tự gọi đồng bộ sau khi ghi; không có nút hoàn tác (muốn quay lại ⇒ sửa bù bằng chính luồng này).
// Fixture /ui-catalog: mọi request bị useFixtureActionBlocked chặn (0 ghi).

const MAX_FILE = 5 * 1024 * 1024
type Step = 'upload' | 'running' | 'result'
type Format = 'tiers' | 'simple'

function errorText(b: CmsRevisionErrorBody | null): string {
  if (!b) return 'Máy chủ không phản hồi đúng — thử lại'
  const base = b.message ?? `Không xử lý được (${b.code})`
  if (b.productId) return `${base}: ProductID ${b.productId}`
  if (b.missing?.length) return `${base}: ${b.missing.join(', ')}`
  if (b.column) return `${base} (cột "${b.column}")`
  return base
}

/** Khoá idempotency v4 ngẫu nhiên. Không có nguồn ngẫu nhiên an toàn ⇒ null (nút ghi báo lỗi — không dùng khoá hằng: PM audit 17/11 P2). */
function newKey(): string | null {
  const c = typeof crypto !== 'undefined' ? crypto : null
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
  return null
}

export function CmsRevisionFlow({ program, v2 = false, publishedAt = null, fixture }: {
  program: { id: string; name: string }
  /** Cờ CMS_IMPORT_V2_ENABLED: chọn loại file + kiểm K. */
  v2?: boolean
  publishedAt?: string | null
  /** Chỉ /ui-catalog: dựng sẵn bước / kết quả. */
  fixture?: { step: Step; preview?: CmsRevisionPreviewBody; fileError?: CmsRevisionErrorBody; done?: CmsRevisionCommitReply }
}) {
  const router = useRouter()
  const blocked = useFixtureActionBlocked()
  const [step, setStep] = useState<Step>(fixture?.step ?? 'upload')
  const [file, setFile] = useState<File | null>(null)
  const [format, setFormat] = useState<Format>('tiers')
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<CmsRevisionPreviewBody | null>(fixture?.preview ?? null)
  const [fileError, setFileError] = useState<CmsRevisionErrorBody | null>(fixture?.fileError ?? null)
  const [drafts, setDrafts] = useState<CmsKAckDraft>({})
  const [rechecking, setRechecking] = useState(false)
  const [reason, setReason] = useState('')
  const [wholePeriod, setWholePeriod] = useState(false)
  const [mayDecrease, setMayDecrease] = useState(false)
  const [removedAck, setRemovedAck] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [done, setDone] = useState<CmsRevisionCommitReply | null>(fixture?.done ?? null)
  const key = useRef<string | null>(newKey())
  const abort = useRef<AbortController | null>(null)

  const analysis: CmsRevisionAnalysis | null = preview?.analysis ?? fileError?.analysis ?? null
  const kRows = analysis?.kCheck?.products ?? []

  function clearDecision() {
    setReason(''); setWholePeriod(false); setMayDecrease(false); setRemovedAck(false); setDrafts({})
    key.current = newKey()
  }

  function reset(keepFile: boolean) {
    abort.current?.abort()
    setPreview(null); setFileError(null); setDone(null); clearDecision(); setStep('upload')
    if (!keepFile) setFile(null)
  }

  function pick(f: File | null) {
    setError(null)
    if (!f) { setFile(null); return }
    if (!/\.xlsx$/i.test(f.name)) { setError('Chỉ nhận file .xlsx'); setFile(null); return }
    if (f.size > MAX_FILE) { setError('File vượt 5 MiB'); setFile(null); return }
    setFile(f)
  }

  async function runPreview(withAcks: boolean) {
    if (blocked()) return
    if (!file) { setError('Chọn lại file để kiểm tra'); return }
    const sent = v2 && withAcks && analysis?.kCheck ? cmsKAckPayload(analysis.kCheck.products, drafts) : null
    setError(null)
    if (withAcks) setRechecking(true); else setStep('running')
    const ac = new AbortController()
    abort.current = ac
    const fd = new FormData()
    fd.append('program_id', program.id)
    fd.append('file', file)
    if (v2) fd.append('format', format)
    if (sent) fd.append('k_acks', JSON.stringify(sent))
    try {
      const res = await fetch('/api/cms/revision/preview', { method: 'POST', body: fd, signal: ac.signal })
      const body = (await res.json().catch(() => null)) as CmsRevisionPreviewBody | CmsRevisionErrorBody | null
      if (ac.signal.aborted) return
      // Mỗi preview mới ⇒ tick / lý do / khoá idempotency của preview cũ không còn đúng (spec §2.6).
      clearDecision()
      if (res.ok && body && body.ok) { setPreview(body); setFileError(null); setStep('result'); return }
      const err = body && !body.ok ? body : null
      setPreview(null)
      if (err?.analysis) { setFileError(err); setStep('result'); return }
      setFileError(null)
      setError(errorText(err))
      setStep('upload')
    } catch {
      if (ac.signal.aborted) return
      setError('Không kết nối được máy chủ — thử lại')
      if (!withAcks) setStep('upload')
    } finally {
      if (withAcks) setRechecking(false)
    }
  }

  const rev = preview?.revision ?? null
  const removed = rev?.diff.removed ?? []
  const block = cmsRevisionCommitGate({
    done: done !== null, busy: committing || rechecking, impactOk: preview?.impact.status === 'ok' && rev?.impactOk === true,
    dirty: cmsKDirty(kRows, drafts), reasonOk: cmsRevisionReasonOk(reason), wholePeriod, mayDecrease, removedCount: removed.length, removedAck,
  })

  async function commit() {
    if (!rev || block !== 'NONE' || blocked()) return
    if (!key.current) { setError('Trình duyệt không tạo được mã chống ghi trùng — mở bằng trình duyệt khác rồi thử lại'); return }
    setError(null)
    setCommitting(true)
    try {
      const res = await fetch('/api/cms/revision/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision_id: rev.revisionId, expected_config_version: rev.fromConfigVersion, payload_digest: rev.payloadDigest,
          idempotency_key: key.current, reason: reason.trim(), ack: { whole_period: wholePeriod, may_decrease: mayDecrease, removed },
        }),
      })
      const body = (await res.json().catch(() => null)) as ({ ok: true; result: CmsRevisionCommitReply } | CmsRevisionErrorBody | null)
      if (res.ok && body?.ok) {
        setDone(body.result)
        toast.success('Đã ghi sửa đổi — số mới có sau lượt đồng bộ kế tiếp')
        router.refresh()
        return
      }
      const err = body && !body.ok ? body : null
      setError(errorText(err))
      if (err && ['PREVIEW_STALE', 'EXPIRED', 'MAPPING_CHANGED', 'NOT_OWNER', 'REVISION_NOT_FOUND'].includes(err.code)) {
        setPreview(null); clearDecision(); setStep('upload')
      }
    } catch {
      // Giữ khoá idempotency: gửi lại cùng preview / khoá không ghi hai lần.
      setError('Không kết nối được máy chủ — bấm ghi lại (không ghi trùng)')
    } finally {
      setCommitting(false)
    }
  }

  return (
    <div data-cms-revision-flow={done ? 'done' : step} className="space-y-4">
      <Notice tone="info" title="Sửa chương trình đang chạy">
        File là <b>toàn bộ danh mục mong muốn</b>: sản phẩm có trong file được tính với K / mức mới; sản phẩm đang có mà vắng khỏi file sẽ bị bỏ
        (chỉ khi bạn xác nhận). Sửa áp dụng lại <b>cả kỳ</b> từ ngày bắt đầu; không đổi được kỳ, phạm vi, cách tính, target / loại GMV hay đơn vị CMS.
      </Notice>
      {error && <Notice tone="danger" role="alert">{error}</Notice>}

      {done ? (
        <div data-cms-revision-done className="space-y-3">
          <Notice tone="success" role="status" title={done.already ? 'Sửa đổi này đã được ghi trước đó' : 'Đã ghi sửa đổi'}>
            Cấu hình v{done.fromConfigVersion} → v{done.toConfigVersion}
            {done.archiveMode === 'copied' && <> · đã lưu {done.archiveRows} dòng số đang hiển thị làm bản trước sửa</>}
            {done.archiveMode === 'reused' && <> · số trước sửa đã được lưu ở lần sửa trước</>}
            {done.retired + done.deleted > 0 && <> · bỏ {done.retired + done.deleted} sản phẩm</>}
            . Số mới xuất hiện sau lượt đồng bộ kế tiếp; trong lúc chờ, màn kết quả báo đang tính lại.
          </Notice>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Link href={`/targets/campaigns/cms/${program.id}/revisions`} className={cn(buttonVariants({ variant: 'outline' }), 'h-[44px] md:h-[36px] gap-1.5')}>
              <History className="h-4 w-4" /> Lịch sử sửa
            </Link>
            <Link href={`/targets/campaigns/cms/${program.id}`} className={cn(buttonVariants(), 'h-[44px] md:h-[36px] font-semibold')}>Về chương trình</Link>
          </div>
        </div>
      ) : step === 'upload' ? (
        <div className="space-y-3">
          {v2 && (
            <fieldset data-cms-revision-format={format} className="space-y-1.5">
              <legend className="text-[13px] font-semibold">Loại file</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {([['simple', 'Mức cố định', 'Mỗi sản phẩm một mức CMS / đơn vị (7 cột)'], ['tiers', 'Nhiều bậc / có target', 'Mẫu IMPORT_CMS 9 cột']] as const).map(([f, t, d]) => (
                  <label key={f} className={cn('flex min-h-[44px] cursor-pointer items-start gap-2.5 rounded-v2-control border bg-card p-3', format === f && 'border-v2-selected-line bg-accent')}>
                    <input type="radio" name="cms-revision-format" value={f} checked={format === f} onChange={() => setFormat(f)} className="mt-0.5 h-4 w-4" />
                    <span className="min-w-0"><span className="block text-[13px] font-semibold">{t}</span><span className="block text-[12px] text-muted-foreground">{d}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <label className="flex min-h-[140px] cursor-pointer flex-col items-center justify-center gap-2 rounded-v2-panel border border-dashed border-input bg-card p-6 text-center">
            <Upload aria-hidden="true" className="h-6 w-6 text-muted-foreground" />
            <span className="font-semibold">Chọn file .xlsx danh mục sau sửa</span>
            <span className="text-[12px] text-muted-foreground">Cùng mẫu với nạp danh mục · tối đa 5 MiB</span>
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
          </label>
          {file && (
            <div data-cms-file className="flex items-center gap-3 rounded-v2-panel border bg-card p-3">
              <FileSpreadsheet aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{file.name}</span>
              <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">{cmsFileSize(file.size)}</span>
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Link href={`/targets/campaigns/cms/${program.id}`} className={cn(buttonVariants({ variant: 'ghost' }), 'h-[44px] md:h-[36px]')}>Quay lại</Link>
            <Button type="button" disabled={!file} onClick={() => runPreview(false)} className="h-[44px] md:h-[36px] font-semibold">Kiểm tra và dự toán</Button>
          </div>
        </div>
      ) : step === 'running' ? (
        <div className="space-y-3 rounded-v2-panel border bg-card p-4">
          <div role="progressbar" aria-label="Đang kiểm tra file và dự toán" aria-busy="true" className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-v2-series" />
          </div>
          <p className="text-[13px] text-muted-foreground">Đang kiểm tra file, đọc nguồn bán cả kỳ cho danh mục trước ∪ sau và tính hai cấu hình — có thể mất tới 1–2 phút.</p>
          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={() => reset(true)} className="h-[44px] md:h-[36px]">Hủy</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {fileError?.analysis && (
            <div data-cms-revision-file-errors className="space-y-3">
              <Notice tone="danger" role="alert" title="File chưa dùng được để sửa">
                {fileError.message}
                {fileError.analysis.ignoredFromRow !== null && <> · các dòng từ dòng {fileError.analysis.ignoredFromRow} bị bỏ qua (ProductID trống) — xoá dòng trống giữa danh mục</>}
                . Sửa file rồi chọn lại; không bỏ sản phẩm do lỗi dòng.
              </Notice>
              <CmsImportIssueSummary items={fileError.analysis.issueSummary} format={fileError.analysis.format} />
              {fileError.analysis.groupsRejected.length > 0 && (
                <DataTableShell>
                  <Table className="min-w-[560px] text-[13px]">
                    <TableHeader>
                      <TableRow><TableHead className="pl-4">ProductID / nhóm</TableHead><TableHead>Dòng</TableHead><TableHead className="pr-4">Lỗi</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {fileError.analysis.groupsRejected.slice(0, 200).map((g) => (
                        <TableRow key={g.key} className="align-top">
                          <TableCell className="pl-4 font-mono text-[12px]">{g.key}</TableCell>
                          <TableCell className="tabular-nums whitespace-normal">{g.excelRows.slice(0, 10).join(', ')}{g.excelRows.length > 10 ? '…' : ''}</TableCell>
                          <TableCell className="pr-4 whitespace-normal">{g.errors.slice(0, 3).map((e, i) => <p key={i}>{e.column ? `${e.column}: ` : ''}{e.message}</p>)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </DataTableShell>
              )}
            </div>
          )}
          {analysis?.kCheck && (
            <CmsKCheckPanel key={`${analysis.sha256}:${rev?.revisionId ?? 'x'}`} kCheck={analysis.kCheck} drafts={drafts} onDrafts={setDrafts}
              onRecheck={() => runPreview(true)} busy={rechecking || committing} />
          )}
          {preview && rev && (
            <>
              <CmsRevisionDiffTable diff={rev.diff} />
              <CmsRevisionImpactPanel impact={preview.impact} source={preview.source} names={preview.names} publishedAt={publishedAt} />
              <section data-cms-revision-confirm aria-labelledby="cms-rev-confirm-title" className="space-y-3 rounded-v2-panel border bg-card p-3 md:p-4">
                <h3 id="cms-rev-confirm-title" className="text-[14px] font-semibold">Xác nhận ghi sửa đổi</h3>
                <p className="text-[12px] text-muted-foreground tabular-nums">
                  Bản xem trước cấu hình v{rev.fromConfigVersion} · hết hạn lúc {cmsDateTime(rev.expiresAt)} (15 phút) · chỉ người lập được ghi.
                </p>
                <div className="space-y-1.5">
                  <label htmlFor="cms-rev-reason" className="text-[13px] font-medium">Lý do sửa</label>
                  <Textarea id="cms-rev-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3}
                    placeholder="VD: Cập nhật K theo quy cách mới của NCC, MKT duyệt ngày …" className="text-[16px] md:text-sm" />
                  <p className="text-[12px] text-muted-foreground">10–1.000 ký tự. Lưu trong lịch sử sửa.</p>
                </div>
                <label className="flex min-h-[44px] cursor-pointer items-start gap-2.5 text-[13px]">
                  <input type="checkbox" checked={wholePeriod} onChange={(e) => setWholePeriod(e.target.checked)} className="mt-0.5 h-4 w-4" data-cms-ack="whole_period" />
                  <span>Tôi hiểu sửa đổi áp dụng lại <b>cả kỳ</b> từ ngày bắt đầu; số đang hiển thị chuyển thành bản trước sửa có mốc và màn kết quả báo đang tính lại tới lượt đồng bộ kế tiếp.</span>
                </label>
                <label className="flex min-h-[44px] cursor-pointer items-start gap-2.5 text-[13px]">
                  <input type="checkbox" checked={mayDecrease} onChange={(e) => setMayDecrease(e.target.checked)} className="mt-0.5 h-4 w-4" data-cms-ack="may_decrease" />
                  <span>Tôi đã xem dự toán và hiểu số CMS của dược sĩ <b>có thể giảm</b>.</span>
                </label>
                {removed.length > 0 && (
                  <label className="flex min-h-[44px] cursor-pointer items-start gap-2.5 text-[13px]">
                    <input type="checkbox" checked={removedAck} onChange={(e) => setRemovedAck(e.target.checked)} className="mt-0.5 h-4 w-4" data-cms-ack="removed" />
                    <span>Tôi xác nhận <b>bỏ {removed.length} sản phẩm</b> khỏi chương trình: <span className="font-mono text-[12px] break-all">{removed.join(', ')}</span></span>
                  </label>
                )}
                {block !== 'NONE' && block !== 'BUSY' && <p data-cms-revision-block={block} className="text-[12px] text-muted-foreground">{CMS_REVISION_BLOCK_TEXT[block]}</p>}
              </section>
            </>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => reset(false)} disabled={committing || rechecking} className="h-[44px] md:h-[36px]">Chọn file khác</Button>
            {preview && rev && (
              <Button type="button" onClick={commit} disabled={block !== 'NONE'} data-cms-revision-commit={block} className="h-[44px] md:h-[36px] font-semibold">
                {committing && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Ghi sửa đổi
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
