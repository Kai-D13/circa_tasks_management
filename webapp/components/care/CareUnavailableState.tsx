import { ErrorState } from '@/components/ds/ErrorState'

// B8.4 (PM B7-qa P2): `care_my_access` lỗi ⇒ 'unavailable'. Nguyên nhân có thể là MẤT KẾT NỐI tới cơ sở dữ liệu
// (gặp khi QA 13/10) hoặc CRM chưa sẵn sàng — không khẳng định "thiếu cấu hình CRM". Dùng chung các trang browser.
export const CARE_UNAVAILABLE_MESSAGE = 'Không tải được hệ thống CRM.'
export const CARE_UNAVAILABLE_HINT = 'Có thể do mất kết nối tới cơ sở dữ liệu — thử tải lại trang. Nếu vẫn lỗi, báo quản trị.'

export function CareUnavailableState() {
  return <ErrorState message={CARE_UNAVAILABLE_MESSAGE} hint={CARE_UNAVAILABLE_HINT} />
}
