import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsProgramDetailView } from '@/components/cms/admin/CmsProgramDetailView'
import { CmsDetailSkeleton } from '@/components/cms/CmsRouteSkeletons'
import { CMS_FX_TODAY, cmsFxDetail } from '@/lib/cms/fixtures'
import { CMS_FX_STORE_NAMES, cmsFxDetailOf, cmsFxEligibleStaff, cmsFxProgram } from '@/lib/cms/fixtureScenario'
import { cmsFxAdminResults, cmsFxCorruptResults, cmsFxParseScenario, withBasisUi } from '@/lib/cms/fixturesResults'
import { cmsFxIsPayoutScenario, cmsFxLockPreview, cmsFxP3Program, cmsFxParseP3, cmsFxPayout } from '@/lib/cms/fixturesPayout'
import { cmsDisplayStatus } from '@/lib/cms/programStatus'
import { cmsFixtureNav } from '@/lib/cms/fixtureNav'
import type { CmsResultsLoad } from '@/lib/cms/resultUi'
import { CMS_FX_REPORT_PROGRAM, cmsFxContract, cmsFxContractBasis, cmsFxContractPayout } from '@/lib/cms/fixturesContract'
import { cmsRevisionDetailLinks } from '@/lib/cms/revision/model'

// Dev-only fixture A3 — ĐÚNG CmsProgramDetailView của route thật, dữ liệu giả (kịch bản lib/cms/fixtureScenario — số do engine
// tính). Kích hoạt / tải file đi qua useFixtureActionBlocked ⇒ 0 request ghi / export. Cổng: UI_CATALOG=1 + super admin.
//   &program=<id> — chương trình bất kỳ của danh sách A1 (link từ A1 / quay lại đều ở trong catalog); &as=sm ⇒ phạm vi SM.
//   ?fx= draft (mặc định, có nút Kích hoạt) · draft-empty · retro (nháp ngày bắt đầu đã qua — hộp xác nhận hồi tố) ·
//   upcoming (đã kích hoạt chưa bắt đầu) · running (đã bắt đầu: chỉ Import bổ sung) · sm (chỉ đọc) · runs · loading
// P2-c: &p2=running|top|held|none|error|gone|config (+ corrupt — kịch bản HỎNG có tên riêng: tiền lệch bậc ⇒ "chưa đủ dữ liệu giải
// thích") + &view=products|staff|runs &page= — số liệu engine; SM không có nhóm Chưa gán. Không p2 ⇒ P1 nguyên trạng.
// P3a: &p3=ready|ack|blocked|error|qa-readonly ⇒ PG8 (QA hết kỳ) + khối "Chốt kỳ"; &p3=pending ⇒ PG4 (chương trình thật chờ chốt);
//   &p3=locked|locked-sm|locked-error ⇒ PG9 (QA đã chốt) + "Số đã chốt". Có p2 + chương trình đã chốt ⇒ cũng hiện "Số đã chốt".
// CMS-CALC-RET-2 P5: &program=<PG13–15> (run contract — badge cách tính / chính sách trả, dòng "Cách tính", tổng trả hàng; không p2 ⇒
//   running). &bu=1 giả lập cờ mode / trả BẬT (run legacy cũng hiện dòng "Cách tính").
//   &ret=1 giả lập CMS_RETURNS_ENABLED (route thật: cmsReturnsPageEnabled) ⇒ nút "Trả hàng" (super) ⇒ /ui-catalog/cms-v2/returns
//   cho PG13–15 và PG9 (đã chốt — báo cáo sau chốt). Không ret ⇒ như bản phát hành CMS bán hàng (PM 14/11): KHÔNG nút Trả hàng.
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
  const contractFx = cmsFxContract(one('program'))
  const scenario = p3 ? 'running' : corrupt ? 'running' : cmsFxParseScenario(p2Raw) ?? (contractFx ? 'running' : null)
  const sm = fx === 'sm' || one('as') === 'sm' || p3 === 'locked-sm'
  const viewer = sm ? 'sm' : 'super'
  const programParam = p3 ? cmsFxP3Program(p3) : one('program')
  const fxProgram = programParam ? cmsFxProgram(programParam) ?? cmsFxContract(programParam)?.fx ?? null : null
  if (programParam && !fxProgram) notFound()
  const detail = fxProgram ? cmsFxDetailOf(fxProgram, { sm })
    : cmsFxDetail(scenario ? 'running' : fx === 'draft-empty' || fx === 'retro' || fx === 'upcoming' || fx === 'running' ? fx : fx === 'sm' ? 'running' : 'draft')
  const prog = detail.program
  const display = cmsDisplayStatus(prog, CMS_FX_TODAY)
  const started = prog.status !== 'draft' && prog.startDate <= CMS_FX_TODAY
  const results: CmsResultsLoad | undefined = withBasisUi(!scenario || !started ? undefined
    : corrupt ? cmsFxCorruptResults() : cmsFxAdminResults(scenario, viewer, prog.id), one('bu') === '1')
  const v = one('view') === 'staff' ? 'staff' : one('view') === 'runs' || fx === 'runs' ? 'runs' : 'products'
  const lock = p3 && !cmsFxIsPayoutScenario(p3)
    ? { preview: cmsFxLockPreview(p3, prog.id), error: p3 === 'error' ? 'QUERY_FAILED' : null, qaReadonly: p3 === 'qa-readonly' }
    : !p3 && scenario && !sm && display === 'waiting_close' ? { preview: cmsFxLockPreview(prog.isTest ? 'ready' : 'pending', prog.id), error: null } : null
  // 132 r1: chương trình full_line đã chốt run contract (PG18) ⇒ số RÒNG + khối hợp đồng (fixturesContract.cmsFxContractPayout).
  const contractLocked = contractFx?.fx.row.status === 'locked'
  const payout = p3 && cmsFxIsPayoutScenario(p3)
    ? { data: cmsFxPayout(p3, prog.id), error: p3 === 'locked-error' ? 'QUERY_FAILED' : null }
    : !p3 && scenario && display === 'locked'
      ? { data: contractLocked ? cmsFxContractPayout(sm ? 'sm' : 'super') : cmsFxPayout(sm ? 'locked-sm' : 'locked', prog.id), error: null } : null
  const nav = cmsFixtureNav(sp, sm ? { as: 'sm' } : {})
  // r3 (PM P1-02): &rev= giả lập cổng ĐỌC mở (DB 131) qua ĐÚNG hàm dựng link của route thật — write-off (đã sửa + đang che số, cờ ghi
  // TẮT ⇒ có Lịch sử, KHÔNG nút Sửa) · write-on (cờ ghi bật, chưa sửa ⇒ chỉ nút Sửa) · state-error (không đọc được trạng thái ⇒ vẫn có Lịch sử).
  const revFx = one('rev')
  const revision = sm || !revFx ? null : revFx === 'write-off'
    ? cmsRevisionDetailLinks({ programId: prog.id, status: prog.status, writable: false, state: { ok: true, data: { revised: true, masked: true, lastRevisedAt: '2026-11-17T08:05:00.000Z' } } })
    : revFx === 'write-on'
      ? cmsRevisionDetailLinks({ programId: prog.id, status: prog.status, writable: true, state: { ok: true, data: { revised: false, masked: false, lastRevisedAt: null } } })
      : revFx === 'state-error' ? cmsRevisionDetailLinks({ programId: prog.id, status: prog.status, writable: false, state: { ok: false } }) : null
  const page = Number(one('page'))
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-detail" data-fx={fx} data-p2={corrupt ? 'corrupt' : scenario ?? undefined} data-p3={p3 ?? undefined}>
        {fx === 'loading' ? <CmsDetailSkeleton /> : (
          <CmsProgramDetailView detail={detail} today={CMS_FX_TODAY} canManage={!sm} view={v} results={results}
            eligibleStaffIds={results ? cmsFxEligibleStaff(viewer, detail.storeIds) : null} storeNames={CMS_FX_STORE_NAMES} staffPage={page > 0 ? page : 1}
            lock={lock} payout={payout} nav={nav}
            basis={contractFx ? cmsFxContractBasis(contractFx.fx.row.id) : undefined}
            returnsHref={!sm && one('ret') === '1' && (contractFx || prog.id === CMS_FX_REPORT_PROGRAM) ? `/targets/campaigns/cms/${prog.id}/returns` : null}
            revision={revision} />
        )}
      </div>
    </KpiFixtureBoundary>
  )
}
