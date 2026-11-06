
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
-- @@MD5_CHECK@@
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
