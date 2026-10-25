// T1-B: lưu trữ / khôi phục hàng loạt task qua RPC public.rpc_set_tasks_archived (migration 117) — MỘT transaction, kiểm quyền
// từng task ở DB (super mọi task; admin task mình tạo; SM task thuộc store được giao), lỗi nào cũng rollback toàn bộ. Phần thuần
// (không import Next / server-only) để test được: chuẩn hoá ID, gọi RPC qua client được truyền vào, đổi mã lỗi sang thông báo
// ngắn (không lộ ID / chi tiết DB), kiểm kết quả. Server Action (app/actions/tasks.ts) chỉ gắn cờ + session + revalidate.

export type ArchiveAction = 'archive' | 'restore'
export type ArchiveResult =
  | { success: true; count: number; target: number; error?: undefined }
  | { error: string; success?: undefined; count?: undefined; target?: undefined }

export const ARCHIVE_RPC = 'rpc_set_tasks_archived'
// = trần p_ids của RPC 117: ≤ 5.000 phần tử thô (kiểm trước khi duyệt / loại trùng), ≤ 1.000 ID sau loại trùng. Tập đích (kể
// cả con) trần 5.000 do RPC kiểm. RPC giữ trần riêng, độc lập với app.
export const ARCHIVE_MAX_RAW = 5000
export const ARCHIVE_MAX_IDS = 1000
export const ARCHIVE_DISABLED_MESSAGE = 'Lưu trữ / khôi phục hàng loạt đang tạm dừng — chưa task nào thay đổi'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VERB: Record<ArchiveAction, string> = { archive: 'lưu trữ', restore: 'khôi phục' }
const TOO_MANY_IDS_MESSAGE = 'Chọn tối đa 1.000 task mỗi lần — bỏ bớt rồi thử lại'

export function normalizeArchiveIds(ids: unknown): { ids: string[] } | { error: string } {
  if (!Array.isArray(ids) || ids.length === 0) return { error: 'Không có task nào được chọn' }
  if (ids.length > ARCHIVE_MAX_RAW) return { error: TOO_MANY_IDS_MESSAGE }
  if (!ids.every((id) => typeof id === 'string' && UUID_RE.test(id))) return { error: 'Danh sách task không hợp lệ — tải lại trang rồi chọn lại' }
  const unique = [...new Set((ids as string[]).map((id) => id.toLowerCase()))]
  if (unique.length > ARCHIVE_MAX_IDS) return { error: TOO_MANY_IDS_MESSAGE }
  return { ids: unique }
}

// Toast thành công: số task THỰC SỰ đổi trạng thái (changed_count đã qua parseArchiveResult) — không bao giờ lấy số ID đã chọn.
export function archiveSuccessMessage(action: ArchiveAction, changed: number): string {
  return changed === 0 ? `Không có task nào cần ${VERB[action]}` : `Đã ${VERB[action]} ${changed} task`
}

type RpcError = { message?: string; code?: string } | null | undefined

// Mã lỗi RPC (đều rollback toàn bộ) ⇒ "chưa task nào thay đổi". Lỗi không nhận ra (mạng, …) không khẳng định điều đó.
export function archiveErrorMessage(action: ArchiveAction, err: RpcError): string {
  const m = err?.message ?? ''
  const code = err?.code ?? ''
  const v = VERB[action]
  if (m.includes('TASKS_ARCHIVE_UNAUTHENTICATED')) return 'Phiên đăng nhập đã hết — đăng nhập lại rồi thử lại'
  if (m.includes('TASKS_ARCHIVE_FORBIDDEN')) return `Bạn không có quyền ${v} task`
  if (m.includes('TASKS_ARCHIVE_OUT_OF_SCOPE')) return `Có task ngoài quyền của bạn — chưa ${v} task nào. Bỏ chọn task đó rồi thử lại`
  if (m.includes('TASKS_ARCHIVE_NOT_FOUND')) return `Có task không còn tồn tại — chưa ${v} task nào. Tải lại trang rồi chọn lại`
  if (m.includes('TASKS_ARCHIVE_TOO_MANY')) return `Quá nhiều task trong một lần (tối đa 1.000 task chọn, 5.000 task kể cả task con) — chưa ${v} task nào. Chia nhỏ rồi thử lại`
  // Số dòng ghi lệch số đích (RPC rollback) — không phải lỗi tạm thời nên không bảo "thử lại".
  if (m.includes('TASKS_ARCHIVE_COUNT_MISMATCH')) return `Không ${v} được — kết quả ghi không khớp, chưa task nào thay đổi. Báo quản trị hệ thống`
  // CONCURRENT_CHANGE (RPC tự RAISE), serialization / deadlock / lock_timeout / statement_timeout (Postgres).
  if (m.includes('TASKS_ARCHIVE_CONCURRENT_CHANGE') || ['40001', '40P01', '55P03', '57014'].includes(code))
    return `Task đang được thao tác khác thay đổi — chưa ${v} task nào. Thử lại sau ít giây`
  if (m.includes('TASKS_ARCHIVE_EMPTY')) return 'Không có task nào được chọn'
  if (m.includes('TASKS_ARCHIVE_BAD_INPUT') || m.includes('TASKS_ARCHIVE_BAD_ACTION') || code === '22P02')
    return 'Danh sách task không hợp lệ — tải lại trang rồi chọn lại'
  // RPC chưa có trên DB (chưa chạy 117 / đã gỡ) — PostgREST PGRST202, Postgres 42883.
  if (code === 'PGRST202' || code === '42883') return `Chức năng ${v} hàng loạt chưa sẵn sàng — chưa task nào thay đổi. Báo quản trị hệ thống`
  return `Không ${v} được — tải lại trang để xem trạng thái rồi thử lại`
}

// Thành công chỉ khi kết quả đúng hợp đồng: số nguyên, 0 ≤ changed ≤ target, target ≥ số ID đã chọn (mỗi ID chọn đều thuộc đích).
export function parseArchiveResult(data: unknown, selected: number): { target: number; changed: number } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const { target_count: target, changed_count: changed } = data as Record<string, unknown>
  if (typeof target !== 'number' || typeof changed !== 'number' || !Number.isInteger(target) || !Number.isInteger(changed)) return null
  if (changed < 0 || changed > target || target < selected) return null
  return { target, changed }
}

type RpcClient = {
  rpc: (fn: string, args: { p_ids: string[]; p_action: ArchiveAction }) => PromiseLike<{ data: unknown; error: RpcError }>
}

// ID không hợp lệ ⇒ dừng trước khi gọi RPC. Một lời gọi RPC duy nhất (body POST — không có URL dài, không chia chunk).
export async function runArchiveRpc(client: RpcClient, rawIds: unknown, action: ArchiveAction): Promise<ArchiveResult> {
  const n = normalizeArchiveIds(rawIds)
  if ('error' in n) return n
  let res: { data: unknown; error: RpcError }
  try {
    res = await client.rpc(ARCHIVE_RPC, { p_ids: n.ids, p_action: action })
  } catch {
    return { error: archiveErrorMessage(action, null) }
  }
  const { data, error } = res
  if (error) return { error: archiveErrorMessage(action, error) }
  const r = parseArchiveResult(data, n.ids.length)
  if (!r) return { error: `Không xác nhận được kết quả ${VERB[action]} — tải lại trang để kiểm tra` }
  return { success: true, count: r.changed, target: r.target }
}
