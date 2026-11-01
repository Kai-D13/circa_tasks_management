-- ============================================================================
-- 121_cms_import_activation.sql  (r2 — sửa theo db-reviewer P2 + security review P1-b)
-- Chạy SAU 120 (marker 120 = 'cms_foundation'). So sánh số dạng CASE WHEN version ~ '^[0-9]+$' (luật 118a).
-- Batch CMS P1-b (docs/cms/IMPLEMENTATION_PLAN.md §3.3; SPEC §4.4–§4.7; DECISIONS H7 / H8 / H9 / H9b).
--
-- Mục đích: ghi chương trình / import / kích hoạt CMS qua 4 RPC SECURITY DEFINER chỉ service_role (server action /
-- Route Handler kiểm quyền super admin + cờ TRƯỚC khi gọi). RPC KHÔNG parse xlsx, KHÔNG tin dòng client: payload do
-- server sinh từ lần parse lại, RPC kiểm lại từng trường (kiểu, dạng, độ dài, bậc liên tục, gate / target, quy cách,
-- ProductID có trên Product Master) và ghi atomic; lỗi trả mã CMS_* (không để lọt lỗi CHECK thô).
--
-- Contract (SPEC §4.7 trạng thái × hành động; ngày theo VN, kiểm TRONG transaction sau khi khoá dòng chương trình):
--   rpc_cms_program_save(p jsonb) → uuid
--     · tạo nháp (is_test do server truyền — không đổi về sau, trigger 120), hoặc sửa tên / ngày / phạm vi khi
--       nháp hoặc đã kích hoạt CHƯA bắt đầu; đã bắt đầu / đã chốt ⇒ CMS_PROGRAM_NOT_EDITABLE.
--     · active chưa bắt đầu: không được dời ngày bắt đầu về hôm nay / quá khứ (CMS_PROGRAM_START_PAST) — Q-214
--       (operator chốt 01/11): muốn hồi tố thì tạo nháp rồi kích hoạt có xác nhận (H7).
--     · ngày trong 2020-01-01…2100-12-31; KHÔNG có trần độ dài kỳ — Q-215 (operator chốt 01/11: giữ như spec).
--     · phạm vi 'stores' ⇒ ≥ 1 nhà thuốc OS đang hoạt động; active + 'all' ⇒ ghi lại danh sách OS active hiện tại.
--     · sửa chương trình active ⇒ khoá danh mục rồi kiểm trùng với ngày mới; config_version + 1.
--   rpc_cms_import_preview_save(p jsonb) → uuid   (ghi import run 'previewed', mode khớp trạng thái; result ≤ 24 MiB)
--   rpc_cms_import_commit(p_run_id, p_sha256, p_digest, p_payload, p_actor) → jsonb
--     · run đã committed ⇒ {already: true}, KHÔNG ghi thêm (commit lặp idempotent).
--     · hash / digest / config_version / mode / ngày lệch preview ⇒ CMS_IMPORT_CONFLICT (route 409); đã chốt ⇒
--       CMS_PROGRAM_NOT_EDITABLE.
--     · replace (nháp / active chưa bắt đầu): xoá bậc rồi sản phẩm (WHERE program_id) và ghi lại toàn bộ.
--     · append (đã bắt đầu): chỉ thêm ProductID mới, added_after_start = true (hồi tố); target danh mục hiện hữu
--       không đổi; nhóm danh mục đầu tiên đặt target.
--     · tối đa 2.000 sản phẩm và 2.000 bậc / lần (SPEC §4.1: 2.000 dòng / file).
--     · audit: payload đã ghi lưu vào run (result.committed) ⇒ dựng lại được cấu hình trước mỗi lần nạp lại.
--   rpc_cms_program_activate(p_program_id, p_actor) → jsonb
--     · chỉ từ nháp; ≥ 1 sản phẩm; có SP danh mục ⇒ có catalog_target_gmv; 'all' ⇒ ghi danh sách OS active (≥ 1);
--       'stores' ⇒ mọi nhà thuốc còn OS active; khoá danh mục + kiểm trùng; ngày bắt đầu đã qua vẫn kích hoạt (H7).
--   KHÔNG có RPC xoá / huỷ / về nháp / tạm dừng (H8).
-- Chống race: MỘT khoá advisory toàn cục cho mọi ghi CMS có kiểm trùng ProductID (cms__lock_catalog — ghi CMS hiếm, chỉ
-- super admin) ⇒ không deadlock, không chiếm bảng khoá theo số SP; kiểm trùng chạy SAU khi giữ khoá, trong câu lệnh
-- mới (READ COMMITTED ⇒ snapshot mới — isolation khác ⇒ CMS_ISOLATION). 4 RPC có lock_timeout 5s (phiên khác giữ khoá
-- ⇒ 55P03, route trả BUSY). Không dùng EXCLUDE gist (cần btree_gist chưa kiểm trên prod); bất biến "không trùng SP" và
-- "bậc liên tục" chỉ do RPC bảo đảm ⇒ MỌI đường ghi sau này (122, P3 chốt) phải gọi cms__lock_catalog + cms__conflicts;
-- VERIFY V4–V6 kiểm bất biến.
-- ACL: 4 RPC chỉ service_role; 3 helper cms__* không cấp ai (chỉ owner gọi ⇒ 122 phải chạy bằng CÙNG role owner).
-- Tương thích: chỉ THÊM hàm; app không có caller ⇒ chạy trước / sau deploy đều được (cờ OFF).
-- KHÔNG chạy lại (preflight dừng nếu đã có 121). ROLLBACK: rollback/121_cms_import_activation_rollback.sql
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_name text;
BEGIN
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '120';
  IF v_name IS DISTINCT FROM 'cms_foundation' THEN
    RAISE EXCEPTION '121: thiếu migration nền 120 cms_foundation (name = %)', v_name;
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '121';
  IF FOUND THEN
    RAISE EXCEPTION '121: đã có marker 121 (name = %) — không chạy lại / không chạy chồng', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 121) THEN
    RAISE EXCEPTION '121: DB đã có migration số > 121 — dừng';
  END IF;
  IF to_regclass('public.cms_programs') IS NULL OR to_regclass('public.cms_program_tiers') IS NULL
     OR to_regclass('public.cms_import_runs') IS NULL OR to_regclass('public.cms_product_master') IS NULL THEN
    RAISE EXCEPTION '121: thiếu bảng nền CMS (120)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION '121: role chạy migration (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
END $$;

-- ── 1. Helper nội bộ (không cấp ai; chỉ RPC SECDEF cùng owner gọi) ─────────
CREATE FUNCTION public.cms__vn_today()
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
$$;

-- Khoá toàn cục danh mục CMS (giữ tới hết transaction). Bắt buộc READ COMMITTED: kiểm trùng sau khoá cần snapshot mới.
CREATE FUNCTION public.cms__lock_catalog()
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cms_catalog_conflict', 0));
END;
$$;

-- ProductID của p_ids đã thuộc chương trình KHÁC đang active / locked, giao ngày, CÙNG namespace is_test.
CREATE FUNCTION public.cms__conflicts(p_program_id uuid, p_is_test boolean, p_start date, p_end date, p_ids text[])
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(DISTINCT pp.product_id ORDER BY pp.product_id), '{}'::text[])
    FROM public.cms_program_products pp
    JOIN public.cms_programs o ON o.id = pp.program_id
   WHERE o.id <> p_program_id
     AND o.status IN ('active', 'locked')
     AND o.is_test = p_is_test
     AND o.start_date <= p_end AND o.end_date >= p_start
     AND pp.product_id = ANY (COALESCE(p_ids, '{}'::text[]))
