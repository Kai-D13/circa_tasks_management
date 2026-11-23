-- ============================================================================
-- rollback/133_care_no_need_callback_rollback.sql — HOÀN TÁC migration 133 (chỉ operator chạy, khi PM / operator quyết rollback DB).
-- KHÔNG nằm trong luồng migration tuần tự (thư mục rollback/). Đã kiểm trên PGlite (webapp/scripts/qa-care-133.mjs).
--
-- Thứ tự: deploy app về bản TRƯỚC batch (bảng outcome TS cũ) rồi mới chạy file này — nếu không, app mới gửi NO_NEED kèm ngày hẹn sẽ
-- bị RPC từ chối ("không nhận ngày hẹn") cho tới khi hai bên khớp lại.
--
-- Việc làm:
--   1. trả care_is_terminal_outcome / care_outcome_requires_date về NGUYÊN VĂN 114 (NO_NEED kết thúc, không ngày hẹn);
--   2. DROP FUNCTION care_reason_options(date, boolean);
--   3. DROP FUNCTION care_tasks_by_reason(date, text, boolean);
--   4. cấp lại EXECUTE hai helper outcome theo ma trận 114 (authenticated + service_role; PUBLIC / anon ✗);
--   5. DELETE FROM app_migrations WHERE version = '133'.
-- TỪ CHỐI khi đã có lượt NO_NEED kiểu mới (is_terminal = false): các task đó đang mở kèm ngày hẹn theo luật 133 — quay về luật cũ
-- không tự đóng chúng; PM phải quyết cách xử lý dữ liệu (giữ mở tới hết kỳ / ghi lượt kết thúc) rồi mới rollback bằng tay.
-- Điều kiện chặn tính CẢ lượt của dữ liệu thử (is_test — PM 23/11 §4 f): KHÔNG xoá lượt QA để vượt rào. Vì vậy TRƯỚC khi hạ app phải
-- kiểm điều kiện này trên DB (câu R0 cuối file); đã có lượt kiểu mới ⇒ giữ cặp app / DB 133 và xử lý tiến, không hạ app.
-- Không sửa bất kỳ dòng dữ liệu nào.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';
-- Như 133: không cho lượt ghi vắt qua thời điểm đổi luật, và giữ điều kiện chặn bên dưới đúng tới COMMIT (đọc không bị chặn).
LOCK TABLE public.care_tasks IN EXCLUSIVE MODE;

DO $$
DECLARE
  v_n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '133') THEN
    RAISE EXCEPTION 'rollback 133: chưa có migration 133';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 133) THEN
    RAISE EXCEPTION 'rollback 133: đã có migration số > 133 — rollback bản đó trước';
  END IF;
  SELECT count(*) INTO v_n FROM public.care_interactions WHERE outcome = 'NO_NEED' AND NOT is_terminal;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'rollback 133: đã có % lượt NO_NEED kiểu mới (còn mở, có ngày hẹn) — dừng, PM quyết xử lý dữ liệu trước', v_n;
  END IF;
END $$;

-- Nguyên văn 114.
CREATE OR REPLACE FUNCTION public.care_is_terminal_outcome(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p IN ('NO_NEED', 'INTERESTED', 'ORDERED', 'REFUSED'), false)
$$;

CREATE OR REPLACE FUNCTION public.care_outcome_requires_date(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p IN ('UNREACHABLE', 'CALLBACK'), false)
$$;

DROP FUNCTION IF EXISTS public.care_reason_options(date, boolean);
DROP FUNCTION IF EXISTS public.care_tasks_by_reason(date, text, boolean);

