'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ClipboardList, Loader2, Search, Shuffle, X } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { StatusBadge, type StatusTone } from '@/components/ds/StatusBadge'
import {
  careApptHint, careFilterHref, careSearchTerm, careShortDateTime, careTaskState, CARE_STATUS_LABELS, CARE_TRANSFER_MAX_TASKS,
  type CareFilters,
} from '@/lib/care/browse'
import { CARE_OUTCOME_META, isCareOutcome } from '@/lib/care/outcome'
import { cn } from '@/lib/utils'
import { CareTransferDialog, type CareTransferActionResult, type CareTransferTarget } from './CareTransferDialog'
import { CareTaskDrawer, type CareTaskPanelLoader } from './CareTaskDrawer'
import type { CareLoadMoreInteractions } from './CareTimeline'

// Danh sách /care/tasks (SPEC B3 §2–3; B8.1 theo artboard 12). Một hàng = một task (khách/tháng).
// Phân trang server qua URL (chỉ khoá không PII); TÌM tên/SĐT đi qua action POST — không vào URL,
// tự áp dụng sau ~400 ms (≥2 ký tự), Enter chạy ngay; phản hồi cũ không ghi đè phản hồi mới.
// SĐT che TỪ SERVER (phone_masked — số đầy đủ không xuống client ở danh sách); số đầy đủ chỉ trong
// drawer/trang chi tiết sau kiểm quyền task (Q-115). Chọn nhiều + Chuyển giao chỉ SM/super, chỉ task
// đang mở của kỳ hiện tại trên trang đang thấy (≤500); đổi lọc/trang/từ khoá ⇒ bỏ chọn; Esc bỏ chọn.

export interface CareTaskListRow {
  id: string
  customer_name: string
  phone_masked: string
  status: 'open' | 'completed' | 'closed_unfinished'
  last_outcome: string | null
  last_interaction_at: string | null
  next_action_date: string | null
  store_id: string
  assignee_id: string
  store: { code: string; name: string } | null
  assignee: { full_name: string } | null
  /** B8.1: số sản phẩm hiện hành (is_current) — chỉ số đếm. */
  product_count: number
}

type SearchResult = { ok: true; rows: CareTaskListRow[]; total: number } | { ok: false; message: string }

const STATE_TONE: Record<string, StatusTone> = { not_cared: 'neutral', following: 'warning', completed: 'success', closed_unfinished: 'danger' }
const SEARCH_DELAY_MS = 400

