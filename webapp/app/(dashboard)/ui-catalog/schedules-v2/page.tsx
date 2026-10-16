import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { SchedulesListView, type ScheduleListRow } from '@/components/tasks/SchedulesListView'
import {
  ScheduleDetailView, ScheduleDetailErrorView,
  type ScheduleDetailViewProps, type ScheduleRecentTask, type ScheduleRun,
} from '@/components/tasks/ScheduleDetailView'

// Dev-only fixture UI v2 P1.5 — render ĐÚNG component trình bày của /tasks/schedules và
// /tasks/schedules/[id] (SchedulesListView / ScheduleDetailView) với dữ liệu giả cố định, mỗi trạng thái
// một URL `?fx=` (trang thật chỉ hiện một trạng thái). 100% fixture (không truy vấn DB). Cổng như
// /ui-catalog: UI_CATALOG=1 (Coolify không đặt ⇒ prod 404) + super admin. KHÔNG bấm nút thao tác ở đây:
// ScheduleActions/ShareScheduleDialog gọi server action thật (id giả ⇒ lỗi, nhưng vẫn là lời gọi ghi).

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const LONG_TITLE = 'Lịch QA tên rất dài — báo cáo hình ảnh trưng bày quầy OTC, kệ đầu dãy Vitamin và tentcard thu ngân toàn hệ thống'

const ROWS: ScheduleListRow[] = [
  { id: U(1), title: 'Lịch QA 01 — kiểm tra nhiệt độ tủ mát', frequency: 'daily', run_time: '07:30', next_run_at: '2026-01-16T00:30:00.000Z', last_run_at: '2026-01-15T00:30:00.000Z', is_active: true, assignment_mode: 'store', storeCount: 25 },
  { id: U(2), title: 'Lịch QA 02 — báo cáo trưng bày tuần', frequency: 'weekly', run_time: '08:00', next_run_at: '2026-01-19T01:00:00.000Z', last_run_at: '2026-01-12T01:00:00.000Z', is_active: true, assignment_mode: 'store', storeCount: 25 },
  { id: U(3), title: 'Lịch QA 03 — bài kiểm tra kiến thức tháng', frequency: 'monthly', run_time: '09:00', next_run_at: '2026-02-05T02:00:00.000Z', last_run_at: '2026-01-05T02:00:00.000Z', is_active: true, assignment_mode: 'staff_all', storeCount: 25 },
  { id: U(4), title: 'Lịch QA 04 — kiểm kê hàng cận date', frequency: 'monthly', run_time: '08:00', next_run_at: null, last_run_at: null, is_active: false, assignment_mode: 'store', storeCount: 12 },
  { id: U(5), title: LONG_TITLE, frequency: 'weekly', run_time: '18:00', next_run_at: '2026-01-17T11:00:00.000Z', last_run_at: null, is_active: true, assignment_mode: 'store', storeCount: 8 },
  { id: U(6), title: 'Lịch QA 06 — nhắc vệ sinh quầy', frequency: 'daily', run_time: '17:00', next_run_at: '2026-01-16T10:00:00.000Z', last_run_at: '2026-01-14T10:00:00.000Z', is_active: false, assignment_mode: 'staff_all', storeCount: 3 },
]

const STORES = Array.from({ length: 25 }, (_, i) => ({ store_id: U(100 + i), name: `POS_TEST Cửa hàng ${String(i + 1).padStart(2, '0')}` }))
const LONG_ERROR = 'Lỗi QA giả lập: hết thời gian chờ khi tạo task cho 3 cửa hàng (POS_TEST Cửa hàng 07, POS_TEST Cửa hàng 12, POS_TEST Cửa hàng 19) — đã ghi nhận và sẽ thử lại ở lần chạy kế tiếp theo lịch.'
const RUNS: ScheduleRun[] = [
  { id: U(201), scheduled_for: '2026-01-12', status: 'success', created_count: 25, error_message: null },
  { id: U(202), scheduled_for: '2026-01-05', status: 'failed', created_count: 0, error_message: LONG_ERROR },
  { id: U(203), scheduled_for: '2025-12-29', status: 'running', created_count: 12, error_message: null },
  { id: U(204), scheduled_for: '2025-12-22', status: 'skipped', created_count: 0, error_message: 'Ngoài khoảng ngày bắt đầu/kết thúc' },
  { id: U(205), scheduled_for: '2025-12-15', status: 'success', created_count: 24, error_message: null },
]
const task = (n: number, day: string, store: number, status: string, late = false): ScheduleRecentTask => ({
  id: U(300 + n), status, scheduled_for: day, deadline: `${day}T10:00:00.000Z`,
  overdue_at: late ? `${day}T11:00:00.000Z` : null, stores: { name: STORES[store].name },
})
const RECENT: ScheduleRecentTask[] = [
  task(1, '2026-01-12', 0, 'done'), task(2, '2026-01-12', 1, 'in_progress'), task(3, '2026-01-12', 2, 'done', true),
  task(4, '2026-01-12', 3, 'overdue'), task(5, '2026-01-12', 4, 'todo'),
  task(6, '2026-01-05', 0, 'done'), task(7, '2026-01-05', 1, 'done'), task(8, '2026-01-05', 2, 'done'),
]

