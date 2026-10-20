// CRM-CSKH Q-124 — lõi đọc/ghi CSV cho import N1 (THUẦN, không import gì). App (parse.ts, template.ts) và
// scripts/care-qa-fixture.mjs dùng CHUNG module này (Node 24 chạy thẳng .ts khi không có import nội bộ).
//
// Hợp đồng (PM 15/10): UTF-8 (BOM tuỳ chọn), dấu phẩy, nháy kép chuẩn RFC 4180 (`""` trong ô, ô bọc nháy được chứa
// dấu phẩy/xuống dòng), CRLF hoặc LF. Không đoán mã hoá hay dấu phân tách — sai ⇒ báo lỗi để người dùng lưu lại đúng.

export const CARE_CSV_BOM = String.fromCharCode(0xfeff)

export type CareCsvDecode =
  | { ok: true; text: string; bom: boolean }
  | { ok: false; error: 'FILE_NOT_CSV' | 'ENCODING_INVALID' }

/**
 * Bytes ⇒ chuỗi UTF-8 nghiêm ngặt. File nhị phân (ZIP/.xlsx đổi đuôi, .xls OLE, có byte NUL) ⇒ FILE_NOT_CSV;
 * UTF-16 (BOM FF FE / FE FF) hoặc byte không hợp lệ UTF-8 (vd "CSV" ANSI Windows-1258 của Excel) ⇒ ENCODING_INVALID.
 */
export function decodeCareCsv(buf: Uint8Array): CareCsvDecode {
  const b = (i: number) => buf[i]
  if (buf.length >= 4 && b(0) === 0x50 && b(1) === 0x4b && b(2) === 0x03 && b(3) === 0x04) return { ok: false, error: 'FILE_NOT_CSV' }
  if (buf.length >= 4 && b(0) === 0xd0 && b(1) === 0xcf && b(2) === 0x11 && b(3) === 0xe0) return { ok: false, error: 'FILE_NOT_CSV' }
  if (buf.length >= 2 && ((b(0) === 0xff && b(1) === 0xfe) || (b(0) === 0xfe && b(1) === 0xff))) return { ok: false, error: 'ENCODING_INVALID' }
  const bom = buf.length >= 3 && b(0) === 0xef && b(1) === 0xbb && b(2) === 0xbf
  const body = bom ? buf.subarray(3) : buf
  if (body.includes(0)) {
    // UTF-16 không BOM (chữ Latin ⇒ ~1/2 số byte là 0) ⇒ sai mã hoá; byte 0 lẻ tẻ ⇒ file nhị phân.
    const head = body.subarray(0, 256)
    const zeros = head.reduce((n, x) => n + (x === 0 ? 1 : 0), 0)
    return { ok: false, error: zeros * 3 >= head.length ? 'ENCODING_INVALID' : 'FILE_NOT_CSV' }
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), bom }
  } catch {
    return { ok: false, error: 'ENCODING_INVALID' }
  }
}

/**
 * RFC 4180, dấu phẩy. Trả mảng bản ghi (mỗi bản ghi là mảng trường thô, CHƯA trim). Nháy chỉ mở ở ĐẦU trường;
 * sau nháy đóng phải là dấu phẩy/xuống dòng/hết file; nháy không đóng hoặc nháy lạc trong trường không bọc ⇒ lỗi.
 * Dòng kết thúc file (CRLF/LF cuối cùng) không tạo bản ghi rỗng thừa.
 */
export type CareCsvRecords =
  | { ok: true; records: string[][] }
  | { ok: false; reason: 'MALFORMED' | 'TOO_MANY_RECORDS' | 'TOO_MANY_FIELDS' }

/**
 * `limits` (security Q-124 P1): dừng NGAY khi vượt số bản ghi / số trường một bản ghi — file 8 MiB toàn dòng trống
 * hay toàn dấu phẩy không được dựng hàng triệu mảng/chuỗi rỗng trên process dùng chung.
 */
export function parseCsvRecords(text: string, limits: { maxRecords?: number; maxFields?: number } = {}): CareCsvRecords {
  // Cắt theo đoạn (slice/indexOf) thay vì nối từng ký tự ⇒ ít chuỗi trung gian (file 20.000 dòng ~7 MB).
  const QUOTE = 34, COMMA = 44, CR = 13, LF = 10
  const maxRecords = limits.maxRecords ?? Infinity
  const maxFields = limits.maxFields ?? Infinity
  const n = text.length
  const records: string[][] = []
  let rec: string[] = []
  let i = 0
  while (i < n) {
    let value: string
    if (text.charCodeAt(i) === QUOTE) {
      let parts = ''
      let j = i + 1
      for (;;) {
        const q = text.indexOf('"', j)
        if (q < 0) return { ok: false, reason: 'MALFORMED' } // nháy không đóng
        if (text.charCodeAt(q + 1) === QUOTE) { parts += text.slice(j, q + 1); j = q + 2; continue } // "" ⇒ "
        parts += text.slice(j, q)
        i = q + 1
        break
      }
      value = parts
      const c = text.charCodeAt(i)
      if (i < n && c !== COMMA && c !== CR && c !== LF) return { ok: false, reason: 'MALFORMED' } // ký tự sau nháy đóng
    } else {
      let j = i
      for (; j < n; j++) {
        const c = text.charCodeAt(j)
        if (c === COMMA || c === CR || c === LF) break
        if (c === QUOTE) return { ok: false, reason: 'MALFORMED' } // nháy lạc giữa trường không bọc
      }
      value = text.slice(i, j)
      i = j
    }
    rec.push(value)
    if (rec.length > maxFields) return { ok: false, reason: 'TOO_MANY_FIELDS' }
    if (i >= n) break
    if (text.charCodeAt(i) === COMMA) {
      i++
      if (i >= n) rec.push('') // dấu phẩy cuối file ⇒ trường rỗng cuối
      continue
    }
    i += text.charCodeAt(i) === CR && text.charCodeAt(i + 1) === LF ? 2 : 1
    records.push(rec)
    if (records.length > maxRecords) return { ok: false, reason: 'TOO_MANY_RECORDS' }
    rec = []
  }
  if (rec.length) records.push(rec)
  if (records.length > maxRecords) return { ok: false, reason: 'TOO_MANY_RECORDS' }
  return { ok: true, records }
}

/** Một trường CSV: bọc nháy khi có dấu phẩy, nháy, xuống dòng hoặc khoảng trắng đầu/cuối. */
export function csvField(v: string): string {
  return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** Bảng ⇒ CSV (CRLF, kết thúc bằng CRLF). `bom` = true ⇒ Excel mở đúng tiếng Việt. */
export function toCareCsv(rows: readonly (readonly string[])[], bom = true): string {
  return (bom ? CARE_CSV_BOM : '') + rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n'
}
