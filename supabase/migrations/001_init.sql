-- ============================================================
-- Task Management System — Initial Schema
-- ============================================================

-- Stores
CREATE TABLE IF NOT EXISTS public.stores (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name        text NOT NULL,
  code        text UNIQUE NOT NULL,
  address     text,
  created_at  timestamptz DEFAULT now()
);

-- Users (mirrors auth.users, populated via trigger)
CREATE TABLE IF NOT EXISTS public.users (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text NOT NULL,
  full_name   text NOT NULL DEFAULT '',
  role        text NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'store_manager', 'staff')),
  store_id    uuid REFERENCES public.stores(id) ON DELETE SET NULL,
  created_at  timestamptz DEFAULT now()
);

-- Tasks
CREATE TABLE IF NOT EXISTS public.tasks (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title            text NOT NULL,
  description      text,
  priority         text NOT NULL DEFAULT 'normal'  CHECK (priority IN ('urgent', 'normal')),
  status           text NOT NULL DEFAULT 'todo'    CHECK (status IN ('todo', 'in_progress', 'done', 'overdue')),
  visibility       text NOT NULL DEFAULT 'store'   CHECK (visibility IN ('public', 'store', 'private')),
  store_id         uuid REFERENCES public.stores(id) ON DELETE CASCADE,
  assigned_to      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  input_data       jsonb,
  required_outputs jsonb DEFAULT '[]'::jsonb,
  deadline         timestamptz,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

-- Multiple assignees per task
CREATE TABLE IF NOT EXISTS public.task_assignments (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id     uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_at timestamptz DEFAULT now(),
  UNIQUE(task_id, user_id)
);

-- Staff submissions
CREATE TABLE IF NOT EXISTS public.task_results (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id      uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  output_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at timestamptz DEFAULT now()
);

-- Reusable task templates
CREATE TABLE IF NOT EXISTS public.task_templates (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title      text NOT NULL,
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

-- Audit log (mandatory)
CREATE TABLE IF NOT EXISTS public.task_logs (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id    uuid REFERENCES public.tasks(id) ON DELETE CASCADE,
  action     text NOT NULL,
  user_id    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  metadata   jsonb,
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- Triggers
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-create public.users row when auth user is created
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, email, full_name, role, store_id)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'staff'),
    CASE
      WHEN NEW.raw_user_meta_data->>'store_id' IS NOT NULL
      THEN (NEW.raw_user_meta_data->>'store_id')::uuid
      ELSE NULL
    END
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- Row Level Security
-- ============================================================

ALTER TABLE public.users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stores          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_results    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_templates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_logs       ENABLE ROW LEVEL SECURITY;

-- Stable helpers (avoids repeated subqueries in policies)
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS text AS $$
  SELECT role FROM public.users WHERE id = auth.uid()
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_user_store_id()
RETURNS uuid AS $$
  SELECT store_id FROM public.users WHERE id = auth.uid()
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- --- users ---
CREATE POLICY "users_select"       ON public.users FOR SELECT TO authenticated USING (true);
CREATE POLICY "users_update_own"   ON public.users FOR UPDATE TO authenticated USING (id = auth.uid());
CREATE POLICY "users_update_admin" ON public.users FOR UPDATE TO authenticated USING (get_user_role() = 'admin');
CREATE POLICY "users_insert_admin" ON public.users FOR INSERT TO authenticated WITH CHECK (get_user_role() = 'admin');
CREATE POLICY "users_delete_admin" ON public.users FOR DELETE TO authenticated USING (get_user_role() = 'admin');

-- --- stores ---
CREATE POLICY "stores_select" ON public.stores FOR SELECT TO authenticated USING (true);
CREATE POLICY "stores_admin"  ON public.stores FOR ALL    TO authenticated USING (get_user_role() = 'admin');

-- --- tasks: SELECT ---
CREATE POLICY "tasks_select_admin" ON public.tasks FOR SELECT TO authenticated
  USING (get_user_role() = 'admin');

CREATE POLICY "tasks_select_manager" ON public.tasks FOR SELECT TO authenticated
  USING (get_user_role() = 'store_manager' AND store_id = get_user_store_id());

CREATE POLICY "tasks_select_staff" ON public.tasks FOR SELECT TO authenticated
  USING (
    visibility = 'public'
    OR (visibility = 'store' AND store_id = get_user_store_id())
    OR assigned_to = auth.uid()
  );

-- --- tasks: INSERT ---
CREATE POLICY "tasks_insert_admin" ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (get_user_role() = 'admin');

CREATE POLICY "tasks_insert_manager" ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (get_user_role() = 'store_manager' AND store_id = get_user_store_id());

-- --- tasks: UPDATE ---
CREATE POLICY "tasks_update_admin" ON public.tasks FOR UPDATE TO authenticated
  USING (get_user_role() = 'admin');

CREATE POLICY "tasks_update_manager" ON public.tasks FOR UPDATE TO authenticated
  USING (get_user_role() = 'store_manager' AND store_id = get_user_store_id());

-- --- tasks: DELETE ---
CREATE POLICY "tasks_delete_admin" ON public.tasks FOR DELETE TO authenticated
  USING (get_user_role() = 'admin');

-- --- task_assignments ---
CREATE POLICY "ta_select" ON public.task_assignments FOR SELECT TO authenticated USING (true);
CREATE POLICY "ta_manage" ON public.task_assignments FOR ALL    TO authenticated
  USING (get_user_role() IN ('admin', 'store_manager'));

-- --- task_results ---
CREATE POLICY "tr_select" ON public.task_results FOR SELECT TO authenticated USING (true);
CREATE POLICY "tr_insert" ON public.task_results FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- --- task_templates ---
CREATE POLICY "tt_select" ON public.task_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "tt_manage" ON public.task_templates FOR ALL    TO authenticated
  USING (get_user_role() IN ('admin', 'store_manager'));

-- --- task_logs ---
CREATE POLICY "tl_select_admin"   ON public.task_logs FOR SELECT TO authenticated
  USING (get_user_role() = 'admin');

CREATE POLICY "tl_select_manager" ON public.task_logs FOR SELECT TO authenticated
  USING (
    get_user_role() = 'store_manager'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      WHERE t.id = task_id AND t.store_id = get_user_store_id()
    )
  );

CREATE POLICY "tl_insert" ON public.task_logs FOR INSERT TO authenticated WITH CHECK (true);
