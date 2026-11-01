'use server'

import { revalidatePath } from 'next/cache'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isCmsProgramEnabled } from '@/lib/cms/flags'
import { getCmsAdminAccess } from '@/lib/cms/server/access'
import { supabaseCmsImportRepo } from '@/lib/cms/server/importRepo'
import { cmsProgramErrorLabel, isCmsUuid, normalizeCmsProgramInput } from '@/lib/cms/programInput'

// CMS P1-b — tạo / sửa thông tin / kích hoạt chương trình (SPEC §4.7). Không có xoá / huỷ / về nháp (H8).
// Thứ tự: cờ CMS_PROGRAM_ENABLED → super admin từ session → chuẩn hoá đầu vào → namespace QA (H9b: chương trình test chỉ
// với người có marker) → RPC service role 121 (kiểm lại trạng thái / ngày VN / trùng ProductID trong transaction).
// is_test khi tạo = marker QA của người tạo (server quyết, client không gửi được); không đổi về sau (trigger 120).

export type CmsActionResult =
  | { ok: true; id: string; started?: boolean; ended?: boolean }
  | { ok: false; error: string; code?: string }

// 55P03 = lock_timeout của RPC 121 (phiên khác đang giữ khoá) ⇒ BUSY.
const rpcCode = (error: { code?: string; message?: string } | null) =>
  error?.code === '55P03' ? 'BUSY' : /CMS_[A-Z_]+/.exec(String(error?.message ?? ''))?.[0] ?? ''
const REVALIDATE = '/targets/campaigns/cms'

async function guard(): Promise<{ ok: true; actorId: string; qa: boolean } | { ok: false; res: CmsActionResult }> {
  if (!isCmsProgramEnabled()) return { ok: false, res: { ok: false, error: 'Tính năng CMS chưa được bật' } }
  const a = await getCmsAdminAccess()
  if (a.kind === 'anonymous') return { ok: false, res: { ok: false, error: 'Phiên đăng nhập đã hết hạn' } }
  if (a.kind === 'forbidden') return { ok: false, res: { ok: false, error: 'Chỉ super admin' } }
  if (a.kind === 'unavailable') return { ok: false, res: { ok: false, error: 'Không kiểm tra được quyền — thử lại sau' } }
  return { ok: true, actorId: a.actorId, qa: a.qa }
}

/** Chương trình tồn tại VÀ thuộc namespace người gọi đọc được (test chỉ khi có marker). */
async function visible(id: unknown, qa: boolean): Promise<boolean> {
  if (!isCmsUuid(id)) return false
  try {
    const p = await supabaseCmsImportRepo.getProgram(id)
    return !!p && (!p.isTest || qa)
  } catch {
    return false
  }
}

export async function createCmsProgram(input: unknown): Promise<CmsActionResult> {
  const g = await guard()
  if (!g.ok) return g.res
  const v = normalizeCmsProgramInput(input)
  if (!v.ok) return { ok: false, error: v.error }
  const { data, error } = await supabaseAdmin.rpc('rpc_cms_program_save', { p: { ...v.value, is_test: g.qa, actor: g.actorId } })
  if (error || typeof data !== 'string') {
    const code = rpcCode(error)
    return { ok: false, error: cmsProgramErrorLabel(code), code: code || undefined }
  }
  revalidatePath(REVALIDATE)
  return { ok: true, id: data }
}

export async function updateCmsProgram(id: unknown, input: unknown): Promise<CmsActionResult> {
  const g = await guard()
  if (!g.ok) return g.res
  if (!(await visible(id, g.qa))) return { ok: false, error: cmsProgramErrorLabel('CMS_PROGRAM_NOT_FOUND'), code: 'CMS_PROGRAM_NOT_FOUND' }
  const v = normalizeCmsProgramInput(input)
  if (!v.ok) return { ok: false, error: v.error }
  const { data, error } = await supabaseAdmin.rpc('rpc_cms_program_save', { p: { ...v.value, id, actor: g.actorId } })
  if (error || typeof data !== 'string') {
    const code = rpcCode(error)
    return { ok: false, error: cmsProgramErrorLabel(code), code: code || undefined }
  }
  revalidatePath(REVALIDATE)
  return { ok: true, id: data }
}

export async function activateCmsProgram(id: unknown): Promise<CmsActionResult> {
  const g = await guard()
  if (!g.ok) return g.res
  if (!(await visible(id, g.qa))) return { ok: false, error: cmsProgramErrorLabel('CMS_PROGRAM_NOT_FOUND'), code: 'CMS_PROGRAM_NOT_FOUND' }
  const { data, error } = await supabaseAdmin.rpc('rpc_cms_program_activate', { p_program_id: id, p_actor: g.actorId })
  if (error || !data || typeof data !== 'object') {
    const code = rpcCode(error)
    return { ok: false, error: cmsProgramErrorLabel(code), code: code || undefined }
  }
  const r = data as { program_id?: string; started?: boolean; ended?: boolean }
  revalidatePath(REVALIDATE)
  return { ok: true, id: String(r.program_id ?? id), started: r.started === true, ended: r.ended === true }
}
