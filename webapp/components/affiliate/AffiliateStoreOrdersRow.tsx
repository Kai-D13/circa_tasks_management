'use client'

import { useState, useTransition } from 'react'
import { listAffiliateOrders, listAffiliatePartnerOrders } from '@/app/actions/affiliateOrders'
import { useFixtureActionBlocked } from '@/components/kpi/KpiFixtureBoundary'
import {
  reconcileState, type AffiliateOrderRow, type OrdersCursor,
} from '@/lib/affiliate/orders'
import { TableCell, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { ChevronDown, Loader2 } from 'lucide-react'

// Drill-down đơn Affiliate của MỘT store (contract 28/07) — client row trong
// bảng overview: chevron (aria-expanded, target ≥44px mobile) → LAZY-LOAD qua
// server action (session → RPC 099, RLS-boundary trong DB), keyset ≤50
// đơn/trang, "Tải thêm" cho trang kế. KHÔNG tải trước đơn nào khi chưa mở.
// Đổi store/date filter = GET navigation → server re-render với key mới →
// state cũ tự hủy (không cache chéo bộ lọc).
//
// Đối soát (acceptance): tải hết trang → count + SUM(total_price) phải khớp
// CHÍNH XÁC số parent (kể cả đơn âm); lệch → cảnh báo đỏ, không im lặng.

const vnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(n))}₫`

// FS-expansion (06/08): component dùng chung cho CẢ 2 entity — store (OS/FS
// có store, RPC 099) và FS-partner không store (partnerCode, RPC 102 —
// super-only, authz trong DB). Truyền ĐÚNG MỘT trong storeId/partnerCode.
export function AffiliateStoreOrdersRow({
  storeId, partnerCode, from, to, canDrill, expectedOrders, expectedGmv, parentCells,
}: {
  storeId?: string
  partnerCode?: string
  from: string
  to: string
  canDrill: boolean
  expectedOrders: number
  expectedGmv: number
  parentCells: React.ReactNode  // các <TableCell> số liệu parent (server render)
}) {
  const [open, setOpen] = useState(false)
  const [fetched, setFetched] = useState(false)
  const [rows, setRows] = useState<AffiliateOrderRow[]>([])
  const [cursor, setCursor] = useState<OrdersCursor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const fixtureBlocked = useFixtureActionBlocked()

  function loadPage(nextCursor: OrdersCursor | null) {
    if (fixtureBlocked()) return
    startTransition(async () => {
      const r = partnerCode
        ? await listAffiliatePartnerOrders({ partnerCode, from, to, cursor: nextCursor })
        : await listAffiliateOrders({ storeId: storeId ?? '', from, to, cursor: nextCursor })
      if ('error' in r) { setError(r.error); return }
      setError(null)
      setRows((prev) => (nextCursor ? [...prev, ...r.rows] : r.rows))
      setCursor(r.nextCursor)
      setFetched(true)
    })
  }

  function toggle() {
    const next = !open
    // Fixture: chặn TRƯỚC khi mở (không để khung "đang tải" treo vì action không được gọi).
    if (next && !fetched && !pending && fixtureBlocked()) return
    setOpen(next)
    if (next && !fetched && !pending) loadPage(null)
  }

  return (
    <>
      <TableRow className={cn(open && 'bg-muted/40')}>
        <TableCell className="pl-1 pr-0 w-10 align-middle">
          {canDrill && (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              aria-label={open ? 'Thu gọn danh sách đơn' : 'Xem danh sách đơn'}
              className="flex items-center justify-center rounded-[8px] text-muted-foreground hover:text-foreground hover:bg-muted min-h-[44px] min-w-[44px] md:min-h-[36px] md:min-w-[36px]"
            >
              <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
            </button>
          )}
        </TableCell>
        {parentCells}
      </TableRow>

      {open && (
        <tr className="border-b bg-muted/30">
          <td colSpan={5} className="px-3 py-3 md:px-4">
            <AffiliateOrdersPanel
              rows={rows} fetched={fetched} cursor={cursor} error={error} pending={pending}
              expectedOrders={expectedOrders} expectedGmv={expectedGmv}
              onLoadMore={() => loadPage(cursor)}
            />
          </td>
        </tr>
      )}
    </>
  )
}

// Thân drill-down (THUẦN — chỉ trình bày state của row): lỗi / đang tải / rỗng / bảng đơn + đối soát + "Tải thêm".
// Tách ra để fixture /ui-catalog/kpi-v2/affiliate dựng đủ trạng thái mà không gọi server action. Chữ, cột và luật đối
// soát (reconcileState) giữ nguyên.
export function AffiliateOrdersPanel({
  rows, fetched, cursor, error, pending, expectedOrders, expectedGmv, onLoadMore,
}: {
  rows: AffiliateOrderRow[]
  fetched: boolean
  cursor: OrdersCursor | null
  error: string | null
  pending: boolean
  expectedOrders: number
  expectedGmv: number
  onLoadMore?: () => void
}) {
  const loadedAll = fetched && cursor === null
  const loadedSum = rows.reduce((s, r) => s + (Number(r.total_price) || 0), 0)
  const recon = reconcileState({
    loadedAll, loadedCount: rows.length, loadedSum, expectedOrders, expectedGmv,
  })
  if (error) {
    return (
      <p role="alert" className="text-sm text-status-danger">
        Không tải được danh sách đơn: {error}
      </p>
    )
  }
  if (!fetched) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Đang tải đơn…
      </p>
    )
  }
  if (rows.length === 0) return <p className="text-sm text-muted-foreground py-2">Không có đơn DELIVERED trong khoảng này.</p>
  return (
    <div data-affiliate-orders className="space-y-2.5">
      <div className="overflow-x-auto rounded-v2-control border bg-card">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b bg-muted text-muted-foreground">
              <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Mã POS/DHC</th>
              <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Partner</th>
              <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Giao vận</th>
              <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Trạng thái</th>
              <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Giá trị</th>
              <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Khách hàng</th>
              <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Ngày tạo</th>
              <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Hoàn thành</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-muted/40">
                <td className="px-3 py-1.5 font-mono whitespace-nowrap">{r.pos_order_code ?? '—'}</td>
                <td className="px-3 py-1.5 font-mono whitespace-nowrap">{r.partner_code}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">{r.sale_order_status ?? '—'}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  <StatusBadge tone={(r.status_norm ?? '').toLowerCase() === 'delivered' ? 'success' : 'neutral'} size="sm">{(r.status_norm ?? '—').toUpperCase()}</StatusBadge>
                </td>
                <td className={cn('px-3 py-1.5 text-right tabular-nums whitespace-nowrap', r.total_price < 0 && 'text-status-danger')}>
                  {vnd(Number(r.total_price) || 0)}
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  {r.customer_name ?? '—'}
                  {r.customer_phone && (
                    <span className="text-muted-foreground font-mono"> · {r.customer_phone}</span>
                  )}
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground tabular-nums">{formatDateTime(r.created_time)}</td>
                <td className="px-3 py-1.5 whitespace-nowrap tabular-nums">{formatDateTime(r.completed_time)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap text-[12px]">
        <p className="text-muted-foreground">
          Đã tải {rows.length}/{expectedOrders} đơn · Tổng đã tải: <span className="tabular-nums">{vnd(loadedSum)}</span>
          {recon === 'match' && <span data-recon="match" className="text-status-success font-medium"> · Khớp số tổng hợp ✓</span>}
          {recon === 'mismatch' && (
            <span data-recon="mismatch" className="text-status-danger font-medium"> · LỆCH số tổng hợp ({vnd(expectedGmv)} / {expectedOrders} đơn) — báo Admin kiểm tra</span>
          )}
        </p>
        {cursor && (
          <Button size="sm" variant="outline" disabled={pending} onClick={onLoadMore} className="gap-1.5 h-[44px] md:h-[32px] rounded-[8px] text-[13px]">
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Tải thêm
          </Button>
        )}
      </div>
    </div>
  )
}
