// CMS-CALC-RET-2 P5 (browser gate) — dữ liệu GIẢ cho run CONTRACT (`cms-calc-ret2-v1`) ở /ui-catalog/cms-v2 (dev-only, UI_CATALOG=1).
// Cùng nguyên tắc CMS-UI-1: KHÔNG gõ tay số kết quả. Dòng bán / phiếu trả giả (chuỗi thô như nguồn) ⇒ normalizer thật
// (normalizeSalesRow / normalizeReturnRow) ⇒ engine thật computeCmsNet ⇒ JSON đúng hình dạng reader v2 (rpc_cms_result_header_v2 /
// rows_v2 / events_v2, migration 130 — ánh xạ cột như contractStage.ts) ⇒ parser DTO thật (parseCmsResultHeader(…, 2) /
// parseCmsResultRows(…, 2) / parseCmsResultEvents). Báo cáo sau chốt: số đã chốt = run legacy của PG9 (engine P2-a), số tính lại =
// computeCmsNet pos_base + net_returns_v1 trên CÙNG dòng bán đóng băng + phiếu trả giả ⇒ parser thật. Trạng thái sổ trả (conflict /
// proof / xác nhận) là trạng thái DB — dựng JSON đúng hình dạng rpc_cms_return_conflicts rồi qua parser thật.
// Không IO, không mạng; id / tên / email đều giả (example.invalid). Không dùng ở route thật.
//
// Chương trình (hôm nay của fixture = 15/11/2026, phạm vi nhà thuốc 01 + 02; dược sĩ A, B ở 01, D ở 02):
//  PG13 Tính nguyên + trừ trả hàng (cms_unit · net_returns_v1) — dòng khác đơn vị / số lẻ = "Không tính lượng"; 3 phiếu trả hoàn tất:
//       vitamin K100 trả 5 viên của dòng 2 hộp (Q-232: 195 viên ⇒ 1 hộp), siro trả 1 chai (giảm CMS), men vi sinh trả dòng gói
//       (CMS không đổi).
//  PG14 Tính nguyên, chưa trừ trả (cms_unit · sales_only_v1) — cùng dòng bán, không phiếu trả.
//  PG15 Cộng dồn + trừ trả hàng (pos_base · net_returns_v1) — cùng dòng bán + phiếu trả.
//  PG16 Cộng dồn, chưa trừ trả (pos_base · sales_only_v1) — cùng dòng bán, không phiếu trả: chương trình MỚI do admin chọn "Tính lẻ"
//       ở bản phát hành CMS bán hàng. Metadata CHƯƠNG TRÌNH = admin chọn pos_base, nhưng RUN là LEGACY như DB thật (PM audit RC r2
//       SALES-RC-02): mig 130 mở run contract chỉ khi `quantity_basis <> 'pos_base' OR returns_policy <> 'sales_only_v1'` (cms__open
//       run, v_ct) và CHECK cms_sync_runs_contract_shape đòi `cms_unit OR net_returns_v1`; contractSync.cmsIsContractSnapshot cùng luật.
//       ⇒ kết quả / dòng / XLSX của PG16 = engine legacy (computeCmsProgram, như T11) trên CÙNG dòng bán ⇒ DTO legacy (contract legacy,
//       không cột ròng); `out` (computeCmsNet pos_base + sales_only) chỉ giữ để đối chứng tiền / Q với đường legacy, KHÔNG dựng DTO.
// Khối `contract` của run contract khớp cms__run_contract + CHECK 130: unit_key_version / status_dictionary_version LUÔN có (kể cả
// sales-only / pos_base net); returns_as_of chỉ run net.
import { buildSellerIndex } from './mapping'
import { computeCmsProgram, type CmsEngineOutput } from './engine/compute'
import type { CmsEngineProgramInput } from './engine/config'
import { normalizeSalesRow, type CmsRawRow, type CmsSalesLine } from './source/contract'
import { CMS_RETURN_STATUS_DICTIONARY_VERSION, normalizeReturnRow, type CmsReturnRecord } from './calc/returns'
import { cmsCalcSaleLine, computeCmsNet, type CmsCalcOutput, type CmsCalcSaleLine } from './calc/net'
import { CMS_CALC_CONTRACT_VERSION, CMS_QUANTITY_POLICY_VERSION, type CmsQuantityBasis, type CmsReturnsPolicy } from './calc/policy'
import type { CmsProgramBasis } from './calc/basisUi'
import { CMS_UNIT_KEY_VERSION } from './unitKey'
import { formatCmsDecimal, parseCmsDecimal } from './decimal'
import { formatUtcMicros, parseUtcMicros } from './time'
import {
  parseCmsResultEvents, parseCmsResultHeader, parseCmsResultRows,
  type CmsResultHeaderDto, type CmsResultLineDto, type CmsResultRowDto, type CmsResultRowsDto,
} from './resultView'
import {
  parseCmsCloseReportPage, parseCmsCloseReports,
  parseCmsReturnConflicts, type CmsCloseReportPage, type CmsCloseReportSummary, type CmsReturnConflictsDto,
} from './returnsView'
import {
  CMS_FX_PG, CMS_FX_SELLERS, CMS_FX_SM_STORES, CMS_FX_STORES, CMS_FX_TODAY, CMS_FX_USERS, cmsFxDay, cmsFxHeader, cmsFxLinesOf, cmsFxProgram,
  cmsFxRowView, cmsFxRows, cmsFxSellerEmail, cmsFxUid, cmsFxUserName, cmsFxUserStore, type CmsFxProgram, type CmsFxViewer,
} from './fixtureScenario'
import type { CmsResultsLoad } from './resultUi'
import type { CmsAdminListItem, CmsProductView, CmsProgramRowView, CmsTierView } from './server/catalog'

