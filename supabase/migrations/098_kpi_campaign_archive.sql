-- ============================================================================
-- 098_kpi_campaign_archive.sql
-- ⚠ DRAFT — CHƯA CHẠY cho tới khi stakeholder audit pass. Khi được duyệt:
--   PHẢI chạy TRƯỚC khi deploy code batch archive (code list/detail filter
--   archived_at — thiếu cột là query lỗi). Idempotent, pg_safeupdate-safe
--   (mọi UPDATE/DELETE có WHERE).
--
-- Contract cuối (stakeholder 28/07):
--   · Campaign paused/ended → SOFT ARCHIVE: biến mất khỏi TOÀN BỘ UI nhưng
--     GIỮ NGUYÊN target/tier/actual/daily/import-run (không xóa bảng con nào).
--   · draft giữ hard-delete (đường Xóa vĩnh viễn hiện hành, cascade như cũ).
--   · active KHÔNG archive được — phải tạm dừng trước (enforce trong RPC,
--     "kể cả ép server action/RPC" theo QA gate).
--
-- Nội dung:
--   A. kpi_campaigns + archived_at/archived_by/archived_reason (additive).
--   B. RPC MỚI rpc_archive_kpi_campaign — atomic: lock row → chỉ nhận
--      paused/ended, chưa archive → ghi người + thời điểm. service_role only.
--   C. REDEFINE rpc_replace_campaign_targets: body 093 NGUYÊN VĂN + đúng MỘT
--      guard archived (paused-đã-lưu-trữ không được nạp lại target — status
--      guard cũ 'draft/paused' một mình KHÔNG chặn được case này).
--   D. REDEFINE rpc_activate_kpi_campaign: body 093 NGUYÊN VĂN + đúng MỘT
--      guard archived (paused-đã-lưu-trữ không được kích hoạt lại).
--   E. (r1 — audit P1#1) REDEFINE rpc_replace_campaign_actuals: body 092
--      NGUYÊN VĂN + FOR UPDATE + guard archived khi đọc campaign. Đóng race
--      "sync đang chạy ↔ admin archive": sync ghi actuals SAU khi campaign đã
--      archive sẽ RAISE (archive commit trước → sync thấy archived_at khi lấy
--      lock); sync lấy lock trước → archive CHỜ tới khi sync commit rồi mới
--      archive (số liệu ghi trước thời điểm archive là hợp lệ, đóng băng từ
--      đó). Race import-target ↔ sync cũng serialize qua cùng row lock
--      (rpc_replace_campaign_targets đã FOR UPDATE từ 093).
--
-- RESTORE (SQL tay khi stakeholder cần khôi phục 1 campaign đã lưu trữ —
-- chưa có màn "Đã lưu trữ" theo chốt hiện tại):
--   UPDATE public.kpi_campaigns
--   SET archived_at = NULL, archived_by = NULL, archived_reason = NULL,
--       updated_at = now()
--   WHERE id = '<campaign-id>';
--
-- ROLLBACK (đầy đủ, tái tạo đúng trạng thái 092/093):
--   1. DROP FUNCTION IF EXISTS public.rpc_archive_kpi_campaign(uuid, uuid, text);
--   2. Tái tạo rpc_replace_campaign_targets + rpc_activate_kpi_campaign
--      NGUYÊN VĂN theo migration 093 (bỏ guard archived).
--   3. Tái tạo rpc_replace_campaign_actuals NGUYÊN VĂN theo migration 092
--      (bỏ FOR UPDATE + guard archived).
--   4. ALTER TABLE public.kpi_campaigns
--        DROP COLUMN IF EXISTS archived_reason,
--        DROP COLUMN IF EXISTS archived_by,
--        DROP COLUMN IF EXISTS archived_at;
--   5. DELETE FROM public.app_migrations WHERE version = '098';
-- ============================================================================

BEGIN;

-- ── Preflight ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT count(*) FROM public.app_migrations
      WHERE version IN ('069', '070', '071', '072', '092', '093')) <> 6 THEN
    RAISE EXCEPTION '098: thiếu migration nền KPI campaign — cần đủ 069/070/071/072/092/093 đã chạy';
  END IF;
END $$;

-- ── A. Cột archive (additive — row hiện hữu giữ NULL = chưa lưu trữ) ────────
ALTER TABLE public.kpi_campaigns
  ADD COLUMN IF NOT EXISTS archived_at     timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archived_reason text;

