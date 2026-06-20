-- ============================================================
-- Migration 059: staff_referrals (campaign "Giới thiệu bạn bè")
-- ============================================================
-- Snapshot report uploaded by super admin (xlsx exported from BigQuery). The app
-- does NOT call BigQuery at runtime — super admin uploads the query result, the
-- server parses + REPLACES all rows. Staff see their own rows under "Doanh số";
-- super admin sees the aggregate at /gioi-thieu.
--
-- Match staff via normalized phone: users.phone_number (mixed +84/0) ↔ the
-- Excel phone_number. normalize_phone() canonicalizes both to a leading-0 form.
-- Idempotent.
-- ============================================================

-- Canonical VN phone: digits only, country code 84 → leading 0, ensure leading 0.
CREATE OR REPLACE FUNCTION public.normalize_phone(p text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE d text;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  d := regexp_replace(p, '[^0-9]', '', 'g');
  IF d = '' THEN RETURN NULL; END IF;
  IF left(d, 2) = '84' THEN d := '0' || substr(d, 3);
  ELSIF left(d, 1) <> '0' THEN d := '0' || d;
  END IF;
  RETURN d;
END $$;

-- Caller's normalized phone (SECURITY DEFINER avoids an RLS cross-table recursion
-- on users; mirrors get_user_store_id pattern).
CREATE OR REPLACE FUNCTION public.get_user_phone()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.normalize_phone(phone_number) FROM public.users WHERE id = auth.uid()
$$;
GRANT EXECUTE ON FUNCTION public.get_user_phone() TO authenticated;

CREATE TABLE IF NOT EXISTS public.staff_referrals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_code           text,
  store_name           text,
  phone_number         text NOT NULL,                 -- normalized staff phone
  full_name            text,
  status               text,
  referred_phone       text,
  referral_date        date,
  same_day_order       boolean NOT NULL DEFAULT false,
  customer_id          text,
  is_exist_in_referral boolean NOT NULL DEFAULT false,
  uploaded_at          timestamptz NOT NULL DEFAULT now(),
  uploaded_by          uuid REFERENCES public.users(id) ON DELETE SET NULL
);

ALTER TABLE public.staff_referrals ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_staff_referrals_phone ON public.staff_referrals (phone_number);

-- SELECT: super admin sees all; a staff sees only their own (by normalized phone).
-- No INSERT/UPDATE/DELETE policy → only the service role (upload action) writes.
DROP POLICY IF EXISTS staff_referrals_select ON public.staff_referrals;
CREATE POLICY staff_referrals_select ON public.staff_referrals
  FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR (
      (select public.get_user_role()) = 'staff'
      AND phone_number = (select public.get_user_phone())
    )
  );

INSERT INTO public.app_migrations (version, name)
VALUES ('059', 'staff_referrals')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- 1) normalize_phone:
-- SELECT public.normalize_phone('+84962925980'), public.normalize_phone('0325513737'), public.normalize_phone('962925980');
-- expect: 0962925980 | 0325513737 | 0962925980
--
-- 2) Table + RLS + helper:
-- SELECT proname, prosecdef FROM pg_proc WHERE proname IN ('normalize_phone','get_user_phone');
-- SELECT policyname FROM pg_policies WHERE tablename='staff_referrals';
--
-- 3) Migration recorded:
-- SELECT version FROM public.app_migrations WHERE version='059';
