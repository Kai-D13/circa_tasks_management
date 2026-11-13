// CMS-CALC-RET-2 (planning/research/cms-calculation-modes-returns-spec-2026-11-13.md §3.4; Q-231) — khoá so khớp đơn vị và đọc lượng
// gốc cho mode `cms_unit` ("Tính nguyên — đúng đơn vị CMS"). TÁI DÙNG nguyên thân hàm hợp đồng `cms-unit-key-v2` của nhánh CMS-UNIT
// (blob 7d09034 webapp/lib/cms/unitKey.ts dòng 19–87, giữ đúng byte — sha256 thân ghi ở report CMS-CALC-RET-2 P1). KHÔNG tái dùng
// classifier cũ của nhánh đó (lượng lẻ ⇒ HOLD): luật Q-231 phân loại dòng đúng ĐV có lượng lẻ là FRACTIONAL_QUANTITY (không thưởng,
// vẫn tính GMV) — xem lib/cms/calc/classify.ts.
//  · Khoá đơn vị: ký tự điều khiển C0 / DEL / C1 hoặc ký tự định dạng / vô hình thuộc tập tường minh CMS_UNIT_INVISIBLE (BMP) ở bất kỳ
//    vị trí nào ⇒ null (kiểm trên chuỗi THÔ, trước NFC / cắt; không xoá để ép khớp). NFC; cắt khoảng trắng hai đầu theo tập tường minh
//    (gồm NBSP); chữ hoa → thường theo bảng tường minh (đủ tiếng Việt), KHÔNG toLowerCase / lower() (phụ thuộc locale DB). Không bỏ dấu,
//    không alias (box ≠ hộp, hop ≠ hộp, vỉ ≠ viên), không gộp khoảng trắng giữa chữ, không so khớp mờ. Rỗng sau cắt ⇒ null. Tập vô hình
//    chỉ BMP, không tuyên bố bao trọn Unicode — ngoài tập phải bổ sung test + đổi phiên bản.
//  · Lượng gốc: chuỗi thập phân chính xác (dấu chấm, ≤ 9 chữ số lẻ, ≤ 29 chữ số nguyên, có thể âm; không khoảng trắng / số mũ).
// Bản SQL (parity) sinh lại trong migration được PM cấp số — KHÔNG dùng lại SQL 128 của CMS-UNIT. Comment trong thân còn nhắc
// "migration 128" / "gen-cms-128.mjs" và import CMS_DEC_FACTOR không dùng: giữ nguyên để thân trùng byte với blob gốc (bằng chứng tái
// dùng); 128 / 129 không triển khai — generator / migration mới thay khi được cấp số. Hàm thuần, không I/O.
import { CMS_DEC_FACTOR, parseCmsDecimal, type CmsDecError } from './decimal'

/** Phiên bản hợp đồng khoá đơn vị (ghi trong calculation_snapshot của run — migration 128). */
export const CMS_UNIT_KEY_VERSION = 'cms-unit-key-v2'

/** Khoảng trắng được cắt ở HAI ĐẦU (tường minh). Tab / xuống dòng… là ký tự điều khiển ⇒ đơn vị không hợp lệ, không cắt. v2: không còn
 *  U+FEFF (thuộc CMS_UNIT_INVISIBLE). */
export const CMS_UNIT_WS = '                  　'

/** r1 Q-225: khoảng ký tự định dạng / vô hình làm đơn vị KHÔNG HỢP LỆ (cặp [đầu, cuối] code point, gồm hai đầu). SQL cms__unit_key sinh
 *  lớp ký tự từ CHÍNH hằng này (scripts/gen-cms-128.mjs). */
export const CMS_UNIT_INVISIBLE: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x0600, 0x0605], [0x061c, 0x061c], [0x06dd, 0x06dd], [0x070f, 0x070f], [0x0890, 0x0891],
  [0x08e2, 0x08e2], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f],
  [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfffb],
]

