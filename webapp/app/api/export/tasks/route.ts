import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getSmStoreIds } from '@/lib/authz'
import { xlsxResponse, stampVN } from '@/lib/export/xlsx'
import { TASK_EXPORT_SELECT, shapeTaskRows } from '@/lib/export/taskRows'

const MAX_ROWS = 5000

// GET /api/export/tasks — Excel of the task list, honoring the page filters.
// Mirrors app/(dashboard)/tasks/page.tsx WHERE logic but FLATTENS: staff_all
// overview parents are excluded (they have no submitter); per-pharmacist child
// rows + store/individual tasks are exported. Non-staff only; RLS scopes rows.
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const role = profile?.role
  // Admin / PIC (role 'admin') + SM only — per stakeholder spec.
  if (role !== 'admin' && role !== 'sm')
    return NextResponse.json({ error: 'Không có quyền xuất dữ liệu' }, { status: 403 })

  const isSm = role === 'sm'
  const smStoreIds = isSm ? await getSmStoreIds(supabase, user.id) : []
  if (isSm && smStoreIds.length === 0)
    return NextResponse.json({ error: 'Chưa được phân công cửa hàng nào' }, { status: 403 })

  const p = request.nextUrl.searchParams
  const view = p.get('view') === 'done' ? 'done' : 'pending'
  const showArchived = p.get('archived') === 'true'
  const showOld = p.get('show_old') === 'true'
  const nowIso = new Date().toISOString()
  // Mirror /tasks: hide tasks created >14 days ago from non-archived exports
  // unless "show_old" is on, so the file matches what's on screen.
  const ageCutoffIso = new Date(Date.now() - 14 * 86400_000).toISOString()

  let query = supabase
    .from('tasks')
    .select(TASK_EXPORT_SELECT)
    // Exclude staff_all OVERVIEW parents — they carry no submitter; the export
    // lists the per-pharmacist child rows instead.
    .neq('assignment_mode', 'staff_all')
    // Inventory→TRF tasks live under /inventory, not the task export.
    .neq('source_type', 'inventory_trf')
    // +1 to detect overflow past the cap (silent truncation would read as a
    // complete export).
    .limit(MAX_ROWS + 1)

  if (showArchived) {
    query = query.not('archived_at', 'is', null).order('created_at', { ascending: false })
  } else {
    query = query.is('archived_at', null)
    if (!showOld) query = query.gte('created_at', ageCutoffIso)
    if (view === 'done') {
      query = query.eq('status', 'done')
        .order('completed_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
    } else {
      const status = p.get('status')
      if (status === 'overdue') {
        query = query.or(`status.eq.overdue,and(deadline.lt.${nowIso},status.neq.done)`)
      } else if (status === 'todo' || status === 'in_progress') {
        query = query.eq('status', status).or(`deadline.is.null,deadline.gte.${nowIso}`)
      } else {
        query = query.neq('status', 'done')
      }
      query = query.order('deadline', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false })
    }
  }

  if (p.get('priority')) query = query.eq('priority', p.get('priority') as string)
  if (p.get('store_id')) query = query.eq('store_id', p.get('store_id') as string)
  if (p.get('category')) query = query.eq('category', p.get('category') as string)
  if (p.get('department_id')) query = query.eq('department_id', p.get('department_id') as string)
  if (isSm) query = query.in('store_id', smStoreIds)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if ((data?.length ?? 0) > MAX_ROWS)
    return NextResponse.json({ error: `Quá nhiều dòng (>${MAX_ROWS}). Vui lòng lọc hẹp hơn (theo cửa hàng / trạng thái) rồi xuất lại.` }, { status: 400 })

  const rows = shapeTaskRows((data ?? []) as unknown as Record<string, unknown>[])
  return xlsxResponse(rows, 'Tasks', `tasks_${view}_${stampVN()}`)
}
