// CMS I4 offline (PM 04/11 — `planning/reviews/2026-11-04-cms-p3a-postcommit-pm.md` §I4; checklist
// `planning/research/cms-i4-bi-checklist.md` r1.1 §1, §2.5, §4). Phần THUẦN cho công cụ `scripts/cms-i4-offline.mjs` và spec
// `e2e/cms-i4-offline.spec.ts`: không mạng, không DB, không BigQuery. Mọi đường đọc dòng nguồn đi qua CHÍNH bộ chuẩn hoá /
// kiểm chất lượng / engine của app (`lib/cms/source/contract`, `lib/cms/quality`, `lib/cms/engine/compute`) để kết quả offline
// = kết quả app sẽ tính trên cùng dữ liệu. Oracle N4b viết ĐỘC LẬP với compute.ts (lọc, quy người, cộng dồn, gate, bậc từng đơn
// vị) để bắt lỗi engine lẫn lỗi dữ liệu.
//
// Dữ liệu thật (BI xuất từ view) KHÔNG nằm trong Git: script từ chối đường dẫn trong repo (trừ fixture giả
// `e2e/fixtures/cms-i4/`); đầu ra chỉ số đếm / hash / email che (`maskCmsEmail`).
//   · check-sales / check-products — chất lượng + hợp đồng cột (7 / 14 cột, nullable vẫn phải có cột) như app khi đọc view;
//   · n4a — bảng kiểm dữ liệu THÔ 6–10 đơn (KHÔNG kết luận tiền) + độ phủ ca a–i;
//   · reconcile — N4b: engine candidate + oracle độc lập + (tuỳ chọn) số BI / operator tính tay, cả kỳ, từng đồng.
//
// r2 (PM `planning/reviews/2026-11-04-cms-i4-offline-pm.md` I4-P1-1 / I4-P1-2): MỘT kết luận nghiệm thu (`CmsI4Readiness`) cho
// mọi lệnh — check-sales và reconcile cùng dữ liệu + bối cảnh đi qua CÙNG `evaluateSales` nên không thể một bên đỏ một bên đạt.
// Readiness = app thật giữ snapshot cũ (quality.ts + OVERFLOW, ứng viên / chưa gán lấy từ CHÍNH engine như salesSync) + vi phạm
// hợp đồng app không tự báo (ProductID sai dạng chuẩn — SQL lọc chuỗi, I4-F2) + không có bằng chứng (file rỗng / 0 ứng viên).
// Những gì offline KHÔNG kiểm được (trang BigQuery, snapshot trước cho EMPTY_AFTER_DATA, độ đủ toàn kỳ) ghi `notProven`, không
// bao giờ thành "đạt". Kỳ vọng 0 chỉ khớp với "engine không có cặp" khi MỌI chỉ số kỳ vọng đã cung cấp đều 0.

import crypto from 'node:crypto'
import { decodeCareCsv, parseCsvRecords } from '../lib/care/import/csvCore'
import {
  CMS_PRODUCT_COLUMNS, CMS_SALES_COLUMNS, isEligibleOrder, normalizeProductRow, normalizeSalesRow,
  type CmsRawRow, type CmsRowIssue, type CmsSalesLine,
} from '../lib/cms/source/contract'
import { assessSalesSnapshot, findDuplicates, type CmsHoldReason } from '../lib/cms/quality'
import { buildSellerIndex, mapSeller, maskCmsEmail, type CmsSellerIndex, type CmsStoreRef, type CmsUserRef } from '../lib/cms/mapping'
import { parseCmsEngineProgram, type CmsEngineProgram, type CmsEngineProgramInput } from '../lib/cms/engine/config'
import { computeCmsProgram, type CmsEngineOutput } from '../lib/cms/engine/compute'
import { cmsStageBoundsIssue } from '../lib/cms/resultStage'
import { CMS_DEC_FACTOR, formatCmsDecimal, parseCmsDecimal } from '../lib/cms/decimal'
import { formatUtcMicros, isCmsIsoDate } from '../lib/cms/time'
import { canonicalProductId } from '../lib/cms/productId'
import { buildCmsProductsQuery, buildCmsSalesQuery, cmsSalesSourceColumn } from '../lib/cms/source/bigquery'

const B = (n: number | string) => BigInt(n)
const ZERO = B(0)
/** Trần bản ghi một file xuất (cùng trần dòng một lượt của app + 1 header). */
export const CMS_I4_MAX_RECORDS = 200_001
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const count = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1 }
/** Bí danh ổn định của tài khoản trong bảng (không in UUID / email đầy đủ). */
export const cmsI4Pseudo = (userId: string) => 'u' + sha(userId).slice(0, 6)

// ── CSV ──────────────────────────────────────────────────────────────────────

export type CmsI4Csv =
  | { ok: true; header: string[]; rows: CmsRawRow[]; extraColumns: string[] }
  | { ok: false; reason: string }

/**
 * File BI xuất (UTF-8, RFC 4180, dòng đầu là tên cột) ⇒ bản ghi theo TÊN cột như adapter SELECT. Thiếu cột của hợp đồng ⇒
 * SCHEMA_MISMATCH (app thật dừng cả lượt); cột thừa được bỏ qua (app SELECT theo tên). Ô rỗng = NULL (BI xuất NULL thành rỗng —
 * bộ chuẩn hoá app cũng coi chuỗi rỗng là thiếu).
 */
export function cmsI4ReadCsv(buf: Uint8Array, columns: readonly string[], optional: readonly string[] = []): CmsI4Csv {
  const dec = decodeCareCsv(buf)
  if (!dec.ok) return { ok: false, reason: dec.error }
  const parsed = parseCsvRecords(dec.text, { maxRecords: CMS_I4_MAX_RECORDS, maxFields: 200 })
  if (!parsed.ok) return { ok: false, reason: `CSV_${parsed.reason}` }
  if (parsed.records.length === 0) return { ok: false, reason: 'EMPTY_FILE' }
  const header = parsed.records[0].map((h) => h.trim())
  if (new Set(header).size !== header.length) return { ok: false, reason: 'DUPLICATE_HEADER' }
  const missing = columns.filter((c) => !header.includes(c))
  if (missing.length) return { ok: false, reason: `SCHEMA_MISMATCH: thiếu cột ${missing.join(', ')}` }
  const rows: CmsRawRow[] = []
  for (let i = 1; i < parsed.records.length; i++) {
    const r = parsed.records[i]
    if (r.length === 1 && r[0] === '') continue // dòng trống cuối file
    if (r.length !== header.length) return { ok: false, reason: `ROW_FIELD_COUNT: bản ghi ${i + 1} có ${r.length} trường, header ${header.length}` }
    const row: CmsRawRow = {}
    for (const c of [...columns, ...optional.filter((x) => header.includes(x))]) { const v = r[header.indexOf(c)]; row[c] = v === '' ? null : v }
    rows.push(row)
  }
  return { ok: true, header, rows, extraColumns: header.filter((h) => !columns.includes(h) && !optional.includes(h)) }
}

const issueKey = (i: CmsRowIssue) => `${i.kind}:${i.field}`
/** Số dạng mũ / dấu hiệu FLOAT64 (checklist §1.1): app coi là lỗi dòng. */
const EXPONENT_RE = /[eE]/

