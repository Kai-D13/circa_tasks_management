import 'server-only'
import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { isCareEnabled } from '@/lib/care/flags'
import { fetchExact } from '@/lib/care/import/fetchExact'
import { maskVnPhone } from '@/lib/affiliate/phone'
import {
  applyCareTaskFilters, careCurrentProductCount, careReasonKey, careReasonLabel, careTaskReasons, careSearchTerm, carePermissions, careInteractionPage, careOpenLoadByAssignee, CARE_OUTCOME_KEYS, CARE_INTERACTION_PAGE_SIZE,
  CARE_STATUS_FILTERS, type CareInteractionPage, type CareReasonTag, type CareStatusCounts,
  type CareAccess, type CareOutcomeKey, type CareQueryBuilder, type CareFilters, type CarePermissions, type CareReportRow,
} from '@/lib/care/browse'
import { applyCareScope } from '@/lib/care/scope'
import { careQaReportRows, type CareQaTaskAgg } from '@/lib/care/qa/mirror'
import { careDataScope, careQaStaffIds, careQaViewerAllowed } from './qaUi'

// CRM-CSKH B3 — đọc dữ liệu browser bằng SESSION người xem (RLS 114 quyết phạm vi).
// KHÔNG dùng service role: RLS là ranh giới quyền; filter URL chỉ thêm điều kiện.
// B6-qa-ui: phạm vi dữ liệu (careDataScope) — production loại is_test; QA local chỉ batch QA.

// Kiểu builder PostgREST lồng quá sâu cho generic ⇒ ép qua builder tối giản rồi trả lại đúng kiểu gốc.
type LooseBuilder = CareQueryBuilder<LooseBuilder>
function withCareFilters<T>(q: T, f: Parameters<typeof applyCareTaskFilters>[1], todayISO: string): T {
  return applyCareTaskFilters(q as unknown as LooseBuilder, f, todayISO, careDataScope()) as unknown as T
}
function withScope<T>(q: T): T {
  return applyCareScope(q as unknown as LooseBuilder, careDataScope()) as unknown as T
}

const NO_ACCESS: CareAccess = { role: null, is_super: false, can_import: false, can_view_all: false, scope_store_count: 0 }

/**
 * Chế độ QA local: số liệu tổng hợp tính từ task đọc được qua RLS (đã lọc batch QA) — care_report loại
 * is_test với Marketing/SM. Production KHÔNG đi đường này (lib/care/qa/mirror.ts).
 */
export async function loadCareQaReportRows(f: Pick<CareFilters, 'month' | 'storeId'>): Promise<CareReportRow[]> {
  const supabase = await createClient()
  const tasks = await fetchExact<CareQaTaskAgg>((from, to) => {
    let q = withScope(supabase.from('care_tasks').select('store_id, assignee_id, status, last_interaction_at, first_overdue_on', { count: 'exact' })
      .eq('period_month', f.month))
    if (f.storeId) q = q.eq('store_id', f.storeId)
    return q.order('id').range(from, to)
  })
  return careQaReportRows(tasks)
}

export type CareViewAccess =
  | { kind: 'anonymous' }
  | { kind: 'unavailable' }
  | { kind: 'ok'; userId: string; access: CareAccess; perms: CarePermissions }

/** care_my_access() theo session, memo trong một request (layout + page dùng chung). */
export const getCareViewAccess = cache(async (): Promise<CareViewAccess> => {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { kind: 'anonymous' }
  // QA local: chỉ tài khoản QA trong marker, request từ loopback (production luôn qua).
  if (!(await careQaViewerAllowed(user.id))) return { kind: 'ok', userId: user.id, access: NO_ACCESS, perms: carePermissions(NO_ACCESS) }
  const { data, error } = await supabase.rpc('care_my_access')
  if (error || !data || typeof data !== 'object') return { kind: 'unavailable' }
  const a = data as Partial<CareAccess>
  const access: CareAccess = {
    role: typeof a.role === 'string' ? a.role : null,
    is_super: a.is_super === true,
    can_import: a.can_import === true,
    can_view_all: a.can_view_all === true,
    scope_store_count: typeof a.scope_store_count === 'number' ? a.scope_store_count : 0,
  }
  return { kind: 'ok', userId: user.id, access, perms: carePermissions(access) }
})

