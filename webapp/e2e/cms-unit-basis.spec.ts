import { test, expect } from '@playwright/test'
import { CMS_DEC_FACTOR } from '../lib/cms/decimal'
import { CmsEngineInputError, computeCmsProgram, type CmsEngineOutput } from '../lib/cms/engine/compute'
import { CmsEngineConfigError, type CmsEngineProductInput, type CmsEngineProgramInput } from '../lib/cms/engine/config'
import { cmsUnitBasisFromEnv } from '../lib/cms/flags'
import { canonicalCmsImport, validateCmsImport, type CmsProductMasterLite } from '../lib/cms/import/validate'
import { cmsImportKRequired } from '../lib/cms/import/handler'
import { cmsKClassify, cmsKUnitNorm, cmsParseKAckInput } from '../lib/cms/import/kCheck'
import { cmsApplyUnitBasisCheck } from '../lib/cms/import/unitCheck'
import type { CmsCell, CmsImportColumn, CmsImportRawRow } from '../lib/cms/import/parse'
import { buildSellerIndex } from '../lib/cms/mapping'
import { cmsProgramBasisClaim, cmsResolveProgramBasis } from '../lib/cms/programInput'
import { buildCmsStagePayload, cmsSnapshotToEngineInput, parseCmsSalesSnapshot } from '../lib/cms/resultStage'
import * as S from '../lib/cms/salesSync'
import { normalizeSalesRow, type CmsRawRow, type CmsSalesLine } from '../lib/cms/source/contract'
import { CMS_UNIT_CODES, parseCmsRunBasis } from '../lib/cms/unitBasis'
import {
  CMS_UNIT_CASE_LOWER, CMS_UNIT_CASE_UPPER, CMS_UNIT_INVISIBLE, CMS_UNIT_KEY_VERSION, CMS_UNIT_WS, cmsClassifyUnitLine, cmsUnitKey,
  cmsUnitQuantity, cmsUnitRawFlags,
} from '../lib/cms/unitKey'
import { createCmsFixtureRunner } from './cmsFixtureRunner'
import { fxSale } from './cmsSourceFixture'
import { cmsUnitOracle, oracleUnitKey } from './cmsUnitOracle'
import {
  A, B, C, L, O_SELLERS, P, PROG, STORES, USERS, calcOf, legacySnap, openOf, prog, scenario, snap128,
} from './cmsUnitScenario'

// CMS-UNIT (planning/research/cms-unit-basis-spec-implementation-2026-11-09.md §2 / §4 / §7) — phía TS: hợp đồng khoá đơn vị / lượng,
// engine nhánh cms_unit (AC01–AC05), tương thích pos_base (AC06), snapshot / metadata run + dấu writer (AC07 phía app), cổng âm gồm
// quantity_raw (AC09 phía app), import + tạo chương trình, và ORACLE ĐỘC LẬP (e2e/cmsUnitOracle.ts — không dùng engine) so mỗi cặp /
// tổng trên corpus sinh ngẫu nhiên có hạt giống (AC12). Fixture giả hoàn toàn (email @cms.example.test, UUID 00000000-…). Phía DB
// (128: seal / publish / guard / ACL / rollback / race / PG15) ở scripts/qa-cms-128.mjs.

const E9 = CMS_DEC_FACTOR
const N = (v: number | string) => BigInt(v)
// Fixture dùng chung (người dùng / nhà thuốc / SP / L() / kịch bản fuzz / snapshot 128): e2e/cmsUnitScenario.ts.
const SELLERS = buildSellerIndex(USERS, STORES)
const lines = (rows: CmsRawRow[]): CmsSalesLine[] => rows.map((r) => {
  const x = normalizeSalesRow(r)
  if (!x.ok) throw new Error(`fixture lỗi: ${JSON.stringify(x.issues)}`)
  return x.value
})
const run = (rows: CmsRawRow[], products: CmsEngineProductInput[] = [P('900001')], o: Partial<CmsEngineProgramInput> = {}) =>
  computeCmsProgram({ program: prog(products, o), lines: lines(rows), sellers: SELLERS })
const res = (out: CmsEngineOutput, user: string, pid: string) => out.results.find((r) => r.userId === user && r.productId === pid)
const unitErr = (f: () => unknown): CmsEngineInputError => {
  try { f() } catch (e) { if (e instanceof CmsEngineInputError) return e; throw e }
  throw new Error('không HOLD')
}
const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))