/** Hash chuẩn hoá KHÔNG phụ thuộc thứ tự dòng (cùng ý probe nguồn): đổi giá trị / thêm bớt dòng ⇒ đổi hash. */
export function cmsI4SalesHash(lines: readonly CmsSalesLine[]): string {
  return sha(lines.map((l) => [l.orderLineId, l.orderId, l.orderCode, l.productId, l.sellerEmail ?? '', l.posCode ?? '', l.orderType,
    l.orderStatus, l.completedAtMicros, l.quantityRaw ?? '', l.uomRaw ?? '', l.baseQuantityUnits, l.gmvUnits, l.sourceUpdatedAtMicros].join('\u001f'))
    .sort().join('\n'))
}

// ── Kết luận nghiệm thu offline (readiness) — MỘT kết luận cho mọi lệnh CLI ──

/** Lý do app thật GIỮ snapshot cũ: quality.ts (dòng bán) + OVERFLOW (salesSync) · ROW_ISSUES / DUPLICATE_PRODUCT / EMPTY_SOURCE (productSync). */
export type CmsI4HeldReason = CmsHoldReason | 'OVERFLOW' | 'DUPLICATE_PRODUCT' | 'EMPTY_SOURCE'

/**
 * Kết luận nghiệm thu offline. `ready` ⇔ không held, không vi phạm hợp đồng, có bằng chứng. CLI: rc 0 CHỈ khi `ready` (và các phép
 * so khác của lệnh đó đạt). `notProven` = điều offline không kiểm được — không đổi rc nhưng KHÔNG được ghi là đã chứng minh:
 *   INCOMPLETE_PAGES    file xuất không mang totalRows / trang BigQuery (probe N1 / N3 mới kiểm);
 *   EMPTY_AFTER_DATA    offline không có snapshot công bố trước (không tự dựng);
 *   PERIOD_COMPLETENESS export đủ toàn kỳ / nguồn đủ tới hết kỳ (Q-216) — BI xác nhận;
 *   UNASSIGNED_OVER_THRESHOLD, OVERFLOW — cần --context (không có bối cảnh thì chưa đánh giá).
 */
export interface CmsI4Readiness {
  status: 'ready' | 'not_ready'
  held: CmsI4HeldReason[]
  /** Vi phạm hợp đồng mà app KHÔNG tự báo (mất dòng lặng lẽ) — I4-F2, PM 04/11 (a): ProductID canonical tại view. */
  contract: 'NON_CANONICAL_PRODUCT_ID'[]
  /** Không có bằng chứng: rỗng không bao giờ là "đạt" / "khớp". */
  noEvidence: ('EMPTY_EXPORT' | 'NO_CANDIDATES')[]
  notProven: string[]
}

const cmsI4Readiness = (held: CmsI4HeldReason[], contract: CmsI4Readiness['contract'], noEvidence: CmsI4Readiness['noEvidence'], notProven: string[]): CmsI4Readiness =>
  ({ status: held.length || contract.length || noEvidence.length ? 'not_ready' : 'ready', held, contract, noEvidence, notProven })

// ── Kiểm chất lượng dòng bán ─────────────────────────────────────────────────

export interface CmsI4SalesCheck {
  /** `program` = có bối cảnh chương trình (kỳ, SP, mapping, engine); `contract` = chỉ hợp đồng file (không mapping / ngưỡng). */
  scope: 'program' | 'contract'
  rowsRead: number
  valid: number
  invalid: number
  /** `${kind}:${field}` ⇒ số dòng (một dòng có thể có nhiều lỗi). */
  issues: Record<string, number>
  duplicateLineIds: number
  exponentLike: number
  /**
   * product_id dạng chữ số nhưng KHÔNG canonical (số 0 đầu, khoảng trắng). SQL production lọc `CAST(product_id AS STRING) IN
   * UNNEST(@product_ids)` với ID canonical ⇒ các dòng này bị loại Ở SQL, lặng lẽ (không lỗi). Phải = 0 (hợp đồng §1.3) — vi phạm
   * ⇒ readiness `contract`.
   */
  nonCanonicalProductId: number
  /** Có bối cảnh: số dòng hợp lệ của SP chương trình mà SQL production lọc mất vì ProductID sai dạng (app thật không đọc). */
  sqlDroppedNonCanonical: number | null
  negative: number
  zeroBase: number
  noEmail: number
  /** `${order_type}/${order_status}` trên dòng hợp lệ. */
  typeStatus: Record<string, number>
  eligible: number
  window: { from: string; to: string; inWindow: number; outOfWindow: number } | null
  vnDateRange: { min: string; max: string } | null
  /** Có bối cảnh ⇒ số dòng ứng viên theo CHÍNH engine (OFFLINE + COMPLETED + trong kỳ + SP chương trình), như salesSync. */
  candidates: number | null
  /** Có bối cảnh ⇒ lý do chưa gán của dòng ứng viên (engine). */
  unassigned: Record<string, number> | null
  readiness: CmsI4Readiness
  hash: string
}

/** Ngày VN (UTC+7) — viết riêng, không dùng lib/cms/time (oracle / công cụ độc lập). */
export const cmsI4VnDate = (micros: bigint) => new Date(Number(micros / B(1000)) + 7 * 3_600_000).toISOString().slice(0, 10)

/** Ô product_id thô sai dạng (giữ số 0 đầu / khoảng trắng để BI thấy), bỏ ký tự điều khiển, cắt 40. */
const rawIdCell = (v: string) => {
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001F\u007F-\u009F|]/g, ' ')
  return `"${t.length > 40 ? `${t.slice(0, 40)}…` : t}"`
}
const isNonCanonicalId = (v: unknown) => {
  if (typeof v !== 'string') return false
  const c = canonicalProductId(v)
  return c.ok && c.id !== v
}

interface CmsI4Eval {
  check: CmsI4SalesCheck
  /** Có bối cảnh: dòng app thật đọc (bỏ dòng SQL lọc mất, bỏ trùng — giữ bản đầu) + đầu ra engine trên ĐÚNG tập đó. */
  engine: { lines: CmsSalesLine[]; out: CmsEngineOutput; sqlDropped: number } | null
}

/**
 * Lõi chung của check-sales và reconcile (I4-P1-2): cùng dữ liệu + bối cảnh ⇒ cùng readiness. Có bối cảnh thì đi đúng đường
 * salesSync: SQL lọc ProductID theo CHUỖI (mô phỏng chỗ lệch tiền I4-F2 — dòng ngoài kỳ / SP khác engine tự loại, không đổi tiền)
 * → engine → assessSalesSnapshot với ứng viên / chưa gán của engine → cmsStageBoundsIssue. Không có snapshot trước
 * (previousPublishedRows = null) và không có trang BigQuery: hai điều đó ghi `notProven`, không dựng giả.
 */
