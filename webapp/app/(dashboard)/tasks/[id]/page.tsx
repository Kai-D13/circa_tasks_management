import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button, buttonVariants } from '@/components/ui/button'
import { TaskStatusBadge } from '@/components/tasks/TaskStatusBadge'
import { TaskPriorityBadge } from '@/components/tasks/TaskPriorityBadge'
import { TaskSubmitForm } from '@/components/tasks/TaskSubmitForm'
import { TaskStatusSelector } from '@/components/tasks/TaskStatusSelector'
import { TaskReassignForm } from '@/components/tasks/TaskReassignForm'
import { TaskReviewNote } from '@/components/tasks/TaskReviewNote'
import { RequestResubmitSection } from '@/components/tasks/RequestResubmitSection'
import { ExtendDeadlineForm } from '@/components/tasks/ExtendDeadlineForm'
import { TaskResultCard } from '@/components/tasks/TaskResultCard'
import { InputDataDisplay } from '@/components/tasks/InputDataDisplay'
import { deleteTask, requestResubmit, extendDeadline } from '@/app/actions/tasks'
import { createFeedbackThread, addFeedbackMessage, resolveFeedbackThread } from '@/app/actions/feedback'
import { FeedbackSection, type FeedbackThread } from '@/components/feedback/FeedbackSection'
import { ShareTaskDialog, type CollaboratorRow } from '@/components/tasks/ShareTaskDialog'
import { EditStaffAllInstructionDialog } from '@/components/tasks/EditStaffAllInstructionDialog'
import { AutoRefresh } from '@/components/common/AutoRefresh'
import { formatDate, formatDateTime, getEffectiveStatus } from '@/lib/dateUtils'
import { isSuperAdminEmail, getSmStoreIds, smHasStore } from '@/lib/authz'
import { Task, RequiredOutput, UserRole, TaskCategory, TaskAttachment } from '@/types'
import { Pencil, Trash2, Radio, Users } from 'lucide-react'

const CATEGORY_STYLE: Record<TaskCategory, string> = {
  training: 'bg-blue-100 text-blue-700',
  recall:   'bg-red-100 text-red-700',
  display:  'bg-green-100 text-green-700',
  audit:    'bg-amber-100 text-amber-700',
  other:    'bg-gray-100 text-gray-600',
}
const CATEGORY_LABEL_VN: Record<TaskCategory, string> = {
  training: 'Training',
  recall:   'Thu hồi / Kiểm kê',
  display:  'Trưng bày',
  audit:    'Kiểm tra',
  other:    'Khác',
}
import { cn } from '@/lib/utils'
import { deptBadgeClass } from '@/lib/departments'
import { formatTaskCode } from '@/lib/taskCode'
import { RichText } from '@/components/tasks/RichText'

