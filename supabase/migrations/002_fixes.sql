-- ============================================================
-- Patch 002 — Bug fixes
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Fix admin user role (replace email as needed)
UPDATE public.users
SET role = 'admin', full_name = 'Admin'
WHERE email = 'hoangvudn96@gmail.com';

-- 2. Fix visibility on existing tasks that were assigned to someone
--    but still had visibility = 'store' (causing staff to see them).
--    Going forward the form auto-sets 'private' when an assignee is selected.
UPDATE public.tasks
SET visibility = 'private'
WHERE assigned_to IS NOT NULL
  AND visibility = 'store';

-- 3. Allow task_logs INSERT from service-role (server actions run as
--    anon/service depending on config) — ensure insert policy is present.
--    (already in 001 as tl_insert, but re-create idempotently)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'task_logs' AND policyname = 'tl_insert'
  ) THEN
    EXECUTE 'CREATE POLICY "tl_insert" ON public.task_logs FOR INSERT TO authenticated WITH CHECK (true)';
  END IF;
END $$;

-- 4. Verify: check what role your users have after the fix
SELECT id, email, full_name, role, store_id FROM public.users ORDER BY role, full_name;
