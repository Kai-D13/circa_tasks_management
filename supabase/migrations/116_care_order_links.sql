-- ============================================================================
-- 116_care_order_links.sql — CRM-CSKH E: đơn N3 xác thực sau import (N3 → task → POS)
-- Chạy SAU 115. Operator tạm dừng import của Marketing trước khi chạy (trigger mới trên care_tasks / care_customers và
-- REVOKE DELETE của service_role có hiệu lực ngay, cờ CARE_ORDER_LINKS_* OFF không cô lập được).
--
-- Contract: thiết kế planning/research/crm-cskh-e0-order-visibility-design.md r3.4 (PM audit r3.3.1: GO code có điều kiện) ·
-- DECISIONS Q-175 / 177 / 181 / 182 / 183 / 186 / 187 / 188–194.
--
-- Nội dung:
--   * 7 bảng owner-only (RLS bật, 0 policy, 0 quyền ngoài owner): care_order_links (FK DUY NHẤT → care_tasks RESTRICT),
--     care_order_period_state, care_order_runs, care_order_run_tasks, care_order_run_jobs, care_order_run_chunks,
--     care_order_task_coverage (không FK). Dòng care_sync_state 'n3_import_orders'. Hàm biên kỳ care_period_end (IMMUTABLE).
--   * 4 trigger ENABLE ALWAYS: care_tasks_freeze_cutoff / care_customers_freeze_external_id (mốc + khoá khách bất biến),
--     care_tasks_block_closed_period (AFTER INSERT theo lệnh: từ chối isolation snapshot cũ, lấy khoá X care_import:<kỳ> RỒI mới đọc
--     trạng thái kỳ — PM r3.3.1 P1), care_tasks_drop_order_coverage (AFTER DELETE: dọn coverage cùng transaction).
--   * RPC service_role của lượt đồng bộ (thường / chốt / trial) + dọn QA; RPC authenticated chỉ đọc theo vị từ care_tasks_select.
--   * D1: care__import_cancel_gate / care__import_cancel_assess = nguyên văn 115 + đúng các điểm sửa (Q-175 / Q-182).
--   * REVOKE DELETE ON care_tasks FROM service_role: xoá task is_test chỉ qua care_qa_delete_test_tasks.
--
-- Khoá (không vòng chờ):  L = advisory hashtextextended('care_order_links', 0).  Kỳ = hashtextextended('care_import:' || kỳ, 0)
-- (cùng key finalize / đóng kỳ / huỷ của 114/115; 116 viết kỳ bằng to_char(…,'YYYY-MM-DD') — trùng ::text ở DateStyle ISO,
-- và không đổi theo DateStyle của phiên gọi).
--   chunk: try S(kỳ) → L → KEY SHARE NOWAIT · complete(close): X(P) → L · huỷ: batch → X → try L · dọn QA: X → L ·
--   begin_open / job_done / complete / fail / trial_cleanup: L (rồi mới khoá dòng run) · trigger chèn task: X(kỳ của task).
--
-- Hằng số thời gian (mặc định chờ stakeholder — đổi cùng lúc mọi chỗ, test qa-care-116 + realpg-race-116 bao phủ):
--   · 2 h  = tuổi tối đa của một lượt "đang chạy" (begin_open / sweep / begin_select / job_done / apply_chunk / complete /
--            dọn QA + gate D1) — TODO(Q-188);
--   · 30 phút sau P_end = mở khung tự chốt (CHECK care_order_runs_close_bounds_ck + begin_open_at) — TODO(Q-191);
--   · 24 h sau P_end = hết khung tự chốt ⇒ CLOSE_WINDOW_MISSED (begin_open_at + sweep) — TODO(Q-188 / Q-191);
--   · 24 h = "Chưa cập nhật" (RPC đọc: lagging) + gate D1 last_success_at — TODO(Q-183);
--   · 3 s / 4 s = chờ X(P) / L trong complete(close) (dưới statement_timeout 8 s của PostgREST) — TODO(Q-196).
-- Idempotent: chạy lại an toàn (IF NOT EXISTS, CREATE OR REPLACE, DROP/CREATE TRIGGER, ON CONFLICT DO NOTHING).
-- Preflight: app_migrations có 115, không có bản > 116; PG ≥ 13; current_user = owner care_tasks; mọi care_* cùng owner;
-- md5 gate / assess ∈ {115, 116}, preview_at / cancel_at / finalize = 115; V0 = V0b = 0; coverage mồ côi = 0.
--
-- ROLLBACK: supabase/migrations/rollback/116_care_order_links_rollback_level1.sql (giữ bảng / dữ liệu / FK / trigger dọn
--   coverage / dọn QA; gate về 115; trả DELETE cho service_role) hoặc _level2.sql (PM duyệt mất link: gỡ toàn bộ E, assess
--   về nguyên văn 115). Cả hai DELETE app_migrations '116'. Không chạy lại 115 sau 116.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ── Preflight ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_owner oid;
  v_bad   text;
  v_md5   text;
  v_n     bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '115') THEN
    RAISE EXCEPTION '116: thiếu migration 115 — chạy đúng thứ tự';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE version ~ '^[0-9]+$' AND version::int > 116) THEN
    RAISE EXCEPTION '116: DB đã có migration > 116 — dừng';
  END IF;
  IF current_setting('server_version_num')::int < 130000 THEN
    RAISE EXCEPTION '116: cần PostgreSQL ≥ 13';
  END IF;
  SELECT relowner INTO v_owner FROM pg_catalog.pg_class WHERE oid = 'public.care_tasks'::regclass;
  IF current_user <> pg_catalog.pg_get_userbyid(v_owner) THEN
    RAISE EXCEPTION '116: phải chạy bằng owner của care_tasks (%), đang là %', pg_catalog.pg_get_userbyid(v_owner), current_user;
  END IF;
  SELECT string_agg(c.relname, ',') INTO v_bad FROM pg_catalog.pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'care\_%' AND c.relkind IN ('r', 'S') AND c.relowner <> v_owner;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION '116: bảng/sequence care_* khác owner: %', v_bad; END IF;
  IF to_char(date '2026-10-01', 'YYYY-MM-DD') <> (date '2026-10-01')::text THEN
    RAISE EXCEPTION '116: DateStyle của phiên migration không phải ISO (%), key khoá kỳ sẽ lệch 115', current_setting('DateStyle');
  END IF;

  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_cancel_gate(uuid,uuid,date)'::regprocedure;
  IF v_md5 NOT IN ('7ac1b8c50d7e8616183cce2159730062', '04c8d4081bb2f3e99ebd5cb07b3a5a54') THEN
    RAISE EXCEPTION '116: care__import_cancel_gate trên DB khác bản 115/116 (md5 %) — dừng, đối chiếu thủ công', v_md5;
  END IF;
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_cancel_assess(uuid)'::regprocedure;
  IF v_md5 NOT IN ('f3c441c3de1bd5bdd84383e460f7c942', '19c8ae8c5a171a29fd9ca16509a3e0cd') THEN
    RAISE EXCEPTION '116: care__import_cancel_assess trên DB khác bản 115/116 (md5 %)', v_md5;
  END IF;
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_cancel_preview_at(uuid,uuid,date)'::regprocedure;
  IF v_md5 <> 'c677877af50abf80d89505fb2bad8711' THEN RAISE EXCEPTION '116: care__import_cancel_preview_at khác bản 115 (md5 %)', v_md5; END IF;
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_cancel_at(uuid,uuid,bigint,date,timestamptz)'::regprocedure;
  IF v_md5 <> 'b803576d0c6ac75fd068aa7d1128643c' THEN RAISE EXCEPTION '116: care__import_cancel_at khác bản 115 (md5 %)', v_md5; END IF;
  -- Rào chèn task dựa trên việc finalize 115 giữ khoá X kỳ từ TRƯỚC khi chèn task tới khi commit.
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_finalize_at(uuid,uuid,date)'::regprocedure;
  IF v_md5 <> '971ef429c7c12118b5d4029ba41032c1' THEN RAISE EXCEPTION '116: care__import_finalize_at khác bản 115 (md5 %)', v_md5; END IF;
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__close_period_at(date)'::regprocedure;
  IF v_md5 <> '022049c0cbed01e8263915e4f967fbb0' THEN RAISE EXCEPTION '116: care__close_period_at khác bản 115 (md5 %)', v_md5; END IF;

  -- V0: mốc import của task = finished_at của batch tạo nó (cutoff đơn). V0b (I1): kỳ của task = kỳ VN của created_at.
  SELECT count(*) INTO v_n FROM public.care_tasks t JOIN public.care_import_batches b ON b.id = t.batch_id
  WHERE b.finished_at IS NULL OR t.created_at <> b.finished_at;
  IF v_n <> 0 THEN RAISE EXCEPTION '116: V0 — % task có created_at khác finished_at của batch', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.care_tasks t
  WHERE t.period_month <> date_trunc('month', t.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  IF v_n <> 0 THEN RAISE EXCEPTION '116: V0b — % task có period_month khác kỳ VN của created_at', v_n; END IF;
  -- Chạy lại sau rollback mức 1: không còn coverage / link trỏ task đã xoá.
  IF to_regclass('public.care_order_task_coverage') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.care_order_task_coverage c WHERE NOT EXISTS (SELECT 1 FROM public.care_tasks t WHERE t.id = c.task_id)' INTO v_n;
    IF v_n <> 0 THEN RAISE EXCEPTION '116: % coverage mồ côi', v_n; END IF;
  END IF;
  IF to_regclass('public.care_order_links') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.care_order_links l WHERE NOT EXISTS (SELECT 1 FROM public.care_tasks t WHERE t.id = l.task_id)' INTO v_n;
    IF v_n <> 0 THEN RAISE EXCEPTION '116: % link mồ côi', v_n; END IF;
  END IF;
END $$;

-- Tuần tự hoá với finalize / đóng kỳ / huỷ của kỳ hiện tại (cùng key 115).
SELECT pg_advisory_xact_lock(hashtextextended('care_import:' || to_char(public.care_period_of(public.care_vn_today()), 'YYYY-MM-DD'), 0));

-- ── 1. Hàm biên kỳ + định dạng thời điểm ───────────────────────────────────
-- P_end = 00:00 VN ngày 1 kỳ sau (= 17:00 UTC ngày cuối kỳ). Asia/Ho_Chi_Minh không có DST. Dùng ở CHECK, apply_chunk, RPC đọc.
CREATE OR REPLACE FUNCTION public.care_period_end(p_period date)
RETURNS timestamptz LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = public AS $$
  SELECT ((p_period + interval '1 month')::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
$$;

-- Thời điểm dạng chuẩn UTC 6 chữ số lẻ (µs) — app truyền nguyên chuỗi này cho BigQuery / keyset, không đi qua JS Date.
CREATE OR REPLACE FUNCTION public.care__utc_us(p_at timestamptz)
RETURNS text LANGUAGE sql STABLE STRICT SET search_path = public AS $$
  SELECT to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- ── 2. Bảng (owner-only) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.care_order_runs (
  run_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('regular', 'close')),
  mode             text NOT NULL CHECK (mode IN ('apply', 'trial')),
  period_month     date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  snapshot_at      timestamptz NOT NULL,
  upper_bound      timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing', 'running', 'complete', 'failed', 'abandoned')),
  per_customer_cap integer NOT NULL CHECK (per_customer_cap BETWEEN 1 AND 5000),
  is_retry         boolean NOT NULL DEFAULT false,
  tasks_expected   integer CHECK (tasks_expected >= 0),
  jobs_expected    integer CHECK (jobs_expected >= 0),
  chunks_applied   integer NOT NULL DEFAULT 0 CHECK (chunks_applied >= 0),
  max_age_minutes  integer,
  error_code       text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  started_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at      timestamptz,
  -- Biên kỳ do DB ép (E0 §2/§3): kỳ lượt thường suy từ snapshot (inline, không gọi care_vn_date STABLE).
  CONSTRAINT care_order_runs_regular_bounds_ck CHECK (kind <> 'regular' OR (
    period_month = date_trunc('month', snapshot_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
    AND upper_bound = snapshot_at AND snapshot_at < public.care_period_end(period_month))),
  CONSTRAINT care_order_runs_close_bounds_ck CHECK (kind <> 'close' OR (
    upper_bound = public.care_period_end(period_month) AND snapshot_at >= upper_bound + interval '30 minutes')),
  CONSTRAINT care_order_runs_finished_ck CHECK ((status IN ('preparing', 'running')) = (finished_at IS NULL)),
  CONSTRAINT care_order_runs_running_ck CHECK (status = 'preparing' OR status = 'abandoned' OR status = 'failed'
                                               OR (tasks_expected IS NOT NULL AND jobs_expected IS NOT NULL)),
  CONSTRAINT care_order_runs_error_ck CHECK ((status IN ('failed', 'abandoned')) = (error_code IS NOT NULL)),
  CONSTRAINT care_order_runs_retry_ck CHECK (NOT is_retry OR (kind = 'close' AND mode = 'apply'))
);
-- Một lượt đang chạy mỗi (kind, mode): lượt thường không chặn lượt chốt và ngược lại (E0 §2).
CREATE UNIQUE INDEX IF NOT EXISTS care_order_runs_running_uq ON public.care_order_runs (kind, mode) WHERE status IN ('preparing', 'running');
CREATE INDEX IF NOT EXISTS care_order_runs_period_idx ON public.care_order_runs (kind, mode, period_month, run_id DESC);

CREATE TABLE IF NOT EXISTS public.care_order_period_state (
  period_month   date PRIMARY KEY CHECK (period_month = date_trunc('month', period_month)::date),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'close_failed')),
  close_run_id   bigint REFERENCES public.care_order_runs(run_id),
  closed_at      timestamptz,
  closed_through timestamptz,
  last_error     text CHECK (last_error ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT care_order_period_state_closed_ck CHECK ((status = 'closed') = (close_run_id IS NOT NULL AND closed_at IS NOT NULL AND closed_through IS NOT NULL)),
  CONSTRAINT care_order_period_state_through_ck CHECK (closed_through IS NULL OR closed_through = public.care_period_end(period_month)),
  CONSTRAINT care_order_period_state_failed_ck CHECK (status <> 'close_failed' OR last_error IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.care_order_run_tasks (
  run_id       bigint NOT NULL REFERENCES public.care_order_runs(run_id) ON DELETE CASCADE,
  task_id      uuid NOT NULL,
  external_id  text NOT NULL,
  lo           timestamptz NOT NULL,
  job_no       integer NOT NULL CHECK (job_no >= 1),
  chunk_no     integer CHECK (chunk_no >= 1),
  trial_orders integer CHECK (trial_orders >= 0),
  PRIMARY KEY (run_id, task_id),
  CONSTRAINT care_order_run_tasks_ext_uq UNIQUE (run_id, external_id)
);
CREATE INDEX IF NOT EXISTS care_order_run_tasks_job_idx ON public.care_order_run_tasks (run_id, job_no);

CREATE TABLE IF NOT EXISTS public.care_order_run_jobs (
  run_id             bigint NOT NULL REFERENCES public.care_order_runs(run_id) ON DELETE CASCADE,
  job_no             integer NOT NULL CHECK (job_no >= 1),
  tasks              integer NOT NULL CHECK (tasks BETWEEN 1 AND 10000),
  params_sha256      text NOT NULL CHECK (params_sha256 ~ '^[0-9a-f]{64}$'),
  bq_total_rows      integer CHECK (bq_total_rows >= 0),
  duplicates_dropped integer CHECK (duplicates_dropped >= 0),
  done_at            timestamptz,
  PRIMARY KEY (run_id, job_no),
  CONSTRAINT care_order_run_jobs_done_ck CHECK ((done_at IS NULL) = (bq_total_rows IS NULL) AND (done_at IS NULL) = (duplicates_dropped IS NULL)),
  CONSTRAINT care_order_run_jobs_dup_ck CHECK (duplicates_dropped IS NULL OR duplicates_dropped <= bq_total_rows)
);

CREATE TABLE IF NOT EXISTS public.care_order_run_chunks (
  run_id         bigint NOT NULL REFERENCES public.care_order_runs(run_id) ON DELETE CASCADE,
  chunk_no       integer NOT NULL CHECK (chunk_no >= 1),
  job_no         integer NOT NULL CHECK (job_no >= 1),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  customers      integer NOT NULL CHECK (customers BETWEEN 1 AND 2000),
  rows_received  integer NOT NULL CHECK (rows_received BETWEEN 0 AND 5000),
  links_inserted integer NOT NULL DEFAULT 0 CHECK (links_inserted >= 0),
  links_updated  integer NOT NULL DEFAULT 0 CHECK (links_updated >= 0),
  relink_refused integer NOT NULL DEFAULT 0 CHECK (relink_refused >= 0),
  applied_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, chunk_no)
);

-- Mốc đã quét theo task (không FK — dọn bằng trigger AFTER DELETE, E0 §10a). Cập nhật mỗi lượt ⇒ fillfactor 80 (HOT).
CREATE TABLE IF NOT EXISTS public.care_order_task_coverage (
  task_id       uuid PRIMARY KEY,
  covered_until timestamptz NOT NULL,
  run_id        bigint NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 80);

CREATE TABLE IF NOT EXISTS public.care_order_links (
  link_id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_key            text NOT NULL CHECK (char_length(order_key) BETWEEN 1 AND 200 AND order_key = btrim(order_key)),
  customer_external_id text NOT NULL CHECK (char_length(customer_external_id) BETWEEN 1 AND 100
                                            AND customer_external_id = btrim(customer_external_id)),
  ordered_at           timestamptz NOT NULL,
  task_id              uuid NOT NULL REFERENCES public.care_tasks(id) ON DELETE RESTRICT,
  is_test              boolean NOT NULL,
  first_run_id         bigint NOT NULL,
  updated_run_id       bigint NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT care_order_links_order_key_uq UNIQUE (order_key)
);
CREATE INDEX IF NOT EXISTS care_order_links_task_idx ON public.care_order_links (task_id, ordered_at DESC, link_id DESC);
CREATE INDEX IF NOT EXISTS care_order_links_customer_idx ON public.care_order_links (customer_external_id);

ALTER TABLE public.care_order_runs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_order_period_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_order_run_tasks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_order_run_jobs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_order_run_chunks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_order_task_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_order_links         ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.care_order_runs, public.care_order_period_state, public.care_order_run_tasks, public.care_order_run_jobs,
  public.care_order_run_chunks, public.care_order_task_coverage, public.care_order_links
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.care_order_runs_run_id_seq, public.care_order_links_link_id_seq FROM PUBLIC, anon, authenticated, service_role;
-- Owner-only: thu hồi MỌI quyền của mọi role khác owner (kể cả quyền do default privileges cấp, vd. cho postgres — như 115).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel, x.grantee
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname IN ('care_order_links', 'care_order_period_state', 'care_order_runs', 'care_order_run_tasks', 'care_order_run_jobs',
                        'care_order_run_chunks', 'care_order_task_coverage', 'care_order_runs_run_id_seq', 'care_order_links_link_id_seq')
      AND x.grantee <> c.relowner
    GROUP BY c.oid, x.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', r.rel);
    ELSE
      EXECUTE format('REVOKE ALL ON %s FROM %I', r.rel, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- ── 3. Trigger trên bảng 114 ─────────────────────────────────────────────────
-- Mốc import (cutoff đơn) + khách + kỳ của task bất biến (E0 §3). INVOKER; EXECUTE không cấp ai.
CREATE OR REPLACE FUNCTION public.care__tasks_freeze_cutoff()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.period_month IS DISTINCT FROM OLD.period_month THEN
    RAISE EXCEPTION 'CARE_TASK_CUTOFF_FROZEN — care_tasks: không đổi created_at / customer_id / period_month (mốc đơn sau import)';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.care__customers_freeze_external_id()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF NEW.external_id IS DISTINCT FROM OLD.external_id THEN
    RAISE EXCEPTION 'CARE_CUSTOMER_ID_FROZEN — care_customers: không đổi external_id (khoá đối chiếu đơn N3)';
  END IF;
  RETURN NEW;
END $$;

-- Rào chèn task vào kỳ đã chốt dữ liệu đơn (E0 §3, PM r3.3.1 P1). Trigger AFTER INSERT … FOR EACH STATEMENT với transition table
-- (đo PG 15: bản theo dòng thêm ~48 µs/task — +40 % finalize 10.000 khách; bản theo lệnh O(số kỳ)). Thứ tự bắt buộc:
--   1. chỉ READ COMMITTED: REPEATABLE READ / SERIALIZABLE giữ snapshot từ đầu transaction ⇒ có thể đọc trạng thái kỳ cũ ⇒ từ chối;
--   2. với MỖI kỳ có trong lệnh (theo thứ tự — cùng thứ tự với care_qa_delete_test_tasks): khoá X care_import:<kỳ> — CÙNG key
--      finalize / đóng kỳ / complete(close); finalize đã giữ ⇒ reentrant; INSERT trực tiếp chờ complete(close) commit xong;
--   3. SAU khoá mới đọc trạng thái: hàm VOLATILE ở READ COMMITTED lấy snapshot mới cho từng câu ⇒ thấy 'closed' vừa commit
--      ⇒ RAISE ⇒ cả lệnh (và transaction) rollback. Dòng đã chèn trong lệnh chưa commit nên lượt chốt không đếm được chúng.
-- Không bảo vệ owner/superuser chủ động DISABLE trigger (VERIFY V4 phát hiện).
CREATE OR REPLACE FUNCTION public.care__tasks_block_closed_period()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_p date;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CARE_TASK_INSERT_ISOLATION — care_tasks: chỉ chèn task ở READ COMMITTED (đang %)', current_setting('transaction_isolation');
  END IF;
  FOR v_p IN SELECT DISTINCT n.period_month FROM care_new_tasks n ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('care_import:' || to_char(v_p, 'YYYY-MM-DD'), 0));
    IF EXISTS (SELECT 1 FROM public.care_order_period_state s WHERE s.period_month = v_p AND s.status = 'closed') THEN
      RAISE EXCEPTION 'PERIOD_CLOSED_FOR_ORDERS — care_tasks: kỳ % đã chốt dữ liệu đơn, không thêm task', to_char(v_p, 'YYYY-MM');
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- Dọn coverage của task bị xoá trong CÙNG transaction (huỷ D1, dọn QA). Không dùng FK CASCADE: FK khiến mỗi lần ghi coverage
-- lấy KEY SHARE lên mọi task của chunk (E0 §10a).
CREATE OR REPLACE FUNCTION public.care__tasks_drop_order_coverage()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.care_order_task_coverage WHERE task_id = OLD.id;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS care_tasks_freeze_cutoff ON public.care_tasks;
CREATE TRIGGER care_tasks_freeze_cutoff BEFORE UPDATE OF created_at, customer_id, period_month ON public.care_tasks
  FOR EACH ROW EXECUTE FUNCTION public.care__tasks_freeze_cutoff();
DROP TRIGGER IF EXISTS care_tasks_block_closed_period ON public.care_tasks;
CREATE TRIGGER care_tasks_block_closed_period AFTER INSERT ON public.care_tasks
  REFERENCING NEW TABLE AS care_new_tasks
  FOR EACH STATEMENT EXECUTE FUNCTION public.care__tasks_block_closed_period();
DROP TRIGGER IF EXISTS care_tasks_drop_order_coverage ON public.care_tasks;
CREATE TRIGGER care_tasks_drop_order_coverage AFTER DELETE ON public.care_tasks
  FOR EACH ROW EXECUTE FUNCTION public.care__tasks_drop_order_coverage();
DROP TRIGGER IF EXISTS care_customers_freeze_external_id ON public.care_customers;
CREATE TRIGGER care_customers_freeze_external_id BEFORE UPDATE OF external_id ON public.care_customers
  FOR EACH ROW EXECUTE FUNCTION public.care__customers_freeze_external_id();
ALTER TABLE public.care_tasks ENABLE ALWAYS TRIGGER care_tasks_freeze_cutoff;
ALTER TABLE public.care_tasks ENABLE ALWAYS TRIGGER care_tasks_block_closed_period;
ALTER TABLE public.care_tasks ENABLE ALWAYS TRIGGER care_tasks_drop_order_coverage;
ALTER TABLE public.care_customers ENABLE ALWAYS TRIGGER care_customers_freeze_external_id;

-- ── 4. Lượt đồng bộ (service_role) ───────────────────────────────────────────
-- "Đang chạy" ≡ preparing/running và started_at trong 2 h (clock_timestamp). Mọi kết cục không thành công của lượt
-- chốt apply ghi close_failed trong CÙNG transaction, luôn kèm status <> 'closed' ('closed' là trạng thái cuối).
-- TODO(Q-188): mặc định — mọi kết cục không thành công ⇒ close_failed, không tự chạy lại; RUN_IN_PROGRESS không đổi state.
-- TODO(Q-193): lượt chốt lỗi giữa chừng ⇒ task đã áp giữ mốc riêng (như Q-181), kỳ vẫn close_failed.

-- Kết thúc một run đang chạy với trạng thái lỗi + ghi trạng thái nguồn. Caller giữ L. Run không còn chạy ⇒ false (no-op).
CREATE OR REPLACE FUNCTION public.care__order_links_end_run(p_run_id bigint, p_code text, p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r public.care_order_runs%ROWTYPE;
BEGIN
  IF p_status NOT IN ('failed', 'abandoned') OR p_code IS NULL OR p_code !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'care__order_links_end_run: tham số sai';
  END IF;
  UPDATE public.care_order_runs SET status = p_status, error_code = p_code, finished_at = clock_timestamp()
  WHERE run_id = p_run_id AND status IN ('preparing', 'running')
  RETURNING * INTO r;
  IF NOT FOUND THEN RETURN false; END IF;
  IF r.mode = 'apply' AND r.kind = 'regular' THEN
    -- Chỉ khi lượt này MỚI HƠN kết quả đã ghi (như care_order_sync_fail 114); không đụng last_success_at.
    INSERT INTO public.care_sync_state AS s (source, last_success_at, last_error, updated_at)
    VALUES ('n3_import_orders', NULL, p_code, r.snapshot_at)
    ON CONFLICT (source) DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = EXCLUDED.updated_at
      WHERE EXCLUDED.updated_at > s.updated_at;
  ELSIF r.mode = 'apply' AND r.kind = 'close' THEN
    UPDATE public.care_order_period_state SET status = 'close_failed', last_error = p_code, updated_at = now()
    WHERE period_month = r.period_month AND status <> 'closed';
  END IF;
  RETURN true;
END $$;

-- Luật lỡ khung (E0 §4.2), dưới L, chỉ đường apply: (1) lượt chốt apply quá 2 h ⇒ abandoned + close_failed RUN_ABANDONED;
-- (2) kỳ còn 'active' đã quá P_end + 24 h, không có lượt chốt apply đang chạy ⇒ close_failed CLOSE_WINDOW_MISSED.
CREATE OR REPLACE FUNCTION public.care__order_links_sweep(p_now timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id bigint;
  v_n  integer := 0;
  v_k  integer;
BEGIN
  FOR v_id IN SELECT run_id FROM public.care_order_runs
              WHERE kind = 'close' AND mode = 'apply' AND status IN ('preparing', 'running')
                AND started_at <= clock_timestamp() - interval '2 hours'
              ORDER BY run_id FOR UPDATE LOOP
    IF public.care__order_links_end_run(v_id, 'RUN_ABANDONED', 'abandoned') THEN v_n := v_n + 1; END IF;
  END LOOP;
  UPDATE public.care_order_period_state s SET status = 'close_failed', last_error = 'CLOSE_WINDOW_MISSED', updated_at = now()
  WHERE s.status = 'active' AND p_now >= public.care_period_end(s.period_month) + interval '24 hours'
    AND NOT EXISTS (SELECT 1 FROM public.care_order_runs r
                    WHERE r.kind = 'close' AND r.mode = 'apply' AND r.period_month = s.period_month
                      AND r.status IN ('preparing', 'running') AND r.started_at > clock_timestamp() - interval '2 hours');
  GET DIAGNOSTICS v_k = ROW_COUNT;
  RETURN v_n + v_k;
END $$;

-- Mở lượt (E0 §4.1 bước 1). p_now chỉ để test biên (bản _at không cấp cho role nào); wrapper luôn dùng clock_timestamp().
-- Trả jsonb: ok (run mới) · busy RUN_IN_PROGRESS (không ghi state) · skipped CLOSE_NOT_ELIGIBLE (không ghi state).
CREATE OR REPLACE FUNCTION public.care__order_links_begin_open_at(p_kind text, p_mode text, p_retry_period date,
                                                                  p_per_customer_cap integer, p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_now    timestamptz;
  v_cur    date;
  v_period date;
  v_upper  timestamptz;
  v_id     bigint;
  v_swept  integer := 0;
  st       public.care_order_period_state%ROWTYPE;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('regular', 'close') OR p_mode IS NULL OR p_mode NOT IN ('apply', 'trial')
     OR p_per_customer_cap IS NULL OR p_per_customer_cap NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'care_order_links_begin_open: tham số sai';
  END IF;
  IF p_retry_period IS NOT NULL AND (p_kind <> 'close' OR p_mode <> 'apply') THEN
    RAISE EXCEPTION 'care_order_links_begin_open: chỉ lượt chốt apply nhận kỳ chạy lại';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('care_order_links', 0));
  v_now := COALESCE(p_now, clock_timestamp());
  v_cur := date_trunc('month', v_now AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  IF p_kind = 'regular' THEN
    v_period := v_cur;
    v_upper := v_now;
  ELSE
    v_period := (v_cur - interval '1 month')::date;
    v_upper := public.care_period_end(v_period);
  END IF;

  -- Lượt cùng (kind, mode) quá 2 h ⇒ abandoned (close/apply ⇒ close_failed RUN_ABANDONED nếu kỳ chưa closed).
  FOR v_id IN SELECT run_id FROM public.care_order_runs
              WHERE kind = p_kind AND mode = p_mode AND status IN ('preparing', 'running')
                AND started_at <= clock_timestamp() - interval '2 hours'
              ORDER BY run_id FOR UPDATE LOOP
    PERFORM public.care__order_links_end_run(v_id, 'RUN_ABANDONED', 'abandoned');
  END LOOP;
  IF p_mode = 'apply' THEN
    -- Kỳ trước chưa có trạng thái và không cũ hơn kỳ go-live E ⇒ tạo 'active' (TRƯỚC luật lỡ khung).
    IF p_kind = 'close' THEN
      INSERT INTO public.care_order_period_state (period_month, status)
      SELECT v_period, 'active' WHERE EXISTS (SELECT 1 FROM public.care_order_period_state x WHERE x.period_month <= v_period)
      ON CONFLICT (period_month) DO NOTHING;
    END IF;
    v_swept := public.care__order_links_sweep(v_now);
  END IF;
  IF EXISTS (SELECT 1 FROM public.care_order_runs WHERE kind = p_kind AND mode = p_mode AND status IN ('preparing', 'running')) THEN
    RETURN jsonb_build_object('status', 'busy', 'code', 'RUN_IN_PROGRESS', 'swept', v_swept);
  END IF;

  IF p_kind = 'close' THEN
    SELECT * INTO st FROM public.care_order_period_state WHERE period_month = v_period FOR UPDATE;
    IF p_mode = 'apply' THEN
      -- Tự chốt: 'active' trong khung [P_end + 30', P_end + 24 h). Chạy lại: chỉ 'close_failed' + header đúng kỳ.
      -- TODO(Q-191): khung 00:40 VN + 24 h là mặc định Dev — chốt sau khi operator xác nhận giờ Coolify.
      IF NOT FOUND OR NOT (
           (st.status = 'active' AND p_retry_period IS NULL
            AND v_now >= v_upper + interval '30 minutes' AND v_now < v_upper + interval '24 hours')
        OR (st.status = 'close_failed' AND p_retry_period IS NOT DISTINCT FROM v_period)) THEN
        RETURN jsonb_build_object('status', 'skipped', 'code', 'CLOSE_NOT_ELIGIBLE', 'period_month', v_period,
                                  'period_status', COALESCE(st.status, 'none'), 'swept', v_swept);
      END IF;
    ELSIF (FOUND AND st.status = 'closed') OR v_now < v_upper + interval '30 minutes' THEN
      RETURN jsonb_build_object('status', 'skipped', 'code', 'CLOSE_NOT_ELIGIBLE', 'period_month', v_period,
                                'period_status', COALESCE(st.status, 'none'), 'swept', v_swept);
    END IF;
  END IF;

  INSERT INTO public.care_order_runs (kind, mode, period_month, snapshot_at, upper_bound, per_customer_cap, is_retry)
  VALUES (p_kind, p_mode, v_period, v_now, v_upper, p_per_customer_cap, p_retry_period IS NOT NULL)
  RETURNING run_id INTO v_id;
  RETURN jsonb_build_object('status', 'ok', 'run_id', v_id, 'kind', p_kind, 'mode', p_mode, 'period_month', v_period,
                            'snapshot_at', public.care__utc_us(v_now), 'upper_bound', public.care__utc_us(v_upper),
                            'is_close', p_kind = 'close', 'per_customer_cap', p_per_customer_cap, 'swept', v_swept);
END $$;

CREATE OR REPLACE FUNCTION public.care_order_links_begin_open(p_kind text, p_mode text, p_retry_period date DEFAULT NULL,
                                                              p_per_customer_cap integer DEFAULT 5000)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.care__order_links_begin_open_at(p_kind, p_mode, p_retry_period, p_per_customer_cap, NULL)
$$;

-- Tham số BigQuery của một job ở dạng chuẩn (độ dài byte + giá trị ⇒ không mơ hồ; thời điểm µs UTC; COLLATE "C").
CREATE OR REPLACE FUNCTION public.care__order_links_params_sha(p_run_id bigint, p_job_no integer)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT encode(sha256(convert_to(
           'care-order-links/v1' || chr(10) || public.care__utc_us(r.upper_bound) || chr(10)
           || CASE WHEN r.kind = 'close' THEN '1' ELSE '0' END || chr(10) || r.per_customer_cap::text || chr(10)
           || COALESCE((SELECT string_agg(octet_length(rt.external_id)::text || ':' || rt.external_id || '|' || public.care__utc_us(rt.lo),
                                          chr(10) ORDER BY rt.external_id COLLATE "C")
                        FROM public.care_order_run_tasks rt WHERE rt.run_id = r.run_id AND rt.job_no = p_job_no), ''),
           'UTF8')), 'hex')
  FROM public.care_order_runs r WHERE r.run_id = p_run_id
$$;

-- Chọn tập task của lượt (E0 §4.1 bước 2), ngoài L: một câu lệnh ghi run_tasks = MỌI task của kỳ run (mọi status, gồm
-- is_test) có created_at < snapshot_at. Vượt trần ⇒ RAISE TASKS_OVER_CAP (rollback; app gọi fail). GC run cũ.
CREATE OR REPLACE FUNCTION public.care_order_links_begin_select(p_run_id bigint, p_max_tasks integer, p_max_age_minutes integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r      public.care_order_runs%ROWTYPE;
  v_n    integer;
  v_jobs integer;
  v_gc   integer;
BEGIN
  IF p_max_tasks IS NULL OR p_max_tasks NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'care_order_links_begin_select: trần sai'; END IF;
  SELECT * INTO r FROM public.care_order_runs WHERE run_id = p_run_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'preparing' OR r.started_at <= clock_timestamp() - interval '2 hours' THEN
    RAISE EXCEPTION 'RUN_NOT_PREPARING — care_order_links_begin_select: run không ở preparing';
  END IF;
  -- GC (chỉ run apply — trial do trial_cleanup dọn dưới L): giữ run đang chạy, run kết thúc gần nhất + run complete gần nhất mỗi
  -- (kind, mode), run được period_state tham chiếu.
  DELETE FROM public.care_order_runs x
  WHERE x.mode = 'apply' AND x.status NOT IN ('preparing', 'running')
    AND x.run_id <> ALL (ARRAY(
          SELECT max(y.run_id) FROM public.care_order_runs y WHERE y.status NOT IN ('preparing', 'running') GROUP BY y.kind, y.mode
          UNION ALL
          SELECT max(y.run_id) FROM public.care_order_runs y WHERE y.status = 'complete' GROUP BY y.kind, y.mode
          UNION ALL
          SELECT s.close_run_id FROM public.care_order_period_state s WHERE s.close_run_id IS NOT NULL));
  GET DIAGNOSTICS v_gc = ROW_COUNT;

  -- TODO(Q-178): mốc (lo) = care_tasks.created_at = lúc BẮT ĐẦU transaction finalize của batch tạo task — với task mới do
  -- revision tạo là lúc bắt đầu finalize của revision. TODO(Q-190): đơn sau 00:00 ngày 1 mà trước import kỳ mới không gắn task nào.
  INSERT INTO public.care_order_run_tasks (run_id, task_id, external_id, lo, job_no)
  SELECT r.run_id, t.id, c.external_id, t.created_at,
         ((row_number() OVER (ORDER BY c.external_id COLLATE "C") - 1) / 10000)::integer + 1
  FROM public.care_tasks t JOIN public.care_customers c ON c.id = t.customer_id
  WHERE t.period_month = r.period_month AND t.created_at < r.snapshot_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > p_max_tasks THEN
    RAISE EXCEPTION 'TASKS_OVER_CAP — care_order_links_begin_select: % task > trần %', v_n, p_max_tasks;
  END IF;
  v_jobs := (v_n + 9999) / 10000;
  INSERT INTO public.care_order_run_jobs (run_id, job_no, tasks, params_sha256)
  SELECT r.run_id, g.job_no, g.n, public.care__order_links_params_sha(r.run_id, g.job_no)
  FROM (SELECT rt.job_no, count(*)::integer AS n FROM public.care_order_run_tasks rt WHERE rt.run_id = r.run_id GROUP BY rt.job_no) g;
  UPDATE public.care_order_runs SET status = 'running', tasks_expected = v_n, jobs_expected = v_jobs, max_age_minutes = p_max_age_minutes
  WHERE run_id = r.run_id;
  RETURN jsonb_build_object('status', 'running', 'run_id', r.run_id, 'tasks', v_n, 'jobs', v_jobs, 'gc_runs', v_gc);
END $$;

-- Tham số BigQuery của một job (mảng song song theo external_id COLLATE "C") — trả MỘT jsonb (PostgREST không cắt).
CREATE OR REPLACE FUNCTION public.care_order_links_run_job(p_run_id bigint, p_job_no integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
           'run_id', r.run_id, 'job_no', j.job_no, 'tasks', j.tasks, 'params_sha256', j.params_sha256,
           'upper_bound', public.care__utc_us(r.upper_bound), 'is_close', r.kind = 'close', 'per_customer_cap', r.per_customer_cap,
           'min_lo', (SELECT public.care__utc_us(min(rt.lo)) FROM public.care_order_run_tasks rt WHERE rt.run_id = r.run_id AND rt.job_no = j.job_no),
           'customer_ids', (SELECT jsonb_agg(rt.external_id ORDER BY rt.external_id COLLATE "C")
                            FROM public.care_order_run_tasks rt WHERE rt.run_id = r.run_id AND rt.job_no = j.job_no),
           'from_ts', (SELECT jsonb_agg(public.care__utc_us(rt.lo) ORDER BY rt.external_id COLLATE "C")
                       FROM public.care_order_run_tasks rt WHERE rt.run_id = r.run_id AND rt.job_no = j.job_no))
  FROM public.care_order_runs r JOIN public.care_order_run_jobs j ON j.run_id = r.run_id AND j.job_no = p_job_no
  WHERE r.run_id = p_run_id AND r.status = 'running'
$$;

-- Xác nhận đã đọc đủ một job (E0 §4.1 bước 6): DB so params_sha256 với run_tasks; 0 ≤ duplicates_dropped ≤ bq_total_rows.
CREATE OR REPLACE FUNCTION public.care_order_links_job_done(p_run_id bigint, p_job_no integer, p_bq_total_rows integer,
                                                            p_duplicates_dropped integer, p_params_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r public.care_order_runs%ROWTYPE;
  j public.care_order_run_jobs%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('care_order_links', 0));
  SELECT * INTO r FROM public.care_order_runs WHERE run_id = p_run_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'running' OR r.started_at <= clock_timestamp() - interval '2 hours' THEN
    RAISE EXCEPTION 'RUN_NOT_RUNNING — care_order_links_job_done: run không chạy';
  END IF;
  SELECT * INTO j FROM public.care_order_run_jobs WHERE run_id = p_run_id AND job_no = p_job_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOB_NOT_FOUND — care_order_links_job_done: không có job'; END IF;
  IF p_bq_total_rows IS NULL OR p_duplicates_dropped IS NULL OR p_bq_total_rows < 0 OR p_duplicates_dropped < 0
     OR p_duplicates_dropped > p_bq_total_rows THEN
    RAISE EXCEPTION 'JOB_COUNTS_INVALID — care_order_links_job_done: số đếm sai';
  END IF;
  IF p_params_sha256 IS DISTINCT FROM j.params_sha256
     OR j.params_sha256 IS DISTINCT FROM public.care__order_links_params_sha(p_run_id, p_job_no) THEN
    RAISE EXCEPTION 'JOB_PARAMS_MISMATCH — care_order_links_job_done: tham số BigQuery khác tập task của job';
  END IF;
  IF j.done_at IS NOT NULL THEN
    IF (j.bq_total_rows, j.duplicates_dropped) = (p_bq_total_rows, p_duplicates_dropped) THEN
      RETURN jsonb_build_object('status', 'duplicate');
    END IF;
    RAISE EXCEPTION 'JOB_ALREADY_DONE — care_order_links_job_done: job đã xác nhận với số khác';
  END IF;
  UPDATE public.care_order_run_jobs SET bq_total_rows = p_bq_total_rows, duplicates_dropped = p_duplicates_dropped, done_at = clock_timestamp()
  WHERE run_id = p_run_id AND job_no = p_job_no;
  RETURN jsonb_build_object('status', 'ok');
END $$;

-- Áp một chunk (≤ 2.000 khách, ≤ 5.000 đơn) trong MỘT transaction (E0 §4.1 bước 7). Thứ tự khoá: try S(kỳ) → L (1 s) →
-- dòng run → KEY SHARE NOWAIT đúng task đích có link INSERT/UPDATE. Bận ⇒ {busy, CHUNK_BUSY} (app backoff ≥ 8 s).
-- Trial: không L / KEY SHARE, không ghi link / coverage / state — chỉ đếm đơn theo task.
CREATE OR REPLACE FUNCTION public.care_order_links_apply_chunk(p_run_id bigint, p_job_no integer, p_chunk_no integer,
                                                               p_customer_ids text[], p_orders jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET lock_timeout = '1s' AS $$
DECLARE
  r         public.care_order_runs%ROWTYPE;
  v_rows    integer;
  v_sha     text;
  v_prev    text;
  v_cur     date;
  v_tasks   uuid[];
  v_targets uuid[];
  v_locked  integer;
  v_n       integer;
  v_ins     integer := 0;
  v_upd     integer := 0;
  v_refused integer := 0;
  v_busy    constant jsonb := jsonb_build_object('status', 'busy', 'code', 'CHUNK_BUSY');
BEGIN
  -- 1. Dạng (chưa khoá).
  IF p_run_id IS NULL OR p_job_no IS NULL OR p_chunk_no IS NULL OR p_chunk_no < 1 OR p_customer_ids IS NULL
     OR p_orders IS NULL OR jsonb_typeof(p_orders) <> 'array'
     OR cardinality(p_customer_ids) NOT BETWEEN 1 AND 2000 OR array_position(p_customer_ids, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT x) FROM unnest(p_customer_ids) x) <> cardinality(p_customer_ids) THEN
    RAISE EXCEPTION 'CHUNK_INVALID — care_order_links_apply_chunk: tham số sai';
  END IF;
  v_rows := jsonb_array_length(p_orders);
  IF v_rows > 5000 THEN RAISE EXCEPTION 'CHUNK_INVALID — care_order_links_apply_chunk: > 5.000 đơn'; END IF;
  -- Đúng 3 key chuỗi; giá trị khớp CHECK của care_order_links NGAY tại đây (RAISE chung — không để CHECK ghi giá trị thô vào
  -- log Postgres, như 114); ordered_at đúng dạng chuẩn µs UTC 'Z'.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_orders) e
             WHERE CASE WHEN jsonb_typeof(e) <> 'object' THEN true
                        ELSE (SELECT count(*) FROM jsonb_object_keys(e)) <> 3
                          OR jsonb_typeof(e -> 'order_key') IS DISTINCT FROM 'string'
                          OR jsonb_typeof(e -> 'customer_external_id') IS DISTINCT FROM 'string'
                          OR jsonb_typeof(e -> 'ordered_at') IS DISTINCT FROM 'string'
                          OR char_length(e ->> 'order_key') NOT BETWEEN 1 AND 200 OR (e ->> 'order_key') <> btrim(e ->> 'order_key')
                          OR (e ->> 'ordered_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' END) THEN
    RAISE EXCEPTION 'CHUNK_INVALID — care_order_links_apply_chunk: đơn sai dạng';
  END IF;
  IF (SELECT count(DISTINCT e ->> 'order_key') FROM jsonb_array_elements(p_orders) e) <> v_rows THEN
    RAISE EXCEPTION 'CHUNK_DUPLICATE_ORDER_KEY — care_order_links_apply_chunk: payload trùng order_key';
  END IF;
  SELECT * INTO r FROM public.care_order_runs WHERE run_id = p_run_id;
  IF NOT FOUND OR r.status <> 'running' THEN RAISE EXCEPTION 'RUN_NOT_RUNNING — care_order_links_apply_chunk: run không chạy'; END IF;
  -- Mỗi đơn: khách ∈ chunk, đúng task của run, cửa sổ (lo, upper] (chốt: < upper) và < P_end của kỳ run.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_orders) e
             LEFT JOIN public.care_order_run_tasks rt ON rt.run_id = r.run_id AND rt.external_id = e ->> 'customer_external_id'
             WHERE NOT ((e ->> 'customer_external_id') = ANY (p_customer_ids)) OR rt.task_id IS NULL OR rt.job_no <> p_job_no
                OR (e ->> 'ordered_at')::timestamptz <= rt.lo
                OR (e ->> 'ordered_at')::timestamptz > r.upper_bound
                OR (r.kind = 'close' AND (e ->> 'ordered_at')::timestamptz >= r.upper_bound)
                OR (e ->> 'ordered_at')::timestamptz >= public.care_period_end(r.period_month)) THEN
    RAISE EXCEPTION 'CHUNK_ORDER_OUT_OF_WINDOW — care_order_links_apply_chunk: đơn ngoài cửa sổ task / kỳ';
  END IF;
  v_sha := encode(sha256(convert_to(jsonb_build_array(p_job_no, to_jsonb(p_customer_ids), p_orders)::text, 'UTF8')), 'hex');

  IF r.mode = 'trial' THEN
    SELECT * INTO r FROM public.care_order_runs WHERE run_id = p_run_id FOR UPDATE;
    IF r.status <> 'running' OR r.started_at <= clock_timestamp() - interval '2 hours' THEN
      RAISE EXCEPTION 'RUN_NOT_RUNNING — care_order_links_apply_chunk: run không chạy';
    END IF;
    SELECT payload_sha256 INTO v_prev FROM public.care_order_run_chunks WHERE run_id = p_run_id AND chunk_no = p_chunk_no;
    IF FOUND THEN
      IF v_prev = v_sha THEN RETURN jsonb_build_object('status', 'duplicate', 'mode', 'trial'); END IF;
      RAISE EXCEPTION 'CHUNK_CONFLICT — care_order_links_apply_chunk: chunk đã áp với payload khác';
    END IF;
    IF (SELECT count(*) FROM public.care_order_run_jobs WHERE run_id = p_run_id AND done_at IS NOT NULL) <> r.jobs_expected THEN
      RAISE EXCEPTION 'JOBS_NOT_DONE — care_order_links_apply_chunk: chưa đọc đủ mọi job';
    END IF;
    UPDATE public.care_order_run_tasks rt
    SET chunk_no = p_chunk_no,
        trial_orders = (SELECT count(*) FROM jsonb_array_elements(p_orders) e WHERE e ->> 'customer_external_id' = rt.external_id)
    WHERE rt.run_id = p_run_id AND rt.job_no = p_job_no AND rt.external_id = ANY (p_customer_ids) AND rt.chunk_no IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> cardinality(p_customer_ids) THEN
      RAISE EXCEPTION 'CHUNK_CUSTOMERS_INVALID — care_order_links_apply_chunk: khách không thuộc job hoặc đã áp';
    END IF;
    INSERT INTO public.care_order_run_chunks (run_id, chunk_no, job_no, payload_sha256, customers, rows_received)
    VALUES (p_run_id, p_chunk_no, p_job_no, v_sha, cardinality(p_customer_ids), v_rows);
    UPDATE public.care_order_runs SET chunks_applied = chunks_applied + 1 WHERE run_id = p_run_id;
    RETURN jsonb_build_object('status', 'ok', 'mode', 'trial', 'rows', v_rows);
  END IF;

  -- 2. try khoá kỳ shared (close: chỉ kỳ P; regular: kỳ run + kỳ hiện tại nếu khác).
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('care_import:' || to_char(r.period_month, 'YYYY-MM-DD'), 0)) THEN
    RETURN v_busy;
  END IF;
  IF r.kind = 'regular' THEN
    v_cur := public.care_period_of(public.care_vn_today());
    IF v_cur <> r.period_month
       AND NOT pg_try_advisory_xact_lock_shared(hashtextextended('care_import:' || to_char(v_cur, 'YYYY-MM-DD'), 0)) THEN
      RETURN v_busy;
    END IF;
  END IF;
  -- 3. L (lock_timeout 1 s) → dòng run; kiểm lại sau khoá.
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('care_order_links', 0));
  EXCEPTION WHEN lock_not_available THEN
    RETURN v_busy;
  END;
  SELECT * INTO r FROM public.care_order_runs WHERE run_id = p_run_id FOR UPDATE;
  IF r.status <> 'running' OR r.mode <> 'apply' OR r.started_at <= clock_timestamp() - interval '2 hours' THEN
    RAISE EXCEPTION 'RUN_NOT_RUNNING — care_order_links_apply_chunk: run không chạy';
  END IF;
  SELECT payload_sha256 INTO v_prev FROM public.care_order_run_chunks WHERE run_id = p_run_id AND chunk_no = p_chunk_no;
  IF FOUND THEN
    IF v_prev = v_sha THEN RETURN jsonb_build_object('status', 'duplicate'); END IF;
    RAISE EXCEPTION 'CHUNK_CONFLICT — care_order_links_apply_chunk: chunk đã áp với payload khác';
  END IF;
  IF (SELECT count(*) FROM public.care_order_run_jobs WHERE run_id = p_run_id AND done_at IS NOT NULL) <> r.jobs_expected THEN
    RAISE EXCEPTION 'JOBS_NOT_DONE — care_order_links_apply_chunk: chưa đọc đủ mọi job';
  END IF;
  IF EXISTS (SELECT 1 FROM public.care_order_period_state s WHERE s.period_month = r.period_month AND s.status = 'closed') THEN
    RAISE EXCEPTION 'PERIOD_CLOSED_FOR_ORDERS — care_order_links_apply_chunk: kỳ đã chốt';
  END IF;
  SELECT array_agg(rt.task_id ORDER BY rt.task_id) INTO v_tasks FROM public.care_order_run_tasks rt
  WHERE rt.run_id = p_run_id AND rt.job_no = p_job_no AND rt.external_id = ANY (p_customer_ids) AND rt.chunk_no IS NULL;
  IF COALESCE(cardinality(v_tasks), 0) <> cardinality(p_customer_ids) THEN
    RAISE EXCEPTION 'CHUNK_CUSTOMERS_INVALID — care_order_links_apply_chunk: khách không thuộc job hoặc đã áp';
  END IF;

  -- 4. Kiểm phòng thủ task đích (E0 §3, dựa I1): không có task cùng khách tạo SAU task đích mà TRƯỚC đơn.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_orders) e
             JOIN public.care_order_run_tasks rt ON rt.run_id = p_run_id AND rt.external_id = e ->> 'customer_external_id'
             JOIN public.care_tasks t ON t.id = rt.task_id
             JOIN public.care_tasks t2 ON t2.customer_id = t.customer_id AND t2.id <> t.id
             WHERE t2.created_at > t.created_at AND t2.created_at < (e ->> 'ordered_at')::timestamptz) THEN
    RAISE EXCEPTION 'TARGET_INVARIANT_BROKEN — care_order_links_apply_chunk: task đích không phải task gần nhất trước đơn';
  END IF;

  -- 5. KEY SHARE NOWAIT đúng các task đích có link INSERT / UPDATE, theo id.
  SELECT array_agg(DISTINCT rt.task_id ORDER BY rt.task_id) INTO v_targets
  FROM jsonb_array_elements(p_orders) e
  JOIN public.care_order_run_tasks rt ON rt.run_id = p_run_id AND rt.external_id = e ->> 'customer_external_id'
  LEFT JOIN public.care_order_links l ON l.order_key = e ->> 'order_key'
  WHERE l.link_id IS NULL OR (l.task_id = rt.task_id AND l.ordered_at <> (e ->> 'ordered_at')::timestamptz);
  IF v_targets IS NOT NULL THEN
    BEGIN
      SELECT count(*) INTO v_locked FROM (
        SELECT 1 FROM public.care_tasks t WHERE t.id = ANY (v_targets) ORDER BY t.id FOR KEY SHARE NOWAIT) k;
    EXCEPTION WHEN lock_not_available THEN
      RETURN v_busy;
    END;
    IF v_locked <> cardinality(v_targets) THEN
      RAISE EXCEPTION 'CHUNK_TASK_MISSING — care_order_links_apply_chunk: task đích không còn';
    END IF;
  END IF;

  -- 6. Link: INSERT; trùng order_key cùng task ⇒ UPDATE nếu đổi giờ; trỏ task khác ⇒ giữ nguyên (relink_refused). Không DELETE.
  SELECT count(*) INTO v_refused
  FROM jsonb_array_elements(p_orders) e
  JOIN public.care_order_run_tasks rt ON rt.run_id = p_run_id AND rt.external_id = e ->> 'customer_external_id'
  JOIN public.care_order_links l ON l.order_key = e ->> 'order_key' AND l.task_id <> rt.task_id;
  WITH src AS (
    SELECT e ->> 'order_key' AS order_key, e ->> 'customer_external_id' AS cust, (e ->> 'ordered_at')::timestamptz AS at,
           rt.task_id, t.is_test
    FROM jsonb_array_elements(p_orders) e
    JOIN public.care_order_run_tasks rt ON rt.run_id = p_run_id AND rt.external_id = e ->> 'customer_external_id'
    JOIN public.care_tasks t ON t.id = rt.task_id
  ), up AS (
    INSERT INTO public.care_order_links AS l (order_key, customer_external_id, ordered_at, task_id, is_test, first_run_id, updated_run_id)
    SELECT s.order_key, s.cust, s.at, s.task_id, s.is_test, p_run_id, p_run_id FROM src s
    ON CONFLICT (order_key) DO UPDATE
      SET customer_external_id = EXCLUDED.customer_external_id, ordered_at = EXCLUDED.ordered_at,
          updated_run_id = EXCLUDED.updated_run_id, updated_at = now()
      WHERE l.task_id = EXCLUDED.task_id
        AND (l.customer_external_id, l.ordered_at) IS DISTINCT FROM (EXCLUDED.customer_external_id, EXCLUDED.ordered_at)
    RETURNING (l.xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted) INTO v_ins, v_upd FROM up;

  -- 7. Coverage chỉ cho task CÒN tồn tại; thiếu ⇒ fail-closed. covered_until = GREATEST(cũ, upper_bound).
  INSERT INTO public.care_order_task_coverage AS cv (task_id, covered_until, run_id, updated_at)
  SELECT t.id, r.upper_bound, p_run_id, now() FROM public.care_tasks t WHERE t.id = ANY (v_tasks)
  ON CONFLICT (task_id) DO UPDATE
    SET covered_until = GREATEST(cv.covered_until, EXCLUDED.covered_until), run_id = EXCLUDED.run_id, updated_at = EXCLUDED.updated_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> cardinality(v_tasks) THEN
    RAISE EXCEPTION 'CHUNK_TASK_MISSING — care_order_links_apply_chunk: task của chunk không còn';
  END IF;

  -- 8. Metadata.
  UPDATE public.care_order_run_tasks SET chunk_no = p_chunk_no WHERE run_id = p_run_id AND task_id = ANY (v_tasks);
  INSERT INTO public.care_order_run_chunks (run_id, chunk_no, job_no, payload_sha256, customers, rows_received,
                                            links_inserted, links_updated, relink_refused)
  VALUES (p_run_id, p_chunk_no, p_job_no, v_sha, cardinality(p_customer_ids), v_rows, v_ins, v_upd, v_refused);
  UPDATE public.care_order_runs SET chunks_applied = chunks_applied + 1 WHERE run_id = p_run_id;
  RETURN jsonb_build_object('status', 'ok', 'rows', v_rows, 'links_inserted', v_ins, 'links_updated', v_upd, 'relink_refused', v_refused);
END $$;

-- Kết thúc lượt (E0 §4.1 bước 8). close/apply: X(P) (chờ ≤ 3 s) → L (chờ ≤ 4 s) — tổng dưới statement_timeout 8 s của PostgREST; hậu kiểm
-- đếm task + coverage của run. Mọi thất bại ⇒ run 'failed' + close_failed rồi RETURN {failed} (không RAISE để phần ghi trạng
-- thái không bị rollback). Run không còn 'running' ⇒ no-op.
-- Lỗi RPC (vd. L chờ quá 4 s ⇒ 55P03) ⇒ transaction rollback, run vẫn 'running' ⇒ app gọi care_order_links_fail (hoặc luật 2 h).
-- SET lock_timeout cấp hàm: set_config('lock_timeout', …, true) bên trong được trả về giá trị của bên gọi khi thoát hàm.
CREATE OR REPLACE FUNCTION public.care_order_links_complete(p_run_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET lock_timeout = '4s' AS $$
DECLARE
  r             public.care_order_runs%ROWTYPE;
  v_lock_failed boolean := false;
  v_code        text := NULL;
  v_n           bigint;
  v_out         jsonb;
BEGIN
  SELECT * INTO r FROM public.care_order_runs WHERE run_id = p_run_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RUN_NOT_FOUND — care_order_links_complete: không có run'; END IF;
  IF r.kind = 'close' AND r.mode = 'apply' THEN
    PERFORM set_config('lock_timeout', '3s', true);
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('care_import:' || to_char(r.period_month, 'YYYY-MM-DD'), 0));
    EXCEPTION WHEN lock_not_available THEN
      v_lock_failed := true;
    END;
  END IF;
  PERFORM set_config('lock_timeout', '4s', true);
  PERFORM pg_advisory_xact_lock(hashtextextended('care_order_links', 0));
  SELECT * INTO r FROM public.care_order_runs WHERE run_id = p_run_id FOR UPDATE;
  IF r.status <> 'running' THEN RETURN jsonb_build_object('status', 'noop', 'run_status', r.status); END IF;

  IF v_lock_failed THEN
    v_code := 'CLOSE_LOCK_TIMEOUT';
  ELSIF r.started_at <= clock_timestamp() - interval '2 hours' THEN
    v_code := 'RUN_EXPIRED';
  ELSIF (SELECT count(*) FROM public.care_order_run_tasks WHERE run_id = p_run_id) <> r.tasks_expected THEN
    v_code := 'RUN_TASKS_MISMATCH';
  ELSIF EXISTS (SELECT 1 FROM public.care_order_run_tasks WHERE run_id = p_run_id AND chunk_no IS NULL) THEN
    v_code := 'RUN_CHUNKS_MISSING';
  ELSIF (SELECT count(*) FROM public.care_order_run_jobs WHERE run_id = p_run_id AND done_at IS NOT NULL) <> r.jobs_expected
     OR (SELECT count(*) FROM public.care_order_run_jobs WHERE run_id = p_run_id) <> r.jobs_expected THEN
    v_code := 'RUN_JOBS_MISSING';
  ELSIF EXISTS (SELECT 1 FROM public.care_order_run_jobs j
                WHERE j.run_id = p_run_id
                  AND j.bq_total_rows <> j.duplicates_dropped + COALESCE((SELECT sum(c.rows_received) FROM public.care_order_run_chunks c
                                                                           WHERE c.run_id = p_run_id AND c.job_no = j.job_no), 0)) THEN
    v_code := 'RUN_ROWS_MISMATCH';
  ELSIF r.kind = 'close' AND r.mode = 'apply' AND (
          (SELECT count(*) FROM public.care_tasks t WHERE t.period_month = r.period_month) <> r.tasks_expected
          OR EXISTS (SELECT 1 FROM public.care_tasks t
                     LEFT JOIN public.care_order_task_coverage c ON c.task_id = t.id
                     WHERE t.period_month = r.period_month
                       AND (c.task_id IS NULL OR c.run_id <> p_run_id OR c.covered_until <> r.upper_bound))) THEN
    v_code := 'CLOSE_COVERAGE_INCOMPLETE';
  END IF;
  IF v_code IS NOT NULL THEN
    PERFORM public.care__order_links_end_run(p_run_id, v_code, 'failed');
    RETURN jsonb_build_object('status', 'failed', 'code', v_code, 'kind', r.kind, 'mode', r.mode);
  END IF;

  IF r.mode = 'apply' AND r.kind = 'regular' THEN
    INSERT INTO public.care_sync_state AS s (source, last_success_at, last_error, updated_at)
    VALUES ('n3_import_orders', r.snapshot_at, NULL, r.snapshot_at)
    ON CONFLICT (source) DO UPDATE SET
      last_success_at = GREATEST(COALESCE(s.last_success_at, '-infinity'::timestamptz), EXCLUDED.last_success_at),
      last_error = CASE WHEN EXCLUDED.updated_at >= s.updated_at THEN NULL ELSE s.last_error END,
      updated_at = GREATEST(s.updated_at, EXCLUDED.updated_at);
    INSERT INTO public.care_order_period_state (period_month, status) VALUES (r.period_month, 'active')
    ON CONFLICT (period_month) DO NOTHING;
  ELSIF r.mode = 'apply' AND r.kind = 'close' THEN
    UPDATE public.care_order_period_state
    SET status = 'closed', close_run_id = p_run_id, closed_at = clock_timestamp(), closed_through = r.upper_bound,
        last_error = NULL, updated_at = now()
    WHERE period_month = r.period_month AND status <> 'closed';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'CLOSE_STATE_MISSING — care_order_links_complete: không có trạng thái kỳ để chốt'; END IF;
  END IF;
  UPDATE public.care_order_runs SET status = 'complete', finished_at = clock_timestamp() WHERE run_id = p_run_id;

  IF r.mode = 'trial' THEN
    SELECT jsonb_build_object('status', 'complete', 'mode', 'trial', 'kind', r.kind, 'period_month', r.period_month,
             'tasks', count(*), 'tasks_with_orders', count(*) FILTER (WHERE rt.trial_orders > 0),
             'orders', COALESCE(sum(rt.trial_orders), 0),
             'checksum', md5(COALESCE(string_agg(rt.external_id || ':' || rt.trial_orders::text, ',' ORDER BY rt.external_id COLLATE "C"), '')))
    INTO v_out FROM public.care_order_run_tasks rt WHERE rt.run_id = p_run_id;
    RETURN v_out;
  END IF;
  RETURN jsonb_build_object('status', CASE WHEN r.kind = 'close' THEN 'closed' ELSE 'complete' END, 'kind', r.kind,
                            'period_month', r.period_month, 'tasks', r.tasks_expected, 'chunks', r.chunks_applied,
                            'snapshot_at', public.care__utc_us(r.snapshot_at), 'upper_bound', public.care__utc_us(r.upper_bound));
END $$;

CREATE OR REPLACE FUNCTION public.care_order_links_fail(p_run_id bigint, p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_code IS NULL OR p_code !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN RAISE EXCEPTION 'care_order_links_fail: mã lỗi sai dạng'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('care_order_links', 0));
  PERFORM 1 FROM public.care_order_runs WHERE run_id = p_run_id FOR UPDATE;
  RETURN jsonb_build_object('status', CASE WHEN public.care__order_links_end_run(p_run_id, p_code, 'failed') THEN 'failed' ELSE 'noop' END);
END $$;

-- Dọn metadata trial (không đụng link / coverage / state — trial không ghi). Chỉ run trial đã kết thúc.
CREATE OR REPLACE FUNCTION public.care_order_links_trial_cleanup()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('care_order_links', 0));
  DELETE FROM public.care_order_runs WHERE mode = 'trial' AND status NOT IN ('preparing', 'running');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('deleted_runs', v_n,
                            'remaining_trial_runs', (SELECT count(*) FROM public.care_order_runs WHERE mode = 'trial'));
