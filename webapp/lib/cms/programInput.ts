// CMS P1-b — chuẩn hoá đầu vào tạo / sửa chương trình (thuần, test được) + nhãn lỗi RPC 121 cho server action.
// Server action dùng; RPC rpc_cms_program_save kiểm lại toàn bộ trong transaction (không tin tầng này).
// KHÔNG nhận is_test / actor / status từ client (H9: server quyết namespace QA theo marker của người tạo).
// CMS-UNIT (PM spec 09/11 §4): cơ sở tính do SERVER quyết (tạo mới: cờ CMS_UNIT_BASIS_ENABLED ⇒ cms_unit, tắt ⇒ pos_base; sửa: giữ
// nguyên). Client có thể gửi `quantity_basis` để khẳng định cơ sở đã xem trong preview — enum lạ ⇒ từ chối; khác cơ sở server ⇒
// từ chối (cmsResolveProgramBasis). Không có đường đổi cơ sở qua form (đổi cơ sở = quy trình chuyển đổi riêng).

import { isCmsIsoDate } from './time'
import { CMS_BASIS_LABEL, isCmsQuantityBasis, type CmsQuantityBasis } from './unitBasis'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const CMS_PROGRAM_NAME_MAX = 200
export const CMS_PROGRAM_STORES_MAX = 500
/** Khoảng ngày kỹ thuật (cùng RPC 121; Q-215 operator chốt: không thêm trần độ dài kỳ). UI P1-c dùng cùng hằng số. */
export const CMS_PROGRAM_DATE_MIN = '2020-01-01'
export const CMS_PROGRAM_DATE_MAX = '2100-12-31'

export interface CmsProgramInput {
  name: string
  start_date: string
  end_date: string
  scope: 'all' | 'stores'
  store_ids: string[]
}

/** Khoá quantity_basis client gửi (null = không gửi). Sai enum ⇒ lỗi. */
export function cmsProgramBasisClaim(raw: unknown): { ok: true; value: CmsQuantityBasis | null } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, 'quantity_basis')) return { ok: true, value: null }
  const b = (raw as Record<string, unknown>).quantity_basis
  if (b === undefined || b === null) return { ok: true, value: null }
  return isCmsQuantityBasis(b) ? { ok: true, value: b } : { ok: false, error: 'Cơ sở tính không hợp lệ' }
}

/**
 * Cơ sở tính sẽ dùng. Tạo mới: cờ bật ⇒ cms_unit, tắt ⇒ pos_base. Sửa: cơ sở hiện tại của chương trình (không đổi qua form).
 * Client khẳng định khác ⇒ lỗi (không âm thầm theo client, không âm thầm bỏ qua).
 */
export function cmsResolveProgramBasis(
  claim: CmsQuantityBasis | null, ctx: { kind: 'create'; unitBasisEnabled: boolean } | { kind: 'update'; current: CmsQuantityBasis },
): { ok: true; value: CmsQuantityBasis } | { ok: false; error: string } {
  const server: CmsQuantityBasis = ctx.kind === 'create' ? (ctx.unitBasisEnabled ? 'cms_unit' : 'pos_base') : ctx.current
  if (claim !== null && claim !== server) {
    return {
      ok: false,
      error: ctx.kind === 'create'
        ? `Cơ sở tính hiện áp dụng cho chương trình mới là "${CMS_BASIS_LABEL[server]}" — tải lại trang rồi thử lại`
        : 'Không đổi cơ sở tính của chương trình qua form',
    }
  }
  return { ok: true, value: server }
}

export function normalizeCmsProgramInput(raw: unknown): { ok: true; value: CmsProgramInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Thiếu thông tin chương trình' }
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!name) return { ok: false, error: 'Thiếu tên chương trình' }
  if (name.length > CMS_PROGRAM_NAME_MAX) return { ok: false, error: `Tên tối đa ${CMS_PROGRAM_NAME_MAX} ký tự` }
  const start = typeof r.start_date === 'string' ? r.start_date : ''
  const end = typeof r.end_date === 'string' ? r.end_date : ''
  if (!isCmsIsoDate(start) || !isCmsIsoDate(end)) return { ok: false, error: 'Ngày bắt đầu / kết thúc không hợp lệ' }
  if (end < start) return { ok: false, error: 'Ngày kết thúc phải từ ngày bắt đầu trở đi' }
  if (start < CMS_PROGRAM_DATE_MIN || end > CMS_PROGRAM_DATE_MAX) return { ok: false, error: 'Ngày phải trong khoảng 01/01/2020 – 31/12/2100' }
  const scope = r.scope === 'all' || r.scope === 'stores' ? r.scope : null
  if (!scope) return { ok: false, error: 'Phạm vi không hợp lệ' }
  let storeIds: string[] = []
  if (scope === 'stores') {
    if (!Array.isArray(r.store_ids) || r.store_ids.some((s) => typeof s !== 'string' || !UUID_RE.test(s))) {
      return { ok: false, error: 'Danh sách nhà thuốc không hợp lệ' }
    }
    storeIds = [...new Set((r.store_ids as string[]).map((s) => s.toLowerCase()))]
    if (storeIds.length === 0) return { ok: false, error: 'Chọn ít nhất một nhà thuốc' }
    if (storeIds.length > CMS_PROGRAM_STORES_MAX) return { ok: false, error: 'Quá nhiều nhà thuốc' }
  }
  return { ok: true, value: { name, start_date: start, end_date: end, scope, store_ids: storeIds } }
}

