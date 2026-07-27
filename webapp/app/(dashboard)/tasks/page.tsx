import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { redirectIfFsStaff } from '@/lib/fs/isolation'
import { getSmStoreIds } from '@/lib/authz'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/ds/PageHeader'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { TaskFilters } from '@/components/tasks/TaskFilters'
import { TaskList, TaskListItem, BroadcastGroup, StaffGroup, StaffBroadcastGroup, StaffBroadcastStore, TaskRow, ChildTask } from '@/components/tasks/TaskList'
import { buildImportBatchGroups, groupModeActive, sliceGroupPage, type ImportBatchMember } from '@/lib/tasks/importBatchGroups'
import { effectiveDone, fetchedComplete } from '@/lib/tasks/effectiveGroupStatus'
import { AutoRefresh } from '@/components/common/AutoRefresh'
import { ExportButton } from '@/components/common/ExportButton'
import { Pagination } from '@/components/common/Pagination'
import { Plus, ChevronLeft, ChevronRight, ClipboardList } from 'lucide-react'
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

  // Admin folding views (r1.1: pending — KỂ CẢ status sub-filter — và done)
  // collapse many staff_all store-parents into ONE broadcast row. Paginate by
  // GROUP unit (slice after grouping) instead of a row window, so a broadcast's
  // stores never split across pages. Fetch all top-level parents (bounded).
  // A "Người thực hiện" (assignee) filter targets ONE person's tasks — a flat
  // list is exactly that. Folding a broadcast is meaningless here (a staff_all
  // parent has assigned_to=null so it can't match), and would hide the matching
  // child under a dropped parent. So when this filter is active, disable ALL
  // folding paths → the main query returns a flat, correctly-paginated list.
  const userFilter = !isStaff && !!params.assignee
  const isAdminRole = profile?.role === 'admin'
  // r1 (audit P1#1): group mode admin mở cho CẢ status sub-filter (todo/
  // in_progress/overdue) lẫn pending mặc định + done — trước đây status hẹp
  // rơi về row-pagination nên import batch vẫn 25 dòng ở màn "Chờ thực hiện".
  // Điều kiện = contract groupModeActive (lib/tasks/importBatchGroups, có
  // test): admin + không archive + không assignee filter. Phân trang theo
  // GROUP unit (fetch-all rồi slice) → 1 batch/broadcast không lặp qua trang.
  // Hotfix P1 (27/07): sm + store_manager cũng GOM (group-unit pagination) —
  // điều kiện tiên quyết để phân loại tab theo effective status của group.
  const groupPaginate = groupModeActive({ role: profile?.role, showArchived, userFilter })
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
        <PageHeader title="Danh sách Tasks" icon={ClipboardList} />
        <EmptyState title="Chưa được phân công cửa hàng nào" hint="Vui lòng liên hệ Admin." />
      </div>
    )
  }
  let query = needsCompleted
    ? supabase.from('tasks').select('id, title, status, priority, category, broadcast_id, source_schedule_id, parent_task_id, assignment_mode, assigned_to, import_batch_id, completed_by, completed_at, deadline, created_at, overdue_at, store_id, stores(name), assignee:users!assigned_to(full_name), completed_by_user:users!completed_by(full_name), creator:users!created_by(full_name), department:departments(name, color)', countOpt)
    : supabase.from('tasks').select('id, title, status, priority, category, broadcast_id, source_schedule_id, parent_task_id, assignment_mode, assigned_to, import_batch_id, deadline, created_at, overdue_at, store_id, stores(name), assignee:users!assigned_to(full_name), creator:users!created_by(full_name), department:departments(name, color)', countOpt)

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

  // Admin/PIC with a status sub-filter: ALSO exclude children from the main
  // query — otherwise a 26-store/106-staff broadcast floods the page under
  // 'todo' (parents + children all match). Matching children are fetched ONCE
  // below (r1.1: same dataset for EVERY page — group slicing happens after).
  const adminTreeFilter = isAdminRole && view === 'pending' && !showArchived && !userFilter
    && (params.status === 'todo' || params.status === 'in_progress' || params.status === 'overdue')

  // Done view: staff_all parents never reach status='done' (overview-only,
  // migration 031), so without exclusion the page would be bare pharmacist children —
  // 106 flat rows for one broadcast, with count/pagination driven by children. Page
  // by TOP-LEVEL done tasks instead, and assemble the trees from a separate
  // children fetch (r1.1: fetched ONCE for every page — group slicing needs the
  // same dataset on all pages) — exactly the in_progress/overdue tree pattern.
  // Hotfix P1 (27/07): MỞ RỘNG sm + store_manager — trước đây done view của họ
  // hiển thị children RỜI RẠC (finding #3); giờ dựng lại StaffGroup per-store.
  const doneTree = (isAdminRole || isSm || profile?.role === 'store_manager')
    && view === 'done' && !showArchived && !userFilter
  if (topLevelOnly || adminTreeFilter || doneTree) query = query.is('parent_task_id', null)

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
  // r1 (audit P1#1 27/07): vượt cap → FAIL-VISIBLE (ErrorState qua parentsCapError,
  // gộp vào listError phía dưới) — không render danh sách thiếu group âm thầm.
  // Đường bền vững khi chạm ngưỡng thật: RPC phân trang theo group unit trong DB.
  let parentsCapError: { message: string } | null = null
  if (groupPaginate && totalRows > 1000) {
    console.warn(`[tasks] group pagination hit the 1000-parent fetch cap (${totalRows} top-level parents exist).`)
    parentsCapError = { message: `Quá nhiều task khớp bộ lọc (${totalRows} > 1000) — thu hẹp bộ lọc (cửa hàng/bộ phận/thời gian) rồi thử lại.` }
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
  const CHILD_COLS = 'id, title, status, priority, category, broadcast_id, source_schedule_id, parent_task_id, assignment_mode, assigned_to, import_batch_id, deadline, created_at, overdue_at, store_id, stores(name), assignee:users!assigned_to(full_name), department:departments(name, color)'

  // r1 (audit P1#1): MỌI fetch nuôi phân loại/badge phải ĐẦY ĐỦ — kéo theo
  // chunk 1000 (né PostgREST max-rows) + verify exact count == tổng row nhận
  // (contract fetchedComplete, fail-closed). Thiếu/cắt → childrenError →
  // ErrorState thay cả list — KHÔNG BAO GIỜ phân loại từ subset bị cap âm
  // thầm. (Đường bền vững khi dữ liệu tăng: RPC set-based per-parent — backlog.)
  const FETCH_CHUNK = 1000
  const FETCH_CAP = 10000
  async function fetchAllVerified<T>(
    build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null; count: number | null }>,
  ): Promise<{ rows: T[]; error: { message: string } | null }> {
    const rows: T[] = []
    let expected: number | null = null
    for (let from = 0; from < FETCH_CAP; from += FETCH_CHUNK) {
      const { data, error, count } = await build(from, from + FETCH_CHUNK - 1)
      if (error) return { rows, error }
      if (expected === null) expected = count ?? null
      rows.push(...(data ?? []))
      if (expected !== null && rows.length >= expected) break
      if ((data ?? []).length < FETCH_CHUNK) break
    }
    if (!fetchedComplete(expected, rows.length)) {
      return {
        rows,
        error: { message: `Dữ liệu nhóm chưa tải đủ (${rows.length}/${expected ?? '?'} dòng) — thu hẹp bộ lọc (cửa hàng/bộ phận/thời gian) rồi thử lại. Không phân loại từ dữ liệu thiếu.` },
      }
    }
    return { rows, error: null }
  }

  if (topLevelOnly) {
    const parentIds = (tasks ?? [])
      .filter(t => (t as { assignment_mode?: string }).assignment_mode === 'staff_all')
      .map(t => t.id)
    if (parentIds.length > 0) {
      // staff_all children only ever appear in the pending view, so the base
      // (no completion columns) select matches; cast unifies it with `tasks`.
      const { rows: childRows, error: childErr } = await fetchAllVerified((from, to) => {
        let q = supabase
          .from('tasks')
          .select(CHILD_COLS, { count: 'exact' })
          .in('parent_task_id', parentIds)
          .order('created_at', { ascending: true })
          .range(from, to)
        if (isSm) q = q.in('store_id', smStoreIds)
        if (showArchived) q = q.not('archived_at', 'is', null)
        else              q = q.is('archived_at', null)
        return q
      })
      // A failed/incomplete children fetch must surface as an error, not render
      // every broadcast tree as a misleading "0/0 đã nộp".
      if (childErr) childrenError = childErr
      extraChildren = childRows as unknown as NonNullable<typeof tasks>
    }
  } else if (adminTreeFilter) {
    // Status-filtered admin view: fetch the children MATCHING the filter so the
    // broadcast tree shows exactly the pharmacists the filter is about.
    //
    //   todo        → parents match the filter themselves (their status is the
    //                 constant 'todo'), so scope children to the fetched parents
    //                 (r1.1: fetch-all parents → trees complete on every page).
    //   overdue /   → parents can never match (overdue excludes staff_all parents
    //   in_progress   by design; parents are never 'in_progress'), so pull ALL
    //                 matching children (bounded + exact count) and let the
    //                 orphan grouping assemble the per-broadcast trees.
    //   r1.1 (audit P1#1): fetch ở MỌI page — group slicing cần dataset GIỐNG
    //   NHAU cho mọi request. r1 (audit P1#1 27/07): fetchAllVerified — kéo đủ
    //   theo chunk + verify exact count, bỏ hẳn limit 300 cũ.
    let run = false
    let todoParentIds: string[] = []
    if (params.status === 'todo') {
      todoParentIds = (tasks ?? [])
        .filter(t => (t as { assignment_mode?: string }).assignment_mode === 'staff_all')
        .map(t => t.id)
      run = todoParentIds.length > 0
    } else {
      run = true
    }
    if (run) {
      const { rows: childRows, error: childErr } = await fetchAllVerified((from, to) => {
        let q = supabase.from('tasks').select(CHILD_COLS, { count: 'exact' }).is('archived_at', null).range(from, to)
        if (params.status === 'todo') {
          q = q
            .in('parent_task_id', todoParentIds)
            .eq('status', 'todo')
            .or(`deadline.is.null,deadline.gte.${nowIso}`)
        } else {
          q = q.not('parent_task_id', 'is', null)
          q = params.status === 'overdue'
            ? q.or(`status.eq.overdue,and(deadline.lt.${nowIso},status.neq.done)`)
            : q.eq('status', 'in_progress').or(`deadline.is.null,deadline.gte.${nowIso}`)
        }
        q = q.order('created_at', { ascending: true })
        if (params.priority) q = q.eq('priority', params.priority)
        if (params.store_id) q = q.eq('store_id', params.store_id)
        if (params.category) q = q.eq('category', params.category)
        if (params.department_id) q = q.eq('department_id', params.department_id)
        if (!showOld) q = q.gte('created_at', ageCutoffIso)
        return q
      })
      if (childErr) childrenError = childErr
      extraChildren = childRows as unknown as NonNullable<typeof tasks>
    }
  }

  // Done view: children are excluded from pagination above; fetch ALL done
  // children ONCE (r1.1: no per-page gate, same dataset for every page) and let
  // the orphan grouping assemble the Task → Store → Dược sĩ trees. A stats
  // query then provides the TRUE per-parent totals so the badge reads "61/106
  // đã nộp" even when some stores have zero submissions.
  // r1 (audit P1#1 27/07): BỎ cap 500/2000 — cả hai fetch qua fetchAllVerified
  // (chunk + verify exact count; thiếu → ErrorState, không phân loại giả).
  const doneStatsByParent    = new Map<string, { total: number; done: number }>()
  const doneStatsByBroadcast = new Map<string, { total: number; done: number; parents: Set<string> }>()
  // Group-paginated: fetch the done children once (we slice groups, not rows), so
  // no per-page gate. (doneTree ⊂ groupPaginate.)
  if (doneTree) {
    const { rows: doneKids, error: doneKidsErr } = await fetchAllVerified((from, to) => {
      let q = supabase
        .from('tasks')
        .select(`${CHILD_COLS}, completed_at`, { count: 'exact' })
        .not('parent_task_id', 'is', null)
        .eq('status', 'done')
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .range(from, to)
      // Hotfix P1: mirror scope của query chính cho sm/store_manager (RLS đã
      // chặn tầng DB — đây là app-layer filter đồng bộ, tránh lệch dataset).
      if (isSm) q = q.in('store_id', smStoreIds)
      if (profile?.role === 'store_manager' && profile?.store_id) q = q.eq('store_id', profile.store_id)
      if (params.priority) q = q.eq('priority', params.priority)
      if (params.store_id) q = q.eq('store_id', params.store_id)
      if (params.category) q = q.eq('category', params.category)
      if (params.department_id) q = q.eq('department_id', params.department_id)
      if (!showOld) q = q.gte('created_at', ageCutoffIso)
      return q
    })
    if (doneKidsErr) childrenError = childrenError ?? doneKidsErr
    extraChildren = doneKids as unknown as NonNullable<typeof tasks>

    // Hotfix P1 (27/07): stats key theo PARENT thay vì broadcast — staff_all
    // KHÔNG có broadcast_id (giao 1 store) trước đây không bao giờ có stats →
    // fail-closed kẹt ngoài tab Hoàn thành. Parent-based phủ CẢ hai loại;
    // byBroadcast vẫn build được từ broadcast_id trên row trả về.
    const doneParentIds = [...new Set(
      extraChildren
        .map((t) => (t as { parent_task_id?: string | null }).parent_task_id)
        .filter((p): p is string => !!p)
    )]
    if (doneParentIds.length > 0) {
      // Mirror the children filters so the X/Y badge describes the SAME subset
      // the tree shows (pending view behaves this way too): filtering one store
      // must yield that store's 4/6, not the whole broadcast's 61/106.
      const { rows: statRows, error: statErr } = await fetchAllVerified<{ broadcast_id: string | null; parent_task_id: string; status: string }>((from, to) => {
        let q = supabase
          .from('tasks')
          .select('broadcast_id, parent_task_id, status', { count: 'exact' })
          .in('parent_task_id', doneParentIds)
          .is('archived_at', null)
          .order('parent_task_id')
          .range(from, to)
        // Hotfix P1: mirror scope sm/store_manager (đồng bộ với doneChildQ).
        if (isSm) q = q.in('store_id', smStoreIds)
        if (profile?.role === 'store_manager' && profile?.store_id) q = q.eq('store_id', profile.store_id)
        if (params.priority) q = q.eq('priority', params.priority)
        if (params.store_id) q = q.eq('store_id', params.store_id)
        if (params.category) q = q.eq('category', params.category)
        if (params.department_id) q = q.eq('department_id', params.department_id)
        if (!showOld) q = q.gte('created_at', ageCutoffIso)
        return q
      })
      if (statErr) childrenError = childrenError ?? statErr
      for (const r of statRows) {
        const p = doneStatsByParent.get(r.parent_task_id) ?? { total: 0, done: 0 }
        p.total++
        if (r.status === 'done') p.done++
        doneStatsByParent.set(r.parent_task_id, p)

        if (r.broadcast_id) {
          const b = doneStatsByBroadcast.get(r.broadcast_id)
            ?? { total: 0, done: 0, parents: new Set<string>() }
          b.total++
          if (r.status === 'done') b.done++
          b.parents.add(r.parent_task_id)
          doneStatsByBroadcast.set(r.broadcast_id, b)
        }
      }
    }
  }
  const listError = tasksError ?? childrenError ?? parentsCapError

  const allTasks = [...pageTasks, ...extraChildren]

  // ── Slice A (audit 24/07, r1): task import Excel (import_batch_id set,
  //    broadcast_id NULL — mig 034) gộp MỘT dòng/batch trong admin group views
  //    (groupModeActive: admin + không archive + không assignee — GOM Ở MỌI
  //    status sub-filter; chỉ assignee/archive/non-admin mới flat;
  //    staff/QLCH/SM giữ nguyên vì query của họ vốn scope store).
  //    Badge done/total lấy từ query bổ sung TOÀN batch (mirror các filter
  //    store/category/dept/priority của query chính → không filter = toàn batch,
  //    filter store = subset đúng contract). KHÔNG broadcastId giả, KHÔNG update
  //    task nào. ──
  const importCandidates = groupPaginate
    ? allTasks.filter((t) => {
        const x = t as { import_batch_id?: string | null; parent_task_id?: string | null }
        return !!x.import_batch_id && !t.broadcast_id && !x.parent_task_id
      })
    : []
  let importMembers: ImportBatchMember[] | null = []
  if (importCandidates.length > 0) {
    const batchIds = [...new Set(importCandidates.map((t) => (t as { import_batch_id?: string }).import_batch_id!))]
    let mq = supabase
      .from('tasks')
      .select('import_batch_id, status')
      .in('import_batch_id', batchIds)
      .is('archived_at', null)
    if (params.priority) mq = mq.eq('priority', params.priority)
    if (params.store_id) mq = mq.eq('store_id', params.store_id)
    if (params.category) mq = mq.eq('category', params.category)
    if (params.department_id) mq = mq.eq('department_id', params.department_id)
    const { data: memberRows, error: memberErr } = await mq
    if (memberErr) {
      // r1 (audit P1#2): KHÔNG suy đoán tiến độ — members=null → group hiện
      // "—/—" + "Không tải được tiến độ" (badge sai còn tệ hơn không có badge).
      console.error('[tasks] import-batch members query failed:', memberErr.message)
      importMembers = null
    } else {
      importMembers = (memberRows ?? []) as ImportBatchMember[]
    }
  }
  const importGroups = buildImportBatchGroups(
    importCandidates.map((t) => ({
      id: t.id,
      import_batch_id: (t as { import_batch_id?: string }).import_batch_id!,
      title: t.title,
      category: t.category ?? null,
      status: t.status,
      created_at: t.created_at,
      deadline: (t.deadline as string | null) ?? null,
      overdue_at: (t as { overdue_at?: string | null }).overdue_at ?? null,
      completed_at: (t as { completed_at?: string | null }).completed_at ?? null,
      storeName: (t.stores as unknown as { name: string } | null)?.name ?? null,
      department: ((t as unknown as { department?: { name: string; color: string | null } | null }).department ?? null),
      creator: (t.creator as unknown as { full_name: string } | null) ?? null,
    })),
    importMembers,
  )
  const importGroupedTaskIds = new Set(importCandidates.map((t) => t.id))

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
  // Hotfix P1: done view sm/store_manager — dựng StaffGroup per-parent từ done
  // children (orphan; parent không bao giờ 'done' nên không có trong kết quả).
  const seenStaffParent = new Map<string, number>()

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
    // Slice A: task thuộc import batch đã gộp → đại diện bằng ImportBatchGroup
    // (push sau vòng lặp), không render dòng phẳng.
    if (importGroupedTaskIds.has(task.id)) continue
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
      if (!userFilter && isAdminRole && (view === 'pending' || doneTree) && task.broadcast_id) {
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
            // r1 (audit P1#3): taskIds PHẢI gồm parent — archiveTasks chỉ
            // cascade xuống children khi input chứa parent; thiếu parent →
            // archive group để lại parent 'todo' ma quay về Pending "0/0".
            row.taskIds.push(parentTaskId)
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
            // r1 (audit P1#3): taskIds gồm CẢ parent — archive cascade cần parent
            // trong input (thiếu → chỉ archive children, parent 'todo' thành ma).
            taskIds:     [parentTaskId, task.id],
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

      // Hotfix P1 (27/07, finding #3): done view — dựng lại StaffGroup PER-PARENT
      // từ done children thay vì dòng rời rạc: sm/store_manager (mọi staff_all)
      // + admin với staff_all KHÔNG broadcast (giao 1 store — nhánh broadcast ở
      // trên không bắt). Giữ đúng cấu trúc group của tab Chờ thực hiện. Counts
      // tạm từ done children, OVERWRITE bằng stats authoritative + lọc
      // effective_done phía dưới.
      if (!userFilter && doneTree) {
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
        const existingIdx = seenStaffParent.get(parentTaskId)
        if (existingIdx !== undefined) {
          const row = grouped[existingIdx] as StaffGroup
          row.childTasks.push(child)
          row.total++
          if (isDone) row.done++
          row.taskIds.push(task.id)
        } else {
          seenStaffParent.set(parentTaskId, grouped.length)
          grouped.push({
            type:       'staff',
            parentId:   parentTaskId,
            title:      task.title,
            category:   task.category ?? null,
            department: deptOf(task),
            creator:    (task.creator as unknown as { full_name: string } | null) ?? null,
            storeName:  (task.stores as unknown as { name: string } | null)?.name ?? null,
            total:      1,
            done:       isDone ? 1 : 0,
            createdAt:  task.created_at,
            // r1 (audit P1#3): gồm CẢ parent — archive/restore cascade cần parent
            // trong input; resubmit/export tự lọc parent server-side (preflight
            // loại staff_all parent; export .neq assignment_mode staff_all).
            taskIds:    [parentTaskId, task.id],
            childTasks: [child],
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

  // Slice A: các nhóm import batch vào chung danh sách — re-sort created_at
  // desc phía dưới đặt đúng vị trí; slice theo nhóm giữ 1 batch = 1 đơn vị trang.
  grouped.push(...importGroups)

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
  if (doneTree) {
    for (const item of grouped) {
      if (item.type === 'staff_broadcast') {
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
      // Hotfix P1: StaffGroup (sm/store_manager) — overwrite bằng stats
      // authoritative per-parent (đếm CẢ pharmacist chưa nộp).
      if (item.type === 'staff') {
        const s = doneStatsByParent.get(item.parentId)
        if (s) { item.total = s.total; item.done = s.done }
      }
    }
  }

  // ── Hotfix P1 (stakeholder 27/07): PHÂN LOẠI TAB THEO EFFECTIVE STATUS của
  //    group staff_all — một group xuất hiện ở ĐÚNG MỘT tab; status vật lý của
  //    parent trong DB GIỮ NGUYÊN (contract effectiveDone, fail-closed:
  //    stats thiếu/lỗi → KHÔNG suy luận là hoàn thành).
  //    · Pending (mặc định): group đã done TOÀN BỘ children → thuộc tab Hoàn
  //      thành, loại khỏi đây. Counts pending = full children fetch (childQ
  //      không lọc status); childrenError → listError thay cả list.
  //    · Done: CHỈ giữ group effective_done — loaded = CÓ row stats
  //      authoritative (statQ; thiếu/cap/lỗi → fail-closed không nhận).
  //    Broadcast store-mode + import batch giữ contract riêng (status vật lý
  //    từng task — không đổi trong hotfix này).
  let classified = grouped
  if (view === 'pending' && !params.status && !showArchived && !userFilter) {
    const statsLoaded = childrenError === null
    classified = grouped.filter((g) => {
      if (g.type === 'staff') return !effectiveDone({ loaded: statsLoaded, total: g.total, done: g.done })
      if (g.type === 'staff_broadcast') return !effectiveDone({ loaded: statsLoaded, total: g.totalStaff, done: g.doneStaff })
      return true
    })
  } else if (doneTree) {
    classified = grouped.filter((g) => {
      if (g.type === 'staff') {
        const s = doneStatsByParent.get(g.parentId)
        return effectiveDone({ loaded: !!s, total: s?.total ?? 0, done: s?.done ?? 0 })
      }
      if (g.type === 'staff_broadcast') {
        const b = doneStatsByBroadcast.get(g.broadcastId)
        return effectiveDone({ loaded: !!b, total: b?.total ?? 0, done: b?.done ?? 0 })
      }
      return true
    })
  }

  // Under a status sub-filter, a staff_all group whose children all missed the
  // filter (e.g. parent is 'todo' but every pharmacist is done) has nothing
  // actionable — drop the empty shell instead of rendering "0 dược sĩ".
  // r1 (audit P1#2): áp cho MỌI role folding (trước đây chỉ adminTreeFilter —
  // SM/QLCH mở ?status=todo vẫn thấy group ĐÃ HOÀN THÀNH hiện lại dạng "0/0"
  // trong Chờ thực hiện vì parent vật lý vẫn 'todo'). Group chỉ hiện dưới
  // status=X khi có ≥1 child khớp X → group hoàn tất không quay lại Pending.
  const pendingSubFilter = view === 'pending' && !!params.status && groupPaginate
  const visibleItems = (adminTreeFilter || pendingSubFilter)
    ? classified.filter((g) =>
        (g.type !== 'staff_broadcast' || g.totalStaff > 0) && (g.type !== 'staff' || g.total > 0))
    : classified

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
  // r1.1: slice qua contract sliceGroupPage (có test) — mỗi group đúng 1 lần
  // trên đúng 1 trang, dataset đã gộp toàn bộ trước khi cắt.
  const sliced = sliceGroupPage(orderedVisibleItems, page, GROUPS_PER_PAGE)
  const clampedPage = groupPaginate ? sliced.clampedPage : page
  const pageItems = groupPaginate ? sliced.pageItems : orderedVisibleItems
  const effectiveTotalPages = groupPaginate ? sliced.totalPages : totalPages

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
      <PageHeader
        title="Danh sách Tasks"
        icon={ClipboardList}
        actions={
          <>
            {(canCreate || isSm) && <ExportButton endpoint="/api/export/tasks" className="h-[44px] md:h-8" />}
            {canCreate && (
              <Link href="/tasks/new" className={cn(buttonVariants({ size: 'sm' }), 'h-[44px] md:h-8')}>
                <Plus className="h-4 w-4 mr-1" />
                Tạo Task
              </Link>
            )}
          </>
        }
      />

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
        <ErrorState
          message="Không thể tải danh sách task"
          hint={
            listError.message
            + (listError.message.includes('archived_at')
              ? ' — Vui lòng chạy migration 011_archive_tasks.sql trong Supabase SQL Editor.'
              : '')
          }
        />
      ) : (
        <>
          {pageItems.length === 0 ? (
            <EmptyState
              className="py-16"
              icon={ClipboardList}
              title={showArchived ? 'Chưa có task lưu trữ' : view === 'done' ? 'Chưa có task hoàn thành' : 'Không có task nào'}
              hint={
                hasActiveFilters
                  ? 'Thử xoá bớt bộ lọc để xem thêm task.'
                  : view === 'done'
                    ? 'Các task hoàn thành sẽ hiện ở đây.'
                    : canCreate
                      ? 'Tạo task đầu tiên để bắt đầu.'
                      : 'Hiện chưa có task nào cần làm.'
              }
              action={
                canCreate && !hasActiveFilters && view !== 'done' && !showArchived ? (
                  <Link href="/tasks/new" className={cn(buttonVariants({ size: 'sm' }), 'h-[44px] md:h-8')}>
                    <Plus className="h-4 w-4 mr-1" /> Tạo Task
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <TaskList items={pageItems} canArchive={canArchive} canRestore={canRestore} canBulkResubmit={canBulkResubmit} showArchived={showArchived} userRole={profile?.role ?? 'staff'} />
          )}

          {/* Staff pagination — ds simple mode: Trang N + Trước/Tiếp, [44px]
              PIXEL touch targets (the old h-11 was only 41.25 real px at the
              15px root). Renders nothing when there's no prev AND no next.
              pageHref/hasNextStaff semantics unchanged. */}
          {isStaff && (
            <Pagination mode="simple" page={page} hasNext={hasNextStaff} hrefForPage={pageHref} />
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
