import 'server-only'
import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { isCareEnabled } from '@/lib/care/flags'
import { fetchExact } from '@/lib/care/import/fetchExact'
import { maskVnPhone } from '@/lib/affiliate/phone'
import {
  applyCareTaskFilters, careSearchTerm, carePermissions, careInteractionPage, CARE_OUTCOME_KEYS, CARE_INTERACTION_PAGE_SIZE,
  type CareInteractionPage,
  type CareAccess, type CareOutcomeKey, type CareQueryBuilder, type CareFilters, type CarePermissions, type CareReportRow,
} from '@/lib/care/browse'

// CRM-CSKH B3 — đọc dữ liệu browser bằng SESSION người xem (RLS 114 quyết phạm vi).
// KHÔNG dùng service role: RLS là ranh giới quyền; filter URL chỉ thêm điều kiện.

// Kiểu builder PostgREST lồng quá sâu cho generic ⇒ ép qua builder tối giản rồi trả lại đúng kiểu gốc.
type LooseBuilder = CareQueryBuilder<LooseBuilder>
function withCareFilters<T>(q: T, f: Parameters<typeof applyCareTaskFilters>[1], todayISO: string): T {
  return applyCareTaskFilters(q as unknown as LooseBuilder, f, todayISO) as unknown as T
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
  const { data: rows, error } = await supabase.rpc('care_report', {
    p_month: f.month, p_store_ids: f.storeId ? [f.storeId] : null, p_include_test: false,
  })
  if (error) throw new Error('care_report_failed')
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
  return { rows: (rows ?? []) as CareReportRow[], overdueOpen, outcomes }
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
/** Hàng danh sách: SĐT đã che Ở SERVER — số đầy đủ chỉ ở trang chi tiết (TODO(Q-30)). */
export type CareTaskRow = CareTaskBase & { phone_masked: string }

export const CARE_TASK_PAGE_SIZE = 30

const TASK_COLUMNS = 'id, customer_name, period_month, due_date, status, last_outcome, last_interaction_at, next_action_date, store_id, assignee_id, store:stores!care_tasks_store_id_fkey(code, name), assignee:users!care_tasks_assignee_id_fkey(full_name)'

/** Một trang danh sách task (server pagination, thứ tự ổn định created_at ↓, id ↓). */
export async function loadCareTaskPage(f: CareFilters, todayISO: string, q?: string): Promise<{ rows: CareTaskRow[]; total: number }> {
  const supabase = await createClient()
  let query = withCareFilters(supabase.from('care_tasks').select(`${TASK_COLUMNS}, phone_norm`, { count: 'exact' }), f, todayISO)
  const term = q ? careSearchTerm(q) : null
  if (q && !term) return { rows: [], total: 0 }
  if (term) {
    query = term.phone
      ? query.or(`customer_name.ilike.*${term.name}*,phone_norm.like.*${term.phone}*`)
      : query.ilike('customer_name', `%${term.name}%`)
  }
  const from = (f.page - 1) * CARE_TASK_PAGE_SIZE
  const { data, error, count } = await query
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .range(from, from + CARE_TASK_PAGE_SIZE - 1)
  if (error || count === null) throw new Error('care_tasks_failed')
  const rows = ((data ?? []) as unknown as (CareTaskBase & { phone_norm: string })[])
    .map(({ phone_norm, ...r }) => ({ ...r, phone_masked: maskVnPhone(phone_norm) }))
  return { rows, total: count }
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
  const { data: task, error } = await supabase.from('care_tasks')
    .select(`${TASK_COLUMNS}, customer_id, phone_norm, phone_raw, first_overdue_on, completed_at, closed_at`)
    .eq('id', id).eq('is_test', false).maybeSingle()
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
    const { data, error } = await supabase.from('care_tasks').select('id, customer_id').eq('id', taskId).eq('is_test', false).maybeSingle()
    if (error) throw new Error('care_task_failed')
    if (!data) return null
    task = data as { id: string; customer_id: string }
  }
  let q = supabase.from('care_interactions')
    .select('id, outcome, note, next_action_date, created_at, task_id, actor:users!care_interactions_actor_id_fkey(full_name)')
    .eq('customer_id', task.customer_id)
  if (beforeId !== null) q = q.lt('id', beforeId)
  const { data, error } = await q.order('id', { ascending: false }).limit(CARE_INTERACTION_PAGE_SIZE + 1)
  if (error) throw new Error('care_interactions_failed')
  return careInteractionPage(data as unknown as Parameters<typeof careInteractionPage>[0], task.id)
}

/** Dược sĩ đích cho chuyển giao: staff của store OS ĐANG HOẠT ĐỘNG trong phạm vi chuyển giao. */
export async function loadTransferTargets(perms: CarePermissions): Promise<CareStaffOption[]> {
  if (!perms.canTransfer) return []
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
  return staff
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
