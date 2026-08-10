-- ============================================================================
-- 104_kpi_customer_phone_identity.sql
-- ⚠ DRAFT — CHƯA CHẠY cho tới khi stakeholder audit pass.
--
-- CONTRACT MỚI (stakeholder chốt 09/08 — THAY identity account_id):
--   customer_identity = normalized(order.customer_phone)   ← người MUA
--   ⛔ receiver_phone_number KHÔNG tham gia identity (đặt hộ sẽ gộp/tách sai).
-- Bằng chứng dữ liệu: 317/317 đơn có buyer phone hợp lệ · 233 khách duy nhất ·
-- không account nào nhiều phone · không phone nào nhiều account · 3 ca
-- cross-partner đều giải được bằng rule "đơn DELIVERED sớm nhất TRONG campaign
-- range + tập store target". ⇒ 14 đơn thiếu account_id KHÔNG còn là blocker
-- launch, chỉ còn diagnostic chất lượng nguồn.
--
-- Nội dung (KHÔNG đụng bảng/luồng GMV — zero-touch):
--   A. affiliate_orders += customer_phone_norm text NULL + CHECK định dạng
--      di động VN 10 số. App chuẩn hóa (lib/affiliate/phone.ts) — giá trị
--      không hợp lệ → NULL (không bao giờ ghi rác, không sập sync).
--   B. rpc_aggregate_affiliate_customers: dedup theo customer_phone_norm;
--      canary phone chỉ soi ĐƠN ĐỦ ĐIỀU KIỆN TRONG RANGE (contract #7);
--      canary completed_time GIỮ fail-closed toàn thời gian như 103;
--      account_id KHÔNG còn tham gia.
--   C. rpc_activate_kpi_campaign: identity gate đổi sang phone, scope =
--      campaign range (VN) ∩ target stores; thiếu account KHÔNG chặn.
--
-- Idempotent (chỉ DDL additive + CREATE OR REPLACE — KHÔNG đổi dữ liệu).
-- Sau khi chạy: deploy code mới → full sync backfill customer_phone_norm.
--
-- ROLLBACK:
--   CREATE OR REPLACE lại 2 RPC từ file 103 (bản account-identity);
--   ALTER TABLE public.affiliate_orders DROP CONSTRAINT IF EXISTS chk_affiliate_orders_phone_norm;
--   ALTER TABLE public.affiliate_orders DROP COLUMN IF EXISTS customer_phone_norm;
--   DELETE FROM public.app_migrations WHERE version = '104';
-- ============================================================================

BEGIN;

-- ── A. Cột identity + CHECK định dạng ───────────────────────────────────────
DO $$
DECLARE v_active text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '103') THEN
    RAISE EXCEPTION '104: thiếu migration nền 103 (schema customer campaign)';
  END IF;

  -- r1 (audit P2#6): migration ĐỔI SEMANTICS identity của RPC ngay lập tức
  -- (account → phone) trong khi cột customer_phone_norm còn TOÀN NULL (chưa
  -- backfill). Nếu đang có Customer Campaign ACTIVE, lượt sync kế sẽ RAISE
  -- fail-closed hàng loạt. Cutover PHẢI diễn ra khi không campaign khách nào
  -- active (hiện prod: flag=false, chỉ có campaign QA paused/is_test).
  -- r1.1 (audit P2#4): guard CHỈ áp cho lần CUTOVER ĐẦU — sau khi marker
  -- '104' đã ghi, file phải IDEMPOTENT đúng như header cam kết (re-run chỉ
  -- CREATE OR REPLACE lại RPC; cột đã backfill nên campaign active không còn
  -- rủi ro fail-closed hàng loạt).
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '104') THEN
    SELECT string_agg(name || ' (' || status || ')', ', ' ORDER BY name) INTO v_active
    FROM public.kpi_campaigns
    WHERE metric_type = 'affiliate_customer_count' AND status = 'active' AND archived_at IS NULL;
    IF v_active IS NOT NULL THEN
      RAISE EXCEPTION '104: còn Customer Campaign ĐANG ACTIVE [%] — pause/archive trước khi cutover identity (cột customer_phone_norm chưa backfill, sync sẽ fail-closed)', v_active;
    END IF;
  END IF;
END $$;

ALTER TABLE public.affiliate_orders
  ADD COLUMN IF NOT EXISTS customer_phone_norm text;

-- CHECK: NULL hợp lệ (đơn chưa có identity — canary lo); có giá trị thì PHẢI
-- đúng dạng di động VN 10 số. Postgres không có ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.affiliate_orders'::regclass
      AND conname = 'chk_affiliate_orders_phone_norm'
  ) THEN
    ALTER TABLE public.affiliate_orders
      ADD CONSTRAINT chk_affiliate_orders_phone_norm
      CHECK (customer_phone_norm IS NULL OR customer_phone_norm ~ '^0[35789][0-9]{8}$');
  END IF;
END $$;

