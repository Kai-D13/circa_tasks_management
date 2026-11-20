#!/usr/bin/env node
// CMS 132 (Q-236 — profile full_line_qty_refund_v1; design Dev r1 planning/research/cms-returns-q236-design-r1-2026-11-18.md): SINH
// supabase/migrations/132_cms_returns_full_line.sql + rollback từ scripts/cms-132/132.template.sql + thân hàm 130 VÁ THEO NEO (mỗi neo
// khớp ĐÚNG số lần khai — split/join, không String.replace để không ăn `$$`). Rollback khôi phục NGUYÊN VĂN thân 130. KHÔNG sửa tay
// file sinh ra.
//   node scripts/gen-cms-132.mjs            # ghi 2 file, in sha256
//   node scripts/gen-cms-132.mjs --check    # chỉ so: file trên đĩa ≠ bản sinh ⇒ thoát 1
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cmsFunctionBodies } from './gen-cms-131.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
export const CMS_132_TEMPLATE = path.join(HERE, 'cms-132', '132.template.sql')
export const CMS_132_FILE = path.join(MIG, '132_cms_returns_full_line.sql')
export const CMS_132_ROLLBACK_FILE = path.join(MIG, 'rollback', '132_cms_returns_full_line_rollback.sql')
const SRC_130 = '130_cms_calculation_modes_returns.sql'
// r1 (Q-237): rpc_cms_program_lock / rpc_cms_payout — bản cuối ở 124 (125–131 không thay; preflight md5 kiểm trên DB).
const SRC_124 = '124_cms_source_attestation.sql'
const BOTH_RUN = `('cms-calc-ret2-v1', 'cms-calc-ret2-v2')`

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex')
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
function once(s, needle, value, n = 1) {
  const parts = s.split(needle)
  if (parts.length - 1 !== n) throw new Error(`neo xuất hiện ${parts.length - 1} lần (cần ${n}): ${needle.slice(0, 120)}`)
  return parts.join(value)
}

const FULL = `'full_line_qty_refund_v1'`
const BOTH = `('net_returns_v1', 'full_line_qty_refund_v1')`
// r2 (Q-238 b): hai bộ chứng nhận nguồn có version (field_set, fp_version, tool_version) — không trộn.
const ATT_V1 = `'decision10', 'cms-rows-fp-v1', 'cms-i4-compare-v1'`
const ATT_U2 = `'decision_unit14', 'cms-rows-fp-v2', 'cms-i4-compare-v2'`
// r2: cms__attest_eval (preview / chốt) có tính lại phân loại / E của run cms_unit không (true = có; bench quyết — design r2 §3).
export const CMS_132_EVAL_CLASS = true
const EVAL_CLASS = String(CMS_132_EVAL_CLASS)

/**
 * Hàm 130 thay bằng thân vá. `grant` = ma trận 130 (giữ nguyên). `edits` = [neo, thay, số lần (mặc định 1)]. `base` = md5 thân 130 bỏ CR
 * (ghim — generator kiểm lại từ file 130; preflight 132 so trên DB).
 */
