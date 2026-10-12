// Nội dung cảnh báo CHẾ ĐỘ QA (dùng chung: banner CareLayout + sheet chip "QA" ở header màn dược sĩ).
// Q-107 (B7-ui r2 bỏ câu cũ cấm gọi/nhắn số giả): chế độ QA vẫn mở tel:/sms: với số của task QA
// giả — app chỉ mở ứng dụng gọi/SMS của máy, không tự gọi/gửi. Không hook ⇒ dùng được ở server lẫn client.
export function CareQaNoticeText() {
  return (
    <>
      <strong>Chế độ QA trên máy này</strong> — import và lượt chăm sóc chỉ dùng dữ liệu giả (is_test) của lượt QA
      đang chạy. Xem trước file gốc là thao tác <strong>đọc dữ liệu thật</strong> và không import được. Số liệu tổng
      hợp tính theo đường QA, không phải báo cáo vận hành. Không tải ảnh minh chứng. Nút <strong>Gọi/Nhắn</strong> mở
      ứng dụng gọi/SMS của máy với số QA giả — app không tự gọi hay gửi; kiểm số trước khi bấm gọi.
    </>
  )
}
