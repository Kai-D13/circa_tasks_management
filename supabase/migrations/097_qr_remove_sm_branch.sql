-- ============================================================================
-- 097_qr_remove_sm_branch.sql — Slice C: SM KHÔNG được đọc QR (DB enforce)
-- ⚠ DRAFT — CHƯA CHẠY cho tới khi stakeholder audit pass.
--
-- Yêu cầu (audit 24/07): SM không thấy QR Affiliate — enforce Ở CẢ DB lẫn app
-- (ẩn component là không đủ), NHƯNG GIỮ Affiliate Overview của SM (app chuyển
-- nhánh SM sang đọc mapping bằng service role với danh sách store OS active
-- ĐÃ VALIDATE, chỉ select cột non-QR — cùng commit này).
--
-- Nội dung:
--   A. Preflight: đủ migration nền 090..096.
--   B. REDEFINE apm_select_store_qr: COPY NGUYÊN VĂN bản 095 (giữ nguyên qua
--      096) TRỪ nhánh sm — chỉ còn staff + store_manager OS đọc đúng store
--      mình. GIỮ apm_select_super + apm_select_dept_admin (contract hiện hành).
--      KHÔNG xóa dữ liệu QR.
--
-- Idempotent: re-run = no-op.
--
-- ROLLBACK (tái tạo đúng trạng thái trước 097):
--   1. Khôi phục apm_select_store_qr NGUYÊN VĂN theo 095 (CÓ nhánh sm):
--        DROP POLICY IF EXISTS apm_select_store_qr ON public.affiliate_partner_mappings;
--        CREATE POLICY apm_select_store_qr ON public.affiliate_partner_mappings
--          FOR SELECT TO authenticated
--          USING (
--            partner_type = 'os'
--            AND is_active = true
--            AND store_id IS NOT NULL
--            AND (
--              ((SELECT public.get_user_role()) IN ('staff','store_manager')
--                AND store_id = (SELECT public.get_user_store_id()))
--              OR ((SELECT public.get_user_role()) = 'sm' AND public.is_sm_for_store(store_id))
--            )
--          );
--   2. DELETE FROM public.app_migrations WHERE version = '097';
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.app_migrations
      WHERE version IN ('090','091','092','093','094','095','096')) <> 7 THEN
    RAISE EXCEPTION '097: thiếu migration nền — cần đủ 090..096 đã chạy (hiện có: %)',
      (SELECT string_agg(version, ',' ORDER BY version) FROM public.app_migrations
       WHERE version IN ('090','091','092','093','094','095','096'));
  END IF;
END $$;

-- ── B. apm_select_store_qr: BỎ nhánh sm — các điều kiện khác NGUYÊN VĂN 095
--      (chỉ xóa đúng 1 nhánh; sót/sửa nhánh khác = mất quyền hợp lệ). ─────────
DROP POLICY IF EXISTS apm_select_store_qr ON public.affiliate_partner_mappings;
CREATE POLICY apm_select_store_qr ON public.affiliate_partner_mappings
  FOR SELECT TO authenticated
  USING (
    partner_type = 'os'
    AND is_active = true
    AND store_id IS NOT NULL
    AND (SELECT public.get_user_role()) IN ('staff','store_manager')
    AND store_id = (SELECT public.get_user_store_id())
  );

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('097', 'qr_remove_sm_branch',
        'Slice C (audit 24/07): REDEFINE apm_select_store_qr BỎ nhánh sm — chỉ staff + store_manager OS đọc QR đúng store mình (điều kiện khác nguyên văn 095). SM giữ Affiliate Overview qua app-layer (mapping đọc service role với assigned active-OS ids đã validate, chỉ cột non-QR). apm_select_super + apm_select_dept_admin giữ nguyên. Không xóa dữ liệu QR.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau 097):
-- 1) SELECT policyname, qual FROM pg_policies
--      WHERE tablename='affiliate_partner_mappings' ORDER BY 1;
--    -- 3 policy: apm_select_dept_admin · apm_select_store_qr · apm_select_super
--    -- qual của apm_select_store_qr KHÔNG chứa 'is_sm_for_store'
-- 2) SELECT version FROM public.app_migrations WHERE version='097';  -- 1 row
--
-- QA RLS (PostgREST, token từng role — đổi account nhớ logout/incognito):
--   GET /rest/v1/affiliate_partner_mappings?select=partner_code,qr_image_url
--   · SM                    → 0 row (SM hết đường đọc QR trực tiếp)
--   · Staff OS store A      → ĐÚNG 1 row store A
--   · Store Manager OS      → ĐÚNG 1 row store mình
--   · FS staff/QLCH         → 0 row
--   · Admin thường          → 0 row
--   · Admin phòng OPS       → 25 row os (apm_select_dept_admin — như cũ)
--   · Super admin           → 34 row (như cũ)
--   App: SM /targets KHÔNG còn card QR; SM Overview VẪN thấy đúng GMV các
--   store được giao; Staff/QLCH giữ nguyên QR store mình.
-- ============================================================================
