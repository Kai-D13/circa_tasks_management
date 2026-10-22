-- ============================================================================
-- rollback/116_care_order_links_rollback_level2.sql — gỡ E mức 2 (MẤT link / coverage / trạng thái kỳ — PM duyệt riêng)
-- Điều kiện trước: như mức 1 (cờ huỷ D1 OFF đã xác minh, cờ E tắt, tạm dừng import).
-- Chạy được từ trạng thái 116 hoặc sau mức 1. gate + assess về NGUYÊN VĂN 115; DROP 4 trigger + mọi hàm E + 7 bảng +
-- dòng care_sync_state 'n3_import_orders' + care_period_end; trả DELETE care_tasks cho service_role; DELETE app_migrations '116'.
-- Từ chối nếu có version > 116. Chạy lại an toàn.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
  v_md5 text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE version ~ '^[0-9]+$' AND version::int > 116) THEN
    RAISE EXCEPTION '116 rollback mức 2: DB đã có migration > 116 — dừng';
  END IF;
  IF current_user <> (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.care_tasks'::regclass) THEN
    RAISE EXCEPTION '116 rollback mức 2: phải chạy bằng owner của care_tasks';
  END IF;
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_cancel_gate(uuid,uuid,date)'::regprocedure;
  IF v_md5 NOT IN ('7ac1b8c50d7e8616183cce2159730062', '04c8d4081bb2f3e99ebd5cb07b3a5a54') THEN
    RAISE EXCEPTION '116 rollback mức 2: care__import_cancel_gate khác bản 115/116 (md5 %)', v_md5;
  END IF;
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_cancel_assess(uuid)'::regprocedure;
  IF v_md5 NOT IN ('f3c441c3de1bd5bdd84383e460f7c942', '19c8ae8c5a171a29fd9ca16509a3e0cd') THEN
    RAISE EXCEPTION '116 rollback mức 2: care__import_cancel_assess khác bản 115/116 (md5 %)', v_md5;
  END IF;
END $$;

SELECT pg_advisory_xact_lock(hashtextextended('care_import:' || to_char(public.care_period_of(public.care_vn_today()), 'YYYY-MM-DD'), 0));

-- gate + assess về nguyên văn 115 (TRƯỚC khi DROP bảng mà bản 116 tham chiếu).
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

CREATE OR REPLACE FUNCTION public.care__import_cancel_assess(p_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b          public.care_import_batches%ROWTYPE;
  v_new      uuid[];
  v_mod      uuid[];
  v_all      uuid[];
  v_code     text := NULL;
BEGIN
  SELECT * INTO b FROM public.care_import_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('code', 'NOT_FOUND'); END IF;
  SELECT COALESCE(array_agg(t.id ORDER BY t.id), '{}') INTO v_new FROM public.care_tasks t WHERE t.batch_id = p_batch_id;
  SELECT COALESCE(array_agg(j.task_id ORDER BY j.task_id), '{}') INTO v_mod FROM public.care_import_revision_journal j WHERE j.batch_id = p_batch_id;
  v_all := v_new || v_mod;

  -- Hoạt động / phạm vi (Q-150).
  IF EXISTS (SELECT 1 FROM public.care_tasks t WHERE t.id = ANY (v_all)
             AND (t.status <> 'open' OR t.period_month <> b.period_month OR t.is_test <> b.is_test))
     OR EXISTS (SELECT 1 FROM public.care_interactions i WHERE i.task_id = ANY (v_all))
     OR EXISTS (SELECT 1 FROM public.care_assignment_events e WHERE e.task_id = ANY (v_all) AND e.kind = 'transferred')
     OR EXISTS (SELECT 1 FROM public.care_order_attributions a WHERE a.task_id = ANY (v_all))
     OR EXISTS (SELECT 1 FROM public.care_tasks t JOIN public.care_store_refusals r ON r.customer_id = t.customer_id AND r.store_id = t.store_id
                WHERE t.id = ANY (v_all)) THEN
    v_code := 'HAS_ACTIVITY';
  -- Bằng chứng khôi phục (§2.5 a–d + T_new ∩ T_mod = ∅).
  ELSIF EXISTS (SELECT 1 FROM unnest(v_new) n WHERE n = ANY (v_mod))
     OR (SELECT count(*) FROM public.care_import_revision_journal j WHERE j.batch_id = p_batch_id) IS DISTINCT FROM b.journal_rows::bigint
     OR EXISTS (SELECT 1 FROM public.care_task_products p WHERE p.batch_id = p_batch_id
                AND NOT (p.task_id = ANY (v_new))
                AND NOT EXISTS (SELECT 1 FROM public.care_import_revision_journal j
                                WHERE j.batch_id = p_batch_id AND j.task_id = p.task_id AND j.products_replaced))
     OR EXISTS (SELECT 1 FROM public.care_import_revision_journal j JOIN public.care_tasks t ON t.id = j.task_id
                WHERE j.batch_id = p_batch_id
                  AND ((t.customer_name, t.phone_norm, t.phone_raw) IS DISTINCT FROM (j.new_customer_name, j.new_phone_norm, j.new_phone_raw)
                       OR j.products_replaced <> (cardinality(j.prev_product_row_ids) >= 1)
                       OR (j.products_replaced AND (
                             EXISTS (SELECT 1 FROM public.care_task_products p WHERE p.task_id = j.task_id AND p.is_current AND p.batch_id <> p_batch_id)
                             OR EXISTS (SELECT 1 FROM public.care_task_products p WHERE p.task_id = j.task_id AND p.batch_id = p_batch_id AND NOT p.is_current)
                             OR NOT EXISTS (SELECT 1 FROM public.care_task_products p WHERE p.task_id = j.task_id AND p.batch_id = p_batch_id)
                             OR (SELECT count(*) FROM public.care_task_products p
                                 WHERE p.id = ANY (j.prev_product_row_ids) AND p.task_id = j.task_id AND p.batch_id <> p_batch_id AND NOT p.is_current)
                                <> cardinality(j.prev_product_row_ids)))
                       OR (NOT j.products_replaced AND EXISTS (SELECT 1 FROM public.care_task_products p WHERE p.task_id = j.task_id AND p.batch_id = p_batch_id))))
  THEN
    v_code := 'RESTORE_UNAVAILABLE';
  END IF;

  RETURN jsonb_build_object(
    'code', v_code,
    'tasks_deleted', cardinality(v_new),
    'tasks_restored', cardinality(v_mod),
    'products_deleted', (SELECT count(*) FROM public.care_task_products p WHERE p.batch_id = p_batch_id),
    'products_restored', (SELECT COALESCE(sum(cardinality(j.prev_product_row_ids)), 0) FROM public.care_import_revision_journal j WHERE j.batch_id = p_batch_id),
    'events_deleted', (SELECT count(*) FROM public.care_assignment_events e WHERE e.batch_id = p_batch_id AND e.kind = 'assigned' AND e.task_id = ANY (v_new)),
    'customers_deleted', (SELECT count(*) FROM public.care_customers c
                          WHERE c.created_batch_id = p_batch_id
                            AND NOT EXISTS (SELECT 1 FROM public.care_tasks t WHERE t.customer_id = c.id AND NOT (t.id = ANY (v_new)))
                            AND NOT EXISTS (SELECT 1 FROM public.care_interactions i WHERE i.customer_id = c.id)
                            AND NOT EXISTS (SELECT 1 FROM public.care_store_refusals r WHERE r.customer_id = c.id)
                            AND NOT EXISTS (SELECT 1 FROM public.care_reconcile_queue q WHERE q.customer_id = c.id)
                            AND NOT EXISTS (SELECT 1 FROM public.care_order_attributions a WHERE a.customer_id = c.id)));
END $$;

ALTER FUNCTION public.care_import_cancel_preview(uuid, uuid) RESET lock_timeout;

DROP TRIGGER IF EXISTS care_tasks_freeze_cutoff ON public.care_tasks;
DROP TRIGGER IF EXISTS care_tasks_block_closed_period ON public.care_tasks;
DROP TRIGGER IF EXISTS care_tasks_drop_order_coverage ON public.care_tasks;
DROP TRIGGER IF EXISTS care_customers_freeze_external_id ON public.care_customers;
DROP FUNCTION IF EXISTS public.care__tasks_freeze_cutoff();
DROP FUNCTION IF EXISTS public.care__customers_freeze_external_id();
DROP FUNCTION IF EXISTS public.care__tasks_block_closed_period();
DROP FUNCTION IF EXISTS public.care__tasks_drop_order_coverage();

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
DROP FUNCTION IF EXISTS public.care_qa_delete_test_tasks(uuid[]);
DROP FUNCTION IF EXISTS public.care_order_links_qa_counts(uuid[]);
DROP FUNCTION IF EXISTS public.care_task_orders(uuid, timestamptz, bigint, integer);
DROP FUNCTION IF EXISTS public.care_task_order_counts(uuid[]);
DROP FUNCTION IF EXISTS public.care_import_order_list(date, uuid[], uuid[], uuid, timestamptz, uuid, integer);
DROP FUNCTION IF EXISTS public.care_my_order_summary(uuid);
DROP FUNCTION IF EXISTS public.care_my_order_tasks(uuid, timestamptz, uuid, integer);
DROP FUNCTION IF EXISTS public.care_report_conversion_list(date, uuid[], uuid[], boolean, timestamptz, uuid, integer);
DROP FUNCTION IF EXISTS public.care_import_order_state(date);
DROP FUNCTION IF EXISTS public.care__utc_us(timestamptz);

DROP TABLE IF EXISTS public.care_order_links;
DROP TABLE IF EXISTS public.care_order_task_coverage;
DROP TABLE IF EXISTS public.care_order_run_chunks;
DROP TABLE IF EXISTS public.care_order_run_jobs;
DROP TABLE IF EXISTS public.care_order_run_tasks;
DROP TABLE IF EXISTS public.care_order_period_state;
DROP TABLE IF EXISTS public.care_order_runs;
DROP FUNCTION IF EXISTS public.care_period_end(date);

DELETE FROM public.care_sync_state WHERE source = 'n3_import_orders';
GRANT DELETE ON public.care_tasks TO service_role;
DELETE FROM public.app_migrations WHERE version = '116';

DO $$
DECLARE
  v_n bigint;
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_cancel_gate(uuid,uuid,date)'::regprocedure) <> '7ac1b8c50d7e8616183cce2159730062'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_cancel_assess(uuid)'::regprocedure) <> 'f3c441c3de1bd5bdd84383e460f7c942' THEN
    RAISE EXCEPTION '116 rollback mức 2 hậu kiểm: gate / assess chưa về bản 115';
  END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'care%';
  IF v_n <> 51 THEN RAISE EXCEPTION '116 rollback mức 2 hậu kiểm: % hàm care%% (kỳ vọng 51 như 115)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'care\_%' AND c.relkind = 'r';
  IF v_n <> 15 THEN RAISE EXCEPTION '116 rollback mức 2 hậu kiểm: % bảng care_* (kỳ vọng 15 như 115)', v_n; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid
      WHERE NOT g.tgisinternal AND c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'care\_%' AND g.tgenabled IN ('O', 'A')) <> 7 THEN
    RAISE EXCEPTION '116 rollback mức 2 hậu kiểm: số trigger care_* bật khác 7 (như 115)';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.care_tasks', 'DELETE')
     OR EXISTS (SELECT 1 FROM public.care_sync_state WHERE source = 'n3_import_orders')
     OR EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '116') THEN
    RAISE EXCEPTION '116 rollback mức 2 hậu kiểm: quyền DELETE / dòng sync_state / app_migrations sai';
  END IF;
END $$;

COMMIT;
