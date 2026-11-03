// CMS P2-b — hợp đồng snapshot ↔ engine ↔ staging của migration 122 (planning/research/cms-consolidated-implementation-plan
// -2026-11-02.md §4; docs/cms/SPEC.md §5). Hàm thuần, không I/O:
//  · parseCmsSalesSnapshot: kiểm shape jsonb của rpc_cms_sales_snapshot / rpc_cms_sales_run_open (fail-closed, không đoán).
//  · cmsSnapshotToEngineInput: cấu hình chương trình + chỉ mục người bán cho computeCmsProgram (engine P2-a, KHÔNG tính lại).
//  · buildCmsStagePayload: dòng ứng viên (INCLUDED / UNASSIGNED / OUT_OF_SCOPE) + kết quả engine ⇒ 4 part + expect cho seal.
//    Số thập phân / bigint đi dạng chuỗi (không qua number), timestamp ISO UTC 6 chữ số micro giây.
//  · cmsStageBoundsIssue: số vượt miền cột DB (bigint, |x| < 1e35 …) ⇒ mã OVERFLOW trước khi stage (không để DB cắt / lỗi giữa
//    chừng, không clamp).

import { formatCmsDecimal, CMS_DEC_FACTOR } from './decimal'
import { compareCmsLines, type CmsEngineOutput, type CmsExcludeReason } from './engine/compute'
import type { CmsEngineProgramInput } from './engine/config'
import { buildSellerIndex, type CmsSellerIndex, type CmsStoreRef, type CmsUserRef } from './mapping'
import type { CmsSalesLine } from './source/contract'
import { formatUtcMicros } from './time'

const ZERO = BigInt(0)
export const CMS_INT64_MAX = BigInt('9223372036854775807')
/** Khối stage tối đa (RPC 122 nhận 1…5.000 dòng / khối). */
export const CMS_STAGE_CHUNK_MAX = 5000
/** Mặc định 1.000 dòng / khối (~0,6 MB JSON) — giữ request PostgREST nhỏ; đo lại ở I4 trên quy mô thật. */
export const CMS_STAGE_CHUNK_DEFAULT = 1000

export class CmsSnapshotError extends Error {
  constructor(detail: string) {
    super(`CMS snapshot không hợp lệ: ${detail}`)
    this.name = 'CmsSnapshotError'
  }
}

