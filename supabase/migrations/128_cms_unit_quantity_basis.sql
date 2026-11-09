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
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__sales_snapshot(uuid)'::regprocedure) IS DISTINCT FROM 'e22120f8a95af5308420914c441ca260'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__config_fp(uuid)'::regprocedure) IS DISTINCT FROM '08cf01ecc1809866eff314b5ec82d170'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__attest_eval(uuid, uuid)'::regprocedure) IS DISTINCT FROM 'a75e03e0b4c7a45c446af38698cf44e9'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__lock_eval(uuid, uuid, integer, text, boolean)'::regprocedure) IS DISTINCT FROM '6c38e2ca40f37d1cc5e715f8cd3e2bb5'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_program_save(jsonb)'::regprocedure) IS DISTINCT FROM '5f9360e7c3c1d4dd828b50f8fc1c2115'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_open(uuid, jsonb)'::regprocedure) IS DISTINCT FROM 'a0123bc5abeefac9da1c8dbcd645a97a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_seal_begin(uuid, jsonb)'::regprocedure) IS DISTINCT FROM '327d53af6739ffdbf780363aa6460bcc'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_seal_step(uuid, integer)'::regprocedure) IS DISTINCT FROM '55462ce6e7a5b5e6ad26a2c1751ca726'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure) IS DISTINCT FROM 'db2c97efad2bb5ee9d69399b99c7c258'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_finish(uuid, text, jsonb)'::regprocedure) IS DISTINCT FROM '20a74c4806dfc520ce165c181e09c739'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_result_header(uuid)'::regprocedure) IS DISTINCT FROM '26abaac3902886c1e82c92a9dcf321ec'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_result_rows(uuid, uuid)'::regprocedure) IS DISTINCT FROM 'a63f54b3243637c2c8979d0bc24c9d81'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer)'::regprocedure) IS DISTINCT FROM 'c1bf6ff7c059a4b3fe13c140205306cd'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid)'::regprocedure) IS DISTINCT FROM '32b51294e2837918377ba37007da38f1'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_run_source_export(uuid, uuid, text, integer)'::regprocedure) IS DISTINCT FROM '8f1d48eaf1b532490cfc3582a6312d18' THEN
    RAISE EXCEPTION '128 preflight: thân một trong 15 hàm sắp thay KHÁC bản cuối đã duyệt (md5) — dừng, đối chiếu tay';
  END IF;
END $$;

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

-- ── 1. Cơ sở tính theo chương trình ─────────────────────────────────────────
-- Default hằng ⇒ PG ≥ 11 không viết lại bảng; mọi chương trình hiện có = pos_base (luật cũ, không đổi tiền / pointer).
ALTER TABLE public.cms_programs
  ADD COLUMN quantity_basis text NOT NULL DEFAULT 'pos_base'
    CONSTRAINT cms_programs_quantity_basis_check CHECK (quantity_basis IN ('pos_base', 'cms_unit'));

-- ── 2. Metadata tính của run (DB ghi lúc open, bất biến) ────────────────────
ALTER TABLE public.cms_sync_runs
  ADD COLUMN quantity_basis             text,
  ADD COLUMN calculation_policy_version text,
  ADD COLUMN calculation_snapshot       jsonb;
-- Run bán CŨ: dán nhãn theo chính sách đã biết (pos_base), KHÔNG bịa snapshot lịch sử (NULL + nhãn 'pos_base_legacy'). Trigger 123 trên
-- bảng run (owner / payout — preflight: 0 payout) chạy bình thường; trigger bất biến 128 tạo SAU câu này.
UPDATE public.cms_sync_runs SET quantity_basis = 'pos_base', calculation_policy_version = 'pos_base_legacy'
 WHERE kind = 'sales';
ALTER TABLE public.cms_sync_runs
  ADD CONSTRAINT cms_sync_runs_basis_shape CHECK (
    (kind = 'products' AND quantity_basis IS NULL AND calculation_policy_version IS NULL AND calculation_snapshot IS NULL)
    OR (kind = 'sales'
        AND ((quantity_basis = 'pos_base' AND calculation_policy_version IN ('pos_base_legacy', 'pos_base_v1'))
             OR (quantity_basis = 'cms_unit' AND calculation_policy_version = 'cms_unit_v1'))
        AND ((calculation_policy_version = 'pos_base_legacy') = (calculation_snapshot IS NULL))
        AND (calculation_snapshot IS NULL
             OR (jsonb_typeof(calculation_snapshot) = 'object'
                 AND calculation_snapshot ->> 'schema' = 'cms-calc-snapshot-v1'
                 AND calculation_snapshot ->> 'quantity_basis' = quantity_basis
                 AND calculation_snapshot ->> 'calculation_policy_version' = calculation_policy_version
                 AND jsonb_typeof(calculation_snapshot -> 'products') = 'array'
                 AND (calculation_snapshot ->> 'config_fp') ~ '^[0-9a-f]{32}$'))));

-- ── 3. Helper nội bộ (không cấp ai; chỉ RPC SECDEF cùng owner gọi) ─────────
-- Khoá so khớp đơn vị — hợp đồng CHUNG với lib/cms/unitKey.ts cmsUnitKey (cms-unit-key-v1): ký tự điều khiển C0 / DEL / C1 ⇒ NULL
-- (không hợp lệ, không xoá); NFC; cắt khoảng trắng hai đầu theo TẬP TƯỜNG MINH (gồm NBSP); hoa → thường theo BẢNG TƯỜNG MINH bằng
-- translate (KHÔNG lower(): phụ thuộc locale DB — PGlite / cluster locale C chỉ hạ ASCII). Không bỏ dấu / alias / cắt độ dài.
CREATE FUNCTION public.cms__unit_key(p_unit text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_unit ~ '[\x01-\x1f\x7f-\x9f]' THEN NULL
              ELSE NULLIF(translate(btrim(normalize(p_unit, NFC), U&'\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),
                                    'ABCDEFGHIJKLMNOPQRSTUVWXYZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽƠƯḀḂḄḆḈḊḌḎḐḒḔḖḘḚḜḞḠḢḤḦḨḪḬḮḰḲḴḶḸḺḼḾṀṂṄṆṈṊṌṎṐṒṔṖṘṚṜṞṠṢṤṦṨṪṬṮṰṲṴṶṸṺṼṾẀẂẄẆẈẊẌẎẐẒẔẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸỺỼỾ',
                                    'abcdefghijklmnopqrstuvwxyzàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþāăąćĉċčďđēĕėęěĝğġģĥħĩīĭįĳĵķĺļľŀłńņňŋōŏőœŕŗřśŝşšţťŧũūŭůűųŵŷÿźżžơưḁḃḅḇḉḋḍḏḑḓḕḗḙḛḝḟḡḣḥḧḩḫḭḯḱḳḵḷḹḻḽḿṁṃṅṇṉṋṍṏṑṓṕṗṙṛṝṟṡṣṥṧṩṫṭṯṱṳṵṷṹṻṽṿẁẃẅẇẉẋẍẏẑẓẕạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹỻỽỿ'), '') END
$$;

-- Lượng gốc dạng thập phân chính xác — cùng hợp đồng cmsUnitQuantity / parseCmsDecimal (dấu chấm, ≤ 9 chữ số lẻ, ≤ 29 chữ số nguyên
-- sau bỏ số 0 đầu, có thể âm; không khoảng trắng / số mũ). Sai hình thức ⇒ NULL.
CREATE FUNCTION public.cms__qty_dec(p_raw text)
RETURNS numeric LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_raw ~ '^-?[0-9]+(\.[0-9]{1,9})?$'
               AND char_length(regexp_replace(substring(p_raw FROM '^-?([0-9]+)'), '^0+(?=[0-9])', '')) <= 29
              THEN p_raw::numeric END
$$;

-- Phiên bản chính sách tính của từng cơ sở (run mới). NULL ⇒ cơ sở lạ.
CREATE FUNCTION public.cms__basis_policy(p_basis text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE p_basis WHEN 'pos_base' THEN 'pos_base_v1' WHEN 'cms_unit' THEN 'cms_unit_v1' END
$$;

-- Snapshot cấu hình tính BẤT BIẾN của run (cms-calc-snapshot-v1) — DB tự dựng dưới khoá dòng chương trình của rpc_cms_sales_run_open,
-- không nhận từ caller. Không PII / mapping người dùng.
CREATE FUNCTION public.cms__calc_snapshot(p_program_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'schema', 'cms-calc-snapshot-v1',
    'quantity_basis', p.quantity_basis,
    'calculation_policy_version', public.cms__basis_policy(p.quantity_basis),
    'unit_key_version', 'cms-unit-key-v1',
    'quantity_policy', CASE p.quantity_basis WHEN 'cms_unit' THEN 'cms_unit_integer_exact_v1' ELSE 'pos_base_floor_div_k_v1' END,
    'gmv_policy', 'candidate_lines_all_units_v1',
    'config_version', p.config_version,
    'config_fp', public.cms__config_fp(p.id),
    'start_date', to_char(p.start_date, 'YYYY-MM-DD'),
    'end_date', to_char(p.end_date, 'YYYY-MM-DD'),
    'catalog_target_gmv', p.catalog_target_gmv::text,
    'products', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', pp.id, 'product_id', pp.product_id, 'unit_cms', pp.unit_cms, 'unit_key', public.cms__unit_key(pp.unit_cms),
        'base_quantity_cms', pp.base_quantity_cms::text, 'gmv_basis', pp.gmv_basis, 'target_gmv', pp.target_gmv::text,
        'tiers', COALESCE((SELECT jsonb_agg(jsonb_build_object('order', t.tier_order, 'from', t.qty_from, 'to', t.qty_to,
                                                               'amount', t.amount_per_unit::text) ORDER BY t.tier_order)
                             FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id), '[]'::jsonb))
        ORDER BY pp.product_id) FROM public.cms_program_products pp WHERE pp.program_id = p.id), '[]'::jsonb))
  FROM public.cms_programs p WHERE p.id = p_program_id
$$;

-- ── 4. Guard đổi cơ sở chương trình ─────────────────────────────────────────
-- Đổi quantity_basis chỉ khi: config_version + 1 trong CÙNG câu lệnh (run / preview / chứng nhận cũ hết hiệu lực), pointer NULL (không
-- để UI đọc số luật cũ như số luật mới), không run bán running; VÀ chương trình nháp, HOẶC chưa từng có run bán (sửa trước ngày bắt đầu
-- qua rpc_cms_program_save), HOẶC phiên datafix khai set_config('cms.basis_change_program', <id>, true). 'locked' đã bị guard 123 chặn.
CREATE FUNCTION public.cms__programs_basis_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.quantity_basis IS NOT DISTINCT FROM OLD.quantity_basis THEN
    RETURN NEW;
  END IF;
  IF NEW.config_version IS DISTINCT FROM OLD.config_version + 1 OR NEW.current_result_run_id IS NOT NULL
     OR OLD.status = 'locked' OR NEW.status = 'locked'
     OR EXISTS (SELECT 1 FROM public.cms_sync_runs r WHERE r.kind = 'sales' AND r.program_id = OLD.id AND r.status = 'running') THEN
    RAISE EXCEPTION 'CMS_PROGRAM_BASIS_CHANGE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF OLD.status = 'draft'
     OR NOT EXISTS (SELECT 1 FROM public.cms_sync_runs r WHERE r.kind = 'sales' AND r.program_id = OLD.id)
     OR current_setting('cms.basis_change_program', true) IS NOT DISTINCT FROM OLD.id::text THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'CMS_PROGRAM_BASIS_CHANGE_INVALID' USING ERRCODE = '22023';
END;
$$;
CREATE TRIGGER cms_programs_basis_guard BEFORE UPDATE OF quantity_basis ON public.cms_programs
  FOR EACH ROW EXECUTE FUNCTION public.cms__programs_basis_guard();
ALTER TABLE public.cms_programs ENABLE ALWAYS TRIGGER cms_programs_basis_guard;

-- ── 5. Guard metadata run ────────────────────────────────────────────────────
-- INSERT run bán: phải có cơ sở + chính sách v1 + snapshot đúng cơ sở (nhãn legacy chỉ cho run trước 128). UPDATE: ba cột BẤT BIẾN
-- (caller không sửa được qua finish / stage / publish / owner ghi thẳng — muốn đổi phải tạo run mới).
CREATE FUNCTION public.cms__runs_basis_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind = 'sales' AND (NEW.quantity_basis IS NULL OR NEW.calculation_snapshot IS NULL
                               OR NEW.calculation_policy_version IS DISTINCT FROM public.cms__basis_policy(NEW.quantity_basis)) THEN
      RAISE EXCEPTION 'CMS_RUN_BASIS_INVALID' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.quantity_basis IS DISTINCT FROM OLD.quantity_basis
     OR NEW.calculation_policy_version IS DISTINCT FROM OLD.calculation_policy_version
     OR NEW.calculation_snapshot IS DISTINCT FROM OLD.calculation_snapshot THEN
    RAISE EXCEPTION 'CMS_RUN_BASIS_IMMUTABLE' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cms_sync_runs_basis_guard BEFORE INSERT OR UPDATE ON public.cms_sync_runs
  FOR EACH ROW EXECUTE FUNCTION public.cms__runs_basis_guard();
ALTER TABLE public.cms_sync_runs ENABLE ALWAYS TRIGGER cms_sync_runs_basis_guard;

-- ── 6. Mười lăm hàm thay (thân nguyên văn bản cuối + vá gen-cms-128) ──────────
CREATE OR REPLACE FUNCTION public.cms__sales_snapshot(p_program_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'program_id', p.id,
    'status', p.status,
    'is_test', p.is_test,
    'config_version', p.config_version,
    -- 128: cơ sở tính / phiên bản chính sách của chương trình + phiên bản khoá đơn vị (run mới ghi cùng giá trị trong metadata run).
    'quantity_basis', p.quantity_basis,
    'calculation_policy_version', public.cms__basis_policy(p.quantity_basis),
    'unit_key_version', 'cms-unit-key-v1',
    'start_date', to_char(p.start_date, 'YYYY-MM-DD'),
    'end_date', to_char(p.end_date, 'YYYY-MM-DD'),
    'catalog_target_gmv', p.catalog_target_gmv::text,
    'today_vn', to_char(public.cms__vn_today(), 'YYYY-MM-DD'),
    'current_result_run_id', p.current_result_run_id,
    'previous_rows_read', (SELECT r.rows_read FROM public.cms_sync_runs r WHERE r.id = p.current_result_run_id),
    'store_ids', COALESCE((SELECT jsonb_agg(ps.store_id ORDER BY ps.store_id) FROM public.cms_program_stores ps
                            WHERE ps.program_id = p.id), '[]'::jsonb),
    'products', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', pp.id, 'product_id', pp.product_id, 'gmv_basis', pp.gmv_basis, 'target_gmv', pp.target_gmv::text,
        'base_quantity_cms', pp.base_quantity_cms::text, 'unit_cms', pp.unit_cms,
        'tiers', COALESCE((SELECT jsonb_agg(jsonb_build_object('order', t.tier_order, 'from', t.qty_from, 'to', t.qty_to,
                                                               'amount', t.amount_per_unit::text) ORDER BY t.tier_order)
                             FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id), '[]'::jsonb))
        ORDER BY pp.product_id) FROM public.cms_program_products pp WHERE pp.program_id = p.id), '[]'::jsonb),
    'sellers', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email, 'role', u.role, 'store_id', u.store_id)
                                          ORDER BY u.id) FROM public.users u), '[]'::jsonb),
    'stores', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'store_type', s.store_type, 'is_active', s.is_active)
                                         ORDER BY s.id) FROM public.stores s), '[]'::jsonb),
    'mapping_fp', public.cms__mapping_fp())
  FROM public.cms_programs p WHERE p.id = p_program_id
$$;

