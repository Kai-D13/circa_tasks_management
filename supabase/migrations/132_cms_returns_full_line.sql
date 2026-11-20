-- ============================================================================
-- 132_cms_returns_full_line.sql  (CANDIDATE r2 — Q-236 trả đủ lượng dòng tham chiếu, GMV theo tiền hoàn; Q-237 chốt run contract;
-- Q-238 chứng nhận nguồn có version cho CẢ HAI cách tính; Dev 18–19/11/2026; CHƯA commit, KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-132.mjs từ webapp/scripts/cms-132/132.template.sql + thân hàm 130 vá theo neo (mỗi neo đúng một lần).
-- KHÔNG sửa tay — `node scripts/gen-cms-132.mjs --check` phát hiện lệch.
-- Số 132 = số PM dành trong khối Hiện trạng sống STATE (18/11); nền 131 cms_program_revision. Nguồn: planning/research/
-- cms-returns-full-line-CONTRACT-2026-11-18.md (Q-236), cms-returns-full-line-SPEC-2026-11-18.md, design Dev r1
-- cms-returns-q236-design-r1-2026-11-18.md. KHÔNG sửa 130 / 131; KHÔNG đổi nghĩa net_returns_v1 / sales_only_v1.
--
-- Nội dung (schema-only — không đổi policy / config / pointer / tiền của chương trình nào):
--   P1. Profile mới full_line_qty_refund_v1: chương trình (CHECK + chuyển một chiều sales_only_v1 → net / full_line), run (bộ version cố
--       định theo policy: full_line ⇔ cms-calc-ret2-v2 + cms-return-status-v2; còn lại giữ v1), phiếu trả của run (cột returns_policy +
--       FK tới run, hình dạng theo policy: full_line KHÔNG có lượng BI / người / POS / B / G / q·u gốc), sự kiện RETURN cho phép
--       base_delta = 0 (phiếu sau của cùng dòng), baseline sổ fp v2 (không lượng), báo cáo sau chốt có profile.
--   P2. Hàm mới: cms__return_status_effect_v (từ điển v1 / v2), cms__report_rows2 (phân tích + hash phiếu báo cáo theo từ điển).
--   P3. Thay 24 hàm có sẵn (thân vá neo, md5 nền ghim; nền 130, riêng rpc_cms_program_lock / rpc_cms_payout nền 124 vì 125–131
--       không thay; cộng các hàm MỚI ở P2 / P6 = đúng danh sách ACL ở VERIFY V2): seal N2 / N3 / N10 dẫn xuất ĐỘC LẬP lượng = B_i một lần (phiếu đầu theo
--       recorded_at µs rồi byte ID), đủ điều kiện = E_i, GMV = Σ refund từng phiếu; open chọn hợp đồng theo policy + giữ worker cũ
--       (CMS_WORKER_UNSUPPORTED); publish / báo cáo sau chốt dùng fp v2 + chặn sổ trộn version; capability thêm đường full_line (giữ
--       nguyên khoá / danh sách RPC cũ cho app cũ).
--   r1 (PM 18/11 audit r0 → Q-237 "trừ trả hàng trong kỳ + hoàn thiện chốt run contract"):
--   P4. Chốt run contract: cms__lock_eval nhận cms-calc-ret2-v1 / v2 (kiểm seal 5–6 phần + Σ sự kiện = tổng run, snapshot trả sau mốc
--       sớm nhất, sổ sạch); rpc_cms_program_lock ghi hợp đồng của run vào cms_payouts (cột mới, NULL ⇔ legacy) — payout = số RÒNG đã
--       seal; rpc_cms_payout trả khối hợp đồng + tổng trả đã trừ (super); cms__attest_eval nhận chứng nhận nguồn decision10 cho run contract
--       v1 / v2 (lớp nguồn 14 trường 124 như run legacy — chương trình thật có basis operator_reconciliation khi policy cho). Không đổi
--       chính sách chốt thật (real.ready vẫn do PM).
--   P5. Báo cáo sau chốt đọc HỢP ĐỒNG ĐÓNG BĂNG: run contract ⇒ tính lại = số gộp đóng băng − MỌI phiếu APPLIED của snapshot (⊇ phiếu đã
--       trừ trước chốt) rồi so số ròng đã chốt (phát lại phiếu cũ ⇒ delta 0, không trừ kép); profile theo lựa chọn ghim (run đọc trả ⇒
--       policy run; legacy / sales-only ⇒ báo cáo đầu tiên của super; cron không tự chọn); SP hiệu lực (SP retire không vào phạm vi);
--       trần 10.000 phiếu / báo cáo cho full_line và mọi run contract (đề xuất Dev sau bench < 8 s — Q-238 PM chốt; v1 legacy giữ 100.000).
--   P6. Lưu báo cáo: lõi owner-only cms__close_report_save; cron = rpc_cms_return_close_report_save (service_role, payload KHÔNG còn
--       khoá actor); ngày 31 = rpc_cms_return_close_report_save_super (authenticated — actor = auth.uid() + is_super_admin(), lý do
--       10–500 ký tự + khoá yêu cầu lưu cùng báo cáo; phát lại cùng khoá ⇒ báo cáo đã lập).
--   r2 (PM 19/11 audit r1 → Q-238 "hoàn thiện cả hai trước phát hành"; design planning/research/cms-returns-r2-unit-attest-design-2026-11-19.md):
--   P7. Chứng nhận nguồn có VERSION theo cách tính: bảng chứng nhận nhận đúng hai bộ (field_set, fp_version, tool_version) — decision10 /
--       cms-rows-fp-v1 / cms-i4-compare-v1 (pos_base + run legacy, nghĩa KHÔNG đổi) và decision_unit14 / cms-rows-fp-v2 / cms-i4-compare-v2
--       (cms_unit: decision10 + chuỗi THÔ quantity_src / uom_src + cờ NUL / OVERSIZE — đúng đầu vào classify / seal N1; *_raw là dẫn xuất
--       cms__src_clean(thô) nên không vào vân tay). Hàm mới owner-only cms__run_unit_fp_text / cms__run_unit_fp / cms__run_unit_check (lớp
--       nguồn có thô, raw = làm sạch(thô), lớp bán trùng thô / cờ, phân loại / E tính lại = khối N1(c) seal 130 NGUYÊN VĂN). Thay
--       rpc_cms_source_attest (bộ phải khớp cách tính của run — lệch ⇒ CMS_ATTEST_BASIS_MISMATCH; vân tay theo bộ), rpc_cms_run_source_export
--       (+ 4 khoá thô / cờ), cms__attest_eval (FIELD_SET_BASIS; bỏ BASIS_UNSUPPORTED r1). Capability thêm đường unit_attest.
-- Cờ app CMS_RETURNS_ENABLED (mặc định OFF) KHÔNG được DB đọc. Không UPDATE dữ liệu sẵn có (ADD COLUMN DEFAULT điền metadata), không
-- DISABLE TRIGGER, không session_replication_role.
--
-- Triển khai (runbook — chỉ khi PM / operator cho): app bridge biết 132 (cờ OFF) TRƯỚC; READ COMMITTED; role owner bảng / hàm CMS; dán
-- NGUYÊN FILE (giữ LF; md5 thân hàm bỏ \r). ROLLBACK: rollback/132_cms_returns_full_line_rollback.sql — DỪNG nếu đã có chương trình /
-- run / baseline / báo cáo full_line; gồm DELETE FROM app_migrations WHERE version = '132'. Sau dữ liệu full_line đầu tiên: sàn rollback
-- = app bridge, KHÔNG gỡ 132, KHÔNG xoá ledger / run (design r1 §8). Chứng nhận decision_unit14 đầu tiên cũng là điểm không quay lui.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
-- Khoá TRƯỚC preflight, cùng chiều RPC (chương trình → run → bảng con).
LOCK TABLE public.cms_programs, public.cms_sync_runs, public.cms_return_lines, public.cms_result_events, public.cms_return_baselines,
           public.cms_return_close_reports, public.cms_return_close_report_lines, public.cms_return_close_report_events,
           public.cms_payouts, public.cms_source_attestations IN ACCESS EXCLUSIVE MODE;

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_name text;
  v_acl  text;
  r      record;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '132: cần READ COMMITTED';
  END IF;
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION '132: cần PostgreSQL ≥ 15, có %', current_setting('server_version');
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '131';
  IF v_name IS DISTINCT FROM 'cms_program_revision' THEN
    RAISE EXCEPTION '132: thiếu migration nền 131 cms_program_revision (name = %)', v_name;
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '132';
  IF FOUND THEN
    RAISE EXCEPTION '132: đã có marker 132 (name = %) — không chạy lại / không chạy chồng', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 131) THEN
    RAISE EXCEPTION '132: DB đã có migration số > 131 — dừng';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r0 WHERE r0.rolname = current_user AND (r0.rolsuper OR r0.rolbypassrls)) THEN
    RAISE EXCEPTION '132: role chạy migration (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname LIKE 'cms\_%'
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '132: owner bảng / hàm CMS khác role chạy (%)', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE status = 'running') THEN
    RAISE EXCEPTION '132: còn run đang chạy (status running) — chờ kết thúc / STALE rồi chạy lại';
  END IF;
  -- Chưa có đối tượng 132 (không chạy chồng sau rollback dở).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE NOT attisdropped AND attnum > 0
              AND ((attrelid = 'public.cms_return_lines'::regclass AND attname = 'returns_policy')
                OR (attrelid = 'public.cms_return_close_reports'::regclass AND attname = 'returns_profile')
                OR (attrelid = 'public.cms_return_close_report_events'::regclass AND attname IN ('returns_profile', 'qty_effect', 'pre_lock'))
                OR (attrelid = 'public.cms_return_close_reports'::regclass AND attname IN ('manual_reason', 'manual_request'))
                OR (attrelid = 'public.cms_return_close_report_lines'::regclass AND attname IN ('frozen_return_base', 'frozen_return_gmv'))
                OR (attrelid = 'public.cms_payouts'::regclass AND attname IN ('calc_contract_version', 'quantity_basis', 'returns_policy',
                                                                              'returns_as_of', 'returns_digest', 'ledger_eval_seq'))))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('cms__return_status_effect_v', 'cms__report_rows2', 'cms__close_report_save', 'rpc_cms_return_close_report_save_super', 'cms__run_unit_fp_text', 'cms__run_unit_fp', 'cms__run_unit_check', 'cms__close_report_scan', 'cms__ledger_drift')) THEN
    RAISE EXCEPTION '132: đã có cột / hàm của 132 — DB không ở trạng thái nền 131';
  END IF;
  -- Ràng buộc nền 130 sẽ thay phải có đúng tên (định nghĩa kiểm ở khối dưới).
  FOR r IN SELECT x.rel, x.con FROM (VALUES ('cms_programs'::text, 'cms_programs_returns_policy_value'::text), ('cms_programs', 'cms_programs_policy_actor'), ('cms_sync_runs', 'cms_sync_runs_contract_shape'), ('cms_sync_runs', 'cms_sync_runs_returns_shape'), ('cms_sync_runs', 'cms_sync_runs_ledger_shape'), ('cms_sync_runs', 'cms_sync_runs_contract_ok'), ('cms_return_lines', 'cms_return_lines_effect'), ('cms_return_lines', 'cms_return_lines_shape'), ('cms_result_events', 'cms_result_events_sign'), ('cms_return_baselines', 'cms_return_baselines_fp_version_check'), ('cms_return_baselines', 'cms_return_baselines_base_quantity_check'), ('cms_return_close_reports', 'cms_return_close_reports_calc_contract_version_check'), ('cms_return_close_reports', 'cms_return_close_reports_fp_version_check'), ('cms_return_close_reports', 'cms_return_close_reports_status_dictionary_version_check'), ('cms_return_close_report_events', 'cms_return_close_report_events_base_check'), ('cms_return_close_report_lines', 'cms_return_close_report_lines_math'), ('cms_source_attestations', 'cms_source_attestations_fp_version_check'), ('cms_source_attestations', 'cms_source_attestations_field_set_check'), ('cms_source_attestations', 'cms_source_attestations_tool_version_check')) AS x(rel, con) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = ('public.' || r.rel)::regclass AND c.conname = r.con) THEN
      RAISE EXCEPTION '132: thiếu ràng buộc nền 130 / 124 %.%', r.rel, r.con;
    END IF;
  END LOOP;
  -- Dữ liệu: mọi chương trình còn ở policy 130; không baseline / báo cáo nào khác version 130.
  IF EXISTS (SELECT 1 FROM public.cms_programs WHERE returns_policy NOT IN ('sales_only_v1', 'net_returns_v1'))
     OR EXISTS (SELECT 1 FROM public.cms_return_baselines WHERE fp_version <> 'cms-return-fp-v1')
     OR EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE calc_contract_version IS NOT NULL AND calc_contract_version <> 'cms-calc-ret2-v1')
     OR EXISTS (SELECT 1 FROM public.cms_source_attestations
                 WHERE (field_set, fp_version, tool_version) IS DISTINCT FROM ('decision10', 'cms-rows-fp-v1', 'cms-i4-compare-v1')) THEN
    RAISE EXCEPTION '132: dữ liệu ngoài hợp đồng 130 — dừng, đối chiếu tay';
  END IF;
  -- ACL nền của hàm sắp thay (OR REPLACE giữ ACL): đúng ma trận 130.
  FOR r IN SELECT m.sig, m.want FROM (VALUES ('cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone)'::text, NULL::text), ('cms__programs_basis_guard()', NULL), ('rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)', 'service_role:EXECUTE'), ('rpc_cms_capabilities()', 'authenticated:EXECUTE,service_role:EXECUTE'), ('cms__stage_contract(uuid,text,integer,jsonb)', NULL), ('cms__seal_begin_contract(uuid,jsonb)', NULL), ('cms__seal_contract_step(uuid,integer)', NULL), ('cms__as_of_floor(uuid)', NULL), ('cms__ledger_eval_guard()', NULL), ('cms__publish_contract(uuid)', NULL), ('rpc_cms_sales_run_open(uuid,jsonb)', 'service_role:EXECUTE'), ('rpc_cms_result_header_v2(uuid)', 'authenticated:EXECUTE'), ('rpc_cms_return_close_reports(uuid)', 'authenticated:EXECUTE'), ('rpc_cms_return_close_report(uuid,integer,integer)', 'authenticated:EXECUTE'), ('rpc_cms_return_close_report_events(uuid,text,integer)', 'authenticated:EXECUTE'), ('cms__run_source_check(uuid)', NULL), ('cms__attest_eval(uuid,uuid)', NULL), ('cms__lock_eval(uuid,uuid,integer,text,boolean)', NULL), ('rpc_cms_program_lock(uuid,uuid,integer,uuid,text,uuid)', 'service_role:EXECUTE'), ('rpc_cms_payout(uuid)', 'authenticated:EXECUTE'), ('rpc_cms_frozen_sales_lines(uuid,integer,integer)', 'service_role:EXECUTE'), ('rpc_cms_return_close_report_save(uuid,uuid,jsonb)', 'service_role:EXECUTE'), ('rpc_cms_source_attest(uuid,uuid,jsonb,uuid)', 'authenticated:EXECUTE'), ('rpc_cms_run_source_export(uuid,uuid,text,integer)', 'authenticated:EXECUTE')) AS m(sig, want) LOOP
    -- db-reviewer 18/11 P2: sắp theo grantee rồi quyền (ORDER BY 1 trong aggregate = sắp theo hằng, không xác định).
    SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ','
                      ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END, a.privilege_type)
      INTO v_acl FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE p.oid = to_regprocedure('public.' || r.sig) AND a.grantee <> p.proowner;
    IF to_regprocedure('public.' || r.sig) IS NULL OR v_acl IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION '132: ACL nền % khác ma trận 130 (có %, cần %)', r.sig, COALESCE(v_acl, '-'), COALESCE(r.want, '-');
    END IF;
  END LOOP;
END $$;
-- Thân 24 hàm sắp thay phải đúng nguyên văn 130 (md5 thân bỏ CR — Studio lưu CRLF).
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone)')) IS DISTINCT FROM 'b25fdd09183dffc64658e9ae704aeadf'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__programs_basis_guard()')) IS DISTINCT FROM '534964b54b91f5b6d00c9c9916c38edb'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)')) IS DISTINCT FROM '76f945a8c051bcfb0ee750bf3dd1f166'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_capabilities()')) IS DISTINCT FROM 'ab71996e89d66ddcd8a2c4b02c1caa5e'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__stage_contract(uuid,text,integer,jsonb)')) IS DISTINCT FROM '93b9788769d20237c3d09a273de8252b'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__seal_begin_contract(uuid,jsonb)')) IS DISTINCT FROM '588b1c83f285facf39a228391576d4c3'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__seal_contract_step(uuid,integer)')) IS DISTINCT FROM '8d750bcc6b45a6926262068d6289cd99'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__as_of_floor(uuid)')) IS DISTINCT FROM '292f9884a3b11216bc5a1ff6c8d4d86f'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__ledger_eval_guard()')) IS DISTINCT FROM 'c6e3fdc2ce57477eb7424aaac198a940'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__publish_contract(uuid)')) IS DISTINCT FROM 'e280ae4939fddda9938b4544b7532a9e'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_open(uuid,jsonb)')) IS DISTINCT FROM 'c9bafba3b88949308c10b4f06732f106'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_header_v2(uuid)')) IS DISTINCT FROM '4ffc602cb0a641432b31f2d6032f1d85'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_reports(uuid)')) IS DISTINCT FROM '15af6feac81da195c56aa5a396ca4e16'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_report(uuid,integer,integer)')) IS DISTINCT FROM 'c2ff20f86cb23d3e91a6a847c3363efe'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_report_events(uuid,text,integer)')) IS DISTINCT FROM '20879fbe6f56c53110e4bc5392a6dfee'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__run_source_check(uuid)')) IS DISTINCT FROM 'cd97ae54dee9e5030bac5c1ded72218f'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__attest_eval(uuid,uuid)')) IS DISTINCT FROM '9a332cd63acf909558e8bccba868af82'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__lock_eval(uuid,uuid,integer,text,boolean)')) IS DISTINCT FROM 'f7fa018ad762a526ff6279a48c427d61'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_program_lock(uuid,uuid,integer,uuid,text,uuid)')) IS DISTINCT FROM 'd6fff19d80bbb98a72bf43d90e6f289f'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_payout(uuid)')) IS DISTINCT FROM '2b96b52d238885e72cfbefd7752cfd91'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_frozen_sales_lines(uuid,integer,integer)')) IS DISTINCT FROM '056b83531da67d3f547c8665d4c02c48'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_report_save(uuid,uuid,jsonb)')) IS DISTINCT FROM '60dd216a8f9f5bd680171601d9377fc0'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_source_attest(uuid,uuid,jsonb,uuid)')) IS DISTINCT FROM '32b51294e2837918377ba37007da38f1'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_run_source_export(uuid,uuid,text,integer)')) IS DISTINCT FROM '8f1d48eaf1b532490cfc3582a6312d18' THEN
    RAISE EXCEPTION '132 preflight: thân một trong 24 hàm sắp thay KHÁC bản 130 đã duyệt (md5) — dừng, đối chiếu tay';
  END IF;