const BASE: ScheduleDetailViewProps = {
  scheduleId: U(2),
  data: {
    title: LONG_TITLE, is_active: true, frequency: 'weekly', assignment_mode: 'store',
    weekdays: [5, 1, 3], month_day: null, run_time: '08:00', deadline_offset_hours: 48,
    timezone: 'Asia/Ho_Chi_Minh', start_date: '2025-09-01', end_date: null,
    last_run_at: '2026-01-12T01:00:00.000Z', next_run_at: '2026-01-19T01:00:00.000Z',
    config: {
      category: 'display', priority: 'urgent', visibility: 'store', required_outputs: ['image', 'text'],
      description: '<p>Chụp ảnh khu trưng bày theo planogram tuần:</p><ul><li>Quầy OTC chính diện</li><li>Kệ đầu dãy Vitamin</li><li>Tentcard tại quầy thu ngân</li></ul>',
      input_data: {
        attachments: [{ name: 'Planogram_QA_giả_lập_tên_tệp_rất_dài_để_kiểm_tra_xuống_dòng.pdf', url: 'https://example.invalid/planogram.pdf' }],
        links: [{ label: 'Hướng dẫn chụp ảnh trưng bày (QA)', url: 'https://example.invalid/huong-dan' }],
      },
    },
    stores: STORES,
  },
  runs: RUNS, runsError: null,
  recentTasks: RECENT, recentTasksError: null,
  isOwner: true, isEditorCollaborator: false,
  collaborators: [{ admin_id: U(401), permission: 'editor', users: { full_name: 'Admin QA B' } }],
  adminOptions: [{ value: U(402), label: 'Admin QA C', description: 'admin-c@example.invalid' }],
  myCollabError: false, shareDataError: false,
}

const DETAIL: Record<string, ScheduleDetailViewProps> = {
  'detail-owner': BASE,
  // Collaborator editor: Tạm dừng/Kích hoạt, không Chia sẻ/Xóa; lịch tháng, từng dược sĩ, chưa chạy lần nào
  'detail-editor': {
    ...BASE, scheduleId: U(3), isOwner: false, isEditorCollaborator: true,
    data: { ...BASE.data, title: 'Lịch QA 03 — bài kiểm tra kiến thức tháng', frequency: 'monthly', weekdays: [], month_day: 5,
      assignment_mode: 'staff_all', is_active: false, last_run_at: null, stores: STORES.slice(0, 3),
      config: { ...BASE.data.config!, category: 'training', priority: 'normal', required_outputs: ['file'], description: undefined, input_data: undefined } },
    runs: [], recentTasks: [],
  },
  // Collaborator view: không nút thao tác; 2 khối lỗi truy vấn con
  'detail-view': {
    ...BASE, scheduleId: U(1), isOwner: false, isEditorCollaborator: false,
    data: { ...BASE.data, title: 'Lịch QA 01 — kiểm tra nhiệt độ tủ mát', frequency: 'daily', weekdays: [], stores: [] },
    runs: null, runsError: { message: 'QA: lỗi giả lập khi đọc task_generation_runs' },
    recentTasks: null, recentTasksError: { message: 'QA: lỗi giả lập khi đọc tasks' },
  },
  // Owner nhưng đọc quyền/chia sẻ lỗi ⇒ cảnh báo + ẩn dialog chia sẻ
  'detail-permwarn': { ...BASE, myCollabError: true, shareDataError: true },
}

export default async function UiCatalogSchedulesV2Page({ searchParams }: { searchParams: Promise<{ fx?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()

  const fx = (await searchParams).fx ?? 'list'
  let view: React.ReactNode
  if (fx === 'list') view = <SchedulesListView rows={ROWS} error={null} />
  else if (fx === 'list-empty') view = <SchedulesListView rows={[]} error={null} />
  else if (fx === 'list-error') view = <SchedulesListView rows={null} error={{ message: 'QA: lỗi giả lập khi đọc task_schedules' }} />
  else if (fx === 'detail-error') view = <ScheduleDetailErrorView message="QA: lỗi giả lập khi đọc task_schedules" />
  else if (DETAIL[fx]) view = <ScheduleDetailView {...DETAIL[fx]} />
  else notFound()

  return <div data-testid="ui-catalog-schedules" data-fx={fx}>{view}</div>
}
