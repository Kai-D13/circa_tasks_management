import { cn } from '@/lib/utils'
import { normalizeProgress } from '@/lib/ui/progress'
import type { StatusTone } from './StatusBadge'

// Thanh tiến độ chỉ VẼ LẠI số x/y trang đã có (vd "18/25 hoàn thành") — không tự tính nghiệp vụ,
// không truy vấn. `label` là chữ trang đang hiển thị sẵn; thanh là phần trình bày thêm.
// PM audit P1.0 P2: số liệu qua normalizeProgress (kẹp biên, max ≤0 ⇒ không vẽ thanh) và BẮT BUỘC
// `ariaLabel` (tên cho trình đọc màn hình, vì `label` thường là JSX).
// Phase 2 KPI (K0): ngoài 5 tone trạng thái còn 3 tone của thanh tiến độ KPI — `series` (cam chuỗi dữ liệu
// chính, đang chạy), `ok` (đạt ≥100% / đạt bậc), `ended` (chiến dịch đã kết thúc: số đã chốt, trung tính).
// Chữ số luôn dùng màu chữ, không dùng màu chuỗi.
export type ProgressTone = StatusTone | 'series' | 'ok' | 'ended'
const TEXT: Record<ProgressTone, string> = {
  success: 'text-status-success', warning: 'text-status-warning', danger: 'text-status-danger',
  info: 'text-status-info', neutral: 'text-foreground',
  series: 'text-foreground', ok: 'text-status-success', ended: 'text-muted-foreground v2:text-v2-text-3',
}
const FILL: Record<ProgressTone, string> = {
  success: 'bg-status-success', warning: 'bg-status-warning', danger: 'bg-status-danger',
  info: 'bg-status-info', neutral: 'bg-status-neutral',
  series: 'bg-primary v2:bg-v2-series', ok: 'bg-status-success v2:bg-v2-ok', ended: 'bg-muted-foreground v2:bg-v2-text-3',
}
// Cao thanh (px literal — root 15px): 5 mặc định (bảng/mini), 6 bảng KPI, 8 mobile, 10 hàng, 12 hero.
export type ProgressSize = 5 | 6 | 8 | 10 | 12
const HEIGHT: Record<ProgressSize, string> = { 5: 'h-[5px]', 6: 'h-[6px]', 8: 'h-[8px]', 10: 'h-[10px]', 12: 'h-[12px]' }

export function ProgressBar({
  value, max, tone = 'success', size = 5, label, ariaLabel, className,
}: {
  value: number
  max: number
  tone?: ProgressTone
  size?: ProgressSize
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
          className={cn(HEIGHT[size], 'w-full overflow-hidden rounded-full bg-muted')}
        >
          <div className={cn('h-full rounded-full', FILL[tone])} style={{ width: `${p.pct}%` }} />
        </div>
      )}
    </div>
  )
}
