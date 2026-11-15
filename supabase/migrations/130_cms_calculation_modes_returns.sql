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
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('cms__src_clean', 'cms__unit_key', 'cms__qty_dec', 'cms__return_status_effect', 'cms__return_fp', 'cms__programs_basis_guard', 'cms__products_basis_guard', 'rpc_cms_program_save_v2', 'rpc_cms_program_set_returns_policy', 'rpc_cms_capabilities', 'cms__stage_contract', 'cms__seal_begin_contract', 'cms__seal_contract_step', 'cms__ledger_set_hash', 'cms__open_set_hash', 'cms__as_of_floor', 'cms__ledger_immutable', 'cms__ledger_eval_guard', 'cms__ledger_insert_guard', 'cms__ledger_eval', 'cms__publish_contract', 'rpc_cms_return_conflicts_confirm_restored', 'cms__run_contract', 'rpc_cms_result_header_v2', 'rpc_cms_result_rows_v2', 'rpc_cms_result_events_v2', 'rpc_cms_result_excluded_v2', 'rpc_cms_result_returns_v2', 'rpc_cms_return_conflicts', 'cms__report_rows', 'rpc_cms_return_close_report_save', 'rpc_cms_frozen_sales_lines', 'rpc_cms_return_close_reports', 'rpc_cms_return_close_report', 'rpc_cms_return_close_report_events')) THEN
    RAISE EXCEPTION '130: đã có cột / hàm của 130 — DB không ở trạng thái nền 127';
  END IF;
  -- ACL nền của hàm sắp thay (OR REPLACE giữ ACL — phải đúng ma trận trước khi thay).
  FOR r IN SELECT x.sig, x.want FROM (VALUES ('rpc_cms_sales_run_open(uuid,jsonb)', 'service_role:EXECUTE'::text), ('rpc_cms_sales_run_stage(uuid,text,integer,jsonb)', 'service_role:EXECUTE'), ('rpc_cms_sales_run_cleanup(uuid,integer)', 'service_role:EXECUTE'), ('cms__lock_eval(uuid,uuid,integer,text,boolean)', NULL), ('cms__attest_eval(uuid,uuid)', NULL), ('rpc_cms_sales_run_seal_begin(uuid,jsonb)', 'service_role:EXECUTE'), ('rpc_cms_sales_run_seal_step(uuid,integer)', 'service_role:EXECUTE'), ('cms__sales_snapshot(uuid)', NULL), ('rpc_cms_result_header(uuid)', 'authenticated:EXECUTE'), ('rpc_cms_result_rows(uuid,uuid)', 'authenticated:EXECUTE'), ('rpc_cms_result_lines(uuid,uuid,uuid,uuid,integer,integer)', 'authenticated:EXECUTE'), ('rpc_cms_result_excluded(uuid,uuid,integer,integer)', 'authenticated:EXECUTE'), ('rpc_cms_sales_run_publish(uuid)', 'service_role:EXECUTE')) AS x(sig, want) LOOP
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
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_open(uuid,jsonb)')) IS DISTINCT FROM 'a0123bc5abeefac9da1c8dbcd645a97a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_stage(uuid,text,integer,jsonb)')) IS DISTINCT FROM 'b19df838c787755c56c76cfd8ff48a3a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_cleanup(uuid,integer)')) IS DISTINCT FROM 'bbea7ad89f57a054a998db7b72d854b3'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__lock_eval(uuid,uuid,integer,text,boolean)')) IS DISTINCT FROM '6c38e2ca40f37d1cc5e715f8cd3e2bb5'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__attest_eval(uuid,uuid)')) IS DISTINCT FROM 'a75e03e0b4c7a45c446af38698cf44e9'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_seal_begin(uuid,jsonb)')) IS DISTINCT FROM '327d53af6739ffdbf780363aa6460bcc'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_seal_step(uuid,integer)')) IS DISTINCT FROM '55462ce6e7a5b5e6ad26a2c1751ca726'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__sales_snapshot(uuid)')) IS DISTINCT FROM 'e22120f8a95af5308420914c441ca260'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_header(uuid)')) IS DISTINCT FROM '26abaac3902886c1e82c92a9dcf321ec'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_rows(uuid,uuid)')) IS DISTINCT FROM 'a63f54b3243637c2c8979d0bc24c9d81'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_lines(uuid,uuid,uuid,uuid,integer,integer)')) IS DISTINCT FROM 'c1bf6ff7c059a4b3fe13c140205306cd'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_excluded(uuid,uuid,integer,integer)')) IS DISTINCT FROM '5fa1aa66c4c013bd2ca4a2f72cde6978'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_publish(uuid)')) IS DISTINCT FROM 'db2c97efad2bb5ee9d69399b99c7c258' THEN
    RAISE EXCEPTION '130 preflight: thân một trong 13 hàm sắp thay KHÁC bản cuối 120–126 đã duyệt (md5) — dừng, đối chiếu tay';
  END IF;
END $$;
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_program_save(jsonb)')) IS DISTINCT FROM '5f9360e7c3c1d4dd828b50f8fc1c2115'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_import_commit(uuid,text,text,jsonb,uuid)')) IS DISTINCT FROM '65bd0b43e24fda590eec4cd764f959c2'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_program_activate(uuid,uuid)')) IS DISTINCT FROM '6ae92590bf7afc237c80cc3db15e5aad'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__config_fp(uuid)')) IS DISTINCT FROM '08cf01ecc1809866eff314b5ec82d170'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__programs_lock_guard()')) IS DISTINCT FROM '23201e6389865e668665951d611e46de'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_source_attest(uuid,uuid,jsonb,uuid)')) IS DISTINCT FROM '32b51294e2837918377ba37007da38f1'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_finish(uuid,text,jsonb)')) IS DISTINCT FROM '20a74c4806dfc520ce165c181e09c739'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__programs_result_guard()')) IS DISTINCT FROM '8784c4589f1d3875b50d015223fc7b93'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__programs_guard()')) IS DISTINCT FROM '4dae021fddc4ae654955d2a37e434eb7'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__config_auth_guard()')) IS DISTINCT FROM 'd960d7d4465da96de1fdca09ecee3abf'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__config_lock_guard()')) IS DISTINCT FROM 'bcd7ae0e4b4857b42b5904d6570625d0'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__tiers_last_open_guard()')) IS DISTINCT FROM 'd83088c260633f520dac35cfe8169475' THEN
    RAISE EXCEPTION '130 preflight: thân một trong 12 hàm ghim (nền 130 + guard 127) KHÁC bản đã duyệt (md5) — dừng, đối chiếu tay';
  END IF;
END $$;

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

-- ── 1. Helper hợp đồng (chỉ owner; RPC SECDEF cùng owner gọi) ─────────────
-- Làm sạch chuỗi thô q / u — ĐÚNG text() của lớp nguồn (lib/cms/source/contract.ts; lib/cms/calc/fp.ts cmsSrcClean): ký tự điều khiển
-- C0 / DEL / C1 → space, rồi cắt hai đầu theo TẬP ĐO được của String.prototype.trim sau bước thay (U+180E / 200B / 2060 KHÔNG cắt),
-- rỗng ⇒ NULL. Không NFC, không đổi hoa / thường. Tập cắt sinh từ hằng generator (parity TS ↔ PGlite ↔ PG15 ở harness).
CREATE FUNCTION public.cms__src_clean(p text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path = public AS $$
  SELECT NULLIF(btrim(regexp_replace(p, '[\x01-\x1f\x7f-\x9f]', ' ', 'g'), E'\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), '')
$$;

-- Khoá so khớp đơn vị — hợp đồng CHUNG với lib/cms/unitKey.ts cmsUnitKey (cms-unit-key-v2): ký tự điều khiển C0 / DEL / C1 hoặc
-- ký tự định dạng / vô hình của tập tường minh CMS_UNIT_INVISIBLE ở BẤT KỲ vị trí nào ⇒ NULL (kiểm trên chuỗi THÔ trước NFC / cắt);
-- NFC; cắt khoảng trắng hai đầu theo tập tường minh CMS_UNIT_WS; hoa → thường theo bảng tường minh bằng translate (không lower():
-- phụ thuộc locale). Không bỏ dấu / alias / cắt độ dài. Lớp ký tự / bảng sinh từ hằng TS.
CREATE FUNCTION public.cms__unit_key(p_unit text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_unit ~ '[\x01-\x1f\x7f-\x9f]' OR p_unit ~ E'[\u00AD\u034F\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u115F-\u1160\u17B4-\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB]' THEN NULL
              ELSE NULLIF(translate(btrim(normalize(p_unit, NFC), E'\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽƠƯḀḂḄḆḈḊḌḎḐḒḔḖḘḚḜḞḠḢḤḦḨḪḬḮḰḲḴḶḸḺḼḾṀṂṄṆṈṊṌṎṐṒṔṖṘṚṜṞṠṢṤṦṨṪṬṮṰṲṴṶṸṺṼṾẀẂẄẆẈẊẌẎẐẒẔẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸỺỼỾ', 'abcdefghijklmnopqrstuvwxyzàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþāăąćĉċčďđēĕėęěĝğġģĥħĩīĭįĳĵķĺļľŀłńņňŋōŏőœŕŗřśŝşšţťŧũūŭůűųŵŷÿźżžơưḁḃḅḇḉḋḍḏḑḓḕḗḙḛḝḟḡḣḥḧḩḫḭḯḱḳḵḷḹḻḽḿṁṃṅṇṉṋṍṏṑṓṕṗṙṛṝṟṡṣṥṧṩṫṭṯṱṳṵṷṹṻṽṿẁẃẅẇẉẋẍẏẑẓẕạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹỻỽỿ'), '') END
$$;

-- Lượng gốc dạng thập phân chính xác — cùng hợp đồng cmsUnitQuantity / parseCmsDecimal (dấu chấm, ≤ 9 chữ số lẻ, ≤ 29 chữ số nguyên
-- sau bỏ số 0 đầu, có thể âm; không khoảng trắng / số mũ / dấu +). Sai hình thức ⇒ NULL.
CREATE FUNCTION public.cms__qty_dec(p_raw text)
RETURNS numeric LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_raw ~ '^-?[0-9]+(\.[0-9]{1,9})?$'
               AND char_length(regexp_replace(substring(p_raw FROM '^-?([0-9]+)'), '^0+(?=[0-9])', '')) <= 29
              THEN p_raw::numeric END
$$;

-- Từ điển trạng thái phiếu trả (cms-return-status-v1 — PM D13): so khớp BYTE trên chuỗi thô; ngoài từ điển ⇒ NULL (lạ ⇒ HOLD).
CREATE FUNCTION public.cms__return_status_effect(p_status text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE p_status WHEN 'COMPLETED' THEN 'EFFECTIVE' WHEN 'APPROVED' THEN 'NOT_EFFECTIVE' END
$$;

-- Vân tay tài chính của phiếu trả (cms-return-fp-v1 — PM D14 / RET2-DB-01): sha256 hex của tuple chuẩn, mỗi trường
-- `<độ dài byte UTF-8>:<giá trị>` nối liền; số → chuỗi số nguyên đơn vị 10⁻⁹ (trunc scale 0, không `.0`); thời điểm → µs UTC.
-- Không email / user / store. Version lạ hoặc thiếu trường ⇒ NULL (CHECK baseline ép version + NOT NULL). Cùng hợp đồng
-- lib/cms/calc/fp.ts cmsReturnFinancialFp (vector độc lập sha256sum — parity ở harness).
CREATE FUNCTION public.cms__return_fp(p_version text, p_program_id uuid, p_return_event_id text, p_return_document_id text,
                                      p_original_order_line_id text, p_original_order_id text, p_product_id text,
                                      p_base numeric, p_refund numeric, p_recorded_at timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_version = 'cms-return-fp-v1' AND p_program_id IS NOT NULL AND p_return_event_id IS NOT NULL
                   AND p_return_document_id IS NOT NULL AND p_original_order_line_id IS NOT NULL AND p_original_order_id IS NOT NULL
                   AND p_product_id IS NOT NULL AND p_base IS NOT NULL AND p_refund IS NOT NULL AND p_recorded_at IS NOT NULL
                   AND isfinite(p_recorded_at)
              THEN encode(sha256(convert_to(string_agg(octet_length(f) || ':' || f, '' ORDER BY i), 'UTF8')), 'hex') END
    FROM unnest(ARRAY[p_version, p_program_id::text, p_return_event_id, p_return_document_id, p_original_order_line_id,
                      p_original_order_id, p_product_id, trunc(p_base * 1000000000, 0)::text, trunc(p_refund * 1000000000, 0)::text,
                      trunc(extract(epoch FROM p_recorded_at) * 1000000, 0)::text]) WITH ORDINALITY AS t(f, i)
$$;

-- ── 2. Chương trình: cách tính lượng + chính sách trả (thiết kế r2 §3) ─────
-- Backfill KHÔNG UPDATE (cms__programs_lock_guard chặn dòng locked, cms_config_auth_guard chặn non-owner): ADD COLUMN DEFAULT điền
-- nhanh mọi dòng có sẵn ⇒ ('pos_base', 'legacy_migration', 'sales_only_v1'), rồi bỏ DEFAULT của hai cột basis (INSERT mới phải đi qua
-- trigger tương thích). Không tăng config_version, không đổi pointer / tiền / kỳ / K / mức, không actor giả.
ALTER TABLE public.cms_programs
  ADD COLUMN quantity_basis         text        DEFAULT 'pos_base',
  ADD COLUMN quantity_basis_source  text        NOT NULL DEFAULT 'legacy_migration',
  ADD COLUMN quantity_basis_set_by  uuid,
  ADD COLUMN quantity_basis_set_at  timestamptz,
  ADD COLUMN returns_policy         text        NOT NULL DEFAULT 'sales_only_v1',
  ADD COLUMN returns_policy_set_by  uuid,
  ADD COLUMN returns_policy_set_at  timestamptz;
ALTER TABLE public.cms_programs
  ALTER COLUMN quantity_basis DROP DEFAULT,
  ALTER COLUMN quantity_basis_source DROP DEFAULT,
  ADD CONSTRAINT cms_programs_basis_value CHECK (quantity_basis IS NULL OR quantity_basis IN ('pos_base', 'cms_unit')),
  ADD CONSTRAINT cms_programs_basis_source_value
    CHECK (quantity_basis_source IN ('legacy_migration', 'legacy_compat', 'admin', 'pending')),
  ADD CONSTRAINT cms_programs_returns_policy_value CHECK (returns_policy IN ('sales_only_v1', 'net_returns_v1')),
  -- pending ⇔ chưa chọn; nháp được chưa chọn, active / locked thì phải có.
  ADD CONSTRAINT cms_programs_basis_state CHECK ((quantity_basis_source = 'pending') = (quantity_basis IS NULL)),
  ADD CONSTRAINT cms_programs_basis_draft CHECK (status = 'draft' OR quantity_basis IS NOT NULL),
  -- Actor: legacy_* không actor; admin / pending có người chọn + thời điểm.
  ADD CONSTRAINT cms_programs_basis_actor CHECK (
    (quantity_basis_source IN ('admin', 'pending')) = (quantity_basis_set_by IS NOT NULL)
    AND (quantity_basis_set_by IS NULL) = (quantity_basis_set_at IS NULL)),
  ADD CONSTRAINT cms_programs_policy_actor CHECK (
    (returns_policy = 'net_returns_v1') = (returns_policy_set_by IS NOT NULL)
    AND (returns_policy_set_by IS NULL) = (returns_policy_set_at IS NULL));

-- Trigger tương thích (BEFORE ROW, ENABLE ALWAYS). INSERT không mang basis (mọi INSERT của rpc_cms_program_save 121: client cũ, app cờ
-- OFF, bước đầu của save_v2) ⇒ ('pos_base', 'legacy_compat'). Đổi basis chỉ ở nháp, kèm config_version tăng, không quay về legacy_*.
-- Kích hoạt cần basis + (cms_unit) mọi đơn vị CMS có khoá hợp lệ. Chính sách trả chỉ một chiều sales_only_v1 → net_returns_v1.
CREATE FUNCTION public.cms__programs_basis_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.quantity_basis_source IS NOT NULL OR NEW.quantity_basis IS NOT NULL
       OR NEW.quantity_basis_set_by IS NOT NULL OR NEW.quantity_basis_set_at IS NOT NULL THEN
      RAISE EXCEPTION 'CMS_BASIS_INVALID' USING ERRCODE = '22023';
    END IF;
    IF NEW.returns_policy IS DISTINCT FROM 'sales_only_v1' OR NEW.returns_policy_set_by IS NOT NULL OR NEW.returns_policy_set_at IS NOT NULL THEN
      RAISE EXCEPTION 'CMS_RETURNS_POLICY_INVALID' USING ERRCODE = '22023';
    END IF;
    NEW.quantity_basis := 'pos_base';
    NEW.quantity_basis_source := 'legacy_compat';
    RETURN NEW;
  END IF;
  IF (NEW.quantity_basis, NEW.quantity_basis_source, NEW.quantity_basis_set_by, NEW.quantity_basis_set_at)
       IS DISTINCT FROM (OLD.quantity_basis, OLD.quantity_basis_source, OLD.quantity_basis_set_by, OLD.quantity_basis_set_at) THEN
    IF OLD.status <> 'draft' OR NEW.status <> 'draft' OR NEW.config_version <= OLD.config_version THEN
      RAISE EXCEPTION 'CMS_BASIS_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.quantity_basis_source NOT IN ('admin', 'pending') THEN
      RAISE EXCEPTION 'CMS_BASIS_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF (NEW.returns_policy, NEW.returns_policy_set_by, NEW.returns_policy_set_at)
       IS DISTINCT FROM (OLD.returns_policy, OLD.returns_policy_set_by, OLD.returns_policy_set_at) THEN
    IF OLD.returns_policy = 'net_returns_v1' THEN
      RAISE EXCEPTION 'CMS_RETURNS_POLICY_REGRESSION' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.returns_policy <> 'net_returns_v1' OR OLD.status NOT IN ('draft', 'active') OR NEW.status <> OLD.status
       OR NEW.config_version <= OLD.config_version OR NEW.quantity_basis IS NULL THEN
      RAISE EXCEPTION 'CMS_RETURNS_POLICY_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'active' THEN
    IF NEW.quantity_basis IS NULL THEN
      RAISE EXCEPTION 'CMS_BASIS_NOT_SET' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.quantity_basis = 'cms_unit' AND EXISTS (
         SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = NEW.id AND public.cms__unit_key(pp.unit_cms) IS NULL) THEN
      RAISE EXCEPTION 'CMS_UNIT_CMS_INVALID' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cms_programs_basis_guard BEFORE INSERT OR UPDATE ON public.cms_programs
  FOR EACH ROW EXECUTE FUNCTION public.cms__programs_basis_guard();
ALTER TABLE public.cms_programs ENABLE ALWAYS TRIGGER cms_programs_basis_guard;

-- SP chỉ vào chương trình đã chọn basis; chương trình cms_unit nhận SP khi đơn vị CMS có khoá hợp lệ (kể cả append vào active).
-- Chạy SAU cms_config_lock_guard (tên) ⇒ dòng chương trình đã khoá FOR SHARE, basis không đổi xen giữa.
CREATE FUNCTION public.cms__products_basis_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_basis  text;
  v_source text;
BEGIN
  SELECT p.quantity_basis, p.quantity_basis_source INTO v_basis, v_source FROM public.cms_programs p WHERE p.id = NEW.program_id;
  IF v_source = 'pending' THEN
    RAISE EXCEPTION 'CMS_BASIS_NOT_SET' USING ERRCODE = 'P0001';
  END IF;
  IF v_basis = 'cms_unit' AND public.cms__unit_key(NEW.unit_cms) IS NULL THEN
    RAISE EXCEPTION 'CMS_UNIT_CMS_INVALID' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cms_products_basis_guard BEFORE INSERT OR UPDATE ON public.cms_program_products
  FOR EACH ROW EXECUTE FUNCTION public.cms__products_basis_guard();
ALTER TABLE public.cms_program_products ENABLE ALWAYS TRIGGER cms_products_basis_guard;

-- Lưu chương trình kèm cách tính (app cờ CMS_CALC_MODES_ENABLED). Bắt buộc quantity_basis ∈ {pos_base, cms_unit, pending}; gọi
-- NGUYÊN rpc_cms_program_save 121 (không khoá lạ), rồi đặt cặp (basis, source) đích + actor + config_version tăng trong CÙNG transaction.
-- Chương trình tạo bằng v2 không bao giờ còn legacy_compat. Sửa basis ngoài nháp ⇒ CMS_BASIS_IMMUTABLE (rollback cả phần 121).
CREATE FUNCTION public.rpc_cms_program_save_v2(p jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_id     uuid;
  v_basis  text;
  v_source text;
  v_actor  uuid;
  v_prog   public.cms_programs%ROWTYPE;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p -> 'quantity_basis') IS DISTINCT FROM 'string'
     OR (p ->> 'quantity_basis') NOT IN ('pos_base', 'cms_unit', 'pending') THEN
    RAISE EXCEPTION 'CMS_BASIS_REQUIRED' USING ERRCODE = '22023';
  END IF;
  v_id := public.rpc_cms_program_save(p - 'quantity_basis');
  v_actor := (p ->> 'actor')::uuid;  -- 121 đã kiểm dạng uuid
  v_basis := NULLIF(p ->> 'quantity_basis', 'pending');
  v_source := CASE WHEN v_basis IS NULL THEN 'pending' ELSE 'admin' END;
  -- Phòng thủ chiều sâu (security-reviewer 14/11 P1-1): actor phải là admin (điều kiện cần của super; không chép allowlist).
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_actor AND u.role = 'admin') THEN
    RAISE EXCEPTION 'CMS_ACTOR_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_id FOR UPDATE;
  -- Ngoài nháp chỉ cấm ĐỔI basis; cùng basis giữ nguyên nguồn (legacy_*) ⇒ vẫn sửa được chương trình active chưa bắt đầu như 121
  -- (db-reviewer 14/11 P2-7).
  IF v_prog.status <> 'draft' THEN
    IF v_prog.quantity_basis IS DISTINCT FROM v_basis THEN
      RAISE EXCEPTION 'CMS_BASIS_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
  ELSIF (v_prog.quantity_basis, v_prog.quantity_basis_source) IS DISTINCT FROM (v_basis, v_source) THEN
    UPDATE public.cms_programs
       SET quantity_basis = v_basis, quantity_basis_source = v_source, quantity_basis_set_by = v_actor, quantity_basis_set_at = now(),
           config_version = config_version + 1, updated_by = v_actor, updated_at = now()
     WHERE id = v_id;
  END IF;
  RETURN v_id;
END;
$$;

-- Chuyển chương trình sang trừ trả hàng (một chiều). App chỉ gọi khi CMS_RETURNS_ENABLED + nguồn trả đạt readiness (mốc B).
CREATE FUNCTION public.rpc_cms_program_set_returns_policy(p_program_id uuid, p_policy text, p_expected_config_version integer, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_prog public.cms_programs%ROWTYPE;
BEGIN
  IF p_program_id IS NULL OR p_actor IS NULL OR p_expected_config_version IS NULL THEN
    RAISE EXCEPTION 'CMS_RETURNS_POLICY_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF p_policy IS DISTINCT FROM 'net_returns_v1' THEN
    RAISE EXCEPTION 'CMS_RETURNS_POLICY_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_prog.returns_policy = 'net_returns_v1' THEN
    RETURN jsonb_build_object('program_id', v_prog.id, 'returns_policy', v_prog.returns_policy, 'config_version', v_prog.config_version,
                              'already', true);
  END IF;
  IF v_prog.status NOT IN ('draft', 'active') THEN
    RAISE EXCEPTION 'CMS_PROGRAM_NOT_EDITABLE' USING ERRCODE = 'P0001';
  END IF;
  IF v_prog.config_version <> p_expected_config_version THEN
    RAISE EXCEPTION 'CMS_CONFIG_STALE' USING ERRCODE = 'P0001';
  END IF;
  IF v_prog.quantity_basis IS NULL THEN
    RAISE EXCEPTION 'CMS_BASIS_NOT_SET' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs r WHERE r.program_id = p_program_id AND r.status = 'running') THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_BUSY' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_actor) THEN
    RAISE EXCEPTION 'CMS_RETURNS_POLICY_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- Phòng thủ chiều sâu (security-reviewer 14/11 P1-1): người bật net phải là admin (điều kiện cần của super; allowlist super chỉ ở
  -- authz.ts + is_super_admin(), KHÔNG chép thêm). App vẫn kiểm super bằng phiên trước khi gọi service_role.
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_actor AND u.role = 'admin') THEN
    RAISE EXCEPTION 'CMS_ACTOR_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.cms_programs
     SET returns_policy = 'net_returns_v1', returns_policy_set_by = p_actor, returns_policy_set_at = now(),
         config_version = config_version + 1, updated_by = p_actor, updated_at = now()
   WHERE id = p_program_id;
  RETURN jsonb_build_object('program_id', p_program_id, 'returns_policy', 'net_returns_v1', 'config_version', v_prog.config_version + 1,
                            'already', false);
END;
$$;

-- Năng lực DB cho app (PM r2: SUY từ catalog — RPC có mặt + EXECUTE của đúng vai trò gọi, hàm nội bộ có mặt, bảng / cột có mặt; không
-- khai hằng). DB trước 130 ⇒ PostgREST 404 ⇒ app chỉ dùng đường 121–126. Mỗi đường trả {ok, rpcs}; app (lib/cms/calc/capabilities.ts)
-- chỉ dùng đường khi ok VÀ danh sách RPC = danh sách nó biết. Đường KHÔNG có trong batch — chốt run contract (cms__lock_eval chặn
-- CMS_LOCK_CONTRACT_UNSUPPORTED) — luôn false tường minh. Không dữ liệu.
CREATE FUNCTION public.rpc_cms_capabilities()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH r(path, fn, sig, role) AS (VALUES
    ('program_modes', 'rpc_cms_program_save_v2', 'public.rpc_cms_program_save_v2(jsonb)', 'service_role'),
    ('program_modes', 'rpc_cms_program_set_returns_policy', 'public.rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_snapshot', 'public.rpc_cms_sales_snapshot(uuid)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_run_open', 'public.rpc_cms_sales_run_open(uuid,jsonb)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_run_stage', 'public.rpc_cms_sales_run_stage(uuid,text,integer,jsonb)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_run_seal_begin', 'public.rpc_cms_sales_run_seal_begin(uuid,jsonb)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_run_seal_step', 'public.rpc_cms_sales_run_seal_step(uuid,integer)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_run_publish', 'public.rpc_cms_sales_run_publish(uuid)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_run_finish', 'public.rpc_cms_sales_run_finish(uuid,text,jsonb)', 'service_role'),
    ('contract_run', 'rpc_cms_sales_run_cleanup', 'public.rpc_cms_sales_run_cleanup(uuid,integer)', 'service_role'),
    ('readers_v2', 'rpc_cms_result_header_v2', 'public.rpc_cms_result_header_v2(uuid)', 'authenticated'),
    ('readers_v2', 'rpc_cms_result_rows_v2', 'public.rpc_cms_result_rows_v2(uuid,uuid)', 'authenticated'),
    ('readers_v2', 'rpc_cms_result_events_v2', 'public.rpc_cms_result_events_v2(uuid,uuid,uuid,uuid,integer,integer)', 'authenticated'),
    ('readers_v2', 'rpc_cms_result_excluded_v2', 'public.rpc_cms_result_excluded_v2(uuid,uuid,text,integer,integer)', 'authenticated'),
    ('readers_v2', 'rpc_cms_result_returns_v2', 'public.rpc_cms_result_returns_v2(uuid,uuid,integer,integer)', 'authenticated'),
    ('returns_ledger', 'rpc_cms_return_conflicts', 'public.rpc_cms_return_conflicts(uuid)', 'authenticated'),
    ('returns_ledger', 'rpc_cms_return_conflicts_confirm_restored', 'public.rpc_cms_return_conflicts_confirm_restored(uuid,text,bigint,text,uuid)',
     'authenticated'),
    ('close_report', 'rpc_cms_return_close_report_save', 'public.rpc_cms_return_close_report_save(uuid,uuid,jsonb)', 'service_role'),
    ('close_report', 'rpc_cms_frozen_sales_lines', 'public.rpc_cms_frozen_sales_lines(uuid,integer,integer)', 'service_role'),
    ('close_report', 'rpc_cms_return_close_reports', 'public.rpc_cms_return_close_reports(uuid)', 'authenticated'),
    ('close_report', 'rpc_cms_return_close_report', 'public.rpc_cms_return_close_report(uuid,integer,integer)', 'authenticated'),
    ('close_report', 'rpc_cms_return_close_report_events', 'public.rpc_cms_return_close_report_events(uuid,text,integer)', 'authenticated')
  ), i(path, sig) AS (VALUES
    ('program_modes', 'public.cms__programs_basis_guard()'),
    ('contract_run', 'public.cms__stage_contract(uuid,text,integer,jsonb)'),
    ('contract_run', 'public.cms__seal_begin_contract(uuid,jsonb)'),
    ('contract_run', 'public.cms__seal_contract_step(uuid,integer)'),
    ('contract_run', 'public.cms__publish_contract(uuid)'),
    ('readers_v2', 'public.cms__run_contract(uuid)'),
    ('returns_ledger', 'public.cms__ledger_eval(uuid,text,uuid,timestamp with time zone,text,jsonb)'),
    ('returns_ledger', 'public.cms__ledger_insert_guard()'),
    ('returns_ledger', 'public.cms__as_of_floor(uuid)'),
    ('close_report', 'public.cms__report_rows(jsonb)')
  ), t(path, rel, col) AS (VALUES
    ('program_modes', 'cms_programs', 'quantity_basis'), ('program_modes', 'cms_programs', 'returns_policy'),
    ('contract_run', 'cms_sync_runs', 'calc_contract_version'), ('contract_run', 'cms_sales_source_lines', 'src_v'),
    ('contract_run', 'cms_return_lines', 'disposition'), ('contract_run', 'cms_result_events', 'event_key'),
    ('readers_v2', 'cms_result_events', 'event_key'),
    ('returns_ledger', 'cms_return_ledger_evals', 'eval_seq'), ('returns_ledger', 'cms_return_baselines', 'financial_fp'),
    ('returns_ledger', 'cms_return_conflicts', 'prev_conflict_id'), ('returns_ledger', 'cms_return_restorations', 'open_set_hash'),
    ('close_report', 'cms_return_close_reports', 'idem_key'), ('close_report', 'cms_return_close_report_lines', 'recomputed_amount'),
    ('close_report', 'cms_return_close_report_events', 'disposition')
  ), ok AS (
    SELECT p.path,
           COALESCE((SELECT bool_and(COALESCE(has_function_privilege(r.role, to_regprocedure(r.sig), 'EXECUTE'), false)) FROM r WHERE r.path = p.path), false)
           AND COALESCE((SELECT bool_and(to_regprocedure(i.sig) IS NOT NULL) FROM i WHERE i.path = p.path), true)
           AND COALESCE((SELECT bool_and(EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public.' || t.rel)
                                                   AND a.attname = t.col AND a.attnum > 0 AND NOT a.attisdropped))
                           FROM t WHERE t.path = p.path), true) AS ok
      FROM (SELECT DISTINCT r.path FROM r) p
  )
  SELECT jsonb_build_object(
    'calc_contract', 'cms-calc-ret2-v1', 'status_dictionary', 'cms-return-status-v1', 'fp', 'cms-return-fp-v1', 'source_pin', 'cms-source-pin-v1',
    'src_digest', 'cms-src-digest-v1', 'unit_key', 'cms-unit-key-v2', 'program_save', 2, 'readers', 2,
    'paths', (SELECT jsonb_object_agg(ok.path, jsonb_build_object('ok', ok.ok, 'rpcs', (SELECT jsonb_agg(r.fn ORDER BY r.fn) FROM r WHERE r.path = ok.path)))
                FROM ok)
             || jsonb_build_object('lock_contract', jsonb_build_object('ok', false, 'rpcs', '[]'::jsonb)))
$$;

-- ── 3. Run contract: cột run + ràng buộc thay (thiết kế r2 §5.1 / r2.1 §14.3) ──
-- Run contract ⇔ chương trình cms_unit HOẶC net_returns_v1 lúc open (ghim từ chương trình, không từ caller). Run legacy
-- (pos_base + sales_only_v1, gồm T11) giữ mọi cột mới NULL và đường 122–126 nguyên hành vi.
ALTER TABLE public.cms_sync_runs
  ADD COLUMN quantity_basis            text,
  ADD COLUMN quantity_policy_version   text,
  ADD COLUMN returns_policy            text,
  ADD COLUMN calc_contract_version     text,
  ADD COLUMN unit_key_version          text,
  ADD COLUMN status_dictionary_version text,
  ADD COLUMN source_pin                jsonb       CHECK (source_pin IS NULL OR jsonb_typeof(source_pin) = 'object'),
  ADD COLUMN sales_src_digest          text        CHECK (sales_src_digest IS NULL OR sales_src_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN returns_as_of             timestamptz CHECK (returns_as_of IS NULL OR isfinite(returns_as_of)),
  ADD COLUMN returns_digest            text        CHECK (returns_digest IS NULL OR returns_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN returns_rows_read         integer     CHECK (returns_rows_read IS NULL OR returns_rows_read >= 0),
  ADD COLUMN ledger_verdict            text        CHECK (ledger_verdict IS NULL OR ledger_verdict IN ('CLEAN', 'MISMATCH', 'OPEN_CONFLICT_MATCH')),
  ADD COLUMN ledger_set_hash           text        CHECK (ledger_set_hash IS NULL OR ledger_set_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN ledger_checked_at         timestamptz,
  ADD COLUMN ledger_eval_seq           bigint      CHECK (ledger_eval_seq IS NULL OR ledger_eval_seq >= 1);
-- Mọi vế CHECK dưới đây là boolean KHÔNG NULL (r2.1 §14.3): so sánh có thể NULL bọc IS [NOT] DISTINCT FROM.
ALTER TABLE public.cms_sync_runs
  ADD CONSTRAINT cms_sync_runs_contract_shape CHECK (
    (quantity_basis IS NULL AND quantity_policy_version IS NULL AND returns_policy IS NULL AND calc_contract_version IS NULL
       AND unit_key_version IS NULL AND status_dictionary_version IS NULL)
    OR (kind = 'sales' AND quantity_basis IS NOT NULL AND quantity_policy_version IS NOT NULL AND returns_policy IS NOT NULL
        AND calc_contract_version IS NOT NULL AND unit_key_version IS NOT NULL AND status_dictionary_version IS NOT NULL
        AND ((quantity_basis = 'pos_base' AND quantity_policy_version = 'pos_base_v1')
             OR (quantity_basis = 'cms_unit' AND quantity_policy_version = 'cms_unit_v2'))
        AND returns_policy IN ('sales_only_v1', 'net_returns_v1')
        AND (quantity_basis = 'cms_unit' OR returns_policy = 'net_returns_v1')
        AND calc_contract_version = 'cms-calc-ret2-v1' AND unit_key_version = 'cms-unit-key-v2'
        AND status_dictionary_version = 'cms-return-status-v1')),
  -- Cột trả CHỈ ở run net đã seal (run sales-only không có "0 phiếu trả" giả).
  ADD CONSTRAINT cms_sync_runs_returns_shape CHECK (
    (returns_policy IS DISTINCT FROM 'net_returns_v1' AND returns_as_of IS NULL AND returns_digest IS NULL AND returns_rows_read IS NULL)
    OR (returns_policy IS NOT DISTINCT FROM 'net_returns_v1'
        AND (sealed_at IS NULL) = (returns_as_of IS NULL) AND (sealed_at IS NULL) = (returns_digest IS NULL)
        AND (sealed_at IS NULL) = (returns_rows_read IS NULL))),
  ADD CONSTRAINT cms_sync_runs_contract_sealed CHECK (
    (calc_contract_version IS NULL AND source_pin IS NULL AND sales_src_digest IS NULL)
    OR (calc_contract_version IS NOT NULL AND (sealed_at IS NULL) = (source_pin IS NULL) AND (sealed_at IS NULL) = (sales_src_digest IS NULL))),
  ADD CONSTRAINT cms_sync_runs_ledger_shape CHECK (
    (ledger_verdict IS NULL) = (ledger_set_hash IS NULL) AND (ledger_verdict IS NULL) = (ledger_checked_at IS NULL)
    AND (ledger_verdict IS NULL OR calc_contract_version IS NOT NULL)
    AND (ledger_eval_seq IS NULL OR (ledger_verdict IS NOT NULL AND returns_policy IS NOT DISTINCT FROM 'net_returns_v1'))),
  -- r2 P1-3 / r2.1 §14.3: run contract công bố ⇒ ledger sạch (verdict NULL không được lọt).
  ADD CONSTRAINT cms_sync_runs_contract_ok CHECK (
    calc_contract_version IS NULL OR status IS DISTINCT FROM 'ok'
    OR (ledger_verdict IS NOT DISTINCT FROM 'CLEAN' AND ledger_set_hash IS NOT NULL AND ledger_checked_at IS NOT NULL
        AND (returns_policy IS DISTINCT FROM 'net_returns_v1' OR ledger_eval_seq IS NOT NULL)));
-- Thay 2 ràng buộc 122: bước seal 0…13 (13 chỉ ở run contract); đã seal ⇒ đủ bước theo loại run.
ALTER TABLE public.cms_sync_runs DROP CONSTRAINT cms_sync_runs_seal_step_check;
ALTER TABLE public.cms_sync_runs ADD CONSTRAINT cms_sync_runs_seal_step_check CHECK (
  seal_step IS NULL OR (seal_step BETWEEN 0 AND 13 AND (calc_contract_version IS NOT NULL OR seal_step <= 10)));
ALTER TABLE public.cms_sync_runs DROP CONSTRAINT cms_sync_runs_sales_publish;
ALTER TABLE public.cms_sync_runs ADD CONSTRAINT cms_sync_runs_sales_publish CHECK (kind <> 'sales' OR (
  ((status = 'ok') = (published_at IS NOT NULL))
  AND (published_at IS NULL OR (sealed_at IS NOT NULL AND amount_vnd IS NOT NULL))
  AND (sealed_at IS NULL OR (seal_expect IS NOT NULL
                             AND seal_step IS NOT DISTINCT FROM (CASE WHEN calc_contract_version IS NULL THEN 10 ELSE 13 END)))
  AND (purged_at IS NULL OR status <> 'running')
  AND (cleared_at IS NULL OR purged_at IS NOT NULL)));
-- Thay part check 124: thêm 2 part của run contract (loại trừ chéo theo loại run kiểm ở stage / seal_begin).
ALTER TABLE public.cms_sync_run_chunks DROP CONSTRAINT cms_sync_run_chunks_part_check;
ALTER TABLE public.cms_sync_run_chunks ADD CONSTRAINT cms_sync_run_chunks_part_check
  CHECK (part IN ('sales_lines', 'results', 'catalog', 'result_lines', 'source_lines', 'return_lines', 'result_events'));

-- ── 4. Lớp bán: chuỗi THÔ q / u ở cả hai lớp + lớp lượng (thiết kế r2 §4.1 / §5.3) ──
-- src_v = 1 ⇔ dòng của run contract (capture thô trước làm sạch). Có cờ NUL / OVERSIZE ⇒ thô + sạch NULL; không thô, không cờ ⇒ sạch
-- NULL. Sạch = cms__src_clean(thô) do seal N1 đối chiếu trên tập DISTINCT (không gọi hàm theo dòng ở CHECK).
ALTER TABLE public.cms_sales_source_lines
  ADD COLUMN src_v              smallint CHECK (src_v IS NULL OR src_v = 1),
  ADD COLUMN quantity_src       text     CHECK (quantity_src IS NULL OR char_length(quantity_src) <= 64),
  ADD COLUMN uom_src            text     CHECK (uom_src IS NULL OR char_length(uom_src) <= 64),
  ADD COLUMN quantity_src_flag  text     CHECK (quantity_src_flag IS NULL OR quantity_src_flag IN ('NUL', 'OVERSIZE')),
  ADD COLUMN uom_src_flag       text     CHECK (uom_src_flag IS NULL OR uom_src_flag IN ('NUL', 'OVERSIZE')),
  ADD CONSTRAINT cms_sales_source_lines_src CHECK (
    (src_v IS NULL AND quantity_src IS NULL AND uom_src IS NULL AND quantity_src_flag IS NULL AND uom_src_flag IS NULL)
    OR (src_v IS NOT DISTINCT FROM 1
        AND (quantity_src_flag IS NULL OR (quantity_src IS NULL AND quantity_raw IS NULL))
        AND (uom_src_flag IS NULL OR (uom_src IS NULL AND uom_raw IS NULL))
        AND (quantity_src IS NOT NULL OR quantity_src_flag IS NOT NULL OR quantity_raw IS NULL)
        AND (uom_src IS NOT NULL OR uom_src_flag IS NOT NULL OR uom_raw IS NULL)));
ALTER TABLE public.cms_sales_lines
  ADD COLUMN src_v              smallint CHECK (src_v IS NULL OR src_v = 1),
  ADD COLUMN quantity_src       text     CHECK (quantity_src IS NULL OR char_length(quantity_src) <= 64),
  ADD COLUMN uom_src            text     CHECK (uom_src IS NULL OR char_length(uom_src) <= 64),
  ADD COLUMN quantity_src_flag  text     CHECK (quantity_src_flag IS NULL OR quantity_src_flag IN ('NUL', 'OVERSIZE')),
  ADD COLUMN uom_src_flag       text     CHECK (uom_src_flag IS NULL OR uom_src_flag IN ('NUL', 'OVERSIZE')),
  ADD COLUMN quantity_class     text     CHECK (quantity_class IS NULL
                                                OR quantity_class IN ('POS_BASE', 'COUNTED', 'OTHER_UNIT', 'FRACTIONAL_QUANTITY', 'ZERO_QUANTITY')),
  ADD COLUMN eligible_base      numeric  CHECK (eligible_base IS NULL OR (eligible_base >= 0 AND scale(eligible_base) <= 9)),
  ADD CONSTRAINT cms_sales_lines_src CHECK (
    (src_v IS NULL AND quantity_src IS NULL AND uom_src IS NULL AND quantity_src_flag IS NULL AND uom_src_flag IS NULL
       AND quantity_class IS NULL AND eligible_base IS NULL)
    OR (src_v IS NOT DISTINCT FROM 1
        AND (quantity_src_flag IS NULL OR (quantity_src IS NULL AND quantity_raw IS NULL))
        AND (uom_src_flag IS NULL OR (uom_src IS NULL AND uom_raw IS NULL))
        AND (quantity_src IS NOT NULL OR quantity_src_flag IS NOT NULL OR quantity_raw IS NULL)
        AND (uom_src IS NOT NULL OR uom_src_flag IS NOT NULL OR uom_raw IS NULL)
        -- Dòng bán của run contract không âm (âm ⇒ HOLD trước stage) và lớp lượng nhất quán với B đủ điều kiện.
        AND base_quantity >= 0 AND gmv_amount >= 0
        AND quantity_class IS NOT NULL AND eligible_base IS NOT NULL
        AND ((quantity_class IN ('POS_BASE', 'COUNTED') AND eligible_base = base_quantity)
             OR (quantity_class IN ('OTHER_UNIT', 'FRACTIONAL_QUANTITY', 'ZERO_QUANTITY') AND eligible_base = 0))));

-- Nhóm kết quả: cột ròng (run contract). base_quantity = B thật ròng; gmv_amount = GMV ròng; eligible_base = B đủ ròng (Q tính trên đây).
ALTER TABLE public.cms_results
  ADD COLUMN net_v                smallint CHECK (net_v IS NULL OR net_v = 1),
  ADD COLUMN sale_base            numeric,
  ADD COLUMN return_base          numeric,
  ADD COLUMN eligible_sale_base   numeric,
  ADD COLUMN eligible_return_base numeric,
  ADD COLUMN eligible_base        numeric,
  ADD COLUMN counted_sale_qty     bigint,
  ADD COLUMN sale_gmv             numeric,
  ADD COLUMN return_gmv           numeric,
  ADD COLUMN return_count         integer,
  ADD CONSTRAINT cms_results_net CHECK (
    (net_v IS NULL AND sale_base IS NULL AND return_base IS NULL AND eligible_sale_base IS NULL AND eligible_return_base IS NULL
       AND eligible_base IS NULL AND counted_sale_qty IS NULL AND sale_gmv IS NULL AND return_gmv IS NULL AND return_count IS NULL)
    OR (net_v IS NOT DISTINCT FROM 1
        AND sale_base IS NOT NULL AND return_base IS NOT NULL AND eligible_sale_base IS NOT NULL AND eligible_return_base IS NOT NULL
        AND eligible_base IS NOT NULL AND sale_gmv IS NOT NULL AND return_gmv IS NOT NULL AND return_count IS NOT NULL
        AND sale_base >= 0 AND return_base >= 0 AND eligible_sale_base >= 0 AND eligible_return_base >= 0 AND eligible_base >= 0
        AND sale_gmv >= 0 AND return_gmv >= 0 AND return_count >= 0 AND (counted_sale_qty IS NULL OR counted_sale_qty >= 0)
        AND eligible_sale_base <= sale_base AND eligible_return_base <= return_base
        AND base_quantity = sale_base - return_base AND gmv_amount = sale_gmv - return_gmv
        AND eligible_base = eligible_sale_base - eligible_return_base
        AND scale(sale_base) <= 9 AND scale(return_base) <= 9 AND scale(eligible_base) <= 9 AND scale(sale_gmv) <= 9
        AND scale(return_gmv) <= 9
        -- Thang 125 luôn mở bậc cuối ⇒ không trần; run contract không dùng trường trần cũ.
        AND cap_quantity IS NULL AND NOT at_cap AND rewarded_quantity = cms_quantity));

-- ── 5. Bảng run contract (dọn theo run, guard 123 / 124) ───────────────────
-- Phiếu trả của snapshot: MỌI dòng provider trả (đã chuẩn hoá) + disposition DB tự suy lại ở seal N2. Chưa hiệu lực ⇒ chỉ id +
-- trạng thái. Hiệu lực ⇒ đủ trường tài chính / lineage / ngữ cảnh dòng gốc.
CREATE TABLE public.cms_return_lines (
  run_id                     uuid        NOT NULL,
  program_id                 uuid        NOT NULL,
  return_event_id            text        NOT NULL CHECK (return_event_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  seq                        integer     NOT NULL CHECK (seq >= 0),
  return_status              text        NOT NULL CHECK (char_length(return_status) BETWEEN 1 AND 30),
  status_effect              text        NOT NULL CHECK (status_effect IN ('EFFECTIVE', 'NOT_EFFECTIVE')),
  return_document_id         text        CHECK (return_document_id IS NULL OR return_document_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  return_code                text        CHECK (return_code IS NULL OR return_code ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  recorded_at                timestamptz CHECK (recorded_at IS NULL OR isfinite(recorded_at)),
  original_order_line_id     text        CHECK (original_order_line_id IS NULL OR original_order_line_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  original_order_id          text        CHECK (original_order_id IS NULL OR original_order_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  product_id                 text        CHECK (product_id IS NULL OR product_id ~ '^[1-9][0-9]{0,18}$'),
  return_base_quantity       numeric     CHECK (return_base_quantity IS NULL
                                                OR (return_base_quantity > 0 AND scale(return_base_quantity) = 0 AND return_base_quantity < 1e29)),
  return_gmv_amount          numeric     CHECK (return_gmv_amount IS NULL
                                                OR (return_gmv_amount >= 0 AND scale(return_gmv_amount) <= 9 AND return_gmv_amount < 1e20)),
  original_completed_at      timestamptz CHECK (original_completed_at IS NULL OR isfinite(original_completed_at)),
  original_order_type        text        CHECK (original_order_type IS NULL OR char_length(original_order_type) BETWEEN 1 AND 30),
  original_order_status      text        CHECK (original_order_status IS NULL OR char_length(original_order_status) BETWEEN 1 AND 30),
  original_seller_email      text        CHECK (original_seller_email IS NULL OR (char_length(original_seller_email) BETWEEN 1 AND 320
                                                AND original_seller_email = lower(original_seller_email))),
  original_pos_code          text        CHECK (original_pos_code IS NULL OR char_length(original_pos_code) BETWEEN 1 AND 50),
  original_base_quantity     numeric     CHECK (original_base_quantity IS NULL OR (abs(original_base_quantity) < 1e29 AND scale(original_base_quantity) <= 9)),
  original_gmv_amount        numeric     CHECK (original_gmv_amount IS NULL OR (abs(original_gmv_amount) < 1e20 AND scale(original_gmv_amount) <= 9)),
  original_quantity_src      text        CHECK (original_quantity_src IS NULL OR char_length(original_quantity_src) <= 64),
  original_uom_src           text        CHECK (original_uom_src IS NULL OR char_length(original_uom_src) <= 64),
  original_quantity_src_flag text        CHECK (original_quantity_src_flag IS NULL OR original_quantity_src_flag IN ('NUL', 'OVERSIZE')),
  original_uom_src_flag      text        CHECK (original_uom_src_flag IS NULL OR original_uom_src_flag IN ('NUL', 'OVERSIZE')),
  source_updated_at          timestamptz CHECK (source_updated_at IS NULL OR isfinite(source_updated_at)),
  disposition                text        NOT NULL CHECK (disposition IN ('APPLIED', 'NOT_COMPLETED', 'ORIGIN_NOT_ELIGIBLE',
                                           'ORIGIN_OUT_OF_WINDOW', 'ORIGIN_NOT_IN_PROGRAM', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE')),
  sale_ref_line_id           text,
  PRIMARY KEY (run_id, return_event_id),
  CONSTRAINT cms_return_lines_seq UNIQUE (run_id, seq),
  CONSTRAINT cms_return_lines_run_fk FOREIGN KEY (run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id),
  CONSTRAINT cms_return_lines_sale_fk FOREIGN KEY (run_id, sale_ref_line_id) REFERENCES public.cms_sales_lines (run_id, order_line_id),
  CONSTRAINT cms_return_lines_effect CHECK (status_effect IS NOT DISTINCT FROM public.cms__return_status_effect(return_status)),
  CONSTRAINT cms_return_lines_shape CHECK (
    (status_effect = 'NOT_EFFECTIVE' AND disposition = 'NOT_COMPLETED' AND sale_ref_line_id IS NULL
       AND return_document_id IS NULL AND return_code IS NULL AND recorded_at IS NULL AND original_order_line_id IS NULL
       AND original_order_id IS NULL AND product_id IS NULL AND return_base_quantity IS NULL AND return_gmv_amount IS NULL
       AND original_completed_at IS NULL AND original_order_type IS NULL AND original_order_status IS NULL
       AND original_seller_email IS NULL AND original_pos_code IS NULL AND original_base_quantity IS NULL
       AND original_gmv_amount IS NULL AND original_quantity_src IS NULL AND original_uom_src IS NULL
       AND original_quantity_src_flag IS NULL AND original_uom_src_flag IS NULL AND source_updated_at IS NULL)
    OR (status_effect = 'EFFECTIVE' AND disposition <> 'NOT_COMPLETED'
        AND return_document_id IS NOT NULL AND recorded_at IS NOT NULL AND original_order_line_id IS NOT NULL
        AND original_order_id IS NOT NULL AND product_id IS NOT NULL AND return_base_quantity IS NOT NULL
        AND return_gmv_amount IS NOT NULL AND original_completed_at IS NOT NULL AND original_order_type IS NOT NULL
        AND original_order_status IS NOT NULL AND original_base_quantity IS NOT NULL AND original_gmv_amount IS NOT NULL
        -- source_updated_at của phiếu COMPLETED được NULL (returns.ts: nguồn có thể không có mốc cập nhật — r2 §4.2 không bắt buộc).
        AND (original_quantity_src_flag IS NULL OR original_quantity_src IS NULL)
        AND (original_uom_src_flag IS NULL OR original_uom_src IS NULL)
        AND (sale_ref_line_id IS NOT NULL) = (disposition IN ('APPLIED', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE'))
        AND (sale_ref_line_id IS NULL OR sale_ref_line_id = original_order_line_id))));
CREATE INDEX cms_return_lines_sale_idx ON public.cms_return_lines (run_id, sale_ref_line_id) WHERE sale_ref_line_id IS NOT NULL;
CREATE INDEX cms_return_lines_origin_idx ON public.cms_return_lines (run_id, original_order_line_id) WHERE original_order_line_id IS NOT NULL;

-- Sự kiện tính (SALE / RETURN) theo nhóm — thay cms_result_lines cho run contract. Khoá namespaced `SALE:<dòng>` / `RETURN:<phiếu>`.
CREATE TABLE public.cms_result_events (
  run_id             uuid        NOT NULL,
  program_id         uuid        NOT NULL,
  event_key          text        NOT NULL,
  seq                integer     NOT NULL CHECK (seq >= 0),
  kind               text        NOT NULL CHECK (kind IN ('SALE', 'RETURN')),
  event_at           timestamptz NOT NULL CHECK (isfinite(event_at)),
  order_line_id      text        NOT NULL,
  return_event_id    text,
  user_id            uuid        NOT NULL,
  program_product_id uuid        NOT NULL,
  quantity_class     text        NOT NULL CHECK (quantity_class IN ('POS_BASE', 'COUNTED', 'OTHER_UNIT', 'FRACTIONAL_QUANTITY', 'ZERO_QUANTITY')),
  base_delta         numeric     NOT NULL CHECK (abs(base_delta) < 1e29 AND scale(base_delta) <= 9),
  eligible_delta     numeric     NOT NULL CHECK (abs(eligible_delta) < 1e29 AND scale(eligible_delta) <= 9),
  gmv_delta          numeric     NOT NULL CHECK (abs(gmv_delta) < 1e20 AND scale(gmv_delta) <= 9),
  eligible_before    numeric     NOT NULL CHECK (eligible_before >= 0 AND scale(eligible_before) <= 9),
  eligible_after     numeric     NOT NULL CHECK (eligible_after >= 0 AND scale(eligible_after) <= 9),
  qty_before         bigint      NOT NULL CHECK (qty_before >= 0),
  qty_after          bigint      NOT NULL CHECK (qty_after >= 0),
  amount_vnd         bigint      NOT NULL,
  status             text        NOT NULL CHECK (status IN ('WAITING_GATE', 'ACCUMULATING', 'RECORDED', 'NOT_COUNTED',
                                                           'RETURN_REDUCED', 'RETURN_NO_CHANGE')),
  PRIMARY KEY (run_id, event_key),
  CONSTRAINT cms_result_events_seq UNIQUE (run_id, seq),
  CONSTRAINT cms_result_events_key CHECK (event_key = kind || ':' || COALESCE(return_event_id, order_line_id)),
  CONSTRAINT cms_result_events_kind CHECK ((kind = 'RETURN') = (return_event_id IS NOT NULL)),
  CONSTRAINT cms_result_events_sign CHECK (
    (kind = 'SALE' AND base_delta >= 0 AND eligible_delta >= 0 AND gmv_delta >= 0 AND amount_vnd >= 0
       AND status IN ('WAITING_GATE', 'ACCUMULATING', 'RECORDED', 'NOT_COUNTED'))
    OR (kind = 'RETURN' AND base_delta < 0 AND eligible_delta <= 0 AND gmv_delta <= 0 AND amount_vnd <= 0
        AND status IN ('WAITING_GATE', 'RETURN_REDUCED', 'RETURN_NO_CHANGE'))),
  CONSTRAINT cms_result_events_chain CHECK (eligible_after = eligible_before + eligible_delta AND qty_after >= 0),
  CONSTRAINT cms_result_events_run_fk FOREIGN KEY (run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id),
  CONSTRAINT cms_result_events_sale_fk FOREIGN KEY (run_id, order_line_id) REFERENCES public.cms_sales_lines (run_id, order_line_id),
  CONSTRAINT cms_result_events_return_fk FOREIGN KEY (run_id, return_event_id) REFERENCES public.cms_return_lines (run_id, return_event_id),
  CONSTRAINT cms_result_events_result_fk FOREIGN KEY (run_id, user_id, program_product_id)
    REFERENCES public.cms_results (run_id, user_id, program_product_id)
);
-- Index phía FK (cleanup xoá cms_sales_lines / cms_return_lines / cms_results không quét toàn bảng) + keyset reader theo nhóm.
CREATE INDEX cms_result_events_sale_idx ON public.cms_result_events (run_id, order_line_id);
CREATE INDEX cms_result_events_return_idx ON public.cms_result_events (run_id, return_event_id) WHERE return_event_id IS NOT NULL;
CREATE INDEX cms_result_events_group_idx ON public.cms_result_events (run_id, user_id, program_product_id, seq);
-- Reader events_v2 cho người xem một dược sĩ: keyset theo seq trong phạm vi user (db-reviewer 14/11 P2-6).
CREATE INDEX cms_result_events_user_idx ON public.cms_result_events (run_id, user_id, seq);
-- excluded_v2 kind quantity: chỉ dòng INCLUDED bị loại theo lớp lượng — index từng phần, không quét cả run (db-reviewer 14/11 P2-6).
CREATE INDEX cms_sales_lines_qty_excluded_idx ON public.cms_sales_lines (run_id, seq)
  WHERE disposition = 'INCLUDED' AND quantity_class IN ('OTHER_UNIT', 'FRACTIONAL_QUANTITY', 'ZERO_QUANTITY');

ALTER TABLE public.cms_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_result_events ENABLE ROW LEVEL SECURITY;
-- Guard 123 / 124 như mọi bảng dữ liệu run: chỉ owner / RPC ghi; đóng băng khi run có payout; TRUNCATE khi có payout ⇒ từ chối.
CREATE TRIGGER cms_frozen_ins AFTER INSERT ON public.cms_return_lines REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_ins();
CREATE TRIGGER cms_frozen_upd AFTER UPDATE ON public.cms_return_lines REFERENCING OLD TABLE AS cms_old NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_upd();
CREATE TRIGGER cms_frozen_del AFTER DELETE ON public.cms_return_lines REFERENCING OLD TABLE AS cms_old
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_del();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_frozen_truncate BEFORE TRUNCATE ON public.cms_return_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_truncate_guard();
CREATE TRIGGER cms_frozen_ins AFTER INSERT ON public.cms_result_events REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_ins();
CREATE TRIGGER cms_frozen_upd AFTER UPDATE ON public.cms_result_events REFERENCING OLD TABLE AS cms_old NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_upd();
CREATE TRIGGER cms_frozen_del AFTER DELETE ON public.cms_result_events REFERENCING OLD TABLE AS cms_old
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_del();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_result_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_frozen_truncate BEFORE TRUNCATE ON public.cms_result_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_truncate_guard();
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, t.tgname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND c.relname IN ('cms_return_lines', 'cms_result_events')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', r.relname, r.tgname);
  END LOOP;
  -- Đủ 5 trigger ENABLE ALWAYS mỗi bảng (db-reviewer 14/11 P2-10).
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.cms_return_lines'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'A') <> 5
     OR (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.cms_result_events'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'A') <> 5 THEN
    RAISE EXCEPTION '130: trigger cms_return_lines / cms_result_events phải đủ 5 + 5 và ENABLE ALWAYS';
  END IF;
END $$;

-- ── 6. Stage / seal_begin run contract (thiết kế r2 §5.1) ─────────────────
-- Gọi từ thân 124 / 122 qua đoạn rẽ nhánh đầu thân (run có calc_contract_version — ghim lúc open, không RPC nào đổi). Chỉ owner
-- (không GRANT): hàm gọi là SECDEF của owner. Thân legacy giữ nguyên văn cho run legacy.
CREATE FUNCTION public.cms__stage_contract(p_run_id uuid, p_part text, p_chunk_no integer, p_rows jsonb)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_run    public.cms_sync_runs%ROWTYPE;
  v_n      integer;
  v_count  integer;
  v_digest text;
  v_prev   record;
  c_uuid CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_dec  CONSTANT text := '^-?[0-9]{1,35}(\.[0-9]{1,9})?$';
  c_udec CONSTANT text := '^[0-9]{1,35}(\.[0-9]{1,9})?$';
  c_int  CONSTANT text := '^(0|[1-9][0-9]{0,18})$';
  c_sint CONSTANT text := '^-?(0|[1-9][0-9]{0,18})$';
  c_seq  CONSTANT text := '^(0|[1-9][0-9]{0,8})$';
  c_ts   CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$';
  c_pid  CONSTANT text := '^[1-9][0-9]{0,18}$';
  c_txt  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,100}$';
  c_t50  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,50}$';
  c_t30  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,30}$';
  c_mail CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]+$';
  c_flag CONSTANT text := '^(NUL|OVERSIZE)$';
  c_cls  CONSTANT text := '^(POS_BASE|COUNTED|OTHER_UNIT|FRACTIONAL_QUANTITY|ZERO_QUANTITY)$';
  c_rqty CONSTANT text := '^[1-9][0-9]{0,28}$';
  c_rgmv CONSTANT text := '^[0-9]{1,20}(\.[0-9]{1,9})?$';
  c_ekey CONSTANT text := '^(SALE|RETURN):[^\x01-\x1f\x7f-\x9f]{1,100}$';
BEGIN
  IF p_chunk_no IS NULL OR p_chunk_no < 0 OR p_chunk_no >= 100000 THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_CHUNK' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROWS' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(p_rows);
  IF v_n = 0 OR v_n > 5000 THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_CHUNK' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.kind <> 'sales' OR v_run.status <> 'running' THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  -- Whitelist theo loại run (loại trừ chéo, r2 §5.1): run contract KHÔNG có result_lines; return_lines chỉ ở net; source_lines bắt
  -- buộc (source_schema = 1). Run legacy không tới đây (thân 124 giữ whitelist 5 part cũ ⇒ từ chối return_lines / result_events).
  IF v_run.calc_contract_version IS NULL OR v_run.source_schema IS DISTINCT FROM 1
     OR p_part IS NULL OR p_part NOT IN ('sales_lines', 'results', 'catalog', 'result_events', 'source_lines', 'return_lines')
     OR (p_part = 'return_lines' AND v_run.returns_policy IS DISTINCT FROM 'net_returns_v1') THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_PART' USING ERRCODE = '22023';
  END IF;
  IF v_run.seal_expect IS NOT NULL OR v_run.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'CMS_STAGE_SEALED' USING ERRCODE = 'P0001'; END IF;
  IF v_run.started_at < now() - interval '30 minutes' THEN RAISE EXCEPTION 'CMS_SYNC_RUN_STALE' USING ERRCODE = 'P0001'; END IF;

  v_digest := md5(p_rows::text);
  SELECT row_count, digest INTO v_prev FROM public.cms_sync_run_chunks
   WHERE run_id = p_run_id AND part = p_part AND chunk_no = p_chunk_no;
  IF FOUND THEN
    IF v_prev.row_count = v_n AND v_prev.digest = v_digest THEN
      RETURN v_n;  -- retry khối đã ghi: không ghi lại
    END IF;
    RAISE EXCEPTION 'CMS_STAGE_CHUNK_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) e WHERE jsonb_typeof(e) <> 'object') THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
  END IF;
  -- Như 124: mọi số dạng chuỗi; boolean chỉ ở trường boolean của results / catalog.
  IF jsonb_path_exists(p_rows, 'strict $[*].* ? (@.type() == "number" || @.type() == "object" || @.type() == "array")')
     OR (p_part NOT IN ('results', 'catalog') AND jsonb_path_exists(p_rows, 'strict $[*].* ? (@.type() == "boolean")'))
     OR (p_part = 'results' AND jsonb_path_exists(p_rows, '$[*] ? (@.at_cap.type() != "boolean" || @.gate_met.type() != "boolean")'))
     OR (p_part = 'catalog' AND jsonb_path_exists(p_rows, '$[*] ? (@.met.type() != "boolean")')) THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
  END IF;

  BEGIN
  IF p_part = 'source_lines' THEN
    -- 14 trường 124 + chuỗi THÔ q / u (capture trước làm sạch, có thể chứa điều khiển; ≤ 64 code point) + cờ. Quan hệ
    -- thô ↔ sạch kiểm ở seal N1 trên tập DISTINCT; CHECK bảng ép quy tắc cờ.
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, order_id text, order_code text, product_id text,
             seller_email text, pos_code text, order_type text, order_status text, completed_at text, source_updated_at text,
             quantity_raw text, uom_raw text, base_quantity text, gmv_amount text, quantity_src text, uom_src text,
             quantity_src_flag text, uom_src_flag text)
       WHERE NOT (COALESCE(x.order_line_id ~ c_txt AND x.order_id ~ c_txt AND x.order_code ~ c_txt AND x.product_id ~ c_pid
                           AND x.order_type ~ c_t30 AND x.order_status ~ c_t30 AND x.completed_at ~ c_ts
                           AND x.source_updated_at ~ c_ts AND x.base_quantity ~ c_dec AND x.gmv_amount ~ c_dec, false)
                  AND (x.seller_email IS NULL OR (x.seller_email ~ c_mail AND char_length(x.seller_email) <= 320
                                                  AND x.seller_email = lower(x.seller_email)))
                  AND (x.pos_code IS NULL OR x.pos_code ~ c_t50)
                  AND (x.quantity_raw IS NULL OR x.quantity_raw ~ c_t50) AND (x.uom_raw IS NULL OR x.uom_raw ~ c_t50)
                  AND (x.quantity_src IS NULL OR char_length(x.quantity_src) <= 64)
                  AND (x.uom_src IS NULL OR char_length(x.uom_src) <= 64)
                  AND (x.quantity_src_flag IS NULL OR x.quantity_src_flag ~ c_flag)
                  AND (x.uom_src_flag IS NULL OR x.uom_src_flag ~ c_flag))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_sales_source_lines (run_id, program_id, order_line_id, order_id, order_code, product_id, seller_email,
      pos_code, order_type, order_status, completed_at, source_updated_at, quantity_raw, uom_raw, base_quantity, gmv_amount,
      src_v, quantity_src, uom_src, quantity_src_flag, uom_src_flag)
    SELECT p_run_id, v_run.program_id, x.order_line_id, x.order_id, x.order_code, x.product_id, x.seller_email, x.pos_code,
           x.order_type, x.order_status, x.completed_at::timestamptz, x.source_updated_at::timestamptz, x.quantity_raw, x.uom_raw,
           x.base_quantity::numeric, x.gmv_amount::numeric, 1, x.quantity_src, x.uom_src, x.quantity_src_flag, x.uom_src_flag
      FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, order_id text, order_code text, product_id text,
             seller_email text, pos_code text, order_type text, order_status text, completed_at text, source_updated_at text,
             quantity_raw text, uom_raw text, base_quantity text, gmv_amount text, quantity_src text, uom_src text,
             quantity_src_flag text, uom_src_flag text);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSIF p_part = 'sales_lines' THEN
    -- 18 trường 122 + thô / cờ (bằng lớp nguồn, N1 đối chiếu) + lớp lượng / B đủ (N1 tự tính lại từ thô).
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, order_id text, order_code text, product_id text,
             program_product_id text, seller_email text, user_id text, store_id text, pos_code text, completed_at text,
             source_updated_at text, quantity_raw text, uom_raw text, base_quantity text, gmv_amount text, disposition text,
             unassigned_reason text, quantity_src text, uom_src text, quantity_src_flag text, uom_src_flag text,
             quantity_class text, eligible_base text)
       WHERE NOT (COALESCE(x.order_line_id ~ c_txt AND x.seq ~ c_seq AND x.order_id ~ c_txt AND x.order_code ~ c_txt
                           AND x.product_id ~ c_pid AND x.program_product_id ~ c_uuid AND x.completed_at ~ c_ts
                           AND x.source_updated_at ~ c_ts AND x.base_quantity ~ c_dec AND x.gmv_amount ~ c_dec
                           AND x.disposition ~ '^(INCLUDED|UNASSIGNED|OUT_OF_SCOPE)$'
                           AND x.quantity_class ~ c_cls AND x.eligible_base ~ c_udec, false)
                  AND (x.seller_email IS NULL OR (x.seller_email ~ c_mail AND char_length(x.seller_email) <= 320
                                                  AND x.seller_email = lower(x.seller_email)))
                  AND (x.user_id IS NULL OR x.user_id ~ c_uuid)
                  AND (x.store_id IS NULL OR x.store_id ~ c_uuid) AND (x.pos_code IS NULL OR x.pos_code ~ c_t50)
                  AND (x.quantity_raw IS NULL OR x.quantity_raw ~ c_t50) AND (x.uom_raw IS NULL OR x.uom_raw ~ c_t50)
                  AND (x.unassigned_reason IS NULL
                       OR x.unassigned_reason ~ '^(NO_EMAIL|NOT_FOUND|MULTIPLE|SHARED_ACCOUNT|NOT_STAFF|STORE_NOT_ELIGIBLE)$')
                  AND (x.quantity_src IS NULL OR char_length(x.quantity_src) <= 64)
                  AND (x.uom_src IS NULL OR char_length(x.uom_src) <= 64)
                  AND (x.quantity_src_flag IS NULL OR x.quantity_src_flag ~ c_flag)
                  AND (x.uom_src_flag IS NULL OR x.uom_src_flag ~ c_flag))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_sales_lines (run_id, program_id, order_line_id, seq, order_id, order_code, product_id,
      program_product_id, seller_email, user_id, store_id, pos_code, completed_at, source_updated_at, quantity_raw, uom_raw,
      base_quantity, gmv_amount, disposition, unassigned_reason, src_v, quantity_src, uom_src, quantity_src_flag, uom_src_flag,
      quantity_class, eligible_base)
    SELECT p_run_id, v_run.program_id, x.order_line_id, x.seq::integer, x.order_id, x.order_code, x.product_id,
           x.program_product_id::uuid, x.seller_email, x.user_id::uuid, x.store_id::uuid, x.pos_code, x.completed_at::timestamptz,
           x.source_updated_at::timestamptz, x.quantity_raw, x.uom_raw, x.base_quantity::numeric, x.gmv_amount::numeric,
           x.disposition, x.unassigned_reason, 1, x.quantity_src, x.uom_src, x.quantity_src_flag, x.uom_src_flag,
           x.quantity_class, x.eligible_base::numeric
      FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, order_id text, order_code text, product_id text,
             program_product_id text, seller_email text, user_id text, store_id text, pos_code text, completed_at text,
             source_updated_at text, quantity_raw text, uom_raw text, base_quantity text, gmv_amount text, disposition text,
             unassigned_reason text, quantity_src text, uom_src text, quantity_src_flag text, uom_src_flag text,
             quantity_class text, eligible_base text);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSIF p_part = 'results' THEN
    -- 19 trường 122 + 9 cột ròng. CHECK cms_results_net ép số học bán − trả và "không trần" của run contract.
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(program_product_id text, product_id text, user_id text, store_id text,
             gmv_basis text, base_quantity text, per_unit text, cms_quantity text, rewarded_quantity text, cap_quantity text,
             at_cap boolean, gmv_amount text, gate_gmv text, target_gmv text, gate_met boolean, gate_met_at text,
             potential_amount text, amount_vnd text, line_count text, sale_base text, return_base text,
             eligible_sale_base text, eligible_return_base text, eligible_base text, counted_sale_qty text, sale_gmv text,
             return_gmv text, return_count text)
       WHERE NOT (COALESCE(x.program_product_id ~ c_uuid AND x.product_id ~ c_pid AND x.user_id ~ c_uuid AND x.store_id ~ c_uuid
                           AND x.gmv_basis ~ '^(product|catalog|none)$' AND x.base_quantity ~ c_dec AND x.per_unit ~ c_udec
                           AND x.cms_quantity ~ c_int AND x.rewarded_quantity ~ c_int AND x.at_cap IS NOT NULL
                           AND x.gmv_amount ~ c_dec AND x.gate_met IS NOT NULL AND x.potential_amount ~ c_int
                           AND x.amount_vnd ~ c_int AND x.line_count ~ c_seq
                           AND x.sale_base ~ c_udec AND x.return_base ~ c_udec AND x.eligible_sale_base ~ c_udec
                           AND x.eligible_return_base ~ c_udec AND x.eligible_base ~ c_udec AND x.sale_gmv ~ c_udec
                           AND x.return_gmv ~ c_udec AND x.return_count ~ c_seq, false)
                  AND (x.cap_quantity IS NULL OR x.cap_quantity ~ c_int) AND (x.gate_gmv IS NULL OR x.gate_gmv ~ c_dec)
                  AND (x.target_gmv IS NULL OR x.target_gmv ~ c_int) AND (x.gate_met_at IS NULL OR x.gate_met_at ~ c_ts)
                  AND (x.counted_sale_qty IS NULL OR x.counted_sale_qty ~ c_int))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(cms_quantity text, rewarded_quantity text, cap_quantity text, target_gmv text,
             potential_amount text, amount_vnd text, counted_sale_qty text)
       WHERE x.cms_quantity::numeric > 9223372036854775807 OR x.rewarded_quantity::numeric > 9223372036854775807
          OR COALESCE(x.cap_quantity::numeric, 0) > 9223372036854775807 OR COALESCE(x.target_gmv::numeric, 0) > 9223372036854775807
          OR x.potential_amount::numeric > 9223372036854775807 OR x.amount_vnd::numeric > 9223372036854775807
          OR COALESCE(x.counted_sale_qty::numeric, 0) > 9223372036854775807) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_results (run_id, program_id, program_product_id, product_id, user_id, store_id, gmv_basis,
      base_quantity, per_unit, cms_quantity, rewarded_quantity, cap_quantity, at_cap, gmv_amount, gate_gmv, target_gmv, gate_met,
      gate_met_at, potential_amount, amount_vnd, line_count, net_v, sale_base, return_base, eligible_sale_base,
      eligible_return_base, eligible_base, counted_sale_qty, sale_gmv, return_gmv, return_count)
    SELECT p_run_id, v_run.program_id, x.program_product_id::uuid, x.product_id, x.user_id::uuid, x.store_id::uuid, x.gmv_basis,
           x.base_quantity::numeric, x.per_unit::numeric, x.cms_quantity::bigint, x.rewarded_quantity::bigint,
           x.cap_quantity::bigint, x.at_cap, x.gmv_amount::numeric, x.gate_gmv::numeric, x.target_gmv::bigint, x.gate_met,
           x.gate_met_at::timestamptz, x.potential_amount::bigint, x.amount_vnd::bigint, x.line_count::integer, 1,
           x.sale_base::numeric, x.return_base::numeric, x.eligible_sale_base::numeric, x.eligible_return_base::numeric,
           x.eligible_base::numeric, x.counted_sale_qty::bigint, x.sale_gmv::numeric, x.return_gmv::numeric,
           x.return_count::integer
      FROM jsonb_to_recordset(p_rows) AS x(program_product_id text, product_id text, user_id text, store_id text,
             gmv_basis text, base_quantity text, per_unit text, cms_quantity text, rewarded_quantity text, cap_quantity text,
             at_cap boolean, gmv_amount text, gate_gmv text, target_gmv text, gate_met boolean, gate_met_at text,
             potential_amount text, amount_vnd text, line_count text, sale_base text, return_base text,
             eligible_sale_base text, eligible_return_base text, eligible_base text, counted_sale_qty text, sale_gmv text,
             return_gmv text, return_count text);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSIF p_part = 'catalog' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(user_id text, store_id text, catalog_gmv text, target_gmv text, met boolean,
             met_at text, line_count text)
       WHERE NOT (COALESCE(x.user_id ~ c_uuid AND x.store_id ~ c_uuid AND x.catalog_gmv ~ c_dec AND x.target_gmv ~ c_int
                           AND x.met IS NOT NULL AND x.line_count ~ c_seq, false)
                  AND (x.met_at IS NULL OR x.met_at ~ c_ts))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(target_gmv text) WHERE x.target_gmv::numeric > 9223372036854775807) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_result_catalog (run_id, program_id, user_id, store_id, catalog_gmv, target_gmv, met, met_at, line_count)
    SELECT p_run_id, v_run.program_id, x.user_id::uuid, x.store_id::uuid, x.catalog_gmv::numeric, x.target_gmv::bigint, x.met,
           x.met_at::timestamptz, x.line_count::integer
      FROM jsonb_to_recordset(p_rows) AS x(user_id text, store_id text, catalog_gmv text, target_gmv text, met boolean,
             met_at text, line_count text);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSIF p_part = 'return_lines' THEN
    -- MỌI dòng provider trả (đã chuẩn hoá). status_effect do DB suy từ từ điển; trạng thái lạ ⇒ lỗi riêng (app đã HOLD trước).
    -- Định dạng tại đây; ràng buộc EFFECTIVE / NOT_EFFECTIVE / sale_ref do CHECK bảng; disposition DB tự suy lại ở seal N2.
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(return_event_id text, seq text, return_status text, return_document_id text,
             return_code text, recorded_at text, original_order_line_id text, original_order_id text, product_id text,
             return_base_quantity text, return_gmv_amount text, original_completed_at text, original_order_type text,
             original_order_status text, original_seller_email text, original_pos_code text, original_base_quantity text,
             original_gmv_amount text, original_quantity_src text, original_uom_src text, original_quantity_src_flag text,
             original_uom_src_flag text, source_updated_at text, disposition text, sale_ref_line_id text)
       WHERE NOT (COALESCE(x.return_event_id ~ c_txt AND x.seq ~ c_seq AND x.return_status ~ c_t30
                           AND x.disposition ~ '^(APPLIED|NOT_COMPLETED|ORIGIN_NOT_ELIGIBLE|ORIGIN_OUT_OF_WINDOW|ORIGIN_NOT_IN_PROGRAM|ORIGIN_UNASSIGNED|ORIGIN_OUT_OF_SCOPE)$', false)
                  AND (x.return_document_id IS NULL OR x.return_document_id ~ c_txt)
                  AND (x.return_code IS NULL OR x.return_code ~ c_txt)
                  AND (x.recorded_at IS NULL OR x.recorded_at ~ c_ts)
                  AND (x.original_order_line_id IS NULL OR x.original_order_line_id ~ c_txt)
                  AND (x.original_order_id IS NULL OR x.original_order_id ~ c_txt)
                  AND (x.product_id IS NULL OR x.product_id ~ c_pid)
                  AND (x.return_base_quantity IS NULL OR x.return_base_quantity ~ c_rqty)
                  AND (x.return_gmv_amount IS NULL OR x.return_gmv_amount ~ c_rgmv)
                  AND (x.original_completed_at IS NULL OR x.original_completed_at ~ c_ts)
                  AND (x.original_order_type IS NULL OR x.original_order_type ~ c_t30)
                  AND (x.original_order_status IS NULL OR x.original_order_status ~ c_t30)
                  AND (x.original_seller_email IS NULL OR (x.original_seller_email ~ c_mail AND char_length(x.original_seller_email) <= 320
                                                           AND x.original_seller_email = lower(x.original_seller_email)))
                  AND (x.original_pos_code IS NULL OR x.original_pos_code ~ c_t50)
                  AND (x.original_base_quantity IS NULL OR x.original_base_quantity ~ c_dec)
                  AND (x.original_gmv_amount IS NULL OR x.original_gmv_amount ~ c_dec)
                  AND (x.original_quantity_src IS NULL OR char_length(x.original_quantity_src) <= 64)
                  AND (x.original_uom_src IS NULL OR char_length(x.original_uom_src) <= 64)
                  AND (x.original_quantity_src_flag IS NULL OR x.original_quantity_src_flag ~ c_flag)
                  AND (x.original_uom_src_flag IS NULL OR x.original_uom_src_flag ~ c_flag)
                  AND (x.source_updated_at IS NULL OR x.source_updated_at ~ c_ts)
                  AND (x.sale_ref_line_id IS NULL OR x.sale_ref_line_id ~ c_txt))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(return_status text)
                WHERE public.cms__return_status_effect(x.return_status) IS NULL) THEN
      RAISE EXCEPTION 'CMS_RETURN_STATUS_UNKNOWN' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_return_lines (run_id, program_id, return_event_id, seq, return_status, status_effect, return_document_id,
      return_code, recorded_at, original_order_line_id, original_order_id, product_id, return_base_quantity, return_gmv_amount,
      original_completed_at, original_order_type, original_order_status, original_seller_email, original_pos_code,
      original_base_quantity, original_gmv_amount, original_quantity_src, original_uom_src, original_quantity_src_flag,
      original_uom_src_flag, source_updated_at, disposition, sale_ref_line_id)
    SELECT p_run_id, v_run.program_id, x.return_event_id, x.seq::integer, x.return_status,
           public.cms__return_status_effect(x.return_status), x.return_document_id, x.return_code, x.recorded_at::timestamptz,
           x.original_order_line_id, x.original_order_id, x.product_id, x.return_base_quantity::numeric,
           x.return_gmv_amount::numeric, x.original_completed_at::timestamptz, x.original_order_type, x.original_order_status,
           x.original_seller_email, x.original_pos_code, x.original_base_quantity::numeric, x.original_gmv_amount::numeric,
           x.original_quantity_src, x.original_uom_src, x.original_quantity_src_flag, x.original_uom_src_flag,
           x.source_updated_at::timestamptz, x.disposition, x.sale_ref_line_id
      FROM jsonb_to_recordset(p_rows) AS x(return_event_id text, seq text, return_status text, return_document_id text,
             return_code text, recorded_at text, original_order_line_id text, original_order_id text, product_id text,
             return_base_quantity text, return_gmv_amount text, original_completed_at text, original_order_type text,
             original_order_status text, original_seller_email text, original_pos_code text, original_base_quantity text,
             original_gmv_amount text, original_quantity_src text, original_uom_src text, original_quantity_src_flag text,
             original_uom_src_flag text, source_updated_at text, disposition text, sale_ref_line_id text);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSE
    -- result_events: sự kiện SALE / RETURN theo nhóm (thay result_lines). CHECK bảng ép khoá / dấu / chuỗi before → after.
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(event_key text, seq text, kind text, event_at text, order_line_id text,
             return_event_id text, user_id text, program_product_id text, quantity_class text, base_delta text,
             eligible_delta text, gmv_delta text, eligible_before text, eligible_after text, qty_before text, qty_after text,
             amount_vnd text, status text)
       WHERE NOT (COALESCE(x.event_key ~ c_ekey AND x.seq ~ c_seq AND x.kind ~ '^(SALE|RETURN)$' AND x.event_at ~ c_ts
                           AND x.order_line_id ~ c_txt AND x.user_id ~ c_uuid AND x.program_product_id ~ c_uuid
                           AND x.quantity_class ~ c_cls AND x.base_delta ~ c_dec AND x.eligible_delta ~ c_dec
                           AND x.gmv_delta ~ c_dec AND x.eligible_before ~ c_udec AND x.eligible_after ~ c_udec
                           AND x.qty_before ~ c_int AND x.qty_after ~ c_int AND x.amount_vnd ~ c_sint
                           AND x.status ~ '^(WAITING_GATE|ACCUMULATING|RECORDED|NOT_COUNTED|RETURN_REDUCED|RETURN_NO_CHANGE)$', false)
                  AND (x.return_event_id IS NULL OR x.return_event_id ~ c_txt))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(qty_before text, qty_after text, amount_vnd text)
       WHERE x.qty_before::numeric > 9223372036854775807 OR x.qty_after::numeric > 9223372036854775807
          OR abs(x.amount_vnd::numeric) > 9223372036854775807) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_result_events (run_id, program_id, event_key, seq, kind, event_at, order_line_id, return_event_id,
      user_id, program_product_id, quantity_class, base_delta, eligible_delta, gmv_delta, eligible_before, eligible_after,
      qty_before, qty_after, amount_vnd, status)
    SELECT p_run_id, v_run.program_id, x.event_key, x.seq::integer, x.kind, x.event_at::timestamptz, x.order_line_id,
           x.return_event_id, x.user_id::uuid, x.program_product_id::uuid, x.quantity_class, x.base_delta::numeric,
           x.eligible_delta::numeric, x.gmv_delta::numeric, x.eligible_before::numeric, x.eligible_after::numeric,
           x.qty_before::bigint, x.qty_after::bigint, x.amount_vnd::bigint, x.status
      FROM jsonb_to_recordset(p_rows) AS x(event_key text, seq text, kind text, event_at text, order_line_id text,
             return_event_id text, user_id text, program_product_id text, quantity_class text, base_delta text,
             eligible_delta text, gmv_delta text, eligible_before text, eligible_after text, qty_before text, qty_after text,
             amount_vnd text, status text);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
  END;
  IF v_count <> v_n THEN RAISE EXCEPTION 'CMS_STAGE_COUNT_MISMATCH' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.cms_sync_run_chunks (run_id, part, chunk_no, row_count, digest) VALUES (p_run_id, p_part, p_chunk_no, v_n, v_digest);
  UPDATE public.cms_sync_runs SET rows_written = rows_written + v_n WHERE id = p_run_id;
  RETURN v_n;
END;
$$;

-- seal_begin run contract: expect + pin nguồn. Hình dạng sai ⇒ CMS_SEAL_BAD_EXPECT (không đổi trạng thái); dữ liệu staging lệch
-- khai báo ⇒ seal_fail. Mọi kiểm hình dạng tách IF riêng (PG không cam kết thứ tự đánh giá OR — hàm jsonb_object_keys trên scalar
-- sẽ lỗi thô nếu chạy trước kiểm kiểu).
CREATE FUNCTION public.cms__seal_begin_contract(p_run_id uuid, p_expect jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_run   public.cms_sync_runs%ROWTYPE;
  v_prog  public.cms_programs%ROWTYPE;
  v_part  text;
  v_parts text[];
  v_net   boolean;
  v_n     bigint;
  v_pin   jsonb;
  v_tot   jsonb;
  c_cnt   CONSTANT text := '^(0|[1-9][0-9]{0,8})$';
  c_dec   CONSTANT text := '^-?[0-9]{1,35}(\.[0-9]{1,9})?$';
  c_udec  CONSTANT text := '^[0-9]{1,35}(\.[0-9]{1,9})?$';
  c_vnd   CONSTANT text := '^(0|[1-9][0-9]{0,18})$';
  c_ts    CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$';
  c_date  CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';
  c_hex   CONSTANT text := '^[0-9a-f]{64}$';
  c_ref   CONSTANT text := '^[A-Za-z0-9_.:-]{1,255}$';  -- regex PG lặp tối đa 255
  -- Tổng run contract: khoá 122 trừ adjustment_lines (run contract không có dòng điều chỉnh âm — âm ⇒ HOLD N1) + lớp lượng + trả.
  c_tcnt  CONSTANT text[] := ARRAY['lines_read', 'candidates', 'included', 'unassigned', 'out_of_scope', 'returns_read',
                                   'returns_not_effective', 'returns_applied'];
  c_tobj  CONSTANT text[] := ARRAY['unassigned_by_reason', 'excluded_by_reason', 'class_counts', 'returns_excluded_by_reason'];
BEGIN
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.kind <> 'sales' OR v_run.status <> 'running' OR v_run.calc_contract_version IS NULL THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  v_net := v_run.returns_policy = 'net_returns_v1';
  v_parts := ARRAY['sales_lines', 'results', 'catalog', 'result_events', 'source_lines']
             || CASE WHEN v_net THEN ARRAY['return_lines'] ELSE ARRAY[]::text[] END;
  -- (1) kiểu các nút.
  IF p_expect IS NULL OR jsonb_typeof(p_expect) <> 'object' OR pg_column_size(p_expect) > 65536 THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END IF;
  v_pin := p_expect -> 'pin';
  v_tot := p_expect -> 'totals';
  IF jsonb_typeof(p_expect -> 'chunks') IS DISTINCT FROM 'object' OR jsonb_typeof(v_tot) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_pin) IS DISTINCT FROM 'object' OR jsonb_typeof(v_pin -> 'scope') IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_pin -> 'sales') IS DISTINCT FROM 'object'
     OR (v_net AND jsonb_typeof(v_pin -> 'returns') IS DISTINCT FROM 'object')
     OR EXISTS (SELECT 1 FROM unnest(c_tobj) k WHERE jsonb_typeof(v_tot -> k) IS DISTINCT FROM 'object') THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END IF;
  -- (2) đúng tập khoá ở mọi nút (không khoá lạ; run contract không có result_lines; sales-only không có return_lines / pin.returns).
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_expect) k
              WHERE NOT (k = ANY (v_parts || ARRAY['chunks', 'totals', 'pin', 'amount_vnd', 'rows_read', 'rows_rejected',
                                                    'bytes_processed', 'source_max_updated_at'])))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_expect -> 'chunks') k WHERE NOT (k = ANY (v_parts)))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_tot) k
                 WHERE NOT (k = ANY (c_tcnt || c_tobj || ARRAY['candidate_gmv', 'unassigned_gmv', 'amount_vnd',
                                                               'return_base_applied', 'return_gmv_applied'])))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_pin) k
                 WHERE NOT (k = ANY (ARRAY['protocol', 'provider', 'job_id', 'snapshot_id', 'as_of', 'scope', 'sales']
                                     || CASE WHEN v_net THEN ARRAY['returns'] ELSE ARRAY[]::text[] END)))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_pin -> 'scope') k WHERE NOT (k = ANY (ARRAY['from', 'to', 'products_hash'])))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_pin -> 'sales') k
                 WHERE NOT (k = ANY (ARRAY['rows_total', 'rows_staged', 'rows_rejected', 'staged_digest', 'rejected_digest'])))
     OR (v_net AND EXISTS (SELECT 1 FROM jsonb_object_keys(v_pin -> 'returns') k WHERE NOT (k = ANY (ARRAY['rows', 'digest']))))
     OR EXISTS (SELECT 1 FROM jsonb_each(v_tot -> 'unassigned_by_reason') e
                 WHERE e.key NOT IN ('NO_EMAIL', 'NOT_FOUND', 'MULTIPLE', 'SHARED_ACCOUNT', 'NOT_STAFF', 'STORE_NOT_ELIGIBLE')
                    OR jsonb_typeof(e.value) <> 'number' OR e.value::text !~ c_cnt)
     OR EXISTS (SELECT 1 FROM jsonb_each(v_tot -> 'excluded_by_reason') e
                 WHERE e.key NOT IN ('ORDER_NOT_ELIGIBLE', 'OUT_OF_WINDOW', 'PRODUCT_NOT_IN_PROGRAM', 'UNASSIGNED', 'OUT_OF_SCOPE')
                    OR jsonb_typeof(e.value) <> 'number' OR e.value::text !~ c_cnt)
     OR EXISTS (SELECT 1 FROM jsonb_each(v_tot -> 'returns_excluded_by_reason') e
                 WHERE e.key NOT IN ('NOT_COMPLETED', 'ORIGIN_NOT_ELIGIBLE', 'ORIGIN_OUT_OF_WINDOW', 'ORIGIN_NOT_IN_PROGRAM',
                                     'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE')
                    OR jsonb_typeof(e.value) <> 'number' OR e.value::text !~ c_cnt)
     -- class_counts: ĐỦ 5 lớp (0 vẫn ghi).
     OR (SELECT count(*) FROM jsonb_each(v_tot -> 'class_counts') e
          WHERE e.key IN ('POS_BASE', 'COUNTED', 'OTHER_UNIT', 'FRACTIONAL_QUANTITY', 'ZERO_QUANTITY')
            AND jsonb_typeof(e.value) = 'number' AND e.value::text ~ c_cnt) <> 5
     OR (SELECT count(*) FROM jsonb_object_keys(v_tot -> 'class_counts')) <> 5 THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END IF;
  -- (3) giá trị.
  IF NOT public.cms__str(p_expect, 'amount_vnd', c_vnd)
     OR NOT public.cms__str_or_null(p_expect, 'source_max_updated_at', c_ts)
     OR EXISTS (SELECT 1 FROM unnest(v_parts || ARRAY['rows_read', 'rows_rejected']) k
                 WHERE jsonb_typeof(p_expect -> k) IS DISTINCT FROM 'number' OR (p_expect ->> k) !~ c_cnt)
     OR EXISTS (SELECT 1 FROM unnest(v_parts) k
                 WHERE jsonb_typeof(p_expect -> 'chunks' -> k) IS DISTINCT FROM 'number' OR (p_expect -> 'chunks' ->> k) !~ c_cnt)
     OR EXISTS (SELECT 1 FROM unnest(c_tcnt) k WHERE jsonb_typeof(v_tot -> k) IS DISTINCT FROM 'number' OR (v_tot ->> k) !~ c_cnt)
     OR NOT public.cms__str(v_tot, 'candidate_gmv', c_dec) OR NOT public.cms__str(v_tot, 'unassigned_gmv', c_dec)
     OR NOT public.cms__str(v_tot, 'amount_vnd', c_vnd)
     OR NOT public.cms__str(v_tot, 'return_base_applied', c_udec) OR NOT public.cms__str(v_tot, 'return_gmv_applied', c_udec)
     OR (p_expect ? 'bytes_processed' AND jsonb_typeof(p_expect -> 'bytes_processed') <> 'null'
         AND (p_expect ->> 'bytes_processed') !~ '^(0|[1-9][0-9]{0,17})$')
     -- pin cms-source-pin-v1 (r2 §4.3): đúng một trong job_id / snapshot_id.
     OR v_pin ->> 'protocol' IS DISTINCT FROM 'cms-source-pin-v1'
     OR NOT public.cms__str(v_pin, 'provider', '^(bq|fixture)$')
     OR (v_pin ? 'job_id') = (v_pin ? 'snapshot_id')
     OR public.cms__str(v_pin, 'job_id', c_ref) = public.cms__str(v_pin, 'snapshot_id', c_ref)
     OR NOT public.cms__str(v_pin, 'as_of', c_ts)
     OR NOT public.cms__str(v_pin -> 'scope', 'from', c_date) OR NOT public.cms__str(v_pin -> 'scope', 'to', c_date)
     OR NOT public.cms__str(v_pin -> 'scope', 'products_hash', c_hex)
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['rows_total', 'rows_staged', 'rows_rejected']) k
                 WHERE jsonb_typeof(v_pin -> 'sales' -> k) IS DISTINCT FROM 'number' OR (v_pin -> 'sales' ->> k) !~ c_cnt)
     OR NOT public.cms__str(v_pin -> 'sales', 'staged_digest', c_hex) OR NOT public.cms__str(v_pin -> 'sales', 'rejected_digest', c_hex)
     OR (v_net AND (jsonb_typeof(v_pin -> 'returns' -> 'rows') IS DISTINCT FROM 'number' OR (v_pin -> 'returns' ->> 'rows') !~ c_cnt
                    OR NOT public.cms__str(v_pin -> 'returns', 'digest', c_hex))) THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END IF;
  -- (4) nhất quán nội bộ expect ↔ pin (worker tự mâu thuẫn ⇒ lỗi hình dạng, không phải dữ liệu).
  IF (v_pin -> 'sales' ->> 'rows_staged')::bigint <> (p_expect ->> 'source_lines')::bigint
     OR (v_pin -> 'sales' ->> 'rows_rejected')::bigint <> (p_expect ->> 'rows_rejected')::bigint
     OR (v_pin -> 'sales' ->> 'rows_total')::bigint <> (p_expect ->> 'rows_read')::bigint
     OR (p_expect ->> 'rows_read')::bigint <> (p_expect ->> 'source_lines')::bigint + (p_expect ->> 'rows_rejected')::bigint
     OR (v_tot ->> 'lines_read')::bigint <> (p_expect ->> 'source_lines')::bigint
     OR (v_tot ->> 'amount_vnd') <> (p_expect ->> 'amount_vnd')
     OR (v_net AND ((v_pin -> 'returns' ->> 'rows')::bigint <> (p_expect ->> 'return_lines')::bigint
                    OR (v_tot ->> 'returns_read')::bigint <> (p_expect ->> 'return_lines')::bigint))
     -- sales-only: không có "0 phiếu trả" giả nào khác 0.
     OR (NOT v_net AND ((v_tot ->> 'returns_read')::bigint <> 0 OR (v_tot ->> 'returns_not_effective')::bigint <> 0
                        OR (v_tot ->> 'returns_applied')::bigint <> 0 OR (v_tot -> 'returns_excluded_by_reason') <> '{}'::jsonb
                        OR (v_tot ->> 'return_base_applied')::numeric <> 0 OR (v_tot ->> 'return_gmv_applied')::numeric <> 0)) THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END IF;
  BEGIN
    PERFORM NULLIF(p_expect ->> 'source_max_updated_at', '')::timestamptz, (v_pin ->> 'as_of')::timestamptz,
            (v_pin -> 'scope' ->> 'from')::date, (v_pin -> 'scope' ->> 'to')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END;
  IF v_run.seal_expect IS NOT NULL OR v_run.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'CMS_SEAL_STARTED' USING ERRCODE = 'P0001'; END IF;
  IF v_run.started_at < now() - interval '30 minutes' THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'STALE'); END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_run.program_id;
  IF v_prog.status = 'locked' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_LOCKED'); END IF;
  IF v_prog.status <> 'active' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_NOT_ACTIVE'); END IF;
  IF v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN
    RETURN public.cms__seal_fail(p_run_id, 'held', 'CONFIG_CHANGED');
  END IF;
  IF public.cms__mapping_fp() <> v_run.mapping_fp THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'MAPPING_CHANGED'); END IF;
  -- Nguồn giả chỉ cho chương trình thử (r2 §4.3) — production không bao giờ nhận pin fixture.
  IF v_pin ->> 'provider' = 'fixture' AND NOT v_run.is_test THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_PIN_PROVIDER'); END IF;
  ANALYZE (SKIP_LOCKED) public.cms_sales_lines, public.cms_results, public.cms_result_catalog, public.cms_sales_source_lines,
    public.cms_return_lines, public.cms_result_events;
  -- Loại trừ chéo: run contract không có dữ liệu / khối của part ngoài whitelist theo loại.
  IF EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = p_run_id)
     OR (NOT v_net AND EXISTS (SELECT 1 FROM public.cms_return_lines WHERE run_id = p_run_id))
     OR EXISTS (SELECT 1 FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND NOT (part = ANY (v_parts))) THEN
    RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_PART_FORBIDDEN');
  END IF;
  -- S1 đủ dòng.
  IF (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = p_run_id) <> (p_expect ->> 'sales_lines')::bigint
     OR (SELECT count(*) FROM public.cms_results WHERE run_id = p_run_id) <> (p_expect ->> 'results')::bigint
     OR (SELECT count(*) FROM public.cms_result_catalog WHERE run_id = p_run_id) <> (p_expect ->> 'catalog')::bigint
     OR (SELECT count(*) FROM public.cms_result_events WHERE run_id = p_run_id) <> (p_expect ->> 'result_events')::bigint
     OR (SELECT count(*) FROM public.cms_sales_source_lines WHERE run_id = p_run_id) <> (p_expect ->> 'source_lines')::bigint
     OR (v_net AND (SELECT count(*) FROM public.cms_return_lines WHERE run_id = p_run_id) <> (p_expect ->> 'return_lines')::bigint) THEN
    RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_COUNT_MISMATCH');
  END IF;
  -- S2 đủ khối.
  FOREACH v_part IN ARRAY v_parts LOOP
    v_n := (p_expect -> 'chunks' ->> v_part)::bigint;
    IF (SELECT count(*) FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND part = v_part) <> v_n
       OR COALESCE((SELECT max(chunk_no) FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND part = v_part), -1) <> v_n - 1
       OR COALESCE((SELECT sum(row_count) FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND part = v_part), 0)
          <> (p_expect ->> v_part)::bigint THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_CHUNKS_MISMATCH');
    END IF;
  END LOOP;
  UPDATE public.cms_sync_runs SET seal_expect = p_expect, seal_step = 0 WHERE id = p_run_id;
  RETURN jsonb_build_object('ok', true, 'steps', 13);
END;
$$;

-- ── 7. Seal run contract — 13 bước DB tự tính lại (thiết kế r2 §5.2) ──────
-- Gọi từ rpc_cms_sales_run_seal_step (thân 122 + rẽ nhánh). Cùng khung 122: khoá run, thứ tự bước, "already" khi gọi lại, kiểm
-- khoá / active / cấu hình / mapping / STALE đầu MỖI bước. Dữ liệu staging đóng băng từ seal_begin. Mã fail:
--   · error SEAL_* — worker / staging lệch dữ liệu DB tự tính (lỗi kỹ thuật);
--   · held SEAL_N1_* / SEAL_N2_* / SEAL_N9_REJECTED — nguồn cần người xử lý (tập HOLD cùng lib/cms/calc/classify.ts + net.ts).
-- Mọi so sánh có thể NULL dùng IS [NOT] DISTINCT FROM (một vế NULL trong OR của WHERE sẽ bỏ lọt dòng lệch).
CREATE FUNCTION public.cms__seal_contract_step(p_run_id uuid, p_step integer)
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
  v_code  text;
  v_net   boolean;
  v_unit  boolean;
  v_asof  timestamptz;
  v_dig   text;
BEGIN
  IF p_step IS NULL OR p_step < 1 OR p_step > 13 THEN RAISE EXCEPTION 'CMS_SEAL_BAD_STEP' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.kind <> 'sales' OR v_run.status <> 'running' OR v_run.calc_contract_version IS NULL THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.seal_expect IS NULL THEN RAISE EXCEPTION 'CMS_SEAL_STEP_ORDER' USING ERRCODE = 'P0001'; END IF;
  IF v_run.sealed_at IS NOT NULL THEN
    RETURN CASE WHEN p_step = 13 THEN jsonb_build_object('sealed', true, 'step', 13, 'already', true, 'amount_vnd', v_run.amount_vnd::text)
                ELSE jsonb_build_object('sealed', false, 'ok', true, 'step', p_step, 'already', true) END;
  END IF;
  IF v_run.seal_step >= p_step THEN RETURN jsonb_build_object('sealed', false, 'ok', true, 'step', p_step, 'already', true); END IF;
  IF v_run.seal_step <> p_step - 1 THEN RAISE EXCEPTION 'CMS_SEAL_STEP_ORDER' USING ERRCODE = 'P0001'; END IF;
  IF v_run.started_at < now() - interval '30 minutes' THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'STALE'); END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_run.program_id;
  IF v_prog.status = 'locked' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_LOCKED'); END IF;
  IF v_prog.status <> 'active' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_NOT_ACTIVE'); END IF;
  IF v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN
    RETURN public.cms__seal_fail(p_run_id, 'held', 'CONFIG_CHANGED');
  END IF;
  IF public.cms__mapping_fp() <> v_run.mapping_fp THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'MAPPING_CHANGED'); END IF;
  v_exp  := v_run.seal_expect;
  v_from := (v_prog.start_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
  v_to   := ((v_prog.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
  v_net  := v_run.returns_policy = 'net_returns_v1';
  v_unit := v_run.quantity_basis = 'cms_unit';

  IF p_step = 1 THEN
    -- S1 thứ tự (r2 §5.4, parity lib/cms/calc/order.ts). Dòng bán: khoá 122 bước 1 nguyên văn. Phiếu trả: byte return_event_id.
    -- Sự kiện: µs → SALE trước RETURN → ID (SALE nhánh số / text như dòng bán; RETURN byte). Seq liên tục 0…n−1 ở cả ba bảng.
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
      OR EXISTS (
        SELECT 1 FROM (
          SELECT return_event_id AS c_id, lag(return_event_id) OVER (ORDER BY seq) AS p_id
            FROM public.cms_return_lines WHERE run_id = p_run_id) x
         WHERE x.p_id IS NOT NULL AND NOT (x.p_id COLLATE "C" < x.c_id COLLATE "C"))
      OR COALESCE((SELECT max(seq) FROM public.cms_return_lines WHERE run_id = p_run_id), -1)
         <> (SELECT count(*) FROM public.cms_return_lines WHERE run_id = p_run_id) - 1
      OR EXISTS (
        SELECT 1 FROM (
          SELECT e.event_at AS c_at, e.kind AS c_k, COALESCE(e.return_event_id, e.order_line_id) AS c_id,
                 regexp_replace(COALESCE(e.return_event_id, e.order_line_id), '^0+(?=[0-9])', '') AS c_t,
                 lag(e.event_at) OVER w AS p_at, lag(e.kind) OVER w AS p_k, lag(COALESCE(e.return_event_id, e.order_line_id)) OVER w AS p_id,
                 lag(regexp_replace(COALESCE(e.return_event_id, e.order_line_id), '^0+(?=[0-9])', '')) OVER w AS p_t
            FROM public.cms_result_events e WHERE e.run_id = p_run_id WINDOW w AS (ORDER BY e.seq)) x
         WHERE x.p_at > x.c_at
            OR (x.p_at = x.c_at AND x.p_k = 'RETURN' AND x.c_k = 'SALE')
            OR (x.p_at = x.c_at AND x.p_k = 'RETURN' AND x.c_k = 'RETURN' AND NOT (x.p_id COLLATE "C" < x.c_id COLLATE "C"))
            OR (x.p_at = x.c_at AND x.p_k = 'SALE' AND x.c_k = 'SALE'
                AND ((x.p_id !~ '^[0-9]+$' AND x.c_id ~ '^[0-9]+$')
                     OR (x.p_id ~ '^[0-9]+$' AND x.c_id ~ '^[0-9]+$'
                         AND NOT (length(x.p_t) < length(x.c_t)
                                  OR (length(x.p_t) = length(x.c_t) AND x.p_t COLLATE "C" < x.c_t COLLATE "C")
                                  OR (x.p_t = x.c_t AND x.p_id COLLATE "C" < x.c_id COLLATE "C")))
                     OR (x.p_id !~ '^[0-9]+$' AND x.c_id !~ '^[0-9]+$' AND NOT (x.p_id COLLATE "C" < x.c_id COLLATE "C")))))
      OR COALESCE((SELECT max(seq) FROM public.cms_result_events WHERE run_id = p_run_id), -1)
         <> (SELECT count(*) FROM public.cms_result_events WHERE run_id = p_run_id) - 1
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_ORDER'); END IF;
  ELSIF p_step = 2 THEN
    -- S2 kỳ / SP / phạm vi (điều kiện = 122 bước 2). count(*) > 0 thay EXISTS: EXISTS tối ưu khởi động nhanh (planner ước gần mọi dòng
    -- vi phạm) ⇒ chọn Merge Join quét index cms_sales_lines_product_fk_idx của MỌI run rồi lọc run_id (bench 14/11: 4,4 s / 1 triệu dòng
    -- bảng); đếm ⇒ tối ưu tổng chi phí. Run hợp lệ không có dòng vi phạm ⇒ hai dạng cùng đọc hết run.
    SELECT count(*) > 0
      FROM public.cms_sales_lines sl
      JOIN public.cms_program_products pp ON pp.id = sl.program_product_id
      LEFT JOIN public.cms_program_stores ps ON ps.program_id = v_run.program_id AND ps.store_id = sl.store_id
     WHERE sl.run_id = p_run_id
       AND (sl.product_id <> pp.product_id OR sl.completed_at < v_from OR sl.completed_at >= v_to
            OR (sl.disposition = 'INCLUDED' AND ps.store_id IS NULL)
            OR (sl.disposition = 'OUT_OF_SCOPE' AND ps.store_id IS NOT NULL))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_SCOPE'); END IF;
    -- Lớp nguồn ↔ lớp bán: tập ứng viên (OFFLINE + COMPLETED, trong kỳ, SP chương trình) KHÔNG âm của lớp nguồn = đúng tập dòng bán,
    -- mọi trường chung + thô / cờ bằng nhau. Không bỏ sót ứng viên; ứng viên âm ⇒ N1.
    WITH sc AS (
      SELECT s.* FROM public.cms_sales_source_lines s
       WHERE s.run_id = p_run_id AND s.order_type = 'OFFLINE' AND s.order_status = 'COMPLETED'
         AND s.completed_at >= v_from AND s.completed_at < v_to AND s.base_quantity >= 0 AND s.gmv_amount >= 0
         AND EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = v_run.program_id AND pp.product_id = s.product_id)
    ), sl AS (
      SELECT * FROM public.cms_sales_lines WHERE run_id = p_run_id
    )
    SELECT EXISTS (
      SELECT 1 FROM sc FULL JOIN sl ON sl.order_line_id = sc.order_line_id
       WHERE sc.order_line_id IS NULL OR sl.order_line_id IS NULL
          OR (sl.order_id, sl.order_code, sl.product_id, sl.seller_email, sl.pos_code, sl.completed_at, sl.source_updated_at,
              sl.quantity_raw, sl.uom_raw, sl.base_quantity, sl.gmv_amount, sl.quantity_src, sl.uom_src, sl.quantity_src_flag,
              sl.uom_src_flag)
             IS DISTINCT FROM
             (sc.order_id, sc.order_code, sc.product_id, sc.seller_email, sc.pos_code, sc.completed_at, sc.source_updated_at,
              sc.quantity_raw, sc.uom_raw, sc.base_quantity, sc.gmv_amount, sc.quantity_src, sc.uom_src, sc.quantity_src_flag,
              sc.uom_src_flag))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_SOURCE_LINK'); END IF;
  ELSIF p_step = 3 THEN
    -- S3 người bán (122 bước 3 nguyên văn).
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
    -- N1 (r2 §4.1 / §5.2). (a) thô ↔ sạch trên lớp nguồn, tính trên tập DISTINCT (hàm SECDEF từng dòng ≈ 6,8 s / 100k).
    SELECT EXISTS (SELECT 1 FROM (SELECT DISTINCT quantity_src, quantity_raw FROM public.cms_sales_source_lines
                                   WHERE run_id = p_run_id AND quantity_src IS NOT NULL) d
                    WHERE public.cms__src_clean(d.quantity_src) IS DISTINCT FROM d.quantity_raw)
        OR EXISTS (SELECT 1 FROM (SELECT DISTINCT uom_src, uom_raw FROM public.cms_sales_source_lines
                                   WHERE run_id = p_run_id AND uom_src IS NOT NULL) d
                    WHERE public.cms__src_clean(d.uom_src) IS DISTINCT FROM d.uom_raw)
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_N1_SRC'); END IF;
    -- (b) dòng BÁN âm của ứng viên chương trình (cả hai mode, kể cả dòng không stage được vào lớp bán) ⇒ HOLD.
    IF EXISTS (SELECT 1 FROM public.cms_sales_source_lines s
                WHERE s.run_id = p_run_id AND (s.base_quantity < 0 OR s.gmv_amount < 0)
                  AND s.order_type = 'OFFLINE' AND s.order_status = 'COMPLETED' AND s.completed_at >= v_from AND s.completed_at < v_to
                  AND EXISTS (SELECT 1 FROM public.cms_program_products pp
                               WHERE pp.program_id = v_run.program_id AND pp.product_id = s.product_id)) THEN
      RETURN public.cms__seal_fail(p_run_id, 'held', 'SEAL_N1_NEGATIVE_SALE');
    END IF;
    IF v_unit AND EXISTS (SELECT 1 FROM public.cms_program_products pp
                           WHERE pp.program_id = v_run.program_id
                             AND (public.cms__unit_key(pp.unit_cms) IS NULL OR pp.base_quantity_cms IS NULL OR pp.base_quantity_cms <= 0)) THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_N1_CONFIG');
    END IF;
    -- (c) phân loại MỌI ứng viên đã stage (INCLUDED / UNASSIGNED / OUT_OF_SCOPE — D7) theo đúng thứ tự classifyCmsSale; khoá đơn vị /
    -- lượng tính trên tập DISTINCT rồi hash join. Cờ NUL / OVERSIZE ⇒ không hợp lệ (TS writer HOLD cùng mã).
    -- MATERIALIZED bắt buộc (bench PG15 14/11): CTE inline ⇒ hàm SECDEF bị gọi lại TRÊN TỪNG DÒNG sau join, nhiều lần / dòng trong CASE
    -- (20k dòng 2,3 s; 200k ≈ 23 s). Vật hoá ⇒ mỗi giá trị phân biệt gọi đúng một lần.
    WITH pk AS MATERIALIZED (
      SELECT pp.id, pp.base_quantity_cms AS k, CASE WHEN v_unit THEN public.cms__unit_key(pp.unit_cms) END AS ukey
        FROM public.cms_program_products pp WHERE pp.program_id = v_run.program_id
    ), du AS MATERIALIZED (
      SELECT d.src, public.cms__unit_key(d.src) AS ukey
        FROM (SELECT DISTINCT uom_src AS src FROM public.cms_sales_lines
               WHERE run_id = p_run_id AND uom_src IS NOT NULL AND v_unit) d
    ), dq AS MATERIALIZED (
      SELECT d.src, public.cms__qty_dec(d.src) AS q
        FROM (SELECT DISTINCT quantity_src AS src FROM public.cms_sales_lines
               WHERE run_id = p_run_id AND quantity_src IS NOT NULL AND v_unit) d
    ), c AS (
      SELECT sl.quantity_class, sl.eligible_base, sl.base_quantity AS b,
             CASE
               WHEN sl.base_quantity < 0 OR sl.gmv_amount < 0 THEN 'H:NEGATIVE_SALE'
               WHEN NOT v_unit THEN 'POS_BASE'
               WHEN sl.uom_src_flag IS NOT NULL THEN 'H:UNIT_INVALID'
               WHEN sl.uom_src IS NULL OR sl.uom_src = '' THEN 'H:UNIT_MISSING'
               WHEN du.ukey IS NULL THEN 'H:UNIT_INVALID'
               WHEN sl.quantity_src_flag IS NOT NULL THEN 'H:QTY_INVALID'
               WHEN sl.quantity_src IS NULL OR sl.quantity_src = '' THEN 'H:QTY_MISSING'
               WHEN dq.q IS NULL THEN 'H:QTY_INVALID'
               WHEN dq.q < 0 THEN 'H:NEGATIVE_SALE'
               WHEN du.ukey <> pk.ukey THEN
                 CASE WHEN dq.q = 0 AND (sl.base_quantity <> 0 OR sl.gmv_amount <> 0) THEN 'H:ZERO_QTY_WITH_VALUE' ELSE 'OTHER_UNIT' END
               WHEN dq.q = 0 THEN
                 CASE WHEN sl.base_quantity <> 0 OR sl.gmv_amount <> 0 THEN 'H:ZERO_QTY_WITH_VALUE' ELSE 'ZERO_QUANTITY' END
               WHEN sl.base_quantity <> dq.q * pk.k THEN 'H:BASE_QTY_MISMATCH'
               WHEN dq.q <> trunc(dq.q) THEN 'FRACTIONAL_QUANTITY'
               WHEN dq.q > 9223372036854775807 THEN 'H:QTY_RANGE'
               ELSE 'COUNTED' END AS cls
        FROM public.cms_sales_lines sl
        JOIN pk ON pk.id = sl.program_product_id
        LEFT JOIN du ON du.src = sl.uom_src
        LEFT JOIN dq ON dq.src = sl.quantity_src
       WHERE sl.run_id = p_run_id
    )
    SELECT min(substr(c.cls, 3)) FILTER (WHERE c.cls LIKE 'H:%'),
           COALESCE(bool_or(c.quantity_class IS DISTINCT FROM c.cls
                            OR c.eligible_base IS DISTINCT FROM (CASE WHEN c.cls IN ('POS_BASE', 'COUNTED') THEN c.b ELSE 0 END)), false)
      INTO v_code, v_bad FROM c;
    IF v_code IS NOT NULL THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'SEAL_N1_' || v_code); END IF;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_N1_CLASS'); END IF;
  ELSIF p_step = 5 THEN
    -- N2 phiếu trả (r2 §5.2). Sales-only: không có dòng trả nào. Net: as_of trong cửa sổ run; tập HOLD cùng net.ts; disposition tự suy.
    IF NOT v_net THEN
      IF EXISTS (SELECT 1 FROM public.cms_return_lines WHERE run_id = p_run_id) THEN
        RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_PART_FORBIDDEN');
      END IF;
    ELSE
      v_asof := (v_exp -> 'pin' ->> 'as_of')::timestamptz;
      -- Cửa sổ as_of: không ở tương lai (> mở run + 5 phút) và không cũ hơn 36 giờ trước mở run (db-reviewer 14/11 P1-1 — snapshot phát
      -- lại; 36 giờ = mặc định Dev, đủ cho snapshot BI materialize hằng ngày; PM đổi được).
      IF v_asof > v_run.started_at + interval '5 minutes' OR v_asof < v_run.started_at - interval '36 hours' THEN
        RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_N2_AS_OF');
      END IF;
      WITH r AS (
        SELECT rl.return_event_id, rl.status_effect, rl.recorded_at, rl.original_order_line_id, rl.original_completed_at,
               rl.original_order_type, rl.original_order_status, rl.return_base_quantity, rl.return_gmv_amount, rl.disposition,
               src.order_line_id AS src_id, sl.disposition AS sale_disp,
               EXISTS (SELECT 1 FROM public.cms_program_products pp
                        WHERE pp.program_id = v_run.program_id AND pp.product_id = rl.product_id) AS in_prog,
               COALESCE(src.order_line_id IS NOT NULL AND (
                 (src.order_id, src.product_id, src.completed_at, src.order_type, src.order_status, src.seller_email, src.pos_code,
                  src.base_quantity, src.gmv_amount)
                 IS DISTINCT FROM
                 (rl.original_order_id, rl.product_id, rl.original_completed_at, rl.original_order_type, rl.original_order_status,
                  rl.original_seller_email, rl.original_pos_code, rl.original_base_quantity, rl.original_gmv_amount)
                 OR (v_unit AND (src.quantity_src, src.uom_src, src.quantity_src_flag, src.uom_src_flag)
                                IS DISTINCT FROM (rl.original_quantity_src, rl.original_uom_src, rl.original_quantity_src_flag,
                                                  rl.original_uom_src_flag))), false) AS ctx_bad
          FROM public.cms_return_lines rl
          LEFT JOIN public.cms_sales_source_lines src ON src.run_id = rl.run_id AND src.order_line_id = rl.original_order_line_id
          LEFT JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.original_order_line_id
         WHERE rl.run_id = p_run_id
      ), d AS (
        SELECT r.*,
               CASE WHEN r.status_effect = 'NOT_EFFECTIVE' THEN 'NOT_COMPLETED'
                    WHEN r.ctx_bad THEN NULL
                    WHEN NOT (r.original_order_type = 'OFFLINE' AND r.original_order_status = 'COMPLETED') THEN 'ORIGIN_NOT_ELIGIBLE'
                    WHEN r.original_completed_at < v_from OR r.original_completed_at >= v_to THEN 'ORIGIN_OUT_OF_WINDOW'
                    WHEN NOT r.in_prog THEN 'ORIGIN_NOT_IN_PROGRAM'
                    WHEN r.src_id IS NULL THEN NULL
                    WHEN r.sale_disp = 'UNASSIGNED' THEN 'ORIGIN_UNASSIGNED'
                    WHEN r.sale_disp = 'OUT_OF_SCOPE' THEN 'ORIGIN_OUT_OF_SCOPE'
                    WHEN r.sale_disp = 'INCLUDED' THEN 'APPLIED' END AS exp_disp
          FROM r
      ), acc AS (
        SELECT d.original_order_line_id AS id, sum(d.return_base_quantity) AS rb, sum(d.return_gmv_amount) AS rg
          FROM d WHERE d.exp_disp IN ('APPLIED', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE') GROUP BY d.original_order_line_id
      ), h AS (
        SELECT 'AFTER_AS_OF' AS code FROM d WHERE d.status_effect = 'EFFECTIVE' AND d.recorded_at > v_asof
        UNION ALL SELECT 'BEFORE_SALE' FROM d WHERE d.status_effect = 'EFFECTIVE' AND d.recorded_at < d.original_completed_at
        UNION ALL SELECT 'CONTEXT_MISMATCH' FROM d WHERE d.status_effect = 'EFFECTIVE' AND d.ctx_bad
        UNION ALL SELECT 'ORIGIN_MISSING' FROM d
                   WHERE d.status_effect = 'EFFECTIVE' AND NOT d.ctx_bad AND d.src_id IS NULL
                     AND d.original_order_type = 'OFFLINE' AND d.original_order_status = 'COMPLETED'
                     AND d.original_completed_at >= v_from AND d.original_completed_at < v_to AND d.in_prog
        UNION ALL SELECT 'EXCEEDS_SALE_BASE' FROM acc JOIN public.cms_sales_lines sl ON sl.run_id = p_run_id AND sl.order_line_id = acc.id
                   WHERE acc.rb > sl.base_quantity
        UNION ALL SELECT 'EXCEEDS_SALE_GMV' FROM acc JOIN public.cms_sales_lines sl ON sl.run_id = p_run_id AND sl.order_line_id = acc.id
                   WHERE acc.rg > sl.gmv_amount
      )
      SELECT (SELECT min(h.code) FROM h), EXISTS (SELECT 1 FROM d WHERE d.disposition IS DISTINCT FROM d.exp_disp)
        INTO v_code, v_bad;
      IF v_code IS NOT NULL THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'SEAL_N2_' || v_code); END IF;
      IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_N2_DISPOSITION'); END IF;
    END IF;
  ELSIF p_step = 6 THEN
    -- N3 sự kiện ↔ nguồn: mỗi dòng INCLUDED đúng một SALE, mỗi phiếu APPLIED đúng một RETURN; delta = nguồn + lớp lượng của dòng
    -- bán (gốc); mốc = completed_at / recorded_at; không sự kiện nào khác (khoá / FK / CHECK bảng ép phần còn lại).
    WITH s AS (SELECT * FROM public.cms_sales_lines WHERE run_id = p_run_id AND disposition = 'INCLUDED'),
         es AS (SELECT * FROM public.cms_result_events WHERE run_id = p_run_id AND kind = 'SALE'),
         r AS (SELECT rl.return_event_id, rl.sale_ref_line_id, rl.recorded_at, rl.return_base_quantity, rl.return_gmv_amount,
                      sl.user_id, sl.program_product_id, sl.quantity_class
                 FROM public.cms_return_lines rl
                 JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.sale_ref_line_id
                WHERE rl.run_id = p_run_id AND rl.disposition = 'APPLIED'),
         er AS (SELECT * FROM public.cms_result_events WHERE run_id = p_run_id AND kind = 'RETURN')
    SELECT EXISTS (
      SELECT 1 FROM s FULL JOIN es ON es.order_line_id = s.order_line_id
       WHERE s.order_line_id IS NULL OR es.order_line_id IS NULL
          OR (es.user_id, es.program_product_id, es.quantity_class, es.base_delta, es.eligible_delta, es.gmv_delta, es.event_at)
             IS DISTINCT FROM (s.user_id, s.program_product_id, s.quantity_class, s.base_quantity, s.eligible_base, s.gmv_amount,
                               s.completed_at))
    OR EXISTS (
      SELECT 1 FROM r FULL JOIN er ON er.return_event_id = r.return_event_id
       WHERE r.return_event_id IS NULL OR er.return_event_id IS NULL
          OR (er.order_line_id, er.user_id, er.program_product_id, er.quantity_class, er.base_delta, er.eligible_delta, er.gmv_delta,
              er.event_at)
             IS DISTINCT FROM (r.sale_ref_line_id, r.user_id, r.program_product_id, r.quantity_class, -r.return_base_quantity,
                               CASE WHEN r.quantity_class IN ('POS_BASE', 'COUNTED') THEN -r.return_base_quantity ELSE 0 END,
                               -r.return_gmv_amount, r.recorded_at))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_N3_EVENTS'); END IF;
  ELSIF p_step = 7 THEN
    -- N4 cấu hình trong kết quả = chương trình (SP, loại GMV, K, target; run contract không trần) và tổng nhóm = Σ sự kiện (bán /
    -- trả / đủ / GMV / tiền / số dòng / số phiếu, C_bán ở cms_unit), một store.
    IF EXISTS (SELECT 1 FROM public.cms_results r
                 JOIN public.cms_program_products pp ON pp.id = r.program_product_id
                WHERE r.run_id = p_run_id
                  AND ((r.product_id, r.gmv_basis, r.per_unit) IS DISTINCT FROM (pp.product_id, pp.gmv_basis, pp.base_quantity_cms)
                       OR r.target_gmv IS DISTINCT FROM (CASE pp.gmv_basis WHEN 'product' THEN pp.target_gmv
                                                                           WHEN 'catalog' THEN v_prog.catalog_target_gmv END)
                       OR r.cap_quantity IS NOT NULL OR r.net_v IS DISTINCT FROM 1)) THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_RESULT_CONFIG');
    END IF;
    IF EXISTS (SELECT 1 FROM public.cms_results r
                 LEFT JOIN (
                   SELECT e.user_id, e.program_product_id,
                          count(*) FILTER (WHERE e.kind = 'SALE') AS ns, count(*) FILTER (WHERE e.kind = 'RETURN') AS nr,
                          COALESCE(sum(e.base_delta) FILTER (WHERE e.kind = 'SALE'), 0) AS sb,
                          COALESCE(-sum(e.base_delta) FILTER (WHERE e.kind = 'RETURN'), 0) AS rb,
                          COALESCE(sum(e.eligible_delta) FILTER (WHERE e.kind = 'SALE'), 0) AS esb,
                          COALESCE(-sum(e.eligible_delta) FILTER (WHERE e.kind = 'RETURN'), 0) AS erb,
                          COALESCE(sum(e.gmv_delta) FILTER (WHERE e.kind = 'SALE'), 0) AS sg,
                          COALESCE(-sum(e.gmv_delta) FILTER (WHERE e.kind = 'RETURN'), 0) AS rg,
                          sum(e.amount_vnd::numeric) AS a,
                          COALESCE(sum(e.eligible_delta / pp.base_quantity_cms)
                                     FILTER (WHERE e.kind = 'SALE' AND e.quantity_class = 'COUNTED'), 0) AS cq,
                          min(sl.store_id::text) AS s1, max(sl.store_id::text) AS s2
                     FROM public.cms_result_events e
                     JOIN public.cms_sales_lines sl ON sl.run_id = e.run_id AND sl.order_line_id = e.order_line_id
                     JOIN public.cms_program_products pp ON pp.id = e.program_product_id
                    WHERE e.run_id = p_run_id GROUP BY e.user_id, e.program_product_id) x
                   ON x.user_id = r.user_id AND x.program_product_id = r.program_product_id
                WHERE r.run_id = p_run_id
                  AND (x.ns IS NULL OR x.ns = 0
                       OR (x.ns, x.nr, x.sb, x.rb, x.esb, x.erb, x.sg, x.rg, x.a, x.s1, x.s2)
                          IS DISTINCT FROM (r.line_count::bigint, r.return_count::bigint, r.sale_base, r.return_base, r.eligible_sale_base,
                                            r.eligible_return_base, r.sale_gmv, r.return_gmv, r.amount_vnd::numeric,
                                            r.store_id::text, r.store_id::text)
                       OR r.counted_sale_qty::numeric IS DISTINCT FROM (CASE WHEN v_unit THEN x.cq END))) THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_RESULT_SUMS');
    END IF;
  ELSIF p_step = 8 THEN
    -- N5 Q = floor(B_đủ_ròng / K) (bất đẳng thức chính xác) và F(Q) lũy tiến (thang 125 mở bậc cuối); tiền nhóm = gate ? F(Q) : 0.
    -- F tính một lần cho mỗi cặp (SP, Q) phân biệt như 122 bước 7.
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
         AND (NOT COALESCE(r.cms_quantity::numeric * r.per_unit <= r.eligible_base
                           AND r.eligible_base < (r.cms_quantity::numeric + 1) * r.per_unit, false)
              OR fq.f IS NULL OR r.potential_amount::numeric IS DISTINCT FROM fq.f
              OR r.amount_vnd IS DISTINCT FROM (CASE WHEN r.gate_met THEN r.potential_amount ELSE 0 END)))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TIER_AMOUNT'); END IF;
  ELSIF p_step = 9 THEN
    -- N6 gate SP theo GMV RÒNG cộng dồn theo seq sự kiện; đạt = cuối kỳ ≥ target; "đạt từ" = lần chuyển chưa đạt → đạt CUỐI (net.ts
    -- trackGate). SP không gate: luôn đạt, không GMV gate / target / mốc.
    WITH l AS (
      SELECT e.user_id, e.program_product_id, e.seq, e.event_at, e.gmv_delta, r.target_gmv
        FROM public.cms_result_events e
        JOIN public.cms_results r ON r.run_id = e.run_id AND r.user_id = e.user_id AND r.program_product_id = e.program_product_id
       WHERE e.run_id = p_run_id AND r.gmv_basis = 'product'
    ), c AS (
      SELECT l.*, (sum(l.gmv_delta) OVER (PARTITION BY l.user_id, l.program_product_id ORDER BY l.seq)) >= l.target_gmv AS met FROM l
    ), x AS (
      SELECT c.*, COALESCE(lag(c.met) OVER (PARTITION BY c.user_id, c.program_product_id ORDER BY c.seq), false) AS prev_met FROM c
    ), g AS (
      SELECT user_id, program_product_id, sum(gmv_delta) AS gmv, (array_agg(met ORDER BY seq DESC))[1] AS final_met,
             max(event_at) FILTER (WHERE met AND NOT prev_met) AS last_cross
        FROM x GROUP BY user_id, program_product_id
    )
    SELECT EXISTS (
      SELECT 1 FROM public.cms_results r
        LEFT JOIN g ON g.user_id = r.user_id AND g.program_product_id = r.program_product_id
       WHERE r.run_id = p_run_id AND r.gmv_basis = 'product'
         AND (g.user_id IS NULL OR r.gate_gmv IS DISTINCT FROM g.gmv OR r.gate_met IS DISTINCT FROM g.final_met
              OR r.gate_met_at IS DISTINCT FROM (CASE WHEN g.final_met THEN g.last_cross END)))
    OR EXISTS (
      SELECT 1 FROM public.cms_results r
       WHERE r.run_id = p_run_id AND r.gmv_basis = 'none'
         AND NOT COALESCE(r.gate_met AND r.gate_gmv IS NULL AND r.target_gmv IS NULL AND r.gate_met_at IS NULL, false))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_GATE'); END IF;
  ELSIF p_step = 10 THEN
    -- N7 gate danh mục theo dược sĩ: GMV ròng mọi sự kiện của SP danh mục, theo seq; line_count = số sự kiện (bán + trả); kết quả SP
    -- danh mục mang đúng gate của dược sĩ.
    WITH l AS (
      SELECT e.user_id, e.seq, e.event_at, e.gmv_delta, r.store_id
        FROM public.cms_result_events e
        JOIN public.cms_results r ON r.run_id = e.run_id AND r.user_id = e.user_id AND r.program_product_id = e.program_product_id
       WHERE e.run_id = p_run_id AND r.gmv_basis = 'catalog'
    ), c AS (
      SELECT l.*, (sum(l.gmv_delta) OVER (PARTITION BY l.user_id ORDER BY l.seq)) >= v_prog.catalog_target_gmv AS met FROM l
    ), x AS (
      SELECT c.*, COALESCE(lag(c.met) OVER (PARTITION BY c.user_id ORDER BY c.seq), false) AS prev_met FROM c
    ), g AS (
      SELECT user_id, sum(gmv_delta) AS gmv, count(*) AS n, (array_agg(met ORDER BY seq DESC))[1] AS final_met,
             max(event_at) FILTER (WHERE met AND NOT prev_met) AS last_cross,
             min(store_id::text) AS s1, max(store_id::text) AS s2
        FROM x GROUP BY user_id
    )
    SELECT EXISTS (
      SELECT 1 FROM g FULL JOIN (SELECT * FROM public.cms_result_catalog WHERE run_id = p_run_id) k ON k.user_id = g.user_id
       WHERE g.user_id IS NULL OR k.user_id IS NULL
          OR (k.catalog_gmv, k.line_count::bigint, k.met, k.store_id::text, k.store_id::text)
             IS DISTINCT FROM (g.gmv, g.n, g.final_met, g.s1, g.s2)
          OR k.target_gmv IS DISTINCT FROM v_prog.catalog_target_gmv
          OR k.met_at IS DISTINCT FROM (CASE WHEN g.final_met THEN g.last_cross END))
    OR EXISTS (
      SELECT 1 FROM public.cms_results r
        LEFT JOIN public.cms_result_catalog k ON k.run_id = r.run_id AND k.user_id = r.user_id
       WHERE r.run_id = p_run_id AND r.gmv_basis = 'catalog'
         AND (k.user_id IS NULL OR (r.gate_gmv, r.gate_met, r.gate_met_at) IS DISTINCT FROM (k.catalog_gmv, k.met, k.met_at)))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_CATALOG'); END IF;
  ELSIF p_step = 11 THEN
    -- N8 phân bổ từng sự kiện: B đủ trước = Σ delta trước theo seq trong nhóm (CHECK bảng ép sau = trước + delta, ≥ 0); Q trước /
    -- sau; tiền = gate ? F(Q_sau) − F(Q_trước) : 0; trạng thái đúng thứ tự net.ts.
    WITH l AS (
      SELECT e.*, r.per_unit, r.gate_met,
             COALESCE(sum(e.eligible_delta) OVER (PARTITION BY e.user_id, e.program_product_id ORDER BY e.seq
                                                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS exp_before
        FROM public.cms_result_events e
        JOIN public.cms_results r ON r.run_id = e.run_id AND r.user_id = e.user_id AND r.program_product_id = e.program_product_id
       WHERE e.run_id = p_run_id
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
       WHERE f.eligible_before IS DISTINCT FROM f.exp_before
          OR NOT COALESCE(f.qty_before::numeric * f.per_unit <= f.eligible_before
                          AND f.eligible_before < (f.qty_before::numeric + 1) * f.per_unit, false)
          OR NOT COALESCE(f.qty_after::numeric * f.per_unit <= f.eligible_after
                          AND f.eligible_after < (f.qty_after::numeric + 1) * f.per_unit, false)
          OR (f.gate_met AND (f.f_after IS NULL OR f.f_before IS NULL))
          OR f.amount_vnd::numeric IS DISTINCT FROM (CASE WHEN f.gate_met THEN f.f_after - f.f_before ELSE 0 END)
          OR f.status IS DISTINCT FROM (
               CASE WHEN f.kind = 'SALE' THEN
                      CASE WHEN f.quantity_class NOT IN ('POS_BASE', 'COUNTED') THEN 'NOT_COUNTED'
                           WHEN NOT f.gate_met THEN 'WAITING_GATE'
                           WHEN f.amount_vnd > 0 THEN 'RECORDED'
                           ELSE 'ACCUMULATING' END
                    WHEN NOT f.gate_met AND f.eligible_delta <> 0 THEN 'WAITING_GATE'
                    WHEN f.amount_vnd < 0 THEN 'RETURN_REDUCED'
                    ELSE 'RETURN_NO_CHANGE' END))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_LINE_ALLOC'); END IF;
  ELSIF p_step = 12 THEN
    -- N9 pin (cms-source-pin-v1, r2 §4.3): contract mới không nhận dòng normalizer từ chối (PM r2 — fail-closed); phạm vi pin = kỳ + tập
    -- SP chương trình; digest cms-src-digest-v1 DB tự tính trên lớp nguồn (và phiếu trả khi net) = pin. Mỗi dòng: token
    -- `<byte UTF-8>:<giá trị>` (NULL ⇒ `-`), số = đơn vị 10⁻⁹, thời điểm = µs UTC; sha256 từng dòng; digest = sha256 của
    -- version / loại / số dòng / hash dòng theo byte ID, nối bằng LF. Cùng hợp đồng TS (parity ở harness).
    IF (v_exp ->> 'rows_rejected')::bigint > 0 THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'SEAL_N9_REJECTED'); END IF;
    SELECT encode(sha256(convert_to('cms-src-digest-v1' || E'\n' || 'products' || E'\n' || count(*)::text || E'\n'
                                    || COALESCE(string_agg(pp.product_id, E'\n' ORDER BY pp.product_id COLLATE "C"), ''), 'UTF8')), 'hex')
      INTO v_dig FROM public.cms_program_products pp WHERE pp.program_id = v_run.program_id;
    IF (v_exp -> 'pin' -> 'scope' ->> 'from')::date IS DISTINCT FROM v_prog.start_date
       OR (v_exp -> 'pin' -> 'scope' ->> 'to')::date IS DISTINCT FROM v_prog.end_date
       OR v_dig IS DISTINCT FROM v_exp -> 'pin' -> 'scope' ->> 'products_hash' THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_PIN_SCOPE');
    END IF;
    SELECT encode(sha256(convert_to('cms-src-digest-v1' || E'\n' || 'sales' || E'\n' || count(*)::text || E'\n'
                                    || COALESCE(string_agg(h.h, E'\n' ORDER BY h.id COLLATE "C"), ''), 'UTF8')), 'hex')
      INTO v_dig
      FROM (SELECT s.order_line_id AS id, encode(sha256(convert_to(
                     COALESCE(octet_length(s.order_line_id) || ':' || s.order_line_id, '-')
                  || COALESCE(octet_length(s.order_id) || ':' || s.order_id, '-')
                  || COALESCE(octet_length(s.order_code) || ':' || s.order_code, '-')
                  || COALESCE(octet_length(s.product_id) || ':' || s.product_id, '-')
                  || COALESCE(octet_length(s.seller_email) || ':' || s.seller_email, '-')
                  || COALESCE(octet_length(s.pos_code) || ':' || s.pos_code, '-')
                  || COALESCE(octet_length(s.order_type) || ':' || s.order_type, '-')
                  || COALESCE(octet_length(s.order_status) || ':' || s.order_status, '-')
                  || COALESCE(octet_length(n.c_at) || ':' || n.c_at, '-')
                  || COALESCE(octet_length(n.u_at) || ':' || n.u_at, '-')
                  || COALESCE(octet_length(s.quantity_src) || ':' || s.quantity_src, '-')
                  || COALESCE(octet_length(s.uom_src) || ':' || s.uom_src, '-')
                  || COALESCE(octet_length(s.quantity_src_flag) || ':' || s.quantity_src_flag, '-')
                  || COALESCE(octet_length(s.uom_src_flag) || ':' || s.uom_src_flag, '-')
                  || COALESCE(octet_length(n.b) || ':' || n.b, '-')
                  || COALESCE(octet_length(n.g) || ':' || n.g, '-'), 'UTF8')), 'hex') AS h
              FROM public.cms_sales_source_lines s
              CROSS JOIN LATERAL (SELECT trunc(extract(epoch FROM s.completed_at) * 1000000, 0)::text AS c_at,
                                         trunc(extract(epoch FROM s.source_updated_at) * 1000000, 0)::text AS u_at,
                                         trunc(s.base_quantity * 1000000000, 0)::text AS b,
                                         trunc(s.gmv_amount * 1000000000, 0)::text AS g) n
             WHERE s.run_id = p_run_id) h;
    IF v_dig IS DISTINCT FROM v_exp -> 'pin' -> 'sales' ->> 'staged_digest' THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_PIN_DIGEST');
    END IF;
    IF v_net THEN
      SELECT encode(sha256(convert_to('cms-src-digest-v1' || E'\n' || 'returns' || E'\n' || count(*)::text || E'\n'
                                      || COALESCE(string_agg(h.h, E'\n' ORDER BY h.id COLLATE "C"), ''), 'UTF8')), 'hex')
        INTO v_dig
        FROM (SELECT r.return_event_id AS id, encode(sha256(convert_to(
                       COALESCE(octet_length(r.return_event_id) || ':' || r.return_event_id, '-')
                    || COALESCE(octet_length(r.return_status) || ':' || r.return_status, '-')
                    || COALESCE(octet_length(r.return_document_id) || ':' || r.return_document_id, '-')
                    || COALESCE(octet_length(r.return_code) || ':' || r.return_code, '-')
                    || COALESCE(octet_length(n.rec) || ':' || n.rec, '-')
                    || COALESCE(octet_length(r.original_order_line_id) || ':' || r.original_order_line_id, '-')
                    || COALESCE(octet_length(r.original_order_id) || ':' || r.original_order_id, '-')
                    || COALESCE(octet_length(r.product_id) || ':' || r.product_id, '-')
                    || COALESCE(octet_length(n.rb) || ':' || n.rb, '-')
                    || COALESCE(octet_length(n.rg) || ':' || n.rg, '-')
                    || COALESCE(octet_length(n.oc) || ':' || n.oc, '-')
                    || COALESCE(octet_length(r.original_order_type) || ':' || r.original_order_type, '-')
                    || COALESCE(octet_length(r.original_order_status) || ':' || r.original_order_status, '-')
                    || COALESCE(octet_length(r.original_seller_email) || ':' || r.original_seller_email, '-')
                    || COALESCE(octet_length(r.original_pos_code) || ':' || r.original_pos_code, '-')
                    || COALESCE(octet_length(n.ob) || ':' || n.ob, '-')
                    || COALESCE(octet_length(n.og) || ':' || n.og, '-')
                    || COALESCE(octet_length(r.original_quantity_src) || ':' || r.original_quantity_src, '-')
                    || COALESCE(octet_length(r.original_uom_src) || ':' || r.original_uom_src, '-')
                    || COALESCE(octet_length(r.original_quantity_src_flag) || ':' || r.original_quantity_src_flag, '-')
                    || COALESCE(octet_length(r.original_uom_src_flag) || ':' || r.original_uom_src_flag, '-')
                    || COALESCE(octet_length(n.su) || ':' || n.su, '-'), 'UTF8')), 'hex') AS h
                FROM public.cms_return_lines r
                CROSS JOIN LATERAL (SELECT trunc(extract(epoch FROM r.recorded_at) * 1000000, 0)::text AS rec,
                                           trunc(r.return_base_quantity * 1000000000, 0)::text AS rb,
                                           trunc(r.return_gmv_amount * 1000000000, 0)::text AS rg,
                                           trunc(extract(epoch FROM r.original_completed_at) * 1000000, 0)::text AS oc,
                                           trunc(r.original_base_quantity * 1000000000, 0)::text AS ob,
                                           trunc(r.original_gmv_amount * 1000000000, 0)::text AS og,
                                           trunc(extract(epoch FROM r.source_updated_at) * 1000000, 0)::text AS su) n
               WHERE r.run_id = p_run_id) h;
      IF v_dig IS DISTINCT FROM v_exp -> 'pin' -> 'returns' ->> 'digest' THEN
        RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_PIN_DIGEST');
      END IF;
    END IF;
  ELSE
    -- N10 tổng tiền = khai báo, trong miền bigint; mọi khoá totals = dữ liệu (loại ngoài ứng viên đếm CHÍNH XÁC từ lớp nguồn); mốc
    -- nguồn ≥ mốc dòng nguồn. Rồi đóng seal: ghi pin / digest (đã kiểm ở N9) và cột trả của run net.
    SELECT COALESCE(sum(amount_vnd::numeric), 0) INTO v_sum FROM public.cms_results WHERE run_id = p_run_id;
    IF v_sum <> (v_exp ->> 'amount_vnd')::numeric OR v_sum > 9223372036854775807 THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TOTAL');
    END IF;
    WITH a AS (
      SELECT count(*) AS cand,
             count(*) FILTER (WHERE disposition = 'INCLUDED') AS inc,
             count(*) FILTER (WHERE disposition = 'UNASSIGNED') AS una,
             count(*) FILTER (WHERE disposition = 'OUT_OF_SCOPE') AS oos,
             COALESCE(sum(gmv_amount), 0) AS cgmv,
             COALESCE(sum(gmv_amount) FILTER (WHERE disposition = 'UNASSIGNED'), 0) AS ugmv,
             jsonb_build_object(
               'POS_BASE', count(*) FILTER (WHERE disposition = 'INCLUDED' AND quantity_class = 'POS_BASE'),
               'COUNTED', count(*) FILTER (WHERE disposition = 'INCLUDED' AND quantity_class = 'COUNTED'),
               'OTHER_UNIT', count(*) FILTER (WHERE disposition = 'INCLUDED' AND quantity_class = 'OTHER_UNIT'),
               'FRACTIONAL_QUANTITY', count(*) FILTER (WHERE disposition = 'INCLUDED' AND quantity_class = 'FRACTIONAL_QUANTITY'),
               'ZERO_QUANTITY', count(*) FILTER (WHERE disposition = 'INCLUDED' AND quantity_class = 'ZERO_QUANTITY')) AS cls
        FROM public.cms_sales_lines WHERE run_id = p_run_id
    ), s AS (
      SELECT count(*) AS n, max(s.source_updated_at) AS mx,
             count(*) FILTER (WHERE NOT (s.order_type = 'OFFLINE' AND s.order_status = 'COMPLETED')) AS ne,
             count(*) FILTER (WHERE s.order_type = 'OFFLINE' AND s.order_status = 'COMPLETED'
                                AND (s.completed_at < v_from OR s.completed_at >= v_to)) AS ow,
             count(*) FILTER (WHERE s.order_type = 'OFFLINE' AND s.order_status = 'COMPLETED'
                                AND s.completed_at >= v_from AND s.completed_at < v_to AND pp.id IS NULL) AS np
        FROM public.cms_sales_source_lines s
        LEFT JOIN public.cms_program_products pp ON pp.program_id = v_run.program_id AND pp.product_id = s.product_id
       WHERE s.run_id = p_run_id
    ), rt AS (
      SELECT count(*) AS n,
             count(*) FILTER (WHERE status_effect = 'NOT_EFFECTIVE') AS ne,
             count(*) FILTER (WHERE disposition = 'APPLIED') AS ap,
             COALESCE(sum(return_base_quantity) FILTER (WHERE disposition = 'APPLIED'), 0) AS rb,
             COALESCE(sum(return_gmv_amount) FILTER (WHERE disposition = 'APPLIED'), 0) AS rg
        FROM public.cms_return_lines WHERE run_id = p_run_id
    )
    SELECT EXISTS (
      SELECT 1 FROM a, s, rt
       WHERE (a.cand, a.inc, a.una, a.oos, a.cgmv, a.ugmv, s.n, rt.n, rt.ne, rt.ap, rt.rb, rt.rg)
             IS DISTINCT FROM ((v_exp -> 'totals' ->> 'candidates')::bigint, (v_exp -> 'totals' ->> 'included')::bigint,
                               (v_exp -> 'totals' ->> 'unassigned')::bigint, (v_exp -> 'totals' ->> 'out_of_scope')::bigint,
                               (v_exp -> 'totals' ->> 'candidate_gmv')::numeric, (v_exp -> 'totals' ->> 'unassigned_gmv')::numeric,
                               (v_exp -> 'totals' ->> 'lines_read')::bigint, (v_exp -> 'totals' ->> 'returns_read')::bigint,
                               (v_exp -> 'totals' ->> 'returns_not_effective')::bigint, (v_exp -> 'totals' ->> 'returns_applied')::bigint,
                               (v_exp -> 'totals' ->> 'return_base_applied')::numeric,
                               (v_exp -> 'totals' ->> 'return_gmv_applied')::numeric)
          OR a.cls IS DISTINCT FROM v_exp -> 'totals' -> 'class_counts'
          OR jsonb_strip_nulls(jsonb_build_object('ORDER_NOT_ELIGIBLE', NULLIF(s.ne, 0), 'OUT_OF_WINDOW', NULLIF(s.ow, 0),
                                                  'PRODUCT_NOT_IN_PROGRAM', NULLIF(s.np, 0), 'UNASSIGNED', NULLIF(a.una, 0),
                                                  'OUT_OF_SCOPE', NULLIF(a.oos, 0)))
             IS DISTINCT FROM v_exp -> 'totals' -> 'excluded_by_reason'
          OR COALESCE((SELECT jsonb_object_agg(g.unassigned_reason, g.n) FROM (
                         SELECT unassigned_reason, count(*) AS n FROM public.cms_sales_lines
                          WHERE run_id = p_run_id AND disposition = 'UNASSIGNED' GROUP BY unassigned_reason) g), '{}'::jsonb)
             IS DISTINCT FROM v_exp -> 'totals' -> 'unassigned_by_reason'
          OR COALESCE((SELECT jsonb_object_agg(g.disposition, g.n) FROM (
                         SELECT disposition, count(*) AS n FROM public.cms_return_lines
                          WHERE run_id = p_run_id AND disposition <> 'APPLIED' GROUP BY disposition) g), '{}'::jsonb)
             IS DISTINCT FROM v_exp -> 'totals' -> 'returns_excluded_by_reason'
          OR (s.mx IS NOT NULL AND (v_exp ->> 'source_max_updated_at') IS NULL)
          OR (s.mx IS NOT NULL AND (v_exp ->> 'source_max_updated_at')::timestamptz < s.mx))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TOTALS'); END IF;
    UPDATE public.cms_sync_runs SET
      seal_step = 13,
      sealed_at = now(),
      amount_vnd = v_sum::bigint,
      rows_read = (v_exp ->> 'rows_read')::integer,
      rows_rejected = (v_exp ->> 'rows_rejected')::integer,
      bytes_processed = NULLIF(v_exp ->> 'bytes_processed', '')::bigint,
      source_max_updated_at = NULLIF(v_exp ->> 'source_max_updated_at', '')::timestamptz,
      detail = detail || jsonb_build_object('totals', v_exp -> 'totals'),
      source_pin = v_exp -> 'pin',
      sales_src_digest = v_exp -> 'pin' -> 'sales' ->> 'staged_digest',
      returns_as_of = CASE WHEN v_net THEN (v_exp -> 'pin' ->> 'as_of')::timestamptz END,
      returns_digest = CASE WHEN v_net THEN v_exp -> 'pin' -> 'returns' ->> 'digest' END,
      returns_rows_read = CASE WHEN v_net THEN (v_exp -> 'pin' -> 'returns' ->> 'rows')::integer END
    WHERE id = p_run_id;
    RETURN jsonb_build_object('sealed', true, 'step', 13, 'amount_vnd', v_sum::text);
  END IF;
  UPDATE public.cms_sync_runs SET seal_step = p_step WHERE id = p_run_id;
  RETURN jsonb_build_object('sealed', false, 'ok', true, 'step', p_step);
END;
$$;

-- ── 8. Ledger trả hàng bền (PM D14) + publish run contract (thiết kế r2 §6–§7, r2.1 §14.1–§14.3) ──
-- Bảng BỀN: ngoài cleanup; chỉ INSERT (UPDATE / DELETE / TRUNCATE ⇒ CMS_LEDGER_IMMUTABLE, áp CẢ owner, ENABLE ALWAYS); chỉ RPC owner
-- ghi (cms__run_auth_guard). Mọi bất biến thứ tự (eval_seq liên tục dưới khoá chương trình, sàn as_of, baseline chỉ sau eval CLEAN mới
-- nhất, conflict chỉ từ eval MISMATCH mới nhất, observation liên tục, phục hồi chỉ trên proof mới nhất) kiểm bằng trigger DB ⇒ owner ghi
-- thẳng cũng không vượt. Không có trạng thái RESOLVED / ACCEPT_NEW: baseline bất biến, conflict mở ⇔ chưa có dòng phục hồi.
-- Thay r2 §6.3 (r2.1 §14.1): KHÔNG có cms_run_ledger_checks — mỗi lượt đánh giá là MỘT dòng eval bền; chi tiết lệch nằm ở observation.

-- Báo cáo trả sau chốt (D11 — RPC ở lát báo cáo). Header tạo ở đây vì baseline nhận SAU chốt trỏ tới nó: một sổ receipt duy nhất
-- (r2.1 §14.2). FK (program, run chốt) → cms_payouts ⇒ chỉ chương trình đã chốt, đúng run chốt.
ALTER TABLE public.cms_payouts ADD CONSTRAINT cms_payouts_program_run UNIQUE (program_id, run_id);
CREATE TABLE public.cms_return_close_reports (
  id                        uuid        PRIMARY KEY,
  program_id                uuid        NOT NULL,
  payout_run_id             uuid        NOT NULL,
  eval_seq                  bigint      NOT NULL,
  calc_contract_version     text        NOT NULL CHECK (calc_contract_version = 'cms-calc-ret2-v1'),
  fp_version                text        NOT NULL CHECK (fp_version = 'cms-return-fp-v1'),
  status_dictionary_version text        NOT NULL CHECK (status_dictionary_version = 'cms-return-status-v1'),
  source_pin                jsonb       NOT NULL CHECK (jsonb_typeof(source_pin) = 'object'),
  returns_as_of             timestamptz NOT NULL CHECK (isfinite(returns_as_of)),
  returns_digest            text        NOT NULL CHECK (returns_digest ~ '^[0-9a-f]{64}$'),
  frozen_amount             bigint      NOT NULL CHECK (frozen_amount >= 0),
  recomputed_amount         bigint      NOT NULL CHECK (recomputed_amount >= 0),
  delta_amount              bigint      NOT NULL,
  return_events             integer     NOT NULL CHECK (return_events >= 0),
  line_count                integer     NOT NULL CHECK (line_count >= 0),
  idem_key                  text        NOT NULL CHECK (idem_key ~ '^[0-9a-f]{64}$'),
  created_via               text        NOT NULL CHECK (created_via IN ('cron', 'super')),
  created_by                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cms_return_close_reports_idem UNIQUE (idem_key),
  CONSTRAINT cms_return_close_reports_bind UNIQUE (id, program_id),
  CONSTRAINT cms_return_close_reports_eval UNIQUE (program_id, eval_seq),
  CONSTRAINT cms_return_close_reports_payout_fk FOREIGN KEY (program_id, payout_run_id) REFERENCES public.cms_payouts (program_id, run_id),
  CONSTRAINT cms_return_close_reports_delta CHECK (delta_amount = recomputed_amount - frozen_amount),
  CONSTRAINT cms_return_close_reports_actor CHECK ((created_via = 'super') = (created_by IS NOT NULL))
);

-- Lượt đánh giá ledger (r2.1 §14.1): mỗi lượt hợp lệ — publish run net hoặc kiểm báo cáo sau chốt — MỘT dòng, kể cả lượt held và lượt
-- không sinh observation. eval_seq = max + 1 cấp dưới khoá chương trình (thứ tự toàn phần; không xếp theo thời gian). Sàn as_of: không
-- eval nào có returns_as_of nhỏ hơn cms__as_of_floor của chương trình (eval trước / baseline / run net đã khai seal). Hash: ledger_set_hash = tập baseline LÚC đánh giá (trước baseline
-- mới của lượt CLEAN); open_set_hash = tập conflict mở SAU lượt này.
CREATE TABLE public.cms_return_ledger_evals (
  program_id      uuid        NOT NULL REFERENCES public.cms_programs (id),
  eval_seq        bigint      NOT NULL CHECK (eval_seq >= 1),
  kind            text        NOT NULL CHECK (kind IN ('run', 'report')),
  run_id          uuid,
  report_attempt  uuid,
  returns_as_of   timestamptz NOT NULL CHECK (isfinite(returns_as_of)),
  returns_digest  text        NOT NULL CHECK (returns_digest ~ '^[0-9a-f]{64}$'),
  verdict         text        NOT NULL CHECK (verdict IN ('CLEAN', 'MISMATCH', 'OPEN_CONFLICT_MATCH')),
  baselines       integer     NOT NULL CHECK (baselines >= 0),
  mismatched      integer     NOT NULL CHECK (mismatched >= 0),
  open_conflicts  integer     NOT NULL CHECK (open_conflicts >= 0),
  ledger_set_hash text        NOT NULL CHECK (ledger_set_hash ~ '^[0-9a-f]{64}$'),
  open_set_hash   text        NOT NULL CHECK (open_set_hash ~ '^[0-9a-f]{64}$'),
  config_version  integer     NOT NULL CHECK (config_version >= 1),
  evaluated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, eval_seq),
  CONSTRAINT cms_return_ledger_evals_run UNIQUE (run_id),
  CONSTRAINT cms_return_ledger_evals_attempt UNIQUE (report_attempt),
  CONSTRAINT cms_return_ledger_evals_run_bind UNIQUE (program_id, eval_seq, run_id),
  CONSTRAINT cms_return_ledger_evals_run_verdict UNIQUE (program_id, eval_seq, run_id, verdict),
  CONSTRAINT cms_return_ledger_evals_report_bind UNIQUE (program_id, eval_seq, report_attempt),
  CONSTRAINT cms_return_ledger_evals_run_fk FOREIGN KEY (run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id),
  CONSTRAINT cms_return_ledger_evals_ref CHECK (
    (kind = 'run' AND run_id IS NOT NULL AND report_attempt IS NULL)
    OR (kind = 'report' AND run_id IS NULL AND report_attempt IS NOT NULL)),
  -- Mọi vế boolean không NULL (cột NOT NULL). MISMATCH ⇒ mỗi baseline lệch đều có conflict mở sau lượt này.
  CONSTRAINT cms_return_ledger_evals_shape CHECK (
    mismatched <= baselines AND open_conflicts <= baselines
    AND ((verdict = 'CLEAN' AND mismatched = 0 AND open_conflicts = 0)
         OR (verdict = 'MISMATCH' AND mismatched > 0 AND open_conflicts >= mismatched)
         OR (verdict = 'OPEN_CONFLICT_MATCH' AND mismatched = 0 AND open_conflicts > 0)))
);
ALTER TABLE public.cms_return_close_reports ADD CONSTRAINT cms_return_close_reports_eval_fk
  FOREIGN KEY (program_id, eval_seq, id) REFERENCES public.cms_return_ledger_evals (program_id, eval_seq, report_attempt);
-- Dòng báo cáo: một dòng / nhóm (dược sĩ, SP) của run chốt — số chốt (frozen_*) + trả APPLIED + số tính lại; line_no cho keyset.
CREATE TABLE public.cms_return_close_report_lines (
  report_id          uuid        NOT NULL,
  program_id         uuid        NOT NULL,
  line_no            integer     NOT NULL CHECK (line_no >= 0),
  user_id            uuid        NOT NULL,
  program_product_id uuid        NOT NULL,
  product_id         text        NOT NULL CHECK (product_id ~ '^[1-9][0-9]{0,18}$'),
  gmv_basis          text        NOT NULL CHECK (gmv_basis IN ('product', 'catalog', 'none')),
  per_unit           numeric     NOT NULL CHECK (per_unit > 0),
  frozen_base        numeric     NOT NULL,
  frozen_qty         bigint      NOT NULL CHECK (frozen_qty >= 0),
  frozen_gmv         numeric     NOT NULL,
  frozen_gate_met    boolean     NOT NULL,
  frozen_amount      bigint      NOT NULL CHECK (frozen_amount >= 0),
  return_base        numeric     NOT NULL CHECK (return_base >= 0),
  return_gmv         numeric     NOT NULL CHECK (return_gmv >= 0),
  return_events      integer     NOT NULL CHECK (return_events >= 0),
  eligible_base      numeric     NOT NULL,
  net_gmv            numeric     NOT NULL,
  gate_met           boolean     NOT NULL,
  recomputed_qty     bigint      NOT NULL CHECK (recomputed_qty >= 0),
  recomputed_amount  bigint      NOT NULL CHECK (recomputed_amount >= 0),
  delta              bigint      NOT NULL,
  PRIMARY KEY (report_id, user_id, program_product_id),
  CONSTRAINT cms_return_close_report_lines_no UNIQUE (report_id, line_no),
  CONSTRAINT cms_return_close_report_lines_report_fk FOREIGN KEY (report_id, program_id)
    REFERENCES public.cms_return_close_reports (id, program_id),
  CONSTRAINT cms_return_close_report_lines_math CHECK (
    delta = recomputed_amount - frozen_amount AND eligible_base = frozen_base - return_base AND net_gmv = frozen_gmv - return_gmv
    AND (return_events = 0) = (return_base = 0))
);
-- Sự kiện báo cáo: mọi phiếu EFFECTIVE của snapshot + disposition DB suy từ dòng chốt; APPLIED gắn nhóm (FK tới dòng báo cáo).
CREATE TABLE public.cms_return_close_report_events (
  report_id              uuid        NOT NULL,
  program_id             uuid        NOT NULL,
  return_event_id        text        NOT NULL CHECK (return_event_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  financial_fp           text        NOT NULL CHECK (financial_fp ~ '^[0-9a-f]{64}$'),
  original_order_line_id text        NOT NULL,
  disposition            text        NOT NULL CHECK (disposition IN ('APPLIED', 'ORIGIN_NOT_ELIGIBLE', 'ORIGIN_OUT_OF_WINDOW',
                                                                     'ORIGIN_NOT_IN_PROGRAM', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE')),
  user_id                uuid,
  program_product_id     uuid,
  base                   numeric     NOT NULL CHECK (base > 0 AND scale(base) = 0),
  refund                 numeric     NOT NULL CHECK (refund >= 0),
  recorded_at            timestamptz NOT NULL CHECK (isfinite(recorded_at)),
  PRIMARY KEY (report_id, return_event_id),
  CONSTRAINT cms_return_close_report_events_report_fk FOREIGN KEY (report_id, program_id)
    REFERENCES public.cms_return_close_reports (id, program_id),
  CONSTRAINT cms_return_close_report_events_line_fk FOREIGN KEY (report_id, user_id, program_product_id)
    REFERENCES public.cms_return_close_report_lines (report_id, user_id, program_product_id),
  CONSTRAINT cms_return_close_report_events_group CHECK (
    (disposition = 'APPLIED') = (user_id IS NOT NULL AND program_product_id IS NOT NULL) AND (user_id IS NULL) = (program_product_id IS NULL))
);
-- Keyset reader sự kiện báo cáo theo byte (COLLATE "C") — db-reviewer 14/11 P2-6.
CREATE INDEX cms_return_close_report_events_key_idx ON public.cms_return_close_report_events (report_id, return_event_id COLLATE "C");

-- Run net ghi số eval của mình; FK bốn cột ⇒ eval đúng chương trình + đúng run + phán quyết trên run = phán quyết eval (db-reviewer
-- 14/11 P2-1).
ALTER TABLE public.cms_sync_runs ADD CONSTRAINT cms_sync_runs_ledger_eval_fk
  FOREIGN KEY (program_id, ledger_eval_seq, id, ledger_verdict) REFERENCES public.cms_return_ledger_evals (program_id, eval_seq, run_id, verdict);

-- Phiếu đã nhận (baseline tài chính bất biến — D14). Một sổ receipt: nhận trước chốt (accepted_run_id) XOR sau chốt
-- (accepted_report_id); PK (chương trình, phiếu) ⇒ một phiếu chỉ có một baseline / một số tiền. fp do DB tính lại ở CHECK (r2.1 §14.3:
-- vế hàm NULL ⇒ CHECK sai, không lọt). Không cột trạng thái / email / user / store.
CREATE TABLE public.cms_return_baselines (
  program_id             uuid        NOT NULL,
  return_event_id        text        NOT NULL CHECK (return_event_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  fp_version             text        NOT NULL CHECK (fp_version = 'cms-return-fp-v1'),
  financial_fp           text        NOT NULL CHECK (financial_fp ~ '^[0-9a-f]{64}$'),
  return_document_id     text        NOT NULL CHECK (return_document_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  original_order_line_id text        NOT NULL CHECK (original_order_line_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  original_order_id      text        NOT NULL CHECK (original_order_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  product_id             text        NOT NULL CHECK (product_id ~ '^[1-9][0-9]{0,18}$'),
  base_quantity          numeric     NOT NULL CHECK (base_quantity > 0 AND scale(base_quantity) = 0 AND base_quantity < 1e29),
  refund_amount          numeric     NOT NULL CHECK (refund_amount >= 0 AND scale(refund_amount) <= 9 AND refund_amount < 1e20),
  recorded_at            timestamptz NOT NULL CHECK (isfinite(recorded_at)),
  accepted_eval_seq      bigint      NOT NULL,
  accepted_run_id        uuid,
  accepted_report_id     uuid,
  accepted_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, return_event_id),
  CONSTRAINT cms_return_baselines_accepted CHECK ((accepted_run_id IS NULL) <> (accepted_report_id IS NULL)),
  CONSTRAINT cms_return_baselines_fp CHECK (COALESCE(
    financial_fp = public.cms__return_fp(fp_version, program_id, return_event_id, return_document_id, original_order_line_id,
                                         original_order_id, product_id, base_quantity, refund_amount, recorded_at), false)),
  CONSTRAINT cms_return_baselines_eval_fk FOREIGN KEY (program_id, accepted_eval_seq)
    REFERENCES public.cms_return_ledger_evals (program_id, eval_seq),
  CONSTRAINT cms_return_baselines_run_eval_fk FOREIGN KEY (program_id, accepted_eval_seq, accepted_run_id)
    REFERENCES public.cms_return_ledger_evals (program_id, eval_seq, run_id),
  CONSTRAINT cms_return_baselines_report_eval_fk FOREIGN KEY (program_id, accepted_eval_seq, accepted_report_id)
    REFERENCES public.cms_return_ledger_evals (program_id, eval_seq, report_attempt),
  CONSTRAINT cms_return_baselines_run_fk FOREIGN KEY (accepted_run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id),
  CONSTRAINT cms_return_baselines_report_fk FOREIGN KEY (accepted_report_id, program_id)
    REFERENCES public.cms_return_close_reports (id, program_id)
);

-- Conflict: tối đa MỘT conflict mở / phiếu bằng ràng buộc DB (r2 §6.2): conflict đầu prev NULL (UNIQUE NULLS NOT DISTINCT chỉ cho một);
-- conflict sau trỏ conflict trước ĐÃ phục hồi (FK tới bảng liên kết phục hồi) và mỗi conflict trước chỉ có một kế tiếp (UNIQUE).
-- Mở = chưa có dòng ở cms_return_conflict_restorations. Mở bởi eval (run hoặc báo cáo) — không trỏ run.
CREATE TABLE public.cms_return_conflicts (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  program_id       uuid        NOT NULL,
  return_event_id  text        NOT NULL,
  prev_conflict_id bigint,
  opened_kind      text        NOT NULL CHECK (opened_kind IN ('MISSING', 'CHANGED', 'NOT_EFFECTIVE')),
  opened_eval_seq  bigint      NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cms_return_conflicts_prog UNIQUE (id, program_id),
  CONSTRAINT cms_return_conflicts_bind UNIQUE (id, program_id, return_event_id),
  CONSTRAINT cms_return_conflicts_chain UNIQUE NULLS NOT DISTINCT (program_id, return_event_id, prev_conflict_id),
  CONSTRAINT cms_return_conflicts_prev CHECK (prev_conflict_id IS NULL OR prev_conflict_id < id),
  CONSTRAINT cms_return_conflicts_baseline_fk FOREIGN KEY (program_id, return_event_id)
    REFERENCES public.cms_return_baselines (program_id, return_event_id),
  CONSTRAINT cms_return_conflicts_eval_fk FOREIGN KEY (program_id, opened_eval_seq)
    REFERENCES public.cms_return_ledger_evals (program_id, eval_seq)
);

-- Xác nhận phục hồi theo chương trình (super, proof = eval OPEN_CONFLICT_MATCH MỚI NHẤT). Không đổi tiền / fp / baseline / pointer.
CREATE TABLE public.cms_return_restorations (
  id              uuid        PRIMARY KEY,
  program_id      uuid        NOT NULL,
  proof_eval_seq  bigint      NOT NULL,
  open_set_hash   text        NOT NULL CHECK (open_set_hash ~ '^[0-9a-f]{64}$'),
  ledger_set_hash text        NOT NULL CHECK (ledger_set_hash ~ '^[0-9a-f]{64}$'),
  conflicts       integer     NOT NULL CHECK (conflicts >= 1),
  reason          text        NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 1000 AND reason = btrim(reason, E' \t\r\n\f\v')),
  confirmed_by    uuid        NOT NULL,
  confirmed_at    timestamptz NOT NULL DEFAULT now(),
  idem_key        uuid        NOT NULL,
  CONSTRAINT cms_return_restorations_idem UNIQUE (idem_key),
  CONSTRAINT cms_return_restorations_proof UNIQUE (program_id, proof_eval_seq),
  CONSTRAINT cms_return_restorations_bind UNIQUE (id, program_id),
  CONSTRAINT cms_return_restorations_eval_fk FOREIGN KEY (program_id, proof_eval_seq)
    REFERENCES public.cms_return_ledger_evals (program_id, eval_seq)
);

CREATE TABLE public.cms_return_conflict_restorations (
  conflict_id     bigint      PRIMARY KEY,
  restoration_id  uuid        NOT NULL,
  program_id      uuid        NOT NULL,
  return_event_id text        NOT NULL,
  CONSTRAINT cms_return_conflict_restorations_chain UNIQUE (conflict_id, program_id, return_event_id),
  CONSTRAINT cms_return_conflict_restorations_conflict_fk FOREIGN KEY (conflict_id, program_id, return_event_id)
    REFERENCES public.cms_return_conflicts (id, program_id, return_event_id),
  CONSTRAINT cms_return_conflict_restorations_restoration_fk FOREIGN KEY (restoration_id, program_id)
    REFERENCES public.cms_return_restorations (id, program_id)
);
CREATE INDEX cms_return_conflict_restorations_rest_idx ON public.cms_return_conflict_restorations (restoration_id);
ALTER TABLE public.cms_return_conflicts ADD CONSTRAINT cms_return_conflicts_prev_fk FOREIGN KEY (prev_conflict_id, program_id, return_event_id)
  REFERENCES public.cms_return_conflict_restorations (conflict_id, program_id, return_event_id);

-- Observation: version 1 lúc mở; sau đó CHỈ khi (phán quyết, fp quan sát) đổi so với observation mới nhất (r2 P1-11). Tối đa một
-- observation / conflict / eval. MATCH ⇔ fp quan sát = fp baseline (trigger); MISSING / NOT_EFFECTIVE không có fp.
CREATE TABLE public.cms_return_conflict_observations (
  conflict_id  bigint      NOT NULL,
  version      integer     NOT NULL CHECK (version >= 1),
  program_id   uuid        NOT NULL,
  eval_seq     bigint      NOT NULL,
  verdict      text        NOT NULL CHECK (verdict IN ('MISSING', 'CHANGED', 'NOT_EFFECTIVE', 'MATCH')),
  observed_fp  text        CHECK (observed_fp IS NULL OR observed_fp ~ '^[0-9a-f]{64}$'),
  observed     jsonb       NOT NULL CHECK (jsonb_typeof(observed) = 'object'),
  observed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conflict_id, version),
  CONSTRAINT cms_return_conflict_obs_eval UNIQUE (conflict_id, eval_seq),
  CONSTRAINT cms_return_conflict_obs_fp CHECK ((verdict IN ('CHANGED', 'MATCH')) = (observed_fp IS NOT NULL)),
  CONSTRAINT cms_return_conflict_obs_conflict_fk FOREIGN KEY (conflict_id, program_id) REFERENCES public.cms_return_conflicts (id, program_id),
  CONSTRAINT cms_return_conflict_obs_eval_fk FOREIGN KEY (program_id, eval_seq) REFERENCES public.cms_return_ledger_evals (program_id, eval_seq)
);

ALTER TABLE public.cms_return_close_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_close_report_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_close_report_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_ledger_evals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_restorations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_conflict_restorations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_return_conflict_observations ENABLE ROW LEVEL SECURITY;

-- Hash tập baseline (cms-ledger-set-v1): ID sắp theo byte (COLLATE "C"), mỗi dòng `<ID> <fp>` — ID không chứa ký tự điều khiển (CHECK),
-- fp cố định 64 hex ở cuối ⇒ không mơ hồ. Tập rỗng vẫn có hash.
CREATE FUNCTION public.cms__ledger_set_hash(p_program_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT encode(sha256(convert_to('cms-ledger-set-v1' || E'\n' || count(*)::text || E'\n'
           || COALESCE(string_agg(b.return_event_id || ' ' || b.financial_fp, E'\n' ORDER BY b.return_event_id COLLATE "C"), ''),
           'UTF8')), 'hex')
    FROM public.cms_return_baselines b
   WHERE b.program_id = p_program_id
$$;

-- Hash tập conflict mở (cms-open-set-v1): mỗi conflict mở `<ID phiếu> <eval mở> <version observation mới nhất>`, sắp byte theo ID phiếu
-- (tối đa một conflict mở / phiếu). Tính được TRƯỚC khi ghi (không dùng id identity) ⇒ eval ghi hash trước conflict / observation.
CREATE FUNCTION public.cms__open_set_hash(p_program_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT encode(sha256(convert_to('cms-open-set-v1' || E'\n' || count(*)::text || E'\n'
           || COALESCE(string_agg(c.return_event_id || ' ' || c.opened_eval_seq::text || ' ' || o.version::text, E'\n'
                                  ORDER BY c.return_event_id COLLATE "C"), ''),
           'UTF8')), 'hex')
    FROM public.cms_return_conflicts c
    LEFT JOIN LATERAL (SELECT max(x.version) AS version FROM public.cms_return_conflict_observations x WHERE x.conflict_id = c.id) o ON true
   WHERE c.program_id = p_program_id
     AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations r WHERE r.conflict_id = c.id)
$$;

-- Bất biến: không UPDATE / DELETE / TRUNCATE (áp cả owner — ENABLE ALWAYS). Rollback 130 chỉ DROP khi các bảng rỗng (rb-head).
-- Sàn as_of của chương trình (RET2-R2-01, db-reviewer 14/11 P1-1): mốc mới nhất DB từng THẤY — eval trước, mốc ghi nhận baseline, và
-- as_of của MỌI run net contract đã khai seal (seal_expect.pin.as_of / returns_as_of), kể cả run held / error trước khi kịp ghi eval
-- (mapping / cấu hình / cổng đổi, seal N2 lỗi, finish error). Snapshot cũ hơn không được làm eval / proof / baseline.
CREATE FUNCTION public.cms__as_of_floor(p_program_id uuid)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT GREATEST(
    (SELECT max(e.returns_as_of) FROM public.cms_return_ledger_evals e WHERE e.program_id = p_program_id),
    (SELECT max(b.recorded_at) FROM public.cms_return_baselines b WHERE b.program_id = p_program_id),
    (SELECT max(GREATEST(r.returns_as_of, (r.seal_expect -> 'pin' ->> 'as_of')::timestamptz))
       FROM public.cms_sync_runs r
      WHERE r.program_id = p_program_id AND r.kind = 'sales' AND r.calc_contract_version IS NOT NULL
        AND r.returns_policy = 'net_returns_v1' AND (r.returns_as_of IS NOT NULL OR r.seal_expect IS NOT NULL)));
$$;

CREATE FUNCTION public.cms__ledger_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'CMS_LEDGER_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$;

-- Eval: thứ tự toàn phần dưới khoá chương trình (r2.1 §14.1) — eval_seq = max + 1; as_of không lùi; config = chương trình; hash tập
-- baseline = trạng thái lúc ghi; eval kind run gắn đúng run net đang chạy đã seal 13 bước (as_of + digest = run); kind report chỉ ở
-- chương trình đã chốt. Áp cả owner ghi thẳng.
CREATE FUNCTION public.cms__ledger_eval_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog  public.cms_programs%ROWTYPE;
  v_seq   bigint;
  v_floor timestamptz;
  v_open  integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = NEW.program_id FOR UPDATE;
  SELECT max(e.eval_seq) INTO v_seq FROM public.cms_return_ledger_evals e WHERE e.program_id = NEW.program_id;
  v_floor := public.cms__as_of_floor(NEW.program_id);
  IF NEW.eval_seq IS DISTINCT FROM COALESCE(v_seq, 0) + 1 OR COALESCE(NEW.returns_as_of < v_floor, false) THEN
    RAISE EXCEPTION 'CMS_LEDGER_EVAL_ORDER' USING ERRCODE = 'P0001';
  END IF;
  -- Phán quyết khớp sổ hiện tại (db-reviewer 14/11 P2-1): CLEAN ⇔ không conflict mở; OPEN_CONFLICT_MATCH giữ đúng số conflict mở;
  -- MISMATCH chỉ mở thêm (không đóng).
  SELECT count(*)::integer INTO v_open FROM public.cms_return_conflicts c
   WHERE c.program_id = NEW.program_id AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id);
  IF (NEW.verdict = 'CLEAN' AND v_open <> 0) OR (NEW.verdict = 'OPEN_CONFLICT_MATCH' AND NEW.open_conflicts <> v_open)
     OR (NEW.verdict = 'MISMATCH' AND NEW.open_conflicts < v_open) THEN
    RAISE EXCEPTION 'CMS_LEDGER_EVAL_VERDICT' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.config_version IS DISTINCT FROM v_prog.config_version
     OR NEW.ledger_set_hash IS DISTINCT FROM public.cms__ledger_set_hash(NEW.program_id)
     OR NEW.baselines IS DISTINCT FROM (SELECT count(*)::integer FROM public.cms_return_baselines b WHERE b.program_id = NEW.program_id)
     OR (NEW.kind = 'run' AND NOT EXISTS (
           SELECT 1 FROM public.cms_sync_runs r
            WHERE r.id = NEW.run_id AND r.program_id = NEW.program_id AND r.kind = 'sales' AND r.status = 'running'
              AND r.sealed_at IS NOT NULL AND r.seal_step = 13 AND r.returns_policy = 'net_returns_v1'
              AND r.returns_as_of = NEW.returns_as_of AND r.returns_digest = NEW.returns_digest AND r.config_version = NEW.config_version))
     OR (NEW.kind = 'report' AND v_prog.status IS DISTINCT FROM 'locked') THEN
    RAISE EXCEPTION 'CMS_LEDGER_EVAL_BIND' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- Ghi baseline / conflict / observation / phục hồi: kiểm theo LỆNH (bảng chuyển tiếp) sau khi khoá các chương trình liên quan. Baseline /
-- conflict / observation / header báo cáo chỉ trong CÙNG transaction với eval của chúng (evaluated_at = now() — db-reviewer 14/11 P2-2).
CREATE FUNCTION public.cms__ledger_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bad boolean;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  PERFORM 1 FROM public.cms_programs p WHERE p.id IN (SELECT n.program_id FROM cms_new n) ORDER BY p.id FOR UPDATE;
  -- Bảng chuyển tiếp cms_new có thể hàng chục nghìn dòng: mọi tra bảng khác từ cms_new là probe PK TỪNG dòng (LATERAL … LIMIT 1 — không
  -- kéo lên thành join; bench 14/11 r4b: JOIN thường ở nhánh observation ⇒ Merge Join + Nested Loop join filter 360.981.000 lần, 75,4 s).
  IF TG_TABLE_NAME = 'cms_return_baselines' THEN
    -- Chỉ nhận ngay sau eval CLEAN MỚI NHẤT của chương trình (cùng lượt publish / báo cáo); ghi nhận ≤ as_of của eval đó.
    v_bad := EXISTS (
      SELECT 1 FROM cms_new n
        LEFT JOIN LATERAL (SELECT e0.verdict, e0.returns_as_of, e0.evaluated_at FROM public.cms_return_ledger_evals e0
                            WHERE e0.program_id = n.program_id AND e0.eval_seq = n.accepted_eval_seq LIMIT 1) e ON true
       WHERE e.verdict IS DISTINCT FROM 'CLEAN' OR n.recorded_at > e.returns_as_of OR e.evaluated_at IS DISTINCT FROM now()
          OR n.accepted_eval_seq IS DISTINCT FROM (SELECT max(x.eval_seq) FROM public.cms_return_ledger_evals x WHERE x.program_id = n.program_id));
  ELSIF TG_TABLE_NAME = 'cms_return_conflicts' THEN
    -- Chỉ mở bởi eval MISMATCH mới nhất.
    v_bad := EXISTS (
      SELECT 1 FROM cms_new n
        LEFT JOIN LATERAL (SELECT e0.verdict, e0.evaluated_at FROM public.cms_return_ledger_evals e0
                            WHERE e0.program_id = n.program_id AND e0.eval_seq = n.opened_eval_seq LIMIT 1) e ON true
       WHERE e.verdict IS DISTINCT FROM 'MISMATCH' OR e.evaluated_at IS DISTINCT FROM now()
          OR n.opened_eval_seq IS DISTINCT FROM (SELECT max(x.eval_seq) FROM public.cms_return_ledger_evals x WHERE x.program_id = n.program_id));
  ELSIF TG_TABLE_NAME = 'cms_return_conflict_observations' THEN
    -- Thuộc eval mới nhất (MISMATCH / OPEN_CONFLICT_MATCH; lượt OPEN_CONFLICT_MATCH chỉ có MATCH); conflict còn mở; version liên tục
    -- (= số observation của conflict); v1 ⇔ eval mở conflict và phán quyết = loại mở; MATCH ⇔ fp quan sát = fp baseline.
    v_bad := EXISTS (
      SELECT 1 FROM cms_new n
        CROSS JOIN LATERAL (SELECT c0.program_id, c0.return_event_id, c0.opened_eval_seq, c0.opened_kind
                              FROM public.cms_return_conflicts c0 WHERE c0.id = n.conflict_id LIMIT 1) c
        CROSS JOIN LATERAL (SELECT b0.financial_fp FROM public.cms_return_baselines b0
                             WHERE b0.program_id = c.program_id AND b0.return_event_id = c.return_event_id LIMIT 1) b
        LEFT JOIN LATERAL (SELECT e0.verdict, e0.evaluated_at FROM public.cms_return_ledger_evals e0
                            WHERE e0.program_id = n.program_id AND e0.eval_seq = n.eval_seq LIMIT 1) e ON true
       WHERE COALESCE(e.verdict NOT IN ('MISMATCH', 'OPEN_CONFLICT_MATCH'), true) OR e.evaluated_at IS DISTINCT FROM now()
          OR (e.verdict = 'OPEN_CONFLICT_MATCH' AND n.verdict <> 'MATCH')
          OR n.eval_seq IS DISTINCT FROM (SELECT max(x.eval_seq) FROM public.cms_return_ledger_evals x WHERE x.program_id = n.program_id)
          OR EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations r WHERE r.conflict_id = n.conflict_id)
          OR (n.version = 1) IS DISTINCT FROM (n.eval_seq = c.opened_eval_seq)
          OR (n.version = 1 AND n.verdict IS DISTINCT FROM c.opened_kind)
          OR n.version IS DISTINCT FROM (SELECT count(*)::integer FROM public.cms_return_conflict_observations x WHERE x.conflict_id = n.conflict_id)
          OR (n.verdict = 'MATCH') IS DISTINCT FROM (n.observed_fp IS NOT DISTINCT FROM b.financial_fp))
      OR EXISTS (SELECT 1 FROM cms_new n WHERE NOT EXISTS (SELECT 1 FROM public.cms_return_conflicts c WHERE c.id = n.conflict_id));
  ELSIF TG_TABLE_NAME = 'cms_return_restorations' THEN
    -- Proof = eval OPEN_CONFLICT_MATCH MỚI NHẤT; hash / số conflict / config của proof = hiện tại; một phục hồi / chương trình / lệnh.
    v_bad := EXISTS (
      SELECT 1 FROM cms_new n
        LEFT JOIN public.cms_return_ledger_evals e ON e.program_id = n.program_id AND e.eval_seq = n.proof_eval_seq
        JOIN public.cms_programs p ON p.id = n.program_id
       WHERE e.verdict IS DISTINCT FROM 'OPEN_CONFLICT_MATCH'
          OR n.proof_eval_seq IS DISTINCT FROM (SELECT max(x.eval_seq) FROM public.cms_return_ledger_evals x WHERE x.program_id = n.program_id)
          OR n.open_set_hash IS DISTINCT FROM e.open_set_hash OR n.ledger_set_hash IS DISTINCT FROM e.ledger_set_hash
          OR n.open_set_hash IS DISTINCT FROM public.cms__open_set_hash(n.program_id)
          OR n.ledger_set_hash IS DISTINCT FROM public.cms__ledger_set_hash(n.program_id)
          OR n.conflicts IS DISTINCT FROM e.open_conflicts OR p.config_version IS DISTINCT FROM e.config_version)
      OR (SELECT count(*) FROM cms_new) <> (SELECT count(DISTINCT n.program_id) FROM cms_new n);
  ELSIF TG_TABLE_NAME = 'cms_return_conflict_restorations' THEN
    -- Đóng MỌI conflict mở của chương trình trong cùng lệnh, chỉ khi proof vẫn là eval mới nhất và observation mới nhất của từng
    -- conflict là MATCH. Đếm liên kết / eval mới nhất tính MỘT lần mỗi phục hồi (db-reviewer 14/11 P1-2: subquery tương quan từng dòng
    -- ⇒ O(N²) khi confirm hàng chục nghìn conflict).
    v_bad := EXISTS (
      WITH rs AS (
        SELECT r.id, r.conflicts, r.proof_eval_seq,
               (SELECT max(x.eval_seq) FROM public.cms_return_ledger_evals x WHERE x.program_id = r.program_id) AS latest
          FROM public.cms_return_restorations r WHERE r.id IN (SELECT n.restoration_id FROM cms_new n)
      ), k AS (
        SELECT x.restoration_id, count(*) AS c FROM public.cms_return_conflict_restorations x
         WHERE x.restoration_id IN (SELECT rs.id FROM rs) GROUP BY x.restoration_id
      )
      SELECT 1 FROM rs LEFT JOIN k ON k.restoration_id = rs.id
       WHERE rs.proof_eval_seq IS DISTINCT FROM rs.latest OR COALESCE(k.c, 0) IS DISTINCT FROM rs.conflicts::bigint)
      OR EXISTS (SELECT 1 FROM cms_new n WHERE NOT EXISTS (SELECT 1 FROM public.cms_return_restorations r WHERE r.id = n.restoration_id))
      OR EXISTS (
      SELECT 1 FROM cms_new n
        LEFT JOIN LATERAL (SELECT o.verdict FROM public.cms_return_conflict_observations o WHERE o.conflict_id = n.conflict_id
                            ORDER BY o.version DESC LIMIT 1) lo ON true
       WHERE lo.verdict IS DISTINCT FROM 'MATCH')
      OR EXISTS (
      SELECT 1 FROM public.cms_return_conflicts c
       WHERE c.program_id IN (SELECT n.program_id FROM cms_new n)
         AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id));
  ELSIF TG_TABLE_NAME = 'cms_return_close_reports' THEN
    -- Header chỉ ngay sau eval kind report CLEAN MỚI NHẤT của chính lượt (report_attempt = id), cùng as_of / digest; chương trình đã chốt.
    v_bad := EXISTS (
      SELECT 1 FROM cms_new n
        LEFT JOIN public.cms_return_ledger_evals e ON e.program_id = n.program_id AND e.eval_seq = n.eval_seq
        JOIN public.cms_programs p ON p.id = n.program_id
       WHERE e.verdict IS DISTINCT FROM 'CLEAN' OR e.kind IS DISTINCT FROM 'report' OR e.report_attempt IS DISTINCT FROM n.id
          OR e.evaluated_at IS DISTINCT FROM now()
          OR e.returns_as_of IS DISTINCT FROM n.returns_as_of OR e.returns_digest IS DISTINCT FROM n.returns_digest
          OR n.eval_seq IS DISTINCT FROM (SELECT max(x.eval_seq) FROM public.cms_return_ledger_evals x WHERE x.program_id = n.program_id)
          OR p.status IS DISTINCT FROM 'locked');
  ELSIF TG_TABLE_NAME IN ('cms_return_close_report_lines', 'cms_return_close_report_events') THEN
    -- Dòng / sự kiện của MỘT báo cáo ghi trong ĐÚNG MỘT câu lệnh, cùng lượt tạo (eval của báo cáo vẫn mới nhất): số dòng câu lệnh = số
    -- header khai (line_count / return_events) = số dòng bảng đang có ⇒ không thêm được về sau, kể cả vào báo cáo mới nhất.
    v_bad := EXISTS (
      SELECT 1 FROM (SELECT n.report_id, count(*) AS k FROM cms_new n GROUP BY n.report_id) g
        LEFT JOIN public.cms_return_close_reports r ON r.id = g.report_id
       WHERE r.id IS NULL
          OR r.eval_seq IS DISTINCT FROM (SELECT max(x.eval_seq) FROM public.cms_return_ledger_evals x WHERE x.program_id = r.program_id)
          OR g.k IS DISTINCT FROM (CASE TG_TABLE_NAME WHEN 'cms_return_close_report_lines' THEN r.line_count ELSE r.return_events END)::bigint
          OR g.k IS DISTINCT FROM (CASE TG_TABLE_NAME
                                     WHEN 'cms_return_close_report_lines'
                                       THEN (SELECT count(*) FROM public.cms_return_close_report_lines l WHERE l.report_id = g.report_id)
                                     ELSE (SELECT count(*) FROM public.cms_return_close_report_events e WHERE e.report_id = g.report_id) END));
  ELSE
    RAISE EXCEPTION 'CMS_LEDGER_GUARD_TABLE' USING ERRCODE = 'P0001';
  END IF;
  IF v_bad IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'CMS_LEDGER_INSERT_GUARD' USING ERRCODE = 'P0001', DETAIL = TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_close_reports
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_close_reports
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_close_reports REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_close_report_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_close_report_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_close_report_lines REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_close_report_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_close_report_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_close_report_events REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_ledger_evals
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_ledger_evals
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_eval_guard BEFORE INSERT ON public.cms_return_ledger_evals
  FOR EACH ROW EXECUTE FUNCTION public.cms__ledger_eval_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_baselines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_baselines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_baselines REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_conflicts
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_conflicts
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_conflicts REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_restorations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_restorations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_restorations REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_conflict_restorations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_conflict_restorations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_conflict_restorations REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_conflict_observations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.cms_return_conflict_observations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_immutable();
CREATE TRIGGER cms_ledger_insert_guard AFTER INSERT ON public.cms_return_conflict_observations REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__ledger_insert_guard();
DO $$
DECLARE
  r record;
  v_n integer;
BEGIN
  FOR r IN
    SELECT c.relname, t.tgname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
       AND c.relname IN ('cms_return_close_reports', 'cms_return_close_report_lines', 'cms_return_close_report_events',
                         'cms_return_ledger_evals', 'cms_return_baselines', 'cms_return_conflicts',
                         'cms_return_restorations', 'cms_return_conflict_restorations', 'cms_return_conflict_observations')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', r.relname, r.tgname);
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgenabled = 'A'
     AND c.relname IN ('cms_return_close_reports', 'cms_return_close_report_lines', 'cms_return_close_report_events',
                         'cms_return_ledger_evals', 'cms_return_baselines', 'cms_return_conflicts',
                       'cms_return_restorations', 'cms_return_conflict_restorations', 'cms_return_conflict_observations');
  IF v_n <> 27 THEN RAISE EXCEPTION '130: trigger ledger phải đủ 27 và ENABLE ALWAYS, có %', v_n; END IF;
END $$;

-- ── Đánh giá ledger (dùng chung publish run net + kiểm báo cáo sau chốt) ──
-- p_obs: mảng quan sát CHỈ của các phiếu có baseline (người gọi join): {id, status, effect, fp (DB tính, NULL khi không hiệu lực),
-- base, refund, recorded_at}. Phán quyết từng baseline: MATCH (còn dòng EFFECTIVE cùng fp — bất kể disposition; fp gồm recorded_at,
-- mà recorded_at baseline ≤ sàn ≤ as_of ⇒ khớp fp kéo theo recorded_at ≤ as_of), NOT_EFFECTIVE, CHANGED, MISSING. Sàn as_of lùi ⇒
-- trả {code}, KHÔNG ghi. Còn lại ghi eval → conflict mới → observation khi đổi; hậu kiểm hash tập mở. Người gọi giữ khoá chương trình.
CREATE FUNCTION public.cms__ledger_eval(p_program_id uuid, p_kind text, p_ref uuid, p_as_of timestamptz, p_digest text, p_obs jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog    public.cms_programs%ROWTYPE;
  v_seq     bigint;
  v_floor   timestamptz;
  v_nb      integer;
  v_bad     integer;
  v_open    integer;
  v_nopen   integer;
  v_nobs    integer;
  v_verdict text;
  v_lhash   text;
  v_ohash   text;
  v_list    jsonb;
  v_map     jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  IF p_program_id IS NULL OR p_kind IS NULL OR p_kind NOT IN ('run', 'report') OR p_ref IS NULL OR p_as_of IS NULL
     OR NOT isfinite(p_as_of) OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_obs IS NULL OR jsonb_typeof(p_obs) <> 'array' THEN
    RAISE EXCEPTION 'CMS_LEDGER_EVAL_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- 1. Sàn as_of = cms__as_of_floor (eval trước + mốc ghi nhận baseline + as_of run net đã khai seal, kể cả run held / error trước eval).
  SELECT max(e.eval_seq) INTO v_seq FROM public.cms_return_ledger_evals e WHERE e.program_id = p_program_id;
  v_floor := public.cms__as_of_floor(p_program_id);
  IF COALESCE(p_as_of < v_floor, false) THEN
    RETURN jsonb_build_object('code', 'CMS_RETURN_AS_OF_REGRESSION');
  END IF;
  v_seq := COALESCE(v_seq, 0) + 1;
  IF (SELECT count(*) FROM jsonb_array_elements(p_obs)) <> (SELECT count(DISTINCT x ->> 'id') FROM jsonb_array_elements(p_obs) x)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_obs) x
                 WHERE jsonb_typeof(x) <> 'object' OR x ->> 'id' IS NULL
                    OR NOT EXISTS (SELECT 1 FROM public.cms_return_baselines b WHERE b.program_id = p_program_id AND b.return_event_id = x ->> 'id')) THEN
    RAISE EXCEPTION 'CMS_LEDGER_EVAL_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- 2. Phán quyết + kế hoạch ghi (một lần): dòng cần theo dõi = baseline lệch HOẶC đang có conflict mở.
  --    Kế hoạch không phụ thuộc thống kê (bench 14/11: baseline / conflict vừa ghi của chương trình chưa có trong thống kê ⇒ planner ước
  --    1 dòng ⇒ Nested Loop + Materialize bậc hai). Baseline → quan sát: tra map id → quan sát dựng MỘT lần (khoá jsonb, ID đã kiểm duy
  --    nhất ở trên); baseline → conflict mở: LATERAL probe theo (program_id, return_event_id) (cms_return_conflicts_chain; tối đa một
  --    conflict mở / phiếu — ràng buộc DB). Không viết lại thành JOIN.
  SELECT COALESCE(jsonb_object_agg(x ->> 'id', x), '{}'::jsonb) INTO v_map FROM jsonb_array_elements(p_obs) x;
  WITH bo AS (
    SELECT b.return_event_id AS id, b.financial_fp AS bfp, v_map -> b.return_event_id AS o
      FROM public.cms_return_baselines b
     WHERE b.program_id = p_program_id
  ), v AS (
    SELECT bo.id, bo.bfp,
           CASE WHEN bo.o IS NULL THEN 'MISSING'
                WHEN bo.o ->> 'effect' IS DISTINCT FROM 'EFFECTIVE' THEN 'NOT_EFFECTIVE'
                WHEN bo.o ->> 'fp' IS DISTINCT FROM bo.bfp THEN 'CHANGED'
                ELSE 'MATCH' END AS verdict,
           CASE WHEN bo.o IS NOT NULL AND bo.o ->> 'effect' = 'EFFECTIVE' THEN bo.o ->> 'fp' END AS fp,
           CASE WHEN bo.o IS NULL THEN '{}'::jsonb
                ELSE jsonb_strip_nulls(jsonb_build_object('status', bo.o ->> 'status', 'effect', bo.o ->> 'effect', 'base', bo.o ->> 'base',
                                                          'refund', bo.o ->> 'refund', 'recorded_at', bo.o ->> 'recorded_at')) END AS observed
      FROM bo
  ), l AS (
    SELECT v.id, v.verdict, v.fp, v.observed, oc.cid, oc.version,
           CASE WHEN oc.cid IS NULL THEN 'open'
                WHEN (v.verdict, v.fp) IS DISTINCT FROM (oc.lverdict, oc.lfp) THEN 'observe'
                ELSE 'same' END AS action,
           CASE WHEN oc.cid IS NULL THEN v_seq ELSE oc.opened_eval_seq END AS opened_seq,
           CASE WHEN oc.cid IS NULL THEN 1
                WHEN (v.verdict, v.fp) IS DISTINCT FROM (oc.lverdict, oc.lfp) THEN oc.version + 1
                ELSE oc.version END AS new_version
      FROM v
      LEFT JOIN LATERAL (
        SELECT c.id AS cid, c.opened_eval_seq, lo.version, lo.verdict AS lverdict, lo.observed_fp AS lfp
          FROM public.cms_return_conflicts c
          LEFT JOIN LATERAL (SELECT x.version, x.verdict, x.observed_fp FROM public.cms_return_conflict_observations x
                              WHERE x.conflict_id = c.id ORDER BY x.version DESC LIMIT 1) lo ON true
         WHERE c.program_id = p_program_id AND c.return_event_id = v.id
           AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations r WHERE r.conflict_id = c.id)
         ORDER BY c.id DESC LIMIT 1) oc ON true
     WHERE v.verdict <> 'MATCH' OR oc.cid IS NOT NULL
  )
  SELECT (SELECT count(*) FROM v), (SELECT count(*) FROM v WHERE v.verdict <> 'MATCH'), count(*),
         count(*) FILTER (WHERE l.action = 'open'), count(*) FILTER (WHERE l.action IN ('open', 'observe')),
         encode(sha256(convert_to('cms-open-set-v1' || E'\n' || count(*)::text || E'\n'
           || COALESCE(string_agg(l.id || ' ' || l.opened_seq::text || ' ' || l.new_version::text, E'\n' ORDER BY l.id COLLATE "C"), ''),
           'UTF8')), 'hex'),
         COALESCE(jsonb_agg(jsonb_build_object('id', l.id, 'verdict', l.verdict, 'fp', l.fp, 'observed', l.observed, 'cid', l.cid,
                                               'action', l.action, 'new_version', l.new_version))
                  FILTER (WHERE l.action IN ('open', 'observe')), '[]'::jsonb)
    INTO v_nb, v_bad, v_open, v_nopen, v_nobs, v_ohash, v_list
    FROM l;
  -- Conflict mở có thể đã "sạch" trước lượt này nhưng baseline vẫn phải nằm trong tập (FK) ⇒ v_open = số dòng l.
  v_verdict := CASE WHEN v_bad > 0 THEN 'MISMATCH' WHEN v_open > 0 THEN 'OPEN_CONFLICT_MATCH' ELSE 'CLEAN' END;
  v_lhash := public.cms__ledger_set_hash(p_program_id);
  -- 3. Eval trước (trigger kiểm thứ tự / sàn / gắn run), rồi conflict mới (prev = conflict gần nhất của phiếu — đã phục hồi; FK +
  --    UNIQUE NULLS NOT DISTINCT chặn mở chồng), rồi observation.
  INSERT INTO public.cms_return_ledger_evals (program_id, eval_seq, kind, run_id, report_attempt, returns_as_of, returns_digest, verdict,
    baselines, mismatched, open_conflicts, ledger_set_hash, open_set_hash, config_version)
  VALUES (p_program_id, v_seq, p_kind, CASE WHEN p_kind = 'run' THEN p_ref END, CASE WHEN p_kind = 'report' THEN p_ref END, p_as_of,
          p_digest, v_verdict, v_nb, v_bad, v_open, v_lhash, v_ohash, v_prog.config_version);
  IF v_nopen > 0 THEN
    INSERT INTO public.cms_return_conflicts (program_id, return_event_id, prev_conflict_id, opened_kind, opened_eval_seq)
    SELECT p_program_id, x.id,
           (SELECT max(c.id) FROM public.cms_return_conflicts c WHERE c.program_id = p_program_id AND c.return_event_id = x.id),
           x.verdict, v_seq
      FROM jsonb_to_recordset(v_list) AS x(id text, verdict text, action text)
     WHERE x.action = 'open';
  END IF;
  IF v_nobs > 0 THEN
    INSERT INTO public.cms_return_conflict_observations (conflict_id, version, program_id, eval_seq, verdict, observed_fp, observed)
    -- Conflict vừa mở của lượt: probe vô hướng (bench 14/11: LEFT JOIN với conflict vừa ghi ⇒ Materialize ước 1 dòng).
    SELECT COALESCE(x.cid, CASE WHEN x.action = 'open' THEN
             (SELECT c.id FROM public.cms_return_conflicts c
               WHERE c.program_id = p_program_id AND c.return_event_id = x.id AND c.opened_eval_seq = v_seq) END),
           x.new_version, p_program_id, v_seq, x.verdict, x.fp, x.observed
      FROM jsonb_to_recordset(v_list) AS x(id text, verdict text, fp text, observed jsonb, cid bigint, action text, new_version integer);
  END IF;
  -- 4. Hậu kiểm: hash tập mở tính lại từ bảng = hash đã ghi trên eval.
  IF public.cms__open_set_hash(p_program_id) IS DISTINCT FROM v_ohash THEN
    RAISE EXCEPTION 'CMS_LEDGER_ASSERT' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('eval_seq', v_seq, 'verdict', v_verdict, 'baselines', v_nb, 'mismatched', v_bad, 'open_conflicts', v_open,
                            'opened', v_nopen, 'observations', v_nobs, 'ledger_set_hash', v_lhash, 'open_set_hash', v_ohash);
END;
$$;

-- ── Publish atomic run contract (r2 §7) — gọi từ rpc_cms_sales_run_publish (đoạn chèn đầu thân 126) ──
-- Khoá chương trình → run (cùng thứ tự 126 / open / cleanup / chốt / confirm). Mã chặn chung ⇒ run held / error, không ghi gì khác.
-- Run net: đánh giá ledger dưới khoá (eval luôn ghi) ⇒ lệch / còn conflict mở ⇒ held, pointer giữ. Sạch ⇒ CÙNG transaction: baseline
-- mới (phiếu EFFECTIVE có tác động tiền: APPLIED / ORIGIN_UNASSIGNED / ORIGIN_OUT_OF_SCOPE) → run ok + đóng dấu căn cứ (cả run QA) →
-- pointer → hậu kiểm. KHÔNG có EXCEPTION handler (savepoint) trong hàm: lỗi / huỷ / timeout ⇒ rollback toàn bộ.
CREATE FUNCTION public.cms__publish_contract(p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pid   uuid;
  v_prog  public.cms_programs%ROWTYPE;
  v_run   public.cms_sync_runs%ROWTYPE;
  v_net   boolean;
  v_code  text;
  v_prev  uuid;
  v_obs   jsonb;
  v_ev    jsonb;
  v_seq   bigint;
  v_lhash text;
  v_nb0   bigint;
  v_new   bigint;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  SELECT program_id INTO v_pid FROM public.cms_sync_runs WHERE id = p_run_id AND kind = 'sales';
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_pid FOR UPDATE;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.calc_contract_version IS NULL THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_CONTRACT' USING ERRCODE = 'P0001'; END IF;
  IF v_run.status = 'ok' THEN
    RETURN jsonb_build_object('published', true, 'already', true, 'run_id', p_run_id,
                              'current', v_prog.current_result_run_id IS NOT DISTINCT FROM p_run_id);
  END IF;
  IF v_run.status <> 'running' THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001'; END IF;
  IF v_run.sealed_at IS NULL OR v_run.seal_step IS DISTINCT FROM 13 THEN RAISE EXCEPTION 'CMS_RESULT_NOT_SEALED' USING ERRCODE = 'P0001'; END IF;
  v_net := v_run.returns_policy = 'net_returns_v1';
  -- So sánh có thể NULL (chưa có eval / baseline) bọc COALESCE(…, false) ⇒ không chặn nhầm, không lọt nhầm.
  v_code := CASE
    WHEN v_run.started_at < now() - interval '30 minutes' THEN 'STALE'
    WHEN v_prog.status = 'locked' THEN 'PROGRAM_LOCKED'
    WHEN v_prog.status <> 'active' THEN 'PROGRAM_NOT_ACTIVE'
    WHEN v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN 'CONFIG_CHANGED'
    WHEN public.cms__mapping_fp() <> v_run.mapping_fp THEN 'MAPPING_CHANGED'
    WHEN NOT v_run.is_test AND NOT public.cms__results_release_open() THEN 'RESULTS_RELEASE_GATE'
    WHEN v_run.quantity_basis IS DISTINCT FROM v_prog.quantity_basis THEN 'CMS_BASIS_MISMATCH'
    -- Chương trình đã net / đã có sổ ⇒ run sales-only không được công bố (mọi baseline phải được kiểm ở mọi run).
    WHEN NOT v_net AND (v_prog.returns_policy IS DISTINCT FROM 'sales_only_v1'
                        OR EXISTS (SELECT 1 FROM public.cms_return_baselines b WHERE b.program_id = v_pid)
                        OR EXISTS (SELECT 1 FROM public.cms_return_ledger_evals e WHERE e.program_id = v_pid))
      THEN 'CMS_RETURNS_POLICY_REGRESSION'
    WHEN v_net AND v_prog.returns_policy IS DISTINCT FROM 'net_returns_v1' THEN 'CONFIG_CHANGED'
    WHEN v_net AND COALESCE(v_run.returns_as_of < public.cms__as_of_floor(v_pid), false) THEN 'CMS_RETURN_AS_OF_REGRESSION'
  END;
  IF v_code IS NOT NULL THEN
    UPDATE public.cms_sync_runs SET status = CASE WHEN v_code = 'STALE' THEN 'error' ELSE 'held' END,
           finished_at = now(), error_code = v_code
     WHERE id = p_run_id;
    RETURN jsonb_build_object('published', false, 'code', v_code, 'run_id', p_run_id);
  END IF;
  IF v_net THEN
    -- Quan sát cho MỌI baseline của chương trình: dòng phiếu của snapshot cùng ID (fp DB tính lại; chưa hiệu lực ⇒ không fp).
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', r.return_event_id, 'status', r.return_status, 'effect', r.status_effect,
             'fp', CASE WHEN r.status_effect = 'EFFECTIVE' THEN public.cms__return_fp('cms-return-fp-v1', v_pid, r.return_event_id,
                          r.return_document_id, r.original_order_line_id, r.original_order_id, r.product_id, r.return_base_quantity,
                          r.return_gmv_amount, r.recorded_at) END,
             'base', r.return_base_quantity::text, 'refund', r.return_gmv_amount::text,
             'recorded_at', CASE WHEN r.recorded_at IS NOT NULL THEN public.cms__ts(r.recorded_at) END)), '[]'::jsonb)
      INTO v_obs
      FROM public.cms_return_lines r
     -- Probe PK baseline từng dòng (truy vấn con vô hướng — không JOIN / EXISTS: thống kê cũ của chương trình ⇒ Nested Loop +
     -- Materialize bậc hai, bench 14/11).
     WHERE r.run_id = p_run_id
       AND (SELECT true FROM public.cms_return_baselines b WHERE b.program_id = v_pid AND b.return_event_id = r.return_event_id) IS NOT NULL;
    v_ev := public.cms__ledger_eval(v_pid, 'run', p_run_id, v_run.returns_as_of, v_run.returns_digest, v_obs);
    IF v_ev ? 'code' THEN
      UPDATE public.cms_sync_runs SET status = 'held', finished_at = now(), error_code = v_ev ->> 'code' WHERE id = p_run_id;
      RETURN jsonb_build_object('published', false, 'code', v_ev ->> 'code', 'run_id', p_run_id);
    END IF;
    v_seq := (v_ev ->> 'eval_seq')::bigint;
    v_lhash := v_ev ->> 'ledger_set_hash';
    UPDATE public.cms_sync_runs SET ledger_verdict = v_ev ->> 'verdict', ledger_set_hash = v_lhash, ledger_checked_at = now(),
           ledger_eval_seq = v_seq
     WHERE id = p_run_id;
    IF v_ev ->> 'verdict' <> 'CLEAN' THEN
      v_code := CASE v_ev ->> 'verdict' WHEN 'MISMATCH' THEN 'CMS_RETURN_LEDGER_CONFLICT' ELSE 'CMS_RETURN_CONFLICT_OPEN' END;
      UPDATE public.cms_sync_runs SET status = 'held', finished_at = now(), error_code = v_code WHERE id = p_run_id;
      RETURN jsonb_build_object('published', false, 'code', v_code, 'run_id', p_run_id, 'ledger', v_ev);
    END IF;
  ELSE
    v_lhash := public.cms__ledger_set_hash(v_pid);
  END IF;
  -- Sạch: baseline mới → run ok → pointer → hậu kiểm (RAISE ⇒ rollback cả baseline + trạng thái + pointer).
  SELECT count(*) INTO v_nb0 FROM public.cms_return_baselines WHERE program_id = v_pid;
  v_new := 0;
  IF v_net THEN
    INSERT INTO public.cms_return_baselines (program_id, return_event_id, fp_version, financial_fp, return_document_id,
      original_order_line_id, original_order_id, product_id, base_quantity, refund_amount, recorded_at, accepted_eval_seq, accepted_run_id)
    SELECT v_pid, r.return_event_id, 'cms-return-fp-v1',
           public.cms__return_fp('cms-return-fp-v1', v_pid, r.return_event_id, r.return_document_id, r.original_order_line_id,
                                 r.original_order_id, r.product_id, r.return_base_quantity, r.return_gmv_amount, r.recorded_at),
           r.return_document_id, r.original_order_line_id, r.original_order_id, r.product_id, r.return_base_quantity,
           r.return_gmv_amount, r.recorded_at, v_seq, p_run_id
      FROM public.cms_return_lines r
     WHERE r.run_id = p_run_id AND r.status_effect = 'EFFECTIVE'
       AND r.disposition IN ('APPLIED', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE')
       AND (SELECT true FROM public.cms_return_baselines b WHERE b.program_id = v_pid AND b.return_event_id = r.return_event_id) IS NULL;
    GET DIAGNOSTICS v_new = ROW_COUNT;
  END IF;
  v_prev := v_prog.current_result_run_id;
  UPDATE public.cms_sync_runs SET status = 'ok', finished_at = now(), published_at = now(),
         ledger_verdict = 'CLEAN', ledger_set_hash = v_lhash, ledger_checked_at = COALESCE(ledger_checked_at, now()),
         detail = detail || jsonb_build_object('results_basis', v_run.returns_policy, 'quantity_basis', v_run.quantity_basis)
   WHERE id = p_run_id;
  UPDATE public.cms_programs SET current_result_run_id = p_run_id WHERE id = v_pid;
  IF (SELECT count(*) FROM public.cms_return_baselines WHERE program_id = v_pid) IS DISTINCT FROM v_nb0 + v_new
     OR EXISTS (SELECT 1 FROM public.cms_return_conflicts c WHERE c.program_id = v_pid
                   AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id))
     OR (SELECT current_result_run_id FROM public.cms_programs WHERE id = v_pid) IS DISTINCT FROM p_run_id
     OR (v_net AND ((SELECT e.verdict FROM public.cms_return_ledger_evals e WHERE e.program_id = v_pid AND e.eval_seq = v_seq)
                      IS DISTINCT FROM 'CLEAN'
                    OR v_seq IS DISTINCT FROM (SELECT max(e.eval_seq) FROM public.cms_return_ledger_evals e WHERE e.program_id = v_pid))) THEN
    RAISE EXCEPTION 'CMS_PUBLISH_ASSERT' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('published', true, 'already', false, 'run_id', p_run_id, 'previous_run_id', v_prev,
                            'ledger_verdict', 'CLEAN', 'eval_seq', v_seq, 'baselines_new', v_new);
END;
$$;

-- ── Super xác nhận nguồn đã phục hồi đúng baseline (r2 §6.4 bước 4, r2.1 §14.1) ──
-- Authenticated, mẫu attest 124: auth.uid() + is_super_admin() + chương trình đọc được (QA cần marker). Khoá chương trình FOR UPDATE.
-- Proof = eval có eval_seq = max của chương trình (không lượt nào sau), verdict OPEN_CONFLICT_MATCH, as_of = sàn, hash tập mở / tập
-- baseline / config = hiện tại. Ghi một phục hồi + một liên kết / conflict mở; không đổi tiền / fp / baseline / pointer.
CREATE FUNCTION public.rpc_cms_return_conflicts_confirm_restored(p_program_id uuid, p_expected_open_set_hash text, p_proof_eval_seq bigint,
                                                                  p_reason text, p_idem uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_reason text;
  v_prog   public.cms_programs%ROWTYPE;
  v_old    public.cms_return_restorations%ROWTYPE;
  v_ev     public.cms_return_ledger_evals%ROWTYPE;
  v_max    bigint;
  v_floor  timestamptz;
  v_open   integer;
  v_ohash  text;
  v_id     uuid;
  v_n      integer;
  v_con    text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_super_admin()
     OR NOT COALESCE(p_program_id = ANY (public.cms_readable_program_ids()), false) THEN
    RAISE EXCEPTION 'CMS_RETURN_CONFIRM_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  v_reason := btrim(p_reason, E' \t\r\n\f\v');
  IF COALESCE(p_expected_open_set_hash IS NULL OR p_expected_open_set_hash !~ '^[0-9a-f]{64}$' OR p_proof_eval_seq IS NULL
     OR p_proof_eval_seq < 1 OR p_idem IS NULL OR v_reason IS NULL OR char_length(v_reason) NOT BETWEEN 10 AND 1000
     OR p_reason ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]', true) THEN
    RAISE EXCEPTION 'CMS_RETURN_CONFIRM_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- Idempotency sau khoá: cùng khoá + cùng (chương trình, proof, hash, lý do, người gọi) ⇒ already; khác ⇒ CMS_IDEM_REUSED.
  SELECT * INTO v_old FROM public.cms_return_restorations WHERE idem_key = p_idem;
  IF FOUND THEN
    IF v_old.program_id = p_program_id AND v_old.proof_eval_seq = p_proof_eval_seq AND v_old.open_set_hash = p_expected_open_set_hash
       AND v_old.reason = v_reason AND v_old.confirmed_by = v_uid THEN
      RETURN jsonb_build_object('confirmed', true, 'already', true, 'id', v_old.id, 'conflicts', v_old.conflicts,
                                'proof_eval_seq', v_old.proof_eval_seq);
    END IF;
    RAISE EXCEPTION 'CMS_IDEM_REUSED' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO v_open FROM public.cms_return_conflicts c
   WHERE c.program_id = p_program_id AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id);
  IF v_open = 0 THEN RAISE EXCEPTION 'CMS_RETURN_NO_OPEN_CONFLICT' USING ERRCODE = 'P0001'; END IF;
  v_ohash := public.cms__open_set_hash(p_program_id);
  IF v_ohash IS DISTINCT FROM p_expected_open_set_hash THEN
    RAISE EXCEPTION 'CMS_RETURN_OPEN_SET_STALE' USING ERRCODE = 'P0001';
  END IF;
  SELECT max(e.eval_seq) INTO v_max FROM public.cms_return_ledger_evals e WHERE e.program_id = p_program_id;
  v_floor := public.cms__as_of_floor(p_program_id);
  SELECT * INTO v_ev FROM public.cms_return_ledger_evals WHERE program_id = p_program_id AND eval_seq = p_proof_eval_seq;
  IF NOT FOUND OR p_proof_eval_seq IS DISTINCT FROM v_max THEN
    RAISE EXCEPTION 'CMS_RETURN_PROOF_NOT_LATEST' USING ERRCODE = 'P0001';
  END IF;
  IF v_ev.verdict <> 'OPEN_CONFLICT_MATCH'
     OR EXISTS (SELECT 1 FROM public.cms_return_conflicts c
                 WHERE c.program_id = p_program_id
                   AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id)
                   AND (SELECT o.verdict FROM public.cms_return_conflict_observations o WHERE o.conflict_id = c.id
                         ORDER BY o.version DESC LIMIT 1) IS DISTINCT FROM 'MATCH') THEN
    RAISE EXCEPTION 'CMS_RETURN_PROOF_NOT_MATCH' USING ERRCODE = 'P0001';
  END IF;
  IF v_ev.returns_as_of < v_floor OR v_ev.open_set_hash IS DISTINCT FROM v_ohash
     OR v_ev.ledger_set_hash IS DISTINCT FROM public.cms__ledger_set_hash(p_program_id)
     OR v_ev.config_version IS DISTINCT FROM v_prog.config_version OR v_ev.open_conflicts IS DISTINCT FROM v_open THEN
    RAISE EXCEPTION 'CMS_RETURN_PROOF_STALE' USING ERRCODE = 'P0001';
  END IF;
  v_id := gen_random_uuid();
  BEGIN
    INSERT INTO public.cms_return_restorations (id, program_id, proof_eval_seq, open_set_hash, ledger_set_hash, conflicts, reason,
                                                confirmed_by, idem_key)
    VALUES (v_id, p_program_id, p_proof_eval_seq, v_ohash, v_ev.ledger_set_hash, v_open, v_reason, v_uid, p_idem);
  EXCEPTION WHEN unique_violation THEN
    -- Cùng khoá idem đang dùng song song cho chương trình khác (khoá chương trình khác nhau) ⇒ chờ rồi vi phạm unique.
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    IF v_con = 'cms_return_restorations_idem' THEN RAISE EXCEPTION 'CMS_IDEM_REUSED' USING ERRCODE = 'P0001'; END IF;
    RAISE;
  END;
  INSERT INTO public.cms_return_conflict_restorations (conflict_id, restoration_id, program_id, return_event_id)
  SELECT c.id, v_id, c.program_id, c.return_event_id
    FROM public.cms_return_conflicts c
   WHERE c.program_id = p_program_id
     AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_open THEN RAISE EXCEPTION 'CMS_LEDGER_ASSERT' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('confirmed', true, 'already', false, 'id', v_id, 'conflicts', v_open, 'proof_eval_seq', p_proof_eval_seq);
END;
$$;

-- ── 8b. Reader v2 (thiết kế r2 §8.2) — authenticated, STABLE SECDEF, phạm vi cms__result_run / cms__visible_result_users (122) ──
-- Đọc cả run legacy (cms_result_lines ↦ sự kiện SALE) lẫn run contract. Mỗi phản hồi mang khối `contract` ghim TỪ RUN (không từ cờ /
-- chương trình). Email / POS người bán gốc của phiếu trả chỉ ở returns_v2 (super). Reader cũ 122 RAISE trên run contract (đoạn chèn R).

-- Khối hợp đồng của run (chỉ owner): run legacy = pos_base + sales_only_v1 (đúng nghĩa T11 — không nhãn giả cho run contract).
CREATE FUNCTION public.cms__run_contract(p_run_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN r.calc_contract_version IS NULL THEN
           jsonb_build_object('legacy', true, 'calc_contract_version', NULL, 'quantity_basis', 'pos_base', 'returns_policy', 'sales_only_v1')
         ELSE jsonb_build_object('legacy', false, 'calc_contract_version', r.calc_contract_version, 'quantity_basis', r.quantity_basis,
                'quantity_policy_version', r.quantity_policy_version, 'returns_policy', r.returns_policy,
                'unit_key_version', r.unit_key_version, 'status_dictionary_version', r.status_dictionary_version,
                'returns_as_of', CASE WHEN r.returns_as_of IS NOT NULL THEN public.cms__ts(r.returns_as_of) END) END
    FROM public.cms_sync_runs r
   WHERE r.id = p_run_id
$$;

CREATE FUNCTION public.rpc_cms_result_header_v2(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run  uuid;
  v_su   boolean := public.is_super_admin();
  v_prog public.cms_programs%ROWTYPE;
  v_r    public.cms_sync_runs%ROWTYPE;
  v_last public.cms_sync_runs%ROWTYPE;
BEGIN
  v_run := public.cms__result_run(p_program_id, NULL);
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id;
  SELECT * INTO v_last FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = p_program_id ORDER BY started_at DESC LIMIT 1;
  IF v_run IS NOT NULL THEN SELECT * INTO v_r FROM public.cms_sync_runs WHERE id = v_run; END IF;
  RETURN jsonb_build_object(
    'program_id', p_program_id,
    'config_version', v_prog.config_version,
    'program_mode', jsonb_build_object('quantity_basis', v_prog.quantity_basis, 'returns_policy', v_prog.returns_policy),
    'viewer', CASE WHEN v_su THEN 'super' ELSE (SELECT u.role FROM public.users u WHERE u.id = auth.uid()) END,
    'run', CASE WHEN v_run IS NULL THEN NULL ELSE
      jsonb_build_object('id', v_r.id, 'config_version', v_r.config_version, 'published_at', public.cms__ts(v_r.published_at),
                         'source_max_updated_at', public.cms__ts(v_r.source_max_updated_at), 'started_at', public.cms__ts(v_r.started_at),
                         'contract', public.cms__run_contract(v_r.id))
      || CASE WHEN v_su THEN jsonb_build_object('amount_vnd', v_r.amount_vnd::text, 'rows_read', v_r.rows_read,
                                                'totals', CASE WHEN v_r.calc_contract_version IS NULL THEN v_r.detail -> 'totals'
                                                               ELSE v_r.seal_expect -> 'totals' END,
                                                'returns_rows_read', v_r.returns_rows_read,
                                                'ledger', CASE WHEN v_r.ledger_verdict IS NULL THEN NULL
                                                               ELSE jsonb_build_object('verdict', v_r.ledger_verdict, 'eval_seq', v_r.ledger_eval_seq,
                                                                                       'set_hash', v_r.ledger_set_hash) END)
             ELSE '{}'::jsonb END END,
    'last_attempt', CASE WHEN v_last.id IS NULL THEN NULL ELSE
      jsonb_build_object('status', v_last.status, 'started_at', public.cms__ts(v_last.started_at),
                         'finished_at', public.cms__ts(v_last.finished_at), 'is_current', v_last.id IS NOT DISTINCT FROM v_run)
      || CASE WHEN v_su THEN jsonb_build_object('id', v_last.id, 'error_code', v_last.error_code, 'ledger_verdict', v_last.ledger_verdict)
              ELSE '{}'::jsonb END END,
    'recent_runs', CASE WHEN v_su THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', q.id, 'status', q.status, 'error_code', q.error_code,
                                          'started_at', public.cms__ts(q.started_at), 'finished_at', public.cms__ts(q.finished_at),
                                          'rows_read', q.rows_read, 'amount_vnd', q.amount_vnd::text, 'config_version', q.config_version,
                                          'purged', q.purged_at IS NOT NULL, 'calc_contract_version', q.calc_contract_version,
                                          'quantity_basis', q.quantity_basis, 'returns_policy', q.returns_policy,
                                          'ledger_verdict', q.ledger_verdict, 'ledger_eval_seq', q.ledger_eval_seq)
                       ORDER BY q.started_at DESC)
        FROM (SELECT * FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = p_program_id
               ORDER BY started_at DESC LIMIT 10) q), '[]'::jsonb) END,
    'ledger', CASE WHEN v_su AND v_prog.returns_policy = 'net_returns_v1' THEN jsonb_build_object(
      'baselines', (SELECT count(*) FROM public.cms_return_baselines b WHERE b.program_id = p_program_id),
      'open_conflicts', (SELECT count(*) FROM public.cms_return_conflicts c WHERE c.program_id = p_program_id
                            AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id)),
      'latest_eval_seq', (SELECT max(e.eval_seq) FROM public.cms_return_ledger_evals e WHERE e.program_id = p_program_id)) END);
END;
$$;

CREATE FUNCTION public.rpc_cms_result_rows_v2(p_program_id uuid, p_run_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run   uuid;
  v_users uuid[];
  v_n     bigint;
BEGIN
  v_run := public.cms__result_run(p_program_id, p_run_id);
  IF v_run IS NULL THEN
    RETURN jsonb_build_object('run_id', NULL, 'contract', NULL, 'results', '[]'::jsonb, 'catalog', '[]'::jsonb, 'users', '[]'::jsonb);
  END IF;
  v_users := public.cms__visible_result_users();
  SELECT count(*) INTO v_n FROM public.cms_results r WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users));
  IF v_n > 50000 THEN RAISE EXCEPTION 'CMS_RESULT_TOO_LARGE' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object(
    'run_id', v_run,
    'contract', public.cms__run_contract(v_run),
    'results', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'user_id', r.user_id, 'store_id', r.store_id, 'program_product_id', r.program_product_id, 'product_id', r.product_id,
        'gmv_basis', r.gmv_basis, 'base_quantity', r.base_quantity::text, 'per_unit', r.per_unit::text,
        'cms_quantity', r.cms_quantity::text, 'rewarded_quantity', r.rewarded_quantity::text,
        'cap_quantity', r.cap_quantity::text, 'at_cap', r.at_cap, 'gmv_amount', r.gmv_amount::text,
        'gate_gmv', r.gate_gmv::text, 'target_gmv', r.target_gmv::text, 'gate_met', r.gate_met,
        'gate_met_at', public.cms__ts(r.gate_met_at), 'potential_amount', r.potential_amount::text,
        'amount_vnd', r.amount_vnd::text, 'line_count', r.line_count,
        'net', CASE WHEN r.net_v IS NULL THEN NULL ELSE jsonb_build_object(
          'sale_base', r.sale_base::text, 'return_base', r.return_base::text, 'eligible_sale_base', r.eligible_sale_base::text,
          'eligible_return_base', r.eligible_return_base::text, 'eligible_base', r.eligible_base::text,
          'counted_sale_qty', r.counted_sale_qty::text, 'sale_gmv', r.sale_gmv::text, 'return_gmv', r.return_gmv::text,
          'return_count', r.return_count) END) ORDER BY r.user_id, r.product_id)
      FROM public.cms_results r WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users))), '[]'::jsonb),
    'catalog', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'user_id', k.user_id, 'store_id', k.store_id, 'catalog_gmv', k.catalog_gmv::text, 'target_gmv', k.target_gmv::text,
        'met', k.met, 'met_at', public.cms__ts(k.met_at), 'line_count', k.line_count) ORDER BY k.user_id)
      FROM public.cms_result_catalog k WHERE k.run_id = v_run AND (v_users IS NULL OR k.user_id = ANY (v_users))), '[]'::jsonb),
    'users', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'full_name', u.full_name, 'store_id', u.store_id) ORDER BY u.id)
      FROM public.users u WHERE u.id IN (SELECT r.user_id FROM public.cms_results r
                                          WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users)))), '[]'::jsonb));
END;
$$;

-- Sự kiện tính theo nhóm (keyset seq). Run contract: cms_result_events (SALE + RETURN). Run legacy: cms_result_lines ↦ SALE (lớp lượng
-- POS_BASE, B đủ = B). RETURN không trả POS / email gốc.
CREATE FUNCTION public.rpc_cms_result_events_v2(p_program_id uuid, p_run_id uuid, p_program_product_id uuid DEFAULT NULL,
                                                p_user_id uuid DEFAULT NULL, p_after_seq integer DEFAULT NULL, p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run   uuid;
  v_users uuid[];
  v_rows  jsonb;
  v_next  integer;
  v_ct    boolean;
  v_uid   uuid;
BEGIN
  IF p_run_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_after_seq IS NOT NULL AND p_after_seq < 0) THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  v_run := public.cms__result_run(p_program_id, p_run_id);
  v_users := public.cms__visible_result_users();
  IF p_user_id IS NOT NULL AND v_users IS NOT NULL AND NOT (p_user_id = ANY (v_users)) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Người xem chỉ thấy MỘT dược sĩ ⇒ lọc user ngay từ index (run_id, user_id, seq), không quét cả run theo seq rồi lọc (db-reviewer
  -- 14/11 P2-6).
  v_uid := COALESCE(p_user_id, CASE WHEN cardinality(v_users) = 1 THEN v_users[1] END);
  SELECT r.calc_contract_version IS NOT NULL INTO v_ct FROM public.cms_sync_runs r WHERE r.id = v_run;
  IF v_ct THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'seq', q.seq, 'kind', q.kind, 'event_key', q.event_key, 'event_at', public.cms__ts(q.event_at), 'order_line_id', q.order_line_id,
        'order_code', q.order_code, 'product_id', q.product_id, 'program_product_id', q.program_product_id, 'user_id', q.user_id,
        'store_id', q.store_id, 'pos_code', CASE WHEN q.kind = 'SALE' THEN q.pos_code END,
        'quantity_raw', CASE WHEN q.kind = 'SALE' THEN q.quantity_raw END, 'uom_raw', CASE WHEN q.kind = 'SALE' THEN q.uom_raw END,
        'quantity_class', q.quantity_class, 'return_event_id', q.return_event_id, 'return_code', q.return_code,
        'base_delta', q.base_delta::text, 'eligible_delta', q.eligible_delta::text, 'gmv_delta', q.gmv_delta::text,
        'eligible_before', q.eligible_before::text, 'eligible_after', q.eligible_after::text,
        'qty_before', q.qty_before::text, 'qty_after', q.qty_after::text, 'amount_vnd', q.amount_vnd::text, 'status', q.status)
        ORDER BY q.seq), '[]'::jsonb)
      INTO v_rows
      FROM (SELECT e.seq, e.kind, e.event_key, e.event_at, e.order_line_id, sl.order_code, sl.product_id, e.program_product_id, e.user_id,
                   sl.store_id, sl.pos_code, sl.quantity_raw, sl.uom_raw, e.quantity_class, e.return_event_id, rt.return_code,
                   e.base_delta, e.eligible_delta, e.gmv_delta, e.eligible_before, e.eligible_after, e.qty_before, e.qty_after,
                   e.amount_vnd, e.status
              FROM public.cms_result_events e
              JOIN public.cms_sales_lines sl ON sl.run_id = e.run_id AND sl.order_line_id = e.order_line_id
              LEFT JOIN public.cms_return_lines rt ON rt.run_id = e.run_id AND rt.return_event_id = e.return_event_id
             WHERE e.run_id = v_run
               AND (v_users IS NULL OR e.user_id = ANY (v_users))
               AND (v_uid IS NULL OR e.user_id = v_uid)
               AND (p_program_product_id IS NULL OR e.program_product_id = p_program_product_id)
               AND e.seq > COALESCE(p_after_seq, -1)
             ORDER BY e.seq LIMIT p_limit + 1) q;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'seq', q.seq, 'kind', 'SALE', 'event_key', 'SALE:' || q.order_line_id, 'event_at', public.cms__ts(q.completed_at),
        'order_line_id', q.order_line_id, 'order_code', q.order_code, 'product_id', q.product_id,
        'program_product_id', q.program_product_id, 'user_id', q.user_id, 'store_id', q.store_id, 'pos_code', q.pos_code,
        'quantity_raw', q.quantity_raw, 'uom_raw', q.uom_raw, 'quantity_class', 'POS_BASE', 'return_event_id', NULL, 'return_code', NULL,
        'base_delta', q.base_quantity::text, 'eligible_delta', q.base_quantity::text, 'gmv_delta', q.gmv_amount::text,
        'eligible_before', q.base_before::text, 'eligible_after', q.base_after::text,
        'qty_before', q.qty_before::text, 'qty_after', q.qty_after::text, 'amount_vnd', q.amount_vnd::text, 'status', q.status)
        ORDER BY q.seq), '[]'::jsonb)
      INTO v_rows
      FROM (SELECT rl.seq, rl.order_line_id, sl.order_code, sl.product_id, rl.program_product_id, rl.user_id, sl.store_id,
                   sl.pos_code, sl.completed_at, sl.quantity_raw, sl.uom_raw, sl.base_quantity, sl.gmv_amount, rl.base_before,
                   rl.base_after, rl.qty_before, rl.qty_after, rl.amount_vnd, rl.status
              FROM public.cms_result_lines rl
              JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
             WHERE rl.run_id = v_run
               AND (v_users IS NULL OR rl.user_id = ANY (v_users))
               AND (v_uid IS NULL OR rl.user_id = v_uid)
               AND (p_program_product_id IS NULL OR rl.program_product_id = p_program_product_id)
               AND rl.seq > COALESCE(p_after_seq, -1)
             ORDER BY rl.seq LIMIT p_limit + 1) q;
  END IF;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'seq')::integer;
  END IF;
  RETURN jsonb_build_object('run_id', v_run, 'contract', public.cms__run_contract(v_run), 'rows', v_rows, 'next_after_seq', v_next);
END;
$$;

-- Dòng không tính (super): p_kind = 'disposition' (dòng bán không INCLUDED — như 122, kèm lớp lượng) hoặc 'quantity' (dòng INCLUDED
-- của run contract mà lớp lượng không đếm: OTHER_UNIT / FRACTIONAL_QUANTITY / ZERO_QUANTITY). Super kiểm TRƯỚC khi tra run.
CREATE FUNCTION public.rpc_cms_result_excluded_v2(p_program_id uuid, p_run_id uuid, p_kind text, p_after_seq integer DEFAULT NULL,
                                                  p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run  uuid;
  v_rows jsonb;
  v_next integer;
BEGIN
  IF p_run_id IS NULL OR p_kind IS NULL OR p_kind NOT IN ('disposition', 'quantity') OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500
     OR (p_after_seq IS NOT NULL AND p_after_seq < 0) THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  v_run := public.cms__result_run(p_program_id, p_run_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'seq', q.seq, 'order_line_id', q.order_line_id, 'order_code', q.order_code, 'product_id', q.product_id,
      'program_product_id', q.program_product_id, 'disposition', q.disposition, 'unassigned_reason', q.unassigned_reason,
      'seller_email', q.seller_email, 'user_id', q.user_id, 'store_id', q.store_id, 'pos_code', q.pos_code,
      'completed_at', public.cms__ts(q.completed_at), 'base_quantity', q.base_quantity::text, 'gmv_amount', q.gmv_amount::text,
      'quantity_raw', q.quantity_raw, 'uom_raw', q.uom_raw, 'quantity_src_flag', q.quantity_src_flag, 'uom_src_flag', q.uom_src_flag,
      'quantity_class', q.quantity_class, 'eligible_base', q.eligible_base::text) ORDER BY q.seq), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT * FROM public.cms_sales_lines sl
           WHERE sl.run_id = v_run AND sl.seq > COALESCE(p_after_seq, -1)
             AND ((p_kind = 'disposition' AND sl.disposition <> 'INCLUDED')
                  OR (p_kind = 'quantity' AND sl.disposition = 'INCLUDED'
                      AND sl.quantity_class IN ('OTHER_UNIT', 'FRACTIONAL_QUANTITY', 'ZERO_QUANTITY')))
           ORDER BY sl.seq LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'seq')::integer;
  END IF;
  RETURN jsonb_build_object('run_id', v_run, 'contract', public.cms__run_contract(v_run), 'kind', p_kind, 'rows', v_rows,
                            'next_after_seq', v_next);
END;
$$;

-- Phiếu trả của snapshot run (super): mọi dòng provider trả + disposition DB tự suy + đã vào sổ hay chưa. Run sales-only / legacy ⇒ rỗng
-- (không "0 phiếu" giả: khối contract cho biết returns_policy).
CREATE FUNCTION public.rpc_cms_result_returns_v2(p_program_id uuid, p_run_id uuid, p_after_seq integer DEFAULT NULL, p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run  uuid;
  v_rows jsonb;
  v_next integer;
BEGIN
  IF p_run_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_after_seq IS NOT NULL AND p_after_seq < 0) THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  v_run := public.cms__result_run(p_program_id, p_run_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'seq', q.seq, 'return_event_id', q.return_event_id, 'return_status', q.return_status, 'status_effect', q.status_effect,
      'disposition', q.disposition, 'return_document_id', q.return_document_id, 'return_code', q.return_code,
      'recorded_at', public.cms__ts(q.recorded_at), 'original_order_line_id', q.original_order_line_id,
      'original_order_id', q.original_order_id, 'product_id', q.product_id,
      'return_base_quantity', q.return_base_quantity::text, 'return_gmv_amount', q.return_gmv_amount::text,
      'original_completed_at', public.cms__ts(q.original_completed_at), 'original_seller_email', q.original_seller_email,
      'original_pos_code', q.original_pos_code, 'sale_ref_line_id', q.sale_ref_line_id,
      'in_ledger', EXISTS (SELECT 1 FROM public.cms_return_baselines b WHERE b.program_id = p_program_id AND b.return_event_id = q.return_event_id))
      ORDER BY q.seq), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT * FROM public.cms_return_lines rt WHERE rt.run_id = v_run AND rt.seq > COALESCE(p_after_seq, -1)
           ORDER BY rt.seq LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'seq')::integer;
  END IF;
  RETURN jsonb_build_object('run_id', v_run, 'contract', public.cms__run_contract(v_run), 'rows', v_rows, 'next_after_seq', v_next);
END;
$$;

-- Sổ trả hàng của chương trình (super + đọc được — QA cần marker): conflict mở (tối đa 500, observation mới nhất 10 / conflict),
-- phục hồi gần nhất, eval mới nhất, hash hiện tại và proof ỨNG VIÊN (chỉ khi hợp lệ — UI chỉ hiện nút xác nhận khi có; RPC confirm vẫn
-- kiểm lại dưới khoá). Không có thao tác "nhận tiền mới".
CREATE FUNCTION public.rpc_cms_return_conflicts(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog  public.cms_programs%ROWTYPE;
  v_ev    public.cms_return_ledger_evals%ROWTYPE;
  v_open  integer;
  v_ohash text;
  v_lhash text;
  v_proof boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin() OR NOT COALESCE(p_program_id = ANY (public.cms_readable_program_ids()), false) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id;
  SELECT * INTO v_ev FROM public.cms_return_ledger_evals WHERE program_id = p_program_id ORDER BY eval_seq DESC LIMIT 1;
  SELECT count(*) INTO v_open FROM public.cms_return_conflicts c
   WHERE c.program_id = p_program_id AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id);
  v_ohash := public.cms__open_set_hash(p_program_id);
  v_lhash := public.cms__ledger_set_hash(p_program_id);
  v_proof := v_open > 0 AND v_ev.verdict IS NOT DISTINCT FROM 'OPEN_CONFLICT_MATCH' AND v_ev.open_set_hash IS NOT DISTINCT FROM v_ohash
    AND v_ev.ledger_set_hash IS NOT DISTINCT FROM v_lhash AND v_ev.config_version IS NOT DISTINCT FROM v_prog.config_version
    AND v_ev.open_conflicts IS NOT DISTINCT FROM v_open;
  RETURN jsonb_build_object(
    'program_id', p_program_id, 'returns_policy', v_prog.returns_policy, 'config_version', v_prog.config_version,
    'baselines', (SELECT count(*) FROM public.cms_return_baselines b WHERE b.program_id = p_program_id),
    'ledger_set_hash', v_lhash, 'open_set_hash', v_ohash, 'open_count', v_open, 'open_truncated', v_open > 500,
    'latest_eval', CASE WHEN v_ev.program_id IS NULL THEN NULL ELSE jsonb_build_object(
      'eval_seq', v_ev.eval_seq, 'kind', v_ev.kind, 'run_id', v_ev.run_id, 'report_attempt', v_ev.report_attempt, 'verdict', v_ev.verdict,
      'returns_as_of', public.cms__ts(v_ev.returns_as_of), 'evaluated_at', public.cms__ts(v_ev.evaluated_at),
      'baselines', v_ev.baselines, 'mismatched', v_ev.mismatched, 'open_conflicts', v_ev.open_conflicts) END,
    'proof', CASE WHEN v_proof THEN jsonb_build_object('eval_seq', v_ev.eval_seq, 'open_set_hash', v_ohash) END,
    'open', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'conflict_id', c.id, 'return_event_id', c.return_event_id, 'prev_conflict_id', c.prev_conflict_id, 'opened_kind', c.opened_kind,
        'opened_eval_seq', c.opened_eval_seq, 'opened_at', public.cms__ts(c.opened_at),
        'baseline', jsonb_build_object('return_document_id', b.return_document_id, 'original_order_line_id', b.original_order_line_id,
          'product_id', b.product_id, 'base_quantity', b.base_quantity::text, 'refund_amount', b.refund_amount::text,
          'recorded_at', public.cms__ts(b.recorded_at), 'accepted_run_id', b.accepted_run_id, 'accepted_report_id', b.accepted_report_id,
          'accepted_at', public.cms__ts(b.accepted_at)),
        'observations', (SELECT jsonb_agg(jsonb_build_object('version', o.version, 'eval_seq', o.eval_seq, 'verdict', o.verdict,
                                                              'observed', o.observed, 'observed_at', public.cms__ts(o.observed_at))
                                          ORDER BY o.version DESC)
                           FROM (SELECT * FROM public.cms_return_conflict_observations x WHERE x.conflict_id = c.id
                                  ORDER BY x.version DESC LIMIT 10) o))
        ORDER BY c.return_event_id COLLATE "C")
      FROM (SELECT * FROM public.cms_return_conflicts c0
             WHERE c0.program_id = p_program_id
               AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c0.id)
             ORDER BY c0.return_event_id COLLATE "C" LIMIT 500) c
      JOIN public.cms_return_baselines b ON b.program_id = c.program_id AND b.return_event_id = c.return_event_id), '[]'::jsonb),
    'restorations', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'proof_eval_seq', r.proof_eval_seq, 'conflicts', r.conflicts,
        'reason', r.reason, 'confirmed_by', r.confirmed_by, 'confirmed_at', public.cms__ts(r.confirmed_at)) ORDER BY r.confirmed_at DESC)
      FROM (SELECT * FROM public.cms_return_restorations r0 WHERE r0.program_id = p_program_id
             ORDER BY r0.confirmed_at DESC LIMIT 20) r), '[]'::jsonb));
END;
$$;

-- ── 8c. Báo cáo trả hàng sau chốt (PM D11, thiết kế r2 §6.6 + r2.1 §14.2) ──
-- Chỉ chương trình ĐÃ CHỐT (cms_payouts), run chốt legacy (cms__lock_eval chặn chốt run contract trong batch này). Báo cáo tính lại
-- net trên dòng bán / kết quả ĐÃ ĐÓNG BĂNG của run chốt + phiếu trả của snapshot ghim; KHÔNG là lệnh thu / chi (không ghi cms_payouts /
-- cms_payout_staff). Payload chỉ gồm pin + phiếu thô; DB tự suy disposition / người / SP / fp / số. Kiểm báo cáo = một eval kind
-- report trên CÙNG sổ receipt: lệch / còn conflict mở ⇒ ghi eval + conflict / observation, KHÔNG ghi báo cáo, trả held.

-- Phiếu payload ↦ dòng có kiểu + hash dòng cms-src-digest-v1 (22 trường, CÙNG công thức seal N9 cho cms_return_lines). Gọi SAU khi RPC đã
-- kiểm định dạng chuỗi (ép kiểu an toàn). Chỉ owner.
CREATE FUNCTION public.cms__report_rows(p_rows jsonb)
RETURNS TABLE (return_event_id text, return_status text, status_effect text, return_document_id text, return_code text,
               recorded_at timestamptz, original_order_line_id text, original_order_id text, product_id text,
               return_base_quantity numeric, return_gmv_amount numeric, original_completed_at timestamptz, original_order_type text,
               original_order_status text, original_seller_email text, original_pos_code text, original_base_quantity numeric,
               original_gmv_amount numeric, original_quantity_src text, original_uom_src text, original_quantity_src_flag text,
               original_uom_src_flag text, source_updated_at timestamptz, row_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.return_event_id, r.return_status, public.cms__return_status_effect(r.return_status), r.return_document_id, r.return_code,
         r.recorded_at, r.original_order_line_id, r.original_order_id, r.product_id, r.return_base_quantity, r.return_gmv_amount,
         r.original_completed_at, r.original_order_type, r.original_order_status, r.original_seller_email, r.original_pos_code,
         r.original_base_quantity, r.original_gmv_amount, r.original_quantity_src, r.original_uom_src, r.original_quantity_src_flag,
         r.original_uom_src_flag, r.source_updated_at,
         encode(sha256(convert_to(
              COALESCE(octet_length(r.return_event_id) || ':' || r.return_event_id, '-')
           || COALESCE(octet_length(r.return_status) || ':' || r.return_status, '-')
           || COALESCE(octet_length(r.return_document_id) || ':' || r.return_document_id, '-')
           || COALESCE(octet_length(r.return_code) || ':' || r.return_code, '-')
           || COALESCE(octet_length(n.rec) || ':' || n.rec, '-')
           || COALESCE(octet_length(r.original_order_line_id) || ':' || r.original_order_line_id, '-')
           || COALESCE(octet_length(r.original_order_id) || ':' || r.original_order_id, '-')
           || COALESCE(octet_length(r.product_id) || ':' || r.product_id, '-')
           || COALESCE(octet_length(n.rb) || ':' || n.rb, '-')
           || COALESCE(octet_length(n.rg) || ':' || n.rg, '-')
           || COALESCE(octet_length(n.oc) || ':' || n.oc, '-')
           || COALESCE(octet_length(r.original_order_type) || ':' || r.original_order_type, '-')
           || COALESCE(octet_length(r.original_order_status) || ':' || r.original_order_status, '-')
           || COALESCE(octet_length(r.original_seller_email) || ':' || r.original_seller_email, '-')
           || COALESCE(octet_length(r.original_pos_code) || ':' || r.original_pos_code, '-')
           || COALESCE(octet_length(n.ob) || ':' || n.ob, '-')
           || COALESCE(octet_length(n.og) || ':' || n.og, '-')
           || COALESCE(octet_length(r.original_quantity_src) || ':' || r.original_quantity_src, '-')
           || COALESCE(octet_length(r.original_uom_src) || ':' || r.original_uom_src, '-')
           || COALESCE(octet_length(r.original_quantity_src_flag) || ':' || r.original_quantity_src_flag, '-')
           || COALESCE(octet_length(r.original_uom_src_flag) || ':' || r.original_uom_src_flag, '-')
           || COALESCE(octet_length(n.su) || ':' || n.su, '-'), 'UTF8')), 'hex')
    FROM (SELECT x.return_event_id, x.return_status, x.return_document_id, x.return_code, x.recorded_at::timestamptz AS recorded_at,
                 x.original_order_line_id, x.original_order_id, x.product_id, x.return_base_quantity::numeric AS return_base_quantity,
                 x.return_gmv_amount::numeric AS return_gmv_amount, x.original_completed_at::timestamptz AS original_completed_at,
                 x.original_order_type, x.original_order_status, x.original_seller_email, x.original_pos_code,
                 x.original_base_quantity::numeric AS original_base_quantity, x.original_gmv_amount::numeric AS original_gmv_amount,
                 x.original_quantity_src, x.original_uom_src, x.original_quantity_src_flag, x.original_uom_src_flag,
                 x.source_updated_at::timestamptz AS source_updated_at
            FROM jsonb_to_recordset(p_rows) AS x(return_event_id text, return_status text, return_document_id text, return_code text,
                   recorded_at text, original_order_line_id text, original_order_id text, product_id text, return_base_quantity text,
                   return_gmv_amount text, original_completed_at text, original_order_type text, original_order_status text,
                   original_seller_email text, original_pos_code text, original_base_quantity text, original_gmv_amount text,
                   original_quantity_src text, original_uom_src text, original_quantity_src_flag text, original_uom_src_flag text,
                   source_updated_at text)) r
    CROSS JOIN LATERAL (SELECT trunc(extract(epoch FROM r.recorded_at) * 1000000, 0)::text AS rec,
                               trunc(r.return_base_quantity * 1000000000, 0)::text AS rb,
                               trunc(r.return_gmv_amount * 1000000000, 0)::text AS rg,
                               trunc(extract(epoch FROM r.original_completed_at) * 1000000, 0)::text AS oc,
                               trunc(r.original_base_quantity * 1000000000, 0)::text AS ob,
                               trunc(r.original_gmv_amount * 1000000000, 0)::text AS og,
                               trunc(extract(epoch FROM r.source_updated_at) * 1000000, 0)::text AS su) n
$$;

-- service_role (job sau chốt / server action super đã kiểm quyền ở app; actor tuỳ chọn trong payload). Mã lỗi đầu vào / ngữ cảnh ⇒ RAISE,
-- 0 ghi. Sổ lệch / còn conflict ⇒ {saved:false, code} và CHỈ eval + conflict / observation được ghi. Cùng snapshot (as_of + digest) ⇒
-- trả báo cáo cũ (idempotent).
CREATE FUNCTION public.rpc_cms_return_close_report_save(p_program_id uuid, p_payout_run_id uuid, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  c_ts   CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$';
  c_pid  CONSTANT text := '^[1-9][0-9]{0,18}$';
  c_txt  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,100}$';
  c_t50  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,50}$';
  c_t30  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,30}$';
  c_mail CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]+$';
  c_flag CONSTANT text := '^(NUL|OVERSIZE)$';
  c_dec  CONSTANT text := '^-?[0-9]{1,35}(\.[0-9]{1,9})?$';
  c_rqty CONSTANT text := '^[1-9][0-9]{0,28}$';
  c_rgmv CONSTANT text := '^[0-9]{1,20}(\.[0-9]{1,9})?$';
  c_ref  CONSTANT text := '^[A-Za-z0-9_.:-]{1,255}$';
  c_hex  CONSTANT text := '^[0-9a-f]{64}$';
  c_date CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';
  c_uuid CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_pin    jsonb;
  v_rows   jsonb;
  v_actor  uuid;
  v_n      integer;
  v_prog   public.cms_programs%ROWTYPE;
  v_pay    public.cms_payouts%ROWTYPE;
  v_run    public.cms_sync_runs%ROWTYPE;
  v_ph     text;
  v_dig    text;
  v_asof   timestamptz;
  v_ids    text;
  v_from   timestamptz;
  v_to     timestamptz;
  v_idem   text;
  v_old    uuid;
  v_code   text;
  v_ret    jsonb;
  v_obs    jsonb;
  v_id     uuid;
  v_ev     jsonb;
  v_seq    bigint;
  v_lines  jsonb;
  v_frozen bigint;
  v_recomp bigint;
  v_nlines integer;
  v_nev    integer;
  v_nb0    bigint;
  v_new    bigint;
  v_badrow boolean;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  -- 1. Hình dạng payload (trước mọi khoá). Mọi giá trị phiếu là chuỗi hoặc null; khoá lạ ⇒ từ chối.
  IF COALESCE(p_program_id IS NULL OR p_payout_run_id IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('pin', 'returns', 'actor'))
     OR jsonb_typeof(p_payload -> 'pin') IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload -> 'returns') IS DISTINCT FROM 'array'
     OR (p_payload ? 'actor' AND NOT public.cms__str(p_payload, 'actor', c_uuid)), true) THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  v_pin := p_payload -> 'pin';
  v_rows := p_payload -> 'returns';
  v_n := jsonb_array_length(v_rows);
  v_actor := (p_payload ->> 'actor')::uuid;
  -- Phòng thủ chiều sâu (security-reviewer 14/11 P1-1): actor (đường super) phải là admin — điều kiện cần của super; allowlist super chỉ ở
  -- authz.ts + is_super_admin(), KHÔNG chép thêm. Server action vẫn phải kiểm super bằng phiên trước khi gọi service_role.
  IF v_actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_actor AND u.role = 'admin') THEN
    RAISE EXCEPTION 'CMS_REPORT_ACTOR_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF v_n > 100000 THEN RAISE EXCEPTION 'CMS_REPORT_TOO_LARGE' USING ERRCODE = '22023'; END IF;
  IF COALESCE(EXISTS (SELECT 1 FROM jsonb_object_keys(v_pin) k
                       WHERE k NOT IN ('protocol', 'provider', 'job_id', 'snapshot_id', 'as_of', 'scope', 'returns'))
     OR v_pin ->> 'protocol' IS DISTINCT FROM 'cms-source-pin-v1' OR (v_pin ->> 'provider') NOT IN ('bq', 'fixture')
     OR (v_pin ? 'job_id') = (v_pin ? 'snapshot_id')
     OR NOT (public.cms__str(v_pin, 'job_id', c_ref) OR public.cms__str(v_pin, 'snapshot_id', c_ref))
     OR NOT public.cms__str(v_pin, 'as_of', c_ts)
     OR jsonb_typeof(v_pin -> 'scope') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_pin -> 'scope') k WHERE k NOT IN ('from', 'to', 'products_hash'))
     OR NOT public.cms__str(v_pin -> 'scope', 'from', c_date) OR NOT public.cms__str(v_pin -> 'scope', 'to', c_date)
     OR NOT public.cms__str(v_pin -> 'scope', 'products_hash', c_hex)
     OR jsonb_typeof(v_pin -> 'returns') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_pin -> 'returns') k WHERE k NOT IN ('rows', 'digest'))
     OR jsonb_typeof(v_pin -> 'returns' -> 'rows') IS DISTINCT FROM 'number' OR (v_pin -> 'returns' ->> 'rows') !~ '^(0|[1-9][0-9]{0,8})$'
     OR (v_pin -> 'returns' ->> 'rows')::integer <> v_n
     OR NOT public.cms__str(v_pin -> 'returns', 'digest', c_hex), true) THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_PIN' USING ERRCODE = '22023';
  END IF;
  -- Không EXCEPTION handler (cùng luật publish / seal): ngày đúng regex nhưng sai lịch (30/02) ⇒ lỗi cast 22008 trước mọi khoá / ghi.
  PERFORM (v_pin ->> 'as_of')::timestamptz, (v_pin -> 'scope' ->> 'from')::date, (v_pin -> 'scope' ->> 'to')::date;
  -- Phần tử không phải object kiểm RIÊNG trước: `strict $[*].*` trên phần tử không phải object văng lỗi jsonpath thay vì mã.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) e WHERE jsonb_typeof(e) <> 'object') THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_ROW' USING ERRCODE = '22023';
  END IF;
  IF jsonb_path_exists(v_rows, 'strict $[*].* ? (@.type() != "string" && @.type() != "null")')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) e CROSS JOIN LATERAL jsonb_object_keys(e) k
                 WHERE k NOT IN ('return_event_id', 'return_status', 'return_document_id', 'return_code', 'recorded_at',
                                 'original_order_line_id', 'original_order_id', 'product_id', 'return_base_quantity', 'return_gmv_amount',
                                 'original_completed_at', 'original_order_type', 'original_order_status', 'original_seller_email',
                                 'original_pos_code', 'original_base_quantity', 'original_gmv_amount', 'original_quantity_src',
                                 'original_uom_src', 'original_quantity_src_flag', 'original_uom_src_flag', 'source_updated_at'))
     OR (SELECT count(DISTINCT e ->> 'return_event_id') FROM jsonb_array_elements(v_rows) e) <> v_n
     OR EXISTS (
      SELECT 1 FROM jsonb_to_recordset(v_rows) AS x(return_event_id text, return_status text, return_document_id text,
             return_code text, recorded_at text, original_order_line_id text, original_order_id text, product_id text,
             return_base_quantity text, return_gmv_amount text, original_completed_at text, original_order_type text,
             original_order_status text, original_seller_email text, original_pos_code text, original_base_quantity text,
             original_gmv_amount text, original_quantity_src text, original_uom_src text, original_quantity_src_flag text,
             original_uom_src_flag text, source_updated_at text)
       WHERE NOT (COALESCE(x.return_event_id ~ c_txt AND x.return_status ~ c_t30, false)
                  AND (x.return_document_id IS NULL OR x.return_document_id ~ c_txt)
                  AND (x.return_code IS NULL OR x.return_code ~ c_txt)
                  AND (x.recorded_at IS NULL OR x.recorded_at ~ c_ts)
                  AND (x.original_order_line_id IS NULL OR x.original_order_line_id ~ c_txt)
                  AND (x.original_order_id IS NULL OR x.original_order_id ~ c_txt)
                  AND (x.product_id IS NULL OR x.product_id ~ c_pid)
                  AND (x.return_base_quantity IS NULL OR x.return_base_quantity ~ c_rqty)
                  AND (x.return_gmv_amount IS NULL OR x.return_gmv_amount ~ c_rgmv)
                  AND (x.original_completed_at IS NULL OR x.original_completed_at ~ c_ts)
                  AND (x.original_order_type IS NULL OR x.original_order_type ~ c_t30)
                  AND (x.original_order_status IS NULL OR x.original_order_status ~ c_t30)
                  AND (x.original_seller_email IS NULL OR (x.original_seller_email ~ c_mail AND char_length(x.original_seller_email) <= 320
                                                           AND x.original_seller_email = lower(x.original_seller_email)))
                  AND (x.original_pos_code IS NULL OR x.original_pos_code ~ c_t50)
                  AND (x.original_base_quantity IS NULL OR x.original_base_quantity ~ c_dec)
                  AND (x.original_gmv_amount IS NULL OR x.original_gmv_amount ~ c_dec)
                  AND (x.original_quantity_src IS NULL OR char_length(x.original_quantity_src) <= 64)
                  AND (x.original_uom_src IS NULL OR char_length(x.original_uom_src) <= 64)
                  AND (x.original_quantity_src_flag IS NULL OR x.original_quantity_src_flag ~ c_flag)
                  AND (x.original_uom_src_flag IS NULL OR x.original_uom_src_flag ~ c_flag)
                  AND (x.source_updated_at IS NULL OR x.source_updated_at ~ c_ts))) THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_ROW' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(v_rows) AS x(return_status text) WHERE public.cms__return_status_effect(x.return_status) IS NULL) THEN
    RAISE EXCEPTION 'CMS_RETURN_STATUS_UNKNOWN' USING ERRCODE = '22023';
  END IF;
  -- Dạng theo hiệu lực = CHECK cms_return_lines: chưa hiệu lực ⇒ chỉ ID + trạng thái; hiệu lực ⇒ đủ trường tài chính / lineage / ngữ cảnh.
  -- CÙNG lần đọc cms__report_rows tính digest phiếu (so pin ở bước 3, sau khoá). Bench 14/11: mỗi lần đọc ~0,6 s / 20.000 phiếu
  -- (ép kiểu + sha256 từng dòng) — cả RPC chỉ đọc 2 lần (đây + bước 5), không đọc lại ở bước 3 / 6.
  SELECT COALESCE(bool_or(NOT COALESCE(
                (p.status_effect = 'NOT_EFFECTIVE' AND p.return_document_id IS NULL AND p.return_code IS NULL AND p.recorded_at IS NULL
                   AND p.original_order_line_id IS NULL AND p.original_order_id IS NULL AND p.product_id IS NULL
                   AND p.return_base_quantity IS NULL AND p.return_gmv_amount IS NULL AND p.original_completed_at IS NULL
                   AND p.original_order_type IS NULL AND p.original_order_status IS NULL AND p.original_seller_email IS NULL
                   AND p.original_pos_code IS NULL AND p.original_base_quantity IS NULL AND p.original_gmv_amount IS NULL
                   AND p.original_quantity_src IS NULL AND p.original_uom_src IS NULL AND p.original_quantity_src_flag IS NULL
                   AND p.original_uom_src_flag IS NULL AND p.source_updated_at IS NULL)
                OR (p.status_effect = 'EFFECTIVE' AND p.return_document_id IS NOT NULL AND p.recorded_at IS NOT NULL
                    AND p.original_order_line_id IS NOT NULL AND p.original_order_id IS NOT NULL AND p.product_id IS NOT NULL
                    AND p.return_base_quantity IS NOT NULL AND p.return_gmv_amount IS NOT NULL AND p.original_completed_at IS NOT NULL
                    AND p.original_order_type IS NOT NULL AND p.original_order_status IS NOT NULL
                    AND p.original_base_quantity IS NOT NULL AND p.original_gmv_amount IS NOT NULL
                    AND (p.original_quantity_src_flag IS NULL OR p.original_quantity_src IS NULL)
                    AND (p.original_uom_src_flag IS NULL OR p.original_uom_src IS NULL)), false)), false),
         encode(sha256(convert_to('cms-src-digest-v1' || E'\n' || 'returns' || E'\n' || count(*)::text || E'\n'
                                  || COALESCE(string_agg(p.row_hash, E'\n' ORDER BY p.return_event_id COLLATE "C"), ''), 'UTF8')), 'hex')
    INTO v_badrow, v_dig
    FROM public.cms__report_rows(v_rows) p;
  IF v_badrow THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_ROW' USING ERRCODE = '22023';
  END IF;

  -- 2. Khoá chương trình (cùng thứ tự publish / confirm / chốt) → payout → run chốt.
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_prog.status IS DISTINCT FROM 'locked' THEN RAISE EXCEPTION 'CMS_REPORT_NOT_LOCKED' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_pay FROM public.cms_payouts WHERE program_id = p_program_id;
  IF NOT FOUND OR v_pay.run_id IS DISTINCT FROM p_payout_run_id THEN
    RAISE EXCEPTION 'CMS_REPORT_PAYOUT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_payout_run_id;
  IF v_run.calc_contract_version IS NOT NULL THEN RAISE EXCEPTION 'CMS_REPORT_CONTRACT_UNSUPPORTED' USING ERRCODE = 'P0001'; END IF;
  IF v_pin ->> 'provider' = 'fixture' AND NOT v_prog.is_test THEN RAISE EXCEPTION 'CMS_REPORT_PIN_PROVIDER' USING ERRCODE = 'P0001'; END IF;
  -- 3. Pin = chương trình (kỳ + tập SP); digest phiếu DB tự tính = pin; as_of không ở tương lai.
  SELECT encode(sha256(convert_to('cms-src-digest-v1' || E'\n' || 'products' || E'\n' || count(*)::text || E'\n'
                                  || COALESCE(string_agg(pp.product_id, E'\n' ORDER BY pp.product_id COLLATE "C"), ''), 'UTF8')), 'hex')
    INTO v_ph FROM public.cms_program_products pp WHERE pp.program_id = p_program_id;
  v_asof := (v_pin ->> 'as_of')::timestamptz;
  IF (v_pin -> 'scope' ->> 'from')::date IS DISTINCT FROM v_prog.start_date OR (v_pin -> 'scope' ->> 'to')::date IS DISTINCT FROM v_prog.end_date
     OR v_ph IS DISTINCT FROM v_pin -> 'scope' ->> 'products_hash' THEN
    RAISE EXCEPTION 'CMS_REPORT_PIN_SCOPE' USING ERRCODE = 'P0001';
  END IF;
  IF v_dig IS DISTINCT FROM v_pin -> 'returns' ->> 'digest' THEN RAISE EXCEPTION 'CMS_REPORT_PIN_DIGEST' USING ERRCODE = 'P0001'; END IF;
  IF v_asof > now() + interval '5 minutes' THEN RAISE EXCEPTION 'CMS_REPORT_BAD_PIN' USING ERRCODE = '22023'; END IF;
  -- 4. Idempotency sau khoá: cùng chương trình / run chốt / as_of / digest / version ⇒ báo cáo cũ.
  v_idem := encode(sha256(convert_to(concat_ws(E'\n', 'cms-close-report-v1', p_program_id::text, p_payout_run_id::text,
                                               public.cms__ts(v_asof), v_dig, 'cms-calc-ret2-v1', 'cms-return-fp-v1', 'cms-return-status-v1'),
                                     'UTF8')), 'hex');
  SELECT id INTO v_old FROM public.cms_return_close_reports WHERE idem_key = v_idem;
  IF FOUND THEN RETURN jsonb_build_object('saved', true, 'already', true, 'report_id', v_old); END IF;
  -- Snapshot quá cũ ⇒ không đánh giá (db-reviewer 14/11 P1-1: lượt bị RAISE không để vết ⇒ giới hạn cửa sổ phát lại; 36 giờ = mặc định
  -- Dev như seal N2). Sau idem: phát lại đúng snapshot đã lưu vẫn trả báo cáo cũ.
  IF v_asof < now() - interval '36 hours' THEN RAISE EXCEPTION 'CMS_REPORT_AS_OF_STALE' USING ERRCODE = 'P0001'; END IF;

  -- 5. Suy từ dòng bán ĐÃ ĐÓNG BĂNG của run chốt (đóng băng bởi trigger cms_frozen_*): disposition / người / SP; ngữ cảnh gốc phải khớp
  --    (run legacy pos_base: không so q / u); mốc ghi nhận; Σ trả / dòng gốc ≤ b / g. Sai ⇒ RAISE, 0 ghi.
  v_from := (v_prog.start_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
  v_to   := ((v_prog.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
  --    Kế hoạch không phụ thuộc thống kê (bench 14/11 — run / chương trình mới chưa có trong thống kê ⇒ planner ước 1 dòng, chọn Nested
  --    Loop + Materialize ⇒ bậc hai 20.000 × 20.000): MỌI tra bảng từ tập phiếu là probe khoá chính TỪNG dòng — LATERAL … LIMIT 1 (dòng
  --    bán, PK (run_id, order_line_id)) và truy vấn con vô hướng (baseline, PK (program_id, return_event_id)); không viết lại thành
  --    JOIN / EXISTS (planner được kéo lên thành join). p0 = MỘT lần đọc cms__report_rows; fp tính MỘT lần cho phiếu hiệu lực, dùng
  --    chung cho sự kiện báo cáo (bước 8) và quan sát sổ (bước 6); led = phiếu đã có baseline (dưới khoá chương trình — baseline chỉ
  --    ghi dưới khoá này).
  WITH p0 AS MATERIALIZED (
    SELECT x.*,
           CASE WHEN x.status_effect = 'EFFECTIVE' THEN public.cms__return_fp('cms-return-fp-v1', p_program_id, x.return_event_id,
                  x.return_document_id, x.original_order_line_id, x.original_order_id, x.product_id, x.return_base_quantity,
                  x.return_gmv_amount, x.recorded_at) END AS fp,
           (SELECT true FROM public.cms_return_baselines b
             WHERE b.program_id = p_program_id AND b.return_event_id = x.return_event_id) IS NOT NULL AS led
      FROM public.cms__report_rows(v_rows) x
  ), d AS (
    SELECT p.*, sl.order_line_id AS sl_id, sl.disposition AS sale_disp, sl.user_id AS sl_user, sl.program_product_id AS sl_pp,
           sl.base_quantity AS sb, sl.gmv_amount AS sg,
           EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = p_program_id AND pp.product_id = p.product_id) AS in_prog,
           COALESCE(sl.order_line_id IS NOT NULL AND (
             (sl.order_id, sl.product_id, sl.completed_at, sl.seller_email, sl.pos_code, sl.base_quantity, sl.gmv_amount)
             IS DISTINCT FROM
             (p.original_order_id, p.product_id, p.original_completed_at, p.original_seller_email, p.original_pos_code,
              p.original_base_quantity, p.original_gmv_amount)
             OR NOT (p.original_order_type = 'OFFLINE' AND p.original_order_status = 'COMPLETED')), false) AS ctx_bad
      FROM p0 p
      LEFT JOIN LATERAL (SELECT s.order_line_id, s.disposition, s.user_id, s.program_product_id, s.base_quantity, s.gmv_amount,
                                s.order_id, s.product_id, s.completed_at, s.seller_email, s.pos_code
                           FROM public.cms_sales_lines s
                          WHERE s.run_id = p_payout_run_id AND s.order_line_id = p.original_order_line_id LIMIT 1) sl ON true
     WHERE p.status_effect = 'EFFECTIVE'
  ), e AS (
    SELECT d.*,
           CASE WHEN d.ctx_bad THEN NULL
                WHEN NOT (d.original_order_type = 'OFFLINE' AND d.original_order_status = 'COMPLETED') THEN 'ORIGIN_NOT_ELIGIBLE'
                WHEN d.original_completed_at < v_from OR d.original_completed_at >= v_to THEN 'ORIGIN_OUT_OF_WINDOW'
                WHEN NOT d.in_prog THEN 'ORIGIN_NOT_IN_PROGRAM'
                WHEN d.sl_id IS NULL THEN NULL
                WHEN d.sale_disp = 'UNASSIGNED' THEN 'ORIGIN_UNASSIGNED'
                WHEN d.sale_disp = 'OUT_OF_SCOPE' THEN 'ORIGIN_OUT_OF_SCOPE'
                WHEN d.sale_disp = 'INCLUDED' THEN 'APPLIED' END AS disp
      FROM d
  ), acc AS (
    SELECT e.original_order_line_id AS id, max(e.sb) AS sb, max(e.sg) AS sg, sum(e.return_base_quantity) AS rb, sum(e.return_gmv_amount) AS rg
      FROM e WHERE e.disp IN ('APPLIED', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE') GROUP BY e.original_order_line_id
  ), h AS (
    SELECT 'AFTER_AS_OF' AS code, e.return_event_id AS ref FROM e WHERE e.recorded_at > v_asof
    UNION ALL SELECT 'BEFORE_SALE', e.return_event_id FROM e WHERE e.recorded_at < e.original_completed_at
    UNION ALL SELECT 'CONTEXT_MISMATCH', e.return_event_id FROM e WHERE e.ctx_bad
    UNION ALL SELECT 'ORIGIN_MISSING', e.return_event_id FROM e WHERE NOT e.ctx_bad AND e.disp IS NULL
    UNION ALL SELECT 'EXCEEDS_SALE_BASE', acc.id FROM acc WHERE acc.rb > acc.sb
    UNION ALL SELECT 'EXCEEDS_SALE_GMV', acc.id FROM acc WHERE acc.rg > acc.sg
  ), hc AS (
    SELECT min(h.code) AS code FROM h
  )
  SELECT (SELECT hc.code FROM hc),
         (SELECT string_agg(z.ref, ',' ORDER BY z.ref COLLATE "C")
            FROM (SELECT h.ref FROM h JOIN hc ON hc.code = h.code ORDER BY h.ref COLLATE "C" LIMIT 20) z),
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.return_event_id, 'disp', e.disp,
                     'user_id', CASE WHEN e.disp = 'APPLIED' THEN e.sl_user END,
                     'ppid', CASE WHEN e.disp = 'APPLIED' THEN e.sl_pp END,
                     'line', e.original_order_line_id, 'base', e.return_base_quantity, 'refund', e.return_gmv_amount,
                     'recorded_at', public.cms__ts(e.recorded_at), 'fp', e.fp, 'led', e.led,
                     'doc', e.return_document_id, 'order_id', e.original_order_id, 'product_id', e.product_id))
                    FROM e), '[]'::jsonb),
         -- Quan sát bước 6: mọi phiếu (cả chưa hiệu lực) đã có baseline.
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'id', p.return_event_id, 'status', p.return_status, 'effect', p.status_effect, 'fp', p.fp,
                     'base', p.return_base_quantity::text, 'refund', p.return_gmv_amount::text,
                     'recorded_at', CASE WHEN p.recorded_at IS NOT NULL THEN public.cms__ts(p.recorded_at) END))
                    FROM p0 p WHERE p.led), '[]'::jsonb)
    INTO v_code, v_ids, v_ret, v_obs;
  -- Mã + tối đa 20 ID phiếu / dòng gốc (không PII) ở DETAIL để job ghi vết (db-reviewer 14/11 P2-5); 0 ghi.
  IF v_code IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'CMS_REPORT_' || v_code, DETAIL = 'refs: ' || COALESCE(v_ids, ''), ERRCODE = 'P0001';
  END IF;

  -- 6. Kiểm sổ = eval kind report dưới khoá (mọi baseline của chương trình đối chiếu snapshot này).
  --    Quan sát v_obs đã tính ở bước 5 (probe baseline dưới CÙNG khoá chương trình, chưa có ghi nào xen giữa).
  v_id := gen_random_uuid();
  v_ev := public.cms__ledger_eval(p_program_id, 'report', v_id, v_asof, v_dig, v_obs);
  IF v_ev ? 'code' THEN
    RETURN jsonb_build_object('saved', false, 'code', v_ev ->> 'code');
  END IF;
  IF v_ev ->> 'verdict' <> 'CLEAN' THEN
    RETURN jsonb_build_object('saved', false,
                              'code', CASE v_ev ->> 'verdict' WHEN 'MISMATCH' THEN 'CMS_REPORT_LEDGER_CONFLICT' ELSE 'CMS_REPORT_CONFLICT_OPEN' END,
                              'ledger', v_ev);
  END IF;
  v_seq := (v_ev ->> 'eval_seq')::bigint;

  -- 7. Tính lại từng nhóm của run chốt: B đủ = B chốt − Σ trả APPLIED (pos_base); GMV ròng = GMV chốt − Σ hoàn; gate SP theo GMV gate
  --    ròng, gate danh mục theo GMV danh mục ròng của dược sĩ, không gate ⇒ đạt; Q = floor(max(B đủ, 0) / K); tiền = gate ? F(Q) : 0
  --    theo thang ĐÃ ĐÓNG BĂNG (guard locked) — F trên Q chưa trần như 122 bước 7 (bậc cuối có trần nằm trong LEAST); số hiển thị
  --    recomputed_qty = Q sau trần (cùng nghĩa rewarded_quantity).
  WITH ev AS (
    SELECT * FROM jsonb_to_recordset(v_ret) AS x(id text, disp text, user_id uuid, ppid uuid, base numeric, refund numeric)
  ), ap AS (
    SELECT ev.user_id, ev.ppid, sum(ev.base) AS rb, sum(ev.refund) AS rg, count(*)::integer AS n
      FROM ev WHERE ev.disp = 'APPLIED' GROUP BY ev.user_id, ev.ppid
  ), r AS (
    SELECT r.*, COALESCE(ap.rb, 0) AS rb, COALESCE(ap.rg, 0) AS rg, COALESCE(ap.n, 0) AS rn
      FROM public.cms_results r
      LEFT JOIN ap ON ap.user_id = r.user_id AND ap.ppid = r.program_product_id
     WHERE r.run_id = p_payout_run_id
  ), cat AS (
    SELECT r.user_id, sum(r.rg) AS crg FROM r WHERE r.gmv_basis = 'catalog' GROUP BY r.user_id
  ), g AS (
    SELECT r.*, r.base_quantity - r.rb AS elig, r.gmv_amount - r.rg AS net_gmv,
           CASE r.gmv_basis WHEN 'none' THEN true
                            WHEN 'product' THEN COALESCE(r.gate_gmv - r.rg >= r.target_gmv, false)
                            ELSE COALESCE(k.catalog_gmv - COALESCE(cat.crg, 0) >= k.target_gmv, false) END AS met,
           GREATEST(floor((r.base_quantity - r.rb) / r.per_unit), 0)::bigint AS qn
      FROM r
      LEFT JOIN public.cms_result_catalog k ON k.run_id = r.run_id AND k.user_id = r.user_id
      LEFT JOIN cat ON cat.user_id = r.user_id
  ), gq AS (
    SELECT g.*, CASE WHEN g.cap_quantity IS NOT NULL AND g.qn > g.cap_quantity THEN g.cap_quantity ELSE g.qn END AS rq FROM g
  ), tc AS (
    SELECT t.program_product_id, t.tier_order,
           COALESCE(sum((t.qty_to - t.qty_from + 1)::numeric * t.amount_per_unit) OVER (PARTITION BY t.program_product_id
                    ORDER BY t.tier_order ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_before
      FROM public.cms_program_tiers t WHERE t.program_id = p_program_id
  ), fq AS (
    SELECT gq.*, CASE WHEN gq.qn <= 0 OR x.tier_order IS NULL THEN 0
                      ELSE tc.cum_before + (LEAST(gq.qn::numeric, COALESCE(x.qty_to, gq.qn)::numeric) - x.qty_from + 1) * x.amount_per_unit
                 END AS f
      FROM gq
      LEFT JOIN LATERAL (SELECT t.tier_order, t.qty_from, t.qty_to, t.amount_per_unit FROM public.cms_program_tiers t
                          WHERE t.program_product_id = gq.program_product_id AND t.qty_from <= gq.qn
                          ORDER BY t.qty_from DESC LIMIT 1) x ON true
      LEFT JOIN tc ON tc.program_product_id = gq.program_product_id AND tc.tier_order = x.tier_order
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'line_no', q.line_no, 'user_id', q.user_id, 'program_product_id', q.program_product_id, 'product_id', q.product_id,
           'gmv_basis', q.gmv_basis, 'per_unit', q.per_unit, 'frozen_base', q.base_quantity, 'frozen_qty', q.rewarded_quantity,
           'frozen_gmv', q.gmv_amount, 'frozen_gate_met', q.gate_met, 'frozen_amount', q.amount_vnd, 'return_base', q.rb,
           'return_gmv', q.rg, 'return_events', q.rn, 'eligible_base', q.elig, 'net_gmv', q.net_gmv, 'gate_met', q.met,
           'recomputed_qty', q.rq, 'recomputed_amount', q.ra, 'delta', q.ra - q.amount_vnd)), '[]'::jsonb),
         COALESCE(sum(q.amount_vnd), 0)::bigint, COALESCE(sum(q.ra), 0)::bigint, count(*)::integer
    INTO v_lines, v_frozen, v_recomp, v_nlines
    FROM (SELECT fq.*, (row_number() OVER (ORDER BY fq.user_id, fq.product_id, fq.program_product_id) - 1)::integer AS line_no,
                 (CASE WHEN fq.met THEN fq.f ELSE 0 END)::bigint AS ra
            FROM fq) q;
  IF v_frozen IS DISTINCT FROM v_pay.amount_vnd THEN RAISE EXCEPTION 'CMS_REPORT_FROZEN_MISMATCH' USING ERRCODE = 'P0001'; END IF;
  v_nev := jsonb_array_length(v_ret);

  -- 8. Ghi atomic (không EXCEPTION handler): header → dòng → sự kiện → baseline mới (accepted_report_id) → hậu kiểm.
  SELECT count(*) INTO v_nb0 FROM public.cms_return_baselines WHERE program_id = p_program_id;
  INSERT INTO public.cms_return_close_reports (id, program_id, payout_run_id, eval_seq, calc_contract_version, fp_version,
    status_dictionary_version, source_pin, returns_as_of, returns_digest, frozen_amount, recomputed_amount, delta_amount, return_events,
    line_count, idem_key, created_via, created_by)
  VALUES (v_id, p_program_id, p_payout_run_id, v_seq, 'cms-calc-ret2-v1', 'cms-return-fp-v1', 'cms-return-status-v1', v_pin, v_asof, v_dig,
          v_frozen, v_recomp, v_recomp - v_frozen, v_nev, v_nlines, v_idem, CASE WHEN v_actor IS NULL THEN 'cron' ELSE 'super' END, v_actor);
  INSERT INTO public.cms_return_close_report_lines (report_id, program_id, line_no, user_id, program_product_id, product_id, gmv_basis,
    per_unit, frozen_base, frozen_qty, frozen_gmv, frozen_gate_met, frozen_amount, return_base, return_gmv, return_events, eligible_base,
    net_gmv, gate_met, recomputed_qty, recomputed_amount, delta)
  SELECT v_id, p_program_id, x.line_no, x.user_id, x.program_product_id, x.product_id, x.gmv_basis, x.per_unit, x.frozen_base, x.frozen_qty,
         x.frozen_gmv, x.frozen_gate_met, x.frozen_amount, x.return_base, x.return_gmv, x.return_events, x.eligible_base, x.net_gmv,
         x.gate_met, x.recomputed_qty, x.recomputed_amount, x.delta
    FROM jsonb_to_recordset(v_lines) AS x(line_no integer, user_id uuid, program_product_id uuid, product_id text, gmv_basis text,
           per_unit numeric, frozen_base numeric, frozen_qty bigint, frozen_gmv numeric, frozen_gate_met boolean, frozen_amount bigint,
           return_base numeric, return_gmv numeric, return_events integer, eligible_base numeric, net_gmv numeric, gate_met boolean,
           recomputed_qty bigint, recomputed_amount bigint, delta bigint);
  INSERT INTO public.cms_return_close_report_events (report_id, program_id, return_event_id, financial_fp, original_order_line_id,
    disposition, user_id, program_product_id, base, refund, recorded_at)
  SELECT v_id, p_program_id, x.id, x.fp, x.line, x.disp, x.user_id, x.ppid, x.base, x.refund, x.recorded_at::timestamptz
    FROM jsonb_to_recordset(v_ret) AS x(id text, fp text, line text, disp text, user_id uuid, ppid uuid, base numeric, refund numeric,
                                        recorded_at text);
  INSERT INTO public.cms_return_baselines (program_id, return_event_id, fp_version, financial_fp, return_document_id,
    original_order_line_id, original_order_id, product_id, base_quantity, refund_amount, recorded_at, accepted_eval_seq, accepted_report_id)
  SELECT p_program_id, x.id, 'cms-return-fp-v1', x.fp, x.doc, x.line, x.order_id, x.product_id, x.base, x.refund, x.recorded_at::timestamptz,
         v_seq, v_id
    FROM jsonb_to_recordset(v_ret) AS x(id text, fp text, doc text, line text, order_id text, product_id text, disp text, base numeric,
                                        refund numeric, recorded_at text, led boolean)
   -- led = probe PK ở bước 5 (không anti-join: bench 14/11 Nested Loop Anti Join + Materialize = 199.990.000 so sánh, 15,6 s); lệch
   -- (không thể dưới khoá) ⇒ vi phạm PK ⇒ rollback cả lượt.
   WHERE x.disp IN ('APPLIED', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE') AND NOT x.led;
  GET DIAGNOSTICS v_new = ROW_COUNT;
  IF (SELECT count(*) FROM public.cms_return_baselines WHERE program_id = p_program_id) IS DISTINCT FROM v_nb0 + v_new
     OR (SELECT count(*) FROM public.cms_return_close_report_lines WHERE report_id = v_id) IS DISTINCT FROM v_nlines::bigint
     OR (SELECT COALESCE(sum(l.frozen_amount), 0) FROM public.cms_return_close_report_lines l WHERE l.report_id = v_id)
          IS DISTINCT FROM v_pay.amount_vnd::numeric
     OR (SELECT count(*) FROM public.cms_return_close_report_events WHERE report_id = v_id) IS DISTINCT FROM v_nev::bigint
     OR EXISTS (SELECT 1 FROM public.cms_return_conflicts c WHERE c.program_id = p_program_id
                   AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id))
     -- Trả hàng chỉ làm giảm B / GMV; F và gate đơn điệu ⇒ không dòng nào tăng; không phiếu APPLIED ⇒ tính lại = số chốt (bắt lệch công
     -- thức so với 122 nếu sau này sửa một bên — db-reviewer 14/11 P2-4).
     OR EXISTS (SELECT 1 FROM public.cms_return_close_report_lines l WHERE l.report_id = v_id AND l.delta > 0)
     OR (NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v_ret) AS x(disp text) WHERE x.disp = 'APPLIED') AND v_recomp IS DISTINCT FROM v_frozen)
     OR v_seq IS DISTINCT FROM (SELECT max(e.eval_seq) FROM public.cms_return_ledger_evals e WHERE e.program_id = p_program_id) THEN
    RAISE EXCEPTION 'CMS_REPORT_ASSERT' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('saved', true, 'already', false, 'report_id', v_id, 'eval_seq', v_seq, 'frozen_amount', v_frozen::text,
                            'recomputed_amount', v_recomp::text, 'delta_amount', (v_recomp - v_frozen)::text, 'return_events', v_nev,
                            'line_count', v_nlines, 'baselines_new', v_new);
END;
$$;

-- Dòng bán đã đóng băng của run chốt (service_role — job sau chốt tính oracle đối chiếu ở app; DB không nhận số app). Chỉ chương trình
-- đã chốt. Keyset theo seq.
CREATE FUNCTION public.rpc_cms_frozen_sales_lines(p_program_id uuid, p_after_seq integer, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog public.cms_programs%ROWTYPE;
  v_pay  public.cms_payouts%ROWTYPE;
  v_rows jsonb;
  v_next integer;
BEGIN
  IF p_program_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 OR (p_after_seq IS NOT NULL AND p_after_seq < 0) THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id;
  SELECT * INTO v_pay FROM public.cms_payouts WHERE program_id = p_program_id;
  IF v_prog.status IS DISTINCT FROM 'locked' OR v_pay.run_id IS NULL THEN
    RAISE EXCEPTION 'CMS_REPORT_NOT_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'seq', q.seq, 'order_line_id', q.order_line_id, 'order_id', q.order_id, 'order_code', q.order_code, 'product_id', q.product_id,
      'program_product_id', q.program_product_id, 'seller_email', q.seller_email, 'user_id', q.user_id, 'store_id', q.store_id,
      'pos_code', q.pos_code, 'completed_at', public.cms__ts(q.completed_at), 'source_updated_at', public.cms__ts(q.source_updated_at),
      'quantity_raw', q.quantity_raw, 'uom_raw', q.uom_raw, 'base_quantity', q.base_quantity::text, 'gmv_amount', q.gmv_amount::text,
      'disposition', q.disposition, 'unassigned_reason', q.unassigned_reason) ORDER BY q.seq), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT * FROM public.cms_sales_lines sl WHERE sl.run_id = v_pay.run_id AND sl.seq > COALESCE(p_after_seq, -1)
           ORDER BY sl.seq LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'seq')::integer;
  END IF;
  RETURN jsonb_build_object('program_id', p_program_id, 'payout_run_id', v_pay.run_id, 'payout_amount_vnd', v_pay.amount_vnd::text,
                            'contract', public.cms__run_contract(v_pay.run_id), 'rows', v_rows, 'next_after_seq', v_next);
END;
$$;

-- Reader báo cáo (authenticated: super + chương trình đọc được — QA cần marker).
CREATE FUNCTION public.rpc_cms_return_close_reports(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin() OR NOT COALESCE(p_program_id = ANY (public.cms_readable_program_ids()), false) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('program_id', p_program_id, 'reports', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', r.id, 'payout_run_id', r.payout_run_id, 'eval_seq', r.eval_seq,
                                        'returns_as_of', public.cms__ts(r.returns_as_of), 'frozen_amount', r.frozen_amount::text,
                                        'recomputed_amount', r.recomputed_amount::text, 'delta_amount', r.delta_amount::text,
                                        'return_events', r.return_events, 'line_count', r.line_count, 'created_via', r.created_via,
                                        'created_at', public.cms__ts(r.created_at)) ORDER BY r.eval_seq DESC)
      FROM public.cms_return_close_reports r WHERE r.program_id = p_program_id), '[]'::jsonb));
END;
$$;

CREATE FUNCTION public.rpc_cms_return_close_report(p_report_id uuid, p_after integer, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r    public.cms_return_close_reports%ROWTYPE;
  v_rows jsonb;
  v_next integer;
BEGIN
  IF p_report_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 OR (p_after IS NOT NULL AND p_after < 0) THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_r FROM public.cms_return_close_reports WHERE id = p_report_id;
  IF NOT FOUND OR NOT COALESCE(v_r.program_id = ANY (public.cms_readable_program_ids()), false) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'line_no', q.line_no, 'user_id', q.user_id, 'program_product_id', q.program_product_id, 'product_id', q.product_id,
      'gmv_basis', q.gmv_basis, 'per_unit', q.per_unit::text, 'frozen_base', q.frozen_base::text, 'frozen_qty', q.frozen_qty::text,
      'frozen_gmv', q.frozen_gmv::text, 'frozen_gate_met', q.frozen_gate_met, 'frozen_amount', q.frozen_amount::text,
      'return_base', q.return_base::text, 'return_gmv', q.return_gmv::text, 'return_events', q.return_events,
      'eligible_base', q.eligible_base::text, 'net_gmv', q.net_gmv::text, 'gate_met', q.gate_met,
      'recomputed_qty', q.recomputed_qty::text, 'recomputed_amount', q.recomputed_amount::text, 'delta', q.delta::text,
      'full_name', (SELECT u.full_name FROM public.users u WHERE u.id = q.user_id)) ORDER BY q.line_no), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT * FROM public.cms_return_close_report_lines l WHERE l.report_id = p_report_id AND l.line_no > COALESCE(p_after, -1)
           ORDER BY l.line_no LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'line_no')::integer;
  END IF;
  RETURN jsonb_build_object(
    'report', jsonb_build_object('id', v_r.id, 'program_id', v_r.program_id, 'payout_run_id', v_r.payout_run_id, 'eval_seq', v_r.eval_seq,
      'source_pin', v_r.source_pin, 'returns_as_of', public.cms__ts(v_r.returns_as_of), 'returns_digest', v_r.returns_digest,
      'frozen_amount', v_r.frozen_amount::text, 'recomputed_amount', v_r.recomputed_amount::text, 'delta_amount', v_r.delta_amount::text,
      'return_events', v_r.return_events, 'line_count', v_r.line_count, 'created_via', v_r.created_via,
      'created_at', public.cms__ts(v_r.created_at), 'not_a_payment_order', true),
    'lines', v_rows, 'next_after', v_next);
END;
$$;

-- Sự kiện báo cáo — keyset theo return_event_id byte (COLLATE "C", index cms_return_close_report_events_key_idx), không cắt ở 1.000
-- (db-reviewer 14/11 P2-6). Cùng quyền reader báo cáo.
CREATE FUNCTION public.rpc_cms_return_close_report_events(p_report_id uuid, p_after text, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r    public.cms_return_close_reports%ROWTYPE;
  v_rows jsonb;
  v_next text;
BEGIN
  IF p_report_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000
     OR (p_after IS NOT NULL AND p_after !~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$') THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_r FROM public.cms_return_close_reports WHERE id = p_report_id;
  IF NOT FOUND OR NOT COALESCE(v_r.program_id = ANY (public.cms_readable_program_ids()), false) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('return_event_id', q.return_event_id, 'original_order_line_id', q.original_order_line_id,
                                              'disposition', q.disposition, 'user_id', q.user_id, 'program_product_id', q.program_product_id,
                                              'base', q.base::text, 'refund', q.refund::text, 'recorded_at', public.cms__ts(q.recorded_at))
                            ORDER BY q.k), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT x.*, x.return_event_id COLLATE "C" AS k FROM public.cms_return_close_report_events x
           WHERE x.report_id = p_report_id AND (p_after IS NULL OR x.return_event_id COLLATE "C" > p_after COLLATE "C")
           ORDER BY x.return_event_id COLLATE "C" LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := v_rows -> (p_limit - 1) ->> 'return_event_id';
  END IF;
  RETURN jsonb_build_object('report_id', p_report_id, 'return_events', v_r.return_events, 'events', v_rows, 'next_after', v_next);
END;
$$;

-- ── R. Thân thay (định nghĩa cuối 120–126 + đoạn vá r-patches.sql; rollback dựng lại nguyên văn) ──
-- rpc_cms_sales_run_open: nền 124_cms_source_attestation.sql; vá khai-bao, ghim-run, tra-ve
CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_open(p_program_id uuid, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_prog public.cms_programs%ROWTYPE;
  v_snap jsonb;
  v_id   uuid;
  v_sch  smallint;  -- 124
  v_ct   boolean;   -- 130: run contract
BEGIN
  IF p_program_id IS NULL THEN RAISE EXCEPTION 'CMS_SALES_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  IF p_detail IS NULL OR jsonb_typeof(p_detail) <> 'object' OR pg_column_size(p_detail) > 4096 THEN
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
  -- 130: run contract ⇔ chương trình cms_unit HOẶC net_returns_v1. 6 cột ghim lấy từ CHƯƠNG TRÌNH (dòng đã khoá FOR UPDATE ở trên),
  -- không từ caller; run legacy để NULL ⇒ đường 122–126 nguyên hành vi. Chương trình active luôn có basis (cms_programs_basis_draft).
  IF v_prog.quantity_basis IS NULL THEN RAISE EXCEPTION 'CMS_BASIS_NOT_SET' USING ERRCODE = 'P0001'; END IF;
  v_ct := v_prog.quantity_basis <> 'pos_base' OR v_prog.returns_policy <> 'sales_only_v1';
  INSERT INTO public.cms_sync_runs (kind, program_id, config_version, is_test, mapping_fp, detail, quantity_basis,
    quantity_policy_version, returns_policy, calc_contract_version, unit_key_version, status_dictionary_version)
  VALUES ('sales', p_program_id, v_prog.config_version, v_prog.is_test, v_snap ->> 'mapping_fp', p_detail,
          CASE WHEN v_ct THEN v_prog.quantity_basis END,
          CASE WHEN v_ct THEN CASE v_prog.quantity_basis WHEN 'pos_base' THEN 'pos_base_v1' WHEN 'cms_unit' THEN 'cms_unit_v2' END END,
          CASE WHEN v_ct THEN v_prog.returns_policy END, CASE WHEN v_ct THEN 'cms-calc-ret2-v1' END,
          CASE WHEN v_ct THEN 'cms-unit-key-v2' END, CASE WHEN v_ct THEN 'cms-return-status-v1' END)
  RETURNING id, source_schema INTO v_id, v_sch;
  -- Worker không khai đúng hợp đồng (app cũ / cờ OFF) trên chương trình contract ⇒ VẪN có run (vết), đóng held ngay; pointer giữ.
  IF v_ct AND p_detail ->> 'calc_contract' IS DISTINCT FROM 'cms-calc-ret2-v1' THEN
    UPDATE public.cms_sync_runs SET status = 'held', finished_at = now(), error_code = 'CMS_WORKER_UNSUPPORTED' WHERE id = v_id;
    RETURN jsonb_build_object('run_id', v_id, 'held', true, 'error_code', 'CMS_WORKER_UNSUPPORTED');
  END IF;
  -- 124: capability lớp nguồn = giá trị THỰC của run vừa INSERT (DEFAULT 1 sau 124) — app không tự suy.
  RETURN v_snap || jsonb_build_object('run_id', v_id, 'source_schema', v_sch,
                                      'calc_contract_version', CASE WHEN v_ct THEN 'cms-calc-ret2-v1' END);
END;
$$;
-- rpc_cms_sales_run_stage: nền 124_cms_source_attestation.sql; vá re-nhanh
CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_stage(p_run_id uuid, p_part text, p_chunk_no integer, p_rows jsonb)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_run    public.cms_sync_runs%ROWTYPE;
  v_n      integer;
  v_count  integer;
  v_digest text;
  v_prev   record;
  c_uuid CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_dec  CONSTANT text := '^-?[0-9]{1,35}(\.[0-9]{1,9})?$';
  c_udec CONSTANT text := '^[0-9]{1,35}(\.[0-9]{1,9})?$';
  c_int  CONSTANT text := '^(0|[1-9][0-9]{0,18})$';
  c_sint CONSTANT text := '^-?(0|[1-9][0-9]{0,18})$';
  c_seq  CONSTANT text := '^(0|[1-9][0-9]{0,8})$';
  -- Miền tháng / ngày / giờ trong regex ⇒ ngày sai dạng thô (2026-13-45) ra mã CMS_*, không lỗi ép kiểu 22008.
  c_ts   CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$';
  c_pid  CONSTANT text := '^[1-9][0-9]{0,18}$';
  -- Ký tự điều khiển C0 / DEL / C1 bằng lớp tường minh (không phụ thuộc ctype DB; khớp CONTROL_RE của app — db-reviewer P2-3).
  c_txt  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,100}$';
  c_t50  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,50}$';
  c_t30  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,30}$';  -- 124: order_type / order_status thô
  c_mail CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]+$';  -- regex PG lặp tối đa 255; độ dài ≤ 320 + chữ thường do CHECK / kiểm dưới
BEGIN
  -- 130: run contract ⇒ thân riêng (whitelist part / cột khác); run legacy đi tiếp thân 124 nguyên văn.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = p_run_id AND calc_contract_version IS NOT NULL) THEN
    RETURN public.cms__stage_contract(p_run_id, p_part, p_chunk_no, p_rows);
  END IF;
  IF p_part IS NULL OR p_part NOT IN ('sales_lines', 'results', 'catalog', 'result_lines', 'source_lines') THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_PART' USING ERRCODE = '22023';
  END IF;
  IF p_chunk_no IS NULL OR p_chunk_no < 0 OR p_chunk_no >= 100000 THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_CHUNK' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROWS' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(p_rows);
  IF v_n = 0 OR v_n > 5000 THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_CHUNK' USING ERRCODE = '22023';
  END IF;
  -- Khoá run: các khối của cùng run ghi tuần tự; seal / finish chờ khối đang ghi.
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.kind <> 'sales' OR v_run.status <> 'running' THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  -- seal_begin đã đóng băng staging ⇒ không ghi thêm (bước seal đối chiếu đúng tập đã đếm).
  IF v_run.seal_expect IS NOT NULL OR v_run.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'CMS_STAGE_SEALED' USING ERRCODE = 'P0001'; END IF;
  IF v_run.started_at < now() - interval '30 minutes' THEN RAISE EXCEPTION 'CMS_SYNC_RUN_STALE' USING ERRCODE = 'P0001'; END IF;

  v_digest := md5(p_rows::text);
  SELECT row_count, digest INTO v_prev FROM public.cms_sync_run_chunks
   WHERE run_id = p_run_id AND part = p_part AND chunk_no = p_chunk_no;
  IF FOUND THEN
    IF v_prev.row_count = v_n AND v_prev.digest = v_digest THEN
      RETURN v_n;  -- retry khối đã ghi: không ghi lại
    END IF;
    RAISE EXCEPTION 'CMS_STAGE_CHUNK_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) e WHERE jsonb_typeof(e) <> 'object') THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
  END IF;

  -- Kiểm kiểu JSON một lượt (SQL/JSON path, chạy trong C): app gửi MỌI số dạng chuỗi ⇒ số / object / mảng ở bất kỳ trường
  -- nào ⇒ lỗi dòng; boolean chỉ được ở trường boolean của results / catalog. Sau đó đọc bằng jsonb_to_recordset và kiểm
  -- định dạng bằng regex trên cột (không gọi hàm theo từng trường — r1 chậm ~0,45 s / khối 1.000 dòng).
  -- strict: lax tự mở mảng ⇒ ["x"] / [] ở trường text lọt qua (db-reviewer r2 N3).
  IF jsonb_path_exists(p_rows, 'strict $[*].* ? (@.type() == "number" || @.type() == "object" || @.type() == "array")')
     OR (p_part IN ('sales_lines', 'result_lines', 'source_lines') AND jsonb_path_exists(p_rows, 'strict $[*].* ? (@.type() == "boolean")'))
     -- Trường boolean phải là boolean JSON (chuỗi 'true' / 'abc' ⇒ lỗi dòng, không để lọt lỗi ép kiểu thô).
     OR (p_part = 'results' AND jsonb_path_exists(p_rows, '$[*] ? (@.at_cap.type() != "boolean" || @.gate_met.type() != "boolean")'))
     OR (p_part = 'catalog' AND jsonb_path_exists(p_rows, '$[*] ? (@.met.type() != "boolean")')) THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
  END IF;

  -- Khối bắt lỗi ép kiểu: ngày qua regex nhưng không tồn tại (30/02, năm 0000) ⇒ CMS_STAGE_BAD_ROW, không lỗi thô 22008
  -- (db-reviewer r2 N4). Trùng khoá / CHECK vẫn lộ mã gốc (kiểm thử dựa vào).
  BEGIN
  IF p_part = 'source_lines' THEN
    -- 124: lớp NGUỒN — chỉ run mở sau 124 (source_schema = 1). MỌI dòng hợp lệ adapter đọc trong kỳ + SP (kể cả ONLINE / chưa
    -- hoàn tất), 14 trường thô đã chuẩn hoá; không phân loại engine. Cùng lớp ký tự / độ dài / dạng số như sales_lines.
    IF v_run.source_schema IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_PART' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, order_id text, order_code text, product_id text,
             seller_email text, pos_code text, order_type text, order_status text, completed_at text, source_updated_at text,
             quantity_raw text, uom_raw text, base_quantity text, gmv_amount text)
       WHERE NOT (COALESCE(x.order_line_id ~ c_txt AND x.order_id ~ c_txt AND x.order_code ~ c_txt AND x.product_id ~ c_pid
                           AND x.order_type ~ c_t30 AND x.order_status ~ c_t30 AND x.completed_at ~ c_ts
                           AND x.source_updated_at ~ c_ts AND x.base_quantity ~ c_dec AND x.gmv_amount ~ c_dec, false)
                  AND (x.seller_email IS NULL OR (x.seller_email ~ c_mail AND char_length(x.seller_email) <= 320
                                                  AND x.seller_email = lower(x.seller_email)))
                  AND (x.pos_code IS NULL OR x.pos_code ~ c_t50)
                  AND (x.quantity_raw IS NULL OR x.quantity_raw ~ c_t50) AND (x.uom_raw IS NULL OR x.uom_raw ~ c_t50))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_sales_source_lines (run_id, program_id, order_line_id, order_id, order_code, product_id, seller_email,
      pos_code, order_type, order_status, completed_at, source_updated_at, quantity_raw, uom_raw, base_quantity, gmv_amount)
    SELECT p_run_id, v_run.program_id, x.order_line_id, x.order_id, x.order_code, x.product_id, x.seller_email, x.pos_code,
           x.order_type, x.order_status, x.completed_at::timestamptz, x.source_updated_at::timestamptz, x.quantity_raw, x.uom_raw,
           x.base_quantity::numeric, x.gmv_amount::numeric
      FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, order_id text, order_code text, product_id text,
             seller_email text, pos_code text, order_type text, order_status text, completed_at text, source_updated_at text,
             quantity_raw text, uom_raw text, base_quantity text, gmv_amount text);
    GET DIAGNOSTICS v_count = ROW_COUNT;  -- ngay sau INSERT
  ELSIF p_part = 'sales_lines' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, order_id text, order_code text, product_id text,
             program_product_id text, seller_email text, user_id text, store_id text, pos_code text, completed_at text,
             source_updated_at text, quantity_raw text, uom_raw text, base_quantity text, gmv_amount text, disposition text,
             unassigned_reason text)
       WHERE NOT (COALESCE(x.order_line_id ~ c_txt AND x.seq ~ c_seq AND x.order_id ~ c_txt AND x.order_code ~ c_txt
                           AND x.product_id ~ c_pid AND x.program_product_id ~ c_uuid AND x.completed_at ~ c_ts
                           AND x.source_updated_at ~ c_ts AND x.base_quantity ~ c_dec AND x.gmv_amount ~ c_dec
                           AND x.disposition ~ '^(INCLUDED|UNASSIGNED|OUT_OF_SCOPE)$', false)
                  AND (x.seller_email IS NULL OR (x.seller_email ~ c_mail AND char_length(x.seller_email) <= 320
                                                  AND x.seller_email = lower(x.seller_email)))
                  AND (x.user_id IS NULL OR x.user_id ~ c_uuid)
                  AND (x.store_id IS NULL OR x.store_id ~ c_uuid) AND (x.pos_code IS NULL OR x.pos_code ~ c_t50)
                  AND (x.quantity_raw IS NULL OR x.quantity_raw ~ c_t50) AND (x.uom_raw IS NULL OR x.uom_raw ~ c_t50)
                  AND (x.unassigned_reason IS NULL
                       OR x.unassigned_reason ~ '^(NO_EMAIL|NOT_FOUND|MULTIPLE|SHARED_ACCOUNT|NOT_STAFF|STORE_NOT_ELIGIBLE)$'))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_sales_lines (run_id, program_id, order_line_id, seq, order_id, order_code, product_id,
      program_product_id, seller_email, user_id, store_id, pos_code, completed_at, source_updated_at, quantity_raw, uom_raw,
      base_quantity, gmv_amount, disposition, unassigned_reason)
    SELECT p_run_id, v_run.program_id, x.order_line_id, x.seq::integer, x.order_id, x.order_code, x.product_id,
           x.program_product_id::uuid, x.seller_email, x.user_id::uuid, x.store_id::uuid, x.pos_code, x.completed_at::timestamptz,
           x.source_updated_at::timestamptz, x.quantity_raw, x.uom_raw, x.base_quantity::numeric, x.gmv_amount::numeric,
           x.disposition, x.unassigned_reason
      FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, order_id text, order_code text, product_id text,
             program_product_id text, seller_email text, user_id text, store_id text, pos_code text, completed_at text,
             source_updated_at text, quantity_raw text, uom_raw text, base_quantity text, gmv_amount text, disposition text,
             unassigned_reason text);
    GET DIAGNOSTICS v_count = ROW_COUNT;  -- ngay sau INSERT (một câu SQL chen giữa sẽ ghi đè ROW_COUNT — db-reviewer r3 R3-3)
  ELSIF p_part = 'results' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(program_product_id text, product_id text, user_id text, store_id text,
             gmv_basis text, base_quantity text, per_unit text, cms_quantity text, rewarded_quantity text, cap_quantity text,
             at_cap boolean, gmv_amount text, gate_gmv text, target_gmv text, gate_met boolean, gate_met_at text,
             potential_amount text, amount_vnd text, line_count text)
       WHERE NOT (COALESCE(x.program_product_id ~ c_uuid AND x.product_id ~ c_pid AND x.user_id ~ c_uuid AND x.store_id ~ c_uuid
                           AND x.gmv_basis ~ '^(product|catalog|none)$' AND x.base_quantity ~ c_dec AND x.per_unit ~ c_udec
                           AND x.cms_quantity ~ c_int AND x.rewarded_quantity ~ c_int AND x.at_cap IS NOT NULL
                           AND x.gmv_amount ~ c_dec AND x.gate_met IS NOT NULL AND x.potential_amount ~ c_int
                           AND x.amount_vnd ~ c_int AND x.line_count ~ c_seq, false)
                  AND (x.cap_quantity IS NULL OR x.cap_quantity ~ c_int) AND (x.gate_gmv IS NULL OR x.gate_gmv ~ c_dec)
                  AND (x.target_gmv IS NULL OR x.target_gmv ~ c_int) AND (x.gate_met_at IS NULL OR x.gate_met_at ~ c_ts))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    -- Miền bigint kiểm SAU khi đã chắc định dạng (ép kiểu an toàn); vượt ⇒ lỗi dòng, không để lọt lỗi ép kiểu thô.
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(cms_quantity text, rewarded_quantity text, cap_quantity text, target_gmv text,
             potential_amount text, amount_vnd text)
       WHERE x.cms_quantity::numeric > 9223372036854775807 OR x.rewarded_quantity::numeric > 9223372036854775807
          OR COALESCE(x.cap_quantity::numeric, 0) > 9223372036854775807 OR COALESCE(x.target_gmv::numeric, 0) > 9223372036854775807
          OR x.potential_amount::numeric > 9223372036854775807 OR x.amount_vnd::numeric > 9223372036854775807) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_results (run_id, program_id, program_product_id, product_id, user_id, store_id, gmv_basis,
      base_quantity, per_unit, cms_quantity, rewarded_quantity, cap_quantity, at_cap, gmv_amount, gate_gmv, target_gmv, gate_met,
      gate_met_at, potential_amount, amount_vnd, line_count)
    SELECT p_run_id, v_run.program_id, x.program_product_id::uuid, x.product_id, x.user_id::uuid, x.store_id::uuid, x.gmv_basis,
           x.base_quantity::numeric, x.per_unit::numeric, x.cms_quantity::bigint, x.rewarded_quantity::bigint,
           x.cap_quantity::bigint, x.at_cap, x.gmv_amount::numeric, x.gate_gmv::numeric, x.target_gmv::bigint, x.gate_met,
           x.gate_met_at::timestamptz, x.potential_amount::bigint, x.amount_vnd::bigint, x.line_count::integer
      FROM jsonb_to_recordset(p_rows) AS x(program_product_id text, product_id text, user_id text, store_id text,
             gmv_basis text, base_quantity text, per_unit text, cms_quantity text, rewarded_quantity text, cap_quantity text,
             at_cap boolean, gmv_amount text, gate_gmv text, target_gmv text, gate_met boolean, gate_met_at text,
             potential_amount text, amount_vnd text, line_count text);
    GET DIAGNOSTICS v_count = ROW_COUNT;  -- ngay sau INSERT (một câu SQL chen giữa sẽ ghi đè ROW_COUNT — db-reviewer r3 R3-3)
  ELSIF p_part = 'catalog' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(user_id text, store_id text, catalog_gmv text, target_gmv text, met boolean,
             met_at text, line_count text)
       WHERE NOT (COALESCE(x.user_id ~ c_uuid AND x.store_id ~ c_uuid AND x.catalog_gmv ~ c_dec AND x.target_gmv ~ c_int
                           AND x.met IS NOT NULL AND x.line_count ~ c_seq, false)
                  AND (x.met_at IS NULL OR x.met_at ~ c_ts))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(target_gmv text) WHERE x.target_gmv::numeric > 9223372036854775807) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_result_catalog (run_id, program_id, user_id, store_id, catalog_gmv, target_gmv, met, met_at, line_count)
    SELECT p_run_id, v_run.program_id, x.user_id::uuid, x.store_id::uuid, x.catalog_gmv::numeric, x.target_gmv::bigint, x.met,
           x.met_at::timestamptz, x.line_count::integer
      FROM jsonb_to_recordset(p_rows) AS x(user_id text, store_id text, catalog_gmv text, target_gmv text, met boolean,
             met_at text, line_count text);
    GET DIAGNOSTICS v_count = ROW_COUNT;  -- ngay sau INSERT (một câu SQL chen giữa sẽ ghi đè ROW_COUNT — db-reviewer r3 R3-3)
  ELSE
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, user_id text, program_product_id text,
             base_before text, base_after text, qty_before text, qty_after text, amount_vnd text, status text)
       WHERE NOT COALESCE(x.order_line_id ~ c_txt AND x.seq ~ c_seq AND x.user_id ~ c_uuid AND x.program_product_id ~ c_uuid
                          AND x.base_before ~ c_dec AND x.base_after ~ c_dec AND x.qty_before ~ c_int AND x.qty_after ~ c_int
                          AND x.amount_vnd ~ c_sint
                          AND x.status ~ '^(WAITING_GATE|ACCUMULATING|RECORDED|AT_CAP|ADJUSTMENT)$', false)) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(qty_before text, qty_after text, amount_vnd text)
       WHERE x.qty_before::numeric > 9223372036854775807 OR x.qty_after::numeric > 9223372036854775807
          OR abs(x.amount_vnd::numeric) > 9223372036854775807) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_result_lines (run_id, program_id, order_line_id, seq, user_id, program_product_id, base_before,
      base_after, qty_before, qty_after, amount_vnd, status)
    SELECT p_run_id, v_run.program_id, x.order_line_id, x.seq::integer, x.user_id::uuid, x.program_product_id::uuid,
           x.base_before::numeric, x.base_after::numeric, x.qty_before::bigint, x.qty_after::bigint, x.amount_vnd::bigint, x.status
      FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, user_id text, program_product_id text,
             base_before text, base_after text, qty_before text, qty_after text, amount_vnd text, status text);
    GET DIAGNOSTICS v_count = ROW_COUNT;  -- ngay sau INSERT (một câu SQL chen giữa sẽ ghi đè ROW_COUNT — db-reviewer r3 R3-3)
  END IF;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
  END;
  IF v_count <> v_n THEN RAISE EXCEPTION 'CMS_STAGE_COUNT_MISMATCH' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.cms_sync_run_chunks (run_id, part, chunk_no, row_count, digest) VALUES (p_run_id, p_part, p_chunk_no, v_n, v_digest);
  UPDATE public.cms_sync_runs SET rows_written = rows_written + v_n WHERE id = p_run_id;
  RETURN v_n;
END;
$$;
-- rpc_cms_sales_run_cleanup: nền 124_cms_source_attestation.sql; vá bang-contract, clear-kiem
CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_cleanup(p_program_id uuid, p_max_rows integer DEFAULT 50000)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_cur  uuid;
  v_prev uuid;
  v_id   uuid;
  v_left integer;
  v_n    integer;
  v_del  integer := 0;
  v_done boolean := false;
BEGIN
  -- Trần 50.000 dòng / lần = lô app (r2.3, PM 03/11: lô 100.000 vượt statement_timeout 8 s trên PG15 khi máy tải; lô 50.000 đo
  -- local 1,4–3,5 s tuỳ tải, kể cả ở tập lưu giữ tối đa — dưới 8 s, không phải SLA).
  IF p_program_id IS NULL OR p_max_rows IS NULL OR p_max_rows < 1 OR p_max_rows > 50000 THEN
    RAISE EXCEPTION 'CMS_SALES_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT current_result_run_id INTO v_cur FROM public.cms_programs WHERE id = p_program_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- Tập run ok không đổi khi giữ FOR SHARE (chỉ publish đổi, cần FOR UPDATE) ⇒ v_prev ổn định trong hàm.
  SELECT id INTO v_prev FROM public.cms_sync_runs
   WHERE program_id = p_program_id AND kind = 'sales' AND status = 'ok' AND id IS DISTINCT FROM v_cur
   ORDER BY published_at DESC, id DESC LIMIT 1;
  SELECT id INTO v_id FROM public.cms_sync_runs
   WHERE program_id = p_program_id AND kind = 'sales' AND purged_at IS NOT NULL AND cleared_at IS NULL
   ORDER BY purged_at, id LIMIT 1;
  IF v_id IS NULL THEN
    -- 2 run held / error gần nhất (tie-break xác định) tính TRONG CÙNG câu lệnh chọn ứng viên (một snapshot): run vừa chuyển
    -- running → held / error giữa hai câu lệnh không thể bị chọn dọn trong khi bị loại khỏi tập giữ (db-reviewer r2.2 P2-1).
    SELECT r.id INTO v_id FROM public.cms_sync_runs r
     WHERE r.program_id = p_program_id AND r.kind = 'sales' AND r.purged_at IS NULL AND r.status <> 'running'
       AND r.id IS DISTINCT FROM v_cur AND r.id IS DISTINCT FROM v_prev
       AND (r.status = 'ok' OR r.finished_at < now() - interval '24 hours'
            OR r.id NOT IN (SELECT k.id FROM public.cms_sync_runs k
                             WHERE k.program_id = p_program_id AND k.kind = 'sales' AND k.status IN ('held', 'error')
                             ORDER BY k.finished_at DESC, k.id DESC LIMIT 2))
     ORDER BY r.started_at, r.id LIMIT 1;
    IF v_id IS NOT NULL THEN
      UPDATE public.cms_sync_runs SET purged_at = now() WHERE id = v_id AND purged_at IS NULL AND status <> 'running';
      IF NOT FOUND THEN v_id := NULL; END IF;
    END IF;
  END IF;
  IF v_id IS NOT NULL THEN
    v_left := p_max_rows;
    -- 130: bảng run contract trước (FK tới cms_sales_lines / cms_results / cms_return_lines). Còn dòng ⇒ v_left = 0 ⇒ chuỗi dưới
    -- (LIMIT 0 / điều kiện v_left > 0) không chạm bảng cha ở lượt này.
    DELETE FROM public.cms_result_events WHERE ctid IN (SELECT ctid FROM public.cms_result_events WHERE run_id = v_id LIMIT v_left);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_result_events WHERE run_id = v_id) THEN
      DELETE FROM public.cms_return_lines WHERE ctid IN (SELECT ctid FROM public.cms_return_lines WHERE run_id = v_id LIMIT v_left);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
    DELETE FROM public.cms_result_lines WHERE ctid IN (SELECT ctid FROM public.cms_result_lines WHERE run_id = v_id LIMIT v_left);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_result_catalog WHERE ctid IN (SELECT ctid FROM public.cms_result_catalog WHERE run_id = v_id LIMIT v_left);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_results WHERE ctid IN (SELECT ctid FROM public.cms_results WHERE run_id = v_id LIMIT v_left);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_sales_lines WHERE ctid IN (SELECT ctid FROM public.cms_sales_lines WHERE run_id = v_id LIMIT v_left);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
    -- 124: lớp nguồn sau lớp engine, trước khối.
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_sales_source_lines WHERE ctid IN (SELECT ctid FROM public.cms_sales_source_lines WHERE run_id = v_id LIMIT v_left);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_sales_source_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_sync_run_chunks WHERE run_id = v_id;
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_result_catalog WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_results WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_sales_source_lines WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_sync_run_chunks WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_result_events WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_return_lines WHERE run_id = v_id) THEN
      UPDATE public.cms_sync_runs SET cleared_at = now() WHERE id = v_id;
      v_done := true;
    END IF;
  END IF;
  RETURN jsonb_build_object('purged', CASE WHEN v_done THEN 1 ELSE 0 END, 'deleted', v_del, 'more',
    EXISTS (SELECT 1 FROM public.cms_sync_runs
             WHERE program_id = p_program_id AND kind = 'sales' AND purged_at IS NOT NULL AND cleared_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.cms_sync_runs r
                WHERE r.program_id = p_program_id AND r.kind = 'sales' AND r.purged_at IS NULL AND r.status <> 'running'
                  AND r.id IS DISTINCT FROM v_cur AND r.id IS DISTINCT FROM v_prev
                  AND (r.status = 'ok' OR r.finished_at < now() - interval '24 hours'
                       OR r.id NOT IN (SELECT k.id FROM public.cms_sync_runs k
                                        WHERE k.program_id = p_program_id AND k.kind = 'sales' AND k.status IN ('held', 'error')
                                        ORDER BY k.finished_at DESC, k.id DESC LIMIT 2))));
END;
$$;
-- cms__lock_eval: nền 124_cms_source_attestation.sql; vá contract-che-do
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
    -- 130: run contract chưa chốt được trong batch này (payout / payout_staff / XLSX chốt đọc lớp legacy) ⇒ chặn. Chế độ chương trình
    -- phải khớp căn cứ của run hiện hành (legacy = pos_base + sales_only_v1): đổi chế độ mà pointer còn run cũ ⇒ chặn, không chốt số
    -- tính theo chế độ khác chế độ đang công bố cho chương trình.
    IF v_run.calc_contract_version IS NOT NULL THEN
      v_b := array_append(v_b, 'CMS_LOCK_CONTRACT_UNSUPPORTED');
    END IF;
    IF (v_prog.quantity_basis, v_prog.returns_policy) IS DISTINCT FROM
       (CASE WHEN v_run.calc_contract_version IS NULL THEN 'pos_base' ELSE v_run.quantity_basis END,
        CASE WHEN v_run.calc_contract_version IS NULL THEN 'sales_only_v1' ELSE v_run.returns_policy END) THEN
      v_b := array_append(v_b, 'CMS_LOCK_POLICY_POINTER_MISMATCH');
    END IF;
  END IF;
  -- 130 (D14): còn conflict trả hàng mở ⇒ không chốt (đọc dưới khoá chương trình của RPC chốt — cùng khoá ghi conflict).
  IF EXISTS (SELECT 1 FROM public.cms_return_conflicts c WHERE c.program_id = v_prog.id
              AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id)) THEN
    v_b := array_append(v_b, 'CMS_LOCK_RETURN_CONFLICT');
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
-- cms__attest_eval: nền 124_cms_source_attestation.sql; vá contract
CREATE OR REPLACE FUNCTION public.cms__attest_eval(p_program_id uuid, p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a    public.cms_source_attestations%ROWTYPE;
  v_run  public.cms_sync_runs%ROWTYPE;
  v_prog public.cms_programs%ROWTYPE;
  v_code text;
BEGIN
  SELECT * INTO v_a FROM public.cms_source_attestations
   WHERE run_id = p_run_id AND program_id = p_program_id AND revoked_at IS NULL AND superseded_by IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('code', 'NONE'); END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id;
  -- Kiểm lại MỌI trường quyết định của dòng chứng nhận (phòng dòng owner ghi thẳng — db-reviewer r2 P2-3).
  v_code := CASE
    -- 130: chứng nhận đối soát decision10 chỉ định nghĩa cho run legacy (lớp nguồn / vân tay 124) ⇒ run contract không dùng được.
    WHEN v_run.calc_contract_version IS NOT NULL THEN 'CONTRACT_UNSUPPORTED'
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
-- rpc_cms_sales_run_seal_begin: nền 122_cms_results.sql; vá re-nhanh
CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_seal_begin(p_run_id uuid, p_expect jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_run   public.cms_sync_runs%ROWTYPE;
  v_prog  public.cms_programs%ROWTYPE;
  v_part  text;
  v_n     bigint;
  c_cnt   CONSTANT text := '^(0|[1-9][0-9]{0,8})$';
BEGIN
  -- 130: run contract ⇒ expect / pin / part riêng, 13 bước.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = p_run_id AND calc_contract_version IS NOT NULL) THEN
    RETURN public.cms__seal_begin_contract(p_run_id, p_expect);
  END IF;
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
-- rpc_cms_sales_run_seal_step: nền 122_cms_results.sql; vá re-nhanh
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
BEGIN
  -- 130: run contract ⇒ 13 bước tự tính lại (cms__seal_contract_step).
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = p_run_id AND calc_contract_version IS NOT NULL) THEN
    RETURN public.cms__seal_contract_step(p_run_id, p_step);
  END IF;
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
-- cms__sales_snapshot: nền 122_cms_results.sql; vá san-pham, che-do
CREATE OR REPLACE FUNCTION public.cms__sales_snapshot(p_program_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'program_id', p.id,
    'status', p.status,
    'is_test', p.is_test,
    'config_version', p.config_version,
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
    'mapping_fp', public.cms__mapping_fp(),
    -- 130: chế độ của CHƯƠNG TRÌNH (run ghim riêng ở open); app cũ bỏ qua khoá lạ.
    'quantity_basis', p.quantity_basis, 'returns_policy', p.returns_policy)
  FROM public.cms_programs p WHERE p.id = p_program_id
$$;
-- rpc_cms_result_header: nền 122_cms_results.sql; vá chan-contract
CREATE OR REPLACE FUNCTION public.rpc_cms_result_header(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run  uuid;
  v_su   boolean := public.is_super_admin();
  v_cfg  integer;
  v_r    public.cms_sync_runs%ROWTYPE;
  v_last public.cms_sync_runs%ROWTYPE;
BEGIN
  v_run := public.cms__result_run(p_program_id, NULL);
  -- 130: run contract chỉ đọc qua reader v2 — app cũ / app rollback không hiện số run contract dưới nhãn pos_base / thiếu trả hàng.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = v_run AND calc_contract_version IS NOT NULL) THEN
    RAISE EXCEPTION 'CMS_RESULT_CONTRACT_UNSUPPORTED' USING ERRCODE = 'P0001';
  END IF;
  SELECT config_version INTO v_cfg FROM public.cms_programs WHERE id = p_program_id;
  SELECT * INTO v_last FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = p_program_id
   ORDER BY started_at DESC LIMIT 1;
  IF v_run IS NOT NULL THEN SELECT * INTO v_r FROM public.cms_sync_runs WHERE id = v_run; END IF;
  RETURN jsonb_build_object(
    'program_id', p_program_id,
    'config_version', v_cfg,
    'viewer', CASE WHEN v_su THEN 'super' ELSE (SELECT u.role FROM public.users u WHERE u.id = auth.uid()) END,
    'run', CASE WHEN v_run IS NULL THEN NULL ELSE
      jsonb_build_object('id', v_r.id, 'config_version', v_r.config_version, 'published_at', public.cms__ts(v_r.published_at),
                         'source_max_updated_at', public.cms__ts(v_r.source_max_updated_at), 'started_at', public.cms__ts(v_r.started_at))
      || CASE WHEN v_su THEN jsonb_build_object('amount_vnd', v_r.amount_vnd::text, 'rows_read', v_r.rows_read,
                                                'totals', v_r.detail -> 'totals') ELSE '{}'::jsonb END END,
    'last_attempt', CASE WHEN v_last.id IS NULL THEN NULL ELSE
      jsonb_build_object('status', v_last.status, 'started_at', public.cms__ts(v_last.started_at),
                         'finished_at', public.cms__ts(v_last.finished_at), 'is_current', v_last.id IS NOT DISTINCT FROM v_run)
      || CASE WHEN v_su THEN jsonb_build_object('id', v_last.id, 'error_code', v_last.error_code) ELSE '{}'::jsonb END END,
    'recent_runs', CASE WHEN v_su THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', q.id, 'status', q.status, 'error_code', q.error_code,
                                          'started_at', public.cms__ts(q.started_at), 'finished_at', public.cms__ts(q.finished_at),
                                          'rows_read', q.rows_read, 'amount_vnd', q.amount_vnd::text,
                                          'config_version', q.config_version, 'purged', q.purged_at IS NOT NULL)
                       ORDER BY q.started_at DESC)
        FROM (SELECT * FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = p_program_id
               ORDER BY started_at DESC LIMIT 10) q), '[]'::jsonb) END);
END;
$$;
-- rpc_cms_result_rows: nền 122_cms_results.sql; vá chan-contract
CREATE OR REPLACE FUNCTION public.rpc_cms_result_rows(p_program_id uuid, p_run_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run   uuid;
  v_users uuid[];
  v_n     bigint;
BEGIN
  v_run := public.cms__result_run(p_program_id, p_run_id);
  -- 130: run contract chỉ đọc qua reader v2 — app cũ / app rollback không hiện số run contract dưới nhãn pos_base / thiếu trả hàng.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = v_run AND calc_contract_version IS NOT NULL) THEN
    RAISE EXCEPTION 'CMS_RESULT_CONTRACT_UNSUPPORTED' USING ERRCODE = 'P0001';
  END IF;
  IF v_run IS NULL THEN
    RETURN jsonb_build_object('run_id', NULL, 'results', '[]'::jsonb, 'catalog', '[]'::jsonb, 'users', '[]'::jsonb);
  END IF;
  v_users := public.cms__visible_result_users();
  SELECT count(*) INTO v_n FROM public.cms_results r WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users));
  IF v_n > 50000 THEN RAISE EXCEPTION 'CMS_RESULT_TOO_LARGE' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object(
    'run_id', v_run,
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
-- rpc_cms_result_lines: nền 122_cms_results.sql; vá chan-contract
CREATE OR REPLACE FUNCTION public.rpc_cms_result_lines(p_program_id uuid, p_run_id uuid, p_program_product_id uuid DEFAULT NULL,
                                            p_user_id uuid DEFAULT NULL, p_after_seq integer DEFAULT NULL,
                                            p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run   uuid;
  v_users uuid[];
  v_rows  jsonb;
  v_next  integer;
BEGIN
  IF p_run_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_after_seq IS NOT NULL AND p_after_seq < 0) THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  v_run := public.cms__result_run(p_program_id, p_run_id);
  -- 130: run contract chỉ đọc qua reader v2 — app cũ / app rollback không hiện số run contract dưới nhãn pos_base / thiếu trả hàng.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = v_run AND calc_contract_version IS NOT NULL) THEN
    RAISE EXCEPTION 'CMS_RESULT_CONTRACT_UNSUPPORTED' USING ERRCODE = 'P0001';
  END IF;
  v_users := public.cms__visible_result_users();
  IF p_user_id IS NOT NULL AND v_users IS NOT NULL AND NOT (p_user_id = ANY (v_users)) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'seq', q.seq, 'order_line_id', q.order_line_id, 'order_code', q.order_code, 'product_id', q.product_id,
      'program_product_id', q.program_product_id, 'user_id', q.user_id, 'store_id', q.store_id, 'pos_code', q.pos_code,
      'completed_at', public.cms__ts(q.completed_at), 'quantity_raw', q.quantity_raw, 'uom_raw', q.uom_raw,
      'base_quantity', q.base_quantity::text, 'gmv_amount', q.gmv_amount::text, 'base_before', q.base_before::text,
      'base_after', q.base_after::text, 'qty_before', q.qty_before::text, 'qty_after', q.qty_after::text,
      'amount_vnd', q.amount_vnd::text, 'status', q.status) ORDER BY q.seq), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT rl.seq, rl.order_line_id, sl.order_code, sl.product_id, rl.program_product_id, rl.user_id, sl.store_id,
                 sl.pos_code, sl.completed_at, sl.quantity_raw, sl.uom_raw, sl.base_quantity, sl.gmv_amount, rl.base_before,
                 rl.base_after, rl.qty_before, rl.qty_after, rl.amount_vnd, rl.status
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
  RETURN jsonb_build_object('run_id', v_run, 'rows', v_rows, 'next_after_seq', v_next);
END;
$$;
-- rpc_cms_result_excluded: nền 122_cms_results.sql; vá chan-contract
CREATE OR REPLACE FUNCTION public.rpc_cms_result_excluded(p_program_id uuid, p_run_id uuid, p_after_seq integer DEFAULT NULL,
                                               p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run  uuid;
  v_rows jsonb;
  v_next integer;
BEGIN
  IF p_run_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_after_seq IS NOT NULL AND p_after_seq < 0) THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- Định danh nguồn lỗi (email người bán) chỉ cho super admin — kiểm TRƯỚC khi tra run để non-super không phân biệt được
  -- RUN_GONE / FORBIDDEN (không dò được run tồn tại — security review P2).
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  v_run := public.cms__result_run(p_program_id, p_run_id);
  -- 130: run contract chỉ đọc qua reader v2 — app cũ / app rollback không hiện số run contract dưới nhãn pos_base / thiếu trả hàng.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = v_run AND calc_contract_version IS NOT NULL) THEN
    RAISE EXCEPTION 'CMS_RESULT_CONTRACT_UNSUPPORTED' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'seq', q.seq, 'order_line_id', q.order_line_id, 'order_code', q.order_code, 'product_id', q.product_id,
      'program_product_id', q.program_product_id, 'disposition', q.disposition, 'unassigned_reason', q.unassigned_reason,
      'seller_email', q.seller_email, 'user_id', q.user_id, 'store_id', q.store_id, 'pos_code', q.pos_code,
      'completed_at', public.cms__ts(q.completed_at), 'base_quantity', q.base_quantity::text,
      'gmv_amount', q.gmv_amount::text) ORDER BY q.seq), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT * FROM public.cms_sales_lines sl
           WHERE sl.run_id = v_run AND sl.disposition <> 'INCLUDED' AND sl.seq > COALESCE(p_after_seq, -1)
           ORDER BY sl.seq LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'seq')::integer;
  END IF;
  RETURN jsonb_build_object('run_id', v_run, 'rows', v_rows, 'next_after_seq', v_next);
END;
$$;
-- rpc_cms_sales_run_publish: nền 126_cms_sales_only_results_release.sql; vá re-nhanh
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
  -- 130: run contract ⇒ publish atomic có ledger trả hàng (cms__publish_contract); phần dưới là đường legacy 126 nguyên văn.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE id = p_run_id AND calc_contract_version IS NOT NULL) THEN
    RETURN public.cms__publish_contract(p_run_id);
  END IF;
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
                    WHERE sl.run_id = p_run_id AND sl.disposition <> 'INCLUDED' AND (sl.base_quantity < 0 OR sl.gmv_amount < 0)))
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

-- ── 9. ACL: thu hồi đích danh rồi cấp đúng ma trận (gate ACL — áp cả hàm OR REPLACE) ──
REVOKE ALL ON FUNCTION
  public.cms__src_clean(text),
  public.cms__unit_key(text),
  public.cms__qty_dec(text),
  public.cms__return_status_effect(text),
  public.cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone),
  public.cms__programs_basis_guard(),
  public.cms__products_basis_guard(),
  public.rpc_cms_program_save_v2(jsonb),
  public.rpc_cms_program_set_returns_policy(uuid,text,integer,uuid),
  public.rpc_cms_capabilities(),
  public.cms__stage_contract(uuid,text,integer,jsonb),
  public.cms__seal_begin_contract(uuid,jsonb),
  public.cms__seal_contract_step(uuid,integer),
  public.cms__ledger_set_hash(uuid),
  public.cms__open_set_hash(uuid),
  public.cms__as_of_floor(uuid),
  public.cms__ledger_immutable(),
  public.cms__ledger_eval_guard(),
  public.cms__ledger_insert_guard(),
  public.cms__ledger_eval(uuid,text,uuid,timestamp with time zone,text,jsonb),
  public.cms__publish_contract(uuid),
  public.rpc_cms_return_conflicts_confirm_restored(uuid,text,bigint,text,uuid),
  public.cms__run_contract(uuid),
  public.rpc_cms_result_header_v2(uuid),
  public.rpc_cms_result_rows_v2(uuid,uuid),
  public.rpc_cms_result_events_v2(uuid,uuid,uuid,uuid,integer,integer),
  public.rpc_cms_result_excluded_v2(uuid,uuid,text,integer,integer),
  public.rpc_cms_result_returns_v2(uuid,uuid,integer,integer),
  public.rpc_cms_return_conflicts(uuid),
  public.cms__report_rows(jsonb),
  public.rpc_cms_return_close_report_save(uuid,uuid,jsonb),
  public.rpc_cms_frozen_sales_lines(uuid,integer,integer),
  public.rpc_cms_return_close_reports(uuid),
  public.rpc_cms_return_close_report(uuid,integer,integer),
  public.rpc_cms_return_close_report_events(uuid,text,integer),
  public.rpc_cms_sales_run_open(uuid,jsonb),
  public.rpc_cms_sales_run_stage(uuid,text,integer,jsonb),
  public.rpc_cms_sales_run_cleanup(uuid,integer),
  public.cms__lock_eval(uuid,uuid,integer,text,boolean),
  public.cms__attest_eval(uuid,uuid),
  public.rpc_cms_sales_run_seal_begin(uuid,jsonb),
  public.rpc_cms_sales_run_seal_step(uuid,integer),
  public.cms__sales_snapshot(uuid),
  public.rpc_cms_result_header(uuid),
  public.rpc_cms_result_rows(uuid,uuid),
  public.rpc_cms_result_lines(uuid,uuid,uuid,uuid,integer,integer),
  public.rpc_cms_result_excluded(uuid,uuid,integer,integer),
  public.rpc_cms_sales_run_publish(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_program_save_v2(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_program_set_returns_policy(uuid,text,integer,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_capabilities() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_return_conflicts_confirm_restored(uuid,text,bigint,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_result_header_v2(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_result_rows_v2(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_result_events_v2(uuid,uuid,uuid,uuid,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_result_excluded_v2(uuid,uuid,text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_result_returns_v2(uuid,uuid,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_return_conflicts(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_return_close_report_save(uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_frozen_sales_lines(uuid,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_return_close_reports(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_return_close_report(uuid,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_return_close_report_events(uuid,text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_sales_run_open(uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_sales_run_stage(uuid,text,integer,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_sales_run_cleanup(uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_sales_run_seal_begin(uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_sales_run_seal_step(uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_result_header(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_result_rows(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_result_lines(uuid,uuid,uuid,uuid,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_result_excluded(uuid,uuid,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_sales_run_publish(uuid) TO service_role;
-- Thu hồi mọi grant khác owner do default privileges cấp (bài học SEC-1 / 091 / 117 / 120–127), trừ đúng ma trận.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, a.grantee
      FROM (VALUES ('cms__src_clean(text)', false, false, false, NULL::text),
              ('cms__unit_key(text)', false, false, false, NULL),
              ('cms__qty_dec(text)', false, false, false, NULL),
              ('cms__return_status_effect(text)', false, false, false, NULL),
              ('cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone)', false, false, false, NULL),
              ('cms__programs_basis_guard()', false, false, false, NULL),
              ('cms__products_basis_guard()', false, false, false, NULL),
              ('rpc_cms_program_save_v2(jsonb)', false, false, true, 'service_role:EXECUTE'),
              ('rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)', false, false, true, 'service_role:EXECUTE'),
              ('rpc_cms_capabilities()', false, true, true, 'authenticated:EXECUTE,service_role:EXECUTE'),
              ('cms__stage_contract(uuid,text,integer,jsonb)', false, false, false, NULL),
              ('cms__seal_begin_contract(uuid,jsonb)', false, false, false, NULL),
              ('cms__seal_contract_step(uuid,integer)', false, false, false, NULL),
              ('cms__ledger_set_hash(uuid)', false, false, false, NULL),
              ('cms__open_set_hash(uuid)', false, false, false, NULL),
              ('cms__as_of_floor(uuid)', false, false, false, NULL),
              ('cms__ledger_immutable()', false, false, false, NULL),
              ('cms__ledger_eval_guard()', false, false, false, NULL),
              ('cms__ledger_insert_guard()', false, false, false, NULL),
              ('cms__ledger_eval(uuid,text,uuid,timestamp with time zone,text,jsonb)', false, false, false, NULL),
              ('cms__publish_contract(uuid)', false, false, false, NULL),
              ('rpc_cms_return_conflicts_confirm_restored(uuid,text,bigint,text,uuid)', false, true, false, 'authenticated:EXECUTE'),
              ('cms__run_contract(uuid)', false, false, false, NULL),
              ('rpc_cms_result_header_v2(uuid)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_result_rows_v2(uuid,uuid)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_result_events_v2(uuid,uuid,uuid,uuid,integer,integer)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_result_excluded_v2(uuid,uuid,text,integer,integer)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_result_returns_v2(uuid,uuid,integer,integer)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_return_conflicts(uuid)', false, true, false, 'authenticated:EXECUTE'),
              ('cms__report_rows(jsonb)', false, false, false, NULL),
              ('rpc_cms_return_close_report_save(uuid,uuid,jsonb)', false, false, true, 'service_role:EXECUTE'),
              ('rpc_cms_frozen_sales_lines(uuid,integer,integer)', false, false, true, 'service_role:EXECUTE'),
              ('rpc_cms_return_close_reports(uuid)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_return_close_report(uuid,integer,integer)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_return_close_report_events(uuid,text,integer)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_sales_run_open(uuid,jsonb)', false, false, true, 'service_role:EXECUTE'),
              ('rpc_cms_sales_run_stage(uuid,text,integer,jsonb)', false, false, true, 'service_role:EXECUTE'),
              ('rpc_cms_sales_run_cleanup(uuid,integer)', false, false, true, 'service_role:EXECUTE'),
              ('cms__lock_eval(uuid,uuid,integer,text,boolean)', false, false, false, NULL),
              ('cms__attest_eval(uuid,uuid)', false, false, false, NULL),
              ('rpc_cms_sales_run_seal_begin(uuid,jsonb)', false, false, true, 'service_role:EXECUTE'),
              ('rpc_cms_sales_run_seal_step(uuid,integer)', false, false, true, 'service_role:EXECUTE'),
              ('cms__sales_snapshot(uuid)', false, false, false, NULL),
              ('rpc_cms_result_header(uuid)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_result_rows(uuid,uuid)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_result_lines(uuid,uuid,uuid,uuid,integer,integer)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_result_excluded(uuid,uuid,integer,integer)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_sales_run_publish(uuid)', false, false, true, 'service_role:EXECUTE')) AS x(sig, anon_x, auth_x, svc_x, acl)
      JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure('public.' || x.sig)
      CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE a.grantee <> p.proowner
       AND NOT (a.grantee = 'authenticated'::regrole::oid AND x.auth_x)
       AND NOT (a.grantee = 'service_role'::regrole::oid AND x.svc_x)
     GROUP BY p.oid, a.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON public.cms_return_lines, public.cms_result_events, public.cms_return_close_reports, public.cms_return_close_report_lines, public.cms_return_close_report_events, public.cms_return_ledger_evals, public.cms_return_baselines, public.cms_return_conflicts, public.cms_return_restorations, public.cms_return_conflict_restorations, public.cms_return_conflict_observations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.cms_return_conflicts_id_seq FROM PUBLIC, anon, authenticated, service_role;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel, c.relkind, a.grantee
      FROM pg_catalog.pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('cms_return_lines', 'cms_result_events', 'cms_return_close_reports', 'cms_return_close_report_lines', 'cms_return_close_report_events', 'cms_return_ledger_evals', 'cms_return_baselines', 'cms_return_conflicts', 'cms_return_restorations', 'cms_return_conflict_restorations', 'cms_return_conflict_observations', 'cms_return_conflicts_id_seq') AND a.grantee <> c.relowner
     GROUP BY c.oid, c.relkind, a.grantee
  LOOP
    EXECUTE format('REVOKE ALL ON %s %s FROM %s', CASE WHEN r.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, r.rel,
                   CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) END);
  END LOOP;
END $$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS ro(r)
              CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS pv(p)
              WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('cms_return_lines', 'cms_result_events', 'cms_return_close_reports', 'cms_return_close_report_lines', 'cms_return_close_report_events', 'cms_return_ledger_evals', 'cms_return_baselines', 'cms_return_conflicts', 'cms_return_restorations', 'cms_return_conflict_restorations', 'cms_return_conflict_observations', 'cms_return_conflicts_id_seq') AND c.relkind IN ('r', 'p')
                AND has_table_privilege(ro.r, c.oid, pv.p))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS ro(r)
              CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) AS pv(p)
              WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('cms_return_lines', 'cms_result_events', 'cms_return_close_reports', 'cms_return_close_report_lines', 'cms_return_close_report_events', 'cms_return_ledger_evals', 'cms_return_baselines', 'cms_return_conflicts', 'cms_return_restorations', 'cms_return_conflict_restorations', 'cms_return_conflict_observations', 'cms_return_conflicts_id_seq') AND c.relkind = 'S'
                AND has_sequence_privilege(ro.r, c.oid, pv.p))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('cms_return_lines', 'cms_result_events', 'cms_return_close_reports', 'cms_return_close_report_lines', 'cms_return_close_report_events', 'cms_return_ledger_evals', 'cms_return_baselines', 'cms_return_conflicts', 'cms_return_restorations', 'cms_return_conflict_restorations', 'cms_return_conflict_observations', 'cms_return_conflicts_id_seq')
                 AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
                 WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('cms_return_lines', 'cms_result_events', 'cms_return_close_reports', 'cms_return_close_report_lines', 'cms_return_close_report_events', 'cms_return_ledger_evals', 'cms_return_baselines', 'cms_return_conflicts', 'cms_return_restorations', 'cms_return_conflict_restorations', 'cms_return_conflict_observations', 'cms_return_conflicts_id_seq'))
     OR (SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('cms_return_lines', 'cms_result_events', 'cms_return_close_reports', 'cms_return_close_report_lines', 'cms_return_close_report_events', 'cms_return_ledger_evals', 'cms_return_baselines', 'cms_return_conflicts', 'cms_return_restorations', 'cms_return_conflict_restorations', 'cms_return_conflict_observations', 'cms_return_conflicts_id_seq'))
        <> 12 THEN
    RAISE EXCEPTION '130 hậu kiểm: bảng / sequence mới phải RLS bật, 0 policy, không quyền cho anon / authenticated / service_role';
  END IF;
END $$;
-- ── 10. Hậu kiểm trong transaction ─────────────────────────────────────────
DO $$
DECLARE
  r   record;
  v_n integer;
BEGIN
  v_n := 0;
  FOR r IN
    SELECT x.sig, x.anon_x, x.auth_x, x.svc_x, x.acl AS want, p.prosecdef, p.proconfig,
           (SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ','
                              ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END, a.privilege_type)
              FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) AS acl,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS a_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS u_x,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS s_x
      FROM (VALUES ('cms__src_clean(text)', false, false, false, NULL::text),
              ('cms__unit_key(text)', false, false, false, NULL),
              ('cms__qty_dec(text)', false, false, false, NULL),
              ('cms__return_status_effect(text)', false, false, false, NULL),
              ('cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone)', false, false, false, NULL),
              ('cms__programs_basis_guard()', false, false, false, NULL),
              ('cms__products_basis_guard()', false, false, false, NULL),
              ('rpc_cms_program_save_v2(jsonb)', false, false, true, 'service_role:EXECUTE'),
              ('rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)', false, false, true, 'service_role:EXECUTE'),
              ('rpc_cms_capabilities()', false, true, true, 'authenticated:EXECUTE,service_role:EXECUTE'),
              ('cms__stage_contract(uuid,text,integer,jsonb)', false, false, false, NULL),
              ('cms__seal_begin_contract(uuid,jsonb)', false, false, false, NULL),
              ('cms__seal_contract_step(uuid,integer)', false, false, false, NULL),
              ('cms__ledger_set_hash(uuid)', false, false, false, NULL),
              ('cms__open_set_hash(uuid)', false, false, false, NULL),
              ('cms__as_of_floor(uuid)', false, false, false, NULL),
              ('cms__ledger_immutable()', false, false, false, NULL),
              ('cms__ledger_eval_guard()', false, false, false, NULL),
              ('cms__ledger_insert_guard()', false, false, false, NULL),
              ('cms__ledger_eval(uuid,text,uuid,timestamp with time zone,text,jsonb)', false, false, false, NULL),
              ('cms__publish_contract(uuid)', false, false, false, NULL),
              ('rpc_cms_return_conflicts_confirm_restored(uuid,text,bigint,text,uuid)', false, true, false, 'authenticated:EXECUTE'),
              ('cms__run_contract(uuid)', false, false, false, NULL),
              ('rpc_cms_result_header_v2(uuid)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_result_rows_v2(uuid,uuid)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_result_events_v2(uuid,uuid,uuid,uuid,integer,integer)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_result_excluded_v2(uuid,uuid,text,integer,integer)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_result_returns_v2(uuid,uuid,integer,integer)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_return_conflicts(uuid)', false, true, false, 'authenticated:EXECUTE'),
              ('cms__report_rows(jsonb)', false, false, false, NULL),
              ('rpc_cms_return_close_report_save(uuid,uuid,jsonb)', false, false, true, 'service_role:EXECUTE'),
              ('rpc_cms_frozen_sales_lines(uuid,integer,integer)', false, false, true, 'service_role:EXECUTE'),
              ('rpc_cms_return_close_reports(uuid)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_return_close_report(uuid,integer,integer)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_return_close_report_events(uuid,text,integer)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_sales_run_open(uuid,jsonb)', false, false, true, 'service_role:EXECUTE'),
              ('rpc_cms_sales_run_stage(uuid,text,integer,jsonb)', false, false, true, 'service_role:EXECUTE'),
              ('rpc_cms_sales_run_cleanup(uuid,integer)', false, false, true, 'service_role:EXECUTE'),
              ('cms__lock_eval(uuid,uuid,integer,text,boolean)', false, false, false, NULL),
              ('cms__attest_eval(uuid,uuid)', false, false, false, NULL),
              ('rpc_cms_sales_run_seal_begin(uuid,jsonb)', false, false, true, 'service_role:EXECUTE'),
              ('rpc_cms_sales_run_seal_step(uuid,integer)', false, false, true, 'service_role:EXECUTE'),
              ('cms__sales_snapshot(uuid)', false, false, false, NULL),
              ('rpc_cms_result_header(uuid)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_result_rows(uuid,uuid)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_result_lines(uuid,uuid,uuid,uuid,integer,integer)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_result_excluded(uuid,uuid,integer,integer)', false, true, false, 'authenticated:EXECUTE'),
              ('rpc_cms_sales_run_publish(uuid)', false, false, true, 'service_role:EXECUTE')) AS x(sig, anon_x, auth_x, svc_x, acl)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure('public.' || x.sig)
  LOOP
    v_n := v_n + 1;
    IF r.prosecdef IS DISTINCT FROM true OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}')))
       OR r.a_x IS DISTINCT FROM r.anon_x OR r.u_x IS DISTINCT FROM r.auth_x OR r.s_x IS DISTINCT FROM r.svc_x
       OR r.acl IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION '130 hậu kiểm: % sai (SECDEF %, config %, acl % ≠ %, anon % auth % svc %)',
        r.sig, r.prosecdef, r.proconfig, r.acl, r.want, r.a_x, r.u_x, r.s_x;
    END IF;
  END LOOP;
  IF v_n <> 48 THEN RAISE EXCEPTION '130 hậu kiểm: cần % hàm trong ma trận ACL, có %', 48, v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> 103 THEN RAISE EXCEPTION '130 hậu kiểm: tổng hàm CMS phải 103 (68 + 35 mới), có %', v_n; END IF;
  -- Dữ liệu cũ đúng backfill: không chương trình nào ngoài legacy_migration; không net; config_version / pointer không đổi (đếm).
  IF EXISTS (SELECT 1 FROM public.cms_programs
              WHERE quantity_basis IS DISTINCT FROM 'pos_base' OR quantity_basis_source <> 'legacy_migration'
                 OR returns_policy <> 'sales_only_v1' OR quantity_basis_set_by IS NOT NULL OR returns_policy_set_by IS NOT NULL) THEN
    RAISE EXCEPTION '130 hậu kiểm: backfill chương trình sai (cần pos_base / legacy_migration / sales_only_v1, không actor)';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger
       WHERE NOT tgisinternal AND tgenabled = 'A'
         AND ((tgrelid = 'public.cms_programs'::regclass AND tgname = 'cms_programs_basis_guard')
              OR (tgrelid = 'public.cms_program_products'::regclass AND tgname = 'cms_products_basis_guard'))) <> 2 THEN
    RAISE EXCEPTION '130 hậu kiểm: 2 trigger basis phải ENABLE ALWAYS';
  END IF;
  IF (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION '130 hậu kiểm: policy chốt thật không được mở';
  END IF;
END $$;
-- Thân hàm mới / thay phải đúng bản sinh (md5) — khối sinh bởi gen-cms-130.mjs.
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__src_clean(text)')) IS DISTINCT FROM '63b3dbbb589459d1b486039c7e73f2f8'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__unit_key(text)')) IS DISTINCT FROM '63103d1c140e24dba82f1c748e82cdb8'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__qty_dec(text)')) IS DISTINCT FROM 'fb241862be3362150b732839e0d492b4'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__return_status_effect(text)')) IS DISTINCT FROM 'c17a317d69570bbeb8ccbd8003b99e0a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone)')) IS DISTINCT FROM 'b25fdd09183dffc64658e9ae704aeadf'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__programs_basis_guard()')) IS DISTINCT FROM '534964b54b91f5b6d00c9c9916c38edb'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__products_basis_guard()')) IS DISTINCT FROM '23f9afeb1655bf939b7b53327d2a0d77'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_program_save_v2(jsonb)')) IS DISTINCT FROM '41775befd6e5c8e0e8483dbff08090a9'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)')) IS DISTINCT FROM '76f945a8c051bcfb0ee750bf3dd1f166'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_capabilities()')) IS DISTINCT FROM 'ab71996e89d66ddcd8a2c4b02c1caa5e'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__stage_contract(uuid,text,integer,jsonb)')) IS DISTINCT FROM '93b9788769d20237c3d09a273de8252b'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__seal_begin_contract(uuid,jsonb)')) IS DISTINCT FROM '588b1c83f285facf39a228391576d4c3'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__seal_contract_step(uuid,integer)')) IS DISTINCT FROM '8d750bcc6b45a6926262068d6289cd99'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__ledger_set_hash(uuid)')) IS DISTINCT FROM '72c6e9943fc592145b08a483ab3a9c17'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__open_set_hash(uuid)')) IS DISTINCT FROM 'c93c1b7564014147a41c94cf7e70fc5d'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__as_of_floor(uuid)')) IS DISTINCT FROM '292f9884a3b11216bc5a1ff6c8d4d86f'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__ledger_immutable()')) IS DISTINCT FROM '2938fbddd4b0cb398e6e974bc50ff47b'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__ledger_eval_guard()')) IS DISTINCT FROM 'c6e3fdc2ce57477eb7424aaac198a940'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__ledger_insert_guard()')) IS DISTINCT FROM 'd6f323bc02cdf8581f841d82bf937a9f'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__ledger_eval(uuid,text,uuid,timestamp with time zone,text,jsonb)')) IS DISTINCT FROM 'bcccc930500360297ab67d270297799a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__publish_contract(uuid)')) IS DISTINCT FROM 'e280ae4939fddda9938b4544b7532a9e'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_conflicts_confirm_restored(uuid,text,bigint,text,uuid)')) IS DISTINCT FROM '7914936bc1e194b6ef04cc39944ae83d'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__run_contract(uuid)')) IS DISTINCT FROM '13404aa1c8411da8c9e706293cc9bd69'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_header_v2(uuid)')) IS DISTINCT FROM '4ffc602cb0a641432b31f2d6032f1d85'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_rows_v2(uuid,uuid)')) IS DISTINCT FROM '0eb5861076ba55ecfbdb3134f0b4d93f'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_events_v2(uuid,uuid,uuid,uuid,integer,integer)')) IS DISTINCT FROM '2e76dd82c771bebc7cf4970fcc412db0'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_excluded_v2(uuid,uuid,text,integer,integer)')) IS DISTINCT FROM '36dfbac01d1fd4c3cf71fc93fcf55984'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_returns_v2(uuid,uuid,integer,integer)')) IS DISTINCT FROM 'e2c28299d2f5b9fe423cde2736f12589'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_conflicts(uuid)')) IS DISTINCT FROM 'eb7ad251732cb5857e6a3962d2d025fa'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__report_rows(jsonb)')) IS DISTINCT FROM '4efa81d495838e71bdafa248894586e9'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_report_save(uuid,uuid,jsonb)')) IS DISTINCT FROM '60dd216a8f9f5bd680171601d9377fc0'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_frozen_sales_lines(uuid,integer,integer)')) IS DISTINCT FROM '056b83531da67d3f547c8665d4c02c48'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_reports(uuid)')) IS DISTINCT FROM '15af6feac81da195c56aa5a396ca4e16'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_report(uuid,integer,integer)')) IS DISTINCT FROM 'c2ff20f86cb23d3e91a6a847c3363efe'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_report_events(uuid,text,integer)')) IS DISTINCT FROM '20879fbe6f56c53110e4bc5392a6dfee'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_open(uuid,jsonb)')) IS DISTINCT FROM 'c9bafba3b88949308c10b4f06732f106'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_stage(uuid,text,integer,jsonb)')) IS DISTINCT FROM 'dc0bdbfa4a0effa50927609bff86915c'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_cleanup(uuid,integer)')) IS DISTINCT FROM 'e437968ffc7aa60b96f9d2029e36c24e'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__lock_eval(uuid,uuid,integer,text,boolean)')) IS DISTINCT FROM 'f7fa018ad762a526ff6279a48c427d61'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__attest_eval(uuid,uuid)')) IS DISTINCT FROM '9a332cd63acf909558e8bccba868af82'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_seal_begin(uuid,jsonb)')) IS DISTINCT FROM '2d2954fc3e86eaa5d066f8393e28eb10'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_seal_step(uuid,integer)')) IS DISTINCT FROM '3892508f17c738585ef521fac8e7b04a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__sales_snapshot(uuid)')) IS DISTINCT FROM 'b8fc8150ff3d733f4a73b8a19dc22daa'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_header(uuid)')) IS DISTINCT FROM '97060db8f5670948dc446f525072ab59'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_rows(uuid,uuid)')) IS DISTINCT FROM '2b39826275a0369349d43602bcf76a13'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_lines(uuid,uuid,uuid,uuid,integer,integer)')) IS DISTINCT FROM 'd87d45d4f9121d41cdfbdedcc1b20271'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_excluded(uuid,uuid,integer,integer)')) IS DISTINCT FROM '069f0d8be9b964fe96802408c4f417a4'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_publish(uuid)')) IS DISTINCT FROM 'a1a618ed424778ae0ed9b650f87910db' THEN
    RAISE EXCEPTION '130 hậu kiểm: thân 35 hàm mới + 13 hàm thay lệch bản sinh (md5)';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('130', 'cms_calculation_modes_returns', jsonb_build_object(
  'candidate', 'CMS-CALC-RET-2 r2', 'new_functions', 35, 'replaced_functions', 13,
  'inventory', current_setting('cms130.inventory')::jsonb)::text);

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — operator chạy từng khối trong Studio / pg-meta, bọc BEGIN READ ONLY; … COMMIT;) ──────────────────
-- Kỳ vọng ghi ngay trên mỗi khối, sinh từ registry generator. Lệch ⇒ báo Dev, KHÔNG sửa tay. Phase 130 của scripts/cms-verify.mjs
-- CHƯA có (Dev làm trước cửa sổ A) — khối dưới là bằng chứng sau COMMIT cho gate ACL (AGENTS §4.2).
-- V1 marker — 2 dòng: 127 cms_t11_flat_amounts · 130 cms_calculation_modes_returns.
--   SELECT version, name FROM public.app_migrations WHERE version IN ('127', '130') ORDER BY 1;
-- V2 ACL — n = 48 · anon_x = 0 · auth_x = 15 · svc_x = 11 · owner_only = 23 · secdef = 48 · sp = 48.
--   SELECT count(*) n, count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE')) anon_x,
--          count(*) FILTER (WHERE has_function_privilege('authenticated', p.oid, 'EXECUTE')) auth_x,
--          count(*) FILTER (WHERE has_function_privilege('service_role', p.oid, 'EXECUTE')) svc_x,
--          count(*) FILTER (WHERE NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
--                             AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')) owner_only,
--          count(*) FILTER (WHERE p.prosecdef) secdef, count(*) FILTER (WHERE 'search_path=public' = ANY (p.proconfig)) sp
--     FROM pg_proc p WHERE p.oid IN (SELECT to_regprocedure('public.' || s)
--     FROM unnest(ARRAY['cms__src_clean(text)', 'cms__unit_key(text)', 'cms__qty_dec(text)', 'cms__return_status_effect(text)',
--       'cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone)',
--       'cms__programs_basis_guard()', 'cms__products_basis_guard()', 'rpc_cms_program_save_v2(jsonb)',
--       'rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)', 'rpc_cms_capabilities()',
--       'cms__stage_contract(uuid,text,integer,jsonb)', 'cms__seal_begin_contract(uuid,jsonb)',
--       'cms__seal_contract_step(uuid,integer)', 'cms__ledger_set_hash(uuid)', 'cms__open_set_hash(uuid)',
--       'cms__as_of_floor(uuid)', 'cms__ledger_immutable()', 'cms__ledger_eval_guard()', 'cms__ledger_insert_guard()',
--       'cms__ledger_eval(uuid,text,uuid,timestamp with time zone,text,jsonb)', 'cms__publish_contract(uuid)',
--       'rpc_cms_return_conflicts_confirm_restored(uuid,text,bigint,text,uuid)', 'cms__run_contract(uuid)',
--       'rpc_cms_result_header_v2(uuid)', 'rpc_cms_result_rows_v2(uuid,uuid)',
--       'rpc_cms_result_events_v2(uuid,uuid,uuid,uuid,integer,integer)',
--       'rpc_cms_result_excluded_v2(uuid,uuid,text,integer,integer)', 'rpc_cms_result_returns_v2(uuid,uuid,integer,integer)',
--       'rpc_cms_return_conflicts(uuid)', 'cms__report_rows(jsonb)', 'rpc_cms_return_close_report_save(uuid,uuid,jsonb)',
--       'rpc_cms_frozen_sales_lines(uuid,integer,integer)', 'rpc_cms_return_close_reports(uuid)',
--       'rpc_cms_return_close_report(uuid,integer,integer)', 'rpc_cms_return_close_report_events(uuid,text,integer)',
--       'rpc_cms_sales_run_open(uuid,jsonb)', 'rpc_cms_sales_run_stage(uuid,text,integer,jsonb)',
--       'rpc_cms_sales_run_cleanup(uuid,integer)', 'cms__lock_eval(uuid,uuid,integer,text,boolean)',
--       'cms__attest_eval(uuid,uuid)', 'rpc_cms_sales_run_seal_begin(uuid,jsonb)', 'rpc_cms_sales_run_seal_step(uuid,integer)',
--       'cms__sales_snapshot(uuid)', 'rpc_cms_result_header(uuid)', 'rpc_cms_result_rows(uuid,uuid)',
--       'rpc_cms_result_lines(uuid,uuid,uuid,uuid,integer,integer)', 'rpc_cms_result_excluded(uuid,uuid,integer,integer)',
--       'rpc_cms_sales_run_publish(uuid)']) s);
-- V3 bảng mới — 11 dòng, mỗi dòng rls = true · pol = 0 · a = u = s = false; sequence: 3 false.
--   SELECT c.relname, c.relrowsecurity rls, (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) pol,
--          has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') a,
--          has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') u,
--          has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') s
--     FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
--     AND c.relname IN ('cms_return_lines', 'cms_result_events', 'cms_return_close_reports', 'cms_return_close_report_lines',
--       'cms_return_close_report_events', 'cms_return_ledger_evals', 'cms_return_baselines', 'cms_return_conflicts',
--       'cms_return_restorations', 'cms_return_conflict_restorations', 'cms_return_conflict_observations') ORDER BY 1;
--   SELECT has_sequence_privilege('anon', 'public.cms_return_conflicts_id_seq', 'USAGE,SELECT,UPDATE'), has_sequence_privilege('authenticated', 'public.cms_return_conflicts_id_seq', 'USAGE,SELECT,UPDATE'), has_sequence_privilege('service_role', 'public.cms_return_conflicts_id_seq', 'USAGE,SELECT,UPDATE');
-- V4 trigger ENABLE ALWAYS — cms_result_events 5/5 · cms_return_lines 5/5 · 9 bảng sổ mỗi bảng 3/3 (tổng 27) · 2 trigger basis.
--   SELECT c.relname, count(*) total, count(*) FILTER (WHERE t.tgenabled = 'A') always
--     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
--    WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
--      AND (c.relname LIKE 'cms\_return\_%' OR c.relname = 'cms_result_events' OR t.tgname IN ('cms_programs_basis_guard', 'cms_products_basis_guard'))
--    GROUP BY 1 ORDER BY 1;
-- V5 sổ rỗng ngay sau migrate — mọi cột = 0.
--   SELECT (SELECT count(*) FROM public.cms_return_ledger_evals) evals, (SELECT count(*) FROM public.cms_return_baselines) bl,
--          (SELECT count(*) FROM public.cms_return_conflicts) cf, (SELECT count(*) FROM public.cms_return_close_reports) rp,
--          (SELECT count(*) FROM public.cms_sync_runs WHERE calc_contract_version IS NOT NULL) runs_ct;
-- V6 backfill — đúng một nhóm (pos_base, legacy_migration, sales_only_v1, n = số chương trình trước 130).
--   SELECT quantity_basis, quantity_basis_source, returns_policy, count(*) FROM public.cms_programs GROUP BY 1, 2, 3;
-- V7 tổng hàm CMS = 103 (68 + 35 mới).
--   SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
-- V8 policy chốt thật vẫn đóng — false.
--   SELECT (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean;
