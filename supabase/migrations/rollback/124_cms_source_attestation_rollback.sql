-- ============================================================================
-- rollback/124_cms_source_attestation_rollback.sql  (r2 — COMP-INT, Dev 05/11/2026; KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-124.mjs: khôi phục NGUYÊN VĂN 5 hàm 122 / 123 (run_open, stage, cleanup, lock_eval, payout) +
-- chữ ký chốt 5 tham số của 123 (grant service_role + thu hồi grant default privileges); lock_timeout + khoá bảng run; hậu kiểm
-- md5 thân 6 hàm khôi phục (sinh từ thân 122 / 123) + cột / ràng buộc payout về 123.
-- Sau rollback: app bật CMS_SOURCE_CAPTURE_ENABLED sẽ thấy run_open KHÔNG trả source_schema ⇒ đóng run SOURCE_SCHEMA_UNSUPPORTED
-- (không tự tiếp tục capture vào DB không hỗ trợ) — tắt cờ cùng lúc rollback.
-- Dừng nếu: thiếu marker 124 · có migration > 124 · đã có payout basis operator_reconciliation (chứng nhận đã dùng để chốt —
-- payout bất biến, chỉ xử lý tiến). Chương trình đã chốt bằng qa_assumption giữ nguyên.
-- Giữ lại có chủ đích: ràng buộc part của cms_sync_run_chunks vẫn nhận 'source_lines' và các khối part 'source_lines' đã ghi —
-- khối của run đã chốt bị guard 123 đóng băng (không xoá được), cleanup 122 xoá khối theo run (mọi part) nên không mồ côi.
-- Mất dữ liệu: lớp nguồn + lịch sử chứng nhận (chỉ chạy trước go-live / khi PM duyệt).
-- Sau rollback: VERIFY ràng buộc part cms_sync_run_chunks vẫn 5 giá trị (có chủ đích, xem trên). Áp lại 124 sau rollback: MỌI run
-- hiện có (kể cả run tạo giữa lần áp đầu và rollback) thành run cũ (source_schema NULL) — lớp nguồn của chúng đã xoá cùng bảng.
-- Vận hành: cờ CMS sync OFF, cron sync / cleanup CMS tạm dừng như khi áp 124. DÁN NGUYÊN FILE, GIỮ LF (md5 hậu kiểm tính trên LF;
-- CRLF ⇒ hậu kiểm dừng, transaction rollback). Chạy bằng ĐÚNG role owner bảng / hàm CMS (như 124) — owner khác ⇒ preflight dừng.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.cms_sync_runs IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'rollback 124: cần READ COMMITTED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '124' AND name = 'cms_source_attestation') THEN
    RAISE EXCEPTION 'rollback 124: không có marker 124';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 124) THEN
    RAISE EXCEPTION 'rollback 124: DB đã có migration số > 124 — rollback theo thứ tự ngược trước';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_payouts WHERE source_complete_basis = 'operator_reconciliation' OR source_attestation_id IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback 124: đã có payout dùng chứng nhận đối soát (bất biến) — không rollback, xử lý tiến';
  END IF;
  -- Owner: lock 5 tham số tạo lại phải cùng owner bảng payout (guard INVOKER cms__payout_insert_guard) — db-reviewer r2 P2-8.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_sync_runs'::regclass, 'public.cms_payouts'::regclass, 'public.cms_programs'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'rollback 124: owner bảng CMS khác role chạy (%) — chạy bằng owner', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running') THEN
    RAISE EXCEPTION 'rollback 124: còn run bán đang chạy — chờ xong (khối source_lines đang ghi sẽ mồ côi nghĩa)';
  END IF;
END $$;

-- Hàm mới (lock 6 tham số DROP rồi tạo lại bản 123 bên dưới).
DROP FUNCTION public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid);
DROP FUNCTION public.rpc_cms_source_attest_revoke(uuid, text, uuid);
DROP FUNCTION public.rpc_cms_run_source_export(uuid, uuid, text, integer);
DROP FUNCTION public.rpc_cms_source_attestations(uuid);
DROP FUNCTION public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text, uuid);

-- ── Khôi phục NGUYÊN VĂN 122 / 123 ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_open(p_program_id uuid, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_prog public.cms_programs%ROWTYPE;
  v_snap jsonb;
  v_id   uuid;
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
  RETURNING id INTO v_id;
  RETURN v_snap || jsonb_build_object('run_id', v_id);
END;
$$;
CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_stage(p_run_id uuid, p_part text, p_chunk_no integer, p_rows jsonb)
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
  -- Miền tháng / ngày / giờ trong regex ⇒ ngày sai dạng thô (2026-13-45) ra mã CMS_*, không lỗi ép kiểu 22008.
  c_ts   CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$';
  c_pid  CONSTANT text := '^[1-9][0-9]{0,18}$';
  -- Ký tự điều khiển C0 / DEL / C1 bằng lớp tường minh (không phụ thuộc ctype DB; khớp CONTROL_RE của app — db-reviewer P2-3).
  c_txt  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,100}$';
  c_t50  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,50}$';
  c_mail CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]+$';  -- regex PG lặp tối đa 255; độ dài ≤ 320 + chữ thường do CHECK / kiểm dưới
