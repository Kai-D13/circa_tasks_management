-- ============================================================
-- 036 — Staff hot-path indexes (additive only, no drops)
-- ============================================================
-- Supports the staff mobile hot paths /prescriptions and /tasks after the
-- query trims in this batch (smaller page size, no count:exact, explicit
-- submitted_by filter mirroring RLS ps_select_staff).
--
-- All CREATE INDEX IF NOT EXISTS — additive, idempotent, no duplicates of an
-- existing index, and no DROPs. Safe to apply without a maintenance window.
-- (Add CONCURRENTLY manually if applying on a hot table outside a transaction.)

-- Staff own-list: WHERE submitted_by = uid() ORDER BY submitted_at DESC.
-- No prior index on submitted_by existed.
CREATE INDEX IF NOT EXISTS idx_ps_submitted_by_at
  ON public.prescription_submissions (submitted_by, submitted_at DESC);

-- Store-manager / admin store-filtered list: WHERE store_id = ? ORDER BY submitted_at DESC.
CREATE INDEX IF NOT EXISTS idx_ps_store_at
  ON public.prescription_submissions (store_id, submitted_at DESC);

-- Per-row prescription_images embed (admin/manager list) + the detail page image
-- lookup. The FK references submissions(id) but no index on submission_id existed,
-- so each embed/lookup was a sequential scan.
CREATE INDEX IF NOT EXISTS idx_pi_submission
  ON public.prescription_images (submission_id);

-- ------------------------------------------------------------
-- OPTIONAL — staff /tasks keeps the full RLS visibility (public OR store OR
-- assigned), so the assigned_to branch is only one arm of an OR. The planner may
-- already use idx_tasks_active_created and filter. Enable this only if
-- EXPLAIN ANALYZE on the staff /tasks query shows it scanning many active rows to
-- fill a page of few assigned tasks. Distinct from idx_tasks_assigned_status,
-- which orders by status (not created_at) and cannot serve this ORDER BY.
-- ------------------------------------------------------------
-- CREATE INDEX IF NOT EXISTS idx_tasks_assigned_active_created
--   ON public.tasks (assigned_to, created_at DESC)
--   WHERE archived_at IS NULL AND assigned_to IS NOT NULL;

-- Verify:
--   select indexname from pg_indexes
--   where schemaname='public'
--     and indexname in ('idx_ps_submitted_by_at','idx_ps_store_at','idx_pi_submission');