CREATE OR REPLACE FUNCTION public.cms__config_fp(p_program_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT md5(
    COALESCE((SELECT ROW(p.id, p.name, p.start_date, p.end_date, p.scope, p.catalog_target_gmv, p.calc_mode, p.gate_scope,
                         p.is_test, p.config_version)::text
                FROM public.cms_programs p WHERE p.id = p_program_id), '')
    || chr(29) ||
    COALESCE((SELECT string_agg(ROW(pp.id, pp.product_id, pp.gmv_basis, pp.target_gmv, pp.unit_cms, pp.base_quantity_cms)::text,
                                chr(30) ORDER BY pp.id)
                FROM public.cms_program_products pp WHERE pp.program_id = p_program_id), '')
    || chr(29) ||
    COALESCE((SELECT string_agg(ROW(t.program_product_id, t.tier_order, t.qty_from, t.qty_to, t.amount_per_unit)::text,
                                chr(30) ORDER BY t.program_product_id, t.tier_order)
                FROM public.cms_program_tiers t WHERE t.program_id = p_program_id), '')
    || chr(29) ||
    COALESCE((SELECT string_agg(s.store_id::text, chr(30) ORDER BY s.store_id)
                FROM public.cms_program_stores s WHERE s.program_id = p_program_id), '')
    -- 128: cơ sở tính chỉ góp vào vân tay khi khác pos_base (giữ nguyên giá trị cũ của mọi chương trình pos_base).
    || COALESCE((SELECT chr(29) || 'quantity_basis=' || p.quantity_basis FROM public.cms_programs p
                  WHERE p.id = p_program_id AND p.quantity_basis <> 'pos_base'), ''))
$$;

CREATE OR REPLACE FUNCTION public.cms__attest_eval(p_program_id uuid, p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a    public.cms_source_attestations%ROWTYPE;
  v_run  public.cms_sync_runs%ROWTYPE;
  v_prog public.cms_programs%ROWTYPE;
  v_code text;
BEGIN
  -- 128 (PM §3.4): decision10 không ràng buộc quantity_raw / uom_raw — trường quyết định tiền của run cms_unit ⇒ không dùng chứng nhận.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs r WHERE r.id = p_run_id AND r.quantity_basis IS DISTINCT FROM 'pos_base') THEN
    RETURN jsonb_build_object('code', 'CMS_UNIT_ATTESTATION_NOT_SUPPORTED');
  END IF;
  SELECT * INTO v_a FROM public.cms_source_attestations
   WHERE run_id = p_run_id AND program_id = p_program_id AND revoked_at IS NULL AND superseded_by IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('code', 'NONE'); END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id;
  -- Kiểm lại MỌI trường quyết định của dòng chứng nhận (phòng dòng owner ghi thẳng — db-reviewer r2 P2-3).
  v_code := CASE
    WHEN v_run.config_version IS DISTINCT FROM v_a.config_version OR v_prog.config_version IS DISTINCT FROM v_a.config_version THEN 'STALE_CONFIG'
    WHEN v_run.mapping_fp IS DISTINCT FROM v_a.mapping_fp OR public.cms__mapping_fp() IS DISTINCT FROM v_a.mapping_fp THEN 'STALE_MAPPING'
    WHEN v_a.scope_from IS DISTINCT FROM v_prog.start_date OR v_a.scope_to IS DISTINCT FROM v_prog.end_date
      OR public.cms__program_scope_hash(p_program_id) IS DISTINCT FROM v_a.scope_hash THEN 'STALE_SCOPE'
    WHEN v_a.as_of < ((v_prog.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') THEN 'AS_OF'
  END;
  IF v_code IS NULL THEN v_code := public.cms__run_source_check(p_run_id); END IF;
  IF v_code IS NULL AND v_a.lines_compared IS DISTINCT FROM (SELECT count(*) FROM public.cms_sales_source_lines WHERE run_id = p_run_id) THEN
    v_code := 'COUNT';
  END IF;
  -- Phòng thủ (PM COMP-P1-1): chỉ decision10 là bằng chứng; vân tay luôn tính lại decision10 từ lớp nguồn DB.
  IF v_code IS NULL AND v_a.field_set IS DISTINCT FROM 'decision10' THEN v_code := 'FIELD_SET'; END IF;
  IF v_code IS NULL AND public.cms__run_source_fp(p_run_id, 'decision10') IS DISTINCT FROM v_a.run_rows_fp THEN
    v_code := 'FP_CHANGED';
  END IF;
  RETURN jsonb_build_object('id', v_a.id, 'scope_to', to_char(v_a.scope_to, 'YYYY-MM-DD'), 'field_set', v_a.field_set,
                            'attested_at', public.cms__ts(v_a.attested_at), 'as_of', public.cms__ts(v_a.as_of), 'code', v_code);
END;
$$;

CREATE OR REPLACE FUNCTION public.cms__lock_eval(p_program_id uuid, p_expected_run_id uuid, p_expected_policy_version integer,
                                      p_ack_reason text, p_require_ack boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog     public.cms_programs%ROWTYPE;
  v_run      public.cms_sync_runs%ROWTYPE;
  v_pol      jsonb := public.cms__lock_policy();
  v_ver      integer;
  v_br       jsonb;
  v_b        text[] := '{}';
  v_end_vn   timestamptz;
  v_earliest timestamptz;
  v_basis    text;
  v_through  date;
  v_fp_now   text;
  v_sum      numeric;
  v_rows     integer;
  v_paid     integer;
  v_multi    integer;
  v_cl       integer := 0;
  v_cg       numeric := 0;
  v_ul       integer := 0;
  v_ug       numeric := 0;
  v_over     boolean := false;
  v_ack_need boolean := false;
  v_ack_ok   boolean;
  v_pol_ok   boolean;
  v_sealed_ok boolean;
  v_att      jsonb := jsonb_build_object('code', 'NONE');  -- 124
  v_att_ok   boolean;                                       -- 124
BEGIN
  v_ver := (v_pol ->> 'version')::integer;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('program_id', p_program_id, 'found', false, 'blockers', jsonb_build_array('CMS_PROGRAM_NOT_FOUND'));
  END IF;
  v_br := CASE WHEN v_prog.is_test THEN v_pol -> 'qa' ELSE v_pol -> 'real' END;
  v_end_vn := ((v_prog.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
  -- 2–3. trạng thái / hết kỳ
  IF v_prog.status = 'locked' THEN
    v_b := array_append(v_b, 'CMS_PROGRAM_LOCKED');
  ELSIF v_prog.status <> 'active' OR v_prog.end_date >= public.cms__vn_today() THEN
    v_b := array_append(v_b, 'CMS_LOCK_NOT_ENDED');
  END IF;
  -- 4. Q-206: chương trình thật cần cổng công bố DB mở
  IF NOT v_prog.is_test AND NOT public.cms__results_release_open() THEN
    v_b := array_append(v_b, 'CMS_LOCK_RELEASE_GATE');
  END IF;
  -- 5. pointer
  IF v_prog.current_result_run_id IS NULL THEN
    v_b := array_append(v_b, 'CMS_LOCK_NO_RESULT');
  ELSIF p_expected_run_id IS NOT NULL AND v_prog.current_result_run_id <> p_expected_run_id THEN
    v_b := array_append(v_b, 'CMS_LOCK_RUN_CHANGED');
  END IF;
  IF v_prog.current_result_run_id IS NOT NULL THEN
    SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = v_prog.current_result_run_id;
    -- 6. run hiện hành phải là run sales đã công bố, chưa dọn, cùng config_version / is_test
    IF v_run.kind IS DISTINCT FROM 'sales' OR v_run.status IS DISTINCT FROM 'ok' OR v_run.published_at IS NULL
       OR v_run.purged_at IS NOT NULL OR v_run.config_version IS DISTINCT FROM v_prog.config_version
       OR v_run.is_test IS DISTINCT FROM v_prog.is_test OR v_run.amount_vnd IS NULL THEN
      v_b := array_append(v_b, 'CMS_LOCK_STALE_RUN');
    END IF;
    -- 128 (PM §3.4): chứng nhận / cơ sở chốt hiện có chỉ cho run pos_base — run cms_unit (kể cả QA) không chốt được ở phase này.
    IF v_run.quantity_basis IS DISTINCT FROM 'pos_base' THEN
      v_b := array_append(v_b, 'CMS_UNIT_ATTESTATION_NOT_SUPPORTED');
    END IF;
  END IF;
  -- 7. policy
  IF p_expected_policy_version IS NOT NULL AND p_expected_policy_version <> v_ver THEN
    v_b := array_append(v_b, 'CMS_LOCK_POLICY_CHANGED');
  END IF;
  -- Nhánh policy dùng được: QA (giả định gắn nhãn) hoặc thật đã ready; ĐỦ khoá ngưỡng / chờ / nguồn — thiếu ⇒ pending
  -- (db-reviewer P2-2: mở nhánh thật mà quên một khoá thì không lọt chốt không kiểm ngưỡng).
  -- COALESCE: khoá thiếu ⇒ jsonb_typeof(NULL) = … là NULL — không để NULL lọt qua IF NOT (test 123 bắt được).
  v_pol_ok := COALESCE((v_prog.is_test OR COALESCE((v_br ->> 'ready')::boolean, false))
              AND jsonb_typeof(v_br -> 'unassigned_max_gmv_bp') = 'number' AND jsonb_typeof(v_br -> 'unassigned_max_lines') = 'number'
              AND jsonb_typeof(v_br -> 'wait_hours') = 'number' AND jsonb_typeof(v_br -> 'completeness') = 'string'
              -- số nguyên không âm (db-reviewer r0.1 finding 2): phân số ⇒ lỗi ép kiểu thô; wait_hours âm ⇒ chốt trước hết kỳ.
              AND (v_br ->> 'unassigned_max_gmv_bp') ~ '^[0-9]{1,6}$' AND (v_br ->> 'unassigned_max_lines') ~ '^[0-9]{1,6}$'
              AND (v_br ->> 'wait_hours') ~ '^[0-9]{1,4}$', false);
  IF NOT v_pol_ok THEN
    v_b := array_append(v_b, 'CMS_LOCK_POLICY_PENDING');
  END IF;
  IF v_run.id IS NOT NULL THEN
    -- 8. thời điểm (+ chờ Q-216 theo policy) + nguồn đầy đủ (D3). 'qa_assumption' chỉ cho QA; cơ sở thật (bi_watermark /
    --    lag_commitment) chưa có nơi lưu chứng nhận gắn run ⇒ chặn cho tới migration hợp đồng nguồn.
    v_earliest := v_end_vn + make_interval(hours => CASE WHEN v_pol_ok THEN (v_br ->> 'wait_hours')::integer ELSE 0 END);
    v_basis := CASE WHEN v_pol_ok THEN v_br ->> 'completeness' END;
    IF v_run.started_at < v_earliest THEN
      v_b := array_append(v_b, 'CMS_LOCK_RUN_TOO_EARLY');
    END IF;
    -- 124: chứng nhận đối soát nguồn decision10 CÒN HIỆU LỰC của đúng run hiện hành, kiểm lại config / mapping / scope / lớp nguồn
    -- / vân tay ⇒ basis operator_reconciliation, đủ tới ngày kết thúc. Chỉ dùng khi chương trình QA, hoặc policy thật đã sẵn sàng
    -- VÀ khai completeness = 'operator_reconciliation' (không để chứng nhận vượt policy khai cơ sở khác). Thật hiện real.ready =
    -- false ⇒ không dùng ⇒ SOURCE_INCOMPLETE + POLICY_PENDING; cổng Q-206 vẫn đóng.
    -- Có chứng nhận nhưng không dùng được ⇒ CMS_LOCK_ATTEST_INVALID (KHÔNG âm thầm lùi về qa_assumption). Không có ⇒ như 123.
    v_att := public.cms__attest_eval(v_prog.id, v_run.id);
    v_att_ok := v_prog.is_test OR (v_pol_ok AND (v_br ->> 'completeness') = 'operator_reconciliation');
    IF v_att_ok AND (v_att ->> 'code') IS NULL THEN
      v_basis := 'operator_reconciliation';
      v_through := (v_att ->> 'scope_to')::date;
    ELSIF v_att_ok AND (v_att ->> 'code') <> 'NONE' THEN
      v_basis := NULL;  -- không báo qa_assumption khi chứng nhận có nhưng hỏng
      v_b := array_append(v_b, 'CMS_LOCK_ATTEST_INVALID');
    ELSIF v_basis IS NULL OR v_basis <> 'qa_assumption' OR NOT v_prog.is_test THEN
      -- policy khai operator_reconciliation nhưng chưa có chứng nhận dùng được ⇒ không báo basis đó (db-reviewer r2 P2-9).
      IF v_basis = 'operator_reconciliation' THEN v_basis := NULL; END IF;
      v_b := array_append(v_b, 'CMS_LOCK_SOURCE_INCOMPLETE');
    END IF;
    -- mapping (kiểm sớm; RPC chốt kiểm lại sau khi chép định danh — bước 11)
    v_fp_now := public.cms__mapping_fp();
    IF v_fp_now IS DISTINCT FROM v_run.mapping_fp THEN
      v_b := array_append(v_b, 'CMS_LOCK_STALE_MAPPING');
    END IF;
    -- tổng run = Σ cms_results; staff_rows / staff_paid; mỗi dược sĩ đúng một nhà thuốc trong run
    SELECT COALESCE(sum(a.amt), 0), count(*), count(*) FILTER (WHERE a.amt > 0), count(*) FILTER (WHERE a.n_store <> 1)
      INTO v_sum, v_rows, v_paid, v_multi
      FROM (SELECT r.user_id, sum(r.amount_vnd) AS amt, count(DISTINCT r.store_id) AS n_store
              FROM public.cms_results r WHERE r.run_id = v_run.id GROUP BY r.user_id) a;
    -- Đối chiếu lại với seal (db-reviewer P2-1): số dòng 4 bảng + số khối / Σ row_count từng phần = seal_expect; Σ tiền dòng =
    -- tổng run ⇒ run "đóng băng" đúng là run đã seal, không thiếu dòng bị xoá trực tiếp trước khi chốt.
    SELECT (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'sales_lines')::bigint
       AND (SELECT count(*) FROM public.cms_results WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'results')::bigint
       AND (SELECT count(*) FROM public.cms_result_catalog WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'catalog')::bigint
       AND (SELECT count(*) FROM public.cms_result_lines WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'result_lines')::bigint
       AND NOT EXISTS (
         SELECT 1 FROM (VALUES ('sales_lines'), ('results'), ('catalog'), ('result_lines')) k(part)
           LEFT JOIN (SELECT ch.part, count(*) AS n, sum(ch.row_count) AS rows FROM public.cms_sync_run_chunks ch
                       WHERE ch.run_id = v_run.id GROUP BY ch.part) x ON x.part = k.part
          WHERE COALESCE(x.n, 0) IS DISTINCT FROM (v_run.seal_expect -> 'chunks' ->> k.part)::bigint
             OR COALESCE(x.rows, 0) IS DISTINCT FROM (v_run.seal_expect ->> k.part)::bigint)
       AND (SELECT COALESCE(sum(l.amount_vnd), 0) FROM public.cms_result_lines l WHERE l.run_id = v_run.id) = v_run.amount_vnd::numeric
      INTO v_sealed_ok;
    IF v_sum IS DISTINCT FROM v_run.amount_vnd::numeric OR v_multi > 0 OR v_sealed_ok IS NOT TRUE THEN
      v_b := array_append(v_b, 'CMS_LOCK_TOTAL_MISMATCH');
    END IF;
    -- 9. Q-213 (a, b, b', c / f, d / e): mẫu số = dòng ứng viên trừ OUT_OF_SCOPE, GMV dương; tử = dòng UNASSIGNED.
    SELECT count(*) FILTER (WHERE s.disposition <> 'OUT_OF_SCOPE'),
           COALESCE(sum(s.gmv_amount) FILTER (WHERE s.disposition <> 'OUT_OF_SCOPE' AND s.gmv_amount > 0), 0),
           count(*) FILTER (WHERE s.disposition = 'UNASSIGNED'),
           COALESCE(sum(s.gmv_amount) FILTER (WHERE s.disposition = 'UNASSIGNED' AND s.gmv_amount > 0), 0)
      INTO v_cl, v_cg, v_ul, v_ug
      FROM public.cms_sales_lines s WHERE s.run_id = v_run.id;
    IF v_ug > 0 AND v_cg = 0 THEN
      v_b := array_append(v_b, 'CMS_LOCK_POLICY_DATA');   -- b': tử > 0 mà mẫu = 0 ⇒ dữ liệu / policy lỗi, không chia 0
    ELSIF v_pol_ok THEN
      v_over := v_ug * 10000 > v_cg * (v_br ->> 'unassigned_max_gmv_bp')::numeric
                OR v_ul > (v_br ->> 'unassigned_max_lines')::integer;
      IF v_over THEN v_b := array_append(v_b, 'CMS_LOCK_UNASSIGNED_OVER'); END IF;
    END IF;
    v_ack_need := v_ul > 0 AND NOT v_over;
    -- Cắt đủ khoảng trắng ASCII như 121 (db-reviewer P2-6): 10 ký tự xuống dòng không phải lý do.
    v_ack_ok := p_ack_reason IS NOT NULL AND char_length(btrim(p_ack_reason, E' \t\r\n\f\v')) BETWEEN 10 AND 1000;
    IF p_require_ack AND v_ack_need AND NOT v_ack_ok THEN
      v_b := array_append(v_b, 'CMS_LOCK_ACK_REQUIRED');
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'program_id', v_prog.id, 'found', true, 'status', v_prog.status, 'is_test', v_prog.is_test,
    'end_date', to_char(v_prog.end_date, 'YYYY-MM-DD'), 'config_version', v_prog.config_version,
    'run_id', v_run.id, 'run_started_at', public.cms__ts(v_run.started_at),
    'amount_vnd', v_run.amount_vnd::text, 'results_amount_vnd', v_sum::text,
    'staff_rows', v_rows, 'staff_paid', v_paid,
    'candidate_lines', v_cl, 'candidate_gmv', v_cg::text, 'unassigned_lines', v_ul, 'unassigned_gmv', v_ug::text,
    'unassigned_over', v_over, 'needs_ack', v_ack_need,
    'policy', v_br, 'policy_version', v_ver,
    'mapping_fp_run', v_run.mapping_fp, 'mapping_fp_now', v_fp_now,
    'source_complete_basis', v_basis, 'source_complete_through', to_char(v_through, 'YYYY-MM-DD'),
    'source_attestation', v_att,
    'earliest_lock_at', public.cms__ts(v_earliest),
    'blockers', to_jsonb(v_b));
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_program_save(p jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_id      uuid;
  v_prog    public.cms_programs%ROWTYPE;
  v_name    text;
  v_start   date;
  v_end     date;
  v_scope   text;
  v_stores  uuid[];
  v_actor   uuid;
  v_today   date := public.cms__vn_today();
  v_ids     text[];
  v_basis   text;  -- 128
BEGIN
  IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p->'name') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p->'start_date') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'end_date') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p->'scope') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'actor') IS DISTINCT FROM 'string'
     OR COALESCE(jsonb_typeof(p->'id'), 'null') NOT IN ('string', 'null')
     OR COALESCE(jsonb_typeof(p->'store_ids'), 'null') NOT IN ('array', 'null') THEN
    RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF (p->>'start_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR (p->>'end_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR (p->>'actor') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (jsonb_typeof(p->'id') = 'string' AND (p->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- 128: cơ sở tính tuỳ chọn — thiếu ⇒ tạo pos_base / sửa GIỮ NGUYÊN (payload cũ tương thích, không âm thầm đổi luật); lạ ⇒
  -- BAD_INPUT. Đổi cơ sở chỉ hợp lệ khi guard cms_programs_basis_guard cho phép (nháp / chưa có run bán).
  IF p ? 'quantity_basis' THEN
    IF jsonb_typeof(p->'quantity_basis') IS DISTINCT FROM 'string' OR (p->>'quantity_basis') NOT IN ('pos_base', 'cms_unit') THEN
      RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
    END IF;
    v_basis := p->>'quantity_basis';
  END IF;
  IF jsonb_typeof(p->'store_ids') = 'array' THEN
    IF jsonb_array_length(p->'store_ids') > 500 OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p->'store_ids') x
          WHERE jsonb_typeof(x) IS DISTINCT FROM 'string'
             OR (x #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
    END IF;
  END IF;
  -- Cắt mọi khoảng trắng (kể cả tab / xuống dòng) — tên chỉ có khoảng trắng ⇒ lỗi.
  v_name := btrim(p->>'name', E' \t\r\n\f\v');
  BEGIN
    v_start := (p->>'start_date')::date;
    v_end := (p->>'end_date')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
  END;
  v_scope := p->>'scope';
  v_actor := (p->>'actor')::uuid;
  -- Khoảng ngày hợp lý về kỹ thuật (chặn gõ nhầm năm). Không trần độ dài kỳ (Q-215, operator chốt 01/11).
  IF char_length(v_name) NOT BETWEEN 1 AND 200 OR v_end < v_start OR v_scope NOT IN ('all', 'stores')
     OR v_start < DATE '2020-01-01' OR v_end > DATE '2100-12-31' THEN
    RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT (x)::uuid), '{}'::uuid[]) INTO v_stores
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p->'store_ids') = 'array' THEN p->'store_ids' ELSE '[]'::jsonb END) x;
  IF v_scope = 'stores' THEN
    IF cardinality(v_stores) = 0
       OR (SELECT count(*) FROM public.stores s WHERE s.id = ANY (v_stores) AND s.store_type = 'os' AND s.is_active) <> cardinality(v_stores) THEN
      RAISE EXCEPTION 'CMS_PROGRAM_STORE_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF NOT (p ? 'id') OR jsonb_typeof(p->'id') = 'null' THEN
    -- Tạo nháp. is_test do server quyết (marker QA của người tạo) — không đổi về sau (trigger 120).
    IF jsonb_typeof(p->'is_test') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_programs (name, start_date, end_date, scope, is_test, created_by, updated_by, quantity_basis)
    VALUES (v_name, v_start, v_end, v_scope, (p->>'is_test')::boolean, v_actor, v_actor, COALESCE(v_basis, 'pos_base'))
    RETURNING id INTO v_id;
    IF v_scope = 'stores' THEN
      INSERT INTO public.cms_program_stores (program_id, store_id) SELECT v_id, x FROM unnest(v_stores) x;
    END IF;
    RETURN v_id;
  END IF;

  -- Sửa: khoá dòng chương trình, kiểm trạng thái + ngày VN TRONG transaction.
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = (p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (v_prog.status = 'draft' OR (v_prog.status = 'active' AND v_today < v_prog.start_date)) THEN
    RAISE EXCEPTION 'CMS_PROGRAM_NOT_EDITABLE' USING ERRCODE = 'P0001';
  END IF;
  IF v_prog.status = 'active' THEN
    -- Q-214 (operator chốt 01/11): chặn dời ngày bắt đầu của chương trình đã kích hoạt về hôm nay / quá khứ VN.
    IF v_start <= v_today THEN
      RAISE EXCEPTION 'CMS_PROGRAM_START_PAST' USING ERRCODE = 'P0001';
    END IF;
    IF v_scope = 'all' THEN
      SELECT COALESCE(array_agg(s.id), '{}'::uuid[]) INTO v_stores FROM public.stores s WHERE s.store_type = 'os' AND s.is_active;
      IF cardinality(v_stores) = 0 THEN RAISE EXCEPTION 'CMS_PROGRAM_STORE_INVALID' USING ERRCODE = '22023'; END IF;
    END IF;
    PERFORM public.cms__lock_catalog();
    SELECT COALESCE(array_agg(product_id), '{}'::text[]) INTO v_ids FROM public.cms_program_products WHERE program_id = v_prog.id;
    IF cardinality(public.cms__conflicts(v_prog.id, v_prog.is_test, v_start, v_end, v_ids)) > 0 THEN
      RAISE EXCEPTION 'CMS_PROGRAM_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  UPDATE public.cms_programs
     SET name = v_name, start_date = v_start, end_date = v_end, scope = v_scope, quantity_basis = COALESCE(v_basis, quantity_basis),
         config_version = config_version + 1, updated_by = v_actor, updated_at = now()
   WHERE id = v_prog.id;
  DELETE FROM public.cms_program_stores WHERE program_id = v_prog.id;
  IF v_scope = 'stores' OR v_prog.status = 'active' THEN
    INSERT INTO public.cms_program_stores (program_id, store_id) SELECT v_prog.id, x FROM unnest(v_stores) x;
  END IF;
  RETURN v_prog.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_open(p_program_id uuid, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_prog public.cms_programs%ROWTYPE;
  v_snap jsonb;
  v_id   uuid;
  v_sch  smallint;  -- 124
  v_calc jsonb;     -- 128
BEGIN
  IF p_program_id IS NULL THEN RAISE EXCEPTION 'CMS_SALES_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  IF p_detail IS NULL OR jsonb_typeof(p_detail) <> 'object' OR pg_column_size(p_detail) > 4096 THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_DETAIL' USING ERRCODE = '22023';
  END IF;
  -- 128: metadata tính do DB ghi — caller không gửi khoá trùng tên qua detail (không để reader nhầm nguồn).
  IF p_detail ?| ARRAY['quantity_basis', 'calculation_policy_version', 'calculation_snapshot'] THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_DETAIL' USING ERRCODE = '22023';
  END IF;
  -- Khoá dòng chương trình: chặn ghi cấu hình (121 khoá FOR UPDATE) trong lúc chụp snapshot ⇒ config_version khớp dữ liệu.
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_prog.status = 'locked' THEN RAISE EXCEPTION 'CMS_PROGRAM_LOCKED' USING ERRCODE = 'P0001'; END IF;
  IF v_prog.status <> 'active' THEN RAISE EXCEPTION 'CMS_SALES_PROGRAM_NOT_ACTIVE' USING ERRCODE = 'P0001'; END IF;
  -- Chỉ tính khi đã bắt đầu: trước ngày bắt đầu danh mục còn nạp lại (replace xoá SP) — không giữ tham chiếu snapshot.
  IF public.cms__vn_today() < v_prog.start_date THEN
    RAISE EXCEPTION 'CMS_SALES_NOT_STARTED' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cms_sales_run:' || p_program_id::text, 0));
  UPDATE public.cms_sync_runs SET status = 'error', finished_at = now(), error_code = 'STALE'
   WHERE kind = 'sales' AND program_id = p_program_id AND status = 'running' AND started_at < now() - interval '30 minutes';
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = p_program_id AND status = 'running') THEN
    RAISE EXCEPTION 'CMS_SYNC_BUSY' USING ERRCODE = 'P0001';
  END IF;
  v_snap := public.cms__sales_snapshot(p_program_id);
  -- 128: snapshot cấu hình tính BẤT BIẾN của run — DB tự dựng dưới khoá dòng chương trình (không từ caller). cms_unit cần khoá đơn
  -- vị hợp lệ cho MỌI SP (unit_cms có ký tự điều khiển / rỗng ⇒ không mở run, không lùi về luật cũ).
  v_calc := public.cms__calc_snapshot(p_program_id);
  IF v_prog.quantity_basis = 'cms_unit' AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_calc -> 'products') e
                                                     WHERE jsonb_typeof(e -> 'unit_key') IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION 'CMS_SALES_UNIT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.cms_sync_runs (kind, program_id, config_version, is_test, mapping_fp, detail,
                                    quantity_basis, calculation_policy_version, calculation_snapshot)
  VALUES ('sales', p_program_id, v_prog.config_version, v_prog.is_test, v_snap ->> 'mapping_fp', p_detail,
          v_prog.quantity_basis, public.cms__basis_policy(v_prog.quantity_basis), v_calc)
  RETURNING id, source_schema INTO v_id, v_sch;
  -- 124: capability lớp nguồn = giá trị THỰC của run vừa INSERT (DEFAULT 1 sau 124) — app không tự suy.
  RETURN v_snap || jsonb_build_object('run_id', v_id, 'source_schema', v_sch, 'calculation_snapshot', v_calc);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_seal_begin(p_run_id uuid, p_expect jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_run   public.cms_sync_runs%ROWTYPE;
  v_prog  public.cms_programs%ROWTYPE;
  v_part  text;
  v_n     bigint;
  c_cnt   CONSTANT text := '^(0|[1-9][0-9]{0,8})$';
BEGIN
  IF p_expect IS NULL OR jsonb_typeof(p_expect) <> 'object' OR pg_column_size(p_expect) > 65536
     OR NOT public.cms__str(p_expect, 'amount_vnd', '^(0|[1-9][0-9]{0,18})$')
     OR NOT public.cms__str_or_null(p_expect, 'source_max_updated_at', '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$')
     OR jsonb_typeof(p_expect -> 'chunks') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_expect -> 'totals') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['sales_lines', 'results', 'catalog', 'result_lines', 'rows_read', 'rows_rejected']) k
                 WHERE jsonb_typeof(p_expect -> k) IS DISTINCT FROM 'number' OR (p_expect ->> k) !~ c_cnt)
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['sales_lines', 'results', 'catalog', 'result_lines']) k
                 WHERE jsonb_typeof(p_expect -> 'chunks' -> k) IS DISTINCT FROM 'number' OR (p_expect -> 'chunks' ->> k) !~ c_cnt)
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['lines_read', 'candidates', 'included', 'unassigned', 'out_of_scope', 'adjustment_lines']) k
                 WHERE jsonb_typeof(p_expect -> 'totals' -> k) IS DISTINCT FROM 'number' OR (p_expect -> 'totals' ->> k) !~ c_cnt)
     OR NOT public.cms__str(p_expect -> 'totals', 'candidate_gmv', '^-?[0-9]{1,35}(\.[0-9]{1,9})?$')
     OR NOT public.cms__str(p_expect -> 'totals', 'unassigned_gmv', '^-?[0-9]{1,35}(\.[0-9]{1,9})?$')
     OR NOT public.cms__str(p_expect -> 'totals', 'amount_vnd', '^(0|[1-9][0-9]{0,18})$')
     -- totals chỉ gồm khoá đã biết (hiển thị cho super — db-reviewer r2 N5); hai bảng lý do: khoá trong enum, giá trị số đếm.
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_expect -> 'totals') k
                 WHERE k NOT IN ('lines_read', 'candidates', 'included', 'unassigned', 'out_of_scope', 'adjustment_lines',
                                 'candidate_gmv', 'unassigned_gmv', 'amount_vnd', 'unassigned_by_reason', 'excluded_by_reason'))
     OR jsonb_typeof(p_expect -> 'totals' -> 'unassigned_by_reason') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_expect -> 'totals' -> 'excluded_by_reason') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(p_expect -> 'totals' -> 'unassigned_by_reason') e
                 WHERE e.key NOT IN ('NO_EMAIL', 'NOT_FOUND', 'MULTIPLE', 'SHARED_ACCOUNT', 'NOT_STAFF', 'STORE_NOT_ELIGIBLE')
                    OR jsonb_typeof(e.value) <> 'number' OR e.value::text !~ c_cnt)
     OR EXISTS (SELECT 1 FROM jsonb_each(p_expect -> 'totals' -> 'excluded_by_reason') e
                 WHERE e.key NOT IN ('ORDER_NOT_ELIGIBLE', 'OUT_OF_WINDOW', 'PRODUCT_NOT_IN_PROGRAM', 'UNASSIGNED', 'OUT_OF_SCOPE')
                    OR jsonb_typeof(e.value) <> 'number' OR e.value::text !~ c_cnt)
     OR (p_expect ? 'bytes_processed' AND jsonb_typeof(p_expect -> 'bytes_processed') <> 'null'
         AND (p_expect ->> 'bytes_processed') !~ '^(0|[1-9][0-9]{0,17})$') THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END IF;
  -- Ngày qua regex nhưng không tồn tại (30/02, năm 0000) ⇒ mã CMS, không lỗi ép kiểu thô 22008 ở bước 10 (db-reviewer r2 N4).
  BEGIN
    PERFORM NULLIF(p_expect ->> 'source_max_updated_at', '')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.kind <> 'sales' OR v_run.status <> 'running' THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.seal_expect IS NOT NULL OR v_run.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'CMS_SEAL_STARTED' USING ERRCODE = 'P0001'; END IF;
  IF v_run.started_at < now() - interval '30 minutes' THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'STALE'); END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_run.program_id;
  IF v_prog.status = 'locked' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_LOCKED'); END IF;
  IF v_prog.status <> 'active' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_NOT_ACTIVE'); END IF;
  IF v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN
    RETURN public.cms__seal_fail(p_run_id, 'held', 'CONFIG_CHANGED');
  END IF;
  IF public.cms__mapping_fp() <> v_run.mapping_fp THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'MAPPING_CHANGED'); END IF;
  -- 128: metadata tính của run (DB ghi lúc open, bất biến) phải hợp lệ; cơ sở + TOÀN BỘ snapshot cấu hình tính của run = snapshot dựng
  -- lại từ chương trình HIỆN TẠI (đổi cơ sở / đơn vị / khoá đơn vị / K / bậc / phạm vi mà lọt config_version ⇒ vẫn held; snapshot ghi
  -- ngoài RPC với unit_key / phiên bản khoá lệch nhưng config_fp đúng ⇒ held — db-reviewer 09/11 P2-1).
  IF v_run.quantity_basis IS NULL OR v_run.calculation_snapshot IS NULL
     OR v_run.calculation_policy_version IS DISTINCT FROM public.cms__basis_policy(v_run.quantity_basis) THEN
    RETURN public.cms__seal_fail(p_run_id, 'error', 'RUN_BASIS_INVALID');
  END IF;
  IF v_prog.quantity_basis IS DISTINCT FROM v_run.quantity_basis
     OR v_run.calculation_snapshot IS DISTINCT FROM public.cms__calc_snapshot(v_run.program_id) THEN
    RETURN public.cms__seal_fail(p_run_id, 'held', 'CONFIG_CHANGED');
  END IF;
  -- 128: DẤU WRITER — expect phải khai đúng cơ sở + phiên bản chính sách của run. Writer cũ (không khai) chỉ hợp lệ với pos_base:
  -- run cms_unit seal bằng writer không biết luật mới ⇒ held, dù số tiền tình cờ bằng nhau.
  IF (p_expect ? 'quantity_basis' OR p_expect ? 'calculation_policy_version' OR v_run.quantity_basis <> 'pos_base')
     AND (jsonb_typeof(p_expect -> 'quantity_basis') IS DISTINCT FROM 'string'
          OR jsonb_typeof(p_expect -> 'calculation_policy_version') IS DISTINCT FROM 'string'
          OR (p_expect ->> 'quantity_basis') IS DISTINCT FROM v_run.quantity_basis
          OR (p_expect ->> 'calculation_policy_version') IS DISTINCT FROM v_run.calculation_policy_version) THEN
    RETURN public.cms__seal_fail(p_run_id, 'held', 'BASIS_WRITER_MISMATCH');
  END IF;
  -- Thống kê mới cho run vừa stage (run_id mới chưa có trong thống kê ⇒ planner ước 1 dòng ⇒ nested loop O(n²)).
  -- SKIP_LOCKED: autovacuum / seal khác đang giữ khoá ⇒ bỏ qua thay vì chờ lock_timeout (security review r2 P2-c); bước
  -- seal vẫn có enable_nestloop = off nên thống kê cũ không rơi vào O(n²).
  ANALYZE (SKIP_LOCKED) public.cms_sales_lines, public.cms_results, public.cms_result_catalog, public.cms_result_lines;
  -- S1 đủ dòng: số dòng từng bảng = khai báo của app.
  IF (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = p_run_id) <> (p_expect ->> 'sales_lines')::bigint
     OR (SELECT count(*) FROM public.cms_results WHERE run_id = p_run_id) <> (p_expect ->> 'results')::bigint
     OR (SELECT count(*) FROM public.cms_result_catalog WHERE run_id = p_run_id) <> (p_expect ->> 'catalog')::bigint
     OR (SELECT count(*) FROM public.cms_result_lines WHERE run_id = p_run_id) <> (p_expect ->> 'result_lines')::bigint THEN
    RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_COUNT_MISMATCH');
  END IF;
  -- S2 đủ khối: mỗi part có đúng n khối 0…n−1, tổng row_count = số dòng.
  FOREACH v_part IN ARRAY ARRAY['sales_lines', 'results', 'catalog', 'result_lines'] LOOP
    v_n := (p_expect -> 'chunks' ->> v_part)::bigint;
    IF (SELECT count(*) FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND part = v_part) <> v_n
       OR COALESCE((SELECT max(chunk_no) FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND part = v_part), -1) <> v_n - 1
       OR COALESCE((SELECT sum(row_count) FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND part = v_part), 0)
          <> (p_expect ->> v_part)::bigint THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_CHUNKS_MISMATCH');
    END IF;
  END LOOP;
  -- Đóng băng staging: từ đây stage bị từ chối; các bước dùng expect đã lưu (không nhận lại từ app).
  UPDATE public.cms_sync_runs SET seal_expect = p_expect, seal_step = 0 WHERE id = p_run_id;
  RETURN jsonb_build_object('ok', true, 'steps', 10);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_seal_step(p_run_id uuid, p_step integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s'
  SET enable_nestloop = off AS $$
DECLARE
  v_run   public.cms_sync_runs%ROWTYPE;
  v_prog  public.cms_programs%ROWTYPE;
  v_exp   jsonb;
  v_from  timestamptz;
  v_to    timestamptz;
  v_sum   numeric;
  v_bad   boolean;
  v_bad2  boolean;  -- 128
BEGIN
  IF p_step IS NULL OR p_step < 1 OR p_step > 10 THEN RAISE EXCEPTION 'CMS_SEAL_BAD_STEP' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.kind <> 'sales' OR v_run.status <> 'running' THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.seal_expect IS NULL THEN RAISE EXCEPTION 'CMS_SEAL_STEP_ORDER' USING ERRCODE = 'P0001'; END IF;
  -- Gọi lại bước đã qua (mất phản hồi) ⇒ trả lại kết quả, không đổi gì (db-reviewer r2 N8).
  IF v_run.sealed_at IS NOT NULL THEN
    RETURN CASE WHEN p_step = 10 THEN jsonb_build_object('sealed', true, 'step', 10, 'already', true, 'amount_vnd', v_run.amount_vnd::text)
                ELSE jsonb_build_object('sealed', false, 'ok', true, 'step', p_step, 'already', true) END;
  END IF;
  IF v_run.seal_step >= p_step THEN RETURN jsonb_build_object('sealed', false, 'ok', true, 'step', p_step, 'already', true); END IF;
  IF v_run.seal_step <> p_step - 1 THEN RAISE EXCEPTION 'CMS_SEAL_STEP_ORDER' USING ERRCODE = 'P0001'; END IF;
  IF v_run.started_at < now() - interval '30 minutes' THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'STALE'); END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_run.program_id;
  -- Đầu MỖI bước: trạng thái / cấu hình / mapping đổi từ lúc open ⇒ held đúng mã (không để bước kiểm dữ liệu báo error
  -- SEAL_* gây hiểu nhầm — db-reviewer r2 N2). Publish vẫn kiểm lại dưới khoá chương trình.
  IF v_prog.status = 'locked' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_LOCKED'); END IF;
  IF v_prog.status <> 'active' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_NOT_ACTIVE'); END IF;
  IF v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN
    RETURN public.cms__seal_fail(p_run_id, 'held', 'CONFIG_CHANGED');
  END IF;
  IF public.cms__mapping_fp() <> v_run.mapping_fp THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'MAPPING_CHANGED'); END IF;
  -- 128: metadata tính của run (DB ghi lúc open, bất biến) phải hợp lệ; cơ sở + TOÀN BỘ snapshot cấu hình tính của run = snapshot dựng
  -- lại từ chương trình HIỆN TẠI (đổi cơ sở / đơn vị / khoá đơn vị / K / bậc / phạm vi mà lọt config_version ⇒ vẫn held; snapshot ghi
  -- ngoài RPC với unit_key / phiên bản khoá lệch nhưng config_fp đúng ⇒ held — db-reviewer 09/11 P2-1).
  IF v_run.quantity_basis IS NULL OR v_run.calculation_snapshot IS NULL
     OR v_run.calculation_policy_version IS DISTINCT FROM public.cms__basis_policy(v_run.quantity_basis) THEN
    RETURN public.cms__seal_fail(p_run_id, 'error', 'RUN_BASIS_INVALID');
  END IF;
  IF v_prog.quantity_basis IS DISTINCT FROM v_run.quantity_basis
     OR v_run.calculation_snapshot IS DISTINCT FROM public.cms__calc_snapshot(v_run.program_id) THEN
    RETURN public.cms__seal_fail(p_run_id, 'held', 'CONFIG_CHANGED');
  END IF;
  v_exp  := v_run.seal_expect;
  v_from := (v_prog.start_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
  v_to   := ((v_prog.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');

  IF p_step = 1 THEN
    -- S3 thứ tự (compareCmsLines): seq liên tục 0…n−1; completed_at không giảm theo seq; cùng thời điểm: ID toàn chữ số trước
    -- ID khác; hai ID số tăng theo giá trị (độ dài sau bỏ số 0 đầu, rồi chữ số, hoà ⇒ chuỗi gốc); hai ID không phải số tăng
    -- theo code point (COLLATE "C" — chỉ khác thứ tự code unit JS với ký tự ngoài BMP).
    SELECT EXISTS (
      SELECT 1 FROM (
        SELECT completed_at, order_line_id AS c_id, regexp_replace(order_line_id, '^0+(?=[0-9])', '') AS c_t,
               lag(completed_at) OVER (ORDER BY seq) AS p_at, lag(order_line_id) OVER (ORDER BY seq) AS p_id,
               lag(regexp_replace(order_line_id, '^0+(?=[0-9])', '')) OVER (ORDER BY seq) AS p_t
          FROM public.cms_sales_lines WHERE run_id = p_run_id) x
       WHERE x.p_at > x.completed_at
          OR (x.p_at = x.completed_at AND x.p_id !~ '^[0-9]+$' AND x.c_id ~ '^[0-9]+$')
          OR (x.p_at = x.completed_at AND x.p_id ~ '^[0-9]+$' AND x.c_id ~ '^[0-9]+$'
              AND NOT (length(x.p_t) < length(x.c_t)
                       OR (length(x.p_t) = length(x.c_t) AND x.p_t COLLATE "C" < x.c_t COLLATE "C")
                       OR (x.p_t = x.c_t AND x.p_id COLLATE "C" < x.c_id COLLATE "C")))
          OR (x.p_at = x.completed_at AND x.p_id !~ '^[0-9]+$' AND x.c_id !~ '^[0-9]+$'
              AND NOT (x.p_id COLLATE "C" < x.c_id COLLATE "C")))
      OR COALESCE((SELECT max(seq) FROM public.cms_sales_lines WHERE run_id = p_run_id), -1)
         <> (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = p_run_id) - 1
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_ORDER'); END IF;
  ELSIF p_step = 2 THEN
    -- S4 kỳ / sản phẩm / phạm vi: trong kỳ ngày VN, ProductID khớp SP chương trình, INCLUDED ⇔ store trong phạm vi.
    SELECT EXISTS (
      SELECT 1 FROM public.cms_sales_lines sl
        JOIN public.cms_program_products pp ON pp.id = sl.program_product_id
        LEFT JOIN public.cms_program_stores ps ON ps.program_id = v_run.program_id AND ps.store_id = sl.store_id
       WHERE sl.run_id = p_run_id
         AND (sl.product_id <> pp.product_id OR sl.completed_at < v_from OR sl.completed_at >= v_to
              OR (sl.disposition = 'INCLUDED' AND ps.store_id IS NULL)
              OR (sl.disposition = 'OUT_OF_SCOPE' AND ps.store_id IS NOT NULL)))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_SCOPE'); END IF;
  ELSIF p_step = 3 THEN
    -- S5 người bán (Q-207): INCLUDED / OUT_OF_SCOPE ⇒ email khớp ĐÚNG MỘT tài khoản, là staff, store OS active = store dòng;
    -- UNASSIGNED ⇒ không có đúng một staff OS active khớp email (không bỏ sót người hưởng); NO_EMAIL ⇔ không email.
    WITH ue AS (
      SELECT u.id, public.cms__norm_email(u.email) AS e, u.role, u.store_id, COALESCE(s.store_type = 'os' AND s.is_active, false) AS ok
        FROM public.users u LEFT JOIN public.stores s ON s.id = u.store_id
    ), cnt AS (SELECT e, count(*) AS n FROM ue WHERE e IS NOT NULL GROUP BY e),
    elig AS (SELECT ue.e FROM ue JOIN cnt ON cnt.e = ue.e AND cnt.n = 1 WHERE ue.role = 'staff' AND ue.ok)
    SELECT EXISTS (
      SELECT 1 FROM public.cms_sales_lines sl
        LEFT JOIN cnt ON cnt.e = sl.seller_email
        LEFT JOIN ue ON ue.id = sl.user_id
       WHERE sl.run_id = p_run_id AND sl.disposition <> 'UNASSIGNED'
         AND NOT COALESCE(cnt.n = 1 AND ue.e = sl.seller_email AND ue.role = 'staff' AND ue.ok AND ue.store_id = sl.store_id, false))
    OR EXISTS (
      SELECT 1 FROM public.cms_sales_lines sl
        LEFT JOIN elig ON elig.e = sl.seller_email
       WHERE sl.run_id = p_run_id AND sl.disposition = 'UNASSIGNED'
         AND ((sl.seller_email IS NULL) <> (sl.unassigned_reason = 'NO_EMAIL') OR elig.e IS NOT NULL))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_MAPPING'); END IF;
  ELSIF p_step = 4 THEN
    -- S6 liên kết dòng: mỗi dòng kết quả ↔ đúng một dòng INCLUDED cùng seq / user / SP; đủ mọi dòng INCLUDED.
    IF EXISTS (SELECT 1 FROM public.cms_result_lines rl
                 JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
                WHERE rl.run_id = p_run_id AND (sl.disposition <> 'INCLUDED' OR sl.seq <> rl.seq OR sl.user_id <> rl.user_id
                                                OR sl.program_product_id <> rl.program_product_id))
       OR (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = p_run_id AND disposition = 'INCLUDED')
          <> (SELECT count(*) FROM public.cms_result_lines WHERE run_id = p_run_id) THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_LINE_LINK');
    END IF;
  ELSIF p_step = 5 THEN
    -- S7 cấu hình trong kết quả = cấu hình chương trình (SP, loại GMV, K, target, trần = to của bậc cuối).
    IF EXISTS (SELECT 1 FROM public.cms_results r
                 JOIN public.cms_program_products pp ON pp.id = r.program_product_id
                 LEFT JOIN LATERAL (SELECT t.qty_to FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id
                                     ORDER BY t.tier_order DESC LIMIT 1) lt ON true
                WHERE r.run_id = p_run_id
                  AND (r.product_id <> pp.product_id OR r.gmv_basis <> pp.gmv_basis OR r.per_unit <> pp.base_quantity_cms
                       OR r.target_gmv IS DISTINCT FROM (CASE pp.gmv_basis WHEN 'product' THEN pp.target_gmv
                                                                           WHEN 'catalog' THEN v_prog.catalog_target_gmv END)
                       OR r.cap_quantity IS DISTINCT FROM lt.qty_to::bigint)) THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_RESULT_CONFIG');
    END IF;
  ELSIF p_step = 6 THEN
    -- S8 tổng theo nhóm dược sĩ × SP = cộng các dòng (số dòng, lượng cơ sở, GMV, tiền) và cùng store.
    IF EXISTS (SELECT 1 FROM public.cms_results r
                 LEFT JOIN (SELECT rl.user_id, rl.program_product_id, count(*) AS n, sum(sl.base_quantity) AS b,
                                   sum(sl.gmv_amount) AS g, sum(rl.amount_vnd::numeric) AS a,
                                   min(sl.store_id::text) AS s1, max(sl.store_id::text) AS s2
                              FROM public.cms_result_lines rl
                              JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
                             WHERE rl.run_id = p_run_id GROUP BY rl.user_id, rl.program_product_id) x
                   ON x.user_id = r.user_id AND x.program_product_id = r.program_product_id
                WHERE r.run_id = p_run_id
                  AND (x.n IS NULL OR x.n <> r.line_count OR x.b <> r.base_quantity OR x.g <> r.gmv_amount
                       OR x.a <> r.amount_vnd OR x.s1 <> r.store_id::text OR x.s2 <> r.store_id::text)) THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_RESULT_SUMS');
    END IF;
  ELSIF p_step = 7 THEN
    IF v_run.quantity_basis = 'cms_unit' THEN
    -- 128 S9u (cms_unit — Q-221 / Q-223): DB TỰ tính lượng đúng ĐV CMS từ dòng nguồn đã stage — KHÔNG tin cms_quantity của caller, KHÔNG
    -- suy từ B / K. Mỗi cặp (SP, đơn vị thô) / mỗi chuỗi lượng PHÂN BIỆT chuẩn hoá MỘT lần. Mọi dòng ứng viên (cả chưa gán / ngoài
    -- phạm vi) phải có đơn vị + lượng hợp lệ; đúng ĐV CMS ⇒ lượng NGUYÊN trong miền bigint (app HOLD trước khi stage — tới đây là
    -- writer sai ⇒ error SEAL_UNIT_SOURCE). Q = max(Σ lượng đúng ĐV của dòng INCLUDED trong nhóm, 0); F(Q) như nhánh pos_base.
    WITH pu AS (
      SELECT (e ->> 'id')::uuid AS program_product_id, e ->> 'unit_key' AS unit_key
        FROM jsonb_array_elements(v_run.calculation_snapshot -> 'products') e
    ), du AS MATERIALIZED (
      SELECT d.program_product_id, d.uom_raw, public.cms__unit_key(d.uom_raw) AS k
        FROM (SELECT DISTINCT s.program_product_id, s.uom_raw FROM public.cms_sales_lines s WHERE s.run_id = p_run_id) d
    ), dq AS MATERIALIZED (
      SELECT d.quantity_raw, public.cms__qty_dec(d.quantity_raw) AS q
        FROM (SELECT DISTINCT s.quantity_raw FROM public.cms_sales_lines s WHERE s.run_id = p_run_id) d
    ), sl AS (
      SELECT s.user_id, s.program_product_id, s.disposition, dq.q, du.k, pu.unit_key, COALESCE(du.k = pu.unit_key, false) AS matched
        FROM public.cms_sales_lines s
        LEFT JOIN du ON du.program_product_id = s.program_product_id AND du.uom_raw = s.uom_raw
        LEFT JOIN dq ON dq.quantity_raw = s.quantity_raw
        LEFT JOIN pu ON pu.program_product_id = s.program_product_id
       WHERE s.run_id = p_run_id
    ), g AS (
      SELECT sl.user_id, sl.program_product_id, GREATEST(sum(CASE WHEN sl.matched THEN sl.q ELSE 0 END), 0) AS qexp
        FROM sl WHERE sl.disposition = 'INCLUDED' GROUP BY sl.user_id, sl.program_product_id
    ), tc AS (
      SELECT t.program_product_id, t.tier_order,
             COALESCE(sum((t.qty_to - t.qty_from + 1)::numeric * t.amount_per_unit) OVER (PARTITION BY t.program_product_id
                      ORDER BY t.tier_order ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_before
        FROM public.cms_program_tiers t WHERE t.program_id = v_run.program_id
    ), q AS (
      SELECT DISTINCT r.program_product_id, r.cms_quantity AS q FROM public.cms_results r WHERE r.run_id = p_run_id
    ), fq AS (
      SELECT q.program_product_id, q.q,
             CASE WHEN q.q <= 0 OR x.tier_order IS NULL THEN 0
                  ELSE tc.cum_before + (LEAST(q.q::numeric, COALESCE(x.qty_to, q.q)::numeric) - x.qty_from + 1) * x.amount_per_unit END AS f
        FROM q
        LEFT JOIN LATERAL (SELECT t.tier_order, t.qty_from, t.qty_to, t.amount_per_unit FROM public.cms_program_tiers t
                            WHERE t.program_product_id = q.program_product_id AND t.qty_from <= q.q
                            ORDER BY t.qty_from DESC LIMIT 1) x ON true
        LEFT JOIN tc ON tc.program_product_id = q.program_product_id AND tc.tier_order = x.tier_order
    )
    SELECT EXISTS (SELECT 1 FROM sl WHERE sl.k IS NULL OR sl.q IS NULL OR sl.unit_key IS NULL
                      OR (sl.matched AND (sl.q <> trunc(sl.q) OR abs(sl.q) > 9223372036854775807))),
           EXISTS (SELECT 1 FROM public.cms_results r
                     LEFT JOIN g ON g.user_id = r.user_id AND g.program_product_id = r.program_product_id
                     LEFT JOIN fq ON fq.program_product_id = r.program_product_id AND fq.q = r.cms_quantity
                    WHERE r.run_id = p_run_id
                      AND (g.qexp IS NULL OR r.cms_quantity::numeric <> g.qexp OR fq.f IS NULL OR r.potential_amount::numeric <> fq.f))
    INTO v_bad2, v_bad;
    IF v_bad2 THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_UNIT_SOURCE'); END IF;
    ELSE
    -- S9 Q = floor(max(0, B) / K) (bất đẳng thức chính xác) và F(Q) theo bậc lũy tiến. F tính MỘT lần cho mỗi cặp (SP, Q)
    -- phân biệt: tra bậc chứa Q bằng index (program_product_id, qty_from) LIMIT 1 + tiền tích luỹ các bậc trước (hash join) —
    -- O(cặp · log bậc), không O(dòng × bậc) (db-reviewer r2 P1-N1).
    WITH tc AS (
      SELECT t.program_product_id, t.tier_order,
             COALESCE(sum((t.qty_to - t.qty_from + 1)::numeric * t.amount_per_unit) OVER (PARTITION BY t.program_product_id
                      ORDER BY t.tier_order ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_before
        FROM public.cms_program_tiers t WHERE t.program_id = v_run.program_id
    ), q AS (
      SELECT DISTINCT r.program_product_id, r.cms_quantity AS q FROM public.cms_results r WHERE r.run_id = p_run_id
    ), fq AS (
      SELECT q.program_product_id, q.q,
             CASE WHEN q.q <= 0 OR x.tier_order IS NULL THEN 0
                  ELSE tc.cum_before + (LEAST(q.q::numeric, COALESCE(x.qty_to, q.q)::numeric) - x.qty_from + 1) * x.amount_per_unit END AS f
        FROM q
        LEFT JOIN LATERAL (SELECT t.tier_order, t.qty_from, t.qty_to, t.amount_per_unit FROM public.cms_program_tiers t
                            WHERE t.program_product_id = q.program_product_id AND t.qty_from <= q.q
                            ORDER BY t.qty_from DESC LIMIT 1) x ON true
        LEFT JOIN tc ON tc.program_product_id = q.program_product_id AND tc.tier_order = x.tier_order
    )
    SELECT EXISTS (
      SELECT 1 FROM public.cms_results r
        LEFT JOIN fq ON fq.program_product_id = r.program_product_id AND fq.q = r.cms_quantity
       WHERE r.run_id = p_run_id
         AND (NOT (r.cms_quantity::numeric * r.per_unit <= GREATEST(r.base_quantity, 0)
                   AND GREATEST(r.base_quantity, 0) < (r.cms_quantity::numeric + 1) * r.per_unit)
              OR fq.f IS NULL OR r.potential_amount::numeric <> fq.f))
    INTO v_bad;
    END IF;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TIER_AMOUNT'); END IF;
  ELSIF p_step = 8 THEN
    -- S10 gate SP: GMV gate = tổng GMV nhóm; đạt = cuối kỳ ≥ target; "đạt từ" = lần chuyển chưa đạt → đạt gần nhất (Q-211).
    WITH l AS (
      SELECT rl.user_id, rl.program_product_id, rl.seq, sl.completed_at, sl.gmv_amount, r.target_gmv
        FROM public.cms_result_lines rl
        JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
        JOIN public.cms_results r ON r.run_id = rl.run_id AND r.user_id = rl.user_id AND r.program_product_id = rl.program_product_id
       WHERE rl.run_id = p_run_id AND r.gmv_basis = 'product'
    ), c AS (
      SELECT l.*, (sum(l.gmv_amount) OVER (PARTITION BY l.user_id, l.program_product_id ORDER BY l.seq)) >= l.target_gmv AS met FROM l
    ), x AS (
      SELECT c.*, COALESCE(lag(c.met) OVER (PARTITION BY c.user_id, c.program_product_id ORDER BY c.seq), false) AS prev_met FROM c
    ), g AS (
      SELECT user_id, program_product_id, sum(gmv_amount) AS gmv, (array_agg(met ORDER BY seq DESC))[1] AS final_met,
             max(completed_at) FILTER (WHERE met AND NOT prev_met) AS last_cross
        FROM x GROUP BY user_id, program_product_id
    )
    SELECT EXISTS (
      SELECT 1 FROM public.cms_results r
        LEFT JOIN g ON g.user_id = r.user_id AND g.program_product_id = r.program_product_id
       WHERE r.run_id = p_run_id AND r.gmv_basis = 'product'
         AND (g.user_id IS NULL OR r.gate_gmv IS DISTINCT FROM g.gmv OR r.gate_met IS DISTINCT FROM g.final_met
              OR r.gate_met_at IS DISTINCT FROM (CASE WHEN g.final_met THEN g.last_cross END)))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_GATE'); END IF;
  ELSIF p_step = 9 THEN
    -- S11 gate danh mục theo dược sĩ (cộng GMV mọi SP GMV_TOAN_DANH_MUC theo thứ tự engine); một dòng catalog ⇔ dược sĩ có
    -- dòng danh mục; kết quả SP danh mục mang đúng gate của dược sĩ.
    WITH l AS (
      SELECT rl.user_id, rl.seq, sl.completed_at, sl.gmv_amount, sl.store_id
        FROM public.cms_result_lines rl
        JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
        JOIN public.cms_results r ON r.run_id = rl.run_id AND r.user_id = rl.user_id AND r.program_product_id = rl.program_product_id
       WHERE rl.run_id = p_run_id AND r.gmv_basis = 'catalog'
    ), c AS (
      SELECT l.*, (sum(l.gmv_amount) OVER (PARTITION BY l.user_id ORDER BY l.seq)) >= v_prog.catalog_target_gmv AS met FROM l
    ), x AS (
      SELECT c.*, COALESCE(lag(c.met) OVER (PARTITION BY c.user_id ORDER BY c.seq), false) AS prev_met FROM c
    ), g AS (
      SELECT user_id, sum(gmv_amount) AS gmv, count(*) AS n, (array_agg(met ORDER BY seq DESC))[1] AS final_met,
             max(completed_at) FILTER (WHERE met AND NOT prev_met) AS last_cross,
             min(store_id::text) AS s1, max(store_id::text) AS s2
        FROM x GROUP BY user_id
    )
    SELECT EXISTS (
      SELECT 1 FROM g FULL JOIN (SELECT * FROM public.cms_result_catalog WHERE run_id = p_run_id) k ON k.user_id = g.user_id
       WHERE g.user_id IS NULL OR k.user_id IS NULL OR k.catalog_gmv <> g.gmv OR k.line_count <> g.n
          OR k.target_gmv IS DISTINCT FROM v_prog.catalog_target_gmv OR k.met <> g.final_met
          OR k.met_at IS DISTINCT FROM (CASE WHEN g.final_met THEN g.last_cross END)
          OR k.store_id::text <> g.s1 OR k.store_id::text <> g.s2)
    OR EXISTS (
      SELECT 1 FROM public.cms_results r
        LEFT JOIN public.cms_result_catalog k ON k.run_id = r.run_id AND k.user_id = r.user_id
       WHERE r.run_id = p_run_id AND r.gmv_basis = 'catalog'
         AND (k.user_id IS NULL OR r.gate_gmv <> k.catalog_gmv OR r.gate_met <> k.met
              OR r.gate_met_at IS DISTINCT FROM k.met_at))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_CATALOG'); END IF;
  ELSE
    IF v_run.quantity_basis = 'cms_unit' THEN
    -- 128 S12u (cms_unit): C trước / sau cộng dồn theo seq từ dòng nguồn (cùng khoá đơn vị / lượng như S9u); Q trước / sau = max(C, 0);
    -- tiền = gate ? F(Q_sau) − F(Q_trước) : 0; B trước / sau vẫn là lượng cơ sở THẬT; điều chỉnh gồm cả lượng gốc âm (kể cả dòng khác
    -- đơn vị — không để né cổng trả hàng). Không chia C cho K; totals / cổng điều chỉnh (S13 / S14) dùng chung bên dưới.
    WITH pu AS (
      SELECT (e ->> 'id')::uuid AS program_product_id, e ->> 'unit_key' AS unit_key
        FROM jsonb_array_elements(v_run.calculation_snapshot -> 'products') e
    ), du AS MATERIALIZED (
      SELECT d.program_product_id, d.uom_raw, public.cms__unit_key(d.uom_raw) AS k
        FROM (SELECT DISTINCT s.program_product_id, s.uom_raw FROM public.cms_sales_lines s WHERE s.run_id = p_run_id) d
    ), dq AS MATERIALIZED (
      SELECT d.quantity_raw, public.cms__qty_dec(d.quantity_raw) AS q
        FROM (SELECT DISTINCT s.quantity_raw FROM public.cms_sales_lines s WHERE s.run_id = p_run_id) d
    ), l AS (
      SELECT rl.*, sl.base_quantity, sl.gmv_amount, r.gate_met, r.cap_quantity, dq.q AS qraw,
             CASE WHEN COALESCE(du.k = pu.unit_key, false) THEN dq.q ELSE 0 END AS c,
             COALESCE(sum(sl.base_quantity) OVER w, 0) AS exp_before,
             COALESCE(sum(CASE WHEN COALESCE(du.k = pu.unit_key, false) THEN dq.q ELSE 0 END) OVER w, 0) AS c_before
        FROM public.cms_result_lines rl
        JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
        JOIN public.cms_results r ON r.run_id = rl.run_id AND r.user_id = rl.user_id AND r.program_product_id = rl.program_product_id
        LEFT JOIN pu ON pu.program_product_id = rl.program_product_id
        LEFT JOIN du ON du.program_product_id = sl.program_product_id AND du.uom_raw = sl.uom_raw
        LEFT JOIN dq ON dq.quantity_raw = sl.quantity_raw
       WHERE rl.run_id = p_run_id
      WINDOW w AS (PARTITION BY rl.user_id, rl.program_product_id ORDER BY rl.seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
    ), tc AS (
      SELECT t.program_product_id, t.tier_order,
             COALESCE(sum((t.qty_to - t.qty_from + 1)::numeric * t.amount_per_unit) OVER (PARTITION BY t.program_product_id
                      ORDER BY t.tier_order ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_before
        FROM public.cms_program_tiers t WHERE t.program_id = v_run.program_id
    ), q AS (
      SELECT program_product_id, qty_before AS q FROM l WHERE gate_met
      UNION
      SELECT program_product_id, qty_after FROM l WHERE gate_met
    ), fq AS (
      SELECT q.program_product_id, q.q,
             CASE WHEN q.q <= 0 OR x.tier_order IS NULL THEN 0
                  ELSE tc.cum_before + (LEAST(q.q::numeric, COALESCE(x.qty_to, q.q)::numeric) - x.qty_from + 1) * x.amount_per_unit END AS f
        FROM q
        LEFT JOIN LATERAL (SELECT t.tier_order, t.qty_from, t.qty_to, t.amount_per_unit FROM public.cms_program_tiers t
                            WHERE t.program_product_id = q.program_product_id AND t.qty_from <= q.q
                            ORDER BY t.qty_from DESC LIMIT 1) x ON true
        LEFT JOIN tc ON tc.program_product_id = q.program_product_id AND tc.tier_order = x.tier_order
    ), f AS (
      SELECT l.*, fa.f AS f_after, fb.f AS f_before
        FROM l
        LEFT JOIN fq fa ON l.gate_met AND fa.program_product_id = l.program_product_id AND fa.q = l.qty_after
        LEFT JOIN fq fb ON l.gate_met AND fb.program_product_id = l.program_product_id AND fb.q = l.qty_before
    )
    SELECT EXISTS (
      SELECT 1 FROM f
       WHERE f.base_before <> f.exp_before OR f.base_after <> f.exp_before + f.base_quantity
          OR f.qraw IS NULL
          OR f.qty_before::numeric IS DISTINCT FROM GREATEST(f.c_before, 0)
          OR f.qty_after::numeric IS DISTINCT FROM GREATEST(f.c_before + f.c, 0)
          OR (f.gate_met AND (f.f_after IS NULL OR f.f_before IS NULL))
          OR f.amount_vnd::numeric <> (CASE WHEN f.gate_met THEN f.f_after - f.f_before ELSE 0 END)
          OR f.status <> (CASE WHEN f.base_quantity < 0 OR f.gmv_amount < 0 OR f.qraw < 0 THEN 'ADJUSTMENT'
                               WHEN NOT f.gate_met THEN 'WAITING_GATE'
                               WHEN f.amount_vnd > 0 THEN 'RECORDED'
                               WHEN f.cap_quantity IS NOT NULL AND f.qty_before >= f.cap_quantity THEN 'AT_CAP'
                               ELSE 'ACCUMULATING' END))
    INTO v_bad;
    ELSE
    -- S12 phân bổ từng dòng: B trước / sau cộng dồn theo seq; Q trước / sau; tiền = gate ? A(B_sau) − A(B_trước) : 0;
    -- trạng thái dòng đúng thứ tự ưu tiên của engine.
    WITH l AS (
      SELECT rl.*, sl.base_quantity, sl.gmv_amount, r.per_unit, r.gate_met, r.cap_quantity,
             COALESCE(sum(sl.base_quantity) OVER (PARTITION BY rl.user_id, rl.program_product_id ORDER BY rl.seq
                                                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS exp_before
        FROM public.cms_result_lines rl
        JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
        JOIN public.cms_results r ON r.run_id = rl.run_id AND r.user_id = rl.user_id AND r.program_product_id = rl.program_product_id
       WHERE rl.run_id = p_run_id
    ), tc AS (
      SELECT t.program_product_id, t.tier_order,
             COALESCE(sum((t.qty_to - t.qty_from + 1)::numeric * t.amount_per_unit) OVER (PARTITION BY t.program_product_id
                      ORDER BY t.tier_order ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_before
        FROM public.cms_program_tiers t WHERE t.program_id = v_run.program_id
    ), q AS (
      -- F chỉ cần ở dòng gate đạt; mỗi cặp (SP, Q) phân biệt tính một lần (db-reviewer r2 P1-N1).
      SELECT program_product_id, qty_before AS q FROM l WHERE gate_met
      UNION
      SELECT program_product_id, qty_after FROM l WHERE gate_met
    ), fq AS (
      SELECT q.program_product_id, q.q,
             CASE WHEN q.q <= 0 OR x.tier_order IS NULL THEN 0
                  ELSE tc.cum_before + (LEAST(q.q::numeric, COALESCE(x.qty_to, q.q)::numeric) - x.qty_from + 1) * x.amount_per_unit END AS f
        FROM q
        LEFT JOIN LATERAL (SELECT t.tier_order, t.qty_from, t.qty_to, t.amount_per_unit FROM public.cms_program_tiers t
                            WHERE t.program_product_id = q.program_product_id AND t.qty_from <= q.q
                            ORDER BY t.qty_from DESC LIMIT 1) x ON true
        LEFT JOIN tc ON tc.program_product_id = q.program_product_id AND tc.tier_order = x.tier_order
    ), f AS (
      SELECT l.*, fa.f AS f_after, fb.f AS f_before
        FROM l
        LEFT JOIN fq fa ON l.gate_met AND fa.program_product_id = l.program_product_id AND fa.q = l.qty_after
        LEFT JOIN fq fb ON l.gate_met AND fb.program_product_id = l.program_product_id AND fb.q = l.qty_before
    )
    SELECT EXISTS (
      SELECT 1 FROM f
       WHERE f.base_before <> f.exp_before OR f.base_after <> f.exp_before + f.base_quantity
          OR NOT (f.qty_before::numeric * f.per_unit <= GREATEST(f.base_before, 0)
                  AND GREATEST(f.base_before, 0) < (f.qty_before::numeric + 1) * f.per_unit)
          OR NOT (f.qty_after::numeric * f.per_unit <= GREATEST(f.base_after, 0)
                  AND GREATEST(f.base_after, 0) < (f.qty_after::numeric + 1) * f.per_unit)
          OR (f.gate_met AND (f.f_after IS NULL OR f.f_before IS NULL))
          OR f.amount_vnd::numeric <> (CASE WHEN f.gate_met THEN f.f_after - f.f_before ELSE 0 END)
          OR f.status <> (CASE WHEN f.base_quantity < 0 OR f.gmv_amount < 0 THEN 'ADJUSTMENT'
                               WHEN NOT f.gate_met THEN 'WAITING_GATE'
                               WHEN f.amount_vnd > 0 THEN 'RECORDED'
                               WHEN f.cap_quantity IS NOT NULL AND f.qty_before >= f.cap_quantity THEN 'AT_CAP'
                               ELSE 'ACCUMULATING' END))
    INTO v_bad;
    END IF;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_LINE_ALLOC'); END IF;
    -- S13 tổng tiền = khai báo, trong miền bigint.
    SELECT COALESCE(sum(amount_vnd::numeric), 0) INTO v_sum FROM public.cms_results WHERE run_id = p_run_id;
    IF v_sum <> (v_exp ->> 'amount_vnd')::numeric OR v_sum > 9223372036854775807 THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TOTAL');
    END IF;
    -- S14 số đếm / tổng hiển thị cho super (totals) = dữ liệu đã stage; rows_read ≥ số ứng viên; mốc nguồn ≥ mốc dòng
    -- (db-reviewer P2-2: không ghi nguyên số app báo mà không đối chiếu).
    SELECT EXISTS (
      SELECT 1 FROM (
        SELECT count(*) AS cand,
               count(*) FILTER (WHERE disposition = 'INCLUDED') AS inc,
               count(*) FILTER (WHERE disposition = 'UNASSIGNED') AS una,
               count(*) FILTER (WHERE disposition = 'OUT_OF_SCOPE') AS oos,
               COALESCE(sum(gmv_amount), 0) AS cgmv,
               COALESCE(sum(gmv_amount) FILTER (WHERE disposition = 'UNASSIGNED'), 0) AS ugmv,
               max(source_updated_at) AS mx
          FROM public.cms_sales_lines WHERE run_id = p_run_id) a
       WHERE a.cand <> (v_exp -> 'totals' ->> 'candidates')::bigint OR a.inc <> (v_exp -> 'totals' ->> 'included')::bigint
          OR a.una <> (v_exp -> 'totals' ->> 'unassigned')::bigint OR a.oos <> (v_exp -> 'totals' ->> 'out_of_scope')::bigint
          OR a.cgmv <> (v_exp -> 'totals' ->> 'candidate_gmv')::numeric OR a.ugmv <> (v_exp -> 'totals' ->> 'unassigned_gmv')::numeric
          OR (v_exp ->> 'rows_read')::bigint < a.cand
          OR (a.mx IS NOT NULL AND (v_exp ->> 'source_max_updated_at') IS NULL)
          OR (a.mx IS NOT NULL AND (v_exp ->> 'source_max_updated_at')::timestamptz < a.mx)
          -- Mọi khoá totals còn lại cũng phải khớp dữ liệu (db-reviewer r2 N5): dòng hợp lệ = đọc − lỗi; dòng không ứng viên
          -- = hợp lệ − ứng viên; chưa gán / ngoài phạm vi theo lý do; tổng tiền; số dòng điều chỉnh.
          OR (v_exp -> 'totals' ->> 'lines_read')::bigint <> (v_exp ->> 'rows_read')::bigint - (v_exp ->> 'rows_rejected')::bigint
          OR (v_exp -> 'totals' ->> 'amount_vnd')::numeric <> v_sum
          OR (v_exp -> 'totals' ->> 'adjustment_lines')::bigint
             <> (SELECT count(*) FROM public.cms_result_lines WHERE run_id = p_run_id AND status = 'ADJUSTMENT')
          OR COALESCE((SELECT jsonb_object_agg(g.unassigned_reason, g.n) FROM (
                         SELECT unassigned_reason, count(*) AS n FROM public.cms_sales_lines
                          WHERE run_id = p_run_id AND disposition = 'UNASSIGNED' GROUP BY unassigned_reason) g), '{}'::jsonb)
             <> (v_exp -> 'totals' -> 'unassigned_by_reason')
          OR COALESCE((v_exp -> 'totals' -> 'excluded_by_reason' ->> 'UNASSIGNED')::bigint, 0) <> a.una
          OR COALESCE((v_exp -> 'totals' -> 'excluded_by_reason' ->> 'OUT_OF_SCOPE')::bigint, 0) <> a.oos
          OR COALESCE((v_exp -> 'totals' -> 'excluded_by_reason' ->> 'ORDER_NOT_ELIGIBLE')::bigint, 0)
             + COALESCE((v_exp -> 'totals' -> 'excluded_by_reason' ->> 'OUT_OF_WINDOW')::bigint, 0)
             + COALESCE((v_exp -> 'totals' -> 'excluded_by_reason' ->> 'PRODUCT_NOT_IN_PROGRAM')::bigint, 0)
             <> (v_exp -> 'totals' ->> 'lines_read')::bigint - a.cand)
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TOTALS'); END IF;
    UPDATE public.cms_sync_runs SET
      seal_step = 10,
      sealed_at = now(),
      amount_vnd = v_sum::bigint,
      rows_read = (v_exp ->> 'rows_read')::integer,
      rows_rejected = (v_exp ->> 'rows_rejected')::integer,
      bytes_processed = NULLIF(v_exp ->> 'bytes_processed', '')::bigint,
      source_max_updated_at = NULLIF(v_exp ->> 'source_max_updated_at', '')::timestamptz,
      detail = detail || jsonb_build_object('totals', v_exp -> 'totals')
    WHERE id = p_run_id;
    RETURN jsonb_build_object('sealed', true, 'step', 10, 'amount_vnd', v_sum::text);
  END IF;
  UPDATE public.cms_sync_runs SET seal_step = p_step WHERE id = p_run_id;
  RETURN jsonb_build_object('sealed', false, 'ok', true, 'step', p_step);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_publish(p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_pid  uuid;
  v_prog public.cms_programs%ROWTYPE;
  v_run  public.cms_sync_runs%ROWTYPE;
  v_code text;
  v_prev uuid;
BEGIN
  IF p_run_id IS NULL THEN RAISE EXCEPTION 'CMS_SALES_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT program_id INTO v_pid FROM public.cms_sync_runs WHERE id = p_run_id AND kind = 'sales';
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001'; END IF;
  -- Thứ tự khoá cố định chương trình → run (cùng thứ tự open / ghi cấu hình 121) ⇒ không deadlock.
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_pid FOR UPDATE;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.status = 'ok' THEN
    RETURN jsonb_build_object('published', true, 'already', true, 'run_id', p_run_id,
                              'current', v_prog.current_result_run_id IS NOT DISTINCT FROM p_run_id);
  END IF;
  IF v_run.status <> 'running' THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001'; END IF;
  IF v_run.sealed_at IS NULL THEN RAISE EXCEPTION 'CMS_RESULT_NOT_SEALED' USING ERRCODE = 'P0001'; END IF;
  v_code := CASE
    WHEN v_run.started_at < now() - interval '30 minutes' THEN 'STALE'
    WHEN v_prog.status = 'locked' THEN 'PROGRAM_LOCKED'
    WHEN v_prog.status <> 'active' THEN 'PROGRAM_NOT_ACTIVE'
    WHEN v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN 'CONFIG_CHANGED'
    WHEN public.cms__mapping_fp() <> v_run.mapping_fp THEN 'MAPPING_CHANGED'
    -- 128: kiểm lại dưới khoá chương trình → run: metadata run hợp lệ, cơ sở + snapshot cấu hình tính = chương trình; run khác pos_base phải
    -- được seal bằng writer có dấu đúng (seal_expect).
    WHEN v_run.quantity_basis IS NULL OR v_run.calculation_snapshot IS NULL
      OR v_run.calculation_policy_version IS DISTINCT FROM public.cms__basis_policy(v_run.quantity_basis)
      OR v_run.quantity_basis IS DISTINCT FROM v_prog.quantity_basis
      OR v_run.calculation_snapshot IS DISTINCT FROM public.cms__calc_snapshot(v_pid) THEN 'CONFIG_CHANGED'
    WHEN v_run.quantity_basis <> 'pos_base'
      AND ((v_run.seal_expect ->> 'quantity_basis') IS DISTINCT FROM v_run.quantity_basis
           OR (v_run.seal_expect ->> 'calculation_policy_version') IS DISTINCT FROM v_run.calculation_policy_version) THEN 'BASIS_WRITER_MISMATCH'
    -- Q-206: chương trình thật không được công bố tiền tới khi cổng DB được mở bằng migration riêng.
    WHEN NOT v_run.is_test AND NOT public.cms__results_release_open() THEN 'RESULTS_RELEASE_GATE'
    -- 126 (PM 06/11 sales-only — trả hàng phase sau): chương trình thật có dòng điều chỉnh ĐÃ SEAL hoặc dòng ứng viên âm ⇒ KHÔNG công
    -- bố (không bỏ dòng âm để công bố riêng phần dương). Căn cứ chỉ là dữ liệu đã seal: totals.adjustment_lines (seal bước 10 đối
    -- chiếu = số dòng kết quả ADJUSTMENT; S12 ép ADJUSTMENT ⇔ dòng INCLUDED âm) + dòng không INCLUDED (chưa gán / ngoài phạm vi) âm
    -- đã stage (index cms_sales_lines_excluded_idx). totals thiếu / sai dạng ⇒ coi như có điều chỉnh (fail-closed; CASE giữ thứ tự,
    -- không ép kiểu chuỗi lạ).
    WHEN NOT v_run.is_test AND (
           CASE WHEN jsonb_typeof(v_run.seal_expect -> 'totals' -> 'adjustment_lines') = 'number'
                     AND (v_run.seal_expect -> 'totals' ->> 'adjustment_lines') ~ '^(0|[1-9][0-9]{0,8})$'
                THEN (v_run.seal_expect -> 'totals' ->> 'adjustment_lines')::bigint <> 0
                ELSE true END
        OR EXISTS (SELECT 1 FROM public.cms_sales_lines sl
                    WHERE sl.run_id = p_run_id AND sl.disposition <> 'INCLUDED' AND (sl.base_quantity < 0 OR sl.gmv_amount < 0
                          -- 128: run cms_unit — lượng gốc âm khác 0 (hình thức đã được seal S9u kiểm) cũng là điều chỉnh.
                          OR (v_run.quantity_basis = 'cms_unit' AND sl.quantity_raw ~ '^-' AND sl.quantity_raw ~ '[1-9]'))))
      THEN 'RETURNS_NOT_SUPPORTED_THIS_PHASE'
  END;
  IF v_code IS NOT NULL THEN
    UPDATE public.cms_sync_runs SET status = CASE WHEN v_code = 'STALE' THEN 'error' ELSE 'held' END,
           finished_at = now(), error_code = v_code
     WHERE id = p_run_id;
    RETURN jsonb_build_object('published', false, 'code', v_code, 'run_id', p_run_id);
  END IF;
  v_prev := v_prog.current_result_run_id;
  -- 126: đóng dấu căn cứ kết quả do DB quyết định (không nhận từ caller) — chương trình thật = CMS tạm tính theo dòng bán, chưa xử
  -- lý trả hàng. Không đổi seal / vân tay dòng 14 trường; run QA giữ nguyên như 122.
  UPDATE public.cms_sync_runs SET status = 'ok', finished_at = now(), published_at = now(),
         detail = CASE WHEN v_run.is_test THEN detail
                       ELSE detail || jsonb_build_object('results_basis', 'sales_only_v1', 'results_gate', '126') END
   WHERE id = p_run_id;
  UPDATE public.cms_programs SET current_result_run_id = p_run_id WHERE id = v_pid;
  RETURN jsonb_build_object('published', true, 'already', false, 'run_id', p_run_id, 'previous_run_id', v_prev);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_finish(p_run_id uuid, p_status text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_code text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('held', 'error') THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_STATUS' USING ERRCODE = '22023';
  END IF;
  IF p_detail IS NULL OR jsonb_typeof(p_detail) <> 'object' OR pg_column_size(p_detail) > 16384
     OR NOT public.cms__str(p_detail, 'error_code', '^[A-Z][A-Z0-9_]{0,63}$')
     OR NOT public.cms__str_or_null(p_detail, 'rows_read', '^(0|[1-9][0-9]{0,8})$')
     OR NOT public.cms__str_or_null(p_detail, 'rows_rejected', '^(0|[1-9][0-9]{0,8})$')
     OR NOT public.cms__str_or_null(p_detail, 'bytes_processed', '^(0|[1-9][0-9]{0,17})$')
     OR p_detail ?| ARRAY['quantity_basis', 'calculation_policy_version', 'calculation_snapshot'] THEN  -- 128: metadata tính do DB ghi lúc open
    RAISE EXCEPTION 'CMS_SYNC_BAD_DETAIL' USING ERRCODE = '22023';
  END IF;
  v_code := p_detail ->> 'error_code';
  UPDATE public.cms_sync_runs SET
    status          = p_status,
    finished_at     = now(),
    error_code      = v_code,
    rows_read       = COALESCE((p_detail ->> 'rows_read')::integer, rows_read),
    rows_rejected   = COALESCE((p_detail ->> 'rows_rejected')::integer, rows_rejected),
    bytes_processed = COALESCE((p_detail ->> 'bytes_processed')::bigint, bytes_processed),
    detail          = detail || (p_detail - 'error_code' - 'rows_read' - 'rows_rejected' - 'bytes_processed')
  WHERE id = p_run_id AND kind = 'sales' AND status = 'running';
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_result_header(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run  uuid;
  v_su   boolean := public.is_super_admin();
  v_cfg  integer;
  v_basis text;  -- 128
  v_r    public.cms_sync_runs%ROWTYPE;
  v_last public.cms_sync_runs%ROWTYPE;
BEGIN
  v_run := public.cms__result_run(p_program_id, NULL);
  SELECT config_version, quantity_basis INTO v_cfg, v_basis FROM public.cms_programs WHERE id = p_program_id;
  SELECT * INTO v_last FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = p_program_id
   ORDER BY started_at DESC LIMIT 1;
  IF v_run IS NOT NULL THEN SELECT * INTO v_r FROM public.cms_sync_runs WHERE id = v_run; END IF;
  RETURN jsonb_build_object(
    'program_id', p_program_id,
    'config_version', v_cfg,
    'quantity_basis', v_basis,  -- 128: cơ sở HIỆN TẠI của chương trình (run lịch sử đọc cơ sở của chính run)
    'viewer', CASE WHEN v_su THEN 'super' ELSE (SELECT u.role FROM public.users u WHERE u.id = auth.uid()) END,
    'run', CASE WHEN v_run IS NULL THEN NULL ELSE
      jsonb_build_object('id', v_r.id, 'config_version', v_r.config_version, 'quantity_basis', v_r.quantity_basis,
                         'calculation_policy_version', v_r.calculation_policy_version, 'published_at', public.cms__ts(v_r.published_at),
                         'source_max_updated_at', public.cms__ts(v_r.source_max_updated_at), 'started_at', public.cms__ts(v_r.started_at))
      || CASE WHEN v_su THEN jsonb_build_object('amount_vnd', v_r.amount_vnd::text, 'rows_read', v_r.rows_read,
                                                'totals', v_r.detail -> 'totals') ELSE '{}'::jsonb END END,
    'last_attempt', CASE WHEN v_last.id IS NULL THEN NULL ELSE
      jsonb_build_object('status', v_last.status, 'quantity_basis', v_last.quantity_basis,
                         'calculation_policy_version', v_last.calculation_policy_version, 'started_at', public.cms__ts(v_last.started_at),
                         'finished_at', public.cms__ts(v_last.finished_at), 'is_current', v_last.id IS NOT DISTINCT FROM v_run)
      || CASE WHEN v_su THEN jsonb_build_object('id', v_last.id, 'error_code', v_last.error_code) ELSE '{}'::jsonb END END,
    'recent_runs', CASE WHEN v_su THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', q.id, 'status', q.status, 'error_code', q.error_code,
                                          'started_at', public.cms__ts(q.started_at), 'finished_at', public.cms__ts(q.finished_at),
                                          'rows_read', q.rows_read, 'amount_vnd', q.amount_vnd::text,
                                          'config_version', q.config_version, 'purged', q.purged_at IS NOT NULL,
                                          'quantity_basis', q.quantity_basis, 'calculation_policy_version', q.calculation_policy_version)
                       ORDER BY q.started_at DESC)
        FROM (SELECT * FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = p_program_id
               ORDER BY started_at DESC LIMIT 10) q), '[]'::jsonb) END);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_result_rows(p_program_id uuid, p_run_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run   uuid;
  v_users uuid[];
  v_n     bigint;
  v_run_r public.cms_sync_runs%ROWTYPE;  -- 128
BEGIN
  v_run := public.cms__result_run(p_program_id, p_run_id);
  IF v_run IS NULL THEN
    RETURN jsonb_build_object('run_id', NULL, 'results', '[]'::jsonb, 'catalog', '[]'::jsonb, 'users', '[]'::jsonb,
                              'quantity_basis', NULL, 'calculation_policy_version', NULL, 'units', NULL);
  END IF;
  v_users := public.cms__visible_result_users();
  SELECT count(*) INTO v_n FROM public.cms_results r WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users));
  IF v_n > 50000 THEN RAISE EXCEPTION 'CMS_RESULT_TOO_LARGE' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_run_r FROM public.cms_sync_runs WHERE id = v_run;  -- 128
  RETURN jsonb_build_object(
    'run_id', v_run,
    -- 128: cơ sở / phiên bản / đơn vị CMS của RUN (snapshot lúc open) — run legacy: units NULL (đọc cấu hình như trước 128).
    'quantity_basis', v_run_r.quantity_basis, 'calculation_policy_version', v_run_r.calculation_policy_version,
    'units', (SELECT jsonb_agg(jsonb_build_object('program_product_id', e ->> 'id', 'product_id', e ->> 'product_id',
                                                  'unit_cms', e ->> 'unit_cms', 'base_quantity_cms', e ->> 'base_quantity_cms')
                               ORDER BY e ->> 'product_id')
                FROM jsonb_array_elements(v_run_r.calculation_snapshot -> 'products') e),
    'results', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'user_id', r.user_id, 'store_id', r.store_id, 'program_product_id', r.program_product_id, 'product_id', r.product_id,
        'gmv_basis', r.gmv_basis, 'base_quantity', r.base_quantity::text, 'per_unit', r.per_unit::text,
        'cms_quantity', r.cms_quantity::text, 'rewarded_quantity', r.rewarded_quantity::text,
        'cap_quantity', r.cap_quantity::text, 'at_cap', r.at_cap, 'gmv_amount', r.gmv_amount::text,
        'gate_gmv', r.gate_gmv::text, 'target_gmv', r.target_gmv::text, 'gate_met', r.gate_met,
        'gate_met_at', public.cms__ts(r.gate_met_at), 'potential_amount', r.potential_amount::text,
        'amount_vnd', r.amount_vnd::text, 'line_count', r.line_count) ORDER BY r.user_id, r.product_id)
      FROM public.cms_results r WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users))), '[]'::jsonb),
    'catalog', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'user_id', k.user_id, 'store_id', k.store_id, 'catalog_gmv', k.catalog_gmv::text, 'target_gmv', k.target_gmv::text,
        'met', k.met, 'met_at', public.cms__ts(k.met_at), 'line_count', k.line_count) ORDER BY k.user_id)
      FROM public.cms_result_catalog k WHERE k.run_id = v_run AND (v_users IS NULL OR k.user_id = ANY (v_users))), '[]'::jsonb),
    'users', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'full_name', u.full_name, 'store_id', u.store_id)
                                        ORDER BY u.id)
      FROM public.users u WHERE u.id IN (SELECT r.user_id FROM public.cms_results r
                                          WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users)))), '[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_result_lines(p_program_id uuid, p_run_id uuid, p_program_product_id uuid DEFAULT NULL,
                                            p_user_id uuid DEFAULT NULL, p_after_seq integer DEFAULT NULL,
                                            p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run   uuid;
  v_users uuid[];
  v_rows  jsonb;
  v_next  integer;
  v_run_r public.cms_sync_runs%ROWTYPE;  -- 128
  v_keys  jsonb;                         -- 128
