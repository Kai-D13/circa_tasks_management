#!/usr/bin/env node
// CMS 128 (CMS-UNIT capability — PM spec 09/11 §3 / §5): SINH supabase/migrations/128_cms_unit_quantity_basis.sql + rollback từ
// scripts/cms-128/*.sql + thân 15 hàm NGUYÊN VĂN của bản cuối đang chạy (121 / 122 / 123 / 124 / 126) + hằng hợp đồng đơn vị
// lib/cms/unitKey.ts. Mỗi chỗ vá phải khớp ĐÚNG MỘT lần (split/join — không String.replace để không ăn `$$`). KHÔNG sửa tay file sinh
// ra; sửa template / chỗ vá rồi sinh lại.
//   node scripts/gen-cms-128.mjs            # ghi 2 file, in sha256 + md5 thân
//   node scripts/gen-cms-128.mjs --check    # chỉ so: file trên đĩa ≠ bản sinh ⇒ thoát 1 (test drift: scripts/qa-cms-128.mjs)
// Bảng hàm (trước → sau) + lý do: header 128 / CMS_128_FUNCTIONS dưới đây. Nhánh pos_base của seal giữ NGUYÊN VĂN 122 (ELSE).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
export const CMS_128_FILE = path.join(MIG, '128_cms_unit_quantity_basis.sql')
export const CMS_128_ROLLBACK_FILE = path.join(MIG, 'rollback', '128_cms_unit_quantity_basis_rollback.sql')

const jiti = createJiti(import.meta.url, { interopDefault: true })
const UK = await jiti.import(path.join(HERE, '..', 'lib', 'cms', 'unitKey.ts'))

