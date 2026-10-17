import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { CampaignNewFrame, CampaignWizard, CampaignWizardImportStep, CampaignWizardSteps } from '@/components/kpi/CampaignWizard'
import NewCampaignLoading from '@/app/(dashboard)/targets/campaigns/new/loading'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'

// Dev-only fixture K-3 (canvas K4) cho /targets/campaigns/new — render ĐÚNG CampaignNewFrame + CampaignWizard của route
// thật. Bước 1 với tổ hợp cờ (props server như route). Bước 2 dựng bằng chính CampaignWizardSteps +
// CampaignWizardImportStep (id giả). Bọc KpiFixtureBoundary ⇒ "Tiếp →" với form hợp lệ, Xem trước/Xác nhận nạp KHÔNG gọi
// createCampaign / action nạp file (PM 17/10 P1). Cổng như /ui-catalog: UI_CATALOG=1 (prod 404)
// + super admin. ?fx= all (mọi cờ bật) · gmv (chỉ Affiliate) · plain (mọi cờ tắt) · step2 · loading

const FLAGS = {
  all: { affiliateEnabled: true, customerEnabled: true, orderAovEnabled: true },
  gmv: { affiliateEnabled: true, customerEnabled: false, orderAovEnabled: false },
  plain: { affiliateEnabled: false, customerEnabled: false, orderAovEnabled: false },
} as const

export default async function UiCatalogKpiNewPage({ searchParams }: { searchParams: Promise<{ fx?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'all' } = await searchParams

  if (fx === 'loading') return <div data-testid="ui-catalog-kpi-new" data-fx="loading"><NewCampaignLoading /></div>
  return (
    <KpiFixtureBoundary>
    <div data-testid="ui-catalog-kpi-new" data-fx={fx}>
      <CampaignNewFrame>
        {fx === 'step2' ? (
          <div className="space-y-4">
            <CampaignWizardSteps step={2} />
            <CampaignWizardImportStep campaignId="fx-new" metricType="gmv" />
          </div>
        ) : (
          <CampaignWizard {...(FLAGS[fx as keyof typeof FLAGS] ?? FLAGS.all)} />
        )}
      </CampaignNewFrame>
    </div>
    </KpiFixtureBoundary>
  )
}
