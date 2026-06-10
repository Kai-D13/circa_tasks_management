'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isSuperAdminEmail, getSmStoreIds, smHasStore } from '@/lib/authz'

export async function createUser(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  const isSm = profile?.role === 'sm'
  if (profile?.role !== 'admin' && !isSm) return { error: 'Only admins can create users' }

  const storeId = formData.get('store_id') as string
  const role    = formData.get('role') as string

  if (isSm) {
    // SM: can only create staff in their assigned stores
    if (role !== 'staff') return { error: 'SM chỉ được tạo tài khoản Nhân viên' }
    if (!storeId) return { error: 'Vui lòng chọn cửa hàng cho nhân viên' }
    const smStoreIds = await getSmStoreIds(supabase, user.id)
    if (!smHasStore(smStoreIds, storeId)) return { error: 'Bạn không quản lý cửa hàng này' }
  } else {
    // Sub-admins may only create store managers. The super admin may create any
    // role (staff / store_manager / admin).
    if (!isSuperAdminEmail(user.email) && role !== 'store_manager')
      return { error: 'Bạn chỉ được tạo tài khoản Quản lý cửa hàng' }
    if (role !== 'admin' && !storeId)
      return { error: 'Tài khoản Quản lý và Nhân viên phải được gán cửa hàng' }
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email:         formData.get('email') as string,
    password:      formData.get('password') as string,
    email_confirm: true,
    user_metadata: {
      full_name: formData.get('full_name') as string,
      role:      formData.get('role') as string,
      store_id:  storeId || null,
    },
  })

  if (error) return { error: error.message }

  revalidatePath('/users')
  return { success: true, userId: data.user?.id }
}

export async function resetUserPassword(userId: string, newPassword: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Chưa đăng nhập' }

  const { data: profile } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'admin') return { error: 'Không có quyền thực hiện' }
  if (newPassword.length < 8) return { error: 'Mật khẩu phải có ít nhất 8 ký tự' }
  // Sub-admins cannot reset anyone's password — only the super admin may do this.
  if (!isSuperAdminEmail(user.email))
    return { error: 'Chỉ super admin mới đặt lại được mật khẩu người dùng' }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: newPassword })
  if (error) return { error: error.message }

  return { success: true }
}

export async function changeOwnPassword(newPassword: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Chưa đăng nhập' }
  if (newPassword.length < 8) return { error: 'Mật khẩu phải có ít nhất 8 ký tự' }
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) return { error: error.message }
  return { success: true }
}

export async function updateUserRole(userId: string, role: string, storeId: string | null) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'admin') return { error: 'Only admins can update roles' }
  // Only the super admin may edit any user — sub-admins can create store managers
  // but cannot edit or change roles for anyone.
  if (!isSuperAdminEmail(user.email))
    return { error: 'Chỉ super admin mới chỉnh sửa được tài khoản người dùng' }

  // SM scopes via sm_store_assignments, not a single store_id — exempt it (and
  // admin) from the single-store requirement and always null their store_id.
  if (role !== 'admin' && role !== 'sm' && !storeId)
    return { error: 'Tài khoản Quản lý và Nhân viên phải được gán cửa hàng' }

  const effectiveStoreId = (role === 'admin' || role === 'sm') ? null : storeId

  const { error } = await supabase
    .from('users')
    .update({ role, store_id: effectiveStoreId })
    .eq('id', userId)

  if (error) return { error: error.message }

  // If the user is no longer an SM, drop any store assignments so a future
  // re-promotion doesn't silently inherit stale scope.
  if (role !== 'sm') {
    await supabaseAdmin.from('sm_store_assignments').delete().eq('sm_user_id', userId)
  }

  revalidatePath('/users')
  return { success: true }
}

// Read a user's SM store assignments (for the edit dialog). Admins may read via
// RLS ssa_select_admin; returns the assigned store IDs.
export async function getSmStores(userId: string): Promise<string[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []
  const { data } = await supabase
    .from('sm_store_assignments')
    .select('store_id')
    .eq('sm_user_id', userId)
  return (data ?? []).map((r: { store_id: string }) => r.store_id)
}

// Promote a user to SM AND set their store assignments in one call. Super-admin
// only. Combining the two mutations avoids the partial state where a user becomes
// 'sm' with no stores (and thus an empty SM view). All store IDs are validated
// BEFORE any write so the replace (delete + insert) cannot fail mid-way on a bad
// FK. Writes go through supabaseAdmin (no RLS write policy for SM assignments)
// and stamp assigned_by for audit. storeIds = the complete desired set.
export async function setSmRole(userId: string, storeIds: string[]) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  if (!isSuperAdminEmail(user.email))
    return { error: 'Chỉ super admin mới gán quyền SM' }

  const unique = [...new Set(storeIds)].filter(Boolean)
  if (unique.length === 0)
    return { error: 'Chọn ít nhất 1 cửa hàng cho tài khoản SM' }

  // Validate every store exists up front so the insert below (after the delete)
  // can never fail on an invalid FK and strand the user with no assignments.
  const { data: validStores } = await supabaseAdmin
    .from('stores').select('id').in('id', unique)
  if ((validStores?.length ?? 0) !== unique.length)
    return { error: 'Có cửa hàng không hợp lệ trong danh sách' }

  // 1) Promote to SM. store_id is null — SM scope lives in sm_store_assignments.
  const { error: roleErr } = await supabaseAdmin
    .from('users').update({ role: 'sm', store_id: null }).eq('id', userId)
  if (roleErr) return { error: roleErr.message }

  // 2) Replace assignments with the validated set.
  const { error: delErr } = await supabaseAdmin
    .from('sm_store_assignments').delete().eq('sm_user_id', userId)
  if (delErr) return { error: delErr.message }

  const rows = unique.map((sid) => ({ sm_user_id: userId, store_id: sid, assigned_by: user.id }))
  const { error: insErr } = await supabaseAdmin.from('sm_store_assignments').insert(rows)
  if (insErr) return { error: insErr.message }

  revalidatePath('/users')
  return { success: true }
}
