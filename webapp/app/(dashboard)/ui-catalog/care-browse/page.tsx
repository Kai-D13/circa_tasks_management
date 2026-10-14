import { notFound, redirect } from 'next/navigation'
import { ClipboardList, HeartHandshake } from 'lucide-react'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { PageHeader } from '@/components/ds/PageHeader'
import { FilterTabs } from '@/components/ds/FilterTabs'
import { CareDashboardView } from '@/components/care/CareDashboardView'
import { CareUnavailableState } from '@/components/care/CareUnavailableState'
import { CareFiltersBar } from '@/components/care/CareFiltersBar'
import { CareTaskTable, type CareTaskListRow } from '@/components/care/CareTaskTable'
import { CareTaskDetailView } from '@/components/care/CareTaskDetailView'
import { CareTaskTransferButton } from '@/components/care/CareTaskTransferButton'
import type { CareTaskPanelResult } from '@/components/care/CareTaskDrawer'
import {
  CARE_INTERACTION_PAGE_SIZE, CARE_TRANSFER_MESSAGES, careInteractionPage, careOutcomeDistribution, careStatusChipTabs, parseCareOpenParam,
  recentCarePeriods, type CareFilters, type CareStatusCounts, type CareTotals,
} from '@/lib/care/browse'
import { maskVnPhone } from '@/lib/affiliate/phone'

// Dev-only bàn thử UI browser CRM (B3). 100% DỮ LIỆU GIẢ — DB chưa có migration 114
// nên trang thật /care* chưa chạy được end-to-end. Cùng cổng /ui-catalog: UI_CATALOG=1
// (Coolify không đặt ⇒ prod 404) + super. Action giả tự kiểm cổng (endpoint action
// tồn tại trong build nên không được trả gì khi UI_CATALOG tắt).

const S = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const STAFF = [
  { id: S(901), fullName: 'QA Dược sĩ 01a', email: 'qa.care.s01a@example.invalid', storeId: S(101), storeCode: 'QAOS01', storeName: 'QA store 1' },
  { id: S(902), fullName: 'QA Dược sĩ 01b', email: 'qa.care.s01b@example.invalid', storeId: S(101), storeCode: 'QAOS01', storeName: 'QA store 1' },
  { id: S(903), fullName: 'QA Dược sĩ 02a', email: 'qa.care.s02a@example.invalid', storeId: S(102), storeCode: 'QAOS02', storeName: 'QA store 2' },
]
const PHONES = Array.from({ length: 6 }, (_, i) => `039000000${i + 1}`)
const ROWS: CareTaskListRow[] = Array.from({ length: 6 }, (_, i) => ({
  id: S(500 + i),
  customer_name: `KH QA 0000${i + 1}`,
  phone_masked: maskVnPhone(PHONES[i]),
  status: (['open', 'open', 'open', 'completed', 'open', 'closed_unfinished'] as const)[i],
  last_outcome: [null, 'CALLBACK', 'CALLBACK', 'INTERESTED', null, null][i],
  last_interaction_at: [null, '2026-10-05T03:00:00Z', '2026-10-06T03:00:00Z', '2026-10-07T03:00:00Z', null, null][i],
  next_action_date: [null, '2026-10-20', '2026-10-02', null, null, null][i],
  store_id: i < 3 ? S(101) : S(102),
  assignee_id: i < 3 ? S(901) : S(903),
  store: i < 3 ? { code: 'QAOS01', name: 'QA store 1' } : { code: 'QAOS02', name: 'QA store 2' },
  assignee: { full_name: i < 3 ? 'QA Dược sĩ 01a' : 'QA Dược sĩ 02a' },
  product_count: i === 1 ? 2 : 1,
}))
// B8.1: số chip NHẤT QUÁN với ROWS (today 2026-10-10): 4 nhóm rời nhau 2+2+1+1 = 6; quá hạn (1) nằm trong đang theo dõi.
const COUNTS: CareStatusCounts = { all: 6, not_cared: 2, following: 2, overdue_open: 1, completed: 1, closed_unfinished: 1 }
const STORES = [{ id: S(101), code: 'QAOS01', name: 'QA store 1' }, { id: S(102), code: 'QAOS02', name: 'QA store 2' }]
// Tải đang mở giả theo dược sĩ (null = không đọc được ⇒ không hiện số).
const OPEN_LOAD: Record<string, number | null> = { [S(901)]: 3, [S(902)]: 0, [S(903)]: null }
const NOT_FOUND_MSG = 'Không tìm thấy khách này trong phạm vi của bạn.'
// Số giả NHẤT QUÁN: các đoạn của mỗi thanh cộng đúng bằng tasks (kỳ hiện tại chưa có 'không hoàn thành').
const TOTALS: CareTotals = { tasks: 100, completed: 41, notCared: 30, inProgress: 29, overdueInPeriod: 9, closedUnfinished: 0 }
const PAST: CareTotals = { tasks: 100, completed: 41, notCared: 0, inProgress: 0, overdueInPeriod: 9, closedUnfinished: 59 }

