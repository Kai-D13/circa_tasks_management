'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { computeNextRunAt } from '@/lib/recurring'
import { notifyTaskCreated } from '@/lib/teams/notifyTaskCreated'
import { getEffectiveStatus } from '@/lib/dateUtils'
import { canAdminManageOwn } from '@/lib/authz'

// True when the given admin is an 'editor' collaborator on the task.
// Used by addReviewNote + requestResubmit to accept collaborator editors.
async function isCollaboratorEditor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  taskId: string,
): Promise<boolean> {
  const { count } = await supabase
    .from('task_collaborators')
    .select('id', { count: 'exact', head: true })
    .eq('task_id', taskId)
    .eq('admin_id', userId)
    .eq('permission', 'editor')
  return (count ?? 0) > 0
}
import { TaskCategory, TaskPriority, TaskStatus, TaskVisibility, RequiredOutput, TaskAttachment } from '@/types'

async function writeLog(
  supabase: Awaited<ReturnType<typeof createClient>>,
  taskId: string,
  action: string,
  userId: string,
  metadata?: Record<string, unknown>
) {
  await supabase.from('task_logs').insert({ task_id: taskId, action, user_id: userId, metadata })
}

// Always uses supabaseAdmin — the public INSERT policy on notifications is
// locked to service role (migration 021) to prevent clients forging alerts.
async function insertNotification(
  _supabase: unknown,
  userId: string,
  type: string,
  taskId: string,
  title: string,
  message: string
) {
  await supabaseAdmin.from('notifications').insert({ user_id: userId, type, task_id: taskId, title, message })
}

const STATUS_LABEL_VN: Record<string, string> = {
  todo:        'Chờ thực hiện',
  in_progress: 'Đang thực hiện',
  done:        'Hoàn thành',
  overdue:     'Quá hạn',
}

// Shared per-file attachment validation used by all task creation paths.
// Keep limits in sync with TaskInputAttachments.tsx (client).
type AttachmentMeta = { type?: string; size?: number }
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
const ALLOWED_AUDIO_TYPES = ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/x-m4a', 'audio/m4a']
function validateAttachments(atts: AttachmentMeta[]): string | null {
  if (atts.length > 20) return 'Tối đa 20 file đính kèm mỗi task'
  let totalSize = 0
  for (const a of atts) {
    const size = a.size ?? 0
    totalSize += size
    if (a.type?.startsWith('image/')) {
      if (!ALLOWED_IMAGE_TYPES.includes(a.type))
        return `Định dạng ảnh không hỗ trợ (${a.type}). Chỉ hỗ trợ jpg, png, webp`
      if (size > 5 * 1024 * 1024) return 'Ảnh quá lớn (tối đa 5MB mỗi ảnh)'
    } else if (a.type?.startsWith('audio/')) {
      if (!ALLOWED_AUDIO_TYPES.includes(a.type))
        return `Định dạng audio không hỗ trợ (${a.type})`
      if (size > 15 * 1024 * 1024) return 'Audio quá lớn (tối đa 15MB mỗi file)'
    } else {
      if (size > 10 * 1024 * 1024) return 'File quá lớn (tối đa 10MB mỗi file)'
    }
  }
  if (totalSize > 30 * 1024 * 1024) return 'Tổng dung lượng file đính kèm vượt 30MB'
  return null
}

// Ad-hoc tasks must have a start date and a deadline, with deadline after start.
function validateTaskDates(startDate: string | null, deadline: string | null): string | null {
  if (!startDate) return 'Vui lòng chọn ngày bắt đầu'
  if (!deadline)  return 'Vui lòng chọn deadline'
  if (new Date(deadline) <= new Date(startDate)) return 'Deadline phải sau ngày bắt đầu'
  return null
}

export async function createTask(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  // Task creation is admin-only (own-scope: created_by = caller). Store managers
  // are executors, not task admins.
  const { data: creatorProfile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (creatorProfile?.role !== 'admin') return { error: 'Chỉ admin mới được tạo task' }

  const storeIdVal = formData.get('store_id') as string | null
  if (!storeIdVal) return { error: 'Vui lòng chọn cửa hàng nhận task' }

  const dateErr = validateTaskDates(
    formData.get('start_date') as string || null,
    formData.get('deadline') as string || null,
  )
  if (dateErr) return { error: dateErr }

  const requiredOutputsRaw = formData.getAll('required_outputs') as RequiredOutput[]
  const assignedTo = formData.get('assigned_to') as string || null

  const attachmentsRaw = formData.get('input_attachments') as string
  const linksRaw = formData.get('input_links') as string
  let inputAttachments: AttachmentMeta[]
  let inputLinks: unknown[]
  try {
    inputAttachments = attachmentsRaw ? JSON.parse(attachmentsRaw) : []
    inputLinks       = linksRaw       ? JSON.parse(linksRaw)       : []
  } catch {
    return { error: 'Dữ liệu đính kèm không hợp lệ' }
  }
  const attachErr = validateAttachments(inputAttachments)
  if (attachErr) return { error: attachErr }

  const inputData = (inputAttachments.length > 0 || inputLinks.length > 0)
    ? { attachments: inputAttachments, links: inputLinks }
    : null

  // ── staff_all mode: parent (overview, not submittable) + one child per staff ──
  // Each pharmacist in the store gets their own child task they must submit.
  // The parent is private/unassigned so staff can't see it (RLS); managers and
  // admins see it via their role policies.
  if (formData.get('assignment_mode') === 'staff_all') {
    return createStaffRequiredTask(supabase, user.id, {
      storeId:         storeIdVal,
      title:           formData.get('title') as string,
      description:     formData.get('description') as string || null,
      category:        (formData.get('category') as TaskCategory) || 'other',
      priority:        formData.get('priority') as TaskPriority,
      startDate:       formData.get('start_date') as string || null,
      deadline:        formData.get('deadline') as string || null,
      requiredOutputs: requiredOutputsRaw,
      inputData,
    })
  }

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
  } else if (storeIdVal) {
    // Store-level task (no individual assignee) → notify all store_managers of that store
    const { data: managers } = await supabase
      .from('users').select('id')
      .eq('role', 'store_manager').eq('store_id', storeIdVal)
    if (managers?.length) {
      await supabaseAdmin.from('notifications').insert(
        managers.map((m) => ({
          user_id: m.id,
          type:    'task_assigned',
          task_id: task.id,
          title:   'Task mới cho cửa hàng',
          message: `Task mới: ${task.title}`,
        }))
      )
    }
  }

  // Microsoft Teams notification (MVP). Never throws — task already created.
  await notifyTaskCreated({
    taskId:    task.id,
    storeId:   storeIdVal,
    taskTitle: task.title,
    taskType:  'Phát sinh',
    deadline:  task.deadline,
  })

  revalidatePath('/tasks')
  redirect('/tasks')
}

