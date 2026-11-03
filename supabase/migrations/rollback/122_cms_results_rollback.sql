-- ============================================================================
-- ROLLBACK 122_cms_results.sql — CHỈ khi CHƯA có run sales của chương trình thật (chỉ dữ liệu QA is_test).
-- Đã có run sales của chương trình thật ⇒ KHÔNG rollback: tắt CMS_EARNINGS_ENABLED / cron sync-cms-sales và xử lý tiến.
-- Xoá: 5 bảng kết quả (kèm index) + 23 hàm 122 + trigger pointer + cột / ràng buộc mới trên cms_sync_runs / cms_programs; xoá run
-- 'sales' (QA); trả cms_sync_runs_kind_check về ('products'); gỡ 2 index 122 trên bảng 120 (cms_sync_runs_program_idx,
-- cms_program_tiers_product_from_idx UNIQUE tra bậc); DELETE marker 122. Không đụng dữ liệu / đối tượng khác của 120 / 121.
-- Transaction: lỗi giữa chừng ⇒ không đổi gì.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '122' AND name = 'cms_results') THEN
    RAISE EXCEPTION 'rollback 122: không có marker 122 cms_results';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 122) THEN
    RAISE EXCEPTION 'rollback 122: đã có migration số > 122 — rollback migration sau trước';
  END IF;
  -- Marker chữ vá hàm 122 (vd. 122a mở cổng Q-206) ⇒ rollback migration đó trước (db-reviewer P2-10).
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE version ~ '^122[a-z]+$') THEN
    RAISE EXCEPTION 'rollback 122: đã có marker 122<chữ> — rollback migration đó trước';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs r JOIN public.cms_programs p ON p.id = r.program_id
              WHERE r.kind = 'sales' AND NOT p.is_test) THEN
    RAISE EXCEPTION 'rollback 122: đã có run sales của chương trình thật — không rollback; tắt cờ và xử lý tiến';
  END IF;
END $$;

DROP TRIGGER cms_programs_result_guard ON public.cms_programs;
UPDATE public.cms_programs SET current_result_run_id = NULL WHERE current_result_run_id IS NOT NULL;

DROP FUNCTION public.rpc_cms_result_excluded(uuid, uuid, integer, integer);
DROP FUNCTION public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer);
DROP FUNCTION public.rpc_cms_result_rows(uuid, uuid);
DROP FUNCTION public.rpc_cms_result_header(uuid);
DROP FUNCTION public.rpc_cms_sales_run_cleanup(uuid, integer);
DROP FUNCTION public.rpc_cms_sales_run_finish(uuid, text, jsonb);
DROP FUNCTION public.rpc_cms_sales_run_publish(uuid);
DROP FUNCTION public.rpc_cms_sales_run_seal_step(uuid, integer);
DROP FUNCTION public.rpc_cms_sales_run_seal_begin(uuid, jsonb);
DROP FUNCTION public.rpc_cms_sales_run_stage(uuid, text, integer, jsonb);
DROP FUNCTION public.rpc_cms_sales_run_open(uuid, jsonb);
DROP FUNCTION public.rpc_cms_sales_snapshot(uuid);
DROP FUNCTION public.cms__programs_result_guard();
DROP FUNCTION public.cms__result_run(uuid, uuid);
DROP FUNCTION public.cms__visible_result_users();
DROP FUNCTION public.cms__results_release_open();
DROP FUNCTION public.cms__seal_fail(uuid, text, text);
DROP FUNCTION public.cms__sales_snapshot(uuid);
DROP FUNCTION public.cms__mapping_fp();
DROP FUNCTION public.cms__norm_email(text);
DROP FUNCTION public.cms__ts(timestamptz);
DROP FUNCTION public.cms__str_or_null(jsonb, text, text);
DROP FUNCTION public.cms__str(jsonb, text, text);

DROP TABLE public.cms_result_lines;
DROP TABLE public.cms_result_catalog;
DROP TABLE public.cms_results;
DROP TABLE public.cms_sales_lines;
DROP TABLE public.cms_sync_run_chunks;

