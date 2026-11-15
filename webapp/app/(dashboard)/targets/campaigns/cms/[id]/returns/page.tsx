import { notFound } from 'next/navigation'
import { randomUUID } from 'node:crypto'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { canManageCms } from '@/lib/cms/access'
import { cmsCalcFlags, isCmsQaServer } from '@/lib/cms/flags'
import { cmsLoadProgramDetail } from '@/lib/cms/server/catalog'
import { getCmsCapabilityState } from '@/lib/cms/server/capabilities'
import { cmsLoadCloseReports, cmsLoadReturnConflicts, cmsReturnsPageEnabled } from '@/lib/cms/server/returnsLoad'
import { ErrorState } from '@/components/ds/ErrorState'
import { CmsReturnsAdminView } from '@/components/cms/admin/CmsReturnsAdminView'

// CMS-CALC-RET-2 P5.5 — /targets/campaigns/cms/[id]/returns: đối soát nguồn trả + báo cáo sau chốt. CHỈ super (canManageCms) + cờ
// program + earnings + DB có đường returns_ledger (rpc_cms_capabilities); khác ⇒ 404. RPC 130 (session) tự kiểm lại super + chương
// trình đọc được + marker QA. Xác nhận phục hồi cần thêm cờ returns và không phải server QA chỉ đọc.
export default async function CmsProgramReturnsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!cmsReturnsPageEnabled() || !canManageCms(profile?.role, user.email)) notFound()
  const caps = await getCmsCapabilityState()
  if (caps.kind !== 'ok' || !caps.caps.paths.returns_ledger) notFound()
  const res = await cmsLoadProgramDetail(id, { manage: true })
  if (!res.ok) {
    console.error('[cms-returns] query failed:', res.error)
    return (
      <div data-ui-v2="page" data-layout-width="fluid" className="p-4 md:p-6">
        <ErrorState message="Không tải được chương trình CMS" hint="Thử tải lại trang." />
      </div>
    )
  }
  if (!res.data) notFound()
  const prog = res.data.program
  const [conflicts, reports] = await Promise.all([
    cmsLoadReturnConflicts(prog.id),
    prog.status === 'locked' && caps.caps.paths.close_report ? cmsLoadCloseReports(prog.id) : Promise.resolve(null),
  ])
  if (!conflicts.ok && conflicts.error === 'FORBIDDEN') notFound()
  const disabledReason = !cmsCalcFlags().returns ? 'Pipeline trả hàng đang tắt (CMS_RETURNS_ENABLED).' : isCmsQaServer() ? 'Server QA chỉ đọc.' : null
  return (
    <CmsReturnsAdminView
      program={{ id: prog.id, name: prog.name, status: prog.status }}
      conflicts={conflicts.ok ? conflicts : { ok: false }}
      reports={reports === null ? null : reports.ok ? reports : { ok: false }}
      confirm={{ idem: randomUUID(), disabledReason }}
    />
  )
}
