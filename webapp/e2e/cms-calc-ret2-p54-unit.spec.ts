import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { test, expect } from '@playwright/test'
import { parseCmsResultEvents, parseCmsResultHeader, parseCmsResultRows } from '../lib/cms/resultView'
import { buildCmsResultWorkbook, handleCmsResultExport, parseCmsExcludedPage, type CmsExportDeps, type CmsExportInput } from '../lib/cms/exportResults'
import { CMS_SALES_ONLY_NOTE } from '../lib/cms/resultUi'
import { CMS_CALC_CONTRACT_VERSION, CMS_QUANTITY_POLICY_VERSION } from '../lib/cms/calc/policy'
import { CMS_RETURN_STATUS_DICTIONARY_VERSION } from '../lib/cms/calc/returns'
import { CMS_UNIT_KEY_VERSION } from '../lib/cms/unitKey'

// CMS-CALC-RET-2 P5.4 — XLSX kết quả cho run contract (PM work order 14/11 §P5; dev design r2 §8.3 "XLSX thêm cột ròng / trả / lớp
// lượng"). Không DB: DTO dựng qua parser v2, file đọc lại bằng xlsx thật.
//  · đủ dòng = Σ(line_count bán + return_count trả) (seal 130 SEAL_RESULT_SUMS), Σ tiền sự kiện = Σ tiền kết quả;
//  · Thông tin ghim cách tính / chính sách trả / as_of / hợp đồng theo PHIÊN; run legacy giữ file như cũ;
//  · super: dòng loại qua reader v2 + sheet "Khong tinh luong" (chỉ run contract); SM không có.

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const RUN = uid(31), PROG = uid(41), A = uid(1), S1 = uid(11), PP1 = uid(21)
const ASOF = '2026-11-14T03:00:00.000000Z'
const C_LEGACY = { legacy: true, calc_contract_version: null, quantity_basis: 'pos_base', returns_policy: 'sales_only_v1' }
const C_UNIT_NET = {
  legacy: false, calc_contract_version: CMS_CALC_CONTRACT_VERSION, quantity_basis: 'cms_unit', quantity_policy_version: CMS_QUANTITY_POLICY_VERSION.cms_unit,
  returns_policy: 'net_returns_v1', unit_key_version: CMS_UNIT_KEY_VERSION, status_dictionary_version: CMS_RETURN_STATUS_DICTIONARY_VERSION, returns_as_of: ASOF,
}
const PROGRAM = { id: PROG, name: 'QA tính nguyên + trả', startDate: '2026-11-01', endDate: '2026-11-30', configVersion: 1, status: 'active' }
const PRODUCTS = [{ id: PP1, productId: '900001', nameSnapshot: 'SP test', unitCms: 'hộp', baseQuantityCms: '100', gmvBasis: 'none' }]

