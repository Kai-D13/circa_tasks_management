'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TaskCategory, TaskPriority, TaskStatus, TaskVisibility, RequiredOutput } from '@/types'

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

  const attachmentsRaw = formData.get('input_attachments') as string
  const linksRaw = formData.get('input_links') as string
  const inputAttachments = attachmentsRaw ? JSON.parse(attachmentsRaw) : []
  const inputLinks = linksRaw ? JSON.parse(linksRaw) : []
  const inputData = (inputAttachments.length > 0 || inputLinks.length > 0)
    ? { attachments: inputAttachments, links: inputLinks }
    : null

  const { data: task, error } = await supabase.from('tasks').insert({
    title:            formData.get('title') as string,
    description:      formData.get('description') as string || null,
    category:         (formData.get('category') as TaskCategory) || 'other',
    priority:         formData.get('priority') as TaskPriority,
    visibility:       formData.get('visibility') as TaskVisibility,
    store_id:         formData.get('store_id') as string || null,
    assigned_to:      assignedTo,
    start_date:       formData.get('start_date') as string || null,
    deadline:         formData.get('deadline') as string || null,
    required_outputs: requiredOutputsRaw,
    created_by:       user.id,
    input_data:       inputData,
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

  const attachmentsRaw = formData.get('input_attachments') as string
  const linksRaw = formData.get('input_links') as string
  const inputAttachments = attachmentsRaw ? JSON.parse(attachmentsRaw) : []
  const inputLinks = linksRaw ? JSON.parse(linksRaw) : []

  // Merge with existing input_data to preserve bulk-import rows
  const { data: existingTask } = await supabase.from('tasks').select('input_data, assigned_to, title').eq('id', taskId).single()
  const prevTask = existingTask
  const existingInputData = (existingTask?.input_data as Record<string, unknown>) ?? {}
  const newInputData = {
    ...existingInputData,
    attachments: inputAttachments,
    links: inputLinks,
  }

  const { error } = await supabase.from('tasks').update({
    title:            formData.get('title') as string,
    description:      formData.get('description') as string || null,
    category:         (formData.get('category') as TaskCategory) || 'other',
    priority:         formData.get('priority') as TaskPriority,
    visibility:       formData.get('visibility') as TaskVisibility,
    store_id:         formData.get('store_id') as string || null,
    assigned_to:      assignedTo,
    start_date:       formData.get('start_date') as string || null,
    deadline:         formData.get('deadline') as string || null,
    required_outputs: requiredOutputsRaw,
    input_data:       newInputData,
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

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const role = profile?.role ?? 'staff'

  // Staff: route through SECURITY DEFINER RPC (only allows status column update,
  // validates assignment + submission state at DB level)
  if (role === 'staff') {
    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      'rpc_staff_update_task_status',
      { p_task_id: taskId, p_status: status, p_note: note ?? null }
    )
    if (rpcError) return { error: rpcError.message }
    if ((rpcResult as { error?: string })?.error) return { error: (rpcResult as { error: string }).error }

    // Notify task creator
    const { data: taskInfo } = await supabase
      .from('tasks').select('created_by, title').eq('id', taskId).single()
    if (taskInfo?.created_by && taskInfo.created_by !== user.id) {
      await insertNotification(supabase, taskInfo.created_by, 'status_changed', taskId,
        'Trạng thái task thay đổi',
        `Task "${taskInfo.title}" chuyển sang: ${STATUS_LABEL_VN[status] ?? status}`
      )
    }

    revalidatePath('/tasks')
    revalidatePath(`/tasks/${taskId}`)
    return { success: true }
  }

  // Admin / Store Manager: direct update
  const { data: current } = await supabase
    .from('tasks').select('status, created_by, title').eq('id', taskId).single()

  const { error } = await supabase.from('tasks').update({ status }).eq('id', taskId)
  if (error) return { error: error.message }

  await writeLog(supabase, taskId, 'status_changed', user.id, {
    from: current?.status ?? null,
    to:   status,
    ...(note ? { note } : {}),
  })

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

  // Fetch task — check assignment and resubmit timestamp in one query
  const { data: task } = await supabase
    .from('tasks')
    .select('created_by, title, assigned_to, resubmit_requested_at')
    .eq('id', taskId)
    .single()

  if (!task || task.assigned_to !== user.id) {
    return { error: 'Task này không được giao cho bạn' }
  }

  // Smart duplicate check: block only if submitted AFTER the last resubmit request
  // (if resubmit_requested_at is set, old results from before it don't block)
  let dupQuery = supabase
    .from('task_results')
    .select('id')
    .eq('task_id', taskId)
    .eq('user_id', user.id)
  if (task.resubmit_requested_at) {
    dupQuery = dupQuery.gt('submitted_at', task.resubmit_requested_at)
  }
  const { data: existing } = await dupQuery.maybeSingle()
  if (existing) return { error: 'Bạn đã nộp kết quả cho task này rồi' }

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

export async function createBroadcastTask(params: {
  title: string
  description: string
  category: TaskCategory
  priority: TaskPriority
  visibility: TaskVisibility
  storeIds: string[]
  startDate: string | null
  deadline: string | null
  requiredOutputs: RequiredOutput[]
  attachments?: { url: string; name: string; type: string; size?: number }[]
  links?: { label: string; url: string }[]
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return { error: 'Chỉ admin mới được tạo task broadcast' }

  if (!params.storeIds.length) return { error: 'Vui lòng chọn ít nhất một cửa hàng' }

  const { data: broadcast, error: bcastError } = await supabase
    .from('task_broadcasts')
    .insert({ title: params.title, created_by: user.id, store_count: params.storeIds.length })
    .select().single()

  if (bcastError) return { error: bcastError.message }

  const inputData = (params.attachments?.length || params.links?.length)
    ? { attachments: params.attachments ?? [], links: params.links ?? [] }
    : null

  const tasksToInsert = params.storeIds.map((storeId) => ({
    title:            params.title,
    description:      params.description || null,
    category:         params.category,
    priority:         params.priority,
    visibility:       params.visibility,
    store_id:         storeId,
    assigned_to:      null,
    created_by:       user.id,
    start_date:       params.startDate || null,
    deadline:         params.deadline || null,
    required_outputs: params.requiredOutputs,
    broadcast_id:     broadcast.id,
    status:           'todo' as TaskStatus,
    input_data:       inputData,
  }))

  const { data: created, error } = await supabase
    .from('tasks').insert(tasksToInsert).select('id, title, store_id')
  if (error) return { error: error.message }

  const logs = (created ?? []).map((t) => ({
    task_id:  t.id,
    action:   'created',
    user_id:  user.id,
    metadata: { method: 'broadcast', broadcast_id: broadcast.id, title: t.title },
  }))
  if (logs.length > 0) await supabase.from('task_logs').insert(logs)

  // Notify store managers of selected stores
  const { data: managers } = await supabase
    .from('users')
    .select('id, store_id')
    .eq('role', 'store_manager')
    .in('store_id', params.storeIds)

  if (managers?.length) {
    const notifications = managers.map((m) => {
      const storeTask = (created ?? []).find((t) => t.store_id === m.store_id)
      return {
        user_id: m.id,
        type:    'task_assigned',
        task_id: storeTask?.id ?? null,
        title:   'Task mới được giao cho cửa hàng',
        message: `Task mới: ${params.title}`,
      }
    })
    await supabase.from('notifications').insert(notifications)
  }

  revalidatePath('/tasks')
  redirect('/tasks')
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

export async function requestResubmit(taskId: string, reason?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (!['admin', 'store_manager'].includes(profile?.role ?? ''))
    return { error: 'Không có quyền yêu cầu làm lại' }

  const { data: task } = await supabase
    .from('tasks').select('assigned_to, title').eq('id', taskId).single()

  const { error } = await supabase.from('tasks')
    .update({ status: 'todo', resubmit_requested_at: new Date().toISOString() })
    .eq('id', taskId)
  if (error) return { error: error.message }

  await writeLog(supabase, taskId, 'resubmit_requested', user.id, {
    reason: reason ?? null,
  })

  if (task?.assigned_to) {
    await insertNotification(
      supabase,
      task.assigned_to,
      'resubmit_requested',
      taskId,
      'Yêu cầu thực hiện lại task',
      `Quản lý yêu cầu bạn thực hiện lại: "${task.title}"${reason ? ` — ${reason}` : ''}`
    )
  }

  revalidatePath(`/tasks/${taskId}`)
  return { success: true }
}

export async function addReviewNote(taskId: string, note: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single()
  if (!['admin', 'store_manager'].includes(profile?.role ?? ''))
    return { error: 'Không có quyền ghi chú' }

  const { data: task } = await supabase
    .from('tasks').select('assigned_to, title').eq('id', taskId).single()

  await writeLog(supabase, taskId, 'review_note', user.id, { note })

  // Notify assigned staff about the manager's review note
  if (task?.assigned_to && task.assigned_to !== user.id) {
    await insertNotification(
      supabase,
      task.assigned_to,
      'review_note',
      taskId,
      'Ghi chú mới từ quản lý',
      `Task "${task.title}": ${note.length > 60 ? note.slice(0, 60) + '…' : note}`
    )
  }

  revalidatePath(`/tasks/${taskId}`)
  return { success: true }
}
