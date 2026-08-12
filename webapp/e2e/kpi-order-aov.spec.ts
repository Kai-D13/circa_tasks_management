import { test, expect } from '@playwright/test'
import {
  ORDER_AOV_STATUS_LABEL, aovFromSnapshot, computeOrderAovResult, countQualityKpiPass,
  qualityKpiPass, round4, targetScore,
} from '../lib/kpi/orderAov'

// Mig 106 — ma trận công thức "Chất lượng bán hàng" (90% số đơn + 10% AOV).
// Module TS là bản soi gương của RPC (nguồn sự thật); test này khóa công thức
// để đổi một phía mà quên phía kia là ĐỎ ngay.

// Cấu hình mẫu dễ tính tay: sàn 100 đơn / AOV 100.000đ, mục tiêu 120 đơn /
// 110.000đ ⇒ target_score = 0.9×1.2 + 0.1×1.1 = 1.19.
const T = { orderFloor: 100, aovFloor: 100_000, orderTarget: 120, aovTarget: 110_000 }
const TIERS = [
  { tier_order: 1, threshold_pct: 90, commission_amount: 1_000_000 },
  { tier_order: 2, threshold_pct: 100, commission_amount: 2_000_000 },
  { tier_order: 3, threshold_pct: 105, commission_amount: 3_000_000 },
]
const run = (actualOrder: number, actualNet: number, tiers = TIERS) =>
  computeOrderAovResult({ ...T, actualOrder, actualNet, tiers })

