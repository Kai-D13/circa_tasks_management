-- ============================================================================
-- 127_cms_t11_flat_amounts.sql  (r0 — CMS đơn giản S0, Dev 08/11/2026; CHƯA audit PM, CHƯA commit, KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-127.mjs từ webapp/scripts/cms-127/fwd.sql + pin.json (ghim chương trình / 17 SP / 51 bậc cũ /
-- 17 mức mới) + md5 thân 6 hàm guard lấy từ file migration nguồn. KHÔNG sửa tay — `node scripts/gen-cms-127.mjs --check`.
-- Số 127 = PM dành 08/11 (khối Hiện trạng sống STATE), nền 126. Spec: planning/research/cms-simple-program-spec-implementation-2026-11-08.md §3.
--
-- Mục đích (quyết định operator 08/11, PM spec r1 §1): sửa dữ liệu cấu hình ĐÚNG MỘT chương trình thật — T11 942194ce-893f-4f62-a88a-bd9efa464bae —
-- từ 17 SP × 3 bậc (1–9 @15.000 · 10–19 @20.000 · từ 20 @25.000) sang 17 SP × 1 bậc {thứ tự 1, từ 1, KHÔNG giới hạn, mức =
-- "CMS proposal" VND / hộp}. Nguồn mức: workbook 4faf2c4ccd7071420293bff8a1520f5e25983482864d45c43c8573f27c62d263 (17 mức ghim trong pin.json, md5 bảng mức 29a0464bd08e27fb95440415209c4b2a).
-- Công thức không đổi: Q = floor(Σ base_quantity / K), CMS = Q × mức (engine lũy tiến 1 bậc mở).
--
-- Giữ NGUYÊN: 17 dòng cms_program_products (id / ProductID / K / đơn vị / tư vấn / tên / ảnh / giá / import_run_id), ngày, phạm vi
-- 25 nhà thuốc, is_test, mọi hàm / trigger / ACL / bảng, run / kết quả / dòng bán / sổ chứng nhận / payout cũ, chương trình khác + QA.
-- Đổi (cùng một transaction): xoá 51 bậc cũ → ghi 17 bậc mới; cms_programs.config_version + 1 ĐÚNG một lần; current_result_run_id
-- = NULL (guard 122 trả sớm khi pointer không đổi ⇒ chỉ tăng version KHÔNG đủ — UI sẽ ở config_pending, vẫn đọc tiền cũ). Trigger
-- pointer 122 (cms_programs_result_guard) tắt TẠM đúng quanh MỘT câu UPDATE rồi bật lại đúng chế độ origin 'O' (mẫu 125 §3); đang giữ
-- EXCLUSIVE bảng chương trình từ đầu ⇒ không phiên nào ghi xen. Không DISABLE ALL, không session_replication_role, không thay thân guard.
-- Sau COMMIT: app hiện "Chưa có số liệu sau thay đổi cấu hình" (state config_reset) tới khi tính lại; run cũ không còn hiện hành
-- (export run cũ bị chặn bởi guard run hiện hành; publish run mở trước đó ⇒ CONFIG_CHANGED).
--
-- Dừng (fail-closed, không đổi gì): thiếu 126 / đã có 127 / có số > 126; không READ COMMITTED; role không phải owner bảng & hàm CMS;
-- thân 6 hàm guard / chế độ trigger pointer lệch bản duyệt; còn run bán 'running'; chương trình khác bản ghim (trạng thái / kỳ /
-- phạm vi / config_version / 17 SP / 51 bậc / 25 nhà thuốc); có payout / đã chốt. Lệch ghim ⇒ chụp PRE mới, cập nhật pin.json, sinh lại.
--
-- Client: Supabase Studio SQL editor / pg-meta (một transaction, lỗi ⇒ huỷ cả). KHÔNG chạy bằng client tự savepoint từng câu (psql
-- \set ON_ERROR_ROLLBACK on, chế độ "rollback on error" của IDE) — cờ giai đoạn cms127.stage vẫn chặn ghi, nhưng đừng thử.
-- Vận hành (operator, sau PM audit + lệnh riêng): cửa sổ ngắn operator chọn, task CMS sales tạm dừng + không chạy CLI ghi, không run
-- 'running' → PRE chỉ đọc (ảnh cấu hình + `cms-verify acl-snapshot`) → DÁN NGUYÊN FILE (giữ LF) bằng ĐÚNG role owner (như 121–126),
-- READ COMMITTED → POST `node scripts/cms-verify.mjs post --phase=127 --pre=<PRE>` → tính lại NGAY (dry-run ×2 + oracle độc lập,
-- rồi một lượt ghi thật được operator cho phép) → đối chiếu DB / UI / XLSX cùng run mới → mới bật lại hiển thị / cron.
-- ROLLBACK (chỉ khẩn, operator + PM duyệt — trả về mức đã bị thay thế nghiệp vụ): rollback/127_cms_t11_flat_amounts_rollback.sql —
-- khôi phục 51 bậc ghim, config_version TĂNG tiếp, pointer NULL, xoá marker 127 (DELETE FROM app_migrations WHERE version = '127');
-- không giảm version, không khôi phục pointer cũ, không xoá run.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
-- Khoá TRƯỚC preflight, CÙNG CHIỀU RPC 122–124 (chương trình → run; db-reviewer 127 P2-1 — không nâng khoá giữa chừng; bận ⇒ hết
-- lock_timeout, rollback sạch, 0 delta; deadlock với RPC đang giữ dòng chương trình rồi ghi run không còn đường xảy ra):
--   · cms_programs EXCLUSIVE ⇒ chặn SELECT … FOR UPDATE / FOR SHARE mới của RPC 121–126 (đủ mức cho DISABLE / ENABLE TRIGGER);
--   · cms_sync_runs SHARE ⇒ không mở / stage / publish run mới;
--   · cms_program_products / cms_program_tiers SHARE ROW EXCLUSIVE ⇒ không ghi cấu hình xen giữa;
--   · cms_program_stores / cms_payouts SHARE ⇒ phạm vi và payout đứng yên trong lúc kiểm.
LOCK TABLE public.cms_programs IN EXCLUSIVE MODE;
LOCK TABLE public.cms_sync_runs IN SHARE MODE;
LOCK TABLE public.cms_program_products, public.cms_program_tiers IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.cms_program_stores, public.cms_payouts IN SHARE MODE;

-- Bản ghim (pin.json) — bảng tạm của transaction, tự huỷ khi COMMIT / ROLLBACK.
CREATE TEMP TABLE cms127_pin (
  id                uuid    PRIMARY KEY,
  product_id        text    NOT NULL UNIQUE,
  unit_cms          text    NOT NULL,
  base_quantity_cms numeric NOT NULL,
  advice_md5        text    NOT NULL,
  name_md5          text    NOT NULL,
  image_md5         text    NOT NULL,
  price_snapshot    numeric,
  import_run_id     uuid,
  added_after_start boolean NOT NULL,
  new_amount        bigint  NOT NULL CHECK (new_amount > 0)
) ON COMMIT DROP;
INSERT INTO cms127_pin (id, product_id, unit_cms, base_quantity_cms, advice_md5, name_md5, image_md5, price_snapshot, import_run_id,
                        added_after_start, new_amount) VALUES
  ('c702ea89-c435-4755-885c-a91ba8cf2b67', '10953', 'hộp', 20, 'e52898c35948bc8d6f6b66546d3ce2bd', '41ceb0aedae65cf93bcca43b5f6f1f1f', '87c9e7b35976c232371286c7d7aa42fc', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 25000),
  ('191358c6-5b13-4794-98be-22e99d14de69', '156227', 'hộp', 30, 'e947c6d48a2767f27eaeec74ecdbaed3', '93b6b7dd1875475c782aeca238db3bb9', '395cb002889ef4661534e0bdafecd307', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 24525),
  ('99dfb459-ab85-4367-b1cb-58735f7558b4', '156600', 'hộp', 60, 'd70428b2d18f068f7a94ef48cb563eb3', 'c96a3158f853f96a599fc96ade62c6a5', 'dc5949d6049bda536aa3e6ee08cdd183', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 24750),
  ('6a012950-b734-465c-a08f-5f3b6ac7af6e', '15827', 'hộp', 90, '59533a06705e2f0f16be6d35947ba55f', 'cdad8de2e61d06c9fe7ebf4642b630b8', '588b8652f63124d46031fef15b21cc63', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 25000),
  ('3386bc7c-2229-492e-870d-3636af88b2b9', '15831', 'hộp', 30, 'f50bdc30e4196507c5d5f73047d5f1cd', 'e685dc09a2063e163180886c332fcd25', 'aba451563b29ad770ce0719d5207e0c7', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 42800),
  ('e20d7f37-9f10-4c9d-994e-eaaeb93025d7', '2004759', 'hộp', 120, 'eb805257af7cd1cfa7ed7af4bb935ffe', 'bcf663bdf6e5a03bcff8e65e71a7fca8', '45accf6ff7d8cb92c52d655b524452da', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 29700),
  ('cd83f6b8-6806-4a14-a445-3910c6764fc5', '2004764', 'hộp', 10, '6181d7e64a7e1a61bb86ab17b4b92cf6', 'bb7880ef0645b1b848b2348b40f13d97', 'ba168ab5d7fa656a865529ced3ca1a08', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 58455),
  ('f22c63fa-5f4a-4c4d-898d-05e8f5c2886b', '2004846', 'hộp', 60, 'ba401182f0975a3706b044d9c9fe99a0', '45f5789f3e4ffcdbfc9c98dee017a27c', '1f111acfc1229dc9ee419806d7012f4b', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 16965),
  ('a467a666-0edc-434c-b41c-6ccf6a5b727b', '2005071', 'hộp', 20, '8ec03ad85666206c5e76ed613259919e', 'eee9fcf7b066a8864a7d077c61d26e50', 'a300908015c22919d8078afa9056a669', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 24115),
  ('2587db41-664a-4562-9e85-3f1106a0c4d3', '2013846', 'hộp', 20, 'e0cc45c794e7167a8c1dd2a006ebd3f4', '8547187f8f7c590bfa8075a5338a8e19', 'f026e00755acd78d08f9a5674112395b', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 25000),
  ('9c82ab27-981c-4b54-afe3-c684a290b776', '2014494', 'hộp', 20, '4fbf7a8968dd57dca260effd9a29d395', '990807b451ef9ecf3a6cb0c27c6026b6', '5e019a53f8105ed35fdf0c6432f65a09', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 31410),
  ('fa90f5ea-950f-4311-9a0c-5a9df421f222', '208259', 'hộp', 180, 'c9407b074ba7d55c45e8d21c21f72294', '9639a31cbf595d3bcd54b0fc92b15a1f', '85ffdc7b04a4fb3e0411ff3257196d83', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 33255),
  ('fcd2ad1a-f70d-496d-8871-0e891b41e68b', '220789', 'hộp', 30, 'e5abc210d7fc38f21f4ca9ba7d42d6e4', '2ba2c5234f3e8e0e2f82bb5083405d44', 'c442f7f6c0b5750900a1ee49f086106a', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 18000),
  ('e3329b29-01e7-401f-a5b0-26b8e3186f28', '77655', 'hộp', 30, '90d9a654f4f32e10e6ece4b569a82c32', '8e109b5dcc96d0b51a274caa97def942', '17bf0567c057acfe24e5e3881612cea7', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 39650),
  ('f66dbfc7-ee72-46a1-ad00-d0ea134719ae', '88807', 'hộp', 30, 'ca6b634fd7f05a601ff88990beb91fa6', '2dece52f34523700310e8c801d695ce3', '15bc43d6b66e4cdba156a28b4a710bcc', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 18000),
  ('4cb4036b-0319-421a-a418-c166692bd321', '88808', 'hộp', 20, 'c7ff96a15f7f4eb461cf23118bf68bec', '7cd1c7ebcfdf1a536f0c661334d889f7', '2d5bfef86980ec20c5bff678eab708d4', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 30000),
  ('a2e22e5a-5749-45a0-b94c-466e3be88fcb', '88974', 'hộp', 30, 'fe2df9743e013aa456c5ad7b4e2a9b97', '09953d0f91ae8a07ae7e990140dbb04e', 'a3a914442ce06c12b8b31e935ddd87b5', NULL, 'eed59e09-5472-421c-a411-2a95d7c163b2', false, 30600);
CREATE TEMP TABLE cms127_old_tiers (
  program_product_id uuid    NOT NULL,
  tier_order         integer NOT NULL,
  qty_from           integer NOT NULL,
  qty_to             integer,
  amount_per_unit    bigint  NOT NULL,
  PRIMARY KEY (program_product_id, tier_order)
) ON COMMIT DROP;
INSERT INTO cms127_old_tiers (program_product_id, tier_order, qty_from, qty_to, amount_per_unit) VALUES
  ('c702ea89-c435-4755-885c-a91ba8cf2b67', 1, 1, 9, 15000),
  ('c702ea89-c435-4755-885c-a91ba8cf2b67', 2, 10, 19, 20000),
  ('c702ea89-c435-4755-885c-a91ba8cf2b67', 3, 20, NULL, 25000),
  ('191358c6-5b13-4794-98be-22e99d14de69', 1, 1, 9, 15000),
  ('191358c6-5b13-4794-98be-22e99d14de69', 2, 10, 19, 20000),
  ('191358c6-5b13-4794-98be-22e99d14de69', 3, 20, NULL, 25000),
  ('99dfb459-ab85-4367-b1cb-58735f7558b4', 1, 1, 9, 15000),
  ('99dfb459-ab85-4367-b1cb-58735f7558b4', 2, 10, 19, 20000),
  ('99dfb459-ab85-4367-b1cb-58735f7558b4', 3, 20, NULL, 25000),
  ('6a012950-b734-465c-a08f-5f3b6ac7af6e', 1, 1, 9, 15000),
  ('6a012950-b734-465c-a08f-5f3b6ac7af6e', 2, 10, 19, 20000),
  ('6a012950-b734-465c-a08f-5f3b6ac7af6e', 3, 20, NULL, 25000),
  ('3386bc7c-2229-492e-870d-3636af88b2b9', 1, 1, 9, 15000),
  ('3386bc7c-2229-492e-870d-3636af88b2b9', 2, 10, 19, 20000),
  ('3386bc7c-2229-492e-870d-3636af88b2b9', 3, 20, NULL, 25000),
  ('e20d7f37-9f10-4c9d-994e-eaaeb93025d7', 1, 1, 9, 15000),
  ('e20d7f37-9f10-4c9d-994e-eaaeb93025d7', 2, 10, 19, 20000),
  ('e20d7f37-9f10-4c9d-994e-eaaeb93025d7', 3, 20, NULL, 25000),
  ('cd83f6b8-6806-4a14-a445-3910c6764fc5', 1, 1, 9, 15000),
  ('cd83f6b8-6806-4a14-a445-3910c6764fc5', 2, 10, 19, 20000),
  ('cd83f6b8-6806-4a14-a445-3910c6764fc5', 3, 20, NULL, 25000),
  ('f22c63fa-5f4a-4c4d-898d-05e8f5c2886b', 1, 1, 9, 15000),
  ('f22c63fa-5f4a-4c4d-898d-05e8f5c2886b', 2, 10, 19, 20000),
  ('f22c63fa-5f4a-4c4d-898d-05e8f5c2886b', 3, 20, NULL, 25000),
  ('a467a666-0edc-434c-b41c-6ccf6a5b727b', 1, 1, 9, 15000),
  ('a467a666-0edc-434c-b41c-6ccf6a5b727b', 2, 10, 19, 20000),
  ('a467a666-0edc-434c-b41c-6ccf6a5b727b', 3, 20, NULL, 25000),
  ('2587db41-664a-4562-9e85-3f1106a0c4d3', 1, 1, 9, 15000),
  ('2587db41-664a-4562-9e85-3f1106a0c4d3', 2, 10, 19, 20000),
  ('2587db41-664a-4562-9e85-3f1106a0c4d3', 3, 20, NULL, 25000),
  ('9c82ab27-981c-4b54-afe3-c684a290b776', 1, 1, 9, 15000),
  ('9c82ab27-981c-4b54-afe3-c684a290b776', 2, 10, 19, 20000),
  ('9c82ab27-981c-4b54-afe3-c684a290b776', 3, 20, NULL, 25000),
  ('fa90f5ea-950f-4311-9a0c-5a9df421f222', 1, 1, 9, 15000),
  ('fa90f5ea-950f-4311-9a0c-5a9df421f222', 2, 10, 19, 20000),
  ('fa90f5ea-950f-4311-9a0c-5a9df421f222', 3, 20, NULL, 25000),
  ('fcd2ad1a-f70d-496d-8871-0e891b41e68b', 1, 1, 9, 15000),
  ('fcd2ad1a-f70d-496d-8871-0e891b41e68b', 2, 10, 19, 20000),
  ('fcd2ad1a-f70d-496d-8871-0e891b41e68b', 3, 20, NULL, 25000),
  ('e3329b29-01e7-401f-a5b0-26b8e3186f28', 1, 1, 9, 15000),
  ('e3329b29-01e7-401f-a5b0-26b8e3186f28', 2, 10, 19, 20000),
  ('e3329b29-01e7-401f-a5b0-26b8e3186f28', 3, 20, NULL, 25000),
  ('f66dbfc7-ee72-46a1-ad00-d0ea134719ae', 1, 1, 9, 15000),
  ('f66dbfc7-ee72-46a1-ad00-d0ea134719ae', 2, 10, 19, 20000),
  ('f66dbfc7-ee72-46a1-ad00-d0ea134719ae', 3, 20, NULL, 25000),
  ('4cb4036b-0319-421a-a418-c166692bd321', 1, 1, 9, 15000),
  ('4cb4036b-0319-421a-a418-c166692bd321', 2, 10, 19, 20000),
  ('4cb4036b-0319-421a-a418-c166692bd321', 3, 20, NULL, 25000),
  ('a2e22e5a-5749-45a0-b94c-466e3be88fcb', 1, 1, 9, 15000),
  ('a2e22e5a-5749-45a0-b94c-466e3be88fcb', 2, 10, 19, 20000),
  ('a2e22e5a-5749-45a0-b94c-466e3be88fcb', 3, 20, NULL, 25000);

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_name text;
  g      public.cms_programs%ROWTYPE;
  v_n    integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '127: cần READ COMMITTED';
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '126';
  IF v_name IS DISTINCT FROM 'cms_sales_only_results_release' THEN
    RAISE EXCEPTION '127: thiếu migration nền 126 cms_sales_only_results_release (name = %)', v_name;
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '127';
  IF FOUND THEN
    RAISE EXCEPTION '127: đã có marker 127 (name = %) — không chạy lại / không chạy chồng', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 126) THEN
    RAISE EXCEPTION '127: DB đã có migration số > 126 — dừng';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION '127: role chạy migration (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  -- Guard chỉ-owner 123 (cms__config_auth_guard) KHÔNG miễn superuser ⇒ chạy bằng ĐÚNG owner bảng / hàm CMS.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_programs'::regclass, 'public.cms_program_products'::regclass,
                              'public.cms_program_tiers'::regclass, 'public.cms_sync_runs'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '127: owner bảng / hàm CMS khác role chạy (%)', current_user;
  END IF;
  -- Trigger pointer 122 sắp tắt tạm: đúng 1 trigger, đúng hàm, chế độ origin ('O') như 122 tạo.
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_result_guard' AND t.tgenabled = 'O'
         AND t.tgfoid = 'public.cms__programs_result_guard()'::regprocedure) <> 1 THEN
    RAISE EXCEPTION '127: trigger pointer cms_programs_result_guard không đúng dạng 122 (tên / hàm / chế độ origin)';
  END IF;
  -- 15 trigger không nội bộ trên 4 bảng cấu hình: đúng tên / chế độ / hàm như 120–126 (O = origin, A = ALWAYS) — mọi trigger chạy trên
  -- câu ghi của 127 phải đang BẬT đúng chế độ (vân tay trước / sau chỉ chứng minh 127 không đổi, không chứng minh trạng thái nền đúng).
  IF (SELECT string_agg(c.relname || '.' || t.tgname || '=' || t.tgenabled::text || ':' || p.proname, ' | ' ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C")
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
       WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
         AND c.relname IN ('cms_programs', 'cms_program_products', 'cms_program_tiers', 'cms_program_stores'))
     IS DISTINCT FROM 'cms_program_products.cms_config_auth_guard=A:cms__config_auth_guard | cms_program_products.cms_config_lock_guard=A:cms__config_lock_guard | cms_program_products.cms_frozen_truncate=A:cms__frozen_truncate_guard | cms_program_stores.cms_config_auth_guard=A:cms__config_auth_guard | cms_program_stores.cms_config_lock_guard=A:cms__config_lock_guard | cms_program_stores.cms_frozen_truncate=A:cms__frozen_truncate_guard | cms_program_tiers.cms_config_auth_guard=A:cms__config_auth_guard | cms_program_tiers.cms_config_lock_guard=A:cms__config_lock_guard | cms_program_tiers.cms_frozen_truncate=A:cms__frozen_truncate_guard | cms_program_tiers.cms_tiers_last_open=A:cms__tiers_last_open_guard | cms_programs.cms_config_auth_guard=A:cms__config_auth_guard | cms_programs.cms_frozen_truncate=A:cms__frozen_truncate_guard | cms_programs.cms_programs_guard=O:cms__programs_guard | cms_programs.cms_programs_lock_guard=A:cms__programs_lock_guard | cms_programs.cms_programs_result_guard=O:cms__programs_result_guard' THEN
    RAISE EXCEPTION '127: trigger bảng cấu hình (tên / chế độ / hàm) khác bản duyệt — dừng, đối chiếu tay';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running') THEN
    RAISE EXCEPTION '127: còn run bán đang chạy — dừng task sales / CLI ghi rồi chạy lại';
  END IF;

  -- Chương trình đích: đúng UUID, trạng thái / kỳ / phạm vi / version như bản ghim.
  SELECT * INTO g FROM public.cms_programs WHERE id = '942194ce-893f-4f62-a88a-bd9efa464bae';
  IF NOT FOUND THEN
    RAISE EXCEPTION '127: không thấy chương trình 942194ce-893f-4f62-a88a-bd9efa464bae';
  END IF;
  IF g.status <> 'active' OR g.is_test OR g.start_date <> DATE '2026-11-01' OR g.end_date <> DATE '2026-11-30' OR g.scope <> 'all'
     OR g.calc_mode <> 'progressive' OR g.gate_scope <> 'pharmacist' OR g.catalog_target_gmv IS NOT NULL
     OR g.locked_at IS NOT NULL OR g.locked_by IS NOT NULL THEN
    RAISE EXCEPTION '127: chương trình khác bản ghim (status % · is_test % · kỳ %–% · scope % · locked_at %)',
      g.status, g.is_test, g.start_date, g.end_date, g.scope, g.locked_at;
  END IF;
  IF g.config_version <> 3 THEN
    RAISE EXCEPTION '127: config_version % ≠ bản ghim 3 — cấu hình đã đổi sau lúc ghim; chụp PRE mới, sinh lại', g.config_version;
  END IF;
  SELECT count(*) INTO v_n FROM public.cms_program_stores WHERE program_id = g.id;
  IF v_n <> 25
     OR (SELECT md5(string_agg(store_id::text, ',' ORDER BY store_id::text)) FROM public.cms_program_stores WHERE program_id = g.id)
        IS DISTINCT FROM '8c8705ccc3ac69a27ccd2d7002329848' THEN
    RAISE EXCEPTION '127: phạm vi nhà thuốc khác bản ghim (% nhà thuốc)', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_payouts WHERE program_id = g.id) THEN
    RAISE EXCEPTION '127: chương trình đã có payout — dừng (không sửa căn cứ đã chốt)';
  END IF;

  -- 17 SP: đúng tập ghim (id + ProductID), không target, mọi trường ngoài phạm vi khớp ghim (nội dung so bằng md5).
  IF (SELECT count(*) FROM public.cms_program_products WHERE program_id = g.id) <> 17
     OR (SELECT count(*) FROM cms127_pin) <> 17
     OR EXISTS (SELECT 1 FROM cms127_pin p
                 WHERE NOT EXISTS (
                   SELECT 1 FROM public.cms_program_products pp
                    WHERE pp.id = p.id AND pp.program_id = g.id AND pp.product_id = p.product_id
                      AND pp.gmv_basis = 'none' AND pp.target_gmv IS NULL
                      AND pp.unit_cms = p.unit_cms AND pp.base_quantity_cms = p.base_quantity_cms
                      AND md5(pp.advice_text) = p.advice_md5 AND md5(pp.name_snapshot) = p.name_md5
                      AND md5(COALESCE(pp.image_url_snapshot, '')) = p.image_md5
                      AND pp.price_snapshot IS NOT DISTINCT FROM p.price_snapshot
                      AND pp.import_run_id IS NOT DISTINCT FROM p.import_run_id
                      AND pp.added_after_start = p.added_after_start)) THEN
    RAISE EXCEPTION '127: 17 SP của chương trình khác bản ghim (tập SP / K / đơn vị / tư vấn / snapshot / target)';
  END IF;
  -- 51 bậc cũ: khớp từng dòng với bản ghim (cả hai chiều).
  IF (SELECT count(*) FROM public.cms_program_tiers WHERE program_id = g.id) <> 51
     OR EXISTS (SELECT program_product_id, tier_order, qty_from, qty_to, amount_per_unit FROM public.cms_program_tiers WHERE program_id = g.id
                EXCEPT SELECT program_product_id, tier_order, qty_from, qty_to, amount_per_unit FROM cms127_old_tiers)
     OR EXISTS (SELECT program_product_id, tier_order, qty_from, qty_to, amount_per_unit FROM cms127_old_tiers
                EXCEPT SELECT program_product_id, tier_order, qty_from, qty_to, amount_per_unit FROM public.cms_program_tiers WHERE program_id = g.id) THEN
    RAISE EXCEPTION '127: bậc hiện tại khác 51 bậc ghim (1–9 @15.000 · 10–19 @20.000 · từ 20 @25.000)';
  END IF;
  -- Bảng mức đúng bản ghim (md5 "ProductID:mức" theo ProductID).
  IF (SELECT md5(string_agg(product_id || ':' || new_amount, ',' ORDER BY product_id COLLATE "C")) FROM cms127_pin) IS DISTINCT FROM '29a0464bd08e27fb95440415209c4b2a' THEN
    RAISE EXCEPTION '127: bảng 17 mức lệch md5 ghim';
  END IF;
  -- Cờ giai đoạn (db-reviewer 127 P2-2): mỗi khối sau chỉ chạy khi khối trước ĐẠT — client tự savepoint từng câu (psql ON_ERROR_ROLLBACK)
  -- bỏ qua khối lỗi cũng không thể ghi dữ liệu / marker.
  PERFORM set_config('cms127.stage', 'p1', true);
