# UI v2 — CMS theo sản phẩm (feature mới)

> Nguồn design: canvas Claude Design "Circa Tasks — Redesign v2 · CMS theo sản phẩm". Mã nguồn từng artboard ở
> `docs/ui/mockups/cms/*.dc.html` (HTML đọc được: layout, chữ, số mẫu nằm trong `renderVals()`).
> Nghiệp vụ, dữ liệu, quyền: `docs/plan-cms-product-commission.md` + `docs/cms/SPEC.md` (**r2**, 01/11/2026). Khi tài liệu lệch nhau, **spec r2 thắng**.
> Bản này = đặc tả UI r1 (31/10) + **redline r2 ở §0** và các chỗ sửa trực tiếp có ghi "(r2)". Mục r1 nào mâu thuẫn §0 thì theo §0.
> **Kế thừa Foundation v2:** `docs/ui/UI_V2_TASKS.md` §1–§3 và token KPI ở `docs/ui/UI_V2_KPI.md` §2.

## 0. Redline r2 (01/11/2026)

| # | Chỗ r1 | r2 |
|---|---|---|
| U1 | Phase | P1 phát hành trước: **chỉ danh mục** (SP, target, loại gate, thang bậc `đồng/unit_CMS`, tư vấn). Ẩn CMS đã kiếm, lượng đã bán, tiến độ thực tế, lịch sử giao dịch; **không hiển thị 0 giả**. Phần số liệu là P2 (chưa giao). Chốt kỳ (P3) **ẩn**, không render nút disabled. |
| U2 | A1 4 StatCard ("CMS tạm tính tháng hiện tại") | Bỏ chỉ số theo tháng. P2 có hai số tiền: **CMS tạm tính chương trình đang chạy** và **CMS chương trình chờ chốt**. P1: chỉ ô không có tiền (Chương trình đang chạy · Sản phẩm đang áp dụng). |
| U3 | A2 bước Thông tin có "Target GMV toàn danh mục" | **Bỏ ô này.** Target danh mục đọc từ Excel (một target / chương trình). Giữ dòng chỉ đọc "Cách tính bậc: Lũy tiến". |
| U4 | A2 Upload "bảng 7 cột" | **9 cột**: thêm `unit_CMS`, `base_quantity_CMS`. Link "Tải file mẫu" trỏ template 9 cột mới (ProductID số giả). Mẫu r1 7 cột ⇒ báo thiếu cột. |
| U5 | A2 Kết quả, bảng hợp lệ | Thêm **đơn vị CMS** và **hệ số cơ sở** (`1 {unit_CMS} = {base_quantity_CMS} đơn vị cơ sở`); chip bậc ghi `đ/{unit_CMS}`. Cảnh báo ảnh ngoài prefix được duyệt. |
| U6 | Kích hoạt | Hộp xác nhận: số SP, khoảng ngày, phạm vi. Nếu ngày bắt đầu đã qua: nói rõ **áp dụng hồi tố từ ngày bắt đầu** và sau kích hoạt **chỉ còn thêm sản phẩm** (H7). |
| U7 | Xóa / hủy / về nháp | **Không có** nút, menu hay action nào cho các đường này (H8). |
| U8 | A1/A3 quyền | Super admin quản lý. **SM chỉ đọc** chương trình có nhà thuốc được phân công: thấy Sắp diễn ra / Đang chạy / Chờ chốt kỳ; không thấy Nháp/QA; ẩn Tạo, Import bổ sung, Kích hoạt (H6). |
| U9 | D1 danh sách chương trình | Staff/QLCH P1 thấy **Sắp diễn ra** (ghi "Bắt đầu dd/mm") và **Đang chạy**, theo nhà thuốc hiện tại. Không có Nháp; Chờ chốt kỳ / Đã chốt không vào danh sách chính P1 (H5). QLCH không có CMS cá nhân; P2 thấy tổng CMS các staff hiện thuộc nhà thuốc. |
| U10 | Ảnh | **Next Image** + `remotePatterns` HTTPS `cdn-gcs.thuocsi.vn` pathname `/thuocsi-live/images/**`. URL khác host/prefix ⇒ ô chữ cái đầu (ảnh dự phòng). Không dùng `<img>`, không wildcard host. |
| U11 | "Chưa gán dược sĩ" link tới trang gán mã nhân viên | Bỏ `employee_code`. P2 hiện nhóm "Chưa gán dược sĩ" với **lý do** (email không khớp / trùng / tài khoản dùng chung / không phải staff / nhà thuốc không hợp lệ); không có trang gán mã. |
| U12 | Trạng thái dòng ghi nhận (P2) | Chờ đạt target · Đang cộng dồn · Đã ghi nhận · Đã đạt trần · Điều chỉnh (chỉ sự kiện trả hàng đã chuẩn hóa, Q-206) · Đã chốt (P3). "Đạt từ dd/mm" = lần chuyển sang đạt gần nhất; gate đang không đạt thì không hiện. |
| U13 | "Gợi ý gần đạt" / "Nếu bán thêm" (P2) | Dùng cùng engine `lib/cms/engine`. Ước tính GMV **chỉ khi** có giá tham khảo đúng theo `unit_CMS`; thiếu giá ⇒ bỏ câu ước tính cần giá. |
| U14 | D3 "Đã chốt" đọc `cms_payout_lines` | P3 (HOLD). P2: D3 đọc `cms_result_lines` của phiên kết quả hiện hành. |
| U15 | Tab | `CampaignsTabs` thêm tab "CMS sản phẩm" **độc lập với cờ Affiliate**. `/targets?tab=cms` không chạy query KPI cũ; cờ CMS OFF giữ nguyên hành vi KPI. |
| U16 | A2 "Chạy xử lý" = 1 lần gọi server action; nút "Lưu nháp" / "Kích hoạt N" | Import **hai bước qua Route Handler** (SPEC §4.5): (1) **Kiểm tra file** = POST preview → lưu import run (`run_id`, hash), hiện Kết quả; (2) **Xác nhận ghi** = POST commit gửi lại file + `run_id`, server parse lại; kết quả khác preview ⇒ báo "Dữ liệu đã thay đổi — kiểm tra lại file" và quay về bước Upload. **Kích hoạt** là hành động riêng sau khi đã ghi danh mục (U6), chỉ ở chương trình nháp. Nhãn nút xác nhận ghi theo trạng thái (SPEC §4.7): nháp / đã kích hoạt chưa bắt đầu = "Nạp danh mục (thay toàn bộ, N sản phẩm)"; đã bắt đầu = "Thêm N sản phẩm". Ẩn nút khi N = 0. "Hủy lần chạy" chỉ bỏ kết quả kiểm tra phía client (run `previewed` không được ghi), **không** phải huỷ chương trình (U7). |
| U17 | Sửa thông tin chương trình | Route `/targets/campaigns/cms/[id]/edit` (bước Thông tin của A2, điền sẵn) — chỉ super admin, chỉ khi **nháp** hoặc **đã kích hoạt chưa bắt đầu** (SPEC §4.7); đã bắt đầu / đã chốt ⇒ không có nút sửa. |
| U18 | Hiển thị âm / trả hàng | Số âm, nhãn "Điều chỉnh", "Khách trả hàng", "tụt do trả hàng" **chỉ hiện khi Q-206 đã chốt** và dữ liệu đã chuẩn hóa sự kiện trả; trước đó không render. |
| U19 | QLCH (tài khoản dùng chung) | D1/D2 không có hero "CMS … của bạn", không có "Gợi ý gần đạt", không có "Nếu bán thêm". P1: chỉ danh mục như staff. P2: khối tổng nhà thuốc (cộng từ kết quả cá nhân của staff hiện thuộc nhà thuốc) thay hero. |
| U20 | Chương trình QA | Chương trình `is_test` chỉ hiện với phiên có marker QA hợp lệ (kể cả super admin — H9); A1 thống kê và danh sách thật loại test. |

