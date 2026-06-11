-- ============================================================
-- Migration 047: Schedule collaborators (share recurring schedules)
-- ============================================================
-- Mirrors the task_collaborators pattern (migration 024) for recurring
-- schedules. An admin owner shares a schedule with another admin:
--   * 'view'   — read schedule config, stores, run history
--   * 'editor' — additionally pause/resume the schedule
-- Generated tasks are shared through task_collaborators rows written by the
-- cron generator + a backfill in the shareSchedule action, so ALL existing
-- task-level collaborator RLS (tasks/results/logs/notes/feedback) is reused
-- unchanged.
--
-- Ownership note: task_schedules has NO created_by; the owner is
-- task_templates.created_by via schedule.template_id (migration 021 chain).
-- invited_by always equals the template owner (mirrors 024) so the owner
-- sees their shares via invited_by = auth.uid() even when a super admin
-- shares on their behalf.
--
-- Known accepted limitation: RLS UPDATE policies cannot restrict columns, so
-- an 'editor' collaborator could technically update schedule fields beyond
-- is_active/next_run_at via direct PostgREST calls. Editors are trusted
-- admins; the app UI only exposes pause/resume.
--
-- Recursion safety (cf. migration 023): policy chains are one-directional —
-- ts_* policies reference task_schedule_collaborators, whose own policies
-- reference only its columns (and the template chain for INSERT), never back
-- into a table whose policy references this one in a cycle.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS; DROP POLICY IF EXISTS before each.
-- Initplan form (select ...) per migration 038 convention.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.task_schedule_collaborators (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid        NOT NULL REFERENCES public.task_schedules(id) ON DELETE CASCADE,
  admin_id    uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  permission  text        NOT NULL CHECK (permission IN ('view', 'editor')),
  invited_by  uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, admin_id)
);

CREATE INDEX IF NOT EXISTS idx_tsc_schedule ON public.task_schedule_collaborators (schedule_id);
CREATE INDEX IF NOT EXISTS idx_tsc_admin    ON public.task_schedule_collaborators (admin_id);

ALTER TABLE public.task_schedule_collaborators ENABLE ROW LEVEL SECURITY;

-- ── policies on the collaborator table itself ──────────────────────────────

DROP POLICY IF EXISTS "tsc_select" ON public.task_schedule_collaborators;
CREATE POLICY "tsc_select" ON public.task_schedule_collaborators
  FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR admin_id   = (select auth.uid())
    OR invited_by = (select auth.uid())
  );

DROP POLICY IF EXISTS "tsc_insert" ON public.task_schedule_collaborators;
CREATE POLICY "tsc_insert" ON public.task_schedule_collaborators
  FOR INSERT TO authenticated
  WITH CHECK (
    (select get_user_role()) = 'admin'
    AND EXISTS (
      SELECT 1
      FROM public.task_schedules s
      JOIN public.task_templates t ON t.id = s.template_id
      WHERE s.id = schedule_id AND t.created_by = invited_by
    )
    AND (
      (select public.is_super_admin())
      OR invited_by = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "tsc_update" ON public.task_schedule_collaborators;
CREATE POLICY "tsc_update" ON public.task_schedule_collaborators
  FOR UPDATE TO authenticated
  USING (
    (select public.is_super_admin())
    OR EXISTS (
      SELECT 1
      FROM public.task_schedules s
      JOIN public.task_templates t ON t.id = s.template_id
      WHERE s.id = schedule_id AND t.created_by = (select auth.uid())
    )
  )
  WITH CHECK (
    (select public.is_super_admin())
    OR EXISTS (
      SELECT 1
      FROM public.task_schedules s
      JOIN public.task_templates t ON t.id = s.template_id
      WHERE s.id = schedule_id AND t.created_by = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "tsc_delete" ON public.task_schedule_collaborators;
CREATE POLICY "tsc_delete" ON public.task_schedule_collaborators
  FOR DELETE TO authenticated
  USING (
    (select public.is_super_admin())
    OR EXISTS (
      SELECT 1
      FROM public.task_schedules s
      JOIN public.task_templates t ON t.id = s.template_id
      WHERE s.id = schedule_id AND t.created_by = (select auth.uid())
    )
  );

-- ── task_schedules: collaborators may SELECT; editors may UPDATE ───────────

DROP POLICY IF EXISTS "ts_select_admin" ON public.task_schedules;
CREATE POLICY "ts_select_admin" ON public.task_schedules FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select get_user_role()) = 'admin' AND (
      EXISTS (
        SELECT 1 FROM public.task_templates t
        WHERE t.id = template_id AND t.created_by = (select auth.uid()))
      OR EXISTS (
        SELECT 1 FROM public.task_schedule_collaborators sc
        WHERE sc.schedule_id = public.task_schedules.id
          AND sc.admin_id = (select auth.uid()))
    ))
  );

DROP POLICY IF EXISTS "ts_update_admin" ON public.task_schedules;
CREATE POLICY "ts_update_admin" ON public.task_schedules FOR UPDATE TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select get_user_role()) = 'admin' AND (
      EXISTS (
        SELECT 1 FROM public.task_templates t
        WHERE t.id = template_id AND t.created_by = (select auth.uid()))
      OR EXISTS (
        SELECT 1 FROM public.task_schedule_collaborators sc
        WHERE sc.schedule_id = public.task_schedules.id
          AND sc.admin_id = (select auth.uid())
          AND sc.permission = 'editor')
    ))
  )
  WITH CHECK (
    (select public.is_super_admin())
    OR ((select get_user_role()) = 'admin' AND (
      EXISTS (
        SELECT 1 FROM public.task_templates t
        WHERE t.id = template_id AND t.created_by = (select auth.uid()))
      OR EXISTS (
        SELECT 1 FROM public.task_schedule_collaborators sc
        WHERE sc.schedule_id = public.task_schedules.id
          AND sc.admin_id = (select auth.uid())
          AND sc.permission = 'editor')
    ))
  );

