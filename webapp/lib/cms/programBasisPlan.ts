// CMS-CALC-RET-2 P5.1 — quyết định đường lưu / kích hoạt chương trình theo cờ CMS_CALC_MODES_ENABLED + năng lực DB + cách tính hiện
// tại (spec §2, §6.1, §7; plan A/B §4). Thuần (server action nối I/O) ⇒ test được cả ma trận tương thích:
//   · App mới + DB trước 130 (pre130): chỉ RPC 121 như cũ; client gửi cách tính ⇒ từ chối (DB không hỗ trợ), không âm thầm bỏ.
//   · Cờ OFF: RPC 121 (DB tự gán pos_base / legacy_compat); client gửi cách tính ⇒ từ chối CMS_MODES_OFF (không tạo pos_base thầm).
//   · Cờ ON + đường program_modes: save_v2 bắt buộc một trong hai cách tính; chương trình đã kích hoạt không đổi được.
//   · Năng lực không xác định (lỗi tra / version lệch) khi cần đọc cách tính ⇒ dừng có mã (fail-closed), không đoán pos_base.

import { cmsBasisConfirmed, normalizeCmsBasisInput, type CmsProgramBasis, type CmsQuantityBasis } from './calc/basisUi'

export type CmsCapKind = 'pre130' | 'ok' | 'unavailable'

export interface CmsBasisEnv {
  /** cmsCalcFlags().modes (đã gồm program + earnings). */
  modesOn: boolean
  caps: CmsCapKind
  /** Đường program_modes bật (chỉ có nghĩa khi caps = 'ok'). */
  modesPath: boolean
}

export type CmsSavePlan =
  | { kind: 'legacy' }
  | { kind: 'v2'; basis: CmsQuantityBasis }
  | { kind: 'error'; code: CmsBasisPlanError }

export type CmsBasisPlanError =
  | 'CMS_BASIS_REQUIRED' | 'CMS_BASIS_IMMUTABLE' | 'CMS_BASIS_NOT_SET' | 'CMS_BASIS_NOT_CONFIRMED'
  | 'CMS_MODES_OFF' | 'CMS_MODES_UNSUPPORTED' | 'CMS_CAPS_UNAVAILABLE' | 'CMS_MODES_OFF_CMS_UNIT'

/** Form có hiện lựa chọn cách tính không (cờ ON + DB hỗ trợ). */
export function cmsBasisSelectable(env: CmsBasisEnv): boolean {
  return env.modesOn && env.caps === 'ok' && env.modesPath
}

/**
 * Lưu (tạo / sửa). `current` = cách tính hiện tại khi sửa (undefined khi tạo); `status` khi sửa. `inputBasis` = giá trị client gửi
 * (undefined khi form không có lựa chọn).
 */
export function cmsPlanProgramSave(env: CmsBasisEnv, o: {
  inputBasis: unknown
  current?: CmsProgramBasis | null
  status?: 'draft' | 'active' | 'locked'
}): CmsSavePlan {
  const sent = o.inputBasis !== undefined && o.inputBasis !== null
  if (!env.modesOn) return sent ? { kind: 'error', code: 'CMS_MODES_OFF' } : { kind: 'legacy' }
  if (env.caps === 'unavailable') return { kind: 'error', code: 'CMS_CAPS_UNAVAILABLE' }
  if (env.caps === 'pre130' || !env.modesPath) return sent ? { kind: 'error', code: 'CMS_MODES_UNSUPPORTED' } : { kind: 'legacy' }
  const b = normalizeCmsBasisInput(o.inputBasis)
  if (!b.ok) return { kind: 'error', code: 'CMS_BASIS_REQUIRED' }
  if (o.status !== undefined && o.status !== 'draft') {
    // Sửa chương trình đã kích hoạt: chỉ cùng cách tính (DB cũng chặn — báo sớm, không gửi RPC).
    if (!o.current || o.current.basis !== b.value) return { kind: 'error', code: 'CMS_BASIS_IMMUTABLE' }
  }
  return { kind: 'v2', basis: b.value }
}

/**
 * Kích hoạt. `current` chỉ có nghĩa khi caps = 'ok' và đã đọc được (null = đọc lỗi / dòng lạ). Trả ok ⇒ gọi RPC kích hoạt như cũ
 * (DB kiểm lại CMS_BASIS_NOT_SET / CMS_UNIT_CMS_INVALID trong trigger).
 */
export function cmsPlanActivate(env: CmsBasisEnv, o: { current?: CmsProgramBasis | null; status: 'draft' | 'active' | 'locked' }):
  { ok: true } | { ok: false; code: CmsBasisPlanError } {
  if (env.caps === 'pre130') return { ok: true }
  // DB đã 130 (hoặc không xác định) mà không đọc được cách tính ⇒ không biết có phải cms_unit / pending ⇒ dừng.
  if (env.caps === 'unavailable' || !env.modesPath || !o.current) return { ok: false, code: 'CMS_CAPS_UNAVAILABLE' }
  const b = o.current
  if (b.basis === null) return { ok: false, code: 'CMS_BASIS_NOT_SET' }
  if (!env.modesOn) return b.basis === 'cms_unit' ? { ok: false, code: 'CMS_MODES_OFF_CMS_UNIT' } : { ok: true }
  if (o.status === 'draft' && !cmsBasisConfirmed(b)) return { ok: false, code: 'CMS_BASIS_NOT_CONFIRMED' }
  return { ok: true }
}

/** Nhãn lỗi (action trả mã + nhãn). */
export const CMS_BASIS_PLAN_LABELS: Readonly<Record<CmsBasisPlanError | 'CMS_UNIT_CMS_INVALID' | 'CMS_BASIS_INVALID' | 'CMS_ACTOR_FORBIDDEN', string>> = {
  CMS_BASIS_REQUIRED: 'Chọn cách tính lượng cho chương trình',
  CMS_BASIS_IMMUTABLE: 'Chương trình đã kích hoạt — không đổi được cách tính',
  CMS_BASIS_NOT_SET: 'Chương trình chưa chọn cách tính — sửa thông tin và chọn cách tính trước',
  CMS_BASIS_NOT_CONFIRMED: 'Chương trình nháp chưa được chọn cách tính — mở "Sửa thông tin", chọn cách tính rồi kích hoạt',
  CMS_MODES_OFF: 'Lựa chọn cách tính chưa được bật — tải lại trang',
  CMS_MODES_UNSUPPORTED: 'Hệ thống chưa hỗ trợ lựa chọn cách tính — tải lại trang',
  CMS_CAPS_UNAVAILABLE: 'Không kiểm tra được cách tính của chương trình — thử lại sau',
  CMS_MODES_OFF_CMS_UNIT: 'Chương trình tính nguyên chỉ kích hoạt được khi lựa chọn cách tính đang bật',
  CMS_UNIT_CMS_INVALID: 'Có sản phẩm có đơn vị CMS không hợp lệ cho cách tính nguyên — sửa unit_CMS trong file rồi nạp lại',
  CMS_BASIS_INVALID: 'Cách tính không hợp lệ',
  CMS_ACTOR_FORBIDDEN: 'Chỉ super admin',
}