export function isCmsUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s)
}

/** Nhãn cho mã RAISE của RPC 121 (route / action chỉ trả mã + nhãn, không message DB). */
export const CMS_PROGRAM_ERROR_LABELS: Record<string, string> = {
  CMS_PROGRAM_BAD_INPUT: 'Thông tin chương trình không hợp lệ',
  CMS_PROGRAM_STORE_INVALID: 'Phạm vi có nhà thuốc không còn là nhà thuốc OS đang hoạt động — sửa phạm vi',
  CMS_PROGRAM_NOT_FOUND: 'Không tìm thấy chương trình',
  CMS_PROGRAM_NOT_EDITABLE: 'Chương trình đã bắt đầu hoặc đã chốt — không sửa thông tin được',
  CMS_PROGRAM_CONFLICT: 'Khoảng ngày mới làm trùng sản phẩm với chương trình khác đang chạy cùng thời gian',
  CMS_PROGRAM_NOT_DRAFT: 'Chỉ kích hoạt được chương trình nháp',
  CMS_PROGRAM_EMPTY: 'Chương trình chưa có sản phẩm hợp lệ — nạp danh mục trước',
  CMS_PROGRAM_CATALOG_TARGET_MISSING: 'Có sản phẩm GMV toàn danh mục nhưng thiếu target danh mục',
  CMS_ACTIVATE_CONFLICT: 'Có sản phẩm thuộc chương trình khác đang chạy cùng thời gian',
  // CMS-Q-220 (migration 125): bậc cuối phải không giới hạn — cấu hình cũ có cận cuối hữu hạn không kích hoạt được.
  CMS_PROGRAM_TIER_LAST_FINITE: 'Danh mục còn bậc cuối có giới hạn (cấu hình trước chính sách không trần) — nạp lại file, để trống Đến SL bán ở bậc cuối',
  CMS_PROGRAM_TIERS_INVALID: 'Thang bậc của danh mục không hợp lệ (phải bắt đầu từ 1, liên tục) — nạp lại file danh mục',
  CMS_PROGRAM_IS_TEST_IMMUTABLE: 'Không đổi được loại chương trình',
  // Q-214 (operator chốt 01/11): chặn dời ngày bắt đầu của chương trình đã kích hoạt về hôm nay / quá khứ.
  CMS_PROGRAM_START_PAST: 'Chương trình đã kích hoạt chỉ được dời ngày bắt đầu sang một ngày sau hôm nay',
  // CMS-UNIT (128): trigger cms_programs_basis_guard từ chối đổi cơ sở ngoài quy trình chuyển đổi.
  CMS_PROGRAM_BASIS_CHANGE_INVALID: 'Không đổi được cơ sở tính của chương trình đã có lượt tính',
  // r1 (PM 10/11 UNIT-P2-3, 128): kích hoạt / lưu chương trình theo ĐV tính CMS có SP mang ĐV không hợp lệ — từ chối nguyên khối.
  CMS_PROGRAM_UNIT_INVALID: 'Có sản phẩm mang ĐV tính CMS không hợp lệ (trống, ký tự điều khiển hoặc ký tự vô hình) — nạp lại danh mục với ĐV đúng như trên POS',
  UNIT_BASIS_DB_UNSUPPORTED: 'CSDL chưa hỗ trợ cách tính theo ĐV tính CMS — chưa tạo được chương trình',
  BUSY: 'Đang có thao tác khác trên danh mục CMS — thử lại sau ít giây',
}

export function cmsProgramErrorLabel(code: string): string {
  return CMS_PROGRAM_ERROR_LABELS[code] ?? 'Không lưu được — thử lại sau'
}
