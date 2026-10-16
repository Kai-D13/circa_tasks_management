import { cn } from '@/lib/utils'
import { normalizeProgress } from '@/lib/ui/progress'
import type { StatusTone } from './StatusBadge'

// Thanh tiến độ chỉ VẼ LẠI số x/y trang đã có (vd "18/25 hoàn thành") — không tự tính nghiệp vụ,
// không truy vấn. `label` là chữ trang đang hiển thị sẵn; thanh là phần trình bày thêm.
// PM audit P1.0 P2: số liệu qua normalizeProgress (kẹp biên, max ≤0 ⇒ không vẽ thanh) và BẮT BUỘC
// `ariaLabel` (tên cho trình đọc màn hình, vì `label` thường là JSX).
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
  /** Tên cho trình đọc màn hình — bắt buộc (vd "18/25 cửa hàng hoàn thành"). */
  ariaLabel: string
  className?: string
}) {
  const p = normalizeProgress(value, max)
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {label && <span className={cn('text-[13px] font-semibold tabular-nums', TEXT[tone])}>{label}</span>}
      {p.valid && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={p.max}
          aria-valuenow={p.value}
          aria-label={ariaLabel}
          className="h-[5px] w-full overflow-hidden rounded-full bg-muted"
        >
          <div className={cn('h-full rounded-full', FILL[tone])} style={{ width: `${p.pct}%` }} />
        </div>
      )}
    </div>
  )
}
