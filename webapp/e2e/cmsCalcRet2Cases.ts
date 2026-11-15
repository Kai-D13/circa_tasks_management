// CMS-CALC-RET-2 — bộ ca nghiệm thu THUẦN (spec §9 A01–A12, R01–R17; ví dụ chuẩn Q-232 §4.3). Dữ liệu giả hoàn toàn (email
// @example.test, nhà thuốc S1–S3, ProductID 9000001…). Mỗi ca mang KỲ VỌNG VIẾT TAY theo câu chữ spec (không lấy từ app / oracle);
// spec cms-calc-ret2-unit so ba phía: kỳ vọng tay = oracle độc lập (cmsCalcRet2Oracle.ts) = app (lib/cms/calc/net.ts).
// Không có ca "huỷ trả rồi phục hồi" (Q-229) và không ca phân bổ refund theo giá gốc (Q-230).

import type { OracleCase, OracleProduct, OracleReturnRow, OracleSaleRow } from './cmsCalcRet2Oracle'

export interface CalcCaseExpect {
  /** Mã HOLD (tập, đã sắp) — có ⇒ không có kết quả. */
  hold?: string[]
  /** Kỳ vọng theo nhóm (user|pid): chỉ trường được ghi mới so. */
  groups?: Record<string, Partial<{ q: number; amount: number; netGmv: number; eligNet: number; netBase: number; met: boolean }>>
  total?: number
  /** Lý do loại phiếu trả (đếm). */
  excludedReturns?: Record<string, number>
  /** Lớp lượng dòng INCLUDED (đếm). */
  classes?: Record<string, number>
  /** r1.1 — TOÀN BỘ lịch sử theo thứ tự contract D1: [khoá, tiền phân bổ]. */
  events?: [string, number][]
  /** r1.1 — mốc gate của nhóm (user|pid): mốc `at()` hoặc null. */
  metAt?: Record<string, string | null>
}
export interface CalcCase { id: string; title: string; c: OracleCase; expect: CalcCaseExpect }

export const P1 = '9000001', P2 = '9000002', P3 = '9000003'
const U1 = 'u-1', U2 = 'u-2'
const tier = (amount = 25000): OracleProduct['tiers'] => [{ from: 1, to: null, amount }]
export const prod = (pid: string, o: Partial<OracleProduct> = {}): OracleProduct =>
  ({ pid, basis: 'none', target: null, k: '100', unit: 'hộp', tiers: tier(), ...o })

let seq = 0
/** Mốc trong kỳ 12/2026 (UTC, cách nhau theo phút). */
export const at = (day: number, minute = 0) => `2026-12-${String(day).padStart(2, '0')}T03:${String(minute % 60).padStart(2, '0')}:00.000000Z`
export function sale(id: string, o: Partial<OracleSaleRow> = {}): OracleSaleRow {
  seq += 1
  return { id, order: `o-${id}`, code: `DHC${id}`, pid: P1, email: 'a@example.test', pos: 'POS01', type: 'OFFLINE', status: 'COMPLETED', at: at(5, seq), q: '2', u: 'hộp', b: '200', g: '50000', ...o }
}
export function ret(id: string, s: OracleSaleRow, r: string, h: string, o: Partial<OracleReturnRow> = {}): OracleReturnRow {
  return { id, doc: `rt-${id}`, status: 'COMPLETED', at: at(20, 1), ref: s.id, order: s.order, pid: s.pid, r, h, ...o }
}
export function base(o: Partial<OracleCase> = {}): OracleCase {
  return {
    quantityBasis: 'cms_unit', returnsPolicy: 'net_returns_v1', start: '2026-12-01', end: '2026-12-31', catalogTarget: null, stores: ['S1', 'S2'],
    products: [prod(P1)],
    users: [
      { id: U1, email: 'a@example.test', role: 'staff', store: 'S1' },
      { id: U2, email: 'b@example.test', role: 'staff', store: 'S2' },
      { id: 'u-qlch', email: 'qlch@example.test', role: 'store_manager', store: 'S1' },
    ],
    storeRefs: [{ id: 'S1', type: 'os', active: true }, { id: 'S2', type: 'os', active: true }, { id: 'S3', type: 'fs', active: true }],
    sales: [], returns: [], asOf: '2027-01-10T00:00:00.000000Z', ...o,
  }
}
const g1 = (pid = P1, user = U1) => `${user}|${pid}`