/** Bảng chữ HOA → thường tường minh (243 cặp, cùng thứ tự; sinh một lần bằng toLowerCase + kiểm khứ hồi + NFC — xem harness). */
export const CMS_UNIT_CASE_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽƠƯḀḂḄḆḈḊḌḎḐḒḔḖḘḚḜḞḠḢḤḦḨḪḬḮḰḲḴḶḸḺḼḾṀṂṄṆṈṊṌṎṐṒṔṖṘṚṜṞṠṢṤṦṨṪṬṮṰṲṴṶṸṺṼṾẀẂẄẆẈẊẌẎẐẒẔẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸỺỼỾ'
export const CMS_UNIT_CASE_LOWER = 'abcdefghijklmnopqrstuvwxyzàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþāăąćĉċčďđēĕėęěĝğġģĥħĩīĭįĳĵķĺļľŀłńņňŋōŏőœŕŗřśŝşšţťŧũūŭůűųŵŷÿźżžơưḁḃḅḇḉḋḍḏḑḓḕḗḙḛḝḟḡḣḥḧḩḫḭḯḱḳḵḷḹḻḽḿṁṃṅṇṉṋṍṏṑṓṕṗṙṛṝṟṡṣṥṧṩṫṭṯṱṳṵṷṹṻṽṿẁẃẅẇẉẋẍẏẑẓẕạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹỻỽỿ'

// Ký tự điều khiển C0 + DEL + C1 — cùng lớp CONTROL_RE của source/contract.ts và regex stage 122 (U+0000 không có trong text PG).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/
const hex4 = (n: number) => n.toString(16).padStart(4, '0')
const INVISIBLE_RE = new RegExp(`[${CMS_UNIT_INVISIBLE.map(([a, b]) => (a === b ? `\\u${hex4(a)}` : `\\u${hex4(a)}-\\u${hex4(b)}`)).join('')}]`)

/** Chuỗi THÔ (trước mọi trim / NFC) có ký tự điều khiển hoặc ký tự vô hình CMS_UNIT_INVISIBLE ⇒ không dùng làm / so khớp ĐV được. Dùng
 *  ở adapter nguồn (marker rawControl) và import (unit_CMS) — cùng hợp đồng cmsUnitKey. */
export const cmsUnitRawFlags = (v: string | null | undefined): { control: boolean; invisible: boolean } => ({
  control: typeof v === 'string' && CONTROL_RE.test(v),
  invisible: typeof v === 'string' && INVISIBLE_RE.test(v),
})
const WS = new Set([...CMS_UNIT_WS])
const LOWER = new Map<string, string>()
{
  const up = [...CMS_UNIT_CASE_UPPER]
  const lo = [...CMS_UNIT_CASE_LOWER]
  if (up.length !== lo.length) throw new Error('CMS unitKey: bảng chữ hoa / thường lệch độ dài')
  up.forEach((u, i) => LOWER.set(u, lo[i]))
}

/** Khoá so khớp đơn vị (null = không hợp lệ / thiếu). Cùng hợp đồng cms__unit_key (migration 128). */
export function cmsUnitKey(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  if (CONTROL_RE.test(v) || INVISIBLE_RE.test(v)) return null
  const cps = [...v.normalize('NFC')]
  let a = 0
  let b = cps.length
  while (a < b && WS.has(cps[a])) a++
  while (b > a && WS.has(cps[b - 1])) b--
  if (a === b) return null
  let out = ''
  for (let i = a; i < b; i++) out += LOWER.get(cps[i]) ?? cps[i]
  return out
}

/** Chuỗi lượng có đúng hình thức thập phân (không cắt khoảng trắng — nguồn đã chuẩn hoá; khác hình thức ⇒ không hợp lệ). */
const QTY_RE = /^-?[0-9]+(\.[0-9]+)?$/

export type CmsUnitQuantity = { ok: true; units: bigint } | { ok: false; error: CmsDecError }

/** Đọc quantity_raw chính xác scale 9 (cùng hợp đồng cms__qty_dec). null / rỗng ⇒ EMPTY; sai hình thức ⇒ FORMAT. */
export function cmsUnitQuantity(raw: string | null | undefined): CmsUnitQuantity {
  if (typeof raw !== 'string' || raw === '') return { ok: false, error: 'EMPTY' }
  if (!QTY_RE.test(raw)) return { ok: false, error: 'FORMAT' }
  return parseCmsDecimal(raw, { allowNegative: true })
}
