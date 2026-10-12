import { cn } from '@/lib/utils'

// Thanh hành động chính dính đáy màn hình (mobile) — CTA luôn trong tầm ngón cái, không phải
// cuộn tìm (B7-ui M01). `sticky` theo KHỐI cha: chỉ dính khi khối nội dung chứa nó còn trong
// khung nhìn (trang catalog nhiều khối không chồng thanh lên nhau). Desktop (md+): nằm theo luồng.
// Dính theo mép dưới vùng cuộn <main>: trang còn bottom nav thì <main> đã chừa `--bottom-nav-clearance`
// nên thanh nằm trên nav (e2e care-my-ui kiểm không bị che); trang ẩn nav thì sát đáy + safe-area.
// `hint` = dòng gợi ý trạng thái (vd "Còn thiếu: …") — KHÔNG phải role=alert.
export function StickyActionBar({
  children, hint, className,
}: {
  children: React.ReactNode
  hint?: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-sticky-action
      className={cn(
        'sticky bottom-0 z-20 -mx-4 space-y-1.5 border-t bg-card/95 px-4 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom))] backdrop-blur',
        'md:static md:mx-0 md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none',
        className,
      )}
    >
      {hint && <p className="text-center text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  )
}
