
-- ── 8c. Báo cáo trả hàng sau chốt (PM D11, thiết kế r2 §6.6 + r2.1 §14.2) ──
-- Chỉ chương trình ĐÃ CHỐT (cms_payouts), run chốt legacy (cms__lock_eval chặn chốt run contract trong batch này). Báo cáo tính lại
-- net trên dòng bán / kết quả ĐÃ ĐÓNG BĂNG của run chốt + phiếu trả của snapshot ghim; KHÔNG là lệnh thu / chi (không ghi cms_payouts /
-- cms_payout_staff). Payload chỉ gồm pin + phiếu thô; DB tự suy disposition / người / SP / fp / số. Kiểm báo cáo = một eval kind
-- report trên CÙNG sổ receipt: lệch / còn conflict mở ⇒ ghi eval + conflict / observation, KHÔNG ghi báo cáo, trả held.

-- Phiếu payload ↦ dòng có kiểu + hash dòng cms-src-digest-v1 (22 trường, CÙNG công thức seal N9 cho cms_return_lines). Gọi SAU khi RPC đã
-- kiểm định dạng chuỗi (ép kiểu an toàn). Chỉ owner.
CREATE FUNCTION public.cms__report_rows(p_rows jsonb)
RETURNS TABLE (return_event_id text, return_status text, status_effect text, return_document_id text, return_code text,
               recorded_at timestamptz, original_order_line_id text, original_order_id text, product_id text,
               return_base_quantity numeric, return_gmv_amount numeric, original_completed_at timestamptz, original_order_type text,
               original_order_status text, original_seller_email text, original_pos_code text, original_base_quantity numeric,
               original_gmv_amount numeric, original_quantity_src text, original_uom_src text, original_quantity_src_flag text,
               original_uom_src_flag text, source_updated_at timestamptz, row_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.return_event_id, r.return_status, public.cms__return_status_effect(r.return_status), r.return_document_id, r.return_code,
         r.recorded_at, r.original_order_line_id, r.original_order_id, r.product_id, r.return_base_quantity, r.return_gmv_amount,
         r.original_completed_at, r.original_order_type, r.original_order_status, r.original_seller_email, r.original_pos_code,
         r.original_base_quantity, r.original_gmv_amount, r.original_quantity_src, r.original_uom_src, r.original_quantity_src_flag,
         r.original_uom_src_flag, r.source_updated_at,
         encode(sha256(convert_to(
              COALESCE(octet_length(r.return_event_id) || ':' || r.return_event_id, '-')
           || COALESCE(octet_length(r.return_status) || ':' || r.return_status, '-')
           || COALESCE(octet_length(r.return_document_id) || ':' || r.return_document_id, '-')
           || COALESCE(octet_length(r.return_code) || ':' || r.return_code, '-')
           || COALESCE(octet_length(n.rec) || ':' || n.rec, '-')
           || COALESCE(octet_length(r.original_order_line_id) || ':' || r.original_order_line_id, '-')
           || COALESCE(octet_length(r.original_order_id) || ':' || r.original_order_id, '-')
           || COALESCE(octet_length(r.product_id) || ':' || r.product_id, '-')
           || COALESCE(octet_length(n.rb) || ':' || n.rb, '-')
           || COALESCE(octet_length(n.rg) || ':' || n.rg, '-')
           || COALESCE(octet_length(n.oc) || ':' || n.oc, '-')
           || COALESCE(octet_length(r.original_order_type) || ':' || r.original_order_type, '-')
           || COALESCE(octet_length(r.original_order_status) || ':' || r.original_order_status, '-')
           || COALESCE(octet_length(r.original_seller_email) || ':' || r.original_seller_email, '-')
           || COALESCE(octet_length(r.original_pos_code) || ':' || r.original_pos_code, '-')
           || COALESCE(octet_length(n.ob) || ':' || n.ob, '-')
           || COALESCE(octet_length(n.og) || ':' || n.og, '-')
           || COALESCE(octet_length(r.original_quantity_src) || ':' || r.original_quantity_src, '-')
           || COALESCE(octet_length(r.original_uom_src) || ':' || r.original_uom_src, '-')
           || COALESCE(octet_length(r.original_quantity_src_flag) || ':' || r.original_quantity_src_flag, '-')
           || COALESCE(octet_length(r.original_uom_src_flag) || ':' || r.original_uom_src_flag, '-')
           || COALESCE(octet_length(n.su) || ':' || n.su, '-'), 'UTF8')), 'hex')
    FROM (SELECT x.return_event_id, x.return_status, x.return_document_id, x.return_code, x.recorded_at::timestamptz AS recorded_at,
                 x.original_order_line_id, x.original_order_id, x.product_id, x.return_base_quantity::numeric AS return_base_quantity,
                 x.return_gmv_amount::numeric AS return_gmv_amount, x.original_completed_at::timestamptz AS original_completed_at,
                 x.original_order_type, x.original_order_status, x.original_seller_email, x.original_pos_code,
                 x.original_base_quantity::numeric AS original_base_quantity, x.original_gmv_amount::numeric AS original_gmv_amount,
                 x.original_quantity_src, x.original_uom_src, x.original_quantity_src_flag, x.original_uom_src_flag,
                 x.source_updated_at::timestamptz AS source_updated_at
            FROM jsonb_to_recordset(p_rows) AS x(return_event_id text, return_status text, return_document_id text, return_code text,
                   recorded_at text, original_order_line_id text, original_order_id text, product_id text, return_base_quantity text,
                   return_gmv_amount text, original_completed_at text, original_order_type text, original_order_status text,
                   original_seller_email text, original_pos_code text, original_base_quantity text, original_gmv_amount text,
                   original_quantity_src text, original_uom_src text, original_quantity_src_flag text, original_uom_src_flag text,
                   source_updated_at text)) r
    CROSS JOIN LATERAL (SELECT trunc(extract(epoch FROM r.recorded_at) * 1000000, 0)::text AS rec,
                               trunc(r.return_base_quantity * 1000000000, 0)::text AS rb,
                               trunc(r.return_gmv_amount * 1000000000, 0)::text AS rg,
                               trunc(extract(epoch FROM r.original_completed_at) * 1000000, 0)::text AS oc,
                               trunc(r.original_base_quantity * 1000000000, 0)::text AS ob,
                               trunc(r.original_gmv_amount * 1000000000, 0)::text AS og,
                               trunc(extract(epoch FROM r.source_updated_at) * 1000000, 0)::text AS su) n
$$;

-- service_role (job sau chốt / server action super đã kiểm quyền ở app; actor tuỳ chọn trong payload). Mã lỗi đầu vào / ngữ cảnh ⇒ RAISE,
-- 0 ghi. Sổ lệch / còn conflict ⇒ {saved:false, code} và CHỈ eval + conflict / observation được ghi. Cùng snapshot (as_of + digest) ⇒
-- trả báo cáo cũ (idempotent).
CREATE FUNCTION public.rpc_cms_return_close_report_save(p_program_id uuid, p_payout_run_id uuid, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  c_ts   CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$';
  c_pid  CONSTANT text := '^[1-9][0-9]{0,18}$';
  c_txt  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,100}$';
  c_t50  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,50}$';
  c_t30  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,30}$';
  c_mail CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]+$';
  c_flag CONSTANT text := '^(NUL|OVERSIZE)$';
  c_dec  CONSTANT text := '^-?[0-9]{1,35}(\.[0-9]{1,9})?$';
  c_rqty CONSTANT text := '^[1-9][0-9]{0,28}$';
  c_rgmv CONSTANT text := '^[0-9]{1,20}(\.[0-9]{1,9})?$';
  c_ref  CONSTANT text := '^[A-Za-z0-9_.:-]{1,255}$';
  c_hex  CONSTANT text := '^[0-9a-f]{64}$';
  c_date CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';
  c_uuid CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_pin    jsonb;
  v_rows   jsonb;
  v_actor  uuid;
  v_n      integer;
  v_prog   public.cms_programs%ROWTYPE;
  v_pay    public.cms_payouts%ROWTYPE;
  v_run    public.cms_sync_runs%ROWTYPE;
  v_ph     text;
  v_dig    text;
  v_asof   timestamptz;
  v_ids    text;
  v_from   timestamptz;
  v_to     timestamptz;
  v_idem   text;
  v_old    uuid;
  v_code   text;
  v_ret    jsonb;
  v_obs    jsonb;
  v_id     uuid;
  v_ev     jsonb;
  v_seq    bigint;
  v_lines  jsonb;
  v_frozen bigint;
  v_recomp bigint;
  v_nlines integer;
  v_nev    integer;
  v_nb0    bigint;
  v_new    bigint;
  v_badrow boolean;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  -- 1. Hình dạng payload (trước mọi khoá). Mọi giá trị phiếu là chuỗi hoặc null; khoá lạ ⇒ từ chối.
  IF COALESCE(p_program_id IS NULL OR p_payout_run_id IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('pin', 'returns', 'actor'))
     OR jsonb_typeof(p_payload -> 'pin') IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload -> 'returns') IS DISTINCT FROM 'array'
     OR (p_payload ? 'actor' AND NOT public.cms__str(p_payload, 'actor', c_uuid)), true) THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  v_pin := p_payload -> 'pin';
  v_rows := p_payload -> 'returns';
  v_n := jsonb_array_length(v_rows);
  v_actor := (p_payload ->> 'actor')::uuid;
  -- Phòng thủ chiều sâu (security-reviewer 14/11 P1-1): actor (đường super) phải là admin — điều kiện cần của super; allowlist super chỉ ở
  -- authz.ts + is_super_admin(), KHÔNG chép thêm. Server action vẫn phải kiểm super bằng phiên trước khi gọi service_role.
  IF v_actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_actor AND u.role = 'admin') THEN
    RAISE EXCEPTION 'CMS_REPORT_ACTOR_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF v_n > 100000 THEN RAISE EXCEPTION 'CMS_REPORT_TOO_LARGE' USING ERRCODE = '22023'; END IF;
  IF COALESCE(EXISTS (SELECT 1 FROM jsonb_object_keys(v_pin) k
                       WHERE k NOT IN ('protocol', 'provider', 'job_id', 'snapshot_id', 'as_of', 'scope', 'returns'))
     OR v_pin ->> 'protocol' IS DISTINCT FROM '@@SOURCE_PIN@@' OR (v_pin ->> 'provider') NOT IN ('bq', 'fixture')
     OR (v_pin ? 'job_id') = (v_pin ? 'snapshot_id')
     OR NOT (public.cms__str(v_pin, 'job_id', c_ref) OR public.cms__str(v_pin, 'snapshot_id', c_ref))
     OR NOT public.cms__str(v_pin, 'as_of', c_ts)
     OR jsonb_typeof(v_pin -> 'scope') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_pin -> 'scope') k WHERE k NOT IN ('from', 'to', 'products_hash'))
     OR NOT public.cms__str(v_pin -> 'scope', 'from', c_date) OR NOT public.cms__str(v_pin -> 'scope', 'to', c_date)
     OR NOT public.cms__str(v_pin -> 'scope', 'products_hash', c_hex)
     OR jsonb_typeof(v_pin -> 'returns') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_pin -> 'returns') k WHERE k NOT IN ('rows', 'digest'))
     OR jsonb_typeof(v_pin -> 'returns' -> 'rows') IS DISTINCT FROM 'number' OR (v_pin -> 'returns' ->> 'rows') !~ '^(0|[1-9][0-9]{0,8})$'
     OR (v_pin -> 'returns' ->> 'rows')::integer <> v_n
     OR NOT public.cms__str(v_pin -> 'returns', 'digest', c_hex), true) THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_PIN' USING ERRCODE = '22023';
  END IF;
  -- Không EXCEPTION handler (cùng luật publish / seal): ngày đúng regex nhưng sai lịch (30/02) ⇒ lỗi cast 22008 trước mọi khoá / ghi.
  PERFORM (v_pin ->> 'as_of')::timestamptz, (v_pin -> 'scope' ->> 'from')::date, (v_pin -> 'scope' ->> 'to')::date;
  -- Phần tử không phải object kiểm RIÊNG trước: `strict $[*].*` trên phần tử không phải object văng lỗi jsonpath thay vì mã.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) e WHERE jsonb_typeof(e) <> 'object') THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_ROW' USING ERRCODE = '22023';
  END IF;
  IF jsonb_path_exists(v_rows, 'strict $[*].* ? (@.type() != "string" && @.type() != "null")')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) e CROSS JOIN LATERAL jsonb_object_keys(e) k
                 WHERE k NOT IN ('return_event_id', 'return_status', 'return_document_id', 'return_code', 'recorded_at',
                                 'original_order_line_id', 'original_order_id', 'product_id', 'return_base_quantity', 'return_gmv_amount',
                                 'original_completed_at', 'original_order_type', 'original_order_status', 'original_seller_email',
                                 'original_pos_code', 'original_base_quantity', 'original_gmv_amount', 'original_quantity_src',
                                 'original_uom_src', 'original_quantity_src_flag', 'original_uom_src_flag', 'source_updated_at'))
     OR (SELECT count(DISTINCT e ->> 'return_event_id') FROM jsonb_array_elements(v_rows) e) <> v_n
     OR EXISTS (
      SELECT 1 FROM jsonb_to_recordset(v_rows) AS x(return_event_id text, return_status text, return_document_id text,
             return_code text, recorded_at text, original_order_line_id text, original_order_id text, product_id text,
             return_base_quantity text, return_gmv_amount text, original_completed_at text, original_order_type text,
             original_order_status text, original_seller_email text, original_pos_code text, original_base_quantity text,
             original_gmv_amount text, original_quantity_src text, original_uom_src text, original_quantity_src_flag text,
             original_uom_src_flag text, source_updated_at text)
       WHERE NOT (COALESCE(x.return_event_id ~ c_txt AND x.return_status ~ c_t30, false)
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
                  AND (x.source_updated_at IS NULL OR x.source_updated_at ~ c_ts))) THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_ROW' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(v_rows) AS x(return_status text) WHERE public.cms__return_status_effect(x.return_status) IS NULL) THEN
    RAISE EXCEPTION 'CMS_RETURN_STATUS_UNKNOWN' USING ERRCODE = '22023';
  END IF;
  -- Dạng theo hiệu lực = CHECK cms_return_lines: chưa hiệu lực ⇒ chỉ ID + trạng thái; hiệu lực ⇒ đủ trường tài chính / lineage / ngữ cảnh.
  -- CÙNG lần đọc cms__report_rows tính digest phiếu (so pin ở bước 3, sau khoá). Bench 14/11: mỗi lần đọc ~0,6 s / 20.000 phiếu
  -- (ép kiểu + sha256 từng dòng) — cả RPC chỉ đọc 2 lần (đây + bước 5), không đọc lại ở bước 3 / 6.
  SELECT COALESCE(bool_or(NOT COALESCE(
                (p.status_effect = 'NOT_EFFECTIVE' AND p.return_document_id IS NULL AND p.return_code IS NULL AND p.recorded_at IS NULL
                   AND p.original_order_line_id IS NULL AND p.original_order_id IS NULL AND p.product_id IS NULL
                   AND p.return_base_quantity IS NULL AND p.return_gmv_amount IS NULL AND p.original_completed_at IS NULL
                   AND p.original_order_type IS NULL AND p.original_order_status IS NULL AND p.original_seller_email IS NULL
                   AND p.original_pos_code IS NULL AND p.original_base_quantity IS NULL AND p.original_gmv_amount IS NULL
                   AND p.original_quantity_src IS NULL AND p.original_uom_src IS NULL AND p.original_quantity_src_flag IS NULL
                   AND p.original_uom_src_flag IS NULL AND p.source_updated_at IS NULL)
                OR (p.status_effect = 'EFFECTIVE' AND p.return_document_id IS NOT NULL AND p.recorded_at IS NOT NULL
                    AND p.original_order_line_id IS NOT NULL AND p.original_order_id IS NOT NULL AND p.product_id IS NOT NULL
                    AND p.return_base_quantity IS NOT NULL AND p.return_gmv_amount IS NOT NULL AND p.original_completed_at IS NOT NULL
                    AND p.original_order_type IS NOT NULL AND p.original_order_status IS NOT NULL
                    AND p.original_base_quantity IS NOT NULL AND p.original_gmv_amount IS NOT NULL
                    AND (p.original_quantity_src_flag IS NULL OR p.original_quantity_src IS NULL)
                    AND (p.original_uom_src_flag IS NULL OR p.original_uom_src IS NULL)), false)), false),
         encode(sha256(convert_to('@@SRC_DIGEST@@' || E'\n' || 'returns' || E'\n' || count(*)::text || E'\n'
                                  || COALESCE(string_agg(p.row_hash, E'\n' ORDER BY p.return_event_id COLLATE "C"), ''), 'UTF8')), 'hex')
    INTO v_badrow, v_dig
    FROM public.cms__report_rows(v_rows) p;
  IF v_badrow THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_ROW' USING ERRCODE = '22023';
  END IF;

  -- 2. Khoá chương trình (cùng thứ tự publish / confirm / chốt) → payout → run chốt.
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_prog.status IS DISTINCT FROM 'locked' THEN RAISE EXCEPTION 'CMS_REPORT_NOT_LOCKED' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_pay FROM public.cms_payouts WHERE program_id = p_program_id;
  IF NOT FOUND OR v_pay.run_id IS DISTINCT FROM p_payout_run_id THEN
    RAISE EXCEPTION 'CMS_REPORT_PAYOUT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_payout_run_id;
  IF v_run.calc_contract_version IS NOT NULL THEN RAISE EXCEPTION 'CMS_REPORT_CONTRACT_UNSUPPORTED' USING ERRCODE = 'P0001'; END IF;
  IF v_pin ->> 'provider' = 'fixture' AND NOT v_prog.is_test THEN RAISE EXCEPTION 'CMS_REPORT_PIN_PROVIDER' USING ERRCODE = 'P0001'; END IF;
  -- 3. Pin = chương trình (kỳ + tập SP); digest phiếu DB tự tính = pin; as_of không ở tương lai.
  SELECT encode(sha256(convert_to('@@SRC_DIGEST@@' || E'\n' || 'products' || E'\n' || count(*)::text || E'\n'
                                  || COALESCE(string_agg(pp.product_id, E'\n' ORDER BY pp.product_id COLLATE "C"), ''), 'UTF8')), 'hex')
    INTO v_ph FROM public.cms_program_products pp WHERE pp.program_id = p_program_id;
  v_asof := (v_pin ->> 'as_of')::timestamptz;
  IF (v_pin -> 'scope' ->> 'from')::date IS DISTINCT FROM v_prog.start_date OR (v_pin -> 'scope' ->> 'to')::date IS DISTINCT FROM v_prog.end_date
     OR v_ph IS DISTINCT FROM v_pin -> 'scope' ->> 'products_hash' THEN
    RAISE EXCEPTION 'CMS_REPORT_PIN_SCOPE' USING ERRCODE = 'P0001';
  END IF;
  IF v_dig IS DISTINCT FROM v_pin -> 'returns' ->> 'digest' THEN RAISE EXCEPTION 'CMS_REPORT_PIN_DIGEST' USING ERRCODE = 'P0001'; END IF;
  IF v_asof > now() + interval '5 minutes' THEN RAISE EXCEPTION 'CMS_REPORT_BAD_PIN' USING ERRCODE = '22023'; END IF;
  -- 4. Idempotency sau khoá: cùng chương trình / run chốt / as_of / digest / version ⇒ báo cáo cũ.
  v_idem := encode(sha256(convert_to(concat_ws(E'\n', 'cms-close-report-v1', p_program_id::text, p_payout_run_id::text,
                                               public.cms__ts(v_asof), v_dig, '@@CALC_CONTRACT@@', '@@FP_VERSION@@', '@@STATUS_VERSION@@'),
                                     'UTF8')), 'hex');
  SELECT id INTO v_old FROM public.cms_return_close_reports WHERE idem_key = v_idem;
  IF FOUND THEN RETURN jsonb_build_object('saved', true, 'already', true, 'report_id', v_old); END IF;
  -- Snapshot quá cũ ⇒ không đánh giá (db-reviewer 14/11 P1-1: lượt bị RAISE không để vết ⇒ giới hạn cửa sổ phát lại; 36 giờ = mặc định
  -- Dev như seal N2). Sau idem: phát lại đúng snapshot đã lưu vẫn trả báo cáo cũ.
  IF v_asof < now() - interval '36 hours' THEN RAISE EXCEPTION 'CMS_REPORT_AS_OF_STALE' USING ERRCODE = 'P0001'; END IF;

  -- 5. Suy từ dòng bán ĐÃ ĐÓNG BĂNG của run chốt (đóng băng bởi trigger cms_frozen_*): disposition / người / SP; ngữ cảnh gốc phải khớp
  --    (run legacy pos_base: không so q / u); mốc ghi nhận; Σ trả / dòng gốc ≤ b / g. Sai ⇒ RAISE, 0 ghi.
  v_from := (v_prog.start_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
  v_to   := ((v_prog.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
  --    Kế hoạch không phụ thuộc thống kê (bench 14/11 — run / chương trình mới chưa có trong thống kê ⇒ planner ước 1 dòng, chọn Nested
  --    Loop + Materialize ⇒ bậc hai 20.000 × 20.000): MỌI tra bảng từ tập phiếu là probe khoá chính TỪNG dòng — LATERAL … LIMIT 1 (dòng
  --    bán, PK (run_id, order_line_id)) và truy vấn con vô hướng (baseline, PK (program_id, return_event_id)); không viết lại thành
  --    JOIN / EXISTS (planner được kéo lên thành join). p0 = MỘT lần đọc cms__report_rows; fp tính MỘT lần cho phiếu hiệu lực, dùng
  --    chung cho sự kiện báo cáo (bước 8) và quan sát sổ (bước 6); led = phiếu đã có baseline (dưới khoá chương trình — baseline chỉ
  --    ghi dưới khoá này).
  WITH p0 AS MATERIALIZED (
    SELECT x.*,
           CASE WHEN x.status_effect = 'EFFECTIVE' THEN public.cms__return_fp('@@FP_VERSION@@', p_program_id, x.return_event_id,
                  x.return_document_id, x.original_order_line_id, x.original_order_id, x.product_id, x.return_base_quantity,
                  x.return_gmv_amount, x.recorded_at) END AS fp,
           (SELECT true FROM public.cms_return_baselines b
             WHERE b.program_id = p_program_id AND b.return_event_id = x.return_event_id) IS NOT NULL AS led
      FROM public.cms__report_rows(v_rows) x
  ), d AS (
    SELECT p.*, sl.order_line_id AS sl_id, sl.disposition AS sale_disp, sl.user_id AS sl_user, sl.program_product_id AS sl_pp,
           sl.base_quantity AS sb, sl.gmv_amount AS sg,
           EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = p_program_id AND pp.product_id = p.product_id) AS in_prog,
           COALESCE(sl.order_line_id IS NOT NULL AND (
             (sl.order_id, sl.product_id, sl.completed_at, sl.seller_email, sl.pos_code, sl.base_quantity, sl.gmv_amount)
             IS DISTINCT FROM
             (p.original_order_id, p.product_id, p.original_completed_at, p.original_seller_email, p.original_pos_code,
              p.original_base_quantity, p.original_gmv_amount)
             OR NOT (p.original_order_type = 'OFFLINE' AND p.original_order_status = 'COMPLETED')), false) AS ctx_bad
      FROM p0 p
      LEFT JOIN LATERAL (SELECT s.order_line_id, s.disposition, s.user_id, s.program_product_id, s.base_quantity, s.gmv_amount,
                                s.order_id, s.product_id, s.completed_at, s.seller_email, s.pos_code
                           FROM public.cms_sales_lines s
                          WHERE s.run_id = p_payout_run_id AND s.order_line_id = p.original_order_line_id LIMIT 1) sl ON true
     WHERE p.status_effect = 'EFFECTIVE'
  ), e AS (
    SELECT d.*,
           CASE WHEN d.ctx_bad THEN NULL
                WHEN NOT (d.original_order_type = 'OFFLINE' AND d.original_order_status = 'COMPLETED') THEN 'ORIGIN_NOT_ELIGIBLE'
                WHEN d.original_completed_at < v_from OR d.original_completed_at >= v_to THEN 'ORIGIN_OUT_OF_WINDOW'
                WHEN NOT d.in_prog THEN 'ORIGIN_NOT_IN_PROGRAM'
                WHEN d.sl_id IS NULL THEN NULL
                WHEN d.sale_disp = 'UNASSIGNED' THEN 'ORIGIN_UNASSIGNED'
                WHEN d.sale_disp = 'OUT_OF_SCOPE' THEN 'ORIGIN_OUT_OF_SCOPE'
                WHEN d.sale_disp = 'INCLUDED' THEN 'APPLIED' END AS disp
      FROM d
  ), acc AS (
    SELECT e.original_order_line_id AS id, max(e.sb) AS sb, max(e.sg) AS sg, sum(e.return_base_quantity) AS rb, sum(e.return_gmv_amount) AS rg
      FROM e WHERE e.disp IN ('APPLIED', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE') GROUP BY e.original_order_line_id
  ), h AS (
    SELECT 'AFTER_AS_OF' AS code, e.return_event_id AS ref FROM e WHERE e.recorded_at > v_asof
    UNION ALL SELECT 'BEFORE_SALE', e.return_event_id FROM e WHERE e.recorded_at < e.original_completed_at
    UNION ALL SELECT 'CONTEXT_MISMATCH', e.return_event_id FROM e WHERE e.ctx_bad
    UNION ALL SELECT 'ORIGIN_MISSING', e.return_event_id FROM e WHERE NOT e.ctx_bad AND e.disp IS NULL
    UNION ALL SELECT 'EXCEEDS_SALE_BASE', acc.id FROM acc WHERE acc.rb > acc.sb
    UNION ALL SELECT 'EXCEEDS_SALE_GMV', acc.id FROM acc WHERE acc.rg > acc.sg
  ), hc AS (
    SELECT min(h.code) AS code FROM h
  )
  SELECT (SELECT hc.code FROM hc),
         (SELECT string_agg(z.ref, ',' ORDER BY z.ref COLLATE "C")
            FROM (SELECT h.ref FROM h JOIN hc ON hc.code = h.code ORDER BY h.ref COLLATE "C" LIMIT 20) z),
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.return_event_id, 'disp', e.disp,
                     'user_id', CASE WHEN e.disp = 'APPLIED' THEN e.sl_user END,
                     'ppid', CASE WHEN e.disp = 'APPLIED' THEN e.sl_pp END,
                     'line', e.original_order_line_id, 'base', e.return_base_quantity, 'refund', e.return_gmv_amount,
                     'recorded_at', public.cms__ts(e.recorded_at), 'fp', e.fp, 'led', e.led,
                     'doc', e.return_document_id, 'order_id', e.original_order_id, 'product_id', e.product_id))
                    FROM e), '[]'::jsonb),
         -- Quan sát bước 6: mọi phiếu (cả chưa hiệu lực) đã có baseline.
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'id', p.return_event_id, 'status', p.return_status, 'effect', p.status_effect, 'fp', p.fp,
                     'base', p.return_base_quantity::text, 'refund', p.return_gmv_amount::text,
                     'recorded_at', CASE WHEN p.recorded_at IS NOT NULL THEN public.cms__ts(p.recorded_at) END))
                    FROM p0 p WHERE p.led), '[]'::jsonb)
    INTO v_code, v_ids, v_ret, v_obs;
  -- Mã + tối đa 20 ID phiếu / dòng gốc (không PII) ở DETAIL để job ghi vết (db-reviewer 14/11 P2-5); 0 ghi.
  IF v_code IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'CMS_REPORT_' || v_code, DETAIL = 'refs: ' || COALESCE(v_ids, ''), ERRCODE = 'P0001';
  END IF;

  -- 6. Kiểm sổ = eval kind report dưới khoá (mọi baseline của chương trình đối chiếu snapshot này).
  --    Quan sát v_obs đã tính ở bước 5 (probe baseline dưới CÙNG khoá chương trình, chưa có ghi nào xen giữa).
  v_id := gen_random_uuid();
  v_ev := public.cms__ledger_eval(p_program_id, 'report', v_id, v_asof, v_dig, v_obs);
  IF v_ev ? 'code' THEN
    RETURN jsonb_build_object('saved', false, 'code', v_ev ->> 'code');
  END IF;
  IF v_ev ->> 'verdict' <> 'CLEAN' THEN
    RETURN jsonb_build_object('saved', false,
                              'code', CASE v_ev ->> 'verdict' WHEN 'MISMATCH' THEN 'CMS_REPORT_LEDGER_CONFLICT' ELSE 'CMS_REPORT_CONFLICT_OPEN' END,
                              'ledger', v_ev);
  END IF;
  v_seq := (v_ev ->> 'eval_seq')::bigint;

  -- 7. Tính lại từng nhóm của run chốt: B đủ = B chốt − Σ trả APPLIED (pos_base); GMV ròng = GMV chốt − Σ hoàn; gate SP theo GMV gate
  --    ròng, gate danh mục theo GMV danh mục ròng của dược sĩ, không gate ⇒ đạt; Q = floor(max(B đủ, 0) / K); tiền = gate ? F(Q) : 0
  --    theo thang ĐÃ ĐÓNG BĂNG (guard locked) — F trên Q chưa trần như 122 bước 7 (bậc cuối có trần nằm trong LEAST); số hiển thị
  --    recomputed_qty = Q sau trần (cùng nghĩa rewarded_quantity).
  WITH ev AS (
    SELECT * FROM jsonb_to_recordset(v_ret) AS x(id text, disp text, user_id uuid, ppid uuid, base numeric, refund numeric)
  ), ap AS (
    SELECT ev.user_id, ev.ppid, sum(ev.base) AS rb, sum(ev.refund) AS rg, count(*)::integer AS n
      FROM ev WHERE ev.disp = 'APPLIED' GROUP BY ev.user_id, ev.ppid
  ), r AS (
    SELECT r.*, COALESCE(ap.rb, 0) AS rb, COALESCE(ap.rg, 0) AS rg, COALESCE(ap.n, 0) AS rn
      FROM public.cms_results r
      LEFT JOIN ap ON ap.user_id = r.user_id AND ap.ppid = r.program_product_id
     WHERE r.run_id = p_payout_run_id
  ), cat AS (
    SELECT r.user_id, sum(r.rg) AS crg FROM r WHERE r.gmv_basis = 'catalog' GROUP BY r.user_id
  ), g AS (
    SELECT r.*, r.base_quantity - r.rb AS elig, r.gmv_amount - r.rg AS net_gmv,
           CASE r.gmv_basis WHEN 'none' THEN true
                            WHEN 'product' THEN COALESCE(r.gate_gmv - r.rg >= r.target_gmv, false)
                            ELSE COALESCE(k.catalog_gmv - COALESCE(cat.crg, 0) >= k.target_gmv, false) END AS met,
           GREATEST(floor((r.base_quantity - r.rb) / r.per_unit), 0)::bigint AS qn
      FROM r
      LEFT JOIN public.cms_result_catalog k ON k.run_id = r.run_id AND k.user_id = r.user_id
      LEFT JOIN cat ON cat.user_id = r.user_id
  ), gq AS (
    SELECT g.*, CASE WHEN g.cap_quantity IS NOT NULL AND g.qn > g.cap_quantity THEN g.cap_quantity ELSE g.qn END AS rq FROM g
  ), tc AS (
    SELECT t.program_product_id, t.tier_order,
           COALESCE(sum((t.qty_to - t.qty_from + 1)::numeric * t.amount_per_unit) OVER (PARTITION BY t.program_product_id
                    ORDER BY t.tier_order ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_before
      FROM public.cms_program_tiers t WHERE t.program_id = p_program_id
  ), fq AS (
    SELECT gq.*, CASE WHEN gq.qn <= 0 OR x.tier_order IS NULL THEN 0
                      ELSE tc.cum_before + (LEAST(gq.qn::numeric, COALESCE(x.qty_to, gq.qn)::numeric) - x.qty_from + 1) * x.amount_per_unit
                 END AS f
      FROM gq
      LEFT JOIN LATERAL (SELECT t.tier_order, t.qty_from, t.qty_to, t.amount_per_unit FROM public.cms_program_tiers t
                          WHERE t.program_product_id = gq.program_product_id AND t.qty_from <= gq.qn
                          ORDER BY t.qty_from DESC LIMIT 1) x ON true
      LEFT JOIN tc ON tc.program_product_id = gq.program_product_id AND tc.tier_order = x.tier_order
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'line_no', q.line_no, 'user_id', q.user_id, 'program_product_id', q.program_product_id, 'product_id', q.product_id,
           'gmv_basis', q.gmv_basis, 'per_unit', q.per_unit, 'frozen_base', q.base_quantity, 'frozen_qty', q.rewarded_quantity,
           'frozen_gmv', q.gmv_amount, 'frozen_gate_met', q.gate_met, 'frozen_amount', q.amount_vnd, 'return_base', q.rb,
           'return_gmv', q.rg, 'return_events', q.rn, 'eligible_base', q.elig, 'net_gmv', q.net_gmv, 'gate_met', q.met,
           'recomputed_qty', q.rq, 'recomputed_amount', q.ra, 'delta', q.ra - q.amount_vnd)), '[]'::jsonb),
         COALESCE(sum(q.amount_vnd), 0)::bigint, COALESCE(sum(q.ra), 0)::bigint, count(*)::integer
    INTO v_lines, v_frozen, v_recomp, v_nlines
    FROM (SELECT fq.*, (row_number() OVER (ORDER BY fq.user_id, fq.product_id, fq.program_product_id) - 1)::integer AS line_no,
                 (CASE WHEN fq.met THEN fq.f ELSE 0 END)::bigint AS ra
            FROM fq) q;
  IF v_frozen IS DISTINCT FROM v_pay.amount_vnd THEN RAISE EXCEPTION 'CMS_REPORT_FROZEN_MISMATCH' USING ERRCODE = 'P0001'; END IF;
  v_nev := jsonb_array_length(v_ret);

  -- 8. Ghi atomic (không EXCEPTION handler): header → dòng → sự kiện → baseline mới (accepted_report_id) → hậu kiểm.
  SELECT count(*) INTO v_nb0 FROM public.cms_return_baselines WHERE program_id = p_program_id;
  INSERT INTO public.cms_return_close_reports (id, program_id, payout_run_id, eval_seq, calc_contract_version, fp_version,
    status_dictionary_version, source_pin, returns_as_of, returns_digest, frozen_amount, recomputed_amount, delta_amount, return_events,
    line_count, idem_key, created_via, created_by)
  VALUES (v_id, p_program_id, p_payout_run_id, v_seq, '@@CALC_CONTRACT@@', '@@FP_VERSION@@', '@@STATUS_VERSION@@', v_pin, v_asof, v_dig,
          v_frozen, v_recomp, v_recomp - v_frozen, v_nev, v_nlines, v_idem, CASE WHEN v_actor IS NULL THEN 'cron' ELSE 'super' END, v_actor);
  INSERT INTO public.cms_return_close_report_lines (report_id, program_id, line_no, user_id, program_product_id, product_id, gmv_basis,
    per_unit, frozen_base, frozen_qty, frozen_gmv, frozen_gate_met, frozen_amount, return_base, return_gmv, return_events, eligible_base,
    net_gmv, gate_met, recomputed_qty, recomputed_amount, delta)
  SELECT v_id, p_program_id, x.line_no, x.user_id, x.program_product_id, x.product_id, x.gmv_basis, x.per_unit, x.frozen_base, x.frozen_qty,
         x.frozen_gmv, x.frozen_gate_met, x.frozen_amount, x.return_base, x.return_gmv, x.return_events, x.eligible_base, x.net_gmv,
         x.gate_met, x.recomputed_qty, x.recomputed_amount, x.delta
    FROM jsonb_to_recordset(v_lines) AS x(line_no integer, user_id uuid, program_product_id uuid, product_id text, gmv_basis text,
           per_unit numeric, frozen_base numeric, frozen_qty bigint, frozen_gmv numeric, frozen_gate_met boolean, frozen_amount bigint,
           return_base numeric, return_gmv numeric, return_events integer, eligible_base numeric, net_gmv numeric, gate_met boolean,
           recomputed_qty bigint, recomputed_amount bigint, delta bigint);
  INSERT INTO public.cms_return_close_report_events (report_id, program_id, return_event_id, financial_fp, original_order_line_id,
    disposition, user_id, program_product_id, base, refund, recorded_at)
  SELECT v_id, p_program_id, x.id, x.fp, x.line, x.disp, x.user_id, x.ppid, x.base, x.refund, x.recorded_at::timestamptz
    FROM jsonb_to_recordset(v_ret) AS x(id text, fp text, line text, disp text, user_id uuid, ppid uuid, base numeric, refund numeric,
                                        recorded_at text);
  INSERT INTO public.cms_return_baselines (program_id, return_event_id, fp_version, financial_fp, return_document_id,
    original_order_line_id, original_order_id, product_id, base_quantity, refund_amount, recorded_at, accepted_eval_seq, accepted_report_id)
  SELECT p_program_id, x.id, '@@FP_VERSION@@', x.fp, x.doc, x.line, x.order_id, x.product_id, x.base, x.refund, x.recorded_at::timestamptz,
         v_seq, v_id
    FROM jsonb_to_recordset(v_ret) AS x(id text, fp text, doc text, line text, order_id text, product_id text, disp text, base numeric,
                                        refund numeric, recorded_at text, led boolean)
   -- led = probe PK ở bước 5 (không anti-join: bench 14/11 Nested Loop Anti Join + Materialize = 199.990.000 so sánh, 15,6 s); lệch
   -- (không thể dưới khoá) ⇒ vi phạm PK ⇒ rollback cả lượt.
   WHERE x.disp IN ('APPLIED', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE') AND NOT x.led;
  GET DIAGNOSTICS v_new = ROW_COUNT;
  IF (SELECT count(*) FROM public.cms_return_baselines WHERE program_id = p_program_id) IS DISTINCT FROM v_nb0 + v_new
     OR (SELECT count(*) FROM public.cms_return_close_report_lines WHERE report_id = v_id) IS DISTINCT FROM v_nlines::bigint
     OR (SELECT COALESCE(sum(l.frozen_amount), 0) FROM public.cms_return_close_report_lines l WHERE l.report_id = v_id)
          IS DISTINCT FROM v_pay.amount_vnd::numeric
     OR (SELECT count(*) FROM public.cms_return_close_report_events WHERE report_id = v_id) IS DISTINCT FROM v_nev::bigint
     OR EXISTS (SELECT 1 FROM public.cms_return_conflicts c WHERE c.program_id = p_program_id
                   AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id))
     -- Trả hàng chỉ làm giảm B / GMV; F và gate đơn điệu ⇒ không dòng nào tăng; không phiếu APPLIED ⇒ tính lại = số chốt (bắt lệch công
     -- thức so với 122 nếu sau này sửa một bên — db-reviewer 14/11 P2-4).
     OR EXISTS (SELECT 1 FROM public.cms_return_close_report_lines l WHERE l.report_id = v_id AND l.delta > 0)
     OR (NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v_ret) AS x(disp text) WHERE x.disp = 'APPLIED') AND v_recomp IS DISTINCT FROM v_frozen)
     OR v_seq IS DISTINCT FROM (SELECT max(e.eval_seq) FROM public.cms_return_ledger_evals e WHERE e.program_id = p_program_id) THEN
    RAISE EXCEPTION 'CMS_REPORT_ASSERT' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('saved', true, 'already', false, 'report_id', v_id, 'eval_seq', v_seq, 'frozen_amount', v_frozen::text,
                            'recomputed_amount', v_recomp::text, 'delta_amount', (v_recomp - v_frozen)::text, 'return_events', v_nev,
                            'line_count', v_nlines, 'baselines_new', v_new);
