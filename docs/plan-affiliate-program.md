# Kế hoạch v2.1: Chương trình AFFILIATE thay thế "Giới thiệu bạn bè"

Ngày lập: 21/07/2026 (v2.1 — đóng 4 P1 của audit lần 2) · Trạng thái: **F0 ĐÓNG · F1 = DRAFT migration (KHÔNG chạy Supabase) → stakeholder audit migration/RLS theo role matrix → mới chạy** · Manifest mapping: `docs/affiliate-partner-manifest.md` (22 code = 14 os + 1 fs + 7 external, checksum 148 ✓ — v2 ghi "15 OS" là đếm sai).

## 0. Trả lời 7 câu hỏi stakeholder (chốt với PM 21/07)

| # | Câu hỏi | Chốt |
|---|---|---|
| 1 | Doanh thu ghi nhận khi nào? | **Mọi đơn trừ CANCELED** (PM chốt, tái xác nhận 21/07). UI hiển thị breakdown trạng thái để minh bạch. |
| 2 | Field tiền chính thức? | **`total_price`** — LÝ DO: trong Mongo collection `order` **không tồn tại** `deliveredItemTotalPrice` / `finalDeliveryTotalPrice` / `paidAmount` (các field đó chỉ có ở API aggregate nhiều service). `total_price` có mặt trên 148/148 đơn. Sẽ đối chiếu `price` ≡ `total_price` trong lần test VPN cuối. |
| 3 | FAIL_TO_DELIVER loại không? | **Vẫn tính** (user chốt 21/07). Đổi rule sau = 1 hằng số trong lớp normalize. |
| 4 | Admin non-super? | **Giai đoạn này KHÔNG thấy**, nhưng build sẵn cơ chế bật bằng SQL: bảng `affiliate_department_access` — muốn cho phòng **OPS** (id `1b362298-7121-4604-9192-4a9ca2bb545f`) thấy thì `INSERT` 1 row, không cần deploy. |
| 5 | PII? | **Tên khách + SĐT đầy đủ** (user chốt). Theo khuyến nghị audit: **KHÔNG pull/lưu** `admin_note`, `system_note`, thông tin thanh toán, **địa chỉ đầy đủ** — UI chỉ cần tên + SĐT. |
| 6 | SM/QLCH mobile? | Giai đoạn này: **desktop sidebar** (đúng lời stakeholder "khi login web browser"). Mobile drawer "Thêm" = enhancement sau, không chặn. |
| 7 | 1 store nhiều code? | **Hỗ trợ sẵn**: bảng mapping riêng, `partner_code` unique, `store_id` lặp được → N code → 1 store. |

## 1. Data contract (số liệu THẬT từ Mongo, khảo sát 21/07 — trả lời P1-1)

- DB `circa-online_prd_order` · collection `order` (~21k docs) · field **snake_case** (camelCase chỉ ở API layer).
- **Marker affiliate** = `affiliate_partner_code` non-empty (148 đơn; tag `AFFILIATE_FS` chỉ phủ 108 — 40 đơn cũ 16/06–15/07 thiếu tag hoặc tag `AFFILIATE_HOTEL`).
- **Trạng thái nghiệp vụ = field top-level `status`.** Distinct THỰC TẾ trên 148 đơn: `CANCELED` (40) · `DELIVERED` (102) · `WAIT_FOR_PURCHASE` (2) · `DELIVERING` (1) · `FAIL_TO_DELIVER` (2) · `PROCESSING` (1); phiên khảo sát trước còn gặp `WAIT_FOR_PAYMENT` → known-set = **7 giá trị**.
- `sale_order_status` (distinct: NEW/PROCESSING/WAIT_TO_DELIVER/WAIT_FOR_PURCHASE/DELIVERING/DELIVERED/FAIL_TO_DELIVER/CANCELED/null×29) = trạng thái lớp giao vận — **lưu tham khảo, không dùng đếm**.
- `payment_status` **KHÔNG tồn tại** trong collection — loại khỏi mọi thiết kế.
- **Lớp normalize (chống trạng thái lạ làm hỏng cron/UI):** lưu `raw_status` nguyên văn + `status_norm` map từ known-set; **giá trị mới chưa biết → `other`** (cron vẫn chạy, UI badge neutral, sync_run ghi cảnh báo) — không bao giờ fail vì status mới.
- `created_time`/`last_updated_time` = BSON Date chuẩn; `order_id` Number (khóa upsert); `total_price` Number (148/148 có).

## 2. Kiến trúc (theo đề xuất audit)

