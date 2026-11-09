import { test, expect } from '@playwright/test'
import * as XLSX from 'xlsx'
import { CMS_FX_PG, CMS_FX_PG_UNIT, CMS_FX_STORE_NAMES, CMS_FX_USERS, cmsFxHeader, cmsFxProgram } from '../lib/cms/fixtureScenario'
import { cmsFxAdminResults, cmsFxLines, cmsFxStaffResults } from '../lib/cms/fixturesResults'
import { buildCmsResultWorkbook, type CmsExportInput } from '../lib/cms/exportResults'
import { cmsA3ProductVM, cmsQtyExplain } from '../lib/cms/productPresentation'
import { cmsProgramBasisOf, cmsSelectWithBasis, CMS_PROGRAM_BASIS_COLS } from '../lib/cms/programBasisCol'
import { CmsQueryError } from '../lib/cms/queryLog'
import {
  CMS_UNIT_RULE_NOTE, cmsFractionText, cmsLineView, cmsLinesMatchRun, cmsPinnedResults, cmsProductSalesStats, cmsScreenBasis, cmsSoldPhrase,
  cmsSoldText, cmsStaffCard, type CmsPinDeps, type CmsResultsLoad,
} from '../lib/cms/resultUi'
import {
  CMS_BASIS_PENDING_TEXT, CmsResultDtoError, cmsNoRunText, cmsResultState, cmsWhatIf, parseCmsResultHeader, parseCmsResultLines,
  parseCmsResultRows, type CmsResultLineDto, type CmsResultRowDto,
} from '../lib/cms/resultView'
import { CMS_BASIS_LABEL, CMS_OTHER_UNIT_TEXT } from '../lib/cms/unitBasis'
import { CMS_UNIT_KEY_VERSION } from '../lib/cms/unitKey'

// CMS-UNIT AC10 (planning/research/cms-unit-basis-spec-implementation-2026-11-09.md §4 / §7) — phía TRÌNH BÀY: DTO đọc RPC 127 (không
// khoá cơ sở ⇒ legacy pos_base) và 128 (cặp cơ sở / phiên bản, ĐV theo snapshot run, phân loại đơn vị từng dòng), trạng thái
// "chưa có số theo cách tính mới", thẻ dược sĩ / dòng lịch sử / "nếu bán thêm" / A3 / XLSX theo Q (không B / K), lệch cơ sở ⇒ lỗi
// (không trình bày số theo luật khác), cột cms_programs.quantity_basis trên DB cũ. Số lấy từ fixture PG13 sinh bằng engine thật (lib/cms/
// fixtureScenario — không gõ tay tiền). Không IO, không server.

const PG13 = cmsFxProgram(CMS_FX_PG_UNIT.PG13)!
const PG1 = cmsFxProgram(CMS_FX_PG.PG1)!
const loaded = (l: CmsResultsLoad) => { if (l.kind !== 'loaded') throw new Error(l.kind); return l }
const ppOf = (productId: string) => PG13.products.find((x) => x.productId === productId)!
const dtoErr = (f: () => unknown): string => {
  try { f() } catch (e) { if (e instanceof CmsResultDtoError) return e.message; throw e }
  throw new Error('không ném CmsResultDtoError')
}
const RUN = '00000000-0000-4000-8000-0000000c0001'
const PROG = '00000000-0000-4000-8000-0000000c0002'
const PP = '00000000-0000-4000-8000-0000000c0003'
const USER = '00000000-0000-4000-8000-0000000c0004'
const STORE = '00000000-0000-4000-8000-0000000c0005'
const TS = '2026-11-15T03:00:00.000000Z'
const META = { quantity_basis: 'cms_unit', calculation_policy_version: 'cms_unit_v1' }
const runRaw = (extra: Record<string, unknown> = {}) => ({ id: RUN, config_version: 3, published_at: TS, source_max_updated_at: TS, started_at: TS, amount_vnd: null, rows_read: null, totals: null, ...extra })
const headerRaw = (o: Record<string, unknown> = {}) => ({ program_id: PROG, config_version: 3, viewer: 'super', run: runRaw(), last_attempt: null, recent_runs: null, ...o })
const resultRaw = (extra: Record<string, unknown> = {}) => ({
  user_id: USER, store_id: STORE, program_product_id: PP, product_id: '900201', gmv_basis: 'none', base_quantity: '405', per_unit: '100',
  cms_quantity: '3', rewarded_quantity: '3', cap_quantity: null, at_cap: false, gmv_amount: '1000', gate_gmv: null, target_gmv: null, gate_met: true,
  gate_met_at: null, potential_amount: '36000', amount_vnd: '36000', line_count: 1, ...extra,
})
const UNITS = [{ program_product_id: PP, product_id: '900201', unit_cms: 'hộp', base_quantity_cms: '100' }]
const lineRaw = (extra: Record<string, unknown> = {}) => ({
  seq: 0, order_line_id: 'L1', order_code: 'O1', product_id: '900201', program_product_id: PP, user_id: USER, store_id: STORE, pos_code: null,
  completed_at: TS, quantity_raw: '5', uom_raw: 'viên', base_quantity: '5', gmv_amount: '1000', base_before: '0', base_after: '5',
  qty_before: '0', qty_after: '0', amount_vnd: '0', status: 'ACCUMULATING', ...extra,
})

