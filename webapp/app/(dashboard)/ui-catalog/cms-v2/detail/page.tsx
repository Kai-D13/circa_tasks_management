import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsProgramDetailView } from '@/components/cms/admin/CmsProgramDetailView'
import { CmsDetailSkeleton } from '@/components/cms/CmsRouteSkeletons'
import { CMS_FX_TODAY, cmsFxDetail } from '@/lib/cms/fixtures'
import { CMS_FX_STORE_NAMES, CMS_FX_USERS, cmsFxAdminResults, cmsFxParseScenario } from '@/lib/cms/fixturesResults'
import { cmsFxIsPayoutScenario, cmsFxLockPreview, cmsFxParseP3, cmsFxPayout } from '@/lib/cms/fixturesPayout'

// Dev-only fixture A3 — ĐÚNG CmsProgramDetailView của route thật, dữ liệu giả. Kích hoạt / tải file lỗi đi qua
// useFixtureActionBlocked ⇒ 0 request ghi. Cổng: UI_CATALOG=1 + super admin. ?fx=
//   draft (mặc định, có nút Kích hoạt) · draft-empty · retro (nháp ngày bắt đầu đã qua — hộp xác nhận hồi tố) ·
//   upcoming (đã kích hoạt chưa bắt đầu) · running (đã bắt đầu: chỉ Import bổ sung) · sm (chỉ đọc) · runs · loading
// P2-c: &p2=running|top|held|none|error|gone|config (chương trình đang chạy) + &view=products|staff|runs &page= — số liệu giả;
// fx=sm ⇒ phạm vi SM (không nhóm Chưa gán). Không p2 ⇒ P1 nguyên trạng.
// P3a: &p3=ready|ack|blocked|pending|error ⇒ chương trình QA đã hết kỳ + khối "Chốt kỳ" (super; xác nhận chốt bị chặn ở fixture);
//   &p3=locked|locked-sm|locked-error ⇒ chương trình đã chốt + khối "Số đã chốt" (super / SM). Kết quả A3 cùng run giả (p2=running).
//   &p3=qa-readonly ⇒ khối Chốt kỳ trên server QA chỉ đọc (r2 — PM r1 PKG-P1-2: nút khoá; server từ chối trước RPC).
export default async function CmsDetailFixture({ searchParams }: { searchParams: Promise<{ fx?: string; p2?: string; p3?: string; view?: string; page?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'draft', p2: p2Raw, p3: p3Raw, view, page } = await searchParams
  const p3 = cmsFxParseP3(p3Raw)
  const scenario = p3 ? 'running' : cmsFxParseScenario(p2Raw)
  const sm = fx === 'sm' || p3 === 'locked-sm'
  const kind = p3 ? (cmsFxIsPayoutScenario(p3) ? 'locked' : 'ended')
    : scenario ? 'running' : fx === 'draft-empty' || fx === 'retro' || fx === 'upcoming' || fx === 'running' ? fx : fx === 'sm' ? 'running' : 'draft'
  const detail = cmsFxDetail(kind)
  const v = view === 'staff' ? 'staff' : view === 'runs' || fx === 'runs' ? 'runs' : 'products'
  const eligible = sm ? [CMS_FX_USERS.A, CMS_FX_USERS.B, CMS_FX_USERS.C] : Object.values(CMS_FX_USERS).concat(['00000000-0000-4000-8000-000000007099'])
  const lock = p3 && !cmsFxIsPayoutScenario(p3)
    ? { preview: cmsFxLockPreview(p3, detail.program.id, detail.program.endDate), error: p3 === 'error' ? 'QUERY_FAILED' : null, qaReadonly: p3 === 'qa-readonly' }
    : null
  const payout = p3 && cmsFxIsPayoutScenario(p3)
    ? { data: cmsFxPayout(p3, detail.program.id), error: p3 === 'locked-error' ? 'QUERY_FAILED' : null }
    : null
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-detail" data-fx={fx} data-p2={scenario ?? undefined} data-p3={p3 ?? undefined}>
        {fx === 'loading' ? <CmsDetailSkeleton /> : (
          <CmsProgramDetailView detail={detail} today={CMS_FX_TODAY} canManage={!sm} view={v}
            results={scenario ? cmsFxAdminResults(scenario, sm ? 'sm' : 'super') : undefined}
            eligibleStaffIds={scenario ? eligible : null} storeNames={CMS_FX_STORE_NAMES} staffPage={Number(page) > 0 ? Number(page) : 1}
            lock={lock} payout={payout} />
        )}
      </div>
    </KpiFixtureBoundary>
  )
}
