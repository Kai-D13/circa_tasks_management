
REVOKE ALL ON FUNCTION public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text) TO service_role;
-- Thu hồi grant khác owner do default privileges cấp cho hàm vừa tạo lại (như 123 §8).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.oid = 'public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)'::regprocedure
       AND x.grantee <> p.proowner AND x.grantee <> 'service_role'::regrole::oid
     GROUP BY x.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE 'REVOKE ALL ON FUNCTION public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text) FROM PUBLIC';
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text) FROM %I', pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- Payout về ràng buộc 123 (đã kiểm không có payout operator_reconciliation).
ALTER TABLE public.cms_payouts DROP CONSTRAINT cms_payouts_attestation;
ALTER TABLE public.cms_payouts DROP CONSTRAINT cms_payouts_source_complete_basis_check;
ALTER TABLE public.cms_payouts ADD CONSTRAINT cms_payouts_source_complete_basis_check
  CHECK (source_complete_basis IN ('qa_assumption', 'bi_watermark', 'lag_commitment'));
ALTER TABLE public.cms_payouts DROP COLUMN source_attestation_id;

-- Bảng mới (trigger đi theo bảng) + helper.
DROP TABLE public.cms_source_attestations;
DROP TABLE public.cms_sales_source_lines;
DROP FUNCTION public.cms__attest_eval(uuid, uuid);
DROP FUNCTION public.cms__attest_immutable();
DROP FUNCTION public.cms__attest_truncate_guard();
DROP FUNCTION public.cms__run_source_check(uuid);
DROP FUNCTION public.cms__program_scope_hash(uuid);
DROP FUNCTION public.cms__run_source_fp(uuid, text);
DROP FUNCTION public.cms__run_source_fp_text(uuid, text);
DROP FUNCTION public.cms__fp_j(text);
ALTER TABLE public.cms_sync_runs DROP COLUMN source_schema;

DO $$
BEGIN
  IF to_regclass('public.cms_source_attestations') IS NOT NULL OR to_regclass('public.cms_sales_source_lines') IS NOT NULL
     OR to_regprocedure('public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)') IS NULL
     OR NOT has_function_privilege('service_role', 'public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)', 'EXECUTE')
     OR (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ',')
           FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
          WHERE p.oid = 'public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)'::regprocedure AND x.grantee <> p.proowner)
        IS DISTINCT FROM 'service_role:EXECUTE'
     OR to_regprocedure('public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('cms_sync_runs', 'cms_payouts')
                   AND column_name IN ('source_schema', 'source_attestation_id'))
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.cms_payouts'::regclass
                     AND conname = 'cms_payouts_source_complete_basis_check'
                     AND pg_catalog.pg_get_constraintdef(oid) LIKE '%qa_assumption%bi_watermark%lag_commitment%'
                     AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%operator_reconciliation%')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.cms_payouts'::regclass AND conname = 'cms_payouts_attestation') THEN
    RAISE EXCEPTION 'rollback 124 hậu kiểm: chưa về trạng thái 123';
  END IF;
END $$;
-- @@MD5_CHECK@@
-- Hậu kiểm quyền / cấu hình / owner 6 hàm khôi phục (db-reviewer r2 P1-1 — gate ACL áp cả CREATE OR REPLACE) + tổng hàm CMS = 55 (123).
DO $$
DECLARE
  r     record;
  v_exp text;
  v_lt  text;
  v_n   integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proowner,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ',' ORDER BY 1)
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl
      FROM pg_catalog.pg_proc p
     WHERE p.oid IN ('public.rpc_cms_sales_run_open(uuid, jsonb)'::regprocedure, 'public.rpc_cms_sales_run_stage(uuid, text, integer, jsonb)'::regprocedure,
                     'public.rpc_cms_sales_run_cleanup(uuid, integer)'::regprocedure, 'public.cms__lock_eval(uuid, uuid, integer, text, boolean)'::regprocedure,
                     'public.rpc_cms_payout(uuid)'::regprocedure, 'public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)'::regprocedure)
  LOOP
    v_n := v_n + 1;
    v_exp := CASE r.proname WHEN 'rpc_cms_payout' THEN 'authenticated:EXECUTE' WHEN 'cms__lock_eval' THEN NULL ELSE 'service_role:EXECUTE' END;
    v_lt := CASE WHEN r.proname = 'rpc_cms_program_lock' THEN 'lock_timeout=3s'
                 WHEN r.proname IN ('rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_cleanup') THEN 'lock_timeout=5s' END;
    IF r.acl IS DISTINCT FROM v_exp OR NOT r.prosecdef OR has_function_privilege('anon', r.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', r.oid, 'EXECUTE') IS DISTINCT FROM (v_exp = 'authenticated:EXECUTE' AND v_exp IS NOT NULL)
       OR has_function_privilege('service_role', r.oid, 'EXECUTE') IS DISTINCT FROM (v_exp = 'service_role:EXECUTE' AND v_exp IS NOT NULL)
       OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}'))) OR (v_lt IS NOT NULL AND NOT (v_lt = ANY (COALESCE(r.proconfig, '{}'))))
       OR r.proowner <> (SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.cms_payouts'::regclass) THEN
      RAISE EXCEPTION 'rollback 124 hậu kiểm: ACL / SECDEF / config / owner hàm % sai (acl %)', r.proname, r.acl;
    END IF;
  END LOOP;
  IF v_n <> 6 THEN RAISE EXCEPTION 'rollback 124 hậu kiểm: cần đủ 6 hàm 122 / 123 khôi phục, có %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> 55 THEN RAISE EXCEPTION 'rollback 124 hậu kiểm: tổng hàm CMS phải về 55 (123), có %', v_n; END IF;
END $$;

DELETE FROM public.app_migrations WHERE version = '124';

COMMIT;
