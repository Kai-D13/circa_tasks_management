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
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid)'::regprocedure) IS DISTINCT FROM 'f5924c03e1ffab041916401a359c76f3'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_program_activate(uuid, uuid)'::regprocedure) IS DISTINCT FROM 'ecc2c134df07a2e89878ac50cc63c04a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__programs_result_guard()'::regprocedure) IS DISTINCT FROM '8784c4589f1d3875b50d015223fc7b93' THEN
    RAISE EXCEPTION '125 preflight: thân 2 RPC 121 / trigger pointer 122 KHÁC bản đã duyệt (md5) — dừng, đối chiếu tay';
  END IF;
END $$;

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

-- ── 1. RPC 121 thay (sinh từ thân nguyên văn 121 + vá gen-cms-125) ────────────
CREATE OR REPLACE FUNCTION public.rpc_cms_import_commit(p_run_id uuid, p_sha256 text, p_digest text, p_payload jsonb, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_run     public.cms_import_runs%ROWTYPE;
  v_prog    public.cms_programs%ROWTYPE;
  v_today   date := public.cms__vn_today();
  v_mode    text;
  v_cat     bigint;
  v_ids     text[];
  e         jsonb;
  t         jsonb;
  v_pp      uuid;
  v_k       integer;
  v_prev_to integer;
  v_n       integer := 0;
  v_tiers   integer := 0;
  v_has_cat boolean := false;
BEGIN
  IF p_run_id IS NULL OR p_actor IS NULL THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_run FROM public.cms_import_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_IMPORT_RUN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_run.file_sha256 IS DISTINCT FROM p_sha256 OR (v_run.result->>'digest') IS DISTINCT FROM p_digest THEN
    RAISE EXCEPTION 'CMS_IMPORT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.status = 'committed' THEN
    RETURN jsonb_build_object('already', true, 'program_id', v_run.program_id);
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_run.program_id FOR UPDATE;
  v_mode := CASE
    WHEN v_prog.status = 'draft' OR (v_prog.status = 'active' AND v_today < v_prog.start_date) THEN 'replace'
    WHEN v_prog.status = 'active' THEN 'append'
    ELSE NULL END;
  IF v_mode IS NULL THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_EDITABLE' USING ERRCODE = 'P0001'; END IF;
  IF v_run.config_version_at_preview <> v_prog.config_version OR v_mode IS DISTINCT FROM v_run.mode THEN
    RAISE EXCEPTION 'CMS_IMPORT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  -- Kiểm payload (không tin client — dù payload do server sinh từ lần parse lại).
  IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
  END IF;
  IF p_payload->>'mode' IS DISTINCT FROM v_mode OR jsonb_typeof(p_payload->'products') IS DISTINCT FROM 'array'
     OR COALESCE(jsonb_typeof(p_payload->'catalog_target'), 'null') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_payload->'products') NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
  END IF;
  -- Miền tiền = bigint dương của PG (cùng contract validator app — PM P1-b P1-1): kiểm dạng + so numeric TRƯỚC cast.
  IF jsonb_typeof(p_payload->'catalog_target') = 'string' THEN
    IF (p_payload->>'catalog_target') !~ '^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023'; END IF;
    IF (p_payload->>'catalog_target')::numeric > 9223372036854775807 THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023'; END IF;
    v_cat := (p_payload->>'catalog_target')::bigint;
  END IF;
  -- Mỗi điều kiện phụ thuộc kiểu được kiểm ở IF riêng (thứ tự đánh giá OR trong SQL không được bảo đảm; không ép kiểu
  -- trước khi đã chắc kiểu / dạng chuỗi ⇒ không lọt NULL, không lỗi cast thô). Kiểm tường minh mọi CHECK của bảng.
  FOR e IN SELECT x FROM jsonb_array_elements(p_payload->'products') x LOOP
    IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023'; END IF;
    IF jsonb_typeof(e->'product_id') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'gmv_basis') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e->'unit_cms') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'advice_text') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e->'name_snapshot') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'base_quantity_cms') IS DISTINCT FROM 'string'
       OR COALESCE(jsonb_typeof(e->'target_gmv'), '-') NOT IN ('string', 'null')
       OR COALESCE(jsonb_typeof(e->'image_url_snapshot'), '-') NOT IN ('string', 'null')
       OR COALESCE(jsonb_typeof(e->'price_snapshot'), '-') NOT IN ('string', 'null')
       OR jsonb_typeof(e->'tiers') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    IF (e->>'product_id') !~ '^[1-9][0-9]{0,18}$' OR (e->>'gmv_basis') NOT IN ('product', 'catalog', 'none')
       -- quy cách: decimal dương ≤ 29 chữ số nguyên / 9 chữ số thập phân (nền 120: < 1e29, scale ≤ 9)
       OR (e->>'base_quantity_cms') !~ '^[0-9]{1,29}(\.[0-9]{1,9})?$' OR (e->>'base_quantity_cms') !~ '[1-9]'
       OR (jsonb_typeof(e->'price_snapshot') = 'string' AND (e->>'price_snapshot') !~ '^[0-9]{1,15}(\.[0-9]{1,9})?$')
       OR ((e->>'gmv_basis') = 'product') IS DISTINCT FROM (jsonb_typeof(e->'target_gmv') = 'string')
       OR (jsonb_typeof(e->'target_gmv') = 'string' AND (e->>'target_gmv') !~ '^[1-9][0-9]{0,18}$')
       OR char_length(e->>'unit_cms') NOT BETWEEN 1 AND 50 OR (e->>'unit_cms') !~ '\S'
       OR char_length(e->>'advice_text') NOT BETWEEN 1 AND 4000 OR (e->>'advice_text') !~ '\S'
       OR char_length(e->>'name_snapshot') NOT BETWEEN 1 AND 500 OR (e->>'name_snapshot') !~ '\S'
       OR (jsonb_typeof(e->'image_url_snapshot') = 'string'
           AND ((e->>'image_url_snapshot') !~ '^https://' OR char_length(e->>'image_url_snapshot') > 2000))
       OR jsonb_array_length(e->'tiers') NOT BETWEEN 1 AND 2000 THEN
      RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(e->'target_gmv') = 'string' AND (e->>'target_gmv')::numeric > 9223372036854775807 THEN
      RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    IF (e->>'gmv_basis') = 'catalog' THEN v_has_cat := true; END IF;
    v_tiers := v_tiers + jsonb_array_length(e->'tiers');
    -- Bậc: payload đã sắp; order = vị trí 1..n, bắt đầu 1, liên tục, chỉ bậc cuối mở, đến ≥ từ, ≤ int max, tiền > 0.
    v_prev_to := 0;
    FOR t, v_k IN SELECT x, n::integer FROM jsonb_array_elements(e->'tiers') WITH ORDINALITY a(x, n) LOOP
      IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR jsonb_typeof(t->'order') IS DISTINCT FROM 'number'
         OR jsonb_typeof(t->'from') IS DISTINCT FROM 'number' OR COALESCE(jsonb_typeof(t->'to'), '-') NOT IN ('number', 'null')
         OR jsonb_typeof(t->'amount') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'CMS_IMPORT_BAD_TIERS' USING ERRCODE = '22023';
      END IF;
      IF (t->>'order') !~ '^[1-9][0-9]{0,9}$' OR (t->>'from') !~ '^[1-9][0-9]{0,9}$'
         OR (jsonb_typeof(t->'to') = 'number' AND (t->>'to') !~ '^[1-9][0-9]{0,9}$')
         OR (t->>'amount') !~ '^[1-9][0-9]{0,18}$' THEN
        RAISE EXCEPTION 'CMS_IMPORT_BAD_TIERS' USING ERRCODE = '22023';
      END IF;
      IF (t->>'order')::bigint <> v_k OR (t->>'from')::bigint <> v_prev_to::bigint + 1
         OR (t->>'amount')::numeric > 9223372036854775807
         OR (jsonb_typeof(t->'to') = 'null' AND v_k <> jsonb_array_length(e->'tiers'))
         OR (t->>'from')::bigint > 2147483647
         OR (jsonb_typeof(t->'to') = 'number' AND ((t->>'to')::bigint < (t->>'from')::bigint OR (t->>'to')::bigint > 2147483647)) THEN
        RAISE EXCEPTION 'CMS_IMPORT_BAD_TIERS' USING ERRCODE = '22023';
      END IF;
      v_prev_to := CASE WHEN jsonb_typeof(t->'to') = 'number' THEN (t->>'to')::integer ELSE v_prev_to END;
    END LOOP;
  END LOOP;
  IF v_tiers > 2000 THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_TIERS' USING ERRCODE = '22023'; END IF;
  IF v_has_cat AND v_cat IS NULL THEN RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023'; END IF;
  IF (SELECT count(*) - count(DISTINCT x->>'product_id') FROM jsonb_array_elements(p_payload->'products') x) <> 0 THEN
    RAISE EXCEPTION 'CMS_IMPORT_BAD_PAYLOAD' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(x->>'product_id') INTO v_ids FROM jsonb_array_elements(p_payload->'products') x;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) x WHERE NOT EXISTS (SELECT 1 FROM public.cms_product_master m WHERE m.product_id = x)) THEN
    RAISE EXCEPTION 'CMS_IMPORT_PRODUCT_UNKNOWN' USING ERRCODE = 'P0001';
  END IF;

  -- 125 (CMS-Q-220 — bỏ trần, thay Q-210a): bậc CUỐI mỗi SP phải không giới hạn ("to": null). Chạy SAU mọi kiểm kiểu / range /
  -- liên tục / payload ở trên (payload hỏng vẫn CMS_IMPORT_BAD_TIERS / BAD_PAYLOAD), TRƯỚC khoá danh mục (thứ tự khoá 121 giữ nguyên).
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'products') x
              WHERE jsonb_typeof((x->'tiers')->(jsonb_array_length(x->'tiers') - 1)->'to') IS DISTINCT FROM 'null') THEN
    RAISE EXCEPTION 'CMS_IMPORT_TIER_LAST_FINITE' USING ERRCODE = '22023';
  END IF;

  -- Khoá danh mục rồi kiểm trùng với chương trình active / locked khác, giao ngày, cùng namespace (câu lệnh mới).
  PERFORM public.cms__lock_catalog();
  IF cardinality(public.cms__conflicts(v_prog.id, v_prog.is_test, v_prog.start_date, v_prog.end_date, v_ids)) > 0 THEN
    RAISE EXCEPTION 'CMS_IMPORT_PRODUCT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  IF v_mode = 'replace' THEN
    DELETE FROM public.cms_program_tiers WHERE program_id = v_prog.id;
    DELETE FROM public.cms_program_products WHERE program_id = v_prog.id;
    UPDATE public.cms_programs SET catalog_target_gmv = CASE WHEN v_has_cat THEN v_cat ELSE NULL END WHERE id = v_prog.id;
  ELSE
    IF EXISTS (SELECT 1 FROM public.cms_program_products WHERE program_id = v_prog.id AND product_id = ANY (v_ids)) THEN
      RAISE EXCEPTION 'CMS_IMPORT_PRODUCT_EXISTS' USING ERRCODE = 'P0001';
    END IF;
    IF v_has_cat THEN
      IF v_prog.catalog_target_gmv IS NULL THEN
        UPDATE public.cms_programs SET catalog_target_gmv = v_cat WHERE id = v_prog.id;
      ELSIF v_prog.catalog_target_gmv <> v_cat THEN
        RAISE EXCEPTION 'CMS_IMPORT_CATALOG_TARGET_CHANGED' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  FOR e IN SELECT x FROM jsonb_array_elements(p_payload->'products') x LOOP
    INSERT INTO public.cms_program_products (program_id, product_id, gmv_basis, target_gmv, unit_cms, base_quantity_cms,
        advice_text, name_snapshot, image_url_snapshot, price_snapshot, import_run_id, added_after_start)
    VALUES (v_prog.id, e->>'product_id', e->>'gmv_basis', NULLIF(e->>'target_gmv', '')::bigint, e->>'unit_cms',
        (e->>'base_quantity_cms')::numeric, e->>'advice_text', e->>'name_snapshot', NULLIF(e->>'image_url_snapshot', ''),
        NULLIF(e->>'price_snapshot', '')::numeric, v_run.id, v_mode = 'append')
    RETURNING id INTO v_pp;
    INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, qty_to, amount_per_unit)
    SELECT v_pp, v_prog.id, (x->>'order')::integer, (x->>'from')::integer, NULLIF(x->>'to', '')::integer, (x->>'amount')::bigint
      FROM jsonb_array_elements(e->'tiers') x;
    v_n := v_n + 1;
  END LOOP;

  -- Audit: lưu payload đã ghi vào run (chuỗi run committed dựng lại được mọi phiên bản danh mục).
  UPDATE public.cms_import_runs
     SET status = 'committed', committed_by = p_actor, committed_at = now(),
         result = result || jsonb_build_object('committed', p_payload)
   WHERE id = v_run.id;
  UPDATE public.cms_programs SET config_version = config_version + 1, updated_by = p_actor, updated_at = now() WHERE id = v_prog.id;
  RETURN jsonb_build_object('already', false, 'program_id', v_prog.id, 'mode', v_mode, 'products', v_n);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_program_activate(p_program_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_prog  public.cms_programs%ROWTYPE;
  v_today date := public.cms__vn_today();
  v_ids   text[];
BEGIN
  IF p_program_id IS NULL OR p_actor IS NULL THEN RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_prog.status <> 'draft' THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_DRAFT' USING ERRCODE = 'P0001'; END IF;
  SELECT COALESCE(array_agg(product_id), '{}'::text[]) INTO v_ids FROM public.cms_program_products WHERE program_id = v_prog.id;
  IF cardinality(v_ids) = 0 THEN RAISE EXCEPTION 'CMS_PROGRAM_EMPTY' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM public.cms_program_products WHERE program_id = v_prog.id AND gmv_basis = 'catalog')
     AND v_prog.catalog_target_gmv IS NULL THEN
    RAISE EXCEPTION 'CMS_PROGRAM_CATALOG_TARGET_MISSING' USING ERRCODE = 'P0001';
  END IF;
  -- 125 (CMS-Q-220): mọi SP có thang bậc hợp lệ (bắt đầu 1, liên tục theo tier_order, chỉ bậc cuối mở) và bậc cuối KHÔNG giới hạn
  -- — cấu hình chưa chuyển đổi (cận cuối hữu hạn) không kích hoạt được, kể cả khi guard bị vượt bằng quyền owner.
  IF EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = v_prog.id
               AND NOT EXISTS (SELECT 1 FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id))
     OR EXISTS (SELECT 1 FROM (SELECT t.tier_order, t.qty_from, t.qty_to,
                                      lag(t.qty_to) OVER w AS prev_to, row_number() OVER w AS rn,
                                      count(*) OVER (PARTITION BY t.program_product_id) AS n
                                 FROM public.cms_program_tiers t WHERE t.program_id = v_prog.id
                               WINDOW w AS (PARTITION BY t.program_product_id ORDER BY t.tier_order)) x
                 WHERE x.tier_order <> x.rn OR (x.rn = 1 AND x.qty_from <> 1)
                    OR (x.rn > 1 AND (x.prev_to IS NULL OR x.qty_from::bigint <> x.prev_to::bigint + 1)) OR (x.qty_to IS NULL AND x.rn <> x.n)) THEN
    RAISE EXCEPTION 'CMS_PROGRAM_TIERS_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_program_products pp
              WHERE pp.program_id = v_prog.id
                AND (SELECT t.qty_to FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id
                      ORDER BY t.tier_order DESC LIMIT 1) IS NOT NULL) THEN
    RAISE EXCEPTION 'CMS_PROGRAM_TIER_LAST_FINITE' USING ERRCODE = 'P0001';
  END IF;
  IF v_prog.scope = 'all' THEN
    DELETE FROM public.cms_program_stores WHERE program_id = v_prog.id;
    INSERT INTO public.cms_program_stores (program_id, store_id)
      SELECT v_prog.id, s.id FROM public.stores s WHERE s.store_type = 'os' AND s.is_active;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cms_program_stores WHERE program_id = v_prog.id)
     OR EXISTS (SELECT 1 FROM public.cms_program_stores ps JOIN public.stores s ON s.id = ps.store_id
                 WHERE ps.program_id = v_prog.id AND NOT (s.store_type = 'os' AND s.is_active)) THEN
    RAISE EXCEPTION 'CMS_PROGRAM_STORE_INVALID' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.cms__lock_catalog();
  IF cardinality(public.cms__conflicts(v_prog.id, v_prog.is_test, v_prog.start_date, v_prog.end_date, v_ids)) > 0 THEN
    RAISE EXCEPTION 'CMS_ACTIVATE_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.cms_programs
     SET status = 'active', activated_at = now(), activated_by = p_actor, config_version = config_version + 1,
         updated_by = p_actor, updated_at = now()
   WHERE id = v_prog.id;
  RETURN jsonb_build_object('program_id', v_prog.id, 'started', v_today >= v_prog.start_date, 'ended', v_today > v_prog.end_date,
                            'stores', (SELECT count(*) FROM public.cms_program_stores WHERE program_id = v_prog.id));
