// CMS P1-b — đọc file import .xlsx (docs/cms/SPEC.md §4.1–§4.2). Thuần (không I/O ngoài bytes đã nhận).
//  · Sheet IMPORT_CMS; header tìm theo TÊN (không phân biệt hoa thường, gộp khoảng trắng) trong 50 dòng đầu.
//  · Bắt đầu sau header; DỪNG ở dòng ProductID trống đầu tiên; nội dung sau điểm dừng ⇒ notice (không nhập).
//  · Đọc giá trị GỐC của ô (không dùng chuỗi hiển thị): number / text; ô công thức ở cột hợp đồng (có / không cache) ⇒
//    lỗi, không bao giờ là điểm dừng; bool / ô ngày-giờ (kể cả số mang định dạng ngày) / ô lỗi ⇒ lỗi kiểu. Cột ngoài hợp
//    đồng bị bỏ qua (kể cả có công thức).
//  · Tối đa 2.000 dòng dữ liệu; giữ raw value từng ô để sinh file lỗi.

import * as XLSX from 'xlsx'
import { cmsZipGuard } from './zipGuard'

export const CMS_IMPORT_SHEET = 'IMPORT_CMS'
export const CMS_IMPORT_MAX_ROWS = 2000
const HEADER_SCAN_ROWS = 50

export const CMS_IMPORT_COLUMNS = [
  'ProductID', 'KPI_Target_GMV_VND', 'Loai_CMS_GMV', 'Tu_SL_ban', 'Den_SL_ban', 'CMS_VND_SP', 'Noi_dung_tu_van',
  'unit_CMS', 'base_quantity_CMS',
] as const
export type CmsImportColumn = typeof CMS_IMPORT_COLUMNS[number]

export type CmsCell =
  | { kind: 'empty' }
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'bad'; reason: 'FORMULA' | 'BOOLEAN' | 'DATE' | 'ERROR' }

export interface CmsImportRawRow {
  /** Số dòng Excel (1-based) để báo lỗi. */
  excelRow: number
  cells: Record<CmsImportColumn, CmsCell>
  /** Giá trị gốc để xuất lại file lỗi (number giữ number, text giữ text). */
  raw: Record<CmsImportColumn, string | number | null>
  /** CMS đơn giản S1: giá trị gốc các cột THAM KHẢO của file 7 cột (tên / brand / giá / CTKM) — chỉ để file lỗi / cảnh báo, không vào
   *  công thức hay payload. Không có ở mẫu 9 cột. */
  info?: Record<string, string | number | null>
}

export type CmsParseError = 'NOT_XLSX' | 'FILE_TOO_COMPLEX' | 'NO_SHEET' | 'MISSING_COLUMNS' | 'TOO_MANY_ROWS' | 'NO_DATA'

export type CmsParseResult =
  | { ok: true; headerRow: number; rows: CmsImportRawRow[]; ignoredFromRow: number | null }
  | { ok: false; error: CmsParseError; missing?: string[] }

const canonHeader = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
const CANON_TO_COL = new Map(CMS_IMPORT_COLUMNS.map((c) => [canonHeader(c), c]))

export function cellOf(ws: XLSX.WorkSheet, r: number, c: number): XLSX.CellObject | undefined {
  return ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined
}

// Ô có công thức (kể cả KHÔNG có giá trị cache — đọc bằng sheetStubs thành t='z' — hoặc cache rỗng) KHÔNG bao giờ là ô
// trống: ProductID công thức không được thành điểm dừng (PM P1-b P1-3), phải đi tới lỗi CELL_FORMULA.
export function isBlank(cell: XLSX.CellObject | undefined): boolean {
  if (!cell) return true
  if (cell.f) return false
  if (cell.t === 'z') return true
  if (cell.t === 's') return String(cell.v ?? '').trim() === ''
  return cell.v === undefined || cell.v === null
}

export function readCell(cell: XLSX.CellObject | undefined): { cell: CmsCell; raw: string | number | null } {
  if (!cell) return { cell: { kind: 'empty' }, raw: null }
  if (cell.f) {
    const noCache = cell.t === 'z' || cell.v === undefined || cell.v === null || cell.v === ''
    return { cell: { kind: 'bad', reason: 'FORMULA' }, raw: noCache ? `=${cell.f}` : (cell.v as string | number) }
  }
  if (cell.t === 'z') return { cell: { kind: 'empty' }, raw: null }
  switch (cell.t) {
    case 'n':
      // Ô số mang định dạng ngày / giờ (serial ngày Excel) KHÔNG phải tiền / mã / số lượng (PM P1-b P1-4). Định dạng
      // số thường (phân cách nghìn, thập phân, General) vẫn hợp lệ.
      if (typeof cell.z === 'string' && XLSX.SSF.is_date(cell.z)) {
        return { cell: { kind: 'bad', reason: 'DATE' }, raw: String(cell.w ?? cell.v) }
      }
      return { cell: { kind: 'number', value: cell.v as number }, raw: cell.v as number }
    case 's': {
      const v = String(cell.v ?? '')
      return v.trim() === '' ? { cell: { kind: 'empty' }, raw: null } : { cell: { kind: 'text', value: v }, raw: v }
    }
    case 'b': return { cell: { kind: 'bad', reason: 'BOOLEAN' }, raw: String(cell.v) }
    case 'd': return { cell: { kind: 'bad', reason: 'DATE' }, raw: String(cell.w ?? cell.v) }
    default: return { cell: { kind: 'bad', reason: 'ERROR' }, raw: String(cell.w ?? '#ERR') }
  }
}

