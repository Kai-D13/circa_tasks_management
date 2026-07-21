-- ============================================================================
-- 090: AFFILIATE PROGRAM — orders synced from Circa Online MongoDB  (F1 r1)
-- ============================================================================
-- ⚠ DRAFT — KHÔNG chạy trên Supabase cho tới khi stakeholder audit r1 pass
--   (plan: docs/plan-affiliate-program.md v2.1).
--
-- r1 (đóng 2 P1 + P2 audit F1):
--   • Thêm rpc_finish_affiliate_sync / rpc_fail_affiliate_sync — mark-missing
--     + safety-floor + đóng run trong CÙNG transaction ở DB boundary; F2 không
--     được UPDATE rời rạc bằng service role.
--   • total_price bỏ DEFAULT 0 (không che lỗi nguồn — row thiếu/sai số bị
--     reject ở F2 và ghi vào sync run, không upsert âm thầm).
--   • REVOKE PUBLIC trên helper; bảng dept_access tạo TRƯỚC helper; verify
--     nêu đích danh 4 bảng; seed preflight check store_type + is_active;
--     partial index (store_id, created_time DESC) WHERE source_active.
--
-- Thay thế chương trình Referral (đã ngưng — bảng staff_referrals GIỮ NGUYÊN).
-- Nguồn: MongoDB circa-online_prd_order.order, marker = affiliate_partner_code
-- non-empty; cron server-only upsert theo order_id (write = service role).
--
-- RLS matrix (FS + đối tác ngoài CHỈ super):
--   super admin        → tất cả (OS + FS + external NULL-store)
--   admin dept được cấp→ CHỈ mapped OS (is_affiliate_dept_admin + is_os_store)
--   sm                 → assigned stores AND is_os_store
--   staff/store_manager→ own store AND is_os_store (staff FS chặn tại DB)
-- Helpers tái dùng: is_super_admin (046), get_user_role/get_user_store_id
-- (001/038), is_sm_for_store (045), is_os_store (085 — SECDEF, đã GRANT).
--
-- Idempotent · pg_safeupdate-safe (mọi UPDATE có WHERE) · rollback = DROP 4
-- bảng + 4 function mới (không đụng bảng/helper cũ).
-- ============================================================================

BEGIN;

-- ── 1. affiliate_department_access (bảng lá — TRƯỚC helper để dependency rõ) ─
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
-- Bật cho phòng OPS sau này (không cần deploy):
--   INSERT INTO public.affiliate_department_access (department_id)
--   VALUES ('1b362298-7121-4604-9192-4a9ca2bb545f');

-- ── 2. Helper: admin thuộc phòng ban được cấp quyền affiliate ───────────────
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
REVOKE ALL ON FUNCTION public.is_affiliate_dept_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_affiliate_dept_admin() TO authenticated;

-- ── 3. affiliate_partner_mappings ───────────────────────────────────────────
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

-- ── 4. affiliate_sync_runs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.affiliate_sync_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status           text NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','success','failed')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  pulled           int,
  upserted         int,
  deactivated      int,
  rejected         int,               -- row nguồn không hợp lệ (thiếu/sai total_price…)
  unmatched_codes  jsonb,
  unknown_statuses jsonb,
  note             text,              -- cảnh báo không chặn (vd safety floor bỏ qua mark-missing)
  error            text               -- lỗi rút gọn khi failed
);
ALTER TABLE public.affiliate_sync_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS asr_select_super ON public.affiliate_sync_runs;
CREATE POLICY asr_select_super ON public.affiliate_sync_runs
  FOR SELECT TO authenticated
  USING ((SELECT public.is_super_admin()));

-- Tối đa MỘT run 'running' ở tầng DB — xóa race SELECT-rồi-INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS uq_affiliate_sync_one_running
  ON public.affiliate_sync_runs ((true))
  WHERE status = 'running';

-- ── 5. affiliate_orders ─────────────────────────────────────────────────────
-- KHÔNG lưu: admin_note/system_note/payment payload/địa chỉ đầy đủ (audit P2).
-- total_price KHÔNG default (audit F1 P1): nguồn thiếu/sai số → F2 reject row
-- + ghi vào sync run — không bao giờ ghi doanh số 0 âm thầm.
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
  total_price        numeric NOT NULL,                -- KHÔNG default — xem chú thích trên
  total_item         int,
  first_product_name text,
  customer_name      text,
  customer_phone     text,
  created_time       timestamptz NOT NULL,
  confirmed_time     timestamptz,
  last_updated_time  timestamptz,
  -- Đơn biến mất khỏi nguồn: đánh dấu qua rpc_finish (safety floor trong DB),
  -- KHÔNG hard-delete.
  last_seen_run_id   uuid REFERENCES public.affiliate_sync_runs(id) ON DELETE SET NULL,
  source_active      boolean NOT NULL DEFAULT true,
  synced_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.affiliate_orders ENABLE ROW LEVEL SECURITY;