export const CMS_132_REPLACED = Object.freeze([
  {
    name: 'cms__return_fp', grant: null,
    sig: 'cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone)',
    // v2 (Q-236): như v1 BỎ trường lượng; bắt buộc p_base IS NULL (một giá trị một nghĩa). Nhánh v1 giữ nguyên byte.
    edits: [[`  SELECT CASE WHEN p_version = 'cms-return-fp-v1' AND p_program_id IS NOT NULL AND p_return_event_id IS NOT NULL`,
      `  SELECT CASE WHEN p_version = 'cms-return-fp-v2' AND p_program_id IS NOT NULL AND p_return_event_id IS NOT NULL
                   AND p_return_document_id IS NOT NULL AND p_original_order_line_id IS NOT NULL AND p_original_order_id IS NOT NULL
                   AND p_product_id IS NOT NULL AND p_base IS NULL AND p_refund IS NOT NULL AND p_recorded_at IS NOT NULL
                   AND isfinite(p_recorded_at)
              THEN (SELECT encode(sha256(convert_to(string_agg(octet_length(f) || ':' || f, '' ORDER BY i), 'UTF8')), 'hex')
                      FROM unnest(ARRAY[p_version, p_program_id::text, p_return_event_id, p_return_document_id, p_original_order_line_id,
                                        p_original_order_id, p_product_id, trunc(p_refund * 1000000000, 0)::text,
                                        trunc(extract(epoch FROM p_recorded_at) * 1000000, 0)::text]) WITH ORDINALITY AS t(f, i))
              WHEN p_version = 'cms-return-fp-v1' AND p_program_id IS NOT NULL AND p_return_event_id IS NOT NULL`]],
  },
  {
    name: 'cms__programs_basis_guard', sig: 'cms__programs_basis_guard()', grant: null,
    edits: [
      [`    IF OLD.returns_policy = 'net_returns_v1' THEN
      RAISE EXCEPTION 'CMS_RETURNS_POLICY_REGRESSION' USING ERRCODE = 'P0001';`, `    -- 132: một chiều sales_only_v1 → net_returns_v1 / full_line_qty_refund_v1; rời policy trả (kể cả net ↔ full_line) ⇒ chặn.
    IF OLD.returns_policy <> 'sales_only_v1' THEN
      RAISE EXCEPTION 'CMS_RETURNS_POLICY_REGRESSION' USING ERRCODE = 'P0001';`],
      [`    IF NEW.returns_policy <> 'net_returns_v1' OR OLD.status NOT IN ('draft', 'active')`,
        `    IF NEW.returns_policy NOT IN ${BOTH} OR OLD.status NOT IN ('draft', 'active')`],
    ],
  },
  {
    name: 'rpc_cms_program_set_returns_policy', sig: 'rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)', grant: 'service_role:EXECUTE',
    edits: [
      [`  IF p_policy IS DISTINCT FROM 'net_returns_v1' THEN`, `  IF p_policy IS NULL OR p_policy NOT IN ${BOTH} THEN`],
      [`  IF v_prog.returns_policy = 'net_returns_v1' THEN
    RETURN jsonb_build_object('program_id', v_prog.id, 'returns_policy', v_prog.returns_policy, 'config_version', v_prog.config_version,
                              'already', true);
  END IF;`, `  IF v_prog.returns_policy = p_policy THEN
    RETURN jsonb_build_object('program_id', v_prog.id, 'returns_policy', v_prog.returns_policy, 'config_version', v_prog.config_version,
                              'already', true);
  END IF;
  -- 132: chỉ rời sales_only_v1; net_returns_v1 ↔ full_line_qty_refund_v1 không hỗ trợ (sổ / vân tay khác version).
  IF v_prog.returns_policy <> 'sales_only_v1' THEN
    RAISE EXCEPTION 'CMS_RETURNS_POLICY_REGRESSION' USING ERRCODE = 'P0001';
  END IF;`],
      [`     SET returns_policy = 'net_returns_v1', returns_policy_set_by = p_actor,`, `     SET returns_policy = p_policy, returns_policy_set_by = p_actor,`],
      [`  RETURN jsonb_build_object('program_id', p_program_id, 'returns_policy', 'net_returns_v1', 'config_version', v_prog.config_version + 1,`,
        `  RETURN jsonb_build_object('program_id', p_program_id, 'returns_policy', p_policy, 'config_version', v_prog.config_version + 1,`],
    ],
  },
  {
    name: 'rpc_cms_capabilities', sig: 'rpc_cms_capabilities()', grant: 'authenticated:EXECUTE,service_role:EXECUTE',
    edits: [
      [`    ('close_report', 'rpc_cms_return_close_report_events', 'public.rpc_cms_return_close_report_events(uuid,text,integer)', 'authenticated')
  ), i(path, sig) AS (VALUES`, `    ('close_report', 'rpc_cms_return_close_report_events', 'public.rpc_cms_return_close_report_events(uuid,text,integer)', 'authenticated'),
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
  ), i(path, sig) AS (VALUES`],
      [`    ('close_report', 'public.cms__report_rows(jsonb)')
  ), t(path, rel, col) AS (VALUES`, `    ('close_report', 'public.cms__report_rows(jsonb)'),
    ('full_line', 'public.cms__return_status_effect_v(text,text)'),
    ('full_line', 'public.cms__report_rows2(text,jsonb)'),
    ('lock_contract', 'public.cms__lock_eval(uuid,uuid,integer,text,boolean)'),
    ('lock_contract', 'public.cms__close_report_save(uuid,uuid,jsonb,uuid,text,uuid)'),
    ('manual_report', 'public.cms__close_report_save(uuid,uuid,jsonb,uuid,text,uuid)'),
    ('unit_attest', 'public.cms__run_unit_fp(uuid)'),
    ('unit_attest', 'public.cms__run_unit_check(uuid,boolean)')
  ), t(path, rel, col) AS (VALUES`],
      [`    ('close_report', 'cms_return_close_report_events', 'disposition')
  ), ok AS (`, `    ('close_report', 'cms_return_close_report_events', 'disposition'),
    ('full_line', 'cms_return_lines', 'returns_policy'), ('full_line', 'cms_return_close_reports', 'returns_profile'),
    ('full_line', 'cms_return_close_report_events', 'qty_effect'),
    ('lock_contract', 'cms_payouts', 'calc_contract_version'), ('lock_contract', 'cms_return_close_report_lines', 'frozen_return_base'),
    ('manual_report', 'cms_return_close_reports', 'manual_request'),
    ('unit_attest', 'cms_sales_source_lines', 'quantity_src')
  ), ok AS (`],
      [`             || jsonb_build_object('lock_contract', jsonb_build_object('ok', false, 'rpcs', '[]'::jsonb)))`,
        `             )`],
      [`'src_digest', 'cms-src-digest-v1', 'unit_key', 'cms-unit-key-v2', 'program_save', 2, 'readers', 2,`,
        `'src_digest', 'cms-src-digest-v1', 'unit_key', 'cms-unit-key-v2', 'program_save', 2, 'readers', 2,
    'calc_contract_v2', 'cms-calc-ret2-v2', 'status_dictionary_v2', 'cms-return-status-v2', 'fp_v2', 'cms-return-fp-v2',
    'close_report_v2', 'cms-close-report-v2',`],
    ],
  },
  {
    name: 'cms__stage_contract', sig: 'cms__stage_contract(uuid,text,integer,jsonb)', grant: null,
    edits: [
      [`     OR (p_part = 'return_lines' AND v_run.returns_policy IS DISTINCT FROM 'net_returns_v1') THEN`,
        `     OR (p_part = 'return_lines' AND COALESCE(v_run.returns_policy, 'sales_only_v1') NOT IN ${BOTH}) THEN`],
      [`                WHERE public.cms__return_status_effect(x.return_status) IS NULL) THEN`,
        `                WHERE public.cms__return_status_effect_v(v_run.status_dictionary_version, x.return_status) IS NULL) THEN`],
      [`      original_uom_src_flag, source_updated_at, disposition, sale_ref_line_id)
    SELECT p_run_id, v_run.program_id, x.return_event_id, x.seq::integer, x.return_status,
           public.cms__return_status_effect(x.return_status), x.return_document_id,`,
        `      original_uom_src_flag, source_updated_at, disposition, sale_ref_line_id, returns_policy)
    SELECT p_run_id, v_run.program_id, x.return_event_id, x.seq::integer, x.return_status,
           public.cms__return_status_effect_v(v_run.status_dictionary_version, x.return_status), x.return_document_id,`],
      [`           x.source_updated_at::timestamptz, x.disposition, x.sale_ref_line_id
      FROM jsonb_to_recordset(p_rows)`, `           x.source_updated_at::timestamptz, x.disposition, x.sale_ref_line_id, v_run.returns_policy
      FROM jsonb_to_recordset(p_rows)`],
    ],
  },
  {
    name: 'cms__seal_begin_contract', sig: 'cms__seal_begin_contract(uuid,jsonb)', grant: null,
    edits: [[`  v_net := v_run.returns_policy = 'net_returns_v1';`, `  v_net := v_run.returns_policy IN ${BOTH};  -- 132: run đọc trả (cùng khoá pin / totals)`]],
  },
  {
    name: 'cms__seal_contract_step', sig: 'cms__seal_contract_step(uuid,integer)', grant: null,
    edits: [
      [`  v_net   boolean;
  v_unit  boolean;`, `  v_net   boolean;
  v_unit  boolean;
  v_full  boolean;  -- 132: Q-236 full_line_qty_refund_v1`],
      [`  v_net  := v_run.returns_policy = 'net_returns_v1';`, `  v_net  := v_run.returns_policy IN ${BOTH};
  v_full := v_run.returns_policy = ${FULL};`],
      // N2 ngữ cảnh: full_line chỉ so 5 trường khoá (đơn / SP / ngày / loại / trạng thái đơn gốc) — người / POS / B / G / q·u từ snapshot.
      [`               COALESCE(src.order_line_id IS NOT NULL AND (
                 (src.order_id, src.product_id, src.completed_at, src.order_type, src.order_status, src.seller_email, src.pos_code,`,
        `               COALESCE(src.order_line_id IS NOT NULL AND (
                 (v_full AND (src.order_id, src.product_id, src.completed_at, src.order_type, src.order_status)
                             IS DISTINCT FROM (rl.original_order_id, rl.product_id, rl.original_completed_at, rl.original_order_type,
                                               rl.original_order_status))
                 OR (NOT v_full AND (
                 (src.order_id, src.product_id, src.completed_at, src.order_type, src.order_status, src.seller_email, src.pos_code,`],
      [`                                                  rl.original_uom_src_flag))), false) AS ctx_bad`,
        `                                                  rl.original_uom_src_flag))))), false) AS ctx_bad`],
      // N2 Σ lượng BI vượt B: không áp full_line (lượng BI không lưu; N3 ép Σ lượng = B_i).
      [`                   WHERE acc.rb > sl.base_quantity`, `                   WHERE NOT v_full AND acc.rb > sl.base_quantity`],
      // N3: full_line ⇒ phiếu đầu của dòng (recorded_at µs, rồi byte ID) mang −B_i / −E_i; phiếu sau 0; GMV −refund từng phiếu.
      [`         r AS (SELECT rl.return_event_id, rl.sale_ref_line_id, rl.recorded_at, rl.return_base_quantity, rl.return_gmv_amount,
                      sl.user_id, sl.program_product_id, sl.quantity_class`,
        `         r AS (SELECT rl.return_event_id, rl.sale_ref_line_id, rl.recorded_at, rl.return_base_quantity, rl.return_gmv_amount,
                      sl.user_id, sl.program_product_id, sl.quantity_class, sl.base_quantity AS sb, sl.eligible_base AS se,
                      row_number() OVER (PARTITION BY rl.sale_ref_line_id
                                         ORDER BY rl.recorded_at, rl.return_event_id COLLATE "C") AS rn`],
      [`             IS DISTINCT FROM (r.sale_ref_line_id, r.user_id, r.program_product_id, r.quantity_class, -r.return_base_quantity,
                               CASE WHEN r.quantity_class IN ('POS_BASE', 'COUNTED') THEN -r.return_base_quantity ELSE 0 END,`,
        `             IS DISTINCT FROM (r.sale_ref_line_id, r.user_id, r.program_product_id, r.quantity_class,
                               CASE WHEN v_full THEN CASE WHEN r.rn = 1 THEN -r.sb ELSE 0 END ELSE -r.return_base_quantity END,
                               CASE WHEN v_full THEN CASE WHEN r.rn = 1 THEN -r.se ELSE 0 END
                                    WHEN r.quantity_class IN ('POS_BASE', 'COUNTED') THEN -r.return_base_quantity ELSE 0 END,`],
      // N10: lượng trả áp dụng full_line = Σ B_i trên dòng KHÁC NHAU có phiếu APPLIED.
      [`             COALESCE(sum(return_base_quantity) FILTER (WHERE disposition = 'APPLIED'), 0) AS rb,`,
        `             CASE WHEN v_full THEN COALESCE((SELECT sum(sl.base_quantity) FROM public.cms_sales_lines sl
                                              WHERE sl.run_id = p_run_id AND sl.order_line_id IN (
                                                SELECT x.sale_ref_line_id FROM public.cms_return_lines x
                                                 WHERE x.run_id = p_run_id AND x.disposition = 'APPLIED')), 0)
                  ELSE COALESCE(sum(return_base_quantity) FILTER (WHERE disposition = 'APPLIED'), 0) END AS rb,`],
    ],
  },
  {
    name: 'cms__as_of_floor', sig: 'cms__as_of_floor(uuid)', grant: null,
    edits: [[`AND r.returns_policy = 'net_returns_v1' AND`, `AND r.returns_policy IN ${BOTH} AND`]],
  },
  {
    name: 'cms__ledger_eval_guard', sig: 'cms__ledger_eval_guard()', grant: null,
    edits: [[`AND r.seal_step = 13 AND r.returns_policy = 'net_returns_v1'`, `AND r.seal_step = 13 AND r.returns_policy IN ${BOTH}`]],
  },
  {
    name: 'cms__publish_contract', sig: 'cms__publish_contract(uuid)', grant: null,
    edits: [
      [`  v_new   bigint;
BEGIN`, `  v_new   bigint;
  v_fpv   text;  -- 132: version vân tay sổ theo policy run
BEGIN`],
      [`  v_net := v_run.returns_policy = 'net_returns_v1';`, `  v_net := v_run.returns_policy IN ${BOTH};
  v_fpv := CASE WHEN v_run.returns_policy = ${FULL} THEN 'cms-return-fp-v2' ELSE 'cms-return-fp-v1' END;`],
      [`    WHEN v_net AND v_prog.returns_policy IS DISTINCT FROM 'net_returns_v1' THEN 'CONFIG_CHANGED'`,
        `    WHEN v_net AND v_prog.returns_policy IS DISTINCT FROM v_run.returns_policy THEN 'CONFIG_CHANGED'
    -- 132: sổ một version / chương trình (fp v1 ≠ v2 ⇒ so sánh vô nghĩa) — không xảy ra qua RPC, chặn phòng thủ.
    WHEN v_net AND EXISTS (SELECT 1 FROM public.cms_return_baselines b WHERE b.program_id = v_pid AND b.fp_version <> v_fpv)
      THEN 'CMS_RETURN_LEDGER_VERSION'`],
      [`public.cms__return_fp('cms-return-fp-v1', v_pid, r.return_event_id,`, `public.cms__return_fp(v_fpv, v_pid, r.return_event_id,`, 2],
      [`    SELECT v_pid, r.return_event_id, 'cms-return-fp-v1',`, `    SELECT v_pid, r.return_event_id, v_fpv,`],
    ],
  },
  {
    name: 'rpc_cms_sales_run_open', sig: 'rpc_cms_sales_run_open(uuid,jsonb)', grant: 'service_role:EXECUTE',
    edits: [
      [`  v_ct   boolean;   -- 130: run contract`, `  v_ct   boolean;   -- 130: run contract
  v_cv   text;      -- 132: hợp đồng run theo policy (full_line ⇒ cms-calc-ret2-v2)
  v_sdv  text;      -- 132: từ điển trạng thái theo policy`],
      [`  v_ct := v_prog.quantity_basis <> 'pos_base' OR v_prog.returns_policy <> 'sales_only_v1';`,
        `  v_ct := v_prog.quantity_basis <> 'pos_base' OR v_prog.returns_policy <> 'sales_only_v1';
  v_cv := CASE WHEN v_prog.returns_policy = ${FULL} THEN 'cms-calc-ret2-v2' ELSE 'cms-calc-ret2-v1' END;
  v_sdv := CASE WHEN v_prog.returns_policy = ${FULL} THEN 'cms-return-status-v2' ELSE 'cms-return-status-v1' END;`],
      [`          CASE WHEN v_ct THEN v_prog.returns_policy END, CASE WHEN v_ct THEN 'cms-calc-ret2-v1' END,
          CASE WHEN v_ct THEN 'cms-unit-key-v2' END, CASE WHEN v_ct THEN 'cms-return-status-v1' END)`,
        `          CASE WHEN v_ct THEN v_prog.returns_policy END, CASE WHEN v_ct THEN v_cv END,
          CASE WHEN v_ct THEN 'cms-unit-key-v2' END, CASE WHEN v_ct THEN v_sdv END)`],
      [`  IF v_ct AND p_detail ->> 'calc_contract' IS DISTINCT FROM 'cms-calc-ret2-v1' THEN`,
        `  -- 132: worker hợp lệ khi khai đúng hợp đồng (\`calc_contract\`, 130) HOẶC liệt kê nó trong \`calc_contracts\` (mảng). App v1-only trên
  -- chương trình full_line ⇒ held, không tự tính theo v1.
  IF v_ct AND p_detail ->> 'calc_contract' IS DISTINCT FROM v_cv
     AND NOT COALESCE(jsonb_typeof(p_detail -> 'calc_contracts') = 'array' AND p_detail -> 'calc_contracts' ? v_cv, false) THEN`],
      [`                                      'calc_contract_version', CASE WHEN v_ct THEN 'cms-calc-ret2-v1' END);`,
        `                                      'calc_contract_version', CASE WHEN v_ct THEN v_cv END);`],
    ],
  },
  {
    name: 'rpc_cms_result_header_v2', sig: 'rpc_cms_result_header_v2(uuid)', grant: 'authenticated:EXECUTE',
    edits: [[`    'ledger', CASE WHEN v_su AND v_prog.returns_policy = 'net_returns_v1' THEN jsonb_build_object(`,
      `    'ledger', CASE WHEN v_su AND v_prog.returns_policy IN ${BOTH} THEN jsonb_build_object(`]],
  },
  {
    name: 'rpc_cms_return_close_reports', sig: 'rpc_cms_return_close_reports(uuid)', grant: 'authenticated:EXECUTE',
    // r1 (PM r0 P1-04): reader super trả người lập (phiên) + lý do lập tay — không trả khoá yêu cầu.
    edits: [[`'created_via', r.created_via,`, `'created_via', r.created_via, 'returns_profile', r.returns_profile,
                                        'created_by', r.created_by, 'created_by_name', (SELECT u.full_name FROM public.users u WHERE u.id = r.created_by),
                                        'manual_reason', r.manual_reason,`]],
  },
  {
    name: 'rpc_cms_return_close_report', sig: 'rpc_cms_return_close_report(uuid,integer,integer)', grant: 'authenticated:EXECUTE',
    edits: [[`'created_via', v_r.created_via,`, `'created_via', v_r.created_via, 'returns_profile', v_r.returns_profile,
      'created_by', v_r.created_by, 'created_by_name', (SELECT u.full_name FROM public.users u WHERE u.id = v_r.created_by),
      'manual_reason', v_r.manual_reason,`],
      // r1 (Q-237): dòng run contract mang phần trả ĐÃ TRỪ trong số chốt (NULL ⇔ legacy).
      [`'eligible_base', q.eligible_base::text,`, `'frozen_return_base', q.frozen_return_base::text, 'frozen_return_gmv', q.frozen_return_gmv::text,
      'eligible_base', q.eligible_base::text,`]],
  },
  {
    name: 'rpc_cms_return_close_report_events', sig: 'rpc_cms_return_close_report_events(uuid,text,integer)', grant: 'authenticated:EXECUTE',
    edits: [[`'base', q.base::text,`, `'base', q.base::text, 'qty_effect', q.qty_effect::text, 'pre_lock', q.pre_lock,`]],
  },
  // ── r1 (Q-237 / PM r0 §3.2): chốt run contract — preview → chốt → payout RÒNG đóng băng → báo cáo sau chốt đọc hợp đồng đóng băng ──
  {
    // r3 (PM 20/11 §1 chọn B / §4.1.2): kiểm lớp nguồn 124 theo RUN — hai kiểm EXISTS (SOURCE_SCOPE, SOURCE_ENGINE_MISMATCH) đổi thành
    // phép gộp trên đúng các dòng của run. EXISTS dừng sớm nên planner cược gặp dòng lệch sớm; ca thường không có dòng lệch ⇒ quét hết bảng
    // mọi run (đo r2: 0,7–1,0 s ở 1,8–2,0 triệu dòng, tăng theo cỡ bảng). COALESCE(bool_or(c), false) ≡ EXISTS(… WHERE c) (c NULL / run
    // rỗng ⇒ false như EXISTS; join nhân bản dòng không đổi kết quả). Mã SOURCE_*, thứ tự ưu tiên, xử lý NULL và đối chiếu hai lớp giữ
    // nguyên; hàm vẫn SET enable_nestloop = off (124). Rollback khôi phục NGUYÊN VĂN thân 124 (preflight md5 thân nền).
    name: 'cms__run_source_check', sig: 'cms__run_source_check(uuid)', grant: null, src: 124,
    edits: [
      [`  IF EXISTS (SELECT 1 FROM public.cms_sales_source_lines s
               LEFT JOIN public.cms_program_products pp ON pp.program_id = v_run.program_id AND pp.product_id = s.product_id
              WHERE s.run_id = p_run_id AND (pp.id IS NULL OR s.completed_at < v_from OR s.completed_at >= v_to)) THEN
    RETURN 'SOURCE_SCOPE';`,
      `  -- 132 r3: phép gộp theo run thay EXISTS (quét toàn bảng ở ca thường) — cùng nghĩa, xem chú thích generator.
  IF COALESCE((SELECT bool_or(pp.id IS NULL OR s.completed_at < v_from OR s.completed_at >= v_to)
                 FROM public.cms_sales_source_lines s
                 LEFT JOIN public.cms_program_products pp ON pp.program_id = v_run.program_id AND pp.product_id = s.product_id
                WHERE s.run_id = p_run_id), false) THEN
    RETURN 'SOURCE_SCOPE';`],
      [`  IF EXISTS (SELECT 1 FROM public.cms_sales_lines e
               LEFT JOIN public.cms_sales_source_lines s ON s.run_id = e.run_id AND s.order_line_id = e.order_line_id
              WHERE e.run_id = p_run_id
                AND (s.order_line_id IS NULL OR s.order_type <> 'OFFLINE' OR s.order_status <> 'COMPLETED'
                     OR s.order_id <> e.order_id OR s.order_code <> e.order_code OR s.product_id <> e.product_id
                     OR s.seller_email IS DISTINCT FROM e.seller_email OR s.pos_code IS DISTINCT FROM e.pos_code
                     OR s.completed_at <> e.completed_at OR s.source_updated_at <> e.source_updated_at
                     OR s.quantity_raw IS DISTINCT FROM e.quantity_raw OR s.uom_raw IS DISTINCT FROM e.uom_raw
                     OR s.base_quantity <> e.base_quantity OR s.gmv_amount <> e.gmv_amount)) THEN
    RETURN 'SOURCE_ENGINE_MISMATCH';`,
      `  -- 132 r3: phép gộp theo run thay EXISTS — cùng nghĩa.
  IF COALESCE((SELECT bool_or(s.order_line_id IS NULL OR s.order_type <> 'OFFLINE' OR s.order_status <> 'COMPLETED'
                             OR s.order_id <> e.order_id OR s.order_code <> e.order_code OR s.product_id <> e.product_id
                             OR s.seller_email IS DISTINCT FROM e.seller_email OR s.pos_code IS DISTINCT FROM e.pos_code
                             OR s.completed_at <> e.completed_at OR s.source_updated_at <> e.source_updated_at
                             OR s.quantity_raw IS DISTINCT FROM e.quantity_raw OR s.uom_raw IS DISTINCT FROM e.uom_raw
                             OR s.base_quantity <> e.base_quantity OR s.gmv_amount <> e.gmv_amount)
                 FROM public.cms_sales_lines e
                 LEFT JOIN public.cms_sales_source_lines s ON s.run_id = e.run_id AND s.order_line_id = e.order_line_id
                WHERE e.run_id = p_run_id), false) THEN
    RETURN 'SOURCE_ENGINE_MISMATCH';`],
    ],
  },
  {
    // db-reviewer r1 P1-1: 130 trả CONTRACT_UNSUPPORTED cho MỌI run contract ⇒ chương trình thật (completeness operator_reconciliation)
    // không bao giờ có basis ⇒ SOURCE_INCOMPLETE dù PM mở real.ready. Run contract mang source_schema = 1 + lớp nguồn đủ 14 trường 124
    // (stage 130 / 132) ⇒ decision10 / cms__run_source_check / vân tay định nghĩa như run legacy; chỉ version lạ còn bị chặn. Chứng nhận
    // chỉ phủ lớp BÁN; phiếu trả do RETURNS_TOO_EARLY + LEDGER_DRIFT (lock_eval r1) + seal N2 giữ.
    // db-reviewer r1 vòng 2 P2-1: decision10 (124 COMP-P1-1 = mọi trường QUYẾT ĐỊNH của pos_base) KHÔNG có quantity_raw / uom_raw — với
    // cms_unit hai trường này quyết định quantity_class / E ⇒ chứng nhận decision10 không ràng buộc số chi ⇒ fail-closed: run cms_unit
    // không dùng chứng nhận (mã BASIS_UNSUPPORTED ⇒ chương trình thật cms_unit: ATTEST_INVALID / SOURCE_INCOMPLETE).
    // r2 (PM 19/11 RET-R2-01, Q-238 b chốt "hoàn thiện cả hai"): bỏ BASIS_UNSUPPORTED; chứng nhận có VERSION theo cách tính của run —
    // pos_base / legacy ⇒ decision10 · cms-rows-fp-v1 · cms-i4-compare-v1 (nghĩa KHÔNG đổi); cms_unit ⇒ decision_unit14 · cms-rows-fp-v2 ·
    // cms-i4-compare-v2 (decision10 + chuỗi THÔ q / u + cờ — đúng đầu vào classify / seal N1). Lệch cách tính ⇒ FIELD_SET_BASIS; bộ lạ ⇒
    // FIELD_SET; run cms_unit còn qua cms__run_unit_check (thô ở lớp nguồn, lớp bán trùng thô / cờ, phân loại / E tính lại khớp).
    name: 'cms__attest_eval', sig: 'cms__attest_eval(uuid,uuid)', grant: null,
    edits: [
      [`    -- 130: chứng nhận đối soát decision10 chỉ định nghĩa cho run legacy (lớp nguồn / vân tay 124) ⇒ run contract không dùng được.
    WHEN v_run.calc_contract_version IS NOT NULL THEN 'CONTRACT_UNSUPPORTED'`,
      `    -- 132: run contract có hợp đồng đã biết dùng chứng nhận nguồn như run legacy (lớp nguồn 14 trường 124, source_schema = 1;
    -- cms__run_source_check bên dưới kiểm lại lớp nguồn ↔ lớp bán); version lạ ⇒ không dùng được. Bộ trường theo cách tính: cuối hàm.
    WHEN v_run.calc_contract_version IS NOT NULL AND v_run.calc_contract_version NOT IN ${BOTH_RUN} THEN 'CONTRACT_UNSUPPORTED'`],
      [`  v_code text;
BEGIN`, `  v_code text;
  v_unit boolean;  -- 132 r2: run tính theo đơn vị CMS ⇒ bộ decision_unit14
BEGIN`],
      [`  -- Phòng thủ (PM COMP-P1-1): chỉ decision10 là bằng chứng; vân tay luôn tính lại decision10 từ lớp nguồn DB.
  IF v_code IS NULL AND v_a.field_set IS DISTINCT FROM 'decision10' THEN v_code := 'FIELD_SET'; END IF;
  IF v_code IS NULL AND public.cms__run_source_fp(p_run_id, 'decision10') IS DISTINCT FROM v_a.run_rows_fp THEN
    v_code := 'FP_CHANGED';
  END IF;`, `  -- Phòng thủ (PM COMP-P1-1; 132 r2 Q-238 b): bằng chứng = ĐÚNG bộ trường quyết định của cách tính run (bộ ba version cố định) —
  -- pos_base / legacy ⇒ decision10, cms_unit ⇒ decision_unit14; vân tay luôn tính lại từ lớp nguồn DB theo đúng bộ đó.
  v_unit := v_run.quantity_basis IS NOT DISTINCT FROM 'cms_unit';
  IF v_code IS NULL AND (v_a.field_set, v_a.fp_version, v_a.tool_version)
                        NOT IN ((${ATT_V1}), (${ATT_U2})) THEN
    v_code := 'FIELD_SET';
  END IF;
  IF v_code IS NULL AND v_a.field_set IS DISTINCT FROM (CASE WHEN v_unit THEN 'decision_unit14' ELSE 'decision10' END) THEN
    v_code := 'FIELD_SET_BASIS';
  END IF;
  IF v_code IS NULL AND v_unit THEN v_code := public.cms__run_unit_check(p_run_id, ${EVAL_CLASS}); END IF;
  IF v_code IS NULL AND (CASE WHEN v_unit THEN public.cms__run_unit_fp(p_run_id) ELSE public.cms__run_source_fp(p_run_id, 'decision10') END)
                        IS DISTINCT FROM v_a.run_rows_fp THEN
    v_code := 'FP_CHANGED';
  END IF;`],
    ],
  },
  {
    name: 'cms__lock_eval', sig: 'cms__lock_eval(uuid,uuid,integer,text,boolean)', grant: null,
    edits: [
      [`  v_att_ok   boolean;                                       -- 124`, `  v_att_ok   boolean;                                       -- 124
  v_ct       boolean := false;  -- 132 r1: run hiện hành là run contract
  v_rp       boolean := false;  -- 132 r1: run contract đọc trả`],
      [`    -- 130: run contract chưa chốt được trong batch này (payout / payout_staff / XLSX chốt đọc lớp legacy) ⇒ chặn. Chế độ chương trình
    -- phải khớp căn cứ của run hiện hành (legacy = pos_base + sales_only_v1): đổi chế độ mà pointer còn run cũ ⇒ chặn, không chốt số
    -- tính theo chế độ khác chế độ đang công bố cho chương trình.
    IF v_run.calc_contract_version IS NOT NULL THEN
      v_b := array_append(v_b, 'CMS_LOCK_CONTRACT_UNSUPPORTED');
    END IF;`, `    -- 132 r1 (Q-237): chốt được run contract có hợp đồng đã biết (cms-calc-ret2-v1 / v2) — payout = số RÒNG đã seal (phiếu trả trước chốt
    -- đã trừ; báo cáo sau chốt không trừ lại); version lạ ⇒ chặn. Chế độ chương trình phải khớp căn cứ của run hiện hành (legacy =
    -- pos_base + sales_only_v1): đổi chế độ mà pointer còn run cũ ⇒ chặn, không chốt số tính theo chế độ khác chế độ đang công bố.
    v_ct := v_run.calc_contract_version IS NOT NULL;
    v_rp := v_ct AND v_run.returns_policy IS DISTINCT FROM 'sales_only_v1';
    IF v_ct AND v_run.calc_contract_version NOT IN ${BOTH_RUN} THEN
      v_b := array_append(v_b, 'CMS_LOCK_CONTRACT_UNSUPPORTED');
    END IF;`],
      [`    IF v_run.started_at < v_earliest THEN
      v_b := array_append(v_b, 'CMS_LOCK_RUN_TOO_EARLY');
    END IF;`, `    IF v_run.started_at < v_earliest THEN
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
    END IF;`],
      [`    SELECT (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'sales_lines')::bigint
       AND (SELECT count(*) FROM public.cms_results WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'results')::bigint
       AND (SELECT count(*) FROM public.cms_result_catalog WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'catalog')::bigint
       AND (SELECT count(*) FROM public.cms_result_lines WHERE run_id = v_run.id)`,
        `    IF NOT v_ct THEN
    SELECT (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'sales_lines')::bigint
       AND (SELECT count(*) FROM public.cms_results WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'results')::bigint
       AND (SELECT count(*) FROM public.cms_result_catalog WHERE run_id = v_run.id) = (v_run.seal_expect ->> 'catalog')::bigint
       AND (SELECT count(*) FROM public.cms_result_lines WHERE run_id = v_run.id)`],
      [`      INTO v_sealed_ok;`, `      INTO v_sealed_ok;
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
    END IF;`],
      [`    'blockers', to_jsonb(v_b));`, `    'contract', CASE WHEN v_ct THEN public.cms__run_contract(v_run.id) END,  -- 132 r1
    'blockers', to_jsonb(v_b));`],
    ],
  },
  {
    name: 'rpc_cms_program_lock', sig: 'rpc_cms_program_lock(uuid,uuid,integer,uuid,text,uuid)', grant: 'service_role:EXECUTE', src: 124,
    edits: [
      [`    run_started_at, source_complete_basis, source_complete_through, locked_by, source_attestation_id)`,
        `    run_started_at, source_complete_basis, source_complete_through, locked_by, source_attestation_id, calc_contract_version,
    quantity_basis, returns_policy, returns_as_of, returns_digest, ledger_eval_seq)`],
      [`    CASE WHEN (v_ev ->> 'source_complete_basis') = 'operator_reconciliation' THEN (v_ev -> 'source_attestation' ->> 'id')::uuid END);`,
        `    CASE WHEN (v_ev ->> 'source_complete_basis') = 'operator_reconciliation' THEN (v_ev -> 'source_attestation' ->> 'id')::uuid END,
    -- 132 r1: hợp đồng của run chốt (NULL ⇔ legacy) — payout = số RÒNG đã seal; snapshot trả / sổ của run ghi kèm (đối chiếu sau chốt).
    v_run.calc_contract_version, v_run.quantity_basis, v_run.returns_policy, v_run.returns_as_of, v_run.returns_digest, v_run.ledger_eval_seq);`],
      [`     OR v_n <> (v_ev ->> 'staff_rows')::integer OR v_paid <> (v_ev ->> 'staff_paid')::integer THEN`,
        `     OR (v_run.calc_contract_version IS NOT NULL
         AND v_sum <> (SELECT COALESCE(sum(e.amount_vnd), 0) FROM public.cms_result_events e WHERE e.run_id = v_run.id))
     OR v_n <> (v_ev ->> 'staff_rows')::integer OR v_paid <> (v_ev ->> 'staff_paid')::integer THEN`],
      [`                            'source_attestation_id', v_ev -> 'source_attestation' ->> 'id');`,
        `                            'source_attestation_id', v_ev -> 'source_attestation' ->> 'id',
                            'calc_contract_version', v_run.calc_contract_version);`],
    ],
  },
  {
    name: 'rpc_cms_payout', sig: 'rpc_cms_payout(uuid)', grant: 'authenticated:EXECUTE', src: 124,
    edits: [
      [`    'policy_version', v_pay.policy_version,`, `    'policy_version', v_pay.policy_version,
    -- 132 r1: lần chốt run contract ⇒ số là RÒNG đã seal (phiếu trả tới mốc dữ liệu đã trừ); phiếu sau chốt chỉ ở báo cáo sau chốt.
    'contract', CASE WHEN v_pay.calc_contract_version IS NOT NULL THEN jsonb_build_object(
      'calc_contract_version', v_pay.calc_contract_version, 'quantity_basis', v_pay.quantity_basis, 'returns_policy', v_pay.returns_policy,
      'returns_as_of', public.cms__ts(v_pay.returns_as_of)) END,`],
      [`         'run_started_at', public.cms__ts(v_pay.run_started_at)) ELSE '{}'::jsonb END;`,
        `         'run_started_at', public.cms__ts(v_pay.run_started_at),
         -- 132 r1: tổng trả ĐÃ TRỪ trong số chốt (run contract đọc trả) — đối chiếu XLSX; không chi tiết phiếu / người.
         'returns', CASE WHEN v_pay.returns_as_of IS NOT NULL THEN (SELECT jsonb_build_object(
             'return_count', COALESCE(sum(r.return_count), 0), 'return_gmv', COALESCE(sum(r.return_gmv), 0)::text,
             'eligible_return_base', COALESCE(sum(r.eligible_return_base), 0)::text)
             FROM public.cms_results r WHERE r.run_id = v_pay.run_id) END) ELSE '{}'::jsonb END;`],
    ],
  },
  {
    name: 'rpc_cms_frozen_sales_lines', sig: 'rpc_cms_frozen_sales_lines(uuid,integer,integer)', grant: 'service_role:EXECUTE',
    edits: [
      [`      'disposition', q.disposition, 'unassigned_reason', q.unassigned_reason) ORDER BY q.seq), '[]'::jsonb)`,
        `      'disposition', q.disposition, 'unassigned_reason', q.unassigned_reason,
      'quantity_class', q.quantity_class, 'eligible_base', q.eligible_base::text) ORDER BY q.seq), '[]'::jsonb)`],
      [`                            'contract', public.cms__run_contract(v_pay.run_id), 'rows', v_rows, 'next_after_seq', v_next);`,
        `                            'contract', public.cms__run_contract(v_pay.run_id), 'rows', v_rows, 'next_after_seq', v_next,
                            -- 132 r1: profile báo cáo ĐÃ GHIM (một profile / chương trình — report_save chặn trộn); null = chưa có báo cáo
                            -- ⇒ job không tự chọn (PM r0 §3.1).
                            -- ORDER BY (db-reviewer r1 P2): report_save đã ép một profile / chương trình; báo cáo ĐẦU là nguồn ghim, tất định.
                            'report_profile', (SELECT r.returns_profile FROM public.cms_return_close_reports r
                                                WHERE r.program_id = p_program_id ORDER BY r.created_at, r.id LIMIT 1));`],
    ],
  },
  {
    name: 'rpc_cms_return_close_report_save', sig: 'rpc_cms_return_close_report_save(uuid,uuid,jsonb)', grant: 'service_role:EXECUTE',
    // r1 (PM r0 P1-04): thân vá thành LÕI owner-only cms__close_report_save (người lập / lý do / khoá yêu cầu là THAM SỐ, không từ payload);
    // hàm service_role cũ thành wrapper cron (template), thêm wrapper PHIÊN super rpc_cms_return_close_report_save_super.
    wrapper: true,
    core: {
      name: 'cms__close_report_save', sig: 'cms__close_report_save(uuid,uuid,jsonb,uuid,text,uuid)',
      head: `CREATE FUNCTION public.cms__close_report_save(p_program_id uuid, p_payout_run_id uuid, p_payload jsonb, p_actor uuid, p_reason text,
                                              p_request uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS `,
    },
    edits: [
      [`  v_pin    jsonb;`, `  v_pin    jsonb;
  v_full   boolean;  -- 132: profile full_line_qty_refund_v1
  v_dict   text;
  v_fpv    text;
  v_ct     boolean;  -- r1: run chốt là run contract (Q-237)`],
      // r1: payload KHÔNG còn khoá actor (UUID khai trong body không chứng minh người duyệt — PM r0 P1-04).
      [`WHERE k NOT IN ('pin', 'returns', 'actor'))`, `WHERE k NOT IN ('pin', 'returns', 'profile'))`],
      [`     OR (p_payload ? 'actor' AND NOT public.cms__str(p_payload, 'actor', c_uuid)), true) THEN`,
        `     OR (p_payload ? 'profile' AND p_payload -> 'profile' IS DISTINCT FROM '"full_line_qty_refund_v1"'::jsonb), true) THEN`],
      [`  v_rows := p_payload -> 'returns';`, `  v_rows := p_payload -> 'returns';
  -- 132: thiếu \`profile\` ⇒ net_returns_v1 (payload 130 nguyên dạng); full_line ⇒ từ điển v2 / fp v2 / hình dạng không lượng BI.
  v_full := p_payload ? 'profile';
  v_dict := CASE WHEN v_full THEN 'cms-return-status-v2' ELSE 'cms-return-status-v1' END;
  v_fpv  := CASE WHEN v_full THEN 'cms-return-fp-v2' ELSE 'cms-return-fp-v1' END;`],
      [`  v_actor := (p_payload ->> 'actor')::uuid;
  -- Phòng thủ chiều sâu (security-reviewer 14/11 P1-1): actor (đường super) phải là admin — điều kiện cần của super; allowlist super chỉ ở
  -- authz.ts + is_super_admin(), KHÔNG chép thêm. Server action vẫn phải kiểm super bằng phiên trước khi gọi service_role.
  IF v_actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_actor AND u.role = 'admin') THEN
    RAISE EXCEPTION 'CMS_REPORT_ACTOR_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF v_n > 100000 THEN RAISE EXCEPTION 'CMS_REPORT_TOO_LARGE' USING ERRCODE = '22023'; END IF;`,
      `  -- r1: người lập = THAM SỐ (cron ⇒ NULL; đường super ⇒ auth.uid() do wrapper phiên truyền sau khi kiểm is_super_admin()); lý do + khoá
  -- yêu cầu đi cùng người lập (đủ cả ba hoặc không có). Lý do 10–500 ký tự đã cắt khoảng trắng, không ký tự điều khiển (trừ tab / xuống dòng).
  v_actor := p_actor;
  IF (p_actor IS NULL) <> (p_reason IS NULL) OR (p_reason IS NULL) <> (p_request IS NULL)
     OR (p_reason IS NOT NULL AND (p_reason ~ '[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]' OR char_length(p_reason) NOT BETWEEN 10 AND 500
                                   OR p_reason <> btrim(p_reason, E' \\t\\r\\n'))) THEN
    RAISE EXCEPTION 'CMS_REPORT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- r1: trần phiếu / báo cáo theo profile — full_line 10.000 (= TS CMS_CLOSE_REPORT_MAX_RETURNS_FULL_LINE; PM r0 §3.3 đặt 20.000 + bench < 8 s,
  -- bench PG15 r1 đo 20.000 = 8,0–9,6 s ⇒ Dev đề xuất 10.000, TODO(Q-238) PM chốt), v1 giữ 100.000.
  -- Vượt ⇒ dừng TRƯỚC mọi khoá / ghi; không cắt / chia.
  IF v_n > (CASE WHEN v_full THEN 10000 ELSE 100000 END) THEN RAISE EXCEPTION 'CMS_REPORT_TOO_LARGE' USING ERRCODE = '22023'; END IF;`],
      // db-reviewer 18/11 P0: kiểm trạng thái phải theo từ điển của profile (v2 nhận CANCELED / PENDING / … là chưa hiệu lực).
      [`x(return_status text) WHERE public.cms__return_status_effect(x.return_status) IS NULL) THEN`,
        `x(return_status text) WHERE public.cms__return_status_effect_v(v_dict, x.return_status) IS NULL) THEN`],
      // r1 P1-2 (bench PG15 200k / 20k, auto_explain): regex lặp giới hạn `^[^ctl]{1,n}$` ≈ 1,2 s / 20.000 phiếu ⇒ viết lại TƯƠNG ĐƯƠNG
      // char_length BETWEEN 1 AND n + KHÔNG chứa ký tự điều khiển (text không chứa NUL) — ~10× nhanh; 12 ca biên khớp (scratch rxbench).
      [`  c_t30  CONSTANT text := '^[^\\x01-\\x1f\\x7f-\\x9f]{1,30}$';`, `  c_t30  CONSTANT text := '^[^\\x01-\\x1f\\x7f-\\x9f]{1,30}$';
  c_ctl  CONSTANT text := '[\\x01-\\x1f\\x7f-\\x9f]';  -- r1: kiểm phiếu = char_length + !~ c_ctl (tương đương c_txt / c_t30 / c_t50)`],
      [`       WHERE NOT (COALESCE(x.return_event_id ~ c_txt AND x.return_status ~ c_t30, false)`,
        `       WHERE NOT (COALESCE(char_length(x.return_event_id) BETWEEN 1 AND 100 AND x.return_event_id !~ c_ctl
                           AND char_length(x.return_status) BETWEEN 1 AND 30 AND x.return_status !~ c_ctl, false)`],
      ...[['return_document_id', 'c_txt', 100], ['return_code', 'c_txt', 100], ['original_order_line_id', 'c_txt', 100],
        ['original_order_id', 'c_txt', 100], ['original_order_type', 'c_t30', 30], ['original_order_status', 'c_t30', 30],
        ['original_pos_code', 'c_t50', 50]].map(([col, rx, n]) => [`(x.${col} IS NULL OR x.${col} ~ ${rx})`,
        `(x.${col} IS NULL OR (char_length(x.${col}) BETWEEN 1 AND ${n} AND x.${col} !~ c_ctl))`]),
      [`public.cms__report_rows(v_rows)`, `public.cms__report_rows2(v_dict, v_rows)`, 2],
      [`                    AND p.return_base_quantity IS NOT NULL AND p.return_gmv_amount IS NOT NULL AND p.original_completed_at IS NOT NULL`,
        `                    AND (p.return_base_quantity IS NOT NULL) = (NOT v_full) AND p.return_gmv_amount IS NOT NULL
                    AND p.original_completed_at IS NOT NULL`],
      [`                    AND p.original_base_quantity IS NOT NULL AND p.original_gmv_amount IS NOT NULL`,
        `                    AND (p.original_base_quantity IS NOT NULL) = (NOT v_full) AND (p.original_gmv_amount IS NOT NULL) = (NOT v_full)
                    AND (NOT v_full OR (p.original_seller_email IS NULL AND p.original_pos_code IS NULL AND p.original_quantity_src IS NULL
                                        AND p.original_uom_src IS NULL AND p.original_quantity_src_flag IS NULL
                                        AND p.original_uom_src_flag IS NULL))`],
      [`  IF v_run.calc_contract_version IS NOT NULL THEN RAISE EXCEPTION 'CMS_REPORT_CONTRACT_UNSUPPORTED' USING ERRCODE = 'P0001'; END IF;`,
        `  -- r1 (Q-237): run contract chốt được ⇒ báo cáo đọc HỢP ĐỒNG ĐÓNG BĂNG (số gộp + điều kiện gốc + phiếu đã nhận + số ròng). Profile
  -- theo LỰA CHỌN GHIM (PM r0 §3.1): run đọc trả ⇒ đúng policy run (khác ⇒ PROFILE_MISMATCH); legacy / sales-only ⇒ lựa chọn của báo cáo
  -- đầu tiên (super) — cron (không người lập) không tự chọn khi chương trình chưa có báo cáo (POLICY_UNSELECTED). 0 ghi.
  v_ct := v_run.calc_contract_version IS NOT NULL;
  IF v_ct AND v_run.calc_contract_version NOT IN ${BOTH_RUN} THEN
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
  END IF;`],
      [`  v_idem := encode(sha256(convert_to(concat_ws(E'\\n', 'cms-close-report-v1', p_program_id::text, p_payout_run_id::text,
                                               public.cms__ts(v_asof), v_dig, 'cms-calc-ret2-v1', 'cms-return-fp-v1', 'cms-return-status-v1'),`,
        `  v_idem := encode(sha256(convert_to(CASE WHEN v_full
                 THEN concat_ws(E'\\n', 'cms-close-report-v2', p_program_id::text, p_payout_run_id::text, public.cms__ts(v_asof), v_dig,
                                'cms-calc-ret2-v2', 'cms-return-fp-v2', 'cms-return-status-v2', 'full_line_qty_refund_v1')
                 ELSE concat_ws(E'\\n', 'cms-close-report-v1', p_program_id::text, p_payout_run_id::text,
                                               public.cms__ts(v_asof), v_dig, 'cms-calc-ret2-v1', 'cms-return-fp-v1', 'cms-return-status-v1') END,`],
      [`           CASE WHEN x.status_effect = 'EFFECTIVE' THEN public.cms__return_fp('cms-return-fp-v1', p_program_id, x.return_event_id,`,
        `           CASE WHEN x.status_effect = 'EFFECTIVE' THEN public.cms__return_fp(v_fpv, p_program_id, x.return_event_id,`],
      [`             (sl.order_id, sl.product_id, sl.completed_at, sl.seller_email, sl.pos_code, sl.base_quantity, sl.gmv_amount)
             IS DISTINCT FROM
             (p.original_order_id, p.product_id, p.original_completed_at, p.original_seller_email, p.original_pos_code,
              p.original_base_quantity, p.original_gmv_amount)`,
        `             CASE WHEN v_full
                  THEN (sl.order_id, sl.product_id, sl.completed_at) IS DISTINCT FROM (p.original_order_id, p.product_id, p.original_completed_at)
                  ELSE (sl.order_id, sl.product_id, sl.completed_at, sl.seller_email, sl.pos_code, sl.base_quantity, sl.gmv_amount)
             IS DISTINCT FROM
             (p.original_order_id, p.product_id, p.original_completed_at, p.original_seller_email, p.original_pos_code,
              p.original_base_quantity, p.original_gmv_amount) END`],
      [`    UNION ALL SELECT 'EXCEEDS_SALE_BASE', acc.id FROM acc WHERE acc.rb > acc.sb`,
        `    UNION ALL SELECT 'EXCEEDS_SALE_BASE', acc.id FROM acc WHERE NOT v_full AND acc.rb > acc.sb`],
      // Hiệu lực full_line: phiếu đầu (recorded_at µs, rồi byte ID) của mỗi dòng APPLIED mang B_i (lượng) / E_i (đủ điều kiện) của dòng
      // chốt; phiếu sau 0. r1: `ee` = lượng ĐỦ ĐIỀU KIỆN bị trừ (full_line: E_i — run legacy không có E ⇒ B_i; net: BI nếu lớp đếm được, lớp
      // khác 0 — cùng seal N3); `pre` = phiếu đã APPLIED trong run chốt contract (đã trừ trước chốt — probe PK (run_id, return_event_id)).
      [`  ), acc AS (
    SELECT e.original_order_line_id AS id, max(e.sb) AS sb,`, `  ), eq0 AS (
    SELECT e.*, row_number() OVER (PARTITION BY e.original_order_line_id, e.disp
                                   ORDER BY e.recorded_at, e.return_event_id COLLATE "C") AS lrn
      FROM e
  ), eq AS (
    SELECT e.*, CASE WHEN v_full AND e.disp = 'APPLIED' THEN CASE WHEN e.lrn = 1 THEN e.sb ELSE 0 END END AS qty,
           CASE WHEN e.disp IS DISTINCT FROM 'APPLIED' THEN NULL
                WHEN v_full THEN CASE WHEN e.lrn = 1 THEN COALESCE(e.se, e.sb) ELSE 0 END
                WHEN e.sqc IS NULL OR e.sqc IN ('POS_BASE', 'COUNTED') THEN e.return_base_quantity ELSE 0 END AS ee,
           CASE WHEN v_ct AND e.disp = 'APPLIED'
                THEN (SELECT true FROM public.cms_return_lines rl WHERE rl.run_id = p_payout_run_id AND rl.return_event_id = e.return_event_id
                        AND rl.disposition = 'APPLIED') IS NOT NULL END AS pre
      FROM eq0 e
  ), acc AS (
    SELECT e.original_order_line_id AS id, max(e.sb) AS sb,`],
      [`                     'doc', e.return_document_id, 'order_id', e.original_order_id, 'product_id', e.product_id))
                    FROM e), '[]'::jsonb),`, `                     'doc', e.return_document_id, 'order_id', e.original_order_id, 'product_id', e.product_id, 'qty', e.qty,
                     'ee', e.ee, 'pre', e.pre))
                    FROM eq e), '[]'::jsonb),`],
      [`    SELECT * FROM jsonb_to_recordset(v_ret) AS x(id text, disp text, user_id uuid, ppid uuid, base numeric, refund numeric)
  ), ap AS (
    SELECT ev.user_id, ev.ppid, sum(ev.base) AS rb,`, `    SELECT * FROM jsonb_to_recordset(v_ret) AS x(id text, disp text, user_id uuid, ppid uuid, base numeric, refund numeric, qty numeric,
                                                  ee numeric)
  ), ap AS (
    SELECT ev.user_id, ev.ppid, sum(CASE WHEN v_full THEN ev.qty ELSE ev.base END) AS rb, sum(ev.ee) AS re,`],
      // r1: nhóm của run chốt — legacy giữ công thức 130 (B / GMV đã chốt − trả); run CONTRACT tính từ số GỘP đóng băng + MỌI phiếu APPLIED
      // của snapshot (⊇ phiếu đã trừ trước chốt — sổ bảo đảm) rồi so số RÒNG đã chốt: phát lại phiếu cũ ⇒ delta 0; phiếu mới cùng dòng
      // (full_line) chỉ thêm tiền hoàn; phiếu trên dòng khác trừ B / E của dòng đó. Gate SP = GMV gộp − Σ hoàn; gate danh mục = GMV danh mục
      // ròng đã chốt + hoàn đã trừ trước chốt − Σ hoàn (cùng nhóm SP danh mục của dược sĩ). F theo thang đóng băng.
      [`    SELECT r.*, COALESCE(ap.rb, 0) AS rb, COALESCE(ap.rg, 0) AS rg, COALESCE(ap.n, 0) AS rn`,
        `    SELECT r.*, COALESCE(ap.rb, 0) AS rb, COALESCE(ap.rg, 0) AS rg, COALESCE(ap.n, 0) AS rn, COALESCE(ap.re, 0) AS re`],
      [`    SELECT r.user_id, sum(r.rg) AS crg FROM r WHERE r.gmv_basis = 'catalog' GROUP BY r.user_id`,
        `    SELECT r.user_id, sum(r.rg) AS crg, COALESCE(sum(r.return_gmv), 0) AS cfr FROM r WHERE r.gmv_basis = 'catalog' GROUP BY r.user_id`],
      [`    SELECT r.*, r.base_quantity - r.rb AS elig, r.gmv_amount - r.rg AS net_gmv,
           CASE r.gmv_basis WHEN 'none' THEN true
                            WHEN 'product' THEN COALESCE(r.gate_gmv - r.rg >= r.target_gmv, false)
                            ELSE COALESCE(k.catalog_gmv - COALESCE(cat.crg, 0) >= k.target_gmv, false) END AS met,
           GREATEST(floor((r.base_quantity - r.rb) / r.per_unit), 0)::bigint AS qn`,
        `    SELECT r.*, CASE WHEN v_ct THEN r.eligible_sale_base ELSE r.base_quantity END AS fb,
           CASE WHEN v_ct THEN r.re ELSE r.rb END AS rbx,
           CASE WHEN v_ct THEN r.sale_gmv ELSE r.gmv_amount END AS fg,
           CASE WHEN v_ct THEN r.eligible_sale_base - r.re ELSE r.base_quantity - r.rb END AS elig,
           CASE WHEN v_ct THEN r.sale_gmv ELSE r.gmv_amount END - r.rg AS net_gmv,
           CASE r.gmv_basis WHEN 'none' THEN true
                            WHEN 'product' THEN COALESCE(CASE WHEN v_ct THEN r.sale_gmv ELSE r.gate_gmv END - r.rg >= r.target_gmv, false)
                            ELSE COALESCE(k.catalog_gmv + CASE WHEN v_ct THEN COALESCE(cat.cfr, 0) ELSE 0 END - COALESCE(cat.crg, 0)
                                          >= k.target_gmv, false) END AS met,
           GREATEST(floor((CASE WHEN v_ct THEN r.eligible_sale_base - r.re ELSE r.base_quantity - r.rb END) / r.per_unit), 0)::bigint AS qn`],
      [`           'gmv_basis', q.gmv_basis, 'per_unit', q.per_unit, 'frozen_base', q.base_quantity, 'frozen_qty', q.rewarded_quantity,
           'frozen_gmv', q.gmv_amount, 'frozen_gate_met', q.gate_met, 'frozen_amount', q.amount_vnd, 'return_base', q.rb,`,
        `           'gmv_basis', q.gmv_basis, 'per_unit', q.per_unit, 'frozen_base', q.fb, 'frozen_qty', q.rewarded_quantity,
           'frozen_gmv', q.fg, 'frozen_gate_met', q.gate_met, 'frozen_amount', q.amount_vnd, 'return_base', q.rbx,
           'frozen_return_base', CASE WHEN v_ct THEN q.eligible_return_base END, 'frozen_return_gmv', CASE WHEN v_ct THEN q.return_gmv END,`],
      [`  INSERT INTO public.cms_return_close_reports (id, program_id, payout_run_id, eval_seq, calc_contract_version, fp_version,
    status_dictionary_version, source_pin,`, `  INSERT INTO public.cms_return_close_reports (id, program_id, payout_run_id, eval_seq, returns_profile, calc_contract_version, fp_version,
    status_dictionary_version, source_pin,`],
      [`    line_count, idem_key, created_via, created_by)`, `    line_count, idem_key, created_via, created_by, manual_reason, manual_request)`],
      [`  VALUES (v_id, p_program_id, p_payout_run_id, v_seq, 'cms-calc-ret2-v1', 'cms-return-fp-v1', 'cms-return-status-v1', v_pin,`,
        `  VALUES (v_id, p_program_id, p_payout_run_id, v_seq, CASE WHEN v_full THEN 'full_line_qty_refund_v1' ELSE 'net_returns_v1' END,
          CASE WHEN v_full THEN 'cms-calc-ret2-v2' ELSE 'cms-calc-ret2-v1' END, v_fpv, v_dict, v_pin,`],
      [`v_idem, CASE WHEN v_actor IS NULL THEN 'cron' ELSE 'super' END, v_actor);`,
        `v_idem, CASE WHEN v_actor IS NULL THEN 'cron' ELSE 'super' END, v_actor,
          p_reason, p_request);`],
      [`    per_unit, frozen_base, frozen_qty, frozen_gmv, frozen_gate_met, frozen_amount, return_base, return_gmv, return_events, eligible_base,
    net_gmv, gate_met, recomputed_qty, recomputed_amount, delta)`,
        `    per_unit, frozen_base, frozen_qty, frozen_gmv, frozen_gate_met, frozen_amount, return_base, return_gmv, return_events, eligible_base,
    net_gmv, gate_met, recomputed_qty, recomputed_amount, delta, frozen_return_base, frozen_return_gmv)`],
      [`         x.gate_met, x.recomputed_qty, x.recomputed_amount, x.delta
    FROM jsonb_to_recordset(v_lines) AS x(line_no integer, user_id uuid, program_product_id uuid, product_id text, gmv_basis text,
           per_unit numeric, frozen_base numeric, frozen_qty bigint, frozen_gmv numeric, frozen_gate_met boolean, frozen_amount bigint,
           return_base numeric, return_gmv numeric, return_events integer, eligible_base numeric, net_gmv numeric, gate_met boolean,
           recomputed_qty bigint, recomputed_amount bigint, delta bigint);`,
        `         x.gate_met, x.recomputed_qty, x.recomputed_amount, x.delta, x.frozen_return_base, x.frozen_return_gmv
    FROM jsonb_to_recordset(v_lines) AS x(line_no integer, user_id uuid, program_product_id uuid, product_id text, gmv_basis text,
           per_unit numeric, frozen_base numeric, frozen_qty bigint, frozen_gmv numeric, frozen_gate_met boolean, frozen_amount bigint,
           return_base numeric, return_gmv numeric, return_events integer, eligible_base numeric, net_gmv numeric, gate_met boolean,
           recomputed_qty bigint, recomputed_amount bigint, delta bigint, frozen_return_base numeric, frozen_return_gmv numeric);`],
      [`    disposition, user_id, program_product_id, base, refund, recorded_at)
  SELECT v_id, p_program_id, x.id, x.fp, x.line, x.disp, x.user_id, x.ppid, x.base, x.refund, x.recorded_at::timestamptz
    FROM jsonb_to_recordset(v_ret) AS x(id text, fp text, line text, disp text, user_id uuid, ppid uuid, base numeric, refund numeric,
                                        recorded_at text);`, `    disposition, user_id, program_product_id, base, refund, recorded_at, returns_profile, qty_effect, pre_lock)
  SELECT v_id, p_program_id, x.id, x.fp, x.line, x.disp, x.user_id, x.ppid, x.base, x.refund, x.recorded_at::timestamptz,
         CASE WHEN v_full THEN 'full_line_qty_refund_v1' ELSE 'net_returns_v1' END, CASE WHEN v_full THEN x.qty END, x.pre
    FROM jsonb_to_recordset(v_ret) AS x(id text, fp text, line text, disp text, user_id uuid, ppid uuid, base numeric, refund numeric,
                                        recorded_at text, qty numeric, pre boolean);`],
      [`  SELECT p_program_id, x.id, 'cms-return-fp-v1', x.fp, x.doc,`, `  SELECT p_program_id, x.id, v_fpv, x.fp, x.doc,`],
      // r1: run contract — phiếu đã trừ trước chốt phải còn trong snapshot (sổ bảo đảm; mất ⇒ lệch công thức / sổ); nhóm KHÔNG có phát sinh
      // sau chốt (cùng tổng đủ điều kiện + hoàn với số đã seal) ⇒ tính lại = số chốt (bắt lệch công thức báo cáo ↔ seal).
      [`     OR EXISTS (SELECT 1 FROM public.cms_return_close_report_lines l WHERE l.report_id = v_id AND l.delta > 0)`,
        `     OR EXISTS (SELECT 1 FROM public.cms_return_close_report_lines l WHERE l.report_id = v_id AND l.delta > 0)
     OR EXISTS (SELECT 1 FROM public.cms_return_close_report_lines l WHERE l.report_id = v_id AND l.frozen_return_base IS NOT NULL
                  AND (l.return_base < l.frozen_return_base OR l.return_gmv < l.frozen_return_gmv
                       OR (l.return_base = l.frozen_return_base AND l.return_gmv = l.frozen_return_gmv AND l.delta <> 0)))`],
      // r1: SP HIỆU LỰC (retired_at IS NULL — PM r0 P1-01): chương trình đã chốt có cấu hình đóng băng ⇒ đúng tập SP của run chốt; SP đã
      // retire (131) không vào phạm vi ⇒ phiếu trên SP đó ORIGIN_NOT_IN_PROGRAM, không HOLD ORIGIN_MISSING; pin = hash SP hiệu lực.
      [`    INTO v_ph FROM public.cms_program_products pp WHERE pp.program_id = p_program_id;`,
        `    INTO v_ph FROM public.cms_program_products pp WHERE pp.program_id = p_program_id AND pp.retired_at IS NULL;`],
      [`EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = p_program_id AND pp.product_id = p.product_id) AS in_prog,`,
        `EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = p_program_id AND pp.product_id = p.product_id
                          AND pp.retired_at IS NULL) AS in_prog,`],
      [`           sl.base_quantity AS sb, sl.gmv_amount AS sg,`, `           sl.base_quantity AS sb, sl.gmv_amount AS sg, sl.eligible_base AS se, sl.quantity_class AS sqc,`],
      [`      LEFT JOIN LATERAL (SELECT s.order_line_id, s.disposition, s.user_id, s.program_product_id, s.base_quantity, s.gmv_amount,`,
        `      LEFT JOIN LATERAL (SELECT s.order_line_id, s.disposition, s.user_id, s.program_product_id, s.base_quantity, s.gmv_amount,
                                s.eligible_base, s.quantity_class,`],
      // r1: đường super phát lại cùng khoá yêu cầu ⇒ báo cáo đã lập (dưới khoá chương trình — hai lượt chen nhau không nhân bản).
      [`  IF v_prog.status IS DISTINCT FROM 'locked' THEN RAISE EXCEPTION 'CMS_REPORT_NOT_LOCKED' USING ERRCODE = 'P0001'; END IF;`,
        `  IF v_prog.status IS DISTINCT FROM 'locked' THEN RAISE EXCEPTION 'CMS_REPORT_NOT_LOCKED' USING ERRCODE = 'P0001'; END IF;
  IF p_request IS NOT NULL THEN
    SELECT id INTO v_old FROM public.cms_return_close_reports WHERE program_id = p_program_id AND manual_request = p_request;
    IF FOUND THEN RETURN jsonb_build_object('saved', true, 'already', true, 'report_id', v_old); END IF;
  END IF;`],
    ],
  },
  // ── r2 (PM 19/11 RET-R2-01 · Q-238 b): chứng nhận nguồn cms_unit có version (thân 124 vá theo neo; 125–131 không thay) ──
  {
    // Nhận ĐÚNG MỘT trong hai bộ (field_set, fp_version, tool_version); bộ phải khớp cách tính của run (cms_unit ⇔ decision_unit14) —
    // lệch ⇒ CMS_ATTEST_BASIS_MISMATCH trước mọi ghi; run cms_unit qua cms__run_unit_check (kể cả tính lại phân loại / E); vân tay DB tính
    // lại theo đúng bộ. Quyền / payload / khoá / idem / mốc / thay / thu hồi giữ nguyên 124.
    name: 'rpc_cms_source_attest', sig: 'rpc_cms_source_attest(uuid,uuid,jsonb,uuid)', grant: 'authenticated:EXECUTE', src: 124,
    edits: [
      [`  v_con   text;
  c_hex`, `  v_con   text;
  v_unit  boolean;  -- 132 r2: run tính theo đơn vị CMS ⇒ bộ decision_unit14
  c_hex`],
      [`     OR NOT public.cms__str(p_payload, 'fp_version', '^cms-rows-fp-v1$')
     OR NOT public.cms__str(p_payload, 'field_set', '^decision10$')   -- PM COMP-P1-1: audit14 bị từ chối trước mọi khoá / ghi`,
        `     -- PM COMP-P1-1 + 132 r2 (Q-238 b): ĐÚNG MỘT trong hai bộ có version; audit14 / trộn version bị từ chối trước mọi khoá / ghi.
     OR NOT public.cms__str(p_payload, 'fp_version', '^cms-rows-fp-v[12]$')
     OR NOT public.cms__str(p_payload, 'field_set', '^(decision10|decision_unit14)$')
     OR (p_payload ->> 'field_set', p_payload ->> 'fp_version', p_payload ->> 'tool_version') NOT IN ((${ATT_V1}), (${ATT_U2}))`],
      [`     OR NOT public.cms__str(p_payload, 'tool_version', '^cms-i4-compare-v1$')`,
        `     OR NOT public.cms__str(p_payload, 'tool_version', '^cms-i4-compare-v[12]$')`],
      [`  v_code := public.cms__run_source_check(p_run_id);
  IF v_code IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE = 'CMS_ATTEST_' || v_code, ERRCODE = 'P0001'; END IF;`,
        `  v_code := public.cms__run_source_check(p_run_id);
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
  END IF;`],
      [`  IF (p_payload ->> 'run_rows_fp') <> public.cms__run_source_fp(p_run_id, 'decision10') THEN`,
        `  IF (p_payload ->> 'run_rows_fp') <> (CASE WHEN v_unit THEN public.cms__run_unit_fp(p_run_id)
                                             ELSE public.cms__run_source_fp(p_run_id, 'decision10') END) THEN`],
    ],
  },
  {
    // Snapshot lớp nguồn: thêm chuỗi THÔ q / u + cờ (130 *_src; run legacy ⇒ NULL) để CLI dựng file run 18 cột cho decision_unit14.
    // 14 khoá cũ giữ nguyên tên / dạng; keyset / quyền / run công bố giữ nguyên 124.
    name: 'rpc_cms_run_source_export', sig: 'rpc_cms_run_source_export(uuid,uuid,text,integer)', grant: 'authenticated:EXECUTE', src: 124,
    edits: [[`           'source_updated_at', public.cms__ts(q.source_updated_at)) ORDER BY q.order_line_id COLLATE "C"), '[]'::jsonb),`,
      `           'source_updated_at', public.cms__ts(q.source_updated_at),
           -- 132 r2 (Q-238 b): chuỗi THÔ q / u + cờ — đầu vào phân loại cms_unit (bộ decision_unit14).
           'quantity_src', q.quantity_src, 'quantity_src_flag', q.quantity_src_flag, 'uom_src', q.uom_src,
           'uom_src_flag', q.uom_src_flag) ORDER BY q.order_line_id COLLATE "C"), '[]'::jsonb),`]],
  },
])

