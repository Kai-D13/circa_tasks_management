# CONTRACT — Chăm sóc khách hàng (CRM-CSKH)

> Hợp đồng nghiệp vụ đang soạn. Mục 1–3 trích tài liệu gốc, **chưa tái xác nhận từng dòng**; mục 4 ghi các quyết định stakeholder đã chốt. Chi tiết còn mở nằm ở `research/crm-cskh-handoff/OPEN_QUESTIONS.md`.
> Trạng thái: **DRAFT v1.13 — nghiệp vụ GĐ1 đã thu hẹp theo Q-57–61, chốt Q-62–72 ngày 07/10; PM đã duyệt SPEC B0/B1, nghiệm thu B1 còn finding**. Nguồn: `research/crm-cskh-handoff/00_SOURCE_stakeholder_raw.md` (CMS.docx, 04/10/2026) và phản hồi stakeholder qua user ngày 05–07/10/2026. Vết quyết định: `research/crm-cskh-handoff/DECISIONS.md`.

## 1. Mục tiêu (từ tài liệu gốc)
Mỗi dược sĩ chịu trách nhiệm một danh sách khách được phân công, có hạn hoàn thành. Đo được: (a) bao nhiêu khách được chăm sóc thành công, (b) bao nhiêu khách phát sinh đơn mới (chuyển đổi, doanh thu).

## 2. Phạm vi
- **GĐ1 (build)**: import/phân công khách và sản phẩm/lý do từ Excel · dược sĩ xem danh sách sản phẩm import · ghi kết quả + ghi chú + proof tùy chọn · lịch hẹn lại/đóng kỳ · BigQuery đối chiếu **đơn sau chăm sóc** · dashboard/báo cáo theo dược sĩ/cửa hàng.
- **GĐ2 (không build)**: gợi ý khách đến kỳ mua lại, gợi ý sản phẩm và phân tích/tự động hóa nâng cao. GĐ1 vẫn cần đối chiếu đơn cơ bản qua ID khách + thời điểm để đo chuyển đổi theo quyết định Q-14/15.
- **Ngoài phạm vi**: thuật toán chọn khách cần chăm sóc ("logic ở bên ngoài" — admin chuẩn bị file).

## 3. Quy tắc stakeholder đã nêu (chờ xác nhận lại từng dòng)
| # | Quy tắc | Trạng thái |
|---|---|---|
| R1 | 6 kết quả chăm sóc: Không liên hệ được · Đã liên hệ–chưa có nhu cầu · Khách quan tâm · Hẹn chăm sóc lại · Đã đặt đơn · Từ chối | nêu trong docx |
| R2 | Mỗi lượt chăm sóc = 1 bản ghi mới, không ghi đè (append-only) | nêu trong docx |
| R3 | Mỗi nhiệm vụ: đúng 1 dược sĩ, ngày phân công, hạn hoàn thành | nêu trong docx |
| R4 | Mỗi lượt phải chọn kết quả + nhập ghi chú; chưa liên hệ được thì phải có ngày xử lý tiếp | nêu trong docx |
| R5 | Hết hạn chưa xong → tự chuyển Quá hạn | tài liệu gốc; **thay thế bởi Q-43/Q-58**: Quá hạn = hẹn lại trễ trong tháng; cuối tháng chưa hoàn thành = Không hoàn thành trong kỳ |
| R6 | Đơn chỉ tính chuyển đổi khi **xác thực được với hệ thống bán hàng** | nêu trong docx |
| R7 | Store Manager được điều chỉnh phân công (nghỉ việc / chuyển cửa hàng / nghỉ phép) | nêu trong docx; stakeholder xác nhận `sm` được chuyển khách, quyền `store_manager` chưa rõ |

