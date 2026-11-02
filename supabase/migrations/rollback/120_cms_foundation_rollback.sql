-- ============================================================================
-- ROLLBACK 120_cms_foundation.sql  (r2)
-- CHỈ dùng khi CHƯA có chương trình / dữ liệu CMS thật (IMPLEMENTATION_PLAN §4): sau khi có dữ liệu nghiệp vụ thì
-- tắt cờ CMS_PROGRAM_ENABLED và xử lý tiến, KHÔNG drop bảng.
-- Preflight fail-closed: dừng nếu marker 120 không phải của CMS (name <> 'cms_foundation'), nếu đã có migration số
-- > 120 (121 phụ thuộc 120), hoặc còn chương trình thật (is_test = false).
-- KHOÁ: DROP cms_program_stores gỡ trigger FK trên public.stores ⇒ cần ACCESS EXCLUSIVE trên stores trong thời gian
-- rất ngắn; lock_timeout 2s để không xếp hàng các request đọc stores (login / embed). Chạy giờ thấp điểm; gặp
-- 55P03 (lock_timeout) thì chờ rồi chạy lại cả file (transaction không để lại gì).
-- Không đụng bảng cũ, không đụng is_super_admin(). CÁCH CHẠY: Studio (superuser), dán nguyên file.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  v_name text;
BEGIN
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '120';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback 120: chưa có marker 120 — không có gì để rollback';
  END IF;
  IF v_name IS DISTINCT FROM 'cms_foundation' THEN
    RAISE EXCEPTION 'rollback 120: marker 120 không phải của CMS (name = %) — dừng', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations
              WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 120) THEN
    RAISE EXCEPTION 'rollback 120: DB đã có migration số > 120 — rollback migration sau trước';
  END IF;
  IF to_regclass('public.cms_programs') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.cms_programs WHERE NOT is_test) THEN
    RAISE EXCEPTION 'rollback 120: đã có chương trình CMS thật — KHÔNG drop; tắt cờ và xử lý tiến';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.rpc_cms_sync_run_close(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.rpc_cms_product_master_upsert(uuid, jsonb);
DROP FUNCTION IF EXISTS public.rpc_cms_sync_run_open(text, jsonb);

-- Bảng (policy / trigger / index đi theo bảng). Thứ tự theo FK.
DROP TABLE IF EXISTS public.cms_program_tiers;
DROP TABLE IF EXISTS public.cms_program_products;
DROP TABLE IF EXISTS public.cms_program_stores;
DROP TABLE IF EXISTS public.cms_import_runs;
DROP TABLE IF EXISTS public.cms_sync_runs;
DROP TABLE IF EXISTS public.cms_programs;
DROP TABLE IF EXISTS public.cms_product_master;
DROP TABLE IF EXISTS public.cms_qa_access;

-- Helper + hàm trigger sau bảng (policy / trigger đã drop cùng bảng).
DROP FUNCTION IF EXISTS public.cms_readable_program_ids();
DROP FUNCTION IF EXISTS public.cms_has_qa_access();
DROP FUNCTION IF EXISTS public.cms__programs_guard();
DROP FUNCTION IF EXISTS public.cms__qa_access_stamp();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname LIKE 'cms\_%')
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                 AND (p.proname LIKE 'cms\_%' OR p.proname LIKE 'rpc\_cms\_%')) THEN
    RAISE EXCEPTION 'rollback 120: hậu kiểm — còn object cms_* trong public';
  END IF;
END $$;

DELETE FROM public.app_migrations WHERE version = '120' AND name = 'cms_foundation';

COMMIT;