/** Hàm mới (thân trong template / sinh từ 130). Chỉ owner. */
// ── r3 S2 (PM 20/11 §4.1.1): bước 5 của lõi báo cáo thành hàm riêng ──────────────────────────────────────────────────────────────
// Thống kê chưa biết run mới (seal ANALYZE SKIP_LOCKED bị bỏ qua khi autovacuum / phiên khác giữ khoá) ⇒ planner ước run 1 dòng, probe
// TỪNG phiếu (LATERAL … LIMIT 1 trên cms_sales_lines, truy vấn con trên cms_return_lines) hoà chi phí giữa PK (run_id, khoá) và index
// (run_id, seq) rồi chọn (run_id, seq) ⇒ mỗi phiếu quét lại cả run (r3 khảo sát: 9 ms × 9.500 phiếu = 89 s). Sửa: hai tra đó thành LEFT
// JOIN theo TẬP (PK duy nhất ⇒ ≤ 1 dòng khớp, cùng nghĩa LIMIT 1 / truy vấn con) trong hàm SQL riêng SET enable_nestloop = off (mẫu seal
// 130 / cms__run_source_check 124) ⇒ chỉ hash / merge join: mỗi bảng run đọc MỘT lượt bất kể thống kê, không còn nested loop + materialize
// bậc hai (bench 14/11). Thân = câu bước 5 của lõi (sinh, không chép tay) trừ hai thay thế dưới; tham số giữ ĐÚNG tên biến của lõi.
export const CMS_132_SCAN_ARGS = Object.freeze(['p_program_id uuid', 'p_payout_run_id uuid', 'v_dict text', 'v_rows jsonb', 'v_fpv text',
  'v_full boolean', 'v_ct boolean', 'v_from timestamp with time zone', 'v_to timestamp with time zone', 'v_asof timestamp with time zone'])