BEGIN
  IF p_part IS NULL OR p_part NOT IN ('sales_lines', 'results', 'catalog', 'result_lines') THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_PART' USING ERRCODE = '22023';
  END IF;
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
  -- Khoá run: các khối của cùng run ghi tuần tự; seal / finish chờ khối đang ghi.
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.kind <> 'sales' OR v_run.status <> 'running' THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  -- seal_begin đã đóng băng staging ⇒ không ghi thêm (bước seal đối chiếu đúng tập đã đếm).
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

  -- Kiểm kiểu JSON một lượt (SQL/JSON path, chạy trong C): app gửi MỌI số dạng chuỗi ⇒ số / object / mảng ở bất kỳ trường
  -- nào ⇒ lỗi dòng; boolean chỉ được ở trường boolean của results / catalog. Sau đó đọc bằng jsonb_to_recordset và kiểm
  -- định dạng bằng regex trên cột (không gọi hàm theo từng trường — r1 chậm ~0,45 s / khối 1.000 dòng).
  -- strict: lax tự mở mảng ⇒ ["x"] / [] ở trường text lọt qua (db-reviewer r2 N3).
  IF jsonb_path_exists(p_rows, 'strict $[*].* ? (@.type() == "number" || @.type() == "object" || @.type() == "array")')
     OR (p_part IN ('sales_lines', 'result_lines') AND jsonb_path_exists(p_rows, 'strict $[*].* ? (@.type() == "boolean")'))
     -- Trường boolean phải là boolean JSON (chuỗi 'true' / 'abc' ⇒ lỗi dòng, không để lọt lỗi ép kiểu thô).
     OR (p_part = 'results' AND jsonb_path_exists(p_rows, '$[*] ? (@.at_cap.type() != "boolean" || @.gate_met.type() != "boolean")'))
     OR (p_part = 'catalog' AND jsonb_path_exists(p_rows, '$[*] ? (@.met.type() != "boolean")')) THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
  END IF;

  -- Khối bắt lỗi ép kiểu: ngày qua regex nhưng không tồn tại (30/02, năm 0000) ⇒ CMS_STAGE_BAD_ROW, không lỗi thô 22008
  -- (db-reviewer r2 N4). Trùng khoá / CHECK vẫn lộ mã gốc (kiểm thử dựa vào).
  BEGIN
  IF p_part = 'sales_lines' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, order_id text, order_code text, product_id text,
             program_product_id text, seller_email text, user_id text, store_id text, pos_code text, completed_at text,
             source_updated_at text, quantity_raw text, uom_raw text, base_quantity text, gmv_amount text, disposition text,
             unassigned_reason text)
       WHERE NOT (COALESCE(x.order_line_id ~ c_txt AND x.seq ~ c_seq AND x.order_id ~ c_txt AND x.order_code ~ c_txt
                           AND x.product_id ~ c_pid AND x.program_product_id ~ c_uuid AND x.completed_at ~ c_ts
                           AND x.source_updated_at ~ c_ts AND x.base_quantity ~ c_dec AND x.gmv_amount ~ c_dec
                           AND x.disposition ~ '^(INCLUDED|UNASSIGNED|OUT_OF_SCOPE)$', false)
                  AND (x.seller_email IS NULL OR (x.seller_email ~ c_mail AND char_length(x.seller_email) <= 320
                                                  AND x.seller_email = lower(x.seller_email)))
                  AND (x.user_id IS NULL OR x.user_id ~ c_uuid)
                  AND (x.store_id IS NULL OR x.store_id ~ c_uuid) AND (x.pos_code IS NULL OR x.pos_code ~ c_t50)
                  AND (x.quantity_raw IS NULL OR x.quantity_raw ~ c_t50) AND (x.uom_raw IS NULL OR x.uom_raw ~ c_t50)
                  AND (x.unassigned_reason IS NULL
                       OR x.unassigned_reason ~ '^(NO_EMAIL|NOT_FOUND|MULTIPLE|SHARED_ACCOUNT|NOT_STAFF|STORE_NOT_ELIGIBLE)$'))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_sales_lines (run_id, program_id, order_line_id, seq, order_id, order_code, product_id,
      program_product_id, seller_email, user_id, store_id, pos_code, completed_at, source_updated_at, quantity_raw, uom_raw,
      base_quantity, gmv_amount, disposition, unassigned_reason)
    SELECT p_run_id, v_run.program_id, x.order_line_id, x.seq::integer, x.order_id, x.order_code, x.product_id,
           x.program_product_id::uuid, x.seller_email, x.user_id::uuid, x.store_id::uuid, x.pos_code, x.completed_at::timestamptz,
           x.source_updated_at::timestamptz, x.quantity_raw, x.uom_raw, x.base_quantity::numeric, x.gmv_amount::numeric,
           x.disposition, x.unassigned_reason
      FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, order_id text, order_code text, product_id text,
             program_product_id text, seller_email text, user_id text, store_id text, pos_code text, completed_at text,
             source_updated_at text, quantity_raw text, uom_raw text, base_quantity text, gmv_amount text, disposition text,
             unassigned_reason text);
    GET DIAGNOSTICS v_count = ROW_COUNT;  -- ngay sau INSERT (một câu SQL chen giữa sẽ ghi đè ROW_COUNT — db-reviewer r3 R3-3)
  ELSIF p_part = 'results' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(program_product_id text, product_id text, user_id text, store_id text,
             gmv_basis text, base_quantity text, per_unit text, cms_quantity text, rewarded_quantity text, cap_quantity text,
             at_cap boolean, gmv_amount text, gate_gmv text, target_gmv text, gate_met boolean, gate_met_at text,
             potential_amount text, amount_vnd text, line_count text)
       WHERE NOT (COALESCE(x.program_product_id ~ c_uuid AND x.product_id ~ c_pid AND x.user_id ~ c_uuid AND x.store_id ~ c_uuid
                           AND x.gmv_basis ~ '^(product|catalog|none)$' AND x.base_quantity ~ c_dec AND x.per_unit ~ c_udec
                           AND x.cms_quantity ~ c_int AND x.rewarded_quantity ~ c_int AND x.at_cap IS NOT NULL
                           AND x.gmv_amount ~ c_dec AND x.gate_met IS NOT NULL AND x.potential_amount ~ c_int
                           AND x.amount_vnd ~ c_int AND x.line_count ~ c_seq, false)
                  AND (x.cap_quantity IS NULL OR x.cap_quantity ~ c_int) AND (x.gate_gmv IS NULL OR x.gate_gmv ~ c_dec)
                  AND (x.target_gmv IS NULL OR x.target_gmv ~ c_int) AND (x.gate_met_at IS NULL OR x.gate_met_at ~ c_ts))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    -- Miền bigint kiểm SAU khi đã chắc định dạng (ép kiểu an toàn); vượt ⇒ lỗi dòng, không để lọt lỗi ép kiểu thô.
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(cms_quantity text, rewarded_quantity text, cap_quantity text, target_gmv text,
             potential_amount text, amount_vnd text)
       WHERE x.cms_quantity::numeric > 9223372036854775807 OR x.rewarded_quantity::numeric > 9223372036854775807
          OR COALESCE(x.cap_quantity::numeric, 0) > 9223372036854775807 OR COALESCE(x.target_gmv::numeric, 0) > 9223372036854775807
          OR x.potential_amount::numeric > 9223372036854775807 OR x.amount_vnd::numeric > 9223372036854775807) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_results (run_id, program_id, program_product_id, product_id, user_id, store_id, gmv_basis,
      base_quantity, per_unit, cms_quantity, rewarded_quantity, cap_quantity, at_cap, gmv_amount, gate_gmv, target_gmv, gate_met,
      gate_met_at, potential_amount, amount_vnd, line_count)
    SELECT p_run_id, v_run.program_id, x.program_product_id::uuid, x.product_id, x.user_id::uuid, x.store_id::uuid, x.gmv_basis,
           x.base_quantity::numeric, x.per_unit::numeric, x.cms_quantity::bigint, x.rewarded_quantity::bigint,
           x.cap_quantity::bigint, x.at_cap, x.gmv_amount::numeric, x.gate_gmv::numeric, x.target_gmv::bigint, x.gate_met,
           x.gate_met_at::timestamptz, x.potential_amount::bigint, x.amount_vnd::bigint, x.line_count::integer
      FROM jsonb_to_recordset(p_rows) AS x(program_product_id text, product_id text, user_id text, store_id text,
             gmv_basis text, base_quantity text, per_unit text, cms_quantity text, rewarded_quantity text, cap_quantity text,
             at_cap boolean, gmv_amount text, gate_gmv text, target_gmv text, gate_met boolean, gate_met_at text,
             potential_amount text, amount_vnd text, line_count text);
    GET DIAGNOSTICS v_count = ROW_COUNT;  -- ngay sau INSERT (một câu SQL chen giữa sẽ ghi đè ROW_COUNT — db-reviewer r3 R3-3)
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
    GET DIAGNOSTICS v_count = ROW_COUNT;  -- ngay sau INSERT (một câu SQL chen giữa sẽ ghi đè ROW_COUNT — db-reviewer r3 R3-3)
  ELSE
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, user_id text, program_product_id text,
             base_before text, base_after text, qty_before text, qty_after text, amount_vnd text, status text)
       WHERE NOT COALESCE(x.order_line_id ~ c_txt AND x.seq ~ c_seq AND x.user_id ~ c_uuid AND x.program_product_id ~ c_uuid
                          AND x.base_before ~ c_dec AND x.base_after ~ c_dec AND x.qty_before ~ c_int AND x.qty_after ~ c_int
                          AND x.amount_vnd ~ c_sint
                          AND x.status ~ '^(WAITING_GATE|ACCUMULATING|RECORDED|AT_CAP|ADJUSTMENT)$', false)) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(qty_before text, qty_after text, amount_vnd text)
       WHERE x.qty_before::numeric > 9223372036854775807 OR x.qty_after::numeric > 9223372036854775807
          OR abs(x.amount_vnd::numeric) > 9223372036854775807) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_result_lines (run_id, program_id, order_line_id, seq, user_id, program_product_id, base_before,
      base_after, qty_before, qty_after, amount_vnd, status)
    SELECT p_run_id, v_run.program_id, x.order_line_id, x.seq::integer, x.user_id::uuid, x.program_product_id::uuid,
           x.base_before::numeric, x.base_after::numeric, x.qty_before::bigint, x.qty_after::bigint, x.amount_vnd::bigint, x.status
      FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, user_id text, program_product_id text,
             base_before text, base_after text, qty_before text, qty_after text, amount_vnd text, status text);
    GET DIAGNOSTICS v_count = ROW_COUNT;  -- ngay sau INSERT (một câu SQL chen giữa sẽ ghi đè ROW_COUNT — db-reviewer r3 R3-3)
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
CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_cleanup(p_program_id uuid, p_max_rows integer DEFAULT 50000)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_cur  uuid;
  v_prev uuid;
  v_id   uuid;
  v_left integer;
  v_n    integer;
  v_del  integer := 0;
  v_done boolean := false;
