-- ============================================================
-- 034 — Excel split import (per-store file attachment)
-- ============================================================
-- Admin uploads one master Excel; the server splits rows by pos_code
-- (= stores.code) into one task per matched store, each carrying its own
-- slice as an attached xlsx in input_data.attachments.
--
-- This migration adds:
--   1. task_import_batches  — audit + grouping record for each import run
--   2. tasks.import_batch_id — links the N store tasks back to their batch
--   3. rpc_create_import_tasks(jsonb, jsonb) — ATOMIC insert of the batch +
--      all store tasks + creation logs (a plpgsql function is one transaction,
--      so a mid-run failure leaves no partial state — no orphan batch/tasks).
--
-- Scope is adhoc + store mode only (no recurring, no staff_all). The per-store
-- file slices live in storage (task-inputs/import/<batch_id>/<pos>.xlsx) and are
-- generated/uploaded by the server before this RPC is called.
--
-- Apply in Supabase SQL Editor after 031–033.
-- ------------------------------------------------------------

-- 1. Import batch record (lean: audit + master file + match summary).
CREATE TABLE IF NOT EXISTS public.task_import_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  file_name       text NOT NULL,
  sheet_name      text,
  pos_column      text,
  total_rows      int  NOT NULL DEFAULT 0,
  matched_count   int  NOT NULL DEFAULT 0,
  unmatched_pos   jsonb NOT NULL DEFAULT '[]'::jsonb,
  master_file_url text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.task_import_batches ENABLE ROW LEVEL SECURITY;

-- Own-scope read: the admin who ran the import, plus the super admin.
-- No INSERT/UPDATE/DELETE policy → writes happen only via the SECURITY DEFINER
-- RPC below (or the service role), never directly from a client.
DROP POLICY IF EXISTS tib_select ON public.task_import_batches;
CREATE POLICY tib_select ON public.task_import_batches FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR public.is_super_admin());

-- 2. Link tasks → batch. SET NULL on delete so removing a batch record never
--    cascades into deleting the actual store tasks.
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS import_batch_id uuid
  REFERENCES public.task_import_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_import_batch_id
  ON public.tasks (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

-- 3. Atomic create. Models rpc_staff_update_task_status (031): plpgsql +
--    SECURITY DEFINER (bypasses RLS for the writes) but auth.uid() still
--    resolves to the calling admin for the role check + created_by/logs.
CREATE OR REPLACE FUNCTION public.rpc_create_import_tasks(
  p_batch jsonb,
  p_tasks jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_role     text;
  v_batch_id uuid;
  v_count    int;
  v_task_ids uuid[];
BEGIN
  -- NULL-safe: a missing profile / NULL role must NOT pass. `<>` would yield NULL
  -- (not TRUE) and fall through — critical because this is SECURITY DEFINER.
  SELECT role INTO v_role FROM public.users WHERE id = v_uid;
  IF v_uid IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('error', 'Chỉ admin mới được import task');
  END IF;

  v_count := jsonb_array_length(p_tasks);
  IF v_count IS NULL OR v_count < 1 THEN
    RETURN jsonb_build_object('error', 'Không có task nào để tạo');
  END IF;
  IF v_count > 30 THEN
    RETURN jsonb_build_object('error', 'Vượt giới hạn 30 cửa hàng mỗi lần import');
  END IF;

  v_batch_id := (p_batch->>'id')::uuid;

  INSERT INTO public.task_import_batches (
    id, created_by, file_name, sheet_name, pos_column,
    total_rows, matched_count, unmatched_pos, master_file_url
  ) VALUES (
    v_batch_id,
    v_uid,
    p_batch->>'file_name',
    p_batch->>'sheet_name',
    p_batch->>'pos_column',
    COALESCE((p_batch->>'total_rows')::int, 0),
    COALESCE((p_batch->>'matched_count')::int, 0),
    COALESCE(p_batch->'unmatched_pos', '[]'::jsonb),
    p_batch->>'master_file_url'
  );

  WITH ins AS (
    INSERT INTO public.tasks (
      title, description, category, priority, status, visibility,
      store_id, assigned_to, assignment_mode, created_by,
      start_date, deadline, required_outputs, input_data, import_batch_id
    )
    SELECT
      t.title,
      t.description,
      COALESCE(t.category, 'other'),
      t.priority,
      'todo',
      'store',
      t.store_id,
      NULL,
      'store',
      v_uid,
      t.start_date,
      t.deadline,
      COALESCE(t.required_outputs, '[]'::jsonb),
      t.input_data,
      v_batch_id
    FROM jsonb_to_recordset(p_tasks) AS t(
      title            text,
      description      text,
      category         text,
      priority         text,
      store_id         uuid,
      start_date       timestamptz,
      deadline         timestamptz,
      required_outputs jsonb,
      input_data       jsonb
    )
    RETURNING id
  )
  SELECT array_agg(id) INTO v_task_ids FROM ins;

  INSERT INTO public.task_logs (task_id, action, user_id, metadata)
  SELECT unnest(v_task_ids), 'created', v_uid,
         jsonb_build_object('method', 'excel_import', 'batch_id', v_batch_id);

  RETURN jsonb_build_object(
    'success',  true,
    'batch_id', v_batch_id,
    'task_ids', to_jsonb(v_task_ids),
    'count',    v_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_create_import_tasks(jsonb, jsonb) TO authenticated;

-- ── Verification queries ──────────────────────────────────────────────────────
-- SELECT to_regclass('public.task_import_batches');
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'tasks' AND column_name = 'import_batch_id';
-- SELECT indexname FROM pg_indexes WHERE tablename = 'tasks'
--   AND indexname = 'idx_tasks_import_batch_id';
-- SELECT proname FROM pg_proc WHERE proname = 'rpc_create_import_tasks';
