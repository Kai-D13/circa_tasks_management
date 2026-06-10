import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { getSmStoreIds } from '@/lib/authz'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { TaskFilters } from '@/components/tasks/TaskFilters'
import { TaskList, TaskListItem, BroadcastGroup, StaffGroup, StaffBroadcastGroup, StaffBroadcastStore, TaskRow, ChildTask } from '@/components/tasks/TaskList'
import { AutoRefresh } from '@/components/common/AutoRefresh'
import { Plus, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 30

// Supabase types FK relations as arrays; the completed_by embed can arrive as an
// object or a one-element array depending on inference. Normalize to object | null.
function normalizeCompletedBy(task: unknown): { full_name: string } | null {
  const x = (task as { completed_by_user?: unknown }).completed_by_user
  if (Array.isArray(x)) return (x[0] as { full_name: string } | undefined) ?? null
  return (x as { full_name: string } | null) ?? null
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; status?: string; priority?: string; store_id?: string; category?: string; archived?: string; page?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()

  const { profile } = await getSessionProfile()
  const isStaff = profile?.role === 'staff'
  const isSm    = profile?.role === 'sm'

  // SM: load assigned store IDs upfront (single query; used for filtering tasks + stores)
  const smStoreIds = isSm ? await getSmStoreIds(supabase, profile!.id) : []

  // Staff must never see archived tasks and must not have filter params honoured —
  // an old link like /tasks?priority=urgent would silently hide tasks, making users
  // think tasks are missing. Ignore all filter params for staff.
  const showArchived = !isStaff && params.archived === 'true'
  // Primary split: "pending" (anything not done) vs "done". Default is pending for
  // ALL roles — the first thing everyone needs is "what's still open", not history.
  // Archive view ignores the tab (it's a separate axis).
  const view: 'pending' | 'done' = params.view === 'done' ? 'done' : 'pending'

  // Staff hit this list on mobile hot paths: use a smaller page and skip the exact
  // count (which runs a second full aggregate under RLS). Admin/manager keep 30 +
  // exact count for the numbered pager. The done view is lighter (history), so it
  // uses a smaller page for everyone.
  const pageSize = view === 'done' ? 15 : (isStaff ? 12 : PAGE_SIZE)
  const page   = Math.max(1, parseInt(params.page ?? '1', 10) || 1)
  const offset = (page - 1) * pageSize

  const nowIso = new Date().toISOString()

  // Narrow select — excludes description/input_data/required_outputs which grow
  // large when tasks have many attachments. The completion columns + completed_by
  // embed are only meaningful for done tasks, so the pending view omits them to
  // drop one RLS-checked join per row (a real cost on the staff mobile hot path).
  // Each branch passes a string LITERAL so Supabase can parse the columns at the
  // type level (a variable would collapse to a ParserError type).
  const needsCompleted = showArchived || view === 'done'
  const countOpt = isStaff ? undefined : { count: 'exact' as const }
  // SM with no assigned stores: skip query entirely
  if (isSm && smStoreIds.length === 0) {
    return (
      <div className="p-4 space-y-4">
        <h1 className="text-xl font-semibold">Danh sách Tasks</h1>
        <p className="text-sm text-muted-foreground">Chưa được phân công cửa hàng nào. Vui lòng liên hệ Admin.</p>
      </div>
    )
  }
  let query = needsCompleted
    ? supabase.from('tasks').select('id, title, status, priority, category, broadcast_id, source_schedule_id, parent_task_id, assignment_mode, assigned_to, completed_by, completed_at, deadline, created_at, overdue_at, store_id, stores(name), assignee:users!assigned_to(full_name), completed_by_user:users!completed_by(full_name)', countOpt)
    : supabase.from('tasks').select('id, title, status, priority, category, broadcast_id, source_schedule_id, parent_task_id, assignment_mode, assigned_to, deadline, created_at, overdue_at, store_id, stores(name), assignee:users!assigned_to(full_name)', countOpt)

  // Ordering per view:
  //   pending -> deadline asc (overdue/soonest first), then newest created
  //   done    -> most recently completed first
  //   archive -> newest first (the view/status split doesn't apply to archive)
  if (showArchived) {
    query = query.order('created_at', { ascending: false })
  } else if (view === 'done') {
    query = query
      .order('completed_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
  } else {
    query = query
      .order('deadline', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
  }
  // Staff fetch one extra row to detect a next page without an exact count.
  query = query.range(offset, isStaff ? offset + pageSize : offset + pageSize - 1)

  if (showArchived) {
    query = query.not('archived_at', 'is', null)
  } else {
    query = query.is('archived_at', null)
  }

  // View gate — skipped entirely in archive view (archive shows ALL archived tasks,
  // done or not). Done view: status = done (ignores the status sub-filter). Pending
  // view: everything not done, optionally refined by the status sub-filter.
  if (!showArchived) {
    if (view === 'done') {
      query = query.eq('status', 'done')
    } else if (!isStaff && params.status === 'overdue') {
      // staff_all parents are never submittable/overdue; exclude them from overdue filter
      query = query
        .or(`status.eq.overdue,and(deadline.lt.${nowIso},status.neq.done)`)
        .neq('assignment_mode', 'staff_all')
    } else if (!isStaff && (params.status === 'todo' || params.status === 'in_progress')) {
      query = query
        .eq('status', params.status)
        .or(`deadline.is.null,deadline.gte.${nowIso}`)
    } else {
      query = query.neq('status', 'done')
    }
  }
  if (!isStaff && params.priority) query = query.eq('priority', params.priority)
  if (!isStaff && params.store_id) query = query.eq('store_id', params.store_id)
  if (!isStaff && params.category) query = query.eq('category', params.category)
  // SM: scope to assigned stores (RLS SELECT policy is the gate; this is the app-layer filter)
  if (isSm) query = query.in('store_id', smStoreIds)

  // For admin/manager/sm in the pending view with no status sub-filter: exclude
  // staff_all children from the paginated count so the page count isn't inflated by
  // N children per parent. Children are fetched separately and appended. In the done
  // view, parents are never 'done', so done children show standalone — no folding.
  const topLevelOnly = (profile?.role === 'admin' || profile?.role === 'store_manager' || isSm)
    && view === 'pending' && !params.status
  if (topLevelOnly) query = query.is('parent_task_id', null)

  // Staff have no store filter (storesForFilter is [] for them), so skip the query
  // entirely instead of fetching and discarding it. (isStaff computed above.)
  const [{ data: tasks, error: tasksError, count }, { data: stores }] = await Promise.all([
    query,
    isStaff
      ? Promise.resolve({ data: [] as { id: string; name: string }[] })
      : isSm
        ? supabase.from('stores').select('id, name').in('id', smStoreIds).order('name')
        : supabase.from('stores').select('id, name').order('name'),
  ])

  const totalRows  = count ?? 0
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
  // Staff: no exact count — the (pageSize + 1)th row, if present, signals a next page.
  const pageTasks    = isStaff ? (tasks ?? []).slice(0, pageSize) : (tasks ?? [])
  const hasNextStaff = isStaff && (tasks ?? []).length > pageSize

  const storesForFilter = isStaff ? [] : (stores ?? [])
  const canCreate  = profile?.role === 'admin'
  const canArchive = !showArchived && (profile?.role === 'admin' || isSm)
  const canRestore = showArchived  && (profile?.role === 'admin' || isSm)

  // Fetch children for staff_all parents on this page (excluded from paginated query).
  let extraChildren: NonNullable<typeof tasks> = []
  let childrenError: { message: string } | null = null
  if (topLevelOnly) {
    const parentIds = (tasks ?? [])
      .filter(t => (t as { assignment_mode?: string }).assignment_mode === 'staff_all')
      .map(t => t.id)
    if (parentIds.length > 0) {
      // staff_all children only ever appear in the pending view, so the base
      // (no completion columns) select matches; cast unifies it with `tasks`.
      let childQ = supabase
        .from('tasks')
        .select('id, title, status, priority, category, broadcast_id, source_schedule_id, parent_task_id, assignment_mode, assigned_to, deadline, created_at, overdue_at, store_id, stores(name), assignee:users!assigned_to(full_name)')
        .in('parent_task_id', parentIds)
        .order('created_at', { ascending: true })
      if (isSm) childQ = childQ.in('store_id', smStoreIds)
      if (showArchived) childQ = childQ.not('archived_at', 'is', null)
      else              childQ = childQ.is('archived_at', null)
      const { data: childData, error: childErr } = await childQ
      // A failed children fetch must surface as an error, not render every
      // broadcast tree as a misleading "0/0 đã nộp".
      if (childErr) childrenError = childErr
      extraChildren = (childData ?? []) as unknown as NonNullable<typeof tasks>
    }
  }
  const listError = tasksError ?? childrenError

  const allTasks = [...pageTasks, ...extraChildren]

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
  // Admin/PIC additionally collapse all staff_all store-parents of one broadcast
  // into a single "task tổng" tree row (Task → Store → Dược sĩ) — 26 stores must
  // read as ONE task, not 26. Store managers/SM keep per-store rows (their scope
  // is one or a few stores, a global rollup adds nothing).
  const isAdminRole = profile?.role === 'admin'
  const grouped: TaskListItem[] = []
  const seenBroadcast = new Map<string, number>()
  const seenStaffBroadcast = new Map<string, number>()

  for (const task of allTasks) {
    const parentTaskId = (task as { parent_task_id?: string | null }).parent_task_id ?? null

    // staff_all parent → admin: fold into the broadcast tree row; others: one
    // per-store group row with per-staff children folded in
    if ((task as { assignment_mode?: string }).assignment_mode === 'staff_all') {
      const kids = childrenByParent.get(task.id) ?? []

      if (isAdminRole && task.broadcast_id) {
        const storeEntry: StaffBroadcastStore = {
          parentId:   task.id,
          storeName:  (task.stores as unknown as { name: string } | null)?.name ?? null,
          total:      kids.length,
          done:       kids.filter((k) => k.status === 'done').length,
          childTasks: kids,
        }
        const existingIdx = seenStaffBroadcast.get(task.broadcast_id)
        if (existingIdx !== undefined) {
          const row = grouped[existingIdx] as StaffBroadcastGroup
          row.stores.push(storeEntry)
          row.totalStores++
          row.totalStaff += storeEntry.total
          row.doneStaff  += storeEntry.done
          row.taskIds.push(task.id, ...kids.map((k) => k.id))
        } else {
          seenStaffBroadcast.set(task.broadcast_id, grouped.length)
          grouped.push({
            type:        'staff_broadcast',
            broadcastId: task.broadcast_id,
            title:       task.title,
            category:    task.category ?? null,
            createdAt:   task.created_at,
            taskIds:     [task.id, ...kids.map((k) => k.id)],
            stores:      [storeEntry],
            totalStores: 1,
            totalStaff:  storeEntry.total,
            doneStaff:   storeEntry.done,
          })
        }
        continue
      }

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
    if (parentTaskId) {
      if (staffParentIds.has(parentTaskId)) continue

      // Parent absent (e.g. a status filter matched the child but not the parent).
      // Admin/PIC must still see the broadcast tree, never stray pharmacist rows —
      // group the orphan by broadcast_id, keying its store entry by parent id.
      // Counts then reflect only the children matching the current filter.
      if (isAdminRole && view === 'pending' && task.broadcast_id) {
        const child: ChildTask = {
          id:         task.id,
          status:     task.status,
          stores:     (task.stores as unknown as { name: string } | null),
          assignee:   (task.assignee as unknown as { full_name: string } | null),
          deadline:   task.deadline ?? null,
          overdue_at: (task as { overdue_at?: string | null }).overdue_at ?? null,
        }
        const isDone = task.status === 'done'
        const existingIdx = seenStaffBroadcast.get(task.broadcast_id)
        if (existingIdx !== undefined) {
          const row = grouped[existingIdx] as StaffBroadcastGroup
          let store = row.stores.find((s) => s.parentId === parentTaskId)
          if (!store) {
            store = {
              parentId:   parentTaskId,
              storeName:  (task.stores as unknown as { name: string } | null)?.name ?? null,
              total:      0,
              done:       0,
              childTasks: [],
            }
            row.stores.push(store)
            row.totalStores++
          }
          store.childTasks.push(child)
          store.total++
          if (isDone) store.done++
          row.totalStaff++
          if (isDone) row.doneStaff++
          row.taskIds.push(task.id)
        } else {
          seenStaffBroadcast.set(task.broadcast_id, grouped.length)
          grouped.push({
            type:        'staff_broadcast',
            broadcastId: task.broadcast_id,
            title:       task.title,
            category:    task.category ?? null,
            createdAt:   task.created_at,
            taskIds:     [task.id],
            stores:      [{
              parentId:   parentTaskId,
              storeName:  (task.stores as unknown as { name: string } | null)?.name ?? null,
              total:      1,
              done:       isDone ? 1 : 0,
              childTasks: [child],
            }],
            totalStores: 1,
            totalStaff:  1,
            doneStaff:   isDone ? 1 : 0,
          })
        }
        continue
      }

      // Non-admin (or done/archive view): show as standalone task row — never as
      // a store-level broadcast group.
      grouped.push({
        type: 'task',
        task: {
          id:                  task.id,
          title:               task.title,
          status:              task.status,
          priority:            task.priority,
          category:            task.category ?? null,
          broadcast_id:        task.broadcast_id ?? null,
          source_schedule_id:  (task as { source_schedule_id?: string | null }).source_schedule_id ?? null,
          assignment_mode:     (task as { assignment_mode?: string | null }).assignment_mode ?? null,
          assigned_to:         (task as { assigned_to?: string | null }).assigned_to ?? null,
          stores:              (task.stores as unknown as { name: string } | null),
          assignee:            (task.assignee as unknown as { full_name: string } | null),
          completed_by_user:   normalizeCompletedBy(task),
          completed_at:        (task as { completed_at?: string | null }).completed_at ?? null,
          deadline:            (task.deadline as string | null) ?? null,
          overdue_at:          (task as { overdue_at?: string | null }).overdue_at ?? null,
          created_at:          task.created_at,
        },
      })
      continue
    }

    // Staff only ever see their own store's copy of a broadcast task (RLS ensures
    // this). Grouping into a BroadcastGroup would show a meaningless "0/1 cửa hàng"
    // counter on mobile. Render as a plain TaskRow so the card looks identical to
    // every other task — same status badge, deadline, submitter info.
    if (!task.broadcast_id || isStaff) {
      const row: TaskRow = {
        type: 'task',
        task: {
          id:                  task.id,
          title:               task.title,
          status:              task.status,
          priority:            task.priority,
          category:            task.category ?? null,
          broadcast_id:        task.broadcast_id ?? null,
          source_schedule_id:  (task as { source_schedule_id?: string | null }).source_schedule_id ?? null,
          assignment_mode:     (task as { assignment_mode?: string | null }).assignment_mode ?? null,
          assigned_to:         (task as { assigned_to?: string | null }).assigned_to ?? null,
          stores:              (task.stores as unknown as { name: string } | null),
          assignee:            (task.assignee as unknown as { full_name: string } | null),
          completed_by_user:   normalizeCompletedBy(task),
          completed_at:        (task as { completed_at?: string | null }).completed_at ?? null,
          deadline:            (task.deadline as string | null) ?? null,
          overdue_at:          (task as { overdue_at?: string | null }).overdue_at ?? null,
          created_at:          task.created_at,
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

  // Inside each broadcast tree, list stores alphabetically — page order is
  // insertion order from the query, which is meaningless to the admin.
  for (const item of grouped) {
    if (item.type === 'staff_broadcast') {
      item.stores.sort((a, b) => (a.storeName ?? '').localeCompare(b.storeName ?? '', 'vi'))
    }
  }

  // Build href that preserves filters but changes page.
  // Staff only carry 'view' — never status/priority/store_id/category/archived,
  // since those params are ignored server-side for staff and could confuse state.
  function pageHref(p: number) {
    const q = new URLSearchParams()
    if (isStaff) {
      if (params.view) q.set('view', params.view)
    } else {
      const carry = ['view', 'status', 'priority', 'store_id', 'category', 'archived'] as const
      carry.forEach((k) => { if (params[k]) q.set(k, params[k]!) })
    }
    if (p > 1) q.set('page', String(p))
    const qs = q.toString()
    return `/tasks${qs ? `?${qs}` : ''}`
  }

  return (
    <div className="p-4 space-y-4">
      {!isStaff && <AutoRefresh intervalMs={45000} />}
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
        view={view}
        isStaff={isStaff}
      />

      {listError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium text-destructive">Không thể tải danh sách task</p>
            <p className="text-muted-foreground mt-1">{listError.message}</p>
            {listError.message.includes('archived_at') && (
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
              <TaskList items={grouped} canArchive={canArchive} canRestore={canRestore} showArchived={showArchived} userRole={profile?.role ?? 'staff'} />
            </CardContent>
          </Card>

          {/* Staff pagination — simple Prev/Next (no exact count, so no page numbers).
              Sticky above the mobile bottom nav so it's always reachable; static on
              desktop. -mx-4 px-4 makes the sticky bar full-bleed inside the page padding. */}
          {isStaff && (page > 1 || hasNextStaff) && (
            <div className="flex items-center justify-between gap-2 pt-1 sticky bottom-16 z-10 -mx-4 px-4 py-2 bg-muted/20 border-t md:static md:bottom-auto md:mx-0 md:px-0 md:py-0 md:bg-transparent md:border-0">
              <Link
                href={pageHref(page - 1)}
                aria-disabled={page <= 1}
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' }),
                  'h-8',
                  page <= 1 && 'pointer-events-none opacity-40',
                )}
              >
                <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Trước
              </Link>
              <span className="text-xs text-muted-foreground">Trang {page}</span>
              <Link
                href={pageHref(page + 1)}
                aria-disabled={!hasNextStaff}
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' }),
                  'h-8',
                  !hasNextStaff && 'pointer-events-none opacity-40',
                )}
              >
                Tiếp <ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Link>
            </div>
          )}

          {/* Admin/manager pagination — numbered, driven by the exact count */}
          {!isStaff && totalPages > 1 && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-xs text-muted-foreground">
                {offset + 1}–{Math.min(offset + pageSize, totalRows)} / {totalRows} task
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
