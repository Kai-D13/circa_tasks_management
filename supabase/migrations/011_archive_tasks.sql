-- Add archived_at column for soft-archive feature
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Partial index: fast queries for active (non-archived) tasks sorted by created_at
CREATE INDEX IF NOT EXISTS idx_tasks_archived_active
  ON public.tasks (created_at DESC)
  WHERE archived_at IS NULL;

-- Index for archive view queries
CREATE INDEX IF NOT EXISTS idx_tasks_archived_at
  ON public.tasks (archived_at DESC)
  WHERE archived_at IS NOT NULL;

-- Additional performance indexes for common filter combinations
CREATE INDEX IF NOT EXISTS idx_tasks_broadcast_id
  ON public.tasks (broadcast_id)
  WHERE broadcast_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_store_status
  ON public.tasks (store_id, status)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_status_deadline
  ON public.tasks (status, deadline)
  WHERE archived_at IS NULL;
