# Câu hỏi cần stakeholder xác nhận — Module CSKH Circa

> Mỗi câu có **mặc định đề xuất** (đang dùng trong SPEC). Stakeholder chỉ cần trả lời "Đồng ý" hoặc ghi lựa chọn khác.
> 🔴 = chặn build / ảnh hưởng dữ liệu, cần trả lời trước khi code phần liên quan. 🟡 = có thể build theo mặc định rồi chỉnh. 🟢 = UI/chi tiết nhỏ.

| Mã | Mức | Câu hỏi | Vì sao hỏi | Mặc định đề xuất | Trả lời |
|---|---|---|---|---|---|
| Q-01 | 🔴 | Phân công: tài liệu ghi "Admin import Excel – logic ở bên ngoài" nhưng GĐ1 lại ghi "**Tự động** phân công", mockup có 3 tab *Theo dược sĩ / Tự động / Theo cửa hàng*. GĐ1 cần cả 3 không? "Tự động" và "Theo cửa hàng" chia theo quy tắc nào? | Mâu thuẫn trong tài liệu | GĐ1 chỉ làm *Theo dược sĩ* + nút *Phân bổ đều*; 2 tab còn lại để GĐ sau | |
| Q-02 | 🔴 | Danh sách kết quả chăm sóc chuẩn là 6 giá trị trong bảng mục 4? Mockup web dùng "Đã liên hệ", thiếu "Từ chối", "Hẹn lại". | Mockup không thống nhất → báo cáo sai | Dùng đúng 6 giá trị bảng mục 4 cho mọi màn | |
| Q-03 | 🔴 | Task được coi là **Hoàn thành** khi nào? Cụ thể "Khách hàng quan tâm" và "Hẹn chăm sóc lại": task gốc hoàn thành rồi tạo lịch mới, hay task vẫn mở? Lịch theo dõi có tính vào tỷ lệ hoàn thành không? | Quyết định tỷ lệ hoàn thành – chỉ số chính | Hoàn thành: Chưa có nhu cầu / Quan tâm / Đã đặt đơn / Từ chối. "Quan tâm" sinh thêm task theo dõi riêng (không tính vào tỷ lệ của kỳ gốc). "Không liên hệ được" & "Hẹn lại" → task vẫn mở | 05/10 cập nhật: proof ảnh tùy chọn, không là điều kiện Hoàn thành; INTERESTED hoàn thành; CALLBACK còn mở và phải có thời gian hẹn. PM chuẩn hóa các outcome còn lại; xem DECISIONS. |
| Q-04 | 🟡 | Ngày liên hệ lại/ngày hẹn được phép **sau** hạn chăm sóc không? Nếu có, task có bị Quá hạn không? | Gây tranh cãi khi tính quá hạn | Cho phép nhưng cảnh báo; quá hạn vẫn tính theo hạn gốc | |
| Q-05 | 🔴 | SĐT trong file không có trong dữ liệu Circa thì xử lý thế nào? | Ảnh hưởng mapping KH | Vẫn import, tạo KH tạm, gắn cờ "chưa có trên Circa" | |
| Q-06 | 🟡 | Mẫu file Excel chuẩn: những cột nào, có cột Cửa hàng / Dược sĩ / Hạn trong file không? Gửi giúp 1 file mẫu thật. | Cần để làm validate | Bắt buộc SĐT; tuỳ chọn Họ tên, Email, Giới tính, Địa chỉ, Ghi chú | |
| Q-07 | 🟡 | Một KH có được nằm trong 2 danh sách/2 dược sĩ cùng lúc không? Import lại KH đang có task mở thì sao? | Tránh gọi trùng KH | Tối đa 1 task mở/KH; dòng trùng bị đánh dấu, không import | 05/10: mỗi khách chỉ thuộc 1 store và 1 dược sĩ tại một thời điểm; import trùng/chuyển chủ sở hữu cần thể hiện rõ trong wizard. Xem DECISIONS Q-28/Q-07. |
| Q-08 | 🟡 | "Từ chối chăm sóc → cập nhật tuỳ chọn liên hệ": có những tuỳ chọn nào (không gọi / không nhắn / không liên hệ mọi kênh)? Có thời hạn không? Ai được gỡ? | Chưa định nghĩa | 1 cờ "Không liên hệ", vĩnh viễn, chỉ Admin gỡ | |
| Q-09 | 🟡 | Dược sĩ có được **sửa/xoá** lượt chăm sóc đã lưu không (mockup web có nút Chỉnh sửa)? | Tài liệu yêu cầu không ghi đè | Không sửa/xoá; nhập sai thì thêm lượt mới ghi chú đính chính | |
| Q-10 | 🔴 | Phân quyền: Admin, Store Manager, Dược sĩ — ai xem dashboard nào? Store Manager có import/phân công được không hay chỉ điều chỉnh? | Chưa có ma trận quyền | Admin: toàn quyền; SM: chỉ cửa hàng mình, điều chỉnh phân công + xem báo cáo; DS: chỉ task của mình | |
| Q-11 | 🟢 | Che SĐT `09***2121`: áp dụng cho ai? Dược sĩ có xem được số đầy đủ không? | Bảo mật dữ liệu KH | Che trên danh sách; nút Gọi dùng số đầy đủ; Admin xem đầy đủ | |
| Q-12 | 🟡 | Nút **Gọi** / **Nhắn**: gọi điện thoại thường, tổng đài, hay Zalo/SMS? Có cần ghi log cuộc gọi tự động không? | Ảnh hưởng tích hợp | Gọi = `tel:`; Nhắn = mở Zalo/SMS; không ghi log tự động | |
| Q-13 | 🔴 | Dữ liệu KH/đơn/sản phẩm lấy từ Circa bằng cách nào (API, DB chung, đồng bộ định kỳ)? Độ trễ bao lâu? Thông tin KH có được sửa trên module không (mockup có "Chỉnh sửa")? | Quyết định kiến trúc | Dùng cơ chế sẵn có của duocsi.circa.vn; thông tin KH chỉ đọc | |
| Q-14 | 🔴 | **Cách tính chuyển đổi** (tài liệu tự ghi cần thống nhất): đơn phát sinh trong bao nhiêu ngày sau lượt chăm sóc thì tính? Đơn tại cửa hàng khác/online có tính? Đơn mua tự nhiên phân biệt thế nào? | Tránh ghi nhận nhầm doanh thu | Cửa sổ 7 ngày sau lượt chăm sóc, mọi kênh, dược sĩ phải liên kết mã đơn | 05/10: đơn khách phát sinh sau thời điểm chăm sóc được tính chuyển đổi; không đặt cửa sổ 7 ngày. Chủ sở hữu do import/phân công, không theo store/kênh đơn. PM định nghĩa chống đếm trùng/kỳ báo cáo; xem DECISIONS. |
| Q-15 | 🔴 | GĐ1 có xác thực đơn với hệ thống bán hàng chưa? Tài liệu ghi "Đã đặt đơn → liên kết mã đơn" + dashboard doanh thu ở GĐ1, nhưng "Liên kết với đơn POS/online" lại nằm GĐ2. | Mâu thuẫn phạm vi | GĐ1: dược sĩ nhập/chọn mã đơn, hệ thống kiểm tra đơn tồn tại & đúng KH. GĐ2: tự động khớp đơn không cần nhập | 05/10: PM diễn giải GĐ1 đối chiếu đơn qua ID khách + thời điểm từ feed BI đã xác thực, không yêu cầu dược sĩ nhập mã đơn; thiếu feed thì chỉ số chưa có dữ liệu. Xem DECISIONS. |
| Q-16 | 🟡 | Nhắc việc qua kênh nào (thông báo trong app, push, Zalo)? Mốc nhắc? Trường **Nhắc nhở** và **Đính kèm file** (mockup web) có làm ở GĐ1 không? | Chưa mô tả | In-app + push; nhắc khi được giao, trước hạn 1 ngày, khi quá hạn, ngày hẹn 8:00. Đính kèm: để GĐ2 | |
| Q-17 | 🟡 | Kỳ báo cáo tính theo **ngày phân công**, **hạn chăm sóc** hay **ngày chăm sóc**? "So với kế hoạch" là kế hoạch nào? | Định nghĩa KPI | Theo ngày phân công; "kế hoạch" = tổng KH được giao trong kỳ | |
| Q-18 | 🟢 | Tab "Lịch hẹn" trên mobile hiển thị gì? | Không có trong tài liệu | Danh sách task có ngày hẹn, nhóm theo ngày | |
| Q-19 | 🟢 | Tên module: file tên "CMS" nhưng nội dung là CRM/Chăm sóc KH. Tên chính thức trên menu? | Đặt tên menu/route | "Chăm sóc khách hàng" | |
| Q-20 | 🟡 | App dược sĩ hiện tại là mobile web (responsive) hay app native? Web admin dùng chung codebase? | Phạm vi build UI | Theo kiến trúc hiện có | |

