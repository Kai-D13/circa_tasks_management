-- ============================================================
-- Migration 021: Super Admin vs Sub Admin scoping + logs hardening
-- ============================================================
-- Summary of changes:
--   1. Sub-admin OWN-SCOPE on tasks/broadcasts/templates/schedules/
--      schedule_stores/generation_runs/feedback (non-super admins see/
--      edit/delete only rows they created).
--   2. task_logs leak fix: store managers revert to actor-based visibility
--      (no longer see admin-authored log rows).
--   3. task_logs INSERT hardened: user_id must equal the caller.
--   4. notifications INSERT locked to service role (server actions switch
--      to supabaseAdmin; no authenticated client can forge notifications).
--   5. task_review_notes: new table for review-note / resubmit-reason text,
--      with fine-grained RLS so managers can read notes on their store's
--      tasks and assigned staff can read notes on their assigned tasks,
--      without exposing the full audit log.
--   6. Backfill review_note / resubmit_requested from task_logs (one-time).
--
-- All statements are idempotent:
--   • DROP POLICY IF EXISTS before every CREATE POLICY.
--   • CREATE TABLE / INDEX IF NOT EXISTS.
--   • Backfill wrapped in DO $$ IF NOT EXISTS guard.
-- ============================================================

-- ============================================================
-- 1. tasks — own-scope for non-super admins (via created_by)
-- ============================================================
DROP POLICY IF EXISTS "tasks_select_admin" ON public.tasks;
CREATE POLICY "tasks_select_admin" ON public.tasks FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND created_by = auth.uid())
  );

DROP POLICY IF EXISTS "tasks_insert_admin" ON public.tasks;
CREATE POLICY "tasks_insert_admin" ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (
    get_user_role() = 'admin'
    AND created_by = auth.uid()
  );

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

DROP POLICY IF EXISTS "tasks_delete_admin" ON public.tasks;
CREATE POLICY "tasks_delete_admin" ON public.tasks FOR DELETE TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND created_by = auth.uid())
  );

-- ============================================================
-- 2. task_broadcasts — own-scope for non-super admins
-- ============================================================
DROP POLICY IF EXISTS "tb_admin_all"    ON public.task_broadcasts;
DROP POLICY IF EXISTS "tb_select_admin" ON public.task_broadcasts;
DROP POLICY IF EXISTS "tb_insert_admin" ON public.task_broadcasts;
DROP POLICY IF EXISTS "tb_update_admin" ON public.task_broadcasts;
DROP POLICY IF EXISTS "tb_delete_admin" ON public.task_broadcasts;

CREATE POLICY "tb_select_admin" ON public.task_broadcasts FOR SELECT TO authenticated
  USING (public.is_super_admin() OR (get_user_role() = 'admin' AND created_by = auth.uid()));

CREATE POLICY "tb_insert_admin" ON public.task_broadcasts FOR INSERT TO authenticated
  WITH CHECK (get_user_role() = 'admin' AND created_by = auth.uid());

CREATE POLICY "tb_update_admin" ON public.task_broadcasts FOR UPDATE TO authenticated
  USING (public.is_super_admin() OR (get_user_role() = 'admin' AND created_by = auth.uid()))
  WITH CHECK (public.is_super_admin() OR (get_user_role() = 'admin' AND created_by = auth.uid()));

CREATE POLICY "tb_delete_admin" ON public.task_broadcasts FOR DELETE TO authenticated
  USING (public.is_super_admin() OR (get_user_role() = 'admin' AND created_by = auth.uid()));
-- tb_manager_read / tb_staff_read unchanged.

-- ============================================================
-- 3. task_templates — own-scope WRITE for admins; read preserved
-- ============================================================
DROP POLICY IF EXISTS "tt_select"       ON public.task_templates;
DROP POLICY IF EXISTS "tt_manage"       ON public.task_templates;
DROP POLICY IF EXISTS "tt_modify_admin" ON public.task_templates;
DROP POLICY IF EXISTS "tt_modify_manager" ON public.task_templates;

CREATE POLICY "tt_select" ON public.task_templates FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND created_by = auth.uid())
    OR get_user_role() IN ('store_manager', 'staff')
  );

CREATE POLICY "tt_modify_admin" ON public.task_templates FOR ALL TO authenticated
  USING (public.is_super_admin() OR (get_user_role() = 'admin' AND created_by = auth.uid()))
  WITH CHECK (public.is_super_admin() OR (get_user_role() = 'admin' AND created_by = auth.uid()));

