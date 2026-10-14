import Link from 'next/link'
import { ArrowRight, ClipboardList } from 'lucide-react'
import { EmptyState } from '@/components/ds/EmptyState'
import { careFilterHref, type CareStatusFilter, type CareTotals } from '@/lib/care/browse'
import { CARE_DASHBOARD_LINK_STATUS, carePct, type CareDashboardLinkKey, type CareOrderDataState } from '@/lib/care/reports'
import { cn } from '@/lib/utils'
import { CareKpiTile, CareOrdersTile } from './CareReportView'

// Dashboard /care (SPEC B3 §2; B8.4 theo artboard 05) — thuần trình bày, số liệu từ care_report (server).
// Đơn vị = TASK (một khách/tháng), không phải dòng sản phẩm. "Quá hạn đang mở" (kỳ hiện tại) ≠ "Từng trễ hẹn
// trong kỳ" (first_overdue_on) ≠ "Không hoàn thành trong kỳ".
// B8.4: ô KPI cùng kiểu báo cáo (B8.2); ô chỉ là link khi /care/tasks trả ĐÚNG CÙNG TẬP (CARE_DASHBOARD_LINK_STATUS);
// "Khách có đơn" dùng chung ô của báo cáo (viền đứt "Chưa có dữ liệu" khi N3 chưa đồng bộ — không 0 giả).
// Biểu đồ theo store: thanh xếp chồng theo TRẠNG THÁI (token status), có chú giải + tooltip + bảng số.

export interface CareDashboardStore { code: string; name: string; totals: CareTotals }

const fmt = (n: number) => n.toLocaleString('vi-VN')
const PANEL = 'space-y-3 rounded-care-panel border border-care-line bg-card p-4'

const SEGMENTS = [
  { key: 'completed', label: 'Hoàn thành', cls: 'bg-status-success' },
  { key: 'inProgress', label: 'Đang theo dõi', cls: 'bg-status-warning' },
  { key: 'notCared', label: 'Chưa chăm sóc', cls: 'bg-status-neutral' },
  { key: 'closedUnfinished', label: 'Không hoàn thành trong kỳ', cls: 'bg-status-danger' },
] as const

