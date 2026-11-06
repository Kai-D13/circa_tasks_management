# CMS theo sản phẩm — nghiệp vụ, phạm vi và điều kiện phát hành

> Bản **r2** (01/11/2026), thay toàn bộ r1 (`cms-handoff-r1`, 31/10) ở các phần r2 đã chốt lại.
> Nguồn: spec r2 do PM trình bày trong chat (operator lưu `docs/PLAN.md`, ngoài Git), review PM `planning/reviews/2026-11-01-cms-r2-dev-intake-pm.md`.
> Bộ tài liệu CMS:
> - `docs/plan-cms-product-commission.md` (file này): nghiệp vụ, quyết định, phạm vi, điều kiện phát hành.
> - `docs/cms/SPEC.md`: hợp đồng dữ liệu và đặc tả kỹ thuật.
> - `docs/cms/IMPLEMENTATION_PLAN.md`: PR (batch), phụ thuộc, AC, checklist nghiệm thu.
> - `docs/cms/DECISIONS.md`: vết quyết định CMS-Q1…Q11, Q-206…Q-213, quyết định PM H4–H11.
> - `docs/ui/UI_V2_CMS.md` + `docs/ui/mockups/cms/`: đặc tả UI (r1 + redline r2) và canvas tham chiếu bố cục.
>
> Tài liệu CMS tách riêng khỏi `planning/CONTRACT.md` / `planning/SPEC.md` của CRM-CSKH.
> **Trạng thái:** PR-0 r1.2 — PM đã đối chiếu và chấp thuận làm baseline tài liệu (review `planning/reviews/2026-11-01-cms-pr0-docs-pm.md`). Cho triển khai phần đã GO; commit vẫn theo lệnh operator. Thay `docs/PLAN.md` ở các nội dung đã được ghi đầy đủ trong bộ này.

## 1. Kết luận, thứ tự phát hành và nguồn sự thật

### 1.1. Kết luận PM

Đủ cơ sở triển khai **P0, P1 và phần tính toán P2 trên dữ liệu kiểm thử** theo đặc tả này.

Thứ tự phát hành đã thống nhất:

1. Phát hành **P1 — chương trình, import và danh mục tư vấn** trước.
2. Xây dựng, kiểm thử P2 song song với việc hoàn thiện nguồn BI.
3. ~~Bật số tiền cho người dùng sau khi hoàn tất hợp đồng dữ liệu, xử lý trả hàng Q-206 và các gate đối soát.~~ **PM 06/11 (docs/cms/DECISIONS.md §5):** bật **CMS tạm tính theo dữ liệu bán hiện có** (chưa bao gồm xử lý trả hàng); trả hàng Q-206 là phase sau (B1 người bán gốc, D1 kỳ ngày bán đã chốt cho phase đó).
4. P3 chốt kỳ chỉ được giao triển khai sau khi PM chốt bổ sung Q-206 và Q-213.

Các phần còn pending có ranh giới rõ ở §4. Dev không tự chọn cách xử lý nghiệp vụ cho những phần đó.

Phạm vi giao (PM 01/11):

| Phạm vi | Trạng thái |
|---|---|
| P0 — hợp đồng dữ liệu, adapter, mapping email | GO triển khai |
| P1 — DB nền, chương trình, import, danh mục và UI | GO triển khai |
| P2-a — engine và kiểm thử dữ liệu mẫu | GO triển khai |
| P2-b / P2-c | Chưa giao thực hiện |
| Bật số tiền P2 cho người dùng | ~~Chờ nguồn BI và Q-206~~ PM 06/11: GO local phase sales-only (migration 126, CMS tạm tính); trả hàng phase sau |
| P3 — chốt kỳ, payout | HOLD (chốt thật: `real.ready = false`, chờ Q-213 / Q-216 / policy chốt; trả hàng phase sau) |

GO triển khai không bao gồm quyền commit, push, merge, DDL prod, deploy hoặc bật cờ; mỗi việc đó cần lệnh operator riêng.

### 1.2. Thứ tự ưu tiên tài liệu

