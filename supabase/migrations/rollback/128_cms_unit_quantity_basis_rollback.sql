-- ============================================================================
-- rollback/128_cms_unit_quantity_basis_rollback.sql  (bản PM-r1 — CMS-UNIT capability, Dev 09–10/11/2026; KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-128.mjs: khôi phục NGUYÊN VĂN 17 hàm (bản cuối trước 128: 121 / 122 / 123 / 124 / 125 / 126) +
-- ACL, gỡ 2 trigger guard + 5 helper, gỡ ràng buộc / cột cơ sở tính (cms_programs.quantity_basis; cms_sync_runs.quantity_basis /
-- calculation_policy_version / calculation_snapshot), xoá marker 128; hậu kiểm md5 thân khôi phục + ACL + tổng hàm 68.
-- CHỈ dùng TRƯỚC khi có dữ liệu cms_unit (spec §5 rollback schema): có chương trình cơ sở cms_unit HOẶC run mang cơ sở cms_unit (mọi
-- trạng thái) ⇒ DỪNG — không drop metadata làm mất nghĩa lịch sử; xử lý tiến (đổi chương trình về pos_base bằng transaction bù có
-- version tăng tiếp, giữ app / reader mới). Run pos_base_v1 tạo sau 128 mất metadata (đọc như run cũ — cùng luật pos_base).
-- Thứ tự vận hành: app về bản không đọc metadata 128 (hoặc giữ app mới — app mới tương thích DB không có 128: snapshot thiếu khoá
-- quantity_basis ⇒ luật pos_base legacy), tạm dừng task CMS sales, không run bán running, rồi chạy file này.
-- Dừng nếu: thiếu marker 128 · có migration > 128 · owner / isolation sai · thân 17 hàm hiện tại khác bản 128 đã sinh.
-- Sau rollback: `cms-verify post --phase=127` (PRE chụp trước 128) phải ĐẠT.
-- Vận hành: DÁN NGUYÊN FILE, nên GIỮ LF. Chạy bằng ĐÚNG role owner bảng / hàm CMS. Gồm DELETE FROM app_migrations WHERE version = '128'.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.cms_programs IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.cms_sync_runs IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'rollback 128: cần READ COMMITTED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '128' AND name = 'cms_unit_quantity_basis') THEN
    RAISE EXCEPTION 'rollback 128: không có marker 128';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 128) THEN
    RAISE EXCEPTION 'rollback 128: DB đã có migration số > 128 — rollback theo thứ tự ngược trước';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION 'rollback 128: role chạy (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_programs'::regclass, 'public.cms_sync_runs'::regclass, 'public.cms_sales_lines'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'rollback 128: owner bảng / hàm CMS khác role chạy (%) — chạy bằng owner', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_programs WHERE quantity_basis <> 'pos_base')
     OR EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE quantity_basis IS DISTINCT FROM 'pos_base' AND kind = 'sales') THEN
    RAISE EXCEPTION 'rollback 128: đã có chương trình / run cơ sở cms_unit — KHÔNG drop metadata lịch sử; xử lý tiến (transaction bù)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running') THEN
    RAISE EXCEPTION 'rollback 128: còn run bán running — tạm dừng task CMS sales trước';
  END IF;
END $$;
-- Thân 17 hàm hiện tại phải đúng bản 128 đã sinh — khối sinh bởi gen-cms-128.mjs.
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__sales_snapshot(uuid)'::regprocedure) IS DISTINCT FROM '6aeef9d9b8cdd085a5684819e008fc1d'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__config_fp(uuid)'::regprocedure) IS DISTINCT FROM '8534cfcbebecc0bd699e8ccecd9bcdd4'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__attest_eval(uuid, uuid)'::regprocedure) IS DISTINCT FROM '3f9f3d9ad9697caab34991082b58a45c'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__lock_eval(uuid, uuid, integer, text, boolean)'::regprocedure) IS DISTINCT FROM 'ded0e1ccc95ffbb78c8aac29ad923b59'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_program_save(jsonb)'::regprocedure) IS DISTINCT FROM '91001438180ea2982a463b02c2464af3'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid)'::regprocedure) IS DISTINCT FROM '69176cc50730bebd46af56aee555fbea'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_program_activate(uuid, uuid)'::regprocedure) IS DISTINCT FROM 'fe46b372821db6d9919fcb810a2ec15a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_open(uuid, jsonb)'::regprocedure) IS DISTINCT FROM '72fc2ed6e219b2238d596b6e2e422b5e'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_seal_begin(uuid, jsonb)'::regprocedure) IS DISTINCT FROM 'b81e7dd702a0ad579ad8515357eb8538'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_seal_step(uuid, integer)'::regprocedure) IS DISTINCT FROM 'd68aabb675d8ee609ea769dbf36efaeb'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure) IS DISTINCT FROM 'cfeaf8d5f8e3e9ee2572a4596ea16f1a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_finish(uuid, text, jsonb)'::regprocedure) IS DISTINCT FROM 'a942cf5e645770faa3b1717539923609'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_result_header(uuid)'::regprocedure) IS DISTINCT FROM 'a55a96a70796163a8f6dcd9b042d3931'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_result_rows(uuid, uuid)'::regprocedure) IS DISTINCT FROM 'c32b8e2183e4fc9e9914abfc770a6b3f'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer)'::regprocedure) IS DISTINCT FROM '79f3960c3e7a4b186056fcd6e09839c5'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid)'::regprocedure) IS DISTINCT FROM '74cd1e68de442952596576c803594be7'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_run_source_export(uuid, uuid, text, integer)'::regprocedure) IS DISTINCT FROM 'b4cf8f9fe5f5b7d6201f9e51e3aa690f' THEN
    RAISE EXCEPTION 'rollback 128 preflight: thân 17 hàm hiện tại KHÁC bản 128 đã sinh (md5) — có sửa tay? dừng, đối chiếu';
  END IF;
END $$;

-- Gỡ trigger + ràng buộc TRƯỚC khi khôi phục thân hàm (thân cũ không đọc / ghi cột 128).
DROP TRIGGER cms_programs_basis_guard ON public.cms_programs;
DROP TRIGGER cms_sync_runs_basis_guard ON public.cms_sync_runs;
ALTER TABLE public.cms_sync_runs DROP CONSTRAINT cms_sync_runs_basis_shape;

-- ── Khôi phục NGUYÊN VĂN 17 hàm (bản cuối trước 128) ──────────────────────────
CREATE OR REPLACE FUNCTION public.cms__sales_snapshot(p_program_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'program_id', p.id,
    'status', p.status,
    'is_test', p.is_test,
    'config_version', p.config_version,
    'start_date', to_char(p.start_date, 'YYYY-MM-DD'),
    'end_date', to_char(p.end_date, 'YYYY-MM-DD'),
    'catalog_target_gmv', p.catalog_target_gmv::text,
    'today_vn', to_char(public.cms__vn_today(), 'YYYY-MM-DD'),
    'current_result_run_id', p.current_result_run_id,
    'previous_rows_read', (SELECT r.rows_read FROM public.cms_sync_runs r WHERE r.id = p.current_result_run_id),
    'store_ids', COALESCE((SELECT jsonb_agg(ps.store_id ORDER BY ps.store_id) FROM public.cms_program_stores ps
                            WHERE ps.program_id = p.id), '[]'::jsonb),
    'products', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', pp.id, 'product_id', pp.product_id, 'gmv_basis', pp.gmv_basis, 'target_gmv', pp.target_gmv::text,
        'base_quantity_cms', pp.base_quantity_cms::text,
        'tiers', COALESCE((SELECT jsonb_agg(jsonb_build_object('order', t.tier_order, 'from', t.qty_from, 'to', t.qty_to,
                                                               'amount', t.amount_per_unit::text) ORDER BY t.tier_order)
                             FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id), '[]'::jsonb))
        ORDER BY pp.product_id) FROM public.cms_program_products pp WHERE pp.program_id = p.id), '[]'::jsonb),
    'sellers', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email, 'role', u.role, 'store_id', u.store_id)
                                          ORDER BY u.id) FROM public.users u), '[]'::jsonb),
    'stores', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'store_type', s.store_type, 'is_active', s.is_active)
                                         ORDER BY s.id) FROM public.stores s), '[]'::jsonb),
    'mapping_fp', public.cms__mapping_fp())
  FROM public.cms_programs p WHERE p.id = p_program_id
$$;