## 1. Phạm vi & nguyên tắc

- Đây là **feature mới**, không phải visual-only: route, query, RPC, action mới theo `docs/cms/SPEC.md` §7–§9 (r2).
- Mọi route CMS đặt `data-ui-v2="page"` ở page-root ngay từ đầu.
- Canvas có số mẫu (tên dược sĩ, nhà thuốc, SP, tiền). **Không** đưa số mẫu vào code; số thật lấy từ RPC.
- Route trong canvas khớp `docs/cms/SPEC.md` §8.1 (r2 giữ route r1). Màn chốt kỳ (P3) chưa có artboard: dựng theo §3.4 dưới đây.
- Icon dùng `lucide-react` (canvas vẽ SVG nét tương đương). Không emoji.

## 2. Token & màu

| Dùng cho | Token | Ghi chú |
|---|---|---|
| Nút chính, tab đang chọn (gạch chân) | action v2 hiện có | Nền cam, chữ `#141210`. |
| Thanh tiến độ đang chạy, chuỗi số liệu | `--v2-series` | |
| Đạt điều kiện | `--v2-ok` | Thanh GMV đã đạt, badge "Đã đạt". |
| Bậc đã qua (thang bậc, thanh phân bố) | `--v2-series-soft` | |
| Bậc 3 trong thanh phân bố A3 | **mới** `--v2-series-strong`: light `#9A3410`, dark `#FBD9C6` | Khác độ sáng với 2 bậc kia. Thêm vào khối token KPI. |
| Badge loại điều kiện | `TagBadge`: "Target SP" = blue · "Theo danh mục" = orange · "Theo số lượng" = neutral | |
| Trạng thái | `StatusBadge` | Bảng §2.1. |

