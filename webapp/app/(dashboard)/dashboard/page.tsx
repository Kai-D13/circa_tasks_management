import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getDefaultRoute } from '@/lib/routes'
import { requireSite } from '@/lib/site/context'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TaskStatusBadge } from '@/components/tasks/TaskStatusBadge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import Link from 'next/link'
import { formatDistanceToNow, formatDate } from '@/lib/dateUtils'
import { Radio, AlertCircle, CalendarClock } from 'lucide-react'
import { TaskCategory } from '@/types'
import { cn } from '@/lib/utils'

const CATEGORY_STYLE: Record<TaskCategory, string> = {
  training: 'bg-blue-100 text-blue-700',
  recall:   'bg-red-100 text-red-700',
  display:  'bg-green-100 text-green-700',
  audit:    'bg-amber-100 text-amber-700',
  other:    'bg-gray-100 text-gray-600',
}
const CATEGORY_LABEL: Record<TaskCategory, string> = {
  training: 'Training',
  recall:   'Thu hồi',
  display:  'Trưng bày',
  audit:    'Kiểm tra',
  other:    'Khác',
}

type DashboardRow =
  | {
      type:        'broadcast'
      broadcastId: string
      title:       string
      category:    string | null
      creator:     string | null
      total:       number
      done:        number
      deadline:    string | null
      createdAt:   string
    }
  | {
      type:      'task'
      id:        string
      title:     string
      category:  string | null
      status:    string
      store:     string | null
      creator:   string | null
      deadline:  string | null
      overdueAt: string | null
      createdAt: string
    }

