import { cn } from '@/lib/utils'

// THE single source of status colors (UI design system — circa-ui skill).
// Routes map their domain status → tone here; raw pastel classes
// (bg-green-100 text-green-700…) are banned outside components/ds/.
// Tones (semantic, docs/ui/UI_FOUNDATION_SPEC §2 — measured WCAG pairs):
//   success = hoàn thành / đã duyệt / đã đồng bộ
//   warning = đang xử lý / cần chú ý / chờ duyệt / redo
//   danger  = lỗi / quá hạn / đã hủy
//   neutral = nháp / chưa xử lý / ngừng hoạt động
//   info    = thông tin (đang xử lý bởi X, sắp đến kỳ)
export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info'

const TONE: Record<StatusTone, string> = {
  success: 'bg-status-success-bg text-status-success',
  warning: 'bg-status-warning-bg text-status-warning',
  danger:  'bg-status-danger-bg text-status-danger',
  neutral: 'bg-status-neutral-bg text-status-neutral',
  info:    'bg-status-info-bg text-status-info',
}

export function StatusBadge({
  tone, children, size = 'md', className,
}: {
  tone: StatusTone
  children: React.ReactNode
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded font-medium whitespace-nowrap',
        size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-[11px] px-2 py-0.5',
        // UI v2 (chỉ trong [data-ui-v2]): chip 6px, chấm + chữ — không phụ thuộc phân biệt màu.
        'v2:gap-1.5 v2:rounded-v2-chip',
        size === 'sm' ? 'v2:text-[11px] v2:px-[7px] v2:py-[2px]' : 'v2:text-[12px] v2:px-2 v2:py-[3px]',
        TONE[tone],
        className,
      )}
    >
      <span aria-hidden="true" className="hidden v2:inline-block size-1.5 shrink-0 rounded-full bg-current" />
      {children}
    </span>
  )
}
