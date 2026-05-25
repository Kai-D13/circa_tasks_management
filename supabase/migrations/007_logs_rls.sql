-- ============================================================
-- Fix task_logs RLS:
--   1. Staff: see own actions + all logs on tasks assigned to them
--   2. Store Manager: see own logs + logs by users in their store
-- ============================================================

-- Staff can read logs they created, or logs on tasks assigned to them
-- (allows staff to see manager review notes on their own tasks)
CREATE POLICY "tl_select_staff" ON public.task_logs FOR SELECT TO authenticated
  USING (
    get_user_role() = 'staff'
    AND (
      user_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.tasks t
        WHERE t.id = task_id AND t.assigned_to = auth.uid()
      )
    )
  );

-- Replace store_manager policy: filter by who acted, not which task
DROP POLICY IF EXISTS "tl_select_manager" ON public.task_logs;
CREATE POLICY "tl_select_manager" ON public.task_logs FOR SELECT TO authenticated
  USING (
    get_user_role() = 'store_manager'
    AND (
      user_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = user_id
          AND u.store_id = get_user_store_id()
      )
    )
  );
