'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useUserStore } from '@/store/userStore'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { TagBadge, type TagHue } from '@/components/ds/TagBadge'
import { IconTooltip } from '@/components/ds/IconTooltip'
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
  Package,
  PackageSearch,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Link2,
  LogOut,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { resolveActiveHref } from '@/lib/layout/sidebarNav'
import { isSuperAdmin } from '@/lib/authz'
import { CYCLE_COUNT_DEPT_ID } from '@/lib/inventory/constants'
import { POLICY_DEPT_ID } from '@/lib/fs/constants'
import { NotificationBell } from '@/components/layout/NotificationBell'
import { ChangePasswordDialog } from '@/components/layout/ChangePasswordDialog'
import { EditProfileDialog } from '@/components/layout/EditProfileDialog'
import { ThemeToggle } from '@/components/layout/ThemeToggle'

// Hue categorical của ds/TagBadge (có sẵn cặp light + dark) thay cho bảng màu
// raw chỉ-light cũ. TagBadge không có orange/purple nên lấy hue gần nhất:
// admin orange→amber, sm purple→indigo.
const ROLE_HUES: Record<string, TagHue> = {
  admin:         'amber',
  store_manager: 'blue',
  staff:         'green',
  sm:            'indigo',
}

const ROLE_LABELS: Record<string, string> = {
  admin:         'Admin',
  store_manager: 'Quản lý',
  staff:         'Nhân viên',
  sm:            'SM',
}

// 3 TRẠNG THÁI HIỂN THỊ của một hàng sidebar (contract active, audit P1#1):
//  - 'active'  : ĐÚNG MỘT phần tử trong cả sidebar — nền `bg-sidebar-accent`.
//  - 'context' : mục CHA accordion đang chứa trang hiện tại. Chỉ đổi MÀU CHỮ +
//                icon, TUYỆT ĐỐI KHÔNG nền — nếu cha cũng có nền thì tại
//                /inventory/trf và /fs/products cha lẫn con cùng sáng, người
//                dùng không biết đâu là trang mình đang đứng.
//  - 'idle'    : còn lại.
// Khi thu gọn, 'context' vẫn chỉ là tint icon (không nền) — cùng một class.
type ItemState = 'active' | 'context' | 'idle'

// Slot chuẩn của footer khi thu gọn — 36px PIXEL LITERAL (root 15px ⇒ `h-9`
// thật ra là 33.75px, xem guardrail "rem lừa").
const FOOTER_SLOT = 'h-[36px] w-[36px]'

// Chỉ bọc IconTooltip khi THU GỌN — lúc mở rộng nhãn đã nằm ngay trên hàng,
// thêm tooltip là nhiễu. Trả thẳng children để không sinh thêm thẻ bọc.
// ⚠ Chỉ dùng cho control NGOÀI vùng cuộn (nút Thu gọn + footer): popup của
// IconTooltip là `absolute` nên sẽ bị `<nav overflow-y-auto>` cắt — các hàng
// điều hướng bên trong nav vì vậy vẫn giữ `title` + `aria-label`.
function CollapsedTip({
  label, collapsed, className, children,
}: {
  label: string
  collapsed: boolean
  className?: string
  children: React.ReactNode
}) {
  if (!collapsed) return <>{children}</>
  return <IconTooltip label={label} className={className}>{children}</IconTooltip>
}

// Pattern class dùng chung cho MỌI hàng của sidebar (link, nút accordion, nút
// thu gọn) — trước đây lặp nguyên văn 6 lần trong file này.
function itemCls(state: ItemState, collapsed: boolean) {
  return cn(
    'flex items-center gap-3 rounded-md py-2 text-sm transition-colors',
    // <Link> thuần không mang focus ring của Button ⇒ khai báo tại đây, nếu
    // không thì tab bằng bàn phím trong sidebar hoàn toàn không thấy con trỏ.
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
    collapsed ? 'justify-center px-0' : 'px-3',
    state === 'active' && 'bg-sidebar-accent text-primary font-medium',
    state === 'context' && 'text-primary hover:bg-sidebar-accent/60',
    state === 'idle' && 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-primary/80',
  )
}

