
-- ── 8b. Reader v2 (thiết kế r2 §8.2) — authenticated, STABLE SECDEF, phạm vi cms__result_run / cms__visible_result_users (122) ──
-- Đọc cả run legacy (cms_result_lines ↦ sự kiện SALE) lẫn run contract. Mỗi phản hồi mang khối `contract` ghim TỪ RUN (không từ cờ /
-- chương trình). Email / POS người bán gốc của phiếu trả chỉ ở returns_v2 (super). Reader cũ 122 RAISE trên run contract (đoạn chèn R).

-- Khối hợp đồng của run (chỉ owner): run legacy = pos_base + sales_only_v1 (đúng nghĩa T11 — không nhãn giả cho run contract).
CREATE FUNCTION public.cms__run_contract(p_run_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN r.calc_contract_version IS NULL THEN
           jsonb_build_object('legacy', true, 'calc_contract_version', NULL, 'quantity_basis', 'pos_base', 'returns_policy', 'sales_only_v1')
         ELSE jsonb_build_object('legacy', false, 'calc_contract_version', r.calc_contract_version, 'quantity_basis', r.quantity_basis,
                'quantity_policy_version', r.quantity_policy_version, 'returns_policy', r.returns_policy,
                'unit_key_version', r.unit_key_version, 'status_dictionary_version', r.status_dictionary_version,
                'returns_as_of', CASE WHEN r.returns_as_of IS NOT NULL THEN public.cms__ts(r.returns_as_of) END) END
    FROM public.cms_sync_runs r
   WHERE r.id = p_run_id
$$;

CREATE FUNCTION public.rpc_cms_result_header_v2(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run  uuid;
  v_su   boolean := public.is_super_admin();
  v_prog public.cms_programs%ROWTYPE;
  v_r    public.cms_sync_runs%ROWTYPE;
  v_last public.cms_sync_runs%ROWTYPE;
BEGIN
  v_run := public.cms__result_run(p_program_id, NULL);
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id;
  SELECT * INTO v_last FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = p_program_id ORDER BY started_at DESC LIMIT 1;
  IF v_run IS NOT NULL THEN SELECT * INTO v_r FROM public.cms_sync_runs WHERE id = v_run; END IF;
  RETURN jsonb_build_object(
    'program_id', p_program_id,
    'config_version', v_prog.config_version,
    'program_mode', jsonb_build_object('quantity_basis', v_prog.quantity_basis, 'returns_policy', v_prog.returns_policy),
    'viewer', CASE WHEN v_su THEN 'super' ELSE (SELECT u.role FROM public.users u WHERE u.id = auth.uid()) END,
    'run', CASE WHEN v_run IS NULL THEN NULL ELSE
      jsonb_build_object('id', v_r.id, 'config_version', v_r.config_version, 'published_at', public.cms__ts(v_r.published_at),
                         'source_max_updated_at', public.cms__ts(v_r.source_max_updated_at), 'started_at', public.cms__ts(v_r.started_at),
                         'contract', public.cms__run_contract(v_r.id))
      || CASE WHEN v_su THEN jsonb_build_object('amount_vnd', v_r.amount_vnd::text, 'rows_read', v_r.rows_read,
                                                'totals', CASE WHEN v_r.calc_contract_version IS NULL THEN v_r.detail -> 'totals'
                                                               ELSE v_r.seal_expect -> 'totals' END,
                                                'returns_rows_read', v_r.returns_rows_read,
                                                'ledger', CASE WHEN v_r.ledger_verdict IS NULL THEN NULL
                                                               ELSE jsonb_build_object('verdict', v_r.ledger_verdict, 'eval_seq', v_r.ledger_eval_seq,
                                                                                       'set_hash', v_r.ledger_set_hash) END)
             ELSE '{}'::jsonb END END,
    'last_attempt', CASE WHEN v_last.id IS NULL THEN NULL ELSE
      jsonb_build_object('status', v_last.status, 'started_at', public.cms__ts(v_last.started_at),
                         'finished_at', public.cms__ts(v_last.finished_at), 'is_current', v_last.id IS NOT DISTINCT FROM v_run)
      || CASE WHEN v_su THEN jsonb_build_object('id', v_last.id, 'error_code', v_last.error_code, 'ledger_verdict', v_last.ledger_verdict)
              ELSE '{}'::jsonb END END,
    'recent_runs', CASE WHEN v_su THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', q.id, 'status', q.status, 'error_code', q.error_code,
                                          'started_at', public.cms__ts(q.started_at), 'finished_at', public.cms__ts(q.finished_at),
                                          'rows_read', q.rows_read, 'amount_vnd', q.amount_vnd::text, 'config_version', q.config_version,
                                          'purged', q.purged_at IS NOT NULL, 'calc_contract_version', q.calc_contract_version,
                                          'quantity_basis', q.quantity_basis, 'returns_policy', q.returns_policy,
                                          'ledger_verdict', q.ledger_verdict, 'ledger_eval_seq', q.ledger_eval_seq)
                       ORDER BY q.started_at DESC)
        FROM (SELECT * FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = p_program_id
               ORDER BY started_at DESC LIMIT 10) q), '[]'::jsonb) END,
    'ledger', CASE WHEN v_su AND v_prog.returns_policy = 'net_returns_v1' THEN jsonb_build_object(
      'baselines', (SELECT count(*) FROM public.cms_return_baselines b WHERE b.program_id = p_program_id),
      'open_conflicts', (SELECT count(*) FROM public.cms_return_conflicts c WHERE c.program_id = p_program_id
                            AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id)),
      'latest_eval_seq', (SELECT max(e.eval_seq) FROM public.cms_return_ledger_evals e WHERE e.program_id = p_program_id)) END);