function evaluateSales(rows: readonly CmsRawRow[], ctx?: CmsI4Context): CmsI4Eval {
  const program = ctx ? parseCmsEngineProgram(ctx.program) : null
  const issues: Record<string, number> = {}
  const rowIssues: CmsRowIssue[][] = []
  const lines: CmsSalesLine[] = []
  const appLines: CmsSalesLine[] = []
  let exponentLike = 0
  let nonCanonicalProductId = 0
  let sqlDropped = 0
  for (const r of rows) {
    if (['base_quantity', 'gmv_amount', 'quantity_raw'].some((f) => typeof r[f] === 'string' && EXPONENT_RE.test(r[f] as string))) exponentLike++
    const nonCanon = isNonCanonicalId(r.product_id)
    if (nonCanon) nonCanonicalProductId++
    const n = normalizeSalesRow(r)
    if (!n.ok) { rowIssues.push(n.issues); for (const i of n.issues) count(issues, issueKey(i)); continue }
    lines.push(n.value)
    if (nonCanon && program?.products.has(n.value.productId)) sqlDropped++
    else appLines.push(n.value)
  }
  // Như salesSync: khoá trùng xét trên order_line_id ĐÃ chuẩn hoá của dòng hợp lệ (app held trước khi chạy engine).
  const lineIds = lines.map((l) => l.orderLineId)
  let engine: CmsI4Eval['engine'] = null
  if (ctx) {
    const firstSeen = new Set<string>()
    const uniq = appLines.filter((l) => (firstSeen.has(l.orderLineId) ? false : (firstSeen.add(l.orderLineId), true)))
    engine = { lines: uniq, out: computeCmsProgram({ program: ctx.program, lines: uniq, sellers: buildSellerIndex(ctx.users, ctx.stores) }), sqlDropped }
  }
  const verdict = assessSalesSnapshot({
    rowsRead: rows.length, totalRowsReported: null, pagesComplete: true, rowIssues, lineIds,
    candidates: engine ? engine.out.totals.candidates : 0, unassigned: engine ? engine.out.totals.unassigned : 0, previousPublishedRows: null,
  })
  const held: CmsI4HeldReason[] = [...verdict.reasons]
  if (engine && cmsStageBoundsIssue(engine.out, engine.lines) === 'OVERFLOW') held.push('OVERFLOW')
  const noEvidence: CmsI4Readiness['noEvidence'] = []
  if (rows.length === 0) noEvidence.push('EMPTY_EXPORT')
  if (engine && engine.out.totals.candidates === 0) noEvidence.push('NO_CANDIDATES')
  const readiness = cmsI4Readiness(held, nonCanonicalProductId > 0 ? ['NON_CANONICAL_PRODUCT_ID'] : [], noEvidence,
    ['INCOMPLETE_PAGES', 'EMPTY_AFTER_DATA', 'PERIOD_COMPLETENESS', ...(ctx ? [] : ['UNASSIGNED_OVER_THRESHOLD', 'OVERFLOW'])])

  // Khoá type / status lấy từ ô dữ liệu: chỉ in giá trị dạng mã (chữ hoa / số / gạch dưới); còn lại gộp (file lệch cột có thể
  // đưa email vào cột này — không in ra stdout).
  const code = (v: string) => (/^[A-Z0-9_]{1,30}$/.test(v) ? v : 'KHÁC')
  const typeStatus: Record<string, number> = {}
  for (const l of lines) count(typeStatus, `${code(l.orderType)}/${code(l.orderStatus)}`)
  const win = ctx && isCmsIsoDate(ctx.program.startDate) && isCmsIsoDate(ctx.program.endDate) ? { from: ctx.program.startDate, to: ctx.program.endDate } : null
  const inWin = (l: CmsSalesLine) => !win || (cmsI4VnDate(l.completedAtMicros) >= win.from && cmsI4VnDate(l.completedAtMicros) <= win.to)
  const dates = lines.map((l) => cmsI4VnDate(l.completedAtMicros)).sort()
  return {
    engine,
    check: {
      scope: ctx ? 'program' : 'contract',
      rowsRead: rows.length,
      valid: lines.length,
      invalid: rows.length - lines.length,
      issues,
      duplicateLineIds: findDuplicates(lineIds).length,
      exponentLike,
      nonCanonicalProductId,
      sqlDroppedNonCanonical: engine ? sqlDropped : null,
      negative: lines.filter((l) => l.baseQuantityUnits < ZERO || l.gmvUnits < ZERO).length,
      zeroBase: lines.filter((l) => l.baseQuantityUnits === ZERO).length,
      noEmail: lines.filter((l) => l.sellerEmail === null).length,
      typeStatus,
      eligible: lines.filter((l) => isEligibleOrder(l)).length,
      window: win ? { ...win, inWindow: lines.filter(inWin).length, outOfWindow: lines.filter((l) => !inWin(l)).length } : null,
      vnDateRange: dates.length ? { min: dates[0], max: dates[dates.length - 1] } : null,
      candidates: engine ? engine.out.totals.candidates : null,
      unassigned: engine ? { ...engine.out.totals.unassignedByReason } : null,
      readiness,
      hash: cmsI4SalesHash(lines),
    },
  }
}

/** Kiểm file dòng bán. Có `ctx` ⇒ đánh giá đúng như app với chương trình đó (kỳ, SP, mapping, ngưỡng chưa gán, OVERFLOW). */
export function cmsI4CheckSales(rows: readonly CmsRawRow[], ctx?: CmsI4Context): CmsI4SalesCheck {
  return evaluateSales(rows, ctx).check
}

// ── Kiểm Product Master ──────────────────────────────────────────────────────

export interface CmsI4ProductsCheck {
  rowsRead: number
  valid: number
  invalid: number
  issues: Record<string, number>
  duplicateProductIds: number
  active: number
  inactive: number
  imageRejected: number
  /**
   * Như productSync: lỗi dòng ⇒ ROW_ISSUES; ProductID trùng ⇒ DUPLICATE_PRODUCT; 0 dòng ⇒ held (PM chốt EMPTY_SOURCE ngay lần đầu;
   * đã có cache ⇒ EMPTY_AFTER_DATA — cả hai held, offline không biết cache nên ghi EMPTY_SOURCE).
   */
  readiness: CmsI4Readiness
  hash: string
}

export function cmsI4CheckProducts(rows: readonly CmsRawRow[]): CmsI4ProductsCheck {
  const issues: Record<string, number> = {}
  const ok: { productId: string; productName: string; isActive: boolean; imageUrl: string | null; imageRejected: boolean; sourceUpdatedAtMicros: bigint; referencePriceUnits: bigint | null; priceUnit: string | null }[] = []
  for (const r of rows) {
    const n = normalizeProductRow(r)
    if (n.ok) ok.push(n.value)
    else for (const i of n.issues) count(issues, issueKey(i))
  }
  const dup = findDuplicates(ok.map((p) => p.productId)).length
  const held: CmsI4HeldReason[] = []
  if (ok.length !== rows.length) held.push('ROW_ISSUES')
  if (dup > 0) held.push('DUPLICATE_PRODUCT')
  if (rows.length === 0) held.push('EMPTY_SOURCE')
  return {
    rowsRead: rows.length,
    valid: ok.length,
    invalid: rows.length - ok.length,
    issues,
    duplicateProductIds: dup,
    active: ok.filter((p) => p.isActive).length,
    inactive: ok.filter((p) => !p.isActive).length,
    imageRejected: ok.filter((p) => p.imageRejected).length,
    readiness: cmsI4Readiness(held, [], [], ['INCOMPLETE_PAGES']),
    hash: sha(ok.map((p) => [p.productId, p.productName, p.isActive, p.imageUrl ?? '', p.sourceUpdatedAtMicros, p.referencePriceUnits ?? '', p.priceUnit ?? ''].join('\u001f')).sort().join('\n')),
  }
}

