import type { CareReportRow } from '@/lib/care/browse'

// CRM-CSKH B6-qa-ui — số liệu tổng hợp cho CHẾ ĐỘ QA local (THUẦN).
//
// `care_report` và `care_my_summary` (114, DEFINER) luôn loại is_test với Marketing/SM/staff — migration 114
// không đổi ⇒ trong chế độ QA, dashboard/báo cáo/export/thẻ "CSKH của tôi" tính lại từ CHÍNH các task người
// xem đọc được qua RLS (đã lọc batch QA). Đây là đường QA, KHÔNG phải đường production:
//   · phạm vi = RLS care_tasks_select (cùng ba vế với care_report: xem toàn chuỗi / task mình ở đúng store /
//     store trong scope) — e2e/care-qa-ui-lifecycle.spec.ts so khớp với care_report trên PGlite cho từng vai;
//   · `converted_tasks` = 0: QA không đồng bộ đơn N3 (ID giả, cờ sync OFF), attribution không đọc được qua RLS.

export interface CareQaTaskAgg {
  store_id: string
  assignee_id: string
  status: 'open' | 'completed' | 'closed_unfinished'
  last_interaction_at: string | null
  first_overdue_on: string | null
}

/** Mirror `care_report`: nhóm theo (store, dược sĩ), thứ tự như ORDER BY 1, 2 của SQL. */
export function careQaReportRows(tasks: readonly CareQaTaskAgg[]): CareReportRow[] {
  const by = new Map<string, CareReportRow>()
  for (const t of tasks) {
    const k = `${t.store_id}|${t.assignee_id}`
    const r = by.get(k) ?? {
      store_id: t.store_id, assignee_id: t.assignee_id, tasks_total: 0, completed: 0, open_not_cared: 0,
      open_in_progress: 0, overdue_in_period: 0, closed_unfinished: 0, converted_tasks: 0,
    }
    r.tasks_total++
    if (t.status === 'completed') r.completed++
    if (t.status === 'open' && t.last_interaction_at === null) r.open_not_cared++
    if (t.status === 'open' && t.last_interaction_at !== null) r.open_in_progress++
    if (t.first_overdue_on !== null) r.overdue_in_period++
    if (t.status === 'closed_unfinished') r.closed_unfinished++
    by.set(k, r)
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return [...by.values()].sort((a, b) => cmp(a.store_id, b.store_id) || cmp(a.assignee_id, b.assignee_id))
}

export interface CareQaMyAgg {
  status: 'open' | 'completed' | 'closed_unfinished'
  last_interaction_at: string | null
  next_action_date: string | null
}

/** Mirror `care_my_summary` (task của mình, đúng store hiện tại, kỳ hiện tại — đã lọc ở query). */
export function careQaMySummary(tasks: readonly CareQaMyAgg[], todayISO: string) {
  return {
    assigned: tasks.length,
    notCared: tasks.filter((t) => t.status === 'open' && t.last_interaction_at === null).length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    overdueLive: tasks.filter((t) => t.status === 'open' && t.next_action_date !== null && t.next_action_date < todayISO).length,
  }
}
