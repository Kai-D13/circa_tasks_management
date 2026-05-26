'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useUserStore } from '@/store/userStore'
import { NotificationBell } from '@/components/layout/NotificationBell'
import { Button } from '@/components/ui/button'
import { LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'

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

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <header className="sticky top-0 z-30 bg-primary flex items-center gap-2 px-4 h-[46px] md:hidden">
      {/* Logo + user info */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <div className="h-7 w-7 rounded-full bg-white/20 flex items-center justify-center shrink-0">
          <span className="text-[11px] font-bold text-white">C</span>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-white leading-tight truncate">
            {profile?.full_name ?? 'Circa Tasks'}
          </p>
          {role && (
            <span className={cn('text-[9px] leading-none text-white/70')}>
              {ROLE_LABELS[role] ?? role}
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <NotificationBell />
        <Button variant="ghost" size="sm" className="w-9 h-9 px-0 text-white/80 hover:bg-white/10 hover:text-white" onClick={handleLogout}>
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  )
}
