-- ============================================================
-- Migration 060: Department-based task visibility (admin, VIEW only)
-- ============================================================
-- Stakeholder ask: admins (PIC) in the SAME department auto-see each other's
-- tasks without manual sharing; cross-department still uses manual share.
-- VIEW ONLY — UPDATE/DELETE policies + app-layer canAdminManageOwn are unchanged,
-- so department peers can view but NOT edit/delete each other's tasks.
--
-- Visibility keys off the CREATOR's CURRENT department (live join), so it is
-- retroactive: the moment an admin's department is set, they see peers' past
-- tasks AND their own past tasks become visible to peers — no backfill needed
-- (tasks.department_id stamp stays a display label only).
--
-- Only the admin SELECT policy changes; store_manager/SM/staff policies untouched
-- (those roles don't use departments). Idempotent.
-- ============================================================

-- Viewer's department (SECURITY DEFINER avoids RLS recursion; mirrors
-- get_user_store_id). users_select is USING(true) and never references tasks,
-- so no cross-table recursion (see migration 048/049 lessons).
CREATE OR REPLACE FUNCTION public.get_user_department_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT department_id FROM public.users WHERE id = auth.uid()
$$;
GRANT EXECUTE ON FUNCTION public.get_user_department_id() TO authenticated;

-- Recreate tasks_select_admin: keep the 3 existing branches (super / own /
-- collaborator), add a 4th — same-department admin (view). Calls stay wrapped in
-- (select ...) to preserve the auth_rls_initplan perf fix (migration 038).
DROP POLICY IF EXISTS tasks_select_admin ON public.tasks;
CREATE POLICY tasks_select_admin ON public.tasks
  FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select public.get_user_role()) = 'admin' AND created_by = (select auth.uid()))
    OR ((select public.get_user_role()) = 'admin' AND EXISTS (
          SELECT 1 FROM public.task_collaborators tc
          WHERE tc.task_id = tasks.id AND tc.admin_id = (select auth.uid())))
    OR ((select public.get_user_role()) = 'admin'
        AND (select public.get_user_department_id()) IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = tasks.created_by
            AND u.department_id = (select public.get_user_department_id())))
  );

INSERT INTO public.app_migrations (version, name)
VALUES ('060', 'department_task_visibility')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Helper exists + SECURITY DEFINER:
-- SELECT proname, prosecdef FROM pg_proc WHERE proname='get_user_department_id';
--
-- 2) Policy has the department branch:
-- SELECT qual FROM pg_policies WHERE tablename='tasks' AND policyname='tasks_select_admin';
-- (expect to contain get_user_department_id)
--
-- 3) Behavior: two admins with the same users.department_id see each other's
--    tasks in /tasks; an admin in a different department does not; super admin
--    still sees all; staff/store_manager/SM unchanged.
--
-- 4) Migration recorded:
-- SELECT version FROM public.app_migrations WHERE version='060';
