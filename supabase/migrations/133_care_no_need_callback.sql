-- ============================================================================
-- 133_care_no_need_callback.sql — CRM-CSKH: "Đã liên hệ – chưa có nhu cầu" (NO_NEED) chuyển sang nhóm CẦN LIÊN HỆ LẠI
--                                  + danh sách lựa chọn bộ lọc Lý do của /care/tasks
-- Chạy SAU 132 (bản mới nhất trên prod 22/11/2026). Nền CRM: 114 / 115 / 116.
--
-- Contract: planning/reviews/2026-11-22-cskh-hen-tu-choi-ly-do-pm.md §1 + §3 (PM GO một batch, 22/11/2026).
--
-- Nội dung (KHÔNG bảng / cột / policy / trigger mới, KHÔNG sửa dữ liệu):
--   1. CREATE OR REPLACE public.care_is_terminal_outcome(text)   — tập kết thúc còn INTERESTED / ORDERED / REFUSED (bỏ NO_NEED).
--   2. CREATE OR REPLACE public.care_outcome_requires_date(text) — tập bắt buộc ngày hẹn = UNREACHABLE / NO_NEED / CALLBACK.
--      care__record_interaction_at (114) đã đọc hai helper này ⇒ KHÔNG sửa RPC: lượt NO_NEED MỚI bắt buộc ngày hẹn trong
--      [hôm nay VN, hạn task], ghi is_terminal = false, task còn 'open' (hiển thị "Đang theo dõi"), không vào hàng đợi ghi công.
--   3. CREATE public.care_reason_options(date, boolean) — khoá lý do chuẩn hoá lower(btrim(reason_type)) của sản phẩm HIỆN HÀNH
--      trong kỳ + một nguyên văn theo file để hiển thị (lựa chọn của bộ lọc Lý do).
--   4. CREATE public.care_tasks_by_reason(date, text, boolean) RETURNS SETOF care_tasks — task trong kỳ có ≥ 1 sản phẩm hiện hành
--      thuộc lý do (lọc TRƯỚC phân trang; app áp tiếp các bộ lọc cột / tìm / đếm trên kết quả).
--      Hai hàm 3–4 là SECURITY DEFINER STABLE SET search_path = public với PHẠM VI TƯỜNG MINH chép nguyên điều kiện của policy
--      care_tasks_select (114): xem toàn chuỗi · dược sĩ = task giao mình ở đúng store hiện tại · SM = store trong scope — mỗi
--      helper là InitPlan (tính MỘT lần / truy vấn). Lý do không dùng SECURITY INVOKER: policy care_task_products_select gọi
--      care_can_read_task(task_id) theo TỪNG DÒNG sản phẩm với SM / dược sĩ — đo chỉ đọc trên prod 22/11/2026, SM 10 cửa hàng
--      (3.805 task kỳ 11): ~18–20 s cho MỘT truy vấn, so với ~35–100 ms khi phạm vi tính một lần. Phạm vi trả về KHÔNG rộng hơn
--      RLS (qa-care-133 so từng vai với tập đọc qua RLS). PM duyệt 23/11/2026 (audit candidate r1 §3, §4 d): caller của hai hàm
--      là SESSION app ⇒ ma trận EXECUTE: authenticated ✓ · PUBLIC / anon / service_role ✗. Hai helper outcome giữ ma trận 114
--      (authenticated ✓ · service_role ✓ · anon ✗).
--      PHỤ THUỘC (PM 23/11 §4 b, c): (1) hai hàm tự giới hạn quyền THAY RLS ⇒ migration nào sửa policy care_tasks_select PHẢI sửa
--      cả hai hàm trong cùng migration; (2) care_tasks_by_reason trả SETOF care_tasks trong phạm vi quyền SELECT toàn bảng của
--      authenticated — nếu sau này đổi sang cấp quyền theo CỘT thì phải đổi hàm sang RETURNS TABLE ít cột; (3) hai hàm đọc
--      care_task_products KHÔNG qua RLS của bảng đó — hiện bằng RLS vì care_task_products_select = care_can_read_task (cùng phạm vi
--      với care_tasks_select); migration nào THU HẸP policy đó / care_can_read_task cũng phải sửa hai hàm.
--
-- KHÔNG BACKFILL (chủ ý): care_interactions.is_terminal là giá trị ĐÃ LƯU lúc ghi ⇒ lượt NO_NEED cũ vẫn là lượt kết thúc, task đã
--   Hoàn thành giữ nguyên, ghi công (attribution theo is_terminal đã lưu) không đổi. Chỉ lượt ghi SAU migration theo luật mới.
--
-- Phối hợp với app: bảng outcome phía TS (webapp/lib/care/outcome.ts) phải đổi CÙNG đợt. Trong khoảng lệch giữa chạy 133 và deploy
--   app: app cũ gửi NO_NEED không kèm ngày ⇒ RPC từ chối "bắt buộc ngày hẹn" (báo lỗi rõ, KHÔNG ghi sai dữ liệu); app mới trên DB
--   cũ gửi NO_NEED kèm ngày ⇒ RPC từ chối "không nhận ngày hẹn". Chạy giờ vắng, 133 trước rồi deploy ngay.
--
-- Idempotent: chạy lại an toàn (CREATE OR REPLACE, REVOKE / GRANT lặp lại được, ON CONFLICT DO NOTHING).
-- Preflight: app_migrations có 116 + 132, không có bản số > 133; current_user là owner của hai helper; bảng chân trị của hai helper
--   đang ở ĐÚNG trạng thái 114 hoặc ĐÚNG trạng thái 133 (trạng thái lạ ⇒ dừng); policy đọc của care_tasks là care_tasks_select duy
--   nhất với ĐÚNG NGUYÊN biểu thức USING đã duyệt ở 114 (so chuỗi, không chỉ tìm tên helper).
--
-- ROLLBACK: supabase/migrations/rollback/133_care_no_need_callback_rollback.sql — trả hai helper về nguyên văn 114, DROP
--   care_reason_options + care_tasks_by_reason, DELETE FROM app_migrations WHERE version = '133'. Rollback TỪ CHỐI khi đã có lượt NO_NEED kiểu mới
--   (is_terminal = false): các task đó đang mở kèm ngày hẹn — quay về luật cũ phải do PM quyết cách xử lý dữ liệu trước.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';
-- Chặn lượt ghi đang chạy dở qua thời điểm đổi luật (db-reviewer P2-1): care__record_interaction_at đọc care_outcome_requires_date
-- TRƯỚC và care_is_terminal_outcome SAU trong cùng một lời gọi; nó khoá dòng task FOR UPDATE ⇒ EXCLUSIVE trên care_tasks buộc mọi
-- lượt ghi / import / chuyển giao xong hẳn hoặc chờ tới sau COMMIT (vài ms; ĐỌC không bị chặn). Quá 3 s không lấy được khoá ⇒ lỗi, chạy lại.
LOCK TABLE public.care_tasks IN EXCLUSIVE MODE;

