-- ============================================================================
-- 107_kpi_campaign_optional_store_group.sql
-- ⚠ DRAFT — chạy SAU 106, TRƯỚC khi deploy code batch này.
--
-- store_kpi_group ("Phân loại Store") thành TÙY CHỌN.
--
-- Vì sao cần migration: cột vốn đã nullable từ 071 (ADD COLUMN ... text, không
-- NOT NULL), nhưng rpc_replace_campaign_targets của 106 RAISE khi giá trị rỗng
-- ⇒ không thể import file để trống. Đây là chốt DUY NHẤT ở tầng DB.
--
-- THAY ĐỔI DUY NHẤT: bỏ dòng
--     IF v_group IS NULL THEN RAISE EXCEPTION 'store_kpi_group là bắt buộc'; END IF;
-- Toàn bộ phần còn lại của body được TRÍCH TỰ ĐỘNG NGUYÊN VĂN từ 106 (script
-- so từng dòng, khẳng định đúng 1 dòng khác biệt) — KHÔNG gõ lại tay:
--   · row lock FOR UPDATE + archive guard + draft/paused guard
--   · whitelist metric_type 3 loại + reject loại lạ
--   · ÉP kpi_target=100 cho Chất lượng bán hàng + reverse guard 2 loại cũ
--   · validate order_target/aov_target (dương, nguyên)
--   · NULLIF(trim(coalesce(...),'')) GIỮ NGUYÊN ⇒ rỗng/whitespace → NULL
--   · tier tăng dần, >= 1 bậc, policy ĐÚNG 1 bậc mốc 100 cho order_aov
--   · import_runs + xoá actuals/daily + updated_at
--   · REVOKE PUBLIC/anon/authenticated + GRANT service_role
--
-- BACKWARD-COMPATIBLE với app đang chạy: app cũ luôn gửi group non-empty nên
-- hành vi không đổi một byte. Chạy migration TRƯỚC deploy là an toàn.
--
-- KHÔNG đụng schema, KHÔNG backfill, KHÔNG sửa migrations 071–106.
--
-- ROLLBACK: CREATE OR REPLACE rpc_replace_campaign_targets từ 106 (nguyên văn,
--   tức thêm lại đúng dòng RAISE trên) rồi
--   DELETE FROM public.app_migrations WHERE version = '107';
--   (Dữ liệu đã lưu NULL sẽ vẫn NULL — cột nullable, không vi phạm ràng buộc.)
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '106') THEN
    RAISE EXCEPTION '107: thiếu migration nền 106 — chạy đúng thứ tự';
  END IF;
END $$;

-- ── rpc_replace_campaign_targets: BODY 106 NGUYÊN VĂN − 1 dòng RAISE ────────
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
    v_group := NULLIF(trim(coalesce(v_row->>'store_kpi_group', '')), '');
    -- 107: store_kpi_group TÙY CHỌN. NULLIF(trim()) ở dòng trên GIỮ NGUYÊN nên
    -- ô rỗng/toàn khoảng trắng vào DB là NULL (không phải chuỗi rỗng). Dòng
    -- RAISE 'store_kpi_group là bắt buộc' của 106 ĐÃ BỎ — đây là THAY ĐỔI DUY
    -- NHẤT của migration này so với body 106.

    INSERT INTO public.kpi_campaign_store_targets
      (campaign_id, store_id, pos_code, kpi_target, store_kpi_group, import_row, note,
       order_target, aov_target)
    VALUES (
      p_campaign_id,
      (v_row->>'store_id')::uuid,
      v_row->>'pos_code',
      v_kt,
      v_group,
      NULLIF(v_row->>'import_row', '')::integer,
      NULLIF(v_row->>'note', ''),
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

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('107', 'kpi_campaign_optional_store_group',
        'store_kpi_group thành TÙY CHỌN: bỏ RAISE "store_kpi_group là bắt buộc" trong'
        || ' rpc_replace_campaign_targets (body 106 giữ nguyên văn phần còn lại).'
        || ' Chuẩn hoá NULLIF(trim(...)) giữ nguyên nên ô rỗng/toàn khoảng trắng lưu NULL,'
        || ' không phải chuỗi rỗng. Cột vốn đã nullable từ 071 — KHÔNG đổi schema, KHÔNG backfill.'
        || ' UI ẩn hoàn toàn cột "Phân loại" khi MỌI store của campaign đều NULL; dữ liệu'
        || ' hỗn hợp giữ cột và hiện "—". Export Excel GIỮ cột Phân loại (contract Finance).'
        || ' Backward-compatible: app cũ luôn gửi group non-empty nên hành vi không đổi.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ── VERIFY (chạy sau khi COMMIT) ────────────────────────────────────────────
-- 1) Function còn SECURITY DEFINER + search_path:
--    SELECT p.proname, p.prosecdef, p.proconfig
--    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'rpc_replace_campaign_targets';
--    Kỳ vọng: prosecdef = true, proconfig chứa search_path=public.
--
-- 2) Grants ĐÚNG (service_role có, 3 vai kia KHÔNG):
--    SELECT has_function_privilege('service_role',
--             'public.rpc_replace_campaign_targets(uuid,jsonb,text,uuid)', 'EXECUTE')  AS service_role,
--           has_function_privilege('authenticated',
--             'public.rpc_replace_campaign_targets(uuid,jsonb,text,uuid)', 'EXECUTE')  AS authenticated,
--           has_function_privilege('anon',
--             'public.rpc_replace_campaign_targets(uuid,jsonb,text,uuid)', 'EXECUTE')  AS anon;
--    Kỳ vọng: true, false, false.
--
-- 3) Dòng RAISE đã biến mất, phần còn lại còn nguyên:
--    SELECT prosrc LIKE '%store_kpi_group là bắt buộc%'          AS con_raise_khong,
--           prosrc LIKE '%NULLIF(trim(coalesce(v_row->>%'         AS con_normalize,
--           prosrc LIKE '%FOR UPDATE%'                            AS con_row_lock,
--           prosrc LIKE '%Chiến dịch đã lưu trữ%'                 AS con_archive_guard,
--           prosrc LIKE '%ĐÚNG 1 bậc%'                            AS con_policy_tier
--    FROM pg_proc WHERE proname = 'rpc_replace_campaign_targets';
--    Kỳ vọng: false, true, true, true, true.
--
-- 4) Marker: SELECT version, name FROM public.app_migrations WHERE version = '107';
