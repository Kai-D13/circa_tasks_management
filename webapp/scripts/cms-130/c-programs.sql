
-- ── 2. Chương trình: cách tính lượng + chính sách trả (thiết kế r2 §3) ─────
-- Backfill KHÔNG UPDATE (cms__programs_lock_guard chặn dòng locked, cms_config_auth_guard chặn non-owner): ADD COLUMN DEFAULT điền
-- nhanh mọi dòng có sẵn ⇒ ('pos_base', 'legacy_migration', 'sales_only_v1'), rồi bỏ DEFAULT của hai cột basis (INSERT mới phải đi qua
-- trigger tương thích). Không tăng config_version, không đổi pointer / tiền / kỳ / K / mức, không actor giả.
ALTER TABLE public.cms_programs
  ADD COLUMN quantity_basis         text        DEFAULT 'pos_base',
  ADD COLUMN quantity_basis_source  text        NOT NULL DEFAULT 'legacy_migration',
  ADD COLUMN quantity_basis_set_by  uuid,
  ADD COLUMN quantity_basis_set_at  timestamptz,
  ADD COLUMN returns_policy         text        NOT NULL DEFAULT 'sales_only_v1',
  ADD COLUMN returns_policy_set_by  uuid,
  ADD COLUMN returns_policy_set_at  timestamptz;
ALTER TABLE public.cms_programs
  ALTER COLUMN quantity_basis DROP DEFAULT,
  ALTER COLUMN quantity_basis_source DROP DEFAULT,
  ADD CONSTRAINT cms_programs_basis_value CHECK (quantity_basis IS NULL OR quantity_basis IN ('pos_base', 'cms_unit')),
  ADD CONSTRAINT cms_programs_basis_source_value
    CHECK (quantity_basis_source IN ('legacy_migration', 'legacy_compat', 'admin', 'pending')),
  ADD CONSTRAINT cms_programs_returns_policy_value CHECK (returns_policy IN ('sales_only_v1', 'net_returns_v1')),
  -- pending ⇔ chưa chọn; nháp được chưa chọn, active / locked thì phải có.
  ADD CONSTRAINT cms_programs_basis_state CHECK ((quantity_basis_source = 'pending') = (quantity_basis IS NULL)),
  ADD CONSTRAINT cms_programs_basis_draft CHECK (status = 'draft' OR quantity_basis IS NOT NULL),
  -- Actor: legacy_* không actor; admin / pending có người chọn + thời điểm.
  ADD CONSTRAINT cms_programs_basis_actor CHECK (
    (quantity_basis_source IN ('admin', 'pending')) = (quantity_basis_set_by IS NOT NULL)
    AND (quantity_basis_set_by IS NULL) = (quantity_basis_set_at IS NULL)),
  ADD CONSTRAINT cms_programs_policy_actor CHECK (
    (returns_policy = 'net_returns_v1') = (returns_policy_set_by IS NOT NULL)
    AND (returns_policy_set_by IS NULL) = (returns_policy_set_at IS NULL));