$$;

-- ── 2. rpc_cms_program_save ─────────────────────────────────────────────────
CREATE FUNCTION public.rpc_cms_program_save(p jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_id      uuid;
  v_prog    public.cms_programs%ROWTYPE;
  v_name    text;
  v_start   date;
  v_end     date;
  v_scope   text;
  v_stores  uuid[];
  v_actor   uuid;
  v_today   date := public.cms__vn_today();
  v_ids     text[];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p->'name') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p->'start_date') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'end_date') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p->'scope') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'actor') IS DISTINCT FROM 'string'
     OR COALESCE(jsonb_typeof(p->'id'), 'null') NOT IN ('string', 'null')
     OR COALESCE(jsonb_typeof(p->'store_ids'), 'null') NOT IN ('array', 'null') THEN
    RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF (p->>'start_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR (p->>'end_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR (p->>'actor') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (jsonb_typeof(p->'id') = 'string' AND (p->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p->'store_ids') = 'array' THEN
    IF jsonb_array_length(p->'store_ids') > 500 OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p->'store_ids') x
          WHERE jsonb_typeof(x) IS DISTINCT FROM 'string'
             OR (x #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
    END IF;
  END IF;
  -- Cắt mọi khoảng trắng (kể cả tab / xuống dòng) — tên chỉ có khoảng trắng ⇒ lỗi.
  v_name := btrim(p->>'name', E' \t\r\n\f\v');
  BEGIN
    v_start := (p->>'start_date')::date;
    v_end := (p->>'end_date')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
  END;
  v_scope := p->>'scope';
  v_actor := (p->>'actor')::uuid;
  -- Khoảng ngày hợp lý về kỹ thuật (chặn gõ nhầm năm). Không trần độ dài kỳ (Q-215, operator chốt 01/11).
  IF char_length(v_name) NOT BETWEEN 1 AND 200 OR v_end < v_start OR v_scope NOT IN ('all', 'stores')
     OR v_start < DATE '2020-01-01' OR v_end > DATE '2100-12-31' THEN
    RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT (x)::uuid), '{}'::uuid[]) INTO v_stores
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p->'store_ids') = 'array' THEN p->'store_ids' ELSE '[]'::jsonb END) x;
  IF v_scope = 'stores' THEN
    IF cardinality(v_stores) = 0
       OR (SELECT count(*) FROM public.stores s WHERE s.id = ANY (v_stores) AND s.store_type = 'os' AND s.is_active) <> cardinality(v_stores) THEN
      RAISE EXCEPTION 'CMS_PROGRAM_STORE_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF NOT (p ? 'id') OR jsonb_typeof(p->'id') = 'null' THEN
    -- Tạo nháp. is_test do server quyết (marker QA của người tạo) — không đổi về sau (trigger 120).
    IF jsonb_typeof(p->'is_test') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_programs (name, start_date, end_date, scope, is_test, created_by, updated_by)
    VALUES (v_name, v_start, v_end, v_scope, (p->>'is_test')::boolean, v_actor, v_actor)
    RETURNING id INTO v_id;
    IF v_scope = 'stores' THEN
      INSERT INTO public.cms_program_stores (program_id, store_id) SELECT v_id, x FROM unnest(v_stores) x;
    END IF;
    RETURN v_id;
  END IF;

  -- Sửa: khoá dòng chương trình, kiểm trạng thái + ngày VN TRONG transaction.
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (v_prog.status = 'draft' OR (v_prog.status = 'active' AND v_today < v_prog.start_date)) THEN
    RAISE EXCEPTION 'CMS_PROGRAM_NOT_EDITABLE' USING ERRCODE = 'P0001';
  END IF;
  IF v_prog.status = 'active' THEN
    -- Q-214 (operator chốt 01/11): chặn dời ngày bắt đầu của chương trình đã kích hoạt về hôm nay / quá khứ VN.
    IF v_start <= v_today THEN
      RAISE EXCEPTION 'CMS_PROGRAM_START_PAST' USING ERRCODE = 'P0001';
    END IF;
    IF v_scope = 'all' THEN
      SELECT COALESCE(array_agg(s.id), '{}'::uuid[]) INTO v_stores FROM public.stores s WHERE s.store_type = 'os' AND s.is_active;
      IF cardinality(v_stores) = 0 THEN RAISE EXCEPTION 'CMS_PROGRAM_STORE_INVALID' USING ERRCODE = '22023'; END IF;
    END IF;
    PERFORM public.cms__lock_catalog();
    SELECT COALESCE(array_agg(product_id), '{}'::text[]) INTO v_ids FROM public.cms_program_products WHERE program_id = v_prog.id;
    IF cardinality(public.cms__conflicts(v_prog.id, v_prog.is_test, v_start, v_end, v_ids)) > 0 THEN
      RAISE EXCEPTION 'CMS_PROGRAM_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  UPDATE public.cms_programs
     SET name = v_name, start_date = v_start, end_date = v_end, scope = v_scope,
         config_version = config_version + 1, updated_by = v_actor, updated_at = now()
   WHERE id = v_prog.id;
  DELETE FROM public.cms_program_stores WHERE program_id = v_prog.id;
  IF v_scope = 'stores' OR v_prog.status = 'active' THEN
    INSERT INTO public.cms_program_stores (program_id, store_id) SELECT v_prog.id, x FROM unnest(v_stores) x;
  END IF;
  RETURN v_prog.id;
