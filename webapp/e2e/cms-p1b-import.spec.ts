import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { test, expect } from '@playwright/test'
import { CMS_IMPORT_COLUMNS, CMS_IMPORT_MAX_ROWS, parseCmsImportXlsx, type CmsImportRawRow } from '../lib/cms/import/parse'
import { canonicalCmsImport, validateCmsImport, type CmsImportContext, type CmsProductMasterLite } from '../lib/cms/import/validate'
import { buildCmsImportErrorXlsx, buildCmsImportTemplateXlsx, CMS_TEMPLATE_EXAMPLE_IDS } from '../lib/cms/import/workbooks'

// CMS P1-b — parser + validator import (docs/cms/SPEC.md §4; IMPLEMENTATION_PLAN §3.3; r2 §5.1 + quy tắc đọc ô PM §5).
// THUẦN: workbook dựng trong bộ nhớ bằng xlsx, ProductID giả 9xxxxx; không DB, không mạng.

const H = [...CMS_IMPORT_COLUMNS]
type Cell = string | number | null | XLSX.CellObject
function book(rows: Cell[][], o: { sheet?: string; pre?: Cell[][]; header?: string[]; extra?: Record<string, XLSX.CellObject> } = {}): Uint8Array {
  const aoa = [...(o.pre ?? []), o.header ?? H, ...rows]
  const ws = XLSX.utils.aoa_to_sheet(aoa.map((r) => r.map((c) => (c !== null && typeof c === 'object' ? null : c))))
  aoa.forEach((r, ri) => r.forEach((c, ci) => { if (c !== null && typeof c === 'object') ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = c }))
  for (const [addr, cell] of Object.entries(o.extra ?? {})) ws[addr] = cell
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
  for (const addr of Object.keys(o.extra ?? {})) { const d = XLSX.utils.decode_cell(addr); range.e.r = Math.max(range.e.r, d.r); range.e.c = Math.max(range.e.c, d.c) }
  ws['!ref'] = XLSX.utils.encode_range(range)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, o.sheet ?? 'IMPORT_CMS')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}
const ADV = 'Tư vấn đã duyệt'
// [ProductID, Target, Loai, Tu, Den, CMS, TuVan, unit, baseQty]
const r = (pid: Cell, tgt: Cell, loai: Cell, tu: Cell, den: Cell, cms: Cell, unit: Cell = 'hộp', base: Cell = 24, adv: Cell = ADV): Cell[] =>
  [pid, tgt, loai, tu, den, cms, adv, unit, base]

const PM = new Map<string, CmsProductMasterLite>([
  ['900001', { productName: 'SP giả 1', imageUrl: 'https://cdn-gcs.thuocsi.vn/thuocsi-live/images/1.jpg', isActive: true, referencePrice: '120000' }],
  ['900002', { productName: 'SP giả 2', imageUrl: 'https://cdn-gcs.thuocsi.vn/thuocsi-live/images/2.jpg', isActive: true, referencePrice: null }],
  ['900003', { productName: 'SP giả 3', imageUrl: 'https://cdn-gcs.thuocsi.vn/thuocsi-live/images/3.jpg', isActive: true, referencePrice: null }],
  ['900004', { productName: 'SP giả 4', imageUrl: null, isActive: false, referencePrice: null }],
  ['900005', { productName: 'SP giả 5', imageUrl: 'http://evil.example/5.jpg', isActive: true, referencePrice: null }],
])
const ctx = (o: Partial<CmsImportContext> = {}): CmsImportContext => ({
  mode: 'replace', productMaster: PM, existingProductIds: new Set(), conflictProductIds: new Set(), currentCatalogTarget: null, ...o,
})
function rowsOf(bytes: Uint8Array): CmsImportRawRow[] {
  const p = parseCmsImportXlsx(bytes)
  if (!p.ok) throw new Error(`parse ${p.error}`)
  return p.rows
}
const codesOf = (v: ReturnType<typeof validateCmsImport>, key: string) => v.groupsRejected.find((g) => g.key === key)?.errors.map((e) => e.code) ?? []