const catalogOn = () => process.env.UI_CATALOG === '1'
/** Cổng cho action giả: cùng điều kiện với page (UI_CATALOG + super) — endpoint action tồn tại trong build. */
async function gate(): Promise<boolean> {
  if (!catalogOn()) return false
  const { user, profile } = await getSessionProfile()
  return !!user && profile?.role === 'admin' && isSuperAdminEmail(user.email)
}

async function fakeTargets() {
  'use server'
  if (!(await gate())) return { ok: false as const, message: 'Không khả dụng' }
  return { ok: true as const, staff: STAFF.map(({ email: _e, ...s }) => ({ ...s, openCount: OPEN_LOAD[s.id] })) }
}
async function fakeTransfer(input: { taskIds: string[]; toUserId: string; note: string }) {
  'use server'
  if (!(await gate())) return { ok: false as const, code: 'FORBIDDEN', message: 'Không khả dụng' }
  await new Promise((r) => setTimeout(r, 700))
  if (input.note.includes('DNC')) return { ok: false as const, code: 'REFUSED_AT_TARGET', message: CARE_TRANSFER_MESSAGES.REFUSED_AT_TARGET }
  return { ok: true as const, transferred: input.taskIds.length }
}
// Lịch sử giả 23 lượt (Q-78): trang đầu 10, "Xem thêm" ×2 (10 + 3). id ↓ = mới → cũ.
const FAKE_HISTORY = Array.from({ length: 23 }, (_, k) => {
  const id = 30 - k
  const day = String(Math.max(1, 28 - k)).padStart(2, '0')
  return { id, outcome: 'CALLBACK', note: `QA: lượt giả #${id}`, next_action_date: null, task_id: k < 2 ? ROWS[1].id : S(499),
    created_at: `${k < 8 ? '2026-10' : '2026-09'}-${day}T03:00:00Z`, actor: { full_name: k % 2 ? 'QA Dược sĩ 01b' : 'QA Dược sĩ 01a' } }
})
const fakePage = (before: number | null) => careInteractionPage(FAKE_HISTORY.filter((h) => before === null || h.id < before).slice(0, CARE_INTERACTION_PAGE_SIZE + 1), ROWS[1].id, Date.parse('2026-10-10T05:00:00Z'))
async function fakeLoadMore(input: { taskId: string; beforeId: number }) {
  'use server'
  if (!(await gate())) return { ok: false as const, message: 'Không khả dụng' }
  await new Promise((r) => setTimeout(r, 400))
  return { ok: true as const, page: fakePage(Number(input.beforeId)) }
}
async function fakeSearch(input: { params: Record<string, string>; q: string; page: number }) {
  'use server'
  if (!(await gate())) return { ok: false as const, message: 'Không khả dụng' }
  const q = String(input.q).toLowerCase()
  // B8.1: từ khoá chứa "00001" trả CHẬM hơn — test phản hồi cũ không ghi đè phản hồi mới.
  await new Promise((r) => setTimeout(r, q.includes('00001') ? 1500 : 150))
  if (q === 'qa-loi') return { ok: false as const, message: 'Không tải được danh sách — thử lại.' }
  const rows = ROWS.filter((r, i) => r.customer_name.toLowerCase().includes(q) || PHONES[i].includes(q))
  return { ok: true as const, rows, total: rows.length }
}
/** B8.1 drawer giả: id ngoài ROWS ⇒ NOT_FOUND (mô phỏng task ngoài phạm vi RLS), không trả số nào. */
async function fakePanel(input: { taskId: string }): Promise<CareTaskPanelResult> {
  'use server'
  if (!(await gate())) return { ok: false, code: 'FORBIDDEN', message: 'Không khả dụng' }
  await new Promise((r) => setTimeout(r, 300))
  const i = ROWS.findIndex((r) => r.id === input.taskId)
  if (i < 0) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND_MSG }
  const r = ROWS[i]
  return {
    ok: true, taskId: r.id, qa: false,
    data: {
      task: { ...r, phone_norm: PHONES[i], phone_raw: PHONES[i], period_month: '2026-10-01', due_date: '2026-10-31', first_overdue_on: i === 2 ? '2026-10-03' : null, completed_at: r.status === 'completed' ? '2026-10-07T03:00:00Z' : null, closed_at: null },
      products: Array.from({ length: r.product_count }, (_, k) => ({ id: `p${i}${k}`, product_id: `QA-SKU-000${k + 1}`, product_name: `Sản phẩm QA 000${k + 1}`, image_url: null, reason_type: 'promotion', reason_text: 'QA: sản phẩm đang có chương trình tháng' })),
      interactions: i === 1 ? fakePage(null) : { rows: [], hasMore: false, nextBefore: null },
      events: [{ id: 10, kind: 'assigned', note: null, created_at: '2026-10-01T02:00:00Z', from_user: null, to_user: r.assignee, actor: { full_name: 'QA Marketing' }, from_store: null, to_store: r.store ? { code: r.store.code } : null }],
    },
    transfer: r.status === 'open' ? { id: r.id, customerName: r.customer_name, storeId: r.store_id, storeCode: r.store?.code ?? '—', assigneeId: r.assignee_id, assigneeName: r.assignee?.full_name ?? '—' } : null,
  }
}

