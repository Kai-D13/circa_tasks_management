// CMS P2-a — cấu hình chương trình cho engine (docs/plan-cms-product-commission.md §2.3, §2.7–§2.9;
// docs/cms/SPEC.md §2). Nhận đúng shape lưu DB / import (decimal dạng chuỗi, số nguyên VND dạng chuỗi
// hoặc số an toàn, bậc {from, to, amount}) và chuyển sang bigint đã kiểm. Cấu hình sai ⇒ throw
// CmsEngineConfigError — không đoán, không cắt, không làm tròn, không thay bằng 0. Hàm thuần, không I/O.

import { parseCmsDecimal } from '../decimal'
import type { CmsGmvBasis } from '../import/validate'
import { canonicalProductId } from '../productId'
import { vnProgramWindowMicros } from '../time'

const ZERO = BigInt(0)
const ONE = BigInt(1)

export type CmsEngineConfigErrorCode =
  | 'BAD_DATES'
  | 'BAD_PRODUCT_ID'
  | 'DUPLICATE_PRODUCT'
  | 'BAD_GMV_BASIS'
  | 'BAD_TARGET'
  | 'BAD_CATALOG_TARGET'
  | 'CATALOG_TARGET_MISSING'
  | 'BAD_BASE_QUANTITY'
  | 'BAD_TIERS'
  | 'BAD_STORE_ID'

export class CmsEngineConfigError extends Error {
  readonly code: CmsEngineConfigErrorCode
  readonly productId: string | null
  constructor(code: CmsEngineConfigErrorCode, detail: string, productId: string | null = null) {
    super(`CMS engine config ${code}${productId ? ` [${productId}]` : ''}: ${detail}`)
    this.name = 'CmsEngineConfigError'
    this.code = code
    this.productId = productId
  }
}

/** Số nguyên dạng DB/import: chuỗi chữ số, số JS an toàn hoặc bigint. */
export type CmsIntLike = string | number | bigint

export interface CmsEngineTierInput {
  from: CmsIntLike
  /** null chỉ ở bậc cuối = không giới hạn; bậc cuối hữu hạn = trần số lượng hưởng CMS (Q-210a). */
  to: CmsIntLike | null
  /** CMS_VND_SP — số nguyên VND > 0 cho mỗi đơn vị CMS. */
  amount: CmsIntLike
}

export interface CmsEngineProductInput {
  productId: string
  gmvBasis: CmsGmvBasis
  /** Số nguyên VND > 0, bắt buộc ⇔ gmvBasis = 'product'; còn lại phải null. */
  targetGmv: CmsIntLike | null
  /** base_quantity_CMS — decimal > 0, tối đa 9 chữ số thập phân (Q-210b). */
  baseQuantityCms: string
  tiers: readonly CmsEngineTierInput[]
}

export interface CmsEngineProgramInput {
  /** Ngày VN YYYY-MM-DD, bao gồm cả hai đầu. */
  startDate: string
  endDate: string
  /** Target danh mục (số nguyên VND) — bắt buộc khi có sản phẩm gmvBasis = 'catalog'. */
  catalogTargetGmv: CmsIntLike | null
  /** Nhà thuốc tham gia (scope 'all' đã được ghi thành danh sách lúc kích hoạt — Q-209). */
  storeIds: readonly string[]
  products: readonly CmsEngineProductInput[]
}

export interface CmsEngineTier {
  from: bigint
  to: bigint | null
  amountVnd: bigint
}

export interface CmsEngineProduct {
  productId: string
  gmvBasis: CmsGmvBasis
  targetVnd: bigint | null
  /** K ở scale 9 (units). */
  perUnitUnits: bigint
  tiers: readonly CmsEngineTier[]
  /** Trần số lượng hưởng CMS = `to` của bậc cuối; null = không giới hạn. */
  capQuantity: bigint | null
}

export interface CmsEngineProgram {
  window: { fromMicros: bigint; toMicrosExclusive: bigint }
  catalogTargetVnd: bigint | null
  storeIds: ReadonlySet<string>
  products: ReadonlyMap<string, CmsEngineProduct>
}

const DIGITS_RE = /^[0-9]+$/

/** Số nguyên dương chính xác; sai kiểu / ≤ 0 / số JS không an toàn ⇒ null (không làm tròn). */
export function parsePositiveInt(v: CmsIntLike | null | undefined): bigint | null {
  if (v === null || v === undefined) return null
  let n: bigint
  if (typeof v === 'bigint') n = v
  else if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) return null
    n = BigInt(v)
  } else if (typeof v === 'string') {
    const s = v.trim()
    if (!DIGITS_RE.test(s)) return null
    n = BigInt(s)
  } else return null
  return n >= ONE ? n : null
}