END;
$$;

-- ── 2. Guard DB: bậc cuối không giới hạn ở cuối transaction ────────────────
-- Constraint trigger DEFERRABLE INITIALLY DEFERRED (chạy lúc COMMIT, mỗi dòng bậc đổi): import nhiều dòng / replace (xoá rồi chèn
-- lại) không bị chặn giữa chừng, nhưng transaction kết thúc không thể để lại bậc cuối hữu hạn. SECURITY DEFINER (owner bảng) ⇒ đọc
-- đúng bậc dù COMMIT chạy dưới role nào (service_role / authenticator) — RLS bảng không áp owner. Không cấp EXECUTE cho ai (trigger
-- không cần). Chỉ ĐỌC bậc cuối qua PK (program_product_id, tier_order) ⇒ không khoá, không quét chương trình.
CREATE FUNCTION public.cms__tiers_last_open_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids uuid[] := '{}'::uuid[];
  v_id  uuid;
  v_to  integer;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_ids := v_ids || OLD.program_product_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_ids := v_ids || NEW.program_product_id;
  END IF;
  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT t.qty_to INTO v_to FROM public.cms_program_tiers t WHERE t.program_product_id = v_id ORDER BY t.tier_order DESC LIMIT 1;
    IF FOUND THEN
      IF v_to IS NOT NULL THEN
        RAISE EXCEPTION 'CMS_TIER_LAST_FINITE' USING ERRCODE = '23514';
      END IF;
    -- Không còn bậc: chỉ bỏ qua khi SP cũng đã bị xoá (replace xoá bậc rồi xoá SP — không kiểm nhầm id cũ). SP còn dòng mà 0 bậc ⇒
    -- không có bậc cuối không giới hạn ⇒ chặn (db-reviewer 125 P2-4).
    ELSIF EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.id = v_id) THEN
      RAISE EXCEPTION 'CMS_TIER_LAST_FINITE' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER cms_tiers_last_open AFTER INSERT OR UPDATE OR DELETE ON public.cms_program_tiers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.cms__tiers_last_open_guard();
