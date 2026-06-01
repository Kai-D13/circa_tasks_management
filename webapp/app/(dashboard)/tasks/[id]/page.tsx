import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button, buttonVariants } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
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
import { AutoRefresh } from '@/components/common/AutoRefresh'
import { formatDate, getEffectiveStatus } from '@/lib/dateUtils'
import { Task, RequiredOutput, UserRole, TaskCategory } from '@/types'
import { Pencil, Trash2, Radio } from 'lucide-react'

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

const OUTPUT_LABEL: Record<string, string> = {
  image: 'Ảnh',
  video: 'Video',
  file:  'File đính kèm',
  text:  'Ghi chú văn bản',
}

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Round 1: task + profile in parallel
  const [{ data: task }, { data: profile }] = await Promise.all([
    supabase
      .from('tasks')
      .select('*, stores(name), assignee:users!assigned_to(full_name, email), creator:users!created_by(full_name)')
      .eq('id', id)
      .single(),
    supabase.from('users').select('role, store_id').eq('id', user.id).single(),
  ])

  if (!task) notFound()

  const userRole   = (profile?.role ?? 'staff') as UserRole
  const canReassign = userRole === 'admin' || userRole === 'store_manager'
  const canEdit     = userRole === 'admin'
  const userId      = user!.id

  // Round 2: store users (needed for reassign form + results filter for store_manager)
  const { data: storeUsers } = canReassign && task.store_id
    ? await supabase.from('users').select('id, full_name, role').eq('store_id', task.store_id).order('full_name')
    : { data: [] }

  // Compute isStoreSubmitter here — needed to gate lastResubmitLog fetch below
  const isStoreSubmitter = task.assigned_to === null
    && task.store_id !== null
    && task.store_id === profile?.store_id
    && userRole === 'store_manager'

  // Build submissions query with role-based visibility
  // - admin: all submissions for this task
  // - store_manager: only submissions from users in their store
  // - staff: only their own submission
  function buildResultsQuery() {
    const base = supabase
      .from('task_results')
      .select('*, users(full_name)')
      .eq('task_id', id)
      .order('submitted_at', { ascending: false })

    if (userRole === 'staff') return base.eq('user_id', userId)

    if (userRole === 'store_manager') {
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
      .from('task_logs')
      .select('id, created_at, metadata, users(full_name)')
      .eq('task_id', id)
      .eq('action', 'review_note')
      .order('created_at', { ascending: false }),
    // Fetch last resubmit reason (for staff/store-manager notification banner)
    (userRole === 'staff' || isStoreSubmitter) && resubmitAt
      ? supabase
          .from('task_logs')
          .select('metadata')
          .eq('task_id', id)
          .eq('action', 'resubmit_requested')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Feedback threads — RLS returns only what caller is allowed to see
    supabase
      .from('task_feedback_threads')
      .select('id, title, status, created_at, created_by, users(full_name), task_feedback_messages(id, user_id, message, created_at, users(full_name))')
      .eq('task_id', id)
      .order('created_at', { ascending: false }),
  ])

  // Who can submit:
  // (a) direct assignment: task assigned to this user
  // (b) store-level: task has no assignee, current user is store_manager of the task's store
  // isStoreSubmitter is computed above (before Round 3) so lastResubmitLog can use it
  const isDirectAssignee = task.assigned_to === userId

  // hasAlreadySubmitted: a result exists submitted AFTER the last resubmit request
  // (results before resubmit_requested_at don't block — can submit again)
  const hasAlreadySubmitted = (isDirectAssignee || isStoreSubmitter)
    && (results ?? []).some(
      (r) => !resubmitAt || new Date((r as { submitted_at: string }).submitted_at) > new Date(resubmitAt)
    )

  // isSubmitterForTask: user is responsible for submitting this task (direct assignee or store-level)
  const isSubmitterForTask = isDirectAssignee || isStoreSubmitter

  // displayStatus: effective status shown in UI — reflects overdue even when DB status is in_progress/todo
  const displayStatus = getEffectiveStatus(task.deadline, task.status) as Task['status']

  // Overdue tasks cannot be submitted — an admin/manager must extend the deadline
  // first (mirrors the server guard in submitTask).
  const canSubmit = displayStatus !== 'done'
    && displayStatus !== 'overdue'
    && isSubmitterForTask
    && !hasAlreadySubmitted

  // Admin always sees selector. Store manager reviewing (not the submitter) always sees it.
  // Submitter (any role) loses the selector once they have a valid submission or task is effectively overdue/done.
  const canSeeStatusSelector =
    canEdit
    || (canReassign && !isSubmitterForTask)
    || (isSubmitterForTask && !hasAlreadySubmitted && !['done', 'overdue'].includes(displayStatus))

  // Helper text shown when submitter is locked after valid submission
  const submittedLocked = isSubmitterForTask && hasAlreadySubmitted

  // Admin/manager-visible: is there a valid submission regardless of viewer's role?
  const hasValidSubmission = (results ?? []).some(
    (r) => !resubmitAt || new Date((r as { submitted_at: string }).submitted_at) > new Date(resubmitAt)
  )

  // canReviewTask: can see RequestResubmitSection and review actions.
  // Store manager who is the submitter for this task cannot review their own submission.
  const canReviewTask = userRole === 'admin' || (canReassign && !isSubmitterForTask)

  // Feedback: any store_manager of this task's store can create AND reply.
  // Store-level submitters CAN create feedback (different from resubmit rule).
  // Staff: no access to feedback.
  const isManagerOfTaskStore = userRole === 'store_manager' && task.store_id === profile?.store_id
  const canCreateFeedback = isManagerOfTaskStore
  const canReplyFeedback  = userRole === 'admin' || isManagerOfTaskStore

  const assignerName: string | null = lastAssignLog
    ? (lastAssignLog.users as unknown as { full_name: string } | null)?.full_name ?? null
    : task.assigned_to
      ? (task.creator as { full_name: string } | null)?.full_name ?? null
      : null

  async function handleDelete() {
    'use server'
    await deleteTask(id)
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <AutoRefresh intervalMs={12000} />
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold">{task.title}</h1>
            {task.category && (
              <span className={cn(
                'text-xs px-2 py-0.5 rounded font-medium',
                CATEGORY_STYLE[task.category as TaskCategory] ?? 'bg-gray-100 text-gray-600'
              )}>
                {CATEGORY_LABEL_VN[task.category as TaskCategory] ?? task.category}
              </span>
            )}
            {task.broadcast_id && (
              <span className="flex items-center gap-1 text-xs text-primary bg-primary/10 px-2 py-0.5 rounded">
                <Radio className="h-3 w-3" /> Broadcast
              </span>
            )}
            {(task as { source_schedule_id?: string | null }).source_schedule_id && (
              <span className="text-xs bg-teal-100 text-teal-700 px-2 py-0.5 rounded font-medium">
                Định kỳ
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Tạo bởi {(task.creator as { full_name: string } | null)?.full_name ?? '—'}
            {task.created_at && ` · ${formatDate(task.created_at)}`}
          </p>
          {assignerName && task.assigned_to && (
            <p className="text-sm text-muted-foreground">
              Phân công bởi{' '}
              <span className="font-medium text-foreground">{assignerName}</span>
              {lastAssignLog?.created_at && ` · ${formatDate(lastAssignLog.created_at as string)}`}
            </p>
          )}
        </div>
        {canEdit && (
          <div className="flex gap-2 shrink-0">
            <Link href={`/tasks/${id}/edit`} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
              <Pencil className="h-4 w-4 mr-1" /> Chỉnh sửa
            </Link>
            <form action={handleDelete}>
              <Button variant="destructive" size="sm" type="submit">
                <Trash2 className="h-4 w-4 mr-1" /> Xoá
              </Button>
            </form>
          </div>
        )}
      </div>

      {/* Resubmit request banner — shown to staff when manager requested resubmission */}
      {(userRole === 'staff' || isStoreSubmitter) && resubmitAt && !hasAlreadySubmitted && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <p className="font-medium text-amber-900">Quản lý yêu cầu bạn thực hiện lại task này</p>
          {(() => {
            const reason = (lastResubmitLog?.metadata as Record<string, unknown> | null)?.reason
            return reason ? <p className="text-amber-800 mt-1">Lý do: {String(reason)}</p> : null
          })()}
          <p className="text-xs text-amber-700 mt-1">Kết quả cũ đã được lưu lại. Vui lòng nộp lại bên dưới.</p>
        </div>
      )}

      {/* Details card */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-muted-foreground">Trạng thái</span>
              <div className="mt-1 flex items-center gap-2 flex-wrap">
                <TaskStatusBadge status={displayStatus} />
                {canSeeStatusSelector && (
                  <TaskStatusSelector
                    taskId={id}
                    currentStatus={displayStatus}
                    userRole={userRole}
                  />
                )}
                {submittedLocked && (
                  <p className="text-xs text-amber-700 mt-1">
                    Task đã nộp. Nếu cần chỉnh sửa, vui lòng chờ quản lý yêu cầu làm lại.
                  </p>
                )}
                {displayStatus === 'overdue' && isSubmitterForTask && !hasAlreadySubmitted && (
                  <p className="text-xs text-red-600 mt-1">
                    Task đã quá hạn. Vui lòng liên hệ quản lý để gia hạn deadline trước khi nộp kết quả.
                  </p>
                )}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Ưu tiên</span>
              <div className="mt-1"><TaskPriorityBadge priority={task.priority as Task['priority']} /></div>
            </div>
            <div>
              <span className="text-muted-foreground">Cửa hàng</span>
              <p className="mt-1 font-medium">
                {(task.stores as { name: string } | null)?.name ?? '—'}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Người thực hiện</span>
              {canReassign ? (
                <div className="mt-1">
                  <TaskReassignForm
                    taskId={id}
                    currentAssignedTo={task.assigned_to}
                    storeUsers={storeUsers ?? []}
                  />
                </div>
              ) : (
                <p className="mt-1 font-medium">
                  {(task.assignee as { full_name: string } | null)?.full_name ?? 'Chưa phân công'}
                </p>
              )}
            </div>
            {task.start_date && (
              <div>
                <span className="text-muted-foreground">Ngày bắt đầu</span>
                <p className="mt-1 font-medium">{formatDate(task.start_date)}</p>
              </div>
            )}
            <div>
              <span className="text-muted-foreground">Deadline</span>
              <p className="mt-1 font-medium">
                {task.deadline ? formatDate(task.deadline) : '—'}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Phạm vi hiển thị</span>
              <p className="mt-1 font-medium">
                {task.visibility === 'public' ? 'Tất cả'
                  : task.visibility === 'store' ? 'Cả store'
                  : 'Chỉ người được giao'}
              </p>
            </div>
          </div>

          {task.description && (
            <>
              <Separator />
              <div>
                <p className="text-xs text-muted-foreground mb-1">Mô tả</p>
                <p className="text-sm whitespace-pre-wrap">{task.description}</p>
              </div>
            </>
          )}

          {(task.required_outputs as RequiredOutput[])?.length > 0 && (
            <>
              <Separator />
              <div>
                <p className="text-xs text-muted-foreground mb-1">Output cần nộp</p>
                <div className="flex flex-wrap gap-1.5">
                  {(task.required_outputs as RequiredOutput[]).map((o) => (
                    <span key={o} className="text-xs bg-muted px-2 py-0.5 rounded">
                      {OUTPUT_LABEL[o] ?? o}
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Input data table */}
      {task.input_data && Object.keys(task.input_data as object).length > 0 && (
        <InputDataDisplay inputData={task.input_data as Record<string, unknown>} />
      )}

      {/* Extend deadline — for admin/manager when task is overdue */}
      {canReviewTask && displayStatus === 'overdue' && (
        <ExtendDeadlineForm
          taskId={id}
          extendFn={extendDeadline}
          currentDeadline={task.deadline ?? null}
        />
      )}

      {/* Submit form — only for the assigned person */}
      {canSubmit && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Nộp kết quả</CardTitle>
          </CardHeader>
          <CardContent>
            <TaskSubmitForm
              taskId={id}
              requiredOutputs={(task.required_outputs as RequiredOutput[]) ?? []}
            />
          </CardContent>
        </Card>
      )}

      {/* Submissions — click each card to view full detail */}
      {(results ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Kết quả đã nộp ({results?.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {results!.map((r) => (
              <TaskResultCard
                key={r.id}
                result={{
                  id:             r.id,
                  submitted_at:   r.submitted_at,
                  output_data:    r.output_data as Record<string, unknown>,
                  submitter_name: (r.users as unknown as { full_name: string } | null)?.full_name ?? null,
                }}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Warning when task has results but status is not done (e.g. status was changed back) */}
      {canReviewTask && hasValidSubmission && task.status !== 'done' && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          Task đã có kết quả nộp nhưng trạng thái hiện không phải Hoàn thành. Có thể yêu cầu làm lại hoặc chỉnh trạng thái.
        </div>
      )}

      {/* Request resubmit — manager can ask staff to redo after submission */}
      {canReviewTask && hasValidSubmission && (
        <RequestResubmitSection taskId={id} requestFn={requestResubmit} />
      )}

      {/* Manager review notes — admin/manager can add; staff can read on their own tasks */}
      <TaskReviewNote
        taskId={id}
        reviews={(reviewLogs ?? []).map((r) => ({
          id:         r.id,
          created_at: r.created_at,
          metadata:   r.metadata as Record<string, unknown> | null,
          users:      (r.users as unknown as { full_name: string } | null),
        }))}
        canAddNote={canReassign}
      />

      {/* Feedback threads — store_manager ↔ admin Q&A; staff cannot see */}
      {(canCreateFeedback || canReplyFeedback) && (
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
    </div>
  )
}
