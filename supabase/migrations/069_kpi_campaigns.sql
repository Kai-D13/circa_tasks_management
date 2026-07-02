-- ============================================================
-- Migration 069: KPI Campaign module — Phase 1 (super-admin config, Store mode)
-- ============================================================
-- New "KPI Campaign" feature: super admin defines a sales campaign (date range,
-- ON/OFF via status) and imports per-store targets + commission tiers from XLSX.
-- PURELY ADDITIVE — does not touch store_kpi_targets / /api/cron/pull-kpi-targets
-- / the current /targets day-week-month flow.
--
-- Business rules (computed in app, not here):
--   run_rate   = actual_gmv / final_target * 100   (actual = SUM(gmv) over range)
--   tier hit   = highest tier where threshold_pct <= run_rate
--   commission = actual_gmv * tier.commission_pct / 100  (highest tier, not cumulative)
--
-- Phase 1 = super-admin only (RLS super gate on every table). Staff/Store Manager
-- read policies (active, non-test, own store) are added later with the display phase.
-- Idempotent. pg_safeupdate-safe. Records 069.
-- ============================================================

BEGIN;

-- 1) Campaigns ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kpi_campaigns (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  start_date  date        NOT NULL,
  end_date    date        NOT NULL,
  scope_type  text        NOT NULL DEFAULT 'store' CHECK (scope_type IN ('store', 'staff')),
  status      text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'ended')),
  is_test     boolean     NOT NULL DEFAULT false,
  created_by  uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

-- 2) Per-store target (one row per store per campaign) -----------------------
CREATE TABLE IF NOT EXISTS public.kpi_campaign_store_targets (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid        NOT NULL REFERENCES public.kpi_campaigns(id) ON DELETE CASCADE,
  store_id     uuid        NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  pos_code     text,
  final_target numeric     NOT NULL,              -- whole-campaign GMV target
  import_row   integer,                            -- source row # (audit)
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, store_id)
);
CREATE INDEX IF NOT EXISTS idx_kct_campaign ON public.kpi_campaign_store_targets (campaign_id);

-- 3) Commission tiers per store-target (N tiers, flexible) --------------------
CREATE TABLE IF NOT EXISTS public.kpi_campaign_store_tiers (
  id             uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id      uuid    NOT NULL REFERENCES public.kpi_campaign_store_targets(id) ON DELETE CASCADE,
  tier_order     integer NOT NULL,        -- 1,2,3,... ascending by threshold
  threshold_pct  numeric NOT NULL,        -- e.g. 90, 100, 105
  commission_pct numeric NOT NULL,        -- % applied to actual_gmv at this tier
  UNIQUE (target_id, tier_order)
);
CREATE INDEX IF NOT EXISTS idx_kct_tiers_target ON public.kpi_campaign_store_tiers (target_id);

-- 4) Import audit ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kpi_campaign_import_runs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid        REFERENCES public.kpi_campaigns(id) ON DELETE CASCADE,
  file_name     text,
  uploaded_by   uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  row_count     integer     NOT NULL DEFAULT 0,
  success_count integer     NOT NULL DEFAULT 0,
  error_count   integer     NOT NULL DEFAULT 0,
  errors        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 5) Actual GMV snapshot (Phase 1D writes it; table created now to avoid churn) --
CREATE TABLE IF NOT EXISTS public.kpi_campaign_store_actuals (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         uuid        NOT NULL REFERENCES public.kpi_campaigns(id) ON DELETE CASCADE,
  store_id            uuid        NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  actual_gmv          numeric     NOT NULL DEFAULT 0,
  run_rate            numeric,
  achieved_tier_order integer,
  synced_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, store_id)
);