END $$;

-- ── P0. Hàm từ điển (tạo TRƯỚC schema: CHECK cms_return_lines_effect tham chiếu) ──
-- Từ điển trạng thái có version (so CHÍNH XÁC chuỗi thô). v1 = cms__return_status_effect 130 (COMPLETED / APPROVED); v2 (Q-236 SPEC §1):
-- COMPLETED hiệu lực; APPROVED / CANCELED / PENDING / REJECTED / WAITING_APPROVAL chưa / không hiệu lực; lạ / version lạ ⇒ NULL (stage
-- từ chối, CHECK bảng chặn). Cùng lib/cms/calc/returns.ts (CMS_RETURN_STATUS_DICTIONARY / _V2).
CREATE FUNCTION public.cms__return_status_effect_v(p_dict text, p_status text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE p_dict
    WHEN 'cms-return-status-v1' THEN CASE p_status WHEN 'COMPLETED' THEN 'EFFECTIVE' WHEN 'APPROVED' THEN 'NOT_EFFECTIVE' END
    WHEN 'cms-return-status-v2' THEN CASE p_status WHEN 'COMPLETED' THEN 'EFFECTIVE'
                                                   WHEN 'APPROVED' THEN 'NOT_EFFECTIVE' WHEN 'CANCELED' THEN 'NOT_EFFECTIVE'
                                                   WHEN 'PENDING' THEN 'NOT_EFFECTIVE' WHEN 'REJECTED' THEN 'NOT_EFFECTIVE'
                                                   WHEN 'WAITING_APPROVAL' THEN 'NOT_EFFECTIVE' END
  END
$$;

-- ── P1. Schema ──────────────────────────────────────────────────────────────
-- Chương trình: thêm profile; actor bắt buộc với mọi policy khác sales-only (chuyển qua RPC có người bật).
ALTER TABLE public.cms_programs
  DROP CONSTRAINT cms_programs_returns_policy_value,
  DROP CONSTRAINT cms_programs_policy_actor;
ALTER TABLE public.cms_programs
  ADD CONSTRAINT cms_programs_returns_policy_value
    CHECK (returns_policy IN ('sales_only_v1', 'net_returns_v1', 'full_line_qty_refund_v1')),
  ADD CONSTRAINT cms_programs_policy_actor CHECK (
    (returns_policy <> 'sales_only_v1') = (returns_policy_set_by IS NOT NULL)
    AND (returns_policy_set_by IS NULL) = (returns_policy_set_at IS NULL));

-- Run: bộ version cố định theo policy. Mọi vế boolean KHÔNG NULL (so sánh có thể NULL bọc COALESCE / IS DISTINCT FROM).
ALTER TABLE public.cms_sync_runs
  DROP CONSTRAINT cms_sync_runs_contract_shape,
  DROP CONSTRAINT cms_sync_runs_returns_shape,
  DROP CONSTRAINT cms_sync_runs_ledger_shape,
  DROP CONSTRAINT cms_sync_runs_contract_ok;
ALTER TABLE public.cms_sync_runs
  ADD CONSTRAINT cms_sync_runs_contract_shape CHECK (
    (quantity_basis IS NULL AND quantity_policy_version IS NULL AND returns_policy IS NULL AND calc_contract_version IS NULL
       AND unit_key_version IS NULL AND status_dictionary_version IS NULL)
    OR (kind = 'sales' AND quantity_basis IS NOT NULL AND quantity_policy_version IS NOT NULL AND returns_policy IS NOT NULL
        AND calc_contract_version IS NOT NULL AND unit_key_version IS NOT NULL AND status_dictionary_version IS NOT NULL
        AND ((quantity_basis = 'pos_base' AND quantity_policy_version = 'pos_base_v1')
             OR (quantity_basis = 'cms_unit' AND quantity_policy_version = 'cms_unit_v2'))
        AND returns_policy IN ('sales_only_v1', 'net_returns_v1', 'full_line_qty_refund_v1')
        AND (quantity_basis = 'cms_unit' OR returns_policy <> 'sales_only_v1')
        AND unit_key_version = 'cms-unit-key-v2'
        AND ((returns_policy = 'full_line_qty_refund_v1' AND calc_contract_version = 'cms-calc-ret2-v2'
              AND status_dictionary_version = 'cms-return-status-v2')
             OR (returns_policy <> 'full_line_qty_refund_v1' AND calc_contract_version = 'cms-calc-ret2-v1'
                 AND status_dictionary_version = 'cms-return-status-v1')))),
  ADD CONSTRAINT cms_sync_runs_returns_shape CHECK (
    (COALESCE(returns_policy, 'sales_only_v1') = 'sales_only_v1' AND returns_as_of IS NULL AND returns_digest IS NULL
       AND returns_rows_read IS NULL)
    OR (COALESCE(returns_policy, 'sales_only_v1') <> 'sales_only_v1'
        AND (sealed_at IS NULL) = (returns_as_of IS NULL) AND (sealed_at IS NULL) = (returns_digest IS NULL)
        AND (sealed_at IS NULL) = (returns_rows_read IS NULL))),
  ADD CONSTRAINT cms_sync_runs_ledger_shape CHECK (
    (ledger_verdict IS NULL) = (ledger_set_hash IS NULL) AND (ledger_verdict IS NULL) = (ledger_checked_at IS NULL)
    AND (ledger_verdict IS NULL OR calc_contract_version IS NOT NULL)
    AND (ledger_eval_seq IS NULL OR (ledger_verdict IS NOT NULL AND COALESCE(returns_policy, 'sales_only_v1') <> 'sales_only_v1'))),
  ADD CONSTRAINT cms_sync_runs_contract_ok CHECK (
    calc_contract_version IS NULL OR status IS DISTINCT FROM 'ok'
    OR (ledger_verdict IS NOT DISTINCT FROM 'CLEAN' AND ledger_set_hash IS NOT NULL AND ledger_checked_at IS NOT NULL
        AND (COALESCE(returns_policy, 'sales_only_v1') = 'sales_only_v1' OR ledger_eval_seq IS NOT NULL))),
  -- Đích FK của phiếu trả (policy run ⇒ hình dạng phiếu).
  ADD CONSTRAINT cms_sync_runs_policy_bind UNIQUE (id, returns_policy);

-- Phiếu trả của run: policy (= policy run, FK) quyết định từ điển và hình dạng. Backfill DEFAULT (metadata) = net_returns_v1 — run trả
-- duy nhất trước 132.
ALTER TABLE public.cms_return_lines ADD COLUMN returns_policy text NOT NULL DEFAULT 'net_returns_v1';
ALTER TABLE public.cms_return_lines ALTER COLUMN returns_policy DROP DEFAULT;
ALTER TABLE public.cms_return_lines
  DROP CONSTRAINT cms_return_lines_effect,
  DROP CONSTRAINT cms_return_lines_shape;
ALTER TABLE public.cms_return_lines
  ADD CONSTRAINT cms_return_lines_policy CHECK (returns_policy IN ('net_returns_v1', 'full_line_qty_refund_v1')),
  ADD CONSTRAINT cms_return_lines_policy_fk FOREIGN KEY (run_id, returns_policy) REFERENCES public.cms_sync_runs (id, returns_policy),
  ADD CONSTRAINT cms_return_lines_effect CHECK (status_effect IS NOT DISTINCT FROM public.cms__return_status_effect_v(
    CASE returns_policy WHEN 'full_line_qty_refund_v1' THEN 'cms-return-status-v2' ELSE 'cms-return-status-v1' END, return_status)),
  ADD CONSTRAINT cms_return_lines_shape CHECK (
    (status_effect = 'NOT_EFFECTIVE' AND disposition = 'NOT_COMPLETED' AND sale_ref_line_id IS NULL
       AND return_document_id IS NULL AND return_code IS NULL AND recorded_at IS NULL AND original_order_line_id IS NULL
       AND original_order_id IS NULL AND product_id IS NULL AND return_base_quantity IS NULL AND return_gmv_amount IS NULL
       AND original_completed_at IS NULL AND original_order_type IS NULL AND original_order_status IS NULL
       AND original_seller_email IS NULL AND original_pos_code IS NULL AND original_base_quantity IS NULL
       AND original_gmv_amount IS NULL AND original_quantity_src IS NULL AND original_uom_src IS NULL
       AND original_quantity_src_flag IS NULL AND original_uom_src_flag IS NULL AND source_updated_at IS NULL)
    OR (status_effect = 'EFFECTIVE' AND disposition <> 'NOT_COMPLETED'
        AND return_document_id IS NOT NULL AND recorded_at IS NOT NULL AND original_order_line_id IS NOT NULL
        AND original_order_id IS NOT NULL AND product_id IS NOT NULL
        AND return_gmv_amount IS NOT NULL AND original_completed_at IS NOT NULL AND original_order_type IS NOT NULL
        AND original_order_status IS NOT NULL
        AND (sale_ref_line_id IS NOT NULL) = (disposition IN ('APPLIED', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE'))
        AND (sale_ref_line_id IS NULL OR sale_ref_line_id = original_order_line_id)
        AND ((returns_policy = 'net_returns_v1'
              AND return_base_quantity IS NOT NULL AND original_base_quantity IS NOT NULL AND original_gmv_amount IS NOT NULL
              AND (original_quantity_src_flag IS NULL OR original_quantity_src IS NULL)
              AND (original_uom_src_flag IS NULL OR original_uom_src IS NULL))
             -- Q-236: lượng BI và ngữ cảnh người / POS / B / G / q·u gốc không thuộc hợp đồng — không lưu.
             OR (returns_policy = 'full_line_qty_refund_v1'
                 AND return_base_quantity IS NULL AND original_seller_email IS NULL AND original_pos_code IS NULL
                 AND original_base_quantity IS NULL AND original_gmv_amount IS NULL AND original_quantity_src IS NULL
                 AND original_uom_src IS NULL AND original_quantity_src_flag IS NULL AND original_uom_src_flag IS NULL))));

-- Sự kiện RETURN: phiếu sau của cùng dòng (full_line) có base_delta = eligible_delta = 0; seal N3 ép đúng giá trị từng policy.
ALTER TABLE public.cms_result_events DROP CONSTRAINT cms_result_events_sign;
ALTER TABLE public.cms_result_events ADD CONSTRAINT cms_result_events_sign CHECK (
  (kind = 'SALE' AND base_delta >= 0 AND eligible_delta >= 0 AND gmv_delta >= 0 AND amount_vnd >= 0
     AND status IN ('WAITING_GATE', 'ACCUMULATING', 'RECORDED', 'NOT_COUNTED'))
  OR (kind = 'RETURN' AND base_delta <= 0 AND eligible_delta <= 0 AND gmv_delta <= 0 AND amount_vnd <= 0
      AND status IN ('WAITING_GATE', 'RETURN_REDUCED', 'RETURN_NO_CHANGE')));

-- Baseline sổ: fp v2 không có lượng (base NULL ⇔ v2). CHECK vân tay (cms_return_baselines_fp) giữ nguyên — hàm cms__return_fp thay
-- thêm nhánh v2.
ALTER TABLE public.cms_return_baselines
  DROP CONSTRAINT cms_return_baselines_fp_version_check,
  DROP CONSTRAINT cms_return_baselines_base_quantity_check;
ALTER TABLE public.cms_return_baselines ALTER COLUMN base_quantity DROP NOT NULL;
ALTER TABLE public.cms_return_baselines
  ADD CONSTRAINT cms_return_baselines_fp_version_check CHECK (fp_version IN ('cms-return-fp-v1', 'cms-return-fp-v2')),
  ADD CONSTRAINT cms_return_baselines_base_quantity_check CHECK (
    (fp_version = 'cms-return-fp-v1') = (base_quantity IS NOT NULL)
    AND (base_quantity IS NULL OR (base_quantity > 0 AND scale(base_quantity) = 0 AND base_quantity < 1e29)));

-- Báo cáo sau chốt: profile + bộ version theo profile.
ALTER TABLE public.cms_return_close_reports ADD COLUMN returns_profile text NOT NULL DEFAULT 'net_returns_v1';
ALTER TABLE public.cms_return_close_reports ALTER COLUMN returns_profile DROP DEFAULT;
ALTER TABLE public.cms_return_close_reports
  DROP CONSTRAINT cms_return_close_reports_calc_contract_version_check,
  DROP CONSTRAINT cms_return_close_reports_fp_version_check,
  DROP CONSTRAINT cms_return_close_reports_status_dictionary_version_check;
ALTER TABLE public.cms_return_close_reports
  ADD CONSTRAINT cms_return_close_reports_versions CHECK (
    (returns_profile = 'net_returns_v1' AND calc_contract_version = 'cms-calc-ret2-v1' AND fp_version = 'cms-return-fp-v1'
       AND status_dictionary_version = 'cms-return-status-v1')
    OR (returns_profile = 'full_line_qty_refund_v1' AND calc_contract_version = 'cms-calc-ret2-v2' AND fp_version = 'cms-return-fp-v2'
        AND status_dictionary_version = 'cms-return-status-v2')),
  ADD CONSTRAINT cms_return_close_reports_profile_bind UNIQUE (id, program_id, returns_profile);
-- Sự kiện báo cáo: v1 giữ base (lượng BI > 0); v2 không lượng BI, có qty_effect (B_i ở phiếu đầu của dòng, 0 phiếu sau) cho phiếu APPLIED.
ALTER TABLE public.cms_return_close_report_events
  ADD COLUMN returns_profile text NOT NULL DEFAULT 'net_returns_v1',
  ADD COLUMN qty_effect numeric;
ALTER TABLE public.cms_return_close_report_events ALTER COLUMN returns_profile DROP DEFAULT;
ALTER TABLE public.cms_return_close_report_events DROP CONSTRAINT cms_return_close_report_events_base_check;
ALTER TABLE public.cms_return_close_report_events ALTER COLUMN base DROP NOT NULL;
ALTER TABLE public.cms_return_close_report_events
  ADD CONSTRAINT cms_return_close_report_events_profile_fk FOREIGN KEY (report_id, program_id, returns_profile)
    REFERENCES public.cms_return_close_reports (id, program_id, returns_profile),
  ADD CONSTRAINT cms_return_close_report_events_qty CHECK (
    (returns_profile = 'net_returns_v1' AND base IS NOT NULL AND base > 0 AND scale(base) = 0 AND qty_effect IS NULL)
    OR (returns_profile = 'full_line_qty_refund_v1' AND base IS NULL
        AND (qty_effect IS NOT NULL) = (disposition = 'APPLIED')
        AND (qty_effect IS NULL OR (qty_effect >= 0 AND scale(qty_effect) <= 9))));

-- r1 (Q-237): lần chốt ghi hợp đồng của run chốt (NULL ⇔ run legacy). ADD COLUMN không bắn trigger bất biến (cms_payout_immutable là
-- BEFORE UPDATE / DELETE theo dòng), không UPDATE dòng cũ. Hình dạng = hình dạng run (cms_sync_runs_contract_shape / returns_shape /
-- ledger_shape); FK (run_id, returns_policy) ⇒ policy ghi ở payout đúng policy GHIM của run (MATCH SIMPLE: legacy NULL không kiểm).
ALTER TABLE public.cms_payouts
  ADD COLUMN calc_contract_version text,
  ADD COLUMN quantity_basis        text,
  ADD COLUMN returns_policy        text,
  ADD COLUMN returns_as_of         timestamptz,
  ADD COLUMN returns_digest        text,
  ADD COLUMN ledger_eval_seq       bigint;
ALTER TABLE public.cms_payouts
  ADD CONSTRAINT cms_payouts_contract_shape CHECK (
    (calc_contract_version IS NULL AND quantity_basis IS NULL AND returns_policy IS NULL AND returns_as_of IS NULL
       AND returns_digest IS NULL AND ledger_eval_seq IS NULL)
    OR (calc_contract_version IN ('cms-calc-ret2-v1', 'cms-calc-ret2-v2') AND quantity_basis IN ('pos_base', 'cms_unit')
        AND returns_policy IN ('sales_only_v1', 'net_returns_v1', 'full_line_qty_refund_v1')
        AND (returns_policy = 'full_line_qty_refund_v1') = (calc_contract_version = 'cms-calc-ret2-v2')
        AND (quantity_basis = 'cms_unit' OR returns_policy <> 'sales_only_v1')
        AND (returns_policy = 'sales_only_v1') = (returns_as_of IS NULL)
        AND (returns_as_of IS NULL) = (returns_digest IS NULL) AND (returns_as_of IS NULL) = (ledger_eval_seq IS NULL))),
  ADD CONSTRAINT cms_payouts_contract_run_fk FOREIGN KEY (run_id, returns_policy) REFERENCES public.cms_sync_runs (id, returns_policy);

-- r1 (PM r0 P1-04): báo cáo ngày 31 lập bằng PHIÊN super ⇒ lý do + khoá yêu cầu lưu cùng báo cáo (người lập = created_by = auth.uid()).
-- Báo cáo super cũ (130, không lý do) vẫn hợp lệ. UNIQUE (chương trình, khoá yêu cầu) ⇒ phát lại không nhân bản.
ALTER TABLE public.cms_return_close_reports ADD COLUMN manual_reason text, ADD COLUMN manual_request uuid;
ALTER TABLE public.cms_return_close_reports
  ADD CONSTRAINT cms_return_close_reports_manual CHECK (
    (manual_reason IS NULL) = (manual_request IS NULL)
    AND (manual_reason IS NULL OR (created_via = 'super' AND created_by IS NOT NULL AND char_length(manual_reason) BETWEEN 10 AND 500
                                   AND manual_reason !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]'
                                   AND manual_reason = btrim(manual_reason, E' \t\r\n')))),
  ADD CONSTRAINT cms_return_close_reports_request_uniq UNIQUE (program_id, manual_request);

-- r1 (Q-237): dòng báo cáo của run CONTRACT mang phần trả ĐÃ TRỪ trong số chốt (đủ điều kiện / hoàn — từ cms_results của run chốt);
-- NULL ⇔ run legacy. frozen_base / frozen_gmv của run contract = số GỘP đóng băng; return_* = mọi phiếu APPLIED của snapshot.
-- Ràng buộc toán: nhóm có phiếu mà lượng đủ điều kiện trừ 0 (lớp OTHER_UNIT / lẻ… — full_line E_i = 0) hợp lệ; không phiếu ⇒ không trừ.
ALTER TABLE public.cms_return_close_report_lines ADD COLUMN frozen_return_base numeric, ADD COLUMN frozen_return_gmv numeric;
ALTER TABLE public.cms_return_close_report_lines DROP CONSTRAINT cms_return_close_report_lines_math;
ALTER TABLE public.cms_return_close_report_lines
  ADD CONSTRAINT cms_return_close_report_lines_math CHECK (
    delta = recomputed_amount - frozen_amount AND eligible_base = frozen_base - return_base AND net_gmv = frozen_gmv - return_gmv
    AND (return_events > 0 OR (return_base = 0 AND return_gmv = 0))
    AND (frozen_return_base IS NULL) = (frozen_return_gmv IS NULL)
    AND (frozen_return_base IS NULL OR (frozen_return_base >= 0 AND frozen_return_gmv >= 0)));
-- r1: sự kiện báo cáo của run contract: đã APPLIED trong run chốt (đã trừ trước chốt) hay phát sinh sau chốt; NULL ⇔ legacy / không APPLIED.
ALTER TABLE public.cms_return_close_report_events ADD COLUMN pre_lock boolean;
ALTER TABLE public.cms_return_close_report_events
  ADD CONSTRAINT cms_return_close_report_events_pre_lock CHECK (pre_lock IS NULL OR disposition = 'APPLIED');
-- r2 (Q-238 b): chứng nhận nguồn có VERSION — đúng hai bộ (field_set, fp_version, tool_version); không trộn (vd decision10 + fp v2).
-- Dòng 124 đều là bộ một ⇒ VALIDATE qua; guard bất biến 124 (cms__attest_immutable) giữ nguyên (so mọi cột).
ALTER TABLE public.cms_source_attestations DROP CONSTRAINT cms_source_attestations_fp_version_check,
  DROP CONSTRAINT cms_source_attestations_field_set_check, DROP CONSTRAINT cms_source_attestations_tool_version_check;
ALTER TABLE public.cms_source_attestations
  ADD CONSTRAINT cms_source_attest_version CHECK (
    (field_set, fp_version, tool_version) IN (('decision10', 'cms-rows-fp-v1', 'cms-i4-compare-v1'),
                                              ('decision_unit14', 'cms-rows-fp-v2', 'cms-i4-compare-v2')));
-- ── P2. Hàm mới ─────────────────────────────────────────────────────────────
-- (cms__return_status_effect_v tạo ở P0 — CHECK cms_return_lines_effect của P1 gọi nó.)
-- cms__report_rows có tham số từ điển (thân = cms__report_rows 130, chỉ đổi lời gọi từ điển — sinh từ 130).
CREATE FUNCTION public.cms__report_rows2(p_dict text, p_rows jsonb)
RETURNS TABLE (return_event_id text, return_status text, status_effect text, return_document_id text, return_code text,
               recorded_at timestamptz, original_order_line_id text, original_order_id text, product_id text,
               return_base_quantity numeric, return_gmv_amount numeric, original_completed_at timestamptz, original_order_type text,
               original_order_status text, original_seller_email text, original_pos_code text, original_base_quantity numeric,
               original_gmv_amount numeric, original_quantity_src text, original_uom_src text, original_quantity_src_flag text,
               original_uom_src_flag text, source_updated_at timestamptz, row_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.return_event_id, r.return_status, public.cms__return_status_effect_v(p_dict, r.return_status), r.return_document_id, r.return_code,
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

-- ── P2b. Lưu báo cáo sau chốt (r1 — PM r0 P1-04) ────────────────────────────
-- r3 (PM 20/11 S2): bước 5 của lõi (suy từ dòng bán đã đóng băng) ở hàm SQL riêng, sinh từ thân lõi: dòng bán / phiếu của run đọc theo
-- TẬP (LEFT JOIN, PK duy nhất ⇒ ≤ 1 dòng khớp như LIMIT 1 / truy vấn con cũ) và SET enable_nestloop = off ⇒ chỉ hash / merge join — mỗi
-- bảng run MỘT lượt bất kể thống kê (thống kê chưa biết run mới từng làm probe từng phiếu chọn index (run_id, seq) ⇒ quét lại cả run mỗi
-- phiếu, 50–100 s ở 10.000 phiếu). Owner-only.
CREATE FUNCTION public.cms__close_report_scan(p_program_id uuid, p_payout_run_id uuid, v_dict text, v_rows jsonb, v_fpv text, v_full boolean, v_ct boolean, v_from timestamp with time zone, v_to timestamp with time zone, v_asof timestamp with time zone)
RETURNS TABLE (o_code text, o_ids text, o_ret jsonb, o_obs jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET enable_nestloop = off AS $$
  WITH p0 AS MATERIALIZED (
    SELECT x.*,
           CASE WHEN x.status_effect = 'EFFECTIVE' THEN public.cms__return_fp(v_fpv, p_program_id, x.return_event_id,
                  x.return_document_id, x.original_order_line_id, x.original_order_id, x.product_id, x.return_base_quantity,
                  x.return_gmv_amount, x.recorded_at) END AS fp,
           (SELECT true FROM public.cms_return_baselines b
             WHERE b.program_id = p_program_id AND b.return_event_id = x.return_event_id) IS NOT NULL AS led
      FROM public.cms__report_rows2(v_dict, v_rows) x
  ), d AS (
    SELECT p.*, sl.order_line_id AS sl_id, sl.disposition AS sale_disp, sl.user_id AS sl_user, sl.program_product_id AS sl_pp,
           sl.base_quantity AS sb, sl.gmv_amount AS sg, sl.eligible_base AS se, sl.quantity_class AS sqc,
           EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = p_program_id AND pp.product_id = p.product_id
                          AND pp.retired_at IS NULL) AS in_prog,
           COALESCE(sl.order_line_id IS NOT NULL AND (
             CASE WHEN v_full
                  THEN (sl.order_id, sl.product_id, sl.completed_at) IS DISTINCT FROM (p.original_order_id, p.product_id, p.original_completed_at)
                  ELSE (sl.order_id, sl.product_id, sl.completed_at, sl.seller_email, sl.pos_code, sl.base_quantity, sl.gmv_amount)
             IS DISTINCT FROM
             (p.original_order_id, p.product_id, p.original_completed_at, p.original_seller_email, p.original_pos_code,
              p.original_base_quantity, p.original_gmv_amount) END
             OR NOT (p.original_order_type = 'OFFLINE' AND p.original_order_status = 'COMPLETED')), false) AS ctx_bad
      FROM p0 p
      LEFT JOIN public.cms_sales_lines sl ON sl.run_id = p_payout_run_id AND sl.order_line_id = p.original_order_line_id
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
  ), eq0 AS (
    SELECT e.*, row_number() OVER (PARTITION BY e.original_order_line_id, e.disp
                                   ORDER BY e.recorded_at, e.return_event_id COLLATE "C") AS lrn
      FROM e
  ), eq AS (
    SELECT e.*, CASE WHEN v_full AND e.disp = 'APPLIED' THEN CASE WHEN e.lrn = 1 THEN e.sb ELSE 0 END END AS qty,
           CASE WHEN e.disp IS DISTINCT FROM 'APPLIED' THEN NULL
                WHEN v_full THEN CASE WHEN e.lrn = 1 THEN COALESCE(e.se, e.sb) ELSE 0 END
                WHEN e.sqc IS NULL OR e.sqc IN ('POS_BASE', 'COUNTED') THEN e.return_base_quantity ELSE 0 END AS ee,
           CASE WHEN v_ct AND e.disp = 'APPLIED' THEN rl.return_event_id IS NOT NULL END AS pre
      FROM eq0 e
      LEFT JOIN public.cms_return_lines rl ON rl.run_id = p_payout_run_id AND rl.return_event_id = e.return_event_id
                                         AND rl.disposition = 'APPLIED'
  ), acc AS (
    SELECT e.original_order_line_id AS id, max(e.sb) AS sb, max(e.sg) AS sg, sum(e.return_base_quantity) AS rb, sum(e.return_gmv_amount) AS rg
      FROM e WHERE e.disp IN ('APPLIED', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE') GROUP BY e.original_order_line_id
  ), h AS (
    SELECT 'AFTER_AS_OF' AS code, e.return_event_id AS ref FROM e WHERE e.recorded_at > v_asof
    UNION ALL SELECT 'BEFORE_SALE', e.return_event_id FROM e WHERE e.recorded_at < e.original_completed_at
    UNION ALL SELECT 'CONTEXT_MISMATCH', e.return_event_id FROM e WHERE e.ctx_bad
    UNION ALL SELECT 'ORIGIN_MISSING', e.return_event_id FROM e WHERE NOT e.ctx_bad AND e.disp IS NULL
    UNION ALL SELECT 'EXCEEDS_SALE_BASE', acc.id FROM acc WHERE NOT v_full AND acc.rb > acc.sb
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
                     'doc', e.return_document_id, 'order_id', e.original_order_id, 'product_id', e.product_id, 'qty', e.qty,
                     'ee', e.ee, 'pre', e.pre))
                    FROM eq e), '[]'::jsonb),
         -- Quan sát bước 6: mọi phiếu (cả chưa hiệu lực) đã có baseline.
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'id', p.return_event_id, 'status', p.return_status, 'effect', p.status_effect, 'fp', p.fp,
                     'base', p.return_base_quantity::text, 'refund', p.return_gmv_amount::text,
                     'recorded_at', CASE WHEN p.recorded_at IS NOT NULL THEN public.cms__ts(p.recorded_at) END))
                    FROM p0 p WHERE p.led), '[]'::jsonb);
