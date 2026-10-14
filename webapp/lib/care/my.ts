import { CARE_OUTCOME_META, isCareOutcome, type CareOutcome } from './outcome'
import type { CareQueryBuilder } from './browse'
import { applyCareScope, CARE_PRODUCTION_SCOPE, type CareDataScope } from './scope'

// CRM-CSKH B4 — logic THUẦN cho màn dược sĩ (mobile): "Khách hàng của tôi", form ghi
// lượt, proof ảnh. Không import Next/Supabase ⇒ test trực tiếp. Quyền thật ở RLS/RPC 114.

// ── Proof ảnh (purpose upload `care_proof`) ────────────────────────────────────
/**
 * Public base GCS của app (= GCS_PUBLIC_BASE_URL ở .env.example/.env.local, 08/10).
 * RPC 114 `care__record_interaction_at` cố định CÙNG giá trị — spec ép khớp.
 */
export const CARE_PROOF_PUBLIC_BASE = 'https://storage.googleapis.com/duocsi-circa-vn'
export const CARE_PROOF_MAX = 5
export const CARE_PROOF_MAX_BYTES = 5 * 1024 * 1024
/** MIME ảnh được nhận → đuôi object (không nhận SVG/GIF). */
export const CARE_PROOF_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
}

/** MIME có trong allowlist — chỉ khoá RIÊNG (`'toString' in {}` là true ⇒ không dùng `in`). */
export function isCareProofMime(contentType: unknown): contentType is string {
  return typeof contentType === 'string' && Object.prototype.hasOwnProperty.call(CARE_PROOF_EXT, contentType)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY_TAIL_RE = /^[0-9]{13}_[0-9a-f]{8}\.(jpg|png|webp|heic|heif)$/

/**
 * Object key OPAQUE theo task: care-proof/<task_id>/<epoch ms 13 số>_<8 hex>.<đuôi>.
 * Không chứa tên file gốc (có thể là tên/SĐT khách) — không PII trong key/log.
 */
export function careProofKey(taskId: string, contentType: string, nowMs: number, rand8: string): string | null {
  const ext = isCareProofMime(contentType) ? CARE_PROOF_EXT[contentType] : undefined
  if (!ext || !UUID_RE.test(taskId) || !/^[0-9a-f]{8}$/.test(rand8)) return null
  const ms = String(Math.trunc(nowMs))
  if (!/^[0-9]{13}$/.test(ms)) return null
  return `care-proof/${taskId.toLowerCase()}/${ms}_${rand8}.${ext}`
}

/** URL proof hợp lệ cho task: đúng base + prefix task + đuôi khoá do app sinh. Mirror SQL 114. */
export function isCareProofUrl(url: unknown, taskId: string, base = CARE_PROOF_PUBLIC_BASE): url is string {
  if (typeof url !== 'string' || url.length > 1000 || !UUID_RE.test(taskId)) return false
  const prefix = `${base.replace(/\/+$/, '')}/care-proof/${taskId.toLowerCase()}/`
  return url.startsWith(prefix) && KEY_TAIL_RE.test(url.slice(prefix.length))
}

/** Hiển thị proof: chỉ URL thuộc kho care-proof của app (bất kỳ task — lịch sử khách). */
export function isCareProofDisplayUrl(url: unknown, base = CARE_PROOF_PUBLIC_BASE): url is string {
  if (typeof url !== 'string' || url.length > 1000) return false
  const m = /^care-proof\/([0-9a-f-]{36})\/(.+)$/.exec(url.startsWith(base + '/') ? url.slice(base.length + 1) : '')
  return !!m && UUID_RE.test(m[1]) && KEY_TAIL_RE.test(m[2])
}

const DAY_MS = 86_400_000

/**
 * Q-85: object `care-proof/` bị GCS lifecycle xoá sau 90 ngày (operator cấu hình trước B6).
 * Lượt + URL vẫn giữ trong DB (append-only); UI coi ảnh của lượt quá hạn là đã hết thời hạn
 * lưu thay vì đưa người xem vào link đã xoá. Mốc tính từ created_at của lượt (ảnh tải lên ngay
 * trước khi ghi lượt — vài phút lệch do onError trên ảnh xử lý).
 */
export const CARE_PROOF_RETENTION_DAYS = 90
export function isProofExpired(createdAt: string, nowMs: number): boolean {
  const t = Date.parse(createdAt)
  return Number.isFinite(t) && Number.isFinite(nowMs) && t + CARE_PROOF_RETENTION_DAYS * DAY_MS < nowMs
}

// ── Danh sách "Khách hàng của tôi" ─────────────────────────────────────────────
export const CARE_MY_FILTERS = ['all', 'not_cared', 'overdue', 'completed'] as const
export type CareMyFilter = (typeof CARE_MY_FILTERS)[number]
export const CARE_MY_FILTER_LABELS: Record<CareMyFilter, string> = {
  all: 'Tất cả', not_cared: 'Chưa chăm sóc', overdue: 'Quá hạn', completed: 'Hoàn thành',
}
export const CARE_MY_PAGE_SIZE = 20

export function parseMyFilters(sp: Record<string, string | string[] | undefined>): { filter: CareMyFilter; page: number } {
  const one = (k: string) => { const v = sp[k]; return typeof v === 'string' ? v.trim() : '' }
  const f = one('filter')
  const filter = (CARE_MY_FILTERS as readonly string[]).includes(f) ? (f as CareMyFilter) : 'all'
  const page = Math.min(10_000, Math.max(1, Number.parseInt(one('page'), 10) || 1))
  return { filter, page }
}

export function myFilterHref(filter: CareMyFilter, page = 1): string {
  const q = new URLSearchParams()
  if (filter !== 'all') q.set('filter', filter)
  if (page > 1) q.set('page', String(page))
  const s = q.toString()
  return s ? `/care/my?${s}` : '/care/my'
}

/**
 * B7-ui (M01/M02): màn con của luồng CSKH dược sĩ — header mobile quay về màn CHA cố định
 * (không `router.back()`: sau khi lưu lượt, lịch sử còn form cũ) và bottom nav ẩn để nút
 * hành động chính dính đáy. `/care/my` là màn gốc của tab CSKH ⇒ null (không "Quay lại").
 */
export function careMyBackTarget(pathname: string): { href: string; label: string } | null {
  const m = /^\/care\/my\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/update)?\/?$/i.exec(pathname)
  if (!m) return null
  return m[2] ? { href: `/care/my/${m[1]}`, label: 'Chi tiết khách' } : { href: '/care/my', label: 'Khách hàng của tôi' }
}

