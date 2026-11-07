-- ============================================================================
-- 126_cms_sales_only_results_release.sql  (r1 — CMS sales-only, Dev 06/11/2026; CHƯA audit PM, CHƯA commit, KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-126.mjs từ webapp/scripts/cms-126/*.sql + thân 2 hàm 122 NGUYÊN VĂN (chỉ chèn / thay đúng các đoạn
-- ghi trong generator). KHÔNG sửa file này bằng tay — `node scripts/gen-cms-126.mjs --check` phát hiện lệch.
-- Số 126 = số PM dành trong khối Hiện trạng sống STATE (06/11, đổi phạm vi sales-only), preflight 125. Chuỗi phát hành 121 → 122 →
-- 123 → 124 → 125 → 126. KHÔNG dùng 126 để mở hợp đồng trả hàng hoặc chốt / chi trả thật.
-- Nguồn: planning/research/cms-sales-only-phase-spec-plan-2026-11-06.md §5 + planning/reviews/2026-11-06-cms-phase-scope-pm.md.
--
-- Mục đích: TÁCH cổng công bố kết quả BÁN tạm tính khỏi tính năng trả hàng (Q-206 — phase sau). Chương trình thật được công bố CMS
-- tạm tính tính từ các dòng bán đủ điều kiện nguồn BI hiện cung cấp; dòng điều chỉnh / âm vẫn KHÔNG được công bố.
--
-- Thay đổi (chỉ 2 hàm, CREATE OR REPLACE giữ chữ ký / owner / SECURITY DEFINER / search_path; không bảng / cột / trigger / RLS mới):
--   1. cms__results_release_open() (122): false → true. Vẫn IMMUTABLE SECURITY DEFINER, CHỈ owner (không cấp anon / authenticated /
--      service_role). Hàm này là cổng DB của publish (122) và một blocker của cms__lock_eval (124) — sau 126 chương trình thật không
--      còn blocker CMS_LOCK_RELEASE_GATE nhưng VẪN bị policy chặn (cms__lock_policy().real.ready = false — 126 không sửa policy /
--      payout / RLS).
--   2. rpc_cms_sales_run_publish(uuid) (122): thêm nhánh held RETURNS_NOT_SUPPORTED_THIS_PHASE cho chương trình thật khi dữ liệu ĐÃ
--      SEAL có điều chỉnh: seal_expect.totals.adjustment_lines ≠ 0 (seal bước 10 đối chiếu = số dòng kết quả ADJUSTMENT; S12 ép
--      ADJUSTMENT ⇔ dòng INCLUDED âm) HOẶC có dòng ứng viên không INCLUDED (chưa gán / ngoài phạm vi) lượng hoặc GMV âm đã stage.
--      Thiếu / sai định dạng totals ⇒ coi như có điều chỉnh (fail-closed). Không tin p_detail / tham số caller. Đóng dấu run công bố
--      chương trình thật: detail.results_basis = 'sales_only_v1', detail.results_gate = '126' (DB quyết định, trong transaction
--      publish; không đổi seal / vân tay dòng 14 trường; run QA giữ nguyên như 122). Giữ thứ tự khoá chương trình → run, kiểm lại
--      STALE / LOCKED / NOT_ACTIVE / CONFIG / MAPPING / cổng, nhánh idempotent 'already', lock_timeout 5s, ACL service_role.
--   Chương trình QA (is_test) không đổi hành vi (fixture điều chỉnh vẫn công bố trong namespace test).
--
-- Triển khai (runbook): sau 125, trong cửa sổ phát hành gộp; app candidate có releaseGate SALES_ONLY_V1. Khoá cms_sync_runs SHARE
-- ⇒ không mở / stage / publish run mới tới COMMIT; run đang chạy (nếu có) publish sau COMMIT đi qua thân mới. READ COMMITTED.
-- POST: `node scripts/cms-verify.mjs post --phase=126 --pre=<PRE chụp NGAY TRƯỚC 126>`. Sau 126, cms-verify phase 125 ĐỎ đúng
-- thiết kế (md5 2 hàm thay + cổng mở) ⇒ phase 126.
-- ROLLBACK: rollback/126_cms_sales_only_results_release_rollback.sql — khôi phục NGUYÊN VĂN 2 hàm 122 + ACL, xoá marker 126; KHÔNG xoá
-- run / snapshot đã công bố (pointer giữ nguyên). Vận hành: tắt CMS_EARNINGS_ENABLED trước, rồi mới rollback cổng nếu cần; ưu tiên
-- xử lý tiến. Có run bán THẬT thì đường rollback 122 vẫn bị guard cũ chặn (không nới). Gồm DELETE FROM app_migrations WHERE
-- version = '126'.
-- Vận hành: DÁN NGUYÊN FILE, nên GIỮ LF (md5 thân hàm bỏ \r — cùng công thức VERIFY md5(replace(prosrc, E'\r', ''))). Chạy bằng ĐÚNG
-- role owner bảng / hàm CMS (như 121–125).
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
-- Khoá TRƯỚC preflight: cms_sync_runs SHARE ⇒ không mở / stage / seal / publish run mới xen giữa (publish / seal ghi bảng run). Không
-- khoá bảng chương trình / cấu hình (126 không ghi dữ liệu).
LOCK TABLE public.cms_sync_runs IN SHARE MODE;

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_name text;
  v_acl  text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '126: cần READ COMMITTED';
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '125';
  IF v_name IS DISTINCT FROM 'cms_uncapped_last_tier' THEN
    RAISE EXCEPTION '126: thiếu migration nền 125 cms_uncapped_last_tier (name = %)', v_name;
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '126';
  IF FOUND THEN
    RAISE EXCEPTION '126: đã có marker 126 (name = %) — không chạy lại / không chạy chồng', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 125) THEN
    RAISE EXCEPTION '126: DB đã có migration số > 125 — dừng';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION '126: role chạy migration (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_programs'::regclass, 'public.cms_sync_runs'::regclass, 'public.cms_sales_lines'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '126: owner bảng / hàm CMS khác role chạy (%)', current_user;
  END IF;
  -- Nền 122 / 123 / 125: cổng DB đang đóng, policy chốt thật chưa sẵn sàng.
  IF public.cms__results_release_open() IS DISTINCT FROM false THEN
    RAISE EXCEPTION '126: cổng cms__results_release_open() không ở trạng thái đóng của 122 — dừng, đối chiếu tay';
  END IF;
  IF (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION '126: cms__lock_policy().real.ready khác false — 126 không áp lên policy chốt thật đã mở';
  END IF;
  -- ACL nền: helper chỉ owner; publish chỉ service_role.
  SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ',')
    INTO v_acl FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
   WHERE p.oid = 'public.cms__results_release_open()'::regprocedure AND x.grantee <> p.proowner;
  IF v_acl IS NOT NULL THEN RAISE EXCEPTION '126: ACL nền cms__results_release_open() có grant ngoài owner (%)', v_acl; END IF;
  SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ',')
    INTO v_acl FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
   WHERE p.oid = 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure AND x.grantee <> p.proowner;
  IF v_acl IS DISTINCT FROM 'service_role:EXECUTE' THEN
    RAISE EXCEPTION '126: ACL nền rpc_cms_sales_run_publish(uuid) khác service_role:EXECUTE (%)', v_acl;
  END IF;
END $$;
-- Thân 2 hàm sắp thay phải đúng nguyên văn 122 — khối sinh bởi gen-cms-126.mjs.
-- @@PREFLIGHT_MD5@@

-- Inventory (chỉ số đếm; không PII) — NOTICE + ghi vào notes marker.
DO $$
BEGIN
  PERFORM set_config('cms126.inventory', jsonb_build_object(
    'programs_real', (SELECT count(*) FROM public.cms_programs WHERE NOT is_test),
    'programs_real_active', (SELECT count(*) FROM public.cms_programs WHERE NOT is_test AND status = 'active'),
    'sales_runs_real_published', (SELECT count(*) FROM public.cms_sync_runs WHERE kind = 'sales' AND NOT is_test AND published_at IS NOT NULL),
    'sales_runs_running', (SELECT count(*) FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running'))::text, true);
  RAISE NOTICE '126 inventory: %', current_setting('cms126.inventory');
END $$;
