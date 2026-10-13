import { CARE_OUTCOMES, CARE_OUTCOME_META, type CareOutcome } from './outcome'
import { isCarePeriod, periodLastDay } from './time'
import { isCareProofDisplayUrl, isProofExpired } from './my'
import { applyCareScope, CARE_PRODUCTION_SCOPE, type CareDataScope } from './scope'

// CRM-CSKH B3 — logic THUẦN cho browser Khách hàng/Chăm sóc + chuyển giao (SPEC B3).
// Không import Next/Supabase ⇒ test trực tiếp. Quyền thật vẫn ở RLS/RPC 114; ở đây
// chỉ quyết định UI hiện gì và lọc URL theo hướng THU HẸP.

// ── Quyền ───────────────────────────────────────────────────────────────────
/** Kết quả RPC care_my_access() (migration 114). */
export interface CareAccess {
  role: string | null
  is_super: boolean
  can_import: boolean
  can_view_all: boolean
  scope_store_count: number
}

export interface CarePermissions {
  /** Xem /care, /care/tasks: super, care admin can_view_all, SM có store OS trong scope (QLCH: không — Q-76/77). */
  canView: boolean
  /** Toàn chuỗi (super / can_view_all) — ngược lại là phạm vi store. */
  canViewAll: boolean
  /** Chuyển giao: chỉ SM hoặc super (RPC 114 kiểm lại). */
  canTransfer: boolean
  /** Phân công bằng Excel (B2): can_import — KHÔNG kéo theo canView (SPEC B3 §1). */
  canImport: boolean
}

/** Q-76/77: tài khoản dùng chung QLCH không tham gia CRM GĐ1 — không quyền nào, kể cả khi có care_access. */
export const CARE_EXCLUDED_ROLES: readonly string[] = ['store_manager']

export function carePermissions(a: CareAccess | null): CarePermissions {
  if (!a || (a.role !== null && CARE_EXCLUDED_ROLES.includes(a.role))) {
    return { canView: false, canViewAll: false, canTransfer: false, canImport: false }
  }
  const scoped = a.role === 'sm' && a.scope_store_count > 0
  const canViewAll = a.is_super || a.can_view_all
  return {
    canView: canViewAll || scoped,
    canViewAll,
    canTransfer: a.is_super || (a.role === 'sm' && a.scope_store_count > 0),
    canImport: a.can_import,
  }
}

/** Mục sidebar "Chăm sóc KH" theo quyền — rỗng ⇒ không render nhóm (không nhóm mồ côi). */
export function careNavItems(p: CarePermissions | null): { href: string; label: string }[] {
  if (!p) return []
  return [
    ...(p.canView ? [{ href: '/care', label: 'Khách hàng' }] : []),
    ...(p.canImport ? [{ href: '/care/assign', label: 'Phân công' }] : []),
    ...(p.canView ? [{ href: '/care/tasks', label: 'Chăm sóc' }] : []),
    // B5a: route /care/reports có thật (SPEC B3 §1: chỉ thêm "Báo cáo" khi route tồn tại).
    ...(p.canView ? [{ href: '/care/reports', label: 'Báo cáo' }] : []),
  ]
}

// ── Filter URL (chỉ thu hẹp) ────────────────────────────────────────────────
export const CARE_STATUS_FILTERS = ['not_cared', 'following', 'overdue_open', 'completed', 'closed_unfinished'] as const
export type CareStatusFilter = (typeof CARE_STATUS_FILTERS)[number]

export const CARE_STATUS_LABELS: Record<CareStatusFilter, string> = {
  not_cared: 'Chưa chăm sóc',
  following: 'Đang theo dõi',
  overdue_open: 'Quá hạn đang mở',
  completed: 'Hoàn thành',
  closed_unfinished: 'Không hoàn thành trong kỳ',
}

