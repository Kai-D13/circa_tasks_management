-- Đoạn vá thân hàm thay (thiết kế r2 §1.1): gen-cms-130.mjs lấy ĐỊNH NGHĨA CUỐI 120–126 của hàm, thay mỗi khối gốc bằng khối mới
-- (khớp ĐÚNG MỘT lần), rồi phát CREATE OR REPLACE. Thân còn lại nguyên văn — rollback dựng lại thân gốc, md5 hai chiều.
-- Định dạng: dòng PATCH <hàm> <nhãn>, dòng FROM, văn bản gốc, dòng TO, văn bản mới, dòng END (marker dạng `-- @@X`; dòng giữa lấy
-- nguyên văn, nối bằng LF).

-- @@PATCH rpc_cms_sales_run_open khai-bao
-- @@FROM
  v_sch  smallint;  -- 124
BEGIN
-- @@TO
  v_sch  smallint;  -- 124
  v_ct   boolean;   -- 130: run contract
BEGIN
-- @@END

-- @@PATCH rpc_cms_sales_run_open ghim-run
-- @@FROM
  v_snap := public.cms__sales_snapshot(p_program_id);
  INSERT INTO public.cms_sync_runs (kind, program_id, config_version, is_test, mapping_fp, detail)
  VALUES ('sales', p_program_id, v_prog.config_version, v_prog.is_test, v_snap ->> 'mapping_fp', p_detail)
  RETURNING id, source_schema INTO v_id, v_sch;
-- @@TO
  v_snap := public.cms__sales_snapshot(p_program_id);
  -- 130: run contract ⇔ chương trình cms_unit HOẶC net_returns_v1. 6 cột ghim lấy từ CHƯƠNG TRÌNH (dòng đã khoá FOR UPDATE ở trên),
  -- không từ caller; run legacy để NULL ⇒ đường 122–126 nguyên hành vi. Chương trình active luôn có basis (cms_programs_basis_draft).
  IF v_prog.quantity_basis IS NULL THEN RAISE EXCEPTION 'CMS_BASIS_NOT_SET' USING ERRCODE = 'P0001'; END IF;
  v_ct := v_prog.quantity_basis <> 'pos_base' OR v_prog.returns_policy <> 'sales_only_v1';
  INSERT INTO public.cms_sync_runs (kind, program_id, config_version, is_test, mapping_fp, detail, quantity_basis,
    quantity_policy_version, returns_policy, calc_contract_version, unit_key_version, status_dictionary_version)
  VALUES ('sales', p_program_id, v_prog.config_version, v_prog.is_test, v_snap ->> 'mapping_fp', p_detail,
          CASE WHEN v_ct THEN v_prog.quantity_basis END,
          CASE WHEN v_ct THEN CASE v_prog.quantity_basis WHEN 'pos_base' THEN '@@QPV_POS@@' WHEN 'cms_unit' THEN '@@QPV_UNIT@@' END END,
          CASE WHEN v_ct THEN v_prog.returns_policy END, CASE WHEN v_ct THEN '@@CALC_CONTRACT@@' END,
          CASE WHEN v_ct THEN '@@UNIT_KEY_VERSION@@' END, CASE WHEN v_ct THEN '@@STATUS_VERSION@@' END)
  RETURNING id, source_schema INTO v_id, v_sch;
  -- Worker không khai đúng hợp đồng (app cũ / cờ OFF) trên chương trình contract ⇒ VẪN có run (vết), đóng held ngay; pointer giữ.
  IF v_ct AND p_detail ->> 'calc_contract' IS DISTINCT FROM '@@CALC_CONTRACT@@' THEN
    UPDATE public.cms_sync_runs SET status = 'held', finished_at = now(), error_code = 'CMS_WORKER_UNSUPPORTED' WHERE id = v_id;
    RETURN jsonb_build_object('run_id', v_id, 'held', true, 'error_code', 'CMS_WORKER_UNSUPPORTED');
  END IF;
-- @@END

-- @@PATCH rpc_cms_sales_run_open tra-ve
-- @@FROM
  RETURN v_snap || jsonb_build_object('run_id', v_id, 'source_schema', v_sch);
-- @@TO
  RETURN v_snap || jsonb_build_object('run_id', v_id, 'source_schema', v_sch,
                                      'calc_contract_version', CASE WHEN v_ct THEN '@@CALC_CONTRACT@@' END);
-- @@END

-- @@PATCH rpc_cms_sales_run_stage re-nhanh
-- @@FROM
BEGIN
  IF p_part IS NULL OR p_part NOT IN ('sales_lines', 'results', 'catalog', 'result_lines', 'source_lines') THEN
-- @@TO
BEGIN
  -- 130: run contract ⇒ thân riêng (whitelist part / cột khác); run legacy đi tiếp thân 124 nguyên văn.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = p_run_id AND calc_contract_version IS NOT NULL) THEN
    RETURN public.cms__stage_contract(p_run_id, p_part, p_chunk_no, p_rows);
  END IF;
  IF p_part IS NULL OR p_part NOT IN ('sales_lines', 'results', 'catalog', 'result_lines', 'source_lines') THEN
