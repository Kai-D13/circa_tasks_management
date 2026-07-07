# HANDOFF — Module "Quản lý FS" · Tính năng "Quản lý sản phẩm" (Phase 1)

> Bản plan kỹ thuật + business logic để stakeholder duyệt trước khi build.
> Nguyên tắc: build/test hoàn toàn trên localhost, additive 100% (bảng mới, route mới),
> KHÔNG đụng bất kỳ flow OS nào đang chạy production. Triển khai theo chuẩn module
> KPI/targets/campaigns đã go-live.

---

## 1. Mục tiêu & bối cảnh

- Hệ thống hiện vận hành 26 cửa hàng **OS** (owner store). Bổ sung loại cửa hàng **FS**
  (franchise store) — 3 FS triển khai đầu: FS Nhị Trưng 6 (POS0057) · FS Hòa Bình 2
  (POS0088) · FS Long Tâm (POS1089), region Miền Nam.
- Team **Policy** (department `fd691349-a087-4998-9536-bc20b14b99b2`) cần đẩy danh sách
  sản phẩm cho từng FS chụp ảnh chuẩn e-commerce (nền trắng) + đo kích thước, theo
  **từng phiên xử lý** có theo dõi tiến độ và cơ chế yêu cầu làm lại (resubmit).

## 2. Phân quyền (Phase 1)

| Role | Quyền |
|---|---|
| Super admin | Toàn quyền: tạo/đóng/hủy phiên, import, xem mọi phiên, resubmit, export |
| Admin thuộc dept **Policy** | Như super admin trong phạm vi module FS (mọi thành viên Policy xem/join được phiên của nhau — gate theo phòng ban, không theo người tạo) |
| Store manager của FS | Xem phiên store mình; **tạo account staff cho store mình** |
| Staff của FS | Xem + xử lý phiên của store mình (wizard chụp ảnh/đo kích thước) |
| Mọi role khác (admin thường, staff OS, sm...) | KHÔNG thấy module |

**Cô lập FS ↔ OS:** account thuộc store FS **chỉ thấy module FS** — nav riêng, mọi
route OS (Tasks/Toa thuốc/Doanh số/Tồn kho/Bảng tin) redirect về màn FS. Kiến trúc
gate bằng 1 nhánh `store_type === 'fs'` duy nhất ở layout/nav → sau này stakeholder
muốn mở hệ thống OS cho FS chỉ cần gỡ gate, không rebuild.

## 3. Data model (migration 076 — additive, idempotent)

```
stores               + store_type text NOT NULL DEFAULT 'os' CHECK ('os','fs')
                       (26 store cũ tự động là 'os'; 3 FS insert với 'fs' + is_active=true)

fs_sessions          id · name · store_id→stores · status: draft|active|completed|cancelled
                     created_by→users · claimed_by→users NULL · claimed_at · created_at · closed_at

fs_session_items     id · session_id (CASCADE) · product_id text · product_name text
                     dim_length_mm int · dim_width_mm int · dim_height_mm int   (bắt buộc khi hoàn thành item)
                     status: pending | done | redo   (redo = admin yêu cầu làm lại cả item)
                     processed_by · processed_at · resubmit_note text
                     UNIQUE(session_id, product_id)          ← chặn product_id trùng trong phiên

fs_item_photos       id · item_id (CASCADE) · box_key 1..5 · storage_path (GCS URL)
                     status: ok | redo   · resubmit_note text · updated_at
                     UNIQUE(item_id, box_key)                 ← 1 box = 1 ảnh, GHI ĐÈ bản cuối

fs_import_runs       audit mỗi lần import (mirror kpi_campaign_import_runs)
```

**RLS** (chuẩn repo: SECURITY DEFINER helpers, không cross-table recursion):
- SELECT: super admin OR (role admin AND dept = Policy) OR (staff/store_manager có
  `users.store_id` = store của phiên).
- Mọi WRITE đi qua server actions dùng service role + authz app chặt (pattern đã
  kiểm chứng ở module Toa thuốc/KPI) — không cấp UPDATE/INSERT policy trực tiếp.