test.describe('CMS P1-b · parser xlsx @desktop', () => {
  test('header theo tên (hoa thường / khoảng trắng), dừng ở ProductID trống, nội dung sau điểm dừng ⇒ notice', () => {
    const header = H.map((h) => `  ${h.toUpperCase()} `)
    const bytes = book([r(900001, null, null, 1, null, 1000), [null], ['Ghi chú: không được nhập'], r(900002, null, null, 1, null, 1000)],
      { pre: [['CIRCA | FILE IMPORT'], [], ['ghi chú']], header })
    const p = parseCmsImportXlsx(bytes)
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.headerRow).toBe(4)
    expect(p.rows.map((x) => x.excelRow)).toEqual([5])
    expect(p.ignoredFromRow).toBe(7)
  })

  test('mẫu r1 7 cột ⇒ MISSING_COLUMNS (không tự mặc định hệ số = 1)', () => {
    const sample = fs.readFileSync(path.resolve(__dirname, '..', '..', 'docs', 'cms', 'samples', 'Circa_Import_CMS_Phase_2_.xlsx'))
    expect(parseCmsImportXlsx(new Uint8Array(sample))).toEqual({ ok: false, error: 'MISSING_COLUMNS', missing: ['unit_CMS', 'base_quantity_CMS'] })
  })

  test('lỗi file: không phải xlsx / thiếu sheet / không dữ liệu / quá 2.000 dòng', () => {
    expect(parseCmsImportXlsx(new TextEncoder().encode('ProductID,x\n1,2')).ok).toBe(false)
    expect(parseCmsImportXlsx(book([r(900001, null, null, 1, null, 1)], { sheet: 'Sheet1' }))).toEqual({ ok: false, error: 'NO_SHEET' })
    expect(parseCmsImportXlsx(book([]))).toEqual({ ok: false, error: 'NO_DATA' })
    const many = Array.from({ length: CMS_IMPORT_MAX_ROWS + 1 }, (_, i) => r(900001 + i, null, null, 1, null, 1000))
    expect(parseCmsImportXlsx(book(many))).toEqual({ ok: false, error: 'TOO_MANY_ROWS' })
    const max = Array.from({ length: CMS_IMPORT_MAX_ROWS }, (_, i) => r(900001 + i, null, null, 1, null, 1000))
    expect(parseCmsImportXlsx(book(max)).ok).toBe(true)
  })

  test('cột ngoài hợp đồng có công thức bị bỏ qua; công thức trong cột hợp đồng / bool ⇒ lỗi ô', () => {
    const bytes = book([[...r(900001, null, null, 1, null, { t: 'n', v: 1000, f: '500*2' })], r(900002, null, null, 1, null, 1000, 'hộp', { t: 'b', v: true })],
      { extra: { J5: { t: 'n', v: 42, f: 'A2*2' } } })
    const v = validateCmsImport(rowsOf(bytes), ctx())
    expect(codesOf(v, '900001')).toContain('CELL_FORMULA')
    expect(codesOf(v, '900002')).toContain('CELL_TYPE')
  })
})

test.describe('CMS P1-b · đọc ô theo SPEC §4.2 @desktop', () => {
  test('số nguyên: ô số (kể cả định dạng nghìn) hoặc text chữ số; KHÔNG đoán text có dấu phân cách', () => {
    const fmt: XLSX.CellObject = { t: 'n', v: 10000000, z: '#,##0' }
    const ok = validateCmsImport(rowsOf(book([r(900001, fmt, 'GMV_THEO_PRODUCTID', 1, null, '15000'), r(900002, '10000000', 'GMV_THEO_PRODUCTID', 1, null, 15000)])), ctx())
    expect(ok.groupsOk.map((g) => g.targetGmv)).toEqual(['10000000', '10000000'])
    const bad = validateCmsImport(rowsOf(book([r(900001, '10,000,000', 'GMV_THEO_PRODUCTID', 1, null, 1000), r(900002, '10.000.000', 'GMV_THEO_PRODUCTID', 1, null, 1000),
      r(900003, null, null, 1.5, null, 1000), r(900004, null, null, 1, null, '1 000')])), ctx())
    expect(bad.groupsOk).toEqual([])
    for (const k of ['900001', '900002', '900003', '900004']) expect(codesOf(bad, k)).toContain('NOT_INTEGER')
  })

  test('ProductID: số nguyên / text chữ số; từ chối SKU, phân số, text số mũ', () => {
    const v = validateCmsImport(rowsOf(book([r(' 0900001 ', null, null, 1, null, 1000), r('SKU001', null, null, 1, null, 1000),
      r(1.5, null, null, 1, null, 1000), r('1.2E+5', null, null, 1, null, 1000)])), ctx())
    expect(v.groupsOk.map((g) => g.productId)).toEqual(['900001'])
    expect(v.groupsRejected.map((g) => g.errors[0].code)).toEqual(['PRODUCT_ID_INVALID', 'PRODUCT_ID_INVALID', 'PRODUCT_ID_INVALID'])
  })

  test('base_quantity_CMS: tối đa 9 chữ số thập phân (ô số 1e-9 hợp lệ), > 0, không làm tròn', () => {
    const v = validateCmsImport(rowsOf(book([r(900001, null, null, 1, null, 1, 'ml', 1e-9), r(900002, null, null, 1, null, 1, 'ml', '2.5'),
      r(900003, null, null, 1, null, 1, 'ml', '1.0000000001'), r(900004, null, null, 1, null, 1, 'ml', 0), r(900005, null, null, 1, null, 1, 'ml', '1,5')])), ctx())
    expect(v.groupsOk.map((g) => [g.productId, g.baseQuantityCms])).toEqual([['900001', '0.000000001'], ['900002', '2.5']])
    for (const k of ['900003', '900004', '900005']) expect(codesOf(v, k)).toContain('BASE_QTY_INVALID')
  })
})

