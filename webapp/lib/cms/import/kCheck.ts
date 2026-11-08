// CMS S2 (PM spec r1 08/11 §5.1) — kiểm K (base_quantity_CMS) của file import so với quy đổi đơn vị THẬT trong dòng bán đang được
// phép đọc. Lõi THUẦN, port logic công cụ offline r1 đã qua PM (`planning/research/dev-tools/cms/cms-k-check.cjs`, 32 selftest):
//  · gộp theo (ProductID, đơn vị chuẩn hoá NFC + trim + lower); cùng khoá mà hệ số khác nhau ⇒ NGUỒN XUNG ĐỘT;
//  · nhóm có dòng không tính được tỷ lệ (quantity rỗng / ≤ 0, base_quantity rỗng / không đọc được), dòng âm, nhiều hệ số ⇒ NGUỒN LỖI
//    (không thành bằng chứng KHỚP); một nhóm bất kỳ của SP có vấn đề ⇒ cả SP NGUỒN (như công cụ r1);
//  · r1 (PM 08/11 audit SIMPLE-P1-1): bằng chứng là CÁC CẶP lượng gốc (q, b) khác nhau + số dòng — KHÔNG dùng tỷ lệ đã chia / làm
//    tròn ở nguồn (hai dòng lệch nhỏ bù nhau từng thành "cùng hệ số" sau làm tròn scale 9). Cùng hệ số ⇔ b_i × q_0 = b_0 × q_i với MỌI
//    cặp; KHỚP ⇔ b_i × 10^9 = K × q_i với MỌI cặp (BigInt, không float / AVG / epsilon); K đề xuất chỉ khi b_0 × 10^9 chia hết q_0;
//  · có viên mà không có hộp ⇒ CHƯA CÓ BẰNG CHỨNG (không K = 1, không kết luận lệch); không suy K từ tên SP.
// Nhánh app (bảng PM §5.1): K trống + bằng chứng duy nhất hợp lệ ⇒ ĐỀ XUẤT (chỉ hiện, admin tự nhập vào file — không tự điền);
// CHƯA CÓ BẰNG CHỨNG / KHÔNG KIỂM ĐƯỢC + K có ⇒ chỉ qua được bằng xác nhận tay của super kèm nguồn căn cứ, gắn đúng SP / đơn vị / K,
// actor lấy từ PHIÊN, thời điểm từ server; LỆCH / NGUỒN XUNG ĐỘT / NGUỒN LỖI ⇒ chặn, xác nhận tay KHÔNG bỏ được.
import { CMS_DEC_FACTOR, cmsNumberToDecimalString, formatCmsDecimal, parseCmsDecimal } from '../decimal'
import { canonicalProductId } from '../productId'
import { cmsNormUnitFull as cmsNormUnit } from '../sourceDiagnostics'
import type { CmsImportRawRow } from './parse'
import type { CmsImportGroupRejected, CmsImportIssue, CmsImportValidation } from './validate'

export type CmsKStatus = 'MATCH' | 'PROPOSED' | 'MISMATCH' | 'SOURCE_CONFLICT' | 'SOURCE_ERROR' | 'NO_EVIDENCE' | 'UNAVAILABLE'

export const CMS_K_STATUS_LABEL: Record<CmsKStatus, string> = {
  MATCH: 'KHỚP', PROPOSED: 'ĐỀ XUẤT K', MISMATCH: 'LỆCH', SOURCE_CONFLICT: 'NGUỒN XUNG ĐỘT', SOURCE_ERROR: 'NGUỒN LỖI',
  NO_EVIDENCE: 'CHƯA CÓ BẰNG CHỨNG', UNAVAILABLE: 'KHÔNG KIỂM ĐƯỢC',
}

/**
 * Một CẶP lượng gốc khác nhau (quantity_raw, base_quantity) của ProductID × đơn vị thô, kèm số dòng — kSource parse decimal9 CHÍNH
 * XÁC (không chia, không làm tròn). q / b null = ô rỗng hoặc không đọc được (> 9 chữ số lẻ, số mũ, chữ…) ⇒ dòng lỗi nguồn, không bỏ.
 */
export interface CmsKEvidenceRow {
  productId: string
  uomRaw: string
  /** quantity_raw (units scale 9) hoặc null. */
  q: bigint | null
  /** base_quantity (units scale 9) hoặc null. */
  b: bigint | null
  /** Số dòng có đúng cặp này (≥ 1). */
  lines: bigint
}