CREATE OR REPLACE FUNCTION public.cms__config_fp(p_program_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT md5(
    COALESCE((SELECT ROW(p.id, p.name, p.start_date, p.end_date, p.scope, p.catalog_target_gmv, p.calc_mode, p.gate_scope,
                         p.is_test, p.config_version)::text
                FROM public.cms_programs p WHERE p.id = p_program_id), '')
    || chr(29) ||
    COALESCE((SELECT string_agg(ROW(pp.id, pp.product_id, pp.gmv_basis, pp.target_gmv, pp.unit_cms, pp.base_quantity_cms)::text,
                                chr(30) ORDER BY pp.id)
                FROM public.cms_program_products pp WHERE pp.program_id = p_program_id), '')
    || chr(29) ||
    COALESCE((SELECT string_agg(ROW(t.program_product_id, t.tier_order, t.qty_from, t.qty_to, t.amount_per_unit)::text,
                                chr(30) ORDER BY t.program_product_id, t.tier_order)
                FROM public.cms_program_tiers t WHERE t.program_id = p_program_id), '')
    || chr(29) ||
    COALESCE((SELECT string_agg(s.store_id::text, chr(30) ORDER BY s.store_id)
                FROM public.cms_program_stores s WHERE s.program_id = p_program_id), ''))
$$;

CREATE OR REPLACE FUNCTION public.cms__attest_eval(p_program_id uuid, p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a    public.cms_source_attestations%ROWTYPE;
  v_run  public.cms_sync_runs%ROWTYPE;
  v_prog public.cms_programs%ROWTYPE;
  v_code text;
BEGIN
  SELECT * INTO v_a FROM public.cms_source_attestations
   WHERE run_id = p_run_id AND program_id = p_program_id AND revoked_at IS NULL AND superseded_by IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('code', 'NONE'); END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id;
  -- Kiểm lại MỌI trường quyết định của dòng chứng nhận (phòng dòng owner ghi thẳng — db-reviewer r2 P2-3).
  v_code := CASE
    WHEN v_run.config_version IS DISTINCT FROM v_a.config_version OR v_prog.config_version IS DISTINCT FROM v_a.config_version THEN 'STALE_CONFIG'
    WHEN v_run.mapping_fp IS DISTINCT FROM v_a.mapping_fp OR public.cms__mapping_fp() IS DISTINCT FROM v_a.mapping_fp THEN 'STALE_MAPPING'
    WHEN v_a.scope_from IS DISTINCT FROM v_prog.start_date OR v_a.scope_to IS DISTINCT FROM v_prog.end_date
      OR public.cms__program_scope_hash(p_program_id) IS DISTINCT FROM v_a.scope_hash THEN 'STALE_SCOPE'
    WHEN v_a.as_of < ((v_prog.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') THEN 'AS_OF'
  END;
  IF v_code IS NULL THEN v_code := public.cms__run_source_check(p_run_id); END IF;
  IF v_code IS NULL AND v_a.lines_compared IS DISTINCT FROM (SELECT count(*) FROM public.cms_sales_source_lines WHERE run_id = p_run_id) THEN
    v_code := 'COUNT';
  END IF;
  -- Phòng thủ (PM COMP-P1-1): chỉ decision10 là bằng chứng; vân tay luôn tính lại decision10 từ lớp nguồn DB.
  IF v_code IS NULL AND v_a.field_set IS DISTINCT FROM 'decision10' THEN v_code := 'FIELD_SET'; END IF;
  IF v_code IS NULL AND public.cms__run_source_fp(p_run_id, 'decision10') IS DISTINCT FROM v_a.run_rows_fp THEN
    v_code := 'FP_CHANGED';
  END IF;
  RETURN jsonb_build_object('id', v_a.id, 'scope_to', to_char(v_a.scope_to, 'YYYY-MM-DD'), 'field_set', v_a.field_set,
                            'attested_at', public.cms__ts(v_a.attested_at), 'as_of', public.cms__ts(v_a.as_of), 'code', v_code);
END;
$$;

CREATE OR REPLACE FUNCTION public.cms__lock_eval(p_program_id uuid, p_expected_run_id uuid, p_expected_policy_version integer,
                                      p_ack_reason text, p_require_ack boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog     public.cms_programs%ROWTYPE;
  v_run      public.cms_sync_runs%ROWTYPE;
  v_pol      jsonb := public.cms__lock_policy();
  v_ver      integer;
  v_br       jsonb;
  v_b        text[] := '{}';
  v_end_vn   timestamptz;
  v_earliest timestamptz;
  v_basis    text;
  v_through  date;
  v_fp_now   text;
  v_sum      numeric;
  v_rows     integer;
  v_paid     integer;
  v_multi    integer;
  v_cl       integer := 0;
  v_cg       numeric := 0;
  v_ul       integer := 0;
  v_ug       numeric := 0;
  v_over     boolean := false;
  v_ack_need boolean := false;
  v_ack_ok   boolean;
  v_pol_ok   boolean;
  v_sealed_ok boolean;
  v_att      jsonb := jsonb_build_object('code', 'NONE');  -- 124
  v_att_ok   boolean;                                       -- 124
BEGIN
  v_ver := (v_pol ->> 'version')::integer;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('program_id', p_program_id, 'found', false, 'blockers', jsonb_build_array('CMS_PROGRAM_NOT_FOUND'));
  END IF;
  v_br := CASE WHEN v_prog.is_test THEN v_pol -> 'qa' ELSE v_pol -> 'real' END;
  v_end_vn := ((v_prog.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
  -- 2–3. trạng thái / hết kỳ
  IF v_prog.status = 'locked' THEN
    v_b := array_append(v_b, 'CMS_PROGRAM_LOCKED');
  ELSIF v_prog.status <> 'active' OR v_prog.end_date >= public.cms__vn_today() THEN
    v_b := array_append(v_b, 'CMS_LOCK_NOT_ENDED');
  END IF;
  -- 4. Q-206: chương trình thật cần cổng công bố DB mở
  IF NOT v_prog.is_test AND NOT public.cms__results_release_open() THEN
    v_b := array_append(v_b, 'CMS_LOCK_RELEASE_GATE');
  END IF;
  -- 5. pointer
  IF v_prog.current_result_run_id IS NULL THEN
    v_b := array_append(v_b, 'CMS_LOCK_NO_RESULT');
  ELSIF p_expected_run_id IS NOT NULL AND v_prog.current_result_run_id <> p_expected_run_id THEN
    v_b := array_append(v_b, 'CMS_LOCK_RUN_CHANGED');
  END IF;
  IF v_prog.current_result_run_id IS NOT NULL THEN
    SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = v_prog.current_result_run_id;
    -- 6. run hiện hành phải là run sales đã công bố, chưa dọn, cùng config_version / is_test
    IF v_run.kind IS DISTINCT FROM 'sales' OR v_run.status IS DISTINCT FROM 'ok' OR v_run.published_at IS NULL
       OR v_run.purged_at IS NOT NULL OR v_run.config_version IS DISTINCT FROM v_prog.config_version
       OR v_run.is_test IS DISTINCT FROM v_prog.is_test OR v_run.amount_vnd IS NULL THEN
      v_b := array_append(v_b, 'CMS_LOCK_STALE_RUN');
    END IF;
  END IF;
  -- 7. policy
  IF p_expected_policy_version IS NOT NULL AND p_expected_policy_version <> v_ver THEN
    v_b := array_append(v_b, 'CMS_LOCK_POLICY_CHANGED');
  END IF;
  -- Nhánh policy dùng được: QA (giả định gắn nhãn) hoặc thật đã ready; ĐỦ khoá ngưỡng / chờ / nguồn — thiếu ⇒ pending
  -- (db-reviewer P2-2: mở nhánh thật mà quên một khoá thì không lọt chốt không kiểm ngưỡng).
  -- COALESCE: khoá thiếu ⇒ jsonb_typeof(NULL) = … là NULL — không để NULL lọt qua IF NOT (test 123 bắt được).
  v_pol_ok := COALESCE((v_prog.is_test OR COALESCE((v_br ->> 'ready')::boolean, false))
              AND jsonb_typeof(v_br -> 'unassigned_max_gmv_bp') = 'number' AND jsonb_typeof(v_br -> 'unassigned_max_lines') = 'number'
              AND jsonb_typeof(v_br -> 'wait_hours') = 'number' AND jsonb_typeof(v_br -> 'completeness') = 'string'
              -- số nguyên không âm (db-reviewer r0.1 finding 2): phân số ⇒ lỗi ép kiểu thô; wait_hours âm ⇒ chốt trước hết kỳ.
              AND (v_br ->> 'unassigned_max_gmv_bp') ~ '^[0-9]{1,6}$' AND (v_br ->> 'unassigned_max_lines') ~ '^[0-9]{1,6}$'
              AND (v_br ->> 'wait_hours') ~ '^[0-9]{1,4}$', false);
  IF NOT v_pol_ok THEN
    v_b := array_append(v_b, 'CMS_LOCK_POLICY_PENDING');
  END IF;
  IF v_run.id IS NOT NULL THEN
    -- 8. thời điểm (+ chờ Q-216 theo policy) + nguồn đầy đủ (D3). 'qa_assumption' chỉ cho QA; cơ sở thật (bi_watermark /
    --    lag_commitment) chưa có nơi lưu chứng nhận gắn run ⇒ chặn cho tới migration hợp đồng nguồn.
    v_earliest := v_end_vn + make_interval(hours => CASE WHEN v_pol_ok THEN (v_br ->> 'wait_hours')::integer ELSE 0 END);
    v_basis := CASE WHEN v_pol_ok THEN v_br ->> 'completeness' END;
    IF v_run.started_at < v_earliest THEN
      v_b := array_append(v_b, 'CMS_LOCK_RUN_TOO_EARLY');
    END IF;
    -- 124: chứng nhận đối soát nguồn decision10 CÒN HIỆU LỰC của đúng run hiện hành, kiểm lại config / mapping / scope / lớp nguồn
    -- / vân tay ⇒ basis operator_reconciliation, đủ tới ngày kết thúc. Chỉ dùng khi chương trình QA, hoặc policy thật đã sẵn sàng
    -- VÀ khai completeness = 'operator_reconciliation' (không để chứng nhận vượt policy khai cơ sở khác). Thật hiện real.ready =
    -- false ⇒ không dùng ⇒ SOURCE_INCOMPLETE + POLICY_PENDING; cổng Q-206 vẫn đóng.
    -- Có chứng nhận nhưng không dùng được ⇒ CMS_LOCK_ATTEST_INVALID (KHÔNG âm thầm lùi về qa_assumption). Không có ⇒ như 123.
    v_att := public.cms__attest_eval(v_prog.id, v_run.id);
    v_att_ok := v_prog.is_test OR (v_pol_ok AND (v_br ->> 'completeness') = 'operator_reconciliation');
    IF v_att_ok AND (v_att ->> 'code') IS NULL THEN
      v_basis := 'operator_reconciliation';
      v_through := (v_att ->> 'scope_to')::date;
    ELSIF v_att_ok AND (v_att ->> 'code') <> 'NONE' THEN
      v_basis := NULL;  -- không báo qa_assumption khi chứng nhận có nhưng hỏng
      v_b := array_append(v_b, 'CMS_LOCK_ATTEST_INVALID');
    ELSIF v_basis IS NULL OR v_basis <> 'qa_assumption' OR NOT v_prog.is_test THEN
      -- policy khai operator_reconciliation nhưng chưa có chứng nhận dùng được ⇒ không báo basis đó (db-reviewer r2 P2-9).
      IF v_basis = 'operator_reconciliation' THEN v_basis := NULL; END IF;
      v_b := array_append(v_b, 'CMS_LOCK_SOURCE_INCOMPLETE');
    END IF;
    -- mapping (kiểm sớm; RPC chốt kiểm lại sau khi chép định danh — bước 11)
    v_fp_now := public.cms__mapping_fp();
    IF v_fp_now IS DISTINCT FROM v_run.mapping_fp THEN
      v_b := array_append(v_b, 'CMS_LOCK_STALE_MAPPING');
    END IF;
    -- tổng run = Σ cms_results; staff_rows / staff_paid; mỗi dược sĩ đúng một nhà thuốc trong run
    SELECT COALESCE(sum(a.amt), 0), count(*), count(*) FILTER (WHERE a.amt > 0), count(*) FILTER (WHERE a.n_store <> 1)
      INTO v_sum, v_rows, v_paid, v_multi
      FROM (SELECT r.user_id, sum(r.amount_vnd) AS amt, count(DISTINCT r.store_id) AS n_store
              FROM public.cms_results r WHERE r.run_id = v_run.id GROUP BY r.user_id) a;
    -- Đối chiếu lại với seal (db-reviewer P2-1): số dòng 4 bảng + số khối / Σ row_count từng phần = seal_expect; Σ tiền dòng =
    -- tổng run ⇒ run "đóng băng" đúng là run đã seal, không thiếu dòng bị xoá trực tiếp trước khi chốt.
    SELECT (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'sales_lines')::bigint
       AND (SELECT count(*) FROM public.cms_results WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'results')::bigint
       AND (SELECT count(*) FROM public.cms_result_catalog WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'catalog')::bigint
       AND (SELECT count(*) FROM public.cms_result_lines WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'result_lines')::bigint
       AND NOT EXISTS (
         SELECT 1 FROM (VALUES ('sales_lines'), ('results'), ('catalog'), ('result_lines')) k(part)
           LEFT JOIN (SELECT ch.part, count(*) AS n, sum(ch.row_count) AS rows FROM public.cms_sync_run_chunks ch
                       WHERE ch.run_id = v_run.id GROUP BY ch.part) x ON x.part = k.part
          WHERE COALESCE(x.n, 0) IS DISTINCT FROM (v_run.seal_expect -> 'chunks' ->> k.part)::bigint
             OR COALESCE(x.rows, 0) IS DISTINCT FROM (v_run.seal_expect ->> k.part)::bigint)
       AND (SELECT COALESCE(sum(l.amount_vnd), 0) FROM public.cms_result_lines l WHERE l.run_id = v_run.id) = v_run.amount_vnd::numeric
      INTO v_sealed_ok;
    IF v_sum IS DISTINCT FROM v_run.amount_vnd::numeric OR v_multi > 0 OR v_sealed_ok IS NOT TRUE THEN
      v_b := array_append(v_b, 'CMS_LOCK_TOTAL_MISMATCH');
    END IF;
    -- 9. Q-213 (a, b, b', c / f, d / e): mẫu số = dòng ứng viên trừ OUT_OF_SCOPE, GMV dương; tử = dòng UNASSIGNED.
    SELECT count(*) FILTER (WHERE s.disposition <> 'OUT_OF_SCOPE'),
           COALESCE(sum(s.gmv_amount) FILTER (WHERE s.disposition <> 'OUT_OF_SCOPE' AND s.gmv_amount > 0), 0),
           count(*) FILTER (WHERE s.disposition = 'UNASSIGNED'),
           COALESCE(sum(s.gmv_amount) FILTER (WHERE s.disposition = 'UNASSIGNED' AND s.gmv_amount > 0), 0)
      INTO v_cl, v_cg, v_ul, v_ug
      FROM public.cms_sales_lines s WHERE s.run_id = v_run.id;
    IF v_ug > 0 AND v_cg = 0 THEN
      v_b := array_append(v_b, 'CMS_LOCK_POLICY_DATA');   -- b': tử > 0 mà mẫu = 0 ⇒ dữ liệu / policy lỗi, không chia 0
    ELSIF v_pol_ok THEN
      v_over := v_ug * 10000 > v_cg * (v_br ->> 'unassigned_max_gmv_bp')::numeric
                OR v_ul > (v_br ->> 'unassigned_max_lines')::integer;
      IF v_over THEN v_b := array_append(v_b, 'CMS_LOCK_UNASSIGNED_OVER'); END IF;
    END IF;
    v_ack_need := v_ul > 0 AND NOT v_over;
    -- Cắt đủ khoảng trắng ASCII như 121 (db-reviewer P2-6): 10 ký tự xuống dòng không phải lý do.
    v_ack_ok := p_ack_reason IS NOT NULL AND char_length(btrim(p_ack_reason, E' \t\r\n\f\v')) BETWEEN 10 AND 1000;
    IF p_require_ack AND v_ack_need AND NOT v_ack_ok THEN
      v_b := array_append(v_b, 'CMS_LOCK_ACK_REQUIRED');
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'program_id', v_prog.id, 'found', true, 'status', v_prog.status, 'is_test', v_prog.is_test,
    'end_date', to_char(v_prog.end_date, 'YYYY-MM-DD'), 'config_version', v_prog.config_version,
    'run_id', v_run.id, 'run_started_at', public.cms__ts(v_run.started_at),
    'amount_vnd', v_run.amount_vnd::text, 'results_amount_vnd', v_sum::text,
    'staff_rows', v_rows, 'staff_paid', v_paid,
    'candidate_lines', v_cl, 'candidate_gmv', v_cg::text, 'unassigned_lines', v_ul, 'unassigned_gmv', v_ug::text,
    'unassigned_over', v_over, 'needs_ack', v_ack_need,
    'policy', v_br, 'policy_version', v_ver,
    'mapping_fp_run', v_run.mapping_fp, 'mapping_fp_now', v_fp_now,
    'source_complete_basis', v_basis, 'source_complete_through', to_char(v_through, 'YYYY-MM-DD'),
    'source_attestation', v_att,
    'earliest_lock_at', public.cms__ts(v_earliest),
    'blockers', to_jsonb(v_b));
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_program_save(p jsonb)
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

CREATE OR REPLACE FUNCTION public.rpc_cms_import_commit(p_run_id uuid, p_sha256 text, p_digest text, p_payload jsonb, p_actor uuid)
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

  -- 125 (CMS-Q-220 — bỏ trần, thay Q-210a): bậc CUỐI mỗi SP phải không giới hạn ("to": null). Chạy SAU mọi kiểm kiểu / range /
  -- liên tục / payload ở trên (payload hỏng vẫn CMS_IMPORT_BAD_TIERS / BAD_PAYLOAD), TRƯỚC khoá danh mục (thứ tự khoá 121 giữ nguyên).
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'products') x
              WHERE jsonb_typeof((x->'tiers')->(jsonb_array_length(x->'tiers') - 1)->'to') IS DISTINCT FROM 'null') THEN
    RAISE EXCEPTION 'CMS_IMPORT_TIER_LAST_FINITE' USING ERRCODE = '22023';
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

CREATE OR REPLACE FUNCTION public.rpc_cms_program_activate(p_program_id uuid, p_actor uuid)
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
  -- 125 (CMS-Q-220): mọi SP có thang bậc hợp lệ (bắt đầu 1, liên tục theo tier_order, chỉ bậc cuối mở) và bậc cuối KHÔNG giới hạn
  -- — cấu hình chưa chuyển đổi (cận cuối hữu hạn) không kích hoạt được, kể cả khi guard bị vượt bằng quyền owner.
  IF EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = v_prog.id
               AND NOT EXISTS (SELECT 1 FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id))
     OR EXISTS (SELECT 1 FROM (SELECT t.tier_order, t.qty_from, t.qty_to,
                                      lag(t.qty_to) OVER w AS prev_to, row_number() OVER w AS rn,
                                      count(*) OVER (PARTITION BY t.program_product_id) AS n
                                 FROM public.cms_program_tiers t WHERE t.program_id = v_prog.id
                               WINDOW w AS (PARTITION BY t.program_product_id ORDER BY t.tier_order)) x
                 WHERE x.tier_order <> x.rn OR (x.rn = 1 AND x.qty_from <> 1)
                    OR (x.rn > 1 AND (x.prev_to IS NULL OR x.qty_from::bigint <> x.prev_to::bigint + 1)) OR (x.qty_to IS NULL AND x.rn <> x.n)) THEN
    RAISE EXCEPTION 'CMS_PROGRAM_TIERS_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_program_products pp
              WHERE pp.program_id = v_prog.id
                AND (SELECT t.qty_to FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id
                      ORDER BY t.tier_order DESC LIMIT 1) IS NOT NULL) THEN
    RAISE EXCEPTION 'CMS_PROGRAM_TIER_LAST_FINITE' USING ERRCODE = 'P0001';
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

CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_open(p_program_id uuid, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_prog public.cms_programs%ROWTYPE;
  v_snap jsonb;
  v_id   uuid;
  v_sch  smallint;  -- 124
BEGIN
  IF p_program_id IS NULL THEN RAISE EXCEPTION 'CMS_SALES_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  IF p_detail IS NULL OR jsonb_typeof(p_detail) <> 'object' OR pg_column_size(p_detail) > 4096 THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_DETAIL' USING ERRCODE = '22023';
  END IF;
  -- Khoá dòng chương trình: chặn ghi cấu hình (121 khoá FOR UPDATE) trong lúc chụp snapshot ⇒ config_version khớp dữ liệu.
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_prog.status = 'locked' THEN RAISE EXCEPTION 'CMS_PROGRAM_LOCKED' USING ERRCODE = 'P0001'; END IF;
  IF v_prog.status <> 'active' THEN RAISE EXCEPTION 'CMS_SALES_PROGRAM_NOT_ACTIVE' USING ERRCODE = 'P0001'; END IF;
  -- Chỉ tính khi đã bắt đầu: trước ngày bắt đầu danh mục còn nạp lại (replace xoá SP) — không giữ tham chiếu snapshot.
  IF public.cms__vn_today() < v_prog.start_date THEN
    RAISE EXCEPTION 'CMS_SALES_NOT_STARTED' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cms_sales_run:' || p_program_id::text, 0));
  UPDATE public.cms_sync_runs SET status = 'error', finished_at = now(), error_code = 'STALE'
   WHERE kind = 'sales' AND program_id = p_program_id AND status = 'running' AND started_at < now() - interval '30 minutes';
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = p_program_id AND status = 'running') THEN
    RAISE EXCEPTION 'CMS_SYNC_BUSY' USING ERRCODE = 'P0001';
  END IF;
  v_snap := public.cms__sales_snapshot(p_program_id);
  INSERT INTO public.cms_sync_runs (kind, program_id, config_version, is_test, mapping_fp, detail)
  VALUES ('sales', p_program_id, v_prog.config_version, v_prog.is_test, v_snap ->> 'mapping_fp', p_detail)
  RETURNING id, source_schema INTO v_id, v_sch;
  -- 124: capability lớp nguồn = giá trị THỰC của run vừa INSERT (DEFAULT 1 sau 124) — app không tự suy.
  RETURN v_snap || jsonb_build_object('run_id', v_id, 'source_schema', v_sch);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_seal_begin(p_run_id uuid, p_expect jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_run   public.cms_sync_runs%ROWTYPE;
  v_prog  public.cms_programs%ROWTYPE;
  v_part  text;
  v_n     bigint;
  c_cnt   CONSTANT text := '^(0|[1-9][0-9]{0,8})$';
BEGIN
  IF p_expect IS NULL OR jsonb_typeof(p_expect) <> 'object' OR pg_column_size(p_expect) > 65536
     OR NOT public.cms__str(p_expect, 'amount_vnd', '^(0|[1-9][0-9]{0,18})$')
     OR NOT public.cms__str_or_null(p_expect, 'source_max_updated_at', '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$')
     OR jsonb_typeof(p_expect -> 'chunks') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_expect -> 'totals') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['sales_lines', 'results', 'catalog', 'result_lines', 'rows_read', 'rows_rejected']) k
                 WHERE jsonb_typeof(p_expect -> k) IS DISTINCT FROM 'number' OR (p_expect ->> k) !~ c_cnt)
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['sales_lines', 'results', 'catalog', 'result_lines']) k
                 WHERE jsonb_typeof(p_expect -> 'chunks' -> k) IS DISTINCT FROM 'number' OR (p_expect -> 'chunks' ->> k) !~ c_cnt)
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['lines_read', 'candidates', 'included', 'unassigned', 'out_of_scope', 'adjustment_lines']) k
                 WHERE jsonb_typeof(p_expect -> 'totals' -> k) IS DISTINCT FROM 'number' OR (p_expect -> 'totals' ->> k) !~ c_cnt)
     OR NOT public.cms__str(p_expect -> 'totals', 'candidate_gmv', '^-?[0-9]{1,35}(\.[0-9]{1,9})?$')
     OR NOT public.cms__str(p_expect -> 'totals', 'unassigned_gmv', '^-?[0-9]{1,35}(\.[0-9]{1,9})?$')
     OR NOT public.cms__str(p_expect -> 'totals', 'amount_vnd', '^(0|[1-9][0-9]{0,18})$')
     -- totals chỉ gồm khoá đã biết (hiển thị cho super — db-reviewer r2 N5); hai bảng lý do: khoá trong enum, giá trị số đếm.
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_expect -> 'totals') k
                 WHERE k NOT IN ('lines_read', 'candidates', 'included', 'unassigned', 'out_of_scope', 'adjustment_lines',
                                 'candidate_gmv', 'unassigned_gmv', 'amount_vnd', 'unassigned_by_reason', 'excluded_by_reason'))
     OR jsonb_typeof(p_expect -> 'totals' -> 'unassigned_by_reason') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_expect -> 'totals' -> 'excluded_by_reason') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(p_expect -> 'totals' -> 'unassigned_by_reason') e
                 WHERE e.key NOT IN ('NO_EMAIL', 'NOT_FOUND', 'MULTIPLE', 'SHARED_ACCOUNT', 'NOT_STAFF', 'STORE_NOT_ELIGIBLE')
                    OR jsonb_typeof(e.value) <> 'number' OR e.value::text !~ c_cnt)
     OR EXISTS (SELECT 1 FROM jsonb_each(p_expect -> 'totals' -> 'excluded_by_reason') e
                 WHERE e.key NOT IN ('ORDER_NOT_ELIGIBLE', 'OUT_OF_WINDOW', 'PRODUCT_NOT_IN_PROGRAM', 'UNASSIGNED', 'OUT_OF_SCOPE')
                    OR jsonb_typeof(e.value) <> 'number' OR e.value::text !~ c_cnt)
     OR (p_expect ? 'bytes_processed' AND jsonb_typeof(p_expect -> 'bytes_processed') <> 'null'
         AND (p_expect ->> 'bytes_processed') !~ '^(0|[1-9][0-9]{0,17})$') THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END IF;
  -- Ngày qua regex nhưng không tồn tại (30/02, năm 0000) ⇒ mã CMS, không lỗi ép kiểu thô 22008 ở bước 10 (db-reviewer r2 N4).
  BEGIN
    PERFORM NULLIF(p_expect ->> 'source_max_updated_at', '')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.kind <> 'sales' OR v_run.status <> 'running' THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.seal_expect IS NOT NULL OR v_run.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'CMS_SEAL_STARTED' USING ERRCODE = 'P0001'; END IF;
  IF v_run.started_at < now() - interval '30 minutes' THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'STALE'); END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_run.program_id;
  IF v_prog.status = 'locked' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_LOCKED'); END IF;
  IF v_prog.status <> 'active' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_NOT_ACTIVE'); END IF;
  IF v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN
    RETURN public.cms__seal_fail(p_run_id, 'held', 'CONFIG_CHANGED');
  END IF;
  IF public.cms__mapping_fp() <> v_run.mapping_fp THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'MAPPING_CHANGED'); END IF;
  -- Thống kê mới cho run vừa stage (run_id mới chưa có trong thống kê ⇒ planner ước 1 dòng ⇒ nested loop O(n²)).
  -- SKIP_LOCKED: autovacuum / seal khác đang giữ khoá ⇒ bỏ qua thay vì chờ lock_timeout (security review r2 P2-c); bước
  -- seal vẫn có enable_nestloop = off nên thống kê cũ không rơi vào O(n²).
  ANALYZE (SKIP_LOCKED) public.cms_sales_lines, public.cms_results, public.cms_result_catalog, public.cms_result_lines;
  -- S1 đủ dòng: số dòng từng bảng = khai báo của app.
  IF (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = p_run_id) <> (p_expect ->> 'sales_lines')::bigint
     OR (SELECT count(*) FROM public.cms_results WHERE run_id = p_run_id) <> (p_expect ->> 'results')::bigint
     OR (SELECT count(*) FROM public.cms_result_catalog WHERE run_id = p_run_id) <> (p_expect ->> 'catalog')::bigint
     OR (SELECT count(*) FROM public.cms_result_lines WHERE run_id = p_run_id) <> (p_expect ->> 'result_lines')::bigint THEN
    RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_COUNT_MISMATCH');
  END IF;
  -- S2 đủ khối: mỗi part có đúng n khối 0…n−1, tổng row_count = số dòng.
  FOREACH v_part IN ARRAY ARRAY['sales_lines', 'results', 'catalog', 'result_lines'] LOOP
    v_n := (p_expect -> 'chunks' ->> v_part)::bigint;
    IF (SELECT count(*) FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND part = v_part) <> v_n
       OR COALESCE((SELECT max(chunk_no) FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND part = v_part), -1) <> v_n - 1
       OR COALESCE((SELECT sum(row_count) FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND part = v_part), 0)
          <> (p_expect ->> v_part)::bigint THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_CHUNKS_MISMATCH');
    END IF;
  END LOOP;
  -- Đóng băng staging: từ đây stage bị từ chối; các bước dùng expect đã lưu (không nhận lại từ app).
  UPDATE public.cms_sync_runs SET seal_expect = p_expect, seal_step = 0 WHERE id = p_run_id;
  RETURN jsonb_build_object('ok', true, 'steps', 10);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_seal_step(p_run_id uuid, p_step integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s'
  SET enable_nestloop = off AS $$
DECLARE
  v_run   public.cms_sync_runs%ROWTYPE;
  v_prog  public.cms_programs%ROWTYPE;
  v_exp   jsonb;
  v_from  timestamptz;
  v_to    timestamptz;
  v_sum   numeric;
  v_bad   boolean;
BEGIN
  IF p_step IS NULL OR p_step < 1 OR p_step > 10 THEN RAISE EXCEPTION 'CMS_SEAL_BAD_STEP' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.kind <> 'sales' OR v_run.status <> 'running' THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.seal_expect IS NULL THEN RAISE EXCEPTION 'CMS_SEAL_STEP_ORDER' USING ERRCODE = 'P0001'; END IF;
  -- Gọi lại bước đã qua (mất phản hồi) ⇒ trả lại kết quả, không đổi gì (db-reviewer r2 N8).
  IF v_run.sealed_at IS NOT NULL THEN
    RETURN CASE WHEN p_step = 10 THEN jsonb_build_object('sealed', true, 'step', 10, 'already', true, 'amount_vnd', v_run.amount_vnd::text)
                ELSE jsonb_build_object('sealed', false, 'ok', true, 'step', p_step, 'already', true) END;
  END IF;
  IF v_run.seal_step >= p_step THEN RETURN jsonb_build_object('sealed', false, 'ok', true, 'step', p_step, 'already', true); END IF;
  IF v_run.seal_step <> p_step - 1 THEN RAISE EXCEPTION 'CMS_SEAL_STEP_ORDER' USING ERRCODE = 'P0001'; END IF;
  IF v_run.started_at < now() - interval '30 minutes' THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'STALE'); END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_run.program_id;
  -- Đầu MỖI bước: trạng thái / cấu hình / mapping đổi từ lúc open ⇒ held đúng mã (không để bước kiểm dữ liệu báo error
  -- SEAL_* gây hiểu nhầm — db-reviewer r2 N2). Publish vẫn kiểm lại dưới khoá chương trình.
  IF v_prog.status = 'locked' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_LOCKED'); END IF;
  IF v_prog.status <> 'active' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_NOT_ACTIVE'); END IF;
  IF v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN
    RETURN public.cms__seal_fail(p_run_id, 'held', 'CONFIG_CHANGED');
  END IF;
  IF public.cms__mapping_fp() <> v_run.mapping_fp THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'MAPPING_CHANGED'); END IF;
  v_exp  := v_run.seal_expect;
  v_from := (v_prog.start_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
  v_to   := ((v_prog.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');

  IF p_step = 1 THEN
    -- S3 thứ tự (compareCmsLines): seq liên tục 0…n−1; completed_at không giảm theo seq; cùng thời điểm: ID toàn chữ số trước
    -- ID khác; hai ID số tăng theo giá trị (độ dài sau bỏ số 0 đầu, rồi chữ số, hoà ⇒ chuỗi gốc); hai ID không phải số tăng
    -- theo code point (COLLATE "C" — chỉ khác thứ tự code unit JS với ký tự ngoài BMP).
    SELECT EXISTS (
      SELECT 1 FROM (
        SELECT completed_at, order_line_id AS c_id, regexp_replace(order_line_id, '^0+(?=[0-9])', '') AS c_t,
               lag(completed_at) OVER (ORDER BY seq) AS p_at, lag(order_line_id) OVER (ORDER BY seq) AS p_id,
               lag(regexp_replace(order_line_id, '^0+(?=[0-9])', '')) OVER (ORDER BY seq) AS p_t
          FROM public.cms_sales_lines WHERE run_id = p_run_id) x
       WHERE x.p_at > x.completed_at
          OR (x.p_at = x.completed_at AND x.p_id !~ '^[0-9]+$' AND x.c_id ~ '^[0-9]+$')
          OR (x.p_at = x.completed_at AND x.p_id ~ '^[0-9]+$' AND x.c_id ~ '^[0-9]+$'
              AND NOT (length(x.p_t) < length(x.c_t)
                       OR (length(x.p_t) = length(x.c_t) AND x.p_t COLLATE "C" < x.c_t COLLATE "C")
                       OR (x.p_t = x.c_t AND x.p_id COLLATE "C" < x.c_id COLLATE "C")))
          OR (x.p_at = x.completed_at AND x.p_id !~ '^[0-9]+$' AND x.c_id !~ '^[0-9]+$'
              AND NOT (x.p_id COLLATE "C" < x.c_id COLLATE "C")))
      OR COALESCE((SELECT max(seq) FROM public.cms_sales_lines WHERE run_id = p_run_id), -1)
         <> (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = p_run_id) - 1
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_ORDER'); END IF;
  ELSIF p_step = 2 THEN
    -- S4 kỳ / sản phẩm / phạm vi: trong kỳ ngày VN, ProductID khớp SP chương trình, INCLUDED ⇔ store trong phạm vi.
    SELECT EXISTS (
      SELECT 1 FROM public.cms_sales_lines sl
        JOIN public.cms_program_products pp ON pp.id = sl.program_product_id
        LEFT JOIN public.cms_program_stores ps ON ps.program_id = v_run.program_id AND ps.store_id = sl.store_id
       WHERE sl.run_id = p_run_id
         AND (sl.product_id <> pp.product_id OR sl.completed_at < v_from OR sl.completed_at >= v_to
              OR (sl.disposition = 'INCLUDED' AND ps.store_id IS NULL)
              OR (sl.disposition = 'OUT_OF_SCOPE' AND ps.store_id IS NOT NULL)))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_SCOPE'); END IF;
  ELSIF p_step = 3 THEN
    -- S5 người bán (Q-207): INCLUDED / OUT_OF_SCOPE ⇒ email khớp ĐÚNG MỘT tài khoản, là staff, store OS active = store dòng;
    -- UNASSIGNED ⇒ không có đúng một staff OS active khớp email (không bỏ sót người hưởng); NO_EMAIL ⇔ không email.
    WITH ue AS (
      SELECT u.id, public.cms__norm_email(u.email) AS e, u.role, u.store_id, COALESCE(s.store_type = 'os' AND s.is_active, false) AS ok
        FROM public.users u LEFT JOIN public.stores s ON s.id = u.store_id
    ), cnt AS (SELECT e, count(*) AS n FROM ue WHERE e IS NOT NULL GROUP BY e),
    elig AS (SELECT ue.e FROM ue JOIN cnt ON cnt.e = ue.e AND cnt.n = 1 WHERE ue.role = 'staff' AND ue.ok)
    SELECT EXISTS (
      SELECT 1 FROM public.cms_sales_lines sl
        LEFT JOIN cnt ON cnt.e = sl.seller_email
        LEFT JOIN ue ON ue.id = sl.user_id
       WHERE sl.run_id = p_run_id AND sl.disposition <> 'UNASSIGNED'
         AND NOT COALESCE(cnt.n = 1 AND ue.e = sl.seller_email AND ue.role = 'staff' AND ue.ok AND ue.store_id = sl.store_id, false))
    OR EXISTS (
      SELECT 1 FROM public.cms_sales_lines sl
        LEFT JOIN elig ON elig.e = sl.seller_email
       WHERE sl.run_id = p_run_id AND sl.disposition = 'UNASSIGNED'
         AND ((sl.seller_email IS NULL) <> (sl.unassigned_reason = 'NO_EMAIL') OR elig.e IS NOT NULL))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_MAPPING'); END IF;
  ELSIF p_step = 4 THEN
    -- S6 liên kết dòng: mỗi dòng kết quả ↔ đúng một dòng INCLUDED cùng seq / user / SP; đủ mọi dòng INCLUDED.
    IF EXISTS (SELECT 1 FROM public.cms_result_lines rl
                 JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
                WHERE rl.run_id = p_run_id AND (sl.disposition <> 'INCLUDED' OR sl.seq <> rl.seq OR sl.user_id <> rl.user_id
                                                OR sl.program_product_id <> rl.program_product_id))
       OR (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = p_run_id AND disposition = 'INCLUDED')
          <> (SELECT count(*) FROM public.cms_result_lines WHERE run_id = p_run_id) THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_LINE_LINK');
    END IF;
  ELSIF p_step = 5 THEN
    -- S7 cấu hình trong kết quả = cấu hình chương trình (SP, loại GMV, K, target, trần = to của bậc cuối).
    IF EXISTS (SELECT 1 FROM public.cms_results r
                 JOIN public.cms_program_products pp ON pp.id = r.program_product_id
                 LEFT JOIN LATERAL (SELECT t.qty_to FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id
                                     ORDER BY t.tier_order DESC LIMIT 1) lt ON true
                WHERE r.run_id = p_run_id
                  AND (r.product_id <> pp.product_id OR r.gmv_basis <> pp.gmv_basis OR r.per_unit <> pp.base_quantity_cms
                       OR r.target_gmv IS DISTINCT FROM (CASE pp.gmv_basis WHEN 'product' THEN pp.target_gmv
                                                                           WHEN 'catalog' THEN v_prog.catalog_target_gmv END)
                       OR r.cap_quantity IS DISTINCT FROM lt.qty_to::bigint)) THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_RESULT_CONFIG');
    END IF;
  ELSIF p_step = 6 THEN
    -- S8 tổng theo nhóm dược sĩ × SP = cộng các dòng (số dòng, lượng cơ sở, GMV, tiền) và cùng store.
    IF EXISTS (SELECT 1 FROM public.cms_results r
                 LEFT JOIN (SELECT rl.user_id, rl.program_product_id, count(*) AS n, sum(sl.base_quantity) AS b,
                                   sum(sl.gmv_amount) AS g, sum(rl.amount_vnd::numeric) AS a,
                                   min(sl.store_id::text) AS s1, max(sl.store_id::text) AS s2
                              FROM public.cms_result_lines rl
                              JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
                             WHERE rl.run_id = p_run_id GROUP BY rl.user_id, rl.program_product_id) x
                   ON x.user_id = r.user_id AND x.program_product_id = r.program_product_id
                WHERE r.run_id = p_run_id
                  AND (x.n IS NULL OR x.n <> r.line_count OR x.b <> r.base_quantity OR x.g <> r.gmv_amount
                       OR x.a <> r.amount_vnd OR x.s1 <> r.store_id::text OR x.s2 <> r.store_id::text)) THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_RESULT_SUMS');
    END IF;
  ELSIF p_step = 7 THEN
    -- S9 Q = floor(max(0, B) / K) (bất đẳng thức chính xác) và F(Q) theo bậc lũy tiến. F tính MỘT lần cho mỗi cặp (SP, Q)
    -- phân biệt: tra bậc chứa Q bằng index (program_product_id, qty_from) LIMIT 1 + tiền tích luỹ các bậc trước (hash join) —
    -- O(cặp · log bậc), không O(dòng × bậc) (db-reviewer r2 P1-N1).
    WITH tc AS (
      SELECT t.program_product_id, t.tier_order,
             COALESCE(sum((t.qty_to - t.qty_from + 1)::numeric * t.amount_per_unit) OVER (PARTITION BY t.program_product_id
                      ORDER BY t.tier_order ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_before
        FROM public.cms_program_tiers t WHERE t.program_id = v_run.program_id
    ), q AS (
      SELECT DISTINCT r.program_product_id, r.cms_quantity AS q FROM public.cms_results r WHERE r.run_id = p_run_id
    ), fq AS (
      SELECT q.program_product_id, q.q,
             CASE WHEN q.q <= 0 OR x.tier_order IS NULL THEN 0
                  ELSE tc.cum_before + (LEAST(q.q::numeric, COALESCE(x.qty_to, q.q)::numeric) - x.qty_from + 1) * x.amount_per_unit END AS f
        FROM q
        LEFT JOIN LATERAL (SELECT t.tier_order, t.qty_from, t.qty_to, t.amount_per_unit FROM public.cms_program_tiers t
                            WHERE t.program_product_id = q.program_product_id AND t.qty_from <= q.q
                            ORDER BY t.qty_from DESC LIMIT 1) x ON true
        LEFT JOIN tc ON tc.program_product_id = q.program_product_id AND tc.tier_order = x.tier_order
    )
    SELECT EXISTS (
      SELECT 1 FROM public.cms_results r
        LEFT JOIN fq ON fq.program_product_id = r.program_product_id AND fq.q = r.cms_quantity
       WHERE r.run_id = p_run_id
         AND (NOT (r.cms_quantity::numeric * r.per_unit <= GREATEST(r.base_quantity, 0)
                   AND GREATEST(r.base_quantity, 0) < (r.cms_quantity::numeric + 1) * r.per_unit)
              OR fq.f IS NULL OR r.potential_amount::numeric <> fq.f))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TIER_AMOUNT'); END IF;
  ELSIF p_step = 8 THEN
    -- S10 gate SP: GMV gate = tổng GMV nhóm; đạt = cuối kỳ ≥ target; "đạt từ" = lần chuyển chưa đạt → đạt gần nhất (Q-211).
    WITH l AS (
      SELECT rl.user_id, rl.program_product_id, rl.seq, sl.completed_at, sl.gmv_amount, r.target_gmv
        FROM public.cms_result_lines rl
        JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
        JOIN public.cms_results r ON r.run_id = rl.run_id AND r.user_id = rl.user_id AND r.program_product_id = rl.program_product_id
       WHERE rl.run_id = p_run_id AND r.gmv_basis = 'product'
    ), c AS (
      SELECT l.*, (sum(l.gmv_amount) OVER (PARTITION BY l.user_id, l.program_product_id ORDER BY l.seq)) >= l.target_gmv AS met FROM l
    ), x AS (
      SELECT c.*, COALESCE(lag(c.met) OVER (PARTITION BY c.user_id, c.program_product_id ORDER BY c.seq), false) AS prev_met FROM c
    ), g AS (
      SELECT user_id, program_product_id, sum(gmv_amount) AS gmv, (array_agg(met ORDER BY seq DESC))[1] AS final_met,
             max(completed_at) FILTER (WHERE met AND NOT prev_met) AS last_cross
        FROM x GROUP BY user_id, program_product_id
    )
    SELECT EXISTS (
      SELECT 1 FROM public.cms_results r
        LEFT JOIN g ON g.user_id = r.user_id AND g.program_product_id = r.program_product_id
       WHERE r.run_id = p_run_id AND r.gmv_basis = 'product'
         AND (g.user_id IS NULL OR r.gate_gmv IS DISTINCT FROM g.gmv OR r.gate_met IS DISTINCT FROM g.final_met
              OR r.gate_met_at IS DISTINCT FROM (CASE WHEN g.final_met THEN g.last_cross END)))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_GATE'); END IF;
  ELSIF p_step = 9 THEN
    -- S11 gate danh mục theo dược sĩ (cộng GMV mọi SP GMV_TOAN_DANH_MUC theo thứ tự engine); một dòng catalog ⇔ dược sĩ có
    -- dòng danh mục; kết quả SP danh mục mang đúng gate của dược sĩ.
    WITH l AS (
      SELECT rl.user_id, rl.seq, sl.completed_at, sl.gmv_amount, sl.store_id
        FROM public.cms_result_lines rl
        JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
        JOIN public.cms_results r ON r.run_id = rl.run_id AND r.user_id = rl.user_id AND r.program_product_id = rl.program_product_id
       WHERE rl.run_id = p_run_id AND r.gmv_basis = 'catalog'
    ), c AS (
      SELECT l.*, (sum(l.gmv_amount) OVER (PARTITION BY l.user_id ORDER BY l.seq)) >= v_prog.catalog_target_gmv AS met FROM l
    ), x AS (
      SELECT c.*, COALESCE(lag(c.met) OVER (PARTITION BY c.user_id ORDER BY c.seq), false) AS prev_met FROM c
    ), g AS (
      SELECT user_id, sum(gmv_amount) AS gmv, count(*) AS n, (array_agg(met ORDER BY seq DESC))[1] AS final_met,
             max(completed_at) FILTER (WHERE met AND NOT prev_met) AS last_cross,
             min(store_id::text) AS s1, max(store_id::text) AS s2
        FROM x GROUP BY user_id
    )
    SELECT EXISTS (
      SELECT 1 FROM g FULL JOIN (SELECT * FROM public.cms_result_catalog WHERE run_id = p_run_id) k ON k.user_id = g.user_id
       WHERE g.user_id IS NULL OR k.user_id IS NULL OR k.catalog_gmv <> g.gmv OR k.line_count <> g.n
          OR k.target_gmv IS DISTINCT FROM v_prog.catalog_target_gmv OR k.met <> g.final_met
          OR k.met_at IS DISTINCT FROM (CASE WHEN g.final_met THEN g.last_cross END)
          OR k.store_id::text <> g.s1 OR k.store_id::text <> g.s2)
    OR EXISTS (
      SELECT 1 FROM public.cms_results r
        LEFT JOIN public.cms_result_catalog k ON k.run_id = r.run_id AND k.user_id = r.user_id
       WHERE r.run_id = p_run_id AND r.gmv_basis = 'catalog'
         AND (k.user_id IS NULL OR r.gate_gmv <> k.catalog_gmv OR r.gate_met <> k.met
              OR r.gate_met_at IS DISTINCT FROM k.met_at))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_CATALOG'); END IF;
  ELSE
    -- S12 phân bổ từng dòng: B trước / sau cộng dồn theo seq; Q trước / sau; tiền = gate ? A(B_sau) − A(B_trước) : 0;
    -- trạng thái dòng đúng thứ tự ưu tiên của engine.
    WITH l AS (
      SELECT rl.*, sl.base_quantity, sl.gmv_amount, r.per_unit, r.gate_met, r.cap_quantity,
             COALESCE(sum(sl.base_quantity) OVER (PARTITION BY rl.user_id, rl.program_product_id ORDER BY rl.seq
                                                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS exp_before
        FROM public.cms_result_lines rl
        JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
        JOIN public.cms_results r ON r.run_id = rl.run_id AND r.user_id = rl.user_id AND r.program_product_id = rl.program_product_id
       WHERE rl.run_id = p_run_id
    ), tc AS (
      SELECT t.program_product_id, t.tier_order,
             COALESCE(sum((t.qty_to - t.qty_from + 1)::numeric * t.amount_per_unit) OVER (PARTITION BY t.program_product_id
                      ORDER BY t.tier_order ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_before
        FROM public.cms_program_tiers t WHERE t.program_id = v_run.program_id
    ), q AS (
      -- F chỉ cần ở dòng gate đạt; mỗi cặp (SP, Q) phân biệt tính một lần (db-reviewer r2 P1-N1).
      SELECT program_product_id, qty_before AS q FROM l WHERE gate_met
      UNION
      SELECT program_product_id, qty_after FROM l WHERE gate_met
    ), fq AS (
      SELECT q.program_product_id, q.q,
             CASE WHEN q.q <= 0 OR x.tier_order IS NULL THEN 0
                  ELSE tc.cum_before + (LEAST(q.q::numeric, COALESCE(x.qty_to, q.q)::numeric) - x.qty_from + 1) * x.amount_per_unit END AS f
        FROM q
        LEFT JOIN LATERAL (SELECT t.tier_order, t.qty_from, t.qty_to, t.amount_per_unit FROM public.cms_program_tiers t
                            WHERE t.program_product_id = q.program_product_id AND t.qty_from <= q.q
                            ORDER BY t.qty_from DESC LIMIT 1) x ON true
        LEFT JOIN tc ON tc.program_product_id = q.program_product_id AND tc.tier_order = x.tier_order
    ), f AS (
      SELECT l.*, fa.f AS f_after, fb.f AS f_before
        FROM l
        LEFT JOIN fq fa ON l.gate_met AND fa.program_product_id = l.program_product_id AND fa.q = l.qty_after
        LEFT JOIN fq fb ON l.gate_met AND fb.program_product_id = l.program_product_id AND fb.q = l.qty_before
    )
    SELECT EXISTS (
      SELECT 1 FROM f
       WHERE f.base_before <> f.exp_before OR f.base_after <> f.exp_before + f.base_quantity
          OR NOT (f.qty_before::numeric * f.per_unit <= GREATEST(f.base_before, 0)
                  AND GREATEST(f.base_before, 0) < (f.qty_before::numeric + 1) * f.per_unit)
          OR NOT (f.qty_after::numeric * f.per_unit <= GREATEST(f.base_after, 0)
                  AND GREATEST(f.base_after, 0) < (f.qty_after::numeric + 1) * f.per_unit)
          OR (f.gate_met AND (f.f_after IS NULL OR f.f_before IS NULL))
          OR f.amount_vnd::numeric <> (CASE WHEN f.gate_met THEN f.f_after - f.f_before ELSE 0 END)
          OR f.status <> (CASE WHEN f.base_quantity < 0 OR f.gmv_amount < 0 THEN 'ADJUSTMENT'
                               WHEN NOT f.gate_met THEN 'WAITING_GATE'
                               WHEN f.amount_vnd > 0 THEN 'RECORDED'
                               WHEN f.cap_quantity IS NOT NULL AND f.qty_before >= f.cap_quantity THEN 'AT_CAP'
                               ELSE 'ACCUMULATING' END))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_LINE_ALLOC'); END IF;
    -- S13 tổng tiền = khai báo, trong miền bigint.
    SELECT COALESCE(sum(amount_vnd::numeric), 0) INTO v_sum FROM public.cms_results WHERE run_id = p_run_id;
    IF v_sum <> (v_exp ->> 'amount_vnd')::numeric OR v_sum > 9223372036854775807 THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TOTAL');
    END IF;
    -- S14 số đếm / tổng hiển thị cho super (totals) = dữ liệu đã stage; rows_read ≥ số ứng viên; mốc nguồn ≥ mốc dòng
    -- (db-reviewer P2-2: không ghi nguyên số app báo mà không đối chiếu).
    SELECT EXISTS (
      SELECT 1 FROM (
        SELECT count(*) AS cand,
               count(*) FILTER (WHERE disposition = 'INCLUDED') AS inc,
               count(*) FILTER (WHERE disposition = 'UNASSIGNED') AS una,
               count(*) FILTER (WHERE disposition = 'OUT_OF_SCOPE') AS oos,
               COALESCE(sum(gmv_amount), 0) AS cgmv,
               COALESCE(sum(gmv_amount) FILTER (WHERE disposition = 'UNASSIGNED'), 0) AS ugmv,
               max(source_updated_at) AS mx
          FROM public.cms_sales_lines WHERE run_id = p_run_id) a
       WHERE a.cand <> (v_exp -> 'totals' ->> 'candidates')::bigint OR a.inc <> (v_exp -> 'totals' ->> 'included')::bigint
          OR a.una <> (v_exp -> 'totals' ->> 'unassigned')::bigint OR a.oos <> (v_exp -> 'totals' ->> 'out_of_scope')::bigint
          OR a.cgmv <> (v_exp -> 'totals' ->> 'candidate_gmv')::numeric OR a.ugmv <> (v_exp -> 'totals' ->> 'unassigned_gmv')::numeric
          OR (v_exp ->> 'rows_read')::bigint < a.cand
          OR (a.mx IS NOT NULL AND (v_exp ->> 'source_max_updated_at') IS NULL)
          OR (a.mx IS NOT NULL AND (v_exp ->> 'source_max_updated_at')::timestamptz < a.mx)
          -- Mọi khoá totals còn lại cũng phải khớp dữ liệu (db-reviewer r2 N5): dòng hợp lệ = đọc − lỗi; dòng không ứng viên
          -- = hợp lệ − ứng viên; chưa gán / ngoài phạm vi theo lý do; tổng tiền; số dòng điều chỉnh.
          OR (v_exp -> 'totals' ->> 'lines_read')::bigint <> (v_exp ->> 'rows_read')::bigint - (v_exp ->> 'rows_rejected')::bigint
          OR (v_exp -> 'totals' ->> 'amount_vnd')::numeric <> v_sum
          OR (v_exp -> 'totals' ->> 'adjustment_lines')::bigint
             <> (SELECT count(*) FROM public.cms_result_lines WHERE run_id = p_run_id AND status = 'ADJUSTMENT')
          OR COALESCE((SELECT jsonb_object_agg(g.unassigned_reason, g.n) FROM (
                         SELECT unassigned_reason, count(*) AS n FROM public.cms_sales_lines
                          WHERE run_id = p_run_id AND disposition = 'UNASSIGNED' GROUP BY unassigned_reason) g), '{}'::jsonb)
             <> (v_exp -> 'totals' -> 'unassigned_by_reason')
          OR COALESCE((v_exp -> 'totals' -> 'excluded_by_reason' ->> 'UNASSIGNED')::bigint, 0) <> a.una
          OR COALESCE((v_exp -> 'totals' -> 'excluded_by_reason' ->> 'OUT_OF_SCOPE')::bigint, 0) <> a.oos
          OR COALESCE((v_exp -> 'totals' -> 'excluded_by_reason' ->> 'ORDER_NOT_ELIGIBLE')::bigint, 0)
             + COALESCE((v_exp -> 'totals' -> 'excluded_by_reason' ->> 'OUT_OF_WINDOW')::bigint, 0)
             + COALESCE((v_exp -> 'totals' -> 'excluded_by_reason' ->> 'PRODUCT_NOT_IN_PROGRAM')::bigint, 0)
             <> (v_exp -> 'totals' ->> 'lines_read')::bigint - a.cand)
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TOTALS'); END IF;
    UPDATE public.cms_sync_runs SET
      seal_step = 10,
      sealed_at = now(),
      amount_vnd = v_sum::bigint,
      rows_read = (v_exp ->> 'rows_read')::integer,
      rows_rejected = (v_exp ->> 'rows_rejected')::integer,
      bytes_processed = NULLIF(v_exp ->> 'bytes_processed', '')::bigint,
      source_max_updated_at = NULLIF(v_exp ->> 'source_max_updated_at', '')::timestamptz,
      detail = detail || jsonb_build_object('totals', v_exp -> 'totals')
    WHERE id = p_run_id;
    RETURN jsonb_build_object('sealed', true, 'step', 10, 'amount_vnd', v_sum::text);
  END IF;
  UPDATE public.cms_sync_runs SET seal_step = p_step WHERE id = p_run_id;
  RETURN jsonb_build_object('sealed', false, 'ok', true, 'step', p_step);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_publish(p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_pid  uuid;
  v_prog public.cms_programs%ROWTYPE;
  v_run  public.cms_sync_runs%ROWTYPE;
  v_code text;
  v_prev uuid;
BEGIN
  IF p_run_id IS NULL THEN RAISE EXCEPTION 'CMS_SALES_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT program_id INTO v_pid FROM public.cms_sync_runs WHERE id = p_run_id AND kind = 'sales';
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001'; END IF;
  -- Thứ tự khoá cố định chương trình → run (cùng thứ tự open / ghi cấu hình 121) ⇒ không deadlock.
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_pid FOR UPDATE;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.status = 'ok' THEN
    RETURN jsonb_build_object('published', true, 'already', true, 'run_id', p_run_id,
                              'current', v_prog.current_result_run_id IS NOT DISTINCT FROM p_run_id);
  END IF;
  IF v_run.status <> 'running' THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001'; END IF;
  IF v_run.sealed_at IS NULL THEN RAISE EXCEPTION 'CMS_RESULT_NOT_SEALED' USING ERRCODE = 'P0001'; END IF;
  v_code := CASE
    WHEN v_run.started_at < now() - interval '30 minutes' THEN 'STALE'
    WHEN v_prog.status = 'locked' THEN 'PROGRAM_LOCKED'
    WHEN v_prog.status <> 'active' THEN 'PROGRAM_NOT_ACTIVE'
    WHEN v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN 'CONFIG_CHANGED'
    WHEN public.cms__mapping_fp() <> v_run.mapping_fp THEN 'MAPPING_CHANGED'
    -- Q-206: chương trình thật không được công bố tiền tới khi cổng DB được mở bằng migration riêng.
    WHEN NOT v_run.is_test AND NOT public.cms__results_release_open() THEN 'RESULTS_RELEASE_GATE'
    -- 126 (PM 06/11 sales-only — trả hàng phase sau): chương trình thật có dòng điều chỉnh ĐÃ SEAL hoặc dòng ứng viên âm ⇒ KHÔNG công
    -- bố (không bỏ dòng âm để công bố riêng phần dương). Căn cứ chỉ là dữ liệu đã seal: totals.adjustment_lines (seal bước 10 đối
    -- chiếu = số dòng kết quả ADJUSTMENT; S12 ép ADJUSTMENT ⇔ dòng INCLUDED âm) + dòng không INCLUDED (chưa gán / ngoài phạm vi) âm
    -- đã stage (index cms_sales_lines_excluded_idx). totals thiếu / sai dạng ⇒ coi như có điều chỉnh (fail-closed; CASE giữ thứ tự,
    -- không ép kiểu chuỗi lạ).
    WHEN NOT v_run.is_test AND (
           CASE WHEN jsonb_typeof(v_run.seal_expect -> 'totals' -> 'adjustment_lines') = 'number'
                     AND (v_run.seal_expect -> 'totals' ->> 'adjustment_lines') ~ '^(0|[1-9][0-9]{0,8})$'
                THEN (v_run.seal_expect -> 'totals' ->> 'adjustment_lines')::bigint <> 0
                ELSE true END
        OR EXISTS (SELECT 1 FROM public.cms_sales_lines sl
                    WHERE sl.run_id = p_run_id AND sl.disposition <> 'INCLUDED' AND (sl.base_quantity < 0 OR sl.gmv_amount < 0)))
      THEN 'RETURNS_NOT_SUPPORTED_THIS_PHASE'
  END;
  IF v_code IS NOT NULL THEN
    UPDATE public.cms_sync_runs SET status = CASE WHEN v_code = 'STALE' THEN 'error' ELSE 'held' END,
           finished_at = now(), error_code = v_code
     WHERE id = p_run_id;
    RETURN jsonb_build_object('published', false, 'code', v_code, 'run_id', p_run_id);
  END IF;
  v_prev := v_prog.current_result_run_id;
  -- 126: đóng dấu căn cứ kết quả do DB quyết định (không nhận từ caller) — chương trình thật = CMS tạm tính theo dòng bán, chưa xử
  -- lý trả hàng. Không đổi seal / vân tay dòng 14 trường; run QA giữ nguyên như 122.
  UPDATE public.cms_sync_runs SET status = 'ok', finished_at = now(), published_at = now(),
         detail = CASE WHEN v_run.is_test THEN detail
                       ELSE detail || jsonb_build_object('results_basis', 'sales_only_v1', 'results_gate', '126') END
   WHERE id = p_run_id;
  UPDATE public.cms_programs SET current_result_run_id = p_run_id WHERE id = v_pid;
  RETURN jsonb_build_object('published', true, 'already', false, 'run_id', p_run_id, 'previous_run_id', v_prev);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_finish(p_run_id uuid, p_status text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_code text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('held', 'error') THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_STATUS' USING ERRCODE = '22023';
  END IF;
  IF p_detail IS NULL OR jsonb_typeof(p_detail) <> 'object' OR pg_column_size(p_detail) > 16384
     OR NOT public.cms__str(p_detail, 'error_code', '^[A-Z][A-Z0-9_]{0,63}$')
     OR NOT public.cms__str_or_null(p_detail, 'rows_read', '^(0|[1-9][0-9]{0,8})$')
     OR NOT public.cms__str_or_null(p_detail, 'rows_rejected', '^(0|[1-9][0-9]{0,8})$')
     OR NOT public.cms__str_or_null(p_detail, 'bytes_processed', '^(0|[1-9][0-9]{0,17})$') THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_DETAIL' USING ERRCODE = '22023';
  END IF;
  v_code := p_detail ->> 'error_code';
  UPDATE public.cms_sync_runs SET
    status          = p_status,
    finished_at     = now(),
    error_code      = v_code,
    rows_read       = COALESCE((p_detail ->> 'rows_read')::integer, rows_read),
    rows_rejected   = COALESCE((p_detail ->> 'rows_rejected')::integer, rows_rejected),
    bytes_processed = COALESCE((p_detail ->> 'bytes_processed')::bigint, bytes_processed),
    detail          = detail || (p_detail - 'error_code' - 'rows_read' - 'rows_rejected' - 'bytes_processed')
  WHERE id = p_run_id AND kind = 'sales' AND status = 'running';
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_result_header(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run  uuid;
  v_su   boolean := public.is_super_admin();
  v_cfg  integer;
  v_r    public.cms_sync_runs%ROWTYPE;
  v_last public.cms_sync_runs%ROWTYPE;
BEGIN
  v_run := public.cms__result_run(p_program_id, NULL);
  SELECT config_version INTO v_cfg FROM public.cms_programs WHERE id = p_program_id;
  SELECT * INTO v_last FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = p_program_id
   ORDER BY started_at DESC LIMIT 1;
  IF v_run IS NOT NULL THEN SELECT * INTO v_r FROM public.cms_sync_runs WHERE id = v_run; END IF;
  RETURN jsonb_build_object(
    'program_id', p_program_id,
    'config_version', v_cfg,
    'viewer', CASE WHEN v_su THEN 'super' ELSE (SELECT u.role FROM public.users u WHERE u.id = auth.uid()) END,
    'run', CASE WHEN v_run IS NULL THEN NULL ELSE
      jsonb_build_object('id', v_r.id, 'config_version', v_r.config_version, 'published_at', public.cms__ts(v_r.published_at),
                         'source_max_updated_at', public.cms__ts(v_r.source_max_updated_at), 'started_at', public.cms__ts(v_r.started_at))
      || CASE WHEN v_su THEN jsonb_build_object('amount_vnd', v_r.amount_vnd::text, 'rows_read', v_r.rows_read,
                                                'totals', v_r.detail -> 'totals') ELSE '{}'::jsonb END END,
    'last_attempt', CASE WHEN v_last.id IS NULL THEN NULL ELSE
      jsonb_build_object('status', v_last.status, 'started_at', public.cms__ts(v_last.started_at),
                         'finished_at', public.cms__ts(v_last.finished_at), 'is_current', v_last.id IS NOT DISTINCT FROM v_run)
      || CASE WHEN v_su THEN jsonb_build_object('id', v_last.id, 'error_code', v_last.error_code) ELSE '{}'::jsonb END END,
    'recent_runs', CASE WHEN v_su THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', q.id, 'status', q.status, 'error_code', q.error_code,
                                          'started_at', public.cms__ts(q.started_at), 'finished_at', public.cms__ts(q.finished_at),
                                          'rows_read', q.rows_read, 'amount_vnd', q.amount_vnd::text,
                                          'config_version', q.config_version, 'purged', q.purged_at IS NOT NULL)
                       ORDER BY q.started_at DESC)
        FROM (SELECT * FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = p_program_id
               ORDER BY started_at DESC LIMIT 10) q), '[]'::jsonb) END);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_result_rows(p_program_id uuid, p_run_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run   uuid;
  v_users uuid[];
  v_n     bigint;
BEGIN
  v_run := public.cms__result_run(p_program_id, p_run_id);
  IF v_run IS NULL THEN
    RETURN jsonb_build_object('run_id', NULL, 'results', '[]'::jsonb, 'catalog', '[]'::jsonb, 'users', '[]'::jsonb);
  END IF;
  v_users := public.cms__visible_result_users();
  SELECT count(*) INTO v_n FROM public.cms_results r WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users));
  IF v_n > 50000 THEN RAISE EXCEPTION 'CMS_RESULT_TOO_LARGE' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object(
    'run_id', v_run,
    'results', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'user_id', r.user_id, 'store_id', r.store_id, 'program_product_id', r.program_product_id, 'product_id', r.product_id,
        'gmv_basis', r.gmv_basis, 'base_quantity', r.base_quantity::text, 'per_unit', r.per_unit::text,
        'cms_quantity', r.cms_quantity::text, 'rewarded_quantity', r.rewarded_quantity::text,
        'cap_quantity', r.cap_quantity::text, 'at_cap', r.at_cap, 'gmv_amount', r.gmv_amount::text,
        'gate_gmv', r.gate_gmv::text, 'target_gmv', r.target_gmv::text, 'gate_met', r.gate_met,
        'gate_met_at', public.cms__ts(r.gate_met_at), 'potential_amount', r.potential_amount::text,
        'amount_vnd', r.amount_vnd::text, 'line_count', r.line_count) ORDER BY r.user_id, r.product_id)
      FROM public.cms_results r WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users))), '[]'::jsonb),
    'catalog', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'user_id', k.user_id, 'store_id', k.store_id, 'catalog_gmv', k.catalog_gmv::text, 'target_gmv', k.target_gmv::text,
        'met', k.met, 'met_at', public.cms__ts(k.met_at), 'line_count', k.line_count) ORDER BY k.user_id)
      FROM public.cms_result_catalog k WHERE k.run_id = v_run AND (v_users IS NULL OR k.user_id = ANY (v_users))), '[]'::jsonb),
    'users', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'full_name', u.full_name, 'store_id', u.store_id)
                                        ORDER BY u.id)
      FROM public.users u WHERE u.id IN (SELECT r.user_id FROM public.cms_results r
                                          WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users)))), '[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_result_lines(p_program_id uuid, p_run_id uuid, p_program_product_id uuid DEFAULT NULL,
                                            p_user_id uuid DEFAULT NULL, p_after_seq integer DEFAULT NULL,
                                            p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run   uuid;
  v_users uuid[];
  v_rows  jsonb;
  v_next  integer;
