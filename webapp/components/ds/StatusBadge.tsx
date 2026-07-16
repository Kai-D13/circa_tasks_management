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
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