$$;

-- r3 (PM 20/11 S2): kiểm lệch sổ của cms__lock_eval theo TẬP — có baseline của chương trình mà phiếu cùng id trong run không hiệu lực
-- (không có / NULL / ≠ EFFECTIVE). Cùng nghĩa EXISTS + truy vấn con PK cũ (COALESCE(bool_or(c), false) ≡ EXISTS(… WHERE c); c không bao
-- giờ NULL vì IS DISTINCT FROM); enable_nestloop = off ⇒ baseline của chương trình và phiếu của run mỗi bên một lượt. Owner-only.
CREATE FUNCTION public.cms__ledger_drift(p_program_id uuid, p_run_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET enable_nestloop = off AS $$
  SELECT COALESCE(bool_or(rl.status_effect IS DISTINCT FROM 'EFFECTIVE'), false)
    FROM public.cms_return_baselines b
    LEFT JOIN public.cms_return_lines rl ON rl.run_id = p_run_id AND rl.return_event_id = b.return_event_id
   WHERE b.program_id = p_program_id
$$;

-- Lõi owner-only = thân rpc_cms_return_close_report_save 130 vá theo neo (sinh từ 130): người lập / lý do / khoá yêu cầu là THAM SỐ.
CREATE FUNCTION public.cms__close_report_save(p_program_id uuid, p_payout_run_id uuid, p_payload jsonb, p_actor uuid, p_reason text,
                                              p_request uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  c_ts   CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$';
  c_pid  CONSTANT text := '^[1-9][0-9]{0,18}$';
  c_txt  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,100}$';
  c_t50  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,50}$';
  c_t30  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,30}$';
  c_ctl  CONSTANT text := '[\x01-\x1f\x7f-\x9f]';  -- r1: kiểm phiếu = char_length + !~ c_ctl (tương đương c_txt / c_t30 / c_t50)
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
  v_full   boolean;  -- 132: profile full_line_qty_refund_v1
  v_dict   text;
  v_fpv    text;
  v_ct     boolean;  -- r1: run chốt là run contract (Q-237)
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
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('pin', 'returns', 'profile'))
     OR jsonb_typeof(p_payload -> 'pin') IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload -> 'returns') IS DISTINCT FROM 'array'
     OR (p_payload ? 'profile' AND p_payload -> 'profile' IS DISTINCT FROM '"full_line_qty_refund_v1"'::jsonb), true) THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  v_pin := p_payload -> 'pin';
  v_rows := p_payload -> 'returns';
  -- 132: thiếu `profile` ⇒ net_returns_v1 (payload 130 nguyên dạng); full_line ⇒ từ điển v2 / fp v2 / hình dạng không lượng BI.
  v_full := p_payload ? 'profile';
  v_dict := CASE WHEN v_full THEN 'cms-return-status-v2' ELSE 'cms-return-status-v1' END;
  v_fpv  := CASE WHEN v_full THEN 'cms-return-fp-v2' ELSE 'cms-return-fp-v1' END;
  v_n := jsonb_array_length(v_rows);
  -- r1: người lập = THAM SỐ (cron ⇒ NULL; đường super ⇒ auth.uid() do wrapper phiên truyền sau khi kiểm is_super_admin()); lý do + khoá
  -- yêu cầu đi cùng người lập (đủ cả ba hoặc không có). Lý do 10–500 ký tự đã cắt khoảng trắng, không ký tự điều khiển (trừ tab / xuống dòng).
  v_actor := p_actor;
  IF (p_actor IS NULL) <> (p_reason IS NULL) OR (p_reason IS NULL) <> (p_request IS NULL)
     OR (p_reason IS NOT NULL AND (p_reason ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]' OR char_length(p_reason) NOT BETWEEN 10 AND 500
                                   OR p_reason <> btrim(p_reason, E' \t\r\n'))) THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- r1: trần phiếu / báo cáo theo profile — full_line 10.000 (= TS CMS_CLOSE_REPORT_MAX_RETURNS_FULL_LINE; PM r0 §3.3 đặt 20.000 + bench < 8 s,
  -- bench PG15 r1 đo 20.000 = 8,0–9,6 s ⇒ Dev đề xuất 10.000, TODO(Q-238) PM chốt), v1 giữ 100.000.
  -- Vượt ⇒ dừng TRƯỚC mọi khoá / ghi; không cắt / chia.
  IF v_n > (CASE WHEN v_full THEN 10000 ELSE 100000 END) THEN RAISE EXCEPTION 'CMS_REPORT_TOO_LARGE' USING ERRCODE = '22023'; END IF;
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
       WHERE NOT (COALESCE(char_length(x.return_event_id) BETWEEN 1 AND 100 AND x.return_event_id !~ c_ctl
                           AND char_length(x.return_status) BETWEEN 1 AND 30 AND x.return_status !~ c_ctl, false)
                  AND (x.return_document_id IS NULL OR (char_length(x.return_document_id) BETWEEN 1 AND 100 AND x.return_document_id !~ c_ctl))
                  AND (x.return_code IS NULL OR (char_length(x.return_code) BETWEEN 1 AND 100 AND x.return_code !~ c_ctl))
                  AND (x.recorded_at IS NULL OR x.recorded_at ~ c_ts)
                  AND (x.original_order_line_id IS NULL OR (char_length(x.original_order_line_id) BETWEEN 1 AND 100 AND x.original_order_line_id !~ c_ctl))
                  AND (x.original_order_id IS NULL OR (char_length(x.original_order_id) BETWEEN 1 AND 100 AND x.original_order_id !~ c_ctl))
                  AND (x.product_id IS NULL OR x.product_id ~ c_pid)
                  AND (x.return_base_quantity IS NULL OR x.return_base_quantity ~ c_rqty)
                  AND (x.return_gmv_amount IS NULL OR x.return_gmv_amount ~ c_rgmv)
                  AND (x.original_completed_at IS NULL OR x.original_completed_at ~ c_ts)
                  AND (x.original_order_type IS NULL OR (char_length(x.original_order_type) BETWEEN 1 AND 30 AND x.original_order_type !~ c_ctl))
                  AND (x.original_order_status IS NULL OR (char_length(x.original_order_status) BETWEEN 1 AND 30 AND x.original_order_status !~ c_ctl))
                  AND (x.original_seller_email IS NULL OR (x.original_seller_email ~ c_mail AND char_length(x.original_seller_email) <= 320
                                                           AND x.original_seller_email = lower(x.original_seller_email)))
                  AND (x.original_pos_code IS NULL OR (char_length(x.original_pos_code) BETWEEN 1 AND 50 AND x.original_pos_code !~ c_ctl))
                  AND (x.original_base_quantity IS NULL OR x.original_base_quantity ~ c_dec)
                  AND (x.original_gmv_amount IS NULL OR x.original_gmv_amount ~ c_dec)
                  AND (x.original_quantity_src IS NULL OR char_length(x.original_quantity_src) <= 64)
                  AND (x.original_uom_src IS NULL OR char_length(x.original_uom_src) <= 64)
                  AND (x.original_quantity_src_flag IS NULL OR x.original_quantity_src_flag ~ c_flag)
                  AND (x.original_uom_src_flag IS NULL OR x.original_uom_src_flag ~ c_flag)
                  AND (x.source_updated_at IS NULL OR x.source_updated_at ~ c_ts))) THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_ROW' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(v_rows) AS x(return_status text) WHERE public.cms__return_status_effect_v(v_dict, x.return_status) IS NULL) THEN
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
                    AND (p.return_base_quantity IS NOT NULL) = (NOT v_full) AND p.return_gmv_amount IS NOT NULL
                    AND p.original_completed_at IS NOT NULL
                    AND p.original_order_type IS NOT NULL AND p.original_order_status IS NOT NULL
                    AND (p.original_base_quantity IS NOT NULL) = (NOT v_full) AND (p.original_gmv_amount IS NOT NULL) = (NOT v_full)
                    AND (NOT v_full OR (p.original_seller_email IS NULL AND p.original_pos_code IS NULL AND p.original_quantity_src IS NULL
                                        AND p.original_uom_src IS NULL AND p.original_quantity_src_flag IS NULL
                                        AND p.original_uom_src_flag IS NULL))
                    AND (p.original_quantity_src_flag IS NULL OR p.original_quantity_src IS NULL)
                    AND (p.original_uom_src_flag IS NULL OR p.original_uom_src IS NULL)), false)), false),
         encode(sha256(convert_to('cms-src-digest-v1' || E'\n' || 'returns' || E'\n' || count(*)::text || E'\n'
                                  || COALESCE(string_agg(p.row_hash, E'\n' ORDER BY p.return_event_id COLLATE "C"), ''), 'UTF8')), 'hex')
    INTO v_badrow, v_dig
    FROM public.cms__report_rows2(v_dict, v_rows) p;
  IF v_badrow THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_ROW' USING ERRCODE = '22023';
  END IF;

  -- 2. Khoá chương trình (cùng thứ tự publish / confirm / chốt) → payout → run chốt.
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_prog.status IS DISTINCT FROM 'locked' THEN RAISE EXCEPTION 'CMS_REPORT_NOT_LOCKED' USING ERRCODE = 'P0001'; END IF;
  IF p_request IS NOT NULL THEN
    SELECT id INTO v_old FROM public.cms_return_close_reports WHERE program_id = p_program_id AND manual_request = p_request;
    IF FOUND THEN RETURN jsonb_build_object('saved', true, 'already', true, 'report_id', v_old); END IF;
  END IF;
  SELECT * INTO v_pay FROM public.cms_payouts WHERE program_id = p_program_id;
  IF NOT FOUND OR v_pay.run_id IS DISTINCT FROM p_payout_run_id THEN
    RAISE EXCEPTION 'CMS_REPORT_PAYOUT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_payout_run_id;
  -- r1 (Q-237): run contract chốt được ⇒ báo cáo đọc HỢP ĐỒNG ĐÓNG BĂNG (số gộp + điều kiện gốc + phiếu đã nhận + số ròng). Profile
  -- theo LỰA CHỌN GHIM (PM r0 §3.1): run đọc trả ⇒ đúng policy run (khác ⇒ PROFILE_MISMATCH); legacy / sales-only ⇒ lựa chọn của báo cáo
  -- đầu tiên (super) — cron (không người lập) không tự chọn khi chương trình chưa có báo cáo (POLICY_UNSELECTED). 0 ghi.
  v_ct := v_run.calc_contract_version IS NOT NULL;
  IF v_ct AND v_run.calc_contract_version NOT IN ('cms-calc-ret2-v1', 'cms-calc-ret2-v2') THEN
    RAISE EXCEPTION 'CMS_REPORT_CONTRACT_UNSUPPORTED' USING ERRCODE = 'P0001';
  END IF;
  -- db-reviewer r1 P2: đường hợp đồng đóng băng là MỚI ở r1 ⇒ trần 10.000 phiếu (= full_line) cho MỌI run contract (cả payload net_returns_v1); trần
  -- 100.000 chỉ còn cho run legacy (hợp đồng 130). Trước mọi ghi (đã khoá, chưa ghi gì).
  IF v_ct AND v_n > 10000 THEN RAISE EXCEPTION 'CMS_REPORT_TOO_LARGE' USING ERRCODE = '22023'; END IF;
  IF v_ct AND v_run.returns_policy <> 'sales_only_v1'
     AND v_run.returns_policy IS DISTINCT FROM (CASE WHEN v_full THEN 'full_line_qty_refund_v1' ELSE 'net_returns_v1' END) THEN
    RAISE EXCEPTION 'CMS_REPORT_PROFILE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF p_actor IS NULL AND COALESCE(v_run.returns_policy, 'sales_only_v1') = 'sales_only_v1'
     AND NOT EXISTS (SELECT 1 FROM public.cms_return_close_reports r WHERE r.program_id = p_program_id) THEN
    RAISE EXCEPTION 'CMS_REPORT_POLICY_UNSELECTED' USING ERRCODE = 'P0001';
  END IF;
  -- 132: sổ một version / chương trình — báo cáo profile khác version baseline sẵn có, HOẶC khác profile của báo cáo đã lưu (kể cả
  -- báo cáo không tạo baseline: mọi phiếu chưa hiệu lực / ngoài chương trình) ⇒ chặn (0 ghi).
  IF EXISTS (SELECT 1 FROM public.cms_return_baselines b WHERE b.program_id = p_program_id AND b.fp_version <> v_fpv)
     OR EXISTS (SELECT 1 FROM public.cms_return_close_reports r WHERE r.program_id = p_program_id
                  AND r.returns_profile <> CASE WHEN v_full THEN 'full_line_qty_refund_v1' ELSE 'net_returns_v1' END) THEN
    RAISE EXCEPTION 'CMS_REPORT_PROFILE_LEDGER_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF v_pin ->> 'provider' = 'fixture' AND NOT v_prog.is_test THEN RAISE EXCEPTION 'CMS_REPORT_PIN_PROVIDER' USING ERRCODE = 'P0001'; END IF;
  -- 3. Pin = chương trình (kỳ + tập SP); digest phiếu DB tự tính = pin; as_of không ở tương lai.
  SELECT encode(sha256(convert_to('cms-src-digest-v1' || E'\n' || 'products' || E'\n' || count(*)::text || E'\n'
                                  || COALESCE(string_agg(pp.product_id, E'\n' ORDER BY pp.product_id COLLATE "C"), ''), 'UTF8')), 'hex')
    INTO v_ph FROM public.cms_program_products pp WHERE pp.program_id = p_program_id AND pp.retired_at IS NULL;
  v_asof := (v_pin ->> 'as_of')::timestamptz;
  IF (v_pin -> 'scope' ->> 'from')::date IS DISTINCT FROM v_prog.start_date OR (v_pin -> 'scope' ->> 'to')::date IS DISTINCT FROM v_prog.end_date
     OR v_ph IS DISTINCT FROM v_pin -> 'scope' ->> 'products_hash' THEN
    RAISE EXCEPTION 'CMS_REPORT_PIN_SCOPE' USING ERRCODE = 'P0001';
  END IF;
  IF v_dig IS DISTINCT FROM v_pin -> 'returns' ->> 'digest' THEN RAISE EXCEPTION 'CMS_REPORT_PIN_DIGEST' USING ERRCODE = 'P0001'; END IF;
  IF v_asof > now() + interval '5 minutes' THEN RAISE EXCEPTION 'CMS_REPORT_BAD_PIN' USING ERRCODE = '22023'; END IF;
  -- 4. Idempotency sau khoá: cùng chương trình / run chốt / as_of / digest / version ⇒ báo cáo cũ.
  v_idem := encode(sha256(convert_to(CASE WHEN v_full
                 THEN concat_ws(E'\n', 'cms-close-report-v2', p_program_id::text, p_payout_run_id::text, public.cms__ts(v_asof), v_dig,
                                'cms-calc-ret2-v2', 'cms-return-fp-v2', 'cms-return-status-v2', 'full_line_qty_refund_v1')
                 ELSE concat_ws(E'\n', 'cms-close-report-v1', p_program_id::text, p_payout_run_id::text,
                                               public.cms__ts(v_asof), v_dig, 'cms-calc-ret2-v1', 'cms-return-fp-v1', 'cms-return-status-v1') END,
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
  --    r3 (PM 20/11 S2): câu tính ở cms__close_report_scan — dòng bán / phiếu run theo TẬP (hash / merge join, enable_nestloop = off),
  --    không phụ thuộc thống kê run mới; baseline vẫn probe PK (program_id, return_event_id) — index duy nhất của bảng. p0 = MỘT lần đọc
  --    cms__report_rows2; fp tính MỘT lần cho phiếu hiệu lực, dùng chung cho sự kiện báo cáo (bước 8) và quan sát sổ (bước 6); led = phiếu
  --    đã có baseline (dưới khoá chương trình — baseline chỉ ghi dưới khoá này). Hàm STABLE: cùng snapshot câu gọi.
  SELECT x.o_code, x.o_ids, x.o_ret, x.o_obs INTO v_code, v_ids, v_ret, v_obs
    FROM public.cms__close_report_scan(p_program_id, p_payout_run_id, v_dict, v_rows, v_fpv, v_full, v_ct, v_from, v_to, v_asof) x;
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
    SELECT * FROM jsonb_to_recordset(v_ret) AS x(id text, disp text, user_id uuid, ppid uuid, base numeric, refund numeric, qty numeric,
                                                  ee numeric)
  ), ap AS (
    SELECT ev.user_id, ev.ppid, sum(CASE WHEN v_full THEN ev.qty ELSE ev.base END) AS rb, sum(ev.ee) AS re, sum(ev.refund) AS rg, count(*)::integer AS n
      FROM ev WHERE ev.disp = 'APPLIED' GROUP BY ev.user_id, ev.ppid
  ), r AS (
    SELECT r.*, COALESCE(ap.rb, 0) AS rb, COALESCE(ap.rg, 0) AS rg, COALESCE(ap.n, 0) AS rn, COALESCE(ap.re, 0) AS re
      FROM public.cms_results r
      LEFT JOIN ap ON ap.user_id = r.user_id AND ap.ppid = r.program_product_id
     WHERE r.run_id = p_payout_run_id
  ), cat AS (
    SELECT r.user_id, sum(r.rg) AS crg, COALESCE(sum(r.return_gmv), 0) AS cfr FROM r WHERE r.gmv_basis = 'catalog' GROUP BY r.user_id
  ), g AS (
    SELECT r.*, CASE WHEN v_ct THEN r.eligible_sale_base ELSE r.base_quantity END AS fb,
           CASE WHEN v_ct THEN r.re ELSE r.rb END AS rbx,
           CASE WHEN v_ct THEN r.sale_gmv ELSE r.gmv_amount END AS fg,
           CASE WHEN v_ct THEN r.eligible_sale_base - r.re ELSE r.base_quantity - r.rb END AS elig,
           CASE WHEN v_ct THEN r.sale_gmv ELSE r.gmv_amount END - r.rg AS net_gmv,
           CASE r.gmv_basis WHEN 'none' THEN true
                            WHEN 'product' THEN COALESCE(CASE WHEN v_ct THEN r.sale_gmv ELSE r.gate_gmv END - r.rg >= r.target_gmv, false)
                            ELSE COALESCE(k.catalog_gmv + CASE WHEN v_ct THEN COALESCE(cat.cfr, 0) ELSE 0 END - COALESCE(cat.crg, 0)
                                          >= k.target_gmv, false) END AS met,
           GREATEST(floor((CASE WHEN v_ct THEN r.eligible_sale_base - r.re ELSE r.base_quantity - r.rb END) / r.per_unit), 0)::bigint AS qn
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
           'gmv_basis', q.gmv_basis, 'per_unit', q.per_unit, 'frozen_base', q.fb, 'frozen_qty', q.rewarded_quantity,
           'frozen_gmv', q.fg, 'frozen_gate_met', q.gate_met, 'frozen_amount', q.amount_vnd, 'return_base', q.rbx,
           'frozen_return_base', CASE WHEN v_ct THEN q.eligible_return_base END, 'frozen_return_gmv', CASE WHEN v_ct THEN q.return_gmv END,
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
  INSERT INTO public.cms_return_close_reports (id, program_id, payout_run_id, eval_seq, returns_profile, calc_contract_version, fp_version,
    status_dictionary_version, source_pin, returns_as_of, returns_digest, frozen_amount, recomputed_amount, delta_amount, return_events,
    line_count, idem_key, created_via, created_by, manual_reason, manual_request)
  VALUES (v_id, p_program_id, p_payout_run_id, v_seq, CASE WHEN v_full THEN 'full_line_qty_refund_v1' ELSE 'net_returns_v1' END,
          CASE WHEN v_full THEN 'cms-calc-ret2-v2' ELSE 'cms-calc-ret2-v1' END, v_fpv, v_dict, v_pin, v_asof, v_dig,
          v_frozen, v_recomp, v_recomp - v_frozen, v_nev, v_nlines, v_idem, CASE WHEN v_actor IS NULL THEN 'cron' ELSE 'super' END, v_actor,
          p_reason, p_request);
  INSERT INTO public.cms_return_close_report_lines (report_id, program_id, line_no, user_id, program_product_id, product_id, gmv_basis,
    per_unit, frozen_base, frozen_qty, frozen_gmv, frozen_gate_met, frozen_amount, return_base, return_gmv, return_events, eligible_base,
    net_gmv, gate_met, recomputed_qty, recomputed_amount, delta, frozen_return_base, frozen_return_gmv)
  SELECT v_id, p_program_id, x.line_no, x.user_id, x.program_product_id, x.product_id, x.gmv_basis, x.per_unit, x.frozen_base, x.frozen_qty,
         x.frozen_gmv, x.frozen_gate_met, x.frozen_amount, x.return_base, x.return_gmv, x.return_events, x.eligible_base, x.net_gmv,
         x.gate_met, x.recomputed_qty, x.recomputed_amount, x.delta, x.frozen_return_base, x.frozen_return_gmv
    FROM jsonb_to_recordset(v_lines) AS x(line_no integer, user_id uuid, program_product_id uuid, product_id text, gmv_basis text,
           per_unit numeric, frozen_base numeric, frozen_qty bigint, frozen_gmv numeric, frozen_gate_met boolean, frozen_amount bigint,
           return_base numeric, return_gmv numeric, return_events integer, eligible_base numeric, net_gmv numeric, gate_met boolean,
           recomputed_qty bigint, recomputed_amount bigint, delta bigint, frozen_return_base numeric, frozen_return_gmv numeric);
  INSERT INTO public.cms_return_close_report_events (report_id, program_id, return_event_id, financial_fp, original_order_line_id,
    disposition, user_id, program_product_id, base, refund, recorded_at, returns_profile, qty_effect, pre_lock)
  SELECT v_id, p_program_id, x.id, x.fp, x.line, x.disp, x.user_id, x.ppid, x.base, x.refund, x.recorded_at::timestamptz,
         CASE WHEN v_full THEN 'full_line_qty_refund_v1' ELSE 'net_returns_v1' END, CASE WHEN v_full THEN x.qty END, x.pre
    FROM jsonb_to_recordset(v_ret) AS x(id text, fp text, line text, disp text, user_id uuid, ppid uuid, base numeric, refund numeric,
                                        recorded_at text, qty numeric, pre boolean);
  INSERT INTO public.cms_return_baselines (program_id, return_event_id, fp_version, financial_fp, return_document_id,
    original_order_line_id, original_order_id, product_id, base_quantity, refund_amount, recorded_at, accepted_eval_seq, accepted_report_id)
  SELECT p_program_id, x.id, v_fpv, x.fp, x.doc, x.line, x.order_id, x.product_id, x.base, x.refund, x.recorded_at::timestamptz,
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
     OR EXISTS (SELECT 1 FROM public.cms_return_close_report_lines l WHERE l.report_id = v_id AND l.frozen_return_base IS NOT NULL
                  AND (l.return_base < l.frozen_return_base OR l.return_gmv < l.frozen_return_gmv
                       OR (l.return_base = l.frozen_return_base AND l.return_gmv = l.frozen_return_gmv AND l.delta <> 0)))
     OR (NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v_ret) AS x(disp text) WHERE x.disp = 'APPLIED') AND v_recomp IS DISTINCT FROM v_frozen)
     OR v_seq IS DISTINCT FROM (SELECT max(e.eval_seq) FROM public.cms_return_ledger_evals e WHERE e.program_id = p_program_id) THEN
    RAISE EXCEPTION 'CMS_REPORT_ASSERT' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('saved', true, 'already', false, 'report_id', v_id, 'eval_seq', v_seq, 'frozen_amount', v_frozen::text,
                            'recomputed_amount', v_recomp::text, 'delta_amount', (v_recomp - v_frozen)::text, 'return_events', v_nev,
                            'line_count', v_nlines, 'baselines_new', v_new);
END;
$$;

-- Cron (service_role): người lập NULL ⇒ created_via cron. Payload không còn khoá actor — khai UUID trong body không chứng minh người duyệt.
CREATE OR REPLACE FUNCTION public.rpc_cms_return_close_report_save(p_program_id uuid, p_payout_run_id uuid, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
BEGIN
  RETURN public.cms__close_report_save(p_program_id, p_payout_run_id, p_payload, NULL, NULL, NULL);
END;
$$;

-- Ngày 31 (authenticated): PHIÊN super — actor = auth.uid() (không tham số), is_super_admin() (allowlist ở authz.ts + hàm này, KHÔNG chép
-- thêm), chương trình đọc được bởi phiên (QA cần marker — cms_readable_program_ids). Lý do / khoá yêu cầu kiểm ở lõi (dưới khoá chương
-- trình: phát lại cùng khoá ⇒ báo cáo đã lập, kể cả khi snapshot khác).
CREATE FUNCTION public.rpc_cms_return_close_report_save_super(p_program_id uuid, p_payout_run_id uuid, p_payload jsonb, p_reason text,
                                                              p_request uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT COALESCE(public.is_super_admin(), false) THEN
    RAISE EXCEPTION 'CMS_REPORT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_program_id IS NULL OR NOT (p_program_id = ANY (COALESCE(public.cms_readable_program_ids(), '{}'::uuid[]))) THEN
    RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_reason IS NULL OR p_request IS NULL THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  RETURN public.cms__close_report_save(p_program_id, p_payout_run_id, p_payload, v_uid, p_reason, p_request);
END;
$$;

-- ── P2c. Chứng nhận nguồn cms_unit (r2 — Q-238 b) ───────────────────────────
-- Văn bản chuẩn cms-rows-fp-v2 / bộ decision_unit14 của lớp nguồn MỘT run (đúng helper offline cmsI4UnitRowsFpText — parity TS ↔ PGlite ↔
-- PG15). 10 trường đầu = decision10, CÙNG biểu thức cms__run_source_fp_text 124 (to_json chuỗi; số trunc(x·1e9); thời gian µs); 4 trường
-- sau = chuỗi THÔ q / u (130 *_src — capture TRƯỚC làm sạch) + cờ NUL / OVERSIZE. Chuẩn hoá DUY NHẤT: thô rỗng ⇒ null (CSV I4 đọc ô rỗng
-- thành null; classify + seal N1 coi '' như NULL = MISSING ⇒ trung tính phân loại). KHÔNG trim / lower / chuẩn hoá số ("2" ≠ "2.0" ⇒ lệch,
-- fail-closed). Thứ tự order_line_id COLLATE "C" (byte UTF-8; PK trong run). Header khác decision10 ⇒ hai bộ không bao giờ trùng hash.
CREATE FUNCTION public.cms__run_unit_fp_text(p_run_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'cms-rows-fp-v2' || E'\n'
      || 'order_line_id,order_id,order_code,product_id,seller_email,order_type,order_status,completed_at_us,base_quantity_e9,gmv_amount_e9,quantity_src,quantity_src_flag,uom_src,uom_src_flag'
      || E'\n'
      || COALESCE(string_agg(
           '[' || to_json(r.order_line_id)::text || ',' || to_json(r.order_id)::text || ',' || to_json(r.order_code)::text
           || ',' || to_json(r.product_id)::text || ',' || COALESCE(to_json(r.seller_email)::text, 'null')
           || ',' || to_json(r.order_type)::text || ',' || to_json(r.order_status)::text
           || ',"' || trunc(extract(epoch FROM r.completed_at) * 1000000)::text || '"'
           || ',"' || trunc(r.base_quantity * 1000000000)::text || '","' || trunc(r.gmv_amount * 1000000000)::text || '"'
           || ',' || COALESCE(to_json(NULLIF(r.quantity_src, ''))::text, 'null') || ',' || COALESCE(to_json(r.quantity_src_flag)::text, 'null')
           || ',' || COALESCE(to_json(NULLIF(r.uom_src, ''))::text, 'null') || ',' || COALESCE(to_json(r.uom_src_flag)::text, 'null')
           || ']' || E'\n', '' ORDER BY r.order_line_id COLLATE "C"), '')
    FROM public.cms_sales_source_lines r
   WHERE r.run_id = p_run_id
$$;

CREATE FUNCTION public.cms__run_unit_fp(p_run_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT encode(sha256(convert_to(public.cms__run_unit_fp_text(p_run_id), 'UTF8')), 'hex')
$$;

-- Kiểm run cms_unit ĐÃ seal cho chứng nhận decision_unit14: NULL = đạt; mã cố định nếu lệch (không giá trị dòng). Bổ sung
-- cms__run_source_check 124 (chỉ so *_raw / B / G giữa hai lớp): (1) run contract cms_unit đã biết version; (2) MỌI dòng hai lớp có chuỗi
-- thô (src_v = 1); (3) raw = cms__src_clean(thô) trên lớp nguồn (seal N1(a), tập DISTINCT); (4) lớp bán mang ĐÚNG thô / cờ của lớp nguồn;
-- (5) p_class: phân loại / E của lớp bán = tính lại bằng khối N1(c) seal 130 NGUYÊN VĂN (generator chép, không viết tay — một nguồn) trên
-- cấu hình hiện tại (cấu hình đổi ⇒ STALE_CONFIG chặn trước ở nơi gọi).
CREATE FUNCTION public.cms__run_unit_check(p_run_id uuid, p_class boolean)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public SET enable_nestloop = off AS $$
DECLARE
  v_run  public.cms_sync_runs%ROWTYPE;
  v_unit boolean := true;  -- khối N1(c) chép nguyên văn dùng biến này (luôn cms_unit ở đây)
  v_code text;
  v_bad  boolean;
BEGIN
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id;
  IF NOT FOUND OR v_run.kind <> 'sales' THEN RETURN 'RUN_NOT_FOUND'; END IF;
  IF v_run.calc_contract_version IS NULL OR v_run.calc_contract_version NOT IN ('cms-calc-ret2-v1', 'cms-calc-ret2-v2')
     OR v_run.quantity_basis IS DISTINCT FROM 'cms_unit' OR v_run.quantity_policy_version IS DISTINCT FROM 'cms_unit_v2'
     OR v_run.unit_key_version IS DISTINCT FROM 'cms-unit-key-v2' THEN
    RETURN 'UNIT_CONTRACT';
  END IF;
  IF v_run.sealed_at IS NULL OR v_run.seal_step IS DISTINCT FROM 13 THEN RETURN 'NOT_SEALED'; END IF;
  IF v_run.purged_at IS NOT NULL THEN RETURN 'RUN_GONE'; END IF;
  -- Gate G6 r2 lượt c (20/11): mọi kiểm là phép GỘP trên đúng các dòng của run, KHÔNG EXISTS. Với EXISTS, planner chọn Seq Scan
  -- dừng sớm (giả định gặp dòng lệch sớm); ca thường là KHÔNG có dòng lệch ⇒ quét hết bảng của MỌI run (đo: 1,8 triệu dòng ⇒ 626 ms
  -- kiểm src_v, 452 ms kiểm hai lớp; tăng theo cỡ bảng). Gộp phải đọc đủ run: planner chọn Bitmap theo run_id HOẶC Parallel Seq Scan
  -- (chi phí gần nhau — db-reviewer r2 vòng 4 P2-1: phía lớp nguồn có thể vẫn quét cả bảng nhưng chia cho worker; đo sau sửa 158–180 ms
  -- src_v, 234 ms hai lớp ở 1,8 triệu dòng). Tập DISTINCT chắn OFFSET 0 rồi mới gọi cms__src_clean (bản EXISTS bị đẩy điều kiện xuống
  -- TỪNG dòng: 2 × 200.000 lần gọi, 804 ms ⇒ 250 ms). Ngữ nghĩa giữ nguyên: COALESCE(bool_or(c), false) ≡ EXISTS(… WHERE c); run không
  -- có dòng ⇒ NULL ⇒ false.
  IF COALESCE((SELECT bool_or(src_v IS DISTINCT FROM 1) FROM public.cms_sales_source_lines WHERE run_id = p_run_id), false)
     OR COALESCE((SELECT bool_or(src_v IS DISTINCT FROM 1) FROM public.cms_sales_lines WHERE run_id = p_run_id), false) THEN
    RETURN 'UNIT_SRC_V';
  END IF;
  IF COALESCE((SELECT bool_or(public.cms__src_clean(d.quantity_src) IS DISTINCT FROM d.quantity_raw)
                 FROM (SELECT DISTINCT quantity_src, quantity_raw FROM public.cms_sales_source_lines
                        WHERE run_id = p_run_id AND quantity_src IS NOT NULL OFFSET 0) d), false)
     OR COALESCE((SELECT bool_or(public.cms__src_clean(d.uom_src) IS DISTINCT FROM d.uom_raw)
                    FROM (SELECT DISTINCT uom_src, uom_raw FROM public.cms_sales_source_lines
                           WHERE run_id = p_run_id AND uom_src IS NOT NULL OFFSET 0) d), false) THEN
    RETURN 'UNIT_SRC_CLEAN';
  END IF;
  IF COALESCE((SELECT bool_or(s.order_line_id IS NULL
                             OR (e.quantity_src, e.uom_src, e.quantity_src_flag, e.uom_src_flag)
                                IS DISTINCT FROM (s.quantity_src, s.uom_src, s.quantity_src_flag, s.uom_src_flag))
                 FROM public.cms_sales_lines e
                 LEFT JOIN public.cms_sales_source_lines s ON s.run_id = e.run_id AND s.order_line_id = e.order_line_id
                WHERE e.run_id = p_run_id), false) THEN
    RETURN 'UNIT_SRC_ENGINE';
  END IF;
  IF p_class THEN
    -- Khối N1(c) seal 130 bước 4 (nguyên văn — gen-cms-132.mjs chép + kiểm một lần):
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
    IF v_code IS NOT NULL THEN RETURN 'UNIT_CLASS_HOLD'; END IF;
    IF v_bad THEN RETURN 'UNIT_CLASS'; END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- ── P3. Hàm thay (thân 130 / 124 vá theo neo) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.cms__return_fp(p_version text, p_program_id uuid, p_return_event_id text, p_return_document_id text,
                                      p_original_order_line_id text, p_original_order_id text, p_product_id text,
                                      p_base numeric, p_refund numeric, p_recorded_at timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_version = 'cms-return-fp-v2' AND p_program_id IS NOT NULL AND p_return_event_id IS NOT NULL
                   AND p_return_document_id IS NOT NULL AND p_original_order_line_id IS NOT NULL AND p_original_order_id IS NOT NULL
                   AND p_product_id IS NOT NULL AND p_base IS NULL AND p_refund IS NOT NULL AND p_recorded_at IS NOT NULL
                   AND isfinite(p_recorded_at)
              THEN (SELECT encode(sha256(convert_to(string_agg(octet_length(f) || ':' || f, '' ORDER BY i), 'UTF8')), 'hex')
                      FROM unnest(ARRAY[p_version, p_program_id::text, p_return_event_id, p_return_document_id, p_original_order_line_id,
                                        p_original_order_id, p_product_id, trunc(p_refund * 1000000000, 0)::text,
                                        trunc(extract(epoch FROM p_recorded_at) * 1000000, 0)::text]) WITH ORDINALITY AS t(f, i))
              WHEN p_version = 'cms-return-fp-v1' AND p_program_id IS NOT NULL AND p_return_event_id IS NOT NULL
                   AND p_return_document_id IS NOT NULL AND p_original_order_line_id IS NOT NULL AND p_original_order_id IS NOT NULL
                   AND p_product_id IS NOT NULL AND p_base IS NOT NULL AND p_refund IS NOT NULL AND p_recorded_at IS NOT NULL
                   AND isfinite(p_recorded_at)
              THEN encode(sha256(convert_to(string_agg(octet_length(f) || ':' || f, '' ORDER BY i), 'UTF8')), 'hex') END
    FROM unnest(ARRAY[p_version, p_program_id::text, p_return_event_id, p_return_document_id, p_original_order_line_id,
                      p_original_order_id, p_product_id, trunc(p_base * 1000000000, 0)::text, trunc(p_refund * 1000000000, 0)::text,
                      trunc(extract(epoch FROM p_recorded_at) * 1000000, 0)::text]) WITH ORDINALITY AS t(f, i)
$$;

CREATE OR REPLACE FUNCTION public.cms__programs_basis_guard()
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
    -- 132: một chiều sales_only_v1 → net_returns_v1 / full_line_qty_refund_v1; rời policy trả (kể cả net ↔ full_line) ⇒ chặn.
    IF OLD.returns_policy <> 'sales_only_v1' THEN
      RAISE EXCEPTION 'CMS_RETURNS_POLICY_REGRESSION' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.returns_policy NOT IN ('net_returns_v1', 'full_line_qty_refund_v1') OR OLD.status NOT IN ('draft', 'active') OR NEW.status <> OLD.status
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

CREATE OR REPLACE FUNCTION public.rpc_cms_program_set_returns_policy(p_program_id uuid, p_policy text, p_expected_config_version integer, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_prog public.cms_programs%ROWTYPE;
BEGIN
  IF p_program_id IS NULL OR p_actor IS NULL OR p_expected_config_version IS NULL THEN
    RAISE EXCEPTION 'CMS_RETURNS_POLICY_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF p_policy IS NULL OR p_policy NOT IN ('net_returns_v1', 'full_line_qty_refund_v1') THEN
    RAISE EXCEPTION 'CMS_RETURNS_POLICY_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_prog.returns_policy = p_policy THEN
    RETURN jsonb_build_object('program_id', v_prog.id, 'returns_policy', v_prog.returns_policy, 'config_version', v_prog.config_version,
                              'already', true);
  END IF;
  -- 132: chỉ rời sales_only_v1; net_returns_v1 ↔ full_line_qty_refund_v1 không hỗ trợ (sổ / vân tay khác version).
  IF v_prog.returns_policy <> 'sales_only_v1' THEN
    RAISE EXCEPTION 'CMS_RETURNS_POLICY_REGRESSION' USING ERRCODE = 'P0001';
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
     SET returns_policy = p_policy, returns_policy_set_by = p_actor, returns_policy_set_at = now(),
         config_version = config_version + 1, updated_by = p_actor, updated_at = now()
   WHERE id = p_program_id;
  RETURN jsonb_build_object('program_id', p_program_id, 'returns_policy', p_policy, 'config_version', v_prog.config_version + 1,
                            'already', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_capabilities()
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
    ('close_report', 'rpc_cms_return_close_report_events', 'public.rpc_cms_return_close_report_events(uuid,text,integer)', 'authenticated'),
    -- 132: đường mới (app cũ không biết ⇒ bỏ qua; 5 đường cũ giữ NGUYÊN danh sách RPC vì app cũ so tuyệt đối).
    ('full_line', 'rpc_cms_program_set_returns_policy', 'public.rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)', 'service_role'),
    ('full_line', 'rpc_cms_sales_run_open', 'public.rpc_cms_sales_run_open(uuid,jsonb)', 'service_role'),
    ('full_line', 'rpc_cms_return_close_report_save', 'public.rpc_cms_return_close_report_save(uuid,uuid,jsonb)', 'service_role'),
    -- r1 (Q-237): chốt run contract (preview / chốt / payout) + báo cáo ngày 31 qua PHIÊN super — SUY từ catalog như các đường khác.
    ('lock_contract', 'rpc_cms_lock_preview', 'public.rpc_cms_lock_preview(uuid)', 'service_role'),
    ('lock_contract', 'rpc_cms_program_lock', 'public.rpc_cms_program_lock(uuid,uuid,integer,uuid,text,uuid)', 'service_role'),
    ('lock_contract', 'rpc_cms_payout', 'public.rpc_cms_payout(uuid)', 'authenticated'),
    ('manual_report', 'rpc_cms_return_close_report_save_super', 'public.rpc_cms_return_close_report_save_super(uuid,uuid,jsonb,text,uuid)',
     'authenticated'),
    -- r2 (Q-238 b): chứng nhận nguồn cms_unit có version (decision_unit14) qua PHIÊN super — CLI kiểm trước khi xuất / chứng nhận.
    ('unit_attest', 'rpc_cms_source_attest', 'public.rpc_cms_source_attest(uuid,uuid,jsonb,uuid)', 'authenticated'),
    ('unit_attest', 'rpc_cms_run_source_export', 'public.rpc_cms_run_source_export(uuid,uuid,text,integer)', 'authenticated')
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
    ('close_report', 'public.cms__report_rows(jsonb)'),
    ('full_line', 'public.cms__return_status_effect_v(text,text)'),
    ('full_line', 'public.cms__report_rows2(text,jsonb)'),
    ('lock_contract', 'public.cms__lock_eval(uuid,uuid,integer,text,boolean)'),
    ('lock_contract', 'public.cms__close_report_save(uuid,uuid,jsonb,uuid,text,uuid)'),
    ('manual_report', 'public.cms__close_report_save(uuid,uuid,jsonb,uuid,text,uuid)'),
    ('unit_attest', 'public.cms__run_unit_fp(uuid)'),
    ('unit_attest', 'public.cms__run_unit_check(uuid,boolean)')
  ), t(path, rel, col) AS (VALUES
    ('program_modes', 'cms_programs', 'quantity_basis'), ('program_modes', 'cms_programs', 'returns_policy'),
    ('contract_run', 'cms_sync_runs', 'calc_contract_version'), ('contract_run', 'cms_sales_source_lines', 'src_v'),
    ('contract_run', 'cms_return_lines', 'disposition'), ('contract_run', 'cms_result_events', 'event_key'),
    ('readers_v2', 'cms_result_events', 'event_key'),
    ('returns_ledger', 'cms_return_ledger_evals', 'eval_seq'), ('returns_ledger', 'cms_return_baselines', 'financial_fp'),
    ('returns_ledger', 'cms_return_conflicts', 'prev_conflict_id'), ('returns_ledger', 'cms_return_restorations', 'open_set_hash'),
    ('close_report', 'cms_return_close_reports', 'idem_key'), ('close_report', 'cms_return_close_report_lines', 'recomputed_amount'),
    ('close_report', 'cms_return_close_report_events', 'disposition'),
    ('full_line', 'cms_return_lines', 'returns_policy'), ('full_line', 'cms_return_close_reports', 'returns_profile'),
    ('full_line', 'cms_return_close_report_events', 'qty_effect'),
    ('lock_contract', 'cms_payouts', 'calc_contract_version'), ('lock_contract', 'cms_return_close_report_lines', 'frozen_return_base'),
    ('manual_report', 'cms_return_close_reports', 'manual_request'),
    ('unit_attest', 'cms_sales_source_lines', 'quantity_src')
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
    'calc_contract_v2', 'cms-calc-ret2-v2', 'status_dictionary_v2', 'cms-return-status-v2', 'fp_v2', 'cms-return-fp-v2',
    'close_report_v2', 'cms-close-report-v2',
    'paths', (SELECT jsonb_object_agg(ok.path, jsonb_build_object('ok', ok.ok, 'rpcs', (SELECT jsonb_agg(r.fn ORDER BY r.fn) FROM r WHERE r.path = ok.path)))
                FROM ok)
             )
$$;

CREATE OR REPLACE FUNCTION public.cms__stage_contract(p_run_id uuid, p_part text, p_chunk_no integer, p_rows jsonb)
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
     OR (p_part = 'return_lines' AND COALESCE(v_run.returns_policy, 'sales_only_v1') NOT IN ('net_returns_v1', 'full_line_qty_refund_v1')) THEN
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
                WHERE public.cms__return_status_effect_v(v_run.status_dictionary_version, x.return_status) IS NULL) THEN
      RAISE EXCEPTION 'CMS_RETURN_STATUS_UNKNOWN' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_return_lines (run_id, program_id, return_event_id, seq, return_status, status_effect, return_document_id,
      return_code, recorded_at, original_order_line_id, original_order_id, product_id, return_base_quantity, return_gmv_amount,
      original_completed_at, original_order_type, original_order_status, original_seller_email, original_pos_code,
      original_base_quantity, original_gmv_amount, original_quantity_src, original_uom_src, original_quantity_src_flag,
      original_uom_src_flag, source_updated_at, disposition, sale_ref_line_id, returns_policy)
    SELECT p_run_id, v_run.program_id, x.return_event_id, x.seq::integer, x.return_status,
           public.cms__return_status_effect_v(v_run.status_dictionary_version, x.return_status), x.return_document_id, x.return_code, x.recorded_at::timestamptz,
           x.original_order_line_id, x.original_order_id, x.product_id, x.return_base_quantity::numeric,
           x.return_gmv_amount::numeric, x.original_completed_at::timestamptz, x.original_order_type, x.original_order_status,
           x.original_seller_email, x.original_pos_code, x.original_base_quantity::numeric, x.original_gmv_amount::numeric,
           x.original_quantity_src, x.original_uom_src, x.original_quantity_src_flag, x.original_uom_src_flag,
           x.source_updated_at::timestamptz, x.disposition, x.sale_ref_line_id, v_run.returns_policy
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

CREATE OR REPLACE FUNCTION public.cms__seal_begin_contract(p_run_id uuid, p_expect jsonb)
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
  v_net := v_run.returns_policy IN ('net_returns_v1', 'full_line_qty_refund_v1');  -- 132: run đọc trả (cùng khoá pin / totals)
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

CREATE OR REPLACE FUNCTION public.cms__seal_contract_step(p_run_id uuid, p_step integer)
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
  v_full  boolean;  -- 132: Q-236 full_line_qty_refund_v1
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
  v_net  := v_run.returns_policy IN ('net_returns_v1', 'full_line_qty_refund_v1');
  v_full := v_run.returns_policy = 'full_line_qty_refund_v1';
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
                 (v_full AND (src.order_id, src.product_id, src.completed_at, src.order_type, src.order_status)
                             IS DISTINCT FROM (rl.original_order_id, rl.product_id, rl.original_completed_at, rl.original_order_type,
                                               rl.original_order_status))
                 OR (NOT v_full AND (
                 (src.order_id, src.product_id, src.completed_at, src.order_type, src.order_status, src.seller_email, src.pos_code,
                  src.base_quantity, src.gmv_amount)
                 IS DISTINCT FROM
                 (rl.original_order_id, rl.product_id, rl.original_completed_at, rl.original_order_type, rl.original_order_status,
                  rl.original_seller_email, rl.original_pos_code, rl.original_base_quantity, rl.original_gmv_amount)
                 OR (v_unit AND (src.quantity_src, src.uom_src, src.quantity_src_flag, src.uom_src_flag)
                                IS DISTINCT FROM (rl.original_quantity_src, rl.original_uom_src, rl.original_quantity_src_flag,
                                                  rl.original_uom_src_flag))))), false) AS ctx_bad
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
                   WHERE NOT v_full AND acc.rb > sl.base_quantity
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
                      sl.user_id, sl.program_product_id, sl.quantity_class, sl.base_quantity AS sb, sl.eligible_base AS se,
                      row_number() OVER (PARTITION BY rl.sale_ref_line_id
                                         ORDER BY rl.recorded_at, rl.return_event_id COLLATE "C") AS rn
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
             IS DISTINCT FROM (r.sale_ref_line_id, r.user_id, r.program_product_id, r.quantity_class,
                               CASE WHEN v_full THEN CASE WHEN r.rn = 1 THEN -r.sb ELSE 0 END ELSE -r.return_base_quantity END,
                               CASE WHEN v_full THEN CASE WHEN r.rn = 1 THEN -r.se ELSE 0 END
                                    WHEN r.quantity_class IN ('POS_BASE', 'COUNTED') THEN -r.return_base_quantity ELSE 0 END,
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
             CASE WHEN v_full THEN COALESCE((SELECT sum(sl.base_quantity) FROM public.cms_sales_lines sl
                                              WHERE sl.run_id = p_run_id AND sl.order_line_id IN (
                                                SELECT x.sale_ref_line_id FROM public.cms_return_lines x
                                                 WHERE x.run_id = p_run_id AND x.disposition = 'APPLIED')), 0)
                  ELSE COALESCE(sum(return_base_quantity) FILTER (WHERE disposition = 'APPLIED'), 0) END AS rb,
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

CREATE OR REPLACE FUNCTION public.cms__as_of_floor(p_program_id uuid)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT GREATEST(
    (SELECT max(e.returns_as_of) FROM public.cms_return_ledger_evals e WHERE e.program_id = p_program_id),
    (SELECT max(b.recorded_at) FROM public.cms_return_baselines b WHERE b.program_id = p_program_id),
    (SELECT max(GREATEST(r.returns_as_of, (r.seal_expect -> 'pin' ->> 'as_of')::timestamptz))
       FROM public.cms_sync_runs r
      WHERE r.program_id = p_program_id AND r.kind = 'sales' AND r.calc_contract_version IS NOT NULL
        AND r.returns_policy IN ('net_returns_v1', 'full_line_qty_refund_v1') AND (r.returns_as_of IS NOT NULL OR r.seal_expect IS NOT NULL)));
$$;

CREATE OR REPLACE FUNCTION public.cms__ledger_eval_guard()
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
              AND r.sealed_at IS NOT NULL AND r.seal_step = 13 AND r.returns_policy IN ('net_returns_v1', 'full_line_qty_refund_v1')
              AND r.returns_as_of = NEW.returns_as_of AND r.returns_digest = NEW.returns_digest AND r.config_version = NEW.config_version))
     OR (NEW.kind = 'report' AND v_prog.status IS DISTINCT FROM 'locked') THEN
    RAISE EXCEPTION 'CMS_LEDGER_EVAL_BIND' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.cms__publish_contract(p_run_id uuid)
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
  v_fpv   text;  -- 132: version vân tay sổ theo policy run
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
  v_net := v_run.returns_policy IN ('net_returns_v1', 'full_line_qty_refund_v1');
  v_fpv := CASE WHEN v_run.returns_policy = 'full_line_qty_refund_v1' THEN 'cms-return-fp-v2' ELSE 'cms-return-fp-v1' END;
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
    WHEN v_net AND v_prog.returns_policy IS DISTINCT FROM v_run.returns_policy THEN 'CONFIG_CHANGED'
    -- 132: sổ một version / chương trình (fp v1 ≠ v2 ⇒ so sánh vô nghĩa) — không xảy ra qua RPC, chặn phòng thủ.
    WHEN v_net AND EXISTS (SELECT 1 FROM public.cms_return_baselines b WHERE b.program_id = v_pid AND b.fp_version <> v_fpv)
      THEN 'CMS_RETURN_LEDGER_VERSION'
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
             'fp', CASE WHEN r.status_effect = 'EFFECTIVE' THEN public.cms__return_fp(v_fpv, v_pid, r.return_event_id,
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
    SELECT v_pid, r.return_event_id, v_fpv,
           public.cms__return_fp(v_fpv, v_pid, r.return_event_id, r.return_document_id, r.original_order_line_id,
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

CREATE OR REPLACE FUNCTION public.rpc_cms_sales_run_open(p_program_id uuid, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_prog public.cms_programs%ROWTYPE;
  v_snap jsonb;
  v_id   uuid;
  v_sch  smallint;  -- 124
  v_ct   boolean;   -- 130: run contract
  v_cv   text;      -- 132: hợp đồng run theo policy (full_line ⇒ cms-calc-ret2-v2)
  v_sdv  text;      -- 132: từ điển trạng thái theo policy
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
  v_cv := CASE WHEN v_prog.returns_policy = 'full_line_qty_refund_v1' THEN 'cms-calc-ret2-v2' ELSE 'cms-calc-ret2-v1' END;
  v_sdv := CASE WHEN v_prog.returns_policy = 'full_line_qty_refund_v1' THEN 'cms-return-status-v2' ELSE 'cms-return-status-v1' END;
  INSERT INTO public.cms_sync_runs (kind, program_id, config_version, is_test, mapping_fp, detail, quantity_basis,
    quantity_policy_version, returns_policy, calc_contract_version, unit_key_version, status_dictionary_version)
  VALUES ('sales', p_program_id, v_prog.config_version, v_prog.is_test, v_snap ->> 'mapping_fp', p_detail,
          CASE WHEN v_ct THEN v_prog.quantity_basis END,
          CASE WHEN v_ct THEN CASE v_prog.quantity_basis WHEN 'pos_base' THEN 'pos_base_v1' WHEN 'cms_unit' THEN 'cms_unit_v2' END END,
          CASE WHEN v_ct THEN v_prog.returns_policy END, CASE WHEN v_ct THEN v_cv END,
          CASE WHEN v_ct THEN 'cms-unit-key-v2' END, CASE WHEN v_ct THEN v_sdv END)
  RETURNING id, source_schema INTO v_id, v_sch;
  -- Worker không khai đúng hợp đồng (app cũ / cờ OFF) trên chương trình contract ⇒ VẪN có run (vết), đóng held ngay; pointer giữ.
  -- 132: worker hợp lệ khi khai đúng hợp đồng (`calc_contract`, 130) HOẶC liệt kê nó trong `calc_contracts` (mảng). App v1-only trên
  -- chương trình full_line ⇒ held, không tự tính theo v1.
  IF v_ct AND p_detail ->> 'calc_contract' IS DISTINCT FROM v_cv
     AND NOT COALESCE(jsonb_typeof(p_detail -> 'calc_contracts') = 'array' AND p_detail -> 'calc_contracts' ? v_cv, false) THEN
    UPDATE public.cms_sync_runs SET status = 'held', finished_at = now(), error_code = 'CMS_WORKER_UNSUPPORTED' WHERE id = v_id;
    RETURN jsonb_build_object('run_id', v_id, 'held', true, 'error_code', 'CMS_WORKER_UNSUPPORTED');
  END IF;
  -- 124: capability lớp nguồn = giá trị THỰC của run vừa INSERT (DEFAULT 1 sau 124) — app không tự suy.
  RETURN v_snap || jsonb_build_object('run_id', v_id, 'source_schema', v_sch,
                                      'calc_contract_version', CASE WHEN v_ct THEN v_cv END);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_result_header_v2(p_program_id uuid)
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
    'ledger', CASE WHEN v_su AND v_prog.returns_policy IN ('net_returns_v1', 'full_line_qty_refund_v1') THEN jsonb_build_object(
      'baselines', (SELECT count(*) FROM public.cms_return_baselines b WHERE b.program_id = p_program_id),
      'open_conflicts', (SELECT count(*) FROM public.cms_return_conflicts c WHERE c.program_id = p_program_id
                            AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id)),
      'latest_eval_seq', (SELECT max(e.eval_seq) FROM public.cms_return_ledger_evals e WHERE e.program_id = p_program_id)) END);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_return_close_reports(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin() OR NOT COALESCE(p_program_id = ANY (public.cms_readable_program_ids()), false) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('program_id', p_program_id, 'reports', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', r.id, 'payout_run_id', r.payout_run_id, 'eval_seq', r.eval_seq,
                                        'returns_as_of', public.cms__ts(r.returns_as_of), 'frozen_amount', r.frozen_amount::text,
                                        'recomputed_amount', r.recomputed_amount::text, 'delta_amount', r.delta_amount::text,
                                        'return_events', r.return_events, 'line_count', r.line_count, 'created_via', r.created_via, 'returns_profile', r.returns_profile,
                                        'created_by', r.created_by, 'created_by_name', (SELECT u.full_name FROM public.users u WHERE u.id = r.created_by),
                                        'manual_reason', r.manual_reason,
                                        'created_at', public.cms__ts(r.created_at)) ORDER BY r.eval_seq DESC)
      FROM public.cms_return_close_reports r WHERE r.program_id = p_program_id), '[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_return_close_report(p_report_id uuid, p_after integer, p_limit integer)
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
      'frozen_return_base', q.frozen_return_base::text, 'frozen_return_gmv', q.frozen_return_gmv::text,
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
      'return_events', v_r.return_events, 'line_count', v_r.line_count, 'created_via', v_r.created_via, 'returns_profile', v_r.returns_profile,
      'created_by', v_r.created_by, 'created_by_name', (SELECT u.full_name FROM public.users u WHERE u.id = v_r.created_by),
      'manual_reason', v_r.manual_reason,
      'created_at', public.cms__ts(v_r.created_at), 'not_a_payment_order', true),
    'lines', v_rows, 'next_after', v_next);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_return_close_report_events(p_report_id uuid, p_after text, p_limit integer)
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
                                              'base', q.base::text, 'qty_effect', q.qty_effect::text, 'pre_lock', q.pre_lock, 'refund', q.refund::text, 'recorded_at', public.cms__ts(q.recorded_at))
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