export type CmsKEvidence = { ok: true; asOf: string; rows: readonly CmsKEvidenceRow[] } | { ok: false; reason: string }

export interface CmsKTarget { productId: string; unit: string; k: bigint | null }

export interface CmsKAck {
  productId: string
  /** Đơn vị chuẩn hoá. */
  unit: string
  /** K dạng decimal chuẩn (formatCmsDecimal). */
  k: string
  /** Nguồn căn cứ manual (text thuần, ≤ 200 ký tự). */
  source: string
  /** actor từ phiên super (không nhận từ client). */
  actor: string
  /** thời điểm server (ISO). */
  at: string
  /** Trạng thái lúc xác nhận. */
  status: 'NO_EVIDENCE' | 'UNAVAILABLE'
}

export interface CmsKResult {
  productId: string
  unit: string
  k: string | null
  status: CmsKStatus
  proposedK: string | null
  /** Đơn vị đã bán (không PII): đơn vị chuẩn hoá × hệ số (null khi không xác định) × số dòng. */
  seen: { unit: string; ratio: string | null; lines: number }[]
  /** Chi tiết lý do (không chứa dữ liệu dòng). */
  note: string
  /** Xác nhận tay đã áp (chỉ NO_EVIDENCE / UNAVAILABLE + K có). */
  ack: CmsKAck | null
  /** Được phép ghi về mặt K. */
  ok: boolean
}

const dec = (s: string | null | undefined): bigint | null => { if (s === null || s === undefined) return null; const r = parseCmsDecimal(s, { allowNegative: true }); return r.ok ? r.units : null }
const fmt = (u: bigint) => formatCmsDecimal(u)
const cellText = (c: CmsImportRawRow['cells'][keyof CmsImportRawRow['cells']]): string | null =>
  c.kind === 'text' ? c.value : c.kind === 'number' ? String(c.value) : null

/**
 * SP cần kiểm từ dòng đã parse: ProductID canonical, đơn vị (dòng đầu), K (nếu đọc được, > 0). SP có nhiều đơn vị / K khác nhau giữa
 * các dòng ⇒ bỏ qua (validator đã loại GROUP_INCONSISTENT). ProductID hỏng ⇒ bỏ (validator loại).
 */
export function cmsKTargets(rows: readonly CmsImportRawRow[]): CmsKTarget[] {
  const by = new Map<string, { units: Set<string>; ks: Set<string>; unit: string; k: bigint | null; bad: boolean }>()
  for (const r of rows) {
    const pc = r.cells.ProductID
    const pid = canonicalProductId(pc.kind === 'number' || pc.kind === 'text' ? pc.value : null)
    if (!pid.ok) continue
    const unitRaw = cellText(r.cells.unit_CMS)
    const unit = cmsNormUnit(unitRaw)
    const kc = r.cells.base_quantity_CMS
    // Cùng cách đọc ô K của validator (ô số: cmsNumberToDecimalString trong miền an toàn; text: nguyên văn).
    const kText = kc.kind === 'number' ? (Math.abs(kc.value) <= Number.MAX_SAFE_INTEGER ? cmsNumberToDecimalString(kc.value) : null) : kc.kind === 'text' ? kc.value.trim() : null
    const kp = kText === null ? null : parseCmsDecimal(kText)
    const k = kp && kp.ok && kp.units > BigInt(0) ? kp.units : null
    const e = by.get(pid.id) ?? { units: new Set<string>(), ks: new Set<string>(), unit: unit ?? '', k, bad: false }
    e.units.add(unit ?? ''); e.ks.add(k === null ? '' : k.toString())
    if (unit === null) e.bad = true
    by.set(pid.id, e)
  }
  const out: CmsKTarget[] = []
  for (const [productId, e] of by) if (!e.bad && e.units.size === 1 && e.ks.size === 1) out.push({ productId, unit: e.unit, k: e.k })
  return out.sort((a, b) => (a.productId.length - b.productId.length) || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0))
}

interface Pair { q: bigint; b: bigint; raw: string; lines: bigint }
interface Group { productId: string; unit: string; raws: Set<string>; n: bigint; badQ: bigint; badB: bigint; neg: bigint; pairs: Pair[] }

const ZERO = BigInt(0)
const F = CMS_DEC_FACTOR