```
MongoDB Circa Online (VPN/private — prod cần Atlas allowlist IP server)
   │  cron server-only · projection tối thiểu · KHÔNG pull note/payment/địa-chỉ-đầy-đủ
   ▼
Supabase: affiliate_orders ←resolve─ affiliate_partner_mappings
          affiliate_sync_runs (audit)      affiliate_department_access (bật admin-dept bằng SQL)
   │  RLS store/SM/super (+dept OPS khi bật)
   ▼
/affiliate (desktop super·SM·QLCH) + AffiliateOrdersCard trong /targets (staff OS mobile)
```

**Migration `090_affiliate_program.sql`** (đã verify 089 là số cuối; idempotent, app_migrations, pg_safeupdate-safe) — 4 bảng, KHÔNG đụng `stores` (bỏ phương án cột trực tiếp theo audit P1-4):

1. `affiliate_partner_mappings`: `partner_code text PK`, `store_id uuid NULL FK stores`, `partner_type text`, `display_name text`, `is_active bool DEFAULT true`, `mapped_by uuid`, `mapped_at timestamptz DEFAULT now()`. **Seed ngay trong migration** (mapping đã chốt — xem §4). RLS: SELECT super; write qua service role/SQL (UI quản lý = phase sau).
2. `affiliate_orders`: `order_id bigint UNIQUE NOT NULL` (source id), `order_code`, `pos_order_code`, `partner_code text NOT NULL`, `store_id uuid NULL FK` (resolve lúc sync; NULL = đối tác ngoài), `raw_status text NOT NULL`, `status_norm text NOT NULL`, `sale_order_status text`, `total_price numeric NOT NULL DEFAULT 0`, `total_item int`, `first_product_name text`, `customer_name text`, `customer_phone text`, `created_time timestamptz NOT NULL`, `confirmed_time`, `last_updated_time`, `synced_at`. Index: UNIQUE(order_id) · (store_id, created_time DESC) · (partner_code, created_time DESC) · (raw_status).
3. `affiliate_sync_runs`: started/finished_at, status running|success|failed, pulled, upserted, unmatched_codes jsonb, unknown_statuses jsonb, error text (rút gọn). SELECT super.
4. `affiliate_department_access`: `department_id uuid PK` — rỗng lúc đầu; INSERT row OPS khi muốn bật admin-dept.

**RLS `affiliate_orders`** (SELECT-only; authenticated KHÔNG có INSERT/UPDATE/DELETE — write = service role; CẢ 4 BẢNG đều ENABLE RLS; helpers SECURITY DEFINER một chiều, không recursion). **Ma trận enforce (P1 audit lần 2 — FS + external CHỈ super):**

| Nhánh | Điều kiện policy |
|---|---|
| Super admin | `is_super_admin()` — thấy tất cả gồm FS + external (store_id NULL) |
| Admin dept được cấp | `get_user_role()='admin' AND is_affiliate_dept_admin() AND store_id IS NOT NULL AND is_os_store(store_id)` — CHỈ mapped OS, không FS/external |
| SM | `get_user_role()='sm' AND is_sm_for_store(store_id) AND is_os_store(store_id)` |
| Staff / QLCH | `get_user_role() IN ('staff','store_manager') AND store_id = get_user_store_id() AND is_os_store(store_id)` — Staff FS bị chặn ngay tại DB (store của họ không phải OS), không cần helper mới |

- **Tái dùng `is_os_store(uuid)`** (migration 085, SECDEF, đã GRANT authenticated) — không tạo helper FS mới.
- `is_affiliate_dept_admin()` = helper SECDEF mới đọc `affiliate_department_access` (một chiều, bảng lá không tham chiếu ngược).
- `affiliate_department_access`: ENABLE RLS, SELECT super-only, không write policy (INSERT bằng SQL/service role).
- `affiliate_partner_mappings` + `affiliate_sync_runs`: ENABLE RLS, SELECT super-only.
- SQL verify per-role matrix kèm cuối migration (QA Gate F1 của stakeholder).

## 3. Đồng bộ (giải P1-3 bằng thiết kế phù hợp khối lượng thật)

Khối lượng thật: **148 đơn affiliate tổng** (105/30 ngày), projection ~18 field nhẹ. Vì vậy:

