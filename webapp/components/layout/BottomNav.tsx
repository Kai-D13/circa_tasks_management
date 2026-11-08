'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useUserStore } from '@/store/userStore'
import {
  LayoutDashboard, CheckSquare, Users, Store, FileImage, ScrollText,
  TrendingUp, Megaphone, Boxes, MoreHorizontal, Package,
  ChartNoAxesCombined, Newspaper, HeartHandshake,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isSuperAdmin } from '@/lib/authz'
import { CYCLE_COUNT_DEPT_ID } from '@/lib/inventory/constants'
import { careMyBackTarget } from '@/lib/care/my'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

interface NavItem { href: string; label: string; icon: LucideIcon; roles: string[] }

// Staff get a FIXED 5-tab bar — their five core workflows, no "Thêm" drawer.
// The old pipeline overflowed Tồn kho into a drawer holding a single item
// (pure friction), and /inventory lit up "Thêm" instead of its own tab.
// Thứ tự chốt với stakeholder 15/08: Tasks · Toa thuốc · Doanh số · Bảng tin ·
// Tồn kho — Doanh số nằm CHÍNH GIỮA (màn số liệu vào nhiều nhất), 2 tab mỗi bên.
// UI-NAV U2 (PM spec ui-nav-spec-implementation-2026-11-08 §4, quyết định UI-NAV-D04 thay hình thức nút NỔI của 15/08):
// năm tab cùng một kiểu NavBtn — cùng bề rộng (flex-1), cùng chiều cao, không nút tròn nhô lên. Thứ tự / href / icon / badge
// giữ nguyên; Doanh số vẫn ở vị trí thứ ba.
//
// M1.3: đổi icon RIÊNG cho staff — Doanh số dùng ChartNoAxesCombined (biểu đồ
// cột: màn số liệu, không phải "đang tăng"; mũi tên TrendingUp đọc như một
// khẳng định về kết quả), Bảng tin dùng Newspaper (bản tin để ĐỌC, không phải
// loa thông báo đẩy). CHỈ trong STAFF_NAV — NAV_ITEMS (store_manager/sm) và
// Sidebar desktop giữ nguyên TrendingUp/Megaphone, nên hai icon cũ vẫn import.
const STAFF_NAV: NavItem[] = [
  { href: '/tasks',         label: 'Tasks',     icon: CheckSquare,          roles: [] },
  { href: '/prescriptions', label: 'Toa thuốc', icon: FileImage,            roles: [] },
  { href: '/targets',       label: 'Doanh số',  icon: ChartNoAxesCombined,  roles: [] },
  { href: '/announcements', label: 'Bảng tin',  icon: Newspaper,            roles: [] },
  { href: '/inventory',     label: 'Tồn kho',   icon: Boxes,                roles: [] },
]

// CRM-CSKH B4: khi CARE_ENABLED (server truyền xuống), tab cuối Tồn kho → CSKH
// (/care/my — "Khách hàng của tôi"). Vẫn 5 tab đều nhau, Doanh số thứ ba; cờ OFF giữ STAFF_NAV cũ.
const STAFF_NAV_CARE: NavItem[] = [
  ...STAFF_NAV.slice(0, 4),
  { href: '/care/my',       label: 'CSKH',      icon: HeartHandshake,       roles: [] },
]

// Non-staff roles keep the role-filter + overflow-drawer pipeline. SM (area
// manager) previously had NO bottom nav at all (bug) — now added via 'sm' roles.
// Order unchanged so store_manager's primary tabs don't shift; SM isn't in
// tasks/prescriptions/announcements so Doanh số bubbles up to a primary tab.
const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard',     label: 'Tổng quan', icon: LayoutDashboard, roles: ['admin', 'store_manager', 'sm'] },
  { href: '/tasks',         label: 'Tasks',      icon: CheckSquare,     roles: ['admin', 'store_manager'] },
  { href: '/prescriptions', label: 'Toa thuốc', icon: FileImage,       roles: ['admin', 'store_manager'] },
  { href: '/announcements', label: 'Bảng tin',  icon: Megaphone,       roles: ['store_manager'] },
  // Store manager reaches Doanh số via the "Thêm" drawer; SM gets it as a primary.
  { href: '/targets',       label: 'Doanh số',  icon: TrendingUp,      roles: ['store_manager', 'sm'] },
  { href: '/users',         label: 'Users',      icon: Users,           roles: ['admin', 'sm'] },
  { href: '/stores',        label: 'Cửa hàng',  icon: Store,           roles: ['admin', 'store_manager', 'sm'] },
  { href: '/logs',          label: 'Nhật ký',   icon: ScrollText,      roles: ['admin', 'store_manager', 'sm'] },
]

// FS staff see ONLY their module — a single tab (F5 isolation).
const FS_NAV: NavItem[] = [
  { href: '/fs/products', label: 'Quản lý sản phẩm', icon: Package, roles: [] },
]

const MAX_PRIMARY = 4

