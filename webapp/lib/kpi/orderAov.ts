// Mig 106 — CÔNG THỨC "Chất lượng bán hàng" (metric_type = 'offline_order_aov').
// ⚠ CONTRACT CHỐT 12/08 — THAY THẾ HOÀN TOÀN thiết kế 90/10 + floor trước đó.
// Không còn order_floor/aov_floor, không trọng số, không bù trừ.
//
//   actual_aov  = actual_order > 0 ? actual_net / actual_order : null
//   order_ratio = actual_order / order_target
//   aov_ratio   = actual_aov   / aov_target
//   completion  = round4(min(order_ratio, aov_ratio) × 100)     ← CHỈ SỐ YẾU HƠN
//   kpi_pass    = actual_order >= order_target AND actual_aov >= aov_target
//                 (tương đương completion >= 100 — min của 2 tỉ lệ)
//
// · KHÔNG cap completion ở 100% (vượt cả 2 mục tiêu thì > 100).
// · 0 đơn → AOV '—', completion 0%. 0 đơn mà net ≠ 0 = NGUỒN HỎNG → throw.
// · Net Revenue ÂM giữ nguyên, không clamp (hoàn/điều chỉnh).
// · Commission chỉ khi completion >= 100; contract hiện tại: ĐÚNG MỘT bậc
//   threshold_pct = 100 (policy tách riêng — xem exactlyOneTierAt100).
//
// ⚠ NGUỒN SỰ THẬT LÀ RPC (mig 106 rpc_replace_campaign_actuals). Module này là
// BẢN SOI GƯƠNG THUẦN dùng để (1) khóa công thức bằng test, (2) suy giá trị
// DẪN XUẤT lúc ĐỌC (kpi_pass, status) — những thứ CỐ Ý không lưu trong DB.
// TUYỆT ĐỐI KHÔNG tính rồi GỬI số vào RPC: nhánh sync chỉ gửi số THÔ.

export interface OrderAovTargets {
  orderTarget: number
  aovTarget: number
}

export interface OrderAovTierRow {
  tier_order: number
  threshold_pct: number
  commission_amount: number
}

// Trạng thái per-store: chưa có đơn → chưa đạt (nói RÕ chỉ số nào) → đạt.
export type OrderAovStatus =
  | 'no_orders'
  | 'below_both_targets'
  | 'below_order_target'
  | 'below_aov_target'
  | 'achieved'

export interface OrderAovResult {
  actualAov: number | null
  orderRatio: number
  aovRatio: number | null
  completionPct: number
  orderPass: boolean
  aovPass: boolean
  kpiPass: boolean
  status: OrderAovStatus
  achievedTierOrder: number | null
  commissionPool: number | null
  remainingPct: number
}

// Khớp `round(x, 4)` của Postgres numeric: HALF-UP ĐỐI XỨNG (away-from-zero).
// Math.round là half-up "về phía +∞" nên số ÂM lệch một đơn vị cuối
// (-1,23455 → -1,2345 thay vì -1,2346); Net Revenue âm được chấp nhận nên sai
// lệch này có thể chạm màn tiền. +1e-9 bù sai số nhị phân (1,23455×1e4 trong
// float là 12345.499999999998) — PG numeric là thập phân CHÍNH XÁC.
export function round4(n: number): number {
  if (!Number.isFinite(n)) return n
  const rounded = Math.round(Math.abs(n) * 1e4 + 1e-9)
  const out = (n < 0 ? -rounded : rounded) / 1e4
  return out === 0 ? 0 : out            // chuẩn hóa -0 → 0
}

function assertPositiveInt(n: number, label: string): void {
  if (!Number.isFinite(n) || n <= 0) throw new Error(`orderAov: ${label} phải > 0`)
  if (!Number.isInteger(n)) throw new Error(`orderAov: ${label} phải là số nguyên`)
}

