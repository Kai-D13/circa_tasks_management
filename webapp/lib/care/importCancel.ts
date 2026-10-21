// CRM-CSKH D1 — huỷ file import N1 chưa có lượt (Q-149–163, SPEC §Sau go-live D). Logic THUẦN (không Next/Supabase) để test được:
// kiểm input, đọc kết quả RPC care_import_cancel_preview / care_import_cancel (migration 115), map mã lỗi sang chữ an toàn.
// commitSeq là CHUỖI số thập phân suốt đường đi (SPEC: bigint không đi qua JS Number).

export const CARE_CANCEL_RPC_CODES = [
  'FORBIDDEN', 'NOT_FOUND', 'NOT_COMMITTED', 'NOT_CURRENT_PERIOD', 'PROVENANCE_UNAVAILABLE', 'NOT_LATEST', 'HAS_ACTIVITY', 'RESTORE_UNAVAILABLE',
] as const
export type CareCancelRpcCode = (typeof CARE_CANCEL_RPC_CODES)[number]
export type CareCancelCode = CareCancelRpcCode | 'INVALID_INPUT' | 'NOT_ENABLED' | 'UNAUTHENTICATED' | 'UNAVAILABLE' | 'RETRYABLE' | 'FAILED'

/** Q-157 — câu cảnh báo cố định của hộp thoại xác nhận. */
export const CARE_CANCEL_WARNING =
  'Huỷ file sẽ xoá các task chưa có lượt chăm sóc và hoàn nguyên thay đổi của file. Task kỳ trước đã đóng khi import sẽ không được mở lại.'