// ── N4a — kiểm dữ liệu THÔ (không kết luận tiền) ─────────────────────────────

export type CmsI4Case = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i'
export const CMS_I4_CASES: Record<CmsI4Case, string> = {
  a: 'Bán nguyên đơn vị CMS (lượng cơ sở chia hết K)',
  b: 'Bán lẻ đơn vị cơ sở (lượng cơ sở không chia hết K)',
  c: 'quantity ≥ 2 của đơn vị không phải cơ sở — base_quantity phải là TỔNG cả dòng (công cụ chỉ nhận diện ỨNG VIÊN: quantity ≥ 2 và ≠ base_quantity; BI xác nhận)',
  d: 'Một đơn nhiều dòng',
  e: 'Đơn có giảm giá dòng / voucher — GMV = item.amount (operator đối chiếu tay với nguồn)',
  f: 'Hoàn tất gần nửa đêm VN (16:30–17:30 UTC) — đúng ngày VN',
  g: 'Tài khoản QLCH dùng chung (⇒ Chưa gán) + dược sĩ có tài khoản',
  h: 'Đơn ONLINE hoặc không COMPLETED (⇒ loại)',
  i: 'Dòng âm / trả hàng — chỉ xem nguồn thể hiện thế nào (Q-206)',
}

export interface CmsI4N4aRow {
  orderCode: string
  orderLineId: string
  productId: string
  completedAtUtc: string
  vnDate: string
  sellerMasked: string
  mapping: string
  orderType: string
  orderStatus: string
  quantityRaw: string
  uomRaw: string
  baseQuantity: string
  gmvAmount: string
  cases: CmsI4Case[]
  issues: string[]
}

/** UTC 16:30:00 ≤ giờ ≤ 17:30:00 (VN 23:30 – 00:30, gồm hai mốc). */
const nearVnMidnight = (micros: bigint) => {
  const secOfDay = Number((micros / B(1_000_000)) % B(86_400))
  return secOfDay >= 16 * 3600 + 1800 && secOfDay <= 17 * 3600 + 1800
}

/**
 * Ô hiển thị trong bảng N4a: giá trị THÔ của file có thể lệch cột (email rơi vào cột khác) ⇒ ô có '@' thành '***', cắt 40 ký tự,
 * bỏ ký tự điều khiển và '|' (không vỡ bảng markdown).
 */
export function cmsI4Cell(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—'
  // eslint-disable-next-line no-control-regex
  const t = String(v).replace(/[\u0000-\u001F\u007F-\u009F|]/g, ' ').trim()
  if (t === '') return '—'
  if (t.includes('@')) return '***'
  return t.length > 40 ? `${t.slice(0, 40)}…` : t
}

export function cmsI4N4a(rows: readonly CmsRawRow[], o: { sellers?: CmsSellerIndex; program?: CmsEngineProgram } = {}): { rows: CmsI4N4aRow[]; coverage: Record<CmsI4Case, number | null> } {
  const perOrder = new Map<string, number>()
  for (const r of rows) if (typeof r.order_id === 'string') perOrder.set(r.order_id.trim(), (perOrder.get(r.order_id.trim()) ?? 0) + 1)
  const out: CmsI4N4aRow[] = []
  for (const r of rows) {
    const n = normalizeSalesRow(r)
    const cases = new Set<CmsI4Case>()
    if (!n.ok) {
      const c = cmsI4Cell
      out.push({ orderCode: c(r.order_code), orderLineId: c(r.order_line_id), productId: c(r.product_id), completedAtUtc: c(r.completed_at),
        vnDate: '—', sellerMasked: maskCmsEmail(r.seller_email ?? null), mapping: '—', orderType: c(r.order_type), orderStatus: c(r.order_status),
        quantityRaw: c(r.quantity_raw), uomRaw: c(r.uom_raw), baseQuantity: c(r.base_quantity), gmvAmount: c(r.gmv_amount),
        cases: [], issues: n.issues.map(issueKey) })
      continue
    }
    const l = n.value
    const prod = o.program?.products.get(l.productId)
    if (prod && l.baseQuantityUnits > ZERO) cases.add(l.baseQuantityUnits % prod.perUnitUnits === ZERO ? 'a' : 'b')
    const q = l.quantityRaw ? parseCmsDecimal(l.quantityRaw) : null
    if (q && q.ok && q.units >= B(2) * CMS_DEC_FACTOR && l.baseQuantityUnits !== q.units) cases.add('c')
    if ((perOrder.get(l.orderId) ?? 0) >= 2) cases.add('d')
    if (nearVnMidnight(l.completedAtMicros)) cases.add('f')
    const m = o.sellers ? mapSeller(l.sellerEmail, o.sellers) : null
    if (m && !m.ok && m.reason === 'SHARED_ACCOUNT') cases.add('g')
    if (!isEligibleOrder(l)) cases.add('h')
    if (l.baseQuantityUnits < ZERO || l.gmvUnits < ZERO) cases.add('i')
    // I4-F2: ProductID sai dạng chuẩn ⇒ SQL production lọc mất dòng này ⇒ hiện giá trị THÔ (có ngoặc kép) + mã lỗi hợp đồng.
    const nonCanon = isNonCanonicalId(r.product_id)
    out.push({
      orderCode: cmsI4Cell(l.orderCode), orderLineId: cmsI4Cell(l.orderLineId), productId: nonCanon ? rawIdCell(r.product_id as string) : l.productId,
      completedAtUtc: formatUtcMicros(l.completedAtMicros),
      vnDate: cmsI4VnDate(l.completedAtMicros), sellerMasked: maskCmsEmail(l.sellerEmail),
      mapping: m === null ? '—' : m.ok ? 'staff' : m.reason,
      orderType: cmsI4Cell(l.orderType), orderStatus: cmsI4Cell(l.orderStatus), quantityRaw: cmsI4Cell(l.quantityRaw), uomRaw: cmsI4Cell(l.uomRaw),
      baseQuantity: formatCmsDecimal(l.baseQuantityUnits), gmvAmount: formatCmsDecimal(l.gmvUnits), cases: [...cases].sort(),
      issues: nonCanon ? ['NON_CANONICAL_PRODUCT_ID'] : [],
    })
  }
  const has = (c: CmsI4Case) => out.filter((r) => r.cases.includes(c)).length
  const gStaff = out.some((r) => r.mapping === 'staff'), gShared = out.some((r) => r.mapping === 'SHARED_ACCOUNT')
  return {
    rows: out,
    coverage: {
      a: o.program ? has('a') : null, b: o.program ? has('b') : null, c: has('c'), d: has('d'),
      e: null, // không suy được từ 14 cột — operator đối chiếu tay
      f: has('f'), g: o.sellers ? (gStaff && gShared ? has('g') : 0) : null, h: has('h'), i: has('i'),
    },
  }
}