CREATE POLICY "tt_modify_manager" ON public.task_templates FOR ALL TO authenticated
  USING (get_user_role() = 'store_manager')
  WITH CHECK (get_user_role() = 'store_manager');

-- ============================================================
-- 4. task_schedules — own-scope via template.created_by
-- ============================================================
DROP POLICY IF EXISTS "ts_admin"       ON public.task_schedules;
DROP POLICY IF EXISTS "ts_select_admin" ON public.task_schedules;
DROP POLICY IF EXISTS "ts_insert_admin" ON public.task_schedules;
DROP POLICY IF EXISTS "ts_update_admin" ON public.task_schedules;
DROP POLICY IF EXISTS "ts_delete_admin" ON public.task_schedules;

CREATE POLICY "ts_select_admin" ON public.task_schedules FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.task_templates t
      WHERE t.id = template_id AND t.created_by = auth.uid()))
  );

CREATE POLICY "ts_insert_admin" ON public.task_schedules FOR INSERT TO authenticated
  WITH CHECK (
    get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.task_templates t
      WHERE t.id = template_id AND t.created_by = auth.uid())
  );

CREATE POLICY "ts_update_admin" ON public.task_schedules FOR UPDATE TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.task_templates t
      WHERE t.id = template_id AND t.created_by = auth.uid()))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.task_templates t
      WHERE t.id = template_id AND t.created_by = auth.uid()))
  );

CREATE POLICY "ts_delete_admin" ON public.task_schedules FOR DELETE TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.task_templates t
      WHERE t.id = template_id AND t.created_by = auth.uid()))
  );
-- ts_manager_select unchanged.

-- ============================================================
-- 5. task_schedule_stores — own-scope via schedule -> template.created_by
-- ============================================================
DROP POLICY IF EXISTS "tss_admin"        ON public.task_schedule_stores;
DROP POLICY IF EXISTS "tss_select_admin" ON public.task_schedule_stores;
DROP POLICY IF EXISTS "tss_insert_admin" ON public.task_schedule_stores;
DROP POLICY IF EXISTS "tss_delete_admin" ON public.task_schedule_stores;

CREATE POLICY "tss_select_admin" ON public.task_schedule_stores FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.task_schedules s
      JOIN public.task_templates t ON t.id = s.template_id
      WHERE s.id = schedule_id AND t.created_by = auth.uid()))
  );

CREATE POLICY "tss_insert_admin" ON public.task_schedule_stores FOR INSERT TO authenticated
  WITH CHECK (
    get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.task_schedules s
      JOIN public.task_templates t ON t.id = s.template_id
      WHERE s.id = schedule_id AND t.created_by = auth.uid())
  );

CREATE POLICY "tss_delete_admin" ON public.task_schedule_stores FOR DELETE TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.task_schedules s
      JOIN public.task_templates t ON t.id = s.template_id
      WHERE s.id = schedule_id AND t.created_by = auth.uid()))
  );
-- tss_manager_select unchanged.

-- ============================================================
-- 6. task_generation_runs — own-scope SELECT via schedule -> template
-- ============================================================
DROP POLICY IF EXISTS "tgr_admin"        ON public.task_generation_runs;
DROP POLICY IF EXISTS "tgr_select_admin" ON public.task_generation_runs;

CREATE POLICY "tgr_select_admin" ON public.task_generation_runs FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.task_schedules s
      JOIN public.task_templates t ON t.id = s.template_id
      WHERE s.id = schedule_id AND t.created_by = auth.uid()))
  );
-- Rows are written by the cron (supabaseAdmin / service role, bypasses RLS).

-- ============================================================
-- 7. task_feedback_threads / messages — own-scope via task.created_by
-- ============================================================
DROP POLICY IF EXISTS "tft_select_admin" ON public.task_feedback_threads;
CREATE POLICY "tft_select_admin" ON public.task_feedback_threads FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.created_by = auth.uid()))
  );

DROP POLICY IF EXISTS "tft_update_admin" ON public.task_feedback_threads;
CREATE POLICY "tft_update_admin" ON public.task_feedback_threads FOR UPDATE TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.created_by = auth.uid()))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.created_by = auth.uid()))
  );

DROP POLICY IF EXISTS "tfm_select_admin" ON public.task_feedback_messages;
CREATE POLICY "tfm_select_admin" ON public.task_feedback_messages FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (get_user_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.task_feedback_threads th
      JOIN public.tasks t ON t.id = th.task_id
      WHERE th.id = thread_id AND t.created_by = auth.uid()))
  );

