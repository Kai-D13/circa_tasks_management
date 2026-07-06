-- ============================================================================
-- 075_kpi_campaign_sm_access.sql
-- Extend KPI campaign READ access to the `sm` (area/multi-store manager) role.
--
-- Until now the campaign read helper + 5 store-scoped policies only matched
-- staff / store_manager via users.store_id (a single store). An `sm` user has
-- users.store_id = NULL and manages several stores via sm_store_assignments, so
-- they matched nothing and /targets redirected them out.
--
-- Fix: add an `sm` branch that uses the existing SECURITY DEFINER helper
-- public.is_sm_for_store(p_store_id) (migration 045) — checks sm_store_assignments
-- for auth.uid(). It returns false for non-sm users, so ORing it into the
-- store-scoped policies is safe for staff/store_manager. No cross-table
-- recursion (is_sm_for_store + can_read_kpi_campaign are SECURITY DEFINER).
--
-- Additive + idempotent. Records app_migrations '075'. Run AFTER 070→074.
-- Rollback: re-create the 070/072 versions of the helper + policies.
-- ============================================================================

BEGIN;

-- 1) Read helper — add the sm branch (keep staff/store_manager exactly as before).
CREATE OR REPLACE FUNCTION public.can_read_kpi_campaign(p_campaign_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.kpi_campaigns c
    JOIN public.kpi_campaign_store_targets t ON t.campaign_id = c.id
    WHERE c.id = p_campaign_id
      AND c.status = 'active'
      AND c.is_test = false
      AND (
        ( (select public.get_user_role()) IN ('staff', 'store_manager')
          AND t.store_id = (select public.get_user_store_id()) )
        OR
        ( (select public.get_user_role()) = 'sm'
          AND public.is_sm_for_store(t.store_id) )
      )
  )
$$;
GRANT EXECUTE ON FUNCTION public.can_read_kpi_campaign(uuid) TO authenticated;

-- 2) Store-scoped read policies — add the sm branch. is_sm_for_store() is false
--    for non-sm users, so staff/store_manager behaviour is unchanged.
--    kc_read_store (kpi_campaigns) only calls the helper → no change needed.

DROP POLICY IF EXISTS "kct_read_store" ON public.kpi_campaign_store_targets;
CREATE POLICY "kct_read_store" ON public.kpi_campaign_store_targets
  FOR SELECT TO authenticated
  USING (
    (store_id = (select public.get_user_store_id()) OR public.is_sm_for_store(store_id))
    AND public.can_read_kpi_campaign(campaign_id)
  );

DROP POLICY IF EXISTS "kctier_read_store" ON public.kpi_campaign_store_tiers;
CREATE POLICY "kctier_read_store" ON public.kpi_campaign_store_tiers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.kpi_campaign_store_targets t
      WHERE t.id = kpi_campaign_store_tiers.target_id
        AND (t.store_id = (select public.get_user_store_id()) OR public.is_sm_for_store(t.store_id))
        AND public.can_read_kpi_campaign(t.campaign_id)
    )
  );

DROP POLICY IF EXISTS "kca_read_store" ON public.kpi_campaign_store_actuals;
CREATE POLICY "kca_read_store" ON public.kpi_campaign_store_actuals
  FOR SELECT TO authenticated
  USING (
    (store_id = (select public.get_user_store_id()) OR public.is_sm_for_store(store_id))
    AND public.can_read_kpi_campaign(campaign_id)
  );

DROP POLICY IF EXISTS "kcda_read_store" ON public.kpi_campaign_store_daily_actuals;
CREATE POLICY "kcda_read_store" ON public.kpi_campaign_store_daily_actuals
  FOR SELECT TO authenticated
  USING (
    (store_id = (select public.get_user_store_id()) OR public.is_sm_for_store(store_id))
    AND public.can_read_kpi_campaign(campaign_id)
  );

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('075', 'kpi_campaign_sm_access',
        'sm role reads campaigns of its assigned stores: can_read_kpi_campaign + 4 store-scoped policies gain an sm branch via is_sm_for_store() (mig 045). Additive; staff/store_manager unchanged.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT policyname FROM pg_policies
--  WHERE tablename IN ('kpi_campaign_store_targets','kpi_campaign_store_tiers',
--                      'kpi_campaign_store_actuals','kpi_campaign_store_daily_actuals')
--    AND policyname LIKE '%_read_store';   -- 4 rows
-- SELECT version FROM public.app_migrations WHERE version = '075';
