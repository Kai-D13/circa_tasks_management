import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { isKpiAffiliateEnabled, isKpiCampaignEnabled } from '@/lib/kpi/flags'
import { CampaignWizard } from '@/components/kpi/CampaignWizard'
import { ChevronLeft } from 'lucide-react'

export default async function NewCampaignPage() {
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email) && isKpiCampaignEnabled())) notFound()

  return (
    <div className="p-4 md:p-6 max-w-3xl space-y-4">
      <div>
        <Link href="/targets/campaigns" className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1">
          <ChevronLeft className="h-3.5 w-3.5" /> Chiến dịch KPI
        </Link>
        <h1 className="text-xl font-semibold mt-1">Tạo chiến dịch KPI</h1>
      </div>
      <CampaignWizard affiliateEnabled={isKpiAffiliateEnabled()} />
    </div>
  )
}
