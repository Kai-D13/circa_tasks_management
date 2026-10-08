-- ============================================================================
-- 114_care_crm_foundation.sql — CRM-CSKH (Chăm sóc khách hàng) B1
-- Chạy SAU 113.
--
-- Contract: planning/SPEC.md §B1 (PM GO 07/10/2026) + §B3 r1.2 · CONTRACT v1.14+ ·
-- DECISIONS Q-03…Q-80 (Q-76/77: QLCH không tham gia CRM; Q-79: SM theo store snapshot) · data contract r3.2 · plan r1.3.1 §2/§4/§5.
-- Dựng nền dữ liệu CRM: 13 bảng `care_*`, RLS chỉ SELECT theo scope, mọi GHI
-- đi qua RPC SECURITY DEFINER (authenticated cho lượt chăm sóc/chuyển giao,
-- service_role cho import/đóng kỳ/stamp). KHÔNG có đồng bộ BigQuery (B5),
-- route/UI/cron (B2–B5). Cờ CARE_ENABLED vẫn OFF ⇒ app không gọi tới đây.
--
-- ── Đồ thị tham chiếu RLS (AGENTS.md §4.1 — không policy nào đọc thẳng bảng
--    RLS khác; mọi tra cứu qua helper SECURITY DEFINER STABLE) ─────────────────
--   care_tasks            → cột + care_assignee_uid(), care_can_view_all(), care_scope_store_ids()
--   care_task_products    → care_can_read_task(task_id)
--   Q-79 (08/10): SM đọc dữ liệu con theo STORE SNAPSHOT của từng dòng thuộc vùng
--   (không suy từ task/khách hiện tại); staff giữ quyền theo task được giao + lịch sử khách.
--   care_assignment_events→ cột from/to_store_id ∈ care_scope_store_ids() OR care_staff_reads_task(task_id)
--   care_order_attributions → cột store_id ∈ care_scope_store_ids() OR care_staff_reads_task(task_id)
--   care_interactions     → cột store_id ∈ care_scope_store_ids() OR care_staff_reads_task(task_id)
--                           OR care_staff_reads_customer(customer_id)
--   care_customers        → care_can_read_customer_history(id)
--   care_store_refusals   → cột store_id ∈ care_scope_store_ids() OR care_staff_reads_customer(customer_id)
--   care_import_batches   → care_can_import() OR care_can_view_all()
--   care_orders, care_sync_state → care_can_view_all()   (staff/SM: KHÔNG)
--   care_access           → is_super_admin() OR (admin AND department_id = get_user_department_id()); ghi: chỉ super
--   QLCH `store_manager` (tài khoản dùng chung) KHÔNG tham gia CRM GĐ1 (Q-76/77, 08/10):
--   scope rỗng + không bao giờ là "assignee" (care_assignee_uid() chỉ trả uid khi
--   role='staff') ⇒ 0 dòng ở mọi bảng, care_report/care_my_summary rỗng/0.
--   care_import_staging, care_reconcile_queue → KHÔNG policy (chỉ service_role)
--   Helper (SECDEF, chạy quyền owner ⇒ không kích hoạt RLS):
--     care_can_view_all/care_can_import → users, care_access, is_super_admin()
--     care_scope_store_ids              → users, stores, sm_store_assignments
--     care_assignee_uid                 → get_user_role() (users)
--     care_can_read_task                → care_tasks + care_assignee_uid + care_scope_store_ids
--     care_can_read_customer_history    → care_tasks + care_assignee_uid + care_scope_store_ids
--     care_staff_reads_task/customer    → care_tasks + care_assignee_uid (chỉ nhánh staff)
--   Policy theo dòng có dạng (select care_can_view_all()) OR helper(cột) ⇒ nhánh
--   admin/super tính một lần mỗi truy vấn (InitPlan).
--   ⇒ không có chu trình policy→policy (bài học 047→048/049).
--
-- ── Quy tắc thời gian ────────────────────────────────────────────────────────
-- Kỳ = tháng VN: care_vn_today() = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
-- không phụ thuộc timezone server. Mốc "từng trễ hẹn" dùng MỘT helper
-- care_overdue_stamp(next, due, today) cho cả 3 đường (ghi lượt, stamp hằng
-- ngày, đóng kỳ): chỉ ghi khi next < today VÀ next < due (ngày bắt đầu trễ còn
-- trong kỳ). Hẹn đúng ngày cuối tháng ⇒ không Quá hạn, chỉ Không hoàn thành.
-- TS mirror: webapp/lib/care/time.ts overdueStampDate (spec parity).
-- Các RPC public gọi bản nội bộ `care__*_at(p_today, …)`; bản nội bộ KHÔNG cấp
-- cho role nào (chỉ owner/QA PGlite gọi được để test biên ngày).
--
-- ── Outcome ─────────────────────────────────────────────────────────────────
-- 6 mã, terminal = NO_NEED/INTERESTED/ORDERED/REFUSED — PARITY với
-- webapp/lib/care/outcome.ts (spec ép). TODO(Q-02), TODO(Q-03): mặc định đề
-- xuất, chưa phải quyết định stakeholder. Đổi tập terminal phải đổi CẢ hai nơi;
-- cột generated care_interactions.is_terminal không tự tính lại dòng cũ.
--
-- ── Không thuộc 114 ─────────────────────────────────────────────────────────
-- care_upsert_orders / care_recompute_attribution / cursor N3 (B5). Bảng
-- care_orders đúng N3 r3.2: KHÔNG is_valid_order/is_deleted/order_status/
-- channel/store_code (Q-65…68).
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP POLICY/TRIGGER IF EXISTS + CREATE, seed ON CONFLICT DO NOTHING. Chạy lại
-- nguyên file không đổi dữ liệu. pg_safeupdate: mọi UPDATE/DELETE có WHERE.
--
-- ROLLBACK (chỉ khi CHƯA có dữ liệu vận hành — xoá toàn bộ CRM):
--   BEGIN;
--   DROP TABLE IF EXISTS public.care_order_attributions, public.care_orders,
--     public.care_sync_state, public.care_reconcile_queue, public.care_store_refusals,
--     public.care_assignment_events, public.care_interactions, public.care_task_products,
--     public.care_tasks, public.care_customers, public.care_import_staging,
--     public.care_import_batches, public.care_access CASCADE;
--   DROP FUNCTION IF EXISTS
--     public.care_record_interaction(uuid, text, text, date, jsonb),
--     public.care_transfer_tasks(uuid[], uuid, text),
--     public.care_import_finalize(uuid, uuid), public.care_close_period(), public.care_purge_stale_staging(interval),
--     public.care_stamp_overdue(), public.care_report(date, uuid[], boolean),
--     public.care_my_summary(), public.care_my_access(),
--     public.care__record_interaction_at(date, uuid, text, text, date, jsonb),
--     public.care__transfer_tasks_at(date, uuid[], uuid, text),
--     public.care__import_finalize_at(uuid, uuid, date),
--     public.care__close_period_at(date), public.care__stamp_overdue_at(date),
--     public.care__forbid_mutation(), public.care__uid_is_super(uuid),
--     public.care__uid_can(uuid, text), public.care_can_read_customer_history(uuid),
--     public.care_staff_reads_task(uuid), public.care_staff_reads_customer(uuid),
--     public.care_can_read_task(uuid), public.care_scope_store_ids(), public.care_assignee_uid(),
--     public.care_can_import(), public.care_can_view_all(),
--     public.care_normalize_vn_phone(text), public.care_overdue_stamp(date, date, date),
--     public.care_period_last_day(date), public.care_period_of(date), public.care_vn_today(), public.care_vn_date(timestamptz),
--     public.care_outcome_records_refusal(text), public.care_outcome_requires_date(text),
--     public.care_is_terminal_outcome(text), public.care_is_outcome(text);
--   DELETE FROM public.app_migrations WHERE version = '114';
--   COMMIT;
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '113') THEN
    RAISE EXCEPTION '114: thiếu migration nền 113 — chạy đúng thứ tự';
  END IF;
  -- Helper nền mà policy/RPC dựa vào phải có sẵn.
  IF to_regprocedure('public.is_super_admin()') IS NULL
     OR to_regprocedure('public.get_user_role()') IS NULL
     OR to_regprocedure('public.get_user_department_id()') IS NULL
     OR to_regprocedure('public.is_sm_for_store(uuid)') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION '114: thiếu helper nền (is_super_admin/get_user_role/get_user_department_id/is_sm_for_store/auth.uid)';
  END IF;
  -- Q-22: phòng Marketing là phòng được cấp quyền ban đầu — id do user cung cấp, phải tồn tại.
  IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = '80cb84b5-da69-46e3-b0e5-1de3d31b93c3') THEN
    RAISE EXCEPTION '114: không thấy phòng Marketing 80cb84b5-da69-46e3-b0e5-1de3d31b93c3 (Q-22)';
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Helper thuần (IMMUTABLE/STABLE, không đọc bảng) — dùng trong CHECK/cột sinh
-- ════════════════════════════════════════════════════════════════════════════

