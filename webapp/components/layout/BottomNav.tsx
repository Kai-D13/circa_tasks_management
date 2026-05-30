'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useUserStore } from '@/store/userStore'
import { LayoutDashboard, CheckSquare, Users, Store, FileImage, ScrollText } from 'lucide-react'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { href: '/dashboard',     label: 'Tổng quan', icon: LayoutDashboard, roles: ['admin', 'store_manager', 'staff'] },
  { href: '/tasks',         label: 'Tasks',      icon: CheckSquare,     roles: ['admin', 'store_manager', 'staff'] },
  { href: '/prescriptions', label: 'Toa thuốc', icon: FileImage,       roles: ['admin', 'store_manager', 'staff'] },
  { href: '/users',         label: 'Users',      icon: Users,           roles: ['admin'] },
  { href: '/stores',        label: 'Cửa hàng',  icon: Store,           roles: ['admin', 'store_manager'] },
  { href: '/logs',          label: 'Nhật ký',   icon: ScrollText,      roles: ['admin', 'store_manager', 'staff'] },
]

export function BottomNav() {
  const pathname = usePathname()
  const profile  = useUserStore((s) => s.profile)
  const role     = profile?.role

  const visible = role ? NAV_ITEMS.filter((item) => item.roles.includes(role)) : []

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-sidebar border-t border-sidebar-border md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-center justify-around h-14">
        {visible.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors',
                isActive
                  ? 'text-primary'
                  : 'text-sidebar-foreground/50 active:text-sidebar-foreground'
              )}
            >
              <Icon className="h-5 w-5" />
              <span className="text-[10px] font-medium">{label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
