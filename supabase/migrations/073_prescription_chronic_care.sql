-- ============================================================================
-- 073_prescription_chronic_care.sql
-- Toa mạn tính (chronic prescription care), phase 1 — ADDITIVE ONLY.
--
-- Staff tick "Toa thuốc mạn tính" + số ngày dùng khi nộp toa. A cron pulls
-- order/customer data from a Google Sheet (BigQuery-fed) by DHC order_code and
-- computes expected_refill_date = order_created_at + days_supply and
-- reminder_date = expected_refill_date - 2 days. Staff/store managers of the
-- store then log a care visit (note + evidence images).
--
-- IMPORTANT SEMANTICS — do not confuse with the EXISTING product sync:
--   * prescription_submissions.status ('pending_sync'/'synced') + sync_batch_id
--     + synced_at/synced_by = the PRODUCT sync (admin pastes internal JSON).
--     UNTOUCHED here.
--   * NEW order_sync_status ('pending'/'synced'/'error') = the ORDER data pull
--     from the Google Sheet. Fully separate columns + wording.
-- care_status stores only stable states ('none'/'done'/'ignored');
-- "Sắp đến kỳ"/"Cần chăm sóc" are DERIVED at read time from reminder_date vs
-- today (no daily status-flip cron, can never go stale).
--
-- Additive + idempotent + pg_safeupdate-safe. Run BEFORE deploying the app
-- build (old code ignores the new defaulted columns). Records app_migrations 073.
-- Rollback: drop the two new tables + the added columns (no core edits).
-- ============================================================================

BEGIN;

-- ── 1. prescription_submissions: chronic + order-sync + care columns ────────
ALTER TABLE public.prescription_submissions
  ADD COLUMN IF NOT EXISTS is_chronic           boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS days_supply          int,
  ADD COLUMN IF NOT EXISTS order_created_at     date,
  ADD COLUMN IF NOT EXISTS expected_refill_date date,
  ADD COLUMN IF NOT EXISTS reminder_date        date,
  ADD COLUMN IF NOT EXISTS customer_name        text,
  ADD COLUMN IF NOT EXISTS customer_phone       text,   -- text: keeps leading 0
  ADD COLUMN IF NOT EXISTS pos_code             text,
  ADD COLUMN IF NOT EXISTS pos_name             text,
  ADD COLUMN IF NOT EXISTS order_products_raw   text,   -- raw "products" string from the Sheet (phase 1)
  ADD COLUMN IF NOT EXISTS order_sync_status    text    NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS order_sync_error     text,
  ADD COLUMN IF NOT EXISTS care_status          text    NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS last_care_at         timestamptz,
  ADD COLUMN IF NOT EXISTS last_care_by         uuid REFERENCES public.users(id);

-- Constraints (added separately so re-runs are safe). NOTE: deliberately NO
-- format CHECK on order_code — legacy rows predate the strict DHC00+6-digit
-- rule (enforced app-side for NEW submissions only).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ps_order_sync_status') THEN
    ALTER TABLE public.prescription_submissions
      ADD CONSTRAINT chk_ps_order_sync_status CHECK (order_sync_status IN ('pending', 'synced', 'error'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ps_care_status') THEN
    ALTER TABLE public.prescription_submissions
      ADD CONSTRAINT chk_ps_care_status CHECK (care_status IN ('none', 'done', 'ignored'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ps_chronic_days') THEN
    ALTER TABLE public.prescription_submissions
      ADD CONSTRAINT chk_ps_chronic_days CHECK (NOT is_chronic OR days_supply > 0);
  END IF;
END $$;

-- Care-list scan (tab "Cần chăm sóc") + cron scan (rows still needing order data)
CREATE INDEX IF NOT EXISTS idx_ps_chronic_reminder
  ON public.prescription_submissions (reminder_date)
  WHERE is_chronic;
CREATE INDEX IF NOT EXISTS idx_ps_order_sync_pending
  ON public.prescription_submissions (order_sync_status)
  WHERE order_sync_status <> 'synced';

-- ── 2. prescription_care_logs — one row per care visit ──────────────────────
CREATE TABLE IF NOT EXISTS public.prescription_care_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id   uuid NOT NULL REFERENCES public.prescription_submissions(id) ON DELETE CASCADE,
  care_by         uuid NOT NULL REFERENCES public.users(id),
  care_note       text NOT NULL,
  evidence_images jsonb NOT NULL,       -- [{path,name,type,size}] (GCS URL or bucket key)
  cared_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pcl_submission ON public.prescription_care_logs (submission_id);
-- Phase 1 = care ONCE per prescription. Hard DB guard against a concurrent
-- double-submit racing past the app-level care_status check.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pcl_one_per_submission ON public.prescription_care_logs (submission_id);

ALTER TABLE public.prescription_care_logs ENABLE ROW LEVEL SECURITY;

-- Visibility piggybacks on the submission: if you can see the submission
-- (ps_select_admin / ps_select_manager / ps_select_staff), you can see its care
-- logs. One-way EXISTS — no cross-table recursion (submissions policies never
-- reference care logs). Writes are service-role only (server action authz).
DROP POLICY IF EXISTS pcl_select_visible ON public.prescription_care_logs;
CREATE POLICY pcl_select_visible ON public.prescription_care_logs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.prescription_submissions ps
      WHERE ps.id = prescription_care_logs.submission_id
    )
  );

-- ── 3. prescription_order_sync_runs — cron audit trail ──────────────────────
CREATE TABLE IF NOT EXISTS public.prescription_order_sync_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  pulled_count    int NOT NULL DEFAULT 0,
  matched_count   int NOT NULL DEFAULT 0,
  unmatched_count int NOT NULL DEFAULT 0,
  error_count     int NOT NULL DEFAULT 0,
  row_errors      jsonb,
  unmatched_codes jsonb,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

ALTER TABLE public.prescription_order_sync_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS posr_select_super ON public.prescription_order_sync_runs;
CREATE POLICY posr_select_super ON public.prescription_order_sync_runs
  FOR SELECT USING ((SELECT public.is_super_admin()));
-- No write policies: the cron writes via service role.

-- ── 4. Record migration ──────────────────────────────────────────────────────
INSERT INTO public.app_migrations (version, name, notes)
VALUES ('073', 'prescription_chronic_care',
        'chronic Rx care phase 1: submissions +15 cols (is_chronic/days_supply/order_* sheet sync/care_*), prescription_care_logs (visibility piggybacks submission RLS), prescription_order_sync_runs (super-only read). Additive; order sync fully separate from the legacy product sync.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ── Verify (run separately; SQL editor prints last statement only) ──────────
-- 1) Expect 15 rows:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'prescription_submissions'
--    AND column_name IN ('is_chronic','days_supply','order_created_at','expected_refill_date',
--                        'reminder_date','customer_name','customer_phone','pos_code','pos_name',
--                        'order_products_raw','order_sync_status','order_sync_error',
--                        'care_status','last_care_at','last_care_by');
-- 2) Expect 1 policy each:
-- SELECT policyname FROM pg_policies WHERE tablename = 'prescription_care_logs';
-- SELECT policyname FROM pg_policies WHERE tablename = 'prescription_order_sync_runs';
-- 3) SELECT version FROM public.app_migrations WHERE version = '073';
