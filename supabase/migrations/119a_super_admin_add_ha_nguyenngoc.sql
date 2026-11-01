-- ============================================================================
-- 119a_super_admin_add_ha_nguyenngoc.sql
-- Chạy SAU 119 (và 118a). Ad hoc theo yêu cầu operator 01/11/2026: nâng
-- ha.nguyenngoc@buymed.com (id 24849449-1c56-42f3-9253-0935762c73f1, đang role
-- admin, phòng OPS) lên SUPER ADMIN. Cùng mẫu 118a.
--
-- CÁCH CHẠY: Studio SQL editor, current_user = supabase_admin. DÁN NGUYÊN FILE,
-- không bôi chọn một đoạn (bôi riêng CREATE + INSERT là bỏ qua cả preflight lẫn
-- hậu kiểm); để role / impersonation mặc định. Lỗi hoặc timeout ⇒ KHÔNG Run lại
-- mù: kiểm marker '119a' và thân hàm (verify) trước.
--
-- VÌ SAO VERSION '119a' (không phải số, như 118a): 120 đã dành cho P-K1 (file đã
-- audit, preflight đòi '119' và chặn version SỐ > 120). Lấy '121' khiến 120 không
-- chạy được nữa. '119a' không khớp ^[0-9]+$ nên preflight 120 (dạng CASE WHEN
-- version ~ ...) bỏ qua nó; tên file sort sau 119_ và trước 120_ (gate
-- e2e/super-admin-allowlist.spec.ts sort tên file, không đọc rollback/).
--
-- Hồ sơ prod đọc CHỈ ĐỌC 01/11/2026 (pg-meta, ops-ro):
--   - public.users: đúng 1 dòng id + email này, role = 'admin', store_id NULL,
--     phòng OPS; auth.users cùng id + email, đã xác nhận email.
--     ⇒ KHÔNG cần UPDATE role.
--   - public.is_super_admin(): thân = nguyên văn 118a (11 email),
--     md5(replace(prosrc, E'\r', '')) = f2d4c63a94ebb5dc11e18cdd742a79d0,
--     ACL = PROD_ACL bên dưới (PUBLIC / anon còn EXECUTE là trạng thái đã biết —
--     backlog HYG-1; anon nhận auth.uid() NULL ⇒ false). 119a KHÔNG đổi ACL.
--   - app_migrations mới nhất: 119, 118a, 118.
--
-- Thay đổi DUY NHẤT: thân hàm = nguyên văn 118a + 1 email ⇒ 12 email.
--   - KHÔNG GRANT/REVOKE: CREATE OR REPLACE giữ nguyên owner + ACL.
--   - KHÔNG đụng public.users (role đã đúng), full_name/department/store.
--
-- Allowlist nằm ở HAI NƠI PHẢI SYNC (bài học 066/100):
--   1. DB : public.is_super_admin() — file này (RLS + RPC).
--   2. App: webapp/lib/authz.ts SUPER_ADMIN_EMAILS — commit CÙNG batch. Các
--      đường super của app kiểm email ở app rồi dùng supabaseAdmin (service
--      role, bỏ qua RLS) ⇒ CHỈ app quyết định các đường đó.
--   Cấp quyền: chạy file này (DB) → deploy app.
--
-- Không chạy lại được: marker '119a' đã có ⇒ RAISE. Mọi kiểm tra sai ⇒ RAISE
-- ⇒ rollback toàn bộ transaction, không nửa vời.
--
-- ROLLBACK / THU HỒI QUYỀN — PHẢI làm CẢ HAI bước, liền nhau:
--   (1) deploy app đã bỏ email khỏi authz.ts (chỉ bước này chặn các đường
--       service role); (2) chạy
--       supabase/migrations/rollback/119a_super_admin_add_ha_nguyenngoc_rollback.sql
--       (thân hàm về nguyên văn 118a + DELETE FROM public.app_migrations
--       WHERE version = '119a'). Thu hồi vì lý do bảo mật ⇒ deploy app TRƯỚC.
--       Chỉ chạy rollback DB KHÔNG thu hồi quyền.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ── Preflight ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  PROD_ACL constant text := '{=X/supabase_admin,supabase_admin=X/supabase_admin,postgres=X/supabase_admin,anon=X/supabase_admin,authenticated=X/supabase_admin,service_role=X/supabase_admin}';
  p record;
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION '119a: sai database (%), kỳ vọng postgres', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
    RAISE EXCEPTION '119a: phải chạy bằng superuser (Studio = supabase_admin), current_user = %', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '119') THEN
    RAISE EXCEPTION '119a: thiếu migration nền 119 — chạy đúng thứ tự';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '118a') THEN
    RAISE EXCEPTION '119a: thiếu migration nền 118a — chạy đúng thứ tự';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '119a') THEN
    RAISE EXCEPTION '119a: marker 119a đã có — migration đã chạy, KHÔNG chạy lại';
  END IF;
  -- Account: đúng 1 dòng, đúng id + email, role admin. Role khác ⇒ DỪNG (ngoài phạm vi; sm/store_manager kéo theo dữ liệu phụ).
  IF (SELECT count(*) FROM public.users WHERE lower(email) = 'ha.nguyenngoc@buymed.com') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.users
       WHERE id = '24849449-1c56-42f3-9253-0935762c73f1'
         AND lower(email) = 'ha.nguyenngoc@buymed.com'
         AND role = 'admin'
     ) THEN
    RAISE EXCEPTION '119a: account ha.nguyenngoc@buymed.com phải là đúng 1 dòng public.users (id 24849449-…) với role admin';
  END IF;
  -- App đọc email từ auth.users (JWT), hàm DB đọc public.users ⇒ hai bên phải cùng id + email, email đã xác nhận.
  IF NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = '24849449-1c56-42f3-9253-0935762c73f1'
      AND lower(email) = 'ha.nguyenngoc@buymed.com'
      AND email_confirmed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION '119a: auth.users không có đúng id + email ha.nguyenngoc@buymed.com đã xác nhận';
  END IF;
  -- Hàm hiện tại phải ĐÚNG bản 118a (không drift): thân, thuộc tính, ACL.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'is_super_admin') <> 1 THEN
    RAISE EXCEPTION '119a: public.is_super_admin phải có đúng 1 overload';
  END IF;
  SELECT md5(replace(f.prosrc, E'\r', '')) AS src_md5, f.prosecdef, f.provolatile, f.proconfig::text AS cfg,
         pg_get_userbyid(f.proowner) AS owner, f.proacl::text AS acl, pg_get_function_result(f.oid) AS res
    INTO p FROM pg_proc f WHERE f.oid = 'public.is_super_admin()'::regprocedure;
  IF p.src_md5 <> 'f2d4c63a94ebb5dc11e18cdd742a79d0' THEN
    RAISE EXCEPTION '119a: thân is_super_admin() khác bản 118a (md5 %) — có thay đổi ngoài luồng, DỪNG để đối chiếu', p.src_md5;
  END IF;
  IF NOT p.prosecdef OR p.provolatile <> 's' OR p.cfg IS DISTINCT FROM '{search_path=public}' OR p.owner <> 'supabase_admin'
     OR p.res <> 'boolean' OR p.acl IS DISTINCT FROM PROD_ACL THEN
    RAISE EXCEPTION '119a: thuộc tính / ACL is_super_admin() khác hồ sơ 01/11 (secdef %, vol %, cfg %, owner %, acl %)',
      p.prosecdef, p.provolatile, p.cfg, p.owner, p.acl;
  END IF;
