import 'server-only'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isCareEnabled } from '@/lib/care/flags'
import { maskVnPhone } from '@/lib/affiliate/phone'
import { applyMyTaskFilters, pageMyTasks, type CareMyFilter, type CareMySortKey } from '@/lib/care/my'
import { careSearchTerm, type CareQueryBuilder } from '@/lib/care/browse'
import { fetchExact } from '@/lib/care/import/fetchExact'
import { careQaMySummary, type CareQaMyAgg } from '@/lib/care/qa/mirror'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import { careDataScope, careQaViewerAllowed } from './qaUi'

// CRM-CSKH B4 — đọc dữ liệu màn dược sĩ bằng SESSION (RLS 114). Không service role.
// B6-qa-ui: phạm vi dữ liệu (careDataScope) — production loại is_test; QA local chỉ batch QA.

type LooseBuilder = CareQueryBuilder<LooseBuilder>
function withMyFilters<T>(q: T, me: { userId: string; storeId: string }, period: string, filter: CareMyFilter, todayISO: string): T {
  return applyMyTaskFilters(q as unknown as LooseBuilder, me.userId, me.storeId, period, filter, todayISO, careDataScope()) as unknown as T
}

export type CareStaffAccess =
  | { kind: 'anonymous' }
  | { kind: 'forbidden' }
  | { kind: 'ok'; userId: string; storeId: string }

/** Dược sĩ OS: role 'staff' + store OS. QLCH/SM/admin/FS ⇒ forbidden. Không đụng bảng 114. */
export async function getCareStaffAccess(): Promise<CareStaffAccess> {
  const { user, profile } = await getSessionProfile()
  if (!user || !profile) return { kind: 'anonymous' }
  type EmbeddedStore = { store_type?: string | null; is_active?: boolean | null }
  const embedded = (profile as { stores?: EmbeddedStore | EmbeddedStore[] | null }).stores
  const store = Array.isArray(embedded) ? embedded[0] : embedded
  // Store OS ĐANG HOẠT ĐỘNG (RPC 114 kiểm lại khi ghi lượt — dược sĩ bị tháo store/store ngừng ⇒ không ghi).
  if (profile.role !== 'staff' || !profile.store_id || store?.store_type !== 'os' || store?.is_active === false) return { kind: 'forbidden' }
  // QA local: chỉ tài khoản QA trong marker, request từ loopback (production luôn qua).
  if (!(await careQaViewerAllowed(user.id))) return { kind: 'forbidden' }
  return { kind: 'ok', userId: user.id, storeId: profile.store_id as string }
}

/**
 * Cổng route /care/my*: cờ OFF ⇒ 404 TRƯỚC mọi đọc; chưa đăng nhập ⇒ /login; không phải
 * dược sĩ OS ⇒ 404 (không lộ chức năng). Trạng thái "DB chưa có 114" xử lý ở loader.
 */
export async function requireCareStaff(): Promise<{ userId: string; storeId: string }> {
  if (!isCareEnabled()) notFound()
  const a = await getCareStaffAccess()
  if (a.kind === 'anonymous') redirect('/login')
  if (a.kind === 'forbidden') notFound()
  return { userId: a.userId, storeId: a.storeId }
}

export class CareNotReadyError extends Error { constructor() { super('care_not_ready') } }

export interface CareMySummary { assigned: number; notCared: number; completed: number; overdueLive: number }

/**
 * care_my_summary() (114): đếm task kỳ hiện tại của mình, loại is_test. Lỗi ⇒ CareNotReadyError.
 * QA local: RPC luôn loại is_test ⇒ đếm lại từ task của mình qua RLS + batch QA (lib/care/qa/mirror.ts).
 */
export async function loadMySummary(me?: { userId: string; storeId: string }): Promise<CareMySummary> {
  const supabase = await createClient()
  if (careDataScope().kind === 'qa') {
    if (!me) throw new CareNotReadyError()
    const now = new Date()
    try {
      const rows = await fetchExact<CareQaMyAgg>((from, to) =>
        withMyFilters(supabase.from('care_tasks').select('status, last_interaction_at, next_action_date', { count: 'exact' }),
          me, carePeriodOf(now), 'all', vnDateISO(now)).order('id').range(from, to))
      return careQaMySummary(rows, vnDateISO(now))
    } catch {
      throw new CareNotReadyError()
    }
  }
  const { data, error } = await supabase.rpc('care_my_summary')
  if (error) throw new CareNotReadyError()
  const r = (Array.isArray(data) ? data[0] : data) as { assigned?: number; not_cared?: number; completed?: number; overdue_live?: number } | null
  return { assigned: r?.assigned ?? 0, notCared: r?.not_cared ?? 0, completed: r?.completed ?? 0, overdueLive: r?.overdue_live ?? 0 }
}

export interface CareMyTaskRow {
  id: string
  customer_name: string
  phone_masked: string
  status: 'open' | 'completed' | 'closed_unfinished'
  last_outcome: string | null
  last_interaction_at: string | null
  next_action_date: string | null
  due_date: string
}

/**
 * Một trang danh sách của dược sĩ (không tải sản phẩm/ảnh/timeline). Tìm kiếm qua POST.
 * Q-84: thứ tự theo khoảng cách ngày hẹn tới hôm nay — PostgREST không order được theo biểu
 * thức ⇒ (1) đọc khoá sort của TOÀN TẬP đã lọc/tìm (session/RLS, vài chục task/tháng),
 * (2) sort bằng compareMyTasks, (3) đọc cột hiển thị của đúng trang theo id, giữ thứ tự.
 */
export async function loadMyTaskPage(me: { userId: string; storeId: string }, period: string, filter: CareMyFilter, page: number, todayISO: string, q?: string):
  Promise<{ rows: CareMyTaskRow[]; total: number }> {
  const supabase = await createClient()
  let term: ReturnType<typeof careSearchTerm> = null
  if (q !== undefined) {
    term = careSearchTerm(q)
    if (!term) return { rows: [], total: 0 }
  }
  let keys: CareMySortKey[]
  try {
    keys = await fetchExact<CareMySortKey>((from, to) => {
      let query = withMyFilters(supabase.from('care_tasks').select('id, status, next_action_date', { count: 'exact' }), me, period, filter, todayISO)
      if (term) {
        query = term.phone
          ? query.or(`customer_name.ilike.*${term.name}*,phone_norm.like.*${term.phone}*`)
          : query.ilike('customer_name', `%${term.name}%`)
      }
      return query.order('id').range(from, to)
    })
  } catch {
    throw new CareNotReadyError()
  }
  const { pageIds, total } = pageMyTasks(keys, page, todayISO)
  if (pageIds.length === 0) return { rows: [], total }
  const { data, error } = await withMyFilters(
    supabase.from('care_tasks').select('id, customer_name, phone_norm, status, last_outcome, last_interaction_at, next_action_date, due_date'),
    me, period, 'all', todayISO).in('id', pageIds)
  if (error) throw new CareNotReadyError()
  const byId = new Map(((data ?? []) as (Omit<CareMyTaskRow, 'phone_masked'> & { phone_norm: string })[]).map((r) => [r.id, r]))
  const rows = pageIds.flatMap((id) => {
    const r = byId.get(id)
    if (!r) return []                                 // vừa bị chuyển giao giữa hai lần đọc ⇒ bỏ dòng
    const { phone_norm, ...rest } = r
    return [{ ...rest, phone_masked: maskVnPhone(phone_norm) }]
  })
  return { rows, total }
}
