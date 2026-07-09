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
import { LogOut, ArrowLeft, ArrowLeftRight } from 'lucide-react'
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
  fs:            'Quản lý sản phẩm',
}

export function MobileHeader({ canSwitchSite = false }: { canSwitchSite?: boolean }) {
  const supabase = useMemo(() => createClient(), [])
  const router   = useRouter()
  const pathname = usePathname()
  const profile  = useUserStore((s) => s.profile)
  const role     = profile?.role

  const segments   = pathname.split('/').filter(Boolean)
  const section    = segments[0]
  const isSubPage  = segments.length > 1
  // The FS module root (/fs/products) is an FS user's home — no "back". Deeper FS
  // pages keep a back button (labelled "Quản lý sản phẩm").
  const isFsRoot   = section === 'fs' && segments.length <= 2
  const showBack   = isSubPage && !isFsRoot
  const parentTitle = SECTION_TITLES[section] ?? 'Quay lại'

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <header className="sticky top-0 z-30 bg-primary flex items-center gap-2 px-4 h-14 md:hidden">

      {showBack ? (
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
      ) : section === 'fs' ? (
        /* FS module root — clean module title, no back (it's the FS home). */
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="h-8 w-8 rounded-full bg-white/20 flex items-center justify-center shrink-0">
            <span className="text-xs font-bold text-white">C</span>
          </div>
          <p className="text-sm font-semibold text-white leading-tight truncate min-w-0">Quản lý sản phẩm</p>
        </div>
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
        {canSwitchSite && (
          <Button variant="ghost" size="sm" aria-label="Đổi site" className="w-10 h-10 px-0 text-white/80 hover:bg-white/10 hover:text-white" onClick={() => router.push('/select-site')}>
            <ArrowLeftRight className="h-4 w-4" />
          </Button>
        )}
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
