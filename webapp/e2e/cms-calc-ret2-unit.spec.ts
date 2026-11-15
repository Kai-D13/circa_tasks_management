import { test, expect } from '@playwright/test'
import { CMS_DEC_FACTOR } from '../lib/cms/decimal'
import { buildSellerIndex } from '../lib/cms/mapping'
import { normalizeSalesRow, type CmsRawRow } from '../lib/cms/source/contract'
import { parseUtcMicros } from '../lib/cms/time'
import { compareCmsLineId, computeCmsProgram } from '../lib/cms/engine/compute'
import { CmsCalcConfigError, cmsCalcSaleLine, computeCmsNet, type CmsCalcInput, type CmsCalcOutput } from '../lib/cms/calc/net'
import { compareCmsCalcEvents, compareCmsContractLineId, compareUtf8Bytes } from '../lib/cms/calc/order'
import { CMS_RETURN_STATUS_DICTIONARY, CMS_RETURN_STATUS_DICTIONARY_VERSION, normalizeReturnRow, type CmsReturnRecord } from '../lib/cms/calc/returns'
import { CMS_QUANTITY_BASIS_LABEL, CMS_QUANTITY_POLICY_VERSION, parseCmsQuantityBasis, parseCmsReturnsPolicy } from '../lib/cms/calc/policy'
import { oracleCompute, type OracleCase, type OracleProduct, type OracleReturnRow, type OracleSaleRow } from './cmsCalcRet2Oracle'
import { CALC_CASES, P1, P2, P3, at, base, prod, ret, sale } from './cmsCalcRet2Cases'

// CMS-CALC-RET-2 P1 — phép tính THUẦN hai cách tính lượng × trả hàng COMPLETED (spec
// planning/research/cms-calculation-modes-returns-spec-2026-11-13.md §3–§4, §9; Q-231 / Q-232 / Q-229 / Q-230). Không DB, không mạng,
// không BigQuery, không cờ env. Ba phía độc lập: kỳ vọng viết tay (cmsCalcRet2Cases) = oracle không import app (cmsCalcRet2Oracle)
// = app (lib/cms/calc/net.ts). Thêm: vi sai ngẫu nhiên có seed app ↔ oracle, bất biến thứ tự / đọc lại, parity pos_base sales-only với
// engine hiện hành (compute.ts). Dữ liệu giả hoàn toàn.

const ZERO = BigInt(0)
const U = (n: number | string | bigint) => BigInt(n) * CMS_DEC_FACTOR

function rawSale(s: OracleSaleRow): CmsRawRow {
  return {
    order_line_id: s.id, order_id: s.order, order_code: s.code ?? s.id, product_id: s.pid, seller_email: s.email, pos_code: s.pos ?? null,
    order_type: s.type ?? 'OFFLINE', order_status: s.status ?? 'COMPLETED', completed_at: s.at, quantity_raw: s.q, uom_raw: s.u,
    base_quantity: s.b, gmv_amount: s.g, source_updated_at: s.at,
  }
}
function rawReturn(r: OracleReturnRow, sales: readonly OracleSaleRow[]): CmsRawRow {
  const s = sales.find((x) => x.id === r.ref)
  const o = r.o ?? (s ? { at: s.at, type: s.type ?? 'OFFLINE', status: s.status ?? 'COMPLETED', email: s.email, pos: s.pos ?? null, b: s.b, g: s.g, q: s.q, u: s.u } : null)
  return {
    return_event_id: r.id, return_document_id: r.doc ?? `doc-${r.id}`, return_code: r.doc ?? null, return_status: r.status,
    return_recorded_at: r.at, original_order_line_id: r.ref, original_order_id: r.order, product_id: r.pid,
    return_base_quantity: r.r, return_gmv_amount: r.h,
    original_completed_at: o?.at ?? null, original_order_type: o?.type ?? null, original_order_status: o?.status ?? null,
    original_seller_email: o?.email ?? null, original_pos_code: o?.pos ?? null, original_base_quantity: o?.b ?? null,
    original_gmv_amount: o?.g ?? null, original_quantity_raw: o?.q ?? null, original_uom_raw: o?.u ?? null, source_updated_at: null,
    // Cột người XỬ LÝ phiếu (không thuộc hợp đồng) — phải bị bỏ qua, không dùng làm người hưởng (R14).
    return_created_by: 'b@example.test',
    // Cột NHIỄU của nguồn trả (R02 / R05, Q-230): quantity / received_quantity ≠ 1, amount / base_amount / header total ≠ refund. Hợp
    // đồng chỉ đọc base_quantity tổng + refund_amount — các cột này đổi giá trị cũng không được đổi kết quả.
    quantity: '7', received_quantity: '9', unit: 'viên', amount: '99999', base_amount: '88888',
    total_item_amount: '777777', actual_total_item_amount: '666666',
  }
}

type AppRun = { sourceError: true } | { sourceError: false; input: CmsCalcInput; out: CmsCalcOutput }