-- @@END

-- @@PATCH rpc_cms_sales_run_seal_begin re-nhanh
-- @@FROM
BEGIN
  IF p_expect IS NULL OR jsonb_typeof(p_expect) <> 'object' OR pg_column_size(p_expect) > 65536
-- @@TO
BEGIN
  -- 130: run contract ⇒ expect / pin / part riêng, 13 bước.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = p_run_id AND calc_contract_version IS NOT NULL) THEN
    RETURN public.cms__seal_begin_contract(p_run_id, p_expect);
  END IF;
  IF p_expect IS NULL OR jsonb_typeof(p_expect) <> 'object' OR pg_column_size(p_expect) > 65536
-- @@END

-- @@PATCH rpc_cms_sales_run_seal_step re-nhanh
-- @@FROM
BEGIN
  IF p_step IS NULL OR p_step < 1 OR p_step > 10 THEN RAISE EXCEPTION 'CMS_SEAL_BAD_STEP' USING ERRCODE = '22023'; END IF;
-- @@TO
BEGIN
  -- 130: run contract ⇒ 13 bước tự tính lại (cms__seal_contract_step).
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = p_run_id AND calc_contract_version IS NOT NULL) THEN
    RETURN public.cms__seal_contract_step(p_run_id, p_step);
  END IF;
  IF p_step IS NULL OR p_step < 1 OR p_step > 10 THEN RAISE EXCEPTION 'CMS_SEAL_BAD_STEP' USING ERRCODE = '22023'; END IF;
-- @@END

-- @@PATCH rpc_cms_sales_run_cleanup bang-contract
-- @@FROM
    v_left := p_max_rows;
    DELETE FROM public.cms_result_lines
-- @@TO
    v_left := p_max_rows;
    -- 130: bảng run contract trước (FK tới cms_sales_lines / cms_results / cms_return_lines). Còn dòng ⇒ v_left = 0 ⇒ chuỗi dưới
    -- (LIMIT 0 / điều kiện v_left > 0) không chạm bảng cha ở lượt này.
    DELETE FROM public.cms_result_events WHERE ctid IN (SELECT ctid FROM public.cms_result_events WHERE run_id = v_id LIMIT v_left);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_result_events WHERE run_id = v_id) THEN
      DELETE FROM public.cms_return_lines WHERE ctid IN (SELECT ctid FROM public.cms_return_lines WHERE run_id = v_id LIMIT v_left);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
    DELETE FROM public.cms_result_lines
-- @@END

-- @@PATCH rpc_cms_sales_run_cleanup clear-kiem
-- @@FROM
       AND NOT EXISTS (SELECT 1 FROM public.cms_sync_run_chunks WHERE run_id = v_id) THEN
-- @@TO
       AND NOT EXISTS (SELECT 1 FROM public.cms_sync_run_chunks WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_result_events WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_return_lines WHERE run_id = v_id) THEN
-- @@END

-- @@PATCH cms__sales_snapshot san-pham
-- @@FROM
        'base_quantity_cms', pp.base_quantity_cms::text,
-- @@TO
        'base_quantity_cms', pp.base_quantity_cms::text, 'unit_cms', pp.unit_cms,
-- @@END

-- @@PATCH cms__sales_snapshot che-do
-- @@FROM
    'mapping_fp', public.cms__mapping_fp())
-- @@TO
    'mapping_fp', public.cms__mapping_fp(),
    -- 130: chế độ của CHƯƠNG TRÌNH (run ghim riêng ở open); app cũ bỏ qua khoá lạ.
    'quantity_basis', p.quantity_basis, 'returns_policy', p.returns_policy)
-- @@END

-- @@PATCH rpc_cms_sales_run_publish re-nhanh
-- @@FROM
  IF p_run_id IS NULL THEN RAISE EXCEPTION 'CMS_SALES_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT program_id INTO v_pid FROM public.cms_sync_runs WHERE id = p_run_id AND kind = 'sales';
-- @@TO
  IF p_run_id IS NULL THEN RAISE EXCEPTION 'CMS_SALES_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  -- 130: run contract ⇒ publish atomic có ledger trả hàng (cms__publish_contract); phần dưới là đường legacy 126 nguyên văn.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = p_run_id AND calc_contract_version IS NOT NULL) THEN
    RETURN public.cms__publish_contract(p_run_id);
  END IF;
  SELECT program_id INTO v_pid FROM public.cms_sync_runs WHERE id = p_run_id AND kind = 'sales';
-- @@END

-- @@PATCH rpc_cms_result_header chan-contract
-- @@FROM
  v_run := public.cms__result_run(p_program_id, NULL);
