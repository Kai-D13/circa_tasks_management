import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { canManageCms } from '@/lib/cms/access'
import { cmsLoadProgramDetail } from '@/lib/cms/server/catalog'
import { getCmsCapabilityState } from '@/lib/cms/server/capabilities'
import { cmsLoadCloseReport, cmsReturnsPageEnabled } from '@/lib/cms/server/returnsLoad'
import { buildCmsCloseReportWorkbook } from '@/lib/cms/exportCloseReport'

// GET /api/export/cms/close-report?program=&report= — XLSX báo cáo trả sau chốt (CMS-CALC-RET-2 P5.5). CHỈ super + cờ program + earnings
// + đường close_report; RPC 130 (session) kiểm lại super + chương trình đọc được. Báo cáo không phải lệnh thu / chi.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const json = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: code, message }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export async function GET(request: Request) {
  const { user, profile } = await getSessionProfile()
  if (!user) return json(401, 'UNAUTHENTICATED', 'Chưa đăng nhập.')
  if (!cmsReturnsPageEnabled() || !canManageCms(profile?.role, user.email)) return json(403, 'FORBIDDEN', 'Không có quyền xuất dữ liệu.')
  const url = new URL(request.url)
  const programId = url.searchParams.get('program') ?? ''
  const reportId = url.searchParams.get('report') ?? ''
  if (!UUID_RE.test(programId) || !UUID_RE.test(reportId)) return json(400, 'BAD_REQUEST', 'Tham số không hợp lệ.')
  const caps = await getCmsCapabilityState()
  if (caps.kind !== 'ok' || !caps.caps.paths.close_report) return json(404, 'NOT_FOUND', 'Không tìm thấy báo cáo.')
  const prog = await cmsLoadProgramDetail(programId, { manage: true })
  if (!prog.ok) return json(500, 'QUERY_FAILED', 'Không tải được chương trình.')
  if (!prog.data) return json(404, 'NOT_FOUND', 'Không tìm thấy chương trình.')
  const page = await cmsLoadCloseReport(reportId)
  if (!page.ok) return page.error === 'FORBIDDEN' ? json(404, 'NOT_FOUND', 'Không tìm thấy báo cáo.') : json(500, 'QUERY_FAILED', 'Không tải được báo cáo.')
  if (page.data.report.programId !== programId) return json(404, 'NOT_FOUND', 'Không tìm thấy báo cáo.')
  const p = prog.data.program
  const built = buildCmsCloseReportWorkbook({
    program: { id: p.id, name: p.name, startDate: p.startDate, endDate: p.endDate }, page: page.data,
    products: prog.data.products.map((x) => ({ id: x.id, nameSnapshot: x.nameSnapshot, unitCms: x.unitCms })), exportedAt: new Date(),
  })
  if (!built.ok) return json(500, built.error, 'Số dòng / tổng không khớp — không xuất file.')
  console.info(`[cms-close-report-export] OK user=${user.id} program=${programId} report=${reportId} lines=${page.data.lines.length}`)
  return new Response(built.bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="cms-bao-cao-sau-chot-${programId.slice(0, 8)}-${reportId.slice(0, 8)}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  })
}
