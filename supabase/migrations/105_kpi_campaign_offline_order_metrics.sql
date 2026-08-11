-- ============================================================================
-- 105_kpi_campaign_offline_order_metrics.sql
-- ⚠ DRAFT — CHƯA CHẠY cho tới khi stakeholder audit pass.
--
-- REQUEST 11/08: BI thêm 2 field vào `buymed_tech.tech__circa_os_gmv_kpi`:
--   no_order (tổng số đơn) · aov (average order value)
-- Stakeholder muốn 2 chỉ số này lên màn /targets/campaigns (tab Kết quả).
--
-- CONTRACT (đã chốt + verify trên dữ liệu thật 25 rows MONTH 08/2026):
--   · CHỈ campaign metric_type='gmv' AND metric_offline=true.
--   · Số đơn Offline = SUM(no_order) trong [start_date, end_date] (DAY rows).
--   · AOV Offline    = SUM(net_revenue) / SUM(no_order)  ← WEIGHTED.
--     TUYỆT ĐỐI KHÔNG AVG(aov)/cộng aov: đo thật 08/2026 lệch 1.445đ
--     (weighted 130.501,53 vs average 131.946,34).
--   · KHÔNG lưu cột aov (giá trị dẫn xuất, dễ lệch với net_revenue/no_order) —
--     chỉ lưu offline_order_count, AOV luôn tính lại từ
--     actual_offline / offline_order_count.
--   · NULL có Ý NGHĨA: 'nguồn chưa có số đơn' (snapshot cũ / campaign không
--     áp dụng) ≠ 0 ('có 0 đơn'). Không backfill giả thành 0.
--   · Row BQ tương lai NULL cả net_revenue + no_order = hợp lệ (0đ / 0 đơn);
--     lệch một bên → fail-closed ở engine, giữ snapshot cũ.
--   · KHÔNG đụng Actual GMV / KPI / % / nhịp độ / tier / commission.
--   · Preflight BQ DAY 08/2026 PASS: 775 rows (25 store × 31 ngày),
--     rev_no_count_BAD = count_no_rev_BAD = negative = non_integer = 0.
--
-- Nội dung: 2 cột offline_order_count (aggregate + daily) + CHECK ≥ 0, và
-- CREATE OR REPLACE rpc_replace_campaign_actuals = BODY 103 NGUYÊN VĂN +
-- delta 105 (đánh dấu "105:"): validate SUM(daily) = aggregate, cấm campaign
-- khách/affiliate-only mang số đơn Offline, payload nửa vời → RAISE.
-- Idempotent (DDL additive + CREATE OR REPLACE, KHÔNG đổi dữ liệu).
--
-- ROLLBACK:
--   CREATE OR REPLACE lại rpc_replace_campaign_actuals từ file 103;
--   ALTER TABLE public.kpi_campaign_store_actuals
--     DROP CONSTRAINT IF EXISTS chk_ksa_offline_order_count_nonneg,
--     DROP COLUMN IF EXISTS offline_order_count;
--   ALTER TABLE public.kpi_campaign_store_daily_actuals
--     DROP CONSTRAINT IF EXISTS chk_kcda_offline_order_count_nonneg,
--     DROP COLUMN IF EXISTS offline_order_count;
--   DELETE FROM public.app_migrations WHERE version = '105';
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '104') THEN
    RAISE EXCEPTION '105: thiếu migration nền 104 (identity phone) — chạy đúng thứ tự';
  END IF;
END $$;

-- ── A. Cột số đơn Offline (nullable có ý nghĩa) ─────────────────────────────
ALTER TABLE public.kpi_campaign_store_actuals
  ADD COLUMN IF NOT EXISTS offline_order_count bigint;