CREATE OR REPLACE FUNCTION public.cms__run_source_check(p_run_id uuid)
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
  -- 132 r3: phép gộp theo run thay EXISTS (quét toàn bảng ở ca thường) — cùng nghĩa, xem chú thích generator.
  IF COALESCE((SELECT bool_or(pp.id IS NULL OR s.completed_at < v_from OR s.completed_at >= v_to)
                 FROM public.cms_sales_source_lines s
                 LEFT JOIN public.cms_program_products pp ON pp.program_id = v_run.program_id AND pp.product_id = s.product_id
                WHERE s.run_id = p_run_id), false) THEN
    RETURN 'SOURCE_SCOPE';
  END IF;
  -- Mọi dòng engine có dòng nguồn TRÙNG trường thô và là OFFLINE / COMPLETED.
  -- 132 r3: phép gộp theo run thay EXISTS — cùng nghĩa.
  IF COALESCE((SELECT bool_or(s.order_line_id IS NULL OR s.order_type <> 'OFFLINE' OR s.order_status <> 'COMPLETED'
                             OR s.order_id <> e.order_id OR s.order_code <> e.order_code OR s.product_id <> e.product_id
                             OR s.seller_email IS DISTINCT FROM e.seller_email OR s.pos_code IS DISTINCT FROM e.pos_code
                             OR s.completed_at <> e.completed_at OR s.source_updated_at <> e.source_updated_at
                             OR s.quantity_raw IS DISTINCT FROM e.quantity_raw OR s.uom_raw IS DISTINCT FROM e.uom_raw
                             OR s.base_quantity <> e.base_quantity OR s.gmv_amount <> e.gmv_amount)
                 FROM public.cms_sales_lines e
                 LEFT JOIN public.cms_sales_source_lines s ON s.run_id = e.run_id AND s.order_line_id = e.order_line_id
                WHERE e.run_id = p_run_id), false) THEN
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

