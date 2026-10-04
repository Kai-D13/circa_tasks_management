# Module "Chăm sóc & nhắc khách hàng (Growth)" — Bản làm rõ yêu cầu v0.2

> Trạng thái: **DEFINE / BRAINSTORM**. Chưa chốt contract, chưa có spec PM, **không sửa code**.
> Ngày: 2026-10-01. Nguồn: mockup 3 màn hình (chỉ là UI/UX flow) + 2 bảng BigQuery sơ khai do user cung cấp.
> v0.1 hiểu nhầm là "cửa hàng áp dụng khuyến mãi + chụp ảnh quầy". v0.2 sửa lại sau khi có dữ liệu.

---

## 1. Hiểu lại bài toán

**Bản chất:** đây là một **worklist chăm sóc khách hàng** (CRM-lite) cho dược sĩ, không phải kiểm tra trưng bày.

```
BI (Growth) tính ra danh sách KHÁCH cần được liên hệ trong kỳ
  (vd: khách mua thuốc mạn tính ngày X → sắp hết thuốc → nhắc tái mua; có thể kèm ưu đãi)
→ mỗi khách (tại 1 cửa hàng) được gán cho 1 DƯỢC SĨ phụ trách
→ admin import vào app (Excel, v1) → app tạo việc cho từng dược sĩ, nhóm theo tháng
→ dược sĩ xem thông tin khách + SP đã mua + chương trình KM + hướng dẫn (kịch bản)
→ liên hệ khách → ghi kết quả → đánh dấu Hoàn thành
→ HQ theo dõi tiến độ; (nên) đo chuyển đổi: khách có quay lại mua không
```

**Đọc lại mockup theo nghĩa này:**

| Thành phần mockup | Nghĩa khả dĩ | Nguồn dữ liệu |
|---|---|---|
| Nhóm `Tháng 10 (0/8)` | Kỳ nhắc; `0/8` = số khách dược sĩ đã chăm sóc / tổng khách được gán trong tháng | kỳ import |
| Mỗi dòng danh sách | **1 khách hàng** (hoặc 1 khách × 1 chương trình) — không phải 1 chương trình chung | `fact_circa_growth_reminder` |
| "Chương trình" + ảnh + Xem thêm | Chương trình KM đi kèm (nếu có) | `promotion_campaign`, `promotion_code` |
| "Hướng dẫn" | Kịch bản/tư vấn cho dược sĩ khi gọi khách | admin nhập theo chương trình/kỳ |
| "Danh sách sản phẩm (2)" + SL + giá sau KM | SP khách đã mua / nên tái mua, giá sau giảm | `product_*`, `discount_*`, `percent` |
| "Hình ảnh" + Cập nhật / Hoàn thành / Chỉnh sửa | Bằng chứng chăm sóc (ảnh chat Zalo? ảnh đơn mới?) + lưu nháp → hoàn thành → sửa | ❓ cần chốt |
| Badge Chưa/Hoàn thành | Trạng thái chăm sóc (cần thêm kết quả: gọi được / không nghe máy / đã mua / từ chối) | app |

---

## 2. Phân tích 2 bảng BigQuery (sơ khai)

**`dim_circa_growth_staff_customer`** — gán khách → dược sĩ
`pharmacist_name, pos_name, customer_name, customer_phone`

**`fact_circa_growth_reminder`** — việc cần nhắc
`product_id, product_name, product_category, promotion_code, promotion_campaign, discount_type, discount_value, percent, order_pos_id, pos_name, order_code (DHC…), order_created_date, customer_name, phone_number, email, gender, reminder_type ("Chronic")`

**Khớp được với hệ thống hiện có:**
- `pos_name` "CIRCA AKARI" → `POS0080` qua `lib/targets/posMap.ts` (đã có map 25 POS) ✅
- `customer_phone` "346859296" (BQ làm mất số 0 đầu) → `normalizeVnPhone()` (`lib/affiliate/phone.ts`) trả `0346859296` ✅ — cùng identity khách đang dùng cho KPI Số khách Affiliate (`customer_phone_norm`, mig 104)
- `order_code` DHC… → cùng định dạng `^DHC\d{6,12}$` của module Toa thuốc ✅ (có thể link toa đã nộp)
- Pull BigQuery: `lib/targets/bigquery.ts` + `BQ_SERVICE_ACCOUNT_KEY` ✅ — **nhưng SA hiện chỉ có quyền dataset `buymed_tech`, KHÔNG có `gold_buymed_vn2`** (ghi chú tại `bigquery.ts:38`; lần BQ-V2 BI phải mirror gold → `tech__*`)

**Thiếu / rủi ro trong dữ liệu:**