const SCAN_FROM = '  --    Kế hoạch không phụ thuộc thống kê (bench 14/11'
const SCAN_STMT = '  WITH p0 AS MATERIALIZED ('
const SCAN_INTO = '\n    INTO v_code, v_ids, v_ret, v_obs;\n'
export const CMS_132_SCAN_SALES = Object.freeze([
  `      LEFT JOIN LATERAL (SELECT s.order_line_id, s.disposition, s.user_id, s.program_product_id, s.base_quantity, s.gmv_amount,
                                s.eligible_base, s.quantity_class,
                                s.order_id, s.product_id, s.completed_at, s.seller_email, s.pos_code
                           FROM public.cms_sales_lines s
                          WHERE s.run_id = p_payout_run_id AND s.order_line_id = p.original_order_line_id LIMIT 1) sl ON true`,
  `      LEFT JOIN public.cms_sales_lines sl ON sl.run_id = p_payout_run_id AND sl.order_line_id = p.original_order_line_id`])
export const CMS_132_SCAN_PRE = Object.freeze([
  `           CASE WHEN v_ct AND e.disp = 'APPLIED'
                THEN (SELECT true FROM public.cms_return_lines rl WHERE rl.run_id = p_payout_run_id AND rl.return_event_id = e.return_event_id
                        AND rl.disposition = 'APPLIED') IS NOT NULL END AS pre
      FROM eq0 e`,
  `           CASE WHEN v_ct AND e.disp = 'APPLIED' THEN rl.return_event_id IS NOT NULL END AS pre
      FROM eq0 e
      LEFT JOIN public.cms_return_lines rl ON rl.run_id = p_payout_run_id AND rl.return_event_id = e.return_event_id
                                         AND rl.disposition = 'APPLIED'`])