// ── N4b — đối soát tiền cả kỳ ────────────────────────────────────────────────

export interface CmsI4Pair {
  userId: string
  sellerMasked: string
  productId: string
  gmvBasis: 'product' | 'catalog' | 'none'
  lines: number
  baseQuantity: string
  k: string
  q: bigint
  rewarded: bigint
  cap: bigint | null
  gmv: string
  gateGmv: string | null
  target: bigint | null
  met: boolean
  metAtUtc: string | null
  potential: bigint
  amount: bigint
}

/**
 * Oracle ĐỘC LẬP (không gọi compute.ts / mapping.ts / time.ts): lọc OFFLINE + COMPLETED, ngày VN trong kỳ (tự tính UTC+7), SP thuộc
 * chương trình, email trim + chữ thường khớp ĐÚNG MỘT tài khoản staff có nhà thuốc OS đang hoạt động thuộc chương trình; cộng B
 * và GMV theo dược sĩ × SP; Q = floor(max(0, B) / K); gate theo GMV cuối kỳ (danh mục = Σ GMV các SP danh mục của dược sĩ);
 * tiền = Σ mức bậc chứa TỪNG đơn vị 1…min(Q, trần) khi gate đạt.
 */
export function cmsI4Oracle(p: CmsEngineProgram, lines: readonly CmsSalesLine[], users: readonly CmsUserRef[], stores: readonly CmsStoreRef[], startDate: string, endDate: string) {
  const byEmail = new Map<string, CmsUserRef[]>()
  for (const u of users) {
    const e = u.email === null ? null : u.email.trim().toLowerCase()
    if (!e) continue
    byEmail.set(e, [...(byEmail.get(e) ?? []), u])
  }
  const storeOk = (id: string | null) => {
    const s = stores.find((x) => x.id === id)
    return !!s && s.storeType === 'os' && s.isActive === true && p.storeIds.has(s.id)
  }
  const acc = new Map<string, { userId: string; productId: string; b: bigint; gmv: bigint; n: number }>()
  const catalogGmv = new Map<string, bigint>()
  for (const l of lines) {
    if (!(l.orderType === 'OFFLINE' && l.orderStatus === 'COMPLETED')) continue
    const d = cmsI4VnDate(l.completedAtMicros)
    if (d < startDate || d > endDate) continue
    const prod = p.products.get(l.productId)
    if (!prod) continue
    const hits = l.sellerEmail === null ? [] : byEmail.get(l.sellerEmail.trim().toLowerCase()) ?? []
    if (hits.length !== 1 || hits[0].role !== 'staff' || !storeOk(hits[0].storeId)) continue
    const key = `${hits[0].id}|${l.productId}`
    const a = acc.get(key) ?? { userId: hits[0].id, productId: l.productId, b: ZERO, gmv: ZERO, n: 0 }
    a.b += l.baseQuantityUnits; a.gmv += l.gmvUnits; a.n++
    acc.set(key, a)
    if (prod.gmvBasis === 'catalog') catalogGmv.set(hits[0].id, (catalogGmv.get(hits[0].id) ?? ZERO) + l.gmvUnits)
  }
  const out = new Map<string, { q: bigint; met: boolean; amount: bigint; b: bigint; gmv: bigint; n: number }>()
  for (const [key, a] of acc) {
    const prod = p.products.get(a.productId)!
    const q = a.b > ZERO ? a.b / prod.perUnitUnits : ZERO
    const met = prod.gmvBasis === 'none' ? true
      : prod.gmvBasis === 'product' ? a.gmv >= prod.targetVnd! * CMS_DEC_FACTOR
        : (catalogGmv.get(a.userId) ?? ZERO) >= p.catalogTargetVnd! * CMS_DEC_FACTOR
    // Mỗi bậc [from, to] trả mức của bậc cho số đơn vị của Q rơi vào bậc đó; Q vượt bậc cuối hữu hạn ⇒ phần vượt = 0 (trần).
    // Viết theo đoạn (không lặp từng đơn vị) để Q rất lớn do dữ liệu bẩn không treo công cụ; spec so thêm với oracle từng đơn vị.
    let amount = ZERO
    if (met) {
      for (const t of prod.tiers) {
        const hi = t.to === null ? q : (t.to < q ? t.to : q)
        if (hi >= t.from) amount += (hi - t.from + B(1)) * t.amountVnd
      }
    }
    out.set(key, { q, met, amount, b: a.b, gmv: a.gmv, n: a.n })
  }
  return out
}

export interface CmsI4Expected { email: string; productId: string; cmsVnd: bigint; q: bigint | null; gmvUnits: bigint | null }
export const CMS_I4_EXPECTED_COLUMNS = ['seller_email', 'product_id', 'expected_cms_vnd'] as const
export const CMS_I4_EXPECTED_OPTIONAL = ['expected_q', 'expected_gmv'] as const

/** File số tính tay của BI / operator: seller_email, product_id, expected_cms_vnd [, expected_q, expected_gmv]. */
export function cmsI4ParseExpected(rows: readonly CmsRawRow[]): { ok: true; value: CmsI4Expected[] } | { ok: false; reason: string } {
  const out: CmsI4Expected[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const email = (r.seller_email ?? '').trim().toLowerCase()
    const pidR = canonicalProductId((r.product_id ?? '').trim())
    const pid = pidR.ok ? pidR.id : ''
    const cms = (r.expected_cms_vnd ?? '').trim()
    if (!email || !pidR.ok || !/^\d{1,19}$/.test(cms)) return { ok: false, reason: `dòng kỳ vọng ${i + 2}: cần seller_email, product_id số, expected_cms_vnd số nguyên VND` }
    const q = (r.expected_q ?? '').trim()
    const g = (r.expected_gmv ?? '').trim()
    const gp = g ? parseCmsDecimal(g) : null
    if ((q && !/^\d{1,19}$/.test(q)) || (gp && !gp.ok)) return { ok: false, reason: `dòng kỳ vọng ${i + 2}: expected_q / expected_gmv sai dạng` }
    out.push({ email, productId: pid, cmsVnd: BigInt(cms), q: q ? BigInt(q) : null, gmvUnits: gp && gp.ok ? gp.units : null })
  }
  const keys = out.map((e) => `${e.email}|${e.productId}`)
  if (new Set(keys).size !== keys.length) return { ok: false, reason: 'file kỳ vọng có cặp email × SP trùng' }
  return { ok: true, value: out }
}

export interface CmsI4Mismatch { pair: string; fields: { name: string; expected: string; actual: string }[]; hint: string }