## Bổ sung từ dev sau khi đối chiếu SPEC với codebase duocsi.circa.vn (04/10/2026)

> Các câu dưới đây không có trong tài liệu gốc; phát sinh vì SPEC viết trước khi khảo sát codebase. 🔴 chặn thiết kế data model / kiến trúc.

| Mã | Mức | Câu hỏi | Vì sao hỏi | Mặc định đề xuất | Trả lời |
|---|---|---|---|---|---|
| Q-21 | 🔴 | "Store Manager" trong SPEC là ai trên app? App có `store_manager` = **tài khoản dùng chung của cửa hàng (QLCH)**, không gắn với cá nhân, và `sm` = quản lý vùng nhiều cửa hàng. Ai được điều chỉnh phân công và xem dashboard cửa hàng? | Quyết định RLS + audit "ai chuyển giao" | QLCH (tài khoản cửa hàng) điều chỉnh phân công trong cửa hàng; SM xem báo cáo vùng, không điều chỉnh | 05/10: sm được chuyển khách giữa dược sĩ, kể cả A→B trong vùng phụ trách; store_manager dùng chung không được chuyển. Xem DECISIONS. |
| Q-22 | 🔴 | "Admin" import/phân công là phòng nào (Growth? Vận hành?)? App gate admin theo `department_id` (Policy→FS, Cycle Count→TRF). Super admin có mặc nhiên toàn quyền không? | Cổng phòng ban cho module | Super + admin phòng Growth (cần id phòng) | 05/10: Marketing id 80cb84b5-da69-46e3-b0e5-1de3d31b93c3; super admin có quyền; phòng khác cấp bằng cấu hình. Xem DECISIONS. |
| Q-23 | 🔴 | **App hiện KHÔNG có dữ liệu khách hàng/đơn hàng POS** (không có bảng customer/order; chỉ có đơn online affiliate từ Mongo, đơn theo mã DHC từ Google Sheet cho toa thuốc, và doanh số tổng từ BigQuery). "Lịch sử mua 3 tháng", "mã KH KHxxxxx", "đơn gần nhất", "danh sách đơn để chọn khi Đã đặt đơn" lấy từ đâu? | Kiến trúc dữ liệu — mục lớn nhất chưa có | GĐ1: BI cung cấp 2 feed (a) khách+lịch sử mua 3 tháng theo SĐT, (b) đơn POS theo SĐT để xác thực; đọc qua BigQuery (SA hiện chỉ có dataset `buymed_tech` → cần BI mirror/cấp quyền) hoặc kèm trong file import như snapshot | 05/10: BI có ID khách ổn định và feed dòng đơn POS/online theo khách; còn cần data contract và quyền đọc. Xem DECISIONS. |
| Q-24 | 🟡 | File Excel import có kèm **cửa hàng** và **dược sĩ phụ trách** không? Dược sĩ định danh bằng email hay tên? | Tên không map chắc được; quyết định bước 3 wizard | File có `target_store_code` + `assignee_email` bắt buộc; app kiểm tra tài khoản `staff` ở đúng store | Đã chốt 05/10: email dược sĩ bắt buộc trên từng dòng; BI có thể xuất từ BigQuery. Cần BI đối chiếu tên cột, email và quy tắc một/nhiều store/file. Xem DECISIONS. |
| Q-25 | 🟡 | Thông báo cho dược sĩ: app hiện **không gửi in-app cho staff** (thiết kế giảm tải), không có push (PWA đã gỡ), realtime tắt. Chấp nhận thay bằng badge số việc trên tab + "Nhiệm vụ hôm nay" khi mở app, và Teams cho QLCH khi có đợt phân công mới (không kèm tên/SĐT khách)? | Mục 11 SPEC giả định có push | Badge + màn hình hôm nay; Teams cho QLCH; không push GĐ1 | |
| Q-26 | 🟡 | Vị trí trên mobile: bottom nav staff đang cố định 5 tab (Tasks, Toa thuốc, Doanh số, Bảng tin, Tồn kho). Mockup M1 có nav riêng (Trang chủ/Khách hàng/Lịch hẹn/Thêm). Thay tab nào, hay module nằm trong tab hiện có? | UX + khung app | Thay "Tồn kho" bằng "Khách hàng" cho staff OS (Tồn kho vào drawer); M1 = trang đích module, không thay trang chủ app | 05/10: CSKH thay TRF/Tồn kho trên bottom nav staff; TRF tắt và staff không cần truy cập. Xem DECISIONS. |
| Q-27 | 🔴 | Quan hệ với module **"Toa có ngày dùng"** đang chạy: dược sĩ đã có luồng nhắc tái mua + "Đã chăm sóc" theo toa tự nộp. Khách trong file CSKH trùng với khách có toa mạn tính thì nhắc 2 nơi? | Tránh nhắc trùng, số liệu tách đôi | GĐ1 tách biệt, hiển thị cảnh báo "KH có toa mạn tính đang theo dõi" trên chi tiết; gộp ở GĐ2 | 05/10: CRM-CSKH độc lập với Toa có ngày dùng; khách có toa vẫn có thể nhận task CSKH. Không gộp/cảnh báo/đối chiếu toa ở GĐ1. Xem DECISIONS. |
| Q-28 | 🟡 | Danh tính khách: không có `customer_id` trong app → dùng **SĐT chuẩn hoá** làm khoá (như KPI Số khách Affiliate). Một khách mua ở nhiều cửa hàng là 1 hay N khách? `do_not_contact` áp toàn chuỗi hay theo cửa hàng? | BR-08/BR-09 phụ thuộc khoá | Khoá = SĐT chuẩn hoá toàn chuỗi; 1 task mở/SĐT toàn chuỗi; do_not_contact toàn chuỗi | 05/10: 1 khách toàn chuỗi, tại một thời điểm 1 store + 1 dược sĩ; DNC theo store; SM chuyển A→B. Xem DECISIONS. |
| Q-29 | 🟡 | Import 10.000 dòng: pattern import hiện có xử lý ≤2.000 dòng/lần, parse XLSX ở trình duyệt, ghi 1 RPC atomic. Chấp nhận chia lô (vd 2.000 dòng/lần, nhiều lần) ở GĐ1 thay vì xử lý nền có tiến trình? | Tránh xây job queue mới | Giới hạn 2.000 dòng/file ở GĐ1, nâng sau khi có số liệu thật | |
| Q-30 | 🟡 | Che SĐT `09***2121`: nút Gọi `tel:` buộc số đầy đủ phải xuống máy dược sĩ → che chỉ là hiển thị. Chấp nhận? Admin/QLCH thấy số đầy đủ trên web? | Kỳ vọng bảo mật thực tế | Che trên danh sách mọi vai trò; chi tiết + Gọi dùng số đầy đủ; export che | |
| Q-31 | 🟢 | SPEC §6.2 ghi CANCELLED "khi phân công lại", nhưng §5.3/BR-07 nói chuyển giao giữ nguyên task. Chuyển giao = đổi `pharmacist_id` + log (không huỷ)? | Nhất quán state machine | Đổi người + log; CANCELLED chỉ khi admin thu hồi | |
| Q-32 | 🟡 | Dashboard "Doanh thu từ chăm sóc" và "tiếp tục mua trong 30 ngày" cần đơn POS có số tiền + ngày + SĐT. Nếu Q-23 chưa có feed đơn ở GĐ1, hai chỉ số này lùi GĐ2? | Tránh hứa số liệu không có nguồn | GĐ1 chỉ hiển thị khi có feed; không thì ẩn kèm chú thích | |

