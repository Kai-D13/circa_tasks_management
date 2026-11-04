import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsStaffCatalogView } from '@/components/cms/staff/CmsStaffCatalogView'
import { CMS_FX_STAFF_ENDED, CMS_FX_STAFF_PROGRAMS, CMS_FX_TODAY, cmsFxStaffProducts } from '@/lib/cms/fixturesStaff'
import { cmsPickStaffProgram } from '@/lib/cms/staffView'
import { cmsFxParseScenario, cmsFxStaffResults, cmsFxStoreResults } from '@/lib/cms/fixturesResults'
import { cmsParseCardFilter } from '@/lib/cms/resultUi'
import { cmsFixtureNav } from '@/lib/cms/fixtureNav'

// Dev-only fixture D1 `/targets?tab=cms` — ĐÚNG CmsStaffCatalogView + cmsPickStaffProgram của route thật, dữ liệu giả (kịch bản
// lib/cms/fixtureScenario — mỗi chương trình có danh mục / số engine của nó). Cổng: UI_CATALOG=1 + super admin. ?fx=
//   many (mặc định: 2 đang chạy + 1 sắp diễn ra — nút chọn chương trình) · single (1 chương trình — nhãn) · upcoming (đang
//   xem chương trình sắp diễn ra) · manager (QLCH; cũng nhận &as=manager) · manager-nokpi (QLCH khi cờ KPI campaign OFF — không
//   segmented) · empty · no-store · error
// P2-c: &p2=running|top|held|none|error|gone|config (+ &f=all|met|unmet) — dược sĩ A (top: dược sĩ B) / QLCH nhà thuốc 01.
// P3a r2: fx=history (danh sách gồm nhóm "Đã kết thúc") · ended (Chờ chốt kỳ) · locked (Đã chốt — run đóng băng) · locked-manager.
// CMS-UI-1: &program=<id> (link bộ chọn / quay lại từ D2 / D3) — danh sách gồm cả chương trình đã kết thúc như route thật.
export default async function CmsStaffFixture({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const sp = await searchParams
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined)
  const fx = one('fx') ?? (one('as') === 'manager' ? 'manager' : 'many')
  const program = one('program')
  const scenario = cmsFxParseScenario(one('p2'))
  const manager = fx === 'manager' || fx === 'manager-nokpi' || fx === 'locked-manager'
  const withEnded = fx === 'history' || fx === 'ended' || fx === 'locked' || fx === 'locked-manager' || program !== undefined
  const programs = fx === 'single' ? CMS_FX_STAFF_PROGRAMS.slice(0, 1) : withEnded ? [...CMS_FX_STAFF_PROGRAMS, ...CMS_FX_STAFF_ENDED] : CMS_FX_STAFF_PROGRAMS
  const forced = fx === 'upcoming' ? CMS_FX_STAFF_PROGRAMS[2].id : fx === 'ended' ? CMS_FX_STAFF_ENDED[0].id : fx === 'locked' || fx === 'locked-manager' ? CMS_FX_STAFF_ENDED[1].id : null
  const selected = fx === 'empty' || fx === 'no-store' || fx === 'error' ? null
    : cmsPickStaffProgram(programs, CMS_FX_TODAY, forced ?? program ?? null)
  const kind = fx === 'error' ? 'error' : fx === 'no-store' ? 'no-store' : selected ? 'ok' : 'empty'
  const nav = cmsFixtureNav(sp, manager ? { as: 'manager' } : {})
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-staff" data-fx={fx} data-p2={scenario ?? undefined}>
        <CmsStaffCatalogView
          kind={kind}
          programs={selected ? programs : []}
          selected={selected}
          products={selected ? cmsFxStaffProducts(selected.id) : []}
          today={CMS_FX_TODAY}
          manager={manager}
          kpiTab={fx !== 'manager-nokpi'}
          results={scenario && selected && selected.startDate <= CMS_FX_TODAY ? (manager ? cmsFxStoreResults(scenario, selected.id) : cmsFxStaffResults(scenario, selected.id)) : undefined}
          filter={cmsParseCardFilter(one('f'))}
          nav={nav}
        />
      </div>
    </KpiFixtureBoundary>
  )
}
