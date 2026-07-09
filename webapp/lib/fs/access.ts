import { isSuperAdminEmail } from '@/lib/authz'
import { POLICY_DEPT_ID } from '@/lib/fs/constants'

// Who may see FS entities (FS stores, FS-store users, the FS module) inside the
// OS admin surfaces: a super admin, OR an admin of the Policy department. Every
// other admin/role is OS-only. This is the single source for the OS/FS visibility
// rule — the FS module pages + Sidebar gate on the same predicate inline; keep
// this in sync if that rule ever changes.
export function canSeeFs(p: { role?: string | null; department_id?: string | null; email?: string | null }): boolean {
  if (p.role !== 'admin') return false
  return isSuperAdminEmail(p.email) || p.department_id === POLICY_DEPT_ID
}
