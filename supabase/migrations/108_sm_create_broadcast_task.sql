-- ============================================================================
-- 108_sm_create_broadcast_task.sql
-- Chạy SAU 107. CẤP QUYỀN GHI MỚI — đọc kỹ trước khi chạy.
--
-- SM (Quản lý vùng) được TẠO task phát sinh dạng BROADCAST cho các cửa hàng
-- mình phụ trách. Trước đây tạo task là admin-only ở cả bốn tầng.
--
-- ⚠ POLICY PHẢI CHẶN CẢ "GHI CÁI GÌ", KHÔNG CHỈ "AI GHI".
-- Bản nháp đầu chỉ kiểm role + created_by + phạm vi cửa hàng. Như vậy một SM
-- bỏ qua server action, gọi thẳng PostgREST vẫn tạo được task với
-- visibility='public' (MỌI nhân viên công ty đọc được), assigned_to trỏ người
-- ngoài cửa hàng, status='done' (giả hoàn thành), source_type hệ thống, hoặc
-- gắn vào broadcast của người khác. Validate trong server action KHÔNG bảo vệ
-- đường gọi DB trực tiếp — RLS mới là chốt duy nhất ở đó. Vì vậy
-- tasks_insert_sm ghim TỪNG CỘT xuống đúng hình dạng của một task broadcast
-- store-mode do chính SM tạo.
--
-- ⚠ RANH GIỚI THỰC SỰ NẰM Ở ĐÂU:
--   · task_broadcasts + tasks (chế độ "Cửa hàng nộp"): SESSION client ⇒ RLS LÀ
--     chốt chặn, kể cả khi gọi PostgREST trực tiếp.
--   · tasks chế độ "Từng dược sĩ nộp" (parent + children): SERVICE ROLE ⇒ RLS
--     KHÔNG áp. Chốt chặn duy nhất là validate phạm vi trong server action.
--     Service role key không nằm trong tay SM nên đây không phải lỗ hổng cho
--     người dùng cuối, nhưng phải nói rõ để không ai tưởng policy là đủ.
--
-- ⚠ KHÔNG đặt subquery task_broadcasts TRỰC TIẾP trong policy của tasks:
-- policy của task_broadcasts (tb_select_sm, mig 045) lại tham chiếu ngược
-- tasks — đúng hình dạng A↔B đã gây HAI sự cố production (047→048/049). Bọc
-- trong SECURITY DEFINER để bỏ qua RLS, giống is_sm_for_store/is_super_admin.
--
-- KHÔNG mở UPDATE/DELETE cho SM. KHÔNG đụng policy admin. KHÔNG đổi schema.
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS "tb_insert_sm"     ON public.task_broadcasts;
--   DROP POLICY IF EXISTS "tb_select_sm_own" ON public.task_broadcasts;
--   DROP POLICY IF EXISTS "tasks_insert_sm"  ON public.tasks;
--   DROP FUNCTION IF EXISTS public.is_own_sm_broadcast(uuid);
--   -- rồi tạo lại task_uploads_insert NGUYÊN VĂN từ migration 064 (KHÔNG phải 033).
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

-- ── A. Broadcast này có do CHÍNH SM đang gọi tạo ra không ───────────────────
-- SECURITY DEFINER ⇒ đọc task_broadcasts KHÔNG kích hoạt policy của bảng đó
-- ⇒ không có vòng tasks → task_broadcasts → tasks.
CREATE OR REPLACE FUNCTION public.is_own_sm_broadcast(p_broadcast_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.task_broadcasts b
    WHERE b.id = p_broadcast_id
      AND b.created_by = auth.uid()
  );
$fn$;

