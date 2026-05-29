-- ============================================================
-- Migration 014: Fix task_logs RLS for store_manager
-- ============================================================
-- Problem: tl_select_manager (from 007) allows store managers to read
-- logs created by users in their store. But admin-created logs
-- (e.g. resubmit_requested, review_note) are not visible to store managers
-- even when the log belongs to a task in their store.
-- Fix: grant store_manager visibility to ALL logs on tasks in their store,
-- regardless of who wrote the log.
-- ============================================================

DROP POLICY IF EXISTS "tl_select_manager" ON public.task_logs;

CREATE POLICY "tl_select_manager" ON public.task_logs FOR SELECT TO authenticated
  USING (
    get_user_role() = 'store_manager'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      WHERE t.id = task_id
        AND t.store_id = get_user_store_id()
    )
  );
