# CMS theo sản phẩm — vết quyết định

> Module CMS. Tách khỏi `planning/research/crm-cskh-handoff/DECISIONS.md` (CRM-CSKH).
> Nguồn: spec r2 (chat PM, operator lưu `docs/PLAN.md` ngoài Git 01/11/2026), review PM `planning/reviews/2026-11-01-cms-r2-dev-intake-pm.md` (01/11), spec r1 (`cms-handoff-r1`, 31/10–01/11).
> Thứ tự ưu tiên khi lệch: quyết định operator mới nhất → spec r2 → quyết định PM ở review intake → r1 (phần không bị thay). Riêng các điểm review PM đã sửa r2 (review §2/§5: Q chặn âm, thập phân 9 chữ số, đọc ô Excel, ảnh) thì review PM thắng r2.
> Mã Q-206…Q-213 dành riêng cho CMS, không cấp lại cho module khác. **Mã Q kế tiếp chỉ ghi ở khối Hiện trạng sống `planning/STATE.md`.**
> Nhãn: **[Operator]** quyết định operator/stakeholder · **[PM]** quyết định/diễn giải PM · **[Pending]** chưa chốt, Dev không tự chọn.

## 1. Câu hỏi r1 (CMS-Q1…CMS-Q11, BI-1) — kết luận cuối

| Mã | Câu hỏi r1 | Mặc định r1 | Kết luận hiện hành |
|---|---|---|---|
| CMS-Q1 | Target GMV và bậc số lượng tính theo dược sĩ hay nhà thuốc? | Từng dược sĩ | **[Operator]** Tính riêng **từng dược sĩ trong từng chương trình**. Tổng QLCH/SM cộng từ kết quả cá nhân, không áp lại bậc trên tổng nhà thuốc. |
| CMS-Q2 | Lũy tiến hay áp nguyên mức bậc cao nhất? | Lũy tiến (+ `flat`) | **[Operator]** **Chỉ lũy tiến.** `flat` / thưởng nguyên bậc không thuộc r2. |
| CMS-Q3 | Target danh mục đặt ở đâu; nhiều nhóm danh mục? | Một target / chương trình, nhập ở wizard | **[Operator]** **Đọc từ Excel**, **một target danh mục / chương trình**. Wizard bỏ ô target danh mục. |
| CMS-Q4 | GMV sau giảm giá, chưa VAT? | Đúng | **[Operator] Thay đổi so với r1:** GMV CMS = **nguyên `item.amount`** của dòng hợp lệ, **giữ VAT**, **không phân bổ voucher**, không tính lại từ `quantity × unit_price`, không dùng tổng thanh toán của order. Không khôi phục yêu cầu "chưa VAT" hoặc phân bổ voucher của r1 / trao đổi cũ. Tên trường chuẩn `gmv_amount`. |
| CMS-Q5 | `CMS_VND_SP` theo đơn vị nào; quy đổi bán lẻ? | Theo `qty` của BI | **[Operator]** Admin khai báo `unit_CMS` + `base_quantity_CMS` trong file import; app quy đổi từ `base_quantity` (xem Q-210b). Product Master không quyết định đơn vị hưởng CMS. |
| CMS-Q6 | Một SP thuộc hai chương trình chạy cùng lúc? | Không | **[Operator]** Không — một ProductID không thuộc hai chương trình **đã kích hoạt** có khoảng ngày giao nhau (tính cả hai đầu), **kể cả khác nhà thuốc**. Nháp được cùng chuẩn bị. Chương trình đã chốt giữ quyền sở hữu ProductID trong khoảng ngày lịch sử. |
| CMS-Q7 | Đơn trả sau khi chốt kỳ? | Không sửa số chốt, báo cáo riêng | **[Operator — đã chốt]** Không sửa số đã chốt; báo cáo phát sinh sau chốt riêng. Hợp đồng nhận diện/quy thuộc dòng trả còn HOLD Q-206; triển khai P3 chưa được giao. Không đánh dấu lại chính sách này là chưa có quyết định. |
| CMS-Q8 | ONLINE / Affiliate có tính CMS? | Không | **[Operator]** Chỉ `order_type = OFFLINE`, `order_status = COMPLETED`. |
| CMS-Q9 | Sửa bậc / target giữa kỳ? | Không, chỉ thêm SP | **[Operator]** Từ ngày bắt đầu chỉ **thêm ProductID mới**, tính **hồi tố** từ đầu chương trình (Q-209); khóa target, bậc, loại GMV, `unit_CMS`, `base_quantity_CMS` của SP đã có. |
| CMS-Q10 | QLCH xem tổng CMS nhà thuốc mình? | Không | **[Operator] Thay đổi so với r1:** QLCH (`store_manager`, tài khoản dùng chung) **xem danh mục và tổng CMS của các staff hiện thuộc nhà thuốc mình**; **không có CMS cá nhân**. |
| CMS-Q11 | CMS cộng / loại trừ Commission Store của Chiến dịch KPI? | Độc lập | **[Operator — đã chốt]** CMS độc lập với KPI campaigns/targets và Commission Store; không cộng gộp, cấn trừ hoặc dùng Commission Store để điều chỉnh kết quả CMS. Không xây tích hợp chi trả giữa hai module trong batch này. Việc P3 đang HOLD không làm quyết định độc lập này trở thành pending. |
| BI-1 | Tên, cột, lịch cập nhật 2 view BI; Product Master từ hệ thống nào? | — | **[Operator 01/11]** Hai view chuẩn CMS **chưa tồn tại**. Mẫu lấy từ nguồn thô `buymed_circa_v2.{order_order_item, order_order, entity_entity, entity_pos_profile, product_product}` + `gold_buymed_vn2.dim_product` (xem SPEC §1.4). **[Dev đọc 01/11]** SA của app (scope readonly) bị **403** trên cả 6 bảng nguồn thô; đọc được `buymed_tech`. **[PM]** Tên nguồn qua env `CMS_BQ_PRODUCTS_TABLE` / `CMS_BQ_SALES_TABLE`, không hardcode nguồn thô, không nới quyền SA trong batch này. Product Master đọc được bằng SA = gate phát hành P1; feed dòng bán = gate số đo P0 + P2. |

