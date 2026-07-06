'use client'

import { useMemo } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useUserStore } from '@/store/userStore'
import { NotificationBell } from '@/components/layout/NotificationBell'
import { ChangePasswordDialog } from '@/components/layout/ChangePasswordDialog'
import { EditProfileDialog } from '@/components/layout/EditProfileDialog'
import { ThemeToggle } from '@/components/layout/ThemeToggle'
import { Button } from '@/components/ui/button'
import { LogOut, ArrowLeft } from 'lucide-react'
const SECTION_TITLES: Record<string, string> = {
  dashboard:     'Tổng quan',
  tasks:         'Tasks',
  targets:       'Doanh số',
  prescriptions: 'Toa thuốc',
  announcements: 'Bảng tin',
  inventory:     'Tồn kho',
  users:         'Người dùng',
  stores:        'Cửa hàng',
  logs:          'Nhật ký',
}

export function MobileHeader() {
  const supabase = useMemo(() => createClient(), [])
  const router   = useRouter()
  const pathname = usePathname()
  const profile  = useUserStore((s) => s.profile)
  const role     = profile?.role

  const segments   = pathname.split('/').filter(Boolean)
  const isSubPage  = segments.length > 1
  const parentTitle = SECTION_TITLES[segments[0]] ?? 'Quay lại'

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <header className="sticky top-0 z-30 bg-primary flex items-center gap-2 px-4 h-14 md:hidden">

      {isSubPage ? (
        /* Sub-page: back button + section title */
        <>
          <Button
            variant="ghost"
            size="sm"
            className="w-10 h-10 px-0 text-white hover:bg-white/10 shrink-0"
            onClick={() => router.back()}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <span className="flex-1 text-sm font-semibold text-white truncate">
            {parentTitle}
          </span>
        </>
      ) : (
        /* Top-level: logo + name (role label dropped for a cleaner compact header) */
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="h-8 w-8 rounded-full bg-white/20 flex items-center justify-center shrink-0">
            <span className="text-xs font-bold text-white">C</span>
          </div>
          <p className="text-sm font-semibold text-white leading-tight truncate min-w-0">
            {profile?.full_name ?? 'Circa Tasks'}
          </p>
        </div>
      )}

      {/* Actions — always visible */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Staff don't receive notifications (provider skips their fetch), so the bell
            is dead weight for them — hide it. */}
        {role !== 'staff' && <NotificationBell />}
        {role === 'staff' && <EditProfileDialog variant="mobile" />}
        <ChangePasswordDialog variant="mobile" />
        <ThemeToggle className="w-10 h-10 px-0 text-white/80 hover:bg-white/10 hover:text-white" />
        <Button
          variant="ghost"
          size="sm"
          className="w-10 h-10 px-0 text-white/80 hover:bg-white/10 hover:text-white"
          onClick={handleLogout}
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  )
}