test.describe('CMS P1-b · kiểm nhóm (r2 §5.1) @desktop', () => {
  test('file hợp lệ với 3 loại gate', () => {
    const v = validateCmsImport(rowsOf(book([
      r(900001, 10000000, 'GMV_THEO_PRODUCTID', 1, 9, 15000), r(900001, 10000000, 'GMV_THEO_PRODUCTID', 10, 19, 20000), r(900001, 10000000, 'GMV_THEO_PRODUCTID', 20, null, 25000),
      r(900002, 50000000, 'gmv_toan_danh_muc', 1, null, 8000, 'chai', 1),
      r(900003, null, null, 1, 50, 5000, 'vỉ', 10),
    ])), ctx())
    expect(v.groupsRejected).toEqual([])
    expect(v.groupsOk.map((g) => [g.productId, g.gmvBasis, g.targetGmv])).toEqual([['900001', 'product', '10000000'], ['900002', 'catalog', null], ['900003', 'none', null]])
    expect(v.catalogTarget).toBe('50000000')
    expect(v.groupsOk[0].tiers).toEqual([{ order: 1, from: 1, to: 9, amount: '15000' }, { order: 2, from: 10, to: 19, amount: '20000' }, { order: 3, from: 20, to: null, amount: '25000' }])
    // CMS-Q-220: một bậc 1–50 ⇒ chuẩn hoá 1+ (cuối null) kèm cảnh báo; nhóm vốn để trống cận cuối không có cảnh báo chuyển đổi giả.
    expect(v.groupsOk[2].tiers).toEqual([{ order: 1, from: 1, to: null, amount: '5000' }])
    expect(v.groupsOk[2].normalizedLastTo).toBe(50)
    expect(v.groupsOk[2].warnings.map((w) => [w.code, w.excelRow, w.column])).toEqual([['LAST_TIER_UNBOUNDED_NORMALIZED', v.groupsOk[2].excelRows[0], 'Den_SL_ban']])
    expect(v.groupsOk.slice(0, 2).map((g) => [g.normalizedLastTo, g.warnings.filter((w) => w.code === 'LAST_TIER_UNBOUNDED_NORMALIZED').length])).toEqual([[null, 0], [null, 0]])
    expect(v.stats).toMatchObject({ rowsTotal: 5, rowsOk: 5, rowsRejected: 0, productsOk: 3, productsRejected: 0 })
  })

  test('cùng ProductID khác target / đơn vị / quy cách / tư vấn ⇒ loại cả nhóm', () => {
    const v = validateCmsImport(rowsOf(book([
      r(900001, 10000000, 'GMV_THEO_PRODUCTID', 1, 9, 1), r(900001, 20000000, 'GMV_THEO_PRODUCTID', 10, null, 2),
      r(900002, null, null, 1, 9, 1, 'hộp'), r(900002, null, null, 10, null, 2, 'vỉ'),
      r(900003, null, null, 1, 9, 1, 'hộp', 24), r(900003, null, null, 10, null, 2, 'hộp', 12),
      r(900004, null, null, 1, 9, 1, 'hộp', 24, 'A'), r(900004, null, null, 10, null, 2, 'hộp', 24, 'B'),
    ])), ctx())
    expect(v.groupsOk).toEqual([])
    expect(v.groupsRejected.map((g) => g.errors.find((e) => e.code === 'GROUP_INCONSISTENT')?.column))
      .toEqual(['KPI_Target_GMV_VND', 'unit_CMS', 'base_quantity_CMS', 'Noi_dung_tu_van'])
  })

  test('bậc hở / chồng / không từ 1 / trống giữa / đến < từ; bậc cuối hữu hạn hợp lệ ⇒ chuẩn hoá không giới hạn + cảnh báo (CMS-Q-220)', () => {
    const v = validateCmsImport(rowsOf(book([
      r(900001, null, null, 1, 9, 1), r(900001, null, null, 11, 19, 2),
      r(900002, null, null, 1, 10, 1), r(900002, null, null, 10, 19, 2),
      r(900003, null, null, 2, 9, 1),
      r(900004, null, null, 1, null, 1), r(900004, null, null, 10, 19, 2),
      r(900005, null, null, 5, 4, 1),
    ])), ctx())
    expect(codesOf(v, '900001')).toContain('TIER_GAP')
    expect(codesOf(v, '900002')).toContain('TIER_OVERLAP')
    expect(codesOf(v, '900003')).toContain('TIER_NOT_FROM_ONE')
    expect(codesOf(v, '900004')).toContain('TIER_OPEN_NOT_LAST')
    expect(codesOf(v, '900005')).toContain('TIER_TO_LT_FROM')
    // Lỗi khác KHÔNG được chuẩn hoá thành hợp lệ: cả nhóm vẫn bị loại, không có cảnh báo chuyển đổi.
    expect(v.groupsOk).toEqual([])
    expect(v.groupsRejected.every((g) => g.errors.every((e) => e.code !== 'LAST_TIER_UNBOUNDED_NORMALIZED'))).toBe(true)
    const fin = validateCmsImport(rowsOf(book([r(900001, null, null, 1, 9, 1), r(900001, null, null, 10, 50, 2), r(900002, null, null, 1, 10000, 3),
      r(900003, null, null, 1, 9, 15000), r(900003, null, null, 10, 19, 20000), r(900003, null, null, 20, 100, 25000)])), ctx())
    // Chỉ cận cuối → null; bậc giữa 9 / 19 nguyên vẹn; mức tiền không đổi.
    expect(fin.groupsOk.map((g) => g.tiers)).toEqual([
      [{ order: 1, from: 1, to: 9, amount: '1' }, { order: 2, from: 10, to: null, amount: '2' }],
      [{ order: 1, from: 1, to: null, amount: '3' }],
      [{ order: 1, from: 1, to: 9, amount: '15000' }, { order: 2, from: 10, to: 19, amount: '20000' }, { order: 3, from: 20, to: null, amount: '25000' }],
    ])
    expect(fin.groupsOk.map((g) => g.normalizedLastTo)).toEqual([50, 10000, 100])
    const w = fin.groupsOk[2].warnings.find((x) => x.code === 'LAST_TIER_UNBOUNDED_NORMALIZED')!
    expect([w.excelRow, w.column, w.message]).toEqual([fin.groupsOk[2].excelRows[2], 'Den_SL_ban',
      'Đã bỏ giới hạn 100 của bậc cuối theo chính sách CMS mới; từ 20 trở lên đều được xét bậc này.'])
    expect(fin.groupsOk[1].warnings.find((x) => x.code === 'LAST_TIER_UNBOUNDED_NORMALIZED')!.message).toContain('Đã bỏ giới hạn 10.000 của bậc cuối')
    // Cảnh báo cũ "bậc cuối hữu hạn rất lớn" không còn (bậc cuối luôn không giới hạn).
    expect(fin.groupsOk.flatMap((g) => g.warnings.map((x) => x.code))).not.toContain('LAST_TIER_LARGE')
    // Canonical (digest preview ↔ commit) = file vốn để trống cận cuối: chuẩn hoá không đổi nghĩa payload, có định danh chính sách.
    const blank = validateCmsImport(rowsOf(book([r(900001, null, null, 1, 9, 1), r(900001, null, null, 10, null, 2), r(900002, null, null, 1, null, 3),
      r(900003, null, null, 1, 9, 15000), r(900003, null, null, 10, 19, 20000), r(900003, null, null, 20, null, 25000)])), ctx())
    expect(blank.groupsOk.map((g) => g.normalizedLastTo)).toEqual([null, null, null])
    expect(canonicalCmsImport(fin)).toBe(canonicalCmsImport(blank))
    expect(JSON.parse(canonicalCmsImport(fin)).policy).toBe('uncapped_last_v1')
  })

  test('gate thiếu target / thiếu loại ⇒ lỗi', () => {
    const v = validateCmsImport(rowsOf(book([r(900001, null, 'GMV_THEO_PRODUCTID', 1, null, 1), r(900002, 1000, null, 1, null, 1), r(900003, 1000, 'KHAC', 1, null, 1)])), ctx())
    expect(codesOf(v, '900001')).toContain('GATE_MISSING_TARGET')
    expect(codesOf(v, '900002')).toContain('GATE_MISSING_TYPE')
    expect(codesOf(v, '900003')).toContain('TYPE_INVALID')
  })

  test('hai nhóm danh mục khác target ⇒ loại mọi nhóm danh mục; nhóm không danh mục vẫn nạp', () => {
    const v = validateCmsImport(rowsOf(book([
      r(900001, 50000000, 'GMV_TOAN_DANH_MUC', 1, null, 1), r(900002, 60000000, 'GMV_TOAN_DANH_MUC', 1, null, 1), r(900003, null, null, 1, null, 1),
    ])), ctx())
    expect(v.groupsOk.map((g) => g.productId)).toEqual(['900003'])
    expect(codesOf(v, '900001')).toEqual(['CATALOG_TARGET_MISMATCH'])
    expect(codesOf(v, '900002')).toEqual(['CATALOG_TARGET_MISMATCH'])
    expect(v.catalogTarget).toBeNull()
  })

  test('một nhóm lỗi, nhóm khác vẫn nạp; Product Master thiếu / xung đột chương trình ⇒ loại nhóm', () => {
    const v = validateCmsImport(rowsOf(book([r(900001, null, null, 1, null, 1), r(900009, null, null, 1, null, 1), r(900002, null, null, 1, null, 1)])),
      ctx({ conflictProductIds: new Set(['900002']) }))
    expect(v.groupsOk.map((g) => g.productId)).toEqual(['900001'])
    expect(codesOf(v, '900009')).toEqual(['PRODUCT_NOT_FOUND'])
    expect(codesOf(v, '900002')).toEqual(['PRODUCT_CONFLICT'])
  })

  test('append (đã bắt đầu): chỉ thêm SP mới; target danh mục hiện hữu không đổi; nhóm danh mục đầu tiên đặt target', () => {
    const v = validateCmsImport(rowsOf(book([r(900001, null, null, 1, null, 1), r(900002, 70000000, 'GMV_TOAN_DANH_MUC', 1, null, 1)])),
      ctx({ mode: 'append', existingProductIds: new Set(['900001']), currentCatalogTarget: '50000000' }))
    expect(codesOf(v, '900001')).toEqual(['PRODUCT_EXISTS_STARTED'])
    expect(codesOf(v, '900002')).toEqual(['CATALOG_TARGET_CHANGED'])
    expect(v.catalogTarget).toBe('50000000')
    const first = validateCmsImport(rowsOf(book([r(900003, 70000000, 'GMV_TOAN_DANH_MUC', 1, null, 1)])),
      ctx({ mode: 'append', existingProductIds: new Set(['900001']), currentCatalogTarget: null }))
    expect([first.groupsOk.map((g) => g.productId), first.catalogTarget]).toEqual([['900003'], '70000000'])
  })

  test('cảnh báo vẫn cho nạp: thiếu ảnh, ảnh ngoài allow-list, CMS > 500.000; KHÔNG cảnh báo trạng thái SP (cache cũ is_active=false)', () => {
    // Operator bỏ trạng thái SP 04/11 (PM `2026-11-04-cms-bi-product-master-pm.md` §2.2): 900004 có isActive=false trong cache
    // nhưng KHÔNG sinh PRODUCT_INACTIVE; ProductID không có trên Master vẫn bị từ chối.
    const v = validateCmsImport(rowsOf(book([r(900004, null, null, 1, null, 600000), r(900005, null, null, 1, null, 1), r(900099, null, null, 1, null, 1)])), ctx())
    expect(v.groupsOk.map((g) => [g.productId, g.warnings.map((w) => w.code).sort()])).toEqual([
      ['900004', ['AMOUNT_HIGH', 'IMAGE_MISSING']], ['900005', ['IMAGE_NOT_ALLOWED']]])
    expect(v.groupsOk[1].imageUrlSnapshot).toBeNull()
    expect(JSON.stringify(v)).not.toContain('PRODUCT_INACTIVE')
    expect(v.groupsRejected.map((g) => [g.key, g.errors.map((e) => e.code)])).toEqual([['900099', ['PRODUCT_NOT_FOUND']]])
  })
})

