import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsProgramListView } from '@/components/cms/admin/CmsProgramListView'
import { CmsListSkeleton } from '@/components/cms/CmsRouteSkeletons'
import { cmsBuildListModel, cmsParseListFilter } from '@/lib/cms/programList'
import { CMS_FX_LIST, CMS_FX_TODAY } from '@/lib/cms/fixtures'
import { cmsFxAdminResults, cmsFxParseScenario } from '@/lib/cms/fixturesResults'
import { cmsA1Results, type CmsResultsLoad } from '@/lib/cms/resultUi'
import { cmsDisplayStatus } from '@/lib/cms/programStatus'

// Dev-only fixture A1 cho /targets/campaigns/cms — render ĐÚNG CmsProgramListView + model lib/cms/programList của route
// thật với dữ liệu giả (không truy vấn). Cổng như /ui-catalog: UI_CATALOG=1 (prod 404) + super admin. ?fx=
//   super (mặc định) · sm (chỉ đọc: không Nháp / Tạo / Import) · empty · filter-empty (&status=) · error · loading
// P2-c: &p2=running|top|held|none|error|gone|config — cột / ô kết quả (chương trình 1 theo kịch bản; chờ chốt kỳ = chưa có số;
// QA có số nhưng không vào thống kê). Không p2 ⇒ P1 nguyên trạng.
export default async function CmsListFixture({ searchParams }: { searchParams: Promise<{ fx?: string; status?: string; q?: string; p2?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'super', status, q = '', p2: p2Raw } = await searchParams
  const scenario = cmsFxParseScenario(p2Raw)
  const canManage = fx !== 'sm'
  const items = fx === 'empty' ? [] : fx === 'sm' ? CMS_FX_LIST.filter((p) => p.status !== 'draft' && !p.isTest) : CMS_FX_LIST
  const filter = cmsParseListFilter(fx === 'filter-empty' ? (status ?? 'locked') : status, canManage)
  const m = cmsBuildListModel(fx === 'filter-empty' ? items.filter((p) => p.status !== 'locked') : items, { canManage, today: CMS_FX_TODAY, filter, q })
  const targets = items.map((p) => ({ id: p.id, display: cmsDisplayStatus(p, CMS_FX_TODAY), isTest: p.isTest, productCount: p.productCount }))
    .filter((p) => p.display === 'running' || p.display === 'waiting_close')
  const p2 = scenario ? cmsA1Results(targets, new Map<string, CmsResultsLoad>(targets.map((p) => [p.id,
    p.isTest ? cmsFxAdminResults('running', 'sm') : p.display === 'waiting_close' ? cmsFxAdminResults('none') : cmsFxAdminResults(scenario, canManage ? 'super' : 'sm')]))) : null
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-list" data-fx={fx} data-p2={scenario ?? undefined}>
        {fx === 'loading' ? <CmsListSkeleton /> : (
          <CmsProgramListView
            canManage={canManage}
            affiliateEnabled
            today={CMS_FX_TODAY}
            filter={filter}
            q={q}
            counts={m.counts}
            rows={m.rows}
            hasAny={m.hasAny}
            stats={fx === 'error' ? null : m.stats}
            error={fx === 'error' ? 'Kiểm tra migration 120 / 121 đã chạy và thử lại.' : null}
            p2={p2}
          />
        )}
      </div>
    </KpiFixtureBoundary>
  )
}
