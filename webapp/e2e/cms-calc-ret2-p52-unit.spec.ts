import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  CMS_LEGACY_RUN_CONTRACT, CmsResultDtoError, cmsFractionUnits, parseCmsResultEvents, parseCmsResultHeader, parseCmsResultRows,
  parseCmsRunContract,
} from '../lib/cms/resultView'
import {
  CMS_LINE_LABEL, CMS_SALES_ONLY_NOTE, cmsFractionText, cmsLineOrderText, cmsLineView, cmsNetQtyText, cmsNetSummary, cmsPinnedResults, cmsTruncVnd, cmsResultScopeNote, cmsRunBasisText,
  type CmsPinDeps,
} from '../lib/cms/resultUi'
import { cmsQtyExcludedBase, cmsQtyExplain, cmsQtyExplainRow, cmsQtyReasons } from '../lib/cms/productPresentation'
import { CMS_CALC_CONTRACT_VERSION, CMS_QUANTITY_POLICY_VERSION } from '../lib/cms/calc/policy'
import { CMS_RETURN_STATUS_DICTIONARY_VERSION } from '../lib/cms/calc/returns'
import { CMS_UNIT_KEY_VERSION } from '../lib/cms/unitKey'

// CMS-CALC-RET-2 P5.2 — reader v2 + màn kết quả (PM work order 14/11 §P5 bước 2; dev design r2 §8.2 / §8.3). Không DB:
//  · khối `contract` GHIM từ run: legacy ⇔ pos_base + sales_only_v1; version lạ / thiếu as_of ở run net ⇒ throw (không hiện số với nhãn sai);
//  · rows v2: cột ròng chỉ ở run contract; `eligibleBase` (B đủ) là căn cứ Q; giải thích lượng tách "không tính lượng" = B thật − B đủ;
//  · events v2: SALE + RETURN, trạng thái khớp loại; nhãn RETURN là CMS tính lại (không phải tiền hoàn khách);
//  · câu phạm vi: legacy / sales_only giữ NGUYÊN chữ T11; net ⇒ "đã trừ phiếu trả hoàn tất" + as_of;
//  · reader chọn theo năng lực DB (readers_v2), không theo cờ.

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const RUN = uid(31), PROG = uid(41), A = uid(1), S1 = uid(11), PP1 = uid(21)
const ASOF = '2026-11-14T03:00:00.000000Z'

const C_LEGACY = { legacy: true, calc_contract_version: null, quantity_basis: 'pos_base', returns_policy: 'sales_only_v1' }
const contract = (o: Record<string, unknown> = {}) => ({
  legacy: false, calc_contract_version: CMS_CALC_CONTRACT_VERSION, quantity_basis: 'cms_unit',
  quantity_policy_version: CMS_QUANTITY_POLICY_VERSION.cms_unit, returns_policy: 'sales_only_v1', unit_key_version: CMS_UNIT_KEY_VERSION,
  status_dictionary_version: CMS_RETURN_STATUS_DICTIONARY_VERSION, returns_as_of: null, ...o,
})
const C_NET = contract({ quantity_basis: 'pos_base', quantity_policy_version: CMS_QUANTITY_POLICY_VERSION.pos_base, returns_policy: 'net_returns_v1', returns_as_of: ASOF })

const row = (o: Record<string, unknown> = {}) => ({
  user_id: A, store_id: S1, program_product_id: PP1, product_id: '900001', gmv_basis: 'none', base_quantity: '250', per_unit: '100',
  cms_quantity: '2', rewarded_quantity: '2', cap_quantity: null, at_cap: false, gmv_amount: '500000', gate_gmv: null, target_gmv: null,
  gate_met: true, gate_met_at: null, potential_amount: '30000', amount_vnd: '30000', line_count: 3, ...o,
})
const net = (o: Record<string, unknown> = {}) => ({
  sale_base: '250', return_base: '0', eligible_sale_base: '200', eligible_return_base: '0', eligible_base: '200', counted_sale_qty: '2',
  sale_gmv: '500000', return_gmv: '0', return_count: 0, ...o,
})
const rowsOf = (c: unknown, results: unknown[]) => ({ run_id: RUN, contract: c, results, catalog: [], users: [{ id: A, full_name: 'DS A', store_id: S1 }] })