-- Như 123 (db-reviewer P1-2): ENABLE ALWAYS — vẫn chạy khi session_replication_role = replica.
ALTER TABLE public.cms_program_tiers ENABLE ALWAYS TRIGGER cms_tiers_last_open;

-- ── 3. Chuyển đổi cấu hình CHƯA CHỐT có bậc cuối hữu hạn ───────────────────
-- Guard ở §2 đã tồn tại ⇒ chính câu chuyển đổi cũng bị guard kiểm lúc COMMIT. 'locked' không đụng (guard 123 cũng chặn).
DO $$
DECLARE
  v_ids   uuid[];
  v_tiers integer := 0;
  v_progs integer := 0;
  v_ptr   integer := 0;
BEGIN
  SELECT COALESCE(array_agg(g.id ORDER BY g.id), '{}'::uuid[]) INTO v_ids
    FROM public.cms_programs g
   WHERE g.status IN ('draft', 'active')
     AND EXISTS (SELECT 1 FROM public.cms_program_products pp
                  WHERE pp.program_id = g.id
                    AND (SELECT t.qty_to FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id
                          ORDER BY t.tier_order DESC LIMIT 1) IS NOT NULL);
  IF cardinality(v_ids) > 0 THEN
    -- Khoá dòng chương trình theo thứ tự id (RPC 121 / 123 cũng khoá dòng chương trình trước khi ghi bậc / chốt).
    PERFORM 1 FROM public.cms_programs WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE;
    -- Kiểm lại sau khoá (câu lệnh mới ⇒ bản mới nhất): không run bán đang chạy của chương trình bị đổi.
    IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running' AND program_id = ANY (v_ids)) THEN
      RAISE EXCEPTION '125: run bán đang chạy trên chương trình cần chuyển đổi — dừng';
    END IF;
    -- Chỉ cận trên của bậc CUỐI → NULL; bậc trước / mức tiền / số bậc giữ nguyên.
    UPDATE public.cms_program_tiers t SET qty_to = NULL
      FROM (SELECT DISTINCT ON (x.program_product_id) x.program_product_id, x.tier_order, x.qty_to
              FROM public.cms_program_tiers x WHERE x.program_id = ANY (v_ids)
             ORDER BY x.program_product_id, x.tier_order DESC) l
     WHERE t.program_product_id = l.program_product_id AND t.tier_order = l.tier_order AND l.qty_to IS NOT NULL;
    GET DIAGNOSTICS v_tiers = ROW_COUNT;
    SELECT count(*) INTO v_ptr FROM public.cms_programs WHERE id = ANY (v_ids) AND current_result_run_id IS NOT NULL;
    -- Trigger pointer 122 cấm pointer NULL ⇒ tắt TẠM đúng một câu (đang giữ SHARE ROW EXCLUSIVE bảng chương trình từ đầu).
    ALTER TABLE public.cms_programs DISABLE TRIGGER cms_programs_result_guard;
    UPDATE public.cms_programs
       SET config_version = config_version + 1, current_result_run_id = NULL, updated_at = now(), updated_by = NULL
     WHERE id = ANY (v_ids);
    GET DIAGNOSTICS v_progs = ROW_COUNT;
    ALTER TABLE public.cms_programs ENABLE TRIGGER cms_programs_result_guard;
  END IF;
  PERFORM set_config('cms125.converted', jsonb_build_object('programs', v_progs, 'last_tiers', v_tiers, 'pointers_cleared', v_ptr)::text, true);
  RAISE NOTICE '125 chuyển đổi: %', current_setting('cms125.converted');
