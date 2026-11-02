// CMS P2-a — engine tính CMS một chương trình (docs/plan §2.5–§2.10; docs/cms/SPEC.md §2).
// Đầu vào: cấu hình chương trình (config.ts), dòng đơn ĐÃ chuẩn hóa (source/contract.ts) và chỉ mục người
// bán (mapping.ts). Engine tự xếp dòng theo (completed_at micro giây, order_line_id) nên thứ tự nhận từ
// nguồn không ảnh hưởng kết quả. Gate và bậc tính riêng từng dược sĩ × sản phẩm (CMS-Q1); gate danh mục
// cộng GMV mọi sản phẩm GMV_TOAN_DANH_MUC của dược sĩ. Tiền dòng = A(B_sau) − A(B_trước); gate cuối chưa
// đạt ⇒ mọi dòng 0; tổng tiền dòng = tiền dược sĩ × sản phẩm (bất biến, kiểm trong engine).
// Không I/O, không Supabase / BigQuery, không Date cho micro giây.
//
// TODO(Q-206): dòng âm (base_quantity / amount < 0) chỉ được tính số học như "sự kiện đã chuẩn hóa" và gắn
// trạng thái ADJUSTMENT; quy thuộc trả hàng production vẫn HOLD — engine không suy dòng âm từ status.

import { CMS_DEC_FACTOR } from '../decimal'
import { mapSeller, type CmsSellerIndex, type CmsUnassignedReason } from '../mapping'
import { isEligibleOrder, type CmsSalesLine } from '../source/contract'
import { isWithinWindow } from '../time'
import { parseCmsEngineProgram, type CmsEngineProduct, type CmsEngineProgramInput } from './config'
import { cmsAmountAtBase, cmsProgressiveAmount, cmsQuantityOf, cmsRewardedQuantity } from './tiers'

const ZERO = BigInt(0)

export type CmsExcludeReason =
  | 'ORDER_NOT_ELIGIBLE'      // không phải OFFLINE + COMPLETED
  | 'OUT_OF_WINDOW'           // completed_at ngoài kỳ theo ngày VN
  | 'PRODUCT_NOT_IN_PROGRAM'  // ProductID không có trong danh mục chương trình
  | 'UNASSIGNED'              // "Chưa gán dược sĩ" — xem unassignedReason
  | 'OUT_OF_SCOPE'            // dược sĩ map được nhưng nhà thuốc hiện tại ngoài phạm vi chương trình

/** Trạng thái hiển thị của dòng (plan §2.10); "Đã chốt" thuộc P3, không do engine sinh. */
export type CmsLineStatus =
  | 'WAITING_GATE'   // Chờ đạt target
  | 'ACCUMULATING'   // Đang cộng dồn — dòng chưa hoàn thành thêm đơn vị CMS
  | 'RECORDED'       // Đã ghi nhận — dòng làm tăng CMS
  | 'AT_CAP'         // Đã đạt trần — lượng thêm không tăng CMS
  | 'ADJUSTMENT'     // Điều chỉnh (sự kiện âm đã chuẩn hóa — Q-206)

export class CmsEngineInputError extends Error {
  readonly code: 'DUPLICATE_LINE_ID'
  readonly lineIds: string[]
  constructor(code: 'DUPLICATE_LINE_ID', lineIds: string[]) {
    super(`CMS engine input ${code}: ${lineIds.length} order_line_id lặp`)
    this.name = 'CmsEngineInputError'
    this.code = code
    this.lineIds = lineIds
  }
}

export interface CmsGateOutcome {
  /** GMV dùng để xét gate (scale 9): sản phẩm = GMV của chính sản phẩm; danh mục = tổng GMV danh mục; none = null. */
  gateGmvUnits: bigint | null
  targetVnd: bigint | null
  met: boolean
  /** Lần chuyển chưa đạt → đạt gần nhất (Q-211); gate cuối không đạt hoặc không có target ⇒ null. */
  metAtMicros: bigint | null
}

export interface CmsEngineLineResult {
  orderLineId: string
  orderId: string
  orderCode: string
  productId: string
  userId: string
  storeId: string
  posCode: string | null
  completedAtMicros: bigint
  baseQuantityUnits: bigint
  gmvUnits: bigint
  /** Lượng cơ sở cộng dồn của dược sĩ × sản phẩm trước / sau dòng (scale 9). */
  baseBeforeUnits: bigint
  baseAfterUnits: bigint
  /** floor(max(0, B) / K) trước / sau dòng (chưa áp trần). */
  qtyBefore: bigint
  qtyAfter: bigint
  amountVnd: bigint
  status: CmsLineStatus
}

