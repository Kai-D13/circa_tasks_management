-- ============================================================================
-- rollback/116_care_order_links_rollback_level1.sql — gỡ E mức 1 (giữ dữ liệu)
-- Điều kiện trước (E0 §12): CARE_IMPORT_CANCEL_ENABLED=false đã nạp và xác minh (không còn nút huỷ, action trả DISABLED);
-- cờ CARE_ORDER_LINKS_* tắt; operator tạm dừng import.
--
-- Mức 1:
--   * gate D1 về NGUYÊN VĂN 115; assess GIỮ bản 116 (115 + chặn huỷ khi task có link — bảng link vẫn còn, Q-182 tiếp tục đúng);
--   * bỏ hàm đồng bộ / đọc E, trigger freeze, trigger + hàm chặn chèn task kỳ đã chốt;
--   * GIỮ: 7 bảng + dữ liệu + FK, trigger dọn coverage khi xoá task (V12b), care_qa_delete_test_tasks, care_order_links_qa_counts,
--     care_period_end (CHECK của bảng giữ phụ thuộc);
--   * trả DELETE care_tasks cho service_role (app / fixture trước E xoá thẳng; trigger dọn coverage vẫn chạy);
--   * DELETE app_migrations '116'.
-- Chạy lại an toàn. Từ chối nếu có version > 116. Mức 2 (mất link, PM duyệt): _rollback_level2.sql.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
  v_md5 text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE version ~ '^[0-9]+$' AND version::int > 116) THEN
    RAISE EXCEPTION '116 rollback mức 1: DB đã có migration > 116 — dừng';
  END IF;
  IF current_user <> (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.care_tasks'::regclass) THEN
    RAISE EXCEPTION '116 rollback mức 1: phải chạy bằng owner của care_tasks';
  END IF;
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_cancel_gate(uuid,uuid,date)'::regprocedure;
  IF v_md5 NOT IN ('7ac1b8c50d7e8616183cce2159730062', '04c8d4081bb2f3e99ebd5cb07b3a5a54') THEN
    RAISE EXCEPTION '116 rollback mức 1: care__import_cancel_gate khác bản 115/116 (md5 %)', v_md5;
  END IF;
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_cancel_assess(uuid)'::regprocedure;
  IF v_md5 <> '19c8ae8c5a171a29fd9ca16509a3e0cd' THEN
    RAISE EXCEPTION '116 rollback mức 1: care__import_cancel_assess khác bản 116 (md5 %) — mức 1 chỉ chạy trên 116', v_md5;
  END IF;
END $$;

SELECT pg_advisory_xact_lock(hashtextextended('care_import:' || to_char(public.care_period_of(public.care_vn_today()), 'YYYY-MM-DD'), 0));

-- gate về nguyên văn 115 (ACL giữ nguyên: CREATE OR REPLACE không đổi quyền; 115/116 đều không cấp ai).
CREATE OR REPLACE FUNCTION public.care__import_cancel_gate(p_batch_id uuid, p_actor uuid, p_today date)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b public.care_import_batches%ROWTYPE;
BEGIN
  IF NOT (public.care__uid_is_super(p_actor) OR public.care__uid_can(p_actor, 'import')) THEN RETURN 'FORBIDDEN'; END IF;
  SELECT * INTO b FROM public.care_import_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF b.status <> 'committed' THEN RETURN 'NOT_COMMITTED'; END IF;
  IF b.period_month <> public.care_period_of(p_today) THEN RETURN 'NOT_CURRENT_PERIOD'; END IF;
  IF b.provenance_version IS NULL OR b.commit_seq IS NULL OR b.journal_rows IS NULL THEN RETURN 'PROVENANCE_UNAVAILABLE'; END IF;
  IF b.commit_seq <> (SELECT max(x.commit_seq) FROM public.care_import_batches x
                      WHERE x.period_month = b.period_month AND x.is_test = b.is_test AND x.status = 'committed') THEN
    RETURN 'NOT_LATEST';
  END IF;
  -- Batch committed commit_seq NULL cùng partition đều commit TRƯỚC 115 (rào care__require_commit_provenance) ⇒ cũ hơn B; không xét.
  RETURN NULL;
END $$;

ALTER FUNCTION public.care_import_cancel_preview(uuid, uuid) RESET lock_timeout;

DROP TRIGGER IF EXISTS care_tasks_freeze_cutoff ON public.care_tasks;
DROP TRIGGER IF EXISTS care_tasks_block_closed_period ON public.care_tasks;
DROP TRIGGER IF EXISTS care_customers_freeze_external_id ON public.care_customers;
DROP FUNCTION IF EXISTS public.care__tasks_freeze_cutoff();
DROP FUNCTION IF EXISTS public.care__customers_freeze_external_id();
DROP FUNCTION IF EXISTS public.care__tasks_block_closed_period();

DROP FUNCTION IF EXISTS public.care_order_links_begin_open(text, text, date, integer);
DROP FUNCTION IF EXISTS public.care__order_links_begin_open_at(text, text, date, integer, timestamptz);
DROP FUNCTION IF EXISTS public.care_order_links_begin_select(bigint, integer, integer);
DROP FUNCTION IF EXISTS public.care_order_links_run_job(bigint, integer);
DROP FUNCTION IF EXISTS public.care_order_links_job_done(bigint, integer, integer, integer, text);
DROP FUNCTION IF EXISTS public.care_order_links_apply_chunk(bigint, integer, integer, text[], jsonb);
DROP FUNCTION IF EXISTS public.care_order_links_complete(bigint);
DROP FUNCTION IF EXISTS public.care_order_links_fail(bigint, text);
DROP FUNCTION IF EXISTS public.care_order_links_trial_cleanup();
DROP FUNCTION IF EXISTS public.care__order_links_sweep(timestamptz);
DROP FUNCTION IF EXISTS public.care__order_links_end_run(bigint, text, text);
DROP FUNCTION IF EXISTS public.care__order_links_params_sha(bigint, integer);
DROP FUNCTION IF EXISTS public.care_task_orders(uuid, timestamptz, bigint, integer);
DROP FUNCTION IF EXISTS public.care_task_order_counts(uuid[]);
DROP FUNCTION IF EXISTS public.care_import_order_list(date, uuid[], uuid[], uuid, timestamptz, uuid, integer);
DROP FUNCTION IF EXISTS public.care_my_order_summary(uuid);
DROP FUNCTION IF EXISTS public.care_my_order_tasks(uuid, timestamptz, uuid, integer);
DROP FUNCTION IF EXISTS public.care_report_conversion_list(date, uuid[], uuid[], boolean, timestamptz, uuid, integer);
DROP FUNCTION IF EXISTS public.care_import_order_state(date);
DROP FUNCTION IF EXISTS public.care__utc_us(timestamptz);

GRANT DELETE ON public.care_tasks TO service_role;

DELETE FROM public.app_migrations WHERE version = '116';

DO $$
DECLARE
  v_n bigint;
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_cancel_gate(uuid,uuid,date)'::regprocedure) <> '7ac1b8c50d7e8616183cce2159730062' THEN
    RAISE EXCEPTION '116 rollback mức 1 hậu kiểm: gate chưa về bản 115';
  END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'care%';
  IF v_n <> 55 THEN RAISE EXCEPTION '116 rollback mức 1 hậu kiểm: % hàm care%% (kỳ vọng 51 + 4 giữ = 55)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'care\_%' AND c.relkind = 'r';
  IF v_n <> 22 THEN RAISE EXCEPTION '116 rollback mức 1 hậu kiểm: % bảng care_* (kỳ vọng 22 — giữ bảng E)', v_n; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid
      WHERE NOT g.tgisinternal AND c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'care\_%' AND g.tgenabled IN ('O', 'A')) <> 8
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = 'public.care_tasks'::regclass
                    AND g.tgname = 'care_tasks_drop_order_coverage' AND g.tgenabled = 'A') THEN
    RAISE EXCEPTION '116 rollback mức 1 hậu kiểm: trigger care_* phải là 7 của 114/115 + care_tasks_drop_order_coverage';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.care_tasks', 'DELETE') THEN
    RAISE EXCEPTION '116 rollback mức 1 hậu kiểm: service_role chưa có lại DELETE care_tasks';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '116') THEN
    RAISE EXCEPTION '116 rollback mức 1 hậu kiểm: còn app_migrations 116';
  END IF;
END $$;

COMMIT;
