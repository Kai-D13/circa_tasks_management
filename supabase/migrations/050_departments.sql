-- ============================================================
-- Migration 050: Departments (phòng ban) + task department tag
-- ============================================================
-- Stakeholder ask (2026-06-11): tag every task with the creating admin's
-- department so stores/staff/other PICs can tell which department it belongs
-- to. Permissions/RLS for tasks stay EXACTLY as they are — the department is
-- a label, not a scope.
--
-- Design:
--   * departments: small lookup table, super-admin managed. `color` stores a
--     preset KEY (orange/blue/...) mapped to badge classes in the app — never
--     raw CSS.
--   * users.department_id: which department a user belongs to.
--   * tasks.department_id: stamped ONCE at insert by a BEFORE INSERT trigger
--     from the creator's profile. One trigger covers every creation path
--     (server actions, import RPC, cron generator) with zero app-code risk,
--     and the tag is a historical snapshot — reassigning a user later does
--     not relabel their old tasks.
--
-- RLS rule (lesson from 047→049): NO policy here references another RLS
-- table. departments policies use only is_super_admin() (SECURITY DEFINER).
-- The trigger function is SECURITY DEFINER and reads users outside RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.departments (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL UNIQUE,
  color      text        NOT NULL DEFAULT 'orange'
             CHECK (color IN ('orange','blue','green','purple','teal','pink','amber','slate')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

-- Labels are public to the app: every signed-in role renders the tag.
DROP POLICY IF EXISTS "dept_select" ON public.departments;
CREATE POLICY "dept_select" ON public.departments
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "dept_write" ON public.departments;
CREATE POLICY "dept_write" ON public.departments
  FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL;

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_department
  ON public.tasks (department_id) WHERE department_id IS NOT NULL;

-- Stamp the creator's department on every new task unless the insert already
-- set one. SECURITY DEFINER: the lookup must not depend on the inserter's RLS
-- view of public.users (cron/service-role and staff submits alike).
CREATE OR REPLACE FUNCTION public.set_task_department()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.department_id IS NULL AND NEW.created_by IS NOT NULL THEN
    SELECT u.department_id INTO NEW.department_id
    FROM public.users u
    WHERE u.id = NEW.created_by;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_task_department ON public.tasks;
CREATE TRIGGER trg_set_task_department
  BEFORE INSERT ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.set_task_department();

-- Record this migration.
INSERT INTO public.app_migrations (version, name)
VALUES ('050', 'departments')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Table + policies:
-- SELECT policyname FROM pg_policies WHERE tablename = 'departments';
-- expect: dept_select, dept_write
--
-- 2) Columns exist:
-- SELECT table_name, column_name FROM information_schema.columns
-- WHERE column_name = 'department_id' AND table_schema = 'public';
-- expect: users + tasks
--
-- 3) Trigger installed:
-- SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.tasks'::regclass
--   AND tgname = 'trg_set_task_department';
-- expect: 1 row
--
-- 4) (OPTIONAL — run AFTER assigning departments to admins, only if you want
--     OLD tasks retro-tagged; new tasks tag automatically from creation on):
-- UPDATE public.tasks t
-- SET department_id = u.department_id
-- FROM public.users u
-- WHERE u.id = t.created_by AND t.department_id IS NULL
--   AND u.department_id IS NOT NULL;
