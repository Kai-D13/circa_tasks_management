-- ============================================================
-- Migration 033 — Remove admin branch from result-upload policies
--
-- Finding: migration 032 left `u.role = 'admin'` in the tasks/* storage INSERT
-- and tuf_insert policies. Admins never submit task results in this application
-- (isStoreSubmitter requires a matching store_id, which admins don't have, and
-- tasks are never directly assigned to admins). The branch was too broad against
-- the own-scope model and created a potential path to upload or register metadata
-- for any task regardless of store ownership.
--
-- Fix: remove the admin branch from the tasks/* result-upload path entirely.
-- task-inputs/* (admin-only) and prescriptions/* remain unchanged.
-- Service-role operations bypass Storage RLS and are unaffected.
--
-- Apply after 032_rls_hardening.sql.
-- ============================================================


-- ── storage task_uploads_insert: drop admin branch from tasks/* ───────────────
DROP POLICY IF EXISTS "task_uploads_insert" ON storage.objects;

CREATE POLICY "task_uploads_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'task-uploads'
    AND (
      -- tasks/<task_id>/image/... — result images uploaded during submit.
      -- Only the direct assignee (staff_all child or direct-assign task) or the
      -- store_manager for a store-level task may upload. Admin never submits results.
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
            )
        )
      )

      -- task-inputs/<uploadId>/... — instruction/guide files: admin only.
      OR (
        (storage.foldername(name))[1] = 'task-inputs'
        AND EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid()
            AND u.role = 'admin'
        )
      )

      -- prescriptions/<storeId>/... — prescription images: store-scoped staff/manager.
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


-- ── tuf_insert: drop admin branch, mirror storage result-upload ───────────────
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
        )
    )
  );


-- ── Verification ─────────────────────────────────────────────────────────────
-- INSERT policies use WITH CHECK, not USING — inspect with_check column:

-- SELECT policyname, cmd, with_check FROM pg_policies
-- WHERE tablename = 'objects' AND schemaname = 'storage' AND policyname = 'task_uploads_insert';

-- SELECT policyname, cmd, with_check FROM pg_policies
-- WHERE tablename = 'task_uploaded_files' AND policyname = 'tuf_insert';

-- SELECT policyname, cmd, with_check FROM pg_policies
-- WHERE tablename = 'task_results' AND policyname = 'tr_insert';