REVOKE ALL ON FUNCTION public.is_own_sm_broadcast(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_own_sm_broadcast(uuid) TO authenticated, service_role;

-- ── B. SM tạo + đọc broadcast của chính mình ────────────────────────────────
DROP POLICY IF EXISTS "tb_insert_sm" ON public.task_broadcasts;
CREATE POLICY "tb_insert_sm" ON public.task_broadcasts
  FOR INSERT TO authenticated
  WITH CHECK (
    (select public.get_user_role()) = 'sm'
    AND created_by = (select auth.uid())
  );

-- BẮT BUỘC cho INSERT ... RETURNING: tb_select_sm (045) đòi EXISTS(tasks WHERE
-- broadcast_id = ...), mà lúc insert chưa có task nào trỏ tới broadcast vừa
-- tạo ⇒ RETURNING trả 0 dòng và `.single()` báo lỗi.
DROP POLICY IF EXISTS "tb_select_sm_own" ON public.task_broadcasts;
CREATE POLICY "tb_select_sm_own" ON public.task_broadcasts
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'sm'
    AND created_by = (select auth.uid())
  );

-- ── C. SM tạo task: GHIM ĐÚNG HÌNH DẠNG broadcast store-mode ────────────────
DROP POLICY IF EXISTS "tasks_insert_sm" ON public.tasks;
CREATE POLICY "tasks_insert_sm" ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    (select public.get_user_role()) = 'sm'
    AND created_by = (select auth.uid())
    -- Cửa hàng phải thuộc phạm vi TẠI THỜI ĐIỂM INSERT (không phải lúc mở form)
    AND store_id IS NOT NULL
    AND public.is_sm_for_store(store_id)
    -- 'public' cho MỌI nhân viên công ty đọc (tasks_select_staff không kèm
    -- điều kiện cửa hàng) ⇒ vượt phạm vi vùng. SM chỉ được 'store'.
    AND visibility = 'store'
    -- Giao đích danh sẽ đẩy task tới người ngoài cửa hàng.
    AND assigned_to IS NULL
    AND parent_task_id IS NULL
    AND assignment_mode = 'store'
    -- Không được tạo task đã 'done' (giả hoàn thành) hay trạng thái khác.
    AND status = 'todo'
    -- Không mạo danh nguồn hệ thống (inventory_trf...) để lọt bộ lọc/báo cáo.
    AND source_type = 'task'
    -- Phải gắn vào broadcast của CHÍNH mình — chặn chèn task vào nhóm người khác.
    AND broadcast_id IS NOT NULL
    AND public.is_own_sm_broadcast(broadcast_id)
  );

-- ── D. Storage: SM tải được tệp hướng dẫn, TRỪ vùng import Excel ────────────
-- Khối dưới TRÍCH TỰ ĐỘNG NGUYÊN VĂN từ migration 064 (BẢN MỚI NHẤT của policy
-- này — 033 đã bị 039 rồi 064 định nghĩa lại), chỉ đổi đúng nhánh 'task-inputs';
-- script khẳng định phần còn lại không đổi một ký tự VÀ ba nhánh kia còn đủ:
--   · tasks/  — staff + store_manager nộp kết quả task cấp cửa hàng (039)
--   · prescriptions/  · announcement_assets/ (064, admin)
-- ⚠ Dựng lại từ 033 sẽ ÂM THẦM XOÁ hai quyền đang chạy production.
DROP POLICY IF EXISTS "task_uploads_insert" ON storage.objects;

