// CMS-CALC-RET-2 §3–§4 (Q-227 / Q-231 / Q-232 / Q-229 / Q-230) — phép tính ròng THUẦN cho một chương trình: hai cách tính lượng ×
// phiếu trả COMPLETED. Không I/O, không Supabase / BigQuery, không đọc cờ env (chính sách đến từ input — run ghim, spec §6.1.4).
//
// Nhóm tính = dược sĩ × ProductID của chương trình (người bán GỐC). Mỗi nhóm có hai chuỗi sự kiện:
//   SALE   dòng bán INCLUDED:   B thật +b_i · B đủ điều kiện +e_i · GMV +g_i
//   RETURN item trả COMPLETED gắn dòng bán INCLUDED: B thật −r_j · B đủ −(dòng gốc đóng góp ? r_j : 0) · GMV −h_j
//   e_i = b_i (pos_base) | b_i nếu COUNTED, 0 nếu OTHER_UNIT / FRACTIONAL_QUANTITY / ZERO_QUANTITY (cms_unit) — classify.ts.
// Q = floor(B_đủ_ròng / K) MỘT lần trên tổng nhóm (không floor từng đơn / phiếu); CMS = F(Q) nếu gate GMV ròng đạt, ngược lại 0.
// Gate SP = GMV ròng của nhóm; gate danh mục = GMV ròng mọi SP GMV_TOAN_DANH_MUC của dược sĩ (gồm dòng OTHER_UNIT / FRACTIONAL —
// Q-224). Trả tính lại toàn bộ từ snapshot — không "trừ tiếp vào tổng cũ".
//
// HOLD cả lượt (không công bố phần còn lại). CÓ CHỮ trong spec: dòng bán INCLUDED lỗi phân loại (§3.3); phiếu trùng id KHÁC tài chính,
// thiếu dòng gốc dù thuộc chương trình, ngữ cảnh gốc lệch lớp bán (§4.1.2 / §4.1.6); Σ base trả của một dòng gốc > b_i (§4.1.5, không
// clamp / max 0). ĐỀ XUẤT DEV CHỜ PM (design r0 §2 — đánh dấu TODO(Dx) tại chỗ; đổi được bằng sửa đúng một nhánh):
//   D6 Σ refund một dòng gốc > g_i ⇒ HOLD (spec §4.4 chỉ nêu GMV ròng bất hợp lệ + cần quyết định nếu BI có ca hợp lệ);
//   D7 dòng ứng viên CHƯA GÁN / NGOÀI PHẠM VI lỗi phân loại cũng HOLD (fail-closed như guard âm của salesSync);
//   D8 trùng id GIỐNG HỆT cũng HOLD (dấu hiệu join nhân bản);
//   D9 phiếu COMPLETED sau as_of ⇒ HOLD (snapshot không nhất quán) thay vì loại;  D10 dòng BÁN âm ⇒ HOLD cả hai mode (classify.ts).
// Phiếu ngoài chương trình / chưa COMPLETED / gắn dòng chưa gán · ngoài phạm vi ⇒ loại có lý do.
//
// Thứ tự lịch sử (chỉ phục vụ phân bổ dòng / mốc gate — số cuối bất biến với thứ tự phiếu trả): mốc µs; cùng mốc SALE trước RETURN;
// SALE–SALE theo compareCmsContractLineId (ID số theo giá trị trước, text theo byte UTF-8 — order.ts, PM D1; ID ASCII trùng thứ tự engine
// legacy ⇒ parity pos_base); RETURN–RETURN theo byte UTF-8 của return_event_id (khớp SQL COLLATE "C"). Khoá lịch sử namespaced
// `SALE:<order_line_id>` / `RETURN:<return_event_id>`.

import { mapSeller, type CmsSellerIndex, type CmsUnassignedReason } from '../mapping'
import { isEligibleOrder, type CmsRawRow, type CmsSalesLine } from '../source/contract'
import { isWithinWindow } from '../time'
import { CmsEngineInputError, type CmsExcludeReason, type CmsGateOutcome } from '../engine/compute'
import { parseCmsEngineProgram, type CmsEngineProduct, type CmsEngineProductInput, type CmsEngineProgramInput } from '../engine/config'
import { cmsAmountAtBase, cmsProgressiveAmount, cmsQuantityOf } from '../engine/tiers'
import { CMS_DEC_FACTOR } from '../decimal'
import { cmsUnitKey } from '../unitKey'
import { classifyCmsSale, cmsClassContributes, type CmsQuantityClass, type CmsSaleHoldReason, type CmsSaleRawQtyUnit } from './classify'
import {
  CMS_CALC_CONTRACT_VERSION, CMS_QUANTITY_POLICY_VERSION, parseCmsQuantityBasis, parseCmsReturnsPolicy,
  type CmsQuantityBasis, type CmsReturnsPolicy,
} from './policy'
import { compareCmsCalcEvents, compareCmsContractLineId, compareCmsContractLines, compareUtf8Bytes } from './order'
import type { CmsReturnCompleted, CmsReturnRecord } from './returns'

