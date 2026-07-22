# Plan: KPI Campaign × GMV Affiliate — tick chọn chỉ số khi tạo chiến dịch

**Phiên bản:** v1.2 · 22/07/2026 · v1.1 + chốt ngày ghi nhận (`completed_time`) + 092 r2 (exact target-set validation, seed harden, QA script thực thi)
**Phạm vi:** Enhance module KPI Campaign tại `/targets` — thêm chỉ số **GMV Affiliate** bên cạnh **GMV Offline** hiện tại.
**Nguyên tắc:** Không deploy tới khi toàn bộ pass QA; campaign đang chạy production KHÔNG bị ảnh hưởng (schema additive, mặc định = hành vi cũ; checkbox affiliate ẩn sau flag `KPI_AFFILIATE_ENABLED=false` cho tới rollout).

---

## 1. Contract nghiệp vụ (ĐÃ CHỐT — audit 22/07)

```text
Attribution store = affiliate_partner_code → affiliate_partner_mappings → stores.id (nguồn DUY NHẤT)
Đơn được tính GMV = status = DELIVERED (chỉ đơn giao thành công)
Giá trị GMV       = total_price
Target            = kpi_target chung từ file import hiện tại (file KHÔNG đổi)
```

- **`assigned_store_id` KHÔNG dùng cho attribution** — đó là cửa hàng xử lý đơn, không phải cửa hàng được ghi nhận Affiliate. Khách scan QR của `CIRCA-TAMVIET` → toàn bộ GMV Affiliate sau này luôn thuộc Tâm Việt, kể cả đơn do store khác xử lý. Mọi ý tưởng fallback/discovery bằng `assigned_store_id` trước đây đã **hủy hoàn toàn**.
- **`systemNote` / admin note / payment / address: không pull, không parse, không lưu** (chứa dữ liệu vận hành nhạy cảm; projection đồng bộ hiện tại đã minimal và giữ nguyên).
- **Tầng đồng bộ (ingestion) vẫn lưu MỌI status** — không lọc khi pull Mongo, vì đơn có thể chuyển `PROCESSING → DELIVERED` (phải cộng ở lần sync sau) hoặc `DELIVERED → CANCELED` (phải trừ). Việc lọc `DELIVERED` chỉ diễn ra ở tầng tính KPI: `source_active = true AND status_norm = 'delivered'`.
- Khi tick cả 2 chỉ số: `Đã đạt = GMV_offline + GMV_affiliate`; % hoàn thành, bậc thưởng, commission pool, còn thiếu, nhịp độ đều tính trên **tổng gộp** so với `kpi_target`.

## 2. Ngày ghi nhận GMV — ĐÃ CHỐT: `completed_time` (22/07)

Bằng chứng từ phiên VPN (field list đầy đủ 66 field của đơn DELIVERED):
- **`completed_time`** — mốc **giao thành công** chuyên dụng: **111/111** đơn DELIVERED có, trùng ngày VN với `last_updated_time` trên **111/111** đơn hiện tại → chọn field này (bền hơn `last_updated_time` vốn sẽ trôi nếu đơn bị cập nhật sau giao).
- `delivery_date` = ngày giao **dự kiến** (nhiều đơn nhỏ hơn cả mốc giao thật cả ngày) → không dùng.
- Hệ quả nghiệp vụ: đơn tạo TRƯỚC campaign nhưng giao TRONG campaign → **được tính**; đơn giao SAU end_date → không tính. 40/109 đơn DELIVERED trong snapshot lệch ngày VN giữa tạo và giao → lựa chọn field này thay đổi số thật.
- Ingestion bổ sung: projection + cột `affiliate_orders.completed_time` (migration 092); full-snapshot 2h tự backfill sau lần sync đầu. Lưu ý thứ tự: chạy 092 TRƯỚC khi bật `AFFILIATE_SYNC_ENABLED`. Canary QA: đơn DELIVERED thiếu `completed_time` phải = 0.

## 3. Số liệu baseline (đã verify độc lập 22/07 — khớp audit 100%)

Snapshot 153 đơn / 23 partner code; `DELIVERED` = **109 đơn / 36.836.230₫**. Sau khi map `CIRCA-MIZUKI`:

