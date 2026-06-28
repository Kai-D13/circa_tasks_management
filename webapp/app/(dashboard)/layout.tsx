import { redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { getUnreadAnnouncementCount } from '@/app/actions/announcements'
import { UserProvider } from '@/components/providers/UserProvider'
import { ThemeProvider } from '@/components/providers/ThemeProvider'
import { NotificationProvider } from '@/components/layout/NotificationProvider'
import { Sidebar } from '@/components/layout/Sidebar'
import { MobileHeader } from '@/components/layout/MobileHeader'
import { BottomNav } from '@/components/layout/BottomNav'
import { UserProfile } from '@/types'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { user, profile } = await getSessionProfile()

  if (!user) redirect('/login')
  if (!profile) redirect('/login')

  // Bảng tin unread badge — viewers only (admins are creators, no badge). No
  // realtime: recomputed each navigation (server render), 2 light queries.
  const announcementsUnread = profile.role !== 'admin' ? await getUnreadAnnouncementCount() : 0
  // Staff are mobile-only: skip rendering/hydrating the desktop Sidebar entirely
  // (it's display:none for them anyway) for a leaner shell. 100dvh avoids the
  // mobile address-bar resize jank.
  const isStaff = profile.role === 'staff'

  return (
    <ThemeProvider>
      <UserProvider profile={profile as UserProfile}>
        <NotificationProvider>
        <div className="flex h-[100dvh] overflow-hidden">
          {/* Desktop sidebar — hidden on mobile; not rendered for staff */}
          {!isStaff && <Sidebar announcementsUnread={announcementsUnread} />}

          {/* Main content — full width on mobile */}
          {/* Mobile bottom padding clears the fixed BottomNav (h-16) + the iPhone
              home-indicator safe area + a little breathing room, so the last card /
              Staff pager is never hidden behind the nav. Desktop has no bottom nav. */}
          <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden bg-muted/20 pb-[calc(4rem_+_env(safe-area-inset-bottom)_+_1rem)] md:pb-0">
            {/* Mobile top header */}
            <MobileHeader />
            {children}
          </main>
        </div>

        {/* Bottom navigation — mobile only */}
        <BottomNav announcementsUnread={announcementsUnread} />
        </NotificationProvider>
      </UserProvider>
    </ThemeProvider>
  )
}
