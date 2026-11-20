// CMS-CALC-RET-2 — payload stage của RUN CONTRACT (`cms-calc-ret2-v1`, thiết kế Dev r2 §4–§5; migration 130 `cms__stage_contract` /
// `cms__seal_begin_contract` / seal 13 bước). Hàm thuần trên kết quả computeCmsNet (net.ts) — DB tự tính lại mọi thứ ở seal, payload
// chỉ là khai báo để đối chiếu. Run legacy (pos_base + sales_only_v1) giữ resultStage.ts.
//  · 6 part, thứ tự stage = thứ tự FK: source_lines → sales_lines → results → catalog → return_lines (chỉ net) → result_events.
//  · Lớp nguồn: MỌI dòng bán hợp lệ đã đọc + chuỗi THÔ q / u đã capture (src + cờ); *_raw = làm sạch của thô, có cờ ⇒ NULL.
//  · Lớp bán: ứng viên (INCLUDED / UNASSIGNED / OUT_OF_SCOPE) theo khoá D1 + lớp lượng / B đủ.
//  · Sự kiện: lịch sử engine (thứ tự toàn cục µs → SALE trước RETURN → ID) ⇒ seq.
//  · Pin cms-source-pin-v1 + digest cms-src-digest-v1 (srcDigest.ts) — DB tính lại ở seal N9.
// Chỉ dùng phía server.

import { formatCmsDecimal } from '../decimal'
import { formatUtcMicros } from '../time'
import {
  CMS_STAGE_CHUNK_DEFAULT, CMS_STAGE_CHUNK_MAX, CmsSnapshotError, cmsSnapshotToEngineInput, parseCmsSalesSnapshot,
  type CmsSalesSnapshot, type CmsStageRow,
} from '../resultStage'
import { cmsClassContributes } from './classify'
import type { CmsCalcInput, CmsCalcOutput, CmsCalcSaleLine } from './net'
import { compareCmsContractLines, compareUtf8Bytes } from './order'
import {
  cmsCalcContractVersionFor, cmsPolicyReadsReturns, parseCmsQuantityBasis, parseCmsReturnsPolicy, type CmsCalcContractVersion,
  type CmsQuantityBasis, type CmsReturnsPolicy,
} from './policy'
import { CMS_RETURN_EFFECTIVE_STATUS, type CmsReturnRecord } from './returns'
import { cmsCaptureSrc, cmsSrcClean } from './src'
import { cmsDigestRowHash, cmsDigestSet, cmsProductsHash, cmsReturnDigestHash, cmsSalesDigestHash } from './srcDigest'

export const CMS_SOURCE_PIN_VERSION = 'cms-source-pin-v1'
/** Part run contract theo thứ tự stage (FK). */
export const CMS_CONTRACT_PARTS = ['source_lines', 'sales_lines', 'results', 'catalog', 'return_lines', 'result_events'] as const
export type CmsContractPart = (typeof CMS_CONTRACT_PARTS)[number]
/** Số bước seal của run contract (migration 130). */
export const CMS_CONTRACT_SEAL_STEPS = 13

export interface CmsContractSnapshot extends CmsSalesSnapshot {
  quantityBasis: CmsQuantityBasis
  returnsPolicy: CmsReturnsPolicy
  /** Hợp đồng DB ghim cho run vừa mở; null ⇒ run legacy. Luôn = hợp đồng của policy (v2 ⇔ full_line). */
  calcContractVersion: CmsCalcContractVersion | null
  /** unit_CMS theo ProductID. */
  unitCms: ReadonlyMap<string, string | null>
}

