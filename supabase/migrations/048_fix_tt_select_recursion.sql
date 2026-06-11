-- ============================================================
-- Migration 048: HOTFIX — infinite recursion in tt_select (broke prod)
-- ============================================================
-- Migration 047's tt_select referenced task_schedules, whose ts_select_admin
-- policy references task_templates back → "infinite recursion detected in
-- policy for relation task_templates" on EVERY task_templates SELECT
-- (createSchedule, /tasks/schedules pages). Same failure class migration 023
-- fixed before.
--
-- Fix: move the collaborator lookup into a SECURITY DEFINER function — RLS is
-- not evaluated inside it, so the tt → ts → tt cycle is cut. Mirrors the
-- is_sm_for_store() helper pattern from migration 045.
--
-- Cron is unaffected either way (service role bypasses RLS).
-- Idempotent: CREATE OR REPLACE + DROP POLICY IF EXISTS.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_schedule_collaborator_for_template(p_template_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.task_schedule_collaborators sc
    JOIN public.task_schedules s ON s.id = sc.schedule_id
    WHERE s.template_id = p_template_id
      AND sc.admin_id = auth.uid()
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_schedule_collaborator_for_template(uuid) TO authenticated;

DROP POLICY IF EXISTS "tt_select" ON public.task_templates;
CREATE POLICY "tt_select" ON public.task_templates FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select get_user_role()) = 'admin' AND (
      created_by = (select auth.uid())
      OR public.is_schedule_collaborator_for_template(id)
    ))
    OR (select get_user_role()) IN ('store_manager', 'staff')
  );

-- Record this migration.
INSERT INTO public.app_migrations (version, name)
VALUES ('048', 'fix_tt_select_recursion')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- 1) The failing query class works again (run as any admin via the app, or):
-- SELECT id, title FROM public.task_templates LIMIT 1;
-- expect: rows (or empty), NO recursion error
--
-- 2) Helper exists and is SECURITY DEFINER:
-- SELECT proname, prosecdef FROM pg_proc
-- WHERE proname = 'is_schedule_collaborator_for_template';
-- expect: 1 row, prosecdef = true
--
-- 3) tt_select no longer references task_schedules directly:
-- SELECT qual FROM pg_policies
-- WHERE schemaname='public' AND tablename='task_templates' AND policyname='tt_select';
-- expect: mentions is_schedule_collaborator_for_template, NOT task_schedule_collaborators
--
-- 4) Migration recorded:
-- SELECT version, name FROM public.app_migrations WHERE version='048';
