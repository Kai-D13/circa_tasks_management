import { notFound, redirect } from 'next/navigation'
import { BarChart3 } from 'lucide-react'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { PageHeader } from '@/components/ds/PageHeader'
import { CareReportView } from '@/components/care/CareReportView'
import { CareDashboardView } from '@/components/care/CareDashboardView'
import type { CareReportRow } from '@/lib/care/browse'
import { careReportConvertedTotal, careReportLines, careReportSummary, type CareOrderDataState } from '@/lib/care/reports'

// Dev-only bàn thử UI báo cáo CRM (B5a r1.1). 100% DỮ LIỆU GIẢ — DB chưa có 114, chưa đồng bộ N3.
// Cùng cổng /ui-catalog: UI_CATALOG=1 (Coolify không đặt ⇒ prod 404) + super. Không có action.

const S = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const STORES = new Map([[S(101), { code: 'QAOS01', name: 'QA store 1' }], [S(102), { code: 'QAOS02', name: 'QA store 2' }]])
const NAMES = new Map([[S(1002), 'QA Dược sĩ 01a'], [S(1003), 'QA Dược sĩ 01b'], [S(1004), 'QA Dược sĩ 02a có tên rất dài để kiểm tra cắt dòng']])
const ROWS: CareReportRow[] = [
  { store_id: S(101), assignee_id: S(1002), tasks_total: 120, completed: 80, open_not_cared: 25, open_in_progress: 15, overdue_in_period: 9, closed_unfinished: 0, converted_tasks: 31 },
  { store_id: S(101), assignee_id: S(1003), tasks_total: 95, completed: 60, open_not_cared: 20, open_in_progress: 15, overdue_in_period: 4, closed_unfinished: 0, converted_tasks: 18 },
  { store_id: S(102), assignee_id: S(1004), tasks_total: 70, completed: 30, open_not_cared: 30, open_in_progress: 10, overdue_in_period: 12, closed_unfinished: 0, converted_tasks: 9 },
]
const LINES = careReportLines(ROWS, { stores: STORES, names: NAMES })
// Mọi task Hoàn thành đều đã có đơn ⇒ không hiện dòng "Chưa thấy đơn…".
const ALL_CONVERTED = careReportLines([{ ...ROWS[2], completed: 9, converted_tasks: 9 }], { stores: STORES, names: NAMES })
const TOTALS = careReportSummary(LINES)
const NONE: CareOrderDataState = { kind: 'none' }
const SYNCED: CareOrderDataState = { kind: 'synced', lastSuccessAt: '2026-10-20T01:05:00Z', lastFailed: false }
const STALE: CareOrderDataState = { kind: 'synced', lastSuccessAt: '2026-10-19T23:00:00Z', lastFailed: true }
const EXPORT = '/api/export/care?month=2026-10'

const catalogOn = () => process.env.UI_CATALOG === '1'

export default async function CareReportsCatalogPage() {
  if (!catalogOn()) notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const dashTotals = { tasks: TOTALS.tasks, completed: TOTALS.completed, notCared: TOTALS.notCared, inProgress: TOTALS.inProgress, overdueInPeriod: TOTALS.overdueInPeriod, closedUnfinished: TOTALS.closedUnfinished }

  return (
    <div data-layout-width="fluid" className="space-y-10 p-4 md:p-6">
      <PageHeader title="Báo cáo chăm sóc khách hàng" subtitle="UI catalog — dữ liệu giả" icon={BarChart3} />
      <section className="space-y-3" data-testid="catalog-care-report-none">
        <h2 className="text-sm font-medium text-muted-foreground">Trước lần đồng bộ đơn đầu tiên</h2>
        <CareReportView monthLabel="10/2026" lines={LINES} totals={TOTALS} orderState={NONE} exportHref={EXPORT} />
      </section>
      <section className="space-y-3" data-testid="catalog-care-report-synced">
        <h2 className="text-sm font-medium text-muted-foreground">Đã đồng bộ</h2>
        <CareReportView monthLabel="10/2026" lines={LINES} totals={TOTALS} orderState={SYNCED} exportHref={EXPORT} />
      </section>
      <section className="space-y-3" data-testid="catalog-care-report-stale">
        <h2 className="text-sm font-medium text-muted-foreground">Lần đồng bộ gần nhất lỗi (giữ số cũ)</h2>
        <CareReportView monthLabel="10/2026" lines={LINES.slice(0, 1)} totals={careReportSummary(LINES.slice(0, 1))} orderState={STALE} exportHref={EXPORT} />
      </section>
      <section className="space-y-3" data-testid="catalog-care-report-all-converted">
        <h2 className="text-sm font-medium text-muted-foreground">Mọi task Hoàn thành đã có đơn</h2>
        <CareReportView monthLabel="10/2026" lines={ALL_CONVERTED} totals={careReportSummary(ALL_CONVERTED)} orderState={SYNCED} exportHref={EXPORT} />
      </section>
      <section className="space-y-3" data-testid="catalog-care-report-empty">
        <CareReportView monthLabel="09/2026" lines={[]} totals={careReportSummary([])} orderState={SYNCED} exportHref={EXPORT} />
      </section>
      <section className="space-y-3" data-testid="catalog-care-dashboard-orders">
        <h2 className="text-sm font-medium text-muted-foreground">Dashboard /care khi đã có dữ liệu đơn</h2>
        <CareDashboardView monthLabel="10/2026" isPast={false} totals={dashTotals} overdueOpen={7} stores={[]} outcomes={[]}
          orders={{ state: SYNCED, convertedTasks: careReportConvertedTotal(ROWS) }} />
      </section>
    </div>
  )
}
