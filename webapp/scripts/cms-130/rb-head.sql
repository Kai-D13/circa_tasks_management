-- ============================================================================
-- rollback/130_cms_calculation_modes_returns_rollback.sql  (CANDIDATE — sinh bằng webapp/scripts/gen-cms-130.mjs; KHÔNG sửa tay)
-- Gỡ 130 về đúng nền 127: app TRƯỚC (về bản không gọi save_v2 / reader v2 / pipeline contract), rồi file này. DỪNG (không xoá gì) nếu
-- đã có dữ liệu của chế độ mới: chương trình chọn basis qua v2 (admin / pending), cms_unit, net_returns_v1. Chương trình tạo bằng đường
-- cũ sau 130 (legacy_compat = pos_base) gỡ cột được, không mất nghĩa. KHÔNG xoá kết quả / pointer đã công bố.
-- Gồm DELETE FROM app_migrations WHERE version = '130'. READ COMMITTED; đúng role owner; giữ LF.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.cms_programs, public.cms_program_products, public.cms_payouts, public.cms_sync_runs, public.cms_sync_run_chunks,
           public.cms_sales_source_lines, public.cms_sales_lines, public.cms_results, public.cms_return_ledger_evals,
           public.cms_return_baselines, public.cms_return_conflicts, public.cms_return_restorations, public.cms_return_close_reports,
           public.cms_return_close_report_lines, public.cms_return_close_report_events, public.cms_return_lines, public.cms_result_events,
           public.cms_return_conflict_observations, public.cms_return_conflict_restorations
  IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  v_name text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'rollback 130: cần READ COMMITTED';
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '130';
  IF v_name IS DISTINCT FROM 'cms_calculation_modes_returns' THEN
    RAISE EXCEPTION 'rollback 130: không có marker 130 cms_calculation_modes_returns (name = %)', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 130) THEN
    RAISE EXCEPTION 'rollback 130: DB đã có migration số > 130 — gỡ bản sau trước';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r0 WHERE r0.rolname = current_user AND (r0.rolsuper OR r0.rolbypassrls)) THEN
    RAISE EXCEPTION 'rollback 130: role chạy (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE status = 'running') THEN
    RAISE EXCEPTION 'rollback 130: còn run đang chạy';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_programs
              WHERE quantity_basis_source IN ('admin', 'pending') OR quantity_basis IS DISTINCT FROM 'pos_base'
                 OR returns_policy <> 'sales_only_v1') THEN
    RAISE EXCEPTION 'rollback 130: đã có chương trình dùng chế độ mới (admin / pending / cms_unit / net_returns_v1) — DỪNG, xử lý tiến';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE calc_contract_version IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.cms_return_lines) OR EXISTS (SELECT 1 FROM public.cms_result_events)
     OR EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE src_v IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.cms_sales_source_lines WHERE src_v IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.cms_results WHERE net_v IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback 130: đã có run / dữ liệu run contract — DỪNG, xử lý tiến';
  END IF;
  -- Sổ trả hàng bền (baseline tài chính / conflict / phục hồi / eval / báo cáo sau chốt) KHÔNG bao giờ bị xoá bởi rollback.
  IF EXISTS (SELECT 1 FROM public.cms_return_ledger_evals) OR EXISTS (SELECT 1 FROM public.cms_return_baselines)
     OR EXISTS (SELECT 1 FROM public.cms_return_conflicts) OR EXISTS (SELECT 1 FROM public.cms_return_restorations)
     OR EXISTS (SELECT 1 FROM public.cms_return_close_reports) THEN
    RAISE EXCEPTION 'rollback 130: sổ trả hàng đã có dữ liệu — DỪNG, xử lý tiến';
  END IF;
END $$;
-- Thân hàm hiện tại phải đúng bản 130 đã sinh (không sửa tay sau 130) — khối sinh bởi gen-cms-130.mjs.
-- @@RB_PRE_MD5@@