END;
$$;

CREATE FUNCTION public.rpc_cms_result_rows_v2(p_program_id uuid, p_run_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run   uuid;
  v_users uuid[];
  v_n     bigint;
BEGIN
  v_run := public.cms__result_run(p_program_id, p_run_id);
  IF v_run IS NULL THEN
    RETURN jsonb_build_object('run_id', NULL, 'contract', NULL, 'results', '[]'::jsonb, 'catalog', '[]'::jsonb, 'users', '[]'::jsonb);
  END IF;
  v_users := public.cms__visible_result_users();
  SELECT count(*) INTO v_n FROM public.cms_results r WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users));
  IF v_n > 50000 THEN RAISE EXCEPTION 'CMS_RESULT_TOO_LARGE' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object(
    'run_id', v_run,
    'contract', public.cms__run_contract(v_run),
    'results', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'user_id', r.user_id, 'store_id', r.store_id, 'program_product_id', r.program_product_id, 'product_id', r.product_id,
        'gmv_basis', r.gmv_basis, 'base_quantity', r.base_quantity::text, 'per_unit', r.per_unit::text,
        'cms_quantity', r.cms_quantity::text, 'rewarded_quantity', r.rewarded_quantity::text,
        'cap_quantity', r.cap_quantity::text, 'at_cap', r.at_cap, 'gmv_amount', r.gmv_amount::text,
        'gate_gmv', r.gate_gmv::text, 'target_gmv', r.target_gmv::text, 'gate_met', r.gate_met,
        'gate_met_at', public.cms__ts(r.gate_met_at), 'potential_amount', r.potential_amount::text,
        'amount_vnd', r.amount_vnd::text, 'line_count', r.line_count,
        'net', CASE WHEN r.net_v IS NULL THEN NULL ELSE jsonb_build_object(
          'sale_base', r.sale_base::text, 'return_base', r.return_base::text, 'eligible_sale_base', r.eligible_sale_base::text,
          'eligible_return_base', r.eligible_return_base::text, 'eligible_base', r.eligible_base::text,
          'counted_sale_qty', r.counted_sale_qty::text, 'sale_gmv', r.sale_gmv::text, 'return_gmv', r.return_gmv::text,
          'return_count', r.return_count) END) ORDER BY r.user_id, r.product_id)
      FROM public.cms_results r WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users))), '[]'::jsonb),
    'catalog', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'user_id', k.user_id, 'store_id', k.store_id, 'catalog_gmv', k.catalog_gmv::text, 'target_gmv', k.target_gmv::text,
        'met', k.met, 'met_at', public.cms__ts(k.met_at), 'line_count', k.line_count) ORDER BY k.user_id)
      FROM public.cms_result_catalog k WHERE k.run_id = v_run AND (v_users IS NULL OR k.user_id = ANY (v_users))), '[]'::jsonb),
    'users', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'full_name', u.full_name, 'store_id', u.store_id) ORDER BY u.id)
      FROM public.users u WHERE u.id IN (SELECT r.user_id FROM public.cms_results r
                                          WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users)))), '[]'::jsonb));
