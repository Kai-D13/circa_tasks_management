-- ============================================================================
-- rollback/@@VERSION@@_cms_unit_t11_basis_rollback.sql  (CMS-UNIT UNIT-4 — Dev 09/11/2026; CHƯA audit PM, KHÔNG chạy prod)@@REHEARSAL_NOTE@@
-- SINH bằng webapp/scripts/gen-cms-unit-t11.mjs (cùng pin.json với @@VERSION@@). KHÔNG sửa tay.
--
-- ROLLBACK VẬN HÀNH (spec PM 09/11 §5), cần operator + PM duyệt riêng: transaction BÙ đưa T11 @@PID@@ về cơ sở pos_base (luật cũ
-- floor(ΣB / K)). Đổi (một transaction): quantity_basis = 'pos_base' · config_version + 1 TIẾP (@@CV_AFTER@@ → @@CV_ROLLBACK@@, KHÔNG hạ
-- về @@CV@@) · current_result_run_id = NULL (không trỏ lại run cũ — run nào cũng không còn hiện hành, tính lại theo pos_base sau rollback)
-- · xoá marker @@VERSION@@. KHÔNG xoá / sửa run, kết quả, dòng bán, sổ; run đã tính theo cms_unit GIỮ metadata cms_unit (bất biến — lịch
-- sử vẫn đọc đúng luật của run). KHÔNG đụng cột / hàm 128 (rollback schema là việc khác, bị chặn khi đã có run cms_unit).
-- Dừng (không đổi gì): thiếu marker @@VERSION@@ / có số > @@VERSION@@; không READ COMMITTED; role không phải owner; trigger / thân guard
-- lệch; còn run bán 'running'; T11 khác trạng thái @@VERSION@@ để lại (cms_unit, version = @@CV_AFTER@@, 17 SP / 17 mức / phạm vi ghim — có
-- chỉnh sửa mới ⇒ dừng); đã chốt / có payout.
-- Sau rollback, áp lại @@VERSION@@ bằng CÙNG file bị preflight chặn (config_version ≠ ghim) — đúng thiết kế: muốn áp lại phải chụp PRE
-- mới, cập nhật pin.json, sinh lại và qua audit. Tắt cờ CMS_UNIT_BASIS_ENABLED chỉ ngừng writer cms_unit, KHÔNG thay file này.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.cms_programs IN EXCLUSIVE MODE;
LOCK TABLE public.cms_sync_runs IN SHARE MODE;
LOCK TABLE public.cms_program_products, public.cms_program_tiers, public.cms_program_stores, public.cms_payouts IN SHARE MODE;

CREATE TEMP TABLE cmsunit_pin (
  id                uuid    PRIMARY KEY,
  product_id        text    NOT NULL UNIQUE,
  gmv_basis         text    NOT NULL,
  target_gmv        numeric,
  unit_cms          text    NOT NULL,
  base_quantity_cms numeric NOT NULL,
  advice_md5        text    NOT NULL,
  name_md5          text    NOT NULL,
  image_md5         text    NOT NULL,
  price_snapshot    numeric,
  import_run_id     uuid,
  added_after_start boolean NOT NULL,
  amount            bigint  NOT NULL CHECK (amount > 0)
) ON COMMIT DROP;
INSERT INTO cmsunit_pin (id, product_id, gmv_basis, target_gmv, unit_cms, base_quantity_cms, advice_md5, name_md5, image_md5, price_snapshot,
                         import_run_id, added_after_start, amount) VALUES
