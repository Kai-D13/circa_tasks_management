-- ============================================================
-- Migration 038: RLS auth_rls_initplan fix (hot-path tables)
-- ============================================================
-- Wraps per-row function calls in scalar subqueries so Postgres evaluates them
-- ONCE per query (InitPlan) instead of once per row:
--   auth.uid()            -> (select auth.uid())
--   get_user_role()       -> (select public.get_user_role())
--   get_user_store_id()   -> (select public.get_user_store_id())
--   is_super_admin()      -> (select public.is_super_admin())
--
-- Business logic is IDENTICAL to the live policies exported on 2026-06-08 - only
-- the call form changes. This directly removes the 138k-call per-row
-- get_user_store_id()/auth.uid() pattern from the slow-query report.
--
-- Scope: hot-path / large-volume tables only (tasks, task_results, task_logs,
-- task_uploaded_files, notifications, prescription_submissions,
-- prescription_images, storage.objects). Small admin-only config tables are
-- handled separately in 038b to keep this change focused and easy to roll back.
--
-- Rollback: re-create each policy below from the pre-038 pg_policies export
-- (function calls unwrapped).
-- Idempotent: DROP POLICY IF EXISTS before each CREATE.
-- ============================================================

BEGIN;

-- -- notifications (role: public) ---------------------------------------------
DROP POLICY IF EXISTS notifications_select ON public.notifications;
CREATE POLICY notifications_select ON public.notifications
  FOR SELECT TO public
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS notifications_update ON public.notifications;
CREATE POLICY notifications_update ON public.notifications
  FOR UPDATE TO public
  USING (user_id = (select auth.uid()));


-- -- tasks --------------------------------------------------------------------
DROP POLICY IF EXISTS tasks_select_admin ON public.tasks;
CREATE POLICY tasks_select_admin ON public.tasks
  FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select public.get_user_role()) = 'admin' AND created_by = (select auth.uid()))
    OR ((select public.get_user_role()) = 'admin' AND EXISTS (
          SELECT 1 FROM public.task_collaborators tc
          WHERE tc.task_id = tasks.id AND tc.admin_id = (select auth.uid())))
  );

DROP POLICY IF EXISTS tasks_select_manager ON public.tasks;
CREATE POLICY tasks_select_manager ON public.tasks
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'store_manager'
    AND store_id = (select public.get_user_store_id())
  );

DROP POLICY IF EXISTS tasks_select_staff ON public.tasks;
CREATE POLICY tasks_select_staff ON public.tasks
  FOR SELECT TO authenticated
  USING (
    visibility = 'public'
    OR (visibility = 'store' AND store_id = (select public.get_user_store_id()))
    OR assigned_to = (select auth.uid())
  );

DROP POLICY IF EXISTS tasks_insert_admin ON public.tasks;
CREATE POLICY tasks_insert_admin ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    (select public.get_user_role()) = 'admin' AND created_by = (select auth.uid())
  );

DROP POLICY IF EXISTS tasks_update_admin ON public.tasks;
CREATE POLICY tasks_update_admin ON public.tasks
  FOR UPDATE TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select public.get_user_role()) = 'admin' AND created_by = (select auth.uid()))
  )
  WITH CHECK (
    (select public.is_super_admin())
    OR ((select public.get_user_role()) = 'admin' AND created_by = (select auth.uid()))
  );

DROP POLICY IF EXISTS tasks_delete_admin ON public.tasks;
CREATE POLICY tasks_delete_admin ON public.tasks
  FOR DELETE TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select public.get_user_role()) = 'admin' AND created_by = (select auth.uid()))
  );


-- -- task_results -------------------------------------------------------------
DROP POLICY IF EXISTS tr_insert ON public.task_results;
CREATE POLICY tr_insert ON public.task_results
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (select auth.uid())
    AND (
      EXISTS (
        SELECT 1 FROM public.tasks t
        WHERE t.id = task_results.task_id AND t.assigned_to = (select auth.uid())
      )
      OR EXISTS (
        SELECT 1 FROM public.tasks t JOIN public.users u ON u.id = (select auth.uid())
        WHERE t.id = task_results.task_id
          AND t.assigned_to IS NULL
          AND t.assignment_mode <> 'staff_all'
          AND t.store_id IS NOT NULL
          AND t.store_id = u.store_id
          AND u.role = 'store_manager'
      )
    )
  );

