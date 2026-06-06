import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { TaskFilters } from '@/components/tasks/TaskFilters'
import { TaskList, TaskListItem, BroadcastGroup, StaffGroup, TaskRow, ChildTask } from '@/components/tasks/TaskList'
import { AutoRefresh } from '@/components/common/AutoRefresh'
import { Plus, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 30

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; priority?: string; store_id?: string; category?: string; archived?: string; page?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  const { data: profile } = await supabase
    .from('users').select('role, store_id').eq('id', user!.id).single()

  const showArchived = params.archived === 'true'
  const page   = Math.max(1, parseInt(params.page ?? '1', 10) || 1)
  const offset = (page - 1) * PAGE_SIZE

  let query = supabase
    .from('tasks')
    // Narrow select — excludes description/input_data/required_outputs which grow
    // large when tasks have many attachments. Must be a single string literal so
    // Supabase's type inference doesn't fall back to GenericStringError.
    .select('id, title, status, priority, category, broadcast_id, source_schedule_id, parent_task_id, assignment_mode, deadline, created_at, overdue_at, store_id, stores(name), assignee:users!assigned_to(full_name)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1)

  if (showArchived) {
    query = query.not('archived_at', 'is', null)
  } else {
    query = query.is('archived_at', null)
  }

  if (params.status) {
    const now = new Date().toISOString()
    if (params.status === 'overdue') {
      // staff_all parents are never submittable/overdue; exclude them from overdue filter
      query = query
        .or(`status.eq.overdue,and(deadline.lt.${now},status.neq.done)`)
        .neq('assignment_mode', 'staff_all')
    } else if (params.status === 'todo' || params.status === 'in_progress') {
      query = query
        .eq('status', params.status)
        .or(`deadline.is.null,deadline.gte.${now}`)
    } else {
      query = query.eq('status', params.status)
    }
  }
  if (params.priority) query = query.eq('priority', params.priority)
  if (params.store_id) query = query.eq('store_id', params.store_id)
  if (params.category) query = query.eq('category', params.category)

  // For admin/manager with no status filter: exclude staff_all children from the
  // paginated count so the page count isn't inflated by N children per parent.
  // Children are fetched separately after this query and appended to allTasks.
  const topLevelOnly = (profile?.role === 'admin' || profile?.role === 'store_manager') && !params.status
  if (topLevelOnly) query = query.is('parent_task_id', null)

  const [{ data: tasks, error: tasksError, count }, { data: stores }] = await Promise.all([
    query,
    supabase.from('stores').select('id, name').order('name'),
  ])

  const totalRows  = count ?? 0
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE))

  const storesForFilter = profile?.role === 'staff' ? [] : (stores ?? [])
  const canCreate  = profile?.role === 'admin'
  const canArchive = !showArchived && profile?.role === 'admin'
  const canRestore = showArchived  && profile?.role === 'admin'

  // Fetch children for staff_all parents on this page (excluded from paginated query).
  let extraChildren: NonNullable<typeof tasks> = []
  if (topLevelOnly) {
    const parentIds = (tasks ?? [])
      .filter(t => (t as { assignment_mode?: string }).assignment_mode === 'staff_all')
      .map(t => t.id)
    if (parentIds.length > 0) {
      let childQ = supabase
        .from('tasks')
        .select('id, title, status, priority, category, broadcast_id, source_schedule_id, parent_task_id, assignment_mode, deadline, created_at, overdue_at, store_id, stores(name), assignee:users!assigned_to(full_name)')
        .in('parent_task_id', parentIds)
        .order('created_at', { ascending: true })
      if (showArchived) childQ = childQ.not('archived_at', 'is', null)
      else              childQ = childQ.is('archived_at', null)
      const { data: childData } = await childQ
      extraChildren = (childData ?? []) as unknown as NonNullable<typeof tasks>
    }
  }

  const allTasks = [...(tasks ?? []), ...extraChildren]

  // Pre-pass for staff_all groups: map each staff_all parent to its children, in
  // case pagination/ordering interleaves the parent and child rows. The parent is
  // created slightly before its children so it can appear later in created_at-desc.
  const staffParentIds = new Set<string>(
    allTasks.filter((t) => (t as { assignment_mode?: string }).assignment_mode === 'staff_all').map((t) => t.id)
  )
  const childrenByParent = new Map<string, ChildTask[]>()
  for (const t of allTasks) {
    const pid = (t as { parent_task_id?: string | null }).parent_task_id ?? null
    if (pid && staffParentIds.has(pid)) {
      const child: ChildTask = {
        id:         t.id,
        status:     t.status,
        stores:     (t.stores as unknown as { name: string } | null),
        assignee:   (t.assignee as unknown as { full_name: string } | null),
        deadline:   t.deadline ?? null,
        overdue_at: (t as { overdue_at?: string | null }).overdue_at ?? null,
      }
      const arr = childrenByParent.get(pid) ?? []
      arr.push(child)
      childrenByParent.set(pid, arr)
    }
  }

  // Group tasks: collapse same broadcast_id into one broadcast row, fold staff_all
  // children under their parent, leave everything else as individual rows.
  const grouped: TaskListItem[] = []
  const seenBroadcast = new Map<string, number>()

  for (const task of allTasks) {
    const parentTaskId = (task as { parent_task_id?: string | null }).parent_task_id ?? null

    // staff_all parent → one group row with per-staff children folded in
    if ((task as { assignment_mode?: string }).assignment_mode === 'staff_all') {
      const kids = childrenByParent.get(task.id) ?? []
      const group: StaffGroup = {
        type:       'staff',
        parentId:   task.id,
        title:      task.title,
        category:   task.category ?? null,
        storeName:  (task.stores as unknown as { name: string } | null)?.name ?? null,
        total:      kids.length,
        done:       kids.filter((k) => k.status === 'done').length,
        createdAt:  task.created_at,
        taskIds:    [task.id, ...kids.map((k) => k.id)],
        childTasks: kids,
      }
      grouped.push(group)
      continue
    }
    // staff_all children: if parent is in results, fold into the group above.
    // If parent was filtered out (e.g. status filter), show as standalone task row —
    // never as a broadcast group (children have broadcast_id but are not store-level tasks).
    if (parentTaskId) {
      if (staffParentIds.has(parentTaskId)) continue
      grouped.push({
        type: 'task',
        task: {
          id:                 task.id,
          title:              task.title,
          status:             task.status,
          priority:           task.priority,
          category:           task.category ?? null,
          broadcast_id:       task.broadcast_id ?? null,
          source_schedule_id: (task as { source_schedule_id?: string | null }).source_schedule_id ?? null,
          stores:             (task.stores as unknown as { name: string } | null),
          assignee:           (task.assignee as unknown as { full_name: string } | null),
          deadline:           (task.deadline as string | null) ?? null,
          overdue_at:         (task as { overdue_at?: string | null }).overdue_at ?? null,
          created_at:         task.created_at,
        },
      })
      continue
    }

    if (!task.broadcast_id) {
      const row: TaskRow = {
        type: 'task',
        task: {
          id:                 task.id,
          title:              task.title,
          status:             task.status,
          priority:           task.priority,
          category:           task.category ?? null,
          broadcast_id:       task.broadcast_id ?? null,
          source_schedule_id: (task as { source_schedule_id?: string | null }).source_schedule_id ?? null,
          stores:             (task.stores as unknown as { name: string } | null),
          assignee:           (task.assignee as unknown as { full_name: string } | null),
          deadline:           (task.deadline as string | null) ?? null,
          overdue_at:         (task as { overdue_at?: string | null }).overdue_at ?? null,
          created_at:         task.created_at,
        },
      }
      grouped.push(row)
    } else {
      const child: ChildTask = {
        id:         task.id,
        status:     task.status,
        stores:     (task.stores as unknown as { name: string } | null),
        assignee:   (task.assignee as unknown as { full_name: string } | null),
        deadline:   task.deadline ?? null,
        overdue_at: (task as { overdue_at?: string | null }).overdue_at ?? null,
      }

      if (seenBroadcast.has(task.broadcast_id)) {
        const idx = seenBroadcast.get(task.broadcast_id)!
        const row = grouped[idx] as BroadcastGroup
        row.total++
        if (task.status === 'done') row.done++
        row.taskIds.push(task.id)
        row.childTasks.push(child)
      } else {
        const idx = grouped.length
        seenBroadcast.set(task.broadcast_id, idx)
        const row: BroadcastGroup = {
          type:        'broadcast',
          broadcastId: task.broadcast_id,
          title:       task.title,
          category:    task.category ?? null,
          total:       1,
          done:        task.status === 'done' ? 1 : 0,
          createdAt:   task.created_at,
          taskIds:     [task.id],
          childTasks:  [child],
        }
        grouped.push(row)
      }
    }
  }

  // Build href that preserves all current filters but changes page
  function pageHref(p: number) {
    const q = new URLSearchParams()
    const carry = ['status', 'priority', 'store_id', 'category', 'archived'] as const
    carry.forEach((k) => { if (params[k]) q.set(k, params[k]!) })
    if (p > 1) q.set('page', String(p))
    const qs = q.toString()
    return `/tasks${qs ? `?${qs}` : ''}`
  }

  return (
    <div className="p-4 space-y-4">
      <AutoRefresh intervalMs={45000} />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Danh sách Tasks</h1>
        {canCreate && (
          <Link href="/tasks/new" className={cn(buttonVariants({ size: 'sm' }))}>
            <Plus className="h-4 w-4 mr-1" />
            Tạo Task
          </Link>
        )}
      </div>

      <TaskFilters
        stores={storesForFilter}
        currentParams={params as Record<string, string>}
        showArchived={showArchived}
      />

      {tasksError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium text-destructive">Không thể tải danh sách task</p>
            <p className="text-muted-foreground mt-1">{tasksError.message}</p>
            {tasksError.message.includes('archived_at') && (
              <p className="text-muted-foreground mt-1">
                Vui lòng chạy migration <code className="font-mono text-xs bg-muted px-1 rounded">011_archive_tasks.sql</code> trong Supabase SQL Editor.
              </p>
            )}
          </div>
        </div>
      ) : (
        <>
          <Card>
            <CardContent className="p-0">
              <TaskList items={grouped} canArchive={canArchive} canRestore={canRestore} showArchived={showArchived} />
            </CardContent>
          </Card>

          {/* Pagination — only shown when there are multiple pages */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-xs text-muted-foreground">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, totalRows)} / {totalRows} task
              </span>
              <div className="flex items-center gap-1">
                <Link
                  href={pageHref(page - 1)}
                  aria-disabled={page <= 1}
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'sm' }),
                    'h-7 w-7 p-0',
                    page <= 1 && 'pointer-events-none opacity-40',
                  )}
                  aria-label="Trang trước"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Link>

                {/* Page number buttons — show at most 5 around current page */}
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
                  .reduce<(number | '…')[]>((acc, p, i, arr) => {
                    if (i > 0 && (p as number) - (arr[i - 1] as number) > 1) acc.push('…')
                    acc.push(p)
                    return acc
                  }, [])
                  .map((p, i) =>
                    p === '…' ? (
                      <span key={`gap-${i}`} className="text-xs text-muted-foreground px-1">…</span>
                    ) : (
                      <Link
                        key={p}
                        href={pageHref(p as number)}
                        className={cn(
                          buttonVariants({ variant: p === page ? 'default' : 'outline', size: 'sm' }),
                          'h-7 w-7 p-0 text-xs',
                        )}
                      >
                        {p}
                      </Link>
                    )
                  )}

                <Link
                  href={pageHref(page + 1)}
                  aria-disabled={page >= totalPages}
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'sm' }),
                    'h-7 w-7 p-0',
                    page >= totalPages && 'pointer-events-none opacity-40',
                  )}
                  aria-label="Trang tiếp"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