CREATE OR REPLACE FUNCTION public.cms__attest_eval(p_program_id uuid, p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a    public.cms_source_attestations%ROWTYPE;
  v_run  public.cms_sync_runs%ROWTYPE;
  v_prog public.cms_programs%ROWTYPE;
  v_code text;
  v_unit boolean;  -- 132 r2: run tính theo đơn vị CMS ⇒ bộ decision_unit14
BEGIN
  SELECT * INTO v_a FROM public.cms_source_attestations
   WHERE run_id = p_run_id AND program_id = p_program_id AND revoked_at IS NULL AND superseded_by IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('code', 'NONE'); END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id;
  -- Kiểm lại MỌI trường quyết định của dòng chứng nhận (phòng dòng owner ghi thẳng — db-reviewer r2 P2-3).
  v_code := CASE
    -- 132: run contract có hợp đồng đã biết dùng chứng nhận nguồn như run legacy (lớp nguồn 14 trường 124, source_schema = 1;
    -- cms__run_source_check bên dưới kiểm lại lớp nguồn ↔ lớp bán); version lạ ⇒ không dùng được. Bộ trường theo cách tính: cuối hàm.
    WHEN v_run.calc_contract_version IS NOT NULL AND v_run.calc_contract_version NOT IN ('cms-calc-ret2-v1', 'cms-calc-ret2-v2') THEN 'CONTRACT_UNSUPPORTED'
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
  -- Phòng thủ (PM COMP-P1-1; 132 r2 Q-238 b): bằng chứng = ĐÚNG bộ trường quyết định của cách tính run (bộ ba version cố định) —
  -- pos_base / legacy ⇒ decision10, cms_unit ⇒ decision_unit14; vân tay luôn tính lại từ lớp nguồn DB theo đúng bộ đó.
  v_unit := v_run.quantity_basis IS NOT DISTINCT FROM 'cms_unit';
  IF v_code IS NULL AND (v_a.field_set, v_a.fp_version, v_a.tool_version)
                        NOT IN (('decision10', 'cms-rows-fp-v1', 'cms-i4-compare-v1'), ('decision_unit14', 'cms-rows-fp-v2', 'cms-i4-compare-v2')) THEN
    v_code := 'FIELD_SET';
  END IF;
  IF v_code IS NULL AND v_a.field_set IS DISTINCT FROM (CASE WHEN v_unit THEN 'decision_unit14' ELSE 'decision10' END) THEN
    v_code := 'FIELD_SET_BASIS';
  END IF;
  IF v_code IS NULL AND v_unit THEN v_code := public.cms__run_unit_check(p_run_id, true); END IF;
  IF v_code IS NULL AND (CASE WHEN v_unit THEN public.cms__run_unit_fp(p_run_id) ELSE public.cms__run_source_fp(p_run_id, 'decision10') END)
                        IS DISTINCT FROM v_a.run_rows_fp THEN
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
  v_ct       boolean := false;  -- 132 r1: run hiện hành là run contract
  v_rp       boolean := false;  -- 132 r1: run contract đọc trả
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
    -- 132 r1 (Q-237): chốt được run contract có hợp đồng đã biết (cms-calc-ret2-v1 / v2) — payout = số RÒNG đã seal (phiếu trả trước chốt
    -- đã trừ; báo cáo sau chốt không trừ lại); version lạ ⇒ chặn. Chế độ chương trình phải khớp căn cứ của run hiện hành (legacy =
    -- pos_base + sales_only_v1): đổi chế độ mà pointer còn run cũ ⇒ chặn, không chốt số tính theo chế độ khác chế độ đang công bố.
    v_ct := v_run.calc_contract_version IS NOT NULL;
    v_rp := v_ct AND v_run.returns_policy IS DISTINCT FROM 'sales_only_v1';
    IF v_ct AND v_run.calc_contract_version NOT IN ('cms-calc-ret2-v1', 'cms-calc-ret2-v2') THEN
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
    -- 132 r1: run đọc trả ⇒ snapshot trả cũng sau mốc sớm nhất (không chốt số ròng thiếu phiếu cuối kỳ); sổ của run sạch VÀ mọi baseline
    -- của chương trình là phiếu hiệu lực trong run — sổ đổi sau công bố ⇒ chặn, không chốt số ròng lệch sổ. r3 (PM 20/11 S2): kiểm theo TẬP
    -- ở cms__ledger_drift (enable_nestloop = off) — probe từng baseline từng chọn index (run_id, seq) khi thống kê chưa biết run ⇒ quét
    -- lại cả run mỗi baseline (đo 1,7 s ở 4.750 phiếu, bậc hai theo số phiếu).
    IF v_rp AND (v_run.returns_as_of IS NULL OR v_run.returns_as_of < v_earliest) THEN
      v_b := array_append(v_b, 'CMS_LOCK_RETURNS_TOO_EARLY');
    END IF;
    IF v_ct AND (v_run.ledger_verdict IS DISTINCT FROM 'CLEAN'
                 OR public.cms__ledger_drift(v_prog.id, v_run.id)) THEN
      v_b := array_append(v_b, 'CMS_LOCK_LEDGER_DRIFT');
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
    IF NOT v_ct THEN
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
    ELSE
      -- 132 r1: run contract — 5 bảng (+ phiếu trả khi đọc trả) + số khối / Σ row_count = seal_expect; không có cms_result_lines; Σ tiền
      -- sự kiện = tổng run (seal N8). Thiếu / thừa dòng sau seal ⇒ TOTAL_MISMATCH.
      SELECT (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'sales_lines')::bigint
         AND (SELECT count(*) FROM public.cms_results WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'results')::bigint
         AND (SELECT count(*) FROM public.cms_result_catalog WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'catalog')::bigint
         AND (SELECT count(*) FROM public.cms_result_events WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'result_events')::bigint
         AND (SELECT count(*) FROM public.cms_sales_source_lines WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'source_lines')::bigint
         AND (NOT v_rp OR (SELECT count(*) FROM public.cms_return_lines WHERE run_id = v_run.id)
                          = (v_run.seal_expect ->> 'return_lines')::bigint)
         AND NOT EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = v_run.id)
         AND NOT EXISTS (
           SELECT 1 FROM unnest(ARRAY['sales_lines', 'results', 'catalog', 'result_events', 'source_lines']
                                || CASE WHEN v_rp THEN ARRAY['return_lines'] ELSE ARRAY[]::text[] END) k(part)
             LEFT JOIN (SELECT ch.part, count(*) AS n, sum(ch.row_count) AS rows FROM public.cms_sync_run_chunks ch
                         WHERE ch.run_id = v_run.id GROUP BY ch.part) x ON x.part = k.part
            WHERE COALESCE(x.n, 0) IS DISTINCT FROM (v_run.seal_expect -> 'chunks' ->> k.part)::bigint
               OR COALESCE(x.rows, 0) IS DISTINCT FROM (v_run.seal_expect ->> k.part)::bigint)
         AND (SELECT COALESCE(sum(e.amount_vnd), 0) FROM public.cms_result_events e WHERE e.run_id = v_run.id) = v_run.amount_vnd::numeric
        INTO v_sealed_ok;
    END IF;
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
    'contract', CASE WHEN v_ct THEN public.cms__run_contract(v_run.id) END,  -- 132 r1
    'blockers', to_jsonb(v_b));
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_program_lock(p_program_id uuid, p_expected_run_id uuid, p_expected_policy_version integer,
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
    run_started_at, source_complete_basis, source_complete_through, locked_by, source_attestation_id, calc_contract_version,
    quantity_basis, returns_policy, returns_as_of, returns_digest, ledger_eval_seq)
  VALUES (p_program_id, v_run.id, v_run.config_version, public.cms__config_fp(p_program_id), v_run.mapping_fp, v_run.is_test,
    v_run.amount_vnd, (v_ev ->> 'staff_rows')::integer, (v_ev ->> 'staff_paid')::integer, (v_ev ->> 'candidate_lines')::integer,
    (v_ev ->> 'candidate_gmv')::numeric, (v_ev ->> 'unassigned_lines')::integer, (v_ev ->> 'unassigned_gmv')::numeric,
    v_ev -> 'policy', (v_ev ->> 'policy_version')::integer, v_ack, v_run.started_at, v_ev ->> 'source_complete_basis',
    (v_ev ->> 'source_complete_through')::date, p_actor,
    CASE WHEN (v_ev ->> 'source_complete_basis') = 'operator_reconciliation' THEN (v_ev -> 'source_attestation' ->> 'id')::uuid END,
    -- 132 r1: hợp đồng của run chốt (NULL ⇔ legacy) — payout = số RÒNG đã seal; snapshot trả / sổ của run ghi kèm (đối chiếu sau chốt).
    v_run.calc_contract_version, v_run.quantity_basis, v_run.returns_policy, v_run.returns_as_of, v_run.returns_digest, v_run.ledger_eval_seq);
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
     OR (v_run.calc_contract_version IS NOT NULL
         AND v_sum <> (SELECT COALESCE(sum(e.amount_vnd), 0) FROM public.cms_result_events e WHERE e.run_id = v_run.id))
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
                            'source_attestation_id', v_ev -> 'source_attestation' ->> 'id',
                            'calc_contract_version', v_run.calc_contract_version);
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
    -- 132 r1: lần chốt run contract ⇒ số là RÒNG đã seal (phiếu trả tới mốc dữ liệu đã trừ); phiếu sau chốt chỉ ở báo cáo sau chốt.
    'contract', CASE WHEN v_pay.calc_contract_version IS NOT NULL THEN jsonb_build_object(
      'calc_contract_version', v_pay.calc_contract_version, 'quantity_basis', v_pay.quantity_basis, 'returns_policy', v_pay.returns_policy,
      'returns_as_of', public.cms__ts(v_pay.returns_as_of)) END,
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
         'run_started_at', public.cms__ts(v_pay.run_started_at),
         -- 132 r1: tổng trả ĐÃ TRỪ trong số chốt (run contract đọc trả) — đối chiếu XLSX; không chi tiết phiếu / người.
         'returns', CASE WHEN v_pay.returns_as_of IS NOT NULL THEN (SELECT jsonb_build_object(
             'return_count', COALESCE(sum(r.return_count), 0), 'return_gmv', COALESCE(sum(r.return_gmv), 0)::text,
             'eligible_return_base', COALESCE(sum(r.eligible_return_base), 0)::text)
             FROM public.cms_results r WHERE r.run_id = v_pay.run_id) END) ELSE '{}'::jsonb END;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cms_frozen_sales_lines(p_program_id uuid, p_after_seq integer, p_limit integer)
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
      'disposition', q.disposition, 'unassigned_reason', q.unassigned_reason,
      'quantity_class', q.quantity_class, 'eligible_base', q.eligible_base::text) ORDER BY q.seq), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT * FROM public.cms_sales_lines sl WHERE sl.run_id = v_pay.run_id AND sl.seq > COALESCE(p_after_seq, -1)
           ORDER BY sl.seq LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'seq')::integer;
  END IF;
  RETURN jsonb_build_object('program_id', p_program_id, 'payout_run_id', v_pay.run_id, 'payout_amount_vnd', v_pay.amount_vnd::text,
                            'contract', public.cms__run_contract(v_pay.run_id), 'rows', v_rows, 'next_after_seq', v_next,
                            -- 132 r1: profile báo cáo ĐÃ GHIM (một profile / chương trình — report_save chặn trộn); null = chưa có báo cáo
                            -- ⇒ job không tự chọn (PM r0 §3.1).
                            -- ORDER BY (db-reviewer r1 P2): report_save đã ép một profile / chương trình; báo cáo ĐẦU là nguồn ghim, tất định.
                            'report_profile', (SELECT r.returns_profile FROM public.cms_return_close_reports r
                                                WHERE r.program_id = p_program_id ORDER BY r.created_at, r.id LIMIT 1));
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
  v_unit  boolean;  -- 132 r2: run tính theo đơn vị CMS ⇒ bộ decision_unit14
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
     -- PM COMP-P1-1 + 132 r2 (Q-238 b): ĐÚNG MỘT trong hai bộ có version; audit14 / trộn version bị từ chối trước mọi khoá / ghi.
     OR NOT public.cms__str(p_payload, 'fp_version', '^cms-rows-fp-v[12]$')
     OR NOT public.cms__str(p_payload, 'field_set', '^(decision10|decision_unit14)$')
     OR (p_payload ->> 'field_set', p_payload ->> 'fp_version', p_payload ->> 'tool_version') NOT IN (('decision10', 'cms-rows-fp-v1', 'cms-i4-compare-v1'), ('decision_unit14', 'cms-rows-fp-v2', 'cms-i4-compare-v2'))
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
     OR NOT public.cms__str(p_payload, 'tool_version', '^cms-i4-compare-v[12]$')
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
  -- 132 r2 (Q-238 b): bộ trường phải đúng cách tính của run (cms_unit ⇒ decision_unit14 — có chuỗi THÔ q / u + cờ; pos_base / legacy ⇒
  -- decision10). Run cms_unit: lớp nguồn có thô, raw = làm sạch(thô), lớp bán trùng thô / cờ, phân loại / E tính lại khớp seal N1.
  v_unit := v_run.quantity_basis IS NOT DISTINCT FROM 'cms_unit';
  IF (p_payload ->> 'field_set') IS DISTINCT FROM (CASE WHEN v_unit THEN 'decision_unit14' ELSE 'decision10' END) THEN
    RAISE EXCEPTION 'CMS_ATTEST_BASIS_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF v_unit THEN
    v_code := public.cms__run_unit_check(p_run_id, true);
    IF v_code IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE = 'CMS_ATTEST_' || v_code, ERRCODE = 'P0001'; END IF;
  END IF;
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
  IF (p_payload ->> 'run_rows_fp') <> (CASE WHEN v_unit THEN public.cms__run_unit_fp(p_run_id)
                                             ELSE public.cms__run_source_fp(p_run_id, 'decision10') END) THEN
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
           'source_updated_at', public.cms__ts(q.source_updated_at),
           -- 132 r2 (Q-238 b): chuỗi THÔ q / u + cờ — đầu vào phân loại cms_unit (bộ decision_unit14).
           'quantity_src', q.quantity_src, 'quantity_src_flag', q.quantity_src_flag, 'uom_src', q.uom_src,
           'uom_src_flag', q.uom_src_flag) ORDER BY q.order_line_id COLLATE "C"), '[]'::jsonb),
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

