import { test, expect } from '@playwright/test'
import { CMS_DEC_FACTOR } from '../lib/cms/decimal'
import { buildSellerIndex } from '../lib/cms/mapping'
import { assessSalesSnapshot } from '../lib/cms/quality'
import { normalizeSalesRow, type CmsRawRow, type CmsSalesLine } from '../lib/cms/source/contract'
import { parseUtcMicros } from '../lib/cms/time'
import {
  CmsEngineConfigError, parseCmsEngineProgram,
  type CmsEngineProductInput, type CmsEngineProgramInput, type CmsEngineTier, type CmsEngineTierInput,
} from '../lib/cms/engine/config'
import { CmsEngineInputError, compareCmsLineId, computeCmsProgram, type CmsEngineOutput } from '../lib/cms/engine/compute'
import { cmsAmountByStore, countDistinctPharmacistsWithCms, summarizeCmsProgram } from '../lib/cms/engine/summary'
import { cmsProgressiveAmount } from '../lib/cms/engine/tiers'
import { CMS_INT64_MAX, cmsStageBoundsIssue } from '../lib/cms/resultStage'

// CMS P2-a — engine THUẦN (không DB, không mạng, không BigQuery). Map IMPLEMENTATION_PLAN §3.5 (ca bắt buộc r2 §5.2),
// docs/plan-cms-product-commission.md §2.5–§2.11, docs/cms/SPEC.md §2, Q-210b / Q-211 / Q-212; CMS-Q-220 (bỏ trần —
// thay Q-210a): bậc cuối không giới hạn, cấu hình bậc cuối hữu hạn ⇒ FINITE_LAST_TIER, không tính theo trần.
// Fixture giả hoàn toàn (email @example.test, mã nhà thuốc S1–S3). Dòng âm chỉ chứng minh số học trên sự kiện
// đã chuẩn hóa — KHÔNG thay việc chốt quy thuộc trả hàng (Q-206).

const B = (n: number | string) => BigInt(n)
const ZERO = B(0)
/** GMV / lượng scale 9 từ số nguyên. */
const U = (n: number | string) => BigInt(n) * CMS_DEC_FACTOR

const STORES = [
  { id: 'S1', storeType: 'os', isActive: true },
  { id: 'S2', storeType: 'os', isActive: true },
  { id: 'S3', storeType: 'fs', isActive: true },
]
const USERS = [
  { id: 'u-a', email: 'ds.a@example.test', role: 'staff', storeId: 'S1' },
  { id: 'u-b', email: 'ds.b@example.test', role: 'staff', storeId: 'S1' },
  { id: 'u-c', email: 'ds.c@example.test', role: 'staff', storeId: 'S2' },
  { id: 'u-qlch', email: 'qlch.s1@example.test', role: 'store_manager', storeId: 'S1' },
  { id: 'u-fs', email: 'ds.fs@example.test', role: 'staff', storeId: 'S3' },
  { id: 'u-dup1', email: 'trung@example.test', role: 'staff', storeId: 'S1' },
  { id: 'u-dup2', email: 'TRUNG@example.test ', role: 'staff', storeId: 'S1' },
]
const SELLERS = buildSellerIndex(USERS, STORES)
const EMAIL_A = 'ds.a@example.test'
const EMAIL_B = 'ds.b@example.test'
const EMAIL_C = 'ds.c@example.test'

/** Bậc mẫu plan §2.9: 1–9 = 15.000; 10–19 = 20.000; từ 20 = 25.000. */
const TIERS: CmsEngineTierInput[] = [
  { from: 1, to: 9, amount: '15000' },
  { from: 10, to: 19, amount: '20000' },
  { from: 20, to: null, amount: '25000' },
]
/** Cùng bậc, bậc cuối kết thúc ở 50 — cấu hình CŨ (Q-210a, đã bị CMS-Q-220 thay): engine phải TỪ CHỐI, không tính trần. */
const TIERS_CAP50: CmsEngineTierInput[] = [TIERS[0], TIERS[1], { from: 20, to: 50, amount: '25000' }]
/** Oracle độc lập ví dụ stakeholder CMS-Q-220 (không dùng tiers.ts): 15.000×min(Q,9) + 20.000×min(max(Q−9,0),10) + 25.000×max(Q−19,0). */
const stakeholderF = (q: bigint): bigint => {
  const min = (a: bigint, b: bigint) => (a < b ? a : b)
  const max = (a: bigint, b: bigint) => (a > b ? a : b)
  return B(15000) * min(q, B(9)) + B(20000) * min(max(q - B(9), ZERO), B(10)) + B(25000) * max(q - B(19), ZERO)
}

let seq = 1000
function rawRow(o: { id: string; pid: string; email?: string | null; at?: string; base: string; gmv: string; type?: string; status?: string }): CmsRawRow {
  return {
    order_line_id: o.id, order_id: `o-${o.id}`, order_code: `DH${o.id}`, product_id: o.pid,
    seller_email: o.email === undefined ? EMAIL_A : o.email, pos_code: 'POS01',
    order_type: o.type ?? 'OFFLINE', order_status: o.status ?? 'COMPLETED',
    completed_at: o.at ?? '2026-11-10T03:00:00.000000Z', quantity_raw: o.base, uom_raw: 'Viên',
    base_quantity: o.base, gmv_amount: o.gmv, source_updated_at: '2026-11-10T03:00:00.000000Z',
  }
}
/** Dòng đơn đi qua đúng bộ chuẩn hóa production (source/contract.ts). */
function line(o: { id?: string; pid: string; email?: string | null; at?: string; base: string; gmv: string; type?: string; status?: string }): CmsSalesLine {
  const id = o.id ?? String(seq++)
  const r = normalizeSalesRow(rawRow({ ...o, id }))
  if (!r.ok) throw new Error(`fixture line ${id}: ${JSON.stringify(r.issues)}`)
  return r.value
}
/** Timestamp trong kỳ, tăng dần theo i, khác nhau ở micro giây. */
const ts = (i: number) => `2026-11-${String(2 + Math.floor(i / 100)).padStart(2, '0')}T03:00:00.${String(i % 100).padStart(6, '0')}Z`

function program(products: CmsEngineProductInput[], o: Partial<CmsEngineProgramInput> = {}): CmsEngineProgramInput {
  return { startDate: '2026-11-01', endDate: '2026-11-30', catalogTargetGmv: null, storeIds: ['S1'], products, ...o }
}
const prod = (productId: string, o: Partial<CmsEngineProductInput> = {}): CmsEngineProductInput => ({
  productId, gmvBasis: 'none', targetGmv: null, baseQuantityCms: '1', tiers: TIERS, ...o,
})

/** Bất biến mọi lượt: tổng tiền dòng = tiền dược sĩ × sản phẩm; tổng chương trình = Σ kết quả; đếm dòng khớp. */
function expectConsistent(out: CmsEngineOutput) {
  let total = ZERO
  for (const r of out.results) {
    const ls = out.lines.filter((l) => l.userId === r.userId && l.productId === r.productId)
    expect(ls.length).toBe(r.lineCount)
    expect(ls.reduce((s, l) => s + l.amountVnd, ZERO)).toBe(r.amountVnd)
    expect(r.amountVnd).toBe(r.gate.met ? r.potentialAmountVnd : ZERO)
    total += r.amountVnd
  }
  expect(out.totals.amountVnd).toBe(total)
  expect(out.lines.reduce((s, l) => s + l.amountVnd, ZERO)).toBe(total)
  expect(out.totals.included).toBe(out.lines.length)
  expect(out.totals.linesRead).toBe(out.lines.length + out.excluded.length)
}
function run(p: CmsEngineProgramInput, lines: CmsSalesLine[]): CmsEngineOutput {
  const out = computeCmsProgram({ program: p, lines, sellers: SELLERS })
  expectConsistent(out)
  return out
}
function parsedTiers(tiers: CmsEngineTierInput[]): readonly CmsEngineTier[] {
  return parseCmsEngineProgram(program([prod('1', { tiers })])).products.get('1')!.tiers
}
function configErrorCode(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof CmsEngineConfigError ? e.code : `other:${String(e)}`
  }
}

