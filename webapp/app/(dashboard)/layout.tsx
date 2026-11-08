import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { getUnreadAnnouncementCount } from '@/app/actions/announcements'
import { getStaffPendingTaskCount } from '@/app/actions/tasks'
import { DashboardShell } from '@/components/layout/DashboardShell'
import { isKpiCampaignEnabled, isKpiAffiliateEnabled } from '@/lib/kpi/flags'
import { careNavItems } from '@/lib/care/browse'
import { getCareNavPermissions } from '@/lib/care/server/browse'
import { isCareEnabled } from '@/lib/care/flags'
import { isReferralEnabled } from '@/lib/affiliate/flags'
import { isSuperAdminEmail } from '@/lib/authz'
import { opsSidebarVisible } from '@/lib/affiliate/overview'
import { campaignNavForViewer } from '@/lib/layout/campaignNavServer'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { UserProfile } from '@/types'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { user, profile } = await getSessionProfile()

  if (!user) redirect('/login')
  if (!profile) redirect('/login')

  // An FS-store user (staff or store_manager whose store is FS) sees ONLY the FS
  // module — the store is already embedded by getSessionProfile, so this is
  // query-free. (Only staff operate; store_manager is contained to a no-access
  // notice, never the OS app.)
  const embeddedStore = (profile as { stores?: { store_type?: string | null } | { store_type?: string | null }[] | null }).stores
  const store = Array.isArray(embeddedStore) ? embeddedStore[0] : embeddedStore
  const isFsStore = (profile.role === 'staff' || profile.role === 'store_manager') && store?.store_type === 'fs'

  // Bảng tin unread badge — viewers only (admins are creators, no badge). No
  // realtime: recomputed each navigation (server render), 2 light queries. Skipped
  // for FS-store users (they never see the announcements tab).
  const announcementsUnread = profile.role !== 'admin' && !isFsStore ? await getUnreadAnnouncementCount() : 0
  // Staff are mobile-only (no desktop Sidebar — xem DashboardShell).
  const isStaff = profile.role === 'staff'
  // Tasks-tab badge (OS staff only): head-count of the staff pending list, same
  // posture as the announcements badge — recomputed per navigation, no polling.
  const tasksPending = isStaff && !isFsStore ? await getStaffPendingTaskCount() : 0
  // KPI Campaign flag (server env) — gate của mục Affiliate admin phòng bên dưới; nhóm Sidebar "Chiến dịch" tính ở
  // campaignNavForViewer (cùng cờ, server-controlled, không NEXT_PUBLIC).
  const kpiCampaignEnabled = isKpiCampaignEnabled()
  const referralEnabled = isReferralEnabled()
  // P3-I.2 r1.2a: item sidebar "Affiliate" cho admin PHÒNG ĐƯỢC CẤP QUYỀN
  // (affiliate_department_access — grant 096; RLS bảng này super-only nên đọc
  // bằng admin client, 1 PK lookup chỉ khi role=admin non-super có department).
  // opsSidebarVisible vẫn loại super (helper quyền / phòng giữ nguyên, có test); từ UI-NAV super nhận mục Affiliate qua nhánh
  // super trong campaignNav (cùng cờ KPI + Affiliate) — không mở Affiliate cho admin thường. Route tự re-verify.
  const affiliateNavCandidate = isKpiAffiliateEnabled() && kpiCampaignEnabled
    && profile.role === 'admin' && !isSuperAdminEmail(user.email) && !!profile.department_id
  // Sidebar thu gọn: đọc cookie ngay ở server (layout đã dynamic vì auth) rồi
  // truyền xuống làm state khởi tạo — HTML đầu tiên render đúng bề rộng, không
  // nháy layout và không hydration mismatch. Cookie chặn/thiếu → mặc định mở rộng.
  // CRM-CSKH (B3): mục sidebar "Chăm sóc KH" — chỉ khi CARE_ENABLED và role có thể
  // dùng browser; quyền thật từ care_my_access() (lỗi/DB chưa có 114 ⇒ ẩn, không vỡ layout).
  const careNav = !isStaff && !isFsStore ? careNavItems(await getCareNavPermissions(profile.role)) : []
  const cookieStore = await cookies()
  const sidebarCollapsed = cookieStore.get('sidebar_collapsed')?.value === '1'
  const affiliateOverviewNav = opsSidebarVisible({
    flagEnabled: isKpiAffiliateEnabled() && kpiCampaignEnabled,
    role: profile.role,
    isSuper: isSuperAdminEmail(user.email) && profile.role === 'admin',
    isDeptAdmin: affiliateNavCandidate
      ? !!(await supabaseAdmin
          .from('affiliate_department_access')
          .select('department_id')
          .eq('department_id', profile.department_id!)
          .maybeSingle()).data
      : false,
  })
  // UI-NAV U1: nhóm Sidebar "Chiến dịch" (KPI · Affiliate · CMS) — quyền ∩ cờ hiện có, không query thêm.
  const campaignNav = campaignNavForViewer({ role: profile.role, email: user.email, isFsStore, affiliateDeptAdmin: affiliateOverviewNav })

  // UI-NAV r1: phần trình bày (Sidebar + <main> + BottomNav) ở DashboardShell — dùng chung với fixture /ui-catalog-shell/nav.
  return (
    <DashboardShell
      profile={profile as UserProfile}
      isFsStore={isFsStore}
      announcementsUnread={announcementsUnread}
      tasksPending={tasksPending}
      referralEnabled={referralEnabled}
      campaignNav={campaignNav}
      sidebarCollapsed={sidebarCollapsed}
      careNav={careNav}
      careEnabled={isCareEnabled()}
    >
      {children}
    </DashboardShell>
  )
}
