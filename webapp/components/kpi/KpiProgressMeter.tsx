import { ProgressBar, type ProgressSize } from '@/components/ds/ProgressBar'
import type { KpiProgressTone } from '@/lib/kpi/progressTone'
import { cn } from '@/lib/utils'

// UI v2 Phase 2 (canvas K0 "ProgressMeter — 4 trạng thái"): hàng nhãn + số bên phải, thanh, gợi ý.
// Chỉ TRÌNH BÀY số caller đã tính (campaignDisplay/resultModel) — không tự tính %, không format tiền.
// Trạng thái từ lib/kpi/progressTone.kpiProgressTone (cờ model), không suy từ số làm tròn.
// 'unsynced': khung nét đứt, không vẽ thanh, số LUÔN '—' — không bao giờ 0% giả.
// r1.1 (PM P1): fail-closed — pct null/NaN/Infinity cũng là chưa đồng bộ; khi đó BỎ QUA valueText của caller.
export function KpiProgressMeter({
  label, valueText, pct, tone, size = 8, hint, ariaLabel, className,
}: {
  label: React.ReactNode
  /** Chữ số đã format (vd "40%"). Bị thay bằng '—' khi chưa đồng bộ. */
  valueText: string
  /** % hoàn thành theo model (có thể > 100; thanh tự kẹp). null khi chưa đồng bộ. */
  pct: number | null
  tone: KpiProgressTone
  size?: ProgressSize
  hint?: React.ReactNode
  ariaLabel: string
  className?: string
}) {
  const unsynced = tone === 'unsynced' || pct === null || !Number.isFinite(pct)
  return (
    <div data-kpi-meter={unsynced ? 'unsynced' : tone} className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="min-w-0 text-muted-foreground">{label}</span>
        <span className="shrink-0 font-semibold tabular-nums">{unsynced ? '—' : valueText}</span>
      </div>
      {unsynced ? (
        // Không có role=progressbar: không có giá trị để báo. Chữ '—' ở trên là thông tin.
        <div aria-hidden="true" className={cn(size === 5 ? 'h-[5px]' : size === 6 ? 'h-[6px]' : size === 10 ? 'h-[10px]' : size === 12 ? 'h-[12px]' : 'h-[8px]', 'w-full rounded-full border border-dashed border-input bg-muted')} />
      ) : (
        <ProgressBar value={pct as number} max={100} tone={tone as Exclude<KpiProgressTone, 'unsynced'>} size={size} ariaLabel={ariaLabel} />
      )}
      {hint && <span className="text-[12px] text-muted-foreground v2:text-v2-text-3">{hint}</span>}
    </div>
  )
}
