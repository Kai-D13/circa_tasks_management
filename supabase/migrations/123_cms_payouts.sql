-- ============================================================================
-- 123_cms_payouts.sql  (r0.4 — DRAFT P3a, Dev 03/11/2026; CHƯA audit PM, CHƯA commit, KHÔNG chạy prod)
-- r0.4 (db-reviewer kiểm r0.3: 2 P1 PM đóng; P1 mới cùng lớp): dữ liệu run + dòng run chỉ ghi qua RPC (cms__run_auth_guard, mức câu
--     lệnh, INVOKER) ⇒ non-owner không sửa tiền run đã công bố trước chốt; bỏ ngoại lệ đổi tên của guard cấu hình; preflight kiểm
--     owner mọi hàm CMS + 10 bảng; hậu kiểm đếm trigger chỉ-owner theo bảng; VERIFY V0 owner. 18 hàm mới / 46 trigger.
-- r0.3 (PM NO-GO r0.2, review 2026-11-03-cms-p3a-draft-123-pm.md): P3A-P1-1 guard TRUNCATE bắt buộc READ COMMITTED (snapshot
--     RR lấy trước chốt từng TRUNCATE lọt); P3A-P1-2 cấu hình chỉ ghi qua RPC SECDEF cùng owner (cms__config_auth_guard, INVOKER)
--     ⇒ DML trực tiếp không đổi được tiền bậc / SP / quy cách / target / phạm vi mà run cũ vẫn chốt được; đường 121 luôn tăng
--     config_version ⇒ run cũ CMS_LOCK_STALE_RUN, resync rồi chốt. config_fp chỉ là vân tay kiểm toán SAU chốt, KHÔNG chứng
--     minh run đã tính bằng cấu hình đó. 17 hàm mới / 40 trigger.
-- r0.2 (db-reviewer kiểm lại r0.1: P1 đóng; P2 mới): guard INSERT payout SECURITY INVOKER + chỉ owner bảng (chặn chốt giả của
--     role quản trị); khoá số của policy phải là số nguyên không âm; ghi rõ READ COMMITTED là điều kiện cả cron sync.
-- r0.1 (db-reviewer r0: 2 P1 + P2): ghi dữ liệu run / dòng run bắt buộc READ COMMITTED (CMS_ISOLATION) — snapshot RR không
--     thấy payout vừa commit; 36 trigger ENABLE ALWAYS (session_replication_role = replica không tắt được); chốt đối chiếu
--     lại seal_expect (đếm 4 bảng, khối, Σ tiền dòng); nhánh policy dùng chung QA / thật, thiếu khoá ⇒ pending;
--     lock_timeout RPC chốt 3 s (2 lần chờ ≤ 6 s < statement_timeout 8 s); lý do cắt đủ khoảng trắng; hậu kiểm proconfig /
--     owner / đủ loại quyền bảng payout / định nghĩa trigger; VERIFY có SQL kèm kỳ vọng.
-- Nháp nằm ở planning/research/dev-tools/cms/draft-p3/ (tách manifest writer). Số 123 = số PM dành cho P3a trong STATE; nếu
-- P3a không vào candidate cuối, PM xếp lại số TRƯỚC commit (review 2026-11-03-cms-qa-results-delta-pm.md §5).
-- Chạy SAU 122 (marker 122 = 'cms_results'). So sánh số dạng CASE WHEN version ~ '^[0-9]+$' (luật 118a).
-- Thiết kế: planning/research/cms-i5-p3-blueprint.md r3 (§1–§2, §5) + bổ sung PM §5 (khoá program cha cho DML cấu hình,
-- khoá run theo thứ tự ổn định, Q-206 / Q-213 / Q-216 pending ⇒ chốt thật fail-closed, QA dùng giả định gắn nhãn).
--
-- Mục đích: CHỐT KỲ một chương trình — đóng băng run hiện hành (không sao chép dòng), chép tổng theo dược sĩ + định danh
-- snapshot (≤ số staff), lưu policy + phiên bản, chuyển chương trình 'locked' (H8: không mở lại). Đọc sau chốt theo phạm vi.
--
-- Contract (service_role; server kiểm super + cờ CMS_LOCK_ENABLED trước khi gọi — p_actor theo mẫu 121):
--   rpc_cms_lock_preview(program)                                   → jsonb  CHỈ ĐỌC: run, tổng, staff_rows / staff_paid,
--                                                                     Q-213, policy + version, vân tay mapping run / hiện
--                                                                     tại, nguồn đầy đủ, blockers[], needs_ack
--   rpc_cms_program_lock(program, expected_run, expected_policy_version, actor, ack_reason) → jsonb
--                                                                     MỘT transaction, lock_timeout 3 s; thứ tự khoá chương
--                                                                     trình FOR UPDATE → run FOR UPDATE (cùng 121 / 122);
--                                                                     kiểm theo thứ tự blueprint §2.2 (mã đầu tiên ⇒ RAISE);
--                                                                     chép payout + staff; KIỂM LẠI mapping SAU khi chép +
--                                                                     bất biến tổng 4 nơi; status 'locked'. Gọi lại cùng run ⇒
--                                                                     {already: true}
-- Contract đọc (authenticated, SECDEF):
--   rpc_cms_payout(program)  → jsonb  số chốt theo phạm vi HIỆN TẠI (Q-208): super mọi dòng + program_total + email;
--                                     SM / QLCH staff hiện thuộc phạm vi, CHỈ scope_total, không email; staff chính mình.
--
-- Policy (D4) ở DB: cms__lock_policy() + version. Nhánh 'real' ready = false (Q-206 / Q-213 / Q-216 / hợp đồng nguồn đầy
-- đủ BI / P3b CMS-Q7 chưa chốt) ⇒ chốt chương trình thật luôn bị chặn CMS_LOCK_POLICY_PENDING. Nhánh 'qa' = GIẢ ĐỊNH QA
-- gắn nhãn QA_ONLY_ASSUMPTION (Q-213 theo đề xuất PM 03/11; Q-216 chờ 0 giờ; nguồn đầy đủ 'qa_assumption') — KHÔNG phải mặc
-- định production. Cả hai nhánh đọc cùng khoá (unassigned_max_gmv_bp / unassigned_max_lines / wait_hours / completeness);
-- nhánh thiếu khoá hoặc chưa ready ⇒ CMS_LOCK_POLICY_PENDING. Cơ sở nguồn đầy đủ thật (bi_watermark / lag_commitment) chưa có
-- nơi lưu chứng nhận gắn run ⇒ CMS_LOCK_SOURCE_INCOMPLETE cho tới migration hợp đồng nguồn. Đổi policy = migration CREATE OR
-- REPLACE + version + 1.
--
-- Tập đóng băng (blueprint §1.3) và guard:
--   · dữ liệu run (cms_sync_run_chunks, cms_sales_lines, cms_results, cms_result_catalog, cms_result_lines): trigger MỨC CÂU
--     LỆNH AFTER, tách theo sự kiện (INSERT: NEW TABLE · UPDATE: OLD + NEW TABLE · DELETE: OLD TABLE); tập run_id của OLD và
--     NEW ⇒ khoá cms_sync_runs FOR SHARE theo thứ tự id ⇒ có trong cms_payouts ⇒ CMS_PAYOUT_FROZEN. Người ghi phải ở READ
--     COMMITTED (khác ⇒ CMS_ISOLATION): ở RR / SERIALIZABLE EXISTS đọc snapshot trước chốt và FOR SHARE không gây 40001;
--   · cms_sync_runs: BEFORE UPDATE / DELETE mức dòng — run đã chốt ⇒ CMS_PAYOUT_FROZEN (cùng ràng buộc READ COMMITTED);
--   · cms_payouts / cms_payout_staff: UPDATE / DELETE ⇒ CMS_PAYOUT_IMMUTABLE; INSERT khi chương trình đã 'locked' (khoá
--     FOR SHARE dòng chương trình) ⇒ CMS_PAYOUT_FROZEN; bảng KHÔNG cấp quyền cho service_role (ghi chỉ qua RPC chốt);
--   · cấu hình (cms_program_products / _tiers / _stores): BEFORE INSERT / UPDATE / DELETE mức dòng — khoá FOR SHARE dòng
--     chương trình CHA (UPDATE đổi program_id: khoá cả hai theo thứ tự UUID) rồi đọc trạng thái SAU khoá ⇒ 'locked' ⇒
--     CMS_PROGRAM_LOCKED. RPC chốt giữ FOR UPDATE dòng chương trình tới COMMIT ⇒ DML cấu hình kiểm 'active' trước không thể
--     commit sau chốt (chờ khoá rồi thấy 'locked');
--   · cms_programs: đã 'locked' ⇒ mọi UPDATE đổi dữ liệu / DELETE bị từ chối; chuyển sang 'locked' cần cms_payouts khớp
--     run_id = current_result_run_id; INSERT không mang 'locked';
--   · TRUNCATE: REVOKE TRUNCATE đích danh (PUBLIC / anon / authenticated / service_role) trên 12 bảng + trigger BEFORE
--     TRUNCATE (mức câu lệnh) từ chối khi có bất kỳ cms_payouts;
--   · 46 trigger ENABLE ALWAYS (tiền lệ 115): vẫn chạy khi session_replication_role = replica. Role quản trị (postgres) GIỮ
--     quyền bảng theo default privileges như 120 / 122 — trigger chặn sửa / xoá / TRUNCATE; thu hồi quyền của postgres là quyết
--     định PM riêng (lệch tiền lệ 120). KHÔNG chống owner / superuser cố ý ALTER TABLE … DISABLE TRIGGER / DROP — migration /
--     rollback là đường kiểm soát duy nhất.
--   · cấu hình chỉ qua đường hợp lệ (r0.3): trigger cms_config_auth_guard trên cms_programs + 3 bảng con — non-owner ⇒
--     CMS_CONFIG_RPC_ONLY (không ngoại lệ). 121 luôn tăng config_version ⇒ run tính trước đó thành STALE_RUN;
--   · dữ liệu run + dòng run chỉ qua đường hợp lệ (r0.4): trigger cms_run_auth_guard BEFORE … FOR EACH STATEMENT trên
--     cms_sync_runs + 5 bảng dữ liệu run — non-owner ⇒ CMS_RUN_RPC_ONLY ⇒ số đã seal là số được chốt (owner là ranh giới tin cậy).
-- Ranh giới tin cậy: owner / superuser (chạy migration, thay được DDL) vẫn ghi trực tiếp được — không tuyên bố chống; payout
-- lưu config_fp chỉ để VERIFY phát hiện đổi SAU chốt. DML của owner chạm NHIỀU chương trình khoá cha theo thứ tự dòng — đường
-- hợp lệ (121) chỉ một chương trình; chéo giữa hai câu lệnh trực tiếp ⇒ Postgres phát hiện deadlock, một bên rollback. Đường đọc của staff theo Q-208:
-- staff chuyển sang nhà thuốc NGOÀI chương trình / đổi vai mất quyền xem dòng chi trả của mình (câu hỏi nghiệp vụ, chưa đổi).
-- Embed PostgREST: cms_payouts có FK tới cms_programs và (run_id, program_id) tới cms_sync_runs ⇒ embed giữa cms_programs ↔
-- cms_sync_runs PHẢI ghi rõ FK (!cms_sync_runs_program_id_fkey / !cms_programs_result_run_fk) — app hiện chưa embed cặp này.
-- VẬN HÀNH: migration giữ SHARE ROW EXCLUSIVE (CREATE TRIGGER) trên 12 bảng tới COMMIT ⇒ chạy khi cờ CMS tắt, cron
-- sync-cms-sales / cleanup không chạy. Chốt QA (is_test) trên prod là VĨNH VIỄN: chương trình QA locked vẫn được cms__conflicts
-- (121) tính ⇒ giữ chỗ ProductID + khoảng ngày trong namespace QA mãi mãi — runbook phải ghi rõ trước khi QA chốt.
--
-- Bảng mới (RLS bật, KHÔNG policy, KHÔNG cấp service_role): cms_payouts, cms_payout_staff.
-- Đổi hàm cũ: cms_readable_program_ids() (120) — SM thấy chương trình 'locked' (blueprint §2.4); giữ ACL.
-- ACL: 2 rpc ghi → service_role; 1 rpc đọc → authenticated; 15 helper cms__* (gồm 11 hàm trigger) không cấp ai. Hàm mới
-- SECURITY DEFINER (trigger cần đọc cms_payouts mà service_role không có quyền), TRỪ 3 hàm SECURITY INVOKER có chủ đích kiểm
-- current_user = OWNER bảng: cms__payout_insert_guard (CMS_PAYOUT_RPC_ONLY), cms__config_auth_guard (CMS_CONFIG_RPC_ONLY),
-- cms__run_auth_guard (CMS_RUN_RPC_ONLY). Trigger chỉ chứng minh người ghi là owner, KHÔNG chứng minh lời gọi đi qua RPC —
-- owner là ranh giới tin cậy. Quyền bảng của postgres giữ theo tiền lệ 120 / 122 (PM 03/11). Tổng 18 hàm mới; tổng hàm CMS 55.
-- ĐIỀU KIỆN VẬN HÀNH: mọi câu ghi khác rỗng vào 5 bảng dữ liệu run và mọi UPDATE / DELETE cms_sync_runs (gồm stage / seal /
-- cleanup 122, run 'products' 120) phải ở READ COMMITTED (mặc định PostgREST) — VERIFY V7 là tiền điều kiện của cả cron sync.
-- KHÔNG chạy lại (preflight dừng nếu đã có 123). ROLLBACK: rollback/123_cms_payouts_rollback.sql (chỉ khi KHÔNG có chương
-- trình thật 'locked'; chương trình QA đã chốt GIỮ 'locked', payout QA bị xoá — H8).
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_name text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '123: cần READ COMMITTED';
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '122';
  IF v_name IS DISTINCT FROM 'cms_results' THEN
    RAISE EXCEPTION '123: thiếu migration nền 122 cms_results (name = %)', v_name;
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '123';
  IF FOUND THEN
    RAISE EXCEPTION '123: đã có marker 123 (name = %) — không chạy lại / không chạy chồng', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 123) THEN
    RAISE EXCEPTION '123: DB đã có migration số > 123 — dừng';
  END IF;
  IF to_regclass('public.cms_payouts') IS NOT NULL OR to_regclass('public.cms_payout_staff') IS NOT NULL THEN
    RAISE EXCEPTION '123: đã có bảng payout CMS mà không có marker 123 — kiểm tra tay';
  END IF;
  IF to_regprocedure('public.cms__mapping_fp()') IS NULL OR to_regprocedure('public.cms__results_release_open()') IS NULL
     OR to_regprocedure('public.cms__visible_result_users()') IS NULL OR to_regprocedure('public.cms__vn_today()') IS NULL
     OR to_regprocedure('public.is_super_admin()') IS NULL THEN
    RAISE EXCEPTION '123: thiếu hàm nền 121 / 122';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION '123: role chạy migration (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = 'public.cms__mapping_fp()'::regprocedure
                  AND p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '123: role chạy (%) không phải owner các hàm 122 — chạy bằng cùng role owner', current_user;
  END IF;
  -- Guard chỉ-owner (cms__config_auth_guard / cms__payout_insert_guard) dựa vào: owner bảng = owner RPC SECDEF 121 / 122 / 123.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_programs'::regclass, 'public.cms_program_products'::regclass, 'public.cms_program_tiers'::regclass,
                              'public.cms_program_stores'::regclass, 'public.cms_sync_runs'::regclass, 'public.cms_sync_run_chunks'::regclass,
                              'public.cms_sales_lines'::regclass, 'public.cms_results'::regclass, 'public.cms_result_catalog'::regclass,
                              'public.cms_result_lines'::regclass)
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace
                   AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '123: owner bảng cấu hình / run hoặc hàm CMS 120–122 khác role chạy (%) — guard chỉ-owner sẽ chặn đường hợp lệ', current_user;
  END IF;
  -- Bất biến mới 'locked' ⇒ có payout: chương trình THẬT đã 'locked' từ trước (không qua RPC chốt) ⇒ dừng, không tự sửa.
  -- Chương trình QA 'locked' không payout chỉ có thể là dấu vết QA sau rollback 123 (H8 giữ 'locked') ⇒ cho chạy lại; đọc payout
  -- của chúng trả CMS_PAYOUT_NOT_LOCKED, preview / chốt trả CMS_PROGRAM_LOCKED.
  IF EXISTS (SELECT 1 FROM public.cms_programs WHERE status = 'locked' AND NOT is_test) THEN
    RAISE EXCEPTION '123: đã có chương trình thật locked không có payout — kiểm tra tay';
  END IF;