**Ngữ nghĩa "chỉ lưu bản cuối"** (yêu cầu quan trọng): DB upsert theo
`UNIQUE(item_id, box_key)` → mỗi box luôn đúng 1 row = bản mới nhất. Ảnh upload lên
GCS với key có suffix version (`fs-products/<session>/<item>/<product_id>_mat_truoc_<uniq>.jpg`)
rồi server **xoá object cũ** trên GCS (hàm deleteObject có sẵn). Không dùng key cố
định để tránh browser/CDN cache ảnh cũ. Kết quả: không history, không rác storage.

## 4. Business logic chi tiết

### 4.1 Import & tạo phiên (Policy/Super — tab "Tạo phiên")
1. Chọn **FS store** (dropdown chỉ `store_type='fs'` + `is_active=true`) + đặt tên phiên.
2. Upload file xlsx/csv. Header bắt buộc: `product_id`, `product_name` (đã đối chiếu
   file mẫu thật `docs/file_sample_FS_process.xlsx`). Không cần pos_code — store đã
   chọn ở bước 1.
3. **File nhiều sheet** (file mẫu thật có 3 sheet theo tên store) → bước preview cho
   **chọn sheet** cần nạp. `product_id` trong Excel là số → hệ thống ép về text an toàn.
4. Preview: tổng dòng hợp lệ / lỗi (thiếu product_id, trùng trong file) → chặn nếu có
   lỗi → Commit: RPC atomic tạo phiên + N items (status pending) + audit run.
5. 1 phiên = 1 store. Cùng 1 danh sách cho 5 FS → import 5 lần (mỗi lần chọn 1 store).

### 4.2 Staff FS xử lý (wizard mobile)
1. Landing account FS = danh sách phiên store mình; phiên mới nổi bật + **badge số
   phiên chờ xử lý** trên nav (server-render mỗi lần điều hướng — không polling).
2. "Bắt đầu xử lý" → **claim phiên** bằng conditional UPDATE (mutex — người thứ hai
   thấy "Phiên đang do <tên> xử lý"): 1 người own 1 phiên, chống duplicate request.
   Policy/super có nút release claim khi cần đổi người.
3. Wizard hiện **lần lượt** item kế tiếp (pending → redo ưu tiên trước):
   - 5 box ảnh: **1-Mặt trước (bắt buộc)** · **2-Mặt sau (bắt buộc)** · 3-Mặt bên ·
     4-Mặt bên · 5-(không tên). Min 2 / max 5 ảnh. Chụp camera trực tiếp
     (capture=environment) hoặc tải ảnh; nén client-side như pipeline hiện tại.
   - Nhập **dài / rộng / cao — BẮT BUỘC, đơn vị mm** + helptext: "Nhập theo mm
     (1cm = 10mm) — vui lòng không nhầm sang cm."
   - "Cập nhật" (lưu item, status → done) → "Tiếp theo" (item kế). Thanh tiến độ 20/50.
4. **Resume:** thoát bất kỳ lúc nào; trạng thái nằm trong DB → hôm sau vào tiếp đúng
   item kế tiếp. Không phụ thuộc thiết bị/browser.
5. Ảnh đặt tên chuẩn: `<product_id>_<box>`: `2005946_mat_truoc`, `2005946_mat_sau`,
   `2005946_mat_ben_1`, `2005946_mat_ben_2`, `2005946_khac`.

### 4.3 Kết quả & Resubmit (Policy/Super — tab "Kết quả")
- List phiên: store · người tạo · người đang xử lý · trạng thái · Tổng items ·
  Đã xử lý · Đang sửa · Còn thiếu · **% nhịp độ**. Nút Hoàn tất/Hủy phiên. Export Excel.
- Vào phiên: bảng items (product_id · product · trạng thái · ảnh · dims · người xử lý)
  + **checkbox chọn 1/nhiều/tất cả**:
  - **Bulk resubmit** (nhiều items): làm lại **CẢ item** + 1 note chung. Kỹ thuật:
    1 câu UPDATE set-based (`WHERE id IN (...)`) — không bắn N request, không tải hạ tầng.
  - **Single item**: mở panel chi tiết → thấy từng box ảnh → **resubmit ĐÚNG box**
    chưa đạt + note lý do riêng. Staff chỉ phải chụp lại box đó.
