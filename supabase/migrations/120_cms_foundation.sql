-- ============================================================================
-- 120_cms_foundation.sql  (r2 — sau db-reviewer 01/11: 3 P1 + P2 hiệu năng / ép kiểu / marker / bất biến)
-- Chạy SAU 119 (số). Marker chữ (118a, 119a, …) không tham gia thứ tự — mọi so sánh số dùng dạng
-- CASE WHEN version ~ '^[0-9]+$' THEN version::int END (không ép ::int trần — luật 118a).
-- Batch CMS P1-a (docs/cms/IMPLEMENTATION_PLAN.md §3.2; SPEC §3, §7, §9; DECISIONS H5–H9b).
--
-- Mục đích: nền dữ liệu CMS theo sản phẩm — bảng chương trình / nhà thuốc / sản phẩm / bậc, cache Product Master,
-- import run, sync run, marker QA; RLS đọc theo vai trò qua MỘT helper SECURITY DEFINER trả mảng id (InitPlan, chạy
-- một lần mỗi câu lệnh); RPC ghi Product Master chỉ service_role. KHÔNG có RPC import / kích hoạt (121) hay snapshot /
-- kết quả (122). Không đổi bảng cũ, không đổi allowlist super admin (dùng public.is_super_admin() hiện hành).
--
-- Contract:
--   · Quyền đọc (H5, H6, H9b) — cms_readable_program_ids():
--       super admin (is_super_admin) — mọi chương trình thật (nháp / active / locked).
--       SM — chương trình status = 'active' có ≥ 1 nhà thuốc OS đang hoạt động thuộc sm_store_assignments của mình.
--         (SM chưa thấy 'locked' — chốt khi P3 được giao.)
--       staff / store_manager — status ∈ ('active','locked') có users.store_id thuộc phạm vi, nhà thuốc OS đang hoạt
--         động. (D1 P1 lọc tiếp Sắp diễn ra + Đang chạy ở app; RLS không giấu lịch sử P2.)
--       admin thường, FS, nhà thuốc ngừng — không thấy. Nháp chỉ super admin.
--       is_test chỉ hiện với user có marker QA còn hạn theo GIỜ DB — KỂ CẢ super admin (H9b).
--   · cms_product_master, cms_import_runs: chỉ super admin đọc (import_runs của chương trình test cần thêm marker).
--   · cms_sync_runs, cms_qa_access: không cấp cho authenticated (chỉ service_role).
--   · Ghi: authenticated KHÔNG có INSERT/UPDATE/DELETE. Product Master ghi qua 3 RPC service_role:
--       rpc_cms_sync_run_open(kind, detail)        → mở phiên (tối đa 1 phiên running / (kind, program) — index
--                                                    unique + khoá advisory; phiên treo > 30′ ⇒ đóng error STALE)
--       rpc_cms_product_master_upsert(run, rows)   → upsert một khối ≤ 5.000 dòng đã validate (không xoá dòng cũ)
--       rpc_cms_sync_run_close(run, status, detail)→ đóng phiên ok / held / error (held / error bắt buộc có mã)
--   · Bất biến DB: không đổi is_test của chương trình (trigger); marker QA: granted_at = now() theo DB (trigger),
--     hạn ≤ 7 ngày, granted_by không chứa email.
--   · ACL: helper đọc EXECUTE chỉ authenticated; RPC EXECUTE chỉ service_role; hàm trigger không cấp ai. Thu hồi đích
--     danh mọi grant khác (kể cả do default privileges cấp cho postgres). Bảng: role dashboard (postgres) GIỮ quyền
--     theo default privileges như mọi bảng public (cùng mẫu 114; db-reviewer chấp nhận) — không đi qua PostgREST.
--
-- Đồ thị tham chiếu RLS (AGENTS §4.1): policy → (SELECT cms_readable_program_ids()) / (SELECT is_super_admin()) — hàm
-- SECDEF owner bypass RLS, đọc users, stores, sm_store_assignments, cms_programs, cms_program_stores, cms_qa_access ⇒
-- không policy nào tham chiếu trực tiếp bảng có RLS khác ⇒ không vòng.
--
-- Tương thích: app 01a9185 không đọc bảng CMS ⇒ chạy được trước hoặc sau deploy code CMS (cờ OFF).
-- KHÔNG chạy lại: preflight dừng nếu đã có marker 120 (bất kỳ tên — kể cả 120 cũ của P-K1 đã bỏ số). Transaction
-- BEGIN…COMMIT nên lỗi giữa chừng không để lại gì ⇒ sửa nguyên nhân rồi chạy lại cả file.
--
-- ROLLBACK (CHỈ khi chưa có chương trình / dữ liệu thật — sau đó tắt cờ, xử lý tiến): rollback/120_cms_foundation_rollback.sql
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_120 text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '119') THEN
    RAISE EXCEPTION '120: thiếu migration nền 119 — chạy đúng thứ tự';
  END IF;
  SELECT name INTO v_120 FROM public.app_migrations WHERE version = '120';
  IF FOUND THEN
    RAISE EXCEPTION '120: đã có marker 120 (name = %) — 120 dành cho CMS; không chạy lại / không chạy chồng', v_120;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations
              WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 120) THEN
    RAISE EXCEPTION '120: DB đã có migration số > 120 — dừng';
  END IF;
  IF to_regclass('public.cms_programs') IS NOT NULL THEN
    RAISE EXCEPTION '120: đã có bảng cms_* mà không có marker 120 — kiểm tra tay trước khi chạy';
  END IF;
  IF to_regprocedure('public.is_super_admin()') IS NULL THEN
    RAISE EXCEPTION '120: thiếu hàm public.is_super_admin()';
  END IF;
  IF to_regclass('public.users') IS NULL OR to_regclass('public.stores') IS NULL OR to_regclass('public.sm_store_assignments') IS NULL THEN
    RAISE EXCEPTION '120: thiếu bảng public.users / public.stores / public.sm_store_assignments';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND
        ((table_name = 'users' AND column_name IN ('id', 'role', 'store_id'))
      OR (table_name = 'stores' AND column_name IN ('id', 'store_type', 'is_active'))
      OR (table_name = 'sm_store_assignments' AND column_name IN ('sm_user_id', 'store_id')))) <> 8 THEN
    RAISE EXCEPTION '120: thiếu cột nền (users.id/role/store_id, stores.id/store_type/is_active, sm_store_assignments.sm_user_id/store_id)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION '120: role chạy migration (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION '120: thiếu role anon / authenticated / service_role';
  END IF;
END $$;

-- ── 1. Bảng ─────────────────────────────────────────────────────────────────
-- Không FK tới public.users (cột *_by chỉ là audit uuid) để không tạo đường embed users↔stores mới (AGENTS §4.4).

CREATE TABLE public.cms_product_master (
  product_id        text        PRIMARY KEY CHECK (product_id ~ '^[1-9][0-9]{0,18}$'),
  product_name      text        NOT NULL CHECK (char_length(btrim(product_name)) >= 1 AND char_length(product_name) <= 500),
  image_url         text        CHECK (image_url IS NULL OR (char_length(image_url) <= 2000 AND image_url ~ '^https://')),
  is_active         boolean     NOT NULL,
  source_updated_at timestamptz NOT NULL CHECK (isfinite(source_updated_at)),
  -- < 1e15 loại cả NaN / Infinity (NaN lớn hơn mọi số trong so sánh numeric của Postgres).
  reference_price   numeric     CHECK (reference_price IS NULL OR (reference_price >= 0 AND reference_price < 1e15 AND scale(reference_price) <= 9)),
  price_unit        text        CHECK (price_unit IS NULL OR char_length(price_unit) <= 50),
  synced_at         timestamptz NOT NULL DEFAULT now(),
  sync_run_id       uuid
);

CREATE TABLE public.cms_programs (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  status             text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'locked')),
  start_date         date        NOT NULL,
  end_date           date        NOT NULL,
  scope              text        NOT NULL CHECK (scope IN ('all', 'stores')),
  catalog_target_gmv bigint      CHECK (catalog_target_gmv IS NULL OR catalog_target_gmv > 0),
  calc_mode          text        NOT NULL DEFAULT 'progressive' CHECK (calc_mode = 'progressive'),
  gate_scope         text        NOT NULL DEFAULT 'pharmacist' CHECK (gate_scope = 'pharmacist'),
  is_test            boolean     NOT NULL DEFAULT false,
  config_version     integer     NOT NULL DEFAULT 1 CHECK (config_version >= 1),
  created_by         uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  activated_by       uuid,
  activated_at       timestamptz,
  locked_by          uuid,
  locked_at          timestamptz,
  CONSTRAINT cms_programs_dates CHECK (end_date >= start_date),
  CONSTRAINT cms_programs_activation CHECK ((status = 'draft') = (activated_at IS NULL)),
  CONSTRAINT cms_programs_lock CHECK ((status = 'locked') = (locked_at IS NOT NULL))
);