END $$;

-- ── 4. ACL: thu hồi đích danh rồi cấp đúng ma trận (gate ACL — áp cả hàm OR REPLACE) ──
REVOKE ALL ON FUNCTION public.cms__tiers_last_open_guard(), public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid),
  public.rpc_cms_program_activate(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid), public.rpc_cms_program_activate(uuid, uuid)
  TO service_role;
-- Thu hồi mọi grant khác owner do default privileges cấp (bài học SEC-1 / 091 / 117 / 120–124).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, x.grantee
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('cms__tiers_last_open_guard', 'rpc_cms_import_commit', 'rpc_cms_program_activate')
       AND x.grantee <> p.proowner
       AND NOT (p.proname IN ('rpc_cms_import_commit', 'rpc_cms_program_activate') AND x.grantee = 'service_role'::regrole::oid)
     GROUP BY p.oid, x.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- ── 5. Hậu kiểm trong transaction ──────────────────────────────────────────
DO $$
DECLARE
  r   record;
  v_n integer;
BEGIN
  v_n := 0;
  FOR r IN
    SELECT p.proname, p.prosecdef, p.proconfig,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ','
                              ORDER BY CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END, x.privilege_type)
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl,
           has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
           has_function_privilege('service_role', p.oid, 'EXECUTE') s
      FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('cms__tiers_last_open_guard', 'rpc_cms_import_commit', 'rpc_cms_program_activate')
  LOOP
    v_n := v_n + 1;
    IF r.a OR r.u OR NOT r.prosecdef OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}')))
       OR r.acl IS DISTINCT FROM (CASE WHEN r.proname LIKE 'rpc\_%' THEN 'service_role:EXECUTE' END)
       OR r.s IS DISTINCT FROM (r.proname LIKE 'rpc\_%')
       OR (r.proname LIKE 'rpc\_%' AND NOT ('lock_timeout=5s' = ANY (COALESCE(r.proconfig, '{}')))) THEN
      RAISE EXCEPTION '125 hậu kiểm: ACL / SECDEF / search_path / lock_timeout hàm % sai (acl %, config %)', r.proname, r.acl, r.proconfig;
    END IF;
  END LOOP;
  IF v_n <> 3 THEN RAISE EXCEPTION '125 hậu kiểm: cần đúng 3 hàm 125 (1 mới + 2 thay OR REPLACE), có %', v_n; END IF;
  -- Tổng hàm CMS: 67 sau 124 + 1 (guard).
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> 68 THEN RAISE EXCEPTION '125 hậu kiểm: tổng hàm CMS phải 68, có %', v_n; END IF;
  -- Guard: đúng 1 constraint trigger, hàm, DEFERRABLE INITIALLY DEFERRED, ENABLE ALWAYS, AFTER ROW INSERT / UPDATE / DELETE
  -- (tgtype = ROW 1 + INSERT 4 + DELETE 8 + UPDATE 16 = 29).
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.cms_program_tiers'::regclass AND t.tgname = 'cms_tiers_last_open' AND NOT t.tgisinternal
         AND t.tgenabled = 'A' AND t.tgdeferrable AND t.tginitdeferred AND t.tgconstraint <> 0 AND t.tgtype = 29
         AND t.tgfoid = 'public.cms__tiers_last_open_guard()'::regprocedure) <> 1 THEN
    RAISE EXCEPTION '125 hậu kiểm: constraint trigger cms_tiers_last_open sai (hàm / deferred / ALWAYS / sự kiện)';
  END IF;
  -- Trigger pointer 122 đã bật lại đúng chế độ origin.
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_result_guard' AND t.tgenabled = 'O'
         AND t.tgfoid = 'public.cms__programs_result_guard()'::regprocedure) <> 1 THEN
    RAISE EXCEPTION '125 hậu kiểm: trigger pointer cms_programs_result_guard chưa bật lại đúng chế độ 122';
  END IF;
  -- Bất biến: cấu hình CHƯA CHỐT không còn bậc cuối hữu hạn.
  IF EXISTS (SELECT 1 FROM public.cms_programs g JOIN public.cms_program_products pp ON pp.program_id = g.id
              WHERE g.status IN ('draft', 'active')
                AND (SELECT t.qty_to FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id
                      ORDER BY t.tier_order DESC LIMIT 1) IS NOT NULL) THEN
    RAISE EXCEPTION '125 hậu kiểm: còn cấu hình chưa chốt có bậc cuối hữu hạn';
  END IF;
  -- Bất biến: run HIỆN HÀNH của chương trình chưa chốt không mang trần (chương trình bị đổi đã mất pointer; còn lại vốn cuối NULL).
  IF EXISTS (SELECT 1 FROM public.cms_programs g JOIN public.cms_results res ON res.run_id = g.current_result_run_id
              WHERE g.status IN ('draft', 'active') AND (res.cap_quantity IS NOT NULL OR res.at_cap))
     OR EXISTS (SELECT 1 FROM public.cms_programs g JOIN public.cms_result_lines rl ON rl.run_id = g.current_result_run_id
                 WHERE g.status IN ('draft', 'active') AND rl.status = 'AT_CAP') THEN
    RAISE EXCEPTION '125 hậu kiểm: run hiện hành của chương trình chưa chốt còn trần / AT_CAP';
  END IF;
  -- Cổng thật vẫn đóng (125 không mở cổng / policy).
  IF (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM false OR public.cms__results_release_open() THEN
    RAISE EXCEPTION '125 hậu kiểm: policy thật / cổng Q-206 không được mở';
  END IF;
END $$;
-- Thân 2 RPC thay phải đúng bản sinh (md5) — khối sinh bởi gen-cms-125.mjs.
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid)'::regprocedure) IS DISTINCT FROM '65bd0b43e24fda590eec4cd764f959c2'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_program_activate(uuid, uuid)'::regprocedure) IS DISTINCT FROM '6ae92590bf7afc237c80cc3db15e5aad' THEN
    RAISE EXCEPTION '125 hậu kiểm: thân 2 RPC thay lệch bản sinh (md5)';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('125', 'cms_uncapped_last_tier', 'CMS-Q-220 (thay Q-210a): bỏ trần — bậc cuối không giới hạn; import / kích hoạt + constraint trigger cms_tiers_last_open; chuyển đổi chưa chốt '
  || current_setting('cms125.converted') || ' · inventory trước chuyển đổi ' || current_setting('cms125.inventory'));

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — `node scripts/cms-verify.mjs post --phase=125 --pre=<PRE chụp NGAY TRƯỚC 125>`) ──
-- Sau 125, cms-verify phase 124 ĐỎ đúng thiết kế (md5 2 RPC 121 thay, +1 hàm, +1 trigger, ràng buộc trigger trên cms_program_tiers)
-- ⇒ manifest VERIFY phase 125 (CMS_FN_SRC_125 / CMS_TRIGGERS_125 / shape tiers sinh bằng scripts/gen-cms-verify-fp-125.mjs).
-- V1 marker:
--   SELECT version, name, notes FROM public.app_migrations WHERE version IN ('124', '125') ORDER BY 1;
--   -- 124 cms_source_attestation · 125 cms_uncapped_last_tier (notes: số chương trình / bậc / pointer đã chuyển đổi)
-- V2 ACL 3 hàm:
--   SELECT p.oid::regprocedure fn, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') authn, has_function_privilege('service_role', p.oid, 'EXECUTE') svc
--     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('cms__tiers_last_open_guard', 'rpc_cms_import_commit', 'rpc_cms_program_activate') ORDER BY 1;
--   -- 3 dòng; anon / authn f; svc t đúng 2 RPC; prosecdef t; search_path=public; RPC ∋ lock_timeout=5s
-- V3 guard + pointer trigger:
--   SELECT t.tgname, t.tgenabled, t.tgdeferrable, t.tginitdeferred, pg_get_triggerdef(t.oid) FROM pg_trigger t
--    WHERE t.tgrelid IN ('public.cms_program_tiers'::regclass, 'public.cms_programs'::regclass)
--      AND t.tgname IN ('cms_tiers_last_open', 'cms_programs_result_guard') ORDER BY 1;   -- A t t · O f f
-- V4 bất biến (kỳ vọng 0 dòng):
--   SELECT g.id FROM public.cms_programs g JOIN public.cms_program_products pp ON pp.program_id = g.id
--    WHERE g.status IN ('draft', 'active')
--      AND (SELECT t.qty_to FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id ORDER BY t.tier_order DESC LIMIT 1) IS NOT NULL;
--   SELECT g.id FROM public.cms_programs g JOIN public.cms_results r ON r.run_id = g.current_result_run_id
--    WHERE g.status IN ('draft', 'active') AND (r.cap_quantity IS NOT NULL OR r.at_cap);
-- V5 thân hàm / định nghĩa / bảng / trigger: `node scripts/cms-verify.mjs post --phase=125` (CMS_FN_MATRIX + CMS_FN_SRC_125 sinh
--   từ file migration bằng scripts/gen-cms-verify-fp-125.mjs — không bao giờ từ DB cần kiểm).