export default async function DashboardPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  await requireSite('os') // FS site users never see OS surfaces
  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user!.id).single()

  // Staff don't need the heavy oversight dashboard (4 KPI counts + recent-activity
  // query). Redirect them to their workflow before any of those queries run — covers
  // direct /dashboard URLs too (the nav entry is already hidden for staff).
  if (profile?.role === 'staff') redirect(getDefaultRoute('staff'))

  const isAdmin = profile?.role === 'admin'

  // ── KPI queries (same for all roles — RLS already scopes visibility) ──────
  const [
    { count: total,      error: e1 },
    { count: done,       error: e2 },
    { count: overdue,    error: e3 },
    { count: inProgress, error: e4 },
  ] = await Promise.all([
    // staff_all parents are oversight-only (not submittable work items); exclude
    // them from all KPI counts so children aren't double-counted with the parent.
    supabase.from('tasks').select('*', { count: 'exact', head: true }).is('archived_at', null).neq('assignment_mode', 'staff_all').neq('source_type', 'inventory_trf'),
    supabase.from('tasks').select('*', { count: 'exact', head: true }).is('archived_at', null).eq('status', 'done').neq('assignment_mode', 'staff_all').neq('source_type', 'inventory_trf'),
    // Count tasks that are effectively overdue: DB status='overdue' (set by cron)
    // OR deadline already passed and not yet done. Mirrors the /tasks filter so
    // the KPI stays accurate even when a store moves an overdue task to in_progress.
    supabase.from('tasks').select('*', { count: 'exact', head: true }).is('archived_at', null)
      .or(`status.eq.overdue,and(deadline.lt.${new Date().toISOString()},status.neq.done)`)
      .neq('assignment_mode', 'staff_all').neq('source_type', 'inventory_trf'),
    supabase.from('tasks').select('*', { count: 'exact', head: true }).is('archived_at', null).eq('status', 'in_progress').neq('assignment_mode', 'staff_all').neq('source_type', 'inventory_trf'),
  ])
  const kpiError = e1 ?? e2 ?? e3 ?? e4

  // ── Recurring schedules summary (admin only) ────────────────────────────
  let recurringActive = 0
  let recurringPaused = 0
  let upcomingSchedules: { id: string; next_run_at: string; task_templates: unknown }[] = []

  if (isAdmin) {
    const [
      { count: rActive },
      { count: rPaused },
      { data: rUpcoming },
    ] = await Promise.all([
      supabase.from('task_schedules').select('*', { count: 'exact', head: true }).eq('is_active', true),
      supabase.from('task_schedules').select('*', { count: 'exact', head: true }).eq('is_active', false),
      supabase
        .from('task_schedules')
        .select('id, next_run_at, task_templates(title)')
        .eq('is_active', true)
        .order('next_run_at', { ascending: true })
        .limit(3),
    ])
    recurringActive   = rActive ?? 0
    recurringPaused   = rPaused ?? 0
    upcomingSchedules = (rUpcoming ?? []) as typeof upcomingSchedules
  }

  // ── Recent activity — role-aware ─────────────────────────────────────────
  let recentRows: DashboardRow[] = []
  let recentError: { message: string } | null = null

  if (isAdmin) {
    // Admin: query task_broadcasts table for accurate global progress
    const [
      { data: recentBroadcastsRaw, error: eb },
      { data: recentIndividualRaw, error: ei },
    ] = await Promise.all([
      supabase
        .from('task_broadcasts')
        .select('id, title, created_at')
        .order('created_at', { ascending: false })
        .limit(8),
      supabase
        .from('tasks')
        .select('id, title, status, category, deadline, created_at, overdue_at, stores(name), creator:users!created_by(full_name)')
        .is('broadcast_id', null)
        .is('parent_task_id', null)       // exclude staff_all children (they're folded under parent)
        .is('archived_at', null)
        .neq('source_type', 'inventory_trf')
        .order('created_at', { ascending: false })
        .limit(8),
    ])

    recentError = eb ?? ei ?? null

    if (!recentError) {
      // Fetch all task stats for those broadcasts in one query
      const broadcastIds = (recentBroadcastsRaw ?? []).map((b) => b.id)
      const broadcastStatResult = broadcastIds.length > 0
        ? await supabase
            .from('tasks')
            .select('broadcast_id, status, category, deadline, creator:users!created_by(full_name)')
            .in('broadcast_id', broadcastIds)
            .is('archived_at', null)
            .neq('assignment_mode', 'staff_all').neq('source_type', 'inventory_trf')  // parents are overview-only, count children only
        : { data: [] as { broadcast_id: string; status: string; category: string | null; deadline: string | null; creator?: { full_name: string } | null }[], error: null }
      const { data: broadcastTasksRaw, error: est } = broadcastStatResult
      if (est) recentError = est

      const broadcastRows: DashboardRow[] = (recentBroadcastsRaw ?? [])
        .map((b): DashboardRow | null => {
          const bTasks = (broadcastTasksRaw ?? []).filter((t) => t.broadcast_id === b.id)
          if (bTasks.length === 0) return null
          return {
            type:        'broadcast',
            broadcastId: b.id,
            title:       b.title,
            category:    bTasks[0]?.category ?? null,
            creator:     (bTasks[0]?.creator as unknown as { full_name: string } | null)?.full_name ?? null,
            total:       bTasks.length,
            done:        bTasks.filter((t) => t.status === 'done').length,
            deadline:    bTasks.reduce<string | null>((min, t) =>
              t.deadline && (!min || t.deadline < min) ? t.deadline : min, null),
            createdAt:   b.created_at,
          }
        })
        .filter((r): r is DashboardRow => r !== null)

      const taskRows: DashboardRow[] = (recentIndividualRaw ?? []).map((t) => ({
        type:      'task' as const,
        id:        t.id,
        title:     t.title,
        category:  t.category ?? null,
        status:    t.status,
        store:     (t.stores as unknown as { name: string } | null)?.name ?? null,
        creator:   (t.creator as unknown as { full_name: string } | null)?.full_name ?? null,
        deadline:  t.deadline ?? null,
        overdueAt: (t as { overdue_at?: string | null }).overdue_at ?? null,
        createdAt: t.created_at,
      }))

      recentRows = [...broadcastRows, ...taskRows]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 8)
    }
  } else {
    // Store manager / staff: query only tasks visible to them (RLS scopes to their store).
    // Group by broadcast_id so broadcasts appear as 1 row — counts reflect visible tasks only.
    const { data: visibleTasks, error: ev } = await supabase
      .from('tasks')
      .select('id, title, status, category, deadline, created_at, overdue_at, broadcast_id, assignment_mode, parent_task_id, stores(name), creator:users!created_by(full_name)')
      .is('archived_at', null)
      .neq('source_type', 'inventory_trf')
      .order('created_at', { ascending: false })
      .limit(50)

    recentError = ev ?? null

    if (!recentError) {
      const seenBc = new Map<string, DashboardRow & { type: 'broadcast' }>()
      const bcRows: DashboardRow[] = []
      const indRows: DashboardRow[] = []

      for (const t of visibleTasks ?? []) {
        const assignmentMode = (t as { assignment_mode?: string | null }).assignment_mode
        const parentTaskId   = (t as { parent_task_id?: string | null }).parent_task_id

        // staff_all parents are overview-only; store_manager RLS still surfaces them
        // but they should not appear in the activity feed or inflate broadcast counts.
        if (assignmentMode === 'staff_all') continue

        // staff_all children carry broadcast_id but must appear as individual task rows
        // so the store_manager sees each pharmacist's progress directly.
        if (!t.broadcast_id || parentTaskId) {
          indRows.push({
            type:      'task',
            id:        t.id,
            title:     t.title,
            category:  t.category ?? null,
            status:    t.status,
            store:     (t.stores as unknown as { name: string } | null)?.name ?? null,
            creator:   (t.creator as unknown as { full_name: string } | null)?.full_name ?? null,
            deadline:  t.deadline ?? null,
            overdueAt: (t as { overdue_at?: string | null }).overdue_at ?? null,
            createdAt: t.created_at,
          })
        } else {
          if (seenBc.has(t.broadcast_id)) {
            const row = seenBc.get(t.broadcast_id)!
            row.total++
            if (t.status === 'done') row.done++
            if (t.deadline && (!row.deadline || t.deadline < row.deadline)) row.deadline = t.deadline
          } else {
            const row: DashboardRow & { type: 'broadcast' } = {
              type:        'broadcast',
              broadcastId: t.broadcast_id,
              title:       t.title,
              category:    t.category ?? null,
              creator:     (t.creator as unknown as { full_name: string } | null)?.full_name ?? null,
              total:       1,
              done:        t.status === 'done' ? 1 : 0,
              deadline:    t.deadline ?? null,
              createdAt:   t.created_at,
            }
            seenBc.set(t.broadcast_id, row)
            bcRows.push(row)
          }
        }
      }

      recentRows = [...bcRows, ...indRows]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 8)
    }
  }

  const kpis = [
    { label: 'Tổng Tasks đang hoạt động', value: total ?? 0,      color: 'text-foreground' },
    { label: 'Đang thực hiện',            value: inProgress ?? 0, color: 'text-blue-600' },
    { label: 'Hoàn thành',                value: done ?? 0,       color: 'text-green-600' },
    { label: 'Quá hạn',                   value: overdue ?? 0,    color: 'text-red-600' },
  ]

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6">
      <h1 className="text-lg md:text-xl font-semibold">Tổng quan</h1>

      {kpiError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 flex items-center gap-2 text-sm">
          <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
          <span className="text-destructive font-medium">Lỗi tải KPI:</span>
          <span className="text-muted-foreground">{kpiError.message}</span>
          {kpiError.message.includes('archived_at') && (
            <span className="text-muted-foreground">— Vui lòng chạy migration <code className="font-mono text-xs bg-muted px-1 rounded">011_archive_tasks.sql</code></span>
          )}
        </div>
      )}

      {/* KPI Cards — 2 cols on mobile, 4 on desktop */}
      <div className="grid grid-cols-2 gap-3 md:gap-4 md:grid-cols-4">
        {kpis.map(({ label, value, color }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <p className="text-xs font-medium text-muted-foreground leading-snug">{label}</p>
              <p className={`text-3xl font-bold mt-1 ${color}`}>{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Recurring summary — admin only */}
      {isAdmin && (recurringActive > 0 || recurringPaused > 0) && (
        <Card>
          <CardHeader className="pb-2 px-4 pt-4 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-1.5">
              <CalendarClock className="h-4 w-4 text-muted-foreground" />
              Task định kỳ
            </CardTitle>
            <Link href="/tasks/schedules" className="text-xs text-primary hover:underline">
              Xem tất cả →
            </Link>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="flex gap-4 mb-3 text-sm">
              <span>
                <span className="font-semibold text-green-600">{recurringActive}</span>
                <span className="text-muted-foreground ml-1">đang hoạt động</span>
              </span>
              {recurringPaused > 0 && (
                <span>
                  <span className="font-semibold text-gray-500">{recurringPaused}</span>
                  <span className="text-muted-foreground ml-1">tạm dừng</span>
                </span>
              )}
            </div>
            {upcomingSchedules.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground mb-2">Sắp chạy tiếp</p>
                {upcomingSchedules.map((s) => {
                  const title = (s.task_templates as unknown as { title: string } | null)?.title ?? '—'
                  return (
                    <div key={s.id} className="flex items-center justify-between text-sm">
                      <Link href={`/tasks/schedules/${s.id}`} className="hover:underline truncate max-w-[60%]">
                        {title}
                      </Link>
                      <span className="text-xs text-muted-foreground whitespace-nowrap ml-2">
                        {formatDate(s.next_run_at)}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Recent Activity */}
      <Card>
        <CardHeader className="pb-2 px-4 pt-4 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">Hoạt động gần đây</CardTitle>
          <Link href="/tasks" className="text-xs text-primary hover:underline">
            Xem tất cả trong Tasks →
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          {recentError ? (
            <div className="px-4 py-4 flex items-start gap-2 text-sm">
              <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-destructive">Không thể tải danh sách gần đây</p>
                <p className="text-muted-foreground mt-0.5">{recentError.message}</p>
              </div>
            </div>
          ) : (
            <>
              {/* Desktop */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tiêu đề</TableHead>
                      <TableHead>Loại</TableHead>
                      <TableHead>Cửa hàng</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead>Deadline</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentRows.map((row) => {
                      if (row.type === 'broadcast') {
                        return (
                          <TableRow key={`bc-${row.broadcastId}`} className="bg-primary/5">
                            <TableCell>
                              <div className="flex items-center gap-1.5 font-medium">
                                <Radio className="h-3.5 w-3.5 text-primary shrink-0" />
                                {row.title}
                              </div>
                              <p className="mt-0.5 ml-5 text-xs text-muted-foreground">Tạo bởi {row.creator ?? '—'}</p>
                            </TableCell>
                            <TableCell>
                              {row.category && row.category !== 'other' ? (
                                <span className={cn('text-xs px-1.5 py-0.5 rounded', CATEGORY_STYLE[row.category as TaskCategory] ?? 'bg-gray-100 text-gray-600')}>
                                  {CATEGORY_LABEL[row.category as TaskCategory] ?? row.category}
                                </span>
                              ) : '—'}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {row.total} cửa hàng
                            </TableCell>
                            <TableCell className="text-sm">
                              <span className={cn('font-medium', row.done === row.total ? 'text-green-600' : 'text-amber-600')}>
                                {row.done}/{row.total}
                              </span>
                              <span className="text-muted-foreground"> hoàn thành</span>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {row.deadline ? formatDistanceToNow(row.deadline) : '—'}
                            </TableCell>
                          </TableRow>
                        )
                      }
                      return (
                        <TableRow key={`task-${row.id}`}>
                          <TableCell>
                            <Link href={`/tasks/${row.id}`} className="font-medium hover:underline">
                              {row.title}
                            </Link>
                            <p className="mt-0.5 text-xs text-muted-foreground">Tạo bởi {row.creator ?? '—'}</p>
                          </TableCell>
                          <TableCell>
                            {row.category && row.category !== 'other' ? (
                              <span className={cn('text-xs px-1.5 py-0.5 rounded', CATEGORY_STYLE[row.category as TaskCategory] ?? 'bg-gray-100 text-gray-600')}>
                                {CATEGORY_LABEL[row.category as TaskCategory] ?? row.category}
                              </span>
                            ) : '—'}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">{row.store ?? '—'}</TableCell>
                          <TableCell>
                            <TaskStatusBadge status={row.status as 'todo' | 'in_progress' | 'done' | 'overdue'} late={row.status === 'done' && !!row.overdueAt} />
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {row.deadline ? formatDistanceToNow(row.deadline) : '—'}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                    {recentRows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                          Chưa có task nào đang hoạt động
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile */}
              <div className="md:hidden divide-y">
                {recentRows.length === 0 && (
                  <p className="text-center text-muted-foreground py-8 text-sm">Chưa có task nào đang hoạt động</p>
                )}
                {recentRows.map((row) => {
                  if (row.type === 'broadcast') {
                    return (
                      <div key={`bc-${row.broadcastId}`} className="flex flex-col gap-1.5 px-4 py-3 bg-primary/5">
                        <div className="flex items-start gap-1.5">
                          <Radio className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
                          <span className="font-medium text-sm leading-snug">{row.title}</span>
                        </div>
                        <p className="pl-5 text-xs text-muted-foreground">Tạo bởi {row.creator ?? '—'}</p>
                        <div className="flex items-center gap-2 flex-wrap pl-5">
                          {row.category && row.category !== 'other' && (
                            <span className={cn('text-xs px-1.5 py-0.5 rounded', CATEGORY_STYLE[row.category as TaskCategory] ?? 'bg-gray-100 text-gray-600')}>
                              {CATEGORY_LABEL[row.category as TaskCategory] ?? row.category}
                            </span>
                          )}
                          <span className={cn('text-xs font-medium', row.done === row.total ? 'text-green-600' : 'text-amber-600')}>
                            {row.done}/{row.total} hoàn thành
                          </span>
                          {row.deadline && (
                            <span className="text-xs text-muted-foreground">{formatDistanceToNow(row.deadline)}</span>
                          )}
                        </div>
                      </div>
                    )
                  }
                  return (
                    <Link key={`task-${row.id}`} href={`/tasks/${row.id}`} className="flex flex-col gap-1.5 px-4 py-3 hover:bg-muted/40 active:bg-muted/60">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-medium text-sm leading-snug">{row.title}</span>
                        {row.category && row.category !== 'other' && (
                          <span className={cn('text-xs px-1.5 py-0.5 rounded shrink-0', CATEGORY_STYLE[row.category as TaskCategory] ?? 'bg-gray-100 text-gray-600')}>
                            {CATEGORY_LABEL[row.category as TaskCategory] ?? row.category}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">Tạo bởi {row.creator ?? '—'}</p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <TaskStatusBadge status={row.status as 'todo' | 'in_progress' | 'done' | 'overdue'} late={row.status === 'done' && !!row.overdueAt} />
                        <span className="text-xs text-muted-foreground">{row.store ?? '—'}</span>
                        {row.deadline && (
                          <span className="text-xs text-muted-foreground">{formatDistanceToNow(row.deadline)}</span>
                        )}
                      </div>
                    </Link>
                  )
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        Trang tổng quan chỉ hiển thị task đang hoạt động.{' '}
        <Link href="/tasks" className="text-primary hover:underline">Vào Tasks</Link>{' '}
        để quản lý chi tiết.
      </p>
    </div>
  )
}