test.describe('CMS P2-a · bảng nghiệm thu, lũy tiến, bậc cuối không trần (CMS-Q-220) @desktop', () => {
  test('F(Q) đúng từng số bảng §3 CMS-Q-220 (gồm 8/18/99 và Q rất lớn); oracle độc lập; không trần ở 50/100', () => {
    const t = parsedTiers(TIERS)
    expect(t[t.length - 1].to).toBeNull()
    // Số nguyên văn bảng §3 spec CMS-UNCAPPED-1 + mốc bổ sung §9.1(1) — không sinh từ code.
    const table: Array<[number, number]> = [
      [0, 0], [1, 15000], [8, 120000], [9, 135000], [10, 155000], [11, 175000], [14, 235000], [18, 315000], [19, 335000],
      [20, 360000], [25, 485000], [49, 1085000], [50, 1110000], [51, 1135000], [99, 2335000], [100, 2360000], [101, 2385000],
      [100000, 2499860000],
    ]
    for (const [q, cms] of table) {
      expect(cmsProgressiveAmount(B(q), t), `Q=${q}`).toBe(B(cms))
      expect(stakeholderF(B(q)), `oracle Q=${q}`).toBe(B(cms))
    }
    // Q rất lớn trong miền bigint: vẫn đúng mức bậc cuối, không chặn ở mốc nào.
    for (const q of [B(10) ** B(12), B(10) ** B(30) + B(7)]) expect(cmsProgressiveAmount(q, t)).toBe(stakeholderF(q))
    // Mỗi đơn vị đủ sau bậc cuối +25.000 (§9.1(2)); không áp một mức 25.000 cho toàn bộ Q; không dừng sau 50 / 100.
    expect(cmsProgressiveAmount(B(51), t) - cmsProgressiveAmount(B(50), t)).toBe(B(25000))
    expect(cmsProgressiveAmount(B(101), t) - cmsProgressiveAmount(B(100), t)).toBe(B(25000))
    expect(cmsProgressiveAmount(B(100), t)).not.toBe(B(100) * B(25000))
    expect(cmsProgressiveAmount(B(100), t)).not.toBe(B(1110000))
    // 100 = 9×15.000 + 10×20.000 + 81×25.000.
    expect(cmsProgressiveAmount(B(100), t)).toBe(B(9 * 15000 + 10 * 20000 + 81 * 25000))
    // Bậc TRUNG GIAN vẫn chặn min(Q, to): Q 15 không tính 15 đơn vị ở mức 20.000.
    expect(cmsProgressiveAmount(B(15), t)).toBe(B(9 * 15000 + 6 * 20000))
  })

  test('cấu hình bậc cuối hữu hạn (chưa chuyển đổi) ⇒ FINITE_LAST_TIER, không tính theo trần; bậc giữa hữu hạn vẫn hợp lệ', () => {
    for (const tiers of [TIERS_CAP50, [{ from: 1, to: 50, amount: '25000' }], [TIERS[0], { from: 10, to: 100, amount: '20000' }]] as CmsEngineTierInput[][]) {
      const p = program([prod('102', { tiers })])
      expect(configErrorCode(() => parseCmsEngineProgram(p))).toBe('FINITE_LAST_TIER')
      expect(configErrorCode(() => computeCmsProgram({ program: p, lines: [line({ pid: '102', base: '60', gmv: '1' })], sellers: SELLERS }))).toBe('FINITE_LAST_TIER')
    }
    // Lỗi cấu hình khác vẫn đúng mã cũ (không bị "chuẩn hoá" thành hợp lệ hay đổi sang FINITE_LAST_TIER).
    expect(configErrorCode(() => parseCmsEngineProgram(program([prod('1', { tiers: [{ from: 1, to: 9, amount: '1' }, { from: 11, to: 50, amount: '2' }] })])))).toBe('BAD_TIERS')
    expect(configErrorCode(() => parseCmsEngineProgram(program([prod('1', { tiers: [{ from: 1, to: null, amount: '1' }, { from: 10, to: 50, amount: '2' }] })])))).toBe('BAD_TIERS')
    const ok = parseCmsEngineProgram(program([prod('1', { tiers: [{ from: 1, to: 1, amount: '1' }, { from: 2, to: 2, amount: '2' }, { from: 3, to: null, amount: '3' }] })]))
    expect(ok.products.get('1')!.capQuantity).toBeNull()
    expect(ok.products.get('1')!.tiers.map((x) => x.to)).toEqual([B(1), B(2), null])
  })

  test('engine: gate 10 triệu, 1 triệu/SP — Q 9 chưa đạt (0), Q 10…25 đúng bảng; tính cả lượng bán trước khi đạt', () => {
    const p = program([prod('101', { gmvBasis: 'product', targetGmv: '10000000' })])
    const table: Array<[number, number]> = [[9, 0], [10, 155000], [11, 175000], [14, 235000], [20, 360000], [25, 485000]]
    for (const [q, cms] of table) {
      const lines = Array.from({ length: q }, (_, i) => line({ pid: '101', base: '1', gmv: '1000000', at: ts(i) }))
      const out = run(p, lines)
      expect(out.results).toHaveLength(1)
      const r = out.results[0]
      expect(r.cmsQuantity, `Q=${q}`).toBe(B(q))
      expect(r.gmvUnits).toBe(U(q * 1_000_000))
      expect(r.gate.met).toBe(q >= 10)
      expect(r.amountVnd, `Q=${q}`).toBe(B(cms))
      expect(r.potentialAmountVnd).toBe(cmsProgressiveAmount(B(q), parsedTiers(TIERS)))
      if (q === 9) {
        expect(r.gate.metAtMicros).toBeNull()
        expect(out.lines.every((l) => l.status === 'WAITING_GATE' && l.amountVnd === ZERO)).toBe(true)
      }
      if (q === 10) {
        // Đạt ở dòng thứ 10 nhưng 9 dòng trước vẫn được tính (plan §2.8).
        expect(out.lines.map((l) => l.amountVnd)).toEqual([...Array(9).fill(B(15000)), B(20000)])
        expect(r.gate.metAtMicros).toBe(parseUtcMicros(ts(9)))
      }
    }
  })

  test('không trần: Q 50 / 51 / 60 / 100 / 101 ⇒ đúng F(Q); rewarded = Q, cap null, atCap false; không dòng AT_CAP', () => {
    const p = program([prod('102', { gmvBasis: 'product', targetGmv: '10000000' })])
    for (const q of [50, 51, 60, 100, 101]) {
      const lines = Array.from({ length: q }, (_, i) => line({ pid: '102', base: '1', gmv: '1000000', at: ts(i) }))
      const out = run(p, lines)
      const r = out.results[0]
      expect(r.amountVnd, `Q=${q}`).toBe(stakeholderF(B(q)))
      expect(r.cmsQuantity).toBe(B(q))
      expect(r.rewardedQuantity).toBe(B(q))
      expect(r.capQuantity).toBeNull()
      expect(r.atCap).toBe(false)
      expect(r.baseQuantityUnits).toBe(U(q))
      expect(r.gmvUnits).toBe(U(q * 1_000_000))
      // Từng dòng một đơn vị: 1–9 = 15.000, 10–19 = 20.000, từ 20 = 25.000 (kể cả đơn vị 51, 100, 101).
      expect(out.lines.map((l) => l.amountVnd)).toEqual(
        Array.from({ length: q }, (_, i) => (i < 9 ? B(15000) : i < 19 ? B(20000) : B(25000))))
      expect(out.lines.every((l) => l.status === 'RECORDED')).toBe(true)
    }
    const q100 = run(p, Array.from({ length: 100 }, (_, i) => line({ pid: '102', base: '1', gmv: '1000000', at: ts(i) })))
    expect(q100.results[0].amountVnd).toBe(B(2360000))
    // Một dòng 60 đơn vị: F(60) đầy đủ, không dừng ở 50.
    const one = run(p, [line({ pid: '102', base: '60', gmv: '60000000' })])
    expect(one.results[0].amountVnd).toBe(B(1360000))
    expect(one.results[0].cmsQuantity).toBe(B(60))
    expect(one.lines[0].status).toBe('RECORDED')
    // Từ 50 thêm phần lẻ (chưa đủ đơn vị) ⇒ "Đang cộng dồn" (không còn "Đã đạt trần"); đủ đơn vị 51 ⇒ +25.000.
    const frac = run(p, [
      line({ pid: '102', base: '50', gmv: '50000000', at: ts(1) }),
      line({ pid: '102', base: '0.5', gmv: '500000', at: ts(2) }),
      line({ pid: '102', base: '0.5', gmv: '500000', at: ts(3) }),
    ])
    expect(frac.lines.map((l) => [l.status, l.qtyBefore, l.qtyAfter, l.amountVnd])).toEqual([
      ['RECORDED', ZERO, B(50), B(1110000)],
      ['ACCUMULATING', B(50), B(50), ZERO],
      ['RECORDED', B(50), B(51), B(25000)],
    ])
  })

  test('gate: Q 100 chưa đạt target ⇒ tiền 0 nhưng giữ đủ lượng / potential; đạt ⇒ 2.360.000 (sản phẩm / danh mục / none)', () => {
    const hundred = (pid: string, gmv: string) => Array.from({ length: 100 }, (_, i) => line({ pid, base: '1', gmv, at: ts(i) }))
    const miss = run(program([prod('110', { gmvBasis: 'product', targetGmv: '200000000' })]), hundred('110', '1000000'))
    expect(miss.results[0]).toMatchObject({ cmsQuantity: B(100), rewardedQuantity: B(100), capQuantity: null, atCap: false, amountVnd: ZERO, potentialAmountVnd: B(2360000) })
    expect(miss.results[0].gate.met).toBe(false)
    expect(miss.lines.every((l) => l.status === 'WAITING_GATE' && l.amountVnd === ZERO)).toBe(true)
    const hit = run(program([prod('110', { gmvBasis: 'product', targetGmv: '100000000' })]), hundred('110', '1000000'))
    expect(hit.results[0]).toMatchObject({ cmsQuantity: B(100), amountVnd: B(2360000) })
    expect(hit.results[0].gate.metAtMicros).toBe(parseUtcMicros(ts(99)))
    const cat = run(program([prod('111', { gmvBasis: 'catalog' })], { catalogTargetGmv: '50000000' }), hundred('111', '1000000'))
    expect(cat.results[0]).toMatchObject({ amountVnd: B(2360000) })
    expect(cat.results[0].gate.metAtMicros).toBe(parseUtcMicros(ts(49)))
    const none = run(program([prod('112')]), hundred('112', '0'))
    expect(none.results[0]).toMatchObject({ amountVnd: B(2360000), cmsQuantity: B(100) })
  })

  test('K = 100: dòng lẻ cộng dồn thành đơn vị nguyên quanh 50 / 51; phần lẻ không trả sớm; bậc tính theo từng dược sĩ, không theo store', () => {
    const p = program([prod('120', { baseQuantityCms: '100' }), prod('121')], { storeIds: ['S1'] })
    const out = run(p, [
      line({ pid: '120', base: '4995', gmv: '1', at: ts(1) }),   // B 4.995 ⇒ Q 49
      line({ pid: '120', base: '95', gmv: '1', at: ts(2) }),     // B 5.090 ⇒ Q 50 (50,9)
      line({ pid: '120', base: '5', gmv: '1', at: ts(3) }),      // B 5.095 ⇒ Q 50 — phần lẻ, chưa trả
      line({ pid: '120', base: '5', gmv: '1', at: ts(4) }),      // B 5.100 ⇒ Q 51
      // Hai dược sĩ cùng store, mỗi người Q 15 ở SP 121 ⇒ mỗi người F(15), không gộp F(30) của store.
      line({ pid: '121', email: EMAIL_A, base: '15', gmv: '1', at: ts(5) }),
      line({ pid: '121', email: EMAIL_B, base: '15', gmv: '1', at: ts(6) }),
    ])
    const l120 = out.lines.filter((l) => l.productId === '120')
    expect(l120.map((l) => [l.status, l.qtyBefore, l.qtyAfter, l.amountVnd])).toEqual([
      ['RECORDED', ZERO, B(49), B(1085000)],
      ['RECORDED', B(49), B(50), B(25000)],
      ['ACCUMULATING', B(50), B(50), ZERO],
      ['RECORDED', B(50), B(51), B(25000)],
    ])
    const r120 = out.results.find((r) => r.productId === '120')!
    expect(r120).toMatchObject({ cmsQuantity: B(51), rewardedQuantity: B(51), amountVnd: B(1135000) })
    const r121 = out.results.filter((r) => r.productId === '121')
    expect(r121.map((r) => r.amountVnd)).toEqual([B(255000), B(255000)])
    expect(cmsAmountByStore(out.results).get('S1')).toBe(B(1135000 + 2 * 255000))
    expect(B(2 * 255000)).not.toBe(stakeholderF(B(30)))
  })

  test('phân bổ dòng qua ranh 9→10, 19→20, 50→51; tổng dòng = F(Q); đảo thứ tự đầu vào ⇒ cùng thứ tự / tiền', () => {
    const p = program([prod('130')])
    const lines = [
      line({ id: '1301', pid: '130', base: '9', gmv: '1', at: ts(1) }),
      line({ id: '1302', pid: '130', base: '1', gmv: '1', at: ts(2) }),
      line({ id: '1303', pid: '130', base: '9', gmv: '1', at: ts(3) }),
      line({ id: '1304', pid: '130', base: '1', gmv: '1', at: ts(4) }),
      line({ id: '1305', pid: '130', base: '30', gmv: '1', at: ts(5) }),
      line({ id: '1306', pid: '130', base: '1', gmv: '1', at: ts(6) }),
      // Một dòng đi qua cả 9→10 và 19→20 của dược sĩ B.
      line({ id: '1307', pid: '130', email: EMAIL_B, base: '8', gmv: '1', at: ts(7) }),
      line({ id: '1308', pid: '130', email: EMAIL_B, base: '43', gmv: '1', at: ts(8) }),
    ]
    const out = run(p, lines)
    expect(out.lines.map((l) => [l.orderLineId, l.qtyBefore, l.qtyAfter, l.amountVnd])).toEqual([
      ['1301', ZERO, B(9), B(135000)],
      ['1302', B(9), B(10), B(20000)],
      ['1303', B(10), B(19), B(180000)],
      ['1304', B(19), B(20), B(25000)],
      ['1305', B(20), B(50), B(750000)],
      ['1306', B(50), B(51), B(25000)],
      ['1307', ZERO, B(8), B(120000)],
      ['1308', B(8), B(51), stakeholderF(B(51)) - B(120000)],
    ])
    expect(out.results.map((r) => r.amountVnd)).toEqual([B(1135000), B(1135000)])
    expect(out.totals.amountVnd).toBe(B(2270000))
    expect(run(p, [...lines].reverse())).toEqual(out)
  })

  test('trả hàng (số học trên sự kiện đã chuẩn hoá, KHÔNG chốt Q-206): 51→50 −25.000; 20→19 −25.000; 10→9 −20.000; gate tụt ⇒ theo trạng thái cuối', () => {
    const p = program([prod('140')])
    const cases: Array<[number, bigint]> = [[51, B(-25000)], [20, B(-25000)], [10, B(-20000)]]
    for (const [q, delta] of cases) {
      const out = run(p, [line({ pid: '140', base: String(q), gmv: '1', at: ts(1) }), line({ pid: '140', base: '-1', gmv: '-1', at: ts(2) })])
      expect(out.lines.map((l) => [l.status, l.amountVnd]), `Q ${q}→${q - 1}`).toEqual([['RECORDED', stakeholderF(B(q))], ['ADJUSTMENT', delta]])
      expect(out.results[0].amountVnd).toBe(stakeholderF(B(q - 1)))
    }
    // Gate sản phẩm: Q 100 đạt target rồi dòng âm kéo GMV dưới target ⇒ cả kỳ chưa đạt, tiền cuối 0 (mọi dòng 0 theo trạng thái cuối).
    const g = program([prod('141', { gmvBasis: 'product', targetGmv: '100000000' })])
    const gl = [...Array.from({ length: 100 }, (_, i) => line({ pid: '141', base: '1', gmv: '1000000', at: ts(i) })), line({ pid: '141', base: '-1', gmv: '-1000000', at: ts(150) })]
    const dropped = run(g, gl)
    expect(dropped.results[0]).toMatchObject({ cmsQuantity: B(99), amountVnd: ZERO, potentialAmountVnd: B(2335000) })
    expect(dropped.results[0].gate.met).toBe(false)
    expect(dropped.lines.every((l) => l.amountVnd === ZERO)).toBe(true)
  })

  test('không trần nên số rất lớn phải bị chặn ở miền kỹ thuật (OVERFLOW, giữ snapshot cũ) — không cắt về trần / 0', () => {
    // Một dược sĩ: Q đủ lớn để F(Q) > int8 ⇒ engine giữ số đúng (bigint), stage báo OVERFLOW.
    const qBig = (CMS_INT64_MAX / B(25000)) + B(10)
    const p = program([prod('150')])
    const lines = [line({ pid: '150', base: qBig.toString(), gmv: '1' })]
    const out = run(p, lines)
    expect(out.results[0].amountVnd).toBe(stakeholderF(qBig))
    expect(out.results[0].amountVnd > CMS_INT64_MAX).toBe(true)
    expect(cmsStageBoundsIssue(out, lines)).toBe('OVERFLOW')
    // Từng người trong miền nhưng TỔNG chương trình vượt int8 ⇒ vẫn OVERFLOW.
    const qHalf = (CMS_INT64_MAX / B(25000)) / B(2) + B(100)
    const many = [EMAIL_A, EMAIL_B, EMAIL_C].map((email, i) => line({ pid: '150', email, base: qHalf.toString(), gmv: '1', at: ts(i) }))
    const out2 = run(program([prod('150')], { storeIds: ['S1', 'S2'] }), many)
    expect(out2.results.every((r) => r.amountVnd <= CMS_INT64_MAX)).toBe(true)
    expect(out2.totals.amountVnd > CMS_INT64_MAX).toBe(true)
    expect(cmsStageBoundsIssue(out2, many)).toBe('OVERFLOW')
    // Trong miền ⇒ không OVERFLOW.
    const small = [line({ pid: '150', base: '100000', gmv: '1' })]
    expect(cmsStageBoundsIssue(run(p, small), small)).toBeNull()
  })

  test('một dòng đi qua hai bậc', () => {
    const out = run(program([prod('103')]), [
      line({ pid: '103', base: '8', gmv: '800000', at: ts(1) }),
      line({ pid: '103', base: '13', gmv: '1300000', at: ts(2) }),
    ])
    // F(8) = 120.000; F(21) = 9×15.000 + 10×20.000 + 2×25.000 = 385.000 ⇒ dòng 2 = 265.000.
    expect(out.lines.map((l) => [l.qtyBefore, l.qtyAfter, l.amountVnd])).toEqual([
      [ZERO, B(8), B(120000)],
      [B(8), B(21), B(265000)],
    ])
    expect(out.results[0].amountVnd).toBe(B(385000))
  })
})

