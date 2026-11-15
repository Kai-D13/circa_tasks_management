-- ============================================================================
-- ROLLBACK 127a_super_admin_add_tri_dao.sql
-- Trả public.is_super_admin() về NGUYÊN VĂN 119a (12 email), trả role của
-- tri.dao@buymed.com về đúng role_before ghi trong notes marker '127a'
-- (admin ⇒ không đổi; staff ⇒ admin → staff), rồi xoá marker '127a'.
--
-- ⚠ CHỈ CHẠY FILE NÀY KHÔNG THU HỒI QUYỀN. Các đường super của app (users /
-- targets / referrals / departments / kpiCampaigns actions: đặt lại mật khẩu,
-- đổi role, gán SM, …) kiểm email trong webapp/lib/authz.ts rồi dùng
-- supabaseAdmin (service role, bỏ qua RLS) ⇒ vẫn mở tới khi deploy app đã bỏ
-- email. Thu hồi = CẢ HAI bước, liền nhau: (1) deploy app đã bỏ email khỏi
-- authz.ts; (2) chạy file này. Thu hồi vì lý do bảo mật ⇒ deploy app TRƯỚC.
--
-- CÁCH CHẠY: Studio, current_user = supabase_admin, DÁN NGUYÊN FILE, để role /
-- impersonation mặc định. Chỉ chạy khi thân hàm đang ĐÚNG bản 127a (không
-- drift) — sai ⇒ RAISE, không đổi gì.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  PROD_ACL constant text := '{=X/supabase_admin,supabase_admin=X/supabase_admin,postgres=X/supabase_admin,anon=X/supabase_admin,authenticated=X/supabase_admin,service_role=X/supabase_admin}';
  p record;
  v_before text;
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'rollback 127a: sai database (%), kỳ vọng postgres', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
    RAISE EXCEPTION 'rollback 127a: phải chạy bằng superuser (Studio = supabase_admin), current_user = %', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '127a') THEN
    RAISE EXCEPTION 'rollback 127a: chưa có marker 127a — không có gì để rollback';
  END IF;
  SELECT substring(notes FROM 'role_before=([a-z_]+)') INTO v_before FROM public.app_migrations WHERE version = '127a';
  IF v_before IS NULL OR v_before NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'rollback 127a: notes marker không có role_before hợp lệ (%) — DỪNG để đối chiếu', v_before;
  END IF;
  PERFORM set_config('circa.m127a_role_before', v_before, true);
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = 'd466d69d-9a9e-444c-a1f4-dbffa91d08f4'
                   AND lower(email) = 'tri.dao@buymed.com' AND role = 'admin') THEN
    RAISE EXCEPTION 'rollback 127a: tri.dao@buymed.com không còn role admin — có thay đổi sau 127a, DỪNG để đối chiếu';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'is_super_admin') <> 1 THEN
    RAISE EXCEPTION 'rollback 127a: public.is_super_admin phải có đúng 1 overload';
  END IF;
  SELECT md5(replace(f.prosrc, E'\r', '')) AS src_md5, f.prosecdef, f.provolatile, f.proconfig::text AS cfg,
         pg_get_userbyid(f.proowner) AS owner, f.proacl::text AS acl, pg_get_function_result(f.oid) AS res
    INTO p FROM pg_proc f WHERE f.oid = 'public.is_super_admin()'::regprocedure;
  IF p.src_md5 IS DISTINCT FROM '470f240068e93e26bda444045b3b388e' THEN
    RAISE EXCEPTION 'rollback 127a: thân is_super_admin() không phải bản 127a (md5 %) — DỪNG để đối chiếu', p.src_md5;
  END IF;
  IF NOT p.prosecdef OR p.provolatile <> 's' OR p.cfg IS DISTINCT FROM '{search_path=public}' OR p.owner <> 'supabase_admin'
     OR p.res <> 'boolean' OR p.acl IS DISTINCT FROM PROD_ACL THEN
    RAISE EXCEPTION 'rollback 127a: thuộc tính / ACL is_super_admin() khác hồ sơ (secdef %, vol %, cfg %, owner %, acl %)',
      p.prosecdef, p.provolatile, p.cfg, p.owner, p.acl;
  END IF;
END $$;

-- Role về đúng role_before (staff ⇒ đổi lại; admin ⇒ 0 dòng). WHERE đầy đủ (pg_safeupdate).
UPDATE public.users
   SET role = 'staff'
 WHERE id = 'd466d69d-9a9e-444c-a1f4-dbffa91d08f4'
   AND lower(email) = 'tri.dao@buymed.com'
   AND role = 'admin'
   AND current_setting('circa.m127a_role_before') = 'staff';

-- Nguyên văn 119a (12 email).
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
        'dong.do@buymed.com',
        'ha.nguyenngoc@buymed.com'
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
    RAISE EXCEPTION 'rollback 127a: hậu kiểm — is_super_admin phải còn đúng 1 overload';
  END IF;
  SELECT md5(replace(f.prosrc, E'\r', '')) AS src_md5, f.prosecdef, f.provolatile, f.proconfig::text AS cfg,
         pg_get_userbyid(f.proowner) AS owner, f.proacl::text AS acl, pg_get_function_result(f.oid) AS res
    INTO p FROM pg_proc f WHERE f.oid = 'public.is_super_admin()'::regprocedure;
  IF p.src_md5 <> 'cc8b61fec311b288b2778132f39469fb' OR NOT p.prosecdef OR p.provolatile <> 's'
     OR p.cfg IS DISTINCT FROM '{search_path=public}' OR p.owner <> 'supabase_admin' OR p.res <> 'boolean'
     OR p.acl IS DISTINCT FROM PROD_ACL THEN
    RAISE EXCEPTION 'rollback 127a: hậu kiểm — thân (md5 %) / thuộc tính / ACL (%) không đúng bản 119a', p.src_md5, p.acl;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = 'd466d69d-9a9e-444c-a1f4-dbffa91d08f4'
                   AND role = current_setting('circa.m127a_role_before')) THEN
    RAISE EXCEPTION 'rollback 127a: hậu kiểm — role chưa về %', current_setting('circa.m127a_role_before');
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', 'd466d69d-9a9e-444c-a1f4-dbffa91d08f4', true);
  IF public.is_super_admin() THEN
    RAISE EXCEPTION 'rollback 127a: hậu kiểm — tri.dao@buymed.com vẫn là super admin';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
END $$;

DELETE FROM public.app_migrations WHERE version = '127a';

COMMIT;