const headerRaw = (c: unknown) => ({
  program_id: PROG, config_version: 1, viewer: 'super',
  run: { id: RUN, config_version: 1, published_at: '2026-11-14T03:05:00.000000Z', source_max_updated_at: '2026-11-14T02:59:00.000000Z', started_at: null,
    amount_vnd: '15000', rows_read: 3, totals: null, contract: c, returns_rows_read: 1, ledger: null },
  last_attempt: null, recent_runs: null,
})
const row = (o: Record<string, unknown> = {}) => ({
  user_id: A, store_id: S1, program_product_id: PP1, product_id: '900001', gmv_basis: 'none', base_quantity: '105', per_unit: '100',
  cms_quantity: '1', rewarded_quantity: '1', cap_quantity: null, at_cap: false, gmv_amount: '210000', gate_gmv: null, target_gmv: null,
  gate_met: true, gate_met_at: null, potential_amount: '15000', amount_vnd: '15000', line_count: 2,
  net: { sale_base: '205', return_base: '100', eligible_sale_base: '200', eligible_return_base: '100', eligible_base: '100', counted_sale_qty: '2',
    sale_gmv: '410000', return_gmv: '200000', return_count: 1 },
  ...o,
})
const ev = (o: Record<string, unknown>) => ({
  seq: 1, kind: 'SALE', event_key: 'SALE:L1', event_at: '2026-11-02T03:00:00.000000Z', order_line_id: 'L1', order_code: 'O1',
  product_id: '900001', program_product_id: PP1, user_id: A, store_id: S1, pos_code: 'POS1', quantity_raw: '2', uom_raw: 'Hộp',
  quantity_class: 'COUNTED', return_event_id: null, return_code: null, base_delta: '200', eligible_delta: '200', gmv_delta: '400000',
  eligible_before: '0', eligible_after: '200', qty_before: '0', qty_after: '2', amount_vnd: '30000', status: 'RECORDED', ...o,
})
const EVENTS = [
  ev({}),
  ev({ seq: 2, event_key: 'SALE:L2', order_line_id: 'L2', order_code: 'O2', quantity_raw: '5', uom_raw: 'Viên', quantity_class: 'OTHER_UNIT', base_delta: '5',
    eligible_delta: '0', gmv_delta: '10000', eligible_before: '200', eligible_after: '200', qty_before: '2', qty_after: '2', amount_vnd: '0', status: 'NOT_COUNTED' }),
  ev({ seq: 3, kind: 'RETURN', event_key: 'RETURN:R1', return_event_id: 'R1', return_code: 'TRA-01', pos_code: null, base_delta: '-100', eligible_delta: '-100',
    gmv_delta: '-200000', eligible_before: '200', eligible_after: '100', qty_before: '2', qty_after: '1', amount_vnd: '-15000', status: 'RETURN_REDUCED' }),
]
const QX = { seq: 2, order_line_id: 'L2', order_code: 'O2', product_id: '900001', program_product_id: PP1, disposition: 'INCLUDED', unassigned_reason: null,
  seller_email: 'ban@example.test', user_id: A, store_id: S1, pos_code: 'POS1', completed_at: '2026-11-02T03:00:00.000000Z', base_quantity: '5', gmv_amount: '10000',
  quantity_raw: '5', uom_raw: 'Viên', quantity_src_flag: null, uom_src_flag: null, quantity_class: 'OTHER_UNIT', eligible_base: '0' }

function input(o: Partial<CmsExportInput> = {}): CmsExportInput {
  const header = parseCmsResultHeader(headerRaw(C_UNIT_NET), 2)
  const rows = parseCmsResultRows({ run_id: RUN, contract: C_UNIT_NET, results: [row()], catalog: [], users: [{ id: A, full_name: 'DS A', store_id: S1 }] }, 2)
  const lines = parseCmsResultEvents({ run_id: RUN, contract: C_UNIT_NET, rows: EVENTS, next_after_seq: null }).rows
  const excludedQty = parseCmsExcludedPage({ run_id: RUN, rows: [QX], next_after_seq: null }).rows
  return { program: PROGRAM, header, rows, lines, excluded: [], excludedQty, products: PRODUCTS, storeNames: new Map([[S1, 'NT 01']]),
    exportedAt: new Date('2026-11-14T04:00:00Z'), scope: 'super', returnsApproved: false, ...o }
}
const wbOf = (b: ReturnType<typeof buildCmsResultWorkbook>) => { if (!b.ok) throw new Error(b.error); return XLSX.read(b.bytes, { type: 'array' }) }
const aoa = (wb: XLSX.WorkBook, s: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[s], { header: 1 })
const info = (wb: XLSX.WorkBook) => new Map(aoa(wb, 'Thong tin').map((r) => [String(r[0]), r[1]]))
const objs = (wb: XLSX.WorkBook, s: string) => XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[s])