BEGIN
  IF p_run_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_after_seq IS NOT NULL AND p_after_seq < 0) THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  v_run := public.cms__result_run(p_program_id, p_run_id);
  v_users := public.cms__visible_result_users();
  IF p_user_id IS NOT NULL AND v_users IS NOT NULL AND NOT (p_user_id = ANY (v_users)) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'seq', q.seq, 'order_line_id', q.order_line_id, 'order_code', q.order_code, 'product_id', q.product_id,
      'program_product_id', q.program_product_id, 'user_id', q.user_id, 'store_id', q.store_id, 'pos_code', q.pos_code,
      'completed_at', public.cms__ts(q.completed_at), 'quantity_raw', q.quantity_raw, 'uom_raw', q.uom_raw,
      'base_quantity', q.base_quantity::text, 'gmv_amount', q.gmv_amount::text, 'base_before', q.base_before::text,
      'base_after', q.base_after::text, 'qty_before', q.qty_before::text, 'qty_after', q.qty_after::text,
      'amount_vnd', q.amount_vnd::text, 'status', q.status) ORDER BY q.seq), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT rl.seq, rl.order_line_id, sl.order_code, sl.product_id, rl.program_product_id, rl.user_id, sl.store_id,
                 sl.pos_code, sl.completed_at, sl.quantity_raw, sl.uom_raw, sl.base_quantity, sl.gmv_amount, rl.base_before,
                 rl.base_after, rl.qty_before, rl.qty_after, rl.amount_vnd, rl.status
            FROM public.cms_result_lines rl
            JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
           WHERE rl.run_id = v_run
             AND (v_users IS NULL OR rl.user_id = ANY (v_users))
             AND (p_user_id IS NULL OR rl.user_id = p_user_id)
             AND (p_program_product_id IS NULL OR rl.program_product_id = p_program_product_id)
             AND rl.seq > COALESCE(p_after_seq, -1)
           ORDER BY rl.seq LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'seq')::integer;
  END IF;
  RETURN jsonb_build_object('run_id', v_run, 'rows', v_rows, 'next_after_seq', v_next);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_source_attest(p_program_id uuid, p_run_id uuid, p_payload jsonb, p_idem uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '2s' AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_sha   text;
  v_old   public.cms_source_attestations%ROWTYPE;
  v_prog  public.cms_programs%ROWTYPE;
  v_run   public.cms_sync_runs%ROWTYPE;
  v_code  text;
  v_id    uuid;
  v_prev  uuid;
  v_n     bigint;
  v_maxat timestamptz;
  v_con   text;
  c_hex   CONSTANT text := '^[0-9a-f]{64}$';
  c_ts    CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?Z$';
  c_cnt   CONSTANT text := '^(0|[1-9][0-9]{0,8})$';
  c_date  CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';
BEGIN
  -- 1. Quyền: phiên authenticated của super (allowlist 2 nơi) + chương trình đọc được (QA cần marker cms_qa_access kể cả super —
  --    H9b, như đọc 122 / 123; db-reviewer P1-1); KHÔNG nhận actor từ tham số / payload.
  IF v_uid IS NULL OR NOT public.is_super_admin()
     OR NOT COALESCE(p_program_id = ANY (public.cms_readable_program_ids()), false) THEN
    RAISE EXCEPTION 'CMS_ATTEST_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  -- 2. Dạng đầu vào (trước mọi khoá / ghi). COALESCE(…, true): khoá thiếu ⇒ NULL ⇒ coi là SAI (db-reviewer P2-1 — trước r1 thiếu
  --    ack_reason lọt tới INSERT thành lỗi 23502 thô).
  IF COALESCE(p_program_id IS NULL OR p_run_id IS NULL OR p_idem IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR pg_column_size(p_payload) > 16384
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('fp_version', 'field_set', 'scope_from', 'scope_to',
                'scope_hash', 'run_rows_fp', 'run_file_sha256', 'reference_rows_fp', 'reference_file_sha256', 'reference_label', 'as_of',
                'reference_exported_at', 'run_exported_at', 'lines_compared', 'missing_lines', 'extra_lines', 'changed_lines',
                'tool_version', 'ack_reason'))
     OR jsonb_path_exists(p_payload, 'strict $.* ? (@.type() != "string")')
     OR NOT public.cms__str(p_payload, 'fp_version', '^cms-rows-fp-v1$')
     OR NOT public.cms__str(p_payload, 'field_set', '^decision10$')   -- PM COMP-P1-1: audit14 bị từ chối trước mọi khoá / ghi
     OR NOT public.cms__str(p_payload, 'scope_from', c_date) OR NOT public.cms__str(p_payload, 'scope_to', c_date)
     OR NOT public.cms__str(p_payload, 'scope_hash', c_hex) OR NOT public.cms__str(p_payload, 'run_rows_fp', c_hex)
     OR NOT public.cms__str(p_payload, 'run_file_sha256', c_hex) OR NOT public.cms__str(p_payload, 'reference_rows_fp', c_hex)
     OR NOT public.cms__str(p_payload, 'reference_file_sha256', c_hex)
     OR NOT public.cms__str(p_payload, 'reference_label', '^[^\x01-\x1f\x7f-\x9f]{3,200}$')
     OR (p_payload ->> 'reference_label') <> btrim(p_payload ->> 'reference_label')   -- r1 P2-2: không khoảng trắng đầu / cuối
     OR NOT public.cms__str(p_payload, 'as_of', c_ts) OR NOT public.cms__str(p_payload, 'reference_exported_at', c_ts)
     OR NOT public.cms__str(p_payload, 'run_exported_at', c_ts)
     OR NOT public.cms__str(p_payload, 'lines_compared', c_cnt) OR NOT public.cms__str(p_payload, 'missing_lines', c_cnt)
     OR NOT public.cms__str(p_payload, 'extra_lines', c_cnt) OR NOT public.cms__str(p_payload, 'changed_lines', c_cnt)
     OR NOT public.cms__str(p_payload, 'tool_version', '^cms-i4-compare-v1$')
     OR NOT public.cms__str(p_payload, 'ack_reason', '.')
     OR char_length(btrim(p_payload ->> 'ack_reason', E' \t\r\n\f\v')) NOT BETWEEN 10 AND 1000
     OR (p_payload ->> 'ack_reason') ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]', true) THEN
    RAISE EXCEPTION 'CMS_ATTEST_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  BEGIN
    PERFORM (p_payload ->> 'scope_from')::date, (p_payload ->> 'scope_to')::date, (p_payload ->> 'as_of')::timestamptz,
            (p_payload ->> 'reference_exported_at')::timestamptz, (p_payload ->> 'run_exported_at')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'CMS_ATTEST_BAD_INPUT' USING ERRCODE = '22023';
  END;
  v_sha := encode(sha256(convert_to(jsonb_build_object('program', p_program_id, 'run', p_run_id, 'payload', p_payload)::text, 'UTF8')), 'hex');
  -- 3. Khoá chương trình (thứ tự chương trình → run như publish / chốt / cleanup) rồi idempotency (sau khoá: lượt gọi lại song
  --    song cùng khoá chờ lượt đầu commit rồi thấy dòng).
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_old FROM public.cms_source_attestations WHERE idem_key = p_idem;
  IF FOUND THEN
    IF v_old.payload_sha256 = v_sha AND v_old.attested_by = v_uid THEN
      RETURN jsonb_build_object('attested', true, 'already', true, 'id', v_old.id, 'run_id', v_old.run_id,
                                'live', v_old.revoked_at IS NULL AND v_old.superseded_by IS NULL);
    END IF;
    RAISE EXCEPTION 'CMS_ATTEST_IDEM_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF v_prog.status = 'locked' THEN RAISE EXCEPTION 'CMS_PROGRAM_LOCKED' USING ERRCODE = 'P0001'; END IF;
  IF v_prog.status <> 'active' THEN RAISE EXCEPTION 'CMS_ATTEST_PROGRAM_NOT_ACTIVE' USING ERRCODE = 'P0001'; END IF;
  IF v_prog.current_result_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'CMS_ATTEST_RUN_NOT_CURRENT' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR SHARE;
  IF NOT FOUND OR v_run.program_id <> p_program_id OR v_run.kind <> 'sales' OR v_run.status <> 'ok' OR v_run.published_at IS NULL
     OR v_run.purged_at IS NOT NULL OR v_run.config_version IS DISTINCT FROM v_prog.config_version OR v_run.is_test <> v_prog.is_test THEN
    RAISE EXCEPTION 'CMS_ATTEST_STALE_RUN' USING ERRCODE = 'P0001';
  END IF;
  IF public.cms__mapping_fp() IS DISTINCT FROM v_run.mapping_fp THEN
    RAISE EXCEPTION 'CMS_ATTEST_STALE_MAPPING' USING ERRCODE = 'P0001';
  END IF;
  -- 4. Lớp nguồn của run phải đủ / khớp lớp engine (run cũ ⇒ LEGACY_RUN).
  v_code := public.cms__run_source_check(p_run_id);
  IF v_code IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE = 'CMS_ATTEST_' || v_code, ERRCODE = 'P0001'; END IF;
  -- 5. Phạm vi = chương trình hiện tại (kỳ + toàn bộ ProductID).
  IF (p_payload ->> 'scope_from')::date <> v_prog.start_date OR (p_payload ->> 'scope_to')::date <> v_prog.end_date
     OR (p_payload ->> 'scope_hash') <> public.cms__program_scope_hash(p_program_id) THEN
    RAISE EXCEPTION 'CMS_ATTEST_SCOPE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  -- 6. Kết quả đối soát phải KHỚP; số dòng = lớp nguồn của run; vân tay = DB tính lại (binding run — không chứng minh nguồn).
  IF (p_payload ->> 'missing_lines')::integer <> 0 OR (p_payload ->> 'extra_lines')::integer <> 0
     OR (p_payload ->> 'changed_lines')::integer <> 0
     OR (p_payload ->> 'reference_rows_fp') <> (p_payload ->> 'run_rows_fp') THEN
    RAISE EXCEPTION 'CMS_ATTEST_NOT_MATCH' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*), max(completed_at) INTO v_n, v_maxat FROM public.cms_sales_source_lines WHERE run_id = p_run_id;
  IF v_n = 0 OR (p_payload ->> 'lines_compared')::bigint <> v_n THEN
    RAISE EXCEPTION 'CMS_ATTEST_COUNT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF (p_payload ->> 'run_rows_fp') <> public.cms__run_source_fp(p_run_id, 'decision10') THEN
    RAISE EXCEPTION 'CMS_ATTEST_FP_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  -- 7. Mốc M: không dòng nguồn nào hoàn tất SAU M; M ≥ hết kỳ VN (payout ghi đủ tới ngày kết thúc — r1 P2-4, PM xác nhận);
  --    M ≤ lúc xuất hai file; xuất run sau khi run công bố; ba mốc không ở tương lai (> now() + 5 phút).
  IF v_maxat > (p_payload ->> 'as_of')::timestamptz
     OR (p_payload ->> 'as_of')::timestamptz < ((v_prog.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
     OR (p_payload ->> 'as_of')::timestamptz > (p_payload ->> 'reference_exported_at')::timestamptz
     OR (p_payload ->> 'as_of')::timestamptz > (p_payload ->> 'run_exported_at')::timestamptz
     OR (p_payload ->> 'run_exported_at')::timestamptz < v_run.published_at
     OR (p_payload ->> 'reference_exported_at')::timestamptz > now() + interval '5 minutes'
     OR (p_payload ->> 'run_exported_at')::timestamptz > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'CMS_ATTEST_AS_OF' USING ERRCODE = 'P0001';
  END IF;
  -- 8. Thay chứng nhận còn hiệu lực cũ của run (FK superseded_by hoãn tới COMMIT) rồi ghi. Cùng khoá idem gửi song song cho HAI
  --    chương trình (khoá chương trình khác nhau) ⇒ lượt sau chờ unique idem_key rồi vi phạm ⇒ IDEM_CONFLICT (r1 P2-3).
  v_id := gen_random_uuid();
  UPDATE public.cms_source_attestations SET superseded_by = v_id, superseded_at = now()
   WHERE run_id = p_run_id AND revoked_at IS NULL AND superseded_by IS NULL
   RETURNING id INTO v_prev;
  BEGIN
  INSERT INTO public.cms_source_attestations (id, program_id, run_id, config_version, mapping_fp, basis, fp_version, field_set,
    scope_from, scope_to, scope_hash, run_rows_fp, run_file_sha256, reference_rows_fp, reference_file_sha256, reference_label,
    as_of, reference_exported_at, run_exported_at, lines_compared, missing_lines, extra_lines, changed_lines, tool_version,
    ack_reason, idem_key, payload_sha256, attested_by)
  VALUES (v_id, p_program_id, p_run_id, v_run.config_version, v_run.mapping_fp, 'operator_reconciliation', p_payload ->> 'fp_version',
    p_payload ->> 'field_set', (p_payload ->> 'scope_from')::date, (p_payload ->> 'scope_to')::date, p_payload ->> 'scope_hash',
    p_payload ->> 'run_rows_fp', p_payload ->> 'run_file_sha256', p_payload ->> 'reference_rows_fp', p_payload ->> 'reference_file_sha256',
    p_payload ->> 'reference_label', (p_payload ->> 'as_of')::timestamptz, (p_payload ->> 'reference_exported_at')::timestamptz,
    (p_payload ->> 'run_exported_at')::timestamptz, (p_payload ->> 'lines_compared')::integer, 0, 0, 0, p_payload ->> 'tool_version',
    btrim(p_payload ->> 'ack_reason', E' \t\r\n\f\v'), p_idem, v_sha, v_uid);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    IF v_con = 'cms_source_attest_idem' THEN RAISE EXCEPTION 'CMS_ATTEST_IDEM_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    RAISE;
  END;
  RETURN jsonb_build_object('attested', true, 'already', false, 'id', v_id, 'run_id', p_run_id, 'superseded_id', v_prev, 'live', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_run_source_export(p_program_id uuid, p_run_id uuid, p_after_line_id text DEFAULT NULL, p_limit integer DEFAULT 5000)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run  public.cms_sync_runs%ROWTYPE;
  v_rows jsonb;
  v_last text;
  v_n    integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin()
     OR NOT COALESCE(p_program_id = ANY (public.cms_readable_program_ids()), false) THEN  -- r1 P1-1: QA cần marker
    RAISE EXCEPTION 'CMS_ATTEST_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_program_id IS NULL OR p_run_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 5000
     OR (p_after_line_id IS NOT NULL AND char_length(p_after_line_id) NOT BETWEEN 1 AND 100) THEN
    RAISE EXCEPTION 'CMS_ATTEST_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id AND program_id = p_program_id AND kind = 'sales';
  IF NOT FOUND OR v_run.status <> 'ok' OR v_run.published_at IS NULL THEN
    RAISE EXCEPTION 'CMS_ATTEST_RUN_NOT_PUBLISHED' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.purged_at IS NOT NULL THEN RAISE EXCEPTION 'CMS_RESULT_RUN_GONE' USING ERRCODE = 'P0001'; END IF;
  IF v_run.source_schema IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'CMS_ATTEST_LEGACY_RUN' USING ERRCODE = 'P0001'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order_line_id', q.order_line_id, 'order_id', q.order_id, 'order_code', q.order_code, 'product_id', q.product_id,
           'seller_email', q.seller_email, 'pos_code', q.pos_code, 'order_type', q.order_type, 'order_status', q.order_status,
           'completed_at', public.cms__ts(q.completed_at), 'quantity_raw', q.quantity_raw, 'uom_raw', q.uom_raw,
           'base_quantity', q.base_quantity::text, 'gmv_amount', q.gmv_amount::text,
           'source_updated_at', public.cms__ts(q.source_updated_at)) ORDER BY q.order_line_id COLLATE "C"), '[]'::jsonb),
         (array_agg(q.order_line_id ORDER BY q.order_line_id COLLATE "C" DESC))[1], count(*)
    INTO v_rows, v_last, v_n
    FROM (SELECT * FROM public.cms_sales_source_lines s
           WHERE s.run_id = p_run_id AND (p_after_line_id IS NULL OR s.order_line_id COLLATE "C" > p_after_line_id COLLATE "C")
           ORDER BY s.order_line_id COLLATE "C" LIMIT p_limit) q;
  -- total: CHỈ trang đầu (p_after_line_id NULL) — một lần đếm qua index (run_id, …) để CLI kiểm đủ dòng; trang sau NULL (không
  -- quét lại mỗi trang — PM COMP-P2-2).
  RETURN jsonb_build_object('run_id', p_run_id, 'source_schema', v_run.source_schema, 'rows', v_rows,
                            'next_after', CASE WHEN v_n = p_limit THEN v_last END,
                            'total', CASE WHEN p_after_line_id IS NULL
                                          THEN (SELECT count(*) FROM public.cms_sales_source_lines s WHERE s.run_id = p_run_id) END);