### Bổ sung từ trao đổi stakeholder (05/10/2026)
- Admin Marketing cần template file rõ các cột để phân công. Phase 1 dùng **file import** cho khách hàng/store/dược sĩ, không lấy trực tiếp danh sách cần chăm sóc từ BigQuery. Đề xuất schema PM ở `research/crm-cskh-import-contract-proposal.md` vẫn chờ BI/Marketing đối chiếu.
- Màn dược sĩ cần hiển thị **lý do khách được chọn để chăm sóc** (ví dụ SP từng mua đang khuyến mãi, SP dùng thường kỳ chưa mua lại). BI/Marketing phải cung cấp ít nhất một lý do cụ thể/khách; taxonomy, rule nguồn và cách hiển thị vẫn cần xác nhận. App không tự suy ra lý do từ danh sách đơn.

## 4. Quyết định stakeholder đã xác nhận (05/10/2026)
- **Ghi nhận chăm sóc:** dược sĩ gửi kết quả trên task khách. Ảnh proof **tùy chọn**, có thể upload vào task theo cách vận hành tương tự chăm sóc toa; không phải điều kiện Hoàn thành. `Khách quan tâm` tính Hoàn thành; `Hẹn chăm sóc lại` vẫn Chưa chăm sóc và phải có thời gian hẹn. Hoàn thành chăm sóc và xác thực đơn/chuyển đổi là hai phép đo riêng.
- **Chuyển giao:** `sm` được chuyển khách giữa các dược sĩ, kể cả tình huống từ store A sang store B trong phạm vi quản lý. Tài khoản QLCH dùng chung `store_manager` không được chuyển khách. Việc từ chối liên hệ ở A không tự chặn B.
- **Quyền admin:** admin phòng Marketing (`department_id=80cb84b5-da69-46e3-b0e5-1de3d31b93c3`) được import/phân công ban đầu; super admin cũng có quyền. Cấp quyền cho phòng khác phải cấu hình được.
- **Định danh/phạm vi:** khách mua ở nhiều cửa hàng vẫn tính một khách; tại một thời điểm chỉ thuộc một store và một dược sĩ phụ trách. Đợt import/phân công chọn chủ sở hữu hiện tại; từ chối liên hệ có hiệu lực theo từng store.
- **Nguồn dữ liệu:** BI có ID khách ổn định và feed dòng đơn POS/online theo khách. Cần nhận data contract và quyền truy cập trước khi chốt tích hợp; file import là danh sách giao chăm sóc.
- **Hai đầu vào GĐ1:** (N1) Phase 1 import **một file chứa list khách của toàn bộ 25 store OS**, mỗi khách có mã store đích, **email dược sĩ bắt buộc** và lý do cụ thể theo sản phẩm; một khách có thể chiếm nhiều dòng sản phẩm trong cùng sheet. (N3) Sau khi dược sĩ Hoàn thành, cron **đọc trực tiếp một bảng/view đơn BigQuery** để xác thực đơn phát sinh sau chăm sóc và cập nhật Theo dõi hiệu quả. **Không build N2 lịch sử ba tháng** hay lấy sản phẩm/đơn cũ từ BigQuery cho mobile. Cần BI chốt hợp đồng đơn N3 và quyền đọc.
- **Task chăm sóc:** một **khách duy nhất trong kỳ import** tạo một task thuộc đúng một store và một dược sĩ, dù có nhiều dòng sản phẩm. “Task con” trong trao đổi là task chăm sóc này, không mặc định có thêm task riêng sau submit. Các lượt ghi nhận chăm sóc và đối chiếu đơn liên kết với task. Cách xử lý bản sửa cùng khách/kỳ, nhãn và nơi hiển thị thông báo còn chờ SPEC.
- **Ánh xạ dược sĩ:** email trong file dùng để tìm tài khoản `staff` tại `public.users` của store đích; app lưu ID user nội bộ sau khi xác thực. Không dùng ID bản ghi `entity_entity` của BigQuery làm ID app. Một email có thể xuất hiện nhiều dòng ở bảng BI, nên BI phải xuất đúng email và app phải từ chối email không khớp duy nhất với dược sĩ hợp lệ.
- **Chuyển đổi:** khi khách có đơn được xác thực trong feed BI với thời điểm phát sinh **sau lượt chăm sóc**, ghi nhận chuyển đổi cho dược sĩ đang phụ trách khách ở lượt đó. Không dùng cửa sổ 7 ngày; store/kênh bán của đơn không quyết định người phụ trách. PM sẽ định nghĩa cách chống đếm trùng và kỳ báo cáo trong SPEC.
- **Phạm vi module:** CRM-CSKH chạy độc lập với Toa có ngày dùng. Khách có toa vẫn có thể được phân công CSKH; GĐ1 không thêm logic đối chiếu, gộp hay cảnh báo toa.
- **Import:** màn cấu hình phải báo khách chưa được chia cho ai để admin sửa trước khi hoàn tất; không giữ kho task chưa phân công sau import. PM đề xuất schema import để BI đối chiếu.
- **Điều hướng:** tab CSKH thay TRF/Tồn kho trên bottom nav dược sĩ; TRF đang tắt và dược sĩ không cần truy cập trong giai đoạn này.

