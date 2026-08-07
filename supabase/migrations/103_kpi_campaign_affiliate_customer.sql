-- ============================================================================
-- 103_kpi_campaign_affiliate_customer.sql
-- ⚠ DRAFT — CHƯA CHẠY cho tới khi stakeholder audit pass.
--
-- Metric campaign MỚI `affiliate_customer_count` ("Số khách Affiliate" —
-- handoff 06/08): đếm COUNT(DISTINCT account_id) khách có ≥1 đơn Affiliate
-- DELIVERED hợp lệ trong kỳ. Contract cột: metric_type='affiliate_customer_count'
-- + metric_offline=false + metric_affiliate=true + order_type='online';
-- actual_value = actual_customer_count; actual_offline = actual_affiliate = 0.
-- Campaign GMV hiện hành: HÀNH VI GIỮ NGUYÊN TỪNG BYTE (mọi redefine đều
-- copy 098 nguyên văn + delta đánh dấu "103:").
--
-- THỨ TỰ VẬN HÀNH (quan trọng — giống bài học 092):
--   Phase 0 proof script 3 gate = 0 → audit file này → CHẠY MIGRATION TRƯỚC
--   → deploy code → full sync backfill account_id → verify → QA flag test
--   → bật KPI_AFFILIATE_CUSTOMER_ENABLED. Chạy mig trước deploy AN TOÀN:
--   mọi RPC redefine backward-compat với engine cũ (coalesce-0 cột mới);
--   chiều ngược (deploy trước mig) sẽ làm upsert account_id fail.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / DO-guard theo
-- conname / CREATE INDEX IF NOT EXISTS / marker ON CONFLICT DO NOTHING.
-- pg_safeupdate-safe (không bare UPDATE/DELETE).
--
-- ROLLBACK (thứ tự):
--   1. Kiểm KHÔNG còn campaign customer: SELECT count(*) FROM kpi_campaigns
--      WHERE metric_type='affiliate_customer_count';  -- phải 0 (archive/xóa trước)
--   2. DROP FUNCTION IF EXISTS public.rpc_aggregate_affiliate_customers(uuid[], timestamptz, timestamptz);
--   3. Tái tạo 3 RPC từ file 098 (sections C/D/E nguyên văn):
--      rpc_replace_campaign_targets / rpc_activate_kpi_campaign / rpc_replace_campaign_actuals.
--   4. ALTER TABLE public.kpi_campaigns
--        DROP CONSTRAINT IF EXISTS excl_customer_campaign_overlap,
--        DROP CONSTRAINT IF EXISTS chk_kpi_campaigns_customer_contract,
--        DROP CONSTRAINT IF EXISTS chk_kpi_campaigns_metric_type;
--      ALTER TABLE public.kpi_campaigns ADD CONSTRAINT chk_kpi_campaigns_metric_type
--        CHECK (metric_type IN ('gmv'));
--   5. ALTER TABLE public.kpi_campaign_store_actuals
--        DROP CONSTRAINT IF EXISTS chk_ksa_customer_count_nonneg,
--        DROP COLUMN IF EXISTS actual_customer_count;
--      ALTER TABLE public.kpi_campaign_store_daily_actuals
--        DROP CONSTRAINT IF EXISTS chk_kcda_customer_count_nonneg,
--        DROP COLUMN IF EXISTS affiliate_customer_count;
--   6. DROP INDEX IF EXISTS public.idx_affiliate_orders_delivered_missing_account;
--      ALTER TABLE public.affiliate_orders DROP COLUMN IF EXISTS account_id;
--      (chỉ khi code đã rollback về bản không SELECT/ghi account_id)
--   7. DELETE FROM public.app_migrations WHERE version = '103';
-- ============================================================================

BEGIN;