const A: CalcCase[] = []
const add = (id: string, title: string, c: OracleCase, expect: CalcCaseExpect) => A.push({ id, title, c, expect })

// ── A: tính lượng không trả ──
{
  const s = Array.from({ length: 20 }, (_, i) => sale(`a01-${i}`, { q: '5', u: 'viên', b: '5', g: '10000' }))
  add('A01', 'pos_base 20 đơn × 5 viên, K100 ⇒ Q1 = 25.000 (floor sau cộng)', base({ quantityBasis: 'pos_base', returnsPolicy: 'sales_only_v1', sales: s }),
    { groups: { [g1()]: { q: 1, amount: 25000, netGmv: 200000, eligNet: 100 } }, total: 25000, classes: { POS_BASE: 20 } })
  add('A02', 'cms_unit cùng 20 đơn × 5 viên, unit_CMS hộp ⇒ Q0, CMS 0; GMV còn đủ 200.000', base({ returnsPolicy: 'sales_only_v1', sales: s }),
    { groups: { [g1()]: { q: 0, amount: 0, netGmv: 200000, eligNet: 0, netBase: 100 } }, total: 0, classes: { OTHER_UNIT: 20 } })
}
add('A03', 'cms_unit 1 hộp + 1 hộp (q1 / b100 mỗi đơn) ⇒ Q2 = 50.000',
  base({ sales: [sale('a03-1', { q: '1', b: '100' }), sale('a03-2', { q: '1', b: '100' })] }),
  { groups: { [g1()]: { q: 2, amount: 50000 } }, total: 50000, classes: { COUNTED: 2 } })
add('A04', 'cms_unit 0,5 hộp + 0,5 hộp ⇒ Q0, FRACTIONAL ×2, KHÔNG HOLD vì lẻ; GMV vẫn tính',
  base({ sales: [sale('a04-1', { q: '0.5', b: '50', g: '20000' }), sale('a04-2', { q: '0.5', b: '50', g: '20000' })] }),
  { groups: { [g1()]: { q: 0, amount: 0, netGmv: 40000, netBase: 100, eligNet: 0 } }, total: 0, classes: { FRACTIONAL_QUANTITY: 2 } })
add('A05', 'cms_unit 1,5 hộp ⇒ Q0 (không floor thành 1)', base({ sales: [sale('a05', { q: '1.5', b: '150' })] }),
  { groups: { [g1()]: { q: 0, amount: 0, netBase: 150 } }, total: 0, classes: { FRACTIONAL_QUANTITY: 1 } })
add('A06', 'cms_unit 2.0 / 2.000000000 hộp, b200 ⇒ biểu diễn decimal nguyên được nhận',
  base({ sales: [sale('a06-1', { q: '2.0', b: '200' }), sale('a06-2', { q: '2.000000000', b: '200' })] }),
  { groups: { [g1()]: { q: 4, amount: 100000 } }, total: 100000, classes: { COUNTED: 2 } })
add('A07', 'cms_unit 1 hộp nhưng b99, K100 ⇒ HOLD BASE_QTY_MISMATCH (không sửa B / K)', base({ sales: [sale('a07', { q: '1', b: '99' })] }),
  { hold: ['BASE_QTY_MISMATCH'] })
add('A08a', 'cms_unit HỘP / NBSP hai đầu / NFD ⇒ khớp hộp; vỉ ⇒ OTHER_UNIT',
  base({ sales: [
    sale('a08-1', { q: '1', u: 'HỘP', b: '100' }),
    sale('a08-2', { q: '1', u: ' hộp ', b: '100' }),
    sale('a08-3', { q: '1', u: 'hộp', b: '100' }),
    sale('a08-4', { q: '1', u: 'vỉ', b: '10' }),
  ] }),
  { groups: { [g1()]: { q: 3, amount: 75000, netBase: 310 } }, total: 75000, classes: { COUNTED: 3, OTHER_UNIT: 1 } })
add('A08b', 'cms_unit "Hộp" + U+FEFF ⇒ HOLD UNIT_INVALID (không strip rồi tính khớp)', base({ sales: [sale('a08b', { q: '1', u: 'Hộp﻿', b: '100' })] }),
  { hold: ['UNIT_INVALID'] })