test.describe('kpi order/aov core (106) @desktop', () => {
  test('target_score = 0.9×(order_target/floor) + 0.1×(aov_target/floor)', () => {
    expect(targetScore(T)).toBeCloseTo(1.19, 10)
    // đổi trọng số là đổi tiền thưởng — khóa cứng tỉ lệ 90/10
    expect(targetScore({ orderFloor: 100, aovFloor: 100, orderTarget: 200, aovTarget: 100 }))
      .toBeCloseTo(0.9 * 2 + 0.1 * 1, 10)
  })

  test('đúng mục tiêu cả 2 chỉ số → completion = 100% + đạt bậc 2', () => {
    // 120 đơn × 110.000đ = 13.200.000đ ⇒ AOV đúng 110.000
    const r = run(120, 13_200_000)
    expect(r.actualAov).toBe(110_000)
    expect(r.completionPct).toBe(100)
    expect(r.floorPass).toBe(true)
    expect(r.kpiPass).toBe(true)
    expect(r.status).toBe('achieved')
    expect(r.achievedTierOrder).toBe(2)
    expect(r.commissionPool).toBe(2_000_000)
    expect(r.remainingPct).toBe(0)
  })

  test('BẰNG floor là PASS (>=) — không phải "phải vượt"', () => {
    // đúng 100 đơn, AOV đúng 100.000 ⇒ actual_score = 1.0 → 84,03%
    const r = run(100, 10_000_000)
    expect(r.orderFloorPass).toBe(true)
    expect(r.aovFloorPass).toBe(true)
    expect(r.floorPass).toBe(true)
    expect(r.completionPct).toBe(round4((1 / 1.19) * 100))
    expect(r.completionPct).toBeCloseTo(84.0336, 4)
    expect(r.kpiPass).toBe(false)          // qua sàn nhưng chưa tới 100%
    expect(r.status).toBe('in_progress')
    expect(r.achievedTierOrder).toBeNull() // dưới bậc 1 (90%)
  })

  test('dưới sàn 1 ĐƠN → thủng sàn số đơn, KHÔNG tier dù điểm rất cao', () => {
    // 99 đơn nhưng AOV cực cao ⇒ điểm vượt 100% nhờ bù trừ
    const r = run(99, 99 * 400_000)
    expect(r.completionPct).toBeGreaterThan(100)
    expect(r.orderFloorPass).toBe(false)
    expect(r.floorPass).toBe(false)
    expect(r.kpiPass).toBe(false)
    expect(r.status).toBe('below_order_floor')
    expect(r.achievedTierOrder).toBeNull()   // ĐIỀU KIỆN CẦN: qua CẢ 2 sàn
    expect(r.commissionPool).toBeNull()
  })

  test('dưới sàn AOV 1 ĐỒNG → thủng sàn AOV, KHÔNG tier dù nhiều đơn', () => {
    // 200 đơn, AOV 99.999,995 (< 100.000) ⇒ điểm cao nhưng thủng sàn AOV
    const r = run(200, 200 * 100_000 - 1)
    expect(r.actualAov!).toBeLessThan(100_000)
    expect(r.completionPct).toBeGreaterThan(100)
    expect(r.aovFloorPass).toBe(false)
    expect(r.status).toBe('below_aov_floor')
    expect(r.achievedTierOrder).toBeNull()
  })

  test('thủng CẢ 2 sàn → below_both_floors', () => {
    const r = run(50, 50 * 90_000)
    expect(r.orderFloorPass).toBe(false)
    expect(r.aovFloorPass).toBe(false)
    expect(r.status).toBe('below_both_floors')
    expect(r.kpiPass).toBe(false)
  })

  test('BÙ TRỪ sau khi qua sàn: thiếu đơn nhưng AOV cao vẫn đạt KPI', () => {
    // 110 đơn (>= sàn 100), AOV 200.000 (>= sàn 100.000)
    // score = 0.9×1.1 + 0.1×2 = 1.19 = target ⇒ đúng 100%
    const r = run(110, 110 * 200_000)
    expect(r.completionPct).toBe(100)
    expect(r.floorPass).toBe(true)
    expect(r.kpiPass).toBe(true)
    expect(r.achievedTierOrder).toBe(2)
  })

  test('0 đơn → completion 0%, AOV null, no_orders, không tier (chốt 11/08)', () => {
    const r = run(0, 0)
    expect(r.actualAov).toBeNull()
    expect(r.completionPct).toBe(0)
    expect(r.floorPass).toBe(false)
    expect(r.status).toBe('no_orders')
    expect(ORDER_AOV_STATUS_LABEL[r.status]).toBe('Chưa phát sinh đơn')
    expect(r.achievedTierOrder).toBeNull()
    expect(r.remainingPct).toBe(100)
  })

  test('0 đơn mà nguồn vẫn có doanh thu → VẪN 0% + AOV null (không chia 0)', () => {
    const r = run(0, 5_000_000)
    expect(r.completionPct).toBe(0)
    expect(r.actualAov).toBeNull()
    expect(Number.isFinite(r.actualScore)).toBe(true)
  })

  test('tier: lấy bậc CAO NHẤT đạt được, không cộng dồn', () => {
    // completion ~107% ⇒ bậc 3
    const r = run(130, 130 * 115_000)
    expect(r.completionPct).toBeGreaterThan(105)
    expect(r.achievedTierOrder).toBe(3)
    expect(r.commissionPool).toBe(3_000_000)
    // 95% ⇒ chỉ bậc 1
    const r2 = run(114, 114 * 104_500)
    expect(r2.completionPct).toBeGreaterThanOrEqual(90)
    expect(r2.completionPct).toBeLessThan(100)
    expect(r2.achievedTierOrder).toBe(1)
    expect(r2.commissionPool).toBe(1_000_000)
    // đạt bậc 1 KHÔNG có nghĩa là đạt KPI
    expect(r2.kpiPass).toBe(false)
  })

  test('không có bậc nào → tier null, commission null (không suy ra 0đ)', () => {
    const r = run(120, 13_200_000, [])
    expect(r.achievedTierOrder).toBeNull()
    expect(r.commissionPool).toBeNull()
    expect(r.kpiPass).toBe(true)           // vẫn đạt KPI dù campaign không có bậc
  })

  test('remaining = số điểm % còn thiếu để chạm 100 (không âm)', () => {
    expect(run(100, 10_000_000).remainingPct).toBeCloseTo(15.9664, 4)
    expect(run(130, 130 * 115_000).remainingPct).toBe(0)
  })

  test('làm tròn: completion giữ 4 chữ số (khớp round(x,4) của Postgres)', () => {
    const r = run(107, 107 * 103_333)
    expect(r.completionPct).toBe(round4(r.completionPct))
    expect(String(r.completionPct).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(4)
  })

  test('cấu hình sai (floor = 0) → THROW, không trả NaN/Infinity ra màn tiền', () => {
    expect(() => computeOrderAovResult({
      ...T, orderFloor: 0, actualOrder: 10, actualNet: 1_000_000,
    })).toThrow(/order_floor/)
    expect(() => computeOrderAovResult({
      ...T, aovFloor: 0, actualOrder: 10, actualNet: 1_000_000,
    })).toThrow(/aov_floor/)
  })

  test('kpi_pass suy lúc ĐỌC: floor_pass AND completion >= 100 — KHÔNG suy từ tier', () => {
    expect(qualityKpiPass(true, 100)).toBe(true)
    expect(qualityKpiPass(true, 99.9999)).toBe(false)
    expect(qualityKpiPass(false, 150)).toBe(false)   // thủng sàn dù điểm cao
    expect(qualityKpiPass(null, 150)).toBe(false)    // campaign loại khác → false
    expect(qualityKpiPass(true, null)).toBe(false)   // chưa sync → false
    // "X/Y cửa hàng đạt" của màn danh sách
    expect(countQualityKpiPass([
      { quality_floor_pass: true, actual_value: 120 },     // đạt
      { quality_floor_pass: true, actual_value: 95 },      // qua sàn, chưa 100
      { quality_floor_pass: false, actual_value: 130 },    // thủng sàn
      { quality_floor_pass: null, actual_value: 130 },     // chưa có dữ liệu
    ])).toBe(1)
  })

  test('AOV đọc từ snapshot: weighted per store; 0/null đơn → null', () => {
    expect(aovFromSnapshot(54_140_774, 343)).toBeCloseTo(157_844.82, 2)
    expect(aovFromSnapshot(500, 0)).toBeNull()
    expect(aovFromSnapshot(500, null)).toBeNull()
    expect(aovFromSnapshot(null, 10)).toBe(0)
  })
})