// ── AC03: hợp đồng khoá đơn vị (TS; parity PG15 / PGlite ở qa-cms-128) ─────────────────────────────────────────────────
test.describe('CMS-UNIT · khoá đơn vị cms-unit-key-v2 (AC03 / Q-225) @desktop', () => {
  test('NFC / NFD, hoa thường tiếng Việt, khoảng trắng tường minh; không alias, không cắt, không mờ', () => {
    expect(CMS_UNIT_KEY_VERSION).toBe('cms-unit-key-v2')
    const hop = 'hộp'
    expect(cmsUnitKey('Hộp'.normalize('NFD'))).toBe(hop)
    for (const v of ['HỘP', 'hỘp', 'Hộp', ' hộp ', ' hộp\u3000', '\u00a0hộp\u00a0', '\u2003hộp\u202f', '\u205fhộp\u1680']) {
      expect(cmsUnitKey(v), J(v)).toBe(hop)
    }
    expect(cmsUnitKey('BOX')).toBe('box')
    expect(cmsUnitKey('box')).not.toBe(cmsUnitKey('hộp'))
    expect(cmsUnitKey('h')).not.toBe(hop)
    expect(cmsUnitKey('vỉ')).not.toBe(cmsUnitKey('viên'))
    expect(cmsUnitKey('hop')).not.toBe(hop) // không xoá dấu
    expect(cmsUnitKey('hộp  lớn')).toBe('hộp  lớn') // không gộp khoảng trắng giữa chữ
    expect(cmsUnitKey('hộp  lớn')).not.toBe(cmsUnitKey('hộp lớn'))
    const long = 'Hộp'.repeat(100)
    expect(cmsUnitKey(long)).toBe('hộp'.repeat(100)) // không cắt 30 ký tự
    expect(cmsUnitKey('\u200bhộp')).toBeNull() // r1 Q-225: zero-width ⇒ KHÔNG HỢP LỆ (r0: "khác ĐV" ⇒ 0₫ âm thầm)
    expect(cmsUnitKey('ĐƯỜNG ƠI ỸỴ')).toBe('đường ơi ỹỵ')
    expect(cmsUnitKey('Σ')).toBe('Σ') // ngoài bảng ⇒ phân biệt hoa thường
    expect(cmsUnitKey('İ')).toBe('İ')
  })
  test('ký tự điều khiển / rỗng ⇒ không hợp lệ (null), không làm sạch thành đơn vị có vẻ hợp lệ', () => {
    for (const v of ['hộp\t', 'hộp\n', '\rhộp', '\u0085hộp', 'hộp\u007f', 'h\u0001p', '', ' ', '\u3000\u00a0', null, undefined]) {
      expect(cmsUnitKey(v as string | null), J(v)).toBeNull()
    }
  })
  test('r1 Q-225: ký tự vô hình (tối thiểu PM + phần BMP của Cf ∪ Default_Ignorable) ở đầu / giữa / cuối ⇒ null, không xoá để ép khớp', () => {
    expect(CMS_UNIT_INVISIBLE.flatMap(([a, b]) => [a.toString(16), b.toString(16)]).join(',')).toBe(
      'ad,ad,34f,34f,600,605,61c,61c,6dd,6dd,70f,70f,890,891,8e2,8e2,115f,1160,17b4,17b5,180b,180f,200b,200f,202a,202e,2060,206f,3164,3164,'
      + 'fe00,fe0f,feff,feff,ffa0,ffa0,fff0,fffb')
    // Tập tối thiểu PM (Q-225) nằm trọn trong tập.
    for (const cp of [0xad, 0x34f, 0x61c, 0x180e, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x206f, 0xfeff]) {
      expect(cmsUnitRawFlags(String.fromCodePoint(cp)).invisible, `PM U+${cp.toString(16)}`).toBe(true)
    }
    let n = 0
    for (const [a, b] of CMS_UNIT_INVISIBLE) {
      for (let cp = a; cp <= b; cp++) {
        const c = String.fromCodePoint(cp)
        for (const v of [c + 'hộp', 'h' + c + 'ộp', 'hộp' + c, c, ' ' + c + ' ', '\u00a0Hộp' + c, c + c]) {
          const tag = `U+${cp.toString(16)} ${J(v)}`
          expect(cmsUnitKey(v), tag).toBeNull()
          expect(oracleUnitKey(v), `oracle ${tag}`).toBeNull()
          expect(cmsUnitRawFlags(v), tag).toEqual({ control: false, invisible: true })
          n++
        }
      }
    }
    expect(n).toBe(7 * 80)
    // Khoảng trắng hợp lệ vẫn cắt hai đầu; ký tự sát biên tập vô hình KHÔNG bị coi là vô hình; điều khiển vẫn riêng cờ control.
    expect(cmsUnitKey('\u00a0Hộp\u3000')).toBe('hộp')
    expect(cmsUnitKey('\u202fhộp\u205f')).toBe('hộp')
    for (const cp of [0xac, 0xae, 0x34e, 0x350, 0x5ff, 0x606, 0x61b, 0x61d, 0x6dc, 0x6de, 0x70e, 0x710, 0x88f, 0x892, 0x8e1, 0x8e3, 0x115e,
      0x1161, 0x17b3, 0x17b6, 0x180a, 0x1810, 0x200a, 0x2010, 0x2029, 0x202f, 0x205f, 0x2070, 0x3163, 0x3165, 0xfdff, 0xfe10, 0xfefe, 0xff00,
      0xff9f, 0xffa1, 0xffef, 0xfffc]) {
      expect(cmsUnitRawFlags(String.fromCodePoint(cp)).invisible, `U+${cp.toString(16)}`).toBe(false)
    }
    expect(cmsUnitRawFlags('hộp\t')).toEqual({ control: true, invisible: false })
    expect(cmsUnitRawFlags('\ufeffhộp\t')).toEqual({ control: true, invisible: true })
  })
  test('r1 Q-225: quét toàn BMP — khoá TS = oracle độc lập (ký tự ở giữa và ở hai đầu: khoảng trắng, điều khiển, vô hình, chữ)', () => {
    const bad: string[] = []
    for (let cp = 1; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const c = String.fromCodePoint(cp)
      for (const v of ['h' + c + 'ộp', c + 'hộp' + c]) if (cmsUnitKey(v) !== oracleUnitKey(v)) bad.push(`U+${cp.toString(16)}`)
    }
    expect(bad.slice(0, 20)).toEqual([])
  })
  test('bảng hoa → thường 243 cặp khứ hồi + NFC; khoá TS = oracle dựng lại từ Unicode trên mọi ký tự bảng + chuỗi trộn', () => {
    const up = [...CMS_UNIT_CASE_UPPER]
    const lo = [...CMS_UNIT_CASE_LOWER]
    expect([up.length, lo.length]).toEqual([243, 243])
    up.forEach((u, i) => {
      expect(u.toLowerCase(), u).toBe(lo[i])
      expect(lo[i].toUpperCase(), u).toBe(u)
      expect(u.normalize('NFC')).toBe(u)
    })
    expect([...CMS_UNIT_WS].map((c) => c.codePointAt(0)!.toString(16)).join(',')).toBe('20,a0,1680,2000,2001,2002,2003,2004,2005,2006,2007,2008,2009,200a,2028,2029,202f,205f,3000')
    const corpus = [...up, ...lo, 'Hộp', 'HỘP VIÊN', 'Ống 10ml', 'Tuýp', 'Gói', 'CHAI 100ML', 'Σσ', 'ǅ', 'ẞ', 'Ⅻ', 'Ｈộp', ' Ẩ ', '\u00a0Ư\u3000']
    for (const s of corpus) {
      expect(cmsUnitKey(s), J(s)).toBe(oracleUnitKey(s))
      expect(cmsUnitKey(s.normalize('NFD')), J(s)).toBe(oracleUnitKey(s.normalize('NFD')))
    }
  })
})

// ── AC02: lượng nguyên chính xác ────────────────────────────────────────────────────────────────────────────────────────
test.describe('CMS-UNIT · lượng đúng ĐV phải nguyên (AC02 / Q-223 / UNIT-D01) @desktop', () => {
  const cls = (q: string | null, uom: string | null = 'hộp', rc?: { uom: boolean; quantity: boolean }) =>
    cmsClassifyUnitLine({ uomRaw: uom, quantityRaw: q, ...(rc ? { rawControl: rc } : {}) }, 'hộp')
  test('0 / 1 / 1.000000000 / âm nguyên nhận; lẻ, sai hình thức, ngoài miền ⇒ lý do riêng', () => {
    expect(cls('0')).toEqual({ kind: 'COUNTED', qty: N(0), negative: false })
    expect(cls('1')).toEqual({ kind: 'COUNTED', qty: N(1), negative: false })
    expect(cls('1.000000000')).toEqual({ kind: 'COUNTED', qty: N(1), negative: false })
    expect(cls('0001')).toEqual({ kind: 'COUNTED', qty: N(1), negative: false })
    expect(cls('-2')).toEqual({ kind: 'COUNTED', qty: N(-2), negative: true })
    expect(cls('9223372036854775807')).toEqual({ kind: 'COUNTED', qty: N('9223372036854775807'), negative: false })
    expect(cls('0.5')).toEqual({ kind: 'INVALID', reason: 'QTY_FRACTION' })
    expect(cls('1.000000001')).toEqual({ kind: 'INVALID', reason: 'QTY_FRACTION' })
    expect(cls('9223372036854775808')).toEqual({ kind: 'INVALID', reason: 'QTY_RANGE' })
    expect(cls('-9223372036854775808')).toEqual({ kind: 'INVALID', reason: 'QTY_RANGE' })
    for (const q of ['1e3', '1E3', '1,5', '+1', ' 1', '1 ', '.5', '1.', '1.0000000001', '0x10', '１', 'NaN', '1' + '0'.repeat(29)]) {
      expect(cls(q), q).toEqual({ kind: 'INVALID', reason: 'QTY_INVALID' })
    }
    expect(cls(null)).toEqual({ kind: 'INVALID', reason: 'QTY_MISSING' })
    expect(cls('')).toEqual({ kind: 'INVALID', reason: 'QTY_MISSING' })
    expect(cmsUnitQuantity('1' + '0'.repeat(28))).toEqual({ ok: true, units: N('1' + '0'.repeat(28)) * E9 })
  })
  test('khác ĐV: lượng lẻ hợp lệ hình thức KHÔNG HOLD (không vào Q); đơn vị thiếu / điều khiển / lượng điều khiển ⇒ HOLD', () => {
    expect(cls('0.5', 'viên')).toEqual({ kind: 'OTHER_UNIT', negative: false })
    expect(cls('-0.5', 'viên')).toEqual({ kind: 'OTHER_UNIT', negative: true })
    expect(cls('abc', 'viên')).toEqual({ kind: 'INVALID', reason: 'QTY_INVALID' })
    expect(cls('1', null)).toEqual({ kind: 'INVALID', reason: 'UNIT_MISSING' })
    expect(cls('1', '')).toEqual({ kind: 'INVALID', reason: 'UNIT_MISSING' })
    expect(cls('1', '\u3000')).toEqual({ kind: 'INVALID', reason: 'UNIT_INVALID' })
    expect(cls('1', 'hộp', { uom: true, quantity: false })).toEqual({ kind: 'INVALID', reason: 'UNIT_INVALID' })
    expect(cls('1', 'hộp', { uom: false, quantity: true })).toEqual({ kind: 'INVALID', reason: 'QTY_INVALID' })
    expect(cls('1', 'h\u200bộp')).toEqual({ kind: 'INVALID', reason: 'UNIT_INVALID' }) // r1 Q-225: không phải "khác ĐV"
    expect(cls('1', 'h\u00adộp')).toEqual({ kind: 'INVALID', reason: 'UNIT_INVALID' })
  })
  test('nguồn: ký tự điều khiển ở giá trị THÔ gắn rawControl (dòng sạch giữ shape cũ, không có khoá)', () => {
    const clean = normalizeSalesRow(fxSale({}))
    expect(clean.ok && 'rawControl' in clean.value).toBe(false)
    const tab = normalizeSalesRow(fxSale({ uom_raw: 'hộp\t' }))
    expect(tab.ok && tab.value.uomRaw).toBe('hộp')
    expect(tab.ok && tab.value.rawControl).toEqual({ uom: true, quantity: false })
    const nel = normalizeSalesRow(fxSale({ quantity_raw: '1\u0085' }))
    expect(nel.ok && nel.value.rawControl).toEqual({ uom: false, quantity: true })
    // r1 Q-225: FEFF hai đầu bị adapter trim mất ⇒ marker lấy trên giá trị THÔ; U+200B giữa chuỗi / FEFF trước lượng cũng đánh dấu.
    const bom = normalizeSalesRow(fxSale({ uom_raw: 'hộp\ufeff' }))
    expect(bom.ok && bom.value.uomRaw).toBe('hộp')
    expect(bom.ok && bom.value.rawControl).toEqual({ uom: true, quantity: false })
    const zw = normalizeSalesRow(fxSale({ uom_raw: 'h\u200bộp', quantity_raw: '\ufeff1' }))
    expect(zw.ok && zw.value.quantityRaw).toBe('1')
    expect(zw.ok && zw.value.rawControl).toEqual({ uom: true, quantity: true })
    const nb = normalizeSalesRow(fxSale({ uom_raw: '\u00a0hộp\u00a0' }))
    expect(nb.ok && 'rawControl' in nb.value).toBe(false)
  })
})

