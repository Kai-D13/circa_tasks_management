import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsStaffHistoryView, type CmsHistoryLines } from '@/components/cms/staff/CmsStaffHistoryView'
import { CMS_FX_STAFF_PROGRAMS, CMS_FX_TODAY, cmsFxStaffProducts } from '@/lib/cms/fixturesStaff'
import { CMS_FX_RUN, cmsFxLines, cmsFxParseScenario, cmsFxStaffResults, cmsFxStoreResults } from '@/lib/cms/fixturesResults'
import { cmsParseHistoryParams } from '@/lib/cms/resultUi'

// Dev-only fixture D3 `/targets/cms/history` — ĐÚNG CmsStaffHistoryView + cmsParseHistoryParams / phân trang của route thật,
// dữ liệu giả (không truy vấn, không ghi). Cổng: UI_CATALOG=1 + super admin. ?p2=running|top|held|none|error|gone|config
// (mặc định running) · &role=manager (QLCH) · &product= · &n= · &after= · &run= (khác run giả ⇒ "dữ liệu đã thay đổi") ·
// &fx=empty (chưa có chương trình) | lines-error.
export default async function CmsHistoryFixture({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const sp = await searchParams
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined)
  const scenario = cmsFxParseScenario(one('p2')) ?? 'running'
  const fx = one('fx')
  const manager = one('role') === 'manager'
  const programs = fx === 'empty' ? [] : CMS_FX_STAFF_PROGRAMS.slice(0, 2)
  const params = cmsParseHistoryParams(sp)
  const selected = programs.find((p) => p.id === params.programId) ?? programs[0] ?? null
  const products = selected ? cmsFxStaffProducts(selected.id) : []
  const results = manager ? cmsFxStoreResults(scenario) : cmsFxStaffResults(scenario)
  const productId = params.productId && products.some((p) => p.id === params.productId) ? params.productId : null
  let lines: CmsHistoryLines = { kind: 'none' }
  if (results.kind === 'loaded' && results.header.run) {
    if (fx === 'lines-error') lines = { kind: 'error' }
    else if (params.run && params.run !== CMS_FX_RUN) lines = { kind: 'stale' }
    else {
      const all = cmsFxLines(results.rows.results).filter((l) => !productId || l.programProductId === productId)
      const from = all.filter((l) => params.after === null || l.seq > params.after)
      const page = from.slice(0, params.n)
      lines = { kind: 'ok', rows: page, nextAfterSeq: from.length > params.n ? page[page.length - 1].seq : null }
    }
  }
  const userNames = new Map(results.kind === 'loaded' ? results.rows.users.map((u) => [u.id, u.fullName] as const) : [])
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-history" data-p2={scenario} data-fx={fx ?? undefined}>
        <CmsStaffHistoryView
          programs={programs}
          selected={selected}
          products={products}
          results={selected ? results : { kind: 'off' }}
          lines={selected ? lines : { kind: 'none' }}
          params={{ ...params, programId: selected?.id ?? null, productId }}
          manager={manager}
          today={CMS_FX_TODAY}
          returnsApproved={false}
          userNames={userNames}
        />
      </div>
    </KpiFixtureBoundary>
  )
}
