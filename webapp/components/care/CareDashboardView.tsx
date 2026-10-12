import { AlertTriangle, CheckCircle2, ClipboardList, Clock, TrendingUp, Users, XCircle } from 'lucide-react'
import { StatCard } from '@/components/ds/StatCard'
import { EmptyState } from '@/components/ds/EmptyState'
import type { CareTotals } from '@/lib/care/browse'
import type { CareOrderDataState } from '@/lib/care/reports'
import { cn } from '@/lib/utils'
import { CareOrderDataBanner } from './CareReportView'

// Dashboard /care (SPEC B3 §2) — thuần trình bày, số liệu từ care_report (server).
// Đơn vị = TASK (một khách/tháng), không phải dòng sản phẩm. "Quá hạn đang mở" (kỳ
// hiện tại) ≠ "Từng trễ hẹn trong kỳ" (first_overdue_on) ≠ "Không hoàn thành trong kỳ".
// Biểu đồ theo store: thanh xếp chồng theo TRẠNG THÁI (token status — đúng vai trò
// "state"), có chú giải + tooltip + bảng số; phân bố kết quả: một chuỗi, nhãn số trực tiếp.
// B7-ui: hint thẻ số 2 dòng (không cắt); "Khách có đơn" nằm chung hàng thẻ; hai khối biểu đồ
// là card cạnh nhau (xl); thanh kết quả dùng token trạng thái (không màu brand), "Chưa cập
// nhật" trung tính, dòng 0 mờ đi.

export interface CareDashboardStore { code: string; name: string; totals: CareTotals }

const fmt = (n: number) => n.toLocaleString('vi-VN')

const SEGMENTS = [
  { key: 'completed', label: 'Hoàn thành', cls: 'bg-status-success' },
  { key: 'inProgress', label: 'Đang theo dõi', cls: 'bg-status-warning' },
  { key: 'notCared', label: 'Chưa chăm sóc', cls: 'bg-status-neutral' },
  { key: 'closedUnfinished', label: 'Không hoàn thành trong kỳ', cls: 'bg-status-danger' },
] as const

const CARD = 'space-y-3 rounded-lg border bg-card p-4'