/** Mục sidebar: chỉ khi cờ ON; lỗi/không quyền ⇒ null (ẩn nhóm, không làm vỡ layout). */
export async function getCareNavPermissions(role: string | null | undefined): Promise<CarePermissions | null> {
  if (!isCareEnabled() || !role || !['admin', 'sm'].includes(role)) return null
  try {
    const v = await getCareViewAccess()
    return v.kind === 'ok' ? v.perms : null
  } catch {
    return null
  }
}

export interface CareStoreOption { id: string; code: string; name: string }
// Không gửi email dược sĩ xuống client (security-reviewer B3 P2) — tên + mã/tên cửa hàng đủ để chọn.
export interface CareStaffOption { id: string; fullName: string; storeId: string; storeCode: string; storeName: string }
/** Đích chuyển giao kèm số task đang mở kỳ hiện tại trong phạm vi người xem (null = không đọc được). */
export interface CareTransferTargetOption extends CareStaffOption { openCount: number | null }

/** Store OS trong phạm vi đọc: toàn chuỗi (canViewAll) hoặc care_scope_store_ids(). */
export async function loadScopeStores(perms: CarePermissions): Promise<CareStoreOption[]> {
  const supabase = await createClient()
  let ids: string[] | null = null
  if (!perms.canViewAll) {
    const { data, error } = await supabase.rpc('care_scope_store_ids')
    if (error) throw new Error('care_scope_failed')
    ids = (data as string[] | null) ?? []
    if (ids.length === 0) return []
  }
  let q = supabase.from('stores').select('id, code, name').eq('store_type', 'os').eq('is_active', true).order('code')
  if (ids) q = q.in('id', ids)
  const { data, error } = await q
  if (error) throw new Error('care_stores_failed')
  return (data ?? []) as CareStoreOption[]
}

export interface CareDashboardData {
  rows: CareReportRow[]
  overdueOpen: number | null
  outcomes: Partial<Record<CareOutcomeKey, number>>
}

/** Dashboard: care_report (DEFINER, scope theo auth.uid) + 2 truy vấn nhẹ qua RLS (không PII). */
export async function loadCareDashboard(f: CareFilters, todayISO: string, isCurrent: boolean): Promise<CareDashboardData> {
  const supabase = await createClient()
  let rows: CareReportRow[]
  if (careDataScope().kind === 'qa') {
    rows = await loadCareQaReportRows(f)
  } else {
    const { data, error } = await supabase.rpc('care_report', {
      p_month: f.month, p_store_ids: f.storeId ? [f.storeId] : null, p_include_test: false,
    })
    if (error) throw new Error('care_report_failed')
    rows = (data ?? []) as CareReportRow[]
  }
  let overdueOpen: number | null = null
  if (isCurrent) {
    const { count, error: e2 } = await withCareFilters(
      supabase.from('care_tasks').select('id', { count: 'exact', head: true }),
      { ...f, assigneeId: null, status: 'overdue_open' }, todayISO)
    if (e2 || count === null) throw new Error('care_overdue_failed')
    overdueOpen = count
  }
  // Phân bố theo task: ĐẾM head:true từng khoá ở DB (7 truy vấn nhỏ, không tải dòng — SPEC B3 §2).
  const outcomes = Object.fromEntries(await Promise.all(CARE_OUTCOME_KEYS.map(async (k) => {
    const base = withCareFilters(supabase.from('care_tasks').select('id', { count: 'exact', head: true }), { ...f, assigneeId: null, status: null }, todayISO)
    const { count, error: e3 } = await (k === 'none' ? base.is('last_outcome', null) : base.eq('last_outcome', k))
    if (e3 || count === null) throw new Error('care_outcomes_failed')
    return [k, count] as const
  }))) as Partial<Record<CareOutcomeKey, number>>
  return { rows, overdueOpen, outcomes }
}