END;
$$;

-- Sự kiện tính theo nhóm (keyset seq). Run contract: cms_result_events (SALE + RETURN). Run legacy: cms_result_lines ↦ SALE (lớp lượng
-- POS_BASE, B đủ = B). RETURN không trả POS / email gốc.
CREATE FUNCTION public.rpc_cms_result_events_v2(p_program_id uuid, p_run_id uuid, p_program_product_id uuid DEFAULT NULL,
                                                p_user_id uuid DEFAULT NULL, p_after_seq integer DEFAULT NULL, p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run   uuid;
  v_users uuid[];
  v_rows  jsonb;
  v_next  integer;
  v_ct    boolean;
  v_uid   uuid;
BEGIN
  IF p_run_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_after_seq IS NOT NULL AND p_after_seq < 0) THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  v_run := public.cms__result_run(p_program_id, p_run_id);
  v_users := public.cms__visible_result_users();
  IF p_user_id IS NOT NULL AND v_users IS NOT NULL AND NOT (p_user_id = ANY (v_users)) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Người xem chỉ thấy MỘT dược sĩ ⇒ lọc user ngay từ index (run_id, user_id, seq), không quét cả run theo seq rồi lọc (db-reviewer
  -- 14/11 P2-6).
  v_uid := COALESCE(p_user_id, CASE WHEN cardinality(v_users) = 1 THEN v_users[1] END);
  SELECT r.calc_contract_version IS NOT NULL INTO v_ct FROM public.cms_sync_runs r WHERE r.id = v_run;
  IF v_ct THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'seq', q.seq, 'kind', q.kind, 'event_key', q.event_key, 'event_at', public.cms__ts(q.event_at), 'order_line_id', q.order_line_id,
        'order_code', q.order_code, 'product_id', q.product_id, 'program_product_id', q.program_product_id, 'user_id', q.user_id,
        'store_id', q.store_id, 'pos_code', CASE WHEN q.kind = 'SALE' THEN q.pos_code END,
        'quantity_raw', CASE WHEN q.kind = 'SALE' THEN q.quantity_raw END, 'uom_raw', CASE WHEN q.kind = 'SALE' THEN q.uom_raw END,
        'quantity_class', q.quantity_class, 'return_event_id', q.return_event_id, 'return_code', q.return_code,
        'base_delta', q.base_delta::text, 'eligible_delta', q.eligible_delta::text, 'gmv_delta', q.gmv_delta::text,
        'eligible_before', q.eligible_before::text, 'eligible_after', q.eligible_after::text,
        'qty_before', q.qty_before::text, 'qty_after', q.qty_after::text, 'amount_vnd', q.amount_vnd::text, 'status', q.status)
        ORDER BY q.seq), '[]'::jsonb)
      INTO v_rows
      FROM (SELECT e.seq, e.kind, e.event_key, e.event_at, e.order_line_id, sl.order_code, sl.product_id, e.program_product_id, e.user_id,
                   sl.store_id, sl.pos_code, sl.quantity_raw, sl.uom_raw, e.quantity_class, e.return_event_id, rt.return_code,
                   e.base_delta, e.eligible_delta, e.gmv_delta, e.eligible_before, e.eligible_after, e.qty_before, e.qty_after,
                   e.amount_vnd, e.status
              FROM public.cms_result_events e
              JOIN public.cms_sales_lines sl ON sl.run_id = e.run_id AND sl.order_line_id = e.order_line_id
              LEFT JOIN public.cms_return_lines rt ON rt.run_id = e.run_id AND rt.return_event_id = e.return_event_id
             WHERE e.run_id = v_run
               AND (v_users IS NULL OR e.user_id = ANY (v_users))
               AND (v_uid IS NULL OR e.user_id = v_uid)
               AND (p_program_product_id IS NULL OR e.program_product_id = p_program_product_id)
               AND e.seq > COALESCE(p_after_seq, -1)
             ORDER BY e.seq LIMIT p_limit + 1) q;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'seq', q.seq, 'kind', 'SALE', 'event_key', 'SALE:' || q.order_line_id, 'event_at', public.cms__ts(q.completed_at),
        'order_line_id', q.order_line_id, 'order_code', q.order_code, 'product_id', q.product_id,
        'program_product_id', q.program_product_id, 'user_id', q.user_id, 'store_id', q.store_id, 'pos_code', q.pos_code,
        'quantity_raw', q.quantity_raw, 'uom_raw', q.uom_raw, 'quantity_class', 'POS_BASE', 'return_event_id', NULL, 'return_code', NULL,
        'base_delta', q.base_quantity::text, 'eligible_delta', q.base_quantity::text, 'gmv_delta', q.gmv_amount::text,
        'eligible_before', q.base_before::text, 'eligible_after', q.base_after::text,
        'qty_before', q.qty_before::text, 'qty_after', q.qty_after::text, 'amount_vnd', q.amount_vnd::text, 'status', q.status)
        ORDER BY q.seq), '[]'::jsonb)
      INTO v_rows
      FROM (SELECT rl.seq, rl.order_line_id, sl.order_code, sl.product_id, rl.program_product_id, rl.user_id, sl.store_id,
                   sl.pos_code, sl.completed_at, sl.quantity_raw, sl.uom_raw, sl.base_quantity, sl.gmv_amount, rl.base_before,
                   rl.base_after, rl.qty_before, rl.qty_after, rl.amount_vnd, rl.status
              FROM public.cms_result_lines rl
              JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
             WHERE rl.run_id = v_run
               AND (v_users IS NULL OR rl.user_id = ANY (v_users))
               AND (v_uid IS NULL OR rl.user_id = v_uid)
               AND (p_program_product_id IS NULL OR rl.program_product_id = p_program_product_id)
               AND rl.seq > COALESCE(p_after_seq, -1)
             ORDER BY rl.seq LIMIT p_limit + 1) q;
  END IF;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'seq')::integer;
  END IF;
  RETURN jsonb_build_object('run_id', v_run, 'contract', public.cms__run_contract(v_run), 'rows', v_rows, 'next_after_seq', v_next);
