-- ============================================================================
-- 114_care_crm_foundation.sql — CRM-CSKH (Chăm sóc khách hàng) B1
-- Chạy SAU 113.
--
-- Contract: planning/SPEC.md §B1 (PM GO 07/10/2026) + §B3 r1.2 + §B4 (proof/ghi lượt) + §B5a r1.2 · CONTRACT v1.14+ ·
-- DECISIONS Q-03…Q-105 (Q-76/77: QLCH không tham gia CRM; Q-79: SM theo store snapshot;
-- Q-82: dược sĩ chỉ đọc/ghi task khi còn thuộc ĐÚNG store của task; Q-91/Q-93: N3 ba cột, chỉ Có đơn;
-- Q-95/Q-101: authenticated không SELECT thẳng care_order_attributions / care_orders; Q-104: product_id ≠ 0;
-- Q-105: authenticated chỉ SELECT care_customers(id, is_test, created_at) — external_id chỉ service_role)
-- · N3 r3.4 · plan r1.3.1 §2/§4/§5.
-- Dựng nền dữ liệu CRM: 13 bảng `care_*`, RLS chỉ SELECT theo scope, mọi GHI
-- đi qua RPC SECURITY DEFINER (authenticated cho lượt chăm sóc/chuyển giao,
-- service_role cho import/đóng kỳ/stamp/đồng bộ đơn). B5b.2: 3 RPC đồng bộ đơn N3 (9c) chỉ service_role cho
-- cron care-orders-sync; migration KHÔNG tự đọc BigQuery. Cờ CARE_ENABLED/CARE_SYNC_ENABLED vẫn OFF.
--
-- ── Đồ thị tham chiếu RLS (AGENTS.md §4.1 — không policy nào đọc thẳng bảng
--    RLS khác; mọi tra cứu qua helper SECURITY DEFINER STABLE) ─────────────────
--   care_tasks            → cột + care_assignee_uid(), care_staff_store_id(), care_can_view_all(), care_scope_store_ids()
--   Q-82 (B4 r1.1): MỌI nhánh assignee của staff (policy, helper đọc, RPC ghi lượt, summary/report)
--   so thêm store task = care_staff_store_id() ⇒ staff chuyển A→B mất quyền đọc/ghi task còn ở A.
--   care_task_products    → care_can_read_task(task_id)
--   Q-79 (08/10): SM đọc dữ liệu con theo STORE SNAPSHOT của từng dòng thuộc vùng
--   (không suy từ task/khách hiện tại); staff giữ quyền theo task được giao + lịch sử khách.
--   care_assignment_events→ cột from/to_store_id ∈ care_scope_store_ids() OR care_staff_reads_task(task_id)
--   care_order_attributions → Q-95 (B5a r1.2): KHÔNG GRANT SELECT cho authenticated, KHÔNG policy —
--                           chỉ đọc qua care_report (DEFINER, scope theo store snapshot Q-79)
--   care_interactions     → cột store_id ∈ care_scope_store_ids() OR care_staff_reads_task(task_id)
--                           OR care_staff_reads_customer(customer_id)
--   care_customers        → care_can_read_customer_history(id); Q-105: GRANT cột (id, is_test, created_at),
--                           KHÔNG external_id
--   care_store_refusals   → cột store_id ∈ care_scope_store_ids() OR care_staff_reads_customer(customer_id)
--   care_import_batches   → care_can_import() OR care_can_view_all()
--   care_sync_state       → care_can_view_all()   (staff/SM: KHÔNG; UI đọc qua care_order_sync_status DEFINER)
--   care_orders           → Q-101: KHÔNG GRANT SELECT cho authenticated, KHÔNG policy (kể cả care admin/super) —
--                           chỉ service_role (đồng bộ) + RPC DEFINER đọc
--   care_access           → is_super_admin() OR (admin AND department_id = get_user_department_id()); ghi: chỉ super
--   QLCH `store_manager` (tài khoản dùng chung) KHÔNG tham gia CRM GĐ1 (Q-76/77, 08/10):
--   scope rỗng + không bao giờ là "assignee" (care_assignee_uid() chỉ trả uid khi
--   role='staff') ⇒ 0 dòng ở mọi bảng, care_report/care_my_summary rỗng/0.
--   care_import_staging, care_reconcile_queue → KHÔNG policy (chỉ service_role)
--   Helper (SECDEF, chạy quyền owner ⇒ không kích hoạt RLS):
--     care_can_view_all/care_can_import → users, care_access, is_super_admin()
--     care_scope_store_ids              → users, stores, sm_store_assignments
--     care_assignee_uid                 → get_user_role() (users)
--     care_staff_store_id               → users, stores
--     care_can_read_task                → care_tasks + care_assignee_uid + care_staff_store_id + care_scope_store_ids
--     care_can_read_customer_history    → care_tasks + care_assignee_uid + care_staff_store_id + care_scope_store_ids
--     care_staff_reads_task/customer    → care_tasks + care_assignee_uid + care_staff_store_id (chỉ nhánh staff)
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
-- ── B5a r1.1 (09/10, SPEC §B5a r1.1 — Q-91/Q-93) ────────────────────────────────
-- GĐ1 chỉ đo "sau lượt Hoàn thành có đơn COMPLETED hay không" (task Có đơn, boolean). N3 r3.4 ĐÚNG
-- ba cột: customer_external_id, order_key, ordered_at (= completed_at UTC; BI chỉ xuất COMPLETED).
-- KHÔNG tiền / số đơn / source_updated_at / pos_code / cursor. care_recompute_attribution
-- (service_role) + care_order_sync_status (người xem báo cáo).
-- ── B5b.2 (09/10, SPEC §B5b) ─────────────────────────────────────────────────
-- care_order_sync_candidates / care_order_sync_apply / care_order_sync_fail (service_role) cho cron
-- care-orders-sync (app đọc VIEW N3 Q-96 theo khoảng). Đồng bộ ghi công THẬT còn NO-GO tới khi BI sửa
-- múi giờ VIEW (Q-100) — apply tự chặn đơn có mốc ở tương lai.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP POLICY/TRIGGER IF EXISTS + CREATE, seed ON CONFLICT DO NOTHING. Chạy lại
-- nguyên file không đổi dữ liệu. pg_safeupdate: mọi UPDATE/DELETE có WHERE.
-- Môi trường nháp/QA đã chạy một bản 114 TRƯỚC r1.1 (sáu cột/tiền): chạy khối ROLLBACK dưới đây trước —
-- bản này fail-closed (đổi RETURNS care_report báo lỗi, hậu kiểm tập cột RAISE), không tự nâng cấp.
-- Từ r1.1 lên r1.2 (Q-95) chạy lại tại chỗ sạch (thu hồi GRANT + DROP policy); riêng `notes` của dòng
-- app_migrations đã có không cập nhật (ON CONFLICT DO NOTHING) — chỉ ảnh hưởng DB nháp, prod chưa có 114.
-- DB nháp đã chạy bản TRƯỚC Q-104: CREATE TABLE IF NOT EXISTS không thêm CHECK product_id mới ⇒ hậu kiểm
-- RAISE (fail-closed) ⇒ chạy khối ROLLBACK rồi chạy lại.
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
--     public.care_recompute_attribution(text[], text[]), public.care_order_sync_status(),
--     public.care_order_sync_candidates(integer), public.care_order_sync_apply(jsonb, timestamptz),
--     public.care_order_sync_fail(text, timestamptz),
--     public.care__record_interaction_at(date, uuid, text, text, date, jsonb),
--     public.care__transfer_tasks_at(date, uuid[], uuid, text),
--     public.care__import_finalize_at(uuid, uuid, date),
--     public.care__close_period_at(date), public.care__stamp_overdue_at(date),
--     public.care__forbid_mutation(), public.care__uid_is_super(uuid),
--     public.care__uid_can(uuid, text), public.care_can_read_customer_history(uuid),
--     public.care_staff_reads_task(uuid), public.care_staff_reads_customer(uuid),
--     public.care_can_read_task(uuid), public.care_scope_store_ids(), public.care_assignee_uid(),
--     public.care_staff_store_id(), public.care_can_import(), public.care_can_view_all(),
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
  -- Q-104: product_id không bao giờ toàn số 0 ("0", "00"…) — chặn cả đường ghi khác ngoài finalize.
  product_id   text NOT NULL CHECK (char_length(product_id) BETWEEN 1 AND 100 AND btrim(product_id) !~ '^0+$'),
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

