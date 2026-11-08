import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { test, expect } from '@playwright/test'
import { BigQueryError, bqDryRunBytes, bqQueryAll, type BqTransport } from '../lib/bigquery/query'
import { CMS_IMPORT_COLUMNS, parseCmsImportXlsx } from '../lib/cms/import/parse'
import { parseCmsSimpleXlsx, cmsSimpleFieldOf } from '../lib/cms/import/parseSimple'
import { validateCmsSimpleImport } from '../lib/cms/import/validateSimple'
import { canonicalCmsImport, validateCmsImport, type CmsProductMasterLite } from '../lib/cms/import/validate'
import {
  cmsApplyKCheck, cmsBindKAcks, cmsKClassify, cmsKTargets, cmsParseKAckInput, cmsStoredKAcks, type CmsKEvidence, type CmsKEvidenceRow,
} from '../lib/cms/import/kCheck'
import { buildCmsKEvidenceQuery, fetchCmsKEvidence, normalizeCmsKEvidenceRow, CMS_K_BYTES_CAP, type CmsKProbeIo } from '../lib/cms/import/kSource'
import { buildCmsSimpleErrorXlsx, buildCmsSimpleTemplateXlsx, CMS_SIMPLE_SHEET } from '../lib/cms/import/workbooks'
import {
  handleCmsImportCommit, handleCmsImportErrors, handleCmsImportPreview, CmsRepoError,
  type CmsImportDeps, type CmsImportPayload, type CmsImportRepo, type CmsImportRunRow, type CmsProgramRow,
} from '../lib/cms/import/handler'
import { cmsFlatRate } from '../lib/cms/flat'
import { parseCmsDecimal } from '../lib/cms/decimal'
import {
  cmsDecodeUnitIssueSummary, cmsEncodeUnitIssueSummary, cmsRowIssueContext, cmsSummarizeRowIssues, CMS_UNIT_ISSUE_MAX_BYTES,
} from '../lib/cms/sourceDiagnostics'
import { normalizeSalesRow } from '../lib/cms/source/contract'
import { cmsImportV2FromEnv } from '../lib/cms/flags'
import { runCmsSalesSync } from '../lib/cms/salesSync'
import { createCmsFixtureRunner } from './cmsFixtureRunner'
import { fxSale } from './cmsSourceFixture'

// CMS đơn giản S1 + S2 (PM spec r1 08/11 §4–§5) — thuần, không DB / mạng. ProductID giả 9xxxxx; workbook stakeholder (nếu có trên máy
// Dev) chỉ ĐỌC để khẳng định bố cục thật, không chép vào repo.

