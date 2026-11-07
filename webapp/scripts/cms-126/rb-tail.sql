
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
-- @@MD5_CHECK@@
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
