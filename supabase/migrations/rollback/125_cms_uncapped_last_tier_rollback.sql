-- ============================================================================
-- rollback/125_cms_uncapped_last_tier_rollback.sql  (r1 — CMS-UNCAPPED-1, Dev 05/11/2026; KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-125.mjs: khôi phục NGUYÊN VĂN rpc_cms_import_commit + rpc_cms_program_activate của 121 (ACL
-- service_role + thu hồi grant default privileges), gỡ constraint trigger cms_tiers_last_open + hàm cms__tiers_last_open_guard, xoá
-- marker 125; hậu kiểm md5 thân 2 RPC khôi phục (sinh từ thân 121) + ACL + tổng hàm.
-- GIỮ có chủ đích (không hứa khôi phục dữ liệu cận trên cũ): bậc cuối đã chuyển NULL, config_version đã tăng, pointer đã vô hiệu —
-- NULL là cấu hình hợp lệ với code / SQL cũ (bậc cuối không giới hạn), run cũ vẫn còn (không xoá run / chứng nhận / sổ). KHÔNG tái áp
-- cận hữu hạn, KHÔNG giảm config_version, KHÔNG phục hồi pointer tiền theo trần cũ. Sau rollback, app cũ (trước CMS-Q-220) lại nhận
-- file có cận cuối hữu hạn ⇒ chỉ rollback trước go-live / khi PM duyệt; đã có run / payout THẬT theo chính sách mới ⇒ đường mặc định là
-- tắt cờ / xử lý tiến, không rollback chính sách tài chính để bật lại trần.
-- Dừng nếu: thiếu marker 125 · có migration > 125 (rollback theo thứ tự ngược trước) · owner / isolation sai · còn run bán 'running'.
-- Sau rollback: `cms-verify post --phase=124` (PRE chụp trước 124) phải ĐẠT — 125 không để lại phần dư ở schema / hàm / trigger.
-- Vận hành: cờ CMS sync OFF, cron ghi CMS tạm dừng như khi áp 125. DÁN NGUYÊN FILE, nên GIỮ LF (md5 hậu kiểm bỏ \r như VERIFY; thân lệch ⇒ hậu kiểm
-- dừng, transaction rollback). Chạy bằng ĐÚNG role owner bảng / hàm CMS — owner khác ⇒ preflight dừng.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.cms_sync_runs IN SHARE MODE;
LOCK TABLE public.cms_programs, public.cms_program_products IN SHARE ROW EXCLUSIVE MODE;
-- DROP TRIGGER cần ACCESS EXCLUSIVE ⇒ lấy ngay đầu, không nâng khoá giữa chừng (db-reviewer 125 P2-2). Đọc bậc (RLS UI) chờ tối đa
-- lock_timeout của phiên đọc — chạy trong cửa sổ cờ CMS OFF.
LOCK TABLE public.cms_program_tiers IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'rollback 125: cần READ COMMITTED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '125' AND name = 'cms_uncapped_last_tier') THEN
    RAISE EXCEPTION 'rollback 125: không có marker 125';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 125) THEN
    RAISE EXCEPTION 'rollback 125: DB đã có migration số > 125 — rollback theo thứ tự ngược trước';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_programs'::regclass, 'public.cms_program_products'::regclass,
                              'public.cms_program_tiers'::regclass, 'public.cms_sync_runs'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'rollback 125: owner bảng / hàm CMS khác role chạy (%) — chạy bằng owner', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running') THEN
    RAISE EXCEPTION 'rollback 125: còn run bán đang chạy — chờ xong';
  END IF;
END $$;

DROP TRIGGER cms_tiers_last_open ON public.cms_program_tiers;
DROP FUNCTION public.cms__tiers_last_open_guard();