BEGIN
  -- Trần 50.000 dòng / lần = lô app (r2.3, PM 03/11: lô 100.000 vượt statement_timeout 8 s trên PG15 khi máy tải; lô 50.000 đo
  -- local 1,4–3,5 s tuỳ tải, kể cả ở tập lưu giữ tối đa — dưới 8 s, không phải SLA).
  IF p_program_id IS NULL OR p_max_rows IS NULL OR p_max_rows < 1 OR p_max_rows > 50000 THEN
    RAISE EXCEPTION 'CMS_SALES_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT current_result_run_id INTO v_cur FROM public.cms_programs WHERE id = p_program_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- Tập run ok không đổi khi giữ FOR SHARE (chỉ publish đổi, cần FOR UPDATE) ⇒ v_prev ổn định trong hàm.
  SELECT id INTO v_prev FROM public.cms_sync_runs
   WHERE program_id = p_program_id AND kind = 'sales' AND status = 'ok' AND id IS DISTINCT FROM v_cur
   ORDER BY published_at DESC, id DESC LIMIT 1;
  SELECT id INTO v_id FROM public.cms_sync_runs
   WHERE program_id = p_program_id AND kind = 'sales' AND purged_at IS NOT NULL AND cleared_at IS NULL
   ORDER BY purged_at, id LIMIT 1;
  IF v_id IS NULL THEN
    -- 2 run held / error gần nhất (tie-break xác định) tính TRONG CÙNG câu lệnh chọn ứng viên (một snapshot): run vừa chuyển
    -- running → held / error giữa hai câu lệnh không thể bị chọn dọn trong khi bị loại khỏi tập giữ (db-reviewer r2.2 P2-1).
    SELECT r.id INTO v_id FROM public.cms_sync_runs r
     WHERE r.program_id = p_program_id AND r.kind = 'sales' AND r.purged_at IS NULL AND r.status <> 'running'
       AND r.id IS DISTINCT FROM v_cur AND r.id IS DISTINCT FROM v_prev
       AND (r.status = 'ok' OR r.finished_at < now() - interval '24 hours'
            OR r.id NOT IN (SELECT k.id FROM public.cms_sync_runs k
                             WHERE k.program_id = p_program_id AND k.kind = 'sales' AND k.status IN ('held', 'error')
                             ORDER BY k.finished_at DESC, k.id DESC LIMIT 2))
     ORDER BY r.started_at, r.id LIMIT 1;
    IF v_id IS NOT NULL THEN
      UPDATE public.cms_sync_runs SET purged_at = now() WHERE id = v_id AND purged_at IS NULL AND status <> 'running';
      IF NOT FOUND THEN v_id := NULL; END IF;
    END IF;
  END IF;
  IF v_id IS NOT NULL THEN
    v_left := p_max_rows;
    DELETE FROM public.cms_result_lines WHERE ctid IN (SELECT ctid FROM public.cms_result_lines WHERE run_id = v_id LIMIT v_left);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_result_catalog WHERE ctid IN (SELECT ctid FROM public.cms_result_catalog WHERE run_id = v_id LIMIT v_left);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_results WHERE ctid IN (SELECT ctid FROM public.cms_results WHERE run_id = v_id LIMIT v_left);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_sales_lines WHERE ctid IN (SELECT ctid FROM public.cms_sales_lines WHERE run_id = v_id LIMIT v_left);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_sync_run_chunks WHERE run_id = v_id;
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_result_catalog WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_results WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_sync_run_chunks WHERE run_id = v_id) THEN
      UPDATE public.cms_sync_runs SET cleared_at = now() WHERE id = v_id;
      v_done := true;
    END IF;
  END IF;
  RETURN jsonb_build_object('purged', CASE WHEN v_done THEN 1 ELSE 0 END, 'deleted', v_del, 'more',
    EXISTS (SELECT 1 FROM public.cms_sync_runs
             WHERE program_id = p_program_id AND kind = 'sales' AND purged_at IS NOT NULL AND cleared_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.cms_sync_runs r
                WHERE r.program_id = p_program_id AND r.kind = 'sales' AND r.purged_at IS NULL AND r.status <> 'running'
                  AND r.id IS DISTINCT FROM v_cur AND r.id IS DISTINCT FROM v_prev
                  AND (r.status = 'ok' OR r.finished_at < now() - interval '24 hours'
                       OR r.id NOT IN (SELECT k.id FROM public.cms_sync_runs k
                                        WHERE k.program_id = p_program_id AND k.kind = 'sales' AND k.status IN ('held', 'error')
                                        ORDER BY k.finished_at DESC, k.id DESC LIMIT 2))));
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
    IF v_basis IS NULL OR v_basis <> 'qa_assumption' OR NOT v_prog.is_test THEN
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
    'earliest_lock_at', public.cms__ts(v_earliest),
    'blockers', to_jsonb(v_b));