export interface CmsEngineProductResult {
  userId: string
  storeId: string
  productId: string
  gmvBasis: CmsEngineProduct['gmvBasis']
  /** B — tổng lượng cơ sở hợp lệ cả kỳ (scale 9), giữ đủ kể cả khi vượt trần. */
  baseQuantityUnits: bigint
  /** K (scale 9) để hiển thị số lượng thực tế B / K. */
  perUnitUnits: bigint
  /** Q = floor(max(0, B) / K), chưa áp trần. */
  cmsQuantity: bigint
  /** min(Q, trần) — số lượng được hưởng CMS. */
  rewardedQuantity: bigint
  capQuantity: bigint | null
  atCap: boolean
  /** GMV của dược sĩ trên sản phẩm (scale 9), giữ đủ kể cả khi vượt trần. */
  gmvUnits: bigint
  gate: CmsGateOutcome
  /** F(Q) — mức CMS nếu gate đạt (để hiển thị "Chờ đạt target"). */
  potentialAmountVnd: bigint
  /** gate.met ? F(Q) : 0. */
  amountVnd: bigint
  lineCount: number
}

export interface CmsEngineCatalogResult {
  userId: string
  storeId: string
  /** Tổng GMV các sản phẩm GMV_TOAN_DANH_MUC của dược sĩ (scale 9). */
  catalogGmvUnits: bigint
  targetVnd: bigint
  met: boolean
  metAtMicros: bigint | null
  lineCount: number
}

export interface CmsEngineExcludedLine {
  orderLineId: string
  productId: string
  reason: CmsExcludeReason
  unassignedReason: CmsUnassignedReason | null
  /** Có khi người bán map được (OUT_OF_SCOPE). */
  userId: string | null
  storeId: string | null
  completedAtMicros: bigint
  baseQuantityUnits: bigint
  gmvUnits: bigint
}

export interface CmsEngineTotals {
  linesRead: number
  /** Ứng viên = OFFLINE + COMPLETED + trong kỳ + ProductID thuộc chương trình (cùng định nghĩa quality.ts). */
  candidates: number
  candidateGmvUnits: bigint
  /** Ứng viên không map được người bán ("Chưa gán dược sĩ"). */
  unassigned: number
  unassignedGmvUnits: bigint
  unassignedByReason: Partial<Record<CmsUnassignedReason, number>>
  outOfScope: number
  included: number
  /** Dòng âm đã được tính (Q-206). */
  adjustmentLines: number
  amountVnd: bigint
}

export interface CmsEngineOutput {
  /** Dược sĩ × sản phẩm, xếp theo (userId, productId). */
  results: CmsEngineProductResult[]
  /** Gate danh mục theo dược sĩ (chỉ dược sĩ có dòng danh mục), xếp theo userId. */
  catalog: CmsEngineCatalogResult[]
  /** Phân bổ dòng hợp lệ, xếp theo (completed_at, order_line_id). */
  lines: CmsEngineLineResult[]
  /** Dòng bị loại kèm lý do, xếp theo (completed_at, order_line_id). */
  excluded: CmsEngineExcludedLine[]
  totals: CmsEngineTotals
}

export interface CmsEngineInput {
  program: CmsEngineProgramInput
  lines: readonly CmsSalesLine[]
  sellers: CmsSellerIndex
}

const DIGITS_RE = /^[0-9]+$/

/**
 * So sánh order_line_id — thứ tự TOÀN PHẦN (bắc cầu, kể cả khi trộn kiểu): mọi id toàn chữ số đứng trước id
 * có ký tự khác; id chữ số so theo giá trị (độ dài sau bỏ số 0 đầu, rồi chữ số), hoà thì theo chuỗi gốc;
 * id còn lại so theo code unit (không localeCompare).
 */
export function compareCmsLineId(a: string, b: string): number {
  const da = DIGITS_RE.test(a)
  const db = DIGITS_RE.test(b)
  if (da !== db) return da ? -1 : 1
  if (da) {
    const ta = a.replace(/^0+(?=[0-9])/, '')
    const tb = b.replace(/^0+(?=[0-9])/, '')
    if (ta.length !== tb.length) return ta.length < tb.length ? -1 : 1
    if (ta !== tb) return ta < tb ? -1 : 1
  }
  return a < b ? -1 : a > b ? 1 : 0
}

