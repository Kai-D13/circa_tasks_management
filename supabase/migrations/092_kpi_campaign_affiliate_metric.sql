-- ============================================================================
-- 092_kpi_campaign_affiliate_metric.sql
-- ⚠ DRAFT — KHÔNG chạy cho tới rollout bước 2 (sau khi stakeholder duyệt plan
--   v1.1 [docs/plan-kpi-affiliate-metric.md] và code deploy với
--   KPI_AFFILIATE_ENABLED=false). Additive, idempotent, pg_safeupdate-safe.
--
-- KPI Campaign × GMV Affiliate (plan v1.1, audit stakeholder 22/07):
--   1. kpi_campaigns: metric_offline / metric_affiliate (campaign cũ tự
--      offline-only — hành vi + số liệu KHÔNG đổi).
--   2. kpi_campaign_store_actuals: actual_offline / actual_affiliate
--      (NOT NULL DEFAULT 0) + offline_synced_at / affiliate_synced_at
--      + BACKFILL dữ liệu cũ (toàn bộ là offline).
--   3. kpi_campaign_store_daily_actuals: gmv_affiliate (gmv giữ nghĩa offline).
--   4. Seed mapping CIRCA-MIZUKI → POS0013 (os; preflight RAISE — manifest
--      153 đơn / 23 code, xem docs/affiliate-partner-manifest.md).
--   5. Partial index cho aggregation (delivered + active).
--   6. RPC MỚI rpc_aggregate_affiliate_gmv — SUM trong DB (né cap 1000 row
--      của PostgREST), service_role only.
--   7. CREATE OR REPLACE rpc_replace_campaign_actuals (SIGNATURE GIỮ NGUYÊN)
--      ghi thêm cột mới; re-assert grants (bài học 091: default grant
--      EXECUTE cho anon/authenticated phải revoke đích danh).
--
-- CONTRACT KPI (audit 22/07 — KHÁC rule hiển thị affiliate cũ):
--   • Đơn tính GMV = status_norm='delivered' AND source_active (ingestion F2
--     vẫn lưu MỌI status; transition PROCESSING→DELIVERED cộng ở sync sau,
--     DELIVERED→CANCELED trừ ở sync sau — full-snapshot tự xử lý).
--   • Attribution DUY NHẤT: partner_code → affiliate_partner_mappings → store.
--     TUYỆT ĐỐI KHÔNG dùng assigned_store_id (= store xử lý đơn, không phải
--     store được ghi nhận).
--   • NGÀY GHI NHẬN: tạm created_time (AT TIME ZONE Asia/Ho_Chi_Minh — khớp
--     ngày VN của BigQuery). Stakeholder đang chốt created_time vs ngày giao
--     thành công; nếu đổi → sửa DUY NHẤT biểu thức vn_date trong
--     rpc_aggregate_affiliate_gmv (mục 6).
--
-- ROLLBACK: DROP FUNCTION rpc_aggregate_affiliate_gmv; tái tạo
--   rpc_replace_campaign_actuals từ 072; DROP INDEX
--   idx_affiliate_orders_store_delivered; DROP các cột mới (metric_*,
--   actual_offline/affiliate, *_synced_at, gmv_affiliate) + CHECK;
--   DELETE FROM affiliate_partner_mappings WHERE partner_code='CIRCA-MIZUKI';
--   DELETE FROM app_migrations WHERE version='092'.
-- ============================================================================

BEGIN;

-- ── 1) kpi_campaigns: metric flags ──────────────────────────────────────────
ALTER TABLE public.kpi_campaigns
  ADD COLUMN IF NOT EXISTS metric_offline   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS metric_affiliate boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_kpi_campaigns_metric' AND conrelid = 'public.kpi_campaigns'::regclass
  ) THEN
    ALTER TABLE public.kpi_campaigns
      ADD CONSTRAINT chk_kpi_campaigns_metric CHECK (metric_offline OR metric_affiliate);
  END IF;
END $$;

-- ── 2) actuals: breakdown + synced_at từng nguồn + backfill ─────────────────
ALTER TABLE public.kpi_campaign_store_actuals
  ADD COLUMN IF NOT EXISTS actual_offline      numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_affiliate    numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS offline_synced_at   timestamptz,
  ADD COLUMN IF NOT EXISTS affiliate_synced_at timestamptz;

