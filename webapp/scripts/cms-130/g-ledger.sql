
-- ── 8. Ledger trả hàng bền (PM D14) + publish run contract (thiết kế r2 §6–§7, r2.1 §14.1–§14.3) ──
-- Bảng BỀN: ngoài cleanup; chỉ INSERT (UPDATE / DELETE / TRUNCATE ⇒ CMS_LEDGER_IMMUTABLE, áp CẢ owner, ENABLE ALWAYS); chỉ RPC owner
-- ghi (cms__run_auth_guard). Mọi bất biến thứ tự (eval_seq liên tục dưới khoá chương trình, sàn as_of, baseline chỉ sau eval CLEAN mới
-- nhất, conflict chỉ từ eval MISMATCH mới nhất, observation liên tục, phục hồi chỉ trên proof mới nhất) kiểm bằng trigger DB ⇒ owner ghi
-- thẳng cũng không vượt. Không có trạng thái RESOLVED / ACCEPT_NEW: baseline bất biến, conflict mở ⇔ chưa có dòng phục hồi.
-- Thay r2 §6.3 (r2.1 §14.1): KHÔNG có cms_run_ledger_checks — mỗi lượt đánh giá là MỘT dòng eval bền; chi tiết lệch nằm ở observation.

-- Báo cáo trả sau chốt (D11 — RPC ở lát báo cáo). Header tạo ở đây vì baseline nhận SAU chốt trỏ tới nó: một sổ receipt duy nhất
-- (r2.1 §14.2). FK (program, run chốt) → cms_payouts ⇒ chỉ chương trình đã chốt, đúng run chốt.
ALTER TABLE public.cms_payouts ADD CONSTRAINT cms_payouts_program_run UNIQUE (program_id, run_id);
CREATE TABLE public.cms_return_close_reports (
  id                        uuid        PRIMARY KEY,
  program_id                uuid        NOT NULL,
  payout_run_id             uuid        NOT NULL,
  eval_seq                  bigint      NOT NULL,
  calc_contract_version     text        NOT NULL CHECK (calc_contract_version = '@@CALC_CONTRACT@@'),
  fp_version                text        NOT NULL CHECK (fp_version = '@@FP_VERSION@@'),
  status_dictionary_version text        NOT NULL CHECK (status_dictionary_version = '@@STATUS_VERSION@@'),
  source_pin                jsonb       NOT NULL CHECK (jsonb_typeof(source_pin) = 'object'),
  returns_as_of             timestamptz NOT NULL CHECK (isfinite(returns_as_of)),
  returns_digest            text        NOT NULL CHECK (returns_digest ~ '^[0-9a-f]{64}$'),
  frozen_amount             bigint      NOT NULL CHECK (frozen_amount >= 0),
  recomputed_amount         bigint      NOT NULL CHECK (recomputed_amount >= 0),
  delta_amount              bigint      NOT NULL,
  return_events             integer     NOT NULL CHECK (return_events >= 0),
  line_count                integer     NOT NULL CHECK (line_count >= 0),
  idem_key                  text        NOT NULL CHECK (idem_key ~ '^[0-9a-f]{64}$'),
  created_via               text        NOT NULL CHECK (created_via IN ('cron', 'super')),
  created_by                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cms_return_close_reports_idem UNIQUE (idem_key),
  CONSTRAINT cms_return_close_reports_bind UNIQUE (id, program_id),
  CONSTRAINT cms_return_close_reports_eval UNIQUE (program_id, eval_seq),
  CONSTRAINT cms_return_close_reports_payout_fk FOREIGN KEY (program_id, payout_run_id) REFERENCES public.cms_payouts (program_id, run_id),
  CONSTRAINT cms_return_close_reports_delta CHECK (delta_amount = recomputed_amount - frozen_amount),
  CONSTRAINT cms_return_close_reports_actor CHECK ((created_via = 'super') = (created_by IS NOT NULL))
);

-- Lượt đánh giá ledger (r2.1 §14.1): mỗi lượt hợp lệ — publish run net hoặc kiểm báo cáo sau chốt — MỘT dòng, kể cả lượt held và lượt
-- không sinh observation. eval_seq = max + 1 cấp dưới khoá chương trình (thứ tự toàn phần; không xếp theo thời gian). Sàn as_of: không
-- eval nào có returns_as_of nhỏ hơn cms__as_of_floor của chương trình (eval trước / baseline / run net đã khai seal). Hash: ledger_set_hash = tập baseline LÚC đánh giá (trước baseline
-- mới của lượt CLEAN); open_set_hash = tập conflict mở SAU lượt này.
CREATE TABLE public.cms_return_ledger_evals (
  program_id      uuid        NOT NULL REFERENCES public.cms_programs (id),
  eval_seq        bigint      NOT NULL CHECK (eval_seq >= 1),
  kind            text        NOT NULL CHECK (kind IN ('run', 'report')),
  run_id          uuid,
  report_attempt  uuid,
  returns_as_of   timestamptz NOT NULL CHECK (isfinite(returns_as_of)),
  returns_digest  text        NOT NULL CHECK (returns_digest ~ '^[0-9a-f]{64}$'),
  verdict         text        NOT NULL CHECK (verdict IN ('CLEAN', 'MISMATCH', 'OPEN_CONFLICT_MATCH')),
  baselines       integer     NOT NULL CHECK (baselines >= 0),
  mismatched      integer     NOT NULL CHECK (mismatched >= 0),
  open_conflicts  integer     NOT NULL CHECK (open_conflicts >= 0),
  ledger_set_hash text        NOT NULL CHECK (ledger_set_hash ~ '^[0-9a-f]{64}$'),
  open_set_hash   text        NOT NULL CHECK (open_set_hash ~ '^[0-9a-f]{64}$'),
  config_version  integer     NOT NULL CHECK (config_version >= 1),
  evaluated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, eval_seq),
  CONSTRAINT cms_return_ledger_evals_run UNIQUE (run_id),
  CONSTRAINT cms_return_ledger_evals_attempt UNIQUE (report_attempt),
  CONSTRAINT cms_return_ledger_evals_run_bind UNIQUE (program_id, eval_seq, run_id),
  CONSTRAINT cms_return_ledger_evals_run_verdict UNIQUE (program_id, eval_seq, run_id, verdict),
  CONSTRAINT cms_return_ledger_evals_report_bind UNIQUE (program_id, eval_seq, report_attempt),
  CONSTRAINT cms_return_ledger_evals_run_fk FOREIGN KEY (run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id),
  CONSTRAINT cms_return_ledger_evals_ref CHECK (
    (kind = 'run' AND run_id IS NOT NULL AND report_attempt IS NULL)
    OR (kind = 'report' AND run_id IS NULL AND report_attempt IS NOT NULL)),
  -- Mọi vế boolean không NULL (cột NOT NULL). MISMATCH ⇒ mỗi baseline lệch đều có conflict mở sau lượt này.
  CONSTRAINT cms_return_ledger_evals_shape CHECK (
    mismatched <= baselines AND open_conflicts <= baselines
    AND ((verdict = 'CLEAN' AND mismatched = 0 AND open_conflicts = 0)
         OR (verdict = 'MISMATCH' AND mismatched > 0 AND open_conflicts >= mismatched)
         OR (verdict = 'OPEN_CONFLICT_MATCH' AND mismatched = 0 AND open_conflicts > 0)))
);
ALTER TABLE public.cms_return_close_reports ADD CONSTRAINT cms_return_close_reports_eval_fk
  FOREIGN KEY (program_id, eval_seq, id) REFERENCES public.cms_return_ledger_evals (program_id, eval_seq, report_attempt);
