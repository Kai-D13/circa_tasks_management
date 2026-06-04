-- ============================================================
-- 026 — Performance indexes for the tasks table
-- ============================================================
-- These indexes cover the main query patterns in /tasks (list + filters),
-- the dashboard KPI count queries, and the overdue cron sweep.
-- All created with IF NOT EXISTS — safe to re-run.

-- Primary list query: non-archived tasks ordered by created_at
-- Covers: .is('archived_at', null) + .order('created_at', { ascending: false })
CREATE INDEX IF NOT EXISTS idx_tasks_active_created
  ON public.tasks (created_at DESC)
  WHERE archived_at IS NULL;

-- Status filter (most common filter in the admin list)
CREATE INDEX IF NOT EXISTS idx_tasks_status_active
  ON public.tasks (status)
  WHERE archived_at IS NULL;

-- Deadline — used by the overdue cron (.lt('deadline', now)) and status filters
CREATE INDEX IF NOT EXISTS idx_tasks_deadline
  ON public.tasks (deadline)
  WHERE archived_at IS NULL AND status NOT IN ('done', 'overdue');

-- Store filter
CREATE INDEX IF NOT EXISTS idx_tasks_store_id
  ON public.tasks (store_id)
  WHERE archived_at IS NULL;

-- Broadcast grouping (collapse children on the list page)
CREATE INDEX IF NOT EXISTS idx_tasks_broadcast_id
  ON public.tasks (broadcast_id)
  WHERE broadcast_id IS NOT NULL;

-- Archived list (separate view)
CREATE INDEX IF NOT EXISTS idx_tasks_archived
  ON public.tasks (created_at DESC)
  WHERE archived_at IS NOT NULL;

-- overdue_at — used by badge queries and the late tracking marker
CREATE INDEX IF NOT EXISTS idx_tasks_overdue_at
  ON public.tasks (overdue_at)
  WHERE overdue_at IS NOT NULL;