1. Quyết định mới nhất của operator.
2. Đặc tả r2 (bộ tài liệu này, sau khi PM đối chiếu PR-0).
3. Quyết định PM ở review intake 01/11 (ghi trong `docs/cms/DECISIONS.md` §3). **Riêng các điểm review PM đã sửa r2** (§2/§5 của review: Q chặn âm `floor(max(0,B)/K)`, thập phân tối đa 9 chữ số, quy tắc đọc ô Excel, ảnh Next Image) thì review PM thắng r2 và đã được ghi thẳng vào bộ tài liệu này.
4. Spec r1 đối với nội dung không bị r2 thay thế.
5. `docs/ui/UI_V2_CMS.md` và các mockup để tham khảo bố cục.
6. Số liệu minh họa trong mockup chỉ dùng làm fixture.

### 1.3. Các kết luận r1 được thay thế

| Nội dung r1 | Quyết định r2 |
|---|---|
| Target/bậc còn giả định theo dược sĩ | Tính riêng từng dược sĩ trong từng chương trình |
| Hỗ trợ cả `progressive` và `flat` | Chỉ triển khai lũy tiến |
| Target danh mục nhập ở wizard hoặc Excel | Đọc từ Excel; một target danh mục/chương trình |
| GMV sau giảm giá, chưa VAT | Dùng nguyên `item.amount`; giữ VAT, bỏ qua phân bổ voucher |
| `seller_code` là người bán | Không dùng cho CMS |
| Thêm `users.employee_code`, import CSV và fallback điện thoại | Bỏ; map bằng email lấy từ `o.updated_by` |
| BI quy đổi về đơn vị CMS | App quy đổi từ `base_quantity` theo hệ số admin import |
| Đơn vị CMS do Product Master quyết định | Admin khai báo `unit_CMS`, `base_quantity_CMS` |
| `base_unit` bắt buộc cho đối soát | Không bắt buộc |
| QLCH chỉ xem số của mình | QLCH dùng tài khoản chung, xem tổng nhà thuốc |
| SM xem theo POS của giao dịch | SM xem các dược sĩ hiện thuộc nhà thuốc được phân công |
| Sản phẩm bổ sung chưa rõ hiệu lực | Tính hồi tố từ đầu chương trình |
| `gate_met_at` là lần đầu đạt | Lần chuyển sang đạt gần nhất |
| Dashboard tính CMS theo tháng | Tách chương trình đang chạy và chờ chốt |
| RPC parse file Excel | Server ứng dụng parse; RPC kiểm tra payload và ghi atomic |
| D3 tính lại tiền riêng khi đọc | D3 đọc kết quả dòng đã được cùng engine tính và công bố |
| ProductID mẫu dạng `SKU001` | ProductID = `item.product_id` dạng số nguyên (H4); mẫu r1 chỉ còn là fixture lỗi / tài liệu lịch sử |

### 1.4. Giới hạn của batch

Bao gồm chương trình CMS, import, danh mục tư vấn, tính tạm tính, báo cáo, lịch sử và lộ trình chốt kỳ.

Không thuộc batch:

- ROI, lợi nhuận gộp, tỷ lệ CMS/lợi nhuận, tồn kho và nhãn hiệu quả kinh doanh.
- Cơ chế thưởng nguyên bậc.
- Quản lý nhân sự nghỉ việc hoặc lịch sử điều chuyển nhân sự.
- Thay đổi Commission Store của KPI hiện có.
- Tích hợp gọi API POS từ ứng dụng CMS.
- Thay đổi cấu trúc BottomNav.
- Xóa, hủy, tạm dừng, mở khóa hoặc quay chương trình về nháp (H8).

## 2. Đặc tả nghiệp vụ

### 2.1. Đối tượng và phạm vi tham gia

**Người hưởng CMS:** tài khoản cá nhân có `role = staff` (Q-207).

Email của người hưởng được lấy theo:

```text
order.updated_by
→ entity_entity.email
→ public.users.email
```

