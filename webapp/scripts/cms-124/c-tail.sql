
-- ── 9. Trigger bảng mới ─────────────────────────────────────────────────────
CREATE FUNCTION public.cms__attest_truncate_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'CMS_ATTEST_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$;

-- Lớp nguồn = dữ liệu run: cùng guard 123 (đóng băng sau chốt, chỉ owner / RPC ghi, TRUNCATE khi có payout ⇒ từ chối).
CREATE TRIGGER cms_frozen_ins AFTER INSERT ON public.cms_sales_source_lines REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_ins();
CREATE TRIGGER cms_frozen_upd AFTER UPDATE ON public.cms_sales_source_lines REFERENCING OLD TABLE AS cms_old NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_upd();
CREATE TRIGGER cms_frozen_del AFTER DELETE ON public.cms_sales_source_lines REFERENCING OLD TABLE AS cms_old
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_del();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_sales_source_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_frozen_truncate BEFORE TRUNCATE ON public.cms_sales_source_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_truncate_guard();
-- Chứng nhận: chỉ RPC (owner) ghi; dòng bất biến trừ chuyển thay thế / thu hồi trước chốt; không DELETE / TRUNCATE.
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_source_attestations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_attest_immutable BEFORE UPDATE OR DELETE ON public.cms_source_attestations
  FOR EACH ROW EXECUTE FUNCTION public.cms__attest_immutable();
-- r1 (db-reviewer P2-10): chặn INSERT chứng nhận cho chương trình đã chốt (kể cả owner); trigger riêng để đột biến test tắt được.
CREATE TRIGGER cms_attest_insert_guard BEFORE INSERT ON public.cms_source_attestations
  FOR EACH ROW EXECUTE FUNCTION public.cms__attest_immutable();
CREATE TRIGGER cms_attest_truncate BEFORE TRUNCATE ON public.cms_source_attestations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__attest_truncate_guard();
REVOKE ALL ON public.cms_sales_source_lines, public.cms_source_attestations FROM PUBLIC, anon, authenticated, service_role;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, t.tgname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
       AND c.relname IN ('cms_sales_source_lines', 'cms_source_attestations')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', r.relname, r.tgname);
  END LOOP;
END $$;

-- ── 10. ACL hàm ─────────────────────────────────────────────────────────────
-- 18 hàm = 13 mới / đổi chữ ký + 5 hàm thay bằng CREATE OR REPLACE (run_open, stage, cleanup, lock_eval, payout — gate ACL áp cả hàm
-- OR REPLACE; ma trận giữ đúng 122 / 123). Ma trận: 4 RPC 124 + rpc_cms_payout → authenticated; lock 6 tham số + run_open +
-- stage + cleanup → service_role; còn lại không ai ngoài owner.
REVOKE ALL ON FUNCTION
  public.cms__fp_j(text), public.cms__run_source_fp_text(uuid, text), public.cms__run_source_fp(uuid, text),
  public.cms__program_scope_hash(uuid), public.cms__run_source_check(uuid), public.cms__attest_immutable(),
  public.cms__attest_eval(uuid, uuid), public.cms__attest_truncate_guard(),
  public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid), public.rpc_cms_source_attest_revoke(uuid, text, uuid),
  public.rpc_cms_run_source_export(uuid, uuid, text, integer), public.rpc_cms_source_attestations(uuid),
  public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text, uuid),
  public.rpc_cms_sales_run_open(uuid, jsonb), public.rpc_cms_sales_run_stage(uuid, text, integer, jsonb),
  public.rpc_cms_sales_run_cleanup(uuid, integer), public.cms__lock_eval(uuid, uuid, integer, text, boolean), public.rpc_cms_payout(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid), public.rpc_cms_source_attest_revoke(uuid, text, uuid),
  public.rpc_cms_run_source_export(uuid, uuid, text, integer), public.rpc_cms_source_attestations(uuid),
  public.rpc_cms_payout(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text, uuid),
  public.rpc_cms_sales_run_open(uuid, jsonb), public.rpc_cms_sales_run_stage(uuid, text, integer, jsonb),
  public.rpc_cms_sales_run_cleanup(uuid, integer) TO service_role;