const ZERO = BigInt(0)
const units = (v: string) => { const r = parseCmsDecimal(v); if (!r.ok) throw new Error(`fx decimal ${v}`); return r.units }
const fmt = formatCmsDecimal
const ts = (m: bigint | null) => (m === null ? null : formatUtcMicros(m))
/** Giờ VN (UTC+7) ⇒ chuỗi µs UTC như nguồn. */
const vnAt = (date: string, h: number, m: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCMinutes(h * 60 + m - 7 * 60)
  return d.toISOString().replace(/\.\d{3}Z$/, '.000000Z')
}

// ── Định nghĩa ──────────────────────────────────────────────────────────────
interface CProduct { productId: string; name: string; gmvBasis: 'product' | 'catalog' | 'none'; targetGmv: string | null; unit: string; k: string; tiers: CmsTierView[]; price: string; pricePerBase: number }
const FLAT = (amount: number): CmsTierView[] => [{ order: 1, from: 1, to: null, amount: String(amount) }]
const PRODUCTS: CProduct[] = [
  { productId: '900201', name: 'Viên uống vitamin tổng hợp hộp 100 viên', gmvBasis: 'none', targetGmv: null, unit: 'hộp', k: '100', tiers: FLAT(20000), price: '320000', pricePerBase: 3200 },
  { productId: '900202', name: 'Siro ho thảo dược chai 100ml', gmvBasis: 'product', targetGmv: '300000', unit: 'chai', k: '1',
    tiers: [{ order: 1, from: 1, to: 3, amount: '8000' }, { order: 2, from: 4, to: null, amount: '10000' }], price: '85000', pricePerBase: 85000 },
  { productId: '900203', name: 'Men vi sinh hộp 20 gói', gmvBasis: 'none', targetGmv: null, unit: 'hộp', k: '20', tiers: FLAT(31500), price: '185000', pricePerBase: 9250 },
]
type UKey = 'A' | 'B' | 'D'
/** [mã dòng, dược sĩ, SP, số lượng thô, đơn vị thô, lượng cơ sở, ngày trong kỳ, giờ VN]. */
type SaleDef = [string, UKey, number, string, string, string, number, number]
const SALES: SaleDef[] = [
  ['01', 'A', 0, '2', 'hộp', '200', 1, 9], ['02', 'A', 0, '5', 'viên', '5', 2, 10], ['03', 'A', 0, '1.5', 'Hộp', '150', 4, 15],
  ['04', 'A', 1, '3', 'chai', '3', 1, 11], ['05', 'A', 1, '2', 'Chai', '2', 5, 16], ['06', 'A', 2, '1', 'hộp', '20', 3, 9],
  ['07', 'B', 0, '3', 'hộp', '300', 2, 14], ['08', 'B', 2, '10', 'gói', '10', 4, 10], ['09', 'B', 2, '2', 'hộp', '40', 6, 17],
  ['10', 'B', 1, '4', 'chai', '4', 7, 9],
  ['11', 'D', 0, '1', 'hộp', '100', 3, 13], ['12', 'D', 1, '1', 'chai', '1', 4, 10], ['13', 'D', 2, '3', 'hộp', '60', 5, 11],
]
/** [mã phiếu, dòng bán gốc, lượng cơ sở trả, tiền hoàn, ngày ghi nhận trong kỳ, giờ VN]. */
type ReturnDef = [string, string, string, string, number, number]
const RETURNS: ReturnDef[] = [['01', '01', '5', '16000', 8, 10], ['02', '04', '1', '85000', 9, 15], ['03', '08', '10', '92500', 10, 11]]

