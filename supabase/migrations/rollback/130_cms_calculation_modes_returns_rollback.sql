-- ============================================================================
-- rollback/130_cms_calculation_modes_returns_rollback.sql  (CANDIDATE — sinh bằng webapp/scripts/gen-cms-130.mjs; KHÔNG sửa tay)
-- Gỡ 130 về đúng nền 127: app TRƯỚC (về bản không gọi save_v2 / reader v2 / pipeline contract), rồi file này. DỪNG (không xoá gì) nếu
-- đã có dữ liệu của chế độ mới: chương trình chọn basis qua v2 (admin / pending), cms_unit, net_returns_v1. Chương trình tạo bằng đường
-- cũ sau 130 (legacy_compat = pos_base) gỡ cột được, không mất nghĩa. KHÔNG xoá kết quả / pointer đã công bố.
-- Gồm DELETE FROM app_migrations WHERE version = '130'. READ COMMITTED; đúng role owner; giữ LF.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.cms_programs, public.cms_program_products, public.cms_payouts, public.cms_sync_runs, public.cms_sync_run_chunks,
           public.cms_sales_source_lines, public.cms_sales_lines, public.cms_results, public.cms_return_ledger_evals,
           public.cms_return_baselines, public.cms_return_conflicts, public.cms_return_restorations, public.cms_return_close_reports,
           public.cms_return_close_report_lines, public.cms_return_close_report_events, public.cms_return_lines, public.cms_result_events,
           public.cms_return_conflict_observations, public.cms_return_conflict_restorations
  IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  v_name text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'rollback 130: cần READ COMMITTED';
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '130';
  IF v_name IS DISTINCT FROM 'cms_calculation_modes_returns' THEN
    RAISE EXCEPTION 'rollback 130: không có marker 130 cms_calculation_modes_returns (name = %)', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 130) THEN
    RAISE EXCEPTION 'rollback 130: DB đã có migration số > 130 — gỡ bản sau trước';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r0 WHERE r0.rolname = current_user AND (r0.rolsuper OR r0.rolbypassrls)) THEN
    RAISE EXCEPTION 'rollback 130: role chạy (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE status = 'running') THEN
    RAISE EXCEPTION 'rollback 130: còn run đang chạy';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_programs
              WHERE quantity_basis_source IN ('admin', 'pending') OR quantity_basis IS DISTINCT FROM 'pos_base'
                 OR returns_policy <> 'sales_only_v1') THEN
    RAISE EXCEPTION 'rollback 130: đã có chương trình dùng chế độ mới (admin / pending / cms_unit / net_returns_v1) — DỪNG, xử lý tiến';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE calc_contract_version IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.cms_return_lines) OR EXISTS (SELECT 1 FROM public.cms_result_events)
     OR EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE src_v IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.cms_sales_source_lines WHERE src_v IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.cms_results WHERE net_v IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback 130: đã có run / dữ liệu run contract — DỪNG, xử lý tiến';
  END IF;
  -- Sổ trả hàng bền (baseline tài chính / conflict / phục hồi / eval / báo cáo sau chốt) KHÔNG bao giờ bị xoá bởi rollback.
  IF EXISTS (SELECT 1 FROM public.cms_return_ledger_evals) OR EXISTS (SELECT 1 FROM public.cms_return_baselines)
     OR EXISTS (SELECT 1 FROM public.cms_return_conflicts) OR EXISTS (SELECT 1 FROM public.cms_return_restorations)
     OR EXISTS (SELECT 1 FROM public.cms_return_close_reports) THEN
    RAISE EXCEPTION 'rollback 130: sổ trả hàng đã có dữ liệu — DỪNG, xử lý tiến';
  END IF;
