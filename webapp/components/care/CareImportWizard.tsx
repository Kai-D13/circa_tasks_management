'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Download, FileSpreadsheet, Loader2, Store, Upload, Users,
} from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { ErrorState } from '@/components/ds/ErrorState'
import { StatCard } from '@/components/ds/StatCard'
import { StatusBadge, type StatusTone } from '@/components/ds/StatusBadge'
import { CARE_ERROR_LABELS, type CareRowError } from '@/lib/care/import/contract'
import type { CareAssignmentGroup, CarePreview, CarePreviewCounts, CarePreviewCustomer } from '@/lib/care/import/preview'
import { CARE_QA_ISSUE_LABELS } from '@/lib/care/qa/labels'
import { cn } from '@/lib/utils'

// Wizard Phân công CRM (SPEC B2 §3): Tải file → Kiểm tra → Phân công (chỉ xem)
// → Xác nhận/kết quả. Preview CHỈ ĐỌC; commit gửi lại đúng file + sha256 + kỳ,
// server tính lại và RPC finalize (114) quyết định kết quả. Không có nút chuyển
// giao/phân công thủ công (B3). Tên/SĐT chỉ hiện trên màn hình người có quyền
// import, không log/URL.

type PreviewPayload = Omit<CarePreview, 'errors'> & { errorCount: number; errors: CareRowError[] }
/** B6-qa-ui: chỉ có trên dev server QA local — server quyết file có được import (is_test) hay không. */
type QaInfo = { commitAllowed: boolean; issues: string[] }
type CommitResult =
  | { status: 'committed'; batch_id: string; idempotent?: boolean } & Partial<CarePreviewCounts>
  | { status: 'duplicate'; batch_id: string; duplicate_of: string }
  | { status: 'rejected'; batch_id: string; error_count: number; errors: CareRowError[] }

const STEPS = ['Tải file', 'Kiểm tra dữ liệu', 'Phân công', 'Xác nhận'] as const
const PAGE = 50
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
  FILE_REQUIRED: 'Chọn đúng một file .xlsx.',
  FILE_TYPE: 'Chỉ nhận file Excel .xlsx.',
  SHA_MISMATCH: 'File đã thay đổi so với lúc kiểm tra — kiểm tra lại.',
  PERIOD_CHANGED: 'Đã sang tháng mới so với lúc kiểm tra — kiểm tra lại để lấy kỳ mới.',
  HAS_ERRORS: 'File còn lỗi — sửa file rồi kiểm tra lại.',
  STAGING_FAILED: 'Không lưu được dữ liệu tạm — không có gì được ghi. Thử lại.',
  FINALIZE_FAILED: 'Import thất bại — không có task nào được tạo. Thử lại hoặc báo quản trị.',
}
const messageFor = (code: string | undefined) =>
  (code && (SERVER_MESSAGES[code] ?? (CARE_ERROR_LABELS as Record<string, string>)[code] ?? (CARE_QA_ISSUE_LABELS as Record<string, string>)[code]))
  || 'Có lỗi không xác định — thử lại.'

const ACTION: Record<CarePreviewCustomer['action'], { tone: StatusTone; label: string }> = {
  create: { tone: 'success', label: 'Tạo mới' },
  update: { tone: 'info', label: 'Cập nhật' },
  unchanged: { tone: 'neutral', label: 'Không đổi' },
  skip_has_interaction: { tone: 'warning', label: 'Giữ nguyên (đã có lượt)' },
  error: { tone: 'danger', label: 'Lỗi' },
}

const fmt = (n: number) => n.toLocaleString('vi-VN')
const monthLabel = (period: string) => `${period.slice(5, 7)}/${period.slice(0, 4)}`
const dateLabel = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE))
  if (pages <= 1) return null
  return (
    <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
      <span>Trang {page}/{pages}</span>
      <Button variant="outline" size="sm" className="min-h-[44px] md:min-h-0" aria-label="Trang trước" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ChevronLeft className="size-4" />
      </Button>
      <Button variant="outline" size="sm" className="min-h-[44px] md:min-h-0" aria-label="Trang sau" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        <ChevronRight className="size-4" />
      </Button>
    </div>
  )
}

