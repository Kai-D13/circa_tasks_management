# SPEC — Module Chăm sóc khách hàng (CRM-CSKH) cho Circa

> **Nguồn sự thật (source of truth) cho Claude Code.**
> Bản gốc stakeholder: `00_SOURCE_stakeholder_raw.md` + ảnh trong `mockups/`.
> Khi SPEC và mockup mâu thuẫn → **theo SPEC**. Khi SPEC ghi `[CẦN XÁC NHẬN Q-xx]` → làm theo **mặc định đề xuất**, để logic dễ đổi (config/enum), và ghi chú TODO kèm mã Q.
> Ký hiệu: `BR-xx` = business rule, `AC-xx` = acceptance criteria, `[GIẢ ĐỊNH]` = BA tự suy luận, chưa có trong tài liệu gốc.

---

## 1. Bối cảnh & mục tiêu

- Chuỗi nhà thuốc **Circa**. Mỗi **dược sĩ** được giao một danh sách khách hàng, có **hạn hoàn thành**, phải gọi/tư vấn và ghi nhận kết quả.
- Mục tiêu không chỉ là "đã gọi chưa" mà đo được: **bao nhiêu KH được chăm sóc thành công** và **bao nhiêu KH phát sinh đơn hàng mới** (chuyển đổi, doanh thu).
- Module được build **trên ứng dụng hiện có `duocsi.circa.vn`**. Dữ liệu khách hàng, đơn hàng, sản phẩm đã mua **lấy từ hệ thống Circa**; **lịch sử chăm sóc lưu mới** trên duocsi.circa.vn.

## 2. Phạm vi

### Giai đoạn 1 (BUILD NGAY) — Quản lý & kiểm soát công việc
1. Import danh sách KH từ Excel và phân công cho dược sĩ (wizard 4 bước).
2. Dược sĩ xem danh sách được giao, chi tiết KH, lịch sử mua hàng **3 tháng**.
3. Ghi nhận lượt chăm sóc (kết quả + ghi chú + ngày tiếp theo), lưu **append-only**.
4. Quản lý thời hạn: tự chuyển **Quá hạn**, nhắc việc.
5. Store Manager điều chỉnh phân công.
6. Dashboard hiệu suất theo cửa hàng & theo dược sĩ, xuất Excel.

### Giai đoạn 2 (KHÔNG BUILD, chỉ để thiết kế dữ liệu không bị chặn)
- Gợi ý KH đến kỳ mua lại; gợi ý sản phẩm; liên kết tự động kết quả chăm sóc với đơn POS/online; phân tích hiệu quả tự động.

### Ngoài phạm vi
- Thuật toán chọn KH nào cần chăm sóc (stakeholder ghi rõ: *"logic ở bên ngoài"* — Admin chuẩn bị file Excel).
- Tổng đài gọi điện tích hợp (nút "Gọi" chỉ mở cuộc gọi điện thoại của máy) `[GIẢ ĐỊNH, Q-12]`.

## 3. Vai trò & phân quyền `[GIẢ ĐỊNH, Q-10]`

| Vai trò | Nền tảng | Quyền |
|---|---|---|
| **Admin** (vận hành trung tâm) | Web | Import Excel, phân công mọi cửa hàng, xem mọi báo cáo, xuất Excel, xem lịch sử import |
| **Store Manager** | Web (+ mobile nếu có) | Xem & điều chỉnh phân công **trong cửa hàng mình**; xem dashboard cửa hàng mình |
| **Dược sĩ** | Mobile (app/mobile web hiện có) | Chỉ xem task **được giao cho mình**; ghi nhận chăm sóc; không sửa/xoá lượt chăm sóc đã lưu |

## 4. Thuật ngữ

