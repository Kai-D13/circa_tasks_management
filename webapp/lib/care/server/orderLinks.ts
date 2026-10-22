import 'server-only'
import { createHash } from 'node:crypto'
import { createClient } from '@/lib/supabase/server'
import { isCareOrderLinksUiEnabled } from '@/lib/care/flags'
import { signCareCursor, verifyCareCursor } from '@/lib/care/orderLinks/cursor'
import { CareOrderCursorError, myOrderSearchPage, myOrderTaskPage, type CareOrderRpc } from '@/lib/care/orderLinks/my'
import {
  parseConversionList, parseImportOrderList, parseImportOrderState, parseMyOrderSummary, parseTaskOrders,
  type CareConversionList, type CareImportOrderList, type CareImportOrderState, type CareMyOrderSummary, type CareTaskOrdersView,
} from '@/lib/care/orderLinks/view'
import { careDataScope } from './qaUi'

// CRM-CSKH E3 — đọc "đơn xác thực sau import" bằng SESSION người xem (RPC 116 DEFINER, vị từ READ = policy care_tasks_select).
// Không service role. Cursor keyset ký HMAC gắn user + ngữ cảnh (lib/care/orderLinks/cursor.ts); khoá dẫn xuất từ secret
// server sẵn có (không thêm env), đổi secret chỉ làm cursor cũ hết hiệu lực.

export { CareOrderCursorError }

export const careOrderLinksUiOn = () => isCareOrderLinksUiEnabled()

function cursorKey(): string {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!k) throw new Error('care_cursor_key_missing')
  return createHash('sha256').update(`care-order-cursor-key/v1:${k}`).digest('hex')
}
/** QA local: chỉ task is_test của batch marker; production: NOT is_test (careDataScope). */
const qaBatchId = (): string | null => { const s = careDataScope(); return s.kind === 'qa' ? s.batchId : null }
const after = (userId: string, ctx: string, cursor: string | null | undefined) => {
  if (!cursor) return null
  const v = verifyCareCursor(cursorKey(), cursor, { u: userId, c: ctx })
  if (!v) throw new CareOrderCursorError()
  return v
}

export async function loadTaskOrders(userId: string, taskId: string, cursor?: string | null): Promise<{ view: CareTaskOrdersView; next: string | null }> {
  const ctx = `task:${taskId}`
  const a = after(userId, ctx, cursor)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('care_task_orders', {
    p_task_id: taskId, p_after_ordered_at: a?.a ?? null, p_after_link_id: a ? Number(a.b) : null, p_limit: 20,
  })
  if (error) throw new Error('care_task_orders_failed')
  const view = parseTaskOrders(data)
  const last = view.found ? view.orders.at(-1) : undefined
  const next = view.found && view.hasMore && last ? signCareCursor(cursorKey(), { u: userId, c: ctx, a: last.completedAt, b: String(last.linkId) }) : null
  return { view, next }
}

export interface CareOrderListFilter { month: string; storeId: string | null; assigneeId: string | null }
const listCtx = (kind: string, f: CareOrderListFilter) => `${kind}:${f.month}|${f.storeId ?? ''}|${f.assigneeId ?? ''}|${qaBatchId() ?? ''}`

export async function loadImportOrderList(userId: string, f: CareOrderListFilter, cursor?: string | null): Promise<{ list: CareImportOrderList; next: string | null }> {
  const ctx = listCtx('import', f)
  const a = after(userId, ctx, cursor)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('care_import_order_list', {
    p_month: f.month, p_store_ids: f.storeId ? [f.storeId] : null, p_assignee_ids: f.assigneeId ? [f.assigneeId] : null,
    p_qa_batch_id: qaBatchId(), p_after_latest: a?.a ?? null, p_after_task_id: a?.b ?? null, p_limit: 20,
  })
  if (error) throw new Error('care_import_order_list_failed')
  const list = parseImportOrderList(data)
  const last = list.rows.at(-1)
  return { list, next: list.hasMore && last ? signCareCursor(cursorKey(), { u: userId, c: ctx, a: last.latestCompletedAt, b: last.taskId }) : null }
}

export async function loadConversionList(userId: string, f: CareOrderListFilter, cursor?: string | null): Promise<{ list: CareConversionList; next: string | null }> {
  const ctx = listCtx('care', f)
  const a = after(userId, ctx, cursor)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('care_report_conversion_list', {
    p_month: f.month, p_store_ids: f.storeId ? [f.storeId] : null, p_assignee_ids: f.assigneeId ? [f.assigneeId] : null,
    p_include_test: false, p_after_latest: a?.a ?? null, p_after_task_id: a?.b ?? null, p_limit: 20,
  })
  if (error) throw new Error('care_report_conversion_list_failed')
  const list = parseConversionList(data)
  const last = list.rows.at(-1)
  return { list, next: list.hasMore && last ? signCareCursor(cursorKey(), { u: userId, c: ctx, a: last.latestCompletedAt, b: last.taskId }) : null }
}

export async function loadImportOrderState(month: string): Promise<CareImportOrderState | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('care_import_order_state', { p_month: month })
  if (error) throw new Error('care_import_order_state_failed')
  return parseImportOrderState(data)
}

export async function loadMyOrderSummary(): Promise<CareMyOrderSummary | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('care_my_order_summary', { p_qa_batch_id: qaBatchId() })
  if (error) throw new Error('care_my_order_summary_failed')
  return parseMyOrderSummary(data)
}

/** RPC 116 bằng session; lỗi PostgREST ⇒ ném (không trả rỗng giả). */
async function sessionRpc(): Promise<CareOrderRpc> {
  const supabase = await createClient()
  return async (fn, args) => {
    const { data, error } = await supabase.rpc(fn, args)
    if (error) throw new Error(`${fn}_failed`)
    return data
  }
}

/** /care/my?filter=orders — task kỳ hiện tại của mình có ≥ 1 đơn, mới nhất trước; 20 / trang, "Xem thêm" bằng cursor ký
 *  (gắn user + kỳ + phạm vi QA). Đọc chi tiết thẻ qua RLS ở caller (loadMyTasksByIds). */
export async function loadMyOrderTaskIds(userId: string, period: string, cursor?: string | null): Promise<{ taskIds: string[]; next: string | null }> {
  return myOrderTaskPage(await sessionRpc(), cursorKey(), userId, period, qaBatchId(), cursor)
}

/** Tìm trong nhóm "Có đơn xác thực": `ids` = task của mình khớp tên / SĐT (caller đọc RLS) ∩ có ≥ 1 đơn; trang theo số. */
export async function pickMyOrderSearchPage(ids: readonly string[], page: number): Promise<{ pageIds: string[]; total: number }> {
  return myOrderSearchPage(await sessionRpc(), ids, page)
}