function groupEvidence(rows: readonly CmsKEvidenceRow[]): Map<string, Group[]> {
  const groups = new Map<string, Group>()
  for (const r of rows) {
    const unit = cmsNormUnit(r.uomRaw) ?? ''
    const key = `${r.productId}\u0000${unit}`
    const g = groups.get(key) ?? { productId: r.productId, unit, raws: new Set<string>(), n: ZERO, badQ: ZERO, badB: ZERO, neg: ZERO, pairs: [] }
    g.raws.add(r.uomRaw); g.n += r.lines
    // Mỗi dòng lỗi được ĐẾM (không gộp / không bỏ): âm ⇒ dòng âm; quantity rỗng / ≤ 0 ⇒ không tính được tỷ lệ; base rỗng / hỏng ⇒ như vậy.
    if (r.b !== null && r.b < ZERO) g.neg += r.lines
    else if (r.q === null || r.q <= ZERO) g.badQ += r.lines
    else if (r.b === null) g.badB += r.lines
    else g.pairs.push({ q: r.q, b: r.b, raw: r.uomRaw, lines: r.lines })
    groups.set(key, g)
  }
  const byPid = new Map<string, Group[]>()
  for (const g of groups.values()) byPid.set(g.productId, [...(byPid.get(g.productId) ?? []), g])
  return byPid
}

/** Hai cặp cùng hệ số b / q — nhân chéo BigInt chính xác. */
const sameRatio = (x: Pair, y: Pair) => x.b * y.q === y.b * x.q
const uniqueRatio = (ps: readonly Pair[]) => ps.every((p) => sameRatio(p, ps[0]))
/** Hệ số b / q dạng decimal9 CHÍNH XÁC; không biểu diễn được bằng 9 chữ số lẻ ⇒ null (không làm tròn). */
const exactRatio = (p: Pair): bigint | null => ((p.b * F) % p.q === ZERO ? (p.b * F) / p.q : null)

function problem(g: Group): { status: 'SOURCE_CONFLICT' | 'SOURCE_ERROR'; note: string } | null {
  if (g.raws.size > 1 && !uniqueRatio(g.pairs)) {
    const perRaw = [...g.raws].map((raw) => g.pairs.filter((p) => p.raw === raw))
    if (perRaw.every((ps) => ps.length === 0 || uniqueRatio(ps))) return { status: 'SOURCE_CONFLICT', note: `"${g.unit}" ghi theo nhiều cách với hệ số khác nhau` }
  }
  if (g.badQ > ZERO || g.badB > ZERO) return { status: 'SOURCE_ERROR', note: `"${g.unit}" có ${toNum(g.badQ + g.badB)} dòng không tính được tỷ lệ` }
  if (g.neg > ZERO) return { status: 'SOURCE_ERROR', note: `"${g.unit}" có ${toNum(g.neg)} dòng âm` }
  if (!uniqueRatio(g.pairs)) return { status: 'SOURCE_ERROR', note: `"${g.unit}" có nhiều hệ số (đối chiếu từng cặp lượng gốc)` }
  if (g.pairs.length === 0) return { status: 'SOURCE_ERROR', note: `"${g.unit}" không có dòng hợp lệ` }
  return null
}

const toNum = (n: bigint) => (n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(n))

