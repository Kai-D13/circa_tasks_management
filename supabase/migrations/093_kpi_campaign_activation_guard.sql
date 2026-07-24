-- ============================================================================
-- 093_kpi_campaign_activation_guard.sql
-- ⚠ DRAFT — CHƯA CHẠY cho tới khi audit pass. Khi được duyệt: PHẢI chạy TRƯỚC
--   khi deploy code Phase 3 (toggleCampaign gọi rpc_activate_kpi_campaign —
--   thiếu function là activation hỏng). Function-only, KHÔNG đổi data/schema
--   bảng — idempotent, pg_safeupdate-safe.
--
-- P3-D r1 (audit 23/07 — P1 race giữa sửa campaign / import target / kích hoạt):
--   1. rpc_replace_campaign_targets: khóa campaign row (SELECT ... FOR UPDATE)
--      TRƯỚC khi check status — import và activation serialize với nhau.
--   2. RPC MỚI rpc_activate_kpi_campaign: activation ATOMIC trong DB —
--      lock row → status IN (draft,paused) → updated_at đúng kỳ vọng (import
--      RPC bump updated_at cuối transaction → import xen giữa sẽ bị bắt) →
--      có target → (affiliate) mọi target OS-active + affiliate run mới nhất
--      vẫn là run READY app vừa kiểm (expected_run_id) → mới set active.
--      Health gate vẫn chạy ở app TRƯỚC RPC; RPC là chốt chặn race; sync
--      engine (double-check health) là lớp fail-safe cuối.
-- ROLLBACK: tái tạo rpc_replace_campaign_targets từ 071 (bỏ FOR UPDATE);
--   DROP FUNCTION rpc_activate_kpi_campaign; DELETE app_migrations '093'.
-- ============================================================================

BEGIN;

