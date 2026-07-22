-- ============================================================================
-- 092_kpi_campaign_affiliate_metric.sql  (r2 — audit 22/07 vòng 2: exact
--   target-set validation + chống duplicate + seed MIZUKI harden + date basis
--   CHỐT = completed_time)
-- ⚠ DRAFT — ĐIỀU KIỆN trước khi chạy:
--   (1) [ĐÃ ĐÓNG 22/07] field ngày ghi nhận = completed_time (stakeholder chốt
--       sau bằng chứng field list Mongo: completed_time chuyên dụng "giao thành
--       công", 111/111 đơn DELIVERED có, trùng ngày VN với last_updated_time
--       111/111; delivery_date = ngày DỰ KIẾN nên không dùng).
--   (2) code deploy với KPI_AFFILIATE_ENABLED=false (rollout bước 1).
--   (3) chạy 092 TRƯỚC khi bật AFFILIATE_SYNC_ENABLED — F2 từ commit này upsert
--       thêm cột completed_time (mục 0), sync chạy trước 092 sẽ fail sạch
--       (rpc_fail) vì cột chưa tồn tại.
--   Additive, idempotent, pg_safeupdate-safe.
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

-- ── 0) affiliate_orders: cột completed_time (KPI date basis) ────────────────
-- F2 full-snapshot upsert mỗi 2h tự backfill giá trị cho mọi row sau lần sync
-- đầu tiên hậu-092 (không cần backfill tay).
ALTER TABLE public.affiliate_orders
  ADD COLUMN IF NOT EXISTS completed_time timestamptz;

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

-- ── 4) Seed code mới ĐÃ DUYỆT (manifest 157/24; preflight y 090) ────────────
--   • CIRCA-MIZUKI  → POS0013 (duyệt qua audit sáng 22/07)
--   • CIRCA-NAMVIET → POS0077 (duyệt 22/07 chiều — user xác nhận)
-- r2 (audit P2): mapping ĐÃ TỒN TẠI nhưng sai (khác store/loại/inactive) →
-- RAISE thay vì ON CONFLICT DO NOTHING im lặng giữ bản sai.
DO $$
DECLARE
  r record;
  v_store uuid; v_type text; v_active boolean;
  v_ex_store uuid; v_ex_type text; v_ex_active boolean;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('CIRCA-MIZUKI',  'POS0013', 'CIRCA MIZUKI'),
      ('CIRCA-NAMVIET', 'POS0077', 'CIRCA NAM VIET')
    ) AS m(partner_code, store_code, display_name)
  LOOP
    SELECT id, store_type, is_active INTO v_store, v_type, v_active
    FROM public.stores WHERE code = r.store_code;
    IF v_store IS NULL THEN
      RAISE EXCEPTION 'affiliate seed 092: store % (cho %) không tồn tại', r.store_code, r.partner_code;
    END IF;
    IF v_type IS DISTINCT FROM 'os' THEN
      RAISE EXCEPTION 'affiliate seed 092: store % có store_type=% nhưng manifest ghi os', r.store_code, v_type;
    END IF;
    IF v_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'affiliate seed 092: store % (partner %) đang ngưng hoạt động — xác nhận lại manifest', r.store_code, r.partner_code;
    END IF;

    SELECT store_id, partner_type, is_active INTO v_ex_store, v_ex_type, v_ex_active
    FROM public.affiliate_partner_mappings WHERE partner_code = r.partner_code;
    IF FOUND THEN
      IF v_ex_store IS DISTINCT FROM v_store OR v_ex_type IS DISTINCT FROM 'os'
         OR v_ex_active IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'affiliate seed 092: mapping % ĐÃ tồn tại nhưng SAI (store_id=%, type=%, active=%) — sửa tay rồi chạy lại, không im lặng giữ bản sai',
          r.partner_code, v_ex_store, v_ex_type, v_ex_active;
      END IF;
      -- đã tồn tại và ĐÚNG → idempotent, bỏ qua
    ELSE
      INSERT INTO public.affiliate_partner_mappings (partner_code, store_id, partner_type, display_name)
      VALUES (r.partner_code, v_store, 'os', r.display_name);
    END IF;
  END LOOP;
END $$;

-- ── 5) Partial index aggregation (KPI chỉ đọc delivered + active) ───────────
-- Date basis = completed_time (chốt 22/07).
CREATE INDEX IF NOT EXISTS idx_affiliate_orders_store_completed
  ON public.affiliate_orders (store_id, completed_time DESC)
  WHERE source_active AND status_norm = 'delivered';
