'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isSuperAdminEmail } from '@/lib/authz'

export async function createUser(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'admin') return { error: 'Only admins can create users' }

  const storeId = formData.get('store_id') as string
  const role    = formData.get('role') as string
  if (role === 'admin' && !isSuperAdminEmail(user.email))
    return { error: 'Chỉ super admin mới tạo được tài khoản admin' }
  if (role !== 'admin' && !storeId)
    return { error: 'Tài khoản Quản lý và Nhân viên phải được gán cửa hàng' }

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

  // Only super admin may reset the password of an admin account.
  // Fail closed: if the target profile is missing/unreadable, a regular admin is blocked.
  if (!isSuperAdminEmail(user.email)) {
    const { data: target, error: targetErr } = await supabase
      .from('users').select('role').eq('id', userId).single()
    if (targetErr || !target)
      return { error: 'Không tìm thấy tài khoản người dùng' }
    if (target.role === 'admin')
      return { error: 'Chỉ super admin mới đặt lại mật khẩu cho tài khoản admin' }
  }

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

  // Only super admin may set role=admin or modify an existing admin user
  if (!isSuperAdminEmail(user.email)) {
    if (role === 'admin')
      return { error: 'Chỉ super admin mới gán được quyền admin' }
    const { data: target } = await supabase
      .from('users').select('role').eq('id', userId).single()
    if (target?.role === 'admin')
      return { error: 'Chỉ super admin mới chỉnh sửa được tài khoản admin' }
  }

  if (role !== 'admin' && !storeId)
    return { error: 'Tài khoản Quản lý và Nhân viên phải được gán cửa hàng' }

  const { error } = await supabase
    .from('users')
    .update({ role, store_id: storeId })
    .eq('id', userId)

  if (error) return { error: error.message }

  revalidatePath('/users')
  return { success: true }
}