END $$;
-- Thân 6 hàm guard chạy trên câu ghi của 127 phải đúng nguyên văn bản đã duyệt — khối sinh bởi gen-cms-127.mjs.
DO $$
BEGIN
  IF current_setting('cms127.stage', true) IS DISTINCT FROM 'p1' THEN
    RAISE EXCEPTION '127 preflight: bước trước chưa đạt (giai đoạn %, cần p1)', current_setting('cms127.stage', true);
  END IF;
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__programs_result_guard()'::regprocedure) IS DISTINCT FROM '8784c4589f1d3875b50d015223fc7b93'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__programs_guard()'::regprocedure) IS DISTINCT FROM '4dae021fddc4ae654955d2a37e434eb7'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__config_auth_guard()'::regprocedure) IS DISTINCT FROM 'd960d7d4465da96de1fdca09ecee3abf'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__config_lock_guard()'::regprocedure) IS DISTINCT FROM 'bcd7ae0e4b4857b42b5904d6570625d0'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__programs_lock_guard()'::regprocedure) IS DISTINCT FROM '23201e6389865e668665951d611e46de'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__tiers_last_open_guard()'::regprocedure) IS DISTINCT FROM 'd83088c260633f520dac35cfe8169475' THEN
    RAISE EXCEPTION '127 preflight: thân hàm guard (6) KHÁC bản đã duyệt (md5) — dừng, đối chiếu tay';
  END IF;
  PERFORM set_config('cms127.stage', 'p2', true);