export interface CareFilters {
  month: string
  storeId: string | null
  assigneeId: string | null
  status: CareStatusFilter | null
  page: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Đọc filter từ URL. Giá trị sai ⇒ bỏ (không lỗi). Tháng hợp lệ là YYYY-MM-01
 * hoặc YYYY-MM, không vượt tháng hiện tại. Store/assignee chỉ là bộ lọc bổ sung
 * trên truy vấn RLS — không bao giờ mở rộng phạm vi.
 */
export function parseCareFilters(sp: Record<string, string | string[] | undefined>, currentPeriod: string): CareFilters {
  const one = (k: string) => { const v = sp[k]; return typeof v === 'string' ? v.trim() : '' }
  let month = one('month')
  if (/^\d{4}-\d{2}$/.test(month)) month = `${month}-01`
  if (!isCarePeriod(month) || month > currentPeriod) month = currentPeriod
  const storeId = UUID_RE.test(one('store')) ? one('store').toLowerCase() : null
  const assigneeId = UUID_RE.test(one('assignee')) ? one('assignee').toLowerCase() : null
  const st = one('status')
  const status = (CARE_STATUS_FILTERS as readonly string[]).includes(st) ? (st as CareStatusFilter) : null
  const page = Math.min(10_000, Math.max(1, Number.parseInt(one('page'), 10) || 1))
  return { month, storeId, assigneeId, status, page }
}

/** B8.1: `?open=<uuid>` của drawer chi tiết /care/tasks — chỉ khoá task (không PII); sai ⇒ null. */
export function parseCareOpenParam(sp: Record<string, string | string[] | undefined>): string | null {
  const v = sp.open
  return typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim().toLowerCase() : null
}

export function careFilterHref(path: string, f: Partial<CareFilters>, over: Partial<CareFilters> = {}): string {
  const m = { ...f, ...over }
  const q = new URLSearchParams()
  if (m.month) q.set('month', m.month.slice(0, 7))
  if (m.storeId) q.set('store', m.storeId)
  if (m.assigneeId) q.set('assignee', m.assigneeId)
  if (m.status) q.set('status', m.status)
  if (m.page && m.page > 1) q.set('page', String(m.page))
  const s = q.toString()
  return s ? `${path}?${s}` : path
}

// ── Chip trạng thái /care/tasks (B8.1) ─────────────────────────────────────
/** Nhãn ngắn trên chip (filter giữ nguyên khoá URL CARE_STATUS_FILTERS). */
export const CARE_STATUS_CHIP_LABELS: Record<CareStatusFilter, string> = {
  not_cared: 'Chưa chăm sóc',
  following: 'Đang theo dõi',
  overdue_open: 'Quá hạn',
  completed: 'Hoàn thành',
  closed_unfinished: 'Không hoàn thành',
}

/**
 * Số đếm cho chip: `all` là count RIÊNG theo kỳ/store/dược sĩ (không cộng các chip vì
 * `overdue_open` giao với `following`). Không áp từ khoá tìm (tìm đi qua POST).
 */
export type CareStatusCounts = { all: number } & Record<CareStatusFilter, number>

export function careStatusChipTabs(path: string, f: CareFilters, counts: CareStatusCounts | null): { key: string; label: string; count?: number; href: string }[] {
  const base = { month: f.month, storeId: f.storeId, assigneeId: f.assigneeId }
  return [
    { key: 'all', label: 'Tất cả', count: counts?.all, href: careFilterHref(path, base) },
    ...CARE_STATUS_FILTERS.map((s) => ({ key: s, label: CARE_STATUS_CHIP_LABELS[s], count: counts?.[s], href: careFilterHref(path, { ...base, status: s }) })),
  ]
}

// ── Ô hiển thị 2 dòng /care/tasks (B8.1) ───────────────────────────────────
/** Số sản phẩm HIỆN HÀNH của task từ embed cờ is_current (dòng revision cũ không tính). */
export function careCurrentProductCount(products: { is_current: boolean }[] | null | undefined): number {
  return (products ?? []).filter((p) => p.is_current === true).length
}

const VN_SHORT = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hour12: false })
/** "10:55 13/10" theo giờ VN (thời điểm lượt gần nhất). */
export function careShortDateTime(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const p = Object.fromEntries(VN_SHORT.formatToParts(d).map((x) => [x.type, x.value]))
  return `${p.hour}:${p.minute} ${p.day}/${p.month}`
}

