-- ============================================================
-- Migration 100: thêm super admin anh.nguyenvan1@buymed.com
-- ============================================================
-- Edge case stakeholder 2026-08-04: nâng account admin hiện hữu lên super.
-- Super admin = role 'admin' + email trong ALLOWLIST — allowlist nằm ở HAI
-- nơi PHẢI SYNC (bài học migration 066):
--   1. DB: function public.is_super_admin() (file này — source of truth,
--      user chạy tay trên Supabase).
--   2. App: webapp/lib/authz.ts SUPER_ADMIN_EMAILS (commit cùng batch này).
-- Same function shape as 046/066 — chỉ THÊM đúng 1 email. Idempotent.
--
-- ĐIỀU KIỆN TIÊN QUYẾT (kiểm trước khi chạy): account phải có role='admin'
--   SELECT id, email, role FROM public.users
--   WHERE lower(email) = 'anh.nguyenvan1@buymed.com';
-- Nếu role KHÔNG phải 'admin' → function sẽ không nhận (điều kiện role bên
-- trong); nâng role trước bằng:
--   UPDATE public.users SET role = 'admin'
--   WHERE lower(email) = 'anh.nguyenvan1@buymed.com';
--
-- ROLLBACK: chạy lại CREATE OR REPLACE theo nguyên văn migration 066 (6 email,
-- bỏ anh.nguyenvan1) + DELETE FROM app_migrations WHERE version='100'.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND lower(email) IN (
        'hoangvudn96@gmail.com',
        'ngoc.ta@buymed.com',
        'thao@buymed.com',
        'son.kieu@buymed.com',
        'lan.pham@buymed.com',
        'vu@buymed.com',
        'anh.nguyenvan1@buymed.com'
      )
      AND role = 'admin'
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('100', 'super_admin_add_anh',
        'Thêm anh.nguyenvan1@buymed.com vào allowlist super (7 email). App-layer mirror: webapp/lib/authz.ts SUPER_ADMIN_EMAILS cập nhật cùng batch — thiếu một trong hai nơi là gate lệch (bài học 066).')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify (chạy sau migration)
-- ============================================================
-- 1) Definition có đủ 7 email:
--    SELECT pg_get_functiondef(p.oid) FROM pg_proc p
--    JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public' AND p.proname='is_super_admin';
-- 2) SELECT version, name FROM public.app_migrations WHERE version='100';  -- 1 row
-- 3) Account đúng role:
--    SELECT email, role FROM public.users
--    WHERE lower(email)='anh.nguyenvan1@buymed.com';  -- role = 'admin'