DROP POLICY IF EXISTS tr_select_admin ON public.task_results;
CREATE POLICY tr_select_admin ON public.task_results
  FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select public.get_user_role()) = 'admin' AND EXISTS (
          SELECT 1 FROM public.tasks t
          WHERE t.id = task_results.task_id AND t.created_by = (select auth.uid())))
    OR ((select public.get_user_role()) = 'admin' AND EXISTS (
          SELECT 1 FROM public.task_collaborators tc
          WHERE tc.task_id = task_results.task_id AND tc.admin_id = (select auth.uid())))
  );

DROP POLICY IF EXISTS tr_select_manager ON public.task_results;
CREATE POLICY tr_select_manager ON public.task_results
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'store_manager'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      WHERE t.id = task_results.task_id AND t.store_id = (select public.get_user_store_id())
    )
  );

DROP POLICY IF EXISTS tr_select_staff ON public.task_results;
CREATE POLICY tr_select_staff ON public.task_results
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'staff' AND user_id = (select auth.uid())
  );


-- -- task_logs ----------------------------------------------------------------
DROP POLICY IF EXISTS tl_insert ON public.task_logs;
CREATE POLICY tl_insert ON public.task_logs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS tl_select_admin ON public.task_logs;
CREATE POLICY tl_select_admin ON public.task_logs
  FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select public.get_user_role()) = 'admin' AND (
          user_id = (select auth.uid())
          OR EXISTS (SELECT 1 FROM public.tasks t
                     WHERE t.id = task_logs.task_id AND t.created_by = (select auth.uid()))
          OR EXISTS (SELECT 1 FROM public.task_collaborators tc
                     WHERE tc.task_id = task_logs.task_id AND tc.admin_id = (select auth.uid()))
       ))
  );

DROP POLICY IF EXISTS tl_select_manager ON public.task_logs;
CREATE POLICY tl_select_manager ON public.task_logs
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'store_manager' AND (
      user_id = (select auth.uid())
      OR EXISTS (SELECT 1 FROM public.users u
                 WHERE u.id = task_logs.user_id AND u.store_id = (select public.get_user_store_id()))
    )
  );

DROP POLICY IF EXISTS tl_select_staff ON public.task_logs;
CREATE POLICY tl_select_staff ON public.task_logs
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'staff' AND (
      user_id = (select auth.uid())
      OR EXISTS (SELECT 1 FROM public.tasks t
                 WHERE t.id = task_logs.task_id AND t.assigned_to = (select auth.uid()))
    )
  );


-- -- task_uploaded_files ------------------------------------------------------
DROP POLICY IF EXISTS tuf_insert ON public.task_uploaded_files;
CREATE POLICY tuf_insert ON public.task_uploaded_files
  FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = (select auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.tasks t JOIN public.users u ON u.id = (select auth.uid())
      WHERE t.id = task_uploaded_files.task_id
        AND t.archived_at IS NULL
        AND (
          t.assigned_to = (select auth.uid())
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

DROP POLICY IF EXISTS tuf_select ON public.task_uploaded_files;
CREATE POLICY tuf_select ON public.task_uploaded_files
  FOR SELECT TO authenticated
  USING (
    uploaded_by = (select auth.uid())
    OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = (select auth.uid()) AND u.role = 'admin')
  );


-- -- prescription_submissions -------------------------------------------------
DROP POLICY IF EXISTS ps_insert_staff ON public.prescription_submissions;
CREATE POLICY ps_insert_staff ON public.prescription_submissions
  FOR INSERT TO authenticated
  WITH CHECK (
    (select public.get_user_role()) = 'staff'
    AND submitted_by = (select auth.uid())
    AND store_id = (select public.get_user_store_id())
  );

DROP POLICY IF EXISTS ps_select_admin ON public.prescription_submissions;
CREATE POLICY ps_select_admin ON public.prescription_submissions
  FOR SELECT TO authenticated
  USING ((select public.get_user_role()) = 'admin');

DROP POLICY IF EXISTS ps_select_manager ON public.prescription_submissions;
CREATE POLICY ps_select_manager ON public.prescription_submissions
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'store_manager'
    AND store_id = (select public.get_user_store_id())
  );

DROP POLICY IF EXISTS ps_select_staff ON public.prescription_submissions;
CREATE POLICY ps_select_staff ON public.prescription_submissions
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'staff' AND submitted_by = (select auth.uid())
  );

DROP POLICY IF EXISTS ps_update_super ON public.prescription_submissions;
CREATE POLICY ps_update_super ON public.prescription_submissions
  FOR UPDATE TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));


