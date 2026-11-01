import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isCmsProgramEnabled } from '@/lib/cms/flags'
import { canManageCms } from '@/lib/cms/access'
import { cmsLoadProgramDetail } from '@/lib/cms/server/catalog'
import { cmsProgramActions, cmsTodayVn } from '@/lib/cms/programStatus'
import { ErrorState } from '@/components/ds/ErrorState'
import { CmsWizardShell } from '@/components/cms/admin/CmsWizardShell'
import { CmsImportFlow } from '@/components/cms/admin/CmsImportFlow'

// CMS P1-c · A2 bước 2–4 (`?from=new`) và nạp lại / import bổ sung /targets/campaigns/cms/[id]/import (SPEC §4.6–§4.7):
// nháp / đã kích hoạt chưa bắt đầu ⇒ nạp lại toàn bộ; đã bắt đầu ⇒ chỉ thêm SP mới; đã chốt ⇒ về A3. Chỉ super admin.
// Chế độ hiển thị chỉ để chọn nhãn — Route Handler + RPC 121 tự quyết mode theo trạng thái + ngày VN.
export default async function CmsImportPage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ from?: string }>
}) {
  const [{ id }, { from }] = await Promise.all([params, searchParams])
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(isCmsProgramEnabled() && canManageCms(profile?.role, user.email))) notFound()
  const res = await cmsLoadProgramDetail(id, { manage: true })
  if (!res.ok) {
    console.error('[cms-import] query failed:', res.error)
    return <div data-ui-v2="page" data-layout-width="fluid" className="p-4 md:p-6"><ErrorState message="Không tải được chương trình CMS" hint="Thử tải lại trang." /></div>
  }
  if (!res.data) notFound()
  const p = res.data.program
  const mode = cmsProgramActions(p, cmsTodayVn(new Date()), res.data.products.length, true).importMode
  if (!mode) redirect(`/targets/campaigns/cms/${p.id}`)
  const fromNew = from === 'new' && p.status === 'draft'
  return (
    <CmsWizardShell
      title={fromNew ? 'Tạo chương trình CMS' : mode === 'replace' ? 'Nạp danh mục' : 'Import bổ sung sản phẩm'}
      subtitle={p.name}
      backHref={`/targets/campaigns/cms/${p.id}`}
      backLabel="Chi tiết chương trình"
      kind="import"
    >
      <CmsImportFlow program={{ id: p.id, name: p.name }} mode={mode} fromNew={fromNew} />
    </CmsWizardShell>
  )
}