COMMENT ON COLUMN public.affiliate_orders.customer_phone_norm IS
  'Identity khách campaign Số khách Affiliate (contract 09/08): buyer phone chuẩn hóa 0XXXXXXXXX. KHÔNG phải receiver phone. NULL = chưa có identity hợp lệ (fail-closed ở rpc_aggregate_affiliate_customers).';

-- ── B. RPC aggregate SỐ KHÁCH — identity PHONE ──────────────────────────────
-- Trả jsonb (giữ shape 103, đổi tên field cross-store cho đúng ngữ nghĩa):
--   { rows: [{store_id, vn_date, customer_count}], total_customers,
--     cross_store_customer_count, cross_store_sample: [phone ĐÃ MASK ≤10] }
-- Dedup: DISTINCT ON (customer_phone_norm) trong TOÀN scope campaign, đơn
-- DELIVERED sớm nhất thắng (tie-break order_id) → khách rơi vào (store, ngày
-- VN) của đơn thắng ⇒ SUM(daily) LUÔN = total_customers.
-- ⚠ PII: sample phone được MASK trong DB (0905***560) — chuỗi này đi vào
-- warning/log vận hành, không để lộ số đầy đủ.
-- FAIL-CLOSED:
--   · completed_time thiếu (toàn thời gian trong scope stores) → RAISE (giữ
--     nguyên hợp đồng 103 — thiếu mốc ngày là hỏng chính date basis).
--   · customer_phone_norm thiếu trên ĐƠN ĐỦ ĐIỀU KIỆN TRONG RANGE (delivered
--     + active + price>0 + completed_time ∈ [from,to)) → RAISE (contract #7:
--     chỉ chặn theo dữ liệu thực sự tham gia đếm — đơn ngoài range/giá ≤0
--     không tham gia nên không được chặn oan).
--   · account_id KHÔNG còn được kiểm ở bất kỳ đâu.
CREATE OR REPLACE FUNCTION public.rpc_aggregate_affiliate_customers(
  p_store_ids uuid[],
  p_from      timestamptz,
  p_to        timestamptz
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_missing_ct    integer;
  v_missing_phone integer;
  v_result        jsonb;
BEGIN
  IF p_store_ids IS NULL THEN
    RAISE EXCEPTION 'rpc_aggregate_affiliate_customers: p_store_ids NULL — contract nhận mảng store (rỗng được, NULL không)';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION 'rpc_aggregate_affiliate_customers: khoảng thời gian không hợp lệ (from phải TRƯỚC to, không NULL)';
  END IF;

  SELECT count(*) INTO v_missing_ct
  FROM public.affiliate_orders o
  WHERE o.source_active AND o.status_norm = 'delivered'
    AND o.store_id = ANY (p_store_ids) AND o.completed_time IS NULL;
  IF v_missing_ct > 0 THEN
    RAISE EXCEPTION 'rpc_aggregate_affiliate_customers: % đơn DELIVERED active thiếu completed_time trong các store yêu cầu — fail-closed, giữ snapshot KPI cũ', v_missing_ct;
  END IF;

  -- 104: canary IDENTITY = phone, chỉ trên đơn THỰC SỰ tham gia đếm.
  SELECT count(*) INTO v_missing_phone
  FROM public.affiliate_orders o
  WHERE o.source_active AND o.status_norm = 'delivered'
    AND o.store_id = ANY (p_store_ids)
    AND o.total_price > 0
    AND o.completed_time >= p_from AND o.completed_time < p_to
    AND o.customer_phone_norm IS NULL;
  IF v_missing_phone > 0 THEN
    RAISE EXCEPTION 'rpc_aggregate_affiliate_customers: % đơn DELIVERED đủ điều kiện trong kỳ thiếu số điện thoại khách hợp lệ (identity) — fail-closed, giữ snapshot KPI cũ', v_missing_phone;
  END IF;

  WITH qualifying AS (
    SELECT o.customer_phone_norm AS phone, o.store_id, o.completed_time, o.order_id
    FROM public.affiliate_orders o
    WHERE o.source_active AND o.status_norm = 'delivered'
      AND o.store_id = ANY (p_store_ids)
      AND o.total_price > 0
      AND o.completed_time >= p_from AND o.completed_time < p_to
      AND o.customer_phone_norm IS NOT NULL
  ),
  winners AS (
    SELECT DISTINCT ON (q.phone)
           q.phone, q.store_id,
           (q.completed_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS vn_date
    FROM qualifying q
    ORDER BY q.phone, q.completed_time ASC, q.order_id ASC
  ),
  daily AS (
    SELECT w.store_id, w.vn_date, count(*)::integer AS customer_count
    FROM winners w GROUP BY w.store_id, w.vn_date
  ),
  cross_store AS (
    SELECT q.phone FROM qualifying q
    GROUP BY q.phone HAVING count(DISTINCT q.store_id) > 1
  )
  SELECT jsonb_build_object(
    'rows', coalesce(
      (SELECT jsonb_agg(jsonb_build_object(
                'store_id', d.store_id, 'vn_date', d.vn_date, 'customer_count', d.customer_count)
              ORDER BY d.store_id, d.vn_date)
       FROM daily d), '[]'::jsonb),
    'total_customers', (SELECT count(*) FROM winners),
    'cross_store_customer_count', (SELECT count(*) FROM cross_store),
    'cross_store_sample', coalesce(
      (SELECT jsonb_agg(left(s.phone, 4) || '***' || right(s.phone, 3))
       FROM (SELECT cs.phone FROM cross_store cs ORDER BY cs.phone LIMIT 10) s), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.rpc_aggregate_affiliate_customers(uuid[], timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_aggregate_affiliate_customers(uuid[], timestamptz, timestamptz)
  TO service_role;

-- ── C. Activation gate — identity PHONE theo campaign range ─────────────────
-- Body 103 NGUYÊN VĂN, CHỈ đổi khối identity gate của nhánh customer:
--   · BỎ check account_id (thiếu account không còn chặn).
--   · THÊM check phone trên đơn ĐỦ ĐIỀU KIỆN trong [start_date, end_date] VN
--     ∩ target stores (dùng cùng biên half-open như vnDayRange app: từ 00:00
--     VN ngày start đến 00:00 VN ngày SAU end).
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
VALUES ('104', 'kpi_customer_phone_identity',
        'Identity campaign Số khách Affiliate đổi account_id → normalized buyer phone (contract 09/08). '
        || 'affiliate_orders.customer_phone_norm + CHECK di động VN; rpc_aggregate_affiliate_customers dedup theo phone '
        || '(canary phone CHỈ trên đơn đủ điều kiện trong kỳ, completed_time giữ fail-closed toàn thời gian, account_id '
        || 'không còn tham gia, cross_store_sample MASK PII); rpc_activate_kpi_campaign gate phone theo campaign range '
        || '∩ target stores. GMV zero-touch. Backfill: deploy code mới rồi chạy full Affiliate sync.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau migration):
-- 1) Cột + CHECK:
--    SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name='affiliate_orders' AND column_name='customer_phone_norm';   -- 1 row text
--    SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid='public.affiliate_orders'::regclass AND conname='chk_affiliate_orders_phone_norm';
-- 2) CHECK thực sự chặn (phải LỖI — chạy trong transaction rồi ROLLBACK):
--    BEGIN; UPDATE public.affiliate_orders SET customer_phone_norm='0281234567'
--    WHERE order_id = (SELECT min(order_id) FROM public.affiliate_orders); ROLLBACK;
--    -- kỳ vọng: ERROR ... chk_affiliate_orders_phone_norm
-- 3) SECDEF + grant matrix (anon=f, authenticated=f, service_role=t):
--    SELECT p.proname, p.prosecdef,
--           has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon,
--           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
--           has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role
--    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--    WHERE n.nspname='public' AND p.proname IN
--      ('rpc_aggregate_affiliate_customers','rpc_activate_kpi_campaign');
-- 4) Hardening RPC (2 câu PHẢI raise, 1 câu trả 0):
--    SELECT public.rpc_aggregate_affiliate_customers(NULL, now()-interval '1 day', now());
--    SELECT public.rpc_aggregate_affiliate_customers('{}'::uuid[], now(), now()-interval '1 day');
--    SELECT public.rpc_aggregate_affiliate_customers('{}'::uuid[], now()-interval '1 day', now());
--    -- {"rows": [], "total_customers": 0, "cross_store_customer_count": 0, "cross_store_sample": []}
-- 5) Source-text: RPC KHÔNG còn tham chiếu account_id:
--    SELECT count(*) AS acct_refs FROM pg_proc
--    WHERE proname='rpc_aggregate_affiliate_customers' AND prosrc LIKE '%account_id%';   -- 0
-- 6) Marker: SELECT version, name FROM public.app_migrations WHERE version='104';  -- 1 row
-- 7) SAU khi deploy code + chạy FULL Affiliate sync (backfill), coverage theo
--    25 OS store — kỳ vọng missing_phone = 0 (missing_account CHỈ diagnostic):
--    SELECT count(*) FILTER (WHERE o.customer_phone_norm IS NULL) AS missing_phone,
--           count(*) FILTER (WHERE o.account_id IS NULL)          AS missing_account_diagnostic
--    FROM public.affiliate_orders o
--    WHERE o.source_active AND o.status_norm='delivered' AND o.total_price > 0
--      AND o.store_id IN (SELECT id FROM public.stores WHERE store_type='os' AND is_active);
-- 8) Index: CHƯA thêm index mới cho phone — sau backfill chạy
--    EXPLAIN (ANALYZE, BUFFERS) aggregate 31 ngày × 25 store rồi mới quyết
--    (idx_affiliate_orders_store_completed_id của 099 dự kiến đủ ở quy mô này).
-- ============================================================================
