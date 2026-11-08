-- ============================================================================
-- rollback/127_cms_t11_flat_amounts_rollback.sql  (r0 — Dev 08/11/2026; CHƯA audit PM, KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-127.mjs (cùng pin.json với 127). KHÔNG sửa tay.
--
-- ĐƯỜNG KHẨN, cần operator + PM duyệt riêng: trả T11 942194ce-893f-4f62-a88a-bd9efa464bae về 51 bậc mẫu (1–9 @15.000 · 10–19 @20.000 · từ 20 @25.000) — mức
-- đã bị quyết định operator 08/11 THAY THẾ. Mặc định khi 127 có vấn đề: giữ ẩn số + sửa tiến (fix forward), KHÔNG chạy file này.
--
-- Đổi (một transaction): xoá 17 bậc của 127 → ghi lại 51 bậc ghim; config_version + 1 TIẾP (không giảm, không về giá trị cũ);
-- current_result_run_id = NULL (không khôi phục pointer cũ — run theo cấu hình nào cũng không còn hiện hành, tính lại sau rollback);
-- xoá marker 127. KHÔNG xoá / sửa run, kết quả, dòng bán, sổ — lịch sử chỉnh sửa còn ở config_version tăng + run đã công bố.
-- Dừng (không đổi gì): thiếu marker 127 / có số > 127; không READ COMMITTED; role không phải owner; thân guard / trigger pointer lệch;
-- còn run bán 'running'; T11 khác trạng thái 127 để lại (version = 4, 17 SP ghim, 17 bậc đúng mức — có chỉnh sửa mới ⇒
-- dừng); có payout / đã chốt.
-- Sau rollback, áp lại 127 bằng CÙNG file sẽ bị preflight chặn (config_version ≠ ghim) — đúng thiết kế: muốn áp lại phải chụp PRE
-- mới, cập nhật pin.json, sinh lại và qua audit.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.cms_programs IN EXCLUSIVE MODE;
LOCK TABLE public.cms_sync_runs IN SHARE MODE;
LOCK TABLE public.cms_program_products, public.cms_program_tiers IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.cms_program_stores, public.cms_payouts IN SHARE MODE;

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
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'rollback 127: cần READ COMMITTED';
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '127';
  IF v_name IS DISTINCT FROM 'cms_t11_flat_amounts' THEN
    RAISE EXCEPTION 'rollback 127: không có marker 127 cms_t11_flat_amounts (name = %)', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 127) THEN
    RAISE EXCEPTION 'rollback 127: DB đã có migration số > 127 — dừng';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION 'rollback 127: role chạy (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_programs'::regclass, 'public.cms_program_products'::regclass,
                              'public.cms_program_tiers'::regclass, 'public.cms_sync_runs'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'rollback 127: owner bảng / hàm CMS khác role chạy (%)', current_user;
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_result_guard' AND t.tgenabled = 'O'
         AND t.tgfoid = 'public.cms__programs_result_guard()'::regprocedure) <> 1 THEN
    RAISE EXCEPTION 'rollback 127: trigger pointer cms_programs_result_guard không đúng dạng 122';
  END IF;
  -- 15 trigger không nội bộ trên 4 bảng cấu hình: đúng tên / chế độ / hàm như 120–126 (O = origin, A = ALWAYS) — mọi trigger chạy trên
  -- câu ghi của 127 phải đang BẬT đúng chế độ (vân tay trước / sau chỉ chứng minh 127 không đổi, không chứng minh trạng thái nền đúng).
  IF (SELECT string_agg(c.relname || '.' || t.tgname || '=' || t.tgenabled::text || ':' || p.proname, ' | ' ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C")
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
       WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
         AND c.relname IN ('cms_programs', 'cms_program_products', 'cms_program_tiers', 'cms_program_stores'))
     IS DISTINCT FROM 'cms_program_products.cms_config_auth_guard=A:cms__config_auth_guard | cms_program_products.cms_config_lock_guard=A:cms__config_lock_guard | cms_program_products.cms_frozen_truncate=A:cms__frozen_truncate_guard | cms_program_stores.cms_config_auth_guard=A:cms__config_auth_guard | cms_program_stores.cms_config_lock_guard=A:cms__config_lock_guard | cms_program_stores.cms_frozen_truncate=A:cms__frozen_truncate_guard | cms_program_tiers.cms_config_auth_guard=A:cms__config_auth_guard | cms_program_tiers.cms_config_lock_guard=A:cms__config_lock_guard | cms_program_tiers.cms_frozen_truncate=A:cms__frozen_truncate_guard | cms_program_tiers.cms_tiers_last_open=A:cms__tiers_last_open_guard | cms_programs.cms_config_auth_guard=A:cms__config_auth_guard | cms_programs.cms_frozen_truncate=A:cms__frozen_truncate_guard | cms_programs.cms_programs_guard=O:cms__programs_guard | cms_programs.cms_programs_lock_guard=A:cms__programs_lock_guard | cms_programs.cms_programs_result_guard=O:cms__programs_result_guard' THEN
    RAISE EXCEPTION 'rollback 127: trigger bảng cấu hình (tên / chế độ / hàm) khác bản duyệt — dừng, đối chiếu tay';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running') THEN
    RAISE EXCEPTION 'rollback 127: còn run bán đang chạy — dừng task sales / CLI ghi rồi chạy lại';
  END IF;
  SELECT * INTO g FROM public.cms_programs WHERE id = '942194ce-893f-4f62-a88a-bd9efa464bae';
  IF NOT FOUND OR g.status <> 'active' OR g.is_test OR g.locked_at IS NOT NULL OR g.start_date <> DATE '2026-11-01'
     OR g.end_date <> DATE '2026-11-30' OR g.scope <> 'all' THEN
    RAISE EXCEPTION 'rollback 127: chương trình không ở trạng thái 127 để lại (status % · locked_at %)', g.status, g.locked_at;
  END IF;
  IF g.config_version <> 4 THEN
    RAISE EXCEPTION 'rollback 127: config_version % ≠ 4 (đã có chỉnh sửa sau 127) — dừng, trình PM', g.config_version;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_payouts WHERE program_id = g.id) THEN
    RAISE EXCEPTION 'rollback 127: chương trình đã có payout — dừng';
  END IF;
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
    RAISE EXCEPTION 'rollback 127: 17 SP khác bản ghim — dừng';
  END IF;
  IF (SELECT count(*) FROM public.cms_program_tiers WHERE program_id = g.id) <> 17
     OR EXISTS (SELECT 1 FROM cms127_pin p
                 WHERE NOT EXISTS (SELECT 1 FROM public.cms_program_tiers t
                                    WHERE t.program_product_id = p.id AND t.program_id = g.id AND t.tier_order = 1
                                      AND t.qty_from = 1 AND t.qty_to IS NULL AND t.amount_per_unit = p.new_amount)) THEN
    RAISE EXCEPTION 'rollback 127: bậc hiện tại không phải 17 bậc của 127 — dừng';
  END IF;
  PERFORM set_config('cms127.stage', 'p1', true);
