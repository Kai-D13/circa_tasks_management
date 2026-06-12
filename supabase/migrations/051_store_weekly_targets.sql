-- ============================================================
-- Migration 051: Weekly sales targets per store (Power BI feed)
-- ============================================================
-- Stakeholder ask (2026-06-12): pharmacists see their store's weekly sales
-- target/actual from the BI report "Current Week Achievement by POS".
-- Data flows IN through the app only (super-admin XLSX upload as fallback,
-- /api/targets/ingest for the automated Power Automate/API push) — both run
-- through the service role, so this table has NO write policies at all.
--
-- Business semantics from the BI file (do NOT recompute in app code):
--   run_rate         = actual / target (stored as percent 0-100+)
--   remaining_target = min_weekly_target - actual  (vs the 90% MIN target!)
--   status           = BI's verdict ('Achieved' / 'Not Achieved')
--
-- RLS: read-only policies built ONLY on the SECURITY DEFINER helpers
-- get_user_role()/get_user_store_id()/is_super_admin() — no cross-table
-- references (047→049 lesson).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.store_weekly_targets (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           uuid        NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  week_start         date        NOT NULL,
  target             numeric     NOT NULL,
  min_weekly_target  numeric,
  actual             numeric     NOT NULL DEFAULT 0,
  run_rate           numeric,
  status             text,
  remaining_target   numeric,
  refreshed_at       timestamptz NOT NULL DEFAULT now(),
  source             text        NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'api')),
  uploaded_by        uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  UNIQUE (store_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_swt_week ON public.store_weekly_targets (week_start DESC);

ALTER TABLE public.store_weekly_targets ENABLE ROW LEVEL SECURITY;

-- Staff + store manager read their own store's numbers; admins read all
-- (management/verification view). SM intentionally excluded in v1 — the tab
-- is a staff feature per the stakeholder spec.
DROP POLICY IF EXISTS "swt_select" ON public.store_weekly_targets;
CREATE POLICY "swt_select" ON public.store_weekly_targets
  FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR (select get_user_role()) = 'admin'
    OR store_id = (select get_user_store_id())
  );

-- No INSERT/UPDATE/DELETE policies: all writes go through the service role.

-- Record this migration.
INSERT INTO public.app_migrations (version, name)
VALUES ('051', 'store_weekly_targets')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Table + unique key:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='store_weekly_targets';
-- expect: 12 columns listed above
--
-- 2) Exactly one (read-only) policy:
-- SELECT policyname, cmd FROM pg_policies WHERE tablename='store_weekly_targets';
-- expect: swt_select / SELECT only
--
-- 3) Migration recorded:
-- SELECT version FROM public.app_migrations WHERE version='051';
