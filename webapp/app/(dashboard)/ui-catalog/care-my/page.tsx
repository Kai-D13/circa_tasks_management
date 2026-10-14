import { notFound, redirect } from 'next/navigation'
import { HeartHandshake } from 'lucide-react'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { PageHeader } from '@/components/ds/PageHeader'
import { CareMyHome, type CareMyRow } from '@/components/care/CareMyHome'
import { CareMyTaskDetail } from '@/components/care/CareMyTaskDetail'
import { CareInteractionForm } from '@/components/care/CareInteractionForm'
import { CareMyHeader } from '@/components/care/CareMyHeader'
import { CareMyScreen } from '@/components/care/CareMyScreen'
import type { CareMyDetailData } from '@/components/care/CareMyTaskDetail'
import { careInteractionPage, CARE_INTERACTION_PAGE_SIZE } from '@/lib/care/browse'
import { CARE_RECORD_MESSAGES, CARE_PROOF_PUBLIC_BASE } from '@/lib/care/my'
import { maskVnPhone } from '@/lib/affiliate/phone'
import { CARE_OUTCOME_META, isCareOutcome } from '@/lib/care/outcome'

// Dev-only bàn thử UI màn dược sĩ CRM (B4). 100% DỮ LIỆU GIẢ — DB chưa có migration 114.
// Cùng cổng /ui-catalog: UI_CATALOG=1 (Coolify không đặt ⇒ prod 404) + super, ở page VÀ
// mỗi action giả (endpoint action tồn tại trong build).
// B7-ui r2: `?frame=list|detail|readonly|update[&qa=1]` dựng ĐÚNG MỘT màn theo bố cục trang thật (CareMyScreen +
// header riêng) để test/chụp 360/390 như production; không có `frame` ⇒ bàn thử nhiều section như cũ.

const S = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const TASK = S(700)
const PHONES = Array.from({ length: 6 }, (_, i) => `039000001${i}`)
const ROWS: CareMyRow[] = [
  { id: S(701), customer_name: 'KH QA quá hạn', phone_masked: maskVnPhone(PHONES[0]), status: 'open', last_outcome: 'CALLBACK', last_interaction_at: '2026-10-03T03:00:00Z', next_action_date: '2026-10-05', due_date: '2026-10-31' },
  { id: S(702), customer_name: 'KH QA hẹn hôm nay', phone_masked: maskVnPhone(PHONES[1]), status: 'open', last_outcome: 'CALLBACK', last_interaction_at: '2026-10-04T03:00:00Z', next_action_date: '2026-10-10', due_date: '2026-10-31' },
  { id: S(703), customer_name: 'KH QA hẹn cuối tháng', phone_masked: maskVnPhone(PHONES[2]), status: 'open', last_outcome: 'CALLBACK', last_interaction_at: '2026-10-06T03:00:00Z', next_action_date: '2026-10-31', due_date: '2026-10-31' },
  { id: S(704), customer_name: 'KH QA chưa chăm sóc có tên rất dài để kiểm tra cắt dòng trên màn hình 360', phone_masked: maskVnPhone(PHONES[3]), status: 'open', last_outcome: null, last_interaction_at: null, next_action_date: null, due_date: '2026-10-31' },
  { id: S(705), customer_name: 'KH QA hoàn thành', phone_masked: maskVnPhone(PHONES[4]), status: 'completed', last_outcome: 'INTERESTED', last_interaction_at: '2026-10-07T03:00:00Z', next_action_date: null, due_date: '2026-10-31' },
]
const CDN = 'https://cdn-gcs.thuocsi.vn/qa-fixture'
const PROOF = (k: number) => `${CARE_PROOF_PUBLIC_BASE}/care-proof/${TASK}/17000000000${String(k).padStart(2, '0')}_abcd12${String(k).padStart(2, '0')}.jpg`
// "Bây giờ" GHIM của mock (= todayISO 10/10) ⇒ trạng thái ảnh hết hạn (Q-85) không đổi theo ngày chạy test.
const MOCK_NOW = Date.parse('2026-10-10T05:00:00Z')
// 13 lượt giả (Q-78: 10 + "Xem thêm" 3). Lượt mới nhất có 1 ảnh minh chứng; lượt #49 có ảnh mà
// test UI giả lập tải lỗi; lượt cũ nhất (#38, 20/06 — quá 90 ngày) có ảnh đã hết hạn lưu (Q-85).
const HISTORY = Array.from({ length: 13 }, (_, k) => ({
  id: 50 - k, outcome: 'CALLBACK', note: `QA lượt #${50 - k}`, next_action_date: k === 0 ? '2026-10-20' : null,
  created_at: k === 12 ? '2026-06-20T03:00:00Z' : `2026-${k < 6 ? '10' : '09'}-${String(28 - k).padStart(2, '0')}T03:00:00Z`,
  task_id: k < 3 ? TASK : S(699),
  actor: { full_name: 'QA Dược sĩ 01a' }, proof: k === 0 ? [{ url: PROOF(1) }] : k === 1 ? [{ url: PROOF(2) }] : k === 12 ? [{ url: PROOF(3) }] : null,
}))
const page = (before: number | null) => careInteractionPage(HISTORY.filter((h) => before === null || h.id < before).slice(0, CARE_INTERACTION_PAGE_SIZE + 1), TASK, MOCK_NOW)

