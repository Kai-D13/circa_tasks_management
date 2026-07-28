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
--
-- RESTORE (SQL tay khi stakeholder cần khôi phục 1 campaign đã lưu trữ —
-- chưa có màn "Đã lưu trữ" theo chốt hiện tại):
--   UPDATE public.kpi_campaigns
--   SET archived_at = NULL, archived_by = NULL, archived_reason = NULL,
--       updated_at = now()
--   WHERE id = '<campaign-id>';
--
-- ROLLBACK (đầy đủ, tái tạo đúng trạng thái 093):
--   1. DROP FUNCTION IF EXISTS public.rpc_archive_kpi_campaign(uuid, uuid, text);
--   2. Tái tạo rpc_replace_campaign_targets + rpc_activate_kpi_campaign
--      NGUYÊN VĂN theo migration 093 (bỏ guard archived).
--   3. ALTER TABLE public.kpi_campaigns
--        DROP COLUMN IF EXISTS archived_reason,
--        DROP COLUMN IF EXISTS archived_by,
--        DROP COLUMN IF EXISTS archived_at;
--   4. DELETE FROM public.app_migrations WHERE version = '098';
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

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('098', 'kpi_campaign_archive',
        'Soft archive campaign paused/ended (contract 28/07): cột archived_at/by/reason; RPC rpc_archive_kpi_campaign (lock row, chỉ paused/ended chưa archive, active phải pause trước, draft đi đường delete, KHÔNG xóa bảng con — service_role only); REDEFINE rpc_replace_campaign_targets + rpc_activate_kpi_campaign = body 093 nguyên văn + đúng 1 guard archived mỗi RPC (paused-đã-archive không import/activate được). Restore = SQL tay trong header. CHẠY TRƯỚC khi deploy code batch archive.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau migration):
-- 1) 3 cột mới:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name='kpi_campaigns' AND column_name LIKE 'archived%';  -- 3 rows
-- 2) SELECT proname, prosecdef FROM pg_proc WHERE proname IN
--    ('rpc_archive_kpi_campaign','rpc_replace_campaign_targets','rpc_activate_kpi_campaign');
--    -- 3 rows, prosecdef = t
-- 3) Grant matrix (cả 3 function): has_function_privilege anon/authenticated
--    = false, service_role = true.
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
-- 6) app_migrations '098' = 1 row.
-- ============================================================================