export interface CmsI4Reconcile {
  /**
   * CÙNG kết luận với `cmsI4CheckSales(rows, bối cảnh)` (I4-P1-2). `not_ready` ⇒ bảng / so khớp dưới chỉ để CHẨN ĐOÁN, không phải
   * chứng nhận khớp; CLI rc 1.
   */
  readiness: CmsI4Readiness
  normalize: { rowsRead: number; valid: number; invalid: number; issues: Record<string, number>; duplicateLineIds: number }
  vnDateRange: { min: string; max: string } | null
  totals: { amountVnd: bigint; included: number; excluded: Record<string, number> }
  pairs: CmsI4Pair[]
  /** Engine ≠ oracle độc lập ⇒ lỗi engine HOẶC giả định oracle — luôn phải rỗng. */
  oracleMismatches: CmsI4Mismatch[]
  /**
   * So với số tính tay. `missingInEngine`: engine KHÔNG có cặp nhưng kỳ vọng có chỉ số khác 0 (CMS, Q hoặc GMV) — I4-P1-1.
   * `matchedWithoutPair`: số cặp tính là khớp vì MỌI chỉ số kỳ vọng đã cung cấp = 0 và engine không có dòng nào (đã gồm trong matched).
   */
  expected: { compared: number; matched: number; matchedWithoutPair: number; mismatches: CmsI4Mismatch[]; missingInEngine: CmsI4Mismatch[]; notInExpected: string[] } | null
  warnings: string[]
  inputHash: string
}

const hintFor = (names: string[]) =>
  names.includes('q') ? 'Q lệch — kiểm Σ base_quantity (TỔNG cả dòng, đơn vị cơ sở) và K của chương trình'
    : names.includes('met') || names.includes('gmv') ? 'GMV / gate lệch — kiểm gmv_amount = item.amount (giữ VAT, không phân bổ voucher) và target'
      : names.includes('amount') ? 'Cùng Q và gate nhưng tiền lệch — kiểm bậc lũy tiến / trần'
        : 'lệch khác — đối chiếu từng dòng'

/**
 * N4b: chạy ENGINE candidate (computeCmsProgram — cùng code app) trên mọi dòng cả kỳ BI xuất, so với ORACLE độc lập và (nếu có)
 * số tính tay. Export phải là TOÀN KỲ của các cặp dược sĩ × SP chọn (và mọi SP danh mục của dược sĩ khi có gate danh mục) —
 * công cụ không tự chứng minh được đủ, chỉ cảnh báo. Dòng lỗi ⇒ app thật giữ snapshot cũ cả lượt; đối soát chỉ trên dòng hợp lệ.
 */
