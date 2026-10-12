'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useUserStore } from '@/store/userStore'
import { NotificationBell } from '@/components/layout/NotificationBell'
import { AccountMenu } from '@/components/layout/AccountMenu'
import { Button } from '@/components/ui/button'
import { careMyScreen } from '@/lib/care/my'
import { ArrowLeft } from 'lucide-react'
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
  care:          'Chăm sóc KH',
}

/**
 * `careOwnHeader` (server, dashboard layout): dược sĩ OS khi cờ CSKH bật. B7-ui r2: 3 màn dược sĩ
 * CSKH (/care/my, chi tiết, ghi nhận) tự dựng header nền sáng của trang (CareMyHeader — artboard
 * 08/09/10) ⇒ header chung ẩn ở đó, không chồng 2 header. Giá trị từ server để không nháy header
 * lúc hydrate (profile trong store chỉ có sau useEffect).
 */
export function MobileHeader({ careOwnHeader = false }: { careOwnHeader?: boolean }) {
  const router   = useRouter()
  const pathname = usePathname()
  const role     = useUserStore((s) => s.profile?.role)

  if (careOwnHeader && careMyScreen(pathname)) return null

  const segments   = pathname.split('/').filter(Boolean)
  const section    = segments[0]
  const isSubPage  = segments.length > 1
  // The FS module root (/fs/products) is an FS user's home — no "back". Deeper FS
  // pages keep a back button (labelled "Quản lý sản phẩm").
  const isFsRoot   = section === 'fs' && segments.length <= 2
  const showBack   = isSubPage && !isFsRoot
  const parentTitle = SECTION_TITLES[section] ?? 'Quay lại'

  return (
    <header className="sticky top-0 z-30 bg-primary flex items-center gap-2 px-4 h-14 md:hidden">

      {showBack ? (
        /* Sub-page: back button + section title */
        <>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Quay lại"
            className="size-[44px] px-0 text-white hover:bg-white/10 shrink-0"
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
        /* Top-level: NHẬN DIỆN, không phải danh tính người dùng.
           M1.3: bỏ `profile.full_name` khỏi header. Tên đã hiện ở avatar (chữ
           cái đầu) và đầy đủ trong account sheet cùng email — in thêm ở đây
           là lặp, mà lại chiếm gần hết bề ngang 360px vì tên tiếng Việt dài.
           Danh tính chỉ sống trong account sheet. */
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="h-8 w-8 rounded-full bg-white/20 flex items-center justify-center shrink-0">
            <span className="text-xs font-bold text-white">C</span>
          </div>
          <p className="text-sm font-semibold text-white leading-tight truncate min-w-0">
            Circa Tasks
          </p>
        </div>
      )}

      {/* Actions — giống nhau ở MỌI chế độ (top-level / FS / subpage) nên header
          không đổi hình khi đi sâu vào trang con.
          Trước đây là 4 nút icon xếp cạnh nhau (hồ sơ · mật khẩu · giao diện ·
          đăng xuất) — chật trên iPhone và không nút nào đủ 44px. Giờ chỉ còn
          chuông (phải thấy ngay) + avatar mở account sheet (AccountMenu). */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Staff don't receive notifications (provider skips their fetch), so the bell
            is dead weight for them — hide it. */}
        {role !== 'staff' && <NotificationBell />}
        <AccountMenu tone="onPrimary" />
      </div>
    </header>
  )
}
