-- ============================================================
-- Migration 053: Human-friendly sequential task code (display only)
-- ============================================================
-- Stakeholder ask (2026-06-13): PICs find the UUID task_id hard to monitor.
-- Add a SHORT sequential number for display — UUID stays the primary key
-- (changing PKs would break every FK / RLS policy / storage path that embeds
-- the task id, for zero real benefit at this scale).
--
-- tasks.seq: bigint, auto-incremented by a sequence on insert. Existing rows
-- backfilled in created_at order so the numbering reads chronologically. The
-- app renders it as "T-001042" (formatTaskCode in webapp/lib/taskCode.ts).
-- Additive + reversible; no FK/RLS/storage impact.
-- Idempotent.
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS public.tasks_seq_seq;

ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS seq bigint;

-- Backfill existing rows in chronological order (only rows still missing a seq).
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
  FROM public.tasks
  WHERE seq IS NULL
)
UPDATE public.tasks t
SET seq = ordered.rn
FROM ordered
WHERE t.id = ordered.id;

-- Continue the sequence after the current max so new inserts never collide.
SELECT setval('public.tasks_seq_seq', COALESCE((SELECT max(seq) FROM public.tasks), 0) + 1, false);

-- New rows auto-assign from the sequence (app inserts never set seq explicitly).
ALTER TABLE public.tasks ALTER COLUMN seq SET DEFAULT nextval('public.tasks_seq_seq');

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_seq ON public.tasks (seq);

-- Record this migration.
INSERT INTO public.app_migrations (version, name)
VALUES ('053', 'task_seq')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Column + default present:
-- SELECT column_name, column_default FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='tasks' AND column_name='seq';
-- expect: column_default = nextval('tasks_seq_seq'::regclass)
--
-- 2) Backfill contiguous, chronological:
-- SELECT min(seq), max(seq), count(*) , count(seq) FROM public.tasks;
-- expect: count = count(seq) (no nulls), max = count
--
-- 3) A new task gets the next number automatically (create one in the app).
--
-- 4) Migration recorded:
-- SELECT version FROM public.app_migrations WHERE version='053';
