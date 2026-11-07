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
-- @@PREFLIGHT_MD5@@

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
