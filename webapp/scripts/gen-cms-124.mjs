#!/usr/bin/env node
// CMS 124 (COMP-INT — chứng nhận đối soát nguồn): SINH supabase/migrations/124_cms_source_attestation.sql + rollback từ
// scripts/cms-124/*.sql + thân hàm 122 / 123 NGUYÊN VĂN (chỉ chèn / thay đúng các đoạn dưới). Mỗi chỗ vá phải khớp ĐÚNG MỘT lần
// (split/join — không String.replace để không ăn `$$`). KHÔNG sửa tay file sinh ra; sửa template / chỗ vá rồi sinh lại.
//   node scripts/gen-cms-124.mjs            # ghi 2 file, in sha256
//   node scripts/gen-cms-124.mjs --check    # chỉ so: file trên đĩa ≠ bản sinh ⇒ thoát 1 (test drift: scripts/qa-cms-124.mjs)
// Hàm thay (6): 122 rpc_cms_sales_run_open / rpc_cms_sales_run_stage / rpc_cms_sales_run_cleanup · 123 cms__lock_eval /
// rpc_cms_payout (OR REPLACE, giữ chữ ký + ACL) · 123 rpc_cms_program_lock (DROP 5 tham số + CREATE 6 tham số).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
export const CMS_124_FILE = path.join(MIG, '124_cms_source_attestation.sql')
export const CMS_124_ROLLBACK_FILE = path.join(MIG, 'rollback', '124_cms_source_attestation_rollback.sql')

/** Thân `CREATE FUNCTION public.<name>(` … `$$;` của file migration. */
function fn(sql, name) {
  const i = sql.indexOf(`CREATE FUNCTION public.${name}(`)
  if (i < 0 || sql.indexOf(`CREATE FUNCTION public.${name}(`, i + 1) >= 0) throw new Error(`hàm ${name}: không thấy hoặc trùng`)
  const j = sql.indexOf('$$;', sql.indexOf('AS $$', i) + 5)
  return sql.slice(i, j + 3)
}
function patch(text, from, to, label) {
  const n = text.split(from).length - 1
  if (n !== 1) throw new Error(`vá "${label}": khớp ${n} lần (cần đúng 1)`)
  return text.split(from).join(to)
}
const orReplace = (t) => patch(t, 'CREATE FUNCTION public.', 'CREATE OR REPLACE FUNCTION public.', 'OR REPLACE')
/** prosrc = chuỗi giữa `AS $$` và `$$;` cuối (md5 khớp md5(prosrc) của DB). */
export const cmsProsrc = (t) => t.slice(t.indexOf('AS $$') + 5, t.lastIndexOf('$$;'))
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')

