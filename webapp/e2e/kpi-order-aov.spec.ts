import { test, expect } from '@playwright/test'
import {
  ORDER_AOV_STATUS_LABEL, ORDER_AOV_VERDICT, aovFromSnapshot, computeOrderAovResult,
  countQualityKpiPass, exactlyOneTierAt100, formatCompletionPct, formatRemainingPct,
  normalizeOptionalCount, orderAovDualView, orderAovStatus, orderAovVerdict,
  qualityKpiPass, round4,
} from '../lib/kpi/orderAov'
import { normalizeDailyPoint } from '../lib/kpi/dailyPoint'

// Mig 106 — ma trận công thức "Chất lượng bán hàng" theo CONTRACT CHỐT 12/08:
//   completion = min(order/order_target, aov/aov_target) × 100  (CHỈ SỐ YẾU HƠN)
//   kpi_pass   = order >= order_target AND aov >= aov_target
// KHÔNG floor, KHÔNG trọng số 90/10, KHÔNG bù trừ, KHÔNG cap 100%.
// Module TS là bản soi gương của RPC (nguồn sự thật) — đổi một phía mà quên
// phía kia là ĐỎ ngay.

// Cấu hình mẫu dễ tính tay: mục tiêu 1.000 đơn × AOV 200.000đ.
const T = { orderTarget: 1000, aovTarget: 200_000 }
const TIER100 = [{ tier_order: 1, threshold_pct: 100, commission_amount: 20_800_000 }]
const run = (actualOrder: number, actualNet: number, tiers = TIER100) =>
  computeOrderAovResult({ ...T, actualOrder, actualNet, tiers })

// 3 fixture Finance (12/08) — order_target/aov_target thật + net_revenue tham
// chiếu. net ≠ order_target × aov_target vì AOV đã làm tròn VNĐ ⇒ KHÔNG dùng
// net làm "target thứ 5", chỉ dùng để dựng số thực tế.
const FINANCE = [
  { store: 'SIGNATURE', pos: 'POS0018', orderTarget: 1046, aovTarget: 194_046, net: 203_039_424 },
  { store: 'MIZUKI', pos: 'POS0013', orderTarget: 1187, aovTarget: 126_644, net: 150_321_724 },
  { store: 'SYMPHONY', pos: 'POS0065', orderTarget: 586, aovTarget: 226_762, net: 132_777_603 },
]