| Vấn đề | Tại sao quan trọng | Đề xuất |
|---|---|---|
| `pharmacist_name` là tên tự do | Không map chắc chắn sang `users` (trùng tên, dấu, biệt danh, nghỉ việc) | BI thêm **email dược sĩ** (khớp `users.email`) hoặc SĐT (`users.phone_number`, mig 055) |
| `pos_name` thay vì `pos_code` | Đổi tên store là gãy | Thêm `pos_code` |
| Không có **ngày cần nhắc** (`reminder_date`/`due_date`), chỉ có `order_created_date` | App không biết "bao giờ gọi"; Rx module tính từ `days_supply` | BI tính sẵn `reminder_date` (+ `days_supply` nếu có) |
| Không có **khóa ổn định** cho 1 reminder | Import lại tháng sau → trùng/đè? | BI cấp `reminder_id` (hoặc khóa tổ hợp phone+product_id+order_code+period) |
| Không có **kỳ** (`period`/tháng) | Nhóm "Tháng 10" dựa vào gì? ngày import? ngày nhắc? | Thêm `period_month` hoặc quy ước = tháng của `reminder_date` |
| Không có **số lượng** ("5 Hộp" trong mockup) | Mockup có, bảng không | Hỏi: có cần không, lấy từ đâu |
| Promotion toàn null trong mẫu | Chưa rõ cấu trúc KM (theo SP? theo khách? theo kỳ?) | Cần mẫu có KM thật |
| 1 khách có N sản phẩm / N đơn | Mỗi dòng fact = 1 SP. Đơn vị việc là **khách** hay **khách×SP**? | Đề xuất: 1 việc = 1 khách/kỳ, bên trong N SP |
| Dim và Fact đều có `customer_name` | Tên có thể lệch ("co huong" vs "chị Hương") | Join bằng phone chuẩn hoá + pos_code, tên chỉ hiển thị |
| PII + dữ liệu sức khoẻ (thuốc kê đơn, mạn tính) | Nhạy cảm hơn mọi module hiện có | RLS chặt theo người được gán; không đưa PII vào Teams/log/export rộng; không lưu public storage |

---

## 3. Đề xuất data contract (để BI/PM phản biện — CHƯA chốt)

Một file/bảng duy nhất, mỗi dòng = 1 (khách × sản phẩm × kỳ); app gom theo khách:

| Cột | Bắt buộc | Ghi chú |
|---|---|---|
| `reminder_id` | ✅ | khóa idempotent |
| `period_month` (YYYY-MM) | ✅ | nhóm "Tháng 10" |
| `pos_code` | ✅ | thay cho pos_name |
| `pharmacist_email` | ✅ (cho phép trống = chưa gán) | khớp `users.email` |
| `customer_phone` (chuỗi, giữ số 0) | ✅ | identity khách |
| `customer_name`, `gender`, `email` | ○ | hiển thị |
| `reminder_type` | ✅ | Chronic / Promotion / … |
| `reminder_date` | ✅ | ngày nên liên hệ |
| `order_code`, `order_created_date` | ○ | ngữ cảnh + link toa |
| `product_id`, `product_name`, `product_category`, `quantity` | ✅/○ | |
| `promotion_code`, `promotion_campaign`, `discount_type`, `discount_value`, `percent`, `promo_price` | ○ | |
| `guidance` / mã chương trình để tra hướng dẫn | ○ | kịch bản gọi |

Nguyên tắc: **cùng một parser** cho Excel upload (v1) và pull BigQuery (v2) — như Referral đã làm (upload + Sheet dùng chung `lib/referrals/parse.ts`). Nếu BI mirror bảng sang `buymed_tech`, bước Excel có thể bỏ hẳn.

---

## 4. Mô hình nghiệp vụ đề xuất (draft để brainstorm)

**Thực thể**
- `care_batches` (kỳ import: tháng, file, người import, thống kê, trạng thái)
- `care_customers` (khách × cửa hàng × kỳ: phone_norm, tên, dược sĩ được gán, trạng thái, kết quả, ghi chú, bằng chứng, thời điểm)
- `care_customer_products` (SP + KM của khách trong kỳ)
- `care_programs` (chương trình KM: tên, ảnh, mô tả, hướng dẫn) — nếu stakeholder xác nhận có lớp "chương trình"
- `care_events` (audit: gán/đổi dược sĩ, cập nhật, hoàn thành, sửa)

**Vòng đời 1 khách/kỳ**
`chưa liên hệ → đã liên hệ (kết quả: nghe máy / không nghe / sai số / từ chối / đã mua) → hoàn thành` · cho phép "Cập nhật" nhiều lần (nháp) · "Chỉnh sửa" sau hoàn thành tới hết kỳ · (tuỳ chọn) quá hạn khi qua `reminder_date` + N ngày