/** `run` = loại run DB SINH RA cho cấu hình chương trình (mig 130: chỉ pos_base + sales_only_v1 là legacy) — không phải lựa chọn tự do. */
interface CDef { n: number; name: string; basis: CmsQuantityBasis; policy: CmsReturnsPolicy; withReturns: boolean; run: 'contract' | 'legacy' }
/** Luật DB (cms__open run v_ct + CHECK contract_shape): run contract ⇔ cms_unit HOẶC net_returns_v1. */
export const cmsFxRunIsContract = (basis: CmsQuantityBasis, policy: CmsReturnsPolicy): boolean => basis !== 'pos_base' || policy !== 'sales_only_v1'
const DEFS: CDef[] = [
  { n: 13, name: 'CMS mẫu tính nguyên + trừ trả hàng — vitamin, siro, men vi sinh', basis: 'cms_unit', policy: 'net_returns_v1', withReturns: true, run: 'contract' },
  { n: 14, name: 'CMS mẫu tính nguyên, chưa trừ trả hàng', basis: 'cms_unit', policy: 'sales_only_v1', withReturns: false, run: 'contract' },
  { n: 15, name: 'CMS mẫu cộng dồn + trừ trả hàng', basis: 'pos_base', policy: 'net_returns_v1', withReturns: true, run: 'contract' },
  { n: 16, name: 'CMS mẫu cộng dồn, chưa trừ trả hàng', basis: 'pos_base', policy: 'sales_only_v1', withReturns: false, run: 'legacy' },
]
for (const d of DEFS) if ((d.run === 'contract') !== cmsFxRunIsContract(d.basis, d.policy)) throw new Error(`fx PG${d.n}: loại run trái luật DB`)
const START = cmsFxDay(-14)
const END = cmsFxDay(15)
const STORES = [CMS_FX_STORES.S1, CMS_FX_STORES.S2]
const AS_OF = '2026-11-15T00:30:00.000000Z'
const PUBLISHED = '2026-11-15T01:05:00.000000Z'
const STARTED = '2026-11-15T01:00:00.000000Z'
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const hex = (seed: string) => Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(seed.charCodeAt(i % seed.length) * 7 + i * 13) % 16]).join('')

function rawSale(n: number, s: SaleDef): CmsRawRow {
  const [code, u, pi, q, uom, b, day, h] = s
  const p = PRODUCTS[pi]
  const id = String(n * 100_000 + Number(code))
  const at = vnAt(addDays(START, day), h, Number(code) * 3)
  const store = cmsFxUserStore(CMS_FX_USERS[u])!
  return {
    order_line_id: id, order_id: `HD${id}`, order_code: `HD${id}`, product_id: p.productId, seller_email: cmsFxSellerEmail(u),
    pos_code: `POS-${store.slice(-2)}`, order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: at, quantity_raw: q, uom_raw: uom,
    base_quantity: b, gmv_amount: fmt(units(b) * BigInt(p.pricePerBase)), source_updated_at: at,
  }
}
function rawReturn(n: number, r: ReturnDef, sale: CmsRawRow): CmsRawRow {
  const [code, , rb, rh, day, h] = r
  const id = `${n}-RT${code}`
  return {
    return_event_id: id, return_document_id: `PT${n}${code}`, return_code: `PT${n}${code}`, return_status: 'COMPLETED',
    return_recorded_at: vnAt(addDays(START, day), h, 5), original_order_line_id: sale.order_line_id, original_order_id: sale.order_id,
    product_id: sale.product_id, return_base_quantity: rb, return_gmv_amount: rh,
    original_completed_at: sale.completed_at, original_order_type: sale.order_type, original_order_status: sale.order_status,
    original_seller_email: sale.seller_email, original_pos_code: sale.pos_code, original_base_quantity: sale.base_quantity,
    original_gmv_amount: sale.gmv_amount, original_quantity_raw: sale.quantity_raw, original_uom_raw: sale.uom_raw, source_updated_at: null,
  }
}

export interface CmsFxContractProgram {
  /** Run legacy: `fx.out` = engine legacy (DTO / dòng / XLSX dựng từ đây, như T11). Run contract: `fx.out` null. */
  fx: CmsFxProgram
  /** Cấu hình CHƯƠNG TRÌNH (admin chọn) — badge A3; KHÔNG phải hợp đồng của run khi `runKind = 'legacy'`. */
  basis: CmsQuantityBasis
  policy: CmsReturnsPolicy
  runKind: 'contract' | 'legacy'
  /** computeCmsNet trên cùng dữ liệu — run contract: nguồn DTO; run legacy: chỉ đối chứng tiền / Q với `fx.out`. */
  out: Extract<CmsCalcOutput, { ok: true }>
  sales: CmsCalcSaleLine[]
  returns: CmsReturnRecord[]
  rawReturns: CmsRawRow[]
}