function parseTiers(productId: string, tiers: readonly CmsEngineTierInput[]): CmsEngineTier[] {
  if (!Array.isArray(tiers) || tiers.length === 0) throw new CmsEngineConfigError('BAD_TIERS', 'thiếu bậc', productId)
  const out: CmsEngineTier[] = []
  tiers.forEach((t, i) => {
    const from = parsePositiveInt(t.from)
    const to = t.to === null ? null : parsePositiveInt(t.to)
    const amountVnd = parsePositiveInt(t.amount)
    const last = i === tiers.length - 1
    if (from === null) throw new CmsEngineConfigError('BAD_TIERS', `bậc ${i + 1}: from không hợp lệ`, productId)
    if (t.to !== null && to === null) throw new CmsEngineConfigError('BAD_TIERS', `bậc ${i + 1}: to không hợp lệ`, productId)
    if (amountVnd === null) throw new CmsEngineConfigError('BAD_TIERS', `bậc ${i + 1}: CMS_VND_SP phải là số nguyên > 0`, productId)
    if (to === null && !last) throw new CmsEngineConfigError('BAD_TIERS', `bậc ${i + 1}: chỉ bậc cuối được để trống cận trên`, productId)
    if (to !== null && to < from) throw new CmsEngineConfigError('BAD_TIERS', `bậc ${i + 1}: to < from`, productId)
    const expectedFrom = i === 0 ? ONE : out[i - 1].to! + ONE
    if (from !== expectedFrom) {
      throw new CmsEngineConfigError('BAD_TIERS', `bậc ${i + 1}: phải bắt đầu từ ${expectedFrom} (liên tục, không hở / chồng)`, productId)
    }
    out.push({ from, to, amountVnd })
  })
  return out
}

/**
 * Kiểm và chuyển cấu hình chương trình. Thứ tự bậc theo mảng truyền vào (DB `tier_order`, import đã sắp
 * theo `from`); bậc phải liên tục từ 1 — không tự sắp lại để không che lỗi cấu hình.
 */
export function parseCmsEngineProgram(input: CmsEngineProgramInput): CmsEngineProgram {
  let window: CmsEngineProgram['window']
  try {
    window = vnProgramWindowMicros(input.startDate, input.endDate)
  } catch (e) {
    throw new CmsEngineConfigError('BAD_DATES', e instanceof Error ? e.message : 'ngày không hợp lệ')
  }

  const storeIds = new Set<string>()
  for (const s of input.storeIds) {
    if (typeof s !== 'string' || s.trim() === '') throw new CmsEngineConfigError('BAD_STORE_ID', 'store id rỗng')
    storeIds.add(s)
  }

  let catalogTargetVnd: bigint | null = null
  if (input.catalogTargetGmv !== null) {
    catalogTargetVnd = parsePositiveInt(input.catalogTargetGmv)
    if (catalogTargetVnd === null) throw new CmsEngineConfigError('BAD_CATALOG_TARGET', 'target danh mục phải là số nguyên VND > 0')
  }

  const products = new Map<string, CmsEngineProduct>()
  for (const p of input.products) {
    const pid = canonicalProductId(p.productId)
    if (!pid.ok || pid.id !== p.productId) {
      throw new CmsEngineConfigError('BAD_PRODUCT_ID', 'ProductID phải ở dạng canonical', String(p.productId))
    }
    if (products.has(pid.id)) throw new CmsEngineConfigError('DUPLICATE_PRODUCT', 'ProductID lặp trong chương trình', pid.id)
    if (p.gmvBasis !== 'product' && p.gmvBasis !== 'catalog' && p.gmvBasis !== 'none') {
      throw new CmsEngineConfigError('BAD_GMV_BASIS', `gmvBasis không hợp lệ: ${String(p.gmvBasis)}`, pid.id)
    }
    let targetVnd: bigint | null = null
    if (p.gmvBasis === 'product') {
      targetVnd = parsePositiveInt(p.targetGmv)
      if (targetVnd === null) throw new CmsEngineConfigError('BAD_TARGET', 'gate theo sản phẩm cần target số nguyên VND > 0', pid.id)
    } else if (p.targetGmv !== null) {
      throw new CmsEngineConfigError('BAD_TARGET', 'target sản phẩm chỉ dùng cho gmvBasis = product', pid.id)
    }
    if (p.gmvBasis === 'catalog' && catalogTargetVnd === null) {
      throw new CmsEngineConfigError('CATALOG_TARGET_MISSING', 'sản phẩm GMV_TOAN_DANH_MUC cần target danh mục', pid.id)
    }
    const k = parseCmsDecimal(String(p.baseQuantityCms ?? ''))
    if (!k.ok) throw new CmsEngineConfigError('BAD_BASE_QUANTITY', `base_quantity_CMS lỗi ${k.error}`, pid.id)
    if (k.units <= ZERO) throw new CmsEngineConfigError('BAD_BASE_QUANTITY', 'base_quantity_CMS phải > 0', pid.id)
    const tiers = parseTiers(pid.id, p.tiers)
    products.set(pid.id, {
      productId: pid.id,
      gmvBasis: p.gmvBasis,
      targetVnd,
      perUnitUnits: k.units,
      tiers,
      capQuantity: tiers[tiers.length - 1].to,
    })
  }

  return { window, catalogTargetVnd, storeIds, products }
}
