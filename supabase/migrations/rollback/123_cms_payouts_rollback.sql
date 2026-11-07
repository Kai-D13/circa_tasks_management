-- ============================================================================
-- ROLLBACK 123_cms_payouts.sql  (r0.4 — DRAFT P3a, CHƯA audit PM) — CHỈ khi KHÔNG có chương trình THẬT 'locked'.
-- Có chương trình thật đã chốt ⇒ KHÔNG rollback (số chốt là bằng chứng chi trả): tắt CMS_LOCK_ENABLED và xử lý tiến.
-- Chương trình QA (is_test) đã chốt GIỮ 'locked' (H8 — không mở lại); payout QA bị xoá cùng bảng. Runbook phải nói rõ trước
-- khi QA chốt trên prod.
-- Xoá: 2 bảng payout + 18 hàm 123 + 46 trigger; trả cms_readable_program_ids() về thân 120 (SM chỉ 'active'); trả quyền
-- TRUNCATE cho service_role trên 10 bảng 120 / 122 (GRANT ALL cũ); DELETE marker 123. Transaction: lỗi giữa chừng ⇒ không đổi gì.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '123' AND name = 'cms_payouts') THEN
    RAISE EXCEPTION 'rollback 123: không có marker 123 cms_payouts';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 123) THEN
    RAISE EXCEPTION 'rollback 123: đã có migration số > 123 — rollback migration sau trước';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE version ~ '^123[a-z]+$') THEN
    RAISE EXCEPTION 'rollback 123: đã có marker 123<chữ> — rollback migration đó trước';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_programs WHERE status = 'locked' AND NOT is_test) THEN
    RAISE EXCEPTION 'rollback 123: đã có chương trình thật locked — không rollback; tắt cờ và xử lý tiến';
  END IF;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cms_sync_run_chunks', 'cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_result_lines'] LOOP
    EXECUTE format('DROP TRIGGER cms_frozen_ins ON public.%I', t);
    EXECUTE format('DROP TRIGGER cms_frozen_upd ON public.%I', t);
    EXECUTE format('DROP TRIGGER cms_frozen_del ON public.%I', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['cms_program_products', 'cms_program_tiers', 'cms_program_stores'] LOOP
    EXECUTE format('DROP TRIGGER cms_config_lock_guard ON public.%I', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['cms_programs', 'cms_program_products', 'cms_program_tiers', 'cms_program_stores'] LOOP
    EXECUTE format('DROP TRIGGER cms_config_auth_guard ON public.%I', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['cms_sync_runs', 'cms_sync_run_chunks', 'cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_result_lines'] LOOP
    EXECUTE format('DROP TRIGGER cms_run_auth_guard ON public.%I', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['cms_programs', 'cms_program_products', 'cms_program_tiers', 'cms_program_stores', 'cms_sync_runs',
                           'cms_sync_run_chunks', 'cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_result_lines'] LOOP
    EXECUTE format('DROP TRIGGER cms_frozen_truncate ON public.%I', t);
    EXECUTE format('GRANT TRUNCATE ON public.%I TO service_role', t);
  END LOOP;
END $$;
DROP TRIGGER cms_frozen_run_row ON public.cms_sync_runs;
DROP TRIGGER cms_programs_lock_guard ON public.cms_programs;

-- Bảng payout (trigger của chúng đi cùng DROP TABLE; DROP không kích hoạt trigger DELETE / TRUNCATE).
DROP TABLE public.cms_payout_staff;
DROP TABLE public.cms_payouts;

DROP FUNCTION public.rpc_cms_payout(uuid);
DROP FUNCTION public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text);
DROP FUNCTION public.rpc_cms_lock_preview(uuid);
DROP FUNCTION public.cms__frozen_truncate_guard();
DROP FUNCTION public.cms__config_auth_guard();
DROP FUNCTION public.cms__run_auth_guard();
DROP FUNCTION public.cms__programs_lock_guard();
DROP FUNCTION public.cms__config_lock_guard();
DROP FUNCTION public.cms__payout_insert_guard();
DROP FUNCTION public.cms__payout_immutable();
DROP FUNCTION public.cms__frozen_run_row();
DROP FUNCTION public.cms__frozen_data_del();
DROP FUNCTION public.cms__frozen_data_upd();
DROP FUNCTION public.cms__frozen_data_ins();
DROP FUNCTION public.cms__frozen_runs_guard(uuid[]);
DROP FUNCTION public.cms__lock_eval(uuid, uuid, integer, text, boolean);
DROP FUNCTION public.cms__config_fp(uuid);
DROP FUNCTION public.cms__lock_policy();

-- Thân 120 nguyên văn (SM chỉ 'active'); CREATE OR REPLACE giữ ACL.
CREATE OR REPLACE FUNCTION public.cms_readable_program_ids()
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (
    SELECT u.id, u.role, u.store_id,
           public.is_super_admin() AS su,
           public.cms_has_qa_access() AS qa,
           COALESCE(s.store_type = 'os' AND s.is_active, false) AS store_ok
      FROM public.users u
      LEFT JOIN public.stores s ON s.id = u.store_id
     WHERE u.id = auth.uid()
  ), sm_stores AS (
    SELECT a.store_id
      FROM me
      JOIN public.sm_store_assignments a ON a.sm_user_id = me.id
      JOIN public.stores s ON s.id = a.store_id
     WHERE me.role = 'sm' AND s.store_type = 'os' AND s.is_active
  )
  SELECT COALESCE(array_agg(p.id ORDER BY p.id), '{}'::uuid[])
    FROM public.cms_programs p
   CROSS JOIN me
   WHERE (NOT p.is_test OR me.qa)
     AND (
       me.su
       OR (me.role IN ('staff', 'store_manager') AND me.store_ok AND p.status IN ('active', 'locked')
           AND EXISTS (SELECT 1 FROM public.cms_program_stores ps WHERE ps.program_id = p.id AND ps.store_id = me.store_id))
       OR (me.role = 'sm' AND p.status = 'active'
           AND EXISTS (SELECT 1 FROM public.cms_program_stores ps JOIN sm_stores x ON x.store_id = ps.store_id
                        WHERE ps.program_id = p.id))
     )
$$;

DO $$
BEGIN
  IF to_regclass('public.cms_payouts') IS NOT NULL OR to_regclass('public.cms_payout_staff') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback 123 hậu kiểm: còn bảng payout';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND (p.proname LIKE 'cms\_%' OR p.proname LIKE 'rpc\_cms\_%')) <> 37 THEN
    RAISE EXCEPTION 'rollback 123 hậu kiểm: tổng hàm CMS khác 37 (về 122)';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.cms_sales_lines', 'TRUNCATE')
     OR NOT has_table_privilege('service_role', 'public.cms_programs', 'TRUNCATE') THEN
    RAISE EXCEPTION 'rollback 123 hậu kiểm: chưa trả TRUNCATE cho service_role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
              WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
                AND t.tgname IN ('cms_frozen_ins', 'cms_frozen_upd', 'cms_frozen_del', 'cms_config_lock_guard', 'cms_config_auth_guard', 'cms_run_auth_guard',
                                 'cms_frozen_truncate', 'cms_frozen_run_row', 'cms_programs_lock_guard')) THEN
    RAISE EXCEPTION 'rollback 123 hậu kiểm: còn trigger 123';
  END IF;
END $$;

DELETE FROM public.app_migrations WHERE version = '123';

COMMIT;
