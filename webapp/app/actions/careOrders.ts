'use server'

import { createClient } from '@/lib/supabase/server'
import { isCareEnabled, isCareOrderLinksUiEnabled } from '@/lib/care/flags'
import type { CareConversionRow, CareImportOrderRow, CareTaskOrder } from '@/lib/care/orderLinks/view'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import { CareOrderCursorError, loadConversionList, loadImportOrderList, loadMyOrderTaskIds, loadTaskOrders, type CareOrderListFilter } from '@/lib/care/server/orderLinks'
import { getCareStaffAccess, loadMyTasksByIds, type CareMyTaskRow } from '@/lib/care/server/my'
import { getCareViewAccess } from '@/lib/care/server/browse'
import { careQaViewerAllowed } from '@/lib/care/server/qaUi'

// CRM-CSKH E3 — "Xem thêm" đơn xác thực sau import (POST; cursor ký HMAC — không vào URL). Mỗi lần: cờ CARE_ENABLED +
// CARE_ORDER_LINKS_UI_ENABLED → người dùng phiên (+ cổng QA local như trang) → RPC 116 bằng SESSION (vị từ READ là chốt cuối).
// Danh sách /care/orders: thêm quyền xem CRM (canView — như requireCareViewer của trang). Không service role.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])-01$/
type Fail = { ok: false; message: string }

async function sessionUser(): Promise<string | null> {
  if (!isCareEnabled() || !isCareOrderLinksUiEnabled()) return null
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  const id = data.user?.id ?? null
  return id && (await careQaViewerAllowed(id)) ? id : null
}
/** Người xem danh sách /care/orders (super / care admin / SM có vùng) — cùng điều kiện trang. */
async function listViewer(): Promise<string | null> {
  if (!isCareEnabled() || !isCareOrderLinksUiEnabled()) return null
  const v = await getCareViewAccess()
  return v.kind === 'ok' && v.perms.canView ? v.userId : null
}
const filterOf = (f: unknown): CareOrderListFilter | null => {
  const x = f as Record<string, unknown> | null
  if (!x || typeof x.month !== 'string' || !MONTH_RE.test(x.month)) return null
  const id = (v: unknown) => (v === null || v === undefined || v === '' ? null : typeof v === 'string' && UUID_RE.test(v) ? v : undefined)
  const storeId = id(x.storeId), assigneeId = id(x.assigneeId)
  return storeId === undefined || assigneeId === undefined ? null : { month: x.month, storeId, assigneeId }
}

export async function loadMoreTaskOrders(input: { taskId: string; cursor: string }): Promise<{ ok: true; orders: CareTaskOrder[]; next: string | null } | Fail> {
  const u = await sessionUser()
  if (!u) return { ok: false, message: 'Không có quyền xem.' }
  if (typeof input?.taskId !== 'string' || !UUID_RE.test(input.taskId) || typeof input.cursor !== 'string') return { ok: false, message: 'Yêu cầu không hợp lệ.' }
  try {
    const r = await loadTaskOrders(u, input.taskId, input.cursor)
    return r.view.found ? { ok: true, orders: r.view.orders, next: r.next } : { ok: false, message: 'Không còn quyền xem khách này — tải lại trang.' }
  } catch {
    return { ok: false, message: 'Không tải được đơn — tải lại trang.' }
  }
}

export async function loadMoreImportOrders(input: { filter: CareOrderListFilter; cursor: string }): Promise<{ ok: true; rows: CareImportOrderRow[]; next: string | null } | Fail> {
  const u = await listViewer()
  const f = filterOf(input?.filter)
  if (!u) return { ok: false, message: 'Không có quyền xem.' }
  if (!f || typeof input.cursor !== 'string') return { ok: false, message: 'Yêu cầu không hợp lệ.' }
  try {
    const r = await loadImportOrderList(u, f, input.cursor)
    return { ok: true, rows: r.list.rows, next: r.next }
  } catch {
    return { ok: false, message: 'Không tải được danh sách — tải lại trang.' }
  }
}

export async function loadMoreConversion(input: { filter: CareOrderListFilter; cursor: string }): Promise<{ ok: true; rows: CareConversionRow[]; next: string | null } | Fail> {
  const u = await listViewer()
  const f = filterOf(input?.filter)
  if (!u) return { ok: false, message: 'Không có quyền xem.' }
  if (!f || typeof input.cursor !== 'string') return { ok: false, message: 'Yêu cầu không hợp lệ.' }
  try {
    const r = await loadConversionList(u, f, input.cursor)
    return { ok: true, rows: r.list.rows, next: r.next }
  } catch {
    return { ok: false, message: 'Không tải được danh sách — tải lại trang.' }
  }
}

/** "Xem thêm" của chip "Có đơn xác thực" (/care/my, E3 r1.1): dược sĩ OS như trang (getCareStaffAccess gồm cổng QA local); thẻ đọc qua RLS. */
export async function loadMoreMyOrderTasks(input: { cursor: string }): Promise<{ ok: true; rows: CareMyTaskRow[]; next: string | null } | Fail> {
  if (!isCareEnabled() || !isCareOrderLinksUiEnabled()) return { ok: false, message: 'Không có quyền xem.' }
  const a = await getCareStaffAccess()
  if (a.kind !== 'ok') return { ok: false, message: 'Không có quyền xem.' }
  if (typeof input?.cursor !== 'string' || !input.cursor) return { ok: false, message: 'Yêu cầu không hợp lệ.' }
  const now = new Date()
  const period = carePeriodOf(now)
  try {
    const o = await loadMyOrderTaskIds(a.userId, period, input.cursor)
    return { ok: true, rows: await loadMyTasksByIds(a, period, o.taskIds, vnDateISO(now)), next: o.next }
  } catch (e) {
    return { ok: false, message: e instanceof CareOrderCursorError ? 'Danh sách đã đổi (sang tháng mới hoặc phiên khác) — tải lại trang.' : 'Không tải được danh sách — tải lại trang.' }
  }
}
