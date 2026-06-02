'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { canAdminManageOwn } from '@/lib/authz'

// ── helpers ────────────────────────────────────────────────────────────────────

async function requireTaskOwner(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  userEmail: string | null | undefined,
  userRole: string | null | undefined,
  taskId: string,
): Promise<{ error: string } | { taskTitle: string; createdBy: string }> {
  const { data: task } = await supabase
    .from('tasks').select('created_by, title').eq('id', taskId).single()
  if (!task) return { error: 'Task không tồn tại' }
  if (!task.created_by) return { error: 'Task không có người tạo' }
  if (!canAdminManageOwn({ email: userEmail, role: userRole, createdBy: task.created_by, userId }))
    return { error: 'Chỉ admin tạo task hoặc super admin mới chia sẻ được' }
  return { taskTitle: task.title, createdBy: task.created_by }
}

// ── shareTask ──────────────────────────────────────────────────────────────────

export async function shareTask(
  taskId: string,
  adminId: string,
  permission: 'view' | 'editor',
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const check = await requireTaskOwner(supabase, user.id, user.email, profile?.role, taskId)
  if ('error' in check) return check

  // Prevent sharing with self, the task owner, or a non-admin
  if (adminId === user.id) return { error: 'Không thể chia sẻ task với chính mình' }
  if (adminId === check.createdBy) return { error: 'Người tạo task đã có toàn quyền' }
  const { data: target } = await supabase.from('users').select('role, full_name').eq('id', adminId).single()
  if (!target) return { error: 'Người dùng không tồn tại' }
  if (target.role !== 'admin') return { error: 'Chỉ chia sẻ được với tài khoản admin' }

  // invited_by must equal task.created_by so the task owner can always see
  // their own shares via `tc_select` (invited_by = auth.uid()), even when
  // the super admin performs the share on their behalf.
  const { error } = await supabase.from('task_collaborators').upsert(
    { task_id: taskId, admin_id: adminId, permission, invited_by: check.createdBy },
    { onConflict: 'task_id,admin_id' },
  )
  if (error) return { error: error.message }

  // Notify the invited admin
  await supabaseAdmin.from('notifications').insert({
    user_id: adminId,
    type:    'task_shared',
    task_id: taskId,
    title:   'Task được chia sẻ với bạn',
    message: `"${check.taskTitle}" — quyền: ${permission === 'editor' ? 'Biên tập' : 'Xem'}`,
  })

  revalidatePath(`/tasks/${taskId}`)
  return { success: true }
}

// ── updateCollaboratorPermission ───────────────────────────────────────────────

export async function updateCollaboratorPermission(
  taskId: string,
  adminId: string,
  permission: 'view' | 'editor',
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const check = await requireTaskOwner(supabase, user.id, user.email, profile?.role, taskId)
  if ('error' in check) return check

  const { error } = await supabase
    .from('task_collaborators')
    .update({ permission })
    .eq('task_id', taskId)
    .eq('admin_id', adminId)
  if (error) return { error: error.message }

  revalidatePath(`/tasks/${taskId}`)
  return { success: true }
}

// ── removeCollaborator ─────────────────────────────────────────────────────────

export async function removeCollaborator(taskId: string, adminId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const check = await requireTaskOwner(supabase, user.id, user.email, profile?.role, taskId)
  if ('error' in check) return check

  const { error } = await supabase
    .from('task_collaborators')
    .delete()
    .eq('task_id', taskId)
    .eq('admin_id', adminId)
  if (error) return { error: error.message }

  revalidatePath(`/tasks/${taskId}`)
  return { success: true }
}