const dayNumber = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000
/**
 * Hẹn chăm sóc lại: ngày đầy đủ + gợi ý so với hôm nay (ngày VN). Chỉ task đang mở mới có
 * gợi ý/quá hạn (task đã kết thúc giữ ngày nếu còn, không tô quá hạn).
 */
export function careApptHint(nextISO: string | null, todayISO: string, open: boolean): { date: string; hint: string | null; overdue: boolean } | null {
  if (!nextISO || !/^\d{4}-\d{2}-\d{2}/.test(nextISO)) return null
  const date = `${nextISO.slice(8, 10)}/${nextISO.slice(5, 7)}/${nextISO.slice(0, 4)}`
  if (!open) return { date, hint: null, overdue: false }
  const diff = dayNumber(nextISO) - dayNumber(todayISO)
  if (diff === 0) return { date, hint: 'hôm nay', overdue: false }
  return diff > 0 ? { date, hint: `còn ${diff} ngày`, overdue: false } : { date, hint: `quá ${-diff} ngày`, overdue: true }
}

// ── Trạng thái hiển thị ─────────────────────────────────────────────────────
export interface CareTaskStateInput {
  status: 'open' | 'completed' | 'closed_unfinished'
  last_interaction_at: string | null
  next_action_date: string | null
}

export interface CareTaskState {
  key: 'not_cared' | 'following' | 'completed' | 'closed_unfinished'
  /** Quá hạn ĐANG MỞ: open + có hẹn + ngày hẹn < hôm nay VN. Có thể giao với 'following'. */
  overdueOpen: boolean
}

export function careTaskState(t: CareTaskStateInput, todayISO: string): CareTaskState {
  if (t.status === 'completed') return { key: 'completed', overdueOpen: false }
  if (t.status === 'closed_unfinished') return { key: 'closed_unfinished', overdueOpen: false }
  return {
    key: t.last_interaction_at ? 'following' : 'not_cared',
    overdueOpen: t.next_action_date !== null && t.next_action_date < todayISO,
  }
}

/**
 * Áp filter lên query PostgREST (builder trừu tượng ⇒ test bằng builder giả).
 * Luôn: đúng kỳ + phạm vi dữ liệu (production: loại is_test · QA local: chỉ batch QA — lib/care/scope.ts).
 * Store/dược sĩ/trạng thái chỉ THÊM điều kiện.
 */
export interface CareQueryBuilder<Q> {
  eq(col: string, v: unknown): Q
  is(col: string, v: null): Q
  not(col: string, op: string, v: unknown): Q
  lt(col: string, v: string): Q
}
export function applyCareTaskFilters<Q extends CareQueryBuilder<Q>>(q: Q, f: Pick<CareFilters, 'month' | 'storeId' | 'assigneeId' | 'status'>, todayISO: string, scope: CareDataScope = CARE_PRODUCTION_SCOPE): Q {
  let r = applyCareScope(q.eq('period_month', f.month), scope)
  if (f.storeId) r = r.eq('store_id', f.storeId)
  if (f.assigneeId) r = r.eq('assignee_id', f.assigneeId)
  switch (f.status) {
    case 'not_cared': r = r.eq('status', 'open').is('last_interaction_at', null); break
    case 'following': r = r.eq('status', 'open').not('last_interaction_at', 'is', null); break
    case 'overdue_open': r = r.eq('status', 'open').lt('next_action_date', todayISO); break
    case 'completed': r = r.eq('status', 'completed'); break
    case 'closed_unfinished': r = r.eq('status', 'closed_unfinished'); break
  }
  return r
}

/**
 * Tìm theo tên hoặc SĐT snapshot: bỏ ký tự cú pháp PostgREST (, ( ) * % \ : " ') và
 * wildcard LIKE `_` — tránh chèn filter/khớp mọi dòng. Cắt độ dài TRƯỚC khi xử lý.
 */
