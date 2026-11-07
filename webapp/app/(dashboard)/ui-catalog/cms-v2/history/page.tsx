import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsStaffHistoryView, type CmsHistoryLines } from '@/components/cms/staff/CmsStaffHistoryView'
import { CMS_FX_STAFF_ENDED, CMS_FX_STAFF_PROGRAMS, CMS_FX_TODAY, cmsFxStaffProducts } from '@/lib/cms/fixturesStaff'
import { cmsFxProgram } from '@/lib/cms/fixtureScenario'
import { cmsFxLines, cmsFxParseScenario, cmsFxStaffResults, cmsFxStoreResults } from '@/lib/cms/fixturesResults'
import { cmsParseHistoryParams } from '@/lib/cms/resultUi'
import { cmsFixtureNav } from '@/lib/cms/fixtureNav'

// Dev-only fixture D3 `/targets/cms/history` — ĐÚNG CmsStaffHistoryView + cmsParseHistoryParams / phân trang của route thật,
// dữ liệu giả (kịch bản lib/cms/fixtureScenario — dòng engine của run, seq theo toàn bộ ứng viên). Cổng: UI_CATALOG=1 + super
// admin. ?p2=running|top|held|none|error|gone|config (mặc định running) · &role=manager hoặc &as=manager (QLCH) · &program= ·
// &product= · &n= · &after= · &run= (khác run hiện hành ⇒ "dữ liệu đã thay đổi") · &fx=empty | lines-error | with-ended.
export default async function CmsHistoryFixture({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const sp = await searchParams
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined)
  const scenario = cmsFxParseScenario(one('p2')) ?? 'running'
  const fx = one('fx')
  const manager = one('role') === 'manager' || one('as') === 'manager'
  const params = cmsParseHistoryParams(sp)
  // Như route thật: chương trình ĐÃ BẮT ĐẦU (đang chạy / chờ chốt / đã chốt) — sắp diễn ra không có lịch sử.
  const started = [...CMS_FX_STAFF_PROGRAMS, ...CMS_FX_STAFF_ENDED].filter((p) => p.startDate <= CMS_FX_TODAY)
  const programs = fx === 'empty' ? [] : fx === 'with-ended' || params.programId ? started : started.filter((p) => p.status === 'active' && p.endDate >= CMS_FX_TODAY)
  const selected = programs.find((p) => p.id === params.programId) ?? programs[0] ?? null
  const products = selected ? cmsFxStaffProducts(selected.id) : []
  const results = selected ? (manager ? cmsFxStoreResults(scenario, selected.id) : cmsFxStaffResults(scenario, selected.id)) : { kind: 'off' as const }
  const productId = params.productId && products.some((p) => p.id === params.productId) ? params.productId : null
  const runId = selected ? cmsFxProgram(selected.id)?.run?.id ?? null : null
  let lines: CmsHistoryLines = { kind: 'none' }
  if (results.kind === 'loaded' && results.header.run) {
    if (fx === 'lines-error') lines = { kind: 'error' }
    else if (params.run && params.run !== runId) lines = { kind: 'stale' }
    else {
      const all = cmsFxLines(results.rows.results).filter((l) => !productId || l.programProductId === productId)
      const from = all.filter((l) => params.after === null || l.seq > params.after)
      const page = from.slice(0, params.n)
      lines = { kind: 'ok', rows: page, nextAfterSeq: from.length > params.n ? page[page.length - 1].seq : null }
    }
  }
  const userNames = new Map(results.kind === 'loaded' ? results.rows.users.map((u) => [u.id, u.fullName] as const) : [])
  const nav = cmsFixtureNav(sp, manager ? { as: 'manager' } : {})
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-history" data-p2={scenario} data-fx={fx ?? undefined}>
        <CmsStaffHistoryView
          programs={programs}
          selected={selected}
          products={products}
          results={results}
          lines={selected ? lines : { kind: 'none' }}
          params={{ ...params, programId: selected?.id ?? null, productId }}
          manager={manager}
          today={CMS_FX_TODAY}
          returnsApproved={false}
          userNames={userNames}
          nav={nav}
        />
      </div>
    </KpiFixtureBoundary>
  )
}
