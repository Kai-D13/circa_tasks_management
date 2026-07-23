import { redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { getUnreadAnnouncementCount } from '@/app/actions/announcements'
import { getStaffPendingTaskCount } from '@/app/actions/tasks'
import { UserProvider } from '@/components/providers/UserProvider'
import { ThemeProvider } from '@/components/providers/ThemeProvider'
import { NotificationProvider } from '@/components/layout/NotificationProvider'
import { Sidebar } from '@/components/layout/Sidebar'
import { MobileHeader } from '@/components/layout/MobileHeader'
import { BottomNav } from '@/components/layout/BottomNav'
import { isKpiCampaignEnabled } from '@/lib/kpi/flags'
import { isReferralEnabled } from '@/lib/affiliate/flags'
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
  // Staff are mobile-only: skip rendering/hydrating the desktop Sidebar entirely
  // (it's display:none for them anyway) for a leaner shell. 100dvh avoids the
  // mobile address-bar resize jank.
  const isStaff = profile.role === 'staff'
  // Tasks-tab badge (OS staff only): head-count of the staff pending list, same
  // posture as the announcements badge — recomputed per navigation, no polling.
  const tasksPending = isStaff && !isFsStore ? await getStaffPendingTaskCount() : 0
  // KPI Campaign nav gate (server env) → passed to the client Sidebar as a prop
  // (avoids a NEXT_PUBLIC_ var; keeps the flag server-controlled).
  const kpiCampaignEnabled = isKpiCampaignEnabled()
  const referralEnabled = isReferralEnabled()

  return (
    <ThemeProvider>
      <UserProvider profile={profile as UserProfile}>
        <NotificationProvider>
        <div className="flex h-[100dvh] overflow-hidden">
          {/* Desktop sidebar — hidden on mobile; not rendered for staff */}
          {/* Staff get no desktop Sidebar. An FS store_manager DOES get one → pass
              isFsStore so it collapses to the single FS item (no OS links). */}
          {!isStaff && <Sidebar announcementsUnread={announcementsUnread} kpiCampaignEnabled={kpiCampaignEnabled} referralEnabled={referralEnabled} isFsStore={isFsStore} />}

          {/* Main content — full width on mobile */}
          {/* Mobile bottom padding clears the fixed BottomNav (h-16) + the iPhone
              home-indicator safe area + a little breathing room, so the last card /
              Staff pager is never hidden behind the nav. Desktop has no bottom nav. */}
          <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden bg-muted/20 pb-[calc(5.5rem_+_env(safe-area-inset-bottom))] md:pb-0">
            {/* Mobile top header */}
            <MobileHeader />
            {children}
          </main>
        </div>

        {/* Bottom navigation — mobile only */}
        <BottomNav announcementsUnread={announcementsUnread} tasksPending={tasksPending} isFsStore={isFsStore} />
        </NotificationProvider>
      </UserProvider>
    </ThemeProvider>
  )
}
