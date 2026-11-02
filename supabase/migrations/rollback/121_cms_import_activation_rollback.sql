-- ============================================================================
-- ROLLBACK 121_cms_import_activation.sql
-- Chỉ gỡ 7 hàm của 121 (4 RPC service_role + 3 helper cms__*). KHÔNG đụng bảng / dữ liệu của 120: chương trình, sản
-- phẩm, bậc, import run đã ghi qua RPC vẫn giữ nguyên (đọc theo RLS 120 như cũ). Sau rollback, app (cờ OFF trước) không
-- còn đường ghi CMS; muốn gỡ dữ liệu thì xử lý ở rollback 120 (chỉ khi chưa có chương trình thật).
-- Preflight fail-closed: dừng nếu marker 121 không phải của CMS, hoặc đã có migration số > 121 (122 phụ thuộc 121).
-- CÁCH CHẠY: tắt CMS_PROGRAM_ENABLED + redeploy trước; Studio (superuser), dán nguyên file.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  v_name text;
BEGIN
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '121';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback 121: chưa có marker 121 — không có gì để rollback';
  END IF;
  IF v_name IS DISTINCT FROM 'cms_import_activation' THEN
    RAISE EXCEPTION 'rollback 121: marker 121 không phải của CMS (name = %) — dừng', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations
              WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 121) THEN
    RAISE EXCEPTION 'rollback 121: DB đã có migration số > 121 — rollback migration sau trước';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.rpc_cms_program_activate(uuid, uuid);
DROP FUNCTION IF EXISTS public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid);
DROP FUNCTION IF EXISTS public.rpc_cms_import_preview_save(jsonb);
DROP FUNCTION IF EXISTS public.rpc_cms_program_save(jsonb);
DROP FUNCTION IF EXISTS public.cms__conflicts(uuid, boolean, date, date, text[]);
DROP FUNCTION IF EXISTS public.cms__lock_catalog();
DROP FUNCTION IF EXISTS public.cms__vn_today();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('cms__vn_today', 'cms__lock_catalog', 'cms__conflicts', 'rpc_cms_program_save',
                                'rpc_cms_import_preview_save', 'rpc_cms_import_commit', 'rpc_cms_program_activate')) THEN
    RAISE EXCEPTION 'rollback 121: còn hàm của 121 (overload lạ?) — dừng';
  END IF;
END $$;

DELETE FROM public.app_migrations WHERE version = '121';

COMMIT;

-- VERIFY (chỉ đọc):
--   SELECT version, name FROM public.app_migrations WHERE version IN ('120','121');              -- chỉ còn 120
--   SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('cms__vn_today','cms__lock_catalog','cms__conflicts','rpc_cms_program_save',
--                      'rpc_cms_import_preview_save','rpc_cms_import_commit','rpc_cms_program_activate');   -- 0