CREATE POLICY task_uploads_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'task-uploads'
    AND (
      (
        (storage.foldername(name))[1] = 'tasks'
        AND EXISTS (
          SELECT 1 FROM public.tasks t JOIN public.users u ON u.id = (select auth.uid())
          WHERE t.id::text = (storage.foldername(name))[2]
            AND t.archived_at IS NULL
            AND (
              t.assigned_to = (select auth.uid())
              OR (
                t.assigned_to IS NULL
                AND t.assignment_mode = 'store'
                AND t.store_id IS NOT NULL
                AND t.store_id = u.store_id
                AND u.role IN ('staff', 'store_manager')
              )
            )
        )
      )
      -- 108: admin GIU NGUYEN; SM duoc them NHUNG bi chan segment 'import'.
      -- 'task-inputs/import/<tmpId>/...' la vung file Excel cua luong chia task
      -- hang loat — luong do van admin-only, nen SM khong duoc ghi vao do du UI
      -- da an (UI an khong phai la rang buoc).
      OR (
        (storage.foldername(name))[1] = 'task-inputs'
        AND EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = (select auth.uid())
            AND (
              u.role = 'admin'
              OR (u.role = 'sm' AND (storage.foldername(name))[2] <> 'import')
            )
        )
      )
      OR (
        (storage.foldername(name))[1] = 'prescriptions'
        AND EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = (select auth.uid())
            AND u.store_id::text = (storage.foldername(name))[2]
            AND u.role = ANY (ARRAY['staff', 'store_manager'])
        )
      )
      OR (
        (storage.foldername(name))[1] = 'announcement_assets'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = (select auth.uid()) AND u.role = 'admin')
      )
    )
  );

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('108', 'sm_create_broadcast_task',
        'SM tao task phat sinh BROADCAST cho cua hang duoc phan cong.'
        || ' tasks_insert_sm ghim TUNG COT (visibility=store, assigned_to null,'
        || ' parent null, assignment_mode=store, status=todo, source_type=task,'
        || ' broadcast_id thuoc broadcast cua chinh SM qua helper SECDEF'
        || ' is_own_sm_broadcast) — vi goi PostgREST truc tiep thi server action'
        || ' khong bao ve duoc. tb_insert_sm + tb_select_sm_own (can cho INSERT'
        || ' RETURNING vi tb_select_sm cua 045 doi EXISTS(tasks)).'
        || ' storage task_uploads_insert: SM ghi duoc task-inputs/ TRU tien to'
        || ' import/ (luong chia file Excel van admin-only).'
        || ' KHONG mo UPDATE/DELETE cho SM, KHONG dung policy admin, KHONG doi schema.'
        || ' LUU Y: nhanh "Tung duoc si nop" ghi tasks bang SERVICE ROLE nen RLS'
        || ' KHONG ap — chot chan o do la validate pham vi trong server action.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ── VERIFY (chạy sau COMMIT) ────────────────────────────────────────────────
-- 1) Ba policy + helper:
--    SELECT tablename, policyname, cmd FROM pg_policies
--    WHERE schemaname='public'
--      AND policyname IN ('tb_insert_sm','tb_select_sm_own','tasks_insert_sm');
--    SELECT proname, prosecdef FROM pg_proc WHERE proname='is_own_sm_broadcast';
--    Kỳ vọng: 3 policy; prosecdef = true.
--
-- 2) tasks_insert_sm ghim đủ cột:
--    SELECT with_check FROM pg_policies
--    WHERE schemaname='public' AND policyname='tasks_insert_sm';
--    Kỳ vọng chứa: visibility = 'store' · assigned_to IS NULL ·
--    parent_task_id IS NULL · assignment_mode = 'store' · status = 'todo' ·
--    source_type = 'task' · is_own_sm_broadcast · is_sm_for_store.
--
-- 3) Policy ADMIN còn nguyên:
--    SELECT policyname FROM pg_policies WHERE schemaname='public' AND policyname IN
--      ('tasks_insert_admin','tb_insert_admin','tb_select_admin',
--       'tb_update_admin','tb_delete_admin');
--    Kỳ vọng: 5 dòng.
--
-- 4) KHÔNG có policy UPDATE/DELETE mới cho SM:
--    SELECT policyname, cmd FROM pg_policies
--    WHERE schemaname='public' AND tablename IN ('tasks','task_broadcasts')
--      AND policyname LIKE '%_sm%' AND cmd IN ('UPDATE','DELETE');
--    Kỳ vọng: 0 dòng.
--
-- 5) Storage: nhánh admin còn, nhánh SM có và loại trừ 'import':
--    SELECT with_check FROM pg_policies
--    WHERE schemaname='storage' AND policyname='task_uploads_insert';
--    Kỳ vọng chứa: u.role = 'sm' và <> 'import'.
--
-- 6) Marker: SELECT version, name FROM public.app_migrations WHERE version='108';
