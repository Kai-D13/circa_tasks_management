-- ============================================================
-- Migration 110: thêm super admin dinh.trinh@buymed.com
-- ============================================================
-- Nâng một account admin sẵn có lên super (id 1f004874-d23a-4e60-af34-add1e278829e,
-- role đã là 'admin' nên KHÔNG cần UPDATE public.users).
--
-- Allowlist super admin nằm ở HAI nơi PHẢI SYNC:
--   1. DB : function public.is_super_admin() — file này.
--   2. App: webapp/lib/authz.ts SUPER_ADMIN_EMAILS — commit cùng batch.
-- Từ batch trước đã có gate tự động e2e/super-admin-allowlist.spec.ts: nó đọc
-- migration MỚI NHẤT định nghĩa hàm này (tức file này) và đòi trùng tuyệt đối
-- với danh sách trong authz.ts ⇒ quên một vế là ĐỎ, không còn phụ thuộc trí nhớ.
--
-- Thân hàm TRÍCH TỰ ĐỘNG NGUYÊN VĂN từ 109, chỉ THÊM một email (script khẳng
-- định đủ 9 email và còn nguyên điều kiện role='admin' trước khi ghi file).
-- Idempotent (CREATE OR REPLACE + ON CONFLICT DO NOTHING).
--
-- ROLLBACK: chạy lại CREATE OR REPLACE nguyên văn từ migration 109 (8 email)
--   + DELETE FROM public.app_migrations WHERE version = '110';
-- ============================================================

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
        'dinh.trinh@buymed.com'
      )
      AND role = 'admin'
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('110', 'super_admin_add_dinh',
        'Them dinh.trinh@buymed.com vao allowlist super (9 email). Account da co role=admin nen khong doi bang users. App-layer mirror: webapp/lib/authz.ts cap nhat cung batch; gate e2e/super-admin-allowlist.spec.ts doi hai ve trung tuyet doi.')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify (chạy sau migration)
-- ============================================================
-- 1) Hàm có đủ 9 email và CÒN điều kiện role:
--    SELECT pg_get_functiondef(p.oid) FROM pg_proc p
--    JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public' AND p.proname='is_super_admin';
-- 2) Account đúng role:
--    SELECT id, email, role FROM public.users
--    WHERE id = '1f004874-d23a-4e60-af34-add1e278829e';   -- role = 'admin'
-- 3) SELECT version, name FROM public.app_migrations WHERE version='110';
