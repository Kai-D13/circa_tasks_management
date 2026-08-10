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

// Shared badge tone, from the DS status tokens (dark-mode safe — the old
// text-green-600/amber-600/red-600 had no dark pair). Thresholds unchanged:
// >=100 on-pace (success), >=80 slightly behind (warning), else danger.
export function performanceTone(pct: number): string {
  if (pct >= 100) return 'text-status-success'
  if (pct >= 80) return 'text-status-warning'
  return 'text-status-danger'
}

// ── "Trung bình/ngày cần đạt" (request stakeholder 10/08) ───────────────────
// Công thức LẤY NGUYÊN của màn Staff (CampaignKpiView) để Super/SM và Staff
// không bao giờ lệch số:
//   daysLeft  = số ngày từ hôm nay đến end_date, TÍNH CẢ HÔM NAY
//   remaining = max(kpi_target - actual, 0)
//   perDay    = remaining / max(daysLeft, 1)
// Trả null = KHÔNG XÁC ĐỊNH (chưa đồng bộ actual / campaign đã hết ngày /
// không có target). Hai surface render null KHÁC nhau — có chủ đích:
//   · bảng kết quả (Super/SM): null → '—'
//   · card Staff: `?? 0` để GIỮ NGUYÊN output hiện tại (campaign hết hạn vẫn
//     hiển thị 0₫ như trước — không đổi UI đã được stakeholder duyệt).
// Đã đạt target → 0 (không phải null): "cần đạt thêm 0/ngày" là số thật.
export function requiredPerDay(p: {
  kpiTarget: number
  actual: number | null | undefined
  endISO: string
  todayISO: string
}): number | null {
  if (p.actual === null || p.actual === undefined) return null
  const target = Number(p.kpiTarget) || 0
  if (target <= 0) return null
  const daysLeft = Math.floor((Date.parse(p.endISO) - Date.parse(p.todayISO)) / DAY) + 1
  if (daysLeft <= 0) return null                    // campaign đã hết ngày
  const remaining = Math.max(target - (Number(p.actual) || 0), 0)
  return remaining / Math.max(daysLeft, 1)
}
