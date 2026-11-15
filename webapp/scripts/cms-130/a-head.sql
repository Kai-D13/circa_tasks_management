-- ============================================================================
-- 130_cms_calculation_modes_returns.sql  (CANDIDATE — CMS-CALC-RET-2, Dev 13/11/2026; CHƯA audit PM, CHƯA commit, KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-130.mjs từ webapp/scripts/cms-130/*.sql + thân NGUYÊN VĂN các hàm thay (định nghĩa cuối trong
-- 120–126) + hằng hợp đồng TS (lib/cms/unitKey.ts, lib/cms/calc/fp.ts, lib/cms/calc/returns.ts). KHÔNG sửa file này bằng tay —
-- `node scripts/gen-cms-130.mjs --check` phát hiện lệch.
-- Số 130 = số PM dành trong khối Hiện trạng sống STATE (13/11), predecessor THỰC 127 (cms_t11_flat_amounts); 128 / 129 bỏ, không tái
-- dùng, không marker giả. Nguồn: planning/research/cms-calc-ret2-dev-design-r2-2026-11-13.md (thiết kế r2 + §14 r2.1) + review PM
-- planning/reviews/2026-11-13-cms-calc-ret2-p2-r2-p1-r11-pm.md (RET2-R2-01…04) + db-reviewer / security-reviewer nội bộ 14/11.
--
-- Nội dung (đủ mọi lát của candidate):
--   L1. Helper hợp đồng (chỉ owner): cms__src_clean, cms__unit_key (cms-unit-key-v2), cms__qty_dec, cms__return_status_effect
--       (cms-return-status-v1), cms__return_fp (cms-return-fp-v1, sha256 tuple tiền tố độ dài byte UTF-8).
--   L2. Chương trình: quantity_basis / returns_policy + actor (backfill ADD COLUMN DEFAULT, không UPDATE); trigger tương thích
--       cms__programs_basis_guard / cms__products_basis_guard; rpc_cms_program_save_v2, rpc_cms_program_set_returns_policy;
--       rpc_cms_capabilities suy từ catalog (RPC + EXECUTE đúng vai trò + hàm nội bộ + cột).
--   L3. Run contract: cột run / lớp nguồn _src / cms_return_lines / cms_result_events; open / stage / seal_begin / seal 13 bước (N1–N10)
--       / cleanup / snapshot vá rẽ nhánh contract (nhánh legacy giữ nguyên văn).
--   L4. Sổ trả hàng (D14): eval_seq dưới khoá + sàn as_of (cms__as_of_floor), baseline bất biến run XOR báo cáo, conflict / observation /
--       phục hồi chỉ INSERT, publish atomic, confirm phục hồi theo chương trình (authenticated, super).
--   L5. Reader v2 (header / rows / events / excluded / returns / conflicts); reader 122 chặn run contract.
--   L6. Báo cáo trả sau chốt (D11): save service_role (DB suy disposition từ dòng bán đóng băng), reader super, dòng bán đóng băng.
--   L7. Chốt / attest: chặn run contract, con trỏ legacy lệch chế độ, conflict mở.
--
-- Triển khai (runbook — chỉ khi PM cho): app flag-OFF trước; khoá ACCESS EXCLUSIVE các bảng CMS chính tới COMMIT (thời gian ngắn).
-- READ COMMITTED. Chạy bằng ĐÚNG role owner bảng / hàm CMS. Dán NGUYÊN FILE, nên giữ LF (md5 thân hàm bỏ \r).
-- ROLLBACK: rollback/130_cms_calculation_modes_returns_rollback.sql — dừng nếu đã có dữ liệu chế độ mới (chương trình admin /
-- pending / cms_unit / net_returns_v1); gồm DELETE FROM app_migrations WHERE version = '130'.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
-- Khoá TRƯỚC preflight, thứ tự cố định (cùng chiều các RPC: chương trình → cấu hình → run → dữ liệu run).
LOCK TABLE public.cms_programs, public.cms_program_products, public.cms_payouts, public.cms_sync_runs, public.cms_sync_run_chunks,
           public.cms_sales_source_lines, public.cms_sales_lines, public.cms_results IN ACCESS EXCLUSIVE MODE;

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_name text;
  v_acl  text;
  r      record;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '130: cần READ COMMITTED';
  END IF;
  -- PM 13/11 RET2-R2-04: UNIQUE NULLS NOT DISTINCT (chuỗi conflict) cần PG15 (120 cms_sync_runs_one_running đã dùng ⇒ nền chạy 120 là ≥ 15);
  -- extract(epoch) trả numeric từ PG14 (financial_fp). Không nới xuống PG14.
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION '130: cần PostgreSQL ≥ 15 (UNIQUE NULLS NOT DISTINCT; extract numeric), có %', current_setting('server_version');
  END IF;
  IF pg_catalog.pg_encoding_to_char((SELECT encoding FROM pg_catalog.pg_database WHERE datname = current_database())) <> 'UTF8' THEN
    RAISE EXCEPTION '130: database phải UTF8 (độ dài byte / thứ tự byte của hợp đồng)';
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '127';
  IF v_name IS DISTINCT FROM 'cms_t11_flat_amounts' THEN
    RAISE EXCEPTION '130: thiếu migration nền 127 cms_t11_flat_amounts (name = %)', v_name;
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '130';
  IF FOUND THEN
    RAISE EXCEPTION '130: đã có marker 130 (name = %) — không chạy lại / không chạy chồng', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 127) THEN
    RAISE EXCEPTION '130: DB đã có migration số > 127 (128 / 129 bỏ — không được có marker) — dừng';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r0 WHERE r0.rolname = current_user AND (r0.rolsuper OR r0.rolbypassrls)) THEN
    RAISE EXCEPTION '130: role chạy migration (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname LIKE 'cms\_%'
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '130: owner bảng / hàm CMS khác role chạy (%)', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE status = 'running') THEN
    RAISE EXCEPTION '130: còn run đang chạy (status running) — chờ kết thúc / STALE rồi chạy lại';
  END IF;
  -- Nền 126: cổng kết quả bán mở; policy chốt thật vẫn đóng (130 không mở chốt / chi trả thật).
  IF public.cms__results_release_open() IS DISTINCT FROM true THEN
    RAISE EXCEPTION '130: cổng cms__results_release_open() khác true (nền 126)';
  END IF;
  IF (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION '130: cms__lock_policy().real.ready khác false';
  END IF;
  -- Chưa có đối tượng 130 (không chạy chồng sau rollback dở).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
              WHERE attrelid = 'public.cms_programs'::regclass AND attname IN ('quantity_basis', 'returns_policy') AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (@@NEW_NAMES@@)) THEN
    RAISE EXCEPTION '130: đã có cột / hàm của 130 — DB không ở trạng thái nền 127';
  END IF;
  -- ACL nền của hàm sắp thay (OR REPLACE giữ ACL — phải đúng ma trận trước khi thay).
  FOR r IN SELECT x.sig, x.want FROM (VALUES @@REPLACED_ACL_VALUES@@) AS x(sig, want) LOOP
    SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ','
                      ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END)
      INTO v_acl FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE p.oid = to_regprocedure('public.' || r.sig) AND a.grantee <> p.proowner;
    IF to_regprocedure('public.' || r.sig) IS NULL OR v_acl IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION '130: ACL nền % khác % (có %)', r.sig, COALESCE(r.want, 'chỉ owner'), COALESCE(v_acl, 'chỉ owner');
    END IF;
  END LOOP;
  -- Ràng buộc 130 sẽ thay phải có đúng tên (định nghĩa đầy đủ ghim bằng file SQL chỉ đọc trước cửa sổ).
  IF (SELECT count(*) FROM pg_catalog.pg_constraint
       WHERE contype = 'c' AND ((conrelid = 'public.cms_sync_runs'::regclass AND conname IN ('cms_sync_runs_seal_step_check', 'cms_sync_runs_sales_publish'))
                                OR (conrelid = 'public.cms_sync_run_chunks'::regclass AND conname = 'cms_sync_run_chunks_part_check'))) <> 3 THEN
    RAISE EXCEPTION '130: thiếu một trong 3 ràng buộc sẽ thay (seal_step_check / sales_publish / part_check)';
  END IF;
END $$;
-- Thân hàm sắp thay + hàm nền 130 dựa vào phải đúng nguyên văn bản cuối 120–127 — khối sinh bởi gen-cms-130.mjs.
-- @@PREFLIGHT_MD5@@

-- Inventory (chỉ số đếm; không PII) — NOTICE + ghi vào notes marker.
DO $$
BEGIN
  PERFORM set_config('cms130.inventory', jsonb_build_object(
    'programs', (SELECT count(*) FROM public.cms_programs),
    'programs_real', (SELECT count(*) FROM public.cms_programs WHERE NOT is_test),
    'programs_draft', (SELECT count(*) FROM public.cms_programs WHERE status = 'draft'),
    'programs_locked', (SELECT count(*) FROM public.cms_programs WHERE status = 'locked'),
    'sales_runs', (SELECT count(*) FROM public.cms_sync_runs WHERE kind = 'sales'),
    'payouts', (SELECT count(*) FROM public.cms_payouts))::text, true);
  RAISE NOTICE '130 inventory: %', current_setting('cms130.inventory');
END $$;
