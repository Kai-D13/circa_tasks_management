-- ============================================================
-- Migration 040: Atomic task submit (race-safe "Cua hang nop")
-- ============================================================
-- Now that any staff OR store_manager of a store can submit a store-level task
-- (migration 039), the old app flow (SELECT dup-check -> INSERT result -> UPDATE
-- status, all separate statements) has a race: two store members submitting at
-- nearly the same time can both pass the dup-check and create two results, or a
-- crash between INSERT and UPDATE can leave a result with the task not 'done'.
--
-- This RPC does the whole submit in ONE transaction and takes a row lock on the
-- task (SELECT ... FOR UPDATE), so concurrent submits on the same task serialize:
-- the second caller blocks until the first commits, then sees the existing result
-- and is rejected. It handles BOTH direct-assigned and store-level submits, so
-- every submit path becomes atomic (also fixes the half-done state for direct
-- assignees). Logic mirrors the pre-040 submitTask server action exactly.
--
-- SECURITY DEFINER: the function owner performs the writes (bypassing RLS), but
-- it re-validates submitter identity/role/store itself (stricter than RLS and
-- race-safe). Same pattern as rpc_staff_update_task_status / rpc_create_import_tasks.
--
-- Best-effort, non-transactional side effects (upload-file linking, resubmit-
-- request fulfillment, notifications) stay in the server action after this call.
--
-- Rollback: DROP FUNCTION public.rpc_submit_task_result(uuid, jsonb); and revert
-- the submitTask server action to the inline insert/update flow.
-- ============================================================

BEGIN;

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

  -- Row lock: concurrent submits on the same task serialize on this line.
  SELECT * INTO v_task FROM public.tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Task không tồn tại');
  END IF;

  -- A staff_all parent is overview-only; results go on the per-staff child tasks.
  IF v_task.assignment_mode = 'staff_all' THEN
    RETURN jsonb_build_object('error', 'Đây là task cha — vui lòng nộp kết quả trên task con của bạn.');
  END IF;

  -- Who may submit:
  --   direct    -> task.assigned_to = caller
  --   store-mode -> unassigned 'store' task; caller is staff/manager of the store
  v_is_direct := (v_task.assigned_to IS NOT DISTINCT FROM v_uid);
  v_is_store  := (v_task.assigned_to IS NULL
                  AND v_task.assignment_mode = 'store'
                  AND v_task.store_id IS NOT NULL
                  AND v_task.store_id = v_store_id
                  AND v_role IN ('staff', 'store_manager'));

  IF NOT v_is_direct AND NOT v_is_store THEN
    RETURN jsonb_build_object('error', 'Bạn không có quyền nộp kết quả cho task này');
  END IF;

  -- Duplicate check (inside the lock): direct -> per user; store-level -> per task.
  -- Only results AFTER the last resubmit request count as blocking.
  SELECT EXISTS (
    SELECT 1 FROM public.task_results tr
    WHERE tr.task_id = p_task_id
      AND (NOT v_is_direct OR tr.user_id = v_uid)
      AND (v_task.resubmit_requested_at IS NULL OR tr.submitted_at > v_task.resubmit_requested_at)
  ) INTO v_has_result;

  IF v_has_result THEN
    RETURN jsonb_build_object('error', 'Task này đã có kết quả nộp rồi');
  END IF;

  -- Effective-overdue at submit time (mirrors getEffectiveStatus): a submission is
  -- late when the task is already 'overdue' or the deadline has passed (not done).
  v_late := (v_task.status = 'overdue')
            OR (v_task.deadline IS NOT NULL AND v_task.deadline < v_now AND v_task.status <> 'done');

  INSERT INTO public.task_results (task_id, user_id, output_data)
  VALUES (p_task_id, v_uid, p_output_data)
  RETURNING id INTO v_result_id;

  -- Preserve an earlier cron-set overdue_at so the "Hoàn thành trễ" marker survives.
  UPDATE public.tasks
     SET status     = 'done',
         overdue_at = CASE WHEN v_late THEN COALESCE(v_task.overdue_at, v_now) ELSE v_task.overdue_at END
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

  -- Fulfill the most recent open resubmit request atomically with the result.
  -- Doing this inside the transaction prevents the half-done state where a result
  -- exists but the request remains 'open', which corrupts admin audit views.
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

GRANT EXECUTE ON FUNCTION public.rpc_submit_task_result(uuid, jsonb) TO authenticated;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('040', 'atomic_submit', 'rpc_submit_task_result: locked, transactional task submit (race-safe)')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- -- Verification -------------------------------------------------------------
-- 1) Function exists and is granted:
-- SELECT proname, pg_get_function_identity_arguments(oid)
-- FROM pg_proc WHERE proname = 'rpc_submit_task_result';
--
-- 2) Functional (as a staff JWT): submit a store-level task in your store once
--    -> { success, result_id, submitted_late }; submit again -> error
--    'Task này đã có kết quả nộp rồi'; the task is 'done' and a single
--    task_results row exists.