export interface CareTaskBase {
  id: string
  customer_name: string
  period_month: string
  due_date: string
  status: 'open' | 'completed' | 'closed_unfinished'
  last_outcome: string | null
  last_interaction_at: string | null
  next_action_date: string | null
  store_id: string
  assignee_id: string
  store: { code: string; name: string } | null
  assignee: { full_name: string } | null
}
/**
 * Hàng danh sách: SĐT đã che Ở SERVER — số đầy đủ chỉ ở trang/drawer chi tiết (Q-115).
 * B8.1: `product_count` = số sản phẩm HIỆN HÀNH (is_current) — chỉ đếm, không tải tên/ảnh.
 * PM 22/11: `reasons` = nhãn lý do của sản phẩm hiện hành (mỗi khoá một nhãn).
 */
export type CareTaskRow = CareTaskBase & { phone_masked: string; product_count: number; reasons: CareReasonTag[] }

export const CARE_TASK_PAGE_SIZE = 30

const TASK_COLUMNS = 'id, customer_name, period_month, due_date, status, last_outcome, last_interaction_at, next_action_date, store_id, assignee_id, store:stores!care_tasks_store_id_fkey(code, name), assignee:users!care_tasks_assignee_id_fkey(full_name)'
/**
 * B8.1: embed CHỈ cờ is_current của dòng sản phẩm (không tên/ảnh) để đếm sản phẩm HIỆN HÀNH trong
 * cùng request — đếm ở app (careCurrentProductCount) thay vì lọc embed, không phụ thuộc ngữ nghĩa
 * filter embed của PostgREST; dòng revision cũ (is_current=false) không được tính.
 */
const TASK_PRODUCT_FLAGS = 'care_task_products!care_task_products_task_id_fkey(is_current, reason_type)'
const TASK_LIST_SELECT = `${TASK_COLUMNS}, phone_norm, ${TASK_PRODUCT_FLAGS}`
/**
 * PM 22/11 — lọc theo lý do TRƯỚC phân trang qua RPC 133 `care_tasks_by_reason` (SETOF care_tasks, STABLE): hàm trả đúng các
 * task TRONG PHẠM VI người gọi (cùng điều kiện với policy care_tasks_select) có ≥ 1 sản phẩm hiện hành thuộc lý do; mỗi task
 * một dòng ⇒ count exact đúng, các bộ lọc kỳ / cửa hàng / dược sĩ / trạng thái / tìm kiếm áp tiếp trên kết quả như trên bảng.
 * KHÔNG lọc bằng embed `care_task_products!inner`: RLS của bảng sản phẩm chạy theo TỪNG DÒNG với SM (đo prod 22/11: ~18–20 s
 * cho một lần đếm của SM 10 cửa hàng, so với ~35 ms khi phạm vi tính một lần).
 */
function reasonArgs(f: Pick<CareFilters, 'month' | 'reason'>): { p_period: string; p_reason: string; p_is_test: boolean } | null {
  const key = careReasonKey(f.reason)
  return key ? { p_period: f.month, p_reason: key, p_is_test: careDataScope().kind === 'qa' } : null
}

type TaskListRaw = CareTaskBase & { phone_norm: string; care_task_products: { is_current: boolean; reason_type: string | null }[] | null }
const toTaskRow = ({ phone_norm, care_task_products, ...r }: TaskListRaw): CareTaskRow =>
  ({ ...r, phone_masked: maskVnPhone(phone_norm), product_count: careCurrentProductCount(care_task_products), reasons: careTaskReasons(care_task_products) })

