-- ============================================================================
-- 117_tasks_archive_rpc.sql
-- Chạy SAU 116. Batch T1-B (PM brief `planning/reviews/2026-10-24-tasks-integrity-lag-brief-pm.md`).
--
-- Mục đích: lưu trữ / khôi phục hàng loạt task trên /tasks thành MỘT thao tác "tất cả hoặc không" trong một transaction,
-- kiểm quyền CHO TỪNG task sẽ ghi ở DB (thay luồng app đọc phạm vi rồi ghi bằng service role — finding P1 fail-open khi bước
-- đọc phạm vi lỗi). Không đổi bảng, cột, RLS, index hay cron. Chỉ THÊM một hàm.
--
-- Contract public.rpc_set_tasks_archived(p_ids uuid[], p_action text) RETURNS jsonb:
--   · Gọi bằng session người dùng (role authenticated); auth.uid() + role lấy từ DB, không tin dữ liệu client. Vai được kiểm
--     TRƯỚC mọi xử lý đầu vào: chỉ super (is_super_admin) / admin / sm đi tiếp, vai khác ⇒ FORBIDDEN.
--   · p_action ∈ ('archive','restore'). p_ids: mảng một chiều, không rỗng, không phần tử NULL, ≤ 5000 phần tử thô; tự loại
--     trùng; ≤ 1000 ID sau loại trùng.
--   · Tập đích = ID đã chọn ∪ con trực tiếp (parent_task_id = ID đã chọn) — giống cascade cũ của archiveTasks/restoreTasks;
--     ≤ 5000 task sau khi gộp (kiểm SAU bước quyền — không lộ số con của task người khác).
--   · Kiểm hai lượt: lượt 1 trên dữ liệu CHƯA khoá (yêu cầu ngoài quyền bị từ chối trước khi giữ khoá dòng nào); lượt 2 khoá
--     toàn bộ tập đích FOR UPDATE theo thứ tự id rồi kiểm lại — đây là lần kiểm quyết định. Tập đã khoá phải trùng tập đã đo VÀ
--     tập tính lại sau khoá — lệch (con mới / đổi cha / dòng biến mất trong lúc chờ khoá) ⇒ CONCURRENT_CHANGE. Sau khi cha bị
--     khoá, chèn con mới / gắn con vào cha cần KEY SHARE trên cha (FK) nên phải chờ tới khi RPC commit ⇒ tập đích đứng yên tới
--     lúc ghi. SM: lượt 2 giữ FOR SHARE phân công cửa hàng của mình tới hết transaction. lock_timeout 4s ⇒ lỗi 55P03.
--   · Mọi ID đã chọn phải tồn tại. Quyền từng task trong tập đích: super mọi task; admin chỉ task created_by = auth.uid()
--     (= policy tasks_update_admin); SM chỉ task có store_id thuộc sm_store_assignments của mình (= kiểm app cũ smHasStore).
--     Một task không đạt ⇒ từ chối CẢ LÔ, không ghi gì.
--   · Một UPDATE duy nhất; task đã ở trạng thái đích không bị ghi lại (gọi lặp là idempotent, giữ mốc archived_at cũ). Số dòng
--     UPDATE phải bằng số dòng đích chưa ở trạng thái đích đếm ngay trước đó, lệch ⇒ COUNT_MISMATCH (rollback).
--   · Trả {target_count, changed_count}. Lỗi = mã ngắn TASKS_ARCHIVE_* (không lộ ID ngoài quyền); mọi lỗi rollback toàn bộ.
--     SQLSTATE: UNAUTHENTICATED / FORBIDDEN / OUT_OF_SCOPE 42501 (HTTP 403); EMPTY / BAD_INPUT / BAD_ACTION 22023 (400);
--     NOT_FOUND / TOO_MANY / CONCURRENT_CHANGE / COUNT_MISMATCH P0001 (400).
--   · EXECUTE chỉ authenticated (thu khỏi PUBLIC / anon / service_role + hậu kiểm aclexplode — bài học 090 → 091).
--
-- Tương thích: app de2d750 (chưa dùng RPC) chạy bình thường trên DB 117 — hàm mới, không đổi đối tượng cũ.
-- Idempotent: CREATE OR REPLACE + ON CONFLICT DO NOTHING; chạy lại an toàn (khi DB chưa có migration > 117).
--
-- ROLLBACK (chỉ khi app chưa dùng RPC, hoặc đã tắt cờ TASKS_ARCHIVE_RPC_ENABLED):
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.rpc_set_tasks_archived(uuid[], text);
--   DELETE FROM public.app_migrations WHERE version = '117';
--   COMMIT;
-- ============================================================================

