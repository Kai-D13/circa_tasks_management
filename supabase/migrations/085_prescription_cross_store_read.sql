-- ============================================================================
-- 085_prescription_cross_store_read.sql  (r3 — review round 2026-07-10)
-- RX-V2.5 — Staff cross-store READ for the Toa thuốc module.
--
-- Stakeholder: an OS pharmacist sometimes needs to look up another store's
-- prescription (customer walks in with a toa submitted elsewhere).
-- Read rule (RLS is its OWN boundary — never relies on UI redirects):
--   OS staff        → SELECT every prescription OF AN OS STORE (was: own only)
--   FS staff        → NOTHING, even via direct PostgREST (review P1: a bare
--                     role='staff' check would have included them — FS staff
--                     also carry role='staff'; gate on the caller's store_type)
--   store_manager   → unchanged (own store only)
--   admin           → unchanged (all)
--   sm              → unchanged (no policy — no rows)
-- WRITE surface is NOT widened: insert stays owner+store-checked
-- (ps_insert_staff unchanged), care/DHC-fix/days-supply edits stay
-- owner-gated in the server actions.
--
-- Helpers are SECURITY DEFINER (house pattern: get_user_role/get_user_store_id)
-- so the users/stores lookups can't be skewed by those tables' own RLS. They
-- reference only users/stores — whose policies reference no other tables —
-- so there is no cross-table recursion.
--
-- prescription_images + prescription_submission_products piggyback on the
-- parent submission's visibility (EXISTS runs under the caller's RLS on
-- prescription_submissions, one-way) — tightening the parent tightens them.
-- prescription_care_logs.pcl_select_visible (073) already piggybacks — no change.
--
-- NOTE ON NUMBERING: '084' is intentionally skipped — 084_user_site_permissions
-- was reverted from the repo (site-split direction dropped) but may have been
-- applied on QA; reusing the number would silently no-op via ON CONFLICT.
--
-- Idempotent (CREATE OR REPLACE + DROP POLICY IF EXISTS). Records '085'.
-- Rollback: recreate the three policies from 038 (ps/pi) and 016 (psp); the
-- helpers are harmless to leave.
-- ============================================================================

BEGIN;

-- 0) SECURITY DEFINER helpers ------------------------------------------------
-- Is this store an OS store? (FS stores must never leak into the OS read path.)
CREATE OR REPLACE FUNCTION public.is_os_store(p_store_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.stores s
    WHERE s.id = p_store_id AND s.store_type = 'os'
  )
$$;

-- Is the caller a staff of an OS store? (FS staff also have role='staff' —
-- the role check alone is NOT a sufficient boundary.)
CREATE OR REPLACE FUNCTION public.is_current_user_os_staff()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.stores s ON s.id = u.store_id
    WHERE u.id = auth.uid() AND u.role = 'staff' AND s.store_type = 'os'
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_os_store(uuid)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_current_user_os_staff()   TO authenticated;

-- 1) prescription_submissions — OS staff read all OS-store toa ----------------
DROP POLICY IF EXISTS ps_select_staff ON public.prescription_submissions;
CREATE POLICY ps_select_staff ON public.prescription_submissions
  FOR SELECT TO authenticated
  USING (
    (select public.is_current_user_os_staff())
    AND public.is_os_store(store_id)
  );

-- 2) prescription_images — staff read images of any VISIBLE submission --------
--    (EXISTS runs under the caller's submissions RLS: OS staff → OS toa only;
--     FS staff → parent invisible → no images.)
DROP POLICY IF EXISTS pi_select_staff ON public.prescription_images;
CREATE POLICY pi_select_staff ON public.prescription_images
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'staff'
    AND EXISTS (
      SELECT 1 FROM public.prescription_submissions s
      WHERE s.id = prescription_images.submission_id
    )
  );

-- 3) prescription_submission_products (legacy product-sync rows, read-only in
--    detail) — same piggyback so a cross-store detail view is complete --------
DROP POLICY IF EXISTS psp_select_staff ON public.prescription_submission_products;
CREATE POLICY psp_select_staff ON public.prescription_submission_products
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'staff'
    AND EXISTS (
      SELECT 1 FROM public.prescription_submissions s
      WHERE s.id = prescription_submission_products.submission_id
    )
  );

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('085', 'prescription_cross_store_read',
        'RX-V2.5 r3: OS staff SELECT all OS-store prescriptions (is_current_user_os_staff + is_os_store SECDEF helpers — FS staff blocked at the DB boundary); images + legacy products piggyback parent visibility; care logs already piggyback. Writes unchanged (owner-gated).')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT proname, prosecdef FROM pg_proc
--   WHERE proname IN ('is_os_store','is_current_user_os_staff');       -- both prosecdef = true
-- SELECT polname, pg_get_expr(polqual, polrelid) FROM pg_policy
--   WHERE polname IN ('ps_select_staff','pi_select_staff','psp_select_staff');
--   → ps_select_staff uses is_current_user_os_staff + is_os_store (no bare role check).
-- As an FS staff via PostgREST: SELECT count(*) FROM prescription_submissions; → 0 rows.
-- SELECT version FROM public.app_migrations WHERE version = '085';