### Bổ sung từ stakeholder (07/10/2026)

- **Kỳ tháng và hạn:** admin import mỗi tháng; kỳ/hạn kết thúc vào **cuối tháng import theo giờ Việt Nam**, không tính 30 ngày lăn từ giờ import. Danh sách tháng mới không ghi đè tháng cũ. Đầu tháng mới, task tháng cũ còn mở được đóng kỳ để không có hai task mở của cùng khách; vẫn lưu lịch sử, không tính Hoàn thành.
- **Một file, nhiều sản phẩm:** `care_import_v1.xlsx` dùng một sheet; một khách có thể có nhiều dòng `product_id` nhưng tạo đúng **một task khách/tháng**. Các dòng cùng khách phải thống nhất store và dược sĩ. Có `reason_type`, `reason_text`, `product_id`, `product_name` và URL ảnh sản phẩm. Tên header cuối cùng cần BI/Marketing xác nhận.
- **Một nguồn BigQuery chỉ cho hiệu quả:** không xây lịch sử ba tháng. Tab `Sản phẩm` chỉ hiển thị sản phẩm từ file import tháng hiện hành; ảnh click để xem lớn. Một bảng/view đơn BigQuery để cron đối chiếu đơn sau chăm sóc; nguồn mức một đơn là đề xuất PM chờ BI xác nhận. Hợp đồng cập nhật: `research/crm-cskh-data-contract-v3.md`; bản v2 là lịch sử đề xuất cũ.
- **Sửa file cùng tháng:** preview diff; chỉ thêm khách mới hoặc sửa sản phẩm/lý do của task chưa có lượt chăm sóc. Task đã có lượt và khách vắng trong file sửa vẫn giữ, preview báo phần không áp dụng. Đổi store/dược sĩ phải qua chuyển giao có note, không ghi đè ngầm.
- **Phạm vi UI:** Browser có bốn feature `Khách hàng`, `Phân công`, `Chăm sóc`, `Báo cáo`; `sm`/super admin được chuyển khách giữa dược sĩ với note; store_manager chỉ xem trong store, không được chuyển. Mobile staff có entry CSKH, danh sách, chi tiết `Tổng quan`/`Sản phẩm`/`Lịch sử chăm sóc`, form outcome. Mockup chỉ tham khảo bố cục, không tự chốt các con số hoặc quyền.
- **Đơn và lịch hẹn:** Một đơn **đã đặt** được gán cho **lượt chăm sóc Hoàn thành gần nhất trước thời điểm mua** của khách; mỗi `order_key` chỉ tính một lần, không xây phân bổ phức tạp. `Hẹn chăm sóc lại` chỉ được chọn ngày trong tháng task. GĐ1 không hiển thị lịch sử đơn cũ trên mobile.

### Bổ sung từ phản hồi plan Dev r1 (07/10/2026)