// Một hàng điều hướng. Khi thu gọn: bỏ label, badge đếm thu về chấm nhỏ ở góc
// icon, và tooltip vẫn là `title` native — KHÔNG dùng IconTooltip ở đây vì hàng
// nav nằm trong `<nav overflow-y-auto>`, mà popup `absolute` sẽ bị vùng cuộn
// cắt (đo trên Chromium: popup 107px bị cắt ở mép 64px). Bù lại bằng
// `aria-label` để người dùng screen reader vẫn nghe đúng tên mục.
// `aria-current="page"` đi kèm ĐÚNG hàng active — screen reader phải nghe được
// cùng một thông tin mà nền màu đang nói với người nhìn.
function NavLink({
  href, label, icon: Icon, active, collapsed, prefetch, badge = 0,
}: {
  href: string
  label: string
  icon: LucideIcon
  active: boolean
  collapsed: boolean
  prefetch?: boolean
  badge?: number
}) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      title={collapsed ? label : undefined}
      // Thu gọn: icon không còn chữ nào ⇒ tên có thể đọc được phải do
      // `aria-label` cấp; kèm số badge để screen reader không mất thông tin mà
      // người nhìn vẫn thấy trên chấm đếm.
      aria-label={collapsed ? (badge > 0 ? `${label} (${badge})` : label) : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(itemCls(active ? 'active' : 'idle', collapsed), collapsed && 'relative whitespace-nowrap')}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="flex-1">{label}</span>}
      {badge > 0 && (collapsed ? (
        <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-0.5 rounded-full bg-primary text-white text-[9px] flex items-center justify-center">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : (
        <span className="ml-auto min-w-5 h-5 px-1 rounded-full bg-primary text-white text-[10px] font-semibold flex items-center justify-center">
          {badge > 99 ? '99+' : badge}
        </span>
      ))}
    </Link>
  )
}

