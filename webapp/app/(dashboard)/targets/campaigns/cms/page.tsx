import { notFound } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isCmsEarningsEnabled, isCmsProgramEnabled } from '@/lib/cms/flags'
import { isKpiAffiliateEnabled } from '@/lib/kpi/flags'
import { canManageCms, canViewCmsAdmin } from '@/lib/cms/access'
import { cmsLoadAdminList } from '@/lib/cms/server/catalog'
import { cmsLoadResults } from '@/lib/cms/server/resultLoad'
import { cmsA1LoadOrder, cmsA1Results, type CmsResultsLoad } from '@/lib/cms/resultUi'
import { cmsDisplayStatus, cmsTodayVn } from '@/lib/cms/programStatus'
import { cmsBuildListModel, cmsParseListFilter } from '@/lib/cms/programList'
import { CmsProgramListView } from '@/components/cms/admin/CmsProgramListView'

// CMS P1-c · A1 /targets/campaigns/cms. Cổng: cờ CMS_PROGRAM_ENABLED + super admin hoặc SM (chỉ đọc) — khác ⇒ 404.
// Phạm vi dữ liệu do RLS 120 (session client): SM chỉ active có nhà thuốc phân công; QA chỉ với marker (H9b).
// Trang giữ cổng + truy vấn; model ở lib/cms/programList (dùng chung fixture); trình bày ở CmsProgramListView.
// P2-c (I3): cờ CMS_EARNINGS_ENABLED ⇒ đọc kết quả (RPC 122, session — SM theo phạm vi) cho chương trình đang chạy / chờ chốt
// kỳ (tối đa CMS_A1_MAX chương trình / lượt xem, chương trình thật trước QA); vượt trần ⇒ ô tổng '—' + cảnh báo (không tổng
// thiếu); OFF ⇒ không gọi RPC, P1 nguyên trạng.
const CMS_A1_MAX = 30

export default async function CmsProgramsPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const { status: rawStatus, q: rawQ } = await searchParams
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(isCmsProgramEnabled() && canViewCmsAdmin(profile?.role, user.email))) notFound()
  const canManage = canManageCms(profile?.role, user.email)
  const today = cmsTodayVn(new Date())
  const filter = cmsParseListFilter(rawStatus, canManage)
  const q = (rawQ ?? '').trim().slice(0, 100)

  const res = await cmsLoadAdminList({ manage: canManage })
  if (!res.ok) console.error('[cms-list] query failed:', res.error)
  const m = cmsBuildListModel(res.ok ? res.data : [], { canManage, today, filter, q })
  let p2: ReturnType<typeof cmsA1Results> | null = null
  if (res.ok && isCmsEarningsEnabled()) {
    const targets = res.data.map((p) => ({ id: p.id, display: cmsDisplayStatus(p, today), isTest: p.isTest, productCount: p.productCount }))
      .filter((p) => p.display === 'running' || p.display === 'waiting_close')
    const loads = await Promise.all(cmsA1LoadOrder(targets, CMS_A1_MAX).map(async (p) => [p.id, await cmsLoadResults(p.id, { started: true })] as const))
    p2 = cmsA1Results(targets, new Map<string, CmsResultsLoad>(loads))
  }

  return (
    <CmsProgramListView
      canManage={canManage}
      affiliateEnabled={isKpiAffiliateEnabled()}
      today={today}
      filter={filter}
      q={q}
      counts={m.counts}
      rows={m.rows}
      hasAny={m.hasAny}
      stats={res.ok ? m.stats : null}
      error={res.ok ? null : 'Kiểm tra migration 120 / 121 đã chạy và thử lại.'}
      p2={p2}
    />
  )
}