function buildContract(d: CDef): CmsFxContractProgram {
  const rawSales = SALES.map((s) => rawSale(d.n, s))
  const sales = rawSales.map((raw) => {
    const r = normalizeSalesRow(raw)
    if (!r.ok) throw new Error(`fx contract sale ${raw.order_line_id}: ${JSON.stringify(r.issues)}`)
    return cmsCalcSaleLine(raw, r.value)
  })
  const rawReturns = d.withReturns ? RETURNS.map((r) => rawReturn(d.n, r, rawSales.find((x) => x.order_line_id === String(d.n * 100_000 + Number(r[1])))!)) : []
  const returns = rawReturns.map((raw) => {
    const r = normalizeReturnRow(raw)
    if (!r.ok) throw new Error(`fx contract return ${raw.return_event_id}`)
    return r.value
  })
  const products: CmsProductView[] = PRODUCTS.map((p, i) => ({
    id: cmsFxUid(d.n * 100 + 5000 + i + 1), programId: cmsFxUid(d.n), productId: p.productId, gmvBasis: p.gmvBasis, targetGmv: p.targetGmv,
    unitCms: p.unit, baseQuantityCms: p.k, adviceText: 'Hỏi nhu cầu, đối tượng dùng và liều theo hướng dẫn trên nhãn.', nameSnapshot: p.name,
    imageUrlSnapshot: null, priceSnapshot: p.price, addedAfterStart: false, tiers: p.tiers,
  }))
  const out = computeCmsNet({
    program: {
      startDate: START, endDate: END, catalogTargetGmv: null, storeIds: STORES, quantityBasis: d.basis, returnsPolicy: d.policy,
      products: PRODUCTS.map((p) => ({ productId: p.productId, gmvBasis: p.gmvBasis, targetGmv: p.targetGmv, baseQuantityCms: p.k, unitCms: p.unit,
        tiers: p.tiers.map((t) => ({ from: t.from, to: t.to, amount: t.amount })) })),
    },
    sales, returns, sellers: CMS_FX_SELLERS, asOfMicros: parseUtcMicros(AS_OF)!,
  })
  if (!out.ok) throw new Error(`fx contract PG${d.n} HOLD ${out.holds.map((h) => h.code).join(',')}`)
  const row: CmsAdminListItem = {
    id: cmsFxUid(d.n), name: d.name, status: 'active', startDate: START, endDate: END, scope: 'stores', isTest: false, catalogTargetGmv: null,
    configVersion: 2, activatedAt: '2026-10-31T02:00:00Z', createdAt: '2026-10-28T02:00:00Z', productCount: products.length,
    productIds: products.map((p) => p.productId), lastImport: null,
  }
  // Run legacy (PG16): engine legacy thật (computeCmsProgram — cùng engine run T11) trên CÙNG dòng bán đã chuẩn hoá ⇒ DTO legacy.
  let legacyOut: CmsEngineOutput | null = null
  if (d.run === 'legacy') {
    const input: CmsEngineProgramInput = {
      startDate: START, endDate: END, catalogTargetGmv: null, storeIds: STORES,
      products: PRODUCTS.map((p) => ({ productId: p.productId, gmvBasis: p.gmvBasis, targetGmv: p.targetGmv, baseQuantityCms: p.k, tiers: p.tiers.map((t) => ({ from: t.from, to: t.to, amount: t.amount })) })),
    }
    legacyOut = computeCmsProgram({ program: input, lines: sales as CmsSalesLine[], sellers: CMS_FX_SELLERS })
  }
  const fx: CmsFxProgram = {
    row, products, storeIds: STORES, runs: [], out: legacyOut, lines: sales as CmsSalesLine[], pp: new Map(products.map((p) => [p.productId, p.id])),
    run: { id: cmsFxUid(9500 + (d.n - 1) * 10), publishedAt: PUBLISHED, configVersion: 2 },
  }
  return { fx, basis: d.basis, policy: d.policy, runKind: d.run, out, sales, returns, rawReturns }
}

export const CMS_FX_CONTRACT_PROGRAMS: readonly CmsFxContractProgram[] = DEFS.map(buildContract)
export const CMS_FX_PG_CONTRACT = Object.fromEntries(CMS_FX_CONTRACT_PROGRAMS.map((p, i) => [`PG${DEFS[i].n}`, p.fx.row.id])) as Record<'PG13' | 'PG14' | 'PG15' | 'PG16', string>
export const cmsFxContract = (id: string | null | undefined): CmsFxContractProgram | null => CMS_FX_CONTRACT_PROGRAMS.find((p) => p.fx.row.id === id) ?? null
export const cmsFxContractOfProduct = (ppId: string | null | undefined): CmsFxContractProgram | null =>
  CMS_FX_CONTRACT_PROGRAMS.find((p) => p.fx.products.some((x) => x.id === ppId)) ?? null
/** Danh sách D1 / D3 (fx=contract): bốn chương trình mới (PG13–15 run contract, PG16 run legacy do admin chọn Tính lẻ) đang chạy. */
export const CMS_FX_STAFF_CONTRACT: CmsProgramRowView[] = CMS_FX_CONTRACT_PROGRAMS.map((p) => cmsFxRowView(p.fx.row))
/** Badge cách tính / chính sách trả (A3) — chương trình mới do admin chọn. */
export function cmsFxContractBasis(id: string): CmsProgramBasis | null {
  const c = cmsFxContract(id)
  return c ? { basis: c.basis, source: 'admin', returnsPolicy: c.policy } : null
}