END $$;

-- Ảnh trước (vân tay — so lại ở hậu kiểm; không PII). Ghi vào biến transaction cms127.pre.
DO $$
BEGIN
  IF current_setting('cms127.stage', true) IS DISTINCT FROM 'p2' THEN
    RAISE EXCEPTION '127: bước trước chưa đạt (giai đoạn %, cần p2) — không chạy từng câu với client tự savepoint', current_setting('cms127.stage', true);
  END IF;
  PERFORM set_config('cms127.pre', jsonb_build_object(
    'config_version', (SELECT config_version FROM public.cms_programs WHERE id = '942194ce-893f-4f62-a88a-bd9efa464bae'),
    'old_pointer', (SELECT current_result_run_id FROM public.cms_programs WHERE id = '942194ce-893f-4f62-a88a-bd9efa464bae'),
    'fn', (SELECT md5(string_agg(p.oid::regprocedure::text || '|' || md5(replace(p.prosrc, E'\r', '')) || '|' || p.prosecdef
                                   || '|' || COALESCE(p.proconfig::text, '-') || '|' || COALESCE(p.proacl::text, '-') || '|' || p.proowner,
                                 ',' ORDER BY p.oid::regprocedure::text))
             FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace),
    'triggers', (SELECT md5(string_agg(t.tgrelid::regclass::text || '|' || t.tgname || '|' || t.tgenabled::text || '|' || t.tgfoid::regprocedure::text
                                         || '|' || t.tgtype || '|' || t.tgdeferrable || '|' || t.tginitdeferred,
                                       ',' ORDER BY t.tgrelid::regclass::text, t.tgname))
                   FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
                  WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal),
    'others', (SELECT md5(COALESCE(string_agg(x, ',' ORDER BY x), ''))
                 FROM (SELECT to_jsonb(g)::text AS x FROM public.cms_programs g WHERE g.id <> '942194ce-893f-4f62-a88a-bd9efa464bae'
                       UNION ALL SELECT to_jsonb(pp)::text FROM public.cms_program_products pp WHERE pp.program_id <> '942194ce-893f-4f62-a88a-bd9efa464bae'
                       UNION ALL SELECT to_jsonb(t)::text FROM public.cms_program_tiers t WHERE t.program_id <> '942194ce-893f-4f62-a88a-bd9efa464bae'
                       UNION ALL SELECT to_jsonb(s)::text FROM public.cms_program_stores s WHERE s.program_id <> '942194ce-893f-4f62-a88a-bd9efa464bae') o),
    'runs', (SELECT md5(COALESCE(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id), '')) FROM public.cms_sync_runs r),
    'counts', jsonb_build_object('results', (SELECT count(*) FROM public.cms_results), 'sales_lines', (SELECT count(*) FROM public.cms_sales_lines),
                                 'payouts', (SELECT count(*) FROM public.cms_payouts), 'markers', (SELECT count(*) FROM public.app_migrations)),
    'gate', public.cms__results_release_open(),
    'real_ready', (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean)::text, true);
  PERFORM set_config('cms127.stage', 'p3', true);
