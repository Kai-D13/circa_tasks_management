import * as XLSX from 'xlsx'
import {
  CARE_IMPORT_HEADERS, CARE_IMPORT_MAX_ROWS, CARE_IMPORT_SHEET,
  type CareFileErrorCode, type CareImportField, type CareImportRow, type CareRowError,
} from './contract'

// CRM-CSKH B2 — đọc file Excel N1 thành dòng chuỗi (SPEC B2 §1). THUẦN (không IO).
//
// Quy tắc:
//   · Chỉ .xlsx (chữ ký ZIP "PK\x03\x04") — SheetJS vốn nuốt cả CSV/HTML, nên
//     kiểm chữ ký trước khi đọc.
//   · Đúng MỘT sheet tên KhachHang; dòng 1 đúng 10 header theo thứ tự, không cột dư.
//   · KHÔNG đánh giá công thức: ô có công thức ⇒ FORMULA_NOT_ALLOWED.
//   · Q-73 (PM chốt 08/10): `customer_external_id` và `product_id` phải là ô TEXT —
//     ô SỐ ⇒ CELL_NOT_TEXT (Excel đã có thể làm mất số 0 đầu/độ chính xác, không
//     phát hiện được sau khi đọc). SĐT dạng số vẫn nhận vì chuẩn hoá thêm lại số 0
//     thành số di động VN 10 chữ số (normalizeVnPhone). Cột khác nhận số như chuỗi.
//   · Mọi ô đọc thành chuỗi đã trim.
//   · Dòng trống ở CUỐI bỏ qua; dòng trống XEN GIỮA ⇒ BLANK_ROW (staging cần
//     row_no liên tục — finalize 114 kiểm).
//   · Đọc tối đa CARE_IMPORT_MAX_ROWS + 1 dòng (sheetRows) ⇒ file khổng lồ không
//     bị parse hết vào bộ nhớ.

const ID_FIELDS = new Set<CareImportField>(['customer_external_id', 'product_id'])

export type CareParseResult =
  | { ok: true; rows: CareImportRow[]; errors: CareRowError[] }
  | { ok: false; fileError: CareFileErrorCode }

export function isXlsxSignature(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
}

/** Trần giải nén: file 10.000 dòng thật ~5–10 MB XML (đo 08/10) ⇒ 64 MB dư ~6 lần. */
export const CARE_XLSX_MAX_UNCOMPRESSED = 64 * 1024 * 1024
export const CARE_XLSX_MAX_ENTRIES = 200

/**
 * Chống "zip bomb" (security B2 P1): đọc central directory của ZIP và cộng kích
 * thước giải nén KHAI BÁO trước khi để SheetJS inflate. Không đọc được / ZIP64 /
 * vượt trần ⇒ false. Giới hạn còn lại: kích thước khai báo có thể bị làm giả —
 * lớp bảo vệ tiếp theo là trần byte nén 8 MiB + sheetRows; cô lập parse trong
 * worker có giới hạn bộ nhớ là việc của batch sau nếu cần.
 */
export function zipWithinLimits(buf: Uint8Array, maxUncompressed = CARE_XLSX_MAX_UNCOMPRESSED, maxEntries = CARE_XLSX_MAX_ENTRIES): boolean {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return false
  const entries = dv.getUint16(eocd + 10, true)
  const cdOffset = dv.getUint32(eocd + 16, true)
  if (entries === 0xffff || cdOffset === 0xffffffff || entries > maxEntries) return false
  let p = cdOffset
  let total = 0
  for (let k = 0; k < entries; k++) {
    if (p + 46 > buf.byteLength || dv.getUint32(p, true) !== 0x02014b50) return false
    const size = dv.getUint32(p + 24, true)
    if (size === 0xffffffff) return false // ZIP64 — file Excel thường không cần
    total += size
    if (total > maxUncompressed) return false
    p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true)
  }
  return true
}

