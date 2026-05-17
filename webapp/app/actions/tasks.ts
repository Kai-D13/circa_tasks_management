'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TaskPriority, TaskStatus, TaskVisibility, RequiredOutput } from '@/types'

async function writeLog(
  supabase: Awaited<ReturnType<typeof createClient>>,
  taskId: string,
  action: string,
  userId: string,
  metadata?: Record<string, unknown>
) {
  await supabase.from('task_logs').insert({ task_id: taskId, action, user_id: userId, metadata })
}

async function insertNotification(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  type: string,
  taskId: string,
  title: string,
  message: string
) {
  await supabase.from('notifications').insert({ user_id: userId, type, task_id: taskId, title, message })
}

const STATUS_LABEL_VN: Record<string, string> = {
  todo:        'Chờ thực hiện',
  in_progress: 'Đang thực hiện',
  done:        'Hoàn thành',
  overdue:     'Quá hạn',
}

export async function createTask(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const requiredOutputsRaw = formData.getAll('required_outputs') as RequiredOutput[]
  const assignedTo = formData.get('assigned_to') as string || null

  const { data: task, error } = await supabase.from('tasks').insert({
    title:            formData.get('title') as string,
    description:      formData.get('description') as string || null,
    priority:         formData.get('priority') as TaskPriority,
    visibility:       formData.get('visibility') as TaskVisibility,
    store_id:         formData.get('store_id') as string || null,
    assigned_to:      assignedTo,
    start_date:       formData.get('start_date') as string || null,
    deadline:         formData.get('deadline') as string || null,
    required_outputs: requiredOutputsRaw,
    created_by:       user.id,
  }).select().single()

  if (error) return { error: error.message }

  const { data: assignee } = assignedTo
    ? await supabase.from('users').select('full_name').eq('id', assignedTo).single()
    : { data: null }

  await writeLog(supabase, task.id, 'created', user.id, {
    title:         task.title,
    assigned_to:   assignedTo,
    assignee_name: assignee?.full_name ?? null,
  })

  if (assignedTo) {
    await insertNotification(supabase, assignedTo, 'task_assigned', task.id,
      'Task mới được giao',
      `Bạn được giao task: ${task.title}`
    )
  }

  revalidatePath('/tasks')
  redirect('/tasks')
}

export async function updateTask(taskId: string, formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const requiredOutputsRaw = formData.getAll('required_outputs') as RequiredOutput[]
  const assignedTo = formData.get('assigned_to') as string || null

  // Check if assignee changed to send notification
  const { data: prevTask } = await supabase
    .from('tasks').select('assigned_to, title').eq('id', taskId).single()

  const { error } = await supabase.from('tasks').update({
    title:            formData.get('title') as string,
    description:      formData.get('description') as string || null,
    priority:         formData.get('priority') as TaskPriority,
    visibility:       formData.get('visibility') as TaskVisibility,
    store_id:         formData.get('store_id') as string || null,
    assigned_to:      assignedTo,
    start_date:       formData.get('start_date') as string || null,
    deadline:         formData.get('deadline') as string || null,
    required_outputs: requiredOutputsRaw,
  }).eq('id', taskId)

  if (error) return { error: error.message }

  const { data: assignee } = assignedTo
    ? await supabase.from('users').select('full_name').eq('id', assignedTo).single()
    : { data: null }

  await writeLog(supabase, taskId, 'updated', user.id, {
    title:         formData.get('title') as string,
    assigned_to:   assignedTo,
    assignee_name: assignee?.full_name ?? null,
  })

  if (assignedTo && assignedTo !== prevTask?.assigned_to) {
    await insertNotification(supabase, assignedTo, 'task_assigned', taskId,
      'Task mới được giao',
      `Bạn được giao task: ${formData.get('title') as string}`
    )
  }

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${taskId}`)
  redirect(`/tasks/${taskId}`)
}

export async function updateTaskStatus(taskId: string, status: TaskStatus, note?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: current } = await supabase
    .from('tasks').select('status, created_by, title').eq('id', taskId).single()

  const { error } = await supabase.from('tasks').update({ status }).eq('id', taskId)
  if (error) return { error: error.message }

  await writeLog(supabase, taskId, 'status_changed', user.id, {
    from: current?.status ?? null,
    to:   status,
    ...(note ? { note } : {}),
  })

  // Notify task creator if someone else changed the status
  if (current?.created_by && current.created_by !== user.id) {
    await insertNotification(supabase, current.created_by, 'status_changed', taskId,
      'Trạng thái task thay đổi',
      `Task "${current.title}" chuyển sang: ${STATUS_LABEL_VN[status] ?? status}`
    )
  }

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${taskId}`)
  return { success: true }
}