### 2.1 Trạng thái

| Đối tượng | Chữ | Tone |
|---|---|---|
| Chương trình | Nháp · Sắp diễn ra · Đang chạy · Chờ chốt kỳ · Đã chốt | neutral · info · success · warning · neutral |
| Dòng ghi nhận (P2) | Chờ đạt target · Đang cộng dồn · Đã ghi nhận · Đã đạt trần · Điều chỉnh (chỉ khi Q-206 chốt — U18) · Đã chốt (P3) | neutral · neutral · info · info · warning · success |
| Kết quả import | Lỗi · đã loại · Cảnh báo · vẫn nạp | danger · warning |
| CMS tạm tính (A3 theo dược sĩ) | Tạm tính | info |

- Số tiền luôn màu chữ, đậm, `tabular-nums`. Dòng trả hiện số âm `−12.000đ` màu danger — **chỉ khi Q-206 đã chốt** (U18).
- Định dạng tiền dùng formatter VND hiện có của app (canvas viết `đ`, app đang dùng `₫`: theo app).

## 3. Admin (desktop, fluid; phone width xếp dọc)

### 3.1 A1 · `/targets/campaigns/cms` — mockup `AdminPrograms.dc.html`

- `PageHeader` "Chiến dịch KPI" + nút chính "Tạo chương trình CMS" → A2.
- `CampaignsTabs` thêm tab thứ 3 "CMS sản phẩm" (badge "Mới" trong 30 ngày đầu: tuỳ chọn).
- `StatCard` (r2, U2): P1 = Chương trình đang chạy · Sản phẩm đang áp dụng. P2 thêm CMS tạm tính chương trình đang chạy · CMS chương trình chờ chốt · Dược sĩ có CMS. Không còn "CMS tạm tính tháng hiện tại". Chương trình QA không vào thống kê (U20).
- `FilterTabs` trạng thái kèm số đếm (`?status=`) + ô tìm theo tên chương trình hoặc ProductID (`?q=`).
- Bảng (`DataTableShell`, cuộn ngang trong khung): Chương trình (link A3, dòng phụ khoảng ngày + "còn N ngày") · Trạng thái · Sản phẩm · Đạt điều kiện (thanh + "x/y SP đạt điều kiện") · CMS tạm tính · Dược sĩ có CMS · Import gần nhất (thời gian + "N dòng hợp lệ" hoặc "N dòng lỗi đã bị loại" màu warning). (r2: P1 **không render** các cột Đạt điều kiện, CMS tạm tính, Dược sĩ có CMS — không có ô 0 / thanh rỗng; P2 mới hiện.)
- Rỗng: `EmptyState` "Chưa có chương trình CMS" + nút tạo. Lỗi: `ErrorState`.

### 3.2 A2 · `/targets/campaigns/cms/new` — mockup `AdminImport.dc.html`

Stepper 4 bước (danh sách có `aria-current="step"`): **Thông tin → Upload → Chạy xử lý → Kết quả**.