/** Một trang danh sách task (server pagination, thứ tự ổn định created_at ↓, id ↓). */
export async function loadCareTaskPage(f: CareFilters, todayISO: string, q?: string): Promise<{ rows: CareTaskRow[]; total: number }> {
  const supabase = await createClient()
  const term = q ? careSearchTerm(q) : null
  if (q && !term) return { rows: [], total: 0 }
  const from = (f.page - 1) * CARE_TASK_PAGE_SIZE
  const args = reasonArgs(f)
  if (args) {
    // Bước 1: id của ĐÚNG trang + tổng, lọc / tìm / sắp trên kết quả RPC. Bước 2: đọc cột hiển thị của các id đó (≤ 30) qua bảng + RLS.
    // select PHẢI chứa mọi cột dùng để sắp xếp: PostgREST prod trả 42703 "column care_tasks.created_at does not exist" khi RPC SETOF
    // chỉ select=id mà order=created_at (smoke prod 23/11 sau 133; lọc theo cột ngoài select thì vẫn chạy).
    let ids = withCareFilters(supabase.rpc('care_tasks_by_reason', args, { count: 'exact' }).select('id, created_at'), f, todayISO)
    if (term) ids = term.phone ? ids.or(`customer_name.ilike.*${term.name}*,phone_norm.like.*${term.phone}*`) : ids.ilike('customer_name', `%${term.name}%`)
    const page = await ids.order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, from + CARE_TASK_PAGE_SIZE - 1)
    if (page.error || page.count === null) throw new Error('care_tasks_failed')
    const order = ((page.data ?? []) as { id: string }[]).map((r) => r.id)
    if (order.length === 0) return { rows: [], total: page.count }
    const { data, error } = await supabase.from('care_tasks').select(TASK_LIST_SELECT).in('id', order)
    if (error) throw new Error('care_tasks_failed')
    const byId = new Map(((data ?? []) as unknown as TaskListRaw[]).map((r) => [r.id, r]))
    return { rows: order.flatMap((id) => { const r = byId.get(id); return r ? [toTaskRow(r)] : [] }), total: page.count }
  }
  let query = withCareFilters(supabase.from('care_tasks').select(TASK_LIST_SELECT, { count: 'exact' }), f, todayISO)
  if (term) {
    query = term.phone
      ? query.or(`customer_name.ilike.*${term.name}*,phone_norm.like.*${term.phone}*`)
      : query.ilike('customer_name', `%${term.name}%`)
  }
  const { data, error, count } = await query
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .range(from, from + CARE_TASK_PAGE_SIZE - 1)
  if (error || count === null) throw new Error('care_tasks_failed')
  return { rows: ((data ?? []) as unknown as TaskListRaw[]).map(toTaskRow), total: count }
}

/**
 * B8.1: số đếm cho chip trạng thái — `all` là count RIÊNG (không cộng chip vì overdue_open giao
 * following). Cùng kỳ/store/dược sĩ + lý do (PM 22/11, cùng nguồn RPC care_tasks_by_reason với danh sách) + careDataScope + RLS session; KHÔNG áp từ khoá tìm. Chạy
 * song song, head:true (không tải dòng). Lỗi ⇒ throw (trang ẩn số, không hiện 0 giả).
 */
export async function loadCareStatusCounts(f: CareFilters, todayISO: string): Promise<CareStatusCounts> {
  const supabase = await createClient()
  const keys = [null, ...CARE_STATUS_FILTERS] as const
  const args = reasonArgs(f)
  const counts = await Promise.all(keys.map(async (status) => {
    const base = args
      ? supabase.rpc('care_tasks_by_reason', args, { count: 'exact', head: true })
      : supabase.from('care_tasks').select('id', { count: 'exact', head: true })
    const { count, error } = await withCareFilters(base, { ...f, status }, todayISO)
    if (error || count === null) throw new Error('care_status_counts_failed')
    return [status ?? 'all', count] as const
  }))
  return Object.fromEntries(counts) as CareStatusCounts
}

export interface CareReasonOption { key: string; label: string }
/**
 * PM 22/11 — lựa chọn của bộ lọc "Lý do": khoá phân biệt của sản phẩm hiện hành trong kỳ, trong phạm vi người xem
 * (RPC 133 care_reason_options — phạm vi tính MỘT LẦN trong hàm, cùng điều kiện với policy care_tasks_select). Lỗi / DB chưa có 133 ⇒ null: trang vẫn
 * dùng được, bộ lọc chỉ còn "Tất cả lý do" + lý do đang chọn (không dựng danh sách giả).
 */