END;
$$;

-- ── 3. rpc_cms_import_preview_save ──────────────────────────────────────────
CREATE FUNCTION public.rpc_cms_import_preview_save(p jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_prog  public.cms_programs%ROWTYPE;
  v_mode  text;
  v_today date := public.cms__vn_today();
  v_id    uuid;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p->'program_id') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'mode') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p->'file_name') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'file_sha256') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p->'file_bytes') IS DISTINCT FROM 'number' OR jsonb_typeof(p->'actor') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p->'stats') IS DISTINCT FROM 'object' OR jsonb_typeof(p->'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF (p->>'program_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (p->>'actor') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (p->>'file_sha256') !~ '^[0-9a-f]{64}$'
     OR char_length(p->>'file_name') NOT BETWEEN 1 AND 255
     OR (p->>'file_bytes') !~ '^[1-9][0-9]{0,6}$'
     OR jsonb_typeof(p->'result'->'digest') IS DISTINCT FROM 'string' OR (p->'result'->>'digest') !~ '^[0-9a-f]{64}$'
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['rowsTotal', 'rowsOk', 'rowsRejected', 'warnings', 'productsOk', 'productsRejected']) k
                 WHERE jsonb_typeof(p->'stats'->k) IS DISTINCT FROM 'number' OR (p->'stats'->>k) !~ '^[0-9]{1,6}$') THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- Trần file 5 MiB (SPEC §4.1) + trần kích thước result lưu trong run (raw cells nhóm bị loại).
  IF (p->>'file_bytes')::integer > 5242880 OR octet_length((p->'result')::text) > 25165824 THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = (p->>'program_id')::uuid FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  v_mode := CASE
    WHEN v_prog.status = 'draft' OR (v_prog.status = 'active' AND v_today < v_prog.start_date) THEN 'replace'
    WHEN v_prog.status = 'active' THEN 'append'
    ELSE NULL END;
  IF v_mode IS NULL THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_EDITABLE' USING ERRCODE = 'P0001'; END IF;
  IF v_mode IS DISTINCT FROM p->>'mode' THEN RAISE EXCEPTION 'CMS_IMPORT_CONFLICT' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.cms_import_runs (program_id, mode, file_name, file_sha256, file_bytes, config_version_at_preview,
      rows_total, rows_ok, rows_error, rows_warning, products_ok, products_rejected, result, created_by)
  VALUES (v_prog.id, v_mode, p->>'file_name', p->>'file_sha256', (p->>'file_bytes')::integer, v_prog.config_version,
      (p->'stats'->>'rowsTotal')::integer, (p->'stats'->>'rowsOk')::integer,
      (p->'stats'->>'rowsRejected')::integer, (p->'stats'->>'warnings')::integer,
      (p->'stats'->>'productsOk')::integer, (p->'stats'->>'productsRejected')::integer,
      p->'result', (p->>'actor')::uuid)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ── 4. rpc_cms_import_commit ────────────────────────────────────────────────
