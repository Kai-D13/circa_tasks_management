'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, ChevronRight, ClipboardList, Loader2, Search, Users, X } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatCard } from '@/components/ds/StatCard'
import { FilterTabs } from '@/components/ds/FilterTabs'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { CARE_MY_FILTERS, CARE_MY_FILTER_LABELS, careMyBadge, myFilterHref, type CareMyFilter } from '@/lib/care/my'
import { CARE_OUTCOME_META, isCareOutcome } from '@/lib/care/outcome'
import { cn } from '@/lib/utils'

// "Khách hàng của tôi" (SPEC B4 §2) — mobile-first. Thẻ = một khách/task kỳ hiện tại dù
// nhiều sản phẩm; KHÔNG tải sản phẩm/ảnh/timeline ở đây. Bộ lọc + trang qua URL (không
// PII); tìm tên/SĐT qua action POST. SĐT đã che từ server.

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

function TaskCard({ r, todayISO, basePath }: { r: CareMyRow; todayISO: string; basePath: string }) {
  const b = careMyBadge(r, todayISO)
  const outcome = isCareOutcome(r.last_outcome) ? CARE_OUTCOME_META[r.last_outcome].label : null
  return (
    <li>
      <Link href={`${basePath}/${r.id}`} prefetch={false}
        className="flex min-h-[44px] items-center gap-3 rounded-lg border bg-card p-3 active:bg-muted/60">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate font-medium" title={r.customer_name}>{r.customer_name}</p>
          <p className="text-xs tabular-nums text-muted-foreground">{r.phone_masked}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={b.tone}>{b.label}</StatusBadge>
            {outcome && !b.label.startsWith(outcome) && <span className="truncate text-xs text-muted-foreground">{outcome}</span>}
          </div>
        </div>
        <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  )
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
    <div className="space-y-4" data-testid="care-my-home">
      {/* Các nhóm có thể giao nhau (một khách vừa Đang theo dõi vừa Quá hạn) — không cộng thành tổng. */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatCard label="Được giao" value={summary.assigned} icon={Users} />
        <StatCard label="Chưa chăm sóc" value={summary.notCared} icon={ClipboardList} />
        <StatCard label="Hoàn thành" value={summary.completed} icon={CheckCircle2} tone="success" />
        <StatCard label="Quá hạn đang mở" value={summary.overdueLive} icon={AlertTriangle} tone={summary.overdueLive > 0 ? 'danger' : 'default'} />
      </div>

      <FilterTabs ariaLabel="Lọc khách" activeKey={filter}
        tabs={CARE_MY_FILTERS.map((k) => ({ key: k, label: CARE_MY_FILTER_LABELS[k], href: myFilterHref(k).replace('/care/my', basePath) }))} />

      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void runSearch(1) }}>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Tìm tên hoặc SĐT khách" placeholder="Tìm tên hoặc SĐT…" value={q} autoComplete="off"
            onChange={(e) => setQ(e.target.value)} className="h-[44px] pl-8 text-[16px] md:h-9 md:text-sm" />
        </div>
        <Button type="submit" variant="outline" className="min-h-[44px] md:min-h-0" disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}<span className="sr-only md:not-sr-only">Tìm</span>
        </Button>
        {result && (
          <Button type="button" variant="ghost" className="min-h-[44px] md:min-h-0" aria-label="Bỏ tìm" onClick={() => { setQ(''); setResult(null); setErr(null) }}>
            <X className="size-4" />
          </Button>
        )}
      </form>

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
