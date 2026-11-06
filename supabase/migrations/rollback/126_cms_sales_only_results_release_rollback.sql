-- ============================================================================
-- rollback/126_cms_sales_only_results_release_rollback.sql  (r1 — CMS sales-only, Dev 06/11/2026; KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-126.mjs: khôi phục NGUYÊN VĂN cms__results_release_open() + rpc_cms_sales_run_publish(uuid) của
-- 122 (cổng đóng; publish không có nhánh điều chỉnh / dấu căn cứ), ACL (helper chỉ owner; publish service_role) + thu hồi grant
-- default privileges, xoá marker 126; hậu kiểm md5 thân 2 hàm khôi phục (sinh từ thân 122) + ACL + tổng hàm + cổng đóng.
-- GIỮ có chủ đích: run / snapshot đã công bố và pointer hiện hành (không xoá dữ liệu kết quả; dấu results_basis trong detail giữ làm
-- vết). Sau rollback, publish chương trình thật lại bị held RESULTS_RELEASE_GATE; app phải về chế độ HOLD (releaseGate) hoặc tắt
-- CMS_EARNINGS_ENABLED. Thứ tự vận hành: tắt CMS_EARNINGS_ENABLED (+ cron sync) TRƯỚC, rồi rollback cổng nếu PM quyết; mặc định
-- ưu tiên xử lý tiến. Có run bán THẬT thì rollback 122 vẫn bị guard cũ chặn (không nới).
-- Dừng nếu: thiếu marker 126 · có migration > 126 (rollback theo thứ tự ngược trước) · owner / isolation sai · thân 2 hàm hiện tại
-- khác bản 126 đã sinh (có người sửa tay — đối chiếu trước).
-- Sau rollback: `cms-verify post --phase=125` (PRE chụp trước 125) phải ĐẠT — 126 không để lại phần dư ở schema / hàm / ACL.
-- Vận hành: DÁN NGUYÊN FILE, nên GIỮ LF (md5 bỏ \r như VERIFY). Chạy bằng ĐÚNG role owner bảng / hàm CMS.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.cms_sync_runs IN SHARE MODE;

DO $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'rollback 126: cần READ COMMITTED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '126' AND name = 'cms_sales_only_results_release') THEN
    RAISE EXCEPTION 'rollback 126: không có marker 126';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 126) THEN
    RAISE EXCEPTION 'rollback 126: DB đã có migration số > 126 — rollback theo thứ tự ngược trước';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION 'rollback 126: role chạy (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_programs'::regclass, 'public.cms_sync_runs'::regclass, 'public.cms_sales_lines'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'rollback 126: owner bảng / hàm CMS khác role chạy (%) — chạy bằng owner', current_user;
  END IF;
END $$;
-- Thân 2 hàm hiện tại phải đúng bản 126 đã sinh — khối sinh bởi gen-cms-126.mjs.
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__results_release_open()'::regprocedure) IS DISTINCT FROM 'aebe1ff46ba51dcf533fe328af7ea2a0'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure) IS DISTINCT FROM 'db2c97efad2bb5ee9d69399b99c7c258' THEN
    RAISE EXCEPTION 'rollback 126 preflight: thân 2 hàm hiện tại KHÁC bản 126 đã sinh (md5) — có sửa tay? dừng, đối chiếu';
  END IF;
END $$;