-- ── A. Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE v_nongmv integer;
BEGIN
  IF (SELECT count(*) FROM public.app_migrations
      WHERE version IN ('069','070','071','072','090','092','093','098','099','102')) <> 10 THEN
    RAISE EXCEPTION '103: thiếu migration nền — cần đủ 069/070/071/072/090/092/093/098/099/102 đã chạy';
  END IF;
  SELECT count(*) INTO v_nongmv FROM public.kpi_campaigns WHERE metric_type <> 'gmv';
  IF v_nongmv > 0 THEN
    RAISE EXCEPTION '103: % campaign có metric_type khác gmv TRƯỚC khi mở CHECK — trạng thái bất ngờ, kiểm tra tay', v_nongmv;
  END IF;
END $$;

-- ── B. CHECK metric_type: mở rộng + đặt TÊN tường minh ──────────────────────
-- 071 tạo CHECK inline KHÔNG TÊN (auto-name) → drop bằng DISCOVERY theo
-- definition trong pg_constraint (không hard-code tên auto), rồi tạo lại CÓ
-- TÊN — các lần redefine sau không còn mù tên. Loop chỉ đụng contype='c'
-- (CHECK) và né 2 constraint có tên của chính 103 (idempotent khi re-run;
-- EXCLUDE constraint là contype='x' — không bị đụng).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname FROM pg_constraint con
    WHERE con.conrelid = 'public.kpi_campaigns'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%metric_type%'
      AND con.conname NOT IN ('chk_kpi_campaigns_metric_type', 'chk_kpi_campaigns_customer_contract')
  LOOP
    EXECUTE format('ALTER TABLE public.kpi_campaigns DROP CONSTRAINT %I', r.conname);
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'chk_kpi_campaigns_metric_type'
                   AND conrelid = 'public.kpi_campaigns'::regclass) THEN
    ALTER TABLE public.kpi_campaigns ADD CONSTRAINT chk_kpi_campaigns_metric_type
      CHECK (metric_type IN ('gmv', 'affiliate_customer_count'));
  END IF;

  -- Contract cột customer campaign ENFORCE Ở DB (không tin app):
  -- customer → offline=false + affiliate=true + order_type='online'.
  -- (CHECK 092 chk_kpi_campaigns_metric "offline OR affiliate" pass sẵn.)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'chk_kpi_campaigns_customer_contract'
                   AND conrelid = 'public.kpi_campaigns'::regclass) THEN
    ALTER TABLE public.kpi_campaigns ADD CONSTRAINT chk_kpi_campaigns_customer_contract
      CHECK (metric_type <> 'affiliate_customer_count'
             OR (metric_offline = false AND metric_affiliate = true AND order_type = 'online'));
  END IF;
END $$;

-- ── C. affiliate_orders.account_id (identity khách — Mongo order.account_id) ─
-- NULLABLE: full-snapshot sync tự backfill toàn bộ row sau deploy (pattern
-- completed_time 092); fail-closed nằm ở RPC aggregate customer, KHÔNG ở
-- health gate chung (health chung phục vụ cả GMV — không được đóng băng oan).
ALTER TABLE public.affiliate_orders ADD COLUMN IF NOT EXISTS account_id bigint;

-- Index canary: đơn delivered active THIẾU account_id (gần như rỗng khi nguồn
-- lành mạnh) — phục vụ 2 count fail-closed trong RPC + đối soát vận hành.
-- Scan aggregation chính tái dùng idx_affiliate_orders_store_completed_id (099).
CREATE INDEX IF NOT EXISTS idx_affiliate_orders_delivered_missing_account
  ON public.affiliate_orders (order_id)
  WHERE source_active AND status_norm = 'delivered' AND account_id IS NULL;

-- ── D. Cột count trên actuals/daily (NOT NULL DEFAULT 0 — row cũ tự đúng) ───
ALTER TABLE public.kpi_campaign_store_actuals
  ADD COLUMN IF NOT EXISTS actual_customer_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.kpi_campaign_store_daily_actuals
  ADD COLUMN IF NOT EXISTS affiliate_customer_count integer NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ksa_customer_count_nonneg'
                   AND conrelid = 'public.kpi_campaign_store_actuals'::regclass) THEN
    ALTER TABLE public.kpi_campaign_store_actuals
      ADD CONSTRAINT chk_ksa_customer_count_nonneg CHECK (actual_customer_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_kcda_customer_count_nonneg'
                   AND conrelid = 'public.kpi_campaign_store_daily_actuals'::regclass) THEN
    ALTER TABLE public.kpi_campaign_store_daily_actuals
      ADD CONSTRAINT chk_kcda_customer_count_nonneg CHECK (affiliate_customer_count >= 0);
  END IF;
