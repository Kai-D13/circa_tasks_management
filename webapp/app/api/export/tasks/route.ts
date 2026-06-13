import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getSmStoreIds } from '@/lib/authz'
import { xlsxResponse, stampVN, fmtVN } from '@/lib/export/xlsx'

const MAX_ROWS = 5000

const STATUS_VI: Record<string, string> = {
  todo: 'Chờ thực hiện', in_progress: 'Đang thực hiện', done: 'Hoàn thành', overdue: 'Quá hạn',
}
const PRIORITY_VI: Record<string, string> = { urgent: 'Khẩn cấp', normal: 'Bình thường' }
const CATEGORY_VI: Record<string, string> = {
  training: 'Training', recall: 'Thu hồi / Kiểm kê', display: 'Trưng bày', audit: 'Kiểm tra', other: 'Khác',
}

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
  if (role !== 'admin' && role !== 'sm' && role !== 'store_manager')
    return NextResponse.json({ error: 'Không có quyền xuất dữ liệu' }, { status: 403 })

  const isSm = role === 'sm'
  const smStoreIds = isSm ? await getSmStoreIds(supabase, user.id) : []
  if (isSm && smStoreIds.length === 0)
    return NextResponse.json({ error: 'Chưa được phân công cửa hàng nào' }, { status: 403 })

  const p = request.nextUrl.searchParams
  const view = p.get('view') === 'done' ? 'done' : 'pending'
  const showArchived = p.get('archived') === 'true'
  const nowIso = new Date().toISOString()

  let query = supabase
    .from('tasks')
    .select('title, status, priority, category, source_schedule_id, assignment_mode, deadline, created_at, completed_at, overdue_at, stores(name), department:departments(name), assignee:users!assigned_to(full_name), completed_by_user:users!completed_by(full_name)')
    // Exclude staff_all OVERVIEW parents — they carry no submitter; the export
    // lists the per-pharmacist child rows instead.
    .neq('assignment_mode', 'staff_all')
    .limit(MAX_ROWS)

  if (showArchived) {
    query = query.not('archived_at', 'is', null).order('created_at', { ascending: false })
  } else {
    query = query.is('archived_at', null)
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
  if (isSm) query = query.in('store_id', smStoreIds)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const effStatus = (status: string, deadline: string | null): string =>
    status !== 'done' && deadline && Date.parse(deadline) < Date.now() ? 'overdue' : status

  const rows = (data ?? []).map((t) => {
    const submitter = (t.completed_by_user as unknown as { full_name?: string } | null)?.full_name
    const assignee = (t.assignee as unknown as { full_name?: string } | null)?.full_name
    return {
      'Tiêu đề':         t.title as string,
      'Cửa hàng':        (t.stores as unknown as { name?: string } | null)?.name ?? '',
      'Phòng ban':       (t.department as unknown as { name?: string } | null)?.name ?? '',
      'Loại':            (t.source_schedule_id as string | null) ? 'Định kỳ' : 'Phát sinh',
      'Trạng thái':      STATUS_VI[effStatus(t.status as string, t.deadline as string | null)] ?? (t.status as string),
      'Ưu tiên':         PRIORITY_VI[t.priority as string] ?? (t.priority as string),
      'Danh mục':        CATEGORY_VI[t.category as string] ?? (t.category as string ?? ''),
      'Người thực hiện': submitter ?? assignee ?? '',
      'Deadline':        fmtVN(t.deadline as string | null),
      'Ngày tạo':        fmtVN(t.created_at as string),
      'Ngày hoàn thành': fmtVN(t.completed_at as string | null),
    }
  })

  return xlsxResponse(rows, 'Tasks', `tasks_${view}_${stampVN()}`)
}
