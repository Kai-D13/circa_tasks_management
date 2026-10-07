# SPEC — Chăm sóc khách hàng (CRM-CSKH)

> **PM duyệt kỹ thuật B0 và B1 ngày 07/10/2026.** Nghiệp vụ hiện hành: `CONTRACT.md` v1.13 + `research/crm-cskh-handoff/DECISIONS.md` Q-03…Q-72. Data contract: `research/crm-cskh-data-contract-v3.md` r3.2. Plan Dev r1.3.1 và tái audit B1 r1.1 trong `reviews/2026-10-07-crm-b1.md`. **B1 GO kỹ thuật; full Playwright còn ngoại lệ chờ user cho commit. B2–B6 chưa được PM duyệt kỹ thuật.** Migration tiếp theo 114. GO kỹ thuật không cấp quyền commit hoặc chạy SQL prod.

## B0 — setup và hợp đồng thuần (GO)

**Mục tiêu:** chuẩn bị cờ, bộ quy tắc thuần và QA để B1–B6 có thể triển khai/test trên nhánh `feat/crm-cskh`. B0 không tạo bảng, không sửa dữ liệu prod, không bật UI/cron.

### Phạm vi

1. Khai báo `CARE_ENABLED`, `CARE_SYNC_ENABLED` mặc định OFF và biến cấu hình CRM cần thiết trong `.env.example`; không đưa secret/test credential vào Git. Khi cờ OFF, các route/UI/cron CRM chưa ảnh hưởng module hiện hành.
2. `lib/care/time.ts`: xác định tháng import và ngày cuối tháng theo `Asia/Ho_Chi_Minh`; có test biên cuối tháng/đầu tháng, năm nhuận. Không dùng UTC date trực tiếp làm kỳ VN.
3. `lib/care/outcome.ts`: sáu outcome theo CONTRACT; tập kết thúc gồm `NO_NEED`, `INTERESTED`, `ORDERED`, `REFUSED`; `UNREACHABLE` và `CALLBACK` còn mở. Đây là default dễ đổi cho Q-02/03, có `TODO(Q-xx)`; B1 sẽ kiểm parity với SQL `care_is_terminal_outcome`.
4. Client BigQuery mới cho CRM có API query tham số, phân trang `pageToken`/job chưa hoàn tất, timeout và kiểm lỗi. B0 test bằng mock, **chưa cần bảng N3 thật**. Có thể tái dùng cách xác thực service account hiện có; không dùng nguyên `runBigQuery()` KPI cho feed đơn vì hàm đó giới hạn `maxResults: 1000`, không phân trang/tham số. Không sửa cron KPI đang chạy.
5. Fixture Excel **giả** đúng một sheet/10 header và nhiều sản phẩm trên một khách; dữ liệu giả cho 25 store. Không yêu cầu file thật/số MB trước B2 (Q-63).
6. QA Marketing: Playwright hiện không tự nạp `.env.local`; Dev chọn cách nạp credential phù hợp **PowerShell trên máy Windows** hoặc loader an toàn trong Playwright process. Không dùng recipe Bash `set -a; . ./.env.local` trên PowerShell, không in mật khẩu. Test thiếu credential skip có lý do; khi credential có mặt, preflight kiểm role `admin` + phòng Marketing (không vô tình dùng super). QA ghi prod chỉ khi qua `writeQaGates`.

### AC/gate B0

- Cờ OFF không đổi nav, `/tasks`, cron và module đang live.
- Test thời gian biên cho ngày cuối tháng và đầu tháng VN; outcome default có test ý nghĩa và một nguồn TS.
- Mock BigQuery có test hơn một trang, job chưa xong, timeout và lỗi giữ nguyên snapshot phía caller. Không query BigQuery thật ở B0.
- Fixture không chứa PII thật; credential không xuất hiện trong source, log hoặc báo cáo.
- Dev báo file đổi, bằng chứng `npx tsc --noEmit` → spec liên quan → full Playwright → `npm run build` → `git diff --check`; nêu skip và rủi ro. Không commit/merge khi user chưa yêu cầu.

