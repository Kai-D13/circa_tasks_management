-- ============================================================================
-- @@VERSION@@_cms_unit_t11_basis.sql  (CMS-UNIT UNIT-4 — Dev 09/11/2026; CHƯA audit PM, KHÔNG chạy prod)@@REHEARSAL_NOTE@@
-- SINH bằng webapp/scripts/gen-cms-unit-t11.mjs từ webapp/scripts/cms-unit-t11/{fwd,rb}.sql + pin.json (ghim chương trình / 17 SP / 17 mức /
-- phạm vi / config_version / vân tay cấu hình chụp PRE tại cửa sổ) + md5 thân hàm guard lấy từ file migration 120–128. KHÔNG sửa tay.
-- Số @@VERSION@@ do PM ghim khi chốt release tổng (spec PM 09/11 §5: datafix CHƯA cấp số tới khi chốt hết request, đặt sau mọi migration
-- chuẩn bị schema của đợt gộp); nền @@PRED@@ + capability 128 cms_unit_quantity_basis.
--
-- Mục đích (Q-221 / Q-222 / UNIT-D05): chuyển ĐÚNG MỘT chương trình thật — T11 @@PID@@ — từ cơ sở pos_base (Q = floor(ΣB / K)) sang
-- cms_unit (chỉ đơn bán đúng ĐV tính CMS, Q = Σ quantity_raw nguyên), áp hồi tố cả kỳ từ 01/11 ở lượt tính kế tiếp.
-- Đổi (một transaction, atomically): cms_programs.quantity_basis = 'cms_unit' · config_version + 1 ĐÚNG một lần · current_result_run_id
-- = NULL (pointer cũ trỏ run luật cũ — không để số luật cũ hiện như số luật mới; UI ở "Chưa có số liệu theo cách tính mới" tới khi tính
-- lại) · marker @@VERSION@@. Guard đổi cơ sở 128 (cms_programs_basis_guard, ALWAYS) chỉ cho đổi khi phiên khai
-- cms.basis_change_program = đúng UUID + version + 1 + pointer NULL + không run 'running' + chưa chốt. Guard pointer 122
-- (cms_programs_result_guard) cấm pointer NULL ⇒ tắt TẠM đúng quanh MỘT câu UPDATE rồi bật lại chế độ origin 'O' (mẫu 125 / 127);
-- đang giữ EXCLUSIVE bảng chương trình từ đầu ⇒ không phiên nào ghi xen.
-- Giữ NGUYÊN: 17 SP (ĐV tính CMS / K / tư vấn / snapshot), 17 mức, kỳ, phạm vi, is_test; mọi run / kết quả / dòng bán / sổ / payout cũ
-- (run cũ giữ metadata pos_base bất biến); chương trình khác + QA; mọi hàm / trigger / ACL / bảng.
--
-- Dừng (fail-closed, 0 delta): thiếu 128 / thiếu nền @@PRED@@ / đã có marker @@VERSION@@ / có số > @@PRED@@; không READ COMMITTED; role
-- không phải owner bảng & hàm CMS; trigger / thân guard lệch bản duyệt; còn run bán 'running'; chương trình khác bản ghim (UUID / trạng
-- thái / kỳ / phạm vi / config_version / vân tay cấu hình / 17 SP / 17 mức); đã chốt / có payout; ĐÃ ở cms_unit (không chạy lại); ĐV
-- tính CMS của SP nào đó không có khoá đơn vị hợp lệ (cms-unit-key-v1). Lệch ghim ⇒ chụp PRE mới, cập nhật pin.json, sinh lại, PM audit.
--
-- Client: Supabase Studio SQL editor / pg-meta (một transaction, lỗi ⇒ huỷ cả). KHÔNG chạy bằng client tự savepoint từng câu (psql
-- \set ON_ERROR_ROLLBACK on) — cờ giai đoạn cmsunit.stage vẫn chặn ghi, nhưng đừng thử.
-- Vận hành (operator, sau PM audit + lệnh riêng, trong cửa sổ phát hành tổng): app mới (reader cms_unit) đã deploy + 128 đã chạy · cờ
-- CMS_UNIT_BASIS_ENABLED=true · task CMS sales tạm dừng, không CLI ghi, không run 'running' → PRE chỉ đọc (ảnh cấu hình + vân tay
-- cms__config_fp + `cms-verify acl-snapshot`) → DÁN NGUYÊN FILE (giữ LF) bằng ĐÚNG role owner, READ COMMITTED → VERIFY chỉ đọc → tính lại
-- (dry-run ×2 + oracle độc lập, rồi một lượt ghi thật được operator cho phép) → đối chiếu DB / UI / XLSX cùng run mới → bật lại task.
-- ROLLBACK (vận hành, operator + PM duyệt): rollback/@@VERSION@@_cms_unit_t11_basis_rollback.sql — transaction BÙ: cơ sở về pos_base,
-- config_version TĂNG tiếp, pointer NULL, xoá marker @@VERSION@@; không hạ version, không trỏ lại run cũ, không xoá run / metadata cms_unit.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
-- Khoá TRƯỚC preflight, CÙNG CHIỀU RPC 122–128 (chương trình → run; mẫu 127): bận ⇒ hết lock_timeout, rollback sạch, 0 delta.
--   · cms_programs EXCLUSIVE ⇒ chặn SELECT … FOR UPDATE / FOR SHARE mới của RPC (đủ mức cho DISABLE / ENABLE TRIGGER);
--   · cms_sync_runs SHARE ⇒ không mở / stage / publish run mới trong lúc đổi cơ sở (race datafix ↔ sync);
--   · cms_program_products / cms_program_tiers / cms_program_stores / cms_payouts SHARE ⇒ cấu hình và payout đứng yên.
LOCK TABLE public.cms_programs IN EXCLUSIVE MODE;
LOCK TABLE public.cms_sync_runs IN SHARE MODE;
LOCK TABLE public.cms_program_products, public.cms_program_tiers, public.cms_program_stores, public.cms_payouts IN SHARE MODE;

