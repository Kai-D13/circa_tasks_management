import { cn } from '@/lib/utils'
import type { StatusTone } from './StatusBadge'

// Thanh tiến độ chỉ VẼ LẠI số x/y trang đã có (vd "18/25 hoàn thành") — không tự tính nghiệp vụ,
// không truy vấn. `label` là chữ trang đang hiển thị sẵn; thanh là phần trình bày thêm.
const TEXT: Record<StatusTone, string> = {
  success: 'text-status-success', warning: 'text-status-warning', danger: 'text-status-danger',
  info: 'text-status-info', neutral: 'text-foreground',
}
const FILL: Record<StatusTone, string> = {
  success: 'bg-status-success', warning: 'bg-status-warning', danger: 'bg-status-danger',
  info: 'bg-status-info', neutral: 'bg-status-neutral',
}

export function ProgressBar({
  value, max, tone = 'success', label, ariaLabel, className,
}: {
  value: number
  max: number
  tone?: StatusTone
  label?: React.ReactNode
  /** Tên cho trình đọc màn hình khi `label` không phải chuỗi. */
  ariaLabel?: string
  className?: string
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : 0
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {label && <span className={cn('text-[13px] font-semibold tabular-nums', TEXT[tone])}>{label}</span>}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        className="h-[5px] w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={cn('h-full rounded-full', FILL[tone])} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
