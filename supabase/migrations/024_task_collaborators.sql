-- ============================================================
-- Migration 024: Task Collaborators — admin task sharing
-- ============================================================
-- Allows a task owner (or super admin) to grant another admin
-- read or editor access to a specific task.
--
-- Editor scope (confirmed): add review notes + request resubmit.
-- Delete / archive / extend deadline / reassign / direct status
-- change remain owner + super admin only.
--
-- Column qualification note: all EXISTS subqueries on task_collaborators
-- use fully-qualified outer-table column names (e.g. public.tasks.id,
-- public.task_logs.task_id) to prevent Postgres from resolving the
-- unqualified name against the subquery's inner table first, which would
-- produce a tautology (tc.task_id = tc.task_id) and leak data across tasks.
--
-- Recursion-safe design: task_collaborators.SELECT policy uses only its
-- own columns (admin_id, invited_by) — no tasks reference, no cycle.
-- tasks.SELECT → task_collaborators EXISTS uses admin_id only → safe.
--
-- invited_by invariant: always set to task.created_by (not the calling user)
-- so the task owner can always see rows via `invited_by = auth.uid()`, even
-- when the share was performed by the super admin.
-- ============================================================

-- ── table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.task_collaborators (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid        NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  admin_id    uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  permission  text        NOT NULL CHECK (permission IN ('view', 'editor')),
  invited_by  uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, admin_id)
);

CREATE INDEX IF NOT EXISTS idx_tc_task_admin
  ON public.task_collaborators (task_id, admin_id);

ALTER TABLE public.task_collaborators ENABLE ROW LEVEL SECURITY;

-- ── task_collaborators policies ───────────────────────────────
-- SELECT: own row (admin_id) OR rows invited by the task owner.
-- invited_by is always set to task.created_by so the owner sees all shares
-- for their tasks via `invited_by = auth.uid()`.
-- No tasks reference → no recursion risk.
DROP POLICY IF EXISTS "tc_select" ON public.task_collaborators;
CREATE POLICY "tc_select" ON public.task_collaborators FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR admin_id   = auth.uid()
    OR invited_by = auth.uid()
  );

-- INSERT: caller must be admin + (super admin OR task owner).
-- invited_by must equal the task's created_by in all cases — the server action
-- always passes task.created_by, not the caller's own uid.
-- Super admin branch: is_super_admin() and invited_by = task.created_by verified
--   via EXISTS.
-- Owner branch: invited_by = auth.uid() which equals task.created_by.
DROP POLICY IF EXISTS "tc_insert" ON public.task_collaborators;
CREATE POLICY "tc_insert" ON public.task_collaborators FOR INSERT TO authenticated
  WITH CHECK (
    get_user_role() = 'admin'
    -- invited_by must always be the task owner so they can see their shares
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      WHERE t.id = task_id AND t.created_by = invited_by
    )
    AND (
      public.is_super_admin()
      OR invited_by = auth.uid()   -- non-super admin must be the owner themselves
    )
  );

-- UPDATE / DELETE: separate policies so tc_insert's stricter WITH CHECK is not
-- weakened by a FOR ALL that also applies a looser USING on INSERT.
DROP POLICY IF EXISTS "tc_modify"  ON public.task_collaborators;
DROP POLICY IF EXISTS "tc_update"  ON public.task_collaborators;
DROP POLICY IF EXISTS "tc_delete"  ON public.task_collaborators;

CREATE POLICY "tc_update" ON public.task_collaborators FOR UPDATE TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.created_by = auth.uid())
  )
  WITH CHECK (
    public.is_super_admin()
    OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.created_by = auth.uid())
  );

CREATE POLICY "tc_delete" ON public.task_collaborators FOR DELETE TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.created_by = auth.uid())
  );

-- ── tasks SELECT: collaborator view ──────────────────────────
-- Qualification: tc.task_id = public.tasks.id (not tc.id — task_collaborators
-- also has an `id` column; unqualified `id` would resolve to tc.id, making the
-- EXISTS always false and preventing collaborators from seeing shared tasks).
DROP POLICY IF EXISTS "tasks_select_admin" ON public.tasks;
CREATE POLICY "tasks_select_admin" ON public.tasks FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND created_by = auth.uid())
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.task_collaborators tc
      WHERE tc.task_id = public.tasks.id AND tc.admin_id = auth.uid()
    ))
  );