| Thuật ngữ | Định nghĩa |
|---|---|
| **Task (nhiệm vụ chăm sóc)** | 1 KH × 1 dược sĩ × 1 kỳ phân công, có `assigned_at`, `due_date`. |
| **Interaction (lượt chăm sóc)** | 1 lần dược sĩ liên hệ & ghi nhận. 1 task có nhiều interaction. |
| **Outcome (kết quả chăm sóc)** | Kết quả của 1 interaction — 6 giá trị chuẩn ở mục 6.1. |
| **Task status (trạng thái công việc)** | Trạng thái của task dùng cho báo cáo — mục 6.2. |
| **Chuyển đổi (conversion)** | Interaction "Đã đặt đơn" có mã đơn **đã được xác thực** với hệ thống bán hàng. |

> ⚠️ Tài liệu gốc trộn 2 khái niệm *kết quả chăm sóc* và *trạng thái công việc*. SPEC tách thành **2 enum riêng**. Badge hiển thị trên UI được **suy ra** (mục 6.3).

## 5. Luồng tổng quan (mockups/01)

```
Admin import Excel & phân công → Dược sĩ nhận danh sách → Thực hiện chăm sóc
→ Cập nhật kết quả (ghi chú, lịch hẹn tiếp) → Quản lý theo dõi hiệu quả
```

### 5.1 Luồng Import & phân công (Web, mockups/04 — 4 bước)
1. **Tải file**: kéo-thả/chọn `.xlsx`/`.xls`, tối đa **10.000 dòng**. Có link "Xem file mẫu". Bảng **Lịch sử nhập file** (ngày, tên file, số KH, trạng thái `Hoàn thành`/`Có lỗi (n dòng)`, người thực hiện).
2. **Kiểm tra dữ liệu**: hiển thị Tổng dòng / Hợp lệ / Cần chỉnh sửa / Trùng lặp. Bảng dòng hợp lệ có checkbox chọn, tìm kiếm, filter, phân trang.
3. **Phân công**: 3 tab — *Theo dược sĩ* (mặc định), *Tự động*, *Theo cửa hàng*. Chọn cửa hàng + hạn chăm sóc chung; bảng dược sĩ: số KH hiện tại, ô nhập số KH phân thêm, tổng, hạn riêng từng người. Nút **"Phân bổ đều"**.
4. **Xác nhận**: tóm tắt (file, tổng KH, hạn, cửa hàng, số KH/dược sĩ) → **Hoàn tất phân công** → màn hình thành công.

### 5.2 Luồng dược sĩ (Mobile, mockups/02 — 6 màn)
Trang chủ → Danh sách KH → Chi tiết KH (3 tab) → Cập nhật chăm sóc → lưu → quay về chi tiết, tab Lịch sử có bản ghi mới.

### 5.3 Luồng điều chỉnh phân công
Store Manager chọn task(s) → chuyển cho dược sĩ khác (lý do: nghỉ việc / chuyển cửa hàng / nghỉ phép / khác) → giữ nguyên lịch sử interaction, ghi log chuyển giao.

## 6. Mô hình trạng thái

### 6.1 Outcome — 6 giá trị chuẩn (theo bảng mục 4 tài liệu gốc)

| Code | Nhãn UI | Bắt buộc thêm | Tác động lên task (mặc định đề xuất) |
|---|---|---|---|
| `UNREACHABLE` | Không liên hệ được | `next_action_date` | Task → `IN_PROGRESS` |
| `NO_NEED` | Đã liên hệ – chưa có nhu cầu | — | Task → `COMPLETED` |
| `INTERESTED` | Khách hàng quan tâm | `next_action_date` | Task → `COMPLETED` **+ tạo task FOLLOW_UP** (due = next_action_date) `[CẦN XÁC NHẬN Q-03]` |
| `CALLBACK` | Hẹn chăm sóc lại | `next_action_date` | Task → `IN_PROGRESS` `[CẦN XÁC NHẬN Q-03]` |
| `ORDERED` | Đã đặt đơn | `order_code` | Task → `COMPLETED`; tạo yêu cầu xác thực đơn (mục 7.3) |
| `REFUSED` | Từ chối chăm sóc | `contact_preference` | Task → `COMPLETED` (closed_reason=REFUSED); cập nhật tuỳ chọn liên hệ của KH |