BEGIN
  IF p_run_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_after_seq IS NOT NULL AND p_after_seq < 0) THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  v_run := public.cms__result_run(p_program_id, p_run_id);
  v_users := public.cms__visible_result_users();
  IF p_user_id IS NOT NULL AND v_users IS NOT NULL AND NOT (p_user_id = ANY (v_users)) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- 128: khoá ĐV CMS theo snapshot của RUN (không theo cấu hình hiện tại) ⇒ lý do "khác ĐV — không tính CMS" của từng dòng.
  SELECT * INTO v_run_r FROM public.cms_sync_runs WHERE id = v_run;
  IF v_run_r.quantity_basis = 'cms_unit' THEN
    SELECT jsonb_object_agg(e ->> 'id', e ->> 'unit_key') INTO v_keys
      FROM jsonb_array_elements(v_run_r.calculation_snapshot -> 'products') e;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'seq', q.seq, 'order_line_id', q.order_line_id, 'order_code', q.order_code, 'product_id', q.product_id,
      'program_product_id', q.program_product_id, 'user_id', q.user_id, 'store_id', q.store_id, 'pos_code', q.pos_code,
      'completed_at', public.cms__ts(q.completed_at), 'quantity_raw', q.quantity_raw, 'uom_raw', q.uom_raw,
      'base_quantity', q.base_quantity::text, 'gmv_amount', q.gmv_amount::text, 'base_before', q.base_before::text,
      'base_after', q.base_after::text, 'qty_before', q.qty_before::text, 'qty_after', q.qty_after::text,
      'amount_vnd', q.amount_vnd::text, 'status', q.status, 'unit_match', q.unit_match, 'counted_quantity', q.counted_quantity)
      ORDER BY q.seq), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT rl.seq, rl.order_line_id, sl.order_code, sl.product_id, rl.program_product_id, rl.user_id, sl.store_id,
                 sl.pos_code, sl.completed_at, sl.quantity_raw, sl.uom_raw, sl.base_quantity, sl.gmv_amount, rl.base_before,
                 rl.base_after, rl.qty_before, rl.qty_after, rl.amount_vnd, rl.status,
                 CASE WHEN v_keys IS NOT NULL
                      THEN COALESCE(public.cms__unit_key(sl.uom_raw) = (v_keys ->> rl.program_product_id::text), false) END AS unit_match,
                 CASE WHEN v_keys IS NULL THEN NULL
                      WHEN public.cms__unit_key(sl.uom_raw) = (v_keys ->> rl.program_product_id::text)
                      THEN trunc(public.cms__qty_dec(sl.quantity_raw))::text ELSE '0' END AS counted_quantity
            FROM public.cms_result_lines rl
            JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
           WHERE rl.run_id = v_run
             AND (v_users IS NULL OR rl.user_id = ANY (v_users))
             AND (p_user_id IS NULL OR rl.user_id = p_user_id)
             AND (p_program_product_id IS NULL OR rl.program_product_id = p_program_product_id)
             AND rl.seq > COALESCE(p_after_seq, -1)
           ORDER BY rl.seq LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'seq')::integer;
  END IF;
  RETURN jsonb_build_object('run_id', v_run, 'rows', v_rows, 'next_after_seq', v_next,
                            'quantity_basis', v_run_r.quantity_basis, 'calculation_policy_version', v_run_r.calculation_policy_version);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_source_attest(p_program_id uuid, p_run_id uuid, p_payload jsonb, p_idem uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '2s' AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_sha   text;
  v_old   public.cms_source_attestations%ROWTYPE;
  v_prog  public.cms_programs%ROWTYPE;
  v_run   public.cms_sync_runs%ROWTYPE;
  v_code  text;
  v_id    uuid;
  v_prev  uuid;
  v_n     bigint;
  v_maxat timestamptz;
  v_con   text;
  c_hex   CONSTANT text := '^[0-9a-f]{64}$';
  c_ts    CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?Z$';
  c_cnt   CONSTANT text := '^(0|[1-9][0-9]{0,8})$';
  c_date  CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';
BEGIN
  -- 1. Quyền: phiên authenticated của super (allowlist 2 nơi) + chương trình đọc được (QA cần marker cms_qa_access kể cả super —
  --    H9b, như đọc 122 / 123; db-reviewer P1-1); KHÔNG nhận actor từ tham số / payload.
  IF v_uid IS NULL OR NOT public.is_super_admin()
     OR NOT COALESCE(p_program_id = ANY (public.cms_readable_program_ids()), false) THEN
    RAISE EXCEPTION 'CMS_ATTEST_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  -- 2. Dạng đầu vào (trước mọi khoá / ghi). COALESCE(…, true): khoá thiếu ⇒ NULL ⇒ coi là SAI (db-reviewer P2-1 — trước r1 thiếu
  --    ack_reason lọt tới INSERT thành lỗi 23502 thô).
  IF COALESCE(p_program_id IS NULL OR p_run_id IS NULL OR p_idem IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR pg_column_size(p_payload) > 16384
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('fp_version', 'field_set', 'scope_from', 'scope_to',
                'scope_hash', 'run_rows_fp', 'run_file_sha256', 'reference_rows_fp', 'reference_file_sha256', 'reference_label', 'as_of',
                'reference_exported_at', 'run_exported_at', 'lines_compared', 'missing_lines', 'extra_lines', 'changed_lines',
                'tool_version', 'ack_reason'))
     OR jsonb_path_exists(p_payload, 'strict $.* ? (@.type() != "string")')
     OR NOT public.cms__str(p_payload, 'fp_version', '^cms-rows-fp-v1$')
     OR NOT public.cms__str(p_payload, 'field_set', '^decision10$')   -- PM COMP-P1-1: audit14 bị từ chối trước mọi khoá / ghi
     OR NOT public.cms__str(p_payload, 'scope_from', c_date) OR NOT public.cms__str(p_payload, 'scope_to', c_date)
     OR NOT public.cms__str(p_payload, 'scope_hash', c_hex) OR NOT public.cms__str(p_payload, 'run_rows_fp', c_hex)
     OR NOT public.cms__str(p_payload, 'run_file_sha256', c_hex) OR NOT public.cms__str(p_payload, 'reference_rows_fp', c_hex)
     OR NOT public.cms__str(p_payload, 'reference_file_sha256', c_hex)
     OR NOT public.cms__str(p_payload, 'reference_label', '^[^\x01-\x1f\x7f-\x9f]{3,200}$')
     OR (p_payload ->> 'reference_label') <> btrim(p_payload ->> 'reference_label')   -- r1 P2-2: không khoảng trắng đầu / cuối
     OR NOT public.cms__str(p_payload, 'as_of', c_ts) OR NOT public.cms__str(p_payload, 'reference_exported_at', c_ts)
     OR NOT public.cms__str(p_payload, 'run_exported_at', c_ts)
     OR NOT public.cms__str(p_payload, 'lines_compared', c_cnt) OR NOT public.cms__str(p_payload, 'missing_lines', c_cnt)
     OR NOT public.cms__str(p_payload, 'extra_lines', c_cnt) OR NOT public.cms__str(p_payload, 'changed_lines', c_cnt)
     OR NOT public.cms__str(p_payload, 'tool_version', '^cms-i4-compare-v1$')
     OR NOT public.cms__str(p_payload, 'ack_reason', '.')
     OR char_length(btrim(p_payload ->> 'ack_reason', E' \t\r\n\f\v')) NOT BETWEEN 10 AND 1000
     OR (p_payload ->> 'ack_reason') ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]', true) THEN
    RAISE EXCEPTION 'CMS_ATTEST_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  BEGIN
    PERFORM (p_payload ->> 'scope_from')::date, (p_payload ->> 'scope_to')::date, (p_payload ->> 'as_of')::timestamptz,
            (p_payload ->> 'reference_exported_at')::timestamptz, (p_payload ->> 'run_exported_at')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'CMS_ATTEST_BAD_INPUT' USING ERRCODE = '22023';
  END;
  v_sha := encode(sha256(convert_to(jsonb_build_object('program', p_program_id, 'run', p_run_id, 'payload', p_payload)::text, 'UTF8')), 'hex');
  -- 3. Khoá chương trình (thứ tự chương trình → run như publish / chốt / cleanup) rồi idempotency (sau khoá: lượt gọi lại song
  --    song cùng khoá chờ lượt đầu commit rồi thấy dòng).
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_old FROM public.cms_source_attestations WHERE idem_key = p_idem;
  IF FOUND THEN
    IF v_old.payload_sha256 = v_sha AND v_old.attested_by = v_uid THEN
      RETURN jsonb_build_object('attested', true, 'already', true, 'id', v_old.id, 'run_id', v_old.run_id,
                                'live', v_old.revoked_at IS NULL AND v_old.superseded_by IS NULL);
    END IF;
    RAISE EXCEPTION 'CMS_ATTEST_IDEM_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF v_prog.status = 'locked' THEN RAISE EXCEPTION 'CMS_PROGRAM_LOCKED' USING ERRCODE = 'P0001'; END IF;
  IF v_prog.status <> 'active' THEN RAISE EXCEPTION 'CMS_ATTEST_PROGRAM_NOT_ACTIVE' USING ERRCODE = 'P0001'; END IF;
  IF v_prog.current_result_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'CMS_ATTEST_RUN_NOT_CURRENT' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR SHARE;
  IF NOT FOUND OR v_run.program_id <> p_program_id OR v_run.kind <> 'sales' OR v_run.status <> 'ok' OR v_run.published_at IS NULL
     OR v_run.purged_at IS NOT NULL OR v_run.config_version IS DISTINCT FROM v_prog.config_version OR v_run.is_test <> v_prog.is_test THEN
    RAISE EXCEPTION 'CMS_ATTEST_STALE_RUN' USING ERRCODE = 'P0001';
  END IF;
  -- 128 (PM §3.4): decision10 không ràng buộc quantity_raw / uom_raw ⇒ không chứng nhận run cms_unit (không thay bằng audit14).
  IF v_run.quantity_basis IS DISTINCT FROM 'pos_base' THEN
    RAISE EXCEPTION 'CMS_UNIT_ATTESTATION_NOT_SUPPORTED' USING ERRCODE = 'P0001';
  END IF;
  IF public.cms__mapping_fp() IS DISTINCT FROM v_run.mapping_fp THEN
    RAISE EXCEPTION 'CMS_ATTEST_STALE_MAPPING' USING ERRCODE = 'P0001';
  END IF;
  -- 4. Lớp nguồn của run phải đủ / khớp lớp engine (run cũ ⇒ LEGACY_RUN).
  v_code := public.cms__run_source_check(p_run_id);
  IF v_code IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE = 'CMS_ATTEST_' || v_code, ERRCODE = 'P0001'; END IF;
  -- 5. Phạm vi = chương trình hiện tại (kỳ + toàn bộ ProductID).
  IF (p_payload ->> 'scope_from')::date <> v_prog.start_date OR (p_payload ->> 'scope_to')::date <> v_prog.end_date
     OR (p_payload ->> 'scope_hash') <> public.cms__program_scope_hash(p_program_id) THEN
    RAISE EXCEPTION 'CMS_ATTEST_SCOPE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  -- 6. Kết quả đối soát phải KHỚP; số dòng = lớp nguồn của run; vân tay = DB tính lại (binding run — không chứng minh nguồn).
  IF (p_payload ->> 'missing_lines')::integer <> 0 OR (p_payload ->> 'extra_lines')::integer <> 0
     OR (p_payload ->> 'changed_lines')::integer <> 0
     OR (p_payload ->> 'reference_rows_fp') <> (p_payload ->> 'run_rows_fp') THEN
    RAISE EXCEPTION 'CMS_ATTEST_NOT_MATCH' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*), max(completed_at) INTO v_n, v_maxat FROM public.cms_sales_source_lines WHERE run_id = p_run_id;
  IF v_n = 0 OR (p_payload ->> 'lines_compared')::bigint <> v_n THEN
    RAISE EXCEPTION 'CMS_ATTEST_COUNT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF (p_payload ->> 'run_rows_fp') <> public.cms__run_source_fp(p_run_id, 'decision10') THEN
    RAISE EXCEPTION 'CMS_ATTEST_FP_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  -- 7. Mốc M: không dòng nguồn nào hoàn tất SAU M; M ≥ hết kỳ VN (payout ghi đủ tới ngày kết thúc — r1 P2-4, PM xác nhận);
  --    M ≤ lúc xuất hai file; xuất run sau khi run công bố; ba mốc không ở tương lai (> now() + 5 phút).
  IF v_maxat > (p_payload ->> 'as_of')::timestamptz
     OR (p_payload ->> 'as_of')::timestamptz < ((v_prog.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
     OR (p_payload ->> 'as_of')::timestamptz > (p_payload ->> 'reference_exported_at')::timestamptz
     OR (p_payload ->> 'as_of')::timestamptz > (p_payload ->> 'run_exported_at')::timestamptz
     OR (p_payload ->> 'run_exported_at')::timestamptz < v_run.published_at
     OR (p_payload ->> 'reference_exported_at')::timestamptz > now() + interval '5 minutes'
     OR (p_payload ->> 'run_exported_at')::timestamptz > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'CMS_ATTEST_AS_OF' USING ERRCODE = 'P0001';
  END IF;
  -- 8. Thay chứng nhận còn hiệu lực cũ của run (FK superseded_by hoãn tới COMMIT) rồi ghi. Cùng khoá idem gửi song song cho HAI
  --    chương trình (khoá chương trình khác nhau) ⇒ lượt sau chờ unique idem_key rồi vi phạm ⇒ IDEM_CONFLICT (r1 P2-3).
  v_id := gen_random_uuid();
  UPDATE public.cms_source_attestations SET superseded_by = v_id, superseded_at = now()
   WHERE run_id = p_run_id AND revoked_at IS NULL AND superseded_by IS NULL
   RETURNING id INTO v_prev;
  BEGIN
  INSERT INTO public.cms_source_attestations (id, program_id, run_id, config_version, mapping_fp, basis, fp_version, field_set,
    scope_from, scope_to, scope_hash, run_rows_fp, run_file_sha256, reference_rows_fp, reference_file_sha256, reference_label,
    as_of, reference_exported_at, run_exported_at, lines_compared, missing_lines, extra_lines, changed_lines, tool_version,
    ack_reason, idem_key, payload_sha256, attested_by)
  VALUES (v_id, p_program_id, p_run_id, v_run.config_version, v_run.mapping_fp, 'operator_reconciliation', p_payload ->> 'fp_version',
    p_payload ->> 'field_set', (p_payload ->> 'scope_from')::date, (p_payload ->> 'scope_to')::date, p_payload ->> 'scope_hash',
    p_payload ->> 'run_rows_fp', p_payload ->> 'run_file_sha256', p_payload ->> 'reference_rows_fp', p_payload ->> 'reference_file_sha256',
    p_payload ->> 'reference_label', (p_payload ->> 'as_of')::timestamptz, (p_payload ->> 'reference_exported_at')::timestamptz,
    (p_payload ->> 'run_exported_at')::timestamptz, (p_payload ->> 'lines_compared')::integer, 0, 0, 0, p_payload ->> 'tool_version',
    btrim(p_payload ->> 'ack_reason', E' \t\r\n\f\v'), p_idem, v_sha, v_uid);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    IF v_con = 'cms_source_attest_idem' THEN RAISE EXCEPTION 'CMS_ATTEST_IDEM_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    RAISE;
  END;
  RETURN jsonb_build_object('attested', true, 'already', false, 'id', v_id, 'run_id', p_run_id, 'superseded_id', v_prev, 'live', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_run_source_export(p_program_id uuid, p_run_id uuid, p_after_line_id text DEFAULT NULL, p_limit integer DEFAULT 5000)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run  public.cms_sync_runs%ROWTYPE;
  v_rows jsonb;
  v_last text;
  v_n    integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin()
     OR NOT COALESCE(p_program_id = ANY (public.cms_readable_program_ids()), false) THEN  -- r1 P1-1: QA cần marker
    RAISE EXCEPTION 'CMS_ATTEST_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_program_id IS NULL OR p_run_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 5000
     OR (p_after_line_id IS NOT NULL AND char_length(p_after_line_id) NOT BETWEEN 1 AND 100) THEN
    RAISE EXCEPTION 'CMS_ATTEST_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id AND program_id = p_program_id AND kind = 'sales';
  IF NOT FOUND OR v_run.status <> 'ok' OR v_run.published_at IS NULL THEN
    RAISE EXCEPTION 'CMS_ATTEST_RUN_NOT_PUBLISHED' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.purged_at IS NOT NULL THEN RAISE EXCEPTION 'CMS_RESULT_RUN_GONE' USING ERRCODE = 'P0001'; END IF;
  IF v_run.source_schema IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'CMS_ATTEST_LEGACY_RUN' USING ERRCODE = 'P0001'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order_line_id', q.order_line_id, 'order_id', q.order_id, 'order_code', q.order_code, 'product_id', q.product_id,
           'seller_email', q.seller_email, 'pos_code', q.pos_code, 'order_type', q.order_type, 'order_status', q.order_status,
           'completed_at', public.cms__ts(q.completed_at), 'quantity_raw', q.quantity_raw, 'uom_raw', q.uom_raw,
           'base_quantity', q.base_quantity::text, 'gmv_amount', q.gmv_amount::text,
           'source_updated_at', public.cms__ts(q.source_updated_at)) ORDER BY q.order_line_id COLLATE "C"), '[]'::jsonb),
         (array_agg(q.order_line_id ORDER BY q.order_line_id COLLATE "C" DESC))[1], count(*)
    INTO v_rows, v_last, v_n
    FROM (SELECT * FROM public.cms_sales_source_lines s
           WHERE s.run_id = p_run_id AND (p_after_line_id IS NULL OR s.order_line_id COLLATE "C" > p_after_line_id COLLATE "C")
           ORDER BY s.order_line_id COLLATE "C" LIMIT p_limit) q;
  -- total: CHỈ trang đầu (p_after_line_id NULL) — một lần đếm qua index (run_id, …) để CLI kiểm đủ dòng; trang sau NULL (không
  -- quét lại mỗi trang — PM COMP-P2-2).
  RETURN jsonb_build_object('run_id', p_run_id, 'source_schema', v_run.source_schema, 'rows', v_rows,
                            -- 128: snapshot tra soát kèm cơ sở tính của run; run cms_unit không chứng nhận được (attestation_supported false).
                            'quantity_basis', v_run.quantity_basis, 'calculation_policy_version', v_run.calculation_policy_version,
                            'attestation_supported', v_run.quantity_basis IS NOT DISTINCT FROM 'pos_base',
                            'next_after', CASE WHEN v_n = p_limit THEN v_last END,
                            'total', CASE WHEN p_after_line_id IS NULL
                                          THEN (SELECT count(*) FROM public.cms_sales_source_lines s WHERE s.run_id = p_run_id) END);