// ── AC01 / AC04 / AC05: engine ──────────────────────────────────────────────────────────────────────────────────────────
test.describe('CMS-UNIT · engine cms_unit (AC01 / AC04 / AC05) @desktop', () => {
  test('AC01: hộp × 1 được tính; viên / vỉ đủ K vẫn 0; không nhân lại B / qty; pos_base cùng dữ liệu theo B / K', () => {
    const rows = [
      L({ uom_raw: 'hộp', quantity_raw: '1', base_quantity: '24' }),
      L({ uom_raw: 'HỘP', quantity_raw: '2', base_quantity: '48' }),
      L({ uom_raw: 'viên', quantity_raw: '24', base_quantity: '24' }),
      L({ uom_raw: 'vỉ', quantity_raw: '2', base_quantity: '20' }),
    ]
    const u = run(rows)
    const r = res(u, A, '900001')!
    expect([r.cmsQuantity, r.amountVnd, r.baseQuantityUnits, r.perUnitUnits]).toEqual([N(3), N(3000), N(116) * E9, N(24) * E9])
    expect(u.lines.map((l) => [l.countedQuantity, l.unitMatch, l.qtyBefore, l.qtyAfter, l.amountVnd])).toEqual([
      [N(1), true, N(0), N(1), N(1000)], [N(2), true, N(1), N(3), N(2000)], [N(0), false, N(3), N(3), N(0)], [N(0), false, N(3), N(3), N(0)],
    ])
    expect(u.lines.map((l) => [l.baseBeforeUnits / E9, l.baseAfterUnits / E9])).toEqual([[N(0), N(24)], [N(24), N(72)], [N(72), N(96)], [N(96), N(116)]])
    expect([u.totals.unitMatchedLines, u.totals.unitOtherLines]).toEqual([2, 2])
    const p = run(rows, [P('900001')], { quantityBasis: 'pos_base' })
    expect(res(p, A, '900001')!.cmsQuantity).toBe(N(4)) // floor(116 / 24) — luật cũ khác luật mới trên cùng dữ liệu
  })
  test('AC01: SP cấu hình ĐV viên ⇒ dòng viên được tính, dòng hộp 0; nhóm chỉ khác đơn vị ⇒ Q 0 nhưng giữ dòng / GMV', () => {
    const v = run([L({ product_id: '900002', uom_raw: 'Viên', quantity_raw: '30', base_quantity: '30' }),
      L({ product_id: '900002', uom_raw: 'hộp', quantity_raw: '1', base_quantity: '30' })], [P('900002', { unitCms: 'viên', baseQuantityCms: '1', tiers: [{ from: 1, to: null, amount: '100' }] })])
    expect([res(v, A, '900002')!.cmsQuantity, res(v, A, '900002')!.amountVnd]).toEqual([N(30), N(3000)])
    const o = run([L({ uom_raw: 'viên', quantity_raw: '100', base_quantity: '100', gmv_amount: '500000' })])
    const r = res(o, A, '900001')!
    expect([r.cmsQuantity, r.amountVnd, r.potentialAmountVnd, r.gmvUnits, r.lineCount]).toEqual([N(0), N(0), N(0), N(500000) * E9, 1])
    expect(o.lines[0]).toMatchObject({ countedQuantity: N(0), unitMatch: false, amountVnd: N(0) })
  })
  test('AC04: biên bậc 9 / 10 / 19 / 20 / 100 (nhiều bậc), mức cố định, bậc cuối không trần; phân bổ dòng qua mốc', () => {
    const F: Record<number, bigint> = { 9: N(9000), 10: N(11000), 19: N(29000), 20: N(32000), 100: N(272000) }
    for (const [q, amt] of Object.entries(F)) {
      const o = run([L({ quantity_raw: String(q), base_quantity: '1' })])
      expect([res(o, A, '900001')!.cmsQuantity, res(o, A, '900001')!.amountVnd], q).toEqual([N(q), amt])
    }
    const fixed = run([L({ quantity_raw: '100' })], [P('900001', { tiers: [{ from: 1, to: null, amount: '5000' }] })])
    expect(res(fixed, A, '900001')!.amountVnd).toBe(N(500000))
    const cross = run([L({ quantity_raw: '8' }), L({ quantity_raw: '3' })])
    expect(cross.lines.map((l) => l.amountVnd)).toEqual([N(8000), N(5000)]) // F(11) − F(8) = 13.000 − 8.000
  })
  test('AC04: dòng khác ĐV vẫn giúp vượt target SP / danh mục (tập GMV cũ); tiền chỉ từ lượng đúng ĐV', () => {
    const p2 = P('900002', { unitCms: 'viên', gmvBasis: 'product', targetGmv: '100000', baseQuantityCms: '1', tiers: [{ from: 1, to: null, amount: '500' }] })
    const met = run([L({ product_id: '900002', uom_raw: 'hộp', quantity_raw: '1', gmv_amount: '80000' }),
      L({ product_id: '900002', uom_raw: 'viên', quantity_raw: '5', gmv_amount: '30000' })], [p2])
    expect([res(met, A, '900002')!.gate.met, res(met, A, '900002')!.amountVnd]).toEqual([true, N(2500)])
    const not = run([L({ product_id: '900002', uom_raw: 'viên', quantity_raw: '5', gmv_amount: '30000' })], [p2])
    expect([res(not, A, '900002')!.gate.met, res(not, A, '900002')!.amountVnd, res(not, A, '900002')!.potentialAmountVnd]).toEqual([false, N(0), N(2500)])
    const p3 = P('900003', { unitCms: 'Chai', gmvBasis: 'catalog' }), p4 = P('900004', { gmvBasis: 'catalog' })
    const cat = run([L({ product_id: '900003', uom_raw: 'viên', quantity_raw: '3', gmv_amount: '250000' }),
      L({ product_id: '900004', uom_raw: 'hộp', quantity_raw: '2', gmv_amount: '60000' })], [p3, p4], { catalogTargetGmv: '300000' })
    expect([res(cat, A, '900003')!.cmsQuantity, res(cat, A, '900003')!.amountVnd]).toEqual([N(0), N(0)])
    expect([res(cat, A, '900004')!.gate.met, res(cat, A, '900004')!.amountVnd]).toEqual([true, N(2000)])
  })
  test('AC05: Σ dòng = nhóm = run; Q = max(ΣC, 0); B thật; K chỉ là metadata — đổi K không đổi Q / tiền (pos_base thì đổi)', () => {
    const rows = [L({ quantity_raw: '5', base_quantity: '120' }), L({ uom_raw: 'viên', quantity_raw: '7', base_quantity: '7' }),
      L({ seller_email: 'ds.b@cms.example.test', quantity_raw: '12', base_quantity: '288' }), L({ quantity_raw: '-2', base_quantity: '-48', gmv_amount: '-240000' })]
    const outs = ['24', '1', '7.5'].map((k) => run(rows, [P('900001', { baseQuantityCms: k })]))
    for (const o of outs) {
      expect(o.lines.reduce((s, l) => s + l.amountVnd, N(0))).toBe(o.totals.amountVnd)
      expect(o.results.reduce((s, r) => s + r.amountVnd, N(0))).toBe(o.totals.amountVnd)
      for (const r of o.results) {
        const ls = o.lines.filter((l) => l.userId === r.userId && l.productId === r.productId)
        const c = ls.reduce((s, l) => s + l.countedQuantity!, N(0))
        expect(r.cmsQuantity).toBe(c > N(0) ? c : N(0))
        expect(r.baseQuantityUnits).toBe(ls.reduce((s, l) => s + l.baseQuantityUnits, N(0)))
      }
      expect(o.results.map((r) => [r.userId, r.cmsQuantity, r.amountVnd])).toEqual(outs[0].results.map((r) => [r.userId, r.cmsQuantity, r.amountVnd]))
    }
    expect(outs.map((o) => o.results[0].perUnitUnits)).toEqual([N(24) * E9, E9, N(75) * E9 / N(10)])
    const pos = ['24', '1'].map((k) => run(rows, [P('900001', { baseQuantityCms: k })], { quantityBasis: 'pos_base' }).totals.amountVnd)
    expect(pos[0]).not.toBe(pos[1])
  })
  test('điều chỉnh: quantity_raw âm (mọi đơn vị) ⇒ ADJUSTMENT + cổng âm; C âm ⇒ Q 0; pos_base không đếm quantity_raw', () => {
    const rows = [L({ quantity_raw: '3' }), L({ quantity_raw: '-1', base_quantity: '-24', gmv_amount: '-120000' }),
      L({ uom_raw: 'viên', quantity_raw: '-2', base_quantity: '2', gmv_amount: '1000' }),
      L({ seller_email: 'nobody@cms.example.test', uom_raw: 'viên', quantity_raw: '-1', base_quantity: '1', gmv_amount: '1' }),
      L({ seller_email: 'ds.c@cms.example.test', quantity_raw: '-1', base_quantity: '1', gmv_amount: '1' })]
    const u = run(rows)
    expect(u.lines.map((l) => [l.status, l.qtyAfter, l.amountVnd])).toEqual([
      ['RECORDED', N(3), N(3000)], ['ADJUSTMENT', N(2), N(-1000)], ['ADJUSTMENT', N(2), N(0)],
    ])
    expect(u.totals.adjustmentLines).toBe(2)
    expect(S.cmsNegativeCandidateLines(u)).toBe(4)
    expect(u.excluded.filter((x) => x.reason === 'UNASSIGNED' || x.reason === 'OUT_OF_SCOPE').map((x) => x.rawQuantityNegative)).toEqual([true, true])
    const p = run(rows, [P('900001')], { quantityBasis: 'pos_base' })
    expect([p.totals.adjustmentLines, S.cmsNegativeCandidateLines(p)]).toEqual([1, 1])
    const neg = run([L({ quantity_raw: '-2' })])
    expect([res(neg, A, '900001')!.cmsQuantity, neg.lines[0].qtyBefore, neg.lines[0].qtyAfter]).toEqual([N(0), N(0), N(0)])
  })
})