- **Performance đếm:** item redo vẫn tính "đã xử lý (đang sửa)" — hiển thị tách:
  `Đã xử lý = done + redo` · `Đang sửa = redo` · `Còn thiếu = pending`.

### 4.4 Trạng thái item (máy trạng thái)
```
pending ──(staff Cập nhật đủ ảnh+dims)──► done
done ──(admin resubmit item/box + note)──► redo   [ảnh box bị đánh dấu status=redo]
redo ──(staff upload lại box redo + Cập nhật)──► done  [ghi đè bản cuối]
```

## 5. Hạ tầng & guardrails (yêu cầu tuyệt đối của stakeholder)

- **100% ảnh FS lên Google Cloud Storage** (đã bật `STORAGE_PROVIDER=gcs`, bucket
  `duocsi-circa-vn`). Purpose upload mới `fs_product` là **GCS-only — KHÔNG có
  fallback Supabase**: GCS lỗi → staff thấy lỗi rõ và thử lại, ảnh không bao giờ rơi
  về Supabase storage.
- DB chỉ lưu metadata (đường dẫn, trạng thái, kích thước) — không ảnh hưởng dung
  lượng/băng thông database hiện tại.
- Module 100% additive: 4 bảng mới + route mới `/fs/*`; không sửa bảng/flow OS nào.
- Xử lý nền trắng: **Phase 1 = quy trình chụp trên nền trắng + admin kiểm duyệt qua
  resubmit** (phương án A3 đã chốt). Auto xoá nền bằng AI để Phase 2 (cần thêm
  service/ngân sách riêng — sẽ đề xuất khi stakeholder yêu cầu); cấu trúc lưu ảnh
  đã chừa sẵn chỗ chèn bước xử lý này mà không đổi schema.

## 6. Kế hoạch triển khai (build localhost, commit/push từng batch để audit)

| Batch | Nội dung |
|---|---|
| **F0** | Provisioning QA (chi tiết mục 6.1): insert 3 FS store + 3 account store_manager test |
| **F1** | Migration 076 (store_type + 4 bảng + RLS) + constants (POLICY_DEPT_ID, box labels) |
| **F2** | Import: parser (chọn sheet, ép product_id → text, chặn trùng) + tab "Tạo phiên" + RPC atomic + audit |
| **F3** | Tab "Kết quả": list phiên + bảng items + checkbox bulk resubmit (set-based) + panel item / resubmit từng box + note + đóng/hủy phiên + Export Excel |
| **F4** | Staff FS wizard: claim/release phiên, item tuần tự, 5 box ảnh (GCS-only, đặt tên chuẩn, ghi đè bản cuối + xoá object cũ), dims mm, resume, queue redo |
| **F5** | Cô lập FS: nav/landing riêng cho account FS + guard route OS; store_manager FS tạo account staff (scope store mình) |
| **F6** | Badge phiên chờ + polish mobile + QA tổng (kịch bản dưới) + Playwright spec FS |

### 6.1 F0 — Provisioning QA (chạy khi bắt đầu build, KHÔNG đụng prod)

1. **Insert 3 FS store** (SQL, Supabase QA — sau khi migration 076 thêm cột `store_type`):
```sql
INSERT INTO public.stores (name, code, region, address, is_active, store_type) VALUES
 ('FS Nhị Trưng 6', 'POS0057', 'south', '387 Hai Bà Trưng, Phường Tân Định, Quận 1, TP.HCM', true, 'fs'),
 ('FS Hòa Bình 2',  'POS0088', 'south', '06 Lê Thánh Tông, P. Thành Công, TP. Buôn Ma Thuột, Đắk Lắk', true, 'fs'),
 ('FS Long Tâm',    'POS1089', 'south', 'Gian hàng 01SH06, Tòa T26M-1 (S2.10), Vinhomes Ocean Park, Gia Lâm, Hà Nội', true, 'fs')
ON CONFLICT DO NOTHING;
-- (giá trị cột region khớp enum/label hiện có của hệ thống — xác nhận lúc build)
```
2. **Tạo 3 account store_manager test** — tạo qua Supabase Studio → Authentication →
   Add user (email + mật khẩu do PM cung cấp riêng, không lưu trong tài liệu này):
   - `fs_nhitrung6@circa.com` → store FS Nhị Trưng 6
   - `fs_hoabinh2@circa.com`  → store FS Hòa Bình 2
   - `fs_longtam@circa.com`   → store FS Long Tâm