**Vai trò**
- Dược sĩ: chỉ thấy khách được gán cho mình; thao tác trên mobile
- QLCH: thấy khách của cửa hàng; (đề xuất) được **gán lại** khi dược sĩ nghỉ/đổi ca; không thao tác thay? (hỏi)
- Admin phòng Growth (cổng phòng ban như Policy→FS): import, theo dõi, export
- SM: xem tiến độ vùng (read-only)
- Super: tất cả

**Đo lường cho HQ (đáng giá nhất của module):** tỷ lệ hoàn thành theo dược sĩ/cửa hàng/kỳ; **chuyển đổi** = khách được nhắc có đơn mới trong 30 ngày (BI tính vòng sau, app chỉ cần xuất danh sách đã nhắc + ngày)

---

## 5. Đối chiếu & tái dùng hệ thống hiện có

| Có sẵn | Dùng cho |
|---|---|
| `normalizeVnPhone`, `maskVnPhone` (`lib/affiliate/phone.ts`) + SQL `normalize_phone` (059) | identity khách, che PII trong log |
| `POS_CODE_BY_NAME` (`lib/targets/posMap.ts`) | fallback nếu BI vẫn gửi pos_name |
| Pattern import Excel + RPC replace atomic: Referral (059/061), KPI (`rpc_replace_campaign_targets`), Tasks import (034) | import kỳ, validate toàn bộ trước khi ghi, all-or-nothing |
| Pattern pull BigQuery + gate (`lib/targets/kpiPlan.ts`) | v2 tự động |
| Module Toa thuốc: `prescription_care_logs` (073), `deriveCareState`, upload ảnh chăm sóc `prescription_care` | mẫu "ghi nhận chăm sóc + ảnh bằng chứng" đã chạy thật |
| Staff mobile cards, skeleton, bottom nav (M0-M6) | UI dược sĩ |
| Teams outbox | thông báo QLCH khi có kỳ mới (KHÔNG kèm PII) |
| Cổng phòng ban (`department_id` + helper SECDEF) | admin Growth |

**⚠️ Chồng lấn P0 với module "Toa có ngày dùng" (Rx chronic care):** hiện dược sĩ đã có một luồng nhắc tái mua dựa trên toa họ tự nộp (`days_supply` → `reminder_date` → `care_status`). Module mới là luồng nhắc **do BI tính từ lịch sử đơn POS**. Cùng một khách có thể xuất hiện ở cả hai nơi → dược sĩ bị nhắc 2 lần, số liệu HQ tách đôi. Cần quyết định sản phẩm: (a) module mới **thay thế** nhắc Rx, (b) **gộp** vào một worklist chung, (c) tách biệt có khử trùng theo phone+product. Đây là câu hỏi quan trọng nhất cho stakeholder/PM.

---

## 6. Hướng tiếp cận (để PM quyết)

**A. Xây trên Tasks** (mỗi khách = 1 task `assignment_mode='user'`, `source_type='customer_care'`)
➕ gán việc, thông báo, log, trạng thái có sẵn. ➖ **PII/sức khoẻ nằm trong bảng `tasks`** có RLS rộng (visibility `public`, export, cùng phòng ban xem chéo) → rủi ro lộ dữ liệu; không có kết quả liên hệ; khối lượng lớn làm nhiễu `/tasks`. **Không khuyến nghị.**

**B. Module độc lập** (bảng `care_*`, RLS theo người được gán, RPC import/hoàn thành atomic) — như FS Products
➕ kiểm soát PII chặt, trạng thái/kết quả đúng nghiệp vụ, nhóm theo kỳ tự nhiên, dễ gắn pull BigQuery sau. ➖ tốn công hơn (notify/export/overdue viết riêng). **Thiên hướng: B.**

**C. Mở rộng module Toa thuốc** (thêm nguồn reminder từ BI vào `prescription_*`)
➕ một worklist cho dược sĩ, tái dùng care log. ➖ schema Rx xoay quanh toa tự nộp (ảnh bắt buộc, DHC unique); chạm module đang live; promotion/gán dược sĩ không có chỗ. Có thể là **bước 2** của B (gộp view).

**Pilot 0-code:** không phù hợp như v0.1 nghĩ (task broadcast không mang PII an toàn, không gán theo khách). Nếu cần chạy tháng 10 → chạy ngoài app (Sheet) và đo tay.

---

