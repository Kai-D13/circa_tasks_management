// CMS P2-a — thang lũy tiến (docs/plan §2.7, §2.9, §2.10; Q-210b; CMS-Q-220 thay Q-210a).
// F(Q) = tổng tiền của số đơn vị nằm trong từng bậc. CMS-Q-220: bậc cuối KHÔNG giới hạn (to = null) — mọi đơn vị đủ sau mốc
// bậc cuối cộng đúng mức bậc cuối; bậc TRUNG GIAN vẫn chặn min(Q, to) để không tính chồng. Engine chỉ nhận cấu hình cuối null
// (config.ts FINITE_LAST_TIER); nhánh `to` hữu hạn ở bậc cuối dưới đây chỉ còn cho test / đọc lịch sử, không phải luật tính mới.
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

/** Q = floor(max(0, B) / K) — cộng dồn lượng cơ sở cả kỳ rồi mới floor (phần lẻ cộng tiếp trong kỳ). */
export function cmsQuantityOf(baseUnits: bigint, perUnitUnits: bigint): bigint {
  return cmsUnitsFloorDiv(baseUnits, perUnitUnits)
}

/** A(B) = F(floor(max(0, B) / K)). */
export function cmsAmountAtBase(baseUnits: bigint, perUnitUnits: bigint, tiers: readonly CmsEngineTier[]): bigint {
  return cmsProgressiveAmount(cmsQuantityOf(baseUnits, perUnitUnits), tiers)
}