END;
$$;
CREATE OR REPLACE FUNCTION public.rpc_cms_payout(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pay   public.cms_payouts%ROWTYPE;
  v_su    boolean;
  v_users uuid[];
  v_rows  jsonb;
  v_scope numeric;
BEGIN
  IF auth.uid() IS NULL OR p_program_id IS NULL OR NOT (p_program_id = ANY (public.cms_readable_program_ids())) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_pay FROM public.cms_payouts WHERE program_id = p_program_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PAYOUT_NOT_LOCKED' USING ERRCODE = 'P0002'; END IF;
  v_su := public.is_super_admin();
  v_users := CASE WHEN v_su THEN NULL ELSE COALESCE(public.cms__visible_result_users(), '{}'::uuid[]) END;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', s.user_id, 'store_id', s.store_id, 'name', s.name_snapshot, 'store_name', s.store_name_snapshot,
           'amount_vnd', s.amount_vnd::text, 'products_with_cms', s.products_with_cms)
           || CASE WHEN v_su THEN jsonb_build_object('email', s.email_snapshot) ELSE '{}'::jsonb END
           ORDER BY s.store_name_snapshot, s.name_snapshot, s.user_id), '[]'::jsonb),
         COALESCE(sum(s.amount_vnd), 0)
    INTO v_rows, v_scope
    FROM public.cms_payout_staff s
   WHERE s.program_id = p_program_id AND (v_users IS NULL OR s.user_id = ANY (v_users));
  RETURN jsonb_build_object(
    'program_id', p_program_id, 'run_id', v_pay.run_id, 'is_test', v_pay.is_test, 'locked_at', public.cms__ts(v_pay.locked_at),
    'policy_version', v_pay.policy_version,
    'viewer', CASE WHEN v_su THEN 'super' ELSE (SELECT u.role FROM public.users u WHERE u.id = auth.uid()) END,
    'program_total', CASE WHEN v_su THEN v_pay.amount_vnd::text END,
    'scope_total', v_scope::text,
    'rows', v_rows)
    || CASE WHEN v_su THEN jsonb_build_object(
         'locked_by', v_pay.locked_by, 'staff_rows', v_pay.staff_rows, 'staff_paid', v_pay.staff_paid,
         'candidate_lines', v_pay.candidate_lines, 'candidate_gmv', v_pay.candidate_gmv::text,
         'unassigned_lines', v_pay.unassigned_lines, 'unassigned_gmv', v_pay.unassigned_gmv::text,
         'ack_reason', v_pay.ack_reason, 'policy', v_pay.policy, 'source_complete_basis', v_pay.source_complete_basis,
         'source_complete_through', to_char(v_pay.source_complete_through, 'YYYY-MM-DD'),
         'run_started_at', public.cms__ts(v_pay.run_started_at)) ELSE '{}'::jsonb END;