CREATE TABLE public.cms_program_stores (
  program_id uuid NOT NULL REFERENCES public.cms_programs(id),
  store_id   uuid NOT NULL REFERENCES public.stores(id),
  PRIMARY KEY (program_id, store_id)
);
CREATE INDEX cms_program_stores_store_idx ON public.cms_program_stores (store_id);

CREATE TABLE public.cms_program_products (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id         uuid        NOT NULL REFERENCES public.cms_programs(id),
  product_id         text        NOT NULL CHECK (product_id ~ '^[1-9][0-9]{0,18}$'),
  gmv_basis          text        NOT NULL CHECK (gmv_basis IN ('product', 'catalog', 'none')),
  target_gmv         bigint      CHECK (target_gmv IS NULL OR target_gmv > 0),
  unit_cms           text        NOT NULL CHECK (char_length(btrim(unit_cms)) BETWEEN 1 AND 50),
  base_quantity_cms  numeric     NOT NULL CHECK (base_quantity_cms > 0 AND base_quantity_cms < 1e29 AND scale(base_quantity_cms) <= 9),
  advice_text        text        NOT NULL CHECK (char_length(btrim(advice_text)) >= 1 AND char_length(advice_text) <= 4000),
  name_snapshot      text        NOT NULL CHECK (char_length(btrim(name_snapshot)) >= 1 AND char_length(name_snapshot) <= 500),
  image_url_snapshot text        CHECK (image_url_snapshot IS NULL OR (char_length(image_url_snapshot) <= 2000 AND image_url_snapshot ~ '^https://')),
  price_snapshot     numeric     CHECK (price_snapshot IS NULL OR (price_snapshot >= 0 AND price_snapshot < 1e15 AND scale(price_snapshot) <= 9)),
  import_run_id      uuid,
  added_after_start  boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cms_program_products_uniq UNIQUE (program_id, product_id),
  -- Đích FK kép của cms_program_tiers (bậc mang program_id để RLS dùng mảng InitPlan, không gọi helper theo dòng).
  CONSTRAINT cms_program_products_id_program UNIQUE (id, program_id),
  CONSTRAINT cms_program_products_target CHECK ((gmv_basis = 'product') = (target_gmv IS NOT NULL))
);
CREATE INDEX cms_program_products_product_idx ON public.cms_program_products (product_id);