const OUTPUT_LABEL: Record<string, string> = {
  image: 'Ảnh',
  video: 'Video',
  file:  'File đính kèm',
  text:  'Ghi chú văn bản',
}

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  // Session/profile is request-memoized (already fetched by the dashboard layout),
  // so fetch the task in parallel with it — only the task is a fresh round-trip.
  const [{ user, profile }, { data: task }] = await Promise.all([
    getSessionProfile(),
    supabase
      .from('tasks')
      .select('*, stores(name), assignee:users!assigned_to(full_name, email), creator:users!created_by(full_name), completed_by_user:users!completed_by(full_name), department:departments(name, color)')
      // (task.seq is included by '*' — rendered as T-000000 via formatTaskCode)
      .eq('id', id)
      .single(),
  ])

  if (!user) redirect('/login')
  if (!task) notFound()

  const userRole   = (profile?.role ?? 'staff') as UserRole
  const userId      = user!.id
  const isSm        = userRole === 'sm'

  // SM: load assigned store IDs and gate access to this task
  const smStoreIds   = isSm ? await getSmStoreIds(supabase, userId) : []
  const isSmForStore = isSm && smHasStore(smStoreIds, task.store_id as string | null)
  if (isSm && !isSmForStore) notFound()

  // canManageTask: admin task-management capability (edit/delete/reassign/extend/
  // review). Sub-admins only on tasks they created; super admin on any. Store
  // managers/staff are executors and never manage.
  const canManageTask = userRole === 'admin'
    && (isSuperAdminEmail(user!.email) || task.created_by === userId)
  // canViewStoreRoster: read-only — fetch store users for results filtering
  // (store_manager) and the reassign dropdown (admin/SM). Not a mutation right.
  const canViewStoreRoster = userRole === 'admin' || userRole === 'store_manager' || isSmForStore

  // staff_all parent: overview only. It is never submittable and has no status
  // lifecycle — instead it shows a per-staff child progress table. A child task
  // shows a breadcrumb back to its parent.
  const isStaffParent = task.assignment_mode === 'staff_all'
  const parentTaskId  = (task.parent_task_id as string | null) ?? null
  const [{ data: childTasks }, { data: parentInfo }] = await Promise.all([
    isStaffParent
      ? supabase
          .from('tasks')
          .select('id, status, deadline, overdue_at, assignee:users!assigned_to(full_name)')
          .eq('parent_task_id', id)
          .order('created_at')
      : Promise.resolve({ data: null }),
    parentTaskId
      ? supabase.from('tasks').select('title').eq('id', parentTaskId).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  const staffChildren = (childTasks ?? []) as unknown as Array<{
    id: string; status: string; deadline: string | null; overdue_at: string | null
    assignee: { full_name: string } | null
  }>
  const staffDone  = staffChildren.filter((c) => c.status === 'done').length
  const staffTotal = staffChildren.length

  // Round 2: store users + collaborators (parallel)
  const [{ data: storeUsers }, { data: collaborators }, { data: allAdmins }, { data: myCollaboratorRow }] = await Promise.all([
    canViewStoreRoster && task.store_id
      ? supabase.from('users').select('id, full_name, role').eq('store_id', task.store_id).order('full_name')
      : Promise.resolve({ data: [] as { id: string; full_name: string; role: string }[] }),
    // Full collaborator list — only the task owner needs this (for the Share dialog)
    canManageTask
      ? supabase.from('task_collaborators').select('admin_id, permission, users!admin_id(full_name)').eq('task_id', id)
      : Promise.resolve({ data: [] as CollaboratorRow[] }),
    // Admin options for the Share dialog
    canManageTask
      ? supabase.from('users').select('id, full_name, email').eq('role', 'admin').neq('id', userId).order('full_name')
      : Promise.resolve({ data: [] as { id: string; full_name: string; email: string }[] }),
    // Current user's own collaborator row (only needed when not the owner)
    !canManageTask && userRole === 'admin'
      ? supabase.from('task_collaborators').select('permission').eq('task_id', id).eq('admin_id', userId).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  // True when the current user is an 'editor' collaborator (not the owner)
  const isEditorCollaborator = !canManageTask
    && (myCollaboratorRow as { permission?: string } | null)?.permission === 'editor'

  // Compute isStoreModeSubmitter here — needed to gate lastResubmitLog fetch below.
  // Store-level ("Cửa hàng nộp"): unassigned store task; any staff OR store_manager
  // of that store may submit. One valid result completes it for the whole store.
  const isStoreLevelTask = task.assigned_to === null
    && task.assignment_mode === 'store'
    && task.store_id !== null
    && task.store_id === profile?.store_id
  const isStoreModeSubmitter = isStoreLevelTask
    && (userRole === 'staff' || userRole === 'store_manager')

  // Build submissions query with role-based visibility
  // - admin: all submissions for this task
  // - store_manager: only submissions from users in their store
  // - staff: their own submission; for a store-level task, the store's submission
  //   too (RLS tr_select_staff scopes it to the store) so colleagues see the result
  function buildResultsQuery() {
    const base = supabase
      .from('task_results')
      .select('*, submitter:users!user_id(full_name), performer:users!performed_by(full_name)')
      .eq('task_id', id)
      .order('submitted_at', { ascending: false })

    // Store-level task: show the store's submission to any staff of the store.
    // Otherwise staff only see their own.
    if (userRole === 'staff') return isStoreLevelTask ? base : base.eq('user_id', userId)

    if (userRole === 'store_manager' || isSmForStore) {
      const ids = (storeUsers ?? []).map((u) => u.id)
      // If no users in store, use a fake UUID so we get 0 rows (not all rows)
      return ids.length > 0
        ? base.in('user_id', ids)
        : base.in('user_id', ['00000000-0000-0000-0000-000000000000'])
    }

    return base // admin: no filter
  }

  // Round 3: results + logs + feedback in parallel
  // reviewLogs / feedbackThreads: RLS controls visibility per role
  const resubmitAt = (task.resubmit_requested_at as string | null) ?? null

  // Feedback is an admin↔store_manager channel; staff and view-only collaborators
  // never see it. Compute visibility here (same value as canViewFeedback below) so
  // we can skip the feedbackThreads round-trip entirely for those who can't view it.
  const canViewFeedbackThreads =
    canManageTask || (userRole === 'store_manager' && task.store_id === profile?.store_id) || isSmForStore
  const [
    { data: results },
    { data: lastAssignLog },
    { data: reviewLogs },
    { data: lastResubmitLog },
    { data: feedbackThreads },
  ] = await Promise.all([
    buildResultsQuery(),
    task.assigned_to
      ? supabase
          .from('task_logs')
          .select('created_at, users(full_name)')
          .eq('task_id', id)
          .eq('action', 'reassigned')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from('task_review_notes')
      .select('id, created_at, note, author:users!author_id(full_name)')
      .eq('task_id', id)
      .eq('kind', 'review_note')
      .order('created_at', { ascending: false }),
    // Fetch last resubmit reason (for staff/store-manager notification banner)
    (userRole === 'staff' || isStoreModeSubmitter) && resubmitAt
      ? supabase
          .from('task_review_notes')
          .select('note')
          .eq('task_id', id)
          .eq('kind', 'resubmit_request')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Feedback threads — only fetched for those who can view feedback (admin owner/
    // collaborator-manager or the store's manager); skipped for staff & view-only.
    canViewFeedbackThreads
      ? supabase
          .from('task_feedback_threads')
          .select('id, title, status, created_at, created_by, users(full_name), task_feedback_messages(id, user_id, message, created_at, users(full_name))')
          .eq('task_id', id)
          .order('created_at', { ascending: false })
      : Promise.resolve({ data: [] as unknown[] }),
  ])

  // Who can submit:
  // (a) direct assignment: task assigned to this user
  // (b) store-level: task has no assignee, current user is store_manager of the task's store
  // isStoreModeSubmitter is computed above (before Round 3) so lastResubmitLog can use it
  const isDirectAssignee = task.assigned_to === userId

  // hasAlreadySubmitted: a result exists submitted AFTER the last resubmit request
  // (results before resubmit_requested_at don't block — can submit again)
  const hasAlreadySubmitted = (isDirectAssignee || isStoreModeSubmitter)
    && (results ?? []).some(
      (r) => !resubmitAt || new Date((r as { submitted_at: string }).submitted_at) > new Date(resubmitAt)
    )

  // isSubmitterForTask: user is responsible for submitting this task (direct assignee or store-level)
  const isSubmitterForTask = isDirectAssignee || isStoreModeSubmitter

  // displayStatus: for staff_all parents roll up from children (parent is never
  // submitted or flipped by cron); for regular tasks apply deadline-based overdue.
  const displayStatus = isStaffParent
    ? (staffDone === staffTotal && staffTotal > 0 ? 'done' : staffDone > 0 ? 'in_progress' : 'todo') as Task['status']
    : getEffectiveStatus(task.deadline, task.status) as Task['status']

  // Overdue tasks are still submittable (lateness is tracked, not blocked) — the
  // submit form stays available until there is a valid submission or it's done.
  const canSubmit = !isStaffParent
    && displayStatus !== 'done'
    && isSubmitterForTask
    && !hasAlreadySubmitted

  // Admin (manager of this task) always sees the selector. The submitter
  // (staff/store) keeps it for execution status (todo/in_progress) until they
  // have a valid submission or the task is effectively overdue/done. Store
  // managers who are NOT the submitter no longer get a reviewer selector.
  const canSeeStatusSelector = !isStaffParent && (
    canManageTask
    || (isSubmitterForTask && !hasAlreadySubmitted && displayStatus !== 'done')
  )

  // Helper text shown when submitter is locked after valid submission
  const submittedLocked = isSubmitterForTask && hasAlreadySubmitted

  // Admin/manager-visible: is there a valid submission regardless of viewer's role?
  const hasValidSubmission = (results ?? []).some(
    (r) => !resubmitAt || new Date((r as { submitted_at: string }).submitted_at) > new Date(resubmitAt)
  )

  // canReviewTask: gates RequestResubmitSection + "has results but not done" warning.
  // Extended to editor collaborators and SM (they can request resubmit after validation).
  const canReviewTask = canManageTask || isEditorCollaborator || isSmForStore
  // canExtendDeadline: owner + super only — not open to editor collaborators or SM.
  const canExtendDeadline = canManageTask
  // canAddReviewNote: owner/super + editor collaborators (server action validates).
  // view-only collaborators are also admin, so checking just userRole='admin'
  // would let them through — use the specific flag instead.
  const canAddReviewNote = canManageTask || isEditorCollaborator

  // Feedback: any store_manager of this task's store can create AND reply.
  // Store-level submitters CAN create feedback (different from resubmit rule).
  // Staff: no access to feedback.
  const isManagerOfTaskStore = userRole === 'store_manager' && task.store_id === profile?.store_id
  const canCreateFeedback = isManagerOfTaskStore
  // Feedback reply: task owner/super (canManageTask) or the store's manager.
  // Collaborators (view or editor) can read threads but cannot reply — their
  // channel is review notes, not the store-admin Q&A thread.
  const canReplyFeedback  = canManageTask || isManagerOfTaskStore
  // Feedback is a private Q&A between the task owner/super admin and the store
  // manager. Collaborators are not part of this channel (they use review notes).
  // SM can view feedback threads for their stores (read-only observer role).
  const canViewFeedback = canCreateFeedback || canReplyFeedback || isSmForStore

  const assignerName: string | null = lastAssignLog
    ? (lastAssignLog.users as unknown as { full_name: string } | null)?.full_name ?? null
    : task.assigned_to
      ? (task.creator as { full_name: string } | null)?.full_name ?? null
      : null

  async function handleDelete() {
    'use server'
    await deleteTask(id)
  }

  // Shared review-note entries mapped for TaskReviewNote
  const reviewEntries = (reviewLogs ?? []).map((r) => ({
    id:         r.id,
    created_at: r.created_at,
    metadata:   { note: (r as unknown as { note: string }).note },
    users:      (r as unknown as { author: { full_name: string } | null }).author,
  }))

  // Resubmit reason text (shown in the banner)
  const resubmitReason = (lastResubmitLog as { note?: string } | null)?.note

  return (
    // lg:h-full constrains the two-column body to viewport height on desktop so
    // each column gets independent overflow-y-auto scroll. On mobile no height
    // constraint — <main> (overflow-y-auto) handles natural page scroll.
    <div className="flex flex-col lg:h-full">
      {userRole !== 'staff' && <AutoRefresh intervalMs={30000} />}

      {/* ── Page header (full width) ── */}
      <div className="px-4 pt-4 pb-3 border-b bg-background shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {(task as { seq?: number | null }).seq != null && (
              <p className="text-xs font-mono text-muted-foreground mb-0.5">{formatTaskCode((task as { seq?: number | null }).seq)}</p>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold leading-tight tracking-tight">{task.title}</h1>
              {task.category && (
                <span className={cn(
                  'text-xs px-2 py-0.5 rounded font-medium shrink-0',
                  CATEGORY_STYLE[task.category as TaskCategory] ?? 'bg-gray-100 text-gray-600'
                )}>
                  {CATEGORY_LABEL_VN[task.category as TaskCategory] ?? task.category}
                </span>
              )}
              {task.broadcast_id && (
                <span className="flex items-center gap-1 text-xs text-primary bg-primary/10 px-2 py-0.5 rounded shrink-0">
                  <Radio className="h-3 w-3" /> Broadcast
                </span>
              )}
              {(task.department as unknown as { name: string; color: string | null } | null) && (
                <span className={cn(
                  'text-xs px-2 py-0.5 rounded font-medium shrink-0',
                  deptBadgeClass((task.department as unknown as { color: string | null }).color)
                )}>
                  {(task.department as unknown as { name: string }).name}
                </span>
              )}
              {(task as { source_schedule_id?: string | null }).source_schedule_id && (
                <span className="text-xs bg-teal-100 text-teal-700 px-2 py-0.5 rounded font-medium shrink-0">
                  Định kỳ
                </span>
              )}
              {isStaffParent && (
                <span className="flex items-center gap-1 text-xs text-primary bg-primary/10 px-2 py-0.5 rounded font-medium shrink-0">
                  <Users className="h-3 w-3" /> Từng dược sĩ nộp
                </span>
              )}
            </div>
            {parentTaskId && parentInfo && (
              <p className="text-xs text-muted-foreground mt-1">
                Task con của{' '}
                <Link href={`/tasks/${parentTaskId}`} className="text-primary hover:underline">
                  {(parentInfo as { title: string }).title}
                </Link>
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">
              Tạo bởi {(task.creator as { full_name: string } | null)?.full_name ?? '—'}
              {task.created_at && ` · ${formatDate(task.created_at)}`}
              {assignerName && task.assigned_to && (
                <> · Phân công: <span className="text-foreground">{assignerName}</span>
                  {lastAssignLog?.created_at && ` (${formatDate(lastAssignLog.created_at as string)})`}
                </>
              )}
            </p>
          </div>
          {canManageTask && (
            <div className="flex gap-2 shrink-0">
              <ShareTaskDialog
                taskId={id}
                collaborators={(collaborators ?? []) as CollaboratorRow[]}
                adminOptions={(allAdmins ?? []).map((a) => ({
                  value: a.id,
                  label: a.full_name,
                  description: a.email,
                  keywords: [a.email],
                }))}
              />
              {isStaffParent ? (
                <EditStaffAllInstructionDialog
                  taskId={id}
                  isBroadcast={!!task.broadcast_id}
                  defaults={{
                    title:       task.title as string,
                    description: (task.description as string | null) ?? null,
                    category:    (task.category as TaskCategory),
                    priority:    (task.priority as Task['priority']),
                    attachments: ((task.input_data as { attachments?: TaskAttachment[] } | null)?.attachments ?? []),
                    links:       ((task.input_data as { links?: { label: string; url: string }[] } | null)?.links ?? []),
                  }}
                />
              ) : (
                <Link href={`/tasks/${id}/edit`} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
                  <Pencil className="h-4 w-4 mr-1" /> Chỉnh sửa
                </Link>
              )}
              <form action={handleDelete}>
                <Button variant="destructive" size="sm" type="submit">
                  <Trash2 className="h-4 w-4 mr-1" /> Xoá
                </Button>
              </form>
            </div>
          )}
        </div>
      </div>

      {/* ── Two-column body ── */}
      {/* Desktop (lg): flex-row, each column independently overflow-y-auto within the
          constrained height from lg:h-full above → the right panel effectively "sticks"
          without requiring position:sticky (which breaks inside overflow containers).
          Mobile: flex-col. order-2 on left, order-1 on right → right panel (status +
          submit CTA) appears first on mobile. Using order-* avoids the DOM/focus
          mismatch that flex-col-reverse causes for keyboard navigation. */}
      <div className="flex flex-col lg:flex-row lg:flex-1 lg:min-h-0 w-full max-w-[1400px]">

        {/* ── Left — task content (order-2 mobile → below, order-first desktop → left) ── */}
        <div className="order-2 lg:order-first flex-[2] min-w-0 px-4 py-3 lg:border-r lg:overflow-y-auto">
          <div className="space-y-3">

          {/* Description */}
          {task.description && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Mô tả</p>
              <RichText value={task.description as string} />
            </div>
          )}

          {/* Input data (task attachments / links from creation) */}
          {task.input_data && Object.keys(task.input_data as object).length > 0 && (
            <InputDataDisplay inputData={task.input_data as Record<string, unknown>} />
          )}

          {/* staff_all parent: per-staff progress table instead of a submit form */}
          {isStaffParent && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  Tiến độ dược sĩ
                  <span className={cn(
                    'text-xs font-medium px-1.5 py-0.5 rounded',
                    staffTotal > 0 && staffDone === staffTotal ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                  )}>
                    {staffDone}/{staffTotal} đã nộp
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {staffTotal === 0 ? (
                  <p className="text-sm text-muted-foreground">Chưa có task con nào.</p>
                ) : (
                  <div className="divide-y divide-border/60">
                    {staffChildren.map((c) => (
                      <div key={c.id} className="flex items-center justify-between gap-2 py-2">
                        <Link href={`/tasks/${c.id}`} className="text-sm font-medium hover:underline truncate">
                          {c.assignee?.full_name ?? 'Chưa phân công'}
                        </Link>
                        <div className="flex items-center gap-2 shrink-0">
                          <TaskStatusBadge
                            status={getEffectiveStatus(c.deadline, c.status) as Task['status']}
                            late={c.status === 'done' && !!c.overdue_at}
                          />
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {c.deadline ? formatDate(c.deadline) : '—'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Resubmit request banner — above submit form so the reason is visible
              before the submitter starts filling in the form */}
          {(userRole === 'staff' || isStoreModeSubmitter) && resubmitAt && !hasAlreadySubmitted && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
              <p className="font-medium text-amber-900">Quản lý yêu cầu thực hiện lại</p>
              {resubmitReason && <p className="text-amber-800 mt-1">Lý do: {resubmitReason}</p>}
              <p className="text-xs text-amber-700 mt-1">Kết quả cũ đã được lưu. Vui lòng nộp lại bên dưới.</p>
            </div>
          )}

          {/* Submit form — primary workflow step, right after task content */}
          {canSubmit && (
            <Card className="border-primary/30">
              <CardHeader className="pb-1">
                <CardTitle className="text-sm text-primary flex items-center gap-2">
                  Nộp kết quả
                  {displayStatus === 'overdue' && (
                    <span className="text-[11px] font-medium bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Quá hạn</span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {isStoreLevelTask && (
                  <p className="text-xs text-muted-foreground mb-2">
                    Task cửa hàng: Staff hoặc Quản lý cửa hàng đều có thể nộp. Chỉ cần một kết quả cho cả cửa hàng.
                  </p>
                )}
                <TaskSubmitForm
                  taskId={id}
                  requiredOutputs={(task.required_outputs as RequiredOutput[]) ?? []}
                  role={userRole}
                  isStoreLevelTask={isStoreLevelTask}
                  storeStaff={(storeUsers ?? []).filter((u) => u.role === 'staff')}
                />
              </CardContent>
            </Card>
          )}

          {/* Previous submissions */}
          {(results ?? []).length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Kết quả đã nộp ({results?.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {results!.map((r) => (
                  <TaskResultCard
                    key={r.id}
                    result={{
                      id:             r.id,
                      submitted_at:   r.submitted_at,
                      output_data:    r.output_data as Record<string, unknown>,
                      submitter_name: (r.submitter as unknown as { full_name: string } | null)?.full_name ?? null,
                      performer_name: (r.performer as unknown as { full_name: string } | null)?.full_name ?? null,
                      submitted_by:   r.user_id as string,
                      performed_by:   r.performed_by as string | null,
                    }}
                  />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Trao đổi với Admin — store_manager ↔ admin; staff cannot see */}
          {canViewFeedback && (
            <FeedbackSection
              taskId={id}
              threads={(feedbackThreads ?? []) as unknown as FeedbackThread[]}
              canCreate={canCreateFeedback}
              canReply={canReplyFeedback}
              createFn={createFeedbackThread}
              replyFn={addFeedbackMessage}
              resolveFn={resolveFeedbackThread}
            />
          )}

          {/* Admin review notes — read-only for managers/staff; only admins can add */}
          {(canAddReviewNote || reviewEntries.length > 0) && (
            <TaskReviewNote
              taskId={id}
              reviews={reviewEntries}
              canAddNote={canAddReviewNote}
            />
          )}

          {/* Admin-only review actions — after results so context is clear */}
          {canReviewTask && hasValidSubmission && task.status !== 'done' && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
              Task đã có kết quả nộp nhưng trạng thái hiện không phải Hoàn thành. Có thể yêu cầu làm lại hoặc chỉnh trạng thái.
            </div>
          )}
          {canReviewTask && hasValidSubmission && (
            <RequestResubmitSection taskId={id} requestFn={requestResubmit} />
          )}
          </div>
        </div>

        {/* ── Right — metadata sidebar (order-1 mobile → above, order-last desktop → right) ── */}
        <div className="order-1 lg:order-last lg:w-[340px] lg:shrink-0 px-4 py-3 space-y-3 lg:border-l lg:overflow-y-auto">

          {/* Extend deadline — admin when overdue; at the top so the action is
              immediately visible alongside the overdue status badge */}
          {canExtendDeadline && displayStatus === 'overdue' && (
            <ExtendDeadlineForm
              taskId={id}
              extendFn={extendDeadline}
              currentDeadline={task.deadline ?? null}
            />
          )}

          {/* Status + metadata card — rows use border-t spacing rather than
              heavy Separators between every field */}
          <Card>
            <CardContent className="pt-4 text-sm divide-y divide-border/60">

              {/* Status */}
              <div className="pb-3">
                <p className="text-xs text-muted-foreground mb-1">Trạng thái</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <TaskStatusBadge status={displayStatus} late={!!task.overdue_at} />
                  {canSeeStatusSelector && (
                    <TaskStatusSelector taskId={id} currentStatus={displayStatus} userRole={userRole} />
                  )}
                </div>
                {submittedLocked && (
                  <p className="text-xs text-amber-700 mt-1">
                    Task đã nộp. Vui lòng chờ quản lý yêu cầu làm lại nếu cần chỉnh sửa.
                  </p>
                )}
                {displayStatus === 'overdue' && isSubmitterForTask && !hasAlreadySubmitted && (
                  <p className="text-xs text-amber-700 mt-1">
                    Task đã quá hạn — vẫn có thể nộp, kết quả sẽ được ghi nhận là nộp trễ.
                  </p>
                )}
              </div>

              {/* Deadline + start date */}
              <div className="py-3 grid grid-cols-2 gap-3">
                {task.start_date && (
                  <div>
                    <p className="text-xs text-muted-foreground">Bắt đầu</p>
                    <p className="font-medium mt-0.5">{formatDate(task.start_date)}</p>
                  </div>
                )}
                <div>
                  <p className="text-xs text-muted-foreground">Deadline</p>
                  <p className={cn('font-medium mt-0.5', displayStatus === 'overdue' && 'text-red-600')}>
                    {task.deadline ? formatDate(task.deadline) : '—'}
                  </p>
                </div>
              </div>

              {/* Priority + Store — same row group */}
              <div className="py-3 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Ưu tiên</p>
                  <TaskPriorityBadge priority={task.priority as Task['priority']} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Cửa hàng</p>
                  <p className="font-medium truncate">{(task.stores as { name: string } | null)?.name ?? '—'}</p>
                </div>
              </div>

              {/* Assignee */}
              <div className="py-3">
                <p className="text-xs text-muted-foreground mb-1">
                  {displayStatus === 'done' && isStoreLevelTask ? 'Người đã nộp' : 'Người thực hiện'}
                </p>
                {isStaffParent ? (
                  <p className="font-medium">Từng dược sĩ ({staffTotal})</p>
                ) : displayStatus === 'done' ? (
                  // Done: show who submitted (from completed_by_user for store-level,
                  // or assignee for direct-assigned tasks). Never show reassign form.
                  // completed_by_user can arrive as object or 1-element array (Supabase FK).
                  <>
                    <p className="font-medium">
                      {(() => {
                        const cb = task.completed_by_user as unknown
                        const name = Array.isArray(cb)
                          ? (cb[0] as { full_name?: string } | undefined)?.full_name
                          : (cb as { full_name?: string } | null)?.full_name
                        return name
                          ?? (task.assignee as { full_name: string } | null)?.full_name
                          ?? 'Cửa hàng nộp'
                      })()}
                    </p>
                    {task.completed_at && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Nộp lúc: {formatDateTime(task.completed_at as string)}
                      </p>
                    )}
                  </>
                ) : (canManageTask || isSmForStore) ? (
                  <TaskReassignForm
                    taskId={id}
                    currentAssignedTo={task.assigned_to}
                    storeUsers={isSmForStore
                      ? (storeUsers ?? []).filter((u) => u.role === 'staff')
                      : (storeUsers ?? [])}
                  />
                ) : (
                  <p className="font-medium">
                    {(task.assignee as { full_name: string } | null)?.full_name
                      ?? (isStoreLevelTask ? 'Cửa hàng nộp' : 'Chưa phân công')}
                  </p>
                )}
              </div>

              {/* Required outputs */}
              {(task.required_outputs as RequiredOutput[])?.length > 0 && (
                <div className="py-3">
                  <p className="text-xs text-muted-foreground mb-1.5">Output cần nộp</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(task.required_outputs as RequiredOutput[]).map((o) => (
                      <span key={o} className="text-xs bg-muted px-2 py-0.5 rounded">
                        {OUTPUT_LABEL[o] ?? o}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Visibility — less prominent, admin/manager context only */}
              {canViewStoreRoster && (
                <div className="pt-3">
                  <p className="text-xs text-muted-foreground mb-1">Phạm vi</p>
                  <p className="text-sm">
                    {task.visibility === 'public' ? 'Tất cả'
                      : task.visibility === 'store' ? 'Cả store'
                      : 'Chỉ người được giao'}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