test.describe('CMS P1-b · file lỗi, digest, template @desktop', () => {
  test('file lỗi giữ ĐỦ dòng của nhóm bị loại + cột Loi; sửa rồi nạp lại được', () => {
    const v = validateCmsImport(rowsOf(book([r(900001, null, null, 1, 9, 1), r(900001, null, null, 11, null, 2), r(900002, null, null, 1, null, 1)])), ctx())
    const bytes = buildCmsImportErrorXlsx(v.groupsRejected)
    const wb = XLSX.read(bytes, { type: 'array' })
    const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets.IMPORT_CMS, { header: 1, defval: null })
    expect(aoa[0]).toEqual([...H, 'Loi'])
    expect(aoa.slice(1).map((x) => x[0])).toEqual([900001, 900001])
    expect(String(aoa[2][9])).toContain('Bậc bị hở')
    expect(String(aoa[1][9])).toContain('Cả nhóm ProductID bị loại')
    expect(parseCmsImportXlsx(bytes).ok).toBe(true)
  })

  test('digest chuẩn hoá: không phụ thuộc thứ tự dòng; đổi dữ liệu ⇒ đổi', () => {
    const a = validateCmsImport(rowsOf(book([r(900001, null, null, 1, 9, 1), r(900001, null, null, 10, null, 2), r(900002, null, null, 1, null, 1)])), ctx())
    const b = validateCmsImport(rowsOf(book([r(900002, null, null, 1, null, 1), r(900001, null, null, 10, null, 2), r(900001, null, null, 1, 9, 1)])), ctx())
    const c = validateCmsImport(rowsOf(book([r(900001, null, null, 1, 9, 1), r(900001, null, null, 10, null, 3), r(900002, null, null, 1, null, 1)])), ctx())
    expect(canonicalCmsImport(a)).toBe(canonicalCmsImport(b))
    expect(canonicalCmsImport(a)).not.toBe(canonicalCmsImport(c))
  })

  test('template 9 cột: parse đạt; ProductID giả bị loại PRODUCT_NOT_FOUND nếu quên xoá; file tĩnh khớp bộ sinh', () => {
    const t = buildCmsImportTemplateXlsx()
    const rows = rowsOf(t)
    expect(rows.length).toBe(5)
    expect(validateCmsImport(rows, ctx()).groupsRejected.map((g) => g.errors[0].code)).toEqual(['PRODUCT_NOT_FOUND', 'PRODUCT_NOT_FOUND', 'PRODUCT_NOT_FOUND'])
    const pmFake = new Map([...PM, ...CMS_TEMPLATE_EXAMPLE_IDS.map((id) => [id, { productName: `Giả ${id}`, imageUrl: null, isActive: true, referencePrice: null }] as const)])
    const ok = validateCmsImport(rows, ctx({ productMaster: pmFake }))
    expect(ok.groupsOk.map((g) => g.gmvBasis)).toEqual(['product', 'catalog', 'none'])
    // CMS-Q-220: mẫu để trống Den_SL_ban ở bậc cuối mọi nhóm (không số giả), không sinh cảnh báo chuyển đổi; hướng dẫn ghi rõ.
    expect(ok.groupsOk.map((g) => [g.tiers.at(-1)!.to, g.normalizedLastTo])).toEqual([[null, null], [null, null], [null, null]])
    expect(ok.groupsOk.flatMap((g) => g.warnings.map((w) => w.code))).not.toContain('LAST_TIER_UNBOUNDED_NORMALIZED')
    const guide = XLSX.utils.sheet_to_json<string[]>(XLSX.read(t, { type: 'array' }).Sheets.HUONG_DAN, { header: 1 })
    expect(guide.some((x) => x.join(' ').includes('Bậc cuối tính từ mốc này trở lên, không giới hạn số lượng') && x.join(' ').includes('Để trống Đến SL bán'))).toBe(true)
    expect(JSON.stringify(guide)).not.toMatch(/999999|2147483647|20\+/)
    const staticFile = path.resolve(__dirname, '..', 'public', 'templates', 'Circa_Import_CMS.xlsx')
    const s = parseCmsImportXlsx(new Uint8Array(fs.readFileSync(staticFile)))
    expect(s.ok && s.rows.map((x) => x.raw)).toEqual(rows.map((x) => x.raw))
  })
})

