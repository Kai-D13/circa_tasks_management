// CMS P2-a — thang lũy tiến và trần (docs/plan §2.7, §2.9, §2.10; Q-210a / Q-210b).
// F(Q) = tổng tiền của số đơn vị nằm trong từng bậc; bậc cuối hữu hạn = trần (vượt trần không thêm CMS).
// A(B) = F(floor(max(0, B) / K)). Mọi số là bigint (VND nguyên, lượng cơ sở scale 9). Hàm thuần.

import { cmsUnitsFloorDiv } from '../decimal'
import type { CmsEngineTier } from './config'

const ZERO = BigInt(0)
const ONE = BigInt(1)

/** F(Q) — Q là số đơn vị CMS nguyên đủ xét (đã floor). Q ≤ 0 ⇒ 0. */
export function cmsProgressiveAmount(q: bigint, tiers: readonly CmsEngineTier[]): bigint {
  if (q <= ZERO) return ZERO
  let total = ZERO
  for (const t of tiers) {
    if (q < t.from) break
    const hi = t.to === null || q < t.to ? q : t.to
    total += (hi - t.from + ONE) * t.amountVnd
  }
  return total
}

/** Số lượng được hưởng CMS = min(Q, trần); Q âm không xảy ra vì Q = floor(max(0, B) / K). */
export function cmsRewardedQuantity(q: bigint, capQuantity: bigint | null): bigint {
  if (q <= ZERO) return ZERO
  return capQuantity !== null && q > capQuantity ? capQuantity : q
}

/** Q = floor(max(0, B) / K) — cộng dồn lượng cơ sở cả kỳ rồi mới floor (phần lẻ cộng tiếp trong kỳ). */
export function cmsQuantityOf(baseUnits: bigint, perUnitUnits: bigint): bigint {
  return cmsUnitsFloorDiv(baseUnits, perUnitUnits)
}

/** A(B) = F(floor(max(0, B) / K)). */
export function cmsAmountAtBase(baseUnits: bigint, perUnitUnits: bigint, tiers: readonly CmsEngineTier[]): bigint {
  return cmsProgressiveAmount(cmsQuantityOf(baseUnits, perUnitUnits), tiers)
}
