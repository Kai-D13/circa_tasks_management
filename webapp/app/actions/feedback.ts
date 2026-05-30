'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

// ─── createFeedbackThread ─────────────────────────────────────────────────────
// Store manager opens a new feedback thread on a task, with a required first message.
export async function createFeedbackThread(taskId: string, title: string, message: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('users').select('role, store_id, full_name').eq('id', user.id).single()
  if (profile?.role !== 'store_manager')
    return { error: 'Chỉ quản lý cửa hàng mới có thể tạo phản hồi' }
  if (!profile.store_id)
    return { error: 'Tài khoản chưa được gán cửa hàng' }

  // Verify task belongs to manager's store
  const { data: taskCheck } = await supabase
    .from('tasks').select('store_id').eq('id', taskId).single()
  if (!taskCheck) return { error: 'Task không tồn tại' }
  if (taskCheck.store_id !== profile.store_id)
    return { error: 'Task không thuộc cửa hàng của bạn' }

  const trimmedTitle   = title.trim()
  const trimmedMessage = message.trim()
  if (!trimmedTitle)   return { error: 'Tiêu đề phản hồi không được để trống' }
  if (!trimmedMessage) return { error: 'Nội dung phản hồi không được để trống' }

  const { data: thread, error } = await supabase
    .from('task_feedback_threads')
    .insert({
      task_id:    taskId,
      store_id:   profile.store_id,
      created_by: user.id,
      title:      trimmedTitle,
    })
    .select('id')
    .single()
  if (error) return { error: error.message }

  // Insert the first message; rollback the thread if it fails
  const { error: msgErr } = await supabase
    .from('task_feedback_messages')
    .insert({ thread_id: thread.id, user_id: user.id, message: trimmedMessage })
  if (msgErr) {
    await supabase.from('task_feedback_threads').delete().eq('id', thread.id)
    return { error: `Không thể lưu nội dung phản hồi: ${msgErr.message}` }
  }

  // Notify all admins
  const { data: admins } = await supabase
    .from('users').select('id').eq('role', 'admin')
  if (admins?.length) {
    const { data: taskInfo } = await supabase
      .from('tasks').select('title').eq('id', taskId).single()
    await supabase.from('notifications').insert(
      admins.map((a) => ({
        user_id: a.id,
        type:    'feedback_created',
        task_id: taskId,
        title:   'Phản hồi mới từ cửa hàng',
        message: `"${trimmedTitle}" — task: ${taskInfo?.title ?? taskId}`,
      }))
    )
  }

  revalidatePath(`/tasks/${taskId}`)
  return { success: true, threadId: thread?.id }
}

// ─── addFeedbackMessage ───────────────────────────────────────────────────────
// Admin or store_manager posts a reply in a thread.
export async function addFeedbackMessage(threadId: string, message: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('users').select('role, store_id, full_name').eq('id', user.id).single()
  if (!['admin', 'store_manager'].includes(profile?.role ?? ''))
    return { error: 'Không có quyền phản hồi' }

  const trimmed = message.trim()
  if (!trimmed) return { error: 'Nội dung phản hồi không được để trống' }

  const { data: thread } = await supabase
    .from('task_feedback_threads')
    .select('task_id, store_id, status, title')
    .eq('id', threadId)
    .single()
  if (!thread) return { error: 'Không tìm thấy thread phản hồi' }
  if (thread.status === 'resolved') return { error: 'Thread đã đóng, không thể thêm phản hồi' }

  // Store manager can only reply to threads in their store
  if (profile?.role === 'store_manager' && thread.store_id !== profile.store_id)
    return { error: 'Không có quyền phản hồi thread này' }

  const { error } = await supabase
    .from('task_feedback_messages')
    .insert({ thread_id: threadId, user_id: user.id, message: trimmed })
  if (error) return { error: error.message }

  // Update thread status based on who replied
  const newStatus = profile?.role === 'admin' ? 'answered' : 'open'
  await supabase
    .from('task_feedback_threads')
    .update({ status: newStatus })
    .eq('id', threadId)

  // Notify the other party
  if (profile?.role === 'admin') {
    // Admin replied → notify store managers of that store
    const { data: managers } = await supabase
      .from('users').select('id').eq('role', 'store_manager').eq('store_id', thread.store_id)
    if (managers?.length) {
      await supabase.from('notifications').insert(
        managers.map((m) => ({
          user_id: m.id,
          type:    'feedback_replied',
          task_id: thread.task_id,
          title:   'Admin đã trả lời phản hồi',
          message: `"${thread.title}": ${trimmed.slice(0, 80)}`,
        }))
      )
    }
  } else {
    // Store manager replied → notify admins
    const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin')
    if (admins?.length) {
      await supabase.from('notifications').insert(
        admins.map((a) => ({
          user_id: a.id,
          type:    'feedback_replied',
          task_id: thread.task_id,
          title:   'Cửa hàng có phản hồi mới',
          message: `"${thread.title}": ${trimmed.slice(0, 80)}`,
        }))
      )
    }
  }

  revalidatePath(`/tasks/${thread.task_id}`)
  return { success: true }
}

// ─── resolveFeedbackThread ────────────────────────────────────────────────────
// Mark a thread as resolved (admin or the creating store_manager).
export async function resolveFeedbackThread(threadId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('users').select('role, store_id').eq('id', user.id).single()
  if (!['admin', 'store_manager'].includes(profile?.role ?? ''))
    return { error: 'Không có quyền' }

  const { data: thread } = await supabase
    .from('task_feedback_threads').select('task_id, store_id').eq('id', threadId).single()
  if (!thread) return { error: 'Không tìm thấy thread' }

  if (profile?.role === 'store_manager' && thread.store_id !== profile.store_id)
    return { error: 'Không có quyền đóng thread này' }

  const { error } = await supabase
    .from('task_feedback_threads').update({ status: 'resolved' }).eq('id', threadId)
  if (error) return { error: error.message }

  revalidatePath(`/tasks/${thread.task_id}`)
  return { success: true }
}