## B1 — migration 114, RLS và nghiệp vụ DB (SPEC PM — GO triển khai)

**Mục tiêu:** dựng nền dữ liệu CRM và các thao tác DB nguyên tử cho import, lượt chăm sóc, chuyển giao, đóng kỳ, quyền đọc/báo cáo. B1 chỉ viết migration `114_*.sql`, helper TS thuần nếu cần parity, test PGlite/source. Không xây route, UI, cron, import Excel parser hoặc kết nối N3 thật; không chạy SQL prod. Kết quả B1 phải giữ `main` và prod nguyên trạng, cờ CRM OFF.

### 1. Schema và ràng buộc

- Tạo các bảng trong plan r1.3.1 §4: `care_access`, `care_import_batches`, `care_import_staging`, `care_customers`, `care_tasks`, `care_task_products`, `care_interactions`, `care_assignment_events`, `care_store_refusals`, `care_reconcile_queue`, `care_orders`, `care_order_attributions`, `care_sync_state`. Bảng N3 trong Postgres có đúng các trường nghiệp vụ r3.2: `order_key`, `customer_external_id`, `ordered_at`, `source_updated_at`, `net_amount`, `pos_code` nullable; `synced_at` là metadata nội bộ. Không tạo `is_valid_order`, `is_deleted`, `order_status`, `channel`, `store_code` như hợp đồng cũ.
- `care_customers.external_id` unique toàn chuỗi. `care_tasks` unique `(customer_id, period_month)` và chỉ một task `open`/khách; `period_month` là ngày 1 tháng VN, `due_date` là ngày cuối kỳ. Task giữ snapshot `customer_name`, `phone_norm`, `phone_raw`, `store_id`, `assignee_id`, `is_test`; không đổi snapshot task kỳ cũ khi import kỳ mới. `status` chỉ `open|completed|closed_unfinished`; Quá hạn là chỉ số suy ra, không thêm status.
- `care_task_products` giữ revision bằng `is_current`; unique sản phẩm hiện hành `(task_id, product_id)`. Interaction và assignment event append-only, FK đầy đủ, không cho client sửa/xóa. Interaction chụp `assignee_id` và `store_id` tại thời điểm ghi; một task tối đa một lượt outcome kết thúc. `care_store_refusals` unique `(customer_id, store_id)`. Queue unique theo khách, khi ghi lại giữ `MIN(from_ts)`.
- Index theo truy vấn dự kiến: task `(assignee_id,status)`, `(store_id,period_month)`, `(customer_id,period_month DESC)`; interaction `(customer_id,created_at DESC,id DESC)`; attribution theo kỳ/store/dược sĩ; queue theo thời điểm. Tránh index thừa nếu PGlite/EXPLAIN không chứng minh được nhu cầu.
- Seed quyền import + xem toàn bộ CRM cho phòng Marketing UUID trong CONTRACT; super admin vẫn toàn quyền theo allowlist hiện hành. `care_access` là cấu hình quyền phòng: chỉ super admin được thay đổi, admin thường không thể tự nâng quyền. Metadata batch không chứa PII; staging chứa PII chỉ service role đọc/ghi, xóa sau finalize thành công.

### 2. Quyền và RPC

