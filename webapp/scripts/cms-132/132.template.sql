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
--   P3. Thay @@N_REPLACED@@ hàm có sẵn (thân vá neo, md5 nền ghim; nền 130, riêng rpc_cms_program_lock / rpc_cms_payout nền 124 vì 125–131
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
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (@@NEW_NAMES@@)) THEN
    RAISE EXCEPTION '132: đã có cột / hàm của 132 — DB không ở trạng thái nền 131';
  END IF;
  -- Ràng buộc nền 130 sẽ thay phải có đúng tên (định nghĩa kiểm ở khối dưới).
  FOR r IN SELECT x.rel, x.con FROM (VALUES @@CONSTRAINTS@@) AS x(rel, con) LOOP
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
  FOR r IN SELECT m.sig, m.want FROM (VALUES @@ACL_REPLACED@@) AS m(sig, want) LOOP
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
-- Thân @@N_REPLACED@@ hàm sắp thay phải đúng nguyên văn 130 (md5 thân bỏ CR — Studio lưu CRLF).
DO $$
BEGIN
  IF @@PREFLIGHT_MD5@@ THEN
    RAISE EXCEPTION '132 preflight: thân một trong @@N_REPLACED@@ hàm sắp thay KHÁC bản 130 đã duyệt (md5) — dừng, đối chiếu tay';
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
@@REPORT_ROWS2@@

-- ── P2b. Lưu báo cáo sau chốt (r1 — PM r0 P1-04) ────────────────────────────
-- r3 (PM 20/11 S2): bước 5 của lõi (suy từ dòng bán đã đóng băng) ở hàm SQL riêng, sinh từ thân lõi: dòng bán / phiếu của run đọc theo
-- TẬP (LEFT JOIN, PK duy nhất ⇒ ≤ 1 dòng khớp như LIMIT 1 / truy vấn con cũ) và SET enable_nestloop = off ⇒ chỉ hash / merge join — mỗi
-- bảng run MỘT lượt bất kể thống kê (thống kê chưa biết run mới từng làm probe từng phiếu chọn index (run_id, seq) ⇒ quét lại cả run mỗi
-- phiếu, 50–100 s ở 10.000 phiếu). Owner-only.
@@CLOSE_SCAN@@

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
@@CORE_BLOCKS@@

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
@@UNIT_CLASS_N1C@@
    IF v_code IS NOT NULL THEN RETURN 'UNIT_CLASS_HOLD'; END IF;
    IF v_bad THEN RETURN 'UNIT_CLASS'; END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- ── P3. Hàm thay (thân 130 / 124 vá theo neo) ───────────────────────────────
@@REPLACED_BLOCKS@@

-- ── ACL: thu hồi đích danh rồi cấp đúng ma trận (gate ACL — áp cả hàm OR REPLACE) ──
REVOKE ALL ON FUNCTION @@REVOKE_LIST@@ FROM PUBLIC, anon, authenticated, service_role;
@@GRANTS@@
-- Thu hồi mọi grant khác owner do default privileges cấp (bài học SEC-1 / 091 / 117 / 120–131), trừ đúng ma trận.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, a.grantee
      FROM (VALUES @@ACL_VALUES@@) AS m(sig, want)
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
    FROM (VALUES @@ACL_VALUES@@) AS m(sig, want)
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
@@POSTCHECK_MD5@@

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('132', 'cms_returns_full_line', jsonb_build_object(
  'candidate', 'CMS-RETURNS-Q236 r2', 'new_functions', @@N_NEW@@, 'replaced_functions', @@N_REPLACED@@,
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
-- V2 ACL (gate AGENTS §4.2, lưu kết quả vào report) — @@VERIFY_EXPECT@@.
--   SELECT count(*) n, count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE')) anon_x,
--          count(*) FILTER (WHERE has_function_privilege('authenticated', p.oid, 'EXECUTE')) auth_x,
--          count(*) FILTER (WHERE has_function_privilege('service_role', p.oid, 'EXECUTE')) svc_x,
--          count(*) FILTER (WHERE p.prosecdef) secdef, count(*) FILTER (WHERE 'search_path=public' = ANY (p.proconfig)) sp
--     FROM pg_proc p WHERE p.oid IN (SELECT to_regprocedure('public.' || s) FROM unnest(ARRAY[@@VERIFY_SIGS@@]) s);
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
-- V9 (r2, db-reviewer r2 P2-5) md5 thân hàm mới / thay SAU COMMIT (cùng danh sách + md5 với hậu kiểm trong transaction) — n = @@N_ALL@@ · bad = 0.
--   SELECT count(*) n, count(*) FILTER (WHERE md5(replace(p.prosrc, E'\r', '')) IS DISTINCT FROM e.m) bad
--     FROM (VALUES @@VERIFY_MD5@@) e(s, m)
--     LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure('public.' || e.s);
-- V9b (r2, db-reviewer r2 P2-6) chứng nhận còn hiệu lực theo cách tính run / bộ / mã eval — KHÔNG có dòng qb = cms_unit + decision10 (có ⇒ thu hồi, chứng nhận lại decision_unit14).
--   SELECT to_jsonb(r) ->> 'quantity_basis' qb, a.field_set fs, public.cms__attest_eval(a.program_id, a.run_id) ->> 'code' code, count(*) n
--     FROM public.cms_source_attestations a JOIN public.cms_sync_runs r ON r.id = a.run_id
--    WHERE a.revoked_at IS NULL AND a.superseded_by IS NULL GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