END $$;
DO $$
BEGIN
  IF current_setting('cms127.stage', true) IS DISTINCT FROM 'p1' THEN
    RAISE EXCEPTION 'rollback 127 preflight: bước trước chưa đạt (giai đoạn %, cần p1)', current_setting('cms127.stage', true);
  END IF;
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__programs_result_guard()'::regprocedure) IS DISTINCT FROM '8784c4589f1d3875b50d015223fc7b93'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__programs_guard()'::regprocedure) IS DISTINCT FROM '4dae021fddc4ae654955d2a37e434eb7'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__config_auth_guard()'::regprocedure) IS DISTINCT FROM 'd960d7d4465da96de1fdca09ecee3abf'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__config_lock_guard()'::regprocedure) IS DISTINCT FROM 'bcd7ae0e4b4857b42b5904d6570625d0'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__programs_lock_guard()'::regprocedure) IS DISTINCT FROM '23201e6389865e668665951d611e46de'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__tiers_last_open_guard()'::regprocedure) IS DISTINCT FROM 'd83088c260633f520dac35cfe8169475' THEN
    RAISE EXCEPTION 'rollback 127 preflight: thân hàm guard (6) KHÁC bản đã duyệt (md5) — dừng, đối chiếu tay';
  END IF;
  PERFORM set_config('cms127.stage', 'p2', true);