export function cmsI4Reconcile(o: { program: CmsEngineProgramInput; users: CmsUserRef[]; stores: CmsStoreRef[]; rows: readonly CmsRawRow[]; expected?: CmsI4Expected[] }): CmsI4Reconcile {
  const parsed = parseCmsEngineProgram(o.program)
  // CÙNG lõi với check-sales ⇒ cùng readiness; bảng tính trên ĐÚNG tập dòng app thật đọc (đã bỏ dòng SQL lọc mất, đã bỏ trùng).
  const ev = evaluateSales(o.rows, { program: o.program, users: o.users, stores: o.stores })
  const { check } = ev
  const { lines: uniq, out, sqlDropped } = ev.engine!
  const warnings: string[] = []
  if (check.readiness.status === 'not_ready') {
    const why = [...check.readiness.held, ...check.readiness.contract, ...check.readiness.noEvidence].join(', ')
    warnings.push(`KHÔNG ĐẠT nghiệm thu (${why}) — app thật không công bố snapshot này / dữ liệu không chứng minh được; bảng và so khớp dưới CHỈ để chẩn đoán, không phải chứng nhận khớp`)
  }
  if (check.invalid) warnings.push(`${check.invalid} dòng không hợp lệ — app thật GIỮ snapshot cũ cả lượt (ROW_ISSUES / UNCONVERTED_UNITS); số dưới đây chỉ trên dòng hợp lệ`)
  if (check.duplicateLineIds) warnings.push(`${check.duplicateLineIds} order_line_id trùng — app thật GIỮ snapshot cũ (DUPLICATE_LINE_ID); đối soát chỉ chạy sau khi bỏ trùng`)
  if (sqlDropped) warnings.push(`${sqlDropped} dòng SP chương trình có product_id sai dạng chuẩn — SQL production lọc theo CHUỖI nên app thật KHÔNG đọc (I4-F2); bảng dưới đã bỏ các dòng này như app`)
  const emailOf = new Map(o.users.map((u) => [u.id, u.email]))
  const pairs: CmsI4Pair[] = out.results.map((r) => ({
    userId: r.userId, sellerMasked: maskCmsEmail(emailOf.get(r.userId) ?? null), productId: r.productId, gmvBasis: r.gmvBasis,
    lines: r.lineCount, baseQuantity: formatCmsDecimal(r.baseQuantityUnits), k: formatCmsDecimal(r.perUnitUnits), q: r.cmsQuantity,
    rewarded: r.rewardedQuantity, cap: r.capQuantity, gmv: formatCmsDecimal(r.gmvUnits),
    gateGmv: r.gate.gateGmvUnits === null ? null : formatCmsDecimal(r.gate.gateGmvUnits), target: r.gate.targetVnd, met: r.gate.met,
    metAtUtc: r.gate.metAtMicros === null ? null : formatUtcMicros(r.gate.metAtMicros), potential: r.potentialAmountVnd, amount: r.amountVnd,
  })).sort((a, b) => (a.sellerMasked + a.userId + a.productId).localeCompare(b.sellerMasked + b.userId + b.productId))

  // Engine ↔ oracle độc lập: mọi cặp phải trùng tập + Q / gate / tiền / B / GMV / số dòng.
  const oracle = cmsI4Oracle(parsed, uniq, o.users, o.stores, o.program.startDate, o.program.endDate)
  const oracleMismatches: CmsI4Mismatch[] = []
  const seen = new Set<string>()
  for (const r of out.results) {
    const key = `${r.userId}|${r.productId}`
    seen.add(key)
    const x = oracle.get(key)
    const label = `${maskCmsEmail(emailOf.get(r.userId) ?? null)}#${cmsI4Pseudo(r.userId)}/${r.productId}`
    if (!x) { oracleMismatches.push({ pair: label, fields: [{ name: 'pair', expected: 'không có ở oracle', actual: 'có ở engine' }], hint: 'lọc / quy người khác nhau' }); continue }
    const f: CmsI4Mismatch['fields'] = []
    if (x.q !== r.cmsQuantity) f.push({ name: 'q', expected: String(x.q), actual: String(r.cmsQuantity) })
    if (x.met !== r.gate.met) f.push({ name: 'met', expected: String(x.met), actual: String(r.gate.met) })
    if (x.amount !== r.amountVnd) f.push({ name: 'amount', expected: String(x.amount), actual: String(r.amountVnd) })
    if (x.b !== r.baseQuantityUnits) f.push({ name: 'base', expected: formatCmsDecimal(x.b), actual: formatCmsDecimal(r.baseQuantityUnits) })
    if (x.gmv !== r.gmvUnits) f.push({ name: 'gmv', expected: formatCmsDecimal(x.gmv), actual: formatCmsDecimal(r.gmvUnits) })
    if (x.n !== r.lineCount) f.push({ name: 'lines', expected: String(x.n), actual: String(r.lineCount) })
    if (f.length) oracleMismatches.push({ pair: label, fields: f, hint: hintFor(f.map((z) => z.name)) })
  }
  for (const key of oracle.keys()) if (!seen.has(key)) oracleMismatches.push({ pair: `${maskCmsEmail(emailOf.get(key.split('|')[0]) ?? null)}#${cmsI4Pseudo(key.split('|')[0])}/${key.split('|')[1]}`, fields: [{ name: 'pair', expected: 'có ở oracle', actual: 'không có ở engine' }], hint: 'lọc / quy người khác nhau' })

  // Ngữ cảnh đủ cả kỳ (checklist §2.5): không tự chứng minh được — cảnh báo đúng chỗ cần BI xác nhận.
  const catalogPids = [...parsed.products.values()].filter((p) => p.gmvBasis === 'catalog').map((p) => p.productId)
  const catalogUsers = new Set(out.results.filter((r) => r.gmvBasis === 'catalog').map((r) => r.userId))
  for (const u of catalogUsers) {
    const have = new Set(out.results.filter((r) => r.userId === u && r.gmvBasis === 'catalog').map((r) => r.productId))
    const absent = catalogPids.filter((p) => !have.has(p))
    if (absent.length) warnings.push(`gate danh mục của ${maskCmsEmail(emailOf.get(u) ?? null)}#${cmsI4Pseudo(u)}: export không có dòng của ${absent.length} SP danh mục — chỉ đúng nếu dược sĩ thật sự không bán (BI xác nhận export đủ mọi SP danh mục)`)
  }
  const dates = uniq.map((l) => cmsI4VnDate(l.completedAtMicros)).sort()
  const outOfWindow = out.excluded.filter((x) => x.reason === 'OUT_OF_WINDOW').length
  if (outOfWindow) warnings.push(`${outOfWindow} dòng ngoài kỳ (theo ngày VN của completed_at) — không tính`)
  warnings.push(`export chứa dữ liệu từ ${dates[0] ?? '—'} tới ${dates[dates.length - 1] ?? '—'} (ngày VN); kỳ ${o.program.startDate} → ${o.program.endDate} — đối soát chỉ đúng khi export là TOÀN KỲ của các cặp đã chọn`)

  let expected: CmsI4Reconcile['expected'] = null
  if (o.expected) {
    const byPair = new Map(out.results.map((r) => [`${(emailOf.get(r.userId) ?? '').trim().toLowerCase()}|${r.productId}`, r]))
    const mismatches: CmsI4Mismatch[] = []
    const missingInEngine: CmsI4Mismatch[] = []
    let matched = 0
    let matchedWithoutPair = 0
    for (const e of o.expected) {
      const r = byPair.get(`${e.email}|${e.productId}`)
      const label = `${maskCmsEmail(e.email)}/${e.productId}`
      if (!r) {
        // I4-P1-1: engine không có cặp ⇔ CMS = Q = GMV = 0. Chỉ khớp khi MỌI chỉ số kỳ vọng đã cung cấp đều 0; Q hoặc GMV khác 0 dù
        // CMS = 0 (bán dưới target / dưới K) ⇒ thiếu dữ liệu bán ở engine (export / mapping / phạm vi) — không dựng kết quả 0 để che.
        const none = 'không có cặp (0)'
        const f: CmsI4Mismatch['fields'] = []
        if (e.cmsVnd !== ZERO) f.push({ name: 'amount', expected: String(e.cmsVnd), actual: none })
        if (e.q !== null && e.q !== ZERO) f.push({ name: 'q', expected: String(e.q), actual: none })
        if (e.gmvUnits !== null && e.gmvUnits !== ZERO) f.push({ name: 'gmv', expected: formatCmsDecimal(e.gmvUnits), actual: none })
        if (f.length) missingInEngine.push({ pair: label, fields: f, hint: 'engine không có dòng tính cho cặp này — kiểm export đủ dòng cả kỳ, mapping email ↔ tài khoản staff, phạm vi nhà thuốc / SP' })
        else { matched++; matchedWithoutPair++ }
        continue
      }
      const f: CmsI4Mismatch['fields'] = []
      if (e.cmsVnd !== r.amountVnd) f.push({ name: 'amount', expected: String(e.cmsVnd), actual: String(r.amountVnd) })
      if (e.q !== null && e.q !== r.cmsQuantity) f.push({ name: 'q', expected: String(e.q), actual: String(r.cmsQuantity) })
      if (e.gmvUnits !== null && e.gmvUnits !== r.gmvUnits) f.push({ name: 'gmv', expected: formatCmsDecimal(e.gmvUnits), actual: formatCmsDecimal(r.gmvUnits) })
      if (f.length) mismatches.push({ pair: label, fields: f, hint: hintFor(f.map((z) => z.name)) })
      else matched++
    }
    const expKeys = new Set(o.expected.map((e) => `${e.email}|${e.productId}`))
    const notInExpected = [...byPair.entries()].filter(([k, r]) => !expKeys.has(k) && r.amountVnd > ZERO).map(([, r]) => `${maskCmsEmail(emailOf.get(r.userId) ?? null)}/${r.productId}`)
    if (matchedWithoutPair) warnings.push(`${matchedWithoutPair} cặp kỳ vọng 0 được tính khớp vì engine KHÔNG có dòng nào của cặp — chỉ đúng nếu dược sĩ thật sự không bán SP đó trong kỳ (kiểm mapping email ↔ tài khoản, export đủ dòng)`)
    expected = { compared: o.expected.length, matched, matchedWithoutPair, mismatches, missingInEngine, notInExpected }
  }
  const excluded: Record<string, number> = {}
  for (const x of out.excluded) count(excluded, x.unassignedReason ? `UNASSIGNED:${x.unassignedReason}` : x.reason)
  if (sqlDropped) excluded.SQL_NON_CANONICAL = sqlDropped
  return {
    readiness: check.readiness,
    normalize: { rowsRead: check.rowsRead, valid: check.valid, invalid: check.invalid, issues: check.issues, duplicateLineIds: check.duplicateLineIds },
    vnDateRange: dates.length ? { min: dates[0], max: dates[dates.length - 1] } : null,
    totals: { amountVnd: out.totals.amountVnd, included: out.totals.included, excluded },
    pairs,
    oracleMismatches,
    expected,
    warnings,
    inputHash: sha([cmsI4SalesHash(uniq), JSON.stringify(o.program), o.users.map((u) => `${u.id}|${(u.email ?? '').trim().toLowerCase()}|${u.role}|${u.storeId}`).sort().join(','), o.stores.map((s) => `${s.id}|${s.storeType}|${s.isActive}`).sort().join(',')].join('\n')),
  }
}

export interface CmsI4Context { program: CmsEngineProgramInput; users: CmsUserRef[]; stores: CmsStoreRef[] }

/**
 * Bối cảnh đối soát (JSON NGOÀI Git): cấu hình chương trình đúng như DB (K, bậc, target, phạm vi nhà thuốc đã ghi lúc kích hoạt)
 * + tài khoản (id, email, role, store_id) + nhà thuốc (store_type, is_active) tại MỐC đối soát. Sai dạng ⇒ lý do; cấu hình
 * chương trình được kiểm bằng CHÍNH parseCmsEngineProgram của app.
 */