-- Dọn index bản draft cũ nếu đã lỡ tạo (draft chưa từng chạy → thường no-op).
DROP INDEX IF EXISTS public.idx_affiliate_orders_store_delivered;

-- ── 6) RPC aggregate GMV affiliate trong DB ─────────────────────────────────
-- SUM/GROUP BY chạy trong Postgres → không đụng cap 1000 row PostgREST khi
-- affiliate_orders lớn lên. STABLE + SECURITY DEFINER; CHỈ service_role.
-- p_from inclusive (00:00 VN ngày start), p_to exclusive (00:00 VN ngày sau end).
-- DATE BASIS = completed_time (CHỐT 22/07): đơn DELIVERED tính vào ngày GIAO
-- THÀNH CÔNG — đơn tạo trước campaign nhưng giao trong campaign VẪN tính; đơn
-- giao sau end_date KHÔNG tính. completed_time NULL → tự loại khỏi range
-- (canary QA: đếm delivered thiếu completed_time phải = 0).
-- r2.1 FAIL-CLOSED (audit P1): store được tính KPI mà còn đơn active+DELIVERED
-- thiếu completed_time → RAISE (không âm thầm thiếu GMV); caller (syncCampaign)
-- bắt lỗi → KHÔNG ghi, KPI giữ snapshot cũ. Check trên TOÀN BỘ thời gian (đơn
-- thiếu mốc không thể xếp cửa sổ nào). Cron pull đã cảnh báo sớm cùng điều kiện
-- (delivered_missing_completed_time_count + status warning).
CREATE OR REPLACE FUNCTION public.rpc_aggregate_affiliate_gmv(
  p_store_ids uuid[],
  p_from      timestamptz,
  p_to        timestamptz
) RETURNS TABLE (store_id uuid, vn_date date, gmv numeric, order_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing
  FROM public.affiliate_orders o
  WHERE o.source_active
    AND o.status_norm = 'delivered'
    AND o.store_id = ANY (p_store_ids)
    AND o.completed_time IS NULL;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'rpc_aggregate_affiliate_gmv: % đơn DELIVERED active thiếu completed_time trong các store yêu cầu — fail-closed, giữ snapshot KPI cũ (kiểm tra nguồn/sync)', v_missing;
  END IF;

  RETURN QUERY
  SELECT o.store_id,
         (o.completed_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS vn_date,
         SUM(o.total_price)                                       AS gmv,
         count(*)::integer                                        AS order_count
  FROM public.affiliate_orders o
  WHERE o.source_active
    AND o.status_norm = 'delivered'
    AND o.store_id = ANY (p_store_ids)
    AND o.completed_time >= p_from
    AND o.completed_time <  p_to
  GROUP BY o.store_id, 2;
END $$;

REVOKE ALL ON FUNCTION public.rpc_aggregate_affiliate_gmv(uuid[], timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_aggregate_affiliate_gmv(uuid[], timestamptz, timestamptz)
  TO service_role;

-- ── 7) rpc_replace_campaign_actuals: ghi cột mới + VALIDATE (r1) ────────────
-- SIGNATURE GIỮ NGUYÊN (uuid, jsonb, jsonb).
-- BACKWARD-COMPAT (audit r1 P1): caller PRODUCTION CŨ chỉ gửi actual_value —
--   fallback actual_offline = actual_value (legacy = 100% offline),
--   actual_affiliate = 0, offline_synced_at = synced_at. Nếu coalesce về 0 như
--   bản draft, cron cũ chạy sau migration sẽ ghi actual_offline=0 → phá
--   breakdown + regression legacy.
-- DB VALIDATION (audit r1 P1): RPC là boundary của số liệu thưởng — không tin
--   payload service-role tuyệt đối. Validate TRƯỚC khi delete; mọi RAISE
--   rollback toàn transaction (không bao giờ nửa thành công):
--   • campaign tồn tại (đọc metric flags)
--   • mọi store (actuals + daily) thuộc targets của campaign
--   • actual_value = actual_offline + actual_affiliate (epsilon 0.01 — float
--     JS ↔ numeric)
--   • metric tắt → phần actual tương ứng phải = 0
--   • SUM(daily) từng store khớp aggregate từng nguồn (epsilon 0.01)
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
  v_store       uuid;
  v_value       numeric;
  v_offline     numeric;
  v_affiliate   numeric;
  v_daily_off   numeric;
  v_daily_aff   numeric;
BEGIN
  -- ── VALIDATE (trước mọi thao tác ghi) ──
  SELECT metric_offline, metric_affiliate INTO v_m_offline, v_m_affiliate
  FROM public.kpi_campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign % không tồn tại', p_campaign_id;
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

-- ── app_migrations ──────────────────────────────────────────────────────────
INSERT INTO public.app_migrations (version, name, notes)
VALUES ('092', 'kpi_campaign_affiliate_metric',
        'KPI Campaign × GMV Affiliate (plan v1.3, r2.1): affiliate_orders + completed_time (date basis CHỐT 22/07); metric_offline/metric_affiliate + CHECK ≥1; actuals actual_offline/actual_affiliate (backfill = actual_value/0) + offline/affiliate_synced_at; daily gmv_affiliate; seed CIRCA-MIZUKI→POS0013 + CIRCA-NAMVIET→POS0077 (đã duyệt; RAISE nếu mapping tồn tại sai); partial index (store_id, completed_time) delivered+active; RPC rpc_aggregate_affiliate_gmv (SUM trong DB theo ngày VN completed_time, DELIVERED-only, FAIL-CLOSED khi store có đơn delivered thiếu completed_time) service_role-only; replace rpc_replace_campaign_actuals: backward-compat fallback caller cũ + validation đầy đủ TRƯỚC delete (campaign tồn tại; no-dup store/(store,date); targets==actuals 2 chiều; daily⊆actuals⊆targets; actual_value=offline+affiliate; metric tắt→0; SUM daily khớp aggregate; RAISE rollback toàn transaction), re-assert grants.')
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
-- 4) Mapping mới (MIZUKI + NAMVIET):
--   SELECT partner_code, partner_type, s.code FROM public.affiliate_partner_mappings m
--   JOIN public.stores s ON s.id = m.store_id
--   WHERE partner_code IN ('CIRCA-MIZUKI','CIRCA-NAMVIET') ORDER BY partner_code;
--   -- 2 row: os/POS0013 + os/POS0077;  tổng mapping = 24:
--   SELECT count(*) FROM public.affiliate_partner_mappings;                      -- 24
-- 4b) Cột completed_time + canary DELIVERED thiếu mốc giao (sau sync đầu hậu-092):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='affiliate_orders' AND column_name='completed_time';       -- 1 row
--   SELECT count(*) FROM public.affiliate_orders
--   WHERE status_norm='delivered' AND source_active AND completed_time IS NULL; -- 0 (sau backfill)
-- 5) Index:
--   SELECT indexname FROM pg_indexes WHERE indexname='idx_affiliate_orders_store_completed'; -- 1 row
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
-- 9) Backward-compat legacy caller (r1 — smoke trên campaign is_test, dạng
--    payload CŨ không có key mới; yêu cầu store thuộc targets campaign đó):
--   SELECT public.rpc_replace_campaign_actuals('<test_campaign_id>',
--     '[{"store_id":"<store_in_targets>","date":"2026-07-01","gmv":100}]'::jsonb,
--     '[{"store_id":"<store_in_targets>","actual_value":100,"run_rate":10,"remaining_target":900,"raw_row_count":1}]'::jsonb);
--   SELECT actual_value, actual_offline, actual_affiliate, offline_synced_at IS NOT NULL AS has_off_ts
--   FROM public.kpi_campaign_store_actuals WHERE campaign_id='<test_campaign_id>';
--   -- kỳ vọng: 100 / 100 / 0 / true (KHÔNG phải 100/0/0 — đó chính là bug draft cũ)
-- 10) Validation RAISE (kỳ vọng LỖI, transaction rollback — script thực thi:
--     webapp/scripts/qa-kpi-affiliate-092.mjs chạy đủ các case này):
--   • store ngoài targets → 'không thuộc targets'
--   • p_actuals THIẾU 1 store trong targets → 'THIẾU aggregate' (r2)
--   • duplicate store trong p_actuals → 'trùng lặp' (r2)
--   • duplicate (store_id,date) trong p_daily → 'trùng lặp' (r2)
--   • p_daily chứa store không có trong p_actuals → 'không có aggregate' (r2)
--   • actual_value <> offline+affiliate → RAISE công thức
--   • campaign metric_affiliate=false + actual_affiliate>0 → RAISE metric tắt
--   • daily lệch aggregate → RAISE SUM(daily)
-- ============================================================================