1. **Thông tin**: Tên chương trình*, Từ ngày*, Đến ngày*, Phạm vi (radio Tất cả nhà thuốc / Chọn nhà thuốc–khu vực), dòng chỉ đọc "Cách tính bậc: Lũy tiến". (r2: **bỏ** ô Target GMV toàn danh mục — target đọc từ Excel, U3.) Nút "Lưu nháp" · "Tiếp tục · Upload file". Badge "chờ chốt" trong canvas **không** đưa vào code.
2. **Upload**: vùng kéo thả là `<label>` bọc `<input type="file" accept=".xlsx">`, link "Tải file mẫu" (file mẫu đặt ở `public/templates/Circa_Import_CMS.xlsx`), thẻ file đã chọn (tên, dung lượng, số dòng), bảng **9 cột** của sheet (r2: thêm `unit_CMS`, `base_quantity_CMS` — U4). Cột phải "Hệ thống sẽ kiểm tra" liệt kê luật kiểm tra nhóm ở `docs/cms/SPEC.md` §4.4. Nút "Quay lại" · "Chạy xử lý".
3. **Chạy xử lý**: thanh tiến độ (`role="progressbar"`) + 5 bước có trạng thái. (r2, U16: **một lần gọi POST preview** của Route Handler — không phải server action; 5 bước hiển thị theo kết quả trả về, không cần stream.) Nút "Hủy lần chạy" = bỏ kết quả phía client, không huỷ chương trình.
4. **Kết quả**: 4 ô (Tổng dòng · Hợp lệ · Lỗi (đã loại) · Cảnh báo, chấm màu theo tone); tab "Sản phẩm hợp lệ (N)" / "Lỗi & cảnh báo (N)"; link "Tải file dòng lỗi (.xlsx)". (r2: nếu file có nội dung sau dòng ProductID trống đầu tiên ⇒ thông báo "Nội dung từ dòng {n} trở đi không được nhập"; cảnh báo "Sản phẩm ngừng hoạt động" (`is_active = false`) và ảnh ngoài prefix được duyệt hiện dưới tên SP — U5.)
   - Bảng hợp lệ: ảnh 44×44 + tên + `ProductID · giá` (từ Product Master; cảnh báo hiện dưới tên), điều kiện (TagBadge + dòng phụ target), các chip bậc `1–9 · 15.000đ`, nội dung tư vấn (rút gọn 2 dòng), số dòng Excel.
   - Bảng lỗi: Dòng Excel · ProductID · Cột · Lỗi (badge + câu) · Cách sửa.
   - Nút "Upload file khác" · chính = **xác nhận ghi** theo trạng thái (U16: "Nạp danh mục (thay toàn bộ, N sản phẩm)" hoặc "Thêm N sản phẩm"; ẩn khi N = 0). "Kích hoạt chương trình" là bước riêng sau khi đã ghi (hộp xác nhận U6), chỉ ở chương trình nháp.
- Nạp lại / import bổ sung `/targets/campaigns/cms/[id]/import`: bỏ bước 1, giữ 2–4; nháp hoặc đã kích hoạt chưa bắt đầu = **nạp lại toàn bộ**, đã bắt đầu = **chỉ thêm SP mới** (SPEC §4.6–§4.7).

### 3.3 A3 · `/targets/campaigns/cms/[id]` — mockup `AdminProgramDetail.dc.html`

- Đầu trang: link quay lại "CMS sản phẩm", tên + `StatusBadge`, dòng phụ "dd/mm – dd/mm/yyyy · còn N ngày · phạm vi · Số liệu BI cập nhật dd/mm lúc hh:mm". Nút: "Import bổ sung" (super admin) · "Xuất Excel" (P2) · "Chốt kỳ" (P3). (r2: P1 **ẩn** Xuất Excel và Chốt kỳ; SM không có Import bổ sung — U1, U8.)
- 4 `StatCard`: CMS tạm tính · GMV SP trong chương trình · Dược sĩ có CMS (x / tổng dược sĩ phạm vi) · Lượt đạt điều kiện (cặp dược sĩ × SP).
- Khối "Nhóm theo danh mục" (chỉ khi có SP `catalog`): target, "x / y dược sĩ có bán đã đạt", thanh %.
- Tab `?view=products|staff|runs` (Theo sản phẩm · Theo dược sĩ · Lịch sử import), chú giải màu bậc ở phải.
  - **Theo sản phẩm**: SP · Điều kiện · SL bán · GMV · Dược sĩ đạt / có bán · SL được tính CMS theo bậc (thanh xếp chồng + chữ "B1: 18 · B2: 7 · B3: 0 SP" làm nhãn `aria-label`) · CMS tạm tính · nút mở rộng 44×44 (`aria-expanded`). Mở rộng = bảng con theo dược sĩ: Dược sĩ · Nhà thuốc · SL · GMV / target (thanh nhỏ) · Bậc hiện tại (badge; "Chưa đạt target" neutral) · CMS. Hàng tổng cuối bảng.
  - **Theo dược sĩ**: Dược sĩ · Nhà thuốc · SP có bán · SP đạt điều kiện · SL · GMV · CMS tạm tính · Trạng thái. Sắp theo CMS giảm dần, phân trang.
  - **Lịch sử import**: file, thời gian, người, kết quả, link chi tiết (mở lại màn Kết quả của run).
