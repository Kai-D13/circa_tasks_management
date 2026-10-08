# CRM-CSKH — hợp đồng dữ liệu GĐ1 r3.2 (PM, 07/10/2026)

> **Nguồn hiện hành để gửi Dev và BI.** Quyết định Q-57/Q-61 bỏ hoàn toàn lịch sử mua/đơn ba tháng của app. Hai đầu vào duy nhất: **N1 file Excel Marketing** và **N3 một bảng/view đơn BigQuery cho hiệu quả sau chăm sóc**. `crm-cskh-bi-schema-v1.md` và `v2.md` là lịch sử đề xuất cũ. N1 đã chốt cấu trúc; tên bảng, quyền và dữ liệu N3 cần xác nhận trước B5.

## N1 — `care_import_v1.xlsx`

- **Một file/đợt tháng, một sheet `KhachHang`, toàn bộ 25 store OS.** Một dòng = một `product_id` cần chăm sóc. Nhiều dòng cùng `customer_external_id` tạo **một task khách/tháng**, không tạo nhiều task.
- Header đúng thứ tự dưới đây. File `planning/research/crm-cskh-import-template-v1.xlsx` hiện có một sheet `KhachHang` và đúng 10 header này (PM đã kiểm tra read-only); dữ liệu trong file đó chỉ là mẫu, không thay file vận hành thật BI sẽ gửi.

| Cột | Bắt buộc | Quy tắc import |
|---|---|---|
| `customer_external_id` | Có | ID BI ổn định toàn chuỗi; **ô Excel kiểu Text**, không dùng SĐT làm khóa join. Ô số bị từ chối để tránh mất ký tự/độ chính xác. |
| `customer_name` | Có | Tên hiển thị; trim. |
| `customer_phone` | Có | Ô Text hoặc số, không bắt buộc số 0 đầu trong Excel; ứng dụng chuẩn hóa về số di động VN 10 chữ số. Lỗi nếu không hợp lệ. |
| `target_store_code` | Có | Mã POS, map duy nhất tới `stores.code` với `store_type='os'`, `is_active=true`. |
| `assignee_email` | Có | Lowercase/trim; map duy nhất tới `public.users` role `staff` thuộc store đích. |
| `reason_type` | Có | Text không rỗng; ví dụ `chronic`, `promotion`. BI/Marketing gửi danh mục thực tế; app hiển thị `reason_text` làm nội dung chính. |
| `reason_text` | Có | Lý do cụ thể gắn với dòng sản phẩm, không rỗng/chung chung. |
| `product_id` | Có | ID sản phẩm, **ô Excel kiểu Text**; không dùng tên làm khóa. Ô số bị từ chối để không mất số 0 đầu. |
| `product_name` | Có | Tên snapshot từ Marketing/BI. |
| `product_url` | Không | URL ảnh HTTPS host `cdn-gcs.thuocsi.vn`; trống thì placeholder, host khác báo trong preview. |

**Gom/validate:** các dòng cùng khách phải nhất quán `customer_name`, SĐT sau chuẩn hóa, `target_store_code`, `assignee_email`; xung đột báo kèm số dòng gốc. `(customer_external_id, product_id)` trùng trong một file báo lỗi để BI sửa/gộp lý do. `reason_type`/`reason_text` có thể khác theo sản phẩm. Không tạo task nếu bất kỳ khách nào chưa map được store/dược sĩ. Đếm dashboard theo khách/task unique, không theo dòng sản phẩm. Kỳ và hạn là **cuối tháng import theo `Asia/Ho_Chi_Minh`**, không có cột due date trong Excel. File tháng tối đa **10.000 dòng sản phẩm** theo Q-74.

**Ảnh:** BI xuất `REPLACE(link, 'storage.googleapis.com', 'cdn-gcs.thuocsi.vn') AS product_url`. Query mẫu dùng `SELECT *` rồi alias `link` khiến output có `link` gốc và `link_1` CDN; app chỉ đọc `product_url`. UI mở tab Sản phẩm mới tải ảnh nhìn thấy, chạm để xem lớn. Không tải ảnh trên danh sách khách; không ép nén lại toàn bộ ảnh nếu làm tăng độ trễ. Ảnh mẫu stakeholder nêu ~62,8 KB **không** phải MB của file Excel.

**File sửa cùng tháng:** preview diff theo khách/sản phẩm. Chỉ thêm khách mới, sửa sản phẩm/lý do của task chưa có lượt. Task đã có lượt và khách biến mất khỏi file sửa vẫn giữ, preview nêu phần không áp dụng. Đổi owner phải dùng luồng chuyển giao có note. Commit atomic/idempotent, không thay lịch sử tháng cũ hoặc interaction.

**Dữ liệu vận hành:** GĐ1 **không cần file Excel thật hoặc số MB để bắt đầu/hoàn thành B2**. Dev dùng fixture giả để kiểm import và giới hạn upload. Marketing/operator dùng file thật không che PII để QA thủ công **sau khi module hoàn thành, trước bật cờ rollout**; truyền qua kênh riêng, không commit/đưa vào tài liệu, fixture, log hoặc bucket public. Nếu file thật vượt cap hoặc lộ lỗi mapping, sửa theo QA trước rollout.

