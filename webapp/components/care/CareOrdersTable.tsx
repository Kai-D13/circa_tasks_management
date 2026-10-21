'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { careVnTime, type CareConversionRow, type CareImportOrderRow } from '@/lib/care/orderLinks/view'

// E3 — bảng /care/orders (thiết kế E0 r3.4 §9). Không có mã đơn (chỉ ở chi tiết task). "Xem thêm" qua server action
// (cursor ký HMAC, không URL). basis=import: task có đơn N3 sau mốc import · basis=care: cohort "Khách có đơn sau chăm sóc".

type Filter = { month: string; storeId: string | null; assigneeId: string | null }
type More<R> = (input: { filter: Filter; cursor: string }) => Promise<{ ok: true; rows: R[]; next: string | null } | { ok: false; message: string }>

const customerLink = (id: string, name: string) => (
  <Link href={`/care/tasks/${id}`} className="inline-flex min-h-[44px] max-w-[260px] items-center truncate font-medium text-primary hover:underline md:min-h-0" title={name}>{name}</Link>
)

function useMore<R>(initial: R[], next: string | null, filter: Filter, load: More<R>) {
  const [rows, setRows] = useState(initial)
  const [cursor, setCursor] = useState(next)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const more = async () => {
    if (!cursor || busy) return
    setBusy(true); setError(null)
    const r = await load({ filter, cursor })
    setBusy(false)
    if (!r.ok) { setError(r.message); return }
    setRows((cur) => [...cur, ...r.rows]); setCursor(r.next)
  }
  return { rows, cursor, busy, error, more }
}

function MoreButton({ s }: { s: { cursor: string | null; busy: boolean; error: string | null; more: () => void } }) {
  return (
    <>
      {s.cursor && (
        <div className="flex justify-center p-3">
          <Button type="button" variant="outline" size="sm" onClick={s.more} disabled={s.busy} className="min-h-[44px] md:h-[36px] md:min-h-0">
            {s.busy && <Loader2 className="size-4 animate-spin" aria-hidden />} Xem thêm
          </Button>
        </div>
      )}
      {s.error && <p role="alert" className="px-4 pb-3 text-xs text-status-danger">{s.error}</p>}
    </>
  )
}

export function CareImportOrdersTable({ initial, next, filter, loadMore }: { initial: CareImportOrderRow[]; next: string | null; filter: Filter; loadMore: More<CareImportOrderRow> }) {
  const s = useMore(initial, next, filter, loadMore)
  return (
    <DataTableShell>
      <Table data-testid="care-import-orders-table">
        <TableHeader>
          <TableRow>
            <TableHead>Khách</TableHead><TableHead>Cửa hàng</TableHead><TableHead>Dược sĩ</TableHead>
            <TableHead className="text-right">Đơn</TableHead><TableHead>Đơn gần nhất</TableHead><TableHead>Dữ liệu đến</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {s.rows.map((r) => (
            <TableRow key={r.taskId}>
              <TableCell>{customerLink(r.taskId, r.customerName)}</TableCell>
              <TableCell>{r.storeCode ?? '—'}</TableCell>
              <TableCell className="max-w-[200px] truncate" title={r.assigneeName ?? undefined}>{r.assigneeName ?? '—'}</TableCell>
              <TableCell className="text-right tabular-nums">{r.ordersCount}</TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">{careVnTime(r.latestCompletedAt)}</TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">
                {r.coveredUntil ? careVnTime(r.coveredUntil) : '—'}
                {r.lagging && <span className="ml-2"><StatusBadge tone="warning">Chưa cập nhật</StatusBadge></span>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <MoreButton s={s} />
    </DataTableShell>
  )
}

export function CareConversionTable({ initial, next, filter, loadMore }: { initial: CareConversionRow[]; next: string | null; filter: Filter; loadMore: More<CareConversionRow> }) {
  const s = useMore(initial, next, filter, loadMore)
  return (
    <DataTableShell>
      <Table data-testid="care-conversion-table">
        <TableHeader>
          <TableRow>
            <TableHead>Khách</TableHead><TableHead>Cửa hàng</TableHead><TableHead>Dược sĩ</TableHead>
            <TableHead className="text-right">Đơn được ghi công</TableHead><TableHead>Đơn gần nhất</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {s.rows.map((r) => (
            <TableRow key={r.taskId}>
              <TableCell>{customerLink(r.taskId, r.customerName)}</TableCell>
              <TableCell>{r.storeCode ?? '—'}</TableCell>
              <TableCell className="max-w-[200px] truncate" title={r.assigneeName ?? undefined}>{r.assigneeName ?? '—'}</TableCell>
              <TableCell className="text-right tabular-nums">{r.orders}</TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">{careVnTime(r.latestCompletedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <MoreButton s={s} />
    </DataTableShell>
  )
}