/** Snapshot run (open 130): phần 122 / 124 + chế độ chương trình + unit_CMS + hợp đồng run. */
export function parseCmsContractSnapshot(raw: unknown): CmsContractSnapshot {
  const base = parseCmsSalesSnapshot(raw)
  const o = raw as Record<string, unknown>
  const basis = parseCmsQuantityBasis(o.quantity_basis)
  if (basis === null) throw new CmsSnapshotError('quantity_basis')
  const policy = parseCmsReturnsPolicy(o.returns_policy)
  if (policy === null) throw new CmsSnapshotError('returns_policy')
  const cc = o.calc_contract_version
  if (cc !== null && cc !== undefined && cc !== cmsCalcContractVersionFor(policy)) throw new CmsSnapshotError('calc_contract_version')
  const unitCms = new Map<string, string | null>()
  for (const p of o.products as unknown[]) {
    const r = p as Record<string, unknown>
    const u = r.unit_cms
    if (u !== null && u !== undefined && typeof u !== 'string') throw new CmsSnapshotError('products.unit_cms')
    unitCms.set(String(r.product_id), (u ?? null) as string | null)
  }
  return { ...base, quantityBasis: basis, returnsPolicy: policy, calcContractVersion: (cc ?? null) as CmsCalcContractVersion | null, unitCms }
}

/** Input computeCmsNet từ snapshot run contract. */
export function cmsContractCalcInput(s: CmsContractSnapshot, sales: readonly CmsCalcSaleLine[], returns: readonly CmsReturnRecord[],
  asOfMicros: bigint): CmsCalcInput {
  const { program, sellers } = cmsSnapshotToEngineInput(s)
  return {
    program: {
      ...program, quantityBasis: s.quantityBasis, returnsPolicy: s.returnsPolicy,
      products: program.products.map((p) => ({ ...p, unitCms: s.unitCms.get(p.productId) ?? null })),
    },
    sales, returns, sellers, asOfMicros,
  }
}

export interface CmsContractMeta {
  rowsRead: number
  rowsRejected: number
  bytesProcessed: number | null
  provider: 'bq' | 'fixture'
  /** Đúng MỘT trong hai. */
  jobId?: string
  snapshotId?: string
  asOfMicros: bigint
  /** Digest dòng normalizer từ chối (worker chứng thực). */
  rejectedDigest: string
  chunkSize?: number
}

export interface CmsContractPayload {
  parts: Record<CmsContractPart, CmsStageRow[]>
  /** Khai báo cho cms__seal_begin_contract (đúng tập khoá theo loại run). */
  expect: Record<string, unknown>
  /** Part cần stage (sales-only bỏ return_lines). */
  stageParts: readonly CmsContractPart[]
}

const dec = (u: bigint) => formatCmsDecimal(u)
const decN = (u: bigint | null) => (u === null ? null : formatCmsDecimal(u))
const ts = (m: bigint | null) => (m === null ? null : formatUtcMicros(m))

/** Thô q / u của dòng bán ⇒ cột *_raw / *_src / *_src_flag (cùng quy tắc CHECK 130 + seal N1). */
function srcCols(l: CmsCalcSaleLine) {
  const q = cmsCaptureSrc(l.raw.quantityRaw)
  const u = cmsCaptureSrc(l.raw.uomRaw)
  const qRaw = q.flag ? null : l.quantityRaw
  const uRaw = u.flag ? null : l.uomRaw
  if (!q.flag && qRaw !== cmsSrcClean(q.src)) throw new Error(`CMS contract: quantity_raw ≠ làm sạch của chuỗi thô (${l.orderLineId})`)
  if (!u.flag && uRaw !== cmsSrcClean(u.src)) throw new Error(`CMS contract: uom_raw ≠ làm sạch của chuỗi thô (${l.orderLineId})`)
  return { quantity_raw: qRaw, uom_raw: uRaw, quantity_src: q.src, uom_src: u.src, quantity_src_flag: q.flag, uom_src_flag: u.flag }
}

/**
 * Payload stage run contract. `sales` = TOÀN BỘ dòng bán hợp lệ đã đọc (cùng tập đưa vào engine), `returns` = mọi phiếu provider trả
 * (đã chuẩn hoá), `out` = computeCmsNet() thành công trên đúng hai tập đó.
 */