export function CareDashboardView({
  monthLabel, isPast, totals, overdueOpen, stores, outcomes, orders,
}: {
  monthLabel: string
  isPast: boolean
  totals: CareTotals
  overdueOpen: number | null
  stores: CareDashboardStore[]
  outcomes: { key: string; label: string; count: number }[]
  /** B5a r1.1: số task Có đơn — chỉ hiện SỐ khi đã đồng bộ đơn ít nhất một lần; không số đơn/tiền (Q-91). */
  orders?: { state: CareOrderDataState; convertedTasks: number }
}) {
  if (totals.tasks === 0) {
    return <EmptyState icon={ClipboardList} title={`Chưa có khách cần chăm sóc trong kỳ ${monthLabel}`} hint="Danh sách khách được tạo khi phòng phụ trách import file Excel của tháng." />
  }
  const maxStore = Math.max(1, ...stores.map((s) => s.totals.tasks))
  const maxOutcome = Math.max(1, ...outcomes.map((o) => o.count))
  const synced = orders?.state.kind === 'synced'
  return (
    <div className="space-y-4" data-testid="care-dashboard">
      <div className={cn('grid grid-cols-2 gap-3', synced ? 'lg:grid-cols-5' : 'lg:grid-cols-4')}>
        <StatCard label="Khách (task) trong kỳ" value={fmt(totals.tasks)} icon={Users} hint={`${fmt(stores.filter((s) => s.totals.tasks > 0).length)} cửa hàng có khách`} />
        <StatCard label="Hoàn thành" value={fmt(totals.completed)} icon={CheckCircle2} tone="success"
          hint={`${Math.round((totals.completed / totals.tasks) * 100)}% số task`} />
        {isPast ? (
          <>
            <StatCard label="Từng trễ hẹn trong kỳ" value={fmt(totals.overdueInPeriod)} icon={Clock} tone="warning" hintLines={2}
              hint="đếm mỗi task một lần, kể cả đã hoàn thành sau đó" />
            <StatCard label="Không hoàn thành trong kỳ" value={fmt(totals.closedUnfinished)} icon={XCircle} tone="danger" hintLines={2}
              hint="chỉ số riêng — có thể trùng với số từng trễ hẹn" />
          </>
        ) : (
          <>
            <StatCard label="Chưa chăm sóc" value={fmt(totals.notCared)} icon={ClipboardList} hintLines={2} hint="đang mở, chưa có lượt nào" />
            <StatCard label="Quá hạn đang mở" value={overdueOpen === null ? '—' : fmt(overdueOpen)} icon={AlertTriangle} hintLines={2}
              tone={overdueOpen ? 'danger' : 'default'} hint={`đã qua ngày hẹn chăm sóc lại · từng trễ trong kỳ: ${fmt(totals.overdueInPeriod)}`} />
          </>
        )}
        {orders && orders.state.kind === 'synced' && (
          <div data-testid="care-dashboard-orders" className="contents">
            <StatCard label="Khách có đơn" value={fmt(orders.convertedTasks)} icon={TrendingUp}
              hint={`trên ${fmt(totals.completed)} task Hoàn thành`} />
          </div>
        )}
      </div>
      <CareOrderDataBanner state={orders?.state ?? { kind: 'none' }} hasNotSeen={totals.completed > (orders?.convertedTasks ?? 0)} />

      <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
        <section className={CARD} aria-labelledby="care-by-store">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="care-by-store" className="text-base font-semibold">Theo cửa hàng</h2>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Chú giải">
              {SEGMENTS.map((s) => (
                <li key={s.key} className="flex items-center gap-1.5"><span className={`inline-block size-2.5 rounded-sm ${s.cls}`} />{s.label}</li>
              ))}
            </ul>
          </div>
          <div className="space-y-2">
            {stores.map((s) => (
              <div key={s.code} className="grid grid-cols-[72px_1fr_48px] items-center gap-2 text-sm md:grid-cols-[180px_1fr_56px]">
                <span className="truncate" title={s.name}><span className="font-medium">{s.code}</span><span className="hidden text-muted-foreground md:inline"> · {s.name}</span></span>
                <div className="flex h-4 gap-[2px]" style={{ width: `${(s.totals.tasks / maxStore) * 100}%` }} role="img"
                  aria-label={`${s.code}: ${SEGMENTS.map((g) => `${g.label} ${s.totals[g.key]}`).join(', ')}`}>
                  {SEGMENTS.filter((g) => s.totals[g.key] > 0).map((g) => (
                    <span key={g.key} className={`h-full first:rounded-l last:rounded-r ${g.cls}`}
                      style={{ flexGrow: s.totals[g.key] }} title={`${s.code} · ${g.label}: ${fmt(s.totals[g.key])}`} />
                  ))}
                </div>
                <span className="text-right tabular-nums">{fmt(s.totals.tasks)}</span>
              </div>
            ))}
          </div>
          <details className="text-sm">
            <summary className="min-h-[44px] cursor-pointer py-2 text-muted-foreground md:min-h-0">Xem bảng số theo cửa hàng</summary>
            <div className="overflow-x-auto">
              <table className="mt-2 w-full text-sm">
                <thead className="text-xs text-muted-foreground"><tr>
                  <th className="py-1 text-left font-medium">Cửa hàng</th><th className="text-right font-medium">Task</th>
                  {SEGMENTS.map((g) => <th key={g.key} className="text-right font-medium">{g.label}</th>)}
                  <th className="text-right font-medium">Từng trễ hẹn</th>
                </tr></thead>
                <tbody>{stores.map((s) => (
                  <tr key={s.code} className="border-t">
                    <td className="py-1">{s.code}</td><td className="text-right tabular-nums">{fmt(s.totals.tasks)}</td>
                    {SEGMENTS.map((g) => <td key={g.key} className="text-right tabular-nums">{fmt(s.totals[g.key])}</td>)}
                    <td className="text-right tabular-nums">{fmt(s.totals.overdueInPeriod)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </details>
        </section>

        <section className={CARD} aria-labelledby="care-outcomes">
          <h2 id="care-outcomes" className="text-base font-semibold">Kết quả chăm sóc gần nhất <span className="text-sm font-normal text-muted-foreground">(theo task)</span></h2>
          <div className="space-y-2">
            {outcomes.map((o) => (
              <div key={o.key} className={cn('grid grid-cols-[150px_1fr_48px] items-center gap-2 text-sm md:grid-cols-[200px_1fr_56px]', o.count === 0 && 'text-muted-foreground')}>
                <span className="truncate" title={o.label}>{o.label}</span>
                <div className="h-3 rounded-r bg-muted/60">
                  {o.count > 0 && <div className={cn('h-full rounded-r', o.key === 'none' ? 'bg-status-neutral' : 'bg-status-info')}
                    style={{ width: `${(o.count / maxOutcome) * 100}%` }} title={`${o.label}: ${fmt(o.count)}`} />}
                </div>
                <span className="text-right tabular-nums">{fmt(o.count)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
