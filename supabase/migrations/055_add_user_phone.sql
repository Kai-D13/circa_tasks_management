-- ============================================================
-- Migration 055: users.phone_number + staff self-profile RPC
-- ============================================================
-- Stakeholder ask (2026-06-15): let Staff edit their own full_name +
-- phone_number from the app header. phone_number does not exist yet on
-- public.users (nor in auth) — add it. It will feed an upcoming batch.
--
-- IMPORTANT: migration 021 DROPPED "users_update_own" and locked all writes
-- on public.users to super admin ("users_write_super"), to close a role/
-- store_id self-escalation path. So a plain user-session UPDATE on users is
-- now RLS-blocked. 021 explicitly says: do self-service profile updates via a
-- SECURITY DEFINER RPC that only touches safe columns. This migration does
-- exactly that — the RPC writes ONLY full_name + phone_number for the caller's
-- own row, and only for role='staff'. role/store_id can never be changed here.
-- Additive + reversible; idempotent.
-- ============================================================

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone_number text;

-- Staff-only self-edit of name + phone. SECURITY DEFINER so it bypasses the
-- super-admin-only write policy, but it is hard-scoped to auth.uid()'s own row
-- and to the two safe columns. auth.uid() resolves to the calling user's JWT
-- even under SECURITY DEFINER (PostgREST sets it per request).
CREATE OR REPLACE FUNCTION public.update_own_profile(p_full_name text, p_phone text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (SELECT role FROM public.users WHERE id = auth.uid()) <> 'staff' THEN
    RAISE EXCEPTION 'Chỉ nhân viên được tự cập nhật hồ sơ';
  END IF;
  IF coalesce(btrim(p_full_name), '') = '' THEN
    RAISE EXCEPTION 'Họ tên không được để trống';
  END IF;
  UPDATE public.users
     SET full_name    = btrim(p_full_name),
         phone_number = nullif(btrim(coalesce(p_phone, '')), '')
   WHERE id = auth.uid();
END
$$;

REVOKE ALL ON FUNCTION public.update_own_profile(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.update_own_profile(text, text) TO authenticated;

-- Record this migration.
INSERT INTO public.app_migrations (version, name)
VALUES ('055', 'add_user_phone')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Column present:
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='users' AND column_name='phone_number';
-- expect: phone_number | text
--
-- 2) RPC exists + is SECURITY DEFINER:
-- SELECT proname, prosecdef FROM pg_proc
-- WHERE proname='update_own_profile';   -- expect prosecdef = true
--
-- 3) Self-write policy is super-admin only (no users_update_own — that's expected):
-- SELECT policyname, cmd FROM pg_policies WHERE tablename='users';
-- expect: users_select, users_write_super (NOT users_update_own)
--
-- 4) As a staff user (in the app), edit name/phone → row updates; as admin the
--    RPC raises 'Chỉ nhân viên...'.
--
-- 5) Migration recorded:
-- SELECT version FROM public.app_migrations WHERE version='055';