const header = (c: unknown) => ({
  program_id: PROG, config_version: 1, viewer: 'staff',
  run: { id: RUN, config_version: 1, published_at: '2026-11-14T03:05:00.000000Z', source_max_updated_at: null, started_at: null, contract: c },
  last_attempt: null, recent_runs: null,
})
const ev = (o: Record<string, unknown> = {}) => ({
  seq: 1, kind: 'SALE', event_key: 'SALE:L1', event_at: '2026-11-02T03:00:00.000000Z', order_line_id: 'L1', order_code: 'O1',
  product_id: '900001', program_product_id: PP1, user_id: A, store_id: S1, pos_code: 'POS1', quantity_raw: '2', uom_raw: 'Hộp',
  quantity_class: 'COUNTED', return_event_id: null, return_code: null, base_delta: '200', eligible_delta: '200', gmv_delta: '400000',
  eligible_before: '0', eligible_after: '200', qty_before: '0', qty_after: '2', amount_vnd: '30000', status: 'RECORDED', ...o,
})
const events = (rows: unknown[], c: unknown = contract()) => ({ run_id: RUN, contract: c, rows, next_after_seq: null })

test.describe('CMS-CALC-RET-2 P5.2 — hợp đồng run @desktop', () => {
  test('legacy ⇔ pos_base + sales_only_v1; contract hợp lệ đọc đủ trường', () => {
    expect(parseCmsRunContract(C_LEGACY)).toEqual(CMS_LEGACY_RUN_CONTRACT)
    const c = parseCmsRunContract(contract())
    expect(c).toMatchObject({ legacy: false, quantityBasis: 'cms_unit', returnsPolicy: 'sales_only_v1', returnsAsOf: null, unitKeyVersion: CMS_UNIT_KEY_VERSION, statusDictionaryVersion: CMS_RETURN_STATUS_DICTIONARY_VERSION })
    expect(parseCmsRunContract(C_NET)).toMatchObject({ quantityBasis: 'pos_base', returnsPolicy: 'net_returns_v1', returnsAsOf: ASOF })
  })
  test('lạ / lệch ⇒ throw (không diễn giải số với nhãn sai)', () => {
    const bad: unknown[] = [
      null, 'x',
      { ...C_LEGACY, quantity_basis: 'cms_unit' }, { ...C_LEGACY, returns_policy: 'net_returns_v1' }, { ...C_LEGACY, calc_contract_version: 'v' },
      contract({ calc_contract_version: 'cms-calc-ret2-v9' }),
      contract({ quantity_policy_version: CMS_QUANTITY_POLICY_VERSION.pos_base }),
      contract({ quantity_basis: 'box' }), contract({ returns_policy: 'net_v2' }),
      contract({ returns_policy: 'net_returns_v1', returns_as_of: null }),
      contract({ returns_as_of: ASOF }),
      contract({ returns_policy: 'net_returns_v1', returns_as_of: '2026-11-14T03:00:00Z' }),
      // PM RC r2 SALES-RC-02 — đúng CHECK cms_sync_runs_contract_shape (130): pos_base + sales_only KHÔNG có run contract; mọi run contract
      // ghi đủ unit_key_version / status_dictionary_version (kể cả sales-only) — fixture / DTO lệch hình dạng DB ⇒ throw.
      contract({ quantity_basis: 'pos_base', quantity_policy_version: CMS_QUANTITY_POLICY_VERSION.pos_base }),
      contract({ unit_key_version: null }), contract({ unit_key_version: 'uk1' }),
      contract({ status_dictionary_version: null }), contract({ status_dictionary_version: 'sd1' }),
      { ...C_NET, unit_key_version: null }, { ...C_NET, status_dictionary_version: null },
    ]
    for (const x of bad) expect(() => parseCmsRunContract(x), JSON.stringify(x)).toThrow(CmsResultDtoError)
  })
  test('header: v1 ⇒ luôn legacy (reader 122); v2 ⇒ contract của run + trường super tuỳ chọn', () => {
    expect(parseCmsResultHeader(header(contract()), 1).run?.contract).toEqual(CMS_LEGACY_RUN_CONTRACT)
    const h = parseCmsResultHeader({ ...header(C_NET), run: { ...header(C_NET).run, returns_rows_read: 12, ledger: { verdict: 'OK', eval_seq: 3, set_hash: null } } }, 2)
    expect(h.run?.contract.returnsPolicy).toBe('net_returns_v1')
    expect(h.run?.returnsRowsRead).toBe(12)
    expect(h.run?.ledger).toEqual({ verdict: 'OK', evalSeq: 3, setHash: null })
    expect(parseCmsResultHeader(header(contract()), 2).run?.ledger).toBeNull()
    expect(() => parseCmsResultHeader(header({ ...C_LEGACY, legacy: 'yes' }), 2)).toThrow(CmsResultDtoError)
  })
})