## Bổ sung từ dev khi lập IMPLEMENTATION_PLAN (05/10/2026)

| Mã | Mức | Câu hỏi | Vì sao hỏi | Mặc định đề xuất | Trả lời |
|---|---|---|---|---|---|
| Q-33 | 🟡 | QLCH (tài khoản dùng chung) có được **ghi nhận chăm sóc thay** dược sĩ không? | Tiền lệ toa/task: QLCH nộp thay phải chọn người thực hiện; ảnh hưởng audit "ai đã gọi" | Không. Chỉ dược sĩ được gán ghi nhận; QLCH xem + chuyển giao | |
| Q-34 | 🟡 | Giữ lịch sử mua (thuốc, kể cả kê đơn) và kết quả chăm sóc bao lâu sau khi task đóng? | PII + dữ liệu sức khoẻ lưu trong Supabase (= B6 tài liệu Q-23) | Lịch sử mua xoá 90 ngày sau khi task đóng; lượt chăm sóc giữ (không kèm danh sách thuốc) | |
| Q-35 | 🟢 | Mỗi lần import là **1 cửa hàng** hay 1 file nhiều cửa hàng? | Quyết định wizard + validate; liên quan Q-24 | Một file toàn bộ 25 store OS; mỗi dòng có `target_store_code` | Đã chốt 05/10: một file chứa list khách của 25 store OS. BI cần xác nhận mã store và số dòng/file; app preview/validate theo store. |
| Q-36 | 🟢 | Mockup có mã khách `KH00125`. App không có mã khách. Hiển thị gì? | Không có nguồn | Ẩn ở GĐ1 (định danh = SĐT che); hiện nếu feed Circa có mã | |
| Q-37 | 🟡 | Dashboard W1 có ô **"Chưa phân công"** → khách đã import nhưng chưa chia cho ai được giữ lại thành "kho chờ"? Ai chia sau (admin / QLCH)? | Mâu thuẫn nhẹ với BR-01 (mỗi task đúng 1 dược sĩ) | Có kho chờ = task trạng thái `UNASSIGNED` (chưa có dược sĩ, không tính vào tỉ lệ hoàn thành); admin chia sau. BR-01 áp dụng từ lúc phân công | Đã chốt 05/10: báo lỗi và buộc chia hết ngay trong wizard; không tạo kho UNASSIGNED. Xem DECISIONS. |

