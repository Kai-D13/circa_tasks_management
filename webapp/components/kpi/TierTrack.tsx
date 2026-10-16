import type { KpiProgressTone } from '@/lib/kpi/progressTone'
import { tierTrackScaleMax } from '@/lib/kpi/progressTone'
import { cn } from '@/lib/utils'

// UI v2 Phase 2 (canvas K0 "TierTrack — tiến độ + mốc thưởng trên cùng một thanh"). Chỉ TRÌNH BÀY:
//   - % hoàn thành, bậc đã đạt / bậc kế tiếp, mức thưởng từ model hiện có (CampaignKpiView, resultModel
//     tierProgress) — component KHÔNG tính bậc, KHÔNG tính tiền.
//   - Thang thanh = 0 → (mốc cao nhất + 10) điểm % (tierTrackScaleMax); vạch = ngưỡng bậc thật.
//   - Chữ giữ wording đang chạy: "N%", "Thưởng: …"; dòng "còn thiếu" do caller truyền (tierRemainingLine).
//   - Commission ở đây là của STORE (caller giữ câu phân biệt với commission cá nhân).
export interface TierTrackTier { tier_order: number; threshold_pct: number; commission_amount: number }

const FILL: Record<Exclude<KpiProgressTone, 'unsynced'>, string> = {
  series: 'bg-primary v2:bg-v2-series',
  ok: 'bg-status-success v2:bg-v2-ok',
  ended: 'bg-muted-foreground v2:bg-v2-text-3',
}

export function TierTrack({
  pct, pctText, tone, tiers, reachedOrder, nextTierOrder, money, remainingLine, aside, ariaLabel, className,
}: {
  /** % hoàn thành theo model (có thể > 100). null = chưa đồng bộ ⇒ không vẽ phần đã đạt. */
  pct: number | null
  /** Chữ % đã format của caller. Bị thay bằng '—' khi chưa đồng bộ (fail-closed, r1.1). */
  pctText: string
  tone: KpiProgressTone
  tiers: TierTrackTier[]
  reachedOrder: number | null
  nextTierOrder: number | null
  money: (n: number) => string
  remainingLine?: (tierOrder: number) => React.ReactNode
  /** Nội dung bên phải số % (vd "Commission Store dự kiến: …" — chữ hiện có của caller). */
  aside?: React.ReactNode
  ariaLabel: string
  className?: string
}) {
  const sorted = [...tiers].sort((a, b) => a.tier_order - b.tier_order)
  const scaleMax = tierTrackScaleMax(sorted.map((t) => t.threshold_pct))
  const unsynced = tone === 'unsynced' || pct === null || !Number.isFinite(pct)
  const fillPct = unsynced ? 0 : (Math.min(Math.max(pct as number, 0), scaleMax) / scaleMax) * 100
  const at = (threshold: number) => `${(Math.min(Math.max(threshold, 0), scaleMax) / scaleMax) * 100}%`
  // Nhãn % dưới vạch: nhãn quá gần nhãn trước CÙNG hàng (< 12% thang ≈ 36px ở thanh 300px) ⇒ xuống hàng 2.
  const rowOf = new Map<number, 0 | 1>()
  const lastInRow: [number, number] = [-Infinity, -Infinity]
  for (const t of sorted) {
    const p = (Math.min(Math.max(t.threshold_pct, 0), scaleMax) / scaleMax) * 100
    const row: 0 | 1 = p - lastInRow[0] >= 12 ? 0 : 1
    rowOf.set(t.tier_order, row)
    lastInRow[row] = p
  }
  const twoRows = [...rowOf.values()].includes(1)

  return (
    <div data-tier-track className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[28px] font-bold leading-none tabular-nums">{unsynced ? '—' : pctText}</span>
        {aside && <div className="min-w-0 text-[13px] text-muted-foreground">{aside}</div>}
      </div>

      {/* Thanh + vạch bậc: cao 40px (thanh 10px ở giữa, vạch 22px, nhãn % dưới vạch) */}
      <div className={cn('relative', twoRows ? 'h-[54px]' : 'h-[40px]')}>
        {unsynced ? (
          // r1.1 (PM P1): chưa đồng bộ ⇒ phần tiến độ chỉ là TRANG TRÍ (không role progressbar, không công bố 0);
          // vạch mốc vẫn giữ để thấy các ngưỡng. Thông tin là chữ '—' ở trên.
          <div aria-hidden="true" className="absolute inset-x-0 top-[10px] h-[10px] rounded-full border border-dashed border-input bg-muted" />
        ) : (
          <div
            role="progressbar"
            aria-label={ariaLabel}
            aria-valuemin={0}
            aria-valuemax={scaleMax}
            aria-valuenow={Math.min(Math.max(pct as number, 0), scaleMax)}
            aria-valuetext={pctText}
            className="absolute inset-x-0 top-[10px] h-[10px] overflow-hidden rounded-full bg-muted"
          >
            <div data-tier-fill className={cn('h-full rounded-full', FILL[tone as keyof typeof FILL])} style={{ width: `${fillPct}%` }} />
          </div>
        )}
        {sorted.map((t) => (
          <div key={t.tier_order} aria-hidden="true">
            <span data-tier-mark={t.threshold_pct} className="absolute top-[4px] h-[22px] w-[2px] -translate-x-1/2 bg-muted-foreground" style={{ left: at(t.threshold_pct) }} />
            <span
              data-tier-label-row={rowOf.get(t.tier_order)}
              className={cn('absolute -translate-x-1/2 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground', rowOf.get(t.tier_order) === 1 ? 'top-[41px]' : 'top-[28px]')}
              style={{ left: at(t.threshold_pct) }}
            >
              {t.threshold_pct}%
            </span>
          </div>
        ))}
      </div>

      {/* Thẻ bậc: ≤4 bậc lưới ngang (artboard), 5+ bậc danh sách dọc để 360px không thành vụn */}
      {sorted.length > 0 && (
        <div
          className={cn(sorted.length <= 4 ? 'grid gap-2' : 'flex flex-col gap-1.5')}
          style={sorted.length <= 4 ? { gridTemplateColumns: `repeat(${sorted.length}, minmax(0, 1fr))` } : undefined}
        >
          {sorted.map((t) => {
            const reached = reachedOrder !== null && t.tier_order <= reachedOrder
            const isNext = !reached && nextTierOrder === t.tier_order
            return (
              <div
                key={t.tier_order}
                data-tier-card={reached ? 'reached' : isNext ? 'next' : 'pending'}
                className={cn(
                  'flex min-w-0 flex-col gap-0.5 rounded-v2-control border px-3 py-2.5',
                  sorted.length > 4 && 'flex-row items-center justify-between gap-3',
                  reached && 'border-status-success/40 bg-status-success-bg',
                  isNext && 'border-primary bg-secondary v2:border-v2-selected-line v2:bg-accent',
                )}
              >
                <span className={cn('text-[15px] font-bold tabular-nums', reached && 'text-status-success')}>{t.threshold_pct}%</span>
                <div className={cn('min-w-0', sorted.length > 4 && 'text-right')}>
                  <p className="text-[12px] text-muted-foreground">
                    Thưởng: <span className="font-semibold tabular-nums text-foreground">{money(t.commission_amount)}</span>
                  </p>
                  {remainingLine?.(t.tier_order)}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
