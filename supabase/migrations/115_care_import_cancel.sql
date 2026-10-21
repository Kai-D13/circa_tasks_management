-- ============================================================================
-- 115_care_import_cancel.sql — CRM-CSKH: huỷ import N1 chưa có lượt chăm sóc (D1)
-- Chạy SAU 114. Operator tạm dừng import của Marketing trước khi chạy (cờ CARE_IMPORT_CANCEL_ENABLED OFF KHÔNG cô lập
-- được thay đổi finalize / close / trigger / ACL của migration này).
--
-- Contract: planning/SPEC.md §Sau go-live D (PM 18/10/2026, gồm hợp đồng commitSeq dòng ~315) · DECISIONS Q-149–163 ·
-- thiết kế planning/research/crm-cskh-import-cancel-design.md r1.5 (PM GO hướng thiết kế cho D1).
--
-- Nội dung:
--   * Provenance: care_customers.created_batch_id; care_import_batches.provenance_version / commit_seq / journal_rows;
--     sequence care_import_commit_seq (CACHE 1, cấp SAU advisory ⇒ đúng thứ tự commit).
--   * Journal đảo ngược revision care_import_revision_journal (before/after image tên/SĐT + dòng sản phẩm bị thay).
--     Chứa PII ⇒ RLS bật, 0 policy, chỉ owner (hàm DEFINER) đọc/ghi. Dọn journal KỲ TRƯỚC trong care__close_period_at
--     (cron đóng kỳ + mọi finalize gọi hàm này); journal kỳ hiện tại giữ tới khi sang kỳ (Q-155/Q-158).
--   * Huỷ: care_import_cancel(batch, actor, expected_commit_seq) + care_import_cancel_preview(batch, actor), chỉ service_role.
--     Ngoại lệ trigger append-only HẸP: chỉ DELETE task / sự kiện 'assigned' của đúng batch đang huỷ, trong đúng transaction
--     có token (pg_current_xact_id), và chỉ khi current_user = owner bảng (tức bên trong hàm DEFINER của owner).
--   * Bảo vệ batch (Q-156): service_role mất UPDATE care_import_batches; trigger chặn INSERT batch không phải staged của
--     role ≠ owner và chặn DELETE batch cancelled thật. Q-162: thu hồi TRUNCATE/TRIGGER/REFERENCES của service_role trên care_*.
--   * CREATE OR REPLACE nguyên văn 114 + đúng các điểm sửa: care__import_finalize_at (5 vị trí), care__close_period_at
--     (1 câu sau GET DIAGNOSTICS), care__forbid_mutation (thân mới). Chữ ký / kiểu trả về / RAISE giữ nguyên.
--
-- Idempotent: chạy lại an toàn (IF NOT EXISTS, DO kiểm tên/định nghĩa constraint, CREATE OR REPLACE, setval sequence).
-- Preflight: app_migrations có 114; PG ≥ 13; current_user = owner care_tasks; mọi bảng care_* cùng owner; md5 thân 3 hàm
-- thuộc {bản 114, bản 115}; 4 trigger append-only của 114 đúng bảng / sự kiện / hàm và đang bật ('O').
--
-- ROLLBACK: dùng file supabase/migrations/rollback/115_care_import_cancel_rollback.sql (đã kiểm trên PGlite — khôi phục
--   NGUYÊN VĂN 3 hàm 114, DROP đối tượng mới, khôi phục ACL 114 bằng GRANT tường minh, DELETE app_migrations '115').
--   Không tự đảo một lần huỷ thật.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ── Preflight ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_owner oid;
  v_bad   text;
  v_md5   text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '114') THEN
    RAISE EXCEPTION '115: thiếu migration nền 114 — chạy đúng thứ tự';
  END IF;
  IF current_setting('server_version_num')::int < 130000 THEN
    RAISE EXCEPTION '115: cần PostgreSQL ≥ 13 (pg_current_xact_id / xid8)';
  END IF;
  SELECT relowner INTO v_owner FROM pg_catalog.pg_class WHERE oid = 'public.care_tasks'::regclass;
  IF current_user <> pg_catalog.pg_get_userbyid(v_owner) THEN
    RAISE EXCEPTION '115: phải chạy bằng owner của care_tasks (%), đang là %', pg_catalog.pg_get_userbyid(v_owner), current_user;
  END IF;
  SELECT string_agg(c.relname, ',') INTO v_bad FROM pg_catalog.pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'care\_%' AND c.relkind IN ('r', 'S') AND c.relowner <> v_owner;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION '115: bảng/sequence care_* khác owner: %', v_bad; END IF;

  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_finalize_at(uuid,uuid,date)'::regprocedure;
  IF v_md5 NOT IN ('121e14feb18accd8ec95424df192d20b', '971ef429c7c12118b5d4029ba41032c1') THEN
    RAISE EXCEPTION '115: care__import_finalize_at trên DB khác bản 114/115 (md5 %) — dừng, đối chiếu thủ công', v_md5;
  END IF;
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__close_period_at(date)'::regprocedure;
  IF v_md5 NOT IN ('cd4fb7f945c0cfa4a7ba12e6696942a3', '022049c0cbed01e8263915e4f967fbb0') THEN
    RAISE EXCEPTION '115: care__close_period_at trên DB khác bản 114/115 (md5 %)', v_md5;
  END IF;
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__forbid_mutation()'::regprocedure;
  IF v_md5 NOT IN ('ae77c258096e0c881e9895d275dc0df4', 'c05a08361dc1095fd50fbb93d31acc97') THEN
    RAISE EXCEPTION '115: care__forbid_mutation trên DB khác bản 114/115 (md5 %)', v_md5;
  END IF;

  -- 4 trigger append-only của 114: đúng bảng, đúng sự kiện, đúng hàm, đang bật.
  SELECT string_agg(x, ' | ') INTO v_bad FROM (
    SELECT e.t || ' thiếu/sai' AS x
    FROM (VALUES ('care_interactions', 'care_interactions_append_only', 'UD'), ('care_assignment_events', 'care_assignment_events_append_only', 'UD'),
                 ('care_store_refusals', 'care_store_refusals_append_only', 'UD'), ('care_tasks', 'care_tasks_no_delete', 'D')) e(t, n, ev)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger g
      WHERE g.tgrelid = ('public.' || e.t)::regclass AND g.tgname = e.n AND NOT g.tgisinternal
        AND g.tgfoid = 'public.care__forbid_mutation()'::regprocedure AND g.tgenabled = 'O'
        -- tgtype: bit 1 ROW, bit 2 BEFORE, bit 8 DELETE, bit 16 UPDATE
        AND (g.tgtype & 1) = 1 AND (g.tgtype & 2) = 2 AND (g.tgtype & 8) = 8
        AND ((e.ev = 'UD' AND (g.tgtype & 16) = 16) OR (e.ev = 'D' AND (g.tgtype & 16) = 0)))
  ) s;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION '115: trigger append-only của 114 không nguyên vẹn: %', v_bad; END IF;
END $$;

-- Tuần tự hoá với finalize/đóng kỳ của kỳ hiện tại. Một finalize đã nạp thân 114 trước khi 115 commit và đang chờ khoá sẽ chạy
-- TIẾP thân 114 sau khi 115 commit; rào care__require_commit_provenance (tạo trong CHÍNH transaction này, §5) làm UPDATE cuối của
-- nó RAISE ⇒ rollback toàn bộ (PM D1 r1 P1-1). Vì vậy batch committed có commit_seq NULL ⇔ commit TRƯỚC 115 — xác định, không
-- dựa trên thời gian. Operator vẫn tạm dừng import khi chạy 115 (lượt bị chặn chỉ cần import lại).
SELECT pg_advisory_xact_lock(hashtextextended('care_import:' || public.care_period_of(public.care_vn_today())::text, 0));

-- ── 1. Sequence + bảng mới (owner-only) ─────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.care_import_commit_seq AS bigint MINVALUE 1 NO CYCLE CACHE 1;