const SCAN_CALL = [
  '  --    r3 (PM 20/11 S2): câu tính ở cms__close_report_scan — dòng bán / phiếu run theo TẬP (hash / merge join, enable_nestloop = off),',
  '  --    không phụ thuộc thống kê run mới; baseline vẫn probe PK (program_id, return_event_id) — index duy nhất của bảng. p0 = MỘT lần đọc',
  '  --    cms__report_rows2; fp tính MỘT lần cho phiếu hiệu lực, dùng chung cho sự kiện báo cáo (bước 8) và quan sát sổ (bước 6); led = phiếu',
  '  --    đã có baseline (dưới khoá chương trình — baseline chỉ ghi dưới khoá này). Hàm STABLE: cùng snapshot câu gọi.',
  '  SELECT x.o_code, x.o_ids, x.o_ret, x.o_obs INTO v_code, v_ids, v_ret, v_obs',
  '    FROM public.cms__close_report_scan(p_program_id, p_payout_run_id, v_dict, v_rows, v_fpv, v_full, v_ct, v_from, v_to, v_asof) x;',
  ''].join('\n')
/** Tách bước 5 khỏi thân lõi ⇒ { body: thân lõi gọi hàm, block: CREATE FUNCTION cms__close_report_scan }. */
function closeScanSplit(body) {
  const a = body.indexOf(SCAN_FROM), s = body.indexOf(SCAN_STMT), z = body.indexOf(SCAN_INTO)
  if (a < 0 || s < a || z < s || body.indexOf(SCAN_FROM, a + 1) >= 0 || body.indexOf(SCAN_STMT, s + 1) >= 0 || body.indexOf(SCAN_INTO, z + 1) >= 0) {
    throw new Error('bước 5 lõi báo cáo lạ (neo tách cms__close_report_scan)')
  }
  let stmt = body.slice(s, z)
  stmt = once(stmt, CMS_132_SCAN_SALES[0], CMS_132_SCAN_SALES[1])
  stmt = once(stmt, CMS_132_SCAN_PRE[0], CMS_132_SCAN_PRE[1])
  const args = new Set(CMS_132_SCAN_ARGS.map((x) => x.split(' ')[0]))
  const stray = [...new Set(stmt.match(/\b[pv]_[a-z0-9_]+\b/g) ?? [])].filter((v) => !args.has(v))
  if (stray.length) throw new Error(`bước 5 dùng biến ngoài tham số cms__close_report_scan: ${stray.join(', ')}`)
  if (stmt.includes('$$')) throw new Error('bước 5 chứa $$')
  const block = ['CREATE FUNCTION public.cms__close_report_scan(' + CMS_132_SCAN_ARGS.join(', ') + ')',
    'RETURNS TABLE (o_code text, o_ids text, o_ret jsonb, o_obs jsonb)',
    'LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET enable_nestloop = off AS $$', stmt + ';', '$$;'].join('\n')
  return { body: body.slice(0, a) + SCAN_CALL + body.slice(z + SCAN_INTO.length), block }
}

