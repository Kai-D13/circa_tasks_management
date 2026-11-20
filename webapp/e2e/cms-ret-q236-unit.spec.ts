import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { CMS_DEC_FACTOR } from '../lib/cms/decimal'
import { buildSellerIndex } from '../lib/cms/mapping'
import { normalizeSalesRow, type CmsRawRow } from '../lib/cms/source/contract'
import { parseUtcMicros } from '../lib/cms/time'
import { cmsCalcSaleLine, computeCmsNet, type CmsCalcInput, type CmsCalcOutput } from '../lib/cms/calc/net'
import {
  CMS_RETURN_STATUS_DICTIONARY_V2, cmsReturnNotEffectiveStatuses, cmsReturnStatusDictionaryVersion, normalizeReturnRow, type CmsReturnRecord,
} from '../lib/cms/calc/returns'
import {
  CMS_CALC_CONTRACT_VERSION, CMS_CALC_CONTRACT_VERSION_V2, cmsCalcContractVersionFor, cmsPolicyReadsReturns, parseCmsReturnsPolicy,
  type CmsReturnsPolicy,
} from '../lib/cms/calc/policy'
import { cmsReturnFinancialFp, cmsReturnFinancialFpV2 } from '../lib/cms/calc/fp'
import { CMS_CAPABILITY_RPCS, CMS_CAPABILITY_VERSIONS, CMS_CAPABILITY_VERSIONS_V2, parseCmsCapabilities } from '../lib/cms/calc/capabilities'
import {
  CMS_CLOSE_REPORT_MAX_RETURNS, CMS_CLOSE_REPORT_MAX_RETURNS_FULL_LINE, CmsCloseReportTooLargeError, buildCmsCloseReportPayload, cmsCloseReportMaxReturns,
} from '../lib/cms/calc/closeReport'
import { parseCmsRunContract } from '../lib/cms/resultView'
import { parseCmsCloseReportPage, parseCmsCloseReports, parseCmsReturnConflicts, cmsCloseReportReturnBaseLabel } from '../lib/cms/returnsView'
import { cmsLineView, cmsNetQtyText, cmsResultScopeNote } from '../lib/cms/resultUi'
import { CMS_RETURNS_POLICY_LABEL } from '../lib/cms/calc/basisUi'
import {
  CMS_AFTER_CLOSE_WINDOW_DAYS, CMS_MANUAL_REPORT_CODE_LABEL, cmsAfterCloseProfile, cmsAfterCloseWindow, parseCmsManualReportInput, runCmsManualCloseReport,
  runCmsReturnsAfterClose, type CmsAfterCloseDeps, type CmsAfterClosePayoutRun, type CmsManualReportDeps,
} from '../lib/cms/returnsAfterClose'
import { createCmsContractFixtureProvider } from './cmsContractFixture'
import { oracleCompute, type OracleCase, type OracleReturnRow, type OracleSaleRow } from './cmsCalcRet2Oracle'
import { P1, P2, at, base, prod, ret, sale } from './cmsCalcRet2Cases'

// Q-236 (PM work order 18/11; design Dev r1 18/11) — profile full_line_qty_refund_v1, phần THUẦN (không DB / mạng / BigQuery / cờ):
//   · bảng AC F01–F06 viết tay = oracle độc lập (e2e/cmsCalcRet2Oracle.ts — không import app) = app (lib/cms/calc/net.ts);
//   · vi sai ngẫu nhiên có seed app ↔ oracle (nhiều phiếu / dòng, trùng µs, trạng thái v2, lượng BI rác);
//   · bất biến F07: lượng BI không đổi kết quả; net_returns_v1 giữ nghĩa cũ (hồi quy);
//   · registry / capability / parser hợp đồng / fp v2 / payload báo cáo sau chốt / job sau chốt / nhãn UI–XLSX.
// DB (seal SQL độc lập, ledger, báo cáo, rollback, ACL): scripts/qa-cms-132.mjs (PGlite).

const FULL = 'full_line_qty_refund_v1' as const satisfies CmsReturnsPolicy
const ZERO = BigInt(0)
const U = (n: number | string | bigint) => BigInt(n) * CMS_DEC_FACTOR
const U1 = 'u-1', U2 = 'u-2'

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
  }
}
type AppRun = { sourceError: true } | { sourceError: false; input: CmsCalcInput; out: CmsCalcOutput }
function runApp(c: OracleCase): AppRun {
  const profile = c.returnsPolicy === 'sales_only_v1' ? 'net_returns_v1' : c.returnsPolicy
  const sales = c.sales.map((s) => {
    const raw = rawSale(s)
    const n = normalizeSalesRow(raw)
    if (!n.ok) throw new Error(`fixture bán lỗi ${s.id}`)
    return cmsCalcSaleLine(raw, n.value)
  })
  const returns: CmsReturnRecord[] = []
  for (const r of c.returns) {
    const n = normalizeReturnRow(rawReturn(r, c.sales), profile)
    if (!n.ok) return { sourceError: true }
    returns.push(n.value)
  }
  const input: CmsCalcInput = {
    program: {
      startDate: c.start, endDate: c.end, catalogTargetGmv: c.catalogTarget, storeIds: c.stores, quantityBasis: c.quantityBasis, returnsPolicy: c.returnsPolicy,
      products: c.products.map((p) => ({ productId: p.pid, gmvBasis: p.basis, targetGmv: p.target, baseQuantityCms: p.k, unitCms: p.unit, tiers: p.tiers })),
    },
    sales, returns,
    sellers: buildSellerIndex(c.users.map((u) => ({ id: u.id, email: u.email, role: u.role, storeId: u.store })), c.storeRefs.map((s) => ({ id: s.id, storeType: s.type, isActive: s.active }))),
    asOfMicros: parseUtcMicros(c.asOf)!,
  }
  return { sourceError: false, input, out: computeCmsNet(input) }
}
const appHolds = (r: AppRun): string[] | null =>
  r.sourceError ? ['SOURCE_ROW_INVALID'] : r.out.ok ? null : [...new Set(r.out.holds.map((h) => h.code))].sort()
function compareWithOracle(c: OracleCase, r: AppRun) {
  const o = oracleCompute(c)
  expect(appHolds(r), 'tập HOLD app = oracle').toEqual(o.hold)
  if (o.hold !== null || r.sourceError || !r.out.ok) return o
  const appGroups = r.out.results.map((g) => ({
    user: g.userId, pid: g.productId, saleBase: g.saleBaseUnits, retBase: g.returnBaseUnits, netBase: g.netBaseUnits,
    eligSale: g.eligibleSaleBaseUnits, eligRet: g.eligibleReturnBaseUnits, eligNet: g.eligibleNetBaseUnits, q: g.cmsQuantity,
    saleGmv: g.saleGmvUnits, retGmv: g.returnGmvUnits, netGmv: g.netGmvUnits, met: g.gate.met, amount: g.amountVnd, metAt: g.gate.metAtMicros,
  })).sort((a, b) => (`${a.user}|${a.pid}` < `${b.user}|${b.pid}` ? -1 : 1))
  expect(appGroups, 'nhóm app = oracle').toEqual(o.groups)
  expect(r.out.totals.amountVnd).toBe(o.total)
  expect(r.out.history.map((h) => ({ key: h.key, at: h.atMicros, before: h.eligibleBeforeUnits, after: h.eligibleAfterUnits, amount: h.amountVnd })),
    'phân bổ từng sự kiện app = oracle').toEqual(o.events)
  return o
}
const ok = (r: AppRun) => { if (r.sourceError || !r.out.ok) throw new Error(`app không có kết quả: ${JSON.stringify(appHolds(r))}`); return r.out }
const grp = (out: CmsCalcOutput & { ok: true }, user: string, pid = P1) => {
  const g = out.results.find((x) => x.userId === user && x.productId === pid)
  if (!g) throw new Error(`thiếu nhóm ${user}|${pid}`)
  return g
}
const retDelta = (out: CmsCalcOutput & { ok: true }, id: string) => {
  const h = out.history.find((x) => x.key === `RETURN:${id}`)
  if (!h) throw new Error(`thiếu sự kiện ${id}`)
  return { elig: h.eligibleAfterUnits - h.eligibleBeforeUnits, base: h.baseDeltaUnits, gmv: h.gmvDeltaUnits }
}
const full = (o: Partial<OracleCase> = {}) => base({ returnsPolicy: 'full_line_qty_refund_v1', ...o })

