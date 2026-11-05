
-- ── 3. Bảng chứng nhận ──────────────────────────────────────────────────────
-- Một chứng nhận CÒN HIỆU LỰC / run (không thu hồi, không bị thay); lịch sử thay thế / thu hồi giữ nguyên. Mọi ràng buộc dạng /
-- miền / FK kép chương trình–run ở DB. Không ai ghi trực tiếp: chỉ RPC SECDEF (owner) — non-owner không có quyền bảng.
CREATE TABLE public.cms_source_attestations (
  id                    uuid        PRIMARY KEY,
  program_id            uuid        NOT NULL REFERENCES public.cms_programs(id),
  run_id                uuid        NOT NULL,
  config_version        integer     NOT NULL CHECK (config_version >= 1),
  mapping_fp            text        NOT NULL CHECK (mapping_fp ~ '^[0-9a-f]{32}$'),
  basis                 text        NOT NULL CHECK (basis = 'operator_reconciliation'),
  fp_version            text        NOT NULL CHECK (fp_version = 'cms-rows-fp-v1'),
  -- PM COMP-P1-1: bằng chứng chốt CHỈ decision10 (audit14 không ràng buộc trường quyết định ⇒ không làm chứng nhận).
  field_set             text        NOT NULL CHECK (field_set = 'decision10'),
  scope_from            date        NOT NULL,
  scope_to              date        NOT NULL CHECK (scope_to >= scope_from),
  scope_hash            text        NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  run_rows_fp           text        NOT NULL CHECK (run_rows_fp ~ '^[0-9a-f]{64}$'),
  run_file_sha256       text        NOT NULL CHECK (run_file_sha256 ~ '^[0-9a-f]{64}$'),
  reference_rows_fp     text        NOT NULL CHECK (reference_rows_fp ~ '^[0-9a-f]{64}$'),
  reference_file_sha256 text        NOT NULL CHECK (reference_file_sha256 ~ '^[0-9a-f]{64}$'),
  reference_label       text        NOT NULL CHECK (char_length(reference_label) BETWEEN 3 AND 200 AND reference_label = btrim(reference_label)),
  as_of                 timestamptz NOT NULL CHECK (isfinite(as_of)),
  reference_exported_at timestamptz NOT NULL CHECK (isfinite(reference_exported_at)),
  run_exported_at       timestamptz NOT NULL CHECK (isfinite(run_exported_at)),
  lines_compared        integer     NOT NULL CHECK (lines_compared > 0),
  missing_lines         integer     NOT NULL CHECK (missing_lines = 0),
  extra_lines           integer     NOT NULL CHECK (extra_lines = 0),
  changed_lines         integer     NOT NULL CHECK (changed_lines = 0),
  tool_version          text        NOT NULL CHECK (tool_version = 'cms-i4-compare-v1'),
  ack_reason            text        NOT NULL CHECK (char_length(ack_reason) BETWEEN 10 AND 1000 AND ack_reason = btrim(ack_reason, E' \t\r\n\f\v')),
  idem_key              uuid        NOT NULL,
  payload_sha256        text        NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  attested_by           uuid        NOT NULL,
  attested_at           timestamptz NOT NULL DEFAULT now(),
  superseded_by         uuid,
  superseded_at         timestamptz,
  revoked_at            timestamptz,
  revoked_by            uuid,
  revoke_reason         text        CHECK (revoke_reason IS NULL OR (char_length(revoke_reason) BETWEEN 10 AND 1000
                                                                        AND revoke_reason = btrim(revoke_reason, E' \t\r\n\f\v'))),
  revoke_idem_key       uuid,
  CONSTRAINT cms_source_attest_run_fk FOREIGN KEY (run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id),
  CONSTRAINT cms_source_attest_superseded_fk FOREIGN KEY (superseded_by) REFERENCES public.cms_source_attestations(id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT cms_source_attest_idem UNIQUE (idem_key),
  CONSTRAINT cms_source_attest_revoke_idem UNIQUE (revoke_idem_key),
  CONSTRAINT cms_source_attest_supersede CHECK ((superseded_by IS NULL) = (superseded_at IS NULL) AND superseded_by IS DISTINCT FROM id),
  CONSTRAINT cms_source_attest_revoke CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)
                                            AND (revoked_at IS NULL) = (revoke_idem_key IS NULL)),
  CONSTRAINT cms_source_attest_one_end CHECK (superseded_by IS NULL OR revoked_at IS NULL),
  -- Mốc M ≤ lúc xuất cả hai file (PM I4F-P1-1).
  CONSTRAINT cms_source_attest_times CHECK (as_of <= reference_exported_at AND as_of <= run_exported_at),
  -- KHỚP decision10 ⇒ vân tay tham chiếu = vân tay run (cùng định nghĩa, 0 thiếu / thừa / lệch) — vô điều kiện.
  CONSTRAINT cms_source_attest_fp CHECK (reference_rows_fp = run_rows_fp),
  -- Khoá ba cột cho FK payout ⇒ payout chỉ trỏ chứng nhận CỦA ĐÚNG chương trình + run (db-reviewer r2 P2-1).
  CONSTRAINT cms_source_attest_bind UNIQUE (id, program_id, run_id)
);
CREATE UNIQUE INDEX cms_source_attest_one_live ON public.cms_source_attestations (run_id)
  WHERE revoked_at IS NULL AND superseded_by IS NULL;