-- Dòng báo cáo: một dòng / nhóm (dược sĩ, SP) của run chốt — số chốt (frozen_*) + trả APPLIED + số tính lại; line_no cho keyset.
CREATE TABLE public.cms_return_close_report_lines (
  report_id          uuid        NOT NULL,
  program_id         uuid        NOT NULL,
  line_no            integer     NOT NULL CHECK (line_no >= 0),
  user_id            uuid        NOT NULL,
  program_product_id uuid        NOT NULL,
  product_id         text        NOT NULL CHECK (product_id ~ '^[1-9][0-9]{0,18}$'),
  gmv_basis          text        NOT NULL CHECK (gmv_basis IN ('product', 'catalog', 'none')),
  per_unit           numeric     NOT NULL CHECK (per_unit > 0),
  frozen_base        numeric     NOT NULL,
  frozen_qty         bigint      NOT NULL CHECK (frozen_qty >= 0),
  frozen_gmv         numeric     NOT NULL,
  frozen_gate_met    boolean     NOT NULL,
  frozen_amount      bigint      NOT NULL CHECK (frozen_amount >= 0),
  return_base        numeric     NOT NULL CHECK (return_base >= 0),
  return_gmv         numeric     NOT NULL CHECK (return_gmv >= 0),
  return_events      integer     NOT NULL CHECK (return_events >= 0),
  eligible_base      numeric     NOT NULL,
  net_gmv            numeric     NOT NULL,
  gate_met           boolean     NOT NULL,
  recomputed_qty     bigint      NOT NULL CHECK (recomputed_qty >= 0),
  recomputed_amount  bigint      NOT NULL CHECK (recomputed_amount >= 0),
  delta              bigint      NOT NULL,
  PRIMARY KEY (report_id, user_id, program_product_id),
  CONSTRAINT cms_return_close_report_lines_no UNIQUE (report_id, line_no),
  CONSTRAINT cms_return_close_report_lines_report_fk FOREIGN KEY (report_id, program_id)
    REFERENCES public.cms_return_close_reports (id, program_id),
  CONSTRAINT cms_return_close_report_lines_math CHECK (
    delta = recomputed_amount - frozen_amount AND eligible_base = frozen_base - return_base AND net_gmv = frozen_gmv - return_gmv
    AND (return_events = 0) = (return_base = 0))
);
-- Sự kiện báo cáo: mọi phiếu EFFECTIVE của snapshot + disposition DB suy từ dòng chốt; APPLIED gắn nhóm (FK tới dòng báo cáo).
CREATE TABLE public.cms_return_close_report_events (
  report_id              uuid        NOT NULL,
  program_id             uuid        NOT NULL,
  return_event_id        text        NOT NULL CHECK (return_event_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  financial_fp           text        NOT NULL CHECK (financial_fp ~ '^[0-9a-f]{64}$'),
  original_order_line_id text        NOT NULL,
  disposition            text        NOT NULL CHECK (disposition IN ('APPLIED', 'ORIGIN_NOT_ELIGIBLE', 'ORIGIN_OUT_OF_WINDOW',
                                                                     'ORIGIN_NOT_IN_PROGRAM', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE')),
  user_id                uuid,
  program_product_id     uuid,
  base                   numeric     NOT NULL CHECK (base > 0 AND scale(base) = 0),
  refund                 numeric     NOT NULL CHECK (refund >= 0),
  recorded_at            timestamptz NOT NULL CHECK (isfinite(recorded_at)),
  PRIMARY KEY (report_id, return_event_id),
  CONSTRAINT cms_return_close_report_events_report_fk FOREIGN KEY (report_id, program_id)
    REFERENCES public.cms_return_close_reports (id, program_id),
  CONSTRAINT cms_return_close_report_events_line_fk FOREIGN KEY (report_id, user_id, program_product_id)
    REFERENCES public.cms_return_close_report_lines (report_id, user_id, program_product_id),
  CONSTRAINT cms_return_close_report_events_group CHECK (
    (disposition = 'APPLIED') = (user_id IS NOT NULL AND program_product_id IS NOT NULL) AND (user_id IS NULL) = (program_product_id IS NULL))
);
-- Keyset reader sự kiện báo cáo theo byte (COLLATE "C") — db-reviewer 14/11 P2-6.
CREATE INDEX cms_return_close_report_events_key_idx ON public.cms_return_close_report_events (report_id, return_event_id COLLATE "C");

-- Run net ghi số eval của mình; FK bốn cột ⇒ eval đúng chương trình + đúng run + phán quyết trên run = phán quyết eval (db-reviewer
-- 14/11 P2-1).
ALTER TABLE public.cms_sync_runs ADD CONSTRAINT cms_sync_runs_ledger_eval_fk
  FOREIGN KEY (program_id, ledger_eval_seq, id, ledger_verdict) REFERENCES public.cms_return_ledger_evals (program_id, eval_seq, run_id, verdict);

-- Phiếu đã nhận (baseline tài chính bất biến — D14). Một sổ receipt: nhận trước chốt (accepted_run_id) XOR sau chốt
-- (accepted_report_id); PK (chương trình, phiếu) ⇒ một phiếu chỉ có một baseline / một số tiền. fp do DB tính lại ở CHECK (r2.1 §14.3:
-- vế hàm NULL ⇒ CHECK sai, không lọt). Không cột trạng thái / email / user / store.
CREATE TABLE public.cms_return_baselines (
  program_id             uuid        NOT NULL,
  return_event_id        text        NOT NULL CHECK (return_event_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  fp_version             text        NOT NULL CHECK (fp_version = '@@FP_VERSION@@'),
  financial_fp           text        NOT NULL CHECK (financial_fp ~ '^[0-9a-f]{64}$'),
  return_document_id     text        NOT NULL CHECK (return_document_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  original_order_line_id text        NOT NULL CHECK (original_order_line_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  original_order_id      text        NOT NULL CHECK (original_order_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  product_id             text        NOT NULL CHECK (product_id ~ '^[1-9][0-9]{0,18}$'),
  base_quantity          numeric     NOT NULL CHECK (base_quantity > 0 AND scale(base_quantity) = 0 AND base_quantity < 1e29),
  refund_amount          numeric     NOT NULL CHECK (refund_amount >= 0 AND scale(refund_amount) <= 9 AND refund_amount < 1e20),
  recorded_at            timestamptz NOT NULL CHECK (isfinite(recorded_at)),
  accepted_eval_seq      bigint      NOT NULL,
  accepted_run_id        uuid,
  accepted_report_id     uuid,
  accepted_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, return_event_id),
  CONSTRAINT cms_return_baselines_accepted CHECK ((accepted_run_id IS NULL) <> (accepted_report_id IS NULL)),
  CONSTRAINT cms_return_baselines_fp CHECK (COALESCE(
    financial_fp = public.cms__return_fp(fp_version, program_id, return_event_id, return_document_id, original_order_line_id,
                                         original_order_id, product_id, base_quantity, refund_amount, recorded_at), false)),
  CONSTRAINT cms_return_baselines_eval_fk FOREIGN KEY (program_id, accepted_eval_seq)
    REFERENCES public.cms_return_ledger_evals (program_id, eval_seq),
  CONSTRAINT cms_return_baselines_run_eval_fk FOREIGN KEY (program_id, accepted_eval_seq, accepted_run_id)
    REFERENCES public.cms_return_ledger_evals (program_id, eval_seq, run_id),
  CONSTRAINT cms_return_baselines_report_eval_fk FOREIGN KEY (program_id, accepted_eval_seq, accepted_report_id)
    REFERENCES public.cms_return_ledger_evals (program_id, eval_seq, report_attempt),
  CONSTRAINT cms_return_baselines_run_fk FOREIGN KEY (accepted_run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id),
  CONSTRAINT cms_return_baselines_report_fk FOREIGN KEY (accepted_report_id, program_id)
    REFERENCES public.cms_return_close_reports (id, program_id)
);

-- Conflict: tối đa MỘT conflict mở / phiếu bằng ràng buộc DB (r2 §6.2): conflict đầu prev NULL (UNIQUE NULLS NOT DISTINCT chỉ cho một);
-- conflict sau trỏ conflict trước ĐÃ phục hồi (FK tới bảng liên kết phục hồi) và mỗi conflict trước chỉ có một kế tiếp (UNIQUE).
-- Mở = chưa có dòng ở cms_return_conflict_restorations. Mở bởi eval (run hoặc báo cáo) — không trỏ run.
CREATE TABLE public.cms_return_conflicts (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  program_id       uuid        NOT NULL,
  return_event_id  text        NOT NULL,
  prev_conflict_id bigint,
  opened_kind      text        NOT NULL CHECK (opened_kind IN ('MISSING', 'CHANGED', 'NOT_EFFECTIVE')),
  opened_eval_seq  bigint      NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cms_return_conflicts_prog UNIQUE (id, program_id),
  CONSTRAINT cms_return_conflicts_bind UNIQUE (id, program_id, return_event_id),
  CONSTRAINT cms_return_conflicts_chain UNIQUE NULLS NOT DISTINCT (program_id, return_event_id, prev_conflict_id),
  CONSTRAINT cms_return_conflicts_prev CHECK (prev_conflict_id IS NULL OR prev_conflict_id < id),
  CONSTRAINT cms_return_conflicts_baseline_fk FOREIGN KEY (program_id, return_event_id)
    REFERENCES public.cms_return_baselines (program_id, return_event_id),
  CONSTRAINT cms_return_conflicts_eval_fk FOREIGN KEY (program_id, opened_eval_seq)
    REFERENCES public.cms_return_ledger_evals (program_id, eval_seq)
);

-- Xác nhận phục hồi theo chương trình (super, proof = eval OPEN_CONFLICT_MATCH MỚI NHẤT). Không đổi tiền / fp / baseline / pointer.
CREATE TABLE public.cms_return_restorations (
  id              uuid        PRIMARY KEY,
  program_id      uuid        NOT NULL,
  proof_eval_seq  bigint      NOT NULL,
  open_set_hash   text        NOT NULL CHECK (open_set_hash ~ '^[0-9a-f]{64}$'),
  ledger_set_hash text        NOT NULL CHECK (ledger_set_hash ~ '^[0-9a-f]{64}$'),
  conflicts       integer     NOT NULL CHECK (conflicts >= 1),
  reason          text        NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 1000 AND reason = btrim(reason, E' \t\r\n\f\v')),
  confirmed_by    uuid        NOT NULL,
  confirmed_at    timestamptz NOT NULL DEFAULT now(),
  idem_key        uuid        NOT NULL,
  CONSTRAINT cms_return_restorations_idem UNIQUE (idem_key),
  CONSTRAINT cms_return_restorations_proof UNIQUE (program_id, proof_eval_seq),
  CONSTRAINT cms_return_restorations_bind UNIQUE (id, program_id),
  CONSTRAINT cms_return_restorations_eval_fk FOREIGN KEY (program_id, proof_eval_seq)
    REFERENCES public.cms_return_ledger_evals (program_id, eval_seq)
);

CREATE TABLE public.cms_return_conflict_restorations (
  conflict_id     bigint      PRIMARY KEY,
  restoration_id  uuid        NOT NULL,
  program_id      uuid        NOT NULL,
  return_event_id text        NOT NULL,
  CONSTRAINT cms_return_conflict_restorations_chain UNIQUE (conflict_id, program_id, return_event_id),
  CONSTRAINT cms_return_conflict_restorations_conflict_fk FOREIGN KEY (conflict_id, program_id, return_event_id)
    REFERENCES public.cms_return_conflicts (id, program_id, return_event_id),
  CONSTRAINT cms_return_conflict_restorations_restoration_fk FOREIGN KEY (restoration_id, program_id)
    REFERENCES public.cms_return_restorations (id, program_id)
);
CREATE INDEX cms_return_conflict_restorations_rest_idx ON public.cms_return_conflict_restorations (restoration_id);
ALTER TABLE public.cms_return_conflicts ADD CONSTRAINT cms_return_conflicts_prev_fk FOREIGN KEY (prev_conflict_id, program_id, return_event_id)
  REFERENCES public.cms_return_conflict_restorations (conflict_id, program_id, return_event_id);

-- Observation: version 1 lúc mở; sau đó CHỈ khi (phán quyết, fp quan sát) đổi so với observation mới nhất (r2 P1-11). Tối đa một
-- observation / conflict / eval. MATCH ⇔ fp quan sát = fp baseline (trigger); MISSING / NOT_EFFECTIVE không có fp.
CREATE TABLE public.cms_return_conflict_observations (
  conflict_id  bigint      NOT NULL,
  version      integer     NOT NULL CHECK (version >= 1),
  program_id   uuid        NOT NULL,
  eval_seq     bigint      NOT NULL,
  verdict      text        NOT NULL CHECK (verdict IN ('MISSING', 'CHANGED', 'NOT_EFFECTIVE', 'MATCH')),
  observed_fp  text        CHECK (observed_fp IS NULL OR observed_fp ~ '^[0-9a-f]{64}$'),
  observed     jsonb       NOT NULL CHECK (jsonb_typeof(observed) = 'object'),
  observed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conflict_id, version),
  CONSTRAINT cms_return_conflict_obs_eval UNIQUE (conflict_id, eval_seq),
  CONSTRAINT cms_return_conflict_obs_fp CHECK ((verdict IN ('CHANGED', 'MATCH')) = (observed_fp IS NOT NULL)),
  CONSTRAINT cms_return_conflict_obs_conflict_fk FOREIGN KEY (conflict_id, program_id) REFERENCES public.cms_return_conflicts (id, program_id),
  CONSTRAINT cms_return_conflict_obs_eval_fk FOREIGN KEY (program_id, eval_seq) REFERENCES public.cms_return_ledger_evals (program_id, eval_seq)
);

ALTER TABLE public.cms_return_close_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_close_report_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_close_report_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_ledger_evals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_restorations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_conflict_restorations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_conflict_observations ENABLE ROW LEVEL SECURITY;

-- Hash tập baseline (cms-ledger-set-v1): ID sắp theo byte (COLLATE "C"), mỗi dòng `<ID> <fp>` — ID không chứa ký tự điều khiển (CHECK),
-- fp cố định 64 hex ở cuối ⇒ không mơ hồ. Tập rỗng vẫn có hash.
CREATE FUNCTION public.cms__ledger_set_hash(p_program_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT encode(sha256(convert_to('cms-ledger-set-v1' || E'\n' || count(*)::text || E'\n'
           || COALESCE(string_agg(b.return_event_id || ' ' || b.financial_fp, E'\n' ORDER BY b.return_event_id COLLATE "C"), ''),
           'UTF8')), 'hex')
    FROM public.cms_return_baselines b
   WHERE b.program_id = p_program_id
$$;

-- Hash tập conflict mở (cms-open-set-v1): mỗi conflict mở `<ID phiếu> <eval mở> <version observation mới nhất>`, sắp byte theo ID phiếu
-- (tối đa một conflict mở / phiếu). Tính được TRƯỚC khi ghi (không dùng id identity) ⇒ eval ghi hash trước conflict / observation.
CREATE FUNCTION public.cms__open_set_hash(p_program_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT encode(sha256(convert_to('cms-open-set-v1' || E'\n' || count(*)::text || E'\n'
           || COALESCE(string_agg(c.return_event_id || ' ' || c.opened_eval_seq::text || ' ' || o.version::text, E'\n'
                                  ORDER BY c.return_event_id COLLATE "C"), ''),
           'UTF8')), 'hex')
    FROM public.cms_return_conflicts c
    LEFT JOIN LATERAL (SELECT max(x.version) AS version FROM public.cms_return_conflict_observations x WHERE x.conflict_id = c.id) o ON true
   WHERE c.program_id = p_program_id
     AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations r WHERE r.conflict_id = c.id)
$$;

-- Bất biến: không UPDATE / DELETE / TRUNCATE (áp cả owner — ENABLE ALWAYS). Rollback 130 chỉ DROP khi các bảng rỗng (rb-head).
-- Sàn as_of của chương trình (RET2-R2-01, db-reviewer 14/11 P1-1): mốc mới nhất DB từng THẤY — eval trước, mốc ghi nhận baseline, và
-- as_of của MỌI run net contract đã khai seal (seal_expect.pin.as_of / returns_as_of), kể cả run held / error trước khi kịp ghi eval
-- (mapping / cấu hình / cổng đổi, seal N2 lỗi, finish error). Snapshot cũ hơn không được làm eval / proof / baseline.
CREATE FUNCTION public.cms__as_of_floor(p_program_id uuid)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT GREATEST(
    (SELECT max(e.returns_as_of) FROM public.cms_return_ledger_evals e WHERE e.program_id = p_program_id),
    (SELECT max(b.recorded_at) FROM public.cms_return_baselines b WHERE b.program_id = p_program_id),
    (SELECT max(GREATEST(r.returns_as_of, (r.seal_expect -> 'pin' ->> 'as_of')::timestamptz))
       FROM public.cms_sync_runs r
      WHERE r.program_id = p_program_id AND r.kind = 'sales' AND r.calc_contract_version IS NOT NULL
        AND r.returns_policy = 'net_returns_v1' AND (r.returns_as_of IS NOT NULL OR r.seal_expect IS NOT NULL)));
$$;

CREATE FUNCTION public.cms__ledger_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'CMS_LEDGER_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$;

-- Eval: thứ tự toàn phần dưới khoá chương trình (r2.1 §14.1) — eval_seq = max + 1; as_of không lùi; config = chương trình; hash tập
-- baseline = trạng thái lúc ghi; eval kind run gắn đúng run net đang chạy đã seal 13 bước (as_of + digest = run); kind report chỉ ở
-- chương trình đã chốt. Áp cả owner ghi thẳng.
CREATE FUNCTION public.cms__ledger_eval_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog  public.cms_programs%ROWTYPE;
  v_seq   bigint;
  v_floor timestamptz;
  v_open  integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = NEW.program_id FOR UPDATE;
  SELECT max(e.eval_seq) INTO v_seq FROM public.cms_return_ledger_evals e WHERE e.program_id = NEW.program_id;
  v_floor := public.cms__as_of_floor(NEW.program_id);
  IF NEW.eval_seq IS DISTINCT FROM COALESCE(v_seq, 0) + 1 OR COALESCE(NEW.returns_as_of < v_floor, false) THEN
    RAISE EXCEPTION 'CMS_LEDGER_EVAL_ORDER' USING ERRCODE = 'P0001';
  END IF;
  -- Phán quyết khớp sổ hiện tại (db-reviewer 14/11 P2-1): CLEAN ⇔ không conflict mở; OPEN_CONFLICT_MATCH giữ đúng số conflict mở;
  -- MISMATCH chỉ mở thêm (không đóng).
  SELECT count(*)::integer INTO v_open FROM public.cms_return_conflicts c
   WHERE c.program_id = NEW.program_id AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id);
  IF (NEW.verdict = 'CLEAN' AND v_open <> 0) OR (NEW.verdict = 'OPEN_CONFLICT_MATCH' AND NEW.open_conflicts <> v_open)
     OR (NEW.verdict = 'MISMATCH' AND NEW.open_conflicts < v_open) THEN
    RAISE EXCEPTION 'CMS_LEDGER_EVAL_VERDICT' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.config_version IS DISTINCT FROM v_prog.config_version
     OR NEW.ledger_set_hash IS DISTINCT FROM public.cms__ledger_set_hash(NEW.program_id)
     OR NEW.baselines IS DISTINCT FROM (SELECT count(*)::integer FROM public.cms_return_baselines b WHERE b.program_id = NEW.program_id)
     OR (NEW.kind = 'run' AND NOT EXISTS (
           SELECT 1 FROM public.cms_sync_runs r
            WHERE r.id = NEW.run_id AND r.program_id = NEW.program_id AND r.kind = 'sales' AND r.status = 'running'
              AND r.sealed_at IS NOT NULL AND r.seal_step = 13 AND r.returns_policy = 'net_returns_v1'
              AND r.returns_as_of = NEW.returns_as_of AND r.returns_digest = NEW.returns_digest AND r.config_version = NEW.config_version))
     OR (NEW.kind = 'report' AND v_prog.status IS DISTINCT FROM 'locked') THEN
    RAISE EXCEPTION 'CMS_LEDGER_EVAL_BIND' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- Ghi baseline / conflict / observation / phục hồi: kiểm theo LỆNH (bảng chuyển tiếp) sau khi khoá các chương trình liên quan. Baseline /
-- conflict / observation / header báo cáo chỉ trong CÙNG transaction với eval của chúng (evaluated_at = now() — db-reviewer 14/11 P2-2).
CREATE FUNCTION public.cms__ledger_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bad boolean;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  PERFORM 1 FROM public.cms_programs p WHERE p.id IN (SELECT n.program_id FROM cms_new n) ORDER BY p.id FOR UPDATE;
  -- Bảng chuyển tiếp cms_new có thể hàng chục nghìn dòng: mọi tra bảng khác từ cms_new là probe PK TỪNG dòng (LATERAL … LIMIT 1 — không
  -- kéo lên thành join; bench 14/11 r4b: JOIN thường ở nhánh observation ⇒ Merge Join + Nested Loop join filter 360.981.000 lần, 75,4 s).
  IF TG_TABLE_NAME = 'cms_return_baselines' THEN
    -- Chỉ nhận ngay sau eval CLEAN MỚI NHẤT của chương trình (cùng lượt publish / báo cáo); ghi nhận ≤ as_of của eval đó.
    v_bad := EXISTS (
      SELECT 1 FROM cms_new n
        LEFT JOIN LATERAL (SELECT e0.verdict, e0.returns_as_of, e0.evaluated_at FROM public.cms_return_ledger_evals e0
                            WHERE e0.program_id = n.program_id AND e0.eval_seq = n.accepted_eval_seq LIMIT 1) e ON true
       WHERE e.verdict IS DISTINCT FROM 'CLEAN' OR n.recorded_at > e.returns_as_of OR e.evaluated_at IS DISTINCT FROM now()
          OR n.accepted_eval_seq IS DISTINCT FROM (SELECT max(x.eval_seq) FROM public.cms_return_ledger_evals x WHERE x.program_id = n.program_id));
  ELSIF TG_TABLE_NAME = 'cms_return_conflicts' THEN
    -- Chỉ mở bởi eval MISMATCH mới nhất.
    v_bad := EXISTS (
      SELECT 1 FROM cms_new n
        LEFT JOIN LATERAL (SELECT e0.verdict, e0.evaluated_at FROM public.cms_return_ledger_evals e0
                            WHERE e0.program_id = n.program_id AND e0.eval_seq = n.opened_eval_seq LIMIT 1) e ON true
       WHERE e.verdict IS DISTINCT FROM 'MISMATCH' OR e.evaluated_at IS DISTINCT FROM now()
          OR n.opened_eval_seq IS DISTINCT FROM (SELECT max(x.eval_seq) FROM public.cms_return_ledger_evals x WHERE x.program_id = n.program_id));
  ELSIF TG_TABLE_NAME = 'cms_return_conflict_observations' THEN
    -- Thuộc eval mới nhất (MISMATCH / OPEN_CONFLICT_MATCH; lượt OPEN_CONFLICT_MATCH chỉ có MATCH); conflict còn mở; version liên tục
    -- (= số observation của conflict); v1 ⇔ eval mở conflict và phán quyết = loại mở; MATCH ⇔ fp quan sát = fp baseline.
    v_bad := EXISTS (
      SELECT 1 FROM cms_new n
        CROSS JOIN LATERAL (SELECT c0.program_id, c0.return_event_id, c0.opened_eval_seq, c0.opened_kind
                              FROM public.cms_return_conflicts c0 WHERE c0.id = n.conflict_id LIMIT 1) c
        CROSS JOIN LATERAL (SELECT b0.financial_fp FROM public.cms_return_baselines b0
                             WHERE b0.program_id = c.program_id AND b0.return_event_id = c.return_event_id LIMIT 1) b
        LEFT JOIN LATERAL (SELECT e0.verdict, e0.evaluated_at FROM public.cms_return_ledger_evals e0
                            WHERE e0.program_id = n.program_id AND e0.eval_seq = n.eval_seq LIMIT 1) e ON true
       WHERE COALESCE(e.verdict NOT IN ('MISMATCH', 'OPEN_CONFLICT_MATCH'), true) OR e.evaluated_at IS DISTINCT FROM now()
          OR (e.verdict = 'OPEN_CONFLICT_MATCH' AND n.verdict <> 'MATCH')
          OR n.eval_seq IS DISTINCT FROM (SELECT max(x.eval_seq) FROM public.cms_return_ledger_evals x WHERE x.program_id = n.program_id)
          OR EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations r WHERE r.conflict_id = n.conflict_id)
          OR (n.version = 1) IS DISTINCT FROM (n.eval_seq = c.opened_eval_seq)
          OR (n.version = 1 AND n.verdict IS DISTINCT FROM c.opened_kind)
          OR n.version IS DISTINCT FROM (SELECT count(*)::integer FROM public.cms_return_conflict_observations x WHERE x.conflict_id = n.conflict_id)
          OR (n.verdict = 'MATCH') IS DISTINCT FROM (n.observed_fp IS NOT DISTINCT FROM b.financial_fp))
      OR EXISTS (SELECT 1 FROM cms_new n WHERE NOT EXISTS (SELECT 1 FROM public.cms_return_conflicts c WHERE c.id = n.conflict_id));
  ELSIF TG_TABLE_NAME = 'cms_return_restorations' THEN
    -- Proof = eval OPEN_CONFLICT_MATCH MỚI NHẤT; hash / số conflict / config của proof = hiện tại; một phục hồi / chương trình / lệnh.
    v_bad := EXISTS (
      SELECT 1 FROM cms_new n
        LEFT JOIN public.cms_return_ledger_evals e ON e.program_id = n.program_id AND e.eval_seq = n.proof_eval_seq
        JOIN public.cms_programs p ON p.id = n.program_id
       WHERE e.verdict IS DISTINCT FROM 'OPEN_CONFLICT_MATCH'
          OR n.proof_eval_seq IS DISTINCT FROM (SELECT max(x.eval_seq) FROM public.cms_return_ledger_evals x WHERE x.program_id = n.program_id)
          OR n.open_set_hash IS DISTINCT FROM e.open_set_hash OR n.ledger_set_hash IS DISTINCT FROM e.ledger_set_hash
          OR n.open_set_hash IS DISTINCT FROM public.cms__open_set_hash(n.program_id)
          OR n.ledger_set_hash IS DISTINCT FROM public.cms__ledger_set_hash(n.program_id)
          OR n.conflicts IS DISTINCT FROM e.open_conflicts OR p.config_version IS DISTINCT FROM e.config_version)
      OR (SELECT count(*) FROM cms_new) <> (SELECT count(DISTINCT n.program_id) FROM cms_new n);
  ELSIF TG_TABLE_NAME = 'cms_return_conflict_restorations' THEN
    -- Đóng MỌI conflict mở của chương trình trong cùng lệnh, chỉ khi proof vẫn là eval mới nhất và observation mới nhất của từng
    -- conflict là MATCH. Đếm liên kết / eval mới nhất tính MỘT lần mỗi phục hồi (db-reviewer 14/11 P1-2: subquery tương quan từng dòng
    -- ⇒ O(N²) khi confirm hàng chục nghìn conflict).
    v_bad := EXISTS (
      WITH rs AS (
        SELECT r.id, r.conflicts, r.proof_eval_seq,
               (SELECT max(x.eval_seq) FROM public.cms_return_ledger_evals x WHERE x.program_id = r.program_id) AS latest
          FROM public.cms_return_restorations r WHERE r.id IN (SELECT n.restoration_id FROM cms_new n)
      ), k AS (
        SELECT x.restoration_id, count(*) AS c FROM public.cms_return_conflict_restorations x
         WHERE x.restoration_id IN (SELECT rs.id FROM rs) GROUP BY x.restoration_id
      )
      SELECT 1 FROM rs LEFT JOIN k ON k.restoration_id = rs.id
       WHERE rs.proof_eval_seq IS DISTINCT FROM rs.latest OR COALESCE(k.c, 0) IS DISTINCT FROM rs.conflicts::bigint)
      OR EXISTS (SELECT 1 FROM cms_new n WHERE NOT EXISTS (SELECT 1 FROM public.cms_return_restorations r WHERE r.id = n.restoration_id))
      OR EXISTS (
      SELECT 1 FROM cms_new n
        LEFT JOIN LATERAL (SELECT o.verdict FROM public.cms_return_conflict_observations o WHERE o.conflict_id = n.conflict_id
                            ORDER BY o.version DESC LIMIT 1) lo ON true
       WHERE lo.verdict IS DISTINCT FROM 'MATCH')
      OR EXISTS (
      SELECT 1 FROM public.cms_return_conflicts c
       WHERE c.program_id IN (SELECT n.program_id FROM cms_new n)
         AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id));
  ELSIF TG_TABLE_NAME = 'cms_return_close_reports' THEN
    -- Header chỉ ngay sau eval kind report CLEAN MỚI NHẤT của chính lượt (report_attempt = id), cùng as_of / digest; chương trình đã chốt.
    v_bad := EXISTS (
      SELECT 1 FROM cms_new n
        LEFT JOIN public.cms_return_ledger_evals e ON e.program_id = n.program_id AND e.eval_seq = n.eval_seq
        JOIN public.cms_programs p ON p.id = n.program_id
       WHERE e.verdict IS DISTINCT FROM 'CLEAN' OR e.kind IS DISTINCT FROM 'report' OR e.report_attempt IS DISTINCT FROM n.id
          OR e.evaluated_at IS DISTINCT FROM now()
          OR e.returns_as_of IS DISTINCT FROM n.returns_as_of OR e.returns_digest IS DISTINCT FROM n.returns_digest
          OR n.eval_seq IS DISTINCT FROM (SELECT max(x.eval_seq) FROM public.cms_return_ledger_evals x WHERE x.program_id = n.program_id)
          OR p.status IS DISTINCT FROM 'locked');
  ELSIF TG_TABLE_NAME IN ('cms_return_close_report_lines', 'cms_return_close_report_events') THEN
    -- Dòng / sự kiện của MỘT báo cáo ghi trong ĐÚNG MỘT câu lệnh, cùng lượt tạo (eval của báo cáo vẫn mới nhất): số dòng câu lệnh = số
    -- header khai (line_count / return_events) = số dòng bảng đang có ⇒ không thêm được về sau, kể cả vào báo cáo mới nhất.
    v_bad := EXISTS (
      SELECT 1 FROM (SELECT n.report_id, count(*) AS k FROM cms_new n GROUP BY n.report_id) g
        LEFT JOIN public.cms_return_close_reports r ON r.id = g.report_id
       WHERE r.id IS NULL
          OR r.eval_seq IS DISTINCT FROM (SELECT max(x.eval_seq) FROM public.cms_return_ledger_evals x WHERE x.program_id = r.program_id)
          OR g.k IS DISTINCT FROM (CASE TG_TABLE_NAME WHEN 'cms_return_close_report_lines' THEN r.line_count ELSE r.return_events END)::bigint
          OR g.k IS DISTINCT FROM (CASE TG_TABLE_NAME
                                     WHEN 'cms_return_close_report_lines'
                                       THEN (SELECT count(*) FROM public.cms_return_close_report_lines l WHERE l.report_id = g.report_id)
                                     ELSE (SELECT count(*) FROM public.cms_return_close_report_events e WHERE e.report_id = g.report_id) END));
  ELSE
    RAISE EXCEPTION 'CMS_LEDGER_GUARD_TABLE' USING ERRCODE = 'P0001';
  END IF;
  IF v_bad IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'CMS_LEDGER_INSERT_GUARD' USING ERRCODE = 'P0001', DETAIL = TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_close_reports
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_close_reports
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_close_reports REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_close_report_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_close_report_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_close_report_lines REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_close_report_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_close_report_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_close_report_events REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_ledger_evals
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_ledger_evals
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_eval_guard BEFORE INSERT ON public.cms_return_ledger_evals
  FOR EACH ROW EXECUTE FUNCTION public.cms__ledger_eval_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_baselines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_baselines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_baselines REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_conflicts
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_conflicts
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_conflicts REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_restorations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_restorations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_restorations REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_conflict_restorations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_conflict_restorations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_conflict_restorations REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_conflict_observations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_conflict_observations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_conflict_observations REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
DO $$
DECLARE
  r record;
  v_n integer;
BEGIN
  FOR r IN
    SELECT c.relname, t.tgname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
       AND c.relname IN ('cms_return_close_reports', 'cms_return_close_report_lines', 'cms_return_close_report_events',
                         'cms_return_ledger_evals', 'cms_return_baselines', 'cms_return_conflicts',
                         'cms_return_restorations', 'cms_return_conflict_restorations', 'cms_return_conflict_observations')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', r.relname, r.tgname);
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgenabled = 'A'
     AND c.relname IN ('cms_return_close_reports', 'cms_return_close_report_lines', 'cms_return_close_report_events',
                         'cms_return_ledger_evals', 'cms_return_baselines', 'cms_return_conflicts',
                       'cms_return_restorations', 'cms_return_conflict_restorations', 'cms_return_conflict_observations');
  IF v_n <> 27 THEN RAISE EXCEPTION '130: trigger ledger phải đủ 27 và ENABLE ALWAYS, có %', v_n; END IF;
END $$;

-- ── Đánh giá ledger (dùng chung publish run net + kiểm báo cáo sau chốt) ──
-- p_obs: mảng quan sát CHỈ của các phiếu có baseline (người gọi join): {id, status, effect, fp (DB tính, NULL khi không hiệu lực),
-- base, refund, recorded_at}. Phán quyết từng baseline: MATCH (còn dòng EFFECTIVE cùng fp — bất kể disposition; fp gồm recorded_at,
-- mà recorded_at baseline ≤ sàn ≤ as_of ⇒ khớp fp kéo theo recorded_at ≤ as_of), NOT_EFFECTIVE, CHANGED, MISSING. Sàn as_of lùi ⇒
-- trả {code}, KHÔNG ghi. Còn lại ghi eval → conflict mới → observation khi đổi; hậu kiểm hash tập mở. Người gọi giữ khoá chương trình.
CREATE FUNCTION public.cms__ledger_eval(p_program_id uuid, p_kind text, p_ref uuid, p_as_of timestamptz, p_digest text, p_obs jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog    public.cms_programs%ROWTYPE;
  v_seq     bigint;
  v_floor   timestamptz;
  v_nb      integer;
  v_bad     integer;
  v_open    integer;
  v_nopen   integer;
  v_nobs    integer;
  v_verdict text;
  v_lhash   text;
  v_ohash   text;
  v_list    jsonb;
  v_map     jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  IF p_program_id IS NULL OR p_kind IS NULL OR p_kind NOT IN ('run', 'report') OR p_ref IS NULL OR p_as_of IS NULL
     OR NOT isfinite(p_as_of) OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_obs IS NULL OR jsonb_typeof(p_obs) <> 'array' THEN
    RAISE EXCEPTION 'CMS_LEDGER_EVAL_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- 1. Sàn as_of = cms__as_of_floor (eval trước + mốc ghi nhận baseline + as_of run net đã khai seal, kể cả run held / error trước eval).
  SELECT max(e.eval_seq) INTO v_seq FROM public.cms_return_ledger_evals e WHERE e.program_id = p_program_id;
  v_floor := public.cms__as_of_floor(p_program_id);
  IF COALESCE(p_as_of < v_floor, false) THEN
    RETURN jsonb_build_object('code', 'CMS_RETURN_AS_OF_REGRESSION');
  END IF;
  v_seq := COALESCE(v_seq, 0) + 1;
  IF (SELECT count(*) FROM jsonb_array_elements(p_obs)) <> (SELECT count(DISTINCT x ->> 'id') FROM jsonb_array_elements(p_obs) x)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_obs) x
                 WHERE jsonb_typeof(x) <> 'object' OR x ->> 'id' IS NULL
                    OR NOT EXISTS (SELECT 1 FROM public.cms_return_baselines b WHERE b.program_id = p_program_id AND b.return_event_id = x ->> 'id')) THEN
    RAISE EXCEPTION 'CMS_LEDGER_EVAL_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- 2. Phán quyết + kế hoạch ghi (một lần): dòng cần theo dõi = baseline lệch HOẶC đang có conflict mở.
  --    Kế hoạch không phụ thuộc thống kê (bench 14/11: baseline / conflict vừa ghi của chương trình chưa có trong thống kê ⇒ planner ước
  --    1 dòng ⇒ Nested Loop + Materialize bậc hai). Baseline → quan sát: tra map id → quan sát dựng MỘT lần (khoá jsonb, ID đã kiểm duy
  --    nhất ở trên); baseline → conflict mở: LATERAL probe theo (program_id, return_event_id) (cms_return_conflicts_chain; tối đa một
  --    conflict mở / phiếu — ràng buộc DB). Không viết lại thành JOIN.
  SELECT COALESCE(jsonb_object_agg(x ->> 'id', x), '{}'::jsonb) INTO v_map FROM jsonb_array_elements(p_obs) x;
  WITH bo AS (
    SELECT b.return_event_id AS id, b.financial_fp AS bfp, v_map -> b.return_event_id AS o
      FROM public.cms_return_baselines b
     WHERE b.program_id = p_program_id
  ), v AS (
    SELECT bo.id, bo.bfp,
           CASE WHEN bo.o IS NULL THEN 'MISSING'
                WHEN bo.o ->> 'effect' IS DISTINCT FROM 'EFFECTIVE' THEN 'NOT_EFFECTIVE'
                WHEN bo.o ->> 'fp' IS DISTINCT FROM bo.bfp THEN 'CHANGED'
                ELSE 'MATCH' END AS verdict,
           CASE WHEN bo.o IS NOT NULL AND bo.o ->> 'effect' = 'EFFECTIVE' THEN bo.o ->> 'fp' END AS fp,
           CASE WHEN bo.o IS NULL THEN '{}'::jsonb
                ELSE jsonb_strip_nulls(jsonb_build_object('status', bo.o ->> 'status', 'effect', bo.o ->> 'effect', 'base', bo.o ->> 'base',
                                                          'refund', bo.o ->> 'refund', 'recorded_at', bo.o ->> 'recorded_at')) END AS observed
      FROM bo
  ), l AS (
    SELECT v.id, v.verdict, v.fp, v.observed, oc.cid, oc.version,
           CASE WHEN oc.cid IS NULL THEN 'open'
                WHEN (v.verdict, v.fp) IS DISTINCT FROM (oc.lverdict, oc.lfp) THEN 'observe'
                ELSE 'same' END AS action,
           CASE WHEN oc.cid IS NULL THEN v_seq ELSE oc.opened_eval_seq END AS opened_seq,
           CASE WHEN oc.cid IS NULL THEN 1
                WHEN (v.verdict, v.fp) IS DISTINCT FROM (oc.lverdict, oc.lfp) THEN oc.version + 1
                ELSE oc.version END AS new_version
      FROM v
      LEFT JOIN LATERAL (
        SELECT c.id AS cid, c.opened_eval_seq, lo.version, lo.verdict AS lverdict, lo.observed_fp AS lfp
          FROM public.cms_return_conflicts c
          LEFT JOIN LATERAL (SELECT x.version, x.verdict, x.observed_fp FROM public.cms_return_conflict_observations x
                              WHERE x.conflict_id = c.id ORDER BY x.version DESC LIMIT 1) lo ON true
         WHERE c.program_id = p_program_id AND c.return_event_id = v.id
           AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations r WHERE r.conflict_id = c.id)
         ORDER BY c.id DESC LIMIT 1) oc ON true
     WHERE v.verdict <> 'MATCH' OR oc.cid IS NOT NULL
  )
  SELECT (SELECT count(*) FROM v), (SELECT count(*) FROM v WHERE v.verdict <> 'MATCH'), count(*),
         count(*) FILTER (WHERE l.action = 'open'), count(*) FILTER (WHERE l.action IN ('open', 'observe')),
         encode(sha256(convert_to('cms-open-set-v1' || E'\n' || count(*)::text || E'\n'
           || COALESCE(string_agg(l.id || ' ' || l.opened_seq::text || ' ' || l.new_version::text, E'\n' ORDER BY l.id COLLATE "C"), ''),
           'UTF8')), 'hex'),
         COALESCE(jsonb_agg(jsonb_build_object('id', l.id, 'verdict', l.verdict, 'fp', l.fp, 'observed', l.observed, 'cid', l.cid,
                                               'action', l.action, 'new_version', l.new_version))
                  FILTER (WHERE l.action IN ('open', 'observe')), '[]'::jsonb)
    INTO v_nb, v_bad, v_open, v_nopen, v_nobs, v_ohash, v_list
    FROM l;
  -- Conflict mở có thể đã "sạch" trước lượt này nhưng baseline vẫn phải nằm trong tập (FK) ⇒ v_open = số dòng l.
  v_verdict := CASE WHEN v_bad > 0 THEN 'MISMATCH' WHEN v_open > 0 THEN 'OPEN_CONFLICT_MATCH' ELSE 'CLEAN' END;
  v_lhash := public.cms__ledger_set_hash(p_program_id);
  -- 3. Eval trước (trigger kiểm thứ tự / sàn / gắn run), rồi conflict mới (prev = conflict gần nhất của phiếu — đã phục hồi; FK +
  --    UNIQUE NULLS NOT DISTINCT chặn mở chồng), rồi observation.
  INSERT INTO public.cms_return_ledger_evals (program_id, eval_seq, kind, run_id, report_attempt, returns_as_of, returns_digest, verdict,
    baselines, mismatched, open_conflicts, ledger_set_hash, open_set_hash, config_version)
  VALUES (p_program_id, v_seq, p_kind, CASE WHEN p_kind = 'run' THEN p_ref END, CASE WHEN p_kind = 'report' THEN p_ref END, p_as_of,
          p_digest, v_verdict, v_nb, v_bad, v_open, v_lhash, v_ohash, v_prog.config_version);
  IF v_nopen > 0 THEN
    INSERT INTO public.cms_return_conflicts (program_id, return_event_id, prev_conflict_id, opened_kind, opened_eval_seq)
    SELECT p_program_id, x.id,
           (SELECT max(c.id) FROM public.cms_return_conflicts c WHERE c.program_id = p_program_id AND c.return_event_id = x.id),
           x.verdict, v_seq
      FROM jsonb_to_recordset(v_list) AS x(id text, verdict text, action text)
     WHERE x.action = 'open';
  END IF;
  IF v_nobs > 0 THEN
    INSERT INTO public.cms_return_conflict_observations (conflict_id, version, program_id, eval_seq, verdict, observed_fp, observed)
    -- Conflict vừa mở của lượt: probe vô hướng (bench 14/11: LEFT JOIN với conflict vừa ghi ⇒ Materialize ước 1 dòng).
    SELECT COALESCE(x.cid, CASE WHEN x.action = 'open' THEN
             (SELECT c.id FROM public.cms_return_conflicts c
               WHERE c.program_id = p_program_id AND c.return_event_id = x.id AND c.opened_eval_seq = v_seq) END),
           x.new_version, p_program_id, v_seq, x.verdict, x.fp, x.observed
      FROM jsonb_to_recordset(v_list) AS x(id text, verdict text, fp text, observed jsonb, cid bigint, action text, new_version integer);
  END IF;
  -- 4. Hậu kiểm: hash tập mở tính lại từ bảng = hash đã ghi trên eval.
  IF public.cms__open_set_hash(p_program_id) IS DISTINCT FROM v_ohash THEN
    RAISE EXCEPTION 'CMS_LEDGER_ASSERT' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('eval_seq', v_seq, 'verdict', v_verdict, 'baselines', v_nb, 'mismatched', v_bad, 'open_conflicts', v_open,
                            'opened', v_nopen, 'observations', v_nobs, 'ledger_set_hash', v_lhash, 'open_set_hash', v_ohash);