export function cmsI4ParseContext(json: unknown): { ok: true; value: CmsI4Context } | { ok: false; reason: string } {
  const o = json as Partial<Record<'program' | 'users' | 'stores', unknown>> | null
  if (!o || typeof o !== 'object' || !o.program || !Array.isArray(o.users) || !Array.isArray(o.stores)) return { ok: false, reason: 'context cần { program, users[], stores[] }' }
  const isStrOrNull = (v: unknown) => v === null || typeof v === 'string'
  for (const [i, u] of (o.users as unknown[]).entries()) {
    const x = u as Record<string, unknown>
    if (!x || typeof x.id !== 'string' || !isStrOrNull(x.email) || !isStrOrNull(x.role) || !isStrOrNull(x.storeId)) return { ok: false, reason: `users[${i}] cần id, email, role, storeId` }
  }
  for (const [i, s] of (o.stores as unknown[]).entries()) {
    const x = s as Record<string, unknown>
    if (!x || typeof x.id !== 'string' || !isStrOrNull(x.storeType) || !(x.isActive === null || typeof x.isActive === 'boolean')) return { ok: false, reason: `stores[${i}] cần id, storeType, isActive` }
  }
  const ids = (o.users as CmsUserRef[]).map((u) => u.id)
  if (new Set(ids).size !== ids.length) return { ok: false, reason: 'users có id trùng' }
  try { parseCmsEngineProgram(o.program as CmsEngineProgramInput) } catch (e) { return { ok: false, reason: `program: ${e instanceof Error ? e.message : String(e)}` } }
  return { ok: true, value: { program: o.program as CmsEngineProgramInput, users: o.users as CmsUserRef[], stores: o.stores as CmsStoreRef[] } }
}

export const cmsI4Sellers = (c: CmsI4Context) => buildSellerIndex(c.users, c.stores)
export const cmsI4Program = (c: CmsI4Context) => parseCmsEngineProgram(c.program)

/** Bảng N4a (markdown, email che) — đầu ra ghi NGOÀI Git; cột "Khớp" để operator / BI điền sau khi đối chiếu nguồn. */
export function cmsI4N4aMarkdown(r: ReturnType<typeof cmsI4N4a>): string {
  const head = '| Ca | order_code | order_line_id | product_id | completed_at (UTC) → ngày VN | Người bán (che) → mapping | type / status | quantity_raw · uom_raw | base_quantity | gmv_amount | Lỗi dòng | Khớp (điền tay) |\n|---|---|---|---|---|---|---|---|---|---|---|---|'
  const body = r.rows.map((x) => `| ${x.cases.join(',') || '—'} | ${x.orderCode} | ${x.orderLineId} | ${x.productId} | ${x.completedAtUtc} → ${x.vnDate} | ${x.sellerMasked} → ${x.mapping} | ${x.orderType} / ${x.orderStatus} | ${x.quantityRaw} · ${x.uomRaw} | ${x.baseQuantity} | ${x.gmvAmount} | ${x.issues.join(', ') || '—'} |  |`)
  const cov = (Object.keys(CMS_I4_CASES) as CmsI4Case[]).map((c) => `| ${c} | ${CMS_I4_CASES[c]} | ${r.coverage[c] === null ? 'CHƯA KIỂM — đối chiếu tay' : r.coverage[c] === 0 ? '**THIẾU**' : c === 'c' ? `${r.coverage[c]} dòng ứng viên — cần BI xác nhận tổng dòng` : `${r.coverage[c]} dòng`} |`)
  return [head, ...body, '', '| Ca | Cần chứng minh | Độ phủ |', '|---|---|---|', ...cov].join('\n')
}

/** Bảng N4b (markdown, email che) — đầu ra ghi NGOÀI Git. */
export function cmsI4N4bMarkdown(r: CmsI4Reconcile): string {
  const head = '| Dược sĩ (che) | SP | Số dòng | Σ base_quantity | K | Q | Hưởng (trần) | GMV | Gate GMV / target | Đạt từ (UTC) | CMS engine |\n|---|---|---|---|---|---|---|---|---|---|---|'
  const body = r.pairs.map((p) => `| ${p.sellerMasked}#${cmsI4Pseudo(p.userId)} | ${p.productId} | ${p.lines} | ${p.baseQuantity} | ${p.k} | ${p.q} | ${p.rewarded}${p.cap === null ? '' : ` / ${p.cap}`} | ${p.gmv} | ${p.target === null ? 'không gate' : `${p.gateGmv} / ${p.target} ${p.met ? 'đạt' : 'chưa đạt'}`} | ${p.metAtUtc ?? '—'} | ${p.amount} |`)
  return [head, ...body].join('\n')
}

/**
 * SQL BI dùng để XUẤT file cho N4a / N4b: CÙNG danh sách cột + ép kiểu của câu app chạy (buildCmsSalesQuery — dòng SELECT lấy
 * nguyên văn), chỉ đổi điều kiện lọc. Kết quả lưu CSV UTF-8 có header NGOÀI Git. Tên view là chỗ trống BI tự điền.
 *   n4a: các đơn operator chọn (6–10 order_code), KHÔNG lọc kỳ / SP để thấy cả dòng bị loại;
 *   n4b: toàn kỳ, MỌI ProductID của chương trình (gate danh mục cần đủ SP danh mục), email các dược sĩ chọn.
 * WHERE lọc trên view ⇒ dùng tên cột VẬT LÝ (`employee_email` — PM 04/11), SELECT đã đổi tên ⇒ file xuất vẫn header chuẩn `seller_email`.
 * Email đi bằng tham số `@seller_emails` (trim + chữ thường như app), không nhúng vào SQL.
 *   products: NGUYÊN dòng SELECT của buildCmsProductsQuery — view vật lý 6 cột, file chuẩn 7 cột (`is_active` là hằng
 *   `CAST(TRUE AS STRING)` do app tạo — PM 04/11 `2026-11-04-cms-bi-product-master-pm.md` §2.3), không LIMIT.
 *   scope (I4-FINAL `compare-source`, phía `bi_view`): NGUYÊN SELECT + WHERE kỳ / SP của câu app chạy, KHÔNG lọc email / trạng thái /
 *   loại đơn, không LIMIT — đúng tập adapter đọc cho chương trình. Không phải export của run đã công bố (`published_run`).
 */
export function cmsI4ExportSql(kind: 'n4a' | 'n4b' | 'products' | 'scope', table = kind === 'products' ? 'bi-project.buymed_tech.CMS_PRODUCTS_VIEW' : 'bi-project.buymed_tech.CMS_SALES_VIEW'): string {
  if (kind === 'products') return [...buildCmsProductsQuery(table).sql.split('\n').slice(0, 2), 'ORDER BY product_id'].join('\n')
  const app = buildCmsSalesQuery({ table, fromMicros: B(1), toMicrosExclusive: B(2), productIds: ['1'] }).sql.split('\n')
  const scope = ['WHERE completed_at >= @from_ts AND completed_at < @to_ts', '  AND CAST(product_id AS STRING) IN UNNEST(@product_ids)']
  const where = kind === 'n4a'
    ? ['WHERE CAST(order_code AS STRING) IN UNNEST(@order_codes)']
    : kind === 'scope' ? scope : [...scope, `  AND LOWER(TRIM(${cmsSalesSourceColumn('seller_email')})) IN UNNEST(@seller_emails)`]
  return [app[0], app[1], ...where, 'ORDER BY completed_at, order_line_id'].join('\n')
}

export { CMS_PRODUCT_COLUMNS, CMS_SALES_COLUMNS }
