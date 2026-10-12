'use client'

import { useState } from 'react'
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
import { careFilterHref, careTaskState, CARE_STATUS_LABELS, type CareFilters } from '@/lib/care/browse'
import { CARE_OUTCOME_META, isCareOutcome } from '@/lib/care/outcome'
import { cn } from '@/lib/utils'
import { CareTransferDialog, type CareTransferActionResult, type CareTransferTarget } from './CareTransferDialog'

// Danh sách /care/tasks (SPEC B3 §2–3). Một hàng = một task (khách/tháng). Phân trang
// server qua URL (chỉ khoá không PII); TÌM tên/SĐT đi qua action POST — không vào URL.
// SĐT che TỪ SERVER (phone_masked — số đầy đủ không xuống client ở danh sách);
// TODO(Q-30): mặc định đề xuất — chi tiết mới hiện đầy đủ.
// Chọn nhiều + Chuyển giao chỉ cho SM/super, chỉ task đang mở của kỳ hiện tại.

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
}

type SearchResult = { ok: true; rows: CareTaskListRow[]; total: number } | { ok: false; message: string }

const STATE_TONE: Record<string, StatusTone> = { not_cared: 'neutral', following: 'warning', completed: 'success', closed_unfinished: 'danger' }
const dmy = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '—')