> Mockup có chỗ dùng nhãn khác ("Đã liên hệ", "Chưa có nhu cầu", thiếu "Từ chối"/"Hẹn lại" ở form web). **Bỏ qua, dùng đúng 6 giá trị trên cho cả mobile và web.** `[Q-02]`

### 6.2 Task status

| Code | Nhãn | Khi nào |
|---|---|---|
| `PENDING` | Chưa chăm sóc | Mới phân công, chưa có interaction |
| `IN_PROGRESS` | Đang theo dõi | Có ≥1 interaction nhưng chưa kết thúc |
| `COMPLETED` | Đã hoàn thành | Interaction cuối có outcome kết thúc (NO_NEED/INTERESTED/ORDERED/REFUSED) |
| `OVERDUE` | Quá hạn | Chưa COMPLETED/CANCELLED và đã qua `due_date` |
| `CANCELLED` | Đã huỷ | Task bị thu hồi/thay thế khi phân công lại hoặc KH không còn hợp lệ |

Chuyển trạng thái hợp lệ:
```
PENDING → IN_PROGRESS | COMPLETED | OVERDUE | CANCELLED
IN_PROGRESS → IN_PROGRESS | COMPLETED | OVERDUE | CANCELLED
OVERDUE → COMPLETED (completed_late = true) | IN_PROGRESS? (KHÔNG — vẫn giữ OVERDUE đến khi hoàn thành) | CANCELLED
COMPLETED → (bất biến)
```

### 6.3 Badge hiển thị trên danh sách/chi tiết (suy ra, không lưu)
Ưu tiên: `OVERDUE` → "Quá hạn" (đỏ) › `PENDING` → "Chưa chăm sóc" (vàng) › còn lại hiển thị **nhãn outcome của interaction gần nhất** (màu theo outcome). Tab filter mobile: Tất cả / Chưa chăm sóc / Quá hạn / Đã hoàn thành (+ có thể thêm Hẹn lại).

## 7. Business rules

| Mã | Quy tắc | Nguồn |
|---|---|---|
| BR-01 | Mỗi task có **đúng 1** dược sĩ phụ trách, `assigned_at`, `due_date`. | Gốc |
| BR-02 | Mỗi interaction **bắt buộc chọn outcome và nhập ghi chú** (1–500 ký tự) trước khi lưu. | Gốc + mockup (86/500) |
| BR-03 | Outcome `UNREACHABLE`/`CALLBACK`/`INTERESTED` **bắt buộc `next_action_date`** ≥ hôm nay. Cảnh báo (không chặn) nếu > `due_date`. `[Q-04]` | Gốc |
| BR-04 | Interaction là **append-only**: mỗi lần chăm sóc tạo bản ghi mới, không ghi đè/xoá. Sửa (nếu cho phép) phải lưu lịch sử chỉnh sửa. `[Q-09]` | Gốc |
| BR-05 | Job tự động chuyển task chưa hoàn thành sang `OVERDUE` khi hết `due_date` (hết ngày 23:59:59 giờ VN, `Asia/Ho_Chi_Minh`). Dược sĩ **vẫn được** ghi nhận sau khi quá hạn. | Gốc + giả định |
| BR-06 | Đơn chỉ được tính **chuyển đổi** khi xác thực được với hệ thống bán hàng (mục 7.3). | Gốc |
| BR-07 | Store Manager được chuyển task sang dược sĩ khác **cùng cửa hàng**; lưu log (từ, đến, ai, lý do, thời điểm); lịch sử interaction đi theo KH/task. | Gốc |
| BR-08 | KH có `do_not_contact = true` (từ outcome REFUSED) → **không cho import/phân công lại**, bị đánh dấu ở bước Kiểm tra dữ liệu. `[Q-08]` | Giả định |
| BR-09 | Một KH chỉ có **tối đa 1 task đang mở** (PENDING/IN_PROGRESS/OVERDUE) tại một thời điểm → import trùng bị đánh dấu "Trùng lặp". `[Q-07]` | Giả định |
| BR-10 | Số điện thoại hiển thị **che** dạng `09***2121` trên danh sách; nút Gọi/Nhắn dùng số đầy đủ. `[Q-11]` | Mockup |
| BR-11 | Thông tin KH, đơn hàng, sản phẩm là **read-only, đồng bộ từ Circa**. Ghi chú nội bộ của module được phép sửa. `[Q-13]` | Gốc |