export async function deleteTask(taskId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { error } = await supabase.from('tasks').delete().eq('id', taskId)
  if (error) return { error: error.message }

  revalidatePath('/tasks')
  redirect('/tasks')
}

export async function submitTask(taskId: string, outputData: Record<string, string>) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: task } = await supabase
    .from('tasks').select('created_by, title').eq('id', taskId).single()

  const { error: resultError } = await supabase.from('task_results').insert({
    task_id:     taskId,
    user_id:     user.id,
    output_data: outputData,
  })
  if (resultError) return { error: resultError.message }

  await supabase.from('tasks').update({ status: 'done' }).eq('id', taskId)
  await writeLog(supabase, taskId, 'submitted', user.id, {
    output_types: Object.keys(outputData),
  })

  if (task?.created_by && task.created_by !== user.id) {
    await insertNotification(supabase, task.created_by, 'task_submitted', taskId,
      'Kết quả task đã được nộp',
      `Task "${task.title}" đã được nộp kết quả`
    )
  }

  revalidatePath(`/tasks/${taskId}`)
  return { success: true }
}

export async function reassignTask(taskId: string, assignedTo: string | null) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase.from('users').select('role, store_id').eq('id', user.id).single()
  if (!['admin', 'store_manager'].includes(profile?.role ?? '')) {
    return { error: 'Không có quyền phân công task' }
  }

  if (profile?.role === 'store_manager') {
    const { data: task } = await supabase.from('tasks').select('store_id').eq('id', taskId).single()
    if (task?.store_id !== profile.store_id) return { error: 'Không có quyền phân công task này' }
  }

  const visibility: TaskVisibility = assignedTo ? 'private' : 'store'

  const { error } = await supabase
    .from('tasks')
    .update({ assigned_to: assignedTo, visibility })
    .eq('id', taskId)

  if (error) return { error: error.message }

  // Fetch assignee name for rich log
  const { data: assignee } = assignedTo
    ? await supabase.from('users').select('full_name').eq('id', assignedTo).single()
    : { data: null }

  await writeLog(supabase, taskId, 'reassigned', user.id, {
    assigned_to:   assignedTo,
    assignee_name: assignee?.full_name ?? null,
  })

  if (assignedTo) {
    const { data: taskInfo } = await supabase
      .from('tasks').select('title').eq('id', taskId).single()
    await insertNotification(supabase, assignedTo, 'task_reassigned', taskId,
      'Bạn được phân công task',
      `Task "${taskInfo?.title ?? taskId}" đã được phân công cho bạn`
    )
  }

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${taskId}`)
  return { success: true }
}

export async function createBulkTasks(params: {
  title: string
  description: string
  priority: TaskPriority
  deadline: string
  requiredOutputs: RequiredOutput[]
  fileName: string
  storeItems: { storeId: string; posCode: string; rows: Record<string, string>[] }[]
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (!['admin', 'store_manager'].includes(profile?.role ?? '')) {
    return { error: 'Chỉ admin hoặc store manager mới được tạo task hàng loạt' }
  }

  const tasksToInsert = params.storeItems.map((item) => ({
    title:            params.title,
    description:      params.description || null,
    priority:         params.priority,
    status:           'todo' as TaskStatus,
    visibility:       'store' as TaskVisibility,
    store_id:         item.storeId,
    assigned_to:      null,
    created_by:       user.id,
    deadline:         params.deadline || null,
    required_outputs: params.requiredOutputs,
    input_data: {
      pos_code:  item.posCode,
      file_name: params.fileName,
      rows:      item.rows,
      row_count: item.rows.length,
    },
  }))

  const { data: created, error } = await supabase.from('tasks').insert(tasksToInsert).select('id, title')
  if (error) return { error: error.message }

  const logs = (created ?? []).map((t) => ({
    task_id:  t.id,
    action:   'created',
    user_id:  user.id,
    metadata: { method: 'bulk_import', file: params.fileName, title: t.title },
  }))
  if (logs.length > 0) await supabase.from('task_logs').insert(logs)

  revalidatePath('/tasks')
  return { success: true, count: created?.length ?? 0 }
}

export async function addReviewNote(taskId: string, note: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single()
  if (!['admin', 'store_manager'].includes(profile?.role ?? ''))
    return { error: 'Không có quyền ghi chú' }

  await writeLog(supabase, taskId, 'review_note', user.id, { note })
  revalidatePath(`/tasks/${taskId}`)
  return { success: true }
}
