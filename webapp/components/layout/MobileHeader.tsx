'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useUserStore } from '@/store/userStore'
import { useTheme } from '@/components/providers/ThemeProvider'
import { NotificationBell } from '@/components/layout/NotificationBell'
import { Button } from '@/components/ui/button'
import { LogOut, Sun, Moon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const ROLE_COLORS: Record<string, string> = {
  admin:         'bg-orange-100 text-orange-700',
  store_manager: 'bg-blue-100 text-blue-700',
  staff:         'bg-green-100 text-green-700',
}
const ROLE_LABELS: Record<string, string> = {
  admin:         'Admin',
  store_manager: 'Quản lý',
  staff:         'Nhân viên',
}

export function MobileHeader() {
  const supabase = useMemo(() => createClient(), [])
  const router   = useRouter()
  const profile  = useUserStore((s) => s.profile)
  const role     = profile?.role
  const { theme, toggle } = useTheme()

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <header className="sticky top-0 z-30 bg-sidebar border-b border-sidebar-border flex items-center gap-2 px-4 h-14 md:hidden">
      {/* Logo + user info */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <div className="h-7 w-7 rounded-full bg-primary flex items-center justify-center shrink-0">
          <span className="text-[11px] font-bold text-primary-foreground">C</span>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-sidebar-foreground leading-tight truncate">
            {profile?.full_name ?? 'Circa Tasks'}
          </p>
          {role && (
            <Badge className={cn('text-[9px] px-1.5 py-0 h-4 leading-none', ROLE_COLORS[role])}>
              {ROLE_LABELS[role] ?? role}
            </Badge>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <NotificationBell />
        <Button variant="ghost" size="sm" className="w-9 h-9 px-0 text-sidebar-foreground/70" onClick={toggle}>
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <Button variant="ghost" size="sm" className="w-9 h-9 px-0 text-sidebar-foreground/70" onClick={handleLogout}>
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  )
}
