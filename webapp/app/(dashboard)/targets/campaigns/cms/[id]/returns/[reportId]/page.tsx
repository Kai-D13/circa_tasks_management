import { notFound } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { canManageCms } from '@/lib/cms/access'
import { cmsLoadProgramDetail } from '@/lib/cms/server/catalog'
import { getCmsCapabilityState } from '@/lib/cms/server/capabilities'
import { cmsLoadCloseReport, cmsReturnsPageEnabled } from '@/lib/cms/server/returnsLoad'
import { ErrorState } from '@/components/ds/ErrorState'
import { CmsCloseReportView } from '@/components/cms/admin/CmsCloseReportView'

// CMS-CALC-RET-2 P5.5 — chi tiết một báo cáo trả hàng sau chốt (super). Chỉ trình bày số DB đã tính; đủ dòng (đối chiếu line_count ở loader).
// Không phải lệnh thu / chi; không có thao tác ghi trên trang này. Trình bày: CmsCloseReportView (dùng chung với fixture /ui-catalog).
export default async function CmsCloseReportPage({ params }: { params: Promise<{ id: string; reportId: string }> }) {
  const { id, reportId } = await params
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!cmsReturnsPageEnabled() || !canManageCms(profile?.role, user.email)) notFound()
  const caps = await getCmsCapabilityState()
  if (caps.kind !== 'ok' || !caps.caps.paths.close_report) notFound()
  const [prog, page] = await Promise.all([cmsLoadProgramDetail(id, { manage: true }), cmsLoadCloseReport(reportId)])
  if (prog.ok && !prog.data) notFound()
  if (!page.ok && page.error === 'FORBIDDEN') notFound()
  if (!prog.ok || !page.ok) {
    return (
      <div data-ui-v2="page" data-layout-width="fluid" className="p-4 md:p-6">
        <ErrorState message="Không tải được báo cáo sau chốt" hint="Thử tải lại trang." />
      </div>
    )
  }
  const p = prog.data!.program
  if (page.data.report.programId !== p.id) notFound()
  return (
    <CmsCloseReportView program={{ id: p.id, name: p.name }} products={new Map(prog.data!.products.map((x) => [x.id, x]))} page={page.data} />
  )
}
