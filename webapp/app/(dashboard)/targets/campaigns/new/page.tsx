import { notFound } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { isKpiAffiliateCustomerEnabled, isKpiAffiliateEnabled, isKpiCampaignEnabled, isKpiOrderAovEnabled } from '@/lib/kpi/flags'
import { CampaignNewFrame, CampaignWizard } from '@/components/kpi/CampaignWizard'

export default async function NewCampaignPage() {
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email) && isKpiCampaignEnabled())) notFound()

  // UI v2 Phase 2 · K-3 (canvas K4): khung trang (CampaignNewFrame) dùng chung fixture /ui-catalog/kpi-v2/new.
  // Cổng quyền và cờ không đổi.
  return (
    <CampaignNewFrame>
      <CampaignWizard
        affiliateEnabled={isKpiAffiliateEnabled()}
        customerEnabled={isKpiAffiliateCustomerEnabled()}
        orderAovEnabled={isKpiOrderAovEnabled()}
      />
    </CampaignNewFrame>
  )
}
