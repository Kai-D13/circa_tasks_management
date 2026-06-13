import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { xlsxResponse, stampVN, fmtVN } from '@/lib/export/xlsx'
import { publicStorageUrl } from '@/lib/storage/publicUrl'
import { PRESCRIPTION_BUCKET } from '@/lib/prescriptions/constants'

const MAX_ROWS = 5000

const STATUS_VI: Record<string, string> = {
  pending_sync: 'Chờ đồng bộ',
  synced:       'Đã đồng bộ',
}

// GET /api/export/prescriptions — Excel of prescription submissions, honoring
// the page filters. Admin only (SM has no access; staff use the mobile list).
// RLS still applies via the session client.
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin')
    return NextResponse.json({ error: 'Không có quyền xuất dữ liệu' }, { status: 403 })

  const p = request.nextUrl.searchParams
  let query = supabase
    .from('prescription_submissions')
    .select('order_code, submitted_at, status, notes, stores(name), submitter:users!submitted_by(full_name), prescription_images(storage_path)')
    .order('submitted_at', { ascending: false })
    .limit(MAX_ROWS + 1)

  if (p.get('status'))    query = query.eq('status', p.get('status') as string)
  if (p.get('store_id'))  query = query.eq('store_id', p.get('store_id') as string)
  if (p.get('q'))         query = query.ilike('order_code', `%${(p.get('q') as string).trim()}%`)
  if (p.get('date_from')) query = query.gte('submitted_at', p.get('date_from') + 'T00:00:00+07:00')
  if (p.get('date_to'))   query = query.lte('submitted_at', p.get('date_to') + 'T23:59:59+07:00')

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if ((data?.length ?? 0) > MAX_ROWS)
    return NextResponse.json({ error: `Quá nhiều dòng (>${MAX_ROWS}). Vui lòng lọc theo khoảng ngày / cửa hàng rồi xuất lại.` }, { status: 400 })

  const rows = (data ?? []).map((s) => {
    const imgs = (s.prescription_images as unknown as { storage_path: string }[] | null) ?? []
    return {
      'Mã đơn':       s.order_code as string,
      'Cửa hàng':     (s.stores as unknown as { name?: string } | null)?.name ?? '',
      'Người nộp':    (s.submitter as unknown as { full_name?: string } | null)?.full_name ?? '',
      'Trạng thái':   STATUS_VI[s.status as string] ?? (s.status as string),
      'Số ảnh':       imgs.length,
      'Ghi chú':      (s.notes as string | null) ?? '',
      'Thời gian nộp': fmtVN(s.submitted_at as string),
      'Link ảnh':     imgs.map((i) => publicStorageUrl(PRESCRIPTION_BUCKET, i.storage_path)).join('\n'),
    }
  })

  return xlsxResponse(rows, 'Toa thuốc', `toa-thuoc_${stampVN()}`)
}
