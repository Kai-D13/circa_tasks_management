'use client'

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
  Users,
  Store,
  ScrollText,
  LogOut,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { NotificationBell } from '@/components/layout/NotificationBell'

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

export function Sidebar() {
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

  const navItems = [
    { href: '/dashboard', label: 'Tổng quan',   icon: LayoutDashboard, roles: ['admin', 'store_manager', 'staff'] },
    { href: '/tasks',     label: 'Tasks',        icon: CheckSquare,     roles: ['admin', 'store_manager', 'staff'] },
    { href: '/users',     label: 'Người dùng',   icon: Users,           roles: ['admin'] },
    { href: '/stores',    label: 'Cửa hàng',     icon: Store,           roles: ['admin', 'store_manager'] },
    { href: '/logs',      label: 'Nhật ký',      icon: ScrollText,      roles: ['admin', 'store_manager', 'staff'] },
  ]

  const visibleItems = role
    ? navItems.filter((item) => item.roles.includes(role))
    : []

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
        {visibleItems.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
                ? 'bg-sidebar-accent text-primary font-medium'
                : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-primary/80'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </Link>
        ))}
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
          <NotificationBell />
        </div>
      </div>
    </aside>
  )
}
