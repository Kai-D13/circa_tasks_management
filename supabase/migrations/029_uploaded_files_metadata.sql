-- ============================================================
-- Migration 029 — task_uploaded_files metadata table
--
-- Tracks every file uploaded to task-uploads storage so we can:
--   • Link files to task_results after submit (audit trail)
--   • Identify orphan files (uploaded but never submitted)
--   • Clean up orphans via /api/cron/cleanup-uploads
--   • Report storage usage per task / user / day
--
-- Apply in Supabase SQL Editor before deploying the code changes.
-- No backfill — table accumulates from migration date forward.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.task_uploaded_files (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         uuid        NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  result_id       uuid        REFERENCES public.task_results(id) ON DELETE SET NULL,
  bucket          text        NOT NULL DEFAULT 'task-uploads',
  path            text        NOT NULL,
  thumbnail_path  text,
  mime_type       text        NOT NULL,
  size_bytes      bigint      NOT NULL DEFAULT 0,
  uploaded_by     uuid        REFERENCES public.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  linked_at       timestamptz,
  deleted_at      timestamptz,
  UNIQUE (path)
);

-- Fast lookup by task (submit linking, admin view)
CREATE INDEX IF NOT EXISTS idx_tuf_task
  ON public.task_uploaded_files (task_id);

-- Fast lookup by result (which files belong to a submission)
CREATE INDEX IF NOT EXISTS idx_tuf_result
  ON public.task_uploaded_files (result_id)
  WHERE result_id IS NOT NULL;

-- Orphan query: unlinked + not deleted + older than cutoff
CREATE INDEX IF NOT EXISTS idx_tuf_orphan
  ON public.task_uploaded_files (created_at)
  WHERE linked_at IS NULL AND deleted_at IS NULL;

ALTER TABLE public.task_uploaded_files ENABLE ROW LEVEL SECURITY;

-- Authenticated users can register their own uploads
CREATE POLICY tuf_insert ON public.task_uploaded_files
  FOR INSERT TO authenticated
  WITH CHECK (uploaded_by = auth.uid());

-- Users see their own uploads; admins see all
CREATE POLICY tuf_select ON public.task_uploaded_files
  FOR SELECT TO authenticated
  USING (
    uploaded_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
        AND u.role = 'admin'
    )
  );

-- ── Verification queries ──────────────────────────────────────────────────────
-- Run after applying to confirm the table, indexes, and policies are in place:

-- SELECT table_name FROM information_schema.tables WHERE table_name = 'task_uploaded_files';

-- SELECT indexname FROM pg_indexes WHERE tablename = 'task_uploaded_files';

-- SELECT policyname FROM pg_policies WHERE tablename = 'task_uploaded_files';

-- Orphan count (should be 0 on a fresh table):
-- SELECT COUNT(*) FROM public.task_uploaded_files WHERE linked_at IS NULL AND deleted_at IS NULL;
