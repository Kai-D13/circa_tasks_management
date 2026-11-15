// CMS-CALC-RET-2 — ORACLE ĐỘC LẬP (spec §9: "Oracle độc lập mới theo Q-230 / Q-231 / Q-232, không gọi engine để tự làm kỳ vọng").
// KHÔNG import bất kỳ module nào của app (lib/**) — tự đọc số, tự chuẩn hoá đơn vị, tự map người bán, tự tính bậc. Tính TỔNG theo nhóm
// (Q / B / GMV / gate / tiền), tập mã HOLD và (r1.1, PM review P1/P2 r1) PHÂN BỔ TỪNG SỰ KIỆN + MỐC GATE theo thứ tự contract D1. Viết
// theo câu chữ spec / review, cố ý khác cách cài đặt của app:
//  · số: chuỗi → BigInt scale 9 bằng tách phần nguyên / lẻ thủ công (không parseCmsDecimal);
//  · đơn vị: kiểm code point điều khiển / vô hình theo danh sách spec §3.4 + CMS-UNIT Q-225, NFC, cắt khoảng trắng tường minh, rồi
//    String.prototype.toLowerCase (app dùng bảng tường minh) — fixture chỉ dùng chữ Latin / tiếng Việt nên hai cách phải trùng;
//  · gate: trạng thái CUỐI (GMV ròng ≥ target) tính từ tổng; mốc = lần chuyển chưa đạt → đạt CUỐI CÙNG khi đi theo thứ tự sự kiện;
//  · thứ tự sự kiện (D1): µs → SALE trước RETURN → ID; SALE: ID toàn chữ số so bằng BigInt (cùng giá trị ⇒ so byte), đứng trước ID
//    text; text và RETURN so BYTE UTF-8 bằng TextEncoder (app so code point, không mã hoá);
//  · trạng thái phiếu trả (D13): từ điển cố định { COMPLETED: hiệu lực, APPROVED: chưa hiệu lực }; giá trị khác / rỗng ⇒ lỗi dòng nguồn.
//    Mọi lỗi dòng nguồn trả ⇒ cả lượt chỉ còn SOURCE_ROW_INVALID (cùng mức với app: lỗi chuẩn hoá chặn trước khi tính).
// Đầu vào là FIXTURE THÔ (chuỗi như nguồn) — cùng fixture app đọc qua normalizer của nó.

export interface OracleSaleRow {
  id: string; order: string; code?: string; pid: string; email: string | null; pos?: string | null
  type?: string; status?: string; at: string; q: string | null; u: string | null; b: string; g: string
}
export interface OracleReturnRow {
  id: string; doc?: string; status: string; at: string | null; ref: string | null; order: string | null; pid: string | null
  r: string | null; h: string | null
  /** Ngữ cảnh gốc; mặc định = sao từ dòng bán `ref` (fixture builder). */
  o?: { at: string; type: string; status: string; email: string | null; pos: string | null; b: string; g: string; q: string | null; u: string | null }
}
export interface OracleProduct { pid: string; basis: 'product' | 'catalog' | 'none'; target: string | null; k: string; unit: string | null; tiers: { from: number; to: number | null; amount: number }[] }
export interface OracleUser { id: string; email: string; role: string; store: string | null }
export interface OracleStore { id: string; type: string; active: boolean }
export interface OracleCase {
  quantityBasis: 'pos_base' | 'cms_unit'
  returnsPolicy: 'sales_only_v1' | 'net_returns_v1'
  start: string; end: string; catalogTarget: string | null; stores: string[]
  products: OracleProduct[]; users: OracleUser[]; storeRefs: OracleStore[]
  sales: OracleSaleRow[]; returns: OracleReturnRow[]; asOf: string
}
export interface OracleGroup {
  user: string; pid: string
  saleBase: bigint; retBase: bigint; netBase: bigint
  eligSale: bigint; eligRet: bigint; eligNet: bigint
  q: bigint; saleGmv: bigint; retGmv: bigint; netGmv: bigint; met: boolean; amount: bigint
  /** Mốc gate (µs) — null nếu không đạt hoặc gmv_basis none. */
  metAt: bigint | null
}
/** Một sự kiện lịch sử: khoá namespaced, mốc µs, B đủ trước / sau, tiền phân bổ (= A(sau) − A(trước) khi gate cuối đạt). */
export interface OracleEvent { key: string; at: bigint; before: bigint; after: bigint; amount: bigint }
export interface OracleCatalog { user: string; met: boolean; metAt: bigint | null }
export type OracleResult =
  | { hold: string[] }
  | { hold: null; groups: OracleGroup[]; total: bigint; events: OracleEvent[]; catalog: OracleCatalog[] }