CREATE TABLE public.cms_program_tiers (
  program_product_id uuid    NOT NULL,
  program_id         uuid    NOT NULL,
  tier_order         integer NOT NULL CHECK (tier_order >= 1),
  qty_from           integer NOT NULL CHECK (qty_from >= 1),
  qty_to             integer CHECK (qty_to IS NULL OR qty_to >= qty_from),
  amount_per_unit    bigint  NOT NULL CHECK (amount_per_unit > 0),
  PRIMARY KEY (program_product_id, tier_order),
  CONSTRAINT cms_program_tiers_product_fk FOREIGN KEY (program_product_id, program_id)
    REFERENCES public.cms_program_products (id, program_id)
);
CREATE INDEX cms_program_tiers_program_idx ON public.cms_program_tiers (program_id);

CREATE TABLE public.cms_import_runs (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id                uuid        NOT NULL REFERENCES public.cms_programs(id),
  mode                      text        NOT NULL CHECK (mode IN ('replace', 'append')),
  file_name                 text        NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  file_sha256               text        NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes                integer     NOT NULL CHECK (file_bytes BETWEEN 1 AND 5242880),
  config_version_at_preview integer     NOT NULL CHECK (config_version_at_preview >= 1),
  rows_total                integer     NOT NULL DEFAULT 0 CHECK (rows_total >= 0),
  rows_ok                   integer     NOT NULL DEFAULT 0 CHECK (rows_ok >= 0),
  rows_error                integer     NOT NULL DEFAULT 0 CHECK (rows_error >= 0),
  rows_warning              integer     NOT NULL DEFAULT 0 CHECK (rows_warning >= 0),
  products_ok               integer     NOT NULL DEFAULT 0 CHECK (products_ok >= 0),
  products_rejected         integer     NOT NULL DEFAULT 0 CHECK (products_rejected >= 0),
  result                    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status                    text        NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'committed')),
  created_by                uuid        NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  committed_by              uuid,
  committed_at              timestamptz,
  CONSTRAINT cms_import_runs_commit CHECK ((status = 'committed') = (committed_at IS NOT NULL))
);
CREATE INDEX cms_import_runs_program_idx ON public.cms_import_runs (program_id, created_at DESC);

