import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { BarChart3 } from 'lucide-react'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { PageHeader } from '@/components/ds/PageHeader'
import { CareReportExportLink, CareReportView, type CareReportLinkScope } from '@/components/care/CareReportView'
import { CareReportOutcomesView } from '@/components/care/CareReportOutcomes'
import { CareContactedKpiLive, CareContactedPaceLive, CareReportExtrasProvider, CareReportOutcomesLive } from '@/components/care/CareReportExtras'
import { CareDashboardView } from '@/components/care/CareDashboardView'
import { CareFiltersBar } from '@/components/care/CareFiltersBar'
import { CareReportStoreGroup } from '@/components/care/CareReportStoreGroup'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { Table, TableCell } from '@/components/ui/table'
import { recentCarePeriods, type CareOutcomeKey, type CareReportRow } from '@/lib/care/browse'
import {
  careReportConvertedTotal, careReportExtrasKey, careReportKey, careReportLines, careReportSummary, carePeriodElapsed,
  type CareOrderDataState, type CareReportLine,
} from '@/lib/care/reports'

// Dev-only bàn thử UI báo cáo CRM (B5a r1.1; B8.2 theo artboard 13). 100% DỮ LIỆU GIẢ. Cùng cổng /ui-catalog:
// UI_CATALOG=1 (Coolify không đặt ⇒ prod 404) + super. Một action giả (fakeExtras, B8.2) tự kiểm cổng.
// B8.2: `?frame=report` dựng ĐÚNG bố cục trang /care/reports (header bộ lọc + Xuất Excel, KPI, tiến độ, kết quả, bảng).

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
// Kỳ đã đóng: task đang mở đã thành "không hoàn thành"; một phần từng có lượt (touched) vẫn tính "Đã liên hệ".
const PAST_ROWS: CareReportRow[] = [
  { store_id: S(101), assignee_id: S(1002), tasks_total: 100, completed: 60, open_not_cared: 0, open_in_progress: 0, overdue_in_period: 7, closed_unfinished: 40, converted_tasks: 22 },
]
const PAST_LINES = careReportLines(PAST_ROWS, { stores: STORES, names: NAMES }, new Map([[careReportKey(S(101), S(1002)), 15]]))
// Kết quả gần nhất mỗi task (Q-117): tổng = số khách đã liên hệ (95 + 75 + 40 = 210).
const OUTCOMES: Partial<Record<CareOutcomeKey, number>> = { NO_NEED: 60, INTERESTED: 50, ORDERED: 40, REFUSED: 20, CALLBACK: 30, UNREACHABLE: 10 }
const NONE: CareOrderDataState = { kind: 'none' }
const SYNCED: CareOrderDataState = { kind: 'synced', lastSuccessAt: '2026-10-20T01:05:00Z', lastFailed: false }
const STALE: CareOrderDataState = { kind: 'synced', lastSuccessAt: '2026-10-19T23:00:00Z', lastFailed: true }
const EXPORT = '/api/export/care?month=2026-10'
const TODAY = '2026-10-13'
const SCOPE: CareReportLinkScope = { month: '2026-10-01', storeId: null, assigneeId: null }
// PM 22/10 U2: `?frame=report-groups[&assignee=1]` — 5 POS (1 / 2 / 3 / 1 / 4 dược sĩ) để kiểm thu gọn theo POS; `assignee=1`
// = đang lọc theo một dược sĩ (nhóm chứa kết quả tự mở). Nhóm 0 dược sĩ không sinh từ careReportGroups — kiểm riêng island.
const G_STORES = new Map(Array.from({ length: 5 }, (_, i) => [S(201 + i), { code: `QAOS1${i}`, name: `QA nhóm ${i + 1}` }] as const))
const G_SIZES = [1, 2, 3, 1, 4]
const G_NAMES = new Map(G_SIZES.flatMap((n, i) => Array.from({ length: n }, (_, j) => [S(2000 + i * 10 + j), `QA DS ${i + 1}${'abcd'[j]}`] as const)))
const G_ROWS: CareReportRow[] = G_SIZES.flatMap((n, i) => Array.from({ length: n }, (_, j) => ({
  store_id: S(201 + i), assignee_id: S(2000 + i * 10 + j), tasks_total: 20 + i * 5 + j, completed: 10 + j, open_not_cared: 5 + i,
  open_in_progress: 5 + 4 * i, overdue_in_period: j, closed_unfinished: 0, converted_tasks: 3 + j, // khách = HT + chưa CS + đang theo dõi
})))
const G_LINES = careReportLines(G_ROWS, { stores: G_STORES, names: G_NAMES })