REVOKE ALL ON FUNCTION public.care_is_terminal_outcome(text), public.care_outcome_requires_date(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.care_is_terminal_outcome(text), public.care_outcome_requires_date(text)
  TO authenticated, service_role;

DO $$
DECLARE
  v_bad text;
BEGIN
  IF NOT (public.care_is_terminal_outcome('NO_NEED') AND NOT public.care_outcome_requires_date('NO_NEED')
          AND public.care_outcome_requires_date('CALLBACK') AND public.care_outcome_requires_date('UNREACHABLE')
          AND public.care_is_terminal_outcome('INTERESTED') AND public.care_is_terminal_outcome('ORDERED') AND public.care_is_terminal_outcome('REFUSED')) THEN
    RAISE EXCEPTION 'rollback 133 hậu kiểm: bảng chân trị không về 114';
  END IF;
  SELECT string_agg(f.sig || ':' || r.rolname, ', ') INTO v_bad
  FROM (VALUES ('public.care_is_terminal_outcome(text)'), ('public.care_outcome_requires_date(text)')) AS f(sig)
  CROSS JOIN (VALUES ('anon', false), ('authenticated', true), ('service_role', true)) AS r(rolname, want)
  WHERE pg_catalog.has_function_privilege(r.rolname, f.sig, 'EXECUTE') IS DISTINCT FROM r.want;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'rollback 133 hậu kiểm: ma trận EXECUTE sai (%)', v_bad;
  END IF;
  -- Đủ HAI hàm lý do biến mất — theo TÊN (mọi chữ ký), không chỉ đúng chữ ký của 133.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('care_reason_options', 'care_tasks_by_reason')) THEN
    RAISE EXCEPTION 'rollback 133 hậu kiểm: hàm lọc lý do còn tồn tại';
  END IF;
  -- Như hậu kiểm của 133: hai helper outcome IMMUTABLE, không definer; PUBLIC không có EXECUTE.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.oid IN ('public.care_is_terminal_outcome(text)'::regprocedure, 'public.care_outcome_requires_date(text)'::regprocedure)
                AND (p.prosecdef OR p.provolatile <> 'i')) THEN
    RAISE EXCEPTION 'rollback 133 hậu kiểm: thuộc tính hai helper outcome sai (definer / volatility)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(p.proacl) a
              WHERE p.oid IN ('public.care_is_terminal_outcome(text)'::regprocedure, 'public.care_outcome_requires_date(text)'::regprocedure)
                AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'rollback 133 hậu kiểm: PUBLIC còn EXECUTE';
  END IF;
END $$;

DELETE FROM public.app_migrations WHERE version = '133';

COMMIT;

-- ── R0 — TRƯỚC khi quyết rollback và TRƯỚC khi đổi app (CHỈ ĐỌC): điều kiện chặn của file này ─────────────────────
-- R0) SELECT count(*) AS no_need_kieu_moi, count(*) FILTER (WHERE t.is_test) AS trong_do_du_lieu_thu
--       FROM public.care_interactions i JOIN public.care_tasks t ON t.id = i.task_id
--      WHERE i.outcome = 'NO_NEED' AND NOT i.is_terminal;
--     -- 0 ⇒ rollback chạy được (hạ app trước rồi chạy file này) · > 0 ⇒ file này sẽ RAISE: GIỮ app + DB 133, báo PM, xử lý tiến.

-- ── VERIFY sau rollback (CHỈ ĐỌC — bọc BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;) ─────────────────────────
-- R1) SELECT count(*) FROM public.app_migrations WHERE version = '133';                                   -- 0
-- R2) SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
--        AND proname IN ('care_reason_options', 'care_tasks_by_reason');                                  -- 0 (cả hai hàm đã gỡ)
-- R3) SELECT p.proname, md5(replace(p.prosrc, E'\r', '')) AS md5_no_cr,
--            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
--            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
--            has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
--       FROM pg_proc p
--      WHERE p.oid IN ('public.care_is_terminal_outcome(text)'::regprocedure, 'public.care_outcome_requires_date(text)'::regprocedure) ORDER BY 1;
--     -- md5 nền 114: 8036bc4e30827bf25723df1ae314f878 / c79e0cd839a9014903ce07060d5653c7 · anon f · authenticated t · service_role t