// ── F01–F06: kỳ vọng tay = oracle = app ─────────────────────────────────────────────────────────────────────────────────────────────
test.describe('Q-236 · full_line — bảng AC (tay = oracle = app) @desktop', () => {
  test('F01 BI 1/2 hộp ⇒ trừ đủ dòng (2 hộp); dòng khác cùng SP giữ nguyên; GMV trừ đúng tiền hoàn', () => {
    const s1 = sale('11', { q: '2', b: '200', g: '50000' }), s2 = sale('12', { q: '3', b: '300', g: '60000' })
    const c = full({ sales: [s1, s2], returns: [ret('RT1', s1, '1', '20000')] })
    const r = runApp(c)
    compareWithOracle(c, r)
    const g = grp(ok(r) as CmsCalcOutput & { ok: true }, U1)
    // B bán 500, trừ 200 (đủ dòng s1, BI 1 bỏ qua) ⇒ 300 ⇒ Q3 × 25.000; GMV 110.000 − 20.000.
    expect([g.returnBaseUnits, g.eligibleNetBaseUnits, g.cmsQuantity, g.amountVnd, g.netGmvUnits]).toEqual([U(200), U(300), BigInt(3), BigInt(75000), U(90000)])
  })
  test('F01 hồi quy net_returns_v1 cùng fixture ⇒ trừ lượng BI (100) như 130', () => {
    const s1 = sale('11', { q: '2', b: '200', g: '50000' }), s2 = sale('12', { q: '3', b: '300', g: '60000' })
    const c = base({ sales: [s1, s2], returns: [ret('RT1', s1, '100', '20000')] })
    const r = runApp(c)
    compareWithOracle(c, r)
    const g = grp(ok(r) as CmsCalcOutput & { ok: true }, U1)
    expect([g.returnBaseUnits, g.cmsQuantity]).toEqual([U(100), BigInt(4)])
    expect((ok(r) as CmsCalcOutput & { ok: true }).policy.contractVersion).toBe(CMS_CALC_CONTRACT_VERSION)
  })
  test('F02 nhiều phiếu một dòng (B 400, 310.000 + 310.000) ⇒ trừ 400 MỘT lần tại phiếu sớm nhất, GMV 620.000', () => {
    const s1 = sale('21', { q: '4', b: '400', g: '640000' }), s2 = sale('22', { q: '1', b: '100', g: '100000' })
    const c = full({ sales: [s1, s2], returns: [ret('RT-LATE', s1, '40', '310000', { at: at(20, 2) }), ret('RT-EARLY', s1, '20', '310000', { at: at(20, 1) })] })
    const r = runApp(c)
    compareWithOracle(c, r)
    const out = ok(r) as CmsCalcOutput & { ok: true }
    const g = grp(out, U1)
    expect([g.returnBaseUnits, g.cmsQuantity, g.amountVnd, g.returnGmvUnits, g.netGmvUnits]).toEqual([U(400), BigInt(1), BigInt(25000), U(620000), U(120000)])
    expect(retDelta(out, 'RT-EARLY').elig).toBe(-U(400))
    expect(retDelta(out, 'RT-LATE').elig).toBe(ZERO)
    expect(out.totals.returnBaseAppliedUnits).toBe(U(400))
    expect(out.policy.contractVersion).toBe(CMS_CALC_CONTRACT_VERSION_V2)
  })
  test('F02 cùng µs ⇒ phiếu mang lượng = ID nhỏ hơn theo byte UTF-8 (không theo thứ tự nguồn)', () => {
    const s1 = sale('23', { q: '2', b: '200', g: '100000' })
    const c = full({ sales: [s1], returns: [ret('RT-b', s1, '1', '1000', { at: at(20, 5) }), ret('RT-B', s1, '1', '1000', { at: at(20, 5) })] })
    const r = runApp(c)
    compareWithOracle(c, r)
    const out = ok(r) as CmsCalcOutput & { ok: true }
    // 'B' (0x42) < 'b' (0x62).
    expect([retDelta(out, 'RT-B').elig, retDelta(out, 'RT-b').elig]).toEqual([-U(200), ZERO])
  })
  test('F03 refund riêng từng phiếu: 4.800 bán, hoàn 4.448 ⇒ GMV ròng 352; Σ refund > GMV dòng ⇒ HOLD; Σ BI > B KHÔNG HOLD', () => {
    const s1 = sale('31', { q: '1', b: '100', g: '4800' })
    const c1 = full({ sales: [s1], returns: [ret('RT1', s1, '1', '4448')] })
    const r1 = runApp(c1)
    compareWithOracle(c1, r1)
    expect(grp(ok(r1) as CmsCalcOutput & { ok: true }, U1).netGmvUnits).toBe(U(352))
    const c2 = full({ sales: [s1], returns: [ret('RT1', s1, '1', '4000'), ret('RT2', s1, '1', '801', { at: at(20, 3) })] })
    expect(compareWithOracle(c2, runApp(c2)).hold).toEqual(['RETURN_EXCEEDS_SALE_GMV'])
    const c3 = full({ sales: [s1], returns: [ret('RT1', s1, '999', '100'), ret('RT2', s1, '999', '100', { at: at(20, 3) })] })
    expect(compareWithOracle(c3, runApp(c3)).hold).toBeNull()
  })
  test('F04 cms_unit: phiếu trên dòng OTHER_UNIT trừ B thật, KHÔNG trừ lượng đủ ĐK của dòng COUNTED khác; pos_base trừ đủ B', () => {
    const counted = sale('41', { q: '2', b: '200', g: '200000' }), other = sale('42', { q: '3', u: 'viên', b: '30', g: '30000' })
    const c = full({ sales: [counted, other], returns: [ret('RT1', other, '1', '10000')] })
    const r = runApp(c)
    compareWithOracle(c, r)
    const g = grp(ok(r) as CmsCalcOutput & { ok: true }, U1)
    expect([g.returnBaseUnits, g.eligibleReturnBaseUnits, g.eligibleNetBaseUnits, g.cmsQuantity]).toEqual([U(30), ZERO, U(200), BigInt(2)])
    const cp = full({ quantityBasis: 'pos_base', products: [prod(P1, { k: '10' })], sales: [sale('43', { q: null, u: null, b: '37', g: '1000' })], returns: [] })
    cp.returns = [ret('RT2', cp.sales[0], '5', '100')]
    const rp = runApp(cp)
    compareWithOracle(cp, rp)
    expect(grp(ok(rp) as CmsCalcOutput & { ok: true }, U1).eligibleNetBaseUnits).toBe(ZERO)
  })
  test('F05 cùng đơn cùng SP hai dòng / hai người bán ⇒ chỉ dòng được tham chiếu bị trừ', () => {
    const a = sale('51', { order: 'o-X', q: '4', b: '400', g: '400' }), b = sale('52', { order: 'o-X', q: '2', b: '200', g: '200', email: 'b@example.test' })
    const c = full({ sales: [a, b], returns: [ret('RT1', a, '1', '100')] })
    const r = runApp(c)
    compareWithOracle(c, r)
    const out = ok(r) as CmsCalcOutput & { ok: true }
    expect([grp(out, U1).eligibleNetBaseUnits, grp(out, U2).eligibleNetBaseUnits, grp(out, U2).returnGmvUnits]).toEqual([ZERO, U(200), ZERO])
  })
  test('F06 dữ liệu xấu: trạng thái lạ ⇒ lỗi nguồn; v2 CANCELED / PENDING / REJECTED / WAITING_APPROVAL / APPROVED ⇒ bỏ qua; ngữ cảnh 5 trường', () => {
    const s1 = sale('61', { q: '2', b: '200', g: '100000' })
    const bad = full({ sales: [s1], returns: [ret('RT1', s1, '1', '1000', { status: 'Completed' })] })
    expect(compareWithOracle(bad, runApp(bad)).hold).toEqual(['SOURCE_ROW_INVALID'])
    const ne = full({ sales: [s1], returns: ['CANCELED', 'PENDING', 'REJECTED', 'WAITING_APPROVAL', 'APPROVED'].map((st, i) => ret(`NE${i}`, s1, '1', '1000', { status: st })) })
    const rn = runApp(ne)
    compareWithOracle(ne, rn)
    expect(grp(ok(rn) as CmsCalcOutput & { ok: true }, U1).returnBaseUnits).toBe(ZERO)
    // Net v1 vẫn coi CANCELED là lạ (từ điển v1 không đổi).
    const v1 = base({ sales: [s1], returns: [ret('RT1', s1, '1', '1000', { status: 'CANCELED' })] })
    expect(compareWithOracle(v1, runApp(v1)).hold).toEqual(['SOURCE_ROW_INVALID'])
    for (const [lbl, patch, want] of [
      ['sai đơn', { order: 'KHAC' }, ['RETURN_CONTEXT_MISMATCH']],
      ['sai SP', { pid: P2 }, ['RETURN_CONTEXT_MISMATCH']],
      ['sai ngày bán gốc', { o: { at: at(6, 1), type: 'OFFLINE', status: 'COMPLETED', email: s1.email, pos: 'POS01', b: s1.b, g: s1.g, q: s1.q, u: s1.u } }, ['RETURN_CONTEXT_MISMATCH']],
      ['người / POS / B / G / q·u gốc khác (không thuộc hợp đồng)', { o: { at: s1.at, type: 'OFFLINE', status: 'COMPLETED', email: 'x@example.test', pos: 'POS99', b: '1', g: '1', q: '9', u: 'viên' } }, null],
      ['trả trước giờ bán', { at: at(5, 0) }, ['RETURN_BEFORE_SALE']],
      ['sau as_of', { at: '2027-01-11T00:00:00.000000Z' }, ['RETURN_AFTER_AS_OF']],
      ['dòng gốc thiếu trong snapshot', { ref: 'khong-co' }, ['RETURN_ORIGIN_MISSING']],
    ] as [string, Partial<OracleReturnRow>, string[] | null][]) {
      const c = full({ products: [prod(P1), prod(P2)], sales: [s1], returns: [{ ...ret('RT1', s1, '1', '1000'), ...patch }] })
      if (lbl === 'dòng gốc thiếu trong snapshot') c.returns[0].o = { at: s1.at, type: 'OFFLINE', status: 'COMPLETED', email: null, pos: null, b: '0', g: '0', q: null, u: null }
      expect(compareWithOracle(c, runApp(c)).hold, lbl).toEqual(want)
    }
    const dup = full({ sales: [s1], returns: [ret('RT1', s1, '1', '1000'), ret('RT1', s1, '1', '1000', { at: at(20, 4) })] })
    expect(compareWithOracle(dup, runApp(dup)).hold).toEqual(['RETURN_DUPLICATE_ID'])
  })
  test('F07 bất biến: lượng BI 1 / 0 / rỗng / rác / 999 ⇒ cùng kết quả (app); refund đổi ⇒ kết quả đổi', () => {
    const s1 = sale('71', { q: '4', b: '400', g: '640000' }), s2 = sale('72', { q: '1', b: '100', g: '100000' })
    const mk = (r: string | null, h = '310000') => full({ sales: [s1, s2], returns: [ret('RT1', s1, r ?? '1', h), ret('RT2', s1, '1', '1000', { at: at(20, 2) })].map((x, i) => (i === 0 ? { ...x, r } : x)) })
    const ref = ok(runApp(mk('1'))) as CmsCalcOutput & { ok: true }
    for (const r of ['0', null, 'abc', '999', '-5', '1.5']) {
      const c = mk(r)
      const x = runApp(c)
      compareWithOracle(c, x)
      const out = ok(x) as CmsCalcOutput & { ok: true }
      expect([out.results, out.history, out.totals], `BI ${r}`).toEqual([ref.results, ref.history, ref.totals])
    }
    const changed = ok(runApp(mk('1', '300000'))) as CmsCalcOutput & { ok: true }
    expect(changed.totals.returnGmvAppliedUnits).not.toBe(ref.totals.returnGmvAppliedUnits)
  })
})

