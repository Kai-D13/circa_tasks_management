import { notFound } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isCmsLockEnabled, isCmsProgramEnabled, isCmsQaServer } from '@/lib/cms/flags'
import { cmsLockDeps, cmsLoadPayout } from '@/lib/cms/server/payouts'
import { runCmsLockPreview } from '@/lib/cms/lockAction'
import type { CmsLockPreviewDto, CmsPayoutDto } from '@/lib/cms/payoutView'
import { canManageCms, canViewCmsAdmin } from '@/lib/cms/access'
import { cmsLoadProgramDetail } from '@/lib/cms/server/catalog'
import { cmsLoadEligibleStaffIds, cmsLoadResults, cmsLoadStoreNames } from '@/lib/cms/server/resultLoad'
import { cmsTodayVn } from '@/lib/cms/programStatus'
import { ErrorState } from '@/components/ds/ErrorState'
import { CmsProgramDetailView, type CmsDetailView } from '@/components/cms/admin/CmsProgramDetailView'
import { cmsBasisEnv, cmsProgramBasisFor } from '@/lib/cms/server/basisEnv'
import { getCmsCapabilityState } from '@/lib/cms/server/capabilities'
import { cmsReturnsPageEnabled } from '@/lib/cms/server/returnsLoad'
import { cmsRevisionEnabled, cmsRevisionReadable } from '@/lib/cms/server/revisionCaps'
import { cmsLoadRevisionState } from '@/lib/cms/server/revisionLoad'
import { cmsRevisionDetailLinks, type CmsRevisionDetailLinks } from '@/lib/cms/revision/model'

// CMS P1-c · A3 /targets/campaigns/cms/[id]. Cổng như A1 (cờ + super / SM). Chương trình ngoài phạm vi RLS (kể cả QA không
// marker — H9b) ⇒ 404 như không tồn tại. SM chỉ đọc. Lỗi truy vấn ⇒ ErrorState (không danh mục rỗng giả).
// P2-c (I3): cờ CMS_EARNINGS_ENABLED + chương trình active đã bắt đầu ⇒ kết quả qua RPC 122 (session: super toàn bộ, SM theo
// nhà thuốc được phân công) + mẫu số Q-212 + tên nhà thuốc; OFF / nháp / chưa bắt đầu ⇒ không gọi RPC (P1 nguyên trạng).
export default async function CmsProgramPage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ view?: string; page?: string }>
}) {
  const [{ id }, { view, page }] = await Promise.all([params, searchParams])
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(isCmsProgramEnabled() && canViewCmsAdmin(profile?.role, user.email))) notFound()
  const canManage = canManageCms(profile?.role, user.email)
  const res = await cmsLoadProgramDetail(id, { manage: canManage })
  if (!res.ok) {
    console.error('[cms-detail] query failed:', res.error)
    return (
      <div data-ui-v2="page" data-layout-width="fluid" className="p-4 md:p-6">
        <ErrorState message="Không tải được chương trình CMS" hint="Thử tải lại trang." />
      </div>
    )
  }
  if (!res.data) notFound()
  const today = cmsTodayVn(new Date())
  const prog = res.data.program
  // P3a: chương trình đã chốt vẫn đọc kết quả của run ĐÓNG BĂNG (run hiện hành, RPC 122) + số đã chốt.
  const results = prog.status === 'active' || prog.status === 'locked'
    ? await cmsLoadResults(prog.id, { started: prog.startDate <= today })
    : { kind: 'off' as const }
  const lockOn = isCmsLockEnabled()
  // Khối Chốt kỳ: chỉ super + cờ program/earnings/lock + chương trình active đã hết kỳ; preview qua lõi action (kiểm lại quyền,
  // namespace QA) — RPC 123 quyết blocker.
  let lock: { preview: CmsLockPreviewDto | null; error: string | null; qaReadonly: boolean } | null = null
  if (lockOn && canManage && prog.status === 'active' && prog.endDate < today) {
    const pv = await runCmsLockPreview(cmsLockDeps, prog.id)
    // Server QA (CMS_QA_SERVER) ⇒ khối chỉ đọc; server action vẫn từ chối trước RPC (PM r1 PKG-P1-2).
    lock = pv.ok ? { preview: pv.preview, error: null, qaReadonly: isCmsQaServer() } : { preview: null, error: pv.code, qaReadonly: isCmsQaServer() }
  }
  let payout: { data: CmsPayoutDto | null; error: string | null } | null = null
  if (lockOn && prog.status === 'locked') {
    const r = await cmsLoadPayout(prog.id)
    payout = r.ok ? { data: r.data, error: null } : { data: null, error: r.error }
  }
  let eligible: string[] | null = null
  let storeNames = new Map<string, string>()
  if (results.kind === 'loaded' && results.header.run) {
    const storeIds = [...results.rows.results.map((r) => r.storeId), ...results.rows.users.flatMap((u) => (u.storeId ? [u.storeId] : []))]
    ;[eligible, storeNames] = await Promise.all([
      cmsLoadEligibleStaffIds({ programStoreIds: res.data.storeIds, viewer: { id: user.id, role: profile?.role ?? null, isSuper: canManage } }),
      cmsLoadStoreNames(storeIds),
    ])
  }
  const v: CmsDetailView = view === 'runs' ? 'runs' : view === 'staff' ? 'staff' : 'products'
  const pageNum = Number(page)
  // Cách tính / chính sách trả: đọc SAU khi RLS đã cho thấy chương trình (service role chỉ đọc 3 cột cấu hình).
  const basisMap = await cmsProgramBasisFor(await cmsBasisEnv(), [prog.id])
  const basis = basisMap === undefined ? undefined : basisMap.get(prog.id) ?? null
  // P5.5: trang Trả hàng (đối soát + báo cáo sau chốt) — chỉ super, cờ đọc kết quả, DB có đường returns_ledger.
  const caps = canManage && cmsReturnsPageEnabled() ? await getCmsCapabilityState() : null
  const returnsHref = caps?.kind === 'ok' && caps.caps.paths.returns_ledger ? `/targets/campaigns/cms/${prog.id}/returns` : null
  // F-A: sửa có version. r3 (PM P1-02): tách cổng — ĐỌC (trạng thái che số + link Lịch sử sửa) = super + module CMS + DB 131, không phụ
  // thuộc cờ ghi; GHI (nút Sửa) = thêm cờ CMS_PROGRAM_REVISION_ENABLED. DB 130 ⇒ cả hai false, không gọi RPC 131. Trạng thái đọc bằng
  // session; lỗi đọc ⇒ vẫn hiện link Lịch sử sửa (trang lịch sử tự báo lỗi, không giả "chưa sửa").
  let revision: CmsRevisionDetailLinks | null = null
  if (canManage && (await cmsRevisionReadable())) {
    const [st, writable] = await Promise.all([cmsLoadRevisionState(prog.id), cmsRevisionEnabled()])
    revision = cmsRevisionDetailLinks({ programId: prog.id, status: prog.status, writable, state: st.ok ? { ok: true, data: st.data } : { ok: false } })
  }
  return (
    <CmsProgramDetailView detail={res.data} today={today} canManage={canManage} view={v} results={results}
      eligibleStaffIds={eligible} storeNames={storeNames} staffPage={Number.isInteger(pageNum) && pageNum > 0 ? pageNum : 1}
      lock={lock} payout={payout} basis={basis} returnsHref={returnsHref} revision={revision} />
  )
}
