
-- ── 6. Stage / seal_begin run contract (thiết kế r2 §5.1) ─────────────────
-- Gọi từ thân 124 / 122 qua đoạn rẽ nhánh đầu thân (run có calc_contract_version — ghim lúc open, không RPC nào đổi). Chỉ owner
-- (không GRANT): hàm gọi là SECDEF của owner. Thân legacy giữ nguyên văn cho run legacy.
CREATE FUNCTION public.cms__stage_contract(p_run_id uuid, p_part text, p_chunk_no integer, p_rows jsonb)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_run    public.cms_sync_runs%ROWTYPE;
  v_n      integer;
  v_count  integer;
  v_digest text;
  v_prev   record;
  c_uuid CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_dec  CONSTANT text := '^-?[0-9]{1,35}(\.[0-9]{1,9})?$';
  c_udec CONSTANT text := '^[0-9]{1,35}(\.[0-9]{1,9})?$';
  c_int  CONSTANT text := '^(0|[1-9][0-9]{0,18})$';
  c_sint CONSTANT text := '^-?(0|[1-9][0-9]{0,18})$';
  c_seq  CONSTANT text := '^(0|[1-9][0-9]{0,8})$';
  c_ts   CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$';
  c_pid  CONSTANT text := '^[1-9][0-9]{0,18}$';
  c_txt  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,100}$';
  c_t50  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,50}$';
  c_t30  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,30}$';
  c_mail CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]+$';
  c_flag CONSTANT text := '^(NUL|OVERSIZE)$';
  c_cls  CONSTANT text := '^(POS_BASE|COUNTED|OTHER_UNIT|FRACTIONAL_QUANTITY|ZERO_QUANTITY)$';
  c_rqty CONSTANT text := '^[1-9][0-9]{0,28}$';
  c_rgmv CONSTANT text := '^[0-9]{1,20}(\.[0-9]{1,9})?$';
  c_ekey CONSTANT text := '^(SALE|RETURN):[^\x01-\x1f\x7f-\x9f]{1,100}$';
