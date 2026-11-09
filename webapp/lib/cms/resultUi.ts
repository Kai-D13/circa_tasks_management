// CMS P2-c (I3) — view-model cho màn kết quả D1 / D2 / D3 / A1 / A3 + XLSX (kế hoạch PM 02/11 §6; UI v2 CMS §3–§4;
// docs/cms/SPEC.md §8). Hàm thuần, không I/O, dùng chung route thật + fixture:
//  · Chỉ CỘNG / TRÌNH BÀY số engine đã tính trong snapshot (cms_results / cms_result_lines) — không tính lại tiền, không áp
//    lại bậc / gate trên tổng (CMS-Q1). Bảng chia theo bậc / "Nếu bán thêm" dùng CÙNG hàm bậc engine và phải khớp tiền
//    snapshot; lệch (cấu hình đã đổi so với run) ⇒ không hiện chia bậc (fail-closed), không tự sửa số.
//  · `null` = chưa có dữ liệu ⇒ UI hiện '—'; 0 chỉ khi run đã công bố và người xem thật sự chưa có CMS (0 hợp lệ).
//  · Không ước tính GMV / số đơn vị cần bán theo giá: snapshot danh mục không mang đơn vị của giá tham khảo nên không xác
//    định được "giá đúng theo unit_CMS" (U13) ⇒ bỏ câu ước tính cần giá.
//  · CMS-UNIT (spec PM 09/11 §4): mọi số lượng trình bày theo CƠ SỞ CỦA RUN (gắn ở từng dòng khi parse). cms_unit ⇒ "đã bán" = Q
//    (Σ lượng đơn bán đúng ĐV tính CMS, ≥ 0), không phần lẻ, không B / K; dòng đơn khác ĐV ⇒ "Đơn vị bán khác ĐV tính CMS — không tính
//    CMS" (tiền 0, giữ lineage). pos_base giữ nguyên B / K.
import { CMS_DEC_FACTOR, formatCmsDecimal, parseCmsDecimal } from './decimal'
import { cmsProgressiveAmount } from './engine/tiers'
import type { CmsEngineTier } from './engine/config'
import {
  cmsFractionUnits, cmsResultState, cmsResultSummary, cmsRowBasis, cmsRowsBasis,
  type CmsCatalogRowDto, type CmsLineStatus, type CmsResultHeaderDto, type CmsResultRowDto, type CmsResultRowsDto, type CmsResultState,
  type CmsResultLineDto, type CmsResultUserDto,
} from './resultView'
import type { StatusTone } from '@/components/ds/StatusBadge'
import { CMS_OTHER_UNIT_TEXT, type CmsQuantityBasis, type CmsRunBasis } from './unitBasis'

const ZERO = BigInt(0)
const ONE = BigInt(1)

export interface CmsUiTier { order: number; from: number; to: number | null; amount: string }

// ── Gói kết quả đã tải (server ⇒ view) ─────────────────────────────────────
/** Kết quả đọc cho một chương trình: off = cờ earnings tắt (giữ nguyên UI P1); upcoming = chưa bắt đầu (không có số);
 *  error = lỗi tải (danh mục vẫn hiện, số ⇒ thông báo lỗi, không 0); gone = run vừa bị thay / dọn (tải lại). */
export type CmsResultsLoad =
  | { kind: 'off' }
  | { kind: 'upcoming' }
  | { kind: 'error' }
  | { kind: 'gone' }
  | { kind: 'loaded'; header: CmsResultHeaderDto; rows: CmsResultRowsDto }

/** Deps đọc kết quả (route thật: lib/cms/server/resultLoad — RPC 122 qua session client; test: giả). */
export interface CmsPinDeps {
  /** isCmsEarningsEnabled() — false ⇒ không gọi gì. */
  enabled: boolean
  header(programId: string): Promise<{ ok: true; data: CmsResultHeaderDto } | { ok: false; error: string }>
  rows(programId: string, runId: string): Promise<{ ok: true; data: CmsResultRowsDto } | { ok: false; error: string }>
}

/**
 * Header rồi rows GHIM run_id của header: run mới công bố giữa hai lần gọi không trộn header cũ với dòng mới. rows báo RUN_GONE
 * (run vừa bị thay / dọn) ⇒ đọc lại từ header MỘT lần; vẫn GONE ⇒ 'gone'. rows trả run khác run đã ghim ⇒ 'error' (không nhận).
 * Cờ OFF / chưa bắt đầu ⇒ không gọi deps nào.
 */
export async function cmsPinnedResults(d: CmsPinDeps, programId: string, o: { started: boolean }): Promise<CmsResultsLoad> {
  if (!d.enabled) return { kind: 'off' }
  if (!o.started) return { kind: 'upcoming' }
  for (let attempt = 0; attempt < 2; attempt++) {
    const h = await d.header(programId)
    if (!h.ok) return { kind: h.error === 'RUN_GONE' ? 'gone' : 'error' }
    if (!h.data.run) return { kind: 'loaded', header: h.data, rows: { runId: null, results: [], catalog: [], users: [] } }
    const r = await d.rows(programId, h.data.run.id)
    // CMS-UNIT: rows phải mang CÙNG cơ sở / phiên bản với run của header (lệch ⇒ lỗi, không trình bày số theo luật khác).
    if (r.ok && r.data.runId === h.data.run.id) {
      const rb = r.data.basis ?? null
      const hb = h.data.run.basis
      if (rb !== null && (rb.basis !== hb.basis || rb.policy !== hb.policy)) return { kind: 'error' }
      return { kind: 'loaded', header: h.data, rows: r.data }
    }
    if (r.ok || r.error !== 'RUN_GONE') return { kind: 'error' }
  }
  return { kind: 'gone' }
}

/** Href D3 (lịch sử dòng) — giữ chương trình / SP đang xem. */
export const cmsHistoryHref = (programId?: string | null, programProductId?: string | null): string => {
  const q = new URLSearchParams()
  if (programId) q.set('program', programId)
  if (programProductId) q.set('product', programProductId)
  const s = q.toString()
  return s ? `/targets/cms/history?${s}` : '/targets/cms/history'
}

export const cmsResultsShown = (r: CmsResultsLoad): r is Extract<CmsResultsLoad, { kind: 'loaded' }> => r.kind === 'loaded'