-- ── 1) rpc_replace_campaign_targets: thêm FOR UPDATE ────────────────────────
-- r1.1 (audit P1): body lấy từ MIGRATION 072 (bản đang có hiệu lực — 072 đã
-- thêm 2 lệnh xóa actuals/daily khi thay target; bản draft trước lấy nhầm 071
-- làm mất hành vi này). Thay đổi DUY NHẤT so với 072 = FOR UPDATE ở dòng đọc
-- status. User đã verify pre-093: has_row_lock=false, clears_actuals=true,
-- clears_daily_actuals=true → sau 093 cả 3 phải = true.
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
  -- 093: FOR UPDATE — import giữ khóa campaign row tới hết transaction;
  -- activation (cũng lock row này) phải chờ và thấy updated_at mới.
  SELECT status INTO v_status FROM public.kpi_campaigns WHERE id = p_campaign_id FOR UPDATE;
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
  -- the same tx; next sync repopulates. (Hành vi 072 — GIỮ NGUYÊN.)
  DELETE FROM public.kpi_campaign_store_actuals       WHERE campaign_id = p_campaign_id;
  DELETE FROM public.kpi_campaign_store_daily_actuals WHERE campaign_id = p_campaign_id;

  UPDATE public.kpi_campaigns SET updated_at = now() WHERE id = p_campaign_id;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.rpc_replace_campaign_targets(uuid, jsonb, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_replace_campaign_targets(uuid, jsonb, text, uuid)
  TO service_role;

-- ── 2) rpc_activate_kpi_campaign: activation atomic ─────────────────────────
-- Authz = app layer (requireSuper) + service_role only; anon/authenticated
-- không gọi trực tiếp. p_expected_run_id: NULL cho campaign offline-only.
CREATE OR REPLACE FUNCTION public.rpc_activate_kpi_campaign(
  p_campaign_id         uuid,
  p_expected_updated_at timestamptz,
  p_expected_run_id     uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_c            record;
  v_target_count integer;
  v_bad          integer;
  v_latest_id    uuid;
  v_latest_st    text;
BEGIN
  SELECT id, status, updated_at, metric_affiliate INTO v_c
  FROM public.kpi_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF v_c.id IS NULL THEN
    RAISE EXCEPTION 'Campaign % không tồn tại', p_campaign_id;
  END IF;
  IF v_c.status NOT IN ('draft', 'paused') THEN
    RAISE EXCEPTION 'Chỉ kích hoạt từ draft/paused (hiện: %)', v_c.status;
  END IF;
  IF p_expected_updated_at IS NULL OR v_c.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Cấu hình chiến dịch vừa thay đổi (import/sửa song song) — tải lại trang rồi thử lại';
  END IF;

  SELECT count(*) INTO v_target_count
  FROM public.kpi_campaign_store_targets WHERE campaign_id = p_campaign_id;
  IF v_target_count = 0 THEN
    RAISE EXCEPTION 'Chưa import target cho chiến dịch này';
  END IF;

  IF v_c.metric_affiliate IS TRUE THEN
    SELECT count(*) INTO v_bad
    FROM public.kpi_campaign_store_targets t
    LEFT JOIN public.stores s ON s.id = t.store_id
    WHERE t.campaign_id = p_campaign_id
      AND (s.id IS NULL OR s.store_type <> 'os' OR s.is_active IS DISTINCT FROM true);
    IF v_bad > 0 THEN
      RAISE EXCEPTION '% target không phải OS store active — không kích hoạt campaign affiliate', v_bad;
    END IF;

    IF p_expected_run_id IS NULL THEN
      RAISE EXCEPTION 'Thiếu run id nguồn affiliate — app phải kiểm health READY trước khi kích hoạt';
    END IF;
    SELECT id, status INTO v_latest_id, v_latest_st
    FROM public.affiliate_sync_runs ORDER BY started_at DESC LIMIT 1;
    IF v_latest_id IS DISTINCT FROM p_expected_run_id OR v_latest_st IS DISTINCT FROM 'success' THEN
      RAISE EXCEPTION 'Nguồn affiliate vừa thay đổi (run % / %) — kiểm tra lại health rồi thử lại',
        coalesce(v_latest_id::text, 'null'), coalesce(v_latest_st, 'null');
    END IF;
  END IF;

  UPDATE public.kpi_campaigns
  SET status = 'active', updated_at = now()
  WHERE id = p_campaign_id;

  RETURN jsonb_build_object('activated', true);
END $$;

REVOKE ALL ON FUNCTION public.rpc_activate_kpi_campaign(uuid, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_activate_kpi_campaign(uuid, timestamptz, uuid)
  TO service_role;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('093', 'kpi_campaign_activation_guard',
        'P3-D r1.1: rpc_replace_campaign_targets = body 072 (GIỮ xóa actuals + daily khi thay target) + FOR UPDATE duy nhất (import/activation serialize); RPC mới rpc_activate_kpi_campaign — lock row, status draft/paused, updated_at đúng kỳ vọng (bắt import/sửa xen giữa), có target, affiliate: mọi target OS-active + latest affiliate run == expected_run_id (success). Grants: service_role only, revoke anon/authenticated tường minh. CHẠY TRƯỚC khi deploy code Phase 3.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (script thực thi: webapp/scripts/qa-kpi-activation-093.mjs)
-- 0) REGRESSION ĐỊNH NGHĨA FUNCTION (chạy SQL tay SAU 093 — cả 3 phải TRUE;
--    user đã verify pre-093: false/true/true):
--    with f as (select lower(pg_get_functiondef(
--      'public.rpc_replace_campaign_targets(uuid,jsonb,text,uuid)'::regprocedure)) as body)
--    select position('for update' in body) > 0 as has_row_lock,
--           position('delete from public.kpi_campaign_store_actuals' in body) > 0 as clears_actuals,
--           position('delete from public.kpi_campaign_store_daily_actuals' in body) > 0 as clears_daily_actuals
--    from f;
-- 1) SELECT proname, prosecdef FROM pg_proc
--    WHERE proname IN ('rpc_replace_campaign_targets','rpc_activate_kpi_campaign');  -- 2 row, secdef=t
-- 2) has_function_privilege matrix: anon/authenticated=false, service_role=true cho cả 2.
-- 3) rpc_activate với expected_updated_at SAI → RAISE 'vừa thay đổi'.
-- 4) rpc_activate đúng kỳ vọng trên campaign draft is_test → activated=true;
--    gọi lại → RAISE 'Chỉ kích hoạt từ draft/paused'.
-- 5) update campaign (bump updated_at) rồi activate bằng updated_at CŨ → RAISE
--    (bằng chứng metric-update vs activation chỉ 1 thao tác thắng).
-- 6) campaign affiliate: expected_run_id sai/thiếu → RAISE.
-- 7) replace-target POSITIVE (service role): import mới → targets/tiers/import
--    run đúng; actuals + daily actuals VỀ 0; import trên campaign ACTIVE bị RAISE.
-- 8) app_migrations '093' = 1 row.
-- ============================================================================
