'use server'

import { revalidatePath } from 'next/cache'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isCmsProgramEnabled, isCmsUnitBasisEnabled } from '@/lib/cms/flags'
import { getCmsAdminAccess } from '@/lib/cms/server/access'
import { supabaseCmsImportRepo } from '@/lib/cms/server/importRepo'
import {
  cmsProgramBasisClaim, cmsProgramErrorLabel, cmsResolveProgramBasis, isCmsUuid, normalizeCmsProgramInput,
} from '@/lib/cms/programInput'

// CMS P1-b — tạo / sửa thông tin / kích hoạt chương trình (SPEC §4.7). Không có xoá / huỷ / về nháp (H8).
// Thứ tự: cờ CMS_PROGRAM_ENABLED → super admin từ session → chuẩn hoá đầu vào → namespace QA (H9b: chương trình test chỉ
// với người có marker) → RPC service role 121 (kiểm lại trạng thái / ngày VN / trùng ProductID trong transaction).
// is_test khi tạo = marker QA của người tạo (server quyết, client không gửi được); không đổi về sau (trigger 120).
// CMS-UNIT: cơ sở tính khi tạo = server quyết theo cờ CMS_UNIT_BASIS_ENABLED (cms_unit khi bật; chỉ gửi RPC khi cms_unit — payload
// pos_base giữ nguyên hợp đồng cũ). cms_unit cần DB có 128 (probe chỉ đọc) — RPC trước 128 bỏ qua khoá lạ ⇒ không được để chương
// trình âm thầm thành pos_base. Sửa: không gửi quantity_basis (RPC giữ nguyên); client khẳng định khác cơ sở hiện tại ⇒ từ chối.

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

/** Chương trình tồn tại VÀ thuộc namespace người gọi đọc được (test chỉ khi có marker) ⇒ trả cơ sở tính; không ⇒ null. */
async function visible(id: unknown, qa: boolean): Promise<{ quantityBasis: 'pos_base' | 'cms_unit' } | null> {
  if (!isCmsUuid(id)) return null
  try {
    const p = await supabaseCmsImportRepo.getProgram(id)
    return p && (!p.isTest || qa) ? { quantityBasis: p.quantityBasis ?? 'pos_base' } : null
  } catch {
    return null
  }
}

export async function createCmsProgram(input: unknown): Promise<CmsActionResult> {
  const g = await guard()
  if (!g.ok) return g.res
  const v = normalizeCmsProgramInput(input)
  if (!v.ok) return { ok: false, error: v.error }
  const claim = cmsProgramBasisClaim(input)
  if (!claim.ok) return { ok: false, error: claim.error }
  const basis = cmsResolveProgramBasis(claim.value, { kind: 'create', unitBasisEnabled: isCmsUnitBasisEnabled() })
  if (!basis.ok) return { ok: false, error: basis.error }
  if (basis.value === 'cms_unit') {
    let capable = false
    try { capable = (await supabaseCmsImportRepo.unitBasisCapable?.()) === true } catch { capable = false }
    if (!capable) return { ok: false, error: cmsProgramErrorLabel('UNIT_BASIS_DB_UNSUPPORTED'), code: 'UNIT_BASIS_DB_UNSUPPORTED' }
  }
  const { data, error } = await supabaseAdmin.rpc('rpc_cms_program_save', {
    p: { ...v.value, is_test: g.qa, actor: g.actorId, ...(basis.value === 'cms_unit' ? { quantity_basis: 'cms_unit' } : {}) },
  })
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
  const cur = await visible(id, g.qa)
  if (!cur) return { ok: false, error: cmsProgramErrorLabel('CMS_PROGRAM_NOT_FOUND'), code: 'CMS_PROGRAM_NOT_FOUND' }
  const v = normalizeCmsProgramInput(input)
  if (!v.ok) return { ok: false, error: v.error }
  const claim = cmsProgramBasisClaim(input)
  if (!claim.ok) return { ok: false, error: claim.error }
  const basis = cmsResolveProgramBasis(claim.value, { kind: 'update', current: cur.quantityBasis })
  if (!basis.ok) return { ok: false, error: basis.error }
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
