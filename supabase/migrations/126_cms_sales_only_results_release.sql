-- ============================================================================
-- 126_cms_sales_only_results_release.sql  (r1 — CMS sales-only, Dev 06/11/2026; CHƯA audit PM, CHƯA commit, KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-126.mjs từ webapp/scripts/cms-126/*.sql + thân 2 hàm 122 NGUYÊN VĂN (chỉ chèn / thay đúng các đoạn
-- ghi trong generator). KHÔNG sửa file này bằng tay — `node scripts/gen-cms-126.mjs --check` phát hiện lệch.
-- Số 126 = số PM dành trong khối Hiện trạng sống STATE (06/11, đổi phạm vi sales-only), preflight 125. Chuỗi phát hành 121 → 122 →
-- 123 → 124 → 125 → 126. KHÔNG dùng 126 để mở hợp đồng trả hàng hoặc chốt / chi trả thật.
-- Nguồn: planning/research/cms-sales-only-phase-spec-plan-2026-11-06.md §5 + planning/reviews/2026-11-06-cms-phase-scope-pm.md.
--
-- Mục đích: TÁCH cổng công bố kết quả BÁN tạm tính khỏi tính năng trả hàng (Q-206 — phase sau). Chương trình thật được công bố CMS
-- tạm tính tính từ các dòng bán đủ điều kiện nguồn BI hiện cung cấp; dòng điều chỉnh / âm vẫn KHÔNG được công bố.
--
-- Thay đổi (chỉ 2 hàm, CREATE OR REPLACE giữ chữ ký / owner / SECURITY DEFINER / search_path; không bảng / cột / trigger / RLS mới):
--   1. cms__results_release_open() (122): false → true. Vẫn IMMUTABLE SECURITY DEFINER, CHỈ owner (không cấp anon / authenticated /
--      service_role). Hàm này là cổng DB của publish (122) và một blocker của cms__lock_eval (124) — sau 126 chương trình thật không
--      còn blocker CMS_LOCK_RELEASE_GATE nhưng VẪN bị policy chặn (cms__lock_policy().real.ready = false — 126 không sửa policy /
--      payout / RLS).
--   2. rpc_cms_sales_run_publish(uuid) (122): thêm nhánh held RETURNS_NOT_SUPPORTED_THIS_PHASE cho chương trình thật khi dữ liệu ĐÃ
--      SEAL có điều chỉnh: seal_expect.totals.adjustment_lines ≠ 0 (seal bước 10 đối chiếu = số dòng kết quả ADJUSTMENT; S12 ép
--      ADJUSTMENT ⇔ dòng INCLUDED âm) HOẶC có dòng ứng viên không INCLUDED (chưa gán / ngoài phạm vi) lượng hoặc GMV âm đã stage.
--      Thiếu / sai định dạng totals ⇒ coi như có điều chỉnh (fail-closed). Không tin p_detail / tham số caller. Đóng dấu run công bố
--      chương trình thật: detail.results_basis = 'sales_only_v1', detail.results_gate = '126' (DB quyết định, trong transaction
--      publish; không đổi seal / vân tay dòng 14 trường; run QA giữ nguyên như 122). Giữ thứ tự khoá chương trình → run, kiểm lại
--      STALE / LOCKED / NOT_ACTIVE / CONFIG / MAPPING / cổng, nhánh idempotent 'already', lock_timeout 5s, ACL service_role.
--   Chương trình QA (is_test) không đổi hành vi (fixture điều chỉnh vẫn công bố trong namespace test).
--
-- Triển khai (runbook): sau 125, trong cửa sổ phát hành gộp; app candidate có releaseGate SALES_ONLY_V1. Khoá cms_sync_runs SHARE
-- ⇒ không mở / stage / publish run mới tới COMMIT; run đang chạy (nếu có) publish sau COMMIT đi qua thân mới. READ COMMITTED.
-- POST: `node scripts/cms-verify.mjs post --phase=126 --pre=<PRE chụp NGAY TRƯỚC 126>`. Sau 126, cms-verify phase 125 ĐỎ đúng
-- thiết kế (md5 2 hàm thay + cổng mở) ⇒ phase 126.
-- ROLLBACK: rollback/126_cms_sales_only_results_release_rollback.sql — khôi phục NGUYÊN VĂN 2 hàm 122 + ACL, xoá marker 126; KHÔNG xoá
-- run / snapshot đã công bố (pointer giữ nguyên). Vận hành: tắt CMS_EARNINGS_ENABLED trước, rồi mới rollback cổng nếu cần; ưu tiên
-- xử lý tiến. Có run bán THẬT thì đường rollback 122 vẫn bị guard cũ chặn (không nới). Gồm DELETE FROM app_migrations WHERE
-- version = '126'.
-- Vận hành: DÁN NGUYÊN FILE, nên GIỮ LF (md5 thân hàm bỏ \r — cùng công thức VERIFY md5(replace(prosrc, E'\r', ''))). Chạy bằng ĐÚNG
-- role owner bảng / hàm CMS (như 121–125).
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
-- Khoá TRƯỚC preflight: cms_sync_runs SHARE ⇒ không mở / stage / seal / publish run mới xen giữa (publish / seal ghi bảng run). Không
-- khoá bảng chương trình / cấu hình (126 không ghi dữ liệu).
LOCK TABLE public.cms_sync_runs IN SHARE MODE;

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_name text;
  v_acl  text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '126: cần READ COMMITTED';
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '125';
  IF v_name IS DISTINCT FROM 'cms_uncapped_last_tier' THEN
    RAISE EXCEPTION '126: thiếu migration nền 125 cms_uncapped_last_tier (name = %)', v_name;
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '126';
  IF FOUND THEN
    RAISE EXCEPTION '126: đã có marker 126 (name = %) — không chạy lại / không chạy chồng', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 125) THEN
    RAISE EXCEPTION '126: DB đã có migration số > 125 — dừng';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION '126: role chạy migration (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_programs'::regclass, 'public.cms_sync_runs'::regclass, 'public.cms_sales_lines'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '126: owner bảng / hàm CMS khác role chạy (%)', current_user;
  END IF;
  -- Nền 122 / 123 / 125: cổng DB đang đóng, policy chốt thật chưa sẵn sàng.
  IF public.cms__results_release_open() IS DISTINCT FROM false THEN
    RAISE EXCEPTION '126: cổng cms__results_release_open() không ở trạng thái đóng của 122 — dừng, đối chiếu tay';
  END IF;
  IF (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION '126: cms__lock_policy().real.ready khác false — 126 không áp lên policy chốt thật đã mở';
  END IF;
  -- ACL nền: helper chỉ owner; publish chỉ service_role.
  SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ',')
    INTO v_acl FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
   WHERE p.oid = 'public.cms__results_release_open()'::regprocedure AND x.grantee <> p.proowner;
  IF v_acl IS NOT NULL THEN RAISE EXCEPTION '126: ACL nền cms__results_release_open() có grant ngoài owner (%)', v_acl; END IF;
  SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ',')
    INTO v_acl FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
   WHERE p.oid = 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure AND x.grantee <> p.proowner;
  IF v_acl IS DISTINCT FROM 'service_role:EXECUTE' THEN
    RAISE EXCEPTION '126: ACL nền rpc_cms_sales_run_publish(uuid) khác service_role:EXECUTE (%)', v_acl;
  END IF;
END $$;
-- Thân 2 hàm sắp thay phải đúng nguyên văn 122 — khối sinh bởi gen-cms-126.mjs.
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__results_release_open()'::regprocedure) IS DISTINCT FROM 'd6b7f93f75ed7daafd9977463a3d0a3b'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure) IS DISTINCT FROM 'a12d10f071ac6ef93d6a35f9fa623c12' THEN
    RAISE EXCEPTION '126 preflight: thân cms__results_release_open / rpc_cms_sales_run_publish KHÁC bản 122 đã duyệt (md5) — dừng, đối chiếu tay';
  END IF;
END $$;

-- Inventory (chỉ số đếm; không PII) — NOTICE + ghi vào notes marker.
DO $$
BEGIN
  PERFORM set_config('cms126.inventory', jsonb_build_object(
    'programs_real', (SELECT count(*) FROM public.cms_programs WHERE NOT is_test),
    'programs_real_active', (SELECT count(*) FROM public.cms_programs WHERE NOT is_test AND status = 'active'),
    'sales_runs_real_published', (SELECT count(*) FROM public.cms_sync_runs WHERE kind = 'sales' AND NOT is_test AND published_at IS NOT NULL),
    'sales_runs_running', (SELECT count(*) FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running'))::text, true);
  RAISE NOTICE '126 inventory: %', current_setting('cms126.inventory');
END $$;

-- ── 1. Hai hàm 122 thay (sinh từ thân nguyên văn 122 + vá gen-cms-126) ────────
CREATE OR REPLACE FUNCTION public.cms__results_release_open()
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT true
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
    -- 126 (PM 06/11 sales-only — trả hàng phase sau): chương trình thật có dòng điều chỉnh ĐÃ SEAL hoặc dòng ứng viên âm ⇒ KHÔNG công
    -- bố (không bỏ dòng âm để công bố riêng phần dương). Căn cứ chỉ là dữ liệu đã seal: totals.adjustment_lines (seal bước 10 đối
    -- chiếu = số dòng kết quả ADJUSTMENT; S12 ép ADJUSTMENT ⇔ dòng INCLUDED âm) + dòng không INCLUDED (chưa gán / ngoài phạm vi) âm
    -- đã stage (index cms_sales_lines_excluded_idx). totals thiếu / sai dạng ⇒ coi như có điều chỉnh (fail-closed; CASE giữ thứ tự,
    -- không ép kiểu chuỗi lạ).
    WHEN NOT v_run.is_test AND (
           CASE WHEN jsonb_typeof(v_run.seal_expect -> 'totals' -> 'adjustment_lines') = 'number'
                     AND (v_run.seal_expect -> 'totals' ->> 'adjustment_lines') ~ '^(0|[1-9][0-9]{0,8})$'
                THEN (v_run.seal_expect -> 'totals' ->> 'adjustment_lines')::bigint <> 0
                ELSE true END
        OR EXISTS (SELECT 1 FROM public.cms_sales_lines sl
                    WHERE sl.run_id = p_run_id AND sl.disposition <> 'INCLUDED' AND (sl.base_quantity < 0 OR sl.gmv_amount < 0)))
      THEN 'RETURNS_NOT_SUPPORTED_THIS_PHASE'
  END;
  IF v_code IS NOT NULL THEN
    UPDATE public.cms_sync_runs SET status = CASE WHEN v_code = 'STALE' THEN 'error' ELSE 'held' END,
           finished_at = now(), error_code = v_code
     WHERE id = p_run_id;
    RETURN jsonb_build_object('published', false, 'code', v_code, 'run_id', p_run_id);
  END IF;
  v_prev := v_prog.current_result_run_id;
  -- 126: đóng dấu căn cứ kết quả do DB quyết định (không nhận từ caller) — chương trình thật = CMS tạm tính theo dòng bán, chưa xử
  -- lý trả hàng. Không đổi seal / vân tay dòng 14 trường; run QA giữ nguyên như 122.
  UPDATE public.cms_sync_runs SET status = 'ok', finished_at = now(), published_at = now(),
         detail = CASE WHEN v_run.is_test THEN detail
                       ELSE detail || jsonb_build_object('results_basis', 'sales_only_v1', 'results_gate', '126') END
   WHERE id = p_run_id;
  UPDATE public.cms_programs SET current_result_run_id = p_run_id WHERE id = v_pid;
  RETURN jsonb_build_object('published', true, 'already', false, 'run_id', p_run_id, 'previous_run_id', v_prev);
END;
$$;

-- ── 2. ACL: thu hồi đích danh rồi cấp đúng ma trận (gate ACL — áp cả hàm OR REPLACE) ──
REVOKE ALL ON FUNCTION public.cms__results_release_open(), public.rpc_cms_sales_run_publish(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_sales_run_publish(uuid) TO service_role;
-- Thu hồi mọi grant khác owner do default privileges cấp (bài học SEC-1 / 091 / 117 / 120–125).
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

-- ── 3. Hậu kiểm trong transaction ──────────────────────────────────────────
DO $$
DECLARE
  r   record;
  v_n integer;
BEGIN
  v_n := 0;
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
    v_n := v_n + 1;
    IF r.a OR r.u OR NOT r.prosecdef OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}')))
       OR r.acl IS DISTINCT FROM (CASE WHEN r.proname LIKE 'rpc\_%' THEN 'service_role:EXECUTE' END)
       OR r.s IS DISTINCT FROM (r.proname LIKE 'rpc\_%')
       OR (r.proname LIKE 'rpc\_%' AND (NOT ('lock_timeout=5s' = ANY (COALESCE(r.proconfig, '{}'))) OR r.provolatile <> 'v'))
       OR (r.proname = 'cms__results_release_open' AND (r.provolatile <> 'i' OR cardinality(r.proconfig) <> 1)) THEN
      RAISE EXCEPTION '126 hậu kiểm: ACL / SECDEF / search_path / lock_timeout / volatility hàm % sai (acl %, config %)', r.proname, r.acl, r.proconfig;
    END IF;
  END LOOP;
  IF v_n <> 2 THEN RAISE EXCEPTION '126 hậu kiểm: cần đúng 2 hàm thay OR REPLACE, có %', v_n; END IF;
  -- Tổng hàm CMS không đổi: 68 như sau 125 (126 chỉ thay thân).
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> 68 THEN RAISE EXCEPTION '126 hậu kiểm: tổng hàm CMS phải 68 (như 125), có %', v_n; END IF;
  -- Cổng kết quả bán mở; policy chốt thật VẪN đóng (126 không mở chốt / chi trả thật).
  IF public.cms__results_release_open() IS DISTINCT FROM true THEN
    RAISE EXCEPTION '126 hậu kiểm: cổng cms__results_release_open() chưa mở';
  END IF;
  IF (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION '126 hậu kiểm: policy chốt thật không được mở';
  END IF;
END $$;
-- Thân 2 hàm thay phải đúng bản sinh (md5) — khối sinh bởi gen-cms-126.mjs.
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__results_release_open()'::regprocedure) IS DISTINCT FROM 'aebe1ff46ba51dcf533fe328af7ea2a0'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure) IS DISTINCT FROM 'db2c97efad2bb5ee9d69399b99c7c258' THEN
    RAISE EXCEPTION '126 hậu kiểm: thân 2 hàm thay lệch bản sinh (md5)';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('126', 'cms_sales_only_results_release', 'PM 06/11 sales-only: cổng kết quả bán tạm tính mở (cms__results_release_open = true); '
  || 'publish chương trình thật chặn điều chỉnh / ứng viên âm (RETURNS_NOT_SUPPORTED_THIS_PHASE) + đóng dấu results_basis sales_only_v1; '
  || 'trả hàng (Q-206) phase sau; policy chốt thật giữ false · inventory ' || current_setting('cms126.inventory'));

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — `node scripts/cms-verify.mjs post --phase=126 --pre=<PRE chụp NGAY TRƯỚC 126>`) ──
-- Sau 126, cms-verify phase 125 ĐỎ đúng thiết kế (md5 2 hàm 122 thay, cổng mở) ⇒ manifest VERIFY phase 126 (CMS_FN_SRC_126 sinh bằng
-- scripts/gen-cms-verify-fp-126.mjs từ file migration).
-- V1 marker:
--   SELECT version, name, notes FROM public.app_migrations WHERE version IN ('125', '126') ORDER BY 1;
--   -- 125 cms_uncapped_last_tier · 126 cms_sales_only_results_release (notes: inventory số đếm)
-- V2 ACL 2 hàm:
--   SELECT p.oid::regprocedure fn, p.prosecdef, p.provolatile, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') authn, has_function_privilege('service_role', p.oid, 'EXECUTE') svc
--     FROM pg_proc p WHERE p.oid IN ('public.cms__results_release_open()'::regprocedure, 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure);
--   -- 2 dòng; anon / authn f; svc f helper, t publish; prosecdef t; helper i, publish v + lock_timeout=5s; search_path=public
-- V3 cổng + policy:
--   SELECT public.cms__results_release_open() AS release_open, public.cms__lock_policy() -> 'real' ->> 'ready' AS real_ready;  -- t · false
-- V4 run thật đã công bố sau 126 mang căn cứ (kỳ vọng 0 dòng thiếu dấu):
--   SELECT r.id FROM public.cms_sync_runs r JOIN public.app_migrations m ON m.version = '126'
--    WHERE r.kind = 'sales' AND NOT r.is_test AND r.published_at > m.applied_at
--      AND (r.detail ->> 'results_basis') IS DISTINCT FROM 'sales_only_v1';
-- V5 thân hàm / định nghĩa / bảng / trigger: `node scripts/cms-verify.mjs post --phase=126`.
