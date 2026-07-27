// Hotfix Tasks P1 (stakeholder 27/07) — TRẠNG THÁI HIỆU DỤNG của group
// staff_all: tab "Chờ thực hiện"/"Hoàn thành" phân loại theo TIẾN ĐỘ CHILDREN,
// KHÔNG theo status vật lý của parent (parent cố ý giữ 'todo' làm record tổng
// quan — mig 031; TUYỆT ĐỐI không update parent thành 'done' trong DB — sẽ phá
// contract submit/resubmit/lịch sử/RLS).
//
//   effective_done = stats ĐÃ LOAD  AND  total > 0  AND  done == total
//
// FAIL-CLOSED: stats thiếu/lỗi/không xác định đủ tổng (query lỗi, vượt cap,
// parent không có row stats) → KHÔNG được suy luận là hoàn thành — group ở lại
// "Chờ thực hiện". Phân loại: pending = !effective_done · done = effective_done
// · một group xuất hiện ở ĐÚNG MỘT tab.
export interface GroupChildStats {
  loaded: boolean   // nguồn stats authoritative đã đọc thành công cho group này
  total: number
  done: number
}

export function effectiveDone(stats: GroupChildStats | null | undefined): boolean {
  return !!stats && stats.loaded && stats.total > 0 && stats.done === stats.total
}

// r1 (audit P1#1): nguồn quyết định trạng thái KHÔNG BAO GIỜ được là subset bị
// cap âm thầm — mọi fetch nuôi phân loại phải verify exact count == số row đã
// nhận. count null (không yêu cầu exact) cũng FAIL-CLOSED. Thiếu → page hiển
// thị ErrorState, không phân loại giả. (Đường bền vững khi dữ liệu tăng: RPC
// set-based tổng hợp per-parent trong DB — backlog, cần migration + audit.)
export function fetchedComplete(count: number | null | undefined, rowsLoaded: number): boolean {
  return count !== null && count !== undefined && count === rowsLoaded
}