END $$;
-- Thân hàm hiện tại phải đúng bản 130 đã sinh (không sửa tay sau 130) — khối sinh bởi gen-cms-130.mjs.
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__src_clean(text)')) IS DISTINCT FROM '63b3dbbb589459d1b486039c7e73f2f8'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__unit_key(text)')) IS DISTINCT FROM '63103d1c140e24dba82f1c748e82cdb8'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__qty_dec(text)')) IS DISTINCT FROM 'fb241862be3362150b732839e0d492b4'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__return_status_effect(text)')) IS DISTINCT FROM 'c17a317d69570bbeb8ccbd8003b99e0a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone)')) IS DISTINCT FROM 'b25fdd09183dffc64658e9ae704aeadf'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__programs_basis_guard()')) IS DISTINCT FROM '534964b54b91f5b6d00c9c9916c38edb'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__products_basis_guard()')) IS DISTINCT FROM '23f9afeb1655bf939b7b53327d2a0d77'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_program_save_v2(jsonb)')) IS DISTINCT FROM '41775befd6e5c8e0e8483dbff08090a9'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)')) IS DISTINCT FROM '76f945a8c051bcfb0ee750bf3dd1f166'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_capabilities()')) IS DISTINCT FROM 'ab71996e89d66ddcd8a2c4b02c1caa5e'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__stage_contract(uuid,text,integer,jsonb)')) IS DISTINCT FROM '93b9788769d20237c3d09a273de8252b'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__seal_begin_contract(uuid,jsonb)')) IS DISTINCT FROM '588b1c83f285facf39a228391576d4c3'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__seal_contract_step(uuid,integer)')) IS DISTINCT FROM '8d750bcc6b45a6926262068d6289cd99'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__ledger_set_hash(uuid)')) IS DISTINCT FROM '72c6e9943fc592145b08a483ab3a9c17'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__open_set_hash(uuid)')) IS DISTINCT FROM 'c93c1b7564014147a41c94cf7e70fc5d'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__as_of_floor(uuid)')) IS DISTINCT FROM '292f9884a3b11216bc5a1ff6c8d4d86f'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__ledger_immutable()')) IS DISTINCT FROM '2938fbddd4b0cb398e6e974bc50ff47b'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__ledger_eval_guard()')) IS DISTINCT FROM 'c6e3fdc2ce57477eb7424aaac198a940'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__ledger_insert_guard()')) IS DISTINCT FROM 'd6f323bc02cdf8581f841d82bf937a9f'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__ledger_eval(uuid,text,uuid,timestamp with time zone,text,jsonb)')) IS DISTINCT FROM 'bcccc930500360297ab67d270297799a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__publish_contract(uuid)')) IS DISTINCT FROM 'e280ae4939fddda9938b4544b7532a9e'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_conflicts_confirm_restored(uuid,text,bigint,text,uuid)')) IS DISTINCT FROM '7914936bc1e194b6ef04cc39944ae83d'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__run_contract(uuid)')) IS DISTINCT FROM '13404aa1c8411da8c9e706293cc9bd69'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_header_v2(uuid)')) IS DISTINCT FROM '4ffc602cb0a641432b31f2d6032f1d85'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_rows_v2(uuid,uuid)')) IS DISTINCT FROM '0eb5861076ba55ecfbdb3134f0b4d93f'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_events_v2(uuid,uuid,uuid,uuid,integer,integer)')) IS DISTINCT FROM '2e76dd82c771bebc7cf4970fcc412db0'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_excluded_v2(uuid,uuid,text,integer,integer)')) IS DISTINCT FROM '36dfbac01d1fd4c3cf71fc93fcf55984'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_returns_v2(uuid,uuid,integer,integer)')) IS DISTINCT FROM 'e2c28299d2f5b9fe423cde2736f12589'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_conflicts(uuid)')) IS DISTINCT FROM 'eb7ad251732cb5857e6a3962d2d025fa'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__report_rows(jsonb)')) IS DISTINCT FROM '4efa81d495838e71bdafa248894586e9'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_report_save(uuid,uuid,jsonb)')) IS DISTINCT FROM '60dd216a8f9f5bd680171601d9377fc0'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_frozen_sales_lines(uuid,integer,integer)')) IS DISTINCT FROM '056b83531da67d3f547c8665d4c02c48'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_reports(uuid)')) IS DISTINCT FROM '15af6feac81da195c56aa5a396ca4e16'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_report(uuid,integer,integer)')) IS DISTINCT FROM 'c2ff20f86cb23d3e91a6a847c3363efe'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_report_events(uuid,text,integer)')) IS DISTINCT FROM '20879fbe6f56c53110e4bc5392a6dfee'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_open(uuid,jsonb)')) IS DISTINCT FROM 'c9bafba3b88949308c10b4f06732f106'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_stage(uuid,text,integer,jsonb)')) IS DISTINCT FROM 'dc0bdbfa4a0effa50927609bff86915c'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_cleanup(uuid,integer)')) IS DISTINCT FROM 'e437968ffc7aa60b96f9d2029e36c24e'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__lock_eval(uuid,uuid,integer,text,boolean)')) IS DISTINCT FROM 'f7fa018ad762a526ff6279a48c427d61'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__attest_eval(uuid,uuid)')) IS DISTINCT FROM '9a332cd63acf909558e8bccba868af82'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_seal_begin(uuid,jsonb)')) IS DISTINCT FROM '2d2954fc3e86eaa5d066f8393e28eb10'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_seal_step(uuid,integer)')) IS DISTINCT FROM '3892508f17c738585ef521fac8e7b04a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__sales_snapshot(uuid)')) IS DISTINCT FROM 'b8fc8150ff3d733f4a73b8a19dc22daa'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_header(uuid)')) IS DISTINCT FROM '97060db8f5670948dc446f525072ab59'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_rows(uuid,uuid)')) IS DISTINCT FROM '2b39826275a0369349d43602bcf76a13'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_lines(uuid,uuid,uuid,uuid,integer,integer)')) IS DISTINCT FROM 'd87d45d4f9121d41cdfbdedcc1b20271'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_excluded(uuid,uuid,integer,integer)')) IS DISTINCT FROM '069f0d8be9b964fe96802408c4f417a4'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_publish(uuid)')) IS DISTINCT FROM 'a1a618ed424778ae0ed9b650f87910db' THEN
    RAISE EXCEPTION 'rollback 130 preflight: thân hàm 130 hiện tại KHÁC bản đã sinh (md5) — có sửa tay? dừng, đối chiếu';
  END IF;
