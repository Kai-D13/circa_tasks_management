-- ============================================================================
-- rollback/124_cms_source_attestation_rollback.sql  (r2 — COMP-INT, Dev 05/11/2026; KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-124.mjs: khôi phục NGUYÊN VĂN 5 hàm 122 / 123 (run_open, stage, cleanup, lock_eval, payout) +
-- chữ ký chốt 5 tham số của 123 (grant service_role + thu hồi grant default privileges); lock_timeout + khoá bảng run; hậu kiểm
-- md5 thân 6 hàm khôi phục (sinh từ thân 122 / 123) + cột / ràng buộc payout về 123.
-- Sau rollback: app bật CMS_SOURCE_CAPTURE_ENABLED sẽ thấy run_open KHÔNG trả source_schema ⇒ đóng run SOURCE_SCHEMA_UNSUPPORTED
-- (không tự tiếp tục capture vào DB không hỗ trợ) — tắt cờ cùng lúc rollback.
-- Dừng nếu: thiếu marker 124 · có migration > 124 · đã có payout basis operator_reconciliation (chứng nhận đã dùng để chốt —
-- payout bất biến, chỉ xử lý tiến). Chương trình đã chốt bằng qa_assumption giữ nguyên.
-- Giữ lại có chủ đích: ràng buộc part của cms_sync_run_chunks vẫn nhận 'source_lines' và các khối part 'source_lines' đã ghi —
-- khối của run đã chốt bị guard 123 đóng băng (không xoá được), cleanup 122 xoá khối theo run (mọi part) nên không mồ côi.
-- Mất dữ liệu: lớp nguồn + lịch sử chứng nhận (chỉ chạy trước go-live / khi PM duyệt).
-- Sau rollback: VERIFY ràng buộc part cms_sync_run_chunks vẫn 5 giá trị (có chủ đích, xem trên). Áp lại 124 sau rollback: MỌI run
-- hiện có (kể cả run tạo giữa lần áp đầu và rollback) thành run cũ (source_schema NULL) — lớp nguồn của chúng đã xoá cùng bảng.
-- Vận hành: cờ CMS sync OFF, cron sync / cleanup CMS tạm dừng như khi áp 124. DÁN NGUYÊN FILE, GIỮ LF (md5 hậu kiểm tính trên LF;
-- CRLF ⇒ hậu kiểm dừng, transaction rollback). Chạy bằng ĐÚNG role owner bảng / hàm CMS (như 124) — owner khác ⇒ preflight dừng.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.cms_sync_runs IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'rollback 124: cần READ COMMITTED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '124' AND name = 'cms_source_attestation') THEN
    RAISE EXCEPTION 'rollback 124: không có marker 124';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 124) THEN
    RAISE EXCEPTION 'rollback 124: DB đã có migration số > 124 — rollback theo thứ tự ngược trước';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_payouts WHERE source_complete_basis = 'operator_reconciliation' OR source_attestation_id IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback 124: đã có payout dùng chứng nhận đối soát (bất biến) — không rollback, xử lý tiến';
  END IF;
  -- Owner: lock 5 tham số tạo lại phải cùng owner bảng payout (guard INVOKER cms__payout_insert_guard) — db-reviewer r2 P2-8.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_sync_runs'::regclass, 'public.cms_payouts'::regclass, 'public.cms_programs'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'rollback 124: owner bảng CMS khác role chạy (%) — chạy bằng owner', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running') THEN
    RAISE EXCEPTION 'rollback 124: còn run bán đang chạy — chờ xong (khối source_lines đang ghi sẽ mồ côi nghĩa)';
  END IF;
END $$;

-- Hàm mới (lock 6 tham số DROP rồi tạo lại bản 123 bên dưới).
DROP FUNCTION public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid);
DROP FUNCTION public.rpc_cms_source_attest_revoke(uuid, text, uuid);
DROP FUNCTION public.rpc_cms_run_source_export(uuid, uuid, text, integer);
DROP FUNCTION public.rpc_cms_source_attestations(uuid);
DROP FUNCTION public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text, uuid);