CREATE INDEX cms_source_attest_program_idx ON public.cms_source_attestations (program_id, attested_at DESC);
ALTER TABLE public.cms_source_attestations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cms_source_attestations FROM PUBLIC, anon, authenticated, service_role;

-- Payout tham chiếu chứng nhận đã dùng (bất biến sau chốt như 123).
ALTER TABLE public.cms_payouts ADD COLUMN source_attestation_id uuid REFERENCES public.cms_source_attestations(id);
ALTER TABLE public.cms_payouts DROP CONSTRAINT cms_payouts_source_complete_basis_check;
ALTER TABLE public.cms_payouts ADD CONSTRAINT cms_payouts_source_complete_basis_check
  CHECK (source_complete_basis IN ('qa_assumption', 'bi_watermark', 'lag_commitment', 'operator_reconciliation'));
ALTER TABLE public.cms_payouts ADD CONSTRAINT cms_payouts_attestation
  CHECK ((source_complete_basis = 'operator_reconciliation') = (source_attestation_id IS NOT NULL));
ALTER TABLE public.cms_payouts ADD CONSTRAINT cms_payouts_attest_bind_fk
  FOREIGN KEY (source_attestation_id, program_id, run_id) REFERENCES public.cms_source_attestations (id, program_id, run_id);

