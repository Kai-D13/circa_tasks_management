'use server'

import { revalidatePath } from 'next/cache'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { cmsCalcFlags, isCmsProgramEnabled } from '@/lib/cms/flags'
import { getCmsAdminAccess } from '@/lib/cms/server/access'
import { supabaseCmsImportRepo } from '@/lib/cms/server/importRepo'
import { cmsProgramErrorLabel, isCmsUuid, normalizeCmsProgramInput } from '@/lib/cms/programInput'
import { cmsLoadProgramBasis, cmsProgramModesPath, getCmsCapabilityState } from '@/lib/cms/server/capabilities'
import { CMS_BASIS_PLAN_LABELS, cmsPlanActivate, cmsPlanProgramSave, type CmsBasisEnv } from '@/lib/cms/programBasisPlan'
import type { CmsProgramBasis } from '@/lib/cms/calc/basisUi'

// CMS P1-b — tạo / sửa thông tin / kích hoạt chương trình (SPEC §4.7). Không có xoá / huỷ / về nháp (H8).
// Thứ tự: cờ CMS_PROGRAM_ENABLED → super admin từ session → chuẩn hoá đầu vào → namespace QA (H9b: chương trình test chỉ
// với người có marker) → RPC service role 121 (kiểm lại trạng thái / ngày VN / trùng ProductID trong transaction).
// is_test khi tạo = marker QA của người tạo (server quyết, client không gửi được); không đổi về sau (trigger 120).
// CMS-CALC-RET-2 P5.1: cách tính lượng (quantity_basis) gửi kèm input khi cờ CMS_CALC_MODES_ENABLED + DB có đường program_modes ⇒
// rpc_cms_program_save_v2 (bắt buộc chọn; đã kích hoạt không đổi). Cờ OFF / DB trước 130 ⇒ RPC 121 như cũ (programBasisPlan).

export type CmsActionResult =
  | { ok: true; id: string; started?: boolean; ended?: boolean }
  | { ok: false; error: string; code?: string }

// 55P03 = lock_timeout của RPC 121 (phiên khác đang giữ khoá) ⇒ BUSY.
const rpcCode = (error: { code?: string; message?: string } | null) =>
  error?.code === '55P03' ? 'BUSY' : /CMS_[A-Z_]+/.exec(String(error?.message ?? ''))?.[0] ?? ''
const REVALIDATE = '/targets/campaigns/cms'
const label = (code: string) => (CMS_BASIS_PLAN_LABELS as Record<string, string>)[code] ?? cmsProgramErrorLabel(code)
const failCode = (code: string): CmsActionResult => ({ ok: false, error: label(code), code })

async function basisEnv(): Promise<CmsBasisEnv> {
  const s = await getCmsCapabilityState()
  return { modesOn: cmsCalcFlags().modes, caps: s.kind, modesPath: cmsProgramModesPath(s) }
}

/** Cách tính hiện tại (chỉ khi DB có đường program_modes); null = đọc lỗi / dòng lạ. */
async function currentBasis(env: CmsBasisEnv, id: string): Promise<CmsProgramBasis | null | undefined> {
  if (env.caps !== 'ok' || !env.modesPath) return undefined
  const r = await cmsLoadProgramBasis([id])
  return r.ok ? r.data.get(id) ?? null : null
}

/** Lấy cách tính client gửi (tách khỏi input 121 — normalizeCmsProgramInput không nhận khoá lạ). */
const inputBasisOf = (input: unknown): unknown =>
  input && typeof input === 'object' ? (input as Record<string, unknown>).quantity_basis : undefined

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
  const env = await basisEnv()
  const plan = cmsPlanProgramSave(env, { inputBasis: inputBasisOf(input) })
  if (plan.kind === 'error') return failCode(plan.code)
  const p = { ...v.value, is_test: g.qa, actor: g.actorId }
  const { data, error } = plan.kind === 'v2'
    ? await supabaseAdmin.rpc('rpc_cms_program_save_v2', { p: { ...p, quantity_basis: plan.basis } })
    : await supabaseAdmin.rpc('rpc_cms_program_save', { p })
  if (error || typeof data !== 'string') {
    const code = rpcCode(error)
    return { ok: false, error: label(code), code: code || undefined }
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
  const env = await basisEnv()
  const inputBasis = inputBasisOf(input)
  let current: CmsProgramBasis | null | undefined
  let status: 'draft' | 'active' | 'locked' | undefined
  if (inputBasis !== undefined && inputBasis !== null && env.modesOn) {
    current = await currentBasis(env, id as string)
    if (current === null) return failCode('CMS_CAPS_UNAVAILABLE')
    const prog = await supabaseCmsImportRepo.getProgram(id as string).catch(() => null)
    if (!prog) return failCode('CMS_CAPS_UNAVAILABLE')
    status = prog.status
  }
  const plan = cmsPlanProgramSave(env, { inputBasis, current, status })
  if (plan.kind === 'error') return failCode(plan.code)
  const p = { ...v.value, id, actor: g.actorId }
  const { data, error } = plan.kind === 'v2'
    ? await supabaseAdmin.rpc('rpc_cms_program_save_v2', { p: { ...p, quantity_basis: plan.basis } })
    : await supabaseAdmin.rpc('rpc_cms_program_save', { p })
  if (error || typeof data !== 'string') {
    const code = rpcCode(error)
    return { ok: false, error: label(code), code: code || undefined }
  }
  revalidatePath(REVALIDATE)
  return { ok: true, id: data }
}

export async function activateCmsProgram(id: unknown): Promise<CmsActionResult> {
  const g = await guard()
  if (!g.ok) return g.res
  if (!(await visible(id, g.qa))) return { ok: false, error: cmsProgramErrorLabel('CMS_PROGRAM_NOT_FOUND'), code: 'CMS_PROGRAM_NOT_FOUND' }
  const env = await basisEnv()
  const prog = await supabaseCmsImportRepo.getProgram(id as string).catch(() => null)
  if (!prog) return failCode('CMS_CAPS_UNAVAILABLE')
  const plan = cmsPlanActivate(env, { current: await currentBasis(env, id as string), status: prog.status })
  if (!plan.ok) return failCode(plan.code)
  const { data, error } = await supabaseAdmin.rpc('rpc_cms_program_activate', { p_program_id: id, p_actor: g.actorId })
  if (error || !data || typeof data !== 'object') {
    const code = rpcCode(error)
    return { ok: false, error: label(code), code: code || undefined }
  }
  const r = data as { program_id?: string; started?: boolean; ended?: boolean }
  revalidatePath(REVALIDATE)
  return { ok: true, id: String(r.program_id ?? id), started: r.started === true, ended: r.ended === true }
}