test.describe('CMS P1-b · PM audit r1 — biên số, ô công thức, ô ngày (workbook thật) @desktop', () => {
  const MAX = '9223372036854775807', OVER = '9223372036854775808'
  const codes = (v: ReturnType<typeof validateCmsImport>) => Object.fromEntries(v.groupsRejected.map((g) => [g.key, g.errors.map((e) => e.code)]))

  test('P1-1 tiền: = bigint max nhận (CMS / target SP / target danh mục); +1 ⇒ loại ĐÚNG nhóm, nhóm khác vẫn hợp lệ', () => {
    const v = validateCmsImport(rowsOf(book([
      r(900001, MAX, 'GMV_THEO_PRODUCTID', 1, null, MAX),
      r(900002, MAX, 'GMV_TOAN_DANH_MUC', 1, null, '1000000000000000000'),
      r(900003, null, null, 1, null, OVER),
      r(900004, OVER, 'GMV_THEO_PRODUCTID', 1, null, 1000),
    ])), ctx())
    expect(v.groupsOk.map((g) => g.productId)).toEqual(['900001', '900002'])
    expect(v.groupsOk[0]).toMatchObject({ targetGmv: MAX, tiers: [{ order: 1, from: 1, to: null, amount: MAX }] })
    expect(v.groupsOk[1].tiers[0].amount).toBe('1000000000000000000')
    expect(v.catalogTarget).toBe(MAX)
    expect(codes(v)).toEqual({ '900003': ['AMOUNT_INVALID'], '900004': ['TARGET_INVALID'] })
    const cat = validateCmsImport(rowsOf(book([r(900001, OVER, 'GMV_TOAN_DANH_MUC', 1, null, 1000), r(900002, null, null, 1, null, 1000)])), ctx())
    expect([cat.groupsOk.map((g) => g.productId), codes(cat)]).toEqual([['900002'], { '900001': ['TARGET_INVALID'] }])
  })

  test('P1-1 quy cách: text 29 chữ số nguyên + 9 thập phân và 21 chữ số nhận; 30 chữ số ⇒ loại nhóm', () => {
    const q29 = '9'.repeat(29) + '.999999999'
    const v = validateCmsImport(rowsOf(book([
      r(900001, null, null, 1, null, 1000, 'hộp', q29),
      r(900002, null, null, 1, null, 1000, 'hộp', '100000000000000000000'),
      r(900003, null, null, 1, null, 1000, 'hộp', '1' + '0'.repeat(29)),
    ])), ctx())
    expect(v.groupsOk.map((g) => [g.productId, g.baseQuantityCms])).toEqual([['900001', q29], ['900002', '100000000000000000000']])
    expect(codes(v)).toEqual({ '900003': ['BASE_QTY_INVALID'] })
  })

  test('P1-2 quy cách ô số: MAX_SAFE_INTEGER nhận; ngay ngoài miền ⇒ loại; text chính xác tương ứng nhận; số lẻ và 1e-9 nhận', () => {
    const v = validateCmsImport(rowsOf(book([
      r(900001, null, null, 1, null, 1000, 'hộp', Number.MAX_SAFE_INTEGER),
      r(900002, null, null, 1, null, 1000, 'hộp', 9007199254740992),
      r(900003, null, null, 1, null, 1000, 'hộp', '9007199254740992'),
      r(900004, null, null, 1, null, 1000, 'hộp', 1.5),
      r(900005, null, null, 1, null, 1000, 'hộp', 1e-9),
    ])), ctx())
    expect(v.groupsOk.map((g) => [g.productId, g.baseQuantityCms])).toEqual([
      ['900001', '9007199254740991'], ['900003', '9007199254740992'], ['900004', '1.5'], ['900005', '0.000000001'],
    ])
    expect(codes(v)).toEqual({ '900002': ['BASE_QTY_INVALID'] })
  })

  test('P1-3 ProductID công thức KHÔNG cache / cache rỗng ở giữa và ở đầu ⇒ lỗi CELL_FORMULA, KHÔNG dừng file; dòng sau vẫn nạp; file lỗi giữ đúng dòng', () => {
    const noCache: XLSX.CellObject = { t: 'n', f: '900000+2' }
    const emptyCache: XLSX.CellObject = { t: 's', f: '""', v: '' }
    for (const fcell of [noCache, emptyCache]) {
      const mid = parseCmsImportXlsx(book([r(900001, null, null, 1, null, 1000), r(fcell, null, null, 1, null, 1000), r(900003, null, null, 1, null, 1000)]))
      expect(mid.ok && mid.rows.map((x) => x.excelRow)).toEqual([2, 3, 4])
      expect(mid.ok && mid.ignoredFromRow).toBe(null)
      if (!mid.ok) return
      expect(mid.rows[1].cells.ProductID).toEqual({ kind: 'bad', reason: 'FORMULA' })
      const v = validateCmsImport(mid.rows, ctx())
      expect(v.groupsOk.map((g) => g.productId)).toEqual(['900001', '900003'])
      expect(v.groupsRejected.length).toBe(1)
      expect(v.groupsRejected[0].errors.map((e) => [e.excelRow, e.code])).toEqual([[3, 'CELL_FORMULA']])
      const err = XLSX.read(buildCmsImportErrorXlsx(v.groupsRejected), { type: 'array' })
      const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(err.Sheets.IMPORT_CMS, { header: 1, defval: null })
      expect(aoa.length).toBe(2)
      expect(String(aoa[1][9])).toContain('công thức')
      // Công thức ở dòng dữ liệu ĐẦU: không NO_DATA, các dòng sau vẫn đọc.
      const first = parseCmsImportXlsx(book([r(fcell, null, null, 1, null, 1000), r(900003, null, null, 1, null, 1000)]))
      expect(first.ok && first.rows.length).toBe(2)
    }
    // ProductID thật sự trống vẫn là điểm dừng (baseline).
    const stop = parseCmsImportXlsx(book([r(900001, null, null, 1, null, 1000), r(null, null, null, 1, null, 1000), r(900003, null, null, 1, null, 1000)]))
    expect(stop.ok && [stop.rows.length, stop.ignoredFromRow]).toEqual([1, 3])
  })

  test('P1-4 ô số định dạng ngày / giờ ở cột hợp đồng ⇒ lỗi kiểu (không thành tiền / mã / số lượng); định dạng nghìn / thập phân vẫn nhận', () => {
    const dateNum: XLSX.CellObject = { t: 'n', v: 46000, z: 'm/d/yy' }
    const v = validateCmsImport(rowsOf(book([
      r(900001, null, null, 1, null, dateNum),
      r(900002, null, null, 1, null, { t: 'n', v: 15000, z: '#,##0' }),
      r(900003, null, null, 1, null, { t: 'n', v: 15000, z: '0.00' }),
      r({ t: 'n', v: 900004, z: 'yyyy-mm-dd' }, null, null, 1, null, 1000),
      r(900005, null, null, { t: 'd', v: new Date(Date.UTC(2026, 10, 1)) }, null, 1000),
      r(900006, null, null, 1, null, 1000, 'hộp', { t: 'n', v: 0.5, z: 'h:mm' }),
    ])), ctx({ productMaster: new Map([...PM, ['900006', PM.get('900001')!]]) }))
    expect(v.groupsOk.map((g) => [g.productId, g.tiers[0].amount])).toEqual([['900002', '15000'], ['900003', '15000']])
    const bad = codes(v)
    expect(bad['900001']).toEqual(['CELL_TYPE'])
    expect(bad['900005']).toEqual(['CELL_TYPE'])
    expect(bad['900006']).toEqual(['CELL_TYPE'])
    expect(Object.values(bad).flat().filter((c) => c === 'CELL_TYPE').length).toBe(4)
    expect(JSON.stringify(v.groupsOk)).not.toContain('46000')
  })
})
