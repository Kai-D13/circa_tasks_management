-- ============================================================
-- Migration 012: Allow store-level submit for broadcast tasks
-- ============================================================
-- Context: broadcast tasks are created with assigned_to = NULL.
-- Store managers must be able to submit on behalf of their store.
-- Previous tr_insert policy only allowed assigned_to = auth.uid(),
-- which blocked store managers from submitting unassigned tasks.
-- ============================================================

-- Replace tr_insert with store-aware policy
DROP POLICY IF EXISTS "tr_insert" ON public.task_results;

CREATE POLICY "tr_insert" ON public.task_results FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (
      -- Case 1: task is explicitly assigned to this user (any role)
      EXISTS (
        SELECT 1 FROM public.tasks t
        WHERE t.id = task_id
          AND t.assigned_to = auth.uid()
      )
      OR
      -- Case 2: task has no assignee, submitting user is store_manager of that store
      EXISTS (
        SELECT 1 FROM public.tasks t
        JOIN public.users u ON u.id = auth.uid()
        WHERE t.id = task_id
          AND t.assigned_to IS NULL
          AND t.store_id IS NOT NULL
          AND t.store_id = u.store_id
          AND u.role = 'store_manager'
      )
    )
  );
