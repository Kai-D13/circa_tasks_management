import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type { CareImportAccess } from '@/lib/care/import/handler'
import { carePermissions, type CareAccess } from '@/lib/care/browse'
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
  const a = data as { can_import?: unknown; role?: unknown; is_super?: unknown; can_view_all?: unknown; scope_store_count?: unknown }
  // B8.3: cùng kết quả RPC ⇒ biết có quyền xem /care/tasks (phòng chỉ-import thì không hiện link). Chuẩn hoá
  // như getCareViewAccess — chỉ quyết định UI, quyền thật của /care/tasks vẫn ở trang đó + RLS.
  const access: CareAccess = {
    role: typeof a.role === 'string' ? a.role : null,
    is_super: a.is_super === true,
    can_import: a.can_import === true,
    can_view_all: a.can_view_all === true,
    scope_store_count: typeof a.scope_store_count === 'number' ? a.scope_store_count : 0,
  }
  // Q-76/77: QLCH không tham gia CRM (SQL đã trả can_import=false; chặn thêm ở app).
  return a.can_import === true && a.role !== 'store_manager'
    ? { kind: 'ok', actorId: user.id, canView: carePermissions(access).canView }
    : { kind: 'forbidden' }
}
