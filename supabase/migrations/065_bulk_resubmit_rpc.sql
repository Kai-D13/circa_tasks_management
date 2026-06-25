-- ============================================================
-- Migration 065: atomic bulk "request resubmit"
-- ============================================================
-- The bulk resubmit action (app/actions/tasks.ts bulkRequestResubmit) reopens
-- many tasks at once. Doing the task update + audit writes one-by-one in the app
-- risks a partial state (task reopened but resubmit_request / status_event / log
-- missing). This RPC does them all in ONE transaction. The app validates
-- eligibility (has result, not a staff_all parent, permission) BEFORE calling and
-- passes only the valid ids; notifications stay app-side (best-effort). Service
-- role only. Idempotent (CREATE OR REPLACE).
-- ============================================================

CREATE OR REPLACE FUNCTION public.rpc_bulk_request_resubmit(
  p_task_ids uuid[],
  p_reason   text,
  p_actor    uuid,
  p_source   text
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer;
  v_reason text := NULLIF(trim(coalesce(p_reason, '')), '');
BEGIN
  -- Status events first — capture each task's CURRENT status before the update.
  INSERT INTO public.task_status_events (task_id, from_status, to_status, note, actor_id, source)
  SELECT id, status, 'todo', v_reason, p_actor, p_source
  FROM public.tasks WHERE id = ANY(p_task_ids);

  UPDATE public.tasks
    SET status = 'todo', resubmit_requested_at = now(), completed_by = NULL, completed_at = NULL
    WHERE id = ANY(p_task_ids);
  GET DIAGNOSTICS n = ROW_COUNT;

  -- One open request per task: cancel prior open, insert fresh.
  UPDATE public.task_resubmit_requests SET status = 'cancelled'
    WHERE task_id = ANY(p_task_ids) AND status = 'open';
  INSERT INTO public.task_resubmit_requests (task_id, requested_by, reason)
    SELECT unnest(p_task_ids), p_actor, v_reason;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.task_review_notes (task_id, author_id, kind, note)
      SELECT unnest(p_task_ids), p_actor, 'resubmit_request', v_reason;
  END IF;

  INSERT INTO public.task_logs (task_id, action, user_id, metadata)
    SELECT unnest(p_task_ids), 'resubmit_requested', p_actor, jsonb_build_object('bulk', true);

  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.rpc_bulk_request_resubmit(uuid[], text, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_bulk_request_resubmit(uuid[], text, uuid, text) TO service_role;

INSERT INTO public.app_migrations (version, name)
VALUES ('065', 'bulk_resubmit_rpc')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- SELECT version FROM public.app_migrations WHERE version='065';
-- SELECT proname, prosecdef FROM pg_proc WHERE proname='rpc_bulk_request_resubmit';
