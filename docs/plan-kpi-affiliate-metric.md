# Plan: KPI Campaign × GMV Affiliate — tick chọn chỉ số khi tạo chiến dịch

**Phiên bản:** v1.0 · 22/07/2026 · Trình stakeholder duyệt trước khi build
**Phạm vi:** Enhance module KPI Campaign tại `/targets` — thêm chỉ số **GMV Affiliate** bên cạnh **GMV Offline** hiện tại.
**Nguyên tắc:** Không deploy bất kỳ thay đổi nào tới khi toàn bộ pass QA; campaign hiện đang chạy trên production KHÔNG bị ảnh hưởng (mọi thay đổi schema là additive, mặc định = hành vi cũ).

---

## 1. Tóm tắt request

Khi super admin tạo campaign (`/targets/campaigns/new`), bước "Thông tin" có thêm **2 ô tick chọn chỉ số**:

| Tick | Nguồn dữ liệu | Ý nghĩa |
|---|---|---|
| ☑ **GMV Offline** (mặc định tick) | BigQuery BI (như hiện tại) | Doanh số bán tại cửa hàng |
| ☐ **GMV Affiliate** | MongoDB Circa Online → bảng `affiliate_orders` (đồng bộ 2h/lần) | Doanh số đơn khách scan QR đặt trên circa.vn, ghi nhận cho store |

Hành vi theo cấu hình:
- **Chỉ tick GMV Offline** → toàn bộ cấu hình, cron, hàm xử lý, hiển thị **y hệt hiện tại** (campaign cũ tự động thuộc nhóm này).
- **Chỉ tick GMV Affiliate** → mọi chỉ số (Đã đạt, %, bậc thưởng, chart) tính từ đơn Affiliate.
- **Tick cả 2** → hero "Đã đạt" = **tổng gộp**, thêm khối "**Phân loại theo chỉ số**" tách riêng từng nguồn (theo mock UI stakeholder đã gửi).
- **File import target KHÔNG đổi** — vẫn `pos_code, kpi_target, store_kpi_group, tier_N_threshold_pct, tier_N_commission_amount`.

---

## 2. Quy tắc nghiệp vụ (đã chốt 22/07 — đề nghị stakeholder xác nhận lần cuối vì dính thưởng)

### 2.1 Công thức khi tick cả 2 chỉ số (theo mock)
```
Đã đạt        = GMV_offline + GMV_affiliate
% hoàn thành  = Đã đạt / kpi_target × 100        (mock: (256,7tr + 57,9tr) / 491,3tr = 64%)
Bậc đạt       = bậc CAO NHẤT có threshold ≤ % hoàn thành (trên % GỘP)
Commission    = số tiền của bậc đạt (quỹ Store — chính sách hiện hành, không đổi)
Còn thiếu     = max(kpi_target − Đã đạt, 0)
```
Khối "Phân loại theo chỉ số": mỗi dòng hiện giá trị + `% riêng / cùng kpi_target` (mock: offline 53%, affiliate 12% — cộng lại = 64% hero).

### 2.2 Quy tắc đếm GMV Affiliate (kế thừa nguyên các quyết định đã duyệt ở chương trình Affiliate)
- Đếm **mọi đơn trừ CANCELED** (FAIL_TO_DELIVER và trạng thái lạ vẫn tính) — nhãn "Doanh số Affiliate ghi nhận".
- Doanh thu = `total_price` (field tiền duy nhất trong Mongo); **giá trị âm vẫn cộng** (giữ để phát hiện case thực tế).
- Đơn thuộc store nào = theo bảng mapping `affiliate_partner_mappings` đã seed (22 code). Đơn **Đối tác ngoài / code chưa map / mapping tắt** → không thuộc store nào → **KHÔNG tính vào campaign của bất kỳ store nào**.
- Ngày ghi nhận = `created_time` quy về **ngày Việt Nam** (khớp cách BigQuery tính ngày cho GMV offline).
- Chỉ tính đơn còn tồn tại ở nguồn (`source_active = true` — đơn biến mất khỏi Mongo bị loại khỏi số).

