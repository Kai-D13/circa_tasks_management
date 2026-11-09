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
//
// CMS-UNIT (Q-221…Q-224, UNIT-D01…D03 — planning/research/cms-unit-basis-spec-implementation-2026-11-09.md §2): chương trình cơ sở
// `cms_unit` ⇒ mỗi dòng ỨNG VIÊN (kể cả chưa gán / ngoài phạm vi) được phân loại theo ĐV tính CMS của SP (unitKey.ts — cùng hợp
// đồng SQL 128). Đơn vị / lượng thiếu, hỏng, lượng lẻ đúng đơn vị ⇒ ném CmsEngineInputError UNIT_SOURCE_INVALID (HOLD cả lượt —
// không bỏ dòng, không làm tròn, không 0 giả). Dòng hợp lệ: c_i = quantity_raw nguyên nếu đúng đơn vị, khác đơn vị ⇒ 0 (vẫn giữ
// GMV / lineage / result_line). C cộng dồn theo thứ tự dòng; Q trước / sau = max(C, 0); tiền dòng = gate ? F(Q_sau) − F(Q_trước) : 0;
// B trước / sau vẫn là lượng cơ sở THẬT; K giữ ở output (perUnitUnits) nhưng KHÔNG là mẫu số. Điều chỉnh gồm cả quantity_raw âm (mọi
// đơn vị). Nhánh pos_base giữ nguyên biểu thức và shape output (không thêm khoá).

import { CMS_DEC_FACTOR } from '../decimal'
import { mapSeller, type CmsSellerIndex, type CmsUnassignedReason } from '../mapping'
import { isEligibleOrder, type CmsSalesLine } from '../source/contract'
import { isWithinWindow } from '../time'
import { cmsClassifyUnitLine, type CmsUnitInvalidReason, type CmsUnitLine } from '../unitKey'
import { parseCmsEngineProgram, type CmsEngineProduct, type CmsEngineProgramInput } from './config'
import { cmsAmountAtBase, cmsProgressiveAmount, cmsQuantityOf } from './tiers'

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
  | 'AT_CAP'         // LỊCH SỬ: run trước CMS-Q-220 (bậc cuối hữu hạn). Engine KHÔNG sinh nữa; reader giữ để đọc run QA cũ đã đóng băng
  | 'ADJUSTMENT'     // Điều chỉnh (sự kiện âm đã chuẩn hóa — Q-206)

export type CmsEngineInputCode = 'DUPLICATE_LINE_ID' | 'UNIT_SOURCE_INVALID'