END $$;

-- Xoá task is_test của QA (gộp purge_test, E0 §10a): X(kỳ của các task, theo thứ tự) → L; từ chối khi có lượt apply đang
-- chạy; chỉ dòng is_test; xoá link → task (trigger dọn coverage). Caller (fixture) đã xoá sản phẩm / lượt / sự kiện trước.
CREATE OR REPLACE FUNCTION public.care_qa_delete_test_tasks(p_task_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_p     date;
  v_links integer;
  v_tasks integer;
BEGIN
  IF p_task_ids IS NULL OR cardinality(p_task_ids) = 0 THEN
    RETURN jsonb_build_object('status', 'ok', 'links', 0, 'tasks', 0);
  END IF;
  IF cardinality(p_task_ids) > 20000 THEN RAISE EXCEPTION 'care_qa_delete_test_tasks: > 20.000 task'; END IF;
  IF EXISTS (SELECT 1 FROM public.care_tasks WHERE id = ANY (p_task_ids) AND NOT is_test) THEN
    RAISE EXCEPTION 'NOT_TEST_TASK — care_qa_delete_test_tasks: chỉ xoá task is_test';
  END IF;
  FOR v_p IN SELECT DISTINCT period_month FROM public.care_tasks WHERE id = ANY (p_task_ids) ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('care_import:' || to_char(v_p, 'YYYY-MM-DD'), 0));
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended('care_order_links', 0));
  IF EXISTS (SELECT 1 FROM public.care_order_runs WHERE mode = 'apply' AND status IN ('preparing', 'running')
             AND started_at > clock_timestamp() - interval '2 hours') THEN
    RETURN jsonb_build_object('status', 'busy', 'code', 'ORDERS_SYNC_RUNNING');
  END IF;
  DELETE FROM public.care_order_links WHERE task_id = ANY (p_task_ids) AND is_test;
  GET DIAGNOSTICS v_links = ROW_COUNT;
  DELETE FROM public.care_tasks WHERE id = ANY (p_task_ids) AND is_test;
  GET DIAGNOSTICS v_tasks = ROW_COUNT;
  RETURN jsonb_build_object('status', 'ok', 'links', v_links, 'tasks', v_tasks);