BEGIN;

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '116') THEN
    RAISE EXCEPTION '117: thiếu migration nền 116 — chạy đúng thứ tự';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE version ~ '^[0-9]+$' AND version::int > 117) THEN
    RAISE EXCEPTION '117: DB đã có migration > 117 — dừng';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tasks'
        AND column_name IN ('id', 'archived_at', 'parent_task_id', 'created_by', 'store_id')) <> 5 THEN
    RAISE EXCEPTION '117: bảng public.tasks thiếu cột cần dùng (id, archived_at, parent_task_id, created_by, store_id)';
  END IF;
  IF to_regclass('public.sm_store_assignments') IS NULL OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION '117: thiếu bảng public.sm_store_assignments / public.users';
  END IF;
  IF to_regprocedure('public.is_super_admin()') IS NULL THEN
    RAISE EXCEPTION '117: thiếu hàm public.is_super_admin()';
  END IF;
  -- Hàm SECURITY DEFINER chạy bằng role tạo ra nó và đọc / khoá 3 bảng có RLS (tasks, users, sm_store_assignments): role đó phải
  -- superuser hoặc BYPASSRLS, có SELECT + UPDATE trên tasks và sm_store_assignments (FOR UPDATE / FOR SHARE cần UPDATE), SELECT
  -- trên users. Thiếu ⇒ RPC thấy 0 dòng và mọi lệnh fail-closed. has_table_privilege với danh sách quyền là OR ⇒ kiểm từng quyền.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION '117: role chạy migration (%) không phải superuser / BYPASSRLS — chạy bằng role quản trị DB', current_user;
  END IF;
  IF NOT (has_table_privilege(current_user, 'public.tasks', 'SELECT')
          AND has_table_privilege(current_user, 'public.tasks', 'UPDATE')
          AND has_table_privilege(current_user, 'public.sm_store_assignments', 'SELECT')
          AND has_table_privilege(current_user, 'public.sm_store_assignments', 'UPDATE')
          AND has_table_privilege(current_user, 'public.users', 'SELECT')) THEN
    RAISE EXCEPTION '117: role chạy migration (%) thiếu quyền SELECT/UPDATE trên tasks / sm_store_assignments hoặc SELECT trên users', current_user;
  END IF;
END $$;