add('A08c', 'cms_unit đơn vị có tab (ký tự điều khiển) ⇒ HOLD UNIT_INVALID', base({ sales: [sale('a08c', { q: '1', u: 'hộp\t', b: '100' })] }),
  { hold: ['UNIT_INVALID'] })
add('A09a', 'cms_unit đơn vị NULL ⇒ HOLD UNIT_MISSING', base({ sales: [sale('a09a', { u: null })] }), { hold: ['UNIT_MISSING'] })
add('A09b', 'cms_unit số lượng NULL / sai số ⇒ HOLD QTY_MISSING + QTY_INVALID',
  base({ sales: [sale('a09b-1', { q: null }), sale('a09b-2', { q: '1,5' })] }), { hold: ['QTY_INVALID', 'QTY_MISSING'] })
add('A09c', 'pos_base q / u NULL hoặc lẻ ⇒ KHÔNG thêm ràng buộc (luật hiện hành), cộng b',
  base({ quantityBasis: 'pos_base', sales: [sale('a09c-1', { q: null, u: null, b: '60' }), sale('a09c-2', { q: '0.5', u: 'hộp', b: '50' })] }),
  { groups: { [g1()]: { q: 1, amount: 25000, eligNet: 110 } }, total: 25000, classes: { POS_BASE: 2 } })
add('A10', 'pos_base cùng ProductID 2 dược sĩ, 2 SP, dòng ngoài kỳ ⇒ không gộp chéo / chuyển dư',
  base({ quantityBasis: 'pos_base', products: [prod(P1), prod(P2)], sales: [
    sale('a10-1', { b: '150' }), sale('a10-2', { b: '50', email: 'b@example.test' }), sale('a10-3', { pid: P2, b: '50' }),
    sale('a10-4', { b: '50', at: '2026-11-30T16:59:59.999999Z' }),
  ] }),
  { groups: { [g1()]: { q: 1, amount: 25000, eligNet: 150 }, [g1(P1, U2)]: { q: 0, amount: 0 }, [g1(P2)]: { q: 0, amount: 0 } }, total: 25000 })
add('A11a', 'pos_base B = 99,999999999 / K100 ⇒ Q0 (không epsilon)', base({ quantityBasis: 'pos_base', sales: [sale('a11a', { b: '99.999999999' })] }),
  { groups: { [g1()]: { q: 0, amount: 0 } }, total: 0 })
add('A11b', 'pos_base B = 100 / K100 ⇒ Q1', base({ quantityBasis: 'pos_base', sales: [sale('a11b', { b: '100' })] }),
  { groups: { [g1()]: { q: 1, amount: 25000 } }, total: 25000 })
add('A12', 'Q20 thang 1–9 @15k / 10–19 @20k / từ 20 @25k ⇒ 360.000 (không 400 / 500 nghìn)',
  base({ products: [prod(P1, { tiers: [{ from: 1, to: 9, amount: 15000 }, { from: 10, to: 19, amount: 20000 }, { from: 20, to: null, amount: 25000 }] })],
    sales: [sale('a12', { q: '20', b: '2000', g: '1000000' })] }),
  { groups: { [g1()]: { q: 20, amount: 360000 } }, total: 360000 })

