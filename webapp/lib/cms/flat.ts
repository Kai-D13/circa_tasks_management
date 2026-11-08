// CMS đơn giản (PM spec r1 08/11 §6) — nhận diện SP "mức CMS cố định / đơn vị": đúng 1 bậc {order 1, từ 1, không giới hạn},
// gmvBasis none, không target. Suy từ CẤU HÌNH đã validate phía server (catalog / snapshot), KHÔNG nhận cờ từ query / client.
// Chương trình đơn giản = có ≥ 1 SP và MỌI SP flat (0 SP ⇒ false — không vacuous true). Chương trình trộn: nhánh theo từng SP,
// không ẩn target / bậc của SP khác chỉ vì có một SP flat. Hàm thuần, không IO.
//
// Phép nhân "Q × mức = tiền" chỉ để GIẢI THÍCH số đã công bố: tiền luôn lấy từ snapshot (cms_results.amount_vnd), không tính
// lại ở UI; lệch snapshot (cấu hình đổi so với run, run lịch sử có trần…) ⇒ null ⇒ UI chỉ hiện số tiền, không hiện phép nhân sai.
import { cmsAmountPerUnit, cmsVnd, type CmsGmvBasis } from './display'
import type { CmsUiTier } from './resultUi'

export interface CmsFlatInput {
  gmvBasis: CmsGmvBasis
  targetGmv: string | null
  tiers: readonly CmsUiTier[]
}

const POS_INT = /^[1-9][0-9]*$/

/** Mức CMS / đơn vị (chuỗi số nguyên dương) nếu SP flat; khác ⇒ null. */
export function cmsFlatRate(p: CmsFlatInput): string | null {
  if (p.gmvBasis !== 'none' || p.targetGmv !== null || p.tiers.length !== 1) return null
  const t = p.tiers[0]
  return t.order === 1 && t.from === 1 && t.to === null && POS_INT.test(t.amount) ? t.amount : null
}

export const cmsIsFlatProduct = (p: CmsFlatInput): boolean => cmsFlatRate(p) !== null

/** ≥ 1 SP và mọi SP flat. Danh sách rỗng ⇒ false. */
export const cmsIsSimpleProgram = (products: readonly CmsFlatInput[]): boolean => products.length > 0 && products.every(cmsIsFlatProduct)

/** "Mức CMS 25.000₫/hộp" — dòng cấu hình của thẻ / chi tiết SP flat. */
export const cmsFlatRateText = (rate: string, unit: string): string => `Mức CMS ${cmsAmountPerUnit(rate, unit)}`

/** "Mỗi hộp được tính CMS 25.000₫" — dòng tĩnh D2 khi chương trình ĐANG CHẠY (thay khối "Nếu bán thêm"; hết kỳ không hiện). */
export const cmsFlatEachText = (rate: string, unit: string): string => `Mỗi ${unit} được tính CMS ${cmsVnd(rate)}`

export interface CmsFlatEquation {
  /** Q — số đơn vị CMS nguyên được tính (snapshot). */
  quantity: bigint
  rate: bigint
  /** Tiền snapshot (= quantity × rate, đã kiểm). */
  amountVnd: bigint
}

/**
 * "Q {unit} × X₫ = A₫" từ dòng kết quả snapshot. `row` null (run đã công bố, người xem chưa có dòng cho SP) ⇒ 0 × X = 0 hợp lệ.
 * Không flat / Q ≠ số được thưởng / gate chưa mở / Q × mức ≠ tiền snapshot / dữ liệu sai dạng ⇒ null.
 */
export function cmsFlatEquation(
  p: CmsFlatInput,
  row: { cmsQuantity: string; rewardedQuantity: string; amountVnd: string; gateMet: boolean } | null,
): CmsFlatEquation | null {
  const rate = cmsFlatRate(p)
  if (rate === null) return null
  const r = BigInt(rate)
  if (row === null) return { quantity: BigInt(0), rate: r, amountVnd: BigInt(0) }
  const INT = /^[0-9]+$/
  if (!INT.test(row.cmsQuantity) || !INT.test(row.rewardedQuantity) || !/^-?[0-9]+$/.test(row.amountVnd)) return null
  const q = BigInt(row.cmsQuantity)
  const amount = BigInt(row.amountVnd)
  if (!row.gateMet || BigInt(row.rewardedQuantity) !== q || q * r !== amount) return null
  return { quantity: q, rate: r, amountVnd: amount }
}

/** "12 hộp × 25.000₫ = 300.000₫". */
export const cmsFlatEquationText = (e: CmsFlatEquation, unit: string): string =>
  `${e.quantity.toLocaleString('vi-VN')} ${unit} × ${cmsVnd(e.rate)} = ${cmsVnd(e.amountVnd)}`