END $$;

CREATE OR REPLACE FUNCTION public.care_order_links_qa_counts(p_task_ids uuid[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'care_order_links', (SELECT count(*) FROM public.care_order_links WHERE task_id = ANY (p_task_ids)),
    'care_order_task_coverage', (SELECT count(*) FROM public.care_order_task_coverage WHERE task_id = ANY (p_task_ids)))
$$;

-- ── 5. RPC đọc (authenticated) ───────────────────────────────────────────────
-- READ(t) = vị từ NGUYÊN VĂN policy care_tasks_select (114): (assignee = me.uid AND store = me.sstore) OR v_all OR store ∈ scope.
-- Task không đọc được ⇒ cùng kết quả với task không tồn tại. Thời điểm trả dạng µs UTC (care__utc_us).
-- lagging ("Chưa cập nhật", Q-183): chỉ kỳ hiện tại — chưa coverage và import ≥ 24 h, hoặc covered_until < now() − 24 h.

CREATE OR REPLACE FUNCTION public.care_task_orders(p_task_id uuid, p_after_ordered_at timestamptz DEFAULT NULL,
                                                   p_after_link_id bigint DEFAULT NULL, p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS MATERIALIZED (
    SELECT public.care_assignee_uid() AS uid, public.care_staff_store_id() AS sstore,
           public.care_can_view_all() AS v_all, public.care_scope_store_ids() AS scope,
           public.care_period_of(public.care_vn_today()) AS cur
  ), t AS (
    SELECT t.id, t.period_month, t.created_at, me.cur FROM public.care_tasks t, me
    WHERE t.id = p_task_id
      AND ((t.assignee_id = me.uid AND t.store_id = me.sstore) OR me.v_all OR t.store_id = ANY (me.scope))
  ), lim AS (
    SELECT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 20) AS n
  ), pg AS (
    SELECT l.link_id, l.order_key, l.ordered_at FROM public.care_order_links l, t
    WHERE l.task_id = t.id
      AND ((p_after_ordered_at IS NULL AND p_after_link_id IS NULL)
           OR (p_after_link_id IS NOT NULL AND (l.ordered_at, l.link_id) < (p_after_ordered_at, p_after_link_id)))
    ORDER BY l.ordered_at DESC, l.link_id DESC
    LIMIT (SELECT n + 1 FROM lim)
  )
  SELECT COALESCE((
    SELECT jsonb_build_object(
      'found', true,
      'orders', COALESCE((SELECT jsonb_agg(jsonb_build_object('order_code', x.order_key, 'completed_at', public.care__utc_us(x.ordered_at),
                                                              'link_id', x.link_id) ORDER BY x.ordered_at DESC, x.link_id DESC)
                          FROM (SELECT * FROM pg ORDER BY pg.ordered_at DESC, pg.link_id DESC LIMIT (SELECT n FROM lim)) x), '[]'::jsonb),
      'has_more', (SELECT count(*) FROM pg) > (SELECT n FROM lim),
      'orders_count', (SELECT count(*) FROM public.care_order_links l WHERE l.task_id = t.id),
      'coverage', c.task_id IS NOT NULL,
      'covered_until', public.care__utc_us(c.covered_until),
      'period_month', t.period_month,
      'is_current_period', t.period_month = t.cur,
      'period_status', COALESCE(s.status, 'none'),
      'closed_at', public.care__utc_us(s.closed_at),
      'closed_through', public.care__utc_us(s.closed_through),
      'lagging', t.period_month = t.cur AND ((c.task_id IS NULL AND t.created_at < now() - interval '24 hours')
                                             OR c.covered_until < now() - interval '24 hours'))
    FROM t
    LEFT JOIN public.care_order_task_coverage c ON c.task_id = t.id
    LEFT JOIN public.care_order_period_state s ON s.period_month = t.period_month
  ), jsonb_build_object('found', false))
$$;

CREATE OR REPLACE FUNCTION public.care_task_order_counts(p_task_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_task_ids IS NULL OR cardinality(p_task_ids) > 50 THEN RAISE EXCEPTION 'care_task_order_counts: 0–50 task'; END IF;
  RETURN (
    WITH me AS MATERIALIZED (
      SELECT public.care_assignee_uid() AS uid, public.care_staff_store_id() AS sstore,
             public.care_can_view_all() AS v_all, public.care_scope_store_ids() AS scope,
             public.care_period_of(public.care_vn_today()) AS cur
    ), t AS (
      SELECT t.id, t.period_month, t.created_at, me.cur FROM public.care_tasks t, me
      WHERE t.id = ANY (p_task_ids)
        AND ((t.assignee_id = me.uid AND t.store_id = me.sstore) OR me.v_all OR t.store_id = ANY (me.scope))
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'task_id', t.id,
             'orders_count', lk.n,
             'latest_completed_at', public.care__utc_us(lk.latest),
             'coverage', c.task_id IS NOT NULL,
             'covered_until', public.care__utc_us(c.covered_until),
             'lagging', t.period_month = t.cur AND ((c.task_id IS NULL AND t.created_at < now() - interval '24 hours')
                                                    OR c.covered_until < now() - interval '24 hours'))
           ORDER BY t.id), '[]'::jsonb)
    FROM t
    LEFT JOIN public.care_order_task_coverage c ON c.task_id = t.id
    CROSS JOIN LATERAL (SELECT count(*) AS n, max(l.ordered_at) AS latest FROM public.care_order_links l WHERE l.task_id = t.id) lk);
