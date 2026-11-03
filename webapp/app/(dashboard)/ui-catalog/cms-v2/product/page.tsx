import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsStaffProductView } from '@/components/cms/staff/CmsStaffProductView'
import { CMS_FX_LONG_ADVICE, CMS_FX_STAFF_ENDED, CMS_FX_STAFF_PROGRAMS, CMS_FX_TODAY, cmsFxStaffProducts } from '@/lib/cms/fixturesStaff'
import { cmsFxLines, cmsFxParseScenario, cmsFxStaffResults, cmsFxStoreResults } from '@/lib/cms/fixturesResults'

// Dev-only fixture D2 `/targets/cms/products/[id]` — ĐÚNG CmsStaffProductView của route thật, dữ liệu giả. Cổng: UI_CATALOG=1
// + super admin. ?fx=
//   product (mặc định: target SP, 3 bậc) · catalog (target danh mục, 1 bậc mở) · none (không target, 1 bậc hữu hạn) ·
//   long (tư vấn dài nhiều dòng) · upcoming (chương trình sắp diễn ra) · gate4 (SP target chưa đạt, đơn vị lẻ 0,5)
// P2-c: &p2=running|top|held|none|error|gone|config (&role=manager ⇒ tổng nhà thuốc) — số liệu giả + 3 ghi nhận gần nhất.
// P3a r2: fx=ended (Chờ chốt kỳ) · fx=locked (Đã chốt — không "Nếu bán thêm", nhãn đã chốt).
export default async function CmsProductFixture({ searchParams }: { searchParams: Promise<{ fx?: string; p2?: string; role?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'product', p2: p2Raw, role } = await searchParams
  const scenario = cmsFxParseScenario(p2Raw)
  const manager = role === 'manager'
  const program = fx === 'upcoming' ? CMS_FX_STAFF_PROGRAMS[2] : fx === 'ended' ? CMS_FX_STAFF_ENDED[0] : fx === 'locked' ? CMS_FX_STAFF_ENDED[1] : CMS_FX_STAFF_PROGRAMS[0]
  const products = cmsFxStaffProducts(program.id)
  const base = fx === 'catalog' ? products[1] : fx === 'none' ? products[2] : fx === 'gate4' ? products[3] : products[0]
  const product = fx === 'long' ? { ...base, adviceText: CMS_FX_LONG_ADVICE } : base
  const results = scenario && fx !== 'upcoming' ? (manager ? cmsFxStoreResults(scenario) : cmsFxStaffResults(scenario)) : undefined
  const recent = results?.kind === 'loaded' && !manager ? cmsFxLines(results.rows.results).filter((l) => l.programProductId === product.id).slice(-3).reverse() : null
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-product" data-fx={fx} data-p2={scenario ?? undefined}>
        <CmsStaffProductView data={{ program, product }} today={CMS_FX_TODAY} results={results} manager={manager} recent={recent} />
      </div>
    </KpiFixtureBoundary>
  )
}
