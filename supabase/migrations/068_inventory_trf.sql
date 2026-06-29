-- ============================================================
-- Migration 068: Inventory → TRF (Cycle Count) module
-- ============================================================
-- A daily cron (/api/cron/pull-inventory-trf) reads a Google Sheet and creates
-- ONE store-level task per TRF code per store (output text+image). Any staff /
-- store_manager of the store can submit (existing rpc_submit_task_result — NO new
-- submit RLS). Cycle Count dept admins + super see across all stores; staff/SM
-- see only their store. /tasks, /dashboard, /api/export/tasks exclude these
-- (source_type='inventory_trf').
--
-- This migration EDITS TWO CORE PRODUCTION POLICIES (tasks_select_admin from 060,
-- tr_select_admin from 038): it DROP+CREATEs them preserving EVERY existing branch
-- verbatim and APPENDS one TRF branch each (source_type='inventory_trf' + admin +
-- dept=Cycle Count). A dropped branch = regression/leak — the bodies below are
-- copied verbatim from 060/038.
--
-- Cycle Count department id: cac38f89-a5d4-4402-99ec-24915a446545.
-- Idempotent. pg_safeupdate-safe (no bare DELETE/UPDATE). Records 068.
-- ROLLBACK: re-create tasks_select_admin from 060 + tr_select_admin from 038
--   (drop the appended TRF branch); DROP rpc_create_inventory_trf_items;
--   DROP inventory_trf_items, inventory_trf_import_runs; ALTER tasks DROP source_type
--   + drop idx_tasks_source_type.
-- ============================================================

BEGIN;

-- 1) tasks.source_type --------------------------------------------------------
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'task'
  CHECK (source_type IN ('task', 'inventory_trf'));

-- Partial index on the rare value (inventory views filter = 'inventory_trf';
-- the /tasks list filters <> 'inventory_trf' which is the common default path).
CREATE INDEX IF NOT EXISTS idx_tasks_source_type
  ON public.tasks (source_type) WHERE source_type <> 'task';

-- 2) import-run log -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inventory_trf_import_runs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pulled        integer     NOT NULL DEFAULT 0,
  created       integer     NOT NULL DEFAULT 0,
  skipped       integer     NOT NULL DEFAULT 0,
  unmatched     integer     NOT NULL DEFAULT 0,
  duplicates    integer     NOT NULL DEFAULT 0,
  status        text        NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'success', 'failed')),
  error         jsonb,                     -- { message, unmatched:[...], stores_without_store_manager:[...] }
  -- Source metadata (trace which Sheet/config produced this batch).
  sheet_id      text,
  sheet_range   text,
  deadline_hours integer,
  created_by    uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
ALTER TABLE public.inventory_trf_import_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS itr_runs_select ON public.inventory_trf_import_runs;
CREATE POLICY itr_runs_select ON public.inventory_trf_import_runs
  FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select public.get_user_role()) = 'admin'
        AND (select public.get_user_department_id()) = 'cac38f89-a5d4-4402-99ec-24915a446545'::uuid)
  );
-- No write policies: service role only.

-- 3) TRF items (one per (store, trf), linked to its task) ----------------------
CREATE TABLE IF NOT EXISTS public.inventory_trf_items (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id             uuid        NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  store_id            uuid        NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  pos_code_check      text        NOT NULL,
  pos_name_check      text,
  trf_code            text        NOT NULL,
  reason              text,
  internal_created_by text,                 -- Sheet "created_by" free text, NOT a user FK
  source_run_id       uuid        REFERENCES public.inventory_trf_import_runs(id) ON DELETE SET NULL,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  is_active           boolean     NOT NULL DEFAULT true,
  UNIQUE (store_id, trf_code)               -- dedup key: one task per TRF per store
);
CREATE INDEX IF NOT EXISTS idx_itr_items_store_trf ON public.inventory_trf_items (store_id, trf_code);
CREATE INDEX IF NOT EXISTS idx_itr_items_task      ON public.inventory_trf_items (task_id);

