
-- ── Gỡ helper + cột (sau khi thân cũ không còn tham chiếu) ─────────────────
DROP FUNCTION public.cms__programs_basis_guard();
DROP FUNCTION public.cms__runs_basis_guard();
DROP FUNCTION public.cms__calc_snapshot(uuid);
DROP FUNCTION public.cms__basis_policy(text);
DROP FUNCTION public.cms__qty_dec(text);
DROP FUNCTION public.cms__unit_key(text);
ALTER TABLE public.cms_sync_runs DROP COLUMN calculation_snapshot, DROP COLUMN calculation_policy_version, DROP COLUMN quantity_basis;
ALTER TABLE public.cms_programs DROP COLUMN quantity_basis;

-- ── ACL 15 hàm khôi phục: thu hồi đích danh rồi cấp đúng ma trận trước 128 ──
REVOKE ALL ON FUNCTION
  public.cms__sales_snapshot(uuid), public.cms__config_fp(uuid), public.cms__attest_eval(uuid, uuid),
  public.cms__lock_eval(uuid, uuid, integer, text, boolean),
  public.rpc_cms_program_save(jsonb), public.rpc_cms_sales_run_open(uuid, jsonb), public.rpc_cms_sales_run_seal_begin(uuid, jsonb),
  public.rpc_cms_sales_run_seal_step(uuid, integer), public.rpc_cms_sales_run_publish(uuid), public.rpc_cms_sales_run_finish(uuid, text, jsonb),
  public.rpc_cms_result_header(uuid), public.rpc_cms_result_rows(uuid, uuid),
  public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer),
  public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid), public.rpc_cms_run_source_export(uuid, uuid, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.rpc_cms_program_save(jsonb), public.rpc_cms_sales_run_open(uuid, jsonb), public.rpc_cms_sales_run_seal_begin(uuid, jsonb),
  public.rpc_cms_sales_run_seal_step(uuid, integer), public.rpc_cms_sales_run_publish(uuid), public.rpc_cms_sales_run_finish(uuid, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.rpc_cms_result_header(uuid), public.rpc_cms_result_rows(uuid, uuid),
  public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer),
  public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid), public.rpc_cms_run_source_export(uuid, uuid, text, integer)
  TO authenticated;

-- ── Hậu kiểm ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r   record;
  v_n integer;
BEGIN
  v_n := 0;
  FOR r IN
    SELECT p.proname,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ','
                              ORDER BY CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END, x.privilege_type)
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl
      FROM pg_catalog.pg_proc p WHERE p.oid IN (SELECT unnest(ARRAY[@@ALL_SIGS_OLD@@]::regprocedure[]))
  LOOP
    v_n := v_n + 1;
    IF r.acl IS DISTINCT FROM (CASE WHEN r.proname IN (@@SVC_NAMES@@) THEN 'service_role:EXECUTE'
                                    WHEN r.proname IN (@@AUTH_NAMES@@) THEN 'authenticated:EXECUTE' END) THEN
      RAISE EXCEPTION 'rollback 128 hậu kiểm: ACL % = %', r.proname, r.acl;
    END IF;
  END LOOP;
  IF v_n <> 15 THEN RAISE EXCEPTION 'rollback 128 hậu kiểm: cần 15 hàm khôi phục, có %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> 68 THEN RAISE EXCEPTION 'rollback 128 hậu kiểm: tổng hàm CMS phải 68, có %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND ((table_name = 'cms_programs' AND column_name = 'quantity_basis')
                   OR (table_name = 'cms_sync_runs' AND column_name IN ('quantity_basis', 'calculation_policy_version', 'calculation_snapshot')))) THEN
    RAISE EXCEPTION 'rollback 128 hậu kiểm: còn cột cơ sở tính';
  END IF;
END $$;
-- @@MD5_CHECK@@

DELETE FROM public.app_migrations WHERE version = '128';

COMMIT;