CREATE TABLE public.cms_sync_runs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text        NOT NULL CHECK (kind IN ('products')),  -- 122 mở rộng 'sales' / 'engine'
  program_id      uuid        REFERENCES public.cms_programs(id),
  status          text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'held', 'error')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  rows_read       integer     CHECK (rows_read IS NULL OR rows_read >= 0),
  rows_written    integer     NOT NULL DEFAULT 0 CHECK (rows_written >= 0),
  rows_rejected   integer     CHECK (rows_rejected IS NULL OR rows_rejected >= 0),
  bytes_processed bigint      CHECK (bytes_processed IS NULL OR bytes_processed >= 0),
  error_code      text        CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  detail          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT cms_sync_runs_finish CHECK ((status = 'running') = (finished_at IS NULL)),
  -- ok / running không mang mã lỗi; held / error bắt buộc có mã.
  CONSTRAINT cms_sync_runs_code CHECK ((status IN ('held', 'error')) = (error_code IS NOT NULL))
);
CREATE INDEX cms_sync_runs_kind_idx ON public.cms_sync_runs (kind, started_at DESC);
-- Bất biến DB (không chỉ dựa khoá advisory trong RPC): tối đa MỘT phiên running cho mỗi (kind, program).
CREATE UNIQUE INDEX cms_sync_runs_one_running ON public.cms_sync_runs (kind, program_id) NULLS NOT DISTINCT
  WHERE status = 'running';

CREATE TABLE public.cms_qa_access (
  user_id    uuid        PRIMARY KEY,
  -- Nhãn người / script cấp (vd. 'qa-script:operator'); KHÔNG ghi email.
  granted_by text        NOT NULL CHECK (char_length(granted_by) BETWEEN 1 AND 100 AND position('@' in granted_by) = 0),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT cms_qa_access_ttl CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '7 days')
);

-- ── 2. Trigger bất biến ─────────────────────────────────────────────────────
-- Marker QA neo giờ DB: granted_at luôn = now() khi cấp / gia hạn (người ghi không tự lùi / đẩy mốc để kéo dài hạn).
CREATE FUNCTION public.cms__qa_access_stamp()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.granted_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER cms_qa_access_stamp BEFORE INSERT OR UPDATE ON public.cms_qa_access
  FOR EACH ROW EXECUTE FUNCTION public.cms__qa_access_stamp();

-- H9: không chuyển chương trình thật ↔ test (namespace chống trùng phải ổn định).
CREATE FUNCTION public.cms__programs_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.is_test IS DISTINCT FROM OLD.is_test THEN
    RAISE EXCEPTION 'CMS_PROGRAM_IS_TEST_IMMUTABLE' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cms_programs_guard BEFORE UPDATE ON public.cms_programs
  FOR EACH ROW EXECUTE FUNCTION public.cms__programs_guard();

-- ── 3. Helper quyền (SECURITY DEFINER STABLE, search_path cố định) ──────────
CREATE FUNCTION public.cms_has_qa_access()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.cms_qa_access q WHERE q.user_id = auth.uid() AND q.expires_at > now())
$$;

