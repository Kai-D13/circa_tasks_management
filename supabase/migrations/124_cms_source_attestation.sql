-- ============================================================================
-- 124_cms_source_attestation.sql  (r2 — COMP-INT, Dev 05/11/2026; CHƯA audit PM, CHƯA commit, KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-124.mjs từ webapp/scripts/cms-124/*.sql + thân hàm 122 / 123 NGUYÊN VĂN (chỉ chèn / thay đúng
-- các đoạn ghi trong generator). KHÔNG sửa file này bằng tay — `node scripts/gen-cms-124.mjs --check` phát hiện lệch.
-- Số 124 = số PM dành trong khối Hiện trạng sống STATE (05/11), preflight 123.
-- Lịch sử: r1 = sửa db-reviewer r0 (gate ACL hàm thay, marker QA H9b, 15 P2). r2 = PM audit 05/11 (COMP-P1-1: chứng nhận CHỈ
-- decision10; P2-1 lock_timeout không phải hạn tổng RPC; P2-2 export chỉ là snapshot; rpc_cms_sales_run_open trả source_schema).
--
-- Mục đích: chứng nhận ĐỐI SOÁT NGUỒN của operator gắn ĐÚNG một run bán đã công bố (run / config / mapping / scope / vân tay
-- decision10), làm cơ sở nguồn đầy đủ `operator_reconciliation` cho chốt kỳ. Cổng thật GIỮ ĐÓNG: cms__lock_policy() không đổi
-- (real.ready = false ⇒ CMS_LOCK_POLICY_PENDING), cổng Q-206 không mở; Q-213 / Q-216 không tự chốt.
--
-- Hai lớp dữ liệu của run:
--   · lớp ENGINE  cms_sales_lines (122, không đổi): chỉ dòng ứng viên OFFLINE + COMPLETED đã phân loại (INCLUDED / UNASSIGNED /
--     OUT_OF_SCOPE), seal 122 kiểm như cũ;
--   · lớp NGUỒN   cms_sales_source_lines (MỚI): MỌI dòng hợp lệ adapter đọc trong kỳ + SP chương trình — kể cả ONLINE / chưa hoàn
--     tất — với 14 trường thô đã chuẩn hoá (gồm order_type / order_status thô). Stage bằng part mới 'source_lines' (run
--     source_schema = 1). Không suy ngược từ disposition; run cũ (source_schema NULL) KHÔNG đủ điều kiện chứng nhận — tính lại.
--   Lớp nguồn được kiểm khớp lớp engine khi CHỨNG NHẬN và khi ĐÁNH GIÁ CHỐT CÓ CHỨNG NHẬN (cms__run_source_check — nhánh
--   qa_assumption không kiểm lớp nguồn): đủ số dòng đã đọc, KHÔNG có dòng bị từ chối (SOURCE_REJECTED), mọi dòng
--   engine có dòng nguồn trùng trường thô và là OFFLINE / COMPLETED, số dòng nguồn đủ điều kiện = số dòng engine, đúng kỳ / SP.
--   XUẤT (rpc_cms_run_source_export) chỉ là snapshot lớp nguồn đã lưu: kiểm quyền / run công bố / chưa dọn / source_schema rồi
--   phân trang — KHÔNG gọi kiểm toàn lớp (không quét 200k mỗi trang 5k), KHÔNG phải chứng nhận. CLI phải đọc đủ trang, ghim run,
--   kiểm ID / count / hash trước khi dựng payload.
--   Q-206 (trả hàng) CHƯA có nguồn: lớp nguồn hiện chỉ gồm dòng bán; khi có contract trả hàng, nguồn trả + vân tay của nó phải bổ
--   sung (không coi hash bán dương là đủ cho chương trình có trả).
--
-- Contract (authenticated — phiên super THẬT: auth.uid() + is_super_admin() + chương trình ∈ cms_readable_program_ids() — chương
-- trình QA cần marker cms_qa_access kể cả super (H9b, như đọc 122 / 123); actor KHÔNG lấy từ payload; KHÔNG cấp service_role):
--   rpc_cms_source_attest(program, run, payload jsonb, idem uuid)   → jsonb {attested, already, id, superseded_id}
--   rpc_cms_source_attest_revoke(attestation, reason, idem uuid)    → jsonb {revoked, already, id}
--   rpc_cms_run_source_export(program, run, after_line_id, limit)   → jsonb trang dòng nguồn 14 trường (run ghim, keyset theo byte)
--   rpc_cms_source_attestations(program)                            → jsonb lịch sử chứng nhận (hiệu lực / thay thế / thu hồi)
-- Đổi (service_role như 122 / 123): rpc_cms_sales_run_open trả thêm source_schema THỰC của run vừa tạo (giữ chữ ký + key cũ);
--   rpc_cms_program_lock thêm p_expected_attestation_id (DROP 5 tham số + CREATE 6 tham số).
--
-- Bằng chứng quyết định = decision10 (PM COMP-P1-1): chứng nhận dùng làm basis CHỈ nhận field_set = 'decision10' với
--   reference_rows_fp = run_rows_fp = decision10 của lớp nguồn DB. audit14 (thêm pos_code / quantity_raw / uom_raw /
--   source_updated_at) chỉ để tra soát / parity / xuất — KHÔNG làm chứng nhận chốt (audit14 không ràng buộc được trường quyết định).
-- Vân tay cms-rows-fp-v1 (parity PG15 / PGlite ↔ offline ĐẠT 04/11):
--   dòng = '[' + to_json(text) nối ',' + ']' (KHÔNG json_build_array / jsonb::text); số trunc(x * 1e9)::text; thời gian
--   trunc(extract(epoch) * 1e6)::text; sắp order_line_id COLLATE "C" (= thứ tự byte UTF-8 khi DB UTF8; order_line_id là PK trong
--   run ⇒ không cần khoá phụ theo cả dòng — tương đương thứ tự offline); văn bản 'cms-rows-fp-v1' <LF> tên trường <LF>
--   (dòng <LF>)*;
--   sha256 UTF-8 hex. Điều kiện ngầm ép ở preflight: DB encoding UTF8 + PG ≥ 14 (extract trả numeric).
--
-- Mốc M (as_of — PM 05/11 đồng ý): M ≥ 00:00 VN ngày sau end_date (điều kiện tối thiểu để ghi "đủ tới end_date", KHÔNG chốt Q-216
-- về số ngày chờ thêm), M ≥ dòng nguồn trong scope cuối, M ≤ cả hai thời điểm xuất; thời điểm xuất ≤ giờ DB + 5 phút.
-- Chờ khoá: attest / thu hồi / chốt lock_timeout = 2 s — hết hạn chờ ⇒ lỗi, rollback toàn RPC. Đây KHÔNG phải hạn tổng RPC (còn
-- trigger / FK / index / tải máy); hạn câu lệnh do statement_timeout của role PostgREST đã duyệt — không nới, không đặt
-- statement_timeout trong thân hàm. Huỷ giữa chừng (timeout / cancel) ⇒ không ghi nửa lượt; gọi lại đúng khoá idem không nhân bản.
--
-- Ranh giới tin cậy: DB tính lại vân tay run chỉ chứng minh payload GẮN ĐÚNG run đang lưu. DB không đọc file nguồn độc lập ⇒ không
-- tự chứng minh caller đã đối soát trung thực; xác nhận của super (ack + evidence hash) là ranh giới, lưu đủ để kiểm toán.
--
-- Triển khai (thứ tự):
--   1. Triển khai app (cờ CMS_SOURCE_CAPTURE_ENABLED mặc định OFF ⇒ không gửi 'source_lines').
--   2. Chạy 124 khi cờ CMS sync OFF, cron sync / cleanup CMS tạm dừng, không run bán 'running' (preflight kiểm + khoá bảng run).
--   3. Bật cờ capture → app CHỈ stage lớp nguồn khi run_open trả source_schema = 1 (thiếu / lạ ⇒ đóng run lỗi
--      SOURCE_SCHEMA_UNSUPPORTED, không stage / publish); resync chương trình cần chứng nhận. Run sau 124 mà app không stage lớp
--      nguồn ⇒ kiểm lớp nguồn SOURCE_COUNT (không chứng nhận được; chốt QA như 123) — không phải LEGACY_RUN.
--   source_schema DEFAULT 1 gán cả run 'products' (vô hại: cột chỉ dùng cho run 'sales').
-- Embed PostgREST giữa cms_programs ↔ cms_sync_runs vẫn phải ghi !fk như 122 / 123 (cms_source_attestations thêm FK tới cả hai).
-- READ COMMITTED bắt buộc (như 123). Sau 124, cms-verify phase 122 / 123 ĐỎ phase-match đúng thiết kế ⇒ dùng phase 124.
-- ROLLBACK: rollback/124_cms_source_attestation_rollback.sql (dừng nếu đã có payout basis operator_reconciliation hoặc run bán
-- đang chạy) — gồm DELETE FROM app_migrations WHERE version = '124'.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
-- Khoá bảng run TRƯỚC khi kiểm "không run bán đang chạy" (db-reviewer P2-8): ALTER bên dưới cũng cần ACCESS EXCLUSIVE ⇒ không
-- nâng khoá giữa chừng; bận ⇒ hết lock_timeout, cả migration rollback sạch.
LOCK TABLE public.cms_sync_runs IN ACCESS EXCLUSIVE MODE;

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_name text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '124: cần READ COMMITTED';
  END IF;
  -- Điều kiện ngầm của vân tay (db-reviewer P2-9): COLLATE "C" = thứ tự byte UTF-8 chỉ khi DB UTF8; extract(epoch) trả numeric
  -- (micro giây chính xác) từ PG 14.
  IF current_setting('server_version_num')::int < 140000
     OR (SELECT pg_catalog.pg_encoding_to_char(d.encoding) FROM pg_catalog.pg_database d WHERE d.datname = current_database()) <> 'UTF8' THEN
    RAISE EXCEPTION '124: cần PostgreSQL ≥ 14 và DB encoding UTF8 (vân tay cms-rows-fp-v1)';
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '123';
  IF v_name IS DISTINCT FROM 'cms_payouts' THEN
    RAISE EXCEPTION '124: thiếu migration nền 123 cms_payouts (name = %)', v_name;
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '124';
  IF FOUND THEN
    RAISE EXCEPTION '124: đã có marker 124 (name = %) — không chạy lại / không chạy chồng', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 124) THEN
    RAISE EXCEPTION '124: DB đã có migration số > 124 — dừng';
  END IF;
  IF to_regclass('public.cms_sales_source_lines') IS NOT NULL OR to_regclass('public.cms_source_attestations') IS NOT NULL THEN
    RAISE EXCEPTION '124: đã có bảng 124 mà không có marker — kiểm tra tay';
  END IF;
  IF to_regprocedure('public.cms__lock_eval(uuid, uuid, integer, text, boolean)') IS NULL
     OR to_regprocedure('public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)') IS NULL
     OR to_regprocedure('public.rpc_cms_sales_run_open(uuid, jsonb)') IS NULL
     OR to_regprocedure('public.rpc_cms_payout(uuid)') IS NULL
     OR to_regprocedure('public.rpc_cms_sales_run_stage(uuid, text, integer, jsonb)') IS NULL
     OR to_regprocedure('public.rpc_cms_sales_run_cleanup(uuid, integer)') IS NULL
     OR to_regprocedure('public.is_super_admin()') IS NULL OR to_regprocedure('public.cms__mapping_fp()') IS NULL THEN
    RAISE EXCEPTION '124: thiếu hàm nền 122 / 123';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION '124: role chạy migration (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  -- Guard chỉ-owner của 123 (cms__run_auth_guard) dựa vào owner bảng run = owner RPC SECDEF ⇒ cùng role.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_sync_runs'::regclass, 'public.cms_sync_run_chunks'::regclass, 'public.cms_sales_lines'::regclass,
                              'public.cms_payouts'::regclass, 'public.cms_programs'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '124: owner bảng / hàm CMS khác role chạy (%)', current_user;
  END IF;
  -- Ràng buộc sẽ thay phải đúng dạng 122 / 123 (không đè ràng buộc lạ).
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.cms_sync_run_chunks'::regclass
                  AND conname = 'cms_sync_run_chunks_part_check'
                  AND pg_catalog.pg_get_constraintdef(oid) LIKE '%sales_lines%results%catalog%result_lines%')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.cms_payouts'::regclass
                     AND conname = 'cms_payouts_source_complete_basis_check'
                     AND pg_catalog.pg_get_constraintdef(oid) LIKE '%qa_assumption%bi_watermark%lag_commitment%') THEN
    RAISE EXCEPTION '124: ràng buộc part / basis không đúng dạng 122 / 123';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running') THEN
    RAISE EXCEPTION '124: còn run bán đang chạy — chờ xong (run mở trước 124 sẽ là run cũ, không chứng nhận được)';
  END IF;
END $$;
-- Thân 6 hàm sẽ thay phải đúng nguyên văn 122 / 123 (db-reviewer r2 P2-6) — khối sinh bởi gen-cms-124.mjs.
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_open(uuid, jsonb)'::regprocedure) IS DISTINCT FROM '4aa263fb8d4a526eb52d76bf561dbc59'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_stage(uuid, text, integer, jsonb)'::regprocedure) IS DISTINCT FROM '7815855f252939ddbd9961597b1d1823'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_sales_run_cleanup(uuid, integer)'::regprocedure) IS DISTINCT FROM '72db7f1c3f562f5c841fcb68314c4e30'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.cms__lock_eval(uuid, uuid, integer, text, boolean)'::regprocedure) IS DISTINCT FROM 'c4a9c555e6c1cd85fb89e15a26155b0a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_payout(uuid)'::regprocedure) IS DISTINCT FROM '6b75e9a3c8b5fec978bc8a63d6579e5c'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)'::regprocedure) IS DISTINCT FROM 'f71538167e3c48ae46bc87e1257ae7d3' THEN
    RAISE EXCEPTION '124 preflight: thân hàm 122 / 123 sắp thay KHÁC bản đã duyệt (md5) — dừng, đối chiếu tay';
  END IF;
END $$;

-- ── 1. Lớp nguồn + phiên bản snapshot ───────────────────────────────────────
-- Run mở SAU 124 mang source_schema = 1 (bắt buộc stage đủ lớp nguồn trước seal mới chứng nhận được); run cũ NULL.
ALTER TABLE public.cms_sync_runs ADD COLUMN source_schema smallint CHECK (source_schema IS NULL OR source_schema = 1);
ALTER TABLE public.cms_sync_runs ALTER COLUMN source_schema SET DEFAULT 1;

ALTER TABLE public.cms_sync_run_chunks DROP CONSTRAINT cms_sync_run_chunks_part_check;
ALTER TABLE public.cms_sync_run_chunks ADD CONSTRAINT cms_sync_run_chunks_part_check
  CHECK (part IN ('sales_lines', 'results', 'catalog', 'result_lines', 'source_lines'));

-- MỌI dòng adapter đọc của run (kỳ + SP chương trình), 14 trường thô chuẩn hoá như normalizeSalesRow (email trim + lower).
CREATE TABLE public.cms_sales_source_lines (
  run_id            uuid        NOT NULL,
  program_id        uuid        NOT NULL,
  order_line_id     text        NOT NULL CHECK (char_length(order_line_id) BETWEEN 1 AND 100),
  order_id          text        NOT NULL CHECK (char_length(order_id) BETWEEN 1 AND 100),
  order_code        text        NOT NULL CHECK (char_length(order_code) BETWEEN 1 AND 100),
  product_id        text        NOT NULL CHECK (product_id ~ '^[1-9][0-9]{0,18}$'),
  seller_email      text        CHECK (seller_email IS NULL OR (char_length(seller_email) BETWEEN 1 AND 320
                                       AND seller_email = lower(seller_email))),
  pos_code          text        CHECK (pos_code IS NULL OR char_length(pos_code) BETWEEN 1 AND 50),
  order_type        text        NOT NULL CHECK (char_length(order_type) BETWEEN 1 AND 30),
  order_status      text        NOT NULL CHECK (char_length(order_status) BETWEEN 1 AND 30),
  completed_at      timestamptz NOT NULL CHECK (isfinite(completed_at)),
  source_updated_at timestamptz NOT NULL CHECK (isfinite(source_updated_at)),
  quantity_raw      text        CHECK (quantity_raw IS NULL OR char_length(quantity_raw) BETWEEN 1 AND 50),
  uom_raw           text        CHECK (uom_raw IS NULL OR char_length(uom_raw) BETWEEN 1 AND 50),
  base_quantity     numeric     NOT NULL CHECK (abs(base_quantity) < 1e29 AND scale(base_quantity) <= 9),
  gmv_amount        numeric     NOT NULL CHECK (abs(gmv_amount) < 1e20 AND scale(gmv_amount) <= 9),
  PRIMARY KEY (run_id, order_line_id),
  CONSTRAINT cms_sales_source_lines_run_fk FOREIGN KEY (run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id)
);
-- Keyset xuất / vân tay theo BYTE: collation "C" trên UTF-8 = thứ tự byte.
CREATE INDEX cms_sales_source_lines_byte_idx ON public.cms_sales_source_lines (run_id, (order_line_id COLLATE "C"));
ALTER TABLE public.cms_sales_source_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cms_sales_source_lines FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. Helper vân tay / phạm vi / kiểm lớp nguồn (nội bộ, không cấp ai) ──────
CREATE FUNCTION public.cms__fp_j(p_v text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(to_json(p_v)::text, 'null')
$$;

-- Văn bản chuẩn cms-rows-fp-v1 của lớp nguồn một run (đúng helper offline cmsI4RowsFpText). p_field_set: decision10 | audit14.
-- Hiệu năng (benchmark COMP-DRAFT): biểu thức INLINE (không gọi hàm SECDEF mỗi trường — 1 triệu lời gọi / 100k dòng ≈ 6,8 s);
-- số / micro giây chỉ gồm chữ số và dấu trừ ⇒ bọc '"' trực tiếp (to_json không đổi gì); thứ tự = order_line_id COLLATE "C"
-- (DB UTF-8: thứ tự byte) — order_line_id DUY NHẤT trong run (PK) nên không cần khoá phụ theo cả dòng như offline (tương đương).
CREATE FUNCTION public.cms__run_source_fp_text(p_run_id uuid, p_field_set text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'cms-rows-fp-v1' || E'\n'
      || CASE WHEN p_field_set = 'audit14'
           THEN 'order_line_id,order_id,order_code,product_id,seller_email,order_type,order_status,completed_at_us,base_quantity_e9,gmv_amount_e9,pos_code,quantity_raw,uom_raw,source_updated_at_us'
           ELSE 'order_line_id,order_id,order_code,product_id,seller_email,order_type,order_status,completed_at_us,base_quantity_e9,gmv_amount_e9' END
      || E'\n'
      || COALESCE(string_agg(
           '[' || to_json(r.order_line_id)::text || ',' || to_json(r.order_id)::text || ',' || to_json(r.order_code)::text
           || ',' || to_json(r.product_id)::text || ',' || COALESCE(to_json(r.seller_email)::text, 'null')
           || ',' || to_json(r.order_type)::text || ',' || to_json(r.order_status)::text
           || ',"' || trunc(extract(epoch FROM r.completed_at) * 1000000)::text || '"'
           || ',"' || trunc(r.base_quantity * 1000000000)::text || '","' || trunc(r.gmv_amount * 1000000000)::text || '"'
           || CASE WHEN p_field_set = 'audit14'
                   THEN ',' || COALESCE(to_json(r.pos_code)::text, 'null') || ',' || COALESCE(to_json(r.quantity_raw)::text, 'null')
                        || ',' || COALESCE(to_json(r.uom_raw)::text, 'null')
                        || ',"' || trunc(extract(epoch FROM r.source_updated_at) * 1000000)::text || '"'
                   ELSE '' END
           || ']' || E'\n', '' ORDER BY r.order_line_id COLLATE "C"), '')
    FROM public.cms_sales_source_lines r
   WHERE r.run_id = p_run_id
$$;

CREATE FUNCTION public.cms__run_source_fp(p_run_id uuid, p_field_set text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT encode(sha256(convert_to(public.cms__run_source_fp_text(p_run_id, p_field_set), 'UTF8')), 'hex')
$$;

-- scopeHash = cmsI4ScopeHash: sha256 UTF-8 của ["cms-rows-fp-v1","scope",start,end,[ProductID duy nhất, sắp byte]] KHÔNG khoảng trắng.
CREATE FUNCTION public.cms__program_scope_hash(p_program_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT encode(sha256(convert_to(
           '[' || public.cms__fp_j('cms-rows-fp-v1') || ',' || public.cms__fp_j('scope') || ','
           || public.cms__fp_j(to_char(p.start_date, 'YYYY-MM-DD')) || ',' || public.cms__fp_j(to_char(p.end_date, 'YYYY-MM-DD')) || ',['
           || COALESCE((SELECT string_agg(public.cms__fp_j(x.product_id), ',' ORDER BY convert_to(x.product_id, 'UTF8'))
                          FROM (SELECT DISTINCT pp.product_id FROM public.cms_program_products pp WHERE pp.program_id = p.id) x), '')
           || ']]', 'UTF8')), 'hex')
    FROM public.cms_programs p WHERE p.id = p_program_id
$$;

-- Kiểm lớp nguồn của run ĐÃ seal: NULL = đạt; mã cố định nếu lệch (không giá trị dòng).
CREATE FUNCTION public.cms__run_source_check(p_run_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public SET enable_nestloop = off AS $$
DECLARE
  v_run  public.cms_sync_runs%ROWTYPE;
  v_prog public.cms_programs%ROWTYPE;
  v_from timestamptz;
  v_to   timestamptz;
  v_src  bigint;
BEGIN
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id;
  IF NOT FOUND OR v_run.kind <> 'sales' THEN RETURN 'RUN_NOT_FOUND'; END IF;
  IF v_run.source_schema IS DISTINCT FROM 1 THEN RETURN 'LEGACY_RUN'; END IF;
  IF v_run.sealed_at IS NULL OR v_run.seal_expect IS NULL THEN RETURN 'NOT_SEALED'; END IF;
  IF v_run.purged_at IS NOT NULL THEN RETURN 'RUN_GONE'; END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_run.program_id;
  v_from := (v_prog.start_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
  v_to   := ((v_prog.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
  -- Dòng nguồn bị từ chối khi chuẩn hoá KHÔNG có ở lớp nguồn ⇒ không được coi là đủ (PM COMP-INT §5.A.5; db-reviewer r2 P2-4).
  IF (v_run.seal_expect ->> 'rows_rejected')::bigint IS DISTINCT FROM 0 THEN RETURN 'SOURCE_REJECTED'; END IF;
  -- Đủ dòng đã đọc hợp lệ (rows_read − rows_rejected của seal) — không mất dòng ở lớp nguồn.
  SELECT count(*) INTO v_src FROM public.cms_sales_source_lines WHERE run_id = p_run_id;
  IF v_src IS DISTINCT FROM (v_run.seal_expect ->> 'rows_read')::bigint - (v_run.seal_expect ->> 'rows_rejected')::bigint THEN
    RETURN 'SOURCE_COUNT';
  END IF;
  -- Đúng kỳ / SP chương trình (SQL adapter lọc kỳ + ProductID).
  IF EXISTS (SELECT 1 FROM public.cms_sales_source_lines s
               LEFT JOIN public.cms_program_products pp ON pp.program_id = v_run.program_id AND pp.product_id = s.product_id
              WHERE s.run_id = p_run_id AND (pp.id IS NULL OR s.completed_at < v_from OR s.completed_at >= v_to)) THEN
    RETURN 'SOURCE_SCOPE';
  END IF;
  -- Mọi dòng engine có dòng nguồn TRÙNG trường thô và là OFFLINE / COMPLETED.
  IF EXISTS (SELECT 1 FROM public.cms_sales_lines e
               LEFT JOIN public.cms_sales_source_lines s ON s.run_id = e.run_id AND s.order_line_id = e.order_line_id
              WHERE e.run_id = p_run_id
                AND (s.order_line_id IS NULL OR s.order_type <> 'OFFLINE' OR s.order_status <> 'COMPLETED'
                     OR s.order_id <> e.order_id OR s.order_code <> e.order_code OR s.product_id <> e.product_id
                     OR s.seller_email IS DISTINCT FROM e.seller_email OR s.pos_code IS DISTINCT FROM e.pos_code
                     OR s.completed_at <> e.completed_at OR s.source_updated_at <> e.source_updated_at
                     OR s.quantity_raw IS DISTINCT FROM e.quantity_raw OR s.uom_raw IS DISTINCT FROM e.uom_raw
                     OR s.base_quantity <> e.base_quantity OR s.gmv_amount <> e.gmv_amount)) THEN
    RETURN 'SOURCE_ENGINE_MISMATCH';
  END IF;
  -- Không dòng nguồn đủ điều kiện nào bị bỏ khỏi lớp engine.
  IF (SELECT count(*) FROM public.cms_sales_source_lines WHERE run_id = p_run_id AND order_type = 'OFFLINE' AND order_status = 'COMPLETED')
     <> (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = p_run_id) THEN
    RETURN 'SOURCE_ELIGIBLE_MISMATCH';
  END IF;
  RETURN NULL;
END;
$$;

-- ── 7. Hàm 122 thay (sinh từ thân nguyên văn 122 + vá gen-cms-124) ────────────
CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_open(p_program_id uuid, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_prog public.cms_programs%ROWTYPE;
  v_snap jsonb;
  v_id   uuid;
  v_sch  smallint;  -- 124
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
  INSERT INTO public.cms_sync_runs (kind, program_id, config_version, is_test, mapping_fp, detail)
  VALUES ('sales', p_program_id, v_prog.config_version, v_prog.is_test, v_snap ->> 'mapping_fp', p_detail)
  RETURNING id, source_schema INTO v_id, v_sch;
  -- 124: capability lớp nguồn = giá trị THỰC của run vừa INSERT (DEFAULT 1 sau 124) — app không tự suy.
  RETURN v_snap || jsonb_build_object('run_id', v_id, 'source_schema', v_sch);
END;
$$;
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
       AND NOT EXISTS (SELECT 1 FROM public.cms_sync_run_chunks WHERE run_id = v_id) THEN
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

-- ── 3. Bảng chứng nhận ──────────────────────────────────────────────────────
-- Một chứng nhận CÒN HIỆU LỰC / run (không thu hồi, không bị thay); lịch sử thay thế / thu hồi giữ nguyên. Mọi ràng buộc dạng /
-- miền / FK kép chương trình–run ở DB. Không ai ghi trực tiếp: chỉ RPC SECDEF (owner) — non-owner không có quyền bảng.
CREATE TABLE public.cms_source_attestations (
  id                    uuid        PRIMARY KEY,
  program_id            uuid        NOT NULL REFERENCES public.cms_programs(id),
  run_id                uuid        NOT NULL,
  config_version        integer     NOT NULL CHECK (config_version >= 1),
  mapping_fp            text        NOT NULL CHECK (mapping_fp ~ '^[0-9a-f]{32}$'),
  basis                 text        NOT NULL CHECK (basis = 'operator_reconciliation'),
  fp_version            text        NOT NULL CHECK (fp_version = 'cms-rows-fp-v1'),
  -- PM COMP-P1-1: bằng chứng chốt CHỈ decision10 (audit14 không ràng buộc trường quyết định ⇒ không làm chứng nhận).
  field_set             text        NOT NULL CHECK (field_set = 'decision10'),
  scope_from            date        NOT NULL,
  scope_to              date        NOT NULL CHECK (scope_to >= scope_from),
  scope_hash            text        NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  run_rows_fp           text        NOT NULL CHECK (run_rows_fp ~ '^[0-9a-f]{64}$'),
  run_file_sha256       text        NOT NULL CHECK (run_file_sha256 ~ '^[0-9a-f]{64}$'),
  reference_rows_fp     text        NOT NULL CHECK (reference_rows_fp ~ '^[0-9a-f]{64}$'),
  reference_file_sha256 text        NOT NULL CHECK (reference_file_sha256 ~ '^[0-9a-f]{64}$'),
  reference_label       text        NOT NULL CHECK (char_length(reference_label) BETWEEN 3 AND 200 AND reference_label = btrim(reference_label)),
  as_of                 timestamptz NOT NULL CHECK (isfinite(as_of)),
  reference_exported_at timestamptz NOT NULL CHECK (isfinite(reference_exported_at)),
  run_exported_at       timestamptz NOT NULL CHECK (isfinite(run_exported_at)),
  lines_compared        integer     NOT NULL CHECK (lines_compared > 0),
  missing_lines         integer     NOT NULL CHECK (missing_lines = 0),
  extra_lines           integer     NOT NULL CHECK (extra_lines = 0),
  changed_lines         integer     NOT NULL CHECK (changed_lines = 0),
  tool_version          text        NOT NULL CHECK (tool_version = 'cms-i4-compare-v1'),
  ack_reason            text        NOT NULL CHECK (char_length(ack_reason) BETWEEN 10 AND 1000 AND ack_reason = btrim(ack_reason, E' \t\r\n\f\v')),
  idem_key              uuid        NOT NULL,
  payload_sha256        text        NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  attested_by           uuid        NOT NULL,
  attested_at           timestamptz NOT NULL DEFAULT now(),
  superseded_by         uuid,
  superseded_at         timestamptz,
  revoked_at            timestamptz,
  revoked_by            uuid,
  revoke_reason         text        CHECK (revoke_reason IS NULL OR (char_length(revoke_reason) BETWEEN 10 AND 1000
                                                                        AND revoke_reason = btrim(revoke_reason, E' \t\r\n\f\v'))),
  revoke_idem_key       uuid,
  CONSTRAINT cms_source_attest_run_fk FOREIGN KEY (run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id),
  CONSTRAINT cms_source_attest_superseded_fk FOREIGN KEY (superseded_by) REFERENCES public.cms_source_attestations(id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT cms_source_attest_idem UNIQUE (idem_key),
  CONSTRAINT cms_source_attest_revoke_idem UNIQUE (revoke_idem_key),
  CONSTRAINT cms_source_attest_supersede CHECK ((superseded_by IS NULL) = (superseded_at IS NULL) AND superseded_by IS DISTINCT FROM id),
  CONSTRAINT cms_source_attest_revoke CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)
                                            AND (revoked_at IS NULL) = (revoke_idem_key IS NULL)),
  CONSTRAINT cms_source_attest_one_end CHECK (superseded_by IS NULL OR revoked_at IS NULL),
  -- Mốc M ≤ lúc xuất cả hai file (PM I4F-P1-1).
  CONSTRAINT cms_source_attest_times CHECK (as_of <= reference_exported_at AND as_of <= run_exported_at),
  -- KHỚP decision10 ⇒ vân tay tham chiếu = vân tay run (cùng định nghĩa, 0 thiếu / thừa / lệch) — vô điều kiện.
  CONSTRAINT cms_source_attest_fp CHECK (reference_rows_fp = run_rows_fp),
  -- Khoá ba cột cho FK payout ⇒ payout chỉ trỏ chứng nhận CỦA ĐÚNG chương trình + run (db-reviewer r2 P2-1).
  CONSTRAINT cms_source_attest_bind UNIQUE (id, program_id, run_id)
);
CREATE UNIQUE INDEX cms_source_attest_one_live ON public.cms_source_attestations (run_id)
  WHERE revoked_at IS NULL AND superseded_by IS NULL;
CREATE INDEX cms_source_attest_program_idx ON public.cms_source_attestations (program_id, attested_at DESC);
ALTER TABLE public.cms_source_attestations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cms_source_attestations FROM PUBLIC, anon, authenticated, service_role;

-- Payout tham chiếu chứng nhận đã dùng (bất biến sau chốt như 123).
ALTER TABLE public.cms_payouts ADD COLUMN source_attestation_id uuid REFERENCES public.cms_source_attestations(id);
ALTER TABLE public.cms_payouts DROP CONSTRAINT cms_payouts_source_complete_basis_check;
ALTER TABLE public.cms_payouts ADD CONSTRAINT cms_payouts_source_complete_basis_check
  CHECK (source_complete_basis IN ('qa_assumption', 'bi_watermark', 'lag_commitment', 'operator_reconciliation'));
ALTER TABLE public.cms_payouts ADD CONSTRAINT cms_payouts_attestation
  CHECK ((source_complete_basis = 'operator_reconciliation') = (source_attestation_id IS NOT NULL));
ALTER TABLE public.cms_payouts ADD CONSTRAINT cms_payouts_attest_bind_fk
  FOREIGN KEY (source_attestation_id, program_id, run_id) REFERENCES public.cms_source_attestations (id, program_id, run_id);

-- ── 4. Guard bất biến chứng nhận ────────────────────────────────────────────
-- INSERT (r1, db-reviewer P2-10): dòng mới phải còn hiệu lực và chương trình CHƯA chốt — khoá FOR SHARE dòng chương trình ⇒ lượt
-- chốt đang giữ FOR UPDATE thì chờ rồi thấy 'locked' (chặn cả owner ghi thẳng). DELETE: luôn từ chối. UPDATE: CHỈ chuyển
-- còn-hiệu-lực ⇒ bị thay (superseded_*) hoặc ⇒ thu hồi (revoked_*), mọi cột khác giữ nguyên, và chỉ khi chương trình CHƯA chốt +
-- chứng nhận chưa được payout dùng. Áp cả owner (ENABLE ALWAYS).
CREATE FUNCTION public.cms__attest_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_st text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.superseded_by IS NOT NULL OR NEW.superseded_at IS NOT NULL THEN
      RAISE EXCEPTION 'CMS_ATTEST_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    SELECT status INTO v_st FROM public.cms_programs WHERE id = NEW.program_id FOR SHARE;
    IF v_st IS NOT DISTINCT FROM 'locked' THEN
      RAISE EXCEPTION 'CMS_ATTEST_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CMS_ATTEST_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  -- Khoá FOR SHARE chương trình TRƯỚC khi đọc trạng thái / payout (db-reviewer r2 P2-2): lượt chốt đang giữ FOR UPDATE ⇒ chờ
  -- rồi thấy 'locked' + payout đã commit (FK payout chỉ giữ KEY SHARE, không chặn UPDATE cột thường).
  SELECT status INTO v_st FROM public.cms_programs WHERE id = OLD.program_id FOR SHARE;
  IF OLD.revoked_at IS NOT NULL OR OLD.superseded_by IS NOT NULL OR v_st IS NOT DISTINCT FROM 'locked'
     OR EXISTS (SELECT 1 FROM public.cms_payouts p WHERE p.source_attestation_id = OLD.id) THEN
    RAISE EXCEPTION 'CMS_ATTEST_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.program_id, NEW.run_id, NEW.config_version, NEW.mapping_fp, NEW.basis, NEW.fp_version, NEW.field_set,
      NEW.scope_from, NEW.scope_to, NEW.scope_hash, NEW.run_rows_fp, NEW.run_file_sha256, NEW.reference_rows_fp,
      NEW.reference_file_sha256, NEW.reference_label, NEW.as_of, NEW.reference_exported_at, NEW.run_exported_at,
      NEW.lines_compared, NEW.missing_lines, NEW.extra_lines, NEW.changed_lines, NEW.tool_version, NEW.ack_reason,
      NEW.idem_key, NEW.payload_sha256, NEW.attested_by, NEW.attested_at)
     IS DISTINCT FROM
     (OLD.id, OLD.program_id, OLD.run_id, OLD.config_version, OLD.mapping_fp, OLD.basis, OLD.fp_version, OLD.field_set,
      OLD.scope_from, OLD.scope_to, OLD.scope_hash, OLD.run_rows_fp, OLD.run_file_sha256, OLD.reference_rows_fp,
      OLD.reference_file_sha256, OLD.reference_label, OLD.as_of, OLD.reference_exported_at, OLD.run_exported_at,
      OLD.lines_compared, OLD.missing_lines, OLD.extra_lines, OLD.changed_lines, OLD.tool_version, OLD.ack_reason,
      OLD.idem_key, OLD.payload_sha256, OLD.attested_by, OLD.attested_at) THEN
    RAISE EXCEPTION 'CMS_ATTEST_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 5. Đánh giá chứng nhận của run (dùng chung preview / chốt / đọc) ─────────
-- Trả {id, scope_to, field_set, code}; code NULL = dùng được. Kiểm LẠI tại thời điểm gọi: config / mapping / scope hiện tại,
-- vân tay dòng tính lại từ lớp nguồn, lớp nguồn khớp lớp engine. Không có chứng nhận hiệu lực ⇒ {code: 'NONE'}.
CREATE FUNCTION public.cms__attest_eval(p_program_id uuid, p_run_id uuid)
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

-- ── 6. RPC (authenticated — phiên super thật) ──────────────────────────────
-- Payload (mọi giá trị chuỗi): fp_version, field_set, scope_from, scope_to, scope_hash, run_rows_fp, run_file_sha256,
-- reference_rows_fp, reference_file_sha256, reference_label, as_of, reference_exported_at, run_exported_at, lines_compared,
-- missing_lines, extra_lines, changed_lines, tool_version, ack_reason. Khoá thừa ⇒ BAD_INPUT. Không actor trong payload.
CREATE FUNCTION public.rpc_cms_source_attest(p_program_id uuid, p_run_id uuid, p_payload jsonb, p_idem uuid)
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

CREATE FUNCTION public.rpc_cms_source_attest_revoke(p_attestation_id uuid, p_reason text, p_idem uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '2s' AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_pid  uuid;
  v_a    public.cms_source_attestations%ROWTYPE;
  v_o    public.cms_source_attestations%ROWTYPE;
  v_prog public.cms_programs%ROWTYPE;
  v_con  text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'CMS_ATTEST_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  IF p_attestation_id IS NULL OR p_idem IS NULL OR p_reason IS NULL
     OR char_length(btrim(p_reason, E' \t\r\n\f\v')) NOT BETWEEN 10 AND 1000 OR p_reason ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]' THEN
    RAISE EXCEPTION 'CMS_ATTEST_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT program_id INTO v_pid FROM public.cms_source_attestations WHERE id = p_attestation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_ATTEST_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- Phạm vi QA như attest (db-reviewer P1-1).
  IF NOT COALESCE(v_pid = ANY (public.cms_readable_program_ids()), false) THEN
    RAISE EXCEPTION 'CMS_ATTEST_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Cùng thứ tự khoá: chương trình → chứng nhận (chốt giữ khoá chương trình tới COMMIT ⇒ thu hồi chờ / thấy 'locked').
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_pid FOR UPDATE;
  SELECT * INTO v_a FROM public.cms_source_attestations WHERE id = p_attestation_id FOR UPDATE;
  -- Idempotency (r1 P2-3): cùng khoá ⇒ chỉ "already" khi cùng chứng nhận + cùng người + cùng lý do; khác ⇒ IDEM_CONFLICT.
  SELECT * INTO v_o FROM public.cms_source_attestations WHERE revoke_idem_key = p_idem;
  IF FOUND THEN
    IF v_o.id = p_attestation_id AND v_o.revoked_by = v_uid AND v_o.revoke_reason = btrim(p_reason, E' \t\r\n\f\v') THEN
      RETURN jsonb_build_object('revoked', true, 'already', true, 'id', v_o.id);
    END IF;
    RAISE EXCEPTION 'CMS_ATTEST_IDEM_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF v_prog.status = 'locked' THEN RAISE EXCEPTION 'CMS_PROGRAM_LOCKED' USING ERRCODE = 'P0001'; END IF;
  IF v_a.revoked_at IS NOT NULL OR v_a.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'CMS_ATTEST_NOT_LIVE' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    UPDATE public.cms_source_attestations
       SET revoked_at = now(), revoked_by = v_uid, revoke_reason = btrim(p_reason, E' \t\r\n\f\v'), revoke_idem_key = p_idem
     WHERE id = p_attestation_id;
  EXCEPTION WHEN unique_violation THEN
    -- cùng khoá đang dùng song song cho chứng nhận của chương trình khác ⇒ chờ rồi vi phạm unique.
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    IF v_con = 'cms_source_attest_revoke_idem' THEN RAISE EXCEPTION 'CMS_ATTEST_IDEM_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    RAISE;
  END;
  RETURN jsonb_build_object('revoked', true, 'already', false, 'id', v_a.id);
END;
$$;

-- Xuất SNAPSHOT lớp nguồn của MỘT run đã công bố (run ghim), keyset theo byte order_line_id; 14 trường chuỗi như file CSV chuẩn
-- (số scale 9 dạng thập phân, thời gian ISO micro giây UTC). Chỉ super + chương trình đọc được. KHÔNG phải chứng nhận: chỉ kiểm quyền /
-- run công bố / chưa dọn / source_schema rồi phân trang — không gọi cms__run_source_check (PM COMP-P2-2: không quét toàn lớp mỗi
-- trang). CLI đọc đủ trang, ghim run, kiểm ID / count / hash trước khi dựng payload; attest / đánh giá chốt mới kiểm toàn lớp.
CREATE FUNCTION public.rpc_cms_run_source_export(p_program_id uuid, p_run_id uuid, p_after_line_id text DEFAULT NULL, p_limit integer DEFAULT 5000)
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
                            'next_after', CASE WHEN v_n = p_limit THEN v_last END,
                            'total', CASE WHEN p_after_line_id IS NULL
                                          THEN (SELECT count(*) FROM public.cms_sales_source_lines s WHERE s.run_id = p_run_id) END);
END;
$$;

CREATE FUNCTION public.rpc_cms_source_attestations(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin()
     OR NOT COALESCE(p_program_id = ANY (public.cms_readable_program_ids()), false) THEN  -- r1 P1-1: QA cần marker
    RAISE EXCEPTION 'CMS_ATTEST_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_program_id IS NULL THEN RAISE EXCEPTION 'CMS_ATTEST_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', a.id, 'run_id', a.run_id, 'field_set', a.field_set, 'scope_from', to_char(a.scope_from, 'YYYY-MM-DD'),
            'scope_to', to_char(a.scope_to, 'YYYY-MM-DD'), 'lines_compared', a.lines_compared, 'reference_label', a.reference_label,
            'as_of', public.cms__ts(a.as_of), 'attested_by', a.attested_by, 'attested_at', public.cms__ts(a.attested_at),
            'superseded_by', a.superseded_by, 'revoked_at', public.cms__ts(a.revoked_at), 'revoked_by', a.revoked_by,
            'live', a.revoked_at IS NULL AND a.superseded_by IS NULL,
            'used_by_payout', EXISTS (SELECT 1 FROM public.cms_payouts p WHERE p.source_attestation_id = a.id))
            ORDER BY a.attested_at DESC, a.id), '[]'::jsonb)
            FROM public.cms_source_attestations a WHERE a.program_id = p_program_id);
END;
$$;

-- ── 8. Hàm 123 thay (sinh từ thân nguyên văn 123 + vá gen-cms-124) ────────────
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
DROP FUNCTION public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text);
CREATE FUNCTION public.rpc_cms_program_lock(p_program_id uuid, p_expected_run_id uuid, p_expected_policy_version integer,
                                            p_actor uuid, p_ack_reason text DEFAULT NULL,
                                            p_expected_attestation_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '2s' AS $$
DECLARE
  v_prog public.cms_programs%ROWTYPE;
  v_run  public.cms_sync_runs%ROWTYPE;
  v_pay  public.cms_payouts%ROWTYPE;
  v_ev   jsonb;
  v_ack  text;
  v_n    integer;
  v_paid integer;
  v_sum  numeric;
BEGIN
  IF p_program_id IS NULL OR p_expected_run_id IS NULL OR p_expected_policy_version IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'CMS_LOCK_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- Sau khoá cần snapshot mới mỗi câu lệnh (đọc thấy ghi đã commit trong lúc chờ) ⇒ bắt buộc READ COMMITTED (mẫu 121).
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_actor) THEN
    RAISE EXCEPTION 'CMS_LOCK_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- 1. Chương trình FOR UPDATE — giữ tới COMMIT (DML cấu hình / publish / cleanup / open chờ).
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- 2. Đã chốt: gọi lại cùng run ⇒ already.
  IF v_prog.status = 'locked' THEN
    SELECT * INTO v_pay FROM public.cms_payouts WHERE program_id = p_program_id;
    IF FOUND AND v_pay.run_id = p_expected_run_id
       AND v_pay.source_attestation_id IS NOT DISTINCT FROM p_expected_attestation_id THEN  -- 124
      RETURN jsonb_build_object('locked', true, 'already', true, 'program_id', p_program_id, 'run_id', v_pay.run_id,
                                'amount_vnd', v_pay.amount_vnd::text, 'policy_version', v_pay.policy_version,
                                'source_attestation_id', v_pay.source_attestation_id);
    END IF;
    RAISE EXCEPTION 'CMS_PROGRAM_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  -- Run hiện hành FOR UPDATE (thứ tự chương trình → run); ghi trực tiếp dữ liệu run giữ FOR SHARE ⇒ chờ nhau.
  IF v_prog.current_result_run_id IS NOT NULL THEN
    SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = v_prog.current_result_run_id FOR UPDATE;
  END IF;
  -- 3–9. Đánh giá SAU khoá; blocker đầu tiên ⇒ RAISE (không ghi gì).
  v_ev := public.cms__lock_eval(p_program_id, p_expected_run_id, p_expected_policy_version, p_ack_reason, true);
  IF jsonb_array_length(v_ev -> 'blockers') > 0 THEN
    RAISE EXCEPTION USING MESSAGE = v_ev -> 'blockers' ->> 0, ERRCODE = 'P0001';
  END IF;
  -- 124: chốt bằng chứng nhận ⇒ phải đúng chứng nhận preview đã thấy (đổi / thu hồi / chứng nhận lại giữa preview và chốt ⇒ chặn).
  IF (v_ev ->> 'source_complete_basis') = 'operator_reconciliation' OR p_expected_attestation_id IS NOT NULL THEN
    IF p_expected_attestation_id IS NULL OR (v_ev ->> 'source_complete_basis') IS DISTINCT FROM 'operator_reconciliation'
       OR (v_ev -> 'source_attestation' ->> 'id')::uuid IS DISTINCT FROM p_expected_attestation_id THEN
      RAISE EXCEPTION 'CMS_LOCK_EVIDENCE_CHANGED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  v_ack := CASE WHEN (v_ev ->> 'unassigned_lines')::integer > 0 THEN btrim(p_ack_reason, E' \t\r\n\f\v') END;
  -- 10. Payout + staff (định danh từ users / stores — snapshot).
  INSERT INTO public.cms_payouts (program_id, run_id, config_version, config_fp, mapping_fp, is_test, amount_vnd, staff_rows,
    staff_paid, candidate_lines, candidate_gmv, unassigned_lines, unassigned_gmv, policy, policy_version, ack_reason,
    run_started_at, source_complete_basis, source_complete_through, locked_by, source_attestation_id)
  VALUES (p_program_id, v_run.id, v_run.config_version, public.cms__config_fp(p_program_id), v_run.mapping_fp, v_run.is_test,
    v_run.amount_vnd, (v_ev ->> 'staff_rows')::integer, (v_ev ->> 'staff_paid')::integer, (v_ev ->> 'candidate_lines')::integer,
    (v_ev ->> 'candidate_gmv')::numeric, (v_ev ->> 'unassigned_lines')::integer, (v_ev ->> 'unassigned_gmv')::numeric,
    v_ev -> 'policy', (v_ev ->> 'policy_version')::integer, v_ack, v_run.started_at, v_ev ->> 'source_complete_basis',
    (v_ev ->> 'source_complete_through')::date, p_actor,
    CASE WHEN (v_ev ->> 'source_complete_basis') = 'operator_reconciliation' THEN (v_ev -> 'source_attestation' ->> 'id')::uuid END);
  INSERT INTO public.cms_payout_staff (program_id, user_id, store_id, email_snapshot, name_snapshot, store_name_snapshot,
                                       amount_vnd, products_with_cms)
  SELECT p_program_id, a.user_id, a.store_id, u.email, u.full_name, s.name, a.amt::bigint, a.np
    FROM (SELECT r.user_id, (array_agg(DISTINCT r.store_id))[1] AS store_id, sum(r.amount_vnd) AS amt,
                 count(*) FILTER (WHERE r.amount_vnd > 0)::integer AS np
            FROM public.cms_results r WHERE r.run_id = v_run.id GROUP BY r.user_id) a
    LEFT JOIN public.users u ON u.id = a.user_id
    LEFT JOIN public.stores s ON s.id = a.store_id;
  -- 11. Kiểm lại mapping SAU khi chép định danh (user / store đổi chen giữa ⇒ rollback) + bất biến tổng 4 nơi.
  IF public.cms__mapping_fp() IS DISTINCT FROM v_run.mapping_fp THEN
    RAISE EXCEPTION 'CMS_LOCK_STALE_MAPPING' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE amount_vnd > 0), COALESCE(sum(amount_vnd), 0) INTO v_n, v_paid, v_sum
    FROM public.cms_payout_staff WHERE program_id = p_program_id;
  IF v_sum <> v_run.amount_vnd::numeric
     OR v_sum <> (SELECT COALESCE(sum(r.amount_vnd), 0) FROM public.cms_results r WHERE r.run_id = v_run.id)
     OR v_n <> (SELECT count(DISTINCT r.user_id) FROM public.cms_results r WHERE r.run_id = v_run.id)
     OR v_n <> (v_ev ->> 'staff_rows')::integer OR v_paid <> (v_ev ->> 'staff_paid')::integer THEN
    RAISE EXCEPTION 'CMS_LOCK_TOTAL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  -- 12. Chốt.
  UPDATE public.cms_programs SET status = 'locked', locked_at = now(), locked_by = p_actor, updated_by = p_actor, updated_at = now()
   WHERE id = p_program_id;
  RETURN jsonb_build_object('locked', true, 'already', false, 'program_id', p_program_id, 'run_id', v_run.id,
                            'amount_vnd', v_run.amount_vnd::text, 'staff_rows', v_n, 'staff_paid', v_paid,
                            'unassigned_lines', (v_ev ->> 'unassigned_lines')::integer, 'policy_version', (v_ev ->> 'policy_version')::integer,
                            'source_complete_basis', v_ev ->> 'source_complete_basis',
                            'source_attestation_id', v_ev -> 'source_attestation' ->> 'id');
END;
$$;
CREATE OR REPLACE FUNCTION public.rpc_cms_payout(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pay   public.cms_payouts%ROWTYPE;
  v_su    boolean;
  v_users uuid[];
  v_rows  jsonb;
  v_scope numeric;
BEGIN
  IF auth.uid() IS NULL OR p_program_id IS NULL OR NOT (p_program_id = ANY (public.cms_readable_program_ids())) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_pay FROM public.cms_payouts WHERE program_id = p_program_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PAYOUT_NOT_LOCKED' USING ERRCODE = 'P0002'; END IF;
  v_su := public.is_super_admin();
  v_users := CASE WHEN v_su THEN NULL ELSE COALESCE(public.cms__visible_result_users(), '{}'::uuid[]) END;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', s.user_id, 'store_id', s.store_id, 'name', s.name_snapshot, 'store_name', s.store_name_snapshot,
           'amount_vnd', s.amount_vnd::text, 'products_with_cms', s.products_with_cms)
           || CASE WHEN v_su THEN jsonb_build_object('email', s.email_snapshot) ELSE '{}'::jsonb END
           ORDER BY s.store_name_snapshot, s.name_snapshot, s.user_id), '[]'::jsonb),
         COALESCE(sum(s.amount_vnd), 0)
    INTO v_rows, v_scope
    FROM public.cms_payout_staff s
   WHERE s.program_id = p_program_id AND (v_users IS NULL OR s.user_id = ANY (v_users));
  RETURN jsonb_build_object(
    'program_id', p_program_id, 'run_id', v_pay.run_id, 'is_test', v_pay.is_test, 'locked_at', public.cms__ts(v_pay.locked_at),
    'policy_version', v_pay.policy_version,
    'viewer', CASE WHEN v_su THEN 'super' ELSE (SELECT u.role FROM public.users u WHERE u.id = auth.uid()) END,
    'program_total', CASE WHEN v_su THEN v_pay.amount_vnd::text END,
    'scope_total', v_scope::text,
    'rows', v_rows)
    || CASE WHEN v_su THEN jsonb_build_object(
         'locked_by', v_pay.locked_by, 'staff_rows', v_pay.staff_rows, 'staff_paid', v_pay.staff_paid,
         'candidate_lines', v_pay.candidate_lines, 'candidate_gmv', v_pay.candidate_gmv::text,
         'unassigned_lines', v_pay.unassigned_lines, 'unassigned_gmv', v_pay.unassigned_gmv::text,
         'ack_reason', v_pay.ack_reason, 'policy', v_pay.policy, 'source_complete_basis', v_pay.source_complete_basis,
         'source_complete_through', to_char(v_pay.source_complete_through, 'YYYY-MM-DD'),
         'source_attestation_id', v_pay.source_attestation_id,
         -- 124: tóm tắt chứng nhận đã dùng chốt (bất biến) cho XLSX / khối chốt — không actor / email / hash file.
         'source_attestation', (SELECT jsonb_build_object('field_set', a.field_set, 'as_of', public.cms__ts(a.as_of),
                                         'reference_label', a.reference_label, 'lines_compared', a.lines_compared,
                                         'attested_at', public.cms__ts(a.attested_at), 'run_rows_fp', a.run_rows_fp)
                                  FROM public.cms_source_attestations a WHERE a.id = v_pay.source_attestation_id),
         'run_started_at', public.cms__ts(v_pay.run_started_at)) ELSE '{}'::jsonb END;
END;
$$;

-- ── 9. Trigger bảng mới ─────────────────────────────────────────────────────
CREATE FUNCTION public.cms__attest_truncate_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'CMS_ATTEST_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$;

-- Lớp nguồn = dữ liệu run: cùng guard 123 (đóng băng sau chốt, chỉ owner / RPC ghi, TRUNCATE khi có payout ⇒ từ chối).
CREATE TRIGGER cms_frozen_ins AFTER INSERT ON public.cms_sales_source_lines REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_ins();
CREATE TRIGGER cms_frozen_upd AFTER UPDATE ON public.cms_sales_source_lines REFERENCING OLD TABLE AS cms_old NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_upd();
CREATE TRIGGER cms_frozen_del AFTER DELETE ON public.cms_sales_source_lines REFERENCING OLD TABLE AS cms_old
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_del();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_sales_source_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_frozen_truncate BEFORE TRUNCATE ON public.cms_sales_source_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_truncate_guard();
-- Chứng nhận: chỉ RPC (owner) ghi; dòng bất biến trừ chuyển thay thế / thu hồi trước chốt; không DELETE / TRUNCATE.
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_source_attestations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_attest_immutable BEFORE UPDATE OR DELETE ON public.cms_source_attestations
  FOR EACH ROW EXECUTE FUNCTION public.cms__attest_immutable();
-- r1 (db-reviewer P2-10): chặn INSERT chứng nhận cho chương trình đã chốt (kể cả owner); trigger riêng để đột biến test tắt được.
CREATE TRIGGER cms_attest_insert_guard BEFORE INSERT ON public.cms_source_attestations
  FOR EACH ROW EXECUTE FUNCTION public.cms__attest_immutable();
CREATE TRIGGER cms_attest_truncate BEFORE TRUNCATE ON public.cms_source_attestations
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__attest_truncate_guard();
REVOKE ALL ON public.cms_sales_source_lines, public.cms_source_attestations FROM PUBLIC, anon, authenticated, service_role;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, t.tgname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
       AND c.relname IN ('cms_sales_source_lines', 'cms_source_attestations')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', r.relname, r.tgname);
  END LOOP;
END $$;

-- ── 10. ACL hàm ─────────────────────────────────────────────────────────────
-- 18 hàm = 13 mới / đổi chữ ký + 5 hàm thay bằng CREATE OR REPLACE (run_open, stage, cleanup, lock_eval, payout — gate ACL áp cả hàm
-- OR REPLACE; ma trận giữ đúng 122 / 123). Ma trận: 4 RPC 124 + rpc_cms_payout → authenticated; lock 6 tham số + run_open +
-- stage + cleanup → service_role; còn lại không ai ngoài owner.
REVOKE ALL ON FUNCTION
  public.cms__fp_j(text), public.cms__run_source_fp_text(uuid, text), public.cms__run_source_fp(uuid, text),
  public.cms__program_scope_hash(uuid), public.cms__run_source_check(uuid), public.cms__attest_immutable(),
  public.cms__attest_eval(uuid, uuid), public.cms__attest_truncate_guard(),
  public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid), public.rpc_cms_source_attest_revoke(uuid, text, uuid),
  public.rpc_cms_run_source_export(uuid, uuid, text, integer), public.rpc_cms_source_attestations(uuid),
  public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text, uuid),
  public.rpc_cms_sales_run_open(uuid, jsonb), public.rpc_cms_sales_run_stage(uuid, text, integer, jsonb),
  public.rpc_cms_sales_run_cleanup(uuid, integer), public.cms__lock_eval(uuid, uuid, integer, text, boolean), public.rpc_cms_payout(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid), public.rpc_cms_source_attest_revoke(uuid, text, uuid),
  public.rpc_cms_run_source_export(uuid, uuid, text, integer), public.rpc_cms_source_attestations(uuid),
  public.rpc_cms_payout(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text, uuid),
  public.rpc_cms_sales_run_open(uuid, jsonb), public.rpc_cms_sales_run_stage(uuid, text, integer, jsonb),
  public.rpc_cms_sales_run_cleanup(uuid, integer) TO service_role;
-- Thu hồi mọi grant khác owner do default privileges cấp (bài học SEC-1 / 091 / 117 / 120 / 122 / 123).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, x.grantee, p.proname
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('cms__fp_j', 'cms__run_source_fp_text', 'cms__run_source_fp', 'cms__program_scope_hash', 'cms__run_source_check',
                         'cms__attest_immutable', 'cms__attest_eval', 'cms__attest_truncate_guard', 'rpc_cms_source_attest',
                         'rpc_cms_source_attest_revoke', 'rpc_cms_run_source_export', 'rpc_cms_source_attestations', 'rpc_cms_program_lock',
                         'rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_cleanup', 'cms__lock_eval', 'rpc_cms_payout')
       AND x.grantee <> p.proowner
       AND NOT (p.proname IN ('rpc_cms_source_attest', 'rpc_cms_source_attest_revoke', 'rpc_cms_run_source_export', 'rpc_cms_source_attestations',
                              'rpc_cms_payout')
                AND x.grantee = 'authenticated'::regrole::oid)
       AND NOT (p.proname IN ('rpc_cms_program_lock', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_cleanup')
                AND x.grantee = 'service_role'::regrole::oid)
     GROUP BY p.oid, x.grantee, p.proname
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- ── 11. Hậu kiểm trong transaction ──────────────────────────────────────────
DO $$
DECLARE
  r     record;
  v_exp text;
  v_lt  text;
  v_n   integer;
BEGIN
  v_n := 0;
  FOR r IN
    SELECT p.proname, p.prosecdef, p.proconfig,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END
                              || ':' || x.privilege_type, ',' ORDER BY 1)
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl,
           has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
           has_function_privilege('service_role', p.oid, 'EXECUTE') s
      FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('cms__fp_j', 'cms__run_source_fp_text', 'cms__run_source_fp', 'cms__program_scope_hash', 'cms__run_source_check',
                         'cms__attest_immutable', 'cms__attest_eval', 'cms__attest_truncate_guard', 'rpc_cms_source_attest',
                         'rpc_cms_source_attest_revoke', 'rpc_cms_run_source_export', 'rpc_cms_source_attestations', 'rpc_cms_program_lock',
                         'rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_cleanup', 'cms__lock_eval', 'rpc_cms_payout')
  LOOP
    v_n := v_n + 1;
    v_exp := CASE WHEN r.proname IN ('rpc_cms_source_attest', 'rpc_cms_source_attest_revoke', 'rpc_cms_run_source_export',
                                     'rpc_cms_source_attestations', 'rpc_cms_payout') THEN 'authenticated:EXECUTE'
                  WHEN r.proname IN ('rpc_cms_program_lock', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_cleanup')
                    THEN 'service_role:EXECUTE' END;
    -- lock_timeout: 3 RPC ghi 124 = 2s (hạn CHỜ KHOÁ, không phải hạn tổng RPC); run_open / stage / cleanup giữ 5s như 122.
    v_lt := CASE WHEN r.proname IN ('rpc_cms_source_attest', 'rpc_cms_source_attest_revoke', 'rpc_cms_program_lock') THEN 'lock_timeout=2s'
                 WHEN r.proname IN ('rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_cleanup') THEN 'lock_timeout=5s' END;
    IF r.acl IS DISTINCT FROM v_exp OR r.a OR NOT r.prosecdef OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}')))
       OR r.u IS DISTINCT FROM COALESCE(v_exp = 'authenticated:EXECUTE', false)
       OR r.s IS DISTINCT FROM COALESCE(v_exp = 'service_role:EXECUTE', false)
       OR (v_lt IS NOT NULL AND NOT (v_lt = ANY (COALESCE(r.proconfig, '{}')))) THEN
      RAISE EXCEPTION '124 hậu kiểm: ACL / SECDEF / search_path / lock_timeout hàm % sai (acl %, config %)', r.proname, r.acl, r.proconfig;
    END IF;
  END LOOP;
  IF v_n <> 18 THEN RAISE EXCEPTION '124 hậu kiểm: cần đúng 18 hàm 124 (13 mới / đổi chữ ký + 5 thay OR REPLACE), có %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'rpc_cms_program_lock';
  IF v_n <> 1 THEN RAISE EXCEPTION '124 hậu kiểm: rpc_cms_program_lock phải còn đúng 1 chữ ký (6 tham số), có %', v_n; END IF;
  -- Tổng hàm CMS: 55 sau 123 + 12 (12 tên mới; lock đổi chữ ký giữ 1).
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> 67 THEN RAISE EXCEPTION '124 hậu kiểm: tổng hàm CMS phải 67, có %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_sales_source_lines'::regclass, 'public.cms_source_attestations'::regclass)
                AND (NOT c.relrowsecurity OR c.relforcerowsecurity
                     OR EXISTS (SELECT 1 FROM pg_catalog.pg_policies q WHERE q.schemaname = 'public' AND q.tablename = c.relname)
                     OR has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                     OR has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                     OR has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) THEN
    RAISE EXCEPTION '124 hậu kiểm: bảng mới phải RLS (không FORCE, 0 policy) và không quyền anon / authenticated / service_role';
  END IF;
  -- 9 trigger đúng tên / bảng / hàm / tgtype, ENABLE ALWAYS. tgtype = bit ROW 1 · BEFORE 2 · INSERT 4 · DELETE 8 · UPDATE 16 ·
  -- TRUNCATE 32 (không phụ thuộc thứ tự sự kiện khi deparse pg_get_triggerdef).
  SELECT count(*) INTO v_n
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN (VALUES
      ('cms_sales_source_lines', 'cms_frozen_ins', 'cms__frozen_data_ins', 4),            -- AFTER INSERT, statement
      ('cms_sales_source_lines', 'cms_frozen_upd', 'cms__frozen_data_upd', 16),           -- AFTER UPDATE, statement
      ('cms_sales_source_lines', 'cms_frozen_del', 'cms__frozen_data_del', 8),            -- AFTER DELETE, statement
      ('cms_sales_source_lines', 'cms_run_auth_guard', 'cms__run_auth_guard', 30),        -- BEFORE INSERT / UPDATE / DELETE, statement
      ('cms_sales_source_lines', 'cms_frozen_truncate', 'cms__frozen_truncate_guard', 34),-- BEFORE TRUNCATE
      ('cms_source_attestations', 'cms_run_auth_guard', 'cms__run_auth_guard', 30),
      ('cms_source_attestations', 'cms_attest_immutable', 'cms__attest_immutable', 27),   -- BEFORE UPDATE / DELETE, row
      ('cms_source_attestations', 'cms_attest_insert_guard', 'cms__attest_immutable', 7), -- BEFORE INSERT, row
      ('cms_source_attestations', 'cms_attest_truncate', 'cms__attest_truncate_guard', 34)
    ) AS e(rel, tg, fn, tt) ON e.rel = c.relname AND e.tg = t.tgname
   WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgenabled = 'A'
     AND t.tgfoid = ('public.' || e.fn || '()')::regprocedure AND t.tgtype = e.tt;
  IF v_n <> 9 OR (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
                   WHERE c.relname IN ('cms_sales_source_lines', 'cms_source_attestations') AND NOT t.tgisinternal) <> 9 THEN
    RAISE EXCEPTION '124 hậu kiểm: cần đúng 9 trigger (tên / hàm / thời điểm) ENABLE ALWAYS trên 2 bảng mới, khớp %', v_n;
  END IF;
  -- Cổng thật vẫn đóng.
  IF (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION '124 hậu kiểm: policy thật không được ready';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('124', 'cms_source_attestation', 'CMS COMP-INT: lớp nguồn run (source_lines 14 trường thô; run_open trả source_schema) + chứng nhận đối soát CHỈ decision10 gắn run / config / mapping / scope / vân tay cms-rows-fp-v1; basis operator_reconciliation; real.ready giữ false');

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — sẽ thành cms-verify --phase=124) ──────────
-- Sau 124, cms-verify phase 122 / 123 ĐỎ đúng thiết kế (md5 5 hàm thay, chữ ký lock, trigger tên-123 46 → 52, tổng hàm 55 → 67)
-- ⇒ manifest VERIFY cập nhật cùng phase 124.
-- V1 marker:
--   SELECT version, name FROM public.app_migrations WHERE version IN ('123', '124') ORDER BY 1;   -- cms_payouts, cms_source_attestation
-- V2 ACL 18 hàm (13 mới / đổi chữ ký + 5 thay):
--   SELECT p.oid::regprocedure fn, p.prosecdef, p.proconfig,
--          has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') authn,
--          has_function_privilege('service_role', p.oid, 'EXECUTE') svc,
--          (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ',')
--             FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) acl
--     FROM pg_proc p
--    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('cms__fp_j', 'cms__run_source_fp_text', 'cms__run_source_fp',
--      'cms__program_scope_hash', 'cms__run_source_check', 'cms__attest_immutable', 'cms__attest_eval', 'cms__attest_truncate_guard',
--      'rpc_cms_source_attest', 'rpc_cms_source_attest_revoke', 'rpc_cms_run_source_export', 'rpc_cms_source_attestations',
--      'rpc_cms_program_lock', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_cleanup', 'cms__lock_eval', 'rpc_cms_payout') ORDER BY 1;
--   -- 18 dòng; anon f toàn bộ; authn t đúng 5 (4 RPC 124 + rpc_cms_payout); svc t đúng 4 (lock 6 tham số, run_open, stage, cleanup);
--   -- acl đúng 1 grantee hoặc NULL; prosecdef t; proconfig ∋ search_path=public; attest / revoke / lock ∋ lock_timeout=2s;
--   -- run_open / stage / cleanup ∋ lock_timeout=5s.
-- V3 bảng + trigger:
--   SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) owner,
--          (SELECT count(*) FROM pg_policies q WHERE q.schemaname = 'public' AND q.tablename = c.relname) policies,
--          (SELECT string_agg(r || ':' || pr, ',') FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r
--             CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) pr
--            WHERE has_table_privilege(r, c.oid, pr)) api_privs
--     FROM pg_class c WHERE c.oid IN ('public.cms_sales_source_lines'::regclass, 'public.cms_source_attestations'::regclass);
--   -- rls t, force f, policies 0, api_privs NULL
--   SELECT c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
--    WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
--      AND c.relname IN ('cms_sales_source_lines', 'cms_source_attestations') ORDER BY 1, 2;   -- 9 dòng, tgenabled 'A'
-- V4 ràng buộc / cột / chữ ký / tổng hàm / cổng thật / môi trường:
--   SELECT conrelid::regclass, conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname IN ('cms_sync_run_chunks_part_check', 'cms_payouts_source_complete_basis_check', 'cms_payouts_attestation',
--                      'cms_source_attest_superseded_fk', 'cms_source_attest_fp', 'cms_source_attest_times') ORDER BY 1, 2;
--   SELECT pg_get_indexdef('public.cms_source_attest_one_live'::regclass);
--   -- bất biến COMP-P1-1 ở DDL — 2 dòng: CHECK ((field_set = 'decision10'::text)) · CHECK ((reference_rows_fp = run_rows_fp))
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.cms_source_attestations'::regclass AND contype = 'c'
--      AND pg_get_constraintdef(oid) ~ 'field_set|reference_rows_fp';
--   SELECT count(*) FILTER (WHERE field_set <> 'decision10') bad_fs, count(*) FILTER (WHERE reference_rows_fp <> run_rows_fp) bad_fp
--     FROM public.cms_source_attestations;                                                              -- 0 | 0
--   SELECT id FROM public.cms_sync_runs WHERE kind = 'sales' AND source_schema = 1 AND status = 'ok'
--      AND COALESCE((seal_expect ->> 'rows_rejected')::bigint, 0) <> 0;                                 -- 0 dòng (không chứng nhận được)
--   SELECT position('RETURNING id, source_schema INTO v_id, v_sch' IN prosrc) > 0
--     FROM pg_proc WHERE oid = 'public.rpc_cms_sales_run_open(uuid,jsonb)'::regprocedure;                  -- t (f sau rollback)
--   SELECT column_default FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'cms_sync_runs' AND column_name = 'source_schema';                -- 1
--   SELECT oid::regprocedure FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'rpc_cms_program_lock'; -- 1 dòng, 6 tham số
--   SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%'); -- 67
--   SELECT public.cms__lock_policy() -> 'real' ->> 'ready';                                                             -- false
--   SELECT current_setting('server_version_num')::int >= 140000,
--          (SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database());                 -- t, UTF8
-- V5 thân hàm / định nghĩa / bảng / trigger: `node scripts/cms-verify.mjs --phase=124` (manifest CMS_FN_MATRIX phase 124 sinh từ
--   file migration bằng scripts/gen-cms-verify-fp-124.mjs — không bao giờ từ DB cần kiểm).
