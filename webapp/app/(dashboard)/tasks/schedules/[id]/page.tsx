import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { canAdminManageOwn } from '@/lib/authz'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DetailPageShell } from '@/components/ds/DetailPageShell'
import { ErrorState } from '@/components/ds/ErrorState'
import { StatusBadge, type StatusTone } from '@/components/ds/StatusBadge'
import { TagBadge, type TagHue } from '@/components/ds/TagBadge'
import { ScheduleActions } from '@/components/tasks/ScheduleActions'
import { ShareScheduleDialog, type ScheduleCollaboratorRow } from '@/components/tasks/ShareScheduleDialog'
import { RichText } from '@/components/tasks/RichText'
import { TaskStatusBadge } from '@/components/tasks/TaskStatusBadge'
import { TaskPriorityBadge } from '@/components/tasks/TaskPriorityBadge'
import { CalendarClock, ChevronRight, Store } from 'lucide-react'
import { formatDate } from '@/lib/dateUtils'
import { TaskCategory, TaskPriority, TaskStatus } from '@/types'

// WAVE A1 (UI design system): visual-only — queries, RBAC (owner/collaborator),
// pause/resume/delete, native <details> accordion all untouched.
const FREQ_LABEL: Record<string, string> = {
  daily:   'Mỗi ngày',
  weekly:  'Mỗi tuần',
  monthly: 'Mỗi tháng',
}

const WEEKDAY_LABELS: Record<number, string> = {
  0: 'Chủ nhật', 1: 'Thứ Hai', 2: 'Thứ Ba', 3: 'Thứ Tư',
  4: 'Thứ Năm', 5: 'Thứ Sáu', 6: 'Thứ Bảy',
}

const CATEGORY_LABEL: Record<TaskCategory, string> = {
  training: 'Training', recall: 'Thu hồi / Kiểm kê',
  display: 'Trưng bày', audit: 'Kiểm tra', other: 'Khác',
}
// Category = taxonomy → TagBadge hues (same axis as /tasks).
const CATEGORY_HUE: Record<TaskCategory, TagHue> = {
  training: 'blue', recall: 'red', display: 'green', audit: 'amber', other: 'gray',
}
const OUTPUT_LABEL: Record<string, string> = {
  text: 'Ghi chú', image: 'Ảnh', video: 'Video', file: 'File',
}
// Run outcome = semantic status → StatusBadge tones.
const RUN_STATUS_TONE: Record<string, StatusTone> = {
  success: 'success', failed: 'danger', running: 'info', skipped: 'neutral',
}
const RUN_STATUS_LABEL: Record<string, string> = {
  success: 'Thành công', failed: 'Lỗi', running: 'Đang chạy', skipped: 'Bỏ qua',
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2 border-b last:border-0">
      <span className="text-xs text-muted-foreground w-36 shrink-0 pt-0.5">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  )
}

