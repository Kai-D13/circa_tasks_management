-- ============================================================
-- Migration 049: HOTFIX 2 — remove ALL cross-table refs from schedule RLS
-- ============================================================
-- 048 cut the tt → ts → tt cycle, but the tsc ↔ ts cycle remained:
-- upserting task_schedule_collaborators (shareSchedule) expands
-- tsc_insert/tsc_update which EXISTS into task_schedules, whose
-- ts_select_admin EXISTS back into task_schedule_collaborators →
-- "infinite recursion detected in policy for relation task_schedule_collaborators".
--
-- Definitive fix instead of patching edges one by one: every 047-batch policy
-- is rebuilt on SECURITY DEFINER helpers (RLS not evaluated inside), so NO
-- schedule-related policy references another RLS table at all. Cycles become
-- structurally impossible.
--
-- Untouched (safe, pre-047, reference only task_templates whose tt_select has
-- no table refs since 048): ts_insert_admin, ts_delete_admin,
-- tss_insert_admin, tss_delete_admin, ts_manager_select.
--
-- Idempotent: CREATE OR REPLACE + DROP POLICY IF EXISTS.
-- ============================================================

-- ── helpers (SECURITY DEFINER = no RLS inside = no recursion) ──────────────

-- Owner of a schedule = creator of its template (schedules have no created_by).
CREATE OR REPLACE FUNCTION public.schedule_owner_id(p_schedule_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.created_by
  FROM public.task_schedules s
  JOIN public.task_templates t ON t.id = s.template_id
  WHERE s.id = p_schedule_id
$$;

CREATE OR REPLACE FUNCTION public.is_schedule_collaborator(p_schedule_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.task_schedule_collaborators sc
    WHERE sc.schedule_id = p_schedule_id
      AND sc.admin_id = auth.uid()
  )
$$;

CREATE OR REPLACE FUNCTION public.is_schedule_editor(p_schedule_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.task_schedule_collaborators sc
    WHERE sc.schedule_id = p_schedule_id
      AND sc.admin_id = auth.uid()
      AND sc.permission = 'editor'
  )
$$;

GRANT EXECUTE ON FUNCTION public.schedule_owner_id(uuid)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_schedule_collaborator(uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_schedule_editor(uuid)         TO authenticated;

-- ── task_schedule_collaborators: helper-only policies ──────────────────────

DROP POLICY IF EXISTS "tsc_insert" ON public.task_schedule_collaborators;
CREATE POLICY "tsc_insert" ON public.task_schedule_collaborators
  FOR INSERT TO authenticated
  WITH CHECK (
    (select get_user_role()) = 'admin'
    AND invited_by = public.schedule_owner_id(schedule_id)
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
    OR public.schedule_owner_id(schedule_id) = (select auth.uid())
  )
  WITH CHECK (
    (select public.is_super_admin())
    OR public.schedule_owner_id(schedule_id) = (select auth.uid())
  );

DROP POLICY IF EXISTS "tsc_delete" ON public.task_schedule_collaborators;
CREATE POLICY "tsc_delete" ON public.task_schedule_collaborators
  FOR DELETE TO authenticated
  USING (
    (select public.is_super_admin())
    OR public.schedule_owner_id(schedule_id) = (select auth.uid())
  );

-- tsc_select (047) has no table refs — kept as is.

-- ── task_schedules: helper-only SELECT/UPDATE ───────────────────────────────

DROP POLICY IF EXISTS "ts_select_admin" ON public.task_schedules;
CREATE POLICY "ts_select_admin" ON public.task_schedules FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select get_user_role()) = 'admin' AND (
      public.schedule_owner_id(id) = (select auth.uid())
      OR public.is_schedule_collaborator(id)
    ))
  );

DROP POLICY IF EXISTS "ts_update_admin" ON public.task_schedules;
CREATE POLICY "ts_update_admin" ON public.task_schedules FOR UPDATE TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select get_user_role()) = 'admin' AND (
      public.schedule_owner_id(id) = (select auth.uid())
      OR public.is_schedule_editor(id)
    ))
  )
  WITH CHECK (
    (select public.is_super_admin())
    OR ((select get_user_role()) = 'admin' AND (
      public.schedule_owner_id(id) = (select auth.uid())
      OR public.is_schedule_editor(id)
    ))
  );

-- ── task_schedule_stores / task_generation_runs: helper-only SELECT ────────

DROP POLICY IF EXISTS "tss_select_admin" ON public.task_schedule_stores;
CREATE POLICY "tss_select_admin" ON public.task_schedule_stores FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select get_user_role()) = 'admin' AND (
      public.schedule_owner_id(schedule_id) = (select auth.uid())
      OR public.is_schedule_collaborator(schedule_id)
    ))
  );

DROP POLICY IF EXISTS "tgr_select_admin" ON public.task_generation_runs;
CREATE POLICY "tgr_select_admin" ON public.task_generation_runs FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select get_user_role()) = 'admin' AND (
      public.schedule_owner_id(schedule_id) = (select auth.uid())
      OR public.is_schedule_collaborator(schedule_id)
    ))
  );

-- Record this migration.
INSERT INTO public.app_migrations (version, name)
VALUES ('049', 'schedule_rls_no_cross_refs')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Helpers exist, all SECURITY DEFINER:
-- SELECT proname, prosecdef FROM pg_proc
-- WHERE proname IN ('schedule_owner_id','is_schedule_collaborator','is_schedule_editor');
-- expect: 3 rows, prosecdef = true
--
-- 2) No schedule policy references another table anymore:
-- SELECT tablename, policyname, qual, with_check FROM pg_policies
-- WHERE schemaname='public'
--   AND tablename IN ('task_schedules','task_schedule_stores',
--                     'task_generation_runs','task_schedule_collaborators');
-- expect: no qual/with_check contains 'JOIN' or 'task_templates' except via
--         the helper function names
--
-- 3) Share flow works end-to-end in the app (upsert + select), no recursion.
--
-- 4) Migration recorded:
-- SELECT version, name FROM public.app_migrations WHERE version='049';