// ── Kết quả theo người xem (giả lập phạm vi reader v2) ──────────────────────
function visible(v: CmsFxViewer, userId: string): boolean {
  if (v.kind === 'super') return true
  if (v.kind === 'staff') return v.userId === userId
  const s = cmsFxUserStore(userId)
  return v.kind === 'sm' ? s !== null && CMS_FX_SM_STORES.includes(s) : s === v.storeId
}
/** Đúng hình dạng cms__run_contract (130) của run contract: mọi run contract ghi đủ 3 version (CHECK contract_shape). */
const contractJson = (c: CmsFxContractProgram) => {
  if (c.runKind !== 'contract') throw new Error('fx contractJson: run legacy không có khối hợp đồng contract')
  return {
    legacy: false, calc_contract_version: CMS_CALC_CONTRACT_VERSION, quantity_basis: c.basis, quantity_policy_version: CMS_QUANTITY_POLICY_VERSION[c.basis],
    returns_policy: c.policy, unit_key_version: CMS_UNIT_KEY_VERSION, status_dictionary_version: CMS_RETURN_STATUS_DICTIONARY_VERSION,
    returns_as_of: c.policy === 'net_returns_v1' ? AS_OF : null,
  }
}
export type CmsFxContractScenario = 'running' | 'top' | 'held' | 'none' | 'error' | 'gone' | 'config' | 'reset'

function header(c: CmsFxContractProgram, v: CmsFxViewer, o: { held?: boolean; configChanged?: boolean; reset?: boolean }): CmsResultHeaderDto {
  const su = v.kind === 'super'
  const net = c.policy === 'net_returns_v1'
  const t = c.out.totals
  const run = o.reset ? null : c.fx.run!
  return parseCmsResultHeader({
    program_id: c.fx.row.id, config_version: o.configChanged ? c.fx.row.configVersion + 1 : c.fx.row.configVersion,
    viewer: v.kind === 'store_manager' ? 'store_manager' : v.kind,
    run: run ? {
      id: run.id, config_version: run.configVersion, published_at: run.publishedAt, source_max_updated_at: STARTED, started_at: STARTED,
      amount_vnd: su ? t.amountVnd.toString() : null, rows_read: su ? t.linesRead : null,
      totals: su ? { lines_read: t.linesRead, candidates: t.candidates, included: t.included, unassigned: t.unassigned, out_of_scope: t.outOfScope,
        candidate_gmv: fmt(t.candidateGmvUnits), unassigned_gmv: fmt(t.unassignedGmvUnits), amount_vnd: t.amountVnd.toString(),
        returns_read: t.returnsRead, returns_applied: t.returnsApplied, return_base_applied: fmt(t.returnBaseAppliedUnits),
        return_gmv_applied: fmt(t.returnGmvAppliedUnits), class_counts: { ...t.classCounts } } : null,
      contract: contractJson(c),
      returns_rows_read: su && net ? t.returnsRead : null,
      // Đúng hình dạng DB 130 (FINAL-QA7-01): `cms__publish_contract` ghi verdict CLEAN + set_hash cho MỌI run contract của super; chỉ run
      // net có lần kiểm sổ ⇒ sales-only `eval_seq: null` tường minh. Vai khác không nhận khối riêng của super (header v2 chỉ trả cho super).
      ledger: su ? { verdict: 'CLEAN', eval_seq: net ? 3 : null, set_hash: hex(`ledger-${c.fx.row.id}`) } : null,
    } : null,
    last_attempt: o.reset
      ? { status: 'ok', started_at: STARTED, finished_at: PUBLISHED, is_current: false, error_code: null }
      : o.held
        ? { status: 'held', started_at: '2026-11-15T03:00:00.000000Z', finished_at: '2026-11-15T03:01:10.000000Z', is_current: false, error_code: net ? 'CMS_RETURN_LEDGER_CONFLICT' : 'SOURCE_TIMEOUT' }
        : { status: 'ok', started_at: STARTED, finished_at: PUBLISHED, is_current: true, error_code: null },
    recent_runs: null,
  }, 2)
}

function rows(c: CmsFxContractProgram, v: CmsFxViewer): CmsResultRowsDto {
  const results = c.out.results.filter((r) => visible(v, r.userId))
  const catalog = c.out.catalog.filter((k) => visible(v, k.userId))
  const userIds = [...new Set(results.map((r) => r.userId))].sort()
  return parseCmsResultRows({
    run_id: c.fx.run!.id,
    contract: contractJson(c),
    results: results.map((r) => ({
      user_id: r.userId, store_id: r.storeId, program_product_id: c.fx.pp.get(r.productId), product_id: r.productId, gmv_basis: r.gmvBasis,
      base_quantity: fmt(r.netBaseUnits), per_unit: fmt(r.perUnitUnits), cms_quantity: r.cmsQuantity.toString(), rewarded_quantity: r.cmsQuantity.toString(),
      cap_quantity: null, at_cap: false, gmv_amount: fmt(r.netGmvUnits),
      gate_gmv: r.gate.gateGmvUnits === null ? null : fmt(r.gate.gateGmvUnits), target_gmv: r.gate.targetVnd === null ? null : r.gate.targetVnd.toString(),
      gate_met: r.gate.met, gate_met_at: ts(r.gate.metAtMicros), potential_amount: r.potentialAmountVnd.toString(), amount_vnd: r.amountVnd.toString(),
      line_count: r.saleLines,
      net: {
        sale_base: fmt(r.saleBaseUnits), return_base: fmt(r.returnBaseUnits), eligible_sale_base: fmt(r.eligibleSaleBaseUnits),
        eligible_return_base: fmt(r.eligibleReturnBaseUnits), eligible_base: fmt(r.eligibleNetBaseUnits),
        counted_sale_qty: r.countedSaleQty === null ? null : r.countedSaleQty.toString(), sale_gmv: fmt(r.saleGmvUnits), return_gmv: fmt(r.returnGmvUnits),
        return_count: r.returnEvents,
      },
    })),
    catalog: catalog.map((k) => ({ user_id: k.userId, store_id: k.storeId, catalog_gmv: fmt(k.catalogNetGmvUnits), target_gmv: k.targetVnd.toString(), met: k.met, met_at: ts(k.metAtMicros), line_count: k.events })),
    users: userIds.map((id) => ({ id, full_name: cmsFxUserName(id) ?? 'Dược sĩ mẫu', store_id: cmsFxUserStore(id) })),
  }, 2)
}

