-- ============================================================
-- Migration 009: Task categories + broadcast grouping
-- ============================================================

-- 1. Add category to tasks
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS category text DEFAULT 'other'
  CHECK (category IN ('training','recall','display','audit','other'));

-- 2. Broadcast group table — one row per broadcast, links N tasks
CREATE TABLE IF NOT EXISTS public.task_broadcasts (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title       text NOT NULL,
  created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  store_count int  NOT NULL DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);

-- 3. Link tasks back to their broadcast group
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS broadcast_id uuid REFERENCES public.task_broadcasts(id) ON DELETE SET NULL;

-- 4. RLS for task_broadcasts
ALTER TABLE public.task_broadcasts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tb_admin_all"    ON public.task_broadcasts FOR ALL     TO authenticated USING (get_user_role() = 'admin');
CREATE POLICY "tb_manager_read" ON public.task_broadcasts FOR SELECT  TO authenticated USING (get_user_role() = 'store_manager');
CREATE POLICY "tb_staff_read"   ON public.task_broadcasts FOR SELECT  TO authenticated USING (get_user_role() = 'staff');
