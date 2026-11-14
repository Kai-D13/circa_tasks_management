-- ============================================================================
-- 127a_super_admin_add_tri_dao.sql
-- Chạy SAU 127 (và 119a). Ad hoc theo yêu cầu operator 14/11/2026: nâng
-- tri.dao@buymed.com (id d466d69d-9a9e-444c-a1f4-dbffa91d08f4) lên SUPER ADMIN.
-- Cùng mẫu 118a / 119a (+ nhánh role 'staff' của 113).
--
-- CÁCH CHẠY: Studio SQL editor, current_user = supabase_admin. DÁN NGUYÊN FILE,
-- không bôi chọn một đoạn (bôi riêng CREATE + INSERT là bỏ qua cả preflight lẫn
-- hậu kiểm); để role / impersonation mặc định. Lỗi hoặc timeout ⇒ KHÔNG Run lại
-- mù: kiểm marker '127a' và thân hàm (VERIFY cuối file) trước.
--
-- VÌ SAO VERSION '127a' (không phải số, như 118a / 119a): 130 đã dành cho
-- CMS-CALC-RET-2 (file đã ghim, preflight đòi '127' và chặn MỌI version SỐ > 127;
-- 128 / 129 là số đã bỏ, không tái dùng). Lấy '131' khiến 130 không chạy được.
-- '127a' không khớp ^[0-9]+$ nên preflight 130 (CASE WHEN version ~ '^[0-9]+$')
-- bỏ qua nó; tên file sort sau 127_ và trước 130_ (gate
-- e2e/super-admin-allowlist.spec.ts sort tên file, không đọc rollback/).
-- 130 chỉ GỌI public.is_super_admin(), không ghim thân hàm ⇒ không bị ảnh hưởng.
--
-- KHÔNG ĐỌC PROD TRƯỚC (quy tắc 09/10: Dev không tự chạy SQL prod) ⇒ preflight
-- fail-closed thay cho hồ sơ đọc trước:
--   - public.is_super_admin(): thân phải = nguyên văn 119a (12 email),
--     md5(replace(prosrc, E'\r', '')) = cc8b61fec311b288b2778132f39469fb (hậu kiểm
--     119a), thuộc tính + ACL = PROD_ACL (hồ sơ 01/11; PUBLIC / anon còn EXECUTE là
--     trạng thái đã biết — backlog HYG-1; anon nhận auth.uid() NULL ⇒ false). 120–127
--     không đụng hàm này. Lệch ⇒ RAISE, không đổi gì.
--   - public.users: đúng 1 dòng email này, đúng id. Role:
--       'admin'                       ⇒ KHÔNG UPDATE users (như 118a / 119a);
--       'staff' + store_id NULL        ⇒ UPDATE role = 'admin' (tài khoản Auth mới:
--                                       trigger on_auth_user_created sinh 'staff' — như 113);
--       khác (sm / store_manager / staff đã gán nhà thuốc) ⇒ RAISE (ngoài phạm vi:
--                                       kéo theo dữ liệu phụ — hỏi lại operator).
--     Role trước khi chạy ghi vào notes của marker ('role_before=…') để rollback trả đúng.
--   - auth.users: cùng id + email, đã xác nhận email (app đọc email từ JWT).
--
-- Thay đổi: thân hàm = nguyên văn 119a + 1 email ⇒ 13 email; (nếu staff) role ⇒ admin.
--   - KHÔNG GRANT/REVOKE: CREATE OR REPLACE giữ nguyên owner + ACL.
--   - KHÔNG đụng full_name / department_id / store_id.
--
-- Allowlist nằm ở HAI NƠI PHẢI SYNC (bài học 066/100):
--   1. DB : public.is_super_admin() — file này (RLS + RPC).
--   2. App: webapp/lib/authz.ts SUPER_ADMIN_EMAILS — commit CÙNG batch. Các
--      đường super của app kiểm email ở app rồi dùng supabaseAdmin (service
--      role, bỏ qua RLS) ⇒ CHỈ app quyết định các đường đó.
--   Cấp quyền: chạy file này (DB) → commit / push main → deploy app.
--
-- Không chạy lại được: marker '127a' đã có ⇒ RAISE. Mọi kiểm tra sai ⇒ RAISE
-- ⇒ rollback toàn bộ transaction, không nửa vời.
--
-- ROLLBACK / THU HỒI QUYỀN — PHẢI làm CẢ HAI bước, liền nhau:
--   (1) deploy app đã bỏ email khỏi authz.ts (chỉ bước này chặn các đường
--       service role); (2) chạy
--       supabase/migrations/rollback/127a_super_admin_add_tri_dao_rollback.sql
--       (thân hàm về nguyên văn 119a; role về đúng role_before; DELETE marker
--       '127a'). Thu hồi vì lý do bảo mật ⇒ deploy app TRƯỚC. Chỉ chạy rollback
--       DB KHÔNG thu hồi quyền.
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
  v_nostore boolean;
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION '127a: sai database (%), kỳ vọng postgres', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
    RAISE EXCEPTION '127a: phải chạy bằng superuser (Studio = supabase_admin), current_user = %', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '127') THEN
    RAISE EXCEPTION '127a: thiếu migration nền 127 — chạy đúng thứ tự';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '119a') THEN
    RAISE EXCEPTION '127a: thiếu migration nền 119a — chạy đúng thứ tự';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '127a') THEN
    RAISE EXCEPTION '127a: marker 127a đã có — migration đã chạy, KHÔNG chạy lại';
  END IF;
  -- Account public.users: đúng 1 dòng email, đúng id; role trong phạm vi.
  IF (SELECT count(*) FROM public.users WHERE lower(email) = 'tri.dao@buymed.com') <> 1 THEN
    RAISE EXCEPTION '127a: tri.dao@buymed.com phải có đúng 1 dòng public.users (đang có %)',
      (SELECT count(*) FROM public.users WHERE lower(email) = 'tri.dao@buymed.com');
  END IF;
  SELECT u.role, u.store_id IS NULL INTO v_role, v_nostore
    FROM public.users u
   WHERE u.id = 'd466d69d-9a9e-444c-a1f4-dbffa91d08f4' AND lower(u.email) = 'tri.dao@buymed.com';
  IF NOT FOUND THEN
    RAISE EXCEPTION '127a: dòng public.users của tri.dao@buymed.com không mang id d466d69d-… — DỪNG để đối chiếu';
  END IF;
  IF NOT (v_role = 'admin' OR (v_role = 'staff' AND v_nostore)) THEN
    RAISE EXCEPTION '127a: role hiện tại = % (store_id NULL: %) — ngoài phạm vi (chỉ nhận admin, hoặc staff chưa gán nhà thuốc); DỪNG, hỏi lại operator',
      v_role, v_nostore;
  END IF;
  PERFORM set_config('circa.m127a_role_before', v_role, true);
  -- App đọc email từ auth.users (JWT), hàm DB đọc public.users ⇒ hai bên phải cùng id + email, email đã xác nhận.
  IF NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = 'd466d69d-9a9e-444c-a1f4-dbffa91d08f4'
      AND lower(email) = 'tri.dao@buymed.com'
      AND email_confirmed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION '127a: auth.users không có đúng id + email tri.dao@buymed.com đã xác nhận';
  END IF;
  -- Hàm hiện tại phải ĐÚNG bản 119a (không drift): thân, thuộc tính, ACL.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'is_super_admin') <> 1 THEN
    RAISE EXCEPTION '127a: public.is_super_admin phải có đúng 1 overload';
  END IF;
  SELECT md5(replace(f.prosrc, E'\r', '')) AS src_md5, f.prosecdef, f.provolatile, f.proconfig::text AS cfg,
         pg_get_userbyid(f.proowner) AS owner, f.proacl::text AS acl, pg_get_function_result(f.oid) AS res
    INTO p FROM pg_proc f WHERE f.oid = 'public.is_super_admin()'::regprocedure;
  IF p.src_md5 <> 'cc8b61fec311b288b2778132f39469fb' THEN
    RAISE EXCEPTION '127a: thân is_super_admin() khác bản 119a (md5 %) — có thay đổi ngoài luồng, DỪNG để đối chiếu', p.src_md5;
  END IF;
  IF NOT p.prosecdef OR p.provolatile <> 's' OR p.cfg IS DISTINCT FROM '{search_path=public}' OR p.owner <> 'supabase_admin'
     OR p.res <> 'boolean' OR p.acl IS DISTINCT FROM PROD_ACL THEN
    RAISE EXCEPTION '127a: thuộc tính / ACL is_super_admin() khác hồ sơ 01/11 (secdef %, vol %, cfg %, owner %, acl %)',
      p.prosecdef, p.provolatile, p.cfg, p.owner, p.acl;
  END IF;
  RAISE NOTICE '127a: preflight đạt — role trước khi chạy = %', v_role;