test.describe('CMS-UNIT AC10 · DTO đọc RPC 127 / 128 @desktop', () => {
  test('header: 127 (không khoá) ⇒ chương trình + run pos_base legacy; 128 ⇒ cơ sở chương trình / run / lượt gần nhất / lịch sử từng run', () => {
    const h127 = parseCmsResultHeader(headerRaw({ last_attempt: { status: 'ok', started_at: TS, finished_at: TS, is_current: true, error_code: null } }))
    expect(h127.programBasis).toBe('pos_base')
    expect(h127.run!.basis).toEqual({ basis: 'pos_base', policy: 'pos_base_legacy', legacy: true })
    expect(h127.lastAttempt!.basis.legacy).toBe(true)

    const h128 = parseCmsResultHeader(headerRaw({
      quantity_basis: 'cms_unit', run: runRaw(META),
      last_attempt: { status: 'ok', started_at: TS, finished_at: TS, is_current: true, error_code: null, ...META },
      // Hai run trước / sau khi đổi cơ sở: mỗi run giữ cơ sở của CHÍNH nó (không tô lại run cũ theo luật mới).
      recent_runs: [
        { id: RUN, status: 'ok', error_code: null, started_at: TS, finished_at: TS, rows_read: 10, amount_vnd: '36000', config_version: 3, purged: false, ...META },
        { id: PP, status: 'ok', error_code: null, started_at: TS, finished_at: TS, rows_read: 10, amount_vnd: '48000', config_version: 2, purged: false, quantity_basis: 'pos_base', calculation_policy_version: 'pos_base_v1' },
        { id: USER, status: 'ok', error_code: null, started_at: TS, finished_at: TS, rows_read: 10, amount_vnd: '48000', config_version: 1, purged: false, quantity_basis: 'pos_base', calculation_policy_version: 'pos_base_legacy' },
      ],
    }))
    expect(h128.programBasis).toBe('cms_unit')
    expect(h128.run!.basis).toEqual({ basis: 'cms_unit', policy: 'cms_unit_v1', legacy: false })
    expect(h128.lastAttempt!.basis.basis).toBe('cms_unit')
    expect(h128.recentRuns!.map((r) => `${r.basis.basis}/${r.basis.policy}`)).toEqual(['cms_unit/cms_unit_v1', 'pos_base/pos_base_v1', 'pos_base/pos_base_legacy'])
    expect(parseCmsResultHeader(headerRaw({ quantity_basis: null })).programBasis).toBeNull()
  })

  test('header: cặp lệch / một khoá / enum lạ ⇒ lỗi DTO (không tự chọn pos_base)', () => {
    expect(dtoErr(() => parseCmsResultHeader(headerRaw({ run: runRaw({ quantity_basis: 'cms_unit', calculation_policy_version: 'pos_base_v1' }) })))).toContain('run.quantity_basis')
    expect(dtoErr(() => parseCmsResultHeader(headerRaw({ run: runRaw({ quantity_basis: 'cms_unit' }) })))).toContain('run.quantity_basis')
    expect(dtoErr(() => parseCmsResultHeader(headerRaw({ run: runRaw({ quantity_basis: 'cms_unit', calculation_policy_version: 'cms_unit_v2' }) })))).toContain('run.quantity_basis')
    expect(dtoErr(() => parseCmsResultHeader(headerRaw({ run: runRaw({ quantity_basis: 'cms_unit', calculation_policy_version: 'pos_base_legacy' }) })))).toContain('run.quantity_basis')
    expect(dtoErr(() => parseCmsResultHeader(headerRaw({ quantity_basis: 'box' })))).toContain('quantity_basis')
    expect(dtoErr(() => parseCmsResultHeader(headerRaw({ last_attempt: { status: 'held', started_at: TS, finished_at: TS, is_current: false, error_code: 'X', quantity_basis: 'cms_unit', calculation_policy_version: null } })))).toContain('last_attempt.quantity_basis')
  })

  test('rows: 127 không gắn cơ sở; 128 cms_unit bắt buộc ĐV theo snapshot run phủ mọi dòng; chưa có run mà có metadata ⇒ lỗi', () => {
    const r127 = parseCmsResultRows({ run_id: RUN, results: [resultRaw()], catalog: [], users: [] })
    expect(r127.basis).toEqual({ basis: 'pos_base', policy: 'pos_base_legacy', legacy: true })
    expect(r127.results[0].quantityBasis).toBeUndefined()
    const r128 = parseCmsResultRows({ run_id: RUN, ...META, units: UNITS, results: [resultRaw()], catalog: [], users: [] })
    expect(r128.results[0].quantityBasis).toBe('cms_unit')
    expect(r128.units).toEqual([{ programProductId: PP, productId: '900201', unitCms: 'hộp', baseQuantityCms: '100' }])
    const rv1 = parseCmsResultRows({ run_id: RUN, quantity_basis: 'pos_base', calculation_policy_version: 'pos_base_v1', units: UNITS, results: [resultRaw()], catalog: [], users: [] })
    expect(rv1.results[0].quantityBasis).toBe('pos_base')

    expect(dtoErr(() => parseCmsResultRows({ run_id: RUN, ...META, results: [resultRaw()], catalog: [], users: [] }))).toContain('units')
    expect(dtoErr(() => parseCmsResultRows({ run_id: RUN, ...META, units: [], results: [], catalog: [], users: [] }))).toContain('units')
    expect(dtoErr(() => parseCmsResultRows({ run_id: RUN, ...META, units: [{ ...UNITS[0], program_product_id: STORE }], results: [resultRaw()], catalog: [], users: [] }))).toContain('results[].program_product_id')
    expect(dtoErr(() => parseCmsResultRows({ run_id: RUN, ...META, units: [{ ...UNITS[0], unit_cms: '  ' }], results: [], catalog: [], users: [] }))).toContain('units[].unit_cms')
    expect(dtoErr(() => parseCmsResultRows({ run_id: null, ...META, results: [], catalog: [], users: [] }))).toContain('quantity_basis')
    expect(parseCmsResultRows({ run_id: null, quantity_basis: null, calculation_policy_version: null, results: [], catalog: [], users: [] }).basis).toBeNull()
  })

  test('lines: cms_unit bắt buộc unit_match boolean + counted nguyên; khác ĐV ⇒ counted 0; pos_base mang khoá đơn vị ⇒ lỗi', () => {
    const page = parseCmsResultLines({ run_id: RUN, next_after_seq: null, ...META, rows: [lineRaw({ unit_match: false, counted_quantity: '0' }), lineRaw({ seq: 1, unit_match: true, counted_quantity: '2', quantity_raw: '2', uom_raw: 'Hộp' })] })
    expect(page.basis).toEqual({ basis: 'cms_unit', policy: 'cms_unit_v1', legacy: false })
    expect(page.rows.map((l) => [l.quantityBasis, l.unitMatch, l.countedQuantity])).toEqual([['cms_unit', false, '0'], ['cms_unit', true, '2']])
    const p127 = parseCmsResultLines({ run_id: RUN, next_after_seq: null, rows: [lineRaw()] })
    expect(p127.basis!.legacy).toBe(true)
    expect(p127.rows[0].quantityBasis).toBeUndefined()
    expect(p127.rows[0].unitMatch).toBeUndefined()

    expect(dtoErr(() => parseCmsResultLines({ run_id: RUN, ...META, rows: [lineRaw({ counted_quantity: '0' })] }))).toContain('unit_match')
    expect(dtoErr(() => parseCmsResultLines({ run_id: RUN, ...META, rows: [lineRaw({ unit_match: 'false', counted_quantity: '0' })] }))).toContain('unit_match')
    expect(dtoErr(() => parseCmsResultLines({ run_id: RUN, ...META, rows: [lineRaw({ unit_match: false, counted_quantity: '5' })] }))).toContain('counted_quantity')
    expect(dtoErr(() => parseCmsResultLines({ run_id: RUN, ...META, rows: [lineRaw({ unit_match: true, counted_quantity: '1.5' })] }))).toContain('counted_quantity')
    expect(dtoErr(() => parseCmsResultLines({ run_id: RUN, quantity_basis: 'pos_base', calculation_policy_version: 'pos_base_v1', rows: [lineRaw({ unit_match: false })] }))).toContain('unit_match')
    expect(dtoErr(() => parseCmsResultLines({ run_id: RUN, rows: [lineRaw({ counted_quantity: '0' })] }))).toContain('unit_match')
  })

  test('ghim run: trang dòng / rows khác cơ sở hoặc phiên bản của run ⇒ không nhận (lỗi), trang 127 chỉ khớp run legacy', async () => {
    const legacy = { basis: 'pos_base' as const, policy: 'pos_base_legacy' as const, legacy: true }
    const unit = { basis: 'cms_unit' as const, policy: 'cms_unit_v1' as const, legacy: false }
    const v1 = { basis: 'pos_base' as const, policy: 'pos_base_v1' as const, legacy: false }
    expect(cmsLinesMatchRun({ runId: RUN }, { id: RUN, basis: legacy })).toBe(true)
    expect(cmsLinesMatchRun({ runId: RUN }, { id: RUN, basis: unit })).toBe(false)
    expect(cmsLinesMatchRun({ runId: RUN, basis: unit }, { id: RUN, basis: unit })).toBe(true)
    expect(cmsLinesMatchRun({ runId: RUN, basis: v1 }, { id: RUN, basis: unit })).toBe(false)
    expect(cmsLinesMatchRun({ runId: PP, basis: unit }, { id: RUN, basis: unit })).toBe(false)

    const h = parseCmsResultHeader(headerRaw({ quantity_basis: 'cms_unit', run: runRaw(META) }))
    const rowsOf = (meta: Record<string, unknown>) => parseCmsResultRows({ run_id: RUN, ...meta, units: UNITS, results: [resultRaw()], catalog: [], users: [] })
    const deps = (rows: ReturnType<typeof rowsOf>): CmsPinDeps => ({ enabled: true, header: async () => ({ ok: true, data: h }), rows: async () => ({ ok: true, data: rows }) })
    expect((await cmsPinnedResults(deps(rowsOf(META)), PROG, { started: true })).kind).toBe('loaded')
    expect((await cmsPinnedResults(deps(rowsOf({ quantity_basis: 'pos_base', calculation_policy_version: 'pos_base_v1' })), PROG, { started: true })).kind).toBe('error')
  })
})