function toInput(c: OracleCase): { sourceError: true } | { sourceError: false; input: CmsCalcInput } {
  const sales = c.sales.map((s) => {
    const raw = rawSale(s)
    const n = normalizeSalesRow(raw)
    if (!n.ok) throw new Error(`fixture bán lỗi ${s.id}: ${JSON.stringify(n.issues)}`)
    return cmsCalcSaleLine(raw, n.value)
  })
  const returns: CmsReturnRecord[] = []
  for (const r of c.returns) {
    const n = normalizeReturnRow(rawReturn(r, c.sales))
    if (!n.ok) return { sourceError: true }
    returns.push(n.value)
  }
  return {
    sourceError: false,
    input: {
      program: {
        startDate: c.start, endDate: c.end, catalogTargetGmv: c.catalogTarget, storeIds: c.stores,
        quantityBasis: c.quantityBasis, returnsPolicy: c.returnsPolicy,
        products: c.products.map((p) => ({ productId: p.pid, gmvBasis: p.basis, targetGmv: p.target, baseQuantityCms: p.k, unitCms: p.unit, tiers: p.tiers })),
      },
      sales, returns,
      sellers: buildSellerIndex(c.users.map((u) => ({ id: u.id, email: u.email, role: u.role, storeId: u.store })), c.storeRefs.map((s) => ({ id: s.id, storeType: s.type, isActive: s.active }))),
      asOfMicros: parseUtcMicros(c.asOf)!,
    },
  }
}
function runApp(c: OracleCase): AppRun {
  const t = toInput(c)
  if (t.sourceError) return t
  return { sourceError: false, input: t.input, out: computeCmsNet(t.input) }
}
const appHolds = (r: AppRun): string[] | null =>
  r.sourceError ? ['SOURCE_ROW_INVALID'] : r.out.ok ? null : [...new Set(r.out.holds.map((h) => h.code))].sort()

/** So app ↔ oracle: mọi nhóm / mọi trường tổng + mốc gate; r1.1 thêm TỪNG SỰ KIỆN (thứ tự D1, B trước / sau, tiền) và gate danh mục. */
function compareWithOracle(c: OracleCase, r: AppRun) {
  const o = oracleCompute(c)
  expect(appHolds(r), 'tập HOLD app = oracle').toEqual(o.hold)
  if (o.hold !== null || r.sourceError || !r.out.ok) return
  const appGroups = r.out.results.map((g) => ({
    user: g.userId, pid: g.productId, saleBase: g.saleBaseUnits, retBase: g.returnBaseUnits, netBase: g.netBaseUnits,
    eligSale: g.eligibleSaleBaseUnits, eligRet: g.eligibleReturnBaseUnits, eligNet: g.eligibleNetBaseUnits, q: g.cmsQuantity,
    saleGmv: g.saleGmvUnits, retGmv: g.returnGmvUnits, netGmv: g.netGmvUnits, met: g.gate.met, amount: g.amountVnd, metAt: g.gate.metAtMicros,
  })).sort((a, b) => (`${a.user}|${a.pid}` < `${b.user}|${b.pid}` ? -1 : 1))
  expect(appGroups, 'nhóm app = oracle').toEqual(o.groups)
  expect(r.out.totals.amountVnd).toBe(o.total)
  expect(r.out.history.map((h) => ({ key: h.key, at: h.atMicros, before: h.eligibleBeforeUnits, after: h.eligibleAfterUnits, amount: h.amountVnd })),
    'phân bổ từng sự kiện app = oracle (thứ tự D1)').toEqual(o.events)
  expect(r.out.catalog.map((x) => ({ user: x.userId, met: x.met, metAt: x.metAtMicros })), 'gate danh mục app = oracle').toEqual(o.catalog)
}

/** Bất biến nội bộ của output app: Σ tiền sự kiện = tiền nhóm = tổng; khoá lịch sử duy nhất, namespaced. */
function checkInvariants(out: CmsCalcOutput) {
  if (!out.ok) return
  const byGroup = new Map<string, bigint>()
  for (const h of out.history) byGroup.set(`${h.userId}|${h.productId}`, (byGroup.get(`${h.userId}|${h.productId}`) ?? ZERO) + h.amountVnd)
  for (const g of out.results) expect(byGroup.get(`${g.userId}|${g.productId}`) ?? ZERO).toBe(g.amountVnd)
  expect(out.results.reduce((a, g) => a + g.amountVnd, ZERO)).toBe(out.totals.amountVnd)
  const keys = out.history.map((h) => h.key)
  expect(new Set(keys).size).toBe(keys.length)
  for (const h of out.history) expect(h.key.startsWith(h.kind === 'SALE' ? 'SALE:' : 'RETURN:')).toBe(true)
  for (const g of out.results) {
    expect(g.cmsQuantity).toBe(g.eligibleNetBaseUnits > ZERO ? g.eligibleNetBaseUnits / g.perUnitUnits : ZERO)
    expect(g.remainderBaseUnits >= ZERO && g.remainderBaseUnits < g.perUnitUnits).toBe(true)
  }
}