- **Task Hoàn thành:** GĐ1 không cho ghi thêm lượt chăm sóc sau khi task đã Hoàn thành. Đơn mới được cập nhật qua BigQuery, không cần dược sĩ mở lại task.
- **Từ chối:** Outcome `Từ chối chăm sóc` Hoàn thành task và lưu DNC theo **khách + store**. Không tiếp tục liên hệ tại store đó; store khác không bị chặn tự động. PM đề xuất preview chặn import/chuyển giao vào đúng store còn DNC, cần Dev thực thi nhất quán.
- **Ảnh:** ảnh proof tùy chọn dùng bucket public giống ảnh Toa theo quyết định stakeholder. Ảnh sản phẩm import nhận URL từ CDN `cdn-gcs.thuocsi.vn`, chạm ảnh để xem lớn, tải theo nhu cầu để giữ mobile nhanh.
- **Dữ liệu BI/Marketing:** file vận hành GĐ1 không che PII; không đưa file thật vào Git, test fixture, log hoặc bucket public. Theo Q-63, **không cần file thật/số MB trước B2**; chỉ dùng để QA thủ công trước rollout. User/operator tạo bảng BigQuery N3 theo Q-64; Dev cần xác nhận tên bảng, dữ liệu và quyền trước B5. Con số ~62,8 KB stakeholder cung cấp là kích thước **ảnh mẫu**, không phải file Excel.

### Chốt phạm vi cuối từ stakeholder (07/10/2026)

- **Không có màn lịch sử mua/đơn ba tháng.** Các sản phẩm trong ảnh mockup chỉ là tham khảo cách trình bày; nguồn GĐ1 là các dòng `product_id` trong file Excel Marketing. File N1 không có order ID/ngày mua/giá bán nên không hiển thị nhóm theo đơn, tổng số đơn hay tổng tiền mua trước đó. Ảnh sản phẩm import có thao tác xem lớn; tải ảnh theo nhu cầu để bảo vệ hiệu năng.
- **Hai chỉ số hạn riêng:** task còn mở có lịch hẹn lại đã qua mà chưa ghi lượt tiếp → **Quá hạn** trong tháng. Task chưa hoàn thành khi hết tháng → đóng kỳ **Không hoàn thành trong kỳ**. Task không có lịch hẹn, chưa xử lý giữa tháng không tự thành Quá hạn.
- **Quá hạn trong báo cáo tháng cũ:** giữ số khách/task **từng trễ hẹn chăm sóc lại trong kỳ**, kể cả khi task sau đó Hoàn thành hoặc đóng kỳ; một task đếm một lần trong chỉ số này. Chỉ số Không hoàn thành trong kỳ vẫn tính riêng; một task có thể xuất hiện ở cả hai chỉ số nhưng không cộng hai số như hai tập rời nhau. Nhãn Quá hạn hiện tại chỉ áp cho task còn mở theo Q-58.
- **Báo cáo cohort:** tháng báo cáo là **tháng chăm sóc**; đơn mua tháng sau được tính ngược vào tháng có lượt Hoàn thành được gán. Chỉ số tháng cũ có thể cập nhật sau khi cron nhận đơn.
- **Nguồn đơn và hai chỉ số hiệu quả:** N3 nối bằng `customer_external_id` với N1; `pos_code` N3 là **store bán đơn**, có thể NULL ở đơn online, dùng đối soát chứ không quyết định store/dược sĩ được ghi công. Khi một đơn đã đặt sau lượt Hoàn thành, chuyển đổi = 1 dù về sau hủy/hoàn toàn bộ; lúc đó doanh thu ròng = 0. Hoàn một phần dùng tiền thực thu còn lại. Quy tắc cũ `is_valid_order=false` khi hủy/hoàn rồi xóa conversion đã bị Q-66/Q-67 thay thế. Không xây tự động xử lý ca nguồn xóa cứng rất hiếm; Marketing/operator xử lý thủ công nếu gặp (Q-68).
- **Cron:** Coolify có thể thêm hai Scheduled Tasks; operator cấu hình khi rollout. BI cung cấp một view đơn phát sinh để đồng bộ hiệu quả, không cấp thêm feed lịch sử mua cho UI.
- **Quyền thấy tiền đơn (Q-69):** dược sĩ được xem số tiền của đơn được gán cho task trong phạm vi của mình; không được đọc bảng đơn thô của toàn chuỗi hoặc đơn thuộc task người khác.
- **Ngày hẹn (Q-70):** ngày xử lý tiếp không ở quá khứ khi ghi lượt và không vượt ngày cuối tháng task.
- **Staff nghỉ việc (Q-71/72):** dùng quy ước inactive và chuyển giao task đang mở; giữ bản ghi user/auth và audit CRM, không xóa tài khoản có lịch sử. PM diễn giải thao tác tối thiểu: khóa đăng nhập, tháo gán store sau khi chuyển task; Dev kiểm cách vận hành hiện có ở B2, không thêm state CRM riêng trong B1.
- **File Excel B2 (Q-73):** theo đúng 10 cột N1; `customer_external_id` và `product_id` xuất kiểu **Text** để giữ nguyên ID, parser từ chối ô kiểu số ở hai cột. SĐT trong file có thể thiếu số 0 đầu/ở ô số; hệ thống chuẩn hóa về số di động VN trước khi lưu và đối chiếu, không bỏ kiểm SĐT hợp lệ.
- **Giới hạn import (Q-74/75):** stakeholder bảo đảm file tháng ≤10.000 dòng; giữ trần hiện tại, không xây cơ chế timeout/chia đợt mới cho ca giả định. QA file thật trên DB có 114 trước rollout phải xác nhận import hoàn tất; nếu lỗi thực tế mới sửa. Qua tháng giữa preview và commit thì báo kỳ đã đổi, yêu cầu preview lại; không thêm luồng đặc biệt.