## Bổ sung từ câu hỏi stakeholder về nguồn phân công và lý do chăm sóc (05/10/2026)

| Mã | Mức | Câu hỏi | Vì sao hỏi | Mặc định đề xuất | Trả lời |
|---|---|---|---|---|---|
| Q-38 | 🟡 | BI/Marketing có cung cấp ít nhất một **lý do chăm sóc** cho mỗi khách không? Có thể có nhiều lý do/khách không, gồm mã SP/KM và ngày liên quan? | Dược sĩ cần biết vì sao gọi; quyết định schema import và UI | Ít nhất một lý do/khách; BI/Marketing xác định tín hiệu, app hiển thị chứ không tự suy diễn; taxonomy là đề xuất PM | Đã chốt 05/10: bắt buộc ít nhất một lý do cụ thể/khách. Format và taxonomy chờ BI/Marketing. |
| Q-39 | 🟢 | Phase 1 dùng file import hay kéo danh sách ứng viên trực tiếp từ BigQuery? | Tách nguồn phân công khỏi nguồn đối chiếu hiệu quả | File import cho khách/store/dược sĩ/lý do | Đã chốt 05/10: Phase 1 import file. BigQuery dùng cho cron sau done/submit để cập nhật/gắn nhãn Theo dõi hiệu quả, không kéo danh sách phân công. |
| Q-40 | 🟡 | Sau khi cron tìm đơn, task chăm sóc cần trạng thái nào, hiển thị ở đâu và có gửi thông báo chủ động cho dược sĩ/admin không? | Mô hình task đã rõ; còn quyết định UI/notification | PM đề xuất sau submit hiện “Đang theo dõi đơn”, khi có đơn hợp lệ hiện “Đã có đơn” trên task và Theo dõi hiệu quả; không gửi tin chủ động ở v1. Vì không có cửa sổ chuyển đổi, “chưa có đơn” không là trạng thái đóng vĩnh viễn. | Đã chốt 05/10: “task con” = một task chăm sóc cho mỗi dòng khách trong file, không mặc định tạo task mới sau submit. Cách hiển thị/thông báo còn mở. |
| Q-41 | ✅ | Lịch sử mua 3 tháng lấy từ đâu và cần ở đợt ra mắt nào? | Quyết định nguồn N2 | BigQuery do BI chuẩn bị | **Thay thế 07/10 bởi Q-57/Q-61:** GĐ1 bỏ hẳn N2/lịch sử mua, chỉ hiển thị sản phẩm file Excel. |
| Q-42 | 🟡 | Cron CSKH đọc BigQuery trực tiếp hay qua Google Sheet như Toa? | Hai cách cần quyền, SLA và xử lý lỗi khác nhau | BigQuery trực tiếp | Đã chốt 05/10: BigQuery trực tiếp. Cần BI cung cấp view/quyền và xác nhận service account app đọc được. |