-- Mảng id chương trình người gọi được đọc — policy dùng (SELECT …) ⇒ InitPlan, tính MỘT lần mỗi câu lệnh.
CREATE FUNCTION public.cms_readable_program_ids()
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (
    SELECT u.id, u.role, u.store_id,
           public.is_super_admin() AS su,
           public.cms_has_qa_access() AS qa,
           COALESCE(s.store_type = 'os' AND s.is_active, false) AS store_ok
      FROM public.users u
      LEFT JOIN public.stores s ON s.id = u.store_id
     WHERE u.id = auth.uid()
  ), sm_stores AS (
    SELECT a.store_id
      FROM me
      JOIN public.sm_store_assignments a ON a.sm_user_id = me.id
      JOIN public.stores s ON s.id = a.store_id
     WHERE me.role = 'sm' AND s.store_type = 'os' AND s.is_active
  )
  SELECT COALESCE(array_agg(p.id ORDER BY p.id), '{}'::uuid[])
    FROM public.cms_programs p
   CROSS JOIN me
   WHERE (NOT p.is_test OR me.qa)
     AND (
       me.su
       OR (me.role IN ('staff', 'store_manager') AND me.store_ok AND p.status IN ('active', 'locked')
           AND EXISTS (SELECT 1 FROM public.cms_program_stores ps WHERE ps.program_id = p.id AND ps.store_id = me.store_id))
       OR (me.role = 'sm' AND p.status = 'active'
           AND EXISTS (SELECT 1 FROM public.cms_program_stores ps JOIN sm_stores x ON x.store_id = ps.store_id
                        WHERE ps.program_id = p.id))
     )
$$;

-- ── 4. RLS + ACL bảng ───────────────────────────────────────────────────────
ALTER TABLE public.cms_product_master   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_programs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_program_stores   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_program_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_program_tiers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_import_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_sync_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_qa_access        ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.cms_product_master, public.cms_programs, public.cms_program_stores, public.cms_program_products,
  public.cms_program_tiers, public.cms_import_runs, public.cms_sync_runs, public.cms_qa_access
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.cms_product_master, public.cms_programs, public.cms_program_stores, public.cms_program_products,
  public.cms_program_tiers, public.cms_import_runs, public.cms_sync_runs, public.cms_qa_access
  TO service_role;
-- authenticated chỉ SELECT (RLS lọc); cms_sync_runs / cms_qa_access KHÔNG cấp.
GRANT SELECT ON public.cms_product_master, public.cms_programs, public.cms_program_stores, public.cms_program_products,
  public.cms_program_tiers, public.cms_import_runs
  TO authenticated;

CREATE POLICY cms_product_master_select ON public.cms_product_master FOR SELECT TO authenticated
  USING ((SELECT public.is_super_admin()));
CREATE POLICY cms_programs_select ON public.cms_programs FOR SELECT TO authenticated
  USING (id = ANY ((SELECT public.cms_readable_program_ids())::uuid[]));
CREATE POLICY cms_program_stores_select ON public.cms_program_stores FOR SELECT TO authenticated
  USING (program_id = ANY ((SELECT public.cms_readable_program_ids())::uuid[]));
CREATE POLICY cms_program_products_select ON public.cms_program_products FOR SELECT TO authenticated
  USING (program_id = ANY ((SELECT public.cms_readable_program_ids())::uuid[]));
CREATE POLICY cms_program_tiers_select ON public.cms_program_tiers FOR SELECT TO authenticated
  USING (program_id = ANY ((SELECT public.cms_readable_program_ids())::uuid[]));
CREATE POLICY cms_import_runs_select ON public.cms_import_runs FOR SELECT TO authenticated
  USING ((SELECT public.is_super_admin()) AND program_id = ANY ((SELECT public.cms_readable_program_ids())::uuid[]));

-- ── 5. RPC đồng bộ Product Master (chỉ service_role) ───────────────────────
CREATE FUNCTION public.rpc_cms_sync_run_open(p_kind text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_kind IS NULL OR p_kind <> 'products' THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_KIND' USING ERRCODE = '22023';
  END IF;
  IF p_detail IS NULL OR jsonb_typeof(p_detail) <> 'object' THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_DETAIL' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cms_sync_run:' || p_kind));
  -- Phiên treo quá 30′ ⇒ đóng error STALE (không giữ khoá vĩnh viễn khi process chết giữa chừng).
  UPDATE public.cms_sync_runs SET status = 'error', finished_at = now(), error_code = 'STALE'
   WHERE kind = p_kind AND program_id IS NULL AND status = 'running' AND started_at < now() - interval '30 minutes';
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = p_kind AND program_id IS NULL AND status = 'running') THEN
    RAISE EXCEPTION 'CMS_SYNC_BUSY' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.cms_sync_runs (kind, detail) VALUES (p_kind, p_detail) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE FUNCTION public.rpc_cms_product_master_upsert(p_run_id uuid, p_rows jsonb)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_n     integer;
  v_dup   integer;
  v_count integer;
