// CMS-CALC-RET-2 §3.2–§3.4 (Q-231) — phân loại ĐỘC LẬP từng dòng bán ứng viên trước khi cộng lượng. Không tin nhãn / eligibility do
// nguồn hay client khai: chỉ đọc lượng cơ sở, GMV và chuỗi THÔ quantity / uom (trước khi bị thay ký tự điều khiển / trim).
//
// pos_base ("Tính lẻ"): mọi dòng ứng viên đóng góp b_i (POS_BASE). Không thêm ràng buộc q / u ngoài luật hiện hành (A09).
// cms_unit ("Tính nguyên"):
//   | Dòng                                              | Lượng thưởng                  | GMV            |
//   | đúng ĐV CMS, q nguyên dương, b = q × K             | COUNTED (q đơn vị, b cơ sở)   | toàn g_i       |
//   | khác ĐV CMS hợp lệ                                | OTHER_UNIT, 0                 | toàn g_i       |
//   | đúng ĐV, q dương có phần lẻ, b = q × K             | FRACTIONAL_QUANTITY, 0 cả dòng | toàn g_i       |
//   | đúng ĐV, q = 0, b = 0, g = 0                       | ZERO_QUANTITY, 0              | 0              |
//   | thiếu / hỏng q·u, ký tự không hợp lệ, b ≠ q × K,  | HOLD cả lượt (không công bố phần còn lại)       |
//   | q = 0 nhưng b / g ≠ 0                              |                                                  |
// Hai chế độ: lượng / GMV ÂM trên dòng BÁN ⇒ HOLD (NEGATIVE_SALE) — sự kiện giảm chỉ đến từ phiếu trả có lineage (spec §6.3), không suy
// từ dấu của dòng bán (chống trừ kép khi nguồn bán đã net — R11).
// b = q × K kiểm CHÍNH XÁC trên bigint scale 9: b_units × 10^9 = q_units × K_units — không chia / làm tròn / epsilon.
// Hàm thuần, không I/O.

import { CMS_DEC_FACTOR } from '../decimal'
import { cmsUnitKey, cmsUnitQuantity, cmsUnitRawFlags } from '../unitKey'
import type { CmsQuantityBasis } from './policy'

const ZERO = BigInt(0)
/** Trần INT64 cho số đơn vị CMS đếm được (cùng miền bigint DB). */
export const CMS_CALC_INT64_MAX = BigInt('9223372036854775807')

export type CmsQuantityClass =
  | 'POS_BASE'             // pos_base — cộng b_i
  | 'COUNTED'              // cms_unit — đúng ĐV, nguyên dương
  | 'OTHER_UNIT'           // cms_unit — khác ĐV CMS
  | 'FRACTIONAL_QUANTITY'  // cms_unit — đúng ĐV, lượng lẻ ⇒ bỏ cả dòng khỏi lượng
  | 'ZERO_QUANTITY'        // cms_unit — đúng ĐV, q = b = g = 0

export type CmsSaleHoldReason =
  | 'NEGATIVE_SALE'        // b / g / q âm trên dòng bán (chưa có lineage trả)
  | 'UNIT_MISSING'         // không có đơn vị bán
  | 'UNIT_INVALID'         // ký tự điều khiển / vô hình, chỉ khoảng trắng
  | 'QTY_MISSING'          // không có số lượng gốc
  | 'QTY_INVALID'          // sai hình thức / > 9 chữ số lẻ / > 29 chữ số / ký tự điều khiển
  | 'QTY_RANGE'            // số đơn vị CMS ngoài miền INT64
  | 'BASE_QTY_MISMATCH'    // đúng ĐV nhưng b ≠ q × K
  | 'ZERO_QTY_WITH_VALUE'  // q = 0 nhưng b hoặc g ≠ 0

/** Chuỗi THÔ của nguồn (đúng như adapter nhận, trước CONTROL_RE / trim của source/contract.ts). */
export interface CmsSaleRawQtyUnit {
  quantityRaw: string | null
  uomRaw: string | null
}