END $$;

-- ── 1. Bảng payout ──────────────────────────────────────────────────────────
-- 1 dòng / chương trình đã chốt; PK ⇒ chốt một lần, không mở lại (H8). Tham chiếu run đóng băng (không sao chép dòng).
CREATE TABLE public.cms_payouts (
  program_id             uuid        PRIMARY KEY REFERENCES public.cms_programs(id),
  run_id                 uuid        NOT NULL,
  config_version         integer     NOT NULL CHECK (config_version >= 1),
  config_fp              text        NOT NULL CHECK (config_fp ~ '^[0-9a-f]{32}$'),
  mapping_fp             text        NOT NULL CHECK (mapping_fp ~ '^[0-9a-f]{32}$'),
  is_test                boolean     NOT NULL,
  amount_vnd             bigint      NOT NULL CHECK (amount_vnd >= 0),
  staff_rows             integer     NOT NULL CHECK (staff_rows >= 0),
  staff_paid             integer     NOT NULL CHECK (staff_paid >= 0 AND staff_paid <= staff_rows),
  candidate_lines        integer     NOT NULL CHECK (candidate_lines >= 0),
  candidate_gmv          numeric     NOT NULL CHECK (candidate_gmv >= 0),
  unassigned_lines       integer     NOT NULL CHECK (unassigned_lines >= 0 AND unassigned_lines <= candidate_lines),
  unassigned_gmv         numeric     NOT NULL CHECK (unassigned_gmv >= 0 AND unassigned_gmv <= candidate_gmv),
  policy                 jsonb       NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  policy_version         integer     NOT NULL CHECK (policy_version >= 1),
  ack_reason             text        CHECK (ack_reason IS NULL OR (char_length(btrim(ack_reason, E' \t\r\n\f\v')) BETWEEN 10 AND 1000
                                                                         AND ack_reason = btrim(ack_reason, E' \t\r\n\f\v'))),
  run_started_at         timestamptz NOT NULL,
  source_complete_basis  text        NOT NULL CHECK (source_complete_basis IN ('qa_assumption', 'bi_watermark', 'lag_commitment')),
  source_complete_through date,
  locked_by              uuid        NOT NULL,
  locked_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cms_payouts_run_uniq UNIQUE (run_id),
  CONSTRAINT cms_payouts_run_fk FOREIGN KEY (run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id),
  -- Giả định QA chỉ dùng cho chương trình QA; chứng nhận thật phải có ngày đầy đủ.
  CONSTRAINT cms_payouts_qa_basis CHECK (is_test OR source_complete_basis <> 'qa_assumption'),
  CONSTRAINT cms_payouts_complete CHECK (source_complete_basis = 'qa_assumption' OR source_complete_through IS NOT NULL),
  -- Q-213 d / e: còn dòng chưa gán (dưới ngưỡng) ⇔ có lý do xác nhận; 0 dòng ⇒ không lưu lý do.
  CONSTRAINT cms_payouts_ack CHECK ((unassigned_lines = 0) = (ack_reason IS NULL))
);

