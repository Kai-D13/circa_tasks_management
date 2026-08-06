-- ============================================================================
-- 102_affiliate_fs_expansion.sql  (r1 — sau audit 06/08: 7 finding)
-- ⚠ DRAFT — CHƯA CHẠY cho tới khi stakeholder audit pass. Khi được duyệt:
--   Disable cron pull-affiliate-orders + verify affiliate_sync_runs không có
--   run status='running' → CHỤP SNAPSHOT ĐỘNG (SQL bên dưới) → chạy file này
--   → verify → deploy code batch FS-expansion → dry-run + real sync ×2 →
--   enable lại cron. KHÔNG đổi data đơn hàng; chỉ mapping + function + index.
--   ⚠ ONE-SHOT (audit r1 P2#6): KHÔNG idempotent — guard app_migrations ở đầu
--   fail-fast khi re-run (state sau lần 1 là 25 os/10 fs/0 external, gate
--   cấu trúc 25/2/8 sẽ không bao giờ pass lần 2 by design). pg_safeupdate-safe.
--
-- SNAPSHOT ĐỘNG TRƯỚC MIGRATION (audit r1 — KHÔNG dùng số cố định
-- 96/34.192.580đ vì data sống; lưu output để đối soát VERIFY #8):
--   SELECT m.partner_code,
--          count(o.id)  FILTER (WHERE o.source_active AND o.status_norm='delivered') AS delivered,
--          COALESCE(sum(o.total_price) FILTER (WHERE o.source_active AND o.status_norm='delivered'), 0) AS gmv
--   FROM public.affiliate_partner_mappings m
--   LEFT JOIN public.affiliate_orders o ON o.partner_code = m.partner_code
--   WHERE m.partner_type = 'external'
--   GROUP BY 1 ORDER BY 1;
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

-- ── A. Preflight (one-shot + CẤU TRÚC) + chuyển external → fs ───────────────
DO $$
DECLARE
  v_os int; v_os_ok int; v_fs int; v_fs_ok int; v_ext int; v_ext_null int;
  v_codes text;
BEGIN
  -- r1 P2#6: ONE-SHOT guard — đã có marker 102 = đã chạy; re-run fail-fast
  -- với thông điệp rõ (post-state kỳ vọng: 25 os / 10 fs / 0 external).
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '102') THEN
    RAISE EXCEPTION '102: ĐÃ CHẠY trước đó (one-shot migration, không re-run). Kiểm tra post-state bằng khối VERIFY cuối file (kỳ vọng 25 os / 10 fs / 0 external).';
  END IF;

  IF (SELECT count(*) FROM public.app_migrations
      WHERE version IN ('090','091','092','093','094','095','096','097','098','099','100','101')) <> 12 THEN
    RAISE EXCEPTION '102: thiếu migration nền — cần đủ 090..101 đã chạy';
  END IF;

  -- r1 P1#2: preflight CẤU TRÚC, không chỉ đếm — 25/2/8 count-only vẫn pass
  -- khi OS trỏ nhầm store FS/inactive/NULL, external có store, FS trỏ sai
  -- loại store. Kỳ vọng đã verify 05/08:
  --   25 OS       → store_id NON-NULL → stores.store_type='os' → is_active
  --    2 FS-store → store_id NON-NULL → stores.store_type='fs' → is_active
  --    8 external → store_id NULL
  SELECT count(*) FILTER (WHERE m.partner_type = 'os'),
         count(*) FILTER (WHERE m.partner_type = 'os'
                            AND s.id IS NOT NULL AND s.store_type = 'os' AND s.is_active),
         count(*) FILTER (WHERE m.partner_type = 'fs'),
         count(*) FILTER (WHERE m.partner_type = 'fs'
                            AND s.id IS NOT NULL AND s.store_type = 'fs' AND s.is_active),
         count(*) FILTER (WHERE m.partner_type = 'external'),
         count(*) FILTER (WHERE m.partner_type = 'external' AND m.store_id IS NULL)
  INTO v_os, v_os_ok, v_fs, v_fs_ok, v_ext, v_ext_null
  FROM public.affiliate_partner_mappings m
  LEFT JOIN public.stores s ON s.id = m.store_id;

  IF v_os <> 25 OR v_os_ok <> 25 THEN
    RAISE EXCEPTION '102: OS mapping % total / % đạt cấu trúc (store non-null + store_type=os + active) — kỳ vọng 25/25, DỪNG (kiểm tra tay)', v_os, v_os_ok;
  END IF;
  IF v_fs <> 2 OR v_fs_ok <> 2 THEN
    RAISE EXCEPTION '102: FS mapping % total / % đạt cấu trúc (store non-null + store_type=fs + active) — kỳ vọng 2/2, DỪNG (kiểm tra tay)', v_fs, v_fs_ok;
  END IF;
  IF v_ext <> 8 OR v_ext_null <> 8 THEN
    RAISE EXCEPTION '102: external mapping % total / % có store_id NULL — kỳ vọng 8/8, DỪNG (kiểm tra tay)', v_ext, v_ext_null;
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

  -- One-shot guard ở trên đảm bảo marker chưa tồn tại → INSERT trần (lỗi
  -- logic sẽ nổ to thay vì bị ON CONFLICT nuốt).
  INSERT INTO public.app_migrations (version, name, notes)
  VALUES ('102', 'affiliate_fs_expansion',
          'FS-expansion: chuyển external→fs (store_id NULL giữ nguyên) cho: ' || v_codes
          || '. RPC mới: ensure_fs_partner_mappings (auto-create mã mới, service_role) + aggregate_affiliate_partner_gmv (service_role) + list_affiliate_partner_orders (authenticated, tự authz SUPER-only). Index keyset partner. 25 OS whitelist không đổi. Rollback: xem header file 102.');
END $$;

-- ── B. Index keyset cho FS partner (mirror idx store 092) ───────────────────
CREATE INDEX IF NOT EXISTS idx_affiliate_orders_partner_completed
  ON public.affiliate_orders (partner_code, completed_time DESC, id DESC)
  WHERE source_active AND status_norm = 'delivered';

-- ── C. RPC auto-create mapping FS cho mã mới ────────────────────────────────
-- Cron gọi TRƯỚC resolve khi gặp mã chưa có mapping; trả danh sách mã THỰC SỰ
-- được tạo (new_fs_codes cho report). Đã tồn tại → KHÔNG đụng (kể cả
-- inactive — inactive là lỗi vận hành, không tự bật). service_role only.
-- r1 P1#1: validate theo CONTRACT CHUNG với app (isValidPartnerCode,
-- lib/affiliate/normalize.ts) — production có mã space/Unicode ('NT THIÊN'),
-- regex ASCII cũ loại nhầm dữ liệu thật. Luật: không NULL/rỗng, đã trim,
-- ≤64 ký tự, không control character. Arg parameterized → không cần ASCII
-- whitelist để chống injection.
-- r1 P2#5: INSERT ... ON CONFLICT DO NOTHING (partner_code = PRIMARY KEY,
-- mig 090) thay check-then-insert — RPC tự an toàn trước race dù lease cron
-- đã giảm xác suất; FOUND=false khi row đã tồn tại → không tính vào created.
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
    IF v_code IS NULL OR v_code = '' OR v_code <> btrim(v_code)
       OR char_length(v_code) > 64 OR v_code ~ '[\x01-\x1F\x7F]' THEN
      RAISE EXCEPTION 'rpc_ensure_fs_partner_mappings: partner_code không hợp lệ (NULL/rỗng/chưa trim/quá 64 ký tự/control char): %', coalesce(v_code, 'NULL');
    END IF;
    INSERT INTO public.affiliate_partner_mappings
      (partner_code, store_id, partner_type, display_name, is_active)
    VALUES (v_code, NULL, 'fs', v_code, true)
    ON CONFLICT (partner_code) DO NOTHING;
    IF FOUND THEN
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
-- 8) Đối soát 8 mã lịch sử (r1: theo SNAPSHOT ĐỘNG chụp TRƯỚC migration —
--    KHÔNG dùng số cố định, data sống): chạy lại chính SQL snapshot ở header
--    (đổi WHERE thành partner_type='fs' AND store_id IS NULL) — từng mã phải
--    KHỚP TUYỆT ĐỐI delivered/gmv với snapshot (migration không đụng orders).
-- 9) Verify CẤU TRÚC sau chạy (mirror preflight):
--    SELECT count(*) FILTER (WHERE m.partner_type='os'  AND s.store_type='os' AND s.is_active) AS os_ok,   -- 25
--           count(*) FILTER (WHERE m.partner_type='fs'  AND m.store_id IS NOT NULL
--                              AND s.store_type='fs' AND s.is_active)                          AS fs_store, -- 2
--           count(*) FILTER (WHERE m.partner_type='fs'  AND m.store_id IS NULL)                AS fs_null,  -- 8
--           count(*) FILTER (WHERE m.partner_type='external')                                  AS ext       -- 0
--    FROM public.affiliate_partner_mappings m LEFT JOIN public.stores s ON s.id = m.store_id;
-- ============================================================================
