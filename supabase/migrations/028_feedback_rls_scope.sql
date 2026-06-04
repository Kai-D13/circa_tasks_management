-- ============================================================
-- 028 — Scope feedback thread/message visibility to task owner only
-- ============================================================
-- Migration 024 added a collaborator branch to tft_select_admin and
-- tfm_select_admin, letting any admin who is a task_collaborator read
-- feedback threads. This was a mistake: the feedback channel is a private
-- Q&A between the task owner/super admin and the store manager — it is not
-- a collaborator-facing channel. Collaborators use review notes instead.
--
-- This migration drops the collaborator branch from both SELECT policies.
-- The tft_update_admin / tft_update_manager / tfm_insert_* policies are
-- unchanged (they never included a collaborator branch).
-- ============================================================

-- ── task_feedback_threads ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "tft_select_admin" ON public.task_feedback_threads;

CREATE POLICY "tft_select_admin" ON public.task_feedback_threads
  FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (
      public.get_user_role() = 'admin'
      AND EXISTS (
        SELECT 1 FROM public.tasks t
        WHERE t.id = public.task_feedback_threads.task_id
          AND t.created_by = auth.uid()
      )
    )
  );

-- ── task_feedback_messages ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "tfm_select_admin" ON public.task_feedback_messages;

CREATE POLICY "tfm_select_admin" ON public.task_feedback_messages
  FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (
      public.get_user_role() = 'admin'
      AND EXISTS (
        SELECT 1
        FROM public.task_feedback_threads th
        JOIN public.tasks t ON t.id = th.task_id
        WHERE th.id = public.task_feedback_messages.thread_id
          AND t.created_by = auth.uid()
      )
    )
  );