- Nhóm **"Chưa gán dược sĩ"** (P2): khối cảnh báo trên tab Theo dược sĩ "N dòng đơn chưa map được người bán" kèm lý do (r2: không có trang gán mã nhân viên — U11).
- P1: ẩn ô/cột **kết quả thực tế** (CMS đã kiếm, GMV/SL bán, tiến độ/lượt/người đạt). Giữ số SP cấu hình, target, bậc, mức CMS/`unit_CMS`, quy cách, số dòng import và lịch sử import. Không thay kết quả chưa bật bằng 0 hoặc thanh rỗng.

### 3.4 Chốt kỳ (P3, chưa có artboard — **HOLD** Q-206 / Q-213; r2 chưa giao, giữ để tham chiếu)

Dialog từ nút "Chốt kỳ" ở A3: tóm tắt (tổng CMS, số dược sĩ, số dòng chưa gán, số dòng trả, lần đồng bộ cuối) + checkbox "Tôi đã kiểm tra số liệu" + nút danger "Chốt kỳ". Sau chốt: badge "Đã chốt", nút đổi thành "Xuất file chi trả".

## 4. Dược sĩ (mobile-first, 360/390; desktop = cột giữa `max-w-2xl mx-auto`)

### 4.1 D1 · `/targets?tab=cms` — mockup `StaffHome.dc.html`

- Đầu trang "Mục tiêu" + segmented 2 mục "KPI chiến dịch | CMS sản phẩm" (link, `aria-current`). Không đổi BottomNav.
- Chọn chương trình: nút 52px mở sheet danh sách chương trình đang áp dụng (`?program=`). Chỉ 1 chương trình → hiện như nhãn, không mở sheet.
- **Hero** (light: nền `#1C1917`, chữ sáng; dark: nền cam `#F3743F`, chữ `#141210`, như canvas): "CMS tạm tính của bạn", số lớn, 3 ô (SP đạt điều kiện x/y · SP đã bán · GMV), dòng "Cập nhật dd/mm · hh:mm · chưa chốt kỳ" + link "Xem ghi nhận" → D3.
- **Gợi ý gần đạt** (nền `accent-soft`): SP có gate `product` chưa đạt và còn thiếu ít nhất (theo %). Chữ: "Còn {tiền} để mở CMS {tên ngắn}" + "Khoảng {N} {đơn vị} nữa. Đạt target sẽ được tính CMS cho cả {Q+N} {đơn vị}, ước ≈ {tiền}." N = ceil(thiếu / giá tham khảo) **chỉ khi** giá tham khảo đúng theo `unit_CMS` (r2, U13); không có giá phù hợp → bỏ câu ước tính. Không có SP nào chưa đạt → ẩn khối.
- **Target nhóm danh mục**: thanh + "x / target · tên các SP trong nhóm" + badge Đã đạt / Chưa đạt.
- **Danh sách SP** + bộ lọc Tất cả / Đã đạt / Chưa đạt. Thẻ là 1 link → D2: ảnh 48, tên, TagBadge loại, "Đã bán N", CMS bên phải (màu chữ phụ khi 0đ), thanh GMV nếu có target, dòng nền muted "Bậc k · {mức}/SP" + "Còn N SP lên {mức kế}" / "Bậc cao nhất" / "Cần đạt target trước".
- P1 (chưa có tiền): ẩn hero tiền, thanh GMV, gợi ý; thẻ SP hiện thang bậc rút gọn ("1–9: 15.000đ/hộp · 10–19: 20.000đ/hộp · 20+: 25.000đ/hộp" — r2 ghi `đ/{unit_CMS}`) và loại điều kiện. Danh sách chương trình P1: Sắp diễn ra + Đang chạy (U9).
- Trạng thái: chưa có chương trình → `EmptyState` "Hiện chưa có chương trình CMS cho nhà thuốc của bạn". P2 đồng bộ lỗi: đã có snapshot tốt thì giữ số cũ, ghi thời điểm cập nhật và trạng thái chưa mới; chưa có snapshot tốt thì hiện `—`, không hiện 0đ giả. P1 không có hero kết quả thực tế.
- QLCH (tài khoản dùng chung, U19): không hero "của bạn", không "Gợi ý gần đạt"; P1 chỉ danh mục; P2 hiện khối tổng nhà thuốc.

### 4.2 D2 · `/targets/cms/products/[programProductId]` — mockup `StaffProduct.dc.html`

