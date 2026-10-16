import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { canAdminManageOwn } from '@/lib/authz'
import { type ScheduleCollaboratorRow } from '@/components/tasks/ShareScheduleDialog'
import {
  ScheduleDetailView, ScheduleDetailErrorView,
  type ScheduleTemplateConfig, type ScheduleRun, type ScheduleRecentTask,
} from '@/components/tasks/ScheduleDetailView'

// WAVE A1 (UI design system): visual-only — queries, RBAC (owner/collaborator),
// pause/resume/delete, native <details> accordion all untouched.
// UI v2 P1.5: phần trình bày nằm ở ScheduleDetailView (dùng chung với fixture /ui-catalog/schedules-v2);
// page giữ cổng admin + 4(+2) truy vấn + phân biệt 404/lỗi + tính quyền owner/editor.
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
    return <ScheduleDetailErrorView message={schedError.message} />
  }
  if (!sched) notFound()

  const template = sched.task_templates as unknown as {
    id: string; title: string
    config: ScheduleTemplateConfig
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

  return (
    <ScheduleDetailView
      scheduleId={id}
      data={{
        title: template?.title ?? null,
        is_active: sched.is_active,
        frequency: sched.frequency,
        assignment_mode: sched.assignment_mode,
        weekdays,
        month_day: sched.month_day,
        run_time: sched.run_time,
        deadline_offset_hours: sched.deadline_offset_hours,
        timezone: sched.timezone,
        start_date: sched.start_date,
        end_date: sched.end_date,
        last_run_at: sched.last_run_at,
        next_run_at: sched.next_run_at,
        config,
        stores: schedStores.map((ss) => ({ store_id: ss.store_id, name: ss.stores?.name ?? null })),
      }}
      runs={(runs ?? null) as ScheduleRun[] | null}
      runsError={runsError}
      recentTasks={(recentTasks ?? null) as unknown as ScheduleRecentTask[] | null}
      recentTasksError={recentTasksError}
      isOwner={isOwner}
      isEditorCollaborator={isEditorCollaborator}
      collaborators={(collaborators ?? []) as unknown as ScheduleCollaboratorRow[]}
      adminOptions={adminOptions}
      myCollabError={!!myCollabError}
      shareDataError={!!shareDataError}
    />
  )
}