Operator đã xác nhận `updated_by` luôn là dược sĩ hoàn thành đơn và không thay đổi.

Quy tắc mapping:

- Chuẩn hóa email bằng trim và lowercase.
- Phải khớp duy nhất một tài khoản app.
- Tài khoản phải là staff thuộc nhà thuốc OS đang hoạt động.
- Không fallback qua số điện thoại hoặc `seller_code`.
- Email không khớp, khớp nhiều người hoặc khớp tài khoản dùng chung (`store_manager`) được đưa vào nhóm “Chưa gán dược sĩ”, kèm lý do. Admin / SM không phải người hưởng.

**Phạm vi chương trình** chọn nhóm dược sĩ qua nhà thuốc hiện tại của họ (Q-208). Không thêm điều kiện tính thưởng theo POS giao dịch sau khi đã xác định người bán và phạm vi tham gia.

POS vẫn được lưu để đối soát. Cơ chế POS hiện đã chặn bán sai nhà thuốc; CMS không xây thêm nghiệp vụ bán chéo POS.

Phạm vi `all` được chuyển thành danh sách nhà thuốc OS đang hoạt động tại lúc kích hoạt. Operator xác nhận không phát sinh nhà thuốc mới trong phạm vi vận hành dự kiến (Q-209).

### 2.2. Phân quyền

| Vai trò | Quyền |
|---|---|
| Staff | Xem chương trình đang áp dụng, nội dung tư vấn và kết quả cá nhân |
| QLCH / `store_manager` | Xem danh mục và tổng CMS của các staff hiện thuộc nhà thuốc mình |
| SM | Xem kết quả của các staff hiện thuộc những nhà thuốc được phân công; ở P1 xem A1/A3 danh mục chỉ đọc (H6) |
| Super admin | Quản lý chương trình, import, kích hoạt, đối soát và chốt kỳ khi P3 được duyệt |
| Admin thông thường, FS staff | Không được cấp quyền CMS từ batch này |

QLCH không có CMS cá nhân trên tài khoản dùng chung.

Quyền xem của SM/QLCH dựa trên `users.store_id` hiện tại (SM: `sm_store_assignments`). Đây là quyết định nghiệp vụ có chủ đích; không xây bảng lịch sử nhân sự.

Không thêm trạng thái “nhân viên active” mới. Mẫu số dược sĩ sử dụng các tài khoản staff hiện có thuộc phạm vi nhà thuốc hợp lệ, loại tài khoản QLCH dùng chung (Q-212).

Chương trình nhìn thấy theo vai trò ở P1:

| Vai trò | Nháp | Sắp diễn ra | Đang chạy | Chờ chốt kỳ | Đã chốt | Chương trình QA (`is_test`) |
|---|---|---|---|---|---|---|
| Super admin | Có | Có | Có | Có | Có | Chỉ trong phiên QA đã kiểm soát (marker QA hợp lệ — H9) |
| SM (A1/A3 chỉ đọc, có nhà thuốc được phân công trong phạm vi) | Không | Có | Có | Có | Có (P3a — chỉ đọc, số đã chốt trong phạm vi) | Chỉ trong phiên QA đã kiểm soát |
| Staff / QLCH (D1/D2, nhà thuốc hiện tại trong phạm vi) | Không | Có, ghi ngày bắt đầu | Có | Không vào danh sách chính D1 P1; P3a: nhóm "Đã kết thúc" của bộ chọn D1, D2 / D3 đọc được (tạm tính, chờ chốt) | Như Chờ chốt kỳ; số của run đóng băng, nhãn đã chốt (P3a) | Chỉ trong phiên QA đã kiểm soát |

Đọc lịch sử ở P2 (D3) giữ theo spec; bộ lọc D1 P1 không dùng để xóa hoặc giấu lịch sử phát sinh sau này (H5).

User thật — kể cả super admin — không nhìn thấy chương trình QA qua route, RPC, RLS hoặc export nếu không có marker QA hợp lệ; thống kê và báo cáo thật loại chương trình QA (H9/H9b; PM xác nhận ở audit PR-0).

