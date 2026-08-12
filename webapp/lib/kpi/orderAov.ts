// Mig 106 (11/08) — CÔNG THỨC "Chất lượng bán hàng" (metric_type =
// 'offline_order_aov'): đo ĐỒNG THỜI Số đơn Offline (90%) + AOV Offline (10%),
// mỗi chỉ số có FLOOR bắt buộc.
//
// ⚠ NGUỒN SỰ THẬT LÀ RPC (mig 106 rpc_replace_campaign_actuals). Module này là
// BẢN SOI GƯƠNG THUẦN của đúng công thức đó, dùng cho:
//   · khóa công thức bằng test (đổi 1 phía mà quên phía kia → đỏ);
//   · suy các giá trị DẪN XUẤT lúc ĐỌC (kpiPass, status) — những thứ CỐ Ý
//     không lưu trong DB để không bao giờ lệch với actual_value/floor_pass.
// TUYỆT ĐỐI KHÔNG dùng để tính rồi GỬI số vào RPC: nhánh sync chỉ gửi số THÔ
// (Net Revenue + số đơn), RPC tự tính (audit P0 "RPC là authority").
//
// Contract (stakeholder 11/08):
//   actual_aov     = actual_net / actual_order            (null khi 0 đơn)
//   actual_score   = 0.90×(actual_order/order_floor) + 0.10×(actual_aov/aov_floor)
//   target_score   = 0.90×(order_target/order_floor) + 0.10×(aov_target/aov_floor)
//   completion_pct = actual_score / target_score × 100    (KHÔNG cap thành phần)
//   floor_pass     = actual_order >= order_floor AND actual_aov >= aov_floor
//   kpi_pass       = floor_pass AND completion_pct >= 100
//   tier           = threshold cao nhất <= completion_pct, CHỈ xét khi floor_pass

export const ORDER_WEIGHT = 0.9
export const AOV_WEIGHT = 0.1

export interface OrderAovTargets {
  orderFloor: number
  aovFloor: number
  orderTarget: number
  aovTarget: number
}

export interface OrderAovTierRow {
  tier_order: number
  threshold_pct: number
  commission_amount: number
}

// Trạng thái/nhãn per-store (handoff §status). Thứ tự xét: chưa có đơn → thủng
// sàn (nói rõ THỦNG SÀN NÀO) → đang chạy → đạt.
export type OrderAovStatus =
  | 'no_orders'
  | 'below_both_floors'
  | 'below_order_floor'
  | 'below_aov_floor'
  | 'in_progress'
  | 'achieved'

export interface OrderAovResult {
  actualAov: number | null
  actualScore: number
  targetScore: number
  completionPct: number
  orderFloorPass: boolean
  aovFloorPass: boolean
  floorPass: boolean
  kpiPass: boolean
  status: OrderAovStatus
  achievedTierOrder: number | null
  commissionPool: number | null
  remainingPct: number
}

// Khớp `round(x, 4)` của Postgres numeric: HALF-UP ĐỐI XỨNG (away-from-zero) —
// r1.2 (audit P2): Math.round là half-up "về phía +∞" nên số ÂM lệch một đơn vị
// cuối (-1,23455 → -1,2345 thay vì -1,2346). Net Revenue âm đã được chấp nhận
// nên sai lệch này có thể chạm màn tiền.
// +1e-9 bù sai số nhị phân: 1,23455×1e4 trong float là 12345.499999999998 —
// PG numeric là thập phân CHÍNH XÁC nên không có lỗi đó; nudge ở mức 1e-13 của
// giá trị gốc, nhỏ hơn mọi con số nghiệp vụ.
export function round4(n: number): number {
  if (!Number.isFinite(n)) return n
  const rounded = Math.round(Math.abs(n) * 1e4 + 1e-9)
  const out = (n < 0 ? -rounded : rounded) / 1e4
  return out === 0 ? 0 : out            // chuẩn hóa -0 → 0
}

// target_score tách riêng: đây là con số Finance đối soát trực tiếp từ file
// cấu hình (không phụ thuộc kết quả thực tế).
// r1.1 (audit P2): validate ĐẦY ĐỦ cấu hình — module tiền không được nhận
// NaN/Infinity/số lẻ rồi trả kết quả trông-như-thật.
function assertTargets(t: OrderAovTargets): void {
  // CHỈ soi 4 khóa cấu hình — hàm cũng nhận object có thêm actual*/tiers.
  for (const k of ['orderFloor', 'aovFloor', 'orderTarget', 'aovTarget'] as const) {
    if (!Number.isFinite(t[k])) throw new Error(`orderAov: ${k} phải là số hữu hạn`)
  }
  if (!(t.orderFloor > 0)) throw new Error('orderAov: order_floor phải > 0')
  if (!(t.aovFloor > 0)) throw new Error('orderAov: aov_floor phải > 0')
  if (!(t.orderTarget > 0)) throw new Error('orderAov: order_target phải > 0')
  if (!(t.aovTarget > 0)) throw new Error('orderAov: aov_target phải > 0')
  if (!Number.isInteger(t.orderFloor) || !Number.isInteger(t.orderTarget)) {
    throw new Error('orderAov: order_floor/order_target phải là số nguyên')
  }
  if (!Number.isInteger(t.aovFloor) || !Number.isInteger(t.aovTarget)) {
    throw new Error('orderAov: aov_floor/aov_target phải là VNĐ nguyên')
  }
  if (t.orderTarget < t.orderFloor) throw new Error('orderAov: order_target phải >= order_floor')
  if (t.aovTarget < t.aovFloor) throw new Error('orderAov: aov_target phải >= aov_floor')
}