-- Định danh + tổng snapshot lúc chốt: MỌI user có trong cms_results của run (gồm 0 đ).
CREATE TABLE public.cms_payout_staff (
  program_id          uuid    NOT NULL REFERENCES public.cms_payouts(program_id),
  user_id             uuid    NOT NULL,
  store_id            uuid    NOT NULL,
  email_snapshot      text    CHECK (email_snapshot IS NULL OR char_length(email_snapshot) <= 320),
  name_snapshot       text    CHECK (name_snapshot IS NULL OR char_length(name_snapshot) <= 500),
  store_name_snapshot text    CHECK (store_name_snapshot IS NULL OR char_length(store_name_snapshot) <= 500),
  amount_vnd          bigint  NOT NULL CHECK (amount_vnd >= 0),
  products_with_cms   integer NOT NULL CHECK (products_with_cms >= 0),
  PRIMARY KEY (program_id, user_id)
);

ALTER TABLE public.cms_payouts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_payout_staff ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cms_payouts, public.cms_payout_staff FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. Helper nội bộ (không cấp ai) ─────────────────────────────────────────
-- Policy chốt (D4). Một nguồn duy nhất cho preview + chốt; client không tự chọn ngưỡng.
CREATE FUNCTION public.cms__lock_policy()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'version', 1,
    'real', jsonb_build_object(
      'ready', false,
      'pending', jsonb_build_array('Q-206', 'Q-213', 'Q-216', 'BI_COMPLETENESS_CONTRACT', 'P3B_CMS_Q7')),
    'qa', jsonb_build_object(
      'label', 'QA_ONLY_ASSUMPTION',
      'note', 'Giả định QA, KHÔNG phải mặc định production: Q-213 theo đề xuất PM 03/11 (2 % GMV hoặc 20 dòng, bằng ngưỡng chưa vượt); Q-216 chờ 0 giờ; nguồn đầy đủ = qa_assumption',
      'unassigned_max_gmv_bp', 200,
      'unassigned_max_lines', 20,
      'wait_hours', 0,
      'completeness', 'qa_assumption'))
$$;

-- Vân tay cấu hình giải thích số (không gồm status / mốc thời gian): chương trình + SP + bậc + nhà thuốc. ROW()::text phân biệt
-- NULL với chuỗi rỗng.
CREATE FUNCTION public.cms__config_fp(p_program_id uuid)
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
                FROM public.cms_program_stores s WHERE s.program_id = p_program_id), ''))