function ErrorTable({ errors, total, onPick }: { errors: CareRowError[]; total: number; onPick?: (row: number) => void }) {
  const [code, setCode] = useState<string>('')
  const [page, setPage] = useState(1)
  const codes = useMemo(() => [...new Set(errors.map((e) => e.code))], [errors])
  const list = code ? errors.filter((e) => e.code === code) : errors
  const view = list.slice((page - 1) * PAGE, page * PAGE)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="danger">{fmt(total)} lỗi</StatusBadge>
        {total > errors.length && <span className="text-xs text-muted-foreground">hiển thị {fmt(errors.length)} lỗi đầu</span>}
        <select
          aria-label="Lọc theo loại lỗi"
          className="ml-auto h-10 min-h-[44px] rounded-md border bg-background px-2 text-[16px] md:min-h-0 md:text-sm"
          value={code}
          onChange={(e) => { setCode(e.target.value); setPage(1) }}
        >
          <option value="">Tất cả loại lỗi</option>
          {codes.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <DataTableShell>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Dòng</TableHead>
              <TableHead>Mã lỗi</TableHead>
              <TableHead>Nội dung</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.map((e) => (
              <TableRow key={`${e.row}-${e.code}`}>
                <TableCell>
                  {onPick ? (
                    <button type="button" className="min-h-[44px] font-medium text-primary underline-offset-2 hover:underline md:min-h-0" onClick={() => onPick(e.row)}>
                      {e.row}
                    </button>
                  ) : e.row}
                </TableCell>
                <TableCell className="font-mono text-xs">{e.code}</TableCell>
                <TableCell className="text-sm">{CARE_ERROR_LABELS[e.code]}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
      <Pager page={page} total={list.length} onPage={setPage} />
    </div>
  )
}

function CustomerTable({ customers, focusRow, onClearFocus }: { customers: CarePreviewCustomer[]; focusRow: number | null; onClearFocus: () => void }) {
  const [filter, setFilter] = useState<CarePreviewCustomer['action'] | 'all'>('all')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const list = customers.filter((c) => {
    if (focusRow !== null) return c.rows.includes(focusRow)
    if (filter !== 'all' && c.action !== filter) return false
    if (!q) return true
    const s = q.toLowerCase()
    return c.externalId.toLowerCase().includes(s) || c.name.toLowerCase().includes(s) || c.storeCode.toLowerCase().includes(s) || c.email.includes(s)
  })
  const view = list.slice((page - 1) * PAGE, page * PAGE)
  const tabs: (CarePreviewCustomer['action'] | 'all')[] = ['all', 'create', 'update', 'unchanged', 'skip_has_interaction', 'error']
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {tabs.map((t) => {
          const n = t === 'all' ? customers.length : customers.filter((c) => c.action === t).length
          return (
            <button
              key={t}
              type="button"
              onClick={() => { setFilter(t); setPage(1); onClearFocus() }}
              className={cn(
                'min-h-[44px] rounded px-3 text-sm md:min-h-0 md:py-1.5',
                filter === t && focusRow === null ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              {t === 'all' ? 'Tất cả' : ACTION[t].label} ({fmt(n)})
            </button>
          )
        })}
        <Input
          aria-label="Tìm khách"
          placeholder="Tìm mã KH, tên, cửa hàng, email…"
          className="ml-auto h-10 w-full text-[16px] md:w-64 md:text-sm"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); onClearFocus() }}
        />
      </div>
      {focusRow !== null && (
        <div className="flex items-center gap-2 text-sm">
          <StatusBadge tone="info">Đang xem khách chứa dòng {focusRow}</StatusBadge>
          <Button variant="ghost" size="sm" className="min-h-[44px] md:min-h-0" onClick={onClearFocus}>Bỏ lọc</Button>
        </div>
      )}
      <DataTableShell>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Dòng</TableHead>
              <TableHead>Mã KH</TableHead>
              <TableHead>Tên</TableHead>
              <TableHead>SĐT</TableHead>
              <TableHead>Cửa hàng</TableHead>
              <TableHead>Dược sĩ (từ file)</TableHead>
              <TableHead className="text-right">Sản phẩm</TableHead>
              <TableHead>Kết quả dự kiến</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.map((c) => (
              <TableRow key={c.externalId}>
                <TableCell className="whitespace-nowrap text-muted-foreground">{c.rows.length > 1 ? `${c.rows[0]}–${c.rows[c.rows.length - 1]}` : c.rows[0]}</TableCell>
                <TableCell className="max-w-[140px] truncate font-mono text-xs" title={c.externalId}>{c.externalId}</TableCell>
                <TableCell className="max-w-[180px] truncate" title={c.name}>{c.name}</TableCell>
                <TableCell className="whitespace-nowrap">{c.phoneRaw}</TableCell>
                <TableCell className="max-w-[160px] truncate" title={c.storeName ?? c.storeCode}>{c.storeCode}</TableCell>
                <TableCell className="max-w-[200px] truncate" title={c.email}>{c.assigneeName ?? c.email}</TableCell>
                <TableCell className="text-right tabular-nums">{c.productCount}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <StatusBadge tone={ACTION[c.action].tone}>{ACTION[c.action].label}</StatusBadge>
                    {c.ownerIgnored && <StatusBadge tone="warning">Dược sĩ khác file — giữ người hiện tại</StatusBadge>}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
      <Pager page={page} total={list.length} onPage={setPage} />
    </div>
  )
}

function CountsGrid({ counts }: { counts: CarePreviewCounts }) {
  const items: [string, number, StatusTone][] = [
    ['Tạo task mới', counts.created, 'success'],
    ['Cập nhật sản phẩm/lý do', counts.updated, 'info'],
    ['Không đổi', counts.unchanged, 'neutral'],
    ['Giữ nguyên vì đã có lượt chăm sóc', counts.skipped_has_interaction, 'warning'],
    ['File đổi dược sĩ — không áp dụng', counts.owner_ignored, 'warning'],
    ['Khách vắng file — giữ nguyên task', counts.absent_kept, 'neutral'],
    ['Task kỳ trước sẽ đóng (Không hoàn thành)', counts.closed_previous_period, 'neutral'],
  ]
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {items.map(([label, n, tone]) => (
        <li key={label} className="flex items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
          <span>{label}</span>
          <StatusBadge tone={tone}>{fmt(n)}</StatusBadge>
        </li>
      ))}
    </ul>
  )
}

function AssignmentView({ groups }: { groups: CareAssignmentGroup[] }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Dược sĩ phụ trách lấy từ cột <span className="font-mono">assignee_email</span> trong file — màn này chỉ để xem lại.
        Muốn đổi dược sĩ cho khách đã import, dùng chức năng Chuyển giao (SM/super) khi được mở.
      </p>
      <DataTableShell>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Cửa hàng</TableHead>
              <TableHead>Dược sĩ</TableHead>
              <TableHead className="text-right">Khách</TableHead>
              <TableHead className="text-right">Dòng sản phẩm</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.flatMap((g) => g.assignees.map((a, i) => (
              <TableRow key={`${g.storeCode}-${a.email}`}>
                <TableCell className="max-w-[220px] truncate" title={g.storeName}>
                  {i === 0 ? <span><span className="font-medium">{g.storeCode}</span> · {g.storeName} <span className="text-muted-foreground">({fmt(g.customers)} khách)</span></span> : null}
                </TableCell>
                <TableCell className="max-w-[220px] truncate" title={a.email}>{a.name}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(a.customers)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(a.products)}</TableCell>
              </TableRow>
            )))}
          </TableBody>
        </Table>
      </DataTableShell>
    </div>
  )
}