/** B7-ui r2: 3 màn dược sĩ CSKH có header riêng của trang (MobileHeader chung ẩn) — danh sách gốc + 2 màn con. */
export function careMyScreen(pathname: string): 'list' | 'detail' | 'update' | null {
  if (pathname === '/care/my' || pathname === '/care/my/') return 'list'
  const b = careMyBackTarget(pathname)
  return b ? (b.href === '/care/my' ? 'detail' : 'update') : null
}

/**
 * B7-ui r2: nút quay lại/huỷ ở header màn con. Mục lịch sử ngay trước đúng là màn cha (cùng pathname,
 * query tuỳ ý) ⇒ 'back' — giữ bộ lọc/trang/vị trí cuộn của danh sách; còn lại (mở link trực tiếp, vừa
 * lưu form xong bằng replace…) ⇒ 'push' về màn cha cố định.
 */
export function careBackMode(prevUrl: string | null | undefined, targetHref: string, origin: string): 'back' | 'push' {
  if (!prevUrl) return 'push'
  try {
    const prev = new URL(prevUrl, origin)
    return prev.origin === origin && prev.pathname.replace(/\/$/, '') === targetHref.replace(/\/$/, '') ? 'back' : 'push'
  } catch { return 'push' }
}

/** Chữ tắt avatar khách: chữ cái đầu của từ đầu + từ cuối có chữ (bỏ từ chỉ có số), tối đa 2 ký tự. */
export function customerInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w))
  if (words.length === 0) return '?'
  const first = words[0].match(/\p{L}/u)![0]
  const last = words.length > 1 ? words[words.length - 1].match(/\p{L}/u)![0] : ''
  return (first + last).toLocaleUpperCase('vi')
}