DROP POLICY IF EXISTS "tfm_insert_admin" ON public.task_feedback_messages;
CREATE POLICY "tfm_insert_admin" ON public.task_feedback_messages FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (
      public.is_super_admin()
      OR (get_user_role() = 'admin' AND EXISTS (
        SELECT 1 FROM public.task_feedback_threads th
        JOIN public.tasks t ON t.id = th.task_id
        WHERE th.id = thread_id AND t.created_by = auth.uid()))
    )
  );

-- ============================================================
-- 8. task_logs — three hardening changes
-- ============================================================

-- 8a. Admin SELECT: super all; sub-admin own logs + logs on own tasks.
DROP POLICY IF EXISTS "tl_select_admin" ON public.task_logs;
CREATE POLICY "tl_select_admin" ON public.task_logs FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (
      get_user_role() = 'admin'
      AND (
        user_id = auth.uid()
        OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.created_by = auth.uid())
      )
    )
  );

-- 8b. Store manager SELECT: revert 014's broad "all logs on store tasks" back
-- to actor-based (own logs + logs from users in their store).
-- This closes the leak that exposed admin review/resubmit text to managers.
DROP POLICY IF EXISTS "tl_select_manager" ON public.task_logs;
CREATE POLICY "tl_select_manager" ON public.task_logs FOR SELECT TO authenticated
  USING (
    get_user_role() = 'store_manager'
    AND (
      user_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = user_id AND u.store_id = get_user_store_id()
      )
    )
  );

-- 8c. INSERT: require user_id = caller. Prevents any authenticated user from
-- forging audit entries attributed to someone else.
DROP POLICY IF EXISTS "tl_insert" ON public.task_logs;
CREATE POLICY "tl_insert" ON public.task_logs FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ============================================================
-- 9. notifications — lock INSERT to service role
-- ============================================================
-- Server actions now use supabaseAdmin for all notification writes, which
-- bypasses RLS entirely. Dropping the public INSERT policy means no
-- authenticated client can forge notifications for arbitrary recipients.
DROP POLICY IF EXISTS "notifications_insert" ON public.notifications;
-- (No replacement INSERT policy — service role handles all inserts.)

-- ============================================================
-- 10. task_review_notes — new table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.task_review_notes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid        NOT NULL REFERENCES public.tasks(id)  ON DELETE CASCADE,
  author_id  uuid        REFERENCES public.users(id)           ON DELETE SET NULL,
  kind       text        NOT NULL CHECK (kind IN ('review_note', 'resubmit_request')),
  note       text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trn_task_created
  ON public.task_review_notes (task_id, created_at DESC);

ALTER TABLE public.task_review_notes ENABLE ROW LEVEL SECURITY;

-- SELECT
DROP POLICY IF EXISTS "trn_select_super"   ON public.task_review_notes;
DROP POLICY IF EXISTS "trn_select_admin"   ON public.task_review_notes;
DROP POLICY IF EXISTS "trn_select_manager" ON public.task_review_notes;
DROP POLICY IF EXISTS "trn_select_staff"   ON public.task_review_notes;

CREATE POLICY "trn_select_super" ON public.task_review_notes FOR SELECT TO authenticated
  USING (public.is_super_admin());

CREATE POLICY "trn_select_admin" ON public.task_review_notes FOR SELECT TO authenticated
  USING (
    get_user_role() = 'admin'
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.created_by = auth.uid())
  );

CREATE POLICY "trn_select_manager" ON public.task_review_notes FOR SELECT TO authenticated
  USING (
    get_user_role() = 'store_manager'
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.store_id = get_user_store_id())
  );

CREATE POLICY "trn_select_staff" ON public.task_review_notes FOR SELECT TO authenticated
  USING (
    get_user_role() = 'staff'
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.assigned_to = auth.uid())
  );

-- INSERT: caller = author, on tasks they own/manage
DROP POLICY IF EXISTS "trn_insert_admin"   ON public.task_review_notes;
DROP POLICY IF EXISTS "trn_insert_manager" ON public.task_review_notes;

CREATE POLICY "trn_insert_admin" ON public.task_review_notes FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND get_user_role() = 'admin'
    AND (
      public.is_super_admin()
      OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.created_by = auth.uid())
    )
  );

CREATE POLICY "trn_insert_manager" ON public.task_review_notes FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND get_user_role() = 'store_manager'
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.store_id = get_user_store_id())
  );