export function CareImportWizard({ maxBytes, templateHref = '/api/care/import/template' }: { maxBytes: number; templateHref?: string }) {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewPayload | null>(null)
  const [qa, setQa] = useState<QaInfo | null>(null)
  const [sha, setSha] = useState<string>('')
  const [result, setResult] = useState<CommitResult | null>(null)
  const [focusRow, setFocusRow] = useState<number | null>(null)
  const committing = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileLimit = maxBytes - MULTIPART_RESERVE

  const reset = () => {
    setStep(0); setFile(null); setPreview(null); setQa(null); setSha(''); setResult(null); setError(null); setFocusRow(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  async function runPreview() {
    if (!file) return
    if (file.size > fileLimit) { setError(`File ${(file.size / 1048576).toFixed(1)} MB vượt giới hạn ${(fileLimit / 1048576).toFixed(1)} MB.`); return }
    setBusy(true); setError(null); setResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/care/import/preview', { method: 'POST', body: fd })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.ok) { setError(messageFor(body?.code)); return }
      setPreview(body.preview); setQa(body.qa ?? null); setSha(body.sha256); setFocusRow(null); setStep(1)
    } catch {
      setError('Không gửi được file — kiểm tra mạng rồi thử lại.')
    } finally {
      setBusy(false)
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
          setPreview({ ...preview, errorCount: body.errorCount ?? body.errors.length, errors: body.errors }); setStep(1)
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

  return (
    <div className="space-y-4" data-testid="care-import-wizard">
      <ol className="flex flex-wrap gap-2" aria-label="Các bước import">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined}
            className={cn('flex items-center gap-2 rounded px-3 py-1.5 text-sm',
              i === step ? 'bg-primary text-primary-foreground' : i < step ? 'bg-muted text-foreground' : 'bg-muted text-muted-foreground')}>
            <span className="tabular-nums">{i + 1}</span>{s}
          </li>
        ))}
      </ol>

      {error && <ErrorState message={error} />}

      {step === 0 && (
        <Card className="rounded-lg">
          <CardContent className="space-y-4 p-4">
            <p className="text-sm text-muted-foreground">
              Một file cho cả tháng: một sheet <span className="font-mono">KhachHang</span>, đúng 10 cột theo mẫu.
              Nhiều dòng sản phẩm của cùng khách tạo <strong>một</strong> task. Kỳ và hạn (cuối tháng) do hệ thống tính theo giờ Việt Nam lúc xác nhận.
            </p>
            <p className="text-sm text-muted-foreground">
              Cột <span className="font-mono">customer_external_id</span> phải định dạng <strong>Text</strong> trong Excel (ô dạng số sẽ bị báo lỗi
              vì có thể đã mất số 0 đầu). <span className="font-mono">product_id</span> nhận Text hoặc số nguyên tối đa 15 chữ số định dạng
              General (không đệm số 0, không dấu phân cách). SĐT thiếu số 0 đầu vẫn được nhận và tự chuẩn hoá.
            </p>
            <a href={templateHref} className={cn(buttonVariants({ variant: 'outline' }), 'min-h-[44px] md:min-h-0')}>
              <Download className="size-4" /> Tải file mẫu
            </a>
            <label className="block space-y-2">
              <span className="text-sm font-medium">File Excel (.xlsx, tối đa {(fileLimit / 1048576).toFixed(1)} MB)</span>
              <Input
                ref={inputRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="h-auto min-h-[44px] text-[16px] md:text-sm"
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setError(null) }}
              />
            </label>
            <div className="flex justify-end">
              <Button className="min-h-[44px] md:min-h-0" disabled={!file || busy} onClick={runPreview}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Kiểm tra file
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step >= 1 && preview && !result && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Dòng sản phẩm" value={fmt(preview.rowCount)} icon={FileSpreadsheet} />
          <StatCard label="Khách (task)" value={fmt(preview.customerCount)} icon={Users} />
          <StatCard label="Cửa hàng trong file" value={`${fmt(preview.storeCodesInFile)}/${fmt(preview.activeOsStoreCount)}`} icon={Store}
            hint="so với cửa hàng OS đang hoạt động" tone={preview.activeOsStoresMissing.length ? 'warning' : 'default'} />
          <StatCard label="Lỗi" value={fmt(preview.errorCount)} icon={hasErrors ? AlertTriangle : CheckCircle2} tone={hasErrors ? 'danger' : 'success'} />
        </div>
      )}

      {step === 1 && preview && (
        <div className="space-y-4">
          <p className="text-sm">
            Kỳ dự kiến <strong>{monthLabel(preview.period)}</strong> · hạn chăm sóc <strong>{dateLabel(preview.dueDate)}</strong>.
            Số liệu dưới đây là dự kiến; kết quả cuối do hệ thống kiểm lại khi xác nhận.
          </p>
          {qa && (
            <p role="note" data-testid="care-import-qa" className="rounded-lg border border-status-warning/40 bg-status-warning-bg p-3 text-sm">
              {qa.commitAllowed ? 'Chế độ QA: đúng bản QA đã chuẩn bị — import sẽ ghi dữ liệu thử nghiệm (is_test).' : messageFor(qa.issues[0])}
            </p>
          )}
          {preview.activeOsStoresMissing.length > 0 && (
            <div className="rounded-lg border bg-card p-3 text-sm">
              <StatusBadge tone="warning">{fmt(preview.activeOsStoresMissing.length)} cửa hàng OS không có khách trong file</StatusBadge>
              <p className="mt-2 text-muted-foreground">{preview.activeOsStoresMissing.map((s) => s.code).join(', ')}</p>
            </div>
          )}
          {hasErrors && <ErrorTable errors={preview.errors} total={preview.errorCount} onPick={setFocusRow} />}
          <CountsGrid counts={preview.counts} />
          <CustomerTable customers={preview.customers} focusRow={focusRow} onClearFocus={() => setFocusRow(null)} />
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="outline" className="min-h-[44px] md:min-h-0" onClick={reset}>Chọn file khác</Button>
            <Button className="min-h-[44px] md:min-h-0" disabled={hasErrors} onClick={() => setStep(2)}>
              {hasErrors ? 'Sửa file rồi kiểm tra lại' : 'Tiếp: xem phân công'}
            </Button>
          </div>
        </div>
      )}

      {step === 2 && preview && (
        <div className="space-y-4">
          <AssignmentView groups={preview.assignments} />
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="outline" className="min-h-[44px] md:min-h-0" onClick={() => setStep(1)}>Quay lại</Button>
            <Button className="min-h-[44px] md:min-h-0" onClick={() => setStep(3)}>Tiếp: xác nhận</Button>
          </div>
        </div>
      )}

      {step === 3 && preview && !result && (
        <Card className="rounded-lg">
          <CardContent className="space-y-4 p-4">
            <p className="text-sm">
              Import kỳ <strong>{monthLabel(preview.period)}</strong>, hạn <strong>{dateLabel(preview.dueDate)}</strong>:
              tạo <strong>{fmt(preview.counts.created)}</strong> task, cập nhật <strong>{fmt(preview.counts.updated)}</strong>,
              giữ nguyên <strong>{fmt(preview.counts.unchanged + preview.counts.skipped_has_interaction)}</strong>.
              {preview.counts.closed_previous_period > 0 && <> Đóng <strong>{fmt(preview.counts.closed_previous_period)}</strong> task kỳ trước còn mở.</>}
            </p>
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="outline" className="min-h-[44px] md:min-h-0" disabled={busy} onClick={() => setStep(2)}>Quay lại</Button>
              <Button className="min-h-[44px] md:min-h-0" disabled={busy || hasErrors || qaBlocked} onClick={runCommit}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Xác nhận import
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {result && (
        <Card className="rounded-lg" data-testid="care-import-result">
          <CardContent className="space-y-3 p-4">
            {result.status === 'committed' && (
              <>
                <StatusBadge tone="success" size="md">{result.idempotent ? 'File này đã được import trước đó' : 'Đã import'}</StatusBadge>
                <p className="text-sm">
                  Tạo mới <strong>{fmt(result.created ?? 0)}</strong> · cập nhật <strong>{fmt(result.updated ?? 0)}</strong> ·
                  không đổi <strong>{fmt(result.unchanged ?? 0)}</strong> · giữ nguyên vì đã có lượt <strong>{fmt(result.skipped_has_interaction ?? 0)}</strong> ·
                  đóng task kỳ trước <strong>{fmt(result.closed_previous_period ?? 0)}</strong>.
                </p>
                {preview && (result.created !== preview.counts.created || result.updated !== preview.counts.updated) && (
                  <p className="text-sm text-muted-foreground">
                    Kết quả thực tế khác bản kiểm tra vì dữ liệu đã thay đổi trong lúc chờ (vd. dược sĩ vừa ghi lượt chăm sóc).
                  </p>
                )}
              </>
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
                <ErrorTable errors={result.errors} total={result.error_count} />
              </>
            )}
            <div className="flex justify-end">
              <Button variant="outline" className="min-h-[44px] md:min-h-0" onClick={reset}>Import file khác</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
