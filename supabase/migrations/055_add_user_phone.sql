-- ============================================================
-- Migration 055: Add users.phone_number (staff self-editable)
-- ============================================================
-- Stakeholder ask (2026-06-15): let Staff edit their own full_name +
-- phone_number from the app header. phone_number does not exist yet on
-- public.users (nor in auth) — add it. It will feed an upcoming batch.
--
-- Self-edit needs NO new policy: the existing "users_update_own"
-- (id = auth.uid(), migration 001) already lets a user UPDATE their own row.
-- Additive + reversible; no FK/RLS/storage impact. Idempotent.
-- ============================================================

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone_number text;

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
-- 2) Self-update policy exists (no new one needed):
-- SELECT polname FROM pg_policies WHERE tablename='users' AND polname='users_update_own';
--
-- 3) Migration recorded:
-- SELECT version FROM public.app_migrations WHERE version='055';