test.describe('CMS-UNIT AC10 · trạng thái / thẻ / dòng / nếu bán thêm (fixture PG13) @desktop', () => {
  test('vừa đổi cơ sở (pointer NULL, lượt mới HOLD) ⇒ basis_pending, không 0₫ giả; pos_base cùng tình huống ⇒ config_reset như cũ', () => {
    const h = cmsFxHeader(PG13, { kind: 'super' }, { reset: true })
    expect(h.run).toBeNull()
    expect(cmsResultState(h)).toBe('basis_pending')
    expect(cmsNoRunText(h)).toBe(CMS_BASIS_PENDING_TEXT)
    const h1 = cmsFxHeader(PG1, { kind: 'super' }, { reset: true })
    expect(cmsResultState(h1)).toBe('config_reset')
    // Chưa từng tính lần nào ⇒ vẫn 'none' (kể cả cms_unit).
    expect(cmsResultState(parseCmsResultHeader(headerRaw({ quantity_basis: 'cms_unit', run: null })))).toBe('none')
    // Màn chưa có run: câu luật theo cơ sở HIỆN TẠI của chương trình.
    expect(cmsScreenBasis({ kind: 'loaded', header: h, rows: { runId: null, results: [], catalog: [], users: [] } }, undefined)).toBe('cms_unit')
    expect(cmsScreenBasis({ kind: 'off' }, 'cms_unit')).toBe('cms_unit')
    expect(cmsScreenBasis({ kind: 'off' }, undefined)).toBe('pos_base')
  })

  test('thẻ dược sĩ: "đã bán" = Q đúng ĐV (không B / K), không phần lẻ cơ sở; câu "đúng ĐV"', () => {
    const l = loaded(cmsFxStaffResults('running', PG13.row.id))
    const pp = ppOf('900201')
    const row = l.rows.results.find((r) => r.programProductId === pp.id)!
    expect([row.baseQuantity, row.perUnit, row.cmsQuantity, row.amountVnd]).toEqual(['405', '100', '3', '36000'])
    expect(cmsSoldText(row)).toBe('3')
    expect(cmsSoldText({ ...row, quantityBasis: undefined })).toBe('4,05') // luật cũ B / K — chỉ để thấy khác biệt
    expect(cmsFractionText(row)).toBeNull()
    const card = cmsStaffCard({ programProductId: pp.id, perUnit: pp.baseQuantityCms, tiers: pp.tiers, row, catalog: l.rows.catalog })
    expect(card.quantityBasis).toBe('cms_unit')
    expect(card.soldText).toBe('3')
    expect(card.amountVnd).toBe(BigInt(36000))
    expect(cmsSoldPhrase(card.soldText, 'hộp', card.quantityBasis)).toBe('Đã bán 3 hộp đúng ĐV')
    // Chưa có dòng cho SP: cơ sở của run (không suy B / K "0,00").
    const empty = cmsStaffCard({ programProductId: pp.id, perUnit: pp.baseQuantityCms, tiers: pp.tiers, row: null, catalog: [], basis: 'cms_unit' })
    expect([empty.soldText, empty.quantityBasis]).toEqual(['0', 'cms_unit'])
  })

  test('dòng lịch sử: đúng ĐV ⇒ "+N hộp"; khác ĐV ⇒ "Khác ĐV tính CMS" + đơn vị bán gốc + lý do, tiền 0; chờ target giữ nhãn', () => {
    const lines = cmsFxLines(loaded(cmsFxAdminResults('running', 'super', PG13.row.id)).rows.results)
    const pick = (uom: string, q: string, pid = '900201') => lines.find((x) => x.productId === pid && x.uomRaw === uom && x.quantityRaw === q)!
    const v = (l: CmsResultLineDto) => cmsLineView(l, '100', 'hộp', false)
    const vien = v(pick('viên', '5'))
    expect(vien).toMatchObject({ label: 'Khác ĐV tính CMS', tone: 'neutral', qtyLabel: '5 viên', note: CMS_OTHER_UNIT_TEXT, unitMatch: false, amountVnd: BigInt(0) })
    expect(v(pick('vỉ', '10'))).toMatchObject({ label: 'Khác ĐV tính CMS', qtyLabel: '10 vỉ', unitMatch: false })
    const hop = v(pick('hộp', '2'))
    expect(hop).toMatchObject({ qtyLabel: '2 hộp', note: '+2 hộp tính CMS', unitMatch: true, amountVnd: BigInt(24000) })
    expect(v(pick('hộp', '1', '900203'))).toMatchObject({ note: 'Chưa đạt target — CMS tính khi đạt', unitMatch: true })
    // Không còn số quy đổi B / K (vd. "0,05 hộp") ở bất kỳ dòng cms_unit nào.
    for (const l of lines) expect(v(l).qtyLabel, `${l.seq}`).not.toMatch(/,\d/)
    // Σ tiền dòng = Σ tiền kết quả (phân bổ snapshot, không tính lại).
    expect(lines.reduce((a, l) => a + BigInt(l.amountVnd), BigInt(0)))
      .toBe(loaded(cmsFxAdminResults('running', 'super', PG13.row.id)).rows.results.reduce((a, r) => a + BigInt(r.amountVnd), BigInt(0)))
  })

  test('"nếu bán thêm": cms_unit tính từ Q của snapshot (= tiền hiện tại của dòng kết quả), không từ B / K; thiếu Q ⇒ lỗi', () => {
    const pp = ppOf('900201')
    const row = loaded(cmsFxStaffResults('running', PG13.row.id)).rows.results.find((r) => r.programProductId === pp.id)!
    const w = cmsWhatIf({ baseQuantity: row.baseQuantity, perUnit: row.perUnit, tiers: pp.tiers, extraUnits: 1, quantityBasis: 'cms_unit', cmsQuantity: row.cmsQuantity })
    expect(w.amountNowVnd).toBe(BigInt(row.amountVnd))
    expect(w.deltaVnd > BigInt(0)).toBe(true)
    const old = cmsWhatIf({ baseQuantity: row.baseQuantity, perUnit: row.perUnit, tiers: pp.tiers, extraUnits: 1 })
    expect(old.amountNowVnd).not.toBe(BigInt(row.amountVnd)) // công thức cũ floor(405 / 100) = 4 ≠ Q 3
    expect(() => cmsWhatIf({ baseQuantity: row.baseQuantity, perUnit: row.perUnit, tiers: pp.tiers, extraUnits: 1, quantityBasis: 'cms_unit' })).toThrow(CmsResultDtoError)
    expect(() => cmsWhatIf({ baseQuantity: row.baseQuantity, perUnit: row.perUnit, tiers: pp.tiers, extraUnits: 1, quantityBasis: 'cms_unit', cmsQuantity: '3.5' })).toThrow(CmsResultDtoError)
  })

  test('A3: SL đúng ĐV = ΣQ, câu luật; trộn cơ sở trong một SP ⇒ không giải thích / không thống kê (fail-closed)', () => {
    const l = loaded(cmsFxAdminResults('running', 'super', PG13.row.id))
    const pp = ppOf('900201')
    const rows = l.rows.results.filter((r) => r.programProductId === pp.id)
    const vm = cmsA3ProductVM(pp, { catalogTargetGmv: PG13.row.catalogTargetGmv ?? null, priceText: (v) => v ?? '', programBasis: 'cms_unit',
      results: { rows, catalog: l.rows.catalog, users: l.rows.users, storeNames: CMS_FX_STORE_NAMES, basis: 'cms_unit' } })
    expect(vm.results!.quantityBasis).toBe('cms_unit')
    expect(vm.results!.ruleNote).toBe(CMS_UNIT_RULE_NOTE)
    expect(vm.results!.soldText).toBe(rows.reduce((a, r) => a + BigInt(r.cmsQuantity), BigInt(0)).toLocaleString('vi-VN'))
    expect(vm.results!.soldText).toBe('15')
    const mixed: CmsResultRowDto[] = [rows[0], { ...rows[1], quantityBasis: undefined }]
    expect(cmsQtyExplain(mixed)).toBeNull()
    expect(() => cmsProductSalesStats(mixed)).toThrow('CMS_UI_BASIS_MIXED')
  })
})