END $$;

-- Danh sách task có đơn sau import của một kỳ (/care/orders basis=import) + khối trạng thái / "cập nhật một phần" (Q-181).
-- p_qa_batch_id NULL ⇒ dữ liệu thật (NOT is_test); khác NULL ⇒ chỉ task is_test của batch QA (careDataScope).
CREATE OR REPLACE FUNCTION public.care_import_order_list(p_month date, p_store_ids uuid[] DEFAULT NULL, p_assignee_ids uuid[] DEFAULT NULL,
                                                         p_qa_batch_id uuid DEFAULT NULL, p_after_latest timestamptz DEFAULT NULL,
                                                         p_after_task_id uuid DEFAULT NULL, p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_p   date;
  v_cur date := public.care_period_of(public.care_vn_today());
  v_n   integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 20);
BEGIN
  IF p_month IS NULL THEN RAISE EXCEPTION 'care_import_order_list: thiếu kỳ'; END IF;
  v_p := public.care_period_of(p_month);
  RETURN (
    WITH me AS MATERIALIZED (
      SELECT public.care_assignee_uid() AS uid, public.care_staff_store_id() AS sstore,
             public.care_can_view_all() AS v_all, public.care_scope_store_ids() AS scope
    ), ft AS (
      SELECT t.id, t.customer_name, t.store_id, t.assignee_id, t.status, t.created_at,
             (SELECT s.code FROM public.stores s WHERE s.id = t.store_id) AS store_code,
             (SELECT u.full_name FROM public.users u WHERE u.id = t.assignee_id) AS assignee_name
      FROM public.care_tasks t, me
      WHERE t.period_month = v_p
        AND ((t.assignee_id = me.uid AND t.store_id = me.sstore) OR me.v_all OR t.store_id = ANY (me.scope))
        AND (p_store_ids IS NULL OR t.store_id = ANY (p_store_ids))
        AND (p_assignee_ids IS NULL OR t.assignee_id = ANY (p_assignee_ids))
        AND (CASE WHEN p_qa_batch_id IS NULL THEN NOT t.is_test ELSE t.is_test AND t.batch_id = p_qa_batch_id END)
    ), agg AS (
      SELECT ft.*, c.task_id IS NOT NULL AS covered, c.covered_until, lk.n AS orders_count, lk.latest,
             v_p = v_cur AND ((c.task_id IS NULL AND ft.created_at < now() - interval '24 hours')
                              OR c.covered_until < now() - interval '24 hours') AS lagging
      FROM ft
      LEFT JOIN public.care_order_task_coverage c ON c.task_id = ft.id
      CROSS JOIN LATERAL (SELECT count(*) AS n, max(l.ordered_at) AS latest FROM public.care_order_links l WHERE l.task_id = ft.id) lk
    ), pg AS (
      SELECT a.* FROM agg a
      WHERE a.orders_count > 0
        AND ((p_after_latest IS NULL AND p_after_task_id IS NULL)
             OR (p_after_task_id IS NOT NULL AND (a.latest, a.id) < (p_after_latest, p_after_task_id)))
      ORDER BY a.latest DESC, a.id DESC
      LIMIT v_n + 1
    ), lr AS (
      SELECT r.status, r.chunks_applied FROM public.care_order_runs r
      WHERE r.kind = 'regular' AND r.mode = 'apply' AND r.period_month = v_p AND r.status IN ('complete', 'failed', 'abandoned')
      ORDER BY r.run_id DESC LIMIT 1
    ), sm AS (
      SELECT count(*) AS total, count(*) FILTER (WHERE covered) AS covered, count(*) FILTER (WHERE orders_count > 0) AS with_orders,
             count(*) FILTER (WHERE NOT covered) AS not_covered, count(*) FILTER (WHERE lagging) AS lagging,
             min(covered_until) AS min_cov, max(covered_until) AS max_cov
      FROM agg
    )
    SELECT jsonb_build_object(
      'period_month', v_p,
      'is_current_period', v_p = v_cur,
      'period_status', COALESCE((SELECT s.status FROM public.care_order_period_state s WHERE s.period_month = v_p), 'none'),
      'closed_at', (SELECT public.care__utc_us(s.closed_at) FROM public.care_order_period_state s WHERE s.period_month = v_p),
      'closed_through', (SELECT public.care__utc_us(s.closed_through) FROM public.care_order_period_state s WHERE s.period_month = v_p),
      'last_success_at', (SELECT public.care__utc_us(x.last_success_at) FROM public.care_sync_state x WHERE x.source = 'n3_import_orders'),
      'summary', jsonb_build_object('tasks', sm.total, 'covered', sm.covered, 'with_orders', sm.with_orders,
                                    'not_covered', sm.not_covered, 'lagging', sm.lagging,
                                    'min_covered_until', public.care__utc_us(sm.min_cov), 'max_covered_until', public.care__utc_us(sm.max_cov)),
      'partial', v_p = v_cur AND (sm.not_covered > 0 OR sm.lagging > 0
                                  OR EXISTS (SELECT 1 FROM lr WHERE lr.status IN ('failed', 'abandoned') AND lr.chunks_applied >= 1)),
      'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                 'task_id', x.id, 'customer_name', x.customer_name, 'store_id', x.store_id, 'assignee_id', x.assignee_id,
                 'store_code', x.store_code, 'assignee_name', x.assignee_name, 'status', x.status, 'orders_count', x.orders_count, 'latest_completed_at', public.care__utc_us(x.latest),
                 'covered_until', public.care__utc_us(x.covered_until), 'lagging', x.lagging)
               ORDER BY x.latest DESC, x.id DESC)
               FROM (SELECT * FROM pg ORDER BY pg.latest DESC, pg.id DESC LIMIT v_n) x), '[]'::jsonb),
      'has_more', (SELECT count(*) FROM pg) > v_n)
    FROM sm);