// ── Vi sai ngẫu nhiên app ↔ oracle ──────────────────────────────────────────────────────────────────────────────────────────────────
function lcg(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 } }
test.describe('Q-236 · full_line — vi sai ngẫu nhiên app ↔ oracle @desktop', () => {
  test('300 kịch bản (pos_base / cms_unit; 1–4 phiếu / dòng; trùng µs; trạng thái v2; BI rác; refund có thể vượt) — app = oracle', () => {
    const rnd = lcg(236)
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
    let held = 0, clean = 0
    for (let n = 0; n < 300; n++) {
      const basis = rnd() < 0.5 ? 'pos_base' : 'cms_unit'
      const sales: OracleSaleRow[] = []
      const nSales = 1 + Math.floor(rnd() * 6)
      for (let i = 0; i < nSales; i++) {
        const q = 1 + Math.floor(rnd() * 5)
        const other = basis === 'cms_unit' && rnd() < 0.25
        const g = String(1000 * (1 + Math.floor(rnd() * 200)))
        sales.push(sale(`r${n}-${i}`, {
          order: rnd() < 0.3 ? `o-${n}-shared` : `o-${n}-${i}`, pid: pick([P1, P2]), email: pick(['a@example.test', 'b@example.test', 'a@example.test']),
          q: String(q), u: other ? 'viên' : 'hộp', b: other ? String(q * 7) : String(q * 100), g, at: at(3 + (i % 20), i),
        }))
      }
      const returns: OracleReturnRow[] = []
      let rid = 0
      for (const s of sales) {
        if (rnd() < 0.35) continue
        const k = 1 + Math.floor(rnd() * 4)
        for (let j = 0; j < k; j++) {
          const tie = rnd() < 0.3
          const h = String(Math.floor(Number(s.g) * (rnd() < 0.08 ? 0.9 : 0.3) * rnd()))
          returns.push(ret(`RT${n}-${String.fromCharCode(65 + Math.floor(rnd() * 26))}${rid++}`, s, pick(['1', '0', 'abc', '999', null as unknown as string, s.q ?? '1']), h, {
            at: tie ? at(25, 1) : at(24 + Math.floor(rnd() * 4), Math.floor(rnd() * 59)),
            status: rnd() < 0.85 ? 'COMPLETED' : pick(['CANCELED', 'PENDING', 'REJECTED', 'WAITING_APPROVAL', 'APPROVED']),
          }))
        }
      }
      const c = full({ quantityBasis: basis, products: [prod(P1, basis === 'pos_base' ? { k: '100', unit: null } : {}), prod(P2, { k: '100', basis: 'product', target: '20000' })], sales, returns })
      const o = compareWithOracle(c, runApp(c))
      if (o.hold) held++; else clean++
    }
    // Bộ sinh phải phủ cả hai nhánh (không vacuous).
    expect(clean).toBeGreaterThan(150)
    expect(held).toBeGreaterThan(5)
  })
})

