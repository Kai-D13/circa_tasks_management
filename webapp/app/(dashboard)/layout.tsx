import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { UserProvider } from '@/components/providers/UserProvider'
import { ThemeProvider } from '@/components/providers/ThemeProvider'
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

  let user
  try {
    const { data, error } = await supabase.auth.getUser()
    if (error || !data.user) redirect('/login')
    user = data.user
  } catch (e: unknown) {
    // Re-throw Next.js redirect/not-found signals
    if (typeof e === 'object' && e !== null && 'digest' in e) throw e
    redirect('/login')
  }

  let profile: UserProfile | null = null
  try {
    const { data } = await supabase
      .from('users')
      .select('*, stores(*)')
      .eq('id', user!.id)
      .single()
    profile = data as UserProfile | null
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && 'digest' in e) throw e
    redirect('/login')
  }

  if (!profile) redirect('/login')

  return (
    <ThemeProvider>
      <UserProvider profile={profile as UserProfile}>
        <div className="flex h-screen overflow-hidden">
          {/* Sidebar — desktop only (hidden on mobile) */}
          <Sidebar />

          {/* Main content */}
          <main className="flex-1 overflow-y-auto bg-muted/20 pb-16 md:pb-0">
            {/* Mobile top header */}
            <MobileHeader />
            {children}
          </main>
        </div>

        {/* Bottom navigation — mobile only */}
        <BottomNav />
      </UserProvider>
    </ThemeProvider>
  )
}
