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

/** Q-104: product_id toàn số 0 ("0", "00"…, đã trim) không tồn tại — khớp PRODUCT_ID_INVALID + CHECK của 114. */
export const CARE_PRODUCT_ID_ZERO_RE = /^0+$/

/** Ảnh sản phẩm: trống được; có thì HTTPS host CDN (khớp IMAGE_URL_HOST của 114). */
export const CARE_IMAGE_URL_RE = /^https:\/\/cdn-gcs\.thuocsi\.vn\//

/** Mã lỗi theo dòng. Nhóm "SQL" trùng tên với finalize 114; nhóm "file" chỉ có ở parser. */
export const CARE_ROW_ERROR_CODES = [
  // Trùng finalize 114:
  'FIELD_REQUIRED', 'TOO_LONG', 'PHONE_INVALID', 'PRODUCT_ID_INVALID', 'IMAGE_URL_HOST', 'STORE_INVALID',
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
  /**
   * Q-110 (B8.3): cột sai — CHỈ khi xác định chắc chắn đúng MỘT cột tại nơi phát hiện lỗi (parser/validator/
   * preview). Lỗi nhiều cột cùng lúc hoặc lỗi quan hệ (trùng, không nhất quán, email × cửa hàng, từ chối,
   * QA) ⇒ không có. Chỉ preview có; finalize 114 trả `{row, code}`.
   */
  field?: CareImportField
}

/** Chữ cột Excel của trường (header đã kiểm đúng thứ tự A..J ⇒ chắc chắn). */
export const careColumnLetter = (f: CareImportField) => String.fromCharCode(65 + CARE_IMPORT_HEADERS.indexOf(f))

/** `{ field }` khi đúng một cột, ngược lại `{}` (Q-110: không chọn bừa cột đầu). */
export const careOneField = (fields: readonly CareImportField[]): { field?: CareImportField } =>
  (fields.length === 1 ? { field: fields[0] } : {})

/** Lỗi cả file — không đi tới bước kiểm từng dòng. */
export const CARE_FILE_ERROR_CODES = [
  'WORKBOOK_INVALID', 'SHEET_INVALID', 'HEADER_INVALID', 'NO_ROWS', 'TOO_MANY_ROWS',
] as const
export type CareFileErrorCode = (typeof CARE_FILE_ERROR_CODES)[number]

export const CARE_ERROR_LABELS: Record<CareRowErrorCode | CareFileErrorCode, string> = {
  FIELD_REQUIRED: 'Thiếu dữ liệu bắt buộc (mọi cột trừ product_url)',
  TOO_LONG: 'Dữ liệu vượt độ dài cho phép',
  PHONE_INVALID: 'SĐT không phải số di động Việt Nam hợp lệ',
  PRODUCT_ID_INVALID: 'product_id không hợp lệ (không được bằng 0)',
  IMAGE_URL_HOST: 'Link ảnh phải là https://cdn-gcs.thuocsi.vn/…',
  STORE_INVALID: 'Mã cửa hàng không phải cửa hàng OS đang hoạt động',
  ASSIGNEE_INVALID: 'Email dược sĩ không khớp staff nào của cửa hàng đích',
  ASSIGNEE_AMBIGUOUS: 'Email dược sĩ khớp nhiều hơn một staff của cửa hàng',
  DUPLICATE_PRODUCT: 'Trùng sản phẩm của cùng khách trong file',
  INCONSISTENT_CUSTOMER: 'Cùng khách nhưng tên/SĐT/cửa hàng/dược sĩ khác nhau giữa các dòng',
  REFUSED_AT_STORE: 'Khách đã từ chối chăm sóc tại cửa hàng này',
  TEST_FLAG_MISMATCH: 'Khách thuộc dữ liệu thử nghiệm (QA), không dùng chung với dữ liệu thật',
  FORMULA_NOT_ALLOWED: 'Ô chứa công thức — dán giá trị (Paste values)',
  CELL_NOT_TEXT: 'Ô sai định dạng: customer_external_id phải là Text; product_id là Text hoặc số nguyên tối đa 15 chữ số (định dạng General, không đệm số 0/dấu phân cách); ô ngày/đúng-sai/lỗi không đọc được',
  BLANK_ROW: 'Dòng trống giữa dữ liệu — xoá dòng trống',
  WORKBOOK_INVALID: 'File không phải Excel .xlsx hợp lệ',
  SHEET_INVALID: `File phải có đúng một sheet tên "${'KhachHang'}"`,
  HEADER_INVALID: 'Dòng tiêu đề phải đúng 10 cột theo mẫu, đúng thứ tự',
  NO_ROWS: 'File không có dòng dữ liệu',
  TOO_MANY_ROWS: `File vượt ${CARE_IMPORT_MAX_ROWS.toLocaleString('vi-VN')} dòng dữ liệu`,
}