### 7.1 Validate file import `[GIẢ ĐỊNH theo mockup, Q-06]`
- Cột **bắt buộc**: Số điện thoại. Khuyến nghị: Họ tên, Email, Địa chỉ, Ghi chú (mockup bước 2 có thêm Giới tính).
- SĐT chuẩn hoá: bỏ khoảng trắng/dấu, `+84`/`84` → `0`, đúng 10 số, đầu số VN hợp lệ.
- Lỗi "Cần chỉnh sửa": thiếu/sai SĐT, email sai định dạng. "Trùng lặp": trùng trong file, hoặc trùng task đang mở (BR-09).
- Map KH theo SĐT với dữ liệu Circa → lấy `customer_id` (KHxxxxx). SĐT không có trong Circa: `[Q-05]` mặc định **vẫn tạo KH tạm** và đánh dấu.
- Cho tải file lỗi về (các dòng lỗi + cột lý do) `[GIẢ ĐỊNH]`.

### 7.2 Phân công
- *Theo dược sĩ*: nhập số lượng thủ công / "Phân bổ đều" (chia đều, phần dư dồn người đầu). Tổng phân phải = số KH được chọn mới cho Tiếp tục.
- *Tự động* & *Theo cửa hàng*: `[CẦN XÁC NHẬN Q-01]` — mặc định: Tự động = chia đều theo tải hiện tại (ai ít task mở hơn nhận nhiều hơn); Theo cửa hàng = dùng cửa hàng mua gần nhất/cột cửa hàng trong file.
- Hạn mặc định chung cho cả lô, cho phép override từng dược sĩ.

### 7.3 Xác thực đơn hàng (conversion) `[CẦN XÁC NHẬN Q-14, Q-15]`
Mặc định đề xuất:
- Khi chọn `ORDERED`: dược sĩ **chọn từ danh sách đơn gần đây của KH** (lấy từ Circa) hoặc nhập mã đơn.
- Hợp lệ khi: đơn tồn tại; thuộc đúng KH (customer_id/SĐT); `order_created_at` nằm trong cửa sổ **[thời điểm interaction − 0 ngày, + 7 ngày]** (N cấu hình được); đơn không bị huỷ; chưa được ghi nhận cho interaction khác.
- Nếu chưa xác thực được ngay (đơn chưa sync) → `verification_status = PENDING`, job đối soát định kỳ → `VERIFIED` / `REJECTED`. Chỉ `VERIFIED` mới vào doanh thu dashboard.

## 8. Mô hình dữ liệu đề xuất

> Claude Code: **map vào schema/ORM hiện có trước**, chỉ tạo bảng mới khi chưa có thực thể tương đương. Tên dưới đây mang tính logic.

