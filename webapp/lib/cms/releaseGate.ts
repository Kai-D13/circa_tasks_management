// CMS — cổng công bố KẾT QUẢ TIỀN của chương trình thật. Hai quyết định TÁCH RIÊNG (PM 06/11 đổi phạm vi:
// planning/research/cms-sales-only-phase-spec-plan-2026-11-06.md §4.1; docs/cms/DECISIONS.md §2):
//   1) CMS_RESULTS_RELEASE_MODE — có được công bố CMS TẠM TÍNH theo dòng bán hay không. 'SALES_ONLY_V1' (từ migration 126): chương
//      trình thật được công bố snapshot tính từ các dòng bán đủ điều kiện mà nguồn BI hiện cung cấp; KHÔNG xử lý trả hàng. 'HOLD':
//      như trước 126 — chương trình thật dừng ở held RESULTS_RELEASE_GATE.
//   2) CMS_Q206_RETURNS_CONTRACT — trạng thái TÍNH NĂNG trả hàng (Q-206). Vẫn 'HOLD' = trả hàng chưa triển khai (phase sau; B1 người
//      bán gốc / D1 kỳ ngày bán đã chốt cho phase đó). KHÔNG đặt 'APPROVED' khi chưa có nguồn / adapter trả hàng được PM audit.
//      Khi chưa APPROVED: chương trình thật có dòng âm / ADJUSTMENT trong tập ứng viên ⇒ held RETURNS_NOT_SUPPORTED_THIS_PHASE
//      (không bỏ dòng âm, không clamp, không công bố riêng phần dương); UI / XLSX không lộ tiền dòng điều chỉnh.
// Cả hai là HẰNG trong mã (không đọc env / URL / tham số client). Mở / đổi = batch code + migration DB tương ứng được PM duyệt.
// DB giữ lớp thứ hai độc lập: cms__results_release_open() + chặn dòng điều chỉnh trong rpc_cms_sales_run_publish (migration 126).
// Chương trình QA (is_test, chỉ thấy qua marker) luôn công bố được để kiểm thử pipeline / UI (kể cả fixture điều chỉnh).

export type CmsResultsReleaseMode = 'HOLD' | 'SALES_ONLY_V1'
export type CmsReturnsContractState = 'HOLD' | 'APPROVED'

/** Cổng công bố kết quả bán tạm tính — 'SALES_ONLY_V1' đi cùng migration 126 (cms__results_release_open() = true). */
export const CMS_RESULTS_RELEASE_MODE: CmsResultsReleaseMode = 'SALES_ONLY_V1'

/** Căn cứ kết quả ghi kèm run công bố (DB 126 tự đóng dấu `results_basis` trong transaction publish — app không gửi). */
export const CMS_RESULTS_BASIS = 'sales_only_v1' as const

/** Trạng thái tính năng trả hàng Q-206 — 'HOLD' = chưa triển khai (phase sau), KHÔNG phải cổng công bố kết quả bán. */
export const CMS_Q206_RETURNS_CONTRACT: CmsReturnsContractState = 'HOLD'

/** Mã held khi chương trình thật có dòng âm / điều chỉnh mà tính năng trả hàng chưa triển khai (app + DB 126 dùng chung). */
export const CMS_RETURNS_NOT_SUPPORTED = 'RETURNS_NOT_SUPPORTED_THIS_PHASE'

/** Được công bố snapshot kết quả không: QA luôn được; chương trình thật theo cổng kết quả bán (không theo trạng thái trả hàng). */
export function cmsCanPublishResults(isTest: boolean, mode: CmsResultsReleaseMode = CMS_RESULTS_RELEASE_MODE): boolean {
  return isTest || mode === 'SALES_ONLY_V1'
}

/** Dòng âm / ADJUSTMENT có chặn công bố không: chỉ chương trình thật khi tính năng trả hàng chưa APPROVED. */
export function cmsAdjustmentBlocksRelease(isTest: boolean, returns: CmsReturnsContractState = CMS_Q206_RETURNS_CONTRACT): boolean {
  return !isTest && returns !== 'APPROVED'
}