export async function loadCareReasonOptions(month: string): Promise<CareReasonOption[] | null> {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.rpc('care_reason_options', { p_period: month, p_is_test: careDataScope().kind === 'qa' })
    if (error || !Array.isArray(data)) return null
    const out = new Map<string, string>()
    for (const r of data as { reason_key?: unknown; reason_label?: unknown }[]) {
      const key = careReasonKey(r.reason_key)
      if (key && !out.has(key)) out.set(key, careReasonLabel(key, typeof r.reason_label === 'string' ? r.reason_label : null))
    }
    return [...out].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label, 'vi'))
  } catch {
    return null
  }
}

type CareReportScopeFilter = Pick<CareFilters, 'month' | 'storeId' | 'assigneeId'>

/**
 * B8.2 (Q-113): KPI "Đã liên hệ" = task có `last_interaction_at`, KỂ CẢ kỳ đã đóng — count head:true qua
 * session/RLS, cùng kỳ/store/dược sĩ + careDataScope (không suy từ completed + in_progress).
 */
export async function loadCareContactedCount(f: CareReportScopeFilter, todayISO: string): Promise<number> {
  const supabase = await createClient()
  const { count, error } = await withCareFilters(supabase.from('care_tasks').select('id', { count: 'exact', head: true }), { ...f, status: null }, todayISO)
    .not('last_interaction_at', 'is', null)
  if (error || count === null) throw new Error('care_contacted_failed')
  return count
}

/**
 * B8.2: số task closed_unfinished ĐÃ TỪNG có lượt theo store × dược sĩ (cột "Đã liên hệ" từng dòng báo cáo).
 * Kỳ đang mở chưa có task đóng ⇒ 0 dòng. Chỉ đọc 2 cột id (không PII), phân trang an toàn.
 */
export async function loadCareClosedTouched(f: CareReportScopeFilter, todayISO: string): Promise<Map<string, number>> {
  const supabase = await createClient()
  const rows = await fetchExact<{ store_id: string; assignee_id: string }>((from, to) =>
    withCareFilters(supabase.from('care_tasks').select('store_id, assignee_id', { count: 'exact' }), { ...f, status: 'closed_unfinished' }, todayISO)
      .not('last_interaction_at', 'is', null).order('id').range(from, to))
  const m = new Map<string, number>()
  for (const r of rows) { const k = `${r.store_id}|${r.assignee_id}`; m.set(k, (m.get(k) ?? 0) + 1) }
  return m
}

/**
 * B8.2 (Q-117): "Kết quả liên hệ" — mỗi task đã có lượt tính MỘT lần theo `last_outcome`; task chưa liên hệ
 * không vào mẫu. 6 count head:true song song (cùng kỳ/store/dược sĩ + scope).
 */
export async function loadCareReportOutcomes(f: CareReportScopeFilter, todayISO: string): Promise<Partial<Record<CareOutcomeKey, number>>> {
  const supabase = await createClient()
  return Object.fromEntries(await Promise.all(CARE_OUTCOME_KEYS.filter((k) => k !== 'none').map(async (k) => {
    const { count, error } = await withCareFilters(supabase.from('care_tasks').select('id', { count: 'exact', head: true }), { ...f, status: null }, todayISO)
      .eq('last_outcome', k)
    if (error || count === null) throw new Error('care_report_outcomes_failed')
    return [k, count] as const
  }))) as Partial<Record<CareOutcomeKey, number>>
}

/**
 * Dòng care_report của kỳ theo phạm vi người xem. QA local: tính từ task batch QA đọc qua RLS
 * (care_report loại is_test với SM/Marketing — PM B8.1 P1-1); production: RPC DEFINER theo auth.uid.
 */
async function loadCareReportRowsScoped(month: string): Promise<CareReportRow[]> {
  if (careDataScope().kind === 'qa') return loadCareQaReportRows({ month, storeId: null })
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('care_report', { p_month: month, p_store_ids: null, p_include_test: false })
  if (error) throw new Error('care_report_failed')
  return (data ?? []) as CareReportRow[]
}

