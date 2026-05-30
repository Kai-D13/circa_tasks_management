-- ============================================================
-- Migration 014: Fix task_logs RLS for store_manager
-- ============================================================
-- DEPLOYMENT ORDER: Apply this migration BEFORE deploying the
-- updated logs/page.tsx — the app-level user_id filter for
-- store_manager was removed in the same release.
-- ============================================================
-- Problem: tl_select_manager (from 007) shows logs created by
-- users in their store, but admin-created logs (resubmit_requested,
-- review_note) are invisible even when the task belongs to their store.
-- Fix: grant store_manager visibility to ALL logs on tasks in their
-- store, PLUS their own logs (covers null-store tasks they created).
-- ============================================================

DROP POLICY IF EXISTS "tl_select_manager" ON public.task_logs;

CREATE POLICY "tl_select_manager" ON public.task_logs FOR SELECT TO authenticated
  USING (
    get_user_role() = 'store_manager'
    AND (
      -- All logs on tasks that belong to their store
      EXISTS (
        SELECT 1 FROM public.tasks t
        WHERE t.id = task_id
          AND t.store_id = get_user_store_id()
      )
      -- Own logs (covers null-store tasks the manager created themselves)
      OR user_id = auth.uid()
    )
  );