test.describe('CMS-CALC-RET-2 P5.2 — rows v2 @desktop', () => {
  test('run contract: net bắt buộc, eligibleBase = B đủ; legacy v2: không net, eligibleBase = B', () => {
    const r = parseCmsResultRows(rowsOf(contract(), [row({ net: net() })]), 2)
    expect(r.contract?.quantityBasis).toBe('cms_unit')
    expect(r.results[0].eligibleBase).toBe('200')
    expect(r.results[0].baseQuantity).toBe('250')
    expect(r.results[0].net).toMatchObject({ saleBase: '250', eligibleSaleBase: '200', countedSaleQty: '2', returnCount: 0 })
    const l = parseCmsResultRows(rowsOf(C_LEGACY, [row({ base_quantity: '200', net: null })]), 2)
    expect(l.contract).toEqual(CMS_LEGACY_RUN_CONTRACT)
    expect(l.results[0]).toMatchObject({ eligibleBase: '200', net: null })
    // v1 (122): không có khối contract ⇒ legacy.
    expect(parseCmsResultRows(rowsOf(undefined, [row({ base_quantity: '200' })]), 1).contract).toEqual(CMS_LEGACY_RUN_CONTRACT)
  })
  test('lệch cặp contract ↔ net / số sai dạng ⇒ throw', () => {
    expect(() => parseCmsResultRows(rowsOf(contract(), [row({ net: null })]), 2)).toThrow(CmsResultDtoError)
    expect(() => parseCmsResultRows(rowsOf(C_LEGACY, [row({ net: net() })]), 2)).toThrow(CmsResultDtoError)
    expect(() => parseCmsResultRows(rowsOf(contract(), [row({ net: net({ eligible_base: 200 }) })]), 2)).toThrow(CmsResultDtoError)
    expect(() => parseCmsResultRows(rowsOf(contract(), [row({ net: net({ return_count: '1' }) })]), 2)).toThrow(CmsResultDtoError)
    expect(() => parseCmsResultRows(rowsOf(null, [row({ net: net() })]), 2)).toThrow(CmsResultDtoError)
    // chưa có run ⇒ contract null, không throw.
    expect(parseCmsResultRows({ run_id: null, contract: null, results: [], catalog: [], users: [] }, 2).contract).toBeNull()
  })
})

