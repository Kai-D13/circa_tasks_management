-- ============================================================================
-- 099_affiliate_orders_drilldown.sql
-- ⚠ DRAFT — CHƯA CHẠY cho tới khi stakeholder audit pass. Khi được duyệt:
--   PHẢI chạy TRƯỚC khi deploy code drill-down (UI gọi RPC — thiếu function
--   là expand lỗi). Function-only, KHÔNG đổi schema/data — idempotent,
--   pg_safeupdate-safe.
--
-- Contract cuối (stakeholder 28/07) — Affiliate Order drill-down:
--   · Raw order detail cho Super Admin + Admin OPS + SM + Store Manager.
--     Staff + admin phòng khác: TỪ CHỐI.
--   · KHÔNG mở raw-table RLS cho OPS (mig 096 cố ý bảo vệ PII qua PostgREST
--     generic select) — thay bằng RPC WHITELIST cột cố định: OPS/SM/QLCH đọc
--     đơn qua RPC này, vẫn KHÔNG select trực tiếp affiliate_orders được
--     (aff_orders_select giữ nguyên 096).
--   · Filter CỐ ĐỊNH trong RPC: store yêu cầu + source_active + status_norm
--     'delivered' + completed_time ∈ [p_from, p_to) — child luôn đối soát
--     được với rpc_aggregate_affiliate_gmv (cùng điều kiện, cùng date basis).
--   · Keyset cursor (completed_time DESC, id DESC) ≤50 đơn/trang — không
--     offset; khớp index idx_affiliate_orders_store_completed (092).
--   · FS store: chỉ Super (scope hiện tại); OPS/SM/QLCH bị từ chối.
--
-- Grants ([[feedback_supabase_function_grants]]): anon/authenticated được
-- EXECUTE MẶC ĐỊNH trên function mới qua PUBLIC — REVOKE đích danh PUBLIC +
-- anon, GRANT authenticated (RPC tự authz theo auth.uid() bên trong) +
-- service_role.
--
-- ROLLBACK:
--   1. DROP FUNCTION IF EXISTS public.rpc_list_affiliate_orders(
--        uuid, timestamptz, timestamptz, integer, timestamptz, uuid);
--   2. DELETE FROM public.app_migrations WHERE version = '099';
-- ============================================================================

BEGIN;

-- ── Preflight ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT count(*) FROM public.app_migrations
      WHERE version IN ('090', '091', '092', '093', '094', '095', '096', '097')) <> 8 THEN
    RAISE EXCEPTION '099: thiếu migration nền affiliate — cần đủ 090..097 đã chạy';
  END IF;
END $$;

