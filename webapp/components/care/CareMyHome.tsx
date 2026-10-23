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
import { CARE_IMPORT_NO_DATA_HINT, appendNewById, type CareImportCountState } from '@/lib/care/orderLinks/view'
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
type SearchFn = (input: { filter: CareMyFilter; q: string; page: number; orders?: boolean }) =>
  Promise<{ ok: true; rows: CareMyRow[]; total: number } | { ok: false; message: string }>
type MoreFn = (input: { cursor: string }) => Promise<{ ok: true; rows: CareMyRow[]; next: string | null } | { ok: false; message: string }>

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
  summary, rows: initialRows, total: initialTotal, filter, page: initialPage, pageSize, todayISO, search, basePath = '/care/my', ordersChip, ordersList, ordersNote,
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
  /** E3 (cờ CARE_ORDER_LINKS_UI_ENABLED): chip "Có đơn xác thực" — số task kỳ hiện tại có ≥ 1 đơn N3 sau import. */
  ordersChip?: { count?: number; active: boolean }
  /** E3 r1.1: đang ở chip "Có đơn xác thực" — trang đầu keyset + cursor "Xem thêm" (POST); `total` = số trên chip (null khi không đọc được). */
  ordersList?: { next: string | null; total: number | null; loadMore: MoreFn; state?: CareImportCountState }
  /** PM 22/10 F1: cảnh báo số đơn chưa đầy đủ (lượt lỗi / quá 24 giờ / quét một phần) kèm mốc — hiện cạnh chip / danh sách chip. */
  ordersNote?: string | null
}) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<{ rows: CareMyRow[]; total: number; page: number } | null>(null)
  const inflight = useRef(false)
  const [more, setMore] = useState<{ rows: CareMyRow[]; next: string | null }>({ rows: initialRows, next: ordersList?.next ?? null })
  const [moreBusy, setMoreBusy] = useState(false)
  const [moreErr, setMoreErr] = useState<string | null>(null)

  const rows = result?.rows ?? (ordersList ? more.rows : initialRows)
  const total = result?.total ?? initialTotal
  const page = result?.page ?? initialPage
  const pages = Math.max(1, Math.ceil(total / pageSize))
  // Chip "Có đơn": tổng của cả nhóm (số trên chip) — danh sách nối dần bằng "Xem thêm", không phân trang theo số.
  const ordersTotal = ordersList?.total === null || ordersList?.total === undefined ? null : Math.max(ordersList.total, more.rows.length)
  // PM 22/10 P1 "số 0 giả": chỉ kết luận "không có đơn" / đếm khi BIẾT phạm vi đã quét ('full' | 'partial'); 'none' hoặc không đọc
  // được trạng thái (summary lỗi ⇒ undefined) ⇒ "Chưa có dữ liệu đơn", không câu kết luận.
  const ordersKnown = ordersList?.state === 'full' || ordersList?.state === 'partial'
  const ordersCountText = !ordersList ? null
    : !ordersKnown && rows.length === 0 ? 'Chưa có dữ liệu đơn'
    : !ordersKnown ? `Đang hiện ${rows.length} khách có đơn xác thực · chưa đủ dữ liệu để kết luận cả tháng`
    : ordersTotal === null ? `Đang hiện ${rows.length} khách có đơn xác thực`
    : `${ordersTotal} khách có đơn xác thực${rows.length < ordersTotal ? ` · đang hiện ${rows.length}` : ''}${ordersList.state === 'partial' ? ' · đang cập nhật một phần' : ''}`
  const ordersEmpty = !ordersList ? null
    : ordersKnown ? { title: 'Chưa có khách nào có đơn xác thực trong tháng', hint: ordersList.state === 'partial' ? 'Còn khách chưa được quét đơn — số sẽ đủ sau lượt đồng bộ kế tiếp.' : undefined }
    : { title: 'Chưa có dữ liệu đơn', hint: CARE_IMPORT_NO_DATA_HINT }

  async function loadMore() {
    if (!ordersList || !more.next || inflight.current) return
    inflight.current = true
    setMoreBusy(true); setMoreErr(null)
    try {
      const r = await ordersList.loadMore({ cursor: more.next })
      if (r.ok) setMore((cur) => ({ rows: appendNewById(cur.rows, r.rows), next: r.next })); else setMoreErr(r.message)
    } catch { setMoreErr('Không tải được danh sách — tải lại trang.') } finally { inflight.current = false; setMoreBusy(false) }
  }

  async function runSearch(p = 1) {
    if (!q.trim()) { setResult(null); setErr(null); return }
    if (inflight.current) return
    inflight.current = true
    setBusy(true); setErr(null)
    try {
      const r = await search({ filter, q, page: p, ...(ordersList ? { orders: true } : {}) })
      if (r.ok) setResult({ rows: r.rows, total: r.total, page: p }); else setErr(r.message)
    } catch { setErr('Không tìm được — thử lại.') } finally { inflight.current = false; setBusy(false) }
  }

  return (
    <div className="space-y-3" data-testid="care-my-home">
      <ProgressSummary summary={summary} todayISO={todayISO} />

      {/* Số trên chip là số đếm của cả kỳ (care_my_summary). Các nhóm có thể giao nhau (một khách
          vừa Đang theo dõi vừa Quá hạn) — không cộng thành tổng. */}
      <FilterTabs ariaLabel="Lọc khách" activeKey={ordersChip?.active ? 'orders' : filter} variant="chip" className="-mx-4 px-4 md:mx-0 md:px-0"
        tabs={[...CARE_MY_FILTERS.map((k) => ({ key: k, label: CARE_MY_FILTER_LABELS[k], count: filterCount(summary, k), href: myFilterHref(k).replace('/care/my', basePath) })),
          ...(ordersChip ? [{ key: 'orders', label: 'Có đơn xác thực', count: ordersChip.count, href: `${basePath}?filter=orders` }] : [])]} />
      {ordersNote && (ordersChip || ordersList) && (
        <p role="note" data-testid="care-my-orders-note" className="rounded-lg border border-status-warning/40 bg-status-warning-bg px-3 py-2 text-[13px] break-words text-status-warning">
          {ordersNote}
        </p>
      )}

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

      <p className="px-0.5 text-[13px] text-muted-foreground" aria-live="polite" data-testid="care-my-count">
        {ordersCountText !== null && !result ? ordersCountText
          : <>{total} khách{result ? (ordersList ? ' có đơn khớp tìm kiếm' : ' khớp tìm kiếm') : ''}</>}
      </p>

      {err && <ErrorState message={err} />}
      {rows.length === 0 ? (
        <EmptyState icon={ClipboardList}
          title={result ? 'Không tìm thấy khách phù hợp' : ordersEmpty ? ordersEmpty.title : page > 1 && total > 0 ? 'Trang này không có khách' : filter === 'all' ? 'Chưa có khách nào được giao trong tháng' : 'Không có khách theo bộ lọc này'}
          hint={result ? undefined : ordersEmpty ? ordersEmpty.hint : page > 1 && total > 0 ? 'Quay về trang 1 của danh sách.' : undefined} />
      ) : (
        <ul className="space-y-2" aria-label="Danh sách khách">
          {rows.map((r) => <TaskCard key={r.id} r={r} todayISO={todayISO} basePath={basePath} />)}
        </ul>
      )}

      {ordersList && !result && (more.next || moreErr) && (
        <div className="flex flex-col items-center gap-2">
          {more.next && (
            <Button type="button" variant="outline" className="min-h-[44px] w-full md:w-auto md:min-h-0" disabled={moreBusy} onClick={() => void loadMore()}>
              {moreBusy && <Loader2 className="size-4 animate-spin" aria-hidden />} Xem thêm
            </Button>
          )}
          {moreErr && <p role="alert" className="text-[13px] text-status-danger">{moreErr}</p>}
        </div>
      )}

      {pages > 1 && (!ordersList || result) && (
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
