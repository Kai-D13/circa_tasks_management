// UI v2 Phase 2 (K0 ProgressMeter): chọn trạng thái HIỂN THỊ của thanh tiến độ KPI từ cờ của model —
// KHÔNG suy verdict từ số đã làm tròn (vd 99,96% hiện "100%" nhưng chưa đạt).
//   - chưa đồng bộ (actual null) ⇒ 'unsynced': khung nét đứt + '—', không vẽ 0% giả
//   - chiến dịch đã kết thúc ⇒ 'ended': xám, số đã chốt (ưu tiên hơn "đạt")
//   - đạt (caller truyền: completion ≥ 100 theo model, đạt bậc, hoặc qualityKpiPass của Chất lượng bán hàng)
//     ⇒ 'ok': xanh
//   - còn lại ⇒ 'series': cam chuỗi dữ liệu
export type KpiProgressTone = 'unsynced' | 'ended' | 'ok' | 'series'

export function kpiProgressTone(p: { synced: boolean; ended: boolean; reached: boolean }): KpiProgressTone {
  if (!p.synced) return 'unsynced'
  if (p.ended) return 'ended'
  if (p.reached) return 'ok'
  return 'series'
}

// Thang của TierTrack (K0): 0 → mốc cao nhất + 10 điểm %, tối thiểu 100 (không có bậc ⇒ 0–100).
export function tierTrackScaleMax(thresholds: number[]): number {
  const top = thresholds.reduce((m, t) => (Number.isFinite(t) && t > m ? t : m), 0)
  return Math.max(100, top + 10)
}