const DETAIL: CareMyDetailData = {
  task: { id: TASK, customer_name: 'KH QA 00701', phone_raw: '0390 000 010', phone_norm: PHONES[0], period_month: '2026-10-01', due_date: '2026-10-31',
    status: 'open', last_outcome: 'CALLBACK', last_interaction_at: '2026-10-28T03:00:00Z', next_action_date: '2026-10-20',
    store: { code: 'QAOS01', name: 'QA store 1' }, assignee: { full_name: 'QA Dược sĩ 01a' } },
  products: [
    { id: 'p1', product_id: 'QA-SKU-0001', product_name: 'Sản phẩm QA 0001', image_url: `${CDN}/p1.png`, reason_type: 'chronic', reason_text: 'QA: dùng định kỳ, sắp hết liều' },
    { id: 'p2', product_id: 'QA-SKU-0002', product_name: 'Sản phẩm QA 0002', image_url: `${CDN}/p2.png`, reason_type: 'promotion', reason_text: 'QA: đang có chương trình' },
  ],
  interactions: page(null),
  events: [
    { id: 1, kind: 'assigned', note: null, created_at: '2026-10-01T02:00:00Z', from_user: null, to_user: { full_name: 'QA Dược sĩ 01b' }, actor: { full_name: 'QA Marketing' }, from_store: null, to_store: { code: 'QAOS01' } },
    // Q-83: dược sĩ đang phụ trách thấy ghi chú chuyển giao của SM.
    { id: 2, kind: 'transferred', note: 'QA ghi chú SM: khách hẹn gọi buổi chiều', created_at: '2026-10-02T02:00:00Z', from_user: { full_name: 'QA Dược sĩ 01b' }, to_user: { full_name: 'QA Dược sĩ 01a' }, actor: { full_name: 'QA SM' }, from_store: { code: 'QAOS01' }, to_store: { code: 'QAOS01' } },
  ],
}
const READONLY: CareMyDetailData = {
  task: { id: S(705), customer_name: 'KH QA hoàn thành', phone_raw: '0390000014', phone_norm: PHONES[4], period_month: '2026-10-01', due_date: '2026-10-31',
    status: 'completed', last_outcome: 'INTERESTED', last_interaction_at: '2026-10-07T03:00:00Z', next_action_date: null,
    store: { code: 'QAOS01', name: 'QA store 1' }, assignee: { full_name: 'QA Dược sĩ 01a' } },
  products: [], interactions: { rows: [], hasMore: false, nextBefore: null }, events: [],
}
const QA_DETAIL: CareMyDetailData = {
  task: { id: S(706), customer_name: 'KH QA 001', phone_raw: PHONES[5], phone_norm: PHONES[5], period_month: '2026-10-01', due_date: '2026-10-31',
    status: 'open', last_outcome: null, last_interaction_at: null, next_action_date: null,
    store: { code: 'QAOS01', name: 'QA store 1' }, assignee: { full_name: 'QA Dược sĩ 01a' } },
  products: [], interactions: { rows: [], hasMore: false, nextBefore: null }, events: [],
}
const SUMMARY = { assigned: 5, notCared: 1, completed: 1, overdueLive: 1 }

const catalogOn = () => process.env.UI_CATALOG === '1'
async function gate(): Promise<boolean> {
  if (!catalogOn()) return false
  const { user, profile } = await getSessionProfile()
  return !!user && profile?.role === 'admin' && isSuperAdminEmail(user.email)
}

