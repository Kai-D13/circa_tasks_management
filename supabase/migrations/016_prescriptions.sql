-- ============================================================
-- Migration 016: Prescription Submissions (Toa Thuốc)
-- ============================================================
-- STORAGE (MVP): reuses the existing PUBLIC 'task-uploads' bucket with
-- path prefix prescriptions/{store_id}/{submission_id}/{filename}.
-- prescription_images.storage_path stores the path (not a URL), so the
-- future swap to a private bucket is a single code change.
--
-- TODO (later sprint — compliance hardening):
--   * Create private bucket 'prescription-uploads' (public = false).
--   * storage.objects RLS: staff insert/select own; manager select store;
--     admin select all — scoped by the {store_id} path segment.
--   * Replace getPublicUrl() with createSignedUrl() in the detail page.
-- ============================================================
-- Idempotent: all CREATE TABLE use IF NOT EXISTS;
-- all CREATE POLICY are preceded by DROP POLICY IF EXISTS.
-- ============================================================
-- Tables created in dependency order:
-- 1. prescription_sync_batches   (standalone)
-- 2. prescription_submissions    (refs sync_batches)
-- 3. prescription_images         (refs submissions)
-- 4. prescription_submission_products (refs submissions)
-- ============================================================

-- 1. ── Sync batches ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prescription_sync_batches (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by     uuid        NOT NULL REFERENCES public.users(id),
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  source          text        NOT NULL DEFAULT 'manual_json',
  total_rows      int         NOT NULL DEFAULT 0,
  matched_count   int         NOT NULL DEFAULT 0,
  unmatched_count int         NOT NULL DEFAULT 0,
  error_count     int         NOT NULL DEFAULT 0
);

ALTER TABLE public.prescription_sync_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "psb_admin" ON public.prescription_sync_batches;
CREATE POLICY "psb_admin" ON public.prescription_sync_batches
  FOR ALL TO authenticated
  USING    (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

-- 2. ── Prescription submissions ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.prescription_submissions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_code    text        NOT NULL,
  store_id      uuid        NOT NULL REFERENCES public.stores(id),
  submitted_by  uuid        NOT NULL REFERENCES public.users(id),
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  status        text        NOT NULL DEFAULT 'pending_sync'
                  CHECK (status IN ('pending_sync', 'synced', 'sync_failed')),
  notes         text        DEFAULT NULL,
  synced_at     timestamptz DEFAULT NULL,
  synced_by     uuid        REFERENCES public.users(id),
  sync_batch_id uuid        REFERENCES public.prescription_sync_batches(id),
  UNIQUE (order_code)   -- DHC is globally unique company-wide
);

ALTER TABLE public.prescription_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ps_select_admin"   ON public.prescription_submissions;
DROP POLICY IF EXISTS "ps_update_admin"   ON public.prescription_submissions;
DROP POLICY IF EXISTS "ps_select_manager" ON public.prescription_submissions;
DROP POLICY IF EXISTS "ps_insert_staff"   ON public.prescription_submissions;
DROP POLICY IF EXISTS "ps_select_staff"   ON public.prescription_submissions;

CREATE POLICY "ps_select_admin" ON public.prescription_submissions
  FOR SELECT TO authenticated USING (get_user_role() = 'admin');

CREATE POLICY "ps_update_admin" ON public.prescription_submissions
  FOR UPDATE TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

CREATE POLICY "ps_select_manager" ON public.prescription_submissions
  FOR SELECT TO authenticated
  USING (get_user_role() = 'store_manager' AND store_id = get_user_store_id());

CREATE POLICY "ps_insert_staff" ON public.prescription_submissions
  FOR INSERT TO authenticated
  WITH CHECK (
    get_user_role() = 'staff'
    AND submitted_by = auth.uid()
    AND store_id = get_user_store_id()
  );

CREATE POLICY "ps_select_staff" ON public.prescription_submissions
  FOR SELECT TO authenticated
  USING (get_user_role() = 'staff' AND submitted_by = auth.uid());

-- 3. ── Prescription images ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prescription_images (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid        NOT NULL REFERENCES public.prescription_submissions(id) ON DELETE CASCADE,
  storage_path  text        NOT NULL,
  name          text        NOT NULL,
  type          text        NOT NULL,
  size          int         NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.prescription_images ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pi_select_admin"  ON public.prescription_images;
DROP POLICY IF EXISTS "pi_insert_staff"  ON public.prescription_images;
DROP POLICY IF EXISTS "pi_select_manager" ON public.prescription_images;
DROP POLICY IF EXISTS "pi_select_staff"  ON public.prescription_images;

CREATE POLICY "pi_select_admin" ON public.prescription_images
  FOR SELECT TO authenticated USING (get_user_role() = 'admin');

CREATE POLICY "pi_insert_staff" ON public.prescription_images
  FOR INSERT TO authenticated
  WITH CHECK (
    get_user_role() = 'staff'
    AND EXISTS (
      SELECT 1 FROM public.prescription_submissions s
      WHERE s.id = submission_id AND s.submitted_by = auth.uid()
    )
  );

CREATE POLICY "pi_select_manager" ON public.prescription_images
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'store_manager'
    AND EXISTS (
      SELECT 1 FROM public.prescription_submissions s
      WHERE s.id = submission_id AND s.store_id = get_user_store_id()
    )
  );

CREATE POLICY "pi_select_staff" ON public.prescription_images
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'staff'
    AND EXISTS (
      SELECT 1 FROM public.prescription_submissions s
      WHERE s.id = submission_id AND s.submitted_by = auth.uid()
    )
  );

-- 4. ── Submission products ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prescription_submission_products (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id   uuid        NOT NULL REFERENCES public.prescription_submissions(id) ON DELETE CASCADE,
  order_code      text        NOT NULL,
  product_id      text        NOT NULL,
  product_name    text,
  sku_code        text        NOT NULL,
  lot_date        text        NOT NULL,
  pos_code        text,
  pos_name        text,
  created_at_vn   text,
  completed_at_vn text,
  employee_name   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, product_id, sku_code, lot_date)
);

ALTER TABLE public.prescription_submission_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "psp_select_admin"   ON public.prescription_submission_products;
DROP POLICY IF EXISTS "psp_insert_admin"   ON public.prescription_submission_products;
DROP POLICY IF EXISTS "psp_select_manager" ON public.prescription_submission_products;
DROP POLICY IF EXISTS "psp_select_staff"   ON public.prescription_submission_products;

CREATE POLICY "psp_select_admin" ON public.prescription_submission_products
  FOR SELECT TO authenticated USING (get_user_role() = 'admin');

CREATE POLICY "psp_insert_admin" ON public.prescription_submission_products
  FOR INSERT TO authenticated WITH CHECK (get_user_role() = 'admin');

CREATE POLICY "psp_select_manager" ON public.prescription_submission_products
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'store_manager'
    AND EXISTS (
      SELECT 1 FROM public.prescription_submissions s
      WHERE s.id = submission_id AND s.store_id = get_user_store_id()
    )
  );

CREATE POLICY "psp_select_staff" ON public.prescription_submission_products
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'staff'
    AND EXISTS (
      SELECT 1 FROM public.prescription_submissions s
      WHERE s.id = submission_id AND s.submitted_by = auth.uid()
    )
  );
