// CMS I4-FINAL — so HAI tập dòng bán độc lập theo order_line_id (PM work order `planning/research/cms-i4-final-work-order-2026-11-04.md`
// §3; review `planning/reviews/2026-11-04-cms-dee938a-i4-final-pm.md` §3). THUẦN, offline: không mạng, không DB, không BigQuery.
// Dùng lại normalizeSalesRow / isEligibleOrder / vnProgramWindowMicros / gate hợp đồng của I4 (cmsI4CheckSales) — không viết lại.
//
// Phạm vi chứng nhận: CHỈ hai file đã cung cấp, tại đúng scope (kỳ VN + toàn bộ ProductID chương trình) và mốc đối soát operator khai
// trong metadata. KHÔNG chứng minh: lịch sử nguồn (mốc M là tuyên bố của operator), run DB hiện hành đã dùng đúng tập này
// (`bi_view` ≠ `published_run`; chưa có binding DB — thiết kế completeness chưa GO), trang BigQuery của adapter thật (N1).
// Công cụ này KHÔNG được app / cron / action import (spec kiểm).

import crypto from 'node:crypto'
import { CMS_SALES_COLUMNS, isEligibleOrder, normalizeSalesRow, type CmsRawRow, type CmsRowIssue, type CmsSalesLine } from '../lib/cms/source/contract'
import { isCmsIsoDate, parseUtcMicros, vnProgramWindowMicros } from '../lib/cms/time'
import { canonicalProductId } from '../lib/cms/productId'
import { maskCmsEmail } from '../lib/cms/mapping'
import { cmsI4CheckSales, type CmsI4Context } from './cmsI4Offline'

export const CMS_I4_COMPARE_VERSION = 'cms-i4-compare-v1'
/** Phiên bản định dạng vân tay dòng (đổi bất kỳ quy tắc §FP ⇒ tăng version, không đổi nghĩa bản cũ). */
export const CMS_I4_ROWS_FP_VERSION = 'cms-rows-fp-v1'

const sha = (s: string | Uint8Array) => crypto.createHash('sha256').update(s).digest('hex')
const HEX64 = /^[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/

// ── Vân tay chuẩn (FP) ──────────────────────────────────────────────────────
// Mỗi dòng ⇒ JSON array các trường theo THỨ TỰ CỐ ĐỊNH, giá trị là chuỗi hoặc null (JSON.stringify của mảng chuỗi / null là
// tất định và không va chạm phân cách: chuỗi được escape, không có xuống dòng thô). Số: số nguyên đơn vị scale 9 từ BigInt
// (vd 30 ⇒ "30000000000", 10,5 ⇒ "10500000000") — KHÔNG Number / float, KHÔNG formatCmsDecimal (cắt số 0 cuối). Thời gian: micro
// giây UTC nguyên. Email: trim + chữ thường như app (normalizeSalesRow). Thứ tự dòng: so BYTE UTF-8 của order_line_id, hoà ⇒ so byte
// cả dòng JSON (không localeCompare, không "thứ tự engine"). Văn bản băm = `${version}\n${tên trường,…}\n` + mỗi dòng JSON + "\n",
// mã hoá UTF-8, sha256 hex.

/** Trường QUYẾT ĐỊNH (phép so của lệnh dùng đúng tập này). */
export const CMS_I4_DECISION_FIELDS = [
  'order_line_id', 'order_id', 'order_code', 'product_id', 'seller_email', 'order_type', 'order_status', 'completed_at_us',
  'base_quantity_e9', 'gmv_amount_e9',
] as const
/** Trường CHỈ ĐỂ AUDIT (khác nhau không làm lệch — vd source_updated_at là mốc nạp, có thể khác giữa hai lần xuất). */
export const CMS_I4_INFO_FIELDS = ['pos_code', 'quantity_raw', 'uom_raw', 'source_updated_at_us'] as const
export type CmsI4FpField = (typeof CMS_I4_DECISION_FIELDS)[number] | (typeof CMS_I4_INFO_FIELDS)[number]

/** Giá trị chuẩn của một trường (chuỗi / null). `num` tiêm được để test đột biến (làm tròn) — mặc định số nguyên scale 9. */
export function cmsI4FpValue(l: CmsSalesLine, f: CmsI4FpField, num: (u: bigint) => string = (u) => u.toString()): string | null {
  switch (f) {
    case 'order_line_id': return l.orderLineId
    case 'order_id': return l.orderId
    case 'order_code': return l.orderCode
    case 'product_id': return l.productId
    case 'seller_email': return l.sellerEmail
    case 'order_type': return l.orderType
    case 'order_status': return l.orderStatus
    case 'completed_at_us': return l.completedAtMicros.toString()
    case 'base_quantity_e9': return num(l.baseQuantityUnits)
    case 'gmv_amount_e9': return num(l.gmvUnits)
    case 'pos_code': return l.posCode
    case 'quantity_raw': return l.quantityRaw
    case 'uom_raw': return l.uomRaw
    case 'source_updated_at_us': return l.sourceUpdatedAtMicros.toString()
  }
}

const byteCmp = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))

