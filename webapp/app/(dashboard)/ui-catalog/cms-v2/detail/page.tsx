import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsProgramDetailView } from '@/components/cms/admin/CmsProgramDetailView'
import { CmsDetailSkeleton } from '@/components/cms/CmsRouteSkeletons'
import { CMS_FX_TODAY, cmsFxDetail } from '@/lib/cms/fixtures'

// Dev-only fixture A3 — ĐÚNG CmsProgramDetailView của route thật, dữ liệu giả. Kích hoạt / tải file lỗi đi qua
// useFixtureActionBlocked ⇒ 0 request ghi. Cổng: UI_CATALOG=1 + super admin. ?fx=
//   draft (mặc định, có nút Kích hoạt) · draft-empty · retro (nháp ngày bắt đầu đã qua — hộp xác nhận hồi tố) ·
//   upcoming (đã kích hoạt chưa bắt đầu) · running (đã bắt đầu: chỉ Import bổ sung) · sm (chỉ đọc) · runs · loading
export default async function CmsDetailFixture({ searchParams }: { searchParams: Promise<{ fx?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'draft' } = await searchParams
  const kind = fx === 'draft-empty' || fx === 'retro' || fx === 'upcoming' || fx === 'running' ? fx : fx === 'sm' ? 'running' : 'draft'
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-detail" data-fx={fx}>
        {fx === 'loading' ? <CmsDetailSkeleton /> : (
          <CmsProgramDetailView detail={cmsFxDetail(kind)} today={CMS_FX_TODAY} canManage={fx !== 'sm'} view={fx === 'runs' ? 'runs' : 'products'} />
        )}
      </div>
    </KpiFixtureBoundary>
  )
}
