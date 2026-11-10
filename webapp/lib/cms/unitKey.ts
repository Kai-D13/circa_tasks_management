// CMS-UNIT (planning/research/cms-unit-basis-spec-implementation-2026-11-09.md §2; Q-221 / Q-223 / UNIT-D01) — hợp đồng CHUNG
// TS ↔ SQL cho cơ sở tính `cms_unit`. Bản SQL là cms__unit_key / cms__qty_dec của migration 128 (scripts/gen-cms-128.mjs SINH thân
// hàm SQL từ CHÍNH các hằng dưới đây — đổi hằng ⇒ sinh lại 128 + harness parity TS ↔ PG15 ↔ PGlite).
//  · Khoá đơn vị: có ký tự điều khiển C0 / DEL / C1 HOẶC ký tự định dạng / vô hình thuộc TẬP TƯỜNG MINH CMS_UNIT_INVISIBLE (r1 —
//    PM 10/11 Q-225 tối thiểu: U+00AD, 034F, 061C, 180E, 200B–200F, 202A–202E, 2060–206F, FEFF; Dev r1 bổ sung phần BMP còn lại
//    của Cf ∪ Default_Ignorable_Code_Point: 0600–0605, 06DD, 070F, 0890–0891, 08E2, 115F–1160, 17B4–17B5, 180B–180F, 3164, FE00–FE0F
//    (variation selector), FFA0, FFF0–FFFB) ở BẤT KỲ vị trí nào ⇒ KHÔNG HỢP LỆ (null — kiểm TRÊN CHUỖI THÔ, TRƯỚC NFC / cắt; không
//    xoá để ép khớp, không coi là "khác ĐV"). Tập này CHỈ BMP và không tuyên bố bao trọn mọi ký tự vô hình Unicode (ngoài tập: tag
//    E0000–E007F, VS E0100–E01EF, 1BCA0–1BCA3, 1D173–1D17A, chữ đồng dạng) — bổ sung phải có test / đặc tả + đổi phiên bản. Chuẩn hoá NFC; cắt khoảng trắng HAI ĐẦU theo TẬP TƯỜNG MINH
//    (gồm NBSP; v2 bỏ U+FEFF khỏi tập cắt — FEFF là ký tự vô hình ⇒ không hợp lệ); chữ hoa → thường theo BẢNG TƯỜNG MINH (ASCII, Latin-1, Latin Extended-A, Ơ / Ư, Latin Extended Additional — đủ
//    tiếng Việt), KHÔNG dùng toLowerCase / lower() vì lower() của Postgres phụ thuộc locale DB (PGlite locale C chỉ hạ ASCII).
//    Ký tự ngoài bảng giữ nguyên (so phân biệt hoa thường). Không xoá dấu, không alias (box ≠ hộp, h ≠ hộp, vỉ ≠ viên), không gộp
//    khoảng trắng giữa chữ, không cắt độ dài để so, không so khớp mờ. Rỗng sau khi cắt ⇒ null.
//  · Lượng: chuỗi thập phân CHÍNH XÁC đúng hợp đồng decimal.ts (dấu chấm, ≤ 9 chữ số lẻ, ≤ 29 chữ số nguyên sau bỏ số 0 đầu, có thể
//    âm, KHÔNG khoảng trắng / số mũ / dấu phân cách) — không Number / float. Đúng ĐV CMS ⇒ phải là số NGUYÊN (1.000000000 = 1 nhận;
//    0.5 / 1.000000001 ⇒ lẻ ⇒ HOLD, không làm tròn, không cộng 0,5 + 0,5) trong miền bigint.
// Hàm thuần, không I/O.

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

export const CMS_INT64_MAX_UNITS = BigInt('9223372036854775807')

/** Lý do dòng ỨNG VIÊN không tính được theo cơ sở cms_unit ⇒ HOLD cả lượt (UNIT-D01), không bỏ dòng / không 0 giả. */
export type CmsUnitInvalidReason =
  | 'UNIT_MISSING'      // dòng không có đơn vị bán
  | 'UNIT_INVALID'      // đơn vị có ký tự điều khiển / ký tự vô hình (Q-225) / chỉ khoảng trắng
  | 'QTY_MISSING'       // không có số lượng gốc
  | 'QTY_INVALID'       // số lượng sai hình thức / quá 9 chữ số lẻ / quá 29 chữ số
  | 'QTY_FRACTION'      // đúng ĐV CMS nhưng lượng lẻ (Q-223)
  | 'QTY_RANGE'         // đúng ĐV CMS nhưng lượng ngoài miền bigint

export type CmsUnitLine =
  /** Đúng ĐV CMS, lượng nguyên (âm = điều chỉnh — cổng trả hàng xử lý). */
  | { kind: 'COUNTED'; qty: bigint; negative: boolean }
  /** Khác ĐV CMS — đóng góp 0 vào Q, vẫn giữ lineage / GMV. */
  | { kind: 'OTHER_UNIT'; negative: boolean }
  | { kind: 'INVALID'; reason: CmsUnitInvalidReason }

/**
 * Phân loại một dòng ứng viên theo cơ sở cms_unit. `unitKey` = cmsUnitKey(unit_cms của SP). `rawControl` = nguồn THÔ của
 * quantity_raw / uom_raw có ký tự điều khiển (đã bị thay bằng khoảng trắng khi chuẩn hoá) hoặc ký tự vô hình (r1 Q-225 — có thể đã bị
 * trim mất, vd. FEFF) ⇒ không hợp lệ.
 */
export function cmsClassifyUnitLine(
  line: { uomRaw: string | null; quantityRaw: string | null; rawControl?: { uom: boolean; quantity: boolean } },
  unitKey: string,
): CmsUnitLine {
  if (line.rawControl?.uom) return { kind: 'INVALID', reason: 'UNIT_INVALID' }
  if (line.uomRaw === null || line.uomRaw === '') return { kind: 'INVALID', reason: 'UNIT_MISSING' }
  const key = cmsUnitKey(line.uomRaw)
  if (key === null) return { kind: 'INVALID', reason: 'UNIT_INVALID' }
  if (line.rawControl?.quantity) return { kind: 'INVALID', reason: 'QTY_INVALID' }
  const q = cmsUnitQuantity(line.quantityRaw)
  if (!q.ok) return { kind: 'INVALID', reason: q.error === 'EMPTY' ? 'QTY_MISSING' : 'QTY_INVALID' }
  const negative = q.units < BigInt(0)
  if (key !== unitKey) return { kind: 'OTHER_UNIT', negative }
  if (q.units % CMS_DEC_FACTOR !== BigInt(0)) return { kind: 'INVALID', reason: 'QTY_FRACTION' }
  const qty = q.units / CMS_DEC_FACTOR
  if (qty > CMS_INT64_MAX_UNITS || -qty > CMS_INT64_MAX_UNITS) return { kind: 'INVALID', reason: 'QTY_RANGE' }
  return { kind: 'COUNTED', qty, negative }
}