const ZERO = BigInt(0)

// ── Input ────────────────────────────────────────────────────────────────────

export interface CmsCalcProductInput extends CmsEngineProductInput {
  /** unit_CMS của SP (hộp / chai / vỉ…). Bắt buộc hợp lệ (cmsUnitKey ≠ null) khi quantityBasis = cms_unit. */
  unitCms: string | null
}

export interface CmsCalcProgramInput extends Omit<CmsEngineProgramInput, 'products'> {
  quantityBasis: CmsQuantityBasis
  returnsPolicy: CmsReturnsPolicy
  products: readonly CmsCalcProductInput[]
}

/** Dòng bán đã chuẩn hoá (source/contract.ts) + chuỗi THÔ quantity / uom đúng như nguồn trả về. */
export interface CmsCalcSaleLine extends CmsSalesLine {
  raw: CmsSaleRawQtyUnit
}

/** Gắn chuỗi thô quantity_raw / uom_raw (trước CONTROL_RE / trim) vào dòng đã chuẩn hoá. */
export function cmsCalcSaleLine(raw: CmsRawRow, line: CmsSalesLine): CmsCalcSaleLine {
  const s = (v: string | null | undefined) => (v === null || v === undefined ? null : v)
  return { ...line, raw: { quantityRaw: s(raw.quantity_raw), uomRaw: s(raw.uom_raw) } }
}

export interface CmsCalcInput {
  program: CmsCalcProgramInput
  sales: readonly CmsCalcSaleLine[]
  /** Bản ghi trả đã chuẩn hoá (returns.ts). Chính sách sales_only_v1 ⇒ phải rỗng. */
  returns: readonly CmsReturnRecord[]
  sellers: CmsSellerIndex
  /** Mốc as_of của snapshot (µs UTC); phiếu COMPLETED sau mốc ⇒ HOLD (snapshot không nhất quán). */
  asOfMicros: bigint
}

export type CmsCalcConfigErrorCode = 'BAD_QUANTITY_BASIS' | 'BAD_RETURNS_POLICY' | 'UNIT_CMS_INVALID' | 'RETURNS_NOT_ALLOWED'

export class CmsCalcConfigError extends Error {
  readonly code: CmsCalcConfigErrorCode
  readonly productId: string | null
  constructor(code: CmsCalcConfigErrorCode, detail: string, productId: string | null = null) {
    super(`CMS calc config ${code}${productId ? ` [${productId}]` : ''}: ${detail}`)
    this.name = 'CmsCalcConfigError'
    this.code = code
    this.productId = productId
  }
}

// ── Output ───────────────────────────────────────────────────────────────────

export type CmsCalcHoldCode =
  | CmsSaleHoldReason
  | 'RETURN_DUPLICATE_ID'       // return_event_id lặp (kể cả khác trạng thái) — không DISTINCT / MAX chọn bừa
  | 'RETURN_AFTER_AS_OF'        // COMPLETED sau mốc snapshot
  | 'RETURN_BEFORE_SALE'        // ngày trả trước ngày bán gốc
  | 'RETURN_ORIGIN_MISSING'     // gốc thuộc chương trình nhưng không có trong lớp bán của snapshot
  | 'RETURN_CONTEXT_MISMATCH'   // ngữ cảnh gốc trên phiếu ≠ dòng bán đã lưu (đơn / SP / ngày / người / B / G / q·u)
  | 'RETURN_EXCEEDS_SALE_BASE'  // Σ base trả của một dòng gốc > b_i
  | 'RETURN_EXCEEDS_SALE_GMV'   // Σ refund của một dòng gốc > g_i

export interface CmsCalcHold {
  code: CmsCalcHoldCode
  /** `SALE:<order_line_id>` hoặc `RETURN:<return_event_id>` (định danh kỹ thuật, không PII). */
  ref: string
  /** Tên trường lệch (RETURN_CONTEXT_MISMATCH). */
  fields?: string[]
}

export type CmsReturnExcludeReason =
  | 'NOT_COMPLETED'          // APPROVED… — chưa có hiệu lực
  | 'ORIGIN_NOT_ELIGIBLE'    // đơn gốc không OFFLINE + COMPLETED
  | 'ORIGIN_OUT_OF_WINDOW'   // ngày bán gốc ngoài kỳ chương trình
  | 'ORIGIN_NOT_IN_PROGRAM'  // ProductID không thuộc chương trình
  | 'ORIGIN_UNASSIGNED'      // dòng gốc "Chưa gán dược sĩ"
  | 'ORIGIN_OUT_OF_SCOPE'    // dòng gốc ngoài phạm vi nhà thuốc

