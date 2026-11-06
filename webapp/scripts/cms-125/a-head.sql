-- ============================================================================
-- 125_cms_uncapped_last_tier.sql  (r1 — CMS-UNCAPPED-1, Dev 05/11/2026; CHƯA audit PM, CHƯA commit, KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-125.mjs từ webapp/scripts/cms-125/*.sql + thân 2 RPC 121 NGUYÊN VĂN (chỉ chèn đúng các đoạn
-- ghi trong generator). KHÔNG sửa file này bằng tay — `node scripts/gen-cms-125.mjs --check` phát hiện lệch.
-- Số 125 = số PM dành trong khối Hiện trạng sống STATE (05/11, CMS-Q-220), preflight 124. Chuỗi phát hành 121 → 122 → 123 → 124 →
-- 125 → cổng Q-206 (chưa phân số).
--
-- Mục đích (CMS-Q-220 — stakeholder 05/11, THAY Q-210a): bỏ TRẦN số lượng hưởng CMS. Bậc cuối của mọi cấu hình tính mới KHÔNG giới
-- hạn (qty_to NULL); vẫn lũy tiến từng bậc, bậc trung gian giữ cận trên. KHÔNG đổi công thức tiền / seal SQL 122 (đã hỗ trợ qty_to
-- NULL: S7 / S8 / S14 so cap_quantity với cận cuối của cấu hình ⇒ cuối NULL ⇒ cap NULL), schema run / BI 14 trường / vân tay nguồn /
-- quyền người xem. Không drop cột cap_quantity / at_cap hay trạng thái AT_CAP (đọc run lịch sử đã đóng băng).
--
-- Thay đổi:
--   1. CREATE OR REPLACE rpc_cms_import_commit (121, giữ chữ ký / ACL service_role / lock_timeout 5s / khoá): sau MỌI kiểm kiểu /
--      range / liên tục / payload cũ (payload hỏng vẫn CMS_IMPORT_BAD_TIERS / BAD_PAYLOAD), bậc CUỐI mỗi SP phải "to": null ⇒ khác ⇒
--      CMS_IMPORT_TIER_LAST_FINITE (22023). Kiểm TRƯỚC khi lấy khoá danh mục (không đổi thứ tự khoá 121).
--   2. CREATE OR REPLACE rpc_cms_program_activate (121): mọi SP phải có thang bậc hợp lệ (bắt đầu 1, liên tục theo tier_order, chỉ bậc
--      cuối mở) ⇒ CMS_PROGRAM_TIERS_INVALID; bậc cuối hữu hạn (cấu hình chưa chuyển đổi) ⇒ CMS_PROGRAM_TIER_LAST_FINITE (P0001).
--   3. Guard DB cuối transaction: constraint trigger cms_tiers_last_open — AFTER INSERT OR UPDATE OR DELETE ON cms_program_tiers,
--      DEFERRABLE INITIALLY DEFERRED, FOR EACH ROW, ENABLE ALWAYS — gọi cms__tiers_last_open_guard() (SECURITY DEFINER, không cấp
--      ai): với program_product_id của OLD / NEW (UPDATE đổi SP ⇒ kiểm cả hai), nếu SP còn bậc thì bậc tier_order lớn nhất (index PK
--      (program_product_id, tier_order), không quét chương trình) phải qty_to NULL ⇒ khác ⇒ CMS_TIER_LAST_FINITE (23514). SP đã xoá
--      hết bậc (replace) ⇒ không kiểm id cũ. Import nhiều dòng / replace không bị chặn giữa chừng; transaction kết thúc không thể để lại
--      trần. Không thay kiểm liên tục / kiểu của RPC; KHÔNG lấy khoá (chỉ đọc) ⇒ không đổi thứ tự khoá 121 / 123.
--   4. Chuyển đổi dữ liệu CHƯA CHỐT (status draft / active) có bậc cuối hữu hạn — trong cùng transaction, sau khi khoá dòng chương
--      trình theo thứ tự id: qty_to bậc cuối → NULL (bậc trước / mức tiền giữ nguyên); config_version + 1 ĐÚNG MỘT lần mỗi chương
--      trình bị đổi; current_result_run_id → NULL (không để UI / export đọc tiền theo trần cũ như tiền hiện hành — app hiện "Chưa có
--      số liệu sau thay đổi cấu hình" tới khi tính lại, không 0₫ giả); updated_at = now(), updated_by = NULL (thao tác hệ thống — không
--      gán uid / email giả làm người thao tác); số đếm ghi vào notes marker.
--      Trigger pointer 122 (cms_programs_result_guard) cấm đặt pointer NULL ⇒ tắt TẠM chỉ quanh MỘT câu UPDATE rồi bật lại (ENABLE =
--      chế độ origin như 122 tạo); preflight kiểm thân + chế độ đúng 122, hậu kiểm kiểm lại. Đang giữ SHARE ROW EXCLUSIVE bảng
--      chương trình từ đầu migration ⇒ không phiên nào ghi xen giữa.
--      KHÔNG xoá run / chứng nhận / sổ. Run / preview / chứng nhận cũ không áp sang cấu hình mới: preview lệch config_version ⇒
--      CMS_IMPORT_CONFLICT; run cũ không còn là run hiện hành ⇒ không chốt / không chứng nhận; publish run mở trước đó ⇒ CONFIG_CHANGED.
--      Chương trình vốn cuối NULL: không tăng version, không đụng pointer (tiền đã đúng). 'locked': KHÔNG sửa / unlock / reseal (run
--      QA đóng băng giữ nguyên byte / tiền, ẩn theo marker như trước).
--   Dừng (fail-closed, không đổi gì): chương trình THẬT (is_test = false) có bậc cuối hữu hạn mà đã chốt / có payout / có run bán đã
--   công bố ⇒ trình PM trước khi đổi tài chính (không hồi tố tự động); còn run bán 'running'; thân hàm / trigger nền lệch bản duyệt;
--   marker / owner / isolation sai.
--
-- Triển khai: app candidate (cờ CMS OFF) → 125 khi cờ CMS sync / cron ghi CMS tạm dừng, không run bán 'running' (khoá bảng run SHARE ⇒
-- không mở / stage / publish run mới tới COMMIT) → POST `cms-verify post --phase=125` → resync chương trình bị đổi (version mới) TRƯỚC
-- khi hiển thị số mới. READ COMMITTED bắt buộc (như 123 / 124). Sau 125, cms-verify phase 124 ĐỎ phase-match đúng thiết kế ⇒ phase 125.
-- ROLLBACK: rollback/125_cms_uncapped_last_tier_rollback.sql — khôi phục NGUYÊN VĂN 2 RPC 121 + ACL, gỡ guard + helper, xoá marker;
-- KHÔNG tái áp cận hữu hạn, không giảm config_version, không phục hồi pointer (NULL là cấu hình hợp lệ với code cũ). Gồm
-- DELETE FROM app_migrations WHERE version = '125'.
-- Vận hành: DÁN NGUYÊN FILE, nên GIỮ LF (md5 thân hàm bỏ \r — cùng công thức VERIFY md5(replace(prosrc, E'\r', ''))). Chạy bằng ĐÚNG
-- role owner bảng / hàm CMS (như 121–124).
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
-- Khoá TRƯỚC preflight (như 124), theo thứ tự cố định, không nâng khoá giữa chừng; bận ⇒ hết lock_timeout, cả migration rollback sạch:
--   · cms_sync_runs SHARE ⇒ không mở / stage / publish run mới;
--   · cms_programs EXCLUSIVE (db-reviewer 125 P2-1) ⇒ chặn cả SELECT … FOR UPDATE / FOR SHARE MỚI (ROW SHARE) của RPC 121 / 122 / 123 /
--     124 — phiên nào ĐANG giữ khoá dòng chương trình thì migration chờ ở đây rồi dừng theo lock_timeout (không deadlock ở §3); SELECT
--     thường vẫn đọc được; bao hàm mức SHARE ROW EXCLUSIVE mà DISABLE / ENABLE TRIGGER cần;
--   · cms_program_products / cms_program_tiers SHARE ROW EXCLUSIVE ⇒ không ghi cấu hình xen giữa; CREATE CONSTRAINT TRIGGER cần đúng mức này.
LOCK TABLE public.cms_sync_runs IN SHARE MODE;
LOCK TABLE public.cms_programs IN EXCLUSIVE MODE;
LOCK TABLE public.cms_program_products, public.cms_program_tiers IN SHARE ROW EXCLUSIVE MODE;

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_name text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '125: cần READ COMMITTED';
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '124';
  IF v_name IS DISTINCT FROM 'cms_source_attestation' THEN
    RAISE EXCEPTION '125: thiếu migration nền 124 cms_source_attestation (name = %)', v_name;
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '125';
  IF FOUND THEN
    RAISE EXCEPTION '125: đã có marker 125 (name = %) — không chạy lại / không chạy chồng', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 125) THEN
    RAISE EXCEPTION '125: DB đã có migration số > 125 — dừng';
  END IF;
  IF to_regprocedure('public.cms__tiers_last_open_guard()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.cms_program_tiers'::regclass AND tgname = 'cms_tiers_last_open') THEN
    RAISE EXCEPTION '125: đã có guard 125 mà không có marker — kiểm tra tay';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION '125: role chạy migration (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  -- Guard chỉ-owner 123 (cms__config_auth_guard): chỉ owner bảng cấu hình ghi được ⇒ chạy bằng ĐÚNG owner bảng / hàm CMS (một owner).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_programs'::regclass, 'public.cms_program_products'::regclass,
                              'public.cms_program_tiers'::regclass, 'public.cms_sync_runs'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '125: owner bảng / hàm CMS khác role chạy (%)', current_user;
  END IF;
  -- Trigger pointer 122 sẽ tắt tạm quanh câu vô hiệu pointer: đúng 1 trigger, đúng hàm, chế độ origin ('O') như 122 tạo.
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_result_guard' AND t.tgenabled = 'O'
         AND t.tgfoid = 'public.cms__programs_result_guard()'::regprocedure) <> 1 THEN
    RAISE EXCEPTION '125: trigger pointer cms_programs_result_guard không đúng dạng 122 (tên / hàm / chế độ origin)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running') THEN
    RAISE EXCEPTION '125: còn run bán đang chạy — chờ xong (run mở theo cấu hình cũ)';
  END IF;
  -- Số đã công bố / chốt THẬT theo luật hữu hạn ⇒ DỪNG (không tự hồi tố / sửa tài chính) — trình PM.
  IF EXISTS (SELECT 1 FROM public.cms_programs g
              WHERE NOT g.is_test
                AND EXISTS (SELECT 1 FROM public.cms_program_products pp
                             WHERE pp.program_id = g.id
                               AND (SELECT t.qty_to FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id
                                     ORDER BY t.tier_order DESC LIMIT 1) IS NOT NULL)
                AND (g.status = 'locked'
                     OR EXISTS (SELECT 1 FROM public.cms_payouts y WHERE y.program_id = g.id)
                     OR EXISTS (SELECT 1 FROM public.cms_sync_runs r WHERE r.program_id = g.id AND r.kind = 'sales' AND r.published_at IS NOT NULL))) THEN
    RAISE EXCEPTION '125: có chương trình THẬT bậc cuối hữu hạn đã công bố / chốt số theo luật cũ — DỪNG, trình PM (không tự đổi tài chính)';
  END IF;
END $$;
-- Thân 2 RPC sắp thay + hàm trigger pointer 122 phải đúng nguyên văn bản đã duyệt — khối sinh bởi gen-cms-125.mjs.
-- @@PREFLIGHT_MD5@@

-- Inventory (chỉ số đếm theo trạng thái / namespace; không PII) — NOTICE + ghi vào notes marker (Studio có thể không hiện NOTICE).
DO $$
BEGIN
  PERFORM set_config('cms125.inventory', (
    SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb) FROM (
      SELECT g.status || CASE WHEN g.is_test THEN ':qa' ELSE ':real' END AS k, count(DISTINCT g.id) AS n
        FROM public.cms_programs g JOIN public.cms_program_products pp ON pp.program_id = g.id
       WHERE (SELECT t.qty_to FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id ORDER BY t.tier_order DESC LIMIT 1) IS NOT NULL
       GROUP BY 1) s)::text, true);
  RAISE NOTICE '125 inventory bậc cuối hữu hạn: %', current_setting('cms125.inventory');
  RAISE NOTICE '125 inventory run / payout: %', jsonb_build_object(
    'sales_runs_published', (SELECT count(*) FROM public.cms_sync_runs WHERE kind = 'sales' AND published_at IS NOT NULL),
    'payouts', (SELECT count(*) FROM public.cms_payouts),
    'pointers', (SELECT count(*) FROM public.cms_programs WHERE current_result_run_id IS NOT NULL));
END $$;