END $$;

-- ── Dựng lại NGUYÊN VĂN thân 120–126 của 13 hàm thay (trước khi gỡ cột / bảng / hàm mới) ──
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
  c_t30  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,30}$';  -- 124: order_type / order_status thô
  c_mail CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]+$';  -- regex PG lặp tối đa 255; độ dài ≤ 320 + chữ thường do CHECK / kiểm dưới
BEGIN
  IF p_part IS NULL OR p_part NOT IN ('sales_lines', 'results', 'catalog', 'result_lines', 'source_lines') THEN
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
     OR (p_part IN ('sales_lines', 'result_lines', 'source_lines') AND jsonb_path_exists(p_rows, 'strict $[*].* ? (@.type() == "boolean")'))
     -- Trường boolean phải là boolean JSON (chuỗi 'true' / 'abc' ⇒ lỗi dòng, không để lọt lỗi ép kiểu thô).
     OR (p_part = 'results' AND jsonb_path_exists(p_rows, '$[*] ? (@.at_cap.type() != "boolean" || @.gate_met.type() != "boolean")'))
     OR (p_part = 'catalog' AND jsonb_path_exists(p_rows, '$[*] ? (@.met.type() != "boolean")')) THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
  END IF;

  -- Khối bắt lỗi ép kiểu: ngày qua regex nhưng không tồn tại (30/02, năm 0000) ⇒ CMS_STAGE_BAD_ROW, không lỗi thô 22008
  -- (db-reviewer r2 N4). Trùng khoá / CHECK vẫn lộ mã gốc (kiểm thử dựa vào).
  BEGIN
  IF p_part = 'source_lines' THEN
    -- 124: lớp NGUỒN — chỉ run mở sau 124 (source_schema = 1). MỌI dòng hợp lệ adapter đọc trong kỳ + SP (kể cả ONLINE / chưa
    -- hoàn tất), 14 trường thô đã chuẩn hoá; không phân loại engine. Cùng lớp ký tự / độ dài / dạng số như sales_lines.
    IF v_run.source_schema IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_PART' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, order_id text, order_code text, product_id text,
             seller_email text, pos_code text, order_type text, order_status text, completed_at text, source_updated_at text,
             quantity_raw text, uom_raw text, base_quantity text, gmv_amount text)
       WHERE NOT (COALESCE(x.order_line_id ~ c_txt AND x.order_id ~ c_txt AND x.order_code ~ c_txt AND x.product_id ~ c_pid
                           AND x.order_type ~ c_t30 AND x.order_status ~ c_t30 AND x.completed_at ~ c_ts
                           AND x.source_updated_at ~ c_ts AND x.base_quantity ~ c_dec AND x.gmv_amount ~ c_dec, false)
                  AND (x.seller_email IS NULL OR (x.seller_email ~ c_mail AND char_length(x.seller_email) <= 320
                                                  AND x.seller_email = lower(x.seller_email)))
                  AND (x.pos_code IS NULL OR x.pos_code ~ c_t50)
                  AND (x.quantity_raw IS NULL OR x.quantity_raw ~ c_t50) AND (x.uom_raw IS NULL OR x.uom_raw ~ c_t50))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_sales_source_lines (run_id, program_id, order_line_id, order_id, order_code, product_id, seller_email,
      pos_code, order_type, order_status, completed_at, source_updated_at, quantity_raw, uom_raw, base_quantity, gmv_amount)
    SELECT p_run_id, v_run.program_id, x.order_line_id, x.order_id, x.order_code, x.product_id, x.seller_email, x.pos_code,
           x.order_type, x.order_status, x.completed_at::timestamptz, x.source_updated_at::timestamptz, x.quantity_raw, x.uom_raw,
           x.base_quantity::numeric, x.gmv_amount::numeric
      FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, order_id text, order_code text, product_id text,
             seller_email text, pos_code text, order_type text, order_status text, completed_at text, source_updated_at text,
             quantity_raw text, uom_raw text, base_quantity text, gmv_amount text);
    GET DIAGNOSTICS v_count = ROW_COUNT;  -- ngay sau INSERT
  ELSIF p_part = 'sales_lines' THEN
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
    -- 124: lớp nguồn sau lớp engine, trước khối.
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_sales_source_lines WHERE ctid IN (SELECT ctid FROM public.cms_sales_source_lines WHERE run_id = v_id LIMIT v_left);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_sales_source_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_sync_run_chunks WHERE run_id = v_id;
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_result_catalog WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_results WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_sales_source_lines WHERE run_id = v_id)
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
CREATE OR REPLACE FUNCTION public.rpc_cms_result_excluded(p_program_id uuid, p_run_id uuid, p_after_seq integer DEFAULT NULL,
                                               p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run  uuid;
  v_rows jsonb;
  v_next integer;
BEGIN
  IF p_run_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_after_seq IS NOT NULL AND p_after_seq < 0) THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- Định danh nguồn lỗi (email người bán) chỉ cho super admin — kiểm TRƯỚC khi tra run để non-super không phân biệt được
  -- RUN_GONE / FORBIDDEN (không dò được run tồn tại — security review P2).
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  v_run := public.cms__result_run(p_program_id, p_run_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'seq', q.seq, 'order_line_id', q.order_line_id, 'order_code', q.order_code, 'product_id', q.product_id,
      'program_product_id', q.program_product_id, 'disposition', q.disposition, 'unassigned_reason', q.unassigned_reason,
      'seller_email', q.seller_email, 'user_id', q.user_id, 'store_id', q.store_id, 'pos_code', q.pos_code,
      'completed_at', public.cms__ts(q.completed_at), 'base_quantity', q.base_quantity::text,
      'gmv_amount', q.gmv_amount::text) ORDER BY q.seq), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT * FROM public.cms_sales_lines sl
           WHERE sl.run_id = v_run AND sl.disposition <> 'INCLUDED' AND sl.seq > COALESCE(p_after_seq, -1)
           ORDER BY sl.seq LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'seq')::integer;
  END IF;
  RETURN jsonb_build_object('run_id', v_run, 'rows', v_rows, 'next_after_seq', v_next);
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


