// CRM-CSKH E3 r1.1 — chip "Có đơn xác thực" của /care/my (PM E1–E3 r1 P1): logic THUẦN, RPC + khoá cursor tiêm vào ⇒ spec chạy
// với RPC 116 thật trên PGlite. Lớp server (lib/care/server/orderLinks.ts) chỉ nối session client. Không service role.
// (1) danh sách: keyset của care_my_order_tasks (latest DESC, task_id DESC), 20 / trang, cursor ký gắn user + kỳ + phạm vi QA;
// (2) tìm trong nhóm: id task khớp tên / SĐT (đọc RLS ở caller) ∩ task có ≥ 1 đơn (care_task_order_counts ≤ 50 id / lần),
//     cùng thứ tự với (1), cắt trang theo số trang như tìm kiếm thường.
import { signCareCursor, verifyCareCursor } from './cursor'
import { parseMyOrderTasks, parseTaskOrderCounts } from './view'

export type CareOrderRpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>

export class CareOrderCursorError extends Error { constructor() { super('care_order_cursor_invalid') } }

/** = trần p_limit của care_my_order_tasks (116) và cỡ trang /care/my. */
export const CARE_MY_ORDER_PAGE = 20
/** = trần mảng của care_task_order_counts (116 RAISE khi > 50). */
export const CARE_ORDER_COUNTS_MAX_IDS = 50
const COUNTS_PARALLEL = 4
/** Trần số task khớp từ khoá đưa vào tìm trong nhóm (≤ 40 lần gọi counts). Quá trần ⇒ báo thu hẹp từ khoá, KHÔNG cắt kết quả.
 *  TODO(Q-200): mặc định đề xuất 2.000 (dược sĩ thường vài chục – vài trăm task / kỳ). */
export const CARE_MY_ORDER_SEARCH_MAX_IDS = 2_000
export class CareOrderSearchTooBroadError extends Error { constructor() { super('care_order_search_too_broad') } }

export const myOrdersCtx = (period: string, qaBatchId: string | null) => `my:${period}|${qaBatchId ?? ''}`

export async function myOrderTaskPage(rpc: CareOrderRpc, key: string, userId: string, period: string, qaBatchId: string | null, cursor?: string | null):
  Promise<{ taskIds: string[]; next: string | null }> {
  const ctx = myOrdersCtx(period, qaBatchId)
  let a: { a: string; b: string } | null = null
  if (cursor) {
    a = verifyCareCursor(key, cursor, { u: userId, c: ctx })
    if (!a) throw new CareOrderCursorError()
  }
  const page = parseMyOrderTasks(await rpc('care_my_order_tasks', {
    p_qa_batch_id: qaBatchId, p_after_latest: a?.a ?? null, p_after_task_id: a?.b ?? null, p_limit: CARE_MY_ORDER_PAGE,
  }))
  const last = page.rows.at(-1)
  return {
    taskIds: page.rows.map((r) => r.taskId),
    next: page.hasMore && last ? signCareCursor(key, { u: userId, c: ctx, a: last.latestCompletedAt, b: last.taskId }) : null,
  }
}

export async function myOrderSearchPage(rpc: CareOrderRpc, ids: readonly string[], page: number, size = CARE_MY_ORDER_PAGE):
  Promise<{ pageIds: string[]; total: number }> {
  if (ids.length > CARE_MY_ORDER_SEARCH_MAX_IDS) throw new CareOrderSearchTooBroadError()
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += CARE_ORDER_COUNTS_MAX_IDS) chunks.push(ids.slice(i, i + CARE_ORDER_COUNTS_MAX_IDS))
  const hits: { id: string; latest: string }[] = []
  for (let i = 0; i < chunks.length; i += COUNTS_PARALLEL) {
    const res = await Promise.all(chunks.slice(i, i + COUNTS_PARALLEL).map(async (c) => parseTaskOrderCounts(await rpc('care_task_order_counts', { p_task_ids: c }))))
    for (const x of res.flat()) if (x.ordersCount > 0 && x.latestCompletedAt) hits.push({ id: x.taskId, latest: x.latestCompletedAt })
  }
  // Mốc µs UTC cùng độ dài + uuid chữ thường ⇒ so chuỗi = thứ tự (latest DESC, id DESC) của RPC.
  hits.sort((x, y) => (x.latest !== y.latest ? (x.latest < y.latest ? 1 : -1) : x.id < y.id ? 1 : x.id > y.id ? -1 : 0))
  const from = (Math.max(1, page) - 1) * size
  return { pageIds: hits.slice(from, from + size).map((h) => h.id), total: hits.length }
}
