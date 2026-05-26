import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users')
    .select('*, stores(*)')
    .eq('id', user.id)
    .single()

  if (!profile) redirect('/login')

  return (
    <ThemeProvider>
      <UserProvider profile={profile as UserProfile}>
        <NotificationProvider>
        <div className="flex h-screen overflow-hidden">
          {/* Desktop sidebar — hidden on mobile */}
          <Sidebar />

          {/* Main content — full width on mobile */}
          <main className="flex-1 min-w-0 overflow-y-auto bg-muted/20 pb-16 md:pb-0">
            {/* Mobile top header */}
            <MobileHeader />
            {children}
          </main>
        </div>

        {/* Bottom navigation — mobile only */}
        <BottomNav />
        </NotificationProvider>
      </UserProvider>
    </ThemeProvider>
  )
}