END;
$$;

-- Dòng bán đã đóng băng của run chốt (service_role — job sau chốt tính oracle đối chiếu ở app; DB không nhận số app). Chỉ chương trình
-- đã chốt. Keyset theo seq.
CREATE FUNCTION public.rpc_cms_frozen_sales_lines(p_program_id uuid, p_after_seq integer, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog public.cms_programs%ROWTYPE;
  v_pay  public.cms_payouts%ROWTYPE;
  v_rows jsonb;
  v_next integer;
BEGIN
  IF p_program_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 OR (p_after_seq IS NOT NULL AND p_after_seq < 0) THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id;
  SELECT * INTO v_pay FROM public.cms_payouts WHERE program_id = p_program_id;
  IF v_prog.status IS DISTINCT FROM 'locked' OR v_pay.run_id IS NULL THEN
    RAISE EXCEPTION 'CMS_REPORT_NOT_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'seq', q.seq, 'order_line_id', q.order_line_id, 'order_id', q.order_id, 'order_code', q.order_code, 'product_id', q.product_id,
      'program_product_id', q.program_product_id, 'seller_email', q.seller_email, 'user_id', q.user_id, 'store_id', q.store_id,
      'pos_code', q.pos_code, 'completed_at', public.cms__ts(q.completed_at), 'source_updated_at', public.cms__ts(q.source_updated_at),
      'quantity_raw', q.quantity_raw, 'uom_raw', q.uom_raw, 'base_quantity', q.base_quantity::text, 'gmv_amount', q.gmv_amount::text,
      'disposition', q.disposition, 'unassigned_reason', q.unassigned_reason) ORDER BY q.seq), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT * FROM public.cms_sales_lines sl WHERE sl.run_id = v_pay.run_id AND sl.seq > COALESCE(p_after_seq, -1)
           ORDER BY sl.seq LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'seq')::integer;
  END IF;
  RETURN jsonb_build_object('program_id', p_program_id, 'payout_run_id', v_pay.run_id, 'payout_amount_vnd', v_pay.amount_vnd::text,
                            'contract', public.cms__run_contract(v_pay.run_id), 'rows', v_rows, 'next_after_seq', v_next);