const u = (s: string) => { const r = parseCmsDecimal(s, { allowNegative: true }); if (!r.ok) throw new Error(s); return r.units }
const H7 = ['product_id', 'product_name', 'brand_name', 'ĐV tính CMS (1 item)', 'Giá bán / item (đ)', 'CMS proposal\u00A0', 'CTKM tháng 11']
const H9 = [...H7, 'base_quantity_CMS', 'Noi_dung_tu_van']
function wb(rows: (string | number | null | { f: string; v?: number })[][], sheet = 'Sheet1'): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(rows.map((r) => r.map((c) => (c !== null && typeof c === 'object' ? null : c))))
  rows.forEach((r, ri) => r.forEach((c, ci) => { if (c !== null && typeof c === 'object') ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = { t: 'n', f: c.f, v: c.v } }))
  const b = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(b, ws, sheet)
  return new Uint8Array(XLSX.write(b, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}
const PM = new Map<string, CmsProductMasterLite>([
  ['900101', { productName: 'Viên sắt mẫu hộp 30 viên', imageUrl: null, isActive: true, referencePrice: '320000' }],
  ['900102', { productName: 'Siro kẽm mẫu chai 100ml', imageUrl: null, isActive: true, referencePrice: null }],
  ['900103', { productName: 'Men vi sinh mẫu hộp 10 gói', imageUrl: null, isActive: true, referencePrice: '185000' }],
])
const ctx = (o: Partial<Parameters<typeof validateCmsImport>[1]> = {}) => ({ mode: 'replace' as const, productMaster: PM, existingProductIds: new Set<string>(), conflictProductIds: new Set<string>(), currentCatalogTarget: null, ...o })
const ADV = 'Tư vấn đã duyệt (mẫu)'

test.describe('CMS đơn giản S1 — đọc file 7 cột @desktop', () => {
  test('alias tường minh: NBSP cuối "CMS proposal", NFD / hoa thường, CTKM theo tháng; trường lạ ⇒ không khớp', () => {
    expect(cmsSimpleFieldOf('CMS proposal\u00A0')).toBe('cms')
    expect(cmsSimpleFieldOf('  cms   PROPOSAL ')).toBe('cms')
    expect(cmsSimpleFieldOf('ĐV tính CMS (1 item)'.normalize('NFD'))).toBe('unit')
    expect(cmsSimpleFieldOf('CTKM tháng 11')).toBe('promo')
    expect(cmsSimpleFieldOf('CTKM tháng 13')).toBeNull()
    expect(cmsSimpleFieldOf('CMS')).toBeNull()
    expect(cmsSimpleFieldOf('Giá bán / item (đ)')).toBe('price')
  })

  test('file 7 cột KHÔNG có K / tư vấn: đọc được (ánh xạ bậc 1 từ 1, không target) nhưng mọi SP bị loại — không K = 1, không tư vấn giả', () => {
    const p = parseCmsSimpleXlsx(wb([H7, [900101, 'Viên sắt mẫu hộp 30 viên', 'B', 'hộp', 320000, 58000, 0], [900102, 'Siro', 'B', 'chai', 95000, 24000, 0.1]]))
    if (!p.ok) throw new Error(p.error)
    expect(p.supplement).toEqual({ baseQuantity: false, advice: false })
    expect(p.rows.map((r) => [r.cells.Tu_SL_ban, r.cells.Den_SL_ban.kind, r.cells.KPI_Target_GMV_VND.kind, r.cells.Loai_CMS_GMV.kind, r.cells.CMS_VND_SP])).toEqual([
      [{ kind: 'number', value: 1 }, 'empty', 'empty', 'empty', { kind: 'number', value: 58000 }],
      [{ kind: 'number', value: 1 }, 'empty', 'empty', 'empty', { kind: 'number', value: 24000 }],
    ])
    expect(p.rows[1].info).toEqual({ product_name: 'Siro', brand_name: 'B', price: 95000, promo: 0.1 })
    const v = validateCmsSimpleImport(p.rows, ctx())
    expect(v.groupsOk).toEqual([])
    for (const g of v.groupsRejected) expect(g.errors.map((e) => e.code).sort()).toEqual(['ADVICE_REQUIRED', 'BASE_QTY_REQUIRED'])
  })

  test('đủ 2 cột bổ sung ⇒ 1 bậc {1, không giới hạn, mức = CMS proposal}, gate none, flat; giá / CTKM / brand không vào payload; tên lệch Master ⇒ cảnh báo', () => {
    const p = parseCmsSimpleXlsx(wb([H9, [900101, 'Tên khác Master', 'BrandFile', 'hộp', 999999, 58000, 0.25, 30, ADV], [900103, 'Men vi sinh mẫu hộp 10 gói', 'B', 'hộp', 185000, 31410, 0, '10', ADV]]))
    if (!p.ok) throw new Error(p.error)
    expect(p.supplement).toEqual({ baseQuantity: true, advice: true })
    const v = validateCmsSimpleImport(p.rows, ctx())
    expect(v.groupsRejected).toEqual([])
    expect(v.groupsOk.map((g) => [g.productId, g.gmvBasis, g.targetGmv, g.unitCms, g.baseQuantityCms, g.tiers, cmsFlatRate(g)])).toEqual([
      ['900101', 'none', null, 'hộp', '30', [{ order: 1, from: 1, to: null, amount: '58000' }], '58000'],
      ['900103', 'none', null, 'hộp', '10', [{ order: 1, from: 1, to: null, amount: '31410' }], '31410'],
    ])
    expect(v.groupsOk[0].warnings.map((w) => w.code)).toEqual(['IMAGE_MISSING', 'NAME_DIFFERS_MASTER'])
    expect(v.groupsOk[1].warnings.map((w) => w.code)).toEqual(['IMAGE_MISSING'])
    // Giá / CTKM / brand của FILE không vào payload (giá hiển thị = Product Master 320000, khác giá file 999999).
    expect(JSON.stringify(v.groupsOk)).not.toMatch(/999999|0\.25|BrandFile/)
    expect(v.groupsOk[0].priceSnapshot).toBe('320000')
  })

  test('tiền: phần lẻ (31,41 / "31,41") ⇒ lỗi, không đoán; ô công thức ở CMS proposal ⇒ lỗi; công thức ở cột tham khảo ⇒ bỏ qua', () => {
    const p = parseCmsSimpleXlsx(wb([H9,
      [900101, 'x', 'B', 'hộp', 320000, 31.41, 0, 30, ADV],
      [900102, 'x', 'B', 'chai', 95000, '31,41', 0, 1, ADV],
      [900103, 'x', 'B', 'hộp', { f: 'B1*2', v: 2 }, { f: 'E4*5%', v: 9250 }, 0, 10, ADV],
    ]))
    if (!p.ok) throw new Error(p.error)
    const v = validateCmsSimpleImport(p.rows, ctx())
    const codes = Object.fromEntries(v.groupsRejected.map((g) => [g.key, g.errors.map((e) => e.code)]))
    expect(codes).toEqual({ '900101': ['NOT_INTEGER'], '900102': ['NOT_INTEGER'], '900103': ['CELL_FORMULA'] })
  })

  test('ID mất chính xác (ô số > 2^53) ⇒ lỗi ProductID; ProductID lặp ⇒ DUPLICATE_PRODUCT (không báo "bậc chồng")', () => {
    const p = parseCmsSimpleXlsx(wb([H9, [9007199254740993, 'x', 'B', 'hộp', 1, 1000, 0, 1, ADV], [900101, 'x', 'B', 'hộp', 1, 1000, 0, 30, ADV], [900101, 'x', 'B', 'hộp', 1, 2000, 0, 30, ADV]]))
    if (!p.ok) throw new Error(p.error)
    const v = validateCmsSimpleImport(p.rows, ctx())
    const by = Object.fromEntries(v.groupsRejected.map((g) => [g.key, g.errors.map((e) => e.code)]))
    expect(by['900101']).toEqual(['DUPLICATE_PRODUCT'])
    expect(Object.entries(by).find(([k]) => k.startsWith('raw:'))?.[1]).toEqual(['PRODUCT_ID_INVALID'])
  })

  test('header: thiếu cột ⇒ MISSING_COLUMNS (tên); hai cột cùng ý nghĩa ⇒ DUPLICATE_COLUMNS; nhầm mẫu 9 cột ⇔ 7 cột ⇒ lỗi rõ', () => {
    const miss = parseCmsSimpleXlsx(wb([H7.filter((h) => !h.startsWith('CTKM')), [900101, 'x', 'B', 'hộp', 1, 1000]]))
    expect(miss).toEqual({ ok: false, error: 'MISSING_COLUMNS', missing: ['CTKM'] })
    const dup = parseCmsSimpleXlsx(wb([[...H7, 'cms proposal'], [900101, 'x', 'B', 'hộp', 1, 1000, 0, 2000]]))
    expect(dup).toEqual({ ok: false, error: 'DUPLICATE_COLUMNS', duplicate: ['CMS proposal'] })
    const nine = wb([[...CMS_IMPORT_COLUMNS], [900101, null, null, 1, null, 1000, ADV, 'hộp', 30]], 'IMPORT_CMS')
    expect(parseCmsSimpleXlsx(nine)).toMatchObject({ ok: false, error: 'MISSING_COLUMNS' })
    expect(parseCmsImportXlsx(wb([H9, [900101, 'x', 'B', 'hộp', 1, 1000, 0, 30, ADV]]))).toEqual({ ok: false, error: 'NO_SHEET' })
  })

  test('file mẫu tĩnh = bộ sinh; đọc bằng parser mức cố định: 2 SP giả 999xxx, có K + tư vấn; hướng dẫn ghi công thức, không suy từ giá', () => {
    const built = buildCmsSimpleTemplateXlsx()
    const file = new Uint8Array(fs.readFileSync(path.resolve(__dirname, '..', 'public', 'templates', 'Circa_Import_CMS_muc_co_dinh.xlsx')))
    const a = parseCmsSimpleXlsx(built), b = parseCmsSimpleXlsx(file)
    if (!a.ok || !b.ok) throw new Error('template')
    expect(b.rows.map((r) => r.raw)).toEqual(a.rows.map((r) => r.raw))
    expect(a.rows.map((r) => r.raw.ProductID)).toEqual([999001, 999002])
    expect(a.supplement).toEqual({ baseQuantity: true, advice: true })
    const guide = JSON.stringify(XLSX.utils.sheet_to_json(XLSX.read(built, { type: 'array' }).Sheets.HUONG_DAN, { header: 1 }))
    expect(guide).toContain('KHÔNG dùng trong công thức CMS')
    expect(guide).toContain('KHÔNG mặc định 1')
  })

  test('file lỗi mức cố định: đúng bố cục 9 cột business + Loi, giữ giá trị gốc kể cả cột tham khảo, nhãn cột business', () => {
    const p = parseCmsSimpleXlsx(wb([H7, [900102, 'Siro', 'Brand X', 'chai', 95000, 24000, 0.1]]))
    if (!p.ok) throw new Error(p.error)
    const v = validateCmsSimpleImport(p.rows, ctx())
    const x = XLSX.read(buildCmsSimpleErrorXlsx(v.groupsRejected.map((g) => ({ key: g.key, rows: g.rows, errors: g.errors }))), { type: 'array' })
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(x.Sheets[CMS_SIMPLE_SHEET], { header: 1 })
    expect(rows[0]).toEqual(['product_id', 'product_name', 'brand_name', 'ĐV tính CMS (1 item)', 'Giá bán / item (đ)', 'CMS proposal', 'CTKM', 'base_quantity_CMS', 'Noi_dung_tu_van', 'Loi'])
    expect(rows[1].slice(0, 7)).toEqual([900102, 'Siro', 'Brand X', 'chai', 95000, 24000, 0.1])
    expect(String(rows[1][9])).toMatch(/\[Noi_dung_tu_van\].*\[base_quantity_CMS\]|\[base_quantity_CMS\].*\[Noi_dung_tu_van\]/)
  })

  test('digest: file mức cố định gắn format, mẫu 9 cột giữ NGUYÊN chuỗi cũ (preview cũ không bị vô hiệu)', () => {
    const v = { mode: 'replace' as const, catalogTarget: null, groupsOk: [] }
    expect(JSON.parse(canonicalCmsImport(v))).not.toHaveProperty('format')
    expect(canonicalCmsImport(v)).toBe(canonicalCmsImport(v, 'tiers'))
    expect(JSON.parse(canonicalCmsImport(v, 'simple')).format).toBe('simple_v1')
  })

  test('workbook stakeholder thật (chỉ đọc, nếu có trên máy Dev): 17 SP, 2014494 = 31410 nguyên, chưa đủ điều kiện ghi (thiếu K / tư vấn)', () => {
    const f = 'C:/Users/Administrator/Downloads/CMS_T11.xlsx'
    test.skip(!fs.existsSync(f), 'không có file operator trên máy')
    const p = parseCmsSimpleXlsx(new Uint8Array(fs.readFileSync(f)))
    if (!p.ok) throw new Error(p.error)
    expect(p.rows.length).toBe(17)
    const r = p.rows.find((x) => x.raw.ProductID === 2014494)!
    expect(r.cells.CMS_VND_SP).toEqual({ kind: 'number', value: 31410 })
    expect(p.supplement).toEqual({ baseQuantity: false, advice: false })
  })

  test('cờ CMS_IMPORT_V2_ENABLED mặc định OFF; chỉ hiệu lực khi CMS_PROGRAM_ENABLED bật', () => {
    expect(cmsImportV2FromEnv({})).toBe(false)
    expect(cmsImportV2FromEnv({ CMS_IMPORT_V2_ENABLED: 'true' })).toBe(false)
    expect(cmsImportV2FromEnv({ CMS_PROGRAM_ENABLED: 'true', CMS_IMPORT_V2_ENABLED: 'TRUE' })).toBe(false)
    expect(cmsImportV2FromEnv({ CMS_PROGRAM_ENABLED: 'true', CMS_IMPORT_V2_ENABLED: 'true' })).toBe(true)
  })
})

// ── S2 kiểm K: port 11 ca phản ví dụ của công cụ r1 (cms-k-check selftest K1…K17, phần logic app) + nhánh app ────────────────────
// r1 (PM 08/11 SIMPLE-P1-1): bằng chứng = CẶP lượng gốc (q, b) + số dòng. `pairs` dựng trực tiếp; `ev` giữ ý đồ các ca port từ r1 bằng
// cách dựng cặp tương đương: (sq, sb) là một cặp hợp lệ; badQ ⇒ cặp quantity 0; badB ⇒ cặp base rỗng; nRatio 2 / rmax ⇒ thêm cặp hệ số rmax.
const pairs = (pid: string, uom: string, ps: [string | null, string | null, number?][]): CmsKEvidenceRow[] =>
  ps.map(([q, b, n]) => ({ productId: pid, uomRaw: uom, q: q === null ? null : u(q), b: b === null ? null : u(b), lines: BigInt(n ?? 1) }))
const ev = (pid: string, uom: string, o: { n?: number; badQ?: number; badB?: number; nRatio?: number; rmin?: string; rmax?: string; sq?: string; sb?: string }): CmsKEvidenceRow[] => [
  ...pairs(pid, uom, [[o.sq ?? '1', o.sb ?? o.rmin ?? '1', o.n ?? 2]]),
  ...(o.badQ ? pairs(pid, uom, [['0', '0', o.badQ]]) : []),
  ...(o.badB ? pairs(pid, uom, [['1', null, o.badB]]) : []),
  ...((o.nRatio ?? 1) > 1 || (o.rmax && o.rmax !== o.rmin) ? pairs(pid, uom, [['1', o.rmax ?? '999', 1]]) : []),
]
const T = (pid: string, unit: string, k: string | null) => ({ productId: pid, unit, k: k === null ? null : u(k) })
const OK = (rows: CmsKEvidenceRow[]) => ({ ok: true as const, asOf: '2026-11-08T00:00:00.000Z', rows })
const cls = (t: ReturnType<typeof T>, rows: CmsKEvidenceRow[]) => cmsKClassify([t], OK(rows))[0]

test.describe('CMS S2 — kiểm K (lõi thuần) @desktop', () => {
  test('K1 K lớn mất chính xác Number: POS 2^53, file 2^53+1 ⇒ LỆCH (BigInt, không float)', () => {
    expect(cls(T('900001', 'hộp', '9007199254740993'), [...ev('900001', 'hộp', { rmin: '9007199254740992', sq: '1', sb: '9007199254740992' })]).status).toBe('MISMATCH')
  })
  test('K3 box / BOX cùng đơn vị chuẩn hoá, hệ số 10 và 100 ⇒ NGUỒN XUNG ĐỘT', () => {
    expect(cls(T('900003', 'box', '10'), [...ev('900003', 'box', { rmin: '10', sq: '1', sb: '10' }), ...ev('900003', 'BOX', { rmin: '100', sq: '1', sb: '100' })]).status).toBe('SOURCE_CONFLICT')
  })
  test('K4 dòng quantity rỗng / 0 dù tỷ lệ phần còn lại = K ⇒ NGUỒN LỖI; base_quantity rỗng ⇒ NGUỒN LỖI', () => {
    expect(cls(T('900004', 'hộp', '20'), [...ev('900004', 'hộp', { badQ: 1, rmin: '20', sq: '2', sb: '40' })]).status).toBe('SOURCE_ERROR')
    expect(cls(T('900004', 'hộp', '20'), [...ev('900004', 'hộp', { badB: 1, rmin: '20', sq: '2', sb: '40' })]).status).toBe('SOURCE_ERROR')
  })
  test('K5 / K6 K hoặc đơn vị khác nhau giữa các dòng cùng ProductID ⇒ không thành mục kiểm (validator loại GROUP_INCONSISTENT)', () => {
    const rows = (k2: number, unit2: string) => [
      { excelRow: 2, cells: { ProductID: { kind: 'number', value: 900005 }, unit_CMS: { kind: 'text', value: 'hộp' }, base_quantity_CMS: { kind: 'number', value: 20 } } },
      { excelRow: 3, cells: { ProductID: { kind: 'number', value: 900005 }, unit_CMS: { kind: 'text', value: unit2 }, base_quantity_CMS: { kind: 'number', value: k2 } } },
    ] as unknown as Parameters<typeof cmsKTargets>[0]
    expect(cmsKTargets(rows(30, 'hộp'))).toEqual([])
    expect(cmsKTargets(rows(20, 'chai'))).toEqual([])
    expect(cmsKTargets(rows(20, ' HỘP '))).toEqual([{ productId: '900005', unit: 'hộp', k: u('20') }])
  })
  test('K11 nhiều hệ số ⇒ NGUỒN LỖI; K12 (r1) hai dòng LỆCH NHỎ BÙ NHAU (PM SIMPLE-P1-1) ⇒ NGUỒN LỖI, không KHỚP / không đề xuất', () => {
    expect(cls(T('900011', 'hộp', '20'), [...ev('900011', 'hộp', { nRatio: 2, rmin: '20', rmax: '30', sq: '2', sb: '40' })]).status).toBe('SOURCE_ERROR')
    // Phản ví dụ PM: 10 / 300.000000001 và 10 / 299.999999999 — tỷ lệ làm tròn scale 9 đều = 30, ΣB = 600 = 30 × Σq 20.
    const bu = pairs('900012', 'hộp', [['10', '300.000000001'], ['10', '299.999999999']])
    expect(cls(T('900012', 'hộp', '30'), bu)).toMatchObject({ status: 'SOURCE_ERROR', ok: false })
    expect(cls(T('900012', 'hộp', null), bu)).toMatchObject({ status: 'SOURCE_ERROR', proposedK: null, ok: false })
    // Một dòng lệch duy nhất (một cặp) ⇒ LỆCH, không KHỚP.
    expect(cls(T('900012', 'hộp', '30'), pairs('900012', 'hộp', [['10', '300'], ['10', '300.000000001']])).status).toBe('SOURCE_ERROR')
    expect(cls(T('900012', 'hộp', '30'), pairs('900012', 'hộp', [['10', '300.000000001']])).status).toBe('MISMATCH')
  })
  test('K13 / K14 KHỚP (K nguyên có thêm đơn vị viên; K thập phân 2,5); K15 lệch thật', () => {
    expect(cls(T('900013', 'hộp', '20'), [...ev('900013', 'hộp', { rmin: '20', sq: '3', sb: '60' }), ...ev('900013', 'viên', { rmin: '1', sq: '7', sb: '7' })])).toMatchObject({ status: 'MATCH', ok: true })
    expect(cls(T('900014', 'chai', '2.5'), [...ev('900014', 'chai', { rmin: '2.5', sq: '2', sb: '5' })])).toMatchObject({ status: 'MATCH', ok: true })
    expect(cls(T('900015', 'hộp', '10'), [...ev('900015', 'hộp', { rmin: '20', sq: '1', sb: '20' })])).toMatchObject({ status: 'MISMATCH', ok: false })
  })
  test('K16 chưa bán / K17 chỉ bán viên chưa bán hộp ⇒ CHƯA CÓ BẰNG CHỨNG (không K = 1, không kết luận lệch)', () => {
    expect(cls(T('900016', 'hộp', '20'), [])).toMatchObject({ status: 'NO_EVIDENCE', ok: false })
    const r = cls(T('900017', 'hộp', '30'), [...ev('900017', 'viên', { rmin: '1', sq: '3', sb: '3' })])
    expect(r).toMatchObject({ status: 'NO_EVIDENCE', ok: false })
    expect(r.note).toContain('đã bán: viên')
  })
  test('K trống + bằng chứng duy nhất hợp lệ ⇒ ĐỀ XUẤT (không tự điền, không ghi được); nguồn lỗi ⇒ KHÔNG KIỂM ĐƯỢC cho mọi SP', () => {
    expect(cls(T('900020', 'hộp', null), [...ev('900020', 'hộp', { rmin: '24', sq: '2', sb: '48' })])).toMatchObject({ status: 'PROPOSED', proposedK: '24', ok: false })
    // r1: hệ số 1 / 3 không biểu diễn đúng bằng 9 chữ số lẻ ⇒ KHÔNG đề xuất (không làm tròn), không ghi được.
    expect(cls(T('900020', 'hộp', null), pairs('900020', 'hộp', [['3', '1'], ['6', '2']]))).toMatchObject({ status: 'NO_EVIDENCE', proposedK: null, ok: false })
    expect(cls(T('900020', 'hộp', null), pairs('900020', 'hộp', [['2', '47']]))).toMatchObject({ status: 'PROPOSED', proposedK: '23.5' })
    expect(cmsKClassify([T('900021', 'hộp', '10')], { ok: false, reason: 'SOURCE_TIMEOUT' })[0]).toMatchObject({ status: 'UNAVAILABLE', ok: false })
  })

  test('xác nhận tay: chỉ CHƯA CÓ BẰNG CHỨNG / KHÔNG KIỂM ĐƯỢC có K, đúng SP + đơn vị + K; actor / giờ do server gắn; LỆCH / NGUỒN không bao giờ', () => {
    const targets = [T('900030', 'hộp', '10'), T('900031', 'hộp', '10'), T('900032', 'hộp', '10'), T('900033', 'hộp', null)]
    const evd = OK([...ev('900031', 'hộp', { rmin: '12', sq: '1', sb: '12' }), ...ev('900032', 'hộp', { badQ: 1, rmin: '10', sq: '1', sb: '10' })])
    const before = cmsKClassify(targets, evd)
    expect(before.map((x) => x.status)).toEqual(['NO_EVIDENCE', 'MISMATCH', 'SOURCE_ERROR', 'NO_EVIDENCE'])
    const inputs = cmsParseKAckInput(JSON.stringify([
      { product_id: '900030', unit: ' Hộp ', k: '10.0', source: 'Quy cách NCC 05/11' },
      { product_id: '900031', unit: 'hộp', k: '10', source: 'cố bỏ lệch' },
      { product_id: '900032', unit: 'hộp', k: '10', source: 'cố bỏ nguồn lỗi' },
      { product_id: '900033', unit: 'hộp', k: '10', source: 'K trống trong file' },
    ]))!
    const acks = cmsBindKAcks(inputs, before, 'actor-from-session', '2026-11-08T01:00:00.000Z')
    expect(acks).toEqual([{ productId: '900030', unit: 'hộp', k: '10', source: 'Quy cách NCC 05/11', actor: 'actor-from-session', at: '2026-11-08T01:00:00.000Z', status: 'NO_EVIDENCE' }])
    const after = cmsKClassify(targets, evd, acks)
    expect(after.map((x) => [x.status, x.ok, x.ack?.source ?? null])).toEqual([
      ['NO_EVIDENCE', true, 'Quy cách NCC 05/11'], ['MISMATCH', false, null], ['SOURCE_ERROR', false, null], ['NO_EVIDENCE', false, null],
    ])
    // Xác nhận sai K / đơn vị ⇒ không áp.
    expect(cmsBindKAcks(cmsParseKAckInput(JSON.stringify([{ product_id: '900030', unit: 'hộp', k: '12', source: 'sai K' }]))!, before, 'a', 't')).toEqual([])
    expect(cmsBindKAcks(cmsParseKAckInput(JSON.stringify([{ product_id: '900030', unit: 'chai', k: '10', source: 'sai đơn vị' }]))!, before, 'a', 't')).toEqual([])
    // Đọc lại bản lưu: thiếu trường / status lạ ⇒ bỏ.
    expect(cmsStoredKAcks([...acks, { productId: '1', unit: 'hộp', k: '1', source: 'x', actor: 'a', at: 't', status: 'MATCH' }, null, 'x'])).toEqual(acks)
  })
  test('ý định xác nhận sai dạng ⇒ null (route 400): nguồn < 3 / > 200 ký tự, K ≤ 0, ProductID hỏng, không phải mảng', () => {
    for (const bad of ['{', '{}', JSON.stringify([{ product_id: 'x', unit: 'hộp', k: '1', source: 'abc' }]), JSON.stringify([{ product_id: '1', unit: 'hộp', k: '0', source: 'abc' }]),
      JSON.stringify([{ product_id: '1', unit: 'hộp', k: '1', source: 'ab' }]), JSON.stringify([{ product_id: '1', unit: 'hộp', k: '1', source: 'x'.repeat(201) }]), JSON.stringify([{ product_id: '1', unit: '', k: '1', source: 'abc' }])]) {
      expect(cmsParseKAckInput(bad), bad.slice(0, 40)).toBeNull()
    }
    expect(cmsParseKAckInput(null)).toEqual([])
    expect(cmsParseKAckInput(JSON.stringify([{ product_id: '0900030', unit: 'Hộp\u0007', k: '10.50', source: '  NCC\n05/11 ' }]))).toEqual([{ productId: '900030', unit: 'hộp', k: '10.5', source: 'NCC 05/11' }])
  })

  test('áp kết quả K lên validator: nhóm hợp lệ chưa đạt K ⇒ loại kèm K_*; nhóm thiếu K có đề xuất ⇒ thêm thông tin; thống kê tính lại', () => {
    const p = parseCmsSimpleXlsx(wb([H9, [900101, 'x', 'B', 'hộp', 1, 58000, 0, 30, ADV], [900102, 'x', 'B', 'chai', 1, 24000, 0, null, ADV], [900103, 'x', 'B', 'hộp', 1, 31410, 0, 12, ADV]]))
    if (!p.ok) throw new Error(p.error)
    const v = validateCmsSimpleImport(p.rows, ctx())
    expect(v.groupsOk.map((g) => g.productId)).toEqual(['900101', '900103'])
    const res = cmsKClassify(cmsKTargets(p.rows), OK([...ev('900101', 'Hộp', { rmin: '30', sq: '2', sb: '60' }), ...ev('900102', 'chai', { rmin: '1', sq: '6', sb: '6' }), ...ev('900103', 'hộp', { rmin: '10', sq: '1', sb: '10' })]))
    const a = cmsApplyKCheck(v, p.rows, res)
    expect(a.groupsOk.map((g) => g.productId)).toEqual(['900101'])
    const codes = Object.fromEntries(a.groupsRejected.map((g) => [g.key, g.errors.map((e) => e.code)]))
    expect(codes['900102']).toEqual(['BASE_QTY_REQUIRED', 'K_PROPOSED'])
    expect(codes['900103']).toEqual(['K_MISMATCH'])
    expect(a.stats).toMatchObject({ rowsOk: 1, rowsRejected: 2, productsOk: 1, productsRejected: 2 })
  })
})

// ── S2 nguồn bằng chứng BigQuery: tham số hoá, dry-run trước, trần byte / dòng / hạn, fail-closed ──────────────────────────────
test.describe('CMS S2 — nguồn kiểm K (BigQuery) @desktop', () => {
  const RES = (rows: Record<string, string | null>[], o: { fields?: string[]; total?: number } = {}) => ({
    rows, fields: o.fields ?? ['pid', 'uom', 'q_raw', 'b_raw', 'n_lines'],
    totalRows: o.total ?? rows.length, jobId: 'j', pages: 1, totalBytesProcessed: 10,
  })
  const row = (o: Record<string, string | null> = {}) => ({ pid: '900101', uom: 'Hộp', q_raw: '3', b_raw: '90', n_lines: '3', ...o })
  function io(o: { bytes?: number; dryErr?: Error; runErr?: Error; res?: ReturnType<typeof RES> } = {}) {
    const calls: { kind: string; sql: string; params: unknown; opts?: unknown }[] = []
    let t = 1_000_000
    const x: CmsKProbeIo = {
      now: () => (t += 5),
      async dryRun(sql, params) { calls.push({ kind: 'dry', sql, params }); if (o.dryErr) throw o.dryErr; return o.bytes ?? 1000 },
      async run(sql, params, opts) { calls.push({ kind: 'run', sql, params, opts }); if (o.runErr) throw o.runErr; return o.res ?? RES([row()]) },
    }
    return { x, calls }
  }
  test('SQL chỉ nội suy tên view đã validate; ProductID / mốc / trần là THAM SỐ; view sai dạng ⇒ CONFIG không gọi BQ', async () => {
    const q = buildCmsKEvidenceQuery('qa-project.dataset.cms_sales', ['900101', '900101', '15831'], '2025-11-07T00:00:00.000Z')
    expect(q.sql).toContain('FROM `qa-project.dataset.cms_sales`')
    expect(q.sql).not.toMatch(/900101|15831|2025-11/)
    // r1: không chia / làm tròn tỷ lệ ở SQL — trả cặp lượng gốc dạng chuỗi.
    expect(q.sql).not.toMatch(/SAFE_DIVIDE|SAFE_CAST|MIN\(|MAX\(|DISTINCT/)
    expect(q.sql).toMatch(/GROUP BY pid, uom, q_raw, b_raw/)
    expect(q.params).toEqual([
      { name: 'from_ts', type: 'TIMESTAMP', value: '2025-11-07T00:00:00.000Z' },
      { name: 'product_ids', type: 'ARRAY', arrayType: 'STRING', values: ['15831', '900101'] },
      { name: 'row_limit', type: 'INT64', value: 10_001 },
    ])
    const a = io()
    expect(await fetchCmsKEvidence(a.x, { table: 'qa-project.dataset.cms_sales`; DROP', productIds: ['1'] })).toEqual({ ok: false, reason: 'CONFIG' })
    expect(await fetchCmsKEvidence(a.x, { table: null, productIds: ['1'] })).toEqual({ ok: false, reason: 'CONFIG' })
    expect(a.calls).toEqual([])
  })
  test('dry-run trước: vượt trần byte ⇒ BYTE_CAP và KHÔNG chạy thật; dưới trần ⇒ chạy với maximumBytesBilled = trần + trần dòng', async () => {
    const big = io({ bytes: CMS_K_BYTES_CAP + 1 })
    expect(await fetchCmsKEvidence(big.x, { table: 'qa-project.dataset.cms_sales', productIds: ['900101'] })).toEqual({ ok: false, reason: 'BYTE_CAP' })
    expect(big.calls.map((c) => c.kind)).toEqual(['dry'])
    const ok = io()
    const r = await fetchCmsKEvidence(ok.x, { table: 'qa-project.dataset.cms_sales', productIds: ['900101'] })
    expect(r.ok).toBe(true)
    expect(ok.calls.map((c) => c.kind)).toEqual(['dry', 'run'])
    expect(ok.calls[1].opts).toMatchObject({ maxRows: 10_000, maximumBytesBilled: CMS_K_BYTES_CAP })
    if (r.ok) expect(r.rows[0]).toEqual({ productId: '900101', uomRaw: 'Hộp', q: u('3'), b: u('90'), lines: BigInt(3) })
  })
  test('lỗi / sai dạng ⇒ KHÔNG KIỂM ĐƯỢC với mã cố định (không message thô): http, timeout, thiếu cột, thiếu trang, số hỏng', async () => {
    const cases: [ReturnType<typeof io>, string][] = [
      [io({ dryErr: new BigQueryError('http', 'BigQuery HTTP 403: secret detail', 403) }), 'SOURCE_HTTP'],
      [io({ runErr: new BigQueryError('timeout', 'x') }), 'SOURCE_TIMEOUT'],
      [io({ res: RES([row()], { fields: ['pid', 'uom'] }) }), 'SOURCE_SCHEMA'],
      [io({ res: RES([row()], { total: 2 }) }), 'SOURCE_INCOMPLETE'],
      [io({ res: RES([row({ n_lines: '0' })]) }), 'SOURCE_MALFORMED'],
      [io({ res: RES([row({ n_lines: '1.5' })]) }), 'SOURCE_MALFORMED'],
      [io({ res: RES([row({ pid: 'abc' })]) }), 'SOURCE_MALFORMED'],
    ]
    for (const [a, reason] of cases) expect(await fetchCmsKEvidence(a.x, { table: 'qa-project.dataset.cms_sales', productIds: ['900101'] })).toEqual({ ok: false, reason })
    // Ô lượng không đọc được / > 9 chữ số lẻ ⇒ q / b = null (dòng lỗi của SP — classifier NGUỒN LỖI), KHÔNG làm tròn, không hỏng cả lần đọc.
    expect(normalizeCmsKEvidenceRow(row({ q_raw: '3,0' }))).toMatchObject({ q: null, b: u('90') })
    expect(normalizeCmsKEvidenceRow(row({ b_raw: '300.0000000001' }))).toMatchObject({ q: u('3'), b: null })
    expect(normalizeCmsKEvidenceRow(row({ b_raw: '3e2' }))).toMatchObject({ b: null })
    expect(normalizeCmsKEvidenceRow(row({ q_raw: null, b_raw: null }))).toMatchObject({ q: null, b: null })
  })
  test('client BigQuery dùng chung: maximumBytesBilled vào jobs.query; dry-run gửi dryRun và đọc totalBytesProcessed; tương thích ngược', async () => {
    const bodies: unknown[] = []
    const tr = (resp: unknown): BqTransport => ({
      fetch: (async (_u: string, init: { body?: string }) => { bodies.push(JSON.parse(init.body ?? 'null')); return new Response(JSON.stringify(resp), { status: 200 }) }) as unknown as typeof fetch,
      getToken: async () => 't', now: () => 0, sleep: async () => {},
    })
    await bqQueryAll(tr({ jobReference: { jobId: 'j' }, jobComplete: true, schema: { fields: [{ name: 'a' }] }, rows: [], totalRows: '0' }), { projectId: 'p', sql: 'select 1', maximumBytesBilled: 2_000_000_000 })
    await bqQueryAll(tr({ jobReference: { jobId: 'j' }, jobComplete: true, schema: { fields: [{ name: 'a' }] }, rows: [], totalRows: '0' }), { projectId: 'p', sql: 'select 1' })
    expect((bodies[0] as Record<string, unknown>).maximumBytesBilled).toBe('2000000000')
    expect(bodies[1]).not.toHaveProperty('maximumBytesBilled')
    expect(await bqDryRunBytes(tr({ totalBytesProcessed: '12345' }), { projectId: 'p', sql: 'select 1' })).toBe(12345)
    expect((bodies[2] as Record<string, unknown>).dryRun).toBe(true)
    await expect(bqDryRunBytes(tr({}), { projectId: 'p', sql: 'select 1' })).rejects.toMatchObject({ kind: 'malformed' })
    await expect(bqQueryAll(tr({}), { projectId: 'p', sql: 'select 1', maximumBytesBilled: 0 })).rejects.toMatchObject({ kind: 'config' })
  })
})

// ── Route: preview / commit với loại file + kiểm K ───────────────────────────────────────────────────────────────────────────
const NOW = new Date('2026-11-10T03:00:00Z')
const PROG = '00000000-0000-4000-8000-000000000001'
const ACTOR = '00000000-0000-4000-8000-0000000000aa'
class Repo implements CmsImportRepo {
  program: CmsProgramRow = { id: PROG, status: 'draft', startDate: '2026-11-20', endDate: '2026-12-31', isTest: false, configVersion: 1, catalogTargetGmv: null }
  runs = new Map<string, CmsImportRunRow>()
  commits: CmsImportPayload[] = []
  private seq = 0
  async getProgram(id: string) { return id === PROG ? this.program : null }
  async loadContext() { return { productMaster: PM, existingProductIds: new Set<string>(), conflictProductIds: new Set<string>() } }
  async savePreview(i: Parameters<CmsImportRepo['savePreview']>[0]) {
    const id = `00000000-0000-4000-9000-${String(++this.seq).padStart(12, '0')}`
    this.runs.set(id, { id, programId: i.programId, mode: i.mode, status: 'previewed', fileSha256: i.sha256, configVersionAtPreview: 1, result: JSON.parse(JSON.stringify(i.result)) })
    return id
  }
  async commit(i: Parameters<CmsImportRepo['commit']>[0]) {
    const run = this.runs.get(i.runId)!
    if (run.result.digest !== i.digest) throw new CmsRepoError('CMS_IMPORT_CONFLICT')
    run.status = 'committed'; this.commits.push(i.payload)
    return { already: false, mode: run.mode, products: i.payload.products.length }
  }
  async getRun(id: string) { return this.runs.get(id) ?? null }
}
function deps(o: { v2?: boolean; evidence?: () => CmsKEvidence } = {}) {
  const repo = new Repo()
  const probes: string[][] = []
  const d: CmsImportDeps & { repo: Repo } = {
    enabled: true, v2: o.v2 ?? true, repo, now: () => NOW,
    async getAccess() { return { kind: 'ok', actorId: ACTOR, qa: false } },
    kProbe: async (ids) => { probes.push(ids); return o.evidence ? o.evidence() : OK([...ev('900101', 'hộp', { rmin: '30', sq: '1', sb: '30' })]) },
  }
  return Object.assign(d, { probes })
}
async function mp(url: string, fields: Record<string, string>, bytes: Uint8Array) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  fd.append('file', new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'muc-co-dinh.xlsx')
  const tmp = new Response(fd)
  const body = new Uint8Array(await tmp.arrayBuffer())
  return new Request(url, { method: 'POST', body, headers: { 'content-type': tmp.headers.get('content-type')!, 'content-length': String(body.byteLength) } })
}
async function shaHex(b: Uint8Array) { const h = await crypto.subtle.digest('SHA-256', b.slice().buffer as ArrayBuffer); return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('') }
const SIMPLE = wb([H9, [900101, 'Viên sắt mẫu hộp 30 viên', 'B', 'hộp', 1, 58000, 0, 30, ADV], [900102, 'Siro kẽm mẫu chai 100ml', 'B', 'chai', 1, 24000, 0, 1, ADV]])
const pv = (d: CmsImportDeps, f: Record<string, string>, b = SIMPLE) => mp('http://x/api/cms/import/preview', { program_id: PROG, ...f }, b).then((r) => handleCmsImportPreview(r, d))
const cm = async (d: CmsImportDeps, runId: string, f: Record<string, string> = {}, b = SIMPLE) => handleCmsImportCommit(await mp('http://x/api/cms/import/commit', { run_id: runId, sha256: await shaHex(b), ...f }, b), d)
const J = async (r: Response) => r.json() as Promise<Record<string, any>>

test.describe('CMS S1 + S2 — route import (loại file + kiểm K) @desktop', () => {
  test('cờ v2 OFF: format=simple ⇒ 400 FORMAT_UNAVAILABLE; k_acks ⇒ 400; mặc định 9 cột như cũ (run không có format / kCheck, không gọi BQ)', async () => {
    const d = deps({ v2: false })
    expect([(await pv(d, { format: 'simple' })).status, (await J(await pv(d, { format: 'simple' }))).code]).toEqual([400, 'FORMAT_UNAVAILABLE'])
    expect((await J(await pv(d, { k_acks: JSON.stringify([{ product_id: '1', unit: 'hộp', k: '1', source: 'abc' }]) }))).code).toBe('K_ACK_INVALID')
    expect((await J(await pv(d, { format: 'xlsx' }))).code).toBe('BAD_REQUEST')
    const nine = wb([[...CMS_IMPORT_COLUMNS], [900101, null, null, 1, null, 1000, ADV, 'hộp', 30]], 'IMPORT_CMS')
    const r = await J(await pv(d, {}, nine))
    expect(r.ok).toBe(true)
    expect(r).not.toHaveProperty('kCheck')
    const run = d.repo.runs.get(r.runId)!
    expect(run.result).not.toHaveProperty('format')
    expect(run.result).not.toHaveProperty('kCheck')
    expect(d.probes).toEqual([])
  })

  test('v2 ON, file mức cố định: preview lưu format + kiểm K (KHỚP ghi được, CHƯA CÓ BẰNG CHỨNG chặn); commit ghi đúng 1 SP 1 bậc', async () => {
    const d = deps()
    const r = await J(await pv(d, { format: 'simple' }))
    expect(r.format).toBe('simple')
    expect(r.kCheck.products.map((x: any) => [x.productId, x.status, x.ok])).toEqual([['900101', 'MATCH', true], ['900102', 'NO_EVIDENCE', false]])
    expect(r.groupsOk.map((g: any) => g.productId)).toEqual(['900101'])
    expect(r.groupsRejected[0].errors.map((e: any) => e.code)).toEqual(['K_NO_EVIDENCE'])
    expect(d.repo.runs.get(r.runId)!.result).toMatchObject({ format: 'simple', kAcks: [] })
    const c = await cm(d, r.runId, { format: 'simple' })
    expect(c.status).toBe(200)
    expect(d.repo.commits[0].products.map((p) => [p.product_id, p.gmv_basis, p.target_gmv, p.tiers])).toEqual([['900101', 'none', null, [{ order: 1, from: 1, to: null, amount: '58000' }]]])
    expect(d.probes.length).toBe(2)
  })

  test('xác nhận tay ở preview: actor = PHIÊN (không nhận từ client), giờ server, lưu trong run; commit đọc lại từ run, k_acks gửi kèm commit bị bỏ qua', async () => {
    const d = deps()
    const acks = JSON.stringify([{ product_id: '900102', unit: 'chai', k: '1', source: 'Quy cách NCC (mẫu)', actor: 'GIẢ-MẠO' }])
    const r = await J(await pv(d, { format: 'simple', k_acks: acks }))
    expect(r.groupsOk.map((g: any) => g.productId)).toEqual(['900101', '900102'])
    expect(d.repo.runs.get(r.runId)!.result.kAcks).toEqual([{ productId: '900102', unit: 'chai', k: '1', source: 'Quy cách NCC (mẫu)', actor: ACTOR, at: NOW.toISOString(), status: 'NO_EVIDENCE' }])
    const c = await cm(d, r.runId, { format: 'simple', k_acks: '[]' })
    expect(c.status).toBe(200)
    expect(d.repo.commits[0].products.map((p) => p.product_id)).toEqual(['900101', '900102'])
  })

  test('commit kiểm lại nguồn: cùng K vẫn hợp lệ (CHƯA CÓ BẰNG CHỨNG đã xác nhận → nay KHỚP) ⇒ không ép preview lại; nguồn mới xung đột ⇒ 409', async () => {
    let evd: CmsKEvidence = OK([...ev('900101', 'hộp', { rmin: '30', sq: '1', sb: '30' })])
    const d = deps({ evidence: () => evd })
    const r = await J(await pv(d, { format: 'simple', k_acks: JSON.stringify([{ product_id: '900102', unit: 'chai', k: '1', source: 'NCC (mẫu)' }]) }))
    evd = OK([...ev('900101', 'hộp', { rmin: '30', n: 5, sq: '2', sb: '60' }), ...ev('900102', 'chai', { rmin: '1', sq: '3', sb: '3' })])
    expect((await cm(d, r.runId, { format: 'simple' })).status).toBe(200)
    const d2 = deps({ evidence: () => evd })
    evd = OK([...ev('900101', 'hộp', { rmin: '30', sq: '1', sb: '30' })])
    const r2 = await J(await pv(d2, { format: 'simple' }))
    evd = OK([...ev('900101', 'hộp', { rmin: '30', sq: '1', sb: '30' }), ...ev('900101', 'HỘP', { rmin: '24', sq: '1', sb: '24' })])
    const c2 = await cm(d2, r2.runId, { format: 'simple' })
    expect([c2.status, (await J(c2)).code]).toEqual([409, 'PREVIEW_STALE'])
    expect(d2.repo.commits).toEqual([])
  })

  test('BigQuery lỗi lúc commit: SP KHỚP ở preview mà không có xác nhận ⇒ 409; có xác nhận tay đã lưu ⇒ vẫn ghi (nhánh manual)', async () => {
    let evd: CmsKEvidence = OK([...ev('900101', 'hộp', { rmin: '30', sq: '1', sb: '30' })])
    const d = deps({ evidence: () => evd })
    const r = await J(await pv(d, { format: 'simple' }))
    evd = { ok: false, reason: 'SOURCE_TIMEOUT' }
    expect((await J(await cm(d, r.runId, { format: 'simple' }))).code).toBe('PREVIEW_STALE')
    const d2 = deps({ evidence: () => ({ ok: false, reason: 'SOURCE_HTTP' }) })
    const acks = JSON.stringify([{ product_id: '900101', unit: 'hộp', k: '30', source: 'NCC (mẫu)' }, { product_id: '900102', unit: 'chai', k: '1', source: 'NCC (mẫu)' }])
    const r2 = await J(await pv(d2, { format: 'simple', k_acks: acks }))
    expect(r2.kCheck).toMatchObject({ available: false, reason: 'SOURCE_HTTP' })
    expect(r2.kCheck.products.map((x: any) => [x.status, x.ok])).toEqual([['UNAVAILABLE', true], ['UNAVAILABLE', true]])
    expect((await cm(d2, r2.runId, { format: 'simple' })).status).toBe(200)
  })

  test('commit theo loại file ĐÃ LƯU: client gửi loại khác ⇒ 409; cờ v2 đổi giữa preview và commit ⇒ 409', async () => {
    const d = deps()
    const r = await J(await pv(d, { format: 'simple' }))
    expect((await J(await cm(d, r.runId, { format: 'tiers' }))).code).toBe('PREVIEW_STALE')
    d.v2 = false
    expect((await J(await cm(d, r.runId))).code).toBe('PREVIEW_STALE')
    const d2 = deps({ v2: false })
    const nine = wb([[...CMS_IMPORT_COLUMNS], [900101, null, null, 1, null, 1000, ADV, 'hộp', 30]], 'IMPORT_CMS')
    const r2 = await J(await pv(d2, {}, nine))
    d2.v2 = true
    expect((await J(await cm(d2, r2.runId, {}, nine))).code).toBe('PREVIEW_STALE')
  })

  test('file lỗi của lần kiểm mức cố định = bố cục mức cố định; lỗi header trả tên cột trùng', async () => {
    const d = deps()
    const r = await J(await pv(d, { format: 'simple' }))
    const e = await handleCmsImportErrors(new Request(`http://x/api/cms/import/errors?run_id=${r.runId}`), d)
    expect(e.status).toBe(200)
    const x = XLSX.read(new Uint8Array(await e.arrayBuffer()), { type: 'array' })
    expect(x.SheetNames).toEqual([CMS_SIMPLE_SHEET])
    const dup = await J(await pv(d, { format: 'simple' }, wb([[...H7, 'CMS proposal'], [900101, 'x', 'B', 'hộp', 1, 1000, 0, 1000]])))
    expect([dup.code, dup.duplicate]).toEqual(['DUPLICATE_COLUMNS', ['CMS proposal']])
  })
})

// ── S2 chẩn đoán held: ngữ cảnh trước khi bỏ dòng, ≤ 20 nhóm, ≤ 8 KiB, không PII ─────────────────────────────────────────────
test.describe('CMS S2 — chẩn đoán dòng nguồn bị loại @desktop', () => {
  const raw = (o: Record<string, string | null>) => ({
    order_line_id: 'L1', order_id: 'O1', order_code: 'HD-SECRET-1', product_id: '900101', seller_email: 'secret.person@example.test', pos_code: 'P',
    order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: '2026-11-05T01:00:00.000000Z', quantity_raw: '1', uom_raw: 'Hộp',
    base_quantity: '30', gmv_amount: '1000', source_updated_at: '2026-11-05T02:00:00.000000Z', ...o,
  })
  const bad = (o: Record<string, string | null>) => { const r = raw(o); const n = normalizeSalesRow(r); if (n.ok) throw new Error('phải lỗi'); return { ctx: cmsRowIssueContext(r), issues: n.issues } }
  test('base_quantity thiếu ⇒ mã base_quantity:MISSING_FIELD theo ProductID × đơn vị; ProductID hỏng ⇒ null (nhãn cố định); không email / mã đơn', () => {
    const s = cmsSummarizeRowIssues([bad({ base_quantity: null }), bad({ base_quantity: null, uom_raw: ' HỘP ' }), bad({ base_quantity: null, uom_raw: 'Viên' }), bad({ product_id: 'SKU-1' }), bad({ completed_at: 'x' })])
    expect(s).toEqual({ v: 1, rows: 5, truncated: 0, groups: [
      { productId: '900101', uom: 'hộp', code: 'base_quantity:MISSING_FIELD', rows: 2 },
      { productId: '900101', uom: 'hộp', code: 'completed_at:BAD_TIMESTAMP', rows: 1 },
      { productId: '900101', uom: 'viên', code: 'base_quantity:MISSING_FIELD', rows: 1 },
      { productId: null, uom: 'hộp', code: 'product_id:BAD_PRODUCT_ID', rows: 1 },
    ] })
    const enc = cmsEncodeUnitIssueSummary(s)
    expect(enc).not.toMatch(/secret|HD-SECRET|SKU-1/)
    expect(cmsDecodeUnitIssueSummary(enc)).toEqual(s)
  })
  test('> 20 nhóm ⇒ giữ 20 nhóm nhiều dòng nhất + đếm số nhóm rút gọn; mã hoá ≤ 8 KiB kể cả đơn vị dài; đọc lại hỏng ⇒ null', () => {
    const items = Array.from({ length: 45 }, (_, i) => bad({ product_id: String(900000 + i), base_quantity: null, uom_raw: `Đơn vị rất dài ${'x'.repeat(60)} ${i}` }))
    const s = cmsSummarizeRowIssues([...items, bad({ product_id: '900001', base_quantity: null, uom_raw: `Đơn vị rất dài ${'x'.repeat(60)} 1` })])
    expect(s.groups.length).toBe(20)
    expect(s.truncated).toBe(25)
    expect(s.groups[0]).toMatchObject({ productId: '900001', rows: 2 })
    expect(s.groups.every((g) => (g.uom ?? '').length <= 31)).toBe(true)
    const enc = cmsEncodeUnitIssueSummary(s)
    expect(new TextEncoder().encode(enc).byteLength).toBeLessThanOrEqual(CMS_UNIT_ISSUE_MAX_BYTES)
    for (const broken of ['{', '[]', JSON.stringify({ v: 2, rows: 1, truncated: 0, groups: [] }), JSON.stringify({ v: 1, rows: 1, truncated: 0, groups: [{ productId: 'abc', uom: null, code: 'x:Y', rows: 1 }] }),
      JSON.stringify({ v: 1, rows: 1, truncated: 0, groups: [{ productId: null, uom: 'a\u0001', code: 'base_quantity:MISSING_FIELD', rows: 1 }] }), 'x'.repeat(9000)]) {
      expect(cmsDecodeUnitIssueSummary(broken)).toBeNull()
    }
  })
})

// ── S2 tích hợp lõi đồng bộ bán: lượt held vì dòng lỗi ⇒ detail run có chẩn đoán đã mã hoá; guard held toàn run giữ nguyên ─────
test.describe('CMS S2 — chẩn đoán trong lượt đồng bộ bán (deps giả) @desktop', () => {
  const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const snap = {
    program_id: uid(1), status: 'active', is_test: true, config_version: 3, start_date: '2026-11-05', end_date: '2026-11-06',
    catalog_target_gmv: null, today_vn: '2026-11-07', current_result_run_id: null, previous_rows_read: null, store_ids: [uid(11)],
    products: [{ id: uid(31), product_id: '900001', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '24', tiers: [{ order: 1, from: 1, to: null, amount: '10000' }] }],
    sellers: [{ id: uid(21), email: 'ds.a@cms.example.test', role: 'staff', store_id: uid(11) }],
    stores: [{ id: uid(11), store_type: 'os', is_active: true }], mapping_fp: 'a'.repeat(32),
  }
  function fake(sales: ReturnType<typeof fxSale>[]) {
    const finishes: { status: string; detail: Record<string, unknown> }[] = []
    let t = 1_000_000
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deps: any = {
      table: 'qa-project.dataset.cms_sales', runner: createCmsFixtureRunner({ sales }),
      loadSnapshot: async () => snap, openRun: async () => ({ ...snap, run_id: uid(99) }),
      stage: async (_r: string, _p: string, _n: number, rows: unknown[]) => rows.length,
      sealBegin: async () => ({ ok: true, steps: 10 }), sealStep: async (_r: string, n: number) => (n === 10 ? { sealed: true, step: 10 } : { ok: true, step: n }),
      publish: async () => ({ published: true, already: false }),
      finish: async (_r: string, status: string, detail: Record<string, unknown>) => { finishes.push({ status, detail }) },
      cleanup: async () => ({ purged: 0, deleted: 0, more: false }), now: () => (t += 10),
    }
    return { deps, finishes }
  }
  const IN = (n: number, o: Record<string, string | null> = {}) => fxSale({ order_line_id: `L-${n}`, order_id: `O-${n}`, order_code: `TEST-${n}`, completed_at: `2026-11-05T0${n}:00:00.000000Z`, ...o })
  test('base_quantity rỗng ⇒ held UNCONVERTED_UNITS, KHÔNG publish; detail có unit_issue_summary (≤ 8 KiB, đọc lại được) + đếm; dry-run cũng trả chẩn đoán', async () => {
    const f = fake([IN(1), IN(2, { base_quantity: null, uom_raw: 'Viên' }), IN(3, { base_quantity: null, uom_raw: ' VIÊN ' }), IN(4, { gmv_amount: 'abc' })])
    const r = await runCmsSalesSync(f.deps, uid(1), { dryRun: false, source: 'operator' })
    expect([r.status, r.code]).toEqual(['held', 'UNCONVERTED_UNITS'])
    expect(r.reasons).toEqual(['UNCONVERTED_UNITS', 'ROW_ISSUES'])
    expect(f.finishes.length).toBe(1)
    const d = f.finishes[0].detail
    expect([d.unit_issue_rows, d.unit_issue_groups_truncated]).toEqual([3, 0])
    const s = cmsDecodeUnitIssueSummary(d.unit_issue_summary)
    expect(s?.groups).toEqual([
      { productId: '900001', uom: 'viên', code: 'base_quantity:MISSING_FIELD', rows: 2 },
      { productId: '900001', uom: 'hộp', code: 'gmv_amount:BAD_NUMBER', rows: 1 },
    ])
    expect(JSON.stringify(d)).not.toMatch(/cms\.example\.test|TEST-2|O-2/)
    expect(new TextEncoder().encode(JSON.stringify(d)).byteLength).toBeLessThanOrEqual(16384)
    const dry = await runCmsSalesSync(fake([IN(1), IN(2, { base_quantity: null })]).deps, uid(1), { dryRun: true, source: 'operator' })
    expect([dry.status, dry.unitIssues?.rows]).toEqual(['dry_run', 1])
  })
  test('không có dòng lỗi ⇒ không có trường chẩn đoán', async () => {
    const f = fake([IN(1), IN(2)])
    const r = await runCmsSalesSync(f.deps, uid(1), { dryRun: true, source: 'operator' })
    expect(r.unitIssues ?? null).toBeNull()
  })
})

// ── Bổ sung sau review (security P2-2 / P2-4 / P2-5; pm-auditor P1-2) ─────────────────────────────────────────────────────────
test.describe('CMS S1 + S2 — sau review: đổi giữa preview / commit, đơn vị dài, phản hồi tối thiểu, file lỗi không công thức @desktop', () => {
  test('đổi giữa preview và commit ⇒ 409, 0 ghi: cấu hình chương trình (config_version), Product Master (tên), file (sửa K ⇒ SHA khác)', async () => {
    const d = deps()
    const r = await J(await pv(d, { format: 'simple' }))
    d.repo.program = { ...d.repo.program, configVersion: 2 }
    expect((await J(await cm(d, r.runId, { format: 'simple' }))).code).toBe('PREVIEW_STALE')
    const d2 = deps()
    const r2 = await J(await pv(d2, { format: 'simple' }))
    const old = PM.get('900101')!
    PM.set('900101', { ...old, productName: 'Tên Master đổi sau preview' })
    try {
      expect((await J(await cm(d2, r2.runId, { format: 'simple' }))).code).toBe('PREVIEW_STALE')
    } finally { PM.set('900101', old) }
    const d3 = deps()
    const r3 = await J(await pv(d3, { format: 'simple' }))
    const edited = wb([H9, [900101, 'Viên sắt mẫu hộp 30 viên', 'B', 'hộp', 1, 58000, 0, 31, ADV], [900102, 'Siro kẽm mẫu chai 100ml', 'B', 'chai', 1, 24000, 0, 1, ADV]])
    const res = await handleCmsImportCommit(await mp('http://x/api/cms/import/commit', { run_id: r3.runId, sha256: await shaHex(SIMPLE), format: 'simple' }, edited), d3)
    expect([res.status, (await J(res)).code]).toEqual([409, 'SHA_MISMATCH'])
    expect([...d.repo.commits, ...d2.repo.commits, ...d3.repo.commits]).toEqual([])
  })

  test('đơn vị > 30 ký tự: so khớp K dùng chuỗi chuẩn hoá ĐẦY ĐỦ (hai đơn vị chung tiền tố không bị gộp ⇒ không KHỚP sai); chẩn đoán vẫn cắt để hiển thị', () => {
    const a = 'hộp loại đặc biệt rất dài để thử cắt chuỗi a', b = 'hộp loại đặc biệt rất dài để thử cắt chuỗi b'
    expect(cls(T('900040', a, '10'), [...ev('900040', b, { rmin: '10', sq: '1', sb: '10' })]).status).toBe('NO_EVIDENCE')
    expect(cls(T('900040', a, '10'), [...ev('900040', a.toUpperCase(), { rmin: '10', sq: '1', sb: '10' })]).status).toBe('MATCH')
    const s = cmsSummarizeRowIssues([{ ctx: { productId: '900040', uom: cmsRowIssueContext({ product_id: '900040', uom_raw: a }).uom }, issues: [{ kind: 'MISSING_FIELD', field: 'base_quantity' }] }])
    expect((s.groups[0].uom ?? '').length).toBeLessThanOrEqual(31)
  })

  test('phản hồi preview: xác nhận chỉ trả nguồn + thời điểm (không actor); bản lưu trong run giữ actor', async () => {
    const d = deps()
    const r = await J(await pv(d, { format: 'simple', k_acks: JSON.stringify([{ product_id: '900102', unit: 'chai', k: '1', source: 'NCC (mẫu)' }]) }))
    const ack = r.kCheck.products.find((x: any) => x.productId === '900102').ack
    expect(ack).toEqual({ source: 'NCC (mẫu)', at: NOW.toISOString() })
    expect(JSON.stringify(r)).not.toContain(ACTOR)
    expect(d.repo.runs.get(r.runId)!.result.kAcks![0].actor).toBe(ACTOR)
  })

  test('file lỗi mức cố định: chuỗi bắt đầu "=" ở cột tham khảo / ô công thức không cache ⇒ ô chuỗi, KHÔNG thành công thức', async () => {
    const book = wb([H7, [900102, '=HYPERLINK("http://x.invalid","bấm")', '+cmd', 'chai', { f: 'SUM(1,2)' }, 24000, '@x']])
    const p = parseCmsSimpleXlsx(book)
    if (!p.ok) throw new Error(p.error)
    const v = validateCmsSimpleImport(p.rows, ctx())
    const ws = XLSX.read(buildCmsSimpleErrorXlsx(v.groupsRejected.map((g) => ({ key: g.key, rows: g.rows, errors: g.errors }))), { type: 'array', cellFormula: true }).Sheets[CMS_SIMPLE_SHEET]
    for (const addr of ['B2', 'C2', 'E2', 'G2']) {
      expect(ws[addr]?.t, addr).toBe('s')
      expect(ws[addr]?.f, addr).toBeUndefined()
    }
    expect(ws.B2.v).toBe('=HYPERLINK("http://x.invalid","bấm")')
  })
})

// ── r1 SIMPLE-P1-1 (PM 08/11 audit §3.1): nguồn THÔ → bằng chứng → classifier → preview / commit ─────────────────────────────────
test.describe('CMS S2 r1 — kiểm K chính xác từng cặp lượng gốc, đầu–cuối qua nguồn giả @desktop', () => {
  type Raw = [string, string | null, string | null, number] // [uom, q_raw, b_raw, n_lines]
  const rawIo = (get: () => Record<string, Raw[]>, o: { runErr?: Error; total?: number } = {}): CmsKProbeIo => ({
    now: () => Date.now(),
    async dryRun() { return 1000 },
    async run() {
      if (o.runErr) throw o.runErr
      const rows = Object.entries(get()).flatMap(([pid, rs]) => rs.map(([uom, q, b, n]) => ({ pid, uom, q_raw: q, b_raw: b, n_lines: String(n) })))
      return { rows, fields: ['pid', 'uom', 'q_raw', 'b_raw', 'n_lines'], totalRows: o.total ?? rows.length, jobId: 'j', pages: 1, totalBytesProcessed: 10 }
    },
  })
  const probe = (get: () => Record<string, Raw[]>, o: Parameters<typeof rawIo>[1] = {}) =>
    (ids: string[]) => fetchCmsKEvidence(rawIo(get, o), { table: 'qa-project.dataset.cms_sales', productIds: ids })
  const classify = async (src: Record<string, Raw[]>, t: ReturnType<typeof T>) => cmsKClassify([t], await probe(() => src)([t.productId]))[0]
  type KRow = { productId: string; status: string; ok: boolean; ack: unknown }

  test('phản ví dụ PM: 10 / 300.000000001 + 10 / 299.999999999 (K 30) ⇒ NGUỒN LỖI qua nguồn thô; K trống không đề xuất; xác nhận tay KHÔNG bỏ được', async () => {
    const src: Record<string, Raw[]> = { '900101': [['hộp', '10', '300.000000001', 1], ['hộp', '10', '299.999999999', 1]] }
    expect(await classify(src, T('900101', 'hộp', '30'))).toMatchObject({ status: 'SOURCE_ERROR', ok: false })
    expect(await classify(src, T('900101', 'hộp', null))).toMatchObject({ status: 'SOURCE_ERROR', proposedK: null })
    const d = deps(); d.kProbe = probe(() => src)
    const r = await J(await pv(d, { format: 'simple', k_acks: JSON.stringify([{ product_id: '900101', unit: 'hộp', k: '30', source: 'cố xác nhận tay' }]) }))
    const k = (r.kCheck.products as KRow[]).find((x) => x.productId === '900101')!
    expect([k.status, k.ok, k.ack]).toEqual(['SOURCE_ERROR', false, null])
    expect((r.groupsOk as { productId: string }[]).map((g) => g.productId)).not.toContain('900101')
    const rej = (r.groupsRejected as { key: string; errors: { code: string }[] }[]).find((g) => g.key === '900101')!
    expect(rej.errors.map((e) => e.code)).toEqual(['K_SOURCE_ERROR'])
  })

  test('đúng hoàn toàn (nhiều cặp, cùng hệ số) ⇒ KHỚP; một dòng lệch ⇒ không KHỚP; base > 9 chữ số lẻ / quantity rỗng / dòng âm ⇒ NGUỒN LỖI (không làm tròn)', async () => {
    expect(await classify({ '900101': [['hộp', '1', '30', 5], ['hộp', '2', '60', 3], ['hộp', '0.5', '15', 1]] }, T('900101', 'hộp', '30'))).toMatchObject({ status: 'MATCH', ok: true })
    expect((await classify({ '900101': [['hộp', '1', '30', 5], ['hộp', '1', '30.000000001', 1]] }, T('900101', 'hộp', '30'))).status).toBe('SOURCE_ERROR')
    expect((await classify({ '900101': [['hộp', '1', '30.0000000001', 1]] }, T('900101', 'hộp', '30'))).status).toBe('SOURCE_ERROR')
    expect((await classify({ '900101': [['hộp', '1', '30', 4], ['hộp', '-1', '-30', 1]] }, T('900101', 'hộp', '30'))).status).toBe('SOURCE_ERROR')
    expect((await classify({ '900101': [['hộp', null, '30', 1], ['hộp', '1', '30', 2]] }, T('900101', 'hộp', '30'))).status).toBe('SOURCE_ERROR')
  })

  test('K thập phân 2,5 / K lớn 2^53 + 1 (BigInt) ⇒ KHỚP chính xác; K lớn lệch 1 đơn vị ⇒ LỆCH', async () => {
    expect(await classify({ '900102': [['chai', '2', '5', 3], ['chai', '4', '10', 1]] }, T('900102', 'chai', '2.5'))).toMatchObject({ status: 'MATCH' })
    expect(await classify({ '900102': [['hộp', '1', '9007199254740993', 1]] }, T('900102', 'hộp', '9007199254740993'))).toMatchObject({ status: 'MATCH' })
    expect((await classify({ '900102': [['hộp', '1', '9007199254740992', 1]] }, T('900102', 'hộp', '9007199254740993'))).status).toBe('MISMATCH')
  })

  test('nhiều cách ghi cùng đơn vị: cùng hệ số ⇒ KHỚP; khác hệ số ⇒ NGUỒN XUNG ĐỘT', async () => {
    expect(await classify({ '900101': [['Hộp', '1', '30', 2], ['hộp', '2', '60', 1]] }, T('900101', 'hộp', '30'))).toMatchObject({ status: 'MATCH' })
    expect((await classify({ '900101': [['Hộp', '1', '30', 2], ['HỘP', '1', '24', 1]] }, T('900101', 'hộp', '30'))).status).toBe('SOURCE_CONFLICT')
  })

  test('vượt trần cặp / thiếu trang ⇒ KHÔNG KIỂM ĐƯỢC (không lấy một phần làm KHỚP); preview 0 SP ghi được', async () => {
    const src: Record<string, Raw[]> = { '900101': [['hộp', '1', '30', 1]], '900102': [['chai', '1', '1', 1]] }
    for (const o of [{ runErr: new BigQueryError('row_limit', 'x') }, { total: 99_999 }]) {
      const e = await probe(() => src, o)(['900101'])
      expect(e.ok).toBe(false)
      expect(cmsKClassify([T('900101', 'hộp', '30')], e)[0]).toMatchObject({ status: 'UNAVAILABLE', ok: false })
    }
    const d = deps(); d.kProbe = probe(() => src, { runErr: new BigQueryError('row_limit', 'x') })
    const r = await J(await pv(d, { format: 'simple' }))
    expect(r.kCheck).toMatchObject({ available: false, reason: 'SOURCE_ROW_LIMIT' })
    expect(r.groupsOk).toEqual([])
  })

  test('preview KHỚP từ nguồn đúng → trước commit nguồn thêm hai dòng lệch bù nhau ⇒ commit 409 PREVIEW_STALE, 0 ghi; nguồn chỉ thêm dòng cùng hệ số ⇒ commit được', async () => {
    let src: Record<string, Raw[]> = { '900101': [['hộp', '1', '30', 3]], '900102': [['chai', '1', '1', 2]] }
    const d = deps(); d.kProbe = probe(() => src)
    const r = await J(await pv(d, { format: 'simple' }))
    expect((r.kCheck.products as KRow[]).map((x) => [x.productId, x.status])).toEqual([['900101', 'MATCH'], ['900102', 'MATCH']])
    expect((r.groupsOk as { productId: string }[]).map((g) => g.productId)).toEqual(['900101', '900102'])
    src = { '900101': [['hộp', '1', '30', 3], ['hộp', '10', '300.000000001', 1], ['hộp', '10', '299.999999999', 1]], '900102': [['chai', '1', '1', 2]] }
    const c = await cm(d, r.runId, { format: 'simple' })
    expect([c.status, (await J(c)).code]).toEqual([409, 'PREVIEW_STALE'])
    expect(d.repo.commits).toEqual([])
    src = { '900101': [['hộp', '1', '30', 9], ['hộp', '3', '90', 1]], '900102': [['chai', '1', '1', 2]] }
    expect((await cm(d, r.runId, { format: 'simple' })).status).toBe(200)
    expect(d.repo.commits.length).toBe(1)
  })

  test('P2 dry-run: totalBytesProcessed chỉ nhận chuỗi int64 không âm ("0" hợp lệ); null / "" / bool / số / âm ⇒ malformed; hạn tính cả bước lấy token', async () => {
    const tr = (resp: unknown, o: { tokenMs?: number } = {}): BqTransport => {
      let t = 0
      return {
        fetch: (async () => new Response(JSON.stringify(resp), { status: 200 })) as unknown as typeof fetch,
        getToken: async () => { t += o.tokenMs ?? 0; return 'tok' }, now: () => t, sleep: async () => {},
      }
    }
    expect(await bqDryRunBytes(tr({ totalBytesProcessed: '0' }), { projectId: 'p', sql: 'select 1' })).toBe(0)
    for (const v of [null, '', false, true, 123, '-1', '12a', {}, '99999999999999999999']) {
      await expect(bqDryRunBytes(tr({ totalBytesProcessed: v }), { projectId: 'p', sql: 'select 1' }), JSON.stringify(v)).rejects.toMatchObject({ kind: 'malformed' })
    }
    await expect(bqDryRunBytes(tr({ totalBytesProcessed: '1' }, { tokenMs: 31_000 }), { projectId: 'p', sql: 'select 1', deadlineMs: 30_000 })).rejects.toMatchObject({ kind: 'timeout' })
  })
})
