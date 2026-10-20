import {
  CARE_IMPORT_HEADERS, CARE_IMPORT_MAX_ROWS, careOneField,
  type CareFileErrorCode, type CareImportField, type CareImportRow, type CareRowError,
} from './contract'
import { decodeCareCsv, parseCsvRecords } from './csvCore'

// CRM-CSKH — đọc file N1 **CSV** thành dòng chuỗi (Q-124, 15/10/2026: CSV thay hẳn .xlsx ở import CRM). THUẦN (không IO).
//
// Quy tắc:
//   · UTF-8 nghiêm ngặt (BOM tuỳ chọn); nhị phân/.xlsx đổi đuôi ⇒ FILE_NOT_CSV; ANSI/UTF-16 ⇒ ENCODING_INVALID
//     (Excel: "Lưu thành → CSV UTF-8"). Không đoán mã hoá.
//   · Dấu phẩy, nháy kép RFC 4180 (csvCore.ts); nháy hỏng ⇒ CSV_MALFORMED. Tiêu đề dùng `;`/tab (Excel vùng Việt Nam)
//     ⇒ DELIMITER_INVALID — không tự đổi dấu phân tách.
//   · Bản ghi 1 = đúng 10 header theo thứ tự (trường rỗng thừa ở cuối được bỏ qua) ⇒ HEADER_INVALID nếu sai.
//   · Mỗi bản ghi dữ liệu đúng 10 trường (trường RỖNG thừa ở cuối bỏ qua) ⇒ COLUMN_COUNT nếu sai.
//   · `row` = SỐ BẢN GHI (header = 1), không phải số dòng vật lý (ô có xuống dòng).
//   · Mọi giá trị là CHUỖI đã trim — ID/SĐT/product_id giữ nguyên số 0 đầu như trong file. ID ở dạng mũ
//     (`1.23457E+14` — Excel lưu ô số General) ⇒ ID_NOT_TEXT: dữ liệu đã hỏng trước khi tới app, không khôi phục được.
//   · CSV không có công thức: ô bắt đầu bằng `=` chỉ là chữ, không bao giờ được tính.
//   · Bản ghi trống ở CUỐI bỏ qua; bản ghi trống XEN GIỮA ⇒ BLANK_ROW (staging cần row_no liên tục — finalize 114 kiểm).
//   · Quá `maxRows` bản ghi dữ liệu ⇒ TOO_MANY_ROWS (cả file). Trần byte (8 MiB) đã chặn ở route TRƯỚC khi gọi hàm này.

export type CareParseResult =
  | { ok: true; rows: CareImportRow[]; errors: CareRowError[] }
  | { ok: false; fileError: CareFileErrorCode }

/**
 * `1.23457E+14`, `1,23457E+14` (Excel vùng Việt Nam dùng dấu phẩy thập phân — ô được bọc nháy trong CSV), `1E+15`… —
 * dạng Excel ghi ô số General có ≥ 12 chữ số.
 */
export const CARE_SCIENTIFIC_ID_RE = /^\d+([.,]\d+)?E\+\d+$/i
/** Bản ghi trống được phép thêm ngoài trần dòng trước khi dừng đọc (security Q-124 P1: file toàn dòng trống). */
export const CARE_CSV_BLANK_SLACK = 1_000
/** Số trường tối đa một bản ghi trước khi dừng đọc (10 cột + cột trống thừa Excel có thể ghi). */
export const CARE_CSV_MAX_FIELDS = 100
const ID_FIELDS: readonly CareImportField[] = ['customer_external_id', 'product_id']

const isBlank = (fields: readonly string[]) => fields.every((f) => f.trim() === '')
/** Bỏ các trường RỖNG ở cuối vượt quá 10 (Excel có thể ghi thêm cột trống) — trường thừa có dữ liệu giữ lại để báo lỗi. */
function trimTail(fields: string[]): string[] {
  let n = fields.length
  while (n > CARE_IMPORT_HEADERS.length && fields[n - 1].trim() === '') n--
  return fields.slice(0, n)
}

export function parseCareImportCsv(buf: Uint8Array, maxRows = CARE_IMPORT_MAX_ROWS): CareParseResult {
  const dec = decodeCareCsv(buf)
  if (!dec.ok) return { ok: false, fileError: dec.error }
  // Trần đọc: header + maxRows dòng dữ liệu + một khoảng dòng trống (xen giữa/cuối) ⇒ vượt là file quá dài, không đọc tiếp.
  const parsed = parseCsvRecords(dec.text, { maxRecords: maxRows + 1 + CARE_CSV_BLANK_SLACK, maxFields: CARE_CSV_MAX_FIELDS })
  if (!parsed.ok) return { ok: false, fileError: parsed.reason === 'TOO_MANY_RECORDS' ? 'TOO_MANY_ROWS' : 'CSV_MALFORMED' }
  const records = parsed.records
  while (records.length > 0 && isBlank(records[records.length - 1])) records.pop()
  if (records.length === 0) return { ok: false, fileError: 'NO_ROWS' }

  const head = trimTail(records[0]).map((h) => h.trim())
  const headerOk = head.length === CARE_IMPORT_HEADERS.length && head.every((h, i) => h === CARE_IMPORT_HEADERS[i])
  if (!headerOk) {
    // Một trường duy nhất chứa ; hoặc tab mà tách ra đúng các header ⇒ sai dấu phân tách (không phải sai cột).
    const one = head.length === 1 ? head[0] : ''
    for (const sep of [';', '\t']) {
      const parts = one.split(sep).map((x) => x.trim())
      if (parts.length > 1 && parts.slice(0, CARE_IMPORT_HEADERS.length).every((x, i) => x === CARE_IMPORT_HEADERS[i])) {
        return { ok: false, fileError: 'DELIMITER_INVALID' }
      }
    }
    return { ok: false, fileError: 'HEADER_INVALID' }
  }
  const data = records.slice(1)
  if (data.length === 0) return { ok: false, fileError: 'NO_ROWS' }
  // Như parser XLSX cũ: trần tính trên bản ghi CÓ dữ liệu (bản ghi trống xen giữa là lỗi BLANK_ROW riêng).
  if (data.filter((r) => !isBlank(r)).length > maxRows) return { ok: false, fileError: 'TOO_MANY_ROWS' }

  const rows: CareImportRow[] = []
  const errors: CareRowError[] = []
  const blankRows: number[] = []
  data.forEach((raw, i) => {
    const rowNo = i + 2
    if (isBlank(raw)) { blankRows.push(rowNo); return }
    // Bản ghi trống trước bản ghi có dữ liệu này ⇒ bản ghi trống xen giữa.
    for (const b of blankRows) errors.push({ row: b, code: 'BLANK_ROW' })
    blankRows.length = 0
    const fields = trimTail(raw)
    if (fields.length !== CARE_IMPORT_HEADERS.length) errors.push({ row: rowNo, code: 'COLUMN_COUNT' })
    const row = { rowNo } as CareImportRow
    CARE_IMPORT_HEADERS.forEach((f, c) => { row[f] = (fields[c] ?? '').trim() })
    if (fields.length === CARE_IMPORT_HEADERS.length) {
      const sci = ID_FIELDS.filter((f) => CARE_SCIENTIFIC_ID_RE.test(row[f]))
      if (sci.length) errors.push({ row: rowNo, code: 'ID_NOT_TEXT', ...careOneField(sci) })
    }
    rows.push(row)
  })
  return { ok: true, rows, errors }
}
