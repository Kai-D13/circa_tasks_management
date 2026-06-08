-- ============================================================
-- Migration 039: Store-level submit by staff ("Cua hang nop")
-- ============================================================
-- Before: a store-level task (assignment_mode='store', assigned_to=NULL) could
-- only be submitted by the store_manager. Staff in the store could see it but
-- not submit, upload proof, move it to in_progress, or view a colleague result.
--
-- After: ANY staff OR store_manager of the task store can submit. One valid
-- result completes the task for the whole store (submitTask flips it to 'done',
-- which hides the form for everyone else). Remaining store members get a
-- read-only preview of the submitted result.
--
-- This widens the store-level branch role from 'store_manager' to
-- ('staff','store_manager') in 3 policies + the RPC, and adds a staff SELECT
-- branch so staff can read the store result. Business logic is otherwise
-- identical to the live (post-038) definitions; calls stay wrapped in
-- (select ...) so the auth_rls_initplan perf fix is preserved.
--
-- Safe for existing rows: tasks.assignment_mode DEFAULTs to 'store'
-- (migration 013), so every existing unassigned store task already qualifies.
--
-- Rollback: re-create each policy below with role = 'store_manager' (and the
-- staff SELECT branch removed), and restore the RPC from migration 031.
-- Idempotent: DROP POLICY IF EXISTS / CREATE OR REPLACE.
-- ============================================================

BEGIN;

-- -- task_results: tr_insert (allow staff store-level submit) ------------------
DROP POLICY IF EXISTS tr_insert ON public.task_results;
CREATE POLICY tr_insert ON public.task_results
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (select auth.uid())
    AND (
      EXISTS (
        SELECT 1 FROM public.tasks t
        WHERE t.id = task_results.task_id AND t.assigned_to = (select auth.uid())
      )
      OR EXISTS (
        SELECT 1 FROM public.tasks t JOIN public.users u ON u.id = (select auth.uid())
        WHERE t.id = task_results.task_id
          AND t.assigned_to IS NULL
          AND t.assignment_mode = 'store'
          AND t.store_id IS NOT NULL
          AND t.store_id = u.store_id
          AND u.role IN ('staff', 'store_manager')
      )
    )
  );

-- -- task_results: tr_select_staff (staff can read store result) ---------------
DROP POLICY IF EXISTS tr_select_staff ON public.task_results;
CREATE POLICY tr_select_staff ON public.task_results
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'staff'
    AND (
      user_id = (select auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.tasks t
        WHERE t.id = task_results.task_id
          AND t.assigned_to IS NULL
          AND t.assignment_mode = 'store'
          AND t.store_id IS NOT NULL
          AND t.store_id = (select public.get_user_store_id())
      )
    )
  );

-- -- task_uploaded_files: tuf_insert (allow staff store-level upload) ----------
DROP POLICY IF EXISTS tuf_insert ON public.task_uploaded_files;
CREATE POLICY tuf_insert ON public.task_uploaded_files
  FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = (select auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.tasks t JOIN public.users u ON u.id = (select auth.uid())
      WHERE t.id = task_uploaded_files.task_id
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
  );

-- -- storage.objects: task_uploads_insert (allow staff store-level upload) -----
DROP POLICY IF EXISTS task_uploads_insert ON storage.objects;
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
      OR (
        (storage.foldername(name))[1] = 'task-inputs'
        AND EXISTS (
          SELECT 1 FROM public.users u WHERE u.id = (select auth.uid()) AND u.role = 'admin'
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
    )
  );