test.describe('CMS-CALC-RET-2 P5.2 — events v2 @desktop', () => {
  test('SALE + RETURN; base / GMV âm của phiếu trả giữ dấu; mã phiếu chỉ ở RETURN', () => {
    const p = parseCmsResultEvents(events([
      ev(),
      ev({ seq: 2, kind: 'SALE', event_key: 'SALE:L2', order_line_id: 'L2', quantity_raw: '5', uom_raw: 'Viên', quantity_class: 'OTHER_UNIT',
        base_delta: '5', eligible_delta: '0', gmv_delta: '10000', eligible_before: '200', eligible_after: '200', qty_before: '2', qty_after: '2',
        amount_vnd: '0', status: 'NOT_COUNTED', return_code: 'X' }),
      ev({ seq: 3, kind: 'RETURN', event_key: 'RETURN:R1', return_event_id: 'R1', return_code: 'TRA-01', pos_code: null, base_delta: '-100',
        eligible_delta: '-100', gmv_delta: '-200000', eligible_before: '200', eligible_after: '100', qty_before: '2', qty_after: '1',
        amount_vnd: '-15000', status: 'RETURN_REDUCED' }),
    ]))
    expect(p.contract.quantityBasis).toBe('cms_unit')
    expect(p.rows.map((r) => [r.kind, r.status, r.quantityClass])).toEqual([
      ['SALE', 'RECORDED', 'COUNTED'], ['SALE', 'NOT_COUNTED', 'OTHER_UNIT'], ['RETURN', 'RETURN_REDUCED', 'COUNTED']])
    expect(p.rows[1].returnCode).toBeNull()
    expect(p.rows[2]).toMatchObject({ returnCode: 'TRA-01', baseQuantity: '-100', gmvAmount: '-200000', baseBefore: '200', baseAfter: '100', amountVnd: '-15000', posCode: null })
  })
  test('loại ↔ trạng thái lệch / lớp lượng lạ / thiếu contract ⇒ throw', () => {
    const bad = [
      events([ev({ status: 'RETURN_REDUCED' })]),
      events([ev({ kind: 'RETURN', status: 'RECORDED' })]),
      events([ev({ kind: 'ADJUST' })]),
      events([ev({ status: 'ADJUSTMENT' })]),
      events([ev({ quantity_class: 'HALF' })]),
      { ...events([ev()]), contract: undefined },
      { ...events([ev()]), contract: null },
      { ...events([ev()]), next_after_seq: -1 },
    ]
    for (const x of bad) expect(() => parseCmsResultEvents(x), JSON.stringify(x).slice(0, 120)).toThrow(CmsResultDtoError)
    // RETURN khi chưa đạt target: WAITING_GATE hợp lệ.
    expect(parseCmsResultEvents(events([ev({ kind: 'RETURN', status: 'WAITING_GATE', amount_vnd: '0' })])).rows[0].status).toBe('WAITING_GATE')
  })
  test('run legacy qua reader v2: nhận trạng thái 122 (AT_CAP / ADJUSTMENT) như reader 122; chỉ SALE + POS_BASE (db-reviewer P2-1)', () => {
    const LEG = { legacy: true, calc_contract_version: null, quantity_basis: 'pos_base', returns_policy: 'sales_only_v1' }
    const leg = (o: Record<string, unknown>) => ev({ quantity_class: 'POS_BASE', ...o })
    const p = parseCmsResultEvents(events([leg({ status: 'AT_CAP' }), leg({ seq: 2, status: 'ADJUSTMENT', amount_vnd: '-5000' }), leg({ seq: 3, status: 'WAITING_GATE' })], LEG))
    expect(p.contract.legacy).toBe(true)
    expect(p.rows.map((r) => r.status)).toEqual(['AT_CAP', 'ADJUSTMENT', 'WAITING_GATE'])
    // Trạng thái chỉ có ở run contract / loại / lớp lượng của run contract trên run legacy ⇒ DTO sai.
    for (const bad of [leg({ status: 'NOT_COUNTED' }), leg({ status: 'RETURN_REDUCED', kind: 'RETURN' }), leg({ kind: 'RETURN', status: 'WAITING_GATE' }), ev({ status: 'RECORDED' })]) {
      expect(() => parseCmsResultEvents(events([bad], LEG)), JSON.stringify(bad).slice(0, 80)).toThrow(CmsResultDtoError)
    }
    // Run contract vẫn KHÔNG nhận trạng thái chỉ có ở 122.
    for (const st of ['AT_CAP', 'ADJUSTMENT']) expect(() => parseCmsResultEvents(events([ev({ status: st })]))).toThrow(CmsResultDtoError)
  })
  test('nhãn dòng: RETURN là CMS tính lại (không phải hoàn tiền khách); NOT_COUNTED nêu lý do lớp lượng', () => {
    const p = parseCmsResultEvents(events([
      ev({ seq: 2, quantity_class: 'FRACTIONAL_QUANTITY', status: 'NOT_COUNTED', amount_vnd: '0', eligible_delta: '0', quantity_raw: '1.5' }),
      ev({ seq: 3, kind: 'RETURN', return_code: 'TRA-01', base_delta: '-100', amount_vnd: '-15000', status: 'RETURN_REDUCED', qty_before: '2', qty_after: '1' }),
      ev({ seq: 4, kind: 'RETURN', return_code: null, base_delta: '-5', amount_vnd: '0', status: 'RETURN_NO_CHANGE', qty_before: '1', qty_after: '1' }),
    ]))
    const [nc, red, same] = p.rows.map((l) => cmsLineView(l, '100', 'hộp', false))
    expect(nc).toMatchObject({ label: CMS_LINE_LABEL.NOT_COUNTED, tone: 'neutral', amountVnd: BigInt(0) })
    expect(nc.note).toContain('Số lượng lẻ')
    expect(red).toMatchObject({ label: CMS_LINE_LABEL.RETURN_REDUCED, tone: 'warning', amountVnd: BigInt(-15000) })
    expect(red.note).toContain('TRA-01')
    expect(red.note).toContain('tính lại')
    expect(red.note).not.toMatch(/hoàn tiền/i)
    expect(red.qtyText).toBe('1') // lượng trả không dấu âm (nhãn đã nói là trả hàng)
    expect(cmsLineOrderText(p.rows[1])).toBe('Trả hàng · đơn gốc #O1')
    expect(cmsLineOrderText(p.rows[0])).toBe('Đơn #O1')
    expect(cmsLineOrderText({ orderCode: 'O9' })).toBe('Đơn #O9')
    expect(same.label).toBe(CMS_LINE_LABEL.RETURN_NO_CHANGE)
    expect(same.note).toContain('không đổi')
    // ADJUSTMENT legacy chưa công bố vẫn "Chờ xác nhận" (không đổi hành vi 122).
    expect(cmsLineView({ status: 'ADJUSTMENT', amountVnd: '-1', baseQuantity: '-1', qtyBefore: '1', qtyAfter: '0' }, '1', 'hộp', false).label).toBe('Chờ xác nhận')
  })
})

