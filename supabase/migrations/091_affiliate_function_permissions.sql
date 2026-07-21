-- ============================================================================
-- 091: AFFILIATE — siết quyền EXECUTE các SECURITY DEFINER function (hotfix)
-- ============================================================================
-- P1 audit sau khi chạy 090: Supabase cấp EXECUTE mặc định cho anon/
-- authenticated trên function mới (default privileges), và
-- `REVOKE ... FROM PUBLIC` trong 090 KHÔNG gỡ được các grant trực tiếp đó.
-- Hệ quả: user chưa đăng nhập cũng gọi được rpc_start_affiliate_sync() →
-- tạo run rác/giữ lease chặn cron hợp lệ.
--
-- 090 ĐÃ chạy → không sửa lại file 090; hotfix riêng này revoke đích danh
-- anon/authenticated rồi grant lại đúng đối tượng:
--   is_affiliate_dept_admin      → authenticated + service_role (RLS/app gate)
--   rpc_start/finish/fail_..._sync → CHỈ service_role (cron)
-- postgres/supabase_admin giữ quyền là bình thường.
--
-- Ghi chú ngoài phạm vi (ticket riêng, KHÔNG sửa ở đây): một số migration cũ
-- trong repo cũng chỉ `REVOKE FROM PUBLIC` — cần security audit đợt sau.
-- ============================================================================

BEGIN;

-- Helper chỉ dành cho authenticated/service role.
REVOKE ALL ON FUNCTION public.is_affiliate_dept_admin()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.is_affiliate_dept_admin()
  TO authenticated, service_role;

-- Ba RPC đồng bộ chỉ dành cho service role.
REVOKE ALL ON FUNCTION public.rpc_start_affiliate_sync()
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.rpc_finish_affiliate_sync(
  uuid, integer, integer, integer, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.rpc_fail_affiliate_sync(uuid, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_start_affiliate_sync()
  TO service_role;

GRANT EXECUTE ON FUNCTION public.rpc_finish_affiliate_sync(
  uuid, integer, integer, integer, jsonb, jsonb
) TO service_role;

GRANT EXECUTE ON FUNCTION public.rpc_fail_affiliate_sync(uuid, text)
  TO service_role;

INSERT INTO public.app_migrations (version, name, notes)
VALUES (
  '091',
  'affiliate_function_permissions',
  'Restrict Affiliate SECURITY DEFINER sync RPCs to service_role; helper available only to authenticated/service_role.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau 091)
-- ============================================================================
-- select
--   p.oid::regprocedure as signature,
--   has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
--   has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
--   has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and p.proname in (
--     'is_affiliate_dept_admin',
--     'rpc_start_affiliate_sync',
--     'rpc_finish_affiliate_sync',
--     'rpc_fail_affiliate_sync'
--   )
-- order by 1;
--
-- Kỳ vọng:
--   is_affiliate_dept_admin()            anon=false  authenticated=true   service=true
--   rpc_start_affiliate_sync()           anon=false  authenticated=false  service=true
--   rpc_finish_affiliate_sync(...)       anon=false  authenticated=false  service=true
--   rpc_fail_affiliate_sync(uuid,text)   anon=false  authenticated=false  service=true
--
-- select version, name from public.app_migrations
--   where version in ('090','091') order by version;   -- đủ 2 row
-- ============================================================================