-- ============================================================
-- 11. Backfill task_review_notes from existing task_logs
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.task_review_notes LIMIT 1) THEN
    INSERT INTO public.task_review_notes (task_id, author_id, kind, note, created_at)
    SELECT l.task_id, l.user_id, 'review_note',
           COALESCE(l.metadata->>'note', ''), l.created_at
    FROM public.task_logs l
    WHERE l.action = 'review_note' AND l.task_id IS NOT NULL;

    INSERT INTO public.task_review_notes (task_id, author_id, kind, note, created_at)
    SELECT l.task_id, l.user_id, 'resubmit_request',
           COALESCE(l.metadata->>'reason', ''), l.created_at
    FROM public.task_logs l
    WHERE l.action = 'resubmit_requested' AND l.task_id IS NOT NULL;
  END IF;
END $$;

-- ============================================================
-- 12. public.users — lock write operations to super admin
-- ============================================================
-- users_update_own (USING id = auth.uid()) allows any authenticated user
-- to overwrite their own row — including role and store_id — via a direct
-- Supabase client call.  No current app feature needs this (password changes
-- go through supabase.auth.updateUser, not the public.users table directly).
-- Dropping it closes the role/store-escalation path.
-- If a self-service profile-name update is added later, do it via a
-- SECURITY DEFINER RPC that only touches the full_name column.
DROP POLICY IF EXISTS "users_update_own"   ON public.users;

-- Restrict admin-level writes to the super admin.  The app layer already
-- enforces this (users.ts guards), but RLS is the real gate.
-- updateUserRole uses the super-admin's user session, which satisfies
-- is_super_admin() — so the call still succeeds after this change.
DROP POLICY IF EXISTS "users_update_admin" ON public.users;
DROP POLICY IF EXISTS "users_insert_admin" ON public.users;
DROP POLICY IF EXISTS "users_delete_admin" ON public.users;

CREATE POLICY "users_write_super" ON public.users FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());
-- users_select (USING true) is unchanged — every authenticated user still
-- reads the users table (needed for task assignment selectors).

-- ============================================================
-- 13. public.stores — lock write operations to super admin
-- ============================================================
-- stores_admin (FOR ALL, get_user_role()='admin') lets any admin mutate
-- stores directly.  No server action writes stores via the user client today,
-- but a sub-admin could do so directly.  Lock writes to super admin only.
-- stores_select (USING true) already covers read for everyone.
DROP POLICY IF EXISTS "stores_admin" ON public.stores;

CREATE POLICY "stores_write_super" ON public.stores FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- ============================================================
-- 14. task_review_notes — restrict manager INSERT to resubmit_request only
-- ============================================================
-- Managers should not be able to write 'review_note' kind rows — that
-- channel belongs to admins only (mirrors the addReviewNote() server action
-- guard above). The WITH CHECK on the existing trn_insert_manager policy
-- already requires author_id = auth.uid() and store ownership, but it does
-- not restrict the kind column. Adding the kind check closes the gap.
DROP POLICY IF EXISTS "trn_insert_manager" ON public.task_review_notes;
CREATE POLICY "trn_insert_manager" ON public.task_review_notes FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND kind = 'resubmit_request'
    AND get_user_role() = 'store_manager'
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = task_id AND t.store_id = get_user_store_id())
  );

-- ============================================================
-- 15. store_teams_chats / teams_notification_events — super admin only
-- ============================================================
-- Migration 020 set these to any admin. Teams chat config (webhook
-- credentials) and notification audit logs should be super-admin only.

-- store_teams_chats: manage (view + modify) restricted to super admin.
-- Sub-admins have no reason to read or change Teams webhook config.
DROP POLICY IF EXISTS "stc_admin_all"   ON public.store_teams_chats;
DROP POLICY IF EXISTS "stc_super_all"   ON public.store_teams_chats;
CREATE POLICY "stc_super_all" ON public.store_teams_chats
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- teams_notification_events: super admin sees all; sub-admin sees only
-- events tied to tasks they created (useful for debugging their own tasks).
DROP POLICY IF EXISTS "tne_admin_select" ON public.teams_notification_events;
DROP POLICY IF EXISTS "tne_select_super" ON public.teams_notification_events;
DROP POLICY IF EXISTS "tne_select_admin" ON public.teams_notification_events;
CREATE POLICY "tne_select_super" ON public.teams_notification_events
  FOR SELECT TO authenticated
  USING (public.is_super_admin());
CREATE POLICY "tne_select_admin" ON public.teams_notification_events
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      WHERE t.id = task_id AND t.created_by = auth.uid()
    )
  );