export const CMS_132_NEW = Object.freeze([
  { name: 'cms__return_status_effect_v', sig: 'cms__return_status_effect_v(text,text)', grant: null },
  { name: 'cms__report_rows2', sig: 'cms__report_rows2(text,jsonb)', grant: null },
  // r1 (PM r0 P1-04): lõi lưu báo cáo (owner-only) + wrapper PHIÊN super (authenticated — DB kiểm auth.uid() + is_super_admin()).
  { name: 'cms__close_report_save', sig: 'cms__close_report_save(uuid,uuid,jsonb,uuid,text,uuid)', grant: null },
  { name: 'rpc_cms_return_close_report_save_super', sig: 'rpc_cms_return_close_report_save_super(uuid,uuid,jsonb,text,uuid)',
    grant: 'authenticated:EXECUTE' },
  // r2 (Q-238 b): chứng nhận nguồn cms_unit — vân tay decision_unit14 (cms-rows-fp-v2) + kiểm thô / phân loại của run. Chỉ owner.
  { name: 'cms__run_unit_fp_text', sig: 'cms__run_unit_fp_text(uuid)', grant: null },
  { name: 'cms__run_unit_fp', sig: 'cms__run_unit_fp(uuid)', grant: null },
  { name: 'cms__run_unit_check', sig: 'cms__run_unit_check(uuid,boolean)', grant: null },
  // r3 (PM 20/11 S2): bước 5 của lõi báo cáo (dòng bán / phiếu run theo TẬP, enable_nestloop = off — sinh từ thân lõi) + kiểm lệch sổ
  // của lock_eval theo tập. Chỉ owner.
  { name: 'cms__close_report_scan', sig: `cms__close_report_scan(${CMS_132_SCAN_ARGS.map((a) => a.replace(/^[a-z_0-9]+ /, '')).join(',')})`, grant: null },
  { name: 'cms__ledger_drift', sig: 'cms__ledger_drift(uuid,uuid)', grant: null },
])
export const CMS_132_ALL = Object.freeze([...CMS_132_NEW, ...CMS_132_REPLACED.map(({ name, sig, grant }) => ({ name, sig, grant }))])
/** Ràng buộc nền 130 bị thay (preflight kiểm có mặt; rollback dựng lại nguyên văn). */
export const CMS_132_CONSTRAINTS = Object.freeze([
  ['cms_programs', 'cms_programs_returns_policy_value'], ['cms_programs', 'cms_programs_policy_actor'],
  ['cms_sync_runs', 'cms_sync_runs_contract_shape'], ['cms_sync_runs', 'cms_sync_runs_returns_shape'],
  ['cms_sync_runs', 'cms_sync_runs_ledger_shape'], ['cms_sync_runs', 'cms_sync_runs_contract_ok'],
  ['cms_return_lines', 'cms_return_lines_effect'], ['cms_return_lines', 'cms_return_lines_shape'],
  ['cms_result_events', 'cms_result_events_sign'],
  ['cms_return_baselines', 'cms_return_baselines_fp_version_check'], ['cms_return_baselines', 'cms_return_baselines_base_quantity_check'],
  ['cms_return_close_reports', 'cms_return_close_reports_calc_contract_version_check'],
  ['cms_return_close_reports', 'cms_return_close_reports_fp_version_check'],
  ['cms_return_close_reports', 'cms_return_close_reports_status_dictionary_version_check'],
  ['cms_return_close_report_events', 'cms_return_close_report_events_base_check'],
  // r1: dòng báo cáo full_line / run contract — nhóm có phiếu mà lượng đủ điều kiện trừ 0 (lớp OTHER_UNIT…) hợp lệ.
  ['cms_return_close_report_lines', 'cms_return_close_report_lines_math'],
  // r2 (Q-238 b): CHECK cột 124 của bảng chứng nhận ⇒ một CHECK bộ ba version (decision10 v1 | decision_unit14 v2).
  ['cms_source_attestations', 'cms_source_attestations_fp_version_check'],
  ['cms_source_attestations', 'cms_source_attestations_field_set_check'],
  ['cms_source_attestations', 'cms_source_attestations_tool_version_check'],
])

const sigRe = (name) => new RegExp(`^CREATE (OR REPLACE )?FUNCTION public\\.${name}\\(`)
const aclValues = (list) => list.map((x, i) => `('${x.sig}', ${x.grant ? `'${x.grant}'` : 'NULL'}${i === 0 ? '::text' : ''})`).join(', ')
const md5Check = (list, key) => list.map((x, i) =>
  `${i ? '     OR ' : ''}(SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.${x.sig}')) IS DISTINCT FROM '${x[key]}'`).join('\n')

