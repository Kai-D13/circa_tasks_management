-- ============================================================
-- 025 — Overdue tasks become submittable (with persistent late trace)
-- ============================================================
-- New rule: a task past its deadline can still be submitted. The old behaviour
-- hard-blocked submit/resubmit/status-change while overdue, leaving a store that
-- missed the deadline unable to deliver until an admin extended the deadline.
--
-- To keep an admin-visible "đã từng quá hạn" trace that survives the done
-- transition, we add tasks.overdue_at and recreate the staff status RPC without
-- its overdue guard. The submit/resubmit/extendDeadline TS actions and the UI
-- gates are updated alongside this migration.
-- ------------------------------------------------------------

-- 1. Persistent late marker. Stamped once when a task first passes its deadline
--    (by the overdue cron, or at submit time if the cron hasn't run yet) and
--    cleared by extendDeadline() when an overdue task is reset.
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS overdue_at timestamptz;

-- 2. Recreate rpc_staff_update_task_status WITHOUT the overdue guard.
--    Identical to migration 022 except the "Block status changes when overdue"
--    block is removed, so a store manager / assignee can still move an overdue
--    task to todo / in_progress. All other checks are unchanged.
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

  -- Caller must be the submitter for this task:
  --   staff         -> direct assignee
  --   store_manager -> direct assignee OR store-level submitter for their store
  IF v_role = 'staff' THEN
    v_is_submitter := (v_task.assigned_to IS NOT DISTINCT FROM auth.uid());
  ELSE -- store_manager
    v_is_submitter := (v_task.assigned_to IS NOT DISTINCT FROM auth.uid())
      OR (v_task.assigned_to IS NULL
          AND v_task.store_id IS NOT NULL
          AND v_task.store_id = v_store_id);
  END IF;

  IF NOT v_is_submitter THEN
    RETURN jsonb_build_object('error', 'Bạn không phải người thực hiện task này');
  END IF;

  -- NOTE: the overdue guard from migration 022 is intentionally removed here.
  -- Overdue tasks are now actionable; lateness is tracked via tasks.overdue_at.

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