END $$;

-- ── Allowlist: nguyên văn 118a + 1 email ────────────────────────────────────
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

-- ── Hậu kiểm TRONG transaction ──────────────────────────────────────────────
DO $$
DECLARE
  PROD_ACL constant text := '{=X/supabase_admin,supabase_admin=X/supabase_admin,postgres=X/supabase_admin,anon=X/supabase_admin,authenticated=X/supabase_admin,service_role=X/supabase_admin}';
  ALLOW constant text[] := ARRAY['hoangvudn96@gmail.com', 'ngoc.ta@buymed.com', 'thao@buymed.com', 'son.kieu@buymed.com',
    'lan.pham@buymed.com', 'vu@buymed.com', 'anh.nguyenvan1@buymed.com', 'phuc.nguyen@buymed.com', 'dinh.trinh@buymed.com',
    'nikhilesh.deshpande@buymed.com', 'dong.do@buymed.com', 'ha.nguyenngoc@buymed.com'];
  p record;
  u record;
  got boolean;
  n_admin int := 0;
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'is_super_admin') <> 1 THEN
    RAISE EXCEPTION '119a: hậu kiểm — is_super_admin phải còn đúng 1 overload';
  END IF;
  SELECT md5(replace(f.prosrc, E'\r', '')) AS src_md5, f.prosecdef, f.provolatile, f.proconfig::text AS cfg,
         pg_get_userbyid(f.proowner) AS owner, f.proacl::text AS acl, pg_get_function_result(f.oid) AS res
    INTO p FROM pg_proc f WHERE f.oid = 'public.is_super_admin()'::regprocedure;
  IF p.src_md5 <> 'cc8b61fec311b288b2778132f39469fb' THEN
    RAISE EXCEPTION '119a: hậu kiểm — thân hàm mới sai (md5 %), có thể do dán thiếu / sửa file', p.src_md5;
  END IF;
  IF NOT p.prosecdef OR p.provolatile <> 's' OR p.cfg IS DISTINCT FROM '{search_path=public}' OR p.owner <> 'supabase_admin'
     OR p.res <> 'boolean' OR p.acl IS DISTINCT FROM PROD_ACL THEN
    RAISE EXCEPTION '119a: hậu kiểm — thuộc tính / ACL đổi (secdef %, vol %, cfg %, owner %, acl %)', p.prosecdef, p.provolatile, p.cfg, p.owner, p.acl;
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.is_super_admin()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.is_super_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION '119a: hậu kiểm — authenticated / service_role mất EXECUTE (RLS gọi hàm này)';
  END IF;
  -- Hành vi (giả lập JWT, chỉ trong transaction): xoá claims cấp phiên (impersonation Studio còn sót) để auth.uid() chỉ đọc claim.sub.
  PERFORM set_config('request.jwt.claims', '', true);
  -- Với MỌI user role admin, is_super_admin() = email thuộc allowlist 12.
  FOR u IN SELECT id, lower(email) AS em FROM public.users WHERE role = 'admin' LOOP
    PERFORM set_config('request.jwt.claim.sub', u.id::text, true);
    got := public.is_super_admin();
    IF got IS DISTINCT FROM (u.em = ANY (ALLOW)) THEN
      RAISE EXCEPTION '119a: hậu kiểm — is_super_admin() sai cho một admin (id %): %', u.id, got;
    END IF;
    n_admin := n_admin + 1;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '24849449-1c56-42f3-9253-0935762c73f1', true);
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION '119a: hậu kiểm — ha.nguyenngoc@buymed.com chưa là super admin';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF public.is_super_admin() THEN
    RAISE EXCEPTION '119a: hậu kiểm — không có JWT mà is_super_admin() = true';
  END IF;
  RAISE NOTICE '119a: hậu kiểm đạt — % admin đối chiếu allowlist 12 email', n_admin;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('119a', 'super_admin_add_ha_nguyenngoc',
        'Ad hoc 01/11/2026: them ha.nguyenngoc@buymed.com vao allowlist super (12 email).'
        || ' Account da role=admin nen khong UPDATE users. Version khong phai so de'
        || ' khong chan preflight 120 (da danh so P-K1). App-layer mirror:'
        || ' webapp/lib/authz.ts SUPER_ADMIN_EMAILS cung batch; gate'
        || ' e2e/super-admin-allowlist.spec.ts doi hai ve trung tuyet doi.');

