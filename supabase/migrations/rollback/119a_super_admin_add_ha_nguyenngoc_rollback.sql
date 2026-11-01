-- ============================================================================
-- ROLLBACK 119a_super_admin_add_ha_nguyenngoc.sql
-- Trả public.is_super_admin() về NGUYÊN VĂN 118a (11 email) và xoá marker '119a'.
-- KHÔNG đụng public.users (119a không đổi role).
--
-- ⚠ CHỈ CHẠY FILE NÀY KHÔNG THU HỒI QUYỀN. Các đường super của app (users /
-- targets / referrals / departments / kpiCampaigns actions: đặt lại mật khẩu,
-- đổi role, gán SM, …) kiểm email trong webapp/lib/authz.ts rồi dùng
-- supabaseAdmin (service role, bỏ qua RLS) ⇒ vẫn mở tới khi deploy app đã bỏ
-- email. Thu hồi = CẢ HAI bước, liền nhau: (1) deploy app đã bỏ email khỏi
-- authz.ts; (2) chạy file này. Thu hồi vì lý do bảo mật ⇒ deploy app TRƯỚC.
--
-- CÁCH CHẠY: Studio, current_user = supabase_admin, DÁN NGUYÊN FILE, để role /
-- impersonation mặc định. Chỉ chạy khi thân hàm đang ĐÚNG bản 119a (không
-- drift) — sai ⇒ RAISE, không đổi gì.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  PROD_ACL constant text := '{=X/supabase_admin,supabase_admin=X/supabase_admin,postgres=X/supabase_admin,anon=X/supabase_admin,authenticated=X/supabase_admin,service_role=X/supabase_admin}';
  p record;
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'rollback 119a: sai database (%), kỳ vọng postgres', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
    RAISE EXCEPTION 'rollback 119a: phải chạy bằng superuser (Studio = supabase_admin), current_user = %', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '119a') THEN
    RAISE EXCEPTION 'rollback 119a: chưa có marker 119a — không có gì để rollback';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'is_super_admin') <> 1 THEN
    RAISE EXCEPTION 'rollback 119a: public.is_super_admin phải có đúng 1 overload';
  END IF;
  SELECT md5(replace(f.prosrc, E'\r', '')) AS src_md5, f.prosecdef, f.provolatile, f.proconfig::text AS cfg,
         pg_get_userbyid(f.proowner) AS owner, f.proacl::text AS acl, pg_get_function_result(f.oid) AS res
    INTO p FROM pg_proc f WHERE f.oid = 'public.is_super_admin()'::regprocedure;
  IF p.src_md5 IS DISTINCT FROM 'cc8b61fec311b288b2778132f39469fb' THEN
    RAISE EXCEPTION 'rollback 119a: thân is_super_admin() không phải bản 119a (md5 %) — DỪNG để đối chiếu', p.src_md5;
  END IF;
  IF NOT p.prosecdef OR p.provolatile <> 's' OR p.cfg IS DISTINCT FROM '{search_path=public}' OR p.owner <> 'supabase_admin'
     OR p.res <> 'boolean' OR p.acl IS DISTINCT FROM PROD_ACL THEN
    RAISE EXCEPTION 'rollback 119a: thuộc tính / ACL is_super_admin() khác hồ sơ (secdef %, vol %, cfg %, owner %, acl %)',
      p.prosecdef, p.provolatile, p.cfg, p.owner, p.acl;
  END IF;
END $$;

-- Nguyên văn 118a (11 email).
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
      AND lower(email) IN (
        'hoangvudn96@gmail.com',
        'ngoc.ta@buymed.com',
        'thao@buymed.com',
        'son.kieu@buymed.com',
        'lan.pham@buymed.com',
        'vu@buymed.com',
        'anh.nguyenvan1@buymed.com',
        'phuc.nguyen@buymed.com',
        'dinh.trinh@buymed.com',
        'nikhilesh.deshpande@buymed.com',
        'dong.do@buymed.com'
      )
      AND role = 'admin'
  )
$$;

DO $$
DECLARE
  PROD_ACL constant text := '{=X/supabase_admin,supabase_admin=X/supabase_admin,postgres=X/supabase_admin,anon=X/supabase_admin,authenticated=X/supabase_admin,service_role=X/supabase_admin}';
  p record;
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'is_super_admin') <> 1 THEN
    RAISE EXCEPTION 'rollback 119a: hậu kiểm — is_super_admin phải còn đúng 1 overload';
  END IF;
  SELECT md5(replace(f.prosrc, E'\r', '')) AS src_md5, f.prosecdef, f.provolatile, f.proconfig::text AS cfg,
         pg_get_userbyid(f.proowner) AS owner, f.proacl::text AS acl, pg_get_function_result(f.oid) AS res
    INTO p FROM pg_proc f WHERE f.oid = 'public.is_super_admin()'::regprocedure;
  IF p.src_md5 <> 'f2d4c63a94ebb5dc11e18cdd742a79d0' OR NOT p.prosecdef OR p.provolatile <> 's'
     OR p.cfg IS DISTINCT FROM '{search_path=public}' OR p.owner <> 'supabase_admin' OR p.res <> 'boolean'
     OR p.acl IS DISTINCT FROM PROD_ACL THEN
    RAISE EXCEPTION 'rollback 119a: hậu kiểm — thân (md5 %) / thuộc tính / ACL (%) không đúng bản 118a', p.src_md5, p.acl;
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '24849449-1c56-42f3-9253-0935762c73f1', true);
  IF public.is_super_admin() THEN
    RAISE EXCEPTION 'rollback 119a: hậu kiểm — ha.nguyenngoc@buymed.com vẫn là super admin';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
END $$;

DELETE FROM public.app_migrations WHERE version = '119a';

COMMIT;