-- Partial index khớp query thật (mọi màn chỉ đọc source_active=true).
CREATE INDEX IF NOT EXISTS idx_affiliate_orders_store_time_active
  ON public.affiliate_orders (store_id, created_time DESC)
  WHERE source_active;
CREATE INDEX IF NOT EXISTS idx_affiliate_orders_partner_time_active
  ON public.affiliate_orders (partner_code, created_time DESC)
  WHERE source_active;
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

-- ── 6. Sync lease RPCs (vòng đời run TRỌN VẸN ở DB boundary — audit F1 P1) ──
-- start → (upsert từng batch bằng service role, gắn last_seen_run_id=run)
--       → finish (mark-missing + safety floor + đóng run, CÙNG transaction)
--       hoặc fail (đóng run lỗi, KHÔNG BAO GIỜ đụng source_active).

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

-- Hoàn tất run: CHỈ chấp nhận đúng run đang 'running' (đúng lease); safety
-- floor enforce TRONG DB: chỉ mark-missing khi pulled ≥ 50% số đơn active
-- hiện có (chống mass-deactivate do pull hụt/cursor đứt — caller cũng chỉ
-- được gọi finish sau khi cursor Mongo hoàn tất trọn vẹn).
CREATE OR REPLACE FUNCTION public.rpc_finish_affiliate_sync(
  p_run_id   uuid,
  p_pulled   int,
  p_upserted int,
  p_rejected int DEFAULT 0,
  p_unmatched jsonb DEFAULT NULL,
  p_unknown   jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active_before bigint;
  v_deactivated   int := 0;
  v_note          text := NULL;
BEGIN
  -- Xác nhận đúng run đang giữ lease — sai/đã đóng → RAISE, không ghi gì.
  PERFORM 1 FROM public.affiliate_sync_runs
   WHERE id = p_run_id AND status = 'running'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rpc_finish_affiliate_sync: run % không tồn tại hoặc không ở trạng thái running', p_run_id;
  END IF;

  SELECT count(*) INTO v_active_before
    FROM public.affiliate_orders WHERE source_active;

  IF p_pulled >= GREATEST(1, floor(v_active_before * 0.5)::int) THEN
    UPDATE public.affiliate_orders
       SET source_active = false, synced_at = now()
     WHERE source_active
       AND (last_seen_run_id IS DISTINCT FROM p_run_id);
    GET DIAGNOSTICS v_deactivated = ROW_COUNT;
  ELSE
    v_note := format('safety floor: bỏ qua mark-missing (pulled %s < 50%% của %s đơn active)',
                     p_pulled, v_active_before);
  END IF;

  UPDATE public.affiliate_sync_runs
     SET status = 'success',
         finished_at = now(),
         pulled = p_pulled,
         upserted = p_upserted,
         rejected = p_rejected,
         deactivated = v_deactivated,
         unmatched_codes = p_unmatched,
         unknown_statuses = p_unknown,
         note = v_note
   WHERE id = p_run_id;

  RETURN jsonb_build_object('deactivated', v_deactivated, 'note', v_note);
END $$;
REVOKE ALL ON FUNCTION public.rpc_finish_affiliate_sync(uuid, int, int, int, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_finish_affiliate_sync(uuid, int, int, int, jsonb, jsonb) TO service_role;

-- Đóng run lỗi (Mongo timeout / upsert fail) — KHÔNG BAO GIỜ đụng source_active.
CREATE OR REPLACE FUNCTION public.rpc_fail_affiliate_sync(p_run_id uuid, p_error text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.affiliate_sync_runs
     SET status = 'failed',
         error = left(coalesce(p_error, 'unknown'), 500),
         finished_at = now()
   WHERE id = p_run_id AND status = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rpc_fail_affiliate_sync: run % không tồn tại hoặc không ở trạng thái running', p_run_id;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.rpc_fail_affiliate_sync(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_fail_affiliate_sync(uuid, text) TO service_role;

-- ── 7. Seed mappings theo stores.code (manifest checksum 22 — KHÔNG seed theo
--       tên; RAISE nếu code thiếu, store_type lệch, hoặc store ngưng hoạt động) ─
DO $$
DECLARE
  r record;
  v_store  uuid;
  v_type   text;
  v_active boolean;
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
      SELECT id, store_type, is_active INTO v_store, v_type, v_active
      FROM public.stores WHERE code = r.store_code;
      IF v_store IS NULL THEN
        RAISE EXCEPTION 'affiliate seed: store code % (cho partner %) không tồn tại', r.store_code, r.partner_code;
      END IF;
      IF v_type IS DISTINCT FROM r.mapping_type THEN
        RAISE EXCEPTION 'affiliate seed: store % có store_type=% nhưng manifest ghi %', r.store_code, v_type, r.mapping_type;
      END IF;
      IF v_active IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'affiliate seed: store % (partner %) đang ngưng hoạt động — xác nhận lại manifest', r.store_code, r.partner_code;
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
        'Affiliate thay Referral (F1 r1): 4 bảng (orders/mappings/sync_runs/dept_access) + is_affiliate_dept_admin + bộ RPC start/finish/fail (lease race-safe, safety-floor mark-missing trong DB) + seed 22 mappings theo stores.code (check store_type + is_active). RLS: FS + external chỉ super; nhánh khác AND is_os_store. total_price NOT NULL không default. Nguồn: Mongo circa-online_prd_order.order.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau migration)
-- ============================================================================
-- 1) Cấu trúc:
--   SELECT count(*) FROM public.affiliate_partner_mappings;                -- = 22
--   SELECT partner_type, count(*) FROM public.affiliate_partner_mappings
--     GROUP BY 1 ORDER BY 1;                                               -- external=7, fs=1, os=14
--   SELECT tablename, count(*) FROM pg_policies
--     WHERE tablename IN ('affiliate_orders','affiliate_partner_mappings',
--                         'affiliate_sync_runs','affiliate_department_access')
--     GROUP BY 1 ORDER BY 1;                                               -- 4 bảng × 1 policy SELECT
--   SELECT relname, relrowsecurity FROM pg_class
--     WHERE relname IN ('affiliate_orders','affiliate_partner_mappings',
--                       'affiliate_sync_runs','affiliate_department_access'); -- 4 × true
--   SELECT proname, prosecdef FROM pg_proc
--     WHERE proname IN ('is_affiliate_dept_admin','rpc_start_affiliate_sync',
--                       'rpc_finish_affiliate_sync','rpc_fail_affiliate_sync'); -- 4 × prosecdef=true
--   SELECT a.attname, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS default
--     FROM pg_attribute a LEFT JOIN pg_attrdef d
--       ON d.adrelid = a.attrelid AND d.adnum = a.attnum
--     WHERE a.attrelid = 'public.affiliate_orders'::regclass
--       AND a.attname = 'total_price';                                     -- notnull=true, default=NULL
--
-- 2) Vòng đời run (service role):
--   SELECT public.rpc_start_affiliate_sync();          -- lần 1: uuid
--   SELECT public.rpc_start_affiliate_sync();          -- lần 2 ngay sau: NULL (lease giữ)
--   SELECT public.rpc_finish_affiliate_sync('<uuid>', 0, 0);
--     -- bảng rỗng: deactivated=0; run → success; note NULL (floor GREATEST(1,0)=1 > pulled 0
--     --            → thực tế note 'safety floor…' khi CHƯA có đơn nào — chấp nhận, backfill đầu
--     --            tiên luôn pulled>0)
--   SELECT public.rpc_finish_affiliate_sync('<cùng uuid>', 1, 1);          -- RAISE (run đã đóng)
--   SELECT public.rpc_fail_affiliate_sync('<uuid mới>', 'test');           -- run → failed
--
-- 3) QA Gate F1 — role matrix (fixture tạm: 1 đơn OS store A + 1 OS store B +
--    1 FS + 1 external qua service role; CLEAN sau khi test):
--   super          → thấy cả 4 đơn
--   admin (chưa cấp dept) → 0 rows
--   admin sau INSERT affiliate_department_access (OPS
--     '1b362298-7121-4604-9192-4a9ca2bb545f') → CHỈ 2 đơn OS
--   sm             → chỉ đơn OS thuộc assigned stores
--   staff/QLCH OS (store A) → chỉ đơn store A
--   staff/QLCH FS  → 0 rows (is_os_store=false)
--   authenticated INSERT/UPDATE/DELETE trực tiếp → bị chặn (không write policy)
--   DELETE FROM affiliate_orders WHERE order_id IN (…fixture…);            -- clean
-- ============================================================================
