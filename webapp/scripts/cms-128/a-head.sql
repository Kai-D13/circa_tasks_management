-- ============================================================================
-- 128_cms_unit_quantity_basis.sql  (r1 — CMS-UNIT capability, Dev 09/11/2026; CHƯA audit PM, CHƯA commit, KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-128.mjs từ webapp/scripts/cms-128/*.sql + thân 15 hàm NGUYÊN VĂN của bản cuối đang chạy (121 / 122 /
-- 123 / 124 / 126 — xem bảng dưới; chỉ chèn / thay đúng các đoạn ghi trong generator) + hằng hợp đồng đơn vị lib/cms/unitKey.ts.
-- KHÔNG sửa file này bằng tay — `node scripts/gen-cms-128.mjs --check` phát hiện lệch.
-- Số 128 = số PM dành trong khối Hiện trạng sống STATE (09/11, "128 cms_unit_quantity_basis"), preflight 127. Datafix T11 (đổi cơ sở
-- chương trình thật) là file RIÊNG, CHƯA cấp số — 128 KHÔNG đổi cơ sở / tiền / pointer của chương trình nào.
-- Nguồn: planning/research/cms-unit-basis-spec-implementation-2026-11-09.md (Q-221…Q-224, UNIT-D01…D05) + review PM 09/11.
--
-- Mục đích: CAPABILITY cơ sở tính số lượng CMS theo chương trình (cms_programs.quantity_basis):
--   · 'pos_base' (mặc định, mọi chương trình hiện có + payload cũ): Q = floor(max(ΣB, 0) / K) — KHÔNG đổi ngữ nghĩa (nhánh cũ giữ
--     nguyên văn trong seal; đọc / ghi / chốt như 127).
--   · 'cms_unit' (Q-221 / Q-223): chỉ dòng bán ĐÚNG "ĐV tính CMS" (khoá đơn vị cms__unit_key — hợp đồng chung với TS) đóng góp
--     lượng = quantity_raw, phải là số NGUYÊN (lẻ / sai / thiếu ⇒ không seal được — app HOLD trước); dòng khác đơn vị đóng góp 0 nhưng
--     GIỮ dòng kết quả / GMV (Q-224) / lineage. Q = max(ΣC, 0), tiền = F(Q) theo bậc hiện có; K (base_quantity_CMS) chỉ còn là thông tin
--     kiểm chéo (per_unit vẫn = K, không bao giờ là mẫu số của nhánh mới). B (base_quantity) trong kết quả / dòng vẫn là lượng cơ sở THẬT.
--
-- Thay đổi:
--   1. Cột cms_programs.quantity_basis text NOT NULL DEFAULT 'pos_base' CHECK ('pos_base' | 'cms_unit') — thêm cột có default hằng
--      (không viết lại bảng). Đổi cơ sở = trigger cms_programs_basis_guard: chỉ khi config_version + 1 trong CÙNG câu lệnh, pointer NULL,
--      không run bán đang chạy, và (chương trình nháp | chưa có run bán nào | phiên datafix khai cms.basis_change_program = id).
--   2. Metadata tính của run (DB ghi lúc open, BẤT BIẾN — trigger cms_sync_runs_basis_guard): cms_sync_runs.quantity_basis,
--      calculation_policy_version ('pos_base_v1' | 'cms_unit_v1'; run bán CŨ được dán nhãn 'pos_base_legacy' — không bịa snapshot),
--      calculation_snapshot (jsonb cms-calc-snapshot-v1: cơ sở, chính sách, phiên bản khoá đơn vị, config_version + vân tay cấu hình,
--      từng SP: unit_cms gốc + khoá, K, loại GMV, target, bậc). Run 'products' để NULL. INSERT run bán mới thiếu / sai metadata ⇒ lỗi.
--   3. Helper nội bộ (không cấp ai — kể cả service_role): cms__unit_key(text), cms__qty_dec(text), cms__basis_policy(text),
--      cms__calc_snapshot(uuid) + 2 hàm trigger. Seal chỉ chuẩn hoá MỖI cặp (SP, đơn vị thô) / mỗi chuỗi lượng PHÂN BIỆT một lần.
--   4. Thay 15 hàm (OR REPLACE giữ chữ ký / owner / SECDEF / search_path / lock_timeout / ACL):
--        cms__sales_snapshot (122)          + quantity_basis / calculation_policy_version / unit_key_version / products.unit_cms
--        cms__config_fp (123)               + cơ sở khi = cms_unit (pos_base giữ NGUYÊN giá trị vân tay cũ — payout / VERIFY cũ không đổi)
--        rpc_cms_program_save (121)         + khoá tuỳ chọn quantity_basis (thiếu ⇒ tạo pos_base / sửa giữ nguyên; lạ ⇒ BAD_INPUT)
--        rpc_cms_sales_run_open (124)       dựng + ghi metadata run, cms_unit có SP khoá đơn vị rỗng ⇒ CMS_SALES_UNIT_INVALID; detail
--                                           mang khoá metadata ⇒ CMS_SYNC_BAD_DETAIL; trả calculation_snapshot
--        rpc_cms_sales_run_seal_begin (122) metadata run hợp lệ, cơ sở / vân tay cấu hình = chương trình, DẤU WRITER (expect khai đúng
--                                           cơ sở + phiên bản; writer cũ không khai chỉ hợp lệ với pos_base) ⇒ held BASIS_WRITER_MISMATCH
--        rpc_cms_sales_run_seal_step (122)  đầu mỗi bước kiểm như seal_begin; bước 7 / 10 nhánh cms_unit (C độc lập từ dòng nguồn,
--                                           Q = max(ΣC, 0), F(Q), C trước / sau theo seq, B thật, trạng thái gồm lượng âm); nhánh
--                                           pos_base NGUYÊN VĂN 122 (ELSE)
--        rpc_cms_sales_run_publish (126)    cơ sở / vân tay cấu hình + dấu writer kiểm lại dưới khoá; chương trình thật cms_unit: dòng
--                                           chưa gán / ngoài phạm vi có quantity_raw âm cũng chặn (RETURNS_NOT_SUPPORTED_THIS_PHASE)
--        rpc_cms_sales_run_finish (122)     detail mang khoá metadata ⇒ CMS_SYNC_BAD_DETAIL
--        rpc_cms_result_header / rows / lines (122)  trả cơ sở + phiên bản của RUN (rows: đơn vị theo snapshot run; lines: unit_match +
--                                           counted_quantity cho run cms_unit) — không lấy cấu hình hiện tại để diễn giải run lịch sử
--        cms__attest_eval / rpc_cms_source_attest / cms__lock_eval (124)  run cms_unit ⇒ CMS_UNIT_ATTESTATION_NOT_SUPPORTED (decision10
--                                           không ràng buộc quantity_raw / uom_raw — PM §3.4; cả chốt QA)
--        rpc_cms_run_source_export (124)    + quantity_basis / calculation_policy_version / attestation_supported (snapshot tra soát,
--                                           KHÔNG phải chứng nhận)
--   Không đổi: stage 124 (hợp đồng dòng), schema kết quả / trạng thái dòng, RLS / policy, quyền bảng, cổng 126, policy chốt thật,
--   cron / env. Không đổi cơ sở của chương trình nào (datafix riêng).
--
-- Triển khai (runbook phát hành gộp — spec §8): sau 127; app cũ (prod) vẫn chạy pos_base trên schema mới (snapshot thêm khoá thừa app
-- cũ bỏ qua; seal nhận writer không dấu cho pos_base). Khoá cms_programs + cms_sync_runs ACCESS EXCLUSIVE (thứ tự chương trình → run như
-- RPC) ⇒ chạy khi task CMS sales tạm dừng, không run bán 'running'. READ COMMITTED. POST: `node scripts/cms-verify.mjs post --phase=128
-- --pre=<PRE chụp NGAY TRƯỚC 128>`. Sau 128, cms-verify phase 127 ĐỎ phase-match đúng thiết kế ⇒ phase 128.
-- ROLLBACK: rollback/128_cms_unit_quantity_basis_rollback.sql — chỉ khi CHƯA có chương trình / run cms_unit (có ⇒ dừng, không drop metadata
-- làm mất nghĩa lịch sử; xử lý tiến). Khôi phục NGUYÊN VĂN 15 hàm + ACL, gỡ trigger / helper / cột / ràng buộc, xoá marker 128.
-- Vận hành: DÁN NGUYÊN FILE, nên GIỮ LF (md5 thân hàm bỏ \r — md5(replace(prosrc, E'\r', ''))). Chạy bằng ĐÚNG role owner bảng / hàm CMS.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
-- Khoá TRƯỚC preflight theo thứ tự chương trình → run (như RPC 121–126), không nâng khoá giữa chừng; bận ⇒ hết lock_timeout, cả
-- migration rollback sạch. ALTER TABLE ADD COLUMN / CREATE TRIGGER / ADD CONSTRAINT cần các mức này.
LOCK TABLE public.cms_programs IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.cms_sync_runs IN ACCESS EXCLUSIVE MODE;

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_name text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '128: cần READ COMMITTED';
  END IF;
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION '128: DB phải UTF8 (normalize NFC của khoá đơn vị)';
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '127';
  IF v_name IS DISTINCT FROM 'cms_t11_flat_amounts' THEN
    RAISE EXCEPTION '128: thiếu migration nền 127 cms_t11_flat_amounts (name = %)', v_name;
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '128';
  IF FOUND THEN
    RAISE EXCEPTION '128: đã có marker 128 (name = %) — không chạy lại / không chạy chồng', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 127) THEN
    RAISE EXCEPTION '128: DB đã có migration số > 127 — dừng';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION '128: role chạy migration (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_programs'::regclass, 'public.cms_sync_runs'::regclass, 'public.cms_sales_lines'::regclass,
                              'public.cms_program_products'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '128: owner bảng / hàm CMS khác role chạy (%)', current_user;
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND (p.proname LIKE 'cms\_%' OR p.proname LIKE 'rpc\_cms\_%')) <> 68 THEN
    RAISE EXCEPTION '128: tổng hàm CMS trước 128 phải 68 (như 126 / 127)';
  END IF;
  IF to_regprocedure('public.cms__unit_key(text)') IS NOT NULL OR to_regprocedure('public.cms__calc_snapshot(uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                 AND ((table_name = 'cms_programs' AND column_name = 'quantity_basis')
                      OR (table_name = 'cms_sync_runs' AND column_name IN ('quantity_basis', 'calculation_policy_version', 'calculation_snapshot')))) THEN
    RAISE EXCEPTION '128: đã có cột / helper cơ sở tính mà không có marker 128 — kiểm tra tay';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running') THEN
    RAISE EXCEPTION '128: còn run bán running — tạm dừng task CMS sales, chờ run kết thúc rồi chạy lại';
  END IF;
  -- Dán nhãn legacy cho run bán cũ là UPDATE dòng run: run đã có payout bị guard đóng băng 123 chặn ⇒ không tự nới guard, dừng để PM
  -- quyết (prod 09/11: 0 payout).
  IF EXISTS (SELECT 1 FROM public.cms_payouts) THEN
    RAISE EXCEPTION '128: đã có payout — nhãn legacy chạm run đóng băng; dừng, trình PM (không nới guard 123)';
  END IF;
  IF public.cms__results_release_open() IS DISTINCT FROM true
     OR (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION '128: cổng kết quả / policy chốt khác trạng thái 126 / 127 — dừng, đối chiếu tay';
  END IF;
END $$;
-- Thân 15 hàm sắp thay phải đúng nguyên văn bản cuối đã duyệt (121 / 122 / 123 / 124 / 126) — khối sinh bởi gen-cms-128.mjs.
-- @@PREFLIGHT_MD5@@

-- Inventory (chỉ số đếm; không PII) — NOTICE + ghi vào notes marker.
DO $$
BEGIN
  PERFORM set_config('cms128.inventory', jsonb_build_object(
    'programs', (SELECT count(*) FROM public.cms_programs),
    'programs_real', (SELECT count(*) FROM public.cms_programs WHERE NOT is_test),
    'sales_runs_legacy_labelled', (SELECT count(*) FROM public.cms_sync_runs WHERE kind = 'sales'),
    'sales_runs_published', (SELECT count(*) FROM public.cms_sync_runs WHERE kind = 'sales' AND published_at IS NOT NULL))::text, true);
  RAISE NOTICE '128 inventory: %', current_setting('cms128.inventory');
END $$;
