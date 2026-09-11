-- ============================================================================
-- 112_kpi_campaign_order_bonus.sql
-- Chạy SAU 111, và TRƯỚC khi deploy code batch 113.
--
-- THƯỞNG THÊM THEO NGƯỠNG SỐ ĐƠN cho campaign Doanh số (gmv) — TUỲ CHỌN.
-- Bối cảnh: KPI W2 tháng 09 (10/09–16/09). Mỗi cửa hàng có thêm ngưỡng số đơn
-- tối thiểu; đạt CẢ target doanh thu LẪN ngưỡng đơn thì mỗi dược sĩ nhận thêm
-- một khoản cố định (W2: 200.000đ). Không tạo loại campaign mới, không
-- hardcode campaign nào: chương trình bật theo 2 cột trong file import.
--
-- CONTRACT (chốt 11/09):
--   tổng đơn = offline_order_count (BigQuery DAY.offline_no_order, đã có 105)
--            + affiliate_order_count (sổ affiliate_orders — DELIVERED,
--              source_active, quy gán partner_code, ngày VN theo completed_time;
--              KHÔNG dùng BigQuery affiliate_no_order vì quy gán cửa hàng khác)
--   Đạt ⇔ actual_value >= kpi_target VÀ tổng đơn >= minimum_order_target
--   Khoản thưởng thêm TÁCH HẲN khỏi store_commission_pool (không cộng vào).
--
-- VÌ SAO LƯU SNAPSHOT (không tính ở UI): bộ lọc khoảng ngày ghi đè
-- actual_value/offline_order_count bằng số của khoảng lọc. Tính "đạt" ở UI thì
-- trạng thái thưởng đổi theo bộ lọc. ⇒ RPC tự tính bonus_order_count +
-- order_bonus_achieved lúc ghi snapshot (cơ chế v_calc của 106), payload app
-- KHÔNG được mang 2 số này.
--
-- THÂN 2 RPC được TRÍCH TỰ ĐỘNG NGUYÊN VĂN (107 targets, 106 actuals) rồi CHỈ
-- CHÈN THÊM — spec kpi-migration-112-source khẳng định không mất dòng nào.
--
-- BACKWARD-COMPATIBLE: code đang chạy không gửi key mới ⇒ mọi cột mới NULL,
-- không hành vi nào đổi. Chạy trước deploy là an toàn.
--
-- ROLLBACK:
--   1. CREATE OR REPLACE rpc_replace_campaign_targets từ 107 (nguyên văn).
--   2. CREATE OR REPLACE rpc_replace_campaign_actuals từ 106 (nguyên văn).
--   3. ALTER TABLE public.kpi_campaign_store_actuals
--        DROP CONSTRAINT IF EXISTS chk_kcsa_order_bonus,
--        DROP COLUMN IF EXISTS affiliate_order_count,
--        DROP COLUMN IF EXISTS bonus_order_count,
--        DROP COLUMN IF EXISTS order_bonus_achieved;
--      ALTER TABLE public.kpi_campaign_store_targets
--        DROP CONSTRAINT IF EXISTS chk_kcst_order_bonus,
--        DROP COLUMN IF EXISTS minimum_order_target,
--        DROP COLUMN IF EXISTS order_bonus_per_staff;
--   4. DELETE FROM public.app_migrations WHERE version = '112';
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '111') THEN
    RAISE EXCEPTION '112: thiếu migration nền 111 — chạy đúng thứ tự';
  END IF;
END $$;

