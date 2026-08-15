'use client'

import { Tooltip } from '@base-ui/react/tooltip'
import { cn } from '@/lib/utils'

/**
 * Tooltip cho control CHỈ CÓ ICON — hiện khi rê chuột VÀ khi focus bàn phím.
 * Sinh ra để vá khuyết điểm của `title` native: `title` KHÔNG hiện khi tab bằng
 * bàn phím ⇒ người dùng keyboard không bao giờ đọc được nhãn của icon. Chỗ nào
 * đã bọc IconTooltip thì BỎ `title` (tránh 2 tooltip chồng nhau), GIỮ
 * `aria-label` vì base-ui Tooltip không tự gán tên cho phần tử trigger.
 *
 * VÌ SAO PHẢI PORTAL (bản r1 dựng bằng CSS thuần đã phải bỏ): popup
 * `position: absolute` bị CẮT bởi mọi tổ tiên có `overflow` khác `visible`, mà
 * `overflow-y: auto` thì tự động kéo `overflow-x` thành `auto`. Đo trên
 * Chromium: trong `<nav overflow-y-auto>` rộng 56px của sidebar thu gọn, popup
 * dài 107px bị xén ở mép nav — tức đúng chỗ cần tooltip nhất (hàng điều hướng)
 * lại là chỗ không dùng được. `Tooltip.Portal` treo popup thẳng vào <body> nên
 * thoát mọi vùng cuộn.
 *
 * KHÔNG phải dependency mới: `@base-ui/react` đã nằm sẵn trong deps (components/
 * ui/dialog.tsx, avatar.tsx… đều dựng trên đó). Nhắc lại bài học base-ui: KHÔNG
 * có `asChild`, thay thế phần tử render bằng prop `render`.
 */
export function IconTooltip({
  label, side = 'right', className, children,
}: {
  label: string
  /** Mặc định 'right' — sidebar nằm sát mép trái nên popup phải bung sang phải. */
  side?: Tooltip.Positioner.Props['side']
  className?: string
  children: React.ReactNode
}) {
  return (
    <Tooltip.Root>
      {/* Trigger mặc định render <button>; ở đây nó chỉ là lớp BỌC quanh control
          thật (Link / button / Avatar / ThemeToggle) nên phải đổi sang <span> —
          button lồng button/link là HTML không hợp lệ. Focus của phần tử con
          bubble lên span (React map onFocus → focusin) nên tab bàn phím vào
          Link vẫn mở tooltip; base-ui chỉ mở khi khớp `:focus-visible`, tức
          click chuột không làm popup nhảy ra.
          `block`: span mặc định inline, mà `space-y-*` của <nav> đặt margin-top
          — margin dọc không ăn trên phần tử inline. Call-site nào cần khác
          (footer dùng `flex`) truyền className, tailwind-merge cho lớp sau
          thắng. */}
      <Tooltip.Trigger delay={300} render={<span />} className={cn('block', className)}>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={8} className="z-50">
          <Tooltip.Popup
            role="tooltip"
            className="rounded-md bg-foreground text-background text-xs px-2 py-1 shadow-md whitespace-nowrap z-50"
          >
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
