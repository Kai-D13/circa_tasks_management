import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { UserProvider } from '@/components/providers/UserProvider'
import { ThemeProvider } from '@/components/providers/ThemeProvider'
import { Sidebar } from '@/components/layout/Sidebar'
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
        <div className="flex h-screen overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-y-auto bg-muted/20">
            {children}
          </main>
        </div>
      </UserProvider>
    </ThemeProvider>
  )
}
