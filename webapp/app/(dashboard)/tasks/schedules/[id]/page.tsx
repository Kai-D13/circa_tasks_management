import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { canAdminManageOwn } from '@/lib/authz'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScheduleActions } from '@/components/tasks/ScheduleActions'
import { ShareScheduleDialog, type ScheduleCollaboratorRow } from '@/components/tasks/ShareScheduleDialog'
import { TaskStatusBadge } from '@/components/tasks/TaskStatusBadge'
import { ArrowLeft, CalendarClock, Store } from 'lucide-react'
import { formatDate } from '@/lib/dateUtils'
import { TaskCategory, TaskStatus } from '@/types'
import { cn } from '@/lib/utils'

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
const CATEGORY_STYLE: Record<TaskCategory, string> = {
  training: 'bg-blue-100 text-blue-700', recall: 'bg-red-100 text-red-700',
  display: 'bg-green-100 text-green-700', audit: 'bg-amber-100 text-amber-700',
  other: 'bg-gray-100 text-gray-600',
}
const OUTPUT_LABEL: Record<string, string> = {
  text: 'Ghi chú', image: 'Ảnh', video: 'Video', file: 'File',
}
const PRIORITY_LABEL: Record<string, string> = {
  urgent: 'Khẩn cấp', normal: 'Bình thường',
}
const RUN_STATUS_STYLE: Record<string, string> = {
  success: 'bg-green-100 text-green-700',
  failed:  'bg-red-100 text-red-700',
  running: 'bg-blue-100 text-blue-700',
  skipped: 'bg-gray-100 text-gray-600',
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
    { data: sched },
    { data: runs },
    { data: recentTasks },
    { data: myCollabRow },
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
      .order('created_at', { ascending: false })
      .limit(20),
    // Own collaborator row — decides whether a non-owner may pause/resume.
    supabase
      .from('task_schedule_collaborators')
      .select('permission')
      .eq('schedule_id', id)
      .eq('admin_id', user.id)
      .maybeSingle(),
  ])

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
  const [{ data: collaborators }, { data: allAdmins }] = isOwner
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
    : [{ data: [] as ScheduleCollaboratorRow[] }, { data: [] as { id: string; full_name: string; email: string }[] }]

  const adminOptions = (allAdmins ?? [])
    .filter((a) => a.id !== template?.created_by)
    .map((a) => ({ value: a.id, label: a.full_name, description: a.email }))

  const schedStores = (sched.task_schedule_stores as unknown as { store_id: string; stores: { id: string; name: string } | null }[]) ?? []
  const weekdays    = (sched.weekdays as number[] | null) ?? []
  const config      = template?.config

  return (
    <div className="p-6 max-w-4xl space-y-5">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/tasks/schedules" className="flex items-center gap-1 hover:text-foreground transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" />
          Định kỳ
        </Link>
        <span>/</span>
        <span className="text-foreground font-medium truncate">{template?.title ?? 'Chi tiết lịch'}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold">{template?.title ?? '—'}</h1>
            <Badge className={sched.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}>
              {sched.is_active ? 'Đang hoạt động' : 'Tạm dừng'}
            </Badge>
            {config?.category && (
              <span className={cn('text-xs px-2 py-0.5 rounded font-medium', CATEGORY_STYLE[config.category] ?? 'bg-gray-100 text-gray-600')}>
                {CATEGORY_LABEL[config.category] ?? config.category}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground flex items-center gap-1.5">
            <CalendarClock className="h-3.5 w-3.5" />
            {FREQ_LABEL[sched.frequency] ?? sched.frequency} · Lần tiếp: {sched.next_run_at ? formatDate(sched.next_run_at) : '—'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isOwner && (
            <ShareScheduleDialog
              scheduleId={id}
              collaborators={(collaborators ?? []) as unknown as ScheduleCollaboratorRow[]}
              adminOptions={adminOptions}
            />
          )}
          {/* View-only collaborators get no pause/resume — RLS would reject it
              as a silent 0-row update, which the action would misreport as success. */}
          {(isOwner || isEditorCollaborator) && (
            <ScheduleActions scheduleId={id} isActive={sched.is_active} />
          )}
        </div>
      </div>

      {/* 2-col layout on md+ */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Schedule config */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Cấu hình lịch</CardTitle>
          </CardHeader>
          <CardContent className="text-sm px-4 pb-4">
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
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Nội dung task</CardTitle>
          </CardHeader>
          <CardContent className="text-sm px-4 pb-4">
            <Row label="Ưu tiên">
              {config?.priority ? (
                <span className={config.priority === 'urgent' ? 'text-red-600 font-medium' : ''}>
                  {PRIORITY_LABEL[config.priority] ?? config.priority}
                </span>
              ) : '—'}
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
                <span className="whitespace-pre-wrap leading-relaxed">{config.description}</span>
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
      <Card>
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
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Lịch sử chạy</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {(!runs || runs.length === 0) ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">Chưa có lần chạy nào</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
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
                      <span className={cn('text-xs px-2 py-0.5 rounded', RUN_STATUS_STYLE[r.status] ?? 'bg-gray-100 text-gray-600')}>
                        {RUN_STATUS_LABEL[r.status] ?? r.status}
                      </span>
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
          )}
        </CardContent>
      </Card>

      {/* Recent tasks generated */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Task đã tạo gần đây</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {(!recentTasks || recentTasks.length === 0) ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">Chưa có task nào được tạo</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Cửa hàng</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Ngày lịch</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Trạng thái</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Deadline</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {recentTasks.map((t) => (
                  <tr key={t.id} className="hover:bg-muted/30">
                    <td className="px-4 py-2.5">
                      <Link href={`/tasks/${t.id}`} className="hover:underline font-medium">
                        {(t.stores as unknown as { name: string } | null)?.name ?? '—'}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {(t.scheduled_for as string | null) ?? '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <TaskStatusBadge status={t.status as TaskStatus} late={t.status === 'done' && !!(t as { overdue_at?: string | null }).overdue_at} />
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                      {t.deadline ? formatDate(t.deadline) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
