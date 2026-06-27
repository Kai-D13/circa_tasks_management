-- ============================================================
-- Migration 067: store_kpi_targets (KPI v2 — Day / Week / Month)
-- ============================================================
-- BI replaced the weekly BigQuery feed with a DAILY table
-- (lakehouse-prod-394907.buymed_tech.tech__circa_os_gmv_kpi: month, week, date,
-- pos_code, pos_name, gmv, final_target). KPI v2 rebuilds /targets into three
-- grains (day/week/month). This table is the read source for the new page.
--
-- Built SIDE-BY-SIDE with store_weekly_targets (051/052), which stays untouched
-- for rollback. The new cron /api/cron/pull-kpi-targets aggregates the three
-- current periods per store IN BigQuery and upserts here — service role only,
-- so this table has NO write policies (mirrors 051/052).
--
-- One row per (store_id, period_type, period_start). The unique key upserts in
-- place (idempotent re-runs) and lets past periods accumulate as history.
--
-- Business rule (computed in the aggregator, NOT here):
--   actual = SUM(gmv)            target = SUM(final_target)
--   hasGoal = target > 0
--   run_rate = hasGoal ? actual/target*100 : NULL
--   remaining_target = hasGoal ? max(target-actual,0) : NULL
--   status = !hasGoal ? NULL : (actual>=target ? 'Achieved' : 'Not Achieved')
-- target = 0/NULL → UI shows "Chưa có mục tiêu" (never "Đã đạt").
--
-- RLS: read-only, built ONLY on SECURITY DEFINER helpers
-- is_super_admin()/get_user_role()/get_user_store_id() — no cross-table refs
-- (047→049 lesson). Idempotent. pg_safeupdate-safe (no bare DELETE/UPDATE).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.store_kpi_targets (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          uuid        NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  period_type       text        NOT NULL CHECK (period_type IN ('day', 'week', 'month')),
  period_start      date        NOT NULL,
  period_end        date        NOT NULL,
  actual            numeric     NOT NULL DEFAULT 0,
  target            numeric     NOT NULL DEFAULT 0,
  run_rate          numeric,                 -- percent, NULL when no goal
  status            text,                    -- 'Achieved' | 'Not Achieved' | NULL
  remaining_target  numeric,                 -- NULL when no goal
  raw_row_count     integer     NOT NULL DEFAULT 0,
  refreshed_at      timestamptz NOT NULL DEFAULT now(),
  source            text        NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'upload')),
  UNIQUE (store_id, period_type, period_start)
);

CREATE INDEX IF NOT EXISTS idx_skt_store_period
  ON public.store_kpi_targets (store_id, period_type, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_skt_period
  ON public.store_kpi_targets (period_type, period_start DESC);

ALTER TABLE public.store_kpi_targets ENABLE ROW LEVEL SECURITY;

-- Same gate as migration 052: super admin (manages the feed / all-stores
-- verification) + staff reading their OWN store. Nobody else. SECDEF helpers
-- only, no cross-table references.
DROP POLICY IF EXISTS "skt_select" ON public.store_kpi_targets;
CREATE POLICY "skt_select" ON public.store_kpi_targets
  FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR (
      (select get_user_role()) = 'staff'
      AND store_id = (select get_user_store_id())
    )
  );

-- No INSERT/UPDATE/DELETE policies: all writes go through the service role.

INSERT INTO public.app_migrations (version, name)
VALUES ('067', 'store_kpi_targets')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Columns (14):
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='store_kpi_targets'
--   ORDER BY ordinal_position;
--
-- 2) Exactly one (read-only) policy, super + staff branches, no admin branch:
-- SELECT policyname, cmd, qual FROM pg_policies
--   WHERE schemaname='public' AND tablename='store_kpi_targets';
--
-- 3) Unique + indexes:
-- SELECT indexname, indexdef FROM pg_indexes
--   WHERE schemaname='public' AND tablename='store_kpi_targets';
--
-- 4) Migration recorded:
-- SELECT version FROM public.app_migrations WHERE version='067';
