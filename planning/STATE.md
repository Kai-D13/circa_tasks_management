# STATE — hiện trạng dự án (cập nhật khi deploy / chạy migration / đổi hướng)

_Cập nhật: 2026-10-04. Nguồn: git, bảng `app_migrations` prod (đọc 01/10), bảng `kpi_campaigns` prod (đọc 04/10), xác nhận của user._

## Prod
- **Deploy**: Coolify từ `main` @ `4472524` (17/09/2026) — `release(authz): thêm nikhilesh… allowlist super admin`. Không có nhánh nào lệch main cần merge (`integration/tasks-affiliate-20260728` +2 là nhánh cũ, bỏ qua).
- **Migration đã chạy**: 037 → 113 đủ (084 cố ý bỏ trống). Migration tiếp theo: **114**.
- **Supabase**: self-host, realtime tắt, Kong rò RAM cần restart định kỳ (`docs/runbook-disable-realtime.md`, `docs/audit_feedback_docker_check.md`).
- **Cron (Coolify)**: overdue 5′ · teams-dispatch 1′ · generate-recurring-tasks 01:00 UTC · pull-targets 2h · pull-kpi-targets 2h · sync-kpi-campaign-actuals 2h · pull-affiliate-orders 2h · pull-prescription-orders 05:00/17:00 · pull-inventory-trf 02:00 · cleanup-uploads · cleanup-announcements · pull-referrals (503, đã ngưng).
- **Cờ env đang bật (suy ra từ dữ liệu)**: `KPI_CAMPAIGN_ENABLED`, `KPI_AFFILIATE_ENABLED`, `AFFILIATE_SYNC_ENABLED`, `STORAGE_PROVIDER=gcs`. Tắt: `REFERRAL_ENABLED`, `KPI_CAMPAIGN_TEST_MODE`. Chưa rõ: `KPI_AFFILIATE_CUSTOMER_ENABLED`, `KPI_ORDER_AOV_CAMPAIGN_ENABLED` (hỏi user khi cần).

## Chiến dịch KPI đang live (user xác nhận 04/10, DB khớp)
| Campaign | id | kỳ | loại | ghi chú |
|---|---|---|---|---|
| KPI tháng 10/2026 | `923e4e83-0e38-4c4a-b099-93b03e33b4a2` | 01–31/10 | gmv, Offline+Affiliate | 25 store, không ngưỡng thưởng thêm |
| KPI W1 T10-2026 | `134dfed7-e541-456f-9399-3483f78f9fc2` | 01–07/10 | gmv, Offline+Affiliate | 25 store, không ngưỡng thưởng thêm |
Thưởng thêm theo số đơn (mig 112) đã deploy nhưng **chưa campaign nào dùng**. Audit KPI T09 xem memory `project_kpi_t09_audit`.

## Việc đang làm
- **CRM-CSKH (Chăm sóc khách hàng)** — giai đoạn DEFINE. Gói handoff tại `planning/research/crm-cskh-handoff/` (chưa final); CONTRACT/SPEC ở `planning/` (SPEC, OPEN_QUESTIONS Q-01…Q-20 + Q-21… do dev bổ sung, DECISIONS trống, 4 mockup). Bước kế: IMPLEMENTATION_PLAN.md → PM duyệt → slice 1.
- Bản brainstorm trước spec (phân tích 2 bảng BQ `dim_circa_growth_staff_customer`, `fact_circa_growth_reminder`): `planning/research/brainstorm-v0.2-truoc-spec.md`.

## Nợ kỹ thuật đã biết (không chặn, ghi để không quên)
- Ảnh toa thuốc ở bucket public (TODO từ mig 016). Ảnh toa/FS/bảng tin mồ côi không có cron dọn.
- `DEVNOTES.md` (dừng ở mig 005) và `business_logic_structure.md` (sai stack) đã lỗi thời → `CLAUDE.md` thay thế.
- Env khai nhưng không dùng: `AFFILIATE_ENABLED`, `GCP_PROJECT_ID`, `NEXT_PUBLIC_API_URL`. Dùng nhưng thiếu trong `.env.example`: `SUPABASE_INTERNAL_URL`, `TARGETS_INGEST_SECRET`, `NEXT_PUBLIC_APP_URL`, `AFFILIATE_MONGO_DB`, `AFFILIATE_MONGO_COLLECTION`, `UI_CATALOG`.
- `rpc_staff_update_task_status` không còn ghi `task_status_events` (mất từ mig 031). So sánh `CRON_SECRET` bằng `!==`.
- Working tree: 5 file tracked đang bị xoá chưa commit (`PROJECT_STATUS.md`, `TODAY_NEXT_STEPS.md`, `list_store_info.txt`, 1 jpg, 1 md) — chờ user quyết.
