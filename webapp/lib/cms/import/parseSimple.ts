// CMS đơn giản S1 (PM spec r1 08/11 §4) — đọc file "mỗi SP một mức CMS / đơn vị" theo bố cục 7 cột business của stakeholder
// (product_id · product_name · brand_name · ĐV tính CMS · Giá bán / item · CMS proposal · CTKM) + 2 cột BỔ SUNG tuỳ chọn
// (base_quantity_CMS · Noi_dung_tu_van). Thuần (chỉ bytes đã nhận). KHÔNG có model / engine / schema tiền mới: mỗi dòng ánh xạ về
// đúng một dòng IMPORT_CMS 9 cột {bậc 1, từ 1, đến trống, không target} rồi đi qua CHÍNH validator cũ (validateCmsImport).
//
// Luật đọc:
//  · Sheet đầu tiên của workbook (file stakeholder: "Sheet1"); header tìm trong 50 dòng đầu theo alias TƯỜNG MINH sau chuẩn hoá
//    NFC + NBSP → khoảng trắng + gộp khoảng trắng + trim + lower ("CMS proposal " có khoảng trắng / NBSP cuối vẫn khớp).
//  · Đủ 7 cột business (thiếu ⇒ MISSING_COLUMNS kèm tên); hai cột khớp cùng một trường ⇒ DUPLICATE_COLUMNS (không đoán cột nào đúng).
//  · Ô hợp đồng (product_id · ĐV tính CMS · CMS proposal · 2 cột bổ sung) đọc giá trị GỐC như parser 9 cột: công thức / ngày / bool /
//    lỗi ⇒ lỗi dòng; số tiền lấy raw numeric (không parse chuỗi hiển thị theo locale, không suy CMS = giá × %); ProductID ô số vượt
//    2^53 ⇒ lỗi (validator). Cột THAM KHẢO (tên / brand / giá / CTKM) chỉ giữ giá trị gốc cho file lỗi + cảnh báo — không vào công thức.
//  · Không có cột base_quantity_CMS / Noi_dung_tu_van ⇒ file vẫn đọc được nhưng validator loại mọi nhóm (thiếu K / tư vấn) ⇒ không
//    có gì để ghi. KHÔNG tự đặt K = 1, không suy K từ tên / quy cách, không điền chữ tư vấn giả.
import * as XLSX from 'xlsx'
import { cmsZipGuard } from './zipGuard'
import { CMS_IMPORT_MAX_ROWS, cellOf, isBlank, readCell, type CmsCell, type CmsImportColumn, type CmsImportRawRow } from './parse'
import { CMS_SIMPLE_HEADER, type CmsSimpleField } from './simpleColumns'

export { CMS_SIMPLE_COLUMN_OF, CMS_SIMPLE_HEADER, type CmsSimpleField } from './simpleColumns'

const HEADER_SCAN_ROWS = 50

/** 7 cột business bắt buộc có mặt (đúng bố cục file stakeholder). */
export const CMS_SIMPLE_REQUIRED: readonly CmsSimpleField[] = ['product_id', 'product_name', 'brand_name', 'unit', 'price', 'cms', 'promo']
export const CMS_SIMPLE_OPTIONAL: readonly CmsSimpleField[] = ['base_quantity', 'advice']