@@PIN_ROWS@@;

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_name text;
  g      public.cms_programs%ROWTYPE;
  v_n    integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: cần READ COMMITTED';
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '@@VERSION@@';
  IF v_name IS DISTINCT FROM 'cms_unit_t11_basis' THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: thiếu marker @@VERSION@@ cms_unit_t11_basis (name = %)', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > @@VERSION@@) THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: DB đã có migration số > @@VERSION@@ — dừng';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: role chạy (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_programs'::regclass, 'public.cms_program_products'::regclass,
                              'public.cms_program_tiers'::regclass, 'public.cms_sync_runs'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: owner bảng / hàm CMS khác role chạy (%)', current_user;
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_result_guard' AND t.tgenabled = 'O'
         AND t.tgfoid = 'public.cms__programs_result_guard()'::regprocedure) <> 1
     OR (SELECT count(*) FROM pg_catalog.pg_trigger t
          WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_basis_guard' AND t.tgenabled = 'A'
            AND t.tgfoid = 'public.cms__programs_basis_guard()'::regprocedure) <> 1 THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: trigger pointer 122 (O) / guard đổi cơ sở 128 (A) không đúng dạng duyệt';
  END IF;
  IF (SELECT string_agg(c.relname || '.' || t.tgname || '=' || t.tgenabled::text || ':' || p.proname, ' | ' ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C")
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
       WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
         AND c.relname IN ('cms_programs', 'cms_program_products', 'cms_program_tiers', 'cms_program_stores'))
     IS DISTINCT FROM '@@TRIGGERS@@' THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: trigger bảng cấu hình (tên / chế độ / hàm) khác bản duyệt — dừng, đối chiếu tay';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running') THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: còn run bán đang chạy — dừng task sales / CLI ghi rồi chạy lại';
  END IF;
  SELECT * INTO g FROM public.cms_programs WHERE id = '@@PID@@';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: không thấy chương trình @@PID@@';
  END IF;
  IF g.quantity_basis IS DISTINCT FROM 'cms_unit' THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: chương trình không ở cơ sở cms_unit (%) — không có gì để bù', g.quantity_basis;
  END IF;
  IF g.status <> 'active' OR g.is_test OR g.start_date <> DATE '@@START@@' OR g.end_date <> DATE '@@END@@' OR g.scope <> '@@SCOPE@@'
     OR g.calc_mode <> '@@CALC_MODE@@' OR g.gate_scope <> '@@GATE_SCOPE@@' OR g.catalog_target_gmv IS DISTINCT FROM @@CATALOG@@
     OR g.locked_at IS NOT NULL OR g.locked_by IS NOT NULL THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: chương trình khác trạng thái @@VERSION@@ để lại (status % · kỳ %–% · locked_at %)', g.status, g.start_date, g.end_date, g.locked_at;
  END IF;
  IF g.config_version <> @@CV_AFTER@@ THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: config_version % ≠ @@CV_AFTER@@ (sau @@VERSION@@) — đã có chỉnh sửa sau datafix; đối chiếu tay, không bù tự động', g.config_version;
  END IF;
  SELECT count(*) INTO v_n FROM public.cms_program_stores WHERE program_id = g.id;
  IF v_n <> @@STORES_N@@
     OR (SELECT md5(string_agg(store_id::text, ',' ORDER BY store_id::text COLLATE "C")) FROM public.cms_program_stores WHERE program_id = g.id)
        IS DISTINCT FROM '@@STORES_MD5@@' THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: phạm vi nhà thuốc khác bản ghim (% nhà thuốc)', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_payouts WHERE program_id = g.id) THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: chương trình đã có payout — dừng';
  END IF;
  IF (SELECT count(*) FROM public.cms_program_products WHERE program_id = g.id) <> 17
     OR EXISTS (SELECT 1 FROM cmsunit_pin p
                 WHERE NOT EXISTS (
                   SELECT 1 FROM public.cms_program_products pp
                    WHERE pp.id = p.id AND pp.program_id = g.id AND pp.product_id = p.product_id
                      AND pp.gmv_basis = p.gmv_basis AND pp.target_gmv IS NOT DISTINCT FROM p.target_gmv
                      AND pp.unit_cms = p.unit_cms AND pp.base_quantity_cms = p.base_quantity_cms
                      AND md5(pp.advice_text) = p.advice_md5 AND md5(pp.name_snapshot) = p.name_md5
                      AND md5(COALESCE(pp.image_url_snapshot, '')) = p.image_md5
                      AND pp.price_snapshot IS NOT DISTINCT FROM p.price_snapshot
                      AND pp.import_run_id IS NOT DISTINCT FROM p.import_run_id
                      AND pp.added_after_start = p.added_after_start)) THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: 17 SP khác bản ghim';
  END IF;
  IF (SELECT count(*) FROM public.cms_program_tiers WHERE program_id = g.id) <> 17
     OR EXISTS (SELECT 1 FROM cmsunit_pin p
                 WHERE NOT EXISTS (SELECT 1 FROM public.cms_program_tiers t
                                    WHERE t.program_product_id = p.id AND t.program_id = g.id AND t.tier_order = 1
                                      AND t.qty_from = 1 AND t.qty_to IS NULL AND t.amount_per_unit = p.amount)) THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: bậc hiện tại khác 17 mức ghim';
  END IF;
  PERFORM set_config('cmsunit.stage', 'p1', true);
END $$;
-- @@PREFLIGHT_MD5@@