END;
$$;

-- Dòng không tính (super): p_kind = 'disposition' (dòng bán không INCLUDED — như 122, kèm lớp lượng) hoặc 'quantity' (dòng INCLUDED
-- của run contract mà lớp lượng không đếm: OTHER_UNIT / FRACTIONAL_QUANTITY / ZERO_QUANTITY). Super kiểm TRƯỚC khi tra run.
CREATE FUNCTION public.rpc_cms_result_excluded_v2(p_program_id uuid, p_run_id uuid, p_kind text, p_after_seq integer DEFAULT NULL,
                                                  p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run  uuid;
  v_rows jsonb;
  v_next integer;
BEGIN
  IF p_run_id IS NULL OR p_kind IS NULL OR p_kind NOT IN ('disposition', 'quantity') OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500
     OR (p_after_seq IS NOT NULL AND p_after_seq < 0) THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  v_run := public.cms__result_run(p_program_id, p_run_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'seq', q.seq, 'order_line_id', q.order_line_id, 'order_code', q.order_code, 'product_id', q.product_id,
      'program_product_id', q.program_product_id, 'disposition', q.disposition, 'unassigned_reason', q.unassigned_reason,
      'seller_email', q.seller_email, 'user_id', q.user_id, 'store_id', q.store_id, 'pos_code', q.pos_code,
      'completed_at', public.cms__ts(q.completed_at), 'base_quantity', q.base_quantity::text, 'gmv_amount', q.gmv_amount::text,
      'quantity_raw', q.quantity_raw, 'uom_raw', q.uom_raw, 'quantity_src_flag', q.quantity_src_flag, 'uom_src_flag', q.uom_src_flag,
      'quantity_class', q.quantity_class, 'eligible_base', q.eligible_base::text) ORDER BY q.seq), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT * FROM public.cms_sales_lines sl
           WHERE sl.run_id = v_run AND sl.seq > COALESCE(p_after_seq, -1)
             AND ((p_kind = 'disposition' AND sl.disposition <> 'INCLUDED')
                  OR (p_kind = 'quantity' AND sl.disposition = 'INCLUDED'
                      AND sl.quantity_class IN ('OTHER_UNIT', 'FRACTIONAL_QUANTITY', 'ZERO_QUANTITY')))
           ORDER BY sl.seq LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'seq')::integer;
  END IF;
  RETURN jsonb_build_object('run_id', v_run, 'contract', public.cms__run_contract(v_run), 'kind', p_kind, 'rows', v_rows,
                            'next_after_seq', v_next);
