-- ============================================================
-- Migration 010: Security hardening
-- ============================================================

-- 1. Track when a manager last requested resubmission
--    Used to determine if staff can submit again (submitted_at > resubmit_requested_at)
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS resubmit_requested_at timestamptz;

-- ============================================================
-- 2. Fix task_results RLS — replace USING (true) with role-based policies
-- ============================================================
DROP POLICY IF EXISTS "tr_select" ON public.task_results;

-- Admin: sees all submissions
CREATE POLICY "tr_select_admin" ON public.task_results FOR SELECT TO authenticated
  USING (get_user_role() = 'admin');

-- Store Manager: sees submissions only from tasks in their store
CREATE POLICY "tr_select_manager" ON public.task_results FOR SELECT TO authenticated
  USING (
    get_user_role() = 'store_manager'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      WHERE t.id = task_id AND t.store_id = get_user_store_id()
    )
  );

-- Staff: sees only their own submissions
CREATE POLICY "tr_select_staff" ON public.task_results FOR SELECT TO authenticated
  USING (get_user_role() = 'staff' AND user_id = auth.uid());

-- ============================================================
-- 3. Harden tr_insert: staff can only submit for tasks assigned to them
-- ============================================================
DROP POLICY IF EXISTS "tr_insert" ON public.task_results;

CREATE POLICY "tr_insert" ON public.task_results FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      WHERE t.id = task_id AND t.assigned_to = auth.uid()
    )
  );

-- ============================================================
-- 4. SECURITY DEFINER RPC for staff status update
--    Staff can ONLY update the status column via this function.
--    Direct UPDATE policy for staff is dropped (see step 5).
-- ============================================================
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
  v_role       text;
  v_task       record;
  v_has_result boolean;
BEGIN
  SELECT role INTO v_role FROM public.users WHERE id = auth.uid();
  IF v_role <> 'staff' THEN
    RETURN jsonb_build_object('error', 'Chỉ staff mới dùng được API này');
  END IF;

  SELECT * INTO v_task FROM public.tasks WHERE id = p_task_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Task không tồn tại');
  END IF;

  IF v_task.assigned_to IS DISTINCT FROM auth.uid() THEN
    RETURN jsonb_build_object('error', 'Task không được giao cho bạn');
  END IF;

  IF p_status NOT IN ('todo', 'in_progress') THEN
    RETURN jsonb_build_object('error', 'Không có quyền đổi sang trạng thái này');
  END IF;

  IF p_status = 'in_progress' AND (p_note IS NULL OR trim(p_note) = '') THEN
    RETURN jsonb_build_object('error', 'Bắt buộc phải ghi chú khi chuyển sang Đang thực hiện');
  END IF;

  -- Block if staff already submitted after the last resubmit request
  SELECT EXISTS (
    SELECT 1 FROM public.task_results tr
    WHERE tr.task_id = p_task_id
      AND tr.user_id = auth.uid()
      AND (v_task.resubmit_requested_at IS NULL OR tr.submitted_at > v_task.resubmit_requested_at)
  ) INTO v_has_result;

  IF v_has_result THEN
    RETURN jsonb_build_object('error', 'Bạn đã nộp kết quả rồi, không thể thay đổi trạng thái');
  END IF;

  -- Update ONLY the status column
  UPDATE public.tasks SET status = p_status WHERE id = p_task_id;

  -- Write audit log
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

-- 5. Drop the broad staff UPDATE policy — replaced by the RPC above
DROP POLICY IF EXISTS "tasks_update_staff" ON public.tasks;
