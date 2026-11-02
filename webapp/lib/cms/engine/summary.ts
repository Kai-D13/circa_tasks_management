// CMS P2-a — chỉ số báo cáo từ kết quả cá nhân (docs/plan §2.11; Q-212). Tổng QLCH / SM cộng từ kết quả
// dược sĩ × sản phẩm đã tính gate và bậc riêng — KHÔNG áp lại bậc trên tổng nhà thuốc (CMS-Q1). Dòng chưa
// gán không có trong `results` nên không tạo thêm người vào tử / mẫu. Hàm thuần.

import type { CmsEngineProductResult } from './compute'

const ZERO = BigInt(0)
const ONE = BigInt(1)

export interface CmsProgramSummary {
  amountVnd: bigint
  /** x của "SP có CMS x/y": số ProductID có ít nhất một dược sĩ CMS > 0. */
  productsWithCms: number
  /** y: số sản phẩm trong chương trình. */
  productCount: number
  /** Tử số: dược sĩ (distinct) có CMS > 0. */
  pharmacistsWithCms: number
  /** Mẫu số: tài khoản staff hiện thuộc phạm vi nhà thuốc hợp lệ (caller cung cấp; null khi chưa có). */
  pharmacistDenominator: number | null
  /** Lượt (dược sĩ × sản phẩm) có bán: số lượng CMS thuần nguyên ≥ 1. */
  turnsWithSales: number
  /** Lượt đạt: gate đạt và CMS > 0 (SP không target: có bán thì đạt). */
  turnsAchieved: number
}

export function summarizeCmsProgram(
  results: readonly CmsEngineProductResult[],
  opts: { productIds: readonly string[]; eligibleStaffIds?: readonly string[] | null },
): CmsProgramSummary {
  let amountVnd = ZERO
  const products = new Set<string>()
  const users = new Set<string>()
  let turnsWithSales = 0
  let turnsAchieved = 0
  for (const r of results) {
    amountVnd += r.amountVnd
    if (r.cmsQuantity >= ONE) turnsWithSales += 1
    if (r.gate.met && r.amountVnd > ZERO) {
      turnsAchieved += 1
      products.add(r.productId)
      users.add(r.userId)
    }
  }
  return {
    amountVnd,
    productsWithCms: products.size,
    productCount: new Set(opts.productIds).size,
    pharmacistsWithCms: users.size,
    pharmacistDenominator: opts.eligibleStaffIds ? new Set(opts.eligibleStaffIds).size : null,
    turnsWithSales,
    turnsAchieved,
  }
}

/** Gộp nhiều chương trình: đếm dược sĩ distinct có CMS > 0 (một người ở hai chương trình đếm một lần). */
export function countDistinctPharmacistsWithCms(resultSets: ReadonlyArray<readonly CmsEngineProductResult[]>): number {
  const users = new Set<string>()
  for (const set of resultSets) for (const r of set) if (r.amountVnd > ZERO) users.add(r.userId)
  return users.size
}

/** Tổng CMS theo nhà thuốc hiện tại = cộng tiền cá nhân (đã áp gate / bậc / trần riêng từng người). */
export function cmsAmountByStore(results: readonly CmsEngineProductResult[]): Map<string, bigint> {
  const out = new Map<string, bigint>()
  for (const r of results) out.set(r.storeId, (out.get(r.storeId) ?? ZERO) + r.amountVnd)
  return out
}
