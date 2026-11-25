-- ============================================================================
-- 133a_super_admin_add_tuyen_ly.sql
-- Chạy SAU 133 (và 130a). Ad hoc theo yêu cầu operator 25/11/2026: nâng
-- tuyen.ly@buymed.com (id 65751703-8dd7-44bf-b52e-f19e148e16f2) lên SUPER ADMIN.
-- Cùng mẫu 118a / 119a / 127a / 130a.
--
-- CÁCH CHẠY: Studio SQL editor, current_user = supabase_admin. DÁN NGUYÊN FILE,
-- không bôi chọn một đoạn (bôi riêng CREATE + INSERT là bỏ qua cả preflight lẫn
-- hậu kiểm); để role / impersonation mặc định. Lỗi hoặc timeout ⇒ KHÔNG Run lại
-- mù: kiểm marker '133a' và thân hàm (VERIFY cuối file) trước.
--
-- VÌ SAO VERSION '133a' (không phải số, như 118a / 119a / 127a / 130a): số kế
-- tiếp 134 dành cho batch theo kế hoạch (khối hiện trạng sống STATE); các
-- migration số chặn MỌI version SỐ lớn hơn mình (133 và rollback 133 dùng
-- version ~ '^[0-9]+$'). '133a' không khớp ^[0-9]+$ nên các preflight đó bỏ qua.
-- Tên file sort sau 133_ (gate e2e/super-admin-allowlist.spec.ts sort tên file,
-- không đọc rollback/). 131 / 132 / 133 chỉ GỌI public.is_super_admin(), không
-- ghim thân hàm ⇒ không bị ảnh hưởng.
--
-- HỒ SƠ ĐỌC TRƯỚC (Dev, chỉ đọc qua pg-meta BEGIN READ ONLY, 25/11/2026 21:32 VN):
--   - public.users: đúng 1 dòng email này, id 65751703-…, role 'admin', store_id NULL,
--     có department_id (Marketing) ⇒ KHÔNG đổi role (không UPDATE public.users).
--   - auth.users: cùng id + email, email đã xác nhận, đã từng đăng nhập.
--   - public.is_super_admin(): đúng bản 130a (14 email), md5 1b277ccb…, ACL = PROD_ACL.
--   - app_migrations: số lớn nhất 133; adhoc 118a, 119a, 127a, 130a.
-- Preflight vẫn fail-closed như hồ sơ trên (prod có thể đổi giữa lúc đọc và lúc chạy):
--   - role phải đúng 'admin' (khác ⇒ RAISE, hỏi lại operator — không tự đổi role);
--   - thân hàm phải đúng bản 130a, thuộc tính + ACL = PROD_ACL (PUBLIC / anon còn
--     EXECUTE là trạng thái đã biết — backlog HYG-1; anon nhận auth.uid() NULL ⇒ false).
--
-- Thay đổi: thân hàm = nguyên văn 130a + 1 email ⇒ 15 email. Không gì khác.
--   - KHÔNG GRANT/REVOKE: CREATE OR REPLACE giữ nguyên owner + ACL.
--   - KHÔNG đụng public.users (role / full_name / department_id / store_id).
--
-- Allowlist nằm ở HAI NƠI PHẢI SYNC (bài học 066/100):
--   1. DB : public.is_super_admin() — file này (RLS + RPC).
--   2. App: webapp/lib/authz.ts SUPER_ADMIN_EMAILS — commit CÙNG batch. Các
--      đường super của app kiểm email ở app rồi dùng supabaseAdmin (service
--      role, bỏ qua RLS) ⇒ CHỈ app quyết định các đường đó.
--   Cấp quyền: chạy file này (DB) → commit / push main → deploy app.
--
-- Không chạy lại được: marker '133a' đã có ⇒ RAISE. Mọi kiểm tra sai ⇒ RAISE
-- ⇒ rollback toàn bộ transaction, không nửa vời.
--
-- ROLLBACK / THU HỒI QUYỀN — PHẢI làm CẢ HAI bước, liền nhau:
--   (1) deploy app đã bỏ email khỏi authz.ts (chỉ bước này chặn các đường
--       service role); (2) chạy
--       supabase/migrations/rollback/133a_super_admin_add_tuyen_ly_rollback.sql
--       (thân hàm về nguyên văn 130a; DELETE marker '133a'). Thu hồi vì lý do bảo
--       mật ⇒ deploy app TRƯỚC. Chỉ chạy rollback DB KHÔNG thu hồi quyền.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ── Preflight ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  PROD_ACL constant text := '{=X/supabase_admin,supabase_admin=X/supabase_admin,postgres=X/supabase_admin,anon=X/supabase_admin,authenticated=X/supabase_admin,service_role=X/supabase_admin}';
  p record;
  v_role text;
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION '133a: sai database (%), kỳ vọng postgres', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
    RAISE EXCEPTION '133a: phải chạy bằng superuser (Studio = supabase_admin), current_user = %', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '133') THEN
    RAISE EXCEPTION '133a: thiếu migration nền 133 — chạy đúng thứ tự';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '130a') THEN
    RAISE EXCEPTION '133a: thiếu migration nền 130a — chạy đúng thứ tự';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '133a') THEN
    RAISE EXCEPTION '133a: marker 133a đã có — migration đã chạy, KHÔNG chạy lại';
  END IF;
  -- Account public.users: đúng 1 dòng email, đúng id, role admin.
  IF (SELECT count(*) FROM public.users WHERE lower(email) = 'tuyen.ly@buymed.com') <> 1 THEN
    RAISE EXCEPTION '133a: tuyen.ly@buymed.com phải có đúng 1 dòng public.users (đang có %)',
      (SELECT count(*) FROM public.users WHERE lower(email) = 'tuyen.ly@buymed.com');
  END IF;
  SELECT u.role INTO v_role
    FROM public.users u
   WHERE u.id = '65751703-8dd7-44bf-b52e-f19e148e16f2' AND lower(u.email) = 'tuyen.ly@buymed.com';
  IF NOT FOUND THEN
    RAISE EXCEPTION '133a: dòng public.users của tuyen.ly@buymed.com không mang id 65751703-… — DỪNG để đối chiếu';
  END IF;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION '133a: role hiện tại = % (hồ sơ đọc trước là admin) — DỪNG, hỏi lại operator; file này không đổi role', v_role;
  END IF;
  -- App đọc email từ auth.users (JWT), hàm DB đọc public.users ⇒ hai bên phải cùng id + email, email đã xác nhận.
  IF NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = '65751703-8dd7-44bf-b52e-f19e148e16f2'
      AND lower(email) = 'tuyen.ly@buymed.com'
      AND email_confirmed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION '133a: auth.users không có đúng id + email tuyen.ly@buymed.com đã xác nhận';
  END IF;
  -- Hàm hiện tại phải ĐÚNG bản 130a (không drift): thân, thuộc tính, ACL.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'is_super_admin') <> 1 THEN
    RAISE EXCEPTION '133a: public.is_super_admin phải có đúng 1 overload';
  END IF;
  SELECT md5(replace(f.prosrc, E'\r', '')) AS src_md5, f.prosecdef, f.provolatile, f.proconfig::text AS cfg,
         pg_get_userbyid(f.proowner) AS owner, f.proacl::text AS acl, pg_get_function_result(f.oid) AS res
    INTO p FROM pg_proc f WHERE f.oid = 'public.is_super_admin()'::regprocedure;
  IF p.src_md5 <> '1b277ccb6cfce7af2f064075b51837d7' THEN
    RAISE EXCEPTION '133a: thân is_super_admin() khác bản 130a (md5 %) — có thay đổi ngoài luồng, DỪNG để đối chiếu', p.src_md5;
  END IF;
  IF NOT p.prosecdef OR p.provolatile <> 's' OR p.cfg IS DISTINCT FROM '{search_path=public}' OR p.owner <> 'supabase_admin'
     OR p.res <> 'boolean' OR p.acl IS DISTINCT FROM PROD_ACL THEN
    RAISE EXCEPTION '133a: thuộc tính / ACL is_super_admin() khác hồ sơ (secdef %, vol %, cfg %, owner %, acl %)',
      p.prosecdef, p.provolatile, p.cfg, p.owner, p.acl;
  END IF;
  RAISE NOTICE '133a: preflight đạt — role = %', v_role;
