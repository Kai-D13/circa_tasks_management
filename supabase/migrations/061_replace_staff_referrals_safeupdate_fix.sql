-- ============================================================
-- Migration 061: fix replace_staff_referrals for pg_safeupdate guard
-- ============================================================
-- Prod self-hosted Postgres has the safeupdate guard enabled, which rejects any
-- DELETE/UPDATE without a WHERE clause ("DELETE requires a WHERE clause") — even
-- inside a SECURITY DEFINER function. Migration 059's replace_staff_referrals did
-- a bare `DELETE FROM staff_referrals`, so every /gioi-thieu upload failed with
-- "Ghi dữ liệu lỗi: DELETE requires a WHERE clause".
--
-- Fix: add an always-true WHERE. Same semantics (delete all rows), still atomic
-- (delete + insert in one transaction). Idempotent (CREATE OR REPLACE).
-- ============================================================

CREATE OR REPLACE FUNCTION public.replace_staff_referrals(p_rows jsonb, p_uploaded_by uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n integer;
BEGIN
  DELETE FROM public.staff_referrals WHERE true;  -- WHERE true satisfies the safeupdate guard
  INSERT INTO public.staff_referrals
    (store_code, store_name, phone_number, full_name, status, referred_phone,
     referral_date, same_day_order, customer_id, is_exist_in_referral, uploaded_by)
  SELECT x.store_code, x.store_name, x.phone_number, x.full_name, x.status, x.referred_phone,
         x.referral_date, coalesce(x.same_day_order, false), x.customer_id,
         coalesce(x.is_exist_in_referral, false), p_uploaded_by
  FROM jsonb_to_recordset(p_rows) AS x(
    store_code text, store_name text, phone_number text, full_name text, status text,
    referred_phone text, referral_date date, same_day_order boolean, customer_id text,
    is_exist_in_referral boolean
  )
  WHERE x.phone_number IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.replace_staff_referrals(jsonb, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.replace_staff_referrals(jsonb, uuid) TO service_role;

INSERT INTO public.app_migrations (version, name)
VALUES ('061', 'replace_staff_referrals_safeupdate_fix')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- After running, re-upload the JSON at /gioi-thieu → should succeed.
-- SELECT version FROM public.app_migrations WHERE version='061';
-- SELECT count(*) FROM public.staff_referrals;