-- ── Gỡ ledger trả hàng (chỉ tới đây khi các bảng ledger rỗng — preflight rb-head), theo thứ tự FK ─────────
ALTER TABLE public.cms_sync_runs DROP CONSTRAINT cms_sync_runs_ledger_eval_fk;
DROP TABLE public.cms_return_conflict_observations;
ALTER TABLE public.cms_return_conflicts DROP CONSTRAINT cms_return_conflicts_prev_fk;
DROP TABLE public.cms_return_conflict_restorations;
DROP TABLE public.cms_return_restorations;
DROP TABLE public.cms_return_conflicts;
DROP TABLE public.cms_return_baselines;
DROP TABLE public.cms_return_close_report_events;
DROP TABLE public.cms_return_close_report_lines;
DROP TABLE public.cms_return_close_reports;
DROP TABLE public.cms_return_ledger_evals;
ALTER TABLE public.cms_payouts DROP CONSTRAINT cms_payouts_program_run;

-- ── Gỡ bảng / cột run contract, dựng lại đúng 3 ràng buộc 122 / 124 ─────────
DROP TABLE public.cms_result_events;
DROP TABLE public.cms_return_lines;
ALTER TABLE public.cms_results
  DROP COLUMN return_count, DROP COLUMN return_gmv, DROP COLUMN sale_gmv, DROP COLUMN counted_sale_qty, DROP COLUMN eligible_base,
  DROP COLUMN eligible_return_base, DROP COLUMN eligible_sale_base, DROP COLUMN return_base, DROP COLUMN sale_base, DROP COLUMN net_v;
