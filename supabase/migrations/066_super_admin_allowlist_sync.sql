-- ============================================================
-- Migration 066: sync super-admin allowlist (add lan.pham, vu)
-- ============================================================
-- Production's public.is_super_admin() was extended via SQL with two more super
-- admins (lan.pham@buymed.com, vu@buymed.com). This brings the migration
-- source-of-truth + the app-layer mirror (webapp/lib/authz.ts SUPER_ADMIN_EMAILS)
-- back in sync so a fresh DB build matches prod and every app-layer super gate
-- (Bảng tin creator/super, announcement upload, /users, /gioi-thieu, etc.)
-- recognizes them. Same function shape as migration 046. Idempotent.
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
        'vu@buymed.com'
      )
      AND role = 'admin'
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

INSERT INTO public.app_migrations (version, name)
VALUES ('066', 'super_admin_allowlist_sync')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--   WHERE n.nspname='public' AND p.proname='is_super_admin';  -- expect 6 emails
-- SELECT version FROM public.app_migrations WHERE version='066';