- **Mỗi lần cron (2h/lần) pull TOÀN BỘ subset affiliate** (filter `affiliate_partner_code` non-empty, KHÔNG cửa sổ thời gian) → upsert theo `order_id` (batch 500). Lần chạy đầu = initial backfill; mỗi lần chạy = full reconciliation — **mọi đơn cũ đổi trạng thái (kể cả >30 ngày) đều được cập nhật vĩnh viễn**, không cần overlap/daily-job riêng. Đơn giản hơn incremental mà giải trọn mối lo bỏ sót.
- **Ngưỡng tăng trưởng**: subset > 3.000 → cron log cảnh báo + ghi vào sync_run (tín hiệu tạo ticket chuyển incremental theo `last_updated_time`). Giai đoạn này KHÔNG build incremental — chỉ cảnh báo (P2 audit: đừng hứa auto-switch khi chưa build). Với ~100 đơn/tháng, còn ~4 năm mới chạm.
- **Lock race-safe (P1 audit lần 2)**: RPC atomic `rpc_start_affiliate_sync()` (SECDEF, service_role) — trong 1 transaction: đóng run `running` quá 15 phút thành `failed('stale')` → INSERT run mới; **partial UNIQUE index `WHERE status='running'`** bảo đảm tối đa 1 run đang chạy ở tầng DB — request thứ hai dính unique_violation → RPC trả NULL → route trả 409. Không còn cửa sổ SELECT-rồi-INSERT.
- **Đơn biến mất khỏi nguồn (order bị xóa / partner_code bị clear)**: cột `last_seen_run_id` + `source_active` trên affiliate_orders. SAU khi cursor Mongo chạy trọn thành công VÀ pulled ≥ safety floor (≥ 50% số đơn active hiện có — chống mass-deactivate do pull hụt): đánh dấu `source_active=false` cho row không thuộc run này. **KHÔNG hard-delete**; số liệu/UI chỉ tính `source_active=true`.
- **Không replace-all**; upsert idempotent; unmatched partner_code + unknown status ghi vào run làm canary.
- Mongo client: singleton pool (globalThis, tránh leak hot-reload), `serverSelectionTimeoutMS` ngắn, **chỉ gọi từ cron/server — UI không bao giờ query Mongo trực tiếp** (đúng P2).
- Test cases: Mongo timeout → run failed + 502, không đổ vỡ trang; status lạ → `other` + cảnh báo; partner_code mới → unmatched, không rơi đơn.

## 4. Mapping seed (chốt 21/07 — CIRCA-ELARA đã QA tay đơn DH023275/DHC01024385 → **CIRCA ELANA** ✓)

- **15 code map store OS**: AKARI, BEVERLY, CELADON, CENTRAL, ECOGREEN→ECO GREEN, **ELARA→ELANA**, FLORITA, LUMINA, MEDLY, MIRA, PHARMAONE→PHARMA ONE, SUNRISE, SYMPHONY, TAMVIET→TAM VIET (+ theo tên POS trong bảng stores).
- **1 code map store FS**: HOABINH2 → FS Hòa Bình 2 (chỉ super xem; staff FS chưa triển khai — đã chặn ở RLS).
- **7 code đối tác ngoài, store_id NULL** (`display_name` để super đọc được): CIRCA-ONG-CHU-5 (74 đơn — nhiều nhất hệ thống), CIRCA-MYHANH (10), NT-NGOC-VY (16), HOTEL-DN-LDH (5), CIRCA-YENMAI-TAYNINH, NT THIÊN, NT-BAO-TRAN.
- **Seed theo `stores.code`** (POS0009…, KHÔNG theo tên — tên đổi được/dễ lệch dấu) từ manifest `docs/affiliate-partner-manifest.md`; migration `RAISE EXCEPTION` nếu code không tồn tại hoặc `store_type` không khớp `mapping_type`; verify tổng mapping = 22.

## 5. Feature flags & tắt Referral (tách 2 flag độc lập — đúng P2)

- `REFERRAL_ENABLED` (**default false** = tắt referral ngay khi deploy) · `AFFILIATE_ENABLED` (**default false** — bật sau khi backfill + đối soát xong). Hai flag độc lập: tắt Affiliate KHÔNG tự bật lại Referral.
- `/gioi-thieu`: redirect theo role + flag — super khi REFERRAL_ENABLED=true → trang cũ; ngược lại super/SM/QLCH → `/affiliate` (nếu bật) hoặc `/tasks`; staff → `/targets`.
- `/targets` staff: REFERRAL_ENABLED ? ReferralCard : AFFILIATE_ENABLED ? AffiliateOrdersCard : không render gì.
- Sidebar: item cũ "Giới thiệu" gate REFERRAL_ENABLED (thực tế = biến mất); item mới "Affiliate" `/affiliate` roles super+SM+QLCH gate AFFILIATE_ENABLED (flag qua layout prop như KPI, không NEXT_PUBLIC).
- **Referral tắt Ở MỌI ENTRY POINT (P1 audit lần 2)**, không chỉ UI: cron `pull-referrals` check `REFERRAL_ENABLED` → 503 "Referral disabled"; action `uploadReferralReport` từ chối TRƯỚC khi đọc file. Bảng `staff_referrals` + data + parser giữ nguyên; user tắt thêm Scheduled Task trên Coolify (phòng thủ kép).

