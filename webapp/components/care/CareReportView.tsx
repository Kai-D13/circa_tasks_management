import { CheckCircle2, Download, TrendingUp, Users } from 'lucide-react'
import { StatCard } from '@/components/ds/StatCard'
import { EmptyState } from '@/components/ds/EmptyState'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { buttonVariants } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import {
  CARE_ORDER_NO_DATA, careOrderNotSeenText, vnDateTime,
  type CareOrderDataState, type CareReportLine, type CareReportTotals,
} from '@/lib/care/reports'

// /care/reports (SPEC §B5a r1.1, Q-91): báo cáo kỳ theo store × dược sĩ từ care_report. Chỉ một chỉ số
// đơn: "Khách có đơn" (task có ≥1 đơn COMPLETED sau lượt Hoàn thành) — KHÔNG số đơn/tiền. Chỉ hiện SỐ
// khi đã có ít nhất một lần đồng bộ thành công; trước đó ghi "Chưa có dữ liệu đơn" (không giả 0). Lỗi
// đồng bộ sau đó ⇒ giữ số cũ + mốc lần thành công cuối.

const fmt = (n: number) => n.toLocaleString('vi-VN')

/** `hasNotSeen`: còn task Hoàn thành chưa có đơn ⇒ thêm dòng "Chưa thấy đơn…" (ẩn khi mọi task đã Có đơn). */
export function CareOrderDataBanner({ state, hasNotSeen }: { state: CareOrderDataState; hasNotSeen: boolean }) {
  if (state.kind === 'none') {
    return (
      <div className="rounded-lg border bg-card p-3 text-sm" data-testid="care-order-state" data-state="none">
        <StatusBadge tone="neutral">Khách có đơn</StatusBadge>
        <span className="ml-2 text-muted-foreground">{CARE_ORDER_NO_DATA} — sẽ có khi đồng bộ đơn hàng được bật.</span>
      </div>
    )
  }
  return (
    <div className="rounded-lg border bg-card p-3 text-sm" data-testid="care-order-state" data-state={state.lastFailed ? 'stale' : 'synced'}>
      {state.lastFailed ? (
        <>
          <StatusBadge tone="warning">Chưa cập nhật</StatusBadge>
          <span className="ml-2 text-muted-foreground">Lần đồng bộ đơn gần nhất chưa thành công — giữ kết quả tính đến lần thành công {vnDateTime(state.lastSuccessAt)}.</span>
        </>
      ) : (
        <>
          <StatusBadge tone="info">Dữ liệu đơn</StatusBadge>
          <span className="ml-2 text-muted-foreground">Cập nhật lúc {vnDateTime(state.lastSuccessAt)}. Khách có đơn ghi vào tháng của lượt chăm sóc Hoàn thành.</span>
        </>
      )}
      {hasNotSeen && (
        <span className="mt-1 block text-xs text-muted-foreground" data-testid="care-order-not-seen">
          Task Hoàn thành chưa có đơn: {careOrderNotSeenText(state)}.
        </span>
      )}
    </div>
  )
}

export function CareReportView({ monthLabel, lines, totals, orderState, exportHref }: {
  monthLabel: string
  lines: CareReportLine[]
  totals: CareReportTotals
  orderState: CareOrderDataState
  exportHref: string
}) {
  const hasOrders = orderState.kind === 'synced'
  const orderCell = (v: string) => (hasOrders ? v : '—')
  return (
    <div className="space-y-6" data-testid="care-report">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Khách (task)" value={fmt(totals.tasks)} icon={Users} hint={`kỳ ${monthLabel}`} />
        <StatCard label="Hoàn thành" value={fmt(totals.completed)} icon={CheckCircle2} tone="success" />
        <StatCard label="Khách có đơn" value={orderCell(fmt(totals.convertedTasks))} icon={TrendingUp}
          hint={hasOrders ? 'task có đơn sau lượt Hoàn thành' : CARE_ORDER_NO_DATA} className="col-span-2 lg:col-span-1" />
      </div>

      <CareOrderDataBanner state={orderState} hasNotSeen={totals.completed > totals.convertedTasks} />

      <section className="space-y-3" aria-labelledby="care-report-table">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="care-report-table" className="text-base font-semibold">Theo cửa hàng &amp; dược sĩ</h2>
          <a href={exportHref} download
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'ml-auto min-h-[44px] gap-1.5 md:min-h-0')}>
            <Download className="size-4" /> Xuất Excel
          </a>
        </div>
        {lines.length === 0 ? (
          <EmptyState icon={Users} title="Không có dữ liệu chăm sóc theo bộ lọc này" hint="Thử đổi kỳ, cửa hàng hoặc dược sĩ." />
        ) : (
          <DataTableShell>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cửa hàng</TableHead>
                  <TableHead>Dược sĩ</TableHead>
                  <TableHead className="text-right">Khách</TableHead>
                  <TableHead className="text-right">Hoàn thành</TableHead>
                  <TableHead className="text-right">Chưa chăm sóc</TableHead>
                  <TableHead className="text-right">Đang theo dõi</TableHead>
                  <TableHead className="text-right">Từng trễ hẹn</TableHead>
                  <TableHead className="text-right">Không hoàn thành</TableHead>
                  <TableHead className="text-right">Có đơn</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l) => (
                  <TableRow key={`${l.storeId}|${l.assigneeId}`}>
                    <TableCell className="whitespace-nowrap" title={l.storeName}>{l.storeCode}</TableCell>
                    <TableCell className="max-w-[200px] truncate" title={l.assigneeName}>{l.assigneeName}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(l.tasks)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(l.completed)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(l.notCared)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(l.inProgress)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(l.overdueInPeriod)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(l.closedUnfinished)}</TableCell>
                    <TableCell className="text-right tabular-nums">{orderCell(fmt(l.convertedTasks))}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="font-semibold" data-testid="care-report-total">
                  <TableCell colSpan={2}>Tổng</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(totals.tasks)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(totals.completed)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(totals.notCared)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(totals.inProgress)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(totals.overdueInPeriod)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(totals.closedUnfinished)}</TableCell>
                  <TableCell className="text-right tabular-nums">{orderCell(fmt(totals.convertedTasks))}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </DataTableShell>
        )}
      </section>
    </div>
  )
}
