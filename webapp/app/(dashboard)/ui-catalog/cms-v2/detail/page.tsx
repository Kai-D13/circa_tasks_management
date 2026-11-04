import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsProgramDetailView } from '@/components/cms/admin/CmsProgramDetailView'
import { CmsDetailSkeleton } from '@/components/cms/CmsRouteSkeletons'
import { CMS_FX_TODAY, cmsFxDetail } from '@/lib/cms/fixtures'
import { CMS_FX_STORE_NAMES, cmsFxDetailOf, cmsFxEligibleStaff, cmsFxProgram } from '@/lib/cms/fixtureScenario'
import { cmsFxAdminResults, cmsFxCorruptResults, cmsFxParseScenario } from '@/lib/cms/fixturesResults'
import { cmsFxIsPayoutScenario, cmsFxLockPreview, cmsFxP3Program, cmsFxParseP3, cmsFxPayout } from '@/lib/cms/fixturesPayout'
import { cmsDisplayStatus } from '@/lib/cms/programStatus'
import { cmsFixtureNav } from '@/lib/cms/fixtureNav'
import type { CmsResultsLoad } from '@/lib/cms/resultUi'

// Dev-only fixture A3 — ĐÚNG CmsProgramDetailView của route thật, dữ liệu giả (kịch bản lib/cms/fixtureScenario — số do engine
// tính). Kích hoạt / tải file đi qua useFixtureActionBlocked ⇒ 0 request ghi / export. Cổng: UI_CATALOG=1 + super admin.
//   &program=<id> — chương trình bất kỳ của danh sách A1 (link từ A1 / quay lại đều ở trong catalog); &as=sm ⇒ phạm vi SM.
//   ?fx= draft (mặc định, có nút Kích hoạt) · draft-empty · retro (nháp ngày bắt đầu đã qua — hộp xác nhận hồi tố) ·
//   upcoming (đã kích hoạt chưa bắt đầu) · running (đã bắt đầu: chỉ Import bổ sung) · sm (chỉ đọc) · runs · loading
// P2-c: &p2=running|top|held|none|error|gone|config (+ corrupt — kịch bản HỎNG có tên riêng: tiền lệch bậc ⇒ "chưa đủ dữ liệu giải
// thích") + &view=products|staff|runs &page= — số liệu engine; SM không có nhóm Chưa gán. Không p2 ⇒ P1 nguyên trạng.
// P3a: &p3=ready|ack|blocked|error|qa-readonly ⇒ PG8 (QA hết kỳ) + khối "Chốt kỳ"; &p3=pending ⇒ PG4 (chương trình thật chờ chốt);
//   &p3=locked|locked-sm|locked-error ⇒ PG9 (QA đã chốt) + "Số đã chốt". Có p2 + chương trình đã chốt ⇒ cũng hiện "Số đã chốt".
export default async function CmsDetailFixture({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const sp = await searchParams
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined)
  const fx = one('fx') ?? 'draft'
  const p2Raw = one('p2')
  const p3 = cmsFxParseP3(one('p3'))
  const corrupt = p2Raw === 'corrupt'
  const scenario = p3 ? 'running' : corrupt ? 'running' : cmsFxParseScenario(p2Raw)
  const sm = fx === 'sm' || one('as') === 'sm' || p3 === 'locked-sm'
  const viewer = sm ? 'sm' : 'super'
  const programParam = p3 ? cmsFxP3Program(p3) : one('program')
  const fxProgram = programParam ? cmsFxProgram(programParam) : null
  if (programParam && !fxProgram) notFound()
  const detail = fxProgram ? cmsFxDetailOf(fxProgram, { sm })
    : cmsFxDetail(scenario ? 'running' : fx === 'draft-empty' || fx === 'retro' || fx === 'upcoming' || fx === 'running' ? fx : fx === 'sm' ? 'running' : 'draft')
  const prog = detail.program
  const display = cmsDisplayStatus(prog, CMS_FX_TODAY)
  const started = prog.status !== 'draft' && prog.startDate <= CMS_FX_TODAY
  const results: CmsResultsLoad | undefined = !scenario || !started ? undefined
    : corrupt ? cmsFxCorruptResults() : cmsFxAdminResults(scenario, viewer, prog.id)
  const v = one('view') === 'staff' ? 'staff' : one('view') === 'runs' || fx === 'runs' ? 'runs' : 'products'
  const lock = p3 && !cmsFxIsPayoutScenario(p3)
    ? { preview: cmsFxLockPreview(p3, prog.id), error: p3 === 'error' ? 'QUERY_FAILED' : null, qaReadonly: p3 === 'qa-readonly' }
    : !p3 && scenario && !sm && display === 'waiting_close' ? { preview: cmsFxLockPreview(prog.isTest ? 'ready' : 'pending', prog.id), error: null } : null
  const payout = p3 && cmsFxIsPayoutScenario(p3)
    ? { data: cmsFxPayout(p3, prog.id), error: p3 === 'locked-error' ? 'QUERY_FAILED' : null }
    : !p3 && scenario && display === 'locked' ? { data: cmsFxPayout(sm ? 'locked-sm' : 'locked', prog.id), error: null } : null
  const nav = cmsFixtureNav(sp, sm ? { as: 'sm' } : {})
  const page = Number(one('page'))
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-detail" data-fx={fx} data-p2={corrupt ? 'corrupt' : scenario ?? undefined} data-p3={p3 ?? undefined}>
        {fx === 'loading' ? <CmsDetailSkeleton /> : (
          <CmsProgramDetailView detail={detail} today={CMS_FX_TODAY} canManage={!sm} view={v} results={results}
            eligibleStaffIds={results ? cmsFxEligibleStaff(viewer, detail.storeIds) : null} storeNames={CMS_FX_STORE_NAMES} staffPage={page > 0 ? page : 1}
            lock={lock} payout={payout} nav={nav} />
        )}
      </div>
    </KpiFixtureBoundary>
  )
}