- RLS bật trên mọi bảng `care_*`. Bảng nghiệp vụ chỉ có SELECT theo scope; ghi chỉ qua RPC cho authenticated hoặc service role đúng mục đích. Helper `SECURITY DEFINER STABLE SET search_path=public` giải scope, policy không tham chiếu trực tiếp bảng RLS khác. Tất cả function mới `REVOKE ALL FROM PUBLIC, anon, authenticated` đích danh rồi `GRANT` đúng role; kiểm bằng `has_function_privilege`.
- Scope đọc: staff thấy task mình đang/đã được giao; sau chuyển A→B, A mất task hiện tại được chuyển và lượt của nó, B thấy lịch sử khách; A vẫn thấy task **kỳ cũ** từng thuộc A. Store manager thấy store mình nhưng không ghi/chuyển giao. SM thấy các store trong `sm_store_assignments`, chuyển giao chỉ trong phạm vi cả store nguồn lẫn đích. Care admin phòng được cấp `can_view_all` và super thấy tất cả; FS không được thấy CRM OS. `care_can_read_customer_history` chỉ mở toàn chuỗi cho staff/QLCH/SM khi khách có task **kỳ hiện tại** trong scope của họ; không suy từ task lịch sử.
- `care_import_finalize(batch_id, actor)` chỉ service role: xác thực actor là care admin có `can_import` hoặc super; trong một transaction khoá theo khách, kiểm lại store OS active, **assignee_email khớp đúng một** user role staff của store đích (0 hoặc >1 đều lỗi, kể cả email trùng khác chữ hoa/thường), DNC cùng store, unique, hash/idempotency và diff cùng tháng **trước khi ghi nghiệp vụ**. Đóng task kỳ cũ còn mở trước khi tạo kỳ mới. Không chạm task đã có lượt hoặc task vắng trong file revision; không đổi owner qua revision. Nếu một khách/dòng sai, rollback cả batch. B2 sẽ cung cấp staging/preview chuẩn; B1 test trực tiếp với staging giả.
- `care_record_interaction(task_id,outcome,note,next_action_date,proof)` cho authenticated staff được giao: khoá task `FOR UPDATE`, kiểm `open` và kỳ hiện tại theo VN, outcome hợp lệ, note 1–500 ký tự, ngày hẹn bắt buộc cho `UNREACHABLE`/`CALLBACK` và **từ hôm nay tới cuối tháng task** (Q-70). Ghi lượt append-only; kết thúc chuyển `completed`, xóa nhãn hẹn live, chụp owner/store, thêm reconcile queue; `REFUSED` ghi DNC của store hiện tại. Task completed/closed không nhận thêm lượt, kể cả RPC gọi trực tiếp. Proof tùy chọn, không quyết định trạng thái.
- `care_transfer_tasks(task_ids,to_user,note)` cho SM hoặc super: note bắt buộc; khoá mọi task theo thứ tự ổn định, kiểm toàn bộ trước khi ghi, chỉ task `open` kỳ hiện tại; target là `staff` ở store OS active. SM cần quyền cả store nguồn và đích. Store đích có DNC với khách thì toàn bộ lệnh lỗi; store khác được phép. Ghi event snapshot nguồn/đích/actor; không đổi interaction cũ hay attribution.
- `care_close_period` và `care_stamp_overdue` chỉ service role, idempotent; B1 tạo function nhưng chưa tạo cron. Mọi đường đóng kỳ, ghi lượt sau hẹn, stamp hằng ngày dùng **một helper SQL** để set `first_overdue_on` đúng một lần khi `next_action_date + 1 <= due_date`. Ngày hẹn cuối tháng không sinh Quá hạn của tháng cũ; task chưa xong vẫn `closed_unfinished` đầu tháng sau. Dùng `timezone('Asia/Ho_Chi_Minh', now())::date` hoặc tương đương, không dựa timezone server.
- `care_report(month,store_ids)` và `care_my_summary()` là DEFINER, tự lấy scope từ `auth.uid()`; không tin store/user do client truyền. **Cả hai mặc định loại `is_test` khỏi số liệu người dùng.** Báo cáo task theo owner hiện tại, conversion/doanh thu theo snapshot attribution và tháng của lượt Hoàn thành. Đếm `first_overdue_on` một lần/task dù task đã hoàn thành/đóng kỳ; `closed_unfinished` là chỉ số riêng và có thể giao. Không join làm nhân đôi task/doanh thu khi khách có nhiều sản phẩm/lượt. Không đọc `care_orders` trong report; staff/QLCH/SM không có SELECT trực tiếp vào `care_orders`, nhưng staff được đọc `net_amount` trong attribution thuộc task mình theo Q-69. B1 kiểm trên attribution fixture, B5 mới xây đồng bộ nguồn thật.
- Các hàm `care_upsert_orders`, `care_recompute_attribution` và logic cursor N3 thuộc **B5**. B1 chỉ tạo bảng, ràng buộc và quyền cần thiết; không code kết nối BigQuery hay giả định cột N3 ngoài r3.2.