export function parseCmsImportXlsx(bytes: Uint8Array): CmsParseResult {
  // .xlsx là ZIP (PK\x03\x04). Thư viện xlsx còn đọc được CSV / HTML / .xls ⇒ chặn trước, không đoán định dạng.
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    return { ok: false, error: 'NOT_XLSX' }
  }
  // Zip bomb: tổng giải nén khai báo / số entry vượt trần ⇒ từ chối, không giải nén.
  const zip = cmsZipGuard(bytes)
  if (!zip.ok) return { ok: false, error: zip.reason === 'NOT_ZIP' ? 'NOT_XLSX' : 'FILE_TOO_COMPLEX' }
  let wb: XLSX.WorkBook
  try {
    // cellDates:false ⇒ ngày là number + định dạng; cellNF giữ định dạng (z) để nhận diện ô ngày / giờ; cellFormula +
    // sheetStubs để thấy cả công thức không có giá trị cache; bool / err giữ kiểu.
    // Chỉ dựng sheet IMPORT_CMS; tối đa 50 dòng tìm header + 2.000 dòng + 2 (đủ phát hiện dòng thứ 2.001 ⇒ TOO_MANY_ROWS).
    wb = XLSX.read(bytes, {
      type: 'array', cellFormula: true, cellNF: true, cellHTML: false, cellText: false, dense: false, sheetStubs: true,
      sheets: CMS_IMPORT_SHEET, sheetRows: HEADER_SCAN_ROWS + CMS_IMPORT_MAX_ROWS + 2,
    })
  } catch {
    return { ok: false, error: 'NOT_XLSX' }
  }
  if (!wb.SheetNames || wb.SheetNames.length === 0) return { ok: false, error: 'NOT_XLSX' }
  const ws = wb.Sheets[CMS_IMPORT_SHEET]
  if (!ws || !ws['!ref']) return { ok: false, error: 'NO_SHEET' }
  const range = XLSX.utils.decode_range(ws['!ref'])

  // 1) Tìm header: dòng đầu tiên chứa ProductID theo tên.
  let headerRow = -1
  const colIndex = new Map<CmsImportColumn, number>()
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + HEADER_SCAN_ROWS - 1) && headerRow < 0; r++) {
    const found = new Map<CmsImportColumn, number>()
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = cellOf(ws, r, c)
      if (!cell || cell.t !== 's') continue
      const col = CANON_TO_COL.get(canonHeader(String(cell.v ?? '')))
      if (col && !found.has(col)) found.set(col, c)
    }
    if (found.has('ProductID')) { headerRow = r; for (const [k, v] of found) colIndex.set(k, v) }
  }
  if (headerRow < 0) return { ok: false, error: 'MISSING_COLUMNS', missing: [...CMS_IMPORT_COLUMNS] }
  const missing = CMS_IMPORT_COLUMNS.filter((c) => !colIndex.has(c))
  if (missing.length) return { ok: false, error: 'MISSING_COLUMNS', missing }

  // 2) Đọc dữ liệu tới dòng ProductID trống đầu tiên.
  const pidCol = colIndex.get('ProductID')!
  const rows: CmsImportRawRow[] = []
  let r = headerRow + 1
  for (; r <= range.e.r; r++) {
    if (isBlank(cellOf(ws, r, pidCol))) break
    if (rows.length >= CMS_IMPORT_MAX_ROWS) return { ok: false, error: 'TOO_MANY_ROWS' }
    const cells = {} as Record<CmsImportColumn, CmsCell>
    const raw = {} as Record<CmsImportColumn, string | number | null>
    for (const col of CMS_IMPORT_COLUMNS) {
      const v = readCell(cellOf(ws, r, colIndex.get(col)!))
      cells[col] = v.cell
      raw[col] = v.raw
    }
    rows.push({ excelRow: r + 1, cells, raw })
  }
  if (rows.length === 0) return { ok: false, error: 'NO_DATA' }

  // 3) Nội dung sau điểm dừng (bất kỳ cột nào) ⇒ notice, không nhập.
  let ignoredFromRow: number | null = null
  // Tính cả chính dòng dừng (ProductID trống nhưng cột khác có nội dung).
  for (let rr = r; rr <= range.e.r && ignoredFromRow === null; rr++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (!isBlank(cellOf(ws, rr, c))) { ignoredFromRow = rr + 1; break }
    }
  }
  return { ok: true, headerRow: headerRow + 1, rows, ignoredFromRow }
}