-- N3 r3.4 (Q-91/Q-93) — một dòng / đơn COMPLETED (BI lọc status; CANCELED/khác không vào).
-- ordered_at = order_order.completed_at UTC (Q-93: COMPLETED không đổi về CANCELED). Q-101: KHÔNG ai thuộc
-- authenticated (kể cả care admin/super) SELECT thẳng — chỉ service_role ghi/đọc; người dùng xem qua care_report.
-- synced_at: metadata nội bộ (lần ghi gần nhất — chẩn đoán đồng bộ), không thuộc interface N3.
CREATE TABLE IF NOT EXISTS public.care_orders (
  -- Khoá/ID khớp CHÍNH XÁC (không khoảng trắng đầu/cuối — như care_customers.external_id; parser B5a cũng chặn).
  order_key            text PRIMARY KEY CHECK (char_length(order_key) BETWEEN 1 AND 200 AND order_key = btrim(order_key)),
  customer_external_id text NOT NULL CHECK (char_length(customer_external_id) BETWEEN 1 AND 100
                                            AND customer_external_id = btrim(customer_external_id)),
  ordered_at           timestamptz NOT NULL,
  synced_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS care_orders_customer_time_idx ON public.care_orders (customer_external_id, ordered_at);

-- Attribution: snapshot chủ sở hữu tại lượt Hoàn thành; báo cáo CHỈ đọc bảng này.
CREATE TABLE IF NOT EXISTS public.care_order_attributions (
  order_key      text PRIMARY KEY REFERENCES public.care_orders(order_key) ON DELETE CASCADE,
  interaction_id bigint NOT NULL REFERENCES public.care_interactions(id),
  task_id        uuid NOT NULL REFERENCES public.care_tasks(id),
  customer_id    uuid NOT NULL REFERENCES public.care_customers(id),
  assignee_id    uuid NOT NULL REFERENCES public.users(id),
  store_id       uuid NOT NULL REFERENCES public.stores(id),
  period_month   date NOT NULL,
  is_test        boolean NOT NULL DEFAULT false,
  computed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS care_attr_period_store_idx ON public.care_order_attributions (period_month, store_id);
CREATE INDEX IF NOT EXISTS care_attr_period_assignee_idx ON public.care_order_attributions (period_month, assignee_id);
CREATE INDEX IF NOT EXISTS care_attr_task_idx ON public.care_order_attributions (task_id);
-- B5a: care_recompute_attribution tìm attribution đang gán cho khách (đơn đổi khách ⇒ tính lại phía cũ).
CREATE INDEX IF NOT EXISTS care_attr_customer_idx ON public.care_order_attributions (customer_id);

-- Trạng thái đồng bộ (B5a r1.1: không cursor/watermark). last_error = MÃ lỗi (vd. BQ_TIMEOUT) — CHECK chỉ
-- nhận dạng mã ⇒ không thể ghi message BigQuery thô/PII (care admin SELECT được bảng; security-reviewer P1).
-- B5b.2: updated_at = snapshot_at của KẾT QUẢ mới nhất đã ghi (care_order_sync_apply/_fail) — mốc so sánh
-- để lượt chạy chồng/đến muộn không đè kết quả lượt mới hơn.
CREATE TABLE IF NOT EXISTS public.care_sync_state (
  source              text PRIMARY KEY,
  last_success_at     timestamptz,
  last_error          text CHECK (last_error ~ '^[A-Z][A-Z0-9_]{0,63}$'),
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

-- Q-82 (B4 r1.1): store của dược sĩ phiên hiện tại — users.store_id CHỈ khi role 'staff' VÀ
-- store là OS đang hoạt động; ngược lại NULL (so sánh với NULL không bao giờ đúng ⇒
-- fail-closed). Nhánh assignee của staff luôn đi kèm `t.store_id = care_staff_store_id()`:
-- staff bị tháo store / chuyển sang store khác (kể cả OS khác) / store ngừng hoạt động mà task
-- vẫn ở store cũ ⇒ mất quyền ĐỌC lẫn GHI task đó; SM/super chuyển giao thủ công (Q-80). Task
-- hợp lệ luôn khớp store: finalize chỉ gán staff CÙNG store của dòng, transfer đặt store task =
-- store của dược sĩ đích.
CREATE OR REPLACE FUNCTION public.care_staff_store_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.store_id FROM public.users u JOIN public.stores s ON s.id = u.store_id
  WHERE u.id = auth.uid() AND u.role = 'staff' AND s.store_type = 'os' AND s.is_active
$$;

-- Hai helper theo DÒNG dưới đây chỉ xét assignee/scope store; nhánh care admin/
-- super nằm ở policy dạng `(select public.care_can_view_all()) OR …` để chỉ tính
-- MỘT lần mỗi truy vấn (db-reviewer B1 P2 hiệu năng).
-- Đọc một task: assignee hiện tại ở ĐÚNG store task (gồm task kỳ cũ của chính mình) · scope store.
-- Sau chuyển giao A→B, task được chuyển có assignee = B ⇒ A mất quyền task đó.
CREATE OR REPLACE FUNCTION public.care_can_read_task(p_task_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.care_tasks t
    WHERE t.id = p_task_id
      AND ((t.assignee_id = public.care_assignee_uid() AND t.store_id = public.care_staff_store_id())
           OR t.store_id = ANY (public.care_scope_store_ids()))
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
      AND ((t.assignee_id = public.care_assignee_uid() AND t.store_id = public.care_staff_store_id())
           OR t.store_id = ANY (public.care_scope_store_ids()))
  )
$$;

-- Q-79: hai helper CHỈ nhánh staff (người được giao) cho dữ liệu con có store snapshot
-- (lượt/ghi chú, event, DNC; attribution không còn policy — Q-95). Nhánh SM KHÔNG đi qua task/khách hiện tại mà xét
-- store của TỪNG dòng ở policy — task chuyển X→Y không mở lượt X cho SM vùng Y.
-- Staff: giữ đúng quyền đã chốt (assignee HIỆN TẠI của task — kể cả task kỳ cũ của mình chưa chuyển —
-- + lịch sử khách có task kỳ này giao cho mình), và (Q-82) task phải ở ĐÚNG store hiện tại của staff.
-- Ở policy, nhánh staff được chặn sớm bằng InitPlan `(select care_assignee_uid()) IS NOT NULL` ⇒
-- SM/admin không phải gọi helper theo từng dòng.
CREATE OR REPLACE FUNCTION public.care_staff_reads_task(p_task_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.care_tasks t
    WHERE t.id = p_task_id AND t.assignee_id = public.care_assignee_uid()
      AND t.store_id = public.care_staff_store_id()
  )
$$;

CREATE OR REPLACE FUNCTION public.care_staff_reads_customer(p_customer_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.care_tasks t
    WHERE t.customer_id = p_customer_id
      AND t.period_month = public.care_period_of(public.care_vn_today())
      AND t.assignee_id = public.care_assignee_uid()
      AND t.store_id = public.care_staff_store_id()
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
-- Q-95 (B5a r1.2) + Q-101: care_order_attributions và care_orders KHÔNG có trong danh sách — authenticated
-- (kể cả super/care admin) không SELECT thẳng (không lộ DHC/ID khách/số đơn qua PostgREST); aggregate qua
-- care_report, trạng thái qua care_order_sync_status. care_sync_state GIỮ (Q-101 không mở rộng sang bảng này).
-- Q-105: care_customers KHÔNG có trong danh sách quyền TOÀN BẢNG — quyền bảng cộng dồn với quyền cột (REVOKE
-- một cột khi còn GRANT bảng không ẩn được cột) ⇒ chỉ cấp 3 cột; external_id (ID khách thô của nguồn) chỉ
-- service_role và hàm SECURITY DEFINER nội bộ (import/đồng bộ N3) dùng.
GRANT SELECT ON public.care_access, public.care_import_batches,
  public.care_tasks, public.care_task_products, public.care_interactions,
  public.care_assignment_events, public.care_store_refusals,
  public.care_sync_state
  TO authenticated;
-- REVOKE ALL mức bảng ở trên đã gỡ cả quyền cột cũ; ghi rõ cho DB nháp từng thử grant cột external_id.
REVOKE SELECT (external_id) ON public.care_customers FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, is_test, created_at) ON public.care_customers TO authenticated;
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
  -- Q-82: staff chỉ thấy task giao mình Ở ĐÚNG store hiện tại (cả hai vế là InitPlan).
  USING ((assignee_id = (select public.care_assignee_uid()) AND store_id = (select public.care_staff_store_id()))
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

-- Q-95 (B5a r1.2): bỏ policy SELECT attribution (bảng vẫn bật RLS, không policy ⇒ chặn mọi role không
-- phải owner/service_role). DROP để chạy lại trên DB nháp từng có bản trước r1.2 cũng sạch.
DROP POLICY IF EXISTS care_order_attributions_select ON public.care_order_attributions;

-- Q-101: bỏ policy SELECT đơn thô (RLS vẫn bật, không policy, không GRANT) — DROP để DB nháp sạch.
DROP POLICY IF EXISTS care_orders_select ON public.care_orders;

DROP POLICY IF EXISTS care_sync_state_select ON public.care_sync_state;
CREATE POLICY care_sync_state_select ON public.care_sync_state FOR SELECT TO authenticated
  USING ((select public.care_can_view_all()));
-- care_import_staging, care_reconcile_queue, care_order_attributions (Q-95), care_orders (Q-101): KHÔNG
-- policy ⇒ authenticated không thấy dòng nào (và cũng không có GRANT SELECT).

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
  v_proof_prefix text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'care_record_interaction: chưa đăng nhập'; END IF;
  IF p_today IS NULL THEN RAISE EXCEPTION 'care_record_interaction: thiếu ngày'; END IF;
  SELECT * INTO t FROM public.care_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'care_record_interaction: không tìm thấy task'; END IF;
  -- Q-76/77: QLCH không tham gia CRM — chỉ dược sĩ (staff) đang được giao mới ghi lượt.
  IF t.assignee_id <> v_uid OR public.get_user_role() IS DISTINCT FROM 'staff' THEN
    RAISE EXCEPTION 'care_record_interaction: chỉ dược sĩ được giao task mới ghi nhận';
  END IF;
  -- Q-82 (B4 r1.1): dược sĩ phải còn thuộc ĐÚNG store của task và store đó là OS đang hoạt
  -- động — bị tháo store / chuyển sang store khác (kể cả OS khác) / store ngừng ⇒ không ghi,
  -- kể cả khi còn là assignee. SM/super chuyển giao thủ công (Q-80).
  IF public.care_staff_store_id() IS DISTINCT FROM t.store_id THEN
    RAISE EXCEPTION 'care_record_interaction: chỉ dược sĩ được giao task mới ghi nhận (không còn thuộc cửa hàng của task)';
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
  -- Proof tùy chọn (Q-53), không quyết định trạng thái. Chỉ nhận {url}, tối đa 5 ảnh,
  -- tổng ≤ 4KB. B4: URL PHẢI là object do app cấp qua createUploadUrl purpose `care_proof`
  -- = <GCS public base>/care-proof/<task_id ĐÚNG task này>/<khoá opaque>.<ảnh> — gọi RPC
  -- trực tiếp cũng không đính được link ngoài / link của task khác; URL trùng trong mảng bị
  -- chặn (khớp TS). Base cố định theo GCS_PUBLIC_BASE_URL (.env.example = .env.local, 08/10;
  -- tiền lệ mig 095 affiliate-qr); đổi bucket ⇒ migration mới CREATE OR REPLACE hàm này +
  -- lib/care/my.ts (CARE_PROOF_PUBLIC_BASE, spec ép khớp).
  v_proof_prefix := 'https://storage.googleapis.com/duocsi-circa-vn/care-proof/' || t.id::text || '/';
  IF jsonb_typeof(v_proof) <> 'array' OR jsonb_array_length(v_proof) > 5
     OR pg_column_size(v_proof) > 4096
     OR (SELECT count(DISTINCT e->>'url') FROM jsonb_array_elements(v_proof) e) <> jsonb_array_length(v_proof)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_proof) e
       WHERE jsonb_typeof(e) <> 'object'
          OR (SELECT array_agg(k) FROM jsonb_object_keys(e) k) IS DISTINCT FROM ARRAY['url']
          OR jsonb_typeof(e->'url') IS DISTINCT FROM 'string'
          OR char_length(e->>'url') > 1000
          OR left(e->>'url', char_length(v_proof_prefix)) IS DISTINCT FROM v_proof_prefix
          OR substr(e->>'url', char_length(v_proof_prefix) + 1) !~ '^[0-9]{13}_[0-9a-f]{8}[.](jpg|png|webp|heic|heif)$') THEN
    RAISE EXCEPTION 'care_record_interaction: proof phải là mảng ≤5 ảnh do ứng dụng tải lên cho đúng task này';
  END IF;
  -- B4: chống ghi TRÙNG khi retry (mạng rớt sau khi server đã commit, 2 tab/2 máy): cùng
  -- người ghi + task + kết quả + ghi chú + ngày hẹn trong 2 phút ⇒ từ chối. Lượt kết thúc
  -- thứ hai vốn đã bị chặn bởi trạng thái task + unique one_terminal_per_task.
  IF EXISTS (SELECT 1 FROM public.care_interactions i
             WHERE i.task_id = t.id AND i.actor_id = v_uid AND i.outcome = p_outcome AND i.note = v_note
               AND i.next_action_date IS NOT DISTINCT FROM p_next_action_date
               AND i.created_at > now() - interval '2 minutes') THEN
    RAISE EXCEPTION 'care_record_interaction: lượt trùng vừa được ghi';
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
  -- Q-86 (chốt 08/10): không chuyển task cho chính assignee hiện tại, kể cả khi họ đã sang store khác (task
  -- còn ở store cũ — Q-82); SM phân công lại thủ công cho dược sĩ hợp lệ của store task, không tự động.
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
-- Task theo owner HIỆN TẠI; "Có đơn" = COUNT(DISTINCT task_id) theo snapshot attribution + tháng
-- của lượt Hoàn thành (Q-59/Q-91) — nhiều đơn cùng task vẫn 1; KHÔNG số đơn/tiền (Q-91). Hai
-- aggregate riêng rồi FULL JOIN ⇒ không nhân đôi khi khách nhiều sản phẩm/lượt. KHÔNG đọc
-- care_orders. is_test loại trừ, trừ super
-- chủ động bật p_include_test (QA B6). p_store_ids chỉ THU HẸP scope, không nới.
-- p_month được chuẩn hoá về ngày 1 (truyền ngày giữa tháng không ra rỗng âm thầm).
CREATE OR REPLACE FUNCTION public.care_report(p_month date, p_store_ids uuid[] DEFAULT NULL, p_include_test boolean DEFAULT false)
RETURNS TABLE (
  store_id uuid, assignee_id uuid,
  tasks_total integer, completed integer, open_not_cared integer, open_in_progress integer,
  overdue_in_period integer, closed_unfinished integer,
  converted_tasks integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (
    -- Q-82: nhánh staff = task/attribution của mình Ở ĐÚNG store hiện tại.
    SELECT public.care_assignee_uid() AS uid, public.care_staff_store_id() AS staff_store,
           public.care_can_view_all() AS v_all, public.care_scope_store_ids() AS scope,
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
      AND (me.v_all OR (t.assignee_id = me.uid AND t.store_id = me.staff_store) OR t.store_id = ANY (me.scope))
      AND (p_store_ids IS NULL OR t.store_id = ANY (p_store_ids))
    GROUP BY t.store_id, t.assignee_id
  ), at AS (
    SELECT a.store_id, a.assignee_id,
           count(DISTINCT a.task_id)::int AS conv_tasks
    FROM public.care_order_attributions a, me
    WHERE a.period_month = public.care_period_of(p_month) AND (me.v_test OR NOT a.is_test)
      AND (me.v_all OR (a.assignee_id = me.uid AND a.store_id = me.staff_store) OR a.store_id = ANY (me.scope))
      AND (p_store_ids IS NULL OR a.store_id = ANY (p_store_ids))
    GROUP BY a.store_id, a.assignee_id
  )
  SELECT COALESCE(tk.store_id, at.store_id), COALESCE(tk.assignee_id, at.assignee_id),
         COALESCE(tk.total, 0), COALESCE(tk.completed, 0), COALESCE(tk.not_cared, 0),
         COALESCE(tk.in_progress, 0), COALESCE(tk.overdue, 0), COALESCE(tk.unfinished, 0),
         COALESCE(at.conv_tasks, 0)
  FROM tk FULL OUTER JOIN at ON at.store_id = tk.store_id AND at.assignee_id = tk.assignee_id
  ORDER BY 1, 2
$$;

-- Thẻ "CSKH của tôi" (staff) — kỳ hiện tại, task đang giao cho chính mình Ở ĐÚNG store hiện
-- tại (Q-82 — khớp danh sách/RLS: staff chuyển A→B không đếm task còn ở A).
CREATE OR REPLACE FUNCTION public.care_my_summary()
RETURNS TABLE (period_month date, assigned integer, not_cared integer, completed integer, overdue_live integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (SELECT public.care_assignee_uid() AS uid, public.care_staff_store_id() AS store_id, public.care_vn_today() AS today)
  SELECT public.care_period_of(me.today),
         count(t.id)::int,
         count(t.id) FILTER (WHERE t.status = 'open' AND t.last_interaction_at IS NULL)::int,
         count(t.id) FILTER (WHERE t.status = 'completed')::int,
         count(t.id) FILTER (WHERE t.status = 'open' AND t.next_action_date < me.today)::int
  FROM me
  -- Loại fixture QA (is_test) như care_report (audit PM B1 P1).
  LEFT JOIN public.care_tasks t ON t.assignee_id = me.uid AND t.store_id = me.store_id
                                AND t.period_month = public.care_period_of(me.today)
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
-- 9b. B5a — tính lại attribution + trạng thái dữ liệu đơn (SPEC §B5a)
-- ════════════════════════════════════════════════════════════════════════════
-- Ghi công MỘT đơn N3 COMPLETED (care_orders) cho lượt Hoàn thành (is_terminal) GẦN NHẤT của cùng
-- customer_external_id có created_at < ordered_at (STRICT — đơn completed_at bằng đúng giờ lượt KHÔNG
-- tính; trùng giờ giữa các lượt ⇒ id lớn hơn). Người/store/tháng/task lấy từ snapshot LƯỢT — không từ
-- owner task hiện tại (Q-59). Unique index care_interactions_one_terminal_per_task ⇒ mỗi task một lượt
-- terminal ⇒ báo cáo đếm DISTINCT task không nhân đôi. Q-89 (đã chốt): REFUSED là terminal, VẪN ghi
-- công. Q-93: đơn COMPLETED không về CANCELED ⇒ không có nhánh hủy/hoàn. Không có lượt hợp lệ ⇒ không
-- attribution. Phạm vi = đơn của các khách/đơn truyền vào + đơn ĐANG gán cho các khách đó (đơn đổi khách/giờ được
-- tính lại cả phía cũ). Đơn vắng khỏi một lần đồng bộ KHÔNG bị coi là xoá (Q-68); đơn bị xoá khỏi
-- care_orders ⇒ attribution xoá theo FK CASCADE. MỘT câu lệnh CTE ghi dữ liệu ⇒ cùng snapshot,
-- tất-cả-hoặc-không; khoá advisory tuần tự hoá mọi lần tính lại. Chạy lại cùng dữ liệu ⇒ 0 dòng
-- thay đổi. service_role only (cron B5b / QA). Giới hạn 20.000 khách + 20.000 đơn/lần = trần một lô
-- parser N3 (lib/care/orders/n3.ts CARE_N3_MAX_ROWS — spec ép khớp).
-- TODO(Q-03): ghi công theo is_terminal (6 outcome, 4 kết thúc — mặc định Q-03). Đổi tập terminal ⇒
--   đổi care_is_terminal_outcome + giá trị is_terminal đã ghi KHÔNG tự đổi ⇒ phải tính lại toàn bộ.
-- Hợp đồng cho B5b (sink đồng bộ, một transaction): (1) lấy pg_advisory_xact_lock(hashtext(
--   'care_recompute_attribution')) TRƯỚC khi upsert care_orders; (2) luôn truyền order_key của lô (đơn
--   MỚI chỉ vào scope qua khoá); (3) care_reconcile_queue chỉ BỔ SUNG khách mới vào lô — tập cần đọc lại
--   mỗi lần là MỌI task Hoàn thành chưa có attribution (drain queue không được làm quên task "Chưa thấy
--   đơn"); (4) thành công ⇒ last_success_at = GREATEST(cũ, snapshot), last_error chỉ xoá khi snapshot
--   ≥ updated_at; lỗi ⇒ giữ attribution cũ. Hiện thực: care_order_sync_apply / care_order_sync_fail (9c).
CREATE OR REPLACE FUNCTION public.care_recompute_attribution(
  p_customer_external_ids text[] DEFAULT NULL, p_order_keys text[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ext   text[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_customer_external_ids, '{}'::text[])) x
                          WHERE x IS NOT NULL AND x <> '');
  v_keys  text[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_order_keys, '{}'::text[])) x
                          WHERE x IS NOT NULL AND x <> '');
  v_scope integer;
  v_up    integer;
  v_del   integer;
BEGIN
  IF cardinality(v_ext) = 0 AND cardinality(v_keys) = 0 THEN
    RAISE EXCEPTION 'care_recompute_attribution: cần ít nhất một khách hoặc một đơn';
  END IF;
  IF cardinality(v_ext) > 20000 OR cardinality(v_keys) > 20000 THEN
    RAISE EXCEPTION 'care_recompute_attribution: vượt giới hạn một lần (20000 khách, 20000 đơn)';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('care_recompute_attribution'));

  -- Nhánh 2 tra attribution theo customer_id (index care_attr_customer_idx); attribution có order_key ∈
  -- v_keys đã nằm trong nhánh 1 nhờ FK order_key → care_orders.
  WITH scope AS (
    SELECT o.order_key FROM public.care_orders o
    WHERE o.customer_external_id = ANY (v_ext) OR o.order_key = ANY (v_keys)
    UNION
    SELECT a.order_key FROM public.care_order_attributions a
    WHERE a.customer_id IN (SELECT c.id FROM public.care_customers c WHERE c.external_id = ANY (v_ext))
  ), desired AS (
    SELECT o.order_key, w.id AS interaction_id, w.task_id, w.customer_id, w.assignee_id, w.store_id,
           w.period_month, w.is_test
    FROM scope s
    JOIN public.care_orders o ON o.order_key = s.order_key
    JOIN public.care_customers c ON c.external_id = o.customer_external_id
    CROSS JOIN LATERAL (
      SELECT i.id, i.task_id, i.customer_id, i.assignee_id, i.store_id, i.period_month, i.is_test
      FROM public.care_interactions i
      WHERE i.customer_id = c.id AND i.is_terminal AND i.created_at < o.ordered_at
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT 1
    ) w
  ), del AS (
    DELETE FROM public.care_order_attributions a
    USING scope s
    WHERE a.order_key = s.order_key
      AND NOT EXISTS (SELECT 1 FROM desired d WHERE d.order_key = a.order_key)
    RETURNING a.order_key
  ), up AS (
    INSERT INTO public.care_order_attributions AS a
      (order_key, interaction_id, task_id, customer_id, assignee_id, store_id, period_month, is_test, computed_at)
    SELECT order_key, interaction_id, task_id, customer_id, assignee_id, store_id, period_month, is_test, now()
    FROM desired
    ON CONFLICT (order_key) DO UPDATE
      SET interaction_id = EXCLUDED.interaction_id, task_id = EXCLUDED.task_id, customer_id = EXCLUDED.customer_id,
          assignee_id = EXCLUDED.assignee_id, store_id = EXCLUDED.store_id, period_month = EXCLUDED.period_month,
          is_test = EXCLUDED.is_test, computed_at = now()
      WHERE (a.interaction_id, a.task_id, a.customer_id, a.assignee_id, a.store_id, a.period_month, a.is_test)
            IS DISTINCT FROM (EXCLUDED.interaction_id, EXCLUDED.task_id, EXCLUDED.customer_id, EXCLUDED.assignee_id,
                              EXCLUDED.store_id, EXCLUDED.period_month, EXCLUDED.is_test)
    RETURNING a.order_key
  )
  SELECT (SELECT count(*) FROM scope), (SELECT count(*) FROM up), (SELECT count(*) FROM del)
  INTO v_scope, v_up, v_del;

  RETURN jsonb_build_object('scope', v_scope, 'upserted', v_up, 'deleted', v_del);
END $$;

-- Trạng thái dữ liệu đơn cho người xem BÁO CÁO (super / care admin / SM có scope): đọc care_sync_state
-- qua DEFINER sau khi kiểm quyền — KHÔNG mở SELECT bảng cho SM/staff/QLCH, không trả last_error thô.
-- Chưa có dòng / chưa lần thành công ⇒ has_synced=false ⇒ UI "Chưa có dữ liệu đơn" (không giả 0).
-- Người không có quyền xem báo cáo ⇒ 0 dòng. Dòng source='n3_orders' do care_order_sync_apply (thành công:
-- last_success_at + xoá last_error) / care_order_sync_fail (chỉ MÃ lỗi, CHECK) ghi — xem 9c.
CREATE OR REPLACE FUNCTION public.care_order_sync_status()
RETURNS TABLE (has_synced boolean, last_success_at timestamptz, last_failed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.last_success_at IS NOT NULL, s.last_success_at, s.last_error IS NOT NULL
  FROM (SELECT 1) AS one
  LEFT JOIN public.care_sync_state s ON s.source = 'n3_orders'
  WHERE public.care_can_view_all() OR cardinality(public.care_scope_store_ids()) > 0
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 9c. B5b.2 — đồng bộ đơn N3 (service_role; cron care-orders-sync, SPEC §B5b)
-- ════════════════════════════════════════════════════════════════════════════
-- Một lượt cron: (1) care_order_sync_candidates chụp tập khoảng (snapshot_at = now() DB); (2) app đọc VIEW
-- theo khoảng, kiểm TOÀN BỘ; (3) care_order_sync_apply ghi đơn + tính lại + dọn queue + đánh dấu thành công
-- trong MỘT transaction; lỗi bất kỳ bước nào ⇒ care_order_sync_fail chỉ ghi MÃ lỗi, giữ dữ liệu cũ.
-- care_sync_state.updated_at = snapshot_at của KẾT QUẢ mới nhất đã ghi (thành công hoặc lỗi) ⇒ lượt chạy
-- chồng/đến muộn không đè kết quả của lượt mới hơn; last_success_at không bao giờ lùi.

-- Ứng viên = MỌI lượt terminal mà task CHƯA có attribution ("Chưa thấy đơn"), kể cả lượt cũ (bắt đơn đến
-- VIEW muộn). Khoảng (lo, hi]: lo = created_at của lượt; hi = created_at lượt terminal KẾ TIẾP cùng khách,
-- tính LEAD trên TOÀN BỘ lượt terminal của khách TRƯỚC khi lọc (đơn sau hi thuộc lượt sau — không kéo lại).
-- hi NULL ⇒ mở. Lượt cùng mốc ⇒ lượt id nhỏ có lo = hi (rỗng — app bỏ). Gồm is_test (fixture QA B6 đi được
-- đường sync; báo cáo vẫn loại is_test). Trả MỘT jsonb (PostgREST cắt SETOF theo db-max-rows): tổng số
-- khoảng + số khách duy nhất (Q-98 báo riêng) + tối đa p_cap+1 khoảng (app thấy > p_cap ⇒ fail-closed).
CREATE OR REPLACE FUNCTION public.care_order_sync_candidates(p_cap integer DEFAULT 20000)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH term AS (
    SELECT i.task_id, i.customer_id, i.created_at,
           lead(i.created_at) OVER (PARTITION BY i.customer_id ORDER BY i.created_at, i.id) AS next_at
    FROM public.care_interactions i
    WHERE i.is_terminal
  ), w AS (
    SELECT c.external_id, t.created_at AS lo, t.next_at AS hi
    FROM term t
    JOIN public.care_customers c ON c.id = t.customer_id
    WHERE NOT EXISTS (SELECT 1 FROM public.care_order_attributions a WHERE a.task_id = t.task_id)
  ), lim AS (
    SELECT * FROM w ORDER BY lo, external_id LIMIT GREATEST(LEAST(COALESCE(p_cap, 20000), 20000), 0) + 1
  )
  SELECT jsonb_build_object(
    'snapshot_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'windows', (SELECT count(*) FROM w),
    'customers', (SELECT count(DISTINCT external_id) FROM w),
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_array(
               external_id,
               to_char(lo AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               CASE WHEN hi IS NULL THEN NULL ELSE to_char(hi AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END)
             ORDER BY lo, external_id) FROM lim), '[]'::jsonb))
$$;

-- Ghi MỘT lượt đồng bộ, tất-cả-hoặc-không: kiểm TOÀN BỘ payload (mảng ≤ 20.000 phần tử, mỗi phần tử ĐÚNG 3
-- key chuỗi, mốc hợp lệ và KHÔNG ở tương lai quá 5 phút — chặn VIEW sai múi giờ Q-100 ngay ở DB, trùng
-- order_key giống hệt thì gộp, mâu thuẫn thì RAISE) rồi mới ghi: upsert care_orders (chỉ khi đổi) ⇒
-- care_recompute_attribution(khách, khoá của lô) ⇒ xoá queue enqueued_at ≤ snapshot ⇒ đánh dấu thành công.
-- Lô rỗng vẫn đánh dấu thành công (đã đọc đủ phạm vi). Khoá advisory chung với recompute ⇒ cron chồng
-- tuần tự hoá; ghi lại cùng dữ liệu ⇒ 0 thay đổi. Lỗi ở bất kỳ bước nào ⇒ rollback cả lượt.
CREATE OR REPLACE FUNCTION public.care_order_sync_apply(p_orders jsonb, p_snapshot_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_n       integer;
  v_written integer := 0;
  v_queue   integer := 0;
  v_attr    jsonb := jsonb_build_object('scope', 0, 'upserted', 0, 'deleted', 0);
BEGIN
  IF p_snapshot_at IS NULL OR p_snapshot_at > now() + interval '1 minute' OR p_snapshot_at < now() - interval '2 hours' THEN
    RAISE EXCEPTION 'care_order_sync_apply: snapshot_at ngoài biên';
  END IF;
  IF p_orders IS NULL OR jsonb_typeof(p_orders) <> 'array' THEN
    RAISE EXCEPTION 'care_order_sync_apply: p_orders phải là mảng';
  END IF;
  v_n := jsonb_array_length(p_orders);
  IF v_n > 20000 THEN
    RAISE EXCEPTION 'care_order_sync_apply: vượt 20000 đơn một lượt';
  END IF;
  -- Đúng 3 key chuỗi, kiểm theo TẬP (`?&` + đếm) — KHÔNG sắp xếp: prod datcollate en_US.UTF-8 xếp
  -- 'ordered_at' trước 'order_key' (PGlite là C ⇒ QA không thấy). Giá trị khớp CHECK care_orders ngay tại
  -- đây (RAISE chung, không để CHECK ghi giá trị thô vào log Postgres). ordered_at đúng dạng app chuẩn hoá
  -- (ISO UTC, 6 chữ số giây lẻ, 'Z') ⇒ không nhận 'now'/'epoch'/'infinity' hay chuỗi không offset (Q-100).
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_orders) e
             WHERE CASE WHEN jsonb_typeof(e) <> 'object' THEN true
                        ELSE NOT (e ?& ARRAY['customer_external_id', 'order_key', 'ordered_at'])
                          OR (SELECT count(*) FROM jsonb_object_keys(e)) <> 3
                          OR jsonb_typeof(e -> 'customer_external_id') <> 'string'
                          OR jsonb_typeof(e -> 'order_key') <> 'string'
                          OR jsonb_typeof(e -> 'ordered_at') <> 'string'
                          OR char_length(e ->> 'customer_external_id') NOT BETWEEN 1 AND 100
                          OR e ->> 'customer_external_id' <> btrim(e ->> 'customer_external_id')
                          OR char_length(e ->> 'order_key') NOT BETWEEN 1 AND 200
                          OR e ->> 'order_key' <> btrim(e ->> 'order_key')
                          OR e ->> 'ordered_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$' END) THEN
    RAISE EXCEPTION 'care_order_sync_apply: phần tử đơn sai dạng';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_orders) e
             WHERE (e ->> 'ordered_at')::timestamptz > now() + interval '5 minutes') THEN
    RAISE EXCEPTION 'care_order_sync_apply: đơn có mốc hoàn tất ở tương lai (nguồn sai thời gian)';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_orders) e GROUP BY e ->> 'order_key'
             HAVING count(DISTINCT (e ->> 'customer_external_id', (e ->> 'ordered_at')::timestamptz)) > 1) THEN
    RAISE EXCEPTION 'care_order_sync_apply: trùng order_key mâu thuẫn';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('care_recompute_attribution'));

  WITH src AS (
    SELECT DISTINCT e ->> 'order_key' AS order_key, e ->> 'customer_external_id' AS cust,
           (e ->> 'ordered_at')::timestamptz AS at
    FROM jsonb_array_elements(p_orders) e
  ), up AS (
    INSERT INTO public.care_orders AS o (order_key, customer_external_id, ordered_at, synced_at)
    SELECT order_key, cust, at, now() FROM src
    ON CONFLICT (order_key) DO UPDATE
      SET customer_external_id = EXCLUDED.customer_external_id, ordered_at = EXCLUDED.ordered_at, synced_at = now()
      WHERE (o.customer_external_id, o.ordered_at) IS DISTINCT FROM (EXCLUDED.customer_external_id, EXCLUDED.ordered_at)
    RETURNING 1
  )
  SELECT count(*) INTO v_written FROM up;

  IF v_n > 0 THEN
    v_attr := public.care_recompute_attribution(
      ARRAY(SELECT DISTINCT e ->> 'customer_external_id' FROM jsonb_array_elements(p_orders) e),
      ARRAY(SELECT DISTINCT e ->> 'order_key' FROM jsonb_array_elements(p_orders) e));
  END IF;

  DELETE FROM public.care_reconcile_queue WHERE enqueued_at <= p_snapshot_at;
  GET DIAGNOSTICS v_queue = ROW_COUNT;

  INSERT INTO public.care_sync_state AS s (source, last_success_at, last_error, updated_at)
  VALUES ('n3_orders', p_snapshot_at, NULL, p_snapshot_at)
  ON CONFLICT (source) DO UPDATE SET
    last_success_at = GREATEST(COALESCE(s.last_success_at, '-infinity'::timestamptz), EXCLUDED.last_success_at),
    -- Chỉ xoá lỗi khi lượt này MỚI HƠN kết quả đã ghi (lượt cũ xong muộn không xoá lỗi của lượt mới).
    last_error = CASE WHEN EXCLUDED.updated_at >= s.updated_at THEN NULL ELSE s.last_error END,
    updated_at = GREATEST(s.updated_at, EXCLUDED.updated_at);

  RETURN jsonb_build_object('orders', v_n, 'orders_written', v_written, 'attribution', v_attr, 'queue_drained', v_queue);
