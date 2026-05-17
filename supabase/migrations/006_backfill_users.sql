-- Backfill public.users for any auth.users that were created before the trigger existed.
-- Safe to run multiple times (ON CONFLICT DO NOTHING).
INSERT INTO public.users (id, email, full_name, role, store_id, created_at)
SELECT
  au.id,
  au.email,
  COALESCE(au.raw_user_meta_data->>'full_name', au.email, ''),
  COALESCE(au.raw_user_meta_data->>'role', 'staff'),
  CASE
    WHEN au.raw_user_meta_data->>'store_id' IS NOT NULL
    THEN (au.raw_user_meta_data->>'store_id')::uuid
    ELSE NULL
  END,
  au.created_at
FROM auth.users au
WHERE au.id NOT IN (SELECT id FROM public.users)
ON CONFLICT (id) DO NOTHING;
