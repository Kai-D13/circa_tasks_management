// UI-NAV U1 (PM spec planning/research/ui-nav-spec-implementation-2026-11-08.md §3.1) — mô hình TRÌNH BÀY của nhóm Sidebar
// "Chiến dịch" (Chiến dịch KPI · Affiliate · CMS sản phẩm). Hàm THUẦN: không query, không đọc credential / env. Đầu vào là các
// boolean server đã tính sẵn từ quyền + cờ hiện có (layout / page). Không cấp quyền mới: route tự kiểm quyền như trước.
// Cùng một hàm dùng cho Sidebar và cho việc quyết định hàng tab trong trang (CampaignsTabs) có được ẩn ở desktop hay không.

export type CampaignNavKey = 'kpi' | 'affiliate' | 'cms'
export interface CampaignNavItem { key: CampaignNavKey; label: string; href: string }

export const CAMPAIGN_NAV_GROUP_LABEL = 'Chiến dịch'
export const CAMPAIGN_NAV_ITEMS: Record<CampaignNavKey, CampaignNavItem> = {
  kpi: { key: 'kpi', label: 'Chiến dịch KPI', href: '/targets/campaigns' },
  affiliate: { key: 'affiliate', label: 'Affiliate', href: '/targets/campaigns/affiliate' },
  cms: { key: 'cms', label: 'CMS sản phẩm', href: '/targets/campaigns/cms' },
}

export interface CampaignNavInput {
  role: string | null | undefined
  /** role = admin VÀ email trong allowlist super (server: isSuperAdminEmail). */
  isSuper: boolean
  /** Người dùng thuộc cửa hàng FS ⇒ không có mục OS nào. */
  isFsStore: boolean
  /** KPI_CAMPAIGN_ENABLED */
  kpiCampaignEnabled: boolean
  /** KPI_AFFILIATE_ENABLED */
  kpiAffiliateEnabled: boolean
  /** CMS_PROGRAM_ENABLED */
  cmsProgramEnabled: boolean
  /** Kết quả `opsSidebarVisible` của layout (admin PHÒNG được cấp quyền Affiliate, không phải super, đã gồm cờ). */
  affiliateDeptAdmin: boolean
  /** `canViewCmsAdmin(role, email)` — với role admin chỉ super (SM cũng true nhưng SM không nhận nhóm Sidebar). */
  cmsAdminView: boolean
}

/**
 * Mục nhóm "Chiến dịch" theo thứ tự KPI → Affiliate → CMS, đã lọc theo quyền ∩ cờ. Chỉ role admin (SM / QLCH / staff / FS: rỗng).
 * - Chiến dịch KPI: super + KPI_CAMPAIGN_ENABLED.
 * - Affiliate: super + KPI_CAMPAIGN_ENABLED + KPI_AFFILIATE_ENABLED; hoặc admin phòng được cấp quyền (đã gồm cờ).
 * - CMS sản phẩm: admin + canViewCmsAdmin + CMS_PROGRAM_ENABLED — ĐỘC LẬP cờ KPI / Affiliate.
 */
export function campaignNavItems(p: CampaignNavInput): CampaignNavItem[] {
  if (p.role !== 'admin' || p.isFsStore) return []
  const out: CampaignNavItem[] = []
  if (p.isSuper && p.kpiCampaignEnabled) out.push(CAMPAIGN_NAV_ITEMS.kpi)
  if ((p.isSuper && p.kpiCampaignEnabled && p.kpiAffiliateEnabled) || (!p.isSuper && p.affiliateDeptAdmin)) out.push(CAMPAIGN_NAV_ITEMS.affiliate)
  if (p.cmsAdminView && p.cmsProgramEnabled) out.push(CAMPAIGN_NAV_ITEMS.cms)
  return out
}

/**
 * Hàng tab chuyển module trong trang (CampaignsTabs) có được ẩn ở desktop không: CHỈ khi người xem là admin và Sidebar đã có
 * ĐỦ mọi đích của hàng tab đó (tab "Chiến dịch" luôn có; Affiliate / CMS theo prop của trang). Thiếu một đích ⇒ giữ tabs.
 */
export function campaignTabsReplacedBySidebar(
  items: CampaignNavItem[],
  tabs: { affiliate: boolean; cms: boolean },
): boolean {
  if (items.length === 0) return false
  const has = (k: CampaignNavKey) => items.some((i) => i.key === k)
  return has('kpi') && (!tabs.affiliate || has('affiliate')) && (!tabs.cms || has('cms'))
}