-- Trigger tương thích (BEFORE ROW, ENABLE ALWAYS). INSERT không mang basis (mọi INSERT của rpc_cms_program_save 121: client cũ, app cờ
-- OFF, bước đầu của save_v2) ⇒ ('pos_base', 'legacy_compat'). Đổi basis chỉ ở nháp, kèm config_version tăng, không quay về legacy_*.
-- Kích hoạt cần basis + (cms_unit) mọi đơn vị CMS có khoá hợp lệ. Chính sách trả chỉ một chiều sales_only_v1 → net_returns_v1.
CREATE FUNCTION public.cms__programs_basis_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.quantity_basis_source IS NOT NULL OR NEW.quantity_basis IS NOT NULL
       OR NEW.quantity_basis_set_by IS NOT NULL OR NEW.quantity_basis_set_at IS NOT NULL THEN
      RAISE EXCEPTION 'CMS_BASIS_INVALID' USING ERRCODE = '22023';
    END IF;
    IF NEW.returns_policy IS DISTINCT FROM 'sales_only_v1' OR NEW.returns_policy_set_by IS NOT NULL OR NEW.returns_policy_set_at IS NOT NULL THEN
      RAISE EXCEPTION 'CMS_RETURNS_POLICY_INVALID' USING ERRCODE = '22023';
    END IF;
    NEW.quantity_basis := 'pos_base';
    NEW.quantity_basis_source := 'legacy_compat';
    RETURN NEW;
  END IF;
  IF (NEW.quantity_basis, NEW.quantity_basis_source, NEW.quantity_basis_set_by, NEW.quantity_basis_set_at)
       IS DISTINCT FROM (OLD.quantity_basis, OLD.quantity_basis_source, OLD.quantity_basis_set_by, OLD.quantity_basis_set_at) THEN
    IF OLD.status <> 'draft' OR NEW.status <> 'draft' OR NEW.config_version <= OLD.config_version THEN
      RAISE EXCEPTION 'CMS_BASIS_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.quantity_basis_source NOT IN ('admin', 'pending') THEN
      RAISE EXCEPTION 'CMS_BASIS_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF (NEW.returns_policy, NEW.returns_policy_set_by, NEW.returns_policy_set_at)
       IS DISTINCT FROM (OLD.returns_policy, OLD.returns_policy_set_by, OLD.returns_policy_set_at) THEN
    IF OLD.returns_policy = 'net_returns_v1' THEN
      RAISE EXCEPTION 'CMS_RETURNS_POLICY_REGRESSION' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.returns_policy <> 'net_returns_v1' OR OLD.status NOT IN ('draft', 'active') OR NEW.status <> OLD.status
       OR NEW.config_version <= OLD.config_version OR NEW.quantity_basis IS NULL THEN
      RAISE EXCEPTION 'CMS_RETURNS_POLICY_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'active' THEN
    IF NEW.quantity_basis IS NULL THEN
      RAISE EXCEPTION 'CMS_BASIS_NOT_SET' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.quantity_basis = 'cms_unit' AND EXISTS (
         SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = NEW.id AND public.cms__unit_key(pp.unit_cms) IS NULL) THEN
      RAISE EXCEPTION 'CMS_UNIT_CMS_INVALID' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cms_programs_basis_guard BEFORE INSERT OR UPDATE ON public.cms_programs
  FOR EACH ROW EXECUTE FUNCTION public.cms__programs_basis_guard();
ALTER TABLE public.cms_programs ENABLE ALWAYS TRIGGER cms_programs_basis_guard;

-- SP chỉ vào chương trình đã chọn basis; chương trình cms_unit nhận SP khi đơn vị CMS có khoá hợp lệ (kể cả append vào active).
-- Chạy SAU cms_config_lock_guard (tên) ⇒ dòng chương trình đã khoá FOR SHARE, basis không đổi xen giữa.
CREATE FUNCTION public.cms__products_basis_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_basis  text;
  v_source text;
BEGIN
  SELECT p.quantity_basis, p.quantity_basis_source INTO v_basis, v_source FROM public.cms_programs p WHERE p.id = NEW.program_id;
  IF v_source = 'pending' THEN
    RAISE EXCEPTION 'CMS_BASIS_NOT_SET' USING ERRCODE = 'P0001';
  END IF;
  IF v_basis = 'cms_unit' AND public.cms__unit_key(NEW.unit_cms) IS NULL THEN
    RAISE EXCEPTION 'CMS_UNIT_CMS_INVALID' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cms_products_basis_guard BEFORE INSERT OR UPDATE ON public.cms_program_products
  FOR EACH ROW EXECUTE FUNCTION public.cms__products_basis_guard();
ALTER TABLE public.cms_program_products ENABLE ALWAYS TRIGGER cms_products_basis_guard;