-- -- rpc_staff_update_task_status: unify submitter check (staff store-level) ---
-- Verbatim from migration 031 except v_is_submitter is unified for both roles
-- so staff (not only store_manager) can move a store-level task to in_progress.
CREATE OR REPLACE FUNCTION rpc_staff_update_task_status(
  p_task_id uuid,
  p_status  text,
  p_note    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role        text;
  v_store_id    uuid;
  v_task        record;
  v_has_result  boolean;
  v_is_submitter boolean;
BEGIN
  SELECT role, store_id INTO v_role, v_store_id
  FROM public.users WHERE id = auth.uid();

  IF v_role NOT IN ('staff', 'store_manager') THEN
    RETURN jsonb_build_object('error', 'API này chỉ dành cho người thực hiện task');
  END IF;

  SELECT * INTO v_task FROM public.tasks WHERE id = p_task_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Task không tồn tại');
  END IF;

  -- A staff_all parent is overview-only -- it has no submitter and cannot change
  -- status. Status flows happen on the per-staff child tasks.
  IF v_task.assignment_mode = 'staff_all' THEN
    RETURN jsonb_build_object('error', 'Task cha không thể đổi trạng thái — hãy thao tác trên task con.');
  END IF;

  -- Caller must be the submitter for this task. Unified for staff + store_manager
  -- (the role gate above already restricts to those two):
  --   direct assignee, OR store-level submitter for their store.
  v_is_submitter :=
    (v_task.assigned_to IS NOT DISTINCT FROM auth.uid())
    OR (v_task.assigned_to IS NULL
        AND v_task.assignment_mode = 'store'
        AND v_task.store_id IS NOT NULL
        AND v_task.store_id = v_store_id);

  IF NOT v_is_submitter THEN
    RETURN jsonb_build_object('error', 'Bạn không phải người thực hiện task này');
  END IF;

  -- Overdue tasks are actionable; lateness is tracked via tasks.overdue_at.

  IF p_status NOT IN ('todo', 'in_progress') THEN
    RETURN jsonb_build_object('error', 'Không có quyền đổi sang trạng thái này');
  END IF;

  IF p_status = 'in_progress' AND (p_note IS NULL OR trim(p_note) = '') THEN
    RETURN jsonb_build_object('error', 'Bắt buộc phải ghi chú khi chuyển sang Đang thực hiện');
  END IF;

  -- Block if a valid submission exists after the last resubmit request.
  -- Direct assignee: per user. Store-level submitter: per task.
  SELECT EXISTS (
    SELECT 1 FROM public.task_results tr
    WHERE tr.task_id = p_task_id
      AND (v_task.assigned_to IS NULL OR tr.user_id = auth.uid())
      AND (v_task.resubmit_requested_at IS NULL OR tr.submitted_at > v_task.resubmit_requested_at)
  ) INTO v_has_result;

  IF v_has_result THEN
    RETURN jsonb_build_object('error', 'Đã nộp kết quả rồi, không thể thay đổi trạng thái');
  END IF;

  UPDATE public.tasks SET status = p_status WHERE id = p_task_id;

  INSERT INTO public.task_logs (task_id, action, user_id, metadata)
  VALUES (
    p_task_id,
    'status_changed',
    auth.uid(),
    jsonb_build_object('from', v_task.status, 'to', p_status)
    || CASE WHEN p_note IS NOT NULL AND trim(p_note) <> ''
            THEN jsonb_build_object('note', p_note)
            ELSE '{}'::jsonb END
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_staff_update_task_status(uuid, text, text) TO authenticated;

-- Record this migration.
INSERT INTO public.app_migrations (version, name, notes)
VALUES ('039', 'store_level_staff_submit', 'staff can submit/upload/preview store-level tasks; unify RPC submitter check')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- -- Verification -------------------------------------------------------------
-- 1) The 4 rewritten policies exist (expect 4 rows):
-- SELECT tablename, policyname FROM pg_policies
-- WHERE schemaname IN ('public','storage')
--   AND (tablename::text, policyname::text) IN (
--     VALUES ('task_results','tr_insert'), ('task_results','tr_select_staff'),
--            ('task_uploaded_files','tuf_insert'), ('objects','task_uploads_insert')
--   )
-- ORDER BY tablename, policyname;
--
-- 2) RPC carries the unified store-level branch (expect 1 row):
-- SELECT proname FROM pg_proc
-- WHERE proname = 'rpc_staff_update_task_status'
--   AND pg_get_functiondef(oid) LIKE '%assignment_mode = ''store''%store_id = v_store_id%';
--
-- 3) Tracking row:
-- SELECT version, name, applied_at FROM public.app_migrations WHERE version = '039';