/** Văn bản chuẩn (để test vector byte) của tập dòng theo bộ trường. `num` chỉ đổi trong test đột biến. */
export function cmsI4RowsFpText(lines: readonly CmsSalesLine[], fields: readonly CmsI4FpField[], num: (u: bigint) => string = (u) => u.toString()): string {
  const rows = lines.map((l) => ({ id: l.orderLineId, json: JSON.stringify(fields.map((f) => cmsI4FpValue(l, f, num))) }))
  rows.sort((a, b) => byteCmp(a.id, b.id) || byteCmp(a.json, b.json))
  return `${CMS_I4_ROWS_FP_VERSION}\n${fields.join(',')}\n${rows.map((r) => `${r.json}\n`).join('')}`
}
/** Vân tay sha256 (hex) của văn bản chuẩn, mã hoá UTF-8. */
export const cmsI4RowsFp = (lines: readonly CmsSalesLine[], fields: readonly CmsI4FpField[], num?: (u: bigint) => string) =>
  sha(Buffer.from(cmsI4RowsFpText(lines, fields, num), 'utf8'))
export const CMS_I4_FULL_FIELDS: readonly CmsI4FpField[] = [...CMS_I4_DECISION_FIELDS, ...CMS_I4_INFO_FIELDS]

/** Vân tay phạm vi: version + kỳ VN + ProductID canonical đã sắp (byte). */
export function cmsI4ScopeHash(s: { startDate: string; endDate: string; productIds: readonly string[] }): string {
  const ids = [...new Set(s.productIds)].sort(byteCmp)
  return sha(Buffer.from(JSON.stringify([CMS_I4_ROWS_FP_VERSION, 'scope', s.startDate, s.endDate, ids]), 'utf8'))
}

// ── Metadata bằng chứng ─────────────────────────────────────────────────────

export type CmsI4InputKind = 'reference_source' | 'bi_view' | 'published_run'
export interface CmsI4EvidenceSide {
  inputKind: CmsI4InputKind
  /** Nhãn nguồn / người xuất (không PII khách). */
  source: string
  /** Thời điểm chạy lệnh xuất (UTC ISO). */
  exportedAt: string
  /** Mốc đối soát M operator khai (UTC ISO) — tuyên bố, công cụ không xác minh lịch sử nguồn. */
  asOf: string
  fileSha256: string
  scope: { startDate: string; endDate: string; productIds: string[] }
  /** Chỉ `published_run`: run_id khai báo (chưa có binding DB ⇒ luôn "chưa xác minh"). */
  runId?: string | null
}
export interface CmsI4EvidenceMeta { version: 1; reference: CmsI4EvidenceSide; app: CmsI4EvidenceSide }