export type CmsSaleClassification =
  | { ok: true; cls: CmsQuantityClass; eligibleBaseUnits: bigint; countedQty: bigint | null }
  | { ok: false; reason: CmsSaleHoldReason }

export interface CmsClassifyProduct {
  basis: CmsQuantityBasis
  /** K scale 9, > 0. */
  perUnitUnits: bigint
  /** cmsUnitKey(unit_CMS) — bắt buộc (khác null) khi basis = cms_unit. */
  unitKey: string | null
}

const isContributing = (cls: CmsQuantityClass) => cls === 'POS_BASE' || cls === 'COUNTED'
export { isContributing as cmsClassContributes }

export function classifyCmsSale(
  line: { baseQuantityUnits: bigint; gmvUnits: bigint; raw: CmsSaleRawQtyUnit },
  product: CmsClassifyProduct,
): CmsSaleClassification {
  const b = line.baseQuantityUnits
  const g = line.gmvUnits
  // TODO(D10, chờ PM): dòng BÁN âm ⇒ HOLD ở cả hai mode (đường legacy sales_only + pos_base vẫn ở compute.ts + guard 126).
  if (b < ZERO || g < ZERO) return { ok: false, reason: 'NEGATIVE_SALE' }
  if (product.basis === 'pos_base') return { ok: true, cls: 'POS_BASE', eligibleBaseUnits: b, countedQty: null }
  if (product.unitKey === null) throw new RangeError('CMS calc: cms_unit cần khoá unit_CMS hợp lệ')
  if (product.perUnitUnits <= ZERO) throw new RangeError('CMS calc: K phải > 0')

  const { uomRaw, quantityRaw } = line.raw
  const uf = cmsUnitRawFlags(uomRaw)
  if (uf.control || uf.invisible) return { ok: false, reason: 'UNIT_INVALID' }
  if (uomRaw === null || uomRaw === '') return { ok: false, reason: 'UNIT_MISSING' }
  const key = cmsUnitKey(uomRaw)
  if (key === null) return { ok: false, reason: 'UNIT_INVALID' }
  const qf = cmsUnitRawFlags(quantityRaw)
  if (qf.control || qf.invisible) return { ok: false, reason: 'QTY_INVALID' }
  const q = cmsUnitQuantity(quantityRaw)
  if (!q.ok) return { ok: false, reason: q.error === 'EMPTY' ? 'QTY_MISSING' : 'QTY_INVALID' }
  if (q.units < ZERO) return { ok: false, reason: 'NEGATIVE_SALE' }

  if (key !== product.unitKey) {
    if (q.units === ZERO && (b !== ZERO || g !== ZERO)) return { ok: false, reason: 'ZERO_QTY_WITH_VALUE' }
    return { ok: true, cls: 'OTHER_UNIT', eligibleBaseUnits: ZERO, countedQty: null }
  }
  if (q.units === ZERO) {
    if (b !== ZERO || g !== ZERO) return { ok: false, reason: 'ZERO_QTY_WITH_VALUE' }
    return { ok: true, cls: 'ZERO_QUANTITY', eligibleBaseUnits: ZERO, countedQty: null }
  }
  // Kiểm chéo bắt buộc cho dòng đúng ĐV (cả dòng lẻ): b = q × K chính xác. Sai ⇒ HOLD, không thay b bằng q / K bằng 1.
  if (b * CMS_DEC_FACTOR !== q.units * product.perUnitUnits) return { ok: false, reason: 'BASE_QTY_MISMATCH' }
  if (q.units % CMS_DEC_FACTOR !== ZERO) return { ok: true, cls: 'FRACTIONAL_QUANTITY', eligibleBaseUnits: ZERO, countedQty: null }
  const qty = q.units / CMS_DEC_FACTOR
  if (qty > CMS_CALC_INT64_MAX) return { ok: false, reason: 'QTY_RANGE' }
  return { ok: true, cls: 'COUNTED', eligibleBaseUnits: b, countedQty: qty }
}
