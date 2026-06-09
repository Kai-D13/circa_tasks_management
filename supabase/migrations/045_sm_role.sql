-- ============================================================
-- Migration 045: SM Role (Store Manager multi-store)
-- ============================================================
-- New role 'sm': regional/area manager that oversees multiple stores
-- manually assigned via sm_store_assignments.
--
-- Scope decision: SM SELECT is handled by new RLS policies below.
-- SM mutations (archive, reassign, requestResubmit, etc.) go through
-- server actions using supabaseAdmin after app-layer store validation —
-- no RLS UPDATE/INSERT/DELETE policies needed for SM.
--
-- users/stores tables already have USING (true) SELECT — SM inherits
-- them; app layer filters to assigned stores before rendering.
--
-- Rollback:
--   ALTER TABLE users DROP CONSTRAINT users_role_check;
--   ALTER TABLE users ADD CONSTRAINT users_role_check
--     CHECK (role IN ('admin','store_manager','staff'));
--   DROP TABLE sm_store_assignments;
--   DROP FUNCTION is_sm_for_store(uuid);
--   DROP POLICY tasks_select_sm ON tasks; (and all sm policies below)
--   Restore old tuf_select from migration 038.
--   Restore task_status_events.source CHECK to the 027 set (without 'sm').
-- ============================================================

BEGIN;

-- ── 1. Add 'sm' to users.role CHECK constraint ─────────────────────────────
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'store_manager', 'staff', 'sm'));


-- ── 2. sm_store_assignments: single source of truth for SM store scope ──────
CREATE TABLE IF NOT EXISTS public.sm_store_assignments (
  sm_user_id  uuid        NOT NULL REFERENCES public.users(id)  ON DELETE CASCADE,
  store_id    uuid        NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  -- Audit: which admin granted this store to the SM. SET NULL so removing the
  -- granting admin's account doesn't cascade-delete the assignment itself.
  assigned_by uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  PRIMARY KEY (sm_user_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_ssa_sm_user ON public.sm_store_assignments (sm_user_id);
CREATE INDEX IF NOT EXISTS idx_ssa_store   ON public.sm_store_assignments (store_id);

ALTER TABLE public.sm_store_assignments ENABLE ROW LEVEL SECURITY;

-- Super admin: full control (create/remove SM store assignments)
CREATE POLICY "ssa_all_super" ON public.sm_store_assignments
  FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

-- Regular admin: read-only (list SM assignments in UI)
CREATE POLICY "ssa_select_admin" ON public.sm_store_assignments
  FOR SELECT TO authenticated
  USING ((select public.get_user_role()) = 'admin');

-- SM: read own assignments (to know which stores they manage)
CREATE POLICY "ssa_select_sm" ON public.sm_store_assignments
  FOR SELECT TO authenticated
  USING (sm_user_id = (select auth.uid()));


-- ── 3. SECURITY DEFINER helper: per-call InitPlan-safe store check ──────────
CREATE OR REPLACE FUNCTION public.is_sm_for_store(p_store_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sm_store_assignments
    WHERE sm_user_id = auth.uid() AND store_id = p_store_id
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_sm_for_store(uuid) TO authenticated;


-- ── 4. tasks: SM sees tasks belonging to their assigned stores ──────────────
DROP POLICY IF EXISTS "tasks_select_sm" ON public.tasks;
CREATE POLICY "tasks_select_sm" ON public.tasks
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'sm'
    AND store_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.sm_store_assignments ssa
      WHERE ssa.sm_user_id = (select auth.uid())
        AND ssa.store_id   = tasks.store_id
    )
  );


-- ── 5. task_results: SM sees results for tasks in their stores ──────────────
DROP POLICY IF EXISTS "tr_select_sm" ON public.task_results;
CREATE POLICY "tr_select_sm" ON public.task_results
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'sm'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      JOIN public.sm_store_assignments ssa ON ssa.store_id = t.store_id
      WHERE t.id            = task_results.task_id
        AND ssa.sm_user_id  = (select auth.uid())
    )
  );


-- ── 6. task_logs: SM sees logs for tasks in their stores ────────────────────
DROP POLICY IF EXISTS "tl_select_sm" ON public.task_logs;
CREATE POLICY "tl_select_sm" ON public.task_logs
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'sm'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      JOIN public.sm_store_assignments ssa ON ssa.store_id = t.store_id
      WHERE t.id            = task_logs.task_id
        AND ssa.sm_user_id  = (select auth.uid())
    )
  );


-- ── 7. task_uploaded_files: extend tuf_select to include SM ────────────────
-- Current tuf_select (from 038): uploaded_by = uid OR admin.
-- SM needs to see file metadata for tasks in their assigned stores.
DROP POLICY IF EXISTS tuf_select ON public.task_uploaded_files;
CREATE POLICY tuf_select ON public.task_uploaded_files
  FOR SELECT TO authenticated
  USING (
    uploaded_by = (select auth.uid())
    OR EXISTS (SELECT 1 FROM public.users u
               WHERE u.id = (select auth.uid()) AND u.role = 'admin')
    OR (
      (select public.get_user_role()) = 'sm'
      AND EXISTS (
        SELECT 1 FROM public.tasks t
        JOIN public.sm_store_assignments ssa ON ssa.store_id = t.store_id
        WHERE t.id           = task_uploaded_files.task_id
          AND ssa.sm_user_id = (select auth.uid())
      )
    )
  );