// ── R: trả hàng ──
for (const basis of ['pos_base', 'cms_unit'] as const) {
  const s = sale(`r01-${basis}`)
  add(`R01-${basis}`, `${basis}: bán 2 hộp, trả COMPLETED 5 viên ⇒ Q1 = 25.000 (Q-232)`,
    base({ quantityBasis: basis, sales: [s], returns: [ret(`r01-${basis}-1`, s, '5', '1250')] }),
    { groups: { [g1()]: { q: 1, amount: 25000, eligNet: 195, netBase: 195, netGmv: 48750 } }, total: 25000 })
}
{
  // Bảng chuẩn §4.3 (cms_unit, K100, 25.000, hai hộp q2 / b200).
  const rows: [string, string[], number, number][] = [['none', [], 2, 50000], ['5', ['5'], 1, 25000], ['2+3', ['2', '3'], 1, 25000], ['101', ['101'], 0, 0], ['200', ['200'], 0, 0]]
  for (const [label, rs, q, amount] of rows) {
    const s = sale(`q232-${label}`)
    add(`Q232-${label}`, `Q-232 bảng chuẩn: trả ${label} ⇒ Q${q} / ${amount}`,
      base({ sales: [s], returns: rs.map((r, i) => ret(`q232-${label}-${i}`, s, r, '0', { at: at(21, i * 7) })) }),
      { groups: { [g1()]: { q, amount, eligNet: 200 - rs.reduce((a, r) => a + Number(r), 0) } }, total: amount })
  }
}
{
  const s1 = sale('r02a'), s2 = sale('r02b')
  add('R02', 'trả 2 + 3 viên (hai phiếu) ≡ trả 5: cùng Q1 — không nhân quantity của phiếu, không floor từng phiếu',
    base({ sales: [s1], returns: [ret('r02-1', s1, '2', '500'), ret('r02-2', s1, '3', '750', { at: at(22) })] }),
    { groups: { [g1()]: { q: 1, amount: 25000, netGmv: 48750 } }, total: 25000 })
  add('R02b', 'đối chứng trả 5 một phiếu', base({ sales: [s2], returns: [ret('r02b-1', s2, '5', '1250')] }),
    { groups: { [g1()]: { q: 1, amount: 25000, netGmv: 48750 } }, total: 25000 })
}
{
  const s = sale('r03')
  add('R03', 'trả toàn bộ 200 viên + toàn bộ refund ⇒ Q0, B ròng 0, GMV ròng 0', base({ sales: [s], returns: [ret('r03-1', s, '200', '50000')] }),
    { groups: { [g1()]: { q: 0, amount: 0, netBase: 0, netGmv: 0, eligNet: 0 } }, total: 0 })
}
{
  const s = sale('r04a')
  add('R04a', 'phiếu APPROVED, completed_at NULL ⇒ không trừ (chưa hiệu lực)',
    base({ sales: [s], returns: [ret('r04a-1', s, '100', '25000', { status: 'APPROVED', at: null })] }),
    { groups: { [g1()]: { q: 2, amount: 50000 } }, total: 50000, excludedReturns: { NOT_COMPLETED: 1 } })
  const t = sale('r04b')
  add('R04b', 'phiếu COMPLETED thiếu completed_at ⇒ lỗi nguồn (HOLD), không giả 0 / bỏ dòng',
    base({ sales: [t], returns: [ret('r04b-1', t, '100', '25000', { at: null })] }), { hold: ['SOURCE_ROW_INVALID'] })
}
{
  const s = sale('r05', { g: '50000' })
  add('R05', 'chỉ trừ refund_amount (20.000) — không phân bổ theo giá gốc (25.000): GMV ròng 30.000 đạt target 30.000',
    base({ products: [prod(P1, { basis: 'product', target: '30000' })], sales: [s], returns: [ret('r05-1', s, '100', '20000')] }),
    { groups: { [g1()]: { q: 1, amount: 25000, netGmv: 30000, met: true } }, total: 25000 })
}
{
  const c = sale('r06-c'), o = sale('r06-o', { q: '50', u: 'viên', b: '50', g: '10000' }), f = sale('r06-f', { q: '0.5', b: '50', g: '12000' })
  add('R06', 'cms_unit: trả gắn OTHER_UNIT / FRACTIONAL ⇒ giảm GMV / B thật, KHÔNG giảm B đủ / Q',
    base({ sales: [c, o, f], returns: [ret('r06-1', o, '50', '10000'), ret('r06-2', f, '20', '5000')] }),
    { groups: { [g1()]: { q: 2, amount: 50000, eligNet: 200, netBase: 230, netGmv: 57000 } }, total: 50000,
      classes: { COUNTED: 1, OTHER_UNIT: 1, FRACTIONAL_QUANTITY: 1 } })
}
{
  const c = sale('r07-c'), o = sale('r07-o', { q: '100', u: 'viên', b: '100', g: '20000' })
  add('R07', 'cms_unit: COUNTED 200 + OTHER_UNIT 100, trả 100 của OTHER_UNIT ⇒ Q2 (không dùng B thật 200 để trừ Q)',
    base({ sales: [c, o], returns: [ret('r07-1', o, '100', '20000')] }),
    { groups: { [g1()]: { q: 2, amount: 50000, eligNet: 200, netBase: 200 } }, total: 50000 })
}
{
  const s = sale('r08')
  add('R08', 'hai phiếu cùng dòng, Σ trả 250 > bán 200 ⇒ HOLD cả lượt (không max 0)',
    base({ sales: [s, sale('r08-other')], returns: [ret('r08-1', s, '150', '0'), ret('r08-2', s, '100', '0', { at: at(22) })] }),
    { hold: ['RETURN_EXCEEDS_SALE_BASE'] })
  const t = sale('r08g', { g: '50000' })
  add('R08g', 'Σ refund > GMV dòng gốc ⇒ HOLD (chưa có quyết định cho trường hợp vượt)',
    base({ sales: [t], returns: [ret('r08g-1', t, '5', '50001')] }), { hold: ['RETURN_EXCEEDS_SALE_GMV'] })
}
{
  const s = sale('r09')
  add('R09a', 'phiếu ghi sai đơn gốc ⇒ HOLD RETURN_CONTEXT_MISMATCH', base({ sales: [s], returns: [ret('r09a', s, '5', '0', { order: 'o-khac' })] }),
    { hold: ['RETURN_CONTEXT_MISMATCH'] })
  add('R09b', 'phiếu ghi sai ProductID ⇒ HOLD', base({ products: [prod(P1), prod(P2)], sales: [s], returns: [ret('r09b', s, '5', '0', { pid: P2 })] }),
    { hold: ['RETURN_CONTEXT_MISMATCH'] })
  add('R09c', 'gốc thuộc chương trình nhưng không có trong lớp bán ⇒ HOLD RETURN_ORIGIN_MISSING (không INNER JOIN cho xanh)',
    base({ sales: [s], returns: [ret('r09c', s, '5', '0', { ref: 'khong-co', o: { at: s.at, type: 'OFFLINE', status: 'COMPLETED', email: s.email, pos: 'POS01', b: '200', g: '50000', q: '2', u: 'hộp' } })] }),
    { hold: ['RETURN_ORIGIN_MISSING'] })
  add('R09d', 'trùng return_event_id khác tiền ⇒ HOLD (không DISTINCT / MAX)',
    base({ sales: [s], returns: [ret('r09d', s, '5', '1000'), ret('r09d', s, '5', '2000')] }), { hold: ['RETURN_DUPLICATE_ID'] })
  add('R09f', 'pos_base: q / u gốc trên phiếu khác lớp bán ⇒ KHÔNG so (luật lẻ không dùng q / u), vẫn trừ đúng',
    base({ quantityBasis: 'pos_base', sales: [s], returns: [ret('r09f', s, '5', '0', { o: { at: s.at, type: 'OFFLINE', status: 'COMPLETED', email: s.email, pos: 'POS01', b: '200', g: '50000', q: '1', u: 'viên' } })] }),
    { groups: { [g1()]: { q: 1, amount: 25000 } }, total: 25000 })
  add('R14b', 'người bán gốc trên phiếu ≠ người bán của dòng đã lưu ⇒ HOLD (không tự chọn người hưởng)',
    base({ sales: [s], returns: [ret('r14b', s, '5', '0', { o: { at: s.at, type: 'OFFLINE', status: 'COMPLETED', email: 'b@example.test', pos: 'POS01', b: '200', g: '50000', q: '2', u: 'hộp' } })] }),
    { hold: ['RETURN_CONTEXT_MISMATCH'] })
  add('R09e','ngữ cảnh gốc lệch B / G với lớp bán đã lưu (nguồn bán đã net?) ⇒ HOLD',
    base({ sales: [s], returns: [ret('r09e', s, '5', '0', { o: { at: s.at, type: 'OFFLINE', status: 'COMPLETED', email: s.email, pos: 'POS01', b: '195', g: '50000', q: '2', u: 'hộp' } })] }),
    { hold: ['RETURN_CONTEXT_MISMATCH'] })
}
{
  const s = sale('r11', { b: '200' })
  add('R11', 'nguồn bán đã net (dòng bán âm) dưới net_returns ⇒ HOLD NEGATIVE_SALE — không trừ kép',
    base({ quantityBasis: 'pos_base', sales: [s, sale('r11-neg', { q: '-1', b: '-5', g: '-1250' })], returns: [ret('r11-1', s, '5', '1250')] }),
    { hold: ['NEGATIVE_SALE'] })
}
{
  const s = sale('r12')
  add('R12', 'bán trong kỳ 12, trả tháng sau (trước as_of) ⇒ điều chỉnh vào kỳ bán, không đẩy sang kỳ sau',
    base({ sales: [s], returns: [ret('r12-1', s, '5', '0', { at: '2027-01-05T02:00:00.000000Z' })] }),
    { groups: { [g1()]: { q: 1, amount: 25000 } }, total: 25000 })
  add('R12b', 'phiếu COMPLETED SAU as_of ⇒ HOLD (snapshot không nhất quán)',
    base({ sales: [s], returns: [ret('r12b-1', s, '5', '0', { at: '2027-01-11T00:00:00.000000Z' })] }), { hold: ['RETURN_AFTER_AS_OF'] })
  add('R12c', 'ngày trả trước ngày bán gốc ⇒ HOLD', base({ sales: [s], returns: [ret('r12c-1', s, '5', '0', { at: '2026-12-01T00:00:00.000000Z' })] }),
    { hold: ['RETURN_BEFORE_SALE'] })
}
{
  const s = sale('r14'), t = sale('r14-b', { email: 'b@example.test' })
  add('R14', 'người xử lý phiếu khác người bán gốc: trừ người bán GỐC (U1), U2 không đổi',
    base({ sales: [s, t], returns: [ret('r14-1', s, '5', '0')] }),
    { groups: { [g1()]: { q: 1, amount: 25000 }, [g1(P1, U2)]: { q: 2, amount: 50000 } }, total: 75000 })
}
{
  const s = sale('r15', { g: '110000' })
  add('R15', 'gate 100.000: gross 110.000, refund 20.000 ⇒ GMV ròng 90.000 chưa đạt ⇒ CMS 0 dù Q1',
    base({ products: [prod(P1, { basis: 'product', target: '100000' })], sales: [s], returns: [ret('r15-1', s, '5', '20000')] }),
    { groups: { [g1()]: { q: 1, amount: 0, netGmv: 90000, met: false } }, total: 0 })
}
{
  const a = sale('r16-a', { pid: P1, q: '1', b: '100', g: '60000' }), b2 = sale('r16-b', { pid: P2, q: '1', b: '100', g: '50000' })
  const prods = [prod(P1, { basis: 'catalog' }), prod(P2, { basis: 'catalog' })]
  add('R16a', 'gate danh mục 100.000: hai SP 110.000 ⇒ đạt, mỗi SP Q1', base({ catalogTarget: '100000', products: prods, sales: [a, b2] }),
    { groups: { [g1(P1)]: { q: 1, amount: 25000, met: true }, [g1(P2)]: { q: 1, amount: 25000, met: true } }, total: 50000 })
  add('R16b', 'trả 1 viên + 20.000 ở SP2 ⇒ danh mục 90.000 rớt gate ⇒ tính lại cả nhóm (SP1 cũng 0)',
    base({ catalogTarget: '100000', products: prods, sales: [a, b2], returns: [ret('r16-1', b2, '1', '20000')] }),
    { groups: { [g1(P1)]: { q: 1, amount: 0, met: false }, [g1(P2)]: { q: 0, amount: 0, met: false } }, total: 0 })
}
{
  const s = sale('r17', { g: '50000' })
  add('R17', 'refund 0 với lượng trả > 0 ⇒ Q giảm theo lượng, GMV không đổi (vẫn đạt target 50.000)',
    base({ products: [prod(P1, { basis: 'product', target: '50000' })], sales: [s], returns: [ret('r17-1', s, '100', '0')] }),
    { groups: { [g1()]: { q: 1, amount: 25000, netGmv: 50000, met: true } }, total: 25000 })
}
{
  const s = sale('rx-1'), u = sale('rx-2', { email: 'qlch@example.test' })
  add('RX1', 'phiếu ngoài chương trình / gắn dòng chưa gán ⇒ loại có lý do, không HOLD',
    base({ products: [prod(P1)], sales: [s, u], returns: [
      ret('rx-out', s, '1', '0', { ref: 'ngoai', pid: P3, o: { at: at(3), type: 'OFFLINE', status: 'COMPLETED', email: 'a@example.test', pos: 'POS01', b: '10', g: '1000', q: '1', u: 'hộp' } }),
      ret('rx-win', s, '1', '0', { ref: 'ky-truoc', o: { at: '2026-11-20T03:00:00.000000Z', type: 'OFFLINE', status: 'COMPLETED', email: 'a@example.test', pos: 'POS01', b: '10', g: '1000', q: '1', u: 'hộp' } }),
      ret('rx-un', u, '5', '0'),
    ] }),
    { groups: { [g1()]: { q: 2, amount: 50000 } }, total: 50000, excludedReturns: { ORIGIN_NOT_IN_PROGRAM: 1, ORIGIN_OUT_OF_WINDOW: 1, ORIGIN_UNASSIGNED: 1 } })
}
add('RX2', 'cms_unit q = 0 nhưng có B / G ⇒ HOLD ZERO_QTY_WITH_VALUE; q = b = g = 0 ⇒ ZERO_QUANTITY',
  base({ sales: [sale('rx2-1', { q: '0', b: '0', g: '0' }), sale('rx2-2', { q: '0', b: '100', g: '0' })] }), { hold: ['ZERO_QTY_WITH_VALUE'] })
