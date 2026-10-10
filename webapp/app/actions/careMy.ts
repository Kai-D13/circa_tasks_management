'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isCareEnabled } from '@/lib/care/flags'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import { type CareInteractionPage } from '@/lib/care/browse'
import {
  CARE_RECORD_MESSAGES, careStaffTaskBlock, mapCareRecordError, parseMyFilters, validateInteractionInput,
  type CareMyFilter, type CareRecordErrorCode,
} from '@/lib/care/my'
import { loadCareInteractionsPage } from '@/lib/care/server/browse'
import { getCareStaffAccess, loadMyTaskPage, type CareMyTaskRow } from '@/lib/care/server/my'

// CRM-CSKH B4 — server actions màn dược sĩ. Mọi action: cờ CARE_ENABLED → dược sĩ OS
// (session) → làm việc bằng SESSION client; RPC/RLS 114 là chốt cuối. Không service role.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CareRecordResult =
  | { ok: true; status: 'open' | 'completed' }
  | { ok: false; code: CareRecordErrorCode | 'NOT_FOUND' | 'UNAVAILABLE'; message: string }

/**
 * Ghi MỘT lượt chăm sóc qua RPC care_record_interaction (session dược sĩ). Ngày/kỳ do RPC
 * quyết theo giờ VN; app chỉ kiểm sớm để báo lỗi rõ. Proof chỉ nhận URL app cấp cho
 * đúng task (RPC kiểm lại). Submit đôi: lượt kết thúc thứ hai bị RPC/unique chặn.
 */
export async function recordCareInteraction(input: {
  taskId: string; outcome: string; note: string; nextActionDate: string | null; proofUrls: string[]
}): Promise<CareRecordResult> {
  if (!isCareEnabled()) return { ok: false, code: 'NOT_FOUND', message: 'Chức năng chưa được bật.' }
  const a = await getCareStaffAccess()
  if (a.kind === 'anonymous') return { ok: false, code: 'UNAUTHENTICATED', message: CARE_RECORD_MESSAGES.UNAUTHENTICATED }
  if (a.kind !== 'ok') return { ok: false, code: 'NOT_ASSIGNEE', message: CARE_RECORD_MESSAGES.NOT_ASSIGNEE }
  if (typeof input?.taskId !== 'string' || !UUID_RE.test(input.taskId)) {
    return { ok: false, code: 'TASK_NOT_FOUND', message: CARE_RECORD_MESSAGES.TASK_NOT_FOUND }
  }
  const supabase = await createClient()
  const { data: t, error: te } = await supabase.from('care_tasks')
    .select('id, assignee_id, store_id, status, period_month, due_date').eq('id', input.taskId).maybeSingle()
  if (te) return { ok: false, code: 'UNAVAILABLE', message: 'Hệ thống CRM chưa sẵn sàng.' }
  const now = new Date()
  // Q-82: assignee + ĐÚNG store của task (store OS đang hoạt động) + task mở kỳ hiện tại.
  const block = careStaffTaskBlock(t, a, carePeriodOf(now))
  if (block || !t) return { ok: false, code: block ?? 'TASK_NOT_FOUND', message: CARE_RECORD_MESSAGES[block ?? 'TASK_NOT_FOUND'] }
  const v = validateInteractionInput(
    { outcome: input.outcome, note: input.note, nextActionDate: input.nextActionDate, proofUrls: input.proofUrls },
    { taskId: t.id as string, todayISO: vnDateISO(now), dueDate: t.due_date as string })
  if (!v.ok) return { ok: false, code: v.code, message: CARE_RECORD_MESSAGES[v.code] }

  const { data, error } = await supabase.rpc('care_record_interaction', {
    p_task_id: t.id, p_outcome: v.outcome, p_note: v.note, p_next_action_date: v.nextActionDate,
    p_proof: v.proof.length ? v.proof : null,
  })
  if (error) {
    const code = mapCareRecordError(error.message)
    return { ok: false, code, message: CARE_RECORD_MESSAGES[code] }
  }
  revalidatePath('/care/my')
  revalidatePath(`/care/my/${t.id}`)
  const status = (data as { status?: string } | null)?.status === 'completed' ? 'completed' : 'open'
  return { ok: true, status }
}

/** Tìm khách của mình theo tên/SĐT — POST, từ khoá không vào URL/log. */
export async function searchMyCareTasks(input: { filter: CareMyFilter; q: string; page: number }):
  Promise<{ ok: true; rows: CareMyTaskRow[]; total: number } | { ok: false; message: string }> {
  if (!isCareEnabled()) return { ok: false, message: 'Chức năng chưa được bật.' }
  const a = await getCareStaffAccess()
  if (a.kind !== 'ok') return { ok: false, message: 'Không có quyền xem.' }
  const f = parseMyFilters({ filter: String(input?.filter ?? ''), page: String(input?.page ?? 1) })
  const now = new Date()
  try {
    return { ok: true, ...(await loadMyTaskPage(a, carePeriodOf(now), f.filter, f.page, vnDateISO(now), String(input?.q ?? '').slice(0, 200))) }
  } catch {
    return { ok: false, message: 'Không tải được danh sách — thử lại.' }
  }
}

/** "Xem thêm" lịch sử (Q-78) cho dược sĩ — kiểm lại cờ/quyền và đọc lại task qua RLS mỗi lần. */
export async function loadMoreMyCareInteractions(input: { taskId: string; beforeId: number }):
  Promise<{ ok: true; page: CareInteractionPage } | { ok: false; message: string }> {
  if (!isCareEnabled()) return { ok: false, message: 'Chức năng chưa được bật.' }
  const a = await getCareStaffAccess()
  if (a.kind !== 'ok') return { ok: false, message: 'Không có quyền xem.' }
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
