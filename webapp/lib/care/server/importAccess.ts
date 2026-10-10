import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type { CareImportAccess } from '@/lib/care/import/handler'
import { careQaViewerAllowed } from './qaUi'

// Quyền import CRM lấy từ SESSION thật (SPEC B2 §2). Nguồn sự thật là RPC
// `care_my_access()` của migration 114: super theo allowlist DB (is_super_admin)
// HOẶC admin phòng có care_access.can_import. Không tin role/phòng từ client.
// RPC lỗi (vd DB chưa có 114) ⇒ 'unavailable' (503) — fail-closed, không đoán quyền.
export async function getCareImportAccess(): Promise<CareImportAccess> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { kind: 'anonymous' }
  // B6-qa-ui: QA local chỉ tài khoản QA trong marker, request từ loopback (production luôn qua).
  if (!(await careQaViewerAllowed(user.id))) return { kind: 'forbidden' }
  const { data, error } = await supabase.rpc('care_my_access')
  if (error || !data || typeof data !== 'object') return { kind: 'unavailable' }
  const a = data as { can_import?: unknown; role?: unknown }
  // Q-76/77: QLCH không tham gia CRM (SQL đã trả can_import=false; chặn thêm ở app).
  return a.can_import === true && a.role !== 'store_manager'
    ? { kind: 'ok', actorId: user.id }
    : { kind: 'forbidden' }
}