BEGIN
  PERFORM 1 FROM public.cms_sync_runs WHERE id = p_run_id AND kind = 'products' AND status = 'running' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_ROWS' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(p_rows);
  IF v_n = 0 OR v_n > 5000 THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_CHUNK' USING ERRCODE = '22023';
  END IF;
  -- Kiểm KIỂU từng phần tử trước khi ép (fail-closed, đúng mã): object; product_id / product_name / source_updated_at
  -- là chuỗi; is_active là boolean JSON (không nhận 'yes'/'1'); timestamp ISO UTC có Z (không 'now'/'infinity'/thiếu múi).
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) e
     WHERE jsonb_typeof(e) <> 'object'
        OR jsonb_typeof(e->'product_id') IS DISTINCT FROM 'string'
        OR jsonb_typeof(e->'product_name') IS DISTINCT FROM 'string'
        OR jsonb_typeof(e->'is_active') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(e->'source_updated_at') IS DISTINCT FROM 'string'
        OR (e->>'source_updated_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
        OR (e ? 'reference_price' AND jsonb_typeof(e->'reference_price') NOT IN ('string', 'null'))
        OR (e ? 'image_url' AND jsonb_typeof(e->'image_url') NOT IN ('string', 'null'))
        OR (e ? 'price_unit' AND jsonb_typeof(e->'price_unit') NOT IN ('string', 'null'))
        OR (e ? 'reference_price' AND jsonb_typeof(e->'reference_price') = 'string'
            AND (e->>'reference_price') !~ '^[0-9]+(\.[0-9]{1,9})?$')
  ) THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_ROW' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) - count(DISTINCT e->>'product_id') INTO v_dup FROM jsonb_array_elements(p_rows) e;
  IF v_dup <> 0 THEN
    RAISE EXCEPTION 'CMS_SYNC_DUPLICATE_PRODUCT' USING ERRCODE = '22023';
  END IF;
  -- Vi phạm CHECK (canonical, độ dài, https, giá) ⇒ lỗi, rollback cả khối.
  INSERT INTO public.cms_product_master AS m
    (product_id, product_name, image_url, is_active, source_updated_at, reference_price, price_unit, synced_at, sync_run_id)
  SELECT e->>'product_id', e->>'product_name', NULLIF(e->>'image_url', ''), (e->>'is_active')::boolean,
         (e->>'source_updated_at')::timestamptz, NULLIF(e->>'reference_price', '')::numeric, NULLIF(e->>'price_unit', ''),
         now(), p_run_id
    FROM jsonb_array_elements(p_rows) e
  ON CONFLICT (product_id) DO UPDATE SET
    product_name = EXCLUDED.product_name, image_url = EXCLUDED.image_url, is_active = EXCLUDED.is_active,
    source_updated_at = EXCLUDED.source_updated_at, reference_price = EXCLUDED.reference_price,
    price_unit = EXCLUDED.price_unit, synced_at = EXCLUDED.synced_at, sync_run_id = EXCLUDED.sync_run_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> v_n THEN
    RAISE EXCEPTION 'CMS_SYNC_COUNT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.cms_sync_runs SET rows_written = rows_written + v_count WHERE id = p_run_id;
  RETURN v_count;
END;
$$;

