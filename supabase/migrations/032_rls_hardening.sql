-- ============================================================
-- Migration 032 — staff_all RLS + storage hardening
--
-- Finding 1 (High): task_results INSERT — Case 2 matches staff_all parent
--   (assigned_to IS NULL) so a store_manager could bypass the app-level
--   guard and insert a result row for the parent. Fix: exclude staff_all.
--
-- Finding 2 (High): storage tasks/* INSERT — store-level branch allowed
--   role IN ('staff', 'store_manager'), but the submit permission (tr_insert)
--   is store_manager only. Align them. Also exclude staff_all parent.
--
-- Finding 3 (Medium): storage task-inputs/* and prescriptions/* had no
--   role/store check at all. Fix: admin-only for task-inputs; store-scoped
--   staff/manager for prescriptions.
--
-- tuf_insert (task_uploaded_files) mirrors the storage upload permission
--   so metadata rows stay in sync. Apply the same alignment.
--
-- Apply in Supabase SQL Editor after 031_staff_required_tasks.sql.
-- ============================================================


-- ── Finding 1: task_results INSERT — block staff_all parent ──────────────────
DROP POLICY IF EXISTS "tr_insert" ON public.task_results;

CREATE POLICY "tr_insert" ON public.task_results FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (
      -- Case 1: task is directly assigned to this user (staff_all children, direct-assign tasks)
      EXISTS (
        SELECT 1 FROM public.tasks t
        WHERE t.id = task_id
          AND t.assigned_to = auth.uid()
      )
      OR
      -- Case 2: store-level task (no assignee), submitter is store_manager of that store.
      -- Explicitly excludes staff_all parents: they have assigned_to IS NULL but are
      -- never submittable — only their children are.
      EXISTS (
        SELECT 1 FROM public.tasks t
        JOIN public.users u ON u.id = auth.uid()
        WHERE t.id = task_id
          AND t.assigned_to IS NULL
          AND t.assignment_mode <> 'staff_all'
          AND t.store_id IS NOT NULL
          AND t.store_id = u.store_id
          AND u.role = 'store_manager'
      )
    )
  );


-- ── Finding 2 + 3: storage INSERT — align with submit permission ─────────────
DROP POLICY IF EXISTS "task_uploads_insert" ON storage.objects;

CREATE POLICY "task_uploads_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'task-uploads'
    AND (
      -- tasks/<task_id>/image/... — result images uploaded during submit.
      -- Store-level branch: store_manager only (mirrors tr_insert Case 2).
      -- Explicitly excludes staff_all parent (not submittable).
      (
        (storage.foldername(name))[1] = 'tasks'
        AND EXISTS (
          SELECT 1
          FROM   public.tasks t
          JOIN   public.users u ON u.id = auth.uid()
          WHERE  t.id::text = (storage.foldername(name))[2]
            AND  t.archived_at IS NULL
            AND  (
              t.assigned_to = auth.uid()
              OR (
                t.assigned_to IS NULL
                AND t.assignment_mode <> 'staff_all'
                AND t.store_id IS NOT NULL
                AND t.store_id = u.store_id
                AND u.role = 'store_manager'
              )
              OR u.role = 'admin'
            )
        )
      )

      -- task-inputs/<uploadId>/... — instruction/guide files attached when creating tasks.
      -- Only admins create tasks with attachments.
      OR (
        (storage.foldername(name))[1] = 'task-inputs'
        AND EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid()
            AND u.role = 'admin'
        )
      )

      -- prescriptions/<storeId>/... — prescription images uploaded by store staff/manager.
      -- Path component [2] must match the uploader's store_id.
      OR (
        (storage.foldername(name))[1] = 'prescriptions'
        AND EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid()
            AND u.store_id::text = (storage.foldername(name))[2]
            AND u.role IN ('staff', 'store_manager')
        )
      )
    )
  );


-- ── task_uploaded_files INSERT — mirror storage submit alignment ──────────────
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
            AND t.assignment_mode <> 'staff_all'
            AND t.store_id IS NOT NULL
            AND t.store_id = u.store_id
            AND u.role = 'store_manager'
          )
          OR u.role = 'admin'
        )
    )
  );


-- ── Verification ─────────────────────────────────────────────────────────────
-- INSERT policies use WITH CHECK, not USING — inspect with_check column:

-- SELECT policyname, cmd, with_check FROM pg_policies
-- WHERE tablename = 'task_results' AND policyname = 'tr_insert';

-- SELECT policyname, cmd, with_check FROM pg_policies
-- WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'task_uploads_insert';

-- SELECT policyname, cmd, with_check FROM pg_policies
-- WHERE tablename = 'task_uploaded_files' AND policyname = 'tuf_insert';

-- Note: 033_storage_tuf_admin_branch_removal.sql supersedes the tasks/* and
-- tuf_insert policies created here by removing the admin result-upload branch.
