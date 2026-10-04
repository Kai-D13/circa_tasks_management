# SPEC — Chăm sóc khách hàng (CRM-CSKH) — kỹ thuật

> Viết **sau khi** `CONTRACT.md` chốt các mục 🔴. Bản nháp nghiệp vụ của BA (BR-01..11, AC-01..12, 9 slice) ở `research/crm-cskh-handoff/SPEC.md` — dùng làm đầu vào, không phải source of truth cho đến khi được PM duyệt.
> Trạng thái: **chưa viết**.

## Khung sẽ dùng (giữ ngắn, mỗi mục ≤ 1 trang)
1. **Data model** — bảng mới (`care_*`), khoá định danh khách (SĐT chuẩn hoá — Q-28), index, RLS theo người được gán / cửa hàng / phòng.
2. **RPC** — import atomic, ghi nhận lượt chăm sóc (append-only), chuyển giao, đánh dấu quá hạn; grant chỉ `service_role` / `authenticated` đúng chỗ.
3. **Nguồn dữ liệu ngoài** — theo Q-23: feed BigQuery (cần quyền dataset) hoặc kèm trong file import; parser dùng chung cho cả hai.
4. **Route & UI** — mobile dược sĩ (trong khung bottom nav hiện có — Q-26), web admin/QLCH; theo skill `circa-ui`.
5. **Cờ & cron** — `CARE_ENABLED` (mặc định OFF), cron quá hạn + nhắc, đối soát đơn (nếu GĐ1 có — Q-15).
6. **Thông báo** — badge + "hôm nay" cho dược sĩ; Teams cho QLCH không kèm PII (Q-25).
7. **Slice & migration** — bắt đầu từ migration **114**, nhánh `feat/crm-cskh`; mỗi slice: BR/AC phủ, test, gate.
8. **QA & rollout** — fixture `is_test`, safety gate, thứ tự: deploy OFF → migration → QA → bật cờ.