CREATE FUNCTION public.rpc_cms_sync_run_close(p_run_id uuid, p_status text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('ok', 'held', 'error') THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_STATUS' USING ERRCODE = '22023';
  END IF;
  IF p_detail IS NULL OR jsonb_typeof(p_detail) <> 'object' THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_DETAIL' USING ERRCODE = '22023';
  END IF;
  v_code := NULLIF(p_detail->>'error_code', '');
  IF (p_status IN ('held', 'error')) <> (v_code IS NOT NULL) THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_CODE' USING ERRCODE = '22023';
  END IF;
  UPDATE public.cms_sync_runs SET
    status          = p_status,
    finished_at     = now(),
    rows_read       = NULLIF(p_detail->>'rows_read', '')::integer,
    rows_rejected   = NULLIF(p_detail->>'rows_rejected', '')::integer,
    bytes_processed = NULLIF(p_detail->>'bytes_processed', '')::bigint,
    error_code      = v_code,
    detail          = detail || (p_detail - 'rows_read' - 'rows_rejected' - 'bytes_processed' - 'error_code')
  WHERE id = p_run_id AND status = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- ── 6. ACL hàm: thu hồi đích danh rồi cấp đúng ma trận ─────────────────────
REVOKE ALL ON FUNCTION public.cms_has_qa_access(), public.cms_readable_program_ids(),
  public.rpc_cms_sync_run_open(text, jsonb), public.rpc_cms_product_master_upsert(uuid, jsonb),
  public.rpc_cms_sync_run_close(uuid, text, jsonb), public.cms__qa_access_stamp(), public.cms__programs_guard()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cms_has_qa_access(), public.cms_readable_program_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_sync_run_open(text, jsonb), public.rpc_cms_product_master_upsert(uuid, jsonb),
  public.rpc_cms_sync_run_close(uuid, text, jsonb)
  TO service_role;
-- Thu hồi mọi grant khác owner do default privileges cấp (vd. postgres) — bài học SEC-1 / 090→091 / 117.
-- Hàm trigger (cms__*): không cấp ai (trigger không cần EXECUTE của người ghi).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, x.grantee
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('cms_has_qa_access', 'cms_readable_program_ids', 'rpc_cms_sync_run_open',
                         'rpc_cms_product_master_upsert', 'rpc_cms_sync_run_close', 'cms__qa_access_stamp', 'cms__programs_guard')
       AND x.grantee <> p.proowner
       AND NOT (p.proname LIKE 'rpc\_cms\_%' AND x.grantee = 'service_role'::regrole::oid)
       AND NOT (p.proname IN ('cms_has_qa_access', 'cms_readable_program_ids') AND x.grantee = 'authenticated'::regrole::oid)
     GROUP BY p.oid, x.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- ── 7. Hậu kiểm trong transaction ──────────────────────────────────────────
DO $$
DECLARE
  v_tables text[] := ARRAY['cms_product_master', 'cms_programs', 'cms_program_stores', 'cms_program_products',
                           'cms_program_tiers', 'cms_import_runs', 'cms_sync_runs', 'cms_qa_access'];
  v_t    text;
  v_priv text;
  r      record;
BEGIN
  FOREACH v_t IN ARRAY v_tables LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = ('public.' || v_t)::regclass AND c.relrowsecurity) THEN
      RAISE EXCEPTION '120 hậu kiểm: % chưa bật RLS', v_t;
    END IF;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege('anon', 'public.' || v_t, v_priv) THEN
        RAISE EXCEPTION '120 hậu kiểm: anon có % trên %', v_priv, v_t;
      END IF;
      IF has_table_privilege('authenticated', 'public.' || v_t, v_priv)
         AND NOT (v_priv = 'SELECT' AND v_t NOT IN ('cms_sync_runs', 'cms_qa_access')) THEN
        RAISE EXCEPTION '120 hậu kiểm: authenticated có % trên %', v_priv, v_t;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('authenticated', 'public.' || v_t, 'SELECT') AND v_t NOT IN ('cms_sync_runs', 'cms_qa_access') THEN
      RAISE EXCEPTION '120 hậu kiểm: authenticated thiếu SELECT trên %', v_t;
    END IF;
  END LOOP;
  -- Policy: đúng 6, đều SELECT TO authenticated; cms_sync_runs / cms_qa_access không có policy.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'cms\_%') <> 6
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'cms\_%'
                 AND (cmd <> 'SELECT' OR roles <> ARRAY['authenticated']::name[]))
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('cms_sync_runs', 'cms_qa_access')) THEN
    RAISE EXCEPTION '120 hậu kiểm: policy CMS sai (phải đúng 6 policy SELECT TO authenticated)';
  END IF;
  IF to_regclass('public.cms_sync_runs_one_running') IS NULL THEN
    RAISE EXCEPTION '120 hậu kiểm: thiếu index cms_sync_runs_one_running';
  END IF;
  FOR r IN
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proacl IS NULL AS acl_default,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ',')
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl
      FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('cms_has_qa_access', 'cms_readable_program_ids', 'rpc_cms_sync_run_open',
                         'rpc_cms_product_master_upsert', 'rpc_cms_sync_run_close', 'cms__qa_access_stamp', 'cms__programs_guard')
  LOOP
    IF NOT ('search_path=public' = ANY (r.proconfig)) THEN
      RAISE EXCEPTION '120 hậu kiểm: % phải SET search_path = public', r.proname;
    END IF;
    IF r.proname LIKE 'cms\_\_%' THEN
      -- proacl NULL = quyền mặc định (PUBLIC EXECUTE ngầm) ⇒ phải có ACL tường minh chỉ còn owner.
      IF r.acl_default OR r.acl IS NOT NULL THEN RAISE EXCEPTION '120 hậu kiểm: hàm trigger % không được cấp ai (ACL = %, mặc định = %)', r.proname, r.acl, r.acl_default; END IF;
      CONTINUE;
    END IF;
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '120 hậu kiểm: % phải SECURITY DEFINER', r.proname;
    END IF;
    IF r.acl IS DISTINCT FROM (CASE WHEN r.proname LIKE 'rpc\_%' THEN 'service_role:EXECUTE' ELSE 'authenticated:EXECUTE' END) THEN
      RAISE EXCEPTION '120 hậu kiểm: ACL % = % (sai ma trận)', r.proname, r.acl;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles ro ON ro.oid = p.proowner
                    WHERE p.oid = r.oid AND (ro.rolsuper OR ro.rolbypassrls)) THEN
      RAISE EXCEPTION '120 hậu kiểm: owner của % phải superuser / BYPASSRLS', r.proname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND (p.proname LIKE 'cms\_%' OR p.proname LIKE 'rpc\_cms\_%')) <> 7 THEN
    RAISE EXCEPTION '120 hậu kiểm: số hàm CMS khác 7 (overload lạ?)';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('120', 'cms_foundation', 'CMS P1-a: bảng nền + RLS đọc theo vai qua mảng InitPlan (marker QA kể cả super) + RPC Product Master service_role');