/**
 * Cơ sở để trình bày LUẬT trên màn (câu nhắc, dòng quy đổi): có run ⇒ cơ sở của run; chưa có run ⇒ cơ sở hiện tại của chương trình
 * (header 128, hoặc `programBasis` đọc từ danh mục khi cờ kết quả tắt / chưa bắt đầu). Số luôn theo cơ sở gắn ở dòng.
 */
export function cmsScreenBasis(r: CmsResultsLoad, programBasis: CmsQuantityBasis | undefined): CmsQuantityBasis {
  if (r.kind === 'loaded') {
    if (r.header.run) return r.header.run.basis.basis
    if (r.header.programBasis) return r.header.programBasis
  }
  return programBasis ?? 'pos_base'
}
/** Trang dòng thuộc ĐÚNG run đã ghim và cùng cơ sở / phiên bản của run (trang DB trước 128 không mang cơ sở ⇒ run phải legacy). */
export function cmsLinesMatchRun(page: { runId: string; basis?: CmsRunBasis }, run: { id: string; basis: CmsRunBasis }): boolean {
  if (page.runId !== run.id) return false
  if (!page.basis) return run.basis.legacy
  return page.basis.basis === run.basis.basis && page.basis.policy === run.basis.policy
}
/** Cơ sở của tập rows đã tải (chưa có run ⇒ pos_base — không có số). */
export const cmsLoadedRowsBasis = (r: CmsResultsLoad): CmsQuantityBasis => (r.kind === 'loaded' ? cmsRowsBasis(r.rows) : 'pos_base')

/** Trạng thái dữ liệu cho nhãn (none ⇒ "Chưa có số liệu", số '—'). */
export function cmsLoadState(r: CmsResultsLoad): CmsResultState | null {
  return r.kind === 'loaded' ? cmsResultState(r.header) : null
}

// ── Số học hiển thị ─────────────────────────────────────────────────────────
function dec(v: string): bigint {
  const r = parseCmsDecimal(v, { allowNegative: true })
  if (!r.ok) throw new Error('CMS_UI_DECIMAL')
  return r.units
}

/** VND nguyên từ GMV thập phân (scale 9), làm tròn LÊN phần lẻ đồng (chỉ để hiển thị "còn thiếu"). */
export function cmsCeilVnd(units: bigint): bigint {
  if (units <= ZERO) return -((-units) / CMS_DEC_FACTOR)
  return (units + CMS_DEC_FACTOR - ONE) / CMS_DEC_FACTOR
}

/** VND nguyên từ GMV thập phân, cắt phần lẻ đồng về 0 (hiển thị tổng GMV — không dùng tính tiền). */
export function cmsTruncVnd(units: bigint): bigint {
  return units / CMS_DEC_FACTOR
}

/** Phần trăm hiển thị thanh (0…∞, số thực — chỉ để vẽ). target ≤ 0 ⇒ null (không vẽ thanh). */
export function cmsPct(valueUnits: bigint, targetVnd: bigint): number | null {
  if (targetVnd <= ZERO) return null
  // ×10.000 rồi chia ⇒ 2 chữ số thập phân của % mà không qua float trên số lớn.
  const x = (valueUnits * BigInt(10000)) / (targetVnd * CMS_DEC_FACTOR)
  return Number(x) / 100
}

const toEngineTiers = (tiers: readonly CmsUiTier[]): CmsEngineTier[] =>
  tiers.map((t) => ({ from: BigInt(t.from), to: t.to === null ? null : BigInt(t.to), amountVnd: BigInt(t.amount) }))

// ── Bậc ─────────────────────────────────────────────────────────────────────
export interface CmsTierSlice { order: number; from: number; to: number | null; amount: string; units: bigint; amountVnd: bigint }

/**
 * Chia Q (số đơn vị CMS nguyên đủ xét) theo bậc: mỗi bậc nhận số đơn vị rơi vào nó (bậc cuối hữu hạn = trần). Tổng tiền các
 * lát = F(Q) của engine. `expectedVnd` (tiền / tiềm năng trong snapshot) khác tổng lát ⇒ null (cấu hình bậc đã đổi so với run —
 * không trình bày chia bậc sai).
 */
export function cmsTierBreakdown(q: bigint, tiers: readonly CmsUiTier[], expectedVnd: bigint): CmsTierSlice[] | null {
  const out: CmsTierSlice[] = []
  let sum = ZERO
  for (const t of tiers) {
    const from = BigInt(t.from)
    if (q < from) { out.push({ ...t, units: ZERO, amountVnd: ZERO }); continue }
    const hi = t.to === null || q < BigInt(t.to) ? q : BigInt(t.to)
    const units = hi - from + ONE
    const amountVnd = units * BigInt(t.amount)
    sum += amountVnd
    out.push({ ...t, units, amountVnd })
  }
  if (sum !== cmsProgressiveAmount(q, toEngineTiers(tiers)) || sum !== expectedVnd) return null
  return out
}

export interface CmsTierPosition {
  /** Chỉ số bậc chứa Q (Q ≥ 1); null khi chưa có đơn vị CMS nào. */
  index: number | null
  /** Bậc kế + số đơn vị CMS còn thiếu để vào bậc đó; null khi đang ở bậc cuối / đã trần. */
  next: { index: number; unitsToNext: bigint } | null
  /** Đã ở bậc cuối (vô hạn) hoặc chạm trần (bậc cuối hữu hạn). */
  top: boolean
  atCap: boolean
}

export function cmsTierPosition(q: bigint, tiers: readonly CmsUiTier[]): CmsTierPosition {
  if (tiers.length === 0) return { index: null, next: null, top: false, atCap: false }
  const last = tiers[tiers.length - 1]
  const atCap = last.to !== null && q >= BigInt(last.to)
  let index: number | null = null
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i]
    if (q >= BigInt(t.from) && (t.to === null || q <= BigInt(t.to))) { index = i; break }
  }
  if (atCap) index = tiers.length - 1
  const nextIdx = index === null ? (q < BigInt(tiers[0].from) ? 0 : null) : index + 1 < tiers.length ? index + 1 : null
  return {
    index,
    next: nextIdx === null || atCap ? null : { index: nextIdx, unitsToNext: BigInt(tiers[nextIdx].from) - q },
    top: index === tiers.length - 1,
    atCap,
  }
}

// ── Gate ────────────────────────────────────────────────────────────────────
export interface CmsGateView {
  basis: 'product' | 'catalog'
  met: boolean
  /** "Đạt từ" (Q-211: lần chuyển sang đạt gần nhất) — chỉ khi đang đạt. */
  metAt: string | null
  gmvVnd: bigint
  targetVnd: bigint
  /** Còn thiếu (làm tròn lên đồng) khi chưa đạt; 0 khi đạt. */
  shortVnd: bigint
  pct: number | null
}

