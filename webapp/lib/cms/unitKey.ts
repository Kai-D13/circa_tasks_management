// CMS-UNIT (planning/research/cms-unit-basis-spec-implementation-2026-11-09.md §2; Q-221 / Q-223 / UNIT-D01) — hợp đồng CHUNG
// TS ↔ SQL cho cơ sở tính `cms_unit`. Bản SQL là cms__unit_key / cms__qty_dec của migration 128 (scripts/gen-cms-128.mjs SINH thân
// hàm SQL từ CHÍNH các hằng dưới đây — đổi hằng ⇒ sinh lại 128 + harness parity TS ↔ PG15 ↔ PGlite).
//  · Khoá đơn vị: có ký tự điều khiển C0 / DEL / C1 ⇒ KHÔNG HỢP LỆ (null — báo chất lượng nguồn, KHÔNG xoá để thành đơn vị có vẻ
//    hợp lệ); chuẩn hoá NFC; cắt khoảng trắng HAI ĐẦU theo TẬP TƯỜNG MINH (gồm NBSP — cùng tập String.prototype.trim ngoài ký tự
//    điều khiển); chữ hoa → thường theo BẢNG TƯỜNG MINH (ASCII, Latin-1, Latin Extended-A, Ơ / Ư, Latin Extended Additional — đủ
//    tiếng Việt), KHÔNG dùng toLowerCase / lower() vì lower() của Postgres phụ thuộc locale DB (PGlite locale C chỉ hạ ASCII).
//    Ký tự ngoài bảng giữ nguyên (so phân biệt hoa thường). Không xoá dấu, không alias (box ≠ hộp, h ≠ hộp, vỉ ≠ viên), không gộp
//    khoảng trắng giữa chữ, không cắt độ dài để so, không so khớp mờ. Rỗng sau khi cắt ⇒ null.
//  · Lượng: chuỗi thập phân CHÍNH XÁC đúng hợp đồng decimal.ts (dấu chấm, ≤ 9 chữ số lẻ, ≤ 29 chữ số nguyên sau bỏ số 0 đầu, có thể
//    âm, KHÔNG khoảng trắng / số mũ / dấu phân cách) — không Number / float. Đúng ĐV CMS ⇒ phải là số NGUYÊN (1.000000000 = 1 nhận;
//    0.5 / 1.000000001 ⇒ lẻ ⇒ HOLD, không làm tròn, không cộng 0,5 + 0,5) trong miền bigint.
// Hàm thuần, không I/O.

import { CMS_DEC_FACTOR, parseCmsDecimal, type CmsDecError } from './decimal'

/** Phiên bản hợp đồng khoá đơn vị (ghi trong calculation_snapshot của run — migration 128). */
export const CMS_UNIT_KEY_VERSION = 'cms-unit-key-v1'

/** Khoảng trắng được cắt ở HAI ĐẦU (tường minh). Tab / xuống dòng… là ký tự điều khiển ⇒ đơn vị không hợp lệ, không cắt. */
export const CMS_UNIT_WS = '                  　﻿'

/** Bảng chữ HOA → thường tường minh (243 cặp, cùng thứ tự; sinh một lần bằng toLowerCase + kiểm khứ hồi + NFC — xem harness). */
export const CMS_UNIT_CASE_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽƠƯḀḂḄḆḈḊḌḎḐḒḔḖḘḚḜḞḠḢḤḦḨḪḬḮḰḲḴḶḸḺḼḾṀṂṄṆṈṊṌṎṐṒṔṖṘṚṜṞṠṢṤṦṨṪṬṮṰṲṴṶṸṺṼṾẀẂẄẆẈẊẌẎẐẒẔẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸỺỼỾ'
export const CMS_UNIT_CASE_LOWER = 'abcdefghijklmnopqrstuvwxyzàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþāăąćĉċčďđēĕėęěĝğġģĥħĩīĭįĳĵķĺļľŀłńņňŋōŏőœŕŗřśŝşšţťŧũūŭůűųŵŷÿźżžơưḁḃḅḇḉḋḍḏḑḓḕḗḙḛḝḟḡḣḥḧḩḫḭḯḱḳḵḷḹḻḽḿṁṃṅṇṉṋṍṏṑṓṕṗṙṛṝṟṡṣṥṧṩṫṭṯṱṳṵṷṹṻṽṿẁẃẅẇẉẋẍẏẑẓẕạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹỻỽỿ'

// Ký tự điều khiển C0 + DEL + C1 — cùng lớp CONTROL_RE của source/contract.ts và regex stage 122 (U+0000 không có trong text PG).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/
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
  if (CONTROL_RE.test(v)) return null
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
  | 'UNIT_INVALID'      // đơn vị có ký tự điều khiển / chỉ khoảng trắng
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
 * Phân loại một dòng ứng viên theo cơ sở cms_unit. `unitKey` = cmsUnitKey(unit_cms của SP). `rawControl` = nguồn thô của
 * quantity_raw / uom_raw có ký tự điều khiển (đã bị thay bằng khoảng trắng khi chuẩn hoá) ⇒ không hợp lệ.
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