COMMIT;

-- ── VERIFY (chạy sau COMMIT, CHỈ ĐỌC — Dev qua wrapper ops-ro / pg-meta READ ONLY; sub-agent không gọi prod) ──
-- V1 marker đúng chủ:   SELECT version, name FROM public.app_migrations WHERE version IN ('119','119a','120') ORDER BY 1;
--                        kỳ vọng 120 | cms_foundation.
-- V2 policy:            SELECT tablename, policyname, cmd, roles::text FROM pg_policies
--                        WHERE schemaname = 'public' AND tablename LIKE 'cms\_%' ORDER BY 1;
--                        kỳ vọng 6 dòng, cmd SELECT, roles {authenticated}; 0 dòng cho cms_sync_runs / cms_qa_access.
-- V3 ACL bảng:          SELECT c.relname, c.relrowsecurity, c.relacl::text FROM pg_class c
--                        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'cms\_%' ORDER BY 1;
--                        kỳ vọng: không 'anon='; 'authenticated=r/' chỉ ở 6 bảng (không sync_runs / qa_access);
--                        service_role=arwdDxt; postgres=arwdDxt (default privileges — chấp nhận, như 114); relrowsecurity t.
-- V4 hàm:               SELECT p.oid::regprocedure, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, p.proacl::text,
--                               has_function_privilege('anon', p.oid, 'EXECUTE') anon_x,
--                               has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x,
--                               has_function_privilege('service_role', p.oid, 'EXECUTE') svc_x,
--                               has_function_privilege('postgres', p.oid, 'EXECUTE') pg_x
--                          FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--                           AND (p.proname LIKE 'cms\_%' OR p.proname LIKE 'rpc\_cms\_%') ORDER BY 1;
--                        kỳ vọng 7 dòng: cms_has_qa_access / cms_readable_program_ids auth_x t còn lại f;
--                        rpc_cms_* svc_x t còn lại f; cms__* (trigger) mọi cột f, proacl chỉ owner.
-- V5 role:              SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
--                        WHERE rolname IN ('postgres','supabase_admin','service_role','authenticated','anon');
-- V6 ACL 178 hàm cũ:    cùng truy vấn ảnh PRE (md5 string_agg proacl, sep chr(59)) nhưng loại cms_% / rpc_cms_%
--                        ⇒ n_fn = 178, md5 = c0798e82652c4dd8d02290b2ac750c3e.
-- V7 index:             SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'cms_sync_runs_one_running';
-- V8 hành vi (trong transaction READ ONLY): SET LOCAL ROLE authenticated; set_config('request.jwt.claims', {sub: <super>}) ;
--                        SELECT public.cms_has_qa_access(), cardinality(public.cms_readable_program_ids()),
--                               (SELECT count(*) FROM public.cms_programs);   kỳ vọng false, 0, 0 (chưa có chương trình).