-- ── Preflight ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_me   oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);
  v_t    boolean;
  v_d    boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '116' AND name = 'care_order_links') THEN
    RAISE EXCEPTION '133: thiếu migration nền CRM 116 care_order_links';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '132') THEN
    RAISE EXCEPTION '133: thiếu migration 132 — chạy đúng thứ tự';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 133) THEN
    RAISE EXCEPTION '133: DB đã có migration số > 133 — dừng';
  END IF;
  IF to_regprocedure('public.care_is_terminal_outcome(text)') IS NULL OR to_regprocedure('public.care_outcome_requires_date(text)') IS NULL
     OR to_regprocedure('public.care__record_interaction_at(date, uuid, text, text, date, jsonb)') IS NULL THEN
    RAISE EXCEPTION '133: thiếu hàm nền 114 (care_is_terminal_outcome / care_outcome_requires_date / care__record_interaction_at)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.oid IN ('public.care_is_terminal_outcome(text)'::regprocedure, 'public.care_outcome_requires_date(text)'::regprocedure)
                AND p.proowner <> v_me) THEN
    RAISE EXCEPTION '133: role chạy migration (%) không phải owner của hai helper outcome', current_user;
  END IF;
  -- Hàm cùng tên care_reason_options với chữ ký KHÁC ⇒ dừng (không tạo overload mơ hồ cho PostgREST).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'care_reason_options'
              AND p.oid IS DISTINCT FROM to_regprocedure('public.care_reason_options(date, boolean)')) THEN
    RAISE EXCEPTION '133: đã có care_reason_options với chữ ký khác — dừng';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'care_tasks_by_reason'
              AND p.oid IS DISTINCT FROM to_regprocedure('public.care_tasks_by_reason(date, text, boolean)')) THEN
    RAISE EXCEPTION '133: đã có care_tasks_by_reason với chữ ký khác — dừng';
  END IF;
  -- Helper phạm vi của 114 mà hai hàm lọc lý do dùng (cùng bộ với policy care_tasks_select).
  IF to_regprocedure('public.care_can_view_all()') IS NULL OR to_regprocedure('public.care_scope_store_ids()') IS NULL
     OR to_regprocedure('public.care_assignee_uid()') IS NULL OR to_regprocedure('public.care_staff_store_id()') IS NULL
     OR to_regprocedure('public.care_period_of(date)') IS NULL THEN
    RAISE EXCEPTION '133: thiếu helper phạm vi của 114 (care_can_view_all / care_scope_store_ids / care_assignee_uid / care_staff_store_id / care_period_of)';
  END IF;
  -- Policy care_tasks_select phải ĐÚNG NGUYÊN biểu thức USING đã duyệt ở 114: hai hàm lọc lý do chép điều kiện đó và tự giới hạn quyền
  -- THAY RLS ⇒ policy đổi điều kiện (kể cả khi vẫn nhắc đủ bốn helper) mà hàm không đổi theo = lệch phạm vi ⇒ dừng (PM 23/11 §4 c).
  -- So chuỗi qual do PG deparse, sau khi bỏ khoảng trắng và tiền tố "public." (tiền tố có / không tuỳ search_path của phiên chạy).
  -- Giá trị chuẩn = nguyên văn trên prod (PG 15.8, đọc 23/11/2026); PGlite 16 cho cùng chuỗi (qa-care-133). Cũng dừng khi care_tasks
  -- có thêm policy đọc khác (kể cả RESTRICTIVE / FOR ALL), policy không còn PERMISSIVE hoặc không còn đúng role authenticated.
  IF (SELECT count(*) FROM pg_catalog.pg_policies pol WHERE pol.schemaname = 'public' AND pol.tablename = 'care_tasks' AND pol.cmd IN ('SELECT', 'ALL')) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies pol
                     WHERE pol.schemaname = 'public' AND pol.tablename = 'care_tasks' AND pol.policyname = 'care_tasks_select' AND pol.cmd = 'SELECT'
                       AND pol.permissive = 'PERMISSIVE' AND pol.roles = ARRAY['authenticated']::name[]
                       AND regexp_replace(replace(pol.qual, 'public.', ''), '[[:space:]]+', '', 'g')
                           = '(((assignee_id=(SELECTcare_assignee_uid()AScare_assignee_uid))AND(store_id=(SELECTcare_staff_store_id()AScare_staff_store_id)))OR(SELECTcare_can_view_all()AScare_can_view_all)OR(store_id=ANY((SELECTcare_scope_store_ids()AScare_scope_store_ids)::uuid[])))') THEN
    RAISE EXCEPTION '133: policy đọc của care_tasks không còn đúng nguyên biểu thức 114 (care_tasks_select duy nhất, PERMISSIVE, authenticated) — dừng, đối chiếu rồi sửa cả hai hàm lý do';
  END IF;
  -- Năm outcome còn lại + giá trị lạ / NULL phải đúng như 114 (133 KHÔNG đổi chúng).
  IF NOT (public.care_is_terminal_outcome('INTERESTED') AND public.care_is_terminal_outcome('ORDERED') AND public.care_is_terminal_outcome('REFUSED')
          AND NOT public.care_is_terminal_outcome('UNREACHABLE') AND NOT public.care_is_terminal_outcome('CALLBACK')
          AND NOT public.care_is_terminal_outcome('zz') AND NOT public.care_is_terminal_outcome(NULL)
          AND public.care_outcome_requires_date('UNREACHABLE') AND public.care_outcome_requires_date('CALLBACK')
          AND NOT public.care_outcome_requires_date('INTERESTED') AND NOT public.care_outcome_requires_date('ORDERED')
          AND NOT public.care_outcome_requires_date('REFUSED') AND NOT public.care_outcome_requires_date('zz')
          AND NOT public.care_outcome_requires_date(NULL)) THEN
    RAISE EXCEPTION '133: bảng chân trị hai helper outcome không ở trạng thái 114 / 133 — dừng, đối chiếu thân hàm trước';
  END IF;
  -- NO_NEED: (kết thúc, không ngày) = 114 · (còn mở, có ngày) = 133. Hai tổ hợp còn lại là trạng thái dở ⇒ dừng.
  v_t := public.care_is_terminal_outcome('NO_NEED');
  v_d := public.care_outcome_requires_date('NO_NEED');
  IF v_t = v_d THEN
    RAISE EXCEPTION '133: NO_NEED đang ở trạng thái dở (terminal = %, requires_date = %) — dừng', v_t, v_d;
  END IF;