-- TODO(Q-02): sáu giá trị theo bảng mục 4 tài liệu gốc.
CREATE OR REPLACE FUNCTION public.care_is_outcome(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p IN ('UNREACHABLE', 'NO_NEED', 'INTERESTED', 'CALLBACK', 'ORDERED', 'REFUSED')
$$;

-- TODO(Q-03): NO_NEED/ORDERED kết thúc là mặc định đề xuất. Giá trị lạ/NULL ⇒ false.
CREATE OR REPLACE FUNCTION public.care_is_terminal_outcome(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p IN ('NO_NEED', 'INTERESTED', 'ORDERED', 'REFUSED'), false)
$$;

-- CALLBACK bắt buộc ngày hẹn (Q-48); UNREACHABLE: TODO(Q-03) mặc định.
CREATE OR REPLACE FUNCTION public.care_outcome_requires_date(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p IN ('UNREACHABLE', 'CALLBACK'), false)
$$;

-- Q-54: chỉ REFUSED ghi từ chối (khách, store của task).
CREATE OR REPLACE FUNCTION public.care_outcome_records_refusal(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p = 'REFUSED', false)
$$;

-- Ngày VN của một thời điểm (mirror TS vnDateISO) — tách riêng để test biên 23:59/00:00.
CREATE OR REPLACE FUNCTION public.care_vn_date(p_at timestamptz)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (p_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
$$;

CREATE OR REPLACE FUNCTION public.care_vn_today()
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT public.care_vn_date(now())
$$;

CREATE OR REPLACE FUNCTION public.care_period_of(d date)
RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT date_trunc('month', d)::date
$$;

CREATE OR REPLACE FUNCTION public.care_period_last_day(p date)
RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT (date_trunc('month', p) + interval '1 month' - interval '1 day')::date
$$;

-- Mốc "từng trễ hẹn trong kỳ" — NGUỒN DUY NHẤT phía SQL (mirror TS overdueStampDate).
CREATE OR REPLACE FUNCTION public.care_overdue_stamp(p_next date, p_due date, p_today date)
RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_next IS NOT NULL AND p_next < p_today AND p_next < p_due
              THEN p_next + 1 END
$$;

-- Mirror CHẶT của normalizeVnPhone (webapp/lib/affiliate/phone.ts): sai ⇒ NULL.
-- KHÔNG dùng normalize_phone() (059) — hàm đó lỏng (chỉ để match staff).
CREATE OR REPLACE FUNCTION public.care_normalize_vn_phone(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d text;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  d := regexp_replace(p, '[^0-9]', '', 'g');
  IF d = '' THEN RETURN NULL; END IF;
  IF length(d) = 13 AND left(d, 4) = '0084' THEN d := substr(d, 5);
  ELSIF length(d) = 12 AND left(d, 3) = '840' THEN d := substr(d, 4);
  ELSIF length(d) = 11 AND left(d, 2) = '84' THEN d := substr(d, 3);
  END IF;
  IF length(d) = 9 AND left(d, 1) <> '0' THEN d := '0' || d; END IF;
  RETURN CASE WHEN d ~ '^0[35789][0-9]{8}$' THEN d END;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Bảng
-- ════════════════════════════════════════════════════════════════════════════

-- Cổng quyền theo phòng (Q-22): cấu hình được, KHÔNG gắn cứng Marketing trong logic.
CREATE TABLE IF NOT EXISTS public.care_access (
  department_id uuid PRIMARY KEY REFERENCES public.departments(id) ON DELETE CASCADE,
  can_import    boolean NOT NULL DEFAULT false,
  can_view_all  boolean NOT NULL DEFAULT false,
  granted_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Metadata đợt import — KHÔNG PII (summary chỉ có số đếm + số dòng/mã lỗi).
CREATE TABLE IF NOT EXISTS public.care_import_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_month  date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  kind          text CHECK (kind IN ('initial', 'revision')),
  status        text NOT NULL DEFAULT 'staged'
                CHECK (status IN ('staged', 'committed', 'rejected', 'duplicate')),
  file_name     text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  file_sha256   text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  row_count     integer NOT NULL CHECK (row_count > 0),
  customer_count integer,
  store_count   integer,
  summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid NOT NULL REFERENCES public.users(id),
  is_test       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  CHECK ((status = 'staged') = (finished_at IS NULL)),
  CHECK (status <> 'committed' OR kind IS NOT NULL)
);
-- Nạp lại cùng file (hash) trong cùng kỳ ⇒ không tạo gì thêm.
-- Tách theo is_test cho khớp logic duplicate trong finalize (audit PM B1 P2).
CREATE UNIQUE INDEX IF NOT EXISTS care_import_batches_committed_hash_uq
  ON public.care_import_batches (period_month, file_sha256, is_test) WHERE status = 'committed';

-- Dòng Excel thô (PII) — CHỈ service_role; xoá sau finalize (thành công hoặc bị từ chối).
CREATE TABLE IF NOT EXISTS public.care_import_staging (
  batch_id uuid NOT NULL REFERENCES public.care_import_batches(id) ON DELETE CASCADE,
  row_no   integer NOT NULL CHECK (row_no >= 1),
  payload  jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (batch_id, row_no)
);

-- Định danh khách toàn chuỗi (BI). Tên/SĐT nằm ở snapshot task theo kỳ.
CREATE TABLE IF NOT EXISTS public.care_customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text NOT NULL UNIQUE CHECK (char_length(external_id) BETWEEN 1 AND 100 AND external_id = btrim(external_id)),
  is_test     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.care_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         uuid NOT NULL REFERENCES public.care_customers(id),
  period_month        date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  due_date            date NOT NULL,
  batch_id            uuid NOT NULL REFERENCES public.care_import_batches(id),
  store_id            uuid NOT NULL REFERENCES public.stores(id),
  assignee_id         uuid NOT NULL REFERENCES public.users(id),
  customer_name       text NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 200),
  phone_norm          text NOT NULL CHECK (phone_norm ~ '^0[35789][0-9]{8}$'),
  phone_raw           text NOT NULL CHECK (char_length(phone_raw) BETWEEN 1 AND 30),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'closed_unfinished')),
  last_outcome        text CHECK (public.care_is_outcome(last_outcome)),
  last_interaction_at timestamptz,
  next_action_date    date,
  first_overdue_on    date,
  completed_at        timestamptz,
  closed_at           timestamptz,
  is_test             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT care_tasks_customer_period_uq UNIQUE (customer_id, period_month),
  CHECK (due_date = public.care_period_last_day(period_month)),
  CHECK (next_action_date IS NULL OR next_action_date BETWEEN period_month AND due_date),
  CHECK (first_overdue_on IS NULL OR first_overdue_on BETWEEN period_month AND due_date),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((status = 'closed_unfinished') = (closed_at IS NOT NULL)),
  CHECK (status = 'open' OR next_action_date IS NULL)
);
-- Một khách chỉ một task đang mở.
CREATE UNIQUE INDEX IF NOT EXISTS care_tasks_one_open_per_customer
  ON public.care_tasks (customer_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS care_tasks_assignee_status_idx ON public.care_tasks (assignee_id, status);
CREATE INDEX IF NOT EXISTS care_tasks_store_period_idx ON public.care_tasks (store_id, period_month);
-- (customer_id, period_month) đã có từ UNIQUE — đọc ngược được cho "kỳ gần nhất".
CREATE INDEX IF NOT EXISTS care_tasks_open_period_idx ON public.care_tasks (period_month) WHERE status = 'open';

-- Snapshot sản phẩm/lý do từ Excel; revision giữ bản cũ is_current=false.
CREATE TABLE IF NOT EXISTS public.care_task_products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      uuid NOT NULL REFERENCES public.care_tasks(id),
  batch_id     uuid NOT NULL REFERENCES public.care_import_batches(id),
  product_id   text NOT NULL CHECK (char_length(product_id) BETWEEN 1 AND 100),
  product_name text NOT NULL CHECK (char_length(product_name) BETWEEN 1 AND 300),
  image_url    text CHECK (image_url IS NULL OR (char_length(image_url) <= 1000 AND image_url ~ '^https://cdn-gcs\.thuocsi\.vn/')),
  reason_type  text NOT NULL CHECK (char_length(reason_type) BETWEEN 1 AND 50),
  reason_text  text NOT NULL CHECK (char_length(reason_text) BETWEEN 1 AND 1000),
  is_current   boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS care_task_products_current_uq
  ON public.care_task_products (task_id, product_id) WHERE is_current;
-- Lịch sử revision (is_current = false) và policy theo task_id.
CREATE INDEX IF NOT EXISTS care_task_products_task_idx ON public.care_task_products (task_id);

-- Lượt chăm sóc — APPEND-ONLY (trigger). Chụp assignee/store tại lúc ghi (attribution B5).
CREATE TABLE IF NOT EXISTS public.care_interactions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id          uuid NOT NULL REFERENCES public.care_tasks(id),
  customer_id      uuid NOT NULL REFERENCES public.care_customers(id),
  actor_id         uuid NOT NULL REFERENCES public.users(id),
  assignee_id      uuid NOT NULL REFERENCES public.users(id),
  store_id         uuid NOT NULL REFERENCES public.stores(id),
  period_month     date NOT NULL,
  outcome          text NOT NULL CHECK (public.care_is_outcome(outcome)),
  -- Cột THƯỜNG do RPC ghi lúc tạo lượt (không phải cột sinh): tập terminal còn là
  -- TODO(Q-02/03); nếu đổi, lượt cũ giữ đúng ngữ nghĩa tại thời điểm ghi và
  -- dump/restore không tính lại (db-reviewer B1 P1).
  is_terminal      boolean NOT NULL,
  note             text NOT NULL CHECK (char_length(btrim(note)) BETWEEN 1 AND 500),
  next_action_date date,
  proof            jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(proof) = 'array'),
  is_test          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (next_action_date IS NULL OR NOT is_terminal)
);
-- Task Hoàn thành bất biến (Q-52) ⇒ tối đa MỘT lượt kết thúc / task.
CREATE UNIQUE INDEX IF NOT EXISTS care_interactions_one_terminal_per_task
  ON public.care_interactions (task_id) WHERE is_terminal;
