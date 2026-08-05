-- ============================================================================
-- 102_affiliate_fs_expansion.sql
-- ⚠ DRAFT — CHƯA CHẠY cho tới khi stakeholder audit pass. Khi được duyệt:
--   Disable cron pull-affiliate-orders + verify không có run 'running' →
--   chạy file này → verify → deploy code batch FS-expansion → dry-run +
--   real sync ×2 → enable lại cron. KHÔNG đổi data đơn hàng; chỉ mapping +
--   function + index. Idempotent, pg_safeupdate-safe.
--
-- Contract cuối (stakeholder 05-06/08):
--   · 25 mapping OS = whitelist có thẩm quyền — TUYỆT ĐỐI không đổi.
--   · MỌI mã ngoài whitelist = FS; FS được phép store_id NULL (đối tác không
--     phải cửa hàng thật — KHÔNG tạo store giả trong public.stores, tránh lọt
--     /stores //users /FS-Products/pickers).
--   · 8 mapping external hiện tại → partner_type='fs', GIỮ store_id NULL,
--     display_name bỏ tiền tố 'Đối tác ngoài: ' (trống → partner_code).
--   · Mã mới từ nguồn tự tạo mapping fs/NULL/active qua RPC ensure (cron gọi,
--     service_role; đã tồn tại → KHÔNG đụng, kể cả inactive).
--   · GMV/drill-down CHỈ DELIVERED + source_active theo completed_time.
--   · Drill-down FS partner: CHỈ Super Admin (OPS/SM/QLCH/Staff từ chối).
--
-- ⚠ HAZARD RE-RUN: sau 102, re-run 094/095/101 sẽ RAISE (checksum os/fs/
--   external + type-guard của các migration đó) — BY DESIGN, migration chỉ
--   chạy một lần theo app_migrations; không được re-run file cũ.
--
-- ROLLBACK:
--   1. Danh sách mã đã chuyển nằm trong notes app_migrations version='102' —
--      UPDATE public.affiliate_partner_mappings
--        SET partner_type='external',
--            display_name='Đối tác ngoài: '||partner_code
--      WHERE partner_code IN (<danh sách trong notes>);
--   2. DROP FUNCTION IF EXISTS public.rpc_ensure_fs_partner_mappings(text[]);
--      DROP FUNCTION IF EXISTS public.rpc_aggregate_affiliate_partner_gmv(text[], timestamptz, timestamptz);
--      DROP FUNCTION IF EXISTS public.rpc_list_affiliate_partner_orders(text, timestamptz, timestamptz, integer, timestamptz, uuid);
--   3. DROP INDEX IF EXISTS public.idx_affiliate_orders_partner_completed;
--   4. DELETE FROM public.app_migrations WHERE version = '102';
-- ============================================================================

BEGIN;

-- ── A. Preflight + chuyển external → fs (dynamic, count-gated) ──────────────
DO $$
DECLARE
  v_os  int; v_fs int; v_ext int;
  v_codes text;
BEGIN
  IF (SELECT count(*) FROM public.app_migrations
      WHERE version IN ('090','091','092','093','094','095','096','097','098','099','100','101')) <> 12 THEN
    RAISE EXCEPTION '102: thiếu migration nền — cần đủ 090..101 đã chạy';
  END IF;

  SELECT count(*) FILTER (WHERE partner_type='os'),
         count(*) FILTER (WHERE partner_type='fs'),
         count(*) FILTER (WHERE partner_type='external')
  INTO v_os, v_fs, v_ext
  FROM public.affiliate_partner_mappings;
  -- Trạng thái kỳ vọng đã verify 05/08: 25 OS + 2 FS (có store) + 8 external.
  IF v_os <> 25 OR v_fs <> 2 OR v_ext <> 8 THEN
    RAISE EXCEPTION '102: mapping hiện tại % os / % fs / % external — KHÁC kỳ vọng 25/2/8, DỪNG (kiểm tra tay trước khi chạy)', v_os, v_fs, v_ext;
  END IF;

  SELECT string_agg(partner_code, ', ' ORDER BY partner_code) INTO v_codes
  FROM public.affiliate_partner_mappings WHERE partner_type = 'external';

  -- Chuyển type + dọn display_name; GIỮ store_id (NULL) + is_active nguyên trạng.
  UPDATE public.affiliate_partner_mappings
  SET partner_type = 'fs',
      display_name = COALESCE(
        NULLIF(trim(regexp_replace(display_name, '^Đối tác ngoài:\s*', '')), ''),
        partner_code)
  WHERE partner_type = 'external';

  INSERT INTO public.app_migrations (version, name, notes)
  VALUES ('102', 'affiliate_fs_expansion',
          'FS-expansion: chuyển external→fs (store_id NULL giữ nguyên) cho: ' || v_codes
          || '. RPC mới: ensure_fs_partner_mappings (auto-create mã mới, service_role) + aggregate_affiliate_partner_gmv (service_role) + list_affiliate_partner_orders (authenticated, tự authz SUPER-only). Index keyset partner. 25 OS whitelist không đổi. Rollback: xem header file 102.')
  ON CONFLICT (version) DO NOTHING;
END $$;

-- ── B. Index keyset cho FS partner (mirror idx store 092) ───────────────────
CREATE INDEX IF NOT EXISTS idx_affiliate_orders_partner_completed
  ON public.affiliate_orders (partner_code, completed_time DESC, id DESC)
  WHERE source_active AND status_norm = 'delivered';

-- ── C. RPC auto-create mapping FS cho mã mới ────────────────────────────────
-- Cron gọi TRƯỚC resolve khi gặp mã chưa có mapping; trả danh sách mã THỰC SỰ
-- được tạo (new_fs_codes cho report). Đã tồn tại → KHÔNG đụng (kể cả
-- inactive — inactive là lỗi vận hành, không tự bật). service_role only.
CREATE OR REPLACE FUNCTION public.rpc_ensure_fs_partner_mappings(p_codes text[])
RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code    text;
  v_created text[] := '{}';
BEGIN
  IF p_codes IS NULL OR array_length(p_codes, 1) IS NULL THEN
    RETURN v_created;
  END IF;
  FOREACH v_code IN ARRAY p_codes LOOP
    IF v_code IS NULL OR v_code !~ '^[A-Za-z0-9_-]{1,64}$' THEN
      RAISE EXCEPTION 'rpc_ensure_fs_partner_mappings: partner_code không hợp lệ: %', coalesce(v_code, 'NULL');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.affiliate_partner_mappings WHERE partner_code = v_code) THEN
      INSERT INTO public.affiliate_partner_mappings
        (partner_code, store_id, partner_type, display_name, is_active)
      VALUES (v_code, NULL, 'fs', v_code, true);
      v_created := v_created || v_code;
    END IF;
  END LOOP;
  RETURN v_created;
