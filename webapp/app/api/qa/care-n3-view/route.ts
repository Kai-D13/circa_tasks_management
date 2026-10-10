import { NextRequest, NextResponse } from 'next/server'
import { careN3QaGate, runCareN3Qa } from '@/lib/care/orders/qaView'
import { careN3ErrorCode } from '@/lib/care/orders/source'
import { careN3Table, runN3Query } from '@/lib/care/server/n3Source'

// GET /api/qa/care-n3-view — QA ĐỌC VIEW N3 thật trên localhost (SPEC §B5b). Chỉ development +
// UI_CATALOG=1 + Bearer CRON_SECRET (ngoài development ⇒ 404 kể cả có secret). Dùng đúng SA app
// (BQ_SERVICE_ACCOUNT_KEY) và CARE_BQ_ORDERS_TABLE. Không đọc/ghi Supabase, không phụ thuộc cờ CARE_* hay
// migration 114. Response/log chỉ số tổng hợp + mã lỗi — không ID khách, DHC, timestamp đơn, lỗi thô.
// proxy.ts bỏ qua đăng nhập cho ĐÚNG pathname này và chỉ khi NODE_ENV=development.

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const gate = careN3QaGate(process.env, request.headers.get('authorization'))
  if (gate.status === 404) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (gate.status === 401) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let table: string
  try {
    table = careN3Table()
  } catch (err) {
    return NextResponse.json({ ok: false, code: careN3ErrorCode(err) }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  }
  const report = await runCareN3Qa(table, runN3Query)
  console.warn(`[qa care-n3-view] ok=${report.ok} code=${report.code ?? '-'} sample=${report.sampleCount} param=${report.paramQuery.ok}/${report.paramQuery.code ?? '-'} future=${report.freshness.futureCount ?? '-'}`)
  return NextResponse.json(report, { status: 200, headers: { 'Cache-Control': 'no-store' } })
}