DO $$
BEGIN
  IF current_setting('cmsunit.stage', true) IS DISTINCT FROM 'p2' THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: bước trước chưa đạt (giai đoạn %, cần p2)', current_setting('cmsunit.stage', true);
  END IF;
  PERFORM set_config('cmsunit.pre', jsonb_build_object(
    'config_version', (SELECT config_version FROM public.cms_programs WHERE id = '@@PID@@'),
    'old_pointer', (SELECT current_result_run_id FROM public.cms_programs WHERE id = '@@PID@@'),
    'program_rest', (SELECT md5((to_jsonb(g) - 'quantity_basis' - 'config_version' - 'current_result_run_id' - 'updated_at' - 'updated_by')::text)
                       FROM public.cms_programs g WHERE g.id = '@@PID@@'),
    'config', (SELECT md5(COALESCE(string_agg(x, ',' ORDER BY x), ''))
                 FROM (SELECT to_jsonb(pp)::text AS x FROM public.cms_program_products pp WHERE pp.program_id = '@@PID@@'
                       UNION ALL SELECT to_jsonb(t)::text FROM public.cms_program_tiers t WHERE t.program_id = '@@PID@@'
                       UNION ALL SELECT to_jsonb(s)::text FROM public.cms_program_stores s WHERE s.program_id = '@@PID@@') o),
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
                 FROM (SELECT to_jsonb(g)::text AS x FROM public.cms_programs g WHERE g.id <> '@@PID@@'
                       UNION ALL SELECT to_jsonb(pp)::text FROM public.cms_program_products pp WHERE pp.program_id <> '@@PID@@'
                       UNION ALL SELECT to_jsonb(t)::text FROM public.cms_program_tiers t WHERE t.program_id <> '@@PID@@'
                       UNION ALL SELECT to_jsonb(s)::text FROM public.cms_program_stores s WHERE s.program_id <> '@@PID@@') o),
    'runs', (SELECT md5(COALESCE(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id), '')) FROM public.cms_sync_runs r),
    'counts', jsonb_build_object('results', (SELECT count(*) FROM public.cms_results), 'sales_lines', (SELECT count(*) FROM public.cms_sales_lines),
                                 'payouts', (SELECT count(*) FROM public.cms_payouts), 'markers', (SELECT count(*) FROM public.app_migrations)),
    'gate', public.cms__results_release_open(),
    'real_ready', (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean)::text, true);
  PERFORM set_config('cmsunit.stage', 'p3', true);
END $$;

-- ── 1. Bù: về pos_base, version tăng tiếp, pointer NULL ─────────────────────
DO $$
DECLARE
  v_upd integer;
BEGIN
  IF current_setting('cmsunit.stage', true) IS DISTINCT FROM 'p3' THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: bước trước chưa đạt (giai đoạn %, cần p3)', current_setting('cmsunit.stage', true);
  END IF;
  PERFORM 1 FROM public.cms_programs WHERE id = '@@PID@@' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running' AND program_id = '@@PID@@') THEN
    RAISE EXCEPTION 'rollback @@VERSION@@: run bán đang chạy trên T11 — dừng';
  END IF;
  PERFORM set_config('cms.basis_change_program', '@@PID@@', true);
  ALTER TABLE public.cms_programs DISABLE TRIGGER cms_programs_result_guard;
  UPDATE public.cms_programs
     SET quantity_basis = 'pos_base', config_version = config_version + 1, current_result_run_id = NULL, updated_at = now(), updated_by = NULL
   WHERE id = '@@PID@@' AND quantity_basis = 'cms_unit' AND config_version = @@CV_AFTER@@;
  GET DIAGNOSTICS v_upd = ROW_COUNT;
  ALTER TABLE public.cms_programs ENABLE TRIGGER cms_programs_result_guard;
  PERFORM set_config('cms.basis_change_program', '', true);
  IF v_upd <> 1 THEN RAISE EXCEPTION 'rollback @@VERSION@@: cập nhật % chương trình, cần đúng 1', v_upd; END IF;
  PERFORM set_config('cmsunit.stage', 'dml', true);
END $$;

SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE
  v_pre jsonb := NULLIF(current_setting('cmsunit.pre', true), '')::jsonb;
  g     public.cms_programs%ROWTYPE;