-- Backfill: dữ liệu tồn tại trước 092 toàn bộ là offline. Idempotent: chỉ đụng
-- row chưa từng sync dưới schema mới (cả 2 synced_at NULL); actual_value giữ
-- nguyên tuyệt đối (regression vàng). Có WHERE → pg_safeupdate-safe.
UPDATE public.kpi_campaign_store_actuals
SET actual_offline    = actual_value,
    actual_affiliate  = 0,
    offline_synced_at = synced_at
WHERE offline_synced_at IS NULL AND affiliate_synced_at IS NULL;

-- ── 3) daily: gmv_affiliate (gmv giữ nghĩa = offline) ───────────────────────
ALTER TABLE public.kpi_campaign_store_daily_actuals
  ADD COLUMN IF NOT EXISTS gmv_affiliate numeric NOT NULL DEFAULT 0;

-- ── 4) Seed CIRCA-MIZUKI → POS0013 (manifest 153/23; preflight y 090) ───────
DO $$
DECLARE v_store uuid; v_type text; v_active boolean;
BEGIN
  SELECT id, store_type, is_active INTO v_store, v_type, v_active
  FROM public.stores WHERE code = 'POS0013';
  IF v_store IS NULL THEN
    RAISE EXCEPTION 'affiliate seed 092: store POS0013 (CIRCA-MIZUKI) không tồn tại';
  END IF;
  IF v_type IS DISTINCT FROM 'os' THEN
    RAISE EXCEPTION 'affiliate seed 092: POS0013 có store_type=% nhưng manifest ghi os', v_type;
  END IF;
  IF v_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'affiliate seed 092: POS0013 đang ngưng hoạt động — xác nhận lại manifest';
  END IF;
  INSERT INTO public.affiliate_partner_mappings (partner_code, store_id, partner_type, display_name)
  VALUES ('CIRCA-MIZUKI', v_store, 'os', 'CIRCA MIZUKI')
  ON CONFLICT (partner_code) DO NOTHING;
END $$;

-- ── 5) Partial index aggregation (KPI chỉ đọc delivered + active) ───────────
CREATE INDEX IF NOT EXISTS idx_affiliate_orders_store_delivered
  ON public.affiliate_orders (store_id, created_time DESC)
  WHERE source_active AND status_norm = 'delivered';