-- ── 1. RPC ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpc_set_tasks_archived(p_ids uuid[], p_action text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET lock_timeout = '4s'
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_role     text;
  v_super    boolean;
  v_ids      uuid[];
  v_target   uuid[];
  v_locked   uuid[];
  v_recheck  uuid[];
  v_pass     integer;
  v_expected integer;
  v_changed  integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'TASKS_ARCHIVE_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  -- Vai trước mọi xử lý đầu vào: vai khác super / admin / sm gửi gì cũng chỉ nhận FORBIDDEN.
  SELECT u.role INTO v_role FROM public.users u WHERE u.id = v_uid;
  v_super := COALESCE(public.is_super_admin(), false);
  IF NOT v_super AND (v_role IS NULL OR v_role NOT IN ('admin', 'sm')) THEN
    RAISE EXCEPTION 'TASKS_ARCHIVE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('archive', 'restore') THEN
    RAISE EXCEPTION 'TASKS_ARCHIVE_BAD_ACTION' USING ERRCODE = '22023';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RAISE EXCEPTION 'TASKS_ARCHIVE_EMPTY' USING ERRCODE = '22023';
  END IF;
  IF array_ndims(p_ids) <> 1 THEN
    RAISE EXCEPTION 'TASKS_ARCHIVE_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF cardinality(p_ids) > 5000 THEN
    RAISE EXCEPTION 'TASKS_ARCHIVE_TOO_MANY' USING ERRCODE = 'P0001';
  END IF;
  IF array_position(p_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'TASKS_ARCHIVE_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids FROM unnest(p_ids) AS x;
  IF cardinality(v_ids) > 1000 THEN
    RAISE EXCEPTION 'TASKS_ARCHIVE_TOO_MANY' USING ERRCODE = 'P0001';
  END IF;

  -- Tập đích = ID đã chọn + con trực tiếp. Lượt 1: dữ liệu CHƯA khoá — từ chối sớm, không giữ khoá dòng của task ngoài quyền.
  -- Lượt 2: khoá theo thứ tự id, so tập đã khoá với tập đã đo và với tập tính lại bằng snapshot mới (câu khoá dùng snapshot lúc
  -- bắt đầu nên không thấy con được commit trong lúc chờ khoá), rồi kiểm lại y hệt trên dữ liệu đã khoá — lần kiểm quyết định.
  FOR v_pass IN 1..2 LOOP
    IF v_pass = 1 THEN
      SELECT COALESCE(array_agg(t.id ORDER BY t.id), '{}'::uuid[]) INTO v_target
        FROM public.tasks t
       WHERE t.id = ANY (v_ids) OR t.parent_task_id = ANY (v_ids);
    ELSE
      SELECT COALESCE(array_agg(s.id ORDER BY s.id), '{}'::uuid[]) INTO v_locked
        FROM (SELECT t.id FROM public.tasks t
               WHERE t.id = ANY (v_ids) OR t.parent_task_id = ANY (v_ids)
               ORDER BY t.id
                 FOR UPDATE OF t) s;
      IF v_locked IS DISTINCT FROM v_target THEN
        RAISE EXCEPTION 'TASKS_ARCHIVE_CONCURRENT_CHANGE' USING ERRCODE = 'P0001';
      END IF;
      SELECT COALESCE(array_agg(t.id ORDER BY t.id), '{}'::uuid[]) INTO v_recheck
        FROM public.tasks t
       WHERE t.id = ANY (v_ids) OR t.parent_task_id = ANY (v_ids);
      IF v_recheck IS DISTINCT FROM v_locked THEN
        RAISE EXCEPTION 'TASKS_ARCHIVE_CONCURRENT_CHANGE' USING ERRCODE = 'P0001';
      END IF;
    END IF;

    -- Mọi ID đã chọn phải tồn tại (không nói ID nào thiếu).
    IF (SELECT count(*) FROM public.tasks t WHERE t.id = ANY (v_ids)) <> cardinality(v_ids) THEN
      RAISE EXCEPTION 'TASKS_ARCHIVE_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;

    -- Quyền cho TỪNG task trong tập đích; một task không đạt ⇒ từ chối cả lô.
    IF NOT v_super THEN
      IF v_role = 'admin' THEN
        IF EXISTS (SELECT 1 FROM public.tasks t
                    WHERE t.id = ANY (v_target) AND t.created_by IS DISTINCT FROM v_uid) THEN
          RAISE EXCEPTION 'TASKS_ARCHIVE_OUT_OF_SCOPE' USING ERRCODE = '42501';
        END IF;
      ELSIF v_role = 'sm' THEN
        IF v_pass = 2 THEN
          -- Giữ phân công cửa hàng của SM tới hết transaction (không bị gỡ giữa lúc kiểm và lúc ghi).
          PERFORM 1 FROM public.sm_store_assignments a WHERE a.sm_user_id = v_uid ORDER BY a.store_id FOR SHARE;
        END IF;
        IF EXISTS (SELECT 1 FROM public.tasks t
                    WHERE t.id = ANY (v_target)
                      AND NOT (t.store_id IS NOT NULL AND EXISTS (
                            SELECT 1 FROM public.sm_store_assignments a WHERE a.sm_user_id = v_uid AND a.store_id = t.store_id))) THEN
          RAISE EXCEPTION 'TASKS_ARCHIVE_OUT_OF_SCOPE' USING ERRCODE = '42501';
        END IF;
      ELSE
        RAISE EXCEPTION 'TASKS_ARCHIVE_FORBIDDEN' USING ERRCODE = '42501';
      END IF;
    END IF;

    -- Trần tập đích sau bước quyền (không lộ số con của task người khác); kiểm ở lượt 1 — trước khi khoá.
    IF v_pass = 1 AND cardinality(v_target) > 5000 THEN
      RAISE EXCEPTION 'TASKS_ARCHIVE_TOO_MANY' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  SELECT count(*)::int INTO v_expected FROM public.tasks t
   WHERE t.id = ANY (v_target)
     AND CASE WHEN p_action = 'archive' THEN t.archived_at IS NULL ELSE t.archived_at IS NOT NULL END;
  IF p_action = 'archive' THEN
    UPDATE public.tasks t SET archived_at = now()
     WHERE t.id = ANY (v_target) AND t.archived_at IS NULL;
  ELSE
    UPDATE public.tasks t SET archived_at = NULL
     WHERE t.id = ANY (v_target) AND t.archived_at IS NOT NULL;
  END IF;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed <> v_expected THEN
    RAISE EXCEPTION 'TASKS_ARCHIVE_COUNT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('target_count', cardinality(v_target), 'changed_count', v_changed);
END;
$$;

-- ── 2. Quyền thực thi: chỉ authenticated ────────────────────────────────────
REVOKE ALL ON FUNCTION public.rpc_set_tasks_archived(uuid[], text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_set_tasks_archived(uuid[], text) TO authenticated;
-- Thu hồi mọi grant khác owner (kể cả do default privileges cấp, vd. cho postgres), trừ authenticated.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, x.grantee
    FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
    WHERE p.oid = 'public.rpc_set_tasks_archived(uuid[], text)'::regprocedure
      AND x.grantee <> p.proowner
      AND x.grantee <> 'authenticated'::regrole::oid
    GROUP BY p.oid, x.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- ── 3. Hậu kiểm trong transaction ───────────────────────────────────────────
DO $$
DECLARE
  f oid := 'public.rpc_set_tasks_archived(uuid[], text)'::regprocedure;
BEGIN
  IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION '117: hậu kiểm — authenticated phải EXECUTE được';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION '117: hậu kiểm — anon / service_role không được EXECUTE';
  END IF;
  IF (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ',')
        FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
       WHERE p.oid = f AND x.grantee <> p.proowner) IS DISTINCT FROM 'authenticated:EXECUTE' THEN
    RAISE EXCEPTION '117: hậu kiểm — ACL ngoài owner phải đúng một quyền authenticated:EXECUTE';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = f) THEN
    RAISE EXCEPTION '117: hậu kiểm — hàm phải SECURITY DEFINER';
  END IF;
  -- CREATE OR REPLACE giữ owner cũ khi chạy lại ⇒ kiểm chính owner của hàm, không chỉ current_user.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = f AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION '117: hậu kiểm — owner của hàm phải superuser / BYPASSRLS';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('117', 'tasks_archive_rpc', 'T1-B: rpc_set_tasks_archived — lưu trữ / khôi phục hàng loạt atomic, kiểm quyền từng task')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ── VERIFY (chạy sau COMMIT, chỉ đọc) — bản đầy đủ: planning/research/dev-tools/t1-117/verify-117.sql ─────────
-- 1) Marker:   SELECT version, name FROM public.app_migrations WHERE version = '117';
-- 2) Hàm:      SELECT p.prosecdef, p.proconfig, p.proowner::regrole AS owner, r.rolsuper, r.rolbypassrls
--               FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
--              WHERE p.oid = 'public.rpc_set_tasks_archived(uuid[], text)'::regprocedure;
--              kỳ vọng prosecdef = true; proconfig chứa search_path=public, lock_timeout=4s; rolsuper hoặc rolbypassrls = true.
-- 3) Quyền:    SELECT has_function_privilege('authenticated', 'public.rpc_set_tasks_archived(uuid[], text)', 'EXECUTE') AS auth_ok,
--                     has_function_privilege('anon',          'public.rpc_set_tasks_archived(uuid[], text)', 'EXECUTE') AS anon_bad,
--                     has_function_privilege('service_role',  'public.rpc_set_tasks_archived(uuid[], text)', 'EXECUTE') AS svc_bad;
--              kỳ vọng true / false / false.
-- 4) ACL:      SELECT pg_get_userbyid(x.grantee) FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
--               WHERE p.oid = 'public.rpc_set_tasks_archived(uuid[], text)'::regprocedure AND x.grantee <> p.proowner;
--              kỳ vọng đúng một dòng: authenticated.