3. **Gán role + store** (trigger handle_new_user đã tạo row public.users khi add user):
```sql
UPDATE public.users SET role='store_manager', store_id=(SELECT id FROM stores WHERE code='POS0057'), full_name='FS Nhị Trưng 6'
 WHERE email='fs_nhitrung6@circa.com';
-- tương tự POS0088 / POS1089
```

**QA chính:** import file mẫu 3 sheet → 3 phiên cho 3 FS; staff FS claim + xử lý +
thoát giữa chừng + resume; staff store khác không thấy (RLS test trực tiếp); resubmit
1 box → staff chỉ chụp lại box đó, DB chỉ còn bản cuối, GCS không còn object cũ;
bulk resubmit 10 items = 1 UPDATE; account FS không vào được bất kỳ route OS nào;
mọi role OS không thấy module FS; Policy member B thấy phiên do member A tạo.

## 7. Ngoài phạm vi Phase 1 (ghi nhận để không lạc scope)
- Auto xoá nền AI (A1/A2) · Thông báo đẩy Teams/ZNS · FS dùng các module OS ·
  Nhiều người cùng xử lý 1 phiên · Lịch sử phiên bản ảnh (chỉ giữ bản cuối theo yêu cầu).

## 8. Trạng thái chốt thông tin — ĐỦ, sẵn sàng build khi được duyệt
- ✅ 3 FS store: thông tin đầy đủ (mục 6.1) — POS0057 / POS0088 / POS1089, region Miền Nam.
- ✅ 3 account store_manager test: email đã chốt (mục 6.1); mật khẩu PM giữ riêng.
- ✅ File mẫu thật đã đối chiếu (`docs/file_sample_FS_process.xlsx` — 3 sheet, header
  `product_id`/`product_name`, product_id dạng số → hệ thống ép text).
- ✅ Nhãn hiển thị chốt: sidebar **"Quản lý FS" → "Sản phẩm"** (route `/fs/products`),
  tab **"Tạo phiên" / "Kết quả"**.
- ✅ Dimensions dài/rộng/cao (mm) bắt buộc mọi item.

> Sau khi stakeholder duyệt tài liệu này → dev bắt đầu F0→F6 trên localhost,
> commit/push từng batch để audit; KHÔNG deploy production cho tới khi QA + stakeholder
> pass toàn bộ module.

---

## 9. AMENDMENT v2 (2026-07-06) — theo review + Q&A của stakeholder (ĐÃ DUYỆT BUILD)

**Quyết định chốt từ stakeholder:**
- Phase 1 KHÔNG auto xoá nền (chụp nền trắng + duyệt qua resubmit) ✔
- 1 staff xử lý 1 phiên tại 1 thời điểm ✔ · FS store_manager KHÔNG cần quyền release claim (chỉ Policy/super) ✔
- Export = Excel kèm URL ảnh (không ZIP phase 1) ✔ · FS account tuyệt đối chỉ thấy module FS ✔
- Progress: stakeholder giao dev quyết → **chốt theo khuyến nghị review**: `Hoàn thành = done` ·
  `Cần làm lại = redo` · `Chưa xử lý = pending` · **Progress chính = done/total**; metric phụ
  "Đã từng xử lý = done+redo". (Redo KHÔNG tính vào progress chính — tránh 100% ảo.)

