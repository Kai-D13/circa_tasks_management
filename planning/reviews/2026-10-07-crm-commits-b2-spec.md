# PM audit — ba commit B0/B1 và SPEC B2 (07/10/2026)

## Phạm vi kiểm

- HEAD local `feat/crm-cskh` = `7218358`; lịch sử nối tiếp `7a1eb1f` → `059dff5` → `7218358`, lần lượt 11/14/3 file theo `git show --stat`. `git show --check` cả ba không phát hiện lỗi whitespace. Nhánh local chưa có upstream được cấu hình; PM không push/merge/checkout/commit.
- Diff commit chỉ gồm planning CRM, B0 `webapp/lib/care`, `lib/bigquery`/fixture/QA/config, và B1 migration 114/QA. File ngoài phạm vi còn ở working tree, không được tự stage. Điều kiện full Playwright **vẫn là ngoại lệ do user đã duyệt**: báo cáo gần nhất 839 pass / 13 fail / 60 skip; baseline `dff97d3` và artifact được Dev lưu. Commit và hook `tsc` không biến full suite thành xanh.
- PM đã nghiệm thu B1 r1.1 ở `2026-10-07-crm-b1.md` sau PGlite 173/0; audit này không chạy lại suite hay SQL, không xác nhận môi trường prod. Migration 114 hiện **chưa chạy prod**. JWT secret từng lộ trong transcript là việc an toàn hạ tầng cần operator xử lý kín trước rollout, không là dependency code B2.

## Quyết định

**GO B2 trên nhánh** theo `planning/SPEC.md` §B2: Excel N1, API preview/commit, wizard và lịch sử import. B2 dùng fixture giả; không cần file thật, BigQuery N3, migration prod hoặc mở cờ. Dev chỉ triển khai đúng B2 và báo lại diff/gate để PM audit. B3–B6 chưa GO.

## Redline cần Dev giữ

1. Preview không ghi; finalize SQL 114 là nguồn quyết định và vẫn kiểm lại quyền, DNC, mapping email duy nhất, revision. Không dùng service role trước kiểm quyền app.
2. `care_import_staging.row_no` là dòng Excel gốc, liên tục; commit gửi lại file, kiểm SHA-256/kỳ. Trạng thái `duplicate`/`rejected` không được trình bày như tạo task thành công.
3. Một khách nhiều dòng sản phẩm vẫn một task; `assignee_email` trong file đã là phân công. Wizard bước 3 chỉ xem. Chuyển giao thủ công có note để B3.
4. Diff phải giữ task đã có lượt, khách vắng file và lịch sử tháng cũ; đổi owner trong file chỉ báo `owner_ignored`. `is_test` không lấy từ client.
5. Chỉ lưu tên file kỹ thuật và số đếm/mã lỗi trong batch; không log/store file thật, tên/SĐT, secret hoặc screenshot có PII. UI theo `circa-ui` và không ảnh hưởng bottom nav staff.
6. Báo kết quả đo fixture gần cap/10.000 dòng; hiệu năng với DB prod `statement_timeout=8s` kiểm lại ở B6 trước rollout. Full Playwright nếu còn lỗi phải so baseline, nêu regression mới và artifact, không ghi “pass”.

**Gate giao B2:** `tsc → spec/API/PGlite → full Playwright → build → diff --check`, báo SHA và file đổi. PM audit sau batch; commit chỉ theo quyền user đã cấp, không push/merge/deploy/migration prod nếu chưa có lệnh.
