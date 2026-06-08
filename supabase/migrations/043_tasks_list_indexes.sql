-- ============================================================
-- Migration 043: Indexes for the pending/done task-list views
-- ============================================================
-- The /tasks list is now split into two query shapes (one per view tab):
--   pending -> WHERE archived_at IS NULL AND status <> 'done'
--              ORDER BY deadline ASC NULLS LAST, created_at DESC
--   done    -> WHERE archived_at IS NULL AND status = 'done'
--              ORDER BY completed_at DESC NULLS LAST, created_at DESC
-- SM/Admin views additionally filter by store_id.
--
-- These partial, ordered indexes let Postgres satisfy both the filter and the
-- ORDER BY from the index directly (no full scan + sort) as the table grows.
-- Index column orders/NULLS placement mirror the ORDER BY exactly so the planner
-- can use them for ordering, not just filtering.
--
-- Plain CREATE INDEX (not CONCURRENTLY) is fine at current scale and lets this run
-- in a transaction. If the tasks table ever grows large enough that the brief
-- ACCESS EXCLUSIVE lock matters, re-issue these as CREATE INDEX CONCURRENTLY
-- outside a transaction instead.
--
-- Rollback: DROP INDEX IF EXISTS <name>; for each index below.
-- ============================================================

BEGIN;

-- Pending view (all roles)
CREATE INDEX IF NOT EXISTS idx_tasks_open_deadline
  ON public.tasks (deadline ASC NULLS LAST, created_at DESC)
  WHERE archived_at IS NULL AND status <> 'done';

-- Done view (all roles)
CREATE INDEX IF NOT EXISTS idx_tasks_done_completed_at
  ON public.tasks (completed_at DESC NULLS LAST, created_at DESC)
  WHERE archived_at IS NULL AND status = 'done';

-- Pending view scoped to a store (SM / Admin store filter)
CREATE INDEX IF NOT EXISTS idx_tasks_store_open_deadline
  ON public.tasks (store_id, deadline ASC NULLS LAST, created_at DESC)
  WHERE archived_at IS NULL AND status <> 'done';

-- Done view scoped to a store (SM / Admin store filter on history)
CREATE INDEX IF NOT EXISTS idx_tasks_store_done_completed_at
  ON public.tasks (store_id, completed_at DESC NULLS LAST, created_at DESC)
  WHERE archived_at IS NULL AND status = 'done';

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('043', 'tasks_list_indexes', 'Partial ordered indexes for pending/done task-list views (incl. store-scoped)')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- -- Verification -------------------------------------------------------------
-- 1) Indexes exist:
-- SELECT indexname FROM pg_indexes
-- WHERE tablename = 'tasks'
--   AND indexname IN ('idx_tasks_open_deadline','idx_tasks_done_completed_at',
--                     'idx_tasks_store_open_deadline','idx_tasks_store_done_completed_at');
-- expect: 4 rows
--
-- 2) Planner uses them (run after some data exists; may need ANALYZE public.tasks):
-- EXPLAIN SELECT id FROM public.tasks
--   WHERE archived_at IS NULL AND status <> 'done'
--   ORDER BY deadline ASC NULLS LAST, created_at DESC LIMIT 30;
-- expect: Index Scan using idx_tasks_open_deadline (not Seq Scan + Sort)
