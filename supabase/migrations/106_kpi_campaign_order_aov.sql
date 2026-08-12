-- ============================================================================
-- 106_kpi_campaign_order_aov.sql
-- ⚠ DRAFT — CHƯA CHẠY cho tới khi stakeholder audit pass. Chạy SAU 105.
--
-- REQUEST 11/08 (handoff stakeholder): loại chiến dịch MỚI
-- "Chất lượng bán hàng" (metric_type = 'offline_order_aov') — đo ĐỒNG THỜI
-- Số đơn Offline (trọng số 90%) và AOV Offline (10%), mỗi chỉ số có FLOOR
-- bắt buộc. Net Revenue chỉ là số tham khảo (dùng để tính AOV).
--
-- CONTRACT (khóa — mọi con số do RPC TỰ TÍNH, app KHÔNG được gửi điểm):
--   actual_order  = SUM(no_order)      ← BigQuery DAY rows trong [start, end]
--   actual_net    = SUM(net_revenue)
--   actual_aov    = actual_net / actual_order      (NULL khi 0 đơn)
--   actual_score  = 0.90×(actual_order/order_floor) + 0.10×(actual_aov/aov_floor)
--   target_score  = 0.90×(order_target/order_floor) + 0.10×(aov_target/aov_floor)
--   completion_pct = actual_score / target_score × 100   (KHÔNG cap thành phần)
--   floor_pass    = actual_order >= order_floor AND actual_aov >= aov_floor
--                   (>= : BẰNG floor là PASS)
--   kpi_pass      = floor_pass AND completion_pct >= 100   (dẫn xuất ở tầng đọc)
--   tier          = threshold cao nhất <= completion_pct, CHỈ xét khi floor_pass
--   actual_order = 0 → completion 0%, AOV '—', không tier ("Chưa phát sinh đơn")
--
-- ÁNH XẠ CỘT (tái dùng bảng sẵn có, KHÔNG đẻ bảng mới):
--   kpi_target            = 100          (điểm chuẩn hóa — RPC ÉP, không nhận
--                                         từ file import; UI KHÔNG hiện như tiền)
--   actual_value          = completion_pct
--   run_rate              = completion_pct   (hero Staff đọc thẳng cột này)
--   remaining_target      = max(100 - completion_pct, 0)   (đơn vị: điểm %)
--   actual_offline        = Net Revenue kỳ
--   offline_order_count   = số đơn kỳ (cột của 105 — tái dùng)
--   quality_floor_pass    = floor_pass   (cột MỚI, NULL cho 2 loại cũ)
--   actual_affiliate / actual_customer_count = 0
--   AOV KHÔNG LƯU — luôn tính lại actual_offline / offline_order_count.
--
-- Nội dung:
--   A. CHECK metric_type += 'offline_order_aov' + CHECK contract cột
--      (offline=true, affiliate=false, order_type='all').
--   B. kpi_campaign_store_targets += order_floor/aov_floor/order_target/
--      aov_target (+ CHECK dương · đủ-4-hoặc-không-cột-nào · target >= floor).
--   C. kpi_campaign_store_actuals += quality_floor_pass boolean.
--   D. rpc_replace_campaign_targets = body 103 NGUYÊN VĂN + nhánh order_aov
--      (ép kpi_target=100 · validate 4 chỉ số · reverse guard cho 2 loại cũ).
--   E. rpc_replace_campaign_actuals = body 105 NGUYÊN VĂN + nhánh order_aov —
--      RPC LÀ AUTHORITY: nhận RAW (net + số đơn), tự tính AOV/điểm/floor/bậc/
--      commission; TỪ CHỐI payload mang số dẫn xuất; 3 nhánh metric_type tường
--      minh + ELSE reject loại lạ.
--   F. rpc_activate_kpi_campaign = body 104 NGUYÊN VĂN + nhánh order_aov —
--      pg_advisory_xact_lock + overlap PER-STORE chỉ với campaign ACTIVE cùng
--      loại (khác tập store ⇒ chạy song song).
-- Idempotent (DDL additive + CREATE OR REPLACE, KHÔNG đổi dữ liệu hiện có).
-- GMV + Số khách Affiliate ZERO-TOUCH (nhánh cũ nguyên văn; payload 2 loại này
-- được ghi lại từng byte — v_calc rỗng).
--
-- ROLLBACK:
--   CREATE OR REPLACE 3 RPC từ 105 (actuals), 103 (targets), 104 (activate);
--   ALTER TABLE public.kpi_campaign_store_actuals
--     DROP COLUMN IF EXISTS quality_floor_pass;
--   ALTER TABLE public.kpi_campaign_store_targets
--     DROP CONSTRAINT IF EXISTS chk_kcst_order_aov_positive,
--     DROP CONSTRAINT IF EXISTS chk_kcst_order_aov_all_or_none,
--     DROP CONSTRAINT IF EXISTS chk_kcst_order_aov_target_ge_floor,
--     DROP COLUMN IF EXISTS order_floor, DROP COLUMN IF EXISTS aov_floor,
--     DROP COLUMN IF EXISTS order_target, DROP COLUMN IF EXISTS aov_target;
--   ALTER TABLE public.kpi_campaigns
--     DROP CONSTRAINT IF EXISTS chk_kpi_campaigns_order_aov_contract,
--     DROP CONSTRAINT IF EXISTS chk_kpi_campaigns_metric_type;
--   ALTER TABLE public.kpi_campaigns ADD CONSTRAINT chk_kpi_campaigns_metric_type
--     CHECK (metric_type IN ('gmv', 'affiliate_customer_count'));
--   DELETE FROM public.app_migrations WHERE version = '106';
--   ⚠ Rollback CHỈ an toàn khi CHƯA có campaign offline_order_aov nào.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '105') THEN
    RAISE EXCEPTION '106: thiếu migration nền 105 (offline_order_count) — chạy đúng thứ tự';
  END IF;
END $$;

-- ── A. metric_type: mở rộng whitelist + contract cột của loại mới ───────────
-- 103 đã đặt TÊN cho CHECK metric_type ⇒ drop theo tên (không cần discovery).
DO $$
BEGIN
  ALTER TABLE public.kpi_campaigns DROP CONSTRAINT IF EXISTS chk_kpi_campaigns_metric_type;
  ALTER TABLE public.kpi_campaigns ADD CONSTRAINT chk_kpi_campaigns_metric_type
    CHECK (metric_type IN ('gmv', 'affiliate_customer_count', 'offline_order_aov'));

  -- Contract ENFORCE Ở DB (không tin app): Chất lượng bán hàng đọc BigQuery
  -- Offline toàn bộ đơn ⇒ offline=true, affiliate=false, order_type='all'.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'chk_kpi_campaigns_order_aov_contract'
                   AND conrelid = 'public.kpi_campaigns'::regclass) THEN
    ALTER TABLE public.kpi_campaigns ADD CONSTRAINT chk_kpi_campaigns_order_aov_contract
      CHECK (metric_type <> 'offline_order_aov'
             OR (metric_offline = true AND metric_affiliate = false AND order_type = 'all'));
  END IF;