/** Phân loại từng SP. `acks` = xác nhận tay hợp lệ (đã gắn actor / thời điểm ở server). */
export function cmsKClassify(targets: readonly CmsKTarget[], evidence: CmsKEvidence, acks: readonly CmsKAck[] = []): CmsKResult[] {
  const byPid = evidence.ok ? groupEvidence(evidence.rows) : new Map<string, Group[]>()
  return targets.map((t): CmsKResult => {
    const k = t.k === null ? null : fmt(t.k)
    const gs = byPid.get(t.productId) ?? []
    const seen = gs.map((g) => {
      const r = g.pairs.length && g.badQ === ZERO && g.badB === ZERO && g.neg === ZERO && uniqueRatio(g.pairs) ? exactRatio(g.pairs[0]) : null
      return { unit: g.unit, ratio: r === null ? null : fmt(r), lines: toNum(g.n) }
    })
    const base = { productId: t.productId, unit: t.unit, k, proposedK: null as string | null, seen, ack: null as CmsKAck | null }
    const withAck = (status: 'NO_EVIDENCE' | 'UNAVAILABLE', note: string): CmsKResult => {
      const ack = k === null ? undefined : acks.find((a) => a.productId === t.productId && a.unit === t.unit && a.k === k)
      return { ...base, status, note, ack: ack ?? null, ok: ack !== undefined }
    }
    if (!evidence.ok) return withAck('UNAVAILABLE', 'Không đọc được nguồn bán để đối chiếu K')
    const issues = gs.map(problem).filter((x): x is NonNullable<ReturnType<typeof problem>> => x !== null)
    if (issues.length) {
      const st = issues.some((i) => i.status === 'SOURCE_CONFLICT') ? 'SOURCE_CONFLICT' : 'SOURCE_ERROR'
      return { ...base, status: st, note: issues.map((i) => i.note).join('; '), ok: false }
    }
    const hit = gs.find((g) => g.unit === t.unit)
    if (!hit) return withAck('NO_EVIDENCE', gs.length ? `Chưa bán theo "${t.unit}" (đã bán: ${gs.map((g) => g.unit || '—').join(', ')})` : 'Chưa có dòng bán')
    const r = exactRatio(hit.pairs[0])
    const lines = `${toNum(hit.n)} dòng bán "${t.unit}"`
    if (t.k === null) {
      // Đề xuất chỉ khi hệ số biểu diễn đúng bằng decimal9 VÀ mọi cặp đúng hệ số đó (đã kiểm uniqueRatio ở problem()).
      return r !== null && hit.pairs.every((p) => p.b * F === r * p.q)
        ? { ...base, status: 'PROPOSED', proposedK: fmt(r), note: `Theo ${lines}: 1 ${t.unit} = ${fmt(r)}`, ok: false }
        : withAck('NO_EVIDENCE', `Theo ${lines}: hệ số không biểu diễn chính xác bằng 9 chữ số lẻ — không đề xuất K`)
    }
    const K = t.k
    if (hit.pairs.every((p) => p.b * F === K * p.q)) return { ...base, status: 'MATCH', note: `Theo ${lines} (từng cặp lượng gốc)`, ok: true }
    return { ...base, status: 'MISMATCH', note: `POS: 1 ${t.unit} = ${r === null ? 'hệ số không biểu diễn được bằng 9 chữ số lẻ' : fmt(r)}; file K = ${k}`, ok: false }
  })
}

const KFIX: Record<CmsKStatus, string> = {
  MATCH: '',
  PROPOSED: 'Nếu đúng, nhập K đề xuất vào base_quantity_CMS rồi kiểm tra lại (hệ thống không tự điền)',
  MISMATCH: 'Sửa base_quantity_CMS theo quy đổi POS hoặc kiểm lại đơn vị CMS — không xác nhận tay được',
  SOURCE_CONFLICT: 'Nguồn bán ghi đơn vị không thống nhất — làm việc với BI; không xác nhận tay được',
  SOURCE_ERROR: 'Nguồn bán có dòng lỗi — làm việc với BI; không xác nhận tay được',
  NO_EVIDENCE: 'Super xác nhận K kèm nguồn căn cứ (vd. quy cách nhà cung cấp) ở bước kiểm tra',
  UNAVAILABLE: 'Thử kiểm tra lại sau, hoặc super xác nhận K kèm nguồn căn cứ',
}
const kIssue = (row: number | null, x: CmsKResult): CmsImportIssue => ({
  excelRow: row, column: 'base_quantity_CMS', code: `K_${x.status}`,
  message: `Kiểm K — ${CMS_K_STATUS_LABEL[x.status]}: ${x.note}${x.proposedK ? ` · đề xuất K = ${x.proposedK}` : ''}`, fix: KFIX[x.status],
})

/**
 * Áp kết quả kiểm K lên kết quả validator: nhóm hợp lệ mà K chưa đạt (!ok) ⇒ chuyển sang bị loại kèm lỗi K_*; nhóm đã bị loại (vd.
 * thiếu K) ⇒ thêm thông tin K (đề xuất / chưa có bằng chứng) để admin biết sửa gì. Không đổi giá trị nhóm hợp lệ.
 */
