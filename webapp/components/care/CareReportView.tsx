import Link from 'next/link'
import { Download, Users } from 'lucide-react'
import { EmptyState } from '@/components/ds/EmptyState'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { buttonVariants } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { careFilterHref, type CareStatusFilter } from '@/lib/care/browse'
import {
  CARE_ORDER_NO_DATA, CARE_REPORT_LINK_STATUS, careOrderNotSeenText, carePct, careReportGroups, vnDateTime,
  type CareOrderDataState, type CareReportLine, type CareReportLinkKey, type CareReportTotals,
} from '@/lib/care/reports'

// /care/reports (SPEC §B5a r1.1, Q-91; B8.2 theo artboard 13): báo cáo kỳ theo store × dược sĩ từ care_report.
// Chỉ một chỉ số đơn: "Khách có đơn" (task có ≥1 đơn COMPLETED sau lượt Hoàn thành) — KHÔNG số đơn/tiền. Chỉ
// hiện SỐ khi đã có ít nhất một lần đồng bộ thành công; trước đó ghi "Chưa có dữ liệu đơn" (không giả 0). Lỗi
// đồng bộ sau đó ⇒ giữ số cũ + mốc lần thành công cuối.
// B8.2: KPI "Đã liên hệ" (Q-113, count riêng); tiến độ = 4 nhóm RỜI NHAU + đúng 2 thanh nhịp (Q-114, không
// cảnh báo); bảng nhóm store → dược sĩ; chỉ số có filter danh sách TƯƠNG ĐƯƠNG mới thành link (PM audit B8 P1).

const fmt = (n: number) => n.toLocaleString('vi-VN')
const PANEL = 'rounded-care-panel border border-care-line bg-card'

/** Nút "Xuất Excel" (đặt trên header trang cùng hàng bộ lọc — artboard 13). Export giữ hợp đồng cột B5a. */
export function CareReportExportLink({ href }: { href: string }) {
  return (
    <a href={href} download className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-h-[44px] gap-1.5 md:h-[36px] md:min-h-0')}>
      <Download className="size-4" /> Xuất Excel
    </a>
  )
}

/** `href` (B8.4): ô thành link sang danh sách — chỉ truyền khi danh sách đích đếm ĐÚNG CÙNG TẬP với số trên ô. */
export function CareKpiTile({ label, value, pct, hint, dot, href }: { label: string; value: string; pct?: number; hint: string; dot?: string; href?: string }) {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">{dot && <span aria-hidden className={cn('size-1.5 rounded-full', dot)} />}{label}</span>
      <span className="text-2xl leading-tight font-bold tabular-nums">
        {value}{typeof pct === 'number' && <span className="ml-1.5 text-sm font-semibold text-muted-foreground">{pct}%</span>}
      </span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </>
  )
  if (href) {
    return (
      <Link href={href} title={`Xem danh sách: ${label}`} data-kpi-link
        className={cn(PANEL, 'group flex flex-col gap-1 p-4 transition-colors hover:border-care-line-strong hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none')}>
        {body}
      </Link>
    )
  }
  return <div className={cn(PANEL, 'flex flex-col gap-1 p-4')}>{body}</div>
}

/** Ô "Khách có đơn": viền đứt + nhãn khi chưa có dữ liệu (không 0 giả); đã đồng bộ ⇒ số + mốc giờ VN. Dùng chung /care (B8.4). */
export function CareOrdersTile({ label, state, converted, hasNotSeen }: { label: string; state: CareOrderDataState; converted: number; hasNotSeen: boolean }) {
  const none = state.kind === 'none'
  return (
    <div className={cn(PANEL, 'flex flex-col gap-1 p-4', none && 'border-dashed bg-transparent')}
      data-testid="care-order-state" data-state={none ? 'none' : state.lastFailed ? 'stale' : 'synced'}>
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {label}
        {none ? <StatusBadge tone="neutral">Chưa có dữ liệu</StatusBadge> : state.lastFailed ? <StatusBadge tone="warning">Chưa cập nhật</StatusBadge> : null}
      </span>
      <span className={cn('text-2xl leading-tight font-bold tabular-nums', none && 'text-muted-foreground')}>{none ? '—' : fmt(converted)}</span>
      <span className="text-xs break-words text-muted-foreground">
        {none ? `${CARE_ORDER_NO_DATA} — sẽ có khi đồng bộ đơn hàng được bật.`
          : state.lastFailed ? `Lần đồng bộ đơn gần nhất chưa thành công — giữ kết quả tính đến lần thành công ${vnDateTime(state.lastSuccessAt)}.`
          : `Cập nhật lúc ${vnDateTime(state.lastSuccessAt)}. Khách có đơn ghi vào tháng của lượt chăm sóc Hoàn thành.`}
      </span>
      {!none && hasNotSeen && (
        <span className="text-xs break-words text-muted-foreground" data-testid="care-order-not-seen">Task Hoàn thành chưa có đơn: {careOrderNotSeenText(state)}.</span>
      )}
    </div>
  )
}

