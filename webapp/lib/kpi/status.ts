// Shared status labels/tones for KPI campaigns (list + detail).
//
// Step 5.1: bỏ màu hardcode chỉ-sáng (`bg-gray-100 text-gray-600`…). Cặp
// green-700-trên-green-100 không đảo theo theme nên dark mode đọc sai; token
// `--status-*` đã khai báo đủ light + dark trong globals.css.
//
// File này nằm ngoài components/kpi/ và app/(dashboard)/targets/ nên lượt quét
// token ở commit đầu batch không chạm tới — đó là lý do nó sót lại.
export const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft:  { label: 'Nháp',      cls: 'bg-status-neutral-bg text-status-neutral' },
  active: { label: 'Đang chạy', cls: 'bg-status-success-bg text-status-success' },
  paused: { label: 'Tạm dừng',  cls: 'bg-status-warning-bg text-status-warning' },
  // 'ended' cùng tông trung tính với draft nhưng nhạt hơn về ngữ nghĩa: đã xong,
  // không còn là việc đang mở. Dùng chung token neutral, khác nhau ở nhãn.
  ended:  { label: 'Kết thúc',  cls: 'bg-status-neutral-bg text-status-neutral' },
}

// Badge campaign thử nghiệm. Trước đây tím hardcode (`bg-purple-100
// text-purple-700`) — không có token tím trong hệ, và tím chỉ-sáng cũng chìm
// trên nền tối. Dùng tông info: đây là NHÃN THÔNG TIN ("bản thử"), không phải
// cảnh báo hay lỗi.
export const TEST_BADGE_CLS = 'bg-status-info-bg text-status-info'