test.describe('CMS-CALC-RET-2 P5.2 — giải thích lượng trên B đủ @desktop', () => {
  test('tính nguyên: B thật 250, B đủ 200, K 100 ⇒ Q 2, không tính lượng 50, phần lẻ 0; Σ khớp', () => {
    const r = parseCmsResultRows(rowsOf(contract(), [row({ net: net() })]), 2).results[0]
    const e = cmsQtyExplainRow(r)!
    expect(e).toMatchObject({ rewarded: BigInt(2), fractionBase: BigInt(0), notCountedStaff: 1 })
    expect(e.notCountedBase).toBe(BigInt(50) * BigInt(1e9))
    expect(cmsQtyExcludedBase(e)).toBe(e.notCountedBase)
    expect(cmsQtyReasons(e, 'hộp', 'none').join(' | ')).toContain('không tính lượng')
    expect(cmsFractionUnits(r)).toBe(BigInt(0))
    expect(cmsFractionText(r)).toBeNull()
    // Hai người cùng K: ΣB = (được + chưa đạt + vượt trần)·K + phần lẻ + không tính lượng.
    const r2 = parseCmsResultRows(rowsOf(contract(), [row({ user_id: uid(2), base_quantity: '330', cms_quantity: '1', rewarded_quantity: '1',
      net: net({ sale_base: '430', return_base: '100', eligible_sale_base: '250', eligible_return_base: '100', eligible_base: '150', counted_sale_qty: '3' }) })]), 2).results[0]
    const sum = cmsQtyExplain([r, r2])!
    expect(sum.baseUnits).toBe(BigInt(580) * BigInt(1e9))
    expect(sum.fractionBase).toBe(BigInt(50) * BigInt(1e9))
    expect(sum.notCountedBase).toBe(BigInt(230) * BigInt(1e9))
    expect(sum.notCountedStaff).toBe(2)
  })
  test('cộng dồn net: phần lẻ theo B đủ ròng (bán 2 hộp K100, trả 5 viên ⇒ còn 1 hộp + 95 viên — Q-232)', () => {
    const r = parseCmsResultRows(rowsOf(C_NET, [row({ base_quantity: '195', cms_quantity: '1', rewarded_quantity: '1',
      net: net({ sale_base: '200', return_base: '5', eligible_sale_base: '200', eligible_return_base: '5', eligible_base: '195', counted_sale_qty: null, return_count: 1 }) })]), 2).results[0]
    const e = cmsQtyExplainRow(r)!
    expect(e).toMatchObject({ rewarded: BigInt(1), notCountedBase: BigInt(0) })
    expect(e.fractionBase).toBe(BigInt(95) * BigInt(1e9))
    expect(cmsFractionText(r)).toBe('95 / 100 đơn vị cơ sở')
  })
  test('bất nhất ⇒ null (không bịa phần không tính): B đủ > B thật, Q ≠ floor(B đủ / K), B đủ sai dạng', () => {
    const base = parseCmsResultRows(rowsOf(contract(), [row({ net: net() })]), 2).results[0]
    expect(cmsQtyExplainRow({ ...base, eligibleBase: '300' })).toBeNull()
    expect(cmsQtyExplainRow({ ...base, cmsQuantity: '1', rewardedQuantity: '1' })).toBeNull()
    expect(cmsQtyExplainRow({ ...base, eligibleBase: 'x' })).toBeNull()
    expect(cmsQtyExplainRow({ ...base, eligibleBase: '-1' })).toBeNull()
    // Không có eligibleBase (caller cũ / run legacy): như 122 — Q trên B, không có phần "không tính lượng".
    const { eligibleBase: _drop, ...legacy } = base
    void _drop
    const e = cmsQtyExplainRow(legacy)!
    expect(e).toMatchObject({ rewarded: BigInt(2), notCountedBase: BigInt(0), notCountedStaff: 0 })
    expect(e.fractionBase).toBe(BigInt(50) * BigInt(1e9))
  })
})