END $$;

-- ── B. Target: 4 chỉ số Order/AOV (NULL cho 2 loại cũ) ──────────────────────
ALTER TABLE public.kpi_campaign_store_targets
  ADD COLUMN IF NOT EXISTS order_floor  bigint,
  ADD COLUMN IF NOT EXISTS aov_floor    numeric,
  ADD COLUMN IF NOT EXISTS order_target bigint,
  ADD COLUMN IF NOT EXISTS aov_target   numeric;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.kpi_campaign_store_targets'::regclass
                   AND conname = 'chk_kcst_order_aov_positive') THEN
    ALTER TABLE public.kpi_campaign_store_targets
      ADD CONSTRAINT chk_kcst_order_aov_positive CHECK (
        (order_floor  IS NULL OR order_floor  > 0) AND
        (aov_floor    IS NULL OR aov_floor    > 0) AND
        (order_target IS NULL OR order_target > 0) AND
        (aov_target   IS NULL OR aov_target   > 0));
  END IF;
  -- Đủ 4 hoặc không cột nào: chặn target nửa cấu hình (engine sẽ chia cho NULL).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.kpi_campaign_store_targets'::regclass
                   AND conname = 'chk_kcst_order_aov_all_or_none') THEN
    ALTER TABLE public.kpi_campaign_store_targets
      ADD CONSTRAINT chk_kcst_order_aov_all_or_none
      CHECK (num_nonnulls(order_floor, aov_floor, order_target, aov_target) IN (0, 4));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.kpi_campaign_store_targets'::regclass
                   AND conname = 'chk_kcst_order_aov_target_ge_floor') THEN
    ALTER TABLE public.kpi_campaign_store_targets
      ADD CONSTRAINT chk_kcst_order_aov_target_ge_floor CHECK (
        (order_target IS NULL OR order_floor IS NULL OR order_target >= order_floor) AND
        (aov_target   IS NULL OR aov_floor   IS NULL OR aov_target   >= aov_floor));
  END IF;
END $$;

COMMENT ON COLUMN public.kpi_campaign_store_targets.order_floor IS
  'Chất lượng bán hàng (106): sàn số đơn BẮT BUỘC của kỳ. NULL với campaign GMV/Số khách.';
COMMENT ON COLUMN public.kpi_campaign_store_targets.aov_floor IS
  'Chất lượng bán hàng (106): sàn AOV (VNĐ) BẮT BUỘC của kỳ. NULL với campaign GMV/Số khách.';
COMMENT ON COLUMN public.kpi_campaign_store_targets.order_target IS
  'Chất lượng bán hàng (106): số đơn mục tiêu (>= order_floor). Dùng cho target_score.';
COMMENT ON COLUMN public.kpi_campaign_store_targets.aov_target IS
  'Chất lượng bán hàng (106): AOV mục tiêu VNĐ (>= aov_floor). Dùng cho target_score.';

-- ── C. Actual: kết quả 2 sàn (RPC ghi, KHÔNG nhận từ app) ───────────────────
ALTER TABLE public.kpi_campaign_store_actuals
  ADD COLUMN IF NOT EXISTS quality_floor_pass boolean;

COMMENT ON COLUMN public.kpi_campaign_store_actuals.quality_floor_pass IS
  'Chất lượng bán hàng (106): actual_order >= order_floor AND actual_aov >= aov_floor. '
  'RPC tự tính (payload KHÔNG được gửi). NULL = campaign loại khác. '
  'KPI pass = quality_floor_pass AND actual_value >= 100 — TUYỆT ĐỐI không suy từ achieved_tier_order.';