CREATE TABLE IF NOT EXISTS public.care_import_revision_journal (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id             uuid NOT NULL REFERENCES public.care_import_batches(id) ON DELETE CASCADE,
  task_id              uuid NOT NULL REFERENCES public.care_tasks(id) ON DELETE CASCADE,
  prev_customer_name   text NOT NULL,
  prev_phone_norm      text NOT NULL,
  prev_phone_raw       text NOT NULL,
  new_customer_name    text NOT NULL,
  new_phone_norm       text NOT NULL,
  new_phone_raw        text NOT NULL,
  products_replaced    boolean NOT NULL,
  prev_product_row_ids uuid[] NOT NULL DEFAULT '{}',
  is_test              boolean NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Không CHECK products_replaced ⇔ cardinality(prev) ≥ 1 ở đây: một dữ liệu bất thường không được làm hỏng IMPORT thật;
  -- care__import_cancel_assess kiểm điều kiện này và từ chối HUỶ (RESTORE_UNAVAILABLE) — fail-closed ở phía huỷ.
  UNIQUE (batch_id, task_id)
);
CREATE INDEX IF NOT EXISTS care_import_revision_journal_task_idx ON public.care_import_revision_journal (task_id);
ALTER TABLE public.care_import_revision_journal ENABLE ROW LEVEL SECURITY;

-- Vé huỷ của ĐÚNG một transaction (RPC huỷ ghi đầu phần ghi, xoá ở cuối).
CREATE TABLE IF NOT EXISTS public.care_cancel_tokens (
  xact     xid8 PRIMARY KEY,
  batch_id uuid NOT NULL
);
ALTER TABLE public.care_cancel_tokens ENABLE ROW LEVEL SECURITY;

-- Owner-only: thu hồi MỌI quyền của mọi role khác owner (kể cả quyền do default privileges cấp, vd. cho postgres).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel, x.grantee
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname IN ('care_import_revision_journal', 'care_cancel_tokens', 'care_import_commit_seq', 'care_import_revision_journal_id_seq')
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
REVOKE ALL ON public.care_import_revision_journal, public.care_cancel_tokens FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.care_import_commit_seq, public.care_import_revision_journal_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. Hàm 114 được thay (nguyên văn + đúng các điểm sửa) ───────────────────
-- 115: append-only như 114 + ngoại lệ HẸP cho RPC huỷ import: chỉ DELETE task / sự kiện 'assigned' của batch đang huỷ,
-- khi current_user = owner bảng (tức bên trong hàm DEFINER của owner) VÀ transaction giữ token của batch. INVOKER bắt buộc:
-- current_user phải là người gọi thật (DEFINER sẽ biến guard thành no-op). IF lồng: không đọc field OLD trước khi rẽ theo bảng.
CREATE OR REPLACE FUNCTION public.care__forbid_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.is_test THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('care_tasks', 'care_assignment_events') THEN
    IF current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID) THEN
      IF TG_TABLE_NAME = 'care_tasks' THEN
        IF public.care__cancel_delete_allowed(OLD.batch_id, OLD.id, NULL) THEN RETURN OLD; END IF;
      ELSE
        IF public.care__cancel_delete_allowed(OLD.batch_id, OLD.task_id, OLD.kind) THEN RETURN OLD; END IF;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION '%: dữ liệu CRM chỉ thêm, không % (chỉ xoá được dòng is_test khi dọn QA)', TG_TABLE_NAME, TG_OP;
END $$;