export function CareDashboardView({
  monthLabel, isPast, totals, overdueOpen, stores, outcomes, orders, scope, assignees,
}: {
  monthLabel: string
  isPast: boolean
  totals: CareTotals
  overdueOpen: number | null
  stores: CareDashboardStore[]
  outcomes: { key: string; label: string; count: number }[]
  /** B5a r1.1: số task Có đơn — chỉ hiện SỐ khi đã đồng bộ đơn ít nhất một lần; không số đơn/tiền (Q-91). */
  orders?: { state: CareOrderDataState; convertedTasks: number }
  /** Bộ lọc đang xem (kỳ + cửa hàng) — có thì ô KPI cùng tập thành link /care/tasks. */
  scope?: { month: string; storeId: string | null }
  /** Số dược sĩ có khách trong kỳ (từ care_report). */
  assignees?: number
}) {
  const link = (k: CareDashboardLinkKey, n: number | null) => (scope && n !== null && n > 0
    ? careFilterHref('/care/tasks', { month: scope.month, storeId: scope.storeId, assigneeId: null, status: CARE_DASHBOARD_LINK_STATUS[k] as CareStatusFilter | null })
    : undefined)
  const maxStore = Math.max(1, ...stores.map((s) => s.totals.tasks))
  const maxOutcome = Math.max(1, ...outcomes.map((o) => o.count))
  const anyOutcome = outcomes.some((o) => o.key !== 'none' && o.count > 0)
  const storesWithTasks = stores.filter((s) => s.totals.tasks > 0).length
  const state = orders?.state ?? { kind: 'none' as const }
  const kpis = (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <CareKpiTile label="Khách (task) trong kỳ" value={fmt(totals.tasks)} href={link('tasks', totals.tasks)}
          hint={`${fmt(storesWithTasks)} cửa hàng${typeof assignees === 'number' ? ` · ${fmt(assignees)} dược sĩ` : ''} có khách`} />
        <CareKpiTile label="Hoàn thành" value={fmt(totals.completed)} pct={carePct(totals.completed, totals.tasks)} dot="bg-status-success"
          hint="kết thúc chăm sóc trong kỳ" href={link('completed', totals.completed)} />
        {isPast ? (
          <>
            <CareKpiTile label="Từng trễ hẹn trong kỳ" value={fmt(totals.overdueInPeriod)} dot="bg-status-warning"
              hint="đếm mỗi task một lần, kể cả đã hoàn thành sau đó" />
            <CareKpiTile label="Không hoàn thành trong kỳ" value={fmt(totals.closedUnfinished)} dot="bg-status-danger"
              hint="chỉ số riêng — có thể trùng với số từng trễ hẹn" href={link('closedUnfinished', totals.closedUnfinished)} />
          </>
        ) : (
          <>
            <CareKpiTile label="Chưa chăm sóc" value={fmt(totals.notCared)} dot="bg-status-neutral"
              hint="đang mở, chưa có lượt nào" href={link('notCared', totals.notCared)} />
            <CareKpiTile label="Quá hạn đang mở" value={overdueOpen === null ? '—' : fmt(overdueOpen)} dot="bg-status-danger"
              hint={`đã qua ngày hẹn chăm sóc lại · từng trễ trong kỳ: ${fmt(totals.overdueInPeriod)}`} href={link('overdueOpen', overdueOpen)} />
          </>
        )}
        <div data-testid="care-dashboard-orders" className="contents">
          <CareOrdersTile label="Khách có đơn" state={state} converted={orders?.convertedTasks ?? 0}
            hasNotSeen={totals.completed > (orders?.convertedTasks ?? 0)} />
        </div>
      </div>
  )
  // PM B8.4 R1-01: kỳ 0 task vẫn hiện hàng ô (số 0 THẬT, không link vì n = 0) + ô "Khách có đơn" theo trạng thái N3
  // (chưa đồng bộ ⇒ "—"/"Chưa có dữ liệu", không 0 giả); lời giải thích kỳ rỗng thay cho hai panel.
  if (totals.tasks === 0) {
    return (
      <div className="space-y-4" data-testid="care-dashboard">
        {kpis}
        <EmptyState icon={ClipboardList} title={`Chưa có khách cần chăm sóc trong kỳ ${monthLabel}`} hint="Danh sách khách được tạo khi phòng phụ trách import file Excel của tháng." />
      </div>
    )
  }
  return (
    <div className="space-y-4" data-testid="care-dashboard">
      {kpis}

      <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
        <section className={PANEL} aria-labelledby="care-by-store">
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
          <div className="flex flex-wrap items-center justify-between gap-x-4">
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
            {scope && (
              <Link href={careFilterHref('/care/reports', { month: scope.month, storeId: scope.storeId })}
                className="inline-flex min-h-[44px] items-center gap-1 text-sm font-medium text-primary underline-offset-2 hover:underline md:min-h-0">
                Xem báo cáo theo dược sĩ <ArrowRight className="size-4" aria-hidden />
              </Link>
            )}
          </div>
        </section>

        <section className={PANEL} aria-labelledby="care-outcomes">
          <h2 id="care-outcomes" className="text-base font-semibold">Kết quả chăm sóc gần nhất <span className="text-sm font-normal text-muted-foreground">(theo task)</span></h2>
          {anyOutcome ? (
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
          ) : (
            // Artboard 05: kỳ chưa có lượt nào ⇒ trạng thái trống có lời giải thích thay vì 6 thanh 0.
            <div className="flex flex-col items-start gap-2 py-4 text-sm" data-testid="care-outcomes-empty">
              <p className="font-medium">Chưa có kết quả trong kỳ</p>
              <p className="text-muted-foreground">Chưa khách nào có lượt chăm sóc. Kết quả hiện ở đây khi dược sĩ ghi lượt đầu tiên.</p>
              {!isPast && link('notCared', totals.notCared) && (
                <Link href={link('notCared', totals.notCared)!} className="inline-flex min-h-[44px] items-center gap-1 font-medium text-primary underline-offset-2 hover:underline md:min-h-0">
                  Xem khách chưa chăm sóc <ArrowRight className="size-4" aria-hidden />
                </Link>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
