import { CARE_IMPORT_HEADERS, CARE_IMPORT_MAX_ROWS } from './contract'
import { decodeCareCsv, parseCsvRecords, toCareCsv } from './csvCore'
import { CARE_CSV_BLANK_SLACK, CARE_CSV_MAX_FIELDS } from './parse'

// PM 22/11/2026 — "Loại khỏi lần nhập": dựng FILE LÀM VIỆC từ file đã kiểm tra, bỏ đúng các bản ghi mà preview của server
// chỉ ra (khách đã từ chối chăm sóc tại cửa hàng đích). Module THUẦN (trình duyệt + test), không IO.
//
// Đánh số = của parser (lib/care/import/parse.ts): header là bản ghi 1, bản ghi thứ i (0-based) ⇒ dòng i + 1 — theo BẢN GHI CSV,
// không theo dòng văn bản (một ô có xuống dòng vẫn là một bản ghi). Ô giữ NGUYÊN VĂN (không trim): số 0 đầu SĐT, dấu tiếng Việt,
// dấu phẩy / nháy / xuống dòng trong ô được ghi lại bằng toCareCsv (BOM UTF-8 + CRLF + bọc nháy tối thiểu) ⇒ GIÁ TRỊ 10 cột của
// các dòng còn lại không đổi, byte của file có thể khác bản gốc. Server vẫn parse / kiểm / finalize lại trên chính file này.

export type CareExcludeResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; removed: number; remaining: number }
  /** DECODE / PARSE: file không còn đọc được như lúc kiểm tra · ROW_RANGE: số dòng không thuộc file này · EMPTY: loại xong không còn dòng dữ liệu. */
  | { ok: false; reason: 'DECODE' | 'PARSE' | 'ROW_RANGE' | 'EMPTY' }

const isBlank = (fields: readonly string[]) => fields.every((f) => f.trim() === '')

export function excludeCareCsvRows(buf: Uint8Array, rowNos: readonly number[]): CareExcludeResult {
  const dec = decodeCareCsv(buf)
  if (!dec.ok) return { ok: false, reason: 'DECODE' }
  const parsed = parseCsvRecords(dec.text, { maxRecords: CARE_IMPORT_MAX_ROWS + 1 + CARE_CSV_BLANK_SLACK, maxFields: CARE_CSV_MAX_FIELDS })
  if (!parsed.ok) return { ok: false, reason: 'PARSE' }
  const records = parsed.records
  const drop = new Set(rowNos)
  // Mọi số dòng phải là bản ghi DỮ LIỆU có thật, không trống, của chính file này (2 … số bản ghi) — lệch ⇒ không đoán.
  for (const n of drop) {
    if (!Number.isInteger(n) || n < 2 || n > records.length || isBlank(records[n - 1])) return { ok: false, reason: 'ROW_RANGE' }
  }
  if (drop.size === 0 || records.length === 0 || records[0].length < CARE_IMPORT_HEADERS.length) return { ok: false, reason: 'ROW_RANGE' }
  const kept = records.filter((_, i) => i === 0 || !drop.has(i + 1))
  const remaining = kept.slice(1).filter((r) => !isBlank(r)).length
  if (remaining === 0) return { ok: false, reason: 'EMPTY' }
  return { ok: true, bytes: new TextEncoder().encode(toCareCsv(kept, true)), removed: drop.size, remaining }
}