export type CmsCalcLineStatus =
  | 'WAITING_GATE'      // gate cuối chưa đạt
  | 'ACCUMULATING'      // SALE đóng góp nhưng chưa thêm đơn vị CMS
  | 'RECORDED'          // SALE làm tăng CMS
  | 'NOT_COUNTED'       // SALE không đóng góp lượng (OTHER_UNIT / FRACTIONAL_QUANTITY / ZERO_QUANTITY) — vẫn tính GMV
  | 'RETURN_REDUCED'    // RETURN làm giảm CMS
  | 'RETURN_NO_CHANGE'  // RETURN không đổi CMS (gốc không đóng góp lượng, hoặc chưa qua mốc đơn vị)

export interface CmsCalcHistoryLine {
  kind: 'SALE' | 'RETURN'
  key: string
  /** Dòng bán (SALE) hoặc dòng bán GỐC (RETURN). */
  orderLineId: string
  orderId: string
  orderCode: string
  returnEventId: string | null
  returnDocumentId: string | null
  returnCode: string | null
  productId: string
  userId: string
  storeId: string
  posCode: string | null
  atMicros: bigint
  /** Lớp lượng của dòng bán (gốc). */
  quantityClass: CmsQuantityClass
  baseDeltaUnits: bigint
  eligibleDeltaUnits: bigint
  gmvDeltaUnits: bigint
  eligibleBeforeUnits: bigint
  eligibleAfterUnits: bigint
  qtyBefore: bigint
  qtyAfter: bigint
  amountVnd: bigint
  status: CmsCalcLineStatus
}

export type CmsQuantityClassCounts = Record<CmsQuantityClass, number>

export interface CmsCalcGroupResult {
  userId: string
  storeId: string
  productId: string
  gmvBasis: CmsEngineProduct['gmvBasis']
  perUnitUnits: bigint
  /** B thật — mọi dòng bán INCLUDED / mọi phiếu trả gắn chúng (scale 9). */
  saleBaseUnits: bigint
  returnBaseUnits: bigint
  netBaseUnits: bigint
  /** B đủ điều kiện thưởng (pos_base = B thật; cms_unit chỉ COUNTED). */
  eligibleSaleBaseUnits: bigint
  eligibleReturnBaseUnits: bigint
  eligibleNetBaseUnits: bigint
  /** C_bán = Σ q_i của dòng COUNTED (cms_unit); pos_base ⇒ null. */
  countedSaleQty: bigint | null
  /** Q_ròng = floor(B_đủ_ròng / K). */
  cmsQuantity: bigint
  /** Phần cơ sở đủ điều kiện chưa thành đơn vị CMS = B_đủ_ròng − Q × K (scale 9). */
  remainderBaseUnits: bigint
  saleGmvUnits: bigint
  returnGmvUnits: bigint
  netGmvUnits: bigint
  gate: CmsGateOutcome
  potentialAmountVnd: bigint
  amountVnd: bigint
  saleLines: number
  returnEvents: number
  classCounts: CmsQuantityClassCounts
}

export interface CmsCalcCatalogResult {
  userId: string
  storeId: string
  catalogNetGmvUnits: bigint
  targetVnd: bigint
  met: boolean
  metAtMicros: bigint | null
  events: number
}

export interface CmsCalcExcludedSale {
  orderLineId: string
  productId: string
  reason: CmsExcludeReason
  unassignedReason: CmsUnassignedReason | null
  userId: string | null
  storeId: string | null
  completedAtMicros: bigint
  baseQuantityUnits: bigint
  gmvUnits: bigint
  /** Lớp lượng khi dòng là ứng viên (UNASSIGNED / OUT_OF_SCOPE); không phải ứng viên ⇒ null. */
  quantityClass: CmsQuantityClass | null
}

export interface CmsCalcExcludedReturn {
  returnEventId: string
  originalOrderLineId: string | null
  productId: string | null
  reason: CmsReturnExcludeReason
  baseQuantityUnits: bigint | null
  gmvUnits: bigint | null
}

export interface CmsCalcTotals {
  linesRead: number
  candidates: number
  candidateGmvUnits: bigint
  unassigned: number
  unassignedGmvUnits: bigint
  unassignedByReason: Partial<Record<CmsUnassignedReason, number>>
  outOfScope: number
  included: number
  classCounts: CmsQuantityClassCounts
  returnsRead: number
  returnsNotEffective: number
  returnsApplied: number
  returnsExcludedByReason: Partial<Record<CmsReturnExcludeReason, number>>
  returnBaseAppliedUnits: bigint
  returnGmvAppliedUnits: bigint
  amountVnd: bigint
}