### 3. An toàn migration và gate B1

- Migration 114 theo mẫu 112/113: header thứ tự chạy, preflight `app_migrations` 113, `BEGIN…COMMIT`, ghi version 114 cuối transaction, idempotency rõ, ROLLBACK gồm xóa version, block VERIFY. Mọi UPDATE/DELETE có WHERE vì `pg_safeupdate`. Không sửa migration cũ. Nêu đồ thị RLS trong comment/test trước khi viết policy.
- Test PGlite `scripts/qa-care-114.mjs` hoặc tương đương và Playwright source/contract: bảng/check/unique/FK, grants theo role, không RLS recursion, import atomic/idempotent, email staff khớp duy nhất, DNC import+transfer, hai task mở bị chặn, completed bất biến, transfer snapshot, scope 5 role, report **và `care_my_summary`** không lộ raw orders hoặc fixture `is_test`. Test trực tiếp RPC để không thể chỉ dựa UI. **Race nhiều connection** được PM chấp nhận dời sang B6 vì PGlite một session; bắt buộc test trên DB thật bằng fixture an toàn **trước bật cờ**, gồm hai lượt kết thúc đồng thời, chuyển giao song song ghi lượt, hai finalize cùng kỳ. Không tuyên bố race B1 đã đạt.
- Test biên: hẹn 30/10 → `first_overdue_on=31/10`; hẹn 31/10 → không có Quá hạn T10, sang 01/11 đóng kỳ; import T11 trước cron cũng cùng kết quả. Test mốc 23:59/00:00 VN và parity helper SQL ↔ helper TS ở `lib/care/time.ts`. Outcome SQL ↔ `lib/care/outcome.ts` phải khớp đủ sáu giá trị và tập terminal; default Q-02/03 còn TODO.
- Gate báo cáo: `npx tsc --noEmit` → spec B1/PGlite → full Playwright → `npm run build` → `git diff --check`; ghi rõ pass/fail/skip, SHA HEAD, danh sách file đổi, VERIFY và rollback. Full Playwright B0 còn 14 lỗi cũ: không tuyên bố xanh nếu vẫn đỏ; đưa artifact và so với baseline cho PM audit. Không commit khi user chưa yêu cầu. Không chạy migration prod trong B1.

## B2–B6 — gate chưa duyệt

- **B2:** import bằng fixture giả; file vận hành thật QA thủ công trước bật cờ rollout, không là dependency B2.
- **B3–B4:** web/mobile và chuyển giao theo CONTRACT; staff CTA `/tasks` mặc định tĩnh.
- **B5:** N3 theo data contract r3.2: ghép bằng ID khách; `pos_code` là store bán. Đơn đã đặt vẫn là conversion dù hủy/hoàn; doanh thu ròng về 0 nếu hủy/hoàn hết. Không dùng `is_valid_order`/`is_deleted` theo nghĩa r3.1; không xây xử lý xóa cứng tự động. Cần tên bảng, cột thực, cách cập nhật tiền/`source_updated_at`, độ trễ và quyền đọc trước khi tích hợp. Không có N2.
- **B6:** rollout cờ OFF → migration/VERIFY → dry-run N3 ×2 → QA fixture + file vận hành thật an toàn → bật cờ → smoke theo vai trò. Merge `main` chỉ sau B6 và theo yêu cầu user.
