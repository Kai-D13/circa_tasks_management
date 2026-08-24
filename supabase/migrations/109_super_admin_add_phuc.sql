-- ============================================================================
-- 109_super_admin_add_phuc.sql
-- Chạy SAU 108.
--
-- Nâng phuc.nguyen@buymed.com (id 9d9fcf0b-840f-4c39-af77-126a0a503740) lên
-- SUPER ADMIN.
--
-- ⚠ Super admin = role 'admin' + email trong ALLOWLIST, và allowlist nằm ở HAI
-- NƠI PHẢI SYNC (bài học migration 066, lặp lại ở 100):
--   1. DB : function public.is_super_admin() — file này.
--   2. App: webapp/lib/authz.ts SUPER_ADMIN_EMAILS — commit CÙNG batch.
-- Thiếu một trong hai thì gate lệch: sửa được ở màn này nhưng bị RLS chặn ở màn
-- kia (hoặc ngược lại), và triệu chứng rất khó lần.
--
-- ĐÃ KIỂM TRƯỚC KHI VIẾT FILE NÀY: account đã có role='admin' (query bằng
-- service role, 2026-08-18) ⇒ KHÔNG cần UPDATE public.users. Nếu về sau role bị
-- đổi khác 'admin' thì function tự không nhận (điều kiện role nằm trong thân
-- hàm) — đó là hành vi đúng, không phải lỗi.
--
-- Thân hàm TRÍCH TỰ ĐỘNG NGUYÊN VĂN từ migration 100 (bản mới nhất định nghĩa
-- hàm này — 102/108 chỉ GỌI nó), chỉ THÊM đúng một email; script khẳng định
-- vẫn đủ 7 email cũ, tổng 8, và giữ nguyên điều kiện role='admin'.
--
-- ROLLBACK: chạy lại CREATE OR REPLACE nguyên văn migration 100 (7 email) +
--   DELETE FROM public.app_migrations WHERE version = '109';
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '108') THEN
    RAISE EXCEPTION '109: thiếu migration nền 108 — chạy đúng thứ tự';
  END IF;
  -- Fail sớm nếu account chưa tồn tại hoặc sai role: thêm email vào allowlist
  -- mà account không phải admin thì hàm vẫn trả false, dễ tưởng migration hỏng.
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = '9d9fcf0b-840f-4c39-af77-126a0a503740'
      AND lower(email) = 'phuc.nguyen@buymed.com'
      AND role = 'admin'
  ) THEN
    RAISE EXCEPTION '109: account phuc.nguyen@buymed.com phải tồn tại và có role=admin trước khi thêm vào allowlist';
  END IF;
END $$;

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
        'phuc.nguyen@buymed.com'
      )
      AND role = 'admin'
  )
$$;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('109', 'super_admin_add_phuc',
        'Them phuc.nguyen@buymed.com vao allowlist super (8 email). Account da co'
        || ' role=admin nen KHONG dung bang users. App-layer mirror:'
        || ' webapp/lib/authz.ts SUPER_ADMIN_EMAILS cap nhat cung batch — thieu mot'
        || ' trong hai noi la gate lech (bai hoc 066/100).')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ── VERIFY (chạy sau COMMIT) ────────────────────────────────────────────────
-- 1) Hàm có đủ 8 email + vẫn còn điều kiện role:
--    SELECT pg_get_functiondef(p.oid) FROM pg_proc p
--    JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public' AND p.proname='is_super_admin';
--    Kỳ vọng: chứa phuc.nguyen@buymed.com, đủ 7 email cũ, và "role = 'admin'".
--
-- 2) Account đúng trạng thái:
--    SELECT id, email, role FROM public.users
--    WHERE id = '9d9fcf0b-840f-4c39-af77-126a0a503740';
--    Kỳ vọng: 1 dòng, role = 'admin'.
--
-- 3) Marker: SELECT version, name FROM public.app_migrations WHERE version='109';