END;
$$;

-- ── 7. ACL: thu hồi đích danh rồi cấp đúng ma trận (gate ACL — cả 6 hàm mới lẫn 15 hàm OR REPLACE) ──
REVOKE ALL ON FUNCTION
  public.cms__unit_key(text), public.cms__qty_dec(text), public.cms__basis_policy(text), public.cms__calc_snapshot(uuid),
  public.cms__programs_basis_guard(), public.cms__runs_basis_guard(),
  public.cms__sales_snapshot(uuid), public.cms__config_fp(uuid), public.cms__attest_eval(uuid, uuid),
  public.cms__lock_eval(uuid, uuid, integer, text, boolean),
  public.rpc_cms_program_save(jsonb), public.rpc_cms_sales_run_open(uuid, jsonb), public.rpc_cms_sales_run_seal_begin(uuid, jsonb),
  public.rpc_cms_sales_run_seal_step(uuid, integer), public.rpc_cms_sales_run_publish(uuid), public.rpc_cms_sales_run_finish(uuid, text, jsonb),
  public.rpc_cms_result_header(uuid), public.rpc_cms_result_rows(uuid, uuid),
  public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer),
  public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid), public.rpc_cms_run_source_export(uuid, uuid, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.rpc_cms_program_save(jsonb), public.rpc_cms_sales_run_open(uuid, jsonb), public.rpc_cms_sales_run_seal_begin(uuid, jsonb),
  public.rpc_cms_sales_run_seal_step(uuid, integer), public.rpc_cms_sales_run_publish(uuid), public.rpc_cms_sales_run_finish(uuid, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.rpc_cms_result_header(uuid), public.rpc_cms_result_rows(uuid, uuid),
  public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer),
  public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid), public.rpc_cms_run_source_export(uuid, uuid, text, integer)
  TO authenticated;