-- ── Khôi phục NGUYÊN VĂN 121 ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpc_cms_import_commit(p_run_id uuid, p_sha256 text, p_digest text, p_payload jsonb, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_run     public.cms_import_runs%ROWTYPE;
  v_prog    public.cms_programs%ROWTYPE;
  v_today   date := public.cms__vn_today();
  v_mode    text;
  v_cat     bigint;
  v_ids     text[];
  e         jsonb;
  t         jsonb;
  v_pp      uuid;
  v_k       integer;
  v_prev_to integer;
  v_n       integer := 0;
  v_tiers   integer := 0;
  v_has_cat boolean := false;
BEGIN
  IF p_run_id IS NULL OR p_actor IS NULL THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_run FROM public.cms_import_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_IMPORT_RUN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_run.file_sha256 IS DISTINCT FROM p_sha256 OR (v_run.result->>'digest') IS DISTINCT FROM p_digest THEN
    RAISE EXCEPTION 'CMS_IMPORT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.status = 'committed' THEN
    RETURN jsonb_build_object('already', true, 'program_id', v_run.program_id);
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_run.program_id FOR UPDATE;
  v_mode := CASE
    WHEN v_prog.status = 'draft' OR (v_prog.status = 'active' AND v_today < v_prog.start_date) THEN 'replace'
    WHEN v_prog.status = 'active' THEN 'append'
    ELSE NULL END;
  IF v_mode IS NULL THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_EDITABLE' USING ERRCODE = 'P0001'; END IF;
  IF v_run.config_version_at_preview <> v_prog.config_version OR v_mode IS DISTINCT FROM v_run.mode THEN
    RAISE EXCEPTION 'CMS_IMPORT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  -- Kiểm payload (không tin client — dù payload do server sinh từ lần parse lại).
  IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
  END IF;
  IF p_payload->>'mode' IS DISTINCT FROM v_mode OR jsonb_typeof(p_payload->'products') IS DISTINCT FROM 'array'
     OR COALESCE(jsonb_typeof(p_payload->'catalog_target'), 'null') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_payload->'products') NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
  END IF;
  -- Miền tiền = bigint dương của PG (cùng contract validator app — PM P1-b P1-1): kiểm dạng + so numeric TRƯỚC cast.
  IF jsonb_typeof(p_payload->'catalog_target') = 'string' THEN
    IF (p_payload->>'catalog_target') !~ '^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023'; END IF;
    IF (p_payload->>'catalog_target')::numeric > 9223372036854775807 THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023'; END IF;
    v_cat := (p_payload->>'catalog_target')::bigint;
  END IF;
  -- Mỗi điều kiện phụ thuộc kiểu được kiểm ở IF riêng (thứ tự đánh giá OR trong SQL không được bảo đảm; không ép kiểu
  -- trước khi đã chắc kiểu / dạng chuỗi ⇒ không lọt NULL, không lỗi cast thô). Kiểm tường minh mọi CHECK của bảng.
  FOR e IN SELECT x FROM jsonb_array_elements(p_payload->'products') x LOOP
    IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023'; END IF;
    IF jsonb_typeof(e->'product_id') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'gmv_basis') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e->'unit_cms') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'advice_text') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e->'name_snapshot') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'base_quantity_cms') IS DISTINCT FROM 'string'
       OR COALESCE(jsonb_typeof(e->'target_gmv'), '-') NOT IN ('string', 'null')
       OR COALESCE(jsonb_typeof(e->'image_url_snapshot'), '-') NOT IN ('string', 'null')
       OR COALESCE(jsonb_typeof(e->'price_snapshot'), '-') NOT IN ('string', 'null')
       OR jsonb_typeof(e->'tiers') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    IF (e->>'product_id') !~ '^[1-9][0-9]{0,18}$' OR (e->>'gmv_basis') NOT IN ('product', 'catalog', 'none')
       -- quy cách: decimal dương ≤ 29 chữ số nguyên / 9 chữ số thập phân (nền 120: < 1e29, scale ≤ 9)
       OR (e->>'base_quantity_cms') !~ '^[0-9]{1,29}(\.[0-9]{1,9})?$' OR (e->>'base_quantity_cms') !~ '[1-9]'
       OR (jsonb_typeof(e->'price_snapshot') = 'string' AND (e->>'price_snapshot') !~ '^[0-9]{1,15}(\.[0-9]{1,9})?$')
       OR ((e->>'gmv_basis') = 'product') IS DISTINCT FROM (jsonb_typeof(e->'target_gmv') = 'string')
       OR (jsonb_typeof(e->'target_gmv') = 'string' AND (e->>'target_gmv') !~ '^[1-9][0-9]{0,18}$')
       OR char_length(e->>'unit_cms') NOT BETWEEN 1 AND 50 OR (e->>'unit_cms') !~ '\S'
       OR char_length(e->>'advice_text') NOT BETWEEN 1 AND 4000 OR (e->>'advice_text') !~ '\S'
       OR char_length(e->>'name_snapshot') NOT BETWEEN 1 AND 500 OR (e->>'name_snapshot') !~ '\S'
       OR (jsonb_typeof(e->'image_url_snapshot') = 'string'
           AND ((e->>'image_url_snapshot') !~ '^https://' OR char_length(e->>'image_url_snapshot') > 2000))
       OR jsonb_array_length(e->'tiers') NOT BETWEEN 1 AND 2000 THEN
      RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(e->'target_gmv') = 'string' AND (e->>'target_gmv')::numeric > 9223372036854775807 THEN
      RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    IF (e->>'gmv_basis') = 'catalog' THEN v_has_cat := true; END IF;
    v_tiers := v_tiers + jsonb_array_length(e->'tiers');
    -- Bậc: payload đã sắp; order = vị trí 1..n, bắt đầu 1, liên tục, chỉ bậc cuối mở, đến ≥ từ, ≤ int max, tiền > 0.
    v_prev_to := 0;
    FOR t, v_k IN SELECT x, n::integer FROM jsonb_array_elements(e->'tiers') WITH ORDINALITY a(x, n) LOOP
      IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR jsonb_typeof(t->'order') IS DISTINCT FROM 'number'
         OR jsonb_typeof(t->'from') IS DISTINCT FROM 'number' OR COALESCE(jsonb_typeof(t->'to'), '-') NOT IN ('number', 'null')
         OR jsonb_typeof(t->'amount') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'CMS_IMPORT_BAD_TIERS' USING ERRCODE = '22023';
      END IF;
      IF (t->>'order') !~ '^[1-9][0-9]{0,9}$' OR (t->>'from') !~ '^[1-9][0-9]{0,9}$'
         OR (jsonb_typeof(t->'to') = 'number' AND (t->>'to') !~ '^[1-9][0-9]{0,9}$')
         OR (t->>'amount') !~ '^[1-9][0-9]{0,18}$' THEN
        RAISE EXCEPTION 'CMS_IMPORT_BAD_TIERS' USING ERRCODE = '22023';
      END IF;
      IF (t->>'order')::bigint <> v_k OR (t->>'from')::bigint <> v_prev_to::bigint + 1
         OR (t->>'amount')::numeric > 9223372036854775807
         OR (jsonb_typeof(t->'to') = 'null' AND v_k <> jsonb_array_length(e->'tiers'))
         OR (t->>'from')::bigint > 2147483647
         OR (jsonb_typeof(t->'to') = 'number' AND ((t->>'to')::bigint < (t->>'from')::bigint OR (t->>'to')::bigint > 2147483647)) THEN
        RAISE EXCEPTION 'CMS_IMPORT_BAD_TIERS' USING ERRCODE = '22023';
      END IF;
      v_prev_to := CASE WHEN jsonb_typeof(t->'to') = 'number' THEN (t->>'to')::integer ELSE v_prev_to END;
    END LOOP;
  END LOOP;
  IF v_tiers > 2000 THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_TIERS' USING ERRCODE = '22023'; END IF;
  IF v_has_cat AND v_cat IS NULL THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023'; END IF;
  IF (SELECT count(*) - count(DISTINCT x->>'product_id') FROM jsonb_array_elements(p_payload->'products') x) <> 0 THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(x->>'product_id') INTO v_ids FROM jsonb_array_elements(p_payload->'products') x;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) x WHERE NOT EXISTS (SELECT 1 FROM public.cms_product_master m WHERE m.product_id = x)) THEN
    RAISE EXCEPTION 'CMS_IMPORT_PRODUCT_UNKNOWN' USING ERRCODE = 'P0001';
  END IF;

  -- Khoá danh mục rồi kiểm trùng với chương trình active / locked khác, giao ngày, cùng namespace (câu lệnh mới).
  PERFORM public.cms__lock_catalog();
  IF cardinality(public.cms__conflicts(v_prog.id, v_prog.is_test, v_prog.start_date, v_prog.end_date, v_ids)) > 0 THEN
    RAISE EXCEPTION 'CMS_IMPORT_PRODUCT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  IF v_mode = 'replace' THEN
    DELETE FROM public.cms_program_tiers WHERE program_id = v_prog.id;
    DELETE FROM public.cms_program_products WHERE program_id = v_prog.id;
    UPDATE public.cms_programs SET catalog_target_gmv = CASE WHEN v_has_cat THEN v_cat ELSE NULL END WHERE id = v_prog.id;
  ELSE
    IF EXISTS (SELECT 1 FROM public.cms_program_products WHERE program_id = v_prog.id AND product_id = ANY (v_ids)) THEN
      RAISE EXCEPTION 'CMS_IMPORT_PRODUCT_EXISTS' USING ERRCODE = 'P0001';
    END IF;
    IF v_has_cat THEN
      IF v_prog.catalog_target_gmv IS NULL THEN
        UPDATE public.cms_programs SET catalog_target_gmv = v_cat WHERE id = v_prog.id;
      ELSIF v_prog.catalog_target_gmv <> v_cat THEN
        RAISE EXCEPTION 'CMS_IMPORT_CATALOG_TARGET_CHANGED' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  FOR e IN SELECT x FROM jsonb_array_elements(p_payload->'products') x LOOP
    INSERT INTO public.cms_program_products (program_id, product_id, gmv_basis, target_gmv, unit_cms, base_quantity_cms,
        advice_text, name_snapshot, image_url_snapshot, price_snapshot, import_run_id, added_after_start)
    VALUES (v_prog.id, e->>'product_id', e->>'gmv_basis', NULLIF(e->>'target_gmv', '')::bigint, e->>'unit_cms',
        (e->>'base_quantity_cms')::numeric, e->>'advice_text', e->>'name_snapshot', NULLIF(e->>'image_url_snapshot', ''),
        NULLIF(e->>'price_snapshot', '')::numeric, v_run.id, v_mode = 'append')
    RETURNING id INTO v_pp;
    INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, qty_to, amount_per_unit)
    SELECT v_pp, v_prog.id, (x->>'order')::integer, (x->>'from')::integer, NULLIF(x->>'to', '')::integer, (x->>'amount')::bigint
      FROM jsonb_array_elements(e->'tiers') x;
    v_n := v_n + 1;
  END LOOP;

  -- Audit: lưu payload đã ghi vào run (chuỗi run committed dựng lại được mọi phiên bản danh mục).
  UPDATE public.cms_import_runs
     SET status = 'committed', committed_by = p_actor, committed_at = now(),
         result = result || jsonb_build_object('committed', p_payload)
   WHERE id = v_run.id;
  UPDATE public.cms_programs SET config_version = config_version + 1, updated_by = p_actor, updated_at = now() WHERE id = v_prog.id;
  RETURN jsonb_build_object('already', false, 'program_id', v_prog.id, 'mode', v_mode, 'products', v_n);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_program_activate(p_program_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_prog  public.cms_programs%ROWTYPE;
  v_today date := public.cms__vn_today();
  v_ids   text[];
BEGIN
  IF p_program_id IS NULL OR p_actor IS NULL THEN RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_prog.status <> 'draft' THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_DRAFT' USING ERRCODE = 'P0001'; END IF;
  SELECT COALESCE(array_agg(product_id), '{}'::text[]) INTO v_ids FROM public.cms_program_products WHERE program_id = v_prog.id;
  IF cardinality(v_ids) = 0 THEN RAISE EXCEPTION 'CMS_PROGRAM_EMPTY' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM public.cms_program_products WHERE program_id = v_prog.id AND gmv_basis = 'catalog')
     AND v_prog.catalog_target_gmv IS NULL THEN
    RAISE EXCEPTION 'CMS_PROGRAM_CATALOG_TARGET_MISSING' USING ERRCODE = 'P0001';
  END IF;
  IF v_prog.scope = 'all' THEN
    DELETE FROM public.cms_program_stores WHERE program_id = v_prog.id;
    INSERT INTO public.cms_program_stores (program_id, store_id)
      SELECT v_prog.id, s.id FROM public.stores s WHERE s.store_type = 'os' AND s.is_active;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cms_program_stores WHERE program_id = v_prog.id)
     OR EXISTS (SELECT 1 FROM public.cms_program_stores ps JOIN public.stores s ON s.id = ps.store_id
                 WHERE ps.program_id = v_prog.id AND NOT (s.store_type = 'os' AND s.is_active)) THEN
    RAISE EXCEPTION 'CMS_PROGRAM_STORE_INVALID' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.cms__lock_catalog();
  IF cardinality(public.cms__conflicts(v_prog.id, v_prog.is_test, v_prog.start_date, v_prog.end_date, v_ids)) > 0 THEN
    RAISE EXCEPTION 'CMS_ACTIVATE_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.cms_programs
     SET status = 'active', activated_at = now(), activated_by = p_actor, config_version = config_version + 1,
         updated_by = p_actor, updated_at = now()
   WHERE id = v_prog.id;
  RETURN jsonb_build_object('program_id', v_prog.id, 'started', v_today >= v_prog.start_date, 'ended', v_today > v_prog.end_date,
                            'stores', (SELECT count(*) FROM public.cms_program_stores WHERE program_id = v_prog.id));