## N3 — một bảng/view đơn BigQuery cho hiệu quả sau chăm sóc

**Không có N2 lịch sử mua trong GĐ1.** App không cần sản phẩm/dòng đơn/đơn cũ để dựng UI dược sĩ. Cron đọc trực tiếp một nguồn **một dòng cho mỗi đơn đã đặt** từ BigQuery, gồm cả đơn về sau hủy/hoàn, để cập nhật conversion và doanh thu ròng. BI có thể tổng hợp nguồn này từ feed POS/online sẵn có. BI không cần biết `task_id` hay pharmacist.

| Cột N3 đề nghị | BigQuery | Mục đích |
|---|---|---|
| `customer_external_id` | STRING, NOT NULL | Join với N1. |
| `order_key` | STRING, NOT NULL | Khóa đơn toàn POS/online, unique. |
| `ordered_at` | TIMESTAMP, NOT NULL | Thời điểm **đặt đơn** UTC; so với lượt Hoàn thành. |
| `source_updated_at` | TIMESTAMP, NOT NULL | Thời điểm dòng đơn/tiền ròng được cập nhật; cron dùng để đọc phần thay đổi. Có thể map từ cột cập nhật sẵn có của BI. |
| `order_net_amount` | NUMERIC, NOT NULL | Tiền thực thu hiện tại của toàn đơn (VND); hủy/hoàn hết = 0, hoàn một phần = số còn lại. |
| `pos_code` | STRING, có thể NULL | **Cửa hàng phát sinh đơn POS**; đơn online có thể NULL. Dùng đối soát nguồn, không quyết định người/store được ghi công. |

**Sáu cột trên là schema N3 đề nghị sau Q-65–68.** N3 chỉ chứa đơn **đã đặt**, kể cả khi sau này bị hủy/hoàn, nên không cần `is_valid_order` để xóa conversion. `order_status` và `order_code` có thể thêm để audit nếu BI đã có, không bắt buộc cho attribution. Cột `is_deleted`/tombstone và xử lý xóa nguồn tự động **không thuộc GĐ1**; ca nguồn xóa hẳn đơn do Marketing/operator xử lý thủ công theo Q-68. Nếu BI chưa có `source_updated_at` hoặc tương đương, cron phải dùng đối soát toàn bộ phần dữ liệu liên quan thay vì cursor incremental; xác nhận cách này trước B5, không chặn B0.

**Attribution tối thiểu:** đơn đã đặt có `ordered_at` **sau** lượt Hoàn thành → gán `order_key` đúng một lần cho lượt Hoàn thành gần nhất trước đơn. Hủy/hoàn toàn bộ **giữ conversion = 1** và cập nhật **doanh thu ròng = 0**; hoàn một phần giữ conversion 1, tiền là số thực thu. Chụp store/dược sĩ tại lượt chăm sóc, không dùng `pos_code` bán. Báo cáo tháng theo **tháng của lượt chăm sóc**, vì vậy đơn tháng sau có thể cập nhật cohort tháng cũ. Khi BI lỗi hoặc dữ liệu chưa đủ, giữ snapshot trước và hiện độ mới dữ liệu, không ghi 0 giả. UI chỉ cần nhãn “Đã có đơn”/số liệu hiệu quả, không cần lịch sử đơn cũ.

**Trước B5 cần xác nhận ngắn gọn:** tên bảng đầy đủ, sáu cột và kiểu thực (hoặc tên tương đương để map), một dòng mới nhất cho mỗi `order_key` chung POS/online, nguồn chỉ gồm đơn đã đặt, cách cập nhật tiền ròng khi hủy/hoàn, độ trễ và quyền đọc của service account app. User/operator tạo bảng như luồng cron KPI đang có; Dev kiểm thử query thực tế trên số dòng mẫu giả/an toàn. Partition/cluster là tối ưu bảng vật lý do bên tạo bảng chọn, không phải cột nghiệp vụ bắt buộc; không yêu cầu thêm feed lịch sử. Không gửi service account key vào chat.

**Cron:** Coolify có thể thêm task đóng kỳ và task đồng bộ đơn. Nhịp đồng bộ cần phù hợp độ trễ BI; PM đề xuất tối thiểu hằng ngày theo yêu cầu vận hành, cấu hình giờ trong Coolify. Không tạo cron kéo sản phẩm/lịch sử đơn về mobile.

## UI từ hai nguồn

- **Tab `Sản phẩm`:** ảnh/tên/lý do của tất cả dòng sản phẩm N1 thuộc task tháng hiện hành, ảnh mở lớn khi chạm. Không nhóm theo đơn mua, không có số đơn/ngày mua/tổng chi tiêu cũ vì N1 không có những trường này.
- **Theo dõi hiệu quả/báo cáo:** trạng thái và tiền đơn sau chăm sóc từ N3, cập nhật theo lần cron thành công; hiển thị rõ thời điểm dữ liệu được đồng bộ.
