-- ============================================================
-- Migration 054: Indexes on task_logs (scaling /logs)
-- ============================================================
-- task_logs (migration 001) had NO indexes. /logs orders by created_at DESC
-- and filters by task_id / user_id / action; RLS scopes by user_id and the
-- task join. As the audit log grows every read is a full scan. These indexes
-- fix that; data is unchanged (no retention here).
--
-- IMPORTANT: run this file AS-IS in the Supabase SQL editor (do NOT wrap in a
-- transaction). CREATE INDEX CONCURRENTLY cannot run inside BEGIN/COMMIT and
-- builds without locking writes on the live table.
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_task_logs_created_at
  ON public.task_logs (created_at DESC);

-- Covers RLS staff/manager (user_id = auth.uid()) + the user_id filter, with
-- created_at for the ordering.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_task_logs_user_created
  ON public.task_logs (user_id, created_at DESC);

-- Task join (tasks!inner) + RLS branches that match on task_id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_task_logs_task_id
  ON public.task_logs (task_id);

-- Optional action filter on /logs.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_task_logs_action
  ON public.task_logs (action);

-- Record this migration.
INSERT INTO public.app_migrations (version, name)
VALUES ('054', 'task_logs_indexes')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Indexes exist + valid:
-- SELECT indexname, indisvalid FROM pg_indexes
-- JOIN pg_class c ON c.relname = indexname
-- JOIN pg_index i ON i.indexrelid = c.oid
-- WHERE tablename = 'task_logs' AND schemaname='public';
-- expect: idx_task_logs_created_at / _user_created / _task_id / _action, all valid=true
--
-- 2) Planner now uses the index for the default ordering:
-- EXPLAIN ANALYZE SELECT * FROM public.task_logs ORDER BY created_at DESC LIMIT 50;
-- expect: Index Scan using idx_task_logs_created_at (not Seq Scan + Sort)
--
-- 3) Migration recorded:
-- SELECT version FROM public.app_migrations WHERE version='054';
