'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { getEffectiveStatus, formatDate } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { ChevronRight, Search } from 'lucide-react'

export interface TrfRow {
  id: string
  trf_code: string
  reason: string | null
  internal_created_by: string | null
  pos_code: string | null
  store_name: string | null
  store_id: string | null
  status: string
  deadline: string | null
  completed_by_name: string | null
}

type StatusKey = 'overdue' | 'pending' | 'done'

function effKey(r: TrfRow): StatusKey {
  const e = getEffectiveStatus(r.deadline, r.status)
  if (e === 'done') return 'done'
  if (e === 'overdue') return 'overdue'
  return 'pending'
}

const STATUS_META: Record<StatusKey, { label: string; cls: string }> = {
  overdue: { label: 'Quá hạn', cls: 'bg-red-100 text-red-700' },
  pending: { label: 'Chờ nộp', cls: 'bg-amber-100 text-amber-700' },
  done:    { label: 'Đã nộp',  cls: 'bg-green-100 text-green-700' },
}
const RANK: Record<StatusKey, number> = { overdue: 0, pending: 1, done: 2 }

const deburr = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

function TrfRowItem({ r }: { r: TrfRow }) {
  const m = STATUS_META[effKey(r)]
  return (
    <Link
      href={`/tasks/${r.id}`}
      className="flex items-center gap-3 px-4 py-3 border-t first:border-t-0 hover:bg-muted/30 transition-colors"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sm truncate">{r.trf_code}</p>
        <p className="text-xs text-muted-foreground mt-0.5 truncate">
          {r.reason ?? '—'}{r.internal_created_by ? ` · Người tạo phiếu: ${r.internal_created_by}` : ''}
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Hạn {r.deadline ? formatDate(r.deadline) : '—'}{r.completed_by_name ? ` · Đã nộp: ${r.completed_by_name}` : ''}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className={cn('text-xs px-2 py-0.5 rounded font-medium', m.cls)}>{m.label}</span>
        <span className="flex items-center gap-0.5 text-[11px] text-primary font-medium">
          Mở phiếu <ChevronRight className="h-3 w-3" />
        </span>
      </div>
    </Link>
  )
}

export function TrfBoard({ rows, isAllStores }: { rows: TrfRow[]; isAllStores: boolean }) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | StatusKey>('all')

  const counts = useMemo(() => {
    const c = { total: rows.length, overdue: 0, pending: 0, done: 0 }
    for (const r of rows) c[effKey(r)]++
    return c
  }, [rows])

  const filtered = useMemo(() => {
    const term = deburr(q.trim())
    let list = rows
    if (filter !== 'all') list = list.filter((r) => effKey(r) === filter)
    if (term) {
      list = list.filter((r) =>
        deburr(`${r.trf_code} ${r.pos_code ?? ''} ${r.store_name ?? ''} ${r.internal_created_by ?? ''} ${r.reason ?? ''}`).includes(term))
    }
    return [...list].sort((a, b) => {
      const d = RANK[effKey(a)] - RANK[effKey(b)]
      return d !== 0 ? d : (a.deadline ?? '').localeCompare(b.deadline ?? '')
    })
  }, [rows, q, filter])

  const chips: { key: 'all' | StatusKey; label: string; cls: string }[] = [
    { key: 'all',     label: `Tổng ${counts.total}`,      cls: 'bg-muted text-foreground' },
    { key: 'pending', label: `Chờ nộp ${counts.pending}`, cls: 'bg-amber-100 text-amber-700' },
    { key: 'overdue', label: `Quá hạn ${counts.overdue}`, cls: 'bg-red-100 text-red-700' },
    { key: 'done',    label: `Đã nộp ${counts.done}`,     cls: 'bg-green-100 text-green-700' },
  ]

  return (
    <div className="space-y-3">
      {/* Summary chips (click = filter) + search */}
      <div className="flex flex-wrap items-center gap-2">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setFilter(c.key)}
            className={cn(
              'text-xs px-2.5 py-1 rounded-full font-medium border transition-colors',
              c.cls,
              filter === c.key ? 'ring-2 ring-primary/40 border-transparent' : 'border-transparent opacity-80 hover:opacity-100',
            )}
          >
            {c.label}
          </button>
        ))}
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Tìm mã TRF, POS, người tạo…"
            className="w-full h-9 pl-8 pr-3 rounded-md border bg-background text-sm outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Không có mã TRF khớp bộ lọc.
          </CardContent>
        </Card>
      ) : isAllStores ? (
        <TrfAccordion rows={filtered} />
      ) : (
        <Card>
          <CardContent className="p-0">
            {filtered.map((r) => <TrfRowItem key={r.id} r={r} />)}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// Admin / Cycle Count: group by store (native <details> accordion). Group key is
// store_id (display = store_name) so duplicate/empty names never collide.
function TrfAccordion({ rows }: { rows: TrfRow[] }) {
  const byStore = new Map<string, { name: string; items: TrfRow[] }>()
  for (const r of rows) {
    const k = r.store_id ?? r.store_name ?? '—'
    if (!byStore.has(k)) byStore.set(k, { name: r.store_name ?? '—', items: [] })
    byStore.get(k)!.items.push(r)
  }
  const groups = [...byStore.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, 'vi'))

  return (
    <Card>
      <CardContent className="p-0">
        {groups.map(([storeKey, { name: storeName, items }], idx) => {
          const done = items.filter((r) => effKey(r) === 'done').length
          const overdue = items.filter((r) => effKey(r) === 'overdue').length
          const pending = items.filter((r) => effKey(r) === 'pending').length
          const pos = items.find((r) => r.pos_code)?.pos_code
          return (
            <details key={storeKey} open={idx === 0} className="group border-b last:border-0">
              <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer hover:bg-muted/30 list-none">
                <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm truncate">{storeName}{pos ? ` · ${pos}` : ''}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {overdue > 0 && <span className="text-red-600">{overdue} quá hạn · </span>}
                    {pending} chờ · {done} đã nộp
                  </p>
                </div>
                <span className={cn(
                  'text-xs px-2 py-0.5 rounded font-medium shrink-0',
                  done === items.length ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700',
                )}>
                  {done}/{items.length}
                </span>
              </summary>
              <div className="bg-muted/10">
                {items.map((r) => <TrfRowItem key={r.id} r={r} />)}
              </div>
            </details>
          )
        })}
      </CardContent>
    </Card>
  )
}