async function fakeSearch(input: { filter: string; q: string; page: number }) {
  'use server'
  if (!(await gate())) return { ok: false as const, message: 'Không khả dụng' }
  const q = String(input.q).toLowerCase()
  if (q === 'qa-loi') return { ok: false as const, message: 'Không tải được danh sách — thử lại.' }
  const rows = ROWS.filter((r, i) => r.customer_name.toLowerCase().includes(q) || PHONES[i].includes(q))
  return { ok: true as const, rows, total: rows.length }
}
async function fakeLoadMore(input: { taskId: string; beforeId: number }) {
  'use server'
  if (!(await gate())) return { ok: false as const, message: 'Không khả dụng' }
  await new Promise((r) => setTimeout(r, 300))
  return { ok: true as const, page: page(Number(input.beforeId)) }
}
async function fakeRecord(input: { taskId: string; outcome: string; note: string; nextActionDate: string | null; proofUrls: string[] }) {
  'use server'
  if (!(await gate())) return { ok: false as const, code: 'FORBIDDEN', message: 'Không khả dụng' }
  await new Promise((r) => setTimeout(r, 700))
  if (String(input.note).includes('QA-RPC-LOI')) return { ok: false as const, code: 'NOT_ASSIGNEE', message: CARE_RECORD_MESSAGES.NOT_ASSIGNEE }
  return { ok: true as const, status: (isCareOutcome(input.outcome) && CARE_OUTCOME_META[input.outcome].terminal ? 'completed' : 'open') as 'open' | 'completed' }
}

export default async function CareMyCatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!catalogOn()) notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const sp = await searchParams
  const frame = typeof sp.frame === 'string' ? sp.frame : null
  const qa = sp.qa === '1'
  const BASE = '/ui-catalog/care-my'
  if (frame === 'list') {
    return (
      <CareMyScreen screen="list">
        <CareMyHeader screen="list" qa={qa} />
        <div className="px-4 pt-1 pb-4 md:p-0" data-testid="catalog-care-my-home">
          <CareMyHome summary={SUMMARY} rows={ROWS} total={ROWS.length} filter="all" page={1}
            pageSize={20} todayISO="2026-10-10" search={fakeSearch} basePath={BASE} />
        </div>
      </CareMyScreen>
    )
  }
  if (frame === 'detail' || frame === 'readonly') {
    return (
      <CareMyScreen screen="detail">
        <CareMyHeader screen="detail" back={{ href: `${BASE}?frame=list`, label: 'Khách hàng của tôi' }} qa={qa} />
        <CareMyTaskDetail todayISO="2026-10-10" canRecord={frame === 'detail'} updateHref={`${BASE}?frame=update`} loadMore={fakeLoadMore} qa={qa}
          data={frame === 'readonly' ? READONLY : qa ? QA_DETAIL : DETAIL} />
      </CareMyScreen>
    )
  }
  if (frame === 'update') {
    return (
      <CareMyScreen screen="update">
        <CareMyHeader screen="update" back={{ href: `${BASE}?frame=detail`, label: 'Chi tiết khách' }} subtitle="KH QA 00701" qa={qa} />
        <CareInteractionForm taskId={TASK} customerName="KH QA 00701" todayISO="2026-10-10" dueDate="2026-10-31" record={fakeRecord}
          doneHref={`${BASE}?frame=detail&saved=1`} proofDisabled={qa} />
      </CareMyScreen>
    )
  }

  return (
    <div data-layout-width="fluid" className="space-y-8 p-4 md:p-6">
      <PageHeader title="Khách hàng của tôi" subtitle="UI catalog — dữ liệu giả" icon={HeartHandshake} />
      <section className="space-y-3" data-testid="catalog-care-my-home">
        <CareMyHome summary={SUMMARY} rows={ROWS} total={ROWS.length} filter="all" page={1}
          pageSize={20} todayISO="2026-10-10" search={fakeSearch} basePath="/ui-catalog/care-my" />
      </section>
      <section className="space-y-3" data-testid="catalog-care-my-empty">
        <CareMyHome summary={{ assigned: 0, notCared: 0, completed: 0, overdueLive: 0 }} rows={[]} total={0} filter="overdue" page={1}
          pageSize={20} todayISO="2026-10-10" search={fakeSearch} basePath="/ui-catalog/care-my" />
      </section>
      <section className="space-y-3" data-testid="catalog-care-my-detail">
        <CareMyTaskDetail todayISO="2026-10-10" canRecord updateHref="/ui-catalog/care-my#form" loadMore={fakeLoadMore}
          data={DETAIL} />
      </section>
      <section className="space-y-3" data-testid="catalog-care-my-readonly">
        <CareMyTaskDetail todayISO="2026-10-10" canRecord={false} updateHref="#"
          data={READONLY} />
      </section>
      {/* Q-107 (B7-ui r1.1): chế độ QA local — vẫn tel:/sms: với số của task QA, thêm dòng nhận biết số giả. */}
      <section className="space-y-3" data-testid="catalog-care-my-detail-qa">
        <CareMyTaskDetail todayISO="2026-10-10" canRecord updateHref="#" qa
          data={QA_DETAIL} />
      </section>
      <section className="space-y-3" data-testid="catalog-care-my-form" id="form">
        <CareInteractionForm taskId={TASK} customerName="KH QA 00701" todayISO="2026-10-10" dueDate="2026-10-31" record={fakeRecord} doneHref="/ui-catalog/care-my?saved=1" />
      </section>
    </div>
  )
}
