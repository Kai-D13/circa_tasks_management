-- ============================================================
-- Migration 013: Recurring Task Foundation
-- ============================================================
-- Builds the data model for scheduled/recurring tasks.
-- Pattern: Admin creates a template + schedule. A cron job runs
-- daily and generates real tasks for each store according to
-- the schedule. Real tasks flow through the normal submit/review
-- workflow unchanged.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Extend task_templates (existing table, add missing cols)
-- ------------------------------------------------------------
ALTER TABLE public.task_templates
  ADD COLUMN IF NOT EXISTS is_active  boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- ------------------------------------------------------------
-- 2. task_schedules — one schedule per template
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.task_schedules (
  id                    uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  template_id           uuid    NOT NULL REFERENCES public.task_templates(id) ON DELETE CASCADE,
  frequency             text    NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  timezone              text    NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  run_time              time    NOT NULL DEFAULT '08:00',
  weekdays              int[]   NULL,   -- weekly: 0=Sun,1=Mon,...6=Sat
  month_day             int     NULL CHECK (month_day BETWEEN 1 AND 28),
  start_date            date    NOT NULL DEFAULT CURRENT_DATE,
  end_date              date    NULL,
  deadline_offset_hours int     NOT NULL DEFAULT 24,
  next_run_at           timestamptz NOT NULL,
  last_run_at           timestamptz NULL,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- ------------------------------------------------------------
-- 3. task_schedule_stores — which stores a schedule targets
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.task_schedule_stores (
  schedule_id uuid NOT NULL REFERENCES public.task_schedules(id) ON DELETE CASCADE,
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  PRIMARY KEY (schedule_id, store_id)
);

-- ------------------------------------------------------------
-- 4. task_generation_runs — cron run audit log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.task_generation_runs (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  schedule_id      uuid REFERENCES public.task_schedules(id) ON DELETE SET NULL,
  scheduled_for    date NOT NULL,
  status           text NOT NULL CHECK (status IN ('running','success','failed','skipped')),
  created_count    int  DEFAULT 0,
  error_message    text NULL,
  idempotency_key  text NOT NULL UNIQUE,
  started_at       timestamptz DEFAULT now(),
  finished_at      timestamptz NULL
);

-- ------------------------------------------------------------
-- 5. Extend tasks table with recurring-origin columns
-- ------------------------------------------------------------
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS source_template_id uuid REFERENCES public.task_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_schedule_id uuid REFERENCES public.task_schedules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS scheduled_for      date NULL,
  ADD COLUMN IF NOT EXISTS assignment_mode    text DEFAULT 'store'
    CHECK (assignment_mode IN ('store','user'));

-- Idempotency guard: one task per schedule × store × day
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_schedule_store_day
  ON public.tasks (source_schedule_id, store_id, scheduled_for)
  WHERE source_schedule_id IS NOT NULL;

-- ------------------------------------------------------------
-- 6. RLS
-- ------------------------------------------------------------

-- task_schedules
ALTER TABLE public.task_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ts_admin" ON public.task_schedules
  FOR ALL TO authenticated
  USING (get_user_role() = 'admin');

-- Store managers can see schedules that target their store
CREATE POLICY "ts_manager_select" ON public.task_schedules
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'store_manager'
    AND EXISTS (
      SELECT 1 FROM public.task_schedule_stores tss
      WHERE tss.schedule_id = id
        AND tss.store_id = get_user_store_id()
    )
  );

-- task_schedule_stores
ALTER TABLE public.task_schedule_stores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tss_admin" ON public.task_schedule_stores
  FOR ALL TO authenticated
  USING (get_user_role() = 'admin');

CREATE POLICY "tss_manager_select" ON public.task_schedule_stores
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'store_manager'
    AND store_id = get_user_store_id()
  );

-- task_generation_runs (admin only — cron audit)
ALTER TABLE public.task_generation_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tgr_admin" ON public.task_generation_runs
  FOR ALL TO authenticated
  USING (get_user_role() = 'admin');