END $$;

-- ── E. Chống overlap 2 customer campaign ACTIVE — DB backstop race-proof ────
-- Repo không dùng advisory lock; EXCLUSION constraint kiểm ngay tại statement
-- UPDATE status='active' → 2 session cùng activate thì 1 bên fail sạch.
-- GMV campaign không dính predicate (song song/chồng ngày như hiện tại).
-- RPC activate còn pre-check active+paused với message tiếng Việt (handoff);
-- constraint này là backstop cho race + sửa tay.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'excl_customer_campaign_overlap'
                   AND conrelid = 'public.kpi_campaigns'::regclass) THEN
    ALTER TABLE public.kpi_campaigns ADD CONSTRAINT excl_customer_campaign_overlap
      EXCLUDE USING gist (daterange(start_date, end_date, '[]') WITH &&)
      WHERE (metric_type = 'affiliate_customer_count' AND status = 'active' AND archived_at IS NULL);
  END IF;
END $$;

-- ── F. RPC aggregate SỐ KHÁCH theo store×ngày VN (service_role only) ────────
-- Trả jsonb (khác template TABLE của 092 — cần daily rows + tổng đối chiếu +
-- diagnostics cross-store trong CÙNG MVCC snapshot 1 statement):
--   { rows: [{store_id, vn_date, customer_count}], total_customers,
--     cross_store_account_count, cross_store_sample: [account_id ≤10] }
-- Dedup TOÀN scope: DISTINCT ON (account_id) — 1 account = 1 khách, đơn
-- DELIVERED sớm nhất thắng (tie-break order_id); khách rơi vào (store, ngày VN)
-- của đơn thắng → SUM(daily) LUÔN = total_customers.
-- total_price <= 0 loại ÊM (không fail — giá âm là hiện tượng đã biết 22/07).
-- FAIL-CLOSED (mirror 092, check TOÀN thời gian trong scope stores):
--   thiếu completed_time HOẶC thiếu account_id → RAISE, giữ snapshot KPI cũ.
CREATE OR REPLACE FUNCTION public.rpc_aggregate_affiliate_customers(
  p_store_ids uuid[],
  p_from      timestamptz,
  p_to        timestamptz
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_missing_ct   integer;
  v_missing_acct integer;
  v_result       jsonb;
BEGIN
  SELECT count(*) INTO v_missing_ct
  FROM public.affiliate_orders o
  WHERE o.source_active AND o.status_norm = 'delivered'
    AND o.store_id = ANY (p_store_ids) AND o.completed_time IS NULL;
  IF v_missing_ct > 0 THEN
    RAISE EXCEPTION 'rpc_aggregate_affiliate_customers: % đơn DELIVERED active thiếu completed_time trong các store yêu cầu — fail-closed, giữ snapshot KPI cũ', v_missing_ct;
  END IF;

  SELECT count(*) INTO v_missing_acct
  FROM public.affiliate_orders o
  WHERE o.source_active AND o.status_norm = 'delivered'
    AND o.store_id = ANY (p_store_ids)
    AND (o.account_id IS NULL OR o.account_id <= 0);
  IF v_missing_acct > 0 THEN
    RAISE EXCEPTION 'rpc_aggregate_affiliate_customers: % đơn DELIVERED active thiếu account_id (identity khách) trong các store yêu cầu — fail-closed, giữ snapshot KPI cũ (kiểm tra backfill account_id)', v_missing_acct;
  END IF;

  WITH qualifying AS (
    SELECT o.account_id, o.store_id, o.completed_time, o.order_id
    FROM public.affiliate_orders o
    WHERE o.source_active AND o.status_norm = 'delivered'
      AND o.store_id = ANY (p_store_ids)
      AND o.total_price > 0
      AND o.completed_time >= p_from AND o.completed_time < p_to
  ),
  winners AS (
    SELECT DISTINCT ON (q.account_id)
           q.account_id, q.store_id,
           (q.completed_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS vn_date
    FROM qualifying q
    ORDER BY q.account_id, q.completed_time ASC, q.order_id ASC
  ),
  daily AS (
    SELECT w.store_id, w.vn_date, count(*)::integer AS customer_count
    FROM winners w GROUP BY w.store_id, w.vn_date
  ),
  cross_store AS (
    SELECT q.account_id FROM qualifying q
    GROUP BY q.account_id HAVING count(DISTINCT q.store_id) > 1
  )
  SELECT jsonb_build_object(
    'rows', coalesce(
      (SELECT jsonb_agg(jsonb_build_object(
                'store_id', d.store_id, 'vn_date', d.vn_date, 'customer_count', d.customer_count)
              ORDER BY d.store_id, d.vn_date)
       FROM daily d), '[]'::jsonb),
    'total_customers', (SELECT count(*) FROM winners),
    'cross_store_account_count', (SELECT count(*) FROM cross_store),
    'cross_store_sample', coalesce(
      (SELECT jsonb_agg(s.account_id)
       FROM (SELECT cs.account_id FROM cross_store cs ORDER BY cs.account_id LIMIT 10) s), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.rpc_aggregate_affiliate_customers(uuid[], timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_aggregate_affiliate_customers(uuid[], timestamptz, timestamptz)
  TO service_role;

-- ── G. rpc_replace_campaign_actuals: body 098 NGUYÊN VĂN + branch metric ────
-- Delta 103 (đánh dấu "103:"): đọc metric_type; per-row branch —
--   · customer: actual_value = actual_customer_count (integer ≥0),
--     actual_offline = actual_affiliate = 0, SUM(daily.gmv) = SUM(daily
--     .gmv_affiliate) = 0, SUM(daily.affiliate_customer_count) = count.
--     Check identity value=offline+affiliate của GMV KHÔNG áp cho nhánh này
--     (sẽ vỡ by design — đây là TẦNG CHỐT: engine cũ không biết customer gửi
--     payload GMV vào campaign customer → fallback legacy offline=actual_value
--     ≠ 0 → RAISE → snapshot_preserved, không bao giờ ghi số sai).
--   · gmv: giữ NGUYÊN VĂN 098 + THÊM actual_customer_count = 0 và
--     SUM(daily.affiliate_customer_count) = 0 (chặn chiều ngược).
-- INSERT coalesce(...,0) cột mới → caller cũ không gửi key vẫn chạy đúng.
CREATE OR REPLACE FUNCTION public.rpc_replace_campaign_actuals(
  p_campaign_id uuid,
  p_daily   jsonb,  -- [{store_id, date, gmv, gmv_affiliate?, affiliate_customer_count?, synced_at}]
  p_actuals jsonb   -- [{store_id, actual_value, actual_offline?, actual_affiliate?,
                    --   actual_customer_count?, run_rate, remaining_target,
                    --   achieved_tier_order, store_commission_pool, raw_row_count,
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

    IF NOT EXISTS (SELECT 1 FROM public.kpi_campaign_store_targets t
                   WHERE t.campaign_id = p_campaign_id AND t.store_id = v_store) THEN
      RAISE EXCEPTION 'rpc_replace_campaign_actuals: store % không thuộc targets của campaign %', v_store, p_campaign_id;
    END IF;

    SELECT coalesce(sum((e->>'gmv')::numeric), 0),
           coalesce(sum(coalesce((e->>'gmv_affiliate')::numeric, 0)), 0),
           coalesce(sum(coalesce((e->>'affiliate_customer_count')::integer, 0)), 0)
    INTO v_daily_off, v_daily_aff, v_daily_cust
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
    END IF;
  END LOOP;

  -- ── REPLACE-ALL (098 nguyên văn; 103: thêm cột count vào INSERT/UPDATE) ──
  DELETE FROM public.kpi_campaign_store_daily_actuals WHERE campaign_id = p_campaign_id;
  DELETE FROM public.kpi_campaign_store_actuals       WHERE campaign_id = p_campaign_id;

  INSERT INTO public.kpi_campaign_store_daily_actuals
    (campaign_id, store_id, date, gmv, gmv_affiliate, affiliate_customer_count, synced_at)
  SELECT p_campaign_id,
         (e->>'store_id')::uuid,
         (e->>'date')::date,
         coalesce((e->>'gmv')::numeric, 0),
         coalesce((e->>'gmv_affiliate')::numeric, 0),
         coalesce((e->>'affiliate_customer_count')::integer, 0),
         coalesce((e->>'synced_at')::timestamptz, now())
  FROM jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) e;

  FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_actuals, '[]'::jsonb))
  LOOP
    INSERT INTO public.kpi_campaign_store_actuals
      (campaign_id, store_id, actual_value, actual_offline, actual_affiliate,
       actual_customer_count, run_rate, remaining_target, achieved_tier_order,
       store_commission_pool, raw_row_count, offline_synced_at, affiliate_synced_at, synced_at)
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

-- ── H. rpc_activate_kpi_campaign: body 098 NGUYÊN VĂN + nhánh customer ──────
-- Delta 103: SELECT thêm metric_type/start_date/end_date; nhánh customer —
--   (1) overlap pre-check với customer campaign khác active/PAUSED không
--       archived (handoff Phase 5; EXCLUDE constraint là backstop race cho
--       active tại chính statement UPDATE);
--   (2) identity fail-closed sớm: còn đơn delivered active thiếu account_id
--       trong các store targets → RAISE (đỡ chờ sync đầu preserve).
-- Nhánh metric_affiliate=true (OS-active + run_id) TỰ áp cho customer vì
-- contract cột ép metric_affiliate=true — health freshness giữ nguyên.
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
  v_overlap      record;
  v_noacct       integer;
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

  SELECT count(*) INTO v_target_count
  FROM public.kpi_campaign_store_targets WHERE campaign_id = p_campaign_id;
  IF v_target_count = 0 THEN
    RAISE EXCEPTION 'Chưa import target cho chiến dịch này';
  END IF;

  -- 103: nhánh customer-count.
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

    SELECT count(*) INTO v_noacct
    FROM public.affiliate_orders o
    WHERE o.source_active AND o.status_norm = 'delivered'
      AND (o.account_id IS NULL OR o.account_id <= 0)
      AND o.store_id IN (SELECT t.store_id FROM public.kpi_campaign_store_targets t
                         WHERE t.campaign_id = p_campaign_id);
    IF v_noacct > 0 THEN
      RAISE EXCEPTION '% đơn DELIVERED thiếu account_id trong các store của chiến dịch — backfill identity chưa hoàn tất, không kích hoạt', v_noacct;
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

-- ── I. rpc_replace_campaign_targets: body 098 NGUYÊN VĂN + integer guard ────
-- Delta 103: đọc metric_type; campaign customer → kpi_target phải SỐ NGUYÊN
-- (đơn vị khách) — DB boundary không tin payload service-role.
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

  DELETE FROM public.kpi_campaign_store_targets WHERE campaign_id = p_campaign_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_kt := (v_row->>'kpi_target')::numeric;
    IF v_kt IS NULL OR v_kt <= 0 THEN RAISE EXCEPTION 'kpi_target phải > 0'; END IF;
    -- 103: campaign khách — target là SỐ KHÁCH nguyên.
    IF v_metric_type = 'affiliate_customer_count' AND v_kt <> floor(v_kt) THEN
      RAISE EXCEPTION 'kpi_target phải là số nguyên dương (số khách) — nhận %', v_kt;
    END IF;
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

  DELETE FROM public.kpi_campaign_store_actuals       WHERE campaign_id = p_campaign_id;
  DELETE FROM public.kpi_campaign_store_daily_actuals WHERE campaign_id = p_campaign_id;

  UPDATE public.kpi_campaigns SET updated_at = now() WHERE id = p_campaign_id;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.rpc_replace_campaign_targets(uuid, jsonb, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_replace_campaign_targets(uuid, jsonb, text, uuid)
  TO service_role;

-- ── J. Marker ───────────────────────────────────────────────────────────────
INSERT INTO public.app_migrations (version, name, notes)
VALUES ('103', 'kpi_campaign_affiliate_customer',
        'Metric affiliate_customer_count (Số khách Affiliate): CHECK metric_type mở rộng + customer_contract; affiliate_orders.account_id + index canary; actual_customer_count/affiliate_customer_count (DEFAULT 0); RPC rpc_aggregate_affiliate_customers (service_role, fail-closed completed_time + account_id, DISTINCT ON dedup toàn scope); redefine replace_actuals (branch metric — tầng chốt chống payload sai chiều) + activate (overlap customer active/paused + identity gate) + replace_targets (integer target); EXCLUDE excl_customer_campaign_overlap backstop race. Campaign GMV hành vi giữ nguyên từng byte. Rollback: header file 103.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau migration):
-- 1) Cột mới:
--    SELECT table_name, column_name, data_type FROM information_schema.columns
--    WHERE (table_name, column_name) IN (
--      ('affiliate_orders','account_id'),
--      ('kpi_campaign_store_actuals','actual_customer_count'),
--      ('kpi_campaign_store_daily_actuals','affiliate_customer_count'));  -- 3 rows
-- 2) Constraints:
--    SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid IN ('public.kpi_campaigns'::regclass,
--                       'public.kpi_campaign_store_actuals'::regclass,
--                       'public.kpi_campaign_store_daily_actuals'::regclass)
--      AND conname IN ('chk_kpi_campaigns_metric_type','chk_kpi_campaigns_customer_contract',
--                      'excl_customer_campaign_overlap','chk_ksa_customer_count_nonneg',
--                      'chk_kcda_customer_count_nonneg');
--    -- 5 rows; metric_type def chứa 'affiliate_customer_count'
-- 3) SELECT indexname FROM pg_indexes WHERE tablename='affiliate_orders'
--    AND indexname='idx_affiliate_orders_delivered_missing_account';  -- 1 row
-- 4) SELECT proname, prosecdef FROM pg_proc WHERE proname IN
--    ('rpc_aggregate_affiliate_customers','rpc_replace_campaign_actuals',
--     'rpc_activate_kpi_campaign','rpc_replace_campaign_targets');  -- 4 rows, prosecdef=t
-- 5) Grant matrix (cả 4 function trên):
--    SELECT p.proname,
--           has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon,
--           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
--           has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role
--    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public' AND p.proname IN
--      ('rpc_aggregate_affiliate_customers','rpc_replace_campaign_actuals',
--       'rpc_activate_kpi_campaign','rpc_replace_campaign_targets');
--    -- kỳ vọng anon=f / authenticated=f / service_role=t cho CẢ 4
-- 6) Smoke aggregate (mảng rỗng — không RAISE, trả 0):
--    SELECT public.rpc_aggregate_affiliate_customers('{}'::uuid[], now() - interval '1 day', now());
--    -- {"rows": [], "total_customers": 0, "cross_store_account_count": 0, "cross_store_sample": []}
-- 7) SELECT version, name FROM public.app_migrations WHERE version='103';  -- 1 row
-- 8) Campaign GMV không đổi hành vi: chạy webapp/scripts/qa-kpi-customer-103.mjs
--    (fixture is_test, cleanup finally) — legacy-payload GMV pass, payload
--    GMV vào campaign customer RAISE, dedup/tie-break/cross-store/biên ngày VN,
--    overlap activate, grants. ALL PASS mới đi tiếp.
-- 9) SAU DEPLOY + FULL SYNC (backfill): SELECT count(*) FROM affiliate_orders
--    WHERE source_active AND status_norm='delivered' AND account_id IS NULL;  -- 0
-- ============================================================================