test.describe('CMS-CALC-RET-2 P5.4 — XLSX run contract @desktop', () => {
  test('đủ dòng = bán + trả; Σ tiền sự kiện = Σ kết quả; thiếu / lệch ⇒ không file', () => {
    const i = input()
    expect(buildCmsResultWorkbook(i).ok).toBe(true)
    expect(buildCmsResultWorkbook({ ...i, lines: i.lines.slice(0, 2) })).toEqual({ ok: false, error: 'COUNT_MISMATCH' })
    expect(buildCmsResultWorkbook({ ...i, lines: i.lines.map((l) => (l.kind === 'RETURN' ? { ...l, amountVnd: '-14999' } : l)) })).toEqual({ ok: false, error: 'TOTAL_MISMATCH' })
    // header và rows khác hợp đồng (cùng run_id) ⇒ không trộn diễn giải.
    const legacyRows = parseCmsResultRows({ run_id: RUN, contract: C_LEGACY, results: [row({ base_quantity: '100', net: null, line_count: 3 })], catalog: [], users: [] }, 2)
    expect(buildCmsResultWorkbook({ ...i, rows: legacyRows })).toEqual({ ok: false, error: 'RUN_MISMATCH' })
  })
  test('Thông tin ghim theo phiên: phạm vi net + as_of, cách tính, chính sách, hợp đồng, loại số liệu', () => {
    const m = info(wbOf(buildCmsResultWorkbook(input())))
    expect(String(m.get('Phạm vi số liệu'))).toContain('đã trừ phiếu trả hàng hoàn tất')
    expect(m.get('Cách tính lượng (ghim theo phiên)')).toBe('Tính nguyên — đúng đơn vị CMS')
    expect(m.get('Chính sách trả hàng (ghim theo phiên)')).toBe('Trừ trả hàng hoàn tất')
    expect(m.get('Dữ liệu trả đến (VN)')).toBe('14/11/2026 10:00:00')
    expect(String(m.get('Hợp đồng tính'))).toBe(`${CMS_CALC_CONTRACT_VERSION} · ${CMS_QUANTITY_POLICY_VERSION.cms_unit} · ${CMS_UNIT_KEY_VERSION}`)
    expect(m.get('Loại số liệu')).toBe('Tạm tính — chưa chốt kỳ')
    expect(String(m.get('Định nghĩa lượng'))).toContain('ĐỦ ĐIỀU KIỆN')
    expect(String(info(wbOf(buildCmsResultWorkbook(input({ program: { ...PROGRAM, status: 'locked' } })))).get('Loại số liệu'))).toContain('Số đã chốt')
  })
  test('Theo SP / Theo dược sĩ: cột cũ giữ vị trí (ròng), cột cuối gộp / trả / đủ điều kiện / phiếu', () => {
    const wb = wbOf(buildCmsResultWorkbook(input()))
    const p = objs(wb, 'Theo san pham')[0]
    expect(p).toMatchObject({ ProductID: '900001', 'SL bán ròng (đv CMS)': '1,05', 'SL tính CMS': 1, 'GMV ròng (VND)': 210000, 'CMS tạm tính (VND)': 15000,
      'K (cơ sở / 1 đv CMS)': 100, 'SL đủ điều kiện (đv CMS)': '1', 'SL bán gộp (đv CMS)': '2,05', 'SL trả (đv CMS)': '1', 'GMV bán gộp (VND)': 410000, 'GMV trả (VND)': 200000, 'Dòng trả hàng': 1 })
    expect((aoa(wb, 'Theo san pham')[0] as string[]).slice(0, 10)).toEqual(['ProductID', 'Tên sản phẩm', 'Loại điều kiện', 'Đơn vị CMS', 'SL bán ròng (đv CMS)', 'SL tính CMS', 'GMV ròng (VND)', 'Dược sĩ có bán', 'Dược sĩ đạt', 'CMS tạm tính (VND)'])
    const s = objs(wb, 'Theo duoc si')[0]
    expect(s).toMatchObject({ 'Dược sĩ': 'DS A', 'SL bán ròng (đv CMS)': '1,05', 'SL tính CMS': 1, 'GMV ròng (VND)': 210000, 'Số dòng bán': 2,
      'SL đủ điều kiện (đv CMS)': '1', 'SL bán gộp (đv CMS)': '2,05', 'SL trả (đv CMS)': '1', 'GMV trả (VND)': 200000, 'Dòng trả hàng': 1 })
  })
  test('Chi tiết dòng: sự kiện bán + phiếu trả, lũy kế đủ điều kiện, số âm ở phiếu trả, lớp lượng tiếng Việt', () => {
    const l = objs(wbOf(buildCmsResultWorkbook(input())), 'Chi tiet dong')
    expect(l.map((x) => [x['Loại'], x['Lớp lượng'], x['Trạng thái'], x['Thay đổi CMS (VND)']])).toEqual([
      ['Bán', 'Đúng đơn vị, số nguyên', 'Đã ghi nhận', 30000],
      ['Bán', 'Khác đơn vị CMS', 'Không tính lượng', 0],
      ['Trả hàng', 'Đúng đơn vị, số nguyên', 'Trả hàng — giảm CMS', -15000],
    ])
    expect(l[2]).toMatchObject({ 'Mã phiếu trả': 'TRA-01', 'Thay đổi cơ sở': -100, 'Thay đổi GMV (VND)': -200000, 'Lũy kế cơ sở đủ ĐK trước': 200, 'Lũy kế cơ sở đủ ĐK sau': 100, 'Thay đổi cơ sở đủ ĐK': -100 })
    expect(l[2].POS).toBeUndefined()
  })
  test('super: sheet "Khong tinh luong" (lớp lượng, SL / ĐVT gốc, không email); SM: không sheet loại', () => {
    const wb = wbOf(buildCmsResultWorkbook(input()))
    expect(wb.SheetNames).toEqual(['Thong tin', 'Theo san pham', 'Theo duoc si', 'Chi tiet dong', 'Chua gan', 'Khong tinh luong'])
    const q = objs(wb, 'Khong tinh luong')
    expect(q).toEqual([expect.objectContaining({ 'Mã đơn': 'O2', 'Lớp lượng': 'Khác đơn vị CMS', 'SL gốc': '5', 'ĐVT gốc': 'Viên', 'SL cơ sở': 5, 'GMV (VND)': 10000 })])
    expect(JSON.stringify(aoa(wb, 'Khong tinh luong'))).not.toContain('example.test')
    const sm = wbOf(buildCmsResultWorkbook(input({ scope: 'sm', excluded: null })))
    expect(sm.SheetNames).not.toContain('Chua gan')
    expect(sm.SheetNames).not.toContain('Khong tinh luong')
  })
  test('run legacy qua reader v2: file như cũ (không cột / dòng hợp đồng, câu phạm vi T11)', () => {
    const header = parseCmsResultHeader(headerRaw(C_LEGACY), 2)
    const rows = parseCmsResultRows({ run_id: RUN, contract: C_LEGACY, results: [row({ base_quantity: '200', cms_quantity: '2', rewarded_quantity: '2', amount_vnd: '30000', potential_amount: '30000', gmv_amount: '400000', line_count: 1, net: null })], catalog: [], users: [] }, 2)
    const lines = parseCmsResultEvents({ run_id: RUN, contract: C_LEGACY, rows: [ev({ quantity_class: 'POS_BASE' })], next_after_seq: null }).rows
    const wb = wbOf(buildCmsResultWorkbook(input({ header, rows, lines, excludedQty: null })))
    const m = info(wb)
    expect(m.get('Phạm vi số liệu')).toBe(CMS_SALES_ONLY_NOTE)
    expect(m.has('Cách tính lượng (ghim theo phiên)')).toBe(false)
    expect((aoa(wb, 'Theo san pham')[0] as string[]).length).toBe(10)
    expect((aoa(wb, 'Chi tiet dong')[0] as string[])).not.toContain('Loại')
    expect(wb.SheetNames).not.toContain('Khong tinh luong')
  })
})