export interface CareTaskDetail {
  task: CareTaskBase & { customer_id: string; phone_norm: string; phone_raw: string; first_overdue_on: string | null; completed_at: string | null; closed_at: string | null }
  products: { id: string; product_id: string; product_name: string; image_url: string | null; reason_type: string; reason_text: string }[]
  /** Trang đầu lịch sử lượt (Q-78: 10 lượt mới nhất); lượt cũ hơn nạp qua loadCareInteractionsPage. */
  interactions: CareInteractionPage
  events: { id: number; kind: 'assigned' | 'transferred'; note: string | null; created_at: string;
    from_user: { full_name: string } | null; to_user: { full_name: string } | null; actor: { full_name: string } | null;
    from_store: { code: string } | null; to_store: { code: string } | null }[]
}

/** Chi tiết theo RLS: không thấy task ⇒ null (404). Lịch sử khách theo helper B1. */
export async function loadCareTaskDetail(id: string): Promise<CareTaskDetail | null> {
  const supabase = await createClient()
  const { data: task, error } = await withScope(supabase.from('care_tasks')
    .select(`${TASK_COLUMNS}, customer_id, phone_norm, phone_raw, first_overdue_on, completed_at, closed_at`)
    .eq('id', id)).maybeSingle()
  if (error) throw new Error('care_task_failed')
  if (!task) return null
  const t = task as unknown as CareTaskDetail['task']
  const [interactions, products, events] = await Promise.all([
    // Lượt của khách mà người xem được đọc (task này + lịch sử khách theo RLS) — trang đầu.
    loadCareInteractionsPage(t.id, null, { id: t.id, customer_id: t.customer_id }),
    supabase.from('care_task_products').select('id, product_id, product_name, image_url, reason_type, reason_text')
      .eq('task_id', id).eq('is_current', true).order('product_id'),
    supabase.from('care_assignment_events')
      .select('id, kind, note, created_at, from_user:users!care_assignment_events_from_user_id_fkey(full_name), to_user:users!care_assignment_events_to_user_id_fkey(full_name), actor:users!care_assignment_events_actor_id_fkey(full_name), from_store:stores!care_assignment_events_from_store_id_fkey(code), to_store:stores!care_assignment_events_to_store_id_fkey(code)')
      .eq('task_id', id).order('created_at', { ascending: false }).order('id', { ascending: false }),
  ])
  if (products.error || events.error || !interactions) throw new Error('care_task_detail_failed')
  return {
    task: t,
    products: (products.data ?? []) as CareTaskDetail['products'],
    interactions,
    events: (events.data ?? []) as unknown as CareTaskDetail['events'],
  }
}

/**
 * Một trang lịch sử lượt chăm sóc của KHÁCH thuộc task (Q-78): 10 lượt, keyset theo id ↓
 * (`beforeId` = id nhỏ nhất đã có). Mỗi lần gọi đọc lại task bằng SESSION — RLS không cho
 * thấy task ⇒ null (không lộ gì); lượt được trả cũng qua RLS care_interactions.
 * `known` chỉ dùng khi chính loadCareTaskDetail vừa đọc task qua RLS trong cùng request.
 */
export async function loadCareInteractionsPage(taskId: string, beforeId: number | null, known?: { id: string; customer_id: string }): Promise<CareInteractionPage | null> {
  const supabase = await createClient()
  let task = known ?? null
  if (!task) {
    const { data, error } = await withScope(supabase.from('care_tasks').select('id, customer_id').eq('id', taskId)).maybeSingle()
    if (error) throw new Error('care_task_failed')
    if (!data) return null
    task = data as { id: string; customer_id: string }
  }
  let q = supabase.from('care_interactions')
    .select('id, outcome, is_terminal, note, next_action_date, created_at, task_id, proof, actor:users!care_interactions_actor_id_fkey(full_name)')
    .eq('customer_id', task.customer_id)
  if (beforeId !== null) q = q.lt('id', beforeId)
  const { data, error } = await q.order('id', { ascending: false }).limit(CARE_INTERACTION_PAGE_SIZE + 1)
  if (error) throw new Error('care_interactions_failed')
  return careInteractionPage(data as unknown as Parameters<typeof careInteractionPage>[0], task.id, Date.now())
}

/** Dược sĩ đích cho chuyển giao: staff của store OS ĐANG HOẠT ĐỘNG trong phạm vi chuyển giao. */
/**
 * B6-qa-ui (security P1-2): ở chế độ QA local, chuyển giao chỉ được cho task thuộc batch QA (đếm qua RLS + phạm
 * vi QA phải đủ số id) và chỉ sang dược sĩ QA trong marker. Production: luôn null (không đọc gì).
 */