// ── HOLD nguồn (UNIT-D01) ───────────────────────────────────────────────────────────────────────────────────────────────
test.describe('CMS-UNIT · HOLD nguồn đơn vị / lượng (UNIT-D01) @desktop', () => {
  test('0,5 + 0,5 cùng ĐV ⇒ HOLD cả lượt (không thành 1); 1.000000001 / thiếu / sai hình thức ⇒ HOLD theo lý do', () => {
    const e = unitErr(() => run([L({ quantity_raw: '0.5' }), L({ quantity_raw: '0.5' }), L({ quantity_raw: '1' })]))
    expect([e.code, e.unitIssues, e.lineIds.length]).toEqual(['UNIT_SOURCE_INVALID', { QTY_FRACTION: 2 }, 2])
    expect(unitErr(() => run([L({ quantity_raw: '1.000000001' })])).unitIssues).toEqual({ QTY_FRACTION: 1 })
    expect(unitErr(() => run([L({ quantity_raw: null })])).unitIssues).toEqual({ QTY_MISSING: 1 })
    expect(unitErr(() => run([L({ quantity_raw: '1e3', uom_raw: 'viên' })])).unitIssues).toEqual({ QTY_INVALID: 1 })
    expect(unitErr(() => run([L({ uom_raw: null })])).unitIssues).toEqual({ UNIT_MISSING: 1 })
    expect(unitErr(() => run([L({ uom_raw: 'hộp\t' }), L({ quantity_raw: '2\u0085' })])).unitIssues).toEqual({ UNIT_INVALID: 1, QTY_INVALID: 1 })
  })
  test('phạm vi HOLD = mọi dòng ỨNG VIÊN (cả chưa gán / ngoài phạm vi); không ứng viên (ONLINE / ngoài kỳ / SP ngoài CT) không HOLD', () => {
    expect(unitErr(() => run([L({ seller_email: 'nobody@cms.example.test', quantity_raw: '0.5' })])).unitIssues).toEqual({ QTY_FRACTION: 1 })
    expect(unitErr(() => run([L({ seller_email: 'ds.c@cms.example.test', uom_raw: null })])).unitIssues).toEqual({ UNIT_MISSING: 1 })
    const ok = run([L({ order_type: 'ONLINE', quantity_raw: '0.5' }), L({ completed_at: '2026-11-07T03:00:00.000000Z', uom_raw: null }),
      L({ product_id: '900009', quantity_raw: '0.5' }), L({ quantity_raw: '2' })])
    expect(res(ok, A, '900001')!.cmsQuantity).toBe(N(2))
  })
  test('pos_base không đổi: cùng nguồn lỗi đơn vị vẫn tính như cũ (không HOLD mới)', () => {
    const p = run([L({ quantity_raw: '0.5' }), L({ uom_raw: null }), L({ uom_raw: 'hộp\t' })], [P('900001')], { quantityBasis: 'pos_base' })
    expect(res(p, A, '900001')!.cmsQuantity).toBe(N(3))
  })
})