test.describe('CMS-UNIT AC10 · XLSX theo cơ sở của phiên @desktop', () => {
  const sheet = (bytes: Uint8Array, name: string) => XLSX.utils.sheet_to_json<unknown[]>(XLSX.read(bytes, { type: 'array' }).Sheets[name], { header: 1, defval: '' })
  const input = (p: typeof PG13, l: ReturnType<typeof loaded>, lines: CmsResultLineDto[]): CmsExportInput => ({
    program: { id: p.row.id, name: p.row.name, startDate: p.row.startDate, endDate: p.row.endDate, configVersion: p.row.configVersion },
    header: l.header, rows: l.rows, lines, excluded: [], products: p.products, storeNames: CMS_FX_STORE_NAMES,
    exportedAt: new Date('2026-11-15T03:00:00Z'), scope: 'super', returnsApproved: false,
  })

  test('cms_unit: Thong tin ghi cơ sở / phiên bản / khoá đơn vị; SL đúng ĐV = Q, B / K chỉ ở cột [Tra soát POS]; dòng khác ĐV ghi lý do', () => {
    const l = loaded(cmsFxAdminResults('running', 'super', PG13.row.id))
    const b = buildCmsResultWorkbook(input(PG13, l, cmsFxLines(l.rows.results)))
    if (!b.ok) throw new Error(b.error)
    const info = new Map(sheet(b.bytes, 'Thong tin').map((r) => [String(r[0]), String(r[1])]))
    expect(info.get('Cơ sở tính số lượng (của phiên)')).toBe(CMS_BASIS_LABEL.cms_unit)
    expect(info.get('Phiên bản chính sách tính (của phiên)')).toBe('cms_unit_v1')
    expect(info.get('Khoá chuẩn hoá đơn vị')).toBe(CMS_UNIT_KEY_VERSION)
    expect(info.get('Luật số lượng')).toContain(CMS_UNIT_RULE_NOTE)

    const prod = sheet(b.bytes, 'Theo san pham')
    const hd = prod[0] as string[]
    const col = (name: string) => { const i = hd.indexOf(name); if (i < 0) throw new Error(`thiếu cột ${name}`); return i }
    const p201 = prod.find((r) => r[0] === '900201')!
    expect(p201[col('ĐV tính CMS (của phiên)')]).toBe('hộp')
    expect(Number(p201[col('SL bán đúng ĐV CMS')])).toBe(15)
    expect(Number(p201[col('SL tính CMS')])).toBe(15)
    expect(Number(p201[col('CMS tạm tính (VND)')])).toBe(189000)
    expect(Number(p201[col('[Tra soát POS] Lượng cơ sở (B)')])).toBe(1625)
    expect(Number(p201[col('[Tra soát POS] K (1 ĐV CMS = K cơ sở)')])).toBe(100)
    expect(hd.filter((h) => /B \/ K|Lượng cơ sở|K \(/.test(h)).every((h) => h.startsWith('[Tra soát POS]'))).toBe(true)

    const staff = sheet(b.bytes, 'Theo duoc si')
    expect((staff[0] as string[])).toContain('SL bán đúng ĐV CMS')
    const det = sheet(b.bytes, 'Chi tiet dong')
    const dh = det[0] as string[]
    const vien = det.find((r) => r[dh.indexOf('ĐVT gốc')] === 'viên' && String(r[dh.indexOf('SL gốc')]) === '5')!
    expect(vien[dh.indexOf('Đúng ĐV CMS')]).toBe('Không')
    expect(Number(vien[dh.indexOf('SL tính CMS của dòng')])).toBe(0)
    expect(vien[dh.indexOf('Ghi chú đơn vị')]).toBe(CMS_OTHER_UNIT_TEXT)
    const hop = det.find((r) => r[dh.indexOf('ĐVT gốc')] === 'hộp' && String(r[dh.indexOf('SL gốc')]) === '12')!
    expect([hop[dh.indexOf('Đúng ĐV CMS')], Number(hop[dh.indexOf('SL tính CMS của dòng')])]).toEqual(['Có', 12])
  })

  test('pos_base (run legacy): cột / Thong tin như cũ, không cột tra soát, không khoá đơn vị', () => {
    const l = loaded(cmsFxAdminResults('running'))
    const b = buildCmsResultWorkbook(input(PG1, l, cmsFxLines(l.rows.results)))
    if (!b.ok) throw new Error(b.error)
    const info = new Map(sheet(b.bytes, 'Thong tin').map((r) => [String(r[0]), String(r[1])]))
    expect(info.get('Phiên bản chính sách tính (của phiên)')).toBe('pos_base_legacy')
    expect(info.has('Khoá chuẩn hoá đơn vị')).toBe(false)
    const hd = sheet(b.bytes, 'Theo san pham')[0] as string[]
    expect(hd).toEqual(['ProductID', 'Tên sản phẩm', 'Loại điều kiện', 'Đơn vị CMS', 'SL bán (đv CMS)', 'SL tính CMS', 'GMV (VND)', 'Dược sĩ có bán', 'Dược sĩ đạt', 'CMS tạm tính (VND)'])
    expect((sheet(b.bytes, 'Chi tiet dong')[0] as string[]).some((h) => h.includes('Tra soát') || h === 'Đúng ĐV CMS')).toBe(false)
  })

  test('header / rows / dòng lệch cơ sở, hoặc dòng cms_unit thiếu phân loại đơn vị ⇒ BASIS_MISMATCH (không xuất)', () => {
    const l = loaded(cmsFxAdminResults('running', 'super', PG13.row.id))
    const lines = cmsFxLines(l.rows.results)
    const err = (i: CmsExportInput) => { const b = buildCmsResultWorkbook(i); return b.ok ? 'ok' : b.error }
    expect(err(input(PG13, l, lines))).toBe('ok')
    expect(err(input(PG13, { ...l, rows: { ...l.rows, basis: { basis: 'pos_base', policy: 'pos_base_v1', legacy: false } } }, lines))).toBe('BASIS_MISMATCH')
    expect(err(input(PG13, { ...l, rows: { ...l.rows, results: l.rows.results.map((r, i) => (i === 0 ? { ...r, quantityBasis: undefined } : r)) } }, lines))).toBe('BASIS_MISMATCH')
    expect(err(input(PG13, l, lines.map((x, i) => (i === 0 ? { ...x, unitMatch: undefined } : x))))).toBe('BASIS_MISMATCH')
    expect(err(input(PG13, l, lines.map((x, i) => (i === 0 ? { ...x, quantityBasis: undefined } : x))))).toBe('BASIS_MISMATCH')
    const pl = loaded(cmsFxAdminResults('running'))
    const plines = cmsFxLines(pl.rows.results)
    expect(err(input(PG1, pl, plines.map((x, i) => (i === 0 ? { ...x, quantityBasis: 'cms_unit' as const, unitMatch: true, countedQuantity: '1' } : x))))).toBe('BASIS_MISMATCH')
  })
})

test.describe('CMS-UNIT AC10 · cột quantity_basis trên DB trước 128 @desktop', () => {
  test('cmsSelectWithBasis: 42703 ⇒ chạy lại ĐÚNG MỘT lần không cột; lỗi khác / thành công ⇒ không chạy lại', async () => {
    const calls: string[] = []
    const r1 = await cmsSelectWithBasis(async (x) => { calls.push(x); return { error: x ? { code: '42703' } : null, data: x } })
    expect(calls).toEqual([CMS_PROGRAM_BASIS_COLS, ''])
    expect(r1.error).toBeNull()
    calls.length = 0
    const r2 = await cmsSelectWithBasis(async (x) => { calls.push(x); return { error: { code: '42501' } } })
    expect(calls).toEqual([CMS_PROGRAM_BASIS_COLS])
    expect(r2.error!.code).toBe('42501')
    calls.length = 0
    await cmsSelectWithBasis(async (x) => { calls.push(x); return { error: null } })
    expect(calls).toEqual([CMS_PROGRAM_BASIS_COLS])
  })

  test('cmsProgramBasisOf: thiếu cột ⇒ pos_base; giá trị lạ / null ⇒ lỗi đọc (không đoán)', () => {
    expect(cmsProgramBasisOf(undefined)).toBe('pos_base')
    expect(cmsProgramBasisOf('cms_unit')).toBe('cms_unit')
    expect(cmsProgramBasisOf('pos_base')).toBe('pos_base')
    for (const v of [null, 'box', 1, '']) {
      let e: unknown = null
      try { cmsProgramBasisOf(v) } catch (x) { e = x }
      expect(e, String(v)).toBeInstanceOf(CmsQueryError)
    }
  })
})

test('CMS-UNIT AC10 · người dùng fixture PG13 đủ vai (A có cả dòng khác ĐV) @desktop', () => {
  const rows = loaded(cmsFxAdminResults('running', 'super', PG13.row.id)).rows.results
  expect(rows.some((r) => r.userId === CMS_FX_USERS.A && r.quantityBasis === 'cms_unit')).toBe(true)
})
