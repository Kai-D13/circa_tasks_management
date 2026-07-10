-- ============================================================================
-- 088_prescription_staff_os_wide_read.sql
-- RX-V2.8 — restore OS-wide prescription read/search for OS staff.
--
-- Context:
--   085 intentionally opened OS staff SELECT to all OS-store prescriptions while
--   blocking FS staff at the DB boundary.
--   087 added the paged search RPC, but mistakenly tightened ps_select_staff to
--   the caller's own store. Stakeholder final rule is:
--     * view/search: OS staff can see all OS-store prescriptions;
--     * actions (care / DHC-fix): staff remain scoped to their own submissions
--       in the app layer;
--     * FS staff must not see OS prescriptions.
--
-- This migration only fixes the staff SELECT policy. Child tables already
-- piggyback parent visibility via EXISTS against prescription_submissions.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS ps_select_staff ON public.prescription_submissions;
CREATE POLICY ps_select_staff ON public.prescription_submissions
  FOR SELECT TO authenticated
  USING (
    (select public.is_current_user_os_staff())
    AND public.is_os_store(store_id)
  );

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('088', 'prescription_staff_os_wide_read',
        'RX-V2.8: restore OS staff view/search to all OS-store prescriptions after 087 mistakenly scoped SELECT to own store; FS staff still blocked by is_current_user_os_staff; actions remain app-scoped to own submissions.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT version, name FROM public.app_migrations WHERE version = '088';
-- SELECT policyname, cmd, qual
-- FROM pg_policies
-- WHERE schemaname='public' AND tablename='prescription_submissions' AND policyname='ps_select_staff';
-- Expected qual includes is_current_user_os_staff() AND is_os_store(store_id),
-- not store_id = get_user_store_id().