/** Kiểm DẠNG metadata (sai dạng ⇒ lỗi tham số rc 2). Nhất quán scope / mốc / hash so với dữ liệu kiểm ở cmsI4CompareSource. */
export function cmsI4ParseEvidenceMeta(json: unknown): { ok: true; value: CmsI4EvidenceMeta } | { ok: false; reason: string } {
  const o = json as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, reason: 'metadata phải là object JSON' }
  if (o.version !== 1) return { ok: false, reason: 'version phải = 1' }
  const side = (name: 'reference' | 'app'): CmsI4EvidenceSide | string => {
    const s = o[name] as Record<string, unknown> | null
    if (!s || typeof s !== 'object') return `${name}: thiếu`
    const kinds: CmsI4InputKind[] = name === 'reference' ? ['reference_source'] : ['bi_view', 'published_run']
    if (!kinds.includes(s.inputKind as CmsI4InputKind)) return `${name}.inputKind phải là ${kinds.join(' | ')}`
    if (typeof s.source !== 'string' || s.source.trim().length < 3 || s.source.length > 200) return `${name}.source: chuỗi 3–200 ký tự`
    for (const k of ['exportedAt', 'asOf'] as const) {
      if (typeof s[k] !== 'string' || !ISO_UTC_RE.test(s[k] as string) || parseUtcMicros(s[k] as string) === null) return `${name}.${k}: ISO UTC dạng YYYY-MM-DDTHH:MM:SS[.ffffff]Z`
    }
    if (typeof s.fileSha256 !== 'string' || !HEX64.test(s.fileSha256)) return `${name}.fileSha256: 64 hex thường`
    const sc = s.scope as Record<string, unknown> | null
    if (!sc || typeof sc !== 'object' || !isCmsIsoDate(sc.startDate as string) || !isCmsIsoDate(sc.endDate as string)
      || !Array.isArray(sc.productIds) || sc.productIds.length === 0 || !sc.productIds.every((p) => typeof p === 'string' && canonicalProductId(p).ok)) {
      return `${name}.scope: { startDate, endDate (YYYY-MM-DD), productIds (≥ 1 ProductID) }`
    }
    if (s.inputKind === 'published_run') {
      if (typeof s.runId !== 'string' || !UUID_RE.test(s.runId)) return `${name}.runId: UUID bắt buộc với published_run`
    } else if (s.runId !== undefined && s.runId !== null) return `${name}.runId: chỉ dùng với published_run`
    return {
      inputKind: s.inputKind as CmsI4InputKind, source: s.source.trim(), exportedAt: s.exportedAt as string, asOf: s.asOf as string,
      fileSha256: s.fileSha256, scope: { startDate: sc.startDate as string, endDate: sc.endDate as string, productIds: (sc.productIds as string[]).map((p) => (canonicalProductId(p) as { id: string }).id) },
      runId: (s.runId as string | null | undefined) ?? null,
    }
  }
  const ref = side('reference')
  if (typeof ref === 'string') return { ok: false, reason: ref }
  const app = side('app')
  if (typeof app === 'string') return { ok: false, reason: app }
  return { ok: true, value: { version: 1, reference: ref, app } }
}

// ── Bước so (tiêm được để test đột biến — mặc định là bản thật) ─────────────

export interface CmsI4CompareSteps {
  /** Tập dòng đem so trong scope — bản thật: MỌI trạng thái / loại đơn (không lọc ứng viên trước khi so). */
  select(inScope: readonly CmsSalesLine[]): CmsSalesLine[]
  /** Lập chỉ mục theo order_line_id — bản thật: ID trùng bị loại khỏi so và báo lỗi (không DISTINCT). */
  index(lines: readonly CmsSalesLine[]): { byId: Map<string, CmsSalesLine>; dupIds: string[] }
  /** Anti-join hai chiều theo order_line_id. */
  antiJoin(ref: ReadonlyMap<string, CmsSalesLine>, app: ReadonlyMap<string, CmsSalesLine>): { missing: string[]; extra: string[] }
  /** Tên trường QUYẾT ĐỊNH khác nhau giữa hai dòng cùng ID. */
  diff(a: CmsSalesLine, b: CmsSalesLine): string[]
  /** Biểu diễn số trong so / vân tay. */
  num(units: bigint): string
}
export const CMS_I4_COMPARE_STEPS: CmsI4CompareSteps = {
  select: (inScope) => [...inScope],
  index(lines) {
    const byId = new Map<string, CmsSalesLine>()
    const dup = new Set<string>()
    for (const l of lines) { if (byId.has(l.orderLineId)) dup.add(l.orderLineId); else byId.set(l.orderLineId, l) }
    for (const d of dup) byId.delete(d)
    return { byId, dupIds: [...dup].sort(byteCmp) }
  },
  antiJoin(ref, app) {
    return { missing: [...ref.keys()].filter((k) => !app.has(k)).sort(byteCmp), extra: [...app.keys()].filter((k) => !ref.has(k)).sort(byteCmp) }
  },
  diff(a, b) {
    return CMS_I4_DECISION_FIELDS.filter((f) => cmsI4FpValue(a, f) !== cmsI4FpValue(b, f))
  },
  num: (u) => u.toString(),
}