/** Kết quả run contract theo người xem + kịch bản; null ⇒ không phải chương trình run contract (caller dùng fixture legacy). */
export function cmsFxContractResultsOf(programId: string, s: CmsFxContractScenario, v: CmsFxViewer): CmsResultsLoad | null {
  const c = cmsFxContract(programId)
  if (!c) return null
  if (c.fx.row.startDate > CMS_FX_TODAY) return { kind: 'upcoming' }
  if (s === 'error' || s === 'gone') return { kind: s }
  const empty: CmsResultRowsDto = { runId: null, results: [], catalog: [], users: [], contract: null }
  // Run legacy (PG16): như đường legacy của fixturesResults (DTO 122 / reader v2 nhánh legacy — contract legacy, không cột ròng).
  if (c.runKind === 'legacy') {
    if (s === 'none') return { kind: 'loaded', header: cmsFxHeader({ ...c.fx, run: null, out: null }, v), rows: empty }
    if (s === 'reset') return { kind: 'loaded', header: cmsFxHeader(c.fx, v, { reset: true }), rows: empty }
    return { kind: 'loaded', header: cmsFxHeader(c.fx, v, { held: s === 'held', configChanged: s === 'config' }), rows: cmsFxRows(c.fx, v) }
  }
  if (s === 'none') return { kind: 'loaded', header: { ...header(c, v, {}), run: null, lastAttempt: null }, rows: empty }
  if (s === 'reset') return { kind: 'loaded', header: header(c, v, { reset: true }), rows: empty }
  return { kind: 'loaded', header: header(c, v, { held: s === 'held', configChanged: s === 'config' }), rows: rows(c, v) }
}

/**
 * Sự kiện D3 / D2 (SALE + RETURN) của các cặp dược sĩ × SP có trong `rows` — seq = thứ tự engine toàn cục (như cms_result_events),
 * dòng RETURN không có POS / số lượng / đơn vị gốc (như events_v2). null ⇒ không phải run contract.
 */
export function cmsFxContractLines(rs: readonly CmsResultRowDto[]): CmsResultLineDto[] | null {
  if (rs.length === 0) return null
  const c = cmsFxContractOfProduct(rs[0].programProductId)
  if (!c) return null
  const pairs = new Set(rs.map((r) => `${r.userId}|${r.programProductId}`))
  if (c.runKind === 'legacy') return cmsFxLinesOf(c.fx, pairs)
  const src = new Map(c.sales.map((l) => [l.orderLineId, l]))
  const evRows = c.out.history
    .map((h, seq) => ({ h, seq }))
    .filter(({ h }) => pairs.has(`${h.userId}|${c.fx.pp.get(h.productId)}`))
    .map(({ h, seq }) => ({
      seq, kind: h.kind, event_key: h.key, event_at: formatUtcMicros(h.atMicros), order_line_id: h.orderLineId, order_code: h.orderCode,
      product_id: h.productId, program_product_id: c.fx.pp.get(h.productId), user_id: h.userId, store_id: h.storeId,
      pos_code: h.kind === 'SALE' ? h.posCode : null,
      quantity_raw: h.kind === 'SALE' ? src.get(h.orderLineId)?.quantityRaw ?? null : null,
      uom_raw: h.kind === 'SALE' ? src.get(h.orderLineId)?.uomRaw ?? null : null,
      quantity_class: h.quantityClass, return_event_id: h.returnEventId, return_code: h.returnCode,
      base_delta: fmt(h.baseDeltaUnits), eligible_delta: fmt(h.eligibleDeltaUnits), gmv_delta: fmt(h.gmvDeltaUnits),
      eligible_before: fmt(h.eligibleBeforeUnits), eligible_after: fmt(h.eligibleAfterUnits), qty_before: h.qtyBefore.toString(),
      qty_after: h.qtyAfter.toString(), amount_vnd: h.amountVnd.toString(), status: h.status,
    }))
  return parseCmsResultEvents({ run_id: c.fx.run!.id, contract: contractJson(c), rows: evRows, next_after_seq: null }).rows
}