CREATE OR REPLACE FUNCTION public.care__close_period_at(p_today date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF p_today IS NULL THEN RAISE EXCEPTION 'care_close_period: thiếu ngày'; END IF;
  -- Cùng khoá với finalize của kỳ mới (re-entrant trong cùng transaction) ⇒ cron
  -- đóng kỳ và import kỳ mới không UPDATE chồng nhau.
  PERFORM pg_advisory_xact_lock(hashtextextended('care_import:' || public.care_period_of(p_today)::text, 0));
  UPDATE public.care_tasks
  SET first_overdue_on = COALESCE(first_overdue_on, public.care_overdue_stamp(next_action_date, due_date, p_today)),
      status = 'closed_unfinished', closed_at = now(), next_action_date = NULL, updated_at = now()
  WHERE status = 'open' AND period_month < public.care_period_of(p_today);
  GET DIAGNOSTICS n = ROW_COUNT;
  -- 115 (Q-155/Q-158): dọn journal huỷ import của KỲ TRƯỚC (PII tên/SĐT) — SAU GET DIAGNOSTICS để n vẫn là số task đóng kỳ.
  -- Chạy mỗi lời gọi: cron care-period-close và mọi finalize (gọi hàm này). Journal kỳ hiện tại giữ tới khi sang kỳ.
  DELETE FROM public.care_import_revision_journal j
  USING public.care_import_batches b
  WHERE j.batch_id = b.id AND b.period_month < public.care_period_of(p_today);
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.care__import_finalize_at(p_batch_id uuid, p_actor uuid, p_today date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch   public.care_import_batches%ROWTYPE;
  v_period  date;
  v_due     date;
  v_kind    text;
  v_dup     uuid;
  v_staged  integer;
  v_err_n   integer;
  v_errors  jsonb;
  v_closed  integer;
  v_created integer;
  v_updated integer;
  v_unchanged integer;
  v_locked  integer;
  v_owner_ignored integer;
  v_absent  integer;
  v_summary jsonb;
  v_seq     bigint;   -- 115: thứ tự commit (cấp sau advisory)
  v_journal integer;  -- 115: số dòng journal revision
BEGIN
  IF p_batch_id IS NULL OR p_actor IS NULL OR p_today IS NULL THEN
    RAISE EXCEPTION 'care_import_finalize: thiếu tham số';
  END IF;
  SELECT * INTO v_batch FROM public.care_import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'care_import_finalize: không tìm thấy batch %', p_batch_id; END IF;
  IF v_batch.status = 'committed' THEN
    RETURN v_batch.summary || jsonb_build_object('status', 'committed', 'batch_id', v_batch.id, 'idempotent', true);
  END IF;
  IF v_batch.status <> 'staged' THEN
    RAISE EXCEPTION 'care_import_finalize: batch % đã kết thúc (%)', p_batch_id, v_batch.status;
  END IF;
  IF v_batch.created_by <> p_actor THEN
    RAISE EXCEPTION 'care_import_finalize: actor khác người tạo batch';
  END IF;
  IF NOT (public.care__uid_is_super(p_actor) OR public.care__uid_can(p_actor, 'import')) THEN
    RAISE EXCEPTION 'care_import_finalize: actor không có quyền import CRM';
  END IF;
  v_period := public.care_period_of(p_today);
  IF v_batch.period_month <> v_period THEN
    RAISE EXCEPTION 'care_import_finalize: kỳ của batch (%) khác tháng hiện tại theo giờ VN (%)', v_batch.period_month, v_period;
  END IF;
  v_due := public.care_period_last_day(v_period);

  -- Mọi finalize cùng kỳ chạy tuần tự.
  PERFORM pg_advisory_xact_lock(hashtextextended('care_import:' || v_period::text, 0));
  -- 115: sequence CACHE 1 cấp SAU advisory ⇒ commit_seq tăng đúng thứ tự commit của các finalize cùng kỳ.
  v_seq := nextval('public.care_import_commit_seq');

  -- row_no = số dòng Excel (B2): phải đủ row_count dòng và LIỀN MẠCH (không hụt khối staging).
  SELECT count(*) INTO v_staged FROM public.care_import_staging WHERE batch_id = p_batch_id;
  IF v_staged <> v_batch.row_count OR (
       SELECT max(row_no) - min(row_no) + 1 FROM public.care_import_staging WHERE batch_id = p_batch_id
     ) IS DISTINCT FROM v_staged THEN
    RAISE EXCEPTION 'care_import_finalize: staging chưa đủ hoặc hụt dòng (% / % dòng) — tải lại file', v_staged, v_batch.row_count;
  END IF;

  SELECT id INTO v_dup FROM public.care_import_batches
  WHERE period_month = v_period AND file_sha256 = v_batch.file_sha256 AND status = 'committed'
    AND is_test = v_batch.is_test AND id <> p_batch_id
  LIMIT 1;
  IF v_dup IS NOT NULL THEN
    UPDATE public.care_import_batches
    SET status = 'duplicate', finished_at = now(), summary = jsonb_build_object('duplicate_of', v_dup)
    WHERE id = p_batch_id;
    DELETE FROM public.care_import_staging WHERE batch_id = p_batch_id;
    RETURN jsonb_build_object('status', 'duplicate', 'batch_id', p_batch_id, 'duplicate_of', v_dup);
  END IF;

  -- ── (1) Chuẩn hoá dòng ────────────────────────────────────────────────────
  DROP TABLE IF EXISTS pg_temp.care_rows;
  CREATE TEMP TABLE care_rows ON COMMIT DROP AS
  SELECT s.row_no,
         nullif(btrim(s.payload->>'customer_external_id'), '') AS ext_id,
         nullif(btrim(s.payload->>'customer_name'), '')        AS cname,
         nullif(btrim(s.payload->>'customer_phone'), '')       AS phone_raw,
         public.care_normalize_vn_phone(s.payload->>'customer_phone') AS phone_norm,
         nullif(btrim(s.payload->>'target_store_code'), '')    AS store_code,
         lower(nullif(btrim(s.payload->>'assignee_email'), '')) AS email,
         nullif(btrim(s.payload->>'reason_type'), '')          AS reason_type,
         nullif(btrim(s.payload->>'reason_text'), '')          AS reason_text,
         nullif(btrim(s.payload->>'product_id'), '')           AS product_id,
         nullif(btrim(s.payload->>'product_name'), '')         AS product_name,
         nullif(btrim(s.payload->>'product_url'), '')          AS product_url,
         NULL::uuid AS store_id,
         NULL::uuid AS assignee_id,
         0          AS assignee_matches
  FROM public.care_import_staging s WHERE s.batch_id = p_batch_id;

  -- Store OS đang hoạt động (AGENTS.md §5) · dược sĩ role staff của ĐÚNG store đó.
  UPDATE care_rows r SET store_id = s.id
  FROM public.stores s
  WHERE s.code = r.store_code AND s.store_type = 'os' AND s.is_active;
  -- Email phải khớp ĐÚNG MỘT staff của store đích (CONTRACT §4, audit PM B1 P0):
  -- public.users.email không có ràng buộc unique, kể cả khác hoa/thường ⇒ đếm ứng
  -- viên; 0 ⇒ ASSIGNEE_INVALID, >1 ⇒ ASSIGNEE_AMBIGUOUS, không bao giờ chọn tuỳ ý.
  -- Staff nghỉ việc (Q-71) đã tháo gán store ⇒ không còn là ứng viên. Preview B2
  -- phải dùng cùng quy tắc.
  UPDATE care_rows r
  SET assignee_matches = m.n,
      assignee_id = CASE WHEN m.n = 1 THEN m.only_id END
  FROM (
    SELECT r2.row_no,
           count(u.id)::int AS n,
           (array_agg(u.id))[1] AS only_id
    FROM care_rows r2
    LEFT JOIN public.users u
      ON lower(btrim(u.email)) = r2.email AND u.role = 'staff' AND u.store_id = r2.store_id
    WHERE r2.store_id IS NOT NULL AND r2.email IS NOT NULL
    GROUP BY r2.row_no
  ) m
  WHERE m.row_no = r.row_no;
  -- Bảng tạm không được autovacuum ANALYZE ⇒ thống kê thật cho planner (file ~10k dòng).
  ANALYZE care_rows;

  -- ── (2) Lỗi (chỉ số dòng + mã, không PII) ─────────────────────────────────
  WITH e AS (
    SELECT row_no, 'FIELD_REQUIRED' AS code FROM care_rows
    WHERE ext_id IS NULL OR cname IS NULL OR phone_raw IS NULL OR store_code IS NULL OR email IS NULL
       OR reason_type IS NULL OR reason_text IS NULL OR product_id IS NULL OR product_name IS NULL
    UNION ALL
    SELECT row_no, 'TOO_LONG' FROM care_rows
    WHERE char_length(ext_id) > 100 OR char_length(cname) > 200 OR char_length(phone_raw) > 30
       OR char_length(reason_type) > 50 OR char_length(reason_text) > 1000 OR char_length(product_id) > 100
       OR char_length(product_name) > 300 OR char_length(product_url) > 1000
    UNION ALL
    SELECT row_no, 'PHONE_INVALID' FROM care_rows WHERE phone_raw IS NOT NULL AND phone_norm IS NULL
    UNION ALL
    -- Q-104: ID sản phẩm toàn số 0 (Text "0"/"00", Number 0 đã thành "0") — mirror validate.ts.
    SELECT row_no, 'PRODUCT_ID_INVALID' FROM care_rows WHERE product_id ~ '^0+$'
    UNION ALL
    SELECT row_no, 'IMAGE_URL_HOST' FROM care_rows
    WHERE product_url IS NOT NULL AND product_url !~ '^https://cdn-gcs\.thuocsi\.vn/'
    UNION ALL
    SELECT row_no, 'STORE_INVALID' FROM care_rows WHERE store_code IS NOT NULL AND store_id IS NULL
    UNION ALL
    SELECT row_no, 'ASSIGNEE_INVALID' FROM care_rows
    WHERE store_id IS NOT NULL AND email IS NOT NULL AND assignee_matches = 0
    UNION ALL
    SELECT row_no, 'ASSIGNEE_AMBIGUOUS' FROM care_rows
    WHERE store_id IS NOT NULL AND email IS NOT NULL AND assignee_matches > 1
    UNION ALL
    SELECT row_no, 'DUPLICATE_PRODUCT' FROM (
      SELECT row_no, count(*) OVER (PARTITION BY ext_id, product_id) AS c
      FROM care_rows WHERE ext_id IS NOT NULL AND product_id IS NOT NULL) d
    WHERE c > 1
    UNION ALL
    SELECT r.row_no, 'INCONSISTENT_CUSTOMER' FROM care_rows r
    WHERE r.ext_id IN (
      SELECT ext_id FROM care_rows WHERE ext_id IS NOT NULL GROUP BY ext_id
      HAVING count(DISTINCT COALESCE(cname, '')) > 1
          OR count(DISTINCT COALESCE(phone_norm, phone_raw, '')) > 1
          OR count(DISTINCT COALESCE(store_code, '')) > 1
          OR count(DISTINCT COALESCE(email, '')) > 1)
    UNION ALL
    -- DNC cùng store (Q-54) — chỉ cho khách sẽ được TẠO task kỳ này (task đã có
    -- trong kỳ không đổi store qua revision).
    SELECT r.row_no, 'REFUSED_AT_STORE' FROM care_rows r
    JOIN public.care_customers c ON c.external_id = r.ext_id
    JOIN public.care_store_refusals f ON f.customer_id = c.id AND f.store_id = r.store_id
    WHERE NOT EXISTS (SELECT 1 FROM public.care_tasks t WHERE t.customer_id = c.id AND t.period_month = v_period)
    UNION ALL
    -- Fixture QA (is_test) và dữ liệu thật KHÔNG dùng chung khách/task: batch test
    -- chạm khách thật (hoặc ngược lại) ⇒ lỗi, không ghi đè snapshot/chiếm chỗ task.
    SELECT r.row_no, 'TEST_FLAG_MISMATCH' FROM care_rows r
    JOIN public.care_customers c ON c.external_id = r.ext_id
    WHERE c.is_test <> v_batch.is_test
       OR EXISTS (SELECT 1 FROM public.care_tasks t
                  WHERE t.customer_id = c.id AND t.period_month = v_period AND t.is_test <> v_batch.is_test)
  ), d AS (SELECT DISTINCT row_no, code FROM e)
  SELECT count(*),
         COALESCE((SELECT jsonb_agg(jsonb_build_object('row', x.row_no, 'code', x.code) ORDER BY x.row_no, x.code)
                   FROM (SELECT * FROM d ORDER BY row_no, code LIMIT 500) x), '[]'::jsonb)
  INTO v_err_n, v_errors FROM d;

  IF v_err_n > 0 THEN
    UPDATE public.care_import_batches
    SET status = 'rejected', finished_at = now(),
        summary = jsonb_build_object('error_count', v_err_n, 'errors', v_errors)
    WHERE id = p_batch_id;
    DELETE FROM public.care_import_staging WHERE batch_id = p_batch_id;
    RETURN jsonb_build_object('status', 'rejected', 'batch_id', p_batch_id, 'error_count', v_err_n, 'errors', v_errors);
  END IF;

  v_kind := CASE WHEN EXISTS (
      SELECT 1 FROM public.care_import_batches
      WHERE period_month = v_period AND status = 'committed' AND is_test = v_batch.is_test)
    THEN 'revision' ELSE 'initial' END;

  -- ── (3) Ghi — đóng kỳ cũ TRƯỚC khi tạo kỳ mới ─────────────────────────────
  v_closed := public.care__close_period_at(p_today);

  -- 115: provenance — khách MỚI ghi batch tạo ra nó (khách đã có giữ nguyên, ON CONFLICT DO NOTHING).
  INSERT INTO public.care_customers (external_id, is_test, created_batch_id)
  SELECT DISTINCT ext_id, v_batch.is_test, p_batch_id FROM care_rows
  ON CONFLICT (external_id) DO NOTHING;

  -- Khoá task kỳ này của các khách trong file (serialize với ghi lượt/chuyển giao).
  PERFORM 1 FROM public.care_tasks t
  JOIN public.care_customers c ON c.id = t.customer_id
  WHERE t.period_month = v_period AND c.external_id IN (SELECT ext_id FROM care_rows)
  ORDER BY t.id FOR UPDATE OF t;

  DROP TABLE IF EXISTS pg_temp.care_cust;
  CREATE TEMP TABLE care_cust ON COMMIT DROP AS
  SELECT g.*,
         t.id AS task_id,
         (t.id IS NULL) AS is_new,
         (t.id IS NOT NULL AND (t.status <> 'open'
            OR EXISTS (SELECT 1 FROM public.care_interactions i WHERE i.task_id = t.id))) AS locked,
         (t.id IS NOT NULL AND (t.store_id <> g.store_id OR t.assignee_id <> g.assignee_id)) AS owner_diff,
         (t.id IS NOT NULL AND (SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'product_id', p.product_id, 'product_name', p.product_name, 'image_url', p.image_url,
              'reason_type', p.reason_type, 'reason_text', p.reason_text) ORDER BY p.product_id), '[]'::jsonb)
            FROM public.care_task_products p WHERE p.task_id = t.id AND p.is_current) IS DISTINCT FROM g.products) AS products_diff,
         (t.id IS NOT NULL AND (t.customer_name, t.phone_norm, t.phone_raw)
            IS DISTINCT FROM (g.cname, g.phone_norm, g.phone_raw)) AS snapshot_diff
  FROM (
    SELECT c.id AS customer_id,
           (array_agg(r.cname))[1]       AS cname,
           (array_agg(r.phone_norm))[1]  AS phone_norm,
           min(r.phone_raw)              AS phone_raw,
           (array_agg(r.store_id))[1]    AS store_id,
           (array_agg(r.assignee_id))[1] AS assignee_id,
           jsonb_agg(jsonb_build_object(
             'product_id', r.product_id, 'product_name', r.product_name, 'image_url', r.product_url,
             'reason_type', r.reason_type, 'reason_text', r.reason_text) ORDER BY r.product_id) AS products
    FROM care_rows r JOIN public.care_customers c ON c.external_id = r.ext_id
    GROUP BY c.id
  ) g
  LEFT JOIN public.care_tasks t ON t.customer_id = g.customer_id AND t.period_month = v_period;
  ANALYZE care_cust;

  -- Task mới.
  INSERT INTO public.care_tasks (customer_id, period_month, due_date, batch_id, store_id, assignee_id,
                                 customer_name, phone_norm, phone_raw, is_test)
  SELECT customer_id, v_period, v_due, p_batch_id, store_id, assignee_id, cname, phone_norm, phone_raw, v_batch.is_test
  FROM care_cust WHERE is_new;
  UPDATE care_cust cc SET task_id = t.id
  FROM public.care_tasks t
  WHERE cc.is_new AND t.customer_id = cc.customer_id AND t.period_month = v_period;

  INSERT INTO public.care_assignment_events (task_id, kind, to_store_id, to_user_id, actor_id, batch_id, is_test)
  SELECT task_id, 'assigned', store_id, assignee_id, p_actor, p_batch_id, v_batch.is_test
  FROM care_cust WHERE is_new;

  -- 115: journal đảo ngược revision — MỘT câu theo tập, TRƯỚC khi tắt sản phẩm / ghi đè snapshot: before + after image
  -- tên/SĐT và id các dòng sản phẩm is_current sắp tắt. Cùng vị từ với v_updated (NOT is_new AND NOT locked AND (pd OR sd)).
  INSERT INTO public.care_import_revision_journal
    (batch_id, task_id, prev_customer_name, prev_phone_norm, prev_phone_raw,
     new_customer_name, new_phone_norm, new_phone_raw, products_replaced, prev_product_row_ids, is_test)
  SELECT p_batch_id, cc.task_id, t.customer_name, t.phone_norm, t.phone_raw,
         CASE WHEN cc.snapshot_diff THEN cc.cname ELSE t.customer_name END,
         CASE WHEN cc.snapshot_diff THEN cc.phone_norm ELSE t.phone_norm END,
         CASE WHEN cc.snapshot_diff THEN cc.phone_raw ELSE t.phone_raw END,
         cc.products_diff,
         CASE WHEN cc.products_diff THEN COALESCE((SELECT array_agg(p.id ORDER BY p.id) FROM public.care_task_products p
                                                   WHERE p.task_id = cc.task_id AND p.is_current), '{}'::uuid[])
              ELSE '{}'::uuid[] END,
         v_batch.is_test
  FROM care_cust cc JOIN public.care_tasks t ON t.id = cc.task_id
  WHERE NOT cc.is_new AND NOT cc.locked AND (cc.products_diff OR cc.snapshot_diff);
  GET DIAGNOSTICS v_journal = ROW_COUNT;

  -- Revision: task chưa có lượt mà sản phẩm/lý do đổi ⇒ thay snapshot sản phẩm.
  UPDATE public.care_task_products p SET is_current = false
  FROM care_cust cc
  WHERE p.task_id = cc.task_id AND p.is_current AND NOT cc.is_new AND NOT cc.locked AND cc.products_diff;

  INSERT INTO public.care_task_products (task_id, batch_id, product_id, product_name, image_url, reason_type, reason_text)
  SELECT cc.task_id, p_batch_id, x->>'product_id', x->>'product_name', x->>'image_url', x->>'reason_type', x->>'reason_text'
  FROM care_cust cc CROSS JOIN LATERAL jsonb_array_elements(cc.products) x
  WHERE cc.is_new OR (NOT cc.locked AND cc.products_diff);

  UPDATE public.care_tasks t
  SET customer_name = cc.cname, phone_norm = cc.phone_norm, phone_raw = cc.phone_raw, updated_at = now()
  FROM care_cust cc
  WHERE t.id = cc.task_id AND NOT cc.is_new AND NOT cc.locked AND cc.snapshot_diff;

  SELECT count(*) FILTER (WHERE is_new),
         count(*) FILTER (WHERE NOT is_new AND NOT locked AND (products_diff OR snapshot_diff)),
         count(*) FILTER (WHERE NOT is_new AND NOT locked AND NOT products_diff AND NOT snapshot_diff),
         count(*) FILTER (WHERE NOT is_new AND locked),
         count(*) FILTER (WHERE NOT is_new AND owner_diff)
  INTO v_created, v_updated, v_unchanged, v_locked, v_owner_ignored
  FROM care_cust;

  SELECT count(*) INTO v_absent FROM public.care_tasks t
  WHERE t.period_month = v_period AND t.is_test = v_batch.is_test
    AND NOT EXISTS (SELECT 1 FROM care_cust cc WHERE cc.customer_id = t.customer_id);

  v_summary := jsonb_build_object(
    'kind', v_kind, 'rows', v_staged,
    'customers', (SELECT count(*) FROM care_cust),
    'stores', (SELECT count(DISTINCT store_id) FROM care_cust WHERE is_new),
    'created', v_created, 'updated', v_updated, 'unchanged', v_unchanged,
    'skipped_has_interaction', v_locked, 'owner_ignored', v_owner_ignored,
    'absent_kept', v_absent, 'closed_previous_period', v_closed);

  -- 115: bằng chứng journal đủ — journal_rows phải bằng summary.updated (cùng vị từ).
  IF v_journal <> v_updated THEN
    RAISE EXCEPTION 'care_import_finalize: journal revision lệch số task cập nhật (% ≠ %)', v_journal, v_updated;
  END IF;
  UPDATE public.care_import_batches
  SET status = 'committed', kind = v_kind, finished_at = now(),
      customer_count = (v_summary->>'customers')::int, store_count = (v_summary->>'stores')::int,
      summary = v_summary,
      provenance_version = 1, commit_seq = v_seq, journal_rows = v_journal   -- 115
  WHERE id = p_batch_id;
  DELETE FROM public.care_import_staging WHERE batch_id = p_batch_id;

  RETURN v_summary || jsonb_build_object('status', 'committed', 'batch_id', p_batch_id);