add('RX4', 'ĐỀ XUẤT D7: cms_unit, dòng CHƯA GÁN (tài khoản dùng chung) có ĐV vô hình ⇒ HOLD cả lượt (fail-closed, chờ PM)',
  base({ sales: [sale('rx4-ok'), sale('rx4-un', { email: 'qlch@example.test', u: 'hộp​' })] }), { hold: ['UNIT_INVALID'] })
{
  const s = sale('rx5')
  add('RX5', 'ĐỀ XUẤT D8: trùng return_event_id GIỐNG HỆT (join nhân bản) ⇒ HOLD, không DISTINCT', base({ sales: [s], returns: [ret('rx5', s, '5', '1000'), ret('rx5', s, '5', '1000')] }),
    { hold: ['RETURN_DUPLICATE_ID'] })
  add('RX6', 'trạng thái "Completed" (sai hoa / thường) ⇒ lỗi nguồn, không coi là chưa hiệu lực', base({ sales: [s], returns: [ret('rx6', s, '5', '0', { status: 'Completed' })] }),
    { hold: ['SOURCE_ROW_INVALID'] })
}
add('RX3','cms_unit q = b = g = 0 ⇒ ZERO_QUANTITY, không HOLD', base({ sales: [sale('rx3-1', { q: '0', b: '0', g: '0' }), sale('rx3-2')] }),
  { groups: { [g1()]: { q: 2, amount: 50000 } }, total: 50000, classes: { ZERO_QUANTITY: 1, COUNTED: 1 } })