// staff_all helper — called by createTask when the admin picks "Từng dược sĩ nộp".
// Creates one private parent (overview only) plus one private child per active
// staff member of the store. Already authenticated/admin-checked by the caller.
async function createStaffRequiredTask(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  p: {
    storeId:         string
    title:           string
    description:     string | null
    category:        TaskCategory
    priority:        TaskPriority
    startDate:       string | null
    deadline:        string | null
    requiredOutputs: RequiredOutput[]
    inputData:       unknown
  },
) {
  // 1. Active pharmacists of the store. No is_active flag exists → all role='staff'.
  const { data: staff } = await supabase
    .from('users').select('id, full_name')
    .eq('role', 'staff').eq('store_id', p.storeId)
  if (!staff || staff.length === 0) {
    return { error: 'Cửa hàng chưa có dược sĩ nào để giao task' }
  }

  // 2. Parent — private + unassigned so staff can't see it; managers/admins can.
  const { data: parent, error: parentErr } = await supabase.from('tasks').insert({
    title:            p.title,
    description:      p.description,
    category:         p.category,
    priority:         p.priority,
    visibility:       'private' as TaskVisibility,
    store_id:         p.storeId,
    assigned_to:      null,
    assignment_mode:  'staff_all',
    start_date:       p.startDate,
    deadline:         p.deadline,
    required_outputs: p.requiredOutputs,
    created_by:       userId,
    input_data:       p.inputData,
  }).select().single()
  if (parentErr || !parent) return { error: parentErr?.message ?? 'Không thể tạo task cha' }

  // 3. One child per staff. Private + assigned so each staff sees only their own.
  const { data: children, error: childErr } = await supabase.from('tasks').insert(
    staff.map((s) => ({
      title:            p.title,
      description:      p.description,
      category:         p.category,
      priority:         p.priority,
      visibility:       'private' as TaskVisibility,
      store_id:         p.storeId,
      assigned_to:      s.id,
      assignment_mode:  'user',
      parent_task_id:   parent.id,
      start_date:       p.startDate,
      deadline:         p.deadline,
      required_outputs: p.requiredOutputs,
      created_by:       userId,
      input_data:       p.inputData,
    })),
  ).select('id, assigned_to')
  if (childErr || !children) {
    // Rollback the orphan parent (best-effort) so we never leave a childless parent.
    await supabase.from('tasks').delete().eq('id', parent.id)
    return { error: childErr?.message ?? 'Không thể tạo task con cho nhân viên' }
  }

  // 4. Logs: parent created + child-generation summary.
  await writeLog(supabase, parent.id, 'created', userId, {
    title:            p.title,
    assignment_mode:  'staff_all',
  })
  await writeLog(supabase, parent.id, 'staff_children_generated', userId, {
    child_count: children.length,
  })

  // 5. Notifications: each store_manager about the parent, each staff about their child.
  const { data: managers } = await supabase
    .from('users').select('id')
    .eq('role', 'store_manager').eq('store_id', p.storeId)
  const notifications = [
    ...(managers ?? []).map((m) => ({
      user_id: m.id,
      type:    'task_assigned',
      task_id: parent.id,
      title:   'Task mới cho cửa hàng (từng dược sĩ nộp)',
      message: `Task mới: ${p.title} — ${children.length} dược sĩ cần nộp`,
    })),
    ...children.map((c) => ({
      user_id: c.assigned_to as string,
      type:    'task_assigned',
      task_id: c.id,
      title:   'Task mới được giao',
      message: `Bạn được giao task: ${p.title}`,
    })),
  ]
  if (notifications.length) {
    await supabaseAdmin.from('notifications').insert(notifications)
  }

  // 6. Microsoft Teams notification (best-effort, never throws).
  await notifyTaskCreated({
    taskId:    parent.id,
    storeId:   p.storeId,
    taskTitle: p.title,
    taskType:  'Phát sinh',
    deadline:  p.deadline,
  })

  revalidatePath('/tasks')
  redirect('/tasks')
}

