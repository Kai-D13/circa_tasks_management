import { cn } from '@/lib/utils'

// Thanh thao tác hàng loạt nổi (nền đảo màu) — chỉ là KHUNG trình bày: số đã chọn + các nút có sẵn
// của trang (xuất/lưu trữ/yêu cầu làm lại…) truyền vào `children`; component không giữ state, không
// tự thêm hành động. Dính đáy vùng cuộn <main> (đã chừa bottom nav trên mobile).
// Nút bên trong dùng BULK_ACTION_BUTTON (viền mảnh đảo màu, 44px mobile / 32px desktop). Cũng dùng làm
// className cho ui/button variant outline (P1.2): ghi đè cả hover/aria-expanded của outline để chữ
// không tối đi trên nền đảo màu.
export const BULK_ACTION_BUTTON =
  'inline-flex h-[44px] md:h-8 items-center justify-center gap-1.5 rounded-[8px] border border-background/25 bg-transparent px-3 text-[13px] font-medium text-background hover:bg-background/10 hover:text-background aria-expanded:bg-background/10 aria-expanded:text-background disabled:opacity-50'

export function BulkActionBar({
  label, children, className,
}: {
  label: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-bulk-bar
      className={cn(
        'sticky bottom-4 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2.5 rounded-lg bg-foreground py-2 pl-4 pr-2 text-background shadow-sm',
        'v2:rounded-v2-panel v2:shadow-lg',
        className,
      )}
    >
      <span className="text-[13px] font-semibold">{label}</span>
      <span aria-hidden="true" className="h-5 w-px bg-background/25" />
      {children}
    </div>
  )
}
