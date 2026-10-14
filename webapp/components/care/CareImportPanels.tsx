'use client'

import { useState } from 'react'
import { CalendarDays, Check, ChevronLeft, ChevronRight, Download, Info } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { StatusBadge, type StatusTone } from '@/components/ds/StatusBadge'
import {
  CARE_ERROR_FIXES, CARE_ERROR_LABELS, CARE_ERROR_SHORT, CARE_FIELD_MAX_LENGTH, CARE_IMPORT_COLUMN_RULES,
  CARE_IMPORT_HEADERS, CARE_IMPORT_MAX_ROWS, CARE_IMPORT_SHEET, careColumnLetter,
  type CareRowError, type CareRowErrorCode,
} from '@/lib/care/import/contract'
import type { CarePreviewCounts, CarePreviewCustomer } from '@/lib/care/import/preview'
import { careAssignmentTable, careErrorCodeCounts } from '@/lib/care/import/review'
import { cn } from '@/lib/utils'

// B8.3 /care/assign theo artboard 11 (bố cục) + SPEC B2/Q-110 (nghiệp vụ): lỗi bất kỳ chặn CẢ file, cột chỉ khi
// chắc chắn, không giá trị ô, bước Phân công chỉ đọc (email khớp chính xác), không ghi chú lần import.

export const PANEL = 'rounded-care-panel border border-care-line bg-card'
export const INSET = 'rounded-lg border border-care-line bg-care-surface'
export const fmt = (n: number) => n.toLocaleString('vi-VN')
export const monthLabel = (period: string) => `${period.slice(5, 7)}/${period.slice(0, 4)}`
export const dateLabel = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
/** 20 dòng/trang: nút đi tiếp của bước không bị đẩy quá xa (file N1 ~3–5 nghìn khách). */
const PAGE = 20

/** Header trang: kỳ nhận (tháng hiện tại giờ VN, chỉ hiển thị) + tải file mẫu. */
export function CareImportPageActions({ period, templateHref = '/api/care/import/template' }: { period: string; templateHref?: string }) {
  return (
    <>
      <span className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-care-line-strong bg-card px-3 text-sm text-muted-foreground md:min-h-[36px]">
        <CalendarDays className="size-4" aria-hidden /> Kỳ nhận: <b className="font-medium text-foreground">Tháng {monthLabel(period)}</b>
      </span>
      <a href={templateHref} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-h-[44px] gap-1.5 md:h-[36px] md:min-h-0')}>
        <Download className="size-4" /> Tải file mẫu
      </a>
    </>
  )
}

/** Chip lọc client (cùng hình FilterTabs variant chip): viên 36px trong vùng chạm 44px. */
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className="group flex min-h-[44px] shrink-0 items-center">
      <span className={cn('inline-flex h-[36px] items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium whitespace-nowrap transition-colors',
        active ? 'border-foreground bg-foreground text-background' : 'border-input bg-card text-foreground/80 group-hover:text-foreground')}>
        {children}
      </span>
    </button>
  )
}
const ChipCount = ({ n, active }: { n: number; active: boolean }) =>
  <span className={cn('tabular-nums', active ? 'text-background/70' : 'text-muted-foreground')}>{fmt(n)}</span>

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