export function careSearchTerm(raw: string): { name: string; phone: string | null } | null {
  const name = String(raw ?? '').slice(0, 200).replace(/[,()*%\\:"'_]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  if (name.length < 2) return null
  const digits = name.replace(/\D/g, '')
  return { name, phone: digits.length >= 3 ? digits : null }
}

// ── Số liệu dashboard (từ care_report) ──────────────────────────────────────
export interface CareReportRow {
  store_id: string
  assignee_id: string
  tasks_total: number
  completed: number
  open_not_cared: number
  open_in_progress: number
  overdue_in_period: number
  closed_unfinished: number
  /** Số task Có đơn (DISTINCT task) — GĐ1 không số đơn/tiền (Q-91). */
  converted_tasks: number
}

export interface CareTotals {
  tasks: number
  completed: number
  notCared: number
  inProgress: number
  /** Từng trễ hẹn trong kỳ (first_overdue_on) — KHÁC quá hạn đang mở. */
  overdueInPeriod: number
  closedUnfinished: number
}

const sumRows = (rows: CareReportRow[]): CareTotals => rows.reduce<CareTotals>((t, r) => ({
  tasks: t.tasks + r.tasks_total,
  completed: t.completed + r.completed,
  notCared: t.notCared + r.open_not_cared,
  inProgress: t.inProgress + r.open_in_progress,
  overdueInPeriod: t.overdueInPeriod + r.overdue_in_period,
  closedUnfinished: t.closedUnfinished + r.closed_unfinished,
}), { tasks: 0, completed: 0, notCared: 0, inProgress: 0, overdueInPeriod: 0, closedUnfinished: 0 })

/** Cộng MỘT lần mỗi dòng RPC (dòng = store × dược sĩ) — không đếm dòng sản phẩm. */
export function careReportTotals(rows: CareReportRow[]): CareTotals {
  return sumRows(rows)
}

export function careReportByStore(rows: CareReportRow[]): { storeId: string; totals: CareTotals }[] {
  const by = new Map<string, CareReportRow[]>()
  for (const r of rows) by.set(r.store_id, [...(by.get(r.store_id) ?? []), r])
  return [...by.entries()].map(([storeId, list]) => ({ storeId, totals: sumRows(list) }))
}

export type CareOutcomeKey = CareOutcome | 'none'
/** Khoá đếm phân bố: 6 outcome + 'none' (task chưa có lượt, last_outcome IS NULL). */
export const CARE_OUTCOME_KEYS: readonly CareOutcomeKey[] = [...CARE_OUTCOMES, 'none']

/**
 * Phân bố kết quả theo task từ SỐ ĐẾM (server đếm head:true theo từng khoá —
 * SPEC B3 §2: aggregate ở server, không tải toàn bộ dòng chỉ để vẽ).
 */
export function careOutcomeDistribution(counts: Partial<Record<CareOutcomeKey, number>>): { key: CareOutcomeKey; label: string; count: number }[] {
  return CARE_OUTCOME_KEYS.map((k) => ({
    key: k, label: k === 'none' ? 'Chưa cập nhật' : CARE_OUTCOME_META[k].label, count: counts[k] ?? 0,
  }))
}

/** Ảnh sản phẩm chỉ từ CDN đã chốt (CHECK 114) — chốt thứ hai phía app trước khi render <img>. */
export const CARE_PRODUCT_IMAGE_PREFIX = 'https://cdn-gcs.thuocsi.vn/'
export function careSafeImageUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.startsWith(CARE_PRODUCT_IMAGE_PREFIX) || /[\s"'<>\\]/.test(url)) return null
  try { return new URL(url).origin === 'https://cdn-gcs.thuocsi.vn' ? url : null } catch { return null }
}

/** Kỳ đang xem đã khép (tháng trước tháng hiện tại)? */
export const isPastPeriod = (month: string, currentPeriod: string) => month < currentPeriod
export const periodDue = (month: string) => periodLastDay(month)

// ── Chuyển giao ─────────────────────────────────────────────────────────────
export const CARE_TRANSFER_NOTE_MAX = 500
export const CARE_TRANSFER_MAX_TASKS = 500

export type CareTransferErrorCode =
  | 'FORBIDDEN' | 'NOTE_REQUIRED' | 'BATCH_SIZE' | 'TARGET_INVALID' | 'TARGET_OUT_OF_SCOPE' | 'SOURCE_OUT_OF_SCOPE'
  | 'TASK_NOT_FOUND' | 'TASK_NOT_OPEN' | 'SAME_OWNER' | 'REFUSED_AT_TARGET' | 'UNAUTHENTICATED' | 'TRANSFER_FAILED'

export const CARE_TRANSFER_MESSAGES: Record<CareTransferErrorCode, string> = {
  FORBIDDEN: 'Chỉ SM hoặc super admin được chuyển giao.',
  NOTE_REQUIRED: 'Ghi chú chuyển giao bắt buộc (1–500 ký tự).',
  BATCH_SIZE: 'Chọn từ 1 đến 500 task.',
  TARGET_INVALID: 'Dược sĩ đích phải là staff của cửa hàng OS đang hoạt động.',
  TARGET_OUT_OF_SCOPE: 'Cửa hàng của dược sĩ đích ngoài phạm vi bạn quản lý.',
  SOURCE_OUT_OF_SCOPE: 'Có task thuộc cửa hàng ngoài phạm vi bạn quản lý.',
  TASK_NOT_FOUND: 'Có task không còn tồn tại — tải lại danh sách.',
  TASK_NOT_OPEN: 'Chỉ chuyển được task đang mở của kỳ hiện tại — có task vừa hoàn thành/đóng kỳ, tải lại danh sách.',
  SAME_OWNER: 'Có task đã thuộc dược sĩ đích.',
  REFUSED_AT_TARGET: 'Có khách đã từ chối chăm sóc tại cửa hàng đích — chọn cửa hàng khác.',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết — đăng nhập lại.',
  TRANSFER_FAILED: 'Chuyển giao không thành công — không task nào bị đổi. Thử lại.',
}

/**
 * Map thông điệp RAISE của care__transfer_tasks_at (114) → mã an toàn. Không trả
 * message gốc ra client (có thể lộ dữ liệu). Lệnh là nguyên tử: mọi lỗi ⇒ không đổi gì.
 */
export function mapCareTransferError(message: string | null | undefined): CareTransferErrorCode {
  const m = message ?? ''
  if (/chưa đăng nhập/.test(m)) return 'UNAUTHENTICATED'
  if (/chỉ SM hoặc super/.test(m)) return 'FORBIDDEN'
  if (/ghi chú chuyển giao/.test(m)) return 'NOTE_REQUIRED'
  if (/cần 1–500 task/.test(m)) return 'BATCH_SIZE'
  if (/dược sĩ đích phải là staff/.test(m)) return 'TARGET_INVALID'
  if (/không quản lý cửa hàng đích/.test(m)) return 'TARGET_OUT_OF_SCOPE'
  if (/không quản lý cửa hàng nguồn/.test(m)) return 'SOURCE_OUT_OF_SCOPE'
  if (/có task không tồn tại/.test(m)) return 'TASK_NOT_FOUND'
  if (/chỉ chuyển task đang mở/.test(m)) return 'TASK_NOT_OPEN'
  if (/đã thuộc dược sĩ đích/.test(m)) return 'SAME_OWNER'
  if (/từ chối chăm sóc tại cửa hàng đích/.test(m)) return 'REFUSED_AT_TARGET'
  return 'TRANSFER_FAILED'
}

/**
 * B8.1 (PM P1-2): dược sĩ đích bị khoá nếu đang giữ BẤT KỲ task nào trong lô chọn — RPC 114
 * (`assignee_id = p_to_user` trên cả mảng) từ chối nguyên lô. Trả số task xung đột theo dược sĩ.
 */
export function careTransferConflicts(tasks: { assigneeId: string }[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of tasks) m.set(t.assigneeId, (m.get(t.assigneeId) ?? 0) + 1)
  return m
}

/**
 * B8.1 (PM P1-1): tải hiện tại của dược sĩ = task ĐANG MỞ kỳ hiện tại (open_not_cared +
 * open_in_progress) cộng theo assignee qua các dòng store × dược sĩ của care_report — không
 * dùng tasks_total. Phạm vi = phạm vi người xem (SM: các store trong vùng).
 */
export function careOpenLoadByAssignee(rows: CareReportRow[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) m.set(r.assignee_id, (m.get(r.assignee_id) ?? 0) + r.open_not_cared + r.open_in_progress)
  return m
}

/** Kiểm đầu vào phía app (RPC kiểm lại). */
export function validateTransferInput(input: { taskIds: unknown; toUserId: unknown; note: unknown }):
  { ok: true; taskIds: string[]; toUserId: string; note: string } | { ok: false; code: CareTransferErrorCode } {
  const ids = Array.isArray(input.taskIds) ? [...new Set(input.taskIds.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x)))] : []
  if (ids.length === 0 || ids.length > CARE_TRANSFER_MAX_TASKS || !Array.isArray(input.taskIds) || ids.length !== new Set(input.taskIds).size) {
    return { ok: false, code: 'BATCH_SIZE' }
  }
  if (typeof input.toUserId !== 'string' || !UUID_RE.test(input.toUserId)) return { ok: false, code: 'TARGET_INVALID' }
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (note.length < 1 || note.length > CARE_TRANSFER_NOTE_MAX) return { ok: false, code: 'NOTE_REQUIRED' }
  return { ok: true, taskIds: ids, toUserId: input.toUserId, note }
}

