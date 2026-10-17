// UI v2 Phase 2 (K0 ProgressMeter): chọn trạng thái HIỂN THỊ của thanh tiến độ KPI từ cờ của model —
// KHÔNG suy verdict từ số đã làm tròn (vd 99,96% hiện "100%" nhưng chưa đạt).
// Thứ tự PM chốt ở audit K-1 (16/10, §3): unsynced > reached > ended > series.
//   - chưa đồng bộ (actual null) ⇒ 'unsynced': khung nét đứt + '—', không vẽ 0% giả
//   - đạt THẬT (caller truyền từ số thô: actual ≥ target, đạt bậc, hoặc qualityKpiPass của Chất lượng bán hàng)
//     ⇒ 'ok': xanh — KỂ CẢ chiến dịch đã kết thúc
//   - chiến dịch đã kết thúc mà CHƯA đạt ⇒ 'ended': trung tính (--v2-text-3), số đã chốt
//   - còn lại ⇒ 'series': cam chuỗi dữ liệu
export type KpiProgressTone = 'unsynced' | 'ended' | 'ok' | 'series'

export function kpiProgressTone(p: { synced: boolean; ended: boolean; reached: boolean }): KpiProgressTone {
  if (!p.synced) return 'unsynced'
  if (p.reached) return 'ok'
  if (p.ended) return 'ended'
  return 'series'
}

// Thang của TierTrack (K0): 0 → mốc cao nhất + 10 điểm %, tối thiểu 100 (không có bậc ⇒ 0–100).
export function tierTrackScaleMax(thresholds: number[]): number {
  const top = thresholds.reduce((m, t) => (Number.isFinite(t) && t > m ? t : m), 0)
  return Math.max(100, top + 10)
}