/** Thân `CREATE [OR REPLACE] FUNCTION public.<name>(` … `$$;` — đúng MỘT định nghĩa trong file. */
function fn(sql, name) {
  const heads = [`CREATE FUNCTION public.${name}(`, `CREATE OR REPLACE FUNCTION public.${name}(`]
  const hits = []
  for (const h of heads) { let i = -1; while ((i = sql.indexOf(h, i + 1)) >= 0) hits.push(i) }
  if (hits.length !== 1) throw new Error(`hàm ${name}: ${hits.length} định nghĩa (cần đúng 1)`)
  const i = hits[0]
  const j = sql.indexOf('$$;', sql.indexOf('AS $$', i) + 5)
  return sql.slice(i, j + 3)
}
function patch(text, from, to, label) {
  const n = text.split(from).length - 1
  if (n !== 1) throw new Error(`vá "${label}": khớp ${n} lần (cần đúng 1)`)
  return text.split(from).join(to)
}
const orReplace = (t) => (t.startsWith('CREATE OR REPLACE FUNCTION public.') ? t : patch(t, 'CREATE FUNCTION public.', 'CREATE OR REPLACE FUNCTION public.', 'OR REPLACE'))
/** prosrc = chuỗi giữa `AS $$` và `$$;` cuối, BỎ \r (md5 khớp md5(replace(prosrc, E'\r', '')) của DB). */
export const cmsProsrc = (t) => t.slice(t.indexOf('AS $$') + 5, t.lastIndexOf('$$;')).split('\r').join('')
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')
const sqlLit = (s) => s.split("'").join("''")
/** U&'\XXXX…' (mọi ký tự BMP) — khoảng trắng tường minh không lẫn trong file. */
const uLit = (s) => [...s].map((c) => '\\' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join('')

/** 15 hàm thay: tên, chữ ký regprocedure, file nguồn của bản cuối, quyền EXECUTE kỳ vọng (ngoài owner). */
export const CMS_128_REPLACED = [
  { name: 'cms__sales_snapshot', sig: 'cms__sales_snapshot(uuid)', file: '122_cms_results.sql', grant: null },
  { name: 'cms__config_fp', sig: 'cms__config_fp(uuid)', file: '123_cms_payouts.sql', grant: null },
  { name: 'cms__attest_eval', sig: 'cms__attest_eval(uuid, uuid)', file: '124_cms_source_attestation.sql', grant: null },
  { name: 'cms__lock_eval', sig: 'cms__lock_eval(uuid, uuid, integer, text, boolean)', file: '124_cms_source_attestation.sql', grant: null },
  { name: 'rpc_cms_program_save', sig: 'rpc_cms_program_save(jsonb)', file: '121_cms_import_activation.sql', grant: 'service_role' },
  { name: 'rpc_cms_sales_run_open', sig: 'rpc_cms_sales_run_open(uuid, jsonb)', file: '124_cms_source_attestation.sql', grant: 'service_role' },
  { name: 'rpc_cms_sales_run_seal_begin', sig: 'rpc_cms_sales_run_seal_begin(uuid, jsonb)', file: '122_cms_results.sql', grant: 'service_role' },
  { name: 'rpc_cms_sales_run_seal_step', sig: 'rpc_cms_sales_run_seal_step(uuid, integer)', file: '122_cms_results.sql', grant: 'service_role' },
  { name: 'rpc_cms_sales_run_publish', sig: 'rpc_cms_sales_run_publish(uuid)', file: '126_cms_sales_only_results_release.sql', grant: 'service_role' },
  { name: 'rpc_cms_sales_run_finish', sig: 'rpc_cms_sales_run_finish(uuid, text, jsonb)', file: '122_cms_results.sql', grant: 'service_role' },
  { name: 'rpc_cms_result_header', sig: 'rpc_cms_result_header(uuid)', file: '122_cms_results.sql', grant: 'authenticated' },
  { name: 'rpc_cms_result_rows', sig: 'rpc_cms_result_rows(uuid, uuid)', file: '122_cms_results.sql', grant: 'authenticated' },
  { name: 'rpc_cms_result_lines', sig: 'rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer)', file: '122_cms_results.sql', grant: 'authenticated' },
  { name: 'rpc_cms_source_attest', sig: 'rpc_cms_source_attest(uuid, uuid, jsonb, uuid)', file: '124_cms_source_attestation.sql', grant: 'authenticated' },
  { name: 'rpc_cms_run_source_export', sig: 'rpc_cms_run_source_export(uuid, uuid, text, integer)', file: '124_cms_source_attestation.sql', grant: 'authenticated' },
]
/** 6 hàm mới (chỉ owner — không cấp PUBLIC / anon / authenticated / service_role). */
export const CMS_128_NEW = [
  { name: 'cms__unit_key', sig: 'cms__unit_key(text)' },
  { name: 'cms__qty_dec', sig: 'cms__qty_dec(text)' },
  { name: 'cms__basis_policy', sig: 'cms__basis_policy(text)' },
  { name: 'cms__calc_snapshot', sig: 'cms__calc_snapshot(uuid)' },
  { name: 'cms__programs_basis_guard', sig: 'cms__programs_basis_guard()' },
  { name: 'cms__runs_basis_guard', sig: 'cms__runs_basis_guard()' },
]

/** Mã DB mới (app dùng chung — lib/cms/unitBasis.ts). */
export const CMS_128_CODES = {
  attestNotSupported: 'CMS_UNIT_ATTESTATION_NOT_SUPPORTED',
  writerMismatch: 'BASIS_WRITER_MISMATCH',
  runBasisInvalid: 'RUN_BASIS_INVALID',
  sealUnitSource: 'SEAL_UNIT_SOURCE',
  unitInvalid: 'CMS_SALES_UNIT_INVALID',
}

// ── Khối chèn ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const RESERVED = `ARRAY['quantity_basis', 'calculation_policy_version', 'calculation_snapshot']`

/** Kiểm metadata run + cơ sở / vân tay cấu hình — đầu seal_begin và đầu MỖI bước seal. */
const RUN_BASIS_CHECK = String.raw`  -- 128: metadata tính của run (DB ghi lúc open, bất biến) phải hợp lệ; cơ sở + TOÀN BỘ snapshot cấu hình tính của run = snapshot dựng
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
`
const WRITER_STAMP_CHECK = String.raw`  -- 128: DẤU WRITER — expect phải khai đúng cơ sở + phiên bản chính sách của run. Writer cũ (không khai) chỉ hợp lệ với pos_base:
  -- run cms_unit seal bằng writer không biết luật mới ⇒ held, dù số tiền tình cờ bằng nhau.
  IF (p_expect ? 'quantity_basis' OR p_expect ? 'calculation_policy_version' OR v_run.quantity_basis <> 'pos_base')
     AND (jsonb_typeof(p_expect -> 'quantity_basis') IS DISTINCT FROM 'string'
          OR jsonb_typeof(p_expect -> 'calculation_policy_version') IS DISTINCT FROM 'string'
          OR (p_expect ->> 'quantity_basis') IS DISTINCT FROM v_run.quantity_basis
          OR (p_expect ->> 'calculation_policy_version') IS DISTINCT FROM v_run.calculation_policy_version) THEN
    RETURN public.cms__seal_fail(p_run_id, 'held', 'BASIS_WRITER_MISMATCH');
  END IF;
`
/** CTE chung: đơn vị CMS của run (snapshot) + chuẩn hoá MỖI giá trị phân biệt một lần. du / dq MATERIALIZED (db-reviewer 09/11 P1): CTE
 *  tham chiếu một lần bị inline + pull-up; biểu thức strict ở phía nullable của LEFT JOIN không được bọc PlaceHolderVar trên PG ≤ 15 ⇒
 *  hàm chuẩn hoá chạy theo TỪNG DÒNG (đo PG15 200k dòng: 724k / 524k lần gọi). MATERIALIZED ⇒ mỗi giá trị phân biệt đúng một lần. */
const UNIT_CTES = String.raw`    WITH pu AS (
      SELECT (e ->> 'id')::uuid AS program_product_id, e ->> 'unit_key' AS unit_key
        FROM jsonb_array_elements(v_run.calculation_snapshot -> 'products') e
    ), du AS MATERIALIZED (
      SELECT d.program_product_id, d.uom_raw, public.cms__unit_key(d.uom_raw) AS k
        FROM (SELECT DISTINCT s.program_product_id, s.uom_raw FROM public.cms_sales_lines s WHERE s.run_id = p_run_id) d
    ), dq AS MATERIALIZED (
      SELECT d.quantity_raw, public.cms__qty_dec(d.quantity_raw) AS q
        FROM (SELECT DISTINCT s.quantity_raw FROM public.cms_sales_lines s WHERE s.run_id = p_run_id) d
    )`
const TC_FQ = (qSource) => String.raw`, tc AS (
      SELECT t.program_product_id, t.tier_order,
             COALESCE(sum((t.qty_to - t.qty_from + 1)::numeric * t.amount_per_unit) OVER (PARTITION BY t.program_product_id
                      ORDER BY t.tier_order ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_before
        FROM public.cms_program_tiers t WHERE t.program_id = v_run.program_id
    ), q AS (
${qSource}
    ), fq AS (
      SELECT q.program_product_id, q.q,
             CASE WHEN q.q <= 0 OR x.tier_order IS NULL THEN 0
                  ELSE tc.cum_before + (LEAST(q.q::numeric, COALESCE(x.qty_to, q.q)::numeric) - x.qty_from + 1) * x.amount_per_unit END AS f
        FROM q
        LEFT JOIN LATERAL (SELECT t.tier_order, t.qty_from, t.qty_to, t.amount_per_unit FROM public.cms_program_tiers t
                            WHERE t.program_product_id = q.program_product_id AND t.qty_from <= q.q
                            ORDER BY t.qty_from DESC LIMIT 1) x ON true
        LEFT JOIN tc ON tc.program_product_id = q.program_product_id AND tc.tier_order = x.tier_order
    )`

const STEP7_UNIT = String.raw`    IF v_run.quantity_basis = 'cms_unit' THEN
    -- 128 S9u (cms_unit — Q-221 / Q-223): DB TỰ tính lượng đúng ĐV CMS từ dòng nguồn đã stage — KHÔNG tin cms_quantity của caller, KHÔNG
    -- suy từ B / K. Mỗi cặp (SP, đơn vị thô) / mỗi chuỗi lượng PHÂN BIỆT chuẩn hoá MỘT lần. Mọi dòng ứng viên (cả chưa gán / ngoài
    -- phạm vi) phải có đơn vị + lượng hợp lệ; đúng ĐV CMS ⇒ lượng NGUYÊN trong miền bigint (app HOLD trước khi stage — tới đây là
    -- writer sai ⇒ error SEAL_UNIT_SOURCE). Q = max(Σ lượng đúng ĐV của dòng INCLUDED trong nhóm, 0); F(Q) như nhánh pos_base.
${UNIT_CTES}, sl AS (
      SELECT s.user_id, s.program_product_id, s.disposition, dq.q, du.k, pu.unit_key, COALESCE(du.k = pu.unit_key, false) AS matched
        FROM public.cms_sales_lines s
        LEFT JOIN du ON du.program_product_id = s.program_product_id AND du.uom_raw = s.uom_raw
        LEFT JOIN dq ON dq.quantity_raw = s.quantity_raw
        LEFT JOIN pu ON pu.program_product_id = s.program_product_id
       WHERE s.run_id = p_run_id
    ), g AS (
      SELECT sl.user_id, sl.program_product_id, GREATEST(sum(CASE WHEN sl.matched THEN sl.q ELSE 0 END), 0) AS qexp
        FROM sl WHERE sl.disposition = 'INCLUDED' GROUP BY sl.user_id, sl.program_product_id
    )${TC_FQ(`      SELECT DISTINCT r.program_product_id, r.cms_quantity AS q FROM public.cms_results r WHERE r.run_id = p_run_id`)}
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
`
const STEP10_UNIT = String.raw`    IF v_run.quantity_basis = 'cms_unit' THEN
    -- 128 S12u (cms_unit): C trước / sau cộng dồn theo seq từ dòng nguồn (cùng khoá đơn vị / lượng như S9u); Q trước / sau = max(C, 0);
    -- tiền = gate ? F(Q_sau) − F(Q_trước) : 0; B trước / sau vẫn là lượng cơ sở THẬT; điều chỉnh gồm cả lượng gốc âm (kể cả dòng khác
    -- đơn vị — không để né cổng trả hàng). Không chia C cho K; totals / cổng điều chỉnh (S13 / S14) dùng chung bên dưới.
${UNIT_CTES}, l AS (
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
    )${TC_FQ(`      SELECT program_product_id, qty_before AS q FROM l WHERE gate_met
      UNION
      SELECT program_product_id, qty_after FROM l WHERE gate_met`)}, f AS (
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
`

export function buildCms128() {
  const src = (f) => fs.readFileSync(path.join(MIG, f), 'utf8')
  const tpl = (f) => fs.readFileSync(path.join(HERE, 'cms-128', f), 'utf8')
  const base = Object.fromEntries(CMS_128_REPLACED.map((r) => [r.name, fn(src(r.file), r.name)]))
  const out = {}

  // cms__sales_snapshot (122): cơ sở / phiên bản của CHƯƠNG TRÌNH + unit_cms từng SP (app cũ bỏ qua khoá thừa).
  let t = orReplace(base.cms__sales_snapshot)
  t = patch(t, "    'config_version', p.config_version,\n", `    'config_version', p.config_version,
    -- 128: cơ sở tính / phiên bản chính sách của chương trình + phiên bản khoá đơn vị (run mới ghi cùng giá trị trong metadata run).
    'quantity_basis', p.quantity_basis,
    'calculation_policy_version', public.cms__basis_policy(p.quantity_basis),
    'unit_key_version', '${UK.CMS_UNIT_KEY_VERSION}',
`, 'snapshot basis')
  t = patch(t, "'base_quantity_cms', pp.base_quantity_cms::text,", "'base_quantity_cms', pp.base_quantity_cms::text, 'unit_cms', pp.unit_cms,", 'snapshot unit')
  out.cms__sales_snapshot = t

  // cms__config_fp (123): + cơ sở khi KHÁC pos_base ⇒ vân tay mọi chương trình pos_base KHÔNG đổi (payout / VERIFY cũ giữ nguyên).
  t = orReplace(base.cms__config_fp)
  t = patch(t, "                FROM public.cms_program_stores s WHERE s.program_id = p_program_id), ''))\n", `                FROM public.cms_program_stores s WHERE s.program_id = p_program_id), '')
    -- 128: cơ sở tính chỉ góp vào vân tay khi khác pos_base (giữ nguyên giá trị cũ của mọi chương trình pos_base).
    || COALESCE((SELECT chr(29) || 'quantity_basis=' || p.quantity_basis FROM public.cms_programs p
                  WHERE p.id = p_program_id AND p.quantity_basis <> 'pos_base'), ''))
`, 'config_fp basis')
  out.cms__config_fp = t

  // cms__attest_eval (124): run cms_unit ⇒ không đánh giá chứng nhận decision10.
  t = orReplace(base.cms__attest_eval)
  t = patch(t, 'BEGIN\n  SELECT * INTO v_a FROM public.cms_source_attestations', `BEGIN
  -- 128 (PM §3.4): decision10 không ràng buộc quantity_raw / uom_raw — trường quyết định tiền của run cms_unit ⇒ không dùng chứng nhận.
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs r WHERE r.id = p_run_id AND r.quantity_basis IS DISTINCT FROM 'pos_base') THEN
    RETURN jsonb_build_object('code', '${CMS_128_CODES.attestNotSupported}');
  END IF;
  SELECT * INTO v_a FROM public.cms_source_attestations`, 'attest_eval unit')
  out.cms__attest_eval = t

  // cms__lock_eval (124): run hiện hành cms_unit ⇒ blocker (cả chốt QA — PM §3.4).
  t = orReplace(base.cms__lock_eval)
  t = patch(t, "      v_b := array_append(v_b, 'CMS_LOCK_STALE_RUN');\n    END IF;\n", `      v_b := array_append(v_b, 'CMS_LOCK_STALE_RUN');
    END IF;
    -- 128 (PM §3.4): chứng nhận / cơ sở chốt hiện có chỉ cho run pos_base — run cms_unit (kể cả QA) không chốt được ở phase này.
    IF v_run.quantity_basis IS DISTINCT FROM 'pos_base' THEN
      v_b := array_append(v_b, '${CMS_128_CODES.attestNotSupported}');
    END IF;
`, 'lock_eval unit')
  out.cms__lock_eval = t

  // rpc_cms_program_save (121): khoá tuỳ chọn quantity_basis.
  t = orReplace(base.rpc_cms_program_save)
  t = patch(t, '  v_ids     text[];\n', '  v_ids     text[];\n  v_basis   text;  -- 128\n', 'save declare')
  t = patch(t, "  IF jsonb_typeof(p->'store_ids') = 'array' THEN\n", `  -- 128: cơ sở tính tuỳ chọn — thiếu ⇒ tạo pos_base / sửa GIỮ NGUYÊN (payload cũ tương thích, không âm thầm đổi luật); lạ ⇒
  -- BAD_INPUT. Đổi cơ sở chỉ hợp lệ khi guard cms_programs_basis_guard cho phép (nháp / chưa có run bán).
  IF p ? 'quantity_basis' THEN
    IF jsonb_typeof(p->'quantity_basis') IS DISTINCT FROM 'string' OR (p->>'quantity_basis') NOT IN ('pos_base', 'cms_unit') THEN
      RAISE EXCEPTION 'CMS_PROGRAM_BAD_INPUT' USING ERRCODE = '22023';
    END IF;
    v_basis := p->>'quantity_basis';
  END IF;
  IF jsonb_typeof(p->'store_ids') = 'array' THEN
`, 'save basis input')
  t = patch(t, `    INSERT INTO public.cms_programs (name, start_date, end_date, scope, is_test, created_by, updated_by)
    VALUES (v_name, v_start, v_end, v_scope, (p->>'is_test')::boolean, v_actor, v_actor)`, `    INSERT INTO public.cms_programs (name, start_date, end_date, scope, is_test, created_by, updated_by, quantity_basis)
    VALUES (v_name, v_start, v_end, v_scope, (p->>'is_test')::boolean, v_actor, v_actor, COALESCE(v_basis, 'pos_base'))`, 'save insert')
  t = patch(t, '     SET name = v_name, start_date = v_start, end_date = v_end, scope = v_scope,\n', '     SET name = v_name, start_date = v_start, end_date = v_end, scope = v_scope, quantity_basis = COALESCE(v_basis, quantity_basis),\n', 'save update')
  out.rpc_cms_program_save = t

  // rpc_cms_sales_run_open (124): ghi metadata run.
  t = orReplace(base.rpc_cms_sales_run_open)
  t = patch(t, '  v_sch  smallint;  -- 124\n', '  v_sch  smallint;  -- 124\n  v_calc jsonb;     -- 128\n', 'open declare')
  t = patch(t, "    RAISE EXCEPTION 'CMS_SYNC_BAD_DETAIL' USING ERRCODE = '22023';\n  END IF;\n", `    RAISE EXCEPTION 'CMS_SYNC_BAD_DETAIL' USING ERRCODE = '22023';
  END IF;
  -- 128: metadata tính do DB ghi — caller không gửi khoá trùng tên qua detail (không để reader nhầm nguồn).
  IF p_detail ?| ${RESERVED} THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_DETAIL' USING ERRCODE = '22023';
  END IF;
`, 'open reserved')
  t = patch(t, `  INSERT INTO public.cms_sync_runs (kind, program_id, config_version, is_test, mapping_fp, detail)
  VALUES ('sales', p_program_id, v_prog.config_version, v_prog.is_test, v_snap ->> 'mapping_fp', p_detail)
  RETURNING id, source_schema INTO v_id, v_sch;`, `  -- 128: snapshot cấu hình tính BẤT BIẾN của run — DB tự dựng dưới khoá dòng chương trình (không từ caller). cms_unit cần khoá đơn
  -- vị hợp lệ cho MỌI SP (unit_cms có ký tự điều khiển / rỗng ⇒ không mở run, không lùi về luật cũ).
  v_calc := public.cms__calc_snapshot(p_program_id);
  IF v_prog.quantity_basis = 'cms_unit' AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_calc -> 'products') e
                                                     WHERE jsonb_typeof(e -> 'unit_key') IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION '${CMS_128_CODES.unitInvalid}' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.cms_sync_runs (kind, program_id, config_version, is_test, mapping_fp, detail,
                                    quantity_basis, calculation_policy_version, calculation_snapshot)
  VALUES ('sales', p_program_id, v_prog.config_version, v_prog.is_test, v_snap ->> 'mapping_fp', p_detail,
          v_prog.quantity_basis, public.cms__basis_policy(v_prog.quantity_basis), v_calc)
  RETURNING id, source_schema INTO v_id, v_sch;`, 'open insert')
  t = patch(t, "  RETURN v_snap || jsonb_build_object('run_id', v_id, 'source_schema', v_sch);", "  RETURN v_snap || jsonb_build_object('run_id', v_id, 'source_schema', v_sch, 'calculation_snapshot', v_calc);", 'open return')
  out.rpc_cms_sales_run_open = t

  // seal_begin (122): metadata + cơ sở / vân tay + dấu writer.
  t = orReplace(base.rpc_cms_sales_run_seal_begin)
  t = patch(t, "  IF public.cms__mapping_fp() <> v_run.mapping_fp THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'MAPPING_CHANGED'); END IF;\n  -- Thống kê mới",
    `  IF public.cms__mapping_fp() <> v_run.mapping_fp THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'MAPPING_CHANGED'); END IF;\n${RUN_BASIS_CHECK}${WRITER_STAMP_CHECK}  -- Thống kê mới`, 'seal_begin basis')
  out.rpc_cms_sales_run_seal_begin = t

  // seal_step (122): đầu bước + nhánh cms_unit bước 7 / 10 (nhánh pos_base NGUYÊN VĂN trong ELSE).
  t = orReplace(base.rpc_cms_sales_run_seal_step)
  t = patch(t, '  v_bad   boolean;\n', '  v_bad   boolean;\n  v_bad2  boolean;  -- 128\n', 'step declare')
  t = patch(t, "  IF public.cms__mapping_fp() <> v_run.mapping_fp THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'MAPPING_CHANGED'); END IF;\n  v_exp  := v_run.seal_expect;",
    `  IF public.cms__mapping_fp() <> v_run.mapping_fp THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'MAPPING_CHANGED'); END IF;\n${RUN_BASIS_CHECK}  v_exp  := v_run.seal_expect;`, 'step head')
  t = patch(t, '  ELSIF p_step = 7 THEN\n', `  ELSIF p_step = 7 THEN\n${STEP7_UNIT}`, 'step7 open')
  t = patch(t, "    INTO v_bad;\n    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TIER_AMOUNT'); END IF;\n",
    "    INTO v_bad;\n    END IF;\n    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TIER_AMOUNT'); END IF;\n", 'step7 close')
  t = patch(t, '  ELSE\n    -- S12 phân bổ từng dòng', `  ELSE\n${STEP10_UNIT}    -- S12 phân bổ từng dòng`, 'step10 open')
  t = patch(t, "    INTO v_bad;\n    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_LINE_ALLOC'); END IF;\n",
    "    INTO v_bad;\n    END IF;\n    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_LINE_ALLOC'); END IF;\n", 'step10 close')
  out.rpc_cms_sales_run_seal_step = t

  // publish (126): cơ sở / vân tay / dấu writer dưới khoá + lượng gốc âm ở dòng không INCLUDED của run cms_unit.
  t = orReplace(base.rpc_cms_sales_run_publish)
  t = patch(t, "    WHEN public.cms__mapping_fp() <> v_run.mapping_fp THEN 'MAPPING_CHANGED'\n", `    WHEN public.cms__mapping_fp() <> v_run.mapping_fp THEN 'MAPPING_CHANGED'
    -- 128: kiểm lại dưới khoá chương trình → run: metadata run hợp lệ, cơ sở + snapshot cấu hình tính = chương trình; run khác pos_base phải
    -- được seal bằng writer có dấu đúng (seal_expect).
    WHEN v_run.quantity_basis IS NULL OR v_run.calculation_snapshot IS NULL
      OR v_run.calculation_policy_version IS DISTINCT FROM public.cms__basis_policy(v_run.quantity_basis)
      OR v_run.quantity_basis IS DISTINCT FROM v_prog.quantity_basis
      OR v_run.calculation_snapshot IS DISTINCT FROM public.cms__calc_snapshot(v_pid) THEN 'CONFIG_CHANGED'
    WHEN v_run.quantity_basis <> 'pos_base'
      AND ((v_run.seal_expect ->> 'quantity_basis') IS DISTINCT FROM v_run.quantity_basis
           OR (v_run.seal_expect ->> 'calculation_policy_version') IS DISTINCT FROM v_run.calculation_policy_version) THEN 'BASIS_WRITER_MISMATCH'
`, 'publish basis')
  t = patch(t, "                    WHERE sl.run_id = p_run_id AND sl.disposition <> 'INCLUDED' AND (sl.base_quantity < 0 OR sl.gmv_amount < 0)))\n",
    `                    WHERE sl.run_id = p_run_id AND sl.disposition <> 'INCLUDED' AND (sl.base_quantity < 0 OR sl.gmv_amount < 0
                          -- 128: run cms_unit — lượng gốc âm khác 0 (hình thức đã được seal S9u kiểm) cũng là điều chỉnh.
                          OR (v_run.quantity_basis = 'cms_unit' AND sl.quantity_raw ~ '^-' AND sl.quantity_raw ~ '[1-9]'))))
`, 'publish negative qty')
  out.rpc_cms_sales_run_publish = t

  // finish (122): khoá metadata trong detail ⇒ BAD_DETAIL.
  t = orReplace(base.rpc_cms_sales_run_finish)
  t = patch(t, "     OR NOT public.cms__str_or_null(p_detail, 'bytes_processed', '^(0|[1-9][0-9]{0,17})$') THEN\n",
    `     OR NOT public.cms__str_or_null(p_detail, 'bytes_processed', '^(0|[1-9][0-9]{0,17})$')
     OR p_detail ?| ${RESERVED} THEN  -- 128: metadata tính do DB ghi lúc open
`, 'finish reserved')
  out.rpc_cms_sales_run_finish = t

  // rpc_cms_result_header (122): cơ sở chương trình + của run hiện hành / lần thử / run gần đây.
  t = orReplace(base.rpc_cms_result_header)
  t = patch(t, '  v_cfg  integer;\n', '  v_cfg  integer;\n  v_basis text;  -- 128\n', 'header declare')
  t = patch(t, '  SELECT config_version INTO v_cfg FROM public.cms_programs WHERE id = p_program_id;',
    '  SELECT config_version, quantity_basis INTO v_cfg, v_basis FROM public.cms_programs WHERE id = p_program_id;', 'header select')
  t = patch(t, "    'config_version', v_cfg,\n", "    'config_version', v_cfg,\n    'quantity_basis', v_basis,  -- 128: cơ sở HIỆN TẠI của chương trình (run lịch sử đọc cơ sở của chính run)\n", 'header basis')
  t = patch(t, "      jsonb_build_object('id', v_r.id, 'config_version', v_r.config_version, ",
    "      jsonb_build_object('id', v_r.id, 'config_version', v_r.config_version, 'quantity_basis', v_r.quantity_basis,\n                         'calculation_policy_version', v_r.calculation_policy_version, ", 'header run')
  t = patch(t, "      jsonb_build_object('status', v_last.status, ",
    "      jsonb_build_object('status', v_last.status, 'quantity_basis', v_last.quantity_basis,\n                         'calculation_policy_version', v_last.calculation_policy_version, ", 'header last')
  t = patch(t, "'config_version', q.config_version, 'purged', q.purged_at IS NOT NULL)",
    "'config_version', q.config_version, 'purged', q.purged_at IS NOT NULL,\n                                          'quantity_basis', q.quantity_basis, 'calculation_policy_version', q.calculation_policy_version)", 'header recent')
  out.rpc_cms_result_header = t

  // rpc_cms_result_rows (122): cơ sở + đơn vị theo snapshot của RUN.
  t = orReplace(base.rpc_cms_result_rows)
  t = patch(t, '  v_n     bigint;\n', '  v_n     bigint;\n  v_run_r public.cms_sync_runs%ROWTYPE;  -- 128\n', 'rows declare')
  t = patch(t, "    RETURN jsonb_build_object('run_id', NULL, 'results', '[]'::jsonb, 'catalog', '[]'::jsonb, 'users', '[]'::jsonb);",
    "    RETURN jsonb_build_object('run_id', NULL, 'results', '[]'::jsonb, 'catalog', '[]'::jsonb, 'users', '[]'::jsonb,\n                              'quantity_basis', NULL, 'calculation_policy_version', NULL, 'units', NULL);", 'rows empty')
  t = patch(t, "  IF v_n > 50000 THEN RAISE EXCEPTION 'CMS_RESULT_TOO_LARGE' USING ERRCODE = 'P0001'; END IF;\n",
    "  IF v_n > 50000 THEN RAISE EXCEPTION 'CMS_RESULT_TOO_LARGE' USING ERRCODE = 'P0001'; END IF;\n  SELECT * INTO v_run_r FROM public.cms_sync_runs WHERE id = v_run;  -- 128\n", 'rows run')
  t = patch(t, "    'run_id', v_run,\n    'results',", `    'run_id', v_run,
    -- 128: cơ sở / phiên bản / đơn vị CMS của RUN (snapshot lúc open) — run legacy: units NULL (đọc cấu hình như trước 128).
    'quantity_basis', v_run_r.quantity_basis, 'calculation_policy_version', v_run_r.calculation_policy_version,
    'units', (SELECT jsonb_agg(jsonb_build_object('program_product_id', e ->> 'id', 'product_id', e ->> 'product_id',
                                                  'unit_cms', e ->> 'unit_cms', 'base_quantity_cms', e ->> 'base_quantity_cms')
                               ORDER BY e ->> 'product_id')
                FROM jsonb_array_elements(v_run_r.calculation_snapshot -> 'products') e),
    'results',`, 'rows basis')
  out.rpc_cms_result_rows = t

  // rpc_cms_result_lines (122): cơ sở run + unit_match / counted_quantity (run cms_unit).
  t = orReplace(base.rpc_cms_result_lines)
  t = patch(t, '  v_next  integer;\n', '  v_next  integer;\n  v_run_r public.cms_sync_runs%ROWTYPE;  -- 128\n  v_keys  jsonb;                         -- 128\n', 'lines declare')
  t = patch(t, "    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';\n  END IF;\n  SELECT COALESCE(jsonb_agg(", `    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- 128: khoá ĐV CMS theo snapshot của RUN (không theo cấu hình hiện tại) ⇒ lý do "khác ĐV — không tính CMS" của từng dòng.
  SELECT * INTO v_run_r FROM public.cms_sync_runs WHERE id = v_run;
  IF v_run_r.quantity_basis = 'cms_unit' THEN
    SELECT jsonb_object_agg(e ->> 'id', e ->> 'unit_key') INTO v_keys
      FROM jsonb_array_elements(v_run_r.calculation_snapshot -> 'products') e;
  END IF;
  SELECT COALESCE(jsonb_agg(`, 'lines keys')
  t = patch(t, "      'amount_vnd', q.amount_vnd::text, 'status', q.status) ORDER BY q.seq), '[]'::jsonb)",
    "      'amount_vnd', q.amount_vnd::text, 'status', q.status, 'unit_match', q.unit_match, 'counted_quantity', q.counted_quantity)\n      ORDER BY q.seq), '[]'::jsonb)", 'lines json')
  t = patch(t, '                 rl.base_after, rl.qty_before, rl.qty_after, rl.amount_vnd, rl.status\n', `                 rl.base_after, rl.qty_before, rl.qty_after, rl.amount_vnd, rl.status,
                 CASE WHEN v_keys IS NOT NULL
                      THEN COALESCE(public.cms__unit_key(sl.uom_raw) = (v_keys ->> rl.program_product_id::text), false) END AS unit_match,
                 CASE WHEN v_keys IS NULL THEN NULL
                      WHEN public.cms__unit_key(sl.uom_raw) = (v_keys ->> rl.program_product_id::text)
                      THEN trunc(public.cms__qty_dec(sl.quantity_raw))::text ELSE '0' END AS counted_quantity
`, 'lines cols')
  t = patch(t, "  RETURN jsonb_build_object('run_id', v_run, 'rows', v_rows, 'next_after_seq', v_next);",
    "  RETURN jsonb_build_object('run_id', v_run, 'rows', v_rows, 'next_after_seq', v_next,\n                            'quantity_basis', v_run_r.quantity_basis, 'calculation_policy_version', v_run_r.calculation_policy_version);", 'lines return')
  out.rpc_cms_result_lines = t

  // rpc_cms_source_attest (124): run khác pos_base ⇒ từ chối.
  t = orReplace(base.rpc_cms_source_attest)
  t = patch(t, "    RAISE EXCEPTION 'CMS_ATTEST_STALE_RUN' USING ERRCODE = 'P0001';\n  END IF;\n", `    RAISE EXCEPTION 'CMS_ATTEST_STALE_RUN' USING ERRCODE = 'P0001';
  END IF;
  -- 128 (PM §3.4): decision10 không ràng buộc quantity_raw / uom_raw ⇒ không chứng nhận run cms_unit (không thay bằng audit14).
  IF v_run.quantity_basis IS DISTINCT FROM 'pos_base' THEN
    RAISE EXCEPTION '${CMS_128_CODES.attestNotSupported}' USING ERRCODE = 'P0001';
  END IF;
`, 'attest unit')
  out.rpc_cms_source_attest = t

  // rpc_cms_run_source_export (124): kèm cơ sở / phiên bản (snapshot tra soát, không phải chứng nhận).
  t = orReplace(base.rpc_cms_run_source_export)
  t = patch(t, "  RETURN jsonb_build_object('run_id', p_run_id, 'source_schema', v_run.source_schema, 'rows', v_rows,",
    "  RETURN jsonb_build_object('run_id', p_run_id, 'source_schema', v_run.source_schema, 'rows', v_rows,\n                            -- 128: snapshot tra soát kèm cơ sở tính của run; run cms_unit không chứng nhận được (attestation_supported false).\n                            'quantity_basis', v_run.quantity_basis, 'calculation_policy_version', v_run.calculation_policy_version,\n                            'attestation_supported', v_run.quantity_basis IS NOT DISTINCT FROM 'pos_base',", 'export basis')
  out.rpc_cms_run_source_export = t

  // ── Lắp file ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const sec = (s) => `\n-- ── ${s} ${'─'.repeat(Math.max(4, 74 - s.length))}\n`
  const md5Block = (pairs, msg) => `DO $$
BEGIN
  IF ${pairs.map(([sig, body]) => `(SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.${sig}'::regprocedure) IS DISTINCT FROM '${md5(cmsProsrc(body))}'`).join('\n     OR ')} THEN
    RAISE EXCEPTION '${msg}';
  END IF;
END $$;`
  const schema = [
    ['@@UNIT_KEY_VERSION@@', UK.CMS_UNIT_KEY_VERSION], ['@@UNIT_KEY_WS@@', null], ['@@UNIT_KEY_UP@@', sqlLit(UK.CMS_UNIT_CASE_UPPER)],
    ['@@UNIT_KEY_LO@@', sqlLit(UK.CMS_UNIT_CASE_LOWER)],
  ].reduce((acc, [k, v]) => {
    if (k === '@@UNIT_KEY_WS@@') return patch(acc, `'${k}'`, `U&'${uLit(UK.CMS_UNIT_WS)}'`, 'ws literal')
    const n = acc.split(k).length - 1
    if (n < 1) throw new Error(`placeholder ${k} không có`)
    return acc.split(k).join(v)
  }, tpl('b-schema.sql'))
  const fnFromSchema = (name) => {
    const i = schema.indexOf(`CREATE FUNCTION public.${name}(`)
    return schema.slice(i, schema.indexOf('$$;', schema.indexOf('AS $$', i) + 5) + 3)
  }
  const sigList = [...CMS_128_NEW, ...CMS_128_REPLACED].map((x) => `'public.${x.sig}'`).join(', ')
  const names = (g) => CMS_128_REPLACED.filter((x) => x.grant === g).map((x) => `'${x.name}'`).join(', ')
  const tail = [['@@ALL_SIGS@@', sigList], ['@@SVC_NAMES@@', names('service_role')], ['@@AUTH_NAMES@@', names('authenticated')]]
    .reduce((acc, [k, v]) => acc.split(k).join(v), tpl('c-tail.sql'))

  const PREFLIGHT_MD5 = md5Block(CMS_128_REPLACED.map((r) => [r.sig, base[r.name]]),
    '128 preflight: thân một trong 15 hàm sắp thay KHÁC bản cuối đã duyệt (md5) — dừng, đối chiếu tay')
  const POST_MD5 = md5Block([...CMS_128_NEW.map((x) => [x.sig, fnFromSchema(x.name)]), ...CMS_128_REPLACED.map((r) => [r.sig, out[r.name]])],
    '128 hậu kiểm: thân 21 hàm lệch bản sinh (md5)')
  const RB_PRE_MD5 = md5Block(CMS_128_REPLACED.map((r) => [r.sig, out[r.name]]),
    'rollback 128 preflight: thân 15 hàm hiện tại KHÁC bản 128 đã sinh (md5) — có sửa tay? dừng, đối chiếu')
  const RB_POST_MD5 = md5Block(CMS_128_REPLACED.map((r) => [r.sig, base[r.name]]), 'rollback 128 hậu kiểm: thân 15 hàm khôi phục lệch nguyên văn (md5)')

  const migration = [
    patch(tpl('a-head.sql'), '-- @@PREFLIGHT_MD5@@', PREFLIGHT_MD5, 'preflight md5'),
    schema,
    sec('6. Mười lăm hàm thay (thân nguyên văn bản cuối + vá gen-cms-128)'),
    CMS_128_REPLACED.map((r) => out[r.name]).join('\n\n'), '\n',
    patch(tail, '-- @@POST_MD5@@', POST_MD5, 'post md5'),
  ].join('')
  const rbTail = [['@@ALL_SIGS_OLD@@', CMS_128_REPLACED.map((x) => `'public.${x.sig}'`).join(', ')],
    ['@@SVC_NAMES@@', names('service_role')], ['@@AUTH_NAMES@@', names('authenticated')]]
    .reduce((acc, [k, v]) => acc.split(k).join(v), tpl('rb-tail.sql'))
  const rollback = [
    patch(tpl('rb-head.sql'), '-- @@PRE_MD5@@', RB_PRE_MD5, 'rollback pre md5'),
    sec('Khôi phục NGUYÊN VĂN 15 hàm (bản cuối trước 128)'), CMS_128_REPLACED.map((r) => orReplace(base[r.name])).join('\n\n'), '\n',
    patch(rbTail, '-- @@MD5_CHECK@@', RB_POST_MD5, 'rollback md5 check'),
  ].join('')
  const md5s = {
    base: Object.fromEntries(CMS_128_REPLACED.map((r) => [r.name, md5(cmsProsrc(base[r.name]))])),
    after: Object.fromEntries([...CMS_128_NEW.map((x) => [x.name, md5(cmsProsrc(fnFromSchema(x.name)))]),
      ...CMS_128_REPLACED.map((r) => [r.name, md5(cmsProsrc(out[r.name]))])]),
  }
  return { migration, rollback, base, replaced: out, md5s, fnFromSchema }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const { migration, rollback, md5s } = buildCms128()
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex')
  if (process.argv.includes('--check')) {
    const same = (f, s) => fs.existsSync(f) && fs.readFileSync(f, 'utf8') === s
    const ok = same(CMS_128_FILE, migration) && same(CMS_128_ROLLBACK_FILE, rollback)
    console.log(ok ? 'gen-cms-128: file trên đĩa KHỚP bản sinh' : 'gen-cms-128: LỆCH bản sinh — chạy lại node scripts/gen-cms-128.mjs')
    process.exitCode = ok ? 0 : 1
  } else {
    fs.writeFileSync(CMS_128_FILE, migration)
    fs.writeFileSync(CMS_128_ROLLBACK_FILE, rollback)
    console.log(`128_cms_unit_quantity_basis.sql ${migration.split('\n').length - 1} dòng sha256 ${h(migration)}`)
    console.log(`rollback/128_cms_unit_quantity_basis_rollback.sql ${rollback.split('\n').length - 1} dòng sha256 ${h(rollback)}`)
    console.log(`md5 prosrc: ${JSON.stringify(md5s)}`)
  }
}