## Bổ sung từ yêu cầu thiết kế lại 07/10/2026

| Mã | Mức | Câu hỏi | Vì sao hỏi | Đề xuất PM | Trả lời |
|---|---|---|---|---|---|
| Q-43 | ✅ | Hạn tháng import và task cũ còn mở? | State/kỳ | Hạn cuối tháng; đóng kỳ task cũ | Đã chốt 07/10: hạn hết tháng import, task cũ đóng kỳ khi sang tháng mới, giữ lịch sử. |
| Q-44 | ✅ | Một khách nhiều sản phẩm trong file và tab Sản phẩm? | Grain file/DB/UI | Một sheet, gom dòng theo khách | Đã chốt 07/10: một sheet, nhiều dòng sản phẩm/khách, một task; tab chỉ lấy sản phẩm từ file. |
| Q-45 | ✅ | Có gộp N2/N3; lịch sử ba tháng cần dòng SP? | Grain BI | Một view ở mức đơn | **Thay thế bởi Q-57/Q-61:** bỏ N2, chỉ một nguồn đơn BigQuery cho hiệu quả sau chăm sóc. |
| Q-46 | ✅ | Nạp lại bản sửa cùng tháng? | Idempotency/lịch sử | Preview diff | Đã chốt 07/10: preview diff, giữ lịch sử. Quy tắc sửa/xóa từng task còn mở. |
| Q-47 | ✅ | Một đơn sau nhiều lượt/nhiều kỳ gán cho lượt nào? | Chống đếm trùng báo cáo/doanh thu | Lượt Hoàn thành gần nhất trước đơn; một `order_key` chỉ gán một lần | Đã chốt 07/10: theo đề xuất, không overengineer. |
| Q-48 | ✅ | `Hẹn chăm sóc lại` được hẹn sau cuối tháng không? | Task sẽ tự đóng kỳ khi sang tháng | Chỉ hẹn trong kỳ của task | Đã chốt 07/10: chỉ trong tháng task. |
| Q-49 | ✅ | Lịch sử đơn ba tháng hiển thị chỉ mã hay thêm ngày/tổng tiền? | UI + hợp đồng BI | Mã, ngày, tổng tiền | **Thay thế bởi Q-57:** GĐ1 không hiển thị lịch sử đơn. |
| Q-50 | ✅ | Khi nạp bản sửa cùng tháng, khách đã chăm sóc hoặc biến mất khỏi file mới được xử lý thế nào? | Tránh xóa lịch sử/ngầm chuyển owner | Không đổi ngầm; preview conflict và thao tác có log | Đã chốt 07/10: chỉ thêm khách mới/sửa sản phẩm-lý do task chưa có lượt; giữ task đã có lượt và khách vắng file; preview diff. |
| Q-51 | 🟡 B5 | Bảng BigQuery N3 thực tế có đúng một dòng/đơn **đã đặt**, ID khách, `pos_code` store bán, tiền ròng, mốc cập nhật/độ trễ và quyền đọc không? | Chặn tích hợp B5, không chặn B0–B4 | Schema đề nghị theo `crm-cskh-data-contract-v3.md` r3.2 | User/operator sẽ tạo bảng như pattern cron KPI (Q-64); xác nhận tên và dữ liệu thực trước B5. Không phục vụ lịch sử UI. |
| Q-57 | ✅ | Ảnh mobile mới có sản phẩm/ảnh theo từng đơn; đây có thay quyết định cũ về lịch sử không? | Grain BI/UI | Chờ stakeholder | Đã chốt 07/10: GĐ1 bỏ lịch sử đơn; sản phẩm/ảnh đều từ Excel, mockup chỉ tham khảo trình bày. |
| Q-58 | ✅ | Hẹn lại trễ trong tháng và task chưa làm khi hết tháng có là cùng một chỉ số không? | Chart/filter cần thống nhất | Hai chỉ số riêng | Đã chốt 07/10: hẹn lại trễ = Quá hạn; hết tháng chưa hoàn thành = Không hoàn thành trong kỳ. |
| Q-59 | ✅ | Đơn tháng sau tính vào kỳ báo cáo nào? | Conversion/doanh thu cohort | Tháng của lượt chăm sóc Hoàn thành | Đã chốt 07/10: tháng chăm sóc. |
| Q-60 | ✅ | Coolify thêm được hai Scheduled Tasks? | Rollout | Operator cấu hình khi deploy | Đã chốt 07/10: có. |
| Q-61 | ✅ | GĐ1 có bao nhiêu nguồn dữ liệu và có N2 lịch sử không? | Scope build | Excel N1 + BQ đơn N3 | Đã chốt 07/10: hai đầu vào, bỏ N2/lịch sử mua trên mobile. |
| Q-62 | ✅ | Khi xem báo cáo tháng đã qua, “Quá hạn” có giữ số task từng trễ hẹn gọi lại trong kỳ dù sau đó task đã Hoàn thành/đóng kỳ không? | Cách suy từ task `open` hiện tại sẽ làm số Quá hạn kỳ cũ biến mất; cần định nghĩa chỉ số lịch sử trước SPEC báo cáo. | Giữ số task từng trễ ít nhất một lần trong kỳ, đếm mỗi task một lần, tách khỏi Không hoàn thành trong kỳ. | Đã chốt 07/10: có, vẫn giữ số từng trễ hẹn trong báo cáo tháng cũ. |
| Q-63 | ✅ | Có cần file Excel thật và số MB trước B2 để đo import không? | Gate batch import | Dùng fixture giả B2, file thật QA trước rollout | Đã chốt 07/10: không cần trước B2; QA manual sau khi module hoàn thành. |
| Q-64 | ✅ | Bảng BI cần bao nhiêu cột GĐ1 và ai tạo? | Tránh yêu cầu thừa trước B5 | Các cột tối thiểu, operator tạo bảng | Đã chốt 07/10: chỉ cột cần xác nhận đơn/doanh thu; operator tạo bảng giống pattern cron KPI. Danh sách cập nhật theo Q-65–68 trong data contract r3.2. |
| Q-65 | ✅ | `pos_code` trong N3 là store bán hay store giao chăm sóc? | Không nhầm khóa nối/attribution | Store bán, nullable cho online; join theo customer ID | Đã chốt 07/10: cửa hàng phát sinh đơn. |
| Q-66 | ✅ | Đơn đã đặt sau chăm sóc rồi hủy/hoàn toàn bộ còn tính chuyển đổi không? | `is_valid_order` và attribution hiện đang đảo conversion | Giữ một chuyển đổi đã từng đặt | Đã chốt 07/10: vẫn tính vì đã từng đặt. |
| Q-67 | ✅ | Đơn hủy/hoàn toàn bộ giữ conversion 1 thì doanh thu trong báo cáo còn bao nhiêu? | `order_net_amount` và báo cáo | Conversion 1, doanh thu ròng 0 | Đã chốt 07/10: chuyển đổi 1, doanh thu 0. |
| Q-68 | ✅ | Nếu bảng BI xóa hẳn một dòng đơn đã từng đặt, CRM có tự xử lý không? | Tránh thêm tombstone/UI chỉ cho edge case | Không tự động; vận hành xử lý thủ công khi gặp | Đã chốt 07/10: không quan tâm ca rất hiếm trong GĐ1; Marketing/operator xử lý tay nếu xảy ra. |

