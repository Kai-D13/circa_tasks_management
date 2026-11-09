// CMS-UNIT (planning/research/cms-unit-basis-spec-implementation-2026-11-09.md §3.1 / §4; Q-221…Q-224, UNIT-D01…D05) — cơ sở tính số
// lượng CMS của chương trình / run. Luật theo CHƯƠNG TRÌNH (cms_programs.quantity_basis), metadata theo RUN (cms_sync_runs — DB ghi
// lúc open, bất biến; migration 128). Hàm thuần, không I/O.
//  · pos_base  — luật cũ: Q = floor(max(ΣB, 0) / K).
//  · cms_unit  — chỉ dòng bán đúng "ĐV tính CMS (1 item)" đóng góp lượng = quantity_raw (số nguyên); khác đơn vị ⇒ 0 (vẫn giữ GMV /
//                lineage); lượng lẻ / hỏng / đơn vị thiếu ở dòng ứng viên ⇒ HOLD cả lượt (không làm tròn, không bỏ dòng).

/** Cơ sở tính số lượng CMS. */
export type CmsQuantityBasis = 'pos_base' | 'cms_unit'
export const CMS_QUANTITY_BASES: readonly CmsQuantityBasis[] = ['pos_base', 'cms_unit']

/** Phiên bản chính sách tính của run (cùng hợp đồng cms__basis_policy — migration 128). */
export type CmsCalcPolicyVersion = 'pos_base_legacy' | 'pos_base_v1' | 'cms_unit_v1'
export const CMS_BASIS_POLICY: Readonly<Record<CmsQuantityBasis, Exclude<CmsCalcPolicyVersion, 'pos_base_legacy'>>> = {
  pos_base: 'pos_base_v1',
  cms_unit: 'cms_unit_v1',
}
/** Run bán tạo TRƯỚC migration 128 (backfill — không có snapshot cấu hình tính). */
export const CMS_POS_BASE_LEGACY_POLICY = 'pos_base_legacy'
/** schema của cms_sync_runs.calculation_snapshot (migration 128 cms__calc_snapshot). */
export const CMS_CALC_SNAPSHOT_SCHEMA = 'cms-calc-snapshot-v1'

export function isCmsQuantityBasis(v: unknown): v is CmsQuantityBasis {
  return v === 'pos_base' || v === 'cms_unit'
}

/**
 * Mã HOLD / lỗi của nhánh cms_unit (app). DB có mã riêng ở seal (SEAL_UNIT_SOURCE / BASIS_WRITER_MISMATCH / RUN_BASIS_INVALID —
 * scripts/gen-cms-128.mjs CMS_128_CODES).
 */
export const CMS_UNIT_CODES = {
  /** Chương trình cms_unit nhưng cờ CMS_UNIT_BASIS_ENABLED tắt ⇒ run đóng `held` ngay sau snapshot — không stage / công bố số mới, pointer
   *  giữ nguyên (không lùi về luật cũ). */
  disabled: 'UNIT_BASIS_DISABLED',
  /** DB chưa có capability 128 (snapshot thiếu khoá cơ sở) mà chương trình / yêu cầu cần cms_unit. */
  dbUnsupported: 'UNIT_BASIS_DB_UNSUPPORTED',
  /** Dòng ứng viên thiếu / sai đơn vị hoặc số lượng ⇒ HOLD cả lượt (UNIT-D01). */
  sourceInvalid: 'UNIT_SOURCE_INVALID',
  /** Dòng đúng ĐV CMS có lượng lẻ ⇒ HOLD cả lượt (Q-223 — không làm tròn, không cộng 0,5 + 0,5). */
  fraction: 'UNIT_QUANTITY_FRACTION',
  /** Metadata cơ sở / phiên bản của run lạ hoặc không khớp chương trình ⇒ lỗi, không tự chọn pos_base. */
  metaInvalid: 'UNIT_BASIS_META_INVALID',
} as const