END $$;

-- Thẻ "Có đơn xác thực" của dược sĩ: task KỲ HIỆN TẠI giao mình ở đúng store hiện tại (như care_my_summary).
CREATE OR REPLACE FUNCTION public.care_my_order_summary(p_qa_batch_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS MATERIALIZED (
    SELECT public.care_assignee_uid() AS uid, public.care_staff_store_id() AS sstore,
           public.care_period_of(public.care_vn_today()) AS cur
  ), mt AS (
    SELECT t.id FROM public.care_tasks t, me
    WHERE t.assignee_id = me.uid AND t.store_id = me.sstore AND t.period_month = me.cur
      AND (CASE WHEN p_qa_batch_id IS NULL THEN NOT t.is_test ELSE t.is_test AND t.batch_id = p_qa_batch_id END)
  )
  SELECT jsonb_build_object(
    'period_month', me.cur,
    'tasks', (SELECT count(*) FROM mt),
    'covered', (SELECT count(*) FROM mt JOIN public.care_order_task_coverage c ON c.task_id = mt.id),
    'tasks_with_orders', (SELECT count(DISTINCT l.task_id) FROM public.care_order_links l JOIN mt ON mt.id = l.task_id),
    'orders', (SELECT count(*) FROM public.care_order_links l JOIN mt ON mt.id = l.task_id),
    'last_success_at', (SELECT public.care__utc_us(s.last_success_at) FROM public.care_sync_state s WHERE s.source = 'n3_import_orders'))
  FROM me WHERE me.uid IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION public.care_my_order_tasks(p_qa_batch_id uuid DEFAULT NULL, p_after_latest timestamptz DEFAULT NULL,
                                                      p_after_task_id uuid DEFAULT NULL, p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS MATERIALIZED (
    SELECT public.care_assignee_uid() AS uid, public.care_staff_store_id() AS sstore,
           public.care_period_of(public.care_vn_today()) AS cur, LEAST(GREATEST(COALESCE(p_limit, 20), 1), 20) AS n
  ), mt AS (
    SELECT t.id, t.customer_name, t.status, lk.n AS orders_count, lk.latest
    FROM public.care_tasks t CROSS JOIN me
    CROSS JOIN LATERAL (SELECT count(*) AS n, max(l.ordered_at) AS latest FROM public.care_order_links l WHERE l.task_id = t.id) lk
    WHERE t.assignee_id = me.uid AND t.store_id = me.sstore AND t.period_month = me.cur
      AND (CASE WHEN p_qa_batch_id IS NULL THEN NOT t.is_test ELSE t.is_test AND t.batch_id = p_qa_batch_id END)
      AND lk.n > 0
      AND ((p_after_latest IS NULL AND p_after_task_id IS NULL)
           OR (p_after_task_id IS NOT NULL AND (lk.latest, t.id) < (p_after_latest, p_after_task_id)))
    ORDER BY lk.latest DESC, t.id DESC
    LIMIT (SELECT n + 1 FROM me)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('task_id', x.id, 'customer_name', x.customer_name, 'status', x.status,
                                                          'orders_count', x.orders_count, 'latest_completed_at', public.care__utc_us(x.latest))
                                       ORDER BY x.latest DESC, x.id DESC)
                      FROM (SELECT * FROM mt ORDER BY mt.latest DESC, mt.id DESC LIMIT (SELECT n FROM me)) x), '[]'::jsonb),
    'has_more', (SELECT count(*) FROM mt) > me.n)
  FROM me WHERE me.uid IS NOT NULL