END $$;

-- ── Allowlist: nguyên văn 130a + 1 email ────────────────────────────────────
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
        'ha.nguyenngoc@buymed.com',
        'tri.dao@buymed.com',
        'duc.nguyenminh@buymed.com',
        'tuyen.ly@buymed.com'
      )
      AND role = 'admin'
  )
$$;

-- ── Hậu kiểm TRONG transaction ──────────────────────────────────────────────
DO $$
DECLARE
  PROD_ACL constant text := '{=X/supabase_admin,supabase_admin=X/supabase_admin,postgres=X/supabase_admin,anon=X/supabase_admin,authenticated=X/supabase_admin,service_role=X/supabase_admin}';
  ALLOW constant text[] := ARRAY['hoangvudn96@gmail.com', 'ngoc.ta@buymed.com', 'thao@buymed.com', 'son.kieu@buymed.com',
    'lan.pham@buymed.com', 'vu@buymed.com', 'anh.nguyenvan1@buymed.com', 'phuc.nguyen@buymed.com', 'dinh.trinh@buymed.com',
    'nikhilesh.deshpande@buymed.com', 'dong.do@buymed.com', 'ha.nguyenngoc@buymed.com', 'tri.dao@buymed.com',
    'duc.nguyenminh@buymed.com', 'tuyen.ly@buymed.com'];
  p record;
  u record;
  got boolean;
  n_admin int := 0;
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'is_super_admin') <> 1 THEN
    RAISE EXCEPTION '133a: hậu kiểm — is_super_admin phải còn đúng 1 overload';
  END IF;
  SELECT md5(replace(f.prosrc, E'\r', '')) AS src_md5, f.prosecdef, f.provolatile, f.proconfig::text AS cfg,
         pg_get_userbyid(f.proowner) AS owner, f.proacl::text AS acl, pg_get_function_result(f.oid) AS res
    INTO p FROM pg_proc f WHERE f.oid = 'public.is_super_admin()'::regprocedure;
  IF p.src_md5 <> 'e22196a8be9ba934c0a9960e01c515db' THEN
    RAISE EXCEPTION '133a: hậu kiểm — thân hàm mới sai (md5 %), có thể do dán thiếu / sửa file', p.src_md5;
  END IF;
  IF NOT p.prosecdef OR p.provolatile <> 's' OR p.cfg IS DISTINCT FROM '{search_path=public}' OR p.owner <> 'supabase_admin'
     OR p.res <> 'boolean' OR p.acl IS DISTINCT FROM PROD_ACL THEN
    RAISE EXCEPTION '133a: hậu kiểm — thuộc tính / ACL đổi (secdef %, vol %, cfg %, owner %, acl %)', p.prosecdef, p.provolatile, p.cfg, p.owner, p.acl;
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.is_super_admin()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.is_super_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION '133a: hậu kiểm — authenticated / service_role mất EXECUTE (RLS gọi hàm này)';
  END IF;
  -- Account: vẫn admin (đúng 1 dòng; file không đổi role).
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = '65751703-8dd7-44bf-b52e-f19e148e16f2'
                   AND lower(email) = 'tuyen.ly@buymed.com' AND role = 'admin') THEN
    RAISE EXCEPTION '133a: hậu kiểm — tuyen.ly@buymed.com không có role admin';
  END IF;
  -- Hành vi (giả lập JWT, chỉ trong transaction): xoá claims cấp phiên (impersonation Studio còn sót) để auth.uid() chỉ đọc claim.sub.
  PERFORM set_config('request.jwt.claims', '', true);
  -- Với MỌI user role admin, is_super_admin() = email thuộc allowlist 15.
  FOR u IN SELECT id, lower(email) AS em FROM public.users WHERE role = 'admin' LOOP
    PERFORM set_config('request.jwt.claim.sub', u.id::text, true);
    got := public.is_super_admin();
    IF got IS DISTINCT FROM (u.em = ANY (ALLOW)) THEN
      RAISE EXCEPTION '133a: hậu kiểm — is_super_admin() sai cho một admin (id %): %', u.id, got;
    END IF;
    n_admin := n_admin + 1;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '65751703-8dd7-44bf-b52e-f19e148e16f2', true);
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION '133a: hậu kiểm — tuyen.ly@buymed.com chưa là super admin';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF public.is_super_admin() THEN
    RAISE EXCEPTION '133a: hậu kiểm — không có JWT mà is_super_admin() = true';
  END IF;
  RAISE NOTICE '133a: hậu kiểm đạt — % admin đối chiếu allowlist 15 email', n_admin;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('133a', 'super_admin_add_tuyen_ly',
        'Ad hoc 25/11/2026: them tuyen.ly@buymed.com vao allowlist super (15 email).'
        || ' role_before=admin (khong doi role).'
        || ' Version khong phai so de khong chiem so 134 va khong bi cac preflight chan version SO > N.'
        || ' App-layer mirror: webapp/lib/authz.ts SUPER_ADMIN_EMAILS cung batch; gate'
        || ' e2e/super-admin-allowlist.spec.ts doi hai ve trung tuyet doi.');