ALTER TABLE public.cms_programs DROP CONSTRAINT cms_programs_result_run_fk;
ALTER TABLE public.cms_programs DROP COLUMN current_result_run_id;

DELETE FROM public.cms_sync_runs WHERE kind = 'sales';
DROP INDEX public.cms_sync_runs_program_idx;
DROP INDEX public.cms_program_tiers_product_from_idx;
ALTER TABLE public.cms_sync_runs
  DROP CONSTRAINT cms_sync_runs_sales_publish,
  DROP CONSTRAINT cms_sync_runs_seal_pair,
  DROP CONSTRAINT cms_sync_runs_kind_shape,
  DROP CONSTRAINT cms_sync_runs_id_program,
  DROP CONSTRAINT cms_sync_runs_kind_check,
  DROP COLUMN config_version,
  DROP COLUMN is_test,
  DROP COLUMN mapping_fp,
  DROP COLUMN sealed_at,
  DROP COLUMN published_at,
  DROP COLUMN purged_at,
  DROP COLUMN cleared_at,
  DROP COLUMN source_max_updated_at,
  DROP COLUMN amount_vnd,
  DROP COLUMN seal_expect,
  DROP COLUMN seal_step;
ALTER TABLE public.cms_sync_runs ADD CONSTRAINT cms_sync_runs_kind_check CHECK (kind IN ('products'));

DELETE FROM public.app_migrations WHERE version = '122';

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND (p.proname LIKE 'cms\_%' OR p.proname LIKE 'rpc\_cms\_%')) <> 14 THEN
    RAISE EXCEPTION 'rollback 122 hậu kiểm: số hàm CMS phải về 14 (120 + 121)';
  END IF;
  IF to_regclass('public.cms_sales_lines') IS NOT NULL OR to_regclass('public.cms_results') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback 122 hậu kiểm: còn bảng kết quả';
  END IF;
  IF pg_catalog.pg_get_constraintdef((SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid = 'public.cms_sync_runs'::regclass
                                       AND conname = 'cms_sync_runs_kind_check')) <> 'CHECK ((kind = ''products''::text))' THEN
    RAISE EXCEPTION 'rollback 122 hậu kiểm: cms_sync_runs_kind_check chưa về dạng 120';
  END IF;
  -- db-reviewer r2.2 P2-5: prod không có bước áp lại để lộ phần sót ⇒ kiểm trực tiếp index / cột / ràng buộc 122 đã gỡ.
  IF to_regclass('public.cms_program_tiers_product_from_idx') IS NOT NULL OR to_regclass('public.cms_sync_runs_program_idx') IS NOT NULL
     OR to_regclass('public.cms_sync_run_chunks') IS NOT NULL OR to_regclass('public.cms_result_lines') IS NOT NULL
     OR to_regclass('public.cms_result_catalog') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback 122 hậu kiểm: còn index / bảng 122';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND ((table_name = 'cms_sync_runs' AND column_name IN ('config_version', 'is_test', 'mapping_fp', 'sealed_at',
                     'published_at', 'purged_at', 'cleared_at', 'source_max_updated_at', 'amount_vnd', 'seal_expect', 'seal_step'))
                OR (table_name = 'cms_programs' AND column_name = 'current_result_run_id'))) THEN
    RAISE EXCEPTION 'rollback 122 hậu kiểm: còn cột 122';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.cms_sync_runs'::regclass
              AND conname IN ('cms_sync_runs_sales_publish', 'cms_sync_runs_seal_pair', 'cms_sync_runs_kind_shape', 'cms_sync_runs_id_program')) THEN
    RAISE EXCEPTION 'rollback 122 hậu kiểm: còn ràng buộc 122';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.cms_programs'::regclass AND tgname = 'cms_programs_result_guard') THEN
    RAISE EXCEPTION 'rollback 122 hậu kiểm: còn trigger pointer';
  END IF;
END $$;

COMMIT;