END $$;

-- ── 3. Hàm mới ──────────────────────────────────────────────────────────────
-- Helper của trigger: true CHỈ khi transaction này giữ token của batch, batch đã 'cancelled', và dòng đúng loại cho phép.
CREATE OR REPLACE FUNCTION public.care__cancel_delete_allowed(p_batch uuid, p_task uuid, p_kind text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_batch IS NULL OR p_task IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.care_cancel_tokens k WHERE k.xact = pg_catalog.pg_current_xact_id() AND k.batch_id = p_batch) THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.care_import_batches b WHERE b.id = p_batch AND b.status = 'cancelled') THEN
    RETURN false;
  END IF;
  IF p_kind IS NOT NULL THEN
    RETURN p_kind = 'assigned';   -- sự kiện: chỉ 'assigned' (transferred có batch_id NULL và không bao giờ khớp)
  END IF;
  RETURN NOT EXISTS (SELECT 1 FROM public.care_interactions i WHERE i.task_id = p_task)
     AND NOT EXISTS (SELECT 1 FROM public.care_order_attributions a WHERE a.task_id = p_task)
     AND NOT EXISTS (SELECT 1 FROM public.care_assignment_events e WHERE e.task_id = p_task AND e.kind = 'transferred');
END $$;

-- Q-156: role ≠ owner chỉ được tạo batch 'staged' với các cột huỷ/provenance để trống (app createBatch, fixture QA).
CREATE OR REPLACE FUNCTION public.care__guard_batch_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID) THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM 'staged' OR NEW.cancelled_by IS NOT NULL OR NEW.cancelled_at IS NOT NULL
     OR NEW.provenance_version IS NOT NULL OR NEW.commit_seq IS NOT NULL OR NEW.journal_rows IS NOT NULL THEN
    RAISE EXCEPTION 'care_import_batches: chỉ được tạo batch staged — cột huỷ/provenance do hệ thống ghi';
  END IF;
  RETURN NEW;