const VN_WEEKDAYS = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy']
/** Ngày lịch "dd/mm/yyyy (Thứ …)" — tránh ô date native hiện mm/dd theo locale máy. */
export function careDateLabel(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} (${VN_WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()]})`
}

/**
 * B7-ui (M05): nút chọn nhanh ngày hẹn — ngày lịch thuần (UTC 00:00, không lệch múi giờ);
 * nút vượt hạn task (`dueISO`) bị tắt. Server/RPC vẫn validate [hôm nay, hạn] như cũ.
 */
export const CARE_NEXT_DATE_PRESETS = [{ label: 'Hôm nay', days: 0 }, { label: 'Ngày mai', days: 1 }, { label: '+3 ngày', days: 3 }, { label: '+7 ngày', days: 7 }] as const
export function careNextDatePresets(todayISO: string, dueISO: string): { label: string; value: string; disabled: boolean }[] {
  return CARE_NEXT_DATE_PRESETS.map((p) => {
    const d = new Date(`${todayISO}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + p.days)
    const value = d.toISOString().slice(0, 10)
    return { label: p.label, value, disabled: value > dueISO }
  })
}

/**
 * Áp filter lên query task của CHÍNH dược sĩ (assignee + ĐÚNG store hiện tại — Q-82 + kỳ hiện
 * tại + phạm vi dữ liệu: production loại is_test · QA local chỉ batch QA). RLS 114 cũng chặn store
 * lệch; điều kiện ở đây giữ danh sách khớp care_my_summary. "Quá hạn" = còn mở + ngày hẹn < hôm nay
 * VN (task chưa gọi, chưa hẹn KHÔNG tự quá hạn).
 */
export function applyMyTaskFilters<Q extends CareQueryBuilder<Q>>(q: Q, userId: string, storeId: string, period: string, filter: CareMyFilter, todayISO: string, scope: CareDataScope = CARE_PRODUCTION_SCOPE): Q {
  let r = applyCareScope(q.eq('assignee_id', userId).eq('store_id', storeId).eq('period_month', period), scope)
  switch (filter) {
    case 'not_cared': r = r.eq('status', 'open').is('last_interaction_at', null); break
    case 'overdue': r = r.eq('status', 'open').lt('next_action_date', todayISO); break
    case 'completed': r = r.eq('status', 'completed'); break
  }
  return r
}

/** Khoá sort của một task trong danh sách (đọc TOÀN TẬP đã lọc trước khi phân trang). */
export interface CareMySortKey { id: string; status: string; next_action_date: string | null }

const isoDayNo = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS
/** 0 = mở có ngày hẹn · 1 = mở chưa hẹn (chưa gọi) · 2 = đã kết thúc. */
const myGroup = (t: CareMySortKey) => (t.status !== 'open' ? 2 : t.next_action_date ? 0 : 1)

/**
 * Q-84 (stakeholder): task mở CÓ hẹn đứng đầu, theo |ngày hẹn − hôm nay VN| tăng dần; cùng
 * khoảng cách thì lịch QUÁ HẠN trước (hôm qua trước ngày mai); rồi task mở chưa hẹn; cuối cùng
 * task đã kết thúc. Trong nhóm (và khi hoà) theo id tăng dần — id uuid chữ thường nên so chuỗi
 * cùng thứ tự với Postgres.
 */