/** Gate của một dòng kết quả: product ⇒ GMV SP / target SP; catalog ⇒ dòng gate danh mục của CÙNG dược sĩ; none ⇒ null. */
export function cmsGateView(r: CmsResultRowDto, catalog: readonly CmsCatalogRowDto[]): CmsGateView | null {
  if (r.gmvBasis === 'none') return null
  if (r.gmvBasis === 'product') {
    if (r.targetGmv === null || r.gateGmv === null) return null
    const g = dec(r.gateGmv)
    const t = BigInt(r.targetGmv)
    const short = t * CMS_DEC_FACTOR - g
    return { basis: 'product', met: r.gateMet, metAt: r.gateMet ? r.gateMetAt : null, gmvVnd: cmsTruncVnd(g), targetVnd: t,
      shortVnd: r.gateMet || short <= ZERO ? ZERO : cmsCeilVnd(short), pct: cmsPct(g, t) }
  }
  const k = catalog.find((c) => c.userId === r.userId)
  if (!k) return null
  return cmsCatalogGateView(k)
}

export function cmsCatalogGateView(k: CmsCatalogRowDto): CmsGateView {
  const g = dec(k.catalogGmv)
  const t = BigInt(k.targetGmv)
  const short = t * CMS_DEC_FACTOR - g
  return { basis: 'catalog', met: k.met, metAt: k.met ? k.metAt : null, gmvVnd: cmsTruncVnd(g), targetVnd: t,
    shortVnd: k.met || short <= ZERO ? ZERO : cmsCeilVnd(short), pct: cmsPct(g, t) }
}