// Bốn nhóm trạng thái RỜI NHAU (cộng = Khách); "Từng trễ hẹn" giao với các nhóm ⇒ chỉ ở KPI/bảng, không vào thanh.
const SEGMENTS: { key: 'completed' | 'inProgress' | 'notCared' | 'closedUnfinished'; label: string; cls: string }[] = [
  { key: 'completed', label: 'Hoàn thành', cls: 'bg-status-success' },
  { key: 'inProgress', label: 'Đang theo dõi', cls: 'bg-status-warning' },
  { key: 'notCared', label: 'Chưa chăm sóc', cls: 'bg-status-neutral' },
  { key: 'closedUnfinished', label: 'Không hoàn thành', cls: 'bg-status-danger' },
]

function StackedBar({ t, className }: { t: CareReportTotals; className?: string }) {
  return (
    <div className={cn('flex gap-[2px] overflow-hidden rounded-full bg-muted', className)} role="img"
      aria-label={SEGMENTS.map((g) => `${g.label} ${t[g.key]}`).join(', ')}>
      {t.tasks > 0 && SEGMENTS.map((g) => t[g.key] > 0 && <span key={g.key} className={g.cls} style={{ width: `${(t[g.key] / t.tasks) * 100}%` }} />)}
    </div>
  )
}

