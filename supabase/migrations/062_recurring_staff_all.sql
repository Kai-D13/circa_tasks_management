-- ============================================================
-- Migration 062: recurring schedules support "Toàn bộ dược sĩ" (staff_all)
-- ============================================================
-- Adds a per-schedule assignment_mode + widens the recurring idempotency index
-- so the cron can materialize 1 parent + N children per (schedule, store, day)
-- for staff_all schedules. Migration 031 deferred this exact change because the
-- old unique index (schedule, store, day) collided with multiple children.
-- Idempotent.
-- ============================================================

-- 1) Schedule-level mode. 'store' = one store-level task per store (current
--    behavior, unchanged); 'staff_all' = one task per pharmacist per store.
ALTER TABLE public.task_schedules
  ADD COLUMN IF NOT EXISTS assignment_mode text NOT NULL DEFAULT 'store'
    CHECK (assignment_mode IN ('store','staff_all'));

-- 2) Widen the recurring idempotency index. The old one
--    (migration 013) was UNIQUE (source_schedule_id, store_id, scheduled_for)
--    WHERE source_schedule_id IS NOT NULL — it permits only ONE row per
--    schedule/store/day, which rejects the parent + N children of a staff_all
--    run. Include COALESCE(assigned_to, <sentinel>) so:
--      * store mode  → assigned_to NULL → sentinel → one row/store/day (as before)
--      * staff_all parent → NULL → sentinel → exactly one parent/store/day
--      * staff_all child  → real staff uuid → one child/(store,day,staff)
--    A real uuid can never equal the all-zero sentinel, so parent vs child never
--    collide, and retries still cannot create duplicates.
DROP INDEX IF EXISTS public.idx_tasks_schedule_store_day;
CREATE UNIQUE INDEX idx_tasks_schedule_store_day
  ON public.tasks (
    source_schedule_id, store_id, scheduled_for,
    COALESCE(assigned_to, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE source_schedule_id IS NOT NULL;

INSERT INTO public.app_migrations (version, name)
VALUES ('062', 'recurring_staff_all')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Column exists:
-- SELECT column_name, data_type, column_default FROM information_schema.columns
--   WHERE table_name='task_schedules' AND column_name='assignment_mode';
--
-- 2) Index rebuilt with the COALESCE expression:
-- SELECT indexdef FROM pg_indexes WHERE indexname='idx_tasks_schedule_store_day';
--
-- 3) Migration recorded:
-- SELECT version FROM public.app_migrations WHERE version='062';