## 6. UI (không đổi so v1, bổ sung state)

- **Staff OS mobile** (thế chỗ ReferralCard trong /targets): card "Đơn hàng Affiliate" — 4 ô (Đơn/Doanh thu tháng này + hôm nay, loại đơn hủy) → ~10 đơn gần nhất (mã DH, ngày giờ, tên khách, SĐT, giá trị, badge trạng thái: Đã giao=success, Đang giao=info, Chờ thanh toán/Chờ xử lý/Đang xử lý=warning, Giao thất bại=danger, Đã hủy=neutral, khác=neutral) → footer "Không tính đơn hủy · Cập nhật {synced_at}".
- **Desktop `/affiliate`**: super = bảng mọi store + nhóm "Đối tác ngoài" (Đơn tháng · Doanh thu tháng · Đơn hủy · Cập nhật) → click store xem danh sách đơn **phân trang server-side** (không tải hết rồi lọc client — đúng P2); SM = store pills; QLCH = thẳng store mình.
- Đủ light/dark, loading/error/empty + **stale-sync state** (lần sync cuối > 4h → cảnh báo "dữ liệu có thể chưa mới"); theo design system đã merge. Nhãn số liệu dùng **"Doanh số Affiliate ghi nhận"** (vì FAIL_TO_DELIVER vẫn tính — tránh đọc nhầm thành doanh thu thực thu). `/affiliate` guard flag + role Ở SERVER (redirect), không chỉ ẩn nav.

## 7. Nhánh & thứ tự build (đúng P2 — không xây trên feat/ui-wave-a)

- **F0 (xong khi doc này được duyệt)**: data contract §1 + 7 câu trả lời §0. **Hoàn thành/merge Wave A trước**: stakeholder QA A3 `/logs` + `/targets` T1/T2 qua URL localhost → merge `feat/ui-wave-a` vào main (A4 `/dashboard` dời sau Affiliate). Dep `mongodb` đang uncommitted trong worktree — sẽ commit trên nhánh affiliate, KHÔNG commit vào wave-a.
- **F1**: nhánh mới `feat/affiliate-program` — **chỉ DRAFT migration 090 + SQL verify, KHÔNG chạy trên Supabase** cho tới khi stakeholder audit migration/RLS theo role matrix. Kèm: 2 flags + gate referral entry points + **pin Node EXACT tag đã kiểm chứng `node:22.17.1-alpine`** (không dùng tag nổi; driver mongodb 7.5 cần ≥20.19, Node 20 đã EOL 04/2026) + commit dep mongodb tại nhánh này (KHÔNG vào wave-a). Nhánh tạo từ main hiện tại để không chặn tiến độ; **trước F3 (UI đụng /targets) phải merge main-mới (chứa wave-a) vào nhánh**.
- **F2**: `lib/affiliate/` (mongo singleton, normalize, flags) + cron `pull-affiliate-orders` + test lỗi. Dev offline bằng fixture 148 đơn; test cron thật khi user bật VPN.
- **F3**: UI (/affiliate + AffiliateOrdersCard + sidebar) — gửi URL localhost QA.
- **F4**: tắt Referral (flag + redirect + bỏ render).
- **F5 rollout**: deploy code + migration với **AFFILIATE_ENABLED=false** → chạy backfill → **đối soát Mongo↔Supabase theo store/status/doanh thu** → bật flag → smoke role matrix. Rollback = tắt flag (referral vẫn ẩn).

## 8. Deploy checklist (user/DevOps)

1. DevOps: Atlas Network Access allowlist **IP server Coolify** trên chuỗi PUBLIC `circa-online.ge5yfl.mongodb.net` (chuỗi `-pri` là private endpoint 172.16.x — chỉ VPN/VPC dùng được). Điều kiện bắt buộc để cron prod chạy.
2. Chạy migration 090 trên prod.
3. Env: `MONGODB_AFFILIATE_URI` (chuỗi public), `REFERRAL_ENABLED=false`, `AFFILIATE_ENABLED=false` (bật sau đối soát).
4. Coolify task `pull-affiliate-orders` `0 */2 * * *` Bearer CRON_SECRET; chạy tay backfill + verify; TẮT task `pull-referrals`.
5. Đối soát xong → `AFFILIATE_ENABLED=true` + restart → QA role matrix trên prod.