-- ── RPC whitelist: liệt kê đơn DELIVERED active của MỘT store, keyset ───────
-- SECURITY DEFINER (bypass RLS bảng) → authz NẰM TRONG function, dùng đúng bộ
-- helper SECDEF của aff_orders_select (096): is_super_admin /
-- is_affiliate_dept_admin / is_sm_for_store / get_user_store_id / is_os_store.
-- Trả ĐÚNG các field stakeholder chốt + id (cursor) — không payload khác.
CREATE OR REPLACE FUNCTION public.rpc_list_affiliate_orders(
  p_store_id              uuid,
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
  v_role    text    := (SELECT public.get_user_role());
  v_limit   integer := LEAST(GREATEST(coalesce(p_limit, 50), 1), 50);
  v_allowed boolean := false;
BEGIN
  IF p_store_id IS NULL OR p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'Thiếu tham số';
  END IF;
  -- Cursor phải đủ CẶP (completed_time + id) hoặc không có — nửa cặp là bug caller.
  IF (p_cursor_completed_time IS NULL) <> (p_cursor_id IS NULL) THEN
    RAISE EXCEPTION 'Cursor không hợp lệ';
  END IF;

  -- Scope theo contract 28/07. Thứ tự nhánh mirror aff_orders_select (090/096).
  IF (SELECT public.is_super_admin()) THEN
    v_allowed := true;                                   -- mọi store (gồm FS)
  ELSIF v_role = 'admin' AND (SELECT public.is_affiliate_dept_admin())
        AND public.is_os_store(p_store_id) THEN
    v_allowed := true;                                   -- OPS: toàn bộ OS
  ELSIF v_role = 'sm' AND public.is_sm_for_store(p_store_id)
        AND public.is_os_store(p_store_id) THEN
    v_allowed := true;                                   -- SM: OS được phân công
  ELSIF v_role = 'store_manager' AND p_store_id = (SELECT public.get_user_store_id())
        AND public.is_os_store(p_store_id) THEN
    v_allowed := true;                                   -- QLCH: OS store mình
  END IF;
  IF NOT v_allowed THEN
    -- Staff / admin phòng khác / store ngoài scope / FS với non-super:
    -- từ chối chung một message — không tiết lộ store tồn tại hay không.
    RAISE EXCEPTION 'Không có quyền xem đơn Affiliate của cửa hàng này';
  END IF;

  RETURN QUERY
  SELECT o.id, o.pos_order_code, o.sale_order_status, o.partner_code, o.status_norm,
         o.total_price, o.customer_name, o.customer_phone, o.created_time, o.completed_time
  FROM public.affiliate_orders o
  WHERE o.store_id = p_store_id
    AND o.source_active
    AND o.status_norm = 'delivered'
    AND o.completed_time >= p_from
    AND o.completed_time <  p_to
    AND (p_cursor_completed_time IS NULL
         OR (o.completed_time, o.id) < (p_cursor_completed_time, p_cursor_id))
  ORDER BY o.completed_time DESC, o.id DESC
  LIMIT v_limit;
END $$;

REVOKE ALL ON FUNCTION public.rpc_list_affiliate_orders(uuid, timestamptz, timestamptz, integer, timestamptz, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_list_affiliate_orders(uuid, timestamptz, timestamptz, integer, timestamptz, uuid)
  TO authenticated, service_role;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('099', 'affiliate_orders_drilldown',
        'Drill-down đơn Affiliate (contract 28/07): RPC whitelist rpc_list_affiliate_orders — SECDEF tự authz (Super mọi store · OPS admin OS-all · SM OS-assigned · QLCH OS-own · Staff/khác từ chối; FS chỉ Super); filter cố định delivered+source_active+completed_time ∈ [from,to) khớp aggregate; keyset (completed_time DESC, id DESC) ≤50/trang khớp index 092; trả đúng field chốt + id cursor. aff_orders_select GIỮ NGUYÊN 096 (OPS vẫn không select trực tiếp bảng). Grant authenticated + service_role, revoke PUBLIC/anon đích danh. CHẠY TRƯỚC khi deploy code drill-down.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau migration):
-- 1) SELECT proname, prosecdef FROM pg_proc WHERE proname = 'rpc_list_affiliate_orders';
--    -- 1 row, prosecdef = t
-- 2) Grant matrix:
--    SELECT has_function_privilege('anon',
--      'public.rpc_list_affiliate_orders(uuid,timestamptz,timestamptz,integer,timestamptz,uuid)', 'EXECUTE');          -- false
--    SELECT has_function_privilege('authenticated', '...cùng signature...', 'EXECUTE');                                 -- true
--    SELECT has_function_privilege('service_role',  '...cùng signature...', 'EXECUTE');                                 -- true
-- 3) QA PostgREST theo role (Bearer token từng account, POST /rest/v1/rpc/rpc_list_affiliate_orders):
--    · super: store OS bất kỳ → rows; store FS → rows (scope hiện tại).
--    · OPS admin: store OS → rows; store FS → lỗi 'Không có quyền'; đồng thời
--      GET /rest/v1/affiliate_orders vẫn 0 row (RLS 096 giữ nguyên).
--    · SM: store phân công → rows; store ngoài assignment → lỗi.
--    · QLCH: store mình → rows; store khác → lỗi.
--    · staff: mọi store → lỗi.
-- 4) Đối soát parent-child (1 store + 1 khoảng ngày có đơn, gồm đơn âm):
--    SUM(total_price) + COUNT qua các trang RPC == gmv/order_count từ
--    rpc_aggregate_affiliate_gmv cùng store + khoảng (cộng các vn_date).
-- 5) Keyset: trang 1 (50) + trang 2 (cursor = row cuối) không trùng/không sót id;
--    cursor nửa cặp (chỉ time hoặc chỉ id) → RAISE 'Cursor không hợp lệ'.
-- 6) app_migrations '099' = 1 row.
-- ============================================================================