END $$;

-- ── Role (chỉ nhánh staff chưa gán nhà thuốc; admin ⇒ 0 dòng). WHERE đầy đủ (pg_safeupdate). ──
UPDATE public.users
   SET role = 'admin'
 WHERE id = 'd466d69d-9a9e-444c-a1f4-dbffa91d08f4'
   AND lower(email) = 'tri.dao@buymed.com'
   AND role = 'staff'
   AND store_id IS NULL
   AND current_setting('circa.m127a_role_before') = 'staff';

-- ── Allowlist: nguyên văn 119a + 1 email ────────────────────────────────────
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
        'tri.dao@buymed.com'
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
    'nikhilesh.deshpande@buymed.com', 'dong.do@buymed.com', 'ha.nguyenngoc@buymed.com', 'tri.dao@buymed.com'];
  p record;
  u record;
  got boolean;
  n_admin int := 0;
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'is_super_admin') <> 1 THEN
    RAISE EXCEPTION '127a: hậu kiểm — is_super_admin phải còn đúng 1 overload';
  END IF;
  SELECT md5(replace(f.prosrc, E'\r', '')) AS src_md5, f.prosecdef, f.provolatile, f.proconfig::text AS cfg,
         pg_get_userbyid(f.proowner) AS owner, f.proacl::text AS acl, pg_get_function_result(f.oid) AS res
    INTO p FROM pg_proc f WHERE f.oid = 'public.is_super_admin()'::regprocedure;
  IF p.src_md5 <> '470f240068e93e26bda444045b3b388e' THEN
    RAISE EXCEPTION '127a: hậu kiểm — thân hàm mới sai (md5 %), có thể do dán thiếu / sửa file', p.src_md5;
  END IF;
  IF NOT p.prosecdef OR p.provolatile <> 's' OR p.cfg IS DISTINCT FROM '{search_path=public}' OR p.owner <> 'supabase_admin'
     OR p.res <> 'boolean' OR p.acl IS DISTINCT FROM PROD_ACL THEN
    RAISE EXCEPTION '127a: hậu kiểm — thuộc tính / ACL đổi (secdef %, vol %, cfg %, owner %, acl %)', p.prosecdef, p.provolatile, p.cfg, p.owner, p.acl;
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.is_super_admin()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.is_super_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION '127a: hậu kiểm — authenticated / service_role mất EXECUTE (RLS gọi hàm này)';
  END IF;
  -- Account: nay phải là admin (đúng 1 dòng).
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = 'd466d69d-9a9e-444c-a1f4-dbffa91d08f4'
                   AND lower(email) = 'tri.dao@buymed.com' AND role = 'admin') THEN
    RAISE EXCEPTION '127a: hậu kiểm — tri.dao@buymed.com chưa có role admin';
  END IF;
  -- Hành vi (giả lập JWT, chỉ trong transaction): xoá claims cấp phiên (impersonation Studio còn sót) để auth.uid() chỉ đọc claim.sub.
  PERFORM set_config('request.jwt.claims', '', true);
  -- Với MỌI user role admin, is_super_admin() = email thuộc allowlist 13.
  FOR u IN SELECT id, lower(email) AS em FROM public.users WHERE role = 'admin' LOOP
    PERFORM set_config('request.jwt.claim.sub', u.id::text, true);
    got := public.is_super_admin();
    IF got IS DISTINCT FROM (u.em = ANY (ALLOW)) THEN
      RAISE EXCEPTION '127a: hậu kiểm — is_super_admin() sai cho một admin (id %): %', u.id, got;
    END IF;
    n_admin := n_admin + 1;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', 'd466d69d-9a9e-444c-a1f4-dbffa91d08f4', true);
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION '127a: hậu kiểm — tri.dao@buymed.com chưa là super admin';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF public.is_super_admin() THEN
    RAISE EXCEPTION '127a: hậu kiểm — không có JWT mà is_super_admin() = true';
  END IF;
  RAISE NOTICE '127a: hậu kiểm đạt — % admin đối chiếu allowlist 13 email; role trước = %', n_admin, current_setting('circa.m127a_role_before');
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('127a', 'super_admin_add_tri_dao',
        'Ad hoc 14/11/2026: them tri.dao@buymed.com vao allowlist super (13 email).'
        || ' role_before=' || current_setting('circa.m127a_role_before') || '.'
        || ' Version khong phai so de khong chan preflight 130 (da danh so CMS-CALC-RET-2).'
        || ' App-layer mirror: webapp/lib/authz.ts SUPER_ADMIN_EMAILS cung batch; gate'
        || ' e2e/super-admin-allowlist.spec.ts doi hai ve trung tuyet doi.');

