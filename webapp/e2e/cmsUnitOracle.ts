// CMS-UNIT AC12 — ORACLE ĐỘC LẬP cho cơ sở tính `cms_unit` (PM spec 09/11 §2 / §7). KHÔNG import lib/cms (không dùng engine, decimal,
// unitKey, mapping hay tiers của app) — tự đọc chuỗi nguồn thô, tự dựng khoá đơn vị từ Unicode (toLowerCase + khứ hồi + NFC, giới
// hạn đúng các khối Latin / tiếng Việt của hợp đồng), tự parse thập phân scale 9 bằng BigInt, tự tính ở mức NHÓM (không theo dòng):
//   C = Σ quantity_raw nguyên của dòng INCLUDED đúng ĐV CMS; Q = max(C, 0); tiềm năng = F(Q) lũy tiến; nhận = gate ? F(Q) : 0;
//   gate SP = Σ GMV INCLUDED của (dược sĩ, SP) ≥ target; gate danh mục = Σ GMV INCLUDED các SP danh mục của dược sĩ ≥ target danh mục.
// HOLD khi BẤT KỲ dòng ứng viên (OFFLINE + COMPLETED + trong kỳ VN + SP thuộc chương trình — kể cả chưa gán / ngoài phạm vi) có đơn vị
// thiếu / có ký tự điều khiển hoặc ký tự vô hình (r1 Q-225), lượng thiếu / sai hình thức, hoặc đúng ĐV mà lượng lẻ / ngoài miền bigint. Không clamp, không làm tròn.
// Phạm vi oracle: người bán là email ↔ (user, nhà thuốc) đơn giản (fixture chỉ dùng dược sĩ OS hợp lệ); thứ tự dòng không ảnh hưởng.

export type OracleRaw = Record<string, string | null | undefined>

export interface OracleProduct {
  productId: string
  unitCms: string
  gmvBasis: 'product' | 'catalog' | 'none'
  target: string | null
  tiers: { from: number; to: number | null; amount: string }[]
}
export interface OracleProgram {
  start: string
  end: string
  storeIds: string[]
  catalogTarget: string | null
  products: OracleProduct[]
}
export interface OracleSeller { email: string; userId: string; storeId: string }

export interface OracleResult {
  hold: Record<string, number> | null
  /** khoá `${userId}|${productId}` */
  pairs: Map<string, { q: bigint; potential: bigint; amount: bigint; gateMet: boolean; b: bigint; gmv: bigint }>
  total: bigint
  /** Dòng ứng viên có B / GMV / quantity_raw âm (cổng trả hàng). */
  negativeCandidates: number
}

const E9 = BigInt('1000000000')
const I64 = BigInt('9223372036854775807')
const Z = BigInt(0)

// ── khoá đơn vị (dựng lại từ Unicode, không đọc bảng của app) ───────────────────────────────────────────────────────────────
const CTRL = /[\u0000-\u001f\u007f-\u009f]/
// Khoảng trắng cắt hai đầu (khoá v2 — KHÔNG còn U+FEFF), viết bằng code point độc lập với hằng của app.
const WS = String.fromCodePoint(0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000)
// r1 Q-225 (PM 10/11): ký tự định dạng / vô hình ở BẤT KỲ vị trí nào ⇒ đơn vị / lượng không hợp lệ (kiểm trên chuỗi THÔ, trước trim).
const INVIS = /[\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb]/
const isWs = (c: string) => WS.includes(c)
const inLatinBlocks = (cp: number) =>
  (cp >= 0x41 && cp <= 0x5a) || (cp >= 0xc0 && cp <= 0xde) || (cp >= 0x100 && cp <= 0x17f) || (cp >= 0x1a0 && cp <= 0x1a1)
  || (cp >= 0x1af && cp <= 0x1b0) || (cp >= 0x1e00 && cp <= 0x1eff)
function lowerOne(c: string): string {
  const cp = c.codePointAt(0)!
  if (!inLatinBlocks(cp)) return c
  const l = c.toLowerCase()
  if ([...l].length !== 1 || l === c || l.toUpperCase() !== c || l.normalize('NFC') !== l) return c
  return l
}
export function oracleUnitKey(v: string | null | undefined): string | null {
  if (typeof v !== 'string' || CTRL.test(v) || INVIS.test(v)) return null
  const cs = [...v.normalize('NFC')]
  while (cs.length && isWs(cs[0])) cs.shift()
  while (cs.length && isWs(cs[cs.length - 1])) cs.pop()
  return cs.length ? cs.map(lowerOne).join('') : null
}

// ── số ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** decimal scale 9 → BigInt (đơn vị 1e-9); sai hình thức ⇒ null. */
export function oracleDec9(s: string | null | undefined): bigint | null {
  if (typeof s !== 'string') return null
  const m = /^(-?)([0-9]+)(?:\.([0-9]{1,9}))?$/.exec(s)
  if (!m) return null
  const intDigits = m[2].replace(/^0+/, '')
  if (intDigits.length > 29) return null
  const v = BigInt(m[2]) * E9 + BigInt((m[3] ?? '').padEnd(9, '0') || '0')
  return m[1] === '-' ? -v : v
}