END;
$$;

-- ── Gỡ helper + cột (sau khi thân cũ không còn tham chiếu) ─────────────────
DROP FUNCTION public.cms__programs_basis_guard();
DROP FUNCTION public.cms__runs_basis_guard();
DROP FUNCTION public.cms__units_invalid(text[]);
DROP FUNCTION public.cms__calc_snapshot(uuid);
DROP FUNCTION public.cms__basis_policy(text);
DROP FUNCTION public.cms__qty_dec(text);
DROP FUNCTION public.cms__unit_key(text);
ALTER TABLE public.cms_sync_runs DROP COLUMN calculation_snapshot, DROP COLUMN calculation_policy_version, DROP COLUMN quantity_basis;
ALTER TABLE public.cms_programs DROP COLUMN quantity_basis;

-- ── ACL 17 hàm khôi phục: thu hồi đích danh rồi cấp đúng ma trận trước 128 (danh sách sinh từ generator) ──
REVOKE ALL ON FUNCTION
  public.cms__sales_snapshot(uuid),
  public.cms__config_fp(uuid),
  public.cms__attest_eval(uuid, uuid),
  public.cms__lock_eval(uuid, uuid, integer, text, boolean),
  public.rpc_cms_program_save(jsonb),
  public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid),
  public.rpc_cms_program_activate(uuid, uuid),
  public.rpc_cms_sales_run_open(uuid, jsonb),
  public.rpc_cms_sales_run_seal_begin(uuid, jsonb),
  public.rpc_cms_sales_run_seal_step(uuid, integer),
  public.rpc_cms_sales_run_publish(uuid),
  public.rpc_cms_sales_run_finish(uuid, text, jsonb),
  public.rpc_cms_result_header(uuid),
  public.rpc_cms_result_rows(uuid, uuid),
  public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer),
  public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid),
  public.rpc_cms_run_source_export(uuid, uuid, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.rpc_cms_program_save(jsonb),
  public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid),
  public.rpc_cms_program_activate(uuid, uuid),
  public.rpc_cms_sales_run_open(uuid, jsonb),
  public.rpc_cms_sales_run_seal_begin(uuid, jsonb),
  public.rpc_cms_sales_run_seal_step(uuid, integer),
  public.rpc_cms_sales_run_publish(uuid),
  public.rpc_cms_sales_run_finish(uuid, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.rpc_cms_result_header(uuid),
  public.rpc_cms_result_rows(uuid, uuid),
  public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer),
  public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid),
  public.rpc_cms_run_source_export(uuid, uuid, text, integer)
  TO authenticated;