## 7. Rủi ro chính
1. **PII + dữ liệu y tế** (tên, SĐT, giới tính, thuốc kê đơn mạn tính): cần RLS theo người được gán, mask trong log, không public storage, export giới hạn, cân nhắc thời gian lưu. Module Toa thuốc hiện để ảnh ở bucket public — không lặp lại.
2. **Định danh**: dược sĩ theo tên, store theo tên, phone mất số 0 → nếu không sửa ở nguồn, import sẽ có tỉ lệ "không gán được" cao; cần hàng đợi "chưa gán" + QLCH gán tay.
3. **Trùng nhắc với Rx chronic care** (mục 5).
4. **Excel import tay hằng tháng**: schema trôi, lỗi người dùng, chậm; BigQuery đã có bảng → nên tiến tới pull tự động, cần BI cấp quyền dataset hoặc mirror sang `buymed_tech`.
5. **Khối lượng**: chưa biết bao nhiêu khách/kỳ/dược sĩ → ảnh hưởng UI, import, notify.
6. **Biến động nhân sự**: dược sĩ nghỉ/đổi store giữa kỳ → cần gán lại; BI tính gán theo gì?
7. **Không có staging**: module ghi nhiều, có PII → QA trên prod bằng fixture `is_test` khó hơn; nên đặt lại câu hỏi staging với DevOps.

---

## 8. Câu hỏi cần trả lời

**P0 — quyết định hình dạng module (stakeholder Growth + PM)**
1. Đơn vị công việc của dược sĩ là **1 khách/kỳ** (bên trong N sản phẩm) hay **1 khách × 1 sản phẩm**? Danh sách trên mobile hiển thị theo khách?
2. "Take care" cụ thể là làm gì: gọi điện / nhắn Zalo / tư vấn tại quầy? **Bằng chứng hoàn thành** là gì — ảnh (ảnh gì?), ghi chú, kết quả chọn sẵn, hay mã đơn mới? Có bắt buộc không?
3. Quan hệ với module **Toa có ngày dùng** hiện tại: thay thế / gộp / tách? Ai đang dùng Rx reminder thật và có muốn giữ không?
4. **Gán dược sĩ**: BI quyết định theo tiêu chí gì (người bán gần nhất? đều tay?)? Khách không có dược sĩ thì sao? QLCH có được gán lại không? Dược sĩ nghỉ việc giữa kỳ xử lý thế nào?
5. Kỳ nhắc: theo **tháng** cố định? Import 1 lần/tháng hay bổ sung liên tục? Nhắc có **ngày đến hạn** riêng từng khách (`reminder_date`) không?

**P1 — dữ liệu (BI)**
6. Có thể bổ sung `pharmacist_email`, `pos_code`, `reminder_date`, `reminder_id`, `period_month`, `quantity`, `promo_price`? Phone giữ dạng chuỗi có số 0?
7. Cấu trúc khuyến mãi: gắn theo SP, theo khách, hay theo kỳ? Cho xin mẫu có KM thật. "Hướng dẫn" ai soạn, lưu ở đâu?
8. Có `reminder_type` nào khác "Chronic"? (Promotion, Birthday, Win-back…)
9. Khối lượng dự kiến: số khách/kỳ, số dược sĩ, số SP/khách.
10. BI có thể cấp quyền SA đọc `gold_buymed_vn2` hoặc mirror sang `buymed_tech` để app pull tự động (bỏ Excel) không?
11. BI có muốn nhận lại kết quả chăm sóc (export/bảng) để đo chuyển đổi không? Định dạng?

**P2 — phạm vi & vận hành (stakeholder + PM)**
12. HQ cần màn hình gì trên desktop: import, danh sách theo kỳ/cửa hàng/dược sĩ, tiến độ, gán lại, export?
13. QLCH/SM thấy gì? Có thao tác thay dược sĩ không?
14. Thông báo: Teams cho QLCH khi có kỳ mới? nhắc dược sĩ gần hạn? (không kèm PII)
15. Thời gian lưu dữ liệu khách; có cần xoá/ẩn sau N tháng?
16. Lịch mong muốn (tháng 11? cuối Q4?) — để PM chia batch.
17. Tên module & vị trí nav (bottom nav staff đang 5 tab cố định): "Chăm sóc KH" thay tab nào / gộp vào "Toa thuốc"?

---

## 9. Bước tiếp theo
1. User chuyển mục 8 (P0 trước) cho stakeholder Growth và BI; mục 3 cho BI phản biện contract.
2. Xin **1 file mẫu đầy đủ** (≥ 50 dòng, có khuyến mãi thật, có khách nhiều SP) để tôi phân tích thực tế thay vì 1 dòng.
3. PM viết spec theo khung `docs/plan-*.md` sau khi P0 chốt; tôi review trước khi batch 114.x.
4. Ghi chú riêng: sau khi ra khỏi plan mode, lưu memory "user thích làm rõ bằng chat tự do hơn chọn ô" + trạng thái module này.