-- tasks UPDATE: owner + super only — no collaborator UPDATE.
-- requestResubmit() uses supabaseAdmin (service role) after server-side
-- validation, so editors don't need a DB-level UPDATE grant.
DROP POLICY IF EXISTS "tasks_update_admin" ON public.tasks;
CREATE POLICY "tasks_update_admin" ON public.tasks FOR UPDATE TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND created_by = auth.uid())
  )
  WITH CHECK (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND created_by = auth.uid())
  );

-- ── task_results: scope admin SELECT to own tasks + collaborator tasks ──
-- Previously "get_user_role() = 'admin'" gave all admins access to all results.
-- Now scoped: own tasks OR shared tasks OR super admin.
-- Qualification: tc.task_id = public.task_results.task_id (task_collaborators
-- also has task_id; unqualified would resolve to inner tc.task_id = tautology).
DROP POLICY IF EXISTS "tr_select_admin" ON public.task_results;
CREATE POLICY "tr_select_admin" ON public.task_results FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.created_by = auth.uid()
    ))
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.task_collaborators tc
      WHERE tc.task_id = public.task_results.task_id AND tc.admin_id = auth.uid()
    ))
  );

-- ── task_logs SELECT: collaborators can read audit trail ──────
-- Qualification: tc.task_id = public.task_logs.task_id (both task_logs and
-- task_collaborators have a task_id column; unqualified would tautology).
DROP POLICY IF EXISTS "tl_select_admin" ON public.task_logs;
CREATE POLICY "tl_select_admin" ON public.task_logs FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (
      get_user_role() = 'admin'
      AND (
        user_id = auth.uid()
        OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.created_by = auth.uid())
        OR EXISTS (
          SELECT 1 FROM public.task_collaborators tc
          WHERE tc.task_id = public.task_logs.task_id AND tc.admin_id = auth.uid()
        )
      )
    )
  );

-- ── task_review_notes: collaborators read; editors can write 'review_note' ──
-- Qualification: tc.task_id = public.task_review_notes.task_id.
DROP POLICY IF EXISTS "trn_select_admin" ON public.task_review_notes;
CREATE POLICY "trn_select_admin" ON public.task_review_notes FOR SELECT TO authenticated
  USING (
    get_user_role() = 'admin'
    AND (
      public.is_super_admin()
      OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.created_by = auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.task_collaborators tc
        WHERE tc.task_id = public.task_review_notes.task_id AND tc.admin_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "trn_insert_admin" ON public.task_review_notes;
CREATE POLICY "trn_insert_admin" ON public.task_review_notes FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND get_user_role() = 'admin'
    AND (
      -- Super admin or task owner: may insert any kind.
      public.is_super_admin()
      OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.created_by = auth.uid())
      -- Editor collaborator: review_note ONLY. resubmit_request is inserted by
      -- requestResubmit() via supabaseAdmin so forging a banner without the
      -- corresponding status change is impossible at the DB level.
      OR (kind = 'review_note' AND EXISTS (
        SELECT 1 FROM public.task_collaborators tc
        WHERE tc.task_id = public.task_review_notes.task_id
          AND tc.admin_id = auth.uid()
          AND tc.permission = 'editor'
      ))
    )
  );

-- ── task_feedback_threads: collaborators can read ─────────────
-- Qualification: tc.task_id = public.task_feedback_threads.task_id.
DROP POLICY IF EXISTS "tft_select_admin" ON public.task_feedback_threads;
CREATE POLICY "tft_select_admin" ON public.task_feedback_threads FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.created_by = auth.uid()
    ))
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.task_collaborators tc
      WHERE tc.task_id = public.task_feedback_threads.task_id AND tc.admin_id = auth.uid()
    ))
  );

-- ── task_feedback_messages: collaborators can read ────────────
-- Using a JOIN to task_feedback_threads; all columns are table-qualified so
-- no ambiguity.
DROP POLICY IF EXISTS "tfm_select_admin" ON public.task_feedback_messages;
CREATE POLICY "tfm_select_admin" ON public.task_feedback_messages FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.task_feedback_threads th
      JOIN public.tasks t ON t.id = th.task_id
      WHERE th.id = thread_id AND t.created_by = auth.uid()
    ))
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.task_feedback_threads th
      JOIN public.task_collaborators tc ON tc.task_id = th.task_id
      WHERE th.id = thread_id AND tc.admin_id = auth.uid()
    ))
  );
