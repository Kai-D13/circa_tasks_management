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
DECLARE
  v_name  text := btrim(coalesce(p_full_name, ''));
  -- Strip spaces / . / - / ( ) before validating, then NULL if empty.
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[[:space:].()-]', '', 'g'), '');
BEGIN
  -- Validation lives here too (not only in the server action) because the RPC is
  -- granted to every authenticated user and could be called directly. phone_number
  -- feeds an important downstream batch, so guard its shape at the DB layer.
  IF (SELECT role FROM public.users WHERE id = auth.uid()) IS DISTINCT FROM 'staff' THEN
    RAISE EXCEPTION 'Chỉ nhân viên được tự cập nhật hồ sơ';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'Họ tên không được để trống';
  END IF;
  IF char_length(v_name) > 100 THEN
    RAISE EXCEPTION 'Họ tên quá dài (tối đa 100 ký tự)';
  END IF;
  IF v_phone IS NOT NULL AND v_phone !~ '^(0|[+]84)[0-9]{9,10}$' THEN
    RAISE EXCEPTION 'Số điện thoại không hợp lệ';
  END IF;

  UPDATE public.users
     SET full_name    = v_name,
         phone_number = v_phone
   WHERE id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hồ sơ người dùng';
  END IF;
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
-- 2) RPC exists + is SECURITY DEFINER (REQUIRED — an earlier 055 only added the
--    column, so app_migrations having '055' does NOT prove the RPC exists; this
--    file is CREATE OR REPLACE + idempotent, safe to re-run to add the RPC):
-- SELECT proname, prosecdef FROM pg_proc
-- WHERE proname='update_own_profile';   -- expect 1 row, prosecdef = true
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
