-- ============================================================================
-- rollback/115_care_import_cancel_rollback.sql — HOÀN TÁC migration 115 (chỉ operator chạy, khi PM/operator quyết rollback DB).
-- KHÔNG nằm trong luồng migration tuần tự (thư mục rollback/). Đã kiểm trên PGlite (webapp/scripts/qa-care-115.mjs):
-- có / không có batch 'cancelled', rồi chạy lại 115.
--
-- Thứ tự (thiết kế D0 r1.5 §9.2):
--   1. khôi phục NGUYÊN VĂN 114 của care__forbid_mutation / care__close_period_at / care__import_finalize_at (+ REVOKE như 114);
--   2. DROP 2 trigger + hàm mới của 115;
--   3. xoá provenance của batch KHÔNG 'cancelled' (tránh "có provenance mà mất journal" nếu chạy lại 115);
--   4. DROP journal, token, index mới, cột care_customers.created_batch_id; GIỮ sequence nếu còn batch 'cancelled' có commit_seq;
--   5. ACL 114 bằng GRANT TƯỜNG MINH (TRUNCATE chỉ 9 bảng — KHÔNG mở lại 4 bảng append-only);
--   6. DROP cột / CHECK mới của care_import_batches + khôi phục CHECK status 114 CHỈ KHI không có batch 'cancelled';
--   7. DELETE FROM app_migrations WHERE version = '115';
--   8. hậu kiểm: md5 thân 3 hàm = 114, ACL service_role = 13/13/13/13/9/13/13 trên 13 bảng, 4 trigger, 41 hàm care%.
-- Không đảo một lần huỷ thật (batch 'cancelled' giữ nguyên, dữ liệu đã xoá không phục hồi).
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '115') THEN
    RAISE EXCEPTION 'rollback 115: chưa có migration 115';
  END IF;
  -- Đã có migration sau 115 (vd 116 sửa finalize) ⇒ rollback sẽ đè thân hàm của bản sau bằng 114 ⇒ dừng, rollback bản sau trước.
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE version ~ '^[0-9]{3}$' AND version::int > 115) THEN
    RAISE EXCEPTION 'rollback 115: đã có migration sau 115 — rollback bản đó trước';
  END IF;
  IF current_user <> (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.care_tasks'::regclass) THEN
    RAISE EXCEPTION 'rollback 115: phải chạy bằng owner của care_tasks';
  END IF;
END $$;
SELECT pg_advisory_xact_lock(hashtextextended('care_import:' || public.care_period_of(public.care_vn_today())::text, 0));

-- ── 1. Khôi phục nguyên văn 114 ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.care__forbid_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.is_test THEN RETURN OLD; END IF;
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

  INSERT INTO public.care_customers (external_id, is_test)
  SELECT DISTINCT ext_id, v_batch.is_test FROM care_rows
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

  UPDATE public.care_import_batches
  SET status = 'committed', kind = v_kind, finished_at = now(),
      customer_count = (v_summary->>'customers')::int, store_count = (v_summary->>'stores')::int,
      summary = v_summary
  WHERE id = p_batch_id;
  DELETE FROM public.care_import_staging WHERE batch_id = p_batch_id;

  RETURN v_summary || jsonb_build_object('status', 'committed', 'batch_id', p_batch_id);
END $$;

REVOKE ALL ON FUNCTION public.care__forbid_mutation(), public.care__close_period_at(date), public.care__import_finalize_at(uuid, uuid, date)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. Trigger + hàm mới ────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS care_import_batches_guard_insert ON public.care_import_batches;
DROP TRIGGER IF EXISTS care_import_batches_keep_cancelled ON public.care_import_batches;
DROP TRIGGER IF EXISTS care_import_batches_require_provenance ON public.care_import_batches;  -- rào r1.1: bỏ để finalize 114 chạy lại được
DROP FUNCTION IF EXISTS public.care_import_cancel(uuid, uuid, bigint);
DROP FUNCTION IF EXISTS public.care__import_cancel_at(uuid, uuid, bigint, date, timestamptz);
DROP FUNCTION IF EXISTS public.care_import_cancel_preview(uuid, uuid);
DROP FUNCTION IF EXISTS public.care__import_cancel_preview_at(uuid, uuid, date);
DROP FUNCTION IF EXISTS public.care__import_cancel_gate(uuid, uuid, date);
DROP FUNCTION IF EXISTS public.care__import_cancel_assess(uuid);
DROP FUNCTION IF EXISTS public.care__keep_cancelled_batch();
DROP FUNCTION IF EXISTS public.care__require_commit_provenance();
DROP FUNCTION IF EXISTS public.care__guard_batch_insert();
DROP FUNCTION IF EXISTS public.care__cancel_delete_allowed(uuid, uuid, text);

-- ── 3. Provenance của batch không 'cancelled' ───────────────────────────────
UPDATE public.care_import_batches
SET provenance_version = NULL, commit_seq = NULL, journal_rows = NULL
WHERE status <> 'cancelled' AND (provenance_version IS NOT NULL OR commit_seq IS NOT NULL OR journal_rows IS NOT NULL);

-- ── 4. Đối tượng mới ────────────────────────────────────────────────────────
DROP TABLE IF EXISTS public.care_import_revision_journal;
DROP TABLE IF EXISTS public.care_cancel_tokens;
DROP INDEX IF EXISTS public.care_customers_created_batch_idx;
DROP INDEX IF EXISTS public.care_tasks_batch_idx;
DROP INDEX IF EXISTS public.care_task_products_batch_idx;
DROP INDEX IF EXISTS public.care_assignment_events_batch_idx;
DROP INDEX IF EXISTS public.care_import_batches_latest_idx;
ALTER TABLE public.care_customers DROP COLUMN IF EXISTS created_batch_id;

-- ── 5. ACL 114 tường minh ───────────────────────────────────────────────────
GRANT UPDATE ON public.care_import_batches TO service_role;
GRANT TRIGGER, REFERENCES ON
  public.care_access, public.care_import_batches, public.care_import_staging, public.care_customers, public.care_tasks,
  public.care_task_products, public.care_interactions, public.care_assignment_events, public.care_store_refusals,
  public.care_reconcile_queue, public.care_orders, public.care_order_attributions, public.care_sync_state
  TO service_role;
-- TRUNCATE CHỈ 9 bảng (114:625–626 thu hồi trên care_tasks / care_interactions / care_assignment_events / care_store_refusals).
GRANT TRUNCATE ON
  public.care_access, public.care_import_batches, public.care_import_staging, public.care_customers,
  public.care_task_products, public.care_reconcile_queue, public.care_orders, public.care_order_attributions, public.care_sync_state
  TO service_role;

-- ── 6. Cột / CHECK của care_import_batches (chỉ khi không có batch đã huỷ) ───
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.care_import_batches WHERE status = 'cancelled') THEN
    RAISE NOTICE 'rollback 115: còn batch cancelled — GIỮ cột/CHECK/sequence của 115 (additive)';
  ELSE
    ALTER TABLE public.care_import_batches DROP CONSTRAINT IF EXISTS care_import_batches_provenance_check;
    ALTER TABLE public.care_import_batches DROP CONSTRAINT IF EXISTS care_import_batches_cancel_meta_check;
    ALTER TABLE public.care_import_batches DROP CONSTRAINT IF EXISTS care_import_batches_status_check;
    ALTER TABLE public.care_import_batches ADD CONSTRAINT care_import_batches_status_check
      CHECK (status IN ('staged', 'committed', 'rejected', 'duplicate'));
    ALTER TABLE public.care_import_batches DROP COLUMN IF EXISTS cancelled_by;
    ALTER TABLE public.care_import_batches DROP COLUMN IF EXISTS cancelled_at;
    ALTER TABLE public.care_import_batches DROP COLUMN IF EXISTS provenance_version;
    ALTER TABLE public.care_import_batches DROP COLUMN IF EXISTS commit_seq;
    ALTER TABLE public.care_import_batches DROP COLUMN IF EXISTS journal_rows;
    DROP SEQUENCE IF EXISTS public.care_import_commit_seq;
  END IF;
