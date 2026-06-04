-- ============================================================
-- 027 — Structured Workflow Event Tables
-- ============================================================
-- Adds two tables alongside the existing task_logs audit trail so that
-- workflow state-transitions and resubmit lifecycles are queryable without
-- parsing free-form metadata JSON.
--
-- task_logs remains the canonical append-only audit log; these tables are
-- additive. No backfill — rows accumulate from migration-apply date forward.
-- ============================================================

-- ── 1. task_status_events ────────────────────────────────────────────────────
-- One row per status transition: admin direct-update, staff/manager via RPC,
-- cron overdue sweep, submitTask (→ done), requestResubmit (→ todo),
-- extendDeadline (overdue → todo).

CREATE TABLE IF NOT EXISTS public.task_status_events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid        NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  from_status text,       -- NULL acceptable (e.g. first creation transition)
  to_status   text        NOT NULL,
  note        text,       -- e.g. reason text for in_progress transition
  actor_id    uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  source      text        NOT NULL DEFAULT 'admin'
              CHECK (source IN ('admin', 'staff', 'store_manager', 'cron', 'system')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tse_task_created
  ON public.task_status_events (task_id, created_at DESC);

ALTER TABLE public.task_status_events ENABLE ROW LEVEL SECURITY;

-- Super admin: see all
CREATE POLICY "tse_select_super" ON public.task_status_events FOR SELECT TO authenticated
  USING (public.is_super_admin());

-- Sub-admin: see events on tasks they created
CREATE POLICY "tse_select_admin" ON public.task_status_events FOR SELECT TO authenticated
  USING (
    get_user_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      WHERE t.id = public.task_status_events.task_id AND t.created_by = auth.uid()
    )
  );

-- Store manager: see events on tasks assigned to their store
CREATE POLICY "tse_select_manager" ON public.task_status_events FOR SELECT TO authenticated
  USING (
    get_user_role() = 'store_manager'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      WHERE t.id = public.task_status_events.task_id AND t.store_id = get_user_store_id()
    )
  );

-- INSERT: service-role only (supabaseAdmin). Client path goes through RPC or
-- server actions — no direct insert policy needed for authenticated users.
-- (No INSERT policy = only service role / SECURITY DEFINER functions can insert.)


-- ── 2. task_resubmit_requests ────────────────────────────────────────────────
-- Full resubmit lifecycle: one row per requestResubmit() call.
-- Replaces the split between resubmit_requested_at (last-only timestamp on tasks)
-- and task_review_notes(kind='resubmit_request') for reporting purposes.
-- Both still written for backward compat (resubmit_requested_at for gating logic,
-- task_review_notes for the existing UI display).

CREATE TABLE IF NOT EXISTS public.task_resubmit_requests (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id             uuid        NOT NULL REFERENCES public.tasks(id)        ON DELETE CASCADE,
  requested_by        uuid        NOT NULL REFERENCES public.users(id)        ON DELETE CASCADE,
  reason              text,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  fulfilled_result_id uuid        REFERENCES public.task_results(id)         ON DELETE SET NULL,
  fulfilled_at        timestamptz,
  status              text        NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'fulfilled', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_trr_task_requested
  ON public.task_resubmit_requests (task_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_trr_open
  ON public.task_resubmit_requests (status)
  WHERE status = 'open';

-- DB-level guarantee: at most one 'open' request per task. Prevents race
-- conditions where two concurrent requestResubmit() calls could both succeed
-- before the app-layer cancel runs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trr_one_open_per_task
  ON public.task_resubmit_requests (task_id)
  WHERE status = 'open';

ALTER TABLE public.task_resubmit_requests ENABLE ROW LEVEL SECURITY;

-- Super admin: see all
CREATE POLICY "trr_select_super" ON public.task_resubmit_requests FOR SELECT TO authenticated
  USING (public.is_super_admin());

-- Sub-admin: see requests on tasks they created
CREATE POLICY "trr_select_admin" ON public.task_resubmit_requests FOR SELECT TO authenticated
  USING (
    get_user_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      WHERE t.id = public.task_resubmit_requests.task_id AND t.created_by = auth.uid()
    )
  );

-- Store/staff: no select access (resubmit requests are admin-internal workflow)


-- ── 3. Recreate rpc_staff_update_task_status with task_status_events insert ──
-- Identical to migration 025 body, with one additional INSERT at the end that
-- records the transition in task_status_events.

CREATE OR REPLACE FUNCTION rpc_staff_update_task_status(
  p_task_id uuid,
  p_status  text,
  p_note    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role         text;
  v_store_id     uuid;
  v_task         record;
  v_has_result   boolean;
  v_is_submitter boolean;
BEGIN
  SELECT role, store_id INTO v_role, v_store_id
  FROM public.users WHERE id = auth.uid();

  IF v_role NOT IN ('staff', 'store_manager') THEN
    RETURN jsonb_build_object('error', 'API này chỉ dành cho người thực hiện task');
  END IF;

  SELECT * INTO v_task FROM public.tasks WHERE id = p_task_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Task không tồn tại');
  END IF;

  -- Submitter check (unchanged from 025)
  IF v_role = 'staff' THEN
    v_is_submitter := (v_task.assigned_to IS NOT DISTINCT FROM auth.uid());
  ELSE
    v_is_submitter := (v_task.assigned_to IS NOT DISTINCT FROM auth.uid())
      OR (v_task.assigned_to IS NULL
          AND v_task.store_id IS NOT NULL
          AND v_task.store_id = v_store_id);
  END IF;

  IF NOT v_is_submitter THEN
    RETURN jsonb_build_object('error', 'Bạn không phải người thực hiện task này');
  END IF;

  -- Overdue guard removed in migration 025 — overdue tasks remain actionable.

  IF p_status NOT IN ('todo', 'in_progress') THEN
    RETURN jsonb_build_object('error', 'Không có quyền đổi sang trạng thái này');
  END IF;

  IF p_status = 'in_progress' AND (p_note IS NULL OR trim(p_note) = '') THEN
    RETURN jsonb_build_object('error', 'Bắt buộc phải ghi chú khi chuyển sang Đang thực hiện');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.task_results tr
    WHERE tr.task_id = p_task_id
      AND (v_task.assigned_to IS NULL OR tr.user_id = auth.uid())
      AND (v_task.resubmit_requested_at IS NULL OR tr.submitted_at > v_task.resubmit_requested_at)
  ) INTO v_has_result;

  IF v_has_result THEN
    RETURN jsonb_build_object('error', 'Đã nộp kết quả rồi, không thể thay đổi trạng thái');
  END IF;

  UPDATE public.tasks SET status = p_status WHERE id = p_task_id;

  -- Audit log (unchanged)
  INSERT INTO public.task_logs (task_id, action, user_id, metadata)
  VALUES (
    p_task_id,
    'status_changed',
    auth.uid(),
    jsonb_build_object('from', v_task.status, 'to', p_status)
    || CASE WHEN p_note IS NOT NULL AND trim(p_note) <> ''
            THEN jsonb_build_object('note', p_note)
            ELSE '{}'::jsonb END
  );

  -- Structured status event (new in 027)
  INSERT INTO public.task_status_events (task_id, from_status, to_status, note, actor_id, source)
  VALUES (
    p_task_id,
    v_task.status,
    p_status,
    NULLIF(trim(coalesce(p_note, '')), ''),
    auth.uid(),
    CASE WHEN v_role = 'staff' THEN 'staff' ELSE 'store_manager' END
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_staff_update_task_status(uuid, text, text) TO authenticated;