```
import_batch(id, file_name, store_id, uploaded_by, uploaded_at,
             total_rows, valid_rows, error_rows, duplicate_rows,
             status[PROCESSING|COMPLETED|HAS_ERRORS], error_file_url)

import_row(id, batch_id, row_no, raw_json, phone_normalized, customer_id?,
           validation_status[VALID|INVALID|DUPLICATE|DO_NOT_CONTACT], errors[])

care_task(id, customer_id, store_id, pharmacist_id, import_batch_id?,
          parent_task_id?,              -- task FOLLOW_UP tạo từ INTERESTED
          type[INITIAL|FOLLOW_UP],
          assigned_at, assigned_by, due_date,
          status[PENDING|IN_PROGRESS|COMPLETED|OVERDUE|CANCELLED],
          next_action_date?, last_outcome?, last_interaction_at?,
          completed_at?, completed_late bool, closed_reason?,
          created_at, updated_at)

care_interaction(id, task_id, customer_id, pharmacist_id,
                 outcome, note(<=500), next_action_date?,
                 order_code?, verification_status[NONE|PENDING|VERIFIED|REJECTED],
                 verified_order_amount?, verified_at?,
                 attachment_url?, created_at)          -- append-only

task_reassignment_log(id, task_id, from_pharmacist_id, to_pharmacist_id,
                      by_user_id, reason, created_at)

customer_contact_preference(customer_id, do_not_contact bool,
                            channel_opt_out[], reason, updated_by, updated_at)

notification(id, user_id, type[DUE_SOON|OVERDUE|FOLLOW_UP_TODAY|NEW_ASSIGNMENT],
             task_id, read_at, created_at)
```
Index gợi ý: `care_task(pharmacist_id, status, due_date)`, `care_task(store_id, assigned_at)`, `care_task(customer_id, status)`, `care_interaction(task_id, created_at)`.

## 9. Màn hình

### 9.1 Mobile — Dược sĩ (mockups/02, đọc từ trái→phải, trên→dưới)

**M1. Trang chủ** — Lời chào, tên, chức danh, cửa hàng; chuông thông báo. Card "Chăm sóc khách hàng": 4 ô số **Được phân công / Chờ chăm sóc / Đã hoàn thành / Quá hạn** (tap → mở danh sách đã lọc). Nút "Xem danh sách khách hàng". Khối **Nhiệm vụ hôm nay** (task có `next_action_date = hôm nay` hoặc đến hạn hôm nay + quá hạn), mỗi dòng: tên, badge, giờ/ngày, SĐT che. Bottom nav: Trang chủ / Khách hàng / Lịch hẹn / Thêm.

**M2. Khách hàng của tôi** — Header "n khách hàng được phân công". Search theo tên/SĐT, icon filter. Chip: Tất cả / Chưa chăm sóc / Quá hạn / Đã hoàn thành. Item: avatar chữ cái, tên, SĐT che, "Đã mua: <nhóm SP>", "Hạn: dd/mm/yyyy", badge. Sắp xếp mặc định: Quá hạn → hạn gần nhất `[GIẢ ĐỊNH]`.

**M3. Chi tiết KH — tab Tổng quan** — Header: avatar, tên, SĐT che, mã KH, badge, nút **Gọi** (`tel:`) & **Nhắn** `[Q-12]`. Khối *Thông tin KH*: ngày sinh, giới tính, địa chỉ, ghi chú khác. Khối *Thông tin chăm sóc*: dược sĩ phụ trách, cửa hàng, **hạn chăm sóc (đỏ nếu quá/sắp hạn)**, lần mua gần nhất. CTA cố định **Cập nhật chăm sóc**.

**M4. Tab Sản phẩm đã mua (3 tháng)** — 3 số tổng: Đơn hàng / Tổng giá trị / Sản phẩm. Danh sách đơn theo ngày giảm dần: ngày, mã đơn, tổng tiền; dòng SP: ảnh, tên, số lượng + đơn vị, thành tiền.

**M5. Tab Lịch sử chăm sóc** — Timeline giảm dần: icon theo outcome, ngày, nhãn outcome, dược sĩ, ghi chú, mã đơn (nếu có). Nút "Xem thêm lịch sử" (phân trang). Hiển thị **mọi** interaction của KH, kể cả của dược sĩ trước (khi chuyển giao).

**M6. Cập nhật chăm sóc** (full-screen form) — (1) Radio 6 outcome; (2) Ghi chú textarea, đếm ký tự /500; (3) Ngày chăm sóc tiếp theo (date picker, hiện/bắt buộc theo outcome — BR-03); outcome `ORDERED` → hiện chọn/nhập mã đơn; `REFUSED` → hiện tuỳ chọn liên hệ. Nút **Lưu kết quả chăm sóc** disabled đến khi đủ điều kiện.

