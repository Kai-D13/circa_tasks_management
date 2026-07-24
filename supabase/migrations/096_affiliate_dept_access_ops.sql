-- ============================================================================
-- 096_affiliate_dept_access_ops.sql — P3-I.2: grant Affiliate cho phòng OPS
-- ⚠ DRAFT — CHƯA CHẠY cho tới khi stakeholder audit pass.
--
-- Bối cảnh (user chốt 24/07): màn tổng hợp /targets/campaigns/affiliate mở
-- thêm cho Admin phòng OPS (toàn bộ OS — FS/external vẫn CHỈ super, đúng
-- thiết kế 090), SM (store OS được phân công), Store Manager (store mình).
-- Staff KHÔNG (giữ quyết định cũ). Bảng affiliate_department_access (090) được
-- thiết kế sẵn cho grant này — hiện RỖNG; version hóa INSERT tại đây thay vì
-- SQL tay (bài học 094: mọi thay đổi DB phải tái tạo được từ source).
--
-- r1.2a (audit P1 — user xác nhận 24/07): Admin OPS CHỈ ĐƯỢC XEM AGGREGATE,
-- TUYỆT ĐỐI KHÔNG đọc raw order (customer_name/customer_phone = PII). Grant B
-- nếu giữ nguyên 090 sẽ đồng thời kích hoạt nhánh admin-dept của
-- aff_orders_select → mở PostgREST đọc raw đơn. Vì vậy mục D REDEFINE
-- aff_orders_select BỎ nhánh admin-department (các nhánh khác copy NGUYÊN VĂN
-- từ 090 — contract cũ của super/sm/own-store GIỮ NGUYÊN; nhánh dept trước
-- nay INERT vì bảng access rỗng → bỏ không đổi hành vi hiện hữu).
--
-- Nội dung:
--   A. Preflight: đủ migration nền 090..095; dept đúng id + tên 'OPS'.
--   B. INSERT affiliate_department_access cho dept OPS (idempotent) — để
--      route/sidebar nhận diện quyền màn tổng hợp.
--   C. Policy MỚI apm_select_dept_admin: admin phòng được cấp quyền đọc
--      mapping os + active (để màn tổng hợp lấy danh sách store qua session
--      client — storeIds cho RPC aggregate derive TỪ rows RLS cho thấy).
--      FS + external mapping vẫn chỉ super (apm_select_super).
--   D. REDEFINE aff_orders_select: BỎ nhánh admin-dept (OPS không raw/PII);
--      rpc_aggregate_affiliate_gmv GIỮ service_role-only (092) — page gọi
--      sau gate với storeIds từ RLS.
--
-- Idempotent: re-run = no-op. ROLLBACK: DELETE FROM affiliate_department_access
-- WHERE department_id='1b362298-…'; DROP POLICY apm_select_dept_admin;
-- DELETE app_migrations '096'.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_ops constant uuid := '1b362298-7121-4604-9192-4a9ca2bb545f';
  v_name text;
BEGIN
  -- ── A. Preflight ──
  IF (SELECT count(*) FROM public.app_migrations
      WHERE version IN ('090','091','092','093','094','095')) <> 6 THEN
    RAISE EXCEPTION '096: thiếu migration nền — cần đủ 090..095 đã chạy (hiện có: %)',
      (SELECT string_agg(version, ',' ORDER BY version) FROM public.app_migrations
       WHERE version IN ('090','091','092','093','094','095'));
  END IF;

  SELECT name INTO v_name FROM public.departments WHERE id = v_ops;
  IF v_name IS NULL THEN
    RAISE EXCEPTION '096: department % không tồn tại', v_ops;
  END IF;
  IF v_name IS DISTINCT FROM 'OPS' THEN
    RAISE EXCEPTION '096: department % có tên "%" — kỳ vọng "OPS", kiểm tra lại id', v_ops, v_name;
  END IF;

  -- ── B. Grant (insert-if-absent — PK department_id) ──
  IF NOT EXISTS (SELECT 1 FROM public.affiliate_department_access WHERE department_id = v_ops) THEN
    INSERT INTO public.affiliate_department_access (department_id) VALUES (v_ops);
  END IF;
END $$;