test.describe('CMS P2-a · gate GMV @desktop', () => {
  test('gate theo sản phẩm: thiếu 1đ / thiếu 0,000000001đ không đạt; bằng và vượt target đạt', () => {
    const p = program([prod('101', { gmvBasis: 'product', targetGmv: '10000000' })])
    const cases: Array<[string, boolean]> = [['9999999', false], ['9999999.999999999', false], ['10000000', true], ['10000001', true]]
    for (const [gmv, met] of cases) {
      const out = run(p, [line({ pid: '101', base: '3', gmv })])
      const r = out.results[0]
      expect(r.gate.met, gmv).toBe(met)
      expect(r.gate.targetVnd).toBe(B(10000000))
      expect(r.potentialAmountVnd).toBe(B(45000))
      expect(r.amountVnd, gmv).toBe(met ? B(45000) : ZERO)
      expect(out.lines[0].status).toBe(met ? 'RECORDED' : 'WAITING_GATE')
    }
  })

  test('gate danh mục cộng nhiều sản phẩm; sản phẩm gate riêng không cộng vào danh mục', () => {
    const p = program(
      [prod('201', { gmvBasis: 'catalog' }), prod('202', { gmvBasis: 'catalog' }), prod('203', { gmvBasis: 'product', targetGmv: '1000000' })],
      { catalogTargetGmv: '5000000' },
    )
    const out = run(p, [
      line({ pid: '201', base: '2', gmv: '3000000', at: ts(1) }),
      line({ pid: '202', base: '1', gmv: '2000000', at: ts(2) }),
      line({ pid: '203', base: '1', gmv: '9000000', at: ts(3) }),
      line({ pid: '201', email: EMAIL_B, base: '2', gmv: '2999999', at: ts(4) }),
      line({ pid: '203', email: EMAIL_B, base: '1', gmv: '2000000', at: ts(5) }),
    ])
    expect(out.catalog.map((c) => [c.userId, c.catalogGmvUnits, c.met, c.metAtMicros, c.lineCount])).toEqual([
      ['u-a', U(5000000), true, parseUtcMicros(ts(2)), 2],
      ['u-b', U(2999999), false, null, 1],
    ])
    const byKey = new Map(out.results.map((r) => [`${r.userId}/${r.productId}`, r]))
    expect(byKey.get('u-a/201')!.gate.gateGmvUnits).toBe(U(5000000))
    expect(byKey.get('u-a/201')!.amountVnd).toBe(B(30000))
    expect(byKey.get('u-a/202')!.amountVnd).toBe(B(15000))
    expect(byKey.get('u-a/203')!.gate.gateGmvUnits).toBe(U(9000000))
    expect(byKey.get('u-a/203')!.amountVnd).toBe(B(15000))
    // B: danh mục 2.999.999 < 5 triệu dù GMV sản phẩm 203 cộng vào sẽ vượt — 203 không thuộc danh mục.
    expect(byKey.get('u-b/201')!.gate.met).toBe(false)
    expect(byKey.get('u-b/201')!.amountVnd).toBe(ZERO)
    expect(byKey.get('u-b/201')!.potentialAmountVnd).toBe(B(30000))
    expect(byKey.get('u-b/203')!.amountVnd).toBe(B(15000))
  })

  test('không target: luôn đạt, không có "Đạt từ"', () => {
    const out = run(program([prod('301')]), [line({ pid: '301', base: '1', gmv: '0' })])
    const r = out.results[0]
    expect(r.gate).toEqual({ gateGmvUnits: null, targetVnd: null, met: true, metAtMicros: null })
    expect(r.amountVnd).toBe(B(15000))
  })

  test('Q-211: gate_met_at = lần chuyển chưa đạt → đạt gần nhất; đang không đạt ⇒ null', () => {
    const p = program([prod('101', { gmvBasis: 'product', targetGmv: '10000000' })])
    const reMet = run(p, [
      line({ pid: '101', base: '1', gmv: '10000000', at: ts(1) }),
      line({ pid: '101', base: '-1', gmv: '-1000000', at: ts(2) }),
      line({ pid: '101', base: '1', gmv: '2000000', at: ts(3) }),
    ])
    expect(reMet.results[0].gate.met).toBe(true)
    expect(reMet.results[0].gate.metAtMicros).toBe(parseUtcMicros(ts(3)))
    const dropped = run(p, [
      line({ pid: '101', base: '1', gmv: '10000000', at: ts(1) }),
      line({ pid: '101', base: '-1', gmv: '-1000000', at: ts(2) }),
    ])
    expect(dropped.results[0].gate).toMatchObject({ met: false, metAtMicros: null })
    expect(dropped.lines.map((l) => [l.status, l.amountVnd])).toEqual([['WAITING_GATE', ZERO], ['ADJUSTMENT', ZERO]])

    // Gate danh mục: đạt (t1, qua 2 sản phẩm) → tụt (t3) → đạt lại (t4) ⇒ "Đạt từ" = t4 cho mọi SP danh mục.
    const pc = program([prod('201', { gmvBasis: 'catalog' }), prod('202', { gmvBasis: 'catalog' })], { catalogTargetGmv: '1000000' })
    const cat = run(pc, [
      line({ pid: '201', base: '1', gmv: '600000', at: ts(1) }),
      line({ pid: '202', base: '1', gmv: '400000', at: ts(2) }),
      line({ pid: '201', base: '-1', gmv: '-300000', at: ts(3) }),
      line({ pid: '202', base: '1', gmv: '300000', at: ts(4) }),
    ])
    expect(cat.catalog).toEqual([
      { userId: 'u-a', storeId: 'S1', catalogGmvUnits: U(1000000), targetVnd: B(1000000), met: true, metAtMicros: parseUtcMicros(ts(4)), lineCount: 4 },
    ])
    expect(cat.results.map((r) => [r.productId, r.gate.metAtMicros, r.amountVnd])).toEqual([
      ['201', parseUtcMicros(ts(4)), ZERO],
      ['202', parseUtcMicros(ts(4)), B(30000)],
    ])
  })
})

