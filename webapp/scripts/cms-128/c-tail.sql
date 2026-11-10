
-- ── 7. ACL: thu hồi đích danh rồi cấp đúng ma trận (gate ACL — cả @@N_NEW@@ hàm mới lẫn @@N_REP@@ hàm OR REPLACE; danh sách sinh từ generator) ──
REVOKE ALL ON FUNCTION
@@REVOKE_LIST@@
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
@@SVC_LIST@@
  TO service_role;
GRANT EXECUTE ON FUNCTION
@@AUTH_LIST@@
  TO authenticated;
-- Thu hồi mọi grant khác owner do default privileges cấp (bài học SEC-1 / 091 / 117 / 120–126).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, x.grantee
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.oid IN (SELECT unnest(ARRAY[@@ALL_SIGS@@]::regprocedure[]))
       AND x.grantee <> p.proowner
       AND NOT (p.proname IN (@@SVC_NAMES@@) AND x.grantee = 'service_role'::regrole::oid)
       AND NOT (p.proname IN (@@AUTH_NAMES@@) AND x.grantee = 'authenticated'::regrole::oid)
     GROUP BY p.oid, x.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- ── 8. Hậu kiểm trong transaction ──────────────────────────────────────────
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
     WHERE p.oid IN (SELECT unnest(ARRAY[@@ALL_SIGS@@]::regprocedure[]))
  LOOP
    v_n := v_n + 1;
    IF r.a OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}')))
       OR (r.proname NOT IN ('cms__programs_basis_guard', 'cms__runs_basis_guard') AND NOT r.prosecdef)
       OR r.acl IS DISTINCT FROM (CASE WHEN r.proname IN (@@SVC_NAMES@@) THEN 'service_role:EXECUTE'
                                       WHEN r.proname IN (@@AUTH_NAMES@@) THEN 'authenticated:EXECUTE' END)
       OR r.s IS DISTINCT FROM (r.proname IN (@@SVC_NAMES@@))
       OR r.u IS DISTINCT FROM (r.proname IN (@@AUTH_NAMES@@))
       OR (r.proname IN (@@SVC_NAMES@@) AND (NOT ('lock_timeout=5s' = ANY (COALESCE(r.proconfig, '{}'))) OR r.provolatile <> 'v'))
       OR (r.proname = 'rpc_cms_sales_run_seal_step' AND NOT ('enable_nestloop=off' = ANY (COALESCE(r.proconfig, '{}'))))
       OR (r.proname IN ('cms__unit_key', 'cms__qty_dec', 'cms__basis_policy', 'cms__units_invalid') AND r.provolatile <> 'i') THEN
      RAISE EXCEPTION '128 hậu kiểm: ACL / SECDEF / search_path / lock_timeout / volatility hàm % sai (acl %, config %)', r.proname, r.acl, r.proconfig;
    END IF;
  END LOOP;
  IF v_n <> @@N_ALL@@ THEN RAISE EXCEPTION '128 hậu kiểm: cần đúng @@N_ALL@@ hàm (@@N_NEW@@ mới + @@N_REP@@ thay), có %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> @@N_CMS_AFTER@@ THEN RAISE EXCEPTION '128 hậu kiểm: tổng hàm CMS phải @@N_CMS_AFTER@@ (@@N_CMS_BEFORE@@ + @@N_NEW@@ mới), có %', v_n; END IF;
  -- Cột / ràng buộc / trigger mới.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'public.cms_programs'::regclass AND a.attname = 'quantity_basis'
                  AND a.attnotnull AND NOT a.attisdropped)
     OR (SELECT count(*) FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'public.cms_sync_runs'::regclass AND NOT a.attisdropped
          AND a.attname IN ('quantity_basis', 'calculation_policy_version', 'calculation_snapshot')) <> 3
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.cms_programs'::regclass
                     AND conname = 'cms_programs_quantity_basis_check' AND convalidated)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.cms_sync_runs'::regclass
                     AND conname = 'cms_sync_runs_basis_shape' AND convalidated) THEN
    RAISE EXCEPTION '128 hậu kiểm: thiếu cột / ràng buộc cơ sở tính';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgenabled = 'A'
         AND ((t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_basis_guard'
               AND t.tgfoid = 'public.cms__programs_basis_guard()'::regprocedure)
           OR (t.tgrelid = 'public.cms_sync_runs'::regclass AND t.tgname = 'cms_sync_runs_basis_guard'
               AND t.tgfoid = 'public.cms__runs_basis_guard()'::regprocedure))) <> 2 THEN
    RAISE EXCEPTION '128 hậu kiểm: thiếu trigger guard cơ sở tính (ENABLE ALWAYS)';
  END IF;
  -- Không đổi cơ sở / pointer / tiền của chương trình nào; mọi run bán cũ mang nhãn legacy.
  IF EXISTS (SELECT 1 FROM public.cms_programs WHERE quantity_basis <> 'pos_base')
     OR EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales'
                 AND (quantity_basis IS DISTINCT FROM 'pos_base' OR calculation_policy_version IS DISTINCT FROM 'pos_base_legacy'
                      OR calculation_snapshot IS NOT NULL))
     OR EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'products'
                 AND (quantity_basis IS NOT NULL OR calculation_policy_version IS NOT NULL OR calculation_snapshot IS NOT NULL)) THEN
    RAISE EXCEPTION '128 hậu kiểm: cơ sở chương trình / nhãn run cũ sai';
  END IF;
  -- Cổng / policy giữ nguyên.
  IF public.cms__results_release_open() IS DISTINCT FROM true
     OR (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION '128 hậu kiểm: cổng kết quả / policy chốt bị đổi';
  END IF;
  -- Hằng hợp đồng khoá đơn vị (mẫu cố định, cùng bảng TS): parity tối thiểu ngay trong transaction.
  IF public.cms__unit_key(' Hộp ') IS DISTINCT FROM 'hộp' OR public.cms__unit_key(E'HỘP') IS DISTINCT FROM 'hộp'
     OR public.cms__unit_key('VỈ') IS DISTINCT FROM 'vỉ' OR public.cms__unit_key('ĐƯỜNG') IS DISTINCT FROM 'đường'
     OR public.cms__unit_key(chr(160) || 'BOX' || chr(12288)) IS DISTINCT FROM 'box' OR public.cms__unit_key(E'hộp\t') IS NOT NULL
     -- r1 Q-225 (khoá v2): ký tự vô hình ở đầu / giữa / cuối ⇒ không hợp lệ (FEFF không còn bị cắt).
     OR public.cms__unit_key('h' || chr(8203) || 'ộp') IS NOT NULL OR public.cms__unit_key('hộp' || chr(65279)) IS NOT NULL
     OR public.cms__unit_key(chr(173) || 'hộp') IS NOT NULL OR public.cms__unit_key(chr(8206) || 'hộp') IS NOT NULL
     OR public.cms__units_invalid(ARRAY['hộp', 'Vỉ']) OR NOT public.cms__units_invalid(ARRAY['hộp', 'h' || chr(8288) || 'ộp'])
     OR public.cms__unit_key('   ') IS NOT NULL OR public.cms__qty_dec('1.000000000') IS DISTINCT FROM 1
     OR public.cms__qty_dec('1e3') IS NOT NULL OR public.cms__qty_dec('0.0000000001') IS NOT NULL THEN
    RAISE EXCEPTION '128 hậu kiểm: helper khoá đơn vị / lượng lệch hợp đồng';
  END IF;
END $$;
-- Thân @@N_ALL@@ hàm (@@N_NEW@@ mới + @@N_REP@@ thay) phải đúng bản sinh (md5) — khối sinh bởi gen-cms-128.mjs.
-- @@POST_MD5@@

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('128', 'cms_unit_quantity_basis', 'CMS-UNIT capability (Q-221…Q-224): cms_programs.quantity_basis pos_base | cms_unit (mặc định '
  || 'pos_base — không đổi chương trình nào); metadata tính bất biến theo run (quantity_basis / calculation_policy_version / '
  || 'calculation_snapshot; run bán cũ = pos_base_legacy); seal 7 / 10 nhánh cms_unit + dấu writer; publish / chứng nhận / chốt / đọc '
  || 'theo cơ sở của run; cms_unit chặn chứng nhận decision10; PM r1 10/11: khoá đơn vị v2 (ký tự vô hình ⇒ không hợp lệ), publish '
  || 'cms_unit đối chiếu lớp nguồn (UNIT_SOURCE_MISMATCH), import / kích hoạt / lưu chặn ĐV tính CMS không hợp lệ · inventory '
  || current_setting('cms128.inventory'));

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — `node scripts/cms-verify.mjs post --phase=128 --pre=<PRE chụp NGAY TRƯỚC 128>`) ──
-- Sau 128, cms-verify phase 127 ĐỎ đúng thiết kế (@@N_NEW@@ hàm mới, @@N_REP@@ thân thay, cột / ràng buộc / trigger mới) ⇒ phase 128 (CMS_FN_SRC_128
-- sinh bằng scripts/gen-cms-verify-fp-128.mjs từ file migration).
-- V1 marker:
--   SELECT version, name, notes FROM public.app_migrations WHERE version IN ('127', '128') ORDER BY 1;
-- V2 cơ sở chương trình + nhãn run (kỳ vọng: mọi chương trình pos_base; run bán cũ pos_base_legacy, snapshot NULL):
--   SELECT quantity_basis, count(*) FROM public.cms_programs GROUP BY 1;
--   SELECT kind, quantity_basis, calculation_policy_version, calculation_snapshot IS NULL AS snap_null, count(*)
--     FROM public.cms_sync_runs GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3;
-- V3 ACL @@N_ALL@@ hàm: @@N_OWNER@@ hàm chỉ owner (anon / authenticated / service_role f); @@N_SVC@@ rpc_cms_* ghi service_role;
--   @@N_AUTH@@ rpc đọc / chứng nhận authenticated; seal_step giữ enable_nestloop=off — `cms-verify post --phase=128`.
-- V4 hành vi (READ ONLY): SELECT public.cms__unit_key(' Hộp '), public.cms__qty_dec('2.000000000');   -- hộp · 2.000000000
--   SELECT public.cms__unit_key('hộp' || chr(65279)) IS NULL;                                         -- true (khoá v2, Q-225)