$$;

-- Cohort KPI "Khách có đơn sau chăm sóc" (/care/orders basis=care): vị từ chép NGUYÊN VĂN CTE `at` của care_report (114)
-- + p_assignee_ids. cohort_total = Σ converted_tasks của care_report (đếm theo nhóm store × dược sĩ); trang = cohort ∩ READ(t).
CREATE OR REPLACE FUNCTION public.care_report_conversion_list(p_month date, p_store_ids uuid[] DEFAULT NULL, p_assignee_ids uuid[] DEFAULT NULL,
                                                              p_include_test boolean DEFAULT false, p_after_latest timestamptz DEFAULT NULL,
                                                              p_after_task_id uuid DEFAULT NULL, p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (
    SELECT public.care_assignee_uid() AS uid, public.care_staff_store_id() AS staff_store,
           public.care_can_view_all() AS v_all, public.care_scope_store_ids() AS scope,
           (COALESCE(p_include_test, false) AND public.is_super_admin()) AS v_test
  ), at AS (
    SELECT a.store_id, a.assignee_id, a.task_id, a.order_key
    FROM public.care_order_attributions a, me
    WHERE a.period_month = public.care_period_of(p_month) AND (me.v_test OR NOT a.is_test)
      AND (me.v_all OR (a.assignee_id = me.uid AND a.store_id = me.staff_store) OR a.store_id = ANY (me.scope))
      AND (p_store_ids IS NULL OR a.store_id = ANY (p_store_ids))
      AND (p_assignee_ids IS NULL OR a.assignee_id = ANY (p_assignee_ids))
  ), rd AS MATERIALIZED (
    SELECT public.care_assignee_uid() AS uid, public.care_staff_store_id() AS sstore,
           public.care_can_view_all() AS v_all, public.care_scope_store_ids() AS scope,
           LEAST(GREATEST(COALESCE(p_limit, 20), 1), 20) AS n
  ), vis AS (
    SELECT t.id, t.customer_name, t.store_id, t.assignee_id, count(DISTINCT at.order_key) AS orders, max(o.ordered_at) AS latest,
           (SELECT s.code FROM public.stores s WHERE s.id = t.store_id) AS store_code,
           (SELECT u.full_name FROM public.users u WHERE u.id = t.assignee_id) AS assignee_name
    FROM at
    JOIN public.care_tasks t ON t.id = at.task_id
    JOIN public.care_orders o ON o.order_key = at.order_key
    CROSS JOIN rd
    WHERE (t.assignee_id = rd.uid AND t.store_id = rd.sstore) OR rd.v_all OR t.store_id = ANY (rd.scope)
    GROUP BY t.id, t.customer_name, t.store_id, t.assignee_id
  ), pg AS (
    SELECT v.* FROM vis v
    WHERE (p_after_latest IS NULL AND p_after_task_id IS NULL)
       OR (p_after_task_id IS NOT NULL AND (v.latest, v.id) < (p_after_latest, p_after_task_id))
    ORDER BY v.latest DESC, v.id DESC
    LIMIT (SELECT n + 1 FROM rd)
  )
  SELECT jsonb_build_object(
    'period_month', public.care_period_of(p_month),
    'cohort_total', (SELECT count(*) FROM (SELECT DISTINCT at.store_id, at.assignee_id, at.task_id FROM at) g),
    'visible_total', (SELECT count(*) FROM vis),
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('task_id', x.id, 'customer_name', x.customer_name, 'store_id', x.store_id,
                                                          'assignee_id', x.assignee_id, 'store_code', x.store_code,
                                                          'assignee_name', x.assignee_name, 'orders', x.orders,
                                                          'latest_completed_at', public.care__utc_us(x.latest))
                                       ORDER BY x.latest DESC, x.id DESC)
                      FROM (SELECT * FROM pg ORDER BY pg.latest DESC, pg.id DESC LIMIT (SELECT n FROM rd)) x), '[]'::jsonb),
    'has_more', (SELECT count(*) FROM pg) > (SELECT n FROM rd))
$$;

