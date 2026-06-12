-- ============================================================
-- Migration 052: Tighten store_weekly_targets read to the exact spec
-- ============================================================
-- Review finding (2026-06-12): 051's policy let every admin read all KPI and
-- store managers read their store's. The stakeholder spec is "staff tab only"
-- — sales numbers are sensitive, so the DB gate must match the UI gate:
-- super admin (manages the feed) + staff reading their OWN store. Nobody else.
-- SECDEF helpers only, no cross-table refs.
-- ============================================================

DROP POLICY IF EXISTS "swt_select" ON public.store_weekly_targets;
CREATE POLICY "swt_select" ON public.store_weekly_targets
  FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR (
      (select get_user_role()) = 'staff'
      AND store_id = (select get_user_store_id())
    )
  );

-- Record this migration.
INSERT INTO public.app_migrations (version, name)
VALUES ('052', 'tighten_swt_select')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- SELECT policyname, qual FROM pg_policies
-- WHERE schemaname='public' AND tablename='store_weekly_targets';
-- expect: 1 row (swt_select), qual contains is_super_admin AND 'staff'
--         and does NOT contain a bare admin role branch
--
-- SELECT version FROM public.app_migrations WHERE version='052';
