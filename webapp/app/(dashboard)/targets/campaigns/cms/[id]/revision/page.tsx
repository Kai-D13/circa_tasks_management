import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isCmsEarningsEnabled, isCmsImportV2Enabled, isCmsProgramEnabled } from '@/lib/cms/flags'
import { canManageCms } from '@/lib/cms/access'
import { cmsLoadProgramDetail } from '@/lib/cms/server/catalog'
import { cmsLoadResultHeader } from '@/lib/cms/server/results'
import { cmsRevisionEnabled } from '@/lib/cms/server/revisionCaps'
import { cmsBasisEnv, cmsProgramBasisFor } from '@/lib/cms/server/basisEnv'
import { cmsDateRange, cmsDateTime } from '@/lib/cms/display'
import { cmsTodayVn } from '@/lib/cms/programStatus'
import { cmsNoRunText } from '@/lib/cms/resultView'
import { ErrorState } from '@/components/ds/ErrorState'
import { CmsWizardShell } from '@/components/cms/admin/CmsWizardShell'
import { CmsBasisBadges } from '@/components/cms/CmsBasisBadges'
import { CmsRevisionFlow } from '@/components/cms/admin/CmsRevisionFlow'

// F-A (PM spec 17/11 §2) /targets/campaigns/cms/[id]/revision — super sửa danh mục / K / mức CMS của chương trình nháp / đang chạy chưa
// chốt. Cổng: cờ CMS_PROGRAM_ENABLED + CMS_PROGRAM_REVISION_ENABLED + DB 131 (năng lực) + super ⇒ khác 404. Đã chốt ⇒ về A3.
// Trang chỉ hiển thị ngữ cảnh (kỳ, phạm vi, cách tính, version, run đang công bố); kiểm / ghi do route + RPC 131 quyết.
export default async function CmsRevisionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(isCmsProgramEnabled() && canManageCms(profile?.role, user.email))) notFound()
  if (!(await cmsRevisionEnabled())) notFound()
  const res = await cmsLoadProgramDetail(id, { manage: true })
  if (!res.ok) {
    console.error('[cms-revision] query failed:', res.error)
    return <div data-ui-v2="page" data-layout-width="fluid" className="p-4 md:p-6"><ErrorState message="Không tải được chương trình CMS" hint="Thử tải lại trang." /></div>
  }
  if (!res.data) notFound()
  const p = res.data.program
  if (p.status !== 'draft' && p.status !== 'active') redirect(`/targets/campaigns/cms/${p.id}`)
  const basisMap = await cmsProgramBasisFor(await cmsBasisEnv(), [p.id])
  const basis = basisMap === undefined ? undefined : basisMap.get(p.id) ?? null
  const started = p.status === 'active' && p.startDate <= cmsTodayVn(new Date())
  const header = started && isCmsEarningsEnabled() ? await cmsLoadResultHeader(p.id) : null
  const run = header?.ok ? header.data.run : null
  const scopeText = p.scope === 'all' ? `Tất cả nhà thuốc OS (${res.data.storeCount})` : `${res.data.storeCount} nhà thuốc`
  return (
    <CmsWizardShell title="Sửa danh mục / mức CMS" subtitle={p.name} backHref={`/targets/campaigns/cms/${p.id}`} backLabel="Chi tiết chương trình" kind="revision">
      <dl data-cms-revision-context className="grid gap-x-4 gap-y-1.5 rounded-v2-panel border bg-card p-3 text-[13px] sm:grid-cols-[auto_1fr] md:p-4">
        <dt className="text-muted-foreground">Kỳ</dt><dd className="tabular-nums">{cmsDateRange(p.startDate, p.endDate)} (không đổi)</dd>
        <dt className="text-muted-foreground">Phạm vi</dt><dd>{scopeText} (không đổi)</dd>
        {basis !== undefined && <><dt className="text-muted-foreground">Cách tính</dt><dd className="flex flex-wrap items-center gap-1.5"><CmsBasisBadges basis={basis} /> (không đổi)</dd></>}
        <dt className="text-muted-foreground">Cấu hình hiện hành</dt><dd className="tabular-nums">v{p.configVersion} · {res.data.products.length} sản phẩm</dd>
        <dt className="text-muted-foreground">Đang công bố</dt>
        {/* r3 (P1-03): run bị che sau sửa (chưa có run mới) ⇒ câu config_reset hiện có, không gọi bản cũ là "đang công bố". */}
        <dd className="tabular-nums">{!started ? 'Chưa bắt đầu — chưa có số CMS' : header && !header.ok ? 'Không đọc được trạng thái công bố' : run ? `Lượt cấu hình v${run.configVersion} · mốc ${cmsDateTime(run.publishedAt)}` : header?.ok ? cmsNoRunText(header.data) : 'Chưa có số đang công bố'}</dd>
      </dl>
      <CmsRevisionFlow program={{ id: p.id, name: p.name }} v2={isCmsImportV2Enabled()} publishedAt={run?.publishedAt ?? null} />
    </CmsWizardShell>
  )
}