$$;

-- Đánh giá chốt (dùng chung preview + RPC chốt; RPC chốt gọi SAU khi đã khoá chương trình + run). Trả số liệu + blockers[]
-- theo thứ tự blueprint §2.2; ACK chỉ thành blocker khi p_require_ack (RPC chốt).
CREATE FUNCTION public.cms__lock_eval(p_program_id uuid, p_expected_run_id uuid, p_expected_policy_version integer,
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
    IF v_basis IS NULL OR v_basis <> 'qa_assumption' OR NOT v_prog.is_test THEN
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
    'earliest_lock_at', public.cms__ts(v_earliest),
    'blockers', to_jsonb(v_b));
END;
$$;

-- Khoá các run theo thứ tự id ổn định (FOR SHARE) rồi từ chối nếu có run đã chốt. Gọi từ trigger dữ liệu run.
CREATE FUNCTION public.cms__frozen_runs_guard(p_runs uuid[])
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_runs IS NULL OR cardinality(p_runs) = 0 THEN
    RETURN;
  END IF;
  -- db-reviewer P1-1: ở REPEATABLE READ / SERIALIZABLE, EXISTS bên dưới đọc theo snapshot CŨ (trước khi chốt commit) và
  -- FOR SHARE không gây 40001 (chốt chỉ khoá dòng run, không UPDATE) ⇒ ghi lọt. Ghi dữ liệu run bắt buộc READ COMMITTED.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  PERFORM 1 FROM (SELECT r.id FROM public.cms_sync_runs r WHERE r.id = ANY (p_runs) ORDER BY r.id FOR SHARE) x;
  IF EXISTS (SELECT 1 FROM public.cms_payouts p WHERE p.run_id = ANY (p_runs)) THEN
    RAISE EXCEPTION 'CMS_PAYOUT_FROZEN' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- ── 3. Hàm trigger ──────────────────────────────────────────────────────────
-- Dữ liệu run — mức câu lệnh, tách theo sự kiện (transition table cms_old / cms_new).
CREATE FUNCTION public.cms__frozen_data_ins()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.cms__frozen_runs_guard(ARRAY(SELECT DISTINCT n.run_id FROM cms_new n));
  RETURN NULL;
END;
$$;
CREATE FUNCTION public.cms__frozen_data_upd()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.cms__frozen_runs_guard(ARRAY(SELECT o.run_id FROM cms_old o UNION SELECT n.run_id FROM cms_new n));
  RETURN NULL;
END;
$$;
CREATE FUNCTION public.cms__frozen_data_del()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.cms__frozen_runs_guard(ARRAY(SELECT DISTINCT o.run_id FROM cms_old o));
  RETURN NULL;
END;
$$;

-- Dòng run đã chốt: không UPDATE / DELETE.
CREATE FUNCTION public.cms__frozen_run_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Như cms__frozen_runs_guard (db-reviewer P1-1): snapshot RR / SERIALIZABLE không thấy payout vừa commit.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_payouts p WHERE p.run_id = OLD.id) THEN
    RAISE EXCEPTION 'CMS_PAYOUT_FROZEN' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF EXISTS (SELECT 1 FROM public.cms_payouts p WHERE p.run_id = NEW.id) THEN
      RAISE EXCEPTION 'CMS_PAYOUT_FROZEN' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;

-- Payout bất biến.
CREATE FUNCTION public.cms__payout_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'CMS_PAYOUT_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$;

-- Ghi payout CHỈ từ RPC chốt + chỉ trước khi chương trình 'locked'; sau COMMIT không nối thêm được.
-- SECURITY INVOKER CÓ CHỦ ĐÍCH (db-reviewer r0.1 finding 1): current_user phải là OWNER bảng — trong rpc_cms_program_lock
-- (SECDEF, cùng owner) current_user = owner; role quản trị (postgres: BYPASSRLS + INSERT theo default privileges) chèn trực
-- tiếp ⇒ CMS_PAYOUT_RPC_ONLY, không dựng được "chốt giả" bỏ qua kiểm Q-206 / policy / Q-213 / mapping của RPC. SECDEF thì
-- current_user luôn là owner ⇒ phép kiểm vô tác dụng.
CREATE FUNCTION public.cms__payout_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_status text;
BEGIN
  IF (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID)
     IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'CMS_PAYOUT_RPC_ONLY' USING ERRCODE = '42501';
  END IF;
  SELECT status INTO v_status FROM public.cms_programs WHERE id = NEW.program_id FOR SHARE;
  IF v_status IS NULL OR v_status = 'locked' THEN
    RAISE EXCEPTION 'CMS_PAYOUT_FROZEN' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- Cấu hình (SP / bậc / nhà thuốc): khoá FOR SHARE dòng chương trình CHA theo thứ tự UUID, đọc trạng thái SAU khoá.
CREATE FUNCTION public.cms__config_lock_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a uuid;
  v_b uuid;
  v_s text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_a := NEW.program_id;
  ELSIF TG_OP = 'DELETE' THEN
    v_a := OLD.program_id;
  ELSE
    v_a := LEAST(OLD.program_id, NEW.program_id);
    IF NEW.program_id IS DISTINCT FROM OLD.program_id THEN
      v_b := GREATEST(OLD.program_id, NEW.program_id);
    END IF;
  END IF;
  -- READ COMMITTED: SELECT … FOR SHARE chờ khoá rồi trả bản đã commit MỚI NHẤT ⇒ thấy 'locked' của RPC chốt vừa commit.
  SELECT status INTO v_s FROM public.cms_programs WHERE id = v_a FOR SHARE;
  IF v_s = 'locked' THEN
    RAISE EXCEPTION 'CMS_PROGRAM_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  IF v_b IS NOT NULL THEN
    SELECT status INTO v_s FROM public.cms_programs WHERE id = v_b FOR SHARE;
    IF v_s = 'locked' THEN
      RAISE EXCEPTION 'CMS_PROGRAM_LOCKED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Cấu hình chỉ ghi qua đường hợp lệ (PM P3A-P1-2): current_user phải là OWNER bảng — tức RPC SECDEF cùng owner của 121 (lưu /
-- nhập / kích hoạt — luôn tăng config_version), 122 (pointer) và 123 (chốt). DML trực tiếp của role còn quyền bảng (service_role,
-- postgres theo default privileges) ⇒ CMS_CONFIG_RPC_ONLY: không đổi được tiền bậc / SP / quy cách / target / phạm vi / kỳ /
-- version mà run cũ vẫn đủ điều kiện chốt. Không ngoại lệ (r0.4 bỏ ngoại lệ đổi tên — db-reviewer: vượt luật 121 với chương
-- trình đã bắt đầu, giả updated_by, giữ khoá dòng). SECURITY INVOKER CÓ CHỦ ĐÍCH (SECDEF ⇒ current_user luôn là owner). Owner /
-- superuser là ranh giới tin cậy (thay được DDL) — không tuyên bố chống được.
CREATE FUNCTION public.cms__config_auth_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID)
     IS NOT DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'CMS_CONFIG_RPC_ONLY' USING ERRCODE = '42501';
END;
$$;