// ── Bước ─────────────────────────────────────────────────────────────────────
export function CareImportStepper({ steps, step, allDone, canGo, onGo }: {
  steps: { label: string; desc: string }[]
  step: number
  /** Đã import xong ⇒ cả 4 bước có dấu ✓. */
  allDone: boolean
  /** Được quay lại bước đã qua (không khi đang gửi / đã có kết quả). */
  canGo: boolean
  onGo: (i: number) => void
}) {
  return (
    <ol aria-label="Các bước import" className="grid grid-cols-2 border-b border-care-line md:grid-cols-4">
      {steps.map((s, i) => {
        const done = allDone || i < step
        const current = !allDone && i === step
        return (
          <li key={s.label} aria-current={current ? 'step' : undefined} className={cn('min-w-0 border-b-2', current ? 'border-primary' : 'border-transparent')}>
            <button type="button" disabled={!(canGo && i < step)} onClick={() => onGo(i)}
              className="flex min-h-[44px] w-full items-center gap-3 px-4 py-3 text-left enabled:hover:bg-muted/40 disabled:cursor-default">
              <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums',
                done ? 'border border-status-success/40 bg-status-success-bg text-status-success'
                  : current ? 'bg-primary text-primary-foreground' : 'border border-care-line-strong text-muted-foreground')}>
                {done ? <Check className="size-3.5" aria-label="đã xong" /> : i + 1}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className={cn('text-sm', current ? 'font-semibold' : 'font-medium', current || done ? 'text-foreground' : 'text-muted-foreground')}>{s.label}</span>
                <span className="truncate text-xs text-muted-foreground" title={s.desc}>{s.desc}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

// ── Bước 1: yêu cầu file (từ hợp đồng N1 thật) ────────────────────────────────
export function CareImportRequirements() {
  const rules = [
    <>Một file cho cả tháng: một sheet <code className="font-mono text-xs">{CARE_IMPORT_SHEET}</code>, đúng 10 cột theo thứ tự mẫu.</>,
    <>Nhiều dòng sản phẩm của cùng một khách được gộp thành <b>một task</b>.</>,
    <>Dán giá trị (không công thức), không để dòng trống xen giữa, tối đa {fmt(CARE_IMPORT_MAX_ROWS)} dòng.</>,
    <>Có lỗi bất kỳ thì <b>cả file</b> không được import — sửa file gốc rồi kiểm tra lại.</>,
  ]
  return (
    <section aria-label="Yêu cầu file" className={cn(INSET, 'space-y-3 p-4 text-sm')}>
      <h3 className="font-semibold">Yêu cầu file</h3>
      <ul className="space-y-2">
        {rules.map((r, i) => (
          <li key={i} className="flex gap-2.5"><Check className="mt-0.5 size-4 shrink-0 text-status-success" aria-hidden /><span>{r}</span></li>
        ))}
        <li className="flex gap-2.5 text-muted-foreground"><Info className="mt-0.5 size-4 shrink-0" aria-hidden /><span>Kỳ và hạn (cuối tháng) do hệ thống tính theo giờ Việt Nam lúc xác nhận.</span></li>
      </ul>
      <div className="space-y-1.5 border-t border-care-line pt-3">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase">10 cột theo mẫu</h4>
        <ol className="space-y-1" data-testid="care-import-columns">
          {CARE_IMPORT_HEADERS.map((h) => {
            const max = CARE_FIELD_MAX_LENGTH[h]
            return (
              <li key={h} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 text-xs leading-5">
                <span className="font-mono text-muted-foreground">{careColumnLetter(h)}</span>
                <span className="min-w-0">
                  <code className="font-mono font-medium break-all">{h}</code>
                  <span className="text-muted-foreground"> — {CARE_IMPORT_COLUMN_RULES[h]}{max !== null && ` · ≤ ${fmt(max)} ký tự`}</span>
                </span>
              </li>
            )
          })}
        </ol>
      </div>
    </section>
  )
}

// ── Bước 2: bảng lỗi (Q-110) ──────────────────────────────────────────────────
/** Ô "Cột": chỉ khi preview xác định chắc chắn một cột; còn lại "—" (lỗi nhiều cột/quan hệ). */
export function CareErrorColumn({ e }: { e: CareRowError }) {
  if (!e.field) return <span className="text-muted-foreground" title="Lỗi liên quan nhiều cột hoặc giữa các dòng — xem cách sửa">—</span>
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="font-mono text-xs text-muted-foreground">{careColumnLetter(e.field)}</span>
      <code className="rounded border border-care-line bg-care-surface px-1.5 py-0.5 font-mono text-xs">{e.field}</code>
    </span>
  )
}

export function CareImportIssues({ errors, total, counts, onPick }: {
  errors: CareRowError[]
  total: number
  counts?: Partial<Record<CareRowErrorCode, number>> | null
  onPick?: (row: number) => void
}) {
  const [code, setCode] = useState<CareRowErrorCode | ''>('')
  const [page, setPage] = useState(1)
  const exact = careErrorCodeCounts(errors, total, counts)
  const codes = [...new Set([...(exact ? Object.keys(exact) as CareRowErrorCode[] : []), ...errors.map((e) => e.code)])]
    .sort((a, b) => (exact?.[b] ?? 0) - (exact?.[a] ?? 0) || a.localeCompare(b))
  const list = code ? errors.filter((e) => e.code === code) : errors
  const view = list.slice((page - 1) * PAGE, page * PAGE)
  const pick = (c: CareRowErrorCode | '') => { setCode(c); setPage(1) }
  const codeTotal = code ? exact?.[code] ?? null : total
  return (
    <section aria-label="Lỗi trong file" className="space-y-3" data-testid="care-import-issues">
      <div className="flex flex-wrap items-center gap-x-2">
        <StatusBadge tone="danger">{fmt(total)} lỗi</StatusBadge>
        {total > errors.length && <span className="text-xs text-muted-foreground">hiển thị {fmt(errors.length)} lỗi đầu — sửa xong kiểm tra lại để xem tiếp</span>}
      </div>
      <div role="group" aria-label="Lọc theo loại lỗi" className="flex gap-2 overflow-x-auto [scrollbar-width:none]">
        <Chip active={code === ''} onClick={() => pick('')}>Tất cả <ChipCount n={total} active={code === ''} /></Chip>
        {codes.map((c) => (
          <Chip key={c} active={code === c} onClick={() => pick(c)}>
            {CARE_ERROR_SHORT[c]}{exact?.[c] !== undefined && <ChipCount n={exact[c]!} active={code === c} />}
          </Chip>
        ))}
      </div>
      {code && codeTotal !== null && codeTotal > list.length && (
        <p className="text-xs text-muted-foreground">Đang hiện {fmt(list.length)}/{fmt(codeTotal)} lỗi loại này (chi tiết giới hạn {fmt(errors.length)} lỗi đầu).</p>
      )}
      <DataTableShell>
        {/* min-w: mobile cuộn ngang TRONG khung bảng, không ép 4 cột vào 360px. */}
        <Table className="min-w-[760px] table-fixed">
          <colgroup><col className="w-20" /><col className="w-56" /><col className="w-72" /><col /></colgroup>
          <TableHeader>
            <TableRow>
              <TableHead className="text-right">Dòng</TableHead>
              <TableHead>Cột</TableHead>
              <TableHead>Lỗi</TableHead>
              <TableHead>Cách sửa</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.map((e) => (
              <TableRow key={`${e.row}-${e.code}`}>
                <TableCell className="text-right tabular-nums">
                  {onPick ? (
                    <button type="button" title={`Xem khách chứa dòng ${e.row}`} className="min-h-[44px] font-medium text-primary underline-offset-2 hover:underline md:min-h-0" onClick={() => onPick(e.row)}>
                      {e.row}
                    </button>
                  ) : e.row}
                </TableCell>
                <TableCell><CareErrorColumn e={e} /></TableCell>
                <TableCell className="whitespace-normal">
                  <span className="block text-sm">{CARE_ERROR_LABELS[e.code]}</span>
                  <span className="block font-mono text-xs text-muted-foreground">{e.code}</span>
                </TableCell>
                <TableCell className="text-sm whitespace-normal text-muted-foreground">{CARE_ERROR_FIXES[e.code]}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
      <Pager page={page} total={list.length} onPage={setPage} />
    </section>
  )
}

// ── Bước 2: khách trong file ──────────────────────────────────────────────────
export const CARE_IMPORT_ACTION: Record<CarePreviewCustomer['action'], { tone: StatusTone; label: string }> = {
  create: { tone: 'success', label: 'Tạo mới' },
  update: { tone: 'info', label: 'Cập nhật' },
  unchanged: { tone: 'neutral', label: 'Không đổi' },
  skip_has_interaction: { tone: 'warning', label: 'Giữ nguyên (đã có lượt)' },
  error: { tone: 'danger', label: 'Lỗi' },
}

export function CareImportCustomers({ customers, focusRow, onClearFocus }: { customers: CarePreviewCustomer[]; focusRow: number | null; onClearFocus: () => void }) {
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
    <section aria-label="Khách trong file" className="space-y-3">
      <h3 className="text-sm font-semibold">Khách trong file</h3>
      <div className="flex flex-wrap items-center gap-2">
        {tabs.map((t) => {
          const n = t === 'all' ? customers.length : customers.filter((c) => c.action === t).length
          if (t !== 'all' && n === 0) return null
          const on = filter === t && focusRow === null
          return (
            <Chip key={t} active={on} onClick={() => { setFilter(t); setPage(1); onClearFocus() }}>
              {t === 'all' ? 'Tất cả' : CARE_IMPORT_ACTION[t].label} ({fmt(n)})
            </Chip>
          )
        })}
        <Input
          aria-label="Tìm khách"
          placeholder="Tìm mã KH, tên, cửa hàng, email…"
          className="h-10 w-full text-[16px] md:ml-auto md:w-64 md:text-sm"
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
                    <StatusBadge tone={CARE_IMPORT_ACTION[c.action].tone}>{CARE_IMPORT_ACTION[c.action].label}</StatusBadge>
                    {c.ownerIgnored && <StatusBadge tone="warning">Dược sĩ khác file — giữ người hiện tại</StatusBadge>}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
      <Pager page={page} total={list.length} onPage={setPage} />
    </section>
  )
}

// ── Bước 3: phân công chỉ đọc ─────────────────────────────────────────────────
export function CareImportAssign({ customers }: { customers: CarePreviewCustomer[] }) {
  const t = careAssignmentTable(customers)
  const showIgnored = t.totals.ownerIgnored > 0
  const num = 'text-right tabular-nums'
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Dược sĩ phụ trách lấy từ cột <code className="font-mono text-xs">assignee_email</code>, khớp <b className="text-foreground">chính xác</b> một
        tài khoản staff của đúng cửa hàng — màn này chỉ để xem lại. Muốn đổi người phụ trách sau khi import, dùng Chuyển giao ở mục Chăm sóc.
      </p>
      <DataTableShell>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Cửa hàng</TableHead>
              <TableHead>Dược sĩ</TableHead>
              <TableHead className="min-w-[160px]">Khách (theo file)</TableHead>
              <TableHead className="text-right">Tạo mới</TableHead>
              <TableHead className="text-right">Cập nhật</TableHead>
              <TableHead className="text-right">Không đổi</TableHead>
              <TableHead className="text-right">Giữ (đã có lượt)</TableHead>
              {showIgnored && <TableHead className="text-right">Giữ người hiện tại</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {t.stores.flatMap((s) => s.rows.map((r, i) => (
              <TableRow key={`${s.storeCode}|${r.email}`}>
                <TableCell className="max-w-[220px] truncate" title={s.storeName}>
                  {i === 0 && <><span className="font-medium">{s.storeCode}</span> · {s.storeName} <span className="text-muted-foreground">({fmt(s.customers)} khách)</span></>}
                </TableCell>
                <TableCell className="max-w-[220px]">
                  <span className="block truncate">{r.name}</span>
                  <span className="block truncate text-xs text-muted-foreground" title={r.email}>{r.email}</span>
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-primary" style={{ width: `${t.maxCustomers ? Math.round((r.customers / t.maxCustomers) * 100) : 0}%` }} />
                    </span>
                    <span className="tabular-nums">{fmt(r.customers)}</span>
                  </span>
                </TableCell>
                <TableCell className={num}>{fmt(r.created)}</TableCell>
                <TableCell className={num}>{fmt(r.updated)}</TableCell>
                <TableCell className={num}>{fmt(r.unchanged)}</TableCell>
                <TableCell className={num}>{fmt(r.skipped)}</TableCell>
                {showIgnored && <TableCell className={num}>{fmt(r.ownerIgnored)}</TableCell>}
              </TableRow>
            )))}
          </TableBody>
          <TableFooter>
            <TableRow className="font-semibold">
              <TableCell>Tổng</TableCell>
              <TableCell className="font-normal text-muted-foreground">{fmt(t.assignees)} dược sĩ · {fmt(t.stores.length)} cửa hàng</TableCell>
              <TableCell className="tabular-nums">{fmt(t.totals.customers)}</TableCell>
              <TableCell className={num}>{fmt(t.totals.created)}</TableCell>
              <TableCell className={num}>{fmt(t.totals.updated)}</TableCell>
              <TableCell className={num}>{fmt(t.totals.unchanged)}</TableCell>
              <TableCell className={num}>{fmt(t.totals.skipped)}</TableCell>
              {showIgnored && <TableCell className={num}>{fmt(t.totals.ownerIgnored)}</TableCell>}
            </TableRow>
          </TableFooter>
        </Table>
      </DataTableShell>
      {showIgnored && (
        <p className="text-xs text-muted-foreground">
          &quot;Giữ người hiện tại&quot;: khách đã có task kỳ này ở cửa hàng/dược sĩ khác file — import không đổi người phụ trách.
        </p>
      )}
    </div>
  )
}

// ── Bước 4: thay đổi sẽ áp dụng ───────────────────────────────────────────────
export function CareImportChanges({ counts }: { counts: CarePreviewCounts }) {
  const big: [string, number][] = [
    ['Task tạo mới', counts.created],
    ['Cập nhật', counts.updated],
    ['Giữ nguyên (đã có lượt)', counts.skipped_has_interaction],
  ]
  const rest: [string, number, StatusTone][] = [
    ['Không đổi', counts.unchanged, 'neutral'],
    ['File đổi dược sĩ — giữ người hiện tại', counts.owner_ignored, 'warning'],
    ['Khách vắng file — giữ nguyên task', counts.absent_kept, 'neutral'],
    ['Task kỳ trước sẽ đóng (Không hoàn thành)', counts.closed_previous_period, 'neutral'],
  ]
  return (
    <section aria-label="Thay đổi sẽ áp dụng" className={cn(INSET, 'space-y-3 p-4')}>
      <h3 className="text-sm font-semibold">Thay đổi sẽ áp dụng</h3>
      <dl className="grid grid-cols-3 gap-3">
        {big.map(([label, n]) => (
          <div key={label} className="flex flex-col-reverse gap-0.5">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-2xl font-bold tabular-nums">{fmt(n)}</dd>
          </div>
        ))}
      </dl>
      <ul className="space-y-1.5 border-t border-care-line pt-3 text-sm">
        {rest.map(([label, n, tone]) => (
          <li key={label} className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{label}</span>
            <StatusBadge tone={n > 0 ? tone : 'neutral'}>{fmt(n)}</StatusBadge>
          </li>
        ))}
      </ul>
    </section>
  )
}
