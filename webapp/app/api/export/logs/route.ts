import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getSmStoreIds } from '@/lib/authz'
import { ACTION_LABELS, formatMeta } from '@/lib/logs/constants'
import { xlsxResponse, stampVN, fmtVN } from '@/lib/export/xlsx'

const MAX_ROWS = 5000
const MAX_RANGE_DAYS = 92

// GET /api/export/logs — Excel of the activity log, honoring the page filters.
// Date range REQUIRED (max ~3 months) to avoid dumping the whole table.
// Auth: proxy.ts requires a session cookie; RLS scopes rows per role. Export is
// for management (admin/SM); staff have no export button.
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const isAdmin = profile?.role === 'admin'
  const isSm    = profile?.role === 'sm'
  if (!isAdmin && !isSm) return NextResponse.json({ error: 'Không có quyền xuất dữ liệu' }, { status: 403 })

  const p = request.nextUrl.searchParams
  const dateFrom = p.get('date_from')
  const dateTo   = p.get('date_to')
  if (!dateFrom || !dateTo)
    return NextResponse.json({ error: 'Vui lòng chọn khoảng ngày trước khi xuất' }, { status: 400 })
  const spanDays = (Date.parse(dateTo) - Date.parse(dateFrom)) / 86400_000
  if (Number.isNaN(spanDays) || spanDays < 0)
    return NextResponse.json({ error: 'Khoảng ngày không hợp lệ' }, { status: 400 })
  if (spanDays > MAX_RANGE_DAYS)
    return NextResponse.json({ error: `Khoảng ngày tối đa ${MAX_RANGE_DAYS} ngày` }, { status: 400 })

  const smStoreIds = isSm ? await getSmStoreIds(supabase, user.id) : []
  if (isSm && smStoreIds.length === 0)
    return NextResponse.json({ error: 'Chưa được phân công cửa hàng nào' }, { status: 403 })

  const storeFilter = p.get('store_id') || undefined
  const q = p.get('q')?.trim()
  const taskType = p.get('task_type')
  const needsJoin = !!(storeFilter || taskType || q)
  const taskEmbed = needsJoin
    ? 'tasks!inner(title, source_schedule_id, stores(name))'
    : 'tasks(title, source_schedule_id, stores(name))'

  let query = supabase
    .from('task_logs')
    .select(`id, action, created_at, metadata, ${taskEmbed}, users(full_name)`)
    .order('created_at', { ascending: false })
    .gte('created_at', dateFrom + 'T00:00:00+07:00')
    .lte('created_at', dateTo + 'T23:59:59+07:00')
    .limit(MAX_ROWS)

  if (p.get('action'))  query = query.eq('action', p.get('action') as string)
  if (p.get('user_id')) query = query.eq('user_id', p.get('user_id') as string)
  if (storeFilter)      query = query.eq('tasks.store_id', storeFilter)
  if (q)                query = query.ilike('tasks.title', `%${q}%`)
  if (taskType === 'recurring') query = query.not('tasks.source_schedule_id', 'is', null)
  if (taskType === 'adhoc')     query = query.is('tasks.source_schedule_id', null)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (data ?? []).map((log) => {
    const task = log.tasks as unknown as { title?: string; source_schedule_id?: string | null; stores?: { name?: string } | null } | null
    return {
      'Thời gian':       fmtVN(log.created_at as string),
      'Hành động':       ACTION_LABELS[log.action as string] ?? (log.action as string),
      'Task':            task?.title ?? '',
      'Loại task':       task ? (task.source_schedule_id ? 'Định kỳ' : 'Phát sinh') : '',
      'Cửa hàng':        task?.stores?.name ?? '',
      'Người thực hiện': (log.users as unknown as { full_name?: string } | null)?.full_name ?? '',
      'Chi tiết':        formatMeta(log.action as string, (log.metadata as Record<string, unknown>) ?? null),
    }
  })

  return xlsxResponse(rows, 'Nhật ký', `nhat-ky_${dateFrom}_${dateTo}_${stampVN()}`)
}