END $$;

-- ── 1–2. Hai helper outcome (PARITY với webapp/lib/care/outcome.ts — spec + qa-care-133 ép khớp) ───────────────
-- PM 22/11/2026: NO_NEED không còn kết thúc task. Giá trị lạ / NULL ⇒ false (fail-closed).
CREATE OR REPLACE FUNCTION public.care_is_terminal_outcome(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p IN ('INTERESTED', 'ORDERED', 'REFUSED'), false)
$$;

-- PM 22/11/2026: NO_NEED bắt buộc ngày hẹn như CALLBACK (Q-48) / UNREACHABLE.
CREATE OR REPLACE FUNCTION public.care_outcome_requires_date(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p IN ('UNREACHABLE', 'NO_NEED', 'CALLBACK'), false)
$$;

-- ── 3. Lựa chọn bộ lọc "Lý do" của /care/tasks ───────────────────────────────────────────────────────────────
-- SECURITY DEFINER + PHẠM VI TƯỜNG MINH = nguyên điều kiện USING của policy care_tasks_select (114): Marketing / super toàn
-- chuỗi, SM theo store trong scope, dược sĩ task giao mình ở đúng store hiện tại; vai khác (QLCH, FS, anon, service_role không
-- có auth.uid()) ⇒ 0 dòng. Mỗi helper nằm trong (select …) ⇒ InitPlan, tính một lần. Không PII: chỉ trả chữ lý do theo file
-- (≤ 50 ký tự). p_is_test: production gọi false (loại dữ liệu thử); QA local gọi true. Kỳ chuẩn hoá về đầu tháng (care_period_of).
-- reason_label: biến thể nhỏ nhất theo thứ tự byte (COLLATE "C") — khớp phép chọn của app (careTaskReasons).
CREATE OR REPLACE FUNCTION public.care_reason_options(p_period date, p_is_test boolean DEFAULT false)
RETURNS TABLE (reason_key text, reason_label text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT lower(btrim(p.reason_type)) AS reason_key, min(btrim(p.reason_type) COLLATE "C") AS reason_label
  FROM public.care_tasks t
  JOIN public.care_task_products p ON p.task_id = t.id
  WHERE t.period_month = public.care_period_of(p_period)
    AND t.is_test = COALESCE(p_is_test, false)
    AND ((t.assignee_id = (select public.care_assignee_uid()) AND t.store_id = (select public.care_staff_store_id()))
         OR (select public.care_can_view_all())
         OR t.store_id = ANY ((select public.care_scope_store_ids())::uuid[]))
    AND p.is_current
    AND btrim(p.reason_type) <> ''
  GROUP BY 1
  ORDER BY 1
$$;

-- ── 4. Task của kỳ theo MỘT lý do (lọc trước phân trang của /care/tasks) ─────────────────────────────────────────
-- Trả nguyên dòng care_tasks (authenticated đã có SELECT toàn bảng — 114; phạm vi dòng do điều kiện bên dưới, GIỐNG policy) ⇒
-- PostgREST lọc / sắp / đếm / phân trang tiếp trên kết quả như trên bảng. Mỗi task tối đa một dòng (EXISTS). So lý do bằng CÙNG
-- phép chuẩn hoá lower(btrim(…)) với care_reason_options và app (careReasonKey). Lý do rỗng / NULL ⇒ 0 dòng (không trả cả kỳ).
CREATE OR REPLACE FUNCTION public.care_tasks_by_reason(p_period date, p_reason text, p_is_test boolean DEFAULT false)
RETURNS SETOF public.care_tasks
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.*
  FROM public.care_tasks t
  WHERE t.period_month = public.care_period_of(p_period)
    AND t.is_test = COALESCE(p_is_test, false)
    AND btrim(COALESCE(p_reason, '')) <> ''
    AND ((t.assignee_id = (select public.care_assignee_uid()) AND t.store_id = (select public.care_staff_store_id()))
         OR (select public.care_can_view_all())
         OR t.store_id = ANY ((select public.care_scope_store_ids())::uuid[]))
    AND EXISTS (SELECT 1 FROM public.care_task_products p
                 WHERE p.task_id = t.id AND p.is_current AND lower(btrim(p.reason_type)) = lower(btrim(p_reason)))
$$;

-- ── Quyền — REVOKE đích danh rồi GRANT đúng role (AGENTS.md §4.2; default privileges của prod tự cấp anon / authenticated) ──
REVOKE ALL ON FUNCTION
  public.care_is_terminal_outcome(text), public.care_outcome_requires_date(text), public.care_reason_options(date, boolean),
  public.care_tasks_by_reason(date, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
-- Hai helper outcome: giữ ma trận 114 (RPC ghi lượt chạy dưới authenticated; job dùng service_role).
GRANT EXECUTE ON FUNCTION public.care_is_terminal_outcome(text), public.care_outcome_requires_date(text)
  TO authenticated, service_role;
-- Hai RPC lý do: caller là session app ⇒ CHỈ authenticated (PM 23/11 §4 d); service_role không có auth.uid() nên cũng không dùng được.
GRANT EXECUTE ON FUNCTION public.care_reason_options(date, boolean), public.care_tasks_by_reason(date, text, boolean)
  TO authenticated;

-- ── Hậu kiểm trong transaction (lệch ⇒ ROLLBACK cả migration) ────────────────────────────────────────────────
DO $$
DECLARE
  v_bad text;
BEGIN
  -- Bảng chân trị đủ 6 outcome + lạ + NULL.
  SELECT string_agg(x.o, ', ') INTO v_bad
  FROM (VALUES ('UNREACHABLE', false, true), ('NO_NEED', false, true), ('INTERESTED', true, false), ('CALLBACK', false, true),
               ('ORDERED', true, false), ('REFUSED', true, false), ('zz', false, false), (NULL, false, false)) AS x(o, t, d)
  WHERE public.care_is_terminal_outcome(x.o) IS DISTINCT FROM x.t OR public.care_outcome_requires_date(x.o) IS DISTINCT FROM x.d;
  IF v_bad IS NOT NULL OR public.care_is_terminal_outcome(NULL) IS DISTINCT FROM false THEN
    RAISE EXCEPTION '133 hậu kiểm: bảng chân trị outcome sai (%)', v_bad;
  END IF;
  -- Thuộc tính hàm: hai helper outcome IMMUTABLE, KHÔNG definer; hai hàm lý do STABLE + SECURITY DEFINER + search_path cố định.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.oid IN ('public.care_is_terminal_outcome(text)'::regprocedure, 'public.care_outcome_requires_date(text)'::regprocedure,
                              'public.care_reason_options(date, boolean)'::regprocedure, 'public.care_tasks_by_reason(date, text, boolean)'::regprocedure)
                AND (p.prosecdef IS DISTINCT FROM (p.proname IN ('care_reason_options', 'care_tasks_by_reason'))
                     OR p.provolatile <> CASE WHEN p.proname IN ('care_reason_options', 'care_tasks_by_reason') THEN 's' ELSE 'i' END
                     OR (p.proname IN ('care_reason_options', 'care_tasks_by_reason') AND NOT COALESCE(p.proconfig @> ARRAY['search_path=public'], false)))) THEN
    RAISE EXCEPTION '133 hậu kiểm: thuộc tính hàm sai (definer / volatility / search_path)';
  END IF;
  -- Gate ACL (PM 25/10, SEC-1 + PM 23/11 §4 d) — ma trận tường minh: anon ✗ ×4 · authenticated ✓ ×4 · service_role ✓ CHỈ hai helper
  -- outcome, ✗ hai RPC lý do · PUBLIC không có EXECUTE.
  SELECT string_agg(f.sig || ':' || r.rolname, ', ') INTO v_bad
  FROM (VALUES ('public.care_is_terminal_outcome(text)', true), ('public.care_outcome_requires_date(text)', true),
               ('public.care_reason_options(date, boolean)', false), ('public.care_tasks_by_reason(date, text, boolean)', false)) AS f(sig, svc)
  CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(rolname)
  WHERE pg_catalog.has_function_privilege(r.rolname, f.sig, 'EXECUTE')
        IS DISTINCT FROM (CASE r.rolname WHEN 'anon' THEN false WHEN 'authenticated' THEN true ELSE f.svc END);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '133 hậu kiểm: ma trận EXECUTE sai (%)', v_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(p.proacl) a
              WHERE p.oid IN ('public.care_is_terminal_outcome(text)'::regprocedure, 'public.care_outcome_requires_date(text)'::regprocedure,
                              'public.care_reason_options(date, boolean)'::regprocedure, 'public.care_tasks_by_reason(date, text, boolean)'::regprocedure)
                AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION '133 hậu kiểm: PUBLIC còn EXECUTE';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('133', 'care_no_need_callback',
        'CRM-CSKH PM 22/11/2026: NO_NEED sang nhom can lien he lai (care_is_terminal_outcome bo NO_NEED, care_outcome_requires_date them'
        || ' NO_NEED; khong backfill is_terminal da luu) + care_reason_options(date, boolean) + care_tasks_by_reason(date, text, boolean)'
        || ' SECURITY DEFINER pham vi tuong minh = policy care_tasks_select, cho bo loc Ly do /care/tasks. Khong bang / cot / policy moi.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ── PRE (chạy TRƯỚC 133, CHỈ ĐỌC — lưu kết quả để so V4) ───────────────────────────────────────────────────────
-- P1) SELECT count(*) FILTER (WHERE outcome = 'NO_NEED' AND is_terminal) AS no_need_ket_thuc_truoc,
--            count(*) FILTER (WHERE outcome = 'NO_NEED' AND NOT is_terminal) AS no_need_mo_truoc      -- kỳ vọng cột 2 = 0
--       FROM public.care_interactions;
-- P2) SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, md5(replace(p.prosrc, E'\r', '')) AS md5_no_cr FROM pg_proc p
--      WHERE p.oid IN ('public.care_is_terminal_outcome(text)'::regprocedure, 'public.care_outcome_requires_date(text)'::regprocedure) ORDER BY 1;
--     -- nền 114: care_is_terminal_outcome 8036bc4e30827bf25723df1ae314f878 · care_outcome_requires_date c79e0cd839a9014903ce07060d5653c7

