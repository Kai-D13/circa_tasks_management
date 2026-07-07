-- ============================================================================
-- 076_fs_product_module.sql
-- Module "Quản lý FS" · "Quản lý sản phẩm" — phase 1 (handoff:
-- docs/plan-fs-product-module.md + Amendment v2, stakeholder-approved).
--
-- Adds: stores.store_type ('os'|'fs') + 5 new tables (sessions, items, photos,
-- import runs, item events/audit). FS staff photograph products (white
-- background, 2-5 named shots) + measure dimensions (mm) per Policy-created
-- session; Policy/super review and request per-box or per-item redo.
--
-- ACCESS: super admin OR admin of dept Policy (fd691349-...) manage everything;
-- staff/store_manager of the session's FS store read their own store's sessions.
-- All WRITES go through service-role server actions (no write policies) — the
-- proven posture of the prescriptions/KPI modules.
--
-- "Last version only": UNIQUE(item_id, box_key) — a re-upload upserts the row;
-- the old GCS object is deleted AFTER the DB commit (failure → logged in
-- fs_item_events for cleanup retry). No photo history by design; the ACTION
-- history lives in fs_item_events.
--
-- Additive + idempotent + pg_safeupdate-safe. Records app_migrations '076'.
-- IMPORTANT deploy order: run this BEFORE inserting any FS store (the OS
-- surfaces filter store_type='os' from the same app build).
-- ============================================================================

BEGIN;

-- ── 1. stores.store_type ─────────────────────────────────────────────────────
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS store_type text NOT NULL DEFAULT 'os';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_stores_store_type') THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT chk_stores_store_type CHECK (store_type IN ('os', 'fs'));
  END IF;
END $$;

-- ── 2. Tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fs_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  store_id    uuid NOT NULL REFERENCES public.stores(id),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_by  uuid NOT NULL REFERENCES public.users(id),
  claimed_by  uuid REFERENCES public.users(id),   -- 1 staff owns the session at a time
  claimed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_fss_store ON public.fs_sessions (store_id, status);

CREATE TABLE IF NOT EXISTS public.fs_session_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL REFERENCES public.fs_sessions(id) ON DELETE CASCADE,
  product_id     text NOT NULL,          -- Excel gives numbers; app coerces to text
  product_name   text NOT NULL,
  dim_length_mm  int CHECK (dim_length_mm IS NULL OR (dim_length_mm > 0 AND dim_length_mm <= 3000)),
  dim_width_mm   int CHECK (dim_width_mm  IS NULL OR (dim_width_mm  > 0 AND dim_width_mm  <= 3000)),
  dim_height_mm  int CHECK (dim_height_mm IS NULL OR (dim_height_mm > 0 AND dim_height_mm <= 3000)),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'redo')),
  processed_by   uuid REFERENCES public.users(id),
  processed_at   timestamptz,
  resubmit_note  text,                   -- admin note when the WHOLE item is sent back
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, product_id)        -- duplicate product in one session → blocked
);
CREATE INDEX IF NOT EXISTS idx_fsi_session_status ON public.fs_session_items (session_id, status);

CREATE TABLE IF NOT EXISTS public.fs_item_photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid NOT NULL REFERENCES public.fs_session_items(id) ON DELETE CASCADE,
  box_key       int  NOT NULL CHECK (box_key BETWEEN 1 AND 5),
  storage_path  text NOT NULL,           -- GCS public URL (GCS-only, no Supabase fallback)
  status        text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'redo')),
  resubmit_note text,                    -- admin note for THIS box
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, box_key)              -- one photo per box — re-upload OVERWRITES
);