### 2.3. Chương trình và trạng thái

Thuộc tính chính:

- Tên chương trình.
- Ngày bắt đầu, ngày kết thúc theo ngày Việt Nam, bao gồm cả hai đầu.
- Phạm vi nhà thuốc.
- Danh mục sản phẩm, đơn vị CMS, quy cách, target, bậc và tư vấn.
- Target danh mục suy ra từ Excel.
- Cách tính cố định `progressive`.
- Phạm vi gate cố định `pharmacist`.
- `is_test` do server/QA gate quyết định (H9).

Trạng thái lưu:

```text
draft → active → locked
```

Trạng thái hiển thị:

| Trạng thái lưu | Điều kiện ngày VN | Hiển thị |
|---|---|---|
| `draft` | Bất kỳ | Nháp |
| `active` | Chưa đến ngày bắt đầu | Sắp diễn ra |
| `active` | Trong khoảng áp dụng | Đang chạy |
| `active` | Qua ngày kết thúc | Chờ chốt kỳ |
| `locked` | Bất kỳ | Đã chốt |

Quyền sửa:

- **Nháp:** được sửa thông tin và nạp lại toàn bộ danh mục.
- **Đã kích hoạt nhưng chưa bắt đầu:** được sửa, nạp lại danh mục; kiểm tra trùng chương trình lại trong transaction.
- **Đã bắt đầu, chưa chốt:** chỉ thêm ProductID mới; áp dụng hồi tố từ đầu chương trình.
- **Đã chốt:** bất biến.

Từ lúc bắt đầu, khóa target, bậc, loại GMV, đơn vị CMS và hệ số quy đổi của sản phẩm đã có.

Kích hoạt khi ngày bắt đầu đã qua được phép nếu khoảng ngày hợp lệ, có sản phẩm hợp lệ và không xung đột ProductID; màn xác nhận nói rõ chương trình áp dụng từ ngày bắt đầu (hồi tố) và sau kích hoạt chỉ còn thêm sản phẩm. Nếu ngày kết thúc cũng đã qua, chương trình hiển thị Chờ chốt kỳ; điều này không cấp quyền chốt P3 hoặc bật tiền thật (H7).

Không thêm trạng thái tạm dừng hoặc mở khóa trong r2. Không xây xóa, hủy hoặc quay về nháp (H8).

### 2.4. Chống trùng chương trình

Một ProductID không được thuộc hai chương trình đã kích hoạt có khoảng ngày giao nhau, kể cả hai chương trình chọn nhà thuốc khác nhau.

- Giao nhau tính cả ngày đầu và cuối.
- Hai chương trình nháp có thể cùng chuẩn bị một ProductID.
- Kiểm tra lúc preview để báo sớm.
- Kiểm tra lại lúc commit, sửa chương trình đã kích hoạt trước ngày bắt đầu và kích hoạt.
- Kiểm tra cuối phải nằm trong transaction và có khóa theo ProductID để ngăn hai request cùng vượt qua.
- Chỉ so trong cùng namespace `is_test`: chương trình thật so với chương trình thật, chương trình QA so với chương trình QA (H9).

Chương trình đã chốt vẫn giữ quyền sở hữu ProductID trong khoảng ngày lịch sử của nó.

### 2.5. Điều kiện dòng bán hợp lệ

Dòng được tính khi:

1. `order_type = OFFLINE`.
2. `order_status = COMPLETED`.
3. `completed_at` thuộc kỳ chương trình theo ngày Việt Nam.
4. ProductID có trong danh mục chương trình.
5. Người bán map được tới staff thuộc phạm vi tham gia.
6. `base_quantity` và `item.amount` hợp lệ.

Cửa sổ thời gian dùng:

```text
Từ 00:00 ngày bắt đầu VN, inclusive
Đến 00:00 ngày sau ngày kết thúc VN, exclusive
```

Không dùng thời gian tạo hoặc sửa dòng hàng để thay thế thời điểm hoàn tất đơn.

