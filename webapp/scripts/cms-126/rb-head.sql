-- ============================================================================
-- rollback/126_cms_sales_only_results_release_rollback.sql  (r1 — CMS sales-only, Dev 06/11/2026; KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-126.mjs: khôi phục NGUYÊN VĂN cms__results_release_open() + rpc_cms_sales_run_publish(uuid) của
-- 122 (cổng đóng; publish không có nhánh điều chỉnh / dấu căn cứ), ACL (helper chỉ owner; publish service_role) + thu hồi grant
-- default privileges, xoá marker 126; hậu kiểm md5 thân 2 hàm khôi phục (sinh từ thân 122) + ACL + tổng hàm + cổng đóng.
-- GIỮ có chủ đích: run / snapshot đã công bố và pointer hiện hành (không xoá dữ liệu kết quả; dấu results_basis trong detail giữ làm
-- vết). Sau rollback, publish chương trình thật lại bị held RESULTS_RELEASE_GATE; app phải về chế độ HOLD (releaseGate) hoặc tắt
-- CMS_EARNINGS_ENABLED. Thứ tự vận hành: tắt CMS_EARNINGS_ENABLED (+ cron sync) TRƯỚC, rồi rollback cổng nếu PM quyết; mặc định
-- ưu tiên xử lý tiến. Có run bán THẬT thì rollback 122 vẫn bị guard cũ chặn (không nới).
-- Dừng nếu: thiếu marker 126 · có migration > 126 (rollback theo thứ tự ngược trước) · owner / isolation sai · thân 2 hàm hiện tại
-- khác bản 126 đã sinh (có người sửa tay — đối chiếu trước).
-- Sau rollback: `cms-verify post --phase=125` (PRE chụp trước 125) phải ĐẠT — 126 không để lại phần dư ở schema / hàm / ACL.
-- Vận hành: DÁN NGUYÊN FILE, nên GIỮ LF (md5 bỏ \r như VERIFY). Chạy bằng ĐÚNG role owner bảng / hàm CMS.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.cms_sync_runs IN SHARE MODE;

DO $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'rollback 126: cần READ COMMITTED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '126' AND name = 'cms_sales_only_results_release') THEN
    RAISE EXCEPTION 'rollback 126: không có marker 126';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 126) THEN
    RAISE EXCEPTION 'rollback 126: DB đã có migration số > 126 — rollback theo thứ tự ngược trước';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION 'rollback 126: role chạy (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_programs'::regclass, 'public.cms_sync_runs'::regclass, 'public.cms_sales_lines'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'rollback 126: owner bảng / hàm CMS khác role chạy (%) — chạy bằng owner', current_user;
  END IF;
END $$;
-- Thân 2 hàm hiện tại phải đúng bản 126 đã sinh — khối sinh bởi gen-cms-126.mjs.
-- @@PRE_MD5@@