export interface CmsSnapshotTier { order: number; from: number; to: number | null; amount: string }
export interface CmsSnapshotProduct {
  id: string
  productId: string
  gmvBasis: 'product' | 'catalog' | 'none'
  targetGmv: string | null
  baseQuantityCms: string
  tiers: CmsSnapshotTier[]
}
export interface CmsSalesSnapshot {
  programId: string
  status: string
  isTest: boolean
  configVersion: number
  startDate: string
  endDate: string
  catalogTargetGmv: string | null
  todayVn: string
  currentResultRunId: string | null
  previousRowsRead: number | null
  storeIds: string[]
  products: CmsSnapshotProduct[]
  sellers: CmsUserRef[]
  stores: CmsStoreRef[]
  mappingFp: string
  /** Chỉ có khi snapshot đến từ rpc_cms_sales_run_open. */
  runId: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const INT_RE = /^(0|[1-9][0-9]{0,18})$/

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
function str(o: Obj, k: string, re?: RegExp): string {
  const v = o[k]
  if (typeof v !== 'string' || (re && !re.test(v))) throw new CmsSnapshotError(k)
  return v
}
function strOrNull(o: Obj, k: string, re?: RegExp): string | null {
  const v = o[k]
  if (v === null || v === undefined) return null
  return str(o, k, re)
}
function int(o: Obj, k: string): number {
  const v = o[k]
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new CmsSnapshotError(k)
  return v
}
function arr(o: Obj, k: string): unknown[] {
  const v = o[k]
  if (!Array.isArray(v)) throw new CmsSnapshotError(k)
  return v
}

export function parseCmsSalesSnapshot(raw: unknown): CmsSalesSnapshot {
  if (!isObj(raw)) throw new CmsSnapshotError('root')
  const isTest = raw.is_test
  if (typeof isTest !== 'boolean') throw new CmsSnapshotError('is_test')
  const prevRows = raw.previous_rows_read
  if (prevRows !== null && prevRows !== undefined && (typeof prevRows !== 'number' || !Number.isSafeInteger(prevRows) || prevRows < 0)) {
    throw new CmsSnapshotError('previous_rows_read')
  }
  const products = arr(raw, 'products').map((p): CmsSnapshotProduct => {
    if (!isObj(p)) throw new CmsSnapshotError('products[]')
    const basis = str(p, 'gmv_basis')
    if (basis !== 'product' && basis !== 'catalog' && basis !== 'none') throw new CmsSnapshotError('gmv_basis')
    return {
      id: str(p, 'id', UUID_RE),
      productId: str(p, 'product_id'),
      gmvBasis: basis,
      targetGmv: strOrNull(p, 'target_gmv', INT_RE),
      baseQuantityCms: str(p, 'base_quantity_cms'),
      tiers: arr(p, 'tiers').map((t) => {
        if (!isObj(t)) throw new CmsSnapshotError('tiers[]')
        const to = t.to
        if (to !== null && (typeof to !== 'number' || !Number.isSafeInteger(to))) throw new CmsSnapshotError('tiers.to')
        return { order: int(t, 'order'), from: int(t, 'from'), to: to as number | null, amount: str(t, 'amount', INT_RE) }
      }),
    }
  })
  const sellers = arr(raw, 'sellers').map((u): CmsUserRef => {
    if (!isObj(u)) throw new CmsSnapshotError('sellers[]')
    return { id: str(u, 'id', UUID_RE), email: strOrNull(u, 'email'), role: strOrNull(u, 'role'), storeId: strOrNull(u, 'store_id', UUID_RE) }
  })
  const stores = arr(raw, 'stores').map((s): CmsStoreRef => {
    if (!isObj(s)) throw new CmsSnapshotError('stores[]')
    const active = s.is_active
    if (active !== null && typeof active !== 'boolean') throw new CmsSnapshotError('stores.is_active')
    return { id: str(s, 'id', UUID_RE), storeType: strOrNull(s, 'store_type'), isActive: active as boolean | null }
  })
  const storeIds = arr(raw, 'store_ids').map((s) => {
    if (typeof s !== 'string' || !UUID_RE.test(s)) throw new CmsSnapshotError('store_ids[]')
    return s
  })
  return {
    programId: str(raw, 'program_id', UUID_RE),
    status: str(raw, 'status'),
    isTest,
    configVersion: int(raw, 'config_version'),
    startDate: str(raw, 'start_date', DATE_RE),
    endDate: str(raw, 'end_date', DATE_RE),
    catalogTargetGmv: strOrNull(raw, 'catalog_target_gmv', INT_RE),
    todayVn: str(raw, 'today_vn', DATE_RE),
    currentResultRunId: strOrNull(raw, 'current_result_run_id', UUID_RE),
    previousRowsRead: (prevRows ?? null) as number | null,
    storeIds,
    products,
    sellers,
    stores,
    mappingFp: str(raw, 'mapping_fp', /^[0-9a-f]{32}$/),
    runId: strOrNull(raw, 'run_id', UUID_RE),
  }
}

export function cmsSnapshotToEngineInput(s: CmsSalesSnapshot): { program: CmsEngineProgramInput; sellers: CmsSellerIndex } {
  return {
    program: {
      startDate: s.startDate,
      endDate: s.endDate,
      catalogTargetGmv: s.catalogTargetGmv,
      storeIds: s.storeIds,
      products: s.products.map((p) => ({
        productId: p.productId,
        gmvBasis: p.gmvBasis,
        targetGmv: p.targetGmv,
        baseQuantityCms: p.baseQuantityCms,
        tiers: [...p.tiers].sort((a, b) => a.order - b.order).map((t) => ({ from: t.from, to: t.to, amount: t.amount })),
      })),
    },
    sellers: buildSellerIndex(s.sellers, s.stores),
  }
}

export type CmsStagePart = 'sales_lines' | 'results' | 'catalog' | 'result_lines'
export const CMS_STAGE_PARTS: readonly CmsStagePart[] = ['sales_lines', 'results', 'catalog', 'result_lines']

export type CmsStageRow = Record<string, string | number | boolean | null>

export interface CmsStageExpect {
  sales_lines: number
  results: number
  catalog: number
  result_lines: number
  chunks: Record<CmsStagePart, number>
  amount_vnd: string
  rows_read: number
  rows_rejected: number
  bytes_processed: number | null
  source_max_updated_at: string | null
  totals: Record<string, string | number | Record<string, number>>
}

export interface CmsStagePayload {
  parts: Record<CmsStagePart, CmsStageRow[]>
  expect: CmsStageExpect
}

const dec = (u: bigint) => formatCmsDecimal(u)
const ts = (m: bigint | null) => (m === null ? null : formatUtcMicros(m))

/**
 * Dựng payload stage. `lines` = TOÀN BỘ dòng hợp lệ đã đọc (cùng tập đã đưa vào engine); `out` = computeCmsProgram().
 * seq = thứ tự engine trên toàn bộ ứng viên (INCLUDED + UNASSIGNED + OUT_OF_SCOPE).
 */
export function buildCmsStagePayload(
  snapshot: CmsSalesSnapshot,
  lines: readonly CmsSalesLine[],
  out: CmsEngineOutput,
  meta: { rowsRead: number; rowsRejected: number; bytesProcessed: number | null; chunkSize?: number },
): CmsStagePayload {
  const byId = new Map(lines.map((l) => [l.orderLineId, l]))
  const ppId = new Map(snapshot.products.map((p) => [p.productId, p.id]))
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`CMS stage: thiếu ${what}`)
    return v
  }

  type Cand = { line: CmsSalesLine; disposition: 'INCLUDED' | 'UNASSIGNED' | 'OUT_OF_SCOPE'; userId: string | null; storeId: string | null; reason: string | null }
  const cands: Cand[] = []
  for (const l of out.lines) cands.push({ line: need(byId.get(l.orderLineId), 'dòng nguồn'), disposition: 'INCLUDED', userId: l.userId, storeId: l.storeId, reason: null })
  const excludedByReason: Partial<Record<CmsExcludeReason, number>> = {}
  for (const x of out.excluded) {
    excludedByReason[x.reason] = (excludedByReason[x.reason] ?? 0) + 1
    if (x.reason === 'UNASSIGNED') cands.push({ line: need(byId.get(x.orderLineId), 'dòng nguồn'), disposition: 'UNASSIGNED', userId: null, storeId: null, reason: x.unassignedReason })
    else if (x.reason === 'OUT_OF_SCOPE') cands.push({ line: need(byId.get(x.orderLineId), 'dòng nguồn'), disposition: 'OUT_OF_SCOPE', userId: x.userId, storeId: x.storeId, reason: null })
  }
  cands.sort((a, b) => compareCmsLines(a.line, b.line))
  const seqOf = new Map<string, number>()
  const salesRows: CmsStageRow[] = cands.map((c, seq) => {
    seqOf.set(c.line.orderLineId, seq)
    return {
      order_line_id: c.line.orderLineId,
      seq: String(seq),
      order_id: c.line.orderId,
      order_code: c.line.orderCode,
      product_id: c.line.productId,
      program_product_id: need(ppId.get(c.line.productId), 'program_product_id'),
      seller_email: c.line.sellerEmail,
      user_id: c.userId,
      store_id: c.storeId,
      pos_code: c.line.posCode,
      completed_at: formatUtcMicros(c.line.completedAtMicros),
      source_updated_at: formatUtcMicros(c.line.sourceUpdatedAtMicros),
      quantity_raw: c.line.quantityRaw,
      uom_raw: c.line.uomRaw,
      base_quantity: dec(c.line.baseQuantityUnits),
      gmv_amount: dec(c.line.gmvUnits),
      disposition: c.disposition,
      unassigned_reason: c.reason,
    }
  })

  const resultRows: CmsStageRow[] = out.results.map((r) => ({
    program_product_id: need(ppId.get(r.productId), 'program_product_id'),
    product_id: r.productId,
    user_id: r.userId,
    store_id: r.storeId,
    gmv_basis: r.gmvBasis,
    base_quantity: dec(r.baseQuantityUnits),
    per_unit: dec(r.perUnitUnits),
    cms_quantity: r.cmsQuantity.toString(),
    rewarded_quantity: r.rewardedQuantity.toString(),
    cap_quantity: r.capQuantity === null ? null : r.capQuantity.toString(),
    at_cap: r.atCap,
    gmv_amount: dec(r.gmvUnits),
    gate_gmv: r.gate.gateGmvUnits === null ? null : dec(r.gate.gateGmvUnits),
    target_gmv: r.gate.targetVnd === null ? null : r.gate.targetVnd.toString(),
    gate_met: r.gate.met,
    gate_met_at: ts(r.gate.metAtMicros),
    potential_amount: r.potentialAmountVnd.toString(),
    amount_vnd: r.amountVnd.toString(),
    line_count: String(r.lineCount),
  }))

  const catalogRows: CmsStageRow[] = out.catalog.map((c) => ({
    user_id: c.userId,
    store_id: c.storeId,
    catalog_gmv: dec(c.catalogGmvUnits),
    target_gmv: c.targetVnd.toString(),
    met: c.met,
    met_at: ts(c.metAtMicros),
    line_count: String(c.lineCount),
  }))

  const lineRows: CmsStageRow[] = out.lines.map((l) => ({
    order_line_id: l.orderLineId,
    seq: String(need(seqOf.get(l.orderLineId), 'seq')),
    user_id: l.userId,
    program_product_id: need(ppId.get(l.productId), 'program_product_id'),
    base_before: dec(l.baseBeforeUnits),
    base_after: dec(l.baseAfterUnits),
    qty_before: l.qtyBefore.toString(),
    qty_after: l.qtyAfter.toString(),
    amount_vnd: l.amountVnd.toString(),
    status: l.status,
  }))

  const size = Math.max(1, Math.min(meta.chunkSize ?? CMS_STAGE_CHUNK_DEFAULT, CMS_STAGE_CHUNK_MAX))
  const nChunks = (n: number) => Math.ceil(n / size)
  let maxUpdated: bigint | null = null
  for (const l of lines) if (maxUpdated === null || l.sourceUpdatedAtMicros > maxUpdated) maxUpdated = l.sourceUpdatedAtMicros
  const t = out.totals
  return {
    parts: { sales_lines: salesRows, results: resultRows, catalog: catalogRows, result_lines: lineRows },
    expect: {
      sales_lines: salesRows.length,
      results: resultRows.length,
      catalog: catalogRows.length,
      result_lines: lineRows.length,
      chunks: {
        sales_lines: nChunks(salesRows.length), results: nChunks(resultRows.length),
        catalog: nChunks(catalogRows.length), result_lines: nChunks(lineRows.length),
      },
      amount_vnd: t.amountVnd.toString(),
      rows_read: meta.rowsRead,
      rows_rejected: meta.rowsRejected,
      bytes_processed: meta.bytesProcessed,
      source_max_updated_at: ts(maxUpdated),
      totals: {
        lines_read: t.linesRead,
        candidates: t.candidates,
        included: t.included,
        unassigned: t.unassigned,
        out_of_scope: t.outOfScope,
        adjustment_lines: t.adjustmentLines,
        candidate_gmv: dec(t.candidateGmvUnits),
        unassigned_gmv: dec(t.unassignedGmvUnits),
        amount_vnd: t.amountVnd.toString(),
        unassigned_by_reason: { ...t.unassignedByReason } as Record<string, number>,
        excluded_by_reason: { ...excludedByReason } as Record<string, number>,
      },
    },
  }
}

