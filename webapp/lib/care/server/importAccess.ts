import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type { CareImportAccess } from '@/lib/care/import/handler'

// Quyền import CRM lấy từ SESSION thật (SPEC B2 §2). Nguồn sự thật là RPC
// `care_my_access()` của migration 114: super theo allowlist DB (is_super_admin)
// HOẶC admin phòng có care_access.can_import. Không tin role/phòng từ client.
// RPC lỗi (vd DB chưa có 114) ⇒ 'unavailable' (503) — fail-closed, không đoán quyền.
export async function getCareImportAccess(): Promise<CareImportAccess> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { kind: 'anonymous' }
  const { data, error } = await supabase.rpc('care_my_access')
  if (error || !data || typeof data !== 'object') return { kind: 'unavailable' }
  return (data as { can_import?: unknown }).can_import === true
    ? { kind: 'ok', actorId: user.id }
    : { kind: 'forbidden' }
}
