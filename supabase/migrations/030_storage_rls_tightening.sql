-- ============================================================
-- Migration 030 — Storage RLS Tightening
--
-- 1. Drop the broad UPDATE policy on task-uploads storage objects.
--    The upload flow uses upsert:false so UPDATE is never needed by clients.
--    Admin/cron operations use the service role which bypasses Storage RLS.
--
-- 2. Replace the INSERT policy on task-uploads storage objects with a
--    path-scoped version that also verifies the uploader has submit access
--    to the target task (path format: tasks/<task_id>/image/<filename>).
--
-- 3. Tighten the task_uploaded_files INSERT policy to mirror the same
--    task-access logic, preventing users from registering metadata for
--    tasks they can't submit to.
--
-- Apply in Supabase SQL Editor before deploying code changes.
-- ============================================================

-- ── 1. Drop unused UPDATE policy ─────────────────────────────────────────────
DROP POLICY IF EXISTS "task_uploads_update" ON storage.objects;


-- ── 2. Tighten storage INSERT: path prefix + task access ─────────────────────
-- foldername(name) returns an array of path components excluding the filename.
-- For 'tasks/<task_id>/image/<file>.jpg' → [1]='tasks', [2]='<task_id>', [3]='image'.
DROP POLICY IF EXISTS "task_uploads_insert" ON storage.objects;

CREATE POLICY "task_uploads_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'task-uploads'
    AND (storage.foldername(name))[1] = 'tasks'
    AND EXISTS (
      SELECT 1
      FROM   public.tasks t
      JOIN   public.users u ON u.id = auth.uid()
      WHERE  t.id::text = (storage.foldername(name))[2]
        AND  t.archived_at IS NULL
        AND  (
          -- Direct assignee
          t.assigned_to = auth.uid()
          -- Store-level submit (unassigned task, user belongs to same store)
          OR (
            t.assigned_to IS NULL
            AND t.store_id IS NOT NULL
            AND t.store_id = u.store_id
            AND u.role IN ('staff', 'store_manager')
          )
          -- Admin can upload to any active task
          OR u.role = 'admin'
        )
    )
  );


-- ── 3. Tighten task_uploaded_files INSERT: require submit access ──────────────
DROP POLICY IF EXISTS tuf_insert ON public.task_uploaded_files;

CREATE POLICY tuf_insert ON public.task_uploaded_files
  FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM   public.tasks t
      JOIN   public.users u ON u.id = auth.uid()
      WHERE  t.id = task_id
        AND  t.archived_at IS NULL
        AND  (
          t.assigned_to = auth.uid()
          OR (
            t.assigned_to IS NULL
            AND t.store_id IS NOT NULL
            AND t.store_id = u.store_id
            AND u.role IN ('staff', 'store_manager')
          )
          OR u.role = 'admin'
        )
    )
  );


-- ── Verification queries ──────────────────────────────────────────────────────
-- After applying, confirm the policies are correct:

-- SELECT policyname, cmd, qual
-- FROM pg_policies
-- WHERE tablename = 'objects' AND schemaname = 'storage'
--   AND policyname IN ('task_uploads_insert', 'task_uploads_select', 'task_uploads_update');

-- Confirm task_uploads_update is gone (should return 0 rows):
-- SELECT COUNT(*) FROM pg_policies
-- WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'task_uploads_update';

-- Confirm task_uploaded_files INSERT policy:
-- SELECT policyname, cmd, qual
-- FROM pg_policies
-- WHERE tablename = 'task_uploaded_files' AND policyname = 'tuf_insert';
