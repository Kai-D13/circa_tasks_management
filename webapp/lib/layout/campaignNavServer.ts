// UI-NAV U1 — vỏ SERVER của `campaignNav`: đọc cờ env (server-only, không NEXT_PUBLIC) + allowlist super, rồi gọi hàm thuần.
// Dùng chung cho layout (Sidebar) và ba trang danh sách (quyết định ẩn CampaignsTabs ở desktop) ⇒ một nguồn luật.
// Không query: `affiliateDeptAdmin` là kết quả kiểm phòng mà layout đã có (opsSidebarVisible); trang danh sách truyền false vì
// hàng tab chỉ render cho super / SM (admin phòng không có hàng tab).
import { isKpiAffiliateEnabled, isKpiCampaignEnabled } from '@/lib/kpi/flags'
import { isCmsProgramEnabled } from '@/lib/cms/flags'
import { isSuperAdminEmail } from '@/lib/authz'
import { canViewCmsAdmin } from '@/lib/cms/access'
import { campaignNavItems, campaignTabsReplacedBySidebar, type CampaignNavItem } from '@/lib/layout/campaignNav'

export function campaignNavForViewer(v: {
  role: string | null | undefined
  email: string | null | undefined
  isFsStore: boolean
  affiliateDeptAdmin: boolean
}): CampaignNavItem[] {
  return campaignNavItems({
    role: v.role,
    isSuper: v.role === 'admin' && isSuperAdminEmail(v.email),
    isFsStore: v.isFsStore,
    kpiCampaignEnabled: isKpiCampaignEnabled(),
    kpiAffiliateEnabled: isKpiAffiliateEnabled(),
    cmsProgramEnabled: isCmsProgramEnabled(),
    affiliateDeptAdmin: v.affiliateDeptAdmin,
    cmsAdminView: canViewCmsAdmin(v.role, v.email),
  })
}

/** Trang danh sách (KPI / Affiliate / CMS): hàng tab có được ẩn ở desktop không — chỉ khi Sidebar của người xem có đủ đích. */
export function campaignTabsDesktopReplaced(
  viewer: { role: string | null | undefined; email: string | null | undefined },
  tabs: { affiliate: boolean; cms: boolean },
): boolean {
  return campaignTabsReplacedBySidebar(campaignNavForViewer({ ...viewer, isFsStore: false, affiliateDeptAdmin: false }), tabs)
}
