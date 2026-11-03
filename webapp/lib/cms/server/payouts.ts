import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isCmsLockEnabled, isCmsQaServer } from '@/lib/cms/flags'
import { getCmsAdminAccess } from '@/lib/cms/server/access'
import { supabaseCmsImportRepo } from '@/lib/cms/server/importRepo'
import { cmsSafeErrorCode } from '@/lib/cms/server/results'
import type { CmsLockDeps } from '@/lib/cms/lockAction'
import { parseCmsPayout, type CmsPayoutDto } from '@/lib/cms/payoutView'

// CMS P3a — đọc số đã chốt bằng SESSION client qua rpc_cms_payout (123: authenticated, SECDEF lọc phạm vi HIỆN TẠI theo
// Q-208 / Q-217 + marker QA trong DB; email / program_total chỉ super). Không service role. Lỗi ⇒ mã chung, không message DB:
//   FORBIDDEN (ngoài phạm vi / QA không marker) · NOT_LOCKED (chương trình chưa chốt — không hiện 0 giả) · QUERY_FAILED.
// Deps THẬT cho lõi action chốt (lib/cms/lockAction): cờ, quyền từ session, chương trình (isTest), RPC service_role 123.

export type CmsPayoutError = 'FORBIDDEN' | 'NOT_LOCKED' | 'BAD_INPUT' | 'QUERY_FAILED'
export type CmsPayoutRead = { ok: true; data: CmsPayoutDto } | { ok: false; error: CmsPayoutError }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function cmsLoadPayout(programId: string): Promise<CmsPayoutRead> {
  if (typeof programId !== 'string' || !UUID_RE.test(programId)) return { ok: false, error: 'BAD_INPUT' }
  let raw: unknown
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.rpc('rpc_cms_payout', { p_program_id: programId })
    if (error) {
      const m = String(error.message ?? '')
      if (m.includes('CMS_RESULT_FORBIDDEN')) return { ok: false, error: 'FORBIDDEN' }
      if (m.includes('CMS_PAYOUT_NOT_LOCKED')) return { ok: false, error: 'NOT_LOCKED' }
      console.error(`[cms-payout] rpc_cms_payout QUERY_FAILED sqlstate=${cmsSafeErrorCode(error.code)}`)
      return { ok: false, error: 'QUERY_FAILED' }
    }
    raw = data
  } catch {
    console.error('[cms-payout] rpc_cms_payout TRANSPORT_FAILED')
    return { ok: false, error: 'QUERY_FAILED' }
  }
  try {
    return { ok: true, data: parseCmsPayout(raw) }
  } catch {
    console.error('[cms-payout] rpc_cms_payout DTO_INVALID')
    return { ok: false, error: 'QUERY_FAILED' }
  }
}

export const cmsLockDeps: CmsLockDeps = {
  lockEnabled: isCmsLockEnabled,
  qaReadonly: isCmsQaServer,
  access: getCmsAdminAccess,
  program: async (id) => {
    const p = await supabaseCmsImportRepo.getProgram(id)
    return p ? { isTest: p.isTest } : null
  },
  rpc: async (fn, args) => {
    const { data, error } = await supabaseAdmin.rpc(fn, args)
    return { data, error: error ? { code: error.code, message: error.message } : null }
  },
}