-- ── 6) RPC aggregate GMV affiliate trong DB ─────────────────────────────────
-- SUM/GROUP BY chạy trong Postgres → không đụng cap 1000 row PostgREST khi
-- affiliate_orders lớn lên. STABLE + SECURITY DEFINER; CHỈ service_role.
-- p_from inclusive (00:00 VN ngày start), p_to exclusive (00:00 VN ngày sau end).
CREATE OR REPLACE FUNCTION public.rpc_aggregate_affiliate_gmv(
  p_store_ids uuid[],
  p_from      timestamptz,
  p_to        timestamptz
) RETURNS TABLE (store_id uuid, vn_date date, gmv numeric, order_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.store_id,
         -- NGÀY GHI NHẬN (xem header): đổi biểu thức này nếu stakeholder chốt
         -- field khác created_time.
         (o.created_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS vn_date,
         SUM(o.total_price)                                     AS gmv,
         count(*)::integer                                      AS order_count
  FROM public.affiliate_orders o
  WHERE o.source_active
    AND o.status_norm = 'delivered'
    AND o.store_id = ANY (p_store_ids)
    AND o.created_time >= p_from
    AND o.created_time <  p_to
  GROUP BY o.store_id, 2
$$;

REVOKE ALL ON FUNCTION public.rpc_aggregate_affiliate_gmv(uuid[], timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_aggregate_affiliate_gmv(uuid[], timestamptz, timestamptz)
  TO service_role;

-- ── 7) rpc_replace_campaign_actuals: ghi cột mới ────────────────────────────
-- SIGNATURE GIỮ NGUYÊN (uuid, jsonb, jsonb) — jsonb chỉ mang thêm key. Payload
-- thiếu key mới (caller cũ) → coalesce về default → hành vi cũ nguyên vẹn.
CREATE OR REPLACE FUNCTION public.rpc_replace_campaign_actuals(
  p_campaign_id uuid,
  p_daily   jsonb,  -- [{store_id, date, gmv, gmv_affiliate, synced_at}]
  p_actuals jsonb   -- [{store_id, actual_value, actual_offline, actual_affiliate,
                    --   run_rate, remaining_target, achieved_tier_order,
                    --   store_commission_pool, raw_row_count,
                    --   offline_synced_at, affiliate_synced_at, synced_at}]
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row   jsonb;
  v_count integer := 0;
BEGIN
  -- Replace-all cả 2 bảng (WHERE'd delete — pg_safeupdate-safe; dọn ghost khi
  -- re-import bớt store). Toàn bộ trong 1 transaction: không bao giờ chart mới
  -- cạnh tổng cũ trên màn hình commission.
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
      coalesce((v_row->>'actual_offline')::numeric, 0),
      coalesce((v_row->>'actual_affiliate')::numeric, 0),
      (v_row->>'run_rate')::numeric,
      (v_row->>'remaining_target')::numeric,
      (v_row->>'achieved_tier_order')::integer,
      (v_row->>'store_commission_pool')::numeric,
      coalesce((v_row->>'raw_row_count')::integer, 0),
      (v_row->>'offline_synced_at')::timestamptz,
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

-- ── app_migrations ──────────────────────────────────────────────────────────
INSERT INTO public.app_migrations (version, name, notes)
VALUES ('092', 'kpi_campaign_affiliate_metric',
        'KPI Campaign × GMV Affiliate (plan v1.1): metric_offline/metric_affiliate + CHECK ≥1; actuals actual_offline/actual_affiliate (backfill = actual_value/0) + offline/affiliate_synced_at; daily gmv_affiliate; seed CIRCA-MIZUKI→POS0013 (manifest 153/23); partial index (store_id, created_time) delivered+active; RPC rpc_aggregate_affiliate_gmv (SUM trong DB, DELIVERED-only, ngày VN theo created_time — pending chốt field ngày) service_role-only; replace rpc_replace_campaign_actuals ghi cột mới, re-assert grants.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau migration — kỳ vọng ghi cạnh từng câu)
-- ============================================================================
-- 1) Cột mới:
--   SELECT column_name, is_nullable, column_default FROM information_schema.columns
--   WHERE table_name='kpi_campaigns' AND column_name IN ('metric_offline','metric_affiliate');
--   -- 2 row; default true / false
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='kpi_campaign_store_actuals'
--     AND column_name IN ('actual_offline','actual_affiliate','offline_synced_at','affiliate_synced_at');
--   -- 4 row
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='kpi_campaign_store_daily_actuals' AND column_name='gmv_affiliate';
--   -- 1 row
-- 2) CHECK:
--   SELECT conname FROM pg_constraint WHERE conname='chk_kpi_campaigns_metric';  -- 1 row
-- 3) Backfill (regression vàng — actual_value KHÔNG đổi):
--   SELECT count(*) FROM public.kpi_campaign_store_actuals
--   WHERE actual_offline <> actual_value OR actual_affiliate <> 0;               -- 0
-- 4) Mapping MIZUKI:
--   SELECT partner_code, partner_type, s.code FROM public.affiliate_partner_mappings m
--   JOIN public.stores s ON s.id = m.store_id WHERE partner_code='CIRCA-MIZUKI';
--   -- 1 row: os / POS0013;  tổng mapping = 23:
--   SELECT count(*) FROM public.affiliate_partner_mappings;                      -- 23
-- 5) Index:
--   SELECT indexname FROM pg_indexes WHERE indexname='idx_affiliate_orders_store_delivered'; -- 1 row
-- 6) Quyền RPC (ma trận — kỳ vọng service_role=t, anon/authenticated=f):
--   SELECT r.rolname,
--          has_function_privilege(r.rolname,'public.rpc_aggregate_affiliate_gmv(uuid[],timestamptz,timestamptz)','EXECUTE') AS agg,
--          has_function_privilege(r.rolname,'public.rpc_replace_campaign_actuals(uuid,jsonb,jsonb)','EXECUTE') AS replace
--   FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role');
-- 7) app_migrations:
--   SELECT version, name FROM public.app_migrations WHERE version='092';         -- 1 row
-- 8) Smoke aggregate (đọc, không ghi — sau backfill F2):
--   SELECT * FROM public.rpc_aggregate_affiliate_gmv(
--     (SELECT array_agg(DISTINCT store_id) FROM public.affiliate_partner_mappings WHERE store_id IS NOT NULL),
--     '2026-06-30T17:00:00Z', '2026-07-31T17:00:00Z');
--   -- kỳ vọng: chỉ store OS/FS có đơn delivered; tổng khớp baseline manifest.
-- ============================================================================
