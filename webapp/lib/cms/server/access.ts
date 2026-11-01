import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdmin } from '@/lib/authz'
import type { CmsAdminAccess } from '@/lib/cms/import/handler'

// Quyền quản trị CMS (tạo / sửa / import / kích hoạt) lấy từ SESSION thật: super admin = role 'admin' + email trong
// allowlist (lib/authz.ts — cùng mẫu KPI Campaign). Marker QA (H9 / H9b) đọc qua helper SECDEF cms_has_qa_access()
// bằng session của chính người gọi (thời gian DB, user không tự cấp được). Lỗi tra cứu ⇒ 'unavailable' (fail-closed).
// Không nhận role / is_test từ client.
export async function getCmsAdminAccess(): Promise<CmsAdminAccess> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { kind: 'anonymous' }
  const { data: profile, error } = await supabase.from('users').select('role').eq('id', user.id).maybeSingle()
  if (error) return { kind: 'unavailable' }
  if (!isSuperAdmin(user.email, (profile as { role?: string } | null)?.role)) return { kind: 'forbidden' }
  const { data: qa, error: qaErr } = await supabase.rpc('cms_has_qa_access')
  if (qaErr) return { kind: 'unavailable' }
  return { kind: 'ok', actorId: user.id, qa: qa === true }
}