-- -- prescription_images ------------------------------------------------------
DROP POLICY IF EXISTS pi_insert_staff ON public.prescription_images;
CREATE POLICY pi_insert_staff ON public.prescription_images
  FOR INSERT TO authenticated
  WITH CHECK (
    (select public.get_user_role()) = 'staff'
    AND EXISTS (
      SELECT 1 FROM public.prescription_submissions s
      WHERE s.id = prescription_images.submission_id AND s.submitted_by = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS pi_select_admin ON public.prescription_images;
CREATE POLICY pi_select_admin ON public.prescription_images
  FOR SELECT TO authenticated
  USING ((select public.get_user_role()) = 'admin');

DROP POLICY IF EXISTS pi_select_manager ON public.prescription_images;
CREATE POLICY pi_select_manager ON public.prescription_images
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'store_manager'
    AND EXISTS (
      SELECT 1 FROM public.prescription_submissions s
      WHERE s.id = prescription_images.submission_id AND s.store_id = (select public.get_user_store_id())
    )
  );

DROP POLICY IF EXISTS pi_select_staff ON public.prescription_images;
CREATE POLICY pi_select_staff ON public.prescription_images
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'staff'
    AND EXISTS (
      SELECT 1 FROM public.prescription_submissions s
      WHERE s.id = prescription_images.submission_id AND s.submitted_by = (select auth.uid())
    )
  );


-- -- storage.objects: task_uploads_insert (every upload) ----------------------
DROP POLICY IF EXISTS task_uploads_insert ON storage.objects;
CREATE POLICY task_uploads_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'task-uploads'
    AND (
      (
        (storage.foldername(name))[1] = 'tasks'
        AND EXISTS (
          SELECT 1 FROM public.tasks t JOIN public.users u ON u.id = (select auth.uid())
          WHERE t.id::text = (storage.foldername(name))[2]
            AND t.archived_at IS NULL
            AND (
              t.assigned_to = (select auth.uid())
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
      OR (
        (storage.foldername(name))[1] = 'task-inputs'
        AND EXISTS (
          SELECT 1 FROM public.users u WHERE u.id = (select auth.uid()) AND u.role = 'admin'
        )
      )
      OR (
        (storage.foldername(name))[1] = 'prescriptions'
        AND EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = (select auth.uid())
            AND u.store_id::text = (storage.foldername(name))[2]
            AND u.role = ANY (ARRAY['staff', 'store_manager'])
        )
      )
    )
  );


-- Record this migration.
INSERT INTO public.app_migrations (version, name, notes)
VALUES ('038', 'rls_initplan', 'wrap auth/helper calls in (select ...) on hot-path tables')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- -- Verification -------------------------------------------------------------
-- Regex on pg_policies.qual is unreliable: Postgres may deparse
-- (select auth.uid()) as (SELECT uid() AS uid), making uid() appear unwrapped.
-- Instead, verify that all 28 expected policies were created (expect 28 rows).
-- A missing row means the DROP succeeded but the CREATE failed - impossible
-- inside the transaction, but this confirms the transaction committed cleanly.
--
-- SELECT tablename, policyname, cmd
-- FROM pg_policies
-- WHERE schemaname IN ('public','storage')
--   AND (tablename::text, policyname::text) IN (
--     VALUES
--       ('notifications','notifications_select'), ('notifications','notifications_update'),
--       ('tasks','tasks_select_admin'),   ('tasks','tasks_select_manager'),
--       ('tasks','tasks_select_staff'),   ('tasks','tasks_insert_admin'),
--       ('tasks','tasks_update_admin'),   ('tasks','tasks_delete_admin'),
--       ('task_results','tr_insert'),     ('task_results','tr_select_admin'),
--       ('task_results','tr_select_manager'), ('task_results','tr_select_staff'),
--       ('task_logs','tl_insert'),        ('task_logs','tl_select_admin'),
--       ('task_logs','tl_select_manager'),('task_logs','tl_select_staff'),
--       ('task_uploaded_files','tuf_insert'), ('task_uploaded_files','tuf_select'),
--       ('prescription_submissions','ps_insert_staff'),
--       ('prescription_submissions','ps_select_admin'),
--       ('prescription_submissions','ps_select_manager'),
--       ('prescription_submissions','ps_select_staff'),
--       ('prescription_submissions','ps_update_super'),
--       ('prescription_images','pi_insert_staff'),
--       ('prescription_images','pi_select_admin'),
--       ('prescription_images','pi_select_manager'),
--       ('prescription_images','pi_select_staff'),
--       ('objects','task_uploads_insert')
--   )
-- ORDER BY tablename, policyname;
-- -- Expect 28 rows.
--
-- 2) Confirm tracking row:
-- SELECT version, name, applied_at FROM public.app_migrations ORDER BY version;
--
-- 3) Optional InitPlan spot-check (look for "InitPlan" nodes in the plan):
-- EXPLAIN (VERBOSE true, COSTS false) SELECT * FROM public.tasks LIMIT 1;
