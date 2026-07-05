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

// Staff get a FIXED 5-tab bar — their five core workflows, no "Thêm" drawer.
// The old pipeline overflowed Tồn kho into a drawer holding a single item
// (pure friction), and /inventory lit up "Thêm" instead of its own tab.
const STAFF_NAV: NavItem[] = [
  { href: '/tasks',         label: 'Tasks',     icon: CheckSquare, roles: [] },
  { href: '/targets',       label: 'Doanh số',  icon: TrendingUp,  roles: [] },
  { href: '/prescriptions', label: 'Toa thuốc', icon: FileImage,   roles: [] },
  { href: '/announcements', label: 'Bảng tin',  icon: Megaphone,   roles: [] },
  { href: '/inventory',     label: 'Tồn kho',   icon: Boxes,       roles: [] },
]

// Non-staff roles keep the role-filter + overflow-drawer pipeline.
const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard',     label: 'Tổng quan', icon: LayoutDashboard, roles: ['admin', 'store_manager'] },
  { href: '/tasks',         label: 'Tasks',      icon: CheckSquare,     roles: ['admin', 'store_manager'] },
  { href: '/prescriptions', label: 'Toa thuốc', icon: FileImage,       roles: ['admin', 'store_manager'] },
  { href: '/announcements', label: 'Bảng tin',  icon: Megaphone,       roles: ['store_manager'] },
  // Store manager reaches Doanh số (campaign view) via the "Thêm" drawer —
  // placed AFTER the primary four so SM's main tabs don't shift.
  { href: '/targets',       label: 'Doanh số',  icon: TrendingUp,      roles: ['store_manager'] },
  { href: '/users',         label: 'Users',      icon: Users,           roles: ['admin'] },
  { href: '/stores',        label: 'Cửa hàng',  icon: Store,           roles: ['admin', 'store_manager'] },
  { href: '/logs',          label: 'Nhật ký',   icon: ScrollText,      roles: ['admin', 'store_manager'] },
]

const MAX_PRIMARY = 4

export function BottomNav({
  announcementsUnread = 0,
  tasksPending = 0,
}: {
  announcementsUnread?: number
  tasksPending?: number
}) {
  const pathname = usePathname()
  const profile  = useUserStore((s) => s.profile)
  const role     = profile?.role
  const [moreOpen, setMoreOpen] = useState(false)

  const isStaffNav = role === 'staff'
  const visible = isStaffNav ? STAFF_NAV : role ? NAV_ITEMS.filter((item) => item.roles.includes(role)) : []

  // Inventory (→ TRF) in the overflow for NON-staff: store_manager (own store) +
  // super / Cycle Count admin. Staff carry it as a primary tab. Not 'sm' (phase 1).
  const showInventory = !isStaffNav && (role === 'store_manager'
    || (role === 'admin' && (isSuperAdmin(profile?.email, role) || profile?.department_id === CYCLE_COUNT_DEPT_ID)))
  const extra: NavItem[] = showInventory
    ? [{ href: '/inventory', label: 'Tồn kho', icon: Boxes, roles: [] }]
    : []

  const needsMore = !isStaffNav && (visible.length > MAX_PRIMARY || extra.length > 0)
  const primary = needsMore ? visible.slice(0, MAX_PRIMARY) : visible
  const drawerItems = needsMore ? [...visible.slice(MAX_PRIMARY), ...extra] : []
  const moreActive = drawerItems.some((i) => pathname === i.href || pathname.startsWith(i.href + '/'))

  const badgeFor = (href: string) =>
    href === '/announcements' ? announcementsUnread : href === '/tasks' ? tasksPending : 0

  function NavBtn({ item, onClick }: { item: NavItem; onClick?: () => void }) {
    const Icon = item.icon
    // Segment-boundary match: '/inventory' stays active on '/inventory/trf',
    // but '/tasks' can never light up on an unrelated '/tasks-…' path.
    const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
    const badge = badgeFor(item.href)
    return (
      <Link
        href={item.href}
        prefetch={false}
        onClick={onClick}
        aria-label={item.label}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'relative flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors',
          isActive ? 'text-primary' : 'text-sidebar-foreground/60 active:text-sidebar-foreground',
        )}
      >
        {/* Soft pill behind the icon marks the active tab — color alone was too quiet */}
        <span className={cn('rounded-full px-3.5 py-0.5 transition-colors', isActive && 'bg-primary/10')}>
          <span className="relative block">
            <Icon className="h-6 w-6" />
            {badge > 0 && (
              <span className="absolute -top-1.5 -right-2 min-w-4 h-4 px-1 rounded-full bg-primary text-white text-[9px] font-semibold flex items-center justify-center">
                {badge > 9 ? '9+' : badge}
              </span>
            )}
          </span>
        </span>
        <span className={cn('text-[11px]', isActive ? 'font-semibold' : 'font-medium')}>{item.label}</span>
      </Link>
    )
  }

  return (
    <>
      <nav
        aria-label="Điều hướng chính"
        className="fixed bottom-0 left-0 right-0 z-40 bg-sidebar border-t border-sidebar-border shadow-[0_-2px_10px_rgb(0_0_0/0.06)] md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center justify-around h-16">
          {primary.map((item) => <NavBtn key={item.href} item={item} />)}
          {needsMore && (
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-label="Thêm"
              aria-haspopup="dialog"
              className={cn(
                'flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors',
                moreActive ? 'text-primary' : 'text-sidebar-foreground/60 active:text-sidebar-foreground',
              )}
            >
              <span className={cn('rounded-full px-3.5 py-0.5 transition-colors', moreActive && 'bg-primary/10')}>
                <MoreHorizontal className="h-6 w-6" />
              </span>
              <span className={cn('text-[11px]', moreActive ? 'font-semibold' : 'font-medium')}>Thêm</span>
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
              const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch={false}
                  onClick={() => setMoreOpen(false)}
                  aria-current={isActive ? 'page' : undefined}
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