export async function careQaTransferBlock(taskIds: string[], toUserId: string): Promise<'TARGET_INVALID' | 'TASK_NOT_FOUND' | null> {
  const scope = careDataScope()
  if (scope.kind !== 'qa') return null
  if (!(careQaStaffIds() ?? []).includes(toUserId)) return 'TARGET_INVALID'
  const supabase = await createClient()
  const { count, error } = await withScope(supabase.from('care_tasks').select('id', { count: 'exact', head: true }).in('id', taskIds))
  return error || count !== taskIds.length ? 'TASK_NOT_FOUND' : null
}

/**
 * Dược sĩ đích + tải hiện tại (B8.1): task đang mở kỳ hiện tại theo care_report trong phạm vi
 * người xem — MỘT lần đọc, không N+1. Lỗi đọc tải ⇒ openCount null (dialog vẫn dùng được).
 */
export async function loadTransferTargets(perms: CarePermissions, currentMonth: string): Promise<CareTransferTargetOption[]> {
  if (!perms.canTransfer) return []
  const [staff, load] = await Promise.all([
    loadTransferStaff(perms),
    loadCareReportRowsScoped(currentMonth).then(careOpenLoadByAssignee).catch(() => null),
  ])
  return staff.map((s) => ({ ...s, openCount: load ? (load.get(s.id) ?? 0) : null }))
}

async function loadTransferStaff(perms: CarePermissions): Promise<CareStaffOption[]> {
  const supabase = await createClient()
  let storeQ = supabase.from('stores').select('id, code, name').eq('store_type', 'os').eq('is_active', true)
  if (!perms.canViewAll) {
    const { data, error } = await supabase.rpc('care_scope_store_ids')
    if (error) throw new Error('care_scope_failed')
    const ids = (data as string[] | null) ?? []
    if (ids.length === 0) return []
    storeQ = storeQ.in('id', ids)
  }
  const { data: stores, error: se } = await storeQ
  if (se) throw new Error('care_stores_failed')
  const byId = new Map((stores ?? []).map((s) => [s.id as string, s as { id: string; code: string; name: string }]))
  if (byId.size === 0) return []
  const staff = await fetchExact<{ id: string; full_name: string; store_id: string }>((from, to) =>
    supabase.from('users').select('id, full_name, store_id', { count: 'exact' })
      .eq('role', 'staff').in('store_id', [...byId.keys()]).order('id').range(from, to))
  // B6-qa-ui: QA local chỉ cho chọn dược sĩ QA trong marker (action cũng chặn).
  const qaStaff = careQaStaffIds()
  return staff
    .filter((u) => qaStaff === null || qaStaff.includes(u.id))
    .map((u) => { const s = byId.get(u.store_id)!; return { id: u.id, fullName: u.full_name, storeId: s.id, storeCode: s.code, storeName: s.name } })
    .sort((a, b) => a.storeCode.localeCompare(b.storeCode) || a.fullName.localeCompare(b.fullName))
}

/** Dược sĩ thuộc các store trong phạm vi đọc — cho bộ lọc (không dùng làm đích chuyển giao). */
export async function loadScopeStaff(stores: CareStoreOption[]): Promise<{ id: string; fullName: string; storeCode: string }[]> {
  if (stores.length === 0) return []
  const supabase = await createClient()
  const byId = new Map(stores.map((s) => [s.id, s]))
  const rows = await fetchExact<{ id: string; full_name: string; store_id: string }>((from, to) =>
    supabase.from('users').select('id, full_name, store_id', { count: 'exact' })
      .eq('role', 'staff').in('store_id', [...byId.keys()]).order('id').range(from, to))
  return rows.map((u) => ({ id: u.id, fullName: u.full_name, storeCode: byId.get(u.store_id)?.code ?? '' }))
    .sort((a, b) => a.storeCode.localeCompare(b.storeCode) || a.fullName.localeCompare(b.fullName))
}