-- Trạng thái dữ liệu đơn sau import của một kỳ cho người có quyền xem CRM; chỉ v_all nhận số toàn chuỗi. Không quyền ⇒ NULL.
CREATE OR REPLACE FUNCTION public.care_import_order_state(p_month date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS MATERIALIZED (
    SELECT public.care_can_view_all() AS v_all, public.care_scope_store_ids() AS scope, public.care_assignee_uid() AS uid,
           public.care_period_of(p_month) AS p, public.care_period_of(public.care_vn_today()) AS cur
  )
  SELECT jsonb_build_object(
    'period_month', me.p,
    'is_current_period', me.p = me.cur,
    'has_synced', s.last_success_at IS NOT NULL,
    'last_success_at', public.care__utc_us(s.last_success_at),
    'last_failed', s.last_error IS NOT NULL,
    'period_status', COALESCE(ps.status, 'none'),
    'closed_at', public.care__utc_us(ps.closed_at),
    'closed_through', public.care__utc_us(ps.closed_through),
    'chain', CASE WHEN me.v_all THEN (
      SELECT jsonb_build_object('tasks', count(*), 'covered', count(c.task_id),
                                'with_orders', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.care_order_links l WHERE l.task_id = t.id)))
      FROM public.care_tasks t LEFT JOIN public.care_order_task_coverage c ON c.task_id = t.id
      WHERE t.period_month = me.p AND NOT t.is_test) END)
  FROM me
  LEFT JOIN public.care_sync_state s ON s.source = 'n3_import_orders'
  LEFT JOIN public.care_order_period_state ps ON ps.period_month = me.p
  WHERE p_month IS NOT NULL AND (me.v_all OR cardinality(me.scope) > 0 OR me.uid IS NOT NULL)
$$;

-- ── 6. D1 / 115: gate + assess = nguyên văn 115 + điểm sửa (Q-175 / Q-182) ─────
CREATE OR REPLACE FUNCTION public.care__import_cancel_gate(p_batch_id uuid, p_actor uuid, p_today date)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b public.care_import_batches%ROWTYPE;
  v_last timestamptz;  -- 116
BEGIN
  IF NOT (public.care__uid_is_super(p_actor) OR public.care__uid_can(p_actor, 'import')) THEN RETURN 'FORBIDDEN'; END IF;
  SELECT * INTO b FROM public.care_import_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF b.status <> 'committed' THEN RETURN 'NOT_COMMITTED'; END IF;
  IF b.period_month <> public.care_period_of(p_today) THEN RETURN 'NOT_CURRENT_PERIOD'; END IF;
  IF b.provenance_version IS NULL OR b.commit_seq IS NULL OR b.journal_rows IS NULL THEN RETURN 'PROVENANCE_UNAVAILABLE'; END IF;
  IF b.commit_seq <> (SELECT max(x.commit_seq) FROM public.care_import_batches x
                      WHERE x.period_month = b.period_month AND x.is_test = b.is_test AND x.status = 'committed') THEN
    RETURN 'NOT_LATEST';
  END IF;
  -- 116 (Q-175): chỉ huỷ khi đơn N3 sau import của mọi task B tạo / sửa đã được đối chiếu ở lượt thường gần nhất.
  -- try L: không chờ lượt đồng bộ (huỷ giữ X kỳ — chờ L sẽ nghịch thứ tự chunk S(kỳ) → L).
  IF NOT pg_try_advisory_xact_lock(hashtextextended('care_order_links', 0)) THEN RETURN 'ORDERS_SYNC_RUNNING'; END IF;
  IF EXISTS (SELECT 1 FROM public.care_order_runs r
             WHERE r.kind = 'regular' AND r.mode = 'apply' AND r.status IN ('preparing', 'running')
               AND r.started_at > clock_timestamp() - interval '2 hours') THEN
    RETURN 'ORDERS_SYNC_RUNNING';
  END IF;
  SELECT s.last_success_at INTO v_last FROM public.care_sync_state s WHERE s.source = 'n3_import_orders';
  IF v_last IS NULL OR v_last < clock_timestamp() - interval '24 hours' THEN RETURN 'ORDERS_SYNC_STALE'; END IF;
  IF EXISTS (SELECT 1 FROM public.care_tasks t
             LEFT JOIN public.care_order_task_coverage c ON c.task_id = t.id
             WHERE (t.batch_id = p_batch_id
                    OR t.id IN (SELECT j.task_id FROM public.care_import_revision_journal j WHERE j.batch_id = p_batch_id))
               AND (c.task_id IS NULL OR c.covered_until < b.finished_at OR c.covered_until < v_last)) THEN
    RETURN 'ORDERS_NOT_COVERED';
  END IF;
  -- Batch committed commit_seq NULL cùng partition đều commit TRƯỚC 115 (rào care__require_commit_provenance) ⇒ cũ hơn B; không xét.
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.care__import_cancel_assess(p_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b          public.care_import_batches%ROWTYPE;
  v_new      uuid[];
  v_mod      uuid[];
  v_all      uuid[];
  v_code     text := NULL;
BEGIN
  SELECT * INTO b FROM public.care_import_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('code', 'NOT_FOUND'); END IF;
  SELECT COALESCE(array_agg(t.id ORDER BY t.id), '{}') INTO v_new FROM public.care_tasks t WHERE t.batch_id = p_batch_id;
  SELECT COALESCE(array_agg(j.task_id ORDER BY j.task_id), '{}') INTO v_mod FROM public.care_import_revision_journal j WHERE j.batch_id = p_batch_id;
  v_all := v_new || v_mod;

  -- Hoạt động / phạm vi (Q-150).
  IF EXISTS (SELECT 1 FROM public.care_tasks t WHERE t.id = ANY (v_all)
             AND (t.status <> 'open' OR t.period_month <> b.period_month OR t.is_test <> b.is_test))
     OR EXISTS (SELECT 1 FROM public.care_interactions i WHERE i.task_id = ANY (v_all))
     OR EXISTS (SELECT 1 FROM public.care_assignment_events e WHERE e.task_id = ANY (v_all) AND e.kind = 'transferred')
     OR EXISTS (SELECT 1 FROM public.care_order_attributions a WHERE a.task_id = ANY (v_all))
     OR EXISTS (SELECT 1 FROM public.care_tasks t JOIN public.care_store_refusals r ON r.customer_id = t.customer_id AND r.store_id = t.store_id
                WHERE t.id = ANY (v_all)) THEN
    v_code := 'HAS_ACTIVITY';
  -- 116 (Q-182): task B tạo / sửa đã có đơn N3 xác thực sau import ⇒ không huỷ.
  ELSIF EXISTS (SELECT 1 FROM public.care_order_links l WHERE l.task_id = ANY (v_all)) THEN
    v_code := 'HAS_VERIFIED_ORDER';
  -- Bằng chứng khôi phục (§2.5 a–d + T_new ∩ T_mod = ∅).
  ELSIF EXISTS (SELECT 1 FROM unnest(v_new) n WHERE n = ANY (v_mod))
     OR (SELECT count(*) FROM public.care_import_revision_journal j WHERE j.batch_id = p_batch_id) IS DISTINCT FROM b.journal_rows::bigint
     OR EXISTS (SELECT 1 FROM public.care_task_products p WHERE p.batch_id = p_batch_id
                AND NOT (p.task_id = ANY (v_new))
                AND NOT EXISTS (SELECT 1 FROM public.care_import_revision_journal j
                                WHERE j.batch_id = p_batch_id AND j.task_id = p.task_id AND j.products_replaced))
     OR EXISTS (SELECT 1 FROM public.care_import_revision_journal j JOIN public.care_tasks t ON t.id = j.task_id
                WHERE j.batch_id = p_batch_id
                  AND ((t.customer_name, t.phone_norm, t.phone_raw) IS DISTINCT FROM (j.new_customer_name, j.new_phone_norm, j.new_phone_raw)
                       OR j.products_replaced <> (cardinality(j.prev_product_row_ids) >= 1)
                       OR (j.products_replaced AND (
                             EXISTS (SELECT 1 FROM public.care_task_products p WHERE p.task_id = j.task_id AND p.is_current AND p.batch_id <> p_batch_id)
                             OR EXISTS (SELECT 1 FROM public.care_task_products p WHERE p.task_id = j.task_id AND p.batch_id = p_batch_id AND NOT p.is_current)
                             OR NOT EXISTS (SELECT 1 FROM public.care_task_products p WHERE p.task_id = j.task_id AND p.batch_id = p_batch_id)
                             OR (SELECT count(*) FROM public.care_task_products p
                                 WHERE p.id = ANY (j.prev_product_row_ids) AND p.task_id = j.task_id AND p.batch_id <> p_batch_id AND NOT p.is_current)
                                <> cardinality(j.prev_product_row_ids)))
                       OR (NOT j.products_replaced AND EXISTS (SELECT 1 FROM public.care_task_products p WHERE p.task_id = j.task_id AND p.batch_id = p_batch_id))))
  THEN
    v_code := 'RESTORE_UNAVAILABLE';
  END IF;

  RETURN jsonb_build_object(
    'code', v_code,
    'orders_checked_at', (SELECT min(c.covered_until) FROM public.care_order_task_coverage c WHERE c.task_id = ANY (v_all)),  -- 116
    'tasks_deleted', cardinality(v_new),
    'tasks_restored', cardinality(v_mod),
    'products_deleted', (SELECT count(*) FROM public.care_task_products p WHERE p.batch_id = p_batch_id),
    'products_restored', (SELECT COALESCE(sum(cardinality(j.prev_product_row_ids)), 0) FROM public.care_import_revision_journal j WHERE j.batch_id = p_batch_id),
    'events_deleted', (SELECT count(*) FROM public.care_assignment_events e WHERE e.batch_id = p_batch_id AND e.kind = 'assigned' AND e.task_id = ANY (v_new)),
    'customers_deleted', (SELECT count(*) FROM public.care_customers c
                          WHERE c.created_batch_id = p_batch_id
                            AND NOT EXISTS (SELECT 1 FROM public.care_tasks t WHERE t.customer_id = c.id AND NOT (t.id = ANY (v_new)))
                            AND NOT EXISTS (SELECT 1 FROM public.care_interactions i WHERE i.customer_id = c.id)
                            AND NOT EXISTS (SELECT 1 FROM public.care_store_refusals r WHERE r.customer_id = c.id)
                            AND NOT EXISTS (SELECT 1 FROM public.care_reconcile_queue q WHERE q.customer_id = c.id)
                            AND NOT EXISTS (SELECT 1 FROM public.care_order_attributions a WHERE a.customer_id = c.id)));
END $$;

-- Wrapper preview: không chờ khoá lâu (gate 116 chỉ try L; khoá khác không có).
ALTER FUNCTION public.care_import_cancel_preview(uuid, uuid) SET lock_timeout = '2s';

-- ── 7. Quyền (REVOKE đích danh rồi GRANT — AGENTS §4.2) ────────────────────
REVOKE ALL ON FUNCTION
  public.care_period_end(date), public.care__utc_us(timestamptz),
  public.care__tasks_freeze_cutoff(), public.care__customers_freeze_external_id(),
  public.care__tasks_block_closed_period(), public.care__tasks_drop_order_coverage(),
  public.care__order_links_end_run(bigint, text, text), public.care__order_links_sweep(timestamptz),
  public.care__order_links_begin_open_at(text, text, date, integer, timestamptz), public.care__order_links_params_sha(bigint, integer),
  public.care_order_links_begin_open(text, text, date, integer), public.care_order_links_begin_select(bigint, integer, integer),
  public.care_order_links_run_job(bigint, integer), public.care_order_links_job_done(bigint, integer, integer, integer, text),
  public.care_order_links_apply_chunk(bigint, integer, integer, text[], jsonb), public.care_order_links_complete(bigint),
  public.care_order_links_fail(bigint, text), public.care_order_links_trial_cleanup(),
  public.care_qa_delete_test_tasks(uuid[]), public.care_order_links_qa_counts(uuid[]),
  public.care_task_orders(uuid, timestamptz, bigint, integer), public.care_task_order_counts(uuid[]),
  public.care_import_order_list(date, uuid[], uuid[], uuid, timestamptz, uuid, integer),
  public.care_my_order_summary(uuid), public.care_my_order_tasks(uuid, timestamptz, uuid, integer),
  public.care_report_conversion_list(date, uuid[], uuid[], boolean, timestamptz, uuid, integer),
  public.care_import_order_state(date),
  public.care__import_cancel_gate(uuid, uuid, date), public.care__import_cancel_assess(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.care_order_links_begin_open(text, text, date, integer), public.care_order_links_begin_select(bigint, integer, integer),
  public.care_order_links_run_job(bigint, integer), public.care_order_links_job_done(bigint, integer, integer, integer, text),
  public.care_order_links_apply_chunk(bigint, integer, integer, text[], jsonb), public.care_order_links_complete(bigint),
  public.care_order_links_fail(bigint, text), public.care_order_links_trial_cleanup(),
  public.care_qa_delete_test_tasks(uuid[]), public.care_order_links_qa_counts(uuid[])
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.care_task_orders(uuid, timestamptz, bigint, integer), public.care_task_order_counts(uuid[]),
  public.care_import_order_list(date, uuid[], uuid[], uuid, timestamptz, uuid, integer),
  public.care_my_order_summary(uuid), public.care_my_order_tasks(uuid, timestamptz, uuid, integer),
  public.care_report_conversion_list(date, uuid[], uuid[], boolean, timestamptz, uuid, integer),
  public.care_import_order_state(date)
  TO authenticated;

-- Owner-only cho hàm mới: thu hồi EXECUTE của MỌI role khác owner, trừ đúng role được cấp ở trên (default privileges Supabase
-- cấp EXECUTE cho postgres trên hàm mới — như 115 với bảng).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, x.grantee
    FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('care_period_end', 'care__utc_us', 'care__tasks_freeze_cutoff', 'care__customers_freeze_external_id',
                          'care__tasks_block_closed_period', 'care__tasks_drop_order_coverage', 'care__order_links_end_run', 'care__order_links_sweep',
                          'care__order_links_begin_open_at', 'care__order_links_params_sha',
                          'care_order_links_begin_open', 'care_order_links_begin_select', 'care_order_links_run_job', 'care_order_links_job_done',
                          'care_order_links_apply_chunk', 'care_order_links_complete', 'care_order_links_fail', 'care_order_links_trial_cleanup',
                          'care_qa_delete_test_tasks', 'care_order_links_qa_counts',
                          'care_task_orders', 'care_task_order_counts', 'care_import_order_list', 'care_my_order_summary', 'care_my_order_tasks',
                          'care_report_conversion_list', 'care_import_order_state',
                          'care__import_cancel_gate', 'care__import_cancel_assess')
      AND x.grantee <> p.proowner
      AND NOT (p.proname IN ('care_order_links_begin_open', 'care_order_links_begin_select', 'care_order_links_run_job', 'care_order_links_job_done',
                          'care_order_links_apply_chunk', 'care_order_links_complete', 'care_order_links_fail', 'care_order_links_trial_cleanup',
                          'care_qa_delete_test_tasks', 'care_order_links_qa_counts') AND x.grantee = 'service_role'::regrole::oid)
      AND NOT (p.proname IN ('care_task_orders', 'care_task_order_counts', 'care_import_order_list', 'care_my_order_summary', 'care_my_order_tasks',
                          'care_report_conversion_list', 'care_import_order_state') AND x.grantee = 'authenticated'::regrole::oid)
    GROUP BY p.oid, x.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- Xoá task chỉ qua RPC (owner / DEFINER): fixture QA không còn xoá thẳng care_tasks (E0 §10a, P1 db r3.3).
REVOKE DELETE ON public.care_tasks FROM service_role;

-- ── 8. Trạng thái ban đầu ────────────────────────────────────────────────────
-- Kỳ hiện tại = kỳ go-live E ('active'); kỳ cũ hơn không có trạng thái ⇒ UI "Chưa có dữ liệu đơn".
INSERT INTO public.care_order_period_state (period_month, status)
VALUES (public.care_period_of(public.care_vn_today()), 'active')
ON CONFLICT (period_month) DO NOTHING;
INSERT INTO public.care_sync_state (source, last_success_at, last_error, updated_at)
VALUES ('n3_import_orders', NULL, NULL, now())
ON CONFLICT (source) DO NOTHING;

-- ── 9. Hậu kiểm ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n     bigint;
  v_owner oid := (SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.care_tasks'::regclass);
  v_new   text[] := ARRAY['care_order_links', 'care_order_period_state', 'care_order_runs', 'care_order_run_tasks',
                          'care_order_run_jobs', 'care_order_run_chunks', 'care_order_task_coverage'];
  v_svc   text[] := ARRAY['care_order_links_begin_open', 'care_order_links_begin_select', 'care_order_links_run_job',
                          'care_order_links_job_done', 'care_order_links_apply_chunk', 'care_order_links_complete',
                          'care_order_links_fail', 'care_order_links_trial_cleanup', 'care_qa_delete_test_tasks',
                          'care_order_links_qa_counts'];
  v_read  text[] := ARRAY['care_task_orders', 'care_task_order_counts', 'care_import_order_list', 'care_my_order_summary',
                          'care_my_order_tasks', 'care_report_conversion_list', 'care_import_order_state'];
  v_int   text[] := ARRAY['care_period_end', 'care__utc_us', 'care__tasks_freeze_cutoff', 'care__customers_freeze_external_id',
                          'care__tasks_block_closed_period', 'care__tasks_drop_order_coverage', 'care__order_links_end_run',
                          'care__order_links_sweep', 'care__order_links_begin_open_at', 'care__order_links_params_sha'];
BEGIN
  SELECT count(*) INTO v_n FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'care\_%' AND c.relkind = 'r';
  IF v_n <> 22 THEN RAISE EXCEPTION '116 hậu kiểm: % bảng care_* (kỳ vọng 15 + 7 = 22)', v_n; END IF;
  -- 7 bảng mới: RLS bật, 0 policy, không quyền ngoài owner, cùng owner.
  SELECT count(*) INTO v_n FROM pg_catalog.pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (v_new) AND c.relkind = 'r' AND c.relrowsecurity AND c.relowner = v_owner;
  IF v_n <> 7 THEN RAISE EXCEPTION '116 hậu kiểm: % / 7 bảng mới bật RLS đúng owner', v_n; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
             WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (v_new)) THEN
    RAISE EXCEPTION '116 hậu kiểm: bảng mới có policy';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
             WHERE c.relnamespace = 'public'::regnamespace AND x.grantee <> c.relowner
               AND (c.relname = ANY (v_new) OR c.relname IN ('care_order_runs_run_id_seq', 'care_order_links_link_id_seq'))) THEN
    RAISE EXCEPTION '116 hậu kiểm: bảng / sequence mới có quyền ngoài owner';
  END IF;
  -- Một FK duy nhất tới care_tasks từ bảng mới (care_order_links.task_id, RESTRICT).
  SELECT count(*) INTO v_n FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
  WHERE k.contype = 'f' AND k.confrelid = 'public.care_tasks'::regclass AND c.relname = ANY (v_new);
  IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.contype = 'f' AND k.conrelid = 'public.care_order_links'::regclass
                             AND k.confrelid = 'public.care_tasks'::regclass AND k.confdeltype = 'r') THEN
    RAISE EXCEPTION '116 hậu kiểm: FK tới care_tasks từ bảng mới phải đúng 1 (care_order_links RESTRICT), có %', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = 'public.care_order_runs'::regclass
                 AND i.indexrelid = 'public.care_order_runs_running_uq'::regclass AND i.indisunique AND i.indpred IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.care_order_links'::regclass
                    AND k.conname = 'care_order_links_order_key_uq' AND k.contype = 'u')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.care_order_runs'::regclass
                    AND k.conname = 'care_order_runs_regular_bounds_ck')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.care_order_runs'::regclass
                    AND k.conname = 'care_order_runs_close_bounds_ck') THEN
    RAISE EXCEPTION '116 hậu kiểm: thiếu UNIQUE / CHECK biên kỳ';
  END IF;
  -- service_role mất DELETE care_tasks, còn SELECT/INSERT/UPDATE.
  IF has_table_privilege('service_role', 'public.care_tasks', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.care_tasks', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.care_tasks', 'UPDATE') THEN
    RAISE EXCEPTION '116 hậu kiểm: quyền service_role trên care_tasks sai';
  END IF;

  -- Hàm: nội bộ không ai EXECUTE; service chỉ service_role; đọc chỉ authenticated.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
             AND (p.proname = ANY (v_int) OR p.proname IN ('care__import_cancel_gate', 'care__import_cancel_assess'))
             AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  OR has_function_privilege('service_role', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION '116 hậu kiểm: hàm nội bộ có quyền EXECUTE';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (v_svc)
             AND (NOT has_function_privilege('service_role', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  OR has_function_privilege('anon', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION '116 hậu kiểm: quyền hàm service_role sai';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (v_read)
             AND (NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
                  OR has_function_privilege('service_role', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION '116 hậu kiểm: quyền hàm đọc sai';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
             AND (p.proname = ANY (v_int) OR p.proname = ANY (v_svc) OR p.proname = ANY (v_read)) AND p.proacl IS NULL)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
                WHERE p.pronamespace = 'public'::regnamespace
                  AND (p.proname = ANY (v_int) OR p.proname = ANY (v_svc) OR p.proname = ANY (v_read))
                  AND x.grantee <> p.proowner
                  AND NOT (p.proname = ANY (v_svc) AND x.grantee = 'service_role'::regrole::oid)
                  AND NOT (p.proname = ANY (v_read) AND x.grantee = 'authenticated'::regrole::oid)) THEN
    RAISE EXCEPTION '116 hậu kiểm: hàm mới có quyền EXECUTE ngoài owner / đúng role được cấp (kể cả quyền do default privileges)';
  END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    AND (p.proname = ANY (v_int) OR p.proname = ANY (v_svc) OR p.proname = ANY (v_read));
  IF v_n <> 27 THEN RAISE EXCEPTION '116 hậu kiểm: % hàm mới (kỳ vọng 10 + 10 + 7 = 27, không overload)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'care%';
  IF v_n <> 78 THEN RAISE EXCEPTION '116 hậu kiểm: % hàm care%% (kỳ vọng 51 + 27 = 78)', v_n; END IF;
  -- DEFINER: search_path=public, cùng owner bảng; hàm trigger freeze INVOKER; rào chèn VOLATILE + DEFINER.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'care%' AND p.prosecdef
             AND (NOT (COALESCE(p.proconfig, '{}') @> ARRAY['search_path=public']) OR p.proowner <> v_owner)) THEN
    RAISE EXCEPTION '116 hậu kiểm: hàm DEFINER care%% thiếu search_path=public hoặc khác owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname IN ('care__tasks_freeze_cutoff', 'care__customers_freeze_external_id') AND p.prosecdef) THEN
    RAISE EXCEPTION '116 hậu kiểm: hàm trigger freeze phải SECURITY INVOKER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = 'public.care__tasks_block_closed_period()'::regprocedure
                 AND p.prosecdef AND p.provolatile = 'v'
                 AND position('transaction_isolation' in p.prosrc) > 0
                 AND position('pg_advisory_xact_lock(hashtextextended(''care_import:'' || to_char(v_p, ''YYYY-MM-DD''), 0))' in p.prosrc) > 0
                 AND position('FROM care_new_tasks n ORDER BY 1' in p.prosrc) > 0
                 AND position('pg_advisory_xact_lock' in p.prosrc) < position('care_order_period_state' in p.prosrc)) THEN
    RAISE EXCEPTION '116 hậu kiểm: rào chèn task phải VOLATILE DEFINER, kiểm isolation, lấy khoá kỳ TRƯỚC khi đọc trạng thái';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = 'public.care_order_links_complete(bigint)'::regprocedure
                 AND position('''care_import:''' in p.prosrc) > 0 AND position('lock_not_available' in p.prosrc) > 0)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = 'public.care_period_end(date)'::regprocedure AND p.provolatile = 'i') THEN
    RAISE EXCEPTION '116 hậu kiểm: complete thiếu khoá kỳ / care_period_end không IMMUTABLE';
  END IF;
  IF public.care_period_end(date '2026-10-01') <> timestamptz '2026-10-31 17:00:00+00'
     OR public.care_period_end(date '2026-12-01') <> timestamptz '2026-12-31 17:00:00+00'
     OR public.care_period_end(date '2027-02-01') <> timestamptz '2027-02-28 17:00:00+00' THEN
    RAISE EXCEPTION '116 hậu kiểm: care_period_end sai biên';
  END IF;