test.describe('CMS-CALC-RET-2 P1 · bảng AC (kỳ vọng tay = oracle = app) @desktop', () => {
  for (const cc of CALC_CASES) {
    test(`${cc.id} — ${cc.title}`, () => {
      const r = runApp(cc.c)
      const o = oracleCompute(cc.c)
      expect(o.hold, 'oracle ↔ kỳ vọng tay (HOLD)').toEqual(cc.expect.hold ?? null)
      compareWithOracle(cc.c, r)
      if (cc.expect.hold) return
      if (r.sourceError || !r.out.ok) throw new Error('app không có kết quả')
      checkInvariants(r.out)
      for (const [key, e] of Object.entries(cc.expect.groups ?? {})) {
        const [user, pid] = key.split('|')
        const g = r.out.results.find((x) => x.userId === user && x.productId === pid)
        expect(g, `nhóm ${key}`).toBeTruthy()
        if (e.q !== undefined) expect(g!.cmsQuantity, `${key} Q`).toBe(BigInt(e.q))
        if (e.amount !== undefined) expect(g!.amountVnd, `${key} CMS`).toBe(BigInt(e.amount))
        if (e.netGmv !== undefined) expect(g!.netGmvUnits, `${key} GMV ròng`).toBe(U(e.netGmv))
        if (e.eligNet !== undefined) expect(g!.eligibleNetBaseUnits, `${key} B đủ ròng`).toBe(U(e.eligNet))
        if (e.netBase !== undefined) expect(g!.netBaseUnits, `${key} B thật ròng`).toBe(U(e.netBase))
        if (e.met !== undefined) expect(g!.gate.met, `${key} gate`).toBe(e.met)
      }
      if (cc.expect.total !== undefined) expect(r.out.totals.amountVnd).toBe(BigInt(cc.expect.total))
      if (cc.expect.excludedReturns) expect(r.out.totals.returnsExcludedByReason).toEqual(cc.expect.excludedReturns)
      if (cc.expect.classes) {
        const nz = Object.fromEntries(Object.entries(r.out.totals.classCounts).filter(([, n]) => n > 0))
        expect(nz).toEqual(cc.expect.classes)
      }
      if (cc.expect.events) expect(r.out.history.map((h) => [h.key, Number(h.amountVnd)]), 'lịch sử theo thứ tự + tiền (kỳ vọng tay)').toEqual(cc.expect.events)
      for (const [key, m] of Object.entries(cc.expect.metAt ?? {})) {
        const [user, pid] = key.split('|')
        const g = r.out.results.find((x) => x.userId === user && x.productId === pid)
        expect(g?.gate.metAtMicros, `${key} mốc gate`).toBe(m === null ? null : parseUtcMicros(m))
      }
    })
  }
})