| Nhóm | Đơn DELIVERED | GMV | Vào campaign OS? |
|---|---|---|---|
| OS (15 code, gồm MIZUKI) | 31 | 8.522.800₫ | ✅ |
| FS (HOABINH2) | 5 | 2.124.100₫ | ❌ (chỉ super thấy) |
| Đối tác ngoài (7 code) | 73 | 26.189.330₫ | ❌ (chỉ super thấy) |

**`CIRCA-MIZUKI` là code mới** (1 đơn DELIVERED 248.900₫) chưa có trong mapping — đã verify DB: `POS0013` = "CIRCA MIZUKI", loại **os**, đang **active** → thêm mapping chính thức trong migration tiếp theo (kèm preflight). Manifest cập nhật 148/22 → **153/23**.

## 4. Kiến trúc & đồng bộ 2 nguồn

```text
BigQuery BI ─(cron 2h, phút 20)──────────────┐
                                             ├─> KPI aggregate ─> actuals (+offline/affiliate) ─> UI 4 role
MongoDB ─(cron 2h, phút 05)─> affiliate_orders┘        │
   (3-RPC lifecycle, đã audit 3 vòng)                  └─> daily (+gmv_affiliate) ─> chart
```

- KPI aggregate **không gọi Mongo trực tiếp** — chỉ đọc `affiliate_orders` nội bộ; phép SUM chạy **trong database qua RPC service-role** (không giới hạn 1.000 dòng của API).
- **Thứ tự bắt buộc:** Affiliate sync thành công → KPI aggregate. KPI **không recompute** nếu run affiliate mới nhất đang `running`/`failed` hoặc stale (quá 3h) → **giữ snapshot cũ**, không bao giờ ghi dữ liệu nửa thành công (ghi daily + tổng trong cùng 1 transaction). Campaign offline-only không bị ảnh hưởng.
- 2 cron Coolify lệch phút: affiliate `5 */2 * * *`, KPI aggregate `20 */2 * * *`.

## 5. Thay đổi schema — migration mới (additive)

| Đối tượng | Thay đổi |
|---|---|
| `affiliate_orders` | + `completed_time` (date basis KPI — mục 2); sync 2h tự backfill |
| `kpi_campaigns` | + `metric_offline` (default **true**), `metric_affiliate` (default **false**), CHECK ≥1 bật → campaign cũ tự = offline-only, số không đổi |
| `kpi_campaign_store_actuals` | + `actual_offline`, `actual_affiliate` (NOT NULL DEFAULT 0) + `offline_synced_at`, `affiliate_synced_at`; **backfill** `actual_offline = actual_value`, `actual_affiliate = 0`; `actual_value` giữ nghĩa = tổng |
| `kpi_campaign_store_daily_actuals` | + `gmv_affiliate` (default 0); `gmv` giữ nghĩa Offline |
| Mapping | + `CIRCA-MIZUKI → POS0013` (os) sau preflight store active/đúng loại; mapping tồn tại nhưng SAI → migration FAIL (không im lặng giữ bản sai) |
| Index | partial index `(store_id, completed_time DESC) WHERE source_active AND status_norm='delivered'` phục vụ aggregation |
| RPC | + `rpc_aggregate_affiliate_gmv` (SUM theo store × ngày VN `completed_time` trong DB); `rpc_replace_campaign_actuals` (r2): backward-compat caller cũ + **validate đầy đủ trước khi replace** — campaign tồn tại · không duplicate store/(store,date) · payload phủ đúng TOÀN BỘ targets (2 chiều) · daily ⊆ actuals · tổng = offline + affiliate · metric tắt = 0 · SUM(daily) khớp aggregate; lỗi → rollback toàn transaction. Cả hai RPC chỉ `service_role` EXECUTE |
| QA | script thực thi `webapp/scripts/qa-kpi-affiliate-092.mjs`: legacy caller (100/100/0), both-metric, đủ 8 case RAISE + rollback + quyền anon + cleanup exact-ID |

## 6. Cấu hình campaign

