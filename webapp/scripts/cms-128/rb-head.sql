-- ============================================================================
-- rollback/128_cms_unit_quantity_basis_rollback.sql  (bản PM-r1 — CMS-UNIT capability, Dev 09–10/11/2026; KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-128.mjs: khôi phục NGUYÊN VĂN @@N_REP@@ hàm (bản cuối trước 128: 121 / 122 / 123 / 124 / 125 / 126) +
-- ACL, gỡ 2 trigger guard + @@N_NEW_HELPERS@@ helper, gỡ ràng buộc / cột cơ sở tính (cms_programs.quantity_basis; cms_sync_runs.quantity_basis /
-- calculation_policy_version / calculation_snapshot), xoá marker 128; hậu kiểm md5 thân khôi phục + ACL + tổng hàm @@N_CMS_BEFORE@@.
-- CHỈ dùng TRƯỚC khi có dữ liệu cms_unit (spec §5 rollback schema): có chương trình cơ sở cms_unit HOẶC run mang cơ sở cms_unit (mọi
-- trạng thái) ⇒ DỪNG — không drop metadata làm mất nghĩa lịch sử; xử lý tiến (đổi chương trình về pos_base bằng transaction bù có
-- version tăng tiếp, giữ app / reader mới). Run pos_base_v1 tạo sau 128 mất metadata (đọc như run cũ — cùng luật pos_base).
-- Thứ tự vận hành: app về bản không đọc metadata 128 (hoặc giữ app mới — app mới tương thích DB không có 128: snapshot thiếu khoá
-- quantity_basis ⇒ luật pos_base legacy), tạm dừng task CMS sales, không run bán running, rồi chạy file này.
-- Dừng nếu: thiếu marker 128 · có migration > 128 · owner / isolation sai · thân @@N_REP@@ hàm hiện tại khác bản 128 đã sinh.
-- Sau rollback: `cms-verify post --phase=127` (PRE chụp trước 128) phải ĐẠT.
-- Vận hành: DÁN NGUYÊN FILE, nên GIỮ LF. Chạy bằng ĐÚNG role owner bảng / hàm CMS. Gồm DELETE FROM app_migrations WHERE version = '128'.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.cms_programs IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.cms_sync_runs IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'rollback 128: cần READ COMMITTED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '128' AND name = 'cms_unit_quantity_basis') THEN
    RAISE EXCEPTION 'rollback 128: không có marker 128';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 128) THEN
    RAISE EXCEPTION 'rollback 128: DB đã có migration số > 128 — rollback theo thứ tự ngược trước';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION 'rollback 128: role chạy (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_programs'::regclass, 'public.cms_sync_runs'::regclass, 'public.cms_sales_lines'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'rollback 128: owner bảng / hàm CMS khác role chạy (%) — chạy bằng owner', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_programs WHERE quantity_basis <> 'pos_base')
     OR EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE quantity_basis IS DISTINCT FROM 'pos_base' AND kind = 'sales') THEN
    RAISE EXCEPTION 'rollback 128: đã có chương trình / run cơ sở cms_unit — KHÔNG drop metadata lịch sử; xử lý tiến (transaction bù)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running') THEN
    RAISE EXCEPTION 'rollback 128: còn run bán running — tạm dừng task CMS sales trước';
  END IF;
END $$;
-- Thân @@N_REP@@ hàm hiện tại phải đúng bản 128 đã sinh — khối sinh bởi gen-cms-128.mjs.
-- @@PRE_MD5@@

-- Gỡ trigger + ràng buộc TRƯỚC khi khôi phục thân hàm (thân cũ không đọc / ghi cột 128).
DROP TRIGGER cms_programs_basis_guard ON public.cms_programs;
DROP TRIGGER cms_sync_runs_basis_guard ON public.cms_sync_runs;
ALTER TABLE public.cms_sync_runs DROP CONSTRAINT cms_sync_runs_basis_shape;