export function compareMyTasks(a: CareMySortKey, b: CareMySortKey, todayISO: string): number {
  const ga = myGroup(a), gb = myGroup(b)
  if (ga !== gb) return ga - gb
  if (ga === 0) {
    const today = isoDayNo(todayISO)
    const da = isoDayNo(a.next_action_date as string) - today, db = isoDayNo(b.next_action_date as string) - today
    if (Math.abs(da) !== Math.abs(db)) return Math.abs(da) - Math.abs(db)
    if (da !== db) return da - db
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Sort TOÀN TẬP rồi cắt trang (không sort riêng một trang sau `range`). */
export function pageMyTasks(keys: readonly CareMySortKey[], page: number, todayISO: string, size = CARE_MY_PAGE_SIZE): { pageIds: string[]; total: number } {
  const sorted = [...keys].sort((a, b) => compareMyTasks(a, b, todayISO))
  const from = (Math.max(1, page) - 1) * size
  return { pageIds: sorted.slice(from, from + size).map((t) => t.id), total: keys.length }
}

/**
 * Điều kiện app trước khi ghi lượt / cấp URL ảnh proof (RPC 114 kiểm lại và là chốt cuối).
 * `t` = task đọc bằng SESSION (RLS) — null khi không thấy. Q-82: dược sĩ phải là assignee VÀ
 * còn ở đúng store của task (`me.storeId` = store OS đang hoạt động từ getCareStaffAccess).
 */
export type CareStaffTaskBlock = 'TASK_NOT_FOUND' | 'NOT_ASSIGNEE' | 'TASK_CLOSED' | 'PERIOD_PASSED'
export function careStaffTaskBlock(
  t: { assignee_id: string; store_id: string; status: string; period_month: string } | null | undefined,
  me: { userId: string; storeId: string }, currentPeriod: string,
): CareStaffTaskBlock | null {
  if (!t) return 'TASK_NOT_FOUND'
  if (t.assignee_id !== me.userId || t.store_id !== me.storeId) return 'NOT_ASSIGNEE'
  if (t.status !== 'open') return 'TASK_CLOSED'
  if (t.period_month !== currentPeriod) return 'PERIOD_PASSED'
  return null
}

export interface CareMyTaskBadge { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }
/** Nhãn trạng thái trên thẻ: Quá hạn > Hẹn chăm sóc lại dd/mm > Đang theo dõi > Chưa chăm sóc. */
export function careMyBadge(t: { status: string; last_interaction_at: string | null; next_action_date: string | null }, todayISO: string): CareMyTaskBadge {
  if (t.status === 'completed') return { label: 'Hoàn thành', tone: 'success' }
  if (t.status === 'closed_unfinished') return { label: 'Không hoàn thành trong kỳ', tone: 'neutral' }
  const d = t.next_action_date
  if (d && d < todayISO) return { label: `Quá hạn · hẹn ${d.slice(8, 10)}/${d.slice(5, 7)}`, tone: 'danger' }
  if (d) return { label: `Hẹn chăm sóc lại ${d.slice(8, 10)}/${d.slice(5, 7)}`, tone: 'info' }
  if (t.last_interaction_at) return { label: 'Đang theo dõi', tone: 'warning' }
  return { label: 'Chưa chăm sóc', tone: 'neutral' }
}

// ── Form ghi lượt ──────────────────────────────────────────────────────────────
export const CARE_NOTE_MAX = 500

export type CareRecordErrorCode =
  | 'UNAUTHENTICATED' | 'NOT_ASSIGNEE' | 'TASK_NOT_FOUND' | 'TASK_CLOSED' | 'PERIOD_PASSED'
  | 'OUTCOME_INVALID' | 'NOTE_REQUIRED' | 'DATE_REQUIRED' | 'DATE_RANGE' | 'DATE_NOT_ALLOWED'
  | 'PROOF_INVALID' | 'DUPLICATE' | 'RECORD_FAILED'

export const CARE_RECORD_MESSAGES: Record<CareRecordErrorCode, string> = {
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết — đăng nhập lại.',
  NOT_ASSIGNEE: 'Khách này không còn được giao cho bạn (có thể vừa được chuyển giao).',
  TASK_NOT_FOUND: 'Không tìm thấy khách cần chăm sóc — tải lại danh sách.',
  TASK_CLOSED: 'Khách đã hoàn thành hoặc đã đóng kỳ — không ghi thêm lượt.',
  PERIOD_PASSED: 'Kỳ chăm sóc của khách này đã qua.',
  OUTCOME_INVALID: 'Chọn một kết quả chăm sóc.',
  NOTE_REQUIRED: 'Ghi chú bắt buộc (1–500 ký tự).',
  DATE_REQUIRED: 'Kết quả này bắt buộc chọn ngày hẹn chăm sóc lại.',
  DATE_RANGE: 'Ngày hẹn phải từ hôm nay đến hết tháng của khách.',
  DATE_NOT_ALLOWED: 'Kết quả này kết thúc chăm sóc, không cần ngày hẹn.',
  PROOF_INVALID: 'Ảnh đính kèm không hợp lệ — xoá ảnh và tải lại.',
  DUPLICATE: 'Lượt này vừa được lưu — mở tab Lịch sử để kiểm tra, không cần gửi lại.',
  RECORD_FAILED: 'Không lưu được lượt chăm sóc — thử lại.',
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Kiểm đầu vào phía app (RPC 114 kiểm lại và là chốt cuối). */
export function validateInteractionInput(
  input: { outcome: unknown; note: unknown; nextActionDate: unknown; proofUrls: unknown },
  ctx: { taskId: string; todayISO: string; dueDate: string; proofBase?: string },
): { ok: true; outcome: CareOutcome; note: string; nextActionDate: string | null; proof: { url: string }[] } | { ok: false; code: CareRecordErrorCode } {
  if (!isCareOutcome(input.outcome)) return { ok: false, code: 'OUTCOME_INVALID' }
  const outcome = input.outcome
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (note.length < 1 || note.length > CARE_NOTE_MAX) return { ok: false, code: 'NOTE_REQUIRED' }
  const raw = typeof input.nextActionDate === 'string' ? input.nextActionDate.trim() : ''
  let nextActionDate: string | null = null
  if (CARE_OUTCOME_META[outcome].requiresNextActionDate) {
    if (!raw) return { ok: false, code: 'DATE_REQUIRED' }
    if (!ISO_DATE.test(raw) || raw < ctx.todayISO || raw > ctx.dueDate) return { ok: false, code: 'DATE_RANGE' }
    nextActionDate = raw
  } else if (raw) {
    return { ok: false, code: 'DATE_NOT_ALLOWED' }
  }
  const urls = input.proofUrls === undefined || input.proofUrls === null ? [] : input.proofUrls
  if (!Array.isArray(urls) || urls.length > CARE_PROOF_MAX || new Set(urls).size !== urls.length
      || !urls.every((u) => isCareProofUrl(u, ctx.taskId, ctx.proofBase))) {
    return { ok: false, code: 'PROOF_INVALID' }
  }
  return { ok: true, outcome, note, nextActionDate, proof: (urls as string[]).map((url) => ({ url })) }
}

/** Map RAISE của care__record_interaction_at (114) → mã an toàn (không trả message gốc). */
export function mapCareRecordError(message: string | null | undefined): CareRecordErrorCode {
  const m = message ?? ''
  if (/chưa đăng nhập/.test(m)) return 'UNAUTHENTICATED'
  if (/không tìm thấy task/.test(m)) return 'TASK_NOT_FOUND'
  if (/chỉ dược sĩ được giao/.test(m)) return 'NOT_ASSIGNEE'
  if (/task đã kết thúc|one_terminal_per_task/.test(m)) return 'TASK_CLOSED'
  if (/task thuộc kỳ đã qua/.test(m)) return 'PERIOD_PASSED'
  if (/kết quả không hợp lệ/.test(m)) return 'OUTCOME_INVALID'
  if (/ghi chú bắt buộc/.test(m)) return 'NOTE_REQUIRED'
  if (/bắt buộc ngày hẹn/.test(m)) return 'DATE_REQUIRED'
  if (/ngày hẹn phải từ hôm nay/.test(m)) return 'DATE_RANGE'
  if (/không nhận ngày hẹn/.test(m)) return 'DATE_NOT_ALLOWED'
  if (/proof phải là mảng/.test(m)) return 'PROOF_INVALID'
  if (/lượt trùng vừa được ghi/.test(m)) return 'DUPLICATE'
  return 'RECORD_FAILED'
}
