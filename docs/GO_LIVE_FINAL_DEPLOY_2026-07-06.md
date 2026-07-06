# GO-LIVE FINAL DEPLOY — checklist (2026-07-06)

Deploy HEAD `617b07e` (main). Gộp toàn bộ commit từ ~04/07: KPI Campaign package,
Staff Mobile shell, Toa mạn tính (prescription), Belvita inactive, và batch cuối
(Performance · SM access · exports). PROD hiện ở `f448461` (KPI campaign chưa từng
deploy → chỉ migration 069 đã chạy trên prod).

## 1. Migrations — chạy trên PROD Supabase theo ĐÚNG thứ tự (069 đã có)
```
070_kpi_campaign_v2.sql
071_kpi_campaign_policy_model.sql
072_kpi_campaign_daily_actuals.sql
073_prescription_chronic_care.sql
074_store_is_active.sql          (Belvita đã ALTER tay → IF NOT EXISTS, an toàn; ghi app_migrations)
075_kpi_campaign_sm_access.sql   (SM đọc campaign store được assign)
```
Mỗi file idempotent + có verify block ở cuối. Chạy từng file, đọc verify.

## 2. Deploy build
Deploy HEAD `617b07e`. (Tắt dev server localhost trước khi build sạch nếu build tại chỗ — EPERM `.next` là lock dev, không phải lỗi code.)

## 3. Env (Coolify)
```env
KPI_CAMPAIGN_ENABLED=true
KPI_CAMPAIGN_TEST_MODE=false        # BẮT BUỘC false — nếu true, campaign mới bị ẩn khỏi staff/SM
BQ_SERVICE_ACCOUNT_KEY=<base64 SA>  # đã có (dùng cho BigQuery + Sheets)
CRON_SECRET=<secret>                # đã có
PRESCRIPTION_ORDER_SHEET_ID=1ia_TIFzOx3KsKlmLnTdYOd2VHTr8IMmyX0V2ortmdFs
PRESCRIPTION_ORDER_SHEET_RANGE=order_data
# (Tùy chọn ảnh mới lên GCS thay vì Supabase fallback:)
# STORAGE_PROVIDER=gcs  + GCS_BUCKET + GCS_PUBLIC_BASE_URL + GCP_PROJECT_ID
```

## 4. Dọn dữ liệu test (SQL, sau khi bật flag)
Chạy `docs/GO_LIVE_KPI_CAMPAIGN_CLEAN.sql`: xoá campaign `is_test=true`, verify 0, verify migrations.

## 5. Coolify Scheduled Tasks (Bearer CRON_SECRET)
```bash
# KPI campaign actual sync — mỗi 2h
wget -qO- --header="Authorization: Bearer $CRON_SECRET" https://duocsi.circa.vn/api/cron/sync-kpi-campaign-actuals
```
cron: `0 */2 * * *`
```bash
# Prescription order sync — 12:00 & 24:00 VN (UTC 05,17)
wget -qO- --header="Authorization: Bearer $CRON_SECRET" https://duocsi.circa.vn/api/cron/pull-prescription-orders
```
cron: `0 5,17 * * *`
Chạy tay mỗi cái 1 lần để verify (matched/upserted > 0).

## 6. Manual một lần
- Share Google Sheet toa (`1ia_TIFz…`) với email của `BQ_SERVICE_ACCOUNT_KEY` (Viewer).
- Rotate **BQ SA key + CRON_SECRET** (đã lộ trong chat) sau khi verify xong.

## 7. QA prod (theo role)
- Super admin: /targets/campaigns → tab Kết quả có cột + card **Nhịp độ (Performance)** + nút **Xuất Excel** (đủ cột gồm Performance).
- **SM** (`vu.nguyenhoang@buymed.com`, 2 store Nam Việt/Tâm Việt): Sidebar có "Doanh số"; /targets KHÔNG còn redirect; store selector chuyển giữa 2 store; mỗi store thấy campaign đúng (RLS mig 075). store_manager/staff không regress.
- Prescription: nộp toa mới (DHC strict) + toa mạn tính; cron order-sync điền customer/ngày; care flow; strip nhắc.
- Tasks: chọn checkbox N task → **Xuất đã chọn** ra đúng N; export theo filter vẫn chạy.
- Belvita: store inactive không xuất hiện khi tạo task mới / recurring / TRF / import.
- Staff mobile: 5 tab floating nav 1 dòng (Playwright smoke 360/390 pass).
```