-- ── A. Target: ngưỡng số đơn + thưởng thêm/dược sĩ (NULL = không áp dụng) ──
ALTER TABLE public.kpi_campaign_store_targets
  ADD COLUMN IF NOT EXISTS minimum_order_target  integer,
  ADD COLUMN IF NOT EXISTS order_bonus_per_staff numeric;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.kpi_campaign_store_targets'::regclass
                   AND conname = 'chk_kcst_order_bonus') THEN
    ALTER TABLE public.kpi_campaign_store_targets
      ADD CONSTRAINT chk_kcst_order_bonus CHECK (
        num_nonnulls(minimum_order_target, order_bonus_per_staff) IN (0, 2)
        AND (minimum_order_target  IS NULL OR minimum_order_target > 0)
        AND (order_bonus_per_staff IS NULL
             OR (order_bonus_per_staff > 0 AND order_bonus_per_staff = trunc(order_bonus_per_staff))));
  END IF;
END $$;

COMMENT ON COLUMN public.kpi_campaign_store_targets.minimum_order_target IS
  '112: ngưỡng tổng số đơn (Offline + Affiliate) tối thiểu của kỳ để nhận thưởng thêm. NULL = campaign không áp dụng. KHÁC order_target (Chất lượng bán hàng).';
COMMENT ON COLUMN public.kpi_campaign_store_targets.order_bonus_per_staff IS
  '112: thưởng thêm cho MỖI dược sĩ (VNĐ nguyên) khi đạt cả target doanh thu lẫn ngưỡng số đơn. Tách hẳn khỏi store_commission_pool.';

-- ── B. Actuals: số đơn Affiliate + 2 số thưởng thêm do RPC tự tính ─────────
ALTER TABLE public.kpi_campaign_store_actuals
  ADD COLUMN IF NOT EXISTS affiliate_order_count integer,
  ADD COLUMN IF NOT EXISTS bonus_order_count     integer,
  ADD COLUMN IF NOT EXISTS order_bonus_achieved  boolean;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.kpi_campaign_store_actuals'::regclass
                   AND conname = 'chk_kcsa_order_bonus') THEN
    ALTER TABLE public.kpi_campaign_store_actuals
      ADD CONSTRAINT chk_kcsa_order_bonus CHECK (
        (affiliate_order_count IS NULL OR affiliate_order_count >= 0)
        AND (bonus_order_count IS NULL OR bonus_order_count >= 0)
        -- đã có kết luận đạt/chưa đạt thì PHẢI biết tổng đơn dùng để xét
        AND (order_bonus_achieved IS NULL OR bonus_order_count IS NOT NULL));
  END IF;
END $$;

COMMENT ON COLUMN public.kpi_campaign_store_actuals.affiliate_order_count IS
  '112: số đơn Affiliate DELIVERED của kỳ (sổ affiliate_orders, quy gán partner_code). NULL = chưa có / campaign tắt Affiliate.';
COMMENT ON COLUMN public.kpi_campaign_store_actuals.bonus_order_count IS
  '112: tổng số đơn DÙNG ĐỂ XÉT thưởng thêm, RPC tự tính lúc ghi snapshot toàn kỳ. Bộ lọc khoảng ngày KHÔNG ghi đè cột này.';
COMMENT ON COLUMN public.kpi_campaign_store_actuals.order_bonus_achieved IS
  '112: đạt thưởng thêm (RPC tự tính). NULL = không áp dụng HOẶC chưa đủ dữ liệu số đơn — phân biệt bằng target.minimum_order_target.';