const vnDate = (iso: string) => new Date(Date.parse(iso.slice(0, 19) + 'Z') + 7 * 3600_000).toISOString().slice(0, 10)
const pidCanon = (s: string | null | undefined) => (typeof s === 'string' ? s.trim().replace(/^0+(?=[0-9])/, '') : '')

function F(q: bigint, tiers: OracleProduct['tiers']): bigint {
  let t = Z
  for (const x of tiers) {
    const from = BigInt(x.from)
    if (q < from) break
    const hi = x.to === null || q < BigInt(x.to) ? q : BigInt(x.to)
    t += (hi - from + BigInt(1)) * BigInt(x.amount)
  }
  return t
}

export function cmsUnitOracle(prog: OracleProgram, rows: readonly OracleRaw[], sellers: readonly OracleSeller[]): OracleResult {
  const products = new Map(prog.products.map((p) => [pidCanon(p.productId), p]))
  const sel = new Map(sellers.map((s) => [s.email.trim().toLowerCase(), s]))
  const scope = new Set(prog.storeIds)
  const hold: Record<string, number> = {}
  const bump = (k: string) => { hold[k] = (hold[k] ?? 0) + 1 }
  let negativeCandidates = 0
  type Acc = { c: bigint; b: bigint; gmv: bigint }
  const acc = new Map<string, Acc>()
  const catalogGmv = new Map<string, bigint>()
  for (const r of rows) {
    if (r.order_type !== 'OFFLINE' || r.order_status !== 'COMPLETED') continue
    const d = vnDate(String(r.completed_at))
    if (d < prog.start || d > prog.end) continue
    const p = products.get(pidCanon(r.product_id))
    if (!p) continue
    const unitKeyCms = oracleUnitKey(p.unitCms)!
    // Hình thức đơn vị / lượng của MỌI ứng viên. Biên nguồn (hợp đồng dòng bán đã phát hành) cắt khoảng trắng hai đầu của text ⇒ chỉ
    // khoảng trắng = thiếu; ký tự điều khiển ở giá trị THÔ ⇒ không hợp lệ (không làm sạch thành giá trị có vẻ hợp lệ).
    const uom = typeof r.uom_raw === 'string' ? r.uom_raw : null
    const qraw = typeof r.quantity_raw === 'string' ? r.quantity_raw : null
    let bad: string | null = null
    if (uom !== null && (CTRL.test(uom) || INVIS.test(uom))) bad = 'UNIT_INVALID'
    else if (uom === null || uom.trim() === '') bad = 'UNIT_MISSING'
    const key = bad ? null : oracleUnitKey(uom!.trim())
    if (!bad && key === null) bad = 'UNIT_INVALID'
    if (!bad && qraw !== null && (CTRL.test(qraw) || INVIS.test(qraw))) bad = 'QTY_INVALID'
    const q9 = bad ? null : oracleDec9(qraw === null ? null : qraw.trim())
    if (!bad && q9 === null) bad = qraw === null || qraw.trim() === '' ? 'QTY_MISSING' : 'QTY_INVALID'
    const matched = !bad && key === unitKeyCms
    if (!bad && matched && q9! % E9 !== Z) bad = 'QTY_FRACTION'
    if (!bad && matched && (q9! / E9 > I64 || -(q9! / E9) > I64)) bad = 'QTY_RANGE'
    if (bad) { bump(bad); continue }
    const b = oracleDec9(r.base_quantity)!
    const gmv = oracleDec9(r.gmv_amount)!
    if (b < Z || gmv < Z || q9! < Z) negativeCandidates++
    const s = sel.get(String(r.seller_email ?? '').trim().toLowerCase())
    if (!s || !scope.has(s.storeId)) continue
    const k = `${s.userId}|${pidCanon(p.productId)}`
    const a = acc.get(k) ?? { c: Z, b: Z, gmv: Z }
    if (matched) a.c += q9! / E9
    a.b += b
    a.gmv += gmv
    acc.set(k, a)
    if (p.gmvBasis === 'catalog') catalogGmv.set(s.userId, (catalogGmv.get(s.userId) ?? Z) + gmv)
  }
  const pairs: OracleResult['pairs'] = new Map()
  let total = Z
  for (const [k, a] of acc) {
    const [userId, pid] = k.split('|')
    const p = products.get(pid)!
    const q = a.c > Z ? a.c : Z
    const potential = F(q, p.tiers)
    const gateMet = p.gmvBasis === 'none' ? true
      : p.gmvBasis === 'product' ? a.gmv >= BigInt(p.target!) * E9
      : (catalogGmv.get(userId) ?? Z) >= BigInt(prog.catalogTarget!) * E9
    const amount = gateMet ? potential : Z
    total += amount
    pairs.set(k, { q, potential, amount, gateMet, b: a.b, gmv: a.gmv })
  }
  return { hold: Object.keys(hold).length ? hold : null, pairs, total, negativeCandidates }
}