/** `pct` null = chưa có số (đang tải / không đọc được) — thanh rỗng + "—", không giả 0%. */
export function CarePaceRow({ label, pct, note, cls }: { label: string; pct: number | null; note: string; cls: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_3rem] items-center gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${label} ${pct === null ? '—' : `${pct}%`} — ${note}`}>
        {pct !== null && <span className={cn('block h-full rounded-full', cls)} style={{ width: `${Math.min(100, pct)}%` }} />}
      </span>
      <span className="text-right font-semibold tabular-nums" title={note}>{pct === null ? '—' : `${pct}%`}</span>
    </div>
  )
}

/**
 * "Đã liên hệ" (Q-113): `count` (catalog/tính sẵn) hoặc hai slot do trang stream qua <Suspense> (ô KPI + thanh nhịp)
 * để count không nằm trên đường hiện bảng.
 */
export type CareReportContacted = { count: number } | { kpi: React.ReactNode; pace: React.ReactNode }

export interface CareReportLinkScope { month: string; storeId: string | null; assigneeId: string | null }

function Num({ value, link, scope, storeId, assigneeId, muted }: {
  value: number; link?: CareReportLinkKey; scope: CareReportLinkScope; storeId?: string | null; assigneeId?: string | null; muted?: boolean
}) {
  if (!link || value <= 0) return <span className={cn((muted || value === 0) && 'text-muted-foreground')}>{fmt(value)}</span>
  const status = CARE_REPORT_LINK_STATUS[link] as CareStatusFilter | null
  const href = careFilterHref('/care/tasks', { month: scope.month, storeId: storeId ?? scope.storeId, assigneeId: assigneeId ?? scope.assigneeId, status })
  return <Link href={href} className="underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground">{fmt(value)}</Link>
}

type OrderCell = (n: number, storeId?: string | null, assigneeId?: string | null) => React.ReactNode

function Cells({ t, scope, storeId, assigneeId, orderCell, bold }: {
  t: CareReportTotals; scope: CareReportLinkScope; storeId?: string | null; assigneeId?: string | null; orderCell: OrderCell; bold?: boolean
}) {
  const n = (k: keyof CareReportTotals, link?: CareReportLinkKey) => (
    <TableCell className={cn('text-right tabular-nums', bold && 'font-semibold')}><Num value={t[k]} link={link} scope={scope} storeId={storeId} assigneeId={assigneeId} /></TableCell>
  )
  const pct = carePct(t.contacted, t.tasks)
  return (
    <>
      {n('tasks', 'tasks')}
      {n('contacted')}
      {n('completed', 'completed')}
      {n('notCared', 'notCared')}
      {n('inProgress', 'inProgress')}
      {n('overdueInPeriod')}
      {n('closedUnfinished', 'closedUnfinished')}
      <TableCell className={cn('text-right tabular-nums', bold && 'font-semibold')}>{orderCell(t.convertedTasks, storeId, assigneeId)}</TableCell>
      <TableCell>
        <span className="flex min-w-[120px] items-center gap-2">
          <StackedBar t={t} className="h-2 flex-1" />
          <span className="w-10 text-right text-xs tabular-nums">{pct}%</span>
        </span>
      </TableCell>
    </>
  )
}

export function CareReportView({ monthLabel, lines, totals, contacted, orderState, elapsed, dueLabel, scope, outcomes, importOrders, conversionHref }: {
  monthLabel: string
  lines: CareReportLine[]
  totals: CareReportTotals
  /** KPI "Đã liên hệ" (Q-113): count riêng `last_interaction_at`. */
  contacted: CareReportContacted
  orderState: CareOrderDataState
  /** Phần thời gian kỳ đã qua (ngày VN). */
  elapsed: { pct: number; elapsedDays: number; totalDays: number; ended: boolean }
  dueLabel: string
  /** Bộ lọc hiện tại — link số liệu sang /care/tasks giữ đúng kỳ/store/dược sĩ. */
  scope: CareReportLinkScope
  /** Khối "Kết quả liên hệ" (trang thật stream qua Suspense). */
  outcomes?: React.ReactNode
  /** E3 (cờ CARE_ORDER_LINKS_UI_ENABLED): khối "Đơn xác thực sau import" dưới hàng KPI. */
  importOrders?: React.ReactNode
  /** E3: link ô "Có đơn" > 0 sang cohort /care/orders/care — chỉ truyền khi cohort RPC khớp tổng báo cáo (parity). */
  conversionHref?: (storeId: string | null, assigneeId: string | null) => string
}) {
  const hasOrders = orderState.kind === 'synced'
  const orderCell: OrderCell = (v, storeId, assigneeId) => {
    if (!hasOrders) return '—'
    if (!conversionHref || v <= 0) return fmt(v)
    return <Link href={conversionHref(storeId ?? scope.storeId, assigneeId ?? scope.assigneeId)} className="underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground">{fmt(v)}</Link>
  }
  const groups = careReportGroups(lines)
  return (
    <div className="space-y-4" data-testid="care-report">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <CareKpiTile label="Khách (task)" value={fmt(totals.tasks)} hint={`kỳ ${monthLabel}`} />
        {'kpi' in contacted ? contacted.kpi : (
          <CareKpiTile label="Đã liên hệ" value={fmt(contacted.count)} pct={carePct(contacted.count, totals.tasks)} hint="khách có ≥ 1 lượt chăm sóc" dot="bg-status-info" />
        )}
        <CareKpiTile label="Hoàn thành" value={fmt(totals.completed)} pct={carePct(totals.completed, totals.tasks)} hint="kết thúc chăm sóc trong kỳ" dot="bg-status-success" />
        <CareKpiTile label="Từng trễ hẹn" value={fmt(totals.overdueInPeriod)} hint="khách có lịch hẹn từng bị lỡ" dot="bg-status-danger" />
        <CareOrdersTile label={importOrders ? 'Khách có đơn sau chăm sóc' : 'Khách có đơn'} state={orderState} converted={totals.convertedTasks} hasNotSeen={totals.completed > totals.convertedTasks} />
      </div>

      {importOrders}

      {totals.tasks > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          <section className={cn(PANEL, 'space-y-4 p-4')} aria-labelledby="care-report-progress" data-testid="care-report-progress">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="care-report-progress" className="text-base font-semibold">Tiến độ kỳ</h2>
              <span className="text-xs text-muted-foreground">{fmt(totals.tasks)} khách · hạn {dueLabel}</span>
            </div>
            <StackedBar t={totals} className="h-3.5" />
            <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-4" aria-label="Chú giải">
              {SEGMENTS.map((g) => (
                <li key={g.key} className="flex items-center gap-1.5 text-muted-foreground">
                  <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', g.cls)} />{g.label}
                  <b className="ml-auto font-semibold text-foreground tabular-nums">{fmt(totals[g.key])}</b>
                </li>
              ))}
            </ul>
            <div className="space-y-2.5 border-t border-care-line pt-3">
              <CarePaceRow label="Thời gian đã qua" pct={elapsed.pct} cls="bg-muted-foreground"
                note={elapsed.ended ? 'kỳ đã kết thúc' : `ngày ${elapsed.elapsedDays}/${elapsed.totalDays} của kỳ`} />
              {'pace' in contacted ? contacted.pace : (
                <CarePaceRow label="Khách đã liên hệ" pct={carePct(contacted.count, totals.tasks)} cls="bg-primary"
                  note={`${fmt(contacted.count)}/${fmt(totals.tasks)} khách có ≥ 1 lượt`} />
              )}
            </div>
          </section>
          {outcomes}
        </div>
      )}

      <section className={cn(PANEL, 'overflow-hidden')} aria-labelledby="care-report-table">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-care-line px-4 py-3">
          <h2 id="care-report-table" className="text-base font-semibold">Theo cửa hàng &amp; dược sĩ</h2>
          {lines.length > 0 && <span className="text-xs text-muted-foreground">Bấm số để mở danh sách khách đã lọc (trừ Đã liên hệ, Từng trễ hẹn{conversionHref ? '' : ', Có đơn'})</span>}
        </div>
        {lines.length === 0 ? (
          <div className="p-3"><EmptyState icon={Users} title="Không có dữ liệu chăm sóc theo bộ lọc này" hint="Thử đổi kỳ, cửa hàng hoặc dược sĩ." /></div>
        ) : (
          <DataTableShell className="rounded-none py-0 ring-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cửa hàng / Dược sĩ</TableHead>
                  <TableHead className="text-right">Khách</TableHead>
                  <TableHead className="text-right">Đã liên hệ</TableHead>
                  <TableHead className="text-right">Hoàn thành</TableHead>
                  <TableHead className="text-right">Chưa chăm sóc</TableHead>
                  <TableHead className="text-right">Đang theo dõi</TableHead>
                  <TableHead className="text-right">Từng trễ hẹn</TableHead>
                  <TableHead className="text-right">Không hoàn thành</TableHead>
                  <TableHead className="text-right">Có đơn</TableHead>
                  <TableHead>Tiến độ</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <GroupRows key={g.storeId} g={g} scope={scope} orderCell={orderCell} />
                ))}
                <TableRow className="bg-muted/50 font-semibold" data-testid="care-report-total">
                  <TableCell>Tổng</TableCell>
                  <Cells t={totals} scope={scope} orderCell={orderCell} bold />
                </TableRow>
              </TableBody>
            </Table>
          </DataTableShell>
        )}
      </section>
    </div>
  )
}

function GroupRows({ g, scope, orderCell }: { g: ReturnType<typeof careReportGroups>[number]; scope: CareReportLinkScope; orderCell: OrderCell }) {
  return (
    <>
      <TableRow className="bg-muted/30" data-testid="care-report-store">
        <TableCell className="font-semibold whitespace-nowrap" title={g.storeName}>
          <span className="text-muted-foreground">{g.storeCode}</span>{g.storeName && <> · {g.storeName}</>}
        </TableCell>
        <Cells t={g.totals} scope={scope} storeId={g.storeId} orderCell={orderCell} bold />
      </TableRow>
      {g.lines.map((l) => (
        <TableRow key={`${l.storeId}|${l.assigneeId}`}>
          <TableCell className="max-w-[240px] truncate pl-8" title={l.assigneeName}>{l.assigneeName}</TableCell>
          <Cells t={l} scope={scope} storeId={l.storeId} assigneeId={l.assigneeId} orderCell={orderCell} />
        </TableRow>
      ))}
    </>
  )
}