test.describe('CMS P2-a · quy đổi số lượng (Q-210b) @desktop', () => {
  test('hai lần nửa hộp bằng một hộp; phần lẻ cộng tiếp trong kỳ', () => {
    const out = run(program([prod('401', { baseQuantityCms: '100' })]), [
      line({ pid: '401', base: '50', gmv: '50000', at: ts(1) }),
      line({ pid: '401', base: '50', gmv: '50000', at: ts(2) }),
      line({ pid: '401', base: '50', gmv: '50000', at: ts(3) }),
    ])
    expect(out.lines.map((l) => [l.status, l.qtyAfter, l.amountVnd])).toEqual([
      ['ACCUMULATING', ZERO, ZERO],
      ['RECORDED', B(1), B(15000)],
      ['ACCUMULATING', B(1), ZERO],
    ])
    expect(out.results[0].baseQuantityUnits).toBe(U(150))
    expect(out.results[0].cmsQuantity).toBe(B(1))
  })

  test('cộng nhiều dòng lẻ rồi mới floor (không float)', () => {
    // 10 × 0,1 trong float = 0,9999999999999999 ⇒ floor 0; số thập phân chính xác = 1.
    expect(Array(10).fill(0.1).reduce((s: number, x: number) => s + x, 0)).toBeLessThan(1)
    const tenths = Array.from({ length: 10 }, (_, i) => line({ pid: '402', base: '0.1', gmv: '1000', at: ts(i) }))
    const out = run(program([prod('402')]), tenths)
    expect(out.results[0].cmsQuantity).toBe(B(1))
    expect(out.results[0].amountVnd).toBe(B(15000))
    expect(out.lines.filter((l) => l.amountVnd > ZERO).map((l) => l.orderLineId)).toEqual([tenths[9].orderLineId])
  })

  test('K thập phân 9 chữ số chia chính xác; vượt precision ⇒ lỗi, không cắt', () => {
    const p = program([prod('403', { baseQuantityCms: '0.333333333' })])
    const thirds = Array.from({ length: 3 }, (_, i) => line({ pid: '403', base: '0.333333333', gmv: '1', at: ts(i) }))
    expect(run(p, thirds).results[0].cmsQuantity).toBe(B(3))
    const short = [...thirds.slice(0, 2), line({ pid: '403', base: '0.333333332', gmv: '1', at: ts(5) })]
    expect(run(p, short).results[0].cmsQuantity).toBe(B(2))
    for (const bad of ['0.0000000001', '1.0000000001']) {
      expect(configErrorCode(() => parseCmsEngineProgram(program([prod('403', { baseQuantityCms: bad })]))), bad).toBe('BAD_BASE_QUANTITY')
    }
    for (const bad of ['0', '0.000000000', '-1', '', '1e3', '1,5']) {
      expect(configErrorCode(() => parseCmsEngineProgram(program([prod('403', { baseQuantityCms: bad })]))), bad).toBe('BAD_BASE_QUANTITY')
    }
    // Lượng cơ sở nguồn quá 9 chữ số thập phân ⇒ lỗi chuẩn hóa (held), không làm tròn.
    const r = normalizeSalesRow(rawRow({ id: 'x1', pid: '403', base: '1.0000000001', gmv: '1' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues).toContainEqual({ kind: 'BAD_NUMBER', field: 'base_quantity', error: 'SCALE' })
    // Số rất lớn vẫn chính xác (bigint).
    const huge = run(program([prod('404', { baseQuantityCms: '0.000000001' })]), [
      line({ pid: '404', base: '99999999999999999999999999999.999999999', gmv: '1' }),
    ])
    expect(huge.results[0].cmsQuantity).toBe(B('99999999999999999999999999999999999999'))
  })

  test('Q = floor(max(0, B) / K) không âm; dòng âm là điều chỉnh (Q-206)', () => {
    const out = run(program([prod('405')]), [
      line({ pid: '405', base: '5', gmv: '500000', at: ts(1) }),
      line({ pid: '405', base: '-8', gmv: '-800000', at: ts(2) }),
    ])
    const r = out.results[0]
    expect(r.baseQuantityUnits).toBe(U(-3))
    expect(r.cmsQuantity).toBe(ZERO)
    expect(r.rewardedQuantity).toBe(ZERO)
    expect(r.amountVnd).toBe(ZERO)
    expect(out.lines.map((l) => [l.status, l.amountVnd])).toEqual([['RECORDED', B(75000)], ['ADJUSTMENT', B(-75000)]])
    expect(out.totals.adjustmentLines).toBe(1)

    // Trên mốc 50 cũ có dòng âm: không trần ⇒ mỗi đơn vị trả bớt ở bậc cuối −25.000 (không còn "dòng âm = 0 vì trên trần").
    const above = run(program([prod('407')]), [
      line({ pid: '407', base: '55', gmv: '5500000', at: ts(1) }),
      line({ pid: '407', base: '-3', gmv: '-300000', at: ts(2) }),
      line({ pid: '407', base: '-5', gmv: '-500000', at: ts(3) }),
    ])
    expect(above.lines.map((l) => [l.status, l.qtyBefore, l.qtyAfter, l.amountVnd])).toEqual([
      ['RECORDED', ZERO, B(55), B(1235000)],
      ['ADJUSTMENT', B(55), B(52), B(-75000)],
      ['ADJUSTMENT', B(52), B(47), B(-125000)],
    ])
    expect(above.results[0]).toMatchObject({ cmsQuantity: B(47), rewardedQuantity: B(47), capQuantity: null, atCap: false, amountVnd: B(1035000) })
    // Dòng GMV âm nhưng lượng dương cũng là điều chỉnh (Q-206), không phải bán mới.
    const gmvNeg = run(program([prod('408')]), [line({ pid: '408', base: '1', gmv: '-1000' })])
    expect(gmvNeg.lines[0].status).toBe('ADJUSTMENT')
  })

  test('giá trị 0 hợp lệ khác thiếu dữ liệu', () => {
    const out = run(program([prod('406')]), [line({ pid: '406', base: '0', gmv: '0' })])
    expect(out.totals.included).toBe(1)
    expect(out.results[0]).toMatchObject({ baseQuantityUnits: ZERO, gmvUnits: ZERO, cmsQuantity: ZERO, amountVnd: ZERO, lineCount: 1 })
    expect(out.lines[0].status).toBe('ACCUMULATING')
    // Thiếu base_quantity ⇒ không vào engine; snapshot bị giữ ở nhóm "Chưa quy đổi đơn vị".
    const missing = normalizeSalesRow(rawRow({ id: 'x2', pid: '406', base: '', gmv: '0' }))
    expect(missing.ok).toBe(false)
    const missingIssues = missing.ok ? [] : missing.issues
    expect(missingIssues).toEqual([{ kind: 'MISSING_FIELD', field: 'base_quantity' }])
    const verdict = assessSalesSnapshot({
      rowsRead: 1, totalRowsReported: 1, pagesComplete: true, rowIssues: [missingIssues], lineIds: ['x2'],
      candidates: 0, unassigned: 0, previousPublishedRows: null,
    })
    expect(verdict.status).toBe('held')
    expect(verdict.reasons).toContain('UNCONVERTED_UNITS')
  })
})

test.describe('CMS P2-a · thứ tự, phân bổ, phạm vi @desktop', () => {
  test('timestamp micro giây và tie-break bằng item ID (số: 9 trước 10)', () => {
    expect(compareCmsLineId('9', '10')).toBeLessThan(0)
    expect(compareCmsLineId('10', '9')).toBeGreaterThan(0)
    expect(compareCmsLineId('010', '10')).toBeLessThan(0)
    expect(compareCmsLineId('10', '10')).toBe(0)
    expect(compareCmsLineId('a-2', 'a-10')).toBeGreaterThan(0)
    // Thứ tự toàn phần khi trộn id số / id có chữ: kết quả sắp không phụ thuộc thứ tự vào (không có vòng 9 < 10 < 1a < 9).
    const mixed = ['9', '10', '1a', 'a', '010', '0', 'B-1']
    const expected = ['0', '9', '010', '10', '1a', 'B-1', 'a']
    for (const perm of [mixed, [...mixed].reverse(), ['1a', '9', 'a', '10', '0', 'B-1', '010']]) {
      expect([...perm].sort(compareCmsLineId)).toEqual(expected)
    }
    for (const x of mixed) for (const y of mixed) for (const z of mixed) {
      if (compareCmsLineId(x, y) < 0 && compareCmsLineId(y, z) < 0) expect(compareCmsLineId(x, z), `${x} < ${y} < ${z}`).toBeLessThan(0)
    }

    const tiers: CmsEngineTierInput[] = [{ from: 1, to: 1, amount: '10000' }, { from: 2, to: null, amount: '20000' }]
    const p = program([prod('501', { tiers, gmvBasis: 'product', targetGmv: '200' })])
    const at = '2026-11-12T05:06:07.000001Z'
    const first = line({ id: '500', pid: '501', base: '1', gmv: '100', at: '2026-11-12T05:06:07.000000Z' })
    const l9 = line({ id: '9', pid: '501', base: '1', gmv: '100', at })
    const l10 = line({ id: '10', pid: '501', base: '1', gmv: '100', at })
    for (const input of [[l10, l9, first], [first, l9, l10], [l9, first, l10]]) {
      const out = run(p, input)
      expect(out.lines.map((l) => [l.orderLineId, l.amountVnd])).toEqual([['500', B(10000)], ['9', B(20000)], ['10', B(20000)]])
      // Gate đạt ở dòng '9' (micro giây .000001), không bị gộp về .000000 như khi đi qua Date.
      expect(out.results[0].gate.metAtMicros).toBe(parseUtcMicros(at))
      expect(out.results[0].gate.metAtMicros).not.toBe(first.completedAtMicros)
    }
  })

  test('cùng đầu vào, khác thứ tự nhận từ nguồn ⇒ kết quả giống hệt', () => {
    const p = program(
      [prod('601', { gmvBasis: 'product', targetGmv: '300000', baseQuantityCms: '2.5' }),
        prod('602', { gmvBasis: 'catalog' }), prod('603', { gmvBasis: 'catalog', baseQuantityCms: '0.5' })],
      { catalogTargetGmv: '400000' },
    )
    const lines = [
      line({ pid: '601', base: '2.5', gmv: '100000', at: ts(3) }),
      line({ pid: '602', base: '1', gmv: '150000', at: ts(3) }),
      line({ pid: '603', email: EMAIL_B, base: '0.75', gmv: '300000', at: ts(1) }),
      line({ pid: '601', base: '5', gmv: '250000', at: ts(2) }),
      line({ pid: '603', base: '0.25', gmv: '260000', at: ts(4) }),
      line({ pid: '602', email: EMAIL_B, base: '3', gmv: '90000', at: ts(4) }),
    ]
    const a = run(p, lines)
    const b = run(p, [...lines].reverse())
    const c = run(p, [lines[4], lines[0], lines[5], lines[2], lines[1], lines[3]])
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })

  test('loại dòng theo điều kiện §2.5, biên kỳ VN, chưa gán, ngoài phạm vi; số liệu khớp quality', () => {
    const p = program([prod('101')])
    const lines = [
      line({ id: '1', pid: '101', base: '1', gmv: '1' }),
      line({ id: '2', pid: '101', base: '1', gmv: '1', type: 'ONLINE' }),
      line({ id: '3', pid: '101', base: '1', gmv: '1', status: 'CANCELLED' }),
      line({ id: '4', pid: '101', base: '1', gmv: '1', at: '2026-10-31T16:59:59.999999Z' }), // 23:59:59,999999 VN 31/10
      line({ id: '5', pid: '101', base: '1', gmv: '1', at: '2026-10-31T17:00:00.000000Z' }), // 00:00 VN 01/11
      line({ id: '6', pid: '101', base: '1', gmv: '1', at: '2026-11-30T16:59:59.999999Z' }), // cuối 30/11 VN
      line({ id: '7', pid: '101', base: '1', gmv: '1', at: '2026-11-30T17:00:00.000000Z' }), // 00:00 VN 01/12
      line({ id: '8', pid: '999', base: '1', gmv: '1' }),
      line({ id: '9', pid: '101', base: '1', gmv: '1', email: null }),
      line({ id: '10', pid: '101', base: '1', gmv: '1', email: 'khong.co@example.test' }),
      line({ id: '11', pid: '101', base: '1', gmv: '1', email: 'qlch.s1@example.test' }),
      line({ id: '12', pid: '101', base: '1', gmv: '1', email: 'trung@example.test' }),
      line({ id: '13', pid: '101', base: '1', gmv: '1', email: 'ds.fs@example.test' }),
      line({ id: '14', pid: '101', base: '1', gmv: '1', email: EMAIL_C }),
      line({ id: '15', pid: '101', base: '1', gmv: '1', email: '  DS.A@Example.Test ' }),
    ]
    const out = run(p, lines)
    const reasons = Object.fromEntries(out.excluded.map((e) => [e.orderLineId, e.unassignedReason ?? e.reason]))
    expect(reasons).toEqual({
      '2': 'ORDER_NOT_ELIGIBLE', '3': 'ORDER_NOT_ELIGIBLE', '4': 'OUT_OF_WINDOW', '7': 'OUT_OF_WINDOW', '8': 'PRODUCT_NOT_IN_PROGRAM',
      '9': 'NO_EMAIL', '10': 'NOT_FOUND', '11': 'SHARED_ACCOUNT', '12': 'MULTIPLE', '13': 'STORE_NOT_ELIGIBLE', '14': 'OUT_OF_SCOPE',
    })
    expect(out.excluded.find((e) => e.orderLineId === '14')).toMatchObject({ reason: 'OUT_OF_SCOPE', userId: 'u-c', storeId: 'S2' })
    expect(out.lines.map((l) => l.orderLineId)).toEqual(['5', '1', '15', '6'])
    expect(out.results).toHaveLength(1)
    expect(out.results[0]).toMatchObject({ userId: 'u-a', storeId: 'S1', cmsQuantity: B(4), amountVnd: B(60000) })
    expect(out.totals).toMatchObject({
      linesRead: 15, candidates: 10, candidateGmvUnits: U(10), unassigned: 5, unassignedGmvUnits: U(5), outOfScope: 1, included: 4,
      unassignedByReason: { NO_EMAIL: 1, NOT_FOUND: 1, SHARED_ACCOUNT: 1, MULTIPLE: 1, STORE_NOT_ELIGIBLE: 1 },
    })
    // Cùng định nghĩa ứng viên với quality.ts: 5/10 chưa gán > 20% ⇒ held.
    const verdict = assessSalesSnapshot({
      rowsRead: out.totals.linesRead, totalRowsReported: out.totals.linesRead, pagesComplete: true, rowIssues: [],
      lineIds: lines.map((l) => l.orderLineId), candidates: out.totals.candidates, unassigned: out.totals.unassigned, previousPublishedRows: null,
    })
    expect(verdict.reasons).toEqual(['UNASSIGNED_OVER_THRESHOLD'])
  })

  test('tính lại sau bổ sung sản phẩm hồi tố (Q-209): dòng đầu kỳ được tính, sản phẩm cũ không đổi', () => {
    const lines = [
      line({ pid: '701', base: '5', gmv: '500000', at: '2026-10-31T17:00:00.000000Z' }), // 00:00 VN ngày bắt đầu
      line({ pid: '702', base: '3', gmv: '300000', at: ts(10) }),
      line({ pid: '711', base: '1', gmv: '600000', at: ts(11) }),
      line({ pid: '712', base: '1', gmv: '500000', at: '2026-11-01T01:00:00.000000Z' }),
    ]
    const v1 = run(program([prod('702'), prod('711', { gmvBasis: 'catalog' })], { catalogTargetGmv: '1000000' }), lines)
    expect(v1.excluded.filter((e) => e.reason === 'PRODUCT_NOT_IN_PROGRAM').map((e) => e.productId).sort()).toEqual(['701', '712'])
    const v1r = new Map(v1.results.map((r) => [r.productId, r]))
    expect(v1r.get('711')!.amountVnd).toBe(ZERO) // danh mục 600.000 < 1 triệu

    const v2 = run(program(
      [prod('702'), prod('711', { gmvBasis: 'catalog' }), prod('701'), prod('712', { gmvBasis: 'catalog' })],
      { catalogTargetGmv: '1000000' },
    ), lines)
    const v2r = new Map(v2.results.map((r) => [r.productId, r]))
    expect(v2r.get('701')!.amountVnd).toBe(B(75000))
    expect(v2r.get('702')).toEqual(v1r.get('702'))
    // Sản phẩm danh mục bổ sung làm danh mục đạt từ đầu kỳ ⇒ 711 được tính hồi tố.
    expect(v2r.get('711')!.gate).toMatchObject({ met: true, metAtMicros: parseUtcMicros(ts(11)) })
    expect(v2r.get('711')!.amountVnd).toBe(B(15000))
    expect(v2.excluded).toHaveLength(0)
  })
})

test.describe('CMS P2-a · cấu hình và đầu vào sai ⇒ lỗi @desktop', () => {
  test('cấu hình sai bị từ chối với mã rõ ràng', () => {
    const cases: Array<[string, CmsEngineProgramInput, string]> = [
      ['ngày ngược', program([prod('1')], { startDate: '2026-11-30', endDate: '2026-11-01' }), 'BAD_DATES'],
      ['ngày không tồn tại', program([prod('1')], { endDate: '2026-11-31' }), 'BAD_DATES'],
      ['ProductID có số 0 đầu', program([prod('0123')]), 'BAD_PRODUCT_ID'],
      ['ProductID lặp', program([prod('1'), prod('1')]), 'DUPLICATE_PRODUCT'],
      ['gate sản phẩm thiếu target', program([prod('1', { gmvBasis: 'product' })]), 'BAD_TARGET'],
      ['target 0', program([prod('1', { gmvBasis: 'product', targetGmv: '0' })]), 'BAD_TARGET'],
      ['target lẻ', program([prod('1', { gmvBasis: 'product', targetGmv: '100.5' })]), 'BAD_TARGET'],
      ['target trên SP không target', program([prod('1', { targetGmv: '100' })]), 'BAD_TARGET'],
      ['danh mục thiếu target', program([prod('1', { gmvBasis: 'catalog' })]), 'CATALOG_TARGET_MISSING'],
      ['target danh mục 0', program([prod('1')], { catalogTargetGmv: '0' }), 'BAD_CATALOG_TARGET'],
      ['không có bậc', program([prod('1', { tiers: [] })]), 'BAD_TIERS'],
      ['bậc đầu không từ 1', program([prod('1', { tiers: [{ from: 2, to: null, amount: '1' }] })]), 'BAD_TIERS'],
      ['bậc hở', program([prod('1', { tiers: [{ from: 1, to: 9, amount: '1' }, { from: 11, to: null, amount: '2' }] })]), 'BAD_TIERS'],
      ['bậc chồng', program([prod('1', { tiers: [{ from: 1, to: 9, amount: '1' }, { from: 9, to: null, amount: '2' }] })]), 'BAD_TIERS'],
      ['bậc giữa để trống cận trên', program([prod('1', { tiers: [{ from: 1, to: null, amount: '1' }, { from: 10, to: null, amount: '2' }] })]), 'BAD_TIERS'],
      ['to < from', program([prod('1', { tiers: [{ from: 1, to: 0, amount: '1' }] })]), 'BAD_TIERS'],
      ['to < from ở bậc cuối hữu hạn (lỗi trước, không thành FINITE_LAST_TIER)', program([prod('1', { tiers: [{ from: 1, to: 9, amount: '1' }, { from: 10, to: 5, amount: '2' }] })]), 'BAD_TIERS'],
      ['bậc cuối hữu hạn — chưa chuyển đổi CMS-Q-220', program([prod('1', { tiers: TIERS_CAP50 })]), 'FINITE_LAST_TIER'],
      ['một bậc 1–50 — chưa chuyển đổi CMS-Q-220', program([prod('1', { tiers: [{ from: 1, to: 50, amount: '25000' }] })]), 'FINITE_LAST_TIER'],
      ['CMS_VND_SP = 0', program([prod('1', { tiers: [{ from: 1, to: null, amount: '0' }] })]), 'BAD_TIERS'],
      ['CMS_VND_SP lẻ', program([prod('1', { tiers: [{ from: 1, to: null, amount: '1.5' }] })]), 'BAD_TIERS'],
      ['số JS không an toàn', program([prod('1', { tiers: [{ from: 1, to: null, amount: 2 ** 53 }] })]), 'BAD_TIERS'],
      ['store id rỗng', program([prod('1')], { storeIds: [''] }), 'BAD_STORE_ID'],
    ]
    for (const [name, p, code] of cases) {
      expect(configErrorCode(() => computeCmsProgram({ program: p, lines: [], sellers: SELLERS })), name).toBe(code)
    }
    // Cấu hình hợp lệ, số / bigint / chuỗi đều nhận.
    const ok = parseCmsEngineProgram(program([prod('1', { gmvBasis: 'product', targetGmv: 10, tiers: [{ from: B(1), to: '3', amount: 7 }, { from: 4, to: null, amount: B(8) }] })]))
    expect(ok.products.get('1')).toMatchObject({ targetVnd: B(10), capQuantity: null, perUnitUnits: U(1) })
    expect(ok.products.get('1')!.tiers).toEqual([{ from: B(1), to: B(3), amountVnd: B(7) }, { from: B(4), to: null, amountVnd: B(8) }])
  })

  test('order_line_id lặp ⇒ lỗi đầu vào, không tính', () => {
    const dupA = line({ id: '77', pid: '101', base: '1', gmv: '1' })
    const dupB = line({ id: '77', pid: '101', base: '2', gmv: '2', at: ts(5) })
    let err: unknown = null
    try {
      computeCmsProgram({ program: program([prod('101')]), lines: [dupA, dupB], sellers: SELLERS })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(CmsEngineInputError)
    expect((err as CmsEngineInputError).lineIds).toEqual(['77'])
  })

  test('chương trình không có dòng ⇒ rỗng, tổng 0 (không phải lỗi)', () => {
    const out = run(program([prod('101')]), [])
    expect(out.results).toEqual([])
    expect(out.totals.amountVnd).toBe(ZERO)
    expect(out.totals.candidates).toBe(0)
  })
})

test.describe('CMS P2-a · chỉ số báo cáo §2.11 @desktop', () => {
  test('tử / mẫu, lượt, SP có CMS x/y; tổng nhà thuốc cộng từ cá nhân, không áp lại bậc', () => {
    const p = program([prod('101'), prod('102', { gmvBasis: 'product', targetGmv: '50000000' })])
    const out = run(p, [
      line({ pid: '101', base: '5', gmv: '500000', at: ts(1) }),
      line({ pid: '101', email: EMAIL_B, base: '5', gmv: '500000', at: ts(2) }),
      line({ pid: '102', base: '3', gmv: '1000000', at: ts(3) }),
      line({ pid: '102', email: 'khong.co@example.test', base: '9', gmv: '1', at: ts(4) }),
    ])
    const s = summarizeCmsProgram(out.results, { productIds: ['101', '102'], eligibleStaffIds: ['u-a', 'u-b', 'u-a', 'u-dup1'] })
    expect(s).toEqual({
      amountVnd: B(150000), productsWithCms: 1, productCount: 2, pharmacistsWithCms: 2, pharmacistDenominator: 3,
      turnsWithSales: 3, turnsAchieved: 2,
    })
    expect(summarizeCmsProgram(out.results, { productIds: ['101', '102'] }).pharmacistDenominator).toBeNull()
    // QLCH / SM: 75.000 + 75.000 = 150.000, KHÔNG phải F(5 + 5) = 155.000.
    expect(cmsAmountByStore(out.results)).toEqual(new Map([['S1', B(150000)]]))
    expect(cmsProgressiveAmount(B(10), parsedTiers(TIERS))).toBe(B(155000))
    // Gộp chương trình: u-a có CMS ở cả hai chương trình ⇒ đếm một lần.
    const other = run(program([prod('801')]), [line({ pid: '801', base: '1', gmv: '1' })])
    expect(countDistinctPharmacistsWithCms([out.results, other.results])).toBe(2)
  })
})

test.describe('CMS P2-a · đối chiếu oracle tham chiếu (fixture sinh xác định) @desktop', () => {
  // Oracle độc lập: cộng tiền TỪNG đơn vị trong khoảng (0, Q] theo bậc chứa nó — không dùng telescoping,
  // không dùng compute.ts; gate tự cộng lại từ dòng thô. CMS-Q-220: không có trần, đơn vị nào cũng thuộc một bậc.
  function naiveF(q: bigint, tiers: readonly CmsEngineTier[]): bigint {
    let total = ZERO
    for (let u = B(1); u <= q; u += B(1)) {
      const t = tiers.find((x) => u >= x.from && (x.to === null || u <= x.to))
      if (!t) throw new Error(`oracle: đơn vị ${u} không thuộc bậc nào (cấu hình có trần?)`)
      total += t.amountVnd
    }
    return total
  }
  function lcg(seed: number) {
    let s = seed >>> 0
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 2 ** 32
    }
  }

  test('300 dòng ngẫu nhiên xác định: kết quả = oracle, bất biến dòng, không phụ thuộc thứ tự', () => {
    const p = program(
      [
        prod('901', { gmvBasis: 'product', targetGmv: '3000000', baseQuantityCms: '2.5' }),
        prod('902', { gmvBasis: 'catalog' }),
        prod('903', { gmvBasis: 'catalog', baseQuantityCms: '0.5' }),
        prod('904', { baseQuantityCms: '10', tiers: [{ from: 1, to: 3, amount: '5000' }, { from: 4, to: null, amount: '7000' }] }),
        // Target rất cao ⇒ bảo đảm oracle đi qua nhánh gate chưa đạt.
        prod('906', { gmvBasis: 'product', targetGmv: '100000000', baseQuantityCms: '0.5' }),
      ],
      { catalogTargetGmv: '4000000' },
    )
    const rnd = lcg(20261102)
    const pids = ['901', '902', '903', '904', '905', '906']
    const emails = [EMAIL_A, EMAIL_B, EMAIL_C, 'qlch.s1@example.test']
    const lines: CmsSalesLine[] = []
    for (let i = 0; i < 300; i++) {
      const negative = rnd() < 0.08
      const base = (Math.floor(rnd() * 15000) / 1000) * (negative ? -1 : 1)
      const gmv = Math.floor(rnd() * 400000) * (negative ? -1 : 1)
      const day = 1 + Math.floor(rnd() * 30)
      const micros = Math.floor(rnd() * 3) // trùng timestamp có chủ đích ⇒ tie-break theo ID
      lines.push(line({
        id: String(i + 1), pid: pids[Math.floor(rnd() * pids.length)], email: emails[Math.floor(rnd() * emails.length)],
        base: base.toFixed(3), gmv: String(gmv),
        at: `2026-11-${String(day).padStart(2, '0')}T02:00:00.${String(micros).padStart(6, '0')}Z`,
      }))
    }
    const out = run(p, lines)
    const parsed = parseCmsEngineProgram(p)
    expect(out.results.length).toBeGreaterThan(4)
    expect(out.totals.adjustmentLines).toBeGreaterThan(0)

    const included = lines.filter((l) => l.productId !== '905' && (l.sellerEmail === EMAIL_A || l.sellerEmail === EMAIL_B))
    expect(out.totals.included).toBe(included.length)
    const uid = (e: string | null) => (e === EMAIL_A ? 'u-a' : 'u-b')
    const catalogGmv = new Map<string, bigint>()
    for (const l of included) {
      if (parsed.products.get(l.productId)!.gmvBasis === 'catalog') {
        catalogGmv.set(uid(l.sellerEmail), (catalogGmv.get(uid(l.sellerEmail)) ?? ZERO) + l.gmvUnits)
      }
    }
    for (const r of out.results) {
      const mine = included.filter((l) => uid(l.sellerEmail) === r.userId && l.productId === r.productId)
      const prodCfg = parsed.products.get(r.productId)!
      const b = mine.reduce((s, l) => s + l.baseQuantityUnits, ZERO)
      const gmv = mine.reduce((s, l) => s + l.gmvUnits, ZERO)
      const q = b > ZERO ? b / prodCfg.perUnitUnits : ZERO
      const met = prodCfg.gmvBasis === 'none'
        ? true
        : prodCfg.gmvBasis === 'product'
          ? gmv >= prodCfg.targetVnd! * CMS_DEC_FACTOR
          : (catalogGmv.get(r.userId) ?? ZERO) >= parsed.catalogTargetVnd! * CMS_DEC_FACTOR
      expect(r.baseQuantityUnits, `${r.userId}/${r.productId}`).toBe(b)
      expect(r.gmvUnits).toBe(gmv)
      expect(r.cmsQuantity).toBe(q)
      expect(r.rewardedQuantity).toBe(q)
      expect([r.capQuantity, r.atCap]).toEqual([null, false])
      expect(r.gate.met).toBe(met)
      expect(r.amountVnd, `${r.userId}/${r.productId}`).toBe(met ? naiveF(q, prodCfg.tiers) : ZERO)
      // "Đạt từ" (Q-211) tự dò lại: sắp độc lập (micro giây rồi BigInt id), cộng dồn, lấy lần chuyển chưa đạt → đạt cuối.
      if (prodCfg.gmvBasis !== 'none') {
        const gateLines = included
          .filter((l) => uid(l.sellerEmail) === r.userId && (prodCfg.gmvBasis === 'product'
            ? l.productId === r.productId
            : parsed.products.get(l.productId)!.gmvBasis === 'catalog'))
          .sort((x, y) => (x.completedAtMicros === y.completedAtMicros
            ? (BigInt(x.orderLineId) < BigInt(y.orderLineId) ? -1 : 1)
            : (x.completedAtMicros < y.completedAtMicros ? -1 : 1)))
        const target = (prodCfg.gmvBasis === 'product' ? prodCfg.targetVnd! : parsed.catalogTargetVnd!) * CMS_DEC_FACTOR
        let cum = ZERO
        let was = false
        let at: bigint | null = null
        for (const l of gateLines) {
          cum += l.gmvUnits
          const now = cum >= target
          if (now && !was) at = l.completedAtMicros
          was = now
        }
        expect(r.gate.metAtMicros, `metAt ${r.userId}/${r.productId}`).toBe(was ? at : null)
      }
    }
    // Thứ tự dòng đầu ra = sắp độc lập (micro giây rồi BigInt id).
    const expectedOrder = [...included].sort((x, y) => (x.completedAtMicros === y.completedAtMicros
      ? (BigInt(x.orderLineId) < BigInt(y.orderLineId) ? -1 : 1)
      : (x.completedAtMicros < y.completedAtMicros ? -1 : 1))).map((l) => l.orderLineId)
    expect(out.lines.map((l) => l.orderLineId)).toEqual(expectedOrder)
    expect(out.results.some((r) => r.gate.metAtMicros !== null)).toBe(true)
    expect(out.results.some((r) => r.gmvBasis !== 'none' && !r.gate.met)).toBe(true)
    // Vector phải đi qua vùng trên các mốc cuối cũ (50 / 100) và không sinh trạng thái lịch sử AT_CAP.
    expect(out.results.some((r) => r.cmsQuantity > B(100) && r.amountVnd > ZERO)).toBe(true)
    expect(out.lines.some((l) => l.status === 'AT_CAP')).toBe(false)

    const shuffled = [...lines]
    const rnd2 = lcg(7)
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd2() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    expect(run(p, shuffled)).toEqual(out)
    expect(run(p, [...lines].reverse())).toEqual(out)
  })
})
