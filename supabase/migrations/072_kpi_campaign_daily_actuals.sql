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

-- Atomic sync write: replace the campaign's daily rows AND upsert the aggregate
-- snapshots in ONE transaction — a partial failure can never leave a fresh chart
-- next to a stale total (or vice versa) on a commission screen. Any RAISE rolls
-- back everything; the caller (cron / "Đồng bộ doanh số từ BI") just retries.
CREATE OR REPLACE FUNCTION public.rpc_replace_campaign_actuals(
  p_campaign_id uuid,
  p_daily   jsonb,  -- [{store_id, date, gmv, synced_at}]
  p_actuals jsonb   -- [{store_id, actual_value, run_rate, remaining_target, achieved_tier_order, store_commission_pool, raw_row_count, synced_at}]
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row   jsonb;
  v_count integer := 0;
BEGIN
  -- Replace-all BOTH tables (WHERE'd deletes — pg_safeupdate-safe; also clears
  -- ghosts when payloads are empty). Aggregate rows of stores REMOVED from the
  -- campaign (re-import with fewer stores) must not keep contributing to the
  -- totals on the Kết quả tab / campaign list.
  DELETE FROM public.kpi_campaign_store_daily_actuals WHERE campaign_id = p_campaign_id;
  DELETE FROM public.kpi_campaign_store_actuals       WHERE campaign_id = p_campaign_id;

  INSERT INTO public.kpi_campaign_store_daily_actuals (campaign_id, store_id, date, gmv, synced_at)
  SELECT p_campaign_id,
         (e->>'store_id')::uuid,
         (e->>'date')::date,
         coalesce((e->>'gmv')::numeric, 0),
         coalesce((e->>'synced_at')::timestamptz, now())
  FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e;

  FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_actuals, '[]'::jsonb))
  LOOP
    INSERT INTO public.kpi_campaign_store_actuals
      (campaign_id, store_id, actual_value, run_rate, remaining_target,
       achieved_tier_order, store_commission_pool, raw_row_count, synced_at)
    VALUES (
      p_campaign_id,
      (v_row->>'store_id')::uuid,
      coalesce((v_row->>'actual_value')::numeric, 0),
      (v_row->>'run_rate')::numeric,
      (v_row->>'remaining_target')::numeric,
      (v_row->>'achieved_tier_order')::integer,
      (v_row->>'store_commission_pool')::numeric,
      coalesce((v_row->>'raw_row_count')::integer, 0),
      coalesce((v_row->>'synced_at')::timestamptz, now())
    )
    ON CONFLICT (campaign_id, store_id) DO UPDATE SET
      actual_value          = EXCLUDED.actual_value,
      run_rate              = EXCLUDED.run_rate,
      remaining_target      = EXCLUDED.remaining_target,
      achieved_tier_order   = EXCLUDED.achieved_tier_order,
      store_commission_pool = EXCLUDED.store_commission_pool,
      raw_row_count         = EXCLUDED.raw_row_count,
      synced_at             = EXCLUDED.synced_at;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.rpc_replace_campaign_actuals(uuid, jsonb, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_replace_campaign_actuals(uuid, jsonb, jsonb) TO service_role;

-- FINAL version of the import RPC (supersedes 071's — defined here because it
-- now touches the daily table created above): identical body PLUS clearing the
-- campaign's actual snapshots + daily series in the SAME transaction. A target
-- re-import invalidates every previously computed number (they were graded
-- against the OLD targets/tiers); the UI then shows "Chưa đồng bộ doanh số"
-- until the next "Đồng bộ doanh số từ BI".
CREATE OR REPLACE FUNCTION public.rpc_replace_campaign_targets(
  p_campaign_id uuid,
  p_rows        jsonb,   -- [{store_id, pos_code, kpi_target, store_kpi_group, import_row, note, tiers:[{tier_order, threshold_pct, commission_amount}]}]
  p_file_name   text DEFAULT NULL,
  p_uploaded_by uuid DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row       jsonb;
  v_tier      jsonb;
  v_target_id uuid;
  v_count     integer := 0;
  v_status    text;
  v_tiers     integer;
  v_kt        numeric;
  v_group     text;
  v_th        numeric;
  v_cm        numeric;
  v_prev_th   numeric;
BEGIN
  SELECT status INTO v_status FROM public.kpi_campaigns WHERE id = p_campaign_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Campaign % không tồn tại', p_campaign_id; END IF;
  IF v_status NOT IN ('draft', 'paused') THEN
    RAISE EXCEPTION 'Chỉ nạp target khi chiến dịch draft/paused (hiện: %)', v_status;
  END IF;

  DELETE FROM public.kpi_campaign_store_targets WHERE campaign_id = p_campaign_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_kt := (v_row->>'kpi_target')::numeric;
    IF v_kt IS NULL OR v_kt <= 0 THEN RAISE EXCEPTION 'kpi_target phải > 0'; END IF;
    v_group := NULLIF(trim(coalesce(v_row->>'store_kpi_group', '')), '');
    IF v_group IS NULL THEN RAISE EXCEPTION 'store_kpi_group là bắt buộc'; END IF;

    INSERT INTO public.kpi_campaign_store_targets
      (campaign_id, store_id, pos_code, kpi_target, store_kpi_group, import_row, note)
    VALUES (
      p_campaign_id,
      (v_row->>'store_id')::uuid,
      v_row->>'pos_code',
      v_kt,
      v_group,
      NULLIF(v_row->>'import_row', '')::integer,
      NULLIF(v_row->>'note', '')
    )
    RETURNING id INTO v_target_id;

    v_tiers := 0;
    v_prev_th := NULL;
    FOR v_tier IN SELECT * FROM jsonb_array_elements(coalesce(v_row->'tiers', '[]'::jsonb))
    LOOP
      v_th := (v_tier->>'threshold_pct')::numeric;
      v_cm := (v_tier->>'commission_amount')::numeric;
      IF v_th IS NULL OR v_th <= 0 THEN RAISE EXCEPTION 'threshold_pct phải > 0'; END IF;
      IF v_prev_th IS NOT NULL AND v_th <= v_prev_th THEN
        RAISE EXCEPTION 'threshold các bậc phải tăng dần (% <= %)', v_th, v_prev_th;
      END IF;
      IF v_cm IS NULL OR v_cm < 0 THEN RAISE EXCEPTION 'commission_amount phải >= 0'; END IF;
      INSERT INTO public.kpi_campaign_store_tiers
        (target_id, tier_order, threshold_pct, commission_amount)
      VALUES (v_target_id, (v_tier->>'tier_order')::integer, v_th, v_cm);
      v_prev_th := v_th;
      v_tiers := v_tiers + 1;
    END LOOP;
    IF v_tiers = 0 THEN RAISE EXCEPTION 'Mỗi target cần ít nhất 1 bậc'; END IF;

    v_count := v_count + 1;
  END LOOP;

  INSERT INTO public.kpi_campaign_import_runs
    (campaign_id, file_name, uploaded_by, row_count, success_count, error_count)
  VALUES (p_campaign_id, p_file_name, p_uploaded_by, v_count, v_count, 0);

  -- Targets changed → every previously computed actual/pool is stale. Clear in
  -- the same tx; next sync repopulates.
  DELETE FROM public.kpi_campaign_store_actuals       WHERE campaign_id = p_campaign_id;
  DELETE FROM public.kpi_campaign_store_daily_actuals WHERE campaign_id = p_campaign_id;

  UPDATE public.kpi_campaigns SET updated_at = now() WHERE id = p_campaign_id;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.rpc_replace_campaign_targets(uuid, jsonb, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_replace_campaign_targets(uuid, jsonb, text, uuid) TO service_role;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('072', 'kpi_campaign_daily_actuals',
        'per-day GMV per campaign/store for the staff progress chart; rpc_replace_campaign_actuals writes daily + aggregate in one tx')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- Verify (after 069 -> 070 -> 071 -> 072)
-- ============================================================
-- SELECT table_name FROM information_schema.tables WHERE table_name='kpi_campaign_store_daily_actuals';
-- SELECT policyname FROM pg_policies WHERE tablename='kpi_campaign_store_daily_actuals';
--   expect: kcda_super_all, kcda_read_store
-- SELECT proname, prosecdef FROM pg_proc WHERE proname='rpc_replace_campaign_actuals';
-- Consistency check (run after a sync): expect 0 rows
-- SELECT a.campaign_id, a.store_id, a.actual_value, d.sum_gmv
-- FROM public.kpi_campaign_store_actuals a
-- JOIN (SELECT campaign_id, store_id, SUM(gmv) AS sum_gmv
--       FROM public.kpi_campaign_store_daily_actuals GROUP BY 1,2) d
--   ON d.campaign_id = a.campaign_id AND d.store_id = a.store_id
-- WHERE d.sum_gmv <> a.actual_value;
-- SELECT version FROM public.app_migrations WHERE version='072';