// ── Registry / chuẩn hoá / fp / capability / parser ─────────────────────────────────────────────────────────────────────────────────
test.describe('Q-236 · registry · chuẩn hoá · fp · capability · parser @desktop', () => {
  test('registry: 3 policy; hợp đồng / từ điển theo policy; sales_only không đọc trả', () => {
    expect(parseCmsReturnsPolicy(FULL)).toBe(FULL)
    expect(parseCmsReturnsPolicy('full_line_v9')).toBeNull()
    expect([cmsPolicyReadsReturns('sales_only_v1'), cmsPolicyReadsReturns('net_returns_v1'), cmsPolicyReadsReturns(FULL)]).toEqual([false, true, true])
    expect([cmsCalcContractVersionFor('sales_only_v1'), cmsCalcContractVersionFor('net_returns_v1'), cmsCalcContractVersionFor(FULL)])
      .toEqual(['cms-calc-ret2-v1', 'cms-calc-ret2-v1', 'cms-calc-ret2-v2'])
    expect(cmsReturnStatusDictionaryVersion(FULL)).toBe('cms-return-status-v2')
    expect(cmsReturnStatusDictionaryVersion('net_returns_v1')).toBe('cms-return-status-v1')
    expect([...CMS_RETURN_STATUS_DICTIONARY_V2.entries()].sort()).toEqual([['APPROVED', 'NOT_EFFECTIVE'], ['CANCELED', 'NOT_EFFECTIVE'], ['COMPLETED', 'EFFECTIVE'],
      ['PENDING', 'NOT_EFFECTIVE'], ['REJECTED', 'NOT_EFFECTIVE'], ['WAITING_APPROVAL', 'NOT_EFFECTIVE']])
    expect(cmsReturnNotEffectiveStatuses('net_returns_v1')).toEqual(['APPROVED'])
    expect(cmsReturnNotEffectiveStatuses(FULL)).toEqual(['APPROVED', 'CANCELED', 'PENDING', 'REJECTED', 'WAITING_APPROVAL'])
    expect(CMS_RETURNS_POLICY_LABEL[FULL]).toBe('Trừ đủ lượng dòng bán khi có trả; GMV theo tiền hoàn')
  })
  test('chuẩn hoá full_line: không đọc lượng BI / người / POS / B / G gốc; v1 giữ bắt buộc', () => {
    const s1 = sale('81', { q: '2', b: '200', g: '50000' })
    const raw = { ...rawReturn(ret('RT1', s1, 'abc', '1000'), [s1]), original_seller_email: null, original_base_quantity: null, original_gmv_amount: null }
    const f = normalizeReturnRow(raw, FULL)
    expect(f.ok).toBe(true)
    if (!f.ok || f.value.kind !== 'COMPLETED') throw new Error('x')
    expect([f.value.profile, f.value.baseQuantityUnits, f.value.original.baseQuantityUnits, f.value.original.gmvUnits, f.value.original.sellerEmail])
      .toEqual([FULL, null, null, null, null])
    expect(normalizeReturnRow(raw, 'net_returns_v1').ok).toBe(false)
    expect(normalizeReturnRow({ ...raw, return_gmv_amount: null }, FULL).ok).toBe(false)
  })
  test('fp v2: không chứa lượng (đổi lượng không đổi fp); đổi refund / thời điểm ⇒ đổi; khác hẳn fp v1', () => {
    const x = { programId: 'p', returnEventId: 'RT1', returnDocumentId: 'D1', originalOrderLineId: 'L1', originalOrderId: 'O1', productId: '1', refundUnits: U(10), recordedAtMicros: BigInt(5) }
    const a = cmsReturnFinancialFpV2(x)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(cmsReturnFinancialFpV2({ ...x })).toBe(a)
    expect(cmsReturnFinancialFpV2({ ...x, refundUnits: U(11) })).not.toBe(a)
    expect(cmsReturnFinancialFpV2({ ...x, recordedAtMicros: BigInt(6) })).not.toBe(a)
    expect(cmsReturnFinancialFp({ ...x, baseUnits: U(1) })).not.toBe(a)
  })
  test('capability: DB 130 / 131 (không đường full_line) ⇒ chỉ full_line tắt MISSING; DB 132 ⇒ bật; khoá v2 lệch ⇒ VERSION', () => {
    const paths131 = Object.fromEntries(['program_modes', 'contract_run', 'readers_v2', 'returns_ledger', 'close_report']
      .map((p) => [p, { ok: true, rpcs: [...CMS_CAPABILITY_RPCS[p as keyof typeof CMS_CAPABILITY_RPCS]] }]))
    const c131 = parseCmsCapabilities({ ...CMS_CAPABILITY_VERSIONS, paths: paths131 })
    expect([c131.paths.contract_run, c131.paths.close_report, c131.paths.full_line, c131.off.full_line]).toEqual([true, true, false, 'MISSING'])
    const raw132 = { ...CMS_CAPABILITY_VERSIONS, ...CMS_CAPABILITY_VERSIONS_V2, paths: { ...paths131, full_line: { ok: true, rpcs: [...CMS_CAPABILITY_RPCS.full_line] } } }
    expect(parseCmsCapabilities(raw132).paths.full_line).toBe(true)
    const bad = parseCmsCapabilities({ ...raw132, fp_v2: 'cms-return-fp-v9' })
    expect([bad.paths.full_line, bad.off.full_line, bad.paths.close_report]).toEqual([false, 'VERSION', true])
  })
  test('parser hợp đồng run: full_line ⇔ (v2, status-v2, có as_of); lệch cặp ⇒ DTO_INVALID; net / sales-only giữ v1', () => {
    const c = { legacy: false, calc_contract_version: 'cms-calc-ret2-v2', quantity_basis: 'pos_base', quantity_policy_version: 'pos_base_v1', returns_policy: FULL,
      unit_key_version: 'cms-unit-key-v2', status_dictionary_version: 'cms-return-status-v2', returns_as_of: '2026-12-31T00:00:00.000000Z' }
    expect(parseCmsRunContract(c).returnsPolicy).toBe(FULL)
    expect(() => parseCmsRunContract({ ...c, calc_contract_version: 'cms-calc-ret2-v1' })).toThrow()
    expect(() => parseCmsRunContract({ ...c, status_dictionary_version: 'cms-return-status-v1' })).toThrow()
    expect(() => parseCmsRunContract({ ...c, returns_as_of: null })).toThrow()
    expect(() => parseCmsRunContract({ ...c, returns_policy: 'net_returns_v1' })).toThrow()
    expect(parseCmsRunContract({ ...c, returns_policy: 'net_returns_v1', calc_contract_version: 'cms-calc-ret2-v1', status_dictionary_version: 'cms-return-status-v1' }).returnsPolicy).toBe('net_returns_v1')
  })
  test('reader trả: baseline fp v2 (base_quantity null) đọc được; báo cáo thiếu returns_profile (DB 131) ⇒ net_returns_v1; giá trị lạ ⇒ lỗi', () => {
    const h = 'a'.repeat(64), ts = '2026-12-31T00:00:00.000000Z', id = '00000000-0000-4000-8000-000000000001'
    const cf = parseCmsReturnConflicts({ program_id: id, returns_policy: FULL, config_version: 3, baselines: 1, open_set_hash: h, open_count: 1, open_truncated: false,
      latest_eval: null, proof: null, restorations: [],
      open: [{ conflict_id: 1, return_event_id: 'RT1', opened_kind: 'CHANGED', opened_eval_seq: 2, opened_at: ts, observations: [],
        baseline: { return_document_id: 'D', original_order_line_id: 'L', product_id: '1', base_quantity: null, refund_amount: '10.000000000', recorded_at: ts } }] })
    expect(cf.open[0].baseline.baseQuantity).toBeNull()
    const rep = { id, payout_run_id: id, eval_seq: 1, returns_as_of: ts, frozen_amount: '2600', recomputed_amount: '1400', delta_amount: '-1200', return_events: 2,
      line_count: 0, created_via: 'super', created_at: ts }
    expect(parseCmsCloseReports({ program_id: id, reports: [rep] }).reports[0].returnsProfile).toBe('net_returns_v1')
    expect(parseCmsCloseReports({ program_id: id, reports: [{ ...rep, returns_profile: FULL }] }).reports[0].returnsProfile).toBe(FULL)
    expect(() => parseCmsCloseReports({ program_id: id, reports: [{ ...rep, returns_profile: 'x' }] })).toThrow()
    const page = parseCmsCloseReportPage({ report: { ...rep, program_id: id, returns_digest: h, not_a_payment_order: true, returns_profile: FULL }, lines: [], next_after: null })
    expect([page.report.returnsProfile, cmsCloseReportReturnBaseLabel(page.report.returnsProfile)]).toEqual([FULL, 'Lượng trừ theo quy ước CMS'])
  })
  test('nhãn: câu phạm vi + "trừ do trả hàng" theo policy; net giữ "đã trả"', () => {
    const c = { legacy: false, calcContractVersion: 'cms-calc-ret2-v2', quantityBasis: 'pos_base', quantityPolicyVersion: 'pos_base_v1', returnsPolicy: FULL,
      unitKeyVersion: 'cms-unit-key-v2', statusDictionaryVersion: 'cms-return-status-v2', returnsAsOf: '2026-12-31T00:00:00.000000Z' } as Parameters<typeof cmsResultScopeNote>[0]
    expect(cmsResultScopeNote(c)).toContain('trừ đủ lượng của dòng')
    const s = { saleBase: U(5), returnBase: U(2), saleGmv: U(10), returnGmv: U(1), returnCount: 1 }
    expect(cmsNetQtyText(s, '1', 'hộp', FULL)).toBe('Đã bán 5 · trừ do trả hàng 2 · còn 3 hộp')
    expect(cmsNetQtyText(s, '1', 'hộp', 'net_returns_v1')).toBe('Đã bán 5 · đã trả 2 · còn 3 hộp')
    // Lịch sử: phiếu sau của cùng dòng (lượng 0) giải thích rõ; phiếu mang lượng ghi "trừ đủ lượng dòng bán"; net giữ câu cũ.
    const zero = { kind: 'RETURN' as const, status: 'RETURN_NO_CHANGE' as const, amountVnd: '0', baseQuantity: '0', qtyBefore: '1', qtyAfter: '1', returnCode: 'RT2' }
    expect(cmsLineView(zero, '1', 'hộp', true, FULL).note).toBe('Phiếu trả RT2: lượng của dòng bán đã trừ ở phiếu trước · GMV trừ theo tiền hoàn')
    expect(cmsLineView(zero, '1', 'hộp', true, 'net_returns_v1').note).toBe('Phiếu trả RT2: lượng tính CMS không đổi')
    const red = { kind: 'RETURN' as const, status: 'RETURN_REDUCED' as const, amountVnd: '-100', baseQuantity: '-4', qtyBefore: '5', qtyAfter: '1', returnCode: 'RT1' }
    expect(cmsLineView(red, '1', 'hộp', true, FULL).note).toContain('Phiếu trả RT1: trừ đủ lượng dòng bán · ')
    expect(cmsLineView(red, '1', 'hộp', true, 'net_returns_v1').note).not.toContain('trừ đủ lượng')
  })
})