/** Chia một part thành khối liên tục 0…n−1 (cùng kích thước với expect.chunks). */
export function chunkCmsStageRows(rows: readonly CmsStageRow[], chunkSize?: number): CmsStageRow[][] {
  const size = Math.max(1, Math.min(chunkSize ?? CMS_STAGE_CHUNK_DEFAULT, CMS_STAGE_CHUNK_MAX))
  const out: CmsStageRow[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

// Miền cột DB 122 (đơn vị scale 9): |x| < 10^k ⇔ |units| < 10^(k+9).
const lim = (k: number) => BigInt(10) ** BigInt(k) * CMS_DEC_FACTOR
const abs = (v: bigint) => (v < ZERO ? -v : v)

/** Số vượt miền cột DB ⇒ 'OVERFLOW' (held, không stage). null = trong miền. */
export function cmsStageBoundsIssue(out: CmsEngineOutput, lines: readonly CmsSalesLine[]): 'OVERFLOW' | null {
  const L29 = lim(29), L20 = lim(20), L35 = lim(35), L26 = lim(26)
  const big = (v: bigint) => v < ZERO || v > CMS_INT64_MAX
  for (const l of lines) if (abs(l.baseQuantityUnits) >= L29 || abs(l.gmvUnits) >= L20) return 'OVERFLOW'
  for (const r of out.results) {
    if (abs(r.baseQuantityUnits) >= L35 || abs(r.gmvUnits) >= L26 || (r.gate.gateGmvUnits !== null && abs(r.gate.gateGmvUnits) >= L26)) return 'OVERFLOW'
    if (big(r.cmsQuantity) || big(r.rewardedQuantity) || big(r.potentialAmountVnd) || big(r.amountVnd)) return 'OVERFLOW'
  }
  for (const c of out.catalog) if (abs(c.catalogGmvUnits) >= L26) return 'OVERFLOW'
  for (const l of out.lines) {
    if (abs(l.baseBeforeUnits) >= L35 || abs(l.baseAfterUnits) >= L35) return 'OVERFLOW'
    if (big(l.qtyBefore) || big(l.qtyAfter) || abs(l.amountVnd) > CMS_INT64_MAX) return 'OVERFLOW'
  }
  if (out.totals.amountVnd > CMS_INT64_MAX) return 'OVERFLOW'
  return null
}
