import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsStaffProductView } from '@/components/cms/staff/CmsStaffProductView'
import { CMS_FX_LONG_ADVICE, CMS_FX_STAFF_PROGRAMS, CMS_FX_TODAY, cmsFxStaffProducts } from '@/lib/cms/fixturesStaff'

// Dev-only fixture D2 `/targets/cms/products/[id]` — ĐÚNG CmsStaffProductView của route thật, dữ liệu giả. Cổng: UI_CATALOG=1
// + super admin. ?fx=
//   product (mặc định: target SP, 3 bậc) · catalog (target danh mục, 1 bậc mở) · none (không target, 1 bậc hữu hạn) ·
//   long (tư vấn dài nhiều dòng) · upcoming (chương trình sắp diễn ra)
export default async function CmsProductFixture({ searchParams }: { searchParams: Promise<{ fx?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'product' } = await searchParams
  const program = fx === 'upcoming' ? CMS_FX_STAFF_PROGRAMS[2] : CMS_FX_STAFF_PROGRAMS[0]
  const products = cmsFxStaffProducts(program.id)
  const base = fx === 'catalog' ? products[1] : fx === 'none' ? products[2] : products[0]
  const product = fx === 'long' ? { ...base, adviceText: CMS_FX_LONG_ADVICE } : base
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-product" data-fx={fx}>
        <CmsStaffProductView data={{ program, product }} today={CMS_FX_TODAY} />
      </div>
    </KpiFixtureBoundary>
  )
}