export const CARE_CANCEL_MESSAGES: Record<CareCancelCode, string> = {
  FORBIDDEN: 'Bạn không có quyền huỷ file import.',
  NOT_FOUND: 'Không tìm thấy file import này.',
  NOT_COMMITTED: 'Chỉ huỷ được file đã import thành công.',
  NOT_CURRENT_PERIOD: 'Chỉ huỷ được file của kỳ hiện tại.',
  PROVENANCE_UNAVAILABLE: 'File này import trước khi có chức năng huỷ nên không huỷ được.',
  NOT_LATEST: 'Chỉ huỷ được file import mới nhất của kỳ — tải lại trang và xem trước lại.',
  HAS_ACTIVITY: 'Không huỷ được: đã có task của file này được chăm sóc, chuyển giao hoặc từ chối.',
  RESTORE_UNAVAILABLE: 'Không huỷ được: không chứng minh được khôi phục chính xác trạng thái trước file này.',
  INVALID_INPUT: 'Yêu cầu không hợp lệ — tải lại trang và thử lại.',
  NOT_ENABLED: 'Chức năng huỷ file chưa được bật.',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết — đăng nhập lại.',
  UNAVAILABLE: 'Hệ thống CRM chưa sẵn sàng.',
  RETRYABLE: 'Hệ thống đang bận (đang có import hoặc thao tác khác) — thử lại sau ít phút.',
  FAILED: 'Không huỷ được file — thử lại sau.',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BIGINT_MAX = '9223372036854775807'

export const isCareBatchId = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

/** commitSeq hợp lệ: chuỗi số nguyên dương thập phân trong miền bigint (so CHUỖI theo độ dài rồi thứ tự — không dùng Number). */
export function parseCareCommitSeq(v: unknown): string | null {
  if (typeof v !== 'string' || !/^[1-9][0-9]{0,18}$/.test(v)) return null
  if (v.length === BIGINT_MAX.length && v > BIGINT_MAX) return null
  return v
}

export interface CareCancelCounts {
  tasksDeleted: number
  tasksRestored: number
  productsDeleted: number
  productsRestored: number
  eventsDeleted: number
  customersDeleted: number
}

const COUNT_KEYS: [keyof CareCancelCounts, string][] = [
  ['tasksDeleted', 'tasks_deleted'], ['tasksRestored', 'tasks_restored'], ['productsDeleted', 'products_deleted'],
  ['productsRestored', 'products_restored'], ['eventsDeleted', 'events_deleted'], ['customersDeleted', 'customers_deleted'],
]

function readCounts(o: Record<string, unknown>): CareCancelCounts | null {
  const out = {} as CareCancelCounts
  for (const [k, sql] of COUNT_KEYS) {
    const v = o[sql]
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return null
    out[k] = v
  }
  return out
}

const isRpcCode = (v: unknown): v is CareCancelRpcCode => typeof v === 'string' && (CARE_CANCEL_RPC_CODES as readonly string[]).includes(v)

export type CareCancelPreview =
  | { ok: true; commitSeq: string; kind: 'initial' | 'revision'; counts: CareCancelCounts }
  | { ok: false; code: CareCancelCode }

/** Kết quả care_import_cancel_preview ⇒ dạng app. Dữ liệu sai dạng ⇒ FAILED (fail-closed, không đoán). */
export function readCancelPreview(data: unknown): CareCancelPreview {
  if (!data || typeof data !== 'object') return { ok: false, code: 'FAILED' }
  const o = data as Record<string, unknown>
  if (o.status === 'rejected') return { ok: false, code: isRpcCode(o.code) ? o.code : 'FAILED' }
  if (o.status !== 'ready') return { ok: false, code: 'FAILED' }
  const seq = parseCareCommitSeq(o.commit_seq)
  const counts = readCounts(o)
  if (!seq || !counts || (o.kind !== 'initial' && o.kind !== 'revision')) return { ok: false, code: 'FAILED' }
  return { ok: true, commitSeq: seq, kind: o.kind, counts }
}

export type CareCancelResult = { ok: true; counts: CareCancelCounts } | { ok: false; code: CareCancelCode }

/** Kết quả care_import_cancel ⇒ dạng app. */
export function readCancelResult(data: unknown): CareCancelResult {
  if (!data || typeof data !== 'object') return { ok: false, code: 'FAILED' }
  const o = data as Record<string, unknown>
  if (o.status === 'rejected') return { ok: false, code: isRpcCode(o.code) ? o.code : 'FAILED' }
  if (o.status !== 'cancelled') return { ok: false, code: 'FAILED' }
  const counts = readCounts(o)
  return counts ? { ok: true, counts } : { ok: false, code: 'FAILED' }
}

/** Lỗi PostgREST/Postgres khi gọi RPC ⇒ mã app. Khoá chờ quá hạn (55P03) / deadlock (40P01) ⇒ thử lại; thiếu tham số ⇒ input. */
export function mapCancelRpcError(err: { code?: string | null; message?: string | null } | null | undefined): CareCancelCode {
  if (!err) return 'FAILED'
  if (err.code === '55P03' || err.code === '40P01') return 'RETRYABLE'
  if (typeof err.message === 'string' && err.message.includes('thiếu tham số')) return 'INVALID_INPUT'
  return 'FAILED'
}

/**
 * Phạm vi dữ liệu (B6-qa-ui): production chỉ batch thật (is_test=false); server QA local chỉ batch QA của marker.
 * Batch ngoài phạm vi ⇒ coi như không tồn tại (NOT_FOUND) — không lộ batch is_test ở production.
 */
export function careCancelBatchInScope(batch: { id: string; is_test: boolean } | null, scope: { kind: 'production' } | { kind: 'qa'; batchId: string }): boolean {
  if (!batch) return false
  return scope.kind === 'qa' ? batch.is_test && batch.id === scope.batchId : !batch.is_test
}

// ── Luồng của 2 server action (app/actions/careImportCancel.ts chỉ nối phụ thuộc thật) — thuần để test hành vi ──────────
export const CARE_CANCEL_REVALIDATE = ['/care/assign', '/care', '/care/tasks', '/care/my', '/care/reports'] as const
type RpcError = { code?: string | null; message?: string | null } | null
export interface CareCancelDeps {
  enabled: () => boolean
  /** getCareImportAccess(): quyền import từ SESSION thật (không QLCH). */
  access: () => Promise<{ kind: string; actorId?: string }>
  /** Đọc batch bằng service role (chỉ id + is_test). */
  loadBatch: (id: string) => Promise<{ data: { id: string; is_test: boolean } | null; error: unknown }>
  scope: () => { kind: 'production' } | { kind: 'qa'; batchId: string }
  rpc: (fn: 'care_import_cancel_preview' | 'care_import_cancel', args: Record<string, string>) => Promise<{ data: unknown; error: RpcError }>
  revalidate: (path: string) => void
}
type Guarded = { ok: true; actorId: string; batchId: string } | { ok: false; code: CareCancelCode }

/** Thứ tự: cờ → input → quyền session → phạm vi dữ liệu. Ngoài phạm vi ⇒ NOT_FOUND (không lộ batch is_test / batch thật). */
async function careCancelGuard(batchId: unknown, d: CareCancelDeps): Promise<Guarded> {
  if (!d.enabled()) return { ok: false, code: 'NOT_ENABLED' }
  if (!isCareBatchId(batchId)) return { ok: false, code: 'INVALID_INPUT' }
  const access = await d.access()
  if (access.kind === 'anonymous') return { ok: false, code: 'UNAUTHENTICATED' }
  if (access.kind === 'unavailable') return { ok: false, code: 'UNAVAILABLE' }
  if (access.kind !== 'ok' || !access.actorId) return { ok: false, code: 'FORBIDDEN' }
  const { data, error } = await d.loadBatch(batchId)
  if (error) return { ok: false, code: 'UNAVAILABLE' }
  if (!careCancelBatchInScope(data, d.scope())) return { ok: false, code: 'NOT_FOUND' }
  return { ok: true, actorId: access.actorId, batchId }
}

/** Xem trước (chỉ đọc). p_actor = user đã xác thực ở server, không nhận từ client. */
export async function runCareCancelPreview(input: { batchId?: unknown } | null | undefined, d: CareCancelDeps): Promise<CareCancelPreview> {
  const g = await careCancelGuard(input?.batchId, d)
  if (!g.ok) return { ok: false, code: g.code }
  const { data, error } = await d.rpc('care_import_cancel_preview', { p_batch_id: g.batchId, p_actor: g.actorId })
  if (error) return { ok: false, code: mapCancelRpcError(error) }
  return readCancelPreview(data)
}

/** Huỷ MỘT batch; expectedCommitSeq (chuỗi) bắt buộc — PostgREST ép kiểu bigint phía DB. Revalidate chỉ khi huỷ xong. */
export async function runCareCancel(input: { batchId?: unknown; expectedCommitSeq?: unknown } | null | undefined, d: CareCancelDeps): Promise<CareCancelResult> {
  const g = await careCancelGuard(input?.batchId, d)
  if (!g.ok) return { ok: false, code: g.code }
  const seq = parseCareCommitSeq(input?.expectedCommitSeq)
  if (!seq) return { ok: false, code: 'INVALID_INPUT' }
  const { data, error } = await d.rpc('care_import_cancel', { p_batch_id: g.batchId, p_actor: g.actorId, p_expected_commit_seq: seq })
  if (error) return { ok: false, code: mapCancelRpcError(error) }
  const res = readCancelResult(data)
  if (res.ok) for (const p of CARE_CANCEL_REVALIDATE) d.revalidate(p)
  return res
}