-- Lưu chương trình kèm cách tính (app cờ CMS_CALC_MODES_ENABLED). Bắt buộc quantity_basis ∈ {pos_base, cms_unit, pending}; gọi
-- NGUYÊN rpc_cms_program_save 121 (không khoá lạ), rồi đặt cặp (basis, source) đích + actor + config_version tăng trong CÙNG transaction.
-- Chương trình tạo bằng v2 không bao giờ còn legacy_compat. Sửa basis ngoài nháp ⇒ CMS_BASIS_IMMUTABLE (rollback cả phần 121).
CREATE FUNCTION public.rpc_cms_program_save_v2(p jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_id     uuid;
  v_basis  text;
  v_source text;
  v_actor  uuid;
  v_prog   public.cms_programs%ROWTYPE;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p -> 'quantity_basis') IS DISTINCT FROM 'string'
     OR (p ->> 'quantity_basis') NOT IN ('pos_base', 'cms_unit', 'pending') THEN
    RAISE EXCEPTION 'CMS_BASIS_REQUIRED' USING ERRCODE = '22023';
  END IF;
  v_id := public.rpc_cms_program_save(p - 'quantity_basis');
  v_actor := (p ->> 'actor')::uuid;  -- 121 đã kiểm dạng uuid
  v_basis := NULLIF(p ->> 'quantity_basis', 'pending');
  v_source := CASE WHEN v_basis IS NULL THEN 'pending' ELSE 'admin' END;
  -- Phòng thủ chiều sâu (security-reviewer 14/11 P1-1): actor phải là admin (điều kiện cần của super; không chép allowlist).
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_actor AND u.role = 'admin') THEN
    RAISE EXCEPTION 'CMS_ACTOR_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_id FOR UPDATE;
  -- Ngoài nháp chỉ cấm ĐỔI basis; cùng basis giữ nguyên nguồn (legacy_*) ⇒ vẫn sửa được chương trình active chưa bắt đầu như 121
  -- (db-reviewer 14/11 P2-7).
  IF v_prog.status <> 'draft' THEN
    IF v_prog.quantity_basis IS DISTINCT FROM v_basis THEN
      RAISE EXCEPTION 'CMS_BASIS_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
  ELSIF (v_prog.quantity_basis, v_prog.quantity_basis_source) IS DISTINCT FROM (v_basis, v_source) THEN
    UPDATE public.cms_programs
       SET quantity_basis = v_basis, quantity_basis_source = v_source, quantity_basis_set_by = v_actor, quantity_basis_set_at = now(),
           config_version = config_version + 1, updated_by = v_actor, updated_at = now()
     WHERE id = v_id;
  END IF;
  RETURN v_id;
END;
$$;

-- Chuyển chương trình sang trừ trả hàng (một chiều). App chỉ gọi khi CMS_RETURNS_ENABLED + nguồn trả đạt readiness (mốc B).
CREATE FUNCTION public.rpc_cms_program_set_returns_policy(p_program_id uuid, p_policy text, p_expected_config_version integer, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_prog public.cms_programs%ROWTYPE;
BEGIN
  IF p_program_id IS NULL OR p_actor IS NULL OR p_expected_config_version IS NULL THEN
    RAISE EXCEPTION 'CMS_RETURNS_POLICY_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF p_policy IS DISTINCT FROM 'net_returns_v1' THEN
    RAISE EXCEPTION 'CMS_RETURNS_POLICY_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_prog.returns_policy = 'net_returns_v1' THEN
    RETURN jsonb_build_object('program_id', v_prog.id, 'returns_policy', v_prog.returns_policy, 'config_version', v_prog.config_version,
                              'already', true);
  END IF;
  IF v_prog.status NOT IN ('draft', 'active') THEN
    RAISE EXCEPTION 'CMS_PROGRAM_NOT_EDITABLE' USING ERRCODE = 'P0001';
  END IF;
  IF v_prog.config_version <> p_expected_config_version THEN
    RAISE EXCEPTION 'CMS_CONFIG_STALE' USING ERRCODE = 'P0001';
  END IF;
  IF v_prog.quantity_basis IS NULL THEN
    RAISE EXCEPTION 'CMS_BASIS_NOT_SET' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs r WHERE r.program_id = p_program_id AND r.status = 'running') THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_BUSY' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_actor) THEN
    RAISE EXCEPTION 'CMS_RETURNS_POLICY_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- Phòng thủ chiều sâu (security-reviewer 14/11 P1-1): người bật net phải là admin (điều kiện cần của super; allowlist super chỉ ở
  -- authz.ts + is_super_admin(), KHÔNG chép thêm). App vẫn kiểm super bằng phiên trước khi gọi service_role.
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_actor AND u.role = 'admin') THEN
    RAISE EXCEPTION 'CMS_ACTOR_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.cms_programs
     SET returns_policy = 'net_returns_v1', returns_policy_set_by = p_actor, returns_policy_set_at = now(),
         config_version = config_version + 1, updated_by = p_actor, updated_at = now()
   WHERE id = p_program_id;
  RETURN jsonb_build_object('program_id', p_program_id, 'returns_policy', 'net_returns_v1', 'config_version', v_prog.config_version + 1,
                            'already', false);