-- ── 8. task_review_notes: SM sees notes for tasks in their stores ───────────
DROP POLICY IF EXISTS "trn_select_sm" ON public.task_review_notes;
CREATE POLICY "trn_select_sm" ON public.task_review_notes
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'sm'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      JOIN public.sm_store_assignments ssa ON ssa.store_id = t.store_id
      WHERE t.id            = task_review_notes.task_id
        AND ssa.sm_user_id  = (select auth.uid())
    )
  );


-- ── 9. task_feedback_threads: SM sees threads for tasks in their stores ─────
DROP POLICY IF EXISTS "tft_select_sm" ON public.task_feedback_threads;
CREATE POLICY "tft_select_sm" ON public.task_feedback_threads
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'sm'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      JOIN public.sm_store_assignments ssa ON ssa.store_id = t.store_id
      WHERE t.id            = task_feedback_threads.task_id
        AND ssa.sm_user_id  = (select auth.uid())
    )
  );


-- ── 10. task_feedback_messages: SM sees messages in threads for their stores ─
DROP POLICY IF EXISTS "tfm_select_sm" ON public.task_feedback_messages;
CREATE POLICY "tfm_select_sm" ON public.task_feedback_messages
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'sm'
    AND EXISTS (
      SELECT 1 FROM public.task_feedback_threads th
      JOIN public.tasks t  ON t.id  = th.task_id
      JOIN public.sm_store_assignments ssa ON ssa.store_id = t.store_id
      WHERE th.id           = task_feedback_messages.thread_id
        AND ssa.sm_user_id  = (select auth.uid())
    )
  );


-- ── 11. task_broadcasts: SM sees broadcasts with tasks in their stores ───────
DROP POLICY IF EXISTS "tb_select_sm" ON public.task_broadcasts;
CREATE POLICY "tb_select_sm" ON public.task_broadcasts
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'sm'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      JOIN public.sm_store_assignments ssa ON ssa.store_id = t.store_id
      WHERE t.broadcast_id  = task_broadcasts.id
        AND ssa.sm_user_id  = (select auth.uid())
    )
  );


-- ── 12. task_resubmit_requests: SM sees requests for tasks in their stores ──
DROP POLICY IF EXISTS "trr_select_sm" ON public.task_resubmit_requests;
CREATE POLICY "trr_select_sm" ON public.task_resubmit_requests
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'sm'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      JOIN public.sm_store_assignments ssa ON ssa.store_id = t.store_id
      WHERE t.id            = task_resubmit_requests.task_id
        AND ssa.sm_user_id  = (select auth.uid())
    )
  );


-- ── 13. task_status_events: SM sees events for tasks in their stores ─────────
DROP POLICY IF EXISTS "tse_select_sm" ON public.task_status_events;
CREATE POLICY "tse_select_sm" ON public.task_status_events
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'sm'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      JOIN public.sm_store_assignments ssa ON ssa.store_id = t.store_id
      WHERE t.id            = task_status_events.task_id
        AND ssa.sm_user_id  = (select auth.uid())
    )
  );


-- ── 14. task_status_events.source: allow 'sm' ──────────────────────────────
-- requestResubmit (and future SM-driven transitions) writes source='sm'.
-- The original CHECK from migration 027 only allowed admin/staff/store_manager/
-- cron/system, so an SM resubmit would silently fail the status-event insert
-- and leave reporting/audit incomplete. Extend the allowed set here.
ALTER TABLE public.task_status_events
  DROP CONSTRAINT IF EXISTS task_status_events_source_check;
ALTER TABLE public.task_status_events
  ADD CONSTRAINT task_status_events_source_check
  CHECK (source IN ('admin', 'staff', 'store_manager', 'sm', 'cron', 'system'));


-- ── Migration tracking ───────────────────────────────────────────────────────
INSERT INTO public.app_migrations (version, name, notes)
VALUES ('045', 'sm_role',
        'SM role: sm_store_assignments table (+assigned_by) + RLS, is_sm_for_store() helper, SM SELECT policies on tasks/results/logs/uploads/notes/feedback/broadcasts/resubmit/events, task_status_events.source allows sm')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Reload PostgREST schema cache — required after new table + new function
NOTIFY pgrst, 'reload schema';

-- -- Verification ---------------------------------------------------------------
-- 1) role CHECK updated:
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid = 'public.users'::regclass AND contype = 'c' AND conname LIKE '%role%';
-- expect: role IN ('admin','store_manager','staff','sm')
--
-- 2) Table exists with RLS enabled:
-- SELECT tablename, rowsecurity FROM pg_tables
-- WHERE tablename = 'sm_store_assignments';
-- expect: 1 row, rowsecurity = true
--
-- 3) All 13 SM policies created:
-- SELECT tablename, policyname FROM pg_policies
-- WHERE schemaname = 'public' AND policyname LIKE '%_sm%'
-- ORDER BY tablename, policyname;
-- expect: tasks_select_sm, tr_select_sm, tl_select_sm, tuf_select (updated),
--   trn_select_sm, tft_select_sm, tfm_select_sm, tb_select_sm,
--   trr_select_sm, tse_select_sm, ssa_all_super, ssa_select_admin, ssa_select_sm
--
-- 4) Helper function exists:
-- SELECT proname, prosecdef FROM pg_proc
-- WHERE proname = 'is_sm_for_store';
-- expect: 1 row, prosecdef = true
--
-- 5) task_status_events.source CHECK includes 'sm':
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid = 'public.task_status_events'::regclass AND conname LIKE '%source%';
-- expect: source IN ('admin','staff','store_manager','sm','cron','system')
--
-- 6) assigned_by column exists on sm_store_assignments:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'sm_store_assignments' AND column_name = 'assigned_by';
-- expect: 1 row