ALTER TABLE public.kpi_campaign_store_daily_actuals
  ADD COLUMN IF NOT EXISTS offline_order_count bigint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.kpi_campaign_store_actuals'::regclass
                   AND conname = 'chk_ksa_offline_order_count_nonneg') THEN
    ALTER TABLE public.kpi_campaign_store_actuals
      ADD CONSTRAINT chk_ksa_offline_order_count_nonneg
      CHECK (offline_order_count IS NULL OR offline_order_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.kpi_campaign_store_daily_actuals'::regclass
                   AND conname = 'chk_kcda_offline_order_count_nonneg') THEN
    ALTER TABLE public.kpi_campaign_store_daily_actuals
      ADD CONSTRAINT chk_kcda_offline_order_count_nonneg
      CHECK (offline_order_count IS NULL OR offline_order_count >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.kpi_campaign_store_actuals.offline_order_count IS
  'Số đơn Offline trong kỳ (BigQuery no_order). NULL = nguồn chưa có số đơn (KHÁC 0). AOV = actual_offline / offline_order_count (weighted) — KHÔNG lưu aov.';
COMMENT ON COLUMN public.kpi_campaign_store_daily_actuals.offline_order_count IS
  'Số đơn Offline của ngày (BigQuery no_order). NULL = nguồn chưa có số đơn. SUM(daily) PHẢI khớp aggregate (RPC enforce).';

-- ── B. rpc_replace_campaign_actuals: BODY 103 NGUYÊN VĂN + delta 105 ────────
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
    ELSE
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
    END IF;
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

  FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_actuals, '[]'::jsonb))
  LOOP
    INSERT INTO public.kpi_campaign_store_actuals
      (campaign_id, store_id, actual_value, actual_offline, actual_affiliate,
       actual_customer_count, run_rate, remaining_target, achieved_tier_order,
       store_commission_pool, raw_row_count, offline_order_count,
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

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('105', 'kpi_campaign_offline_order_metrics',
        'Số đơn Offline + AOV cho campaign GMV (request 11/08). kpi_campaign_store_actuals'
        || ' + kpi_campaign_store_daily_actuals thêm offline_order_count bigint NULL + CHECK >= 0'
        || ' (NULL = nguồn chưa có số đơn, KHÁC 0). rpc_replace_campaign_actuals = body 103 nguyên'
        || ' văn + validate SUM(daily.offline_order_count) = aggregate, cấm campaign khách/'
        || 'affiliate-only mang số đơn Offline, chặn payload nửa vời. AOV KHÔNG lưu — luôn tính'
        || ' actual_offline / offline_order_count (weighted, cấm AVG(aov)). GMV/KPI/tier/commission'
        || ' zero-touch. Backfill: chạy sync sau deploy code mới.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau migration):
-- 1) Cột + CHECK (2 bảng):
--    SELECT table_name, column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE column_name = 'offline_order_count'
--      AND table_name IN ('kpi_campaign_store_actuals','kpi_campaign_store_daily_actuals');
--    -- 2 rows, bigint, YES
--    SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname IN ('chk_ksa_offline_order_count_nonneg','chk_kcda_offline_order_count_nonneg');
-- 2) CHECK thực sự chặn số âm (phải LỖI — chạy rồi ROLLBACK):
--    BEGIN; UPDATE public.kpi_campaign_store_actuals SET offline_order_count = -1
--    WHERE ctid = (SELECT ctid FROM public.kpi_campaign_store_actuals LIMIT 1); ROLLBACK;
-- 3) RPC vẫn SECDEF + grant đúng (anon=f, authenticated=f, service_role=t):
--    SELECT p.proname, p.prosecdef,
--           has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon,
--           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
--           has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role
--    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public' AND p.proname='rpc_replace_campaign_actuals';
-- 4) Source-text: RPC đã mang delta 105:
--    SELECT count(*) FILTER (WHERE prosrc LIKE '%offline_order_count%') AS has_105
--    FROM pg_proc WHERE proname = 'rpc_replace_campaign_actuals';   -- 1
-- 5) Snapshot HIỆN TẠI giữ NULL (không backfill giả 0):
--    SELECT count(*) AS total, count(offline_order_count) AS has_count
--    FROM public.kpi_campaign_store_actuals;    -- has_count = 0 trước lần sync đầu
-- 6) Marker: SELECT version, name FROM public.app_migrations WHERE version='105';
-- 7) SAU khi deploy code + sync tay 2 lần — đối soát 25 POS campaign 08/2026:
--    SELECT count(*) AS stores,
--           sum(offline_order_count)                              AS total_orders,
--           round(sum(actual_offline) / nullif(sum(offline_order_count),0)) AS aov_weighted
--    FROM public.kpi_campaign_store_actuals
--    WHERE campaign_id = 'a268c597-1e49-40d3-95b9-1265e92bded9';
--    -- đối chiếu với BigQuery MONTH 08/2026: SUM(no_order) và
--    -- SUM(net_revenue)/SUM(no_order) (đo 11/08: 22.283 đơn · AOV 130.502đ)
--    -- ⚠ số sẽ tăng theo ngày — so tại CÙNG thời điểm chạy.
-- 8) SUM(daily) = aggregate (RPC đã enforce; kiểm lại sau sync):
--    SELECT a.store_id, a.offline_order_count AS agg,
--           (SELECT sum(d.offline_order_count) FROM public.kpi_campaign_store_daily_actuals d
--            WHERE d.campaign_id = a.campaign_id AND d.store_id = a.store_id) AS daily_sum
--    FROM public.kpi_campaign_store_actuals a
--    WHERE a.campaign_id = 'a268c597-1e49-40d3-95b9-1265e92bded9'
--      AND a.offline_order_count IS DISTINCT FROM
--          (SELECT sum(d.offline_order_count) FROM public.kpi_campaign_store_daily_actuals d
--           WHERE d.campaign_id = a.campaign_id AND d.store_id = a.store_id);   -- 0 rows
-- ============================================================================