- Màn tạo/sửa: 2 checkbox `☑ GMV Offline` (mặc định) / `☐ GMV Affiliate`; bắt buộc ≥1; campaign cũ mặc định Offline-only; file import giữ nguyên.
- Chỉ sửa metric khi `draft/paused` (không sửa khi `active/ended` — rule sẵn có).
- **Campaign có Affiliate chỉ được activate khi affiliate sync gần nhất thành công và không stale** (fail-closed).
- Flag `KPI_AFFILIATE_ENABLED=false`: ẩn checkbox cho tới rollout — deploy code an toàn trước khi data sẵn sàng.

## 7. Hiển thị theo role

- **1 metric:** giữ layout hiện tại, label đúng nguồn (offline-only = y hệt màn hiện tại).
- **2 metric:** hero tổng gộp + khối "Phân loại theo chỉ số" 2 dòng GMV Offline / GMV Affiliate (giá trị + % riêng trên cùng target). **Không đặt chevron** khi dòng chưa bấm được (drill-down đề xuất sau).
- Chart "Tiến độ theo ngày": cột = tổng ngày; dữ liệu lưu riêng 2 nguồn để mở stacked chart sau.
- Staff mobile 360/390/430; SM/Quản lý cửa hàng dùng chung khối "Kết quả" (+2 card breakdown); super detail +2 cột; **export gồm Offline · Affiliate · Total + timestamp từng nguồn**.

## 8. Referral — đóng nốt 3 entry point (điều kiện trước deploy branch)

`REFERRAL_ENABLED=false` hiện mới chặn upload + cron. Bổ sung gate: (1) mục "Giới thiệu" trên sidebar, (2) truy cập thẳng `/gioi-thieu` → redirect, (3) card Referral trong `/targets` của staff (kèm bỏ query). Code + data giữ nguyên — bật lại được bằng flag.

## 9. QA bắt buộc

1. **Regression vàng:** campaign offline-only trước/sau migration **bằng tuyệt đối** mọi màn, mọi role.
2. Status: chỉ DELIVERED tính; PROCESSING/DELIVERING/CANCELED/FAIL_TO_DELIVER/status lạ không tính; `PROCESSING→DELIVERED` cộng ở sync sau; `DELIVERED→CANCELED` trừ ở sync sau.
3. **Attribution:** đơn partner Tâm Việt nhưng store khác xử lý → vẫn ghi Tâm Việt; MIZUKI map đúng POS0013; FS/external/unmatched không lọt campaign OS (đối chiếu baseline mục 3).
4. Đối soát SUM tay = `actual_affiliate`; SUM daily 2 nguồn = `actual_value`; giá âm cộng đúng.
5. Staleness: affiliate run lỗi/stale → KPI giữ snapshot cũ; affiliate-only campaign không gọi BigQuery.
6. Boundary ngày UTC/VN theo field stakeholder chốt; role/RLS, light/dark, mobile; F2 backfill run 1 + run 2 idempotent; typecheck, build, Playwright, Docker Node22 smoke.

## 10. Rollout (thứ tự khóa)

1. Deploy code với `KPI_AFFILIATE_ENABLED=false` (zero hành vi mới).
2. Chạy migration + verify.
3. Bật VPN: **dry-run** đồng bộ (kỳ vọng 153 rows, MIZUKI unmatched trước migration mapping; in field list đơn DELIVERED để chốt mục 2) → duyệt output → **backfill**.
4. Chạy lần 2 kiểm idempotency (duplicate = 0, deactivated = 0).
5. Coolify cron: affiliate phút 05, KPI aggregate phút 20 mỗi 2h + **Atlas allowlist IP server Coolify (ticket DevOps — bắt buộc cho prod)**.
6. QA campaign test (`is_test` — ẩn khỏi staff/SM thật).
7. Bật `KPI_AFFILIATE_ENABLED=true`.
8. Trang `/affiliate` riêng: **superseded — không build/không bật** (đã đánh dấu trong kế hoạch Affiliate cũ).

---

**Trạng thái duyệt:** contract mục 1 + kiến trúc + schema + rollout = đã chốt theo audit 22/07. Còn lại duy nhất **mục 2 (field ngày ghi nhận)** chờ stakeholder — sẽ trình kèm bằng chứng field list từ phiên VPN dry-run.