END $$;

DO $$
BEGIN
  IF current_setting('cms127.stage', true) IS DISTINCT FROM 'p2' THEN
    RAISE EXCEPTION 'rollback 127: bước trước chưa đạt (giai đoạn %, cần p2) — không chạy từng câu với client tự savepoint', current_setting('cms127.stage', true);
  END IF;
  PERFORM set_config('cms127.pre', jsonb_build_object(
    'config_version', (SELECT config_version FROM public.cms_programs WHERE id = '942194ce-893f-4f62-a88a-bd9efa464bae'),
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
                 FROM (SELECT to_jsonb(o)::text AS x FROM public.cms_programs o WHERE o.id <> '942194ce-893f-4f62-a88a-bd9efa464bae'
                       UNION ALL SELECT to_jsonb(pp)::text FROM public.cms_program_products pp WHERE pp.program_id <> '942194ce-893f-4f62-a88a-bd9efa464bae'
                       UNION ALL SELECT to_jsonb(t)::text FROM public.cms_program_tiers t WHERE t.program_id <> '942194ce-893f-4f62-a88a-bd9efa464bae'
                       UNION ALL SELECT to_jsonb(s)::text FROM public.cms_program_stores s WHERE s.program_id <> '942194ce-893f-4f62-a88a-bd9efa464bae') o),
    'runs', (SELECT md5(COALESCE(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id), '')) FROM public.cms_sync_runs r))::text, true);
  PERFORM set_config('cms127.stage', 'p3', true);
END $$;

-- ── 1. Khôi phục 51 bậc ghim ────────────────────────────────────────────────
DO $$
DECLARE
  v_del integer;
  v_ins integer;
  v_upd integer;
BEGIN
  IF current_setting('cms127.stage', true) IS DISTINCT FROM 'p3' THEN
    RAISE EXCEPTION 'rollback 127: bước trước chưa đạt (giai đoạn %, cần p3) — không chạy từng câu với client tự savepoint', current_setting('cms127.stage', true);
  END IF;
  PERFORM 1 FROM public.cms_programs WHERE id = '942194ce-893f-4f62-a88a-bd9efa464bae' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running' AND program_id = '942194ce-893f-4f62-a88a-bd9efa464bae') THEN
    RAISE EXCEPTION 'rollback 127: run bán đang chạy trên T11 — dừng';
  END IF;
  DELETE FROM public.cms_program_tiers WHERE program_id = '942194ce-893f-4f62-a88a-bd9efa464bae';
  GET DIAGNOSTICS v_del = ROW_COUNT;
  IF v_del <> 17 THEN RAISE EXCEPTION 'rollback 127: xoá % bậc, cần đúng 17', v_del; END IF;
  INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, qty_to, amount_per_unit)
  SELECT o.program_product_id, '942194ce-893f-4f62-a88a-bd9efa464bae'::uuid, o.tier_order, o.qty_from, o.qty_to, o.amount_per_unit
    FROM cms127_old_tiers o ORDER BY o.program_product_id, o.tier_order;
  GET DIAGNOSTICS v_ins = ROW_COUNT;
  IF v_ins <> 51 THEN RAISE EXCEPTION 'rollback 127: ghi % bậc, cần đúng 51', v_ins; END IF;
  ALTER TABLE public.cms_programs DISABLE TRIGGER cms_programs_result_guard;
  UPDATE public.cms_programs
     SET config_version = config_version + 1, current_result_run_id = NULL, updated_at = now(), updated_by = NULL
   WHERE id = '942194ce-893f-4f62-a88a-bd9efa464bae';
  GET DIAGNOSTICS v_upd = ROW_COUNT;
  ALTER TABLE public.cms_programs ENABLE TRIGGER cms_programs_result_guard;
  IF v_upd <> 1 THEN RAISE EXCEPTION 'rollback 127: cập nhật % chương trình, cần đúng 1', v_upd; END IF;
  PERFORM set_config('cms127.stage', 'dml', true);
END $$;

SET CONSTRAINTS ALL IMMEDIATE;

