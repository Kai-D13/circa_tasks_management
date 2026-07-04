'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useUserStore } from '@/store/userStore'
import {
  LayoutDashboard, CheckSquare, Users, Store, FileImage, ScrollText,
  TrendingUp, Megaphone, Boxes, MoreHorizontal,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isSuperAdmin } from '@/lib/authz'
import { CYCLE_COUNT_DEPT_ID } from '@/lib/inventory/constants'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

interface NavItem { href: string; label: string; icon: LucideIcon; roles: string[] }

const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard',     label: 'Tổng quan', icon: LayoutDashboard, roles: ['admin', 'store_manager'] },
  { href: '/tasks',         label: 'Tasks',      icon: CheckSquare,     roles: ['admin', 'store_manager', 'staff'] },
  { href: '/targets',       label: 'Doanh số',  icon: TrendingUp,      roles: ['staff'] },
  { href: '/prescriptions', label: 'Toa thuốc', icon: FileImage,       roles: ['admin', 'store_manager', 'staff'] },
  { href: '/announcements', label: 'Bảng tin',  icon: Megaphone,       roles: ['store_manager', 'staff'] },
  // Store manager reaches Doanh số (campaign view) via the "Thêm" drawer —
  // placed AFTER the primary four so neither staff's nor SM's main tabs shift.
  { href: '/targets',       label: 'Doanh số',  icon: TrendingUp,      roles: ['store_manager'] },
  { href: '/users',         label: 'Users',      icon: Users,           roles: ['admin'] },
  { href: '/stores',        label: 'Cửa hàng',  icon: Store,           roles: ['admin', 'store_manager'] },
  { href: '/logs',          label: 'Nhật ký',   icon: ScrollText,      roles: ['admin', 'store_manager'] },
]

const MAX_PRIMARY = 4

export function BottomNav({ announcementsUnread = 0 }: { announcementsUnread?: number }) {
  const pathname = usePathname()
  const profile  = useUserStore((s) => s.profile)
  const role     = profile?.role
  const [moreOpen, setMoreOpen] = useState(false)

  const visible = role ? NAV_ITEMS.filter((item) => item.roles.includes(role)) : []

  // Inventory (→ TRF) in the overflow: staff/store_manager (own store) + super /
  // Cycle Count admin. Not the multi-store sm role (phase 1).
  const showInventory = role === 'staff' || role === 'store_manager'
    || (role === 'admin' && (isSuperAdmin(profile?.email, role) || profile?.department_id === CYCLE_COUNT_DEPT_ID))
  const extra: NavItem[] = showInventory
    ? [{ href: '/inventory', label: 'Inventory', icon: Boxes, roles: [] }]
    : []

  const needsMore = visible.length > MAX_PRIMARY || extra.length > 0
  const primary = needsMore ? visible.slice(0, MAX_PRIMARY) : visible
  const drawerItems = needsMore ? [...visible.slice(MAX_PRIMARY), ...extra] : []
  const moreActive = drawerItems.some((i) => pathname === i.href || pathname.startsWith(i.href + '/') || pathname.startsWith(i.href))

  function NavBtn({ item, onClick }: { item: NavItem; onClick?: () => void }) {
    const Icon = item.icon
    const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href))
    return (
      <Link
        href={item.href}
        prefetch={false}
        onClick={onClick}
        className={cn(
          'relative flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors',
          isActive ? 'text-primary' : 'text-sidebar-foreground/50 active:text-sidebar-foreground',
        )}
      >
        <span className="relative">
          <Icon className="h-6 w-6" />
          {item.href === '/announcements' && announcementsUnread > 0 && (
            <span className="absolute -top-1.5 -right-2 min-w-4 h-4 px-1 rounded-full bg-primary text-white text-[9px] font-semibold flex items-center justify-center">
              {announcementsUnread > 9 ? '9+' : announcementsUnread}
            </span>
          )}
        </span>
        <span className="text-[10px] font-medium">{item.label}</span>
      </Link>
    )
  }

  return (
    <>
      <nav
        className="fixed bottom-0 left-0 right-0 z-40 bg-sidebar border-t border-sidebar-border md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center justify-around h-16">
          {primary.map((item) => <NavBtn key={item.href} item={item} />)}
          {needsMore && (
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              className={cn(
                'flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors',
                moreActive ? 'text-primary' : 'text-sidebar-foreground/50 active:text-sidebar-foreground',
              )}
            >
              <MoreHorizontal className="h-6 w-6" />
              <span className="text-[10px] font-medium">Thêm</span>
            </button>
          )}
        </div>
      </nav>

      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogContent
          showCloseButton={false}
          className="top-auto bottom-0 left-0 right-0 max-w-full translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl pb-[calc(1rem_+_env(safe-area-inset-bottom))] md:hidden"
        >
          <DialogTitle>Thêm</DialogTitle>
          <div className="grid grid-cols-3 gap-2">
            {drawerItems.map((item) => {
              const Icon = item.icon
              const isActive = pathname === item.href || pathname.startsWith(item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch={false}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    'flex flex-col items-center justify-center gap-1.5 rounded-lg border p-3 transition-colors',
                    isActive ? 'border-primary text-primary bg-primary/5' : 'text-foreground hover:bg-muted/40',
                  )}
                >
                  <Icon className="h-6 w-6" />
                  <span className="text-xs font-medium">{item.label}</span>
                </Link>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
