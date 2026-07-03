-- ============================================================
-- Migration 072: KPI Campaign daily actuals (staff progress chart)
-- ============================================================
-- The staff/SM campaign view needs a per-day GMV series ("Tiến độ theo ngày",
-- "GMV hôm nay") — the aggregate snapshot alone can't drive a chart, and the
-- page must NOT query BigQuery live. The sync (cron + "Đồng bộ doanh số từ BI")
-- now pulls daily rows per campaign (GROUP BY pos_code, date — chunked by month
-- to stay under runBigQuery's 1000-row cap) and derives the aggregate snapshot
-- FROM these rows, so the chart and the totals can never disagree.
--
-- Run order for QA/prod: 069 -> 070 -> 071 -> 072.
-- Idempotent. pg_safeupdate-safe. Records 072.
-- ROLLBACK: drop table + policies.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.kpi_campaign_store_daily_actuals (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid        NOT NULL REFERENCES public.kpi_campaigns(id) ON DELETE CASCADE,
  store_id    uuid        NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  date        date        NOT NULL,
  gmv         numeric     NOT NULL DEFAULT 0,
  synced_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, store_id, date)
);
CREATE INDEX IF NOT EXISTS idx_kcda_campaign_store_date
  ON public.kpi_campaign_store_daily_actuals (campaign_id, store_id, date);

ALTER TABLE public.kpi_campaign_store_daily_actuals ENABLE ROW LEVEL SECURITY;

-- Super admin: full (mirror 069's *_super_all).
DROP POLICY IF EXISTS "kcda_super_all" ON public.kpi_campaign_store_daily_actuals;
CREATE POLICY "kcda_super_all" ON public.kpi_campaign_store_daily_actuals
  FOR ALL TO authenticated
  USING ((select public.is_super_admin())) WITH CHECK ((select public.is_super_admin()));

-- Staff/Store Manager: own store's rows of a readable (active, non-test,
-- participating) campaign — same SECDEF gate as 070, no cross-table recursion.
DROP POLICY IF EXISTS "kcda_read_store" ON public.kpi_campaign_store_daily_actuals;
CREATE POLICY "kcda_read_store" ON public.kpi_campaign_store_daily_actuals
  FOR SELECT TO authenticated
  USING (
    store_id = (select public.get_user_store_id())
    AND public.can_read_kpi_campaign(campaign_id)
  );
-- No write policies: service role (sync) only.

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('072', 'kpi_campaign_daily_actuals',
        'per-day GMV per campaign/store for the staff progress chart; sync derives aggregates from these rows')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- Verify (after 069 -> 070 -> 071 -> 072)
-- ============================================================
-- SELECT table_name FROM information_schema.tables WHERE table_name='kpi_campaign_store_daily_actuals';
-- SELECT policyname FROM pg_policies WHERE tablename='kpi_campaign_store_daily_actuals';
--   expect: kcda_super_all, kcda_read_store
-- Consistency check (run after a sync): expect 0 rows
-- SELECT a.campaign_id, a.store_id, a.actual_value, d.sum_gmv
-- FROM public.kpi_campaign_store_actuals a
-- JOIN (SELECT campaign_id, store_id, SUM(gmv) AS sum_gmv
--       FROM public.kpi_campaign_store_daily_actuals GROUP BY 1,2) d
--   ON d.campaign_id = a.campaign_id AND d.store_id = a.store_id
-- WHERE d.sum_gmv <> a.actual_value;
-- SELECT version FROM public.app_migrations WHERE version='072';