**Guardrail P1 bổ sung vào thiết kế:**
1. **Chống leak FS ↔ OS (đưa lên F1, làm TRƯỚC khi insert FS store):** mọi surface OS đang
   query `stores` (tạo/sửa task, import Excel, TRF cron, recurring cron, KPI campaign import,
   KPI targets sync, referral ingest, dropdown filter tasks/prescriptions/users/logs,
   announcements picker) thêm filter `store_type='os'`; module FS chỉ query `store_type='fs'`;
   route guard 2 chiều (FS account không vào OS route, account OS không thấy module FS ngoài
   Policy/super). Trang Danh sách cửa hàng hiển thị badge "FS" (read-only, không phải dropdown).
2. **Upload GCS-only:** purpose mới `fs_product` — GCS lỗi → fail rõ, KHÔNG fallback Supabase;
   authz theo session/item/store; thứ tự an toàn: upload ảnh mới → update DB path →
   **sau khi DB commit** mới delete object cũ; delete fail → ghi vào `fs_item_events`
   (cleanup retry sau), tuyệt đối không làm hỏng dữ liệu mới.
3. **Audit log `fs_item_events`** (bảng thứ 5): ai resubmit (item/box nào, lý do, lúc nào),
   staff upload lại lúc nào, claim/release, đóng/hủy phiên. Không lưu version ảnh (đúng yêu
   cầu chỉ giữ bản cuối) nhưng action history đầy đủ.
4. **Claim stale-warning:** màn Kết quả hiện "đang xử lý bởi X · từ <thời điểm claim>" —
   Policy/super release khi cần (không tự động hết hạn phase 1).
5. **Validation dimensions:** số nguyên mm, >0, ≤3000mm, helptext "1cm = 10mm".
6. **Import sheet:** default chọn sheet có tên khớp/gần giống store đã chọn, user đổi được.

**Thứ tự build cập nhật:** **F1** (migration 076 gồm 5 bảng + store_type + RLS + **OS sweep
chống leak**) → **F0** (provisioning 3 FS store + account — chỉ chạy SAU F1 để không leak
trên QA) → F2 → F3 → F4 → F5 (FS nav/guard + store_manager tạo account) → F6 (QA: leak test
dropdown OS, RLS PostgREST trực tiếp, stress upload, GCS orphan cleanup).

### 9.1 F1 r2 — siết isolation ở SERVER + DB (theo review P1, đã build)
Review chỉ ra: F1 mới chặn leak ở UI/dropdown; server action + DB vẫn có thể nhận
FS store_id nếu request bị craft. Đã bổ sung:
- **`lib/stores/assertOsStore.ts` → `assertOsStoreIds(ids, {requireActive})`**: kiểm tra
  store tồn tại + `store_type='os'` (+ `is_active` nếu bắt buộc). Gọi TRƯỚC mọi OS write:
  `createTask` (bao cả nhánh staff_all), `createBroadcastTask`, `createTaskSchedule`
  (requireActive), `createUser`, `updateUserRole`, `setSmRole`. `createImportedStoreTasks`
  đã an toàn sẵn (map byCode chỉ chứa store OS). Account FS chỉ tạo qua module FS (F5),
  không qua /users generic.
- **DB trigger `ensure_fs_session_store_is_fs()`** (mig 076) — BEFORE INSERT/UPDATE OF
  store_id trên `fs_sessions`: RAISE nếu store không phải FS / không active. Chặn cả khi
  service-role write bị bug (nếu không, OS staff/mgr của store đó đọc được session qua
  `can_read_fs_session`).
- Bổ sung P2: `fs_item_photos` +`uploaded_by`/`content_type`/`size_bytes`; index
  `fs_import_runs(session_id)`, `(store_id, created_at desc)`, `fs_item_events(item_id,
  created_at desc)`. Status phiên chốt **active/completed/cancelled** (bỏ `draft` — import
  tạo phiên active ngay, không có bước nháp). Trang Cửa hàng: badge "FS" chỉ là nhãn
  read-only trên bảng tham chiếu (super/admin/manager, staff bị redirect) — không phải
  dropdown chọn được, giữ nguyên.
