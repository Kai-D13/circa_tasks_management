import { notFound } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isCmsProgramEnabled } from '@/lib/cms/flags'
import { isKpiAffiliateEnabled } from '@/lib/kpi/flags'
import { canManageCms, canViewCmsAdmin } from '@/lib/cms/access'
import { cmsLoadAdminList } from '@/lib/cms/server/catalog'
import { cmsTodayVn } from '@/lib/cms/programStatus'
import { cmsBuildListModel, cmsParseListFilter } from '@/lib/cms/programList'
import { CmsProgramListView } from '@/components/cms/admin/CmsProgramListView'

// CMS P1-c · A1 /targets/campaigns/cms. Cổng: cờ CMS_PROGRAM_ENABLED + super admin hoặc SM (chỉ đọc) — khác ⇒ 404.
// Phạm vi dữ liệu do RLS 120 (session client): SM chỉ active có nhà thuốc phân công; QA chỉ với marker (H9b).
// Trang giữ cổng + truy vấn; model ở lib/cms/programList (dùng chung fixture); trình bày ở CmsProgramListView.

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
    />
  )
}