-- ── Hậu kiểm ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r   record;
  v_n integer;
BEGIN
  v_n := 0;
  FOR r IN
    SELECT p.proname,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ','
                              ORDER BY CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END, x.privilege_type)
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl
      FROM pg_catalog.pg_proc p WHERE p.oid IN (SELECT unnest(ARRAY['public.cms__sales_snapshot(uuid)', 'public.cms__config_fp(uuid)', 'public.cms__attest_eval(uuid, uuid)', 'public.cms__lock_eval(uuid, uuid, integer, text, boolean)', 'public.rpc_cms_program_save(jsonb)', 'public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid)', 'public.rpc_cms_program_activate(uuid, uuid)', 'public.rpc_cms_sales_run_open(uuid, jsonb)', 'public.rpc_cms_sales_run_seal_begin(uuid, jsonb)', 'public.rpc_cms_sales_run_seal_step(uuid, integer)', 'public.rpc_cms_sales_run_publish(uuid)', 'public.rpc_cms_sales_run_finish(uuid, text, jsonb)', 'public.rpc_cms_result_header(uuid)', 'public.rpc_cms_result_rows(uuid, uuid)', 'public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer)', 'public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid)', 'public.rpc_cms_run_source_export(uuid, uuid, text, integer)']::regprocedure[]))
  LOOP
    v_n := v_n + 1;
    IF r.acl IS DISTINCT FROM (CASE WHEN r.proname IN ('rpc_cms_program_save', 'rpc_cms_import_commit', 'rpc_cms_program_activate', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_seal_begin', 'rpc_cms_sales_run_seal_step', 'rpc_cms_sales_run_publish', 'rpc_cms_sales_run_finish') THEN 'service_role:EXECUTE'
                                    WHEN r.proname IN ('rpc_cms_result_header', 'rpc_cms_result_rows', 'rpc_cms_result_lines', 'rpc_cms_source_attest', 'rpc_cms_run_source_export') THEN 'authenticated:EXECUTE' END) THEN
      RAISE EXCEPTION 'rollback 128 hậu kiểm: ACL % = %', r.proname, r.acl;
    END IF;
  END LOOP;
  IF v_n <> 17 THEN RAISE EXCEPTION 'rollback 128 hậu kiểm: cần 17 hàm khôi phục, có %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> 68 THEN RAISE EXCEPTION 'rollback 128 hậu kiểm: tổng hàm CMS phải 68, có %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND ((table_name = 'cms_programs' AND column_name = 'quantity_basis')
                   OR (table_name = 'cms_sync_runs' AND column_name IN ('quantity_basis', 'calculation_policy_version', 'calculation_snapshot')))) THEN
    RAISE EXCEPTION 'rollback 128 hậu kiểm: còn cột cơ sở tính';
  END IF;
