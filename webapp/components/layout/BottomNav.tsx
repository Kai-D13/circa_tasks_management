'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useUserStore } from '@/store/userStore'
import { LayoutDashboard, CheckSquare, Users, Store, FileImage, ScrollText, TrendingUp, Megaphone } from 'lucide-react'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { href: '/dashboard',     label: 'Tổng quan', icon: LayoutDashboard, roles: ['admin', 'store_manager'], prefetch: false },
  { href: '/tasks',         label: 'Tasks',      icon: CheckSquare,     roles: ['admin', 'store_manager', 'staff'], prefetch: false },
  { href: '/targets',       label: 'Doanh số',  icon: TrendingUp,      roles: ['staff'],                           prefetch: false },
  { href: '/prescriptions', label: 'Toa thuốc', icon: FileImage,       roles: ['admin', 'store_manager', 'staff'], prefetch: false },
  { href: '/announcements', label: 'Bảng tin',  icon: Megaphone,       roles: ['store_manager', 'staff'],          prefetch: false },
  { href: '/users',         label: 'Users',      icon: Users,           roles: ['admin'],                           prefetch: false },
  { href: '/stores',        label: 'Cửa hàng',  icon: Store,           roles: ['admin', 'store_manager'],          prefetch: false },
  { href: '/logs',          label: 'Nhật ký',   icon: ScrollText,      roles: ['admin', 'store_manager', 'staff'], prefetch: false },
]

export function BottomNav({ announcementsUnread = 0 }: { announcementsUnread?: number }) {
  const pathname = usePathname()
  const profile  = useUserStore((s) => s.profile)
  const role     = profile?.role

  const visible = role ? NAV_ITEMS.filter((item) => item.roles.includes(role)) : []

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-sidebar border-t border-sidebar-border md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-center justify-around h-16">
        {visible.map(({ href, label, icon: Icon, prefetch }) => {
          const isActive = pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
          return (
            <Link
              key={href}
              href={href}
              prefetch={prefetch}
              className={cn(
                'relative flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors',
                isActive
                  ? 'text-primary'
                  : 'text-sidebar-foreground/50 active:text-sidebar-foreground'
              )}
            >
              <span className="relative">
                <Icon className="h-6 w-6" />
                {href === '/announcements' && announcementsUnread > 0 && (
                  <span className="absolute -top-1.5 -right-2 min-w-4 h-4 px-1 rounded-full bg-primary text-white text-[9px] font-semibold flex items-center justify-center">
                    {announcementsUnread > 9 ? '9+' : announcementsUnread}
                  </span>
                )}
              </span>
              <span className="text-[10px] font-medium">{label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