-- ── 4. Guard bất biến chứng nhận ────────────────────────────────────────────
-- INSERT (r1, db-reviewer P2-10): dòng mới phải còn hiệu lực và chương trình CHƯA chốt — khoá FOR SHARE dòng chương trình ⇒ lượt
-- chốt đang giữ FOR UPDATE thì chờ rồi thấy 'locked' (chặn cả owner ghi thẳng). DELETE: luôn từ chối. UPDATE: CHỈ chuyển
-- còn-hiệu-lực ⇒ bị thay (superseded_*) hoặc ⇒ thu hồi (revoked_*), mọi cột khác giữ nguyên, và chỉ khi chương trình CHƯA chốt +
-- chứng nhận chưa được payout dùng. Áp cả owner (ENABLE ALWAYS).
CREATE FUNCTION public.cms__attest_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_st text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.superseded_by IS NOT NULL OR NEW.superseded_at IS NOT NULL THEN
      RAISE EXCEPTION 'CMS_ATTEST_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    SELECT status INTO v_st FROM public.cms_programs WHERE id = NEW.program_id FOR SHARE;
    IF v_st IS NOT DISTINCT FROM 'locked' THEN
      RAISE EXCEPTION 'CMS_ATTEST_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CMS_ATTEST_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  -- Khoá FOR SHARE chương trình TRƯỚC khi đọc trạng thái / payout (db-reviewer r2 P2-2): lượt chốt đang giữ FOR UPDATE ⇒ chờ
  -- rồi thấy 'locked' + payout đã commit (FK payout chỉ giữ KEY SHARE, không chặn UPDATE cột thường).
  SELECT status INTO v_st FROM public.cms_programs WHERE id = OLD.program_id FOR SHARE;
  IF OLD.revoked_at IS NOT NULL OR OLD.superseded_by IS NOT NULL OR v_st IS NOT DISTINCT FROM 'locked'
     OR EXISTS (SELECT 1 FROM public.cms_payouts p WHERE p.source_attestation_id = OLD.id) THEN
    RAISE EXCEPTION 'CMS_ATTEST_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.program_id, NEW.run_id, NEW.config_version, NEW.mapping_fp, NEW.basis, NEW.fp_version, NEW.field_set,
      NEW.scope_from, NEW.scope_to, NEW.scope_hash, NEW.run_rows_fp, NEW.run_file_sha256, NEW.reference_rows_fp,
      NEW.reference_file_sha256, NEW.reference_label, NEW.as_of, NEW.reference_exported_at, NEW.run_exported_at,
      NEW.lines_compared, NEW.missing_lines, NEW.extra_lines, NEW.changed_lines, NEW.tool_version, NEW.ack_reason,
      NEW.idem_key, NEW.payload_sha256, NEW.attested_by, NEW.attested_at)
     IS DISTINCT FROM
     (OLD.id, OLD.program_id, OLD.run_id, OLD.config_version, OLD.mapping_fp, OLD.basis, OLD.fp_version, OLD.field_set,
      OLD.scope_from, OLD.scope_to, OLD.scope_hash, OLD.run_rows_fp, OLD.run_file_sha256, OLD.reference_rows_fp,
      OLD.reference_file_sha256, OLD.reference_label, OLD.as_of, OLD.reference_exported_at, OLD.run_exported_at,
      OLD.lines_compared, OLD.missing_lines, OLD.extra_lines, OLD.changed_lines, OLD.tool_version, OLD.ack_reason,
      OLD.idem_key, OLD.payload_sha256, OLD.attested_by, OLD.attested_at) THEN
    RAISE EXCEPTION 'CMS_ATTEST_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 5. Đánh giá chứng nhận của run (dùng chung preview / chốt / đọc) ─────────
-- Trả {id, scope_to, field_set, code}; code NULL = dùng được. Kiểm LẠI tại thời điểm gọi: config / mapping / scope hiện tại,
-- vân tay dòng tính lại từ lớp nguồn, lớp nguồn khớp lớp engine. Không có chứng nhận hiệu lực ⇒ {code: 'NONE'}.
CREATE FUNCTION public.cms__attest_eval(p_program_id uuid, p_run_id uuid)
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

-- ── 6. RPC (authenticated — phiên super thật) ──────────────────────────────
-- Payload (mọi giá trị chuỗi): fp_version, field_set, scope_from, scope_to, scope_hash, run_rows_fp, run_file_sha256,
-- reference_rows_fp, reference_file_sha256, reference_label, as_of, reference_exported_at, run_exported_at, lines_compared,
-- missing_lines, extra_lines, changed_lines, tool_version, ack_reason. Khoá thừa ⇒ BAD_INPUT. Không actor trong payload.
CREATE FUNCTION public.rpc_cms_source_attest(p_program_id uuid, p_run_id uuid, p_payload jsonb, p_idem uuid)
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

