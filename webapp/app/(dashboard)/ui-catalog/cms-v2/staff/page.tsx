import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsStaffCatalogView } from '@/components/cms/staff/CmsStaffCatalogView'
import { CMS_FX_STAFF_ENDED, CMS_FX_STAFF_PROGRAMS, CMS_FX_TODAY, cmsFxStaffProducts } from '@/lib/cms/fixturesStaff'
import { cmsPickStaffProgram } from '@/lib/cms/staffView'
import { cmsFxParseScenario, cmsFxStaffResults, cmsFxStoreResults } from '@/lib/cms/fixturesResults'
import { cmsParseCardFilter } from '@/lib/cms/resultUi'

// Dev-only fixture D1 `/targets?tab=cms` — ĐÚNG CmsStaffCatalogView + cmsPickStaffProgram của route thật, dữ liệu giả (không
// truy vấn). Cổng: UI_CATALOG=1 + super admin. ?fx=
//   many (mặc định: 2 đang chạy + 1 sắp diễn ra — nút chọn chương trình) · single (1 chương trình — nhãn) · upcoming (đang
//   xem chương trình sắp diễn ra) · manager (QLCH) · manager-nokpi (QLCH khi cờ KPI campaign OFF — không segmented) ·
//   empty · no-store · error
// P2-c: &p2=running|top|held|none|error|gone|config (+ &f=all|met|unmet) — số liệu giả của chương trình đang chạy (manager ⇒ tổng
// nhà thuốc). Không p2 ⇒ P1 nguyên trạng.
// P3a r2: fx=history (danh sách gồm nhóm "Đã kết thúc", mặc định vẫn chọn chương trình đang chạy) · ended (đang xem Chờ chốt kỳ)
//   · locked (đang xem Đã chốt — số của run đóng băng) · locked-manager (QLCH xem Đã chốt).
export default async function CmsStaffFixture({ searchParams }: { searchParams: Promise<{ fx?: string; program?: string; p2?: string; f?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'many', program, p2: p2Raw, f } = await searchParams
  const scenario = cmsFxParseScenario(p2Raw)
  const withEnded = fx === 'history' || fx === 'ended' || fx === 'locked' || fx === 'locked-manager'
  const programs = fx === 'single' ? CMS_FX_STAFF_PROGRAMS.slice(0, 1) : withEnded ? [...CMS_FX_STAFF_PROGRAMS, ...CMS_FX_STAFF_ENDED] : CMS_FX_STAFF_PROGRAMS
  const forced = fx === 'upcoming' ? CMS_FX_STAFF_PROGRAMS[2].id : fx === 'ended' ? CMS_FX_STAFF_ENDED[0].id : fx === 'locked' || fx === 'locked-manager' ? CMS_FX_STAFF_ENDED[1].id : null
  const selected = fx === 'empty' || fx === 'no-store' || fx === 'error' ? null
    : cmsPickStaffProgram(programs, CMS_FX_TODAY, forced ?? program ?? null)
  const kind = fx === 'error' ? 'error' : fx === 'no-store' ? 'no-store' : selected ? 'ok' : 'empty'
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-staff" data-fx={fx} data-p2={scenario ?? undefined}>
        <CmsStaffCatalogView
          kind={kind}
          programs={selected ? programs : []}
          selected={selected}
          products={selected ? cmsFxStaffProducts(selected.id) : []}
          today={CMS_FX_TODAY}
          manager={fx === 'manager' || fx === 'manager-nokpi' || fx === 'locked-manager'}
          kpiTab={fx !== 'manager-nokpi'}
          results={scenario && selected && selected.startDate <= CMS_FX_TODAY ? (fx === 'manager' || fx === 'manager-nokpi' || fx === 'locked-manager' ? cmsFxStoreResults(scenario) : cmsFxStaffResults(scenario)) : undefined}
          filter={cmsParseCardFilter(f)}
        />
      </div>
    </KpiFixtureBoundary>
  )
}