// ── r1.1 (PM review P1/P2 r1 13/11): D1 thứ tự contract, D13 từ điển trạng thái, phân bổ từng sự kiện + mốc gate ──
{
  // 8 dòng cùng µs, mỗi dòng 1 hộp; bậc lũy tiến 1.000 × vị trí ⇒ tiền từng dòng lộ đúng vị trí trong thứ tự.
  // D1: ID số theo GIÁ TRỊ trước (2 < 7 < 10; cùng giá trị so chuỗi: 02 < 2, 007 < 7), rồi ID text theo BYTE UTF-8:
  // a (61) < U+E000 (EE 80 80) < U+10000 (F0 90 80 80). Thứ tự code unit UTF-16 của engine legacy đảo hai ID cuối (D800 < E000).
  const tiers: OracleProduct['tiers'] = Array.from({ length: 8 }, (_, i) => ({ from: i + 1, to: i === 7 ? null : i + 1, amount: (i + 1) * 1000 }))
  const ids = ['\u{10000}x', 'a', '10', '7', 'x', '2', '007', '02']
  add('RX7', 'D1: SALE cùng µs — ID số theo giá trị (tie theo chuỗi, số 0 đầu), rồi text theo byte UTF-8 (ngoài BMP); tiền từng dòng theo vị trí',
    base({ products: [prod(P1, { tiers })], sales: ids.map((id) => sale(id, { at: at(9, 0), q: '1', b: '100', g: '1000' })) }),
    {
      groups: { [g1()]: { q: 8, amount: 36000 } }, total: 36000,
      events: [['SALE:02', 1000], ['SALE:2', 2000], ['SALE:007', 3000], ['SALE:7', 4000], ['SALE:10', 5000], ['SALE:a', 6000], ['SALE:x', 7000], ['SALE:\u{10000}x', 8000]],
    })
}
{
  // Phiếu trả cùng µs theo byte UTF-8: b (62) < U+FFFF (EF BF BF) < U+1F600 (F0 9F 98 80); UTF-16 sẽ đặt U+1F600 (D83D) trước U+FFFF.
  // B đủ 300 → 200 (Q3→2: −30.000) → 100 (Q2→1: −20.000) → 50 (Q1→0: −10.000).
  const s = sale('rx8', { q: '3', b: '300', g: '90000' })
  const tiers: OracleProduct['tiers'] = [{ from: 1, to: 1, amount: 10000 }, { from: 2, to: 2, amount: 20000 }, { from: 3, to: null, amount: 30000 }]
  add('RX8', 'D1: RETURN cùng µs theo byte UTF-8 (ngoài BMP) — phân bổ tiền âm từng phiếu theo thứ tự',
    base({ products: [prod(P1, { tiers })], sales: [s], returns: [ret('\u{1F600}', s, '50', '0'), ret('￿', s, '100', '0'), ret('b', s, '100', '0')] }),
    {
      groups: { [g1()]: { q: 0, amount: 0, eligNet: 50 } }, total: 0,
      events: [['SALE:rx8', 60000], ['RETURN:b', -30000], ['RETURN:￿', -20000], ['RETURN:\u{1F600}', -10000]],
    })
}
{
  // Gate SP 100.000 đi theo thứ tự: 60k (chưa) → 120k (đạt ở s2) → trả 30k còn 90k (rớt) → +20k = 110k (đạt lại ở s3) ⇒ mốc = s3.
  // Gate CUỐI đạt ⇒ mọi sự kiện mang tiền theo B đủ: 100 → 200 → 199 → 299 ⇒ +25k, +25k, −25k, +25k.
  const s1 = sale('rx11-1', { at: at(5, 1), q: '1', b: '100', g: '60000' })
  const s2 = sale('rx11-2', { at: at(5, 2), q: '1', b: '100', g: '60000' })
  const s3 = sale('rx11-3', { at: at(21, 0), q: '1', b: '100', g: '20000' })
  add('RX11', 'mốc gate SP = lần đạt lại CUỐI sau khi phiếu trả làm rớt gate; phân bổ từng sự kiện khi gate cuối đạt',
    base({ products: [prod(P1, { basis: 'product', target: '100000' })], sales: [s1, s2, s3], returns: [ret('rx11-r', s2, '1', '30000', { at: at(20, 1) })] }),
    {
      groups: { [g1()]: { q: 2, amount: 50000, netGmv: 110000, eligNet: 299, met: true } }, total: 50000,
      metAt: { [g1()]: at(21, 0) },
      events: [['SALE:rx11-1', 25000], ['SALE:rx11-2', 25000], ['RETURN:rx11-r', -25000], ['SALE:rx11-3', 25000]],
    })
}
{
  // D13: chỉ đúng chuỗi COMPLETED / APPROVED thuộc từ điển; còn lại là lỗi nguồn (HOLD), không im lặng thành "không có trả".
  const s = sale('rx9')
  const bad: [string, string, string][] = [
    ['RX9', 'REJECTED', 'trạng thái lạ có ID (REJECTED)'],
    ['RX10a', ' COMPLETED', 'COMPLETED có khoảng trắng đầu'],
    ['RX10b', 'COMPLETED\u0000', 'COMPLETED kèm ký tự NUL'],
    ['RX10c', 'COMPLETED​', 'COMPLETED kèm ký tự vô hình'],
    ['RX10d', 'APPROVED ', 'APPROVED có khoảng trắng cuối'],
    ['RX10e', 'approved', 'approved chữ thường'],
    ['RX10f', '', 'trạng thái rỗng'],
  ]
  for (const [id, status, title] of bad) {
    add(id, `D13: ${title} ⇒ lỗi nguồn / HOLD, không coi là chưa hiệu lực`, base({ sales: [s], returns: [ret(`${id.toLowerCase()}-r`, s, '5', '0', { status })] }),
      { hold: ['SOURCE_ROW_INVALID'] })
  }
}

export const CALC_CASES: readonly CalcCase[] = A