END;
$$;

-- ── ACL 2 RPC khôi phục (ma trận 121: service_role) + thu hồi grant default privileges ──
REVOKE ALL ON FUNCTION public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid), public.rpc_cms_program_activate(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid), public.rpc_cms_program_activate(uuid, uuid)
  TO service_role;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, x.grantee
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('rpc_cms_import_commit', 'rpc_cms_program_activate')
       AND x.grantee <> p.proowner AND x.grantee <> 'service_role'::regrole::oid
     GROUP BY p.oid, x.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- ── Hậu kiểm ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid)'::regprocedure) IS DISTINCT FROM 'f5924c03e1ffab041916401a359c76f3'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_program_activate(uuid, uuid)'::regprocedure) IS DISTINCT FROM 'ecc2c134df07a2e89878ac50cc63c04a' THEN
    RAISE EXCEPTION 'rollback 125 hậu kiểm: thân 2 RPC 121 khôi phục lệch nguyên văn (md5)';
  END IF;
END $$;
DO $$
DECLARE
  r   record;
  v_n integer;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosecdef, p.proconfig,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ','
                              ORDER BY CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END, x.privilege_type)
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl,
           has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
           has_function_privilege('service_role', p.oid, 'EXECUTE') s
      FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('rpc_cms_import_commit', 'rpc_cms_program_activate')
  LOOP
    IF r.a OR r.u OR NOT r.s OR r.acl IS DISTINCT FROM 'service_role:EXECUTE' OR NOT r.prosecdef
       OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}'))) OR NOT ('lock_timeout=5s' = ANY (COALESCE(r.proconfig, '{}'))) THEN
      RAISE EXCEPTION 'rollback 125 hậu kiểm: ACL / SECDEF / config % sai (acl %)', r.proname, r.acl;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> 67 THEN RAISE EXCEPTION 'rollback 125 hậu kiểm: tổng hàm CMS phải về 67 (như 124), có %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.cms_program_tiers'::regclass AND tgname = 'cms_tiers_last_open')
     OR to_regprocedure('public.cms__tiers_last_open_guard()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback 125 hậu kiểm: guard 125 còn sót';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_result_guard' AND t.tgenabled = 'O') <> 1 THEN
    RAISE EXCEPTION 'rollback 125 hậu kiểm: trigger pointer 122 không đúng chế độ origin';
  END IF;
END $$;

DELETE FROM public.app_migrations WHERE version = '125';

COMMIT;
