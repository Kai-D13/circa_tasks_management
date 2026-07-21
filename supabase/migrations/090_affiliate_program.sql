-- ============================================================================
-- 090: AFFILIATE PROGRAM — orders synced from Circa Online MongoDB
-- ============================================================================
-- ⚠ DRAFT — KHÔNG chạy trên Supabase cho tới khi stakeholder audit RLS/role
--   matrix lần cuối (plan: docs/plan-affiliate-program.md v2.1).
--
-- Thay thế chương trình Referral (đã ngưng — bảng staff_referrals GIỮ NGUYÊN).
-- Nguồn: MongoDB circa-online_prd_order.order, marker = affiliate_partner_code
-- non-empty; cron server-only upsert theo order_id (write = service role).
--
-- 4 bảng (TẤT CẢ enable RLS, authenticated CHỈ SELECT — không write policy):
--   affiliate_partner_mappings   partner_code → store (seed từ manifest
--                                docs/affiliate-partner-manifest.md, checksum
--                                22 code = 14 os + 1 fs + 7 external)
--   affiliate_orders             đơn đã đồng bộ (store_id NULL = đối tác ngoài)
--   affiliate_sync_runs          audit mỗi lần cron (partial-unique 1 running)
--   affiliate_department_access  bật quyền xem cho admin theo phòng ban bằng
--                                1 lệnh INSERT (dự kiến: OPS
--                                1b362298-7121-4604-9192-4a9ca2bb545f) — không
--                                cần deploy
--
-- RLS matrix (FS + đối tác ngoài CHỈ super — audit P1):
--   super admin        → tất cả (OS + FS + external NULL-store)
--   admin dept được cấp→ CHỈ mapped OS (is_affiliate_dept_admin + is_os_store)
--   sm                 → assigned stores AND is_os_store
--   staff/store_manager→ own store AND is_os_store (staff FS bị chặn tại DB —
--                        store của họ không phải OS; KHÔNG cần helper FS mới)
-- Helpers tái dùng: is_super_admin (046), get_user_role/get_user_store_id
-- (001/038), is_sm_for_store (045), is_os_store (085 — SECDEF, đã GRANT).
-- Helper MỚI (một chiều, không recursion): is_affiliate_dept_admin().
--
-- Idempotent · pg_safeupdate-safe (mọi UPDATE có WHERE) · rollback = DROP 4
-- bảng + 2 function mới (không đụng bảng/helper cũ).
-- ============================================================================

BEGIN;

-- ── Helper: admin thuộc phòng ban được cấp quyền affiliate ──────────────────
CREATE OR REPLACE FUNCTION public.is_affiliate_dept_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.affiliate_department_access a ON a.department_id = u.department_id
    WHERE u.id = auth.uid()
  )
$$;