// ── AC06: pos_base giữ nguyên shape / số; cấu hình ─────────────────────────────────────────────────────────────────────
test.describe('CMS-UNIT · tương thích pos_base + cấu hình (AC06) @desktop', () => {
  test('pos_base tường minh ≡ thiếu khoá (byte); output không mang khoá cms_unit', () => {
    const rows = [L({ quantity_raw: '1', base_quantity: '30' }), L({ seller_email: 'nobody@cms.example.test' }), L({ seller_email: 'ds.c@cms.example.test' }),
      L({ uom_raw: 'viên', base_quantity: '-3', gmv_amount: '-100' })]
    const { quantityBasis: _q, ...legacy } = prog([P('900001', { unitCms: undefined })])
    void _q
    const a = computeCmsProgram({ program: legacy, lines: lines(rows), sellers: SELLERS })
    const b = computeCmsProgram({ program: { ...legacy, quantityBasis: 'pos_base' }, lines: lines(rows), sellers: SELLERS })
    expect(J(a)).toBe(J(b))
    expect(J(a)).not.toMatch(/countedQuantity|unitMatch|rawQuantityNegative|unitMatchedLines|unitOtherLines/)
  })
  test('cms_unit thiếu / sai ĐV tính CMS ⇒ BAD_UNIT; cơ sở lạ ⇒ BAD_QUANTITY_BASIS; pos_base thiếu đơn vị vẫn hợp lệ', () => {
    for (const unitCms of [null, undefined, '', ' ', 'hộp\t']) {
      expect(() => run([], [P('900001', { unitCms })]), J(unitCms)).toThrow(CmsEngineConfigError)
      try { run([], [P('900001', { unitCms })]) } catch (e) { expect((e as CmsEngineConfigError).code).toBe('BAD_UNIT') }
    }
    expect(() => run([], [P('900001')], { quantityBasis: 'xyz' as never })).toThrow(/BAD_QUANTITY_BASIS/)
    expect(() => run([], [P('900001', { unitCms: null })], { quantityBasis: 'pos_base' })).not.toThrow()
  })
  test('cờ CMS_UNIT_BASIS_ENABLED: chỉ đúng "true" và cần CMS_PROGRAM_ENABLED', () => {
    expect(cmsUnitBasisFromEnv({ CMS_PROGRAM_ENABLED: 'true', CMS_UNIT_BASIS_ENABLED: 'true' })).toBe(true)
    expect(cmsUnitBasisFromEnv({ CMS_PROGRAM_ENABLED: 'true', CMS_UNIT_BASIS_ENABLED: 'TRUE' })).toBe(false)
    expect(cmsUnitBasisFromEnv({ CMS_PROGRAM_ENABLED: 'false', CMS_UNIT_BASIS_ENABLED: 'true' })).toBe(false)
    expect(cmsUnitBasisFromEnv({})).toBe(false)
  })
})

// ── AC12: oracle độc lập trên corpus ngẫu nhiên có hạt giống ─────────────────────────────────────────────────────────────
test.describe('CMS-UNIT · oracle độc lập (AC12) @desktop', () => {
  test('300 kịch bản: mỗi cặp Q / tiềm năng / tiền / gate + tổng + dòng âm khớp oracle; kịch bản lỗi nguồn HOLD cùng lý do', () => {
    let held = 0, compared = 0, posDiffers = 0
    for (let seed = 1; seed <= 300; seed++) {
      const { rows, oprog, eprog } = scenario(seed, seed % 5 === 0)
      const o = cmsUnitOracle(oprog, rows, O_SELLERS)
      let out: CmsEngineOutput | null = null
      let err: CmsEngineInputError | null = null
      try { out = computeCmsProgram({ program: eprog, lines: lines(rows), sellers: SELLERS }) } catch (e) {
        if (!(e instanceof CmsEngineInputError)) throw e
        err = e
      }
      if (o.hold) {
        expect(err?.code, `seed ${seed}`).toBe('UNIT_SOURCE_INVALID')
        expect(err!.unitIssues, `seed ${seed}`).toEqual(o.hold)
        held++
        continue
      }
      expect(err, `seed ${seed}`).toBeNull()
      compared++
      const got = new Map(out!.results.map((x) => [`${x.userId}|${x.productId}`, x]))
      expect([...got.keys()].sort(), `seed ${seed}`).toEqual([...o.pairs.keys()].sort())
      for (const [k, v] of o.pairs) {
        const x = got.get(k)!
        expect([x.cmsQuantity, x.potentialAmountVnd, x.amountVnd, x.gate.met, x.baseQuantityUnits, x.gmvUnits], `seed ${seed} ${k}`)
          .toEqual([v.q, v.potential, v.amount, v.gateMet, v.b, v.gmv])
      }
      expect(out!.totals.amountVnd, `seed ${seed}`).toBe(o.total)
      expect(S.cmsNegativeCandidateLines(out!), `seed ${seed}`).toBe(o.negativeCandidates)
      // Oracle PHÂN BIỆT công thức cũ: tính pos_base trên cùng dữ liệu ⇒ phần lớn kịch bản lệch oracle.
      const pos = computeCmsProgram({ program: { ...eprog, quantityBasis: 'pos_base' }, lines: lines(rows), sellers: SELLERS })
      if (pos.results.some((x) => { const v = o.pairs.get(`${x.userId}|${x.productId}`); return !v || v.q !== x.cmsQuantity || v.amount !== x.amountVnd })) posDiffers++
    }
    expect(held).toBeGreaterThanOrEqual(40)
    expect(compared).toBeGreaterThanOrEqual(200)
    expect(posDiffers / compared).toBeGreaterThan(0.9)
  })
})