test.describe('CMS-CALC-RET-2 P5.2 — câu phạm vi + cách tính ghim theo run @desktop', () => {
  test('legacy / sales_only ⇒ câu T11 nguyên văn; net ⇒ đã trừ phiếu trả hoàn tất + as_of giờ VN', () => {
    expect(cmsResultScopeNote(null)).toBe(CMS_SALES_ONLY_NOTE)
    expect(cmsResultScopeNote(CMS_LEGACY_RUN_CONTRACT)).toBe(CMS_SALES_ONLY_NOTE)
    expect(cmsResultScopeNote(parseCmsRunContract(contract()))).toBe(CMS_SALES_ONLY_NOTE)
    const n = cmsResultScopeNote(parseCmsRunContract(C_NET))
    expect(n).toContain('đã trừ phiếu trả hàng hoàn tất')
    expect(n).toContain('14/11/2026 10:00')
    expect(n).not.toBe(CMS_SALES_ONLY_NOTE)
  })
  test('dòng cách tính: run legacy chỉ khi cờ bật; run contract luôn hiện theo run (không theo cờ)', () => {
    expect(cmsRunBasisText(CMS_LEGACY_RUN_CONTRACT, false)).toBeNull()
    expect(cmsRunBasisText(CMS_LEGACY_RUN_CONTRACT, undefined)).toBeNull()
    expect(cmsRunBasisText(CMS_LEGACY_RUN_CONTRACT, true)).toBe('Cách tính: Tính lẻ — cộng dồn quy đổi')
    expect(cmsRunBasisText(parseCmsRunContract(contract()), false)).toBe('Cách tính: Tính nguyên — đúng đơn vị CMS')
    expect(cmsRunBasisText(null, true)).toBeNull()
  })
  test('loader: basisUi chỉ gắn khi cờ bật (cờ OFF ⇒ object như trước)', async () => {
    const H = parseCmsResultHeader(header(C_LEGACY), 2)
    const R = parseCmsResultRows(rowsOf(C_LEGACY, [row({ base_quantity: '200', net: null })]), 2)
    const deps = (basisUi?: boolean): CmsPinDeps => ({ enabled: true, header: async () => ({ ok: true, data: H }), rows: async () => ({ ok: true, data: R }), basisUi })
    const off = await cmsPinnedResults(deps(), PROG, { started: true })
    expect(off).toEqual({ kind: 'loaded', header: H, rows: R })
    expect('basisUi' in off).toBe(false)
    expect(await cmsPinnedResults(deps(true), PROG, { started: true })).toEqual({ kind: 'loaded', header: H, rows: R, basisUi: true })
  })
})

