import { UserProvider } from '@/components/providers/UserProvider'
import { ThemeProvider } from '@/components/providers/ThemeProvider'
import { NotificationProvider } from '@/components/layout/NotificationProvider'
import { Sidebar } from '@/components/layout/Sidebar'
import { MobileHeader } from '@/components/layout/MobileHeader'
import { BottomNav } from '@/components/layout/BottomNav'
import type { CampaignNavItem } from '@/lib/layout/campaignNav'
import type { UserProfile } from '@/types'
import { cn } from '@/lib/utils'

// UI-NAV r1 (PM audit planning/reviews/2026-11-08-ui-nav-candidate-pm.md §3 UINAV-P1-2): khung TRÌNH BÀY của (dashboard)/layout.tsx
// tách nguyên văn ra đây để fixture `/ui-catalog-shell/nav` render ĐÚNG Sidebar + <main> + BottomNav thật với hồ sơ giả. Layout giữ
// toàn bộ phần lấy dữ liệu / quyền / cờ; component này không query, không đọc env, không tự suy quyền.

/**
 * Đệm đáy <main> trên mobile theo vai (desktop luôn `md:pb-0`). Staff OS — 5 tab phẳng, không nút nổi (UI-NAV U2):
 * `--bottom-nav-clearance-flat` = 60 + 7.5 + 8 = 75.5px + safe-area. Mọi vai khác (QLCH / SM / admin mobile / FS):
 * `--bottom-nav-clearance` = 60 + 7.5 + 14 + 8 + 8 = 97.5px + safe-area (giữ nguyên geometry cũ). Token ở globals.css.
 */
export function mainBottomClearanceClass(isStaff: boolean, isFsStore: boolean): string {
  return isStaff && !isFsStore ? 'pb-[var(--bottom-nav-clearance-flat)]' : 'pb-[var(--bottom-nav-clearance)]'
}

export function DashboardShell({
  profile, isFsStore, announcementsUnread, tasksPending, referralEnabled, campaignNav, sidebarCollapsed, careNav, careEnabled, children,
}: {
  profile: UserProfile
  isFsStore: boolean
  announcementsUnread: number
  tasksPending: number
  referralEnabled: boolean
  campaignNav: CampaignNavItem[]
  sidebarCollapsed: boolean
  careNav: { href: string; label: string }[]
  /** CARE_ENABLED (server) — chỉ có tác dụng với staff OS (tab CSKH + header riêng 3 màn CSKH). */
  careEnabled: boolean
  children: React.ReactNode
}) {
  // Staff are mobile-only: skip rendering/hydrating the desktop Sidebar entirely
  // (it's display:none for them anyway) for a leaner shell. 100dvh avoids the
  // mobile address-bar resize jank.
  const isStaff = profile.role === 'staff'
  const staffCare = isStaff && !isFsStore && careEnabled
  return (
    <ThemeProvider>
      <UserProvider profile={profile}>
        <NotificationProvider>
        <div className="flex h-[100dvh] overflow-hidden">
          {/* Desktop sidebar — hidden on mobile; not rendered for staff */}
          {/* Staff get no desktop Sidebar. An FS store_manager DOES get one → pass
              isFsStore so it collapses to the single FS item (no OS links). */}
          {!isStaff && <Sidebar announcementsUnread={announcementsUnread} referralEnabled={referralEnabled} isFsStore={isFsStore} campaignNav={campaignNav} defaultCollapsed={sidebarCollapsed} careNav={careNav} />}

          {/* Main content — full width on mobile */}
          {/* Mobile bottom padding clears the fixed BottomNav + the iPhone
              home-indicator safe area + a little breathing room, so the last card /
              Staff pager is never hidden behind the nav. Desktop has no bottom nav.
              Hai token clearance (globals.css) DẪN XUẤT từ `--bottom-nav-h` / `--bottom-nav-offset` — cùng token mà BottomNav
              dùng cho pill — nên đổi chiều cao nav là chỗ này tự khớp. Giá trị theo vai: xem `mainBottomClearanceClass`
              (staff OS 75.5px + safe-area; QLCH / SM / admin / FS 97.5px + safe-area). Route CSKH ẩn thanh tab: globals.css
              `body:not(:has([data-bottom-nav])) main` chỉ chừa safe-area. */}
          <main className={cn('flex-1 min-w-0 overflow-y-auto overflow-x-hidden bg-muted/20 md:pb-0', mainBottomClearanceClass(isStaff, isFsStore))}>
            {/* Mobile top header — 3 màn dược sĩ CSKH tự dựng header riêng (B7-ui r2), cùng điều kiện tab CSKH */}
            <MobileHeader careOwnHeader={staffCare} />
            {children}
          </main>
        </div>

        {/* Bottom navigation — mobile only */}
        <BottomNav announcementsUnread={announcementsUnread} tasksPending={tasksPending} isFsStore={isFsStore} careEnabled={staffCare} />
        </NotificationProvider>
      </UserProvider>
    </ThemeProvider>
  )
}