BEGIN
  IF p_chunk_no IS NULL OR p_chunk_no < 0 OR p_chunk_no >= 100000 THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_CHUNK' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROWS' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(p_rows);
  IF v_n = 0 OR v_n > 5000 THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_CHUNK' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.kind <> 'sales' OR v_run.status <> 'running' THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  -- Whitelist theo loại run (loại trừ chéo, r2 §5.1): run contract KHÔNG có result_lines; return_lines chỉ ở net; source_lines bắt
  -- buộc (source_schema = 1). Run legacy không tới đây (thân 124 giữ whitelist 5 part cũ ⇒ từ chối return_lines / result_events).
  IF v_run.calc_contract_version IS NULL OR v_run.source_schema IS DISTINCT FROM 1
     OR p_part IS NULL OR p_part NOT IN ('sales_lines', 'results', 'catalog', 'result_events', 'source_lines', 'return_lines')
     OR (p_part = 'return_lines' AND v_run.returns_policy IS DISTINCT FROM 'net_returns_v1') THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_PART' USING ERRCODE = '22023';
  END IF;
  IF v_run.seal_expect IS NOT NULL OR v_run.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'CMS_STAGE_SEALED' USING ERRCODE = 'P0001'; END IF;
  IF v_run.started_at < now() - interval '30 minutes' THEN RAISE EXCEPTION 'CMS_SYNC_RUN_STALE' USING ERRCODE = 'P0001'; END IF;

  v_digest := md5(p_rows::text);
  SELECT row_count, digest INTO v_prev FROM public.cms_sync_run_chunks
   WHERE run_id = p_run_id AND part = p_part AND chunk_no = p_chunk_no;
  IF FOUND THEN
    IF v_prev.row_count = v_n AND v_prev.digest = v_digest THEN
      RETURN v_n;  -- retry khối đã ghi: không ghi lại
    END IF;
    RAISE EXCEPTION 'CMS_STAGE_CHUNK_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) e WHERE jsonb_typeof(e) <> 'object') THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
  END IF;
  -- Như 124: mọi số dạng chuỗi; boolean chỉ ở trường boolean của results / catalog.
  IF jsonb_path_exists(p_rows, 'strict $[*].* ? (@.type() == "number" || @.type() == "object" || @.type() == "array")')
     OR (p_part NOT IN ('results', 'catalog') AND jsonb_path_exists(p_rows, 'strict $[*].* ? (@.type() == "boolean")'))
     OR (p_part = 'results' AND jsonb_path_exists(p_rows, '$[*] ? (@.at_cap.type() != "boolean" || @.gate_met.type() != "boolean")'))
     OR (p_part = 'catalog' AND jsonb_path_exists(p_rows, '$[*] ? (@.met.type() != "boolean")')) THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
  END IF;

  BEGIN
  IF p_part = 'source_lines' THEN
    -- 14 trường 124 + chuỗi THÔ q / u (capture trước làm sạch, có thể chứa điều khiển; ≤ @@SRC_MAX@@ code point) + cờ. Quan hệ
    -- thô ↔ sạch kiểm ở seal N1 trên tập DISTINCT; CHECK bảng ép quy tắc cờ.
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, order_id text, order_code text, product_id text,
             seller_email text, pos_code text, order_type text, order_status text, completed_at text, source_updated_at text,
             quantity_raw text, uom_raw text, base_quantity text, gmv_amount text, quantity_src text, uom_src text,
             quantity_src_flag text, uom_src_flag text)
       WHERE NOT (COALESCE(x.order_line_id ~ c_txt AND x.order_id ~ c_txt AND x.order_code ~ c_txt AND x.product_id ~ c_pid
                           AND x.order_type ~ c_t30 AND x.order_status ~ c_t30 AND x.completed_at ~ c_ts
                           AND x.source_updated_at ~ c_ts AND x.base_quantity ~ c_dec AND x.gmv_amount ~ c_dec, false)
                  AND (x.seller_email IS NULL OR (x.seller_email ~ c_mail AND char_length(x.seller_email) <= 320
                                                  AND x.seller_email = lower(x.seller_email)))
                  AND (x.pos_code IS NULL OR x.pos_code ~ c_t50)
                  AND (x.quantity_raw IS NULL OR x.quantity_raw ~ c_t50) AND (x.uom_raw IS NULL OR x.uom_raw ~ c_t50)
                  AND (x.quantity_src IS NULL OR char_length(x.quantity_src) <= @@SRC_MAX@@)
                  AND (x.uom_src IS NULL OR char_length(x.uom_src) <= @@SRC_MAX@@)
                  AND (x.quantity_src_flag IS NULL OR x.quantity_src_flag ~ c_flag)
                  AND (x.uom_src_flag IS NULL OR x.uom_src_flag ~ c_flag))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_sales_source_lines (run_id, program_id, order_line_id, order_id, order_code, product_id, seller_email,
      pos_code, order_type, order_status, completed_at, source_updated_at, quantity_raw, uom_raw, base_quantity, gmv_amount,
      src_v, quantity_src, uom_src, quantity_src_flag, uom_src_flag)
    SELECT p_run_id, v_run.program_id, x.order_line_id, x.order_id, x.order_code, x.product_id, x.seller_email, x.pos_code,
           x.order_type, x.order_status, x.completed_at::timestamptz, x.source_updated_at::timestamptz, x.quantity_raw, x.uom_raw,
           x.base_quantity::numeric, x.gmv_amount::numeric, 1, x.quantity_src, x.uom_src, x.quantity_src_flag, x.uom_src_flag
      FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, order_id text, order_code text, product_id text,
             seller_email text, pos_code text, order_type text, order_status text, completed_at text, source_updated_at text,
             quantity_raw text, uom_raw text, base_quantity text, gmv_amount text, quantity_src text, uom_src text,
             quantity_src_flag text, uom_src_flag text);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSIF p_part = 'sales_lines' THEN
    -- 18 trường 122 + thô / cờ (bằng lớp nguồn, N1 đối chiếu) + lớp lượng / B đủ (N1 tự tính lại từ thô).
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, order_id text, order_code text, product_id text,
             program_product_id text, seller_email text, user_id text, store_id text, pos_code text, completed_at text,
             source_updated_at text, quantity_raw text, uom_raw text, base_quantity text, gmv_amount text, disposition text,
             unassigned_reason text, quantity_src text, uom_src text, quantity_src_flag text, uom_src_flag text,
             quantity_class text, eligible_base text)
       WHERE NOT (COALESCE(x.order_line_id ~ c_txt AND x.seq ~ c_seq AND x.order_id ~ c_txt AND x.order_code ~ c_txt
                           AND x.product_id ~ c_pid AND x.program_product_id ~ c_uuid AND x.completed_at ~ c_ts
                           AND x.source_updated_at ~ c_ts AND x.base_quantity ~ c_dec AND x.gmv_amount ~ c_dec
                           AND x.disposition ~ '^(INCLUDED|UNASSIGNED|OUT_OF_SCOPE)$'
                           AND x.quantity_class ~ c_cls AND x.eligible_base ~ c_udec, false)
                  AND (x.seller_email IS NULL OR (x.seller_email ~ c_mail AND char_length(x.seller_email) <= 320
                                                  AND x.seller_email = lower(x.seller_email)))
                  AND (x.user_id IS NULL OR x.user_id ~ c_uuid)
                  AND (x.store_id IS NULL OR x.store_id ~ c_uuid) AND (x.pos_code IS NULL OR x.pos_code ~ c_t50)
                  AND (x.quantity_raw IS NULL OR x.quantity_raw ~ c_t50) AND (x.uom_raw IS NULL OR x.uom_raw ~ c_t50)
                  AND (x.unassigned_reason IS NULL
                       OR x.unassigned_reason ~ '^(NO_EMAIL|NOT_FOUND|MULTIPLE|SHARED_ACCOUNT|NOT_STAFF|STORE_NOT_ELIGIBLE)$')
                  AND (x.quantity_src IS NULL OR char_length(x.quantity_src) <= @@SRC_MAX@@)
                  AND (x.uom_src IS NULL OR char_length(x.uom_src) <= @@SRC_MAX@@)
                  AND (x.quantity_src_flag IS NULL OR x.quantity_src_flag ~ c_flag)
                  AND (x.uom_src_flag IS NULL OR x.uom_src_flag ~ c_flag))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_sales_lines (run_id, program_id, order_line_id, seq, order_id, order_code, product_id,
      program_product_id, seller_email, user_id, store_id, pos_code, completed_at, source_updated_at, quantity_raw, uom_raw,
      base_quantity, gmv_amount, disposition, unassigned_reason, src_v, quantity_src, uom_src, quantity_src_flag, uom_src_flag,
      quantity_class, eligible_base)
    SELECT p_run_id, v_run.program_id, x.order_line_id, x.seq::integer, x.order_id, x.order_code, x.product_id,
           x.program_product_id::uuid, x.seller_email, x.user_id::uuid, x.store_id::uuid, x.pos_code, x.completed_at::timestamptz,
           x.source_updated_at::timestamptz, x.quantity_raw, x.uom_raw, x.base_quantity::numeric, x.gmv_amount::numeric,
           x.disposition, x.unassigned_reason, 1, x.quantity_src, x.uom_src, x.quantity_src_flag, x.uom_src_flag,
           x.quantity_class, x.eligible_base::numeric
      FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, order_id text, order_code text, product_id text,
             program_product_id text, seller_email text, user_id text, store_id text, pos_code text, completed_at text,
             source_updated_at text, quantity_raw text, uom_raw text, base_quantity text, gmv_amount text, disposition text,
             unassigned_reason text, quantity_src text, uom_src text, quantity_src_flag text, uom_src_flag text,
             quantity_class text, eligible_base text);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSIF p_part = 'results' THEN
    -- 19 trường 122 + 9 cột ròng. CHECK cms_results_net ép số học bán − trả và "không trần" của run contract.
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(program_product_id text, product_id text, user_id text, store_id text,
             gmv_basis text, base_quantity text, per_unit text, cms_quantity text, rewarded_quantity text, cap_quantity text,
             at_cap boolean, gmv_amount text, gate_gmv text, target_gmv text, gate_met boolean, gate_met_at text,
             potential_amount text, amount_vnd text, line_count text, sale_base text, return_base text,
             eligible_sale_base text, eligible_return_base text, eligible_base text, counted_sale_qty text, sale_gmv text,
             return_gmv text, return_count text)
       WHERE NOT (COALESCE(x.program_product_id ~ c_uuid AND x.product_id ~ c_pid AND x.user_id ~ c_uuid AND x.store_id ~ c_uuid
                           AND x.gmv_basis ~ '^(product|catalog|none)$' AND x.base_quantity ~ c_dec AND x.per_unit ~ c_udec
                           AND x.cms_quantity ~ c_int AND x.rewarded_quantity ~ c_int AND x.at_cap IS NOT NULL
                           AND x.gmv_amount ~ c_dec AND x.gate_met IS NOT NULL AND x.potential_amount ~ c_int
                           AND x.amount_vnd ~ c_int AND x.line_count ~ c_seq
                           AND x.sale_base ~ c_udec AND x.return_base ~ c_udec AND x.eligible_sale_base ~ c_udec
                           AND x.eligible_return_base ~ c_udec AND x.eligible_base ~ c_udec AND x.sale_gmv ~ c_udec
                           AND x.return_gmv ~ c_udec AND x.return_count ~ c_seq, false)
                  AND (x.cap_quantity IS NULL OR x.cap_quantity ~ c_int) AND (x.gate_gmv IS NULL OR x.gate_gmv ~ c_dec)
                  AND (x.target_gmv IS NULL OR x.target_gmv ~ c_int) AND (x.gate_met_at IS NULL OR x.gate_met_at ~ c_ts)
                  AND (x.counted_sale_qty IS NULL OR x.counted_sale_qty ~ c_int))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(cms_quantity text, rewarded_quantity text, cap_quantity text, target_gmv text,
             potential_amount text, amount_vnd text, counted_sale_qty text)
       WHERE x.cms_quantity::numeric > 9223372036854775807 OR x.rewarded_quantity::numeric > 9223372036854775807
          OR COALESCE(x.cap_quantity::numeric, 0) > 9223372036854775807 OR COALESCE(x.target_gmv::numeric, 0) > 9223372036854775807
          OR x.potential_amount::numeric > 9223372036854775807 OR x.amount_vnd::numeric > 9223372036854775807
          OR COALESCE(x.counted_sale_qty::numeric, 0) > 9223372036854775807) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_results (run_id, program_id, program_product_id, product_id, user_id, store_id, gmv_basis,
      base_quantity, per_unit, cms_quantity, rewarded_quantity, cap_quantity, at_cap, gmv_amount, gate_gmv, target_gmv, gate_met,
      gate_met_at, potential_amount, amount_vnd, line_count, net_v, sale_base, return_base, eligible_sale_base,
      eligible_return_base, eligible_base, counted_sale_qty, sale_gmv, return_gmv, return_count)
    SELECT p_run_id, v_run.program_id, x.program_product_id::uuid, x.product_id, x.user_id::uuid, x.store_id::uuid, x.gmv_basis,
           x.base_quantity::numeric, x.per_unit::numeric, x.cms_quantity::bigint, x.rewarded_quantity::bigint,
           x.cap_quantity::bigint, x.at_cap, x.gmv_amount::numeric, x.gate_gmv::numeric, x.target_gmv::bigint, x.gate_met,
           x.gate_met_at::timestamptz, x.potential_amount::bigint, x.amount_vnd::bigint, x.line_count::integer, 1,
           x.sale_base::numeric, x.return_base::numeric, x.eligible_sale_base::numeric, x.eligible_return_base::numeric,
           x.eligible_base::numeric, x.counted_sale_qty::bigint, x.sale_gmv::numeric, x.return_gmv::numeric,
           x.return_count::integer
      FROM jsonb_to_recordset(p_rows) AS x(program_product_id text, product_id text, user_id text, store_id text,
             gmv_basis text, base_quantity text, per_unit text, cms_quantity text, rewarded_quantity text, cap_quantity text,
             at_cap boolean, gmv_amount text, gate_gmv text, target_gmv text, gate_met boolean, gate_met_at text,
             potential_amount text, amount_vnd text, line_count text, sale_base text, return_base text,
             eligible_sale_base text, eligible_return_base text, eligible_base text, counted_sale_qty text, sale_gmv text,
             return_gmv text, return_count text);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSIF p_part = 'catalog' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(user_id text, store_id text, catalog_gmv text, target_gmv text, met boolean,
             met_at text, line_count text)
       WHERE NOT (COALESCE(x.user_id ~ c_uuid AND x.store_id ~ c_uuid AND x.catalog_gmv ~ c_dec AND x.target_gmv ~ c_int
                           AND x.met IS NOT NULL AND x.line_count ~ c_seq, false)
                  AND (x.met_at IS NULL OR x.met_at ~ c_ts))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(target_gmv text) WHERE x.target_gmv::numeric > 9223372036854775807) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_result_catalog (run_id, program_id, user_id, store_id, catalog_gmv, target_gmv, met, met_at, line_count)
    SELECT p_run_id, v_run.program_id, x.user_id::uuid, x.store_id::uuid, x.catalog_gmv::numeric, x.target_gmv::bigint, x.met,
           x.met_at::timestamptz, x.line_count::integer
      FROM jsonb_to_recordset(p_rows) AS x(user_id text, store_id text, catalog_gmv text, target_gmv text, met boolean,
             met_at text, line_count text);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSIF p_part = 'return_lines' THEN
    -- MỌI dòng provider trả (đã chuẩn hoá). status_effect do DB suy từ từ điển; trạng thái lạ ⇒ lỗi riêng (app đã HOLD trước).
    -- Định dạng tại đây; ràng buộc EFFECTIVE / NOT_EFFECTIVE / sale_ref do CHECK bảng; disposition DB tự suy lại ở seal N2.
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(return_event_id text, seq text, return_status text, return_document_id text,
             return_code text, recorded_at text, original_order_line_id text, original_order_id text, product_id text,
             return_base_quantity text, return_gmv_amount text, original_completed_at text, original_order_type text,
             original_order_status text, original_seller_email text, original_pos_code text, original_base_quantity text,
             original_gmv_amount text, original_quantity_src text, original_uom_src text, original_quantity_src_flag text,
             original_uom_src_flag text, source_updated_at text, disposition text, sale_ref_line_id text)
       WHERE NOT (COALESCE(x.return_event_id ~ c_txt AND x.seq ~ c_seq AND x.return_status ~ c_t30
                           AND x.disposition ~ '^(APPLIED|NOT_COMPLETED|ORIGIN_NOT_ELIGIBLE|ORIGIN_OUT_OF_WINDOW|ORIGIN_NOT_IN_PROGRAM|ORIGIN_UNASSIGNED|ORIGIN_OUT_OF_SCOPE)$', false)
                  AND (x.return_document_id IS NULL OR x.return_document_id ~ c_txt)
                  AND (x.return_code IS NULL OR x.return_code ~ c_txt)
                  AND (x.recorded_at IS NULL OR x.recorded_at ~ c_ts)
                  AND (x.original_order_line_id IS NULL OR x.original_order_line_id ~ c_txt)
                  AND (x.original_order_id IS NULL OR x.original_order_id ~ c_txt)
                  AND (x.product_id IS NULL OR x.product_id ~ c_pid)
                  AND (x.return_base_quantity IS NULL OR x.return_base_quantity ~ c_rqty)
                  AND (x.return_gmv_amount IS NULL OR x.return_gmv_amount ~ c_rgmv)
                  AND (x.original_completed_at IS NULL OR x.original_completed_at ~ c_ts)
                  AND (x.original_order_type IS NULL OR x.original_order_type ~ c_t30)
                  AND (x.original_order_status IS NULL OR x.original_order_status ~ c_t30)
                  AND (x.original_seller_email IS NULL OR (x.original_seller_email ~ c_mail AND char_length(x.original_seller_email) <= 320
                                                           AND x.original_seller_email = lower(x.original_seller_email)))
                  AND (x.original_pos_code IS NULL OR x.original_pos_code ~ c_t50)
                  AND (x.original_base_quantity IS NULL OR x.original_base_quantity ~ c_dec)
                  AND (x.original_gmv_amount IS NULL OR x.original_gmv_amount ~ c_dec)
                  AND (x.original_quantity_src IS NULL OR char_length(x.original_quantity_src) <= @@SRC_MAX@@)
                  AND (x.original_uom_src IS NULL OR char_length(x.original_uom_src) <= @@SRC_MAX@@)
                  AND (x.original_quantity_src_flag IS NULL OR x.original_quantity_src_flag ~ c_flag)
                  AND (x.original_uom_src_flag IS NULL OR x.original_uom_src_flag ~ c_flag)
                  AND (x.source_updated_at IS NULL OR x.source_updated_at ~ c_ts)
                  AND (x.sale_ref_line_id IS NULL OR x.sale_ref_line_id ~ c_txt))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(return_status text)
                WHERE public.cms__return_status_effect(x.return_status) IS NULL) THEN
      RAISE EXCEPTION 'CMS_RETURN_STATUS_UNKNOWN' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_return_lines (run_id, program_id, return_event_id, seq, return_status, status_effect, return_document_id,
      return_code, recorded_at, original_order_line_id, original_order_id, product_id, return_base_quantity, return_gmv_amount,
      original_completed_at, original_order_type, original_order_status, original_seller_email, original_pos_code,
      original_base_quantity, original_gmv_amount, original_quantity_src, original_uom_src, original_quantity_src_flag,
      original_uom_src_flag, source_updated_at, disposition, sale_ref_line_id)
    SELECT p_run_id, v_run.program_id, x.return_event_id, x.seq::integer, x.return_status,
           public.cms__return_status_effect(x.return_status), x.return_document_id, x.return_code, x.recorded_at::timestamptz,
           x.original_order_line_id, x.original_order_id, x.product_id, x.return_base_quantity::numeric,
           x.return_gmv_amount::numeric, x.original_completed_at::timestamptz, x.original_order_type, x.original_order_status,
           x.original_seller_email, x.original_pos_code, x.original_base_quantity::numeric, x.original_gmv_amount::numeric,
           x.original_quantity_src, x.original_uom_src, x.original_quantity_src_flag, x.original_uom_src_flag,
           x.source_updated_at::timestamptz, x.disposition, x.sale_ref_line_id
      FROM jsonb_to_recordset(p_rows) AS x(return_event_id text, seq text, return_status text, return_document_id text,
             return_code text, recorded_at text, original_order_line_id text, original_order_id text, product_id text,
             return_base_quantity text, return_gmv_amount text, original_completed_at text, original_order_type text,
             original_order_status text, original_seller_email text, original_pos_code text, original_base_quantity text,
             original_gmv_amount text, original_quantity_src text, original_uom_src text, original_quantity_src_flag text,
             original_uom_src_flag text, source_updated_at text, disposition text, sale_ref_line_id text);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSE
    -- result_events: sự kiện SALE / RETURN theo nhóm (thay result_lines). CHECK bảng ép khoá / dấu / chuỗi before → after.
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(event_key text, seq text, kind text, event_at text, order_line_id text,
             return_event_id text, user_id text, program_product_id text, quantity_class text, base_delta text,
             eligible_delta text, gmv_delta text, eligible_before text, eligible_after text, qty_before text, qty_after text,
             amount_vnd text, status text)
       WHERE NOT (COALESCE(x.event_key ~ c_ekey AND x.seq ~ c_seq AND x.kind ~ '^(SALE|RETURN)$' AND x.event_at ~ c_ts
                           AND x.order_line_id ~ c_txt AND x.user_id ~ c_uuid AND x.program_product_id ~ c_uuid
                           AND x.quantity_class ~ c_cls AND x.base_delta ~ c_dec AND x.eligible_delta ~ c_dec
                           AND x.gmv_delta ~ c_dec AND x.eligible_before ~ c_udec AND x.eligible_after ~ c_udec
                           AND x.qty_before ~ c_int AND x.qty_after ~ c_int AND x.amount_vnd ~ c_sint
                           AND x.status ~ '^(WAITING_GATE|ACCUMULATING|RECORDED|NOT_COUNTED|RETURN_REDUCED|RETURN_NO_CHANGE)$', false)
                  AND (x.return_event_id IS NULL OR x.return_event_id ~ c_txt))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(qty_before text, qty_after text, amount_vnd text)
       WHERE x.qty_before::numeric > 9223372036854775807 OR x.qty_after::numeric > 9223372036854775807
          OR abs(x.amount_vnd::numeric) > 9223372036854775807) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_result_events (run_id, program_id, event_key, seq, kind, event_at, order_line_id, return_event_id,
      user_id, program_product_id, quantity_class, base_delta, eligible_delta, gmv_delta, eligible_before, eligible_after,
      qty_before, qty_after, amount_vnd, status)
    SELECT p_run_id, v_run.program_id, x.event_key, x.seq::integer, x.kind, x.event_at::timestamptz, x.order_line_id,
           x.return_event_id, x.user_id::uuid, x.program_product_id::uuid, x.quantity_class, x.base_delta::numeric,
           x.eligible_delta::numeric, x.gmv_delta::numeric, x.eligible_before::numeric, x.eligible_after::numeric,
           x.qty_before::bigint, x.qty_after::bigint, x.amount_vnd::bigint, x.status
      FROM jsonb_to_recordset(p_rows) AS x(event_key text, seq text, kind text, event_at text, order_line_id text,
             return_event_id text, user_id text, program_product_id text, quantity_class text, base_delta text,
             eligible_delta text, gmv_delta text, eligible_before text, eligible_after text, qty_before text, qty_after text,
             amount_vnd text, status text);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
  END;
  IF v_count <> v_n THEN RAISE EXCEPTION 'CMS_STAGE_COUNT_MISMATCH' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.cms_sync_run_chunks (run_id, part, chunk_no, row_count, digest) VALUES (p_run_id, p_part, p_chunk_no, v_n, v_digest);
  UPDATE public.cms_sync_runs SET rows_written = rows_written + v_n WHERE id = p_run_id;
  RETURN v_n;
