-- ============================================================================
-- rollback/127_cms_t11_flat_amounts_rollback.sql  (r0 — Dev 08/11/2026; CHƯA audit PM, KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-127.mjs (cùng pin.json với 127). KHÔNG sửa tay.
--
-- ĐƯỜNG KHẨN, cần operator + PM duyệt riêng: trả T11 @@PID@@ về 51 bậc mẫu (1–9 @15.000 · 10–19 @20.000 · từ 20 @25.000) — mức
-- đã bị quyết định operator 08/11 THAY THẾ. Mặc định khi 127 có vấn đề: giữ ẩn số + sửa tiến (fix forward), KHÔNG chạy file này.
--
-- Đổi (một transaction): xoá 17 bậc của 127 → ghi lại 51 bậc ghim; config_version + 1 TIẾP (không giảm, không về giá trị cũ);
-- current_result_run_id = NULL (không khôi phục pointer cũ — run theo cấu hình nào cũng không còn hiện hành, tính lại sau rollback);
-- xoá marker 127. KHÔNG xoá / sửa run, kết quả, dòng bán, sổ — lịch sử chỉnh sửa còn ở config_version tăng + run đã công bố.
-- Dừng (không đổi gì): thiếu marker 127 / có số > 127; không READ COMMITTED; role không phải owner; thân guard / trigger pointer lệch;
-- còn run bán 'running'; T11 khác trạng thái 127 để lại (version = @@CV_AFTER@@, 17 SP ghim, 17 bậc đúng mức — có chỉnh sửa mới ⇒
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
@@PIN_ROWS@@;
CREATE TEMP TABLE cms127_old_tiers (
  program_product_id uuid    NOT NULL,
  tier_order         integer NOT NULL,
  qty_from           integer NOT NULL,
  qty_to             integer,
  amount_per_unit    bigint  NOT NULL,
  PRIMARY KEY (program_product_id, tier_order)
) ON COMMIT DROP;
INSERT INTO cms127_old_tiers (program_product_id, tier_order, qty_from, qty_to, amount_per_unit) VALUES
@@OLD_TIER_ROWS@@;

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
     IS DISTINCT FROM '@@TRIGGERS@@' THEN
    RAISE EXCEPTION 'rollback 127: trigger bảng cấu hình (tên / chế độ / hàm) khác bản duyệt — dừng, đối chiếu tay';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running') THEN
    RAISE EXCEPTION 'rollback 127: còn run bán đang chạy — dừng task sales / CLI ghi rồi chạy lại';
  END IF;
  SELECT * INTO g FROM public.cms_programs WHERE id = '@@PID@@';
  IF NOT FOUND OR g.status <> 'active' OR g.is_test OR g.locked_at IS NOT NULL OR g.start_date <> DATE '@@START@@'
     OR g.end_date <> DATE '@@END@@' OR g.scope <> 'all' THEN
    RAISE EXCEPTION 'rollback 127: chương trình không ở trạng thái 127 để lại (status % · locked_at %)', g.status, g.locked_at;
  END IF;
  IF g.config_version <> @@CV_AFTER@@ THEN
    RAISE EXCEPTION 'rollback 127: config_version % ≠ @@CV_AFTER@@ (đã có chỉnh sửa sau 127) — dừng, trình PM', g.config_version;
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
-- @@PREFLIGHT_MD5@@

DO $$
BEGIN
  IF current_setting('cms127.stage', true) IS DISTINCT FROM 'p2' THEN
    RAISE EXCEPTION 'rollback 127: bước trước chưa đạt (giai đoạn %, cần p2) — không chạy từng câu với client tự savepoint', current_setting('cms127.stage', true);
  END IF;
  PERFORM set_config('cms127.pre', jsonb_build_object(
    'config_version', (SELECT config_version FROM public.cms_programs WHERE id = '@@PID@@'),
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
                 FROM (SELECT to_jsonb(o)::text AS x FROM public.cms_programs o WHERE o.id <> '@@PID@@'
                       UNION ALL SELECT to_jsonb(pp)::text FROM public.cms_program_products pp WHERE pp.program_id <> '@@PID@@'
                       UNION ALL SELECT to_jsonb(t)::text FROM public.cms_program_tiers t WHERE t.program_id <> '@@PID@@'
                       UNION ALL SELECT to_jsonb(s)::text FROM public.cms_program_stores s WHERE s.program_id <> '@@PID@@') o),
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
  PERFORM 1 FROM public.cms_programs WHERE id = '@@PID@@' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running' AND program_id = '@@PID@@') THEN
    RAISE EXCEPTION 'rollback 127: run bán đang chạy trên T11 — dừng';
  END IF;
  DELETE FROM public.cms_program_tiers WHERE program_id = '@@PID@@';
  GET DIAGNOSTICS v_del = ROW_COUNT;
  IF v_del <> 17 THEN RAISE EXCEPTION 'rollback 127: xoá % bậc, cần đúng 17', v_del; END IF;
  INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, qty_to, amount_per_unit)
  SELECT o.program_product_id, '@@PID@@'::uuid, o.tier_order, o.qty_from, o.qty_to, o.amount_per_unit
    FROM cms127_old_tiers o ORDER BY o.program_product_id, o.tier_order;
  GET DIAGNOSTICS v_ins = ROW_COUNT;
  IF v_ins <> 51 THEN RAISE EXCEPTION 'rollback 127: ghi % bậc, cần đúng 51', v_ins; END IF;
  ALTER TABLE public.cms_programs DISABLE TRIGGER cms_programs_result_guard;
  UPDATE public.cms_programs
     SET config_version = config_version + 1, current_result_run_id = NULL, updated_at = now(), updated_by = NULL
   WHERE id = '@@PID@@';
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
  SELECT * INTO g FROM public.cms_programs WHERE id = '@@PID@@';
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
           FROM (SELECT to_jsonb(o)::text AS x FROM public.cms_programs o WHERE o.id <> '@@PID@@'
                 UNION ALL SELECT to_jsonb(pp)::text FROM public.cms_program_products pp WHERE pp.program_id <> '@@PID@@'
                 UNION ALL SELECT to_jsonb(t)::text FROM public.cms_program_tiers t WHERE t.program_id <> '@@PID@@'
                 UNION ALL SELECT to_jsonb(s)::text FROM public.cms_program_stores s WHERE s.program_id <> '@@PID@@') o)
        IS DISTINCT FROM v_pre ->> 'others'
     OR (SELECT md5(COALESCE(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id), '')) FROM public.cms_sync_runs r) IS DISTINCT FROM v_pre ->> 'runs' THEN
    RAISE EXCEPTION 'rollback 127 hậu kiểm: hàm / chương trình khác / run bị đổi';
  END IF;
  -- Xoá marker CHỈ ở đây, sau mọi kiểm (cùng khối DO — db-reviewer 127 P2-2).
  DELETE FROM public.app_migrations WHERE version = '127';
  PERFORM set_config('cms127.stage', 'done', true);
END $$;

COMMIT;
