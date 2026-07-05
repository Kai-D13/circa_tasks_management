'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { computeNextRunAt } from '@/lib/recurring'
import { enqueueTaskCreated } from '@/lib/teams/notifyTaskCreated'
import { canAdminManageOwn, getSmStoreIds, smHasStore } from '@/lib/authz'
import { CYCLE_COUNT_DEPT_ID } from '@/lib/inventory/constants'
import { publicStorageUrl } from '@/lib/storage/publicUrl'
import { sanitizeRichText } from '@/lib/richtext/sanitize'

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

// Server-side URL whitelist for staff_all instruction propagation. The dialog
// posts attachments + links straight into input_data (rendered downstream as
// <a href>), so the server must not trust them: NEW attachments may only point at
// our own task-uploads bucket under task-inputs/, and links must be plain http(s) —
// blocks javascript:/data:/file: and malformed URLs a client could smuggle in.
// Attachments already on the task (`grandfathered` set) are passed through even if
// they use a legacy storage host, so editing an old broadcast's text doesn't get
// rejected over a pre-existing file the admin never touched.
function validateInstructionUrls(
  attachments: { url?: string }[],
  links: { url?: string }[],
  grandfathered: Set<string>,
): string | null {
  let supaHost = ''
  try { supaHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host } catch { /* empty host blocks all */ }
  const PUBLIC_PREFIX = '/storage/v1/object/public/task-uploads/task-inputs/'
  for (const a of attachments) {
    if (a.url && grandfathered.has(a.url)) continue // pre-existing file — trust as-is
    let u: URL
    try { u = new URL(a.url ?? '') } catch { return `Đường dẫn file không hợp lệ: ${a.url ?? '(trống)'}` }
    if (u.protocol !== 'https:' || u.host !== supaHost || !u.pathname.startsWith(PUBLIC_PREFIX))
      return 'File đính kèm phải nằm trong kho lưu trữ của hệ thống'
  }
  for (const l of links) {
    let u: URL
    try { u = new URL(l.url ?? '') } catch { return `Link không hợp lệ: ${l.url ?? '(trống)'}` }
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      return 'Link chỉ chấp nhận http hoặc https'
  }
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
  if (requiredOutputsRaw.length === 0)
    return { error: 'Vui lòng chọn ít nhất một loại kết quả cần nộp' }
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
    // Optional per-staff subset (JSON array of user ids). Key ABSENT → legacy
    // "all staff". Key PRESENT but empty/malformed → the admin meant to pick a
    // subset, so don't silently over-assign to everyone — surface an error.
    let selectedStaffIds: string[] | undefined
    const rawSel = formData.get('selected_staff_ids') as string | null
    if (rawSel !== null) {
      let parsed: unknown
      try { parsed = JSON.parse(rawSel) } catch { return { error: 'Danh sách dược sĩ không hợp lệ' } }
      if (!Array.isArray(parsed)) return { error: 'Danh sách dược sĩ không hợp lệ' }
      selectedStaffIds = parsed.filter((x): x is string => typeof x === 'string')
    }
    return createStaffRequiredTask(supabase, user.id, {
      storeId:         storeIdVal,
      title:           formData.get('title') as string,
      description:     sanitizeRichText(formData.get('description') as string) || null,
      category:        (formData.get('category') as TaskCategory) || 'other',
      priority:        formData.get('priority') as TaskPriority,
      startDate:       formData.get('start_date') as string || null,
      deadline:        formData.get('deadline') as string || null,
      requiredOutputs: requiredOutputsRaw,
      inputData,
      selectedStaffIds,
    })
  }

  const { data: task, error } = await supabase.from('tasks').insert({
    title:            formData.get('title') as string,
    description:      sanitizeRichText(formData.get('description') as string) || null,
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
  await enqueueTaskCreated([{ taskId: task.id, storeId: storeIdVal }])

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
    selectedStaffIds?: string[]   // admin picked a subset; undefined = all staff
  },
) {
  // 1. Active pharmacists of the store. No is_active flag exists → all role='staff'.
  const { data: allStaff } = await supabase
    .from('users').select('id, full_name')
    .eq('role', 'staff').eq('store_id', p.storeId)
  if (!allStaff || allStaff.length === 0) {
    return { error: 'Cửa hàng chưa có dược sĩ nào để giao task' }
  }
  // Subset selection: a provided list (even empty) means "use exactly this set";
  // undefined means legacy "all staff". Intersect with the DB-fetched staff so a
  // tampered id (not a real staff of this store) can never receive a task. An
  // empty effective set is an error — never fall through to all.
  let staff = allStaff
  if (p.selectedStaffIds !== undefined) {
    const allow = new Set(p.selectedStaffIds)
    staff = allStaff.filter((s) => allow.has(s.id))
    if (staff.length === 0) {
      return { error: 'Chưa chọn dược sĩ nào hợp lệ để giao task' }
    }
  }

  // 2. Parent — private + unassigned so staff can't see it; managers/admins can.
  const { data: parent, error: parentErr } = await supabase.from('tasks').insert({
    title:            p.title,
    description:      sanitizeRichText(p.description) || null,
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
      description:      sanitizeRichText(p.description) || null,
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
  await enqueueTaskCreated([{ taskId: parent.id, storeId: p.storeId }])

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
  if (requiredOutputsRaw.length === 0)
    return { error: 'Vui lòng chọn ít nhất một loại kết quả cần nộp' }
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
    description:      sanitizeRichText(formData.get('description') as string) || null,
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

// Edit the shared instruction/attachments of a "staff_all" broadcast and propagate
// the change to EVERY parent + child task of that broadcast (all stores, all
// pharmacists), including already-done children — the attachment is reference
// material (e.g. a PDF guide), so a done pharmacist must still see the new file.
// This is the only sanctioned way to edit a staff_all parent (updateTask blocks it).
// Only the broadcast creator (or super admin) may do this. Does NOT touch status,
// deadline, required_outputs, assignment, store scope or completion metadata.
export async function updateStaffAllInstruction(parentTaskId: string, data: {
  title:       string
  description: string | null
  category:    TaskCategory
  priority:    TaskPriority
  attachments: TaskAttachment[]
  links:       { label: string; url: string }[]
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const { data: anchor } = await supabaseAdmin
    .from('tasks')
    .select('created_by, broadcast_id, assignment_mode, title, description, category, priority, input_data')
    .eq('id', parentTaskId).single()

  if (!anchor) return { error: 'Task không tồn tại' }
  if ((anchor as { assignment_mode?: string }).assignment_mode !== 'staff_all')
    return { error: 'Chỉ áp dụng cho task "Toàn bộ dược sĩ"' }
  // Admin + own-scope: super admin any broadcast, sub-admin (PIC) only ones they
  // created. All parents of a broadcast share created_by, so one check covers the set.
  if (!canAdminManageOwn({ email: user.email, role: profile?.role, createdBy: anchor.created_by, userId: user.id }))
    return { error: 'Bạn không có quyền chỉnh sửa task này' }

  if (!data.title?.trim()) return { error: 'Vui lòng nhập tiêu đề' }

  // Normalize + shape-validate the client-supplied payload before it touches
  // input_data. Attachments must have string url/name/type and a numeric size (if
  // present); links get their label/url trimmed and empties dropped.
  const attachments: TaskAttachment[] = []
  for (const raw of (data.attachments ?? [])) {
    const a = raw as unknown as Record<string, unknown>
    if (typeof a?.url !== 'string' || typeof a?.name !== 'string' || typeof a?.type !== 'string')
      return { error: 'Dữ liệu file đính kèm không hợp lệ' }
    if (a.size != null && (typeof a.size !== 'number' || !Number.isFinite(a.size) || a.size < 0))
      return { error: 'Dữ liệu file đính kèm không hợp lệ' }
    attachments.push({
      url: a.url.trim(), name: a.name.trim(), type: a.type.trim(),
      ...(a.size != null ? { size: a.size as number } : {}),
    })
  }
  const links = (data.links ?? [])
    .map((l) => ({ label: (l.label ?? '').trim(), url: (l.url ?? '').trim() }))
    .filter((l) => l.url)

  const attachErr = validateAttachments(attachments)
  if (attachErr) return { error: attachErr }

  // Previous attachments/links — used both to grandfather pre-existing files
  // through URL validation and to detect what actually changed for the audit log.
  const prevAtts  = ((anchor.input_data as { attachments?: TaskAttachment[] } | null)?.attachments ?? [])
  const prevLinks = ((anchor.input_data as { links?: { label: string; url: string }[] } | null)?.links ?? [])
  const existingUrls = new Set(prevAtts.map((a) => a.url).filter(Boolean) as string[])

  // Don't trust client-supplied URLs — whitelist (new) attachments + links before
  // they land in input_data; pre-existing files are grandfathered.
  const urlErr = validateInstructionUrls(attachments, links, existingUrls)
  if (urlErr) return { error: urlErr }

  // Resolve the full set of tasks to update. Multi-store broadcasts share a
  // broadcast_id across their staff_all parents; a single-store staff_all
  // (createStaffRequiredTask) has none, so it's just this one parent.
  let parentIds: string[]
  if (anchor.broadcast_id) {
    const { data: parents, error: parentsErr } = await supabaseAdmin
      .from('tasks').select('id').eq('broadcast_id', anchor.broadcast_id).eq('assignment_mode', 'staff_all')
    // A transient query error here would silently shrink the scope to a single
    // parent — fail instead of doing a partial propagation that reports success.
    if (parentsErr) return { error: 'Không tải được danh sách task cha: ' + parentsErr.message }
    parentIds = (parents ?? []).map((p: { id: string }) => p.id)
    if (parentIds.length === 0) return { error: 'Không tìm thấy task cha của broadcast này' }
  } else {
    parentIds = [parentTaskId]
  }

  const { data: children, error: childrenErr } = await supabaseAdmin
    .from('tasks').select('id').in('parent_task_id', parentIds)
  if (childrenErr) return { error: 'Không tải được danh sách task con: ' + childrenErr.message }
  // Not filtered by archived_at on purpose — keep the reference doc consistent
  // across archived copies too.
  const childIds = (children ?? []).map((c: { id: string }) => c.id)
  const allIds = [...parentIds, ...childIds]

  // Merge onto the anchor's existing input_data so any future metadata keys are
  // preserved (we only own attachments + links). All broadcast rows are created
  // identically, so the anchor's other keys mirror every row's — applying the
  // anchor's merged object uniformly is safe here. Collapse to null only when
  // there is genuinely nothing left to store.
  const baseMeta = { ...((anchor.input_data as Record<string, unknown> | null) ?? {}) }
  delete baseMeta.attachments
  delete baseMeta.links
  const hasOtherMeta = Object.keys(baseMeta).length > 0
  const inputData = (attachments.length || links.length)
    ? { ...baseMeta, attachments, links }
    : (hasOtherMeta ? baseMeta : null)

  // Sanitize once → used for BOTH the write and the changed-fields compare so
  // the audit can't disagree with what was actually stored.
  const cleanDescription = sanitizeRichText(data.description)

  const { error: updErr } = await supabaseAdmin.from('tasks').update({
    title:       data.title.trim(),
    description: cleanDescription,
    category:    data.category,
    priority:    data.priority,
    input_data:  inputData,
  }).in('id', allIds)
  if (updErr) return { error: updErr.message }

  // Audit: which fields actually changed (vs the anchor) + reach of the propagation.
  // Attachments/links are compared by normalized content (not just count) so
  // swapping PDF A → PDF B, or editing a link, is recorded even when the count is
  // unchanged.
  const normAtts  = (a: TaskAttachment[]) => JSON.stringify(a.map((x) => [x.url, x.name, x.type, x.size ?? null]))
  const normLinks = (l: { label: string; url: string }[]) => JSON.stringify(l.map((x) => [x.label, x.url]))
  const changed: string[] = []
  if (anchor.title !== data.title.trim())               changed.push('title')
  if ((anchor.description ?? '') !== cleanDescription)   changed.push('description')
  if (anchor.category !== data.category)                changed.push('category')
  if (anchor.priority !== data.priority)                changed.push('priority')
  if (normAtts(prevAtts) !== normAtts(attachments))     changed.push('attachments')
  if (normLinks(prevLinks) !== normLinks(links))        changed.push('links')

  // One log per parent (filterable per store), tagged with the broadcast + reach.
  const logs = parentIds.map((pid) => ({
    task_id:  pid,
    action:   'staff_all_instruction_updated',
    user_id:  user.id,
    metadata: {
      broadcast_id:   anchor.broadcast_id ?? null,
      title:          data.title.trim(),
      changed_fields: changed,
      parent_count:   parentIds.length,
      child_count:    childIds.length,
      applied_to:     allIds.length,
      old_attachment_count: prevAtts.length,
      new_attachment_count: attachments.length,
      old_link_count: prevLinks.length,
      new_link_count: links.length,
    },
  }))
  const { error: logErr } = await supabaseAdmin.from('task_logs').insert(logs)
  if (logErr) console.error('[updateStaffAllInstruction] task_logs:', logErr.message)

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${parentTaskId}`)
  return { success: true, count: allIds.length }
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

export async function submitTask(
  taskId: string,
  outputData: Record<string, unknown>,
  performedBy?: string | null,
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  // Fetch the task for fast-fail checks + required-output validation. The submit
  // itself (dup-check + insert result + flip to done + status event + log) runs
  // atomically in rpc_submit_task_result under a row lock, so two store members
  // submitting at the same time can't create duplicate results or leave the task
  // with a result but not 'done'.
  const { data: task } = await supabase
    .from('tasks')
    .select('created_by, title, required_outputs, assignment_mode')
    .eq('id', taskId)
    .single()

  if (!task) return { error: 'Task không tồn tại' }

  // A staff_all parent is overview-only — fast-fail with a clear message (the RPC
  // rejects it too).
  if (task.assignment_mode === 'staff_all') {
    return { error: 'Đây là task cha — vui lòng nộp kết quả trên task con của bạn.' }
  }

  // Validate each required output is present (pure + race-free) before the RPC.
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

  // Atomic core: validates submitter/role/store, blocks duplicates under a row
  // lock, inserts the result, flips the task to done, writes the status event + log.
  const { data: rpcData, error: rpcError } = await supabase.rpc('rpc_submit_task_result', {
    p_task_id:      taskId,
    p_output_data:  outputData,
    p_performed_by: performedBy ?? null,
  })
  if (rpcError) return { error: rpcError.message }
  const rpc = rpcData as { error?: string; result_id?: string; submitted_late?: boolean } | null
  if (rpc?.error) return { error: rpc.error }
  const resultId      = rpc?.result_id ?? null
  const submittedLate = rpc?.submitted_late ?? false

  // ---- Best-effort side effects (outside the transaction; never block success) ----

  // Link tracked upload metadata rows to this result. fileId is stored in each
  // ImageAttachment by MultiImageUpload (Batch D+). A link failure must not block.
  const imageAtts = (outputData['image'] as Array<{ fileId?: string }> | undefined) ?? []
  const fileIds = imageAtts.map((a) => a.fileId).filter((id): id is string => !!id)
  if (resultId && fileIds.length > 0) {
    const { error: linkErr } = await supabaseAdmin
      .from('task_uploaded_files')
      .update({ result_id: resultId, linked_at: new Date().toISOString() })
      .in('id', fileIds)
      .eq('task_id', taskId)
      .eq('uploaded_by', user.id)
      .is('linked_at', null)
    if (linkErr) console.error('[task_uploaded_files link]', linkErr.message)
  }

  if (task.created_by && task.created_by !== user.id) {
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

  // Admin + own-scope, OR SM for tasks in their assigned stores.
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const isSm = profile?.role === 'sm'
  const { data: reassignTask } = await supabaseAdmin.from('tasks')
    .select('created_by, store_id, status, completed_by, resubmit_requested_at')
    .eq('id', taskId).single()

  const isAdminOwner = canAdminManageOwn({ email: user.email, role: profile?.role, createdBy: reassignTask?.created_by, userId: user.id })
  let isSmForTask = false
  if (isSm) {
    const smStoreIds = await getSmStoreIds(supabase, user.id)
    isSmForTask = smHasStore(smStoreIds, reassignTask?.store_id as string | null)
  }
  if (!isAdminOwner && !isSmForTask)
    return { error: 'Không có quyền phân công task này' }

  // Block reassign once the task has a valid submission. Gate on the submission
  // itself (completed_by, or a result after the last resubmit request), not just
  // status — status can drift in old data while a real result exists.
  if (reassignTask?.completed_by || reassignTask?.status === 'done') {
    return { error: 'Task đã có kết quả nộp, không thể phân công lại. Vui lòng yêu cầu làm lại nếu cần chỉnh sửa.' }
  }
  {
    let resultQ = supabase.from('task_results').select('id', { count: 'exact', head: true }).eq('task_id', taskId)
    if (reassignTask?.resubmit_requested_at) resultQ = resultQ.gt('submitted_at', reassignTask.resubmit_requested_at)
    const { count: validResultCount } = await resultQ
    if ((validResultCount ?? 0) > 0)
      return { error: 'Task đã có kết quả nộp, không thể phân công lại. Vui lòng yêu cầu làm lại nếu cần chỉnh sửa.' }
  }

  // If assigning to a specific user, they must belong to the same store as the task.
  // SM may only assign to staff (not other managers or admins).
  if (assignedTo) {
    const { data: assignee } = await supabase.from('users').select('store_id, role').eq('id', assignedTo).single()
    if (assignee?.store_id !== reassignTask?.store_id)
      return { error: 'Người được phân công phải thuộc cùng cửa hàng với task' }
    if (isSmForTask && assignee?.role !== 'staff')
      return { error: 'SM chỉ được phân công task cho Nhân viên' }
  }

  const visibility: TaskVisibility = assignedTo ? 'private' : 'store'

  // SM has no RLS UPDATE policy — use supabaseAdmin after app-layer validation above.
  const updateClient = isSmForTask ? supabaseAdmin : supabase
  const { error } = await updateClient
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
  // staff_all only: per-store subset of pharmacist ids. A store absent here keeps
  // all its staff (backward compatible); a store present gets only the listed ids.
  selectedStaffByStore?: Record<string, string[]>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return { error: 'Chỉ admin mới được tạo task broadcast' }

  if (!params.storeIds.length) return { error: 'Vui lòng chọn ít nhất một cửa hàng' }
  if (!params.requiredOutputs?.length) return { error: 'Vui lòng chọn ít nhất một loại kết quả cần nộp' }

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

    // Per-store subset: intersect each store's selection with its DB staff (so a
    // tampered/foreign id can't receive a task). Stores not listed keep all staff.
    if (params.selectedStaffByStore) {
      for (const [sid, ids] of Object.entries(params.selectedStaffByStore)) {
        // Validate the payload shape before trusting it — a malformed value must
        // return a clean error, never throw a 500 at `new Set(ids)`.
        if (!Array.isArray(ids)) return { error: 'Danh sách dược sĩ không hợp lệ' }
        const cur = staffByStore.get(sid)
        if (!cur) continue
        const allow = new Set(ids.filter((x): x is string => typeof x === 'string'))
        staffByStore.set(sid, cur.filter((s) => allow.has(s.id)))
      }
    }

    // Without a selection, a store with zero pharmacists is a data error the admin
    // must fix (preserve the original hard stop). With a selection, a store left
    // with nobody was intentionally cleared in the form — skip it silently.
    if (!params.selectedStaffByStore) {
      const emptyStoreIds = params.storeIds.filter(id => !(staffByStore.get(id)?.length))
      if (emptyStoreIds.length > 0) {
        const { data: emptyNames } = await supabaseAdmin
          .from('stores').select('id, name').in('id', emptyStoreIds)
        const names = (emptyNames ?? []).map(s => s.name).join(', ')
        return { error: `Cửa hàng chưa có dược sĩ: ${names}. Vui lòng thêm dược sĩ trước.` }
      }
    }
    const effectiveStoreIds = params.storeIds.filter(id => (staffByStore.get(id)?.length ?? 0) > 0)
    if (effectiveStoreIds.length === 0) {
      return { error: 'Chưa chọn dược sĩ nào để giao task' }
    }

    const { data: bcast, error: bcastErrSA } = await supabase
      .from('task_broadcasts')
      .insert({ title: params.title, created_by: user.id, store_count: effectiveStoreIds.length })
      .select().single()
    if (bcastErrSA || !bcast) return { error: bcastErrSA?.message ?? 'Lỗi tạo broadcast' }

    const saInputData = (params.attachments?.length || params.links?.length)
      ? { attachments: params.attachments ?? [], links: params.links ?? [] }
      : null

    const parentsToInsert = effectiveStoreIds.map(sid => ({
      title:            params.title,
      description:      sanitizeRichText(params.description) || null,
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
        description:      sanitizeRichText(params.description) || null,
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
      .from('users').select('id, store_id').eq('role', 'store_manager').in('store_id', effectiveStoreIds)
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

    // Teams notification per store parent — enqueue (sent by cron dispatcher)
    await enqueueTaskCreated(saParents.map(p => ({ taskId: p.id, storeId: p.store_id! })))

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
    description:      sanitizeRichText(params.description) || null,
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

  // Teams notification per store — enqueue (sent by cron dispatcher). Without
  // this, store-mode broadcasts never reached n8n/Teams.
  await enqueueTaskCreated((created ?? []).map((t) => ({ taskId: t.id, storeId: t.store_id })))

  revalidatePath('/tasks')
  redirect('/tasks')
}

// Excel split import: admin uploads one master file (already in storage at
// masterPath); we split rows by pos_code (= stores.code) into one store task each,
// attaching that store's slice as an xlsx. All parsing/validation is server-side
// (the client preview is not trusted) and the batch + tasks + logs are inserted
// atomically via rpc_create_import_tasks. See migration 034.
const IMPORT_MAX_ROWS       = 2000
const IMPORT_MAX_STORES     = 30
const IMPORT_MAX_FILE_BYTES = 20 * 1024 * 1024
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export async function createImportedStoreTasks(params: {
  masterPath:      string
  sheetName:       string
  posColumn:       string
  scope:           'multi' | 'all'
  allowedStoreIds: string[]
  title:           string
  description:     string
  category:        TaskCategory
  priority:        TaskPriority
  startDate:       string
  deadline:        string
  requiredOutputs: RequiredOutput[]
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return { error: 'Chỉ admin mới được import task' }

  // masterPath is passed by the client and fed to a service-role download, so it
  // must be validated: confined to the import prefix, no traversal, known ext.
  const masterPath = params.masterPath ?? ''
  if (!masterPath.startsWith('task-inputs/import/') || masterPath.includes('..') ||
      !/\.(xlsx|xls|csv)$/i.test(masterPath)) {
    return { error: 'Đường dẫn file không hợp lệ' }
  }

  // Cleanup helper: best-effort removal of the master + any generated slices so a
  // validation/RPC failure doesn't leave orphans under task-inputs/import/.
  // Defined before param checks so early validation failures also remove the master
  // the client already uploaded to storage.
  const uploadedPaths: string[] = []
  const cleanup = async () => {
    const paths = [masterPath, ...uploadedPaths]
    try { await supabaseAdmin.storage.from('task-uploads').remove(paths) } catch { /* best-effort */ }
  }
  const fail = async (error: string) => { await cleanup(); return { error } }

  // Task field validation — use fail() so the master upload is cleaned up on error.
  if (!params.title?.trim())            return fail('Vui lòng nhập tiêu đề task')
  if (!params.posColumn)                return fail('Chưa xác định cột POS code')
  if (!params.sheetName)                return fail('Chưa chọn sheet dữ liệu')
  if (!params.requiredOutputs?.length)  return fail('Chọn ít nhất 1 loại output yêu cầu')
  if (!params.allowedStoreIds?.length)  return fail('Vui lòng chọn ít nhất một cửa hàng')
  const dateErr = validateTaskDates(params.startDate || null, params.deadline || null)
  if (dateErr) return fail(dateErr)

  // Download + parse the master file (service role; lives under task-inputs/).
  const { data: fileBlob, error: dlErr } = await supabaseAdmin.storage
    .from('task-uploads').download(masterPath)
  if (dlErr || !fileBlob) return fail('Không tải được file import')

  if (fileBlob.size > IMPORT_MAX_FILE_BYTES) {
    return fail(`File quá lớn (tối đa ${IMPORT_MAX_FILE_BYTES / (1024 * 1024)}MB)`)
  }

  let rows: Record<string, unknown>[]
  try {
    const buf = await fileBlob.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const sheet = wb.Sheets[params.sheetName]
    if (!sheet) return fail(`Không tìm thấy sheet "${params.sheetName}" trong file`)
    // raw:false → cells are formatted text (dates render as readable strings, not
    // Excel serial numbers) so the per-store slice stays human-readable.
    rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false })
  } catch {
    return fail('Không đọc được file Excel')
  }

  if (rows.length === 0) return fail('Sheet không có dữ liệu')
  if (rows.length > IMPORT_MAX_ROWS) {
    return fail(`File vượt giới hạn ${IMPORT_MAX_ROWS.toLocaleString('vi-VN')} dòng (hiện ${rows.length.toLocaleString('vi-VN')})`)
  }

  // Group rows by POS code (case-insensitive on the chosen column).
  const grouped = new Map<string, Record<string, unknown>[]>()
  for (const row of rows) {
    const code = String(row[params.posColumn] ?? '').trim().toUpperCase()
    if (!code) continue
    const list = grouped.get(code) ?? []
    list.push(row)
    grouped.set(code, list)
  }
  if (grouped.size === 0) return fail('Không tìm thấy POS code nào trong cột đã chọn')

  // Resolve POS → store against stores.code (server-side re-match; client mapping not trusted).
  const { data: stores, error: storesErr } = await supabase.from('stores').select('id, name, code')
  if (storesErr) return fail('Lỗi khi lấy danh sách cửa hàng: ' + storesErr.message)
  const storeByCode = new Map((stores ?? []).map((s) => [s.code.toUpperCase(), s]))
  const allowed = new Set(params.allowedStoreIds)

  // Strict scoping: every POS in the file must map to a store INSIDE the chosen
  // scope (multi = selected stores, all = every store). A POS that matches no
  // store, or matches a store outside the allow-list, blocks the whole import so
  // data never lands on a store the admin didn't target.
  const matched: { store: { id: string; name: string; code: string }; posCode: string; rows: Record<string, unknown>[] }[] = []
  const outside: string[] = []
  for (const [code, list] of grouped) {
    const store = storeByCode.get(code)
    if (store && allowed.has(store.id)) matched.push({ store, posCode: code, rows: list })
    else outside.push(code)
  }

  if (outside.length > 0) {
    const shown = outside.slice(0, 10).join(', ')
    const extra = outside.length > 10 ? ` +${outside.length - 10} POS khác` : ''
    return fail(`POS ngoài phạm vi cửa hàng đã chọn: ${shown}${extra}. Vui lòng tách file đúng phạm vi.`)
  }
  if (matched.length === 0)               return fail('Không có cửa hàng nào khớp POS code')
  if (matched.length > IMPORT_MAX_STORES) return fail(`Vượt giới hạn ${IMPORT_MAX_STORES} cửa hàng (hiện ${matched.length})`)

  // Generate + upload one xlsx slice per store; build the per-task payloads.
  const batchId  = crypto.randomUUID()
  const fileName = masterPath.split('/').pop() ?? 'import.xlsx'
  const baseName = fileName.replace(/\.[^.]+$/, '')

  const tasksPayload: Record<string, unknown>[] = []
  for (const m of matched) {
    const sliceWb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(sliceWb, XLSX.utils.json_to_sheet(m.rows), 'Data')
    const sliceBuf = XLSX.write(sliceWb, { type: 'buffer', bookType: 'xlsx' }) as Buffer

    const path = `task-inputs/import/${batchId}/${m.posCode}.xlsx`
    const { error: upErr } = await supabaseAdmin.storage
      .from('task-uploads').upload(path, sliceBuf, { contentType: XLSX_MIME, upsert: true })
    if (upErr) return fail(`Lỗi tải file cho ${m.posCode}: ${upErr.message}`)
    uploadedPaths.push(path)
    const publicUrl = publicStorageUrl('task-uploads', path)

    tasksPayload.push({
      store_id:         m.store.id,
      title:            params.title,
      description:      sanitizeRichText(params.description) || null,
      category:         params.category || 'other',
      priority:         params.priority,
      start_date:       params.startDate || null,
      deadline:         params.deadline || null,
      required_outputs: params.requiredOutputs,
      input_data: {
        attachments: [{ url: publicUrl, name: `${m.posCode}_${baseName}.xlsx`, type: XLSX_MIME, size: sliceBuf.length }],
        pos_code:        m.posCode,
        file_name:       fileName,
        row_count:       m.rows.length,
        import_batch_id: batchId,
      },
    })
  }

  const masterUrl = publicStorageUrl('task-uploads', masterPath)

  // Atomic: batch + N tasks + logs (rpc returns { error } or { success, task_ids }).
  const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_create_import_tasks', {
    p_batch: {
      id:              batchId,
      file_name:       fileName,
      sheet_name:      params.sheetName,
      pos_column:      params.posColumn,
      total_rows:      rows.length,
      matched_count:   matched.length,
      unmatched_pos:   [],
      master_file_url: masterUrl,
    },
    p_tasks: tasksPayload,
  })
  // On failure, clean up the master + all slices — no batch row was created so all
  // storage files are orphans.
  if (rpcErr)        { await cleanup(); return { error: rpcErr.message } }
  const result = rpcData as { error?: string; success?: boolean } | null
  if (result?.error) { await cleanup(); return { error: result.error } }

  // Best-effort, outside the transaction: notify store managers + Teams.
  // Re-fetch by batch to map store → task (RPC array order is not guaranteed).
  try {
    const { data: created } = await supabase
      .from('tasks').select('id, store_id').eq('import_batch_id', batchId)
    const taskByStore = new Map((created ?? []).map((t) => [t.store_id, t.id]))

    const { data: managers } = await supabase
      .from('users').select('id, store_id')
      .eq('role', 'store_manager')
      .in('store_id', matched.map((m) => m.store.id))

    const notifications = (managers ?? [])
      .map((mgr) => {
        const taskId = taskByStore.get(mgr.store_id)
        return taskId ? {
          user_id: mgr.id, type: 'task_assigned', task_id: taskId,
          title:   'Task mới cho cửa hàng',
          message: `Task mới: ${params.title}`,
        } : null
      })
      .filter((n): n is NonNullable<typeof n> => n !== null)
    if (notifications.length) await supabaseAdmin.from('notifications').insert(notifications)

    await enqueueTaskCreated(
      matched
        .map((m) => ({ taskId: taskByStore.get(m.store.id), storeId: m.store.id }))
        .filter((x): x is { taskId: string; storeId: string } => !!x.taskId),
    )
  } catch (e) {
    console.error('createImportedStoreTasks notifications error:', e)
  }

  revalidatePath('/tasks')
  return { success: true, count: matched.length }
}

export async function requestResubmit(taskId: string, reason?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  // Requesting resubmit: task owner/super admin OR editor collaborator OR SM for their stores.
  const { data: profile } = await supabase
    .from('users').select('role, department_id').eq('id', user.id).single()
  const { data: task } = await supabaseAdmin
    .from('tasks').select('created_by, assigned_to, title, store_id, deadline, status, source_type').eq('id', taskId).single()
  const isSm = profile?.role === 'sm'
  const isOwnerR = canAdminManageOwn({ email: user.email, role: profile?.role, createdBy: task?.created_by, userId: user.id })
  // Cycle Count admins may request resubmit on TRF tasks (view+resubmit only).
  const isCycleCountTrf = profile?.role === 'admin'
    && (task as { source_type?: string } | null)?.source_type === 'inventory_trf'
    && (profile as { department_id?: string | null } | null)?.department_id === CYCLE_COUNT_DEPT_ID
  let isSmForTask = false
  if (isSm) {
    const smStoreIds = await getSmStoreIds(supabase, user.id)
    isSmForTask = smHasStore(smStoreIds, task?.store_id as string | null)
  }
  if (!isOwnerR && !isSmForTask && !isCycleCountTrf && !(await isCollaboratorEditor(supabase, user.id, taskId)))
    return { error: 'Không có quyền yêu cầu làm lại task này' }

  // Ensure task actually has results before allowing resubmit request
  const { count: resultCount } = await supabaseAdmin
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
    .update({
      status: 'todo',
      resubmit_requested_at: new Date().toISOString(),
      // Reopening the task: clear the completion metadata so it no longer claims
      // "đã hoàn thành bởi X" while awaiting a fresh result (keeps reporting honest).
      completed_by: null,
      completed_at: null,
    })
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
    source:      isSmForTask ? 'sm' : 'admin',
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

// Bulk version of requestResubmit — same side-effects, server-side, with a
// preflight so the admin sees how many are valid vs skipped before committing.
// Eligible = has a submitted result + NOT a staff_all parent + caller has rights
// (owner/super OR editor collaborator OR SM for the store). Skips the rest.
export async function bulkRequestResubmit(
  taskIds: string[],
  reason?: string,
  opts?: { preflight?: boolean },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const ids = [...new Set((taskIds ?? []).filter((x): x is string => typeof x === 'string'))]
  if (!ids.length) return { error: 'Chưa chọn task nào' }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const isSm = profile?.role === 'sm'
  const smStoreIds = isSm ? await getSmStoreIds(supabase, user.id) : []

  type Row = { id: string; created_by: string | null; assigned_to: string | null; title: string; store_id: string | null; status: string; assignment_mode: string | null }
  const { data: rows, error: rowsErr } = await supabaseAdmin
    .from('tasks')
    .select('id, created_by, assigned_to, title, store_id, status, assignment_mode')
    .in('id', ids)
  if (rowsErr) return { error: rowsErr.message }
  const taskMap = new Map<string, Row>((rows ?? []).map((t) => [t.id as string, t as Row]))

  const { data: resultRows, error: resultErr } = await supabaseAdmin
    .from('task_results').select('task_id').in('task_id', ids)
  if (resultErr) return { error: resultErr.message }
  const hasResult = new Set((resultRows ?? []).map((r) => r.task_id as string))

  const valid: Row[] = []
  let skippedCount = 0
  for (const id of ids) {
    const t = taskMap.get(id)
    if (!t) { skippedCount++; continue }
    if (t.assignment_mode === 'staff_all') { skippedCount++; continue }   // overview parent
    if (!hasResult.has(id)) { skippedCount++; continue }                  // nothing submitted yet
    const isOwnerR = canAdminManageOwn({ email: user.email, role: profile?.role, createdBy: t.created_by, userId: user.id })
    const isSmForTask = isSm && smHasStore(smStoreIds, t.store_id)
    let ok = isOwnerR || isSmForTask
    if (!ok) ok = await isCollaboratorEditor(supabase, user.id, id)
    if (!ok) { skippedCount++; continue }
    valid.push(t)
  }

  if (opts?.preflight) {
    return { preflight: true as const, validCount: valid.length, skippedCount }
  }
  if (!valid.length) return { error: 'Không có task hợp lệ để yêu cầu làm lại (task cha / chưa có kết quả / không có quyền)' }

  const validIds = valid.map((t) => t.id)
  const trimmed = reason?.trim() || null

  // Atomic: task reopen + resubmit_requests + review_notes + status_events + logs
  // all in ONE transaction (migration 065) — no partial audit on failure.
  const { data: updatedCount, error: rpcErr } = await supabaseAdmin.rpc('rpc_bulk_request_resubmit', {
    p_task_ids: validIds,
    p_reason:   trimmed,
    p_actor:    user.id,
    p_source:   isSm ? 'sm' : 'admin',
  })
  if (rpcErr) return { error: rpcErr.message }
  const applied = typeof updatedCount === 'number' ? updatedCount : validIds.length
  if (applied !== validIds.length) {
    console.error(`[bulkRequestResubmit] expected ${validIds.length} updates, RPC applied ${applied}`)
  }

  // Notifications: assignee (user tasks) + store managers (store-level tasks).
  const notifs: { user_id: string; type: string; task_id: string; title: string; message: string }[] = []
  for (const t of valid) {
    if (t.assigned_to) notifs.push({ user_id: t.assigned_to, type: 'resubmit_requested', task_id: t.id, title: 'Yêu cầu thực hiện lại task', message: `Quản lý yêu cầu bạn thực hiện lại: "${t.title}"${trimmed ? ` — ${trimmed}` : ''}` })
  }
  const storeLevel = valid.filter((t) => !t.assigned_to && t.store_id)
  if (storeLevel.length) {
    const storeIds = [...new Set(storeLevel.map((t) => t.store_id as string))]
    const { data: mgrs } = await supabaseAdmin.from('users').select('id, store_id').eq('role', 'store_manager').in('store_id', storeIds)
    for (const t of storeLevel) for (const m of (mgrs ?? []).filter((x) => x.store_id === t.store_id)) {
      notifs.push({ user_id: m.id as string, type: 'resubmit_requested', task_id: t.id, title: 'Yêu cầu thực hiện lại task', message: `Quản lý yêu cầu thực hiện lại: "${t.title}"${trimmed ? ` — ${trimmed}` : ''}` })
    }
  }
  if (notifs.length) {
    const { error: notifErr } = await supabaseAdmin.from('notifications').insert(notifs)
    if (notifErr) console.error('[bulkRequestResubmit] notifications insert failed:', notifErr.message)
  }

  revalidatePath('/tasks')
  return { success: true, count: applied, skippedCount }
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

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const isSm = profile?.role === 'sm'

  if (profile?.role !== 'admin' && !isSm)
    return { error: 'Không có quyền lưu trữ' }

  // Cascade first: build the full set of IDs (parents + any staff_all children)
  // so the SM scope check below covers every row that will be written.
  const { data: childRows } = await supabaseAdmin.from('tasks').select('id').in('parent_task_id', ids)
  const allIds = childRows?.length ? [...new Set([...ids, ...childRows.map(r => r.id)])] : ids

  // SM: validate the full allIds set (parents + cascaded children) are all in scope.
  // Using allIds here prevents a bypass where a parent is in scope but its children are not.
  if (isSm) {
    const smStoreIds = await getSmStoreIds(supabase, user.id)
    const { data: taskRows } = await supabaseAdmin.from('tasks').select('id, store_id').in('id', allIds)
    const allInScope = (taskRows ?? []).every((t) => smHasStore(smStoreIds, t.store_id as string | null))
    if (!allInScope) return { error: 'Bạn không có quyền lưu trữ task này' }
  }

  // Admin: RLS-scoped via supabase client (own-scope enforced by tasks_update_admin).
  // SM: no RLS UPDATE policy — must use supabaseAdmin; app-layer validation above is the gate.
  const client = isSm ? supabaseAdmin : supabase
  const { data: updated, error } = await client
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

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const isSm = profile?.role === 'sm'

  if (profile?.role !== 'admin' && !isSm)
    return { error: 'Không có quyền khôi phục' }

  // Cascade first: build the full set of IDs (parents + any staff_all children)
  // so the SM scope check below covers every row that will be written.
  const { data: childRows } = await supabaseAdmin.from('tasks').select('id').in('parent_task_id', ids)
  const allIds = childRows?.length ? [...new Set([...ids, ...childRows.map(r => r.id)])] : ids

  // SM: validate the full allIds set (parents + cascaded children) are all in scope.
  if (isSm) {
    const smStoreIds = await getSmStoreIds(supabase, user.id)
    const { data: taskRows } = await supabaseAdmin.from('tasks').select('id, store_id').in('id', allIds)
    const allInScope = (taskRows ?? []).every((t) => smHasStore(smStoreIds, t.store_id as string | null))
    if (!allInScope) return { error: 'Bạn không có quyền khôi phục task này' }
  }

  const client = isSm ? supabaseAdmin : supabase
  const { data: updated, error } = await client
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
  assignmentMode?: 'store' | 'staff_all'   // 'staff_all' = one task per pharmacist per store, each run
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return { error: 'Chỉ Admin mới có thể tạo task định kỳ' }
  const assignmentMode = data.assignmentMode === 'staff_all' ? 'staff_all' : 'store'

  // Server-side validation
  if (!data.title.trim())       return { error: 'Tiêu đề không được để trống' }
  if (!data.startDate)          return { error: 'Vui lòng chọn ngày bắt đầu' }
  if (!data.storeIds.length)    return { error: 'Vui lòng chọn ít nhất một cửa hàng' }
  if (!/^\d{2}:\d{2}$/.test(data.runTime))
    return { error: 'Giờ chạy không hợp lệ' }
  if (!Number.isInteger(data.deadlineOffsetHours) || data.deadlineOffsetHours < 1 || data.deadlineOffsetHours > 168)
    return { error: 'Deadline offset phải là số giờ nguyên từ 1 đến 168' }
  if (data.frequency === 'weekly' && (!data.weekdays || data.weekdays.length === 0))
    return { error: 'Vui lòng chọn ít nhất một ngày trong tuần' }
  if (data.frequency === 'monthly' && (!data.monthDay || data.monthDay < 1 || data.monthDay > 28))
    return { error: 'Ngày trong tháng phải từ 1 đến 28' }
  if (data.endDate && data.endDate < data.startDate)
    return { error: 'Ngày kết thúc phải sau ngày bắt đầu' }
  if (!data.requiredOutputs || data.requiredOutputs.length === 0)
    return { error: 'Vui lòng chọn ít nhất một loại kết quả cần nộp' }
  const attachErrS = validateAttachments(data.attachments)
  if (attachErrS) return { error: attachErrS }

  const uniqueStoreIds = [...new Set(data.storeIds)]

  // 1. Create template
  const config = {
    description:      sanitizeRichText(data.description) || undefined,
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
      assignment_mode:       assignmentMode,
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
      schedule_id:     schedule.id,
      template_id:     template.id,
      title:           data.title,
      frequency:       data.frequency,
      store_count:     uniqueStoreIds.length,
      assignment_mode: assignmentMode,
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

// Permanently deletes a recurring schedule. Only the schedule owner (template
// creator) or the super admin may delete (RLS tt_modify_admin is the DB gate).
// Deleting the TEMPLATE cascades the schedule + store links + collaborators
// (FKs from 013/047); generated tasks and run history are KEPT — their
// source_template_id/source_schedule_id are SET NULL, so completed work and
// audit data survive.
export async function deleteSchedule(scheduleId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return { error: 'Không có quyền' }

  const { data: sched } = await supabase
    .from('task_schedules')
    .select('id, template_id, task_templates ( title, created_by ), task_schedule_stores ( store_id )')
    .eq('id', scheduleId)
    .single()
  const template = sched?.task_templates as unknown as { title: string; created_by: string | null } | null
  if (!sched || !template) return { error: 'Lịch không tồn tại' }
  if (!canAdminManageOwn({ email: user.email, role: profile?.role, createdBy: template.created_by, userId: user.id }))
    return { error: 'Chỉ admin tạo lịch hoặc super admin mới xóa được' }

  const { data: deleted, error } = await supabase
    .from('task_templates')
    .delete()
    .eq('id', sched.template_id)
    .select('id')
  if (error) return { error: error.message }
  if (!deleted?.length) return { error: 'Không xóa được lịch (RLS từ chối)' }

  await supabase.from('task_logs').insert({
    task_id: null, action: 'schedule_deleted', user_id: user.id,
    metadata: {
      schedule_id: scheduleId,
      template_id: sched.template_id,
      title:       template.title,
      store_count: (sched.task_schedule_stores as unknown as unknown[] | null)?.length ?? 0,
    },
  })

  revalidatePath('/tasks/schedules')
  revalidatePath('/tasks')
  return { success: true }
}

// Bottom-nav badge: how many tasks the staff user still has open. Head-count
// only (no rows), RLS-scoped, and the predicate MIRRORS the staff pending list
// in app/(dashboard)/tasks/page.tsx (not-done + not-archived + no TRF; staff
// are exempt from the 14-day declutter) so the badge always equals the list.
export async function getStaffPendingTaskCount(): Promise<number> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return 0
  const { count } = await supabase
    .from('tasks')
    .select('id', { count: 'exact', head: true })
    .neq('status', 'done')
    .is('archived_at', null)
    .neq('source_type', 'inventory_trf')
  return count ?? 0
}