// ── Snapshot / metadata run / dấu writer (AC06 / AC07 phía app) ──────────────────────────────────────────────────────────
test.describe('CMS-UNIT · snapshot / metadata run / dấu writer @desktop', () => {
  test('legacy (DB trước 128): pos_base luật cũ, không dấu writer; 128: cơ sở + unit_cms + dấu writer', () => {
    const l = parseCmsSalesSnapshot(legacySnap())
    expect([l.quantityBasis, l.calculationPolicyVersion, l.basisLegacy, l.unitKeyVersion, l.products[0].unitCms]).toEqual(['pos_base', 'pos_base_legacy', true, null, null])
    const lo = parseCmsSalesSnapshot(openOf(legacySnap(), null))
    expect(lo.calculationSnapshotChecked).toBe(false)
    const lp = buildCmsStagePayload(l, [], computeCmsProgram({ ...cmsSnapshotToEngineInput(l), lines: [] }), { rowsRead: 0, rowsRejected: 0, bytesProcessed: null })
    expect('quantity_basis' in lp.expect || 'calculation_policy_version' in lp.expect).toBe(false)
    const u = parseCmsSalesSnapshot(openOf(snap128()))
    expect([u.quantityBasis, u.calculationPolicyVersion, u.basisLegacy, u.calculationSnapshotChecked, u.products[0].unitCms]).toEqual(['cms_unit', 'cms_unit_v1', false, true, 'Hộp'])
    const ei = cmsSnapshotToEngineInput(u)
    expect([ei.program.quantityBasis, ei.program.products[0].unitCms]).toEqual(['cms_unit', 'Hộp'])
    const up = buildCmsStagePayload(u, [], computeCmsProgram({ ...ei, lines: [] }), { rowsRead: 0, rowsRejected: 0, bytesProcessed: null })
    expect([up.expect.quantity_basis, up.expect.calculation_policy_version]).toEqual(['cms_unit', 'cms_unit_v1'])
    const pb = parseCmsSalesSnapshot(snap128({ quantity_basis: 'pos_base', calculation_policy_version: 'pos_base_v1' }))
    expect([pb.quantityBasis, pb.calculationPolicyVersion, pb.basisLegacy]).toEqual(['pos_base', 'pos_base_v1', false])
  })
  test('enum / phiên bản lạ, cặp lệch, thiếu unit_cms, khoá đơn vị khác hợp đồng ⇒ snapshot không hợp lệ (không tự chọn pos_base)', () => {
    const bad: Record<string, unknown>[] = [
      snap128({ quantity_basis: 'unit' }), snap128({ quantity_basis: null }), snap128({ calculation_policy_version: 'pos_base_v1' }),
      snap128({ quantity_basis: 'pos_base', calculation_policy_version: 'pos_base_legacy' }), snap128({ unit_key_version: 'cms-unit-key-v1' }),
      snap128({ unit_key_version: 'cms-unit-key-v3' }),
      snap128({ unit_key_version: undefined }),
    ]
    const noUnit = snap128(); delete (noUnit.products as Record<string, unknown>[])[0].unit_cms
    bad.push(noUnit)
    for (const b of bad) expect(() => parseCmsSalesSnapshot(b), J(b).slice(0, 160)).toThrow()
    expect(() => parseCmsRunBasis({ quantity_basis: null, calculation_policy_version: null })).toThrow()
    expect(() => parseCmsRunBasis({ quantity_basis: 'cms_unit' })).toThrow()
    expect(() => parseCmsRunBasis({ quantity_basis: 'cms_unit', calculation_policy_version: 'pos_base_v1' })).toThrow()
    expect(parseCmsRunBasis({})).toEqual({ basis: 'pos_base', policy: 'pos_base_legacy', legacy: true })
    expect(parseCmsRunBasis({ quantity_basis: 'pos_base', calculation_policy_version: 'pos_base_legacy' })).toEqual({ basis: 'pos_base', policy: 'pos_base_legacy', legacy: true })
    expect(parseCmsRunBasis({ quantity_basis: 'cms_unit', calculation_policy_version: 'cms_unit_v1' })).toEqual({ basis: 'cms_unit', policy: 'cms_unit_v1', legacy: false })
  })
  test('calculation_snapshot của run: bắt buộc ở run_open 128, cấm ở snapshot chỉ đọc / legacy, đối chiếu từng trường + parity khoá đơn vị', () => {
    const s = snap128()
    expect(() => parseCmsSalesSnapshot(openOf(s, null))).toThrow(/calculation_snapshot/)
    expect(() => parseCmsSalesSnapshot({ ...s, calculation_snapshot: calcOf(s) })).toThrow(/calculation_snapshot/)
    expect(() => parseCmsSalesSnapshot(openOf(legacySnap(), calcOf(s)))).toThrow(/calculation_snapshot/)
    const drift: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ config_version: 6 }, {}], [{ quantity_basis: 'pos_base' }, {}], [{ schema: 'v0' }, {}], [{ end_date: '2026-11-07' }, {}],
      [{}, { unit_cms: 'hộp' }], [{}, { base_quantity_cms: '12' }], [{}, { tiers: [{ order: 1, from: 1, to: null, amount: '1001' }] }],
      [{}, { unit_key: 'hop' }], [{}, { unit_key: null }], [{ products: [] }, {}],
    ]
    for (const [o, p] of drift) expect(() => parseCmsSalesSnapshot(openOf(s, calcOf(s, o, p))), J([o, p])).toThrow(/calculation_snapshot/)
    const pb = snap128({ quantity_basis: 'pos_base', calculation_policy_version: 'pos_base_v1' })
    expect(parseCmsSalesSnapshot(openOf(pb, calcOf(pb, {}, { unit_key: 'khác' }))).calculationSnapshotChecked).toBe(true) // parity chỉ ép với cms_unit
  })
})

// ── salesSync (deps giả, không DB / BigQuery) ───────────────────────────────────────────────────────────────────────────
type Call = { fn: string; args: unknown[] }
function fake(o: { snap?: Record<string, unknown>; sales?: CmsRawRow[]; open?: Record<string, unknown> } = {}) {
  const calls: Call[] = []
  const log = (fn: string, ...args: unknown[]) => { calls.push({ fn, args }) }
  const snap = o.snap ?? snap128()
  let t = 1_000_000
  const deps: S.CmsSalesSyncDeps = {
    table: 'qa-project.dataset.cms_sales',
    runner: createCmsFixtureRunner({ sales: o.sales ?? [L({ quantity_raw: '2' }), L({ uom_raw: 'viên', quantity_raw: '24' })] }),
    loadSnapshot: async (id) => { log('loadSnapshot', id); return snap },
    // DB legacy (snapshot không có khoá cơ sở) ⇒ run_open không trả calculation_snapshot.
    openRun: async (id, d) => { log('openRun', id, d); return o.open ?? openOf(snap, 'quantity_basis' in snap ? calcOf(snap) : null) },
    stage: async (run, part, no, rows) => { log('stage', run, part, no); return rows.length },
    sealBegin: async (run, e) => { log('sealBegin', run, e); return { ok: true } },
    sealStep: async (run, n) => { log('sealStep', run, n); return n === 10 ? { sealed: true } : { ok: true } },
    publish: async (run) => { log('publish', run); return { published: true } },
    finish: async (run, st, d) => { log('finish', run, st, d) },
    cleanup: async () => ({ purged: 0, deleted: 0, more: false }),
    now: () => (t += 10),
  }
  return { deps, calls, fns: () => calls.map((c) => c.fn) }
}