CREATE FUNCTION public.rpc_cms_import_commit(p_run_id uuid, p_sha256 text, p_digest text, p_payload jsonb, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_run     public.cms_import_runs%ROWTYPE;
  v_prog    public.cms_programs%ROWTYPE;
  v_today   date := public.cms__vn_today();
  v_mode    text;
  v_cat     bigint;
  v_ids     text[];
  e         jsonb;
  t         jsonb;
  v_pp      uuid;
  v_k       integer;
  v_prev_to integer;
  v_n       integer := 0;
  v_tiers   integer := 0;
  v_has_cat boolean := false;
BEGIN
  IF p_run_id IS NULL OR p_actor IS NULL THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_run FROM public.cms_import_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_IMPORT_RUN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_run.file_sha256 IS DISTINCT FROM p_sha256 OR (v_run.result->>'digest') IS DISTINCT FROM p_digest THEN
    RAISE EXCEPTION 'CMS_IMPORT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.status = 'committed' THEN
    RETURN jsonb_build_object('already', true, 'program_id', v_run.program_id);
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_run.program_id FOR UPDATE;
  v_mode := CASE
    WHEN v_prog.status = 'draft' OR (v_prog.status = 'active' AND v_today < v_prog.start_date) THEN 'replace'
    WHEN v_prog.status = 'active' THEN 'append'
    ELSE NULL END;
  IF v_mode IS NULL THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_EDITABLE' USING ERRCODE = 'P0001'; END IF;
  IF v_run.config_version_at_preview <> v_prog.config_version OR v_mode IS DISTINCT FROM v_run.mode THEN
    RAISE EXCEPTION 'CMS_IMPORT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  -- Kiểm payload (không tin client — dù payload do server sinh từ lần parse lại).
  IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
  END IF;
  IF p_payload->>'mode' IS DISTINCT FROM v_mode OR jsonb_typeof(p_payload->'products') IS DISTINCT FROM 'array'
     OR COALESCE(jsonb_typeof(p_payload->'catalog_target'), 'null') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_payload->'products') NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
  END IF;
  -- Miền tiền = bigint dương của PG (cùng contract validator app — PM P1-b P1-1): kiểm dạng + so numeric TRƯỚC cast.
  IF jsonb_typeof(p_payload->'catalog_target') = 'string' THEN
    IF (p_payload->>'catalog_target') !~ '^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023'; END IF;
    IF (p_payload->>'catalog_target')::numeric > 9223372036854775807 THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023'; END IF;
    v_cat := (p_payload->>'catalog_target')::bigint;
  END IF;
  -- Mỗi điều kiện phụ thuộc kiểu được kiểm ở IF riêng (thứ tự đánh giá OR trong SQL không được bảo đảm; không ép kiểu
  -- trước khi đã chắc kiểu / dạng chuỗi ⇒ không lọt NULL, không lỗi cast thô). Kiểm tường minh mọi CHECK của bảng.
  FOR e IN SELECT x FROM jsonb_array_elements(p_payload->'products') x LOOP
    IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023'; END IF;
    IF jsonb_typeof(e->'product_id') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'gmv_basis') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e->'unit_cms') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'advice_text') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e->'name_snapshot') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'base_quantity_cms') IS DISTINCT FROM 'string'
       OR COALESCE(jsonb_typeof(e->'target_gmv'), '-') NOT IN ('string', 'null')
       OR COALESCE(jsonb_typeof(e->'image_url_snapshot'), '-') NOT IN ('string', 'null')
       OR COALESCE(jsonb_typeof(e->'price_snapshot'), '-') NOT IN ('string', 'null')
       OR jsonb_typeof(e->'tiers') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    IF (e->>'product_id') !~ '^[1-9][0-9]{0,18}$' OR (e->>'gmv_basis') NOT IN ('product', 'catalog', 'none')
       -- quy cách: decimal dương ≤ 29 chữ số nguyên / 9 chữ số thập phân (nền 120: < 1e29, scale ≤ 9)
       OR (e->>'base_quantity_cms') !~ '^[0-9]{1,29}(\.[0-9]{1,9})?$' OR (e->>'base_quantity_cms') !~ '[1-9]'
       OR (jsonb_typeof(e->'price_snapshot') = 'string' AND (e->>'price_snapshot') !~ '^[0-9]{1,15}(\.[0-9]{1,9})?$')
       OR ((e->>'gmv_basis') = 'product') IS DISTINCT FROM (jsonb_typeof(e->'target_gmv') = 'string')
       OR (jsonb_typeof(e->'target_gmv') = 'string' AND (e->>'target_gmv') !~ '^[1-9][0-9]{0,18}$')
       OR char_length(e->>'unit_cms') NOT BETWEEN 1 AND 50 OR (e->>'unit_cms') !~ '\S'
       OR char_length(e->>'advice_text') NOT BETWEEN 1 AND 4000 OR (e->>'advice_text') !~ '\S'
       OR char_length(e->>'name_snapshot') NOT BETWEEN 1 AND 500 OR (e->>'name_snapshot') !~ '\S'
       OR (jsonb_typeof(e->'image_url_snapshot') = 'string'
           AND ((e->>'image_url_snapshot') !~ '^https://' OR char_length(e->>'image_url_snapshot') > 2000))
       OR jsonb_array_length(e->'tiers') NOT BETWEEN 1 AND 2000 THEN
      RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(e->'target_gmv') = 'string' AND (e->>'target_gmv')::numeric > 9223372036854775807 THEN
      RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    IF (e->>'gmv_basis') = 'catalog' THEN v_has_cat := true; END IF;
    v_tiers := v_tiers + jsonb_array_length(e->'tiers');
    -- Bậc: payload đã sắp; order = vị trí 1..n, bắt đầu 1, liên tục, chỉ bậc cuối mở, đến ≥ từ, ≤ int max, tiền > 0.
    v_prev_to := 0;
    FOR t, v_k IN SELECT x, n::integer FROM jsonb_array_elements(e->'tiers') WITH ORDINALITY a(x, n) LOOP
      IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR jsonb_typeof(t->'order') IS DISTINCT FROM 'number'
         OR jsonb_typeof(t->'from') IS DISTINCT FROM 'number' OR COALESCE(jsonb_typeof(t->'to'), '-') NOT IN ('number', 'null')
         OR jsonb_typeof(t->'amount') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'CMS_IMPORT_BAD_TIERS' USING ERRCODE = '22023';
      END IF;
      IF (t->>'order') !~ '^[1-9][0-9]{0,9}$' OR (t->>'from') !~ '^[1-9][0-9]{0,9}$'
         OR (jsonb_typeof(t->'to') = 'number' AND (t->>'to') !~ '^[1-9][0-9]{0,9}$')
         OR (t->>'amount') !~ '^[1-9][0-9]{0,18}$' THEN
        RAISE EXCEPTION 'CMS_IMPORT_BAD_TIERS' USING ERRCODE = '22023';
      END IF;
      IF (t->>'order')::bigint <> v_k OR (t->>'from')::bigint <> v_prev_to::bigint + 1
         OR (t->>'amount')::numeric > 9223372036854775807
         OR (jsonb_typeof(t->'to') = 'null' AND v_k <> jsonb_array_length(e->'tiers'))
         OR (t->>'from')::bigint > 2147483647
         OR (jsonb_typeof(t->'to') = 'number' AND ((t->>'to')::bigint < (t->>'from')::bigint OR (t->>'to')::bigint > 2147483647)) THEN
        RAISE EXCEPTION 'CMS_IMPORT_BAD_TIERS' USING ERRCODE = '22023';
      END IF;
      v_prev_to := CASE WHEN jsonb_typeof(t->'to') = 'number' THEN (t->>'to')::integer ELSE v_prev_to END;
    END LOOP;
  END LOOP;
  IF v_tiers > 2000 THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_TIERS' USING ERRCODE = '22023'; END IF;
  IF v_has_cat AND v_cat IS NULL THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023'; END IF;
  IF (SELECT count(*) - count(DISTINCT x->>'product_id') FROM jsonb_array_elements(p_payload->'products') x) <> 0 THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(x->>'product_id') INTO v_ids FROM jsonb_array_elements(p_payload->'products') x;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) x WHERE NOT EXISTS (SELECT 1 FROM public.cms_product_master m WHERE m.product_id = x)) THEN
    RAISE EXCEPTION 'CMS_IMPORT_PRODUCT_UNKNOWN' USING ERRCODE = 'P0001';
  END IF;

  -- Khoá danh mục rồi kiểm trùng với chương trình active / locked khác, giao ngày, cùng namespace (câu lệnh mới).
  PERFORM public.cms__lock_catalog();
  IF cardinality(public.cms__conflicts(v_prog.id, v_prog.is_test, v_prog.start_date, v_prog.end_date, v_ids)) > 0 THEN
    RAISE EXCEPTION 'CMS_IMPORT_PRODUCT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  IF v_mode = 'replace' THEN
    DELETE FROM public.cms_program_tiers WHERE program_id = v_prog.id;
    DELETE FROM public.cms_program_products WHERE program_id = v_prog.id;
    UPDATE public.cms_programs SET catalog_target_gmv = CASE WHEN v_has_cat THEN v_cat ELSE NULL END WHERE id = v_prog.id;
  ELSE
    IF EXISTS (SELECT 1 FROM public.cms_program_products WHERE program_id = v_prog.id AND product_id = ANY (v_ids)) THEN
      RAISE EXCEPTION 'CMS_IMPORT_PRODUCT_EXISTS' USING ERRCODE = 'P0001';
    END IF;
    IF v_has_cat THEN
      IF v_prog.catalog_target_gmv IS NULL THEN
        UPDATE public.cms_programs SET catalog_target_gmv = v_cat WHERE id = v_prog.id;
      ELSIF v_prog.catalog_target_gmv <> v_cat THEN
        RAISE EXCEPTION 'CMS_IMPORT_CATALOG_TARGET_CHANGED' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  FOR e IN SELECT x FROM jsonb_array_elements(p_payload->'products') x LOOP
    INSERT INTO public.cms_program_products (program_id, product_id, gmv_basis, target_gmv, unit_cms, base_quantity_cms,
        advice_text, name_snapshot, image_url_snapshot, price_snapshot, import_run_id, added_after_start)
    VALUES (v_prog.id, e->>'product_id', e->>'gmv_basis', NULLIF(e->>'target_gmv', '')::bigint, e->>'unit_cms',
        (e->>'base_quantity_cms')::numeric, e->>'advice_text', e->>'name_snapshot', NULLIF(e->>'image_url_snapshot', ''),
        NULLIF(e->>'price_snapshot', '')::numeric, v_run.id, v_mode = 'append')
    RETURNING id INTO v_pp;
    INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, qty_to, amount_per_unit)
    SELECT v_pp, v_prog.id, (x->>'order')::integer, (x->>'from')::integer, NULLIF(x->>'to', '')::integer, (x->>'amount')::bigint
      FROM jsonb_array_elements(e->'tiers') x;
    v_n := v_n + 1;
  END LOOP;

  -- Audit: lưu payload đã ghi vào run (chuỗi run committed dựng lại được mọi phiên bản danh mục).
  UPDATE public.cms_import_runs
     SET status = 'committed', committed_by = p_actor, committed_at = now(),
         result = result || jsonb_build_object('committed', p_payload)
   WHERE id = v_run.id;
  UPDATE public.cms_programs SET config_version = config_version + 1, updated_by = p_actor, updated_at = now() WHERE id = v_prog.id;
  RETURN jsonb_build_object('already', false, 'program_id', v_prog.id, 'mode', v_mode, 'products', v_n);