/** Nhãn ngắn (chip lọc theo loại lỗi). */
export const CARE_ERROR_SHORT: Record<CareRowErrorCode, string> = {
  FIELD_REQUIRED: 'Thiếu dữ liệu',
  TOO_LONG: 'Quá dài',
  PHONE_INVALID: 'SĐT sai',
  PRODUCT_ID_INVALID: 'product_id = 0',
  IMAGE_URL_HOST: 'Link ảnh sai',
  STORE_INVALID: 'Mã cửa hàng sai',
  ASSIGNEE_INVALID: 'Email dược sĩ không khớp',
  ASSIGNEE_AMBIGUOUS: 'Email trùng nhiều staff',
  DUPLICATE_PRODUCT: 'Trùng sản phẩm',
  INCONSISTENT_CUSTOMER: 'Khách không nhất quán',
  REFUSED_AT_STORE: 'Khách đã từ chối',
  TEST_FLAG_MISMATCH: 'Lẫn dữ liệu QA',
  FORMULA_NOT_ALLOWED: 'Có công thức',
  CELL_NOT_TEXT: 'Sai định dạng ô',
  BLANK_ROW: 'Dòng trống',
}

/** Hướng sửa trong file gốc (Q-110). Không nhắc giá trị ô. */
export const CARE_ERROR_FIXES: Record<CareRowErrorCode, string> = {
  FIELD_REQUIRED: 'Điền đủ các cột bắt buộc của dòng (chỉ product_url được để trống).',
  TOO_LONG: 'Rút gọn nội dung ô theo độ dài tối đa của cột (xem "Yêu cầu file").',
  PHONE_INVALID: 'Nhập số di động Việt Nam 10 chữ số; thiếu số 0 đầu vẫn được.',
  PRODUCT_ID_INVALID: 'Thay product_id bằng mã sản phẩm thật (khác 0).',
  IMAGE_URL_HOST: 'Dùng link ảnh https://cdn-gcs.thuocsi.vn/… hoặc để trống ô.',
  STORE_INVALID: 'Sửa mã cửa hàng theo danh sách cửa hàng OS đang hoạt động.',
  ASSIGNEE_INVALID: 'Kiểm tra email dược sĩ và mã cửa hàng: email phải là tài khoản staff của đúng cửa hàng đó.',
  ASSIGNEE_AMBIGUOUS: 'Email khớp nhiều tài khoản staff của cửa hàng — báo quản trị gộp/sửa tài khoản.',
  DUPLICATE_PRODUCT: 'Mỗi khách chỉ một dòng cho mỗi product_id — xoá dòng trùng hoặc sửa mã.',
  INCONSISTENT_CUSTOMER: 'Các dòng cùng customer_external_id phải cùng tên, SĐT, mã cửa hàng và email dược sĩ.',
  REFUSED_AT_STORE: 'Khách đã từ chối chăm sóc tại cửa hàng này — bỏ khách khỏi file.',
  TEST_FLAG_MISMATCH: 'Mã khách thuộc dữ liệu thử nghiệm — bỏ khỏi file thật.',
  FORMULA_NOT_ALLOWED: 'Sao chép rồi dán giá trị (Paste values) thay cho công thức.',
  CELL_NOT_TEXT: 'customer_external_id: đặt ô Text rồi nhập lại; product_id: Text hoặc số nguyên định dạng General (không đệm 0, không dấu phân cách); ô ngày/đúng-sai/lỗi: nhập lại dạng chữ.',
  BLANK_ROW: 'Xoá dòng trống nằm giữa các dòng dữ liệu.',
}

/** Yêu cầu từng cột (card "Yêu cầu file"), cùng nguồn với giới hạn ở trên. */
export const CARE_IMPORT_COLUMN_RULES: Record<CareImportField, string> = {
  customer_external_id: 'Bắt buộc · ô Text (không để Excel đổi thành số)',
  customer_name: 'Bắt buộc',
  customer_phone: 'Bắt buộc · di động VN, thiếu số 0 đầu tự chuẩn hoá',
  target_store_code: 'Bắt buộc · mã cửa hàng OS đang hoạt động',
  assignee_email: 'Bắt buộc · email staff của đúng cửa hàng (khớp chính xác)',
  reason_type: 'Bắt buộc',
  reason_text: 'Bắt buộc',
  product_id: 'Bắt buộc · Text hoặc số nguyên ≤ 15 chữ số (General), khác 0',
  product_name: 'Bắt buộc',
  product_url: 'Không bắt buộc · https://cdn-gcs.thuocsi.vn/…',
}

/** Một dòng Excel đã đọc thành chuỗi (trim), '' = ô trống. */
export type CareImportRow = { rowNo: number } & Record<CareImportField, string>