export function BottomNav({
  announcementsUnread = 0,
  tasksPending = 0,
  isFsStore = false,
  careEnabled = false,
}: {
  announcementsUnread?: number
  tasksPending?: number
  isFsStore?: boolean
  /** CARE_ENABLED (server) — chỉ có tác dụng với staff OS. */
  careEnabled?: boolean
}) {
  const pathname = usePathname()
  const profile  = useUserStore((s) => s.profile)
  const role     = profile?.role
  const [moreOpen, setMoreOpen] = useState(false)

  const isStaffNav = role === 'staff' && !isFsStore
  const visible = isFsStore ? FS_NAV : isStaffNav ? (careEnabled ? STAFF_NAV_CARE : STAFF_NAV) : role ? NAV_ITEMS.filter((item) => item.roles.includes(role)) : []

  // Inventory (→ TRF) in the overflow for NON-staff: store_manager (own store) +
  // super / Cycle Count admin. Staff carry it as a primary tab. Not 'sm' (phase 1).
  const showInventory = !isStaffNav && !isFsStore && (role === 'store_manager'
    || (role === 'admin' && (isSuperAdmin(profile?.email, role) || profile?.department_id === CYCLE_COUNT_DEPT_ID)))
  const extra: NavItem[] = showInventory
    ? [{ href: '/inventory', label: 'Tồn kho', icon: Boxes, roles: [] }]
    : []

  const needsMore = !isStaffNav && !isFsStore && (visible.length > MAX_PRIMARY || extra.length > 0)
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
        data-nav-item
        className={cn(
          // min-h pixel-literal: pill cao 60px nên h-full đã >44px, khai báo
          // tường minh để đổi --bottom-nav-h không vô tình tụt dưới ngưỡng chạm.
          'relative flex flex-col items-center justify-center gap-0.5 flex-1 h-full min-h-[44px] transition-colors',
          // UI-NAV AC06: focus ring khi dùng bàn phím (Link thuần không có ring của Button) — ring-inset, không đổi hình học.
          'rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          isActive ? 'text-primary' : 'text-sidebar-foreground/60 active:text-sidebar-foreground',
        )}
      >
        {/* Active tab = coral pill wrapping icon+label (modern floating-nav look).
            nowrap + tight padding keeps 2-word labels on ONE line at 360px. */}
        <span className={cn('flex flex-col items-center gap-0.5 rounded-2xl px-1.5 py-1 transition-colors', isActive && 'bg-primary/10')}>
          <span className="relative block">
            <Icon className="h-[22px] w-[22px]" />
            {badge > 0 && (
              <span className="absolute -top-1.5 -right-2 min-w-4 h-4 px-1 rounded-full bg-primary text-white text-[9px] font-semibold flex items-center justify-center">
                {badge > 9 ? '9+' : badge}
              </span>
            )}
          </span>
          <span data-nav-label className={cn('text-[10px] leading-none whitespace-nowrap', isActive ? 'font-semibold' : 'font-medium')}>{item.label}</span>
        </span>
      </Link>
    )
  }

  // B7-ui (M01): chi tiết/ghi nhận CSKH là luồng con có nút hành động dính đáy và header
  // quay về màn cha ⇒ ẩn thanh tab (<main> tự bỏ phần chừa chỗ — globals.css :has).
  if (careMyBackTarget(pathname)) return null

  return (
    <>
      {/* Floating rounded nav — detached from the screen edges (mx/mb margins),
          soft shadow, no hard top border. Reads far more premium than a
          full-width bar.
          Hình học lấy từ token globals.css (`--bottom-nav-h` = chiều cao pill,
          `--bottom-nav-offset` = hở dưới): <main> trong layout.tsx chừa chỗ bằng
          `--bottom-nav-clearance` DẪN XUẤT từ đúng hai token này, nên đổi chiều
          cao nav ở một chỗ là hai bên tự khớp. Trước đây hai giá trị khai báo
          rời (h-16 ↔ pb-[5.5rem]) — sửa một bên là lệch. */}
      {/* UI-NAV-D07: [data-nav-reflow] = thanh OS (luôn 5 ô) — globals.css (khối "UI-NAV-D07") ẩn nhãn / xếp lưới 3 + 2 / 2 cột ở
          khung CSS rất hẹp và tăng `--bottom-nav-h` tại :root (pill + <main> cùng nhận). FS một tab không gắn ⇒ không reflow.
          Mốc: lib/layout/bottomNavReflow.ts. data-nav-controls chỉ để test khoá số ô. */}
      <nav
        aria-label="Điều hướng chính"
        data-bottom-nav
        data-nav-reflow={isFsStore ? undefined : ''}
        data-nav-controls={primary.length + (needsMore ? 1 : 0)}
        className="fixed bottom-0 left-0 right-0 z-40 px-3 pointer-events-none md:hidden"
        style={{ paddingBottom: 'calc(var(--bottom-nav-offset) + env(safe-area-inset-bottom))' }}
      >
        <div data-nav-pill className="pointer-events-auto flex items-center justify-around h-[var(--bottom-nav-h)] rounded-3xl border border-border/60 bg-sidebar/95 backdrop-blur shadow-[0_8px_30px_rgb(0_0_0/0.12)]">
          {primary.map((item) => <NavBtn key={item.href} item={item} />)}
          {needsMore && (
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-label="Thêm"
              aria-haspopup="dialog"
              data-nav-item
              className={cn(
                // UI-NAV-D07: cùng sàn 44px + focus ring trong ô như NavBtn (nhãn có thể bị ẩn ở khung hẹp — tên vẫn từ aria-label).
                'flex flex-col items-center justify-center flex-1 h-full min-h-[44px] transition-colors',
                'rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                moreActive ? 'text-primary' : 'text-sidebar-foreground/60 active:text-sidebar-foreground',
              )}
            >
              <span className={cn('flex flex-col items-center gap-0.5 rounded-2xl px-1.5 py-1 transition-colors', moreActive && 'bg-primary/10')}>
                <MoreHorizontal className="h-[22px] w-[22px]" />
                <span data-nav-label className={cn('text-[10px] leading-none whitespace-nowrap', moreActive ? 'font-semibold' : 'font-medium')}>Thêm</span>
              </span>
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