export class CmsEngineInputError extends Error {
  readonly code: CmsEngineInputCode
  readonly lineIds: string[]
  /** UNIT_SOURCE_INVALID: số dòng ứng viên theo lý do (cms_unit). */
  readonly unitIssues: Partial<Record<CmsUnitInvalidReason, number>>
  constructor(code: CmsEngineInputCode, lineIds: string[], unitIssues: Partial<Record<CmsUnitInvalidReason, number>> = {}) {
    super(code === 'DUPLICATE_LINE_ID'
      ? `CMS engine input ${code}: ${lineIds.length} order_line_id lặp`
      : `CMS engine input ${code}: ${lineIds.length} dòng ứng viên thiếu / sai đơn vị hoặc số lượng`)
    this.name = 'CmsEngineInputError'
    this.code = code
    this.lineIds = lineIds
    this.unitIssues = unitIssues
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
  /** Lượng cơ sở cộng dồn của dược sĩ × sản phẩm trước / sau dòng (scale 9) — B THẬT ở mọi cơ sở tính. */
  baseBeforeUnits: bigint
  baseAfterUnits: bigint
  /** pos_base: floor(max(0, B) / K) trước / sau dòng; cms_unit: max(C, 0) trước / sau dòng (C = Σ lượng đúng ĐV CMS). */
  qtyBefore: bigint
  qtyAfter: bigint
  amountVnd: bigint
  status: CmsLineStatus
  /** CHỈ cms_unit: c_i — lượng đúng ĐV CMS của dòng (khác đơn vị ⇒ 0). */
  countedQuantity?: bigint
  /** CHỈ cms_unit: đơn vị bán khớp ĐV tính CMS của SP. */
  unitMatch?: boolean
  /** CHỈ cms_unit: quantity_raw âm (mọi đơn vị) — điều chỉnh / trả hàng. */
  rawQuantityNegative?: boolean
}

export interface CmsEngineProductResult {
  userId: string
  storeId: string
  productId: string
  gmvBasis: CmsEngineProduct['gmvBasis']
  /** B — tổng lượng cơ sở hợp lệ cả kỳ (scale 9). */
  baseQuantityUnits: bigint
  /** K (scale 9) cấu hình — pos_base: mẫu số; cms_unit: CHỈ thông tin kiểm chéo POS (UNIT-D02), không là mẫu số. */
  perUnitUnits: bigint
  /** pos_base: Q = floor(max(0, B) / K); cms_unit: Q = max(C, 0). */
  cmsQuantity: bigint
  /** = Q (CMS-Q-220 — không trần; số lượng TRƯỚC gate như contract cũ, tiền vẫn xét gate). */
  rewardedQuantity: bigint
  /** computeCmsProgram LUÔN ghi null / false (CMS-Q-220). Kiểu rộng vì shape này dùng chung với reader DTO của run QA cũ
   *  đã đóng băng (có thể mang trần cũ) — không phải cho phép cấu hình tính mới có trần. */
  capQuantity: bigint | null
  atCap: boolean
  /** GMV của dược sĩ trên sản phẩm (scale 9). */
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
  /** CHỈ cms_unit, dòng ứng viên chưa gán / ngoài phạm vi: đơn vị khớp ĐV CMS. */
  unitMatch?: boolean
  /** CHỈ cms_unit, dòng ứng viên chưa gán / ngoài phạm vi: quantity_raw âm (cổng trả hàng — không để né guard âm). */
  rawQuantityNegative?: boolean
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
  /** Dòng âm đã được tính (Q-206; cms_unit gồm cả quantity_raw âm). */
  adjustmentLines: number
  amountVnd: bigint
  /** CHỈ cms_unit: số dòng ứng viên đúng / khác ĐV tính CMS. */
  unitMatchedLines?: number
  unitOtherLines?: number
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
  const unitBasis = program.quantityBasis === 'cms_unit'
  /** cms_unit: phân loại của dòng ứng viên hợp lệ (COUNTED / OTHER_UNIT). */
  const unitOf = new Map<string, Exclude<CmsUnitLine, { kind: 'INVALID' }>>()
  const unitInvalid: string[] = []
  const unitIssues: Partial<Record<CmsUnitInvalidReason, number>> = {}
  if (unitBasis) { totals.unitMatchedLines = 0; totals.unitOtherLines = 0 }