END;
$$;
CREATE FUNCTION public.rpc_cms_program_lock(p_program_id uuid, p_expected_run_id uuid, p_expected_policy_version integer,
                                            p_actor uuid, p_ack_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '3s' AS $$
DECLARE
  v_prog public.cms_programs%ROWTYPE;
  v_run  public.cms_sync_runs%ROWTYPE;
  v_pay  public.cms_payouts%ROWTYPE;
  v_ev   jsonb;
  v_ack  text;
  v_n    integer;
  v_paid integer;
  v_sum  numeric;
BEGIN
  IF p_program_id IS NULL OR p_expected_run_id IS NULL OR p_expected_policy_version IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'CMS_LOCK_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- Sau khoá cần snapshot mới mỗi câu lệnh (đọc thấy ghi đã commit trong lúc chờ) ⇒ bắt buộc READ COMMITTED (mẫu 121).
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_actor) THEN
    RAISE EXCEPTION 'CMS_LOCK_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- 1. Chương trình FOR UPDATE — giữ tới COMMIT (DML cấu hình / publish / cleanup / open chờ).
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- 2. Đã chốt: gọi lại cùng run ⇒ already.
  IF v_prog.status = 'locked' THEN
    SELECT * INTO v_pay FROM public.cms_payouts WHERE program_id = p_program_id;
    IF FOUND AND v_pay.run_id = p_expected_run_id THEN
      RETURN jsonb_build_object('locked', true, 'already', true, 'program_id', p_program_id, 'run_id', v_pay.run_id,
                                'amount_vnd', v_pay.amount_vnd::text, 'policy_version', v_pay.policy_version);
    END IF;
    RAISE EXCEPTION 'CMS_PROGRAM_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  -- Run hiện hành FOR UPDATE (thứ tự chương trình → run); ghi trực tiếp dữ liệu run giữ FOR SHARE ⇒ chờ nhau.
  IF v_prog.current_result_run_id IS NOT NULL THEN
    SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = v_prog.current_result_run_id FOR UPDATE;
  END IF;
  -- 3–9. Đánh giá SAU khoá; blocker đầu tiên ⇒ RAISE (không ghi gì).
  v_ev := public.cms__lock_eval(p_program_id, p_expected_run_id, p_expected_policy_version, p_ack_reason, true);
  IF jsonb_array_length(v_ev -> 'blockers') > 0 THEN
    RAISE EXCEPTION USING MESSAGE = v_ev -> 'blockers' ->> 0, ERRCODE = 'P0001';
  END IF;
  v_ack := CASE WHEN (v_ev ->> 'unassigned_lines')::integer > 0 THEN btrim(p_ack_reason, E' \t\r\n\f\v') END;
  -- 10. Payout + staff (định danh từ users / stores — snapshot).
  INSERT INTO public.cms_payouts (program_id, run_id, config_version, config_fp, mapping_fp, is_test, amount_vnd, staff_rows,
    staff_paid, candidate_lines, candidate_gmv, unassigned_lines, unassigned_gmv, policy, policy_version, ack_reason,
    run_started_at, source_complete_basis, source_complete_through, locked_by)
  VALUES (p_program_id, v_run.id, v_run.config_version, public.cms__config_fp(p_program_id), v_run.mapping_fp, v_run.is_test,
    v_run.amount_vnd, (v_ev ->> 'staff_rows')::integer, (v_ev ->> 'staff_paid')::integer, (v_ev ->> 'candidate_lines')::integer,
    (v_ev ->> 'candidate_gmv')::numeric, (v_ev ->> 'unassigned_lines')::integer, (v_ev ->> 'unassigned_gmv')::numeric,
    v_ev -> 'policy', (v_ev ->> 'policy_version')::integer, v_ack, v_run.started_at, v_ev ->> 'source_complete_basis',
    (v_ev ->> 'source_complete_through')::date, p_actor);
  INSERT INTO public.cms_payout_staff (program_id, user_id, store_id, email_snapshot, name_snapshot, store_name_snapshot,
                                       amount_vnd, products_with_cms)
  SELECT p_program_id, a.user_id, a.store_id, u.email, u.full_name, s.name, a.amt::bigint, a.np
    FROM (SELECT r.user_id, (array_agg(DISTINCT r.store_id))[1] AS store_id, sum(r.amount_vnd) AS amt,
                 count(*) FILTER (WHERE r.amount_vnd > 0)::integer AS np
            FROM public.cms_results r WHERE r.run_id = v_run.id GROUP BY r.user_id) a
    LEFT JOIN public.users u ON u.id = a.user_id
    LEFT JOIN public.stores s ON s.id = a.store_id;
  -- 11. Kiểm lại mapping SAU khi chép định danh (user / store đổi chen giữa ⇒ rollback) + bất biến tổng 4 nơi.
  IF public.cms__mapping_fp() IS DISTINCT FROM v_run.mapping_fp THEN
    RAISE EXCEPTION 'CMS_LOCK_STALE_MAPPING' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE amount_vnd > 0), COALESCE(sum(amount_vnd), 0) INTO v_n, v_paid, v_sum
    FROM public.cms_payout_staff WHERE program_id = p_program_id;
  IF v_sum <> v_run.amount_vnd::numeric
     OR v_sum <> (SELECT COALESCE(sum(r.amount_vnd), 0) FROM public.cms_results r WHERE r.run_id = v_run.id)
     OR v_n <> (SELECT count(DISTINCT r.user_id) FROM public.cms_results r WHERE r.run_id = v_run.id)
     OR v_n <> (v_ev ->> 'staff_rows')::integer OR v_paid <> (v_ev ->> 'staff_paid')::integer THEN
    RAISE EXCEPTION 'CMS_LOCK_TOTAL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  -- 12. Chốt.
  UPDATE public.cms_programs SET status = 'locked', locked_at = now(), locked_by = p_actor, updated_by = p_actor, updated_at = now()
   WHERE id = p_program_id;
  RETURN jsonb_build_object('locked', true, 'already', false, 'program_id', p_program_id, 'run_id', v_run.id,
                            'amount_vnd', v_run.amount_vnd::text, 'staff_rows', v_n, 'staff_paid', v_paid,
                            'unassigned_lines', (v_ev ->> 'unassigned_lines')::integer, 'policy_version', (v_ev ->> 'policy_version')::integer);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text) TO service_role;