export function computeOrderAovResult(input: OrderAovTargets & {
  actualOrder: number
  actualNet: number
  tiers?: OrderAovTierRow[]
}): OrderAovResult {
  const { orderTarget, aovTarget, actualOrder, actualNet } = input
  assertPositiveInt(orderTarget, 'order_target')
  assertPositiveInt(aovTarget, 'aov_target')
  if (!Number.isFinite(actualOrder) || actualOrder < 0 || !Number.isInteger(actualOrder)) {
    throw new Error(`orderAov: actual_order phải là số nguyên >= 0 — nhận ${actualOrder}`)
  }
  if (!Number.isFinite(actualNet)) {
    throw new Error(`orderAov: actual_net phải là số hữu hạn — nhận ${actualNet}`)
  }
  // Canary nguồn (mirror RPC + orchestrator strict): 0 đơn mà có doanh thu là
  // dữ liệu MÂU THUẪN — không được âm thầm quy về 0%.
  if (actualOrder === 0 && actualNet !== 0) {
    throw new Error(`orderAov: nguồn mâu thuẫn — 0 đơn nhưng actual_net khác 0 (${actualNet})`)
  }

  // 0 đơn ⇒ AOV VÔ ĐỊNH (không phải 0đ): UI hiện '—'.
  const actualAov = actualOrder > 0 ? actualNet / actualOrder : null
  const orderRatio = actualOrder / orderTarget
  const aovRatio = actualAov === null ? null : actualAov / aovTarget
  const orderPass = actualOrder >= orderTarget
  const aovPass = actualAov !== null && actualAov >= aovTarget
  const kpiPass = orderPass && aovPass

  // Điểm = CHỈ SỐ YẾU HƠN (min) — không bù trừ, không trọng số.
  // ⚠ INVARIANT TIỀN: completion >= 100 ⟺ đạt CẢ HAI mục tiêu. Làm tròn 4 chữ
  // số có thể đẩy một ca hụt cực nhỏ (AOV thiếu 0,001đ ⇒ 99,999999%) thành
  // đúng 100 → mở khoá commission cho store CHƯA đạt. Vì kpi_pass được suy
  // LÚC ĐỌC từ completion, sai lệch này lan ra cả UI/export ⇒ chặn tại đây.
  const rawPct = actualAov === null ? 0 : Math.min(orderRatio, aovRatio as number) * 100
  const rounded = round4(rawPct)
  const completionPct = !kpiPass && rounded >= 100 ? 99.9999 : rounded

  // Commission CHỈ khi đạt KPI (completion >= 100). Vẫn dùng bảng tier động —
  // policy "đúng một bậc 100" nằm ở tầng import (exactlyOneTierAt100), không
  // hardcode vào công thức: mở nhiều bậc sau này không phải đổi core.
  const achieved = completionPct >= 100
    ? [...(input.tiers ?? [])]
      .filter((x) => Number(x.threshold_pct) <= completionPct)
      .sort((a, b) => b.tier_order - a.tier_order)[0] ?? null
    : null

  return {
    actualAov,
    orderRatio,
    aovRatio,
    completionPct,
    orderPass,
    aovPass,
    kpiPass,
    status: orderAovStatus({ actualOrder, orderPass, aovPass }),
    achievedTierOrder: achieved?.tier_order ?? null,
    commissionPool: achieved ? Number(achieved.commission_amount) : null,
    remainingPct: Math.max(100 - completionPct, 0),
  }
}

export function orderAovStatus(x: {
  actualOrder: number
  orderPass: boolean
  aovPass: boolean
}): OrderAovStatus {
  if (x.actualOrder === 0) return 'no_orders'
  if (!x.orderPass && !x.aovPass) return 'below_both_targets'
  if (!x.orderPass) return 'below_order_target'
  if (!x.aovPass) return 'below_aov_target'
  return 'achieved'
}

export const ORDER_AOV_STATUS_LABEL: Record<OrderAovStatus, string> = {
  no_orders: 'Chưa phát sinh đơn',
  below_both_targets: 'Chưa đạt cả 2 mục tiêu',
  below_order_target: 'Chưa đạt mục tiêu số đơn',
  below_aov_target: 'Chưa đạt mục tiêu AOV',
  achieved: 'Đạt KPI',
}