// ── Trang "Trả hàng" (super) ────────────────────────────────────────────────
export type CmsFxReturnsScenario = 'clean' | 'conflict' | 'proof' | 'restored' | 'error'
export const CMS_FX_RETURNS_SCENARIOS: CmsFxReturnsScenario[] = ['clean', 'conflict', 'proof', 'restored', 'error']
export const cmsFxParseReturnsScenario = (v: string | undefined): CmsFxReturnsScenario =>
  (CMS_FX_RETURNS_SCENARIOS as string[]).includes(v ?? '') ? (v as CmsFxReturnsScenario) : 'clean'

/** Trạng thái sổ trả của chương trình net (DB) ⇒ parser thật. Baseline = các phiếu đã áp ở run hiện hành (dữ liệu giả ở trên). */
export function cmsFxReturnConflicts(programId: string, s: CmsFxReturnsScenario): CmsReturnConflictsDto | null {
  const c = cmsFxContract(programId) ?? null
  if (!c || c.policy !== 'net_returns_v1' || s === 'error') return null
  const target = c.rawReturns[1]
  const hasOpen = s === 'conflict' || s === 'proof'
  const openHash = hex(hasOpen ? `open-${target.return_event_id}` : 'open-empty')
  const evalSeq = s === 'clean' ? 3 : s === 'conflict' ? 4 : s === 'proof' ? 5 : 6
  const verdict = s === 'conflict' ? 'MISMATCH' : s === 'proof' ? 'OPEN_CONFLICT_MATCH' : 'CLEAN'
  const observed = { return_document_id: target.return_document_id, original_order_line_id: target.original_order_line_id, product_id: target.product_id,
    base_quantity: target.return_base_quantity, refund_amount: target.return_gmv_amount }
  return parseCmsReturnConflicts({
    program_id: c.fx.row.id, returns_policy: c.policy, config_version: c.fx.row.configVersion, baselines: c.rawReturns.length,
    open_set_hash: openHash, open_count: hasOpen ? 1 : 0, open_truncated: false,
    latest_eval: { eval_seq: evalSeq, kind: 'run', verdict, returns_as_of: AS_OF, evaluated_at: '2026-11-15T01:04:00.000000Z', mismatched: s === 'conflict' ? 1 : 0, open_conflicts: hasOpen ? 1 : 0 },
    proof: s === 'proof' ? { eval_seq: 5, open_set_hash: openHash } : null,
    open: hasOpen ? [{
      conflict_id: 41, return_event_id: target.return_event_id, opened_kind: 'MISSING', opened_eval_seq: 4, opened_at: '2026-11-14T01:04:00.000000Z',
      baseline: { ...observed, recorded_at: target.return_recorded_at },
      observations: [
        { version: 1, eval_seq: 4, verdict: 'MISSING', observed: null, observed_at: '2026-11-14T01:04:00.000000Z' },
        ...(s === 'proof' ? [{ version: 2, eval_seq: 5, verdict: 'MATCH', observed, observed_at: '2026-11-15T01:04:00.000000Z' }] : []),
      ],
    }] : [],
    restorations: s === 'restored' ? [{ id: cmsFxUid(9901), proof_eval_seq: 5, conflicts: 1, reason: 'BI xác nhận phiếu PT siro đã khôi phục đúng nội dung trên view nguồn (dữ liệu minh hoạ).', confirmed_at: '2026-11-15T02:00:00.000000Z' }] : [],
  })
}

// ── Báo cáo sau chốt (PG9 — QA đã chốt, run đóng băng legacy) ───────────────
const REPORT_AS_OF = '2026-11-14T20:00:00.000000Z'
const REPORT_ID = cmsFxUid(9951)
export const CMS_FX_REPORT_PROGRAM = CMS_FX_PG.PG9
export const CMS_FX_REPORT_ID = REPORT_ID

interface ReportBuild { summary: CmsCloseReportSummary; page: CmsCloseReportPage }
let reportCache: ReportBuild | null = null