// ── So ──────────────────────────────────────────────────────────────────────

export interface CmsI4SideSummary {
  inputKind: CmsI4InputKind | null
  fileSha256: string | null
  rowsRead: number
  rowIssues: number
  issues: Record<string, number>
  duplicateLineIds: number
  nonCanonicalProductId: number
  /** Dòng hợp lệ nằm NGOÀI kỳ / SP chương trình (đếm, không so). */
  outOfScope: number
  inScope: number
  /** Ứng viên OFFLINE + COMPLETED trong scope (tập con — so đã gồm mọi trạng thái). */
  candidates: number
  /**
   * Dòng hợp lệ TRONG scope có completed_at SAU mốc M (`asOf`) / SAU thời điểm xuất (`exportedAt`) đã khai — metadata tự mâu thuẫn
   * với chính dữ liệu (PM I4F-P1-1). null khi không có metadata. Không loại / kẹp dòng để làm xanh.
   */
  afterAsOf: number | null
  afterExportedAt: number | null
  rowsFp: string
  decisionFp: string
}
export interface CmsI4Totals { lines: number; baseUnits: string; gmvUnits: string }
export interface CmsI4CompareResult {
  version: string
  fpVersion: string
  verdict: 'MATCH' | 'MISMATCH' | 'NOT_PROVEN'
  /** Lỗi dữ liệu (⇒ MISMATCH). */
  dataIssues: string[]
  /** Chưa chứng minh được trong phạm vi lệnh (⇒ NOT_PROVEN nếu không có lỗi dữ liệu). */
  notProven: string[]
  /** Giới hạn LUÔN đúng của công cụ — không chặn rc 0, không được ghi là đã chứng minh. */
  limits: string[]
  scope: { startDate: string; endDate: string; products: number; scopeHash: string }
  asOf: string | null
  reference: CmsI4SideSummary
  app: CmsI4SideSummary
  compare: { matched: number; missing: number; extra: number; changed: number; changedByField: Record<string, number>; infoDiffByField: Record<string, number> }
  totals: {
    all: { reference: CmsI4Totals; app: CmsI4Totals; equal: boolean }
    candidates: { reference: CmsI4Totals; app: CmsI4Totals; equal: boolean }
    byProduct: { productId: string; reference: CmsI4Totals; app: CmsI4Totals; equal: boolean }[]
  }
  runBinding: { claimedRunId: string | null; verifiedAgainstDb: false }
  /** Chi tiết cho file --out (ngoài Git) — KHÔNG in stdout. Email đã che. */
  details: { missing: string[]; extra: string[]; changed: { orderLineId: string; fields: string[] }[]; duplicates: { side: 'reference' | 'app'; orderLineId: string }[] }
}

export interface CmsI4CompareInput {
  context: CmsI4Context
  reference: { rows: readonly CmsRawRow[]; fileSha256?: string | null }
  app: { rows: readonly CmsRawRow[]; fileSha256?: string | null }
  meta?: CmsI4EvidenceMeta | null
}

const sum = (ls: readonly CmsSalesLine[]): CmsI4Totals => ({
  lines: ls.length,
  baseUnits: ls.reduce((a, l) => a + l.baseQuantityUnits, BigInt(0)).toString(),
  gmvUnits: ls.reduce((a, l) => a + l.gmvUnits, BigInt(0)).toString(),
})
const eqT = (a: CmsI4Totals, b: CmsI4Totals) => a.lines === b.lines && a.baseUnits === b.baseUnits && a.gmvUnits === b.gmvUnits