-- Dữ liệu run + dòng run chỉ ghi qua đường hợp lệ (db-reviewer r0.3 P1-mới, cùng lớp P3A-P1-2): non-owner sửa tiền trong run
-- ĐÃ CÔNG BỐ trước khi chốt (cms_results / cms_result_lines / cms_sync_runs.amount_vnd nhất quán) thì lệnh chốt chứng nhận số giả.
-- Mức câu lệnh BEFORE trên cms_sync_runs + 5 bảng dữ liệu run: current_user ≠ owner ⇒ CMS_RUN_RPC_ONLY (cả câu lệnh 0 dòng).
-- Đường hợp lệ đều là RPC SECDEF cùng owner: 120 rpc_cms_sync_run_open / _product_master_upsert / _sync_run_close; 122 open /
-- stage / seal_begin / seal_step / publish / finish / cleanup (+ cms__seal_fail); 123 chốt. SECURITY INVOKER CÓ CHỦ ĐÍCH.
CREATE FUNCTION public.cms__run_auth_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID)
     IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'CMS_RUN_RPC_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END;
$$;

-- Chương trình: 'locked' bất biến; chỉ vào 'locked' khi đã có payout khớp run hiện hành.
CREATE FUNCTION public.cms__programs_lock_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'locked' THEN
      RAISE EXCEPTION 'CMS_PROGRAM_LOCK_INVALID' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'locked' THEN
      RAISE EXCEPTION 'CMS_PAYOUT_FROZEN' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'locked' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'CMS_PAYOUT_FROZEN' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'locked' THEN
    IF OLD.status <> 'active' OR NEW.current_result_run_id IS NULL
       OR NEW.current_result_run_id IS DISTINCT FROM OLD.current_result_run_id
       OR NOT EXISTS (SELECT 1 FROM public.cms_payouts p WHERE p.program_id = NEW.id AND p.run_id = NEW.current_result_run_id) THEN
      RAISE EXCEPTION 'CMS_PROGRAM_LOCK_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- TRUNCATE (kể cả lan theo CASCADE): có payout ⇒ từ chối. PM P3A-P1-1: ở REPEATABLE READ / SERIALIZABLE, EXISTS đọc snapshot