Các quyết định r1 vẫn giữ: D2 (CMS cho từng dược sĩ bán, không chia pool), D3 (3 loại gate), D4 (thang bậc theo số lượng; SP 1 bậc = thang 1 dòng), D5 (ProductID liên kết Product Master lấy tên, ảnh), D6 (Upload → Run → Kết quả; nhóm lỗi bị loại, nhóm hợp lệ xử lý), D7 (nội dung tư vấn bắt buộc, đã kiểm duyệt chuyên môn). D1 r1 (BI cấp view dòng đơn có mã người bán) bị thay bởi Q-207.

## 2. Q-206…Q-213

| Mã | Nội dung / quyết định mới nhất | Trạng thái |
|---|---|---|
| **Q-206** | Quy thuộc dòng trả về dược sĩ / chương trình / dòng bán gốc, nhất là trả sau kỳ. Cần xác định: nhận diện dòng bán gốc / dòng trả; quy thuộc đúng dược sĩ và chương trình; trả trong kỳ, sau ngày kết thúc nhưng trước chốt; phân biệt hủy snapshot và sự kiện trả riêng; dữ liệu đến muộn / cập nhật lại; feed phát sinh sau chốt. | **HOLD** theo operator. Chặn bật tiền thật và P3; **không chặn P1**. Dev không tự chọn mặc định cho adapter trả hàng production; không suy dòng bán âm từ `status`. |
| **Q-207** | Người hưởng là **staff cá nhân**; `o.updated_by` → `entity_entity.email` → `public.users.email` (operator xác nhận `updated_by` luôn là dược sĩ hoàn thành đơn và không thay đổi); `seller_code` không liên quan; QLCH tài khoản chung không có CMS cá nhân; không dựng workflow nghỉ việc. | Đã chốt operator |
| **Q-208** | Phạm vi theo `users.store_id` **hiện tại**; SM/QLCH xem staff hiện thuộc nhà thuốc mình. POS chỉ để đối soát; POS đã chặn bán sai nhà thuốc, CMS không xây nghiệp vụ bán chéo POS. | Đã chốt operator |
| **Q-209** | Bổ sung ProductID mới khi chương trình đã bắt đầu được tính **hồi tố từ đầu kỳ**. Không phát sinh nhà thuốc mới trong phạm vi vận hành dự kiến (phạm vi `all` = danh sách OS active lúc kích hoạt). | Đã chốt operator |
| **Q-210a** | Bậc cuối **hữu hạn tạo trần**; số lượng vượt trần không có thêm CMS; GMV và số lượng bán thực tế vẫn giữ đủ. | Đã chốt operator |
| **Q-210b** | Cộng dồn số lượng cơ sở cả kỳ, chia theo `base_quantity_CMS` admin import rồi `floor`; phần lẻ cộng tiếp trong kỳ, không chuyển sang chương trình khác; `unit_CMS` là nhãn hiển thị và hưởng thưởng; `base_unit` không bắt buộc. Thay đề xuất ban đầu "BI quy đổi về đơn vị CMS". | Đã chốt operator |
| **Q-211** | `gate_met_at` = lần chuyển từ chưa đạt sang đạt **gần nhất**; gate đang không đạt thì không hiện "Đạt từ"; câu "tụt do trả hàng ngày…" chỉ hiện khi dữ liệu chứng minh được sự kiện gây tụt. | Đã chốt operator; đầu vào trả hàng vẫn chờ Q-206 |
| **Q-212** | Bỏ thống kê theo tháng; A1 tách **CMS tạm tính chương trình đang chạy** và **CMS chương trình chờ chốt**. "SP có CMS x/y": x = số ProductID có ít nhất một dược sĩ CMS > 0. "Lượt" = dược sĩ × sản phẩm. Gộp nhiều chương trình đếm user distinct. Mẫu số dùng tài khoản staff hiện có thuộc phạm vi nhà thuốc hợp lệ, không cộng QLCH dùng chung / nhân sự đã out; không thêm trạng thái "nhân viên active" mới. | Đã chốt; thay mặc định cũ có `store_manager` / người nghỉ |
| **Q-213** | Chốt kỳ khi còn dòng chưa gán: đề xuất chặn nếu vượt 2% GMV hoặc vượt 20 dòng; dưới ngưỡng cần xác nhận + lý do; lưu người chốt, lý do, snapshot bị loại; không đưa dòng đã loại trở lại payout sau chốt. Ngưỡng và người duyệt chưa được stakeholder chốt. | **Pending**; không triển khai P3 từ mặc định này |

