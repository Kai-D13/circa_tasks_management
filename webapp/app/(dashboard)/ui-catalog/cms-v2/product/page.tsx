import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsStaffProductView } from '@/components/cms/staff/CmsStaffProductView'
import { CMS_FX_LONG_ADVICE, CMS_FX_STAFF_ENDED, CMS_FX_STAFF_PROGRAMS, CMS_FX_TODAY, cmsFxStaffProducts } from '@/lib/cms/fixturesStaff'
import { cmsFxProgramOfProduct, cmsFxRowView } from '@/lib/cms/fixtureScenario'
import { cmsFxLines, cmsFxParseScenario, cmsFxStaffResults, cmsFxStoreResults } from '@/lib/cms/fixturesResults'
import { cmsFixtureNav } from '@/lib/cms/fixtureNav'

// Dev-only fixture D2 `/targets/cms/products/[id]` — ĐÚNG CmsStaffProductView của route thật, dữ liệu giả (kịch bản
// lib/cms/fixtureScenario). Cổng: UI_CATALOG=1 + super admin. &pp=<program_product_id> (link từ thẻ D1) hoặc ?fx=
//   product (mặc định: target SP, 3 bậc) · catalog (target danh mục, 1 bậc mở) · none (không target, 1 bậc không giới hạn = SP mức cố định — CMS đơn giản S3, số lẻ) ·
//   long (tư vấn ~4.000 ký tự) · upcoming (chương trình sắp diễn ra) · gate4 (SP target chưa đạt, quy cách 0,5)
// P2-c: &p2=running|top|held|none|error|gone|config (&role=manager hoặc &as=manager ⇒ tổng nhà thuốc) — số engine + 3 ghi nhận.
// P3a r2: fx=ended (Chờ chốt kỳ) · fx=locked (Đã chốt — không "Nếu bán thêm", nhãn đã chốt).
// CMS đơn giản (PM r1 08/11 §6): &pp=<SP của PG10–12> (mức cố định / hộp); p2=reset ⇒ config_reset.
export default async function CmsProductFixture({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const sp = await searchParams
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined)
  const fx = one('fx') ?? 'product'
  const scenario = cmsFxParseScenario(one('p2'))
  const manager = one('role') === 'manager' || one('as') === 'manager'
  const byPp = cmsFxProgramOfProduct(one('pp'))
  if (one('pp') && !byPp) notFound()
  const program = byPp ? cmsFxRowView(byPp.row)
    : fx === 'upcoming' ? CMS_FX_STAFF_PROGRAMS[2] : fx === 'ended' ? CMS_FX_STAFF_ENDED[0] : fx === 'locked' ? CMS_FX_STAFF_ENDED[1] : CMS_FX_STAFF_PROGRAMS[0]
  const products = cmsFxStaffProducts(program.id)
  const pick = (i: number) => products[Math.min(i, products.length - 1)]
  // Chờ chốt kỳ / Đã chốt: SP đầu tiên dược sĩ A CÓ CMS trong run của chương trình đó (để xem nhãn "đã chốt" trên số thật).
  const earned = fx === 'ended' || fx === 'locked'
    ? (() => { const l = cmsFxStaffResults('running', program.id); return l.kind === 'loaded' ? products.find((p) => l.rows.results.some((r) => r.programProductId === p.id && BigInt(r.amountVnd) > BigInt(0))) : undefined })()
    : undefined
  const base = byPp ? products.find((p) => p.id === one('pp'))!
    : earned ?? (fx === 'catalog' ? pick(1) : fx === 'none' ? pick(2) : fx === 'gate4' ? pick(3) : pick(0))
  const product = fx === 'long' ? { ...base, adviceText: CMS_FX_LONG_ADVICE } : base
  const results = scenario && program.startDate <= CMS_FX_TODAY ? (manager ? cmsFxStoreResults(scenario, program.id) : cmsFxStaffResults(scenario, program.id)) : undefined
  const recent = results?.kind === 'loaded' && !manager ? cmsFxLines(results.rows.results.filter((r) => r.programProductId === product.id)).slice(-3).reverse() : null
  const nav = cmsFixtureNav(sp, manager ? { as: 'manager' } : {})
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-product" data-fx={fx} data-p2={scenario ?? undefined}>
        <CmsStaffProductView data={{ program, product }} today={CMS_FX_TODAY} results={results} manager={manager} recent={recent} nav={nav} />
      </div>
    </KpiFixtureBoundary>
  )
}