END;
$$;

-- ── 5. rpc_cms_program_activate ─────────────────────────────────────────────
CREATE FUNCTION public.rpc_cms_program_activate(p_program_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_prog  public.cms_programs%ROWTYPE;
  v_today date := public.cms__vn_today();
  v_ids   text[];
BEGIN
  IF p_program_id IS NULL OR p_actor IS NULL THEN RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_prog.status <> 'draft' THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_DRAFT' USING ERRCODE = 'P0001'; END IF;
  SELECT COALESCE(array_agg(product_id), '{}'::text[]) INTO v_ids FROM public.cms_program_products WHERE program_id = v_prog.id;
  IF cardinality(v_ids) = 0 THEN RAISE EXCEPTION 'CMS_PROGRAM_EMPTY' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM public.cms_program_products WHERE program_id = v_prog.id AND gmv_basis = 'catalog')
     AND v_prog.catalog_target_gmv IS NULL THEN
    RAISE EXCEPTION 'CMS_PROGRAM_CATALOG_TARGET_MISSING' USING ERRCODE = 'P0001';
  END IF;
  IF v_prog.scope = 'all' THEN
    DELETE FROM public.cms_program_stores WHERE program_id = v_prog.id;
    INSERT INTO public.cms_program_stores (program_id, store_id)
      SELECT v_prog.id, s.id FROM public.stores s WHERE s.store_type = 'os' AND s.is_active;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cms_program_stores WHERE program_id = v_prog.id)
     OR EXISTS (SELECT 1 FROM public.cms_program_stores ps JOIN public.stores s ON s.id = ps.store_id
                 WHERE ps.program_id = v_prog.id AND NOT (s.store_type = 'os' AND s.is_active)) THEN
    RAISE EXCEPTION 'CMS_PROGRAM_STORE_INVALID' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.cms__lock_catalog();
  IF cardinality(public.cms__conflicts(v_prog.id, v_prog.is_test, v_prog.start_date, v_prog.end_date, v_ids)) > 0 THEN
    RAISE EXCEPTION 'CMS_ACTIVATE_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.cms_programs
     SET status = 'active', activated_at = now(), activated_by = p_actor, config_version = config_version + 1,
         updated_by = p_actor, updated_at = now()
   WHERE id = v_prog.id;
  RETURN jsonb_build_object('program_id', v_prog.id, 'started', v_today >= v_prog.start_date, 'ended', v_today > v_prog.end_date,
                            'stores', (SELECT count(*) FROM public.cms_program_stores WHERE program_id = v_prog.id));
