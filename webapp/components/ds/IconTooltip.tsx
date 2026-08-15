import { cn } from '@/lib/utils'

/**
 * Tooltip cho control CHỈ CÓ ICON — hiện khi rê chuột VÀ khi focus bàn phím.
 *
 * Vì sao tự viết bằng CSS thuần thay vì kéo primitive Radix/base-ui Tooltip
 * (audit UI-fluid-sidebar-r1, P1#3): chỗ dùng duy nhất hiện nay là sidebar
 * desktop-only của 500 user nội bộ; `group-hover` + `group-focus-within` đã đủ
 * và không thêm dependency, không thêm provider, không thêm JS runtime.
 * Khuyết điểm đã biết của `title` native mà primitive này sinh ra để vá:
 * `title` KHÔNG hiện khi tab bằng bàn phím ⇒ người dùng keyboard không bao giờ
 * đọc được nhãn của icon. Chỗ nào đã bọc IconTooltip thì BỎ `title` để tránh 2
 * tooltip chồng nhau.
 *
 * ⚠ RÀNG BUỘC ĐẶT CHỖ: popup dùng `position: absolute` nên bị CẮT bởi bất kỳ tổ
 * tiên nào có `overflow` khác `visible`. Lưu ý CSS: đặt `overflow-y: auto` thì
 * `overflow-x: visible` TỰ ĐỘNG thành `auto` — đo trên Chromium: trong một
 * `<nav overflow-y-auto>` rộng 56px, popup dài 107px bị cắt ở mép 64px. Vậy
 * KHÔNG dùng IconTooltip bên trong vùng cuộn; ở đó giữ `title` + `aria-label`.
 */
export function IconTooltip({
  label, className, children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <span className={cn('relative group/tip', className)}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 hidden group-hover/tip:block group-focus-within/tip:block whitespace-nowrap rounded-md bg-foreground text-background text-xs px-2 py-1 shadow-md"
      >
        {label}
      </span>
    </span>
  )
}