// ── Báo cáo sau chốt (payload + job) ────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('Q-236 · báo cáo sau chốt profile full_line @desktop', () => {
  const PROG = { startDate: '2026-11-01', endDate: '2026-11-30', productIds: ['900001'] }
  const retRow = (o: Record<string, string | null> = {}) => ({
    src_kind: 'R', return_event_id: 'RT1', return_document_id: 'RD1', return_code: 'RT-1', return_status: 'COMPLETED',
    return_recorded_at: '2026-12-01T02:00:00.000000Z', original_order_line_id: '9001', original_order_id: 'O1', product_id: '900001',
    return_base_quantity: '1.5', return_gmv_amount: '100000', original_completed_at: '2026-11-03T02:00:00.000000Z', original_order_type: 'OFFLINE',
    original_order_status: 'COMPLETED', original_seller_email: null, original_pos_code: null, original_base_quantity: null,
    original_gmv_amount: null, original_quantity_raw: null, original_uom_raw: null, source_updated_at: null, ...o,
  })
  test('payload: profile full_line gửi khoá profile; v1 không gửi; trộn bản ghi khác profile ⇒ ném', () => {
    const rec = (p: 'net_returns_v1' | typeof FULL, o = {}) => { const n = normalizeReturnRow(retRow({ return_base_quantity: '1', original_base_quantity: '2', original_gmv_amount: '200000', ...o }), p); if (!n.ok) throw new Error('x'); return n.value }
    const meta = { provider: 'fixture' as const, snapshotId: 's', asOfMicros: BigInt(1) }
    expect(buildCmsCloseReportPayload(PROG, [rec(FULL)], { ...meta, profile: FULL }).profile).toBe(FULL)
    expect('profile' in buildCmsCloseReportPayload(PROG, [rec('net_returns_v1')], meta)).toBe(false)
    expect(() => buildCmsCloseReportPayload(PROG, [rec('net_returns_v1')], { ...meta, profile: FULL })).toThrow()
  })
  const PAY = (o: Partial<CmsAfterClosePayoutRun> = {}) =>
    ({ ok: true as const, runId: '00000000-0000-4000-8000-000000000031', legacy: false, runPolicy: FULL as CmsReturnsPolicy, reportProfile: null, ...o })
  test('profile báo cáo theo LỰA CHỌN ĐÃ GHIM (PM r0 §3.1): run contract trả ⇒ policy run; legacy ⇒ profile báo cáo đã lưu; chưa chọn ⇒ UNSELECTED', () => {
    expect(cmsAfterCloseProfile(PAY())).toEqual({ profile: FULL })
    expect(cmsAfterCloseProfile(PAY({ runPolicy: 'net_returns_v1' }))).toEqual({ profile: 'net_returns_v1' })
    expect(cmsAfterCloseProfile(PAY(), 'net_returns_v1')).toEqual({ code: 'CMS_REPORT_PROFILE_MISMATCH' })
    expect(cmsAfterCloseProfile(PAY({ legacy: true, runPolicy: 'sales_only_v1' }))).toEqual({ code: 'REPORT_POLICY_UNSELECTED' })
    expect(cmsAfterCloseProfile(PAY({ runPolicy: 'sales_only_v1' }))).toEqual({ code: 'REPORT_POLICY_UNSELECTED' })
    expect(cmsAfterCloseProfile(PAY({ legacy: true, runPolicy: 'sales_only_v1', reportProfile: 'net_returns_v1' }))).toEqual({ profile: 'net_returns_v1' })
    expect(cmsAfterCloseProfile(PAY({ legacy: true, runPolicy: 'sales_only_v1', reportProfile: 'net_returns_v1' }), FULL)).toEqual({ code: 'CMS_REPORT_PROFILE_LEDGER_MISMATCH' })
    // Chỉ đường super (lựa chọn tay) mới chọn được khi chưa có — job cron không bao giờ tự gán.
    expect(cmsAfterCloseProfile(PAY({ legacy: true, runPolicy: 'sales_only_v1' }), FULL)).toEqual({ profile: FULL })
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cms', 'server', 'returnsAfterCloseDeps.ts'), 'utf8')
    expect(src).not.toContain("profile: 'full_line_qty_refund_v1',")
    expect(src).toContain("(profile !== 'full_line_qty_refund_v1' || s.caps.paths.full_line)")
  })
  function jobDeps(o: Partial<CmsAfterCloseDeps> = {}, log: { reads: unknown[]; saves: unknown[]; manual: unknown[] } = { reads: [], saves: [], manual: [] }, returns = [retRow()]): CmsAfterCloseDeps {
    const provider = createCmsContractFixtureProvider({ returns, snapshotId: 'qa-snap-1' })
    return {
      capsOk: async () => true,
      listPrograms: async () => [{ id: '00000000-0000-4000-8000-000000000041', ...PROG, isTest: true }],
      payoutRun: async () => PAY(),
      provider: { kind: provider.kind, read: async (s) => { log.reads.push(s); return provider.read(s) } },
      save: async (_p, _r, payload, manual) => { log.saves.push(payload); log.manual.push(manual ?? null); return { ok: true, data: { saved: true, already: false, report_id: '00000000-0000-4000-8000-000000000090' } } },
      nowMicros: () => BigInt(Date.parse('2026-12-03T03:00:00Z')) * BigInt(1000), remainingMs: () => 200_000,
      ...o,
    }
  }
  test('job: run chốt full_line ⇒ nguồn nhận returnsProfile, phiếu lượng lẻ không chặn, payload mang profile, không actor; legacy chưa chọn ⇒ skipped TRƯỚC khi đọc nguồn', async () => {
    const log = { reads: [] as unknown[], saves: [] as unknown[], manual: [] as unknown[] }
    const s = await runCmsReturnsAfterClose(jobDeps({}, log), { maxPrograms: 5 })
    expect(s.results.map((r) => r.status)).toEqual(['saved'])
    expect((log.reads[0] as { returnsProfile?: string }).returnsProfile).toBe(FULL)
    expect((log.saves[0] as { profile?: string }).profile).toBe(FULL)
    expect('actor' in (log.saves[0] as object)).toBe(false)
    expect(log.manual).toEqual([null])
    const l2 = { reads: [] as unknown[], saves: [] as unknown[], manual: [] as unknown[] }
    const s2 = await runCmsReturnsAfterClose(jobDeps({ payoutRun: async () => PAY({ legacy: true, runPolicy: 'sales_only_v1' }) }, l2), { maxPrograms: 5 })
    expect(s2.results.map((r) => [r.status, r.code])).toEqual([['skipped', 'REPORT_POLICY_UNSELECTED']])
    expect(l2.reads.length + l2.saves.length).toBe(0)
    // Đã có báo cáo net (lựa chọn đã ghim) ⇒ chạy đúng net, không v2.
    const l3 = { reads: [] as unknown[], saves: [] as unknown[], manual: [] as unknown[] }
    const s3 = await runCmsReturnsAfterClose(jobDeps({ payoutRun: async () => PAY({ legacy: true, runPolicy: 'sales_only_v1', reportProfile: 'net_returns_v1' }) }, l3,
      [retRow({ return_base_quantity: '1', original_base_quantity: '2', original_gmv_amount: '200000', original_seller_email: 'a@x.vn', original_pos_code: 'P1', original_quantity_raw: '2', original_uom_raw: 'Hộp' })]),
    { maxPrograms: 5 })
    expect(s3.results.map((r) => r.status)).toEqual(['saved'])
    expect((l3.reads[0] as { returnsProfile?: string }).returnsProfile).toBe('net_returns_v1')
    expect('profile' in (l3.saves[0] as object)).toBe(false)
    // full_line cần đường full_line của DB — thiếu ⇒ held, không đọc nguồn.
    const l4 = { reads: [] as unknown[], saves: [] as unknown[], manual: [] as unknown[] }
    const s4 = await runCmsReturnsAfterClose(jobDeps({ capsOk: async (p) => p !== FULL }, l4), { maxPrograms: 5 })
    expect(s4.results.map((r) => [r.status, r.code])).toEqual([['held', 'CAPS_UNAVAILABLE']])
    expect(l4.reads.length).toBe(0)
  })
  test('trần full_line / run contract 10.000 phiếu / báo cáo (r1 P1-2, Q-238; = DB): 10.000 lưu, 10.001 ⇒ held CMS_REPORT_TOO_LARGE trước khi lưu; v1 legacy giữ 100.000', async () => {
    expect([CMS_CLOSE_REPORT_MAX_RETURNS_FULL_LINE, CMS_CLOSE_REPORT_MAX_RETURNS, cmsCloseReportMaxReturns(FULL), cmsCloseReportMaxReturns('net_returns_v1')])
      .toEqual([10_000, 100_000, 10_000, 100_000])
    const CAP = CMS_CLOSE_REPORT_MAX_RETURNS_FULL_LINE
    const ne = (n: number) => Array.from({ length: n }, (_, i) => retRow({ return_event_id: `NE${String(i).padStart(6, '0')}`, return_status: 'CANCELED' }))
    const l1 = { reads: [] as unknown[], saves: [] as unknown[], manual: [] as unknown[] }
    expect((await runCmsReturnsAfterClose(jobDeps({}, l1, ne(CAP)), { maxPrograms: 1 })).results.map((r) => r.status)).toEqual(['saved'])
    expect((l1.saves[0] as { returns: unknown[] }).returns.length).toBe(CAP)
    const l2 = { reads: [] as unknown[], saves: [] as unknown[], manual: [] as unknown[] }
    const r2 = await runCmsReturnsAfterClose(jobDeps({}, l2, ne(CAP + 1)), { maxPrograms: 1 })
    expect(r2.results.map((r) => [r.status, r.code, r.returnsRead])).toEqual([['held', 'CMS_REPORT_TOO_LARGE', CAP + 1]])
    expect(l2.saves.length).toBe(0)
    // db-reviewer r1 P2 (= DB): run chốt CONTRACT ⇒ cùng trần cả khi profile net_returns_v1; run legacy net giữ 100.000.
    const l5 = { reads: [] as unknown[], saves: [] as unknown[], manual: [] as unknown[] }
    const r5 = await runCmsReturnsAfterClose(jobDeps({ payoutRun: async () => PAY({ runPolicy: 'net_returns_v1' }) }, l5, ne(CAP + 1)), { maxPrograms: 1 })
    expect(r5.results.map((r) => [r.status, r.code, r.returnsRead])).toEqual([['held', 'CMS_REPORT_TOO_LARGE', CAP + 1]])
    expect(l5.saves.length).toBe(0)
    const l6 = { reads: [] as unknown[], saves: [] as unknown[], manual: [] as unknown[] }
    // Phiếu chưa hiệu lực theo từ điển v1 (APPROVED — v1 không biết CANCELED): chỉ ID + trạng thái.
    const ap = (n: number) => Array.from({ length: n }, (_, i) => retRow({ return_event_id: `AP${String(i).padStart(6, '0')}`, return_status: 'APPROVED',
      return_document_id: null, return_code: null, return_recorded_at: null, original_order_line_id: null, original_order_id: null, product_id: null,
      return_base_quantity: null, return_gmv_amount: null, original_completed_at: null, original_order_type: null, original_order_status: null }))
    // Provider trả thẳng phiếu (fixture lọc phạm vi theo mốc ghi nhận — phiếu chưa hiệu lực v1 không có mốc ⇒ bị lọc).
    const rawProvider: CmsAfterCloseDeps['provider'] = { kind: 'fixture', read: async (s) => ({ ok: true, provider: 'fixture', snapshotId: 'qa-snap-v1',
      asOfMicros: s.asOfMicros, salesRaw: [], returnsRaw: ap(CAP + 1), bytesProcessed: null }) }
    const r6 = await runCmsReturnsAfterClose(jobDeps({ payoutRun: async () => PAY({ legacy: true, runPolicy: 'sales_only_v1', reportProfile: 'net_returns_v1' }),
      provider: rawProvider }, l6), { maxPrograms: 1 })
    expect(r6.results.map((r) => [r.status, r.code])).toEqual([['saved', null]])
    expect((l6.saves[0] as { returns: unknown[] }).returns.length).toBe(CAP + 1)
    // Hàm thuần cũng chặn (không cắt N đầu).
    const recs = ne(CAP + 1).map((x) => { const n = normalizeReturnRow(x, FULL); if (!n.ok) throw new Error('x'); return n.value })
    expect(() => buildCmsCloseReportPayload(PROG, recs, { provider: 'fixture', snapshotId: 's', asOfMicros: BigInt(1), profile: FULL })).toThrow(CmsCloseReportTooLargeError)
    expect(buildCmsCloseReportPayload(PROG, recs.slice(0, CAP), { provider: 'fixture', snapshotId: 's', asOfMicros: BigInt(1), profile: FULL }).returns.length).toBe(CAP)
    // DB trả TOO_LARGE ⇒ held (không lỗi máy chủ).
    const r3 = await runCmsReturnsAfterClose(jobDeps({ save: async () => ({ ok: false, code: 'CMS_REPORT_TOO_LARGE' }) }), { maxPrograms: 1 })
    expect(r3.results.map((r) => [r.status, r.code])).toEqual([['held', 'CMS_REPORT_TOO_LARGE']])
  })
})