END;
$$;

-- seal_begin run contract: expect + pin nguồn. Hình dạng sai ⇒ CMS_SEAL_BAD_EXPECT (không đổi trạng thái); dữ liệu staging lệch
-- khai báo ⇒ seal_fail. Mọi kiểm hình dạng tách IF riêng (PG không cam kết thứ tự đánh giá OR — hàm jsonb_object_keys trên scalar
-- sẽ lỗi thô nếu chạy trước kiểm kiểu).
CREATE FUNCTION public.cms__seal_begin_contract(p_run_id uuid, p_expect jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_run   public.cms_sync_runs%ROWTYPE;
  v_prog  public.cms_programs%ROWTYPE;
  v_part  text;
  v_parts text[];
  v_net   boolean;
  v_n     bigint;
  v_pin   jsonb;
  v_tot   jsonb;
  c_cnt   CONSTANT text := '^(0|[1-9][0-9]{0,8})$';
  c_dec   CONSTANT text := '^-?[0-9]{1,35}(\.[0-9]{1,9})?$';
  c_udec  CONSTANT text := '^[0-9]{1,35}(\.[0-9]{1,9})?$';
  c_vnd   CONSTANT text := '^(0|[1-9][0-9]{0,18})$';
  c_ts    CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$';
  c_date  CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';
  c_hex   CONSTANT text := '^[0-9a-f]{64}$';
  c_ref   CONSTANT text := '^[A-Za-z0-9_.:-]{1,255}$';  -- regex PG lặp tối đa 255
  -- Tổng run contract: khoá 122 trừ adjustment_lines (run contract không có dòng điều chỉnh âm — âm ⇒ HOLD N1) + lớp lượng + trả.
  c_tcnt  CONSTANT text[] := ARRAY['lines_read', 'candidates', 'included', 'unassigned', 'out_of_scope', 'returns_read',
                                   'returns_not_effective', 'returns_applied'];
  c_tobj  CONSTANT text[] := ARRAY['unassigned_by_reason', 'excluded_by_reason', 'class_counts', 'returns_excluded_by_reason'];
BEGIN
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.kind <> 'sales' OR v_run.status <> 'running' OR v_run.calc_contract_version IS NULL THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  v_net := v_run.returns_policy = 'net_returns_v1';
  v_parts := ARRAY['sales_lines', 'results', 'catalog', 'result_events', 'source_lines']
             || CASE WHEN v_net THEN ARRAY['return_lines'] ELSE ARRAY[]::text[] END;
  -- (1) kiểu các nút.
  IF p_expect IS NULL OR jsonb_typeof(p_expect) <> 'object' OR pg_column_size(p_expect) > 65536 THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END IF;
  v_pin := p_expect -> 'pin';
  v_tot := p_expect -> 'totals';
  IF jsonb_typeof(p_expect -> 'chunks') IS DISTINCT FROM 'object' OR jsonb_typeof(v_tot) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_pin) IS DISTINCT FROM 'object' OR jsonb_typeof(v_pin -> 'scope') IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_pin -> 'sales') IS DISTINCT FROM 'object'
     OR (v_net AND jsonb_typeof(v_pin -> 'returns') IS DISTINCT FROM 'object')
     OR EXISTS (SELECT 1 FROM unnest(c_tobj) k WHERE jsonb_typeof(v_tot -> k) IS DISTINCT FROM 'object') THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END IF;
  -- (2) đúng tập khoá ở mọi nút (không khoá lạ; run contract không có result_lines; sales-only không có return_lines / pin.returns).
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_expect) k
              WHERE NOT (k = ANY (v_parts || ARRAY['chunks', 'totals', 'pin', 'amount_vnd', 'rows_read', 'rows_rejected',
                                                    'bytes_processed', 'source_max_updated_at'])))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_expect -> 'chunks') k WHERE NOT (k = ANY (v_parts)))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_tot) k
                 WHERE NOT (k = ANY (c_tcnt || c_tobj || ARRAY['candidate_gmv', 'unassigned_gmv', 'amount_vnd',
                                                               'return_base_applied', 'return_gmv_applied'])))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_pin) k
                 WHERE NOT (k = ANY (ARRAY['protocol', 'provider', 'job_id', 'snapshot_id', 'as_of', 'scope', 'sales']
                                     || CASE WHEN v_net THEN ARRAY['returns'] ELSE ARRAY[]::text[] END)))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_pin -> 'scope') k WHERE NOT (k = ANY (ARRAY['from', 'to', 'products_hash'])))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_pin -> 'sales') k
                 WHERE NOT (k = ANY (ARRAY['rows_total', 'rows_staged', 'rows_rejected', 'staged_digest', 'rejected_digest'])))
     OR (v_net AND EXISTS (SELECT 1 FROM jsonb_object_keys(v_pin -> 'returns') k WHERE NOT (k = ANY (ARRAY['rows', 'digest']))))
     OR EXISTS (SELECT 1 FROM jsonb_each(v_tot -> 'unassigned_by_reason') e
                 WHERE e.key NOT IN ('NO_EMAIL', 'NOT_FOUND', 'MULTIPLE', 'SHARED_ACCOUNT', 'NOT_STAFF', 'STORE_NOT_ELIGIBLE')
                    OR jsonb_typeof(e.value) <> 'number' OR e.value::text !~ c_cnt)
     OR EXISTS (SELECT 1 FROM jsonb_each(v_tot -> 'excluded_by_reason') e
                 WHERE e.key NOT IN ('ORDER_NOT_ELIGIBLE', 'OUT_OF_WINDOW', 'PRODUCT_NOT_IN_PROGRAM', 'UNASSIGNED', 'OUT_OF_SCOPE')
                    OR jsonb_typeof(e.value) <> 'number' OR e.value::text !~ c_cnt)
     OR EXISTS (SELECT 1 FROM jsonb_each(v_tot -> 'returns_excluded_by_reason') e
                 WHERE e.key NOT IN ('NOT_COMPLETED', 'ORIGIN_NOT_ELIGIBLE', 'ORIGIN_OUT_OF_WINDOW', 'ORIGIN_NOT_IN_PROGRAM',
                                     'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE')
                    OR jsonb_typeof(e.value) <> 'number' OR e.value::text !~ c_cnt)
     -- class_counts: ĐỦ 5 lớp (0 vẫn ghi).
     OR (SELECT count(*) FROM jsonb_each(v_tot -> 'class_counts') e
          WHERE e.key IN ('POS_BASE', 'COUNTED', 'OTHER_UNIT', 'FRACTIONAL_QUANTITY', 'ZERO_QUANTITY')
            AND jsonb_typeof(e.value) = 'number' AND e.value::text ~ c_cnt) <> 5
     OR (SELECT count(*) FROM jsonb_object_keys(v_tot -> 'class_counts')) <> 5 THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END IF;
  -- (3) giá trị.
  IF NOT public.cms__str(p_expect, 'amount_vnd', c_vnd)
     OR NOT public.cms__str_or_null(p_expect, 'source_max_updated_at', c_ts)
     OR EXISTS (SELECT 1 FROM unnest(v_parts || ARRAY['rows_read', 'rows_rejected']) k
                 WHERE jsonb_typeof(p_expect -> k) IS DISTINCT FROM 'number' OR (p_expect ->> k) !~ c_cnt)
     OR EXISTS (SELECT 1 FROM unnest(v_parts) k
                 WHERE jsonb_typeof(p_expect -> 'chunks' -> k) IS DISTINCT FROM 'number' OR (p_expect -> 'chunks' ->> k) !~ c_cnt)
     OR EXISTS (SELECT 1 FROM unnest(c_tcnt) k WHERE jsonb_typeof(v_tot -> k) IS DISTINCT FROM 'number' OR (v_tot ->> k) !~ c_cnt)
     OR NOT public.cms__str(v_tot, 'candidate_gmv', c_dec) OR NOT public.cms__str(v_tot, 'unassigned_gmv', c_dec)
     OR NOT public.cms__str(v_tot, 'amount_vnd', c_vnd)
     OR NOT public.cms__str(v_tot, 'return_base_applied', c_udec) OR NOT public.cms__str(v_tot, 'return_gmv_applied', c_udec)
     OR (p_expect ? 'bytes_processed' AND jsonb_typeof(p_expect -> 'bytes_processed') <> 'null'
         AND (p_expect ->> 'bytes_processed') !~ '^(0|[1-9][0-9]{0,17})$')
     -- pin cms-source-pin-v1 (r2 §4.3): đúng một trong job_id / snapshot_id.
     OR v_pin ->> 'protocol' IS DISTINCT FROM '@@SOURCE_PIN@@'
     OR NOT public.cms__str(v_pin, 'provider', '^(bq|fixture)$')
     OR (v_pin ? 'job_id') = (v_pin ? 'snapshot_id')
     OR public.cms__str(v_pin, 'job_id', c_ref) = public.cms__str(v_pin, 'snapshot_id', c_ref)
     OR NOT public.cms__str(v_pin, 'as_of', c_ts)
     OR NOT public.cms__str(v_pin -> 'scope', 'from', c_date) OR NOT public.cms__str(v_pin -> 'scope', 'to', c_date)
     OR NOT public.cms__str(v_pin -> 'scope', 'products_hash', c_hex)
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['rows_total', 'rows_staged', 'rows_rejected']) k
                 WHERE jsonb_typeof(v_pin -> 'sales' -> k) IS DISTINCT FROM 'number' OR (v_pin -> 'sales' ->> k) !~ c_cnt)
     OR NOT public.cms__str(v_pin -> 'sales', 'staged_digest', c_hex) OR NOT public.cms__str(v_pin -> 'sales', 'rejected_digest', c_hex)
     OR (v_net AND (jsonb_typeof(v_pin -> 'returns' -> 'rows') IS DISTINCT FROM 'number' OR (v_pin -> 'returns' ->> 'rows') !~ c_cnt
                    OR NOT public.cms__str(v_pin -> 'returns', 'digest', c_hex))) THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END IF;
  -- (4) nhất quán nội bộ expect ↔ pin (worker tự mâu thuẫn ⇒ lỗi hình dạng, không phải dữ liệu).
  IF (v_pin -> 'sales' ->> 'rows_staged')::bigint <> (p_expect ->> 'source_lines')::bigint
     OR (v_pin -> 'sales' ->> 'rows_rejected')::bigint <> (p_expect ->> 'rows_rejected')::bigint
     OR (v_pin -> 'sales' ->> 'rows_total')::bigint <> (p_expect ->> 'rows_read')::bigint
     OR (p_expect ->> 'rows_read')::bigint <> (p_expect ->> 'source_lines')::bigint + (p_expect ->> 'rows_rejected')::bigint
     OR (v_tot ->> 'lines_read')::bigint <> (p_expect ->> 'source_lines')::bigint
     OR (v_tot ->> 'amount_vnd') <> (p_expect ->> 'amount_vnd')
     OR (v_net AND ((v_pin -> 'returns' ->> 'rows')::bigint <> (p_expect ->> 'return_lines')::bigint
                    OR (v_tot ->> 'returns_read')::bigint <> (p_expect ->> 'return_lines')::bigint))
     -- sales-only: không có "0 phiếu trả" giả nào khác 0.
     OR (NOT v_net AND ((v_tot ->> 'returns_read')::bigint <> 0 OR (v_tot ->> 'returns_not_effective')::bigint <> 0
                        OR (v_tot ->> 'returns_applied')::bigint <> 0 OR (v_tot -> 'returns_excluded_by_reason') <> '{}'::jsonb
                        OR (v_tot ->> 'return_base_applied')::numeric <> 0 OR (v_tot ->> 'return_gmv_applied')::numeric <> 0)) THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END IF;
  BEGIN
    PERFORM NULLIF(p_expect ->> 'source_max_updated_at', '')::timestamptz, (v_pin ->> 'as_of')::timestamptz,
            (v_pin -> 'scope' ->> 'from')::date, (v_pin -> 'scope' ->> 'to')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END;
  IF v_run.seal_expect IS NOT NULL OR v_run.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'CMS_SEAL_STARTED' USING ERRCODE = 'P0001'; END IF;
  IF v_run.started_at < now() - interval '30 minutes' THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'STALE'); END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_run.program_id;
  IF v_prog.status = 'locked' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_LOCKED'); END IF;
  IF v_prog.status <> 'active' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_NOT_ACTIVE'); END IF;
  IF v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN
    RETURN public.cms__seal_fail(p_run_id, 'held', 'CONFIG_CHANGED');
  END IF;
  IF public.cms__mapping_fp() <> v_run.mapping_fp THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'MAPPING_CHANGED'); END IF;
  -- Nguồn giả chỉ cho chương trình thử (r2 §4.3) — production không bao giờ nhận pin fixture.
  IF v_pin ->> 'provider' = 'fixture' AND NOT v_run.is_test THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_PIN_PROVIDER'); END IF;
  ANALYZE (SKIP_LOCKED) public.cms_sales_lines, public.cms_results, public.cms_result_catalog, public.cms_sales_source_lines,
    public.cms_return_lines, public.cms_result_events;
  -- Loại trừ chéo: run contract không có dữ liệu / khối của part ngoài whitelist theo loại.
  IF EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = p_run_id)
     OR (NOT v_net AND EXISTS (SELECT 1 FROM public.cms_return_lines WHERE run_id = p_run_id))
     OR EXISTS (SELECT 1 FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND NOT (part = ANY (v_parts))) THEN
    RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_PART_FORBIDDEN');
  END IF;
  -- S1 đủ dòng.
  IF (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = p_run_id) <> (p_expect ->> 'sales_lines')::bigint
     OR (SELECT count(*) FROM public.cms_results WHERE run_id = p_run_id) <> (p_expect ->> 'results')::bigint
     OR (SELECT count(*) FROM public.cms_result_catalog WHERE run_id = p_run_id) <> (p_expect ->> 'catalog')::bigint
     OR (SELECT count(*) FROM public.cms_result_events WHERE run_id = p_run_id) <> (p_expect ->> 'result_events')::bigint
     OR (SELECT count(*) FROM public.cms_sales_source_lines WHERE run_id = p_run_id) <> (p_expect ->> 'source_lines')::bigint
     OR (v_net AND (SELECT count(*) FROM public.cms_return_lines WHERE run_id = p_run_id) <> (p_expect ->> 'return_lines')::bigint) THEN
    RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_COUNT_MISMATCH');
  END IF;
  -- S2 đủ khối.
  FOREACH v_part IN ARRAY v_parts LOOP
    v_n := (p_expect -> 'chunks' ->> v_part)::bigint;
    IF (SELECT count(*) FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND part = v_part) <> v_n
       OR COALESCE((SELECT max(chunk_no) FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND part = v_part), -1) <> v_n - 1
       OR COALESCE((SELECT sum(row_count) FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND part = v_part), 0)
          <> (p_expect ->> v_part)::bigint THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_CHUNKS_MISMATCH');
    END IF;
  END LOOP;
  UPDATE public.cms_sync_runs SET seal_expect = p_expect, seal_step = 0 WHERE id = p_run_id;
  RETURN jsonb_build_object('ok', true, 'steps', 13);
END;
$$;