-- ── C. rpc_replace_campaign_targets: BODY 107 NGUYÊN VĂN + delta 112 ──────
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
  -- 106: 2 mục tiêu của campaign "Chất lượng bán hàng".
  v_ot          numeric;   -- order_target
  v_at          numeric;   -- aov_target
  v_is_aov      boolean;
  -- 112: thưởng thêm theo số đơn — TUỲ CHỌN, CHỈ campaign gmv.
  v_mot         numeric;   -- minimum_order_target
  v_bps         numeric;   -- order_bonus_per_staff
  v_bonus_rows  integer := 0;
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
  -- 106: whitelist metric_type TƯỜNG MINH — loại lạ không được nạp target.
  IF v_metric_type NOT IN ('gmv', 'affiliate_customer_count', 'offline_order_aov') THEN
    RAISE EXCEPTION 'rpc_replace_campaign_targets: metric_type % không được hỗ trợ', v_metric_type;
  END IF;
  v_is_aov := (v_metric_type = 'offline_order_aov');

  DELETE FROM public.kpi_campaign_store_targets WHERE campaign_id = p_campaign_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    -- 106: Chất lượng bán hàng — kpi_target là ĐIỂM CHUẨN HÓA 100, RPC TỰ ÉP;
    -- file import KHÔNG có cột này.
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

    -- 106: 2 mục tiêu — BẮT BUỘC ĐỦ với offline_order_aov, BẮT BUỘC VẮNG với 2
    -- loại cũ (reverse guard: cột lạ không lọt vào campaign tiền/khách).
    v_ot := NULLIF(v_row->>'order_target', '')::numeric;
    v_at := NULLIF(v_row->>'aov_target',   '')::numeric;
    IF v_is_aov THEN
      IF v_ot IS NULL OR v_at IS NULL THEN
        RAISE EXCEPTION 'campaign Chất lượng bán hàng: store % thiếu chỉ số — order_target và aov_target đều bắt buộc', v_row->>'pos_code';
      END IF;
      IF v_ot <= 0 OR v_at <= 0 THEN
        RAISE EXCEPTION 'campaign Chất lượng bán hàng: store % có chỉ số <= 0 (order_target=%, aov_target=%)', v_row->>'pos_code', v_ot, v_at;
      END IF;
      IF v_ot <> floor(v_ot) THEN
        RAISE EXCEPTION 'campaign Chất lượng bán hàng: store % có order_target KHÔNG NGUYÊN (%)', v_row->>'pos_code', v_ot;
      END IF;
      IF v_at <> floor(v_at) THEN
        RAISE EXCEPTION 'campaign Chất lượng bán hàng: store % có aov_target không nguyên VNĐ (%)', v_row->>'pos_code', v_at;
      END IF;
    ELSIF v_ot IS NOT NULL OR v_at IS NOT NULL THEN
      RAISE EXCEPTION 'campaign % nhưng store % mang order_target/aov_target — 2 cột này CHỈ dành cho Chất lượng bán hàng', v_metric_type, v_row->>'pos_code';
    END IF;
    -- 112: ngưỡng số đơn + thưởng thêm/dược sĩ — TUỲ CHỌN, CHỈ campaign gmv.
    -- Cùng có hoặc cùng vắng; ngưỡng nguyên > 0; tiền thưởng VNĐ nguyên > 0.
    -- KHÔNG dùng lại order_target (thuộc riêng Chất lượng bán hàng).
    v_mot := NULLIF(v_row->>'minimum_order_target', '')::numeric;
    v_bps := NULLIF(v_row->>'order_bonus_per_staff', '')::numeric;
    IF v_mot IS NOT NULL OR v_bps IS NOT NULL THEN
      IF v_metric_type <> 'gmv' THEN
        RAISE EXCEPTION 'campaign % nhưng store % mang minimum_order_target/order_bonus_per_staff — thưởng thêm theo số đơn CHỈ dành cho campaign Doanh số', v_metric_type, v_row->>'pos_code';
      END IF;
      IF v_mot IS NULL OR v_bps IS NULL THEN
        RAISE EXCEPTION 'store % phải có ĐỦ minimum_order_target và order_bonus_per_staff (hoặc để trống cả hai)', v_row->>'pos_code';
      END IF;
      IF v_mot <= 0 OR v_mot <> floor(v_mot) THEN
        RAISE EXCEPTION 'store % có minimum_order_target không hợp lệ (%) — phải là số nguyên > 0', v_row->>'pos_code', v_mot;
      END IF;
      IF v_bps <= 0 OR v_bps <> floor(v_bps) THEN
        RAISE EXCEPTION 'store % có order_bonus_per_staff không hợp lệ (%) — phải là VNĐ nguyên > 0', v_row->>'pos_code', v_bps;
      END IF;
      v_bonus_rows := v_bonus_rows + 1;
    END IF;
    v_group := NULLIF(trim(coalesce(v_row->>'store_kpi_group', '')), '');
    -- 107: store_kpi_group TÙY CHỌN. NULLIF(trim()) ở dòng trên GIỮ NGUYÊN nên
    -- ô rỗng/toàn khoảng trắng vào DB là NULL (không phải chuỗi rỗng). Dòng
    -- RAISE 'store_kpi_group là bắt buộc' của 106 ĐÃ BỎ — đây là THAY ĐỔI DUY
    -- NHẤT của migration này so với body 106.

    INSERT INTO public.kpi_campaign_store_targets
      (campaign_id, store_id, pos_code, kpi_target, store_kpi_group, import_row, note,
       minimum_order_target, order_bonus_per_staff,
       order_target, aov_target)
    VALUES (
      p_campaign_id,
      (v_row->>'store_id')::uuid,
      v_row->>'pos_code',
      v_kt,
      v_group,
      NULLIF(v_row->>'import_row', '')::integer,
      NULLIF(v_row->>'note', ''),
      v_mot::integer, v_bps,   -- 112: NULL khi campaign không áp dụng thưởng thêm
      v_ot::bigint, v_at   -- 106: NULL cho gmv/customer
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
    -- 106 policy: Chất lượng bán hàng dùng ĐÚNG 1 bậc với mốc = 100%
    -- (commission chỉ khi đạt CẢ HAI mục tiêu).
    IF v_is_aov THEN
      IF v_tiers <> 1 THEN
        RAISE EXCEPTION 'campaign Chất lượng bán hàng: store % phải có ĐÚNG 1 bậc (mốc 100%%) — nhận % bậc', v_row->>'pos_code', v_tiers;
      END IF;
      IF v_prev_th IS DISTINCT FROM 100 THEN
        RAISE EXCEPTION 'campaign Chất lượng bán hàng: store % có mốc bậc = %%%, phải đúng 100%%', v_row->>'pos_code', v_prev_th;
      END IF;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  -- 112: HOẶC mọi store có thưởng thêm, HOẶC không store nào (chốt 11/09).
  -- File lẫn lộn gần như luôn là quên một dòng ⇒ store đó lặng lẽ mất thưởng.
  IF v_bonus_rows > 0 AND v_bonus_rows <> v_count THEN
    RAISE EXCEPTION 'Thưởng thêm theo số đơn phải áp dụng cho MỌI cửa hàng trong file (đang có %/% cửa hàng) — điền đủ hoặc để trống toàn bộ 2 cột', v_bonus_rows, v_count;
  END IF;

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

-- ── D. rpc_replace_campaign_actuals: BODY 106 NGUYÊN VĂN + delta 112 ──────
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
  -- 106: campaign Chất lượng bán hàng — RPC LÀ AUTHORITY: nhận số THÔ (Net
  -- Revenue + số đơn), tự tính AOV/tỉ lệ/điểm/bậc/commission từ target trong DB.
  v_out         jsonb := '[]'::jsonb;   -- payload GHI (gốc + số RPC tự tính)
  v_calc        jsonb;
  v_t           record;
  v_aov         numeric;
  v_o_ratio     numeric;
  v_a_ratio     numeric;
  v_completion  numeric;
  v_kpi_pass    boolean;
  v_tier_ord    integer;
  v_pool        numeric;
  v_daily_n     integer;
  v_daily_null  integer;
  -- 112: thưởng thêm theo số đơn — RPC TỰ TÍNH từ target trong DB.
  v_aff_ord     bigint;    -- số đơn Affiliate (sổ affiliate_orders, quy gán partner_code)
  v_bonus_t     record;
  v_bonus_cnt   bigint;
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
    -- 112: NULL = chưa có số đơn Affiliate (caller cũ / metric Affiliate tắt).
    v_aff_ord   := (v_row->>'affiliate_order_count')::bigint;
    v_calc      := '{}'::jsonb;   -- 106: số RPC tự tính (rỗng cho gmv/customer)

    IF NOT EXISTS (SELECT 1 FROM public.kpi_campaign_store_targets t
                   WHERE t.campaign_id = p_campaign_id AND t.store_id = v_store) THEN
      RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % không thuộc targets của campaign %', v_store, p_campaign_id;
    END IF;
    -- 112: 2 số THƯỞNG THÊM do RPC tự tính — payload mang lên là sai contract
    -- (mọi loại campaign). Số đơn Affiliate chỉ có nghĩa với campaign Doanh số.
    IF v_row ?| array['bonus_order_count', 'order_bonus_achieved'] THEN
      RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % gửi bonus_order_count/order_bonus_achieved — 2 số này RPC tự tính từ target, payload không được mang', v_store;
    END IF;
    IF v_metric_type <> 'gmv' AND v_aff_ord IS NOT NULL THEN
      RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign % nhưng store % có affiliate_order_count=% (chỉ campaign Doanh số được mang)', v_metric_type, v_store, v_aff_ord;
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

    ELSIF v_metric_type = 'offline_order_aov' THEN
      -- ── 106: CHẤT LƯỢNG BÁN HÀNG — RPC TỰ TÍNH, KHÔNG TIN PAYLOAD ──
      -- completion = min(actual_order/order_target, actual_aov/aov_target)×100.
      -- Payload CHỈ được mang: actual_offline = Net Revenue kỳ ·
      -- offline_order_count = số đơn kỳ · daily {gmv, offline_order_count}.
      IF v_row ?| array['actual_value', 'run_rate', 'remaining_target',
                        'achieved_tier_order', 'store_commission_pool'] THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign Chất lượng bán hàng — store % gửi số liệu DẪN XUẤT (actual_value/run_rate/remaining_target/achieved_tier_order/store_commission_pool); RPC tự tính, payload chỉ được gửi actual_offline + offline_order_count', v_store;
      END IF;
      IF NOT (v_row ? 'actual_offline') OR v_row->>'actual_offline' IS NULL THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign Chất lượng bán hàng — store % thiếu actual_offline (Net Revenue kỳ)', v_store;
      END IF;
      IF v_affiliate <> 0 OR v_cust <> 0 OR v_daily_aff <> 0 OR v_daily_cust <> 0 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign Chất lượng bán hàng nhưng store % có số liệu affiliate/khách (aff=%, cust=%, daily aff=%, daily cust=%) — phải 0', v_store, v_affiliate, v_cust, v_daily_aff, v_daily_cust;
      END IF;
      -- Net Revenue ÂM là HỢP LỆ (hoàn/điều chỉnh) — KHÔNG clamp.
      IF v_ord IS NULL THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign Chất lượng bán hàng — store % thiếu offline_order_count (số đơn LÀ KPI, không được để trống)', v_store;
      END IF;
      IF v_ord < 0 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % offline_order_count âm (%)', v_store, v_ord;
      END IF;
      -- 0 đơn mà CÓ doanh thu = nguồn MÂU THUẪN (canary 105 bắt ở orchestrator;
      -- đây là lớp phòng thủ DB). '0 đơn → 0%' chỉ đúng khi Net Revenue = 0.
      IF v_ord = 0 AND v_offline <> 0 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % có 0 đơn nhưng Net Revenue = % — nguồn mâu thuẫn, không ghi', v_store, v_offline;
      END IF;
      -- Mọi dòng daily phải ĐỦ gmv + số đơn (không null nửa vời) và tổng khớp.
      SELECT count(*), count(*) FILTER (WHERE e->>'gmv' IS NULL)
      INTO v_daily_n, v_daily_null
      FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e
      WHERE (e->>'store_id')::uuid = v_store;
      IF v_daily_null > 0 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % có % dòng daily thiếu gmv (Net Revenue ngày)', v_store, v_daily_null;
      END IF;
      IF v_daily_ord_n <> v_daily_n THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % chỉ %/% dòng daily mang offline_order_count (phải đủ mọi ngày)', v_store, v_daily_ord_n, v_daily_n;
      END IF;
      IF coalesce(v_daily_ord, 0) <> v_ord THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % SUM(daily.offline_order_count)=% không khớp aggregate offline_order_count=%', v_store, coalesce(v_daily_ord, 0), v_ord;
      END IF;
      IF abs(v_daily_off - v_offline) > 0.01 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % SUM(daily.gmv)=% không khớp actual_offline (Net Revenue)=%', v_store, v_daily_off, v_offline;
      END IF;

      SELECT t.id, t.kpi_target, t.order_target, t.aov_target INTO v_t
      FROM public.kpi_campaign_store_targets t
      WHERE t.campaign_id = p_campaign_id AND t.store_id = v_store;
      IF v_t.order_target IS NULL OR v_t.aov_target IS NULL THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % chưa cấu hình đủ order_target/aov_target — nạp lại file target trước khi đồng bộ', v_store;
      END IF;
      IF v_t.kpi_target <> 100 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % có kpi_target=% (Chất lượng bán hàng phải = 100 — điểm chuẩn hóa)', v_store, v_t.kpi_target;
      END IF;

      -- CÔNG THỨC CHỐT 12/08 — điểm = CHỈ SỐ YẾU HƠN, không bù trừ, không cap.
      v_aov     := CASE WHEN v_ord > 0 THEN v_offline / v_ord END;
      v_o_ratio := v_ord::numeric / v_t.order_target;
      v_a_ratio := CASE WHEN v_aov IS NOT NULL THEN v_aov / v_t.aov_target END;
      v_kpi_pass := (v_ord >= v_t.order_target
                     AND v_aov IS NOT NULL AND v_aov >= v_t.aov_target);
      v_completion := CASE
        WHEN v_aov IS NULL THEN 0                       -- 0 đơn → 0%
        ELSE round(least(v_o_ratio, v_a_ratio) * 100, 4)
      END;
      -- ⚠ INVARIANT TIỀN: completion >= 100 ⟺ đạt CẢ HAI mục tiêu. Làm tròn 4
      -- chữ số có thể đẩy ca hụt cực nhỏ (AOV thiếu 0,001đ) thành đúng 100 →
      -- mở khoá commission oan. kpi_pass suy LÚC ĐỌC từ completion nên sai lệch
      -- này lan ra cả UI/export ⇒ chặn tại đây.
      IF NOT v_kpi_pass AND v_completion >= 100 THEN
        v_completion := 99.9999;
      END IF;

      -- Commission CHỈ khi đạt KPI. Vẫn dùng bảng tier ĐỘNG (policy "đúng 1
      -- bậc 100" nằm ở rpc_replace_campaign_targets) — mở nhiều bậc sau này
      -- không phải đổi nhánh này.
      v_tier_ord := NULL;
      v_pool     := NULL;
      IF v_kpi_pass THEN
        SELECT ti.tier_order, ti.commission_amount INTO v_tier_ord, v_pool
        FROM public.kpi_campaign_store_tiers ti
        WHERE ti.target_id = v_t.id AND ti.threshold_pct <= v_completion
        ORDER BY ti.tier_order DESC LIMIT 1;
      END IF;

      v_calc := jsonb_build_object(
        'actual_value',          v_completion,
        'run_rate',              v_completion,
        'remaining_target',      greatest(100 - v_completion, 0),
        'achieved_tier_order',   v_tier_ord,
        'store_commission_pool', v_pool
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

      -- ── 112: SỐ ĐƠN AFFILIATE (sổ affiliate_orders, quy gán partner_code) ──
      IF NOT v_m_affiliate AND v_aff_ord IS NOT NULL THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: campaign tắt metric_affiliate nhưng store % có affiliate_order_count=%', v_store, v_aff_ord;
      END IF;
      IF v_aff_ord IS NOT NULL AND v_aff_ord < 0 THEN
        RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % affiliate_order_count âm (%)', v_store, v_aff_ord;
      END IF;
      -- ── 112: THƯỞNG THÊM THEO SỐ ĐƠN — RPC TỰ TÍNH, KHÔNG TIN PAYLOAD ──
      -- Đạt ⇔ actual_value >= kpi_target VÀ tổng đơn >= minimum_order_target.
      -- Tổng đơn = phần của metric ĐANG BẬT (khớp định nghĩa doanh thu). Một
      -- phần đang bật mà NULL (POS bị degrade) ⇒ tổng NULL ⇒ trạng thái NULL =
      -- "chưa đủ dữ liệu", KHÔNG phải "chưa đạt". Không ngưỡng ⇒ v_calc rỗng.
      SELECT t.kpi_target, t.minimum_order_target INTO v_bonus_t
      FROM public.kpi_campaign_store_targets t
      WHERE t.campaign_id = p_campaign_id AND t.store_id = v_store;
      IF v_bonus_t.minimum_order_target IS NOT NULL THEN
        v_bonus_cnt := CASE WHEN v_m_offline   THEN v_ord     ELSE 0 END
                     + CASE WHEN v_m_affiliate THEN v_aff_ord ELSE 0 END;
        v_calc := jsonb_build_object(
          'bonus_order_count',    v_bonus_cnt,
          'order_bonus_achieved', CASE WHEN v_bonus_cnt IS NULL THEN NULL
                                       ELSE (v_value >= v_bonus_t.kpi_target
                                             AND v_bonus_cnt >= v_bonus_t.minimum_order_target) END
        );
      END IF;

    ELSE
      -- 106: FAIL-CLOSED — loại campaign lạ không được ghi bằng nhánh mặc định.
      RAISE EXCEPTION 'rpc_replace_campaign_actuals: metric_type % không được hỗ trợ — không ghi số liệu', v_metric_type;
    END IF;

    -- 106: payload GHI = payload gốc + số RPC tự tính (rỗng với gmv/customer
    -- ⇒ 2 loại cũ giữ NGUYÊN từng byte).
    v_out := v_out || jsonb_build_array(v_row || v_calc);
    -- 112: gmv CÓ ngưỡng số đơn ⇒ v_calc mang 2 số thưởng thêm; gmv KHÔNG
    -- ngưỡng và customer vẫn rỗng ⇒ payload ghi của chúng giữ nguyên từng byte.
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
       affiliate_order_count, bonus_order_count, order_bonus_achieved,
       offline_synced_at, affiliate_synced_at, synced_at)
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
      (v_row->>'affiliate_order_count')::integer,   -- 112: NULL = chưa có / metric tắt
      (v_row->>'bonus_order_count')::integer,       -- 112: RPC tự tính (v_calc)
      (v_row->>'order_bonus_achieved')::boolean,    -- 112: RPC tự tính (v_calc)
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
      affiliate_order_count = EXCLUDED.affiliate_order_count,
      bonus_order_count     = EXCLUDED.bonus_order_count,
      order_bonus_achieved  = EXCLUDED.order_bonus_achieved,
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

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('112', 'kpi_campaign_order_bonus',
        'Thưởng thêm theo ngưỡng số đơn cho campaign Doanh số (tuỳ chọn, bật theo 2 cột import'
        || ' minimum_order_target + order_bonus_per_staff). actuals + affiliate_order_count (sổ'
        || ' affiliate_orders, partner_code), bonus_order_count, order_bonus_achieved — 2 cột sau'
        || ' do RPC tự tính lúc ghi snapshot toàn kỳ, payload app không được mang. Đạt ⇔'
        || ' actual_value >= kpi_target VÀ tổng đơn >= ngưỡng. Tách hẳn khỏi store_commission_pool.'
        || ' Thân 2 RPC trích nguyên văn 107/106 + chỉ chèn thêm. Backward-compatible.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ── VERIFY (chạy sau khi COMMIT) ────────────────────────────────────────────
-- 1) 5 cột mới:
--    SELECT table_name, column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND column_name IN ('minimum_order_target', 'order_bonus_per_staff',
--                          'affiliate_order_count', 'bonus_order_count', 'order_bonus_achieved')
--    ORDER BY table_name, column_name;
--    Kỳ vọng 5 dòng: targets (integer, numeric) · actuals (integer, integer, boolean).
--
-- 2) 2 CHECK:
--    SELECT conname FROM pg_constraint
--    WHERE conname IN ('chk_kcst_order_bonus', 'chk_kcsa_order_bonus');
--    Kỳ vọng 2 dòng.
--
-- 3) 2 RPC còn SECURITY DEFINER + search_path:
--    SELECT p.proname, p.prosecdef, p.proconfig
--    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('rpc_replace_campaign_targets', 'rpc_replace_campaign_actuals');
--    Kỳ vọng: prosecdef = true, proconfig chứa search_path=public cho cả 2.
--
-- 4) Grants ĐÚNG (service_role có, 2 vai kia KHÔNG):
--    SELECT has_function_privilege('service_role',  'public.rpc_replace_campaign_targets(uuid,jsonb,text,uuid)', 'EXECUTE') AS t_service,
--           has_function_privilege('authenticated', 'public.rpc_replace_campaign_targets(uuid,jsonb,text,uuid)', 'EXECUTE') AS t_auth,
--           has_function_privilege('anon',          'public.rpc_replace_campaign_targets(uuid,jsonb,text,uuid)', 'EXECUTE') AS t_anon,
--           has_function_privilege('service_role',  'public.rpc_replace_campaign_actuals(uuid,jsonb,jsonb)', 'EXECUTE')     AS a_service,
--           has_function_privilege('authenticated', 'public.rpc_replace_campaign_actuals(uuid,jsonb,jsonb)', 'EXECUTE')     AS a_auth,
--           has_function_privilege('anon',          'public.rpc_replace_campaign_actuals(uuid,jsonb,jsonb)', 'EXECUTE')     AS a_anon;
--    Kỳ vọng: true, false, false, true, false, false.
--
-- 5) Delta 112 có mặt, guard cũ còn nguyên:
--    SELECT proname,
--           prosrc LIKE '%minimum_order_target%'            AS co_nguong,
--           prosrc LIKE '%MỌI cửa hàng trong file%'          AS co_all_or_none,
--           prosrc LIKE '%RPC tự tính từ target%'            AS co_chan_key_dan_xuat,
--           prosrc LIKE '%FOR UPDATE%'                       AS con_row_lock,
--           prosrc LIKE '%Chiến dịch đã lưu trữ%' OR prosrc LIKE '%đã lưu trữ%' AS con_archive_guard
--    FROM pg_proc
--    WHERE proname IN ('rpc_replace_campaign_targets', 'rpc_replace_campaign_actuals');
--    Kỳ vọng: targets → co_nguong + co_all_or_none + con_row_lock + con_archive_guard = true;
--             actuals → co_nguong + co_chan_key_dan_xuat + con_row_lock + con_archive_guard = true.
--
-- 6) Campaign hiện có KHÔNG bị ảnh hưởng (mọi cột mới NULL cho tới lần import/sync kế):
--    SELECT count(*) FILTER (WHERE minimum_order_target IS NOT NULL) AS targets_co_nguong
--    FROM public.kpi_campaign_store_targets;
--    Kỳ vọng: 0.
--
-- 7) Marker: SELECT version, name FROM public.app_migrations WHERE version = '112';