END;
$$;

-- Reader báo cáo (authenticated: super + chương trình đọc được — QA cần marker).
CREATE FUNCTION public.rpc_cms_return_close_reports(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin() OR NOT COALESCE(p_program_id = ANY (public.cms_readable_program_ids()), false) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('program_id', p_program_id, 'reports', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', r.id, 'payout_run_id', r.payout_run_id, 'eval_seq', r.eval_seq,
                                        'returns_as_of', public.cms__ts(r.returns_as_of), 'frozen_amount', r.frozen_amount::text,
                                        'recomputed_amount', r.recomputed_amount::text, 'delta_amount', r.delta_amount::text,
                                        'return_events', r.return_events, 'line_count', r.line_count, 'created_via', r.created_via,
                                        'created_at', public.cms__ts(r.created_at)) ORDER BY r.eval_seq DESC)
      FROM public.cms_return_close_reports r WHERE r.program_id = p_program_id), '[]'::jsonb));
END;
$$;

CREATE FUNCTION public.rpc_cms_return_close_report(p_report_id uuid, p_after integer, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r    public.cms_return_close_reports%ROWTYPE;
  v_rows jsonb;
  v_next integer;
BEGIN
  IF p_report_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 OR (p_after IS NOT NULL AND p_after < 0) THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_r FROM public.cms_return_close_reports WHERE id = p_report_id;
  IF NOT FOUND OR NOT COALESCE(v_r.program_id = ANY (public.cms_readable_program_ids()), false) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'line_no', q.line_no, 'user_id', q.user_id, 'program_product_id', q.program_product_id, 'product_id', q.product_id,
      'gmv_basis', q.gmv_basis, 'per_unit', q.per_unit::text, 'frozen_base', q.frozen_base::text, 'frozen_qty', q.frozen_qty::text,
      'frozen_gmv', q.frozen_gmv::text, 'frozen_gate_met', q.frozen_gate_met, 'frozen_amount', q.frozen_amount::text,
      'return_base', q.return_base::text, 'return_gmv', q.return_gmv::text, 'return_events', q.return_events,
      'eligible_base', q.eligible_base::text, 'net_gmv', q.net_gmv::text, 'gate_met', q.gate_met,
      'recomputed_qty', q.recomputed_qty::text, 'recomputed_amount', q.recomputed_amount::text, 'delta', q.delta::text,
      'full_name', (SELECT u.full_name FROM public.users u WHERE u.id = q.user_id)) ORDER BY q.line_no), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT * FROM public.cms_return_close_report_lines l WHERE l.report_id = p_report_id AND l.line_no > COALESCE(p_after, -1)
           ORDER BY l.line_no LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'line_no')::integer;
  END IF;
  RETURN jsonb_build_object(
    'report', jsonb_build_object('id', v_r.id, 'program_id', v_r.program_id, 'payout_run_id', v_r.payout_run_id, 'eval_seq', v_r.eval_seq,
      'source_pin', v_r.source_pin, 'returns_as_of', public.cms__ts(v_r.returns_as_of), 'returns_digest', v_r.returns_digest,
      'frozen_amount', v_r.frozen_amount::text, 'recomputed_amount', v_r.recomputed_amount::text, 'delta_amount', v_r.delta_amount::text,
      'return_events', v_r.return_events, 'line_count', v_r.line_count, 'created_via', v_r.created_via,
      'created_at', public.cms__ts(v_r.created_at), 'not_a_payment_order', true),
    'lines', v_rows, 'next_after', v_next);