export function buildCms124() {
  const S122 = fs.readFileSync(path.join(MIG, '122_cms_results.sql'), 'utf8')
  const S123 = fs.readFileSync(path.join(MIG, '123_cms_payouts.sql'), 'utf8')
  const tpl = (f) => fs.readFileSync(path.join(HERE, 'cms-124', f), 'utf8')

  // ── rpc_cms_sales_run_open (122) — trả source_schema THỰC của run vừa tạo (PM COMP-INT §4) ─────────────────────
  const OPEN0 = fn(S122, 'rpc_cms_sales_run_open')
  let open = orReplace(OPEN0)
  open = patch(open, '  v_id   uuid;\n', '  v_id   uuid;\n  v_sch  smallint;  -- 124\n', 'open declare')
  open = patch(open, '  RETURNING id INTO v_id;\n  RETURN v_snap || jsonb_build_object(\'run_id\', v_id);',
    '  RETURNING id, source_schema INTO v_id, v_sch;\n  -- 124: capability lớp nguồn = giá trị THỰC của run vừa INSERT (DEFAULT 1 sau 124) — app không tự suy.\n  RETURN v_snap || jsonb_build_object(\'run_id\', v_id, \'source_schema\', v_sch);', 'open return')

  // ── rpc_cms_sales_run_stage (122) — thêm part 'source_lines' ─────────────────
  const STAGE0 = fn(S122, 'rpc_cms_sales_run_stage')
  let stage = orReplace(STAGE0)
  stage = patch(stage, "IF p_part IS NULL OR p_part NOT IN ('sales_lines', 'results', 'catalog', 'result_lines') THEN",
    "IF p_part IS NULL OR p_part NOT IN ('sales_lines', 'results', 'catalog', 'result_lines', 'source_lines') THEN", 'stage part')
  stage = patch(stage, "  c_t50  CONSTANT text := '^[^\\x01-\\x1f\\x7f-\\x9f]{1,50}$';\n",
    "  c_t50  CONSTANT text := '^[^\\x01-\\x1f\\x7f-\\x9f]{1,50}$';\n  c_t30  CONSTANT text := '^[^\\x01-\\x1f\\x7f-\\x9f]{1,30}$';  -- 124: order_type / order_status thô\n", 'stage c_t30')
  stage = patch(stage, "OR (p_part IN ('sales_lines', 'result_lines') AND jsonb_path_exists(",
    "OR (p_part IN ('sales_lines', 'result_lines', 'source_lines') AND jsonb_path_exists(", 'stage boolean')
  const SRC_COLS = `x(order_line_id text, order_id text, order_code text, product_id text,
             seller_email text, pos_code text, order_type text, order_status text, completed_at text, source_updated_at text,
             quantity_raw text, uom_raw text, base_quantity text, gmv_amount text)`
  stage = patch(stage, "  IF p_part = 'sales_lines' THEN\n    IF EXISTS (", `  IF p_part = 'source_lines' THEN
    -- 124: lớp NGUỒN — chỉ run mở sau 124 (source_schema = 1). MỌI dòng hợp lệ adapter đọc trong kỳ + SP (kể cả ONLINE / chưa
    -- hoàn tất), 14 trường thô đã chuẩn hoá; không phân loại engine. Cùng lớp ký tự / độ dài / dạng số như sales_lines.
    IF v_run.source_schema IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_PART' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS ${SRC_COLS}
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
      FROM jsonb_to_recordset(p_rows) AS ${SRC_COLS};
    GET DIAGNOSTICS v_count = ROW_COUNT;  -- ngay sau INSERT
  ELSIF p_part = 'sales_lines' THEN
    IF EXISTS (`, 'stage source branch')

  // ── rpc_cms_sales_run_cleanup (122) — dọn lớp nguồn sau lớp engine, trước khối ─
  const CLEAN0 = fn(S122, 'rpc_cms_sales_run_cleanup')
  let clean = orReplace(CLEAN0)
  clean = patch(clean, `    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_sync_run_chunks WHERE run_id = v_id;`, `    -- 124: lớp nguồn sau lớp engine, trước khối.
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_sales_source_lines WHERE ctid IN (SELECT ctid FROM public.cms_sales_source_lines WHERE run_id = v_id LIMIT v_left);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_sales_source_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_sync_run_chunks WHERE run_id = v_id;`, 'cleanup source step')
  clean = patch(clean, `       AND NOT EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_sync_run_chunks WHERE run_id = v_id) THEN`, `       AND NOT EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_sales_source_lines WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_sync_run_chunks WHERE run_id = v_id) THEN`, 'cleanup cleared')

  // ── cms__lock_eval (123) — bước 8 dùng chứng nhận ─────────────────────────────
  const EVAL0 = fn(S123, 'cms__lock_eval')
  let ev = orReplace(EVAL0)
  ev = patch(ev, '  v_sealed_ok boolean;\n', "  v_sealed_ok boolean;\n  v_att      jsonb := jsonb_build_object('code', 'NONE');  -- 124\n  v_att_ok   boolean;                                       -- 124\n", 'eval declare')
  ev = patch(ev, `    IF v_basis IS NULL OR v_basis <> 'qa_assumption' OR NOT v_prog.is_test THEN
      v_b := array_append(v_b, 'CMS_LOCK_SOURCE_INCOMPLETE');
    END IF;`, `    -- 124: chứng nhận đối soát nguồn decision10 CÒN HIỆU LỰC của đúng run hiện hành, kiểm lại config / mapping / scope / lớp nguồn
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
    END IF;`, 'eval step 8')
  ev = patch(ev, "    'source_complete_basis', v_basis, 'source_complete_through', to_char(v_through, 'YYYY-MM-DD'),\n",
    "    'source_complete_basis', v_basis, 'source_complete_through', to_char(v_through, 'YYYY-MM-DD'),\n    'source_attestation', v_att,\n", 'eval return')

  // ── rpc_cms_program_lock (123) — DROP 5 tham số + CREATE 6 tham số ────────────
  const LOCK0 = fn(S123, 'rpc_cms_program_lock')
  let lock = LOCK0
  lock = patch(lock, 'p_actor uuid, p_ack_reason text DEFAULT NULL)', 'p_actor uuid, p_ack_reason text DEFAULT NULL,\n                                            p_expected_attestation_id uuid DEFAULT NULL)', 'lock signature')
  // lock_timeout 3 s → 2 s (PM COMP-INT §4 đồng ý): hết hạn chờ khoá ⇒ lỗi, rollback toàn RPC. Không phải hạn tổng RPC.
  lock = patch(lock, "SET search_path = public SET lock_timeout = '3s' AS $$", "SET search_path = public SET lock_timeout = '2s' AS $$", 'lock lock_timeout')
  // Gọi lại sau chốt chỉ "already" khi cùng run VÀ cùng chứng nhận (NULL = chốt không chứng nhận).
  lock = patch(lock, '    IF FOUND AND v_pay.run_id = p_expected_run_id THEN\n',
    '    IF FOUND AND v_pay.run_id = p_expected_run_id\n       AND v_pay.source_attestation_id IS NOT DISTINCT FROM p_expected_attestation_id THEN  -- 124\n', 'lock already')
  lock = patch(lock, "                                'amount_vnd', v_pay.amount_vnd::text, 'policy_version', v_pay.policy_version);",
    "                                'amount_vnd', v_pay.amount_vnd::text, 'policy_version', v_pay.policy_version,\n                                'source_attestation_id', v_pay.source_attestation_id);", 'lock already return')
  lock = patch(lock, `  IF jsonb_array_length(v_ev -> 'blockers') > 0 THEN
    RAISE EXCEPTION USING MESSAGE = v_ev -> 'blockers' ->> 0, ERRCODE = 'P0001';
  END IF;
`, `  IF jsonb_array_length(v_ev -> 'blockers') > 0 THEN
    RAISE EXCEPTION USING MESSAGE = v_ev -> 'blockers' ->> 0, ERRCODE = 'P0001';
  END IF;
  -- 124: chốt bằng chứng nhận ⇒ phải đúng chứng nhận preview đã thấy (đổi / thu hồi / chứng nhận lại giữa preview và chốt ⇒ chặn).
  IF (v_ev ->> 'source_complete_basis') = 'operator_reconciliation' OR p_expected_attestation_id IS NOT NULL THEN
    IF p_expected_attestation_id IS NULL OR (v_ev ->> 'source_complete_basis') IS DISTINCT FROM 'operator_reconciliation'
       OR (v_ev -> 'source_attestation' ->> 'id')::uuid IS DISTINCT FROM p_expected_attestation_id THEN
      RAISE EXCEPTION 'CMS_LOCK_EVIDENCE_CHANGED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
`, 'lock evidence check')
  lock = patch(lock, 'run_started_at, source_complete_basis, source_complete_through, locked_by)',
    'run_started_at, source_complete_basis, source_complete_through, locked_by, source_attestation_id)', 'lock insert cols')
  lock = patch(lock, "(v_ev ->> 'source_complete_through')::date, p_actor);",
    "(v_ev ->> 'source_complete_through')::date, p_actor,\n    CASE WHEN (v_ev ->> 'source_complete_basis') = 'operator_reconciliation' THEN (v_ev -> 'source_attestation' ->> 'id')::uuid END);",
    'lock insert values')
  lock = patch(lock, "'unassigned_lines', (v_ev ->> 'unassigned_lines')::integer, 'policy_version', (v_ev ->> 'policy_version')::integer);",
    "'unassigned_lines', (v_ev ->> 'unassigned_lines')::integer, 'policy_version', (v_ev ->> 'policy_version')::integer,\n                            'source_complete_basis', v_ev ->> 'source_complete_basis',\n                            'source_attestation_id', v_ev -> 'source_attestation' ->> 'id');",
    'lock return')

  // ── rpc_cms_payout (123) — super thấy id + tóm tắt chứng nhận (không actor / email / hash file) ────────────────
  const PAY0 = fn(S123, 'rpc_cms_payout')
  let pay = orReplace(PAY0)
  pay = patch(pay, "         'source_complete_through', to_char(v_pay.source_complete_through, 'YYYY-MM-DD'),\n",
    `         'source_complete_through', to_char(v_pay.source_complete_through, 'YYYY-MM-DD'),
         'source_attestation_id', v_pay.source_attestation_id,
         -- 124: tóm tắt chứng nhận đã dùng chốt (bất biến) cho XLSX / khối chốt — không actor / email / hash file.
         'source_attestation', (SELECT jsonb_build_object('field_set', a.field_set, 'as_of', public.cms__ts(a.as_of),
                                         'reference_label', a.reference_label, 'lines_compared', a.lines_compared,
                                         'attested_at', public.cms__ts(a.attested_at), 'run_rows_fp', a.run_rows_fp)
                                  FROM public.cms_source_attestations a WHERE a.id = v_pay.source_attestation_id),
`, 'payout read')

  const sec = (t) => `\n-- ── ${t} ${'─'.repeat(Math.max(4, 74 - t.length))}\n`
  // md5(prosrc) 6 hàm = thân nguyên văn 122 / 123: preflight 124 (thân hiện tại) + hậu kiểm rollback (thân khôi phục).
  const MD5_FNS = [['rpc_cms_sales_run_open(uuid, jsonb)', OPEN0], ['rpc_cms_sales_run_stage(uuid, text, integer, jsonb)', STAGE0],
    ['rpc_cms_sales_run_cleanup(uuid, integer)', CLEAN0], ['cms__lock_eval(uuid, uuid, integer, text, boolean)', EVAL0],
    ['rpc_cms_payout(uuid)', PAY0], ['rpc_cms_program_lock(uuid, uuid, integer, uuid, text)', LOCK0]]
  const md5Block = (msg) => `DO $$
BEGIN
  IF ${MD5_FNS.map(([sig, t]) => `(SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'public.${sig}'::regprocedure) IS DISTINCT FROM '${md5(cmsProsrc(t))}'`).join('\n     OR ')} THEN
    RAISE EXCEPTION '${msg}';
  END IF;
END $$;`
  const MD5_CHECK = md5Block('rollback 124 hậu kiểm: thân hàm 122 / 123 khôi phục lệch nguyên văn (md5)')
  // Preflight (db-reviewer r2 P2-6): thân 6 hàm sắp thay phải ĐÚNG 122 / 123 đã duyệt — không ghi đè lặng lẽ thân đã lệch trên DB.
  const PREFLIGHT_MD5 = md5Block('124 preflight: thân hàm 122 / 123 sắp thay KHÁC bản đã duyệt (md5) — dừng, đối chiếu tay')
  const migration = [
    patch(tpl('a-head.sql'), '-- @@PREFLIGHT_MD5@@', PREFLIGHT_MD5, 'preflight md5'),
    sec('7. Hàm 122 thay (sinh từ thân nguyên văn 122 + vá gen-cms-124)'), open, '\n', stage, '\n', clean, '\n',
    tpl('b-attest.sql'),
    sec('8. Hàm 123 thay (sinh từ thân nguyên văn 123 + vá gen-cms-124)'), ev, '\n',
    'DROP FUNCTION public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text);\n', lock, '\n', pay, '\n',
    tpl('c-tail.sql'),
  ].join('')
  const rollback = [
    tpl('rb-head.sql'),
    sec('Khôi phục NGUYÊN VĂN 122 / 123'), orReplace(OPEN0), '\n', orReplace(STAGE0), '\n', orReplace(CLEAN0), '\n', orReplace(EVAL0), '\n',
    orReplace(PAY0), '\n', LOCK0, '\n',
    patch(tpl('rb-tail.sql'), '-- @@MD5_CHECK@@', MD5_CHECK, 'rollback md5 check'),
  ].join('')
  const originals = { run_open: OPEN0, stage: STAGE0, cleanup: CLEAN0, lock_eval: EVAL0, lock: LOCK0, payout: PAY0 }
  return { migration, rollback, originals }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const { migration, rollback } = buildCms124()
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex')
  if (process.argv.includes('--check')) {
    const same = (f, s) => fs.existsSync(f) && fs.readFileSync(f, 'utf8') === s
    const ok = same(CMS_124_FILE, migration) && same(CMS_124_ROLLBACK_FILE, rollback)
    console.log(ok ? 'gen-cms-124: file trên đĩa KHỚP bản sinh' : 'gen-cms-124: LỆCH bản sinh — chạy lại node scripts/gen-cms-124.mjs')
    process.exitCode = ok ? 0 : 1
  } else {
    fs.writeFileSync(CMS_124_FILE, migration)
    fs.writeFileSync(CMS_124_ROLLBACK_FILE, rollback)
    console.log(`124_cms_source_attestation.sql ${migration.split('\n').length - 1} dòng sha256 ${h(migration)}`)
    console.log(`rollback/124_cms_source_attestation_rollback.sql ${rollback.split('\n').length - 1} dòng sha256 ${h(rollback)}`)
  }
}