ALTER TABLE public.cms_sales_lines
  DROP COLUMN eligible_base, DROP COLUMN quantity_class, DROP COLUMN uom_src_flag, DROP COLUMN quantity_src_flag, DROP COLUMN uom_src,
  DROP COLUMN quantity_src, DROP COLUMN src_v;
ALTER TABLE public.cms_sales_source_lines
  DROP COLUMN uom_src_flag, DROP COLUMN quantity_src_flag, DROP COLUMN uom_src, DROP COLUMN quantity_src, DROP COLUMN src_v;
ALTER TABLE public.cms_sync_run_chunks DROP CONSTRAINT cms_sync_run_chunks_part_check;
ALTER TABLE public.cms_sync_run_chunks ADD CONSTRAINT cms_sync_run_chunks_part_check
  CHECK (part IN ('sales_lines', 'results', 'catalog', 'result_lines', 'source_lines'));
ALTER TABLE public.cms_sync_runs DROP CONSTRAINT cms_sync_runs_sales_publish;
ALTER TABLE public.cms_sync_runs DROP CONSTRAINT cms_sync_runs_seal_step_check;
ALTER TABLE public.cms_sync_runs
  DROP CONSTRAINT cms_sync_runs_contract_ok, DROP CONSTRAINT cms_sync_runs_ledger_shape, DROP CONSTRAINT cms_sync_runs_contract_sealed,
  DROP CONSTRAINT cms_sync_runs_returns_shape, DROP CONSTRAINT cms_sync_runs_contract_shape,
  DROP COLUMN ledger_eval_seq, DROP COLUMN ledger_checked_at, DROP COLUMN ledger_set_hash, DROP COLUMN ledger_verdict,
  DROP COLUMN returns_rows_read, DROP COLUMN returns_digest, DROP COLUMN returns_as_of, DROP COLUMN sales_src_digest,
  DROP COLUMN source_pin, DROP COLUMN status_dictionary_version, DROP COLUMN unit_key_version, DROP COLUMN calc_contract_version,
  DROP COLUMN returns_policy, DROP COLUMN quantity_policy_version, DROP COLUMN quantity_basis;