/** NFC + NBSP / khoảng trắng lạ → khoảng trắng + gộp + trim + lower. */
export const cmsCanonHeader = (s: string): string =>
  s.normalize('NFC').replace(/[   ​﻿]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

const ALIASES: Record<CmsSimpleField, (h: string) => boolean> = {
  product_id: (h) => h === 'product_id' || h === 'productid',
  product_name: (h) => h === 'product_name' || h === 'tên sản phẩm',
  brand_name: (h) => h === 'brand_name' || h === 'brand' || h === 'thương hiệu',
  unit: (h) => h === 'đv tính cms (1 item)' || h === 'đv tính cms' || h === 'đơn vị tính cms' || h === 'unit_cms',
  price: (h) => h === 'giá bán / item (đ)' || h === 'giá bán / item' || h === 'giá bán/item (đ)' || h === 'giá bán/item',
  cms: (h) => h === 'cms proposal',
  promo: (h) => /^ctkm( tháng (0?[1-9]|1[0-2]))?( \(%\))?$/.test(h),
  base_quantity: (h) => h === 'base_quantity_cms',
  advice: (h) => h === 'noi_dung_tu_van' || h === 'nội dung tư vấn',
}
const FIELDS = Object.keys(ALIASES) as CmsSimpleField[]

export const cmsSimpleFieldOf = (header: string): CmsSimpleField | null => {
  const h = cmsCanonHeader(header)
  return FIELDS.find((f) => ALIASES[f](h)) ?? null
}

export type CmsSimpleParseError = 'NOT_XLSX' | 'FILE_TOO_COMPLEX' | 'NO_SHEET' | 'MISSING_COLUMNS' | 'DUPLICATE_COLUMNS' | 'TOO_MANY_ROWS' | 'NO_DATA'

export type CmsSimpleParseResult =
  | {
    ok: true
    headerRow: number
    rows: CmsImportRawRow[]
    ignoredFromRow: number | null
    /** File có cột bổ sung K / tư vấn không (thiếu ⇒ mọi nhóm thiếu K / tư vấn ⇒ không ghi được). */
    supplement: { baseQuantity: boolean; advice: boolean }
  }
  | { ok: false; error: CmsSimpleParseError; missing?: string[]; duplicate?: string[] }

const EMPTY: CmsCell = { kind: 'empty' }

/** Dòng 9 cột ánh xạ từ một dòng file đơn giản: bậc 1 từ 1, đến trống, không target / loại target. */
function toImportRow(excelRow: number, get: (f: CmsSimpleField) => { cell: CmsCell; raw: string | number | null } | null): CmsImportRawRow {
  const pid = get('product_id')!, unit = get('unit')!, cms = get('cms')!
  const base = get('base_quantity'), advice = get('advice')
  const cells: Record<CmsImportColumn, CmsCell> = {
    ProductID: pid.cell, KPI_Target_GMV_VND: EMPTY, Loai_CMS_GMV: EMPTY, Tu_SL_ban: { kind: 'number', value: 1 }, Den_SL_ban: EMPTY,
    CMS_VND_SP: cms.cell, Noi_dung_tu_van: advice?.cell ?? EMPTY, unit_CMS: unit.cell, base_quantity_CMS: base?.cell ?? EMPTY,
  }
  const raw: Record<CmsImportColumn, string | number | null> = {
    ProductID: pid.raw, KPI_Target_GMV_VND: null, Loai_CMS_GMV: null, Tu_SL_ban: 1, Den_SL_ban: null,
    CMS_VND_SP: cms.raw, Noi_dung_tu_van: advice?.raw ?? null, unit_CMS: unit.raw, base_quantity_CMS: base?.raw ?? null,
  }
  const info: Record<string, string | number | null> = {}
  for (const f of ['product_name', 'brand_name', 'price', 'promo'] as const) info[f] = get(f)?.raw ?? null
  return { excelRow, cells, raw, info }
}

export function parseCmsSimpleXlsx(bytes: Uint8Array): CmsSimpleParseResult {
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return { ok: false, error: 'NOT_XLSX' }
  const zip = cmsZipGuard(bytes)
  if (!zip.ok) return { ok: false, error: zip.reason === 'NOT_ZIP' ? 'NOT_XLSX' : 'FILE_TOO_COMPLEX' }
  let wb: XLSX.WorkBook
  try {
    // Đọc tên sheet trước (không dựng dữ liệu), rồi chỉ dựng SHEET ĐẦU với trần dòng — cùng tuỳ chọn đọc giá trị gốc như parser 9 cột.
    const names = XLSX.read(bytes, { type: 'array', bookSheets: true }).SheetNames
    if (!names || names.length === 0) return { ok: false, error: 'NO_SHEET' }
    wb = XLSX.read(bytes, {
      type: 'array', cellFormula: true, cellNF: true, cellHTML: false, cellText: false, dense: false, sheetStubs: true,
      sheets: names[0], sheetRows: HEADER_SCAN_ROWS + CMS_IMPORT_MAX_ROWS + 2,
    })
  } catch {
    return { ok: false, error: 'NOT_XLSX' }
  }
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws || !ws['!ref']) return { ok: false, error: 'NO_SHEET' }
  const range = XLSX.utils.decode_range(ws['!ref'])

  // 1) Header: dòng đầu tiên có cột product_id (alias). Trùng alias trong dòng header ⇒ lỗi rõ.
  let headerRow = -1
  const col = new Map<CmsSimpleField, number>()
  const dup = new Set<string>()
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + HEADER_SCAN_ROWS - 1) && headerRow < 0; r++) {
    const found = new Map<CmsSimpleField, number>()
    const twice = new Set<string>()
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = cellOf(ws, r, c)
      if (!cell || cell.t !== 's') continue
      const f = cmsSimpleFieldOf(String(cell.v ?? ''))
      if (!f) continue
      if (found.has(f)) twice.add(CMS_SIMPLE_HEADER[f]); else found.set(f, c)
    }
    if (found.has('product_id')) { headerRow = r; for (const [k, v] of found) col.set(k, v); for (const d of twice) dup.add(d) }
  }
  if (headerRow < 0) return { ok: false, error: 'MISSING_COLUMNS', missing: CMS_SIMPLE_REQUIRED.map((f) => CMS_SIMPLE_HEADER[f]) }
  if (dup.size) return { ok: false, error: 'DUPLICATE_COLUMNS', duplicate: [...dup] }
  const missing = CMS_SIMPLE_REQUIRED.filter((f) => !col.has(f))
  if (missing.length) return { ok: false, error: 'MISSING_COLUMNS', missing: missing.map((f) => CMS_SIMPLE_HEADER[f]) }

  // 2) Dữ liệu tới dòng product_id trống đầu tiên (như parser 9 cột).
  const pidCol = col.get('product_id')!
  const rows: CmsImportRawRow[] = []
  let r = headerRow + 1
  for (; r <= range.e.r; r++) {
    if (isBlank(cellOf(ws, r, pidCol))) break
    if (rows.length >= CMS_IMPORT_MAX_ROWS) return { ok: false, error: 'TOO_MANY_ROWS' }
    const row = r
    rows.push(toImportRow(r + 1, (f) => (col.has(f) ? readCell(cellOf(ws, row, col.get(f)!)) : null)))
  }
  if (rows.length === 0) return { ok: false, error: 'NO_DATA' }

  // 3) Nội dung sau điểm dừng ⇒ notice (không nhập).
  let ignoredFromRow: number | null = null
  for (let rr = r; rr <= range.e.r && ignoredFromRow === null; rr++) {
    for (let c = range.s.c; c <= range.e.c; c++) if (!isBlank(cellOf(ws, rr, c))) { ignoredFromRow = rr + 1; break }
  }
  return { ok: true, headerRow: headerRow + 1, rows, ignoredFromRow, supplement: { baseQuantity: col.has('base_quantity'), advice: col.has('advice') } }
}