interface Prepared { summary: CmsI4SideSummary; byId: Map<string, CmsSalesLine>; inScope: CmsSalesLine[]; dupIds: string[]; dataIssues: string[] }

function prepare(name: 'reference' | 'app', rows: readonly CmsRawRow[], fileSha: string | null, kind: CmsI4InputKind | null,
  win: { fromMicros: bigint; toMicrosExclusive: bigint }, products: ReadonlySet<string>, steps: CmsI4CompareSteps): Prepared {
  // Gate hợp đồng I4 (ROW_ISSUES, DUPLICATE_LINE_ID, ProductID không canonical …) — cùng kết luận với check-sales, không tự nới.
  const check = cmsI4CheckSales(rows)
  const lines: CmsSalesLine[] = []
  const issues: Record<string, number> = {}
  for (const r of rows) {
    const n = normalizeSalesRow(r)
    if (n.ok) lines.push(n.value)
    else for (const i of n.issues as CmsRowIssue[]) issues[`${i.kind}:${i.field}`] = (issues[`${i.kind}:${i.field}`] ?? 0) + 1
  }
  const inScope = steps.select(lines.filter((l) => l.completedAtMicros >= win.fromMicros && l.completedAtMicros < win.toMicrosExclusive && products.has(l.productId)))
  // ID trùng KHÔNG được so (không DISTINCT để xanh) — báo lỗi riêng.
  const { byId, dupIds } = steps.index(inScope)
  const dataIssues: string[] = []
  // MỌI lý do held của gate I4 (quality.ts: ROW_ISSUES, DUPLICATE_LINE_ID, UNCONVERTED_UNITS, OVER_CAP …) là lỗi dữ liệu của bên đó.
  // Không có context ⇒ cmsI4CheckSales không đánh giá mapping / ngưỡng chưa gán / OVERFLOW (thuộc reconcile N4b, không thuộc so nguồn).
  const held = [...check.readiness.held]
  for (const h of held) dataIssues.push(`${h}:${name}`)
  if (dupIds.length && !held.includes('DUPLICATE_LINE_ID')) dataIssues.push(`DUPLICATE_LINE_ID:${name}`)
  for (const c of check.readiness.contract) dataIssues.push(`${c}:${name}`)
  return {
    byId, inScope, dupIds, dataIssues,
    summary: {
      inputKind: kind, fileSha256: fileSha, rowsRead: rows.length, rowIssues: rows.length - lines.length, issues,
      duplicateLineIds: dupIds.length, nonCanonicalProductId: check.nonCanonicalProductId,
      outOfScope: lines.length - inScope.length, inScope: inScope.length, candidates: inScope.filter((l) => isEligibleOrder(l)).length,
      afterAsOf: null, afterExportedAt: null,
      rowsFp: cmsI4RowsFp(inScope, CMS_I4_FULL_FIELDS, steps.num),
      decisionFp: cmsI4RowsFp(inScope, CMS_I4_DECISION_FIELDS, steps.num),
    },
  }
}

/**
 * So tập tham chiếu (nguồn độc lập) với tập app / view TRONG CÙNG scope chương trình. MATCH chỉ khi: không lỗi dữ liệu (thiếu / thừa
 * / lệch trường quyết định / trùng ID / lỗi dòng / ProductID không canonical ở bất kỳ bên nào), cả hai bên có dòng và có ứng viên,
 * metadata có và nhất quán (scope = context, cùng mốc M, xuất sau M, hash byte khớp).
 */