END $$;

-- Q-156: batch đã huỷ (thật) là vết audit — không xoá. Batch is_test (fixture QA) vẫn dọn được.
CREATE OR REPLACE FUNCTION public.care__keep_cancelled_batch()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF OLD.status = 'cancelled' AND NOT OLD.is_test THEN
    RAISE EXCEPTION 'care_import_batches: không xoá batch đã huỷ (giữ vết audit)';
  END IF;
  RETURN OLD;
END $$;

-- Rào thực thi (PM D1 r1 P1-1): sau khi 115 commit, MỌI dòng TRỞ THÀNH 'committed' (INSERT hoặc UPDATE từ trạng thái khác) phải
-- mang commit_seq + provenance — chỉ thân finalize 115 ghi các cột này; dòng đã committed không được đổi 3 cột đó (batch trước 115
-- giữ NULL cả 3, batch sau 115 giữ nguyên giá trị). Áp cho MỌI role (kể cả owner: finalize chạy DEFINER), ENABLE ALWAYS (cả chế độ
-- session_replication_role = replica). Finalize thân 114 chạy chồng 115 ⇒ RAISE ở UPDATE cuối ⇒ không thể có batch committed thiếu
-- commit_seq commit SAU 115. Chỉ owner/superuser chủ động DISABLE / DROP trigger mới vượt được (VERIFY 115 V6 kiểm định nghĩa).
CREATE OR REPLACE FUNCTION public.care__require_commit_provenance()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'committed' THEN
    IF (NEW.commit_seq, NEW.provenance_version, NEW.journal_rows) IS DISTINCT FROM (OLD.commit_seq, OLD.provenance_version, OLD.journal_rows) THEN
      RAISE EXCEPTION 'care_import_batches: không sửa commit_seq/provenance của batch đã commit';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.commit_seq IS NULL OR NEW.provenance_version IS NULL OR NEW.journal_rows IS NULL THEN
    RAISE EXCEPTION 'care_import_batches: chỉ finalize bản 115 được commit batch (thiếu commit_seq/provenance) — lượt import này đã bị huỷ, hãy import lại';
  END IF;
  RETURN NEW;
END $$;

-- Đánh giá điều kiện huỷ của batch B (đọc trạng thái hiện tại; caller tự khoá). Trả mã từ chối hoặc NULL + số đếm dự kiến.
--   HAS_ACTIVITY: task trong T(B) không còn open / khác kỳ / khác is_test, hoặc có lượt / chuyển giao / attribution / từ chối.
--   RESTORE_UNAVAILABLE: không chứng minh được khôi phục chính xác (journal thiếu/lệch, sản phẩm B ngoài phạm vi, T_new ∩ T_mod).
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