ALTER TABLE public.inventory_trf_items ENABLE ROW LEVEL SECURITY;
-- SECDEF helpers only, NO cross-table references (047→049 lesson).
DROP POLICY IF EXISTS itr_items_select ON public.inventory_trf_items;
CREATE POLICY itr_items_select ON public.inventory_trf_items
  FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select public.get_user_role()) = 'admin'
        AND (select public.get_user_department_id()) = 'cac38f89-a5d4-4402-99ec-24915a446545'::uuid)
    OR (store_id = (select public.get_user_store_id()))
  );
-- No write policies: service role (cron / RPC) only.

-- 4) RPC: atomic task + item creation (no orphan tasks) ------------------------
-- Called by the cron AFTER app-side preflight (header/dup/unmatched/existing
-- already filtered). Inserts task + item per row in a per-row subtransaction:
-- a unique_violation (race on (store,trf)) rolls back THAT row only (no orphan
-- task) and continues. set_task_department() trigger stamps department_id from
-- p_created_by. Service role only.
CREATE OR REPLACE FUNCTION public.rpc_create_inventory_trf_items(
  p_items          jsonb,   -- [{store_id, pos_code_check, pos_name_check, trf_code, reason, internal_created_by}]
  p_created_by     uuid,
  p_deadline_hours integer,
  p_run_id         uuid
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item     jsonb;
  v_task_id  uuid;
  v_created  integer := 0;
  v_deadline timestamptz := now() + make_interval(hours => greatest(coalesce(p_deadline_hours, 48), 1));
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    BEGIN
      INSERT INTO public.tasks (
        title, description, category, priority, visibility, status,
        store_id, assigned_to, assignment_mode, created_by, deadline,
        required_outputs, input_data, source_type
      ) VALUES (
        'TRF ' || (v_item->>'trf_code'),
        NULLIF(v_item->>'reason', ''),
        'audit', 'normal', 'store', 'todo',
        (v_item->>'store_id')::uuid, NULL, 'store', p_created_by, v_deadline,
        '["text","image"]'::jsonb,
        jsonb_build_object(
          'trf_code',            v_item->>'trf_code',
          'reason',              v_item->>'reason',
          'internal_created_by', v_item->>'internal_created_by',
          'pos_code_check',      v_item->>'pos_code_check',
          'pos_name_check',      v_item->>'pos_name_check'
        ),
        'inventory_trf'
      )
      RETURNING id INTO v_task_id;

      INSERT INTO public.inventory_trf_items (
        task_id, store_id, pos_code_check, pos_name_check, trf_code, reason,
        internal_created_by, source_run_id, is_active
      ) VALUES (
        v_task_id,
        (v_item->>'store_id')::uuid,
        v_item->>'pos_code_check',
        v_item->>'pos_name_check',
        v_item->>'trf_code',
        NULLIF(v_item->>'reason', ''),
        NULLIF(v_item->>'internal_created_by', ''),
        p_run_id,
        true
      );

      v_created := v_created + 1;
    EXCEPTION WHEN unique_violation THEN
      -- (store, trf) already created concurrently → skip this row (task rolled
      -- back with the subtransaction, no orphan).
      CONTINUE;
    END;
  END LOOP;
  RETURN v_created;
END $$;
REVOKE ALL ON FUNCTION public.rpc_create_inventory_trf_items(jsonb, uuid, integer, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_create_inventory_trf_items(jsonb, uuid, integer, uuid) TO service_role;

-- 4b) task_review_notes: let same-store STAFF read the resubmit reason on TRF
--     tasks. The existing trn_select_staff requires t.assigned_to = auth.uid(),
--     but TRF tasks are store-level (assigned_to NULL), so staff couldn't see the
--     "lý do làm lại". ADDITIVE policy (RLS ORs permissive policies) → the
--     existing trn_select_staff is untouched. Scoped to source_type='inventory_trf'.
DROP POLICY IF EXISTS "trn_select_staff_trf" ON public.task_review_notes;
CREATE POLICY "trn_select_staff_trf" ON public.task_review_notes
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'staff'
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      WHERE t.id = task_review_notes.task_id
        AND t.source_type = 'inventory_trf'
        AND t.assigned_to IS NULL
        AND t.store_id = (select public.get_user_store_id())
    )
  );