END;
$$;

-- ── Publish atomic run contract (r2 §7) — gọi từ rpc_cms_sales_run_publish (đoạn chèn đầu thân 126) ──
-- Khoá chương trình → run (cùng thứ tự 126 / open / cleanup / chốt / confirm). Mã chặn chung ⇒ run held / error, không ghi gì khác.
-- Run net: đánh giá ledger dưới khoá (eval luôn ghi) ⇒ lệch / còn conflict mở ⇒ held, pointer giữ. Sạch ⇒ CÙNG transaction: baseline
-- mới (phiếu EFFECTIVE có tác động tiền: APPLIED / ORIGIN_UNASSIGNED / ORIGIN_OUT_OF_SCOPE) → run ok + đóng dấu căn cứ (cả run QA) →
-- pointer → hậu kiểm. KHÔNG có EXCEPTION handler (savepoint) trong hàm: lỗi / huỷ / timeout ⇒ rollback toàn bộ.
CREATE FUNCTION public.cms__publish_contract(p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pid   uuid;
  v_prog  public.cms_programs%ROWTYPE;
  v_run   public.cms_sync_runs%ROWTYPE;
  v_net   boolean;
  v_code  text;
  v_prev  uuid;
  v_obs   jsonb;
  v_ev    jsonb;
  v_seq   bigint;
  v_lhash text;
  v_nb0   bigint;
  v_new   bigint;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  SELECT program_id INTO v_pid FROM public.cms_sync_runs WHERE id = p_run_id AND kind = 'sales';
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_pid FOR UPDATE;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.calc_contract_version IS NULL THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_CONTRACT' USING ERRCODE = 'P0001'; END IF;
  IF v_run.status = 'ok' THEN
    RETURN jsonb_build_object('published', true, 'already', true, 'run_id', p_run_id,
                              'current', v_prog.current_result_run_id IS NOT DISTINCT FROM p_run_id);
  END IF;
  IF v_run.status <> 'running' THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001'; END IF;
  IF v_run.sealed_at IS NULL OR v_run.seal_step IS DISTINCT FROM 13 THEN RAISE EXCEPTION 'CMS_RESULT_NOT_SEALED' USING ERRCODE = 'P0001'; END IF;
  v_net := v_run.returns_policy = 'net_returns_v1';
  -- So sánh có thể NULL (chưa có eval / baseline) bọc COALESCE(…, false) ⇒ không chặn nhầm, không lọt nhầm.
  v_code := CASE
    WHEN v_run.started_at < now() - interval '30 minutes' THEN 'STALE'
    WHEN v_prog.status = 'locked' THEN 'PROGRAM_LOCKED'
    WHEN v_prog.status <> 'active' THEN 'PROGRAM_NOT_ACTIVE'
    WHEN v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN 'CONFIG_CHANGED'
    WHEN public.cms__mapping_fp() <> v_run.mapping_fp THEN 'MAPPING_CHANGED'
    WHEN NOT v_run.is_test AND NOT public.cms__results_release_open() THEN 'RESULTS_RELEASE_GATE'
    WHEN v_run.quantity_basis IS DISTINCT FROM v_prog.quantity_basis THEN 'CMS_BASIS_MISMATCH'
    -- Chương trình đã net / đã có sổ ⇒ run sales-only không được công bố (mọi baseline phải được kiểm ở mọi run).
    WHEN NOT v_net AND (v_prog.returns_policy IS DISTINCT FROM 'sales_only_v1'
                        OR EXISTS (SELECT 1 FROM public.cms_return_baselines b WHERE b.program_id = v_pid)
                        OR EXISTS (SELECT 1 FROM public.cms_return_ledger_evals e WHERE e.program_id = v_pid))
      THEN 'CMS_RETURNS_POLICY_REGRESSION'
    WHEN v_net AND v_prog.returns_policy IS DISTINCT FROM 'net_returns_v1' THEN 'CONFIG_CHANGED'
    WHEN v_net AND COALESCE(v_run.returns_as_of < public.cms__as_of_floor(v_pid), false) THEN 'CMS_RETURN_AS_OF_REGRESSION'
  END;
  IF v_code IS NOT NULL THEN
    UPDATE public.cms_sync_runs SET status = CASE WHEN v_code = 'STALE' THEN 'error' ELSE 'held' END,
           finished_at = now(), error_code = v_code
     WHERE id = p_run_id;
    RETURN jsonb_build_object('published', false, 'code', v_code, 'run_id', p_run_id);
  END IF;
  IF v_net THEN
    -- Quan sát cho MỌI baseline của chương trình: dòng phiếu của snapshot cùng ID (fp DB tính lại; chưa hiệu lực ⇒ không fp).
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', r.return_event_id, 'status', r.return_status, 'effect', r.status_effect,
             'fp', CASE WHEN r.status_effect = 'EFFECTIVE' THEN public.cms__return_fp('@@FP_VERSION@@', v_pid, r.return_event_id,
                          r.return_document_id, r.original_order_line_id, r.original_order_id, r.product_id, r.return_base_quantity,
                          r.return_gmv_amount, r.recorded_at) END,
             'base', r.return_base_quantity::text, 'refund', r.return_gmv_amount::text,
             'recorded_at', CASE WHEN r.recorded_at IS NOT NULL THEN public.cms__ts(r.recorded_at) END)), '[]'::jsonb)
      INTO v_obs
      FROM public.cms_return_lines r
     -- Probe PK baseline từng dòng (truy vấn con vô hướng — không JOIN / EXISTS: thống kê cũ của chương trình ⇒ Nested Loop +
     -- Materialize bậc hai, bench 14/11).
     WHERE r.run_id = p_run_id
       AND (SELECT true FROM public.cms_return_baselines b WHERE b.program_id = v_pid AND b.return_event_id = r.return_event_id) IS NOT NULL;
    v_ev := public.cms__ledger_eval(v_pid, 'run', p_run_id, v_run.returns_as_of, v_run.returns_digest, v_obs);
    IF v_ev ? 'code' THEN
      UPDATE public.cms_sync_runs SET status = 'held', finished_at = now(), error_code = v_ev ->> 'code' WHERE id = p_run_id;
      RETURN jsonb_build_object('published', false, 'code', v_ev ->> 'code', 'run_id', p_run_id);
    END IF;
    v_seq := (v_ev ->> 'eval_seq')::bigint;
    v_lhash := v_ev ->> 'ledger_set_hash';
    UPDATE public.cms_sync_runs SET ledger_verdict = v_ev ->> 'verdict', ledger_set_hash = v_lhash, ledger_checked_at = now(),
           ledger_eval_seq = v_seq
     WHERE id = p_run_id;
    IF v_ev ->> 'verdict' <> 'CLEAN' THEN
      v_code := CASE v_ev ->> 'verdict' WHEN 'MISMATCH' THEN 'CMS_RETURN_LEDGER_CONFLICT' ELSE 'CMS_RETURN_CONFLICT_OPEN' END;
      UPDATE public.cms_sync_runs SET status = 'held', finished_at = now(), error_code = v_code WHERE id = p_run_id;
      RETURN jsonb_build_object('published', false, 'code', v_code, 'run_id', p_run_id, 'ledger', v_ev);
    END IF;
  ELSE
    v_lhash := public.cms__ledger_set_hash(v_pid);
  END IF;
  -- Sạch: baseline mới → run ok → pointer → hậu kiểm (RAISE ⇒ rollback cả baseline + trạng thái + pointer).
  SELECT count(*) INTO v_nb0 FROM public.cms_return_baselines WHERE program_id = v_pid;
  v_new := 0;
  IF v_net THEN
    INSERT INTO public.cms_return_baselines (program_id, return_event_id, fp_version, financial_fp, return_document_id,
      original_order_line_id, original_order_id, product_id, base_quantity, refund_amount, recorded_at, accepted_eval_seq, accepted_run_id)
    SELECT v_pid, r.return_event_id, '@@FP_VERSION@@',
           public.cms__return_fp('@@FP_VERSION@@', v_pid, r.return_event_id, r.return_document_id, r.original_order_line_id,
                                 r.original_order_id, r.product_id, r.return_base_quantity, r.return_gmv_amount, r.recorded_at),
           r.return_document_id, r.original_order_line_id, r.original_order_id, r.product_id, r.return_base_quantity,
           r.return_gmv_amount, r.recorded_at, v_seq, p_run_id
      FROM public.cms_return_lines r
     WHERE r.run_id = p_run_id AND r.status_effect = 'EFFECTIVE'
       AND r.disposition IN ('APPLIED', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE')
       AND (SELECT true FROM public.cms_return_baselines b WHERE b.program_id = v_pid AND b.return_event_id = r.return_event_id) IS NULL;
    GET DIAGNOSTICS v_new = ROW_COUNT;
  END IF;
  v_prev := v_prog.current_result_run_id;
  UPDATE public.cms_sync_runs SET status = 'ok', finished_at = now(), published_at = now(),
         ledger_verdict = 'CLEAN', ledger_set_hash = v_lhash, ledger_checked_at = COALESCE(ledger_checked_at, now()),
         detail = detail || jsonb_build_object('results_basis', v_run.returns_policy, 'quantity_basis', v_run.quantity_basis)
   WHERE id = p_run_id;
  UPDATE public.cms_programs SET current_result_run_id = p_run_id WHERE id = v_pid;
  IF (SELECT count(*) FROM public.cms_return_baselines WHERE program_id = v_pid) IS DISTINCT FROM v_nb0 + v_new
     OR EXISTS (SELECT 1 FROM public.cms_return_conflicts c WHERE c.program_id = v_pid
                   AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id))
     OR (SELECT current_result_run_id FROM public.cms_programs WHERE id = v_pid) IS DISTINCT FROM p_run_id
     OR (v_net AND ((SELECT e.verdict FROM public.cms_return_ledger_evals e WHERE e.program_id = v_pid AND e.eval_seq = v_seq)
                      IS DISTINCT FROM 'CLEAN'
                    OR v_seq IS DISTINCT FROM (SELECT max(e.eval_seq) FROM public.cms_return_ledger_evals e WHERE e.program_id = v_pid))) THEN
    RAISE EXCEPTION 'CMS_PUBLISH_ASSERT' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('published', true, 'already', false, 'run_id', p_run_id, 'previous_run_id', v_prev,
                            'ledger_verdict', 'CLEAN', 'eval_seq', v_seq, 'baselines_new', v_new);