-- Thu hồi grant khác owner do default privileges cấp cho hàm vừa tạo lại (như 123 §8).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.oid = 'public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)'::regprocedure
       AND x.grantee <> p.proowner AND x.grantee <> 'service_role'::regrole::oid
     GROUP BY x.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE 'REVOKE ALL ON FUNCTION public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text) FROM PUBLIC';
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text) FROM %I', pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- Payout về ràng buộc 123 (đã kiểm không có payout operator_reconciliation).
ALTER TABLE public.cms_payouts DROP CONSTRAINT cms_payouts_attestation;
ALTER TABLE public.cms_payouts DROP CONSTRAINT cms_payouts_source_complete_basis_check;
ALTER TABLE public.cms_payouts ADD CONSTRAINT cms_payouts_source_complete_basis_check
  CHECK (source_complete_basis IN ('qa_assumption', 'bi_watermark', 'lag_commitment'));
ALTER TABLE public.cms_payouts DROP COLUMN source_attestation_id;

-- Bảng mới (trigger đi theo bảng) + helper.
DROP TABLE public.cms_source_attestations;
DROP TABLE public.cms_sales_source_lines;
DROP FUNCTION public.cms__attest_eval(uuid, uuid);
DROP FUNCTION public.cms__attest_immutable();
DROP FUNCTION public.cms__attest_truncate_guard();
DROP FUNCTION public.cms__run_source_check(uuid);
DROP FUNCTION public.cms__program_scope_hash(uuid);
DROP FUNCTION public.cms__run_source_fp(uuid, text);
DROP FUNCTION public.cms__run_source_fp_text(uuid, text);
DROP FUNCTION public.cms__fp_j(text);
ALTER TABLE public.cms_sync_runs DROP COLUMN source_schema;