export function cmsI4CompareSource(input: CmsI4CompareInput, steps: CmsI4CompareSteps = CMS_I4_COMPARE_STEPS): CmsI4CompareResult {
  const p = input.context.program
  const win = vnProgramWindowMicros(p.startDate, p.endDate)
  const productIds = p.products.map((x) => (canonicalProductId(String(x.productId)) as { ok: boolean; id: string }).id)
  const products = new Set(productIds)
  const meta = input.meta ?? null
  const ref = prepare('reference', input.reference.rows, input.reference.fileSha256 ?? null, meta?.reference.inputKind ?? null, win, products, steps)
  const app = prepare('app', input.app.rows, input.app.fileSha256 ?? null, meta?.app.inputKind ?? null, win, products, steps)

  const dataIssues = [...ref.dataIssues, ...app.dataIssues]
  const { missing, extra } = steps.antiJoin(ref.byId, app.byId)
  const changed: { orderLineId: string; fields: string[] }[] = []
  const changedByField: Record<string, number> = {}
  const infoDiffByField: Record<string, number> = {}
  let matched = 0
  for (const [id, a] of ref.byId) {
    const b = app.byId.get(id)
    if (!b) continue
    matched++
    const f = steps.diff(a, b).filter((x) => {
      if (x === 'base_quantity_e9') return steps.num(a.baseQuantityUnits) !== steps.num(b.baseQuantityUnits)
      if (x === 'gmv_amount_e9') return steps.num(a.gmvUnits) !== steps.num(b.gmvUnits)
      return true
    })
    if (f.length) { changed.push({ orderLineId: id, fields: f }); for (const x of f) changedByField[x] = (changedByField[x] ?? 0) + 1 }
    for (const x of CMS_I4_INFO_FIELDS) if (cmsI4FpValue(a, x) !== cmsI4FpValue(b, x)) infoDiffByField[x] = (infoDiffByField[x] ?? 0) + 1
  }
  changed.sort((x, y) => byteCmp(x.orderLineId, y.orderLineId))
  if (missing.length) dataIssues.push('MISSING_LINES')
  if (extra.length) dataIssues.push('EXTRA_LINES')
  if (changed.length) dataIssues.push('CHANGED_LINES')

  // Chưa chứng minh trong phạm vi lệnh.
  const notProven: string[] = []
  if (ref.summary.inScope === 0) notProven.push('EMPTY_REFERENCE')
  if (app.summary.inScope === 0) notProven.push('EMPTY_APP')
  if (ref.summary.candidates === 0 || app.summary.candidates === 0) notProven.push('NO_CANDIDATES')
  const ctxScope = { startDate: p.startDate, endDate: p.endDate, productIds }
  const scopeHash = cmsI4ScopeHash(ctxScope)
  if (!meta) notProven.push('NO_EVIDENCE_META')
  else {
    for (const [name, s, got, side] of [['reference', meta.reference, input.reference.fileSha256, ref], ['app', meta.app, input.app.fileSha256, app]] as const) {
      if (cmsI4ScopeHash(s.scope) !== scopeHash) notProven.push(`SCOPE_MISMATCH:${name}`)
      if (!got || got !== s.fileSha256) notProven.push(`FILE_SHA_MISMATCH:${name}`)
      const asOf = parseUtcMicros(s.asOf)!, exportedAt = parseUtcMicros(s.exportedAt)!
      if (exportedAt < asOf) notProven.push(`EXPORTED_BEFORE_AS_OF:${name}`)
      // PM I4F-P1-1: M là mốc snapshot đối soát. Dòng trong scope hoàn tất SAU M hoặc SAU lúc xuất ⇒ metadata mâu thuẫn với dữ liệu,
      // không được MATCH. So micro giây BigInt: bằng mốc được nhận, vượt 1 µs bị bắt. Không kiểm source_updated_at (có thể là mốc nạp).
      // Dòng ngoài scope không xét ở đây (đếm riêng ở outOfScope). Không chứng nhận đủ TOÀN KỲ khi M trước ngày kết thúc (limits).
      side.summary.afterAsOf = side.inScope.filter((l) => l.completedAtMicros > asOf).length
      side.summary.afterExportedAt = side.inScope.filter((l) => l.completedAtMicros > exportedAt).length
      if (side.summary.afterAsOf) notProven.push(`ROWS_AFTER_AS_OF:${name}`)
      if (side.summary.afterExportedAt) notProven.push(`ROWS_AFTER_EXPORT:${name}`)
    }
    if (parseUtcMicros(meta.reference.asOf) !== parseUtcMicros(meta.app.asOf)) notProven.push('AS_OF_MISMATCH')
  }
  const limits = ['SOURCE_HISTORY_NOT_VERIFIED', 'BIGQUERY_PAGES_NOT_VERIFIED',
    meta?.app.inputKind === 'published_run' ? 'RUN_BINDING_UNVERIFIED' : 'RUN_BINDING_NOT_PROVEN']

  const verdict = dataIssues.length ? 'MISMATCH' : notProven.length ? 'NOT_PROVEN' : 'MATCH'
  const pids = [...new Set([...ref.inScope, ...app.inScope].map((l) => l.productId))].sort(byteCmp)
  const byProduct = pids.map((pid) => {
    const r = sum(ref.inScope.filter((l) => l.productId === pid)), a = sum(app.inScope.filter((l) => l.productId === pid))
    return { productId: pid, reference: r, app: a, equal: eqT(r, a) }
  })
  const allR = sum(ref.inScope), allA = sum(app.inScope)
  const candR = sum(ref.inScope.filter((l) => isEligibleOrder(l))), candA = sum(app.inScope.filter((l) => isEligibleOrder(l)))
  return {
    version: CMS_I4_COMPARE_VERSION, fpVersion: CMS_I4_ROWS_FP_VERSION, verdict, dataIssues, notProven, limits,
    scope: { startDate: p.startDate, endDate: p.endDate, products: products.size, scopeHash },
    asOf: meta ? meta.reference.asOf : null,
    reference: ref.summary, app: app.summary,
    compare: { matched, missing: missing.length, extra: extra.length, changed: changed.length, changedByField, infoDiffByField },
    totals: { all: { reference: allR, app: allA, equal: eqT(allR, allA) }, candidates: { reference: candR, app: candA, equal: eqT(candR, candA) }, byProduct },
    runBinding: { claimedRunId: meta?.app.inputKind === 'published_run' ? meta.app.runId ?? null : null, verifiedAgainstDb: false },
    details: {
      missing, extra, changed,
      duplicates: [...ref.dupIds.map((id) => ({ side: 'reference' as const, orderLineId: id })), ...app.dupIds.map((id) => ({ side: 'app' as const, orderLineId: id }))],
    },
  }
}