export function targetScore(t: OrderAovTargets): number {
  assertTargets(t)
  return ORDER_WEIGHT * (t.orderTarget / t.orderFloor) + AOV_WEIGHT * (t.aovTarget / t.aovFloor)
}

export function computeOrderAovResult(input: OrderAovTargets & {
  actualOrder: number
  actualNet: number
  tiers?: OrderAovTierRow[]
}): OrderAovResult {
  const { orderFloor, aovFloor, actualOrder, actualNet } = input
  // Số đơn: nguyên, không âm. Net Revenue: hữu hạn, ĐƯỢC PHÉP ÂM (hoàn/điều
  // chỉnh) — AOV âm là số thật, sẽ thủng sàn AOV chứ không bị clamp.
  if (!Number.isInteger(actualOrder) || actualOrder < 0) {
    throw new Error('orderAov: actual_order phải là số nguyên >= 0')
  }
  if (!Number.isFinite(actualNet)) throw new Error('orderAov: actual_net phải là số hữu hạn')
  // r1.2 (audit P1): 0 đơn mà có doanh thu = nguồn MÂU THUẪN (canary 105) —
  // fail-closed cùng contract với RPC, không được lặng lẽ thành 0%.
  if (actualOrder === 0 && actualNet !== 0) {
    throw new Error('orderAov: 0 đơn nhưng actual_net khác 0 — nguồn mâu thuẫn (0 đơn chỉ hợp lệ khi doanh thu = 0)')
  }
  const ts = targetScore(input)
  if (!(ts > 0)) throw new Error('orderAov: target_score phải > 0 — cấu hình target sai')

  // 0 đơn ⇒ AOV VÔ ĐỊNH (không phải 0đ): UI hiện '—', không bao giờ suy ra
  // "AOV = 0" rồi tính như đã bán hàng.
  const actualAov = actualOrder > 0 ? actualNet / actualOrder : null
  const actualScore = ORDER_WEIGHT * (actualOrder / orderFloor)
    + AOV_WEIGHT * ((actualAov ?? 0) / aovFloor)
  // Chưa phát sinh đơn → 0% (chốt với stakeholder 11/08), không âm/không NaN.
  const completionPct = actualOrder === 0 ? 0 : round4((actualScore / ts) * 100)

  // BẰNG floor là PASS (>=).
  const orderFloorPass = actualOrder >= orderFloor
  const aovFloorPass = actualAov !== null && actualAov >= aovFloor
  const floorPass = orderFloorPass && aovFloorPass
  const kpiPass = floorPass && completionPct >= 100

  // Bậc CHỈ xét khi qua CẢ 2 sàn: vượt điểm nhờ bù trừ mà thủng sàn thì KHÔNG
  // có commission (điều kiện cần của handoff).
  const achieved = floorPass
    ? [...(input.tiers ?? [])]
      .filter((x) => Number(x.threshold_pct) <= completionPct)
      .sort((a, b) => b.tier_order - a.tier_order)[0] ?? null
    : null

  return {
    actualAov,
    actualScore,
    targetScore: ts,
    completionPct,
    orderFloorPass,
    aovFloorPass,
    floorPass,
    kpiPass,
    status: orderAovStatus({ actualOrder, orderFloorPass, aovFloorPass, completionPct }),
    achievedTierOrder: achieved?.tier_order ?? null,
    commissionPool: achieved ? Number(achieved.commission_amount) : null,
    remainingPct: Math.max(100 - completionPct, 0),
  }
}

export function orderAovStatus(x: {
  actualOrder: number
  orderFloorPass: boolean
  aovFloorPass: boolean
  completionPct: number
}): OrderAovStatus {
  if (x.actualOrder === 0) return 'no_orders'
  if (!x.orderFloorPass && !x.aovFloorPass) return 'below_both_floors'
  if (!x.orderFloorPass) return 'below_order_floor'
  if (!x.aovFloorPass) return 'below_aov_floor'
  return x.completionPct >= 100 ? 'achieved' : 'in_progress'
}

export const ORDER_AOV_STATUS_LABEL: Record<OrderAovStatus, string> = {
  no_orders: 'Chưa phát sinh đơn',
  below_both_floors: 'Chưa đạt cả 2 sàn',
  below_order_floor: 'Chưa đạt sàn số đơn',
  below_aov_floor: 'Chưa đạt sàn AOV',
  in_progress: 'Đang chạy',
  achieved: 'Đạt KPI',
}

// ── Suy DẪN XUẤT lúc ĐỌC (UI / export / list) ───────────────────────────────
// DB lưu quality_floor_pass + actual_value(=completion). KPI pass KHÔNG lưu để
// không thể lệch, và TUYỆT ĐỐI không suy từ achieved_tier_order: bậc thấp nhất
// có thể < 100% (store đạt bậc 1 vẫn CHƯA đạt KPI).
export function qualityKpiPass(
  floorPass: boolean | null | undefined,
  completionPct: number | null | undefined,
): boolean {
  return floorPass === true && (completionPct ?? 0) >= 100
}

// "X/Y cửa hàng đạt" của màn danh sách + dashboard (chốt với user 11/08).
export function countQualityKpiPass(
  rows: { quality_floor_pass?: boolean | null; actual_value?: number | null }[],
): number {
  return rows.filter((r) => qualityKpiPass(r.quality_floor_pass, r.actual_value)).length
}

// AOV đọc từ snapshot: weighted per store (net/số đơn) — mirror mig 105, KHÔNG
// bao giờ trung bình các AOV.
export function aovFromSnapshot(
  actualNet: number | null | undefined,
  orderCount: number | null | undefined,
): number | null {
  if (orderCount == null || orderCount <= 0) return null
  return (Number(actualNet) || 0) / orderCount
}