-- ── VERIFY (chạy sau COMMIT, CHỈ ĐỌC — bọc BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;) ──────────────────────
-- V1) SELECT version, name FROM public.app_migrations WHERE version IN ('132', '133') ORDER BY 1;                 -- 2 dòng
-- V2) SELECT o, public.care_is_terminal_outcome(o) AS terminal, public.care_outcome_requires_date(o) AS requires_date
--       FROM unnest(ARRAY['UNREACHABLE','NO_NEED','INTERESTED','CALLBACK','ORDERED','REFUSED']) o;
--     -- kỳ vọng: UNREACHABLE f/t · NO_NEED f/t · INTERESTED t/f · CALLBACK f/t · ORDERED t/f · REFUSED t/f
-- V3) SELECT p.oid::regprocedure AS fn, p.prosecdef, p.provolatile, p.proconfig,
--            md5(replace(p.prosrc, E'\r', '')) AS md5_no_cr,
--            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
--            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
--            has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
--       FROM pg_proc p
--      WHERE p.oid IN ('public.care_is_terminal_outcome(text)'::regprocedure, 'public.care_outcome_requires_date(text)'::regprocedure,
--                      'public.care_reason_options(date, boolean)'::regprocedure,
--                      'public.care_tasks_by_reason(date, text, boolean)'::regprocedure) ORDER BY 1;
--     -- kỳ vọng: prosecdef f / f / t / t (helper outcome KHÔNG definer; hai hàm lý do definer + proconfig {search_path=public})
--     --          volatility i / i / s / s · anon f ×4 · authenticated t ×4 · service_role t / t / f / f (hai RPC lý do chỉ authenticated)
--     --          md5_no_cr hai helper: care_is_terminal_outcome 3c4c97d4dd22e778d7e49720662e0714 · care_outcome_requires_date 1b16135c91217efda330c9085eb86b76
-- V4) SELECT count(*) FILTER (WHERE outcome = 'NO_NEED' AND is_terminal) AS no_need_cu_ket_thuc,
--            count(*) FILTER (WHERE outcome = 'NO_NEED' AND NOT is_terminal) AS no_need_moi_con_mo
--       FROM public.care_interactions;      -- ngay sau migration: cột thứ hai = 0; cột thứ nhất = P1.no_need_ket_thuc_truoc (không đổi)
-- V5) SELECT count(*) FROM public.care_interactions WHERE outcome = 'NO_NEED' AND NOT is_terminal AND next_action_date IS NULL;
--     -- LUÔN = 0 (lượt NO_NEED còn mở mà không có ngày hẹn = dấu hiệu lượt ghi vắt qua thời điểm đổi luật)
-- V6) Phạm vi hai hàm lý do = ĐÚNG tập đọc qua RLS — so TẬP ID HAI CHIỀU (PM 23/11 §4 e), cùng kỳ / lý do / is_test, dưới session bị
--     giới hạn. Lặp cho từng vai: một SM, một dược sĩ, một Marketing / super, một QLCH (thay <UID>) × từng lý do. KHÔNG viết cứng
--     khoá: lấy <KEY> từ care_reason_options('2026-11-01', false) dưới vai super (khoá có dữ liệu thật) rồi thay 'chronic' ở HAI chỗ:
--       BEGIN; SET TRANSACTION READ ONLY; SET LOCAL ROLE authenticated;
--       SELECT set_config('request.jwt.claim.sub', '<UID>', true), set_config('request.jwt.claims', '{"sub":"<UID>","role":"authenticated"}', true);
--       WITH f AS (SELECT id FROM public.care_tasks_by_reason('2026-11-01', 'chronic', false)),
--            r AS (SELECT t.id FROM public.care_tasks t
--                   WHERE t.period_month = '2026-11-01' AND t.is_test = false
--                     AND EXISTS (SELECT 1 FROM public.care_task_products p
--                                  WHERE p.task_id = t.id AND p.is_current AND lower(btrim(p.reason_type)) = 'chronic'))
--       SELECT (SELECT count(*) FROM f) AS qua_ham, (SELECT count(*) FROM r) AS qua_rls,
--              (SELECT count(*) FROM (SELECT id FROM f EXCEPT SELECT id FROM r) x) AS ham_tru_rls,
--              (SELECT count(*) FROM (SELECT id FROM r EXCEPT SELECT id FROM f) x) AS rls_tru_ham;
--       ROLLBACK;
--     -- kỳ vọng MỌI vai: ham_tru_rls = 0 VÀ rls_tru_ham = 0 (qua_ham = qua_rls); QLCH / tài khoản không có quyền CRM: cả hai tập rỗng.
--     -- Phép so chỉ có nghĩa khi tập KHÔNG rỗng: super, SM và dược sĩ được chọn phải có qua_ham > 0 với ít nhất một khoá (0 = 0 ở mọi
--     -- vai ⇒ CHƯA đạt, chọn lại khoá / tài khoản).
--     -- Vế r đọc sản phẩm dưới RLS từng dòng ⇒ với SM có thể mất ~20 s (chính là lý do có hai hàm này) — chạy từng vai một.
--     Danh sách lựa chọn — cùng khung BEGIN / ROLE / claims, từng vai:
--       WITH f AS (SELECT reason_key k FROM public.care_reason_options('2026-11-01', false)),
--            r AS (SELECT DISTINCT lower(btrim(p.reason_type)) k FROM public.care_tasks t JOIN public.care_task_products p ON p.task_id = t.id
--                   WHERE t.period_month = '2026-11-01' AND NOT t.is_test AND p.is_current AND btrim(p.reason_type) <> '')
--       SELECT (SELECT count(*) FROM f) AS n_f, (SELECT count(*) FROM r) AS n_r,
--              (SELECT count(*) FROM (SELECT k FROM f EXCEPT SELECT k FROM r) x) AS f_tru_r,
--              (SELECT count(*) FROM (SELECT k FROM r EXCEPT SELECT k FROM f) x) AS r_tru_f;      -- 0 / 0, n_f = n_r; super: n_f > 0
-- V7) Quyền gọi qua vai DB (bổ sung V3) — BỐN khối RIÊNG (lỗi đầu tiên huỷ transaction nên không gộp), mỗi khối phải báo
--     "permission denied for function":
--       BEGIN; SET TRANSACTION READ ONLY; SET LOCAL ROLE anon;         SELECT * FROM public.care_reason_options('2026-11-01', false); ROLLBACK;
--       BEGIN; SET TRANSACTION READ ONLY; SET LOCAL ROLE anon;         SELECT * FROM public.care_tasks_by_reason('2026-11-01', 'chronic', false); ROLLBACK;
--       BEGIN; SET TRANSACTION READ ONLY; SET LOCAL ROLE service_role; SELECT * FROM public.care_reason_options('2026-11-01', false); ROLLBACK;
--       BEGIN; SET TRANSACTION READ ONLY; SET LOCAL ROLE service_role; SELECT * FROM public.care_tasks_by_reason('2026-11-01', 'chronic', false); ROLLBACK;
-- V8) Phụ thuộc policy theo OID (bổ sung phép so chuỗi của tiền kiểm — chạy được cả TRƯỚC 133) + ACL đầy đủ để lưu báo cáo:
--       SELECT pol.polname, array_agg(d.refobjid::regprocedure::text ORDER BY d.refobjid::regprocedure::text) AS fns
--         FROM pg_policy pol JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = pol.oid AND d.refclassid = 'pg_proc'::regclass
--        WHERE pol.polrelid IN ('public.care_tasks'::regclass, 'public.care_task_products'::regclass) GROUP BY 1;
--     -- kỳ vọng: care_tasks_select = 4 helper public.* (care_assignee_uid, care_can_view_all, care_scope_store_ids, care_staff_store_id);
--     --          care_task_products_select = care_can_read_task(uuid), care_can_view_all()
--       SELECT p.oid::regprocedure AS fn, p.proacl FROM pg_proc p
--        WHERE p.oid IN ('public.care_reason_options(date, boolean)'::regprocedure, 'public.care_tasks_by_reason(date, text, boolean)'::regprocedure);
--     -- kỳ vọng: owner + authenticated; grantee quản trị khác (vd postgres do default privileges) ⇒ ghi nhận vào báo cáo.