const catalogOn = () => process.env.UI_CATALOG === '1'
/** Cổng cho action giả: cùng điều kiện page (UI_CATALOG + super) — endpoint action tồn tại trong build. */
async function gate(): Promise<boolean> {
  if (!catalogOn()) return false
  const { user, profile } = await getSessionProfile()
  return !!user && profile?.role === 'admin' && isSuperAdminEmail(user.email)
}
const EXTRAS_ERROR_ASSIGNEE = S(9999)
/** B8.2: số liệu phụ giả (Đã liên hệ + Kết quả) — trễ để thấy trạng thái đang tải; assignee đặc biệt ⇒ lỗi. */
async function fakeExtras(input: { month: string; store: string | null; assignee: string | null }) {
  'use server'
  if (!(await gate())) return { ok: false as const, message: 'Không khả dụng' }
  // PM B8.2 r1: mỗi kỳ một số + độ trễ khác nhau (kỳ 09 CHẬM, kỳ 08 NHANH) ⇒ test đổi bộ lọc A→B→C với phản hồi đảo thứ tự.
  const live = LIVE_MONTHS[input.month as keyof typeof LIVE_MONTHS] ?? LIVE_MONTHS['2026-10']
  await new Promise((r) => setTimeout(r, live.delay))
  if (input.assignee === EXTRAS_ERROR_ASSIGNEE) return { ok: false as const, message: 'Không tải được — thử tải lại trang.' }
  return { ok: true as const, contacted: live.contacted, outcomes: live.contacted === TOTALS.contacted ? OUTCOMES : { NO_NEED: live.contacted } }
}
const LIVE_MONTHS = { '2026-10': { contacted: 210, delay: 800 }, '2026-09': { contacted: 75, delay: 1500 }, '2026-08': { contacted: 33, delay: 200 } } as const

function Report({ lines, state, month = '2026-10-01', outcomes = OUTCOMES }: {
  lines: CareReportLine[]; state: CareOrderDataState; month?: string; outcomes?: Partial<Record<CareOutcomeKey, number>> | null
}) {
  const totals = careReportSummary(lines)
  return (
    <CareReportView monthLabel={`${month.slice(5, 7)}/${month.slice(0, 4)}`} lines={lines} totals={totals} contacted={{ count: totals.contacted }}
      orderState={state} elapsed={carePeriodElapsed(month, TODAY)} dueLabel={month === '2026-10-01' ? '31/10/2026' : '30/09/2026'}
      scope={{ ...SCOPE, month }} outcomes={<CareReportOutcomesView counts={outcomes} />} />
  )
}

function Section({ id, title, children }: { id: string; title?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3" data-testid={id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {title ? <h2 className="text-sm font-medium text-muted-foreground">{title}</h2> : <span />}
        <CareReportExportLink href={EXPORT} />
      </div>
      {children}
    </section>
  )
}