export default async function ScheduleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase.from('users').select('role, email').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/tasks')

  const [
    { data: sched, error: schedError },
    { data: runs, error: runsError },
    { data: recentTasks, error: recentTasksError },
    { data: myCollabRow, error: myCollabError },
  ] = await Promise.all([
    supabase
      .from('task_schedules')
      .select(`
        *,
        task_templates ( id, title, config, created_by ),
        task_schedule_stores ( store_id, stores ( id, name ) )
      `)
      .eq('id', id)
      .single(),
    supabase
      .from('task_generation_runs')
      .select('id, scheduled_for, status, created_count, error_message, started_at, finished_at')
      .eq('schedule_id', id)
      .order('started_at', { ascending: false })
      .limit(10),
    supabase
      .from('tasks')
      .select('id, title, status, scheduled_for, deadline, created_at, overdue_at, stores(name)')
      .eq('source_schedule_id', id)
      .is('parent_task_id', null)   // staff_all: show one parent per store/run, not every child
      .order('created_at', { ascending: false })
      .limit(300),
    // Own collaborator row — decides whether a non-owner may pause/resume.
    supabase
      .from('task_schedule_collaborators')
      .select('permission')
      .eq('schedule_id', id)
      .eq('admin_id', user.id)
      .maybeSingle(),
  ])

  // Distinguish a genuine 404 (single() with no rows → PGRST116) from a real
  // query/RLS failure — the latter must surface as an error, not "not found".
  if (schedError && schedError.code !== 'PGRST116') {
    return (
      <DetailPageShell backHref="/tasks/schedules" backLabel="Định kỳ" title="Chi tiết lịch">
        <ErrorState message="Không thể tải lịch định kỳ" hint={schedError.message} />
      </DetailPageShell>
    )
  }
  if (!sched) notFound()

  const template = sched.task_templates as unknown as {
    id: string; title: string
    config: {
      description?: string; category: TaskCategory; priority: string
      visibility: string; required_outputs: string[]
      input_data?: { attachments?: { name: string; url: string }[]; links?: { label: string; url: string }[] }
    }
    created_by: string | null
  } | null

  const isOwner = canAdminManageOwn({
    email: profile?.email, role: profile?.role,
    createdBy: template?.created_by, userId: user.id,
  })
  const isEditorCollaborator = !isOwner && myCollabRow?.permission === 'editor'

  // Share dialog data — only the owner (or super admin) needs it.
  const [
    { data: collaborators, error: collaboratorsError },
    { data: allAdmins, error: allAdminsError },
  ] = isOwner
    ? await Promise.all([
        supabase
          .from('task_schedule_collaborators')
          .select('admin_id, permission, users!admin_id(full_name)')
          .eq('schedule_id', id),
        supabase
          .from('users')
          .select('id, full_name, email')
          .eq('role', 'admin')
          .neq('id', user.id)
          .order('full_name'),
      ])
    : [{ data: [] as ScheduleCollaboratorRow[], error: null }, { data: [] as { id: string; full_name: string; email: string }[], error: null }]
  // A failed collaborator/admin fetch must NOT render the share dialog with
  // empty lists (reads as "no one to share with"); suppress it + warn instead.
  const shareDataError = collaboratorsError ?? allAdminsError

  const adminOptions = (allAdmins ?? [])
    .filter((a) => a.id !== template?.created_by)
    .map((a) => ({ value: a.id, label: a.full_name, description: a.email }))

  const schedStores = (sched.task_schedule_stores as unknown as { store_id: string; stores: { id: string; name: string } | null }[]) ?? []
  const weekdays    = (sched.weekdays as number[] | null) ?? []
  const config      = template?.config

  // Group generated tasks by run date (scheduled_for) so each cron run collapses
  // into one expandable row (Lần chạy → cửa hàng), instead of a long flat list.
  type RecentTask = {
    id: string; status: string; scheduled_for: string | null
    deadline: string | null; overdue_at: string | null; stores: { name: string } | null
  }
  const recentByRun = new Map<string, RecentTask[]>()
  for (const t of (recentTasks ?? []) as unknown as RecentTask[]) {
    const key = t.scheduled_for ?? 'unknown'
    const arr = recentByRun.get(key) ?? []
    arr.push(t)
    recentByRun.set(key, arr)
  }
  const runGroups = [...recentByRun.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))

  return (
    <DetailPageShell
      className="max-w-4xl md:p-6 space-y-5"
      backHref="/tasks/schedules"
      backLabel="Định kỳ"
      title={template?.title ?? '—'}
      badges={
        <>
          <StatusBadge tone={sched.is_active ? 'success' : 'neutral'}>
            {sched.is_active ? 'Đang hoạt động' : 'Tạm dừng'}
          </StatusBadge>
          {config?.category && (
            <TagBadge hue={CATEGORY_HUE[config.category] ?? 'gray'}>
              {CATEGORY_LABEL[config.category] ?? config.category}
            </TagBadge>
          )}
        </>
      }
      meta={
        <span className="flex items-center gap-1.5">
          <CalendarClock className="h-3.5 w-3.5" />
          {FREQ_LABEL[sched.frequency] ?? sched.frequency} · Lần tiếp: {sched.next_run_at ? formatDate(sched.next_run_at) : '—'}
        </span>
      }
      actions={
        <>
          {/* Owner share dialog — suppressed if its data failed to load (an
              empty dialog reads as "no admins to share with"). */}
          {isOwner && !shareDataError && (
            <ShareScheduleDialog
              scheduleId={id}
              collaborators={(collaborators ?? []) as unknown as ScheduleCollaboratorRow[]}
              adminOptions={adminOptions}
            />
          )}
          {/* View-only collaborators get no pause/resume — RLS would reject it
              as a silent 0-row update, which the action would misreport as success. */}
          {(isOwner || isEditorCollaborator) && (
            <ScheduleActions scheduleId={id} isActive={sched.is_active} canDelete={isOwner} />
          )}
        </>
      }
    >
      {/* A failed own-collaborator read leaves pause/resume gating uncertain;
          a failed share-data read hides the dialog — warn in both cases. */}
      {(myCollabError || shareDataError) && (
        <ErrorState
          message="Một số thông tin quyền không tải được"
          hint={
            (myCollabError ? 'Không kiểm tra được quyền cộng tác. ' : '')
            + (shareDataError ? 'Danh sách chia sẻ tạm thời không khả dụng. ' : '')
            + 'Vui lòng tải lại trang.'
          }
        />
      )}
      {/* 2-col layout on md+ */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Schedule config */}
        <Card className="rounded-lg">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Cấu hình lịch</CardTitle>
          </CardHeader>
          <CardContent className="text-sm px-4 pb-4">
            <Row label="Chế độ giao">
              {sched.assignment_mode === 'staff_all' ? 'Từng dược sĩ nộp' : 'Cửa hàng nộp'}
            </Row>
            <Row label="Tần suất">{FREQ_LABEL[sched.frequency] ?? sched.frequency}</Row>
            {sched.frequency === 'weekly' && weekdays.length > 0 && (
              <Row label="Ngày trong tuần">
                <div className="flex flex-wrap gap-1">
                  {weekdays.sort().map((d) => (
                    <span key={d} className="bg-muted text-xs px-2 py-0.5 rounded">{WEEKDAY_LABELS[d]}</span>
                  ))}
                </div>
              </Row>
            )}
            {sched.frequency === 'monthly' && sched.month_day && (
              <Row label="Ngày trong tháng">Ngày {sched.month_day}</Row>
            )}
            <Row label="Giờ tạo task">{sched.run_time ?? '—'}</Row>
            <Row label="Deadline sau khi tạo">{sched.deadline_offset_hours}h</Row>
            <Row label="Múi giờ">{sched.timezone}</Row>
            <Row label="Ngày bắt đầu">{sched.start_date ? formatDate(sched.start_date) : '—'}</Row>
            <Row label="Ngày kết thúc">{sched.end_date ? formatDate(sched.end_date) : 'Không giới hạn'}</Row>
            <Row label="Lần chạy gần nhất">{sched.last_run_at ? formatDate(sched.last_run_at) : 'Chưa chạy'}</Row>
            <Row label="Lần chạy tiếp theo">{sched.next_run_at ? formatDate(sched.next_run_at) : '—'}</Row>
          </CardContent>
        </Card>

        {/* Template content */}
        <Card className="rounded-lg">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Nội dung task</CardTitle>
          </CardHeader>
          <CardContent className="text-sm px-4 pb-4">
            <Row label="Ưu tiên">
              {config?.priority ? <TaskPriorityBadge priority={config.priority as TaskPriority} /> : '—'}
            </Row>
            <Row label="Output cần nộp">
              {config?.required_outputs?.length ? (
                <div className="flex flex-wrap gap-1">
                  {config.required_outputs.map((o) => (
                    <span key={o} className="bg-muted text-xs px-2 py-0.5 rounded">{OUTPUT_LABEL[o] ?? o}</span>
                  ))}
                </div>
              ) : '—'}
            </Row>
            {config?.description && (
              <Row label="Mô tả">
                <RichText value={config.description} />
              </Row>
            )}
            {(config?.input_data?.attachments?.length ?? 0) > 0 && (
              <Row label="Tài liệu đính kèm">
                <div className="space-y-1">
                  {config!.input_data!.attachments!.map((a, i) => (
                    <a key={i} href={a.url} target="_blank" rel="noreferrer" className="text-primary hover:underline block break-words">{a.name}</a>
                  ))}
                </div>
              </Row>
            )}
            {(config?.input_data?.links?.length ?? 0) > 0 && (
              <Row label="Links">
                <div className="space-y-1">
                  {config!.input_data!.links!.map((l, i) => (
                    <a key={i} href={l.url} target="_blank" rel="noreferrer" className="text-primary hover:underline block break-words">{l.label || l.url}</a>
                  ))}
                </div>
              </Row>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Stores */}
      <Card className="rounded-lg">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Store className="h-4 w-4 text-muted-foreground" />
            Cửa hàng nhận task ({schedStores.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-4">
          {schedStores.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có cửa hàng nào</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {schedStores.map((ss) => (
                <span key={ss.store_id} className="text-xs bg-muted px-2.5 py-1 rounded">
                  {ss.stores?.name ?? ss.store_id.slice(0, 8)}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent generation runs */}
      <Card className="rounded-lg">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Lịch sử chạy</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {runsError ? (
            <div className="px-4 pb-4"><ErrorState message="Không tải được lịch sử chạy" hint={runsError.message} /></div>
          ) : (!runs || runs.length === 0) ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">Chưa có lần chạy nào</p>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="border-b">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Ngày</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Kết quả</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Task tạo</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Chi tiết</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {runs.map((r) => (
                  <tr key={r.id} className="hover:bg-muted/30">
                    <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                      {r.scheduled_for ?? '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge tone={RUN_STATUS_TONE[r.status] ?? 'neutral'}>
                        {RUN_STATUS_LABEL[r.status] ?? r.status}
                      </StatusBadge>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {r.created_count ?? 0} task
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground text-xs max-w-[200px] truncate">
                      {r.error_message ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent tasks generated */}
      <Card className="rounded-lg">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Task đã tạo gần đây</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {recentTasksError ? (
            <div className="px-4 pb-4"><ErrorState message="Không tải được task đã tạo" hint={recentTasksError.message} /></div>
          ) : runGroups.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">Chưa có task nào được tạo</p>
          ) : (
            runGroups.map(([date, tasks], idx) => {
              const done = tasks.filter((t) => t.status === 'done').length
              return (
                <details key={date} open={idx === 0} className="group border-b last:border-0">
                  <summary className="flex items-center gap-2 px-4 min-h-[44px] py-2.5 cursor-pointer hover:bg-muted/30 list-none select-none">
                    <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90 shrink-0" />
                    <span className="font-medium text-sm">{date === 'unknown' ? '—' : formatDate(date)}</span>
                    <span className="text-xs text-muted-foreground">
                      · {tasks.length} task · <span className={done === tasks.length ? 'text-status-success' : 'text-status-warning'}>{done}/{tasks.length} hoàn thành</span>
                    </span>
                  </summary>
                  <div className="overflow-x-auto border-t">
                    <table className="w-full text-sm">
                      <tbody className="divide-y">
                        {tasks.map((t) => (
                          <tr key={t.id} className="hover:bg-muted/30">
                            <td className="px-4 py-2 pl-10 max-w-[220px]">
                              <Link href={`/tasks/${t.id}`} className="hover:underline block truncate" title={t.stores?.name ?? undefined}>
                                {t.stores?.name ?? '—'}
                              </Link>
                            </td>
                            <td className="px-4 py-2">
                              <TaskStatusBadge status={t.status as TaskStatus} late={t.status === 'done' && !!t.overdue_at} />
                            </td>
                            <td className="px-4 py-2 text-muted-foreground whitespace-nowrap text-right">
                              {t.deadline ? formatDate(t.deadline) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )
            })
          )}
        </CardContent>
      </Card>
    </DetailPageShell>
  )
}