COMMIT;

-- ── VERIFY (chạy sau COMMIT, CHỈ ĐỌC — BEGIN READ ONLY … ROLLBACK) ──────────
-- 1) Marker: SELECT version, name FROM public.app_migrations WHERE version = '119a';   -- 1 dòng
--    SELECT string_agg(version, ',' ORDER BY version) FILTER (WHERE version !~ '^[0-9]+$') FROM public.app_migrations;  -- '118a,119a'
-- 2) Hàm: SELECT md5(replace(prosrc, E'\r', '')), proacl::text, prosecdef, provolatile, proconfig, pg_get_userbyid(proowner)
--    FROM pg_proc WHERE oid = 'public.is_super_admin()'::regprocedure;
--    Kỳ vọng md5 = cc8b61fec311b288b2778132f39469fb, ACL / thuộc tính như preflight.
-- 3) Ma trận quyền (AGENTS §4.2) — kỳ vọng 4 dòng true, như trước (anon = true theo HYG-1, không đổi):
--    SELECT r, has_function_privilege(r, 'public.is_super_admin()', 'EXECUTE')
--      FROM unnest(ARRAY['anon','authenticated','service_role','postgres']) r;
-- 4) Ảnh ACL toàn bộ hàm public: n_fn và acl_snapshot_md5 KHÔNG đổi so với ngay trước khi chạy.
-- 5) Account auth ↔ public: SELECT count(*) FROM auth.users a JOIN public.users u ON u.id = a.id
--    WHERE a.id = '24849449-1c56-42f3-9253-0935762c73f1' AND lower(a.email) = lower(u.email)
--      AND lower(u.email) = 'ha.nguyenngoc@buymed.com' AND a.email_confirmed_at IS NOT NULL AND u.role = 'admin';   -- 1
-- 6) Đầu-cuối qua RLS như PostgREST (policy app_migrations_select_super) — kỳ vọng is_super = true, n > 0:
--    SET LOCAL ROLE authenticated;
--    SELECT set_config('request.jwt.claim.sub', '', true),
--           set_config('request.jwt.claims', json_build_object('sub', '24849449-1c56-42f3-9253-0935762c73f1', 'role', 'authenticated')::text, true);
--    SELECT public.is_super_admin() AS is_super, (SELECT count(*) FROM public.app_migrations) AS n;
--    (Sau rollback: is_super = false, n = 0.)