BEGIN
  IF current_setting('cmsunit.stage', true) IS DISTINCT FROM 'dml' THEN
    RAISE EXCEPTION 'rollback @@VERSION@@ hậu kiểm: bước trước chưa đạt (giai đoạn %, cần dml)', current_setting('cmsunit.stage', true);
  END IF;
  SELECT * INTO g FROM public.cms_programs WHERE id = '@@PID@@';
  IF g.quantity_basis <> 'pos_base' OR g.config_version <> (v_pre ->> 'config_version')::int + 1 OR g.current_result_run_id IS NOT NULL
     OR g.status <> 'active' OR g.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'rollback @@VERSION@@ hậu kiểm: chương trình sai (cơ sở % · version % · pointer %)', g.quantity_basis, g.config_version, g.current_result_run_id;
  END IF;
  IF md5((to_jsonb(g) - 'quantity_basis' - 'config_version' - 'current_result_run_id' - 'updated_at' - 'updated_by')::text) IS DISTINCT FROM v_pre ->> 'program_rest'
     OR (SELECT md5(COALESCE(string_agg(x, ',' ORDER BY x), ''))
           FROM (SELECT to_jsonb(pp)::text AS x FROM public.cms_program_products pp WHERE pp.program_id = g.id
                 UNION ALL SELECT to_jsonb(t)::text FROM public.cms_program_tiers t WHERE t.program_id = g.id
                 UNION ALL SELECT to_jsonb(s)::text FROM public.cms_program_stores s WHERE s.program_id = g.id) o) IS DISTINCT FROM v_pre ->> 'config' THEN
    RAISE EXCEPTION 'rollback @@VERSION@@ hậu kiểm: trường khác / SP / mức / phạm vi bị đổi';
  END IF;
  IF public.cms__calc_snapshot(g.id) ->> 'quantity_basis' IS DISTINCT FROM 'pos_base' OR COALESCE(current_setting('cms.basis_change_program', true), '') <> '' THEN
    RAISE EXCEPTION 'rollback @@VERSION@@ hậu kiểm: snapshot cấu hình tính / biến phiên sai';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_result_guard' AND t.tgenabled = 'O') <> 1
     OR (SELECT md5(string_agg(t.tgrelid::regclass::text || '|' || t.tgname || '|' || t.tgenabled::text || '|' || t.tgfoid::regprocedure::text
                                 || '|' || t.tgtype || '|' || t.tgdeferrable || '|' || t.tginitdeferred,
                               ',' ORDER BY t.tgrelid::regclass::text, t.tgname))
           FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal) IS DISTINCT FROM v_pre ->> 'triggers'
     OR (SELECT md5(string_agg(p.oid::regprocedure::text || '|' || md5(replace(p.prosrc, E'\r', '')) || '|' || p.prosecdef
                                 || '|' || COALESCE(p.proconfig::text, '-') || '|' || COALESCE(p.proacl::text, '-') || '|' || p.proowner,
                               ',' ORDER BY p.oid::regprocedure::text))
           FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace) IS DISTINCT FROM v_pre ->> 'fn' THEN
    RAISE EXCEPTION 'rollback @@VERSION@@ hậu kiểm: trigger / hàm public đổi so với trước';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(x, ',' ORDER BY x), ''))
        FROM (SELECT to_jsonb(o)::text AS x FROM public.cms_programs o WHERE o.id <> '@@PID@@'
              UNION ALL SELECT to_jsonb(pp)::text FROM public.cms_program_products pp WHERE pp.program_id <> '@@PID@@'
              UNION ALL SELECT to_jsonb(t)::text FROM public.cms_program_tiers t WHERE t.program_id <> '@@PID@@'
              UNION ALL SELECT to_jsonb(s)::text FROM public.cms_program_stores s WHERE s.program_id <> '@@PID@@') o)
        IS DISTINCT FROM v_pre ->> 'others'
     OR (SELECT md5(COALESCE(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id), '')) FROM public.cms_sync_runs r) IS DISTINCT FROM v_pre ->> 'runs'
     OR jsonb_build_object('results', (SELECT count(*) FROM public.cms_results), 'sales_lines', (SELECT count(*) FROM public.cms_sales_lines),
                           'payouts', (SELECT count(*) FROM public.cms_payouts), 'markers', (SELECT count(*) FROM public.app_migrations))
        IS DISTINCT FROM v_pre -> 'counts'
     OR public.cms__results_release_open() IS DISTINCT FROM (v_pre ->> 'gate')::boolean
     OR (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM (v_pre ->> 'real_ready')::boolean THEN
    RAISE EXCEPTION 'rollback @@VERSION@@ hậu kiểm: chương trình khác / run / kết quả / cổng bị đổi';
  END IF;
  DELETE FROM public.app_migrations WHERE version = '@@VERSION@@';
  PERFORM set_config('cmsunit.stage', 'done', true);
END $$;

COMMIT;
-- VERIFY (chỉ đọc): SELECT quantity_basis, config_version, current_result_run_id FROM public.cms_programs WHERE id = '@@PID@@';
--   -- pos_base · @@CV_ROLLBACK@@ · NULL; SELECT count(*) FROM public.app_migrations WHERE version = '@@VERSION@@';   -- 0