END $$;

-- Ghi MÃ lỗi của một lượt thất bại (CHECK last_error chỉ nhận mã) — chỉ khi lượt này MỚI HƠN kết quả đã ghi;
-- không đụng last_success_at (UI giữ số cũ + mốc thành công cuối). Trả true nếu đã ghi.
CREATE OR REPLACE FUNCTION public.care_order_sync_fail(p_code text, p_snapshot_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_snapshot_at IS NULL OR p_snapshot_at > now() + interval '1 minute' OR p_snapshot_at < now() - interval '2 hours' THEN
    RAISE EXCEPTION 'care_order_sync_fail: snapshot_at ngoài biên';
  END IF;
  -- CHECK cột cho qua NULL ⇒ fail(NULL) sẽ XOÁ lỗi đang có; chặn tại đây (cùng mẫu CHECK, không ghi giá trị).
  IF p_code IS NULL OR p_code !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'care_order_sync_fail: mã lỗi sai dạng';
  END IF;
  INSERT INTO public.care_sync_state AS s (source, last_success_at, last_error, updated_at)
  VALUES ('n3_orders', NULL, p_code, p_snapshot_at)
  ON CONFLICT (source) DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = EXCLUDED.updated_at
    WHERE EXCLUDED.updated_at > s.updated_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $$;

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
  public.care_staff_store_id(),
  public.care_can_read_task(uuid), public.care_can_read_customer_history(uuid),
  public.care_staff_reads_task(uuid), public.care_staff_reads_customer(uuid),
  public.care__close_period_at(date), public.care__stamp_overdue_at(date),
  public.care_close_period(), public.care_stamp_overdue(), public.care_purge_stale_staging(interval),
  public.care__import_finalize_at(uuid, uuid, date), public.care_import_finalize(uuid, uuid),
  public.care__record_interaction_at(date, uuid, text, text, date, jsonb),
  public.care_record_interaction(uuid, text, text, date, jsonb),
  public.care__transfer_tasks_at(date, uuid[], uuid, text),
  public.care_transfer_tasks(uuid[], uuid, text),
  public.care_report(date, uuid[], boolean), public.care_my_summary(), public.care_my_access(),
  public.care_recompute_attribution(text[], text[]), public.care_order_sync_status(),
  public.care_order_sync_candidates(integer), public.care_order_sync_apply(jsonb, timestamptz),
  public.care_order_sync_fail(text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

-- Thuần + helper policy: authenticated (policy chạy với quyền người gọi) + service_role.
GRANT EXECUTE ON FUNCTION
  public.care_is_outcome(text), public.care_is_terminal_outcome(text),
  public.care_outcome_requires_date(text), public.care_outcome_records_refusal(text),
  public.care_vn_date(timestamptz), public.care_vn_today(), public.care_period_of(date), public.care_period_last_day(date),
  public.care_overdue_stamp(date, date, date), public.care_normalize_vn_phone(text),
  public.care_can_view_all(), public.care_can_import(), public.care_scope_store_ids(), public.care_assignee_uid(),
  public.care_staff_store_id(),
  public.care_can_read_task(uuid), public.care_can_read_customer_history(uuid),
  public.care_staff_reads_task(uuid), public.care_staff_reads_customer(uuid)
  TO authenticated, service_role;
-- RPC người dùng.
GRANT EXECUTE ON FUNCTION
  public.care_record_interaction(uuid, text, text, date, jsonb),
  public.care_transfer_tasks(uuid[], uuid, text),
  public.care_report(date, uuid[], boolean), public.care_my_summary(), public.care_my_access(),
  public.care_order_sync_status()
  TO authenticated;
-- RPC hệ thống (route import B2, cron B5).
GRANT EXECUTE ON FUNCTION
  public.care_import_finalize(uuid, uuid), public.care_close_period(), public.care_stamp_overdue(),
  public.care_purge_stale_staging(interval), public.care_recompute_attribution(text[], text[]),
  public.care_order_sync_candidates(integer), public.care_order_sync_apply(jsonb, timestamptz),
  public.care_order_sync_fail(text, timestamptz)
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
      -- authenticated: chỉ SELECT (trừ staging/queue/attribution Q-95/đơn thô Q-101); ngoại lệ care_access
      -- có I/U/D (policy chỉ cho super).
      IF has_table_privilege('authenticated', 'public.' || v_t, v_priv)
         AND NOT (v_priv = 'SELECT' AND v_t NOT IN ('care_import_staging', 'care_reconcile_queue', 'care_order_attributions', 'care_orders'))
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
  -- B5a r1.1 (Q-91/Q-93): tập cột CHÍNH XÁC — CREATE TABLE IF NOT EXISTS có thể bỏ qua lặng lẽ bảng dạng
  -- sáu cột r3.2 cũ (tiền/cursor/pos_code) nếu môi trường từng chạy bản nháp. pg_attribute (không phụ
  -- thuộc quyền cột như information_schema — db-reviewer P2).
  IF (SELECT string_agg(a.attname::text, ',' ORDER BY a.attname::text COLLATE "C") FROM pg_attribute a
      WHERE a.attrelid = 'public.care_orders'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
       IS DISTINCT FROM 'customer_external_id,order_key,ordered_at,synced_at'
     OR (SELECT string_agg(a.attname::text, ',' ORDER BY a.attname::text COLLATE "C") FROM pg_attribute a
         WHERE a.attrelid = 'public.care_order_attributions'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
       IS DISTINCT FROM 'assignee_id,computed_at,customer_id,interaction_id,is_test,order_key,period_month,store_id,task_id'
     OR (SELECT string_agg(a.attname::text, ',' ORDER BY a.attname::text COLLATE "C") FROM pg_attribute a
         WHERE a.attrelid = 'public.care_sync_state'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
       IS DISTINCT FROM 'last_error,last_success_at,source,updated_at'
     OR to_regclass('public.care_orders_cursor_idx') IS NOT NULL THEN
    RAISE EXCEPTION '114 hậu kiểm: care_orders/attributions/sync_state không đúng N3 r3.4 ba cột (Q-91 — không tiền/cursor/pos_code)';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'care\_%') <> 12 THEN
    RAISE EXCEPTION '114 hậu kiểm: số policy care_* phải là 12';
  END IF;
  -- Q-95 (attribution) + Q-101 (đơn thô): không role người dùng nào đọc thẳng — kể cả quyền mức cột/policy.
  FOREACH v_t IN ARRAY ARRAY['care_order_attributions', 'care_orders'] LOOP
    IF has_table_privilege('authenticated', 'public.' || v_t, 'SELECT')
       OR has_any_column_privilege('authenticated', 'public.' || v_t, 'SELECT')
       OR has_table_privilege('anon', 'public.' || v_t, 'SELECT')
       OR has_any_column_privilege('anon', 'public.' || v_t, 'SELECT')
       OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t) THEN
      RAISE EXCEPTION '114 hậu kiểm: % còn SELECT (bảng/cột)/policy cho người dùng (Q-95/Q-101)', v_t;
    END IF;
  END LOOP;
  -- Q-105: care_customers — authenticated đọc ĐÚNG 3 cột (id, is_test, created_at) theo RLS; external_id chỉ
  -- service_role. Không GRANT SELECT mức bảng cho authenticated/anon/PUBLIC (ACL), vì quyền bảng mở mọi cột.
  -- Kiểm theo pg_attribute ⇒ cột thêm sau này mặc định phải KHÔNG đọc được.
  IF has_table_privilege('authenticated', 'public.care_customers', 'SELECT')
     OR has_any_column_privilege('anon', 'public.care_customers', 'SELECT')
     OR NOT has_column_privilege('service_role', 'public.care_customers', 'external_id', 'SELECT')
     OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.care_customers'::regclass
                AND a.attnum > 0 AND NOT a.attisdropped
                AND has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT')
                    IS DISTINCT FROM (a.attname IN ('id', 'is_test', 'created_at')))
     OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) x
                WHERE c.oid = 'public.care_customers'::regclass AND x.privilege_type = 'SELECT'
                  AND x.grantee IN (0::oid, 'authenticated'::regrole::oid, 'anon'::regrole::oid)) THEN
    RAISE EXCEPTION '114 hậu kiểm: care_customers phải chỉ cho authenticated SELECT (id, is_test, created_at) — external_id chỉ service_role (Q-105)';
  END IF;
  -- Hàm DEFINER (care_report, care_recompute_attribution, care_order_sync_*) đọc bảng không policy
  -- (attribution, đơn thô, queue) nhờ owner bỏ qua RLS. FORCE RLS hoặc owner lệch ⇒ số liệu 0 GIẢ không báo
  -- lỗi (§4.7) ⇒ chặn ngay ở đây: MỌI hàm care* SECURITY DEFINER cùng owner với mọi bảng care_*.
  IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'care\_%'
             AND relkind = 'r' AND relforcerowsecurity)
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'care%'
                AND p.prosecdef AND p.proowner IS DISTINCT FROM (SELECT c.relowner FROM pg_class c WHERE c.oid = 'public.care_orders'::regclass))
     OR (SELECT count(DISTINCT relowner) FROM pg_class WHERE relnamespace = 'public'::regnamespace
         AND relname LIKE 'care\_%' AND relkind = 'r') <> 1 THEN
    RAISE EXCEPTION '114 hậu kiểm: bảng care_* bật FORCE RLS hoặc owner hàm DEFINER/bảng care_* không thống nhất';
  END IF;
  -- Q-104: CHECK chặn product_id toàn số 0 ở bảng sản phẩm (bảo vệ đường ghi ngoài finalize).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'c' AND conrelid = 'public.care_task_products'::regclass
                 AND pg_get_constraintdef(oid) ~ 'product_id' AND pg_get_constraintdef(oid) ~ '\^0\+\$') THEN
    RAISE EXCEPTION '114 hậu kiểm: care_task_products thiếu CHECK product_id toàn số 0 (Q-104)';
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
  IF position('/care-proof/' in pg_get_functiondef('public.care__record_interaction_at(date,uuid,text,text,date,jsonb)'::regprocedure)) = 0
     OR position('lượt trùng vừa được ghi' in pg_get_functiondef('public.care__record_interaction_at(date,uuid,text,text,date,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '114 hậu kiểm: care__record_interaction_at chưa phải bản B4 (proof/chống trùng)';
  END IF;
  -- B4 r1.1 (Q-82): ghi lượt + policy task + helper đọc staff đều so store task với care_staff_store_id().
  IF position('care_staff_store_id' in pg_get_functiondef('public.care__record_interaction_at(date,uuid,text,text,date,jsonb)'::regprocedure)) = 0
     OR position('care_staff_store_id' in pg_get_functiondef('public.care_staff_reads_task(uuid)'::regprocedure)) = 0
     OR position('care_staff_store_id' in pg_get_functiondef('public.care_staff_reads_customer(uuid)'::regprocedure)) = 0
     OR position('care_staff_store_id' in pg_get_functiondef('public.care_can_read_task(uuid)'::regprocedure)) = 0
     OR position('care_staff_store_id' in pg_get_functiondef('public.care_can_read_customer_history(uuid)'::regprocedure)) = 0
     OR position('care_staff_store_id' in pg_get_functiondef('public.care_my_summary()'::regprocedure)) = 0
     OR position('care_staff_store_id' in pg_get_functiondef('public.care_report(date,uuid[],boolean)'::regprocedure)) = 0
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'care_tasks_select'
                    AND qual ~ 'care_staff_store_id') THEN
    RAISE EXCEPTION '114 hậu kiểm: chưa phải bản B4 r1.1 (Q-82 — staff phải thuộc đúng store của task)';
  END IF;
  -- B5a: index attribution theo khách (nhánh 2 của care_recompute_attribution) + CHECK btrim khoá/ID đơn.
  IF to_regclass('public.care_attr_customer_idx') IS NULL
     OR (SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND conrelid = 'public.care_orders'::regclass
           AND pg_get_constraintdef(oid) ~ 'btrim') <> 2 THEN
    RAISE EXCEPTION '114 hậu kiểm: thiếu index care_attr_customer_idx hoặc CHECK btrim order_key/customer_external_id (B5a)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'c' AND conrelid = 'public.care_sync_state'::regclass
                 AND pg_get_constraintdef(oid) ~ 'last_error') THEN
    RAISE EXCEPTION '114 hậu kiểm: care_sync_state.last_error thiếu CHECK dạng mã lỗi (không message thô)';
  END IF;
  -- care_report GĐ1 không trả số đơn/tiền (Q-91): chữ ký kết quả CHÍNH XÁC, cột cuối converted_tasks.
  IF pg_get_function_result('public.care_report(date,uuid[],boolean)'::regprocedure) IS DISTINCT FROM
     'TABLE(store_id uuid, assignee_id uuid, tasks_total integer, completed integer, open_not_cared integer, '
     || 'open_in_progress integer, overdue_in_period integer, closed_unfinished integer, converted_tasks integer)' THEN
    RAISE EXCEPTION '114 hậu kiểm: chữ ký care_report sai (Q-91 — chỉ task metrics + converted_tasks, không orders/net_revenue)';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'care%') <> 41 THEN
    RAISE EXCEPTION '114 hậu kiểm: số function care* phải là 41';
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
      ('public.care_recompute_attribution(text[],text[])',          false, true),
      ('public.care_order_sync_status()',                           true,  false),
      ('public.care_order_sync_candidates(integer)',                false, true),
      ('public.care_order_sync_apply(jsonb,timestamptz)',           false, true),
      ('public.care_order_sync_fail(text,timestamptz)',             false, true),
      ('public.care_assignee_uid()',                                true,  true),
      ('public.care_staff_store_id()',                              true,  true),
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
        || ' Seed care_access Marketing. Migration khong doc BigQuery; dong bo N3 qua RPC B5b.2 (cron app).'
        || ' B3 r1.1 (Q-76/77): QLCH store_manager khong tham gia CRM (care_assignee_uid, scope chi SM).'
        || ' B3 r1.2 (Q-79): SM doc luot/event/DNC theo store snapshot cua dong thuoc vung.'
        || ' B5a r1.2 (Q-95/Q-101): authenticated khong SELECT care_order_attributions/care_orders (chi RPC DEFINER).'
        || ' Q-104: product_id toan so 0 bi chan (finalize PRODUCT_ID_INVALID + CHECK).'
        || ' Q-105: authenticated chi SELECT care_customers(id, is_test, created_at); external_id chi service_role.'
        || ' B4: proof ep base GCS + care-proof/<task_id>/ + khoa app sinh; chong ghi trung 2 phut; staff phai o store OS hoat dong.'
        || ' B4 r1.1 (Q-82): staff chi doc/ghi task o DUNG store hien tai (care_staff_store_id).'
        || ' B5a: care_recompute_attribution (service_role; luot Hoan thanh gan nhat truoc ordered_at, snapshot luot)'
        || ' + care_order_sync_status (nguoi xem bao cao). B5a r1.1 (Q-91/Q-93): N3 ba cot (don COMPLETED,'
        || ' ordered_at = completed_at); report chi converted_tasks, khong so don/tien/cursor.'
        || ' B5b.2: care_order_sync_candidates/apply/fail (service_role) cho cron care-orders-sync (co CARE_SYNC_ENABLED OFF).'
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
--         OR (p.proname IN ('care_import_finalize', 'care_close_period', 'care_stamp_overdue', 'care_purge_stale_staging',
--                           'care_recompute_attribution', 'care_order_sync_candidates', 'care_order_sync_apply',
--                           'care_order_sync_fail')
--             AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
--         OR (p.prosecdef AND NOT COALESCE(p.proconfig @> ARRAY['search_path=public'], false)) );
--    và: SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'care%';  -- 41
-- 4) Quyền bảng (kỳ vọng: authenticated SELECT mức bảng trên 8 bảng — KHÔNG care_order_attributions (Q-95),
--    care_orders (Q-101), care_customers (Q-105 — chỉ quyền cột, xem VERIFY 21), staging, queue — +
--    INSERT/UPDATE/DELETE trên care_access; anon 0 dòng):
--    SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--    FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND table_name LIKE 'care\_%' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
--    GROUP BY 1, 2 ORDER BY 1, 2;
-- 5) Sequence (kỳ vọng false hết):
--    SELECT s, has_sequence_privilege('anon', s, 'USAGE') a, has_sequence_privilege('authenticated', s, 'USAGE') u
--    FROM unnest(ARRAY[pg_get_serial_sequence('public.care_interactions', 'id'),
--                      pg_get_serial_sequence('public.care_assignment_events', 'id')]) s;
-- 6) Policy (kỳ vọng 12 và 0 policy có FROM; không policy nào trên care_order_attributions/care_orders — Q-95/Q-101):
--    SELECT count(*) AS n_policy, count(*) FILTER (WHERE qual ~* '\mfrom\M' OR with_check ~* '\mfrom\M') AS n_from
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
--    SELECT public.care_assignee_uid() IS NULL AS not_assignee, cardinality(public.care_scope_store_ids()) AS n_scope,
--           (SELECT count(*) FROM public.care_tasks) AS n_tasks, (SELECT count(*) FROM public.care_access) AS n_access,
--           (SELECT count(*) FROM public.care_report(public.care_period_of(public.care_vn_today()))) AS n_report,
--           public.care_my_access() AS my_access;      -- true, 0, 0, 0, 0, can_import/can_view_all=false
--    COMMIT;
-- 12) Helper nền: SELECT prosecdef FROM pg_proc WHERE oid = 'public.get_user_role()'::regprocedure;  -- true
-- 13) Task mồ côi (assignee không còn là staff — sau khi có dữ liệu, kỳ vọng 0 dòng; xử lý bằng chuyển giao):
--    SELECT t.assignee_id, u.role, count(*) FROM public.care_tasks t JOIN public.users u ON u.id = t.assignee_id
--    WHERE t.status = 'open' AND u.role IS DISTINCT FROM 'staff' GROUP BY 1, 2;
-- 14) Q-79 — cấu trúc policy (có nghĩa cả khi DB còn rỗng). Kỳ vọng: 3 policy Q-79 → t, t, f, f;
--     care_task_products_select / care_customers_select → f, f, t, f (attribution không còn policy — Q-95):
--    SELECT policyname, qual ~ 'care_scope_store_ids' AS scope_snapshot, qual ~ 'care_staff_reads_(task|customer)' AS staff_helper,
--           qual ~ 'care_can_read_(task|customer_history)' AS old_helper, qual ~* '\mfrom\M' AS has_from
--    FROM pg_policies WHERE schemaname = 'public' AND policyname IN ('care_interactions_select', 'care_assignment_events_select',
--      'care_store_refusals_select', 'care_task_products_select', 'care_customers_select')
--    ORDER BY 1;
--    Q-95/Q-101 (kỳ vọng 2 dòng f, f, f, f, 0 — tính cả quyền mức cột):
--    SELECT t, has_table_privilege('authenticated', 'public.' || t, 'SELECT'),
--      has_any_column_privilege('authenticated', 'public.' || t, 'SELECT'),
--      has_table_privilege('anon', 'public.' || t, 'SELECT'),
--      has_any_column_privilege('anon', 'public.' || t, 'SELECT'),
--      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = t)
--    FROM unnest(ARRAY['care_order_attributions', 'care_orders']) t;
--    Đường DEFINER dựa vào owner bỏ qua RLS (kỳ vọng 0 dòng; same = t):
--    SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'care\_%'
--      AND relkind = 'r' AND relforcerowsecurity;
--    SELECT p.proowner::regrole fn_owner, c.relowner::regrole tbl_owner, p.proowner = c.relowner AS same
--    FROM pg_proc p, pg_class c WHERE p.oid = 'public.care_report(date,uuid[],boolean)'::regprocedure
--      AND c.oid = 'public.care_order_attributions'::regclass;
--    Smoke DEFINER không cần uid (kỳ vọng 0 dòng, KHÔNG lỗi quyền); SELECT thẳng bảng ⇒ ERROR 42501:
--    BEGIN READ ONLY; SET LOCAL ROLE authenticated;
--    SELECT count(*) FROM public.care_report(public.care_period_of(public.care_vn_today()));
--    COMMIT;
--    Helper mới: SELECT p.oid::regprocedure, p.prosecdef, p.provolatile, p.proconfig,
--      has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth
--    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('care_staff_reads_task', 'care_staff_reads_customer', 'care_assignee_uid', 'care_staff_store_id');
--    -- prosecdef=t, provolatile='s', proconfig={search_path=public}, anon=f, auth=t
-- 15) Sau khi có dữ liệu — giả lập SM (thay <SM_UID>), kỳ vọng 0/0/0 (attribution: SELECT bị từ chối — Q-95;
--     số Có đơn của SM chỉ qua care_report, đã lọc store snapshot):
--    BEGIN READ ONLY; SET LOCAL ROLE authenticated;
--    SELECT set_config('request.jwt.claim.sub', '<SM_UID>', true);
--    SELECT (SELECT count(*) FROM public.care_interactions WHERE NOT (store_id = ANY (public.care_scope_store_ids()))) i_out,
--           (SELECT count(*) FROM public.care_store_refusals WHERE NOT (store_id = ANY (public.care_scope_store_ids()))) r_out,
--           (SELECT count(*) FROM public.care_assignment_events
--             WHERE NOT (ARRAY[from_store_id, to_store_id] && public.care_scope_store_ids())) e_out;
--    COMMIT;
-- 16) B4 — đúng bản (kỳ vọng t, t): hàm ghi lượt có ràng buộc proof care-proof + chống trùng:
--    SELECT position('/care-proof/' in d) > 0 AS has_proof, position('lượt trùng vừa được ghi' in d) > 0 AS has_dedupe
--    FROM (SELECT pg_get_functiondef('public.care__record_interaction_at(date,uuid,text,text,date,jsonb)'::regprocedure) d) x;
--    Base GCS prod khớp hằng (tiền lệ 095, kỳ vọng ≥ 25):
--    SELECT count(*) FROM public.affiliate_partner_mappings WHERE qr_image_url LIKE 'https://storage.googleapis.com/duocsi-circa-vn/%';
--    Sau khi có dữ liệu — proof lệch dạng/lệch task (kỳ vọng 0):
--    SELECT count(*) FROM public.care_interactions i CROSS JOIN LATERAL jsonb_array_elements(i.proof) e
--    WHERE left(e->>'url', char_length('https://storage.googleapis.com/duocsi-circa-vn/care-proof/' || i.task_id::text || '/'))
--            IS DISTINCT FROM ('https://storage.googleapis.com/duocsi-circa-vn/care-proof/' || i.task_id::text || '/')
--       OR substr(e->>'url', char_length('https://storage.googleapis.com/duocsi-circa-vn/care-proof/' || i.task_id::text || '/') + 1)
--            !~ '^[0-9]{13}_[0-9a-f]{8}[.](jpg|png|webp|heic|heif)$';
-- 17) B4 r1.1 (Q-82) — đúng bản (kỳ vọng t, t, 41, f, t, t): ghi lượt + policy task so store với care_staff_store_id():
--    SELECT position('care_staff_store_id' in pg_get_functiondef('public.care__record_interaction_at(date,uuid,text,text,date,jsonb)'::regprocedure)) > 0 AS rpc_q82,
--           (SELECT qual ~ 'care_staff_store_id' FROM pg_policies WHERE schemaname = 'public' AND policyname = 'care_tasks_select') AS policy_q82,
--           (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'care%') AS n_fn,
--           has_function_privilege('anon', 'public.care_staff_store_id()', 'EXECUTE') AS anon_x,
--           has_function_privilege('authenticated', 'public.care_staff_store_id()', 'EXECUTE') AS auth_x,
--           has_function_privilege('service_role', 'public.care_staff_store_id()', 'EXECUTE') AS svc_x;
--    Giám sát (B6, chạy cùng VERIFY 13 — 13 bắt assignee đổi role, 17 bắt assignee lệch store):
--    Sau khi có dữ liệu — task mở có assignee KHÔNG còn ở đúng store task (staff chuyển/tháo store, store
--    ngừng; dược sĩ mất quyền đọc/ghi ⇒ SM/super chuyển giao thủ công Q-80; kỳ vọng 0 dòng):
--    SELECT t.store_id, t.assignee_id, u.store_id AS user_store, count(*) FROM public.care_tasks t
--    JOIN public.users u ON u.id = t.assignee_id LEFT JOIN public.stores s ON s.id = t.store_id
--    WHERE t.status = 'open' AND NOT t.is_test
--      AND (u.store_id IS DISTINCT FROM t.store_id OR s.store_type IS DISTINCT FROM 'os' OR NOT COALESCE(s.is_active, false))
--    GROUP BY 1, 2, 3;
-- 18) B5a — attribution + trạng thái đơn (kỳ vọng t, t, f, f, t, f, 0):
--    SELECT to_regprocedure('public.care_recompute_attribution(text[],text[])') IS NOT NULL AS has_recompute,
--           has_function_privilege('service_role', 'public.care_recompute_attribution(text[],text[])', 'EXECUTE') AS svc_x,
--           has_function_privilege('authenticated', 'public.care_recompute_attribution(text[],text[])', 'EXECUTE') AS auth_x,
--           has_function_privilege('anon', 'public.care_order_sync_status()', 'EXECUTE') AS anon_status_x,
--           has_function_privilege('authenticated', 'public.care_order_sync_status()', 'EXECUTE') AS auth_status_x,
--           has_table_privilege('authenticated', 'public.care_orders', 'INSERT') AS auth_orders_ins,
--           (SELECT count(*) FROM public.care_order_attributions) AS n_attr;          -- 0 trước đồng bộ B5b
--    Sau khi có đơn — attribution lệch quy tắc (kỳ vọng 0 dòng): lượt không terminal, lượt không trước
--    ordered_at, khác khách, hoặc snapshot lệch lượt:
--    SELECT count(*) FROM public.care_order_attributions a
--    JOIN public.care_orders o ON o.order_key = a.order_key
--    JOIN public.care_interactions i ON i.id = a.interaction_id
--    JOIN public.care_customers c ON c.id = i.customer_id
--    WHERE NOT i.is_terminal OR i.created_at >= o.ordered_at OR c.external_id <> o.customer_external_id
--       OR a.task_id <> i.task_id OR a.assignee_id <> i.assignee_id OR a.store_id <> i.store_id
--       OR a.period_month <> i.period_month;
-- 18c) B5a r1.1 (Q-91) — schema N3 ba cột + index (kỳ vọng 3 dòng đúng như chú thích; t; f):
--    SELECT c.relname, string_agg(a.attname::text, ',' ORDER BY a.attname::text COLLATE "C")
--    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
--    WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('care_orders', 'care_order_attributions', 'care_sync_state')
--      AND a.attnum > 0 AND NOT a.attisdropped
--    GROUP BY 1 ORDER BY 1;
--    -- care_order_attributions: assignee_id,computed_at,customer_id,interaction_id,is_test,order_key,period_month,store_id,task_id
--    -- care_orders:             customer_external_id,order_key,ordered_at,synced_at
--    -- care_sync_state:         last_error,last_success_at,source,updated_at
--    SELECT to_regclass('public.care_attr_customer_idx') IS NOT NULL AS has_customer_idx,
--           pg_get_function_result('public.care_report(date,uuid[],boolean)'::regprocedure) ~ '(orders|net_revenue)' AS report_has_money;
--    Sau B5b — last_error chỉ là MÃ lỗi (kỳ vọng 0 dòng; CHECK đã chặn, đây là kiểm chéo):
--    SELECT source FROM public.care_sync_state WHERE last_error !~ '^[A-Z][A-Z0-9_]{0,63}$';
-- 18d) Sau mỗi lần đồng bộ (B5b/B6) — attribution thực tế vs quy tắc (kỳ vọng 0, 0, 0):
--    WITH desired AS (
--      SELECT o.order_key, w.id AS interaction_id, w.task_id, w.customer_id, w.assignee_id, w.store_id,
--             w.period_month, w.is_test
--      FROM public.care_orders o
--      JOIN public.care_customers c ON c.external_id = o.customer_external_id
--      CROSS JOIN LATERAL (
--        SELECT i.id, i.task_id, i.customer_id, i.assignee_id, i.store_id, i.period_month, i.is_test
--        FROM public.care_interactions i
--        WHERE i.customer_id = c.id AND i.is_terminal AND i.created_at < o.ordered_at
--        ORDER BY i.created_at DESC, i.id DESC LIMIT 1) w
--    )
--    SELECT count(*) FILTER (WHERE a.order_key IS NULL) AS missing,
--           count(*) FILTER (WHERE d.order_key IS NULL) AS extra,
--           count(*) FILTER (WHERE a.order_key IS NOT NULL AND d.order_key IS NOT NULL
--             AND (a.interaction_id, a.task_id, a.customer_id, a.assignee_id, a.store_id, a.period_month, a.is_test)
--                 IS DISTINCT FROM (d.interaction_id, d.task_id, d.customer_id, d.assignee_id, d.store_id, d.period_month, d.is_test)) AS drift
--    FROM desired d FULL JOIN public.care_order_attributions a ON a.order_key = d.order_key;
-- 18e) Sau B5b — care_order_sync_apply xoá queue enqueued_at ≤ snapshot ⇒ queue tồn trước lần đồng bộ thành
--     công cuối (kỳ vọng 0, hoặc vài dòng tạm thời: lượt Hoàn thành mở transaction trước snapshot nhưng commit
--     sau DELETE — vô hại vì candidates không đọc queue; lần đồng bộ sau dọn):
--    SELECT count(*) AS stale_queue FROM public.care_reconcile_queue q, public.care_sync_state s
--    WHERE s.source = 'n3_orders' AND q.enqueued_at < s.last_success_at;
-- 19) B5b.2 — RPC đồng bộ chỉ service_role (kỳ vọng 3 dòng: f, f, t, t):
--    SELECT p.oid::regprocedure, has_function_privilege('anon', p.oid, 'EXECUTE') anon_x,
--      has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x,
--      has_function_privilege('service_role', p.oid, 'EXECUTE') svc_x, p.prosecdef
--    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('care_order_sync_candidates', 'care_order_sync_apply', 'care_order_sync_fail') ORDER BY 1;
--    Ứng viên hiện tại (chỉ số đếm, không ID — chạy bằng service role/pg-meta):
--    SELECT (r->>'windows')::int AS windows, (r->>'customers')::int AS customers, r->>'snapshot_at' AS snapshot_at,
--           jsonb_array_length(r->'items') AS items_returned
--    FROM (SELECT public.care_order_sync_candidates(20000) AS r) x;
--    Trạng thái đồng bộ (không lỗi thô — chỉ mã): SELECT source, last_success_at, last_error, updated_at
--    FROM public.care_sync_state;
--    Giám sát Q-98: windows > 15000 ⇒ báo PM trước khi chạm trần 20000 (CANDIDATES_OVER_CAP dừng cả lượt).
-- 20) Collation (db-reviewer P0 B5b.2): kiểm key của apply KHÔNG phụ thuộc thứ tự sắp xếp — prod en_US.UTF-8
--     xếp 'ordered_at' trước 'order_key'. Kỳ vọng: would_reject = f; sorted_default chỉ để thấy khác biệt;
--     has_set_check = t; has_sorted_check = f. Chạy bằng Studio/pg-meta — client JDBC (DBeaver…) có thể hiểu
--     toán tử ?& là placeholder:
--    SELECT NOT (j ?& ARRAY['customer_external_id', 'order_key', 'ordered_at'])
--             OR (SELECT count(*) FROM jsonb_object_keys(j)) <> 3 AS would_reject,
--           (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(j) k) AS sorted_default,
--           position('?& ARRAY[''customer_external_id'', ''order_key'', ''ordered_at'']' IN d) > 0 AS has_set_check,
--           position('array_agg(k ORDER BY k)' IN d) > 0 AS has_sorted_check
--    FROM (SELECT '{"order_key":"x","ordered_at":"y","customer_external_id":"z"}'::jsonb AS j,
--                 pg_get_functiondef('public.care_order_sync_apply(jsonb,timestamptz)'::regprocedure) AS d) x;
-- 21) Q-105 — quyền cột care_customers (kỳ vọng: authenticated chỉ t ở id/is_test/created_at; external_id f;
--     anon f hết; service_role t hết; tbl_auth = f):
--    SELECT a.attname, has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT') auth,
--           has_column_privilege('anon', a.attrelid, a.attnum, 'SELECT') anon,
--           has_column_privilege('service_role', a.attrelid, a.attnum, 'SELECT') svc,
--           has_table_privilege('authenticated', 'public.care_customers', 'SELECT') tbl_auth
--    FROM pg_attribute a WHERE a.attrelid = 'public.care_customers'::regclass AND a.attnum > 0 AND NOT a.attisdropped
--    ORDER BY a.attnum;
--    ACL bảng (kỳ vọng 0 dòng): SELECT x.* FROM pg_class c, aclexplode(c.relacl) x
--    WHERE c.oid = 'public.care_customers'::regclass AND x.privilege_type = 'SELECT'
--      AND x.grantee IN (0::oid, 'authenticated'::regrole::oid, 'anon'::regrole::oid);
--    Hành vi (kỳ vọng 42501 "permission denied" cho CẢ HAI): BEGIN; SET LOCAL ROLE authenticated;
--      SELECT external_id FROM public.care_customers LIMIT 1;  -- rồi ROLLBACK; lặp lại với SELECT * ...