-- 6) Atomic replace-all import (targets + tiers in ONE transaction) ----------
-- Called by commitCampaignImport (super admin) only when campaign is draft/paused.
-- Delete (has WHERE → pg_safeupdate-safe; cascade drops tiers) then insert.
CREATE OR REPLACE FUNCTION public.rpc_replace_campaign_targets(
  p_campaign_id uuid,
  p_rows        jsonb   -- [{store_id, pos_code, final_target, import_row, note, tiers:[{tier_order, threshold_pct, commission_pct}]}]
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row       jsonb;
  v_tier      jsonb;
  v_target_id uuid;
  v_count     integer := 0;
BEGIN
  DELETE FROM public.kpi_campaign_store_targets WHERE campaign_id = p_campaign_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    INSERT INTO public.kpi_campaign_store_targets
      (campaign_id, store_id, pos_code, final_target, import_row, note)
    VALUES (
      p_campaign_id,
      (v_row->>'store_id')::uuid,
      v_row->>'pos_code',
      (v_row->>'final_target')::numeric,
      NULLIF(v_row->>'import_row', '')::integer,
      NULLIF(v_row->>'note', '')
    )
    RETURNING id INTO v_target_id;

    FOR v_tier IN SELECT * FROM jsonb_array_elements(coalesce(v_row->'tiers', '[]'::jsonb))
    LOOP
      INSERT INTO public.kpi_campaign_store_tiers
        (target_id, tier_order, threshold_pct, commission_pct)
      VALUES (
        v_target_id,
        (v_tier->>'tier_order')::integer,
        (v_tier->>'threshold_pct')::numeric,
        (v_tier->>'commission_pct')::numeric
      );
    END LOOP;

    v_count := v_count + 1;
  END LOOP;

  UPDATE public.kpi_campaigns SET updated_at = now() WHERE id = p_campaign_id;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.rpc_replace_campaign_targets(uuid, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_replace_campaign_targets(uuid, jsonb) TO service_role;

-- 7) RLS — Phase 1: super admin only, every table (FOR ALL = select+ins+upd+del).
--    Import writes also go via the service-role RPC (bypasses RLS). Staff/SM read
--    policies come with the display phase.
ALTER TABLE public.kpi_campaigns              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kpi_campaign_store_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kpi_campaign_store_tiers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kpi_campaign_import_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kpi_campaign_store_actuals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kc_super_all" ON public.kpi_campaigns;
CREATE POLICY "kc_super_all" ON public.kpi_campaigns
  FOR ALL TO authenticated
  USING ((select public.is_super_admin())) WITH CHECK ((select public.is_super_admin()));

DROP POLICY IF EXISTS "kct_super_all" ON public.kpi_campaign_store_targets;
CREATE POLICY "kct_super_all" ON public.kpi_campaign_store_targets
  FOR ALL TO authenticated
  USING ((select public.is_super_admin())) WITH CHECK ((select public.is_super_admin()));

DROP POLICY IF EXISTS "kctier_super_all" ON public.kpi_campaign_store_tiers;
CREATE POLICY "kctier_super_all" ON public.kpi_campaign_store_tiers
  FOR ALL TO authenticated
  USING ((select public.is_super_admin())) WITH CHECK ((select public.is_super_admin()));

DROP POLICY IF EXISTS "kcir_super_all" ON public.kpi_campaign_import_runs;
CREATE POLICY "kcir_super_all" ON public.kpi_campaign_import_runs
  FOR ALL TO authenticated
  USING ((select public.is_super_admin())) WITH CHECK ((select public.is_super_admin()));

DROP POLICY IF EXISTS "kca_super_all" ON public.kpi_campaign_store_actuals;
CREATE POLICY "kca_super_all" ON public.kpi_campaign_store_actuals
  FOR ALL TO authenticated
  USING ((select public.is_super_admin())) WITH CHECK ((select public.is_super_admin()));

INSERT INTO public.app_migrations (version, name)
VALUES ('069', 'kpi_campaigns')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- Verify
-- ============================================================
-- 1) 5 tables:
-- SELECT table_name FROM information_schema.tables WHERE table_schema='public'
--   AND table_name LIKE 'kpi_campaign%';
-- 2) RPC exists + SECURITY DEFINER:
-- SELECT proname, prosecdef FROM pg_proc WHERE proname='rpc_replace_campaign_targets';
-- 3) One super-admin policy per table:
-- SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename LIKE 'kpi_campaign%';
-- 4) Migration recorded:
-- SELECT version FROM public.app_migrations WHERE version='069';