-- ── ACL: thu hồi đích danh rồi cấp đúng ma trận (gate ACL — áp cả hàm OR REPLACE) ──
REVOKE ALL ON FUNCTION public.cms__return_status_effect_v(text,text),
  public.cms__report_rows2(text,jsonb),
  public.cms__close_report_save(uuid,uuid,jsonb,uuid,text,uuid),
  public.rpc_cms_return_close_report_save_super(uuid,uuid,jsonb,text,uuid),
  public.cms__run_unit_fp_text(uuid),
  public.cms__run_unit_fp(uuid),
  public.cms__run_unit_check(uuid,boolean),
  public.cms__close_report_scan(uuid,uuid,text,jsonb,text,boolean,boolean,timestamp with time zone,timestamp with time zone,timestamp with time zone),
  public.cms__ledger_drift(uuid,uuid),
  public.cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone),
  public.cms__programs_basis_guard(),
  public.rpc_cms_program_set_returns_policy(uuid,text,integer,uuid),
  public.rpc_cms_capabilities(),
  public.cms__stage_contract(uuid,text,integer,jsonb),
  public.cms__seal_begin_contract(uuid,jsonb),
  public.cms__seal_contract_step(uuid,integer),
  public.cms__as_of_floor(uuid),
  public.cms__ledger_eval_guard(),
  public.cms__publish_contract(uuid),
  public.rpc_cms_sales_run_open(uuid,jsonb),
  public.rpc_cms_result_header_v2(uuid),
  public.rpc_cms_return_close_reports(uuid),
  public.rpc_cms_return_close_report(uuid,integer,integer),
  public.rpc_cms_return_close_report_events(uuid,text,integer),
  public.cms__run_source_check(uuid),
  public.cms__attest_eval(uuid,uuid),
  public.cms__lock_eval(uuid,uuid,integer,text,boolean),
  public.rpc_cms_program_lock(uuid,uuid,integer,uuid,text,uuid),
  public.rpc_cms_payout(uuid),
  public.rpc_cms_frozen_sales_lines(uuid,integer,integer),
  public.rpc_cms_return_close_report_save(uuid,uuid,jsonb),
  public.rpc_cms_source_attest(uuid,uuid,jsonb,uuid),
  public.rpc_cms_run_source_export(uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_return_close_report_save_super(uuid,uuid,jsonb,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_program_set_returns_policy(uuid,text,integer,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_capabilities() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_sales_run_open(uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_result_header_v2(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_return_close_reports(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_return_close_report(uuid,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_return_close_report_events(uuid,text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_program_lock(uuid,uuid,integer,uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_payout(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_frozen_sales_lines(uuid,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_return_close_report_save(uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_source_attest(uuid,uuid,jsonb,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_run_source_export(uuid,uuid,text,integer) TO authenticated;
-- Thu hồi mọi grant khác owner do default privileges cấp (bài học SEC-1 / 091 / 117 / 120–131), trừ đúng ma trận.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, a.grantee
      FROM (VALUES ('cms__return_status_effect_v(text,text)', NULL::text), ('cms__report_rows2(text,jsonb)', NULL), ('cms__close_report_save(uuid,uuid,jsonb,uuid,text,uuid)', NULL), ('rpc_cms_return_close_report_save_super(uuid,uuid,jsonb,text,uuid)', 'authenticated:EXECUTE'), ('cms__run_unit_fp_text(uuid)', NULL), ('cms__run_unit_fp(uuid)', NULL), ('cms__run_unit_check(uuid,boolean)', NULL), ('cms__close_report_scan(uuid,uuid,text,jsonb,text,boolean,boolean,timestamp with time zone,timestamp with time zone,timestamp with time zone)', NULL), ('cms__ledger_drift(uuid,uuid)', NULL), ('cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone)', NULL), ('cms__programs_basis_guard()', NULL), ('rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)', 'service_role:EXECUTE'), ('rpc_cms_capabilities()', 'authenticated:EXECUTE,service_role:EXECUTE'), ('cms__stage_contract(uuid,text,integer,jsonb)', NULL), ('cms__seal_begin_contract(uuid,jsonb)', NULL), ('cms__seal_contract_step(uuid,integer)', NULL), ('cms__as_of_floor(uuid)', NULL), ('cms__ledger_eval_guard()', NULL), ('cms__publish_contract(uuid)', NULL), ('rpc_cms_sales_run_open(uuid,jsonb)', 'service_role:EXECUTE'), ('rpc_cms_result_header_v2(uuid)', 'authenticated:EXECUTE'), ('rpc_cms_return_close_reports(uuid)', 'authenticated:EXECUTE'), ('rpc_cms_return_close_report(uuid,integer,integer)', 'authenticated:EXECUTE'), ('rpc_cms_return_close_report_events(uuid,text,integer)', 'authenticated:EXECUTE'), ('cms__run_source_check(uuid)', NULL), ('cms__attest_eval(uuid,uuid)', NULL), ('cms__lock_eval(uuid,uuid,integer,text,boolean)', NULL), ('rpc_cms_program_lock(uuid,uuid,integer,uuid,text,uuid)', 'service_role:EXECUTE'), ('rpc_cms_payout(uuid)', 'authenticated:EXECUTE'), ('rpc_cms_frozen_sales_lines(uuid,integer,integer)', 'service_role:EXECUTE'), ('rpc_cms_return_close_report_save(uuid,uuid,jsonb)', 'service_role:EXECUTE'), ('rpc_cms_source_attest(uuid,uuid,jsonb,uuid)', 'authenticated:EXECUTE'), ('rpc_cms_run_source_export(uuid,uuid,text,integer)', 'authenticated:EXECUTE')) AS m(sig, want)
      JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure('public.' || m.sig)
     CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE a.grantee <> p.proowner
       AND NOT (a.grantee <> 0 AND pg_catalog.pg_get_userbyid(a.grantee) || ':' || a.privilege_type = ANY (string_to_array(COALESCE(m.want, ''), ',')))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', r.fn, CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) END);
  END LOOP;
END $$;

-- ── Hậu kiểm trong transaction (lệch ⇒ RAISE ⇒ rollback cả migration) ─────
DO $$
DECLARE
  v_bad text;
  v_cap jsonb;
BEGIN
  SELECT string_agg(m.sig, ' ') INTO v_bad
    FROM (VALUES ('cms__return_status_effect_v(text,text)', NULL::text), ('cms__report_rows2(text,jsonb)', NULL), ('cms__close_report_save(uuid,uuid,jsonb,uuid,text,uuid)', NULL), ('rpc_cms_return_close_report_save_super(uuid,uuid,jsonb,text,uuid)', 'authenticated:EXECUTE'), ('cms__run_unit_fp_text(uuid)', NULL), ('cms__run_unit_fp(uuid)', NULL), ('cms__run_unit_check(uuid,boolean)', NULL), ('cms__close_report_scan(uuid,uuid,text,jsonb,text,boolean,boolean,timestamp with time zone,timestamp with time zone,timestamp with time zone)', NULL), ('cms__ledger_drift(uuid,uuid)', NULL), ('cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone)', NULL), ('cms__programs_basis_guard()', NULL), ('rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)', 'service_role:EXECUTE'), ('rpc_cms_capabilities()', 'authenticated:EXECUTE,service_role:EXECUTE'), ('cms__stage_contract(uuid,text,integer,jsonb)', NULL), ('cms__seal_begin_contract(uuid,jsonb)', NULL), ('cms__seal_contract_step(uuid,integer)', NULL), ('cms__as_of_floor(uuid)', NULL), ('cms__ledger_eval_guard()', NULL), ('cms__publish_contract(uuid)', NULL), ('rpc_cms_sales_run_open(uuid,jsonb)', 'service_role:EXECUTE'), ('rpc_cms_result_header_v2(uuid)', 'authenticated:EXECUTE'), ('rpc_cms_return_close_reports(uuid)', 'authenticated:EXECUTE'), ('rpc_cms_return_close_report(uuid,integer,integer)', 'authenticated:EXECUTE'), ('rpc_cms_return_close_report_events(uuid,text,integer)', 'authenticated:EXECUTE'), ('cms__run_source_check(uuid)', NULL), ('cms__attest_eval(uuid,uuid)', NULL), ('cms__lock_eval(uuid,uuid,integer,text,boolean)', NULL), ('rpc_cms_program_lock(uuid,uuid,integer,uuid,text,uuid)', 'service_role:EXECUTE'), ('rpc_cms_payout(uuid)', 'authenticated:EXECUTE'), ('rpc_cms_frozen_sales_lines(uuid,integer,integer)', 'service_role:EXECUTE'), ('rpc_cms_return_close_report_save(uuid,uuid,jsonb)', 'service_role:EXECUTE'), ('rpc_cms_source_attest(uuid,uuid,jsonb,uuid)', 'authenticated:EXECUTE'), ('rpc_cms_run_source_export(uuid,uuid,text,integer)', 'authenticated:EXECUTE')) AS m(sig, want)
   WHERE to_regprocedure('public.' || m.sig) IS NULL
      OR has_function_privilege('anon', to_regprocedure('public.' || m.sig), 'EXECUTE')
      OR has_function_privilege('authenticated', to_regprocedure('public.' || m.sig), 'EXECUTE') IS DISTINCT FROM (COALESCE(m.want, '') LIKE '%authenticated:EXECUTE%')
      OR has_function_privilege('service_role', to_regprocedure('public.' || m.sig), 'EXECUTE') IS DISTINCT FROM (COALESCE(m.want, '') LIKE '%service_role:EXECUTE%')
      -- proconfig NULL (hàm thiếu SET) ⇒ biểu thức NULL ⇒ phải coi là lệch (COALESCE — db-reviewer r2 vòng 2 N1).
      OR NOT COALESCE((SELECT p.prosecdef AND 'search_path=public' = ANY (COALESCE(p.proconfig, '{}'::text[]))
                         FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.' || m.sig)), false)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
                  WHERE p.oid = to_regprocedure('public.' || m.sig) AND a.grantee <> p.proowner
                    AND NOT (a.grantee <> 0 AND pg_catalog.pg_get_userbyid(a.grantee) || ':' || a.privilege_type = ANY (string_to_array(COALESCE(m.want, ''), ','))));
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION '132 hậu kiểm ACL lệch: %', v_bad; END IF;
  -- Năng lực: 5 đường cũ + đường mới full_line đều ok; khoá version cũ giữ nguyên (app cũ so tuyệt đối).
  v_cap := public.rpc_cms_capabilities();
  IF (v_cap ->> 'calc_contract', v_cap ->> 'status_dictionary', v_cap ->> 'fp', v_cap ->> 'calc_contract_v2', v_cap ->> 'status_dictionary_v2',
      v_cap ->> 'fp_v2', v_cap ->> 'close_report_v2')
     IS DISTINCT FROM ('cms-calc-ret2-v1', 'cms-return-status-v1', 'cms-return-fp-v1', 'cms-calc-ret2-v2', 'cms-return-status-v2',
                       'cms-return-fp-v2', 'cms-close-report-v2')
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['program_modes', 'contract_run', 'readers_v2', 'returns_ledger', 'close_report', 'full_line',
                                           'lock_contract', 'manual_report', 'unit_attest']) p
                 WHERE (v_cap -> 'paths' -> p ->> 'ok') IS DISTINCT FROM 'true') THEN
    RAISE EXCEPTION '132 hậu kiểm: rpc_cms_capabilities lệch (%)', v_cap;
  END IF;
  -- Không đổi dữ liệu chương trình / run.
  IF EXISTS (SELECT 1 FROM public.cms_programs WHERE returns_policy = 'full_line_qty_refund_v1')
     OR EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE calc_contract_version = 'cms-calc-ret2-v2')
     OR EXISTS (SELECT 1 FROM public.cms_payouts WHERE calc_contract_version IS NOT NULL) THEN
    RAISE EXCEPTION '132 hậu kiểm: có dữ liệu full_line / chốt contract ngay sau migrate';
  END IF;
  -- r2 (Q-238 b) — kiểm NĂNG LỰC (không tìm chuỗi BASIS_UNSUPPORTED): ràng buộc bộ ba version; văn bản vân tay v2 của run rỗng = đúng
  -- header; kiểm unit của run không tồn tại = RUN_NOT_FOUND; chưa có chứng nhận decision_unit14 nào. Ràng buộc vắng ⇒ NULL ⇒ coi là lệch
  -- (COALESCE — db-reviewer r2 P2-4).
  IF COALESCE((SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = 'public.cms_source_attestations'::regclass AND c.conname = 'cms_source_attest_version')
       NOT LIKE '%decision10%cms-rows-fp-v1%cms-i4-compare-v1%decision_unit14%cms-rows-fp-v2%cms-i4-compare-v2%', true)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'public.cms_source_attestations'::regclass
                 AND c.conname IN ('cms_source_attestations_fp_version_check', 'cms_source_attestations_field_set_check',
                                   'cms_source_attestations_tool_version_check')) THEN
    RAISE EXCEPTION '132 hậu kiểm: ràng buộc version chứng nhận lệch';
  END IF;
  IF public.cms__run_unit_fp_text('00000000-0000-0000-0000-000000000000'::uuid) IS DISTINCT FROM
       'cms-rows-fp-v2' || E'\n' || 'order_line_id,order_id,order_code,product_id,seller_email,order_type,order_status,completed_at_us,'
       || 'base_quantity_e9,gmv_amount_e9,quantity_src,quantity_src_flag,uom_src,uom_src_flag' || E'\n'
     OR public.cms__run_unit_check('00000000-0000-0000-0000-000000000000'::uuid, true) IS DISTINCT FROM 'RUN_NOT_FOUND'
     OR EXISTS (SELECT 1 FROM public.cms_source_attestations WHERE field_set <> 'decision10') THEN
    RAISE EXCEPTION '132 hậu kiểm: chứng nhận cms_unit (vân tay v2 / kiểm unit) lệch';
  END IF;
END $$;
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__return_status_effect_v(text,text)')) IS DISTINCT FROM 'c101bef4406d837a7581e750574f5258'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__report_rows2(text,jsonb)')) IS DISTINCT FROM '2a07aa22f808a53b250ac83dd9598229'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__close_report_save(uuid,uuid,jsonb,uuid,text,uuid)')) IS DISTINCT FROM '1e790435c079b5136409926ede28aa7a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_report_save_super(uuid,uuid,jsonb,text,uuid)')) IS DISTINCT FROM '919dd05be25e3c13b60916b1ad6be8e9'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__run_unit_fp_text(uuid)')) IS DISTINCT FROM '14a7639aa8bc96d15e1131bd8a9dea12'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__run_unit_fp(uuid)')) IS DISTINCT FROM 'fe54c89548265e8f987db13979c00379'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__run_unit_check(uuid,boolean)')) IS DISTINCT FROM '82da20fd808671c1b59d902e3f2a88c0'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__close_report_scan(uuid,uuid,text,jsonb,text,boolean,boolean,timestamp with time zone,timestamp with time zone,timestamp with time zone)')) IS DISTINCT FROM '9ee69601ec2cd45bb8aa4e789c4ce886'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__ledger_drift(uuid,uuid)')) IS DISTINCT FROM 'de91626103a6ff7abd967a21f3b4d558'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone)')) IS DISTINCT FROM '1f5bd57ca7c2d471a0872e37c7d9924e'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__programs_basis_guard()')) IS DISTINCT FROM 'f3877584efe51679d18dc1e8c1f78cb0'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)')) IS DISTINCT FROM '305d7220038cbf9ad67cae2450c6c295'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_capabilities()')) IS DISTINCT FROM 'fc33f935097d0b7260c43ccde19b040a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__stage_contract(uuid,text,integer,jsonb)')) IS DISTINCT FROM '199be7ea7c82b5d77181df5ff27ccbe6'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__seal_begin_contract(uuid,jsonb)')) IS DISTINCT FROM '7ed765e0311c8c1bf3c483e46b5fe68a'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__seal_contract_step(uuid,integer)')) IS DISTINCT FROM '1dc57858869b903f564502d0128e1d50'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__as_of_floor(uuid)')) IS DISTINCT FROM '762adaa57e94038a764080241aff3dfc'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__ledger_eval_guard()')) IS DISTINCT FROM 'c8725a0983d998bd18debe65a3085204'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__publish_contract(uuid)')) IS DISTINCT FROM '2770feebcaadeaffe12471067eda2600'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_open(uuid,jsonb)')) IS DISTINCT FROM 'afe4cc5c332d609e63eb814e8a508d16'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_result_header_v2(uuid)')) IS DISTINCT FROM 'f6f165bbd543176d5f9b84ce3e0e4ab9'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_reports(uuid)')) IS DISTINCT FROM '7c420f93e670dbd39b7dc124d2755eb9'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_report(uuid,integer,integer)')) IS DISTINCT FROM 'a01636ba6266f62f35b49d3e8fc49b22'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_report_events(uuid,text,integer)')) IS DISTINCT FROM 'e9b9f5a6d725582b6f2b0343ffc49c20'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__run_source_check(uuid)')) IS DISTINCT FROM '3008ef2405d62b3892d1c427ab401f6e'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__attest_eval(uuid,uuid)')) IS DISTINCT FROM '7bc32bfdb9108a1742cf0a16035a0f12'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__lock_eval(uuid,uuid,integer,text,boolean)')) IS DISTINCT FROM '168a02958d2c795785b1bae68daef0a3'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_program_lock(uuid,uuid,integer,uuid,text,uuid)')) IS DISTINCT FROM '64f029499a0bddf888d6eab9ef2cc2d9'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_payout(uuid)')) IS DISTINCT FROM 'd48d14e29204c7e23745da36e17952c9'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_frozen_sales_lines(uuid,integer,integer)')) IS DISTINCT FROM 'a41c5e813122394b95c7e6a541bcb4cb'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_return_close_report_save(uuid,uuid,jsonb)')) IS DISTINCT FROM '3dc6146723724b6361566853ecbdf299'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_source_attest(uuid,uuid,jsonb,uuid)')) IS DISTINCT FROM 'b563a72f7bac077749db8b4e109cdca8'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_run_source_export(uuid,uuid,text,integer)')) IS DISTINCT FROM '053502d863746f4640b61a78a13dc8df' THEN
    RAISE EXCEPTION '132 hậu kiểm: thân 33 hàm mới / thay lệch bản sinh (md5)';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('132', 'cms_returns_full_line', jsonb_build_object(
  'candidate', 'CMS-RETURNS-Q236 r2', 'new_functions', 9, 'replaced_functions', 24,
  'policy', 'full_line_qty_refund_v1', 'calc_contract', 'cms-calc-ret2-v2',
  'attest_sets', 'decision10/cms-rows-fp-v1, decision_unit14/cms-rows-fp-v2')::text);

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — operator / Dev chạy từng khối, bọc BEGIN READ ONLY; … COMMIT;) ──────────────────────────────
-- V0 (chạy TRƯỚC migration, lưu kết quả; chạy lại SAU — phải TRÙNG HỆT): version / pointer / trạng thái / policy mọi chương trình.
--   SELECT count(*) n, md5(string_agg(id::text || ':' || config_version || ':' || COALESCE(current_result_run_id::text, '-') || ':' || status
--          || ':' || returns_policy, ',' ORDER BY id)) h FROM public.cms_programs;
-- V0b (chạy TRƯỚC, lưu): khối lượng bảng bị VALIDATE dưới khoá — ước thời gian cửa sổ.
--   SELECT (SELECT count(*) FROM public.cms_result_events) ev, (SELECT count(*) FROM public.cms_return_lines) rl,
--          (SELECT count(*) FROM public.cms_return_baselines) bl, (SELECT count(*) FROM public.cms_return_close_reports) rp;
-- V0c (TRƯỚC + SAU, lưu; db-reviewer r2 P2-6 / N2) chứng nhận còn hiệu lực trên run CONTRACT theo cách tính / bộ — kỳ vọng 0 dòng; có dòng ⇒ báo PM (sau 132: pos_base thành hợp lệ không qua duyệt lại, cms_unit + decision10 thành FIELD_SET_BASIS).
--   SELECT to_jsonb(r) ->> 'quantity_basis' qb, a.field_set fs, count(*) n FROM public.cms_source_attestations a JOIN public.cms_sync_runs r ON r.id = a.run_id
--    WHERE a.revoked_at IS NULL AND a.superseded_by IS NULL AND to_jsonb(r) ->> 'calc_contract_version' IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2;
-- V1 marker — 2 dòng: 131 cms_program_revision · 132 cms_returns_full_line.
--   SELECT version, name FROM public.app_migrations WHERE version IN ('131', '132') ORDER BY 1;
-- V2 ACL (gate AGENTS §4.2, lưu kết quả vào report) — n = 33 · anon_x = 0 · auth_x = 9 · svc_x = 6 · secdef = 33 · sp = 33.
--   SELECT count(*) n, count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE')) anon_x,
--          count(*) FILTER (WHERE has_function_privilege('authenticated', p.oid, 'EXECUTE')) auth_x,
--          count(*) FILTER (WHERE has_function_privilege('service_role', p.oid, 'EXECUTE')) svc_x,
--          count(*) FILTER (WHERE p.prosecdef) secdef, count(*) FILTER (WHERE 'search_path=public' = ANY (p.proconfig)) sp
--     FROM pg_proc p WHERE p.oid IN (SELECT to_regprocedure('public.' || s) FROM unnest(ARRAY['cms__return_status_effect_v(text,text)', 'cms__report_rows2(text,jsonb)', 'cms__close_report_save(uuid,uuid,jsonb,uuid,text,uuid)', 'rpc_cms_return_close_report_save_super(uuid,uuid,jsonb,text,uuid)', 'cms__run_unit_fp_text(uuid)', 'cms__run_unit_fp(uuid)', 'cms__run_unit_check(uuid,boolean)', 'cms__close_report_scan(uuid,uuid,text,jsonb,text,boolean,boolean,timestamp with time zone,timestamp with time zone,timestamp with time zone)', 'cms__ledger_drift(uuid,uuid)', 'cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone)', 'cms__programs_basis_guard()', 'rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)', 'rpc_cms_capabilities()', 'cms__stage_contract(uuid,text,integer,jsonb)', 'cms__seal_begin_contract(uuid,jsonb)', 'cms__seal_contract_step(uuid,integer)', 'cms__as_of_floor(uuid)', 'cms__ledger_eval_guard()', 'cms__publish_contract(uuid)', 'rpc_cms_sales_run_open(uuid,jsonb)', 'rpc_cms_result_header_v2(uuid)', 'rpc_cms_return_close_reports(uuid)', 'rpc_cms_return_close_report(uuid,integer,integer)', 'rpc_cms_return_close_report_events(uuid,text,integer)', 'cms__run_source_check(uuid)', 'cms__attest_eval(uuid,uuid)', 'cms__lock_eval(uuid,uuid,integer,text,boolean)', 'rpc_cms_program_lock(uuid,uuid,integer,uuid,text,uuid)', 'rpc_cms_payout(uuid)', 'rpc_cms_frozen_sales_lines(uuid,integer,integer)', 'rpc_cms_return_close_report_save(uuid,uuid,jsonb)', 'rpc_cms_source_attest(uuid,uuid,jsonb,uuid)', 'rpc_cms_run_source_export(uuid,uuid,text,integer)']) s);
-- V3 năng lực — paths.full_line / lock_contract / manual_report / unit_attest .ok = true · 5 đường cũ (danh sách RPC) và khoá v1 giữ nguyên.
--   SELECT public.rpc_cms_capabilities();
-- V4 dữ liệu ngay sau migrate — prog_fl = 0 · run_v2 = 0 · rl_non_net = 0 · rp_non_net = 0 · bl_v2 = 0.
--   SELECT (SELECT count(*) FROM public.cms_programs WHERE returns_policy = 'full_line_qty_refund_v1') prog_fl,
--          (SELECT count(*) FROM public.cms_sync_runs WHERE calc_contract_version = 'cms-calc-ret2-v2') run_v2,
--          (SELECT count(*) FROM public.cms_return_lines WHERE returns_policy <> 'net_returns_v1') rl_non_net,
--          (SELECT count(*) FROM public.cms_return_close_reports WHERE returns_profile <> 'net_returns_v1') rp_non_net,
--          (SELECT count(*) FROM public.cms_return_baselines WHERE fp_version = 'cms-return-fp-v2') bl_v2;
-- V5 ràng buộc mới — 9 dòng.
--   SELECT conname FROM pg_constraint WHERE conname IN ('cms_sync_runs_policy_bind', 'cms_return_lines_policy_fk',
--          'cms_return_close_reports_versions', 'cms_return_close_report_events_qty', 'cms_payouts_contract_shape',
--          'cms_payouts_contract_run_fk', 'cms_return_close_reports_manual', 'cms_return_close_reports_request_uniq',
--          'cms_return_close_report_events_pre_lock') ORDER BY 1;
-- V6 lõi báo cáo kiểm trạng thái theo từ điển của profile; wrapper cron gọi lõi — v1_call = false · v2_call = true · cron_wrap = true.
--   SELECT position('cms__return_status_effect(x.return_status)' IN prosrc) > 0 v1_call,
--          position('cms__return_status_effect_v(v_dict, x.return_status)' IN prosrc) > 0 v2_call,
--          (SELECT position('cms__close_report_save(' IN q.prosrc) > 0 FROM pg_proc q
--            WHERE q.oid = 'public.rpc_cms_return_close_report_save(uuid,uuid,jsonb)'::regprocedure) cron_wrap
--     FROM pg_proc WHERE oid = 'public.cms__close_report_save(uuid,uuid,jsonb,uuid,text,uuid)'::regprocedure;
-- V7 (r1) ngay sau migrate — payout_ct = 0 · rp_manual = 0 · line_ct = 0 · ev_pre = 0.
--   SELECT (SELECT count(*) FROM public.cms_payouts WHERE calc_contract_version IS NOT NULL) payout_ct,
--          (SELECT count(*) FROM public.cms_return_close_reports WHERE manual_reason IS NOT NULL) rp_manual,
--          (SELECT count(*) FROM public.cms_return_close_report_lines WHERE frozen_return_base IS NOT NULL) line_ct,
--          (SELECT count(*) FROM public.cms_return_close_report_events WHERE pre_lock IS NOT NULL) ev_pre;
-- V8 (r2) chứng nhận theo cách tính — kiểm NĂNG LỰC (không tìm chuỗi): unit_ok = true · c_ver = 1 · c_old = 0 · hdr_ok = true · probe = RUN_NOT_FOUND · att_u14 = 0.
--   SELECT (public.rpc_cms_capabilities() #>> '{paths,unit_attest,ok}') = 'true' unit_ok,
--          (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.cms_source_attestations'::regclass
--            AND conname = 'cms_source_attest_version') c_ver,
--          (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.cms_source_attestations'::regclass
--            AND conname IN ('cms_source_attestations_fp_version_check', 'cms_source_attestations_field_set_check',
--                            'cms_source_attestations_tool_version_check')) c_old,
--          public.cms__run_unit_fp_text('00000000-0000-0000-0000-000000000000'::uuid)
--            = 'cms-rows-fp-v2' || E'\n' || 'order_line_id,order_id,order_code,product_id,seller_email,order_type,order_status,completed_at_us,'
--              || 'base_quantity_e9,gmv_amount_e9,quantity_src,quantity_src_flag,uom_src,uom_src_flag' || E'\n' hdr_ok,
--          public.cms__run_unit_check('00000000-0000-0000-0000-000000000000'::uuid, true) probe,
--          (SELECT count(*) FROM public.cms_source_attestations WHERE field_set = 'decision_unit14') att_u14;
-- V9 (r2, db-reviewer r2 P2-5) md5 thân hàm mới / thay SAU COMMIT (cùng danh sách + md5 với hậu kiểm trong transaction) — n = 33 · bad = 0.
--   SELECT count(*) n, count(*) FILTER (WHERE md5(replace(p.prosrc, E'\r', '')) IS DISTINCT FROM e.m) bad
--     FROM (VALUES ('cms__return_status_effect_v(text,text)', 'c101bef4406d837a7581e750574f5258'),
--            ('cms__report_rows2(text,jsonb)', '2a07aa22f808a53b250ac83dd9598229'),
--            ('cms__close_report_save(uuid,uuid,jsonb,uuid,text,uuid)', '1e790435c079b5136409926ede28aa7a'),
--            ('rpc_cms_return_close_report_save_super(uuid,uuid,jsonb,text,uuid)', '919dd05be25e3c13b60916b1ad6be8e9'),
--            ('cms__run_unit_fp_text(uuid)', '14a7639aa8bc96d15e1131bd8a9dea12'),
--            ('cms__run_unit_fp(uuid)', 'fe54c89548265e8f987db13979c00379'),
--            ('cms__run_unit_check(uuid,boolean)', '82da20fd808671c1b59d902e3f2a88c0'),
--            ('cms__close_report_scan(uuid,uuid,text,jsonb,text,boolean,boolean,timestamp with time zone,timestamp with time zone,timestamp with time zone)', '9ee69601ec2cd45bb8aa4e789c4ce886'),
--            ('cms__ledger_drift(uuid,uuid)', 'de91626103a6ff7abd967a21f3b4d558'),
--            ('cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone)', '1f5bd57ca7c2d471a0872e37c7d9924e'),
--            ('cms__programs_basis_guard()', 'f3877584efe51679d18dc1e8c1f78cb0'),
--            ('rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)', '305d7220038cbf9ad67cae2450c6c295'),
--            ('rpc_cms_capabilities()', 'fc33f935097d0b7260c43ccde19b040a'),
--            ('cms__stage_contract(uuid,text,integer,jsonb)', '199be7ea7c82b5d77181df5ff27ccbe6'),
--            ('cms__seal_begin_contract(uuid,jsonb)', '7ed765e0311c8c1bf3c483e46b5fe68a'),
--            ('cms__seal_contract_step(uuid,integer)', '1dc57858869b903f564502d0128e1d50'),
--            ('cms__as_of_floor(uuid)', '762adaa57e94038a764080241aff3dfc'),
--            ('cms__ledger_eval_guard()', 'c8725a0983d998bd18debe65a3085204'),
--            ('cms__publish_contract(uuid)', '2770feebcaadeaffe12471067eda2600'),
--            ('rpc_cms_sales_run_open(uuid,jsonb)', 'afe4cc5c332d609e63eb814e8a508d16'),
--            ('rpc_cms_result_header_v2(uuid)', 'f6f165bbd543176d5f9b84ce3e0e4ab9'),
--            ('rpc_cms_return_close_reports(uuid)', '7c420f93e670dbd39b7dc124d2755eb9'),
--            ('rpc_cms_return_close_report(uuid,integer,integer)', 'a01636ba6266f62f35b49d3e8fc49b22'),
--            ('rpc_cms_return_close_report_events(uuid,text,integer)', 'e9b9f5a6d725582b6f2b0343ffc49c20'),
--            ('cms__run_source_check(uuid)', '3008ef2405d62b3892d1c427ab401f6e'),
--            ('cms__attest_eval(uuid,uuid)', '7bc32bfdb9108a1742cf0a16035a0f12'),
--            ('cms__lock_eval(uuid,uuid,integer,text,boolean)', '168a02958d2c795785b1bae68daef0a3'),
--            ('rpc_cms_program_lock(uuid,uuid,integer,uuid,text,uuid)', '64f029499a0bddf888d6eab9ef2cc2d9'),
--            ('rpc_cms_payout(uuid)', 'd48d14e29204c7e23745da36e17952c9'),
--            ('rpc_cms_frozen_sales_lines(uuid,integer,integer)', 'a41c5e813122394b95c7e6a541bcb4cb'),
--            ('rpc_cms_return_close_report_save(uuid,uuid,jsonb)', '3dc6146723724b6361566853ecbdf299'),
--            ('rpc_cms_source_attest(uuid,uuid,jsonb,uuid)', 'b563a72f7bac077749db8b4e109cdca8'),
--            ('rpc_cms_run_source_export(uuid,uuid,text,integer)', '053502d863746f4640b61a78a13dc8df')) e(s, m)
--     LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure('public.' || e.s);
-- V9b (r2, db-reviewer r2 P2-6) chứng nhận còn hiệu lực theo cách tính run / bộ / mã eval — KHÔNG có dòng qb = cms_unit + decision10 (có ⇒ thu hồi, chứng nhận lại decision_unit14).
--   SELECT to_jsonb(r) ->> 'quantity_basis' qb, a.field_set fs, public.cms__attest_eval(a.program_id, a.run_id) ->> 'code' code, count(*) n
--     FROM public.cms_source_attestations a JOIN public.cms_sync_runs r ON r.id = a.run_id
--    WHERE a.revoked_at IS NULL AND a.superseded_by IS NULL GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