export function CareTaskTable({
  rows: initialRows, total: initialTotal, pageSize, filters, path, todayISO, canTransfer, isCurrentPeriod,
  search, loadTargets, transfer, toolbar, loadPanel, loadMore, initialOpenId = null,
}: {
  rows: CareTaskListRow[]
  total: number
  pageSize: number
  filters: CareFilters
  path: string
  todayISO: string
  canTransfer: boolean
  isCurrentPeriod: boolean
  search: (input: { params: Record<string, string>; q: string; page: number }) => Promise<SearchResult>
  loadTargets: () => Promise<{ ok: true; staff: CareTransferTarget[] } | { ok: false; message: string }>
  transfer: (input: { taskIds: string[]; toUserId: string; note: string }) => Promise<CareTransferActionResult>
  /** Bộ lọc store/dược sĩ đặt trong thanh công cụ của bảng (trang truyền CareFiltersBar). */
  toolbar?: React.ReactNode
  /** Drawer chi tiết (B8.1); thiếu ⇒ tên khách chỉ là link sang trang chi tiết. */
  loadPanel?: CareTaskPanelLoader
  loadMore?: CareLoadMoreInteractions
  initialOpenId?: string | null
}) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const [result, setResult] = useState<{ rows: CareTaskListRow[]; total: number; page: number; term: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(loadPanel ? initialOpenId : null)
  // Tăng sau chuyển giao hàng loạt ⇒ drawer đang mở tải lại (khách vừa chuyển có thể đang hiển thị).
  const [drawerVer, setDrawerVer] = useState(0)
  const seq = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const rows = result?.rows ?? initialRows
  const total = result?.total ?? initialTotal
  const page = result?.page ?? filters.page
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const canSelect = canTransfer && isCurrentPeriod
  const transferable = (r: CareTaskListRow) => canSelect && r.status === 'open'
  const params: Record<string, string> = Object.fromEntries(Object.entries({
    month: filters.month, store: filters.storeId ?? '', assignee: filters.assigneeId ?? '', status: filters.status ?? '',
  }).filter(([, v]) => v))

  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }
  useEffect(() => clearTimer, [])

  async function runSearch(term: string, p: number) {
    clearTimer()
    // Mỗi lượt tìm có số thứ tự; chỉ phản hồi của lượt MỚI NHẤT được ghi (gõ nhanh / mạng chậm).
    const my = ++seq.current
    setSearching(true); setSearchErr(null); setSelected(new Set())
    try {
      const r = await search({ params, q: term, page: p })
      if (my !== seq.current) return
      if (r.ok) setResult({ rows: r.rows, total: r.total, page: p, term }); else { setResult(null); setSearchErr(r.message) }
    } catch {
      if (my === seq.current) { setResult(null); setSearchErr('Không tìm được — thử lại.') }
    } finally {
      if (my === seq.current) setSearching(false)
    }
  }

  function resetSearch() {
    clearTimer(); seq.current++
    setResult(null); setSearchErr(null); setSearching(false); setSelected(new Set())
  }

  function onQueryChange(v: string) {
    setQ(v); clearTimer(); setSelected(new Set())
    if (!careSearchTerm(v)) { resetSearch(); return }
    // PM r1: vô hiệu NGAY request đang chạy của từ khoá cũ — nếu nó về trong lúc chờ debounce, không
    // được hiện như kết quả mới. Spinner bật trong lúc chờ để không trông như đã có kết quả.
    seq.current++
    setSearching(true); setSearchErr(null)
    timer.current = setTimeout(() => { void runSearch(v, 1) }, SEARCH_DELAY_MS)
  }

  const selectedRows = rows.filter((r) => selected.has(r.id))
  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else if (n.size < CARE_TRANSFER_MAX_TASKS) n.add(id)
    return n
  })
  const pageable = rows.filter(transferable)
  const allOnPage = pageable.length > 0 && pageable.every((r) => selected.has(r.id))

  // Drawer `?open=<uuid>`: chỉ đổi URL tại chỗ (replaceState — không điều hướng/không tải lại danh sách),
  // giữ tháng/store/dược sĩ/trạng thái/trang; từ khoá tìm chỉ nằm trong state client.
  const setOpenParam = useCallback((id: string | null) => {
    const u = new URL(window.location.href)
    if (id) u.searchParams.set('open', id); else u.searchParams.delete('open')
    window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}`)
  }, [])
  const openPanel = (id: string) => { setOpenId(id); setOpenParam(id) }
  const closePanel = () => {
    const id = openId
    setOpenId(null); setOpenParam(null)
    if (id) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-open-task="${id}"]`)?.focus())
  }

  const flt = !!(filters.storeId || filters.assigneeId || filters.status)

  return (
    <div className="flex items-start gap-4" data-testid="care-task-table"
      onKeyDown={(e) => {
        // Esc bỏ chọn — không cướp Esc của hộp thoại/drawer (đã tự xử lý phía trong).
        if (e.key === 'Escape' && selected.size > 0 && !(e.target as HTMLElement).closest('[role="dialog"], aside')) {
          e.preventDefault(); setSelected(new Set())
        }
      }}>
      <section className="min-w-0 flex-1 overflow-hidden rounded-care-panel border border-care-line bg-card">
        {selected.size > 0 ? (
          <div className="flex min-h-[58px] flex-wrap items-center justify-between gap-2 border-b border-care-line bg-care-select px-3 py-2" data-testid="care-bulk-bar">
            <span className="text-sm font-semibold" role="status">Đã chọn {selected.size} khách</span>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" className="min-h-[44px] md:h-[36px] md:min-h-0" onClick={() => setSelected(new Set())}>Bỏ chọn</Button>
              <Button type="button" className="min-h-[44px] md:h-[36px] md:min-h-0" onClick={() => setDialog(true)}>
                <Shuffle className="size-4" /> Chuyển giao {selected.size} khách
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-[58px] flex-wrap items-center gap-2 border-b border-care-line px-3 py-2">
            <form className="relative w-full md:w-72" role="search" onSubmit={(e) => { e.preventDefault(); if (careSearchTerm(q)) void runSearch(q, 1); else resetSearch() }}>
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="Tìm theo tên hoặc SĐT" placeholder="Tìm theo tên hoặc SĐT…" value={q} enterKeyHint="search"
                onChange={(e) => onQueryChange(e.target.value)} className="h-[44px] pr-16 pl-8 text-[16px] md:h-[36px] md:text-sm" autoComplete="off" />
              {/* Đang tìm vẫn bấm "Bỏ tìm" được (huỷ kết quả đang bay — PM r1). */}
              <span className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-1">
                {searching && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Đang tìm" />}
                {(q || result) && (
                  <Button type="button" variant="ghost" size="icon-sm" className="size-[40px] md:size-7" aria-label="Bỏ tìm" onClick={() => { setQ(''); resetSearch() }}>
                    <X className="size-4" />
                  </Button>
                )}
              </span>
            </form>
            {toolbar}
            {canSelect && <span className="text-xs text-muted-foreground md:ml-auto">Tick ô đầu hàng để chuyển giao</span>}
          </div>
        )}
        {flash && <div role="status" className="border-b border-care-line px-3 py-2 text-sm"><StatusBadge tone="success">{flash}</StatusBadge></div>}
        {result && <p className="border-b border-care-line px-3 py-1.5 text-xs text-muted-foreground">Kết quả tìm “{result.term}”: {result.total.toLocaleString('vi-VN')} khách — số trên chip trạng thái chưa áp từ khoá.</p>}

        {searchErr ? (
          <div className="p-3"><ErrorState message={searchErr} /></div>
        ) : rows.length === 0 ? (
          <div className="p-3">
            <EmptyState icon={ClipboardList} title={result ? 'Không tìm thấy khách phù hợp' : 'Không có task theo bộ lọc này'}
              hint={flt ? 'Thử bỏ bớt bộ lọc trạng thái, cửa hàng hoặc dược sĩ.' : 'Thử đổi kỳ hoặc cửa hàng.'} />
          </div>
        ) : (
          <DataTableShell className="rounded-none py-0 ring-0">
            <Table>
              <TableHeader>
                <TableRow>
                  {canSelect && (
                    <TableHead className="w-12">
                      <input type="checkbox" aria-label="Chọn tất cả task đang mở trên trang" className="size-5 align-middle accent-primary"
                        checked={allOnPage} disabled={pageable.length === 0}
                        onChange={() => setSelected((s) => { const n = new Set(s); for (const r of pageable) { if (allOnPage) n.delete(r.id); else if (n.size < CARE_TRANSFER_MAX_TASKS) n.add(r.id) } return n })} />
                    </TableHead>
                  )}
                  <TableHead>Khách</TableHead>
                  <TableHead>SĐT</TableHead>
                  <TableHead>Cửa hàng</TableHead>
                  <TableHead>Dược sĩ</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead>Lượt gần nhất</TableHead>
                  <TableHead>Hẹn lại</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const st = careTaskState(r, todayISO)
                  const outcome = isCareOutcome(r.last_outcome) ? CARE_OUTCOME_META[r.last_outcome].label : null
                  const appt = careApptHint(r.next_action_date, todayISO, r.status === 'open')
                  return (
                    <TableRow key={r.id} data-state={selected.has(r.id) ? 'selected' : undefined} className={cn(openId === r.id && 'bg-muted/60')}>
                      {canSelect && (
                        <TableCell>
                          {transferable(r) && (
                            <label className="flex min-h-[44px] min-w-[44px] items-center md:min-h-0 md:min-w-0">
                              <input type="checkbox" className="size-5 accent-primary" aria-label={`Chọn ${r.customer_name}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                            </label>
                          )}
                        </TableCell>
                      )}
                      <TableCell className="max-w-[220px]">
                        <Link href={`/care/tasks/${r.id}`} data-open-task={r.id} title={r.customer_name}
                          className="block min-h-[44px] truncate pt-2 font-medium text-primary hover:underline md:min-h-0 md:pt-0"
                          onClick={(e) => {
                            // Click thường mở drawer; Ctrl/Meta/Shift/Alt hoặc chuột giữa vẫn mở trang chi tiết.
                            if (!loadPanel || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
                            e.preventDefault(); openPanel(r.id)
                          }}>
                          {r.customer_name}
                        </Link>
                        <span className="block text-xs text-muted-foreground">{r.product_count} sản phẩm</span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">{r.phone_masked}</TableCell>
                      <TableCell className="whitespace-nowrap" title={r.store?.name}>{r.store?.code ?? '—'}</TableCell>
                      <TableCell className="max-w-[180px] truncate">{r.assignee?.full_name ?? '—'}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <StatusBadge tone={STATE_TONE[st.key]}>{CARE_STATUS_LABELS[st.key]}</StatusBadge>
                          {st.overdueOpen && <StatusBadge tone="danger">Quá hạn</StatusBadge>}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[220px]">
                        {outcome ? (
                          <>
                            <span className="block truncate" title={outcome}>{outcome}</span>
                            <span className="block text-xs text-muted-foreground tabular-nums">{careShortDateTime(r.last_interaction_at)}</span>
                          </>
                        ) : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {appt ? (
                          <>
                            <span className={cn('block tabular-nums', appt.overdue && 'text-status-danger')}>{appt.date}</span>
                            {appt.hint && <span className={cn('block text-xs', appt.overdue ? 'text-status-danger' : 'text-muted-foreground')}>{appt.hint}</span>}
                          </>
                        ) : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </DataTableShell>
        )}

        <nav className="flex flex-wrap items-center justify-end gap-2 border-t border-care-line px-3 py-2 text-sm" aria-label="Phân trang">
          <span className="mr-auto text-muted-foreground">{total.toLocaleString('vi-VN')} task · trang {page}/{pages}</span>
          {pages > 1 && (result ? (
            <>
              <Button variant="outline" size="sm" className="min-h-[44px] md:min-h-0" disabled={page <= 1 || searching} onClick={() => runSearch(result.term, page - 1)}>Trước</Button>
              <Button variant="outline" size="sm" className="min-h-[44px] md:min-h-0" disabled={page >= pages || searching} onClick={() => runSearch(result.term, page + 1)}>Sau</Button>
            </>
          ) : (
            <>
              <Link aria-disabled={page <= 1} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-h-[44px] md:min-h-0', page <= 1 && 'pointer-events-none opacity-50')} href={careFilterHref(path, filters, { page: page - 1 })}>Trước</Link>
              <Link aria-disabled={page >= pages} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-h-[44px] md:min-h-0', page >= pages && 'pointer-events-none opacity-50')} href={careFilterHref(path, filters, { page: page + 1 })}>Sau</Link>
            </>
          ))}
        </nav>
      </section>

      {loadPanel && openId && (
        <CareTaskDrawer key={`${openId}:${drawerVer}`} taskId={openId} onClose={closePanel} load={loadPanel} loadMore={loadMore}
          loadTargets={loadTargets} transfer={transfer} todayISO={todayISO} />
      )}

      {canSelect && (
        <CareTransferDialog
          open={dialog}
          onOpenChange={setDialog}
          tasks={selectedRows.map((r) => ({ id: r.id, customerName: r.customer_name, storeId: r.store_id, storeCode: r.store?.code ?? '—', assigneeId: r.assignee_id, assigneeName: r.assignee?.full_name ?? '—' }))}
          loadTargets={loadTargets}
          transfer={transfer}
          onDone={(n) => { setSelected(new Set()); setQ(''); resetSearch(); setFlash(`Đã chuyển giao ${n} khách`); setDrawerVer((v) => v + 1); router.refresh() }}
        />
      )}
    </div>
  )
}