END;
$$;

-- Phiếu trả của snapshot run (super): mọi dòng provider trả + disposition DB tự suy + đã vào sổ hay chưa. Run sales-only / legacy ⇒ rỗng
-- (không "0 phiếu" giả: khối contract cho biết returns_policy).
CREATE FUNCTION public.rpc_cms_result_returns_v2(p_program_id uuid, p_run_id uuid, p_after_seq integer DEFAULT NULL, p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run  uuid;
  v_rows jsonb;
  v_next integer;
BEGIN
  IF p_run_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_after_seq IS NOT NULL AND p_after_seq < 0) THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  v_run := public.cms__result_run(p_program_id, p_run_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'seq', q.seq, 'return_event_id', q.return_event_id, 'return_status', q.return_status, 'status_effect', q.status_effect,
      'disposition', q.disposition, 'return_document_id', q.return_document_id, 'return_code', q.return_code,
      'recorded_at', public.cms__ts(q.recorded_at), 'original_order_line_id', q.original_order_line_id,
      'original_order_id', q.original_order_id, 'product_id', q.product_id,
      'return_base_quantity', q.return_base_quantity::text, 'return_gmv_amount', q.return_gmv_amount::text,
      'original_completed_at', public.cms__ts(q.original_completed_at), 'original_seller_email', q.original_seller_email,
      'original_pos_code', q.original_pos_code, 'sale_ref_line_id', q.sale_ref_line_id,
      'in_ledger', EXISTS (SELECT 1 FROM public.cms_return_baselines b WHERE b.program_id = p_program_id AND b.return_event_id = q.return_event_id))
      ORDER BY q.seq), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT * FROM public.cms_return_lines rt WHERE rt.run_id = v_run AND rt.seq > COALESCE(p_after_seq, -1)
           ORDER BY rt.seq LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'seq')::integer;
  END IF;
  RETURN jsonb_build_object('run_id', v_run, 'contract', public.cms__run_contract(v_run), 'rows', v_rows, 'next_after_seq', v_next);
END;
$$;

