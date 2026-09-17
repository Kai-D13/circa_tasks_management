-- ============================================================================
-- 113_super_admin_add_nikhilesh.sql
-- Chạy SAU 112. (Số 113 ở đây là SỐ MIGRATION — không liên quan nhãn "batch
-- 113.x" trong commit của đợt thưởng thêm 112; đợt đó không có file migration 113.)
--
-- Nâng nikhilesh.deshpande@buymed.com (id 0e854fa3-0387-46b9-b187-834b005386b3)
-- lên SUPER ADMIN.
--
-- ⚠ KHÁC 109/110: account này MỚI chỉ được tạo ở Supabase Auth (2026-09-17).
-- Trigger on_auth_user_created (001) đã tự sinh dòng public.users nhưng với
-- role='staff' (raw_user_meta_data không có role). ĐÃ KIỂM bằng service role
-- 2026-09-17: role='staff', store_id NULL, department_id NULL, chưa đăng nhập
-- lần nào. Vì super admin = role 'admin' + email trong allowlist nên migration
-- này làm HAI việc, trong MỘT transaction:
--   (a) UPDATE public.users SET role='admin' cho đúng id + email này;
--   (b) thêm email vào allowlist của public.is_super_admin().
-- Thiếu (a) thì hàm vẫn trả false (điều kiện role nằm trong thân hàm).
--
-- Allowlist nằm ở HAI NƠI PHẢI SYNC (bài học 066/100):
--   1. DB : function public.is_super_admin() — file này.
--   2. App: webapp/lib/authz.ts SUPER_ADMIN_EMAILS — commit CÙNG batch.
-- Gate tự động e2e/super-admin-allowlist.spec.ts đọc migration MỚI NHẤT định
-- nghĩa hàm (tức file này) và đòi trùng tuyệt đối với authz.ts.
--
-- Thân hàm giữ NGUYÊN VĂN từ 110 (đã đối chiếu pg_get_functiondef trên prod
-- 2026-09-17: đúng 9 email của 110, không drift), chỉ THÊM đúng một email ⇒ 10.
--
-- KHÔNG đụng full_name/department_id/store_id (ngoài phạm vi yêu cầu). Các super
-- admin hiện có cũng store_id NULL, department_id NULL.
--
-- Idempotent: UPDATE có điều kiện role <> 'admin', CREATE OR REPLACE,
-- ON CONFLICT DO NOTHING.
--
-- ROLLBACK:
--   1) chạy lại CREATE OR REPLACE nguyên văn migration 110 (9 email);
--   2) UPDATE public.users SET role = 'staff'
--      WHERE id = '0e854fa3-0387-46b9-b187-834b005386b3'
--        AND lower(email) = 'nikhilesh.deshpande@buymed.com';
--   3) DELETE FROM public.app_migrations WHERE version = '113';
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '112') THEN
    RAISE EXCEPTION '113: thiếu migration nền 112 — chạy đúng thứ tự';
  END IF;
  -- Fail sớm nếu dòng public.users chưa có / sai email: thêm email vào allowlist
  -- mà không có account thì hàm vẫn trả false, dễ tưởng migration hỏng.
  -- Chỉ nhận role 'staff' (trạng thái trigger sinh ra) hoặc 'admin' (chạy lại).
  -- Nếu ai đó đã đổi sang 'sm'/'store_manager' thì DỪNG: các role đó kéo theo
  -- dữ liệu phụ (sm_store_assignments, store_id) không nên lật thẳng sang admin.
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = '0e854fa3-0387-46b9-b187-834b005386b3'
      AND lower(email) = 'nikhilesh.deshpande@buymed.com'
      AND role IN ('staff', 'admin')
  ) THEN
    RAISE EXCEPTION '113: account nikhilesh.deshpande@buymed.com phải tồn tại trong public.users với role staff hoặc admin';
  END IF;
END $$;

-- (a) role → admin. WHERE đầy đủ id + email (pg_safeupdate cũng đòi WHERE).
UPDATE public.users
SET role = 'admin'
WHERE id = '0e854fa3-0387-46b9-b187-834b005386b3'
  AND lower(email) = 'nikhilesh.deshpande@buymed.com'
  AND role <> 'admin';

-- (b) allowlist: nguyên văn 110 + 1 email.
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
        'nikhilesh.deshpande@buymed.com'
      )
      AND role = 'admin'
  )
$$;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

-- Hậu kiểm TRONG transaction: sai là RAISE ⇒ rollback toàn bộ, không nửa vời.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = '0e854fa3-0387-46b9-b187-834b005386b3'
      AND lower(email) = 'nikhilesh.deshpande@buymed.com'
      AND role = 'admin'
  ) THEN
    RAISE EXCEPTION '113: hậu kiểm thất bại — account chưa có role=admin';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('113', 'super_admin_add_nikhilesh',
        'Them nikhilesh.deshpande@buymed.com vao allowlist super (10 email).'
        || ' Account moi tao o Auth nen trigger sinh role=staff ⇒ migration nay'
        || ' UPDATE role=admin CUNG transaction. App-layer mirror:'
        || ' webapp/lib/authz.ts SUPER_ADMIN_EMAILS cap nhat cung batch; gate'
        || ' e2e/super-admin-allowlist.spec.ts doi hai ve trung tuyet doi.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ── VERIFY (chạy sau COMMIT) ────────────────────────────────────────────────
-- 1) Hàm có đủ 10 email + vẫn còn điều kiện role:
--    SELECT pg_get_functiondef(p.oid) FROM pg_proc p
--    JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public' AND p.proname='is_super_admin';
--    Kỳ vọng: chứa nikhilesh.deshpande@buymed.com, đủ 9 email cũ, "role = 'admin'".
--
-- 2) Account đúng trạng thái:
--    SELECT id, email, role FROM public.users
--    WHERE id = '0e854fa3-0387-46b9-b187-834b005386b3';
--    Kỳ vọng: 1 dòng, role = 'admin'.
--
-- 3) Marker: SELECT version, name FROM public.app_migrations WHERE version='113';