export interface CmsCalcPolicyPin {
  quantityBasis: CmsQuantityBasis
  quantityPolicyVersion: string
  returnsPolicy: CmsReturnsPolicy
  contractVersion: string
}

export type CmsCalcOutput =
  | {
      ok: true
      policy: CmsCalcPolicyPin
      results: CmsCalcGroupResult[]
      catalog: CmsCalcCatalogResult[]
      history: CmsCalcHistoryLine[]
      excludedSales: CmsCalcExcludedSale[]
      excludedReturns: CmsCalcExcludedReturn[]
      totals: CmsCalcTotals
    }
  | { ok: false; policy: CmsCalcPolicyPin; holds: CmsCalcHold[] }

// ── Tính ─────────────────────────────────────────────────────────────────────

type Ev = {
  kind: 'SALE' | 'RETURN'
  at: bigint
  sale: CmsCalcSaleLine
  ret: CmsReturnCompleted | null
  cls: CmsQuantityClass
  baseDelta: bigint
  eligibleDelta: bigint
  gmvDelta: bigint
}

const evId = (e: Ev) => (e.kind === 'SALE' ? e.sale.orderLineId : e.ret!.returnEventId)
const cmpEv = (a: Ev, b: Ev) => compareCmsCalcEvents({ kind: a.kind, at: a.at, id: evId(a) }, { kind: b.kind, at: b.at, id: evId(b) })

function trackGate(events: readonly Ev[], targetVnd: bigint): { gmvUnits: bigint; met: boolean; metAtMicros: bigint | null } {
  const targetUnits = targetVnd * CMS_DEC_FACTOR
  let cum = ZERO
  let prevMet = false
  let lastCrossing: bigint | null = null
  for (const e of events) {
    cum += e.gmvDelta
    const met = cum >= targetUnits
    if (met && !prevMet) lastCrossing = e.at
    prevMet = met
  }
  return { gmvUnits: cum, met: prevMet, metAtMicros: prevMet ? lastCrossing : null }
}