  for (const line of sorted) {
    if (!isEligibleOrder(line)) { exclude(line, 'ORDER_NOT_ELIGIBLE'); continue }
    if (!isWithinWindow(line.completedAtMicros, program.window)) { exclude(line, 'OUT_OF_WINDOW'); continue }
    const product = program.products.get(line.productId)
    if (!product) { exclude(line, 'PRODUCT_NOT_IN_PROGRAM'); continue }
    totals.candidates += 1
    totals.candidateGmvUnits += line.gmvUnits
    // cms_unit: phân loại MỌI dòng ứng viên trước khi map người bán (cùng tập seal S9u của 128 — cả chưa gán / ngoài phạm vi).
    let unitExtra: Partial<CmsEngineExcludedLine> = {}
    if (unitBasis) {
      const u = cmsClassifyUnitLine(line, product.unitKey!) // parseCmsEngineProgram bảo đảm unitKey khi cms_unit
      if (u.kind === 'INVALID') {
        unitInvalid.push(line.orderLineId)
        unitIssues[u.reason] = (unitIssues[u.reason] ?? 0) + 1
        continue
      }
      unitOf.set(line.orderLineId, u)
      if (u.kind === 'COUNTED') totals.unitMatchedLines! += 1
      else totals.unitOtherLines! += 1
      unitExtra = { unitMatch: u.kind === 'COUNTED', rawQuantityNegative: u.negative }
    }
    const seller = mapSeller(line.sellerEmail, input.sellers)
    if (!seller.ok) {
      totals.unassigned += 1
      totals.unassignedGmvUnits += line.gmvUnits
      totals.unassignedByReason[seller.reason] = (totals.unassignedByReason[seller.reason] ?? 0) + 1
      exclude(line, 'UNASSIGNED', { unassignedReason: seller.reason, ...unitExtra })
      continue
    }
    if (!program.storeIds.has(seller.storeId)) {
      totals.outOfScope += 1
      exclude(line, 'OUT_OF_SCOPE', { userId: seller.userId, storeId: seller.storeId, ...unitExtra })
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
  // UNIT-D01: nguồn đơn vị / lượng hỏng ở BẤT KỲ dòng ứng viên nào ⇒ HOLD cả lượt (không tính phần còn lại, không 0 giả).
  if (unitInvalid.length) throw new CmsEngineInputError('UNIT_SOURCE_INVALID', unitInvalid.sort(compareCmsLineId), unitIssues)

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
    let counted = ZERO // C — chỉ cms_unit
    let lineSum = ZERO
    for (const { line } of g.items) {
      const before = base
      base += line.baseQuantityUnits
      gmv += line.gmvUnits
      let qtyBefore: bigint
      let qtyAfter: bigint
      let amountVnd: bigint
      let unit: { countedQuantity: bigint; unitMatch: boolean; rawQuantityNegative: boolean } | null = null
      if (unitBasis) {
        const u = unitOf.get(line.orderLineId)
        if (!u) throw new Error('CMS engine invariant: dòng INCLUDED cms_unit chưa phân loại đơn vị')
        const ci = u.kind === 'COUNTED' ? u.qty : ZERO
        const cBefore = counted
        counted += ci
        qtyBefore = cBefore > ZERO ? cBefore : ZERO
        qtyAfter = counted > ZERO ? counted : ZERO
        amountVnd = gate.met ? cmsProgressiveAmount(qtyAfter, product.tiers) - cmsProgressiveAmount(qtyBefore, product.tiers) : ZERO
        unit = { countedQuantity: ci, unitMatch: u.kind === 'COUNTED', rawQuantityNegative: u.negative }
      } else {
        qtyBefore = cmsQuantityOf(before, product.perUnitUnits)
        qtyAfter = cmsQuantityOf(base, product.perUnitUnits)
        amountVnd = gate.met
          ? cmsAmountAtBase(base, product.perUnitUnits, product.tiers) - cmsAmountAtBase(before, product.perUnitUnits, product.tiers)
          : ZERO
      }
      lineSum += amountVnd
      const adjustment = line.baseQuantityUnits < ZERO || line.gmvUnits < ZERO || unit?.rawQuantityNegative === true
      if (adjustment) totals.adjustmentLines += 1
      let status: CmsLineStatus
      if (adjustment) status = 'ADJUSTMENT'
      else if (!gate.met) status = 'WAITING_GATE'
      else if (amountVnd > ZERO) status = 'RECORDED'
      else status = 'ACCUMULATING'   // CMS-Q-220: không còn AT_CAP — mọi đơn vị đủ sau bậc cuối vẫn tăng tiền
      lineResults.push({
        orderLineId: line.orderLineId, orderId: line.orderId, orderCode: line.orderCode, productId: product.productId,
        userId: g.userId, storeId: g.storeId, posCode: line.posCode, completedAtMicros: line.completedAtMicros,
        baseQuantityUnits: line.baseQuantityUnits, gmvUnits: line.gmvUnits, baseBeforeUnits: before, baseAfterUnits: base,
        qtyBefore, qtyAfter, amountVnd, status,
        ...(unit ?? {}),
      })
    }

    const cmsQuantity = unitBasis ? (counted > ZERO ? counted : ZERO) : cmsQuantityOf(base, product.perUnitUnits)
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
      rewardedQuantity: cmsQuantity, capQuantity: null, atCap: false,
      gmvUnits: gmv, gate, potentialAmountVnd, amountVnd, lineCount: g.items.length,
    })
  }
  results.sort((a, b) => cmp(a.userId, b.userId) || compareCmsLineId(a.productId, b.productId))
  lineResults.sort(compareCmsLines)

  return { results, catalog, lines: lineResults, excluded, totals }
}
