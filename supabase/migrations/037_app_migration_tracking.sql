-- ============================================================
-- Migration 037: App migration tracking
-- ============================================================
-- Migrations are applied manually via the Supabase SQL Editor, so there is no
-- record of which ones have actually run on the self-host. This table is that
-- record going forward: insert one row per migration as it is applied.
--
-- IMPORTANT: do NOT blind-mark 001-036 as applied. Backfill those only after
-- verifying the real objects (tables / policies / indexes) exist on this
-- database, using note = 'backfilled_after_object_verification'.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS; DROP POLICY IF EXISTS before create.
-- The new policy already uses the (select ...) initplan form per migration 038.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.app_migrations (
  version     text PRIMARY KEY,
  name        text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text DEFAULT current_user,
  checksum    text,
  notes       text
);

ALTER TABLE public.app_migrations ENABLE ROW LEVEL SECURITY;

-- Least privilege: no anon access at all; authenticated may read only (and RLS
-- below narrows that to the super admin). Writes happen via the SQL Editor
-- (table owner / service role), which bypasses RLS, so there is no write policy.
REVOKE ALL ON public.app_migrations FROM anon, authenticated;
GRANT SELECT ON public.app_migrations TO authenticated;

-- Super-admin-only visibility, ready for an in-app ops view later.
DROP POLICY IF EXISTS app_migrations_select_super ON public.app_migrations;
CREATE POLICY app_migrations_select_super
  ON public.app_migrations
  FOR SELECT TO authenticated
  USING ((select public.is_super_admin()));

-- Record this migration.
INSERT INTO public.app_migrations (version, name, notes)
VALUES ('037', 'app_migration_tracking', 'creates public.app_migrations tracking table')
ON CONFLICT (version) DO NOTHING;

-- Verification:
-- SELECT version, name, notes, applied_at FROM public.app_migrations ORDER BY version;