CREATE INDEX IF NOT EXISTS care_interactions_customer_time_idx
  ON public.care_interactions (customer_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS care_interactions_task_time_idx
  ON public.care_interactions (task_id, created_at);

CREATE TABLE IF NOT EXISTS public.care_assignment_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id       uuid NOT NULL REFERENCES public.care_tasks(id),
  kind          text NOT NULL CHECK (kind IN ('assigned', 'transferred')),
  from_store_id uuid REFERENCES public.stores(id),
  from_user_id  uuid REFERENCES public.users(id),
  to_store_id   uuid NOT NULL REFERENCES public.stores(id),
  to_user_id    uuid NOT NULL REFERENCES public.users(id),
  note          text,
  actor_id      uuid NOT NULL REFERENCES public.users(id),
  batch_id      uuid REFERENCES public.care_import_batches(id),
  is_test       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'transferred' OR (char_length(btrim(note)) BETWEEN 1 AND 500 AND from_user_id IS NOT NULL)),
  CHECK (kind <> 'assigned' OR batch_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS care_assignment_events_task_idx ON public.care_assignment_events (task_id, created_at);

-- Từ chối liên hệ theo (khách, store) — chặn import/chuyển giao vào đúng store (Q-54).
CREATE TABLE IF NOT EXISTS public.care_store_refusals (
  customer_id    uuid NOT NULL REFERENCES public.care_customers(id),
  store_id       uuid NOT NULL REFERENCES public.stores(id),
  interaction_id bigint NOT NULL REFERENCES public.care_interactions(id),
  is_test        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, store_id)
);

