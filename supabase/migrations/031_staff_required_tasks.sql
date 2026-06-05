-- ============================================================
-- 031 — Staff-required tasks (Parent + per-staff Child)
-- ============================================================
-- Adds a third assignment mode so an admin can require EACH pharmacist in a
-- store to submit individually, instead of the store_manager submitting one
-- result for the whole store.
--
--   assignment_mode = 'store'      existing: store_manager submits 1 result
--   assignment_mode = 'staff_all'  NEW parent: overview only, NOT submittable
--   assignment_mode = 'user'       NEW child:  one per staff, each staff submits
--
-- Parent and child are ordinary tasks rows. The parent links its children via
-- the new tasks.parent_task_id self-reference. Existing tasks RLS already covers
-- both rows (parent is created visibility='private'/assigned_to=NULL so staff
-- can't see it; managers/admins see it via their role-scoped policies).
--
-- This migration is AD-HOC only. Recurring staff_all is deferred: the recurring
-- idempotency index idx_tasks_schedule_store_day (schedule, store, day) would
-- collide with multiple children and must be widened separately.
--
-- Apply in Supabase SQL Editor before deploying the code changes.
-- ------------------------------------------------------------

-- 1. Allow 'staff_all' in the assignment_mode CHECK.
--    Migration 013 created the constraint inline on ADD COLUMN, so it is
--    auto-named tasks_assignment_mode_check.
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_assignment_mode_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_assignment_mode_check
  CHECK (assignment_mode IN ('store','user','staff_all'));

-- 2. Parent ⇄ child self-reference. CASCADE so deleting a parent removes its
--    children (children are meaningless without their parent).
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS parent_task_id uuid REFERENCES public.tasks(id) ON DELETE CASCADE;

-- 3. Indexes.
--    parent_task_id: list/detail group children under their parent.
--    (assigned_to, status): staff "my tasks" + parent progress rollup.
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id
  ON public.tasks (parent_task_id)
  WHERE parent_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_status
  ON public.tasks (assigned_to, status)
  WHERE assigned_to IS NOT NULL;

-- 4. Recreate rpc_staff_update_task_status with a parent guard.
--    Identical to migration 025 except the staff_all parent block added after
--    the submitter check: a staff_all parent has no submitter and must never be
--    moved through the staff status flow.
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

  -- A staff_all parent is overview-only — it has no submitter and cannot change
  -- status. Status flows happen on the per-staff child tasks.
  IF v_task.assignment_mode = 'staff_all' THEN
    RETURN jsonb_build_object('error', 'Task cha không thể đổi trạng thái — hãy thao tác trên task con.');
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

  -- NOTE: the overdue guard from migration 022 is intentionally removed (see 025).
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

-- ── Verification queries ──────────────────────────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.tasks'::regclass AND conname = 'tasks_assignment_mode_check';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'tasks' AND column_name = 'parent_task_id';
-- SELECT indexname FROM pg_indexes WHERE tablename = 'tasks'
--   AND indexname IN ('idx_tasks_parent_task_id','idx_tasks_assigned_status');