ALTER TABLE public.cms_sync_runs ADD CONSTRAINT cms_sync_runs_seal_step_check CHECK (seal_step IS NULL OR seal_step BETWEEN 0 AND 10);
ALTER TABLE public.cms_sync_runs ADD CONSTRAINT cms_sync_runs_sales_publish CHECK (kind <> 'sales' OR (
    ((status = 'ok') = (published_at IS NOT NULL))
    AND (published_at IS NULL OR (sealed_at IS NOT NULL AND amount_vnd IS NOT NULL))
    AND (sealed_at IS NULL OR (seal_expect IS NOT NULL AND seal_step = 10))
    AND (purged_at IS NULL OR status <> 'running')
    AND (cleared_at IS NULL OR purged_at IS NOT NULL)));

-- ── Gỡ trigger / cột / hàm mới ──────────────────────────────────────────────
DROP TRIGGER cms_products_basis_guard ON public.cms_program_products;
DROP TRIGGER cms_programs_basis_guard ON public.cms_programs;
ALTER TABLE public.cms_programs
  DROP COLUMN returns_policy_set_at,
  DROP COLUMN returns_policy_set_by,
  DROP COLUMN returns_policy,
  DROP COLUMN quantity_basis_set_at,
  DROP COLUMN quantity_basis_set_by,
  DROP COLUMN quantity_basis_source,
  DROP COLUMN quantity_basis;
DROP FUNCTION public.cms__src_clean(text);
DROP FUNCTION public.cms__unit_key(text);
DROP FUNCTION public.cms__qty_dec(text);
DROP FUNCTION public.cms__return_status_effect(text);
DROP FUNCTION public.cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone);
DROP FUNCTION public.cms__programs_basis_guard();
DROP FUNCTION public.cms__products_basis_guard();
DROP FUNCTION public.rpc_cms_program_save_v2(jsonb);
DROP FUNCTION public.rpc_cms_program_set_returns_policy(uuid,text,integer,uuid);
DROP FUNCTION public.rpc_cms_capabilities();
DROP FUNCTION public.cms__stage_contract(uuid,text,integer,jsonb);
DROP FUNCTION public.cms__seal_begin_contract(uuid,jsonb);
DROP FUNCTION public.cms__seal_contract_step(uuid,integer);
DROP FUNCTION public.cms__ledger_set_hash(uuid);
DROP FUNCTION public.cms__open_set_hash(uuid);
DROP FUNCTION public.cms__as_of_floor(uuid);
DROP FUNCTION public.cms__ledger_immutable();
DROP FUNCTION public.cms__ledger_eval_guard();
DROP FUNCTION public.cms__ledger_insert_guard();
DROP FUNCTION public.cms__ledger_eval(uuid,text,uuid,timestamp with time zone,text,jsonb);
DROP FUNCTION public.cms__publish_contract(uuid);
DROP FUNCTION public.rpc_cms_return_conflicts_confirm_restored(uuid,text,bigint,text,uuid);
DROP FUNCTION public.cms__run_contract(uuid);
DROP FUNCTION public.rpc_cms_result_header_v2(uuid);
DROP FUNCTION public.rpc_cms_result_rows_v2(uuid,uuid);
DROP FUNCTION public.rpc_cms_result_events_v2(uuid,uuid,uuid,uuid,integer,integer);
DROP FUNCTION public.rpc_cms_result_excluded_v2(uuid,uuid,text,integer,integer);
DROP FUNCTION public.rpc_cms_result_returns_v2(uuid,uuid,integer,integer);
DROP FUNCTION public.rpc_cms_return_conflicts(uuid);
DROP FUNCTION public.cms__report_rows(jsonb);
DROP FUNCTION public.rpc_cms_return_close_report_save(uuid,uuid,jsonb);
DROP FUNCTION public.rpc_cms_frozen_sales_lines(uuid,integer,integer);
DROP FUNCTION public.rpc_cms_return_close_reports(uuid);
DROP FUNCTION public.rpc_cms_return_close_report(uuid,integer,integer);
DROP FUNCTION public.rpc_cms_return_close_report_events(uuid,text,integer);

DELETE FROM public.app_migrations WHERE version = '130';

DO $$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> 68 THEN RAISE EXCEPTION 'rollback 130 hậu kiểm: tổng hàm CMS phải 68 như nền 127, có %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
              WHERE attrelid = 'public.cms_programs'::regclass AND attname IN ('quantity_basis', 'returns_policy') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'rollback 130 hậu kiểm: còn cột 130 trên cms_programs';
  END IF;
