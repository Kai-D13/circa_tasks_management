-- ============================================================
-- Migration 041: Lock down direct inserts into task_results
-- ============================================================
-- After migration 040 moved the full submit flow into rpc_submit_task_result
-- (SECURITY DEFINER, FOR UPDATE row lock), any authenticated user can still
-- bypass the RPC by calling the Supabase REST API or JS client directly and
-- inserting into task_results, which skips:
--   - required-output validation
--   - atomic duplicate check
--   - task status update
--   - task_status_events / task_logs writes
--   - resubmit request fulfillment
--
-- Fix: replace tr_insert with WITH CHECK (false) so direct inserts from
-- authenticated sessions are denied at the RLS layer.
--
-- The SECURITY DEFINER RPC runs as the function owner (postgres/service role)
-- and bypasses RLS entirely, so rpc_submit_task_result continues to work.
--
-- Rollback: DROP POLICY IF EXISTS tr_insert ON public.task_results; then
-- restore the widened INSERT policy from migration 039 and revert submitTask
-- to the inline insert/update flow.
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS tr_insert ON public.task_results;
CREATE POLICY tr_insert ON public.task_results
  FOR INSERT TO authenticated
  WITH CHECK (false);

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('041', 'task_results_insert_lockdown', 'Block direct INSERT into task_results from authenticated; all submits must use rpc_submit_task_result')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- -- Verification -------------------------------------------------------------
-- 1) Policy exists with deny predicate:
-- SELECT policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE tablename = 'task_results' AND policyname = 'tr_insert';
-- expect: with_check = 'false'
--
-- 2) Direct insert blocked (run as authenticated user, not service role):
-- INSERT INTO public.task_results (task_id, user_id, output_data)
-- VALUES ('<any-uuid>', auth.uid(), '{}');
-- expect: ERROR: new row violates row-level security policy for table "task_results"
--
-- 3) RPC still works (run as authenticated user):
-- SELECT public.rpc_submit_task_result('<store-level-task-uuid>', '{"note": "test"}');
-- expect: { "success": true, ... }  or duplicate-error (not RLS error)
