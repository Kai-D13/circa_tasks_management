// CRM-CSKH B2 — hợp đồng file import N1 (SPEC B2 §1, data contract r3.2 §N1).
// NGUỒN DUY NHẤT phía TS cho header/giới hạn/mã lỗi; các giới hạn độ dài và mã
// lỗi dòng MIRROR finalize của migration 114 (`care__import_finalize_at`) để
// preview không hứa nhận dữ liệu mà finalize sẽ bác. Spec ép parity.
// Module thuần — dùng chung route, UI và test.

export const CARE_IMPORT_SHEET = 'KhachHang'

export const CARE_IMPORT_HEADERS = [
  'customer_external_id',
  'customer_name',
  'customer_phone',
  'target_store_code',
  'assignee_email',
  'reason_type',
  'reason_text',
  'product_id',
  'product_name',
  'product_url',
] as const

export type CareImportField = (typeof CARE_IMPORT_HEADERS)[number]

/** Tối đa dòng dữ liệu (không tính header) ở B2; file thật lớn hơn ⇒ đo lại ở QA B6. */
export const CARE_IMPORT_MAX_ROWS = 10_000

// reason_type: text tự do, chưa khoá enum (SPEC B2 §1 — vd chronic/promotion do BI/Marketing gửi).

/** Độ dài tối đa sau trim — khớp mã TOO_LONG trong finalize 114. */
export const CARE_FIELD_MAX_LENGTH: Record<CareImportField, number | null> = {
  customer_external_id: 100,
  customer_name: 200,
  customer_phone: 30,
  target_store_code: null,
  assignee_email: null,
  reason_type: 50,
  reason_text: 1000,
  product_id: 100,
  product_name: 300,
  product_url: 1000,
}

/** Ảnh sản phẩm: trống được; có thì HTTPS host CDN (khớp IMAGE_URL_HOST của 114). */
export const CARE_IMAGE_URL_RE = /^https:\/\/cdn-gcs\.thuocsi\.vn\//

/** Mã lỗi theo dòng. Nhóm "SQL" trùng tên với finalize 114; nhóm "file" chỉ có ở parser. */
export const CARE_ROW_ERROR_CODES = [
  // Trùng finalize 114:
  'FIELD_REQUIRED', 'TOO_LONG', 'PHONE_INVALID', 'IMAGE_URL_HOST', 'STORE_INVALID',
  'ASSIGNEE_INVALID', 'ASSIGNEE_AMBIGUOUS', 'DUPLICATE_PRODUCT', 'INCONSISTENT_CUSTOMER',
  'REFUSED_AT_STORE', 'TEST_FLAG_MISMATCH',
  // Chỉ parser (Excel):
  'FORMULA_NOT_ALLOWED', 'CELL_NOT_TEXT', 'BLANK_ROW',
] as const
export type CareRowErrorCode = (typeof CARE_ROW_ERROR_CODES)[number]

export interface CareRowError {
  /** Số dòng Excel gốc (header = dòng 1). */
  row: number
  code: CareRowErrorCode
}

/** Lỗi cả file — không đi tới bước kiểm từng dòng. */
export const CARE_FILE_ERROR_CODES = [
  'WORKBOOK_INVALID', 'SHEET_INVALID', 'HEADER_INVALID', 'NO_ROWS', 'TOO_MANY_ROWS',
] as const
export type CareFileErrorCode = (typeof CARE_FILE_ERROR_CODES)[number]

export const CARE_ERROR_LABELS: Record<CareRowErrorCode | CareFileErrorCode, string> = {
  FIELD_REQUIRED: 'Thiếu dữ liệu bắt buộc (mọi cột trừ product_url)',
  TOO_LONG: 'Dữ liệu vượt độ dài cho phép',
  PHONE_INVALID: 'SĐT không phải số di động Việt Nam hợp lệ',
  IMAGE_URL_HOST: 'Link ảnh phải là https://cdn-gcs.thuocsi.vn/…',
  STORE_INVALID: 'Mã cửa hàng không phải cửa hàng OS đang hoạt động',
  ASSIGNEE_INVALID: 'Email dược sĩ không khớp staff nào của cửa hàng đích',
  ASSIGNEE_AMBIGUOUS: 'Email dược sĩ khớp nhiều hơn một staff của cửa hàng',
  DUPLICATE_PRODUCT: 'Trùng sản phẩm của cùng khách trong file',
  INCONSISTENT_CUSTOMER: 'Cùng khách nhưng tên/SĐT/cửa hàng/dược sĩ khác nhau giữa các dòng',
  REFUSED_AT_STORE: 'Khách đã từ chối chăm sóc tại cửa hàng này',
  TEST_FLAG_MISMATCH: 'Khách thuộc dữ liệu thử nghiệm (QA), không dùng chung với dữ liệu thật',
  FORMULA_NOT_ALLOWED: 'Ô chứa công thức — dán giá trị (Paste values)',
  CELL_NOT_TEXT: 'Ô sai định dạng: customer_external_id/product_id phải là Text (không để dạng số); ô ngày/đúng-sai/lỗi không đọc được',
  BLANK_ROW: 'Dòng trống giữa dữ liệu — xoá dòng trống',
  WORKBOOK_INVALID: 'File không phải Excel .xlsx hợp lệ',
  SHEET_INVALID: `File phải có đúng một sheet tên "${'KhachHang'}"`,
  HEADER_INVALID: 'Dòng tiêu đề phải đúng 10 cột theo mẫu, đúng thứ tự',
  NO_ROWS: 'File không có dòng dữ liệu',
  TOO_MANY_ROWS: `File vượt ${CARE_IMPORT_MAX_ROWS.toLocaleString('vi-VN')} dòng dữ liệu`,
}

/** Một dòng Excel đã đọc thành chuỗi (trim), '' = ô trống. */
export type CareImportRow = { rowNo: number } & Record<CareImportField, string>