-- ── 2. Hậu kiểm ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_pre jsonb := NULLIF(current_setting('cms127.pre', true), '')::jsonb;
  g     public.cms_programs%ROWTYPE;
BEGIN
  IF current_setting('cms127.stage', true) IS DISTINCT FROM 'dml' THEN
    RAISE EXCEPTION 'rollback 127 hậu kiểm: bước trước chưa đạt (giai đoạn %, cần dml) — không chạy từng câu với client tự savepoint', current_setting('cms127.stage', true);
  END IF;
  SELECT * INTO g FROM public.cms_programs WHERE id = '942194ce-893f-4f62-a88a-bd9efa464bae';
  IF g.config_version <> (v_pre ->> 'config_version')::int + 1 OR g.current_result_run_id IS NOT NULL OR g.status <> 'active' THEN
    RAISE EXCEPTION 'rollback 127 hậu kiểm: chương trình sai (version % · pointer %)', g.config_version, g.current_result_run_id;
  END IF;
  IF (SELECT count(*) FROM public.cms_program_tiers WHERE program_id = g.id) <> 51
     OR EXISTS (SELECT program_product_id, tier_order, qty_from, qty_to, amount_per_unit FROM public.cms_program_tiers WHERE program_id = g.id
                EXCEPT SELECT program_product_id, tier_order, qty_from, qty_to, amount_per_unit FROM cms127_old_tiers) THEN
    RAISE EXCEPTION 'rollback 127 hậu kiểm: 51 bậc khôi phục lệch bản ghim';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_result_guard' AND t.tgenabled = 'O'
         AND t.tgfoid = 'public.cms__programs_result_guard()'::regprocedure) <> 1
     OR (SELECT md5(string_agg(t.tgrelid::regclass::text || '|' || t.tgname || '|' || t.tgenabled::text || '|' || t.tgfoid::regprocedure::text
                                 || '|' || t.tgtype || '|' || t.tgdeferrable || '|' || t.tginitdeferred,
                               ',' ORDER BY t.tgrelid::regclass::text, t.tgname))
           FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal) IS DISTINCT FROM v_pre ->> 'triggers' THEN
    RAISE EXCEPTION 'rollback 127 hậu kiểm: trigger đổi / trigger pointer chưa bật lại đúng chế độ 122';
  END IF;
  IF (SELECT md5(string_agg(p.oid::regprocedure::text || '|' || md5(replace(p.prosrc, E'\r', '')) || '|' || p.prosecdef
                              || '|' || COALESCE(p.proconfig::text, '-') || '|' || COALESCE(p.proacl::text, '-') || '|' || p.proowner,
                            ',' ORDER BY p.oid::regprocedure::text))
        FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace) IS DISTINCT FROM v_pre ->> 'fn'
     OR (SELECT md5(COALESCE(string_agg(x, ',' ORDER BY x), ''))
           FROM (SELECT to_jsonb(o)::text AS x FROM public.cms_programs o WHERE o.id <> '942194ce-893f-4f62-a88a-bd9efa464bae'
                 UNION ALL SELECT to_jsonb(pp)::text FROM public.cms_program_products pp WHERE pp.program_id <> '942194ce-893f-4f62-a88a-bd9efa464bae'
                 UNION ALL SELECT to_jsonb(t)::text FROM public.cms_program_tiers t WHERE t.program_id <> '942194ce-893f-4f62-a88a-bd9efa464bae'
                 UNION ALL SELECT to_jsonb(s)::text FROM public.cms_program_stores s WHERE s.program_id <> '942194ce-893f-4f62-a88a-bd9efa464bae') o)
        IS DISTINCT FROM v_pre ->> 'others'
     OR (SELECT md5(COALESCE(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id), '')) FROM public.cms_sync_runs r) IS DISTINCT FROM v_pre ->> 'runs' THEN
    RAISE EXCEPTION 'rollback 127 hậu kiểm: hàm / chương trình khác / run bị đổi';
  END IF;
  -- Xoá marker CHỈ ở đây, sau mọi kiểm (cùng khối DO — db-reviewer 127 P2-2).
  DELETE FROM public.app_migrations WHERE version = '127';
  PERFORM set_config('cms127.stage', 'done', true);
END $$;

COMMIT;