END $$;
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__sales_snapshot(uuid)'::regprocedure) IS DISTINCT FROM 'e22120f8a95af5308420914c441ca260'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__config_fp(uuid)'::regprocedure) IS DISTINCT FROM '08cf01ecc1809866eff314b5ec82d170'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__attest_eval(uuid, uuid)'::regprocedure) IS DISTINCT FROM 'a75e03e0b4c7a45c446af38698cf44e9'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__lock_eval(uuid, uuid, integer, text, boolean)'::regprocedure) IS DISTINCT FROM '6c38e2ca40f37d1cc5e715f8cd3e2bb5'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_program_save(jsonb)'::regprocedure) IS DISTINCT FROM '5f9360e7c3c1d4dd828b50f8fc1c2115'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid)'::regprocedure) IS DISTINCT FROM '65bd0b43e24fda590eec4cd764f959c2'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_program_activate(uuid, uuid)'::regprocedure) IS DISTINCT FROM '6ae92590bf7afc237c80cc3db15e5aad'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_open(uuid, jsonb)'::regprocedure) IS DISTINCT FROM 'a0123bc5abeefac9da1c8dbcd645a97a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_seal_begin(uuid, jsonb)'::regprocedure) IS DISTINCT FROM '327d53af6739ffdbf780363aa6460bcc'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_seal_step(uuid, integer)'::regprocedure) IS DISTINCT FROM '55462ce6e7a5b5e6ad26a2c1751ca726'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure) IS DISTINCT FROM 'db2c97efad2bb5ee9d69399b99c7c258'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_finish(uuid, text, jsonb)'::regprocedure) IS DISTINCT FROM '20a74c4806dfc520ce165c181e09c739'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_result_header(uuid)'::regprocedure) IS DISTINCT FROM '26abaac3902886c1e82c92a9dcf321ec'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_result_rows(uuid, uuid)'::regprocedure) IS DISTINCT FROM 'a63f54b3243637c2c8979d0bc24c9d81'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer)'::regprocedure) IS DISTINCT FROM 'c1bf6ff7c059a4b3fe13c140205306cd'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid)'::regprocedure) IS DISTINCT FROM '32b51294e2837918377ba37007da38f1'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_run_source_export(uuid, uuid, text, integer)'::regprocedure) IS DISTINCT FROM '8f1d48eaf1b532490cfc3582a6312d18' THEN
    RAISE EXCEPTION 'rollback 128 hậu kiểm: thân 17 hàm khôi phục lệch nguyên văn (md5)';
  END IF;
END $$;

DELETE FROM public.app_migrations WHERE version = '128';

COMMIT;