-- ── D. rpc_replace_campaign_targets: BODY 103 NGUYÊN VĂN + delta 106 ───────
CREATE OR REPLACE FUNCTION public.rpc_replace_campaign_targets(
  p_campaign_id uuid,
  p_rows        jsonb,
  p_file_name   text DEFAULT NULL,
  p_uploaded_by uuid DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row         jsonb;
  v_tier        jsonb;
  v_target_id   uuid;
  v_count       integer := 0;
  v_status      text;
  v_archived    timestamptz;
  v_metric_type text;
  v_tiers       integer;
  v_kt          numeric;
  v_group       text;
  v_th          numeric;
  v_cm          numeric;
  v_prev_th     numeric;
  -- 106: 4 chi so cua campaign "Chat luong ban hang" (offline_order_aov).
  v_of          numeric;   -- order_floor
  v_af          numeric;   -- aov_floor
  v_ot          numeric;   -- order_target
  v_at          numeric;   -- aov_target
  v_is_aov      boolean;
BEGIN
  SELECT status, archived_at, metric_type INTO v_status, v_archived, v_metric_type
  FROM public.kpi_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Campaign % không tồn tại', p_campaign_id; END IF;
  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'Chiến dịch đã lưu trữ — không nạp target';
  END IF;
  IF v_status NOT IN ('draft', 'paused') THEN
    RAISE EXCEPTION 'Chỉ nạp target khi chiến dịch draft/paused (hiện: %)', v_status;
  END IF;
  -- 106: whitelist metric_type TƯỜNG MINH — loại lạ (code cũ/mới lệch nhau)
  -- không được nạp target rồi chạy bằng nhánh mặc định.
  IF v_metric_type NOT IN ('gmv', 'affiliate_customer_count', 'offline_order_aov') THEN
    RAISE EXCEPTION 'rpc_replace_campaign_targets: metric_type % không được hỗ trợ', v_metric_type;
  END IF;
  v_is_aov := (v_metric_type = 'offline_order_aov');

  DELETE FROM public.kpi_campaign_store_targets WHERE campaign_id = p_campaign_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    -- 106: campaign Chất lượng bán hàng — kpi_target là ĐIỂM CHUẨN HÓA 100%,
    -- KHÔNG phải tiền/khách. RPC TỰ ÉP = 100; file import chỉ có 4 chỉ số.
    IF v_is_aov THEN
      IF NULLIF(v_row->>'kpi_target', '') IS NOT NULL
         AND (v_row->>'kpi_target')::numeric <> 100 THEN
        RAISE EXCEPTION 'campaign Chất lượng bán hàng: kpi_target do hệ thống ép = 100, payload gửi % — bỏ khỏi file import', (v_row->>'kpi_target')::numeric;
      END IF;
      v_kt := 100;
    ELSE
      v_kt := (v_row->>'kpi_target')::numeric;
      IF v_kt IS NULL OR v_kt <= 0 THEN RAISE EXCEPTION 'kpi_target phải > 0'; END IF;
      -- 103: campaign khách — target là SỐ KHÁCH nguyên.
      IF v_metric_type = 'affiliate_customer_count' AND v_kt <> floor(v_kt) THEN
        RAISE EXCEPTION 'kpi_target phải là số nguyên dương (số khách) — nhận %', v_kt;
      END IF;
    END IF;

    -- 106: 4 chỉ số Order/AOV — BẮT BUỘC ĐỦ với offline_order_aov và BẮT BUỘC
    -- VẮNG với 2 loại cũ (reverse guard: cột lạ không được lọt vào campaign tiền).
    v_of := NULLIF(v_row->>'order_floor',  '')::numeric;
    v_af := NULLIF(v_row->>'aov_floor',    '')::numeric;
    v_ot := NULLIF(v_row->>'order_target', '')::numeric;
    v_at := NULLIF(v_row->>'aov_target',   '')::numeric;
    IF v_is_aov THEN
      IF v_of IS NULL OR v_af IS NULL OR v_ot IS NULL OR v_at IS NULL THEN
        RAISE EXCEPTION 'campaign Chất lượng bán hàng: store % thiếu chỉ số — order_floor/aov_floor/order_target/aov_target đều bắt buộc', v_row->>'pos_code';
      END IF;
      IF v_of <= 0 OR v_af <= 0 OR v_ot <= 0 OR v_at <= 0 THEN
        RAISE EXCEPTION 'campaign Chất lượng bán hàng: store % có chỉ số <= 0 (order_floor=%, aov_floor=%, order_target=%, aov_target=%)', v_row->>'pos_code', v_of, v_af, v_ot, v_at;
      END IF;
      IF v_of <> floor(v_of) OR v_ot <> floor(v_ot) THEN
        RAISE EXCEPTION 'campaign Chất lượng bán hàng: store % có số đơn KHÔNG NGUYÊN (order_floor=%, order_target=%)', v_row->>'pos_code', v_of, v_ot;
      END IF;
      IF v_af <> floor(v_af) OR v_at <> floor(v_at) THEN
        RAISE EXCEPTION 'campaign Chất lượng bán hàng: store % có AOV không nguyên VNĐ (aov_floor=%, aov_target=%)', v_row->>'pos_code', v_af, v_at;
      END IF;
      IF v_ot < v_of THEN
        RAISE EXCEPTION 'campaign Chất lượng bán hàng: store % có order_target (%) < order_floor (%)', v_row->>'pos_code', v_ot, v_of;
      END IF;
      IF v_at < v_af THEN
        RAISE EXCEPTION 'campaign Chất lượng bán hàng: store % có aov_target (%) < aov_floor (%)', v_row->>'pos_code', v_at, v_af;
      END IF;
    ELSIF v_of IS NOT NULL OR v_af IS NOT NULL OR v_ot IS NOT NULL OR v_at IS NOT NULL THEN
      RAISE EXCEPTION 'campaign % nhưng store % mang chỉ số Order/AOV — 4 cột này CHỈ dành cho Chất lượng bán hàng', v_metric_type, v_row->>'pos_code';
    END IF;
    v_group := NULLIF(trim(coalesce(v_row->>'store_kpi_group', '')), '');
    IF v_group IS NULL THEN RAISE EXCEPTION 'store_kpi_group là bắt buộc'; END IF;

    INSERT INTO public.kpi_campaign_store_targets
      (campaign_id, store_id, pos_code, kpi_target, store_kpi_group, import_row, note,
       order_floor, aov_floor, order_target, aov_target)
    VALUES (
      p_campaign_id,
      (v_row->>'store_id')::uuid,
      v_row->>'pos_code',
      v_kt,
      v_group,
      NULLIF(v_row->>'import_row', '')::integer,
      NULLIF(v_row->>'note', ''),
      v_of::bigint, v_af, v_ot::bigint, v_at   -- 106: NULL cho gmv/customer
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

  DELETE FROM public.kpi_campaign_store_actuals       WHERE campaign_id = p_campaign_id;
  DELETE FROM public.kpi_campaign_store_daily_actuals WHERE campaign_id = p_campaign_id;

  UPDATE public.kpi_campaigns SET updated_at = now() WHERE id = p_campaign_id;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.rpc_replace_campaign_targets(uuid, jsonb, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_replace_campaign_targets(uuid, jsonb, text, uuid)
  TO service_role;

-- ── E. rpc_replace_campaign_actuals: BODY 105 NGUYÊN VĂN + delta 106 ───────
CREATE OR REPLACE FUNCTION public.rpc_replace_campaign_actuals(
  p_campaign_id uuid,
  p_daily   jsonb,  -- [{store_id, date, gmv, gmv_affiliate?, affiliate_customer_count?,
                    --   offline_order_count?, synced_at}]
  p_actuals jsonb   -- [{store_id, actual_value, actual_offline?, actual_affiliate?,
                    --   actual_customer_count?, run_rate, remaining_target,
                    --   achieved_tier_order, store_commission_pool, raw_row_count,
                    --   offline_order_count?,
                    --   offline_synced_at?, affiliate_synced_at?, synced_at}]
                    -- (key có ? = caller cũ không gửi → fallback legacy / 0)
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row         jsonb;
  v_count       integer := 0;
  v_m_offline   boolean;
  v_m_affiliate boolean;
  v_metric_type text;
  v_archived    timestamptz;
  v_store       uuid;
  v_value       numeric;
  v_offline     numeric;
  v_affiliate   numeric;
  v_cust        integer;
  v_daily_off   numeric;
  v_daily_aff   numeric;
  v_daily_cust  numeric;
  -- 105: số đơn Offline. NULLABLE có Ý NGHĨA — NULL = 'nguồn chưa có số
  -- đơn' (snapshot cũ / campaign không áp dụng), KHÁC 0 = 'có 0 đơn'.
  v_ord         bigint;
  v_daily_ord   bigint;
  v_daily_ord_n integer;
  -- 106: campaign Chất lượng bán hàng — RPC LÀ AUTHORITY: nhận số liệu THÔ
  -- (Net Revenue + số đơn) rồi tự tính AOV/điểm/floor/bậc/commission từ target
  -- trong DB. App KHÔNG được "gửi điểm" (mọi số dẫn xuất bị từ chối).
  v_out         jsonb := '[]'::jsonb;   -- payload GHI (gốc + số RPC tự tính)
  v_calc        jsonb;
  v_t           record;
  v_aov         numeric;
  v_actual_sc   numeric;
  v_target_sc   numeric;
  v_completion  numeric;
  v_floor_pass  boolean;
  v_tier_ord    integer;
  v_pool        numeric;
  v_daily_n     integer;
BEGIN
  -- ── VALIDATE (trước mọi thao tác ghi) ──
  -- 098: FOR UPDATE + archived — sync ghi số liệu serialize với archive.
  -- 103: đọc thêm metric_type (discriminator).
  SELECT metric_offline, metric_affiliate, metric_type, archived_at
  INTO v_m_offline, v_m_affiliate, v_metric_type, v_archived
  FROM public.kpi_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign % không tồn tại', p_campaign_id;
  END IF;
  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign % đã lưu trữ — không ghi số liệu', p_campaign_id;
  END IF;

  -- (a) Không duplicate store trong p_actuals. (098 nguyên văn)
  IF (SELECT count(*) FROM jsonb_array_elements(coalesce(p_actuals, '[]'::jsonb)) e)
     <> (SELECT count(DISTINCT e->>'store_id') FROM jsonb_array_elements(coalesce(p_actuals, '[]'::jsonb)) e) THEN
    RAISE EXCEPTION 'rpc_replace_campaign_actuals: p_actuals có store trùng lặp';
  END IF;
  -- (b) Không duplicate (store_id, date) trong p_daily. (098 nguyên văn)
  IF (SELECT count(*) FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e)
     <> (SELECT count(DISTINCT (e->>'store_id') || '|' || (e->>'date')) FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e) THEN
    RAISE EXCEPTION 'rpc_replace_campaign_actuals: p_daily có (store_id, date) trùng lặp';
  END IF;
  -- (c) MỖI target của campaign phải có aggregate. (098 nguyên văn)
  IF EXISTS (
    SELECT 1 FROM public.kpi_campaign_store_targets t
    WHERE t.campaign_id = p_campaign_id
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(p_actuals, '[]'::jsonb)) e
        WHERE (e->>'store_id')::uuid = t.store_id)
  ) THEN
    RAISE EXCEPTION 'rpc_replace_campaign_actuals: p_actuals THIẾU aggregate cho ít nhất 1 store trong targets của campaign % — payload phải đủ toàn bộ targets (replace-all)', p_campaign_id;
  END IF;
  -- (d) daily ⊆ actuals. (098 nguyên văn)
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(p_actuals, '[]'::jsonb)) a
      WHERE a->>'store_id' = e->>'store_id')
  ) THEN
    RAISE EXCEPTION 'rpc_replace_campaign_actuals: p_daily chứa store không có aggregate trong p_actuals';
  END IF;
  -- (e) daily ⊆ targets. (098 nguyên văn)
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
    v_cust      := coalesce((v_row->>'actual_customer_count')::integer, 0);
    -- KHÔNG coalesce 0: giữ NULL để phân biệt 'chưa có dữ liệu'.
    v_ord       := (v_row->>'offline_order_count')::bigint;
    v_calc      := '{}'::jsonb;   -- 106: số RPC tự tính (rỗng cho gmv/customer)

    IF NOT EXISTS (SELECT 1 FROM public.kpi_campaign_store_targets t
                   WHERE t.campaign_id = p_campaign_id AND t.store_id = v_store) THEN
      RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % không thuộc targets của campaign %', v_store, p_campaign_id;
    END IF;

    SELECT coalesce(sum((e->>'gmv')::numeric), 0),
           coalesce(sum(coalesce((e->>'gmv_affiliate')::numeric, 0)), 0),
           coalesce(sum(coalesce((e->>'affiliate_customer_count')::integer, 0)), 0),
           sum((e->>'offline_order_count')::bigint),
           count(*) FILTER (WHERE e ? 'offline_order_count' AND e->>'offline_order_count' IS NOT NULL)
    INTO v_daily_off, v_daily_aff, v_daily_cust, v_daily_ord, v_daily_ord_n
    FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e
    WHERE (e->>'store_id')::uuid = v_store;

    IF v_metric_type = 'affiliate_customer_count' THEN
      -- 103: nhánh CUSTOMER — đơn vị KHÁCH, không tiền.
      IF v_cust < 0 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % actual_customer_count âm (%)', v_store, v_cust;
      END IF;
      IF v_offline <> 0 OR v_affiliate <> 0 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign customer-count nhưng store % có actual_offline=% / actual_affiliate=% (phải 0 — payload GMV không được ghi vào campaign khách)', v_store, v_offline, v_affiliate;
      END IF;
      IF v_value <> v_cust THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % actual_value(%) <> actual_customer_count(%) — campaign khách: actual_value phải là SỐ KHÁCH nguyên', v_store, v_value, v_cust;
      END IF;
      IF v_daily_off <> 0 OR v_daily_aff <> 0 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign customer-count nhưng store % có SUM(daily gmv)=% / SUM(daily gmv_affiliate)=% (phải 0)', v_store, v_daily_off, v_daily_aff;
      END IF;
      IF v_daily_cust <> v_cust THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % SUM(daily.affiliate_customer_count)=% không khớp actual_customer_count=%', v_store, v_daily_cust, v_cust;
      END IF;
      -- 105: campaign KHÁCH không có khái niệm số đơn Offline.
      IF v_ord IS NOT NULL OR v_daily_ord_n > 0 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign customer-count nhưng store % có offline_order_count=% / % dòng daily có count (phải KHÔNG gửi)', v_store, coalesce(v_ord::text, 'NULL'), v_daily_ord_n;
      END IF;
      -- 106 reverse guard: cột của Chất lượng bán hàng không được lọt sang.
      IF v_row ? 'quality_floor_pass' THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign customer-count nhưng store % có quality_floor_pass (chỉ dành cho Chất lượng bán hàng)', v_store;
      END IF;

    ELSIF v_metric_type = 'offline_order_aov' THEN
      -- ── 106: CHẤT LƯỢNG BÁN HÀNG — RPC TỰ TÍNH, KHÔNG TIN PAYLOAD ──
      -- Payload CHỈ được mang: actual_offline = Net Revenue kỳ ·
      -- offline_order_count = số đơn kỳ · daily {gmv, offline_order_count}.
      IF v_row ?| array['actual_value', 'run_rate', 'remaining_target',
                        'achieved_tier_order', 'store_commission_pool',
                        'quality_floor_pass'] THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign Chất lượng bán hàng — store % gửi số liệu DẪN XUẤT (actual_value/run_rate/remaining_target/achieved_tier_order/store_commission_pool/quality_floor_pass); RPC tự tính, payload chỉ được gửi actual_offline + offline_order_count', v_store;
      END IF;
      IF NOT (v_row ? 'actual_offline') THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign Chất lượng bán hàng — store % thiếu actual_offline (Net Revenue kỳ)', v_store;
      END IF;
      IF v_affiliate <> 0 OR v_cust <> 0 OR v_daily_aff <> 0 OR v_daily_cust <> 0 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign Chất lượng bán hàng nhưng store % có số liệu affiliate/khách (aff=%, cust=%, daily aff=%, daily cust=%) — phải 0', v_store, v_affiliate, v_cust, v_daily_aff, v_daily_cust;
      END IF;
      IF v_offline < 0 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % có Net Revenue âm (%)', v_store, v_offline;
      END IF;
      -- Số đơn LÀ KPI của loại này ⇒ thiếu = fail-closed (khác campaign GMV,
      -- nơi số đơn chỉ là chỉ số phụ và được phép degrade).
      IF v_ord IS NULL THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign Chất lượng bán hàng — store % thiếu offline_order_count (số đơn LÀ KPI, không được để trống)', v_store;
      END IF;
      IF v_ord < 0 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % offline_order_count âm (%)', v_store, v_ord;
      END IF;
      SELECT count(*) INTO v_daily_n
      FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e
      WHERE (e->>'store_id')::uuid = v_store;
      IF v_daily_ord_n <> v_daily_n THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % chỉ %/% dòng daily mang offline_order_count (phải đủ mọi ngày)', v_store, v_daily_ord_n, v_daily_n;
      END IF;
      IF coalesce(v_daily_ord, 0) <> v_ord THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % SUM(daily.offline_order_count)=% không khớp aggregate offline_order_count=%', v_store, coalesce(v_daily_ord, 0), v_ord;
      END IF;
      IF abs(v_daily_off - v_offline) > 0.01 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % SUM(daily.gmv)=% không khớp actual_offline (Net Revenue)=%', v_store, v_daily_off, v_offline;
      END IF;

      SELECT t.id, t.kpi_target, t.order_floor, t.aov_floor, t.order_target, t.aov_target
      INTO v_t
      FROM public.kpi_campaign_store_targets t
      WHERE t.campaign_id = p_campaign_id AND t.store_id = v_store;
      IF v_t.order_floor IS NULL OR v_t.aov_floor IS NULL
         OR v_t.order_target IS NULL OR v_t.aov_target IS NULL THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % chưa cấu hình đủ 4 chỉ số Order/AOV — nạp lại file target trước khi đồng bộ', v_store;
      END IF;
      IF v_t.kpi_target <> 100 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % có kpi_target=% (Chất lượng bán hàng phải = 100 — điểm chuẩn hóa)', v_store, v_t.kpi_target;
      END IF;

      -- CÔNG THỨC CHỐT (stakeholder 11/08) — trọng số 90% số đơn + 10% AOV,
      -- đều so với FLOOR; completion = actual_score / target_score × 100.
      -- KHÔNG cap từng thành phần (cho phép bù trừ), nhưng floor là ĐIỀU KIỆN
      -- CẦN để xét bậc: vượt điểm mà thủng floor thì KHÔNG có commission.
      v_aov := CASE WHEN v_ord > 0 THEN v_offline / v_ord END;
      v_actual_sc := 0.90 * (v_ord::numeric / v_t.order_floor)
                   + 0.10 * (coalesce(v_aov, 0) / v_t.aov_floor);
      v_target_sc := 0.90 * (v_t.order_target::numeric / v_t.order_floor)
                   + 0.10 * (v_t.aov_target / v_t.aov_floor);
      IF v_target_sc <= 0 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % có target_score <= 0 — cấu hình target sai', v_store;
      END IF;
      -- 0 đơn → 0% (UI hiện nhãn "Chưa phát sinh đơn", AOV '—').
      v_completion := CASE WHEN v_ord = 0 THEN 0
                           ELSE round(v_actual_sc / v_target_sc * 100, 4) END;
      v_floor_pass := (v_ord >= v_t.order_floor
                       AND v_aov IS NOT NULL AND v_aov >= v_t.aov_floor);

      v_tier_ord := NULL;
      v_pool     := NULL;
      IF v_floor_pass THEN
        SELECT ti.tier_order, ti.commission_amount INTO v_tier_ord, v_pool
        FROM public.kpi_campaign_store_tiers ti
        WHERE ti.target_id = v_t.id AND ti.threshold_pct <= v_completion
        ORDER BY ti.tier_order DESC LIMIT 1;
      END IF;

      -- actual_value = run_rate = completion (đơn vị %); remaining = số điểm %
      -- còn thiếu để chạm 100 — cùng nguồn với hero Staff.
      v_calc := jsonb_build_object(
        'actual_value',          v_completion,
        'run_rate',              v_completion,
        'remaining_target',      greatest(100 - v_completion, 0),
        'achieved_tier_order',   v_tier_ord,
        'store_commission_pool', v_pool,
        'quality_floor_pass',    v_floor_pass
      );

    ELSIF v_metric_type = 'gmv' THEN
      -- Nhánh GMV: 098 NGUYÊN VĂN từng check.
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
      IF abs(v_daily_off - v_offline) > 0.01 OR abs(v_daily_aff - v_affiliate) > 0.01 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % SUM(daily) off=%/aff=% không khớp aggregate off=%/aff=%',
          v_store, v_daily_off, v_daily_aff, v_offline, v_affiliate;
      END IF;
      -- 103: chặn chiều ngược — count không được lọt vào campaign GMV.
      IF v_cust <> 0 OR v_daily_cust <> 0 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign GMV nhưng store % có actual_customer_count=% / SUM(daily count)=% (phải 0)', v_store, v_cust, v_daily_cust;
      END IF;
      -- ── 105: SỐ ĐƠN OFFLINE (nguồn BigQuery no_order) ──
      -- Chỉ campaign có metric_offline mới được mang số đơn Offline.
      IF NOT v_m_offline AND (v_ord IS NOT NULL OR v_daily_ord_n > 0) THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign tắt metric_offline nhưng store % có offline_order_count=% / % dòng daily có count', v_store, coalesce(v_ord::text, 'NULL'), v_daily_ord_n;
      END IF;
      IF v_ord IS NOT NULL THEN
        IF v_ord < 0 THEN
          RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % offline_order_count âm (%)', v_store, v_ord;
        END IF;
        -- Mọi dòng daily của store PHẢI có count (không nửa vời) và tổng khớp
        -- aggregate — cùng kỷ luật SUM(daily)=aggregate của tiền.
        IF v_daily_ord_n <> (SELECT count(*) FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e
                             WHERE (e->>'store_id')::uuid = v_store) THEN
          RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % có aggregate offline_order_count nhưng chỉ % dòng daily mang count (phải đủ mọi ngày)', v_store, v_daily_ord_n;
        END IF;
        IF coalesce(v_daily_ord, 0) <> v_ord THEN
          RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % SUM(daily.offline_order_count)=% không khớp aggregate offline_order_count=%', v_store, coalesce(v_daily_ord, 0), v_ord;
        END IF;
      ELSIF v_daily_ord_n > 0 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % có % dòng daily mang offline_order_count nhưng aggregate KHÔNG có (payload nửa vời)', v_store, v_daily_ord_n;
      END IF;
      -- 106 reverse guard.
      IF v_row ? 'quality_floor_pass' THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign GMV nhưng store % có quality_floor_pass (chỉ dành cho Chất lượng bán hàng)', v_store;
      END IF;

    ELSE
      -- 106: FAIL-CLOSED — loại campaign lạ không được ghi bằng nhánh mặc định.
      RAISE EXCEPTION 'rpc_replace_campaign_actuals: metric_type % không được hỗ trợ — không ghi số liệu', v_metric_type;
    END IF;

    -- 106: payload GHI = payload gốc + số liệu RPC tự tính (rỗng với gmv/customer
    -- ⇒ 2 loại cũ giữ NGUYÊN từng byte).
    v_out := v_out || jsonb_build_array(v_row || v_calc);
  END LOOP;

  -- ── REPLACE-ALL (098 nguyên văn; 103: thêm cột count vào INSERT/UPDATE) ──
  DELETE FROM public.kpi_campaign_store_daily_actuals WHERE campaign_id = p_campaign_id;
  DELETE FROM public.kpi_campaign_store_actuals       WHERE campaign_id = p_campaign_id;

  INSERT INTO public.kpi_campaign_store_daily_actuals
    (campaign_id, store_id, date, gmv, gmv_affiliate, affiliate_customer_count,
     offline_order_count, synced_at)
  SELECT p_campaign_id,
         (e->>'store_id')::uuid,
         (e->>'date')::date,
         coalesce((e->>'gmv')::numeric, 0),
         coalesce((e->>'gmv_affiliate')::numeric, 0),
         coalesce((e->>'affiliate_customer_count')::integer, 0),
         (e->>'offline_order_count')::bigint,   -- 105: NULL = nguồn chưa có số đơn
         coalesce((e->>'synced_at')::timestamptz, now())
  FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_out)   -- 106: gốc + tự tính
  LOOP
    INSERT INTO public.kpi_campaign_store_actuals
      (campaign_id, store_id, actual_value, actual_offline, actual_affiliate,
       actual_customer_count, run_rate, remaining_target, achieved_tier_order,
       store_commission_pool, raw_row_count, offline_order_count,
       quality_floor_pass, offline_synced_at, affiliate_synced_at, synced_at)
    VALUES (
      p_campaign_id,
      (v_row->>'store_id')::uuid,
      coalesce((v_row->>'actual_value')::numeric, 0),
      -- fallback legacy: thiếu key mới → toàn bộ actual_value là offline (098)
      coalesce((v_row->>'actual_offline')::numeric, (v_row->>'actual_value')::numeric, 0),
      coalesce((v_row->>'actual_affiliate')::numeric, 0),
      coalesce((v_row->>'actual_customer_count')::integer, 0),
      (v_row->>'run_rate')::numeric,
      (v_row->>'remaining_target')::numeric,
      (v_row->>'achieved_tier_order')::integer,
      (v_row->>'store_commission_pool')::numeric,
      coalesce((v_row->>'raw_row_count')::integer, 0),
      (v_row->>'offline_order_count')::bigint,   -- 105: NULL-preserving
      (v_row->>'quality_floor_pass')::boolean,   -- 106: NULL cho gmv/customer
      coalesce((v_row->>'offline_synced_at')::timestamptz, (v_row->>'synced_at')::timestamptz),
      (v_row->>'affiliate_synced_at')::timestamptz,
      coalesce((v_row->>'synced_at')::timestamptz, now())
    )
    ON CONFLICT (campaign_id, store_id) DO UPDATE SET
      actual_value          = EXCLUDED.actual_value,
      actual_offline        = EXCLUDED.actual_offline,
      actual_affiliate      = EXCLUDED.actual_affiliate,
      actual_customer_count = EXCLUDED.actual_customer_count,
      run_rate              = EXCLUDED.run_rate,
      remaining_target      = EXCLUDED.remaining_target,
      achieved_tier_order   = EXCLUDED.achieved_tier_order,
      store_commission_pool = EXCLUDED.store_commission_pool,
      raw_row_count         = EXCLUDED.raw_row_count,
      offline_order_count   = EXCLUDED.offline_order_count,
      quality_floor_pass    = EXCLUDED.quality_floor_pass,
      offline_synced_at     = EXCLUDED.offline_synced_at,
      affiliate_synced_at   = EXCLUDED.affiliate_synced_at,
      synced_at             = EXCLUDED.synced_at;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.rpc_replace_campaign_actuals(uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_replace_campaign_actuals(uuid, jsonb, jsonb)
  TO service_role;

-- ── F. rpc_activate_kpi_campaign: BODY 104 NGUYÊN VĂN + delta 106 ─────────
CREATE OR REPLACE FUNCTION public.rpc_activate_kpi_campaign(
  p_campaign_id        uuid,
  p_expected_updated_at timestamptz,
  p_expected_run_id     uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_c            record;
  v_target_count integer;
  v_bad          integer;
  v_latest_id    uuid;
  v_latest_st    text;
  v_overlap      record;
  v_nophone      integer;
BEGIN
  SELECT id, status, updated_at, metric_affiliate, archived_at, metric_type, start_date, end_date
  INTO v_c
  FROM public.kpi_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF v_c.id IS NULL THEN
    RAISE EXCEPTION 'Campaign % không tồn tại', p_campaign_id;
  END IF;
  IF v_c.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Chiến dịch đã lưu trữ — không kích hoạt';
  END IF;
  IF v_c.status NOT IN ('draft', 'paused') THEN
    RAISE EXCEPTION 'Chỉ kích hoạt từ draft/paused (hiện: %)', v_c.status;
  END IF;
  IF p_expected_updated_at IS NULL OR v_c.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Cấu hình chiến dịch vừa thay đổi (import/sửa song song) — tải lại trang rồi thử lại';
  END IF;
  -- 106: whitelist metric_type TƯỜNG MINH (fail-closed với loại lạ).
  IF v_c.metric_type NOT IN ('gmv', 'affiliate_customer_count', 'offline_order_aov') THEN
    RAISE EXCEPTION 'metric_type % không được hỗ trợ — không kích hoạt', v_c.metric_type;
  END IF;

  SELECT count(*) INTO v_target_count
  FROM public.kpi_campaign_store_targets WHERE campaign_id = p_campaign_id;
  IF v_target_count = 0 THEN
    RAISE EXCEPTION 'Chưa import target cho chiến dịch này';
  END IF;

  -- 103: nhánh customer-count (104: identity = phone).
  IF v_c.metric_type = 'affiliate_customer_count' THEN
    SELECT c2.id, c2.name, c2.status INTO v_overlap
    FROM public.kpi_campaigns c2
    WHERE c2.id <> p_campaign_id
      AND c2.metric_type = 'affiliate_customer_count'
      AND c2.archived_at IS NULL
      AND c2.status IN ('active', 'paused')
      AND daterange(c2.start_date, c2.end_date, '[]') && daterange(v_c.start_date, v_c.end_date, '[]')
    ORDER BY c2.start_date LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Đã có chiến dịch Số khách Affiliate khác trùng thời gian (% — %) — không được 2 chiến dịch khách overlap', v_overlap.name, v_overlap.status;
    END IF;

    -- 104: identity gate = PHONE, CHỈ trên đơn đủ điều kiện trong kỳ campaign
    -- ∩ target stores (biên VN half-open, mirror vnDayRange + RPC aggregate).
    SELECT count(*) INTO v_nophone
    FROM public.affiliate_orders o
    WHERE o.source_active AND o.status_norm = 'delivered'
      AND o.total_price > 0
      AND o.completed_time >= ((v_c.start_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'))
      AND o.completed_time <  (((v_c.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'))
      AND o.customer_phone_norm IS NULL
      AND o.store_id IN (SELECT t.store_id FROM public.kpi_campaign_store_targets t
                         WHERE t.campaign_id = p_campaign_id);
    IF v_nophone > 0 THEN
      RAISE EXCEPTION '% đơn DELIVERED đủ điều kiện trong kỳ chiến dịch thiếu số điện thoại khách hợp lệ (identity) — nguồn chưa sạch, không kích hoạt', v_nophone;
    END IF;
  END IF;

  -- 106: nhánh Chất lượng bán hàng (offline_order_aov).
  IF v_c.metric_type = 'offline_order_aov' THEN
    -- Overlap của loại này là PER-STORE (chỉ cấm khi CHUNG ≥1 cửa hàng) nên
    -- KHÔNG biểu diễn được bằng EXCLUDE constraint như 103 → serialize bằng
    -- advisory lock cấp TRANSACTION. Dùng MỘT khoá cho cả loại (thay vì khoá
    -- theo từng store đã sort): activation là thao tác hiếm của super admin,
    -- khoá tổng vừa đủ chặt vừa KHÔNG THỂ deadlock. Khoá đặt NGAY TRƯỚC
    -- pre-check để 2 session không cùng đọc "chưa ai trùng".
    PERFORM pg_advisory_xact_lock(hashtext('kpi_order_aov_activate'));

    -- Fail-closed cấu hình: mọi target phải đủ 4 chỉ số + kpi_target chuẩn hóa.
    SELECT count(*) INTO v_bad
    FROM public.kpi_campaign_store_targets t
    WHERE t.campaign_id = p_campaign_id
      AND (t.order_floor IS NULL OR t.aov_floor IS NULL
           OR t.order_target IS NULL OR t.aov_target IS NULL
           OR t.kpi_target IS DISTINCT FROM 100);
    IF v_bad > 0 THEN
      RAISE EXCEPTION '% target chưa đủ chỉ số Order/AOV (hoặc kpi_target <> 100) — nạp lại file target', v_bad;
    END IF;

    -- Overlap: CHỈ so với campaign cùng loại đang ACTIVE và CHUNG cửa hàng.
    -- (paused = đã dừng ghi số ⇒ được phép chuẩn bị chiến dịch kế tiếp; khác
    -- tập store ⇒ chạy song song bình thường.)
    SELECT c2.name AS name,
           string_agg(DISTINCT t2.pos_code, ', ') AS pos
    INTO v_overlap
    FROM public.kpi_campaigns c2
    JOIN public.kpi_campaign_store_targets t2 ON t2.campaign_id = c2.id
    WHERE c2.id <> p_campaign_id
      AND c2.metric_type = 'offline_order_aov'
      AND c2.archived_at IS NULL
      AND c2.status = 'active'
      AND daterange(c2.start_date, c2.end_date, '[]') && daterange(v_c.start_date, v_c.end_date, '[]')
      AND t2.store_id IN (SELECT t.store_id FROM public.kpi_campaign_store_targets t
                          WHERE t.campaign_id = p_campaign_id)
    GROUP BY c2.id, c2.name
    ORDER BY c2.name
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Chiến dịch Chất lượng bán hàng "%" đang chạy trùng thời gian trên cửa hàng: % — mỗi cửa hàng chỉ được 1 chiến dịch loại này tại một thời điểm', v_overlap.name, v_overlap.pos;
    END IF;
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
VALUES ('106', 'kpi_campaign_order_aov',
        'Loại chiến dịch "Chất lượng bán hàng" (metric_type=offline_order_aov, request 11/08):'
        || ' Số đơn Offline 90% + AOV Offline 10%, mỗi chỉ số có floor bắt buộc.'
        || ' kpi_campaign_store_targets += order_floor/aov_floor/order_target/aov_target'
        || ' (+3 CHECK: dương, đủ-4-hoặc-không, target >= floor);'
        || ' kpi_campaign_store_actuals += quality_floor_pass.'
        || ' rpc_replace_campaign_targets: ÉP kpi_target=100 (không nhận từ file) + validate 4'
        || ' chỉ số nguyên/thứ tự + reverse guard cho gmv/customer.'
        || ' rpc_replace_campaign_actuals: RPC LÀ AUTHORITY — nhận RAW net+số đơn, tự tính AOV/'
        || 'completion/floor_pass/tier/commission, TỪ CHỐI payload mang số dẫn xuất; 3 nhánh'
        || ' metric_type tường minh + reject loại lạ.'
        || ' rpc_activate_kpi_campaign: pg_advisory_xact_lock + overlap PER-STORE chỉ với campaign'
        || ' ACTIVE cùng loại (khác tập store vẫn chạy song song) + chặn target thiếu chỉ số.'
        || ' AOV KHÔNG lưu (luôn tính actual_offline/offline_order_count). GMV + Số khách'
        || ' zero-touch. Flag app KPI_ORDER_AOV_CAMPAIGN_ENABLED=false tới khi smoke prod xong.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau migration):
-- 1) CHECK metric_type + contract:
--    SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.kpi_campaigns'::regclass
--      AND conname IN ('chk_kpi_campaigns_metric_type','chk_kpi_campaigns_order_aov_contract');
--    -- metric_type phải liệt kê ĐỦ 3 giá trị
-- 2) 4 cột target + 3 CHECK + cột actual:
--    SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name='kpi_campaign_store_targets'
--      AND column_name IN ('order_floor','aov_floor','order_target','aov_target');   -- 4 rows, YES
--    SELECT conname FROM pg_constraint
--    WHERE conrelid='public.kpi_campaign_store_targets'::regclass
--      AND conname LIKE 'chk_kcst_order_aov%';                                        -- 3 rows
--    SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name='kpi_campaign_store_actuals' AND column_name='quality_floor_pass';
-- 3) CHECK thực sự chặn (phải LỖI — chạy rồi ROLLBACK):
--    BEGIN; UPDATE public.kpi_campaign_store_targets SET order_floor = 10
--    WHERE ctid = (SELECT ctid FROM public.kpi_campaign_store_targets LIMIT 1); ROLLBACK;
--    -- vi phạm all_or_none (mới 1/4 cột) → LỖI là ĐÚNG
-- 4) 3 RPC vẫn SECDEF + grant đúng (anon=f, authenticated=f, service_role=t):
--    SELECT p.proname, p.prosecdef,
--           has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon,
--           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
--           has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role
--    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public' AND p.proname IN ('rpc_replace_campaign_targets',
--          'rpc_replace_campaign_actuals','rpc_activate_kpi_campaign');
-- 5) Source-text: 3 RPC đã mang delta 106 + GIỮ guard cũ:
--    SELECT proname,
--           prosrc LIKE '%offline_order_aov%'        AS has_106,
--           prosrc LIKE '%pg_advisory_xact_lock%'    AS has_lock,
--           prosrc LIKE '%affiliate_customer_count%' AS keeps_103
--    FROM pg_proc WHERE proname IN ('rpc_replace_campaign_targets',
--         'rpc_replace_campaign_actuals','rpc_activate_kpi_campaign');
--    -- actuals/targets/activate: has_106 = true; activate: has_lock = true;
--    -- cả 3: keeps_103 = true (không rơi nhánh customer khi copy)
-- 6) Dữ liệu cũ KHÔNG bị đụng (2 loại campaign hiện hữu):
--    SELECT count(*) FILTER (WHERE order_floor IS NOT NULL) AS should_be_0
--    FROM public.kpi_campaign_store_targets;                                          -- 0
--    SELECT count(*) FILTER (WHERE quality_floor_pass IS NOT NULL) AS should_be_0
--    FROM public.kpi_campaign_store_actuals;                                          -- 0
-- 7) Marker: SELECT version, name FROM public.app_migrations WHERE version='106';
-- 8) SAU khi bật flag + tạo campaign QA (is_test) + sync 2 lần:
--    -- (a) completion do RPC tính khớp công thức tay:
--    SELECT a.store_id, t.order_floor, t.aov_floor, t.order_target, t.aov_target,
--           a.offline_order_count AS actual_order, a.actual_offline AS actual_net,
--           round(a.actual_offline / nullif(a.offline_order_count,0)) AS actual_aov,
--           a.actual_value AS completion_pct, a.quality_floor_pass, a.achieved_tier_order,
--           round(( 0.90*(a.offline_order_count::numeric/t.order_floor)
--                 + 0.10*((a.actual_offline/nullif(a.offline_order_count,0))/t.aov_floor))
--               / ( 0.90*(t.order_target::numeric/t.order_floor)
--                 + 0.10*(t.aov_target/t.aov_floor)) * 100, 4) AS completion_kiem_tra
--    FROM public.kpi_campaign_store_actuals a
--    JOIN public.kpi_campaign_store_targets t
--      ON t.campaign_id = a.campaign_id AND t.store_id = a.store_id
--    WHERE a.campaign_id = '<campaign_id>';
--    -- completion_pct PHẢI bằng completion_kiem_tra ở mọi dòng
--    -- (b) thủng floor mà điểm >= 100 → KHÔNG có bậc:
--    SELECT count(*) AS vi_pham FROM public.kpi_campaign_store_actuals
--    WHERE campaign_id = '<campaign_id>'
--      AND quality_floor_pass IS FALSE AND achieved_tier_order IS NOT NULL;            -- 0
--    -- (c) SUM(daily) = aggregate (tiền lẫn số đơn):
--    SELECT a.store_id, a.actual_offline, a.offline_order_count,
--           (SELECT sum(d.gmv) FROM public.kpi_campaign_store_daily_actuals d
--            WHERE d.campaign_id=a.campaign_id AND d.store_id=a.store_id) AS daily_net,
--           (SELECT sum(d.offline_order_count) FROM public.kpi_campaign_store_daily_actuals d
--            WHERE d.campaign_id=a.campaign_id AND d.store_id=a.store_id) AS daily_ord
--    FROM public.kpi_campaign_store_actuals a WHERE a.campaign_id = '<campaign_id>';
-- 9) Overlap per-store (2 session activate song song — QA script Node):
--    2 campaign order_aov CHUNG >= 1 store + trùng ngày → đúng 1 bên RAISE;
--    2 campaign order_aov KHÁC tập store → cả 2 active được;
--    campaign GMV/Số khách trùng ngày → KHÔNG bị chặn (không đụng nhánh cũ).
-- ============================================================================
