-- ============================================================
-- Migration 042: Denormalize completed_by + completed_at on tasks
-- ============================================================
-- Lets the task list and detail page show "Đã nộp bởi [Tên]" for store-level
-- tasks without joining task_results on every list row.
--
-- completed_by: the user who submitted the accepted result (NULL until done)
-- completed_at: timestamp of that submission (NULL until done)
--
-- rpc_submit_task_result (from 040) is updated here with CREATE OR REPLACE to
-- set both columns atomically when flipping the task to done.
--
-- The migration also backfills existing done tasks from task_results so the
-- new columns are accurate immediately after apply.
-- ============================================================

BEGIN;

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS completed_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- Backfill: for each done task, take the most recent task_results row.
UPDATE public.tasks t
   SET completed_by = subq.user_id,
       completed_at = subq.submitted_at
  FROM (
    SELECT DISTINCT ON (task_id)
           task_id, user_id, submitted_at
      FROM public.task_results
     ORDER BY task_id, submitted_at DESC
  ) subq
 WHERE t.id = subq.task_id
   AND t.status = 'done'
   AND t.completed_by IS NULL;

-- Update the RPC to set completed_by / completed_at on every future submit.
-- Full body identical to 040 except the UPDATE tasks adds the two columns.
CREATE OR REPLACE FUNCTION public.rpc_submit_task_result(
  p_task_id     uuid,
  p_output_data jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_role      text;
  v_store_id  uuid;
  v_task      record;
  v_is_direct boolean;
  v_is_store  boolean;
  v_has_result boolean;
  v_late      boolean;
  v_result_id uuid;
  v_now       timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'Chưa đăng nhập');
  END IF;

  SELECT role, store_id INTO v_role, v_store_id FROM public.users WHERE id = v_uid;
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('error', 'Không tìm thấy hồ sơ người dùng');
  END IF;

  SELECT * INTO v_task FROM public.tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Task không tồn tại');
  END IF;

  IF v_task.assignment_mode = 'staff_all' THEN
    RETURN jsonb_build_object('error', 'Đây là task cha — vui lòng nộp kết quả trên task con của bạn.');
  END IF;

  v_is_direct := (v_task.assigned_to IS NOT DISTINCT FROM v_uid);
  v_is_store  := (v_task.assigned_to IS NULL
                  AND v_task.assignment_mode = 'store'
                  AND v_task.store_id IS NOT NULL
                  AND v_task.store_id = v_store_id
                  AND v_role IN ('staff', 'store_manager'));

  IF NOT v_is_direct AND NOT v_is_store THEN
    RETURN jsonb_build_object('error', 'Bạn không có quyền nộp kết quả cho task này');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.task_results tr
    WHERE tr.task_id = p_task_id
      AND (NOT v_is_direct OR tr.user_id = v_uid)
      AND (v_task.resubmit_requested_at IS NULL OR tr.submitted_at > v_task.resubmit_requested_at)
  ) INTO v_has_result;

  IF v_has_result THEN
    RETURN jsonb_build_object('error', 'Task này đã có kết quả nộp rồi');
  END IF;

  v_late := (v_task.status = 'overdue')
            OR (v_task.deadline IS NOT NULL AND v_task.deadline < v_now AND v_task.status <> 'done');

  INSERT INTO public.task_results (task_id, user_id, output_data)
  VALUES (p_task_id, v_uid, p_output_data)
  RETURNING id INTO v_result_id;

  UPDATE public.tasks
     SET status       = 'done',
         completed_by = v_uid,
         completed_at = v_now,
         overdue_at   = CASE WHEN v_late THEN COALESCE(v_task.overdue_at, v_now) ELSE v_task.overdue_at END
   WHERE id = p_task_id;

  INSERT INTO public.task_status_events (task_id, from_status, to_status, actor_id, source)
  VALUES (p_task_id, v_task.status, 'done', v_uid,
          CASE WHEN v_role = 'store_manager' THEN 'store_manager' ELSE 'staff' END);

  INSERT INTO public.task_logs (task_id, action, user_id, metadata)
  VALUES (p_task_id, 'submitted', v_uid,
          jsonb_build_object(
            'output_types', (SELECT COALESCE(jsonb_agg(k), '[]'::jsonb) FROM jsonb_object_keys(p_output_data) AS k),
            'submitted_after_deadline', v_late
          ));

  UPDATE public.task_resubmit_requests
     SET status              = 'fulfilled',
         fulfilled_result_id = v_result_id,
         fulfilled_at        = v_now
   WHERE id = (
     SELECT id FROM public.task_resubmit_requests
     WHERE task_id = p_task_id AND status = 'open'
     ORDER BY requested_at DESC
     LIMIT 1
   );

  RETURN jsonb_build_object('success', true, 'result_id', v_result_id, 'submitted_late', v_late);
END;
$$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('042', 'completed_by_column', 'Add completed_by/completed_at to tasks; backfill; update rpc_submit_task_result')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- -- Verification -------------------------------------------------------------
-- 1) Columns exist:
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'tasks' AND column_name IN ('completed_by', 'completed_at');
--
-- 2) Backfill count matches done tasks with results:
-- SELECT COUNT(*) FROM public.tasks WHERE status = 'done' AND completed_by IS NOT NULL;
--
-- 3) RPC updated (contains completed_by):
-- SELECT pg_get_functiondef('public.rpc_submit_task_result(uuid,jsonb)'::regprocedure)
--   LIKE '%completed_by%' AS has_completed_by;
-- expect: t
