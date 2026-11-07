import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsProgramListView } from '@/components/cms/admin/CmsProgramListView'
import { CmsListSkeleton } from '@/components/cms/CmsRouteSkeletons'
import { cmsBuildListModel, cmsParseListFilter } from '@/lib/cms/programList'
import { CMS_FX_LIST, CMS_FX_TODAY } from '@/lib/cms/fixtures'
import { CMS_FX_PG } from '@/lib/cms/fixtureScenario'
import { cmsFxAdminResults, cmsFxParseScenario } from '@/lib/cms/fixturesResults'
import { cmsA1LoadOrder, cmsA1Results, type CmsResultsLoad } from '@/lib/cms/resultUi'
import { cmsDisplayStatus } from '@/lib/cms/programStatus'
import { cmsFixtureNav } from '@/lib/cms/fixtureNav'

// Dev-only fixture A1 cho /targets/campaigns/cms — render ĐÚNG CmsProgramListView + model lib/cms/programList của route
// thật với dữ liệu giả (không truy vấn). Cổng như /ui-catalog: UI_CATALOG=1 (prod 404) + super admin. ?fx=
//   super (mặc định) · sm (chỉ đọc: không Nháp / Tạo / Import; cũng nhận &as=sm) · empty · filter-empty (&status=) · error · loading
// P2-c: &p2=running|top|held|none|error|gone|config — cột / ô kết quả. CMS-UI-1: MỌI chương trình đọc kết quả engine của CHÍNH nó
// (kịch bản lib/cms/fixtureScenario); kịch bản p2 áp cho chương trình chính (PG1), chương trình khác dùng số đã công bố của nó.
// Đã chốt (PG5 / PG9) có ô "Đã chốt" (không vào tổng). Tải theo cùng thứ tự / trần như route (cmsA1LoadOrder, 30); &max=1…30 để
// xem trần cắt (ô tổng '—' + cảnh báo). Link trong trang giữ trong catalog (nav fixture), không đi route thật.
export default async function CmsListFixture({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const sp = await searchParams
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined)
  const fx = one('fx') ?? (one('as') === 'sm' ? 'sm' : 'super')
  const status = one('status')
  const q = one('q') ?? ''
  const scenario = cmsFxParseScenario(one('p2'))
  const max = Math.min(30, Math.max(1, Number(one('max')) || 30))
  const canManage = fx !== 'sm'
  const items = fx === 'empty' ? [] : fx === 'sm' ? CMS_FX_LIST.filter((p) => p.status !== 'draft' && !p.isTest) : CMS_FX_LIST
  const filter = cmsParseListFilter(fx === 'filter-empty' ? (status ?? 'locked') : status, canManage)
  const m = cmsBuildListModel(fx === 'filter-empty' ? items.filter((p) => p.status !== 'locked') : items, { canManage, today: CMS_FX_TODAY, filter, q })
  const targets = items.map((p) => ({ id: p.id, display: cmsDisplayStatus(p, CMS_FX_TODAY), isTest: p.isTest, productCount: p.productCount }))
    .filter((p) => p.display === 'running' || p.display === 'waiting_close' || p.display === 'locked')
  const viewer = canManage ? 'super' : 'sm'
  const p2 = scenario ? cmsA1Results(targets, new Map<string, CmsResultsLoad>(cmsA1LoadOrder(targets, max).map((p) => [p.id,
    cmsFxAdminResults(p.id === CMS_FX_PG.PG1 ? scenario : 'running', viewer, p.id)]))) : null
  const nav = cmsFixtureNav(sp, canManage ? {} : { as: 'sm' })
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
            nav={nav}
          />
        )}
      </div>
    </KpiFixtureBoundary>
  )
}