test.describe('CMS-UNIT · salesSync (cờ / override chỉ đọc / HOLD nguồn / dấu writer) @desktop', () => {
  test('chương trình cms_unit + cờ OFF ⇒ held UNIT_BASIS_DISABLED trước khi đọc nguồn / stage; cờ ON ⇒ công bố với dấu writer', async () => {
    const off = fake()
    const r = await S.runCmsSalesSync(off.deps, PROG, { dryRun: false, source: 'qa' })
    expect([r.status, r.code, r.quantityBasis]).toEqual(['held', CMS_UNIT_CODES.disabled, 'cms_unit'])
    expect(off.fns()).not.toContain('stage')
    expect(off.calls.find((c) => c.fn === 'finish')!.args[1]).toBe('held')
    const on = fake()
    const r2 = await S.runCmsSalesSync(on.deps, PROG, { dryRun: false, source: 'qa', unitBasisEnabled: true, sourceCapture: true })
    expect([r2.status, r2.amountVnd]).toEqual(['published', '2000'])
    const e = on.calls.find((c) => c.fn === 'sealBegin')!.args[1] as Record<string, unknown>
    expect([e.quantity_basis, e.calculation_policy_version]).toEqual(['cms_unit', 'cms_unit_v1'])
    const dry = fake()
    const r3 = await S.runCmsSalesSync(dry.deps, PROG, { dryRun: true, source: 'operator' })
    expect([r3.status, r3.code, r3.amountVnd, dry.fns()]).toEqual(['dry_run', null, '2000', ['loadSnapshot']])
  })
  test('r1 UNIT-P1-2: cms_unit + cờ ON nhưng capture lớp nguồn OFF ⇒ held UNIT_SOURCE_CAPTURE_REQUIRED trước khi đọc nguồn; pos_base không đổi', async () => {
    const off = fake()
    const r = await S.runCmsSalesSync(off.deps, PROG, { dryRun: false, source: 'qa', unitBasisEnabled: true })
    expect([r.status, r.code]).toEqual(['held', CMS_UNIT_CODES.captureRequired])
    expect(off.fns()).toEqual(['loadSnapshot', 'openRun', 'finish'])
    expect(off.calls.find((c) => c.fn === 'finish')!.args[1]).toBe('held')
    const on = fake()
    const r2 = await S.runCmsSalesSync(on.deps, PROG, { dryRun: false, source: 'qa', unitBasisEnabled: true, sourceCapture: true })
    expect(r2.status).toBe('published')
    expect(on.calls.filter((c) => c.fn === 'stage').map((c) => c.args[1])).toContain('source_lines')
    const pb = fake({ snap: snap128({ quantity_basis: 'pos_base', calculation_policy_version: 'pos_base_v1' }) })
    const r3 = await S.runCmsSalesSync(pb.deps, PROG, { dryRun: false, source: 'qa' })
    expect([r3.status, pb.calls.some((c) => c.fn === 'stage' && c.args[1] === 'source_lines')]).toEqual(['published', false])
    const dry = await S.runCmsSalesSync(fake().deps, PROG, { dryRun: true, source: 'operator' })
    expect(dry.status).toBe('dry_run')
  })
  test('r1 UNIT-P1-2: DB publish giữ run cms_unit (UNIT_SOURCE_MISMATCH) ⇒ held đúng mã, không báo published', async () => {
    const f = fake()
    f.deps.publish = async () => ({ published: false, code: 'UNIT_SOURCE_MISMATCH' })
    const r = await S.runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'qa', unitBasisEnabled: true, sourceCapture: true })
    expect([r.status, r.code]).toEqual(['held', 'UNIT_SOURCE_MISMATCH'])
  })
  test('basisOverride: lượt ghi ⇒ từ chối trước mọi I/O; dry-run tính thử theo cơ sở khác; DB legacy ⇒ không hỗ trợ', async () => {
    const w = fake()
    const r = await S.runCmsSalesSync(w.deps, PROG, { dryRun: false, source: 'operator', basisOverride: 'cms_unit', unitBasisEnabled: true, sourceCapture: true })
    expect([r.status, r.code, w.calls.length]).toEqual(['error', S.CMS_BASIS_OVERRIDE_WRITE_FORBIDDEN, 0])
    const pb = snap128({ quantity_basis: 'pos_base', calculation_policy_version: 'pos_base_v1' })
    const base = await S.runCmsSalesSync(fake({ snap: pb }).deps, PROG, { dryRun: true, source: 'operator' })
    const ov = await S.runCmsSalesSync(fake({ snap: pb }).deps, PROG, { dryRun: true, source: 'operator', basisOverride: 'cms_unit' })
    expect([base.quantityBasis, base.amountVnd, ov.quantityBasis, ov.calculationPolicyVersion, ov.amountVnd]).toEqual(['pos_base', '2000', 'cms_unit', 'cms_unit_v1', '2000'])
    const ov2 = await S.runCmsSalesSync(fake({ snap: pb, sales: [L({ quantity_raw: '1', base_quantity: '72' })] }).deps, PROG, { dryRun: true, source: 'operator', basisOverride: 'cms_unit' })
    const b2 = await S.runCmsSalesSync(fake({ snap: pb, sales: [L({ quantity_raw: '1', base_quantity: '72' })] }).deps, PROG, { dryRun: true, source: 'operator' })
    expect([b2.amountVnd, ov2.amountVnd]).toEqual(['3000', '1000'])
    const lg = await S.runCmsSalesSync(fake({ snap: legacySnap() }).deps, PROG, { dryRun: true, source: 'operator', basisOverride: 'cms_unit' })
    expect([lg.status, lg.code]).toEqual(['dry_run', CMS_UNIT_CODES.dbUnsupported])
  })
  test('HOLD nguồn: lẻ ⇒ UNIT_QUANTITY_FRACTION; hỏng + lẻ ⇒ UNIT_SOURCE_INVALID (+ lý do), chi tiết chỉ số đếm; không stage', async () => {
    const f = fake({ sales: [L({ quantity_raw: '0.5' }), L({ quantity_raw: '0.5' }), L({ quantity_raw: '3' })] })
    const r = await S.runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'qa', unitBasisEnabled: true, sourceCapture: true })
    expect([r.status, r.code, r.reasons, r.unitInvalid]).toEqual(['held', CMS_UNIT_CODES.fraction, [CMS_UNIT_CODES.fraction], { QTY_FRACTION: 2 }])
    const d = f.calls.find((c) => c.fn === 'finish')!.args[2] as Record<string, unknown>
    expect([d.error_code, d.unit_invalid_lines, d.unit_invalid_by_reason]).toEqual([CMS_UNIT_CODES.fraction, 2, 'QTY_FRACTION=2'])
    expect(f.fns()).not.toContain('stage')
    const g = fake({ sales: [L({ quantity_raw: '0.5' }), L({ uom_raw: null })] })
    const r2 = await S.runCmsSalesSync(g.deps, PROG, { dryRun: false, source: 'qa', unitBasisEnabled: true, sourceCapture: true })
    expect([r2.code, r2.reasons]).toEqual([CMS_UNIT_CODES.sourceInvalid, [CMS_UNIT_CODES.sourceInvalid, CMS_UNIT_CODES.fraction]])
    expect(S.cmsUnitHold({ UNIT_MISSING: 1, QTY_FRACTION: 2 }).detail).toEqual({ unit_invalid_lines: 3, unit_invalid_by_reason: 'QTY_FRACTION=2,UNIT_MISSING=1' })
  })
  test('chương trình thật cms_unit: quantity_raw âm ở dòng khác ĐV ⇒ held trả hàng (không công bố phần dương); legacy / pos_base: dấu writer đúng', async () => {
    const real = snap128({ is_test: false })
    const f = fake({ snap: real, sales: [L({ quantity_raw: '2' }), L({ uom_raw: 'viên', quantity_raw: '-1', base_quantity: '1', gmv_amount: '1' })] })
    const r = await S.runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron', unitBasisEnabled: true, sourceCapture: true })
    expect([r.status, r.code]).toEqual(['held', 'RETURNS_NOT_SUPPORTED_THIS_PHASE'])
    expect(f.fns()).not.toContain('publish')
    const lg = fake({ snap: legacySnap() })
    await S.runCmsSalesSync(lg.deps, PROG, { dryRun: false, source: 'qa' })
    const le = lg.calls.find((c) => c.fn === 'sealBegin')!.args[1] as Record<string, unknown>
    expect('quantity_basis' in le).toBe(false)
    const pb = snap128({ quantity_basis: 'pos_base', calculation_policy_version: 'pos_base_v1' })
    const p = fake({ snap: pb })
    await S.runCmsSalesSync(p.deps, PROG, { dryRun: false, source: 'qa' })
    const pe = p.calls.find((c) => c.fn === 'sealBegin')!.args[1] as Record<string, unknown>
    expect([pe.quantity_basis, pe.calculation_policy_version]).toEqual(['pos_base', 'pos_base_v1'])
  })
  test('snapshot run_open thiếu / lệch calculation_snapshot ⇒ error SNAPSHOT_INVALID (đóng run, không tính)', async () => {
    const s = snap128()
    const f = fake({ open: openOf(s, calcOf(s, { config_version: 4 })) })
    const r = await S.runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'qa', unitBasisEnabled: true, sourceCapture: true })
    expect([r.status, r.code]).toEqual(['error', 'SNAPSHOT_INVALID'])
    expect(f.fns()).not.toContain('stage')
  })
})