END;
$$;

-- ── Super xác nhận nguồn đã phục hồi đúng baseline (r2 §6.4 bước 4, r2.1 §14.1) ──
-- Authenticated, mẫu attest 124: auth.uid() + is_super_admin() + chương trình đọc được (QA cần marker). Khoá chương trình FOR UPDATE.
-- Proof = eval có eval_seq = max của chương trình (không lượt nào sau), verdict OPEN_CONFLICT_MATCH, as_of = sàn, hash tập mở / tập
-- baseline / config = hiện tại. Ghi một phục hồi + một liên kết / conflict mở; không đổi tiền / fp / baseline / pointer.
CREATE FUNCTION public.rpc_cms_return_conflicts_confirm_restored(p_program_id uuid, p_expected_open_set_hash text, p_proof_eval_seq bigint,
                                                                  p_reason text, p_idem uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_reason text;
  v_prog   public.cms_programs%ROWTYPE;
  v_old    public.cms_return_restorations%ROWTYPE;
  v_ev     public.cms_return_ledger_evals%ROWTYPE;
  v_max    bigint;
  v_floor  timestamptz;
  v_open   integer;
  v_ohash  text;
  v_id     uuid;
  v_n      integer;
  v_con    text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_super_admin()
     OR NOT COALESCE(p_program_id = ANY (public.cms_readable_program_ids()), false) THEN
    RAISE EXCEPTION 'CMS_RETURN_CONFIRM_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  v_reason := btrim(p_reason, E' \t\r\n\f\v');
  IF COALESCE(p_expected_open_set_hash IS NULL OR p_expected_open_set_hash !~ '^[0-9a-f]{64}$' OR p_proof_eval_seq IS NULL
     OR p_proof_eval_seq < 1 OR p_idem IS NULL OR v_reason IS NULL OR char_length(v_reason) NOT BETWEEN 10 AND 1000
     OR p_reason ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]', true) THEN
    RAISE EXCEPTION 'CMS_RETURN_CONFIRM_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- Idempotency sau khoá: cùng khoá + cùng (chương trình, proof, hash, lý do, người gọi) ⇒ already; khác ⇒ CMS_IDEM_REUSED.
  SELECT * INTO v_old FROM public.cms_return_restorations WHERE idem_key = p_idem;
  IF FOUND THEN
    IF v_old.program_id = p_program_id AND v_old.proof_eval_seq = p_proof_eval_seq AND v_old.open_set_hash = p_expected_open_set_hash
       AND v_old.reason = v_reason AND v_old.confirmed_by = v_uid THEN
      RETURN jsonb_build_object('confirmed', true, 'already', true, 'id', v_old.id, 'conflicts', v_old.conflicts,
                                'proof_eval_seq', v_old.proof_eval_seq);
    END IF;
    RAISE EXCEPTION 'CMS_IDEM_REUSED' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO v_open FROM public.cms_return_conflicts c
   WHERE c.program_id = p_program_id AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id);
  IF v_open = 0 THEN RAISE EXCEPTION 'CMS_RETURN_NO_OPEN_CONFLICT' USING ERRCODE = 'P0001'; END IF;
  v_ohash := public.cms__open_set_hash(p_program_id);
  IF v_ohash IS DISTINCT FROM p_expected_open_set_hash THEN
    RAISE EXCEPTION 'CMS_RETURN_OPEN_SET_STALE' USING ERRCODE = 'P0001';
  END IF;
  SELECT max(e.eval_seq) INTO v_max FROM public.cms_return_ledger_evals e WHERE e.program_id = p_program_id;
  v_floor := public.cms__as_of_floor(p_program_id);
  SELECT * INTO v_ev FROM public.cms_return_ledger_evals WHERE program_id = p_program_id AND eval_seq = p_proof_eval_seq;
  IF NOT FOUND OR p_proof_eval_seq IS DISTINCT FROM v_max THEN
    RAISE EXCEPTION 'CMS_RETURN_PROOF_NOT_LATEST' USING ERRCODE = 'P0001';
  END IF;
  IF v_ev.verdict <> 'OPEN_CONFLICT_MATCH'
     OR EXISTS (SELECT 1 FROM public.cms_return_conflicts c
                 WHERE c.program_id = p_program_id
                   AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id)
                   AND (SELECT o.verdict FROM public.cms_return_conflict_observations o WHERE o.conflict_id = c.id
                         ORDER BY o.version DESC LIMIT 1) IS DISTINCT FROM 'MATCH') THEN
    RAISE EXCEPTION 'CMS_RETURN_PROOF_NOT_MATCH' USING ERRCODE = 'P0001';
  END IF;
  IF v_ev.returns_as_of < v_floor OR v_ev.open_set_hash IS DISTINCT FROM v_ohash
     OR v_ev.ledger_set_hash IS DISTINCT FROM public.cms__ledger_set_hash(p_program_id)
     OR v_ev.config_version IS DISTINCT FROM v_prog.config_version OR v_ev.open_conflicts IS DISTINCT FROM v_open THEN
    RAISE EXCEPTION 'CMS_RETURN_PROOF_STALE' USING ERRCODE = 'P0001';
  END IF;
  v_id := gen_random_uuid();
  BEGIN
    INSERT INTO public.cms_return_restorations (id, program_id, proof_eval_seq, open_set_hash, ledger_set_hash, conflicts, reason,
                                                confirmed_by, idem_key)
    VALUES (v_id, p_program_id, p_proof_eval_seq, v_ohash, v_ev.ledger_set_hash, v_open, v_reason, v_uid, p_idem);
  EXCEPTION WHEN unique_violation THEN
    -- Cùng khoá idem đang dùng song song cho chương trình khác (khoá chương trình khác nhau) ⇒ chờ rồi vi phạm unique.
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    IF v_con = 'cms_return_restorations_idem' THEN RAISE EXCEPTION 'CMS_IDEM_REUSED' USING ERRCODE = 'P0001'; END IF;
    RAISE;
  END;
  INSERT INTO public.cms_return_conflict_restorations (conflict_id, restoration_id, program_id, return_event_id)
  SELECT c.id, v_id, c.program_id, c.return_event_id
    FROM public.cms_return_conflicts c
   WHERE c.program_id = p_program_id
     AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_open THEN RAISE EXCEPTION 'CMS_LEDGER_ASSERT' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('confirmed', true, 'already', false, 'id', v_id, 'conflicts', v_open, 'proof_eval_seq', p_proof_eval_seq);
END;
$$;