END $$;

DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_cancel_gate(uuid,uuid,date)'::regprocedure) <> '04c8d4081bb2f3e99ebd5cb07b3a5a54'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_cancel_assess(uuid)'::regprocedure) <> '19c8ae8c5a171a29fd9ca16509a3e0cd' THEN
    RAISE EXCEPTION '116 hậu kiểm: md5 gate / assess khác bản 116';
  END IF;
  -- 11 trigger care_* bật: 7 của 114/115 + 4 của 116 ('A').
  IF (SELECT count(*) FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid
      WHERE NOT g.tgisinternal AND c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'care\_%' AND g.tgenabled IN ('O', 'A')) <> 11 THEN
    RAISE EXCEPTION '116 hậu kiểm: số trigger care_* bật khác 11';
  END IF;
  -- tgtype: 1 ROW · 2 BEFORE · 4 INSERT · 8 DELETE · 16 UPDATE (rào chèn = 4: AFTER INSERT FOR EACH STATEMENT, có transition table).
  IF (SELECT count(*) FROM pg_catalog.pg_trigger g
      JOIN (VALUES ('care_tasks', 'care_tasks_freeze_cutoff', 'public.care__tasks_freeze_cutoff()', 19),
                   ('care_tasks', 'care_tasks_block_closed_period', 'public.care__tasks_block_closed_period()', 4),
                   ('care_tasks', 'care_tasks_drop_order_coverage', 'public.care__tasks_drop_order_coverage()', 9),
                   ('care_customers', 'care_customers_freeze_external_id', 'public.care__customers_freeze_external_id()', 19)) e(t, n, f, ty)
        ON g.tgrelid = ('public.' || e.t)::regclass AND g.tgname = e.n AND g.tgfoid = e.f::regprocedure AND g.tgtype = e.ty
      WHERE NOT g.tgisinternal AND g.tgenabled = 'A') <> 4 THEN
    RAISE EXCEPTION '116 hậu kiểm: 4 trigger 116 thiếu / sai loại / không ENABLE ALWAYS';
  END IF;
  -- Cột UPDATE OF của hai trigger freeze đúng nguyên văn.
  IF (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_catalog.pg_trigger g
      JOIN pg_catalog.pg_attribute a ON a.attrelid = g.tgrelid AND a.attnum = ANY (g.tgattr::int2[])
      WHERE g.tgrelid = 'public.care_tasks'::regclass AND g.tgname = 'care_tasks_freeze_cutoff') IS DISTINCT FROM ARRAY['created_at', 'customer_id', 'period_month']
     OR (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_catalog.pg_trigger g
         JOIN pg_catalog.pg_attribute a ON a.attrelid = g.tgrelid AND a.attnum = ANY (g.tgattr::int2[])
         WHERE g.tgrelid = 'public.care_customers'::regclass AND g.tgname = 'care_customers_freeze_external_id') IS DISTINCT FROM ARRAY['external_id'] THEN
    RAISE EXCEPTION '116 hậu kiểm: cột UPDATE OF của trigger freeze sai';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = 'public.care_tasks'::regclass
                 AND g.tgname = 'care_tasks_block_closed_period' AND g.tgnewtable = 'care_new_tasks') THEN
    RAISE EXCEPTION '116 hậu kiểm: rào chèn thiếu transition table care_new_tasks';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.care_order_period_state WHERE period_month = public.care_period_of(public.care_vn_today()))
     OR NOT EXISTS (SELECT 1 FROM public.care_sync_state WHERE source = 'n3_import_orders') THEN
    RAISE EXCEPTION '116 hậu kiểm: thiếu trạng thái kỳ hiện tại / dòng care_sync_state n3_import_orders';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('116', 'care_order_links',
        'CRM-CSKH E: don N3 xac thuc sau import (E0 r3.4). 7 bang owner-only (care_order_links FK RESTRICT, period_state,'
        || ' runs/run_tasks/run_jobs/run_chunks, task_coverage); 4 trigger ALWAYS (freeze cutoff/external_id, chan chen task ky da'
        || ' chot: READ COMMITTED + khoa X care_import truoc khi doc trang thai, don coverage khi xoa task); RPC dong bo service_role'
        || ' (thuong/chot/trial) + doc authenticated (vi tu care_tasks_select); gate/assess D1 = 115 + Q-175/182;'
        || ' REVOKE DELETE care_tasks FROM service_role. Co CARE_ORDER_LINKS_* OFF.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ── VERIFY (chạy sau COMMIT, chỉ đọc) — gói chính thức: planning/research/dev-tools/e-116/crm-116-verify.sql ──
-- 1) SELECT version, name FROM public.app_migrations WHERE version = '116';   -- 1 dòng
-- 2) md5 gate 116 04c8d4081bb2f3e99ebd5cb07b3a5a54 · assess 116 19c8ae8c5a171a29fd9ca16509a3e0cd
