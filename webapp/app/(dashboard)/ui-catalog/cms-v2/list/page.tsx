import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsProgramListView } from '@/components/cms/admin/CmsProgramListView'
import { CmsListSkeleton } from '@/components/cms/CmsRouteSkeletons'
import { cmsBuildListModel, cmsParseListFilter } from '@/lib/cms/programList'
import { CMS_FX_LIST, CMS_FX_TODAY } from '@/lib/cms/fixtures'

// Dev-only fixture A1 cho /targets/campaigns/cms — render ĐÚNG CmsProgramListView + model lib/cms/programList của route
// thật với dữ liệu giả (không truy vấn). Cổng như /ui-catalog: UI_CATALOG=1 (prod 404) + super admin. ?fx=
//   super (mặc định) · sm (chỉ đọc: không Nháp / Tạo / Import) · empty · filter-empty (&status=) · error · loading
export default async function CmsListFixture({ searchParams }: { searchParams: Promise<{ fx?: string; status?: string; q?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'super', status, q = '' } = await searchParams
  const canManage = fx !== 'sm'
  const items = fx === 'empty' ? [] : fx === 'sm' ? CMS_FX_LIST.filter((p) => p.status === 'active' && !p.isTest) : CMS_FX_LIST
  const filter = cmsParseListFilter(fx === 'filter-empty' ? (status ?? 'locked') : status, canManage)
  const m = cmsBuildListModel(fx === 'filter-empty' ? items.filter((p) => p.status !== 'locked') : items, { canManage, today: CMS_FX_TODAY, filter, q })
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-list" data-fx={fx}>
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
          />
        )}
      </div>
    </KpiFixtureBoundary>
  )
}
