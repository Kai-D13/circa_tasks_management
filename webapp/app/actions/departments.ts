'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isSuperAdminEmail } from '@/lib/authz'
import { DEPARTMENT_COLOR_KEYS } from '@/lib/departments'

// Department management is super-admin only — mirrors the dept_write RLS
// policy (migration 050). Departments are labels; they never change task or
// user permissions.

async function requireSuperAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' as const }
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin' || !isSuperAdminEmail(user.email))
    return { error: 'Chỉ super admin mới quản lý được phòng ban' as const }
  return { supabase, user }
}

function validateName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Tên phòng ban không được để trống'
  if (trimmed.length > 50) return 'Tên phòng ban tối đa 50 ký tự'
  return null
}

export async function createDepartment(name: string, color: string) {
  const ctx = await requireSuperAdmin()
  if ('error' in ctx) return ctx
  const nameErr = validateName(name)
  if (nameErr) return { error: nameErr }
  if (!DEPARTMENT_COLOR_KEYS.includes(color as never)) return { error: 'Màu không hợp lệ' }

  const { error } = await ctx.supabase
    .from('departments')
    .insert({ name: name.trim(), color })
  if (error) {
    if (error.code === '23505') return { error: 'Phòng ban này đã tồn tại' }
    return { error: error.message }
  }
  revalidatePath('/users')
  return { success: true }
}

export async function updateDepartment(id: string, name: string, color: string) {
  const ctx = await requireSuperAdmin()
  if ('error' in ctx) return ctx
  const nameErr = validateName(name)
  if (nameErr) return { error: nameErr }
  if (!DEPARTMENT_COLOR_KEYS.includes(color as never)) return { error: 'Màu không hợp lệ' }

  const { error } = await ctx.supabase
    .from('departments')
    .update({ name: name.trim(), color })
    .eq('id', id)
  if (error) {
    if (error.code === '23505') return { error: 'Phòng ban này đã tồn tại' }
    return { error: error.message }
  }
  revalidatePath('/users')
  revalidatePath('/tasks')
  return { success: true }
}

// Deleting a department whose FK rows would be SET NULL silently erases the
// audit trail ("task này thuộc phòng ban nào tạo"). Block the delete while the
// department is still referenced by users OR tasks — rename it instead.
export async function deleteDepartment(id: string) {
  const ctx = await requireSuperAdmin()
  if ('error' in ctx) return ctx

  const [
    { count: memberCount, error: memberErr },
    { count: taskCount, error: taskErr },
  ] = await Promise.all([
    ctx.supabase.from('users').select('id', { count: 'exact', head: true }).eq('department_id', id),
    ctx.supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('department_id', id),
  ])
  // A failed count must BLOCK the delete — a transient error returning null
  // counts would otherwise let an in-use department slip through and erase
  // the audit tags via the FK SET NULL.
  if (memberErr) return { error: `Không kiểm tra được thành viên: ${memberErr.message}` }
  if (taskErr)   return { error: `Không kiểm tra được task gắn nhãn: ${taskErr.message}` }
  if ((memberCount ?? 0) > 0)
    return { error: `Phòng ban còn ${memberCount} thành viên — gỡ thành viên trước khi xóa` }
  if ((taskCount ?? 0) > 0)
    return { error: `Phòng ban đã gắn nhãn ${taskCount} task — không thể xóa (hãy đổi tên nếu cần)` }

  const { error } = await ctx.supabase.from('departments').delete().eq('id', id)
  if (error) return { error: error.message }
  revalidatePath('/users')
  revalidatePath('/tasks')
  return { success: true }
}

// Assign/unassign a user's department. Writes via supabaseAdmin because the
// users UPDATE RLS does not cover cross-user profile edits (same pattern as
// updateUserRole). Tag on FUTURE tasks only — old tasks keep their stamp.
export async function setUserDepartment(userId: string, departmentId: string | null) {
  const ctx = await requireSuperAdmin()
  if ('error' in ctx) return ctx

  if (departmentId) {
    const { data: dept } = await ctx.supabase
      .from('departments').select('id').eq('id', departmentId).single()
    if (!dept) return { error: 'Phòng ban không tồn tại' }
  }

  const { error } = await supabaseAdmin
    .from('users')
    .update({ department_id: departmentId })
    .eq('id', userId)
  if (error) return { error: error.message }

  revalidatePath('/users')
  return { success: true }
}