export default async function CareReportsCatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!catalogOn()) notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const sp = await searchParams
  const dashTotals = { tasks: TOTALS.tasks, completed: TOTALS.completed, notCared: TOTALS.notCared, inProgress: TOTALS.inProgress, overdueInPeriod: TOTALS.overdueInPeriod, closedUnfinished: TOTALS.closedUnfinished }

  // B8.2: khung có số liệu phụ tải SAU khi hiện (như trang thật) — kiểm "…" → số, và lỗi ⇒ "—" (không 0 giả).
  if (sp.frame === 'report-live') {
    const err = sp.extras === 'error'
    const m = typeof sp.m === 'string' && sp.m in LIVE_MONTHS ? sp.m : '2026-10'
    const params = { month: m, store: null, assignee: err ? EXTRAS_ERROR_ASSIGNEE : null }
    return (
      <div data-layout-width="fluid" data-care-browse className="space-y-4 p-4 md:p-6" data-testid="catalog-frame-report-live" data-month={m}>
        <PageHeader title="Báo cáo chăm sóc khách hàng" subtitle="UI catalog — số liệu phụ tải sau" icon={BarChart3}
          actions={(
            // Đổi kỳ bằng điều hướng CLIENT (giữ cây React như trang thật đổi bộ lọc) — test r1 A→B→C.
            <nav className="flex gap-2" aria-label="Kỳ thử">
              {(['2026-10', '2026-09', '2026-08'] as const).map((k, i) => (
                <Link key={k} href={`/ui-catalog/care-reports?frame=report-live&m=${k}`} className="underline">{`Kỳ ${'ABC'[i]}`}</Link>
              ))}
            </nav>
          )} />
        {/* Như trang thật: key theo bộ lọc ⇒ đổi bộ lọc là provider mới (không giữ số của bộ lọc cũ — PM B8.2 r1). */}
        <CareReportExtrasProvider key={careReportExtrasKey(params)} load={fakeExtras} params={params}>
          <CareReportView monthLabel={`${m.slice(5, 7)}/${m.slice(0, 4)}`} lines={LINES} totals={TOTALS} orderState={NONE} elapsed={carePeriodElapsed(`${m}-01`, TODAY)}
            dueLabel="31/10/2026" scope={SCOPE} contacted={{ kpi: <CareContactedKpiLive tasks={TOTALS.tasks} />, pace: <CareContactedPaceLive tasks={TOTALS.tasks} /> }}
            outcomes={<CareReportOutcomesLive />} />
        </CareReportExtrasProvider>
      </div>
    )
  }

  if (sp.frame === 'report') {
    const filters = { month: '2026-10-01', storeId: null, assigneeId: null, status: null, page: 1 }
    return (
      <div data-layout-width="fluid" data-care-browse className="space-y-4 p-4 md:p-6" data-testid="catalog-frame-report">
        <PageHeader title="Báo cáo chăm sóc khách hàng" subtitle="Theo tháng chăm sóc — khách có đơn ghi vào tháng của lượt Hoàn thành" icon={BarChart3}
          actions={(
            <div className="flex flex-wrap items-center gap-2">
              <CareFiltersBar path="/ui-catalog/care-reports" filters={filters} months={recentCarePeriods('2026-10-01')}
                stores={[...STORES].map(([id, s]) => ({ id, ...s }))} staff={[...NAMES].map(([id, fullName]) => ({ id, fullName, storeCode: id === S(1004) ? 'QAOS02' : 'QAOS01' }))} />
              <CareReportExportLink href={EXPORT} />
            </div>
          )} />
        <Report lines={LINES} state={sp.orders === 'synced' ? SYNCED : NONE} />
      </div>
    )
  }

  if (sp.frame === 'report-groups') {
    const one = sp.assignee === '1' ? S(2011) : null
    const lines = one ? G_LINES.filter((l) => l.assigneeId === one) : G_LINES
    const totals = careReportSummary(lines)
    return (
      <div data-layout-width="fluid" data-care-browse className="space-y-4 p-4 md:p-6" data-testid="catalog-frame-report-groups">
        <PageHeader title="Báo cáo chăm sóc khách hàng" icon={BarChart3} actions={<CareReportExportLink href={EXPORT} />} />
        <CareReportView monthLabel="10/2026" lines={lines} totals={totals} contacted={{ count: totals.contacted }} orderState={SYNCED}
          elapsed={carePeriodElapsed('2026-10-01', TODAY)} dueLabel="31/10/2026" scope={{ ...SCOPE, assigneeId: one }} />
        <section data-testid="catalog-zero-group" className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Nhóm POS 0 dược sĩ (island riêng — careReportGroups không sinh nhóm rỗng)</h2>
          <DataTableShell>
            <Table>
              <CareReportStoreGroup groupId="care-report-g-zero" label="QAOS99 · QA nhóm rỗng" count={0} defaultOpen
                storeCells={<TableCell className="text-right tabular-nums">0</TableCell>} assigneeRows={null} />
            </Table>
          </DataTableShell>
        </section>
      </div>
    )
  }

  return (
    <div data-layout-width="fluid" data-care-browse className="space-y-10 p-4 md:p-6">
      <PageHeader title="Báo cáo chăm sóc khách hàng" subtitle="UI catalog — dữ liệu giả" icon={BarChart3} />
      <Section id="catalog-care-report-none" title="Trước lần đồng bộ đơn đầu tiên"><Report lines={LINES} state={NONE} /></Section>
      <Section id="catalog-care-report-synced" title="Đã đồng bộ"><Report lines={LINES} state={SYNCED} /></Section>
      <Section id="catalog-care-report-stale" title="Lần đồng bộ gần nhất lỗi (giữ số cũ)"><Report lines={LINES.slice(0, 1)} state={STALE} outcomes={null} /></Section>
      <Section id="catalog-care-report-all-converted" title="Mọi task Hoàn thành đã có đơn"><Report lines={ALL_CONVERTED} state={SYNCED} /></Section>
      <Section id="catalog-care-report-past" title="Kỳ đã đóng (09/2026) — Đã liên hệ gồm task không hoàn thành từng có lượt">
        <Report lines={PAST_LINES} state={SYNCED} month="2026-09-01" outcomes={{ NO_NEED: 30, INTERESTED: 20, ORDERED: 10, CALLBACK: 10, UNREACHABLE: 5 }} />
      </Section>
      <Section id="catalog-care-report-empty"><Report lines={[]} state={SYNCED} month="2026-09-01" /></Section>
      <section className="space-y-3" data-testid="catalog-care-dashboard-orders">
        <h2 className="text-sm font-medium text-muted-foreground">Dashboard /care khi đã có dữ liệu đơn</h2>
        <CareDashboardView monthLabel="10/2026" isPast={false} totals={dashTotals} overdueOpen={7} stores={[]} outcomes={[]}
          orders={{ state: SYNCED, convertedTasks: careReportConvertedTotal(ROWS) }} />
      </section>
    </div>
  )
}