END;
$$;

-- ── 6. ACL: thu hồi đích danh rồi cấp đúng ma trận ─────────────────────────
REVOKE ALL ON FUNCTION public.cms__vn_today(), public.cms__lock_catalog(),
  public.cms__conflicts(uuid, boolean, date, date, text[]), public.rpc_cms_program_save(jsonb),
  public.rpc_cms_import_preview_save(jsonb), public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid),
  public.rpc_cms_program_activate(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_program_save(jsonb), public.rpc_cms_import_preview_save(jsonb),
  public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid), public.rpc_cms_program_activate(uuid, uuid)
  TO service_role;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, x.grantee
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('cms__vn_today', 'cms__lock_catalog', 'cms__conflicts', 'rpc_cms_program_save',
                         'rpc_cms_import_preview_save', 'rpc_cms_import_commit', 'rpc_cms_program_activate')
       AND x.grantee <> p.proowner
       AND NOT (p.proname LIKE 'rpc\_cms\_%' AND x.grantee = 'service_role'::regrole::oid)
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
  r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proacl IS NULL AS acl_default,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ',')
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl
      FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('cms__vn_today', 'cms__lock_catalog', 'cms__conflicts', 'rpc_cms_program_save',
                         'rpc_cms_import_preview_save', 'rpc_cms_import_commit', 'rpc_cms_program_activate')
  LOOP
    IF NOT r.prosecdef OR NOT ('search_path=public' = ANY (r.proconfig)) THEN
      RAISE EXCEPTION '121 hậu kiểm: % phải SECURITY DEFINER + search_path=public', r.proname;
    END IF;
    IF r.proname LIKE 'rpc\_%' AND NOT ('lock_timeout=5s' = ANY (r.proconfig)) THEN
      RAISE EXCEPTION '121 hậu kiểm: % thiếu lock_timeout=5s', r.proname;
    END IF;
    IF r.acl_default OR r.acl IS DISTINCT FROM (CASE WHEN r.proname LIKE 'rpc\_%' THEN 'service_role:EXECUTE' ELSE NULL END) THEN
      RAISE EXCEPTION '121 hậu kiểm: ACL % = % (mặc định = %) sai ma trận', r.proname, r.acl, r.acl_default;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles ro ON ro.oid = p.proowner
                    WHERE p.oid = r.oid AND (ro.rolsuper OR ro.rolbypassrls)) THEN
      RAISE EXCEPTION '121 hậu kiểm: owner của % phải superuser / BYPASSRLS', r.proname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('cms__vn_today', 'cms__lock_catalog', 'cms__conflicts', 'rpc_cms_program_save',
                          'rpc_cms_import_preview_save', 'rpc_cms_import_commit', 'rpc_cms_program_activate')) <> 7 THEN
    RAISE EXCEPTION '121 hậu kiểm: số hàm khác 7 (overload lạ?)';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('121', 'cms_import_activation', 'CMS P1-b: RPC lưu chương trình / preview / commit import / kích hoạt (service_role, khoá danh mục, namespace is_test)');

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — Dev qua wrapper; sub-agent không gọi prod) ──
-- V1 marker:  SELECT version, name FROM public.app_migrations WHERE version IN ('120','121') ORDER BY 1;   -- 121 | cms_import_activation
-- V2 hàm:     SELECT p.oid::regprocedure, pg_get_userbyid(p.proowner) owner, p.prosecdef, p.proconfig, p.proacl::text,
--                    has_function_privilege('anon', p.oid, 'EXECUTE') anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x,
--                    has_function_privilege('service_role', p.oid, 'EXECUTE') svc_x
--               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--                AND p.proname IN ('cms__vn_today','cms__lock_catalog','cms__conflicts','rpc_cms_program_save',
--                                  'rpc_cms_import_preview_save','rpc_cms_import_commit','rpc_cms_program_activate') ORDER BY 1;
--             kỳ vọng 7 dòng: proacl chỉ owner (+ service_role:EXECUTE ở 4 rpc_cms_*); anon_x / auth_x f; svc_x t chỉ ở rpc_cms_*.
--             (Role owner / superuser như postgres luôn EXECUTE được theo quyền owner — không tính là cấp thêm.)
-- V3 ảnh ACL hàm cũ: cùng truy vấn ảnh PRE (loại cms_% / rpc_cms_%) ⇒ bằng ảnh PRE chụp NGAY TRƯỚC khi chạy 121.
-- V4 bất biến không trùng SP (kỳ vọng 0 dòng; chạy lại sau mỗi lần kích hoạt / QA):
--   SELECT a.product_id, a.program_id p1, b.program_id p2
--     FROM public.cms_program_products a JOIN public.cms_programs pa ON pa.id = a.program_id
--     JOIN public.cms_program_products b ON b.product_id = a.product_id AND b.program_id > a.program_id
--     JOIN public.cms_programs pb ON pb.id = b.program_id
--    WHERE pa.status IN ('active','locked') AND pb.status IN ('active','locked') AND pa.is_test = pb.is_test
--      AND pa.start_date <= pb.end_date AND pb.start_date <= pa.end_date;
-- V5 bậc liên tục, chỉ bậc cuối mở (kỳ vọng 0):
--   SELECT program_product_id FROM (SELECT program_product_id, tier_order, qty_from, qty_to,
--       lag(qty_to) OVER w prev_to, count(*) OVER (PARTITION BY program_product_id) n
--       FROM public.cms_program_tiers WINDOW w AS (PARTITION BY program_product_id ORDER BY tier_order)) t
--    WHERE (tier_order = 1 AND qty_from <> 1) OR (tier_order > 1 AND (prev_to IS NULL OR qty_from <> prev_to + 1))
--       OR (qty_to IS NULL AND tier_order <> n);
-- V6 chương trình đã kích hoạt có SP danh mục mà thiếu target (kỳ vọng 0):
--   SELECT p.id FROM public.cms_programs p WHERE p.status <> 'draft' AND p.catalog_target_gmv IS NULL
--      AND EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = p.id AND pp.gmv_basis = 'catalog');
-- V7 isolation mặc định (kỳ vọng read committed, không role nào đè):
--   SHOW default_transaction_isolation;
--   SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('authenticator', 'service_role');