Dòng hủy không được coi là một dòng bán âm bằng cách suy từ `status`. Quy thuộc trả hàng vẫn thuộc Q-206; chưa được tự suy diễn từ dữ liệu thô.

### 2.6. Định nghĩa GMV

**GMV CMS là tổng nguyên giá trị `item.amount` của các dòng hợp lệ.**

- Giữ VAT như nguồn.
- Không phân bổ thêm voucher.
- Không tính lại từ `quantity × unit_price`.
- Không tách thuế hoặc khấu trừ giảm giá cấp đơn.
- Không dùng tổng tiền thanh toán của cả order làm GMV cho từng sản phẩm.

Tên trường chuẩn trong hợp đồng dữ liệu là `gmv_amount`, tránh gọi là doanh thu thuần hoặc `net_amount`.

### 2.7. Quy đổi số lượng

Mỗi sản phẩm trong chương trình có:

- `unit_CMS`: đơn vị hiển thị và hưởng thưởng.
- `base_quantity_CMS`: số đơn vị cơ sở tương ứng một đơn vị CMS (số dương, thập phân chính xác tối đa 9 chữ số sau dấu chấm).

`base_quantity` của dòng bán là tổng số lượng cơ sở của cả dòng. Không nhân lại với `quantity`.

Với một dược sĩ, sản phẩm và chương trình:

```text
B = tổng base_quantity hợp lệ
K = base_quantity_CMS

Số lượng CMS thực tế = B / K
Q = floor(max(0, B) / K)
```

Quy tắc:

- Cộng dồn số lượng cơ sở trong cả kỳ trước khi lấy phần nguyên.
- Phần lẻ tiếp tục được cộng trong kỳ.
- Phần lẻ cuối kỳ không chuyển sang chương trình khác.
- Không tạo số lượng hưởng CMS âm; trả hàng thô vẫn HOLD Q-206.
- `quantity`, `unit` gốc được giữ để đối soát.
- `base_unit` là metadata tùy chọn.
- Không suy quy cách bằng cách parse tên hoặc `product_volumes`.

Ví dụ với một hộp bằng 100 viên:

| Bán cộng dồn | Số hộp thực tế | Số hộp xét CMS |
|---:|---:|---:|
| 50 viên | 0,5 | 0 |
| 100 viên | 1 | 1 |
| 150 viên | 1,5 | 1 |

### 2.8. Gate GMV

| Loại | Điều kiện |
|---|---|
| Theo ProductID | GMV của dược sĩ trên chính sản phẩm ≥ target sản phẩm |
| Theo danh mục | Tổng GMV của dược sĩ trên các sản phẩm gắn loại danh mục ≥ target danh mục |
| Không target | Luôn đạt gate |

Nhóm danh mục chỉ cộng những sản phẩm được khai báo `GMV_TOAN_DANH_MUC`.

Đạt gate thì CMS được tính cho toàn bộ số lượng hợp lệ trong kỳ, gồm lượng đã bán trước thời điểm đạt.

### 2.9. Tính thưởng lũy tiến (bậc cuối không giới hạn — CMS-Q-220)

> **CMS-Q-220 (05/11) THAY Q-210a:** bỏ trần số lượng hưởng CMS. Bậc cuối luôn **không có cận trên**; nội dung "bậc cuối hữu hạn tạo trần" bên dưới chỉ còn là lịch sử (run QA đã chốt trước 125). Xem `docs/cms/DECISIONS.md` CMS-Q-220.

Bậc liên tục, bắt đầu từ 1. Mỗi bậc có:

```text
[from, to] → CMS_VND_SP
```

Bậc cuối:

- **Không có cận trên: không giới hạn** — bắt buộc với mọi cấu hình tính mới (CMS-Q-220). Bậc trung gian vẫn có cận trên (chặn `min(Q, to)` để không tính chồng).
- ~~Có cận trên: tạo trần số lượng hưởng CMS (Q-210a).~~ Hết hiệu lực; file cũ có số ở `Den_SL_ban` bậc cuối được bỏ giới hạn khi kiểm tra (có cảnh báo).

