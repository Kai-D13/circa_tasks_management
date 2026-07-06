// Campaign "Performance" = pace-normalized run rate (stakeholder 2026-07-06):
// how the store is doing PER ELAPSED DAY vs the per-day KPI target, so a
// mid-campaign store isn't judged against the whole-period target.
//
//   targetPerDay = kpi_target / campaignDays   (inclusive start..end)
//   actualPerDay = actual     / elapsedDays    (inclusive start..min(today,end))
//   performance  = actualPerDay / targetPerDay * 100
//                = (actual * campaignDays) / (elapsedDays * kpi_target) * 100
//
// ≥100 = on/ahead of pace, <100 = behind. Returns null (render "—") when the
// order isn't synced yet, the campaign hasn't started, or there's no target.

const DAY = 86400_000
const inclusiveDays = (startISO: string, endISO: string) =>
  Math.floor((Date.parse(`${endISO}T00:00:00Z`) - Date.parse(`${startISO}T00:00:00Z`)) / DAY) + 1

export function campaignPerformance(
  kpiTarget: number,
  actual: number | null | undefined,
  startISO: string,
  endISO: string,
  todayISO: string,
): number | null {
  if (actual === null || actual === undefined) return null
  const target = Number(kpiTarget) || 0
  if (target <= 0) return null
  const campaignDays = inclusiveDays(startISO, endISO)
  if (campaignDays <= 0) return null
  const effectiveEnd = todayISO < endISO ? todayISO : endISO
  if (todayISO < startISO) return null // not started
  const elapsedDays = inclusiveDays(startISO, effectiveEnd)
  if (elapsedDays <= 0) return null
  return (Number(actual) * campaignDays) / (elapsedDays * target) * 100
}

// Shared badge tone: ≥100 on-pace (green), ≥80 slightly behind (amber), else red.
export function performanceTone(pct: number): string {
  if (pct >= 100) return 'text-green-600'
  if (pct >= 80) return 'text-amber-600'
  return 'text-red-600'
}