export function Sidebar({ announcementsUnread = 0, kpiCampaignEnabled = false, referralEnabled = false, isFsStore = false, affiliateOverviewNav = false, defaultCollapsed = false }: { announcementsUnread?: number; kpiCampaignEnabled?: boolean; referralEnabled?: boolean; isFsStore?: boolean; affiliateOverviewNav?: boolean; defaultCollapsed?: boolean }) {
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
    { href: '/targets',          label: 'Doanh số',     icon: TrendingUp,      roles: ['staff', 'store_manager', 'sm'],          prefetch: false },
    { href: '/tasks/schedules',  label: 'Định kỳ',     icon: CalendarClock,   roles: ['admin'],                                 prefetch: false },
    { href: '/users',            label: 'Người dùng',   icon: Users,           roles: ['admin', 'sm'],                           prefetch: false },
    { href: '/stores',           label: 'Cửa hàng',     icon: Store,           roles: ['admin', 'store_manager', 'sm'],          prefetch: false },
    { href: '/prescriptions',    label: 'Toa thuốc',    icon: FileImage,       roles: ['admin', 'store_manager', 'staff'],       prefetch: false },
    { href: '/announcements',    label: 'Bảng tin',     icon: Megaphone,       roles: ['admin', 'store_manager', 'staff', 'sm'], prefetch: false },
    { href: '/gioi-thieu',       label: 'Giới thiệu',   icon: Gift,            roles: ['admin'],                                 prefetch: false, superAdmin: true },
    { href: '/logs',             label: 'Nhật ký',      icon: ScrollText,      roles: ['admin', 'store_manager', 'sm'], prefetch: false },
  ]

  const isSuper = isSuperAdmin(profile?.email, role)
  // An FS store_manager (isFsStore) is contained to the FS module — hide ALL OS
  // nav; only the "Quản lý FS → Sản phẩm" item shows.
  const visibleItems = role && !isFsStore
    ? navItems.filter((item) => item.roles.includes(role)
        && (!('superAdmin' in item && item.superAdmin) || isSuper)
        // Referral đã ngưng: flag off ẩn "Giới thiệu" khỏi nav (route tự redirect)
        && (item.href !== '/gioi-thieu' || referralEnabled))
    : []

  // Inventory accordion (→ TRF): super, Cycle Count admin, or store manager.
  // Non-Cycle-Count admins and the multi-store sm role do NOT see it (phase 1).
  const showInventory = !isFsStore && (isSuper
    || (role === 'admin' && profile?.department_id === CYCLE_COUNT_DEPT_ID)
    || role === 'store_manager')
  const [invOpen, setInvOpen] = useState(() => pathname.startsWith('/inventory'))

  // KPI (→ Chiến dịch): super admin only, gated by the feature flag. Single flat
  // link now that the old all-stores Doanh số (/targets) is hidden from super admin.
  const showKpi = isSuper && kpiCampaignEnabled

  // Quản lý FS (→ Sản phẩm): super admin, an admin of dept Policy, OR an FS
  // store_manager (their ONLY nav item — everything else is hidden above).
  const showFs = isFsStore || isSuper || (role === 'admin' && profile?.department_id === POLICY_DEPT_ID)
  const [fsOpen, setFsOpen] = useState(() => pathname.startsWith('/fs') || isFsStore)

  // Active = LONGEST-MATCH ĐƠN NHẤT (hàm thuần `resolveActiveHref`, khoá bằng
  // e2e/sidebar-nav.spec.ts). Gom mọi href đang hiển thị (item theo role + 2
  // link con của accordion + link gated KPI/Affiliate) rồi để hàm chọn ĐÚNG 1.
  const activeHref = resolveActiveHref(pathname, [
    ...visibleItems.map((item) => item.href),
    ...(showInventory ? ['/inventory/trf'] : []),
    ...(showKpi ? ['/targets/campaigns'] : []),
    ...(affiliateOverviewNav && !isFsStore ? ['/targets/campaigns/affiliate'] : []),
    ...(showFs ? ['/fs/products'] : []),
  ])

  // "Context" của nút CHA accordion: đang đứng trong section nào. Giữ nguyên
  // predicate section-prefix cũ (kể cả /inventory hub — trang không có mục nav
  // riêng) NHƯNG hiển thị bằng màu chữ, KHÔNG bằng nền: nền active là tài sản
  // độc quyền của `activeHref`.
  const inInventorySection = pathname === '/inventory' || pathname.startsWith('/inventory/')
  const inFsSection        = pathname === '/fs' || pathname.startsWith('/fs/')

  // Thu gọn sidebar — khởi tạo từ COOKIE đọc server-side (prop defaultCollapsed):
  // HTML đầu tiên đã đúng bề rộng ⇒ không hydration mismatch, không nháy layout
  // (localStorage buộc phải đọc trong useEffect → luôn flash 1 frame).
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  // Nhãn nút toggle nói HÀNH ĐỘNG sắp xảy ra, không nói trạng thái hiện tại.
  const toggleLabel  = collapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng'
  // Tên + email hiển thị trên tooltip/aria của avatar khi thu gọn (khối tên
  // email bị ẩn ở chế độ này).
  const accountLabel = [profile?.full_name, profile?.email].filter(Boolean).join(' · ') || 'Tài khoản'

  function applyCollapsed(next: boolean) {
    setCollapsed(next)
    document.cookie = `sidebar_collapsed=${next ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`
  }

  return (
    <aside
      className={cn(
        // w-[56px]/w-[210px] px literal: root font-size 15px nên mọi thang rem
        // của Tailwind co 6.25% — bề rộng sidebar phải là con số thật.
        // motion-reduce: người bật "giảm chuyển động" của OS không phải xem
        // thanh nav trượt mỗi lần thu gọn/mở rộng.
        'hidden md:flex h-full flex-col border-r bg-sidebar transition-[width] duration-200 ease-in-out motion-reduce:transition-none',
        collapsed ? 'w-[56px]' : 'w-[210px]',
      )}
    >
      {/* Logo / Brand — orange header bar (thu gọn: chỉ còn logo "C" căn giữa) */}
      <div className={cn('flex h-[46px] items-center gap-2 bg-primary shrink-0', collapsed ? 'justify-center px-0' : 'px-4')}>
        <div className="h-6 w-6 rounded-full bg-white/20 flex items-center justify-center shrink-0">
          <span className="text-[10px] font-bold text-white">C</span>
        </div>
        {!collapsed && (
          <span className="font-semibold text-sm tracking-tight text-white">
            Circa Tasks
          </span>
        )}
      </div>

      {/* Nav — id để nút Thu gọn/Mở rộng trỏ `aria-controls` vào đúng vùng này */}
      <nav id="sidebar-nav" className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {visibleItems.map(({ href, label, icon, prefetch }) => (
          <NavLink
            key={href}
            href={href}
            label={label}
            icon={icon}
            prefetch={prefetch}
            collapsed={collapsed}
            active={href === activeHref}
            badge={href === '/announcements' ? announcementsUnread : 0}
          />
        ))}

        {/* Inventory — collapsible parent → submodules (TRF) */}
        {showInventory && (
          <div>
            <button
              type="button"
              // Thu gọn: nút cha KHÔNG điều hướng — mở rộng sidebar rồi bung accordion.
              onClick={() => {
                if (collapsed) { applyCollapsed(false); setInvOpen(true); return }
                setInvOpen((o) => !o)
              }}
              title={collapsed ? 'Inventory' : undefined}
              aria-label={collapsed ? 'Inventory' : undefined}
              // Vùng con chỉ tồn tại trong DOM khi đang mở ⇒ `aria-controls`
              // cũng chỉ trỏ khi đó (không để IDREF chết).
              aria-expanded={!collapsed && invOpen}
              aria-controls={!collapsed && invOpen ? 'sidebar-inventory-sub' : undefined}
              className={cn(itemCls(inInventorySection ? 'context' : 'idle', collapsed), 'w-full', collapsed && 'whitespace-nowrap')}
            >
              <Boxes className="h-4 w-4 shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1 text-left">Inventory</span>
                  <ChevronRight className={cn('h-4 w-4 transition-transform', invOpen && 'rotate-90')} />
                </>
              )}
            </button>
            {!collapsed && invOpen && (
              <div id="sidebar-inventory-sub" className="mt-0.5 space-y-0.5 pl-4">
                <NavLink
                  href="/inventory/trf"
                  label="TRF"
                  icon={ClipboardCheck}
                  prefetch={false}
                  collapsed={false}
                  active={activeHref === '/inventory/trf'}
                />
              </div>
            )}
          </div>
        )}

        {/* KPI — super admin only (flag on). The old all-stores "Doanh số"
            (/targets) is hidden now that campaigns own KPI; this is a single
            flat link straight to campaign management (accordion no longer needed). */}
        {showKpi && (
          <NavLink
            href="/targets/campaigns"
            label="Chiến dịch KPI"
            icon={Megaphone}
            prefetch={false}
            collapsed={collapsed}
            active={activeHref === '/targets/campaigns'}
          />
        )}

        {/* P3-I.2: Affiliate overview — admin phòng được cấp quyền (layout tính
            server-side từ affiliate_department_access + flag; route tự re-verify).
            Super không cần item này (đi qua Chiến dịch KPI → tab Affiliate). */}
        {affiliateOverviewNav && !isFsStore && (
          <NavLink
            href="/targets/campaigns/affiliate"
            label="Affiliate"
            icon={Link2}
            prefetch={false}
            collapsed={collapsed}
            active={activeHref === '/targets/campaigns/affiliate'}
          />
        )}

        {/* Quản lý FS — collapsible parent → submodules (Sản phẩm) */}
        {showFs && (
          <div>
            <button
              type="button"
              // Thu gọn: nút cha KHÔNG điều hướng — mở rộng sidebar rồi bung accordion.
              onClick={() => {
                if (collapsed) { applyCollapsed(false); setFsOpen(true); return }
                setFsOpen((o) => !o)
              }}
              title={collapsed ? 'Quản lý FS' : undefined}
              aria-label={collapsed ? 'Quản lý FS' : undefined}
              aria-expanded={!collapsed && fsOpen}
              aria-controls={!collapsed && fsOpen ? 'sidebar-fs-sub' : undefined}
              className={cn(itemCls(inFsSection ? 'context' : 'idle', collapsed), 'w-full', collapsed && 'whitespace-nowrap')}
            >
              <Package className="h-4 w-4 shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1 text-left">Quản lý FS</span>
                  <ChevronRight className={cn('h-4 w-4 transition-transform', fsOpen && 'rotate-90')} />
                </>
              )}
            </button>
            {!collapsed && fsOpen && (
              <div id="sidebar-fs-sub" className="mt-0.5 space-y-0.5 pl-4">
                <NavLink
                  href="/fs/products"
                  label="Sản phẩm"
                  icon={PackageSearch}
                  prefetch={false}
                  collapsed={false}
                  active={activeHref === '/fs/products'}
                />
              </div>
            )}
          </div>
        )}
      </nav>

      {/* Thu gọn / mở rộng — hàng riêng ngay trên khối tài khoản.
          Nhãn ĐỘNG: nút cũ luôn tự xưng "Thu gọn thanh điều hướng" kể cả khi
          đang thu gọn, tức nói ngược hành động sắp xảy ra. */}
      <div className="px-2 pb-2 shrink-0">
        <CollapsedTip label={toggleLabel} collapsed={collapsed} className="block">
          <button
            type="button"
            onClick={() => applyCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            aria-controls="sidebar-nav"
            aria-label={toggleLabel}
            className={cn(itemCls('idle', collapsed), 'w-full', collapsed && 'whitespace-nowrap')}
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4 shrink-0" />
            ) : (
              <>
                <ChevronsLeft className="h-4 w-4 shrink-0" />
                <span className="flex-1 text-left">Thu gọn</span>
              </>
            )}
          </button>
        </CollapsedTip>
      </div>

      {/* User info + controls — thu gọn: stack icon dọc; tên/email/role badge và
          Sửa hồ sơ / Đổi mật khẩu ẩn đi (mở rộng lại để dùng). */}
      {collapsed ? (
        // Cột dọc: MỌI slot đúng 36px để 4 control thẳng một trục (audit P2#4 —
        // trước đó Avatar 26px, Bell 32px, Theme/LogOut 34px lệch nhau).
        // Dùng PIXEL LITERAL: root font-size 15px nên `h-9` chỉ ra 33.75px.
        <div className="border-t border-sidebar-border p-2 flex flex-col items-center gap-2 shrink-0">
          <CollapsedTip label={accountLabel} collapsed className="flex">
            <Avatar className={FOOTER_SLOT} aria-label={accountLabel}>
              <AvatarFallback className="text-xs bg-primary text-primary-foreground">
                {profile?.full_name?.charAt(0)?.toUpperCase() ?? '?'}
              </AvatarFallback>
            </Avatar>
          </CollapsedTip>
          {role !== 'staff' && (
            <CollapsedTip label="Thông báo" collapsed className="flex">
              <NotificationBell className={cn(FOOTER_SLOT, 'px-0')} />
            </CollapsedTip>
          )}
          <CollapsedTip label="Đổi giao diện" collapsed className="flex">
            <ThemeToggle className={cn(FOOTER_SLOT, 'px-0')} />
          </CollapsedTip>
          <CollapsedTip label="Đăng xuất" collapsed className="flex">
            <Button
              variant="outline"
              size="sm"
              className={cn(FOOTER_SLOT, 'px-0')}
              onClick={handleLogout}
              aria-label="Đăng xuất"
            >
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </CollapsedTip>
        </div>
      ) : (
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
            <TagBadge hue={ROLE_HUES[role] ?? 'slate'} className="w-full justify-center">
              {ROLE_LABELS[role] ?? role}
            </TagBadge>
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
      )}
    </aside>
  )
}