Với Q là số lượng nguyên đủ xét:

```text
F(Q) = tổng tiền của số đơn vị nằm trong từng bậc
CMS = gate đạt ? F(Q) : 0
```

Mỗi đơn vị đủ sau mốc bậc cuối (khi gate đã mở) làm CMS tăng đúng mức bậc cuối. GMV và số lượng bán thực tế giữ đầy đủ.

Bảng nghiệm thu:

| Q | Gate target 10 triệu, GMV 1 triệu/SP | CMS |
|---:|---|---:|
| 9 | Chưa đạt | 0 |
| 10 | Đạt | 155.000 |
| 11 | Đạt | 175.000 |
| 14 | Đạt | 235.000 |
| 20 | Đạt | 360.000 |
| 25 | Đạt | 485.000 |

Bậc mẫu: 1–9 hưởng 15.000; 10–19 hưởng 20.000; từ 20 hưởng 25.000.

Bậc cuối không giới hạn (CMS-Q-220 — bảng nghiệm thu stakeholder):

| Q | CMS khi gate đạt / không target |
|---:|---:|
| 0 | 0 |
| 1 | 15.000 |
| 9 | 135.000 |
| 10 | 155.000 |
| 19 | 335.000 |
| 20 | 360.000 |
| 49 | 1.085.000 |
| 50 | 1.110.000 |
| 51 | 1.135.000 |
| 100 | 2.360.000 |
| 101 | 2.385.000 |
| 100.000 | 2.499.860.000 |

(Lịch sử Q-210a — đã bị thay: "bậc cuối kết thúc ở 50" cho Q 50 / 51 / 60 = 1.110.000.)

### 2.10. Phân bổ tiền theo dòng và ngày đạt

Sắp dòng theo `completed_at`, sau đó `order_line_id`.

Với số lượng cơ sở cộng dồn trước và sau một dòng:

```text
Tiền dòng = A(B_sau) − A(B_trước)
A(B) = F(floor(max(0, B) / K))
```

Nếu gate cuối cùng chưa đạt, tiền các dòng đều bằng 0.

Cách này xử lý đúng:

- Hai dòng nửa hộp cộng thành một hộp.
- Một dòng đi qua nhiều bậc.
- Dòng bán đi qua mốc bậc cuối (vd. 50 → 51 vẫn +25.000).
- Các sự kiện điều chỉnh đã được quy thuộc đúng khi Q-206 được chốt.

Trạng thái hiển thị:

- Chờ đạt target.
- Đang cộng dồn, khi chưa hoàn thành thêm đơn vị CMS.
- Đã ghi nhận.
- ~~Đã đạt trần~~ — chỉ còn đọc ở run lịch sử trước CMS-Q-220; run mới không sinh trạng thái này.
- Điều chỉnh cho sự kiện trả hàng đã được chuẩn hóa.
- Đã chốt sau P3.

`gate_met_at` là lần chuyển từ chưa đạt sang đạt gần nhất. Gate đang không đạt thì không hiện “Đạt từ” (Q-211).

Câu giải thích “tụt do trả hàng ngày…” chỉ hiện khi dữ liệu đã chứng minh được sự kiện gây tụt.

### 2.11. Chỉ số báo cáo

- “Lượt” là một cặp dược sĩ × sản phẩm.
- Lượt có bán: số lượng CMS thuần nguyên ≥ 1.
- Lượt đạt: gate đạt và CMS > 0.
- SP không target: có bán thì đạt.
- “SP có CMS x/y”: x là số ProductID có ít nhất một dược sĩ CMS > 0; y là số sản phẩm trong chương trình.
- Tử số dược sĩ: người có CMS > 0.
- Mẫu số: các tài khoản staff hiện thuộc phạm vi nhà thuốc hợp lệ.
- Dòng chưa gán không tạo thêm người vào tử hoặc mẫu.
- Gộp nhiều chương trình phải đếm user distinct.
- Tổng QLCH/SM được cộng từ kết quả cá nhân đã tính gate và bậc riêng; không áp lại bậc trên tổng nhà thuốc.