-- ── task_schedule_stores: collaborators may SELECT ─────────────────────────

DROP POLICY IF EXISTS "tss_select_admin" ON public.task_schedule_stores;
CREATE POLICY "tss_select_admin" ON public.task_schedule_stores FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select get_user_role()) = 'admin' AND (
      EXISTS (
        SELECT 1 FROM public.task_schedules s
        JOIN public.task_templates t ON t.id = s.template_id
        WHERE s.id = schedule_id AND t.created_by = (select auth.uid()))
      OR EXISTS (
        SELECT 1 FROM public.task_schedule_collaborators sc
        WHERE sc.schedule_id = public.task_schedule_stores.schedule_id
          AND sc.admin_id = (select auth.uid()))
    ))
  );

-- ── task_generation_runs: collaborators may SELECT run history ─────────────

DROP POLICY IF EXISTS "tgr_select_admin" ON public.task_generation_runs;
CREATE POLICY "tgr_select_admin" ON public.task_generation_runs FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select get_user_role()) = 'admin' AND (
      EXISTS (
        SELECT 1 FROM public.task_schedules s
        JOIN public.task_templates t ON t.id = s.template_id
        WHERE s.id = schedule_id AND t.created_by = (select auth.uid()))
      OR EXISTS (
        SELECT 1 FROM public.task_schedule_collaborators sc
        WHERE sc.schedule_id = public.task_generation_runs.schedule_id
          AND sc.admin_id = (select auth.uid()))
    ))
  );

-- ── task_templates: collaborators may SELECT the template content ──────────
-- (schedule detail page renders title/config from the template)

DROP POLICY IF EXISTS "tt_select" ON public.task_templates;
CREATE POLICY "tt_select" ON public.task_templates FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select get_user_role()) = 'admin' AND (
      created_by = (select auth.uid())
      OR EXISTS (
        SELECT 1
        FROM public.task_schedule_collaborators sc
        JOIN public.task_schedules s ON s.id = sc.schedule_id
        WHERE s.template_id = public.task_templates.id
          AND sc.admin_id = (select auth.uid()))
    ))
    OR (select get_user_role()) IN ('store_manager', 'staff')
  );

-- Record this migration.
INSERT INTO public.app_migrations (version, name)
VALUES ('047', 'schedule_collaborators')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Table + unique constraint:
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='task_schedule_collaborators';
-- expect: id, schedule_id, admin_id, permission, invited_by, created_at
--
-- 2) Policies in place:
-- SELECT policyname FROM pg_policies
-- WHERE schemaname='public' AND tablename='task_schedule_collaborators';
-- expect: tsc_select, tsc_insert, tsc_update, tsc_delete
--
-- 3) Collaborator branch present on schedules:
-- SELECT policyname, qual FROM pg_policies
-- WHERE schemaname='public' AND tablename='task_schedules' AND policyname='ts_select_admin';
-- expect: qual mentions task_schedule_collaborators
--
-- 4) tt_select keeps store_manager/staff read:
-- SELECT qual FROM pg_policies
-- WHERE schemaname='public' AND tablename='task_templates' AND policyname='tt_select';
-- expect: contains 'store_manager', 'staff' AND task_schedule_collaborators
--
-- 5) Migration recorded:
-- SELECT version, name FROM public.app_migrations WHERE version='047';
