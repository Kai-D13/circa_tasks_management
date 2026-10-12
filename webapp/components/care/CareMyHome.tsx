'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, ClipboardList, Loader2, Search, X } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FilterTabs } from '@/components/ds/FilterTabs'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { CARE_MY_FILTERS, CARE_MY_FILTER_LABELS, careMyBadge, myFilterHref, type CareMyFilter } from '@/lib/care/my'
import { CARE_OUTCOME_META, isCareOutcome } from '@/lib/care/outcome'
import { periodLastDay, periodOfDate, vnDateISO } from '@/lib/care/time'
import { cn } from '@/lib/utils'

// "Khách hàng của tôi" (SPEC B4 §2) — mobile-first. Thẻ = một khách/task kỳ hiện tại dù
// nhiều sản phẩm; KHÔNG tải sản phẩm/ảnh/timeline ở đây. Bộ lọc + trang qua URL (không
// PII); tìm tên/SĐT qua action POST. SĐT đã che từ server.
// B7-ui (M03/M04): 4 thẻ số → 1 khối tiến độ + số đếm ngay trên chip lọc (khách đầu tiên
// lên màn đầu); thẻ khách thêm "Lần cuối dd/mm". Số liệu vẫn từ care_my_summary, không đổi.

export interface CareMyRow {
  id: string
  customer_name: string
  phone_masked: string
  status: 'open' | 'completed' | 'closed_unfinished'
  last_outcome: string | null
  last_interaction_at: string | null
  next_action_date: string | null
  due_date: string
}
export interface CareMySummaryView { assigned: number; notCared: number; completed: number; overdueLive: number }
type SearchFn = (input: { filter: CareMyFilter; q: string; page: number }) =>
  Promise<{ ok: true; rows: CareMyRow[]; total: number } | { ok: false; message: string }>

const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

// B7-ui r2 (artboard 08): thẻ gọn — tên + badge cùng hàng (xuống dòng khi hẹp), dòng phụ SĐT che ·
// lần cuối (chưa chăm sóc: hạn kỳ) · kết quả gần nhất. Không nút gọi trên thẻ (Q-108: Gọi/Nhắn chỉ ở chi tiết).
function TaskCard({ r, todayISO, basePath }: { r: CareMyRow; todayISO: string; basePath: string }) {
  const b = careMyBadge(r, todayISO)
  const outcome = isCareOutcome(r.last_outcome) ? CARE_OUTCOME_META[r.last_outcome].label : null
  const last = r.last_interaction_at ? dm(vnDateISO(new Date(r.last_interaction_at))) : null
  return (
    <li>
      <Link href={`${basePath}/${r.id}`} prefetch={false}
        className="flex min-h-[64px] items-center gap-3 rounded-care-card border border-care-line bg-card py-3 pr-3 pl-4 active:bg-muted/60">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="max-w-full truncate text-[16px] leading-tight font-semibold" title={r.customer_name}>{r.customer_name}</p>
            <StatusBadge tone={b.tone}>{b.label}</StatusBadge>
          </div>
          <p className="line-clamp-2 text-[13px] tabular-nums text-muted-foreground">
            {r.phone_masked}{last ? <> · Lần cuối {last}</> : <> · Hạn {dm(r.due_date)}</>}
            {outcome && !b.label.startsWith(outcome) && <> · {outcome}</>}
          </p>
        </div>
        <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  )
}

/** Khối tiến độ kỳ: thay 4 thẻ số (M03). Các nhóm còn lại hiện thành số đếm trên chip lọc. */
function ProgressSummary({ summary, todayISO }: { summary: CareMySummaryView; todayISO: string }) {
  const period = periodOfDate(todayISO)
  const pct = summary.assigned > 0 ? Math.round((summary.completed / summary.assigned) * 100) : 0
  return (
    <section aria-label="Tiến độ trong tháng" className="space-y-2.5 rounded-care-card border border-care-line bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-[15px] text-muted-foreground">
          <span className="text-[22px] font-bold tabular-nums text-foreground">{summary.completed}</span>
          <span className="tabular-nums">/{summary.assigned}</span> khách đã hoàn thành
        </p>
        <p className="text-[13px] text-muted-foreground">Tháng {period.slice(5, 7)} · hạn {dm(periodLastDay(period))}</p>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Tỉ lệ hoàn thành"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="h-full rounded-full bg-status-success" style={{ width: `${pct}%` }} />
      </div>
    </section>
  )
}

function filterCount(s: CareMySummaryView, k: CareMyFilter): number {
  return k === 'all' ? s.assigned : k === 'not_cared' ? s.notCared : k === 'overdue' ? s.overdueLive : s.completed
}