// ── Import + tạo chương trình ───────────────────────────────────────────────────────────────────────────────────────────
const cell = (v: string | number | null): CmsCell => (v === null ? { kind: 'empty' } : typeof v === 'number' ? { kind: 'number', value: v } : { kind: 'text', value: v })
function irow(excelRow: number, o: Partial<Record<CmsImportColumn, string | number | null>> = {}): CmsImportRawRow {
  const raw: Record<CmsImportColumn, string | number | null> = {
    ProductID: '900001', KPI_Target_GMV_VND: null, Loai_CMS_GMV: null, Tu_SL_ban: 1, Den_SL_ban: null, CMS_VND_SP: 1000,
    Noi_dung_tu_van: 'Tư vấn giả', unit_CMS: 'hộp', base_quantity_CMS: 24, ...o,
  }
  const cells = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, cell(v)])) as Record<CmsImportColumn, CmsCell>
  return { excelRow, cells, raw }
}
const PM = new Map<string, CmsProductMasterLite>(['900001', '900002', '900003'].map((id) => [id, { productName: `SP ${id}`, imageUrl: null, isActive: true, referencePrice: null }]))
const vctx = { mode: 'replace' as const, productMaster: PM, existingProductIds: new Set<string>(), conflictProductIds: new Set<string>(), currentCatalogTarget: null }

test.describe('CMS-UNIT · import + tạo chương trình @desktop', () => {
  test('cms_unit: unit_CMS có ký tự điều khiển / khoá rỗng ⇒ loại nhóm (mọi mẫu file); pos_base không đổi', () => {
    const rows = [irow(2), irow(3, { ProductID: '900002', unit_CMS: 'hộp\tlớn' }), irow(4, { ProductID: '900003', unit_CMS: '\u0085hộp' })]
    const v = validateCmsImport(rows, vctx)
    expect(v.groupsOk.map((g) => g.productId)).toEqual(['900001', '900002', '900003'])
    const u = cmsApplyUnitBasisCheck(v, rows)
    expect(u.groupsOk.map((g) => g.productId)).toEqual(['900001'])
    expect(u.groupsRejected.map((g) => [g.key, g.errors[0].code])).toEqual([['900002', 'UNIT_CMS_CONTROL'], ['900003', 'UNIT_CMS_CONTROL']])
    expect([u.stats.productsOk, u.stats.productsRejected, u.stats.rowsOk]).toEqual([1, 2, 1])
    expect(cmsApplyUnitBasisCheck(validateCmsImport([irow(2)], vctx), [irow(2)])).toEqual(validateCmsImport([irow(2)], vctx))
  })
  test('r1 Q-225: unit_CMS có ký tự vô hình (kể cả FEFF / U+200B ở hai đầu bị trim) ⇒ loại nhóm UNIT_CMS_INVISIBLE; NBSP hai đầu vẫn hợp lệ', () => {
    const rows = [irow(2, { unit_CMS: '\u00a0hộp\u00a0' }), irow(3, { ProductID: '900002', unit_CMS: 'hộp\ufeff' }),
      irow(4, { ProductID: '900003', unit_CMS: '\u200bhộp' })]
    const v = validateCmsImport(rows, vctx)
    expect(v.groupsOk.map((g) => g.productId)).toEqual(['900001', '900002', '900003'])
    const x = cmsApplyUnitBasisCheck(v, rows)
    expect(x.groupsOk.map((g) => g.productId)).toEqual(['900001'])
    expect(x.groupsRejected.map((g) => [g.key, g.errors[0].code, g.errors[0].column])).toEqual([['900002', 'UNIT_CMS_INVISIBLE', 'unit_CMS'], ['900003', 'UNIT_CMS_INVISIBLE', 'unit_CMS']])
    const ctl = [irow(2, { unit_CMS: '\ufeffhộp\t' })]
    expect(cmsApplyUnitBasisCheck(validateCmsImport(ctl, vctx), ctl).groupsRejected[0].errors[0].code).toBe('UNIT_CMS_CONTROL') // điều khiển ưu tiên
  })
  test('digest: pos_base giữ NGUYÊN chuỗi cũ; cms_unit gắn cơ sở + phiên bản khoá đơn vị ⇒ đổi cơ sở giữa preview / commit ⇒ 409', () => {
    const v = validateCmsImport([irow(2)], vctx)
    expect(canonicalCmsImport(v, 'tiers', 'pos_base')).toBe(canonicalCmsImport(v))
    const u = JSON.parse(canonicalCmsImport(v, 'tiers', 'cms_unit'))
    expect([u.quantityBasis, u.unitKeyVersion]).toEqual(['cms_unit', 'cms-unit-key-v2'])
    expect(canonicalCmsImport(v, 'tiers', 'cms_unit')).not.toBe(canonicalCmsImport(v))
  })
  test('kiểm K / bằng chứng đơn vị: cms_unit so bằng cmsUnitKey (ký tự điều khiển ở POS không thành KHỚP); bắt buộc cả khi cờ v2 OFF', () => {
    const norm = cmsKUnitNorm('cms_unit')
    const t = [{ productId: '900001', unit: norm('HỘP')!, k: N(24) * E9 }]
    const ev = (uomRaw: string) => ({ ok: true as const, asOf: '2026-11-09', rows: [{ productId: '900001', uomRaw, q: E9, b: N(24) * E9, lines: N(3) }] })
    expect(cmsKClassify(t, ev('Hộp'), [], norm)[0].status).toBe('MATCH')
    expect(cmsKClassify(t, ev('Hộp\t'), [], norm)[0].status).toBe('NO_EVIDENCE')
    expect(cmsKClassify([{ ...t[0], unit: cmsKUnitNorm('pos_base')('HỘP')! }], ev('Hộp\t'))[0].status).toBe('MATCH') // luật cũ lỏng hơn — chỉ pos_base
    expect(cmsKClassify(t, ev('Hộp'.normalize('NFD') + '\u00a0'), [], norm)[0].status).toBe('MATCH')
    expect(cmsParseKAckInput(JSON.stringify([{ product_id: '900001', unit: 'HỘP\u3000', k: '24', source: 'quy cách NCC' }]), norm)![0].unit).toBe('hộp')
    expect(cmsImportKRequired({ v2: false }, { quantityBasis: 'cms_unit' })).toBe(true)
    expect(cmsImportKRequired({ v2: false }, { quantityBasis: 'pos_base' })).toBe(false)
    expect(cmsImportKRequired({ v2: false }, {})).toBe(false)
    expect(cmsImportKRequired({ v2: true }, {})).toBe(true)
  })
  test('tạo / sửa chương trình: server quyết cơ sở theo cờ; enum lạ / khẳng định khác ⇒ từ chối; sửa không đổi cơ sở', () => {
    expect(cmsProgramBasisClaim({})).toEqual({ ok: true, value: null })
    expect(cmsProgramBasisClaim({ quantity_basis: null })).toEqual({ ok: true, value: null })
    expect(cmsProgramBasisClaim({ quantity_basis: 'cms_unit' })).toEqual({ ok: true, value: 'cms_unit' })
    expect(cmsProgramBasisClaim({ quantity_basis: 'CMS_UNIT' }).ok).toBe(false)
    expect(cmsProgramBasisClaim({ quantity_basis: 1 }).ok).toBe(false)
    expect(cmsResolveProgramBasis(null, { kind: 'create', unitBasisEnabled: true })).toEqual({ ok: true, value: 'cms_unit' })
    expect(cmsResolveProgramBasis(null, { kind: 'create', unitBasisEnabled: false })).toEqual({ ok: true, value: 'pos_base' })
    expect(cmsResolveProgramBasis('pos_base', { kind: 'create', unitBasisEnabled: true }).ok).toBe(false)
    expect(cmsResolveProgramBasis('cms_unit', { kind: 'create', unitBasisEnabled: false }).ok).toBe(false)
    expect(cmsResolveProgramBasis(null, { kind: 'update', current: 'cms_unit' })).toEqual({ ok: true, value: 'cms_unit' })
    expect(cmsResolveProgramBasis('pos_base', { kind: 'update', current: 'cms_unit' }).ok).toBe(false)
  })
})