-- Sổ trả hàng của chương trình (super + đọc được — QA cần marker): conflict mở (tối đa 500, observation mới nhất 10 / conflict),
-- phục hồi gần nhất, eval mới nhất, hash hiện tại và proof ỨNG VIÊN (chỉ khi hợp lệ — UI chỉ hiện nút xác nhận khi có; RPC confirm vẫn
-- kiểm lại dưới khoá). Không có thao tác "nhận tiền mới".
CREATE FUNCTION public.rpc_cms_return_conflicts(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog  public.cms_programs%ROWTYPE;
  v_ev    public.cms_return_ledger_evals%ROWTYPE;
  v_open  integer;
  v_ohash text;
  v_lhash text;
  v_proof boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin() OR NOT COALESCE(p_program_id = ANY (public.cms_readable_program_ids()), false) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id;
  SELECT * INTO v_ev FROM public.cms_return_ledger_evals WHERE program_id = p_program_id ORDER BY eval_seq DESC LIMIT 1;
  SELECT count(*) INTO v_open FROM public.cms_return_conflicts c
   WHERE c.program_id = p_program_id AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id);
  v_ohash := public.cms__open_set_hash(p_program_id);
  v_lhash := public.cms__ledger_set_hash(p_program_id);
  v_proof := v_open > 0 AND v_ev.verdict IS NOT DISTINCT FROM 'OPEN_CONFLICT_MATCH' AND v_ev.open_set_hash IS NOT DISTINCT FROM v_ohash
    AND v_ev.ledger_set_hash IS NOT DISTINCT FROM v_lhash AND v_ev.config_version IS NOT DISTINCT FROM v_prog.config_version
    AND v_ev.open_conflicts IS NOT DISTINCT FROM v_open;
  RETURN jsonb_build_object(
    'program_id', p_program_id, 'returns_policy', v_prog.returns_policy, 'config_version', v_prog.config_version,
    'baselines', (SELECT count(*) FROM public.cms_return_baselines b WHERE b.program_id = p_program_id),
    'ledger_set_hash', v_lhash, 'open_set_hash', v_ohash, 'open_count', v_open, 'open_truncated', v_open > 500,
    'latest_eval', CASE WHEN v_ev.program_id IS NULL THEN NULL ELSE jsonb_build_object(
      'eval_seq', v_ev.eval_seq, 'kind', v_ev.kind, 'run_id', v_ev.run_id, 'report_attempt', v_ev.report_attempt, 'verdict', v_ev.verdict,
      'returns_as_of', public.cms__ts(v_ev.returns_as_of), 'evaluated_at', public.cms__ts(v_ev.evaluated_at),
      'baselines', v_ev.baselines, 'mismatched', v_ev.mismatched, 'open_conflicts', v_ev.open_conflicts) END,
    'proof', CASE WHEN v_proof THEN jsonb_build_object('eval_seq', v_ev.eval_seq, 'open_set_hash', v_ohash) END,
    'open', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'conflict_id', c.id, 'return_event_id', c.return_event_id, 'prev_conflict_id', c.prev_conflict_id, 'opened_kind', c.opened_kind,
        'opened_eval_seq', c.opened_eval_seq, 'opened_at', public.cms__ts(c.opened_at),
        'baseline', jsonb_build_object('return_document_id', b.return_document_id, 'original_order_line_id', b.original_order_line_id,
          'product_id', b.product_id, 'base_quantity', b.base_quantity::text, 'refund_amount', b.refund_amount::text,
          'recorded_at', public.cms__ts(b.recorded_at), 'accepted_run_id', b.accepted_run_id, 'accepted_report_id', b.accepted_report_id,
          'accepted_at', public.cms__ts(b.accepted_at)),
        'observations', (SELECT jsonb_agg(jsonb_build_object('version', o.version, 'eval_seq', o.eval_seq, 'verdict', o.verdict,
                                                              'observed', o.observed, 'observed_at', public.cms__ts(o.observed_at))
                                          ORDER BY o.version DESC)
                           FROM (SELECT * FROM public.cms_return_conflict_observations x WHERE x.conflict_id = c.id
                                  ORDER BY x.version DESC LIMIT 10) o))
        ORDER BY c.return_event_id COLLATE "C")
      FROM (SELECT * FROM public.cms_return_conflicts c0
             WHERE c0.program_id = p_program_id
               AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c0.id)
             ORDER BY c0.return_event_id COLLATE "C" LIMIT 500) c
      JOIN public.cms_return_baselines b ON b.program_id = c.program_id AND b.return_event_id = c.return_event_id), '[]'::jsonb),
    'restorations', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'proof_eval_seq', r.proof_eval_seq, 'conflicts', r.conflicts,
        'reason', r.reason, 'confirmed_by', r.confirmed_by, 'confirmed_at', public.cms__ts(r.confirmed_at)) ORDER BY r.confirmed_at DESC)
      FROM (SELECT * FROM public.cms_return_restorations r0 WHERE r0.program_id = p_program_id
             ORDER BY r0.confirmed_at DESC LIMIT 20) r), '[]'::jsonb));
END;
$$;