-- Khách vừa có lượt Hoàn thành ⇒ B5 đối soát đơn từ from_ts (giữ MIN khi gộp).
CREATE TABLE IF NOT EXISTS public.care_reconcile_queue (
  customer_id uuid PRIMARY KEY REFERENCES public.care_customers(id),
  from_ts     timestamptz NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS care_reconcile_queue_from_idx ON public.care_reconcile_queue (from_ts);

-- N3 r3.2 — một dòng / đơn ĐÃ ĐẶT (kể cả huỷ/hoàn sau đó). Chỉ care admin/super đọc.
CREATE TABLE IF NOT EXISTS public.care_orders (
  order_key            text PRIMARY KEY CHECK (char_length(order_key) BETWEEN 1 AND 200),
  customer_external_id text NOT NULL CHECK (char_length(customer_external_id) BETWEEN 1 AND 100),
  ordered_at           timestamptz NOT NULL,
  source_updated_at    timestamptz NOT NULL,
  net_amount           numeric NOT NULL,
  pos_code             text,
  synced_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS care_orders_customer_time_idx ON public.care_orders (customer_external_id, ordered_at);
CREATE INDEX IF NOT EXISTS care_orders_cursor_idx ON public.care_orders (source_updated_at, order_key);

-- Attribution: snapshot chủ sở hữu tại lượt Hoàn thành; báo cáo CHỈ đọc bảng này.
CREATE TABLE IF NOT EXISTS public.care_order_attributions (
  order_key      text PRIMARY KEY REFERENCES public.care_orders(order_key) ON DELETE CASCADE,
  interaction_id bigint NOT NULL REFERENCES public.care_interactions(id),
  task_id        uuid NOT NULL REFERENCES public.care_tasks(id),
  customer_id    uuid NOT NULL REFERENCES public.care_customers(id),
  assignee_id    uuid NOT NULL REFERENCES public.users(id),
  store_id       uuid NOT NULL REFERENCES public.stores(id),
  period_month   date NOT NULL,
  net_amount     numeric NOT NULL,
  is_test        boolean NOT NULL DEFAULT false,
  computed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS care_attr_period_store_idx ON public.care_order_attributions (period_month, store_id);
CREATE INDEX IF NOT EXISTS care_attr_period_assignee_idx ON public.care_order_attributions (period_month, assignee_id);
CREATE INDEX IF NOT EXISTS care_attr_task_idx ON public.care_order_attributions (task_id);

CREATE TABLE IF NOT EXISTS public.care_sync_state (
  source              text PRIMARY KEY,
  cursor_ts           timestamptz,
  cursor_key          text,
  last_success_at     timestamptz,
  bi_complete_through timestamptz,
  last_error          text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Append-only: UPDATE luôn bị chặn; DELETE chỉ cho dòng is_test (dọn fixture QA).
CREATE OR REPLACE FUNCTION public.care__forbid_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.is_test THEN RETURN OLD; END IF;
  RAISE EXCEPTION '%: dữ liệu CRM chỉ thêm, không % (chỉ xoá được dòng is_test khi dọn QA)', TG_TABLE_NAME, TG_OP;
END $$;

DROP TRIGGER IF EXISTS care_interactions_append_only ON public.care_interactions;
CREATE TRIGGER care_interactions_append_only BEFORE UPDATE OR DELETE ON public.care_interactions
  FOR EACH ROW EXECUTE FUNCTION public.care__forbid_mutation();
DROP TRIGGER IF EXISTS care_assignment_events_append_only ON public.care_assignment_events;
CREATE TRIGGER care_assignment_events_append_only BEFORE UPDATE OR DELETE ON public.care_assignment_events
  FOR EACH ROW EXECUTE FUNCTION public.care__forbid_mutation();
DROP TRIGGER IF EXISTS care_store_refusals_append_only ON public.care_store_refusals;
CREATE TRIGGER care_store_refusals_append_only BEFORE UPDATE OR DELETE ON public.care_store_refusals
  FOR EACH ROW EXECUTE FUNCTION public.care__forbid_mutation();
-- Task: được UPDATE (trạng thái/snapshot qua RPC), không DELETE dòng thật.
DROP TRIGGER IF EXISTS care_tasks_no_delete ON public.care_tasks;
CREATE TRIGGER care_tasks_no_delete BEFORE DELETE ON public.care_tasks
  FOR EACH ROW EXECUTE FUNCTION public.care__forbid_mutation();

-- Seed Q-22: Marketing được import + xem toàn bộ CRM.
INSERT INTO public.care_access (department_id, can_import, can_view_all)
VALUES ('80cb84b5-da69-46e3-b0e5-1de3d31b93c3', true, true)
ON CONFLICT (department_id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Helper quyền (SECURITY DEFINER STABLE, search_path cố định)
-- ════════════════════════════════════════════════════════════════════════════

-- Nội bộ: quyền phòng của một uid bất kỳ (finalize kiểm actor do service_role truyền).
CREATE OR REPLACE FUNCTION public.care__uid_can(p_uid uuid, p_cap text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users u
    JOIN public.care_access a ON a.department_id = u.department_id
    WHERE u.id = p_uid AND u.role = 'admin'
      AND CASE p_cap WHEN 'import' THEN a.can_import WHEN 'view_all' THEN a.can_view_all ELSE false END
  )
$$;

-- Nội bộ: super admin của một uid bất kỳ. Allowlist CHỈ nằm trong is_super_admin()
-- (đồng bộ với authz.ts — bài học 066/100), nên KHÔNG chép lại email ở đây: tạm
-- đặt claim sub = p_uid TRONG transaction, gọi is_super_admin(), rồi trả lại giá trị cũ.
CREATE OR REPLACE FUNCTION public.care__uid_is_super(p_uid uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev text := current_setting('request.jwt.claim.sub', true);
  v      boolean;
BEGIN
  IF p_uid IS NULL THEN RETURN false; END IF;
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  v := public.is_super_admin();
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_prev, ''), true);
  RETURN COALESCE(v, false);
END $$;

CREATE OR REPLACE FUNCTION public.care_can_view_all()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_super_admin() OR public.care__uid_can(auth.uid(), 'view_all')
$$;

CREATE OR REPLACE FUNCTION public.care_can_import()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_super_admin() OR public.care__uid_can(auth.uid(), 'import')
$$;

-- Store OS trong phạm vi đọc: CHỈ SM = store được gán; mọi vai trò khác = rỗng.
-- QLCH `store_manager` KHÔNG có scope (Q-76/77: tài khoản dùng chung không tham gia
-- CRM GĐ1). Chỉ store_type='os' ⇒ tài khoản FS không bao giờ thấy CRM OS.
CREATE OR REPLACE FUNCTION public.care_scope_store_ids()
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((
    SELECT CASE u.role
      WHEN 'sm' THEN ARRAY(
        SELECT a.store_id FROM public.sm_store_assignments a
        JOIN public.stores s ON s.id = a.store_id
        WHERE a.sm_user_id = u.id AND s.store_type = 'os')
      ELSE '{}'::uuid[] END
    FROM public.users u WHERE u.id = auth.uid()
  ), '{}'::uuid[])
$$;

-- "Người được giao" của phiên: auth.uid() CHỈ khi app role = 'staff', ngược lại NULL
-- (so sánh với NULL không bao giờ đúng ⇒ fail-closed). Task chỉ giao cho staff
-- (finalize/transfer kiểm), nhưng nếu tài khoản đổi role (vd. staff → QLCH) thì
-- nhánh assignee cũng đóng — QLCH không đọc lại task cũ (Q-76/77).
CREATE OR REPLACE FUNCTION public.care_assignee_uid()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN public.get_user_role() = 'staff' THEN auth.uid() END
$$;

-- Hai helper theo DÒNG dưới đây chỉ xét assignee/scope store; nhánh care admin/
-- super nằm ở policy dạng `(select public.care_can_view_all()) OR …` để chỉ tính
-- MỘT lần mỗi truy vấn (db-reviewer B1 P2 hiệu năng).
-- Đọc một task: assignee hiện tại (gồm task kỳ cũ của chính mình) · scope store.
-- Sau chuyển giao A→B, task được chuyển có assignee = B ⇒ A mất quyền task đó.
CREATE OR REPLACE FUNCTION public.care_can_read_task(p_task_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.care_tasks t
    WHERE t.id = p_task_id
      AND (t.assignee_id = public.care_assignee_uid() OR t.store_id = ANY (public.care_scope_store_ids()))
  )
$$;

-- Lịch sử toàn chuỗi của khách: chỉ khi khách có task KỲ HIỆN TẠI trong scope
-- (không suy từ task lịch sử) — dược sĩ mới thấy lượt cũ sau chuyển giao/qua kỳ.
CREATE OR REPLACE FUNCTION public.care_can_read_customer_history(p_customer_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.care_tasks t
    WHERE t.customer_id = p_customer_id
      AND t.period_month = public.care_period_of(public.care_vn_today())
      AND (t.assignee_id = public.care_assignee_uid() OR t.store_id = ANY (public.care_scope_store_ids()))
  )
$$;

-- Q-79: hai helper CHỈ nhánh staff (người được giao) cho dữ liệu con có store snapshot
-- (lượt/ghi chú, event, DNC, attribution). Nhánh SM KHÔNG đi qua task/khách hiện tại mà xét
-- store của TỪNG dòng ở policy — task chuyển X→Y không mở lượt X cho SM vùng Y.
-- Staff: giữ đúng quyền đã chốt (assignee HIỆN TẠI của task — kể cả task kỳ cũ của mình chưa chuyển —
-- + lịch sử khách có task kỳ này giao cho mình). Ở policy, nhánh staff được chặn sớm bằng InitPlan
-- `(select care_assignee_uid()) IS NOT NULL` ⇒ SM/admin không phải gọi helper theo từng dòng.
CREATE OR REPLACE FUNCTION public.care_staff_reads_task(p_task_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.care_tasks t
    WHERE t.id = p_task_id AND t.assignee_id = public.care_assignee_uid()
  )
$$;

CREATE OR REPLACE FUNCTION public.care_staff_reads_customer(p_customer_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.care_tasks t
    WHERE t.customer_id = p_customer_id
      AND t.period_month = public.care_period_of(public.care_vn_today())
      AND t.assignee_id = public.care_assignee_uid()
  )
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. RLS + quyền bảng (Supabase cấp mặc định ALL cho anon/authenticated ⇒ thu hồi)
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.care_access             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_import_batches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_import_staging     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_customers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_tasks              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_task_products      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_interactions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_assignment_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_store_refusals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_reconcile_queue    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_orders             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_order_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_sync_state         ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.care_access, public.care_import_batches, public.care_import_staging,
  public.care_customers, public.care_tasks, public.care_task_products, public.care_interactions,
  public.care_assignment_events, public.care_store_refusals, public.care_reconcile_queue,
  public.care_orders, public.care_order_attributions, public.care_sync_state
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.care_access, public.care_import_batches, public.care_import_staging,
  public.care_customers, public.care_tasks, public.care_task_products, public.care_interactions,
  public.care_assignment_events, public.care_store_refusals, public.care_reconcile_queue,
  public.care_orders, public.care_order_attributions, public.care_sync_state
  TO service_role;
-- TRUNCATE bỏ qua trigger append-only theo dòng ⇒ thu hồi cả với service_role.
REVOKE TRUNCATE ON public.care_tasks, public.care_interactions, public.care_assignment_events,
  public.care_store_refusals FROM service_role;
GRANT SELECT ON public.care_access, public.care_import_batches, public.care_customers,
  public.care_tasks, public.care_task_products, public.care_interactions,
  public.care_assignment_events, public.care_store_refusals, public.care_orders,
  public.care_order_attributions, public.care_sync_state
  TO authenticated;
-- care_access: super sửa trực tiếp (policy bên dưới chặn mọi người khác).
GRANT INSERT, UPDATE, DELETE ON public.care_access TO authenticated;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT pg_get_serial_sequence('public.' || t, 'id') AS seq
           FROM unnest(ARRAY['care_interactions', 'care_assignment_events']) t LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated', r.seq);
  END LOOP;
END $$;

DROP POLICY IF EXISTS care_access_select ON public.care_access;
CREATE POLICY care_access_select ON public.care_access FOR SELECT TO authenticated
  -- Chỉ ADMIN cùng phòng đọc cấu hình phòng mình (QLCH/staff/SM cùng department_id không kế thừa — Q-76/77).
  USING ((select public.is_super_admin())
         OR ((select public.get_user_role()) = 'admin' AND department_id = (select public.get_user_department_id())));
DROP POLICY IF EXISTS care_access_insert ON public.care_access;
CREATE POLICY care_access_insert ON public.care_access FOR INSERT TO authenticated
  WITH CHECK ((select public.is_super_admin()));
DROP POLICY IF EXISTS care_access_update ON public.care_access;
CREATE POLICY care_access_update ON public.care_access FOR UPDATE TO authenticated
  USING ((select public.is_super_admin())) WITH CHECK ((select public.is_super_admin()));
DROP POLICY IF EXISTS care_access_delete ON public.care_access;
CREATE POLICY care_access_delete ON public.care_access FOR DELETE TO authenticated
  USING ((select public.is_super_admin()));

DROP POLICY IF EXISTS care_import_batches_select ON public.care_import_batches;
CREATE POLICY care_import_batches_select ON public.care_import_batches FOR SELECT TO authenticated
  USING ((select public.care_can_import()) OR (select public.care_can_view_all()));

DROP POLICY IF EXISTS care_tasks_select ON public.care_tasks;
CREATE POLICY care_tasks_select ON public.care_tasks FOR SELECT TO authenticated
  USING (assignee_id = (select public.care_assignee_uid())
         OR (select public.care_can_view_all())
         -- ::uuid[] bắt buộc: `= ANY ((select …))` bị hiểu là dạng subquery (uuid = uuid[]).
         OR store_id = ANY ((select public.care_scope_store_ids())::uuid[]));

DROP POLICY IF EXISTS care_task_products_select ON public.care_task_products;
CREATE POLICY care_task_products_select ON public.care_task_products FOR SELECT TO authenticated
  USING ((select public.care_can_view_all()) OR public.care_can_read_task(task_id));

DROP POLICY IF EXISTS care_assignment_events_select ON public.care_assignment_events;
CREATE POLICY care_assignment_events_select ON public.care_assignment_events FOR SELECT TO authenticated
  USING ((select public.care_can_view_all())
         OR ARRAY[from_store_id, to_store_id] && ((select public.care_scope_store_ids())::uuid[])
         OR ((select public.care_assignee_uid()) IS NOT NULL AND public.care_staff_reads_task(task_id)));

DROP POLICY IF EXISTS care_interactions_select ON public.care_interactions;
CREATE POLICY care_interactions_select ON public.care_interactions FOR SELECT TO authenticated
  USING ((select public.care_can_view_all())
         OR store_id = ANY ((select public.care_scope_store_ids())::uuid[])
         OR ((select public.care_assignee_uid()) IS NOT NULL AND public.care_staff_reads_task(task_id)) OR ((select public.care_assignee_uid()) IS NOT NULL AND public.care_staff_reads_customer(customer_id)));

DROP POLICY IF EXISTS care_customers_select ON public.care_customers;
CREATE POLICY care_customers_select ON public.care_customers FOR SELECT TO authenticated
  USING ((select public.care_can_view_all()) OR public.care_can_read_customer_history(id));

DROP POLICY IF EXISTS care_store_refusals_select ON public.care_store_refusals;
CREATE POLICY care_store_refusals_select ON public.care_store_refusals FOR SELECT TO authenticated
  USING ((select public.care_can_view_all())
         OR store_id = ANY ((select public.care_scope_store_ids())::uuid[])
         OR ((select public.care_assignee_uid()) IS NOT NULL AND public.care_staff_reads_customer(customer_id)));

DROP POLICY IF EXISTS care_order_attributions_select ON public.care_order_attributions;
CREATE POLICY care_order_attributions_select ON public.care_order_attributions FOR SELECT TO authenticated
  USING ((select public.care_can_view_all())
         OR store_id = ANY ((select public.care_scope_store_ids())::uuid[])
         OR ((select public.care_assignee_uid()) IS NOT NULL AND public.care_staff_reads_task(task_id)));

DROP POLICY IF EXISTS care_orders_select ON public.care_orders;
CREATE POLICY care_orders_select ON public.care_orders FOR SELECT TO authenticated
  USING ((select public.care_can_view_all()));

DROP POLICY IF EXISTS care_sync_state_select ON public.care_sync_state;
CREATE POLICY care_sync_state_select ON public.care_sync_state FOR SELECT TO authenticated
  USING ((select public.care_can_view_all()));
-- care_import_staging, care_reconcile_queue: KHÔNG policy ⇒ authenticated không thấy dòng nào.

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Đóng kỳ + stamp trễ hẹn (service_role; B5 gắn cron Coolify)
-- ════════════════════════════════════════════════════════════════════════════

-- Đóng mọi task còn mở của các kỳ TRƯỚC kỳ chứa p_today. Ghi mốc trễ (nếu có)
-- TRƯỚC khi đóng — cùng một câu UPDATE, biểu thức SET đọc giá trị cũ của dòng.
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

CREATE OR REPLACE FUNCTION public.care__stamp_overdue_at(p_today date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF p_today IS NULL THEN RAISE EXCEPTION 'care_stamp_overdue: thiếu ngày'; END IF;
  UPDATE public.care_tasks
  SET first_overdue_on = public.care_overdue_stamp(next_action_date, due_date, p_today), updated_at = now()
  WHERE status = 'open' AND first_overdue_on IS NULL
    AND public.care_overdue_stamp(next_action_date, due_date, p_today) IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.care_close_period()
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.care__close_period_at(public.care_vn_today())
$$;

CREATE OR REPLACE FUNCTION public.care_stamp_overdue()
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.care__stamp_overdue_at(public.care_vn_today())
$$;

-- Batch 'staged' bị kẹt (route B2 lỗi giữa chừng, hoặc finalize RAISE ⇒ rollback
-- nên không tự xoá staging) ⇒ không giữ PII vô hạn: đánh dấu rejected + xoá
-- staging. Cron B5 gọi định kỳ (service_role). Ngưỡng tối thiểu 1 giờ để không
-- cắt ngang một lần upload đang chạy.
CREATE OR REPLACE FUNCTION public.care_purge_stale_staging(p_older_than interval DEFAULT interval '24 hours')
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF p_older_than IS NULL OR p_older_than < interval '1 hour' THEN
    RAISE EXCEPTION 'care_purge_stale_staging: ngưỡng tối thiểu 1 giờ';
  END IF;
  WITH s AS (
    UPDATE public.care_import_batches
    SET status = 'rejected', finished_at = now(), summary = jsonb_build_object('reason', 'stale_staging')
    WHERE status = 'staged' AND created_at < now() - p_older_than
    RETURNING id
  ), d AS (
    DELETE FROM public.care_import_staging st USING s WHERE st.batch_id = s.id RETURNING 1
  )
  SELECT count(*) INTO n FROM s;
  RETURN n;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Import finalize (service_role) — validate TOÀN BỘ trước, rồi mới ghi
-- ════════════════════════════════════════════════════════════════════════════
-- B2 route: kiểm quyền app → tạo batch 'staged' + staging (khối 2.000 dòng) →
-- gọi care_import_finalize(batch, actor). Kết quả:
--   committed  — đã ghi; summary chỉ có số đếm.
--   rejected   — có lỗi dữ liệu ⇒ KHÔNG ghi nghiệp vụ nào; trả {row, code}.
--   duplicate  — cùng file (hash) đã commit trong kỳ ⇒ không tạo gì thêm.
-- Lỗi hệ thống/điều kiện gọi sai ⇒ RAISE (rollback cả transaction).
-- Revision (Q-50): thêm khách mới; sửa sản phẩm/lý do/tên/SĐT của task CHƯA có
-- lượt; task đã có lượt và khách vắng file giữ nguyên; KHÔNG đổi owner (ghi nhận
-- owner_ignored — dùng Chuyển giao). Kỳ cũ không bao giờ bị chạm.
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

CREATE OR REPLACE FUNCTION public.care_import_finalize(p_batch_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.care__import_finalize_at(p_batch_id, p_actor, public.care_vn_today())
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Ghi lượt chăm sóc (authenticated — dược sĩ được giao)
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.care__record_interaction_at(
  p_today date, p_task_id uuid, p_outcome text, p_note text, p_next_action_date date, p_proof jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid   uuid := auth.uid();
  t       public.care_tasks%ROWTYPE;
  v_note  text := btrim(COALESCE(p_note, ''));
  v_proof jsonb := COALESCE(p_proof, '[]'::jsonb);
  v_term  boolean;
  v_first date;
  v_id    bigint;
  v_at    timestamptz;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'care_record_interaction: chưa đăng nhập'; END IF;
  IF p_today IS NULL THEN RAISE EXCEPTION 'care_record_interaction: thiếu ngày'; END IF;
  SELECT * INTO t FROM public.care_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'care_record_interaction: không tìm thấy task'; END IF;
  -- Q-76/77: QLCH không tham gia CRM — chỉ dược sĩ (staff) đang được giao mới ghi lượt.
  IF t.assignee_id <> v_uid OR public.get_user_role() IS DISTINCT FROM 'staff' THEN
    RAISE EXCEPTION 'care_record_interaction: chỉ dược sĩ được giao task mới ghi nhận';
  END IF;
  IF t.status <> 'open' THEN
    RAISE EXCEPTION 'care_record_interaction: task đã kết thúc (%), không ghi thêm lượt', t.status;
  END IF;
  IF t.period_month <> public.care_period_of(p_today) THEN
    RAISE EXCEPTION 'care_record_interaction: task thuộc kỳ đã qua';
  END IF;
  IF NOT COALESCE(public.care_is_outcome(p_outcome), false) THEN
    RAISE EXCEPTION 'care_record_interaction: kết quả không hợp lệ';
  END IF;
  IF char_length(v_note) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'care_record_interaction: ghi chú bắt buộc, 1–500 ký tự';
  END IF;
  IF public.care_outcome_requires_date(p_outcome) THEN
    IF p_next_action_date IS NULL THEN
      RAISE EXCEPTION 'care_record_interaction: kết quả % bắt buộc ngày hẹn', p_outcome;
    END IF;
    IF p_next_action_date < p_today OR p_next_action_date > t.due_date THEN
      RAISE EXCEPTION 'care_record_interaction: ngày hẹn phải từ hôm nay tới hết tháng của task (%)', t.due_date;
    END IF;
  ELSIF p_next_action_date IS NOT NULL THEN
    RAISE EXCEPTION 'care_record_interaction: kết quả % không nhận ngày hẹn', p_outcome;
  END IF;
  -- Proof tùy chọn (Q-53), không quyết định trạng thái. Chỉ nhận {url} https, tối đa
  -- 5 ảnh, tổng ≤ 4KB (chặn javascript:/http:, object rác). TODO(B4): ép host/prefix
  -- GCS theo task khi có purpose upload care_proof.
  IF jsonb_typeof(v_proof) <> 'array' OR jsonb_array_length(v_proof) > 5
     OR pg_column_size(v_proof) > 4096 OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_proof) e
       WHERE jsonb_typeof(e) <> 'object'
          OR (SELECT array_agg(k) FROM jsonb_object_keys(e) k) IS DISTINCT FROM ARRAY['url']
          OR jsonb_typeof(e->'url') IS DISTINCT FROM 'string'
          OR char_length(e->>'url') > 1000 OR (e->>'url') !~ '^https://[^\s]+$') THEN
    RAISE EXCEPTION 'care_record_interaction: proof phải là mảng ≤5 phần tử {url: https://…}';
  END IF;

  v_term  := public.care_is_terminal_outcome(p_outcome);
  v_first := COALESCE(t.first_overdue_on, public.care_overdue_stamp(t.next_action_date, t.due_date, p_today));

  INSERT INTO public.care_interactions (task_id, customer_id, actor_id, assignee_id, store_id, period_month,
                                        outcome, is_terminal, note, next_action_date, proof, is_test)
  VALUES (t.id, t.customer_id, v_uid, t.assignee_id, t.store_id, t.period_month,
          p_outcome, v_term, v_note, CASE WHEN v_term THEN NULL ELSE p_next_action_date END, v_proof, t.is_test)
  RETURNING id, created_at INTO v_id, v_at;

  UPDATE public.care_tasks
  SET last_outcome = p_outcome, last_interaction_at = v_at, first_overdue_on = v_first,
      next_action_date = CASE WHEN v_term THEN NULL ELSE p_next_action_date END,
      status = CASE WHEN v_term THEN 'completed' ELSE 'open' END,
      completed_at = CASE WHEN v_term THEN v_at END,
      updated_at = now()
  WHERE id = t.id;

  IF v_term THEN
    INSERT INTO public.care_reconcile_queue (customer_id, from_ts) VALUES (t.customer_id, v_at)
    ON CONFLICT (customer_id) DO UPDATE
      SET from_ts = LEAST(public.care_reconcile_queue.from_ts, EXCLUDED.from_ts), enqueued_at = now();
    IF public.care_outcome_records_refusal(p_outcome) THEN
      INSERT INTO public.care_store_refusals (customer_id, store_id, interaction_id, is_test)
      VALUES (t.customer_id, t.store_id, v_id, t.is_test)
      ON CONFLICT (customer_id, store_id) DO NOTHING;
    END IF;
  END IF;

  RETURN jsonb_build_object('interaction_id', v_id, 'task_id', t.id,
                            'status', CASE WHEN v_term THEN 'completed' ELSE 'open' END);
END $$;

CREATE OR REPLACE FUNCTION public.care_record_interaction(
  p_task_id uuid, p_outcome text, p_note text, p_next_action_date date DEFAULT NULL, p_proof jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.care__record_interaction_at(public.care_vn_today(), p_task_id, p_outcome, p_note, p_next_action_date, p_proof)
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Chuyển giao (SM trong phạm vi cả nguồn lẫn đích, hoặc super)
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.care__transfer_tasks_at(p_today date, p_task_ids uuid[], p_to_user uuid, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_super    boolean;
  v_note     text := btrim(COALESCE(p_note, ''));
  v_ids      uuid[];
  v_to_store uuid;
  v_n        integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'care_transfer_tasks: chưa đăng nhập'; END IF;
  v_super := public.is_super_admin();
  IF NOT v_super AND public.get_user_role() IS DISTINCT FROM 'sm' THEN
    RAISE EXCEPTION 'care_transfer_tasks: chỉ SM hoặc super admin được chuyển giao';
  END IF;
  IF char_length(v_note) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'care_transfer_tasks: ghi chú chuyển giao bắt buộc, 1–500 ký tự';
  END IF;
  v_ids := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_task_ids, '{}'::uuid[])) x WHERE x IS NOT NULL ORDER BY 1);
  IF cardinality(v_ids) = 0 OR cardinality(v_ids) > 500 THEN
    RAISE EXCEPTION 'care_transfer_tasks: cần 1–500 task';
  END IF;

  SELECT u.store_id INTO v_to_store
  FROM public.users u JOIN public.stores s ON s.id = u.store_id
  WHERE u.id = p_to_user AND u.role = 'staff' AND s.store_type = 'os' AND s.is_active;
  IF v_to_store IS NULL THEN
    RAISE EXCEPTION 'care_transfer_tasks: dược sĩ đích phải là staff của cửa hàng OS đang hoạt động';
  END IF;
  IF NOT v_super AND NOT public.is_sm_for_store(v_to_store) THEN
    RAISE EXCEPTION 'care_transfer_tasks: SM không quản lý cửa hàng đích';
  END IF;

  -- Khoá theo thứ tự ổn định, rồi kiểm TOÀN BỘ trước khi ghi.
  PERFORM 1 FROM public.care_tasks WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE;
  SELECT count(*) INTO v_n FROM public.care_tasks WHERE id = ANY (v_ids);
  IF v_n <> cardinality(v_ids) THEN RAISE EXCEPTION 'care_transfer_tasks: có task không tồn tại'; END IF;
  -- Scope nguồn kiểm TRƯỚC trạng thái/kỳ: SM không dò được task ngoài vùng còn mở hay không (B3 r1.2).
  IF NOT v_super AND EXISTS (SELECT 1 FROM public.care_tasks WHERE id = ANY (v_ids)
                             AND NOT public.is_sm_for_store(store_id)) THEN
    RAISE EXCEPTION 'care_transfer_tasks: SM không quản lý cửa hàng nguồn';
  END IF;
  IF EXISTS (SELECT 1 FROM public.care_tasks WHERE id = ANY (v_ids)
             AND (status <> 'open' OR period_month <> public.care_period_of(p_today))) THEN
    RAISE EXCEPTION 'care_transfer_tasks: chỉ chuyển task đang mở của kỳ hiện tại';
  END IF;
  IF EXISTS (SELECT 1 FROM public.care_tasks WHERE id = ANY (v_ids) AND assignee_id = p_to_user) THEN
    RAISE EXCEPTION 'care_transfer_tasks: có task đã thuộc dược sĩ đích';
  END IF;
  SELECT count(*) INTO v_n FROM public.care_tasks t
  JOIN public.care_store_refusals f ON f.customer_id = t.customer_id AND f.store_id = v_to_store
  WHERE t.id = ANY (v_ids);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'care_transfer_tasks: % khách đã từ chối chăm sóc tại cửa hàng đích', v_n;
  END IF;

  INSERT INTO public.care_assignment_events (task_id, kind, from_store_id, from_user_id, to_store_id, to_user_id,
                                             note, actor_id, is_test)
  SELECT id, 'transferred', store_id, assignee_id, v_to_store, p_to_user, v_note, v_uid, is_test
  FROM public.care_tasks WHERE id = ANY (v_ids);
  UPDATE public.care_tasks SET store_id = v_to_store, assignee_id = p_to_user, updated_at = now()
  WHERE id = ANY (v_ids);

  RETURN jsonb_build_object('transferred', cardinality(v_ids), 'to_store_id', v_to_store, 'to_user_id', p_to_user);
END $$;

CREATE OR REPLACE FUNCTION public.care_transfer_tasks(p_task_ids uuid[], p_to_user uuid, p_note text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.care__transfer_tasks_at(public.care_vn_today(), p_task_ids, p_to_user, p_note)
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. Báo cáo / tóm tắt / quyền của tôi (DEFINER, scope tự lấy từ auth.uid())
-- ════════════════════════════════════════════════════════════════════════════
-- Task theo owner HIỆN TẠI; đơn/doanh thu theo snapshot attribution + tháng của
-- lượt Hoàn thành (Q-59). Hai aggregate riêng rồi FULL JOIN ⇒ không nhân đôi khi
-- khách nhiều sản phẩm/lượt. KHÔNG đọc care_orders. is_test loại trừ, trừ super
-- chủ động bật p_include_test (QA B6). p_store_ids chỉ THU HẸP scope, không nới.
-- p_month được chuẩn hoá về ngày 1 (truyền ngày giữa tháng không ra rỗng âm thầm).
CREATE OR REPLACE FUNCTION public.care_report(p_month date, p_store_ids uuid[] DEFAULT NULL, p_include_test boolean DEFAULT false)
RETURNS TABLE (
  store_id uuid, assignee_id uuid,
  tasks_total integer, completed integer, open_not_cared integer, open_in_progress integer,
  overdue_in_period integer, closed_unfinished integer,
  converted_tasks integer, orders integer, net_revenue numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (
    SELECT public.care_assignee_uid() AS uid, public.care_can_view_all() AS v_all, public.care_scope_store_ids() AS scope,
           (COALESCE(p_include_test, false) AND public.is_super_admin()) AS v_test
  ), tk AS (
    SELECT t.store_id, t.assignee_id,
           count(*)::int AS total,
           count(*) FILTER (WHERE t.status = 'completed')::int AS completed,
           count(*) FILTER (WHERE t.status = 'open' AND t.last_interaction_at IS NULL)::int AS not_cared,
           count(*) FILTER (WHERE t.status = 'open' AND t.last_interaction_at IS NOT NULL)::int AS in_progress,
           count(*) FILTER (WHERE t.first_overdue_on IS NOT NULL)::int AS overdue,
           count(*) FILTER (WHERE t.status = 'closed_unfinished')::int AS unfinished
    FROM public.care_tasks t, me
    WHERE t.period_month = public.care_period_of(p_month) AND (me.v_test OR NOT t.is_test)
      AND (me.v_all OR t.assignee_id = me.uid OR t.store_id = ANY (me.scope))
      AND (p_store_ids IS NULL OR t.store_id = ANY (p_store_ids))
    GROUP BY t.store_id, t.assignee_id
  ), at AS (
    SELECT a.store_id, a.assignee_id,
           count(DISTINCT a.task_id)::int AS conv_tasks, count(*)::int AS orders, sum(a.net_amount) AS rev
    FROM public.care_order_attributions a, me
    WHERE a.period_month = public.care_period_of(p_month) AND (me.v_test OR NOT a.is_test)
      AND (me.v_all OR a.assignee_id = me.uid OR a.store_id = ANY (me.scope))
      AND (p_store_ids IS NULL OR a.store_id = ANY (p_store_ids))
    GROUP BY a.store_id, a.assignee_id
  )
  SELECT COALESCE(tk.store_id, at.store_id), COALESCE(tk.assignee_id, at.assignee_id),
         COALESCE(tk.total, 0), COALESCE(tk.completed, 0), COALESCE(tk.not_cared, 0),
         COALESCE(tk.in_progress, 0), COALESCE(tk.overdue, 0), COALESCE(tk.unfinished, 0),
         COALESCE(at.conv_tasks, 0), COALESCE(at.orders, 0), COALESCE(at.rev, 0)
  FROM tk FULL OUTER JOIN at ON at.store_id = tk.store_id AND at.assignee_id = tk.assignee_id
  ORDER BY 1, 2
$$;

-- Thẻ "CSKH của tôi" (staff) — kỳ hiện tại, task đang giao cho chính mình.
CREATE OR REPLACE FUNCTION public.care_my_summary()
RETURNS TABLE (period_month date, assigned integer, not_cared integer, completed integer, overdue_live integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (SELECT public.care_assignee_uid() AS uid, public.care_vn_today() AS today)
  SELECT public.care_period_of(me.today),
         count(t.id)::int,
         count(t.id) FILTER (WHERE t.status = 'open' AND t.last_interaction_at IS NULL)::int,
         count(t.id) FILTER (WHERE t.status = 'completed')::int,
         count(t.id) FILTER (WHERE t.status = 'open' AND t.next_action_date < me.today)::int
  FROM me
  -- Loại fixture QA (is_test) như care_report (audit PM B1 P1).
  LEFT JOIN public.care_tasks t ON t.assignee_id = me.uid AND t.period_month = public.care_period_of(me.today)
                                AND NOT t.is_test
  GROUP BY me.today
$$;

CREATE OR REPLACE FUNCTION public.care_my_access()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'role', public.get_user_role(),
    'is_super', public.is_super_admin(),
    'can_import', public.care_can_import(),
    'can_view_all', public.care_can_view_all(),
    'scope_store_count', cardinality(public.care_scope_store_ids()))
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 10. Quyền function — REVOKE đích danh rồi GRANT đúng role (AGENTS.md §4.2)
-- ════════════════════════════════════════════════════════════════════════════
REVOKE ALL ON FUNCTION
  public.care_is_outcome(text), public.care_is_terminal_outcome(text),
  public.care_outcome_requires_date(text), public.care_outcome_records_refusal(text),
  public.care_vn_date(timestamptz), public.care_vn_today(), public.care_period_of(date), public.care_period_last_day(date),
  public.care_overdue_stamp(date, date, date), public.care_normalize_vn_phone(text),
  public.care__forbid_mutation(),
  public.care__uid_can(uuid, text), public.care__uid_is_super(uuid),
  public.care_can_view_all(), public.care_can_import(), public.care_scope_store_ids(), public.care_assignee_uid(),
  public.care_can_read_task(uuid), public.care_can_read_customer_history(uuid),
  public.care_staff_reads_task(uuid), public.care_staff_reads_customer(uuid),
  public.care__close_period_at(date), public.care__stamp_overdue_at(date),
  public.care_close_period(), public.care_stamp_overdue(), public.care_purge_stale_staging(interval),
  public.care__import_finalize_at(uuid, uuid, date), public.care_import_finalize(uuid, uuid),
  public.care__record_interaction_at(date, uuid, text, text, date, jsonb),
  public.care_record_interaction(uuid, text, text, date, jsonb),
  public.care__transfer_tasks_at(date, uuid[], uuid, text),
  public.care_transfer_tasks(uuid[], uuid, text),
  public.care_report(date, uuid[], boolean), public.care_my_summary(), public.care_my_access()
  FROM PUBLIC, anon, authenticated, service_role;

-- Thuần + helper policy: authenticated (policy chạy với quyền người gọi) + service_role.
GRANT EXECUTE ON FUNCTION
  public.care_is_outcome(text), public.care_is_terminal_outcome(text),
  public.care_outcome_requires_date(text), public.care_outcome_records_refusal(text),
  public.care_vn_date(timestamptz), public.care_vn_today(), public.care_period_of(date), public.care_period_last_day(date),
  public.care_overdue_stamp(date, date, date), public.care_normalize_vn_phone(text),
  public.care_can_view_all(), public.care_can_import(), public.care_scope_store_ids(), public.care_assignee_uid(),
  public.care_can_read_task(uuid), public.care_can_read_customer_history(uuid),
  public.care_staff_reads_task(uuid), public.care_staff_reads_customer(uuid)
  TO authenticated, service_role;
-- RPC người dùng.
GRANT EXECUTE ON FUNCTION
  public.care_record_interaction(uuid, text, text, date, jsonb),
  public.care_transfer_tasks(uuid[], uuid, text),
  public.care_report(date, uuid[], boolean), public.care_my_summary(), public.care_my_access()
  TO authenticated;
-- RPC hệ thống (route import B2, cron B5).
GRANT EXECUTE ON FUNCTION
  public.care_import_finalize(uuid, uuid), public.care_close_period(), public.care_stamp_overdue(),
  public.care_purge_stale_staging(interval)
  TO service_role;
-- care__* (bản nội bộ có p_today, kiểm uid bất kỳ, trigger): KHÔNG cấp cho role nào.

-- ── Hậu kiểm TRONG transaction: sai ⇒ RAISE ⇒ rollback toàn bộ ────────────────
DO $$
DECLARE
  v_tables text[] := ARRAY['care_access', 'care_import_batches', 'care_import_staging', 'care_customers',
    'care_tasks', 'care_task_products', 'care_interactions', 'care_assignment_events', 'care_store_refusals',
    'care_reconcile_queue', 'care_orders', 'care_order_attributions', 'care_sync_state'];
  v_t    text;
  v_priv text;
  r      record;
BEGIN
  FOREACH v_t IN ARRAY v_tables LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relname = v_t AND c.relrowsecurity) THEN
      RAISE EXCEPTION '114 hậu kiểm: % chưa bật RLS', v_t;
    END IF;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege('anon', 'public.' || v_t, v_priv) THEN
        RAISE EXCEPTION '114 hậu kiểm: anon có % trên %', v_priv, v_t;
      END IF;
      -- authenticated: chỉ SELECT (trừ staging/queue); ngoại lệ care_access có I/U/D (policy chỉ cho super).
      IF has_table_privilege('authenticated', 'public.' || v_t, v_priv)
         AND NOT (v_priv = 'SELECT' AND v_t NOT IN ('care_import_staging', 'care_reconcile_queue'))
         AND NOT (v_t = 'care_access' AND v_priv IN ('INSERT', 'UPDATE', 'DELETE')) THEN
        RAISE EXCEPTION '114 hậu kiểm: authenticated có % trên %', v_priv, v_t;
      END IF;
    END LOOP;
  END LOOP;
  IF has_table_privilege('service_role', 'public.care_interactions', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.care_tasks', 'TRUNCATE') THEN
    RAISE EXCEPTION '114 hậu kiểm: service_role còn TRUNCATE trên bảng append-only';
  END IF;
  IF has_sequence_privilege('anon', pg_get_serial_sequence('public.care_interactions', 'id'), 'USAGE')
     OR has_sequence_privilege('authenticated', pg_get_serial_sequence('public.care_interactions', 'id'), 'USAGE')
     OR has_sequence_privilege('authenticated', pg_get_serial_sequence('public.care_assignment_events', 'id'), 'USAGE') THEN
    RAISE EXCEPTION '114 hậu kiểm: sequence identity còn cấp cho anon/authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'care_orders'
             AND column_name IN ('is_valid_order', 'is_deleted', 'order_status', 'channel', 'store_code')) THEN
    RAISE EXCEPTION '114 hậu kiểm: care_orders có cột ngoài N3 r3.2';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'care\_%') <> 14 THEN
    RAISE EXCEPTION '114 hậu kiểm: số policy care_* phải là 14';
  END IF;
  -- Mọi function care*: anon không EXECUTE; SECURITY DEFINER phải cố định search_path; care__* không cấp ai.
  FOR r IN SELECT p.oid::regprocedure::text AS fn, p.prosecdef, p.proconfig, p.proname
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'care%' LOOP
    IF has_function_privilege('anon', r.fn, 'EXECUTE') THEN
      RAISE EXCEPTION '114 hậu kiểm: anon EXECUTE được %', r.fn;
    END IF;
    IF r.prosecdef AND NOT COALESCE(r.proconfig @> ARRAY['search_path=public'], false) THEN
      RAISE EXCEPTION '114 hậu kiểm: % SECURITY DEFINER thiếu SET search_path', r.fn;
    END IF;
    IF r.proname LIKE 'care\_\_%' AND (has_function_privilege('authenticated', r.fn, 'EXECUTE')
                                       OR has_function_privilege('service_role', r.fn, 'EXECUTE')) THEN
      RAISE EXCEPTION '114 hậu kiểm: hàm nội bộ % đang được cấp quyền', r.fn;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'care%') <> 35 THEN
    RAISE EXCEPTION '114 hậu kiểm: số function care* phải là 35';
  END IF;
  FOR r IN
    SELECT * FROM (VALUES
      ('public.care_record_interaction(uuid,text,text,date,jsonb)', true,  false),
      ('public.care_transfer_tasks(uuid[],uuid,text)',              true,  false),
      ('public.care_report(date,uuid[],boolean)',                   true,  false),
      ('public.care_my_summary()',                                  true,  false),
      ('public.care_my_access()',                                   true,  false),
      ('public.care_import_finalize(uuid,uuid)',                    false, true),
      ('public.care_close_period()',                                false, true),
      ('public.care_stamp_overdue()',                               false, true),
      ('public.care_purge_stale_staging(interval)',                 false, true),
      ('public.care_assignee_uid()',                                true,  true),
      ('public.care_can_read_task(uuid)',                           true,  true),
      ('public.care_can_read_customer_history(uuid)',               true,  true),
      ('public.care_staff_reads_task(uuid)',                        true,  true),
      ('public.care_staff_reads_customer(uuid)',                    true,  true)
    ) AS v(fn, want_auth, want_service)
  LOOP
    IF has_function_privilege('authenticated', r.fn, 'EXECUTE') <> r.want_auth
       OR has_function_privilege('service_role', r.fn, 'EXECUTE') <> r.want_service THEN
      RAISE EXCEPTION '114 hậu kiểm: quyền EXECUTE sai ở %', r.fn;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.care_access
                 WHERE department_id = '80cb84b5-da69-46e3-b0e5-1de3d31b93c3' AND can_import AND can_view_all) THEN
    RAISE EXCEPTION '114 hậu kiểm: thiếu seed care_access Marketing';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('114', 'care_crm_foundation',
        'CRM-CSKH B1: 13 bang care_* + RLS SELECT theo scope + RPC (finalize import,'
        || ' ghi luot, chuyen giao, dong ky, stamp tre hen, don staging ket, report).'
        || ' Seed care_access Marketing. Chua co dong bo BigQuery N3 (B5), chua cron/route/UI.'
        || ' B3 r1.1 (Q-76/77): QLCH store_manager khong tham gia CRM (care_assignee_uid, scope chi SM).'
        || ' B3 r1.2 (Q-79): SM doc luot/event/DNC/attribution theo store snapshot cua dong thuoc vung.'
        || ' Co CARE_ENABLED OFF.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ── VERIFY (chạy sau COMMIT, chỉ đọc — bọc BEGIN READ ONLY; … COMMIT;) ──────
-- 1) Marker: SELECT version, name FROM public.app_migrations WHERE version = '114';   -- 1 dòng
-- 2) RLS:    SELECT count(*) FILTER (WHERE relrowsecurity) rls, count(*) n FROM pg_class
--            WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'care\_%' AND relkind = 'r';  -- 13 / 13
-- 3) Function sai quyền (kỳ vọng 0 dòng):
--    SELECT p.oid::regprocedure FROM pg_proc p
--    WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'care%'
--      AND ( has_function_privilege('anon', p.oid, 'EXECUTE')
--         OR (p.proname LIKE 'care\_\_%' AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
--                                             OR has_function_privilege('service_role', p.oid, 'EXECUTE')))
--         OR (p.proname IN ('care_import_finalize', 'care_close_period', 'care_stamp_overdue', 'care_purge_stale_staging')
--             AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
--         OR (p.prosecdef AND NOT COALESCE(p.proconfig @> ARRAY['search_path=public'], false)) );
--    và: SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'care%';  -- 35
-- 4) Quyền bảng (kỳ vọng: authenticated SELECT trên 11 bảng + INSERT/UPDATE/DELETE trên care_access; anon 0 dòng):
--    SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--    FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND table_name LIKE 'care\_%' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
--    GROUP BY 1, 2 ORDER BY 1, 2;
-- 5) Sequence (kỳ vọng false hết):
--    SELECT s, has_sequence_privilege('anon', s, 'USAGE') a, has_sequence_privilege('authenticated', s, 'USAGE') u
--    FROM unnest(ARRAY[pg_get_serial_sequence('public.care_interactions', 'id'),
--                      pg_get_serial_sequence('public.care_assignment_events', 'id')]) s;
-- 6) Policy (kỳ vọng 14 và 0 policy có FROM):
--    SELECT count(*), count(*) FILTER (WHERE qual ~* '\mfrom\M' OR with_check ~* '\mfrom\M')
--    FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'care\_%';
-- 7) Trigger append-only (kỳ vọng 4):
--    SELECT tgrelid::regclass, tgname FROM pg_trigger WHERE tgname LIKE 'care\_%' AND NOT tgisinternal;
-- 8) Seed: SELECT department_id, can_import, can_view_all FROM public.care_access;   -- 1 dòng Marketing true/true
-- 9) Rỗng: SELECT (SELECT count(*) FROM public.care_tasks) t, (SELECT count(*) FROM public.care_import_batches) b;  -- 0 / 0
-- 10) auth.uid() vẫn đọc request.jwt.claim.sub (care__uid_is_super dựa vào):
--    SELECT pg_get_functiondef('auth.uid()'::regprocedure);
-- 11) Q-76/77 — QLCH không tham gia CRM (kỳ vọng: care_tasks_select chứa care_assignee_uid();
--     care_access_select chứa get_user_role() = 'admin'; care_scope_store_ids không nhắc store_manager):
--    SELECT policyname, qual FROM pg_policies
--    WHERE schemaname = 'public' AND policyname IN ('care_tasks_select', 'care_access_select');
--    SELECT proname, pg_get_functiondef(oid) ~ 'store_manager' AS mentions_qlch
--    FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('care_scope_store_ids', 'care_assignee_uid');
--    Giả lập một QLCH (thay <QLCH_UID>; lặp lại với QLCH có department_id Marketing nếu có):
--    BEGIN READ ONLY; SET LOCAL ROLE authenticated;
--    SELECT set_config('request.jwt.claim.sub', '<QLCH_UID>', true);
--    SELECT public.care_assignee_uid() IS NULL, cardinality(public.care_scope_store_ids()),
--           (SELECT count(*) FROM public.care_tasks), (SELECT count(*) FROM public.care_access),
--           (SELECT count(*) FROM public.care_report(public.care_period_of(public.care_vn_today()))),
--           public.care_my_access();      -- true, 0, 0, 0, 0, can_import/can_view_all=false
--    COMMIT;
-- 12) Helper nền: SELECT prosecdef FROM pg_proc WHERE oid = 'public.get_user_role()'::regprocedure;  -- true
-- 13) Task mồ côi (assignee không còn là staff — sau khi có dữ liệu, kỳ vọng 0 dòng; xử lý bằng chuyển giao):
--    SELECT t.assignee_id, u.role, count(*) FROM public.care_tasks t JOIN public.users u ON u.id = t.assignee_id
--    WHERE t.status = 'open' AND u.role IS DISTINCT FROM 'staff' GROUP BY 1, 2;
-- 14) Q-79 — cấu trúc policy (có nghĩa cả khi DB còn rỗng). Kỳ vọng: 4 policy Q-79 → t, t, f, f;
--     care_task_products_select / care_customers_select → f, f, t, f:
--    SELECT policyname, qual ~ 'care_scope_store_ids' AS scope_snapshot, qual ~ 'care_staff_reads_(task|customer)' AS staff_helper,
--           qual ~ 'care_can_read_(task|customer_history)' AS old_helper, qual ~* '\mfrom\M' AS has_from
--    FROM pg_policies WHERE schemaname = 'public' AND policyname IN ('care_interactions_select', 'care_assignment_events_select',
--      'care_store_refusals_select', 'care_order_attributions_select', 'care_task_products_select', 'care_customers_select')
--    ORDER BY 1;
--    Helper mới: SELECT p.oid::regprocedure, p.prosecdef, p.provolatile, p.proconfig,
--      has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth
--    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('care_staff_reads_task', 'care_staff_reads_customer', 'care_assignee_uid');
--    -- prosecdef=t, provolatile='s', proconfig={search_path=public}, anon=f, auth=t
-- 15) Sau khi có dữ liệu — giả lập SM (thay <SM_UID>), kỳ vọng 0/0/0/0:
--    BEGIN READ ONLY; SET LOCAL ROLE authenticated;
--    SELECT set_config('request.jwt.claim.sub', '<SM_UID>', true);
--    SELECT (SELECT count(*) FROM public.care_interactions WHERE NOT (store_id = ANY (public.care_scope_store_ids()))) i_out,
--           (SELECT count(*) FROM public.care_store_refusals WHERE NOT (store_id = ANY (public.care_scope_store_ids()))) r_out,
--           (SELECT count(*) FROM public.care_order_attributions WHERE NOT (store_id = ANY (public.care_scope_store_ids()))) a_out,
--           (SELECT count(*) FROM public.care_assignment_events
--             WHERE NOT (ARRAY[from_store_id, to_store_id] && public.care_scope_store_ids())) e_out;
--    COMMIT;