export async function updateTask(taskId: string, formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  // Admin-only + own-scope: super admin any task, sub-admin only ones they created.
  const { data: editorProfile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const { data: ownerRow } = await supabase.from('tasks').select('created_by, assignment_mode').eq('id', taskId).single()
  if (!canAdminManageOwn({ email: user.email, role: editorProfile?.role, createdBy: ownerRow?.created_by, userId: user.id }))
    return { error: 'Bạn không có quyền chỉnh sửa task này' }
  if ((ownerRow as { assignment_mode?: string } | null)?.assignment_mode === 'staff_all')
    return { error: 'Không thể chỉnh sửa task cha — hãy xoá và tạo lại nếu cần.' }

  const storeIdVal = formData.get('store_id') as string | null
  if (!storeIdVal) return { error: 'Vui lòng chọn cửa hàng nhận task' }

  const dateErrU = validateTaskDates(
    formData.get('start_date') as string || null,
    formData.get('deadline') as string || null,
  )
  if (dateErrU) return { error: dateErrU }

  const requiredOutputsRaw = formData.getAll('required_outputs') as RequiredOutput[]
  const assignedTo = formData.get('assigned_to') as string || null

  const attachmentsRaw = formData.get('input_attachments') as string
  const linksRaw = formData.get('input_links') as string
  let inputAttachments: AttachmentMeta[]
  let inputLinks: unknown[]
  try {
    inputAttachments = attachmentsRaw ? JSON.parse(attachmentsRaw) : []
    inputLinks       = linksRaw       ? JSON.parse(linksRaw)       : []
  } catch {
    return { error: 'Dữ liệu đính kèm không hợp lệ' }
  }
  const attachErrU = validateAttachments(inputAttachments)
  if (attachErrU) return { error: attachErrU }

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

  // Only admin can set done — everyone else must use the submit form
  if (role !== 'admin' && status === 'done') {
    return { error: 'Dùng form "Nộp kết quả" để hoàn thành task' }
  }

  // Executors (staff + store_manager submitters): route through the SECURITY
  // DEFINER RPC, which only allows the status column and validates submitter +
  // todo/in_progress + submission state at the DB level. Managers no longer have
  // a direct tasks UPDATE policy (migration 022).
  if (role === 'staff' || role === 'store_manager') {
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

  // Admin only: direct update. RLS (tasks_update_admin, own-scope) enforces that
  // a sub-admin can only touch tasks they created; super admin any.
  const { data: current } = await supabase
    .from('tasks')
    .select('status, created_by, title, assigned_to, store_id, resubmit_requested_at')
    .eq('id', taskId)
    .single()

  const { error } = await supabase.from('tasks').update({ status }).eq('id', taskId)
  if (error) return { error: error.message }

  await writeLog(supabase, taskId, 'status_changed', user.id, {
    from: current?.status ?? null,
    to:   status,
    ...(note ? { note } : {}),
  })
  // Structured status event for admin direct-update path
  { const { error: seErr } = await supabaseAdmin.from('task_status_events').insert({
    task_id:     taskId,
    from_status: current?.status ?? null,
    to_status:   status,
    note:        note || null,
    actor_id:    user.id,
    source:      'admin',
  }); if (seErr) console.error('[task_status_events] updateTaskStatus:', seErr.message) }

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

  // Admin-only + own-scope: super admin any, sub-admin only ones they created.
  const { data: delProfile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const { data: delOwner } = await supabase.from('tasks').select('created_by').eq('id', taskId).single()
  if (!canAdminManageOwn({ email: user.email, role: delProfile?.role, createdBy: delOwner?.created_by, userId: user.id }))
    return { error: 'Bạn không có quyền xoá task này' }

  const { error } = await supabase.from('tasks').delete().eq('id', taskId)
  if (error) return { error: error.message }

  revalidatePath('/tasks')
  redirect('/tasks')
}

export async function submitTask(taskId: string, outputData: Record<string, unknown>) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  // Fetch task + profile in parallel
  const [{ data: task }, { data: profile }] = await Promise.all([
    supabase
      .from('tasks')
      .select('created_by, title, assigned_to, store_id, resubmit_requested_at, required_outputs, deadline, status, overdue_at, assignment_mode')
      .eq('id', taskId)
      .single(),
    supabase
      .from('users')
      .select('role, store_id')
      .eq('id', user.id)
      .single(),
  ])

  if (!task) return { error: 'Task không tồn tại' }

  // A staff_all parent is overview-only — results are submitted on the per-staff
  // child tasks, never on the parent.
  if (task.assignment_mode === 'staff_all') {
    return { error: 'Đây là task cha — vui lòng nộp kết quả trên task con của bạn.' }
  }

  // Who can submit:
  // (a) direct assignment: task.assigned_to = user.id
  // (b) store-level: task has no assignee, user is store_manager of that store
  const isDirectAssignee = task.assigned_to === user.id
  const isStoreSubmitter = task.assigned_to === null
    && task.store_id !== null
    && task.store_id === profile?.store_id
    && profile?.role === 'store_manager'

  if (!isDirectAssignee && !isStoreSubmitter) {
    return { error: 'Bạn không có quyền nộp kết quả cho task này' }
  }

  // Overdue tasks are submittable. We record lateness instead of blocking: a
  // submission counts as late when the task is effectively overdue (DB status
  // 'overdue', or deadline passed while not done) at submit time.
  const submittedLate =
    getEffectiveStatus(task.deadline as string | null, task.status as string) === 'overdue'

  // Duplicate check: block if a result already exists after the last resubmit request.
  // Direct-assign: per user (same user can't double-submit).
  // Store-level: per task (any submission from the store counts).
  let dupQuery = supabase
    .from('task_results')
    .select('id')
    .eq('task_id', taskId)
  if (isDirectAssignee) {
    dupQuery = dupQuery.eq('user_id', user.id)
  }
  if (task.resubmit_requested_at) {
    dupQuery = dupQuery.gt('submitted_at', task.resubmit_requested_at)
  }
  const { data: existingList, error: dupError } = await dupQuery.limit(1)
  if (dupError) return { error: dupError.message }
  if ((existingList?.length ?? 0) > 0) return { error: 'Task này đã có kết quả nộp rồi' }

  // Validate each required output is present
  const requiredOutputs = (task.required_outputs as string[]) ?? []
  const OUTPUT_LABEL_VN: Record<string, string> = {
    text: 'Ghi chú văn bản', image: 'Ảnh', video: 'Video', file: 'File đính kèm',
  }
  const missing = requiredOutputs.filter((type) => {
    const val = outputData[type]
    if (!val) return true
    if (typeof val === 'string') return !val.trim()
    if (Array.isArray(val)) return val.length === 0
    return false
  })
  if (missing.length > 0) {
    return { error: `Vui lòng nộp đủ: ${missing.map((t) => OUTPUT_LABEL_VN[t] ?? t).join(', ')}` }
  }

  const { data: resultRow, error: resultError } = await supabase
    .from('task_results')
    .insert({ task_id: taskId, user_id: user.id, output_data: outputData })
    .select('id')
    .single()
  if (resultError) return { error: resultError.message }

  // Link any tracked upload metadata rows to this result.
  // fileId is stored in each ImageAttachment by MultiImageUpload (Batch D+).
  // Best-effort: a link failure must not block the submission.
  const imageAtts = (outputData['image'] as Array<{ fileId?: string }> | undefined) ?? []
  const fileIds = imageAtts.map((a) => a.fileId).filter((id): id is string => !!id)
  if (fileIds.length > 0) {
    const { error: linkErr } = await supabaseAdmin
      .from('task_uploaded_files')
      .update({ result_id: resultRow.id, linked_at: new Date().toISOString() })
      .in('id', fileIds)
      .eq('task_id', taskId)
      .eq('uploaded_by', user.id)
      .is('linked_at', null)
    if (linkErr) console.error('[task_uploaded_files link]', linkErr.message)
  }

  // Mark the most recent open resubmit request as fulfilled now that a result exists.
  const { data: openReq } = await supabaseAdmin
    .from('task_resubmit_requests')
    .select('id')
    .eq('task_id', taskId)
    .eq('status', 'open')
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (openReq) {
    const { error: rrErr } = await supabaseAdmin.from('task_resubmit_requests').update({
      status:              'fulfilled',
      fulfilled_result_id: resultRow?.id ?? null,
      fulfilled_at:        new Date().toISOString(),
    }).eq('id', openReq.id)
    if (rrErr) console.error('[task_resubmit_requests] fulfill on submit:', rrErr.message)
  }

  // Use admin client — staff RLS no longer allows direct UPDATE on tasks (dropped in 010).
  // When the submission is late, stamp overdue_at (preserving an earlier cron-set value)
  // so the "Hoàn thành trễ" marker survives the done transition.
  const statusUpdate: { status: 'done'; overdue_at?: string } = { status: 'done' }
  if (submittedLate) {
    statusUpdate.overdue_at = (task.overdue_at as string | null) ?? new Date().toISOString()
  }
  const { error: statusError } = await supabaseAdmin
    .from('tasks')
    .update(statusUpdate)
    .eq('id', taskId)
  if (statusError) return { error: `Đã nộp kết quả nhưng không thể cập nhật trạng thái: ${statusError.message}` }

  // Structured status event
  { const { error: seErr } = await supabaseAdmin.from('task_status_events').insert({
    task_id:     taskId,
    from_status: task.status as string,
    to_status:   'done',
    actor_id:    user.id,
    source:      profile?.role === 'store_manager' ? 'store_manager' : 'staff',
  }); if (seErr) console.error('[task_status_events] submitTask:', seErr.message) }

  await writeLog(supabase, taskId, 'submitted', user.id, {
    output_types: Object.keys(outputData),
    submitted_after_deadline: submittedLate,
  })

  if (task?.created_by && task.created_by !== user.id) {
    await insertNotification(supabase, task.created_by, 'task_submitted', taskId,
      'Kết quả task đã được nộp',
      submittedLate
        ? `Task "${task.title}" đã được nộp (sau deadline)`
        : `Task "${task.title}" đã được nộp kết quả`
    )
  }

  // TODO Sprint N: Teams webhook notification
  //   - store_teams_webhook table: store_id → webhook_url (encrypted, never exposed to client)
  //   - trigger on: task submitted, overdue, recurring task generated, resubmit requested
  //   - use notification_outbox pattern for retry on webhook failure
  //   - Microsoft Teams Workflows Incoming Webhook (not Graph API for MVP)
  revalidatePath(`/tasks/${taskId}`)
  return { success: true }
}

export async function reassignTask(taskId: string, assignedTo: string | null) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  // Admin-only + own-scope: reassigning is a task-management action.
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const { data: reassignTask } = await supabase.from('tasks').select('created_by, store_id').eq('id', taskId).single()
  if (!canAdminManageOwn({ email: user.email, role: profile?.role, createdBy: reassignTask?.created_by, userId: user.id }))
    return { error: 'Không có quyền phân công task này' }

  // If assigning to a specific user, they must belong to the same store as the task.
  if (assignedTo) {
    const { data: assignee } = await supabase.from('users').select('store_id').eq('id', assignedTo).single()
    if (assignee?.store_id !== reassignTask?.store_id)
      return { error: 'Người được phân công phải thuộc cùng cửa hàng với task' }
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
  assignmentMode?: 'store' | 'staff_all'
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return { error: 'Chỉ admin mới được tạo task broadcast' }

  if (!params.storeIds.length) return { error: 'Vui lòng chọn ít nhất một cửa hàng' }

  const dateErrB = validateTaskDates(params.startDate, params.deadline)
  if (dateErrB) return { error: dateErrB }

  const attachErrB = validateAttachments(params.attachments ?? [])
  if (attachErrB) return { error: attachErrB }

  // ── staff_all branch: one parent per store + N children per pharmacist ──────
  if (params.assignmentMode === 'staff_all') {
    const { data: allStaff, error: staffErr } = await supabaseAdmin
      .from('users').select('id, store_id, full_name').eq('role', 'staff').in('store_id', params.storeIds)
    if (staffErr) return { error: staffErr.message }

    const staffByStore = new Map<string, { id: string; full_name: string }[]>()
    for (const s of allStaff ?? []) {
      if (!s.store_id) continue
      const arr = staffByStore.get(s.store_id) ?? []
      arr.push({ id: s.id, full_name: s.full_name })
      staffByStore.set(s.store_id, arr)
    }
    const emptyStoreIds = params.storeIds.filter(id => !(staffByStore.get(id)?.length))
    if (emptyStoreIds.length > 0) {
      const { data: emptyNames } = await supabaseAdmin
        .from('stores').select('id, name').in('id', emptyStoreIds)
      const names = (emptyNames ?? []).map(s => s.name).join(', ')
      return { error: `Cửa hàng chưa có dược sĩ: ${names}. Vui lòng thêm dược sĩ trước.` }
    }

    const { data: bcast, error: bcastErrSA } = await supabase
      .from('task_broadcasts')
      .insert({ title: params.title, created_by: user.id, store_count: params.storeIds.length })
      .select().single()
    if (bcastErrSA || !bcast) return { error: bcastErrSA?.message ?? 'Lỗi tạo broadcast' }

    const saInputData = (params.attachments?.length || params.links?.length)
      ? { attachments: params.attachments ?? [], links: params.links ?? [] }
      : null

    const parentsToInsert = params.storeIds.map(sid => ({
      title:            params.title,
      description:      params.description || null,
      category:         params.category,
      priority:         params.priority,
      visibility:       'private' as TaskVisibility,
      store_id:         sid,
      assigned_to:      null as string | null,
      created_by:       user.id,
      start_date:       params.startDate || null,
      deadline:         params.deadline || null,
      required_outputs: params.requiredOutputs,
      broadcast_id:     bcast.id,
      assignment_mode:  'staff_all' as const,
      status:           'todo' as TaskStatus,
      input_data:       saInputData,
    }))

    const { data: saParents, error: parentsErr } = await supabaseAdmin
      .from('tasks').insert(parentsToInsert).select('id, store_id')
    if (parentsErr || !saParents?.length) {
      await supabaseAdmin.from('task_broadcasts').delete().eq('id', bcast.id)
      return { error: parentsErr?.message ?? 'Lỗi tạo task cha' }
    }

    const childrenToInsert = saParents.flatMap(parent => {
      const staffList = staffByStore.get(parent.store_id!) ?? []
      return staffList.map(staff => ({
        title:            params.title,
        description:      params.description || null,
        category:         params.category,
        priority:         params.priority,
        visibility:       'private' as TaskVisibility,
        store_id:         parent.store_id,
        assigned_to:      staff.id,
        created_by:       user.id,
        start_date:       params.startDate || null,
        deadline:         params.deadline || null,
        required_outputs: params.requiredOutputs,
        broadcast_id:     bcast.id,
        assignment_mode:  'user' as const,
        parent_task_id:   parent.id,
        status:           'todo' as TaskStatus,
        input_data:       saInputData,
      }))
    })

    const { data: saChildren, error: childrenErr } = await supabaseAdmin
      .from('tasks').insert(childrenToInsert).select('id, assigned_to, store_id')
    if (childrenErr) {
      await supabaseAdmin.from('tasks').delete().in('id', saParents.map(p => p.id))
      await supabaseAdmin.from('task_broadcasts').delete().eq('id', bcast.id)
      return { error: childrenErr.message }
    }

    // One log per parent: includes child count so it's filterable per store
    const saLogs = saParents.map(p => ({
      task_id:  p.id,
      action:   'created',
      user_id:  user.id,
      metadata: {
        method:       'broadcast_staff_all',
        broadcast_id: bcast.id,
        title:        params.title,
        child_count:  (saChildren ?? []).filter(c => c.store_id === p.store_id).length,
      },
    }))
    const { error: saLogErr } = await supabase.from('task_logs').insert(saLogs)
    if (saLogErr) console.error('[broadcast_staff_all] task_logs:', saLogErr.message)

    const { data: saManagers } = await supabaseAdmin
      .from('users').select('id, store_id').eq('role', 'store_manager').in('store_id', params.storeIds)
    const saNotifications = [
      ...(saManagers ?? []).map(m => ({
        user_id: m.id,
        type:    'task_assigned',
        task_id: saParents.find(p => p.store_id === m.store_id)?.id ?? null as string | null,
        title:   'Task mới cho cửa hàng (từng dược sĩ nộp)',
        message: `Task mới: ${params.title} — ${staffByStore.get(m.store_id!)?.length ?? 0} dược sĩ cần nộp`,
      })),
      ...(saChildren ?? []).filter(c => c.assigned_to).map(c => ({
        user_id: c.assigned_to as string,
        type:    'task_assigned',
        task_id: c.id,
        title:   'Task mới được giao',
        message: `Bạn được giao task: ${params.title}`,
      })),
    ]
    if (saNotifications.length) {
      const { error: saNotiErr } = await supabaseAdmin.from('notifications').insert(saNotifications)
      if (saNotiErr) console.error('[broadcast_staff_all] notifications:', saNotiErr.message)
    }

    // Teams notification per store parent — parallel, best-effort
    await Promise.allSettled(saParents.map(p =>
      notifyTaskCreated({
        taskId:    p.id,
        storeId:   p.store_id!,
        taskTitle: params.title,
        taskType:  'Phát sinh',
        deadline:  params.deadline,
      })
    ))

    revalidatePath('/tasks')
    redirect('/tasks')
  }
  // ─────────────────────────────────────────────────────────────────────────────

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
    await supabaseAdmin.from('notifications').insert(notifications)
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
  if (profile?.role !== 'admin') {
    return { error: 'Chỉ admin mới được tạo task hàng loạt' }
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

  // Requesting resubmit is a review action — task owner / super admin OR editor collaborator.
  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single()
  const { data: task } = await supabase
    .from('tasks').select('created_by, assigned_to, title, store_id, deadline, status').eq('id', taskId).single()
  const isOwnerR = canAdminManageOwn({ email: user.email, role: profile?.role, createdBy: task?.created_by, userId: user.id })
  if (!isOwnerR && !(await isCollaboratorEditor(supabase, user.id, taskId)))
    return { error: 'Không có quyền yêu cầu làm lại task này' }

  // Ensure task actually has results before allowing resubmit request
  const { count: resultCount } = await supabase
    .from('task_results')
    .select('id', { count: 'exact', head: true })
    .eq('task_id', taskId)
  if (!resultCount) return { error: 'Task chưa có kết quả nộp, không thể yêu cầu làm lại' }

  // A resubmit request flips status to 'todo'. Overdue is no longer a blocker —
  // the submitter can re-submit even past the deadline (it will be tracked as
  // late via tasks.overdue_at), so no deadline extension is required first.

  // Use supabaseAdmin for both the task update and the resubmit_request note.
  // Collaborator editors don't have a DB-level UPDATE policy on tasks; they rely
  // on the server-side validation above. Service role bypasses RLS, so the write
  // succeeds regardless of who the caller is, after validation has passed.
  const { error } = await supabaseAdmin.from('tasks')
    .update({ status: 'todo', resubmit_requested_at: new Date().toISOString() })
    .eq('id', taskId)
  if (error) return { error: error.message }

  // Reason text: dual-write to task_review_notes (UI display, backward compat)
  // AND task_resubmit_requests (structured reporting).
  if (reason && reason.trim()) {
    await supabaseAdmin.from('task_review_notes').insert({
      task_id:   taskId,
      author_id: user.id,
      kind:      'resubmit_request',
      note:      reason.trim(),
    })
  }
  // Cancel any prior open requests so there is at most one 'open' per task.
  // An admin may hit "yêu cầu làm lại" multiple times; only the latest matters.
  { const { error: rrCancelErr } = await supabaseAdmin
      .from('task_resubmit_requests')
      .update({ status: 'cancelled' })
      .eq('task_id', taskId)
      .eq('status', 'open')
    if (rrCancelErr) console.error('[task_resubmit_requests] cancel old open:', rrCancelErr.message)
  }
  { const { error: rrInsertErr } = await supabaseAdmin.from('task_resubmit_requests').insert({
      task_id:      taskId,
      requested_by: user.id,
      reason:       reason?.trim() || null,
    })
    if (rrInsertErr) console.error('[task_resubmit_requests] insert new request:', rrInsertErr.message)
  }
  // Structured status event: status flips to 'todo' on resubmit request
  { const { error: seErr } = await supabaseAdmin.from('task_status_events').insert({
    task_id:     taskId,
    from_status: task?.status as string ?? null,
    to_status:   'todo',
    note:        reason?.trim() || null,
    actor_id:    user.id,
    source:      'admin',
  }); if (seErr) console.error('[task_status_events] requestResubmit:', seErr.message) }
  await writeLog(supabase, taskId, 'resubmit_requested', user.id, {})

  if (task?.assigned_to) {
    await insertNotification(
      supabase,
      task.assigned_to,
      'resubmit_requested',
      taskId,
      'Yêu cầu thực hiện lại task',
      `Quản lý yêu cầu bạn thực hiện lại: "${task.title}"${reason ? ` — ${reason}` : ''}`
    )
  } else if (task?.store_id) {
    // Unassigned store-level task — notify all store managers of that store
    const { data: storeManagers } = await supabase
      .from('users')
      .select('id')
      .eq('store_id', task.store_id)
      .eq('role', 'store_manager')
    if (storeManagers?.length) {
      await supabaseAdmin.from('notifications').insert(
        storeManagers.map((m) => ({
          user_id: m.id,
          type:    'resubmit_requested',
          task_id: taskId,
          title:   'Yêu cầu thực hiện lại task',
          message: `Quản lý yêu cầu thực hiện lại: "${task.title}"${reason ? ` — ${reason}` : ''}`,
        }))
      )
    }
  }

  revalidatePath(`/tasks/${taskId}`)
  return { success: true }
}

export async function extendDeadline(taskId: string, newDeadline: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single()

  if (!newDeadline) return { error: 'Vui lòng chọn ngày gia hạn' }
  if (new Date(newDeadline) <= new Date())
    return { error: 'Deadline mới phải ở tương lai' }

  // Admin-only + own-scope.
  const { data: current } = await supabase
    .from('tasks').select('created_by, deadline, title, status, overdue_at').eq('id', taskId).single()
  if (!canAdminManageOwn({ email: user.email, role: profile?.role, createdBy: current?.created_by, userId: user.id }))
    return { error: 'Không có quyền gia hạn deadline cho task này' }

  // Extending to a future deadline makes the task actionable again. For any
  // non-done task we clear overdue_at so a subsequent on-time submission does
  // NOT render as "Hoàn thành trễ". This covers three cases:
  //   (a) status='overdue'   — also reset to 'todo' so getEffectiveStatus unlocks
  //   (b) status='in_progress' — store changed via RPC after cron flipped overdue_at
  //   (c) status='todo'      — admin requested resubmit on a late-done task;
  //                             task now has overdue_at set but is back to todo
  const update: { deadline: string; status?: TaskStatus; overdue_at?: null } = { deadline: newDeadline }
  if (current?.status !== 'done') {
    update.overdue_at = null
    if (current?.status === 'overdue') update.status = 'todo'
  }

  const { error } = await supabase
    .from('tasks').update(update).eq('id', taskId)
  if (error) return { error: error.message }

  await writeLog(supabase, taskId, 'deadline_extended', user.id, {
    from: current?.deadline ?? null,
    to:   newDeadline,
    status_reset: current?.status === 'overdue',
  })
  // Structured status event only when overdue task is revived (the meaningful
  // status transition). Non-overdue deadline changes don't alter status.
  if (current?.status === 'overdue') {
    const { error: seErr } = await supabaseAdmin.from('task_status_events').insert({
      task_id:     taskId,
      from_status: 'overdue',
      to_status:   'todo',
      note:        'deadline extended',
      actor_id:    user.id,
      source:      'admin',
    })
    if (seErr) console.error('[task_status_events] extendDeadline:', seErr.message)
  }

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${taskId}`)
  return { success: true }
}

export async function addReviewNote(taskId: string, note: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin')
    return { error: 'Chỉ admin mới được ghi chú quản lý' }

  // Task owner / super admin OR collaborator with editor permission.
  const { data: task } = await supabase
    .from('tasks').select('assigned_to, title, created_by').eq('id', taskId).single()
  const isOwner = canAdminManageOwn({ email: user.email, role: profile?.role, createdBy: task?.created_by, userId: user.id })
  const isEditor = isOwner || await isCollaboratorEditor(supabase, user.id, taskId)
  if (!isEditor) return { error: 'Chỉ admin tạo task hoặc editor được ghi chú' }

  // Review notes live in task_review_notes (not task_logs) so the audit log
  // stays clean and store managers don't see other admins' note text.
  const { error: noteErr } = await supabase.from('task_review_notes').insert({
    task_id:   taskId,
    author_id: user.id,
    kind:      'review_note',
    note,
  })
  if (noteErr) return { error: noteErr.message }

  // Audit marker — records the event without leaking note content to the log.
  await writeLog(supabase, taskId, 'review_note', user.id, {})

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

export async function archiveTasks(ids: string[]) {
  if (!ids.length) return { error: 'Không có task nào được chọn' }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Chưa đăng nhập' }

  // Admin-only. Own-scope is enforced by RLS (tasks_update_admin): a sub-admin's
  // update only affects their own tasks; super admin affects any.
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin')
    return { error: 'Không có quyền lưu trữ' }

  // Cascade: if any selected IDs are staff_all parents, also archive their children
  const { data: childRows } = await supabase.from('tasks').select('id').in('parent_task_id', ids)
  const allIds = childRows?.length ? [...new Set([...ids, ...childRows.map(r => r.id)])] : ids

  const { data: updated, error } = await supabase
    .from('tasks')
    .update({ archived_at: new Date().toISOString() })
    .in('id', allIds)
    .select('id')

  if (error) return { error: error.message }

  revalidatePath('/tasks')
  revalidatePath('/dashboard')
  return { success: true, count: updated?.length ?? 0 }
}

export async function restoreTasks(ids: string[]) {
  if (!ids.length) return { error: 'Không có task nào được chọn' }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Chưa đăng nhập' }

  // Admin-only. Own-scope enforced by RLS (tasks_update_admin).
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin')
    return { error: 'Không có quyền khôi phục' }

  // Cascade: if any selected IDs are staff_all parents, also restore their children
  const { data: childRows } = await supabase.from('tasks').select('id').in('parent_task_id', ids)
  const allIds = childRows?.length ? [...new Set([...ids, ...childRows.map(r => r.id)])] : ids

  const { data: updated, error } = await supabase
    .from('tasks')
    .update({ archived_at: null })
    .in('id', allIds)
    .select('id')

  if (error) return { error: error.message }

  revalidatePath('/tasks')
  revalidatePath('/dashboard')
  return { success: true, count: updated?.length ?? 0 }
}

// ─────────────────────────────────────────────────────────────────────────────
// Recurring task foundation
// ─────────────────────────────────────────────────────────────────────────────

export async function createTaskSchedule(data: {
  title: string
  description: string
  category: TaskCategory
  priority: TaskPriority
  requiredOutputs: RequiredOutput[]
  attachments: TaskAttachment[]
  links: { label: string; url: string }[]
  frequency: 'daily' | 'weekly' | 'monthly'
  runTime: string            // "HH:MM"
  weekdays: number[] | null  // 0=Sun … 6=Sat
  monthDay: number | null    // 1–28
  startDate: string          // ISO date "YYYY-MM-DD"
  endDate: string | null
  deadlineOffsetHours: number
  storeIds: string[]
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return { error: 'Chỉ Admin mới có thể tạo task định kỳ' }

  // Server-side validation
  if (!data.title.trim())       return { error: 'Tiêu đề không được để trống' }
  if (!data.startDate)          return { error: 'Vui lòng chọn ngày bắt đầu' }
  if (!data.storeIds.length)    return { error: 'Vui lòng chọn ít nhất một cửa hàng' }
  if (!/^\d{2}:\d{2}$/.test(data.runTime))
    return { error: 'Giờ chạy không hợp lệ' }
  if (data.deadlineOffsetHours <= 0)
    return { error: 'Deadline offset phải lớn hơn 0' }
  if (data.frequency === 'weekly' && (!data.weekdays || data.weekdays.length === 0))
    return { error: 'Vui lòng chọn ít nhất một ngày trong tuần' }
  if (data.frequency === 'monthly' && (!data.monthDay || data.monthDay < 1 || data.monthDay > 28))
    return { error: 'Ngày trong tháng phải từ 1 đến 28' }
  if (data.endDate && data.endDate < data.startDate)
    return { error: 'Ngày kết thúc phải sau ngày bắt đầu' }
  const attachErrS = validateAttachments(data.attachments)
  if (attachErrS) return { error: attachErrS }

  const uniqueStoreIds = [...new Set(data.storeIds)]

  // 1. Create template
  const config = {
    description:      data.description || undefined,
    category:         data.category,
    priority:         data.priority,
    visibility:       'store' as const,
    required_outputs: data.requiredOutputs,
    ...(data.attachments.length || data.links.length
      ? { input_data: { attachments: data.attachments, links: data.links } }
      : {}),
  }

  const { data: template, error: templateError } = await supabase
    .from('task_templates')
    .insert({ title: data.title, config, created_by: user.id })
    .select('id')
    .single()

  if (templateError || !template) return { error: templateError?.message ?? 'Không thể tạo template' }

  // 2. Compute first next_run_at using proper frequency logic
  const nextRunAt = computeNextRunAt(
    data.startDate, data.runTime, data.frequency, data.weekdays, data.monthDay
  )

  // 3. Create schedule
  const { data: schedule, error: schedError } = await supabase
    .from('task_schedules')
    .insert({
      template_id:           template.id,
      frequency:             data.frequency,
      timezone:              'Asia/Ho_Chi_Minh',
      run_time:              data.runTime,
      weekdays:              data.weekdays,
      month_day:             data.monthDay,
      start_date:            data.startDate,
      end_date:              data.endDate,
      deadline_offset_hours: data.deadlineOffsetHours,
      next_run_at:           nextRunAt,
    })
    .select('id')
    .single()

  if (schedError || !schedule) {
    await supabase.from('task_templates').delete().eq('id', template.id)
    return { error: schedError?.message ?? 'Không thể tạo lịch' }
  }

  // 4. Link stores
  const storeRows = uniqueStoreIds.map((storeId) => ({ schedule_id: schedule.id, store_id: storeId }))
  const { error: storesError } = await supabase.from('task_schedule_stores').insert(storeRows)
  if (storesError) {
    // Full rollback: schedule depends on template via FK CASCADE, so deleting template removes schedule too
    await supabase.from('task_schedules').delete().eq('id', schedule.id)
    await supabase.from('task_templates').delete().eq('id', template.id)
    return { error: storesError.message }
  }

  // 5. Audit log (no task_id — schedule-level event)
  await supabase.from('task_logs').insert({
    task_id:  null,
    action:   'schedule_created',
    user_id:  user.id,
    metadata: {
      schedule_id: schedule.id,
      template_id: template.id,
      title:       data.title,
      frequency:   data.frequency,
      store_count: uniqueStoreIds.length,
    },
  })

  revalidatePath('/tasks')
  revalidatePath('/tasks/schedules')
  return { success: true, scheduleId: schedule.id }
}

export async function pauseSchedule(scheduleId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return { error: 'Không có quyền' }

  const { error } = await supabase
    .from('task_schedules').update({ is_active: false }).eq('id', scheduleId)
  if (error) return { error: error.message }

  await supabase.from('task_logs').insert({
    task_id: null, action: 'schedule_paused', user_id: user.id,
    metadata: { schedule_id: scheduleId },
  })
  revalidatePath('/tasks/schedules')
  return { success: true }
}

export async function resumeSchedule(scheduleId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return { error: 'Không có quyền' }

  // Fetch schedule to recompute next_run_at
  const { data: sched } = await supabase
    .from('task_schedules')
    .select('frequency, run_time, weekdays, month_day, start_date')
    .eq('id', scheduleId)
    .single()

  const nextRunAt = sched ? computeNextRunAt(
    sched.start_date,
    sched.run_time,
    sched.frequency as 'daily' | 'weekly' | 'monthly',
    sched.weekdays as number[] | null,
    sched.month_day as number | null
  ) : null

  const { error } = await supabase.from('task_schedules')
    .update({ is_active: true, ...(nextRunAt ? { next_run_at: nextRunAt } : {}) })
    .eq('id', scheduleId)
  if (error) return { error: error.message }

  await supabase.from('task_logs').insert({
    task_id: null, action: 'schedule_resumed', user_id: user.id,
    metadata: { schedule_id: scheduleId },
  })
  revalidatePath('/tasks/schedules')
  return { success: true }
}