-- 5) CORE EDIT #1: tasks_select_admin — VERBATIM 4 branches from migration 060,
--    APPEND a 5th for inventory_trf (Cycle Count dept; created_by may be null).
DROP POLICY IF EXISTS tasks_select_admin ON public.tasks;
CREATE POLICY tasks_select_admin ON public.tasks
  FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select public.get_user_role()) = 'admin' AND created_by = (select auth.uid()))
    OR ((select public.get_user_role()) = 'admin' AND EXISTS (
          SELECT 1 FROM public.task_collaborators tc
          WHERE tc.task_id = tasks.id AND tc.admin_id = (select auth.uid())))
    OR ((select public.get_user_role()) = 'admin'
        AND (select public.get_user_department_id()) IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = tasks.created_by
            AND u.department_id = (select public.get_user_department_id())))
    -- NEW (068): Cycle Count admins see every store's TRF task.
    OR (tasks.source_type = 'inventory_trf'
        AND (select public.get_user_role()) = 'admin'
        AND (select public.get_user_department_id()) = 'cac38f89-a5d4-4402-99ec-24915a446545'::uuid)
  );

-- 6) CORE EDIT #2: tr_select_admin — VERBATIM 3 branches from migration 038,
--    APPEND a 4th so Cycle Count admins read TRF submissions across all stores.
DROP POLICY IF EXISTS tr_select_admin ON public.task_results;
CREATE POLICY tr_select_admin ON public.task_results
  FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR ((select public.get_user_role()) = 'admin' AND EXISTS (
          SELECT 1 FROM public.tasks t
          WHERE t.id = task_results.task_id AND t.created_by = (select auth.uid())))
    OR ((select public.get_user_role()) = 'admin' AND EXISTS (
          SELECT 1 FROM public.task_collaborators tc
          WHERE tc.task_id = task_results.task_id AND tc.admin_id = (select auth.uid())))
    -- NEW (068): Cycle Count admins read results of inventory_trf tasks.
    OR ((select public.get_user_role()) = 'admin'
        AND (select public.get_user_department_id()) = 'cac38f89-a5d4-4402-99ec-24915a446545'::uuid
        AND EXISTS (
          SELECT 1 FROM public.tasks t
          WHERE t.id = task_results.task_id AND t.source_type = 'inventory_trf'))
  );

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('068', 'inventory_trf',
        'tasks.source_type + inventory_trf_items/import_runs + atomic RPC; TRF branch on tasks_select_admin (060) and tr_select_admin (038)')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Column + index:
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='tasks' AND column_name='source_type';
-- SELECT indexname FROM pg_indexes WHERE tablename='tasks' AND indexname='idx_tasks_source_type';
--
-- 2) Two tables + their policies + indexes:
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_name IN ('inventory_trf_items','inventory_trf_import_runs');
-- SELECT tablename, policyname FROM pg_policies
--   WHERE tablename IN ('inventory_trf_items','inventory_trf_import_runs');
--
-- 3) Core policies retain ALL branches + the new TRF branch:
-- SELECT qual FROM pg_policies WHERE tablename='tasks' AND policyname='tasks_select_admin';
--   (expect 5 branches incl. source_type = 'inventory_trf')
-- SELECT qual FROM pg_policies WHERE tablename='task_results' AND policyname='tr_select_admin';
--   (expect 4 branches incl. source_type = 'inventory_trf')
--
-- 4) RPC exists + SECURITY DEFINER:
-- SELECT proname, prosecdef FROM pg_proc WHERE proname='rpc_create_inventory_trf_items';
--
-- 5) Orphan check (run after the cron has created TRF tasks) — expect 0 rows:
-- SELECT t.id, t.title FROM public.tasks t
--   LEFT JOIN public.inventory_trf_items i ON i.task_id = t.id
--   WHERE t.source_type='inventory_trf' AND i.id IS NULL;
--
-- 6) Migration recorded:
-- SELECT version FROM public.app_migrations WHERE version='068';