END $$;

-- ── 7. Marker ───────────────────────────────────────────────────────────────
DELETE FROM public.app_migrations WHERE version = '115';

-- ── 8. Hậu kiểm ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_md5 text;
  v_n   integer;
  v_p   text;
  v_exp jsonb := jsonb_build_object('SELECT', 13, 'INSERT', 13, 'UPDATE', 13, 'DELETE', 13, 'TRUNCATE', 9, 'TRIGGER', 13, 'REFERENCES', 13);
BEGIN
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__import_finalize_at(uuid,uuid,date)'::regprocedure;
  IF v_md5 <> '121e14feb18accd8ec95424df192d20b' THEN RAISE EXCEPTION 'rollback 115 hậu kiểm: finalize md5 %', v_md5; END IF;
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__close_period_at(date)'::regprocedure;
  IF v_md5 <> 'cd4fb7f945c0cfa4a7ba12e6696942a3' THEN RAISE EXCEPTION 'rollback 115 hậu kiểm: close md5 %', v_md5; END IF;
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = 'public.care__forbid_mutation()'::regprocedure;
  IF v_md5 <> 'ae77c258096e0c881e9895d275dc0df4' THEN RAISE EXCEPTION 'rollback 115 hậu kiểm: forbid md5 %', v_md5; END IF;
  FOR v_p IN SELECT jsonb_object_keys(v_exp) LOOP
    SELECT count(*) INTO v_n FROM pg_catalog.pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'care\_%' AND c.relkind = 'r' AND has_table_privilege('service_role', c.oid, v_p);
    IF v_n <> (v_exp ->> v_p)::int THEN RAISE EXCEPTION 'rollback 115 hậu kiểm: service_role % = % (kỳ vọng %)', v_p, v_n, v_exp ->> v_p; END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'care\_%' AND relkind = 'r';
  IF v_n <> 13 THEN RAISE EXCEPTION 'rollback 115 hậu kiểm: % bảng care_* (kỳ vọng 13)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid
  WHERE NOT g.tgisinternal AND c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'care\_%';
  IF v_n <> 4 THEN RAISE EXCEPTION 'rollback 115 hậu kiểm: % trigger care_* (kỳ vọng 4)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'care%';
  IF v_n <> 41 THEN RAISE EXCEPTION 'rollback 115 hậu kiểm: % hàm care%% (kỳ vọng 41)', v_n; END IF;
  -- db-reviewer D1 r1.1 P2-6: không còn batch chưa huỷ mang provenance (chạy được cả khi cột đã bị bỏ).
  SELECT count(*) INTO v_n FROM public.care_import_batches b WHERE b.status <> 'cancelled' AND (to_jsonb(b) ->> 'commit_seq') IS NOT NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'rollback 115 hậu kiểm: % batch chưa huỷ còn commit_seq', v_n; END IF;
  IF has_table_privilege('service_role', 'public.care_tasks', 'TRUNCATE') OR has_table_privilege('service_role', 'public.care_interactions', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.care_assignment_events', 'TRUNCATE') OR has_table_privilege('service_role', 'public.care_store_refusals', 'TRUNCATE') THEN
    RAISE EXCEPTION 'rollback 115 hậu kiểm: TRUNCATE bị mở lại trên bảng append-only';
  END IF;
END $$;

COMMIT;
