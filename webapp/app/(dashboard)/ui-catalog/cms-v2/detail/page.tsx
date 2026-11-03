import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsProgramDetailView } from '@/components/cms/admin/CmsProgramDetailView'
import { CmsDetailSkeleton } from '@/components/cms/CmsRouteSkeletons'
import { CMS_FX_TODAY, cmsFxDetail } from '@/lib/cms/fixtures'
import { CMS_FX_STORE_NAMES, CMS_FX_USERS, cmsFxAdminResults, cmsFxParseScenario } from '@/lib/cms/fixturesResults'

// Dev-only fixture A3 — ĐÚNG CmsProgramDetailView của route thật, dữ liệu giả. Kích hoạt / tải file lỗi đi qua
// useFixtureActionBlocked ⇒ 0 request ghi. Cổng: UI_CATALOG=1 + super admin. ?fx=
//   draft (mặc định, có nút Kích hoạt) · draft-empty · retro (nháp ngày bắt đầu đã qua — hộp xác nhận hồi tố) ·
//   upcoming (đã kích hoạt chưa bắt đầu) · running (đã bắt đầu: chỉ Import bổ sung) · sm (chỉ đọc) · runs · loading
// P2-c: &p2=running|top|held|none|error|gone|config (chương trình đang chạy) + &view=products|staff|runs &page= — số liệu giả;
// fx=sm ⇒ phạm vi SM (không nhóm Chưa gán). Không p2 ⇒ P1 nguyên trạng.
export default async function CmsDetailFixture({ searchParams }: { searchParams: Promise<{ fx?: string; p2?: string; view?: string; page?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'draft', p2: p2Raw, view, page } = await searchParams
  const scenario = cmsFxParseScenario(p2Raw)
  const kind = scenario ? 'running' : fx === 'draft-empty' || fx === 'retro' || fx === 'upcoming' || fx === 'running' ? fx : fx === 'sm' ? 'running' : 'draft'
  const v = view === 'staff' ? 'staff' : view === 'runs' || fx === 'runs' ? 'runs' : 'products'
  const eligible = fx === 'sm' ? [CMS_FX_USERS.A, CMS_FX_USERS.B, CMS_FX_USERS.C] : Object.values(CMS_FX_USERS).concat(['00000000-0000-4000-8000-000000007099'])
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-detail" data-fx={fx} data-p2={scenario ?? undefined}>
        {fx === 'loading' ? <CmsDetailSkeleton /> : (
          <CmsProgramDetailView detail={cmsFxDetail(kind)} today={CMS_FX_TODAY} canManage={fx !== 'sm'} view={v}
            results={scenario ? cmsFxAdminResults(scenario, fx === 'sm' ? 'sm' : 'super') : undefined}
            eligibleStaffIds={scenario ? eligible : null} storeNames={CMS_FX_STORE_NAMES} staffPage={Number(page) > 0 ? Number(page) : 1} />
        )}
      </div>
    </KpiFixtureBoundary>
  )
}
