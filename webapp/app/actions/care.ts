'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isCareEnabled } from '@/lib/care/flags'
import {
  CARE_TRANSFER_MESSAGES, mapCareTransferError, parseCareFilters, validateTransferInput,
  type CareInteractionPage, type CareTransferErrorCode,
} from '@/lib/care/browse'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import {
  careQaTransferBlock, getCareViewAccess, loadCareInteractionsPage, loadCareTaskPage, loadTransferTargets,
  type CareStaffOption, type CareTaskRow,
} from '@/lib/care/server/browse'

// CRM-CSKH B3 — server actions browser. Mọi action: cờ CARE_ENABLED → quyền từ
// care_my_access() (session) → làm việc bằng SESSION client (RLS/RPC 114 là chốt cuối).
// Không dùng service role ở đây.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CareTransferResult =
  | { ok: true; transferred: number }
  | { ok: false; code: CareTransferErrorCode | 'NOT_FOUND' | 'UNAVAILABLE'; message: string }

/**
 * Chuyển giao 1–500 task đang mở kỳ hiện tại sang MỘT dược sĩ, ghi chú bắt buộc.
 * Gọi RPC care_transfer_tasks bằng session: SQL dùng auth.uid() để kiểm SM nguồn+đích,
 * DNC tại đích, task open/kỳ hiện tại; lệnh nguyên tử (một task lỗi ⇒ không đổi gì).
 */
export async function transferCareTasks(input: { taskIds: string[]; toUserId: string; note: string }): Promise<CareTransferResult> {
  if (!isCareEnabled()) return { ok: false, code: 'NOT_FOUND', message: 'Chức năng chưa được bật.' }
  const v = await getCareViewAccess()
  if (v.kind === 'anonymous') return { ok: false, code: 'UNAUTHENTICATED', message: CARE_TRANSFER_MESSAGES.UNAUTHENTICATED }
  if (v.kind === 'unavailable') return { ok: false, code: 'UNAVAILABLE', message: 'Hệ thống CRM chưa sẵn sàng.' }
  if (!v.perms.canTransfer) return { ok: false, code: 'FORBIDDEN', message: CARE_TRANSFER_MESSAGES.FORBIDDEN }
  const valid = validateTransferInput(input)
  if (!valid.ok) return { ok: false, code: valid.code, message: CARE_TRANSFER_MESSAGES[valid.code] }

  // B6-qa-ui (security P1-2): QA local chỉ chuyển task của batch QA, chỉ sang dược sĩ QA trong marker —
  // RPC 114 kiểm vùng SM, không biết batch ⇒ chặn trước khi gọi. Production: luôn null.
  const qaBlock = await careQaTransferBlock(valid.taskIds, valid.toUserId)
  if (qaBlock) {
    return { ok: false, code: qaBlock, message: qaBlock === 'TARGET_INVALID' ? 'Chế độ QA: chỉ chuyển cho dược sĩ QA của lượt test.' : CARE_TRANSFER_MESSAGES[qaBlock] }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('care_transfer_tasks', {
    p_task_ids: valid.taskIds, p_to_user: valid.toUserId, p_note: valid.note,
  })
  if (error) {
    const code = mapCareTransferError(error.message)
    return { ok: false, code, message: CARE_TRANSFER_MESSAGES[code] }
  }
  revalidatePath('/care')
  revalidatePath('/care/tasks')
  const n = (data as { transferred?: number } | null)?.transferred
  return { ok: true, transferred: typeof n === 'number' ? n : valid.taskIds.length }
}

/** Danh sách dược sĩ đích (staff của store OS active trong phạm vi chuyển giao). */
export async function listCareTransferTargets(): Promise<{ ok: true; staff: CareStaffOption[] } | { ok: false; message: string }> {
  if (!isCareEnabled()) return { ok: false, message: 'Chức năng chưa được bật.' }
  const v = await getCareViewAccess()
  if (v.kind !== 'ok' || !v.perms.canTransfer) return { ok: false, message: CARE_TRANSFER_MESSAGES.FORBIDDEN }
  try {
    return { ok: true, staff: await loadTransferTargets(v.perms) }
  } catch {
    return { ok: false, message: 'Không tải được danh sách dược sĩ — thử lại.' }
  }
}

/**
 * "Xem thêm" lịch sử lượt chăm sóc (Q-78): 10 lượt cũ hơn `beforeId`. Kiểm lại cờ,
 * quyền xem và đọc lại task bằng SESSION mỗi lần (RLS) — không tin trạng thái trang.
 */
export async function loadMoreCareInteractions(input: { taskId: string; beforeId: number }):
  Promise<{ ok: true; page: CareInteractionPage } | { ok: false; message: string }> {
  if (!isCareEnabled()) return { ok: false, message: 'Chức năng chưa được bật.' }
  const v = await getCareViewAccess()
  if (v.kind !== 'ok' || !v.perms.canView) return { ok: false, message: 'Không có quyền xem.' }
  const before = Number(input?.beforeId)
  if (typeof input?.taskId !== 'string' || !UUID_RE.test(input.taskId) || !Number.isSafeInteger(before) || before < 1) {
    return { ok: false, message: 'Yêu cầu không hợp lệ.' }
  }
  try {
    const page = await loadCareInteractionsPage(input.taskId, before)
    return page ? { ok: true, page } : { ok: false, message: 'Không còn quyền xem khách này — tải lại trang.' }
  } catch {
    return { ok: false, message: 'Không tải được lịch sử — thử lại.' }
  }
}

/**
 * Tìm task theo tên/SĐT snapshot — qua POST (server action) để từ khoá (có thể là
 * SĐT) KHÔNG nằm trong URL/log truy cập. Filter khác lấy như URL, chỉ thu hẹp.
 */
export async function searchCareTasks(input: { params: Record<string, string>; q: string; page: number }):
  Promise<{ ok: true; rows: CareTaskRow[]; total: number } | { ok: false; message: string }> {
  if (!isCareEnabled()) return { ok: false, message: 'Chức năng chưa được bật.' }
  const v = await getCareViewAccess()
  if (v.kind !== 'ok' || !v.perms.canView) return { ok: false, message: 'Không có quyền xem.' }
  const now = new Date()
  const f = parseCareFilters({ ...input.params, page: String(input.page) }, carePeriodOf(now))
  try {
    return { ok: true, ...(await loadCareTaskPage(f, vnDateISO(now), String(input.q ?? '').slice(0, 200))) }
  } catch {
    return { ok: false, message: 'Không tải được danh sách — thử lại.' }
  }
}