END $$;

REVOKE ALL ON FUNCTION public.rpc_ensure_fs_partner_mappings(text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_ensure_fs_partner_mappings(text[])
  TO service_role;

-- ── D. RPC aggregate GMV theo PARTNER_CODE (mirror 092, fail-closed) ────────
-- Không sửa rpc_aggregate_affiliate_gmv (store) — tránh regression OS/campaign.
CREATE OR REPLACE FUNCTION public.rpc_aggregate_affiliate_partner_gmv(
  p_codes text[],
  p_from  timestamptz,
  p_to    timestamptz
) RETURNS TABLE (partner_code text, vn_date date, gmv numeric, order_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing
  FROM public.affiliate_orders o
  WHERE o.source_active
    AND o.status_norm = 'delivered'
    AND o.partner_code = ANY (p_codes)
    AND o.completed_time IS NULL;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'rpc_aggregate_affiliate_partner_gmv: % đơn DELIVERED active thiếu completed_time trong các partner yêu cầu — fail-closed', v_missing;
  END IF;

  RETURN QUERY
  SELECT o.partner_code,
         (o.completed_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS vn_date,
         SUM(o.total_price)                                       AS gmv,
         count(*)::integer                                        AS order_count
  FROM public.affiliate_orders o
  WHERE o.source_active
    AND o.status_norm = 'delivered'
    AND o.partner_code = ANY (p_codes)
    AND o.completed_time >= p_from
    AND o.completed_time <  p_to
  GROUP BY o.partner_code, 2;
END $$;

REVOKE ALL ON FUNCTION public.rpc_aggregate_affiliate_partner_gmv(text[], timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_aggregate_affiliate_partner_gmv(text[], timestamptz, timestamptz)
  TO service_role;

-- ── E. RPC drill-down theo PARTNER_CODE — SUPER-ONLY (mirror guards 099) ────
CREATE OR REPLACE FUNCTION public.rpc_list_affiliate_partner_orders(
  p_partner_code          text,
  p_from                  timestamptz,
  p_to                    timestamptz,
  p_limit                 integer     DEFAULT 50,
  p_cursor_completed_time timestamptz DEFAULT NULL,
  p_cursor_id             uuid        DEFAULT NULL
) RETURNS TABLE (
  id                uuid,
  pos_order_code    text,
  sale_order_status text,
  partner_code      text,
  status_norm       text,
  total_price       numeric,
  customer_name     text,
  customer_phone    text,
  created_time      timestamptz,
  completed_time    timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 50);
BEGIN
  IF p_partner_code IS NULL OR p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'Thiếu tham số';
  END IF;
  IF NOT isfinite(p_from) OR NOT isfinite(p_to) THEN
    RAISE EXCEPTION 'Khoảng thời gian không hợp lệ';
  END IF;
  IF p_from >= p_to THEN
    RAISE EXCEPTION 'Khoảng thời gian không hợp lệ: from phải trước to';
  END IF;
  IF p_to - p_from > interval '366 days' THEN
    RAISE EXCEPTION 'Khoảng thời gian vượt giới hạn 366 ngày';
  END IF;
  IF (p_cursor_completed_time IS NULL) <> (p_cursor_id IS NULL) THEN
    RAISE EXCEPTION 'Cursor không hợp lệ';
  END IF;
  -- Contract 06/08: FS partner (store_id NULL) CHỈ Super Admin xem raw detail.
  IF NOT (SELECT public.is_super_admin()) THEN
    RAISE EXCEPTION 'Không có quyền xem đơn Affiliate của đối tác này';
  END IF;

  RETURN QUERY
  SELECT o.id, o.pos_order_code, o.sale_order_status, o.partner_code, o.status_norm,
         o.total_price, o.customer_name, o.customer_phone, o.created_time, o.completed_time
  FROM public.affiliate_orders o
  WHERE o.partner_code = p_partner_code
    AND o.source_active
    AND o.status_norm = 'delivered'
    AND o.completed_time >= p_from
    AND o.completed_time <  p_to
    AND (p_cursor_completed_time IS NULL
         OR (o.completed_time, o.id) < (p_cursor_completed_time, p_cursor_id))
  ORDER BY o.completed_time DESC, o.id DESC
  LIMIT v_limit;
END $$;

REVOKE ALL ON FUNCTION public.rpc_list_affiliate_partner_orders(text, timestamptz, timestamptz, integer, timestamptz, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_list_affiliate_partner_orders(text, timestamptz, timestamptz, integer, timestamptz, uuid)
  TO authenticated, service_role;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau migration):
-- 1) SELECT partner_type, count(*) FROM public.affiliate_partner_mappings
--    GROUP BY 1 ORDER BY 1;                       -- fs=10, os=25 (external=0)
-- 2) SELECT partner_code, display_name FROM public.affiliate_partner_mappings
--    WHERE partner_type='fs' AND store_id IS NULL ORDER BY 1;  -- 8 mã, tên sạch tiền tố
-- 3) SELECT version, name FROM public.app_migrations WHERE version='102';  -- 1 row (notes chứa 8 mã)
-- 4) SELECT proname, prosecdef FROM pg_proc WHERE proname IN
--    ('rpc_ensure_fs_partner_mappings','rpc_aggregate_affiliate_partner_gmv','rpc_list_affiliate_partner_orders');
--    -- 3 rows, prosecdef=t
-- 5) Grant matrix: ensure + aggregate → anon=f/authenticated=f/service_role=t;
--    list_partner_orders → anon=f/authenticated=t/service_role=t.
-- 6) SELECT indexname FROM pg_indexes WHERE tablename='affiliate_orders'
--    AND indexname='idx_affiliate_orders_partner_completed';   -- 1 row
-- 7) QA PostgREST theo role (POST /rest/v1/rpc/rpc_list_affiliate_partner_orders):
--    super → rows/0-rows OK; OPS/SM/QLCH/staff → 'Không có quyền'.
-- 8) Đối soát 8 mã lịch sử: tổng qua RPC aggregate partner (toàn dải thời
--    gian) == 96 DELIVERED / 34.192.580đ (số preflight 05/08).
-- ============================================================================
