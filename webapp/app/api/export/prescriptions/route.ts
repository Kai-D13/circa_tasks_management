import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { xlsxResponse, stampVN, fmtVN } from '@/lib/export/xlsx'
import { publicStorageUrl } from '@/lib/storage/publicUrl'
import { PRESCRIPTION_BUCKET } from '@/lib/prescriptions/constants'
import { deriveCareState, deriveOrderStatus } from '@/lib/prescriptions/careStatus'
import { searchPrescriptionsPage, parseSearchBy } from '@/lib/prescriptions/search'

const MAX_ROWS = 5000

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
  const qTrim = (p.get('q') ?? '').trim().slice(0, 100)
  const vnTodayISO = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
  const careStateParam = ['due', 'done'].includes(p.get('care_state') ?? '') ? p.get('care_state') : null

  if (qTrim) {
    const searchResult = await searchPrescriptionsPage(supabase, {
      q: qTrim,
      by: parseSearchBy(p.get('search_by')),
      limit: MAX_ROWS + 1,
      offset: 0,
      orderSync: p.get('order_sync'),
      storeId: p.get('store_id'),
      care: p.get('care'),
      careState: careStateParam,
      ownerOnly: false,
      today: vnTodayISO,
      dateFrom: p.get('date_from') ? p.get('date_from') + 'T00:00:00+07:00' : null,
      dateTo: p.get('date_to') ? p.get('date_to') + 'T23:59:59+07:00' : null,
    })
    if (searchResult !== 'fallback') {
      if (searchResult.total > MAX_ROWS)
        return NextResponse.json({ error: `Quá nhiều dòng (>${MAX_ROWS}). Vui lòng lọc theo cửa hàng/trạng thái/từ khóa rồi xuất lại.` }, { status: 400 })

      const rows = searchResult.rows.map((s) => {
        const careState = deriveCareState(s as unknown as Parameters<typeof deriveCareState>[0], vnTodayISO)
        return {
          'Mã đơn':       s.order_code,
          'Cửa hàng':     s.store_name ?? '',
          'Người nộp':    s.submitter_full_name ?? '',
          'Đồng bộ đơn':  deriveOrderStatus(s.order_sync_status).label,
          'Số ảnh':       s.image_paths.length,
          'Ghi chú':      s.notes ?? '',
          'Thời gian nộp': fmtVN(s.submitted_at),
          'Có ngày dùng': s.is_chronic ? 'Có' : '',
          'Khách hàng':   s.customer_name ?? '',
          'SĐT khách':    s.customer_phone ?? '',
          'Ngày bán':     s.order_created_at ?? '',
          'Số ngày dùng': s.days_supply ?? '',
          'Dự kiến hết thuốc': s.expected_refill_date ?? '',
          'Ngày cần nhắc': s.reminder_date ?? '',
          'Trạng thái chăm sóc': careState?.label ?? '',
          'Link ảnh':     s.image_paths.map((i) => i?.startsWith('http') ? i : publicStorageUrl(PRESCRIPTION_BUCKET, i)).join('\n'),
        }
      })

      return xlsxResponse(rows, 'Toa thuốc', `toa-thuoc_${stampVN()}`)
    }
  }
  let query = supabase
    .from('prescription_submissions')
    .select('order_code, submitted_at, notes, is_chronic, days_supply, order_created_at, expected_refill_date, reminder_date, customer_name, customer_phone, order_sync_status, care_status, stores(name), submitter:users!submitted_by(full_name), prescription_images(storage_path)')
    .order('submitted_at', { ascending: false })
    .limit(MAX_ROWS + 1)

  if (p.get('order_sync') && ['pending', 'synced', 'error'].includes(p.get('order_sync') as string))
    query = query.eq('order_sync_status', p.get('order_sync') as string)
  if (p.get('store_id'))  query = query.eq('store_id', p.get('store_id') as string)
  // If mig 087 is missing, degrade search export to DHC-only ilike instead of
  // failing. Normal deployed path returns above through the paged search RPC.
  if (qTrim) query = query.ilike('order_code', `%${qTrim}%`)
  if (p.get('date_from')) query = query.gte('submitted_at', p.get('date_from') + 'T00:00:00+07:00')
  if (p.get('date_to'))   query = query.lte('submitted_at', p.get('date_to') + 'T23:59:59+07:00')

  // Mirror the list's chronic filters (type tab + care dropdown) so an export
  // matches the screen (mig 073; kept in sync with page.tsx).
  if (p.get('care') === 'chronic') query = query.eq('is_chronic', true)
  if (careStateParam === 'due') {
    query = query.eq('is_chronic', true).eq('order_sync_status', 'synced').eq('care_status', 'none').lte('reminder_date', vnTodayISO)
  } else if (careStateParam === 'done') {
    query = query.eq('is_chronic', true).eq('care_status', 'done')
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if ((data?.length ?? 0) > MAX_ROWS)
    return NextResponse.json({ error: `Quá nhiều dòng (>${MAX_ROWS}). Vui lòng lọc theo cửa hàng/trạng thái/từ khóa rồi xuất lại.` }, { status: 400 })

  const rows = (data ?? []).map((s) => {
    const imgs = (s.prescription_images as unknown as { storage_path: string }[] | null) ?? []
    const careState = deriveCareState(s as unknown as Parameters<typeof deriveCareState>[0], vnTodayISO)
    return {
      'Mã đơn':       s.order_code as string,
      'Cửa hàng':     (s.stores as unknown as { name?: string } | null)?.name ?? '',
      'Người nộp':    (s.submitter as unknown as { full_name?: string } | null)?.full_name ?? '',
      'Đồng bộ đơn':  deriveOrderStatus(s.order_sync_status as string).label,
      'Số ảnh':       imgs.length,
      'Ghi chú':      (s.notes as string | null) ?? '',
      'Thời gian nộp': fmtVN(s.submitted_at as string),
      'Có ngày dùng': s.is_chronic ? 'Có' : '',
      'Khách hàng':   (s.customer_name as string | null) ?? '',
      'SĐT khách':    (s.customer_phone as string | null) ?? '',
      'Ngày bán':     (s.order_created_at as string | null) ?? '',
      'Số ngày dùng': (s.days_supply as number | null) ?? '',
      'Dự kiến hết thuốc': (s.expected_refill_date as string | null) ?? '',
      'Ngày cần nhắc': (s.reminder_date as string | null) ?? '',
      'Trạng thái chăm sóc': careState?.label ?? '',
      'Link ảnh':     imgs.map((i) => i.storage_path?.startsWith('http') ? i.storage_path : publicStorageUrl(PRESCRIPTION_BUCKET, i.storage_path)).join('\n'),
    }
  })

  return xlsxResponse(rows, 'Toa thuốc', `toa-thuoc_${stampVN()}`)
}
