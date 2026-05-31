-- ============================================================
-- Migration 017: Super Admin permissions
-- ============================================================
-- Only the super admin (hoangvudn96@gmail.com, role=admin) may:
--   * run prescription product sync (insert products + sync batches)
--   * create/modify admin users (enforced in server actions — createUser
--     uses the service role and bypasses RLS)
-- DB-layer gate here protects the RLS-checked sync paths even if the
-- server-action guard were bypassed.
-- Idempotent: CREATE OR REPLACE function; DROP POLICY IF EXISTS before each.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND lower(email) = 'hoangvudn96@gmail.com'
      AND role = 'admin'
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

-- ── prescription_submission_products: only super admin may INSERT ──
-- Sync inserts product rows, so this is the real DB gate for sync.
DROP POLICY IF EXISTS "psp_insert_admin" ON public.prescription_submission_products;
DROP POLICY IF EXISTS "psp_insert_super" ON public.prescription_submission_products;
CREATE POLICY "psp_insert_super" ON public.prescription_submission_products
  FOR INSERT TO authenticated
  WITH CHECK (public.is_super_admin());

-- ── prescription_sync_batches: admin SELECT, super admin write ──
DROP POLICY IF EXISTS "psb_admin"         ON public.prescription_sync_batches;
DROP POLICY IF EXISTS "psb_select_admin"  ON public.prescription_sync_batches;
DROP POLICY IF EXISTS "psb_write_super"   ON public.prescription_sync_batches;
DROP POLICY IF EXISTS "psb_update_super"  ON public.prescription_sync_batches;

CREATE POLICY "psb_select_admin" ON public.prescription_sync_batches
  FOR SELECT TO authenticated
  USING (get_user_role() = 'admin');

CREATE POLICY "psb_write_super" ON public.prescription_sync_batches
  FOR INSERT TO authenticated
  WITH CHECK (public.is_super_admin());

-- Sync action updates error_count on failure → super admin needs UPDATE
CREATE POLICY "psb_update_super" ON public.prescription_sync_batches
  FOR UPDATE TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- ── prescription_submissions: restrict the sync-status UPDATE to super admin ──
-- (regular admins have no other reason to UPDATE submissions today)
DROP POLICY IF EXISTS "ps_update_admin" ON public.prescription_submissions;
DROP POLICY IF EXISTS "ps_update_super" ON public.prescription_submissions;
CREATE POLICY "ps_update_super" ON public.prescription_submissions
  FOR UPDATE TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());
