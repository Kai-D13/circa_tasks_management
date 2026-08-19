-- ============================================================================
-- 108_sm_create_broadcast_task.sql
-- Chạy SAU 107. Cấp quyền GHI mới ⇒ đọc kỹ phần "ranh giới" bên dưới.
--
-- SM (Quản lý vùng) được TẠO task phát sinh dạng broadcast cho các cửa hàng
-- mình phụ trách. Trước đây tạo task là admin-only ở cả bốn tầng (nút, route,
-- server action, RLS).
--
-- ⚠ RANH GIỚI THỰC SỰ NẰM Ở ĐÂU — đọc trước khi tin migration này là đủ:
--   · task_broadcasts: insert bằng SESSION client ⇒ RLS LÀ chốt chặn.
--   · tasks (chế độ "Cửa hàng nộp"): insert bằng SESSION client ⇒ RLS LÀ chốt.
--   · tasks (chế độ "Từng dược sĩ nộp"): parent + children insert bằng
--     SERVICE ROLE (supabaseAdmin) ⇒ RLS KHÔNG áp. Với nhánh này, chốt chặn duy
--     nhất là validate phạm vi trong server action. Vì vậy test chống giả mạo
--     payload là BẮT BUỘC, không phải tùy chọn.
-- Policy ở đây là phòng thủ hai lớp cho nhánh session-client, KHÔNG thay thế
-- được validate ở tầng action.
--
-- Nội dung:
--   (A) tb_insert_sm      — SM tạo broadcast của chính mình.
--   (B) tb_select_sm_own  — SM ĐỌC broadcast của chính mình.
--       ⚠ BẮT BUỘC, không phải tiện nghi: action chạy
--       `insert(...).select().single()`. Policy tb_select_sm sẵn có (045) đòi
--       EXISTS(tasks WHERE broadcast_id = ...) — tại thời điểm INSERT chưa có
--       task nào trỏ tới broadcast vừa tạo, nên RETURNING trả 0 dòng và
--       `.single()` báo lỗi. Thiếu policy này thì SM tạo task hỏng ngay bước
--       đầu dù đã có quyền INSERT. (Admin không dính vì tb_select_admin so
--       created_by.)
--   (C) tasks_insert_sm   — SM tạo task cho ĐÚNG store được phân công.
--
-- KHÔNG mở UPDATE/DELETE cho SM. KHÔNG đụng policy admin. KHÔNG đổi schema.
-- Dùng is_sm_for_store() (SECURITY DEFINER, mig 045) nên không có tham chiếu
-- chéo bảng trong policy ⇒ không đệ quy.
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS "tb_insert_sm"     ON public.task_broadcasts;
--   DROP POLICY IF EXISTS "tb_select_sm_own" ON public.task_broadcasts;
--   DROP POLICY IF EXISTS "tasks_insert_sm"  ON public.tasks;
--   DELETE FROM public.app_migrations WHERE version = '108';
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '107') THEN
    RAISE EXCEPTION '108: thiếu migration nền 107 — chạy đúng thứ tự';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_sm_for_store'
  ) THEN
    RAISE EXCEPTION '108: thiếu helper is_sm_for_store (mig 045)';
  END IF;
END $$;

-- ── A. SM tạo broadcast của chính mình ──────────────────────────────────────
DROP POLICY IF EXISTS "tb_insert_sm" ON public.task_broadcasts;
CREATE POLICY "tb_insert_sm" ON public.task_broadcasts
  FOR INSERT TO authenticated
  WITH CHECK (
    (select public.get_user_role()) = 'sm'
    AND created_by = (select auth.uid())
  );

-- ── B. SM đọc broadcast của chính mình (cần cho INSERT ... RETURNING) ───────
DROP POLICY IF EXISTS "tb_select_sm_own" ON public.task_broadcasts;
CREATE POLICY "tb_select_sm_own" ON public.task_broadcasts
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'sm'
    AND created_by = (select auth.uid())
  );

-- ── C. SM tạo task cho ĐÚNG cửa hàng được phân công ─────────────────────────
-- store_id IS NOT NULL nêu tường minh: is_sm_for_store(NULL) vốn đã false,
-- nhưng task không gắn cửa hàng thì không thuộc phạm vi SM theo bất kỳ nghĩa
-- nào — nói thẳng ra để người đọc policy không phải suy luận.
DROP POLICY IF EXISTS "tasks_insert_sm" ON public.tasks;
CREATE POLICY "tasks_insert_sm" ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    (select public.get_user_role()) = 'sm'
    AND created_by = (select auth.uid())
    AND store_id IS NOT NULL
    AND public.is_sm_for_store(store_id)
  );

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('108', 'sm_create_broadcast_task',
        'SM được TẠO task phát sinh broadcast cho cửa hàng được phân công.'
        || ' tb_insert_sm + tasks_insert_sm (đòi created_by = auth.uid() và'
        || ' is_sm_for_store(store_id)); tb_select_sm_own BẮT BUỘC vì action dùng'
        || ' INSERT ... RETURNING mà tb_select_sm (045) đòi EXISTS(tasks) — lúc'
        || ' insert chưa có task nào trỏ tới broadcast.'
        || ' KHÔNG mở UPDATE/DELETE cho SM, KHÔNG đụng policy admin, KHÔNG đổi schema.'
        || ' LƯU Ý: nhánh "Từng dược sĩ nộp" ghi tasks bằng service role nên RLS'
        || ' KHÔNG áp — chốt chặn ở đó là validate phạm vi trong server action.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ── VERIFY (chạy sau COMMIT) ────────────────────────────────────────────────
-- 1) Ba policy mới có mặt, đúng lệnh:
--    SELECT tablename, policyname, cmd, qual, with_check
--    FROM pg_policies
--    WHERE schemaname = 'public'
--      AND policyname IN ('tb_insert_sm','tb_select_sm_own','tasks_insert_sm')
--    ORDER BY tablename, policyname;
--    Kỳ vọng: 3 dòng; cmd = INSERT/SELECT/INSERT; with_check của tasks_insert_sm
--    chứa is_sm_for_store.
--
-- 2) Policy ADMIN còn nguyên (không bị ghi đè):
--    SELECT policyname, cmd FROM pg_policies
--    WHERE schemaname='public' AND policyname IN
--      ('tasks_insert_admin','tb_insert_admin','tb_select_admin',
--       'tb_update_admin','tb_delete_admin')
--    ORDER BY policyname;
--    Kỳ vọng: đủ 5 dòng.
--
-- 3) KHÔNG có policy UPDATE/DELETE nào mới cho SM:
--    SELECT policyname, cmd FROM pg_policies
--    WHERE schemaname='public' AND tablename IN ('tasks','task_broadcasts')
--      AND policyname LIKE '%_sm%' AND cmd IN ('UPDATE','DELETE');
--    Kỳ vọng: 0 dòng.
--
-- 4) Marker: SELECT version, name FROM public.app_migrations WHERE version='108';