DO $$
BEGIN
  IF to_regclass('public.cms_source_attestations') IS NOT NULL OR to_regclass('public.cms_sales_source_lines') IS NOT NULL
     OR to_regprocedure('public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)') IS NULL
     OR NOT has_function_privilege('service_role', 'public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)', 'EXECUTE')
     OR (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ',')
           FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
          WHERE p.oid = 'public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)'::regprocedure AND x.grantee <> p.proowner)
        IS DISTINCT FROM 'service_role:EXECUTE'
     OR to_regprocedure('public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('cms_sync_runs', 'cms_payouts')
                   AND column_name IN ('source_schema', 'source_attestation_id'))
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.cms_payouts'::regclass
                     AND conname = 'cms_payouts_source_complete_basis_check'
                     AND pg_catalog.pg_get_constraintdef(oid) LIKE '%qa_assumption%bi_watermark%lag_commitment%'
                     AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%operator_reconciliation%')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.cms_payouts'::regclass AND conname = 'cms_payouts_attestation') THEN
    RAISE EXCEPTION 'rollback 124 hậu kiểm: chưa về trạng thái 123';
  END IF;
END $$;
DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_open(uuid, jsonb)'::regprocedure) IS DISTINCT FROM '4aa263fb8d4a526eb52d76bf561dbc59'
     OR (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_stage(uuid, text, integer, jsonb)'::regprocedure) IS DISTINCT FROM '7815855f252939ddbd9961597b1d1823'
     OR (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_cleanup(uuid, integer)'::regprocedure) IS DISTINCT FROM '72db7f1c3f562f5c841fcb68314c4e30'
     OR (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__lock_eval(uuid, uuid, integer, text, boolean)'::regprocedure) IS DISTINCT FROM 'c4a9c555e6c1cd85fb89e15a26155b0a'
     OR (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_payout(uuid)'::regprocedure) IS DISTINCT FROM '6b75e9a3c8b5fec978bc8a63d6579e5c'
     OR (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)'::regprocedure) IS DISTINCT FROM 'f71538167e3c48ae46bc87e1257ae7d3' THEN
    RAISE EXCEPTION 'rollback 124 hậu kiểm: thân hàm 122 / 123 khôi phục lệch nguyên văn (md5)';
  END IF;
END $$;
-- Hậu kiểm quyền / cấu hình / owner 6 hàm khôi phục (db-reviewer r2 P1-1 — gate ACL áp cả CREATE OR REPLACE) + tổng hàm CMS = 55 (123).
DO $$
DECLARE
  r     record;
  v_exp text;
  v_lt  text;
  v_n   integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proowner,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ',' ORDER BY 1)
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl
      FROM pg_catalog.pg_proc p
     WHERE p.oid IN ('public.rpc_cms_sales_run_open(uuid, jsonb)'::regprocedure, 'public.rpc_cms_sales_run_stage(uuid, text, integer, jsonb)'::regprocedure,
                     'public.rpc_cms_sales_run_cleanup(uuid, integer)'::regprocedure, 'public.cms__lock_eval(uuid, uuid, integer, text, boolean)'::regprocedure,
                     'public.rpc_cms_payout(uuid)'::regprocedure, 'public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)'::regprocedure)
  LOOP
    v_n := v_n + 1;
    v_exp := CASE r.proname WHEN 'rpc_cms_payout' THEN 'authenticated:EXECUTE' WHEN 'cms__lock_eval' THEN NULL ELSE 'service_role:EXECUTE' END;
    v_lt := CASE WHEN r.proname = 'rpc_cms_program_lock' THEN 'lock_timeout=3s'
                 WHEN r.proname IN ('rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_cleanup') THEN 'lock_timeout=5s' END;
    IF r.acl IS DISTINCT FROM v_exp OR NOT r.prosecdef OR has_function_privilege('anon', r.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', r.oid, 'EXECUTE') IS DISTINCT FROM (v_exp = 'authenticated:EXECUTE' AND v_exp IS NOT NULL)
       OR has_function_privilege('service_role', r.oid, 'EXECUTE') IS DISTINCT FROM (v_exp = 'service_role:EXECUTE' AND v_exp IS NOT NULL)
       OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}'))) OR (v_lt IS NOT NULL AND NOT (v_lt = ANY (COALESCE(r.proconfig, '{}'))))
       OR r.proowner <> (SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.cms_payouts'::regclass) THEN
      RAISE EXCEPTION 'rollback 124 hậu kiểm: ACL / SECDEF / config / owner hàm % sai (acl %)', r.proname, r.acl;
    END IF;
  END LOOP;
  IF v_n <> 6 THEN RAISE EXCEPTION 'rollback 124 hậu kiểm: cần đủ 6 hàm 122 / 123 khôi phục, có %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> 55 THEN RAISE EXCEPTION 'rollback 124 hậu kiểm: tổng hàm CMS phải về 55 (123), có %', v_n; END IF;
END $$;

DELETE FROM public.app_migrations WHERE version = '124';

COMMIT;