-- Bản ghim (pin.json) — bảng tạm của transaction, tự huỷ khi COMMIT / ROLLBACK.
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
    RAISE EXCEPTION '@@VERSION@@: cần READ COMMITTED';
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '128';
  IF v_name IS DISTINCT FROM 'cms_unit_quantity_basis' THEN
    RAISE EXCEPTION '@@VERSION@@: thiếu capability 128 cms_unit_quantity_basis (name = %)', v_name;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '@@PRED@@') THEN
    RAISE EXCEPTION '@@VERSION@@: thiếu migration nền @@PRED@@';
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '@@VERSION@@';
  IF FOUND THEN
    RAISE EXCEPTION '@@VERSION@@: đã có marker @@VERSION@@ (name = %) — không chạy lại / không chạy chồng', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > @@PRED@@) THEN
    RAISE EXCEPTION '@@VERSION@@: DB đã có migration số > @@PRED@@ — dừng';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION '@@VERSION@@: role chạy migration (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  -- Guard chỉ-owner 123 (cms__config_auth_guard) KHÔNG miễn superuser ⇒ chạy bằng ĐÚNG owner bảng / hàm CMS.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_programs'::regclass, 'public.cms_program_products'::regclass,
                              'public.cms_program_tiers'::regclass, 'public.cms_sync_runs'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '@@VERSION@@: owner bảng / hàm CMS khác role chạy (%)', current_user;
  END IF;
  -- Trigger pointer 122 sắp tắt tạm: đúng 1 trigger, đúng hàm, chế độ origin ('O'); guard đổi cơ sở 128: ALWAYS ('A').
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_result_guard' AND t.tgenabled = 'O'
         AND t.tgfoid = 'public.cms__programs_result_guard()'::regprocedure) <> 1
     OR (SELECT count(*) FROM pg_catalog.pg_trigger t
          WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_basis_guard' AND t.tgenabled = 'A'
            AND t.tgfoid = 'public.cms__programs_basis_guard()'::regprocedure) <> 1 THEN
    RAISE EXCEPTION '@@VERSION@@: trigger pointer 122 (O) / guard đổi cơ sở 128 (A) không đúng dạng duyệt';
  END IF;
  -- 16 trigger không nội bộ trên 4 bảng cấu hình (120–128): đúng tên / chế độ / hàm — mọi trigger chạy trên câu ghi phải đang BẬT đúng chế độ.
  IF (SELECT string_agg(c.relname || '.' || t.tgname || '=' || t.tgenabled::text || ':' || p.proname, ' | ' ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C")
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
       WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
         AND c.relname IN ('cms_programs', 'cms_program_products', 'cms_program_tiers', 'cms_program_stores'))
     IS DISTINCT FROM '@@TRIGGERS@@' THEN
    RAISE EXCEPTION '@@VERSION@@: trigger bảng cấu hình (tên / chế độ / hàm) khác bản duyệt — dừng, đối chiếu tay';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running') THEN
    RAISE EXCEPTION '@@VERSION@@: còn run bán đang chạy — dừng task sales / CLI ghi rồi chạy lại';
  END IF;

  -- Chương trình đích: ĐÚNG UUID (không LIKE / tiền tố), trạng thái / kỳ / phạm vi / version / vân tay như bản ghim tại cửa sổ.
  SELECT * INTO g FROM public.cms_programs WHERE id = '@@PID@@';
  IF NOT FOUND THEN
    RAISE EXCEPTION '@@VERSION@@: không thấy chương trình @@PID@@';
  END IF;
  IF g.quantity_basis = 'cms_unit' THEN
    RAISE EXCEPTION '@@VERSION@@: chương trình đã ở cơ sở cms_unit — datafix đã áp, không chạy lại';
  END IF;
  IF g.quantity_basis IS DISTINCT FROM 'pos_base' THEN
    RAISE EXCEPTION '@@VERSION@@: cơ sở chương trình lạ (%)', g.quantity_basis;
  END IF;
  IF g.status <> 'active' OR g.is_test OR g.start_date <> DATE '@@START@@' OR g.end_date <> DATE '@@END@@' OR g.scope <> '@@SCOPE@@'
     OR g.calc_mode <> '@@CALC_MODE@@' OR g.gate_scope <> '@@GATE_SCOPE@@' OR g.catalog_target_gmv IS DISTINCT FROM @@CATALOG@@
     OR g.locked_at IS NOT NULL OR g.locked_by IS NOT NULL THEN
    RAISE EXCEPTION '@@VERSION@@: chương trình khác bản ghim (status % · is_test % · kỳ %–% · scope % · locked_at %)',
      g.status, g.is_test, g.start_date, g.end_date, g.scope, g.locked_at;
  END IF;
  IF g.config_version <> @@CV@@ THEN
    RAISE EXCEPTION '@@VERSION@@: config_version % ≠ bản ghim @@CV@@ — cấu hình đã đổi sau lúc ghim; chụp PRE mới, sinh lại', g.config_version;
  END IF;
  IF public.cms__config_fp(g.id) IS DISTINCT FROM '@@CONFIG_FP@@' THEN
    RAISE EXCEPTION '@@VERSION@@: vân tay cấu hình cms__config_fp khác bản ghim tại cửa sổ — chụp PRE mới, sinh lại';
  END IF;
  SELECT count(*) INTO v_n FROM public.cms_program_stores WHERE program_id = g.id;
  IF v_n <> @@STORES_N@@
     OR (SELECT md5(string_agg(store_id::text, ',' ORDER BY store_id::text COLLATE "C")) FROM public.cms_program_stores WHERE program_id = g.id)
        IS DISTINCT FROM '@@STORES_MD5@@' THEN
    RAISE EXCEPTION '@@VERSION@@: phạm vi nhà thuốc khác bản ghim (% nhà thuốc)', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_payouts WHERE program_id = g.id) THEN
    RAISE EXCEPTION '@@VERSION@@: chương trình đã có payout — dừng (không đổi căn cứ đã chốt)';
  END IF;
  -- 17 SP: đúng tập ghim (id + ProductID) và mọi trường (nội dung so bằng md5).
  IF (SELECT count(*) FROM public.cms_program_products WHERE program_id = g.id) <> 17
     OR (SELECT count(*) FROM cmsunit_pin) <> 17
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
    RAISE EXCEPTION '@@VERSION@@: 17 SP của chương trình khác bản ghim (tập SP / K / đơn vị / tư vấn / snapshot / target)';
  END IF;
  -- 17 mức: mỗi SP đúng 1 bậc {thứ tự 1, từ 1, không giới hạn, mức ghim} (trạng thái sau 127).
  IF (SELECT count(*) FROM public.cms_program_tiers WHERE program_id = g.id) <> 17
     OR EXISTS (SELECT 1 FROM cmsunit_pin p
                 WHERE NOT EXISTS (SELECT 1 FROM public.cms_program_tiers t
                                    WHERE t.program_product_id = p.id AND t.program_id = g.id AND t.tier_order = 1
                                      AND t.qty_from = 1 AND t.qty_to IS NULL AND t.amount_per_unit = p.amount)) THEN
    RAISE EXCEPTION '@@VERSION@@: bậc hiện tại khác 17 mức ghim';
  END IF;
  IF (SELECT md5(string_agg(product_id || ':' || amount, ',' ORDER BY product_id COLLATE "C")) FROM cmsunit_pin) IS DISTINCT FROM '@@RATES_MD5@@' THEN
    RAISE EXCEPTION '@@VERSION@@: bảng 17 mức lệch md5 ghim';
  END IF;
  -- ĐV tính CMS của mọi SP có khoá đơn vị hợp lệ (cms-unit-key-v1) — nếu không, run cms_unit không mở được (CMS_SALES_UNIT_INVALID).
  IF EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = g.id AND public.cms__unit_key(pp.unit_cms) IS NULL) THEN
    RAISE EXCEPTION '@@VERSION@@: có SP mà ĐV tính CMS không có khoá đơn vị hợp lệ — sửa cấu hình trước, không đổi cơ sở';
  END IF;
  -- Cờ giai đoạn (mẫu 127 db-reviewer P2-2): mỗi khối sau chỉ chạy khi khối trước ĐẠT.
  PERFORM set_config('cmsunit.stage', 'p1', true);