END;
$$;

-- Sự kiện báo cáo — keyset theo return_event_id byte (COLLATE "C", index cms_return_close_report_events_key_idx), không cắt ở 1.000
-- (db-reviewer 14/11 P2-6). Cùng quyền reader báo cáo.
CREATE FUNCTION public.rpc_cms_return_close_report_events(p_report_id uuid, p_after text, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r    public.cms_return_close_reports%ROWTYPE;
  v_rows jsonb;
  v_next text;
BEGIN
  IF p_report_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000
     OR (p_after IS NOT NULL AND p_after !~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$') THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_r FROM public.cms_return_close_reports WHERE id = p_report_id;
  IF NOT FOUND OR NOT COALESCE(v_r.program_id = ANY (public.cms_readable_program_ids()), false) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('return_event_id', q.return_event_id, 'original_order_line_id', q.original_order_line_id,
                                              'disposition', q.disposition, 'user_id', q.user_id, 'program_product_id', q.program_product_id,
                                              'base', q.base::text, 'refund', q.refund::text, 'recorded_at', public.cms__ts(q.recorded_at))
                            ORDER BY q.k), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT x.*, x.return_event_id COLLATE "C" AS k FROM public.cms_return_close_report_events x
           WHERE x.report_id = p_report_id AND (p_after IS NULL OR x.return_event_id COLLATE "C" > p_after COLLATE "C")
           ORDER BY x.return_event_id COLLATE "C" LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := v_rows -> (p_limit - 1) ->> 'return_event_id';
  END IF;
  RETURN jsonb_build_object('report_id', p_report_id, 'return_events', v_r.return_events, 'events', v_rows, 'next_after', v_next);
END;
$$;