-- ── 1. affiliate_department_access (bảng lá — tạo TRƯỚC vì helper tham chiếu) ─
CREATE TABLE IF NOT EXISTS public.affiliate_department_access (
  department_id uuid PRIMARY KEY REFERENCES public.departments(id) ON DELETE CASCADE,
  granted_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  granted_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.affiliate_department_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ada_select_super ON public.affiliate_department_access;
CREATE POLICY ada_select_super ON public.affiliate_department_access
  FOR SELECT TO authenticated
  USING ((SELECT public.is_super_admin()));
-- Không write policy — INSERT/DELETE bằng SQL editor/service role.

GRANT EXECUTE ON FUNCTION public.is_affiliate_dept_admin() TO authenticated;

-- ── 2. affiliate_partner_mappings ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.affiliate_partner_mappings (
  partner_code text PRIMARY KEY,
  store_id     uuid REFERENCES public.stores(id) ON DELETE SET NULL, -- NULL = đối tác ngoài
  partner_type text NOT NULL DEFAULT 'external'
               CHECK (partner_type IN ('os','fs','external')),
  display_name text NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  mapped_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  mapped_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.affiliate_partner_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS apm_select_super ON public.affiliate_partner_mappings;
CREATE POLICY apm_select_super ON public.affiliate_partner_mappings
  FOR SELECT TO authenticated
  USING ((SELECT public.is_super_admin()));
-- Write qua service role/SQL (UI quản lý mapping = phase sau).

-- ── 3. affiliate_sync_runs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.affiliate_sync_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status           text NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','success','failed')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  pulled           int,
  upserted         int,
  deactivated      int,
  unmatched_codes  jsonb,
  unknown_statuses jsonb,
  error            text
);
ALTER TABLE public.affiliate_sync_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS asr_select_super ON public.affiliate_sync_runs;
CREATE POLICY asr_select_super ON public.affiliate_sync_runs
  FOR SELECT TO authenticated
  USING ((SELECT public.is_super_admin()));

-- Tối đa MỘT run 'running' ở tầng DB — xóa race SELECT-rồi-INSERT (audit P1).
CREATE UNIQUE INDEX IF NOT EXISTS uq_affiliate_sync_one_running
  ON public.affiliate_sync_runs ((true))
  WHERE status = 'running';

-- ── 4. affiliate_orders ─────────────────────────────────────────────────────
-- KHÔNG lưu: admin_note/system_note/payment payload/địa chỉ đầy đủ (audit P2).
CREATE TABLE IF NOT EXISTS public.affiliate_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           bigint NOT NULL UNIQUE,          -- source id (khóa upsert)
  order_code         text,                            -- DH…
  pos_order_code     text,                            -- DHC…
  partner_code       text NOT NULL,
  store_id           uuid REFERENCES public.stores(id) ON DELETE SET NULL,
  raw_status         text NOT NULL,                   -- nguyên văn từ nguồn
  status_norm        text NOT NULL DEFAULT 'other',   -- normalize app-level; giá trị lạ → 'other'
  sale_order_status  text,                            -- lớp giao vận, tham khảo
  total_price        numeric NOT NULL DEFAULT 0,
  total_item         int,
  first_product_name text,
  customer_name      text,
  customer_phone     text,
  created_time       timestamptz NOT NULL,
  confirmed_time     timestamptz,
  last_updated_time  timestamptz,
  -- Đơn biến mất khỏi nguồn (bị xóa / partner_code bị clear): đánh dấu, KHÔNG
  -- hard-delete (audit P1). Chỉ set false sau khi cursor chạy trọn + safety floor.
  last_seen_run_id   uuid REFERENCES public.affiliate_sync_runs(id) ON DELETE SET NULL,
  source_active      boolean NOT NULL DEFAULT true,
  synced_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.affiliate_orders ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_affiliate_orders_store_time
  ON public.affiliate_orders (store_id, created_time DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_orders_partner_time
  ON public.affiliate_orders (partner_code, created_time DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_orders_raw_status
  ON public.affiliate_orders (raw_status);

DROP POLICY IF EXISTS aff_orders_select ON public.affiliate_orders;
CREATE POLICY aff_orders_select ON public.affiliate_orders
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_super_admin())
    OR (
      (SELECT public.get_user_role()) = 'admin'
      AND (SELECT public.is_affiliate_dept_admin())
      AND store_id IS NOT NULL
      AND public.is_os_store(store_id)
    )
    OR (
      (SELECT public.get_user_role()) = 'sm'
      AND public.is_sm_for_store(store_id)
      AND public.is_os_store(store_id)
    )
    OR (
      (SELECT public.get_user_role()) IN ('staff','store_manager')
      AND store_id = (SELECT public.get_user_store_id())
      AND public.is_os_store(store_id)
    )
  );
-- Không INSERT/UPDATE/DELETE policy — write DUY NHẤT qua service role (cron).

-- ── 5. RPC: acquire sync lease (atomic, race-safe — audit P1) ───────────────
CREATE OR REPLACE FUNCTION public.rpc_start_affiliate_sync()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  -- Đóng run treo (crash giữa chừng) để lease không kẹt vĩnh viễn.
  UPDATE public.affiliate_sync_runs
     SET status = 'failed',
         error = 'stale: run quá 15 phút không kết thúc',
         finished_at = now()
   WHERE status = 'running'
     AND started_at < now() - interval '15 minutes';

  BEGIN
    INSERT INTO public.affiliate_sync_runs (status) VALUES ('running')
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN NULL; -- run khác đang chạy → caller trả 409
  END;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.rpc_start_affiliate_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_start_affiliate_sync() TO service_role;

-- ── 6. Seed mappings theo stores.code (manifest checksum 22 — KHÔNG seed theo
--       tên; RAISE nếu code không tồn tại hoặc store_type lệch mapping_type) ─
DO $$
DECLARE
  r record;
  v_store uuid;
  v_type  text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- 14 OS (docs/affiliate-partner-manifest.md)
      ('CIRCA-AKARI',          'os', 'POS0080', 'CIRCA AKARI'),
      ('CIRCA-BEVERLY',        'os', 'POS0058', 'CIRCA BEVERLY'),
      ('CIRCA-CELADON',        'os', 'POS0067', 'CIRCA CELADON'),
      ('CIRCA-CENTRAL',        'os', 'POS0009', 'CIRCA CENTRAL'),
      ('CIRCA-ECOGREEN',       'os', 'POS0073', 'CIRCA ECO GREEN'),
      ('CIRCA-ELARA',          'os', 'POS0015', 'CIRCA ELANA'), -- QA tay DH023275/DHC01024385 (21/07)
      ('CIRCA-FLORITA',        'os', 'POS0068', 'CIRCA FLORITA'),
      ('CIRCA-LUMINA',         'os', 'POS0012', 'CIRCA LUMINA'),
      ('CIRCA-MEDLY',          'os', 'POS0063', 'CIRCA MEDLY'),
      ('CIRCA-MIRA',           'os', 'POS0019', 'CIRCA MIRA'),
      ('CIRCA-PHARMAONE',      'os', 'POS0066', 'CIRCA PHARMA ONE'),
      ('CIRCA-SUNRISE',        'os', 'POS0014', 'CIRCA SUNRISE'),
      ('CIRCA-SYMPHONY',       'os', 'POS0065', 'CIRCA SYMPHONY'),
      ('CIRCA-TAMVIET',        'os', 'POS0059', 'CIRCA TAM VIET'),
      -- 1 FS (chỉ super xem — RLS chặn các role khác)
      ('CIRCA-HOABINH2',       'fs', 'POS0088', 'FS Hòa Bình 2'),
      -- 7 đối tác ngoài (store_id NULL — chỉ super xem)
      ('CIRCA-ONG-CHU-5',      'external', NULL, 'Đối tác ngoài: CIRCA-ONG-CHU-5'),
      ('CIRCA-MYHANH',         'external', NULL, 'Đối tác ngoài: CIRCA-MYHANH'),
      ('CIRCA-YENMAI-TAYNINH', 'external', NULL, 'Đối tác ngoài: CIRCA-YENMAI-TAYNINH'),
      ('NT-NGOC-VY',           'external', NULL, 'Đối tác ngoài: NT-NGOC-VY'),
      ('NT-BAO-TRAN',          'external', NULL, 'Đối tác ngoài: NT-BAO-TRAN'),
      ('NT THIÊN',             'external', NULL, 'Đối tác ngoài: NT THIÊN'),
      ('HOTEL-DN-LDH',         'external', NULL, 'Đối tác ngoài: HOTEL-DN-LDH')
    ) AS m(partner_code, mapping_type, store_code, display_name)
  LOOP
    IF r.mapping_type = 'external' THEN
      INSERT INTO public.affiliate_partner_mappings (partner_code, store_id, partner_type, display_name)
      VALUES (r.partner_code, NULL, 'external', r.display_name)
      ON CONFLICT (partner_code) DO NOTHING;
    ELSE
      SELECT id, store_type INTO v_store, v_type
      FROM public.stores WHERE code = r.store_code;
      IF v_store IS NULL THEN
        RAISE EXCEPTION 'affiliate seed: store code % (cho partner %) không tồn tại', r.store_code, r.partner_code;
      END IF;
      IF v_type IS DISTINCT FROM r.mapping_type THEN
        RAISE EXCEPTION 'affiliate seed: store % có store_type=% nhưng manifest ghi %', r.store_code, v_type, r.mapping_type;
      END IF;
      INSERT INTO public.affiliate_partner_mappings (partner_code, store_id, partner_type, display_name)
      VALUES (r.partner_code, v_store, r.mapping_type, r.display_name)
      ON CONFLICT (partner_code) DO NOTHING;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM public.affiliate_partner_mappings) < 22 THEN
    RAISE EXCEPTION 'affiliate seed: mapping count % < 22 (manifest checksum)',
      (SELECT count(*) FROM public.affiliate_partner_mappings);
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('090', 'affiliate_program',
        'Affiliate thay Referral: 4 bảng (orders/mappings/sync_runs/dept_access) + is_affiliate_dept_admin + rpc_start_affiliate_sync (lease race-safe) + seed 22 mappings theo stores.code. RLS: FS + external chỉ super; các nhánh khác AND is_os_store. Nguồn: Mongo circa-online_prd_order.order.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau migration)
-- ============================================================================
-- 1) Cấu trúc:
--   SELECT count(*) FROM public.affiliate_partner_mappings;                -- = 22
--   SELECT partner_type, count(*) FROM public.affiliate_partner_mappings
--     GROUP BY 1 ORDER BY 1;                                               -- external=7, fs=1, os=14
--   SELECT count(*) FROM pg_policies WHERE tablename LIKE 'affiliate%';    -- = 4 (mỗi bảng 1 SELECT)
--   SELECT relrowsecurity FROM pg_class
--     WHERE relname IN ('affiliate_orders','affiliate_partner_mappings',
--                       'affiliate_sync_runs','affiliate_department_access'); -- 4 × true
--   SELECT proname, prosecdef FROM pg_proc
--     WHERE proname IN ('is_affiliate_dept_admin','rpc_start_affiliate_sync'); -- đều prosecdef=true
--
-- 2) Lease race-safe:
--   SELECT public.rpc_start_affiliate_sync();  -- lần 1: trả uuid
--   SELECT public.rpc_start_affiliate_sync();  -- lần 2 (ngay sau): trả NULL
--   UPDATE public.affiliate_sync_runs SET status='success', finished_at=now()
--     WHERE status='running';                  -- dọn sau test
--
-- 3) QA Gate F1 — role matrix (đăng nhập từng role, PostgREST/SQL):
--   super          → SELECT * FROM affiliate_orders: thấy OS + FS + external(NULL)
--   admin (chưa cấp dept) → 0 rows; sau INSERT INTO affiliate_department_access
--     (department_id) VALUES ('1b362298-7121-4604-9192-4a9ca2bb545f') → CHỈ mapped OS
--   sm             → chỉ assigned OS stores
--   staff/QLCH OS  → chỉ own store
--   staff/QLCH FS  → 0 rows (is_os_store=false)
--   authenticated INSERT/UPDATE/DELETE trực tiếp → bị chặn (không write policy)
-- ============================================================================