-- @@TO
  v_run := public.cms__result_run(p_program_id, NULL);
  -- 130: run contract chỉ đọc qua reader v2 — app cũ / app rollback không hiện số run contract dưới nhãn pos_base / thiếu trả hàng.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = v_run AND calc_contract_version IS NOT NULL) THEN
    RAISE EXCEPTION 'CMS_RESULT_CONTRACT_UNSUPPORTED' USING ERRCODE = 'P0001';
  END IF;
-- @@END

-- @@PATCH rpc_cms_result_rows chan-contract
-- @@FROM
  v_run := public.cms__result_run(p_program_id, p_run_id);
-- @@TO
  v_run := public.cms__result_run(p_program_id, p_run_id);
  -- 130: run contract chỉ đọc qua reader v2 — app cũ / app rollback không hiện số run contract dưới nhãn pos_base / thiếu trả hàng.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = v_run AND calc_contract_version IS NOT NULL) THEN
    RAISE EXCEPTION 'CMS_RESULT_CONTRACT_UNSUPPORTED' USING ERRCODE = 'P0001';
  END IF;
-- @@END

-- @@PATCH rpc_cms_result_lines chan-contract
-- @@FROM
  v_run := public.cms__result_run(p_program_id, p_run_id);
-- @@TO
  v_run := public.cms__result_run(p_program_id, p_run_id);
  -- 130: run contract chỉ đọc qua reader v2 — app cũ / app rollback không hiện số run contract dưới nhãn pos_base / thiếu trả hàng.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = v_run AND calc_contract_version IS NOT NULL) THEN
    RAISE EXCEPTION 'CMS_RESULT_CONTRACT_UNSUPPORTED' USING ERRCODE = 'P0001';
  END IF;
-- @@END

-- @@PATCH rpc_cms_result_excluded chan-contract
-- @@FROM
  v_run := public.cms__result_run(p_program_id, p_run_id);
-- @@TO
  v_run := public.cms__result_run(p_program_id, p_run_id);
  -- 130: run contract chỉ đọc qua reader v2 — app cũ / app rollback không hiện số run contract dưới nhãn pos_base / thiếu trả hàng.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = v_run AND calc_contract_version IS NOT NULL) THEN
    RAISE EXCEPTION 'CMS_RESULT_CONTRACT_UNSUPPORTED' USING ERRCODE = 'P0001';
  END IF;
-- @@END

-- @@PATCH cms__lock_eval contract-che-do
-- @@FROM
      v_b := array_append(v_b, 'CMS_LOCK_STALE_RUN');
    END IF;
  END IF;
-- @@TO
      v_b := array_append(v_b, 'CMS_LOCK_STALE_RUN');
    END IF;
    -- 130: run contract chưa chốt được trong batch này (payout / payout_staff / XLSX chốt đọc lớp legacy) ⇒ chặn. Chế độ chương trình
    -- phải khớp căn cứ của run hiện hành (legacy = pos_base + sales_only_v1): đổi chế độ mà pointer còn run cũ ⇒ chặn, không chốt số
    -- tính theo chế độ khác chế độ đang công bố cho chương trình.
    IF v_run.calc_contract_version IS NOT NULL THEN
      v_b := array_append(v_b, 'CMS_LOCK_CONTRACT_UNSUPPORTED');
    END IF;
    IF (v_prog.quantity_basis, v_prog.returns_policy) IS DISTINCT FROM
       (CASE WHEN v_run.calc_contract_version IS NULL THEN 'pos_base' ELSE v_run.quantity_basis END,
        CASE WHEN v_run.calc_contract_version IS NULL THEN 'sales_only_v1' ELSE v_run.returns_policy END) THEN
      v_b := array_append(v_b, 'CMS_LOCK_POLICY_POINTER_MISMATCH');
    END IF;
  END IF;
  -- 130 (D14): còn conflict trả hàng mở ⇒ không chốt (đọc dưới khoá chương trình của RPC chốt — cùng khoá ghi conflict).
  IF EXISTS (SELECT 1 FROM public.cms_return_conflicts c WHERE c.program_id = v_prog.id
              AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id)) THEN
    v_b := array_append(v_b, 'CMS_LOCK_RETURN_CONFLICT');
  END IF;
-- @@END

-- @@PATCH cms__attest_eval contract
-- @@FROM
  v_code := CASE
    WHEN v_run.config_version IS DISTINCT FROM v_a.config_version OR v_prog.config_version IS DISTINCT FROM v_a.config_version THEN 'STALE_CONFIG'
-- @@TO
  v_code := CASE
    -- 130: chứng nhận đối soát decision10 chỉ định nghĩa cho run legacy (lớp nguồn / vân tay 124) ⇒ run contract không dùng được.
    WHEN v_run.calc_contract_version IS NOT NULL THEN 'CONTRACT_UNSUPPORTED'
    WHEN v_run.config_version IS DISTINCT FROM v_a.config_version OR v_prog.config_version IS DISTINCT FROM v_a.config_version THEN 'STALE_CONFIG'
-- @@END