const S9 = BigInt(1000000000)
const Z = BigInt(0)

/** Chuỗi thập phân → BigInt scale 9; null nếu sai hình thức. */
function dec(s: string | null | undefined): bigint | null {
  if (s === null || s === undefined) return null
  const m = /^(-?)(\d+)(?:\.(\d{1,9}))?$/.exec(s.trim())
  if (!m) return null
  const v = BigInt(m[2]) * S9 + BigInt((m[3] ?? '').padEnd(9, '0'))
  return m[1] === '-' ? -v : v
}
/** UTC ISO (`YYYY-MM-DDTHH:MM:SS(.ffffff)Z` hoặc `YYYY-MM-DD HH:MM:SS(.ffffff) UTC`) → µs. */
function micros(s: string): bigint {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z| UTC)$/.exec(s)
  if (!m) throw new Error(`oracle: mốc sai ${s}`)
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  return BigInt(ms) * BigInt(1000) + BigInt((m[7] ?? '').padEnd(6, '0'))
}
/** Kỳ VN [start 00:00 +07, end+1 00:00 +07). */
function windowOf(start: string, end: string): [bigint, bigint] {
  const d = (x: string, add: number) => {
    const [y, mo, da] = x.split('-').map(Number)
    return BigInt(Date.UTC(y, mo - 1, da + add) - 7 * 3600 * 1000) * BigInt(1000)
  }
  return [d(start, 0), d(end, 1)]
}

const INVISIBLE: [number, number][] = [
  [0xad, 0xad], [0x34f, 0x34f], [0x600, 0x605], [0x61c, 0x61c], [0x6dd, 0x6dd], [0x70f, 0x70f], [0x890, 0x891], [0x8e2, 0x8e2],
  [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164],
  [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfffb],
]
const TRIM = new Set([0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000])
function badCp(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true
    if (INVISIBLE.some(([a, b]) => c >= a && c <= b)) return true
  }
  return false
}
function unitKey(s: string | null): string | null {
  if (s === null || badCp(s)) return null
  const cps = [...s.normalize('NFC')]
  while (cps.length && TRIM.has(cps[0].codePointAt(0)!)) cps.shift()
  while (cps.length && TRIM.has(cps[cps.length - 1].codePointAt(0)!)) cps.pop()
  return cps.length ? cps.join('').toLowerCase() : null
}
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

const ENC = new TextEncoder()
function bytesCmp(a: string, b: string): number {
  const x = ENC.encode(a), y = ENC.encode(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return x.length - y.length
}
function saleIdCmp(a: string, b: string): number {
  const na = /^[0-9]+$/.test(a), nb = /^[0-9]+$/.test(b)
  if (na !== nb) return na ? -1 : 1
  if (na) { const va = BigInt(a), vb = BigInt(b); if (va !== vb) return va < vb ? -1 : 1 }
  return bytesCmp(a, b)
}
type OEv = { kind: 'SALE' | 'RETURN'; id: string; at: bigint; user: string; pid: string; dElig: bigint; dGmv: bigint }
function evCmp(a: OEv, b: OEv): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  if (a.kind !== b.kind) return a.kind === 'SALE' ? -1 : 1
  return a.kind === 'SALE' ? saleIdCmp(a.id, b.id) : bytesCmp(a.id, b.id)
}
/** Mốc chuyển chưa đạt → đạt cuối cùng khi cộng dồn GMV theo thứ tự; null nếu cuối không đạt. */
function crossing(evs: readonly OEv[], target: bigint): { met: boolean; metAt: bigint | null } {
  let cum = Z, met = false, last: bigint | null = null
  for (const e of evs) { cum += e.dGmv; const m = cum >= target; if (m && !met) last = e.at; met = m }
  return { met, metAt: met ? last : null }
}

