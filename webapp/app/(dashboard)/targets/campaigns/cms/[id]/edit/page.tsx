import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isCmsProgramEnabled } from '@/lib/cms/flags'
import { canManageCms } from '@/lib/cms/access'
import { cmsLoadInvalidStores, cmsLoadOsStores, cmsLoadProgramDetail } from '@/lib/cms/server/catalog'
import { cmsProgramActions, cmsTodayVn } from '@/lib/cms/programStatus'
import { ErrorState } from '@/components/ds/ErrorState'
import { CmsWizardShell } from '@/components/cms/admin/CmsWizardShell'
import { CmsProgramForm } from '@/components/cms/admin/CmsProgramForm'

// CMS P1-c · sửa thông tin /targets/campaigns/cms/[id]/edit (U17; SPEC §4.7): chỉ super admin; chỉ nháp hoặc đã kích hoạt
// CHƯA bắt đầu — khác ⇒ quay về A3 (không có nút sửa ở đó). RPC 121 kiểm lại trạng thái + ngày VN + Q-214.
export default async function CmsEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(isCmsProgramEnabled() && canManageCms(profile?.role, user.email))) notFound()
  const today = cmsTodayVn(new Date())
  const [res, stores] = await Promise.all([cmsLoadProgramDetail(id, { manage: true }), cmsLoadOsStores()])
  if (!res.ok) {
    console.error('[cms-edit] query failed:', res.error)
    return <div data-ui-v2="page" data-layout-width="fluid" className="p-4 md:p-6"><ErrorState message="Không tải được chương trình CMS" hint="Thử tải lại trang." /></div>
  }
  if (!res.data) notFound()
  const p = res.data.program
  if (!cmsProgramActions(p, today, res.data.products.length, true).edit) redirect(`/targets/campaigns/cms/${p.id}`)
  if (!stores.ok) console.error('[cms-edit] stores query failed:', stores.error)
  // Nhà thuốc đã chọn nhưng không còn trong danh sách OS đang hoạt động ⇒ form hiện riêng để admin bỏ chọn (PM P1-c P1).
  const selected = p.scope === 'stores' ? res.data.storeIds : []
  const activeIds = new Set(stores.ok ? stores.data.map((s) => s.id) : selected)
  const invalid = await cmsLoadInvalidStores(selected.filter((x) => !activeIds.has(x)))
  if (!invalid.ok) console.error('[cms-edit] invalid stores query failed:', invalid.error)
  const invalidStores = invalid.ok ? invalid.data : selected.filter((x) => !activeIds.has(x)).map((id) => ({ id, name: null, code: null, reason: 'unknown' as const }))
  return (
    <CmsWizardShell title="Sửa thông tin chương trình" subtitle={p.name} backHref={`/targets/campaigns/cms/${p.id}`} backLabel="Chi tiết chương trình" kind="edit">
      <CmsProgramForm
        mode="edit"
        initial={{ id: p.id, name: p.name, startDate: p.startDate, endDate: p.endDate, scope: p.scope, storeIds: p.scope === 'stores' ? res.data.storeIds : [], active: p.status === 'active' }}
        stores={stores.ok ? stores.data : []}
        storesError={!stores.ok}
        invalidStores={invalidStores}
        today={today}
      />
    </CmsWizardShell>
  )
}