## 3. Quyết định PM tại review intake 01/11 (phần đã GO)

| Mã | Quyết định |
|---|---|
| H4 | **[Operator]** ProductID = `item.product_id` = mã product_id POS; **không** phải `sku_code` / `product_code`. **[PM]** Canonical ID là text số nguyên, so sánh chính xác, không đi qua float. |
| H5 | D1 danh mục P1 cho staff/QLCH: **Sắp diễn ra** và **Đang chạy**, trong phạm vi nhà thuốc hiện tại; chương trình tương lai ghi ngày bắt đầu, chưa có số thực tế. Nháp không thấy. Chờ chốt kỳ / Đã chốt không vào danh sách chính D1 P1; đọc lịch sử P2 giữ theo spec. |
| H6 | SM vào A1/A3 **chỉ đọc** khi chương trình có nhà thuốc thuộc `sm_store_assignments` của mình; thấy active suy ra Sắp diễn ra / Đang chạy / Chờ chốt kỳ; không thấy draft hoặc test ngoài phiên QA đã kiểm soát; không tạo / import / kích hoạt. |
| H7 | **Cho kích hoạt** chương trình có ngày bắt đầu đã qua nếu khoảng ngày hợp lệ, có SP hợp lệ, không xung đột ProductID; xác nhận rõ áp dụng từ ngày bắt đầu (hồi tố) và sau kích hoạt chỉ còn thêm SP. Ngày kết thúc cũng đã qua ⇒ hiển thị Chờ chốt kỳ, không cấp quyền chốt P3 hay bật tiền. Ngày theo VN; activation và import cuối kiểm lại ngày/trạng thái trong transaction. |
| H8 | **Không xây** xóa, hủy hoặc quay về nháp trong r2 (không nút, action, RPC, trạng thái). Trước ngày bắt đầu vẫn sửa và nạp lại được. |
| H9 | Kiểm tra trùng chỉ trong **cùng namespace `is_test`** (test so test, thật so thật), nhất quán ở preview, commit, activation, sửa cấu hình, kể cả đồng thời. `is_test` do server/QA gate quyết định; client không tự chuyển thật ↔ test. Cron và báo cáo thật loại test; user thật không thấy test qua route, RPC, RLS, export. Tài khoản QA chỉ thấy qua phiên/marker QA hợp lệ. |
| H9b | **[PM xác nhận PR-0, 01/11]** Super admin cũng chỉ thấy chương trình QA qua marker QA hợp lệ. Quyền super admin không tự bỏ qua marker. Áp dụng đồng nhất ở route/RPC/RLS/export; thống kê A1 và báo cáo thật loại test. |
| H11 | **[Operator xác nhận 01/11 trong chat: "H11 – Quy trình: Xác nhận"; PM đồng ý về kỹ thuật]** "PR" = batch commit trên nhánh `feat/cms` (worktree `C:/circa-cms` từ `main` `01a9185`) kèm report để PM audit; không mở GitHub Pull Request. P2-a ở nhánh con riêng. Mỗi commit / push / merge / deploy / DDL prod vẫn cần lệnh operator riêng. |
| §2 / §5 | Mặc định kỹ thuật được PM sửa: Q = `floor(max(0, ΣB) / K)`; quy cách thập phân chính xác **tối đa 9 chữ số sau dấu chấm** (vượt ⇒ lỗi, không cắt / làm tròn); parser **không đoán** tiền từ text có dấu phân cách; ảnh dùng **Next Image** + `remotePatterns` HTTPS `cdn-gcs.thuocsi.vn` pathname `/thuocsi-live/images/**`, URL khác prefix ⇒ ảnh dự phòng + báo operator kiểm nguồn; reviewer sub-agent chỉ đọc source/diff và DB kiểm thử, không truy cập prod. Chi tiết ở `docs/cms/SPEC.md`. |
