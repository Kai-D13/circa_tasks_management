-- ============================================================
-- Migration 070: KPI Campaign v2 — fixed-amount commission + multi-campaign
--                + Staff/Store Manager read access
-- ============================================================
-- Stakeholder pivots after Phase-1 QA (069 is ALREADY APPLIED, so this is a
-- delta migration):
--   1. Commission per tier is a FIXED AMOUNT (money number), not a percent:
--      rename kpi_campaign_store_tiers.commission_pct -> commission_amount.
--      Payout = the amount of the HIGHEST tier reached (not cumulative).
--   2. Multiple campaigns may run simultaneously on the same store (the old
--      one-active-campaign-per-store rule is dropped — app-side change only).
--   3. Staff + Store Manager read access to THEIR store's campaigns (display
--      phase): new SECDEF helper + additive read policies. The helper contains
--      every cross-table condition, so no policy references another RLS table
--      in a cycle (047->049 recursion lesson).
--   4. kpi_campaign_store_actuals gains display snapshot columns
--      (remaining_target, achieved_commission_amount, raw_row_count) so the
--      staff card reads one row without recomputing.
--
-- ⚠ SEQUENCING: the deployed app (<= 0fe538d/b8a6d32) still writes
-- commission_pct. Run this only while KPI_CAMPAIGN_ENABLED=false on prod
-- (already done 2026-07-02); localhost QA runs the new code against this schema.
--
-- Idempotent. pg_safeupdate-safe (no bare UPDATE/DELETE). Records 070.
-- ROLLBACK: rename commission_amount back to commission_pct; restore 069's
-- rpc_replace_campaign_targets; drop the 4 *_read_store policies +
-- can_read_kpi_campaign(); drop the 3 new actuals columns.
-- ============================================================

BEGIN;

-- 1) Rename tier commission column (skip if an earlier 070 run already did it).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'kpi_campaign_store_tiers'
      AND column_name = 'commission_pct'
  ) THEN
    ALTER TABLE public.kpi_campaign_store_tiers RENAME COLUMN commission_pct TO commission_amount;
  END IF;
END $$;

-- 2) Actuals snapshot columns for the display card.
ALTER TABLE public.kpi_campaign_store_actuals
  ADD COLUMN IF NOT EXISTS remaining_target           numeric,
  ADD COLUMN IF NOT EXISTS achieved_commission_amount numeric,
  ADD COLUMN IF NOT EXISTS raw_row_count              integer;

-- 3) Replace the import RPC: writes commission_amount (guards unchanged:
--    campaign exists & draft/paused, final_target>0, threshold>0, >=1 tier;
--    commission_amount >= 0). Same signature as 069's version.
CREATE OR REPLACE FUNCTION public.rpc_replace_campaign_targets(
  p_campaign_id uuid,
  p_rows        jsonb,   -- [{store_id, pos_code, final_target, import_row, note, tiers:[{tier_order, threshold_pct, commission_amount}]}]
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
  v_ft        numeric;
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
    v_ft := (v_row->>'final_target')::numeric;
    IF v_ft IS NULL OR v_ft <= 0 THEN RAISE EXCEPTION 'final_target phải > 0'; END IF;

    INSERT INTO public.kpi_campaign_store_targets
      (campaign_id, store_id, pos_code, final_target, import_row, note)
    VALUES (
      p_campaign_id,
      (v_row->>'store_id')::uuid,
      v_row->>'pos_code',
      v_ft,
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

-- 4) SECDEF read gate: a campaign is readable by the CURRENT user (staff or
--    store_manager — anyone whose users.store_id participates) iff it is
--    active, non-test, and has a target for their store. Runs as the function
--    owner (bypasses RLS) → policies below never reference another RLS table
--    directly → no cross-table recursion.
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
      AND t.store_id = (SELECT public.get_user_store_id())
  )
$$;
GRANT EXECUTE ON FUNCTION public.can_read_kpi_campaign(uuid) TO authenticated;

-- 5) Additive read policies (the 5 super FOR ALL policies from 069 stay).
--    Staff + store_manager both match via users.store_id (admin/sm have NULL).
DROP POLICY IF EXISTS "kc_read_store" ON public.kpi_campaigns;
CREATE POLICY "kc_read_store" ON public.kpi_campaigns
  FOR SELECT TO authenticated
  USING (public.can_read_kpi_campaign(id));

DROP POLICY IF EXISTS "kct_read_store" ON public.kpi_campaign_store_targets;
CREATE POLICY "kct_read_store" ON public.kpi_campaign_store_targets
  FOR SELECT TO authenticated
  USING (
    store_id = (select public.get_user_store_id())
    AND public.can_read_kpi_campaign(campaign_id)
  );

DROP POLICY IF EXISTS "kctier_read_store" ON public.kpi_campaign_store_tiers;
CREATE POLICY "kctier_read_store" ON public.kpi_campaign_store_tiers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.kpi_campaign_store_targets t
      WHERE t.id = kpi_campaign_store_tiers.target_id
        AND t.store_id = (select public.get_user_store_id())
        AND public.can_read_kpi_campaign(t.campaign_id)
    )
  );

DROP POLICY IF EXISTS "kca_read_store" ON public.kpi_campaign_store_actuals;
CREATE POLICY "kca_read_store" ON public.kpi_campaign_store_actuals
  FOR SELECT TO authenticated
  USING (
    store_id = (select public.get_user_store_id())
    AND public.can_read_kpi_campaign(campaign_id)
  );

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('070', 'kpi_campaign_v2',
        'commission_pct->commission_amount + RPC update + can_read_kpi_campaign + staff/SM read policies + actuals snapshot cols')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Column renamed:
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='kpi_campaign_store_tiers' AND column_name IN ('commission_pct','commission_amount');
--   expect: only commission_amount
-- 2) Actuals columns:
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='kpi_campaign_store_actuals'
--   AND column_name IN ('remaining_target','achieved_commission_amount','raw_row_count');
--   expect: 3 rows
-- 3) Helper + policies:
-- SELECT proname, prosecdef FROM pg_proc WHERE proname='can_read_kpi_campaign';
-- SELECT tablename, policyname FROM pg_policies
--   WHERE tablename LIKE 'kpi_campaign%' ORDER BY 1,2;
--   expect: 5 *_super_all + 4 *_read_store
-- 4) Migration recorded:
-- SELECT version FROM public.app_migrations WHERE version='070';