CREATE FUNCTION public.rpc_cms_source_attest_revoke(p_attestation_id uuid, p_reason text, p_idem uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '2s' AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_pid  uuid;
  v_a    public.cms_source_attestations%ROWTYPE;
  v_o    public.cms_source_attestations%ROWTYPE;
  v_prog public.cms_programs%ROWTYPE;
  v_con  text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'CMS_ATTEST_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  IF p_attestation_id IS NULL OR p_idem IS NULL OR p_reason IS NULL
     OR char_length(btrim(p_reason, E' \t\r\n\f\v')) NOT BETWEEN 10 AND 1000 OR p_reason ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]' THEN
    RAISE EXCEPTION 'CMS_ATTEST_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT program_id INTO v_pid FROM public.cms_source_attestations WHERE id = p_attestation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_ATTEST_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- Phạm vi QA như attest (db-reviewer P1-1).
  IF NOT COALESCE(v_pid = ANY (public.cms_readable_program_ids()), false) THEN
    RAISE EXCEPTION 'CMS_ATTEST_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Cùng thứ tự khoá: chương trình → chứng nhận (chốt giữ khoá chương trình tới COMMIT ⇒ thu hồi chờ / thấy 'locked').
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_pid FOR UPDATE;
  SELECT * INTO v_a FROM public.cms_source_attestations WHERE id = p_attestation_id FOR UPDATE;
  -- Idempotency (r1 P2-3): cùng khoá ⇒ chỉ "already" khi cùng chứng nhận + cùng người + cùng lý do; khác ⇒ IDEM_CONFLICT.
  SELECT * INTO v_o FROM public.cms_source_attestations WHERE revoke_idem_key = p_idem;
  IF FOUND THEN
    IF v_o.id = p_attestation_id AND v_o.revoked_by = v_uid AND v_o.revoke_reason = btrim(p_reason, E' \t\r\n\f\v') THEN
      RETURN jsonb_build_object('revoked', true, 'already', true, 'id', v_o.id);
    END IF;
    RAISE EXCEPTION 'CMS_ATTEST_IDEM_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF v_prog.status = 'locked' THEN RAISE EXCEPTION 'CMS_PROGRAM_LOCKED' USING ERRCODE = 'P0001'; END IF;
  IF v_a.revoked_at IS NOT NULL OR v_a.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'CMS_ATTEST_NOT_LIVE' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    UPDATE public.cms_source_attestations
       SET revoked_at = now(), revoked_by = v_uid, revoke_reason = btrim(p_reason, E' \t\r\n\f\v'), revoke_idem_key = p_idem
     WHERE id = p_attestation_id;
  EXCEPTION WHEN unique_violation THEN
    -- cùng khoá đang dùng song song cho chứng nhận của chương trình khác ⇒ chờ rồi vi phạm unique.
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    IF v_con = 'cms_source_attest_revoke_idem' THEN RAISE EXCEPTION 'CMS_ATTEST_IDEM_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    RAISE;
  END;
  RETURN jsonb_build_object('revoked', true, 'already', false, 'id', v_a.id);
END;
$$;

-- Xuất SNAPSHOT lớp nguồn của MỘT run đã công bố (run ghim), keyset theo byte order_line_id; 14 trường chuỗi như file CSV chuẩn
-- (số scale 9 dạng thập phân, thời gian ISO micro giây UTC). Chỉ super + chương trình đọc được. KHÔNG phải chứng nhận: chỉ kiểm quyền /
-- run công bố / chưa dọn / source_schema rồi phân trang — không gọi cms__run_source_check (PM COMP-P2-2: không quét toàn lớp mỗi
-- trang). CLI đọc đủ trang, ghim run, kiểm ID / count / hash trước khi dựng payload; attest / đánh giá chốt mới kiểm toàn lớp.
CREATE FUNCTION public.rpc_cms_run_source_export(p_program_id uuid, p_run_id uuid, p_after_line_id text DEFAULT NULL, p_limit integer DEFAULT 5000)
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

CREATE FUNCTION public.rpc_cms_source_attestations(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin()
     OR NOT COALESCE(p_program_id = ANY (public.cms_readable_program_ids()), false) THEN  -- r1 P1-1: QA cần marker
    RAISE EXCEPTION 'CMS_ATTEST_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_program_id IS NULL THEN RAISE EXCEPTION 'CMS_ATTEST_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', a.id, 'run_id', a.run_id, 'field_set', a.field_set, 'scope_from', to_char(a.scope_from, 'YYYY-MM-DD'),
            'scope_to', to_char(a.scope_to, 'YYYY-MM-DD'), 'lines_compared', a.lines_compared, 'reference_label', a.reference_label,
            'as_of', public.cms__ts(a.as_of), 'attested_by', a.attested_by, 'attested_at', public.cms__ts(a.attested_at),
            'superseded_by', a.superseded_by, 'revoked_at', public.cms__ts(a.revoked_at), 'revoked_by', a.revoked_by,
            'live', a.revoked_at IS NULL AND a.superseded_by IS NULL,
            'used_by_payout', EXISTS (SELECT 1 FROM public.cms_payouts p WHERE p.source_attestation_id = a.id))
            ORDER BY a.attested_at DESC, a.id), '[]'::jsonb)
            FROM public.cms_source_attestations a WHERE a.program_id = p_program_id);
END;
$$;