COMMIT;

-- ── VERIFY (chạy sau COMMIT, CHỈ ĐỌC — BEGIN READ ONLY … ROLLBACK) ──────────
-- 1) Marker: SELECT version, name, notes FROM public.app_migrations WHERE version = '127a';   -- 1 dòng, notes có role_before=admin|staff
--    SELECT string_agg(version, ',' ORDER BY version) FILTER (WHERE version !~ '^[0-9]+$') FROM public.app_migrations;  -- '118a,119a,127a'
-- 2) Hàm: SELECT md5(replace(prosrc, E'\r', '')), proacl::text, prosecdef, provolatile, proconfig, pg_get_userbyid(proowner)
--    FROM pg_proc WHERE oid = 'public.is_super_admin()'::regprocedure;
--    Kỳ vọng md5 = 470f240068e93e26bda444045b3b388e, ACL / thuộc tính như preflight.
-- 3) Ma trận quyền (AGENTS §4.2) — kỳ vọng 4 dòng true, như trước (anon = true theo HYG-1, không đổi):
--    SELECT r, has_function_privilege(r, 'public.is_super_admin()', 'EXECUTE')
--      FROM unnest(ARRAY['anon','authenticated','service_role','postgres']) r;
-- 4) Account auth ↔ public: SELECT count(*) FROM auth.users a JOIN public.users u ON u.id = a.id
--    WHERE a.id = 'd466d69d-9a9e-444c-a1f4-dbffa91d08f4' AND lower(a.email) = lower(u.email)
--      AND lower(u.email) = 'tri.dao@buymed.com' AND a.email_confirmed_at IS NOT NULL AND u.role = 'admin';   -- 1
-- 5) Đầu-cuối qua RLS như PostgREST (policy app_migrations_select_super) — kỳ vọng is_super = true, n > 0:
--    SET LOCAL ROLE authenticated;
--    SELECT set_config('request.jwt.claim.sub', '', true),
--           set_config('request.jwt.claims', json_build_object('sub', 'd466d69d-9a9e-444c-a1f4-dbffa91d08f4', 'role', 'authenticated')::text, true);
--    SELECT public.is_super_admin() AS is_super, (SELECT count(*) FROM public.app_migrations) AS n;
--    (Sau rollback: is_super = false, n = 0.)
