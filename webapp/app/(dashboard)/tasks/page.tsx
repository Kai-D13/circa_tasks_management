import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { redirectIfFsStaff } from '@/lib/fs/isolation'
import { getSmStoreIds } from '@/lib/authz'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { TaskFilters } from '@/components/tasks/TaskFilters'
import { TaskList, TaskListItem, BroadcastGroup, StaffGroup, StaffBroadcastGroup, StaffBroadcastStore, TaskRow, ChildTask } from '@/components/tasks/TaskList'
import { AutoRefresh } from '@/components/common/AutoRefresh'
import { ExportButton } from '@/components/common/ExportButton'
import { Plus, AlertCircle, ChevronLeft, ChevronRight, ClipboardList } from 'lucide-react'
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
  searchParams: Promise<{ view?: string; status?: string; priority?: string; store_id?: string; category?: string; department_id?: string; assignee?: string; archived?: string; show_old?: string; page?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()

  const { profile } = await getSessionProfile()
  await redirectIfFsStaff(supabase, profile) // FS staff never see OS surfaces
  const isStaff = profile?.role === 'staff'
  const isSm    = profile?.role === 'sm'

  // SM: load assigned store IDs upfront (single query; used for filtering tasks + stores)
  const smStoreIds = isSm ? await getSmStoreIds(supabase, profile!.id) : []

  // Staff must never see archived tasks and must not have filter params honoured —
  // an old link like /tasks?priority=urgent would silently hide tasks, making users
  // think tasks are missing. Ignore all filter params for staff.
  const showArchived = !isStaff && params.archived === 'true'
  // "Hiện task cũ": opt-in to see tasks older than 14 days in the normal views
  // (they're hidden by default for a clean overview). Non-staff only.
  const showOld = !isStaff && params.show_old === 'true'
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

  // Admin folding views (pending without a status sub-filter, and done) collapse
  // many staff_all store-parents into ONE broadcast row. Paginate by GROUP unit
  // (slice after grouping) instead of a row window, so a broadcast's stores never
  // split across pages. Fetch all top-level parents (bounded) for these views.
  // A "Người thực hiện" (assignee) filter targets ONE person's tasks — a flat
  // list is exactly that. Folding a broadcast is meaningless here (a staff_all
  // parent has assigned_to=null so it can't match), and would hide the matching
  // child under a dropped parent. So when this filter is active, disable ALL
  // folding paths → the main query returns a flat, correctly-paginated list.
  const userFilter = !isStaff && !!params.assignee
  const isAdminRole = profile?.role === 'admin'
  const groupPaginate = isAdminRole && !showArchived && !userFilter
    && ((view === 'pending' && !params.status) || view === 'done')
  const GROUPS_PER_PAGE = 15

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
    ? supabase.from('tasks').select('id, title, status, priority, category, broadcast_id, source_schedule_id, parent_task_id, assignment_mode, assigned_to, completed_by, completed_at, deadline, created_at, overdue_at, store_id, stores(name), assignee:users!assigned_to(full_name), completed_by_user:users!completed_by(full_name), creator:users!created_by(full_name), department:departments(name, color)', countOpt)
    : supabase.from('tasks').select('id, title, status, priority, category, broadcast_id, source_schedule_id, parent_task_id, assignment_mode, assigned_to, deadline, created_at, overdue_at, store_id, stores(name), assignee:users!assigned_to(full_name), creator:users!created_by(full_name), department:departments(name, color)', countOpt)

  // Inventory→TRF tasks are surfaced only under /inventory/trf — never in the
  // normal task list (any role, any view). source_type is NOT NULL DEFAULT 'task'.
  query = query.neq('source_type', 'inventory_trf')

  // Ordering per view:
  //   pending -> deadline asc (overdue/soonest first), then newest created
  //   done    -> most recently completed first
  //   archive -> newest first (the view/status split doesn't apply to archive)
  if (showArchived) {
    query = query.order('created_at', { ascending: false })
  } else if (view === 'done') {
    // Done sorts by created_at desc too — same axis as pending (stakeholder:
    // the two tabs must agree on order), so a task keeps its position when it
    // moves from pending to done.
    query = query.order('created_at', { ascending: false })
  } else {
    // Pending: newest-created first (stakeholder request) — a just-created task
    // shows at the top. (Done/archive keep their own ordering.)
    query = query.order('created_at', { ascending: false })
  }
  // Group-paginated admin views fetch all top-level parents (bounded) and slice
  // by group below; other views use a row window. Staff fetch +1 row to detect a
  // next page without an exact count.
  query = groupPaginate
    ? query.range(0, 999)
    : query.range(offset, isStaff ? offset + pageSize : offset + pageSize - 1)

  // Auto-declutter: hide tasks created more than 14 days ago from the default
  // views (overview focus). They remain reachable on demand via the "Hiện task
  // cũ" toggle (show_old) — NOT mixed into Archive, so Archive stays purely
  // archived tasks and Restore behaves correctly. Staff are EXEMPT (they have no
  // toggle and must act on their open tasks). No data is mutated (view-only).
  const HIDE_AFTER_DAYS = 14
  const ageCutoffIso = new Date(Date.now() - HIDE_AFTER_DAYS * 86400_000).toISOString()
  if (showArchived) {
    query = query.not('archived_at', 'is', null) // truly-archived only
  } else {
    query = query.is('archived_at', null)
    if (!isStaff && !showOld) query = query.gte('created_at', ageCutoffIso)
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
  if (!isStaff && params.department_id) query = query.eq('department_id', params.department_id)
  // "Người thực hiện": pending → who the task is ASSIGNED to; done → who actually
  // SUBMITTED it (completed_by, mig 044). Folding is already disabled above, so a
  // matching broadcast child appears standalone in the flat list.
  if (userFilter) {
    query = view === 'done'
      ? query.eq('completed_by', params.assignee!)
      : query.eq('assigned_to', params.assignee!)
  }
  // SM: scope to assigned stores (RLS SELECT policy is the gate; this is the app-layer filter)
  if (isSm) query = query.in('store_id', smStoreIds)

  // For admin/manager/sm in the pending view with no status sub-filter: exclude
  // staff_all children from the paginated count so the page count isn't inflated by
  // N children per parent. Children are fetched separately and appended. In the done
  // view, parents are never 'done', so done children show standalone — no folding.
  const topLevelOnly = (profile?.role === 'admin' || profile?.role === 'store_manager' || isSm)
    && view === 'pending' && !params.status && !userFilter

  // Admin/PIC with a status sub-filter: ALSO exclude children from pagination.
  // Otherwise a 26-store/106-staff broadcast floods the 30-row page under 'todo'
  // (parents + children all match) — partial trees, broadcast repeating across
  // pages, inflated count. Matching children are re-fetched per page below.
  const adminTreeFilter = isAdminRole && view === 'pending' && !showArchived && !userFilter
    && (params.status === 'todo' || params.status === 'in_progress' || params.status === 'overdue')

  // Admin/PIC done view: staff_all parents never reach status='done' (overview-only,
  // migration 031), so without exclusion the page would be bare pharmacist children —
  // 106 flat rows for one broadcast, with count/pagination driven by children. Page
  // by TOP-LEVEL done tasks instead, and assemble the broadcast trees from a separate
  // children fetch (page 1 only) — exactly the in_progress/overdue tree pattern.
  const adminDoneTree = isAdminRole && view === 'done' && !showArchived && !userFilter
  if (topLevelOnly || adminTreeFilter || adminDoneTree) query = query.is('parent_task_id', null)

  // Staff have no store filter (storesForFilter is [] for them), so skip the query
  // entirely instead of fetching and discarding it. (isStaff computed above.)
  // Users list backs the "Người thực hiện" filter — role='staff' scoped like the
  // stores list (admin: all; SM: assigned stores; store_manager: own store).
  const usersQuery = isStaff
    ? Promise.resolve({ data: [] as { id: string; full_name: string; store_id: string | null }[] })
    : (() => {
        let uq = supabase.from('users').select('id, full_name, store_id').eq('role', 'staff').order('full_name')
        if (isSm) uq = uq.in('store_id', smStoreIds)
        else if (profile?.role === 'store_manager' && profile?.store_id) uq = uq.eq('store_id', profile.store_id)
        return uq
      })()
  const [{ data: tasks, error: tasksError, count }, { data: stores }, { data: departments }, { data: assigneeUsers }] = await Promise.all([
    query,
    isStaff
      ? Promise.resolve({ data: [] as { id: string; name: string }[] })
      : isSm
        ? supabase.from('stores').select('id, name').in('id', smStoreIds).order('name')
        : supabase.from('stores').select('id, name').eq('store_type', 'os').order('name'),
    isStaff
      ? Promise.resolve({ data: [] as { id: string; name: string }[] })
      : supabase.from('departments').select('id, name').order('name'),
    usersQuery,
  ])

  const totalRows  = count ?? 0
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
  // Group pagination fetches top-level parents with a hard cap of 1000 (range 0–999).
  // Beyond that, later broadcasts would silently vanish — log it so the tactical fix
  // is visibly outgrown and we move to an RPC that paginates by broadcast_id.
  if (groupPaginate && totalRows > 1000) {
    console.warn(`[tasks] group pagination hit the 1000-parent fetch cap (${totalRows} top-level parents exist); some groups are not shown. Replace range(0,999) with a broadcast_id-grouped RPC.`)
  }
  // Staff: no exact count — the (pageSize + 1)th row, if present, signals a next page.
  const pageTasks    = isStaff ? (tasks ?? []).slice(0, pageSize) : (tasks ?? [])
  const hasNextStaff = isStaff && (tasks ?? []).length > pageSize

  const storesForFilter = isStaff ? [] : (stores ?? [])
  const canCreate  = profile?.role === 'admin'
  const canArchive = !showArchived && (profile?.role === 'admin' || isSm)
  const canRestore = showArchived  && (profile?.role === 'admin' || isSm)
  // Bulk "yêu cầu làm lại" — admin/SM in the Done view (tasks there have results).
  const canBulkResubmit = !showArchived && view === 'done' && (profile?.role === 'admin' || isSm)

  // Fetch children for staff_all parents on this page (excluded from paginated query).
  let extraChildren: NonNullable<typeof tasks> = []
  let childrenError: { message: string } | null = null
  const CHILD_COLS = 'id, title, status, priority, category, broadcast_id, source_schedule_id, parent_task_id, assignment_mode, assigned_to, deadline, created_at, overdue_at, store_id, stores(name), assignee:users!assigned_to(full_name), department:departments(name, color)'
  if (topLevelOnly) {
    const parentIds = (tasks ?? [])
      .filter(t => (t as { assignment_mode?: string }).assignment_mode === 'staff_all')
      .map(t => t.id)
    if (parentIds.length > 0) {
      // staff_all children only ever appear in the pending view, so the base
      // (no completion columns) select matches; cast unifies it with `tasks`.
      let childQ = supabase
        .from('tasks')
        .select(CHILD_COLS)
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
  } else if (adminTreeFilter) {
    // Status-filtered admin view: fetch the children MATCHING the filter so the
    // broadcast tree shows exactly the pharmacists the filter is about.
    //
    //   todo        → parents match the filter themselves (their status is the
    //                 constant 'todo'), so scope children to the parents on this
    //                 page — trees stay complete and never duplicate across pages.
    //   overdue /   → parents can never match (overdue excludes staff_all parents
    //   in_progress   by design; parents are never 'in_progress'), so pull ALL
    //                 matching children (bounded) and let the orphan grouping
    //                 assemble the per-broadcast trees. Page 1 only — the trees
    //                 ride alongside the top-level pagination, and repeating them
    //                 on every page would be worse than the rare long list.
    let childQ = supabase.from('tasks').select(CHILD_COLS).is('archived_at', null)
    let run = false
    if (params.status === 'todo') {
      const parentIds = (tasks ?? [])
        .filter(t => (t as { assignment_mode?: string }).assignment_mode === 'staff_all')
        .map(t => t.id)
      if (parentIds.length > 0) {
        childQ = childQ
          .in('parent_task_id', parentIds)
          .eq('status', 'todo')
          .or(`deadline.is.null,deadline.gte.${nowIso}`)
          .order('created_at', { ascending: true })
        run = true
      }
    } else if (page === 1) {
      childQ = childQ.not('parent_task_id', 'is', null)
      childQ = params.status === 'overdue'
        ? childQ.or(`status.eq.overdue,and(deadline.lt.${nowIso},status.neq.done)`)
        : childQ.eq('status', 'in_progress').or(`deadline.is.null,deadline.gte.${nowIso}`)
      childQ = childQ.order('created_at', { ascending: true }).limit(300)
      run = true
    }
    if (run) {
      if (params.priority) childQ = childQ.eq('priority', params.priority)
      if (params.store_id) childQ = childQ.eq('store_id', params.store_id)
      if (params.category) childQ = childQ.eq('category', params.category)
      if (params.department_id) childQ = childQ.eq('department_id', params.department_id)
      if (!showOld) childQ = childQ.gte('created_at', ageCutoffIso)
      const { data: childData, error: childErr } = await childQ
      if (childErr) childrenError = childErr
      extraChildren = (childData ?? []) as unknown as NonNullable<typeof tasks>
    }
  }

  // Done view (admin/PIC): children are excluded from pagination above; on page 1
  // fetch ALL done children (bounded 500, most recently submitted first) and let the
  // orphan grouping assemble the Task → Store → Dược sĩ trees. A lightweight stats
  // query then provides the TRUE per-broadcast totals so the badge reads "61/106 đã
  // nộp" even when some stores have zero submissions (those stores simply have no
  // tree row — there is nothing to list for them). Page 1 only — same accepted
  // trade-off as the in_progress/overdue trees.
  //
  // ACCEPTED BOUNDS (revisit with an RPC that paginates by group unit when the
  // history grows): trees render on page 1 only, from the 500 most recently
  // submitted children — at the current scale (1-2 broadcasts/day × ~106 staff)
  // that covers the several most recent broadcasts, which is what admins review.
  // Older broadcasts are reachable via their store rows / the task detail pages.
  const doneStatsByParent    = new Map<string, { total: number; done: number }>()
  const doneStatsByBroadcast = new Map<string, { total: number; done: number; parents: Set<string> }>()
  // Group-paginated: fetch the done children once (we slice groups, not rows), so
  // no per-page gate. (adminDoneTree ⊂ groupPaginate.)
  if (adminDoneTree) {
    let doneChildQ = supabase
      .from('tasks')
      .select(`${CHILD_COLS}, completed_at`)
      .not('parent_task_id', 'is', null)
      .eq('status', 'done')
      .is('archived_at', null)
      // created_at desc to match the done view's ordering axis (and the top-level
      // done parents fetched above) — the 500-cap then covers the same recent
      // broadcasts the admin is reviewing.
      .order('created_at', { ascending: false })
      .limit(500)
    if (params.priority) doneChildQ = doneChildQ.eq('priority', params.priority)
    if (params.store_id) doneChildQ = doneChildQ.eq('store_id', params.store_id)
    if (params.category) doneChildQ = doneChildQ.eq('category', params.category)
    if (params.department_id) doneChildQ = doneChildQ.eq('department_id', params.department_id)
    if (!showOld) doneChildQ = doneChildQ.gte('created_at', ageCutoffIso)
    const { data: doneKids, error: doneKidsErr } = await doneChildQ
    if (doneKidsErr) childrenError = childrenError ?? doneKidsErr
    extraChildren = (doneKids ?? []) as unknown as NonNullable<typeof tasks>

    const broadcastIds = [...new Set(
      extraChildren.map((t) => t.broadcast_id).filter((b): b is string => !!b)
    )]
    if (broadcastIds.length > 0) {
      // Mirror the children filters so the X/Y badge describes the SAME subset
      // the tree shows (pending view behaves this way too): filtering one store
      // must yield that store's 4/6, not the whole broadcast's 61/106.
      let statQ = supabase
        .from('tasks')
        .select('broadcast_id, parent_task_id, status')
        .in('broadcast_id', broadcastIds)
        .not('parent_task_id', 'is', null)
        .is('archived_at', null)
        .limit(2000)
      if (params.priority) statQ = statQ.eq('priority', params.priority)
      if (params.store_id) statQ = statQ.eq('store_id', params.store_id)
      if (params.category) statQ = statQ.eq('category', params.category)
      if (params.department_id) statQ = statQ.eq('department_id', params.department_id)
      if (!showOld) statQ = statQ.gte('created_at', ageCutoffIso)
      const { data: statRows, error: statErr } = await statQ
      if (statErr) childrenError = childrenError ?? statErr
      for (const r of (statRows ?? []) as { broadcast_id: string; parent_task_id: string; status: string }[]) {
        const p = doneStatsByParent.get(r.parent_task_id) ?? { total: 0, done: 0 }
        p.total++
        if (r.status === 'done') p.done++
        doneStatsByParent.set(r.parent_task_id, p)

        const b = doneStatsByBroadcast.get(r.broadcast_id)
          ?? { total: 0, done: 0, parents: new Set<string>() }
        b.total++
        if (r.status === 'done') b.done++
        b.parents.add(r.parent_task_id)
        doneStatsByBroadcast.set(r.broadcast_id, b)
      }
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
  // is one or a few stores, a global rollup adds nothing). (isAdminRole is
  // computed above, before the paginated query.)
  const grouped: TaskListItem[] = []
  const seenBroadcast = new Map<string, number>()
  const seenStaffBroadcast = new Map<string, number>()

  // Department tag stamped on the task at insert (migration 050) — embedded as
  // department:departments(name, color) on both selects above.
  const deptOf = (t: unknown) =>
    ((t as { department?: { name: string; color: string | null } | null }).department ?? null)

  // Which children to DISPLAY when a tree is expanded: pending tab shows only
  // not-yet-done pharmacists ("who still needs to do it"), done tab shows the
  // submitted ones. Counts (total/done) are kept from the FULL kids set so the
  // "X/Y đã nộp" badge still reflects overall progress.
  const displayKids = (kids: ChildTask[]) =>
    view === 'done' ? kids.filter((k) => k.status === 'done') : kids.filter((k) => k.status !== 'done')

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
          childTasks: displayKids(kids),
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
            department:  deptOf(task),
            creator:     (task.creator as unknown as { full_name: string } | null) ?? null,
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
        department: deptOf(task),
        creator:    (task.creator as unknown as { full_name: string } | null) ?? null,
        storeName:  (task.stores as unknown as { name: string } | null)?.name ?? null,
        total:      kids.length,
        done:       kids.filter((k) => k.status === 'done').length,
        createdAt:  task.created_at,
        taskIds:    [task.id, ...kids.map((k) => k.id)],
        childTasks: displayKids(kids),
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
      // EXCEPT under the "Người thực hiện" filter: that view is deliberately flat
      // (one person's tasks), so a matching child renders standalone, not folded
      // into a broadcast tree it would otherwise misrepresent as "1/1 store".
      if (!userFilter && isAdminRole && (view === 'pending' || adminDoneTree) && task.broadcast_id) {
        const child: ChildTask = {
          id:           task.id,
          status:       task.status,
          stores:       (task.stores as unknown as { name: string } | null),
          assignee:     (task.assignee as unknown as { full_name: string } | null),
          deadline:     task.deadline ?? null,
          overdue_at:   (task as { overdue_at?: string | null }).overdue_at ?? null,
          completed_at: (task as { completed_at?: string | null }).completed_at ?? null,
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
            department:  deptOf(task),
            creator:     (task.creator as unknown as { full_name: string } | null) ?? null,
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
          department:          deptOf(task),
          stores:              (task.stores as unknown as { name: string } | null),
          assignee:            (task.assignee as unknown as { full_name: string } | null),
          completed_by_user:   normalizeCompletedBy(task),
          creator:             (task.creator as unknown as { full_name: string } | null) ?? null,
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
          department:          deptOf(task),
          stores:              (task.stores as unknown as { name: string } | null),
          assignee:            (task.assignee as unknown as { full_name: string } | null),
          completed_by_user:   normalizeCompletedBy(task),
          creator:             (task.creator as unknown as { full_name: string } | null) ?? null,
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
          department:  deptOf(task),
          creator:     (task.creator as unknown as { full_name: string } | null) ?? null,
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

  // Done view: the trees were built from done children only, so the running
  // counts say "61/61". Overwrite with the real totals from the stats query —
  // per-broadcast for the header badge (counts stores/staff with ZERO
  // submissions too, which have no tree row) and per-parent for each store row.
  if (adminDoneTree && doneStatsByBroadcast.size > 0) {
    for (const item of grouped) {
      if (item.type !== 'staff_broadcast') continue
      for (const store of item.stores) {
        const s = doneStatsByParent.get(store.parentId)
        if (s) { store.total = s.total; store.done = s.done }
      }
      const b = doneStatsByBroadcast.get(item.broadcastId)
      if (b) {
        item.totalStaff  = b.total
        item.doneStaff   = b.done
        item.totalStores = b.parents.size
      }
    }
  }

  // Under a status sub-filter, a staff_all group whose children all missed the
  // filter (e.g. parent is 'todo' but every pharmacist is in_progress/done) has
  // nothing actionable — drop the empty shell instead of rendering "0 dược sĩ".
  const visibleItems = adminTreeFilter
    ? grouped.filter((g) =>
        (g.type !== 'staff_broadcast' || g.totalStaff > 0) && (g.type !== 'staff' || g.total > 0))
    : grouped

  // Restore created_at-desc order at the GROUP level. Grouping builds items in
  // iteration order of [pageTasks, ...extraChildren]; in the done view the
  // broadcast trees come only from extraChildren (staff_all parents are never
  // 'done'), so a fresh broadcast group would otherwise sink below older
  // standalone tasks and slip to page 2. Re-sort by each item's created_at so
  // the group page order matches the query's sort (both views on the same axis).
  const itemCreatedAt = (item: TaskListItem): string =>
    item.type === 'task' ? item.task.created_at : item.createdAt
  const orderedVisibleItems = groupPaginate
    ? [...visibleItems].sort((a, b) => Date.parse(itemCreatedAt(b)) - Date.parse(itemCreatedAt(a)))
    : visibleItems

  // Group-paginated admin views: the query fetched ALL top-level parents, so
  // `orderedVisibleItems` holds every group. Slice by GROUP unit here — a
  // broadcast's stores stay whole on one page (fixes the original row-window
  // straddle bug). Other views keep server-side row pagination (pageItems ===
  // orderedVisibleItems).
  const groupTotalPages = Math.max(1, Math.ceil(orderedVisibleItems.length / GROUPS_PER_PAGE))
  const clampedPage = groupPaginate ? Math.min(page, groupTotalPages) : page
  const pageItems = groupPaginate
    ? orderedVisibleItems.slice((clampedPage - 1) * GROUPS_PER_PAGE, clampedPage * GROUPS_PER_PAGE)
    : orderedVisibleItems
  const effectiveTotalPages = groupPaginate ? groupTotalPages : totalPages

  // Drives the empty-state copy: are filters narrowing the (empty) result?
  const hasActiveFilters = !isStaff && !!(params.status || params.priority || params.store_id || params.category || params.department_id || params.assignee)

  // Build href that preserves filters but changes page.
  // Staff only carry 'view' — never status/priority/store_id/category/archived,
  // since those params are ignored server-side for staff and could confuse state.
  function pageHref(p: number) {
    const q = new URLSearchParams()
    if (isStaff) {
      if (params.view) q.set('view', params.view)
    } else {
      const carry = ['view', 'status', 'priority', 'store_id', 'category', 'department_id', 'assignee', 'archived', 'show_old'] as const
      carry.forEach((k) => { if (params[k]) q.set(k, params[k]!) })
    }
    if (p > 1) q.set('page', String(p))
    const qs = q.toString()
    return `/tasks${qs ? `?${qs}` : ''}`
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-[1400px]">
      {!isStaff && <AutoRefresh intervalMs={45000} />}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Danh sách Tasks</h1>
        <div className="flex items-center gap-2">
          {(canCreate || isSm) && <ExportButton endpoint="/api/export/tasks" />}
          {canCreate && (
            <Link href="/tasks/new" className={cn(buttonVariants({ size: 'sm' }))}>
              <Plus className="h-4 w-4 mr-1" />
              Tạo Task
            </Link>
          )}
        </div>
      </div>

      <TaskFilters
        stores={storesForFilter}
        departments={departments ?? []}
        users={isStaff ? [] : (assigneeUsers ?? [])}
        currentParams={params as Record<string, string>}
        showArchived={showArchived}
        showOld={showOld}
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
          {pageItems.length === 0 ? (
            <Card>
              <CardContent className="py-16 flex flex-col items-center justify-center text-center gap-3">
                <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <ClipboardList className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <p className="font-medium">
                    {showArchived ? 'Chưa có task lưu trữ' : view === 'done' ? 'Chưa có task hoàn thành' : 'Không có task nào'}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {hasActiveFilters
                      ? 'Thử xoá bớt bộ lọc để xem thêm task.'
                      : view === 'done'
                        ? 'Các task hoàn thành sẽ hiện ở đây.'
                        : canCreate
                          ? 'Tạo task đầu tiên để bắt đầu.'
                          : 'Hiện chưa có task nào cần làm.'}
                  </p>
                </div>
                {canCreate && !hasActiveFilters && view !== 'done' && !showArchived && (
                  <Link href="/tasks/new" className={cn(buttonVariants({ size: 'sm' }), 'mt-1')}>
                    <Plus className="h-4 w-4 mr-1" /> Tạo Task
                  </Link>
                )}
              </CardContent>
            </Card>
          ) : (
          <Card>
            <CardContent className="p-0">
              <TaskList items={pageItems} canArchive={canArchive} canRestore={canRestore} canBulkResubmit={canBulkResubmit} showArchived={showArchived} userRole={profile?.role ?? 'staff'} />
            </CardContent>
          </Card>
          )}

          {/* Staff pagination — simple Prev/Next (no exact count, so no page numbers).
              Plain block AFTER the list (no sticky/translucent overlay) with large
              touch targets (h-11 ≈ 44px, Apple/Material guideline) so it never floats
              over a card and is easy to tap on mobile. */}
          {isStaff && (page > 1 || hasNextStaff) && (
            <div className="flex items-center justify-between gap-3 mt-4 mb-5">
              <Link
                href={pageHref(page - 1)}
                aria-disabled={page <= 1}
                className={cn(
                  buttonVariants({ variant: 'outline' }),
                  'h-11 px-5 text-sm',
                  page <= 1 && 'pointer-events-none opacity-40',
                )}
              >
                <ChevronLeft className="h-4 w-4 mr-1" /> Trước
              </Link>
              <span className="text-sm font-medium text-muted-foreground">Trang {page}</span>
              <Link
                href={pageHref(page + 1)}
                aria-disabled={!hasNextStaff}
                className={cn(
                  buttonVariants({ variant: 'outline' }),
                  'h-11 px-5 text-sm',
                  !hasNextStaff && 'pointer-events-none opacity-40',
                )}
              >
                Tiếp <ChevronRight className="h-4 w-4 ml-1" />
              </Link>
            </div>
          )}

          {/* Admin/manager pagination — numbered. Group-paginated views count by
              GROUP (slice above); row-paginated views use the exact row count. */}
          {!isStaff && effectiveTotalPages > 1 && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-xs text-muted-foreground">
                {groupPaginate
                  ? `${(clampedPage - 1) * GROUPS_PER_PAGE + 1}–${Math.min(clampedPage * GROUPS_PER_PAGE, visibleItems.length)} / ${visibleItems.length} nhóm`
                  : `${offset + 1}–${Math.min(offset + pageSize, totalRows)} / ${totalRows} task`}
              </span>
              <div className="flex items-center gap-1">
                <Link
                  href={pageHref(clampedPage - 1)}
                  aria-disabled={clampedPage <= 1}
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'sm' }),
                    'h-7 w-7 p-0',
                    clampedPage <= 1 && 'pointer-events-none opacity-40',
                  )}
                  aria-label="Trang trước"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Link>

                {/* Page number buttons — show at most 5 around current page */}
                {Array.from({ length: effectiveTotalPages }, (_, i) => i + 1)
                  .filter((p) => p === 1 || p === effectiveTotalPages || Math.abs(p - clampedPage) <= 2)
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
                          buttonVariants({ variant: p === clampedPage ? 'default' : 'outline', size: 'sm' }),
                          'h-7 w-7 p-0 text-xs',
                        )}
                      >
                        {p}
                      </Link>
                    )
                  )}

                <Link
                  href={pageHref(clampedPage + 1)}
                  aria-disabled={clampedPage >= effectiveTotalPages}
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'sm' }),
                    'h-7 w-7 p-0',
                    clampedPage >= effectiveTotalPages && 'pointer-events-none opacity-40',
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