export function CareTaskTable({
  rows: initialRows, total: initialTotal, pageSize, filters, path, todayISO, canTransfer, isCurrentPeriod,
  search, loadTargets, transfer,
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
}) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const [result, setResult] = useState<{ rows: CareTaskListRow[]; total: number; page: number } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

  const rows = result?.rows ?? initialRows
  const total = result?.total ?? initialTotal
  const page = result?.page ?? filters.page
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const transferable = (r: CareTaskListRow) => canTransfer && isCurrentPeriod && r.status === 'open'
  const params: Record<string, string> = Object.fromEntries(Object.entries({
    month: filters.month, store: filters.storeId ?? '', assignee: filters.assigneeId ?? '', status: filters.status ?? '',
  }).filter(([, v]) => v))

  async function runSearch(p = 1) {
    if (!q.trim()) { setResult(null); setSearchErr(null); return }
    // Đổi trang/kết quả ⇒ bỏ chọn cũ (lệnh chuyển giao chỉ gồm task đang thấy).
    setSearching(true); setSearchErr(null); setSelected(new Set())
    try {
      const r = await search({ params, q, page: p })
      if (r.ok) setResult({ rows: r.rows, total: r.total, page: p }); else setSearchErr(r.message)
    } catch { setSearchErr('Không tìm được — thử lại.') } finally { setSearching(false) }
  }

  const selectedRows = rows.filter((r) => selected.has(r.id))
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const pageable = rows.filter(transferable)
  const allOnPage = pageable.length > 0 && pageable.every((r) => selected.has(r.id))

  return (
    <div className="space-y-3" data-testid="care-task-table">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void runSearch(1) }}>
        <div className="relative w-full md:w-80">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Tìm theo tên hoặc SĐT" placeholder="Tìm theo tên hoặc SĐT…" value={q}
            onChange={(e) => setQ(e.target.value)} className="h-[44px] pl-8 text-[16px] md:h-[36px] md:text-sm" autoComplete="off" />
        </div>
        <Button type="submit" variant="outline" className="min-h-[44px] md:h-[36px] md:min-h-0" disabled={searching}>
          {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />} Tìm
        </Button>
        {result && (
          <Button type="button" variant="ghost" className="min-h-[44px] md:h-[36px] md:min-h-0" onClick={() => { setQ(''); setResult(null); setSearchErr(null); setSelected(new Set()) }}>
            <X className="size-4" /> Bỏ tìm
          </Button>
        )}
        {canTransfer && isCurrentPeriod && (
          <Button type="button" className="min-h-[44px] md:ml-auto md:h-[36px] md:min-h-0" disabled={selectedRows.length === 0} title={selectedRows.length === 0 ? 'Tick chọn khách ở cột đầu để chuyển giao' : undefined} onClick={() => setDialog(true)}>
            <Shuffle className="size-4" /> Chuyển giao{selectedRows.length ? ` (${selectedRows.length})` : ''}
          </Button>
        )}
      </form>
      {flash && <div role="status" className="flex items-center gap-2 text-sm"><StatusBadge tone="success">{flash}</StatusBadge></div>}
      {searchErr && <ErrorState message={searchErr} />}

      {rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title={result ? 'Không tìm thấy khách phù hợp' : 'Không có task theo bộ lọc này'} hint="Thử đổi kỳ, cửa hàng hoặc trạng thái." />
      ) : (
        <DataTableShell>
          <Table>
            <TableHeader>
              <TableRow>
                {canTransfer && isCurrentPeriod && (
                  <TableHead className="w-12">
                    <input type="checkbox" aria-label="Chọn tất cả task đang mở trên trang" className="size-5 align-middle"
                      checked={allOnPage} disabled={pageable.length === 0}
                      onChange={() => setSelected((s) => { const n = new Set(s); for (const r of pageable) { if (allOnPage) n.delete(r.id); else n.add(r.id) } return n })} />
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
                return (
                  <TableRow key={r.id} data-state={selected.has(r.id) ? 'selected' : undefined}>
                    {canTransfer && isCurrentPeriod && (
                      <TableCell>
                        {transferable(r) && (
                          <label className="flex min-h-[44px] min-w-[44px] items-center md:min-h-0 md:min-w-0">
                            <input type="checkbox" className="size-5" aria-label={`Chọn ${r.customer_name}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                          </label>
                        )}
                      </TableCell>
                    )}
                    <TableCell className="max-w-[200px]">
                      <Link href={`/care/tasks/${r.id}`} className="block min-h-[44px] truncate py-2 font-medium text-primary hover:underline md:min-h-0 md:py-0" title={r.customer_name}>{r.customer_name}</Link>
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
                    <TableCell className="max-w-[200px] truncate text-muted-foreground">{outcome ? `${outcome} · ${dmy(r.last_interaction_at?.slice(0, 10) ?? null)}` : '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">{dmy(r.next_action_date)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </DataTableShell>
      )}

      {pages > 1 && (
        <nav className="flex items-center justify-end gap-2 text-sm" aria-label="Phân trang">
          <span className="text-muted-foreground">{total.toLocaleString('vi-VN')} task · trang {page}/{pages}</span>
          {result ? (
            <>
              <Button variant="outline" size="sm" className="min-h-[44px] md:min-h-0" disabled={page <= 1 || searching} onClick={() => runSearch(page - 1)}>Trước</Button>
              <Button variant="outline" size="sm" className="min-h-[44px] md:min-h-0" disabled={page >= pages || searching} onClick={() => runSearch(page + 1)}>Sau</Button>
            </>
          ) : (
            <>
              <Link aria-disabled={page <= 1} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-h-[44px] md:min-h-0', page <= 1 && 'pointer-events-none opacity-50')} href={careFilterHref(path, filters, { page: page - 1 })}>Trước</Link>
              <Link aria-disabled={page >= pages} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-h-[44px] md:min-h-0', page >= pages && 'pointer-events-none opacity-50')} href={careFilterHref(path, filters, { page: page + 1 })}>Sau</Link>
            </>
          )}
        </nav>
      )}

      {canTransfer && isCurrentPeriod && (
        <CareTransferDialog
          open={dialog}
          onOpenChange={setDialog}
          tasks={selectedRows.map((r) => ({ id: r.id, customerName: r.customer_name, storeId: r.store_id, storeCode: r.store?.code ?? '—', assigneeId: r.assignee_id, assigneeName: r.assignee?.full_name ?? '—' }))}
          loadTargets={loadTargets}
          transfer={transfer}
          onDone={(n) => { setSelected(new Set()); setResult(null); setFlash(`Đã chuyển giao ${n} khách`); router.refresh() }}
        />
      )}
    </div>
  )
}
