// CMS — ai được vào màn quản trị CMS (A1 / A3) và ai được quản lý (tạo / sửa / import / kích hoạt). Cùng luật Chiến dịch
// KPI (lib/kpi/campaignAccess — một nguồn): xem = super admin + SM (H6, chỉ đọc, phạm vi do RLS 120); quản lý = super
// admin. Hàm này chỉ quyết định render / 404 — quyền thật ở server action / Route Handler + RPC + RLS.
import { canManageCampaign, canViewCampaignDashboard } from '@/lib/kpi/campaignAccess'

export function canViewCmsAdmin(role: string | null | undefined, email: string | null | undefined): boolean {
  return canViewCampaignDashboard(role, email)
}

export function canManageCms(role: string | null | undefined, email: string | null | undefined): boolean {
  return canManageCampaign(role, email)
}

// SM-CMS-ENTRY-1 (work order PM 11/11): nút "CMS sản phẩm" ở header landing /targets của SM — bổ sung hẹp cho UI-NAV-D03
// (đường trong trang; Sidebar / BottomNav giữ nguyên). Chỉ SM; chỉ theo CMS_PROGRAM_ENABLED (caller truyền
// `isCmsProgramEnabled()`), KHÔNG theo earnings / Affiliate / CMS-UNIT; không query. Đây là quyết định HIỂN THỊ — quyền đọc
// thật vẫn do cổng trang A1 (canViewCmsAdmin + cờ) và RLS cms_readable_program_ids quyết định.
export const SM_CMS_ENTRY_HREF = '/targets/campaigns/cms'

export function smCmsEntryVisible(
  role: string | null | undefined,
  email: string | null | undefined,
  cmsProgramEnabled: boolean,
): boolean {
  return role === 'sm' && cmsProgramEnabled && canViewCmsAdmin(role, email)
}
