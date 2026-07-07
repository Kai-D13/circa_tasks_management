'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isSuperAdminEmail, getSmStoreIds, smHasStore } from '@/lib/authz'
import { assertOsStoreIds } from '@/lib/stores/assertOsStore'

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

  // Whitelist allowed roles at the action boundary. SM must be provisioned via
  // setSmRole() so assignments are written together — creating an SM directly
  // would produce a broken SM with no store scope.
  const ALLOWED_ROLES = ['staff', 'store_manager', 'admin']
  if (!ALLOWED_ROLES.includes(role)) return { error: 'Role không hợp lệ' }

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

  // FS/OS isolation (mig 076): the generic /users flow only provisions OS-store
  // accounts. FS store_manager/staff accounts are created via the FS module.
  const osErr = await assertOsStoreIds([storeId])
  if (osErr) return { error: osErr }

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

  // Optional department label (super admin only — mirrors setUserDepartment).
  // The profile row exists by now (created from the auth metadata trigger).
  const departmentId = (formData.get('department_id') as string) || null
  if (departmentId && isSuperAdminEmail(user.email) && data.user?.id) {
    const { data: dept } = await supabase
      .from('departments').select('id').eq('id', departmentId).single()
    if (dept) {
      const { error: deptErr } = await supabaseAdmin
        .from('users').update({ department_id: departmentId }).eq('id', data.user.id)
      if (deptErr) {
        revalidatePath('/users')
        return { error: `Đã tạo user nhưng gán phòng ban lỗi: ${deptErr.message}` }
      }
    }
  }

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

// Staff self-edit of their own profile (full_name + phone_number). public.users
// writes are locked to super admin since migration 021, so this goes through the
// SECURITY DEFINER RPC update_own_profile (migration 055), which only touches
// full_name/phone_number on the caller's own row and only for role='staff'.
// Phone is optional with a light VN-format check; blank clears it.
export async function updateOwnProfile(input: { full_name: string; phone_number: string | null }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Chưa đăng nhập' }

  // Scope: staff only (matches the feature spec; the RPC also enforces this).
  const { data: me } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (me?.role !== 'staff') return { error: 'Chỉ nhân viên được tự cập nhật hồ sơ' }

  const fullName = (input.full_name ?? '').trim()
  if (!fullName) return { error: 'Vui lòng nhập họ tên' }
  if (fullName.length > 100) return { error: 'Họ tên quá dài (tối đa 100 ký tự)' }

  const phoneRaw = (input.phone_number ?? '').trim()
  let phone: string | null = null
  if (phoneRaw) {
    const compact = phoneRaw.replace(/[\s.\-()]/g, '')
    if (!/^(0|\+84)\d{9,10}$/.test(compact)) {
      return { error: 'Số điện thoại không hợp lệ (vd 0xxxxxxxxx hoặc +84xxxxxxxxx)' }
    }
    phone = compact
  }

  const { error } = await supabase.rpc('update_own_profile', { p_full_name: fullName, p_phone: phone })
  if (error) return { error: error.message }

  // Keep auth metadata's full_name in sync (createUser seeds it there).
  await supabase.auth.updateUser({ data: { full_name: fullName } })

  revalidatePath('/')
  return { success: true, full_name: fullName, phone_number: phone }
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

  // Never let the super admin change their own role. Demoting yourself out of
  // 'admin' would break public.is_super_admin() (it requires role='admin') and
  // lock the account out of super-admin powers.
  if (userId === user.id)
    return { error: 'Không thể tự đổi quyền của chính mình' }

  // SM must be provisioned via setSmRole() so the store assignments are written
  // atomically — block it on the generic path to avoid creating an SM with no
  // stores (an empty, broken SM view).
  if (role === 'sm')
    return { error: 'Để tạo SM, chọn role SM và tích cửa hàng (chức năng gán SM)' }

  if (role !== 'admin' && !storeId)
    return { error: 'Tài khoản Quản lý và Nhân viên phải được gán cửa hàng' }

  const effectiveStoreId = role === 'admin' ? null : storeId

  // FS/OS isolation (mig 076): the generic /users flow only assigns OS stores.
  const osErr = await assertOsStoreIds([effectiveStoreId])
  if (osErr) return { error: osErr }

  const { error } = await supabase
    .from('users')
    .update({ role, store_id: effectiveStoreId })
    .eq('id', userId)

  if (error) return { error: error.message }

  // Changing to any non-SM role drops stale store assignments so a future
  // re-promotion doesn't silently inherit old scope. (No-op for non-SMs.)
  const { error: delErr } = await supabaseAdmin
    .from('sm_store_assignments').delete().eq('sm_user_id', userId)
  if (delErr) return { error: delErr.message }

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
// only. Combining the two mutations into one action avoids the partial state
// where a user becomes 'sm' with no stores (an empty SM view). Store IDs and the
// target user are validated BEFORE any write so the replace (delete + insert)
// won't fail mid-way on a bad FK. The action is idempotent — re-running it
// re-sets role='sm' and replaces the assignments, so a rare transient DB error
// between the writes is fully recoverable by retrying. Writes go through
// supabaseAdmin (no RLS write policy for SM) and stamp assigned_by for audit.
export async function setSmRole(userId: string, storeIds: string[]) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  // Mirror public.is_super_admin(): must be role='admin' AND the hardcoded email.
  const { data: callerProfile } = await supabase
    .from('users').select('role').eq('id', user.id).single()
  if (callerProfile?.role !== 'admin' || !isSuperAdminEmail(user.email))
    return { error: 'Chỉ super admin mới gán quyền SM' }

  // Don't let the super admin turn themselves into an SM (would break
  // is_super_admin(), which requires role='admin').
  if (userId === user.id)
    return { error: 'Không thể tự gán quyền SM cho chính mình' }

  const unique = [...new Set(storeIds)].filter(Boolean)
  if (unique.length === 0)
    return { error: 'Chọn ít nhất 1 cửa hàng cho tài khoản SM' }

  // Target user must exist (a bad userId would otherwise no-op the update and
  // then fail the assignment insert on the FK).
  const { data: target } = await supabaseAdmin
    .from('users').select('id').eq('id', userId).single()
  if (!target) return { error: 'Không tìm thấy người dùng' }

  // Validate every store exists AND is an OS store up front (FS/OS isolation,
  // mig 076 — an SM only ever manages OS stores) so the insert below (after the
  // delete) won't fail on a bad FK / leak an FS store into SM scope.
  const smOsErr = await assertOsStoreIds(unique)
  if (smOsErr) return { error: smOsErr }

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
