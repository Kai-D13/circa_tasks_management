-- ============================================================================
-- rollback/125_cms_uncapped_last_tier_rollback.sql  (r1 — CMS-UNCAPPED-1, Dev 05/11/2026; KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-125.mjs: khôi phục NGUYÊN VĂN rpc_cms_import_commit + rpc_cms_program_activate của 121 (ACL
-- service_role + thu hồi grant default privileges), gỡ constraint trigger cms_tiers_last_open + hàm cms__tiers_last_open_guard, xoá
-- marker 125; hậu kiểm md5 thân 2 RPC khôi phục (sinh từ thân 121) + ACL + tổng hàm.
-- GIỮ có chủ đích (không hứa khôi phục dữ liệu cận trên cũ): bậc cuối đã chuyển NULL, config_version đã tăng, pointer đã vô hiệu —
-- NULL là cấu hình hợp lệ với code / SQL cũ (bậc cuối không giới hạn), run cũ vẫn còn (không xoá run / chứng nhận / sổ). KHÔNG tái áp
-- cận hữu hạn, KHÔNG giảm config_version, KHÔNG phục hồi pointer tiền theo trần cũ. Sau rollback, app cũ (trước CMS-Q-220) lại nhận
-- file có cận cuối hữu hạn ⇒ chỉ rollback trước go-live / khi PM duyệt; đã có run / payout THẬT theo chính sách mới ⇒ đường mặc định là
-- tắt cờ / xử lý tiến, không rollback chính sách tài chính để bật lại trần.
-- Dừng nếu: thiếu marker 125 · có migration > 125 (rollback theo thứ tự ngược trước) · owner / isolation sai · còn run bán 'running'.
-- Sau rollback: `cms-verify post --phase=124` (PRE chụp trước 124) phải ĐẠT — 125 không để lại phần dư ở schema / hàm / trigger.
-- Vận hành: cờ CMS sync OFF, cron ghi CMS tạm dừng như khi áp 125. DÁN NGUYÊN FILE, nên GIỮ LF (md5 hậu kiểm bỏ \r như VERIFY; thân lệch ⇒ hậu kiểm
-- dừng, transaction rollback). Chạy bằng ĐÚNG role owner bảng / hàm CMS — owner khác ⇒ preflight dừng.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.cms_sync_runs IN SHARE MODE;
LOCK TABLE public.cms_programs, public.cms_program_products IN SHARE ROW EXCLUSIVE MODE;
-- DROP TRIGGER cần ACCESS EXCLUSIVE ⇒ lấy ngay đầu, không nâng khoá giữa chừng (db-reviewer 125 P2-2). Đọc bậc (RLS UI) chờ tối đa
-- lock_timeout của phiên đọc — chạy trong cửa sổ cờ CMS OFF.
LOCK TABLE public.cms_program_tiers IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'rollback 125: cần READ COMMITTED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '125' AND name = 'cms_uncapped_last_tier') THEN
    RAISE EXCEPTION 'rollback 125: không có marker 125';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 125) THEN
    RAISE EXCEPTION 'rollback 125: DB đã có migration số > 125 — rollback theo thứ tự ngược trước';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_programs'::regclass, 'public.cms_program_products'::regclass,
                              'public.cms_program_tiers'::regclass, 'public.cms_sync_runs'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'rollback 125: owner bảng / hàm CMS khác role chạy (%) — chạy bằng owner', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running') THEN
    RAISE EXCEPTION 'rollback 125: còn run bán đang chạy — chờ xong';
  END IF;
END $$;

DROP TRIGGER cms_tiers_last_open ON public.cms_program_tiers;
DROP FUNCTION public.cms__tiers_last_open_guard();