const FRAME_FILTERS: CareFilters = { month: '2026-10-01', storeId: null, assigneeId: null, status: null, page: 1 }

export default async function CareBrowseCatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!catalogOn()) notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const sp = await searchParams

  // B8.1: `?frame=tasks[&open=<uuid>]` dựng ĐÚNG bố cục trang /care/tasks (header + chip + bảng + drawer) để test/chụp.
  if (sp.frame === 'tasks') {
    return (
      <div data-layout-width="fluid" data-care-browse className="space-y-4 p-4 md:p-6" data-testid="catalog-frame-tasks">
        <PageHeader title="Chăm sóc khách hàng" subtitle="Danh sách khách cần chăm sóc theo kỳ · hạn 31/10/2026" icon={ClipboardList}
          actions={<CareFiltersBar path="/ui-catalog/care-browse" filters={FRAME_FILTERS} months={recentCarePeriods('2026-10-01')} />} />
        <FilterTabs variant="chip" ariaLabel="Lọc theo trạng thái" activeKey="all" tabs={careStatusChipTabs('/ui-catalog/care-browse', FRAME_FILTERS, COUNTS)} />
        <CareTaskTable rows={ROWS} total={ROWS.length} pageSize={30} path="/ui-catalog/care-browse" todayISO="2026-10-10" filters={FRAME_FILTERS}
          canTransfer isCurrentPeriod search={fakeSearch} loadTargets={fakeTargets} transfer={fakeTransfer} loadPanel={fakePanel} loadMore={fakeLoadMore}
          initialOpenId={parseCareOpenParam(sp)}
          toolbar={<CareFiltersBar path="/ui-catalog/care-browse" filters={FRAME_FILTERS} stores={STORES} staff={STAFF} clearable />} />
      </div>
    )
  }

  // B8.4: `?frame=dashboard[&past=1|&fresh=1|&empty=1|&synced=1|&store=1|&unavailable=1]` dựng ĐÚNG bố cục trang /care
  // (header lọc + KPI link + 2 panel). `empty` = kỳ 0 task (PM B8.4 R1-01); `synced` = N3 đã đồng bộ (0 khách có đơn).
  if (sp.frame === 'dashboard') {
    const past = sp.past === '1'
    const filters: CareFilters = { ...FRAME_FILTERS, month: past ? '2026-09-01' : '2026-10-01', storeId: sp.store === '1' ? STORES[0].id : null }
    const fresh = sp.fresh === '1' // kỳ mới import, chưa có lượt nào (artboard 05)
    const empty = sp.empty === '1'
    const totals: CareTotals = empty ? { tasks: 0, completed: 0, notCared: 0, inProgress: 0, overdueInPeriod: 0, closedUnfinished: 0 }
      : past ? PAST : fresh ? { tasks: 12, completed: 0, notCared: 12, inProgress: 0, overdueInPeriod: 0, closedUnfinished: 0 } : TOTALS
    const orders = sp.synced === '1' ? { state: { kind: 'synced' as const, lastSuccessAt: '2026-10-20T01:05:00Z', lastFailed: false }, convertedTasks: 0 } : undefined
    return (
      <div data-layout-width="fluid" data-care-browse className="space-y-4 p-4 md:p-6" data-testid="catalog-frame-dashboard">
        <PageHeader title="Chăm sóc khách hàng" subtitle="Tổng quan theo kỳ — mỗi khách một task trong tháng" icon={HeartHandshake}
          actions={<CareFiltersBar path="/ui-catalog/care-browse" filters={filters} months={recentCarePeriods('2026-10-01')} stores={STORES} />} />
        {sp.unavailable === '1' ? <CareUnavailableState /> : (
          <CareDashboardView monthLabel={past ? '09/2026' : '10/2026'} isPast={past} totals={totals} overdueOpen={past ? null : fresh || empty ? 0 : 4}
            stores={empty ? [] : fresh
              ? [{ code: 'QAOS01', name: 'QA store 1', totals }]
              : [{ code: 'QAOS01', name: 'QA store 1', totals: { tasks: 60, completed: 25, notCared: 18, inProgress: 17, overdueInPeriod: 6, closedUnfinished: 0 } }, { code: 'QAOS02', name: 'QA store 2', totals: { tasks: 40, completed: 16, notCared: 12, inProgress: 12, overdueInPeriod: 3, closedUnfinished: 0 } }]}
            outcomes={careOutcomeDistribution(empty ? {} : fresh ? { none: 12 } : { none: 30, INTERESTED: 25, CALLBACK: 29, REFUSED: 16 })}
            orders={orders} scope={{ month: filters.month, storeId: filters.storeId }} assignees={empty ? 0 : fresh ? 1 : 3} />
        )}
      </div>
    )
  }

  return (
    <div data-layout-width="fluid" className="space-y-8 p-4 md:p-6">
      <PageHeader title="Chăm sóc khách hàng" subtitle="UI catalog — dữ liệu giả" icon={HeartHandshake} />
      <section className="space-y-3" data-testid="catalog-care-dashboard">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Dashboard — kỳ hiện tại</h2>
        <CareDashboardView monthLabel="10/2026" isPast={false} totals={TOTALS} overdueOpen={4}
          stores={[{ code: 'QAOS01', name: 'QA store 1', totals: { tasks: 60, completed: 25, notCared: 18, inProgress: 17, overdueInPeriod: 6, closedUnfinished: 0 } }, { code: 'QAOS02', name: 'QA store 2', totals: { tasks: 40, completed: 16, notCared: 12, inProgress: 12, overdueInPeriod: 3, closedUnfinished: 0 } }]}
          outcomes={careOutcomeDistribution({ none: 30, INTERESTED: 25, CALLBACK: 29, REFUSED: 16 })} />
      </section>
      <section className="space-y-3" data-testid="catalog-care-dashboard-past">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Dashboard — kỳ cũ</h2>
        <CareDashboardView monthLabel="09/2026" isPast totals={PAST} overdueOpen={null} stores={[]} outcomes={careOutcomeDistribution({})} />
      </section>
      <section className="space-y-3" data-testid="catalog-care-table">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Danh sách (SM/super)</h2>
        <CareTaskTable rows={ROWS} total={ROWS.length} pageSize={30} path="/ui-catalog/care-browse" todayISO="2026-10-10"
          filters={{ month: '2026-10-01', storeId: null, assigneeId: null, status: null, page: 1 }}
          canTransfer isCurrentPeriod search={fakeSearch} loadTargets={fakeTargets} transfer={fakeTransfer} />
      </section>
      <section className="space-y-3" data-testid="catalog-care-table-empty">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Danh sách rỗng (QLCH, kỳ cũ)</h2>
        <CareTaskTable rows={[]} total={0} pageSize={30} path="/ui-catalog/care-browse" todayISO="2026-10-10"
          filters={{ month: '2026-09-01', storeId: null, assigneeId: null, status: 'overdue_open', page: 1 }}
          canTransfer={false} isCurrentPeriod={false} search={fakeSearch} loadTargets={fakeTargets} transfer={fakeTransfer} />
      </section>
      <section className="space-y-3" data-testid="catalog-care-detail">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Chi tiết</h2>
        <CareTaskDetailView taskId={ROWS[1].id} todayISO="2026-10-10" loadMore={fakeLoadMore}
          actions={<CareTaskTransferButton task={{ id: ROWS[1].id, customerName: ROWS[1].customer_name, storeId: S(101), storeCode: 'QAOS01', assigneeId: S(901), assigneeName: 'QA Dược sĩ 01a' }} loadTargets={fakeTargets} transfer={fakeTransfer} />}
          data={{
            task: { ...ROWS[1], phone_norm: PHONES[1], phone_raw: '0390 000 002', period_month: '2026-10-01', due_date: '2026-10-31', first_overdue_on: null, completed_at: null, closed_at: null },
            products: [
              { id: 'p1', product_id: 'QA-SKU-0001', product_name: 'Sản phẩm QA 0001', image_url: null, reason_type: 'chronic', reason_text: 'QA: khách dùng thuốc định kỳ, sắp hết liều' },
              { id: 'p2', product_id: 'QA-SKU-0002', product_name: 'Sản phẩm QA 0002 có tên rất dài để kiểm tra cắt dòng hai dòng trên màn hình nhỏ', image_url: 'https://example.invalid/ngoai-cdn.png', reason_type: 'promotion', reason_text: 'QA: sản phẩm đang có chương trình tháng' },
            ],
            interactions: fakePage(null),
            events: [
              { id: 11, kind: 'transferred', note: 'QA: dược sĩ nghỉ phép', created_at: '2026-10-04T03:00:00Z', from_user: { full_name: 'QA Dược sĩ 01b' }, to_user: { full_name: 'QA Dược sĩ 01a' }, actor: { full_name: 'QA SM' }, from_store: { code: 'QAOS01' }, to_store: { code: 'QAOS01' } },
              { id: 10, kind: 'assigned', note: null, created_at: '2026-10-01T02:00:00Z', from_user: null, to_user: { full_name: 'QA Dược sĩ 01b' }, actor: { full_name: 'QA Marketing' }, from_store: null, to_store: { code: 'QAOS01' } },
            ],
          }} />
      </section>
      {/* Q-107 (B7-ui r1.1): chế độ QA local — vẫn tel: với số của task QA, thêm dòng nhận biết số giả. */}
      <section className="space-y-3" data-testid="catalog-care-detail-qa">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Chi tiết — chế độ QA</h2>
        <CareTaskDetailView taskId={ROWS[2].id} todayISO="2026-10-10" qa
          data={{
            // Cùng số đầy đủ với khối chi tiết ở trên (0390000002) — số của các hàng danh sách khác không được vào HTML.
            task: { ...ROWS[2], phone_norm: PHONES[1], phone_raw: PHONES[1], period_month: '2026-10-01', due_date: '2026-10-31', first_overdue_on: null, completed_at: null, closed_at: null },
            products: [], interactions: { rows: [], hasMore: false, nextBefore: null }, events: [],
          }} />
      </section>
    </div>
  )
}