// ── Số lượng hiển thị ──────────────────────────────────────────────────────
/** "5,5" từ lượng cơ sở / K (cắt 2 chữ số, chỉ hiển thị). */
export function cmsQtyText(baseUnits: bigint, perUnitUnits: bigint): string {
  if (perUnitUnits <= ZERO) return '—'
  const neg = baseUnits < ZERO
  const x = ((neg ? -baseUnits : baseUnits) * BigInt(100)) / perUnitUnits
  const int = (x / BigInt(100)).toLocaleString('vi-VN')
  const frac = (x % BigInt(100)).toString().padStart(2, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${int}${frac ? `,${frac}` : ''}`
}

/**
 * Số "đã bán" theo cơ sở của run: pos_base ⇒ B / K ("5,5"); cms_unit ⇒ Q (số đúng ĐV tính CMS, nguyên) — KHÔNG dùng B / K (spec §4).
 */
export function cmsSoldText(r: Pick<CmsResultRowDto, 'baseQuantity' | 'perUnit' | 'cmsQuantity' | 'quantityBasis'>): string {
  return cmsRowBasis(r) === 'cms_unit' ? BigInt(r.cmsQuantity).toLocaleString('vi-VN') : cmsQtyText(dec(r.baseQuantity), dec(r.perUnit))
}

/** Câu nhắc luật mới (spec §4) — dùng chung D1 / D2 / D3 / A3 / XLSX. */
export const CMS_UNIT_RULE_NOTE = 'Chỉ tính đơn bán đúng ĐV tính CMS'
/** "Đã bán 5 hộp" (pos_base) · "Đã bán 5 hộp đúng ĐV" (cms_unit). */
export const cmsSoldPhrase = (soldText: string, unit: string, basis: CmsQuantityBasis): string =>
  basis === 'cms_unit' ? `Đã bán ${soldText} ${unit} đúng ĐV` : `Đã bán ${soldText} ${unit}`
/** Dòng luật dưới thang / mức: pos_base giữ quy đổi cơ sở (U5); cms_unit nhắc chỉ đơn đúng ĐV, không quy đổi đơn vị khác. */
export const cmsQtyRuleLine = (unit: string, baseQtyLine: string, basis: CmsQuantityBasis): string =>
  basis === 'cms_unit' ? `${CMS_UNIT_RULE_NOTE} (${unit}) — bán theo đơn vị khác không quy đổi thành ${unit}` : baseQtyLine
/** Điều kiện target khi cms_unit: GMV target gồm mọi đơn vị bán của SP, còn lượng CMS chỉ đơn đúng ĐV (Q-224). */
export const cmsUnitTargetNote = (unit: string): string =>
  `GMV tính target gồm đơn bán mọi đơn vị của sản phẩm; số lượng tính CMS chỉ gồm đơn bán đúng ĐV ${unit}.`

/** Phần đang cộng dồn (lượng cơ sở chưa đủ một đơn vị CMS), dạng "12 / 24 đơn vị cơ sở"; 0 ⇒ null. cms_unit ⇒ luôn null (không có phần lẻ). */
export function cmsFractionText(r: Pick<CmsResultRowDto, 'baseQuantity' | 'perUnit' | 'cmsQuantity' | 'quantityBasis'>): string | null {
  if (cmsRowBasis(r) === 'cms_unit') return null
  const f = cmsFractionUnits(r)
  if (f <= ZERO) return null
  return `${formatCmsDecimal(f).replace('.', ',')} / ${formatCmsDecimal(dec(r.perUnit)).replace('.', ',')} đơn vị cơ sở`
}

// ── "Có phát sinh bán" — MỘT định nghĩa cho D1 / D2 / D3 / QLCH / A3 / XLSX (PM I3 P1-I3-1) ─────────────────────
/**
 * Người / SP "có phát sinh bán" = lượng cơ sở THUẦN > 0 — bán nửa đơn vị CMS vẫn là có bán (Q = 0, tiền 0 hợp lệ). Khác hẳn
 * "lượt có bán" của Q-212 / engine (Q ≥ 1, `turnsWithSales`) — chỗ nào dùng ngưỡng đó phải ghi rõ "đủ ≥ 1 đơn vị CMS".
 */
export const cmsHasSales = (r: Pick<CmsResultRowDto, 'baseQuantity'>): boolean => dec(r.baseQuantity) > ZERO

export interface CmsProductSalesStats {
  programProductId: string
  /** Cơ sở của run (mọi dòng của một run cùng cơ sở). */
  quantityBasis: CmsQuantityBasis
  amountVnd: bigint
  baseUnits: bigint
  perUnitUnits: bigint
  gmvUnits: bigint
  cmsQuantity: bigint
  /** Dược sĩ (distinct) có phát sinh bán SP này — lượng cơ sở thuần > 0 (cmsHasSales). */
  staffWithSales: number
  /** Dược sĩ đã có CMS (gate đạt và tiền > 0). */
  staffAchieved: number
}

/** Thống kê theo SP dùng chung A3 / QLCH (D1 / D2 / D3) / XLSX — cộng số snapshot, không áp lại bậc. */
export function cmsProductSalesStats(rows: readonly CmsResultRowDto[]): Map<string, CmsProductSalesStats> {
  const m = new Map<string, CmsProductSalesStats & { sold: Set<string>; done: Set<string> }>()
  for (const r of rows) {
    const a = m.get(r.programProductId) ?? { programProductId: r.programProductId, quantityBasis: cmsRowBasis(r), amountVnd: ZERO, baseUnits: ZERO, perUnitUnits: dec(r.perUnit),
      gmvUnits: ZERO, cmsQuantity: ZERO, staffWithSales: 0, staffAchieved: 0, sold: new Set<string>(), done: new Set<string>() }
    if (a.quantityBasis !== cmsRowBasis(r)) throw new Error('CMS_UI_BASIS_MIXED')
    a.amountVnd += BigInt(r.amountVnd)
    a.baseUnits += dec(r.baseQuantity)
    a.gmvUnits += dec(r.gmvAmount)
    a.cmsQuantity += BigInt(r.cmsQuantity)
    if (cmsHasSales(r)) a.sold.add(r.userId)
    if (r.gateMet && BigInt(r.amountVnd) > ZERO) a.done.add(r.userId)
    m.set(r.programProductId, a)
  }
  const out = new Map<string, CmsProductSalesStats>()
  for (const [k, { sold, done, ...x }] of m) out.set(k, { ...x, staffWithSales: sold.size, staffAchieved: done.size })
  return out
}

// ── D1 / D2 staff ──────────────────────────────────────────────────────────
export interface CmsStaffSummary {
  amountVnd: bigint
  /** SP có CMS > 0 (x của "x / y"). */
  productsWithCms: number
  productCount: number
  /** SP đã bán (lượng cơ sở > 0). */
  productsSold: number
  gmvVnd: bigint
}

export function cmsStaffSummary(rows: readonly CmsResultRowDto[], productCount: number): CmsStaffSummary {
  let amount = ZERO
  let gmv = ZERO
  const withCms = new Set<string>()
  const sold = new Set<string>()
  for (const r of rows) {
    const a = BigInt(r.amountVnd)
    amount += a
    gmv += dec(r.gmvAmount)
    if (a > ZERO) withCms.add(r.programProductId)
    if (cmsHasSales(r)) sold.add(r.programProductId)
  }
  return { amountVnd: amount, productsWithCms: withCms.size, productCount, productsSold: sold.size, gmvVnd: cmsTruncVnd(gmv) }
}

export type CmsCardTone = 'earning' | 'waiting_gate' | 'at_cap' | 'none'
export interface CmsStaffCard {
  programProductId: string
  /** Cơ sở của run (row ⇒ của row; chưa có row ⇒ của tập rows). */
  quantityBasis: CmsQuantityBasis
  /** null ⇒ người xem chưa có dòng kết quả cho SP (0 hợp lệ khi run đã công bố). */
  row: CmsResultRowDto | null
  amountVnd: bigint
  soldText: string
  cmsQuantity: bigint
  fraction: string | null
  gate: CmsGateView | null
  tone: CmsCardTone
  position: CmsTierPosition
}

export function cmsStaffCard(o: {
  programProductId: string; perUnit: string; tiers: readonly CmsUiTier[]; row: CmsResultRowDto | null; catalog: readonly CmsCatalogRowDto[]
  /** Cơ sở của run khi người xem chưa có dòng cho SP (cmsRowsBasis(rows)); có row ⇒ cơ sở của row. */
  basis?: CmsQuantityBasis
}): CmsStaffCard {
  const r = o.row
  const q = r ? BigInt(r.cmsQuantity) : ZERO
  const gate = r ? cmsGateView(r, o.catalog) : null
  const amount = r ? BigInt(r.amountVnd) : ZERO
  const position = cmsTierPosition(q, o.tiers)
  const tone: CmsCardTone = gate && !gate.met && q > ZERO ? 'waiting_gate' : position.atCap && amount > ZERO ? 'at_cap' : amount > ZERO ? 'earning' : 'none'
  const basis = r ? cmsRowBasis(r) : o.basis ?? 'pos_base'
  return {
    programProductId: o.programProductId, quantityBasis: basis, row: r, amountVnd: amount,
    soldText: r ? cmsSoldText(r) : basis === 'cms_unit' ? '0' : cmsQtyText(ZERO, dec(o.perUnit)),
    cmsQuantity: q, fraction: r ? cmsFractionText(r) : null, gate, tone, position,
  }
}

/** Bộ lọc D1: met = SP đang có CMS > 0; unmet = còn lại. */
export type CmsCardFilter = 'all' | 'met' | 'unmet'
export const cmsParseCardFilter = (v: string | null | undefined): CmsCardFilter => (v === 'met' || v === 'unmet' ? v : 'all')
export const cmsCardMatches = (c: Pick<CmsStaffCard, 'amountVnd'>, f: CmsCardFilter) => f === 'all' || (f === 'met') === (c.amountVnd > ZERO)

export interface CmsNearGate { programProductId: string; shortVnd: bigint; potentialVnd: bigint; cmsQuantity: bigint; pct: number }

/**
 * "Gợi ý gần đạt" (UI §4.1): SP gate `product` đã có bán nhưng chưa đạt, thiếu ít nhất theo %. Không có ⇒ null (ẩn khối).
 * potential = tiền engine sẽ tính cho số lượng hiện có khi đạt target (potential_amount của snapshot) — không ước tính theo giá.
 */
export function cmsNearestGate(rows: readonly CmsResultRowDto[]): CmsNearGate | null {
  let best: CmsNearGate | null = null
  for (const r of rows) {
    if (r.gmvBasis !== 'product' || r.gateMet || r.targetGmv === null || r.gateGmv === null) continue
    const g = dec(r.gateGmv)
    const t = BigInt(r.targetGmv)
    if (g <= ZERO || t <= ZERO) continue
    const pct = cmsPct(g, t) ?? 0
    const cand: CmsNearGate = { programProductId: r.programProductId, shortVnd: cmsCeilVnd(t * CMS_DEC_FACTOR - g), potentialVnd: BigInt(r.potentialAmount), cmsQuantity: BigInt(r.cmsQuantity), pct }
    if (!best || cand.pct > best.pct || (cand.pct === best.pct && cand.programProductId < best.programProductId)) best = cand
  }
  return best
}

// ── QLCH (tổng nhà thuốc, U19) ──────────────────────────────────────────────
export interface CmsStoreSummary { amountVnd: bigint; staffWithCms: number; staffWithSales: number; productsWithCms: number; productCount: number; gmvVnd: bigint }

/** Tổng staff HIỆN thuộc nhà thuốc (RPC đã lọc phạm vi) — cộng tiền cá nhân, không áp lại bậc. */
export function cmsStoreSummary(rows: readonly CmsResultRowDto[], productCount: number): CmsStoreSummary {
  let amount = ZERO
  let gmv = ZERO
  const withCms = new Set<string>()
  const withSales = new Set<string>()
  const prodCms = new Set<string>()
  for (const r of rows) {
    const a = BigInt(r.amountVnd)
    amount += a
    gmv += dec(r.gmvAmount)
    if (a > ZERO) { withCms.add(r.userId); prodCms.add(r.programProductId) }
    if (cmsHasSales(r)) withSales.add(r.userId)
  }
  return { amountVnd: amount, staffWithCms: withCms.size, staffWithSales: withSales.size, productsWithCms: prodCms.size, productCount, gmvVnd: cmsTruncVnd(gmv) }
}

export interface CmsProductTotals { amountVnd: bigint; soldText: string; staffWithSales: number; staffAchieved: number; gmvVnd: bigint; quantityBasis: CmsQuantityBasis }

/** Tổng theo SP (QLCH thẻ D1 / D2 / D3). SP không có dòng ⇒ 0 hợp lệ (run đã công bố). Người có bán theo cmsHasSales (PM P1-I3-1). */
export function cmsProductTotals(rows: readonly CmsResultRowDto[], perUnitFallback: Map<string, string>, basis: CmsQuantityBasis = 'pos_base'): Map<string, CmsProductTotals> {
  const out = new Map<string, CmsProductTotals>()
  for (const a of cmsProductSalesStats(rows).values()) {
    out.set(a.programProductId, {
      amountVnd: a.amountVnd,
      // cms_unit: Σ Q từng dược sĩ (số đúng ĐV) — không B / K.
      soldText: a.quantityBasis === 'cms_unit' ? a.cmsQuantity.toLocaleString('vi-VN') : cmsQtyText(a.baseUnits, a.perUnitUnits),
      staffWithSales: a.staffWithSales, staffAchieved: a.staffAchieved, gmvVnd: cmsTruncVnd(a.gmvUnits), quantityBasis: a.quantityBasis,
    })
  }
  for (const [pp, k] of perUnitFallback) {
    if (!out.has(pp)) out.set(pp, { amountVnd: ZERO, soldText: basis === 'cms_unit' ? '0' : cmsQtyText(ZERO, dec(k)), staffWithSales: 0, staffAchieved: 0, gmvVnd: ZERO, quantityBasis: basis })
  }
  return out
}

// ── A3: phân bố số lượng hưởng CMS theo bậc (cộng từng dược sĩ) ─────────────
/** Σ theo bậc của số đơn vị được tính CMS (chỉ dòng đạt gate — tiền > 0). Lát từng người khớp tiền snapshot; lệch ⇒ null. */
export function cmsProductTierDistribution(rows: readonly CmsResultRowDto[], tiers: readonly CmsUiTier[]): bigint[] | null {
  const acc = tiers.map(() => ZERO)
  for (const r of rows) {
    if (!r.gateMet || BigInt(r.amountVnd) <= ZERO) continue
    const b = cmsTierBreakdown(BigInt(r.cmsQuantity), tiers, BigInt(r.amountVnd))
    if (!b) return null
    b.forEach((s, i) => { acc[i] += s.units })
  }
  return acc
}

// ── Theo dược sĩ (A3 tab / XLSX) ────────────────────────────────────────────
export interface CmsStaffRowView {
  userId: string
  fullName: string | null
  storeId: string | null
  productsSold: number
  productsAchieved: number
  lineCount: number
  gmvVnd: bigint
  amountVnd: bigint
}

/** Theo dược sĩ: storeId = nhà thuốc HIỆN TẠI (users); sắp tiền giảm dần, cùng tiền ⇒ tên rồi id (ổn định). */
export function cmsStaffRows(rows: readonly CmsResultRowDto[], users: readonly CmsResultUserDto[]): CmsStaffRowView[] {
  const u = new Map(users.map((x) => [x.id, x]))
  const m = new Map<string, CmsStaffRowView & { gmvUnits: bigint }>()
  for (const r of rows) {
    const a = m.get(r.userId) ?? { userId: r.userId, fullName: u.get(r.userId)?.fullName ?? null, storeId: u.get(r.userId)?.storeId ?? null,
      productsSold: 0, productsAchieved: 0, lineCount: 0, gmvVnd: ZERO, amountVnd: ZERO, gmvUnits: ZERO }
    if (cmsHasSales(r)) a.productsSold += 1
    if (r.gateMet && BigInt(r.amountVnd) > ZERO) a.productsAchieved += 1
    a.lineCount += r.lineCount
    a.gmvUnits += dec(r.gmvAmount)
    a.amountVnd += BigInt(r.amountVnd)
    m.set(r.userId, a)
  }
  return [...m.values()]
    .map(({ gmvUnits, ...x }) => ({ ...x, gmvVnd: cmsTruncVnd(gmvUnits) }))
    .sort((x, y) => (x.amountVnd === y.amountVnd ? (x.fullName ?? '').localeCompare(y.fullName ?? '', 'vi') || x.userId.localeCompare(y.userId) : x.amountVnd > y.amountVnd ? -1 : 1))
}

// ── Dòng (D3 / XLSX) ────────────────────────────────────────────────────────
/**
 * Ghi chú phạm vi số liệu phase sales-only (PM 06/11 — planning/research/cms-sales-only-phase-spec-plan-2026-11-06.md §4.3): màn kết
 * quả (A3 admin / SM, hero staff, hero QLCH) và sheet "Thong tin" của XLSX dùng CHUNG một câu. Chỉ hiện khi có snapshot đã công bố và
 * chương trình chưa chốt (chưa có snapshot ⇒ "Chưa có số liệu", không 0 giả). Trả hàng (Q-206) là phase sau.
 */
export const CMS_SALES_ONLY_NOTE = 'CMS tạm tính theo dữ liệu bán hiện có; chưa bao gồm xử lý trả hàng.'

export const CMS_LINE_LABEL: Record<CmsLineStatus, string> = {
  WAITING_GATE: 'Chờ đạt target', ACCUMULATING: 'Đang cộng dồn', RECORDED: 'Đã ghi nhận', AT_CAP: 'Đã đạt trần', ADJUSTMENT: 'Điều chỉnh',
}
export const CMS_LINE_TONE: Record<CmsLineStatus, StatusTone> = {
  WAITING_GATE: 'neutral', ACCUMULATING: 'neutral', RECORDED: 'info', AT_CAP: 'info', ADJUSTMENT: 'warning',
}

/** Lượng đơn vị CMS dòng này đẩy thêm (qty_after − qty_before) — chỉ trình bày, tiền dòng lấy từ snapshot. */
export const cmsLineUnits = (l: { qtyBefore: string; qtyAfter: string }): bigint => BigInt(l.qtyAfter) - BigInt(l.qtyBefore)

export interface CmsLineView {
  label: string
  tone: StatusTone
  /** Tiền dòng (snapshot); null ⇒ không hiển thị số (dòng điều chỉnh khi Q-206 chưa chốt — U18). */
  amountVnd: bigint | null
  /** Số lượng dòng theo đơn vị CMS (pos_base: B / K, cắt 2 chữ số; cms_unit: lượng đúng ĐV). */
  qtyText: string
  /** Nhãn lượng ĐẦY ĐỦ để hiển thị: "1,5 hộp" · "2 hộp" (cms_unit đúng ĐV) · "3 viên" (cms_unit khác ĐV — đơn vị bán gốc). */
  qtyLabel: string
  /** Dòng phụ cách tính — không tự tính lại tiền. */
  note: string
  /** CHỈ cms_unit: đơn vị bán có khớp ĐV tính CMS; pos_base ⇒ null. */
  unitMatch: boolean | null
}

/**
 * Trình bày một dòng lịch sử. `returnsApproved` = hợp đồng trả hàng Q-206 đã chốt (lib/cms/releaseGate) — chưa chốt thì KHÔNG
 * hiện nhãn "Điều chỉnh" / số âm (U18): dòng ADJUSTMENT (chỉ có thể xuất hiện ở dữ liệu QA) hiện "Chờ xác nhận", tiền '—'.
 */
export function cmsLineView(l: Pick<CmsResultLineDto, 'status' | 'amountVnd' | 'baseQuantity' | 'qtyBefore' | 'qtyAfter' | 'quantityBasis' | 'unitMatch' | 'countedQuantity'> & Partial<Pick<CmsResultLineDto, 'quantityRaw' | 'uomRaw'>>, perUnit: string, unit: string, returnsApproved: boolean): CmsLineView {
  if (l.quantityBasis === 'cms_unit') return cmsUnitLineView(l, unit, returnsApproved)
  const qtyText = cmsQtyText(dec(l.baseQuantity), dec(perUnit))
  const qtyLabel = `${qtyText} ${unit}`
  if (l.status === 'ADJUSTMENT' && !returnsApproved) return { label: 'Chờ xác nhận', tone: 'neutral', amountVnd: null, qtyText, qtyLabel, note: 'Dòng điều chỉnh chưa được công bố', unitMatch: null }
  const units = cmsLineUnits(l)
  const note = l.status === 'WAITING_GATE' ? 'Chưa đạt target — CMS tính khi đạt'
    : l.status === 'ACCUMULATING' ? `Cộng dồn, chưa đủ thêm 1 ${unit}`
      : l.status === 'AT_CAP' ? (units > ZERO ? `+${units} ${unit} tính CMS · chạm trần` : 'Vượt trần — không thêm CMS')
        : units > ZERO ? `+${units} ${unit} tính CMS` : ''
  return { label: CMS_LINE_LABEL[l.status], tone: CMS_LINE_TONE[l.status], amountVnd: BigInt(l.amountVnd), qtyText, qtyLabel, note, unitMatch: null }
}

/**
 * Dòng run cms_unit (UNIT-D03): đúng ĐV ⇒ lượng dòng = c_i (nguyên) "2 hộp"; khác ĐV ⇒ nhãn "Khác ĐV tính CMS", lượng hiển thị theo
 * ĐƠN VỊ BÁN GỐC ("3 viên"), ghi chú lý do, tiền 0 của snapshot (không quy đổi). Điều chỉnh khi Q-206 chưa chốt ⇒ như pos_base (U18).
 */
function cmsUnitLineView(l: Pick<CmsResultLineDto, 'status' | 'amountVnd' | 'qtyBefore' | 'qtyAfter' | 'unitMatch' | 'countedQuantity'> & Partial<Pick<CmsResultLineDto, 'quantityRaw' | 'uomRaw'>>, unit: string, returnsApproved: boolean): CmsLineView {
  const match = l.unitMatch === true
  const qtyText = match ? BigInt(l.countedQuantity ?? '0').toLocaleString('vi-VN') : (l.quantityRaw ?? '—')
  const qtyLabel = match ? `${qtyText} ${unit}` : `${qtyText} ${l.uomRaw ?? ''}`.trim()
  if (l.status === 'ADJUSTMENT' && !returnsApproved) return { label: 'Chờ xác nhận', tone: 'neutral', amountVnd: null, qtyText, qtyLabel, note: 'Dòng điều chỉnh chưa được công bố', unitMatch: match }
  if (!match && l.status !== 'ADJUSTMENT') {
    return { label: 'Khác ĐV tính CMS', tone: 'neutral', amountVnd: BigInt(l.amountVnd), qtyText, qtyLabel, note: CMS_OTHER_UNIT_TEXT, unitMatch: false }
  }
  const units = cmsLineUnits(l)
  const note = l.status === 'ADJUSTMENT' ? (match ? '' : CMS_OTHER_UNIT_TEXT)
    : l.status === 'WAITING_GATE' ? 'Chưa đạt target — CMS tính khi đạt'
      : units > ZERO ? (BigInt(l.amountVnd) > ZERO ? `+${units} ${unit} tính CMS` : `+${units} ${unit} · chưa tới bậc tính CMS`) : ''
  return { label: CMS_LINE_LABEL[l.status], tone: CMS_LINE_TONE[l.status], amountVnd: BigInt(l.amountVnd), qtyText, qtyLabel, note, unitMatch: match }
}

// ── D3: phân trang ghim run (UI §4.3; kế hoạch PM §6.1) ─────────────────────
export const CMS_HISTORY_STEP = 20
export const CMS_HISTORY_MAX_N = 200
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface CmsHistoryParams { programId: string | null; productId: string | null; run: string | null; after: number | null; n: number }

/** Tham số D3 từ URL: id phải là UUID chữ thường; `n` = số dòng đang hiện (20, 40, … 200); `after` = con trỏ seq (≥ 0). */
export function cmsParseHistoryParams(sp: Record<string, string | string[] | undefined>): CmsHistoryParams {
  const one = (k: string) => { const v = sp[k]; return typeof v === 'string' ? v : null }
  const id = (k: string) => { const v = one(k); return v && UUID_RE.test(v) ? v : null }
  const nRaw = Number(one('n'))
  const n = Number.isInteger(nRaw) && nRaw >= CMS_HISTORY_STEP && nRaw <= CMS_HISTORY_MAX_N && nRaw % CMS_HISTORY_STEP === 0 ? nRaw : CMS_HISTORY_STEP
  const aRaw = one('after')
  const after = aRaw !== null && /^(0|[1-9][0-9]{0,8})$/.test(aRaw) ? Number(aRaw) : null
  return { programId: id('program'), productId: id('product'), run: id('run'), after, n }
}

export function cmsHistoryUrl(p: Partial<CmsHistoryParams>): string {
  const q = new URLSearchParams()
  if (p.programId) q.set('program', p.programId)
  if (p.productId) q.set('product', p.productId)
  if (p.run) q.set('run', p.run)
  if (p.after !== null && p.after !== undefined) q.set('after', String(p.after))
  if (p.n && p.n !== CMS_HISTORY_STEP) q.set('n', String(p.n))
  const s = q.toString()
  return s ? `/targets/cms/history?${s}` : '/targets/cms/history'
}

/**
 * Link "Xem thêm": còn trang (nextAfterSeq ≠ null) ⇒ tăng n thêm 20 trên CÙNG con trỏ (một lần đọc, thứ tự seq ổn định); tới trần
 * 200 dòng / lần ⇒ chuyển con trỏ sang seq cuối đã hiện, n về 20. Luôn giữ run đã ghim — không nối hai phiên.
 */
export function cmsHistoryMore(p: CmsHistoryParams & { run: string }, nextAfterSeq: number | null): string | null {
  if (nextAfterSeq === null) return null
  if (p.n + CMS_HISTORY_STEP <= CMS_HISTORY_MAX_N) return cmsHistoryUrl({ ...p, n: p.n + CMS_HISTORY_STEP })
  return cmsHistoryUrl({ ...p, after: nextAfterSeq, n: CMS_HISTORY_STEP })
}

// ── A3: nhóm "Chưa gán dược sĩ" (U11) từ totals của run (chỉ super đọc được) ─
export const CMS_UNASSIGNED_LABEL: Record<string, string> = {
  NO_EMAIL: 'Nguồn không có email người bán',
  NOT_FOUND: 'Email không khớp tài khoản nào',
  MULTIPLE: 'Email trùng nhiều tài khoản',
  SHARED_ACCOUNT: 'Tài khoản dùng chung của cửa hàng',
  NOT_STAFF: 'Không phải tài khoản dược sĩ',
  STORE_NOT_ELIGIBLE: 'Nhà thuốc không hợp lệ (FS / ngừng / chưa gán)',
}

export interface CmsUnassignedSummary { count: number; gmvVnd: bigint | null; reasons: { reason: string; label: string; count: number }[] }

/** Đọc phòng thủ `run.totals` (whitelist khoá đã kiểm ở seal 122): thiếu / sai dạng ⇒ null (không hiện khối, không 0 giả). */
export function cmsUnassignedSummary(totals: Record<string, unknown> | null | undefined): CmsUnassignedSummary | null {
  if (!totals) return null
  const count = totals.unassigned
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null
  const by = totals.unassigned_by_reason
  const reasons: CmsUnassignedSummary['reasons'] = []
  if (by && typeof by === 'object' && !Array.isArray(by)) {
    for (const [reason, n] of Object.entries(by as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && CMS_UNASSIGNED_LABEL[reason]) reasons.push({ reason, label: CMS_UNASSIGNED_LABEL[reason], count: n })
    }
  }
  reasons.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
  const g = totals.unassigned_gmv
  let gmvVnd: bigint | null = null
  if (typeof g === 'string') { const r = parseCmsDecimal(g, { allowNegative: true }); if (r.ok) gmvVnd = cmsTruncVnd(r.units) }
  return { count, gmvVnd, reasons }
}

/** Chỉ số A3 (Q-212): lượt = dược sĩ × SP; mẫu số dược sĩ = staff hiện thuộc phạm vi (null ⇒ không hiện "/y"). */
export interface CmsA3Stats { amountVnd: bigint; gmvVnd: bigint; pharmacistsWithCms: number; pharmacistDenominator: number | null; turnsAchieved: number; turnsWithSales: number }

export function cmsA3Stats(rows: readonly CmsResultRowDto[], productIds: readonly string[], eligibleStaffIds: readonly string[] | null): CmsA3Stats {
  const s = cmsResultSummary(rows, { productIds, eligibleStaffIds })
  let gmv = ZERO
  for (const r of rows) gmv += dec(r.gmvAmount)
  return { amountVnd: s.amountVnd, gmvVnd: cmsTruncVnd(gmv), pharmacistsWithCms: s.pharmacistsWithCms, pharmacistDenominator: s.pharmacistDenominator, turnsAchieved: s.turnsAchieved, turnsWithSales: s.turnsWithSales }
}

// ── A1: ô kết quả theo chương trình + thống kê P2 (U2 / U20; Q-212) ──────────
// CMS-UI-1 (PM 04/11 §6.4): A1 đọc thêm chương trình ĐÃ CHỐT (run đóng băng, cùng RPC 122 / session) trong CÙNG ngân sách
// CMS_A1_MAX: đang chạy / chờ chốt thật trước, đã chốt thật dùng phần còn lại, QA cuối. Ô đã chốt ghi "Đã chốt", KHÔNG cộng vào
// hai ô tổng đang chạy / chờ chốt, không vào "Dược sĩ có CMS". Đã chốt chưa tải / lỗi ⇒ '—' + link A3 (không 0 giả).
export type CmsA1Cell =
  | { kind: 'ok'; amountVnd: bigint; productsWithCms: number; productCount: number; pharmacistsWithCms: number; publishedAt: string | null; locked: boolean }
  | { kind: 'none' }
  | { kind: 'error' }

export interface CmsA1Stats {
  /** Σ CMS tạm tính các chương trình ĐANG CHẠY (không QA). null ⇒ '—' (lỗi tải hoặc chưa chương trình nào có số). */
  runningVnd: bigint | null
  /** Σ CMS các chương trình CHỜ CHỐT KỲ (không QA). */
  waitingVnd: bigint | null
  /** Dược sĩ distinct có CMS > 0 trên các chương trình đang chạy + chờ chốt (không QA, không đã chốt). */
  pharmacists: number | null
  /** Số chương trình (không QA, đang chạy / chờ chốt) chưa có snapshot — gợi ý dưới ô. */
  withoutSnapshot: number
  /** Tách theo nhóm để gợi ý nằm đúng ô (PM 04/11 §6.5). */
  withoutSnapshotRunning: number
  withoutSnapshotWaiting: number
  /** Số chương trình thật (đang chạy / chờ chốt) KHÔNG được tải vì vượt trần một lượt xem — > 0 ⇒ mọi ô tổng '—'. */
  notLoaded: number
}

export type CmsA1Display = 'draft' | 'upcoming' | 'running' | 'waiting_close' | 'locked' | string
const A1_OPEN = (d: CmsA1Display) => d === 'running' || d === 'waiting_close'

/** Thứ tự tải A1 khi có trần: thật đang chạy / chờ chốt → thật đã chốt → QA; giữ thứ tự danh sách trong mỗi nhóm. */
export function cmsA1LoadOrder<T extends { isTest: boolean; display?: CmsA1Display }>(programs: readonly T[], max: number): T[] {
  const open = (p: T) => p.display === undefined || A1_OPEN(p.display)
  return [
    ...programs.filter((p) => !p.isTest && open(p)),
    ...programs.filter((p) => !p.isTest && p.display === 'locked'),
    ...programs.filter((p) => p.isTest),
  ].slice(0, Math.max(0, max))
}

/**
 * `programs`: TOÀN BỘ chương trình đang chạy / chờ chốt kỳ / đã chốt người xem đọc được; `loads`: kết quả đã tải theo id (thiếu ⇒
 * không có ô). Thống kê loại QA (U20) và loại đã chốt; một chương trình thật đang chạy / chờ chốt lỗi tải ⇒ ô thống kê liên quan
 * '—'; chương trình thật đang chạy / chờ chốt không được tải (vượt trần) ⇒ mọi ô tổng '—' + `notLoaded` — không bao giờ cộng thiếu
 * thành một tổng trông như đủ (pm-auditor I3 P1-1).
 */
export function cmsA1Results(programs: readonly { id: string; display: CmsA1Display; isTest: boolean; productCount: number }[], loads: ReadonlyMap<string, CmsResultsLoad>): { cells: Map<string, CmsA1Cell>; stats: CmsA1Stats } {
  const cells = new Map<string, CmsA1Cell>()
  let running: bigint | null = ZERO, waiting: bigint | null = ZERO
  let anyRunning = false, anyWaiting = false, pharmErr = false, notLoaded = 0, noneRunning = 0, noneWaiting = 0
  const users = new Set<string>()
  for (const p of programs) {
    const l = loads.get(p.id)
    if (!l) {
      if (!p.isTest && A1_OPEN(p.display)) notLoaded += 1
      continue
    }
    let cell: CmsA1Cell
    if (l.kind === 'loaded' && l.header.run) {
      const s = cmsProgramResultSummary(l.rows.results, p.productCount)
      cell = { kind: 'ok', amountVnd: s.amountVnd, productsWithCms: s.productsWithCms, productCount: p.productCount, pharmacistsWithCms: s.pharmacistsWithCms, publishedAt: l.header.run.publishedAt, locked: p.display === 'locked' }
    } else if (l.kind === 'loaded') cell = { kind: 'none' }
    else if (l.kind === 'off' || l.kind === 'upcoming') continue
    else cell = { kind: 'error' }
    cells.set(p.id, cell)
    if (p.isTest || !A1_OPEN(p.display)) continue
    const isRunning = p.display === 'running'
    if (cell.kind === 'error') { if (isRunning) running = null; else waiting = null; pharmErr = true; continue }
    if (cell.kind === 'none') { if (isRunning) noneRunning += 1; else noneWaiting += 1; continue }
    if (isRunning) { anyRunning = true; if (running !== null) running += cell.amountVnd } else { anyWaiting = true; if (waiting !== null) waiting += cell.amountVnd }
    const l2 = l as Extract<CmsResultsLoad, { kind: 'loaded' }>
    for (const u of cmsProgramResultSummary(l2.rows.results, p.productCount).userIdsWithCms) users.add(u)
  }
  return {
    cells,
    stats: {
      runningVnd: anyRunning && notLoaded === 0 ? running : null,
      waitingVnd: anyWaiting && notLoaded === 0 ? waiting : null,
      pharmacists: pharmErr || notLoaded > 0 || (!anyRunning && !anyWaiting) ? null : users.size,
      withoutSnapshot: noneRunning + noneWaiting,
      withoutSnapshotRunning: noneRunning,
      withoutSnapshotWaiting: noneWaiting,
      notLoaded,
    },
  }
}

// ── A1 ──────────────────────────────────────────────────────────────────────
export interface CmsProgramResultSummary {
  amountVnd: bigint
  productsWithCms: number
  productCount: number
  pharmacistsWithCms: number
  userIdsWithCms: string[]
}

export function cmsProgramResultSummary(rows: readonly CmsResultRowDto[], productCount: number): CmsProgramResultSummary {
  let amount = ZERO
  const prod = new Set<string>()
  const users = new Set<string>()
  for (const r of rows) {
    const a = BigInt(r.amountVnd)
    amount += a
    if (a > ZERO && r.gateMet) { prod.add(r.programProductId); users.add(r.userId) }
  }
  return { amountVnd: amount, productsWithCms: prod.size, productCount, pharmacistsWithCms: users.size, userIdsWithCms: [...users].sort() }
}