END $$;
-- Quyền các hàm dựng lại = nền (db-reviewer 14/11 P2-8): anon không; authenticated / service_role đúng ma trận; SECDEF + search_path.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.sig, x.auth_x, x.svc_x, p.prosecdef, p.proconfig,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS a_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS u_x,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS s_x
      FROM (VALUES ('rpc_cms_sales_run_open(uuid,jsonb)'::text, false, true), ('rpc_cms_sales_run_stage(uuid,text,integer,jsonb)', false, true), ('rpc_cms_sales_run_cleanup(uuid,integer)', false, true), ('cms__lock_eval(uuid,uuid,integer,text,boolean)', false, false), ('cms__attest_eval(uuid,uuid)', false, false), ('rpc_cms_sales_run_seal_begin(uuid,jsonb)', false, true), ('rpc_cms_sales_run_seal_step(uuid,integer)', false, true), ('cms__sales_snapshot(uuid)', false, false), ('rpc_cms_result_header(uuid)', true, false), ('rpc_cms_result_rows(uuid,uuid)', true, false), ('rpc_cms_result_lines(uuid,uuid,uuid,uuid,integer,integer)', true, false), ('rpc_cms_result_excluded(uuid,uuid,integer,integer)', true, false), ('rpc_cms_sales_run_publish(uuid)', false, true)) AS x(sig, auth_x, svc_x)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure('public.' || x.sig)
  LOOP
    IF r.prosecdef IS DISTINCT FROM true OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}')))
       OR r.a_x IS DISTINCT FROM false OR r.u_x IS DISTINCT FROM r.auth_x OR r.s_x IS DISTINCT FROM r.svc_x THEN
      RAISE EXCEPTION 'rollback 130 hậu kiểm: quyền % sai (SECDEF %, config %, anon % auth % svc %)',
        r.sig, r.prosecdef, r.proconfig, r.a_x, r.u_x, r.s_x;
    END IF;
  END LOOP;
END $$;
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_open(uuid,jsonb)')) IS DISTINCT FROM 'a0123bc5abeefac9da1c8dbcd645a97a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_stage(uuid,text,integer,jsonb)')) IS DISTINCT FROM 'b19df838c787755c56c76cfd8ff48a3a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_cleanup(uuid,integer)')) IS DISTINCT FROM 'bbea7ad89f57a054a998db7b72d854b3'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__lock_eval(uuid,uuid,integer,text,boolean)')) IS DISTINCT FROM '6c38e2ca40f37d1cc5e715f8cd3e2bb5'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__attest_eval(uuid,uuid)')) IS DISTINCT FROM 'a75e03e0b4c7a45c446af38698cf44e9'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_seal_begin(uuid,jsonb)')) IS DISTINCT FROM '327d53af6739ffdbf780363aa6460bcc'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_seal_step(uuid,integer)')) IS DISTINCT FROM '55462ce6e7a5b5e6ad26a2c1751ca726'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__sales_snapshot(uuid)')) IS DISTINCT FROM 'e22120f8a95af5308420914c441ca260'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_header(uuid)')) IS DISTINCT FROM '26abaac3902886c1e82c92a9dcf321ec'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_rows(uuid,uuid)')) IS DISTINCT FROM 'a63f54b3243637c2c8979d0bc24c9d81'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_lines(uuid,uuid,uuid,uuid,integer,integer)')) IS DISTINCT FROM 'c1bf6ff7c059a4b3fe13c140205306cd'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_excluded(uuid,uuid,integer,integer)')) IS DISTINCT FROM '5fa1aa66c4c013bd2ca4a2f72cde6978'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_publish(uuid)')) IS DISTINCT FROM 'db2c97efad2bb5ee9d69399b99c7c258' THEN
    RAISE EXCEPTION 'rollback 130 hậu kiểm: thân hàm khôi phục lệch nguyên văn (md5)';
  END IF;
END $$;

COMMIT;