END;
$$;

-- Năng lực DB cho app (PM r2: SUY từ catalog — RPC có mặt + EXECUTE của đúng vai trò gọi, hàm nội bộ có mặt, bảng / cột có mặt; không
-- khai hằng). DB trước 130 ⇒ PostgREST 404 ⇒ app chỉ dùng đường 121–126. Mỗi đường trả {ok, rpcs}; app (lib/cms/calc/capabilities.ts)
-- chỉ dùng đường khi ok VÀ danh sách RPC = danh sách nó biết. Đường KHÔNG có trong batch — chốt run contract (cms__lock_eval chặn
-- CMS_LOCK_CONTRACT_UNSUPPORTED) — luôn false tường minh. Không dữ liệu.
CREATE FUNCTION public.rpc_cms_capabilities()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH r(path, fn, sig, role) AS (VALUES
    ('program_modes', 'rpc_cms_program_save_v2', 'public.rpc_cms_program_save_v2(jsonb)', 'service_role'),
    ('program_modes', 'rpc_cms_program_set_returns_policy', 'public.rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_snapshot', 'public.rpc_cms_sales_snapshot(uuid)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_run_open', 'public.rpc_cms_sales_run_open(uuid,jsonb)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_run_stage', 'public.rpc_cms_sales_run_stage(uuid,text,integer,jsonb)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_run_seal_begin', 'public.rpc_cms_sales_run_seal_begin(uuid,jsonb)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_run_seal_step', 'public.rpc_cms_sales_run_seal_step(uuid,integer)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_run_publish', 'public.rpc_cms_sales_run_publish(uuid)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_run_finish', 'public.rpc_cms_sales_run_finish(uuid,text,jsonb)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_run_cleanup', 'public.rpc_cms_sales_run_cleanup(uuid,integer)', 'service_role'),
    ('readers_v2', 'rpc_cms_result_header_v2', 'public.rpc_cms_result_header_v2(uuid)', 'authenticated'),
    ('readers_v2', 'rpc_cms_result_rows_v2', 'public.rpc_cms_result_rows_v2(uuid,uuid)', 'authenticated'),
    ('readers_v2', 'rpc_cms_result_events_v2', 'public.rpc_cms_result_events_v2(uuid,uuid,uuid,uuid,integer,integer)', 'authenticated'),
    ('readers_v2', 'rpc_cms_result_excluded_v2', 'public.rpc_cms_result_excluded_v2(uuid,uuid,text,integer,integer)', 'authenticated'),
    ('readers_v2', 'rpc_cms_result_returns_v2', 'public.rpc_cms_result_returns_v2(uuid,uuid,integer,integer)', 'authenticated'),
    ('returns_ledger', 'rpc_cms_return_conflicts', 'public.rpc_cms_return_conflicts(uuid)', 'authenticated'),
    ('returns_ledger', 'rpc_cms_return_conflicts_confirm_restored', 'public.rpc_cms_return_conflicts_confirm_restored(uuid,text,bigint,text,uuid)',
     'authenticated'),
    ('close_report', 'rpc_cms_return_close_report_save', 'public.rpc_cms_return_close_report_save(uuid,uuid,jsonb)', 'service_role'),
    ('close_report', 'rpc_cms_frozen_sales_lines', 'public.rpc_cms_frozen_sales_lines(uuid,integer,integer)', 'service_role'),
    ('close_report', 'rpc_cms_return_close_reports', 'public.rpc_cms_return_close_reports(uuid)', 'authenticated'),
    ('close_report', 'rpc_cms_return_close_report', 'public.rpc_cms_return_close_report(uuid,integer,integer)', 'authenticated'),
    ('close_report', 'rpc_cms_return_close_report_events', 'public.rpc_cms_return_close_report_events(uuid,text,integer)', 'authenticated')
  ), i(path, sig) AS (VALUES
    ('program_modes', 'public.cms__programs_basis_guard()'),
    ('contract_run', 'public.cms__stage_contract(uuid,text,integer,jsonb)'),
    ('contract_run', 'public.cms__seal_begin_contract(uuid,jsonb)'),
    ('contract_run', 'public.cms__seal_contract_step(uuid,integer)'),
    ('contract_run', 'public.cms__publish_contract(uuid)'),
    ('readers_v2', 'public.cms__run_contract(uuid)'),
    ('returns_ledger', 'public.cms__ledger_eval(uuid,text,uuid,timestamp with time zone,text,jsonb)'),
    ('returns_ledger', 'public.cms__ledger_insert_guard()'),
    ('returns_ledger', 'public.cms__as_of_floor(uuid)'),
    ('close_report', 'public.cms__report_rows(jsonb)')
  ), t(path, rel, col) AS (VALUES
    ('program_modes', 'cms_programs', 'quantity_basis'), ('program_modes', 'cms_programs', 'returns_policy'),
    ('contract_run', 'cms_sync_runs', 'calc_contract_version'), ('contract_run', 'cms_sales_source_lines', 'src_v'),
    ('contract_run', 'cms_return_lines', 'disposition'), ('contract_run', 'cms_result_events', 'event_key'),
    ('readers_v2', 'cms_result_events', 'event_key'),
    ('returns_ledger', 'cms_return_ledger_evals', 'eval_seq'), ('returns_ledger', 'cms_return_baselines', 'financial_fp'),
    ('returns_ledger', 'cms_return_conflicts', 'prev_conflict_id'), ('returns_ledger', 'cms_return_restorations', 'open_set_hash'),
    ('close_report', 'cms_return_close_reports', 'idem_key'), ('close_report', 'cms_return_close_report_lines', 'recomputed_amount'),
    ('close_report', 'cms_return_close_report_events', 'disposition')
  ), ok AS (
    SELECT p.path,
           COALESCE((SELECT bool_and(COALESCE(has_function_privilege(r.role, to_regprocedure(r.sig), 'EXECUTE'), false)) FROM r WHERE r.path = p.path), false)
           AND COALESCE((SELECT bool_and(to_regprocedure(i.sig) IS NOT NULL) FROM i WHERE i.path = p.path), true)
           AND COALESCE((SELECT bool_and(EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public.' || t.rel)
                                                   AND a.attname = t.col AND a.attnum > 0 AND NOT a.attisdropped))
                           FROM t WHERE t.path = p.path), true) AS ok
      FROM (SELECT DISTINCT r.path FROM r) p
  )
  SELECT jsonb_build_object(
    'calc_contract', '@@CALC_CONTRACT@@', 'status_dictionary', '@@STATUS_VERSION@@', 'fp', '@@FP_VERSION@@', 'source_pin', '@@SOURCE_PIN@@',
    'src_digest', '@@SRC_DIGEST@@', 'unit_key', '@@UNIT_KEY_VERSION@@', 'program_save', 2, 'readers', 2,
    'paths', (SELECT jsonb_object_agg(ok.path, jsonb_build_object('ok', ok.ok, 'rpcs', (SELECT jsonb_agg(r.fn ORDER BY r.fn) FROM r WHERE r.path = ok.path)))
                FROM ok)
             || jsonb_build_object('lock_contract', jsonb_build_object('ok', false, 'rpcs', '[]'::jsonb)))
$$;
