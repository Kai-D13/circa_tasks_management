// CMS — cổng công bố KẾT QUẢ TIỀN THẬT (Q-206, docs/cms/DECISIONS.md §2; kế hoạch PM 02/11 §1.2, §5).
// Q-206 (quy thuộc trả hàng) đang HOLD ⇒ chương trình thật KHÔNG được công bố snapshot kết quả: lõi đồng bộ dừng ở
// held RESULTS_RELEASE_GATE sau khi seal đạt (dữ liệu đã kiểm, pointer giữ nguyên, không có số tiền thật nào hiện ra).
// Chương trình QA (is_test, chỉ thấy qua marker) được công bố để kiểm thử pipeline / UI.
// Đây là HẰNG trong mã (không đọc env): mở cổng = batch code riêng sau khi Q-206 được chốt và PM audit adapter trả hàng —
// không có cờ / tham số nào bật được ở runtime. Không bỏ dòng âm, không clamp, không công bố phần bán dương để vượt cổng.

export type CmsReturnsContractState = 'HOLD' | 'APPROVED'

/** Trạng thái hợp đồng trả hàng Q-206 — đổi sang 'APPROVED' chỉ trong batch được PM duyệt. */
export const CMS_Q206_RETURNS_CONTRACT: CmsReturnsContractState = 'HOLD'

export function cmsCanPublishResults(isTest: boolean, state: CmsReturnsContractState = CMS_Q206_RETURNS_CONTRACT): boolean {
  return isTest || state === 'APPROVED'
}
