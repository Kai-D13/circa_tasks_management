// UI v2 Phase 3 · Bảng tin (A3 r1, PM R1-01) — quyết định THUẦN cho trang /announcements/[id]/edit SAU khi đã qua
// tải tin / 404 / kiểm quyền (các bước đó vẫn ở page, thứ tự như cũ). Không truy vấn; nhận cờ lỗi của chính các truy
// vấn hiện có. Dùng chung page thật + fixture để test được mọi nhánh.
//   · cửa hàng đích (announcement_stores) hoặc ảnh (announcement_assets) lỗi ⇒ 'error': không dựng form thiếu dữ liệu
//     (lưu form đó sẽ xóa ảnh / bỏ cửa hàng đích) — fail-closed (PM chấp nhận).
//   · danh sách cửa hàng (stores) lỗi + tin đang gửi THEO CỬA HÀNG ⇒ 'error': người sửa không xem/đối chiếu được tập
//     cửa hàng đang lưu — không mở form, không đổi đối tượng nhận (R1-01).
//   · danh sách cửa hàng lỗi + tin gửi TẤT CẢ ⇒ mở form với storesError: chỉ giữ "Tất cả" (nút chọn cửa hàng bị tắt).
export type EditLoad = { kind: 'error' } | { kind: 'form'; storesError: boolean }

export function editLoadDecision(e: {
  aStoresErr: boolean
  assetsErr: boolean
  storesErr: boolean
  visibility: 'all' | 'stores'
}): EditLoad {
  if (e.aStoresErr || e.assetsErr) return { kind: 'error' }
  if (e.storesErr && e.visibility === 'stores') return { kind: 'error' }
  return { kind: 'form', storesError: e.storesErr }
}