### 9.2 Web — Admin / Store Manager (mockups/03, 04)
Layout: sidebar (Trang chủ, Khách hàng, Phân công, Chăm sóc, Báo cáo, Cài đặt), filter "Tất cả cửa hàng" trên header, search toàn cục, chuông, user.

**W1. Tổng quan Chăm sóc KH** (04 trên-trái): filter tháng; 4 KPI: Tổng KH trong danh sách / Đã phân công (%) / Chưa phân công (%) / Quá hạn (%); stacked bar theo cửa hàng (Đúng hạn / Quá hạn / Chưa chăm sóc); donut kết quả chăm sóc.

**W2–W5. Wizard Import & phân công** — xem 5.1.

**W6. Chi tiết chăm sóc KH** (03 trên-trái): thông tin KH, dược sĩ phụ trách, ngày hẹn, trạng thái; 4 KPI KH (tổng số đơn, tổng chi tiêu, đơn gần nhất, thời gian là KH); tab Tổng quan / Sản phẩm đã mua (bảng: ngày, mã đơn, SP, SL, thành tiền, cửa hàng, xem chi tiết) / Lịch sử.

**W7. Lịch sử & cập nhật kết quả (web)** (03 trên-phải): timeline + form cập nhật giống M6, có thêm **Nhắc nhở** (dropdown) và **Đính kèm** (ảnh/PDF ≤10MB) `[Q-16 — có làm ở GĐ1 không]`.

**W8. Báo cáo tổng quan** (03 dưới-trái) & **W9. Báo cáo chi tiết** (03 dưới-phải) — xem mục 10.

## 10. Dashboard — định nghĩa chỉ số `[CẦN XÁC NHẬN Q-14, Q-17]`

Bộ lọc chung: kỳ (theo **`assigned_at` của task** — mặc định), cửa hàng, dược sĩ, trạng thái.

| Chỉ số | Công thức mặc định |
|---|---|
| Tổng KH cần chăm sóc | count(task INITIAL, không CANCELLED) trong kỳ |
| Đã chăm sóc | count(task có ≥1 interaction) |
| Hoàn thành đúng hạn | count(COMPLETED & completed_at ≤ due_date) / Tổng KH cần chăm sóc |
| Quá hạn | count(status = OVERDUE) (+ % trên tổng) |
| Tỷ lệ chuyển đổi đơn hàng | count(task có interaction ORDERED **VERIFIED**) / Đã chăm sóc |
| Doanh thu từ chăm sóc | sum(verified_order_amount) |
| KH quay lại | count(distinct KH có đơn VERIFIED trong kỳ) |
| Tỷ lệ tiếp tục mua trong 30 ngày | KH có ≥1 đơn trong 30 ngày sau interaction thành công / KH chăm sóc thành công |
| Tỷ lệ kết quả (donut) | phân bố outcome của **interaction cuối** mỗi task |
| Xu hướng theo ngày | theo ngày: số KH cần chăm sóc (đến hạn) vs số KH đã chăm sóc |
| "so với tháng trước" | cùng chỉ số, kỳ liền trước cùng độ dài |

**W9 bảng theo dược sĩ**: Dược sĩ, Số KH phân công, Đã chăm sóc (%), Quá hạn (%), Tỷ lệ chuyển đổi, Doanh thu. **Bảng theo cửa hàng**: Cửa hàng, Tổng KH, Đã liên hệ (%), Đã đặt đơn (%), Quá hạn (%), Tỷ lệ đúng hạn. Sort cột, phân trang, **Xuất Excel**.

## 11. Nhắc việc `[CẦN XÁC NHẬN Q-16]`
Mặc định: thông báo in-app (chuông) + push nếu app hiện có hỗ trợ:
- Có phân công mới; task đến hạn trong 1 ngày; task chuyển Quá hạn; `next_action_date = hôm nay` (gửi 8:00 sáng).