function cellText(cell: XLSX.CellObject | undefined, field: CareImportField): { value: string; bad: boolean } {
  if (!cell || cell.t === 'z' || cell.v === undefined || cell.v === null) return { value: '', bad: false }
  if (cell.t === 's') return { value: String(cell.v).trim(), bad: false }
  if (cell.t === 'n' && typeof cell.v === 'number' && Number.isFinite(cell.v)) {
    if (ID_FIELDS.has(field)) return { value: '', bad: true } // Q-73: ID phải là ô Text
    return { value: String(cell.v), bad: false }
  }
  // 'b' boolean, 'd' date, 'e' error, số vô hạn…
  return { value: '', bad: true }
}

export function parseCareImportXlsx(buf: Uint8Array, maxRows = CARE_IMPORT_MAX_ROWS): CareParseResult {
  if (!isXlsxSignature(buf) || !zipWithinLimits(buf)) return { ok: false, fileError: 'WORKBOOK_INVALID' }
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(buf, {
      type: 'buffer', cellFormula: true, cellHTML: false, cellNF: false, cellStyles: false,
      cellDates: false, sheetRows: maxRows + 2, // header + maxRows + 1 dòng để phát hiện vượt
    })
  } catch {
    return { ok: false, fileError: 'WORKBOOK_INVALID' }
  }
  if (wb.SheetNames.length !== 1 || wb.SheetNames[0] !== CARE_IMPORT_SHEET) return { ok: false, fileError: 'SHEET_INVALID' }
  const ws = wb.Sheets[CARE_IMPORT_SHEET]
  if (!ws || !ws['!ref']) return { ok: false, fileError: 'NO_ROWS' }

  const range = XLSX.utils.decode_range(ws['!ref'])
  // Header: A1..J1 đúng tên/thứ tự; không ô nào khác ở dòng 1 có giá trị.
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })] as XLSX.CellObject | undefined
    const v = cell && cell.v !== undefined && cell.v !== null ? String(cell.v).trim() : ''
    if (c < CARE_IMPORT_HEADERS.length) {
      if (v !== CARE_IMPORT_HEADERS[c] || cell?.f) return { ok: false, fileError: 'HEADER_INVALID' }
    } else if (v !== '') {
      return { ok: false, fileError: 'HEADER_INVALID' }
    }
  }
  if (range.s.c !== 0 || range.e.c < CARE_IMPORT_HEADERS.length - 1 || range.s.r !== 0) {
    return { ok: false, fileError: 'HEADER_INVALID' }
  }

  // SheetJS ghi !fullref khi sheetRows cắt bớt ⇒ file có nhiều dòng hơn đã đọc.
  const full = ws['!fullref'] ? XLSX.utils.decode_range(ws['!fullref'] as string) : range

  const rows: CareImportRow[] = []
  const errors: CareRowError[] = []
  const blankRows: number[] = []
  for (let r = 1; r <= range.e.r; r++) {
    const rowNo = r + 1
    const row = { rowNo } as CareImportRow
    let empty = true
    let bad = false
    let formula = false
    CARE_IMPORT_HEADERS.forEach((field, c) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined
      if (cell?.f) formula = true
      const { value, bad: b } = cellText(cell, field)
      if (b) bad = true
      if (value !== '' || b || cell?.f) empty = false
      row[field] = value
    })
    if (empty) { blankRows.push(rowNo); continue }
    // Dòng trống trước dòng có dữ liệu này ⇒ dòng trống xen giữa.
    for (const b of blankRows) errors.push({ row: b, code: 'BLANK_ROW' })
    blankRows.length = 0
    if (formula) errors.push({ row: rowNo, code: 'FORMULA_NOT_ALLOWED' })
    if (bad) errors.push({ row: rowNo, code: 'CELL_NOT_TEXT' })
    rows.push(row)
  }
  if (rows.length === 0) return { ok: false, fileError: 'NO_ROWS' }
  // Dòng dữ liệu cuối cùng (kể cả phần bị sheetRows cắt) vượt trần ⇒ từ chối cả file.
  if (rows.length > maxRows || full.e.r > range.e.r) return { ok: false, fileError: 'TOO_MANY_ROWS' }
  return { ok: true, rows, errors }
}