function buildReport(): ReportBuild {
  if (reportCache) return reportCache
  const p = cmsFxProgram(CMS_FX_REPORT_PROGRAM)
  if (!p || !p.out || !p.run) throw new Error('fx report PG9')
  const frozen = p.out
  const sales: CmsCalcSaleLine[] = p.lines.map((l) => ({ ...l, raw: { quantityRaw: l.quantityRaw, uomRaw: l.uomRaw } }))
  const included = new Set(frozen.lines.map((l) => l.orderLineId))
  // Ba phiếu trả hoàn tất SAU kỳ (sau chốt): 1 đơn vị CMS của dòng bán đã tính đầu tiên ở mỗi SP 900001 / 900002 / 900003.
  const picks: CmsSalesLine[] = []
  for (const pid of ['900001', '900002', '900003']) {
    const l = p.lines.find((x) => x.productId === pid && included.has(x.orderLineId) && !picks.includes(x))
    if (l) picks.push(l)
  }
  const prodBy = new Map(p.products.map((x) => [x.productId, x]))
  const returns = picks.map((l, i) => {
    const k = units(prodBy.get(l.productId)!.baseQuantityCms)
    const rb = k <= l.baseQuantityUnits ? k : l.baseQuantityUnits
    const rh = (l.gmvUnits * rb) / l.baseQuantityUnits
    const raw: CmsRawRow = {
      return_event_id: `9-RT${i + 1}`, return_document_id: `PT9${i + 1}`, return_code: `PT9${i + 1}`, return_status: 'COMPLETED',
      return_recorded_at: vnAt('2026-11-05', 9 + i, 10), original_order_line_id: l.orderLineId, original_order_id: l.orderId, product_id: l.productId,
      return_base_quantity: fmt(rb), return_gmv_amount: fmt(rh), original_completed_at: formatUtcMicros(l.completedAtMicros),
      original_order_type: l.orderType, original_order_status: l.orderStatus, original_seller_email: l.sellerEmail, original_pos_code: l.posCode,
      original_base_quantity: fmt(l.baseQuantityUnits), original_gmv_amount: fmt(l.gmvUnits), original_quantity_raw: l.quantityRaw,
      original_uom_raw: l.uomRaw, source_updated_at: null,
    }
    const r = normalizeReturnRow(raw)
    if (!r.ok) throw new Error(`fx report return ${i}`)
    return r.value
  })
  const row = p.row
  const net = computeCmsNet({
    program: {
      startDate: row.startDate, endDate: row.endDate, catalogTargetGmv: row.catalogTargetGmv, storeIds: p.storeIds, quantityBasis: 'pos_base',
      returnsPolicy: 'net_returns_v1',
      products: p.products.map((x) => ({ productId: x.productId, gmvBasis: x.gmvBasis, targetGmv: x.targetGmv, baseQuantityCms: x.baseQuantityCms,
        unitCms: x.unitCms, tiers: x.tiers.map((t) => ({ from: t.from, to: t.to, amount: t.amount })) })),
    },
    sales, returns, sellers: CMS_FX_SELLERS, asOfMicros: parseUtcMicros(REPORT_AS_OF)!,
  })
  if (!net.ok) throw new Error(`fx report HOLD ${net.holds.map((h) => h.code).join(',')}`)
  const netBy = new Map(net.results.map((r) => [`${r.userId}|${r.productId}`, r]))
  const sorted = [...frozen.results].sort((a, b) => (`${a.userId}|${a.productId}` < `${b.userId}|${b.productId}` ? -1 : 1))
  const lines = sorted.map((f, i) => {
    const g = netBy.get(`${f.userId}|${f.productId}`)
    if (!g) throw new Error('fx report pair')
    return {
      line_no: i + 1, user_id: f.userId, full_name: cmsFxUserName(f.userId), program_product_id: p.pp.get(f.productId), product_id: f.productId,
      gmv_basis: f.gmvBasis, per_unit: fmt(f.perUnitUnits), frozen_base: fmt(f.baseQuantityUnits), frozen_qty: f.cmsQuantity.toString(),
      frozen_gmv: fmt(f.gmvUnits), frozen_gate_met: f.gate.met, frozen_amount: f.amountVnd.toString(), return_base: fmt(g.returnBaseUnits),
      return_gmv: fmt(g.returnGmvUnits), return_events: g.returnEvents, eligible_base: fmt(g.eligibleNetBaseUnits), net_gmv: fmt(g.netGmvUnits),
      gate_met: g.gate.met, recomputed_qty: g.cmsQuantity.toString(), recomputed_amount: g.amountVnd.toString(), delta: (g.amountVnd - f.amountVnd).toString(),
    }
  })
  const frozenAmount = sorted.reduce((a, f) => a + f.amountVnd, ZERO)
  const recomputed = lines.reduce((a, l) => a + BigInt(l.recomputed_amount), ZERO)
  const report = {
    id: REPORT_ID, program_id: row.id, payout_run_id: p.run.id, eval_seq: 2, returns_as_of: REPORT_AS_OF, returns_digest: hex('report-digest-pg9'),
    frozen_amount: frozenAmount.toString(), recomputed_amount: recomputed.toString(), delta_amount: (recomputed - frozenAmount).toString(),
    return_events: net.totals.returnsApplied, line_count: lines.length, created_via: 'job', created_at: '2026-11-14T20:31:00.000000Z', not_a_payment_order: true,
  }
  const page = parseCmsCloseReportPage({ report, lines, next_after: null })
  const summary = parseCmsCloseReports({ program_id: row.id, reports: [report] }).reports[0]
  reportCache = { summary, page }
  return reportCache
}

/** Danh sách báo cáo sau chốt (chỉ PG9); chương trình khác ⇒ null (khối không hiện như route thật khi chưa chốt). */
export function cmsFxCloseReports(programId: string): CmsCloseReportSummary[] | null {
  return programId === CMS_FX_REPORT_PROGRAM ? [buildReport().summary] : null
}
export function cmsFxCloseReport(programId: string, reportId: string): CmsCloseReportPage | null {
  return programId === CMS_FX_REPORT_PROGRAM && reportId === REPORT_ID ? buildReport().page : null
}