/** Bản stdout: bỏ `details` (chỉ số đếm / hash / mã). */
export const cmsI4CompareSummary = (r: CmsI4CompareResult) => { const { details: _d, ...rest } = r; return rest }

/** Báo cáo chi tiết cho --out (ngoài Git). ID dòng / đơn là mã nội bộ; email KHÔNG xuất hiện (chỉ tên trường lệch). */
export function cmsI4CompareMarkdown(r: CmsI4CompareResult, refLines?: ReadonlyMap<string, CmsSalesLine>): string {
  const t = (x: CmsI4Totals) => `${x.lines} dòng · base ${x.baseUnits} · GMV ${x.gmvUnits} (đơn vị scale 9)`
  const head = r.verdict === 'MATCH' ? '**Kết luận: KHỚP trong phạm vi hai file + scope + mốc đã khai.**'
    : r.verdict === 'MISMATCH' ? `**Kết luận: LỆCH DỮ LIỆU — ${r.dataIssues.join(', ')}.**`
      : `**Kết luận: CHƯA CHỨNG MINH — ${r.notProven.join(', ')}.** So kỹ thuật dưới chỉ để chẩn đoán.`
  const seller = (id: string) => maskCmsEmail(refLines?.get(id)?.sellerEmail ?? null)
  return [
    `# Đối soát nguồn độc lập (${r.version}, vân tay ${r.fpVersion})`, '', head,
    ...(r.verdict !== 'MISMATCH' && r.notProven.length ? [] : r.notProven.length ? [`Chưa chứng minh thêm: ${r.notProven.join(', ')}.`] : []),
    `Giới hạn (luôn đúng, không phải "đạt"): ${r.limits.join(', ')}.`, '',
    `Scope: ${r.scope.startDate} → ${r.scope.endDate} (VN), ${r.scope.products} ProductID — scopeHash \`${r.scope.scopeHash}\`; mốc M: ${r.asOf ?? '— (không có metadata)'}`, '',
    '| | Tham chiếu | App / view |', '|---|---|---|',
    `| loại đầu vào | ${r.reference.inputKind ?? '—'} | ${r.app.inputKind ?? '—'} |`,
    `| sha256 file | \`${r.reference.fileSha256 ?? '—'}\` | \`${r.app.fileSha256 ?? '—'}\` |`,
    `| dòng đọc / lỗi dòng / trùng ID | ${r.reference.rowsRead} / ${r.reference.rowIssues} / ${r.reference.duplicateLineIds} | ${r.app.rowsRead} / ${r.app.rowIssues} / ${r.app.duplicateLineIds} |`,
    `| trong scope / ngoài scope / ứng viên | ${r.reference.inScope} / ${r.reference.outOfScope} / ${r.reference.candidates} | ${r.app.inScope} / ${r.app.outOfScope} / ${r.app.candidates} |`,
    `| dòng trong scope sau mốc M / sau lúc xuất | ${r.reference.afterAsOf ?? '—'} / ${r.reference.afterExportedAt ?? '—'} | ${r.app.afterAsOf ?? '—'} / ${r.app.afterExportedAt ?? '—'} |`,
    `| vân tay quyết định | \`${r.reference.decisionFp}\` | \`${r.app.decisionFp}\` |`,
    `| vân tay 14 trường (audit) | \`${r.reference.rowsFp}\` | \`${r.app.rowsFp}\` |`, '',
    `So theo order_line_id: khớp ID ${r.compare.matched} · thiếu ở app ${r.compare.missing} · thừa ở app ${r.compare.extra} · lệch trường quyết định ${r.compare.changed}.`,
    `Lệch theo trường: ${Object.entries(r.compare.changedByField).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}. Khác trường audit (không làm lệch): ${Object.entries(r.compare.infoDiffByField).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}.`, '',
    `Tổng scope — tham chiếu: ${t(r.totals.all.reference)}; app: ${t(r.totals.all.app)}${r.totals.all.equal ? '' : ' **(khác)**'}.`,
    `Tổng ứng viên — tham chiếu: ${t(r.totals.candidates.reference)}; app: ${t(r.totals.candidates.app)}${r.totals.candidates.equal ? '' : ' **(khác)**'}.`,
    'Tổng KHÔNG thay so từng dòng (lệch bù nhau vẫn bị bắt ở trên).', '',
    '## Theo sản phẩm', '| ProductID | Tham chiếu | App / view | Bằng |', '|---|---|---|---|',
    ...r.totals.byProduct.map((x) => `| ${x.productId} | ${t(x.reference)} | ${t(x.app)} | ${x.equal ? 'có' : '**không**'} |`), '',
    '## Thiếu ở app (có ở tham chiếu)', ...(r.details.missing.length ? r.details.missing.map((id) => `- ${id}`) : ['- (không)']), '',
    '## Thừa ở app (không có ở tham chiếu)', ...(r.details.extra.length ? r.details.extra.map((id) => `- ${id}`) : ['- (không)']), '',
    '## Lệch trường quyết định', ...(r.details.changed.length ? r.details.changed.map((c) => `- ${c.orderLineId} (${seller(c.orderLineId)}): ${c.fields.join(', ')}`) : ['- (không)']), '',
    '## Trùng order_line_id', ...(r.details.duplicates.length ? r.details.duplicates.map((d) => `- ${d.side}: ${d.orderLineId}`) : ['- (không)']), '',
    `Run: ${r.runBinding.claimedRunId ? `khai \`${r.runBinding.claimedRunId}\` — CHƯA xác minh với DB` : 'không áp dụng (bi_view không chứng minh run DB đã dùng tập này)'}.`, '',
  ].join('\n')
}

/** Map order_line_id ⇒ dòng chuẩn hoá (cho báo cáo che email). */
export function cmsI4LinesById(rows: readonly CmsRawRow[]): Map<string, CmsSalesLine> {
  const m = new Map<string, CmsSalesLine>()
  for (const r of rows) { const n = normalizeSalesRow(r); if (n.ok && !m.has(n.value.orderLineId)) m.set(n.value.orderLineId, n.value) }
  return m
}

export { CMS_SALES_COLUMNS }