test.describe('CMS-CALC-RET-2 P1 · hợp đồng / chính sách @desktop', () => {
  test('enum cấp chương trình: parse chính xác, nhãn UI, phiên bản cms_unit_v2 ≠ v1 của CMS-UNIT; giá trị lạ ⇒ null (fail-closed)', () => {
    expect(parseCmsQuantityBasis('pos_base')).toBe('pos_base')
    expect(parseCmsQuantityBasis('cms_unit')).toBe('cms_unit')
    for (const bad of [' pos_base', 'POS_BASE', 'cms-unit', '', null, undefined, 1]) expect(parseCmsQuantityBasis(bad)).toBeNull()
    expect(parseCmsReturnsPolicy('net_returns_v1')).toBe('net_returns_v1')
    expect(parseCmsReturnsPolicy('net')).toBeNull()
    expect(CMS_QUANTITY_BASIS_LABEL).toEqual({ pos_base: 'Tính lẻ — cộng dồn quy đổi', cms_unit: 'Tính nguyên — đúng đơn vị CMS' })
    expect(CMS_QUANTITY_POLICY_VERSION.cms_unit).toBe('cms_unit_v2')
  })

  test('run sales_only_v1 nhận bản ghi trả ⇒ lỗi cấu hình (không âm thầm bỏ trả hay tự đổi sang net); cách tính lạ ⇒ lỗi', () => {
    const s = sale('cfg-1')
    const t = toInput(base({ returnsPolicy: 'sales_only_v1', sales: [s] }))
    if (t.sourceError) throw new Error('fixture')
    const r = normalizeReturnRow(rawReturn(ret('cfg-r', s, '5', '0'), [s]))
    if (!r.ok) throw new Error('fixture')
    expect(() => computeCmsNet({ ...t.input, returns: [r.value] })).toThrow(CmsCalcConfigError)
    expect(() => computeCmsNet({ ...t.input, program: { ...t.input.program, quantityBasis: 'tinh_nguyen' as never } })).toThrow(/BAD_QUANTITY_BASIS/)
    expect(() => computeCmsNet({ ...t.input, program: { ...t.input.program, returnsPolicy: 'net' as never } })).toThrow(/BAD_RETURNS_POLICY/)
  })

  test('cms_unit: unit_CMS rỗng / chỉ khoảng trắng / có ký tự vô hình ⇒ UNIT_CMS_INVALID; pos_base không đòi unit_CMS', () => {
    for (const unit of [null, '', '   ', 'hộp​']) {
      const t = toInput(base({ products: [prod(P1, { unit })], sales: [sale(`u-${String(unit)}`)] }))
      if (t.sourceError) throw new Error('fixture')
      expect(() => computeCmsNet(t.input)).toThrow(/UNIT_CMS_INVALID/)
    }
    const t = toInput(base({ quantityBasis: 'pos_base', products: [prod(P1, { unit: null })], sales: [sale('u-pos')] }))
    if (t.sourceError) throw new Error('fixture')
    expect(computeCmsNet(t.input).ok).toBe(true)
  })

  test('chuẩn hoá phiếu trả: APPROVED thiếu ngày hợp lệ (NOT_EFFECTIVE); COMPLETED thiếu ref / lượng ≤ 0 / lượng lẻ / refund âm ⇒ lỗi nguồn; không mang giá trị vào issue', () => {
    const s = sale('n-1')
    const ok = (o: Partial<OracleReturnRow>) => normalizeReturnRow(rawReturn(ret('n-r', s, '5', '1000', o), [s]))
    const ap = ok({ status: 'APPROVED', at: null })
    expect(ap.ok && ap.value.kind).toBe('NOT_EFFECTIVE')
    // D13 (r1.1): từ điển có version, đúng hai khoá; giá trị khác — kể cả có ID hợp lệ — ⇒ UNKNOWN_STATUS, không NOT_EFFECTIVE.
    expect(CMS_RETURN_STATUS_DICTIONARY_VERSION).toBe('cms-return-status-v1')
    expect([...CMS_RETURN_STATUS_DICTIONARY]).toEqual([['COMPLETED', 'EFFECTIVE'], ['APPROVED', 'NOT_EFFECTIVE']])
    for (const status of ['REJECTED', 'CANCELLED', 'Completed', 'completed', 'Approved', ' COMPLETED', 'COMPLETED ', 'COMPLETED\u0000', 'COMPLETED​',
      'APPROVED\t', 'constructor', '__proto__', 'toString']) {
      const u = ok({ status, at: null })
      expect(u, JSON.stringify(status)).toEqual({ ok: false, issues: [{ kind: 'UNKNOWN_STATUS', field: 'return_status' }] })
    }
    for (const status of ['', '   ']) expect(ok({ status })).toEqual({ ok: false, issues: [{ kind: 'MISSING_FIELD', field: 'return_status' }] })
    for (const [o, field] of [
      [{ ref: null }, 'original_order_line_id'], [{ r: '0' }, 'return_base_quantity'], [{ r: '-5' }, 'return_base_quantity'],
      [{ r: '2.5' }, 'return_base_quantity'], [{ h: '-1' }, 'return_gmv_amount'], [{ h: '1.0000000001' }, 'return_gmv_amount'],
      [{ at: '2026-12-32T00:00:00Z' }, 'return_recorded_at'], [{ pid: 'SKU-1' }, 'product_id'],
    ] as [Partial<OracleReturnRow>, string][]) {
      const r = ok(o)
      expect(r.ok, JSON.stringify(o)).toBe(false)
      if (!r.ok) {
        expect(r.issues.map((i) => i.field)).toContain(field)
        expect(JSON.stringify(r.issues)).not.toMatch(/example\.test|1000|DHC/)
      }
    }
    const good = ok({})
    expect(good.ok && good.value.kind === 'COMPLETED' && good.value.baseQuantityUnits).toBe(U(5))
    expect(good.ok && good.value.kind === 'COMPLETED' && good.value.gmvUnits).toBe(U(1000))
  })

  test('thứ tự RETURN cùng µs theo BYTE UTF-8 (khớp SQL COLLATE "C"), không theo code unit UTF-16 — id ngoài BMP; cùng µs SALE trước RETURN', () => {
    const hi = '￿', astral = '\u{1F600}'
    expect(hi < astral).toBe(false) // UTF-16: astral (D83D…) < FFFF
    expect(compareUtf8Bytes(hi, astral)).toBeLessThan(0) // UTF-8: EF BF BF < F0 9F 98 80
    const s = sale('ord-1', { at: at(9, 0) })
    const c = base({ sales: [s], returns: [ret(astral, s, '3', '0', { at: at(9, 0) }), ret(hi, s, '2', '0', { at: at(9, 0) })] })
    const r = runApp(c)
    if (r.sourceError || !r.out.ok) throw new Error('app')
    expect(r.out.history.map((h) => h.key)).toEqual(['SALE:ord-1', `RETURN:${hi}`, `RETURN:${astral}`])
    expect(r.out.results[0].cmsQuantity).toBe(BigInt(1))
  })

  test('D1 (r1.1): comparator SALE riêng của contract — số theo giá trị / tie chuỗi / số 0 đầu, số trước text, text theo byte UTF-8; engine legacy giữ nguyên UTF-16', () => {
    const sorted = (xs: string[]) => [...xs].sort(compareCmsContractLineId)
    // Số: theo giá trị, KHÔNG theo byte chữ số ('10' < '2' theo byte).
    expect(sorted(['10', '2', '9', '100'])).toEqual(['2', '9', '10', '100'])
    // Cùng giá trị ⇒ so cả chuỗi theo byte: '007' < '07' < '7' (số 0 đầu trước); '0' < '00' (tiền tố ngắn trước).
    expect(sorted(['7', '07', '007', '00', '0'])).toEqual(['0', '00', '007', '07', '7'])
    // Số luôn trước text, kể cả text bắt đầu bằng chữ số; '١' (chữ số Ả Rập) không phải ID số ASCII.
    expect(sorted(['a', '1a', '99999999999999999999', '١'])).toEqual(['99999999999999999999', '1a', 'a', '١'])
    // Text: byte UTF-8 ≡ code point (U+E000 < U+10000) — ngược thứ tự code unit UTF-16.
    const pua = '', astral = '\u{10000}', bmpMax = '￿', emoji = '\u{1F600}'
    expect(compareCmsContractLineId(pua, astral)).toBeLessThan(0)
    expect(compareCmsContractLineId(bmpMax, emoji)).toBeLessThan(0)
    expect(compareCmsContractLineId(`x${astral}`, `x${pua}`)).toBeGreaterThan(0)
    expect(compareCmsContractLineId('ab', 'a')).toBeGreaterThan(0)
    expect(compareCmsContractLineId('', 'a')).toBeLessThan(0)
    // Đối chứng: engine legacy (run cũ) vẫn so code unit UTF-16 — không sửa toàn cục.
    expect(compareCmsLineId(pua, astral)).toBeGreaterThan(0)
    expect(compareCmsLineId('10', '2')).toBeGreaterThan(0)
    // Sự kiện: µs → SALE trước RETURN → ID; RETURN không có nhánh số ('10' < '2' theo byte).
    const ev = (kind: 'SALE' | 'RETURN', id: string, t = 1) => ({ kind, at: BigInt(t), id })
    expect(compareCmsCalcEvents(ev('SALE', '10'), ev('SALE', '2'))).toBeGreaterThan(0)
    expect(compareCmsCalcEvents(ev('RETURN', '10'), ev('RETURN', '2'))).toBeLessThan(0)
    expect(compareCmsCalcEvents(ev('RETURN', 'a'), ev('SALE', 'z'))).toBeGreaterThan(0)
    expect(compareCmsCalcEvents(ev('RETURN', 'a', 1), ev('SALE', 'a', 2))).toBeLessThan(0)
    expect(compareCmsCalcEvents(ev('SALE', pua), ev('SALE', astral))).toBeLessThan(0)
    // Dòng bán bị loại cũng ra theo thứ tự contract (cùng µs, ngoài kỳ): U+E000 trước U+10000.
    const oow = '2026-11-30T16:00:00.000000Z'
    const rx = runApp(base({ sales: [sale(astral, { at: oow }), sale(pua, { at: oow }), sale('10', { at: oow }), sale('9', { at: oow })] }))
    if (rx.sourceError || !rx.out.ok) throw new Error('app')
    expect(rx.out.excludedSales.map((e) => [e.orderLineId, e.reason])).toEqual([['9', 'OUT_OF_WINDOW'], ['10', 'OUT_OF_WINDOW'], [pua, 'OUT_OF_WINDOW'], [astral, 'OUT_OF_WINDOW']])
    // Phản đối xứng + bắc cầu trên tập trộn (kể cả cặp tie giá trị).
    const pool = ['0', '00', '7', '07', '10', '2', 'a', 'A', '1a', pua, astral, bmpMax, emoji, 'ä', 'á', '', ' ']
    for (const a of pool) for (const b of pool) {
      expect(Math.sign(compareCmsContractLineId(a, b)) + Math.sign(compareCmsContractLineId(b, a))).toBe(0)
      if (a !== b) expect(compareCmsContractLineId(a, b)).not.toBe(0)
      for (const c of pool) if (compareCmsContractLineId(a, b) < 0 && compareCmsContractLineId(b, c) < 0) expect(compareCmsContractLineId(a, c)).toBeLessThan(0)
    }
  })

  test('lịch sử: SALE / RETURN có lineage, B trước / sau, tiền âm ở phiếu làm rớt đơn vị; dòng không đóng góp NOT_COUNTED; Σ = tiền nhóm', () => {
    const c1 = sale('h-c'), o1 = sale('h-o', { q: '3', u: 'viên', b: '3', g: '900' })
    const r = runApp(base({ sales: [c1, o1], returns: [ret('h-r1', c1, '5', '1250'), ret('h-r2', o1, '3', '900', { at: at(21) })] }))
    if (r.sourceError || !r.out.ok) throw new Error('app')
    const h = Object.fromEntries(r.out.history.map((x) => [x.key, x]))
    expect(h['SALE:h-c'].status).toBe('RECORDED')
    expect(h['SALE:h-c'].amountVnd).toBe(BigInt(50000))
    expect(h['SALE:h-o'].status).toBe('NOT_COUNTED')
    expect(h['SALE:h-o'].quantityClass).toBe('OTHER_UNIT')
    expect(h['RETURN:h-r1']).toMatchObject({ kind: 'RETURN', orderLineId: 'h-c', returnDocumentId: 'rt-h-r1', status: 'RETURN_REDUCED', amountVnd: BigInt(-25000), eligibleBeforeUnits: U(200), eligibleAfterUnits: U(195) })
    expect(h['RETURN:h-r2']).toMatchObject({ status: 'RETURN_NO_CHANGE', amountVnd: ZERO, eligibleDeltaUnits: ZERO, baseDeltaUnits: U(-3), gmvDeltaUnits: U(-900) })
    checkInvariants(r.out)
  })
})