END $$;

-- ── 1. Sửa đúng T11 ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_del integer;
  v_ins integer;
  v_upd integer;
BEGIN
  IF current_setting('cms127.stage', true) IS DISTINCT FROM 'p3' THEN
    RAISE EXCEPTION '127: bước trước chưa đạt (giai đoạn %, cần p3) — không chạy từng câu với client tự savepoint', current_setting('cms127.stage', true);
  END IF;
  -- Khoá dòng chương trình (RPC 121 / 122 / 123 cũng khoá dòng chương trình trước khi ghi cấu hình / pointer).
  PERFORM 1 FROM public.cms_programs WHERE id = '942194ce-893f-4f62-a88a-bd9efa464bae' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running' AND program_id = '942194ce-893f-4f62-a88a-bd9efa464bae') THEN
    RAISE EXCEPTION '127: run bán đang chạy trên T11 — dừng';
  END IF;
  -- DELETE trước INSERT (index UNIQUE (program_product_id, qty_from) không deferrable). Guard 125 (deferred) kiểm lúc COMMIT.
  DELETE FROM public.cms_program_tiers WHERE program_id = '942194ce-893f-4f62-a88a-bd9efa464bae';
  GET DIAGNOSTICS v_del = ROW_COUNT;
  IF v_del <> 51 THEN RAISE EXCEPTION '127: xoá % bậc, cần đúng 51', v_del; END IF;
  INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, qty_to, amount_per_unit)
  SELECT p.id, '942194ce-893f-4f62-a88a-bd9efa464bae'::uuid, 1, 1, NULL, p.new_amount FROM cms127_pin p ORDER BY p.product_id;
  GET DIAGNOSTICS v_ins = ROW_COUNT;
  IF v_ins <> 17 THEN RAISE EXCEPTION '127: ghi % bậc, cần đúng 17', v_ins; END IF;
  -- Trigger pointer 122 cấm pointer NULL ⇒ tắt TẠM đúng một câu (đang giữ EXCLUSIVE bảng chương trình từ đầu migration).
  ALTER TABLE public.cms_programs DISABLE TRIGGER cms_programs_result_guard;
  UPDATE public.cms_programs
     SET config_version = config_version + 1, current_result_run_id = NULL, updated_at = now(), updated_by = NULL
   WHERE id = '942194ce-893f-4f62-a88a-bd9efa464bae';
  GET DIAGNOSTICS v_upd = ROW_COUNT;
  ALTER TABLE public.cms_programs ENABLE TRIGGER cms_programs_result_guard;
  IF v_upd <> 1 THEN RAISE EXCEPTION '127: cập nhật % chương trình, cần đúng 1', v_upd; END IF;
  PERFORM set_config('cms127.stage', 'dml', true);
