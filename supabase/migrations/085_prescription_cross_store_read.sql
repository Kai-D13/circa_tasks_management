-- ============================================================================
-- 085_prescription_cross_store_read.sql
-- RX-V2.5 — Staff cross-store READ for the Toa thuốc module.
--
-- Stakeholder (2026-07-10): an OS pharmacist sometimes needs to look up another
-- store's prescription (customer walks in with a toa submitted elsewhere).
-- New read rule:
--   staff          → SELECT every prescription (was: own submissions only)
--   store_manager  → unchanged (own store only)
--   admin          → unchanged (all)
--   sm             → unchanged (no /prescriptions access; no policy — no rows)
-- WRITE surface is NOT widened: insert stays owner+store-checked (ps_insert_staff
-- unchanged), care/DHC-fix/days-supply edits stay owner-gated in server actions.
--
-- Related tables: prescription_images + prescription_submission_products carried
-- their own owner-EXISTS staff policies — widened to "parent submission visible"
-- (the EXISTS subquery runs under the caller's RLS on prescription_submissions,
-- one-way reference, no recursion). prescription_care_logs.pcl_select_visible
-- (073) is ALREADY a piggyback policy — no change needed.
--
-- NOTE ON NUMBERING: '084' is intentionally skipped — 084_user_site_permissions
-- was reverted from the repo (site-split direction dropped) but may have been
-- applied on QA; reusing the number would silently no-op via ON CONFLICT.
--
-- Idempotent (DROP POLICY IF EXISTS + CREATE). Records app_migrations '085'.
-- Rollback: recreate the three policies from 038 (ps/pi) and 016 (psp).
-- ============================================================================

BEGIN;

-- 1) prescription_submissions — staff read all -------------------------------
DROP POLICY IF EXISTS ps_select_staff ON public.prescription_submissions;
CREATE POLICY ps_select_staff ON public.prescription_submissions
  FOR SELECT TO authenticated
  USING ((select public.get_user_role()) = 'staff');

-- 2) prescription_images — staff read images of any visible submission -------
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
--    detail) — same widening so a cross-store detail view is complete ---------
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
        'RX-V2.5: staff SELECT all prescriptions (lookup across stores); images + legacy products follow parent visibility; care logs already piggyback. Writes unchanged (owner-gated).')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT polname, pg_get_expr(polqual, polrelid) FROM pg_policy
--   WHERE polname IN ('ps_select_staff','pi_select_staff','psp_select_staff');
--   → ps_select_staff has NO submitted_by condition; pi/psp EXISTS without owner.
-- SELECT version FROM public.app_migrations WHERE version = '085';