// ── Vi sai ngẫu nhiên có seed ──
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const fmt = (u: bigint) => {
  const neg = u < ZERO
  const a = neg ? -u : u
  const f = (a % CMS_DEC_FACTOR).toString().padStart(9, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${a / CMS_DEC_FACTOR}${f ? `.${f}` : ''}`
}
/**
 * `ids`: 'contract' (mặc định, r1.1) trộn ID dòng bán toàn chữ số có số 0 đầu / tie giá trị và ID text ngoài BMP để phủ thứ tự D1;
 * 'ascii' giữ đúng dòng ID của r1 (cùng chuỗi R()) cho parity với engine legacy — legacy so code unit UTF-16 nên chỉ trùng thứ tự
 * contract khi mọi ID là ASCII. Phần tiêm trạng thái lạ (D13) chỉ ở 'contract' và đặt SAU mọi lần rút R() của r1.
 */
function scenario(seed: number, ids: 'contract' | 'ascii' = 'contract'): OracleCase {
  const R = rng(seed)
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(R() * xs.length)]
  const int = (lo: number, hi: number) => lo + Math.floor(R() * (hi - lo + 1))
  const basis = R() < 0.5 ? 'pos_base' : 'cms_unit'
  const withReturns = R() < 0.85
  const pids = [P1, P2, P3].slice(0, int(1, 3))
  const products: OracleProduct[] = pids.map((pid) => {
    const gb = pick(['none', 'product', 'catalog'] as const)
    const a = int(1, 4), b = a + int(1, 4)
    return {
      pid, basis: gb, target: gb === 'product' ? String(int(1, 30) * 10000) : null, k: pick(['100', '30', '1', '2.5', '12']), unit: pick(['hộp', 'Hộp', 'chai']),
      tiers: R() < 0.5 ? [{ from: 1, to: null, amount: int(1, 50) * 1000 }]
        : [{ from: 1, to: a, amount: 15000 }, { from: a + 1, to: b, amount: 20000 }, { from: b + 1, to: null, amount: 25000 }],
    }
  })
  const catalogTarget = products.some((p) => p.basis === 'catalog') ? String(int(1, 40) * 10000) : null
  const emails = ['a@example.test', 'b@example.test', 'qlch@example.test', 'x@example.test', 'A@Example.test']
  const sales: OracleSaleRow[] = []
  const n = int(0, 22)
  for (let i = 0; i < n; i++) {
    const p = pick(products)
    const K = BigInt(Math.round(Number(p.k) * 10)) * CMS_DEC_FACTOR / BigInt(10)
    const unitSame = p.unit === 'chai' ? pick(['chai', 'CHAI', ' chai']) : pick(['hộp', 'HỘP', 'Hộp'])
    const kind = pick(['counted', 'counted', 'frac', 'other', 'zero'] as const)
    let q: string, u: string, b: bigint
    if (kind === 'counted') { const qq = int(1, 5); q = String(qq); u = unitSame; b = BigInt(qq) * K }
    else if (kind === 'frac') { const qu = BigInt(pick([500000000, 1500000000, 2500000000])); q = fmt(qu); u = unitSame; b = qu * K / CMS_DEC_FACTOR }
    else if (kind === 'other') { const qq = int(1, 60); q = String(qq); u = pick(['viên', 'vỉ']); b = U(qq) }
    else { q = '0'; u = unitSame; b = ZERO }
    const g = kind === 'zero' ? ZERO : U(int(0, 25) * 5000)
    const inWin = R() < 0.92
    const tsDay = inWin ? int(1, 31) : 0
    const atS = inWin ? `2026-12-${String(tsDay).padStart(2, '0')}T0${int(0, 9)}:${String(int(0, 3) * 15).padStart(2, '0')}:00.000000Z` : '2026-11-30T16:00:00.000000Z'
    const idr = R()
    const id = idr < 0.3 ? String(int(1, 999)) + `-${i}` : ids === 'ascii' || idr >= 0.6 ? `s${i}`
      : idr < 0.45 ? '0'.repeat(i % 3) + String(Math.floor(i / 3)) : ['\u{1F600}', '\uFFFF', '\uE000', 'ä'][i % 4] + `s${i}`
    // 'contract': dòng lẻ dùng chung mốc µs với dòng ngay trước (không rút thêm R()) ⇒ đủ cặp cùng µs để thứ tự ID D1 quyết định
    // phân bổ (cặp i % 4 = 0 / 1 là U+1F600… / U+FFFF…; cặp i % 3 là ID số cùng giá trị khác số 0 đầu).
    const atI = ids === 'contract' && i % 2 === 1 && sales.length ? sales[sales.length - 1].at : atS
    sales.push({ id, order: `o${i}`, code: `DHC${i}`, pid: p.pid, email: pick(emails), pos: 'POS01', type: R() < 0.95 ? 'OFFLINE' : 'ONLINE', status: 'COMPLETED', at: atI, q, u, b: fmt(b), g: fmt(g) })
  }
  const returns: OracleReturnRow[] = []
  if (withReturns) {
    let k = 0
    for (const s of sales) {
      if (R() < 0.45) continue
      let remB = BigInt(s.b.split('.')[0])
      let remG = BigInt(s.g.split('.')[0])
      for (let j = int(1, 3); j > 0 && remB > ZERO; j--) {
        const r = BigInt(int(1, Number(remB > BigInt(400) ? BigInt(400) : remB)))
        const h = remG > ZERO ? BigInt(int(0, Number(remG > BigInt(100000) ? BigInt(100000) : remG))) : ZERO
        remB -= r; remG -= h
        const sameMicro = R() < 0.2
        const id = pick(['', '', '\u{1F600}', '￿', 'ä']) + `r${k++}`
        returns.push({ id, doc: `doc-${id}`, status: R() < 0.12 ? 'APPROVED' : 'COMPLETED', at: sameMicro ? s.at : `2027-01-0${int(1, 9)}T01:00:00.000000Z`,
          ref: s.id, order: s.order, pid: s.pid, r: String(r), h: String(h) })
      }
    }
    // Tiêm lỗi để phủ nhánh HOLD: trả vượt lượng bán của một dòng.
    if (sales.length && R() < 0.1) {
      const s = pick(sales)
      returns.push({ id: `over-${seed}`, status: 'COMPLETED', at: '2027-01-09T00:00:00.000000Z', ref: s.id, order: s.order, pid: s.pid, r: String(BigInt(s.b.split('.')[0]) + BigInt(1)), h: '0' })
    }
  }
  // Tiêm lỗi b ≠ q × K cho một dòng đúng ĐV (chỉ có tác dụng ở cms_unit).
  if (sales.length && R() < 0.1) {
    const s = pick(sales)
    if (s.q !== '0') s.b = fmt(BigInt(Math.round(Number(s.b) * 1e9)) + CMS_DEC_FACTOR)
  }
  const returnsPolicy = withReturns ? 'net_returns_v1' : pick(['sales_only_v1', 'net_returns_v1'] as const)
  // D13: thỉnh thoảng một phiếu mang trạng thái ngoài từ điển ⇒ cả lượt SOURCE_ROW_INVALID ở cả app lẫn oracle.
  if (ids === 'contract' && returns.length && R() < 0.05) pick(returns).status = pick(['REJECTED', 'Completed', ' COMPLETED', 'APPROVED '])
  return base({ quantityBasis: basis, returnsPolicy, products, catalogTarget, sales, returns, asOf: '2027-01-10T00:00:00.000000Z' })
}
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const R = rng(seed)
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

test.describe('CMS-CALC-RET-2 P1 · vi sai ngẫu nhiên / thứ tự / parity @desktop', () => {
  test('400 kịch bản seed: app = oracle (HOLD hoặc mọi nhóm B / Q / GMV / gate / mốc / TỪNG SỰ KIỆN / tiền); bất biến telescoping', () => {
    let held = 0, ok = 0, withRet = 0, srcErr = 0, d1Sale = 0, d1Ret = 0, numericTie = 0
    // Cặp sự kiện cùng µs + cùng loại mà thứ tự contract khác thứ tự code unit UTF-16 (chỉ là bộ đếm phủ, không phải kỳ vọng).
    const utf16 = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
    for (let seed = 1; seed <= 400; seed++) {
      const c = scenario(seed)
      const r = runApp(c)
      compareWithOracle(c, r)
      if (r.sourceError) srcErr++
      if (!r.sourceError && r.out.ok) {
        checkInvariants(r.out); ok++
        if (r.out.totals.returnsApplied > 0) withRet++
        const h = r.out.history
        let s1 = false, s2 = false, s3 = false
        for (let i = 0; i < h.length; i++) for (let j = i + 1; j < h.length; j++) {
          if (h[i].atMicros !== h[j].atMicros || h[i].kind !== h[j].kind) continue
          const a = h[i].kind === 'SALE' ? h[i].orderLineId : h[i].returnEventId!, b = h[j].kind === 'SALE' ? h[j].orderLineId : h[j].returnEventId!
          if (Math.sign(utf16(a, b)) !== Math.sign(compareCmsCalcEvents({ kind: h[i].kind, at: ZERO, id: a }, { kind: h[j].kind, at: ZERO, id: b }))) {
            if (h[i].kind === 'SALE') s1 = true; else s2 = true
          }
          if (h[i].kind === 'SALE' && /^[0-9]+$/.test(a) && /^[0-9]+$/.test(b)) s3 = true
        }
        if (s1) d1Sale++
        if (s2) d1Ret++
        if (s3) numericTie++
      } else held++
    }
    // Phủ đủ hai nhánh (không để toàn HOLD hoặc toàn không trả) + các nhánh r1.1: thứ tự D1 khác UTF-16 ở SALE / RETURN, hai ID số
    // cùng µs, trạng thái ngoài từ điển.
    expect(ok).toBeGreaterThan(150)
    expect(withRet).toBeGreaterThan(80)
    expect(held).toBeGreaterThan(0)
    console.log(`phủ r1.1: ok ${ok} · trả ${withRet} · HOLD ${held} · lỗi nguồn ${srcErr} · D1 SALE ${d1Sale} · D1 RETURN ${d1Ret} · ID số cùng µs ${numericTie}`)
    expect(srcErr).toBeGreaterThan(0)
    expect(d1Sale).toBeGreaterThan(0)
    expect(d1Ret).toBeGreaterThan(0)
    expect(numericTie).toBeGreaterThan(0)
  })

  test('R10: đảo thứ tự dòng bán / phiếu trả và tính lại hai lần ⇒ cùng kết quả, cùng lịch sử, không trừ thêm; input không bị sửa', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const c = scenario(seed)
      const t = toInput(c)
      if (t.sourceError) continue
      const snap = JSON.stringify(t.input.sales, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
      const a = computeCmsNet(t.input)
      const b = computeCmsNet(t.input)
      const s = computeCmsNet({ ...t.input, sales: shuffled(t.input.sales, seed * 7), returns: shuffled(t.input.returns, seed * 13) })
      expect(b).toEqual(a)
      expect(s).toEqual(a)
      expect(JSON.stringify(t.input.sales, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(snap)
    }
  })

  test('parity: pos_base + sales_only, không trả ⇒ trùng engine hiện hành compute.ts (Q / B / GMV / gate / mốc / tiền nhóm / tiền từng dòng)', () => {
    let compared = 0
    for (let seed = 1; seed <= 300; seed++) {
      const c0 = scenario(seed, 'ascii')
      const c: OracleCase = { ...c0, quantityBasis: 'pos_base', returnsPolicy: 'sales_only_v1', returns: [] }
      const t = toInput(c)
      if (t.sourceError) continue
      const net = computeCmsNet(t.input)
      if (!net.ok) continue
      const legacy = computeCmsProgram({ program: { ...t.input.program, products: t.input.program.products.map(({ unitCms: _u, ...p }) => p) }, lines: t.input.sales, sellers: t.input.sellers })
      expect(net.results.map((g) => [g.userId, g.productId, g.netBaseUnits, g.cmsQuantity, g.netGmvUnits, g.gate, g.potentialAmountVnd, g.amountVnd]))
        .toEqual(legacy.results.map((g) => [g.userId, g.productId, g.baseQuantityUnits, g.cmsQuantity, g.gmvUnits, g.gate, g.potentialAmountVnd, g.amountVnd]))
      expect(net.history.map((h) => [h.orderLineId, h.amountVnd, h.eligibleBeforeUnits, h.eligibleAfterUnits]))
        .toEqual(legacy.lines.map((l) => [l.orderLineId, l.amountVnd, l.baseBeforeUnits, l.baseAfterUnits]))
      expect(net.catalog.map((x) => [x.userId, x.catalogNetGmvUnits, x.met, x.metAtMicros])).toEqual(legacy.catalog.map((x) => [x.userId, x.catalogGmvUnits, x.met, x.metAtMicros]))
      expect(net.excludedSales.map((e) => [e.orderLineId, e.reason, e.unassignedReason])).toEqual(legacy.excluded.map((e) => [e.orderLineId, e.reason, e.unassignedReason]))
      expect(net.totals.amountVnd).toBe(legacy.totals.amountVnd)
      compared++
    }
    expect(compared).toBeGreaterThan(200)
  })
})