const emptyClassCounts = (): CmsQuantityClassCounts => ({ POS_BASE: 0, COUNTED: 0, OTHER_UNIT: 0, FRACTIONAL_QUANTITY: 0, ZERO_QUANTITY: 0 })
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function computeCmsNet(input: CmsCalcInput): CmsCalcOutput {
  const basis = parseCmsQuantityBasis(input.program.quantityBasis)
  if (basis === null) throw new CmsCalcConfigError('BAD_QUANTITY_BASIS', 'cách tính lượng không hợp lệ')
  const returnsPolicy = parseCmsReturnsPolicy(input.program.returnsPolicy)
  if (returnsPolicy === null) throw new CmsCalcConfigError('BAD_RETURNS_POLICY', 'chính sách trả hàng không hợp lệ')
  if (returnsPolicy === 'sales_only_v1' && input.returns.length > 0) {
    throw new CmsCalcConfigError('RETURNS_NOT_ALLOWED', 'run sales_only_v1 không nhận bản ghi trả')
  }
  const policy: CmsCalcPolicyPin = {
    quantityBasis: basis, quantityPolicyVersion: CMS_QUANTITY_POLICY_VERSION[basis], returnsPolicy, contractVersion: CMS_CALC_CONTRACT_VERSION,
  }

  const program = parseCmsEngineProgram({ ...input.program, products: input.program.products.map(({ unitCms: _u, ...p }) => p) })
  const unitKeys = new Map<string, string | null>()
  for (const p of input.program.products) {
    const key = basis === 'cms_unit' ? cmsUnitKey(p.unitCms) : null
    if (basis === 'cms_unit' && key === null) throw new CmsCalcConfigError('UNIT_CMS_INVALID', 'unit_CMS rỗng / có ký tự không hợp lệ', p.productId)
    unitKeys.set(p.productId, key)
  }

  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const l of input.sales) {
    if (seen.has(l.orderLineId)) dup.add(l.orderLineId)
    else seen.add(l.orderLineId)
  }
  if (dup.size) throw new CmsEngineInputError('DUPLICATE_LINE_ID', [...dup].sort(compareCmsContractLineId))

  const holds: CmsCalcHold[] = []
  const totals: CmsCalcTotals = {
    linesRead: input.sales.length, candidates: 0, candidateGmvUnits: ZERO, unassigned: 0, unassignedGmvUnits: ZERO, unassignedByReason: {},
    outOfScope: 0, included: 0, classCounts: emptyClassCounts(), returnsRead: input.returns.length, returnsNotEffective: 0, returnsApplied: 0,
    returnsExcludedByReason: {}, returnBaseAppliedUnits: ZERO, returnGmvAppliedUnits: ZERO, amountVnd: ZERO,
  }

  // ── 1. Dòng bán: loại theo luật hiện hành, phân loại lượng MỌI ứng viên (kể cả chưa gán / ngoài phạm vi) ──
  type SaleState =
    | { candidate: false }
    | { candidate: true; cls: CmsQuantityClass | null; eligible: bigint; counted: bigint | null; included: { userId: string; storeId: string } | null; excluded: 'UNASSIGNED' | 'OUT_OF_SCOPE' | null }
  const sorted = [...input.sales].sort(compareCmsContractLines)
  const saleById = new Map<string, CmsCalcSaleLine>()
  const saleState = new Map<string, SaleState>()
  const excludedSales: CmsCalcExcludedSale[] = []
  const exclude = (line: CmsCalcSaleLine, reason: CmsExcludeReason, extra: Partial<CmsCalcExcludedSale> = {}) => {
    excludedSales.push({
      orderLineId: line.orderLineId, productId: line.productId, reason, unassignedReason: null, userId: null, storeId: null,
      completedAtMicros: line.completedAtMicros, baseQuantityUnits: line.baseQuantityUnits, gmvUnits: line.gmvUnits, quantityClass: null, ...extra,
    })
  }
  for (const line of sorted) {
    saleById.set(line.orderLineId, line)
    if (!isEligibleOrder(line)) { exclude(line, 'ORDER_NOT_ELIGIBLE'); saleState.set(line.orderLineId, { candidate: false }); continue }
    if (!isWithinWindow(line.completedAtMicros, program.window)) { exclude(line, 'OUT_OF_WINDOW'); saleState.set(line.orderLineId, { candidate: false }); continue }
    const product = program.products.get(line.productId)
    if (!product) { exclude(line, 'PRODUCT_NOT_IN_PROGRAM'); saleState.set(line.orderLineId, { candidate: false }); continue }
    totals.candidates += 1
    totals.candidateGmvUnits += line.gmvUnits
    const c = classifyCmsSale(line, { basis, perUnitUnits: product.perUnitUnits, unitKey: unitKeys.get(product.productId) ?? null })
    // TODO(D7, chờ PM): HOLD áp cho MỌI ứng viên, kể cả dòng sắp xếp thành chưa gán / ngoài phạm vi bên dưới.
    if (!c.ok) holds.push({ code: c.reason, ref: `SALE:${line.orderLineId}` })
    const cls = c.ok ? c.cls : null
    const eligible = c.ok ? c.eligibleBaseUnits : ZERO
    const counted = c.ok ? c.countedQty : null
    const seller = mapSeller(line.sellerEmail, input.sellers)
    if (!seller.ok) {
      totals.unassigned += 1
      totals.unassignedGmvUnits += line.gmvUnits
      totals.unassignedByReason[seller.reason] = (totals.unassignedByReason[seller.reason] ?? 0) + 1
      exclude(line, 'UNASSIGNED', { unassignedReason: seller.reason, quantityClass: cls })
      saleState.set(line.orderLineId, { candidate: true, cls, eligible, counted, included: null, excluded: 'UNASSIGNED' })
      continue
    }
    if (!program.storeIds.has(seller.storeId)) {
      totals.outOfScope += 1
      exclude(line, 'OUT_OF_SCOPE', { userId: seller.userId, storeId: seller.storeId, quantityClass: cls })
      saleState.set(line.orderLineId, { candidate: true, cls, eligible, counted, included: null, excluded: 'OUT_OF_SCOPE' })
      continue
    }
    totals.included += 1
    if (cls) totals.classCounts[cls] += 1
    saleState.set(line.orderLineId, { candidate: true, cls, eligible, counted, included: { userId: seller.userId, storeId: seller.storeId }, excluded: null })
  }

  // ── 2. Phiếu trả ──
  const excludedReturns: CmsCalcExcludedReturn[] = []
  const exReturn = (r: CmsReturnRecord, reason: CmsReturnExcludeReason) => {
    totals.returnsExcludedByReason[reason] = (totals.returnsExcludedByReason[reason] ?? 0) + 1
    excludedReturns.push(r.kind === 'COMPLETED'
      ? { returnEventId: r.returnEventId, originalOrderLineId: r.originalOrderLineId, productId: r.productId, reason, baseQuantityUnits: r.baseQuantityUnits, gmvUnits: r.gmvUnits }
      : { returnEventId: r.returnEventId, originalOrderLineId: null, productId: null, reason, baseQuantityUnits: null, gmvUnits: null })
  }
  const retCount = new Map<string, number>()
  for (const r of input.returns) retCount.set(r.returnEventId, (retCount.get(r.returnEventId) ?? 0) + 1)
  const dupReturns = new Set([...retCount].filter(([, n]) => n > 1).map(([id]) => id))
  // TODO(D8, chờ PM): trùng id HOLD kể cả khi các bản giống hệt (spec §4.1.6 chỉ nêu "đa bản khác tài chính").
  for (const id of dupReturns) holds.push({ code: 'RETURN_DUPLICATE_ID', ref: `RETURN:${id}` })

  const perSale = new Map<string, { r: bigint; h: bigint }>()
  const applied: CmsReturnCompleted[] = []
  for (const r of input.returns) {
    if (dupReturns.has(r.returnEventId)) continue
    if (r.kind === 'NOT_EFFECTIVE') { totals.returnsNotEffective += 1; exReturn(r, 'NOT_COMPLETED'); continue }
    const ref = `RETURN:${r.returnEventId}`
    const o = r.original
    // TODO(D9, chờ PM): COMPLETED sau as_of ⇒ HOLD (snapshot không nhất quán), không loại im lặng.
    if (r.recordedAtMicros > input.asOfMicros) holds.push({ code: 'RETURN_AFTER_AS_OF', ref })
    if (r.recordedAtMicros < o.completedAtMicros) holds.push({ code: 'RETURN_BEFORE_SALE', ref })
    const sale = saleById.get(r.originalOrderLineId)
    if (sale) {
      const bad: string[] = []
      if (sale.orderId !== r.originalOrderId) bad.push('original_order_id')
      if (sale.productId !== r.productId) bad.push('product_id')
      if (sale.completedAtMicros !== o.completedAtMicros) bad.push('original_completed_at')
      if (sale.orderType !== o.orderType) bad.push('original_order_type')
      if (sale.orderStatus !== o.orderStatus) bad.push('original_order_status')
      if (sale.sellerEmail !== o.sellerEmail) bad.push('original_seller_email')
      if (sale.posCode !== o.posCode) bad.push('original_pos_code')
      if (sale.baseQuantityUnits !== o.baseQuantityUnits) bad.push('original_base_quantity')
      if (sale.gmvUnits !== o.gmvUnits) bad.push('original_gmv_amount')
      if (basis === 'cms_unit') {
        if (sale.raw.quantityRaw !== o.quantityRaw) bad.push('original_quantity_raw')
        if (sale.raw.uomRaw !== o.uomRaw) bad.push('original_uom_raw')
      }
      if (bad.length) { holds.push({ code: 'RETURN_CONTEXT_MISMATCH', ref, fields: bad }); continue }
    }
    if (!(o.orderType === 'OFFLINE' && o.orderStatus === 'COMPLETED')) { exReturn(r, 'ORIGIN_NOT_ELIGIBLE'); continue }
    if (!isWithinWindow(o.completedAtMicros, program.window)) { exReturn(r, 'ORIGIN_OUT_OF_WINDOW'); continue }
    if (!program.products.has(r.productId)) { exReturn(r, 'ORIGIN_NOT_IN_PROGRAM'); continue }
    if (!sale) { holds.push({ code: 'RETURN_ORIGIN_MISSING', ref }); continue }
    const acc = perSale.get(sale.orderLineId) ?? { r: ZERO, h: ZERO }
    acc.r += r.baseQuantityUnits
    acc.h += r.gmvUnits
    perSale.set(sale.orderLineId, acc)
    const st = saleState.get(sale.orderLineId)!
    if (!st.candidate) throw new Error('CMS calc invariant: dòng gốc khớp ngữ cảnh chương trình nhưng không là ứng viên')
    if (st.excluded === 'UNASSIGNED') { exReturn(r, 'ORIGIN_UNASSIGNED'); continue }
    if (st.excluded === 'OUT_OF_SCOPE') { exReturn(r, 'ORIGIN_OUT_OF_SCOPE'); continue }
    applied.push(r)
  }
  // Danh sách loại không phụ thuộc thứ tự nguồn trả về (R10).
  excludedReturns.sort((a, b) => compareUtf8Bytes(a.returnEventId, b.returnEventId))
  for (const [id, acc] of perSale) {
    const sale = saleById.get(id)!
    if (acc.r > sale.baseQuantityUnits) holds.push({ code: 'RETURN_EXCEEDS_SALE_BASE', ref: `SALE:${id}` })
    // TODO(D6, chờ PM): HOLD theo từng dòng gốc; chờ BI nêu ca refund hợp lệ vượt GMV gốc (spec §4.4) trước khi đổi.
    if (acc.h > sale.gmvUnits) holds.push({ code: 'RETURN_EXCEEDS_SALE_GMV', ref: `SALE:${id}` })
  }

  if (holds.length) {
    const key = (h: CmsCalcHold) => `${h.code}\u0000${h.ref}`
    const uniq = new Map(holds.map((h) => [key(h), h]))
    return { ok: false, policy, holds: [...uniq.values()].sort((a, b) => cmp(a.code, b.code) || compareUtf8Bytes(a.ref, b.ref)) }
  }

  // ── 3. Sự kiện theo nhóm ──
  type Group = { userId: string; storeId: string; product: CmsEngineProduct; events: Ev[]; classCounts: CmsQuantityClassCounts; counted: bigint | null }
  const groups = new Map<string, Group>()
  const catalogEvents = new Map<string, { storeId: string; events: Ev[] }>()
  const groupOf = (userId: string, storeId: string, product: CmsEngineProduct) => {
    const k = `${userId}\u0000${product.productId}`
    let g = groups.get(k)
    if (!g) { g = { userId, storeId, product, events: [], classCounts: emptyClassCounts(), counted: basis === 'cms_unit' ? ZERO : null }; groups.set(k, g) }
    return g
  }
  const pushEv = (g: Group, ev: Ev) => {
    g.events.push(ev)
    if (g.product.gmvBasis === 'catalog') {
      let c = catalogEvents.get(g.userId)
      if (!c) { c = { storeId: g.storeId, events: [] }; catalogEvents.set(g.userId, c) }
      c.events.push(ev)
    }
  }
  for (const line of sorted) {
    const st = saleState.get(line.orderLineId)!
    if (!st.candidate || !st.included || !st.cls) continue
    const g = groupOf(st.included.userId, st.included.storeId, program.products.get(line.productId)!)
    g.classCounts[st.cls] += 1
    if (g.counted !== null && st.counted !== null) g.counted += st.counted
    pushEv(g, { kind: 'SALE', at: line.completedAtMicros, sale: line, ret: null, cls: st.cls, baseDelta: line.baseQuantityUnits, eligibleDelta: st.eligible, gmvDelta: line.gmvUnits })
  }
  for (const r of applied) {
    const sale = saleById.get(r.originalOrderLineId)!
    const st = saleState.get(sale.orderLineId) as Extract<SaleState, { candidate: true }>
    const g = groupOf(st.included!.userId, st.included!.storeId, program.products.get(sale.productId)!)
    const contributes = cmsClassContributes(st.cls!)
    totals.returnsApplied += 1
    totals.returnBaseAppliedUnits += r.baseQuantityUnits
    totals.returnGmvAppliedUnits += r.gmvUnits
    pushEv(g, {
      kind: 'RETURN', at: r.recordedAtMicros, sale, ret: r, cls: st.cls!, baseDelta: -r.baseQuantityUnits,
      eligibleDelta: contributes ? -r.baseQuantityUnits : ZERO, gmvDelta: -r.gmvUnits,
    })
  }

  const catalog: CmsCalcCatalogResult[] = []
  const catalogByUser = new Map<string, CmsCalcCatalogResult>()
  for (const [userId, c] of catalogEvents) {
    c.events.sort(cmpEv)
    const t = trackGate(c.events, program.catalogTargetVnd!)
    const res: CmsCalcCatalogResult = { userId, storeId: c.storeId, catalogNetGmvUnits: t.gmvUnits, targetVnd: program.catalogTargetVnd!, met: t.met, metAtMicros: t.metAtMicros, events: c.events.length }
    catalog.push(res)
    catalogByUser.set(userId, res)
  }
  catalog.sort((a, b) => cmp(a.userId, b.userId))

  const results: CmsCalcGroupResult[] = []
  const history: CmsCalcHistoryLine[] = []
  for (const g of groups.values()) {
    const { product } = g
    g.events.sort(cmpEv)
    let gate: CmsGateOutcome
    if (product.gmvBasis === 'product') {
      const t = trackGate(g.events, product.targetVnd!)
      gate = { gateGmvUnits: t.gmvUnits, targetVnd: product.targetVnd, met: t.met, metAtMicros: t.metAtMicros }
    } else if (product.gmvBasis === 'catalog') {
      const c = catalogByUser.get(g.userId)!
      gate = { gateGmvUnits: c.catalogNetGmvUnits, targetVnd: c.targetVnd, met: c.met, metAtMicros: c.metAtMicros }
    } else {
      gate = { gateGmvUnits: null, targetVnd: null, met: true, metAtMicros: null }
    }

    let elig = ZERO
    let saleBase = ZERO, retBase = ZERO, eligSale = ZERO, eligRet = ZERO, saleGmv = ZERO, retGmv = ZERO
    let lineSum = ZERO
    let saleLines = 0, returnEvents = 0
    for (const e of g.events) {
      const before = elig
      elig += e.eligibleDelta
      if (elig < ZERO) throw new Error('CMS calc invariant: B đủ điều kiện âm giữa chuỗi')
      if (e.kind === 'SALE') { saleLines += 1; saleBase += e.baseDelta; eligSale += e.eligibleDelta; saleGmv += e.gmvDelta }
      else { returnEvents += 1; retBase -= e.baseDelta; eligRet -= e.eligibleDelta; retGmv -= e.gmvDelta }
      const qtyBefore = cmsQuantityOf(before, product.perUnitUnits)
      const qtyAfter = cmsQuantityOf(elig, product.perUnitUnits)
      const amountVnd = gate.met
        ? cmsAmountAtBase(elig, product.perUnitUnits, product.tiers) - cmsAmountAtBase(before, product.perUnitUnits, product.tiers)
        : ZERO
      lineSum += amountVnd
      let status: CmsCalcLineStatus
      if (e.kind === 'SALE') {
        if (!cmsClassContributes(e.cls)) status = 'NOT_COUNTED'
        else if (!gate.met) status = 'WAITING_GATE'
        else if (amountVnd > ZERO) status = 'RECORDED'
        else status = 'ACCUMULATING'
      } else if (!gate.met && e.eligibleDelta !== ZERO) status = 'WAITING_GATE'
      else status = amountVnd < ZERO ? 'RETURN_REDUCED' : 'RETURN_NO_CHANGE'
      const s = e.sale
      history.push({
        kind: e.kind, key: e.kind === 'SALE' ? `SALE:${s.orderLineId}` : `RETURN:${e.ret!.returnEventId}`,
        orderLineId: s.orderLineId, orderId: s.orderId, orderCode: s.orderCode,
        returnEventId: e.ret?.returnEventId ?? null, returnDocumentId: e.ret?.returnDocumentId ?? null, returnCode: e.ret?.returnCode ?? null,
        productId: product.productId, userId: g.userId, storeId: g.storeId, posCode: s.posCode, atMicros: e.at, quantityClass: e.cls,
        baseDeltaUnits: e.baseDelta, eligibleDeltaUnits: e.eligibleDelta, gmvDeltaUnits: e.gmvDelta,
        eligibleBeforeUnits: before, eligibleAfterUnits: elig, qtyBefore, qtyAfter, amountVnd, status,
      })
    }
    const netBase = saleBase - retBase
    const netGmv = saleGmv - retGmv
    if (netBase < ZERO || netGmv < ZERO) throw new Error('CMS calc invariant: B / GMV ròng âm sau kiểm từng dòng gốc')
    const cmsQuantity = cmsQuantityOf(elig, product.perUnitUnits)
    const potentialAmountVnd = cmsProgressiveAmount(cmsQuantity, product.tiers)
    const amountVnd = gate.met ? potentialAmountVnd : ZERO
    if (lineSum !== amountVnd) throw new Error(`CMS calc invariant: tổng tiền sự kiện ${lineSum} ≠ tiền nhóm ${amountVnd}`)
    if (elig !== eligSale - eligRet) throw new Error('CMS calc invariant: B đủ ròng lệch tổng')
    totals.amountVnd += amountVnd
    results.push({
      userId: g.userId, storeId: g.storeId, productId: product.productId, gmvBasis: product.gmvBasis, perUnitUnits: product.perUnitUnits,
      saleBaseUnits: saleBase, returnBaseUnits: retBase, netBaseUnits: netBase,
      eligibleSaleBaseUnits: eligSale, eligibleReturnBaseUnits: eligRet, eligibleNetBaseUnits: elig,
      countedSaleQty: g.counted, cmsQuantity, remainderBaseUnits: elig - cmsQuantity * product.perUnitUnits,
      saleGmvUnits: saleGmv, returnGmvUnits: retGmv, netGmvUnits: netGmv,
      gate, potentialAmountVnd, amountVnd, saleLines, returnEvents, classCounts: g.classCounts,
    })
  }
  results.sort((a, b) => cmp(a.userId, b.userId) || compareCmsContractLineId(a.productId, b.productId))
  history.sort((a, b) => compareCmsCalcEvents({ kind: a.kind, at: a.atMicros, id: a.returnEventId ?? a.orderLineId }, { kind: b.kind, at: b.atMicros, id: b.returnEventId ?? b.orderLineId }))

  return { ok: true, policy, results, catalog, history, excludedSales, excludedReturns, totals }
}