CREATE TABLE IF NOT EXISTS public.fs_import_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid REFERENCES public.fs_sessions(id) ON DELETE SET NULL,
  store_id      uuid REFERENCES public.stores(id),
  file_name     text,
  sheet_name    text,
  row_count     int NOT NULL DEFAULT 0,
  success_count int NOT NULL DEFAULT 0,
  error_count   int NOT NULL DEFAULT 0,
  errors        jsonb,
  uploaded_by   uuid REFERENCES public.users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Business/action audit (photos keep only the LAST version; the history of who
-- did what lives here): resubmits, re-uploads, claims, closes, cleanup failures.
CREATE TABLE IF NOT EXISTS public.fs_item_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES public.fs_sessions(id) ON DELETE CASCADE,
  item_id     uuid REFERENCES public.fs_session_items(id) ON DELETE CASCADE,
  box_key     int CHECK (box_key IS NULL OR box_key BETWEEN 1 AND 5),
  event_type  text NOT NULL CHECK (event_type IN (
    'session_created','session_claimed','session_released','session_completed','session_cancelled',
    'item_submitted','item_resubmit_requested','box_resubmit_requested','box_reuploaded',
    'gcs_delete_failed'
  )),
  note        text,
  actor       uuid REFERENCES public.users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fse_session ON public.fs_item_events (session_id, created_at DESC);

-- ── 3. RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE public.fs_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fs_session_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fs_item_photos   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fs_import_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fs_item_events   ENABLE ROW LEVEL SECURITY;

-- Reader = super admin OR Policy-dept admin OR staff/store_manager of the store.
-- SECURITY DEFINER (existing helpers only) → no cross-table recursion.
CREATE OR REPLACE FUNCTION public.can_read_fs_session(p_session_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (SELECT public.is_super_admin())
    OR ( (SELECT public.get_user_role()) = 'admin'
         AND (SELECT public.get_user_department_id()) = 'fd691349-a087-4998-9536-bc20b14b99b2'::uuid )
    OR EXISTS (
      SELECT 1 FROM public.fs_sessions s
      WHERE s.id = p_session_id
        AND (SELECT public.get_user_role()) IN ('staff', 'store_manager')
        AND s.store_id = (SELECT public.get_user_store_id())
    )
$$;
GRANT EXECUTE ON FUNCTION public.can_read_fs_session(uuid) TO authenticated;

DROP POLICY IF EXISTS fss_select ON public.fs_sessions;
CREATE POLICY fss_select ON public.fs_sessions
  FOR SELECT TO authenticated USING (public.can_read_fs_session(id));

DROP POLICY IF EXISTS fsi_select ON public.fs_session_items;
CREATE POLICY fsi_select ON public.fs_session_items
  FOR SELECT TO authenticated USING (public.can_read_fs_session(session_id));

DROP POLICY IF EXISTS fsp_select ON public.fs_item_photos;
CREATE POLICY fsp_select ON public.fs_item_photos
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.fs_session_items i
            WHERE i.id = fs_item_photos.item_id AND public.can_read_fs_session(i.session_id))
  );

DROP POLICY IF EXISTS fsr_select ON public.fs_import_runs;
CREATE POLICY fsr_select ON public.fs_import_runs
  FOR SELECT TO authenticated USING (
    (SELECT public.is_super_admin())
    OR ( (SELECT public.get_user_role()) = 'admin'
         AND (SELECT public.get_user_department_id()) = 'fd691349-a087-4998-9536-bc20b14b99b2'::uuid )
  );

DROP POLICY IF EXISTS fse_select ON public.fs_item_events;
CREATE POLICY fse_select ON public.fs_item_events
  FOR SELECT TO authenticated USING (public.can_read_fs_session(session_id));

-- No INSERT/UPDATE/DELETE policies: all writes via service-role server actions.

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('076', 'fs_product_module',
        'FS product module phase 1: stores.store_type os|fs + fs_sessions/items/photos(UNIQUE item,box last-version-only)/import_runs/item_events(audit). RLS read: super | Policy-dept admin | store staff/mgr via can_read_fs_session (SECDEF). Writes service-role only. Run BEFORE inserting FS stores.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify (run separately):
-- SELECT column_name FROM information_schema.columns WHERE table_name='stores' AND column_name='store_type';
-- SELECT tablename, policyname FROM pg_policies WHERE tablename LIKE 'fs\_%' ORDER BY 1;  -- 5 select policies
-- SELECT proname, prosecdef FROM pg_proc WHERE proname='can_read_fs_session';
-- SELECT version FROM public.app_migrations WHERE version='076';