END $$;
-- Thân hàm guard / hàm 128 chạy trong file này phải đúng nguyên văn bản đã duyệt — khối sinh bởi gen-cms-unit-t11.mjs.
-- @@PREFLIGHT_MD5@@

-- Ảnh trước (vân tay — so lại ở hậu kiểm; không PII). Ghi vào biến transaction cmsunit.pre.
DO $$
BEGIN
  IF current_setting('cmsunit.stage', true) IS DISTINCT FROM 'p2' THEN
    RAISE EXCEPTION '@@VERSION@@: bước trước chưa đạt (giai đoạn %, cần p2) — không chạy từng câu với client tự savepoint', current_setting('cmsunit.stage', true);
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

-- ── 1. Đổi cơ sở ĐÚNG T11 ───────────────────────────────────────────────────
DO $$
DECLARE
  v_upd integer;
BEGIN
  IF current_setting('cmsunit.stage', true) IS DISTINCT FROM 'p3' THEN
    RAISE EXCEPTION '@@VERSION@@: bước trước chưa đạt (giai đoạn %, cần p3) — không chạy từng câu với client tự savepoint', current_setting('cmsunit.stage', true);
  END IF;
  -- Khoá dòng chương trình (RPC 121–128 cũng khoá dòng chương trình trước khi ghi cấu hình / pointer / mở run).
  PERFORM 1 FROM public.cms_programs WHERE id = '@@PID@@' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running' AND program_id = '@@PID@@') THEN
    RAISE EXCEPTION '@@VERSION@@: run bán đang chạy trên T11 — dừng';
  END IF;
  -- Guard 128: chỉ phiên khai đúng UUID được đổi cơ sở chương trình đã có run (khai cục bộ transaction, xoá ngay sau câu UPDATE).
  PERFORM set_config('cms.basis_change_program', '@@PID@@', true);
  -- Guard pointer 122 cấm pointer NULL ⇒ tắt TẠM đúng một câu (đang giữ EXCLUSIVE bảng chương trình từ đầu file).
  ALTER TABLE public.cms_programs DISABLE TRIGGER cms_programs_result_guard;
  UPDATE public.cms_programs
     SET quantity_basis = 'cms_unit', config_version = config_version + 1, current_result_run_id = NULL, updated_at = now(), updated_by = NULL
   WHERE id = '@@PID@@' AND quantity_basis = 'pos_base' AND config_version = @@CV@@;
  GET DIAGNOSTICS v_upd = ROW_COUNT;
  ALTER TABLE public.cms_programs ENABLE TRIGGER cms_programs_result_guard;
  PERFORM set_config('cms.basis_change_program', '', true);
  IF v_upd <> 1 THEN RAISE EXCEPTION '@@VERSION@@: cập nhật % chương trình, cần đúng 1', v_upd; END IF;
  PERFORM set_config('cmsunit.stage', 'dml', true);
