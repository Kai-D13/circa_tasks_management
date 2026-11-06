// CMS P1-b — chuẩn hoá đầu vào tạo / sửa chương trình (thuần, test được) + nhãn lỗi RPC 121 cho server action.
// Server action dùng; RPC rpc_cms_program_save kiểm lại toàn bộ trong transaction (không tin tầng này).
// KHÔNG nhận is_test / actor / status từ client (H9: server quyết namespace QA theo marker của người tạo).

import { isCmsIsoDate } from './time'

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
  BUSY: 'Đang có thao tác khác trên danh mục CMS — thử lại sau ít giây',
}

export function cmsProgramErrorLabel(code: string): string {
  return CMS_PROGRAM_ERROR_LABELS[code] ?? 'Không lưu được — thử lại sau'
}