export function buildCmsContractStagePayload(snap: CmsContractSnapshot, sales: readonly CmsCalcSaleLine[], returns: readonly CmsReturnRecord[],
  out: Extract<CmsCalcOutput, { ok: true }>, meta: CmsContractMeta): CmsContractPayload {
  // `net` = run đọc nguồn trả (net_returns_v1 hoặc full_line_qty_refund_v1): có part return_lines + pin.returns.
  const net = cmsPolicyReadsReturns(snap.returnsPolicy)
  if (!net && returns.length) throw new Error('CMS contract: chương trình sales-only không nhận phiếu trả')
  for (const r of returns) {
    if (r.kind === 'COMPLETED' && r.profile !== snap.returnsPolicy) throw new Error('CMS contract: phiếu chuẩn hoá khác policy run')
  }
  if (meta.rowsRead !== sales.length + meta.rowsRejected) throw new Error('CMS contract: rows_read ≠ dòng hợp lệ + dòng từ chối')
  if ((meta.jobId === undefined) === (meta.snapshotId === undefined)) throw new Error('CMS contract: pin cần đúng một job_id / snapshot_id')
  const ppId = new Map(snap.products.map((p) => [p.productId, p.id]))
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`CMS contract stage: thiếu ${what}`)
    return v
  }
  const byId = new Map(sales.map((l) => [l.orderLineId, l]))

  // ── Lớp nguồn ──
  const source = [...sales].sort((a, b) => compareUtf8Bytes(a.orderLineId, b.orderLineId))
  const sourceRows: CmsStageRow[] = source.map((l) => ({
    order_line_id: l.orderLineId, order_id: l.orderId, order_code: l.orderCode, product_id: l.productId, seller_email: l.sellerEmail,
    pos_code: l.posCode, order_type: l.orderType, order_status: l.orderStatus, completed_at: formatUtcMicros(l.completedAtMicros),
    source_updated_at: formatUtcMicros(l.sourceUpdatedAtMicros), base_quantity: dec(l.baseQuantityUnits), gmv_amount: dec(l.gmvUnits),
    ...srcCols(l),
  }))

  // ── Lớp bán: ứng viên ──
  type Cand = { line: CmsCalcSaleLine; disposition: 'INCLUDED' | 'UNASSIGNED' | 'OUT_OF_SCOPE'; userId: string | null; storeId: string | null
    reason: string | null; cls: string; eligible: bigint }
  const cands: Cand[] = []
  for (const h of out.history) {
    if (h.kind !== 'SALE') continue
    cands.push({ line: need(byId.get(h.orderLineId), 'dòng bán'), disposition: 'INCLUDED', userId: h.userId, storeId: h.storeId, reason: null,
      cls: h.quantityClass, eligible: h.eligibleDeltaUnits })
  }
  const excludedByReason: Record<string, number> = {}
  for (const x of out.excludedSales) {
    excludedByReason[x.reason] = (excludedByReason[x.reason] ?? 0) + 1
    if (x.reason !== 'UNASSIGNED' && x.reason !== 'OUT_OF_SCOPE') continue
    if (x.quantityClass === null) throw new Error('CMS contract: ứng viên thiếu lớp lượng')
    const line = need(byId.get(x.orderLineId), 'dòng bán')
    cands.push({ line, disposition: x.reason, userId: x.userId, storeId: x.storeId, reason: x.unassignedReason, cls: x.quantityClass,
      eligible: cmsClassContributes(x.quantityClass) ? line.baseQuantityUnits : BigInt(0) })
  }
  cands.sort((a, b) => compareCmsContractLines(a.line, b.line))
  const salesRows: CmsStageRow[] = cands.map((c, seq) => ({
    order_line_id: c.line.orderLineId, seq: String(seq), order_id: c.line.orderId, order_code: c.line.orderCode, product_id: c.line.productId,
    program_product_id: need(ppId.get(c.line.productId), 'program_product_id'), seller_email: c.line.sellerEmail, user_id: c.userId,
    store_id: c.storeId, pos_code: c.line.posCode, completed_at: formatUtcMicros(c.line.completedAtMicros),
    source_updated_at: formatUtcMicros(c.line.sourceUpdatedAtMicros), base_quantity: dec(c.line.baseQuantityUnits),
    gmv_amount: dec(c.line.gmvUnits), disposition: c.disposition, unassigned_reason: c.reason, quantity_class: c.cls,
    eligible_base: dec(c.eligible), ...srcCols(c.line),
  }))

  // ── Kết quả nhóm / danh mục ──
  const resultRows: CmsStageRow[] = out.results.map((r) => ({
    program_product_id: need(ppId.get(r.productId), 'program_product_id'), product_id: r.productId, user_id: r.userId, store_id: r.storeId,
    gmv_basis: r.gmvBasis, base_quantity: dec(r.netBaseUnits), per_unit: dec(r.perUnitUnits), cms_quantity: r.cmsQuantity.toString(),
    rewarded_quantity: r.cmsQuantity.toString(), cap_quantity: null, at_cap: false, gmv_amount: dec(r.netGmvUnits),
    gate_gmv: r.gate.gateGmvUnits === null ? null : dec(r.gate.gateGmvUnits), target_gmv: r.gate.targetVnd === null ? null : r.gate.targetVnd.toString(),
    gate_met: r.gate.met, gate_met_at: ts(r.gate.metAtMicros), potential_amount: r.potentialAmountVnd.toString(),
    amount_vnd: r.amountVnd.toString(), line_count: String(r.saleLines), sale_base: dec(r.saleBaseUnits), return_base: dec(r.returnBaseUnits),
    eligible_sale_base: dec(r.eligibleSaleBaseUnits), eligible_return_base: dec(r.eligibleReturnBaseUnits),
    eligible_base: dec(r.eligibleNetBaseUnits), counted_sale_qty: r.countedSaleQty === null ? null : r.countedSaleQty.toString(),
    sale_gmv: dec(r.saleGmvUnits), return_gmv: dec(r.returnGmvUnits), return_count: String(r.returnEvents),
  }))
  const catalogRows: CmsStageRow[] = out.catalog.map((c) => ({
    user_id: c.userId, store_id: c.storeId, catalog_gmv: dec(c.catalogNetGmvUnits), target_gmv: c.targetVnd.toString(), met: c.met,
    met_at: ts(c.metAtMicros), line_count: String(c.events),
  }))

  // ── Phiếu trả (net) ──
  const applied = new Set(out.history.filter((h) => h.kind === 'RETURN').map((h) => h.returnEventId as string))
  const exReturn = new Map(out.excludedReturns.map((x) => [x.returnEventId, x.reason]))
  const retSorted = [...returns].sort((a, b) => compareUtf8Bytes(a.returnEventId, b.returnEventId))
  const returnRows: CmsStageRow[] = retSorted.map((r, seq): CmsStageRow => {
    if (r.kind === 'NOT_EFFECTIVE') {
      return { return_event_id: r.returnEventId, seq: String(seq), return_status: r.status, disposition: 'NOT_COMPLETED' }
    }
    const disposition = applied.has(r.returnEventId) ? 'APPLIED' : need(exReturn.get(r.returnEventId), `disposition phiếu ${r.returnEventId}`)
    const q = cmsCaptureSrc(r.original.quantityRaw)
    const u = cmsCaptureSrc(r.original.uomRaw)
    return {
      return_event_id: r.returnEventId, seq: String(seq), return_status: CMS_RETURN_EFFECTIVE_STATUS, return_document_id: r.returnDocumentId,
      return_code: r.returnCode, recorded_at: formatUtcMicros(r.recordedAtMicros), original_order_line_id: r.originalOrderLineId,
      original_order_id: r.originalOrderId, product_id: r.productId, return_base_quantity: decN(r.baseQuantityUnits),
      return_gmv_amount: dec(r.gmvUnits), original_completed_at: formatUtcMicros(r.original.completedAtMicros),
      original_order_type: r.original.orderType, original_order_status: r.original.orderStatus,
      original_seller_email: r.original.sellerEmail, original_pos_code: r.original.posCode,
      original_base_quantity: decN(r.original.baseQuantityUnits), original_gmv_amount: decN(r.original.gmvUnits),
      original_quantity_src: q.src, original_uom_src: u.src, original_quantity_src_flag: q.flag, original_uom_src_flag: u.flag,
      source_updated_at: ts(r.sourceUpdatedAtMicros), disposition,
      sale_ref_line_id: ['APPLIED', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE'].includes(disposition) ? r.originalOrderLineId : null,
    }
  })

  // ── Sự kiện ──
  const eventRows: CmsStageRow[] = out.history.map((h, seq) => ({
    event_key: h.key, seq: String(seq), kind: h.kind, event_at: formatUtcMicros(h.atMicros), order_line_id: h.orderLineId,
    return_event_id: h.returnEventId, user_id: h.userId, program_product_id: need(ppId.get(h.productId), 'program_product_id'),
    quantity_class: h.quantityClass, base_delta: dec(h.baseDeltaUnits), eligible_delta: dec(h.eligibleDeltaUnits),
    gmv_delta: dec(h.gmvDeltaUnits), eligible_before: dec(h.eligibleBeforeUnits), eligible_after: dec(h.eligibleAfterUnits),
    qty_before: h.qtyBefore.toString(), qty_after: h.qtyAfter.toString(), amount_vnd: h.amountVnd.toString(), status: h.status,
  }))

  // ── Pin / digest ──
  const salesDigest = cmsDigestSet('sales', source.map((l) => {
    const c = srcCols(l)
    return { id: l.orderLineId, hash: cmsSalesDigestHash({
      orderLineId: l.orderLineId, orderId: l.orderId, orderCode: l.orderCode, productId: l.productId, sellerEmail: l.sellerEmail,
      posCode: l.posCode, orderType: l.orderType, orderStatus: l.orderStatus, completedAtMicros: l.completedAtMicros,
      sourceUpdatedAtMicros: l.sourceUpdatedAtMicros, quantitySrc: c.quantity_src, uomSrc: c.uom_src, quantitySrcFlag: c.quantity_src_flag,
      uomSrcFlag: c.uom_src_flag, baseQuantityUnits: l.baseQuantityUnits, gmvUnits: l.gmvUnits,
    }) }
  }))
  const returnsDigest = cmsDigestSet('returns', retSorted.map((r) => {
    if (r.kind === 'NOT_EFFECTIVE') {
      return { id: r.returnEventId, hash: cmsReturnDigestHash({
        returnEventId: r.returnEventId, returnStatus: r.status, returnDocumentId: null, returnCode: null, recordedAtMicros: null,
        originalOrderLineId: null, originalOrderId: null, productId: null, baseQuantityUnits: null, gmvUnits: null,
        originalCompletedAtMicros: null, originalOrderType: null, originalOrderStatus: null, originalSellerEmail: null, originalPosCode: null,
        originalBaseQuantityUnits: null, originalGmvUnits: null, originalQuantitySrc: null, originalUomSrc: null,
        originalQuantitySrcFlag: null, originalUomSrcFlag: null, sourceUpdatedAtMicros: null,
      }) }
    }
    const q = cmsCaptureSrc(r.original.quantityRaw)
    const u = cmsCaptureSrc(r.original.uomRaw)
    return { id: r.returnEventId, hash: cmsReturnDigestHash({
      returnEventId: r.returnEventId, returnStatus: CMS_RETURN_EFFECTIVE_STATUS, returnDocumentId: r.returnDocumentId, returnCode: r.returnCode,
      recordedAtMicros: r.recordedAtMicros, originalOrderLineId: r.originalOrderLineId, originalOrderId: r.originalOrderId, productId: r.productId,
      baseQuantityUnits: r.baseQuantityUnits, gmvUnits: r.gmvUnits, originalCompletedAtMicros: r.original.completedAtMicros,
      originalOrderType: r.original.orderType, originalOrderStatus: r.original.orderStatus, originalSellerEmail: r.original.sellerEmail,
      originalPosCode: r.original.posCode, originalBaseQuantityUnits: r.original.baseQuantityUnits, originalGmvUnits: r.original.gmvUnits,
      originalQuantitySrc: q.src, originalUomSrc: u.src, originalQuantitySrcFlag: q.flag, originalUomSrcFlag: u.flag,
      sourceUpdatedAtMicros: r.sourceUpdatedAtMicros,
    }) }
  }))

  const parts: Record<CmsContractPart, CmsStageRow[]> = {
    source_lines: sourceRows, sales_lines: salesRows, results: resultRows, catalog: catalogRows, return_lines: returnRows, result_events: eventRows,
  }
  const stageParts = CMS_CONTRACT_PARTS.filter((p) => net || p !== 'return_lines')
  const size = Math.max(1, Math.min(meta.chunkSize ?? CMS_STAGE_CHUNK_DEFAULT, CMS_STAGE_CHUNK_MAX))
  const nChunks = (n: number) => Math.ceil(n / size)
  let maxUpdated: bigint | null = null
  for (const l of sales) if (maxUpdated === null || l.sourceUpdatedAtMicros > maxUpdated) maxUpdated = l.sourceUpdatedAtMicros
  const t = out.totals
  const counts: Record<string, number> = {}
  const chunks: Record<string, number> = {}
  for (const p of stageParts) { counts[p] = parts[p].length; chunks[p] = nChunks(parts[p].length) }
  const pin: Record<string, unknown> = {
    protocol: CMS_SOURCE_PIN_VERSION, provider: meta.provider,
    ...(meta.jobId !== undefined ? { job_id: meta.jobId } : { snapshot_id: meta.snapshotId }),
    as_of: formatUtcMicros(meta.asOfMicros),
    scope: { from: snap.startDate, to: snap.endDate, products_hash: cmsProductsHash(snap.products.map((p) => p.productId)) },
    sales: { rows_total: meta.rowsRead, rows_staged: sales.length, rows_rejected: meta.rowsRejected, staged_digest: salesDigest,
      rejected_digest: meta.rejectedDigest },
    ...(net ? { returns: { rows: returns.length, digest: returnsDigest } } : {}),
  }
  return {
    parts,
    stageParts,
    expect: {
      ...counts,
      chunks,
      amount_vnd: t.amountVnd.toString(),
      rows_read: meta.rowsRead,
      rows_rejected: meta.rowsRejected,
      bytes_processed: meta.bytesProcessed,
      source_max_updated_at: ts(maxUpdated),
      totals: {
        lines_read: t.linesRead, candidates: t.candidates, included: t.included, unassigned: t.unassigned, out_of_scope: t.outOfScope,
        returns_read: t.returnsRead, returns_not_effective: t.returnsNotEffective, returns_applied: t.returnsApplied,
        candidate_gmv: dec(t.candidateGmvUnits), unassigned_gmv: dec(t.unassignedGmvUnits), amount_vnd: t.amountVnd.toString(),
        return_base_applied: dec(t.returnBaseAppliedUnits), return_gmv_applied: dec(t.returnGmvAppliedUnits),
        unassigned_by_reason: { ...t.unassignedByReason }, excluded_by_reason: excludedByReason, class_counts: { ...t.classCounts },
        returns_excluded_by_reason: { ...t.returnsExcludedByReason },
      },
      pin,
    },
  }
}

/** Digest tập dòng normalizer từ chối (worker chứng thực): ID = vị trí dòng trong kết quả nguồn (12 chữ số), hash = token giá trị thô. */
export function cmsRejectedDigest(rows: readonly { position: number; values: readonly (string | null)[] }[]): string {
  return cmsDigestSet('rejected', rows.map((r) => ({ id: String(r.position).padStart(12, '0'), hash: cmsDigestRowHash(r.values) })))
}