export function oracleCompute(c: OracleCase): OracleResult {
  const hold = new Set<string>()
  const [w0, w1] = windowOf(c.start, c.end)
  const prod = new Map(c.products.map((p) => [p.pid, p]))
  const stores = new Map(c.storeRefs.map((s) => [s.id, s]))
  const seller = (email: string | null): { user: string; store: string } | null => {
    if (email === null || email.trim() === '') return null
    const hits = c.users.filter((u) => u.email.trim().toLowerCase() === email.trim().toLowerCase())
    if (hits.length !== 1 || hits[0].role !== 'staff') return null
    const st = hits[0].store === null ? undefined : stores.get(hits[0].store)
    if (!st || st.type !== 'os' || !st.active) return null
    return { user: hits[0].id, store: st.id }
  }
  type SaleInfo = { row: OracleSaleRow; b: bigint; g: bigint; at: bigint; candidate: boolean; cls: string | null; elig: bigint; who: { user: string; store: string } | null; inScope: boolean }
  const sales = new Map<string, SaleInfo>()
  for (const s of c.sales) {
    const b = dec(s.b)!, g = dec(s.g)!, at = micros(s.at)
    const type = s.type ?? 'OFFLINE', status = s.status ?? 'COMPLETED'
    const p = prod.get(s.pid)
    const candidate = type === 'OFFLINE' && status === 'COMPLETED' && at >= w0 && at < w1 && !!p
    let cls: string | null = null
    let elig = Z
    if (candidate) {
      const K = dec(p!.k)!
      if (b < Z || g < Z) hold.add('NEGATIVE_SALE')
      else if (c.quantityBasis === 'pos_base') { cls = 'POS_BASE'; elig = b }
      else {
        const pu = unitKey(p!.unit)
        if (s.u !== null && badCp(s.u)) hold.add('UNIT_INVALID')
        else if (s.u === null || s.u === '') hold.add('UNIT_MISSING')
        else if (unitKey(s.u) === null) hold.add('UNIT_INVALID')
        else if (s.q === null || s.q === '') hold.add('QTY_MISSING')
        else if (badCp(s.q) || !/^-?\d+(\.\d+)?$/.test(s.q) || dec(s.q) === null) hold.add('QTY_INVALID')
        else {
          const q = dec(s.q)!
          if (q < Z) hold.add('NEGATIVE_SALE')
          else if (unitKey(s.u) !== pu) {
            if (q === Z && (b !== Z || g !== Z)) hold.add('ZERO_QTY_WITH_VALUE'); else cls = 'OTHER_UNIT'
          } else if (q === Z) {
            if (b !== Z || g !== Z) hold.add('ZERO_QTY_WITH_VALUE'); else cls = 'ZERO_QUANTITY'
          } else if (b * S9 !== q * K) hold.add('BASE_QTY_MISMATCH')
          else if (q % S9 !== Z) cls = 'FRACTIONAL_QUANTITY'
          else { cls = 'COUNTED'; elig = b }
        }
      }
    }
    const who = candidate ? seller(s.email) : null
    sales.set(s.id, { row: s, b, g, at, candidate, cls, elig, who, inScope: !!who && c.stores.includes(who.store) })
  }
  if (c.returnsPolicy === 'sales_only_v1' && c.returns.length) throw new Error('oracle: sales_only không nhận trả')

  const ids = new Map<string, number>()
  for (const r of c.returns) ids.set(r.id, (ids.get(r.id) ?? 0) + 1)
  const sumR = new Map<string, { r: bigint; h: bigint }>()
  const applied: { sale: SaleInfo; id: string; at: bigint; r: bigint; h: bigint }[] = []
  const asOf = micros(c.asOf)
  const ctxOf = (r: OracleReturnRow) => {
    const sale = r.ref === null ? undefined : sales.get(r.ref)
    return r.o ?? (sale ? { at: sale.row.at, type: sale.row.type ?? 'OFFLINE', status: sale.row.status ?? 'COMPLETED', email: sale.row.email, pos: sale.row.pos ?? null, b: sale.row.b, g: sale.row.g, q: sale.row.q, u: sale.row.u } : null)
  }
  // Lượt 1 — từng dòng nguồn trả phải hợp lệ theo hợp đồng trước khi tính bất cứ gì.
  for (const r of c.returns) {
    if (r.status === 'APPROVED') continue
    if (r.status !== 'COMPLETED') return { hold: ['SOURCE_ROW_INVALID'] }
    if (r.at === null || r.ref === null || r.order === null || r.pid === null || r.r === null || r.h === null || ctxOf(r) === null) return { hold: ['SOURCE_ROW_INVALID'] }
    const rq = dec(r.r), rh = dec(r.h)
    if (rq === null || !/^\d+$/.test(r.r) || rq <= Z || rh === null || rh < Z) return { hold: ['SOURCE_ROW_INVALID'] }
  }
  for (const r of c.returns) {
    if (ids.get(r.id)! > 1) { hold.add('RETURN_DUPLICATE_ID'); continue }
    if (r.status !== 'COMPLETED') continue
    const rq = dec(r.r)!, rh = dec(r.h)!
    const at = micros(r.at!)
    const sale = sales.get(r.ref!)
    const o = ctxOf(r)
    if (!o) throw new Error('oracle: ngữ cảnh gốc đã kiểm ở lượt 1')
    if (at > asOf) hold.add('RETURN_AFTER_AS_OF')
    if (at < micros(o.at)) hold.add('RETURN_BEFORE_SALE')
    if (sale) {
      const same = r.order === sale.row.order && r.pid === sale.row.pid && micros(o.at) === sale.at && o.type === (sale.row.type ?? 'OFFLINE')
        && o.status === (sale.row.status ?? 'COMPLETED') && (o.email?.trim().toLowerCase() ?? null) === (sale.row.email?.trim().toLowerCase() ?? null)
        && o.pos === (sale.row.pos ?? null) && dec(o.b) === sale.b && dec(o.g) === sale.g
        && (c.quantityBasis === 'pos_base' || (o.q === sale.row.q && o.u === sale.row.u))
      if (!same) { hold.add('RETURN_CONTEXT_MISMATCH'); continue }
    }
    const oat = micros(o.at)
    const inProgram = o.type === 'OFFLINE' && o.status === 'COMPLETED' && oat >= w0 && oat < w1 && prod.has(r.pid!)
    if (!inProgram) continue
    if (!sale) { hold.add('RETURN_ORIGIN_MISSING'); continue }
    const acc = sumR.get(r.ref!) ?? { r: Z, h: Z }
    acc.r += rq; acc.h += rh
    sumR.set(r.ref!, acc)
    if (sale.who && sale.inScope) applied.push({ sale, id: r.id, at, r: rq, h: rh })
  }
  for (const [ref, acc] of sumR) {
    const s = sales.get(ref)!
    if (acc.r > s.b) hold.add('RETURN_EXCEEDS_SALE_BASE')
    if (acc.h > s.g) hold.add('RETURN_EXCEEDS_SALE_GMV')
  }
  if (hold.size) return { hold: [...hold].sort() }

  const groups = new Map<string, OracleGroup>()
  const grp = (s: SaleInfo) => {
    const k = `${s.who!.user}|${s.row.pid}`
    let g = groups.get(k)
    if (!g) {
      g = { user: s.who!.user, pid: s.row.pid, saleBase: Z, retBase: Z, netBase: Z, eligSale: Z, eligRet: Z, eligNet: Z, q: Z, saleGmv: Z, retGmv: Z, netGmv: Z, met: true, amount: Z, metAt: null }
      groups.set(k, g)
    }
    return g
  }
  for (const s of sales.values()) {
    if (!s.candidate || !s.who || !s.inScope) continue
    const g = grp(s)
    g.saleBase += s.b; g.eligSale += s.elig; g.saleGmv += s.g
  }
  for (const a of applied) {
    const g = grp(a.sale)
    g.retBase += a.r; g.retGmv += a.h
    if (a.sale.cls === 'POS_BASE' || a.sale.cls === 'COUNTED') g.eligRet += a.r
  }
  const catalogGmv = new Map<string, bigint>()
  for (const g of groups.values()) {
    g.netBase = g.saleBase - g.retBase; g.eligNet = g.eligSale - g.eligRet; g.netGmv = g.saleGmv - g.retGmv
    if (prod.get(g.pid)!.basis === 'catalog') catalogGmv.set(g.user, (catalogGmv.get(g.user) ?? Z) + g.netGmv)
  }
  let total = Z
  for (const g of groups.values()) {
    const p = prod.get(g.pid)!
    const K = dec(p.k)!
    // floor(E / K) với cùng scale: E_units / K_units (chia nguyên BigInt).
    g.q = g.eligNet > Z ? g.eligNet / K : Z
    if (p.basis === 'product') g.met = g.netGmv >= dec(p.target)!
    else if (p.basis === 'catalog') g.met = catalogGmv.get(g.user)! >= dec(c.catalogTarget)!
    g.amount = g.met ? F(g.q, p.tiers) : Z
    total += g.amount
  }

  // Phân bổ từng sự kiện + mốc gate theo thứ tự D1 — tự xếp, tự cộng dồn (không dựa telescoping của app).
  const evs: OEv[] = []
  for (const [id, x] of sales) {
    if (!x.candidate || !x.who || !x.inScope) continue
    evs.push({ kind: 'SALE', id, at: x.at, user: x.who.user, pid: x.row.pid, dElig: x.elig, dGmv: x.g })
  }
  for (const a of applied) {
    const contributes = a.sale.cls === 'POS_BASE' || a.sale.cls === 'COUNTED'
    evs.push({ kind: 'RETURN', id: a.id, at: a.at, user: a.sale.who!.user, pid: a.sale.row.pid, dElig: contributes ? -a.r : Z, dGmv: -a.h })
  }
  evs.sort(evCmp)
  const catalog: OracleCatalog[] = []
  const catByUser = new Map<string, { met: boolean; metAt: bigint | null }>()
  const catUsers = new Set([...groups.values()].filter((g) => prod.get(g.pid)!.basis === 'catalog').map((g) => g.user))
  for (const user of catUsers) {
    const x = crossing(evs.filter((e) => e.user === user && prod.get(e.pid)!.basis === 'catalog'), dec(c.catalogTarget)!)
    catByUser.set(user, x)
    catalog.push({ user, met: x.met, metAt: x.metAt })
  }
  for (const g of groups.values()) {
    const p = prod.get(g.pid)!
    let x: { met: boolean; metAt: bigint | null } | null = null
    if (p.basis === 'product') x = crossing(evs.filter((e) => e.user === g.user && e.pid === g.pid), dec(p.target)!)
    else if (p.basis === 'catalog') x = catByUser.get(g.user)!
    if (x) {
      if (x.met !== g.met) throw new Error('oracle: gate theo chuỗi ≠ gate theo tổng')
      g.metAt = x.metAt
    }
  }
  const events: OracleEvent[] = []
  const running = new Map<string, bigint>()
  for (const e of evs) {
    const k = `${e.user}|${e.pid}`
    const g = groups.get(k)!
    const p = prod.get(e.pid)!
    const K = dec(p.k)!
    const before = running.get(k) ?? Z
    const after = before + e.dElig
    if (after < Z) throw new Error('oracle: B đủ điều kiện âm giữa chuỗi')
    running.set(k, after)
    const A = (b: bigint) => (g.met ? F(b / K, p.tiers) : Z)
    events.push({ key: `${e.kind}:${e.id}`, at: e.at, before, after, amount: A(after) - A(before) })
  }
  catalog.sort((a, b) => (a.user < b.user ? -1 : a.user > b.user ? 1 : 0))
  return { hold: null, groups: [...groups.values()].sort((a, b) => (a.user + '|' + a.pid < b.user + '|' + b.pid ? -1 : 1)), total, events, catalog }
}