-- Thu hồi mọi grant khác owner do default privileges cấp (bài học SEC-1 / 091 / 117 / 120 / 122 / 123).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, x.grantee, p.proname
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('cms__fp_j', 'cms__run_source_fp_text', 'cms__run_source_fp', 'cms__program_scope_hash', 'cms__run_source_check',
                         'cms__attest_immutable', 'cms__attest_eval', 'cms__attest_truncate_guard', 'rpc_cms_source_attest',
                         'rpc_cms_source_attest_revoke', 'rpc_cms_run_source_export', 'rpc_cms_source_attestations', 'rpc_cms_program_lock',
                         'rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_cleanup', 'cms__lock_eval', 'rpc_cms_payout')
       AND x.grantee <> p.proowner
       AND NOT (p.proname IN ('rpc_cms_source_attest', 'rpc_cms_source_attest_revoke', 'rpc_cms_run_source_export', 'rpc_cms_source_attestations',
                              'rpc_cms_payout')
                AND x.grantee = 'authenticated'::regrole::oid)
       AND NOT (p.proname IN ('rpc_cms_program_lock', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_cleanup')
                AND x.grantee = 'service_role'::regrole::oid)
     GROUP BY p.oid, x.grantee, p.proname
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- ── 11. Hậu kiểm trong transaction ──────────────────────────────────────────
DO $$
DECLARE
  r     record;
  v_exp text;
  v_lt  text;
  v_n   integer;
BEGIN
  v_n := 0;
  FOR r IN
    SELECT p.proname, p.prosecdef, p.proconfig,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END
                              || ':' || x.privilege_type, ',' ORDER BY 1)
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl,
           has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
           has_function_privilege('service_role', p.oid, 'EXECUTE') s
      FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('cms__fp_j', 'cms__run_source_fp_text', 'cms__run_source_fp', 'cms__program_scope_hash', 'cms__run_source_check',
                         'cms__attest_immutable', 'cms__attest_eval', 'cms__attest_truncate_guard', 'rpc_cms_source_attest',
                         'rpc_cms_source_attest_revoke', 'rpc_cms_run_source_export', 'rpc_cms_source_attestations', 'rpc_cms_program_lock',
                         'rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_cleanup', 'cms__lock_eval', 'rpc_cms_payout')
  LOOP
    v_n := v_n + 1;
    v_exp := CASE WHEN r.proname IN ('rpc_cms_source_attest', 'rpc_cms_source_attest_revoke', 'rpc_cms_run_source_export',
                                     'rpc_cms_source_attestations', 'rpc_cms_payout') THEN 'authenticated:EXECUTE'
                  WHEN r.proname IN ('rpc_cms_program_lock', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_cleanup')
                    THEN 'service_role:EXECUTE' END;
    -- lock_timeout: 3 RPC ghi 124 = 2s (hạn CHỜ KHOÁ, không phải hạn tổng RPC); run_open / stage / cleanup giữ 5s như 122.
    v_lt := CASE WHEN r.proname IN ('rpc_cms_source_attest', 'rpc_cms_source_attest_revoke', 'rpc_cms_program_lock') THEN 'lock_timeout=2s'
                 WHEN r.proname IN ('rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_cleanup') THEN 'lock_timeout=5s' END;
    IF r.acl IS DISTINCT FROM v_exp OR r.a OR NOT r.prosecdef OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}')))
       OR r.u IS DISTINCT FROM COALESCE(v_exp = 'authenticated:EXECUTE', false)
       OR r.s IS DISTINCT FROM COALESCE(v_exp = 'service_role:EXECUTE', false)
       OR (v_lt IS NOT NULL AND NOT (v_lt = ANY (COALESCE(r.proconfig, '{}')))) THEN
      RAISE EXCEPTION '124 hậu kiểm: ACL / SECDEF / search_path / lock_timeout hàm % sai (acl %, config %)', r.proname, r.acl, r.proconfig;
    END IF;
  END LOOP;
  IF v_n <> 18 THEN RAISE EXCEPTION '124 hậu kiểm: cần đúng 18 hàm 124 (13 mới / đổi chữ ký + 5 thay OR REPLACE), có %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'rpc_cms_program_lock';
  IF v_n <> 1 THEN RAISE EXCEPTION '124 hậu kiểm: rpc_cms_program_lock phải còn đúng 1 chữ ký (6 tham số), có %', v_n; END IF;
  -- Tổng hàm CMS: 55 sau 123 + 12 (12 tên mới; lock đổi chữ ký giữ 1).
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> 67 THEN RAISE EXCEPTION '124 hậu kiểm: tổng hàm CMS phải 67, có %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_sales_source_lines'::regclass, 'public.cms_source_attestations'::regclass)
                AND (NOT c.relrowsecurity OR c.relforcerowsecurity
                     OR EXISTS (SELECT 1 FROM pg_catalog.pg_policies q WHERE q.schemaname = 'public' AND q.tablename = c.relname)
                     OR has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                     OR has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                     OR has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) THEN
    RAISE EXCEPTION '124 hậu kiểm: bảng mới phải RLS (không FORCE, 0 policy) và không quyền anon / authenticated / service_role';
  END IF;
  -- 9 trigger đúng tên / bảng / hàm / tgtype, ENABLE ALWAYS. tgtype = bit ROW 1 · BEFORE 2 · INSERT 4 · DELETE 8 · UPDATE 16 ·
  -- TRUNCATE 32 (không phụ thuộc thứ tự sự kiện khi deparse pg_get_triggerdef).
  SELECT count(*) INTO v_n
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN (VALUES
      ('cms_sales_source_lines', 'cms_frozen_ins', 'cms__frozen_data_ins', 4),            -- AFTER INSERT, statement
      ('cms_sales_source_lines', 'cms_frozen_upd', 'cms__frozen_data_upd', 16),           -- AFTER UPDATE, statement
      ('cms_sales_source_lines', 'cms_frozen_del', 'cms__frozen_data_del', 8),            -- AFTER DELETE, statement
      ('cms_sales_source_lines', 'cms_run_auth_guard', 'cms__run_auth_guard', 30),        -- BEFORE INSERT / UPDATE / DELETE, statement
      ('cms_sales_source_lines', 'cms_frozen_truncate', 'cms__frozen_truncate_guard', 34),-- BEFORE TRUNCATE
      ('cms_source_attestations', 'cms_run_auth_guard', 'cms__run_auth_guard', 30),
      ('cms_source_attestations', 'cms_attest_immutable', 'cms__attest_immutable', 27),   -- BEFORE UPDATE / DELETE, row
      ('cms_source_attestations', 'cms_attest_insert_guard', 'cms__attest_immutable', 7), -- BEFORE INSERT, row
      ('cms_source_attestations', 'cms_attest_truncate', 'cms__attest_truncate_guard', 34)
    ) AS e(rel, tg, fn, tt) ON e.rel = c.relname AND e.tg = t.tgname
   WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgenabled = 'A'
     AND t.tgfoid = ('public.' || e.fn || '()')::regprocedure AND t.tgtype = e.tt;
  IF v_n <> 9 OR (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
                   WHERE c.relname IN ('cms_sales_source_lines', 'cms_source_attestations') AND NOT t.tgisinternal) <> 9 THEN
    RAISE EXCEPTION '124 hậu kiểm: cần đúng 9 trigger (tên / hàm / thời điểm) ENABLE ALWAYS trên 2 bảng mới, khớp %', v_n;
  END IF;
  -- Cổng thật vẫn đóng.
  IF (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION '124 hậu kiểm: policy thật không được ready';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('124', 'cms_source_attestation', 'CMS COMP-INT: lớp nguồn run (source_lines 14 trường thô; run_open trả source_schema) + chứng nhận đối soát CHỈ decision10 gắn run / config / mapping / scope / vân tay cms-rows-fp-v1; basis operator_reconciliation; real.ready giữ false');

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — sẽ thành cms-verify --phase=124) ──────────
-- Sau 124, cms-verify phase 122 / 123 ĐỎ đúng thiết kế (md5 5 hàm thay, chữ ký lock, trigger tên-123 46 → 52, tổng hàm 55 → 67)
-- ⇒ manifest VERIFY cập nhật cùng phase 124.
-- V1 marker:
--   SELECT version, name FROM public.app_migrations WHERE version IN ('123', '124') ORDER BY 1;   -- cms_payouts, cms_source_attestation
-- V2 ACL 18 hàm (13 mới / đổi chữ ký + 5 thay):
--   SELECT p.oid::regprocedure fn, p.prosecdef, p.proconfig,
--          has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') authn,
--          has_function_privilege('service_role', p.oid, 'EXECUTE') svc,
--          (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ',')
--             FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) acl
--     FROM pg_proc p
--    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('cms__fp_j', 'cms__run_source_fp_text', 'cms__run_source_fp',
--      'cms__program_scope_hash', 'cms__run_source_check', 'cms__attest_immutable', 'cms__attest_eval', 'cms__attest_truncate_guard',
--      'rpc_cms_source_attest', 'rpc_cms_source_attest_revoke', 'rpc_cms_run_source_export', 'rpc_cms_source_attestations',
--      'rpc_cms_program_lock', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_cleanup', 'cms__lock_eval', 'rpc_cms_payout') ORDER BY 1;
--   -- 18 dòng; anon f toàn bộ; authn t đúng 5 (4 RPC 124 + rpc_cms_payout); svc t đúng 4 (lock 6 tham số, run_open, stage, cleanup);
--   -- acl đúng 1 grantee hoặc NULL; prosecdef t; proconfig ∋ search_path=public; attest / revoke / lock ∋ lock_timeout=2s;
--   -- run_open / stage / cleanup ∋ lock_timeout=5s.
-- V3 bảng + trigger:
--   SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) owner,
--          (SELECT count(*) FROM pg_policies q WHERE q.schemaname = 'public' AND q.tablename = c.relname) policies,
--          (SELECT string_agg(r || ':' || pr, ',') FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r
--             CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) pr
--            WHERE has_table_privilege(r, c.oid, pr)) api_privs
--     FROM pg_class c WHERE c.oid IN ('public.cms_sales_source_lines'::regclass, 'public.cms_source_attestations'::regclass);
--   -- rls t, force f, policies 0, api_privs NULL
--   SELECT c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
--    WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
--      AND c.relname IN ('cms_sales_source_lines', 'cms_source_attestations') ORDER BY 1, 2;   -- 9 dòng, tgenabled 'A'
-- V4 ràng buộc / cột / chữ ký / tổng hàm / cổng thật / môi trường:
--   SELECT conrelid::regclass, conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname IN ('cms_sync_run_chunks_part_check', 'cms_payouts_source_complete_basis_check', 'cms_payouts_attestation',
--                      'cms_source_attest_superseded_fk', 'cms_source_attest_fp', 'cms_source_attest_times') ORDER BY 1, 2;
--   SELECT pg_get_indexdef('public.cms_source_attest_one_live'::regclass);
--   -- bất biến COMP-P1-1 ở DDL — 2 dòng: CHECK ((field_set = 'decision10'::text)) · CHECK ((reference_rows_fp = run_rows_fp))
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.cms_source_attestations'::regclass AND contype = 'c'
--      AND pg_get_constraintdef(oid) ~ 'field_set|reference_rows_fp';
--   SELECT count(*) FILTER (WHERE field_set <> 'decision10') bad_fs, count(*) FILTER (WHERE reference_rows_fp <> run_rows_fp) bad_fp
--     FROM public.cms_source_attestations;                                                              -- 0 | 0
--   SELECT id FROM public.cms_sync_runs WHERE kind = 'sales' AND source_schema = 1 AND status = 'ok'
--      AND COALESCE((seal_expect ->> 'rows_rejected')::bigint, 0) <> 0;                                 -- 0 dòng (không chứng nhận được)
--   SELECT position('RETURNING id, source_schema INTO v_id, v_sch' IN prosrc) > 0
--     FROM pg_proc WHERE oid = 'public.rpc_cms_sales_run_open(uuid,jsonb)'::regprocedure;                  -- t (f sau rollback)
--   SELECT column_default FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'cms_sync_runs' AND column_name = 'source_schema';                -- 1
--   SELECT oid::regprocedure FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'rpc_cms_program_lock'; -- 1 dòng, 6 tham số
--   SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%'); -- 67
--   SELECT public.cms__lock_policy() -> 'real' ->> 'ready';                                                             -- false
--   SELECT current_setting('server_version_num')::int >= 140000,
--          (SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database());                 -- t, UTF8
-- V5 thân hàm / định nghĩa / bảng / trigger: `node scripts/cms-verify.mjs --phase=124` (manifest CMS_FN_MATRIX phase 124 sinh từ
--   file migration bằng scripts/gen-cms-verify-fp-124.mjs — không bao giờ từ DB cần kiểm).
