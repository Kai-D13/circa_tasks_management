-- ============================================================
-- 035 — Drop exact-duplicate task index
-- ============================================================
-- idx_tasks_archived_active (011_archive_tasks.sql) and idx_tasks_active_created
-- (026_task_indexes.sql) are byte-identical:
--   ON public.tasks (created_at DESC) WHERE archived_at IS NULL
--
-- Two identical indexes double the maintenance cost on every task insert/update
-- (status changes, staff_all child inserts, the overdue cron sweep) for zero read
-- benefit. Keep idx_tasks_active_created (026 — clearer name, documented there);
-- drop the older duplicate.
--
-- Note: the *overlapping* (not identical) pairs — idx_tasks_store_id vs
-- idx_tasks_store_status, idx_tasks_status_active vs idx_tasks_status_deadline —
-- are intentionally left in place; they need a real Performance Advisor audit
-- before removal, not a blind drop.

DROP INDEX IF EXISTS public.idx_tasks_archived_active;