## 12. Job nền
| Job | Lịch | Việc |
|---|---|---|
| mark_overdue | 00:05 hằng ngày | PENDING/IN_PROGRESS có due_date < hôm nay → OVERDUE + notify |
| daily_reminders | 08:00 hằng ngày | Gửi nhắc FOLLOW_UP_TODAY / DUE_SOON |
| verify_orders | mỗi 1h (cấu hình) | Đối soát interaction ORDERED PENDING với Circa |
| sync_circa | theo cơ chế sẵn có của app | Cập nhật KH/đơn/SP `[Q-13]` |
Job phải **idempotent**.

## 13. Phi chức năng
- Múi giờ `Asia/Ho_Chi_Minh`; định dạng ngày `dd/MM/yyyy`; tiền `1.250.000đ`.
- Import 10.000 dòng xử lý không timeout (xử lý nền/chunk nếu cần), có tiến trình.
- Phân quyền kiểm tra ở **backend**, không chỉ ẩn UI.
- Audit: ai tạo/chuyển/huỷ task, ai import.
- UI theo **design system hiện có** của duocsi.circa.vn; mockup chỉ là tham khảo bố cục/thông tin.

## 14. Acceptance criteria (GĐ1)

- **AC-01** Import file hợp lệ 1.250 dòng có 50 lỗi, 20 trùng → bước 2 hiển thị đúng 1.250 / 1.180 / 50 / 20; chỉ dòng hợp lệ được chọn để phân công.
- **AC-02** Phân bổ đều 1.180 KH cho 5 dược sĩ → mỗi người 236; không cho "Tiếp tục" khi tổng ≠ số đã chọn.
- **AC-03** Sau "Hoàn tất phân công", dược sĩ đăng nhập thấy task mới ở M1/M2 với đúng hạn; nhận thông báo.
- **AC-04** Dược sĩ chỉ thấy task của mình; gọi API task người khác → 403.
- **AC-05** Không lưu được interaction khi thiếu outcome hoặc ghi chú; thiếu ngày tiếp theo với UNREACHABLE/CALLBACK/INTERESTED; thiếu mã đơn với ORDERED.
- **AC-06** Lưu 3 interaction liên tiếp cho cùng KH → tab Lịch sử có 3 bản ghi, bản cũ không đổi.
- **AC-07** Task PENDING có due_date = hôm qua → sau job 00:05 thành OVERDUE; badge đỏ; vẫn ghi nhận được, khi hoàn thành có `completed_late = true`.
- **AC-08** ORDERED với mã đơn không thuộc KH → REJECTED, không tính doanh thu; mã đơn hợp lệ trong cửa sổ → VERIFIED, doanh thu dashboard tăng đúng số tiền.
- **AC-09** Store Manager chuyển 20 task từ DS A sang DS B → A không còn thấy, B thấy kèm toàn bộ lịch sử; có log chuyển giao.
- **AC-10** REFUSED → KH bị gắn do_not_contact; import lại KH đó bị đánh dấu ở bước Kiểm tra dữ liệu.
- **AC-11** Số liệu dashboard khớp truy vấn kiểm tra thủ công trên cùng bộ lọc; Xuất Excel đúng dữ liệu đang lọc.
- **AC-12** Store Manager chỉ thấy dữ liệu cửa hàng mình trên mọi màn và API.

## 15. Thứ tự triển khai gợi ý (vertical slices)
1. Schema + enum + state machine (unit test transitions).
2. Import & validate (W2–W3) + lịch sử import.
3. Phân công (W4–W5) + notification NEW_ASSIGNMENT.
4. Mobile M1–M5 (read) dùng dữ liệu Circa sẵn có.
5. M6 / W7 ghi nhận interaction + rules BR-02..04, BR-08.
6. Jobs: overdue, reminders.
7. Xác thực đơn (ORDERED) + verify job.
8. Reassignment (BR-07).
9. Dashboard W1, W8, W9 + export.