export function CareMyHome({
  summary, rows: initialRows, total: initialTotal, filter, page: initialPage, pageSize, todayISO, search, basePath = '/care/my',
}: {
  summary: CareMySummaryView
  rows: CareMyRow[]
  total: number
  filter: CareMyFilter
  page: number
  pageSize: number
  todayISO: string
  search: SearchFn
  basePath?: string
}) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<{ rows: CareMyRow[]; total: number; page: number } | null>(null)
  const inflight = useRef(false)

  const rows = result?.rows ?? initialRows
  const total = result?.total ?? initialTotal
  const page = result?.page ?? initialPage
  const pages = Math.max(1, Math.ceil(total / pageSize))

  async function runSearch(p = 1) {
    if (!q.trim()) { setResult(null); setErr(null); return }
    if (inflight.current) return
    inflight.current = true
    setBusy(true); setErr(null)
    try {
      const r = await search({ filter, q, page: p })
      if (r.ok) setResult({ rows: r.rows, total: r.total, page: p }); else setErr(r.message)
    } catch { setErr('Không tìm được — thử lại.') } finally { inflight.current = false; setBusy(false) }
  }

  return (
    <div className="space-y-3" data-testid="care-my-home">
      <ProgressSummary summary={summary} todayISO={todayISO} />

      {/* Số trên chip là số đếm của cả kỳ (care_my_summary). Các nhóm có thể giao nhau (một khách
          vừa Đang theo dõi vừa Quá hạn) — không cộng thành tổng. */}
      <FilterTabs ariaLabel="Lọc khách" activeKey={filter} variant="chip" className="-mx-4 px-4 md:mx-0 md:px-0"
        tabs={CARE_MY_FILTERS.map((k) => ({ key: k, label: CARE_MY_FILTER_LABELS[k], count: filterCount(summary, k), href: myFilterHref(k).replace('/care/my', basePath) }))} />

      {/* B7-ui r2 (artboard 08): MỘT ô tìm, gửi bằng phím Tìm/Enter của bàn phím (POST — SĐT không lên URL);
          bên phải: vòng quay khi đang tìm, ✕ bỏ tìm khi đang xem kết quả. */}
      <form role="search" onSubmit={(e) => { e.preventDefault(); void runSearch(1) }}
        className="relative flex items-center">
        <Search className="pointer-events-none absolute left-3.5 size-[18px] text-muted-foreground" aria-hidden />
        <Input type="search" enterKeyHint="search" aria-label="Tìm tên hoặc SĐT khách" placeholder="Tìm tên hoặc SĐT" value={q} autoComplete="off"
          onChange={(e) => setQ(e.target.value)}
          className="h-[44px] rounded-care-field border-care-line-strong bg-card pr-12 pl-10 text-[16px] md:h-9 md:text-sm [&::-webkit-search-cancel-button]:appearance-none" />
        <div className="absolute right-0 flex">
          {busy ? (
            <span className="flex size-[44px] items-center justify-center" role="status" aria-label="Đang tìm"><Loader2 className="size-4 animate-spin text-muted-foreground" /></span>
          ) : result ? (
            <Button type="button" variant="ghost" className="size-[44px] px-0" aria-label="Bỏ tìm" onClick={() => { setQ(''); setResult(null); setErr(null) }}>
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
      </form>

      <p className="px-0.5 text-[13px] text-muted-foreground" aria-live="polite">{total} khách{result ? ' khớp tìm kiếm' : ''}</p>

      {err && <ErrorState message={err} />}
      {rows.length === 0 ? (
        <EmptyState icon={ClipboardList}
          title={result ? 'Không tìm thấy khách phù hợp' : page > 1 && total > 0 ? 'Trang này không có khách' : filter === 'all' ? 'Chưa có khách nào được giao trong tháng' : 'Không có khách theo bộ lọc này'}
          hint={!result && page > 1 && total > 0 ? 'Quay về trang 1 của danh sách.' : undefined} />
      ) : (
        <ul className="space-y-2" aria-label="Danh sách khách">
          {rows.map((r) => <TaskCard key={r.id} r={r} todayISO={todayISO} basePath={basePath} />)}
        </ul>
      )}

      {pages > 1 && (
        <nav className="flex items-center justify-between gap-2 text-sm" aria-label="Phân trang">
          <span className="text-muted-foreground">Trang {page}/{pages} · {total} khách</span>
          <div className="flex gap-2">
            {result ? (
              <>
                <Button variant="outline" className="min-h-[44px] md:min-h-0" disabled={page <= 1 || busy} onClick={() => runSearch(page - 1)}>Trước</Button>
                <Button variant="outline" className="min-h-[44px] md:min-h-0" disabled={page >= pages || busy} onClick={() => runSearch(page + 1)}>Sau</Button>
              </>
            ) : (
              <>
                <Link aria-disabled={page <= 1} className={cn(buttonVariants({ variant: 'outline' }), 'min-h-[44px] md:min-h-0', page <= 1 && 'pointer-events-none opacity-50')}
                  href={myFilterHref(filter, page - 1).replace('/care/my', basePath)}>Trước</Link>
                <Link aria-disabled={page >= pages} className={cn(buttonVariants({ variant: 'outline' }), 'min-h-[44px] md:min-h-0', page >= pages && 'pointer-events-none opacity-50')}
                  href={myFilterHref(filter, page + 1).replace('/care/my', basePath)}>Sau</Link>
              </>
            )}
          </div>
        </nav>
      )}
    </div>
  )
}
