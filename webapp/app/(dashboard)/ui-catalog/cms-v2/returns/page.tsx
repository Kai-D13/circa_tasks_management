import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsReturnsAdminView } from '@/components/cms/admin/CmsReturnsAdminView'
import { CmsCloseReportView } from '@/components/cms/admin/CmsCloseReportView'
import { cmsFxProgram } from '@/lib/cms/fixtureScenario'
import {
  CMS_FX_PG_CONTRACT, CMS_FX_REPORT_PROGRAM, cmsFxCloseReport, cmsFxCloseReports, cmsFxContract, cmsFxParseReturnsScenario, cmsFxReturnConflicts,
} from '@/lib/cms/fixturesContract'
import { cmsFixtureNav } from '@/lib/cms/fixtureNav'

// Dev-only fixture trang super "Trả hàng" `/targets/campaigns/cms/[id]/returns` (+ chi tiết báo cáo sau chốt) — ĐÚNG
// CmsReturnsAdminView / CmsCloseReportView của route thật, dữ liệu giả (lib/cms/fixturesContract). Xác nhận phục hồi / Xuất Excel đi qua
// useFixtureActionBlocked ⇒ 0 request ghi / export. Cổng: UI_CATALOG=1 + super admin.
//   &program=<id> (mặc định PG13 — tính nguyên + trừ trả) · &rs=clean | conflict | proof | restored | error (sổ trả của chương trình net)
//   · &off=1 (cờ returns OFF ⇒ nút khoá "Pipeline trả hàng đang tắt") · &program=<PG9> (QA đã chốt — khối Báo cáo sau chốt)
//   · &report=<id> (chi tiết báo cáo sau chốt của PG9).
export default async function CmsReturnsFixture({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const sp = await searchParams
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined)
  const programId = one('program') ?? CMS_FX_PG_CONTRACT.PG13
  const rs = cmsFxParseReturnsScenario(one('rs'))
  const contract = cmsFxContract(programId)
  const legacy = contract ? null : cmsFxProgram(programId)
  const fx = contract?.fx ?? legacy
  if (!fx) notFound()
  const nav = cmsFixtureNav(sp)
  const reportId = one('report')
  if (reportId) {
    const page = cmsFxCloseReport(fx.row.id, reportId)
    if (!page) notFound()
    return (
      <KpiFixtureBoundary>
        <div data-testid="ui-catalog-cms-returns" data-fx="report">
          <CmsCloseReportView program={{ id: fx.row.id, name: fx.row.name }} products={new Map(fx.products.map((p) => [p.id, p]))} page={page} nav={nav} />
        </div>
      </KpiFixtureBoundary>
    )
  }
  // Route thật: conflicts đọc mọi chương trình (RPC trả policy hiện tại); chương trình chưa trừ trả ⇒ chưa có baseline / lần kiểm sổ.
  // Fixture: chương trình net dùng kịch bản rs; chương trình khác ⇒ sổ rỗng (baselines 0, chưa lần kiểm).
  const conflicts = cmsFxReturnConflicts(fx.row.id, rs)
  const reports = fx.row.status === 'locked' ? cmsFxCloseReports(fx.row.id) ?? [] : null
  const disabledReason = one('off') === '1' ? 'Pipeline trả hàng đang tắt (CMS_RETURNS_ENABLED).' : null
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-returns" data-fx={rs} data-program={fx.row.id === CMS_FX_REPORT_PROGRAM ? 'report' : undefined}>
        <CmsReturnsAdminView
          program={{ id: fx.row.id, name: fx.row.name, status: fx.row.status }}
          conflicts={rs === 'error' ? { ok: false } : conflicts ? { ok: true, data: conflicts } : { ok: true, data: emptyLedger(fx.row.id, fx.row.configVersion) }}
          reports={reports === null ? null : { ok: true, data: reports }}
          confirm={{ idem: '00000000-0000-4000-8000-000000009990', disabledReason }}
          nav={nav}
        />
      </div>
    </KpiFixtureBoundary>
  )
}

/** Chương trình chưa trừ trả / chưa có lần kiểm sổ: hình dạng rpc_cms_return_conflicts khi chưa có baseline. */
function emptyLedger(programId: string, configVersion: number) {
  return {
    programId, returnsPolicy: 'sales_only_v1', configVersion, baselines: 0, openSetHash: '0'.repeat(64), openCount: 0, openTruncated: false,
    latestEval: null, proof: null, open: [], restorations: [],
  }
}