/** Nhãn ngắn hiển thị cơ sở tính (super / XLSX / lịch sử). */
export const CMS_BASIS_LABEL: Readonly<Record<CmsQuantityBasis, string>> = {
  pos_base: 'Theo lượng cơ sở POS (luật cũ)',
  cms_unit: 'Theo ĐV tính CMS',
}

/**
 * Nhãn mã HOLD / lỗi của cơ sở cms_unit (app + seal 128) để super xử lý — hiện CẠNH mã cố định (không thay mã, không message DB).
 */
export const CMS_UNIT_HOLD_LABEL: Readonly<Record<string, string>> = {
  UNIT_BASIS_DISABLED: 'Cờ tính theo ĐV tính CMS đang tắt — chưa tính chương trình này',
  UNIT_BASIS_DB_UNSUPPORTED: 'CSDL chưa hỗ trợ cách tính theo ĐV tính CMS',
  UNIT_SOURCE_INVALID: 'Nguồn bán thiếu / sai đơn vị hoặc số lượng — giữ số cũ',
  UNIT_QUANTITY_FRACTION: 'Có dòng bán số lượng lẻ ở ĐV tính CMS — giữ số cũ',
  UNIT_BASIS_META_INVALID: 'Metadata cách tính của lần tính không hợp lệ',
  SEAL_UNIT_SOURCE: 'CSDL kiểm lại nguồn đơn vị / số lượng không đạt — giữ số cũ',
  BASIS_WRITER_MISMATCH: 'Bản ghi số dùng sai cách tính so với lần tính — giữ số cũ',
  RUN_BASIS_INVALID: 'Cách tính của lần tính không hợp lệ — giữ số cũ',
  CMS_UNIT_ATTESTATION_NOT_SUPPORTED: 'Chưa hỗ trợ chứng nhận nguồn cho cách tính theo ĐV tính CMS',
}

/** Diễn giải dòng bán khác đơn vị (UNIT-D03). */
export const CMS_OTHER_UNIT_TEXT = 'Đơn vị bán khác ĐV tính CMS — không tính CMS'

export interface CmsRunBasis {
  basis: CmsQuantityBasis
  policy: CmsCalcPolicyVersion
  /** Run bán tạo trước 128 / DB chưa có 128 (đọc như pos_base luật cũ, không có snapshot cấu hình tính). */
  legacy: boolean
}

export class CmsBasisMetaError extends Error {
  readonly code = CMS_UNIT_CODES.metaInvalid
  constructor(message: string) {
    super(`CMS basis meta: ${message}`)
    this.name = 'CmsBasisMetaError'
  }
}

/**
 * Đọc metadata cơ sở của một run bán từ DTO DB (header / rows / snapshot open). Chỉ fallback legacy khi DB thật sự thuộc hợp đồng
 * cũ: KHÔNG có cả hai khoá (DB trước 128). Có khoá ⇒ phải đúng cặp hợp lệ; null / enum / phiên bản lạ ⇒ CmsBasisMetaError (không tự
 * chọn pos_base — PM §3.1).
 */
export function parseCmsRunBasis(o: Record<string, unknown>,
  keys: { basis: string; policy: string } = { basis: 'quantity_basis', policy: 'calculation_policy_version' }): CmsRunBasis {
  const hasB = Object.prototype.hasOwnProperty.call(o, keys.basis)
  const hasP = Object.prototype.hasOwnProperty.call(o, keys.policy)
  if (!hasB && !hasP) return { basis: 'pos_base', policy: CMS_POS_BASE_LEGACY_POLICY, legacy: true }
  const b = o[keys.basis]
  const p = o[keys.policy]
  if (b === 'pos_base' && p === CMS_POS_BASE_LEGACY_POLICY) return { basis: 'pos_base', policy: CMS_POS_BASE_LEGACY_POLICY, legacy: true }
  if (isCmsQuantityBasis(b) && p === CMS_BASIS_POLICY[b]) return { basis: b, policy: CMS_BASIS_POLICY[b], legacy: false }
  throw new CmsBasisMetaError(`cặp cơ sở / phiên bản không hợp lệ (${String(b)} / ${String(p)})`)
}
