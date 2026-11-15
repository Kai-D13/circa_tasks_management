
-- ── 9. ACL: thu hồi đích danh rồi cấp đúng ma trận (gate ACL — áp cả hàm OR REPLACE) ──
REVOKE ALL ON FUNCTION
@@REVOKE_LIST@@
  FROM PUBLIC, anon, authenticated, service_role;
@@GRANT_STMTS@@
-- Thu hồi mọi grant khác owner do default privileges cấp (bài học SEC-1 / 091 / 117 / 120–127), trừ đúng ma trận.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, a.grantee
      FROM (VALUES @@ACL_EXPECT_VALUES@@) AS x(sig, anon_x, auth_x, svc_x, acl)
      JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure('public.' || x.sig)
      CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE a.grantee <> p.proowner
       AND NOT (a.grantee = 'authenticated'::regrole::oid AND x.auth_x)
       AND NOT (a.grantee = 'service_role'::regrole::oid AND x.svc_x)
     GROUP BY p.oid, a.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;
@@TABLE_ACL@@
-- ── 10. Hậu kiểm trong transaction ─────────────────────────────────────────
DO $$
DECLARE
  r   record;
  v_n integer;
BEGIN
  v_n := 0;
  FOR r IN
    SELECT x.sig, x.anon_x, x.auth_x, x.svc_x, x.acl AS want, p.prosecdef, p.proconfig,
           (SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ','
                              ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END, a.privilege_type)
              FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) AS acl,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS a_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS u_x,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS s_x
      FROM (VALUES @@ACL_EXPECT_VALUES@@) AS x(sig, anon_x, auth_x, svc_x, acl)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure('public.' || x.sig)
  LOOP
    v_n := v_n + 1;
    IF r.prosecdef IS DISTINCT FROM true OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}')))
       OR r.a_x IS DISTINCT FROM r.anon_x OR r.u_x IS DISTINCT FROM r.auth_x OR r.s_x IS DISTINCT FROM r.svc_x
       OR r.acl IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION '130 hậu kiểm: % sai (SECDEF %, config %, acl % ≠ %, anon % auth % svc %)',
        r.sig, r.prosecdef, r.proconfig, r.acl, r.want, r.a_x, r.u_x, r.s_x;
    END IF;
  END LOOP;
  IF v_n <> @@N_ACL@@ THEN RAISE EXCEPTION '130 hậu kiểm: cần % hàm trong ma trận ACL, có %', @@N_ACL@@, v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> @@N_CMS_AFTER@@ THEN RAISE EXCEPTION '130 hậu kiểm: tổng hàm CMS phải @@N_CMS_AFTER@@ (@@N_CMS_BEFORE@@ + @@N_NEW@@ mới), có %', v_n; END IF;
  -- Dữ liệu cũ đúng backfill: không chương trình nào ngoài legacy_migration; không net; config_version / pointer không đổi (đếm).
  IF EXISTS (SELECT 1 FROM public.cms_programs
              WHERE quantity_basis IS DISTINCT FROM 'pos_base' OR quantity_basis_source <> 'legacy_migration'
                 OR returns_policy <> 'sales_only_v1' OR quantity_basis_set_by IS NOT NULL OR returns_policy_set_by IS NOT NULL) THEN
    RAISE EXCEPTION '130 hậu kiểm: backfill chương trình sai (cần pos_base / legacy_migration / sales_only_v1, không actor)';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger
       WHERE NOT tgisinternal AND tgenabled = 'A'
         AND ((tgrelid = 'public.cms_programs'::regclass AND tgname = 'cms_programs_basis_guard')
              OR (tgrelid = 'public.cms_program_products'::regclass AND tgname = 'cms_products_basis_guard'))) <> 2 THEN
    RAISE EXCEPTION '130 hậu kiểm: 2 trigger basis phải ENABLE ALWAYS';
  END IF;
  IF (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION '130 hậu kiểm: policy chốt thật không được mở';
  END IF;
END $$;
-- Thân hàm mới / thay phải đúng bản sinh (md5) — khối sinh bởi gen-cms-130.mjs.
-- @@POST_MD5@@

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('130', 'cms_calculation_modes_returns', jsonb_build_object(
  'candidate', 'CMS-CALC-RET-2 r2', 'new_functions', @@N_NEW@@, 'replaced_functions', @@N_REP@@,
  'inventory', current_setting('cms130.inventory')::jsonb)::text);

COMMIT;

-- @@VERIFY_BLOCK@@
