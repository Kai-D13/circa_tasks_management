-- ============================================================================
-- 084_user_site_permissions.sql
-- F5b-1 — Site model (OS / FS). This table is an ADDITIVE OVERRIDE: base site
-- access is derived in the app from role + store_type (super admin & Policy-dept
-- admin → both; admin/sm/OS store → os; FS store → fs). Rows here GRANT extra
-- sites to a specific user via SQL (scale-ready) without a code change.
--
-- The cookie `circa_site` only chooses which allowed site is CURRENT — it never
-- grants access. Allowed sites are always recomputed server-side (role + store_type
-- + this table). Additive + idempotent. Records app_migrations '084'.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_site_permissions (
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  site       text NOT NULL CHECK (site IN ('os', 'fs')),
  granted_by uuid REFERENCES public.users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, site)
);

ALTER TABLE public.user_site_permissions ENABLE ROW LEVEL SECURITY;

-- Read: own rows OR super admin (helpers are SECURITY DEFINER → no recursion).
-- No write policy: grants are done via SQL / service role (app reads via supabaseAdmin).
DROP POLICY IF EXISTS usp_select ON public.user_site_permissions;
CREATE POLICY usp_select ON public.user_site_permissions
  FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR user_id = auth.uid());

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('084', 'user_site_permissions',
        'F5b-1 site model: user_site_permissions (user_id,site os|fs) — additive override on top of role+store_type-derived site access. Cookie circa_site only picks current site, never grants. RLS select self|super; grants via SQL.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT policyname FROM pg_policies WHERE tablename='user_site_permissions';
-- SELECT version FROM public.app_migrations WHERE version='084';
-- Grant example (SQL): INSERT INTO public.user_site_permissions(user_id, site, granted_by)
--   VALUES ('<uid>', 'fs', '<admin uid>') ON CONFLICT DO NOTHING;
