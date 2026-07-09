import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { POLICY_DEPT_ID, FS_PHOTO_BOXES, FS_ITEM_STATUS } from '@/lib/fs/constants'
import { xlsxResponse, stampVN, fmtVN } from '@/lib/export/xlsx'

// GET /api/export/fs-sessions?session_id=... — Excel of a session's items with
// dimensions, status, and the photo URL per box (super OR Policy-dept admin).
// RLS also scopes reads to the same set.

type Embed = { name?: string | null; code?: string | null }

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { data: profile } = await supabase.from('users').select('role, department_id').eq('id', user.id).single()
  const isSuper = profile?.role === 'admin' && isSuperAdminEmail(user.email)
  const isPolicy = profile?.role === 'admin' && profile?.department_id === POLICY_DEPT_ID
  if (!isSuper && !isPolicy) return NextResponse.json({ error: 'Không có quyền xuất dữ liệu' }, { status: 403 })

  const sessionId = request.nextUrl.searchParams.get('session_id')
  if (!sessionId) return NextResponse.json({ error: 'Thiếu session_id' }, { status: 400 })

  const { data: session, error: sErr } = await supabase
    .from('fs_sessions').select('id, name, store:stores(name, code)').eq('id', sessionId).maybeSingle()
  if (sErr) return NextResponse.json({ error: 'Lỗi tải phiên: ' + sErr.message }, { status: 500 })
  if (!session) return NextResponse.json({ error: 'Không tìm thấy phiên' }, { status: 404 })

  const { data: items, error: iErr } = await supabase
    .from('fs_session_items')
    .select('id, product_id, product_name, status, dim_length_mm, dim_width_mm, dim_height_mm, resubmit_note, approved_at, approved_by')
    .eq('session_id', sessionId).is('removed_at', null).order('created_at', { ascending: true })
  if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 })

  const ids = (items ?? []).map((i) => i.id)
  const { data: photos, error: pErr } = ids.length
    ? await supabase.from('fs_item_photos').select('item_id, box_key, storage_path').in('item_id', ids)
    : { data: [], error: null }
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 })

  const photoUrl = new Map<string, string>()
  for (const p of photos ?? []) photoUrl.set(`${p.item_id}:${p.box_key}`, p.storage_path)

  // Approver names for the "Người duyệt" column.
  const approverIds = [...new Set((items ?? []).map((i) => i.approved_by).filter(Boolean))] as string[]
  const { data: approvers } = approverIds.length
    ? await supabase.from('users').select('id, full_name').in('id', approverIds)
    : { data: [] as { id: string; full_name: string }[] }
  const approverName = new Map((approvers ?? []).map((u) => [u.id, u.full_name]))

  const store = Array.isArray(session.store) ? (session.store[0] as Embed) : (session.store as Embed | null)

  const rows = (items ?? []).map((it, i) => {
    const row: Record<string, unknown> = {
      'STT': i + 1,
      'Cửa hàng': store?.name ?? '',
      'product_id': it.product_id,
      'Tên sản phẩm': it.product_name,
      'Dài (mm)': it.dim_length_mm ?? '',
      'Rộng (mm)': it.dim_width_mm ?? '',
      'Cao (mm)': it.dim_height_mm ?? '',
      'Trạng thái': FS_ITEM_STATUS[it.status]?.label ?? it.status,
    }
    // One column per box; boxes 3 & 4 share a label so prefix with the box number
    // to keep the header keys unique (json_to_sheet uses object keys).
    for (const b of FS_PHOTO_BOXES) row[`Box ${b.key} (${b.label})`] = photoUrl.get(`${it.id}:${b.key}`) ?? ''
    row['Trạng thái duyệt'] = it.approved_at ? 'Đã duyệt' : 'Chưa duyệt'
    row['Người duyệt'] = it.approved_by ? (approverName.get(it.approved_by) ?? '') : ''
    row['Thời gian duyệt'] = it.approved_at ? fmtVN(it.approved_at) : ''
    row['Ghi chú làm lại'] = it.resubmit_note ?? ''
    return row
  })

  const nameSlug = (session.name as string).slice(0, 20)
  return xlsxResponse(rows, 'Sản phẩm FS', `fs_${nameSlug}_${stampVN()}`)
}