## Bổ sung sau audit B1 (07/10/2026)

| Mã | Mức | Câu hỏi | Vì sao hỏi | Đề xuất PM | Trả lời |
|---|---|---|---|---|---|
| Q-69 | ✅ | Staff thấy số tiền đơn gán cho task mình? | RLS attribution và UI B4 | Chỉ thấy đơn thuộc task trong scope | User chốt: Có. Không mở bảng đơn thô toàn chuỗi. |
| Q-70 | ✅ | Ngày hẹn lại có được ở quá khứ trong tháng task? | Ghi lượt/nhãn trễ | Từ hôm nay tới cuối kỳ | User chốt: Có quy định không ở quá khứ. |
| Q-71 | ✅ | Staff nghỉ việc xử lý thế nào khi `users` chưa có cờ active? | Tránh import/chuyển giao vào account nghỉ | Inactive, chuyển task mở, khóa Auth, tháo store; giữ lịch sử | User đồng ý nguyên tắc inactive; PM diễn giải cách vận hành tối thiểu, Dev kiểm đường thao tác B2. |
| Q-72 | ✅ | User đã có dữ liệu CRM có bị xoá ở Auth/public.users không? | FK/audit lịch sử | Inactive, không xoá | User chốt: tài khoản nghỉ thì inactive, không xây luồng xoá. |

## Bổ sung sau audit B2 (08/10/2026)

| Mã | Mức | Câu hỏi | Quyết định |
|---|---|---|---|
| Q-73 | ✅ | ID/SĐT trong Excel nhận kiểu ô nào? | PM chốt theo quyền stakeholder giao: `customer_external_id` và `product_id` phải là Text; SĐT Text hoặc số thiếu 0 đầu, ứng dụng chuẩn hóa. |
| Q-74 | ✅ | Có xây riêng cơ chế xử lý file 10.000 dòng chạm timeout từ benchmark giả lập? | Không. Giữ trần 10.000; QA file vận hành thật trên DB thật trước rollout, chỉ sửa nếu lỗi xảy ra. |
| Q-75 | ✅ | Qua tháng giữa preview và xác nhận xử lý ra sao? | Giữ `PERIOD_CHANGED` và preview lại; không thêm cơ chế phức tạp. |
