import { notFound } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isCmsProgramEnabled } from '@/lib/cms/flags'
import { canManageCms } from '@/lib/cms/access'
import { cmsLoadOsStores } from '@/lib/cms/server/catalog'
import { cmsTodayVn } from '@/lib/cms/programStatus'
import { CmsWizardShell } from '@/components/cms/admin/CmsWizardShell'
import { CmsStepper } from '@/components/cms/admin/CmsStepper'
import { CmsProgramForm } from '@/components/cms/admin/CmsProgramForm'

// CMS P1-c · A2 bước 1 "Thông tin" — chỉ super admin + cờ CMS_PROGRAM_ENABLED (khác ⇒ 404). Lưu ⇒ nháp (server action
// createCmsProgram) rồi sang /[id]/import?from=new cho bước Upload → Chạy xử lý → Kết quả.
export default async function CmsNewPage() {
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(isCmsProgramEnabled() && canManageCms(profile?.role, user.email))) notFound()
  const stores = await cmsLoadOsStores()
  if (!stores.ok) console.error('[cms-new] stores query failed:', stores.error)
  return (
    <CmsWizardShell title="Tạo chương trình CMS" backHref="/targets/campaigns/cms" backLabel="CMS sản phẩm" kind="new">
      <CmsStepper current={0} />
      <CmsProgramForm mode="create" stores={stores.ok ? stores.data : []} storesError={!stores.ok} today={cmsTodayVn(new Date())} />
    </CmsWizardShell>
  )
}