### 2.3 Hiển thị phase này
- Chart "Tiến độ theo ngày": **cột gộp** (offline + affiliate cùng 1 cột/ngày). "GMV hôm nay" = tổng ngày.
- Dòng trong "Phân loại theo chỉ số" **chưa bấm được** (chevron trang trí hoặc bỏ) — bản stacked 2 màu / bấm xem danh sách đơn affiliate sẽ đề xuất sau khi stakeholder xem bản đầu.

---

## 3. Kiến trúc & luồng dữ liệu

```
BigQuery BI ──(cron 2h, như hiện tại)──┐
                                       ├──> syncCampaign() ──> kpi_campaign_store_actuals   ──> UI 4 role
MongoDB Circa Online ──(cron 2h,       │         │             (+ actual_offline/affiliate)
  pull-affiliate-orders, đã build) ──> │         └──────────> kpi_campaign_store_daily_actuals
  affiliate_orders (Supabase) ─────────┘                       (+ gmv_affiliate) ──> chart
```
- Campaign sync **KHÔNG gọi Mongo trực tiếp** — chỉ đọc bảng `affiliate_orders` nội bộ (đã có pipeline đồng bộ 2h qua 3-RPC lifecycle, audit 3 vòng, chống trùng/chống kẹt lease). Một nguồn sự thật, một chỗ đối soát.
- Cadence 2 nguồn bằng nhau (2h) → số offline và affiliate luôn cùng độ tươi.

## 4. Thay đổi schema — migration `092` (additive, an toàn với production)

| Bảng | Thêm | Mặc định |
|---|---|---|
| `kpi_campaigns` | `metric_offline boolean`, `metric_affiliate boolean` + CHECK (ít nhất 1 bật) | `true` / `false` → **campaign cũ tự = offline-only, số không đổi 1 đồng** |
| `kpi_campaign_store_actuals` | `actual_offline`, `actual_affiliate` (nullable) | `actual_value` GIỮ = tổng → mọi màn cũ chạy nguyên |
| `kpi_campaign_store_daily_actuals` | `gmv_affiliate` | `0` (`gmv` giữ nghĩa = offline) |
| RPC `rpc_replace_campaign_actuals` | Cập nhật body ghi cột mới — **signature giữ nguyên**, quyền EXECUTE re-assert chỉ service_role | — |

Không đổi RLS row-level (cột mới đi theo policy sẵn có: staff/SM chỉ đọc store mình, campaign active + non-test).

## 5. Hiển thị theo role (khi campaign tick cả 2)

| Role | Màn | Thay đổi |
|---|---|---|
| **Staff** (mobile) | `/targets` campaign view | Theo mock: hero tổng gộp + Card "Phân loại theo chỉ số" (2 dòng offline/affiliate) + 3 thẻ metric + chart gộp |
| **Store Manager** | `/targets` khối "Kết quả chiến dịch" | +2 card "GMV offline" / "GMV affiliate" |
| **SM (quản lý vùng)** | `/targets` store selector | Như Store Manager (cùng component) |
| **Super admin** | `/targets/campaigns/[id]` tab Kết quả | Bảng per-store +2 cột GMV offline/affiliate; tab Cấu hình hiện dòng "Chỉ số: …" |
| **Super admin** | Export Excel campaign | +2 cột GMV offline / GMV affiliate |

Campaign chỉ tick 1 chỉ số → không có khối phân loại, layout hiện tại giữ nguyên (số theo đúng chỉ số đã tick). Chú thích cuối trang đổi theo cấu hình (offline-only giữ "* Không bao gồm đơn online").

## 6. Những gì KHÔNG thay đổi
- File import target + toàn bộ validate/preview/commit.
- Cách tính bậc thưởng/commission pool (chỉ đổi ĐẦU VÀO là tổng gộp khi tick cả 2).
- Danh sách campaign `/targets/campaigns` (Đã đạt = tổng — đúng nghĩa mới luôn).
- Campaign đang chạy trên production: tự nhận cấu hình offline-only, số y hệt trước migration (đây là regression gate số 1 khi QA).
- `/targets` chế độ Ngày/Tuần/Tháng (khi store không có campaign).