// ── Lịch sử lượt chăm sóc (Q-78) ────────────────────────────────────────────
/** Mỗi lần tải 10 lượt mới nhất; "Xem thêm" nạp tiếp. DB giữ đủ lịch sử (không trần nghiệp vụ). */
export const CARE_INTERACTION_PAGE_SIZE = 10

export interface CareInteractionRow {
  id: number; outcome: string; note: string; next_action_date: string | null; created_at: string
  actor: { full_name: string } | null
  /** Lượt của chính task đang xem (ngược lại: kỳ trước / dược sĩ trước). */
  isThisTask: boolean
  /** Ảnh minh chứng (B4) — UI chỉ hiển thị URL đúng kho care-proof. */
  proof?: { url: string }[] | null
  /**
   * Q-85: lượt CÓ ảnh minh chứng hợp lệ nhưng đã quá 90 ngày (GCS lifecycle xoá) — tính ở server;
   * khi true, `proof` bị bỏ (URL không còn đi qua app), UI chỉ báo hết thời hạn lưu.
   */
  proofExpired: boolean
}
export interface CareInteractionPage { rows: CareInteractionRow[]; hasMore: boolean; nextBefore: number | null }

/**
 * Cắt kết quả đã lấy dư 1 dòng (limit size+1, id ↓) thành một trang + con trỏ keyset.
 * `nowMs` (server) quyết ảnh minh chứng đã hết hạn lưu chưa (Q-85) — không tính lúc render client.
 */
