-- ============================================================
-- Migration 046: Super admin email allowlist
-- ============================================================
-- Adds ngoc.ta@buymed.com, thao@buymed.com and son.kieu@buymed.com as super
-- admins. The app-layer mirror is
-- SUPER_ADMIN_EMAILS in webapp/lib/authz.ts — the two lists MUST stay in sync.
-- Same function shape as migration 017 (SECURITY DEFINER, role='admin' still
-- required); only the email check becomes an IN list.
-- Idempotent: CREATE OR REPLACE.
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
        'son.kieu@buymed.com'
      )
      AND role = 'admin'
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

-- Record this migration.
INSERT INTO public.app_migrations (version, name)
VALUES ('046', 'super_admin_allowlist')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Function body contains both emails:
-- SELECT pg_get_functiondef(p.oid)
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public' AND p.proname = 'is_super_admin';
-- expect: IN list contains all 4 emails, prosecdef intact
--
-- 2) Migration recorded:
-- SELECT version, name, applied_at FROM public.app_migrations WHERE version = '046';
-- expect: 1 row
