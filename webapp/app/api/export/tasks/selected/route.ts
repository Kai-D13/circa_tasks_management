import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getSmStoreIds } from '@/lib/authz'
import { xlsxResponse, stampVN } from '@/lib/export/xlsx'
import { TASK_EXPORT_SELECT, shapeTaskRows } from '@/lib/export/taskRows'

const MAX_IDS = 1000

// POST /api/export/tasks/selected  { ids: string[] }
// Export ONLY the checkbox-selected tasks (TaskList bulk toolbar). POST (not GET)
// because a selection of many ids would blow the URL length. Same row shape as
// the filter export; RLS scopes rows (SM further limited to assigned stores).
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const role = profile?.role
  if (role !== 'admin' && role !== 'sm')
    return NextResponse.json({ error: 'Không có quyền xuất dữ liệu' }, { status: 403 })

  const isSm = role === 'sm'
  const smStoreIds = isSm ? await getSmStoreIds(supabase, user.id) : []
  if (isSm && smStoreIds.length === 0)
    return NextResponse.json({ error: 'Chưa được phân công cửa hàng nào' }, { status: 403 })

  let body: { ids?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Body không hợp lệ' }, { status: 400 }) }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : []
  if (ids.length === 0) return NextResponse.json({ error: 'Chưa chọn task nào' }, { status: 400 })
  if (ids.length > MAX_IDS) return NextResponse.json({ error: `Chọn tối đa ${MAX_IDS} task mỗi lần xuất` }, { status: 400 })

  let query = supabase
    .from('tasks')
    .select(TASK_EXPORT_SELECT)
    .in('id', ids)
    // Same exclusions as the filter export: staff_all overview parents carry no
    // submitter (their children export instead); TRF lives under /inventory.
    .neq('assignment_mode', 'staff_all')
    .neq('source_type', 'inventory_trf')
  if (isSm) query = query.in('store_id', smStoreIds)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = shapeTaskRows((data ?? []) as unknown as Record<string, unknown>[])
  return xlsxResponse(rows, 'Tasks', `tasks_selected_${stampVN()}`)
}