-- ── Khôi phục NGUYÊN VĂN 122 ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cms__results_release_open()
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT false
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_publish(p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_pid  uuid;
  v_prog public.cms_programs%ROWTYPE;
  v_run  public.cms_sync_runs%ROWTYPE;
  v_code text;
  v_prev uuid;
BEGIN
  IF p_run_id IS NULL THEN RAISE EXCEPTION 'CMS_SALES_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT program_id INTO v_pid FROM public.cms_sync_runs WHERE id = p_run_id AND kind = 'sales';
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001'; END IF;
  -- Thứ tự khoá cố định chương trình → run (cùng thứ tự open / ghi cấu hình 121) ⇒ không deadlock.
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_pid FOR UPDATE;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.status = 'ok' THEN
    RETURN jsonb_build_object('published', true, 'already', true, 'run_id', p_run_id,
                              'current', v_prog.current_result_run_id IS NOT DISTINCT FROM p_run_id);
  END IF;
  IF v_run.status <> 'running' THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001'; END IF;
  IF v_run.sealed_at IS NULL THEN RAISE EXCEPTION 'CMS_RESULT_NOT_SEALED' USING ERRCODE = 'P0001'; END IF;
  v_code := CASE
    WHEN v_run.started_at < now() - interval '30 minutes' THEN 'STALE'
    WHEN v_prog.status = 'locked' THEN 'PROGRAM_LOCKED'
    WHEN v_prog.status <> 'active' THEN 'PROGRAM_NOT_ACTIVE'
    WHEN v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN 'CONFIG_CHANGED'
    WHEN public.cms__mapping_fp() <> v_run.mapping_fp THEN 'MAPPING_CHANGED'
    -- Q-206: chương trình thật không được công bố tiền tới khi cổng DB được mở bằng migration riêng.
    WHEN NOT v_run.is_test AND NOT public.cms__results_release_open() THEN 'RESULTS_RELEASE_GATE'
  END;
  IF v_code IS NOT NULL THEN
    UPDATE public.cms_sync_runs SET status = CASE WHEN v_code = 'STALE' THEN 'error' ELSE 'held' END,
           finished_at = now(), error_code = v_code
     WHERE id = p_run_id;
    RETURN jsonb_build_object('published', false, 'code', v_code, 'run_id', p_run_id);
  END IF;
  v_prev := v_prog.current_result_run_id;
  UPDATE public.cms_sync_runs SET status = 'ok', finished_at = now(), published_at = now() WHERE id = p_run_id;
  UPDATE public.cms_programs SET current_result_run_id = p_run_id WHERE id = v_pid;
  RETURN jsonb_build_object('published', true, 'already', false, 'run_id', p_run_id, 'previous_run_id', v_prev);
END;
$$;

-- ── ACL 2 hàm khôi phục (ma trận 122: helper chỉ owner; publish service_role) + thu hồi grant default privileges ──
REVOKE ALL ON FUNCTION public.cms__results_release_open(), public.rpc_cms_sales_run_publish(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_sales_run_publish(uuid) TO service_role;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, x.grantee
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.oid IN ('public.cms__results_release_open()'::regprocedure, 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure)
       AND x.grantee <> p.proowner
       AND NOT (p.proname = 'rpc_cms_sales_run_publish' AND x.grantee = 'service_role'::regrole::oid)
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
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__results_release_open()'::regprocedure) IS DISTINCT FROM 'd6b7f93f75ed7daafd9977463a3d0a3b'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure) IS DISTINCT FROM 'a12d10f071ac6ef93d6a35f9fa623c12' THEN
    RAISE EXCEPTION 'rollback 126 hậu kiểm: thân 2 hàm 122 khôi phục lệch nguyên văn (md5)';
  END IF;
END $$;
DO $$
DECLARE
  r   record;
  v_n integer;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosecdef, p.proconfig, p.provolatile,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ','
                              ORDER BY CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END, x.privilege_type)
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl,
           has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
           has_function_privilege('service_role', p.oid, 'EXECUTE') s
      FROM pg_catalog.pg_proc p
     WHERE p.oid IN ('public.cms__results_release_open()'::regprocedure, 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure)
  LOOP
    IF r.a OR r.u OR NOT r.prosecdef OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}')))
       OR r.acl IS DISTINCT FROM (CASE WHEN r.proname LIKE 'rpc\_%' THEN 'service_role:EXECUTE' END)
       OR r.s IS DISTINCT FROM (r.proname LIKE 'rpc\_%')
       OR (r.proname LIKE 'rpc\_%' AND (NOT ('lock_timeout=5s' = ANY (COALESCE(r.proconfig, '{}'))) OR r.provolatile <> 'v'))
       OR (r.proname = 'cms__results_release_open' AND (r.provolatile <> 'i' OR cardinality(r.proconfig) <> 1)) THEN
      RAISE EXCEPTION 'rollback 126 hậu kiểm: ACL / SECDEF / config / volatility % sai (acl %)', r.proname, r.acl;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> 68 THEN RAISE EXCEPTION 'rollback 126 hậu kiểm: tổng hàm CMS phải 68 (như 125), có %', v_n; END IF;
  IF public.cms__results_release_open() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'rollback 126 hậu kiểm: cổng cms__results_release_open() chưa về false';
  END IF;
END $$;

DELETE FROM public.app_migrations WHERE version = '126';

COMMIT;