COMMIT;

-- ── VERIFY (chạy sau COMMIT, CHỈ ĐỌC — BEGIN READ ONLY … ROLLBACK) ──────────
-- 1) Marker: SELECT version, name, notes FROM public.app_migrations WHERE version = '133a';   -- 1 dòng
--    SELECT string_agg(version, ',' ORDER BY version) FILTER (WHERE version !~ '^[0-9]+$') FROM public.app_migrations;  -- '118a,119a,127a,130a,133a'
-- 2) Hàm: SELECT md5(replace(prosrc, E'\r', '')), proacl::text, prosecdef, provolatile, proconfig, pg_get_userbyid(proowner)
--    FROM pg_proc WHERE oid = 'public.is_super_admin()'::regprocedure;
--    Kỳ vọng md5 = e22196a8be9ba934c0a9960e01c515db, ACL / thuộc tính như preflight.
-- 3) Ma trận quyền (AGENTS §4.2) — kỳ vọng 4 dòng true, như trước (anon = true theo HYG-1, không đổi):
--    SELECT r, has_function_privilege(r, 'public.is_super_admin()', 'EXECUTE')
--      FROM unnest(ARRAY['anon','authenticated','service_role','postgres']) r;
-- 4) Account auth ↔ public: SELECT count(*) FROM auth.users a JOIN public.users u ON u.id = a.id
--    WHERE a.id = '65751703-8dd7-44bf-b52e-f19e148e16f2' AND lower(a.email) = lower(u.email)
--      AND lower(u.email) = 'tuyen.ly@buymed.com' AND a.email_confirmed_at IS NOT NULL AND u.role = 'admin';   -- 1
-- 5) Đầu-cuối qua RLS như PostgREST (policy app_migrations_select_super) — kỳ vọng is_super = true, n > 0:
--    SET LOCAL ROLE authenticated;
--    SELECT set_config('request.jwt.claim.sub', '', true),
--           set_config('request.jwt.claims', json_build_object('sub', '65751703-8dd7-44bf-b52e-f19e148e16f2', 'role', 'authenticated')::text, true);
--    SELECT public.is_super_admin() AS is_super, (SELECT count(*) FROM public.app_migrations) AS n;
--    (Sau rollback: is_super = false, n = 0.)