-- ── B. RPC archive — atomic, chỉ paused/ended, không đụng bảng con ──────────
-- Authz = app layer (requireSuper) + service_role only (mirror 093).
CREATE OR REPLACE FUNCTION public.rpc_archive_kpi_campaign(
  p_campaign_id uuid,
  p_actor       uuid,
  p_reason      text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_c record;
BEGIN
  SELECT id, status, archived_at INTO v_c
  FROM public.kpi_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF v_c.id IS NULL THEN
    RAISE EXCEPTION 'Campaign % không tồn tại', p_campaign_id;
  END IF;
  IF v_c.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Chiến dịch đã được lưu trữ trước đó';
  END IF;
  IF v_c.status = 'active' THEN
    RAISE EXCEPTION 'Chiến dịch đang chạy — tạm dừng trước khi lưu trữ';
  END IF;
  IF v_c.status NOT IN ('paused', 'ended') THEN
    -- draft đi đường Xóa vĩnh viễn, không lưu trữ.
    RAISE EXCEPTION 'Chỉ lưu trữ chiến dịch tạm dừng hoặc đã kết thúc (hiện: %)', v_c.status;
  END IF;

  UPDATE public.kpi_campaigns
  SET archived_at     = now(),
      archived_by     = p_actor,
      archived_reason = NULLIF(trim(coalesce(p_reason, '')), ''),
      updated_at      = now()
  WHERE id = p_campaign_id;

  RETURN jsonb_build_object('archived', true);
END $$;

REVOKE ALL ON FUNCTION public.rpc_archive_kpi_campaign(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_archive_kpi_campaign(uuid, uuid, text)
  TO service_role;

-- ── C. rpc_replace_campaign_targets: body 093 NGUYÊN VĂN + guard archived ───
-- Thay đổi DUY NHẤT so với 093: đọc thêm archived_at + RAISE khi đã lưu trữ
-- (campaign paused-đã-archive vẫn qua được guard status cũ). Mọi hành vi khác
-- — FOR UPDATE, validate rows/tiers, xóa actuals+daily, bump updated_at —
-- GIỮ NGUYÊN từng dòng.
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
  v_archived  timestamptz;
  v_tiers     integer;
  v_kt        numeric;
  v_group     text;
  v_th        numeric;
  v_cm        numeric;
  v_prev_th   numeric;
BEGIN
  -- 093: FOR UPDATE — import giữ khóa campaign row tới hết transaction;
  -- activation (cũng lock row này) phải chờ và thấy updated_at mới.
  SELECT status, archived_at INTO v_status, v_archived
  FROM public.kpi_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Campaign % không tồn tại', p_campaign_id; END IF;
  -- 098: guard archived (thay đổi duy nhất so với 093).
  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'Chiến dịch đã lưu trữ — không nạp target';
  END IF;
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

-- ── D. rpc_activate_kpi_campaign: body 093 NGUYÊN VĂN + guard archived ──────
-- Thay đổi DUY NHẤT so với 093: select thêm archived_at + RAISE khi đã lưu
-- trữ (paused-đã-archive không được kích hoạt lại).
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
  SELECT id, status, updated_at, metric_affiliate, archived_at INTO v_c
  FROM public.kpi_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF v_c.id IS NULL THEN
    RAISE EXCEPTION 'Campaign % không tồn tại', p_campaign_id;
  END IF;
  -- 098: guard archived (thay đổi duy nhất so với 093).
  IF v_c.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Chiến dịch đã lưu trữ — không kích hoạt';
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

-- ── E. (r1 — audit P1#1) rpc_replace_campaign_actuals: body 092 NGUYÊN VĂN
--    + FOR UPDATE + guard archived ───────────────────────────────────────────
-- Thay đổi DUY NHẤT so với 092 (2 dòng cùng một chỗ): dòng đọc campaign lấy
-- thêm archived_at + FOR UPDATE (serialize với rpc_archive_kpi_campaign —
-- cùng lock row) và RAISE khi đã lưu trữ TRƯỚC mọi DELETE/INSERT. Toàn bộ
-- validation (a)-(e) + per-row + replace-all + grants GIỮ NGUYÊN từng dòng.
CREATE OR REPLACE FUNCTION public.rpc_replace_campaign_actuals(
  p_campaign_id uuid,
  p_daily   jsonb,  -- [{store_id, date, gmv, gmv_affiliate?, synced_at}]
  p_actuals jsonb   -- [{store_id, actual_value, actual_offline?, actual_affiliate?,
                    --   run_rate, remaining_target, achieved_tier_order,
                    --   store_commission_pool, raw_row_count,
                    --   offline_synced_at?, affiliate_synced_at?, synced_at}]
                    -- (key có ? = caller cũ không gửi → fallback legacy)
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row         jsonb;
  v_count       integer := 0;
  v_m_offline   boolean;
  v_m_affiliate boolean;
  v_archived    timestamptz;
  v_store       uuid;
  v_value       numeric;
  v_offline     numeric;
  v_affiliate   numeric;
  v_daily_off   numeric;
  v_daily_aff   numeric;
BEGIN
  -- ── VALIDATE (trước mọi thao tác ghi) ──
  -- 098: FOR UPDATE + archived (thay đổi duy nhất so với 092) — sync ghi số
  -- liệu serialize với archive; campaign đã lưu trữ → RAISE, không ghi gì.
  SELECT metric_offline, metric_affiliate, archived_at
  INTO v_m_offline, v_m_affiliate, v_archived
  FROM public.kpi_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign % không tồn tại', p_campaign_id;
  END IF;
  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign % đã lưu trữ — không ghi số liệu', p_campaign_id;
  END IF;

  -- r2 (audit P1 tập payload): replace-all xóa snapshot cũ nên payload phải là
  -- BỨC TRANH ĐẦY ĐỦ — thiếu/vượt/trùng đều từ chối trước khi xóa.
  -- (a) Không duplicate store trong p_actuals.
  IF (SELECT count(*) FROM jsonb_array_elements(coalesce(p_actuals, '[]'::jsonb)) e)
     <> (SELECT count(DISTINCT e->>'store_id') FROM jsonb_array_elements(coalesce(p_actuals, '[]'::jsonb)) e) THEN
    RAISE EXCEPTION 'rpc_replace_campaign_actuals: p_actuals có store trùng lặp';
  END IF;
  -- (b) Không duplicate (store_id, date) trong p_daily.
  IF (SELECT count(*) FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e)
     <> (SELECT count(DISTINCT (e->>'store_id') || '|' || (e->>'date')) FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e) THEN
    RAISE EXCEPTION 'rpc_replace_campaign_actuals: p_daily có (store_id, date) trùng lặp';
  END IF;
  -- (c) MỖI target của campaign phải có ĐÚNG MỘT aggregate (targets ⊆ actuals;
  --     chiều ngược actuals ⊆ targets check per-row bên dưới).
  IF EXISTS (
    SELECT 1 FROM public.kpi_campaign_store_targets t
    WHERE t.campaign_id = p_campaign_id
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(p_actuals, '[]'::jsonb)) e
        WHERE (e->>'store_id')::uuid = t.store_id)
  ) THEN
    RAISE EXCEPTION 'rpc_replace_campaign_actuals: p_actuals THIẾU aggregate cho ít nhất 1 store trong targets của campaign % — payload phải đủ toàn bộ targets (replace-all)', p_campaign_id;
  END IF;
  -- (d) Store trong p_daily phải có aggregate trong p_actuals (daily ⊆ actuals).
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(p_actuals, '[]'::jsonb)) a
      WHERE a->>'store_id' = e->>'store_id')
  ) THEN
    RAISE EXCEPTION 'rpc_replace_campaign_actuals: p_daily chứa store không có aggregate trong p_actuals';
  END IF;
  -- (e) Store trong p_daily phải thuộc targets của campaign.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e
    WHERE NOT EXISTS (
      SELECT 1 FROM public.kpi_campaign_store_targets t
      WHERE t.campaign_id = p_campaign_id AND t.store_id = (e->>'store_id')::uuid)
  ) THEN
    RAISE EXCEPTION 'rpc_replace_campaign_actuals: p_daily chứa store ngoài targets của campaign %', p_campaign_id;
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_actuals, '[]'::jsonb))
  LOOP
    v_store     := (v_row->>'store_id')::uuid;
    v_value     := coalesce((v_row->>'actual_value')::numeric, 0);
    v_offline   := coalesce((v_row->>'actual_offline')::numeric, (v_row->>'actual_value')::numeric, 0);
    v_affiliate := coalesce((v_row->>'actual_affiliate')::numeric, 0);

    IF NOT EXISTS (SELECT 1 FROM public.kpi_campaign_store_targets t
                   WHERE t.campaign_id = p_campaign_id AND t.store_id = v_store) THEN
      RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % không thuộc targets của campaign %', v_store, p_campaign_id;
    END IF;
    IF abs(v_value - (v_offline + v_affiliate)) > 0.01 THEN
      RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % actual_value(%) <> actual_offline(%) + actual_affiliate(%)',
        v_store, v_value, v_offline, v_affiliate;
    END IF;
    IF NOT v_m_offline AND v_offline <> 0 THEN
      RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign tắt metric_offline nhưng store % có actual_offline=%', v_store, v_offline;
    END IF;
    IF NOT v_m_affiliate AND v_affiliate <> 0 THEN
      RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign tắt metric_affiliate nhưng store % có actual_affiliate=%', v_store, v_affiliate;
    END IF;

    SELECT coalesce(sum((e->>'gmv')::numeric), 0),
           coalesce(sum(coalesce((e->>'gmv_affiliate')::numeric, 0)), 0)
    INTO v_daily_off, v_daily_aff
    FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e
    WHERE (e->>'store_id')::uuid = v_store;
    IF abs(v_daily_off - v_offline) > 0.01 OR abs(v_daily_aff - v_affiliate) > 0.01 THEN
      RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % SUM(daily) off=%/aff=% không khớp aggregate off=%/aff=%',
        v_store, v_daily_off, v_daily_aff, v_offline, v_affiliate;
    END IF;
  END LOOP;

  -- ── REPLACE-ALL (nguyên logic 072; WHERE'd delete — pg_safeupdate-safe;
  --    dọn ghost khi re-import bớt store; 1 transaction: không bao giờ chart
  --    mới cạnh tổng cũ trên màn commission) ──
  DELETE FROM public.kpi_campaign_store_daily_actuals WHERE campaign_id = p_campaign_id;
  DELETE FROM public.kpi_campaign_store_actuals       WHERE campaign_id = p_campaign_id;

  INSERT INTO public.kpi_campaign_store_daily_actuals
    (campaign_id, store_id, date, gmv, gmv_affiliate, synced_at)
  SELECT p_campaign_id,
         (e->>'store_id')::uuid,
         (e->>'date')::date,
         coalesce((e->>'gmv')::numeric, 0),
         coalesce((e->>'gmv_affiliate')::numeric, 0),
         coalesce((e->>'synced_at')::timestamptz, now())
  FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e;

  FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_actuals, '[]'::jsonb))
  LOOP
    INSERT INTO public.kpi_campaign_store_actuals
      (campaign_id, store_id, actual_value, actual_offline, actual_affiliate,
       run_rate, remaining_target, achieved_tier_order, store_commission_pool,
       raw_row_count, offline_synced_at, affiliate_synced_at, synced_at)
    VALUES (
      p_campaign_id,
      (v_row->>'store_id')::uuid,
      coalesce((v_row->>'actual_value')::numeric, 0),
      -- fallback legacy: thiếu key mới → toàn bộ actual_value là offline
      coalesce((v_row->>'actual_offline')::numeric, (v_row->>'actual_value')::numeric, 0),
      coalesce((v_row->>'actual_affiliate')::numeric, 0),
      (v_row->>'run_rate')::numeric,
      (v_row->>'remaining_target')::numeric,
      (v_row->>'achieved_tier_order')::integer,
      (v_row->>'store_commission_pool')::numeric,
      coalesce((v_row->>'raw_row_count')::integer, 0),
      coalesce((v_row->>'offline_synced_at')::timestamptz, (v_row->>'synced_at')::timestamptz),
      (v_row->>'affiliate_synced_at')::timestamptz,
      coalesce((v_row->>'synced_at')::timestamptz, now())
    )
    ON CONFLICT (campaign_id, store_id) DO UPDATE SET
      actual_value          = EXCLUDED.actual_value,
      actual_offline        = EXCLUDED.actual_offline,
      actual_affiliate      = EXCLUDED.actual_affiliate,
      run_rate              = EXCLUDED.run_rate,
      remaining_target      = EXCLUDED.remaining_target,
      achieved_tier_order   = EXCLUDED.achieved_tier_order,
      store_commission_pool = EXCLUDED.store_commission_pool,
      raw_row_count         = EXCLUDED.raw_row_count,
      offline_synced_at     = EXCLUDED.offline_synced_at,
      affiliate_synced_at   = EXCLUDED.affiliate_synced_at,
      synced_at             = EXCLUDED.synced_at;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