Ở P1 chỉ hiện thông tin sản phẩm, target/điều kiện cấu hình, thang chính sách `đồng/unit_CMS`, quy cách và nội dung tư vấn. Không hiện CMS đã kiếm, tiến độ cá nhân, nhãn bậc hiện tại, mô phỏng hoặc ghi nhận gần đây. Các khối dữ liệu thực tế bên dưới thuộc P2.

Thứ tự khối:

1. Ảnh 1:1 hoặc 180px cao, nền muted; thiếu ảnh → ô chữ cái đầu.
2. Tên, "ProductID · Giá bán · tên chương trình".
3. **CMS tạm tính** + bảng chia theo bậc ("Bậc 1 · 9 SP × 15.000đ … 135.000đ").
4. **Điều kiện** (ẩn khi `none`): tiêu đề theo loại, badge, thanh, câu "GMV của bạn X / target Y. Đạt từ dd/mm — CMS được tính cho toàn bộ số lượng đã bán trong kỳ." hoặc "Còn thiếu Z".
5. **Thang CMS theo số lượng** (ẩn khi chỉ 1 bậc; khi đó hiện 1 dòng "CMS {mức}/SP"): mỗi bậc 1 thẻ, bậc hiện tại viền action + nền accent-soft, chữ phụ "Đã hoàn thành" / "Bạn đang ở đây · 14/19 SP" / "Còn N SP để lên bậc này", thanh tiến độ trong bậc.
6. **Nếu bán thêm** (P2; không có với QLCH — U19; ước tính, chỉ client, không lưu): nút −/+ 44×44 (`aria-label`), số ở giữa `aria-live="polite"`, "CMS ước tính" + "+chênh lệch". Mặc định = số SP còn thiếu để lên bậc kế (hoặc để đạt target). Dùng **cùng engine** `lib/cms/engine` (r2) và kiểm tra cả gate; GMV ước tính = thêm × giá tham khảo **chỉ khi** giá đúng theo `unit_CMS` (U13).
7. **Nội dung tư vấn**: badge "Đã kiểm duyệt", text thuần `white-space: pre-line`, nút "Sao chép" (toast "Đã sao chép").
8. **Ghi nhận gần đây**: 3 dòng mới nhất của SP này + link "Xem tất cả" → D3 lọc theo SP.

### 4.3 D3 · `/targets/cms/history?program=&product=` — mockup `StaffHistory.dc.html`

- Segmented chọn chương trình (tối đa 3 gần nhất; nhiều hơn → nút "Khác" mở sheet).
- Thẻ tổng: chữ phụ tên chương trình + badge trạng thái chương trình, số CMS lớn, 3 ô (đơn có SP CMS · SP tư vấn bán · GMV), câu ghi chú theo trạng thái (Tạm tính / Chờ chốt kỳ / Đã chốt).
- **Hiệu quả tư vấn theo sản phẩm**: mỗi SP 1 hàng (tên, CMS, thanh so với SP cao nhất, "N SP · bậc k" hoặc "chưa đạt target …").
- **Dòng đơn được tính**: danh sách thẻ (không dùng bảng trên mobile): "{SP} × {qty}", "Đơn #… · dd/mm · hh:mm", badge trạng thái dòng, tiền bên phải + dòng phụ cách tính ("4 × 12.000đ", "GMV 54% target"; "Khách trả hàng" chỉ khi Q-206 chốt — U18). Phân trang "Xem thêm" 20 dòng.
- Chương trình "Chờ chốt kỳ": vẫn hiện dòng (tạm tính) — canvas đang ẩn, **theo spec: hiện**. P2 đọc `cms_result_lines` của phiên hiện hành; chương trình "Đã chốt" đọc `cms_payout_lines` là P3 (HOLD — U14).

## 5. Nghiệm thu UI

- Mỗi màn có fixture `/ui-catalog/cms-v2?fx=` cho: P1 danh mục, P2 đang chạy, chưa đạt target, đạt bậc cao nhất, chỉ 1 bậc, không target, danh mục chưa đạt, đồng bộ lỗi, rỗng, đã chốt, import có lỗi.
- Bọc `KpiFixtureBoundary` (hoặc boundary tương đương cho `components/cms`), guard mọi server action.
- Light/dark, 360/390/1280/1440: không cuộn ngang trang (bảng cuộn trong khung), chạm ≥ 44px (literal `h-[44px]`), input 16px trên mobile.
- Mọi số tiền khớp RPC; `null` hiển thị `—`, không `0`.
