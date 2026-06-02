-- ============================================================
-- Migration 022: Store Manager task lockdown (executor-only)
-- ============================================================
-- Migration 021 scoped the ADMIN task policies to own-created rows but left the
-- original manager write policies from 001_init.sql in place. Postgres RLS
-- policies are OR'd, so a Store Manager still had full create/edit rights on
-- their store's tasks. This migration removes those manager write paths and
-- redefines Store Manager (and Staff) as executors:
--
--   KEEP : view store/assigned tasks, mark in_progress, submit results, feedback.
--   LOSE : create / edit / delete / reassign / archive / restore / extend
--          deadline / request resubmit / admin-style status control.
--
-- in_progress is preserved for executors via the status RPC (extended below),
-- NOT via a broad table UPDATE policy.
--
-- Idempotent: DROP POLICY IF EXISTS before changes; CREATE OR REPLACE function.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Drop the leftover manager write policies (the blocker)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "tasks_insert_manager" ON public.tasks;
DROP POLICY IF EXISTS "tasks_update_manager" ON public.tasks;

-- task_assignments: app uses tasks.assigned_to, not this table, so manager
-- write here is unused. Drop the broad FOR ALL policy; ta_select (read) stays.
DROP POLICY IF EXISTS "ta_manage" ON public.task_assignments;

-- task_templates: managers no longer manage templates. tt_select keeps read
-- for store_manager/staff; tt_modify_admin (own-scope, from 021) keeps admin write.
DROP POLICY IF EXISTS "tt_modify_manager" ON public.task_templates;

-- ------------------------------------------------------------
-- 2. Extend the status RPC to keep in_progress for executors
-- ------------------------------------------------------------
-- Originally (010) staff-only. Now also allows a store_manager who is the
-- submitter for the task (direct assignee OR store-level submitter). Still only
-- permits todo / in_progress; admins set done/other via the normal path.
-- SECURITY DEFINER → runs as table owner, so it does not need a tasks UPDATE
-- policy (which we just removed for managers).
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

  -- Block status changes when the task is effectively overdue: the DB status
  -- has been flipped to 'overdue' by the cron, OR the deadline has passed
  -- even if the status column hasn't caught up yet. Mirrors submitTask() guard.
  IF v_task.status = 'overdue'
     OR (v_task.deadline IS NOT NULL
         AND v_task.deadline < now()
         AND v_task.status NOT IN ('done', 'overdue'))
  THEN
    RETURN jsonb_build_object('error', 'Task đã quá hạn. Vui lòng liên hệ quản lý để gia hạn deadline.');
  END IF;

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

-- ------------------------------------------------------------
-- 3. Drop manager INSERT policy on task_review_notes
-- ------------------------------------------------------------
-- Migration 021 gave store managers a narrow INSERT right for
-- kind = 'resubmit_request'. Since migration 022 removes requestResubmit()
-- from the manager path entirely, managers have no legitimate reason to
-- write into task_review_notes at all. Dropping the policy prevents a
-- manager from forging "Yêu cầu làm lại" banners visible to submitters.
-- Managers use "Trao đổi với Admin" (feedback threads) instead.
DROP POLICY IF EXISTS "trn_insert_manager" ON public.task_review_notes;