-- lấy TRƯỚC khi chốt commit ⇒ không thấy payout ⇒ TRUNCATE lọt ⇒ bắt buộc READ COMMITTED như guard DML (kiểm TRƯỚC EXISTS).
CREATE FUNCTION public.cms__frozen_truncate_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CMS_ISOLATION' USING ERRCODE = '25000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_payouts) THEN
    RAISE EXCEPTION 'CMS_PAYOUT_FROZEN' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- ── 4. Trigger ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cms_sync_run_chunks', 'cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_result_lines'] LOOP
    EXECUTE format('CREATE TRIGGER cms_frozen_ins AFTER INSERT ON public.%I REFERENCING NEW TABLE AS cms_new '
                   'FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_ins()', t);
    EXECUTE format('CREATE TRIGGER cms_frozen_upd AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS cms_old NEW TABLE AS cms_new '
                   'FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_upd()', t);
    EXECUTE format('CREATE TRIGGER cms_frozen_del AFTER DELETE ON public.%I REFERENCING OLD TABLE AS cms_old '
                   'FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_del()', t);
  END LOOP;
  -- Tên 'cms_config_auth_guard' xếp trước 'cms_config_lock_guard' / 'cms_programs_*' (BEFORE ROW chạy theo tên) ⇒ từ chối
  -- non-owner trước khi khoá dòng chương trình.
  FOREACH t IN ARRAY ARRAY['cms_programs', 'cms_program_products', 'cms_program_tiers', 'cms_program_stores'] LOOP
    EXECUTE format('CREATE TRIGGER cms_config_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.cms__config_auth_guard()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['cms_sync_runs', 'cms_sync_run_chunks', 'cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_result_lines'] LOOP
    EXECUTE format('CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['cms_program_products', 'cms_program_tiers', 'cms_program_stores'] LOOP
    EXECUTE format('CREATE TRIGGER cms_config_lock_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.cms__config_lock_guard()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['cms_programs', 'cms_program_products', 'cms_program_tiers', 'cms_program_stores', 'cms_sync_runs',
                           'cms_sync_run_chunks', 'cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_result_lines',
                           'cms_payouts', 'cms_payout_staff'] LOOP
    EXECUTE format('CREATE TRIGGER cms_frozen_truncate BEFORE TRUNCATE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_truncate_guard()', t);
    EXECUTE format('REVOKE TRUNCATE ON public.%I FROM PUBLIC, anon, authenticated, service_role', t);
  END LOOP;
END $$;
CREATE TRIGGER cms_frozen_run_row BEFORE UPDATE OR DELETE ON public.cms_sync_runs
  FOR EACH ROW EXECUTE FUNCTION public.cms__frozen_run_row();
CREATE TRIGGER cms_payout_immutable BEFORE UPDATE OR DELETE ON public.cms_payouts
  FOR EACH ROW EXECUTE FUNCTION public.cms__payout_immutable();
CREATE TRIGGER cms_payout_immutable BEFORE UPDATE OR DELETE ON public.cms_payout_staff
  FOR EACH ROW EXECUTE FUNCTION public.cms__payout_immutable();
CREATE TRIGGER cms_payout_insert_guard BEFORE INSERT ON public.cms_payouts
  FOR EACH ROW EXECUTE FUNCTION public.cms__payout_insert_guard();
CREATE TRIGGER cms_payout_insert_guard BEFORE INSERT ON public.cms_payout_staff
  FOR EACH ROW EXECUTE FUNCTION public.cms__payout_insert_guard();
CREATE TRIGGER cms_programs_lock_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_programs
  FOR EACH ROW EXECUTE FUNCTION public.cms__programs_lock_guard();
-- db-reviewer P1-2 (tiền lệ 115): ENABLE ALWAYS — trigger vẫn chạy khi session_replication_role = replica (role quản trị
-- như postgres giữ quyền bảng theo default privileges). Chỉ owner ALTER TABLE … DISABLE TRIGGER mới tắt được (ngoài phạm vi).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, t.tgname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
       AND t.tgname IN ('cms_frozen_ins', 'cms_frozen_upd', 'cms_frozen_del', 'cms_config_lock_guard', 'cms_config_auth_guard', 'cms_run_auth_guard', 'cms_frozen_truncate',
                        'cms_frozen_run_row', 'cms_payout_immutable', 'cms_payout_insert_guard', 'cms_programs_lock_guard')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', r.relname, r.tgname);
  END LOOP;
END $$;

-- ── 5. RPC ghi / preview (service_role) ─────────────────────────────────────
CREATE FUNCTION public.rpc_cms_lock_preview(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_program_id IS NULL THEN RAISE EXCEPTION 'CMS_LOCK_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  RETURN public.cms__lock_eval(p_program_id, NULL, NULL, NULL, false);
END;
$$;

CREATE FUNCTION public.rpc_cms_program_lock(p_program_id uuid, p_expected_run_id uuid, p_expected_policy_version integer,
                                            p_actor uuid, p_ack_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '3s' AS $$
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
    IF FOUND AND v_pay.run_id = p_expected_run_id THEN
      RETURN jsonb_build_object('locked', true, 'already', true, 'program_id', p_program_id, 'run_id', v_pay.run_id,
                                'amount_vnd', v_pay.amount_vnd::text, 'policy_version', v_pay.policy_version);
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
  v_ack := CASE WHEN (v_ev ->> 'unassigned_lines')::integer > 0 THEN btrim(p_ack_reason, E' \t\r\n\f\v') END;
  -- 10. Payout + staff (định danh từ users / stores — snapshot).
  INSERT INTO public.cms_payouts (program_id, run_id, config_version, config_fp, mapping_fp, is_test, amount_vnd, staff_rows,
    staff_paid, candidate_lines, candidate_gmv, unassigned_lines, unassigned_gmv, policy, policy_version, ack_reason,
    run_started_at, source_complete_basis, source_complete_through, locked_by)
  VALUES (p_program_id, v_run.id, v_run.config_version, public.cms__config_fp(p_program_id), v_run.mapping_fp, v_run.is_test,
    v_run.amount_vnd, (v_ev ->> 'staff_rows')::integer, (v_ev ->> 'staff_paid')::integer, (v_ev ->> 'candidate_lines')::integer,
    (v_ev ->> 'candidate_gmv')::numeric, (v_ev ->> 'unassigned_lines')::integer, (v_ev ->> 'unassigned_gmv')::numeric,
    v_ev -> 'policy', (v_ev ->> 'policy_version')::integer, v_ack, v_run.started_at, v_ev ->> 'source_complete_basis',
    (v_ev ->> 'source_complete_through')::date, p_actor);
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
                            'unassigned_lines', (v_ev ->> 'unassigned_lines')::integer, 'policy_version', (v_ev ->> 'policy_version')::integer);
END;
$$;

-- ── 6. RPC đọc (authenticated; SECDEF; phạm vi hiện tại — blueprint §2.4) ──
CREATE FUNCTION public.rpc_cms_payout(p_program_id uuid)
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
         'run_started_at', public.cms__ts(v_pay.run_started_at)) ELSE '{}'::jsonb END;
END;
$$;

-- ── 7. cms_readable_program_ids: SM thấy cả 'locked' (khác 120 đúng một điều kiện) ──
CREATE OR REPLACE FUNCTION public.cms_readable_program_ids()
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (
    SELECT u.id, u.role, u.store_id,
           public.is_super_admin() AS su,
           public.cms_has_qa_access() AS qa,
           COALESCE(s.store_type = 'os' AND s.is_active, false) AS store_ok
      FROM public.users u
      LEFT JOIN public.stores s ON s.id = u.store_id
     WHERE u.id = auth.uid()
  ), sm_stores AS (
    SELECT a.store_id
      FROM me
      JOIN public.sm_store_assignments a ON a.sm_user_id = me.id
      JOIN public.stores s ON s.id = a.store_id
     WHERE me.role = 'sm' AND s.store_type = 'os' AND s.is_active
  )
  SELECT COALESCE(array_agg(p.id ORDER BY p.id), '{}'::uuid[])
    FROM public.cms_programs p
   CROSS JOIN me
   WHERE (NOT p.is_test OR me.qa)
     AND (
       me.su
       OR (me.role IN ('staff', 'store_manager') AND me.store_ok AND p.status IN ('active', 'locked')
           AND EXISTS (SELECT 1 FROM public.cms_program_stores ps WHERE ps.program_id = p.id AND ps.store_id = me.store_id))
       OR (me.role = 'sm' AND p.status IN ('active', 'locked')
           AND EXISTS (SELECT 1 FROM public.cms_program_stores ps JOIN sm_stores x ON x.store_id = ps.store_id
                        WHERE ps.program_id = p.id))
     )
$$;

-- ── 8. ACL hàm ──────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION
  public.cms__lock_policy(), public.cms__config_fp(uuid), public.cms__lock_eval(uuid, uuid, integer, text, boolean),
  public.cms__frozen_runs_guard(uuid[]), public.cms__frozen_data_ins(), public.cms__frozen_data_upd(),
  public.cms__frozen_data_del(), public.cms__frozen_run_row(), public.cms__payout_immutable(),
  public.cms__payout_insert_guard(), public.cms__config_lock_guard(), public.cms__programs_lock_guard(),
  public.cms__frozen_truncate_guard(), public.cms__config_auth_guard(), public.cms__run_auth_guard(),
  public.rpc_cms_lock_preview(uuid), public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text), public.rpc_cms_payout(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_lock_preview(uuid), public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_payout(uuid) TO authenticated;
-- Thu hồi mọi grant khác owner do default privileges cấp (vd. postgres) — bài học SEC-1 / 090→091 / 117 / 120 / 122.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, x.grantee
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('cms__lock_policy', 'cms__config_fp', 'cms__lock_eval', 'cms__frozen_runs_guard', 'cms__frozen_data_ins',
                         'cms__frozen_data_upd', 'cms__frozen_data_del', 'cms__frozen_run_row', 'cms__payout_immutable',
                         'cms__payout_insert_guard', 'cms__config_lock_guard', 'cms__programs_lock_guard',
                         'cms__frozen_truncate_guard', 'cms__config_auth_guard', 'cms__run_auth_guard', 'rpc_cms_lock_preview', 'rpc_cms_program_lock', 'rpc_cms_payout')
       AND x.grantee <> p.proowner
       AND NOT (p.proname IN ('rpc_cms_lock_preview', 'rpc_cms_program_lock') AND x.grantee = 'service_role'::regrole::oid)
       AND NOT (p.proname = 'rpc_cms_payout' AND x.grantee = 'authenticated'::regrole::oid)
     GROUP BY p.oid, x.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- ── 9. Hậu kiểm trong transaction ──────────────────────────────────────────
DO $$
DECLARE
  v_fns text[] := ARRAY['cms__lock_policy', 'cms__config_fp', 'cms__lock_eval', 'cms__frozen_runs_guard', 'cms__frozen_data_ins',
                        'cms__frozen_data_upd', 'cms__frozen_data_del', 'cms__frozen_run_row', 'cms__payout_immutable',
                        'cms__payout_insert_guard', 'cms__config_lock_guard', 'cms__programs_lock_guard',
                        'cms__frozen_truncate_guard', 'cms__config_auth_guard', 'cms__run_auth_guard', 'rpc_cms_lock_preview', 'rpc_cms_program_lock', 'rpc_cms_payout'];
  v_frozen text[] := ARRAY['cms_programs', 'cms_program_products', 'cms_program_tiers', 'cms_program_stores', 'cms_sync_runs',
                           'cms_sync_run_chunks', 'cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_result_lines',
                           'cms_payouts', 'cms_payout_staff'];
  v_t   text;
  v_exp text;
  r     record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosecdef,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END
                              || ':' || x.privilege_type, ',' ORDER BY 1)
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl,
           p.proacl IS NULL AS acl_default
      FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (v_fns)
  LOOP
    v_exp := CASE WHEN r.proname IN ('rpc_cms_lock_preview', 'rpc_cms_program_lock') THEN 'service_role:EXECUTE'
                  WHEN r.proname = 'rpc_cms_payout' THEN 'authenticated:EXECUTE' END;
    IF r.acl_default OR r.acl IS DISTINCT FROM v_exp OR r.prosecdef = (r.proname IN ('cms__payout_insert_guard', 'cms__config_auth_guard', 'cms__run_auth_guard')) THEN
      RAISE EXCEPTION '123 hậu kiểm: ACL % = % (mặc định = %, secdef = %) sai ma trận', r.proname, r.acl, r.acl_default, r.prosecdef;
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE')
       OR (has_function_privilege('authenticated', r.oid, 'EXECUTE') <> (r.proname = 'rpc_cms_payout'))
       OR (has_function_privilege('service_role', r.oid, 'EXECUTE') <> (r.proname IN ('rpc_cms_lock_preview', 'rpc_cms_program_lock'))) THEN
      RAISE EXCEPTION '123 hậu kiểm: has_function_privilege của % sai', r.proname;
    END IF;
    -- db-reviewer P2-3: search_path cố định; lock_timeout của RPC chốt; owner superuser / BYPASSRLS (như 122).
    IF NOT ('search_path=public' = ANY (COALESCE((SELECT proconfig FROM pg_catalog.pg_proc WHERE oid = r.oid), '{}')))
       OR (r.proname = 'rpc_cms_program_lock'
           AND NOT ('lock_timeout=3s' = ANY (COALESCE((SELECT proconfig FROM pg_catalog.pg_proc WHERE oid = r.oid), '{}'))))
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles ro ON ro.oid = p.proowner
                       WHERE p.oid = r.oid AND (ro.rolsuper OR ro.rolbypassrls)) THEN
      RAISE EXCEPTION '123 hậu kiểm: proconfig / owner của % sai', r.proname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (v_fns)) <> 18 THEN
    RAISE EXCEPTION '123 hậu kiểm: số hàm 123 khác 18 (overload lạ?)';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND (p.proname LIKE 'cms\_%' OR p.proname LIKE 'rpc\_cms\_%')) <> 55 THEN
    RAISE EXCEPTION '123 hậu kiểm: tổng hàm CMS khác 55 (120: 7 · 121: 7 · 122: 23 · 123: 18)';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.cms_readable_program_ids()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cms_readable_program_ids()', 'EXECUTE') THEN
    RAISE EXCEPTION '123 hậu kiểm: ACL cms_readable_program_ids đổi sau CREATE OR REPLACE';
  END IF;
  FOREACH v_t IN ARRAY v_frozen LOOP
    IF has_table_privilege('service_role', format('public.%I', v_t), 'TRUNCATE')
       OR has_table_privilege('authenticated', format('public.%I', v_t), 'TRUNCATE')
       OR has_table_privilege('anon', format('public.%I', v_t), 'TRUNCATE') THEN
      RAISE EXCEPTION '123 hậu kiểm: % còn quyền TRUNCATE cho vai API', v_t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = format('public.%I', v_t)::regclass
                    AND tgname = 'cms_frozen_truncate' AND tgenabled = 'A') THEN
      RAISE EXCEPTION '123 hậu kiểm: thiếu trigger TRUNCATE trên %', v_t;
    END IF;
  END LOOP;
  FOREACH v_t IN ARRAY ARRAY['cms_payouts', 'cms_payout_staff'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = format('public.%I', v_t)::regclass)
       OR EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) ro(n)
                   CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) pr(p)
                   WHERE has_table_privilege(ro.n, format('public.%I', v_t), pr.p)) THEN
      RAISE EXCEPTION '123 hậu kiểm: RLS / quyền bảng % sai (vai API còn quyền)', v_t;
    END IF;
  END LOOP;
  -- Định nghĩa trigger (thời điểm / mức / sự kiện / transition table), không chỉ đếm tên (bài học 122 r2.2 P2-2).
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
       AND NOT CASE t.tgname
         WHEN 'cms_frozen_ins' THEN pg_catalog.pg_get_triggerdef(t.oid) LIKE '%AFTER INSERT ON public.% REFERENCING NEW TABLE AS cms_new FOR EACH STATEMENT EXECUTE FUNCTION %cms__frozen_data_ins()'
         WHEN 'cms_frozen_upd' THEN pg_catalog.pg_get_triggerdef(t.oid) LIKE '%AFTER UPDATE ON public.% REFERENCING OLD TABLE AS cms_old NEW TABLE AS cms_new FOR EACH STATEMENT EXECUTE FUNCTION %cms__frozen_data_upd()'
         WHEN 'cms_frozen_del' THEN pg_catalog.pg_get_triggerdef(t.oid) LIKE '%AFTER DELETE ON public.% REFERENCING OLD TABLE AS cms_old FOR EACH STATEMENT EXECUTE FUNCTION %cms__frozen_data_del()'
         WHEN 'cms_config_lock_guard' THEN pg_catalog.pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR DELETE OR UPDATE ON public.% FOR EACH ROW EXECUTE FUNCTION %cms__config_lock_guard()'
         WHEN 'cms_frozen_truncate' THEN pg_catalog.pg_get_triggerdef(t.oid) LIKE '%BEFORE TRUNCATE ON public.% FOR EACH STATEMENT EXECUTE FUNCTION %cms__frozen_truncate_guard()'
         WHEN 'cms_frozen_run_row' THEN pg_catalog.pg_get_triggerdef(t.oid) LIKE '%BEFORE DELETE OR UPDATE ON public.cms_sync_runs FOR EACH ROW EXECUTE FUNCTION %cms__frozen_run_row()'
         WHEN 'cms_payout_immutable' THEN pg_catalog.pg_get_triggerdef(t.oid) LIKE '%BEFORE DELETE OR UPDATE ON public.cms_payout% FOR EACH ROW EXECUTE FUNCTION %cms__payout_immutable()'
         WHEN 'cms_payout_insert_guard' THEN pg_catalog.pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT ON public.cms_payout% FOR EACH ROW EXECUTE FUNCTION %cms__payout_insert_guard()'
         WHEN 'cms_run_auth_guard' THEN pg_catalog.pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR DELETE OR UPDATE ON public.cms_s% FOR EACH STATEMENT EXECUTE FUNCTION %cms__run_auth_guard()'
           OR pg_catalog.pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR DELETE OR UPDATE ON public.cms_result% FOR EACH STATEMENT EXECUTE FUNCTION %cms__run_auth_guard()'
         WHEN 'cms_config_auth_guard' THEN pg_catalog.pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR DELETE OR UPDATE ON public.cms_program% FOR EACH ROW EXECUTE FUNCTION %cms__config_auth_guard()'
         WHEN 'cms_programs_lock_guard' THEN pg_catalog.pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR DELETE OR UPDATE ON public.cms_programs FOR EACH ROW EXECUTE FUNCTION %cms__programs_lock_guard()'
         ELSE true END
       AND t.tgname IN ('cms_frozen_ins', 'cms_frozen_upd', 'cms_frozen_del', 'cms_config_lock_guard', 'cms_config_auth_guard', 'cms_run_auth_guard', 'cms_frozen_truncate',
                        'cms_frozen_run_row', 'cms_payout_immutable', 'cms_payout_insert_guard', 'cms_programs_lock_guard')) THEN
    RAISE EXCEPTION '123 hậu kiểm: định nghĩa trigger 123 khác thiết kế';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
         AND t.tgname IN ('cms_frozen_ins', 'cms_frozen_upd', 'cms_frozen_del')
         AND c.relname IN ('cms_sync_run_chunks', 'cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_result_lines')) <> 15
     OR (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgname = 'cms_config_lock_guard'
            AND c.relname IN ('cms_program_products', 'cms_program_tiers', 'cms_program_stores')) <> 3
     OR (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgname = 'cms_config_auth_guard'
            AND c.relname IN ('cms_programs', 'cms_program_products', 'cms_program_tiers', 'cms_program_stores')) <> 4
     OR (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgname = 'cms_run_auth_guard'
            AND c.relname IN ('cms_sync_runs', 'cms_sync_run_chunks', 'cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_result_lines')) <> 6 THEN
    RAISE EXCEPTION '123 hậu kiểm: trigger 123 không đúng bảng';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgenabled = 'A'
         AND t.tgname IN ('cms_frozen_ins', 'cms_frozen_upd', 'cms_frozen_del', 'cms_config_lock_guard', 'cms_config_auth_guard', 'cms_run_auth_guard', 'cms_frozen_truncate',
                          'cms_frozen_run_row', 'cms_payout_immutable', 'cms_payout_insert_guard', 'cms_programs_lock_guard')) <> 46 THEN
    RAISE EXCEPTION '123 hậu kiểm: số trigger 123 khác 46 (15 dữ liệu run · 6 chỉ-owner run · 3 khoá cha + 4 chỉ-owner cấu hình · 12 TRUNCATE · 1 run · 4 payout · 1 chương trình)';
  END IF;
  IF (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean THEN
    RAISE EXCEPTION '123 hậu kiểm: policy thật không được ready khi Q-206 / Q-213 / Q-216 còn pending';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('123', 'cms_payouts', 'CMS P3a: chốt kỳ — đóng băng run hiện hành + payout theo dược sĩ (định danh snapshot), policy DB (thật pending ⇒ chặn), guard dữ liệu run / cấu hình / TRUNCATE, đọc theo phạm vi');

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — operator chạy; sẽ thành cms-verify --phase=123 riêng) ─────────────────────────
-- KHÔNG chạy cms-verify phase 120 / 121 / 122 trên DB đã 123 để lấy xanh: 123 bỏ TRUNCATE của service_role trên bảng 120 / 122
-- và thay thân cms_readable_program_ids ⇒ kỳ vọng cũ (service_role=arwdDxt, md5 thân) đỏ là ĐÚNG.
-- V0 owner (TRƯỚC khi xếp lịch, chỉ đọc) — một owner duy nhất = role operator sẽ chạy 123 (guard chỉ-owner dựa vào điều này):
--   SELECT c.relname, pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
--      AND c.relname LIKE 'cms\_%' ORDER BY 1;
--   SELECT p.proname, pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--      AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%') ORDER BY 1;
-- V1 hàm — 55 dòng CMS. 18 hàm 123: prosecdef t, TRỪ cms__payout_insert_guard / cms__config_auth_guard / cms__run_auth_guard f; proconfig ∋ search_path=public; rpc_cms_program_lock ∋ lock_timeout=3s;
--    preview / lock: s t, còn lại f; rpc_cms_payout: u t, còn lại f; cms__* (123): a / u / s / pg f, proacl chỉ owner.
--   SELECT p.oid::regprocedure, pg_get_userbyid(p.proowner) owner, p.prosecdef, p.proconfig, p.proacl::text,
--          has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
--          has_function_privilege('service_role', p.oid, 'EXECUTE') s, has_function_privilege('postgres', p.oid, 'EXECUTE') pg
--     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--      AND (p.proname LIKE 'cms\_%' OR p.proname LIKE 'rpc\_cms\_%') ORDER BY 1;
-- V2 trigger — 46 dòng, tgenabled = 'A'; 15 AFTER … FOR EACH STATEMENT + REFERENCING trên 5 bảng run; 6 BEFORE … FOR EACH
--    STATEMENT cms_run_auth_guard (cms_sync_runs + 5 bảng run); 3 BEFORE ROW khoá cha + 4 BEFORE ROW cms_config_auth_guard;
--    12 BEFORE TRUNCATE; cms_frozen_run_row; 2 + 2 payout; cms_programs_lock_guard.
--   SELECT c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid)
--     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
--    WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
--      AND t.tgname IN ('cms_frozen_ins','cms_frozen_upd','cms_frozen_del','cms_config_lock_guard','cms_config_auth_guard','cms_run_auth_guard','cms_frozen_truncate',
--                       'cms_frozen_run_row','cms_payout_immutable','cms_payout_insert_guard','cms_programs_lock_guard')
--    ORDER BY 1, 2;
-- V3 bảng — 2 bảng payout: RLS t, relacl không có anon / authenticated / service_role; 12 bảng tập đóng băng: s_tr f.
--   SELECT c.relname, c.relrowsecurity, c.relacl::text,
--          has_table_privilege('service_role', c.oid, 'TRUNCATE') s_tr, has_table_privilege('postgres', c.oid, 'TRUNCATE') pg_tr
--     FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'cms\_%' ORDER BY 1;
-- V4 policy + cổng — false | 1 | false.
--   SELECT public.cms__lock_policy() -> 'real' ->> 'ready', public.cms__lock_policy() ->> 'version', public.cms__results_release_open();
-- V5 bất biến sau mỗi lần chốt (kể cả QA) — pay = run_amt = staff_sum = res_sum; n_staff = staff_rows; cfg_unchanged t;
--    ptr_ok t; status locked.
--   SELECT p.program_id, p.amount_vnd pay, r.amount_vnd run_amt,
--          (SELECT sum(s.amount_vnd) FROM public.cms_payout_staff s WHERE s.program_id = p.program_id) staff_sum,
--          (SELECT sum(x.amount_vnd) FROM public.cms_results x WHERE x.run_id = p.run_id) res_sum,
--          p.staff_rows, (SELECT count(*) FROM public.cms_payout_staff s WHERE s.program_id = p.program_id) n_staff,
--          p.config_fp = public.cms__config_fp(p.program_id) cfg_unchanged, g.status, g.current_result_run_id = p.run_id ptr_ok
--     FROM public.cms_payouts p JOIN public.cms_sync_runs r ON r.id = p.run_id JOIN public.cms_programs g ON g.id = p.program_id;
-- V6 locked không payout — chỉ is_test (dấu vết rollback H8); 0 dòng NOT is_test.
--   SELECT g.id, g.is_test FROM public.cms_programs g
--    WHERE g.status = 'locked' AND NOT EXISTS (SELECT 1 FROM public.cms_payouts p WHERE p.program_id = g.id);
-- V7 READ COMMITTED (TIỀN ĐIỀU KIỆN mọi đường ghi dữ liệu run / dòng run / TRUNCATE — gồm cron sync 122; kiểm TRƯỚC bật cờ):
--    kỳ vọng dòng 1 = 'read committed'; truy vấn 2 trả 0 dòng (không vai API / DB nào đặt default_transaction_isolation khác).
--   SELECT current_setting('default_transaction_isolation');
--   SELECT coalesce(r.rolname, '(mọi vai)') vai, d.datname, s.setconfig FROM pg_db_role_setting s
--     LEFT JOIN pg_roles r ON r.oid = s.setrole LEFT JOIN pg_database d ON d.oid = s.setdatabase
--    WHERE EXISTS (SELECT 1 FROM unnest(s.setconfig) c WHERE c ILIKE 'default_transaction_isolation=%' AND c NOT ILIKE '%read committed%')
--      AND (r.rolname IS NULL OR r.rolname IN ('authenticator', 'service_role', 'authenticated', 'anon', 'postgres', current_user));
--   Không tự đổi cấu hình isolation trên prod (PM 03/11); lệch ⇒ dừng, báo PM.
-- V8 hành vi (service_role, chỉ đọc) — rpc_cms_lock_preview(<chương trình thật bất kỳ>) ⇒ blockers chứa CMS_LOCK_RELEASE_GATE
--    (hoặc CMS_LOCK_POLICY_PENDING khi cổng Q-206 đã mở) — không có đường chốt thật.