## 5. Phụ thuộc còn lại theo batch

| Gate | Cần nhận/chốt | Chủ trì |
|---|---|---|
| Trước PM duyệt plan r1.1/SPEC B1 | Chuẩn hóa outcome còn lại theo sáu giá trị tài liệu gốc; quyền `store_manager` GĐ1 theo phạm vi xem store, không nộp thay; quyền phòng admin khác chỉ khi cấu hình; DNC/transfer và nhãn đơn trong SPEC. Đây là quyết định thiết kế PM từ nguồn hiện có, không tự mở tính năng mới. | PM, Dev phản biện |
| B2 import | **Không chặn B2 bằng file Excel thật hoặc số MB.** Dev dùng fixture giả để test parser/validate/atomic import/giới hạn upload. File vận hành thật chỉ dùng QA thủ công sau khi module hoàn thành và trước bật cờ rollout; nếu vượt giới hạn thiết kế thì xử lý theo kết quả QA. Danh mục `reason_type` thực tế có thể đối chiếu lúc QA. | Dev, Marketing, user vận hành |
| B5 đồng bộ đơn | User/operator sẽ tạo bảng BigQuery tương tự luồng cron KPI đang có. Dùng schema N3 r3.2 trong `research/crm-cskh-data-contract-v3.md`; xác nhận tên bảng, một dòng cho mỗi đơn đã đặt, cách cập nhật tiền khi hủy/hoàn, `source_updated_at` hoặc cách đối soát thay thế, độ trễ và quyền đọc SA trước B5. `pos_code` là store bán, không phải khóa gán cho dược sĩ. | User/BI, PM/Dev đối chiếu |

Các dependency B2/B5 không làm thay đổi quyết định nghiệp vụ GĐ1. Dev không code khi plan/SPEC batch tương ứng chưa được PM duyệt theo `AGENTS.md`.

## 6. Khi chốt
Ghi vào `research/crm-cskh-handoff/DECISIONS.md` (mã Q, ngày, quyết định, người chốt) rồi cập nhật mục 3–4 ở đây. Mục nào chốt xong mới được đưa vào `SPEC.md`.