export function buildCms132() {
  const tpl = fs.readFileSync(CMS_132_TEMPLATE, 'utf8')
  if (tpl.includes('\r')) throw new Error('template phải LF')
  const src = fs.readFileSync(path.join(MIG, SRC_130), 'utf8')
  if (src.includes('\r')) throw new Error('130 phải LF')
  const bodies130 = cmsFunctionBodies(src)
  const src124 = fs.readFileSync(path.join(MIG, SRC_124), 'utf8')
  if (src124.includes('\r')) throw new Error('124 phải LF')
  const bodies = { 130: bodies130, 124: cmsFunctionBodies(src124) }

  // r1: `core` ⇒ thân vá thành hàm MỚI (owner-only) đặt ở @@CORE_BLOCKS@@; hàm gốc (`wrapper`) lấy thân từ template (gọi lõi). Rollback vẫn
  // khôi phục NGUYÊN VĂN thân nền của hàm gốc.
  const cores = []
  let scanBlock = null
  const replaced = CMS_132_REPLACED.map((x) => {
    const b = bodies[x.src ?? 130].get(x.name)
    if (!b) throw new Error(`không thấy ${x.name} trong ${x.src ?? 130}`)
    if (!sigRe(x.name).test(b.block)) throw new Error(`khối ${x.name} lạ`)
    let body = b.body
    for (const [a, z, n] of x.edits) {
      try { body = once(body, a, z, n ?? 1) } catch (e) { throw new Error(`${x.name}: ${e.message}`) }
    }
    if (body === b.body) throw new Error(`${x.name}: không đổi gì`)
    const head = b.block.slice(0, b.block.length - b.body.length - b.block.match(/(\$[a-z]*\$);$/)[1].length - 1)
    const tag = b.block.match(/(\$[a-z]*\$);$/)[1]
    if (body.includes(tag)) throw new Error(`${x.name}: thân vá chứa thẻ ${tag}`)
    const original = b.block.replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION')
    if (x.core) {
      if (!x.wrapper) throw new Error(`${x.name}: core cần wrapper`)
      if (x.core.name === 'cms__close_report_save') {
        const sp = closeScanSplit(body)
        body = sp.body
        scanBlock = sp.block
      }
      cores.push({ ...x.core, md5: md5(body), block: x.core.head + tag + body + tag + ';' })
      return { ...x, base: md5(b.body), md5: null, block: null, original }
    }
    const block = head.replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION') + body + tag + ';'
    return { ...x, base: md5(b.body), md5: md5(body), block, original }
  })

  // cms__report_rows2 = cms__report_rows 130 + tham số từ điển.
  const rr = bodies130.get('cms__report_rows')
  if (!rr) throw new Error('không thấy cms__report_rows')
  const rr2body = once(rr.body, 'public.cms__return_status_effect(r.return_status)', 'public.cms__return_status_effect_v(p_dict, r.return_status)')
  const rr2 = once(rr.block, 'CREATE FUNCTION public.cms__report_rows(p_rows jsonb)', 'CREATE FUNCTION public.cms__report_rows2(p_dict text, p_rows jsonb)')
    .split(rr.body).join(rr2body)
  if (!rr2.includes('cms__report_rows2(p_dict text, p_rows jsonb)') || rr2.split(rr2body).length !== 2) throw new Error('report_rows2 sinh lỗi')

  // r2 (Q-238 b): khối phân loại N1(c) NGUYÊN VĂN từ seal 130 bước 4 (cms__run_unit_check tính lại phân loại / E — một nguồn, không chép
  // tay). Phải xuất hiện đúng một lần ở 130 và còn nguyên trong thân seal 132 (132 không vá bước 4).
  const N1C_START = '    WITH pk AS MATERIALIZED ('
  const N1C_END = '      INTO v_code, v_bad FROM c;'
  const sealBody = bodies130.get('cms__seal_contract_step').body
  const n1a = sealBody.indexOf(N1C_START), n1b = sealBody.indexOf(N1C_END)
  if (n1a < 0 || n1b < n1a || sealBody.indexOf(N1C_START, n1a + 1) >= 0 || sealBody.indexOf(N1C_END, n1b + 1) >= 0) throw new Error('khối N1(c) seal 130 lạ')
  const n1c = sealBody.slice(n1a, n1b + N1C_END.length)
  const seal132 = replaced.find((x) => x.name === 'cms__seal_contract_step')
  if (!seal132 || seal132.block.split(n1c).length !== 2) throw new Error('khối N1(c) không còn nguyên trong seal 132')
  if (!/v_unit/.test(n1c) || /v_from|v_to|v_net|v_full|v_exp/.test(n1c)) throw new Error('khối N1(c) dùng biến ngoài v_unit / v_run / p_run_id')

  let mig = tpl
  mig = once(mig, '@@UNIT_CLASS_N1C@@', n1c)
  mig = once(mig, '@@REPORT_ROWS2@@', rr2)
  if (!scanBlock) throw new Error('chưa tách cms__close_report_scan')
  mig = once(mig, '@@CLOSE_SCAN@@', scanBlock)
  mig = once(mig, '@@CORE_BLOCKS@@', cores.map((x) => x.block).join('\n\n'))
  mig = once(mig, '@@REPLACED_BLOCKS@@', replaced.filter((x) => x.block).map((x) => x.block).join('\n\n'))
  mig = once(mig, '@@NEW_NAMES@@', CMS_132_NEW.map((x) => `'${x.name}'`).join(', '))
  mig = once(mig, '@@CONSTRAINTS@@', CMS_132_CONSTRAINTS.map(([r, c], i) => `('${r}'${i === 0 ? '::text' : ''}, '${c}'${i === 0 ? '::text' : ''})`).join(', '))
  mig = once(mig, '@@ACL_REPLACED@@', replaced.map((x, i) => {
    const want = x.grant ? x.grant.split(',').sort().join(',') : null
    return `('${x.sig}'${i === 0 ? '::text' : ''}, ${want ? `'${want}'` : 'NULL'}${i === 0 ? '::text' : ''})`
  }).join(', '))
  mig = once(mig, '@@PREFLIGHT_MD5@@', md5Check(replaced, 'base'))
  mig = once(mig, '@@N_REPLACED@@', String(replaced.length), 4)
  mig = once(mig, '@@N_NEW@@', String(CMS_132_NEW.length))
  mig = once(mig, '@@REVOKE_LIST@@', CMS_132_ALL.map((x) => `public.${x.sig}`).join(',\n  '))
  mig = once(mig, '@@GRANTS@@', CMS_132_ALL.filter((x) => x.grant).map((x) =>
    `GRANT EXECUTE ON FUNCTION public.${x.sig} TO ${x.grant.split(',').map((g) => g.split(':')[0]).join(', ')};`).join('\n'))
  mig = once(mig, '@@ACL_VALUES@@', aclValues(CMS_132_ALL), 2)
  // VERIFY (db-reviewer 18/11 P1): danh sách chữ ký + số kỳ vọng tính từ CHÍNH ma trận ACL ở trên (không gõ tay).
  const hasRole = (x, role) => (x.grant ?? '').split(',').some((g) => g.split(':')[0] === role)
  mig = once(mig, '@@VERIFY_SIGS@@', CMS_132_ALL.map((x) => `'${x.sig}'`).join(', '))
  mig = once(mig, '@@VERIFY_EXPECT@@', `n = ${CMS_132_ALL.length} · anon_x = 0 · auth_x = ${CMS_132_ALL.filter((x) => hasRole(x, 'authenticated')).length}`
    + ` · svc_x = ${CMS_132_ALL.filter((x) => hasRole(x, 'service_role')).length} · secdef = ${CMS_132_ALL.length} · sp = ${CMS_132_ALL.length}`)
  const newBodies = cmsFunctionBodies(mig)
  // Lõi sinh từ thân vá phải khớp md5 sau ghép; wrapper (thân template) lấy md5 từ bản ghép.
  for (const c of cores) {
    if (!newBodies.get(c.name) || md5(newBodies.get(c.name).body) !== c.md5) throw new Error(`md5 lõi ${c.name} lệch sau ghép`)
  }
  for (const x of replaced) {
    if (x.wrapper) {
      const w = newBodies.get(x.name)
      if (!w || !w.replace || !w.body.includes(`public.${x.core.name}(`)) throw new Error(`wrapper ${x.name} thiếu / không gọi lõi`)
      x.md5 = md5(w.body)
    }
  }
  const all = [...CMS_132_NEW.map((x) => ({ ...x, md5: md5(newBodies.get(x.name).body) })), ...replaced]
  for (const x of all) {
    if (md5(newBodies.get(x.name).body) !== x.md5) throw new Error(`md5 ${x.name} lệch sau ghép`)
  }
  mig = once(mig, '@@POSTCHECK_MD5@@', ['DO $$', 'BEGIN', `  IF ${md5Check(all, 'md5')} THEN`,
    `    RAISE EXCEPTION '132 hậu kiểm: thân ${all.length} hàm mới / thay lệch bản sinh (md5)';`, '  END IF;', 'END $$;'].join('\n'))
  // r2 (db-reviewer r2 P2-5): VERIFY V9 — cùng danh sách + md5 của hậu kiểm, chạy lại SAU COMMIT (bằng chứng thân hàm còn đúng bản sinh).
  mig = once(mig, '@@VERIFY_MD5@@', all.map((x) => `('${x.sig}', '${x.md5}')`).join(',\n--            '))
  mig = once(mig, '@@N_ALL@@', String(all.length))
  if (/@@[A-Z_0-9]+@@/.test(mig)) throw new Error('còn placeholder chưa điền')

  // Rollback: khôi phục nguyên văn thân 130, trả ràng buộc 130, bỏ cột / hàm 132. DỪNG nếu đã có dữ liệu full_line.
  const rbRole = (x, role) => String((x.grant ?? '').split(',').some((g) => g.split(':')[0] === role))
  const def130 = (rel, con) => {
    // Định nghĩa ràng buộc nền lấy từ chính DB lúc rollback là không được (đã bị thay) ⇒ ghi cứng theo 130 ở đây.
    const m = CMS_132_ROLLBACK_CONSTRAINTS[`${rel}.${con}`]
    if (!m) throw new Error(`thiếu định nghĩa rollback ${rel}.${con}`)
    return m
  }
  const rb = [
    '-- ============================================================================',
    '-- rollback/132_cms_returns_full_line_rollback.sql  (CANDIDATE — sinh bằng webapp/scripts/gen-cms-132.mjs; KHÔNG sửa tay)',
    '-- Gỡ 132 về đúng nền 131. Thứ tự: tắt CMS_RETURNS_ENABLED → app bridge vẫn chạy được trên 131 → file này. DỪNG (không xoá gì) nếu đã',
    '-- có chương trình / run / baseline / báo cáo full_line: đó là lịch sử tài chính — sàn rollback = app bridge (design r1 §8).',
    "-- Khôi phục NGUYÊN VĂN thân 130 của các hàm thay + ràng buộc 130. Gồm DELETE FROM app_migrations WHERE version = '132'.",
    '-- READ COMMITTED; đúng role owner; giữ LF.',
    '-- ============================================================================',
    '',
    'BEGIN;',
    "SET LOCAL lock_timeout = '5s';",
    'LOCK TABLE public.cms_programs, public.cms_sync_runs, public.cms_return_lines, public.cms_result_events, public.cms_return_baselines,',
    '           public.cms_return_close_reports, public.cms_return_close_report_lines, public.cms_return_close_report_events,',
    '           public.cms_payouts, public.cms_source_attestations IN ACCESS EXCLUSIVE MODE;',
    '',
    'DO $$',
    'DECLARE',
    '  v_name text;',
    'BEGIN',
    "  IF current_setting('transaction_isolation') <> 'read committed' THEN",
    "    RAISE EXCEPTION 'rollback 132: cần READ COMMITTED';",
    '  END IF;',
    "  SELECT name INTO v_name FROM public.app_migrations WHERE version = '132';",
    "  IF v_name IS DISTINCT FROM 'cms_returns_full_line' THEN",
    "    RAISE EXCEPTION 'rollback 132: không có marker 132 cms_returns_full_line (name = %)', v_name;",
    '  END IF;',
    // db-reviewer 18/11 P2-4: cả bản adhoc kiểu 132a (tiền tố số = 132 + hậu tố) hoặc tiền tố số > 132.
    "  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE version ~ '^[0-9]+'",
    "              AND ((substring(version FROM '^[0-9]+'))::int > 132 OR version ~ '^132[^0-9]')) THEN",
    "    RAISE EXCEPTION 'rollback 132: DB đã có migration sau 132 (số > 132 hoặc adhoc 132x) — gỡ bản sau trước';",
    '  END IF;',
    '  -- Thân hàm hiện tại phải đúng bản 132 đã sinh (md5 bỏ CR) — không ghi đè một bản đã bị sửa tay / hotfix chưa ghi nhận.',
    `  IF ${md5Check(all, 'md5').split('\n').join('\n  ')} THEN`,
    `    RAISE EXCEPTION 'rollback 132: thân ${all.length} hàm mới / thay khác bản 132 (md5) — dừng, đối chiếu tay';`,
    '  END IF;',
    '  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r0 WHERE r0.rolname = current_user AND (r0.rolsuper OR r0.rolbypassrls)) THEN',
    "    RAISE EXCEPTION 'rollback 132: role chạy (%) không phải superuser / BYPASSRLS', current_user;",
    '  END IF;',
    "  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE status = 'running') THEN",
    "    RAISE EXCEPTION 'rollback 132: còn run đang chạy';",
    '  END IF;',
    "  IF EXISTS (SELECT 1 FROM public.cms_programs WHERE returns_policy = 'full_line_qty_refund_v1')",
    "     OR EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE returns_policy = 'full_line_qty_refund_v1' OR calc_contract_version = 'cms-calc-ret2-v2')",
    "     OR EXISTS (SELECT 1 FROM public.cms_return_lines WHERE returns_policy <> 'net_returns_v1')",
    "     OR EXISTS (SELECT 1 FROM public.cms_return_baselines WHERE fp_version <> 'cms-return-fp-v1')",
    "     OR EXISTS (SELECT 1 FROM public.cms_return_close_reports WHERE returns_profile <> 'net_returns_v1')",
    "     OR EXISTS (SELECT 1 FROM public.cms_result_events WHERE kind = 'RETURN' AND base_delta = 0) THEN",
    "    RAISE EXCEPTION 'rollback 132: đã có dữ liệu full_line — DỪNG, sàn rollback = app bridge (không gỡ 132)';",
    '  END IF;',
    "  -- r1: lần chốt run contract / báo cáo phiên super (lý do) / dòng báo cáo run contract là lịch sử tài chính — 130 không đọc được ⇒ DỪNG.",
    "  IF EXISTS (SELECT 1 FROM public.cms_payouts WHERE calc_contract_version IS NOT NULL)",
    "     OR EXISTS (SELECT 1 FROM public.cms_return_close_reports WHERE manual_reason IS NOT NULL)",
    "     OR EXISTS (SELECT 1 FROM public.cms_return_close_report_lines WHERE frozen_return_base IS NOT NULL)",
    "     OR EXISTS (SELECT 1 FROM public.cms_return_close_report_events WHERE pre_lock IS NOT NULL) THEN",
    "    RAISE EXCEPTION 'rollback 132: đã có chốt run contract / báo cáo phiên super — DỪNG, sàn rollback = app bridge (không gỡ 132)';",
    '  END IF;',
    "  -- r2: chứng nhận nguồn cms_unit (decision_unit14) là bằng chứng chốt bất biến (guard 124 cấm xoá) — 124 không nhận ⇒ DỪNG.",
    "  IF EXISTS (SELECT 1 FROM public.cms_source_attestations WHERE field_set <> 'decision10') THEN",
    "    RAISE EXCEPTION 'rollback 132: đã có chứng nhận nguồn cms_unit (decision_unit14) — DỪNG, sàn rollback = app bridge (không gỡ 132)';",
    '  END IF;',
    'END $$;',
    '',
    '-- Khôi phục NGUYÊN VĂN thân 130 của các hàm thay.',
    ...replaced.flatMap((x) => [x.original, '']),
    // r3: danh sách DROP SINH từ CMS_132_NEW (ngược thứ tạo; không gõ tay — db-reviewer / PM r2 "không số cứng"); cms__return_status_effect_v
    // bỏ SAU khi gỡ CHECK cms_return_lines_effect (bên dưới). Hàm khôi phục 130 / 124 không gọi hàm mới nào; chứng nhận cms_unit đã kiểm
    // không có dòng decision_unit14 ở trên.
    '-- Hàm mới 132 (trừ cms__return_status_effect_v — CHECK cms_return_lines_effect còn dùng, bỏ sau).',
    ...CMS_132_NEW.filter((x) => x.name !== 'cms__return_status_effect_v').slice().reverse().map((x) => `DROP FUNCTION public.${x.sig};`),
    'ALTER TABLE public.cms_source_attestations DROP CONSTRAINT cms_source_attest_version;',
    ...['fp_version', 'field_set', 'tool_version'].map((c, i, a) =>
      `${i === 0 ? 'ALTER TABLE public.cms_source_attestations' : ''}\n  ADD CONSTRAINT cms_source_attestations_${c}_check ${def130('cms_source_attestations', `cms_source_attestations_${c}_check`)}${i === a.length - 1 ? ';' : ','}`),
    '-- r1: cột / ràng buộc chốt run contract + báo cáo phiên super (đã kiểm rỗng ở trên).',
    'ALTER TABLE public.cms_payouts DROP CONSTRAINT cms_payouts_contract_run_fk, DROP CONSTRAINT cms_payouts_contract_shape;',
    'ALTER TABLE public.cms_payouts DROP COLUMN calc_contract_version, DROP COLUMN quantity_basis, DROP COLUMN returns_policy,',
    '  DROP COLUMN returns_as_of, DROP COLUMN returns_digest, DROP COLUMN ledger_eval_seq;',
    'ALTER TABLE public.cms_return_close_report_events DROP CONSTRAINT cms_return_close_report_events_pre_lock, DROP COLUMN pre_lock;',
    'ALTER TABLE public.cms_return_close_report_lines DROP CONSTRAINT cms_return_close_report_lines_math;',
    `ALTER TABLE public.cms_return_close_report_lines ADD CONSTRAINT cms_return_close_report_lines_math ${def130('cms_return_close_report_lines', 'cms_return_close_report_lines_math')};`,
    'ALTER TABLE public.cms_return_close_report_lines DROP COLUMN frozen_return_base, DROP COLUMN frozen_return_gmv;',
    'ALTER TABLE public.cms_return_close_reports DROP CONSTRAINT cms_return_close_reports_request_uniq,',
    '  DROP CONSTRAINT cms_return_close_reports_manual;',
    'ALTER TABLE public.cms_return_close_reports DROP COLUMN manual_reason, DROP COLUMN manual_request;',
    '-- Ràng buộc 130.',
    'ALTER TABLE public.cms_return_close_report_events DROP CONSTRAINT cms_return_close_report_events_qty,',
    '  DROP CONSTRAINT cms_return_close_report_events_profile_fk;',
    'ALTER TABLE public.cms_return_close_report_events ALTER COLUMN base SET NOT NULL;',
    `ALTER TABLE public.cms_return_close_report_events ADD CONSTRAINT cms_return_close_report_events_base_check ${def130('cms_return_close_report_events', 'cms_return_close_report_events_base_check')};`,
    'ALTER TABLE public.cms_return_close_report_events DROP COLUMN qty_effect, DROP COLUMN returns_profile;',
    'ALTER TABLE public.cms_return_close_reports DROP CONSTRAINT cms_return_close_reports_profile_bind,',
    '  DROP CONSTRAINT cms_return_close_reports_versions;',
    ...['calc_contract_version', 'fp_version', 'status_dictionary_version'].map((c) =>
      `ALTER TABLE public.cms_return_close_reports ADD CONSTRAINT cms_return_close_reports_${c}_check ${def130('cms_return_close_reports', `cms_return_close_reports_${c}_check`)};`),
    'ALTER TABLE public.cms_return_close_reports DROP COLUMN returns_profile;',
    'ALTER TABLE public.cms_return_baselines DROP CONSTRAINT cms_return_baselines_fp_version_check,',
    '  DROP CONSTRAINT cms_return_baselines_base_quantity_check;',
    'ALTER TABLE public.cms_return_baselines ALTER COLUMN base_quantity SET NOT NULL;',
    `ALTER TABLE public.cms_return_baselines ADD CONSTRAINT cms_return_baselines_fp_version_check ${def130('cms_return_baselines', 'cms_return_baselines_fp_version_check')},`,
    `  ADD CONSTRAINT cms_return_baselines_base_quantity_check ${def130('cms_return_baselines', 'cms_return_baselines_base_quantity_check')};`,
    'ALTER TABLE public.cms_result_events DROP CONSTRAINT cms_result_events_sign;',
    `ALTER TABLE public.cms_result_events ADD CONSTRAINT cms_result_events_sign ${def130('cms_result_events', 'cms_result_events_sign')};`,
    'ALTER TABLE public.cms_return_lines DROP CONSTRAINT cms_return_lines_shape, DROP CONSTRAINT cms_return_lines_effect,',
    '  DROP CONSTRAINT cms_return_lines_policy_fk, DROP CONSTRAINT cms_return_lines_policy;',
    `ALTER TABLE public.cms_return_lines ADD CONSTRAINT cms_return_lines_effect ${def130('cms_return_lines', 'cms_return_lines_effect')},`,
    `  ADD CONSTRAINT cms_return_lines_shape ${def130('cms_return_lines', 'cms_return_lines_shape')};`,
    'ALTER TABLE public.cms_return_lines DROP COLUMN returns_policy;',
    'DROP FUNCTION public.cms__return_status_effect_v(text,text);',
    'ALTER TABLE public.cms_sync_runs DROP CONSTRAINT cms_sync_runs_policy_bind, DROP CONSTRAINT cms_sync_runs_contract_ok,',
    '  DROP CONSTRAINT cms_sync_runs_ledger_shape, DROP CONSTRAINT cms_sync_runs_returns_shape, DROP CONSTRAINT cms_sync_runs_contract_shape;',
    ...['contract_shape', 'returns_shape', 'ledger_shape', 'contract_ok'].map((c, i, a) =>
      `${i === 0 ? 'ALTER TABLE public.cms_sync_runs' : ''}\n  ADD CONSTRAINT cms_sync_runs_${c} ${def130('cms_sync_runs', `cms_sync_runs_${c}`)}${i === a.length - 1 ? ';' : ','}`),
    'ALTER TABLE public.cms_programs DROP CONSTRAINT cms_programs_policy_actor, DROP CONSTRAINT cms_programs_returns_policy_value;',
    `ALTER TABLE public.cms_programs ADD CONSTRAINT cms_programs_returns_policy_value ${def130('cms_programs', 'cms_programs_returns_policy_value')},`,
    `  ADD CONSTRAINT cms_programs_policy_actor ${def130('cms_programs', 'cms_programs_policy_actor')};`,
    '-- ACL các hàm khôi phục: đúng ma trận 130.',
    'REVOKE ALL ON FUNCTION ' + replaced.map((x) => `public.${x.sig}`).join(',\n  ') + '\n  FROM PUBLIC, anon, authenticated, service_role;',
    ...replaced.filter((x) => x.grant).map((x) =>
      `GRANT EXECUTE ON FUNCTION public.${x.sig} TO ${x.grant.split(',').map((g) => g.split(':')[0]).join(', ')};`),
    '',
    'DO $$',
    'BEGIN',
    `  IF ${md5Check(replaced, 'base')} THEN`,
    `    RAISE EXCEPTION 'rollback 132 hậu kiểm: thân ${replaced.length} hàm khôi phục khác nền 130 (md5)';`,
    '  END IF;',
    "  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (" + CMS_132_NEW.map((x) => `'${x.name}'`).join(', ') + '))',
    "     OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE NOT attisdropped AND attnum > 0",
    "                 AND ((attrelid = 'public.cms_return_lines'::regclass AND attname = 'returns_policy')",
    "                   OR (attrelid = 'public.cms_return_close_reports'::regclass AND attname = 'returns_profile')",
    "                   OR (attrelid = 'public.cms_return_close_report_events'::regclass AND attname IN ('returns_profile', 'qty_effect', 'pre_lock'))",
    "                   OR (attrelid = 'public.cms_return_close_reports'::regclass AND attname IN ('manual_reason', 'manual_request'))",
    "                   OR (attrelid = 'public.cms_return_close_report_lines'::regclass AND attname IN ('frozen_return_base', 'frozen_return_gmv'))",
    "                   OR (attrelid = 'public.cms_payouts'::regclass AND attname IN ('calc_contract_version', 'quantity_basis', 'returns_policy',",
    "                                                                                 'returns_as_of', 'returns_digest', 'ledger_eval_seq')))) THEN",
    "    RAISE EXCEPTION 'rollback 132 hậu kiểm: còn đối tượng 132';",
    '  END IF;',
    "  IF (SELECT public.rpc_cms_capabilities() -> 'paths') ?| ARRAY['full_line', 'manual_report', 'unit_attest']",
    "     OR (SELECT public.rpc_cms_capabilities() -> 'paths' -> 'lock_contract' ->> 'ok') IS DISTINCT FROM 'false' THEN",
    "    RAISE EXCEPTION 'rollback 132 hậu kiểm: capabilities còn đường full_line / manual_report / unit_attest / lock_contract';",
    '  END IF;',
    '  -- db-reviewer 18/11 P2-4: ACL các hàm khôi phục đúng ma trận 130 (anon không; authenticated / service_role theo 130).',
    '  IF EXISTS (SELECT 1 FROM (VALUES ' + replaced.map((x) => `('${x.sig}', ${rbRole(x, 'authenticated')}, ${rbRole(x, 'service_role')})`).join(',\n                 ')
      + ') AS m(sig, au, sv)',
    "             WHERE to_regprocedure('public.' || m.sig) IS NULL",
    "                OR has_function_privilege('anon', to_regprocedure('public.' || m.sig), 'EXECUTE')",
    "                OR has_function_privilege('authenticated', to_regprocedure('public.' || m.sig), 'EXECUTE') IS DISTINCT FROM m.au",
    "                OR has_function_privilege('service_role', to_regprocedure('public.' || m.sig), 'EXECUTE') IS DISTINCT FROM m.sv) THEN",
    "    RAISE EXCEPTION 'rollback 132 hậu kiểm: ACL hàm khôi phục lệch ma trận 130';",
    '  END IF;',
    'END $$;',
    '',
    "DELETE FROM public.app_migrations WHERE version = '132';",
    '',
    'COMMIT;',
    '',
    '-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — bọc BEGIN READ ONLY; … COMMIT;) ──────────────────────────────────────────────────────────',
    "-- R1 marker — 1 dòng: 131 cms_program_revision (không còn 132).",
    "--   SELECT version, name FROM public.app_migrations WHERE version IN ('131', '132') ORDER BY 1;",
    `-- R2 ACL hàm khôi phục — n = ${replaced.length} · anon_x = 0 · auth_x = ${replaced.filter((x) => rbRole(x, 'authenticated') === 'true').length}`
      + ` · svc_x = ${replaced.filter((x) => rbRole(x, 'service_role') === 'true').length} · secdef = ${replaced.length} · sp = ${replaced.length} · new_left = 0.`,
    "--   SELECT count(*) n, count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE')) anon_x,",
    "--          count(*) FILTER (WHERE has_function_privilege('authenticated', p.oid, 'EXECUTE')) auth_x,",
    "--          count(*) FILTER (WHERE has_function_privilege('service_role', p.oid, 'EXECUTE')) svc_x,",
    "--          count(*) FILTER (WHERE p.prosecdef) secdef, count(*) FILTER (WHERE 'search_path=public' = ANY (p.proconfig)) sp,",
    "--          (SELECT count(*) FROM pg_proc q WHERE q.pronamespace = 'public'::regnamespace AND q.proname IN ("
      + CMS_132_NEW.map((x) => `'${x.name}'`).join(', ') + ')) new_left',
    "--     FROM pg_proc p WHERE p.oid IN (SELECT to_regprocedure('public.' || s) FROM unnest(ARRAY["
      + replaced.map((x) => `'${x.sig}'`).join(', ') + ']) s);',
    "-- R3 năng lực — paths không còn khoá full_line; 5 đường cũ như 130.",
    '--   SELECT public.rpc_cms_capabilities();',
    '',
  ].join('\n')
  // r3: mọi hàm mới bị DROP đúng một lần; không DROP hàm thay (khôi phục nguyên văn ở trên).
  for (const x of CMS_132_NEW) {
    if (rb.split(`DROP FUNCTION public.${x.sig};`).length !== 2) throw new Error(`rollback: DROP ${x.name} không đúng một lần`)
  }
  if ((rb.match(/^DROP FUNCTION /gm) ?? []).length !== CMS_132_NEW.length) throw new Error('rollback: số DROP FUNCTION ≠ số hàm mới')
  return { migration: mig, rollback: rb, replaced, sha: { migration: sha256(mig), rollback: sha256(rb) } }
}

