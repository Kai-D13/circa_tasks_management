import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getDefaultRoute } from '@/lib/routes'
import { TaskStatusBadge } from '@/components/tasks/TaskStatusBadge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import Link from 'next/link'
import { formatDistanceToNow, formatDate } from '@/lib/dateUtils'
import { Radio, LayoutDashboard } from 'lucide-react'
import { TaskCategory } from '@/types'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ds/PageHeader'
import { StatCard } from '@/components/ds/StatCard'
import { ErrorState } from '@/components/ds/ErrorState'
import { Panel } from '@/components/ds/Panel'
import { TagBadge, type TagHue } from '@/components/ds/TagBadge'

// Cùng ánh xạ hue danh mục với /tasks (components/tasks/TaskList CATEGORY_HUE) — thay pastel tự viết.
const CATEGORY_HUE: Record<TaskCategory, TagHue> = {
  training: 'blue',
  recall:   'red',
  display:  'green',
  audit:    'amber',
  other:    'gray',
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

  const kpis: { label: string; value: number; tone: 'default' | 'info' | 'success' | 'danger' }[] = [
    { label: 'Tổng Tasks đang hoạt động', value: total ?? 0,      tone: 'default' },
    { label: 'Đang thực hiện',            value: inProgress ?? 0, tone: 'info' },
    { label: 'Hoàn thành',                value: done ?? 0,       tone: 'success' },
    { label: 'Quá hạn',                   value: overdue ?? 0,    tone: 'danger' },
  ]

  const categoryTag = (category: string | null, className?: string) =>
    category && category !== 'other' ? (
      <TagBadge hue={CATEGORY_HUE[category as TaskCategory] ?? 'gray'} className={className}>
        {CATEGORY_LABEL[category as TaskCategory] ?? category}
      </TagBadge>
    ) : null
  const progressText = (done: number, total: number) =>
    done === total ? 'text-status-success' : 'text-status-warning'
  // Link phụ trên header khối: chữ accent (cam chỉ dành cho hành động chính), vùng chạm 44px mobile.
  const headerLink = 'inline-flex min-h-[44px] items-center text-[13px] font-medium text-accent-foreground hover:underline md:min-h-0'

  // UI v2 (docs/ui/UI_V2_TASKS.md, P1.1): chỉ đổi trình bày — query/quyền/chữ giữ nguyên.
  return (
    <div data-ui-v2="page" className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <PageHeader title="Tổng quan" icon={LayoutDashboard} />

      {kpiError && (
        <ErrorState
          message={`Lỗi tải KPI: ${kpiError.message}`}
          hint={kpiError.message.includes('archived_at') ? 'Vui lòng chạy migration 011_archive_tasks.sql' : undefined}
        />
      )}

      {/* KPI — 2 cột mobile, 4 cột desktop */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {kpis.map(({ label, value, tone }) => (
          <StatCard key={label} label={label} value={value} tone={tone} />
        ))}
      </div>

      {/* ≥1280px: Hoạt động gần đây (trái) + Task định kỳ (phải). Hẹp hơn: xếp dọc, giữ thứ tự cũ (định kỳ trước). */}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        {isAdmin && (recurringActive > 0 || recurringPaused > 0) && (
          <Panel
            title="Task định kỳ"
            actions={<Link href="/tasks/schedules" className={headerLink}>Xem tất cả →</Link>}
            className="xl:order-2 xl:w-[300px] xl:shrink-0"
            bodyClassName="space-y-3.5"
          >
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-v2-control bg-muted px-3 py-2.5">
                <p className="text-[22px] font-bold leading-tight tabular-nums text-status-success">{recurringActive}</p>
                <p className="text-[12px] text-muted-foreground">đang hoạt động</p>
              </div>
              {recurringPaused > 0 && (
                <div className="rounded-v2-control bg-muted px-3 py-2.5">
                  <p className="text-[22px] font-bold leading-tight tabular-nums">{recurringPaused}</p>
                  <p className="text-[12px] text-muted-foreground">tạm dừng</p>
                </div>
              )}
            </div>
            {upcomingSchedules.length > 0 && (
              <div>
                <p className="pb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-v2-text-3">Sắp chạy tiếp</p>
                {/* divide-y + border-t: vạch trên mỗi dòng như artboard; divide-y cũng để ui-baseline che vùng dữ liệu sống. */}
                <ul className="divide-y border-t">
                  {upcomingSchedules.map((s) => {
                    const title = (s.task_templates as unknown as { title: string } | null)?.title ?? '—'
                    return (
                      <li key={s.id} className="flex items-center justify-between gap-2.5 py-1 md:py-2.5">
                        <Link href={`/tasks/schedules/${s.id}`} className="inline-flex min-h-[44px] min-w-0 items-center text-[13px] font-medium hover:underline md:min-h-0">
                          <span className="truncate">{title}</span>
                        </Link>
                        <span className="whitespace-nowrap text-[12px] text-muted-foreground">
                          {formatDate(s.next_run_at)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </Panel>
        )}

        <Panel
          title="Hoạt động gần đây"
          flush
          actions={<Link href="/tasks" className={headerLink}>Xem tất cả trong Tasks →</Link>}
          className="min-w-0 xl:flex-1"
        >
          {recentError ? (
            <div className="p-4">
              <ErrorState message="Không thể tải danh sách gần đây" hint={recentError.message} />
            </div>
          ) : (
            <>
              {/* Desktop. ≥1280px + sidebar mở rộng (panel ~686px) bảng phải vừa: cột phụ ~460px, tiêu đề/cửa hàng ngắt ở mọi vị trí (P1.1-R1-01). Khung hẹp hơn 620px (tablet) cuộn ngang trong data-slot=table-container. */}
              <div className="hidden md:block">
                <Table className="min-w-[620px] [&_td:first-child]:pl-5 [&_th:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:last-child]:pr-5 [&_td]:px-3 [&_td]:py-3 [&_th]:px-3">
                  <TableHeader className="bg-muted [&_th]:h-auto [&_th]:py-2.5 [&_th]:text-[12px] [&_th]:font-medium [&_th]:text-muted-foreground">
                    <TableRow>
                      <TableHead>Tiêu đề</TableHead>
                      <TableHead className="w-[92px]">Loại</TableHead>
                      <TableHead className="w-[120px]">Cửa hàng</TableHead>
                      <TableHead className="w-[140px]">Trạng thái</TableHead>
                      <TableHead className="w-[108px]">Deadline</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentRows.map((row) => {
                      if (row.type === 'broadcast') {
                        return (
                          <TableRow key={`bc-${row.broadcastId}`}>
                            <TableCell className="whitespace-normal wrap-anywhere align-top">
                              <div className="flex items-start gap-1.5 font-semibold">
                                <Radio className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                {row.title}
                              </div>
                              <p className="mt-0.5 ml-5 text-[12px] text-v2-text-3">Tạo bởi {row.creator ?? '—'}</p>
                            </TableCell>
                            <TableCell className="align-top">{categoryTag(row.category) ?? '—'}</TableCell>
                            <TableCell className="align-top text-[13px] text-muted-foreground">
                              {row.total} cửa hàng
                            </TableCell>
                            <TableCell className="align-top text-[13px]">
                              <span className={cn('font-semibold tabular-nums', progressText(row.done, row.total))}>
                                {row.done}/{row.total}
                              </span>
                              <span className="text-muted-foreground"> hoàn thành</span>
                            </TableCell>
                            <TableCell className="align-top text-[13px] text-muted-foreground">
                              {row.deadline ? formatDistanceToNow(row.deadline) : '—'}
                            </TableCell>
                          </TableRow>
                        )
                      }
                      return (
                        <TableRow key={`task-${row.id}`}>
                          <TableCell className="whitespace-normal wrap-anywhere align-top">
                            <Link href={`/tasks/${row.id}`} className="font-semibold hover:underline">
                              {row.title}
                            </Link>
                            <p className="mt-0.5 text-[12px] text-v2-text-3">Tạo bởi {row.creator ?? '—'}</p>
                          </TableCell>
                          <TableCell className="align-top">{categoryTag(row.category) ?? '—'}</TableCell>
                          <TableCell className="whitespace-normal wrap-anywhere align-top text-[13px] text-muted-foreground">{row.store ?? '—'}</TableCell>
                          <TableCell className="align-top">
                            <TaskStatusBadge status={row.status as 'todo' | 'in_progress' | 'done' | 'overdue'} late={row.status === 'done' && !!row.overdueAt} />
                          </TableCell>
                          <TableCell className="align-top text-[13px] text-muted-foreground">
                            {row.deadline ? formatDistanceToNow(row.deadline) : '—'}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                    {recentRows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="py-8 text-center text-[13px] text-muted-foreground">
                          Chưa có task nào đang hoạt động
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile */}
              <div className="divide-y md:hidden">
                {recentRows.length === 0 && (
                  <p className="py-8 text-center text-[13px] text-muted-foreground">Chưa có task nào đang hoạt động</p>
                )}
                {recentRows.map((row) => {
                  if (row.type === 'broadcast') {
                    return (
                      <div key={`bc-${row.broadcastId}`} className="flex flex-col gap-1.5 px-4 py-3">
                        <div className="flex items-start gap-1.5">
                          <Radio className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 wrap-anywhere text-sm font-semibold leading-snug">{row.title}</span>
                        </div>
                        <p className="pl-5 text-[12px] text-v2-text-3">Tạo bởi {row.creator ?? '—'}</p>
                        <div className="flex flex-wrap items-center gap-2 pl-5">
                          {categoryTag(row.category)}
                          <span className={cn('text-[12px] font-semibold tabular-nums', progressText(row.done, row.total))}>
                            {row.done}/{row.total} hoàn thành
                          </span>
                          {row.deadline && (
                            <span className="text-[12px] text-muted-foreground">{formatDistanceToNow(row.deadline)}</span>
                          )}
                        </div>
                      </div>
                    )
                  }
                  return (
                    <Link key={`task-${row.id}`} href={`/tasks/${row.id}`} className="flex flex-col gap-1.5 px-4 py-3 hover:bg-muted/40 active:bg-muted/60">
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 wrap-anywhere text-sm font-semibold leading-snug">{row.title}</span>
                        {categoryTag(row.category, 'shrink-0')}
                      </div>
                      <p className="text-[12px] text-v2-text-3">Tạo bởi {row.creator ?? '—'}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <TaskStatusBadge status={row.status as 'todo' | 'in_progress' | 'done' | 'overdue'} late={row.status === 'done' && !!row.overdueAt} />
                        <span className="text-[12px] text-muted-foreground">{row.store ?? '—'}</span>
                        {row.deadline && (
                          <span className="text-[12px] text-muted-foreground">{formatDistanceToNow(row.deadline)}</span>
                        )}
                      </div>
                    </Link>
                  )
                })}
              </div>
            </>
          )}
        </Panel>
      </div>

      <p className="text-center text-[12px] text-v2-text-3">
        Trang tổng quan chỉ hiển thị task đang hoạt động.{' '}
        <Link href="/tasks" className="font-medium text-accent-foreground hover:underline">Vào Tasks</Link>{' '}
        để quản lý chi tiết.
      </p>
    </div>
  )
}