-- Kiểm chung đầu vào của preview/huỷ: quyền, batch, trạng thái, kỳ (theo p_today), provenance, "mới nhất".
CREATE OR REPLACE FUNCTION public.care__import_cancel_gate(p_batch_id uuid, p_actor uuid, p_today date)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b public.care_import_batches%ROWTYPE;
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
  -- Batch committed commit_seq NULL cùng partition đều commit TRƯỚC 115 (rào care__require_commit_provenance) ⇒ cũ hơn B; không xét.
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.care__import_cancel_preview_at(p_batch_id uuid, p_actor uuid, p_today date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code text;
  v_a    jsonb;
  b      public.care_import_batches%ROWTYPE;
BEGIN
  IF p_batch_id IS NULL OR p_actor IS NULL OR p_today IS NULL THEN
    RAISE EXCEPTION 'care_import_cancel_preview: thiếu tham số';
  END IF;
  v_code := public.care__import_cancel_gate(p_batch_id, p_actor, p_today);
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('status', 'rejected', 'code', v_code); END IF;
  v_a := public.care__import_cancel_assess(p_batch_id);
  IF v_a->>'code' IS NOT NULL THEN RETURN jsonb_build_object('status', 'rejected', 'code', v_a->>'code'); END IF;
  SELECT * INTO b FROM public.care_import_batches WHERE id = p_batch_id;
  -- commit_seq trả CHUỖI số thập phân (bigint không đi qua JS Number).
  RETURN (v_a - 'code') || jsonb_build_object('status', 'ready', 'batch_id', b.id, 'kind', b.kind, 'commit_seq', b.commit_seq::text);
END $$;

CREATE OR REPLACE FUNCTION public.care_import_cancel_preview(p_batch_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.care__import_cancel_preview_at(p_batch_id, p_actor, public.care_vn_today())
$$;

-- Huỷ MỘT batch. p_now chỉ để test biên tháng (bản _at không cấp cho role nào); wrapper luôn dùng clock_timestamp().
CREATE OR REPLACE FUNCTION public.care__import_cancel_at(p_batch_id uuid, p_actor uuid, p_expected_commit_seq bigint, p_today date,
                                                         p_now timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  b           public.care_import_batches%ROWTYPE;
  v_code      text;
  v_a         jsonb;
  v_new       uuid[];
  v_all       uuid[];
  v_cur_out   bigint;
  v_n         bigint;
  v_tasks     bigint;
  v_prod      bigint;
  v_prod_r    bigint;
  v_events    bigint;
  v_cust      bigint;
  v_restored  bigint;
  v_cancel    jsonb;
BEGIN
  IF p_batch_id IS NULL OR p_actor IS NULL OR p_expected_commit_seq IS NULL OR p_today IS NULL THEN
    RAISE EXCEPTION 'care_import_cancel: thiếu tham số';
  END IF;
  IF NOT (public.care__uid_is_super(p_actor) OR public.care__uid_can(p_actor, 'import')) THEN
    RETURN jsonb_build_object('status', 'rejected', 'code', 'FORBIDDEN');
  END IF;
  SELECT * INTO b FROM public.care_import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'rejected', 'code', 'NOT_FOUND'); END IF;
  IF b.status <> 'committed' THEN RETURN jsonb_build_object('status', 'rejected', 'code', 'NOT_COMMITTED'); END IF;
  IF b.period_month <> public.care_period_of(p_today) THEN RETURN jsonb_build_object('status', 'rejected', 'code', 'NOT_CURRENT_PERIOD'); END IF;
  IF b.provenance_version IS NULL OR b.commit_seq IS NULL OR b.journal_rows IS NULL THEN
    RETURN jsonb_build_object('status', 'rejected', 'code', 'PROVENANCE_UNAVAILABLE');
  END IF;

  -- Cùng key với finalize / đóng kỳ của kỳ này.
  PERFORM pg_advisory_xact_lock(hashtextextended('care_import:' || b.period_month::text, 0));

  -- Sau khoá: kỳ theo đồng hồ THẬT (now() là giờ bắt đầu transaction), rồi "mới nhất" + commitSeq đã xác nhận.
  IF public.care_period_of(public.care_vn_date(COALESCE(p_now, clock_timestamp()))) <> b.period_month THEN
    RETURN jsonb_build_object('status', 'rejected', 'code', 'NOT_CURRENT_PERIOD');
  END IF;
  v_code := public.care__import_cancel_gate(p_batch_id, p_actor, p_today);
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('status', 'rejected', 'code', v_code); END IF;
  IF b.commit_seq IS DISTINCT FROM p_expected_commit_seq THEN
    RETURN jsonb_build_object('status', 'rejected', 'code', 'NOT_LATEST');
  END IF;

  SELECT COALESCE(array_agg(t.id ORDER BY t.id), '{}') INTO v_new FROM public.care_tasks t WHERE t.batch_id = p_batch_id;
  SELECT v_new || COALESCE(array_agg(j.task_id ORDER BY j.task_id), '{}') INTO v_all
  FROM public.care_import_revision_journal j WHERE j.batch_id = p_batch_id;
  PERFORM 1 FROM public.care_tasks t WHERE t.id = ANY (v_all) ORDER BY t.id FOR UPDATE;

  -- Sau khoá task: đánh giá lại toàn bộ.
  v_a := public.care__import_cancel_assess(p_batch_id);
  IF v_a->>'code' IS NOT NULL THEN RETURN jsonb_build_object('status', 'rejected', 'code', v_a->>'code'); END IF;
  SELECT count(*) INTO v_cur_out FROM public.care_task_products p WHERE p.is_current AND NOT (p.task_id = ANY (v_all));

  -- ── Ghi (mọi UPDATE/DELETE có WHERE — pg_safeupdate) ──
  INSERT INTO public.care_cancel_tokens (xact, batch_id) VALUES (pg_catalog.pg_current_xact_id(), p_batch_id);
  v_cancel := (v_a - 'code');
  UPDATE public.care_import_batches
  SET status = 'cancelled', cancelled_by = p_actor, cancelled_at = now(),
      summary = summary || jsonb_build_object('cancel', v_cancel)
  WHERE id = p_batch_id;

  -- Khôi phục T_mod: bỏ dòng sản phẩm của B, bật lại bộ trước, trả tên/SĐT về trước revision.
  DELETE FROM public.care_task_products p
  USING public.care_import_revision_journal j
  WHERE j.batch_id = p_batch_id AND j.products_replaced AND p.task_id = j.task_id AND p.batch_id = p_batch_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_prod := v_n;
  UPDATE public.care_task_products p SET is_current = true
  FROM public.care_import_revision_journal j
  WHERE j.batch_id = p_batch_id AND j.products_replaced AND p.id = ANY (j.prev_product_row_ids) AND p.task_id = j.task_id;
  GET DIAGNOSTICS v_prod_r = ROW_COUNT;
  UPDATE public.care_tasks t
  SET customer_name = j.prev_customer_name, phone_norm = j.prev_phone_norm, phone_raw = j.prev_phone_raw, updated_at = now()
  FROM public.care_import_revision_journal j
  WHERE j.batch_id = p_batch_id AND t.id = j.task_id;
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  -- Xoá T_new.
  DELETE FROM public.care_task_products p WHERE p.task_id = ANY (v_new);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_prod := v_prod + v_n;
  DELETE FROM public.care_assignment_events e WHERE e.batch_id = p_batch_id AND e.kind = 'assigned' AND e.task_id = ANY (v_new);
  GET DIAGNOSTICS v_events = ROW_COUNT;
  DELETE FROM public.care_tasks t WHERE t.id = ANY (v_new);
  GET DIAGNOSTICS v_tasks = ROW_COUNT;
  DELETE FROM public.care_customers c
  WHERE c.created_batch_id = p_batch_id
    AND NOT EXISTS (SELECT 1 FROM public.care_tasks t WHERE t.customer_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM public.care_interactions i WHERE i.customer_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM public.care_store_refusals r WHERE r.customer_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM public.care_reconcile_queue q WHERE q.customer_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM public.care_order_attributions a WHERE a.customer_id = c.id);
  GET DIAGNOSTICS v_cust = ROW_COUNT;

  -- Hậu kiểm trước khi xoá journal (cần journal để so trạng thái khôi phục).
  IF EXISTS (SELECT 1 FROM public.care_tasks WHERE batch_id = p_batch_id)
     OR EXISTS (SELECT 1 FROM public.care_task_products WHERE batch_id = p_batch_id)
     OR EXISTS (SELECT 1 FROM public.care_assignment_events WHERE batch_id = p_batch_id AND kind = 'assigned') THEN
    RAISE EXCEPTION 'care_import_cancel: hậu kiểm — còn dòng trỏ batch';
  END IF;
  IF EXISTS (SELECT 1 FROM public.care_import_revision_journal j JOIN public.care_tasks t ON t.id = j.task_id
             WHERE j.batch_id = p_batch_id
               AND ((t.customer_name, t.phone_norm, t.phone_raw) IS DISTINCT FROM (j.prev_customer_name, j.prev_phone_norm, j.prev_phone_raw)
                    OR NOT EXISTS (SELECT 1 FROM public.care_task_products p WHERE p.task_id = j.task_id AND p.is_current)
                    OR (j.products_replaced AND (
                          (SELECT array_agg(p.id ORDER BY p.id) FROM public.care_task_products p WHERE p.task_id = j.task_id AND p.is_current)
                          IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(j.prev_product_row_ids) x))))) THEN
    RAISE EXCEPTION 'care_import_cancel: hậu kiểm — khôi phục revision không khớp journal';
  END IF;
  SELECT count(*) INTO v_n FROM public.care_task_products p WHERE p.is_current AND NOT (p.task_id = ANY (v_all));
  IF v_n <> v_cur_out THEN RAISE EXCEPTION 'care_import_cancel: hậu kiểm — đổi sản phẩm ngoài phạm vi'; END IF;
  IF v_tasks <> (v_a->>'tasks_deleted')::bigint OR v_restored <> (v_a->>'tasks_restored')::bigint
     OR v_prod <> (v_a->>'products_deleted')::bigint OR v_prod_r <> (v_a->>'products_restored')::bigint
     OR v_events <> (v_a->>'events_deleted')::bigint OR v_cust <> (v_a->>'customers_deleted')::bigint THEN
    RAISE EXCEPTION 'care_import_cancel: hậu kiểm — số đếm lệch đánh giá';
  END IF;

  DELETE FROM public.care_import_revision_journal WHERE batch_id = p_batch_id;
  DELETE FROM public.care_cancel_tokens WHERE xact = pg_catalog.pg_current_xact_id();
  IF EXISTS (SELECT 1 FROM public.care_cancel_tokens WHERE batch_id = p_batch_id) THEN
    RAISE EXCEPTION 'care_import_cancel: hậu kiểm — token còn';
  END IF;

  RETURN v_cancel || jsonb_build_object('status', 'cancelled', 'batch_id', p_batch_id, 'kind', b.kind);
END $$;

CREATE OR REPLACE FUNCTION public.care_import_cancel(p_batch_id uuid, p_actor uuid, p_expected_commit_seq bigint)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.care__import_cancel_at(p_batch_id, p_actor, p_expected_commit_seq, public.care_vn_today(), NULL)
$$;

-- ── 4. Quyền hàm (REVOKE đích danh rồi GRANT — AGENTS §4.2) ─────────────────
REVOKE ALL ON FUNCTION
  public.care__forbid_mutation(), public.care__close_period_at(date), public.care__import_finalize_at(uuid, uuid, date),
  public.care__cancel_delete_allowed(uuid, uuid, text), public.care__guard_batch_insert(), public.care__keep_cancelled_batch(),
  public.care__require_commit_provenance(), public.care__import_cancel_assess(uuid), public.care__import_cancel_gate(uuid, uuid, date),
  public.care__import_cancel_preview_at(uuid, uuid, date), public.care__import_cancel_at(uuid, uuid, bigint, date, timestamptz),
  public.care_import_cancel_preview(uuid, uuid), public.care_import_cancel(uuid, uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.care_import_cancel_preview(uuid, uuid), public.care_import_cancel(uuid, uuid, bigint) TO service_role;

-- ── 5. Bảng 114 (ALTER đặt cuối) ────────────────────────────────────────────
ALTER TABLE public.care_import_batches ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES public.users(id);
ALTER TABLE public.care_import_batches ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE public.care_import_batches ADD COLUMN IF NOT EXISTS provenance_version smallint;
ALTER TABLE public.care_import_batches ADD COLUMN IF NOT EXISTS commit_seq bigint;
ALTER TABLE public.care_import_batches ADD COLUMN IF NOT EXISTS journal_rows integer;
ALTER TABLE public.care_customers ADD COLUMN IF NOT EXISTS created_batch_id uuid REFERENCES public.care_import_batches(id);

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(oid) INTO v_def FROM pg_catalog.pg_constraint
  WHERE conrelid = 'public.care_import_batches'::regclass AND conname = 'care_import_batches_status_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '115: không thấy care_import_batches_status_check';
  ELSIF v_def = 'CHECK ((status = ANY (ARRAY[''staged''::text, ''committed''::text, ''rejected''::text, ''duplicate''::text, ''cancelled''::text])))' THEN
    NULL;  -- đã là bản 115 (so NGUYÊN VĂN — dạng khác ⇒ RAISE)
  ELSIF v_def = 'CHECK ((status = ANY (ARRAY[''staged''::text, ''committed''::text, ''rejected''::text, ''duplicate''::text])))' THEN
    ALTER TABLE public.care_import_batches DROP CONSTRAINT care_import_batches_status_check;
    ALTER TABLE public.care_import_batches ADD CONSTRAINT care_import_batches_status_check
      CHECK (status IN ('staged', 'committed', 'rejected', 'duplicate', 'cancelled'));
  ELSE
    RAISE EXCEPTION '115: care_import_batches_status_check khác bản 114/115: %', v_def;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.care_import_batches'::regclass
                 AND conname = 'care_import_batches_cancel_meta_check') THEN
    ALTER TABLE public.care_import_batches ADD CONSTRAINT care_import_batches_cancel_meta_check
      CHECK ((status = 'cancelled') = (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.care_import_batches'::regclass
                 AND conname = 'care_import_batches_provenance_check') THEN
    ALTER TABLE public.care_import_batches ADD CONSTRAINT care_import_batches_provenance_check
      CHECK ((provenance_version IS NULL) = (commit_seq IS NULL)
             AND (provenance_version IS NULL) = (journal_rows IS NULL)
             AND (journal_rows IS NULL OR journal_rows >= 0)
             AND (provenance_version IS NULL OR status IN ('committed', 'cancelled'))
             AND (status <> 'cancelled' OR provenance_version IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS care_import_batches_latest_idx ON public.care_import_batches (period_month, is_test, commit_seq) WHERE status = 'committed';
CREATE INDEX IF NOT EXISTS care_customers_created_batch_idx ON public.care_customers (created_batch_id) WHERE created_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS care_tasks_batch_idx ON public.care_tasks (batch_id);
CREATE INDEX IF NOT EXISTS care_task_products_batch_idx ON public.care_task_products (batch_id);
CREATE INDEX IF NOT EXISTS care_assignment_events_batch_idx ON public.care_assignment_events (batch_id) WHERE batch_id IS NOT NULL;

DROP TRIGGER IF EXISTS care_import_batches_guard_insert ON public.care_import_batches;
CREATE TRIGGER care_import_batches_guard_insert BEFORE INSERT ON public.care_import_batches
  FOR EACH ROW EXECUTE FUNCTION public.care__guard_batch_insert();
DROP TRIGGER IF EXISTS care_import_batches_keep_cancelled ON public.care_import_batches;
CREATE TRIGGER care_import_batches_keep_cancelled BEFORE DELETE ON public.care_import_batches
  FOR EACH ROW EXECUTE FUNCTION public.care__keep_cancelled_batch();
DROP TRIGGER IF EXISTS care_import_batches_require_provenance ON public.care_import_batches;
CREATE TRIGGER care_import_batches_require_provenance BEFORE INSERT OR UPDATE ON public.care_import_batches
  FOR EACH ROW WHEN (NEW.status = 'committed')
  EXECUTE FUNCTION public.care__require_commit_provenance();
ALTER TABLE public.care_import_batches ENABLE ALWAYS TRIGGER care_import_batches_require_provenance;

-- ACL (Q-156, Q-162). Không đụng SELECT/INSERT/DELETE; created_batch_id KHÔNG cấp cho authenticated (114 chỉ cấp 3 cột).
REVOKE UPDATE ON public.care_import_batches FROM service_role;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON
  public.care_access, public.care_import_batches, public.care_import_staging, public.care_customers, public.care_tasks,
  public.care_task_products, public.care_interactions, public.care_assignment_events, public.care_store_refusals,
  public.care_reconcile_queue, public.care_orders, public.care_order_attributions, public.care_sync_state
  FROM service_role;

-- Chạy lại sau rollback giữ sequence: đẩy sequence lên trên mọi commit_seq đã có.
SELECT setval('public.care_import_commit_seq',
              GREATEST((SELECT last_value FROM public.care_import_commit_seq),
                       COALESCE((SELECT max(commit_seq) FROM public.care_import_batches), 1)),
              (SELECT max(commit_seq) FROM public.care_import_batches) IS NOT NULL
                OR (SELECT is_called FROM public.care_import_commit_seq));

-- ── 6. Hậu kiểm TRONG transaction ───────────────────────────────────────────
DO $$
DECLARE
  v_t   text;
  v_p   text;
  v_n   integer;
  v_exp jsonb := jsonb_build_object(
    'service_role', jsonb_build_object('SELECT', 13, 'INSERT', 13, 'UPDATE', 12, 'DELETE', 13, 'TRUNCATE', 0, 'TRIGGER', 0, 'REFERENCES', 0),
    'authenticated', jsonb_build_object('SELECT', 8, 'INSERT', 1, 'UPDATE', 1, 'DELETE', 1, 'TRUNCATE', 0, 'TRIGGER', 0, 'REFERENCES', 0),
    'anon', jsonb_build_object('SELECT', 0, 'INSERT', 0, 'UPDATE', 0, 'DELETE', 0, 'TRUNCATE', 0, 'TRIGGER', 0, 'REFERENCES', 0));
BEGIN
  -- Ma trận ACL bảng care_* (15 bảng).
  FOR v_t IN SELECT jsonb_object_keys(v_exp) LOOP
    FOR v_p IN SELECT jsonb_object_keys(v_exp -> v_t) LOOP
      SELECT count(*) INTO v_n FROM pg_catalog.pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'care\_%' AND c.relkind = 'r'
        AND has_table_privilege(v_t, c.oid, v_p);
      IF v_n <> (v_exp -> v_t ->> v_p)::int THEN
        RAISE EXCEPTION '115 hậu kiểm: % có % trên % bảng care_* (kỳ vọng %)', v_t, v_p, v_n, v_exp -> v_t ->> v_p;
      END IF;
    END LOOP;
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'care\_%' AND c.relkind = 'r';
  IF v_n <> 15 THEN RAISE EXCEPTION '115 hậu kiểm: % bảng care_* (kỳ vọng 15)', v_n; END IF;
  -- Journal / token / sequence: không role nào ngoài owner.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
             WHERE c.relnamespace = 'public'::regnamespace AND x.grantee <> c.relowner
               AND c.relname IN ('care_import_revision_journal', 'care_cancel_tokens', 'care_import_commit_seq', 'care_import_revision_journal_id_seq')) THEN
    RAISE EXCEPTION '115 hậu kiểm: journal/token/sequence có quyền ngoài owner';
  END IF;
  IF has_column_privilege('authenticated', 'public.care_customers', 'created_batch_id', 'SELECT') THEN
    RAISE EXCEPTION '115 hậu kiểm: authenticated đọc được care_customers.created_batch_id';
  END IF;
  IF (SELECT seqcache FROM pg_catalog.pg_sequence WHERE seqrelid = 'public.care_import_commit_seq'::regclass) <> 1 THEN
    RAISE EXCEPTION '115 hậu kiểm: care_import_commit_seq phải CACHE 1';
  END IF;
  -- Hàm: không role nào EXECUTE hàm nội bộ / hàm thay; chỉ service_role EXECUTE 2 wrapper; anon/authenticated không có gì.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname IN ('care__forbid_mutation', 'care__close_period_at', 'care__import_finalize_at', 'care__cancel_delete_allowed',
                               'care__guard_batch_insert', 'care__keep_cancelled_batch', 'care__require_commit_provenance',
                               'care__import_cancel_assess', 'care__import_cancel_gate', 'care__import_cancel_preview_at', 'care__import_cancel_at')
             AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  OR has_function_privilege('service_role', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION '115 hậu kiểm: hàm nội bộ có quyền EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.care_import_cancel(uuid, uuid, bigint)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.care_import_cancel_preview(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.care_import_cancel(uuid, uuid, bigint)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.care_import_cancel(uuid, uuid, bigint)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.care_import_cancel_preview(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.care_import_cancel_preview(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '115 hậu kiểm: quyền 2 wrapper huỷ sai';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'care_import_cancel'
             AND p.oid <> 'public.care_import_cancel(uuid, uuid, bigint)'::regprocedure) THEN
    RAISE EXCEPTION '115 hậu kiểm: có overload care_import_cancel khác chữ ký 3 tham số';
  END IF;
  -- Hàm trigger INVOKER; hàm DEFINER có search_path=public và cùng owner bảng.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname IN ('care__forbid_mutation', 'care__guard_batch_insert', 'care__keep_cancelled_batch', 'care__require_commit_provenance')
             AND p.prosecdef) THEN
    RAISE EXCEPTION '115 hậu kiểm: hàm trigger phải SECURITY INVOKER';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'care%' AND p.prosecdef
             AND (NOT (COALESCE(p.proconfig, '{}') @> ARRAY['search_path=public'])
                  OR p.proowner <> (SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.care_tasks'::regclass))) THEN
    RAISE EXCEPTION '115 hậu kiểm: hàm DEFINER care%% thiếu search_path=public hoặc khác owner';
  END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'care%';
  IF v_n <> 51 THEN RAISE EXCEPTION '115 hậu kiểm: % hàm care%% (kỳ vọng 41 + 10 = 51)', v_n; END IF;
  -- 7 trigger care_* bật (4 của 114 + guard insert + giữ batch huỷ + rào commit 'A' = ENABLE ALWAYS).
  SELECT count(*) INTO v_n FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid
  WHERE NOT g.tgisinternal AND c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'care\_%' AND g.tgenabled IN ('O', 'A');
  IF v_n <> 7 THEN RAISE EXCEPTION '115 hậu kiểm: % trigger care_* bật (kỳ vọng 7)', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = 'public.care_import_batches'::regclass
                 AND g.tgname = 'care_import_batches_require_provenance' AND g.tgenabled = 'A' AND NOT g.tgisinternal
                 AND g.tgtype = 23  -- ROW + BEFORE + INSERT + UPDATE
                 AND g.tgfoid = 'public.care__require_commit_provenance()'::regprocedure) THEN
    RAISE EXCEPTION '115 hậu kiểm: thiếu rào care_import_batches_require_provenance';
  END IF;
  -- Key advisory chung của finalize / close / huỷ (P1-10).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace
             AND proname IN ('care__import_finalize_at', 'care__close_period_at', 'care__import_cancel_at')
             AND position('''care_import:''' in prosrc) = 0) THEN
    RAISE EXCEPTION '115 hậu kiểm: thiếu key advisory care_import: ở finalize/close/huỷ';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('115', 'care_import_cancel',
        'CRM-CSKH D1: huy import N1 chua co luot (Q-149..163). Provenance created_batch_id + provenance_version/commit_seq/journal_rows;'
        || ' journal dao nguoc revision (owner-only, don ky truoc trong care__close_period_at); RPC care_import_cancel(batch, actor,'
        || ' expected_commit_seq) + care_import_cancel_preview (service_role); ngoai le trigger hep (token theo transaction + owner);'
        || ' bao ve batch (service_role mat UPDATE, trigger INSERT/DELETE); thu hoi TRUNCATE/TRIGGER/REFERENCES cua service_role.'
        || ' Co CARE_IMPORT_CANCEL_ENABLED OFF (khong co lap thay doi finalize/close).')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ── VERIFY (chạy sau COMMIT, chỉ đọc) — gói chính thức: planning/research/dev-tools/crm-115-verify.sql (D1, PM audit) ──
-- 1) SELECT version, name FROM public.app_migrations WHERE version = '115';   -- 1 dòng
-- 2) Ma trận ACL care_* (V-ACL): service_role 13/13/12/13/0/0/0 · authenticated 8/1/1/1/0/0/0 · anon 0×7
-- 3) md5 thân 3 hàm thay = bản 115: finalize 971ef429c7c12118b5d4029ba41032c1 · close 022049c0cbed01e8263915e4f967fbb0 · forbid c05a08361dc1095fd50fbb93d31acc97