/** Thứ tự dòng (plan §2.10): completed_at (micro giây) rồi order_line_id. */
export function compareCmsLines(
  a: Pick<CmsSalesLine, 'completedAtMicros' | 'orderLineId'>,
  b: Pick<CmsSalesLine, 'completedAtMicros' | 'orderLineId'>,
): number {
  if (a.completedAtMicros !== b.completedAtMicros) return a.completedAtMicros < b.completedAtMicros ? -1 : 1
  return compareCmsLineId(a.orderLineId, b.orderLineId)
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Đi qua dòng đã xếp, cộng dồn GMV; trả GMV cuối, đạt hay không và lần chuyển chưa đạt → đạt gần nhất. */
function trackGate(lines: readonly CmsSalesLine[], targetVnd: bigint): { gmvUnits: bigint; met: boolean; metAtMicros: bigint | null } {
  const targetUnits = targetVnd * CMS_DEC_FACTOR
  let cum = ZERO
  let prevMet = false
  let lastCrossing: bigint | null = null
  for (const l of lines) {
    cum += l.gmvUnits
    const met = cum >= targetUnits
    if (met && !prevMet) lastCrossing = l.completedAtMicros
    prevMet = met
  }
  return { gmvUnits: cum, met: prevMet, metAtMicros: prevMet ? lastCrossing : null }
}

type Included = { line: CmsSalesLine; userId: string; storeId: string }

export function computeCmsProgram(input: CmsEngineInput): CmsEngineOutput {
  const program = parseCmsEngineProgram(input.program)

  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const l of input.lines) {
    if (seen.has(l.orderLineId)) dup.add(l.orderLineId)
    else seen.add(l.orderLineId)
  }
  if (dup.size) throw new CmsEngineInputError('DUPLICATE_LINE_ID', [...dup].sort(compareCmsLineId))

  const sorted = [...input.lines].sort(compareCmsLines)
  const totals: CmsEngineTotals = {
    linesRead: sorted.length, candidates: 0, candidateGmvUnits: ZERO, unassigned: 0, unassignedGmvUnits: ZERO,
    unassignedByReason: {}, outOfScope: 0, included: 0, adjustmentLines: 0, amountVnd: ZERO,
  }
  const excluded: CmsEngineExcludedLine[] = []
  const exclude = (line: CmsSalesLine, reason: CmsExcludeReason, extra: Partial<CmsEngineExcludedLine> = {}) => {
    excluded.push({
      orderLineId: line.orderLineId, productId: line.productId, reason, unassignedReason: null, userId: null, storeId: null,
      completedAtMicros: line.completedAtMicros, baseQuantityUnits: line.baseQuantityUnits, gmvUnits: line.gmvUnits, ...extra,
    })
  }

  // Nhóm theo dược sĩ × sản phẩm; Map giữ thứ tự chèn = thứ tự dòng đã xếp.
  const groups = new Map<string, { userId: string; storeId: string; product: CmsEngineProduct; items: Included[] }>()
  const catalogLines = new Map<string, { storeId: string; lines: CmsSalesLine[] }>()

  for (const line of sorted) {
    if (!isEligibleOrder(line)) { exclude(line, 'ORDER_NOT_ELIGIBLE'); continue }
    if (!isWithinWindow(line.completedAtMicros, program.window)) { exclude(line, 'OUT_OF_WINDOW'); continue }
    const product = program.products.get(line.productId)
    if (!product) { exclude(line, 'PRODUCT_NOT_IN_PROGRAM'); continue }
    totals.candidates += 1
    totals.candidateGmvUnits += line.gmvUnits
    const seller = mapSeller(line.sellerEmail, input.sellers)
    if (!seller.ok) {
      totals.unassigned += 1
      totals.unassignedGmvUnits += line.gmvUnits
      totals.unassignedByReason[seller.reason] = (totals.unassignedByReason[seller.reason] ?? 0) + 1
      exclude(line, 'UNASSIGNED', { unassignedReason: seller.reason })
      continue
    }
    if (!program.storeIds.has(seller.storeId)) {
      totals.outOfScope += 1
      exclude(line, 'OUT_OF_SCOPE', { userId: seller.userId, storeId: seller.storeId })
      continue
    }
    totals.included += 1
    const key = `${seller.userId}\u0000${product.productId}`
    let g = groups.get(key)
    if (!g) {
      g = { userId: seller.userId, storeId: seller.storeId, product, items: [] }
      groups.set(key, g)
    }
    g.items.push({ line, userId: seller.userId, storeId: seller.storeId })
    if (product.gmvBasis === 'catalog') {
      let c = catalogLines.get(seller.userId)
      if (!c) {
        c = { storeId: seller.storeId, lines: [] }
        catalogLines.set(seller.userId, c)
      }
      c.lines.push(line)
    }
  }

  const catalog: CmsEngineCatalogResult[] = []
  const catalogByUser = new Map<string, CmsEngineCatalogResult>()
  for (const [userId, c] of catalogLines) {
    const targetVnd = program.catalogTargetVnd! // parseCmsEngineProgram bảo đảm có target khi có sản phẩm danh mục
    const g = trackGate(c.lines, targetVnd)
    const r: CmsEngineCatalogResult = {
      userId, storeId: c.storeId, catalogGmvUnits: g.gmvUnits, targetVnd, met: g.met, metAtMicros: g.metAtMicros, lineCount: c.lines.length,
    }
    catalog.push(r)
    catalogByUser.set(userId, r)
  }
  catalog.sort((a, b) => cmp(a.userId, b.userId))

  const results: CmsEngineProductResult[] = []
  const lineResults: CmsEngineLineResult[] = []
  for (const g of groups.values()) {
    const { product } = g
    const lines = g.items.map((i) => i.line)
    let gate: CmsGateOutcome
    if (product.gmvBasis === 'product') {
      const t = trackGate(lines, product.targetVnd!)
      gate = { gateGmvUnits: t.gmvUnits, targetVnd: product.targetVnd, met: t.met, metAtMicros: t.metAtMicros }
    } else if (product.gmvBasis === 'catalog') {
      const c = catalogByUser.get(g.userId)!
      gate = { gateGmvUnits: c.catalogGmvUnits, targetVnd: c.targetVnd, met: c.met, metAtMicros: c.metAtMicros }
    } else {
      gate = { gateGmvUnits: null, targetVnd: null, met: true, metAtMicros: null }
    }

    let base = ZERO
    let gmv = ZERO
    let lineSum = ZERO
    for (const { line } of g.items) {
      const before = base
      base += line.baseQuantityUnits
      gmv += line.gmvUnits
      const qtyBefore = cmsQuantityOf(before, product.perUnitUnits)
      const qtyAfter = cmsQuantityOf(base, product.perUnitUnits)
      const amountVnd = gate.met
        ? cmsAmountAtBase(base, product.perUnitUnits, product.tiers) - cmsAmountAtBase(before, product.perUnitUnits, product.tiers)
        : ZERO
      lineSum += amountVnd
      const adjustment = line.baseQuantityUnits < ZERO || line.gmvUnits < ZERO
      if (adjustment) totals.adjustmentLines += 1
      let status: CmsLineStatus
      if (adjustment) status = 'ADJUSTMENT'
      else if (!gate.met) status = 'WAITING_GATE'
      else if (amountVnd > ZERO) status = 'RECORDED'
      else if (product.capQuantity !== null && qtyBefore >= product.capQuantity) status = 'AT_CAP'
      else status = 'ACCUMULATING'
      lineResults.push({
        orderLineId: line.orderLineId, orderId: line.orderId, orderCode: line.orderCode, productId: product.productId,
        userId: g.userId, storeId: g.storeId, posCode: line.posCode, completedAtMicros: line.completedAtMicros,
        baseQuantityUnits: line.baseQuantityUnits, gmvUnits: line.gmvUnits, baseBeforeUnits: before, baseAfterUnits: base,
        qtyBefore, qtyAfter, amountVnd, status,
      })
    }

    const cmsQuantity = cmsQuantityOf(base, product.perUnitUnits)
    const potentialAmountVnd = cmsProgressiveAmount(cmsQuantity, product.tiers)
    const amountVnd = gate.met ? potentialAmountVnd : ZERO
    if (lineSum !== amountVnd) {
      // Bất biến telescoping: Σ(A(B_sau) − A(B_trước)) = A(B_cuối) − A(0). Lệch ⇒ lỗi engine, không công bố.
      throw new Error(`CMS engine invariant: tổng tiền dòng ${lineSum} ≠ tiền dược sĩ × sản phẩm ${amountVnd}`)
    }
    totals.amountVnd += amountVnd
    results.push({
      userId: g.userId, storeId: g.storeId, productId: product.productId, gmvBasis: product.gmvBasis,
      baseQuantityUnits: base, perUnitUnits: product.perUnitUnits, cmsQuantity,
      rewardedQuantity: cmsRewardedQuantity(cmsQuantity, product.capQuantity), capQuantity: product.capQuantity,
      atCap: product.capQuantity !== null && cmsQuantity >= product.capQuantity,
      gmvUnits: gmv, gate, potentialAmountVnd, amountVnd, lineCount: g.items.length,
    })
  }
  results.sort((a, b) => cmp(a.userId, b.userId) || compareCmsLineId(a.productId, b.productId))
  lineResults.sort(compareCmsLines)

  return { results, catalog, lines: lineResults, excluded, totals }
}
