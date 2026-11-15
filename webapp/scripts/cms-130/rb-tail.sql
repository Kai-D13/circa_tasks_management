-- @@RESTORE_FUNCTIONS@@

-- ── Gỡ ledger trả hàng (chỉ tới đây khi các bảng ledger rỗng — preflight rb-head), theo thứ tự FK ─────────
ALTER TABLE public.cms_sync_runs DROP CONSTRAINT cms_sync_runs_ledger_eval_fk;
DROP TABLE public.cms_return_conflict_observations;
ALTER TABLE public.cms_return_conflicts DROP CONSTRAINT cms_return_conflicts_prev_fk;
DROP TABLE public.cms_return_conflict_restorations;
DROP TABLE public.cms_return_restorations;
DROP TABLE public.cms_return_conflicts;
DROP TABLE public.cms_return_baselines;
DROP TABLE public.cms_return_close_report_events;
DROP TABLE public.cms_return_close_report_lines;
DROP TABLE public.cms_return_close_reports;
DROP TABLE public.cms_return_ledger_evals;
ALTER TABLE public.cms_payouts DROP CONSTRAINT cms_payouts_program_run;

-- ── Gỡ bảng / cột run contract, dựng lại đúng 3 ràng buộc 122 / 124 ─────────
DROP TABLE public.cms_result_events;
DROP TABLE public.cms_return_lines;
ALTER TABLE public.cms_results
  DROP COLUMN return_count, DROP COLUMN return_gmv, DROP COLUMN sale_gmv, DROP COLUMN counted_sale_qty, DROP COLUMN eligible_base,
  DROP COLUMN eligible_return_base, DROP COLUMN eligible_sale_base, DROP COLUMN return_base, DROP COLUMN sale_base, DROP COLUMN net_v;
ALTER TABLE public.cms_sales_lines
  DROP COLUMN eligible_base, DROP COLUMN quantity_class, DROP COLUMN uom_src_flag, DROP COLUMN quantity_src_flag, DROP COLUMN uom_src,
  DROP COLUMN quantity_src, DROP COLUMN src_v;
ALTER TABLE public.cms_sales_source_lines
  DROP COLUMN uom_src_flag, DROP COLUMN quantity_src_flag, DROP COLUMN uom_src, DROP COLUMN quantity_src, DROP COLUMN src_v;
ALTER TABLE public.cms_sync_run_chunks DROP CONSTRAINT cms_sync_run_chunks_part_check;
ALTER TABLE public.cms_sync_run_chunks ADD CONSTRAINT cms_sync_run_chunks_part_check
  CHECK (part IN ('sales_lines', 'results', 'catalog', 'result_lines', 'source_lines'));
ALTER TABLE public.cms_sync_runs DROP CONSTRAINT cms_sync_runs_sales_publish;
ALTER TABLE public.cms_sync_runs DROP CONSTRAINT cms_sync_runs_seal_step_check;
ALTER TABLE public.cms_sync_runs
  DROP CONSTRAINT cms_sync_runs_contract_ok, DROP CONSTRAINT cms_sync_runs_ledger_shape, DROP CONSTRAINT cms_sync_runs_contract_sealed,
  DROP CONSTRAINT cms_sync_runs_returns_shape, DROP CONSTRAINT cms_sync_runs_contract_shape,
  DROP COLUMN ledger_eval_seq, DROP COLUMN ledger_checked_at, DROP COLUMN ledger_set_hash, DROP COLUMN ledger_verdict,
  DROP COLUMN returns_rows_read, DROP COLUMN returns_digest, DROP COLUMN returns_as_of, DROP COLUMN sales_src_digest,
  DROP COLUMN source_pin, DROP COLUMN status_dictionary_version, DROP COLUMN unit_key_version, DROP COLUMN calc_contract_version,
  DROP COLUMN returns_policy, DROP COLUMN quantity_policy_version, DROP COLUMN quantity_basis;
ALTER TABLE public.cms_sync_runs ADD CONSTRAINT cms_sync_runs_seal_step_check CHECK (seal_step IS NULL OR seal_step BETWEEN 0 AND 10);
ALTER TABLE public.cms_sync_runs ADD CONSTRAINT cms_sync_runs_sales_publish CHECK (kind <> 'sales' OR (
    ((status = 'ok') = (published_at IS NOT NULL))
    AND (published_at IS NULL OR (sealed_at IS NOT NULL AND amount_vnd IS NOT NULL))
    AND (sealed_at IS NULL OR (seal_expect IS NOT NULL AND seal_step = 10))
    AND (purged_at IS NULL OR status <> 'running')
    AND (cleared_at IS NULL OR purged_at IS NOT NULL)));

-- ── Gỡ trigger / cột / hàm mới ──────────────────────────────────────────────
DROP TRIGGER cms_products_basis_guard ON public.cms_program_products;
DROP TRIGGER cms_programs_basis_guard ON public.cms_programs;
ALTER TABLE public.cms_programs
  DROP COLUMN returns_policy_set_at,
  DROP COLUMN returns_policy_set_by,
  DROP COLUMN returns_policy,
  DROP COLUMN quantity_basis_set_at,
  DROP COLUMN quantity_basis_set_by,
  DROP COLUMN quantity_basis_source,
  DROP COLUMN quantity_basis;
@@DROP_FUNCTIONS@@

DELETE FROM public.app_migrations WHERE version = '130';

DO $$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> @@N_CMS_BEFORE@@ THEN RAISE EXCEPTION 'rollback 130 hậu kiểm: tổng hàm CMS phải @@N_CMS_BEFORE@@ như nền 127, có %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
              WHERE attrelid = 'public.cms_programs'::regclass AND attname IN ('quantity_basis', 'returns_policy') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'rollback 130 hậu kiểm: còn cột 130 trên cms_programs';
  END IF;
END $$;
-- Quyền các hàm dựng lại = nền (db-reviewer 14/11 P2-8): anon không; authenticated / service_role đúng ma trận; SECDEF + search_path.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.sig, x.auth_x, x.svc_x, p.prosecdef, p.proconfig,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS a_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS u_x,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS s_x
      FROM (VALUES @@RB_ACL_VALUES@@) AS x(sig, auth_x, svc_x)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure('public.' || x.sig)
  LOOP
    IF r.prosecdef IS DISTINCT FROM true OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}')))
       OR r.a_x IS DISTINCT FROM false OR r.u_x IS DISTINCT FROM r.auth_x OR r.s_x IS DISTINCT FROM r.svc_x THEN
      RAISE EXCEPTION 'rollback 130 hậu kiểm: quyền % sai (SECDEF %, config %, anon % auth % svc %)',
        r.sig, r.prosecdef, r.proconfig, r.a_x, r.u_x, r.s_x;
    END IF;
  END LOOP;
END $$;
-- @@RB_POST_MD5@@

COMMIT;