test.describe('kpi order/aov core (106) @desktop', () => {
  test('ĐẠT ĐÚNG cả 2 mục tiêu → completion = 100%, đạt bậc 100, KPI pass', () => {
    const r = run(1000, 1000 * 200_000)
    expect(r.actualAov).toBe(200_000)
    expect(r.orderRatio).toBe(1)
    expect(r.aovRatio).toBe(1)
    expect(r.completionPct).toBe(100)
    expect(r.kpiPass).toBe(true)
    expect(r.status).toBe('achieved')
    expect(r.achievedTierOrder).toBe(1)
    expect(r.commissionPool).toBe(20_800_000)
    expect(r.remainingPct).toBe(0)
  })

  test('completion = CHỈ SỐ YẾU HƠN (min), KHÔNG bù trừ', () => {
    // đơn 120% mục tiêu nhưng AOV chỉ 80% ⇒ điểm = 80%, KHÔNG phải 100%
    const r = run(1200, 1200 * 160_000)
    expect(r.orderRatio).toBeCloseTo(1.2, 10)
    expect(r.aovRatio).toBeCloseTo(0.8, 10)
    expect(r.completionPct).toBe(80)
    expect(r.kpiPass).toBe(false)
    expect(r.status).toBe('below_aov_target')
    expect(r.achievedTierOrder).toBeNull()      // commission chỉ khi >= 100
    expect(r.commissionPool).toBeNull()
    expect(r.remainingPct).toBe(20)
  })

  test('CHỈ đạt số đơn → chưa đạt; CHỈ đạt AOV → chưa đạt', () => {
    const onlyOrder = run(1100, 1100 * 180_000)   // order 110%, aov 90%
    expect(onlyOrder.orderPass).toBe(true)
    expect(onlyOrder.aovPass).toBe(false)
    expect(onlyOrder.kpiPass).toBe(false)
    expect(onlyOrder.completionPct).toBe(90)
    expect(onlyOrder.status).toBe('below_aov_target')

    const onlyAov = run(900, 900 * 220_000)       // order 90%, aov 110%
    expect(onlyAov.orderPass).toBe(false)
    expect(onlyAov.aovPass).toBe(true)
    expect(onlyAov.kpiPass).toBe(false)
    expect(onlyAov.completionPct).toBe(90)
    expect(onlyAov.status).toBe('below_order_target')
  })

  test('vượt CẢ HAI → completion > 100% (KHÔNG cap)', () => {
    const r = run(1150, 1150 * 240_000)           // order 115%, aov 120%
    expect(r.completionPct).toBe(115)             // min = 115
    expect(r.kpiPass).toBe(true)
    expect(r.status).toBe('achieved')
    expect(r.achievedTierOrder).toBe(1)
  })

  test('BẰNG mục tiêu là ĐẠT (>=), thiếu 1 đơn / 1 đồng là CHƯA', () => {
    expect(run(1000, 1000 * 200_000).kpiPass).toBe(true)
    expect(run(999, 999 * 200_000).kpiPass).toBe(false)
    // INVARIANT TIỀN: hụt 1 đồng ⇒ round4 sẽ ra đúng 100, nhưng completion
    // KHÔNG được chạm 100 khi chưa đạt (nếu không commission mở khoá oan).
    const oneDong = run(1000, 1000 * 200_000 - 1)
    expect(oneDong.aovPass).toBe(false)
    expect(oneDong.completionPct).toBe(99.9999)
    expect(oneDong.completionPct).toBeLessThan(100)
    expect(oneDong.commissionPool).toBeNull()
    expect(qualityKpiPass(oneDong.completionPct)).toBe(false)   // suy lúc đọc cũng đúng
  })

  test('thiếu cả 2 mục tiêu → below_both_targets', () => {
    const r = run(500, 500 * 150_000)
    expect(r.status).toBe('below_both_targets')
    expect(ORDER_AOV_STATUS_LABEL[r.status]).toBe('Chưa đạt cả 2 mục tiêu')
    expect(r.completionPct).toBe(50)              // min(0.5, 0.75)
  })

  test('0 đơn + 0 doanh thu → 0%, AOV null, "Chưa phát sinh đơn", không tier', () => {
    const r = run(0, 0)
    expect(r.actualAov).toBeNull()
    expect(r.aovRatio).toBeNull()
    expect(r.completionPct).toBe(0)
    expect(r.kpiPass).toBe(false)
    expect(r.status).toBe('no_orders')
    expect(ORDER_AOV_STATUS_LABEL[r.status]).toBe('Chưa phát sinh đơn')
    expect(r.achievedTierOrder).toBeNull()
    expect(r.remainingPct).toBe(100)
  })

  test('0 đơn mà CÓ doanh thu → THROW (nguồn mâu thuẫn, fail-closed cùng RPC)', () => {
    expect(() => run(0, 5_000_000)).toThrow(/0 đơn nhưng actual_net khác 0/)
    expect(() => run(0, -1)).toThrow(/nguồn mâu thuẫn/)
  })

  test('Net Revenue ÂM giữ nguyên, KHÔNG clamp — AOV âm ⇒ không đạt', () => {
    const r = run(100, -20_000_000)
    expect(r.actualAov).toBe(-200_000)
    expect(r.aovPass).toBe(false)
    expect(r.completionPct).toBeLessThan(0)       // min = tỉ lệ AOV âm
    expect(r.kpiPass).toBe(false)
    expect(r.remainingPct).toBe(200)              // 100 − (−100), không bao giờ âm
  })

  test('commission CHỈ khi completion >= 100 (99,99% vẫn = 0)', () => {
    const almost = run(1000, 1000 * 200_000 - 1000)   // AOV 199.999 ⇒ 99,9995%
    expect(almost.completionPct).toBeLessThan(100)
    expect(almost.commissionPool).toBeNull()
    expect(run(1000, 1000 * 200_000).commissionPool).toBe(20_800_000)
  })

  test('campaign không có bậc → vẫn đạt KPI nhưng commission null', () => {
    const r = run(1000, 1000 * 200_000, [])
    expect(r.kpiPass).toBe(true)
    expect(r.achievedTierOrder).toBeNull()
    expect(r.commissionPool).toBeNull()
  })

  // Chính xác điều audit cảnh báo: net_revenue của Finance KHÔNG bằng
  // order_target × aov_target (AOV đã làm tròn VNĐ) ⇒ đủ số đơn mục tiêu mà
  // dùng net tham chiếu thì 2/3 store VẪN chưa đạt AOV. net chỉ để tham khảo.
  test('FIXTURE FINANCE: đủ số đơn mục tiêu + net tham chiếu → chỉ SIGNATURE đạt', () => {
    const expected: Record<string, { completion: number; pass: boolean; status: string }> = {
      SIGNATURE: { completion: 100, pass: true, status: 'achieved' },
      MIZUKI: { completion: 99.9969, pass: false, status: 'below_aov_target' },
      SYMPHONY: { completion: 99.9210, pass: false, status: 'below_aov_target' },
    }
    for (const f of FINANCE) {
      const r = computeOrderAovResult({
        orderTarget: f.orderTarget, aovTarget: f.aovTarget,
        actualOrder: f.orderTarget, actualNet: f.net, tiers: TIER100,
      })
      const e = expected[f.store]
      expect(r.orderRatio, f.store).toBe(1)
      expect(r.completionPct, f.store).toBe(e.completion)
      expect(r.kpiPass, f.store).toBe(e.pass)
      expect(r.status, f.store).toBe(e.status)
      expect(r.achievedTierOrder, f.store).toBe(e.pass ? 1 : null)
    }
  })

  test('FIXTURE FINANCE: thiếu 1 đơn → completion theo tỉ lệ đơn, KHÔNG đạt', () => {
    const f = FINANCE[0]   // SIGNATURE 1046 đơn
    const r = computeOrderAovResult({
      orderTarget: f.orderTarget, aovTarget: f.aovTarget,
      actualOrder: f.orderTarget - 1, actualNet: f.net, tiers: TIER100,
    })
    expect(r.orderPass).toBe(false)
    expect(r.completionPct).toBe(round4(((f.orderTarget - 1) / f.orderTarget) * 100))
    expect(r.completionPct).toBeCloseTo(99.9044, 4)
    expect(r.kpiPass).toBe(false)
    expect(r.status).toBe('below_order_target')
  })

  test('làm tròn 4 chữ số khớp round(x,4) Postgres — kể cả số ÂM (away-from-zero)', () => {
    expect(round4(1.23455)).toBe(1.2346)
    expect(round4(-1.23455)).toBe(-1.2346)
    expect(round4(-0)).toBe(0)
    const r = run(1007, 1007 * 203_333)
    expect(r.completionPct).toBe(round4(r.completionPct))
  })

  test('cấu hình sai → THROW, không trả NaN/Infinity ra màn tiền', () => {
    const base = { actualOrder: 10, actualNet: 1_000_000 }
    expect(() => computeOrderAovResult({ ...T, orderTarget: 0, ...base })).toThrow(/order_target/)
    expect(() => computeOrderAovResult({ ...T, aovTarget: 0, ...base })).toThrow(/aov_target/)
    expect(() => computeOrderAovResult({ ...T, orderTarget: 10.5, ...base })).toThrow(/số nguyên/)
    expect(() => computeOrderAovResult({ ...T, actualOrder: 10.5, actualNet: 1 })).toThrow(/actual_order/)
    expect(() => computeOrderAovResult({ ...T, actualOrder: 10, actualNet: Number.NaN })).toThrow(/actual_net/)
  })

  test('policy tier: ĐÚNG 1 bậc mốc 100 — nhiều bậc / mốc khác đều bị từ chối', () => {
    expect(exactlyOneTierAt100([{ threshold_pct: 100, commission_amount: 20_800_000 }])).toEqual({ ok: true })
    const none = exactlyOneTierAt100([])
    expect(none.ok).toBe(false)
    const two = exactlyOneTierAt100([
      { threshold_pct: 100, commission_amount: 1 }, { threshold_pct: 105, commission_amount: 2 },
    ])
    expect(two.ok).toBe(false)
    if (!two.ok) expect(two.error).toContain('ĐÚNG 1 bậc')
    const wrong = exactlyOneTierAt100([{ threshold_pct: 90, commission_amount: 1 }])
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.error).toContain('100%')
  })

  test('kpi_pass suy lúc ĐỌC = completion >= 100 (KHÔNG suy từ tier)', () => {
    expect(qualityKpiPass(100)).toBe(true)
    expect(qualityKpiPass(115)).toBe(true)
    expect(qualityKpiPass(99.9999)).toBe(false)
    expect(qualityKpiPass(null)).toBe(false)      // chưa sync
    expect(qualityKpiPass(undefined)).toBe(false)
    expect(countQualityKpiPass([
      { actual_value: 120 }, { actual_value: 100 }, { actual_value: 99.9 }, { actual_value: null },
    ])).toBe(2)
  })

  test('orderAovStatus thuần: mọi tổ hợp đều có nhãn tiếng Việt rõ nghĩa', () => {
    const combos: [{ actualOrder: number; orderPass: boolean; aovPass: boolean }, string][] = [
      [{ actualOrder: 0, orderPass: false, aovPass: false }, 'Chưa phát sinh đơn'],
      [{ actualOrder: 5, orderPass: false, aovPass: false }, 'Chưa đạt cả 2 mục tiêu'],
      [{ actualOrder: 5, orderPass: false, aovPass: true }, 'Chưa đạt mục tiêu số đơn'],
      [{ actualOrder: 5, orderPass: true, aovPass: false }, 'Chưa đạt mục tiêu AOV'],
      [{ actualOrder: 5, orderPass: true, aovPass: true }, 'Đạt KPI'],
    ]
    for (const [x, label] of combos) {
      expect(ORDER_AOV_STATUS_LABEL[orderAovStatus(x)]).toBe(label)
    }
  })

  test('AOV đọc từ snapshot: weighted per store; 0/null đơn → null', () => {
    expect(aovFromSnapshot(54_140_774, 343)).toBeCloseTo(157_844.82, 2)
    expect(aovFromSnapshot(500, 0)).toBeNull()
    expect(aovFromSnapshot(500, null)).toBeNull()
    expect(aovFromSnapshot(null, 10)).toBe(0)
  })

  // ── r1.1 (audit P1#3): hiển thị KHÔNG được mâu thuẫn với badge/commission ──
  test('formatCompletionPct: chưa đạt thì KHÔNG BAO GIỜ render 100%', () => {
    // engine ép ca hụt cực nhỏ về 99.9999 — làm tròn 1 chữ số sẽ ra '100,0%'
    expect(formatCompletionPct(99.9999)).toBe('<100%')
    expect(formatCompletionPct(99.96)).toBe('<100%')      // round → 100,0
    expect(formatCompletionPct(99.94)).toBe('99,9%')
    expect(formatCompletionPct(100)).toBe('100%')
    expect(formatCompletionPct(115.26)).toBe('115,3%')
    expect(formatCompletionPct(0)).toBe('0%')
    expect(formatCompletionPct(null)).toBe('—')
    expect(formatCompletionPct(undefined)).toBe('—')
    // đồng bộ với badge: cùng một nguồn quyết định
    const almost = run(1000, 1000 * 200_000 - 1)
    expect(qualityKpiPass(almost.completionPct)).toBe(false)
    expect(formatCompletionPct(almost.completionPct)).toBe('<100%')
  })

  // ── r1.2 (audit P0): pipeline raw Supabase row → DailyPoint ───────────────
  // Bug đã xảy ra: query lấy offline_order_count nhưng .map() bỏ quên ⇒ DB có
  // dữ liệu mà UI hiểu là thiếu (card '—', chart trống). Khóa cả ma trận kiểu.
  test('normalizeDailyPoint: 12 / "12" / 0 / "0" / null / thiếu field / rác', () => {
    const base = { date: '2026-08-12', gmv: 1_000_000, gmv_affiliate: 0, affiliate_customer_count: 0 }
    expect(normalizeDailyPoint({ ...base, offline_order_count: 12 }).offline_order_count).toBe(12)
    expect(normalizeDailyPoint({ ...base, offline_order_count: '12' }).offline_order_count).toBe(12)
    // 0 là DỮ LIỆU HỢP LỆ (ngày không có đơn) — không được biến thành null
    expect(normalizeDailyPoint({ ...base, offline_order_count: 0 }).offline_order_count).toBe(0)
    expect(normalizeDailyPoint({ ...base, offline_order_count: '0' }).offline_order_count).toBe(0)
    // null/thiếu = nguồn CHƯA có số đơn — không được biến thành 0
    expect(normalizeDailyPoint({ ...base, offline_order_count: null }).offline_order_count).toBeNull()
    expect(normalizeDailyPoint(base).offline_order_count).toBeNull()
    expect(normalizeDailyPoint({ ...base, offline_order_count: '' }).offline_order_count).toBeNull()
    expect(normalizeDailyPoint({ ...base, offline_order_count: 'abc' }).offline_order_count).toBeNull()
    // tiền vẫn giữ hành vi cũ (numeric string của Supabase)
    expect(normalizeDailyPoint({ ...base, gmv: '2500000' }).gmv).toBe(2_500_000)
    expect(normalizeDailyPoint({ ...base, gmv: null }).gmv).toBe(0)
  })

  test('normalizeOptionalCount: phân biệt 0 với "chưa có dữ liệu"', () => {
    expect(normalizeOptionalCount(0)).toBe(0)
    expect(normalizeOptionalCount('0')).toBe(0)
    expect(normalizeOptionalCount(343)).toBe(343)
    expect(normalizeOptionalCount(null)).toBeNull()
    expect(normalizeOptionalCount(undefined)).toBeNull()
    expect(normalizeOptionalCount('')).toBeNull()
    expect(normalizeOptionalCount('x')).toBeNull()
    expect(normalizeOptionalCount(Number.NaN)).toBeNull()
  })

  // ── r1.2 (audit P1): phần CÒN THIẾU có formatter RIÊNG ────────────────────
  test('formatRemainingPct: 0 là 0%, hụt tí xíu là <0,1% (không bao giờ "0%")', () => {
    expect(formatRemainingPct(0)).toBe('0%')
    expect(formatRemainingPct(-5)).toBe('0%')          // vượt mục tiêu
    expect(formatRemainingPct(0.0001)).toBe('<0,1%')   // ca 99,9999%
    expect(formatRemainingPct(0.09)).toBe('<0,1%')
    expect(formatRemainingPct(0.1)).toBe('0,1%')
    expect(formatRemainingPct(33.0784)).toBe('33,1%')
    expect(formatRemainingPct(null)).toBe('—')
    // đồng bộ: completion 99,9999 ⇒ remaining 0,0001 ⇒ '<0,1%', KHÔNG '0%'
    const almost = run(1000, 1000 * 200_000 - 1)
    expect(formatCompletionPct(almost.completionPct)).toBe('<100%')
    expect(formatRemainingPct(almost.remainingPct)).toBe('<0,1%')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Commit 5 — HAI CHỈ SỐ ĐỘC LẬP (bỏ điểm gộp khỏi UI)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('order/aov — hai chỉ số độc lập @desktop', () => {
  const T = { orderTarget: 900, aovTarget: 200_000 }
  const view = (orders: number | null, net: number | null, synced = true) =>
    orderAovDualView({ actualOrder: orders, actualNet: net, ...T, synced })

  test('mỗi chỉ số có % RIÊNG, không cap 100', () => {
    // 1.080 đơn / 900 = 120% · AOV 250.000 / 200.000 = 125%
    const v = view(1080, 1080 * 250_000)!
    expect(v.order.pctRaw).toBeCloseTo(120, 6)
    expect(v.aov.pctRaw).toBeCloseTo(125, 6)
    expect(v.order.pctText).toBe('120%')
    expect(v.aov.pctText).toBe('125%')
    // Không có chỗ nào ép về 100 — đây chính là điều stakeholder yêu cầu.
    expect(v.order.pctRaw!).toBeGreaterThan(100)
  })

  test('ĐẠT chỉ khi CẢ HAI đạt — vượt một chỉ số không bù cho chỉ số kia', () => {
    expect(view(1080, 1080 * 250_000)!.overallPass).toBe(true)   // cả hai vượt
    expect(view(1080, 1080 * 150_000)!.overallPass).toBe(false)  // đơn vượt, AOV hụt
    expect(view(500, 500 * 250_000)!.overallPass).toBe(false)    // AOV vượt, đơn hụt
    expect(view(900, 900 * 200_000)!.overallPass).toBe(true)     // bằng đúng mục tiêu = ĐẠT
  })

  test('đạt/chưa đạt của UI PHẢI trùng điều kiện trả thưởng (completion >= 100)', () => {
    // Đây là bất biến chống lệch giữa màn hình và tiền: badge "Đạt KPI" mà
    // không có commission (hoặc ngược lại) là lỗi nghiêm trọng nhất của module.
    const cases: [number, number][] = [
      [900, 900 * 200_000],          // bằng đúng cả hai
      [899, 899 * 200_000],          // hụt 1 đơn
      [900, 900 * 199_999],          // hụt 1đ AOV
      [1080, 1080 * 250_000],        // vượt cả hai
      [1080, 1080 * 150_000],        // vượt đơn, hụt AOV
      [500, 500 * 250_000],          // hụt đơn, vượt AOV
      [900, 900 * 200_000 - 1],      // hụt CỰC NHỎ — ca làm tròn nguy hiểm nhất
      [1, 200_000],                  // 1 đơn đúng AOV, đơn hụt nặng
    ]
    for (const [orders, net] of cases) {
      const dual = view(orders, net)!
      const engine = computeOrderAovResult({ ...T, actualOrder: orders, actualNet: net })
      expect(dual.overallPass, `orders=${orders} net=${net}`).toBe(qualityKpiPass(engine.completionPct))
    }
  })

  test('0 đơn: AOV null → "—", KHÔNG chia 0, và chưa đạt', () => {
    const v = view(0, 0)!
    expect(v.order.actual).toBe(0)
    expect(v.order.pctText).toBe('0%')
    expect(v.aov.actual).toBeNull()
    expect(v.aov.pctText).toBe('—')
    expect(v.aov.valueText).toBe('— / 200.000₫')
    expect(v.overallPass).toBe(false)
  })

  test('chưa đồng bộ: MỤC TIÊU vẫn hiện, thực tế là "—", không bịa 0%', () => {
    // Snapshot partial còn số đơn kỳ trước mà điểm đã null — format thẳng sẽ
    // hiện "1.046 / 900 đơn" ngay cạnh chữ "Chưa đồng bộ".
    const v = view(1046, 1046 * 250_000, false)!
    expect(v.synced).toBe(false)
    expect(v.order.actual).toBeNull()
    expect(v.order.valueText).toBe('— / 900 đơn')
    expect(v.aov.valueText).toBe('— / 200.000₫')
    expect(v.order.pctText).toBe('—')
    expect(orderAovVerdict(v)).toBe(ORDER_AOV_VERDICT.unsynced)
  })

  test('hụt sát 100 hiện "<100%" ở CHÍNH dòng bị hụt, không làm tròn lên', () => {
    const v = view(900, 900 * 200_000 - 1)!
    expect(v.order.pctText).toBe('100%')     // số đơn đạt đủ
    expect(v.aov.pctText).toBe('<100%')      // AOV hụt 1đ ⇒ không được ra '100%'
    expect(v.overallPass).toBe(false)
    expect(orderAovVerdict(v)).toBe(ORDER_AOV_VERDICT.fail)
  })

  test('chưa cấu hình đủ hai mục tiêu → null (không dựng dòng rỗng)', () => {
    expect(orderAovDualView({ actualOrder: 10, actualNet: 1000, orderTarget: null, aovTarget: 200_000, synced: true })).toBeNull()
    expect(orderAovDualView({ actualOrder: 10, actualNet: 1000, orderTarget: 900, aovTarget: null, synced: true })).toBeNull()
  })

  test('verdict: đạt → "Đạt KPI"', () => {
    expect(orderAovVerdict(view(900, 900 * 200_000))).toBe(ORDER_AOV_VERDICT.pass)
    expect(orderAovVerdict(null)).toBe(ORDER_AOV_VERDICT.unsynced)
  })

  test('canary: UI KHÔNG được suy "đạt" từ điểm gộp đã làm tròn', () => {
    // completion 99,9999 làm tròn 1 chữ số ra 100,0 — nếu UI đọc số đã làm
    // tròn thì badge sẽ ghi "Đạt". overallPass đi từ tỉ lệ round4 nên không dính.
    const engine = computeOrderAovResult({ ...T, actualOrder: 900, actualNet: 900 * 200_000 - 1 })
    expect(Math.round(engine.completionPct * 10) / 10).toBe(100)
    expect(view(900, 900 * 200_000 - 1)!.overallPass).toBe(false)
  })
})