-- Thu hồi mọi grant khác owner do default privileges cấp (bài học SEC-1 / 091 / 117 / 120–126).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, x.grantee
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.oid IN (SELECT unnest(ARRAY['public.cms__unit_key(text)', 'public.cms__qty_dec(text)', 'public.cms__basis_policy(text)', 'public.cms__calc_snapshot(uuid)', 'public.cms__programs_basis_guard()', 'public.cms__runs_basis_guard()', 'public.cms__sales_snapshot(uuid)', 'public.cms__config_fp(uuid)', 'public.cms__attest_eval(uuid, uuid)', 'public.cms__lock_eval(uuid, uuid, integer, text, boolean)', 'public.rpc_cms_program_save(jsonb)', 'public.rpc_cms_sales_run_open(uuid, jsonb)', 'public.rpc_cms_sales_run_seal_begin(uuid, jsonb)', 'public.rpc_cms_sales_run_seal_step(uuid, integer)', 'public.rpc_cms_sales_run_publish(uuid)', 'public.rpc_cms_sales_run_finish(uuid, text, jsonb)', 'public.rpc_cms_result_header(uuid)', 'public.rpc_cms_result_rows(uuid, uuid)', 'public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer)', 'public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid)', 'public.rpc_cms_run_source_export(uuid, uuid, text, integer)']::regprocedure[]))
       AND x.grantee <> p.proowner
       AND NOT (p.proname IN ('rpc_cms_program_save', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_seal_begin', 'rpc_cms_sales_run_seal_step', 'rpc_cms_sales_run_publish', 'rpc_cms_sales_run_finish') AND x.grantee = 'service_role'::regrole::oid)
       AND NOT (p.proname IN ('rpc_cms_result_header', 'rpc_cms_result_rows', 'rpc_cms_result_lines', 'rpc_cms_source_attest', 'rpc_cms_run_source_export') AND x.grantee = 'authenticated'::regrole::oid)
     GROUP BY p.oid, x.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- ── 8. Hậu kiểm trong transaction ──────────────────────────────────────────
DO $$
DECLARE
  r   record;
  v_n integer;
BEGIN
  v_n := 0;
  FOR r IN
    SELECT p.proname, p.prosecdef, p.proconfig, p.provolatile,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ','
                              ORDER BY CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END, x.privilege_type)
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl,
           has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
           has_function_privilege('service_role', p.oid, 'EXECUTE') s
      FROM pg_catalog.pg_proc p
     WHERE p.oid IN (SELECT unnest(ARRAY['public.cms__unit_key(text)', 'public.cms__qty_dec(text)', 'public.cms__basis_policy(text)', 'public.cms__calc_snapshot(uuid)', 'public.cms__programs_basis_guard()', 'public.cms__runs_basis_guard()', 'public.cms__sales_snapshot(uuid)', 'public.cms__config_fp(uuid)', 'public.cms__attest_eval(uuid, uuid)', 'public.cms__lock_eval(uuid, uuid, integer, text, boolean)', 'public.rpc_cms_program_save(jsonb)', 'public.rpc_cms_sales_run_open(uuid, jsonb)', 'public.rpc_cms_sales_run_seal_begin(uuid, jsonb)', 'public.rpc_cms_sales_run_seal_step(uuid, integer)', 'public.rpc_cms_sales_run_publish(uuid)', 'public.rpc_cms_sales_run_finish(uuid, text, jsonb)', 'public.rpc_cms_result_header(uuid)', 'public.rpc_cms_result_rows(uuid, uuid)', 'public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer)', 'public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid)', 'public.rpc_cms_run_source_export(uuid, uuid, text, integer)']::regprocedure[]))
  LOOP
    v_n := v_n + 1;
    IF r.a OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}')))
       OR (r.proname NOT IN ('cms__programs_basis_guard', 'cms__runs_basis_guard') AND NOT r.prosecdef)
       OR r.acl IS DISTINCT FROM (CASE WHEN r.proname IN ('rpc_cms_program_save', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_seal_begin', 'rpc_cms_sales_run_seal_step', 'rpc_cms_sales_run_publish', 'rpc_cms_sales_run_finish') THEN 'service_role:EXECUTE'
                                       WHEN r.proname IN ('rpc_cms_result_header', 'rpc_cms_result_rows', 'rpc_cms_result_lines', 'rpc_cms_source_attest', 'rpc_cms_run_source_export') THEN 'authenticated:EXECUTE' END)
       OR r.s IS DISTINCT FROM (r.proname IN ('rpc_cms_program_save', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_seal_begin', 'rpc_cms_sales_run_seal_step', 'rpc_cms_sales_run_publish', 'rpc_cms_sales_run_finish'))
       OR r.u IS DISTINCT FROM (r.proname IN ('rpc_cms_result_header', 'rpc_cms_result_rows', 'rpc_cms_result_lines', 'rpc_cms_source_attest', 'rpc_cms_run_source_export'))
       OR (r.proname IN ('rpc_cms_program_save', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_seal_begin', 'rpc_cms_sales_run_seal_step', 'rpc_cms_sales_run_publish', 'rpc_cms_sales_run_finish') AND (NOT ('lock_timeout=5s' = ANY (COALESCE(r.proconfig, '{}'))) OR r.provolatile <> 'v'))
       OR (r.proname = 'rpc_cms_sales_run_seal_step' AND NOT ('enable_nestloop=off' = ANY (COALESCE(r.proconfig, '{}'))))
       OR (r.proname IN ('cms__unit_key', 'cms__qty_dec', 'cms__basis_policy') AND r.provolatile <> 'i') THEN
      RAISE EXCEPTION '128 hậu kiểm: ACL / SECDEF / search_path / lock_timeout / volatility hàm % sai (acl %, config %)', r.proname, r.acl, r.proconfig;
    END IF;
  END LOOP;
  IF v_n <> 21 THEN RAISE EXCEPTION '128 hậu kiểm: cần đúng 21 hàm (6 mới + 15 thay), có %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> 74 THEN RAISE EXCEPTION '128 hậu kiểm: tổng hàm CMS phải 74 (68 + 6 mới), có %', v_n; END IF;
  -- Cột / ràng buộc / trigger mới.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'public.cms_programs'::regclass AND a.attname = 'quantity_basis'
                  AND a.attnotnull AND NOT a.attisdropped)
     OR (SELECT count(*) FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'public.cms_sync_runs'::regclass AND NOT a.attisdropped
          AND a.attname IN ('quantity_basis', 'calculation_policy_version', 'calculation_snapshot')) <> 3
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.cms_programs'::regclass
                     AND conname = 'cms_programs_quantity_basis_check' AND convalidated)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.cms_sync_runs'::regclass
                     AND conname = 'cms_sync_runs_basis_shape' AND convalidated) THEN
    RAISE EXCEPTION '128 hậu kiểm: thiếu cột / ràng buộc cơ sở tính';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgenabled = 'A'
         AND ((t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_basis_guard'
               AND t.tgfoid = 'public.cms__programs_basis_guard()'::regprocedure)
           OR (t.tgrelid = 'public.cms_sync_runs'::regclass AND t.tgname = 'cms_sync_runs_basis_guard'
               AND t.tgfoid = 'public.cms__runs_basis_guard()'::regprocedure))) <> 2 THEN
    RAISE EXCEPTION '128 hậu kiểm: thiếu trigger guard cơ sở tính (ENABLE ALWAYS)';
  END IF;
  -- Không đổi cơ sở / pointer / tiền của chương trình nào; mọi run bán cũ mang nhãn legacy.
  IF EXISTS (SELECT 1 FROM public.cms_programs WHERE quantity_basis <> 'pos_base')
     OR EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales'
                 AND (quantity_basis IS DISTINCT FROM 'pos_base' OR calculation_policy_version IS DISTINCT FROM 'pos_base_legacy'
                      OR calculation_snapshot IS NOT NULL))
     OR EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'products'
                 AND (quantity_basis IS NOT NULL OR calculation_policy_version IS NOT NULL OR calculation_snapshot IS NOT NULL)) THEN
    RAISE EXCEPTION '128 hậu kiểm: cơ sở chương trình / nhãn run cũ sai';
  END IF;
  -- Cổng / policy giữ nguyên.
  IF public.cms__results_release_open() IS DISTINCT FROM true
     OR (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION '128 hậu kiểm: cổng kết quả / policy chốt bị đổi';
  END IF;
  -- Hằng hợp đồng khoá đơn vị (mẫu cố định, cùng bảng TS): parity tối thiểu ngay trong transaction.
  IF public.cms__unit_key(' Hộp ') IS DISTINCT FROM 'hộp' OR public.cms__unit_key(E'HỘP') IS DISTINCT FROM 'hộp'
     OR public.cms__unit_key('VỈ') IS DISTINCT FROM 'vỉ' OR public.cms__unit_key('ĐƯỜNG') IS DISTINCT FROM 'đường'
     OR public.cms__unit_key(chr(160) || 'BOX' || chr(12288)) IS DISTINCT FROM 'box' OR public.cms__unit_key(E'hộp\t') IS NOT NULL
     OR public.cms__unit_key('   ') IS NOT NULL OR public.cms__qty_dec('1.000000000') IS DISTINCT FROM 1
     OR public.cms__qty_dec('1e3') IS NOT NULL OR public.cms__qty_dec('0.0000000001') IS NOT NULL THEN
    RAISE EXCEPTION '128 hậu kiểm: helper khoá đơn vị / lượng lệch hợp đồng';
  END IF;
END $$;
-- Thân 21 hàm (6 mới + 15 thay) phải đúng bản sinh (md5) — khối sinh bởi gen-cms-128.mjs.
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__unit_key(text)'::regprocedure) IS DISTINCT FROM 'a5452292d761fc646857ac76a2019ef3'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__qty_dec(text)'::regprocedure) IS DISTINCT FROM 'fb241862be3362150b732839e0d492b4'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__basis_policy(text)'::regprocedure) IS DISTINCT FROM '6cb8e9477a077ab77d1a06ceac88228d'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__calc_snapshot(uuid)'::regprocedure) IS DISTINCT FROM '96ab15b002533fb6a9c26a1ea5cea772'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__programs_basis_guard()'::regprocedure) IS DISTINCT FROM '7373882ed1ace933597e8c8aa9910be1'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__runs_basis_guard()'::regprocedure) IS DISTINCT FROM '4812474ee419e38306870b70da91227d'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__sales_snapshot(uuid)'::regprocedure) IS DISTINCT FROM '5b23f40e341fbffeece40f69a90653c5'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__config_fp(uuid)'::regprocedure) IS DISTINCT FROM '8534cfcbebecc0bd699e8ccecd9bcdd4'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__attest_eval(uuid, uuid)'::regprocedure) IS DISTINCT FROM '3f9f3d9ad9697caab34991082b58a45c'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__lock_eval(uuid, uuid, integer, text, boolean)'::regprocedure) IS DISTINCT FROM 'ded0e1ccc95ffbb78c8aac29ad923b59'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_program_save(jsonb)'::regprocedure) IS DISTINCT FROM 'a067cedf4136313b684eec9ad3e80ffd'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_open(uuid, jsonb)'::regprocedure) IS DISTINCT FROM '5d90e13103a0c828e18813d3b02dca03'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_seal_begin(uuid, jsonb)'::regprocedure) IS DISTINCT FROM 'b81e7dd702a0ad579ad8515357eb8538'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_seal_step(uuid, integer)'::regprocedure) IS DISTINCT FROM 'd68aabb675d8ee609ea769dbf36efaeb'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure) IS DISTINCT FROM 'fa7be492995e11a2054e9af258cd55b6'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_finish(uuid, text, jsonb)'::regprocedure) IS DISTINCT FROM '020d48720b83c1aed0aebedb3a19afff'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_result_header(uuid)'::regprocedure) IS DISTINCT FROM 'a55a96a70796163a8f6dcd9b042d3931'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_result_rows(uuid, uuid)'::regprocedure) IS DISTINCT FROM 'c32b8e2183e4fc9e9914abfc770a6b3f'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer)'::regprocedure) IS DISTINCT FROM '79f3960c3e7a4b186056fcd6e09839c5'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid)'::regprocedure) IS DISTINCT FROM '74cd1e68de442952596576c803594be7'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_run_source_export(uuid, uuid, text, integer)'::regprocedure) IS DISTINCT FROM 'b4cf8f9fe5f5b7d6201f9e51e3aa690f' THEN
    RAISE EXCEPTION '128 hậu kiểm: thân 21 hàm lệch bản sinh (md5)';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('128', 'cms_unit_quantity_basis', 'CMS-UNIT capability (Q-221…Q-224): cms_programs.quantity_basis pos_base | cms_unit (mặc định '
  || 'pos_base — không đổi chương trình nào); metadata tính bất biến theo run (quantity_basis / calculation_policy_version / '
  || 'calculation_snapshot; run bán cũ = pos_base_legacy); seal 7 / 10 nhánh cms_unit + dấu writer; publish / chứng nhận / chốt / đọc '
  || 'theo cơ sở của run; cms_unit chặn chứng nhận decision10 · inventory ' || current_setting('cms128.inventory'));

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — `node scripts/cms-verify.mjs post --phase=128 --pre=<PRE chụp NGAY TRƯỚC 128>`) ──
-- Sau 128, cms-verify phase 127 ĐỎ đúng thiết kế (6 hàm mới, 15 thân thay, cột / ràng buộc / trigger mới) ⇒ phase 128 (CMS_FN_SRC_128
-- sinh bằng scripts/gen-cms-verify-fp-128.mjs từ file migration).
-- V1 marker:
--   SELECT version, name, notes FROM public.app_migrations WHERE version IN ('127', '128') ORDER BY 1;
-- V2 cơ sở chương trình + nhãn run (kỳ vọng: mọi chương trình pos_base; run bán cũ pos_base_legacy, snapshot NULL):
--   SELECT quantity_basis, count(*) FROM public.cms_programs GROUP BY 1;
--   SELECT kind, quantity_basis, calculation_policy_version, calculation_snapshot IS NULL AS snap_null, count(*)
--     FROM public.cms_sync_runs GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3;
-- V3 ACL 21 hàm: 6 helper chỉ owner (anon / authenticated / service_role f); 6 rpc_cms_* ghi service_role; 5 rpc đọc / chứng nhận
--   authenticated; seal_step giữ enable_nestloop=off — `cms-verify post --phase=128`.
-- V4 hành vi (READ ONLY): SELECT public.cms__unit_key(' Hộp '), public.cms__qty_dec('2.000000000');   -- hộp · 2.000000000