END $$;

-- Constraint trigger hoãn (125) chạy NGAY ở đây để marker chỉ ghi sau khi mọi kiểm đạt.
SET CONSTRAINTS ALL IMMEDIATE;

-- ── 2. Hậu kiểm trong transaction ──────────────────────────────────────────
DO $$
DECLARE
  v_pre jsonb := NULLIF(current_setting('cmsunit.pre', true), '')::jsonb;
  g     public.cms_programs%ROWTYPE;
  v_cs  jsonb;
BEGIN
  IF current_setting('cmsunit.stage', true) IS DISTINCT FROM 'dml' THEN
    RAISE EXCEPTION '@@VERSION@@ hậu kiểm: bước trước chưa đạt (giai đoạn %, cần dml) — không chạy từng câu với client tự savepoint', current_setting('cmsunit.stage', true);
  END IF;
  SELECT * INTO g FROM public.cms_programs WHERE id = '@@PID@@';
  IF g.quantity_basis <> 'cms_unit' OR g.config_version <> (v_pre ->> 'config_version')::int + 1 OR g.current_result_run_id IS NOT NULL
     OR g.status <> 'active' OR g.locked_at IS NOT NULL THEN
    RAISE EXCEPTION '@@VERSION@@ hậu kiểm: chương trình sai (cơ sở % · version % · pointer % · status %)', g.quantity_basis, g.config_version, g.current_result_run_id, g.status;
  END IF;
  IF md5((to_jsonb(g) - 'quantity_basis' - 'config_version' - 'current_result_run_id' - 'updated_at' - 'updated_by')::text) IS DISTINCT FROM v_pre ->> 'program_rest' THEN
    RAISE EXCEPTION '@@VERSION@@ hậu kiểm: trường khác của chương trình bị đổi';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(x, ',' ORDER BY x), ''))
        FROM (SELECT to_jsonb(pp)::text AS x FROM public.cms_program_products pp WHERE pp.program_id = g.id
              UNION ALL SELECT to_jsonb(t)::text FROM public.cms_program_tiers t WHERE t.program_id = g.id
              UNION ALL SELECT to_jsonb(s)::text FROM public.cms_program_stores s WHERE s.program_id = g.id) o) IS DISTINCT FROM v_pre ->> 'config' THEN
    RAISE EXCEPTION '@@VERSION@@ hậu kiểm: SP / mức / phạm vi bị đổi';
  END IF;
  -- Snapshot cấu hình tính dựng lại từ chương trình: cms_unit, mọi SP có khoá đơn vị (run cms_unit kế tiếp mở được).
  v_cs := public.cms__calc_snapshot(g.id);
  IF v_cs ->> 'quantity_basis' IS DISTINCT FROM 'cms_unit' OR v_cs ->> 'calculation_policy_version' IS DISTINCT FROM 'cms_unit_v1'
     OR jsonb_array_length(v_cs -> 'products') <> 17
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_cs -> 'products') e WHERE jsonb_typeof(e -> 'unit_key') IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION '@@VERSION@@ hậu kiểm: snapshot cấu hình tính không đúng cms_unit / khoá đơn vị';
  END IF;
  IF COALESCE(current_setting('cms.basis_change_program', true), '') <> '' THEN
    RAISE EXCEPTION '@@VERSION@@ hậu kiểm: biến phiên đổi cơ sở chưa xoá';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_payouts WHERE program_id = g.id) THEN
    RAISE EXCEPTION '@@VERSION@@ hậu kiểm: có payout';
  END IF;
  -- Trigger pointer 122 bật lại đúng chế độ origin; guard cơ sở 128 vẫn ALWAYS; mọi trigger / hàm / ACL / chương trình khác / run / cổng KHÔNG đổi.
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_result_guard' AND t.tgenabled = 'O'
         AND t.tgfoid = 'public.cms__programs_result_guard()'::regprocedure) <> 1
     OR (SELECT count(*) FROM pg_catalog.pg_trigger t
          WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_basis_guard' AND t.tgenabled = 'A') <> 1 THEN
    RAISE EXCEPTION '@@VERSION@@ hậu kiểm: trigger pointer / guard cơ sở chưa đúng chế độ';
  END IF;
  IF (SELECT md5(string_agg(t.tgrelid::regclass::text || '|' || t.tgname || '|' || t.tgenabled::text || '|' || t.tgfoid::regprocedure::text
                              || '|' || t.tgtype || '|' || t.tgdeferrable || '|' || t.tginitdeferred,
                            ',' ORDER BY t.tgrelid::regclass::text, t.tgname))
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal) IS DISTINCT FROM v_pre ->> 'triggers' THEN
    RAISE EXCEPTION '@@VERSION@@ hậu kiểm: trigger public đổi so với trước';
  END IF;
  IF (SELECT md5(string_agg(p.oid::regprocedure::text || '|' || md5(replace(p.prosrc, E'\r', '')) || '|' || p.prosecdef
                              || '|' || COALESCE(p.proconfig::text, '-') || '|' || COALESCE(p.proacl::text, '-') || '|' || p.proowner,
                            ',' ORDER BY p.oid::regprocedure::text))
        FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace) IS DISTINCT FROM v_pre ->> 'fn' THEN
    RAISE EXCEPTION '@@VERSION@@ hậu kiểm: hàm public (thân / ACL / cấu hình) đổi so với trước';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(x, ',' ORDER BY x), ''))
        FROM (SELECT to_jsonb(o)::text AS x FROM public.cms_programs o WHERE o.id <> '@@PID@@'
              UNION ALL SELECT to_jsonb(pp)::text FROM public.cms_program_products pp WHERE pp.program_id <> '@@PID@@'
              UNION ALL SELECT to_jsonb(t)::text FROM public.cms_program_tiers t WHERE t.program_id <> '@@PID@@'
              UNION ALL SELECT to_jsonb(s)::text FROM public.cms_program_stores s WHERE s.program_id <> '@@PID@@') o)
     IS DISTINCT FROM v_pre ->> 'others' THEN
    RAISE EXCEPTION '@@VERSION@@ hậu kiểm: chương trình khác / QA bị đổi';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id), '')) FROM public.cms_sync_runs r) IS DISTINCT FROM v_pre ->> 'runs'
     OR jsonb_build_object('results', (SELECT count(*) FROM public.cms_results), 'sales_lines', (SELECT count(*) FROM public.cms_sales_lines),
                           'payouts', (SELECT count(*) FROM public.cms_payouts), 'markers', (SELECT count(*) FROM public.app_migrations))
        IS DISTINCT FROM v_pre -> 'counts' THEN
    RAISE EXCEPTION '@@VERSION@@ hậu kiểm: run / kết quả / dòng bán / payout / marker bị đổi';
  END IF;
  IF public.cms__results_release_open() IS DISTINCT FROM (v_pre ->> 'gate')::boolean
     OR (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM (v_pre ->> 'real_ready')::boolean THEN
    RAISE EXCEPTION '@@VERSION@@ hậu kiểm: cổng kết quả / policy chốt đổi';
  END IF;
  -- Marker CHỈ ghi ở đây, sau mọi kiểm (cùng khối DO). notes: JSON không PII.
  INSERT INTO public.app_migrations (version, name, notes)
  VALUES ('@@VERSION@@', 'cms_unit_t11_basis', jsonb_build_object(
    'program', '@@PID@@', 'products', 17,
    'quantity_basis', jsonb_build_object('from', 'pos_base', 'to', 'cms_unit'), 'policy', 'cms_unit_v1', 'unit_key_version', 'cms-unit-key-v1',
    'config_version', jsonb_build_object('from', (v_pre ->> 'config_version')::int, 'to', (v_pre ->> 'config_version')::int + 1),
    'config_fp_pinned', '@@CONFIG_FP@@', 'rates_md5', '@@RATES_MD5@@',
    'old_pointer', v_pre ->> 'old_pointer', 'pointer_cleared', true,
    'payouts_global', v_pre -> 'counts' -> 'payouts')::text);
  PERFORM set_config('cmsunit.stage', 'done', true);
END $$;

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC) ─────────────────────────────────────────────
-- V1 marker: SELECT version, name, notes FROM public.app_migrations WHERE version IN ('128', '@@PRED@@', '@@VERSION@@') ORDER BY 1;
-- V2 T11 (kỳ vọng cms_unit, version @@CV_AFTER@@, pointer NULL tới khi tính lại):
--   SELECT quantity_basis, config_version, current_result_run_id FROM public.cms_programs WHERE id = '@@PID@@';
--   SELECT public.cms__calc_snapshot('@@PID@@') ->> 'quantity_basis';   -- cms_unit
-- V3 trigger: SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.cms_programs'::regclass
--   AND tgname IN ('cms_programs_result_guard', 'cms_programs_basis_guard') ORDER BY 1;   -- basis_guard A · result_guard O
-- V4 run cũ giữ nhãn pos_base: SELECT quantity_basis, calculation_policy_version, count(*) FROM public.cms_sync_runs
--   WHERE program_id = '@@PID@@' GROUP BY 1, 2;
