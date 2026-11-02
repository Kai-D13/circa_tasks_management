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