// ── Policy TIER (tách riêng để mở rộng không phải đụng schema/core) ─────────
// Contract hiện tại: ĐÚNG MỘT bậc, threshold_pct = 100. Sau này muốn nhiều bậc
// chỉ đổi policy + import + UI; bảng tier vẫn động, công thức completion vẫn
// độc lập với tier.
export function exactlyOneTierAt100(
  tiers: { threshold_pct: number; commission_amount: number }[],
): { ok: true } | { ok: false; error: string } {
  if (tiers.length === 0) return { ok: false, error: 'Cần đúng 1 bậc thưởng với mốc 100%' }
  if (tiers.length > 1) {
    return { ok: false, error: `Chất lượng bán hàng chỉ nhận ĐÚNG 1 bậc (mốc 100%) — nhận ${tiers.length} bậc` }
  }
  const t = tiers[0]
  if (Number(t.threshold_pct) !== 100) {
    return { ok: false, error: `Bậc thưởng phải có mốc đúng 100% — nhận ${t.threshold_pct}%` }
  }
  if (!(Number(t.commission_amount) >= 0)) {
    return { ok: false, error: 'Tiền thưởng của bậc phải >= 0' }
  }
  return { ok: true }
}

// ── Suy DẪN XUẤT lúc ĐỌC (UI / export / list) ───────────────────────────────
// DB lưu actual_value = completion. KPI pass KHÔNG lưu để không thể lệch:
// completion là min của 2 tỉ lệ nên completion >= 100 ⟺ đạt CẢ HAI mục tiêu.
// TUYỆT ĐỐI không suy từ achieved_tier_order.
export function qualityKpiPass(completionPct: number | null | undefined): boolean {
  return completionPct != null && completionPct >= 100
}

// "X/Y cửa hàng đạt" của màn danh sách + dashboard.
export function countQualityKpiPass(rows: { actual_value?: number | null }[]): number {
  return rows.filter((r) => qualityKpiPass(r.actual_value)).length
}

// Hiển thị điểm hoàn thành — DÙNG CHUNG hero/ring/bảng/danh sách/export.
// ⚠ Store CHƯA đạt KHÔNG BAO GIỜ được render thành '100%': engine ép ca hụt
// cực nhỏ về 99.9999, làm tròn 1 chữ số sẽ ra '100,0%' trong khi badge ghi
// "Chưa đạt" và không có commission — mâu thuẫn ngay trên màn tiền.
export function formatCompletionPct(completionPct: number | null | undefined): string {
  if (completionPct == null) return '—'
  const n = Number(completionPct)
  if (!Number.isFinite(n)) return '—'
  const rounded = Math.round(n * 10) / 10
  // hụt sát 100 → hiện '<100%' thay vì làm tròn lên
  if (!qualityKpiPass(n) && rounded >= 100) return '<100%'
  return `${new Intl.NumberFormat('vi-VN').format(rounded)}%`
}

// r1.2 (audit P1): PHẦN CÒN THIẾU dùng formatter RIÊNG — KHÔNG tái dùng
// formatCompletionPct. Với completion 99,9999% thì delta = 0,0001 và làm tròn
// 1 chữ số sẽ ra "Còn thiếu 0%", mâu thuẫn với trạng thái chưa đạt.
export function formatRemainingPct(remainingPct: number | null | undefined): string {
  if (remainingPct == null) return '—'
  const n = Number(remainingPct)
  if (!Number.isFinite(n)) return '—'
  if (n <= 0) return '0%'                       // đã đạt/vượt — 0 thật
  if (n < 0.1) return '<0,1%'                   // còn thiếu tí xíu, KHÔNG phải 0
  return `${new Intl.NumberFormat('vi-VN').format(Math.round(n * 10) / 10)}%`
}

// ── Normalizer daily row (r1.2 audit P0) ────────────────────────────────────
// Supabase trả numeric dạng string; `Number(x) || 0` biến null thành 0 còn
// `?? null` sau Number() lại biến 0 thành null. Cả hai đều SAI trên màn tiền:
//   null/undefined/'' → null (nguồn CHƯA có số đơn — chart vẽ gap)
//   0 hoặc '0'        → 0    (ngày KHÔNG có đơn — dữ liệu hợp lệ)
//   số/chuỗi số hợp lệ→ Number
//   chuỗi rác/NaN     → null (không bịa 0)
export function normalizeOptionalCount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
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
