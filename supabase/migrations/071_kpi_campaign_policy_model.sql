-- ============================================================
-- Migration 071: KPI Campaign v3 — policy model (store commission POOL)
-- ============================================================
-- Official commission policy email (effective 07/2026): each store has its own
-- monthly KPI; stores are CLASSIFIED into KPI groups; each group has fixed-amount
-- payouts at 90/100/105% — and the amount is the STORE's total commission POOL
-- (per-pharmacist split by work-hours + violation deductions are OUT of scope).
-- The policy table is NOT hardcoded — the per-campaign import file carries the
-- resolved values per store.
--
-- Delta over 069 (applied on prod) + 070 (pending): semantic renames + new fields.
-- Run order for fresh QA/prod: 069 -> 070 -> 071.
--   * kpi_campaign_store_targets: final_target -> kpi_target; + store_kpi_group
--     (required display label, free text, e.g. "Nhỏ hơn 500 triệu").
--   * kpi_campaign_store_actuals: actual_gmv -> actual_value;
--     achieved_commission_amount -> store_commission_pool.
--   * kpi_campaigns: + metric_type ('gmv' only this phase) + order_type
--     ('all' this phase; online/offline reserved — needs a BI field first).
--   * rpc_replace_campaign_targets: reads kpi_target + store_kpi_group (required).
-- Idempotent (rename DO-blocks check information_schema). pg_safeupdate-safe.
-- ROLLBACK: reverse the renames, drop store_kpi_group/metric_type/order_type,
-- restore 070's RPC body.
-- ============================================================

BEGIN;

-- 1) targets: final_target -> kpi_target; + store_kpi_group
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='kpi_campaign_store_targets'
               AND column_name='final_target') THEN
    ALTER TABLE public.kpi_campaign_store_targets RENAME COLUMN final_target TO kpi_target;
  END IF;
END $$;
ALTER TABLE public.kpi_campaign_store_targets
  ADD COLUMN IF NOT EXISTS store_kpi_group text;

-- 2) actuals: actual_gmv -> actual_value; achieved_commission_amount -> store_commission_pool
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='kpi_campaign_store_actuals'
               AND column_name='actual_gmv') THEN
    ALTER TABLE public.kpi_campaign_store_actuals RENAME COLUMN actual_gmv TO actual_value;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='kpi_campaign_store_actuals'
               AND column_name='achieved_commission_amount') THEN
    ALTER TABLE public.kpi_campaign_store_actuals RENAME COLUMN achieved_commission_amount TO store_commission_pool;
  END IF;
END $$;

-- 3) campaigns: metric/order type (future-proof; this phase locks gmv/all)
ALTER TABLE public.kpi_campaigns
  ADD COLUMN IF NOT EXISTS metric_type text NOT NULL DEFAULT 'gmv' CHECK (metric_type IN ('gmv')),
  ADD COLUMN IF NOT EXISTS order_type  text NOT NULL DEFAULT 'all' CHECK (order_type IN ('all', 'online', 'offline'));

-- 4) Import RPC: kpi_target (>0) + store_kpi_group (REQUIRED — the UI shows the
--    store's policy group) + fixed-amount tiers. Guards unchanged otherwise;
--    import_run audit stays in the same transaction.
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
    FOR v_tier IN SELECT * FROM jsonb_array_elements(coalesce(v_row->'tiers', '[]'::jsonb))
    LOOP
      v_th := (v_tier->>'threshold_pct')::numeric;
      v_cm := (v_tier->>'commission_amount')::numeric;
      IF v_th IS NULL OR v_th <= 0 THEN RAISE EXCEPTION 'threshold_pct phải > 0'; END IF;
      IF v_cm IS NULL OR v_cm < 0 THEN RAISE EXCEPTION 'commission_amount phải >= 0'; END IF;
      INSERT INTO public.kpi_campaign_store_tiers
        (target_id, tier_order, threshold_pct, commission_amount)
      VALUES (v_target_id, (v_tier->>'tier_order')::integer, v_th, v_cm);
      v_tiers := v_tiers + 1;
    END LOOP;
    IF v_tiers = 0 THEN RAISE EXCEPTION 'Mỗi target cần ít nhất 1 bậc'; END IF;

    v_count := v_count + 1;
  END LOOP;

  INSERT INTO public.kpi_campaign_import_runs
    (campaign_id, file_name, uploaded_by, row_count, success_count, error_count)
  VALUES (p_campaign_id, p_file_name, p_uploaded_by, v_count, v_count, 0);

  UPDATE public.kpi_campaigns SET updated_at = now() WHERE id = p_campaign_id;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.rpc_replace_campaign_targets(uuid, jsonb, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_replace_campaign_targets(uuid, jsonb, text, uuid) TO service_role;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('071', 'kpi_campaign_policy_model',
        'kpi_target + store_kpi_group + actual_value + store_commission_pool + metric/order_type + RPC update (store commission pool policy)')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- Verify (after 069 -> 070 -> 071)
-- ============================================================
-- 1) Renames + new columns:
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='kpi_campaign_store_targets'
--     AND column_name IN ('kpi_target','store_kpi_group','final_target');
--   expect: kpi_target, store_kpi_group (NO final_target)
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='kpi_campaign_store_actuals'
--     AND column_name IN ('actual_value','store_commission_pool','actual_gmv','achieved_commission_amount');
--   expect: actual_value, store_commission_pool only
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='kpi_campaigns' AND column_name IN ('metric_type','order_type');
--   expect: 2 rows
-- 2) Migration recorded:
-- SELECT version FROM public.app_migrations WHERE version='071';
