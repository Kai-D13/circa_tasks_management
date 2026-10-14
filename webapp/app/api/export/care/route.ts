import { NextRequest, NextResponse } from 'next/server'
import { isCareEnabled } from '@/lib/care/flags'
import { parseCareFilters } from '@/lib/care/browse'
import { carePeriodOf } from '@/lib/care/time'
import { CARE_REPORT_EXPORT_MAX_ROWS, careReportExportRows } from '@/lib/care/reports'
import { getCareViewAccess } from '@/lib/care/server/browse'
import { loadCareReport } from '@/lib/care/server/reports'
import { xlsxResponse, stampVN } from '@/lib/export/xlsx'

// GET /api/export/care?month=YYYY-MM&store=<uuid>&assignee=<uuid> — Excel báo cáo CSKH (SPEC §B5a.2).
// CÙNG filter/scope/mapper với /care/reports: cờ → phiên → quyền xem CRM (QLCH/staff/FS/admin không
// quyền ⇒ 403) → loadCareReport bằng SESSION (care_report DEFINER tự giới hạn scope). Không SĐT/ID
// khách, không số đơn/tiền (Q-91); loại is_test; trần số dòng rõ ràng.
export async function GET(request: NextRequest) {
  if (!isCareEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const v = await getCareViewAccess()
  if (v.kind === 'anonymous') return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (v.kind === 'unavailable') return NextResponse.json({ error: 'CRM chưa sẵn sàng' }, { status: 503 })
  if (!v.perms.canView) return NextResponse.json({ error: 'Không có quyền' }, { status: 403 })

  const f = parseCareFilters(Object.fromEntries(request.nextUrl.searchParams), carePeriodOf(new Date()))
  let d: Awaited<ReturnType<typeof loadCareReport>>
  try {
    d = await loadCareReport(v.perms, f, { withContacted: false })
  } catch {
    return NextResponse.json({ error: 'Không tải được báo cáo' }, { status: 503 })
  }
  // Filter cửa hàng ngoài scope ⇒ lỗi filter, KHÔNG xuất toàn scope (SPEC §B5a r1.1).
  if (d.storeOutOfScope) return NextResponse.json({ error: 'Cửa hàng không thuộc phạm vi của bạn' }, { status: 400 })
  if (d.lines.length > CARE_REPORT_EXPORT_MAX_ROWS) {
    return NextResponse.json({ error: `Quá ${CARE_REPORT_EXPORT_MAX_ROWS} dòng — thu hẹp bộ lọc` }, { status: 413 })
  }
  const monthLabel = `${f.month.slice(5, 7)}/${f.month.slice(0, 4)}`
  return xlsxResponse(careReportExportRows(d.lines, d.totals, d.orderState, monthLabel), 'Báo cáo CSKH', `bao-cao-cskh_${f.month.slice(0, 7)}_${stampVN()}`)
}
