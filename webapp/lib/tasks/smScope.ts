// SM tạo task broadcast (mig 108) — CONTRACT PHẠM VI, thuần, có test.
//
// Vì sao tách riêng thay vì viết thẳng trong server action: nhánh "Từng dược sĩ
// nộp" ghi `tasks` bằng SERVICE ROLE nên RLS KHÔNG áp. Với nhánh đó, hàm dưới
// đây LÀ ranh giới bảo mật duy nhất giữa một SM và cửa hàng họ không quản lý.
// Thứ gì là ranh giới bảo mật thì phải kiểm được bằng test, không nằm lẫn giữa
// 200 dòng dựng payload.
//
// Nguyên tắc: KHÔNG tin `storeIds` / `selectedStaffByStore` từ client. Phạm vi
// luôn nạp lại từ sm_store_assignments TẠI THỜI ĐIỂM SUBMIT (SM có thể vừa bị
// gỡ phân công sau khi form đã mở).

export type SmScopeResult =
  | { ok: true; storeIds: string[] }
  | { ok: false; error: string }

// REJECT-ALL, không lọc-rồi-chạy-tiếp: một store ngoài phạm vi nghĩa là payload
// không đáng tin, không phải "chọn nhầm một dòng". Ghi một phần sẽ tạo task
// thật cho các store hợp lệ rồi báo lỗi — người dùng không biết đã ghi gì.
export function validateSmStoreScope(assigned: string[], requested: string[]): SmScopeResult {
  const scope = new Set(assigned.filter((s) => typeof s === 'string' && s.length > 0))
  if (scope.size === 0) {
    return { ok: false, error: 'Bạn chưa được phân công cửa hàng nào — không thể tạo task.' }
  }
  if (!Array.isArray(requested)) return { ok: false, error: 'Danh sách cửa hàng không hợp lệ' }

  const clean = [...new Set(requested.filter((s) => typeof s === 'string' && s.length > 0))]
  if (clean.length === 0) return { ok: false, error: 'Vui lòng chọn ít nhất một cửa hàng' }

  const outside = clean.filter((id) => !scope.has(id))
  if (outside.length > 0) {
    // KHÔNG lộ id store lạ ra thông báo (người gửi payload giả không cần biết
    // id nào tồn tại) — chỉ nói có bao nhiêu cái ngoài phạm vi.
    return {
      ok: false,
      error: `Có ${outside.length} cửa hàng nằm ngoài phạm vi bạn quản lý — không tạo task nào.`,
    }
  }
  return { ok: true, storeIds: clean }
}

// selectedStaffByStore chỉ được nhắc tới các store ĐÃ nằm trong phạm vi.
// Store lạ ở đây tuy không tự sinh task (action chỉ lặp theo storeIds đã
// validate) nhưng vẫn là dấu hiệu payload bị sửa ⇒ từ chối cả lượt.
export function validateSmStaffSelection(
  selected: Record<string, unknown> | undefined,
  allowedStoreIds: string[],
): { ok: true } | { ok: false; error: string } {
  if (!selected) return { ok: true }
  if (typeof selected !== 'object' || Array.isArray(selected)) {
    return { ok: false, error: 'Danh sách dược sĩ không hợp lệ' }
  }
  const allowed = new Set(allowedStoreIds)
  for (const [storeId, ids] of Object.entries(selected)) {
    if (!allowed.has(storeId)) {
      return { ok: false, error: 'Danh sách dược sĩ tham chiếu cửa hàng ngoài phạm vi — không tạo task nào.' }
    }
    if (!Array.isArray(ids)) return { ok: false, error: 'Danh sách dược sĩ không hợp lệ' }
  }
  return { ok: true }
}

// Ai được tạo task (BROADCAST). Tách khỏi `isAdmin` rải rác trong UI để nút /
// route / form dùng CHUNG một luật.
//
// ⚠ KHÔNG dùng cho createTask() — tạo task ĐƠN LẺ vẫn admin-only: request đã
// chốt là broadcast, và đường đơn lẻ còn nhận `assigned_to` tự do nên bề mặt
// kiểm rộng hơn hẳn. SM muốn giao một cửa hàng thì tick đúng một ô trong
// "Nhiều CH".
export function canCreateTask(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'sm'
}

// SM chỉ tạo được task PHÁT SINH. Định kỳ + import Excel giữ nguyên admin-only:
// cả hai đều sinh task theo lịch/hàng loạt ngoài thời điểm submit, nên phạm vi
// không thể kiểm lại được như luồng phát sinh.
export function canCreateRecurring(role: string | null | undefined): boolean {
  return role === 'admin'
}

export function canImportExcel(role: string | null | undefined): boolean {
  return role === 'admin'
}

// SM KHÔNG được đặt visibility = 'public'. Form chỉ gửi 'store'/'private', nên
// luật này chỉ kích hoạt khi payload bị sửa — và nếu bỏ qua thì một SM có thể
// phát một task mà TOÀN BỘ nhân viên công ty đọc được: policy tasks_select_staff
// cho 'public' không kèm bất kỳ điều kiện cửa hàng nào. Từ chối thay vì âm thầm
// hạ xuống 'store' — ép ngầm sẽ giấu mất dấu vết payload bị can thiệp.
export function smVisibilityAllowed(visibility: string | null | undefined): boolean {
  return visibility === 'store' || visibility === 'private'
}