// ── Q-233: cửa sổ 30 ngày (ngày VN) · checklist ngày cuối · đường thủ công ngày 31 qua PHIÊN SUPER (PM r0 P1-04) ─────────────────────
test.describe('Q-233 · job sau chốt 30 ngày + đường thủ công ngày 31 @desktop', () => {
  // Chương trình kết thúc D = 2026-11-30. Bộ chọn deps thật: since ≤ end_date < today (SQL .gte / .lt — cùng phép so chuỗi ngày).
  const D = '2026-11-30'
  const picked = (nowIso: string) => { const w = cmsAfterCloseWindow(Date.parse(nowIso), CMS_AFTER_CLOSE_WINDOW_DAYS); return { in: D >= w.since && D < w.today, last: D === w.lastDay } }
  test('mặc định 30; D (chưa qua kỳ) / D+1 / D+29 / D+30 (ngày cuối) chọn đúng; D+31 không tự chọn; biên 17:00 UTC = 00:00 VN', () => {
    expect(CMS_AFTER_CLOSE_WINDOW_DAYS).toBe(30)
    expect(picked('2026-11-30T05:00:00Z')).toEqual({ in: false, last: false })
    expect(picked('2026-12-01T05:00:00Z')).toEqual({ in: true, last: false })
    expect(picked('2026-12-29T05:00:00Z')).toEqual({ in: true, last: false })
    expect(picked('2026-12-30T05:00:00Z')).toEqual({ in: true, last: true })
    expect(picked('2026-12-31T05:00:00Z')).toEqual({ in: false, last: false })
    // 30/12 16:59:59Z = 30/12 23:59:59 VN (D+30) · 30/12 17:00:00Z = 31/12 00:00 VN (D+31).
    expect(picked('2026-12-30T16:59:59Z')).toEqual({ in: true, last: true })
    expect(picked('2026-12-30T17:00:00Z')).toEqual({ in: false, last: false })
    // 30/11 17:00Z = 01/12 00:00 VN (D+1) ⇒ đã qua kỳ.
    expect(picked('2026-11-30T16:59:59Z').in).toBe(false)
    expect(picked('2026-11-30T17:00:00Z').in).toBe(true)
    expect(() => cmsAfterCloseWindow(Date.now(), 0)).toThrow()
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cms', 'server', 'returnsAfterCloseDeps.ts'), 'utf8')
    // Đồng hồ ghim MỘT lần khi dựng deps; bộ lọc ngày dùng since / today của mốc đó; env trống ⇒ 30.
    expect(src).toContain('const win = cmsAfterCloseWindow(started, maxAge)')
    expect(src).toContain(".gte('end_date', win.since).lt('end_date', win.today)")
    expect(src).toContain("if (v === undefined || v === '') return CMS_AFTER_CLOSE_WINDOW_DAYS")
    expect(src).not.toContain('Date.now() + 7 * 3600_000')
    expect(fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8')).toContain('Q-233 mặc định 30')
  })

  const PID = '00000000-0000-4000-8000-000000000041', RUN = '00000000-0000-4000-8000-000000000031', IDEM = '00000000-0000-4000-8000-0000000000e1'
  const PROG = { startDate: '2026-11-01', endDate: '2026-11-30', productIds: ['900001'] }
  const retRow = () => ({
    src_kind: 'R', return_event_id: 'RT1', return_document_id: 'RD1', return_code: 'RT-1', return_status: 'COMPLETED',
    return_recorded_at: '2026-12-31T02:00:00.000000Z', original_order_line_id: '9001', original_order_id: 'O1', product_id: '900001',
    return_base_quantity: '1', return_gmv_amount: '100000', original_completed_at: '2026-11-03T02:00:00.000000Z', original_order_type: 'OFFLINE',
    original_order_status: 'COMPLETED', original_seller_email: null, original_pos_code: null, original_base_quantity: null,
    original_gmv_amount: null, original_quantity_raw: null, original_uom_raw: null, source_updated_at: null,
  })
  const PAY = (o: Partial<CmsAfterClosePayoutRun> = {}) =>
    ({ ok: true as const, runId: RUN, legacy: false, runPolicy: FULL as CmsReturnsPolicy, reportProfile: null, ...o })
  function job(o: Partial<CmsAfterCloseDeps> = {}, calls: string[] = [], saves: unknown[] = [], manual: unknown[] = []): CmsAfterCloseDeps {
    const provider = createCmsContractFixtureProvider({ returns: [retRow()], snapshotId: 'qa-snap-31' })
    return {
      capsOk: async () => { calls.push('caps'); return true },
      listPrograms: async () => { calls.push('list'); return [] },
      payoutRun: async () => { calls.push('payout'); return PAY() },
      provider: { kind: provider.kind, read: async (s) => { calls.push('read'); return provider.read(s) } },
      save: async (_p, _r, payload, m) => { calls.push('save'); saves.push(payload); manual.push(m ?? null); return { ok: true, data: { saved: true, already: false, report_id: '00000000-0000-4000-8000-000000000090' } } },
      nowMicros: () => BigInt(Date.parse('2027-01-01T03:00:00Z')) * BigInt(1000), remainingMs: () => 200_000,
      ...o,
    }
  }
  function mdeps(o: Partial<CmsManualReportDeps> = {}, j: CmsAfterCloseDeps = job(), calls: string[] = []): CmsManualReportDeps {
    return {
      enabled: () => true, qaReadonly: () => false,
      access: async () => { calls.push('access'); return { kind: 'ok', actorId: '00000000-0000-4000-8000-000000000007', qa: true } },
      manualProgram: async (id) => { calls.push(`prog:${id}`); return { ok: true, program: { id, ...PROG, isTest: true } } },
      job: () => j,
      ...o,
    }
  }
  const input = (o: Record<string, unknown> = {}) => ({ programId: PID, payoutRunId: RUN, reason: 'Phiếu hoàn tất sau ngày 30 — đối soát ngày 31', idem: IDEM, ...o })
  test('thủ công (phiên super): cờ ⇒ QA chỉ đọc ⇒ phiên ⇒ đầu vào ⇒ chương trình; không super / hết phiên ⇒ dừng trước mọi đọc', async () => {
    const calls: string[] = []
    expect(await runCmsManualCloseReport(mdeps({ enabled: () => false }, job(), calls), input())).toEqual({ ok: false, code: 'RETURNS_DISABLED' })
    expect(await runCmsManualCloseReport(mdeps({ qaReadonly: () => true }, job(), calls), input())).toEqual({ ok: false, code: 'QA_SERVER_READONLY' })
    expect(calls).toEqual([])
    for (const [kind, code] of [['anonymous', 'UNAUTHENTICATED'], ['forbidden', 'FORBIDDEN'], ['unavailable', 'UNAVAILABLE']] as const) {
      const c: string[] = []
      expect(await runCmsManualCloseReport(mdeps({ access: async () => { c.push('access'); return { kind } } }, job({}, c), c), input())).toEqual({ ok: false, code })
      expect(c).toEqual(['access'])
    }
    // Body giả mạo actor không có tác dụng: không có trường actor trong đầu vào / payload.
    for (const b of [null, [], input({ programId: 'x' }), input({ payoutRunId: undefined }), input({ idem: 'ABC' }), input({ reason: '   ngắn   ' }),
      input({ reason: 'x'.repeat(501) }), input({ reason: 'lý do có\u0007 điều khiển' }), input({ profile: 'x_v9' })]) {
      const c: string[] = []
      expect(await runCmsManualCloseReport(mdeps({}, job({}, c), c), b)).toEqual({ ok: false, code: 'BAD_INPUT' })
      expect(c).toEqual(['access'])
    }
    expect(parseCmsManualReportInput(input({ reason: '  đủ mười ký tự  ', actor_id: '00000000-0000-4000-8000-000000000099' }))).toEqual(
      { programId: PID, payoutRunId: RUN, profile: null, reason: 'đủ mười ký tự', idem: IDEM })
    // Chương trình QA mà phiên không có marker ⇒ NOT_FOUND (không lộ tồn tại).
    const noQa = mdeps({ access: async () => ({ kind: 'ok', actorId: 'x', qa: false }) })
    expect(await runCmsManualCloseReport(noQa, input())).toEqual({ ok: false, code: 'CMS_PROGRAM_NOT_FOUND' })
    expect(await runCmsManualCloseReport(mdeps({ manualProgram: async () => ({ ok: false, code: 'CMS_REPORT_NOT_LOCKED' }) }), input()))
      .toEqual({ ok: false, code: 'CMS_REPORT_NOT_LOCKED' })
  })
  test('thủ công: ghim run chốt lệch / profile lệch run ⇒ dừng TRƯỚC khi đọc nguồn; legacy chưa chọn ⇒ super chọn được; lưu bằng phiên kèm lý do + khoá yêu cầu', async () => {
    const c1: string[] = []
    const r1 = await runCmsManualCloseReport(mdeps({}, job({ payoutRun: async () => { c1.push('payout'); return PAY({ runId: '00000000-0000-4000-8000-000000000099' }) } }, c1), c1), input())
    expect(r1).toEqual({ ok: false, code: 'CMS_MANUAL_RUN_MISMATCH' })
    expect(c1).not.toContain('read')
    const c2: string[] = []
    expect(await runCmsManualCloseReport(mdeps({}, job({}, c2), c2), input({ profile: 'net_returns_v1' }))).toEqual({ ok: false, code: 'CMS_REPORT_PROFILE_MISMATCH' })
    expect(c2).not.toContain('read')
    // Legacy chưa có lựa chọn: không chọn ⇒ UNSELECTED; super chọn full_line ⇒ chạy full_line.
    const legacy = () => PAY({ legacy: true, runPolicy: 'sales_only_v1' })
    expect(await runCmsManualCloseReport(mdeps({}, job({ payoutRun: async () => legacy() })), input())).toEqual({ ok: false, code: 'REPORT_POLICY_UNSELECTED' })
    const calls: string[] = [], saves: unknown[] = [], manual: unknown[] = []
    const ok = await runCmsManualCloseReport(mdeps({}, job({ payoutRun: async () => { calls.push('payout'); return legacy() } }, calls, saves, manual), calls), input({ profile: FULL }))
    expect(ok).toEqual({ ok: true, status: 'saved', reportId: '00000000-0000-4000-8000-000000000090', returnsRead: 1 })
    expect(calls).toEqual(['access', `prog:${PID}`, 'payout', 'caps', 'read', 'save'])
    const p = saves[0] as { actor?: string; profile?: string; returns: unknown[]; pin: { scope: { from: string; to: string } } }
    expect(['actor' in p, p.profile, p.returns.length, p.pin.scope.from, p.pin.scope.to]).toEqual([false, FULL, 1, '2026-11-01', '2026-11-30'])
    expect(manual).toEqual([{ reason: 'Phiếu hoàn tất sau ngày 30 — đối soát ngày 31', request: IDEM }])
    // Sổ trả lệch / lỗi DB ⇒ mã (UI hiện câu), không ghi.
    expect(await runCmsManualCloseReport(mdeps({}, job({ save: async () => ({ ok: false, code: 'CMS_RETURN_LEDGER_CONFLICT' }) })), input()))
      .toEqual({ ok: false, code: 'CMS_RETURN_LEDGER_CONFLICT' })
    for (const k of ['RETURNS_DISABLED', 'FORBIDDEN', 'BAD_INPUT', 'CMS_MANUAL_RUN_MISMATCH', 'REPORT_POLICY_UNSELECTED', 'CMS_REPORT_PROFILE_MISMATCH',
      'CMS_REPORT_TOO_LARGE', 'CMS_RETURN_LEDGER_CONFLICT']) expect(CMS_MANUAL_REPORT_CODE_LABEL[k], k).toBeTruthy()
  })
  test('checklist ngày cuối: chương trình D+30 chưa saved / already (held, pending) ⇒ lastDayOpen; route không còn POST Bearer; action / deps dùng phiên', async () => {
    const mk = (id: string, lastDay: boolean) => ({ id, ...PROG, isTest: true, lastDay })
    const A = '00000000-0000-4000-8000-0000000000a1', B = '00000000-0000-4000-8000-0000000000b1', C = '00000000-0000-4000-8000-0000000000c1'
    const deps = job({
      listPrograms: async () => [mk(A, true), mk(B, true), mk(C, false)],
      save: async (id) => (id === B ? { ok: false, code: 'CMS_REPORT_AS_OF_STALE' } : { ok: true, data: { saved: true, already: false, report_id: '00000000-0000-4000-8000-000000000090' } }),
    })
    const s = await runCmsReturnsAfterClose(deps, { maxPrograms: 5 })
    expect(s.results.map((r) => [r.programId, r.status, r.lastDay ?? false])).toEqual([[A, 'saved', true], [B, 'held', true], [C, 'saved', false]])
    expect(s.lastDayOpen).toEqual([B])
    const p = await runCmsReturnsAfterClose(deps, { maxPrograms: 1 })
    expect(p.pending.length).toBe(2)
    expect(p.lastDayOpen?.length).toBeGreaterThanOrEqual(1)
    const route = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'cron', 'cms-returns-after-close', 'route.ts'), 'utf8')
    expect(route).not.toContain('export async function POST')
    expect(route).toContain('last_day_open=')
    const d = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cms', 'server', 'returnsAfterCloseDeps.ts'), 'utf8')
    expect(d).toContain("(await createClient()).rpc('rpc_cms_return_close_report_save_super'")
    expect(d).toContain('access: getCmsAdminAccess')
    expect(d).not.toMatch(/isSuperActor|actor_id/)
    const act = fs.readFileSync(path.join(__dirname, '..', 'app', 'actions', 'cmsReturns.ts'), 'utf8')
    expect(act).toContain('runCmsManualCloseReport(cmsManualCloseReportDeps(), input)')
    // Log action chỉ mã + id — không lý do.
    expect(act).not.toMatch(/console\.(warn|error)\([^)]*reason/)
  })
})