/** Định nghĩa ràng buộc 130 (nguyên văn khối CHECK của 130) cho rollback — harness so với pg_get_constraintdef trước 132. */
export const CMS_132_ROLLBACK_CONSTRAINTS = Object.freeze({
  'cms_programs.cms_programs_returns_policy_value': `CHECK (returns_policy IN ('sales_only_v1', 'net_returns_v1'))`,
  'cms_programs.cms_programs_policy_actor': `CHECK (
    (returns_policy = 'net_returns_v1') = (returns_policy_set_by IS NOT NULL)
    AND (returns_policy_set_by IS NULL) = (returns_policy_set_at IS NULL))`,
  'cms_sync_runs.cms_sync_runs_contract_shape': `CHECK (
    (quantity_basis IS NULL AND quantity_policy_version IS NULL AND returns_policy IS NULL AND calc_contract_version IS NULL
       AND unit_key_version IS NULL AND status_dictionary_version IS NULL)
    OR (kind = 'sales' AND quantity_basis IS NOT NULL AND quantity_policy_version IS NOT NULL AND returns_policy IS NOT NULL
        AND calc_contract_version IS NOT NULL AND unit_key_version IS NOT NULL AND status_dictionary_version IS NOT NULL
        AND ((quantity_basis = 'pos_base' AND quantity_policy_version = 'pos_base_v1')
             OR (quantity_basis = 'cms_unit' AND quantity_policy_version = 'cms_unit_v2'))
        AND returns_policy IN ('sales_only_v1', 'net_returns_v1')
        AND (quantity_basis = 'cms_unit' OR returns_policy = 'net_returns_v1')
        AND calc_contract_version = 'cms-calc-ret2-v1' AND unit_key_version = 'cms-unit-key-v2'
        AND status_dictionary_version = 'cms-return-status-v1'))`,
  'cms_sync_runs.cms_sync_runs_returns_shape': `CHECK (
    (returns_policy IS DISTINCT FROM 'net_returns_v1' AND returns_as_of IS NULL AND returns_digest IS NULL AND returns_rows_read IS NULL)
    OR (returns_policy IS NOT DISTINCT FROM 'net_returns_v1'
        AND (sealed_at IS NULL) = (returns_as_of IS NULL) AND (sealed_at IS NULL) = (returns_digest IS NULL)
        AND (sealed_at IS NULL) = (returns_rows_read IS NULL)))`,
  'cms_sync_runs.cms_sync_runs_ledger_shape': `CHECK (
    (ledger_verdict IS NULL) = (ledger_set_hash IS NULL) AND (ledger_verdict IS NULL) = (ledger_checked_at IS NULL)
    AND (ledger_verdict IS NULL OR calc_contract_version IS NOT NULL)
    AND (ledger_eval_seq IS NULL OR (ledger_verdict IS NOT NULL AND returns_policy IS NOT DISTINCT FROM 'net_returns_v1')))`,
  'cms_sync_runs.cms_sync_runs_contract_ok': `CHECK (
    calc_contract_version IS NULL OR status IS DISTINCT FROM 'ok'
    OR (ledger_verdict IS NOT DISTINCT FROM 'CLEAN' AND ledger_set_hash IS NOT NULL AND ledger_checked_at IS NOT NULL
        AND (returns_policy IS DISTINCT FROM 'net_returns_v1' OR ledger_eval_seq IS NOT NULL)))`,
  'cms_return_lines.cms_return_lines_effect': `CHECK (status_effect IS NOT DISTINCT FROM public.cms__return_status_effect(return_status))`,
  'cms_return_lines.cms_return_lines_shape': `CHECK (
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
        AND (original_quantity_src_flag IS NULL OR original_quantity_src IS NULL)
        AND (original_uom_src_flag IS NULL OR original_uom_src IS NULL)
        AND (sale_ref_line_id IS NOT NULL) = (disposition IN ('APPLIED', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE'))
        AND (sale_ref_line_id IS NULL OR sale_ref_line_id = original_order_line_id)))`,
  'cms_result_events.cms_result_events_sign': `CHECK (
    (kind = 'SALE' AND base_delta >= 0 AND eligible_delta >= 0 AND gmv_delta >= 0 AND amount_vnd >= 0
       AND status IN ('WAITING_GATE', 'ACCUMULATING', 'RECORDED', 'NOT_COUNTED'))
    OR (kind = 'RETURN' AND base_delta < 0 AND eligible_delta <= 0 AND gmv_delta <= 0 AND amount_vnd <= 0
        AND status IN ('WAITING_GATE', 'RETURN_REDUCED', 'RETURN_NO_CHANGE')))`,
  'cms_return_baselines.cms_return_baselines_fp_version_check': `CHECK (fp_version = 'cms-return-fp-v1')`,
  'cms_return_baselines.cms_return_baselines_base_quantity_check': `CHECK (base_quantity > 0 AND scale(base_quantity) = 0 AND base_quantity < 1e29)`,
  'cms_return_close_reports.cms_return_close_reports_calc_contract_version_check': `CHECK (calc_contract_version = 'cms-calc-ret2-v1')`,
  'cms_return_close_reports.cms_return_close_reports_fp_version_check': `CHECK (fp_version = 'cms-return-fp-v1')`,
  'cms_return_close_reports.cms_return_close_reports_status_dictionary_version_check': `CHECK (status_dictionary_version = 'cms-return-status-v1')`,
  'cms_return_close_report_events.cms_return_close_report_events_base_check': `CHECK (base > 0 AND scale(base) = 0)`,
  'cms_return_close_report_lines.cms_return_close_report_lines_math': `CHECK (
    delta = recomputed_amount - frozen_amount AND eligible_base = frozen_base - return_base AND net_gmv = frozen_gmv - return_gmv
    AND (return_events = 0) = (return_base = 0))`,
  // r2: CHECK cột của 124 (đặt lại đúng tên tự sinh khi rollback).
  'cms_source_attestations.cms_source_attestations_fp_version_check': `CHECK (fp_version = 'cms-rows-fp-v1')`,
  'cms_source_attestations.cms_source_attestations_field_set_check': `CHECK (field_set = 'decision10')`,
  'cms_source_attestations.cms_source_attestations_tool_version_check': `CHECK (tool_version = 'cms-i4-compare-v1')`,
})

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const { migration, rollback, sha, replaced } = buildCms132()
  if (process.argv.includes('--check')) {
    const a = fs.existsSync(CMS_132_FILE) ? fs.readFileSync(CMS_132_FILE, 'utf8') : null
    const b = fs.existsSync(CMS_132_ROLLBACK_FILE) ? fs.readFileSync(CMS_132_ROLLBACK_FILE, 'utf8') : null
    const okA = a === migration, okB = b === rollback
    console.log(`132 ${okA ? 'KHỚP' : 'LỆCH'} · rollback ${okB ? 'KHỚP' : 'LỆCH'}`)
    process.exit(okA && okB ? 0 : 1)
  }
  fs.writeFileSync(CMS_132_FILE, migration)
  fs.writeFileSync(CMS_132_ROLLBACK_FILE, rollback)
  for (const x of replaced) console.log(`${x.name.padEnd(40)} nền ${x.base} → ${x.md5}`)
  console.log(`ghi 132 sha256 ${sha.migration}\nghi rollback sha256 ${sha.rollback}`)
}