export function careInteractionPage(
  fetched: { id: number; outcome: string; note: string; next_action_date: string | null; created_at: string; task_id: string; actor: { full_name: string } | null; proof?: { url: string }[] | null }[] | null,
  taskId: string, nowMs: number, size = CARE_INTERACTION_PAGE_SIZE,
): CareInteractionPage {
  const all = fetched ?? []
  const rows = all.slice(0, size).map(({ task_id, ...r }) => {
    const proofExpired = (r.proof ?? []).some((p) => isCareProofDisplayUrl(p?.url)) && isProofExpired(r.created_at, nowMs)
    return { ...r, ...(proofExpired ? { proof: null } : {}), isThisTask: task_id === taskId, proofExpired }
  })
  const hasMore = all.length > size
  return { rows, hasMore, nextBefore: hasMore && rows.length ? rows[rows.length - 1].id : null }
}

/** n kỳ gần nhất (mới → cũ) cho bộ chọn tháng. */
export function recentCarePeriods(currentPeriod: string, n = 12): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = []
  let y = Number(currentPeriod.slice(0, 4))
  let m = Number(currentPeriod.slice(5, 7))
  for (let i = 0; i < n; i++) {
    const mm = String(m).padStart(2, '0')
    out.push({ value: `${y}-${mm}`, label: `Tháng ${mm}/${y}` })
    m -= 1
    if (m === 0) { m = 12; y -= 1 }
  }
  return out
}