test.describe('CMS-CALC-RET-2 P5.4 — handler đọc dòng loại v2 @desktop', () => {
  const URL_OK = `http://localhost/api/export/cms?program=${PROG}&run=${RUN}`
  function deps(contract: unknown, calls: string[], o: Partial<CmsExportDeps> = {}): CmsExportDeps {
    const i = input()
    const legacy = (contract as { legacy: boolean }).legacy
    const header = parseCmsResultHeader(headerRaw(contract), 2)
    const rows = legacy
      ? parseCmsResultRows({ run_id: RUN, contract, results: [row({ base_quantity: '200', cms_quantity: '2', rewarded_quantity: '2', amount_vnd: '30000', potential_amount: '30000', line_count: 1, net: null })], catalog: [], users: [] }, 2)
      : i.rows
    const lines = legacy ? parseCmsResultEvents({ run_id: RUN, contract, rows: [ev({ quantity_class: 'POS_BASE' })], next_after_seq: null }).rows : i.lines
    return {
      session: async () => { calls.push('session'); return { userId: A, role: 'admin', email: null } },
      flags: () => { calls.push('flags'); return { program: true, earnings: true } },
      access: () => { calls.push('access'); return { view: true, manage: true } },
      program: async () => { calls.push('program'); return { ok: true, data: { program: PROGRAM, products: PRODUCTS } } },
      header: async () => { calls.push('header'); return { ok: true, data: header } },
      rows: async () => { calls.push('rows'); return { ok: true, data: rows } },
      lines: async () => { calls.push('lines'); return { ok: true, data: lines } },
      excluded: async (_p, _r, after, kind) => {
        calls.push(`excluded:${kind ?? '-'}:${after}`)
        return { ok: true, data: parseCmsExcludedPage({ run_id: RUN, rows: kind === 'quantity' ? [QX] : [], next_after_seq: null }) }
      },
      storeNames: async () => { calls.push('storeNames'); return new Map() },
      now: () => new Date('2026-11-14T04:00:00Z'),
      returnsApproved: false,
      ...o,
    }
  }
  test('run contract: đọc disposition rồi quantity; run legacy: chỉ disposition (như 122)', async () => {
    const c1: string[] = []
    const r1 = await handleCmsResultExport(new Request(URL_OK), deps(C_UNIT_NET, c1))
    expect(r1.status).toBe(200)
    expect(c1.filter((c) => c.startsWith('excluded'))).toEqual(['excluded:disposition:null', 'excluded:quantity:null'])
    expect(XLSX.read(new Uint8Array(await r1.arrayBuffer()), { type: 'array' }).SheetNames).toContain('Khong tinh luong')
    const c2: string[] = []
    expect((await handleCmsResultExport(new Request(URL_OK), deps(C_LEGACY, c2))).status).toBe(200)
    expect(c2.filter((c) => c.startsWith('excluded'))).toEqual(['excluded:disposition:null'])
  })
  test('trang quantity khác run ⇒ 409; lỗi ⇒ không file', async () => {
    const bad = deps(C_UNIT_NET, [], { excluded: async (_p, _r, _a, kind) => ({ ok: true, data: { runId: kind === 'quantity' ? uid(999) : RUN, rows: [], nextAfterSeq: null } }) })
    expect((await handleCmsResultExport(new Request(URL_OK), bad)).status).toBe(409)
    const err = deps(C_UNIT_NET, [], { excluded: async (_p, _r, _a, kind) => (kind === 'quantity' ? { ok: false, error: 'QUERY_FAILED' } : { ok: true, data: { runId: RUN, rows: [], nextAfterSeq: null } }) })
    expect((await handleCmsResultExport(new Request(URL_OK), err)).status).toBe(500)
  })
  test('loader: excluded v2 theo năng lực DB; DB cũ không nhận kind quantity', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib/cms/server/results.ts'), 'utf8')
    expect(src).toContain("'rpc_cms_result_excluded_v2', { p_program_id: o.programId, p_run_id: o.runId, p_kind: o.kind ?? 'disposition'")
    expect(src).toContain("if (o.kind === 'quantity') return { ok: false, error: 'BAD_INPUT' }")
    expect(fs.readFileSync(path.join(__dirname, '..', 'app/api/export/cms/route.ts'), 'utf8')).toContain('cmsLoadResultExcluded({ programId, runId, afterSeq, limit: 500, kind })')
  })
})