test.describe('CMS-CALC-RET-2 P5.2 — chọn reader theo năng lực DB @desktop', () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
  test('readers_v2 ⇒ RPC v2 (header / rows / events), khác ⇒ 122; không theo cờ; log mã cố định', () => {
    const src = read('lib/cms/server/results.ts')
    expect(src).toContain("return s.kind === 'ok' && s.caps.paths.readers_v2 ? 2 : 1")
    for (const [v2, v1] of [['rpc_cms_result_header_v2', 'rpc_cms_result_header'], ['rpc_cms_result_rows_v2', 'rpc_cms_result_rows'], ['rpc_cms_result_events_v2', 'rpc_cms_result_lines']]) {
      expect(src).toContain(`'${v2}'`)
      expect(src).toContain(`'${v1}'`)
    }
    expect(src).not.toMatch(/cmsCalcFlags|CMS_CALC_MODES_ENABLED|CMS_RETURNS_ENABLED/)
    expect(src).toContain('parseCmsResultEvents')
    // Màn D2 dùng B đủ cho "Nếu bán thêm".
    expect(read('components/cms/staff/CmsStaffProductView.tsx')).toContain('baseQuantity={card.row.eligibleBase}')
  })
})

test.describe('CMS-CALC-RET-2 P5.3 — gộp / đã trả / ròng @desktop', () => {
  test('chỉ run net có phiếu trả mới hiện; số = cột ròng của snapshot (không tính lại)', () => {
    const legacy = parseCmsResultRows(rowsOf(C_LEGACY, [row({ base_quantity: '200', net: null })]), 2).results
    expect(cmsNetSummary(legacy)).toBeNull()
    expect(cmsNetQtyText(cmsNetSummary(legacy), '100', 'hộp')).toBeNull()
    const noReturn = parseCmsResultRows(rowsOf(C_NET, [row({ base_quantity: '200', net: net({ eligible_sale_base: '200', eligible_base: '200', counted_sale_qty: null }) })]), 2).results
    expect(cmsNetSummary(noReturn)?.returnCount).toBe(0)
    expect(cmsNetQtyText(cmsNetSummary(noReturn), '100', 'hộp')).toBeNull()
    const two = parseCmsResultRows(rowsOf(C_NET, [
      row({ base_quantity: '195', cms_quantity: '1', rewarded_quantity: '1', net: net({ sale_base: '200', return_base: '5', eligible_sale_base: '200', eligible_return_base: '5', eligible_base: '195', counted_sale_qty: null, sale_gmv: '400000', return_gmv: '10000', return_count: 1 }) }),
      row({ user_id: uid(2), base_quantity: '100', cms_quantity: '1', rewarded_quantity: '1', net: net({ sale_base: '300', return_base: '200', eligible_sale_base: '300', eligible_return_base: '200', eligible_base: '100', counted_sale_qty: null, sale_gmv: '600000', return_gmv: '400000', return_count: 2 }) }),
    ]), 2).results
    const s = cmsNetSummary(two)!
    expect(s.returnCount).toBe(3)
    expect(cmsTruncVnd(s.returnGmv)).toBe(BigInt(410000))
    expect(cmsNetQtyText(s, '100', 'hộp')).toBe('Đã bán 5 · đã trả 2,05 · còn 2,95 hộp')
  })
})