## 7. Chuỗi phụ thuộc & điều kiện go-live (QUAN TRỌNG)

Để GMV Affiliate có **số thật**, bảng `affiliate_orders` phải được nạp và giữ tươi:
1. **Audit F2 r1.1** (diff `65ad850..c5abaa2` — cron đồng bộ Mongo đã hardening 3 vòng) → pass.
2. **Phiên VPN 2 gate** (đã thống nhất trước đó): gate 1 dry-run đối soát → duyệt → gate 2 first-write backfill (~153 đơn) + chạy lần 2 kiểm idempotent.
3. **Prod dài hạn:** DevOps allowlist IP server Coolify trên MongoDB Atlas + bật `AFFILIATE_SYNC_ENABLED` + Coolify Scheduled Task `0 */2 * * *`. **Chưa xong bước này thì campaign tick affiliate trên prod sẽ không có số** — cần chốt ticket DevOps sớm.
4. Không cần bật `AFFILIATE_ENABLED` (flag đó thuộc trang /affiliate riêng — xem mục 9).

## 8. Kế hoạch build & QA

**Build (3 batch, mỗi batch commit/push để audit diff):**
- B1: migration 092 + sync engine (`lib/kpi/actuals.ts`) + actions + wizard tick box.
- B2: màn Staff theo mock (fetch + CampaignKpiView).
- B3: SM + super detail + export.

**QA gate (trên campaign `is_test` — ẩn hoàn toàn khỏi staff/SM thật):**
1. **Regression vàng:** campaign offline-only trước/sau migration — mọi màn, mọi role, số y hệt.
2. Đối soát: SUM tay `affiliate_orders` per store = `actual_affiliate`; SUM(daily gmv + gmv_affiliate) = `actual_value`; offline 53% + affiliate 12% = hero 64% (số mock).
3. Boundary: đơn CANCELED không tính; đơn Đối tác ngoài không tính; đơn 23h UTC rơi đúng ngày VN hôm sau; total_price âm cộng đúng; campaign affiliate-only không gọi BigQuery.
4. Ma trận role: staff / store_manager / SM / admin thường (không thấy) / super — light+dark, mobile 360/390/430.
5. tsc + build + full Playwright suite xanh.

## 9. Ảnh hưởng tới kế hoạch Affiliate đã duyệt trước đó
- **Không revert gì.** F1 (schema + mapping + RLS, migration 090/091 đã chạy) và F2 (cron đồng bộ) chính là NỀN của request này — tiếp tục dùng.
- Trang `/affiliate` riêng + card "Đơn hàng Affiliate" trong /targets staff (F3/F4 cũ — **chưa build dòng nào**): tạm gác. Đề nghị stakeholder xác nhận sau: còn cần trang xem danh sách đơn affiliate riêng không, hay chỉ số trong campaign là đủ?
- Referral vẫn tắt bằng flag như đã chốt (không liên quan batch này).

## 10. Rủi ro & biện pháp

| Rủi ro | Biện pháp |
|---|---|
| Số affiliate stale nếu cron chưa chạy trên prod | Điều kiện go-live mục 7; UI luôn hiện "Cập nhật lúc" từ synced_at |
| Campaign cũ bị lệch số sau migration | Cột mới nullable/default, actual_value giữ nghĩa tổng; regression gate số 1 |
| Đơn affiliate của store ngoài campaign / Đối tác ngoài lọt vào | Sync chỉ đếm store_id thuộc danh sách target của campaign |
| Lệch ngày UTC/VN giữa 2 nguồn | Cùng quy về ngày VN (+07:00) ở cả 2 pipeline; có test boundary |
| RPC bị cấp quyền thừa khi REPLACE | Re-assert REVOKE anon/authenticated + GRANT service_role ngay trong migration (bài học 091) |

---

**Đề nghị stakeholder xác nhận:** (1) công thức tổng gộp mục 2.1 — đặc biệt bậc thưởng grade trên % gộp; (2) quy tắc đếm affiliate mục 2.2; (3) ticket DevOps Atlas allowlist (mục 7.3); (4) số phận trang /affiliate riêng (mục 9). PASS → build B1 ngay.