-- ── C. RLS: admin phòng được cấp quyền đọc mapping os active ────────────────
-- is_affiliate_dept_admin() (090, SECDEF) tự xác nhận role admin + membership;
-- vẫn check get_user_role() ngoài policy (phòng thủ kép — pattern 090).
-- CHỈ os + active + store_id NOT NULL: FS/external/inactive vẫn chỉ super.
DROP POLICY IF EXISTS apm_select_dept_admin ON public.affiliate_partner_mappings;
CREATE POLICY apm_select_dept_admin ON public.affiliate_partner_mappings
  FOR SELECT TO authenticated
  USING (
    (SELECT public.get_user_role()) = 'admin'
    AND (SELECT public.is_affiliate_dept_admin())
    AND partner_type = 'os'
    AND is_active = true
    AND store_id IS NOT NULL
  );

-- ── D. r1.2a (audit P1): aff_orders_select BỎ nhánh admin-department ────────
-- Admin OPS chỉ aggregate — KHÔNG raw order/PII. Các nhánh còn lại COPY
-- NGUYÊN VĂN từ 090 (super / sm / staff+store_manager own-store): sót hoặc
-- sửa 1 nhánh = mất quyền hợp lệ hoặc rò rỉ — chỉ XÓA đúng nhánh dept.
DROP POLICY IF EXISTS aff_orders_select ON public.affiliate_orders;
CREATE POLICY aff_orders_select ON public.affiliate_orders
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_super_admin())
    OR (
      (SELECT public.get_user_role()) = 'sm'
      AND public.is_sm_for_store(store_id)
      AND public.is_os_store(store_id)
    )
    OR (
      (SELECT public.get_user_role()) IN ('staff','store_manager')
      AND store_id = (SELECT public.get_user_store_id())
      AND public.is_os_store(store_id)
    )
  );

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('096', 'affiliate_dept_access_ops',
        'P3-I.2 r1.2a: grant Affiliate cho phòng OPS (1b362298 — preflight id + tên) qua affiliate_department_access (insert-if-absent) + policy apm_select_dept_admin (admin phòng được cấp quyền đọc mapping os+active; FS/external/inactive vẫn chỉ super) + REDEFINE aff_orders_select BỎ nhánh admin-department (user xác nhận 24/07: OPS CHỈ aggregate, không raw order/PII — các nhánh super/sm/own-store copy nguyên văn 090; nhánh dept trước nay inert). rpc_aggregate giữ service_role-only.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau 096):
-- 1) SELECT d.name, a.granted_at FROM public.affiliate_department_access a
--      JOIN public.departments d ON d.id = a.department_id;   -- 1 row: OPS
-- 2) SELECT policyname FROM pg_policies
--      WHERE tablename='affiliate_partner_mappings' ORDER BY 1;
--    -- 3 policy: apm_select_dept_admin · apm_select_store_qr · apm_select_super
-- 3) r1.2a — aff_orders_select KHÔNG còn nhánh dept:
--    SELECT qual FROM pg_policies
--      WHERE tablename='affiliate_orders' AND policyname='aff_orders_select';
--    -- qual KHÔNG chứa 'is_affiliate_dept_admin'; đủ 3 nhánh:
--    --   is_super_admin · sm/is_sm_for_store · staff+store_manager own-store
-- 4) rpc_aggregate vẫn service_role-only (không cấp thêm cho authenticated):
--    SELECT has_function_privilege('authenticated',
--      'public.rpc_aggregate_affiliate_gmv(uuid[],timestamptz,timestamptz)',
--      'EXECUTE');                                            -- false
-- 5) SELECT version FROM public.app_migrations WHERE version='096';  -- 1 row
--
-- QA RLS (PostgREST, token từng role — đổi account nhớ logout/incognito):
--   GET /rest/v1/affiliate_partner_mappings?select=partner_code
--   · Admin phòng OPS       → 25 rows (toàn bộ os active; KHÔNG thấy fs/external)
--   · Admin phòng khác      → 0 row
--   · Super admin           → 34 rows (đủ os+fs+external)
--   GET /rest/v1/affiliate_orders?select=customer_name,customer_phone&limit=5
--   · Admin phòng OPS       → 0 row (r1.2a — KHÔNG raw order/PII)
--   · Admin phòng khác      → 0 row
--   · Super admin           → có rows (contract cũ giữ nguyên)
--   · SM / QLCH / Staff OS  → chỉ rows store scope mình (contract 090 giữ nguyên)
-- ============================================================================
