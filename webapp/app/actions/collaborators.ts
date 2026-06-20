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

// ── shareBroadcast ─────────────────────────────────────────────────────────────
// Share ALL tasks of a broadcast (same broadcast_id) with one admin in a single
// action — avoids sharing 26 store tasks one by one. Authz mirrors shareTask
// (broadcast owner or super admin; target must be admin).
export async function shareBroadcast(
  broadcastId: string,
  adminId: string,
  permission: 'view' | 'editor',
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()

  // All tasks of the broadcast (RLS lets the owner/super read them).
  const { data: tasks, error: tasksErr } = await supabase
    .from('tasks').select('id, created_by, title').eq('broadcast_id', broadcastId)
  if (tasksErr) return { error: tasksErr.message }
  if (!tasks || tasks.length === 0) return { error: 'Không tìm thấy nhóm task (broadcast)' }

  const createdBy = tasks[0].created_by
  if (!createdBy) return { error: 'Nhóm task không có người tạo' }
  if (!canAdminManageOwn({ email: user.email, role: profile?.role, createdBy, userId: user.id }))
    return { error: 'Chỉ admin tạo nhóm task hoặc super admin mới chia sẻ được' }

  if (adminId === user.id) return { error: 'Không thể chia sẻ với chính mình' }
  if (adminId === createdBy) return { error: 'Người tạo đã có toàn quyền' }
  const { data: target } = await supabase.from('users').select('role').eq('id', adminId).single()
  if (!target) return { error: 'Người dùng không tồn tại' }
  if (target.role !== 'admin') return { error: 'Chỉ chia sẻ được với tài khoản admin' }

  // invited_by = each task's created_by (all the same for a broadcast).
  const rows = tasks.map((t) => ({
    task_id: t.id, admin_id: adminId, permission, invited_by: t.created_by as string,
  }))
  const { error } = await supabase.from('task_collaborators').upsert(rows, { onConflict: 'task_id,admin_id' })
  if (error) return { error: error.message }

  await supabaseAdmin.from('notifications').insert({
    user_id: adminId,
    type:    'task_shared',
    task_id: tasks[0].id,
    title:   'Nhóm task được chia sẻ với bạn',
    message: `"${tasks[0].title}" (${tasks.length} task) — quyền: ${permission === 'editor' ? 'Biên tập' : 'Xem'}`,
  })

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${tasks[0].id}`)
  return { success: true, count: tasks.length }
}

// ── broadcast collaborator: update permission across the whole group ────────────
export async function updateBroadcastCollaboratorPermission(
  broadcastId: string,
  adminId: string,
  permission: 'view' | 'editor',
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()

  const { data: tasks, error: tasksErr } = await supabase
    .from('tasks').select('id, created_by').eq('broadcast_id', broadcastId)
  if (tasksErr) return { error: tasksErr.message }
  if (!tasks || tasks.length === 0) return { error: 'Không tìm thấy nhóm task (broadcast)' }
  if (!canAdminManageOwn({ email: user.email, role: profile?.role, createdBy: tasks[0].created_by, userId: user.id }))
    return { error: 'Chỉ admin tạo nhóm task hoặc super admin mới đổi quyền được' }

  const { error } = await supabase
    .from('task_collaborators')
    .update({ permission })
    .in('task_id', tasks.map((t) => t.id))
    .eq('admin_id', adminId)
  if (error) return { error: error.message }

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${tasks[0].id}`)
  return { success: true, count: tasks.length }
}

// ── removeBroadcastCollaborator ────────────────────────────────────────────────
export async function removeBroadcastCollaborator(broadcastId: string, adminId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()

  const { data: tasks, error: tasksErr } = await supabase
    .from('tasks').select('id, created_by').eq('broadcast_id', broadcastId)
  if (tasksErr) return { error: tasksErr.message }
  if (!tasks || tasks.length === 0) return { error: 'Không tìm thấy nhóm task (broadcast)' }
  if (!canAdminManageOwn({ email: user.email, role: profile?.role, createdBy: tasks[0].created_by, userId: user.id }))
    return { error: 'Chỉ admin tạo nhóm task hoặc super admin mới gỡ được' }

  const { error } = await supabase
    .from('task_collaborators')
    .delete()
    .in('task_id', tasks.map((t) => t.id))
    .eq('admin_id', adminId)
  if (error) return { error: error.message }

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${tasks[0].id}`)
  return { success: true, count: tasks.length }
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