export function cmsApplyKCheck(v: CmsImportValidation, rows: readonly CmsImportRawRow[], results: readonly CmsKResult[]): CmsImportValidation {
  const byPid = new Map(results.map((x) => [x.productId, x]))
  const moved: CmsImportGroupRejected[] = []
  const groupsOk = v.groupsOk.filter((g) => {
    const x = byPid.get(g.productId)
    if (x && x.ok) return true
    const issue: CmsImportIssue = x ? kIssue(g.excelRows[0], x)
      : { excelRow: g.excelRows[0], column: 'base_quantity_CMS', code: 'K_UNAVAILABLE', message: 'Kiểm K — KHÔNG KIỂM ĐƯỢC', fix: KFIX.UNAVAILABLE }
    moved.push({ key: g.productId, rows: rows.filter((r) => g.excelRows.includes(r.excelRow)), errors: [issue] })
    return false
  })
  const groupsRejected = v.groupsRejected.map((g) => {
    const x = byPid.get(g.key)
    return x && !x.ok && (x.status === 'PROPOSED' || x.status === 'NO_EVIDENCE') ? { ...g, errors: [...g.errors, kIssue(g.rows[0]?.excelRow ?? null, x)] } : g
  })
  const all = [...groupsRejected, ...moved]
  const rowsOk = groupsOk.reduce((s, g) => s + g.excelRows.length, 0)
  return {
    ...v, groupsOk, groupsRejected: all,
    catalogTarget: groupsOk.some((g) => g.gmvBasis === 'catalog') || v.mode === 'append' ? v.catalogTarget : null,
    stats: { ...v.stats, rowsOk, rowsRejected: v.stats.rowsTotal - rowsOk, productsOk: groupsOk.length, productsRejected: all.length, warnings: groupsOk.reduce((s, g) => s + g.warnings.length, 0) },
  }
}

// ── Xác nhận tay (client gửi ý định; server gắn actor / thời điểm) ─────────────────────────────────────────────────────────────
export const CMS_K_ACK_SOURCE_MAX = 200
export const CMS_K_ACK_MAX = 2000

export interface CmsKAckInput { productId: string; unit: string; k: string; source: string }

/** Đọc `k_acks` (JSON) từ form; sai dạng ⇒ null (route trả 400). Chuẩn hoá đơn vị / K / nguồn; bỏ ký tự điều khiển. */
export function cmsParseKAckInput(raw: string | null): CmsKAckInput[] | null {
  if (raw === null || raw === '') return []
  if (raw.length > 1_000_000) return null
  let x: unknown
  try { x = JSON.parse(raw) } catch { return null }
  if (!Array.isArray(x) || x.length > CMS_K_ACK_MAX) return null
  const out: CmsKAckInput[] = []
  for (const it of x) {
    if (typeof it !== 'object' || it === null) return null
    const o = it as Record<string, unknown>
    const pid = canonicalProductId(typeof o.product_id === 'string' ? o.product_id : null)
    const unit = cmsNormUnit(typeof o.unit === 'string' ? o.unit : null)
    const kp = typeof o.k === 'string' ? parseCmsDecimal(o.k) : null
    // eslint-disable-next-line no-control-regex
    const source = typeof o.source === 'string' ? o.source.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim() : ''
    if (!pid.ok || unit === null || !kp || !kp.ok || kp.units <= BigInt(0) || source.length < 3 || source.length > CMS_K_ACK_SOURCE_MAX) return null
    out.push({ productId: pid.id, unit, k: fmt(kp.units), source })
  }
  return out
}

/** Gắn actor (phiên) + thời điểm (server) cho xác nhận ÁP ĐƯỢC: chỉ SP đang NO_EVIDENCE / UNAVAILABLE, đúng đơn vị + K. */
export function cmsBindKAcks(inputs: readonly CmsKAckInput[], before: readonly CmsKResult[], actor: string, at: string): CmsKAck[] {
  const out: CmsKAck[] = []
  for (const x of before) {
    if ((x.status !== 'NO_EVIDENCE' && x.status !== 'UNAVAILABLE') || x.k === null) continue
    const i = inputs.find((a) => a.productId === x.productId && a.unit === x.unit && a.k === x.k)
    if (i) out.push({ productId: x.productId, unit: x.unit, k: x.k, source: i.source, actor, at, status: x.status })
  }
  return out
}

/** Đọc lại xác nhận đã lưu trong run (server ghi lúc preview) — sai dạng ⇒ bỏ (không ném). */
export function cmsStoredKAcks(v: unknown): CmsKAck[] {
  if (!Array.isArray(v)) return []
  const out: CmsKAck[] = []
  for (const it of v) {
    if (typeof it !== 'object' || it === null) continue
    const o = it as Record<string, unknown>
    if (typeof o.productId !== 'string' || typeof o.unit !== 'string' || typeof o.k !== 'string' || typeof o.source !== 'string'
      || typeof o.actor !== 'string' || typeof o.at !== 'string' || (o.status !== 'NO_EVIDENCE' && o.status !== 'UNAVAILABLE')) continue
    out.push({ productId: o.productId, unit: o.unit, k: o.k, source: o.source, actor: o.actor, at: o.at, status: o.status })
  }
  return out
}

/** Dữ liệu dòng nguồn từ chuỗi (kSource) — dec() dùng chung để test. */
export const cmsKDec = dec