END $$;

-- Guard 125 (constraint trigger hoãn) chạy NGAY ở đây để marker chỉ ghi sau khi mọi kiểm đạt.
SET CONSTRAINTS ALL IMMEDIATE;

-- ── 2. Hậu kiểm trong transaction ──────────────────────────────────────────
DO $$
DECLARE
  v_pre jsonb := NULLIF(current_setting('cms127.pre', true), '')::jsonb;
  g     public.cms_programs%ROWTYPE;
BEGIN
  IF current_setting('cms127.stage', true) IS DISTINCT FROM 'dml' THEN
    RAISE EXCEPTION '127 hậu kiểm: bước trước chưa đạt (giai đoạn %, cần dml) — không chạy từng câu với client tự savepoint', current_setting('cms127.stage', true);
  END IF;
  SELECT * INTO g FROM public.cms_programs WHERE id = '942194ce-893f-4f62-a88a-bd9efa464bae';
  IF g.config_version <> (v_pre ->> 'config_version')::int + 1 OR g.current_result_run_id IS NOT NULL OR g.status <> 'active'
     OR g.is_test OR g.locked_at IS NOT NULL OR g.start_date <> DATE '2026-11-01' OR g.end_date <> DATE '2026-11-30' OR g.scope <> 'all' THEN
    RAISE EXCEPTION '127 hậu kiểm: chương trình sai (version % · pointer % · status %)', g.config_version, g.current_result_run_id, g.status;
  END IF;
  -- 17 SP giữ nguyên mọi trường (so lại với bản ghim).
  IF (SELECT count(*) FROM public.cms_program_products WHERE program_id = g.id) <> 17
     OR EXISTS (SELECT 1 FROM cms127_pin p
                 WHERE NOT EXISTS (
                   SELECT 1 FROM public.cms_program_products pp
                    WHERE pp.id = p.id AND pp.program_id = g.id AND pp.product_id = p.product_id
                      AND pp.gmv_basis = 'none' AND pp.target_gmv IS NULL
                      AND pp.unit_cms = p.unit_cms AND pp.base_quantity_cms = p.base_quantity_cms
                      AND md5(pp.advice_text) = p.advice_md5 AND md5(pp.name_snapshot) = p.name_md5
                      AND md5(COALESCE(pp.image_url_snapshot, '')) = p.image_md5
                      AND pp.price_snapshot IS NOT DISTINCT FROM p.price_snapshot
                      AND pp.import_run_id IS NOT DISTINCT FROM p.import_run_id
                      AND pp.added_after_start = p.added_after_start)) THEN
    RAISE EXCEPTION '127 hậu kiểm: 17 SP bị đổi ngoài phạm vi';
  END IF;
  -- 17 bậc mới đúng từng mức: thứ tự 1, từ 1, không giới hạn.
  IF (SELECT count(*) FROM public.cms_program_tiers WHERE program_id = g.id) <> 17
     OR EXISTS (SELECT 1 FROM cms127_pin p
                 WHERE NOT EXISTS (SELECT 1 FROM public.cms_program_tiers t
                                    WHERE t.program_product_id = p.id AND t.program_id = g.id AND t.tier_order = 1
                                      AND t.qty_from = 1 AND t.qty_to IS NULL AND t.amount_per_unit = p.new_amount)) THEN
    RAISE EXCEPTION '127 hậu kiểm: 17 bậc mới sai';
  END IF;
  IF (SELECT md5(string_agg(pp.product_id || ':' || t.amount_per_unit, ',' ORDER BY pp.product_id COLLATE "C"))
        FROM public.cms_program_tiers t JOIN public.cms_program_products pp ON pp.id = t.program_product_id
       WHERE t.program_id = g.id) IS DISTINCT FROM '29a0464bd08e27fb95440415209c4b2a' THEN
    RAISE EXCEPTION '127 hậu kiểm: md5 bảng mức trong DB lệch ghim';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_payouts WHERE program_id = g.id) THEN
    RAISE EXCEPTION '127 hậu kiểm: có payout';
  END IF;
  -- Trigger pointer 122 bật lại đúng chế độ origin; mọi trigger / hàm / ACL / chương trình khác / run / cổng KHÔNG đổi.
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_result_guard' AND t.tgenabled = 'O'
         AND t.tgfoid = 'public.cms__programs_result_guard()'::regprocedure) <> 1 THEN
    RAISE EXCEPTION '127 hậu kiểm: trigger pointer chưa bật lại đúng chế độ 122';
  END IF;
  IF (SELECT md5(string_agg(t.tgrelid::regclass::text || '|' || t.tgname || '|' || t.tgenabled::text || '|' || t.tgfoid::regprocedure::text
                              || '|' || t.tgtype || '|' || t.tgdeferrable || '|' || t.tginitdeferred,
                            ',' ORDER BY t.tgrelid::regclass::text, t.tgname))
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal) IS DISTINCT FROM v_pre ->> 'triggers' THEN
    RAISE EXCEPTION '127 hậu kiểm: trigger public đổi so với trước';
  END IF;
  IF (SELECT md5(string_agg(p.oid::regprocedure::text || '|' || md5(replace(p.prosrc, E'\r', '')) || '|' || p.prosecdef
                              || '|' || COALESCE(p.proconfig::text, '-') || '|' || COALESCE(p.proacl::text, '-') || '|' || p.proowner,
                            ',' ORDER BY p.oid::regprocedure::text))
        FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace) IS DISTINCT FROM v_pre ->> 'fn' THEN
    RAISE EXCEPTION '127 hậu kiểm: hàm public (thân / ACL / cấu hình) đổi so với trước';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(x, ',' ORDER BY x), ''))
        FROM (SELECT to_jsonb(o)::text AS x FROM public.cms_programs o WHERE o.id <> '942194ce-893f-4f62-a88a-bd9efa464bae'
              UNION ALL SELECT to_jsonb(pp)::text FROM public.cms_program_products pp WHERE pp.program_id <> '942194ce-893f-4f62-a88a-bd9efa464bae'
              UNION ALL SELECT to_jsonb(t)::text FROM public.cms_program_tiers t WHERE t.program_id <> '942194ce-893f-4f62-a88a-bd9efa464bae'
              UNION ALL SELECT to_jsonb(s)::text FROM public.cms_program_stores s WHERE s.program_id <> '942194ce-893f-4f62-a88a-bd9efa464bae') o)
     IS DISTINCT FROM v_pre ->> 'others' THEN
    RAISE EXCEPTION '127 hậu kiểm: chương trình khác / QA bị đổi';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id), '')) FROM public.cms_sync_runs r) IS DISTINCT FROM v_pre ->> 'runs'
     OR jsonb_build_object('results', (SELECT count(*) FROM public.cms_results), 'sales_lines', (SELECT count(*) FROM public.cms_sales_lines),
                           'payouts', (SELECT count(*) FROM public.cms_payouts), 'markers', (SELECT count(*) FROM public.app_migrations))
        IS DISTINCT FROM v_pre -> 'counts' THEN
    RAISE EXCEPTION '127 hậu kiểm: run / kết quả / dòng bán / payout / marker bị đổi';
  END IF;
  IF public.cms__results_release_open() IS DISTINCT FROM (v_pre ->> 'gate')::boolean
     OR (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM (v_pre ->> 'real_ready')::boolean THEN
    RAISE EXCEPTION '127 hậu kiểm: cổng kết quả / policy chốt đổi';
  END IF;
  -- Marker CHỈ ghi ở đây, sau mọi kiểm (cùng khối DO — db-reviewer 127 P2-2). notes: JSON không PII, VERIFY phase 127 đọc.
  INSERT INTO public.app_migrations (version, name, notes)
  VALUES ('127', 'cms_t11_flat_amounts', jsonb_build_object(
    'program', '942194ce-893f-4f62-a88a-bd9efa464bae', 'products', 17,
    'config_version', jsonb_build_object('from', (v_pre ->> 'config_version')::int, 'to', (v_pre ->> 'config_version')::int + 1),
    'tiers', jsonb_build_object('from', 51, 'to', 17),
    'rates_md5', '29a0464bd08e27fb95440415209c4b2a', 'workbook_sha256', '4faf2c4ccd7071420293bff8a1520f5e25983482864d45c43c8573f27c62d263',
    'old_pointer', v_pre ->> 'old_pointer', 'pointer_cleared', true,
    'payouts_global', v_pre -> 'counts' -> 'payouts')::text);
  PERFORM set_config('cms127.stage', 'done', true);
END $$;

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — `node scripts/cms-verify.mjs post --phase=127 --pre=<PRE chụp NGAY TRƯỚC 127>`) ──
-- Sau 127, cms-verify phase 126 ĐỎ đúng thiết kế (phase-match / marker-127-absent / max-numeric) ⇒ phase 127 (kế thừa toàn bộ 126 +
-- marker 127 + bất biến T11 v127-t11-flat).
-- V1 marker: SELECT version, name, notes FROM public.app_migrations WHERE version IN ('126', '127') ORDER BY 1;
-- V2 T11 (kỳ vọng 17 dòng, mỗi SP 1 bậc 1 → NULL đúng mức; pointer NULL tới khi tính lại):
--   SELECT pp.product_id, count(t.*) n, min(t.qty_from) f, max(t.qty_to) t_to, max(t.amount_per_unit) amount
--     FROM public.cms_program_products pp JOIN public.cms_program_tiers t ON t.program_product_id = pp.id
--    WHERE pp.program_id = '942194ce-893f-4f62-a88a-bd9efa464bae' GROUP BY 1 ORDER BY 1;
--   SELECT config_version, current_result_run_id FROM public.cms_programs WHERE id = '942194ce-893f-4f62-a88a-bd9efa464bae';
-- V3 trigger pointer: SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.cms_programs'::regclass
--   AND tgname = 'cms_programs_result_guard';   -- O