A1 bỏ chỉ số theo tháng, thay bằng hai số tiền (Q-212):

1. CMS tạm tính của chương trình đang chạy.
2. CMS của chương trình chờ chốt.

## 3. Điều kiện phát hành

### 3.1. P1 — danh mục (phát hành đầu tiên)

Điều kiện GO phát hành (PM quyết, không suy từ GO triển khai):

1. Gate từng batch P1-a…P1-d đạt và PM audit GO.
2. **Product Master đọc được bằng SA hiện hành** (tên qua `CMS_BQ_PRODUCTS_TABLE`), kiểm chứng tại bước đồng bộ thật. Operator bảo đảm nguồn sẽ có trong `buymed_tech`; chưa cần gửi tên bảng hoặc chạy query lúc đang code bằng fixture. Không nới quyền SA và không lặp dry-run trên các bảng thô đã biết trả 403.
3. Deploy code với cờ OFF → operator chạy migration theo thứ tự → Dev VERIFY chỉ đọc.
4. Bootstrap Product Master bằng script operator-only dùng cùng core/RPC với cron (SPEC §9), trong khi cờ production vẫn OFF; QA import/RLS có cách ly dữ liệu kiểm thử tại localhost theo safety gate, không gọi public route đang tắt.
5. Bật `CMS_PROGRAM_ENABLED`; smoke super admin, SM, QLCH, staff và FS.

Ở P1 không hiển thị CMS đã kiếm được, lượng đã bán, tiến độ thực tế hay lịch sử giao dịch; không hiển thị 0 giả.

### 3.2. P2 — số tiền tạm tính

1. Hoàn tất Q-206 và hợp đồng nguồn bổ sung (feed dòng bán đọc được bằng SA).
2. Nghiệm thu engine, adapter và đối soát.
3. Dry-run hai lần trên cùng đầu vào, kết quả phải giống nhau.
4. Đối chiếu một tập đơn đã biết từ POS/BigQuery đến từng dược sĩ và sản phẩm.
5. Đạt gate hiệu năng và dữ liệu.
6. Bật `CMS_EARNINGS_ENABLED`, tạo lịch cron, smoke theo vai.

### 3.3. P3 — chốt kỳ

Giữ pending đến khi có đặc tả bổ sung được duyệt (Q-206, Q-213). `CMS_LOCK_ENABLED` giữ OFF.

## 4. Pending có chủ đích

**Chính sách đã chốt:** CMS độc lập với Commission Store (CMS-Q11); trả sau chốt không sửa payout và được báo cáo riêng (CMS-Q7). Q-206/P3 còn pending về dữ liệu và triển khai, không mở lại hai quyết định này.

**Q-206 — quy thuộc trả hàng.** Đang hold theo operator. Trước khi bật tiền thật cần xác định:

- Nhận diện dòng bán gốc/dòng trả.
- Quy thuộc đúng dược sĩ và chương trình.
- Trả trong kỳ, sau ngày kết thúc nhưng trước chốt.
- Phân biệt hủy snapshot và sự kiện trả riêng.
- Dữ liệu đến muộn và cập nhật lại.
- Feed phát sinh sau chốt.

Dev không tự chọn mặc định cho adapter trả hàng production.

**Q-213 — chốt khi còn dòng chưa gán.** Đề xuất đang chờ stakeholder:

- Chặn nếu vượt 2% GMV hoặc vượt 20 dòng.
- Dưới ngưỡng cần xác nhận và lý do.
- Lưu người chốt, lý do và snapshot bị loại.
- Không đưa dòng đã loại trở lại payout sau chốt.

Các ngưỡng này chưa phải quyết định phát hành.

**P3.** R1 có định hướng grace hai ngày, snapshot đủ mới, payout bất biến và báo cáo sau chốt. Những nguyên tắc đó được giữ trong roadmap; PR chốt kỳ chỉ được giao sau khi PM ban hành đặc tả bổ sung gắn với Q-206/Q-213.
