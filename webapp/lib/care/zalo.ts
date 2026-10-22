// CRM-CSKH lát C (Q-154, PM 21/10 #3) — nút Zalo trên chi tiết task của dược sĩ. THUẦN (không Next / env) ⇒ dùng được ở client
// và test được mọi nhánh. Chỉ nhận SĐT ĐÃ CHUẨN HOÁ của chính task đang xem (phone_norm — cùng ràng buộc DB 114); không lấy số
// từ env, URL hay input. Link mở sau thao tác người dùng; app không tự chuyển sang SMS và không suy đoán khách chặn tìm qua số.

/** Cùng CHECK `care_tasks.phone_norm` (114) và normalizeVnPhone: 10 số, đầu 03 / 05 / 07 / 08 / 09. */
export const CARE_ZALO_PHONE_RE = /^0[35789][0-9]{8}$/

/** `https://zalo.me/<số>` (C0: dạng HTTPS cùng tab mở đúng hồ sơ); số không hợp lệ ⇒ null (UI hiện ghi chú, không có link). */
export function careZaloHref(phoneNorm: string): string | null {
  return CARE_ZALO_PHONE_RE.test(phoneNorm) ? `https://zalo.me/${phoneNorm}` : null
}
