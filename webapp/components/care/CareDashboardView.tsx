import { AlertTriangle, CheckCircle2, ClipboardList, Clock, Users, XCircle } from 'lucide-react'
import { StatCard } from '@/components/ds/StatCard'
import { EmptyState } from '@/components/ds/EmptyState'
import { StatusBadge } from '@/components/ds/StatusBadge'
import type { CareTotals } from '@/lib/care/browse'

// Dashboard /care (SPEC B3 §2) — thuần trình bày, số liệu từ care_report (server).
// Đơn vị = TASK (một khách/tháng), không phải dòng sản phẩm. "Quá hạn đang mở" (kỳ
// hiện tại) ≠ "Từng trễ hẹn trong kỳ" (first_overdue_on) ≠ "Không hoàn thành trong kỳ".
// Biểu đồ theo store: thanh xếp chồng theo TRẠNG THÁI (token status — đúng vai trò
// "state"), có chú giải + tooltip + bảng số; phân bố kết quả: một chuỗi, nhãn số trực tiếp.

export interface CareDashboardStore { code: string; name: string; totals: CareTotals }

const fmt = (n: number) => n.toLocaleString('vi-VN')

const SEGMENTS = [
  { key: 'completed', label: 'Hoàn thành', cls: 'bg-status-success' },
  { key: 'inProgress', label: 'Đang theo dõi', cls: 'bg-status-warning' },
  { key: 'notCared', label: 'Chưa chăm sóc', cls: 'bg-status-neutral' },
  { key: 'closedUnfinished', label: 'Không hoàn thành trong kỳ', cls: 'bg-status-danger' },
] as const

export function CareDashboardView({
  monthLabel, isPast, totals, overdueOpen, stores, outcomes,
}: {
  monthLabel: string
  isPast: boolean
  totals: CareTotals
  overdueOpen: number | null
  stores: CareDashboardStore[]
  outcomes: { key: string; label: string; count: number }[]
}) {
  if (totals.tasks === 0) {
    return <EmptyState icon={ClipboardList} title={`Chưa có khách cần chăm sóc trong kỳ ${monthLabel}`} hint="Danh sách khách được tạo khi phòng phụ trách import file Excel của tháng." />
  }
  const maxStore = Math.max(1, ...stores.map((s) => s.totals.tasks))
  const maxOutcome = Math.max(1, ...outcomes.map((o) => o.count))
  return (
    <div className="space-y-6" data-testid="care-dashboard">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Khách (task) trong kỳ" value={fmt(totals.tasks)} icon={Users} />
        <StatCard label="Hoàn thành" value={fmt(totals.completed)} icon={CheckCircle2} tone="success"
          hint={`${Math.round((totals.completed / totals.tasks) * 100)}% số task`} />
        {isPast ? (
          <>
            <StatCard label="Từng trễ hẹn trong kỳ" value={fmt(totals.overdueInPeriod)} icon={Clock} tone="warning"
              hint="đếm mỗi task một lần, kể cả đã hoàn thành sau đó" />
            <StatCard label="Không hoàn thành trong kỳ" value={fmt(totals.closedUnfinished)} icon={XCircle} tone="danger"
              hint="chỉ số riêng — có thể trùng với số từng trễ hẹn" />
          </>
        ) : (
          <>
            <StatCard label="Chưa chăm sóc" value={fmt(totals.notCared)} icon={ClipboardList} hint="đang mở, chưa có lượt nào" />
            <StatCard label="Quá hạn đang mở" value={overdueOpen === null ? '—' : fmt(overdueOpen)} icon={AlertTriangle}
              tone={overdueOpen ? 'danger' : 'default'} hint={`đã qua ngày hẹn chăm sóc lại · từng trễ trong kỳ: ${fmt(totals.overdueInPeriod)}`} />
          </>
        )}
      </div>

      <div className="rounded-lg border bg-card p-3 text-sm">
        <StatusBadge tone="neutral">Chuyển đổi &amp; doanh thu</StatusBadge>
        <span className="ml-2 text-muted-foreground">Chưa có dữ liệu đơn — sẽ có khi đồng bộ đơn hàng được bật.</span>
      </div>

      <section className="space-y-3" aria-labelledby="care-by-store">
        <h2 id="care-by-store" className="text-base font-semibold">Theo cửa hàng</h2>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Chú giải">
          {SEGMENTS.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5"><span className={`inline-block size-2.5 rounded-sm ${s.cls}`} />{s.label}</li>
          ))}
        </ul>
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

      <section className="space-y-3" aria-labelledby="care-outcomes">
        <h2 id="care-outcomes" className="text-base font-semibold">Kết quả chăm sóc gần nhất <span className="text-sm font-normal text-muted-foreground">(theo task)</span></h2>
        <div className="space-y-2">
          {outcomes.map((o) => (
            <div key={o.key} className="grid grid-cols-[150px_1fr_48px] items-center gap-2 text-sm md:grid-cols-[220px_1fr_56px]">
              <span className="truncate">{o.label}</span>
              <div className="h-3">
                {o.count > 0 && <div className="h-full rounded-r bg-primary/70" style={{ width: `${(o.count / maxOutcome) * 100}%` }} title={`${o.label}: ${fmt(o.count)}`} />}
              </div>
              <span className="text-right tabular-nums">{fmt(o.count)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