-- Re-assert grants dù signature không đổi (bài học 091 — không tin default).
REVOKE ALL ON FUNCTION public.rpc_replace_campaign_actuals(uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_replace_campaign_actuals(uuid, jsonb, jsonb)
  TO service_role;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('098', 'kpi_campaign_archive',
        'Soft archive campaign paused/ended (contract 28/07): cột archived_at/by/reason; RPC rpc_archive_kpi_campaign (lock row, chỉ paused/ended chưa archive, active phải pause trước, draft đi đường delete, KHÔNG xóa bảng con — service_role only); REDEFINE rpc_replace_campaign_targets + rpc_activate_kpi_campaign = body 093 nguyên văn + đúng 1 guard archived mỗi RPC; r1 (audit P1#1) REDEFINE rpc_replace_campaign_actuals = body 092 nguyên văn + FOR UPDATE + guard archived (đóng race sync-đang-chạy ↔ archive: sync không bao giờ ghi actuals/daily sau khi campaign đã lưu trữ). Restore = SQL tay trong header. CHẠY TRƯỚC khi deploy code batch archive.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau migration):
-- 1) 3 cột mới:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name='kpi_campaigns' AND column_name LIKE 'archived%';  -- 3 rows
-- 2) SELECT proname, prosecdef FROM pg_proc WHERE proname IN
--    ('rpc_archive_kpi_campaign','rpc_replace_campaign_targets',
--     'rpc_activate_kpi_campaign','rpc_replace_campaign_actuals');
--    -- 4 rows, prosecdef = t
-- 3) Grant matrix (cả 4 function): has_function_privilege anon/authenticated
--    = false, service_role = true.
-- 3b) (r1) rpc_replace_campaign_actuals giữ nguyên 092 + thêm lock/guard
--    (cả 4 vế phải TRUE):
--    with f as (select lower(pg_get_functiondef(
--      'public.rpc_replace_campaign_actuals(uuid,jsonb,jsonb)'::regprocedure)) as body)
--    select position('for update' in body) > 0                             as has_row_lock,
--           position('đã lưu trữ' in body) > 0                             as has_archived_guard,
--           position('p_actuals có store trùng lặp' in body) > 0           as keeps_validation,
--           position('on conflict (campaign_id, store_id)' in body) > 0    as keeps_upsert
--    from f;
-- 4) Guard giữ nguyên 093 + thêm archived (cả 3 vế phải TRUE):
--    with f as (select lower(pg_get_functiondef(
--      'public.rpc_replace_campaign_targets(uuid,jsonb,text,uuid)'::regprocedure)) as body)
--    select position('for update' in body) > 0            as has_row_lock,
--           position('đã lưu trữ' in body) > 0            as has_archived_guard,
--           position('delete from public.kpi_campaign_store_actuals' in body) > 0 as clears_actuals
--    from f;
-- 5) Hành vi RPC archive (test trên campaign is_test):
--    · draft → RAISE 'Chỉ lưu trữ…'; active → RAISE 'đang chạy — tạm dừng trước'
--    · paused → {archived:true}; gọi lại → RAISE 'đã được lưu trữ trước đó'
--    · SAU archive: đếm bảng con (targets/tiers/actuals/daily/import_runs)
--      KHÔNG đổi so với trước archive.
--    · rpc_activate trên campaign vừa archive → RAISE 'đã lưu trữ'.
--    · rpc_replace_campaign_targets trên campaign vừa archive → RAISE 'đã lưu trữ'.
--    · rpc_replace_campaign_actuals trên campaign vừa archive → RAISE 'đã lưu
--      trữ — không ghi số liệu'; đếm actuals/daily KHÔNG đổi.
-- 5b) (r1) RACE sync ↔ archive (2 session psql trên campaign is_test paused):
--    · Session A: BEGIN; gọi rpc_replace_campaign_actuals(...) — GIỮ tx mở.
--    · Session B: gọi rpc_archive_kpi_campaign → PHẢI CHỜ (row lock).
--    · A COMMIT → B hoàn tất archive; actuals của A là snapshot cuối hợp lệ.
--    · Đảo chiều: B archive commit trước → A gọi actuals → RAISE 'đã lưu trữ'.
--    RACE import ↔ sync: A giữ tx rpc_replace_campaign_targets → B gọi
--    rpc_replace_campaign_actuals PHẢI CHỜ (cùng row lock FOR UPDATE).
-- 6) app_migrations '098' = 1 row.
-- ============================================================================
