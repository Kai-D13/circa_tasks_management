'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useUserStore } from '@/store/userStore'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  LayoutDashboard,
  CheckSquare,
  CalendarClock,
  Users,
  Store,
  ScrollText,
  FileImage,
  TrendingUp,
  Gift,
  Megaphone,
  Boxes,
  ClipboardCheck,
  ChevronRight,
  LogOut,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { isSuperAdmin } from '@/lib/authz'
import { CYCLE_COUNT_DEPT_ID } from '@/lib/inventory/constants'
import { NotificationBell } from '@/components/layout/NotificationBell'
import { ChangePasswordDialog } from '@/components/layout/ChangePasswordDialog'
import { EditProfileDialog } from '@/components/layout/EditProfileDialog'
import { ThemeToggle } from '@/components/layout/ThemeToggle'

const ROLE_COLORS: Record<string, string> = {
  admin:         'bg-orange-100 text-orange-700',
  store_manager: 'bg-blue-100 text-blue-700',
  staff:         'bg-green-100 text-green-700',
  sm:            'bg-purple-100 text-purple-700',
}

const ROLE_LABELS: Record<string, string> = {
  admin:         'Admin',
  store_manager: 'Quản lý',
  staff:         'Nhân viên',
  sm:            'SM',
}

export function Sidebar({ announcementsUnread = 0, kpiCampaignEnabled = false }: { announcementsUnread?: number; kpiCampaignEnabled?: boolean }) {
  const pathname = usePathname()
  const router   = useRouter()
  const profile  = useUserStore((s) => s.profile)
  const role     = profile?.role

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  // prefetch=false on data-heavy routes so hovering the sidebar doesn't silently
  // fetch large RSC payloads in the background. First-click latency is negligible
  // since these are server-rendered with a fast DB query.
  const navItems = [
    { href: '/dashboard',        label: 'Tổng quan',   icon: LayoutDashboard, roles: ['admin', 'store_manager', 'sm'],        prefetch: false },
    { href: '/tasks',            label: 'Tasks',        icon: CheckSquare,     roles: ['admin', 'store_manager', 'staff', 'sm'], prefetch: false },
    { href: '/targets',          label: 'Doanh số',     icon: TrendingUp,      roles: ['staff', 'store_manager'],                prefetch: false },
    { href: '/tasks/schedules',  label: 'Định kỳ',     icon: CalendarClock,   roles: ['admin'],                                 prefetch: false },
    { href: '/users',            label: 'Người dùng',   icon: Users,           roles: ['admin', 'sm'],                           prefetch: false },
    { href: '/stores',           label: 'Cửa hàng',     icon: Store,           roles: ['admin', 'store_manager', 'sm'],          prefetch: false },
    { href: '/prescriptions',    label: 'Toa thuốc',    icon: FileImage,       roles: ['admin', 'store_manager', 'staff'],       prefetch: false },
    { href: '/announcements',    label: 'Bảng tin',     icon: Megaphone,       roles: ['admin', 'store_manager', 'staff', 'sm'], prefetch: false },
    { href: '/gioi-thieu',       label: 'Giới thiệu',   icon: Gift,            roles: ['admin'],                                 prefetch: false, superAdmin: true },
    { href: '/logs',             label: 'Nhật ký',      icon: ScrollText,      roles: ['admin', 'store_manager', 'sm'], prefetch: false },
  ]

  const isSuper = isSuperAdmin(profile?.email, role)
  const visibleItems = role
    ? navItems.filter((item) => item.roles.includes(role) && (!('superAdmin' in item && item.superAdmin) || isSuper))
    : []

  // Inventory accordion (→ TRF): super, Cycle Count admin, or store manager.
  // Non-Cycle-Count admins and the multi-store sm role do NOT see it (phase 1).
  const showInventory = isSuper
    || (role === 'admin' && profile?.department_id === CYCLE_COUNT_DEPT_ID)
    || role === 'store_manager'
  const [invOpen, setInvOpen] = useState(() => pathname.startsWith('/inventory'))

  // KPI (→ Chiến dịch): super admin only, gated by the feature flag. Single flat
  // link now that the old all-stores Doanh số (/targets) is hidden from super admin.
  const showKpi = isSuper && kpiCampaignEnabled

  return (
    <aside className="hidden md:flex h-screen w-[210px] flex-col border-r bg-sidebar">
      {/* Logo / Brand — orange header bar */}
      <div className="flex h-[46px] items-center gap-2 px-4 bg-primary shrink-0">
        <div className="h-6 w-6 rounded-full bg-white/20 flex items-center justify-center shrink-0">
          <span className="text-[10px] font-bold text-white">C</span>
        </div>
        <span className="font-semibold text-sm tracking-tight text-white">
          Circa Tasks
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {visibleItems.map(({ href, label, icon: Icon, prefetch }) => (
          <Link
            key={href}
            href={href}
            prefetch={prefetch}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
                ? 'bg-sidebar-accent text-primary font-medium'
                : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-primary/80'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1">{label}</span>
            {href === '/announcements' && announcementsUnread > 0 && (
              <span className="ml-auto min-w-5 h-5 px-1 rounded-full bg-primary text-white text-[10px] font-semibold flex items-center justify-center">
                {announcementsUnread > 99 ? '99+' : announcementsUnread}
              </span>
            )}
          </Link>
        ))}

        {/* Inventory — collapsible parent → submodules (TRF) */}
        {showInventory && (
          <div>
            <button
              type="button"
              onClick={() => setInvOpen((o) => !o)}
              className={cn(
                'w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                pathname.startsWith('/inventory')
                  ? 'bg-sidebar-accent text-primary font-medium'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-primary/80',
              )}
            >
              <Boxes className="h-4 w-4 shrink-0" />
              <span className="flex-1 text-left">Inventory</span>
              <ChevronRight className={cn('h-4 w-4 transition-transform', invOpen && 'rotate-90')} />
            </button>
            {invOpen && (
              <div className="mt-0.5 space-y-0.5 pl-4">
                <Link
                  href="/inventory/trf"
                  prefetch={false}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                    pathname.startsWith('/inventory/trf')
                      ? 'bg-sidebar-accent text-primary font-medium'
                      : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-primary/80',
                  )}
                >
                  <ClipboardCheck className="h-4 w-4 shrink-0" />
                  <span className="flex-1">TRF</span>
                </Link>
              </div>
            )}
          </div>
        )}

        {/* KPI — super admin only (flag on). The old all-stores "Doanh số"
            (/targets) is hidden now that campaigns own KPI; this is a single
            flat link straight to campaign management (accordion no longer needed). */}
        {showKpi && (
          <Link
            href="/targets/campaigns"
            prefetch={false}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              pathname.startsWith('/targets/campaigns')
                ? 'bg-sidebar-accent text-primary font-medium'
                : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-primary/80',
            )}
          >
            <Megaphone className="h-4 w-4 shrink-0" />
            <span className="flex-1">Chiến dịch KPI</span>
          </Link>
        )}
      </nav>

      {/* User info + controls */}
      <div className="border-t border-sidebar-border p-3 space-y-2.5">
        <Separator className="bg-sidebar-border" />
        <div className="flex items-center gap-2 px-1">
          <Avatar className="h-7 w-7">
            <AvatarFallback className="text-xs bg-primary text-primary-foreground">
              {profile?.full_name?.charAt(0)?.toUpperCase() ?? '?'}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 overflow-hidden">
            <p className="text-xs font-medium truncate text-sidebar-foreground">{profile?.full_name}</p>
            <p className="text-xs truncate text-sidebar-foreground/50">{profile?.email}</p>
          </div>
        </div>
        {role && (
          <Badge className={cn('text-xs w-full justify-center', ROLE_COLORS[role])}>
            {ROLE_LABELS[role] ?? role}
          </Badge>
        )}
        {role === 'staff' && <EditProfileDialog />}
        <ChangePasswordDialog />
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 justify-start gap-2 text-xs"
            onClick={handleLogout}
          >
            <LogOut className="h-3.5 w-3.5" />
            Đăng xuất
          </Button>
          {role !== 'staff' && <NotificationBell />}
          <ThemeToggle />
        </div>
      </div>
    </aside>
  )
}
