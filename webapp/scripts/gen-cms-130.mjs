#!/usr/bin/env node
// CMS 130 (CMS-CALC-RET-2 — candidate theo thiết kế Dev r2 planning/research/cms-calc-ret2-dev-design-r2-2026-11-13.md): SINH
// supabase/migrations/130_cms_calculation_modes_returns.sql + rollback từ scripts/cms-130/*.sql + thân NGUYÊN VĂN định nghĩa cuối của
// các hàm thay / ghim trong 120–126 + hằng hợp đồng TS (lib/cms/unitKey.ts · lib/cms/calc/fp.ts · lib/cms/calc/returns.ts).
// Mỗi chỗ vá khớp ĐÚNG MỘT lần (split/join — không String.replace để không ăn `$$`). KHÔNG sửa tay file sinh ra.
//   node scripts/gen-cms-130.mjs            # ghi 2 file, in sha256 + md5 thân
//   node scripts/gen-cms-130.mjs --check    # chỉ so: file trên đĩa ≠ bản sinh ⇒ thoát 1 (harness: scripts/qa-cms-130.mjs)
// Đủ lát L1–L7 (helper · chương trình · run contract · sổ trả hàng · reader v2 · báo cáo sau chốt · chốt / attest) — header file sinh.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const TPL = path.join(HERE, 'cms-130')
export const CMS_130_FILE = path.join(MIG, '130_cms_calculation_modes_returns.sql')
export const CMS_130_ROLLBACK_FILE = path.join(MIG, 'rollback', '130_cms_calculation_modes_returns_rollback.sql')

const jiti = createJiti(import.meta.url, { interopDefault: true })
const UK = await jiti.import(path.join(HERE, '..', 'lib', 'cms', 'unitKey.ts'))
const FP = await jiti.import(path.join(HERE, '..', 'lib', 'cms', 'calc', 'fp.ts'))
const RT = await jiti.import(path.join(HERE, '..', 'lib', 'cms', 'calc', 'returns.ts'))
const PL = await jiti.import(path.join(HERE, '..', 'lib', 'cms', 'calc', 'policy.ts'))

/** Phiên bản hợp đồng run contract / pin nguồn (thiết kế r2 §1.2 / §4.3). */
export const CMS_130_CALC_CONTRACT = 'cms-calc-ret2-v1'
export const CMS_130_SOURCE_PIN = 'cms-source-pin-v1'
/** Digest lớp nguồn / phiếu trả / tập SP của pin (seal N9) — cùng hợp đồng TS. */
export const CMS_130_SRC_DIGEST = 'cms-src-digest-v1'
/** Tập code point String.prototype.trim cắt SAU khi điều khiển → space (đo bằng e2e/cms-calc-ret2-fp-unit.spec.ts). */
export const CMS_130_SRC_TRIM = Object.freeze([0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff])
/** Số hàm CMS sau 127 (126 hậu kiểm = 68; 127 không thêm hàm). */
export const CMS_130_FN_BEFORE = 68

/** Hàm thay thân (thiết kế r2 §1.1) — cả 13 có đoạn vá ở r-patches.sql; preflight ghim md5 thân nền cả 13. */
export const CMS_130_REPLACED = Object.freeze([
  { name: 'rpc_cms_sales_run_open', sig: 'rpc_cms_sales_run_open(uuid,jsonb)', grant: 'service_role' },
  { name: 'rpc_cms_sales_run_stage', sig: 'rpc_cms_sales_run_stage(uuid,text,integer,jsonb)', grant: 'service_role' },
  { name: 'rpc_cms_sales_run_cleanup', sig: 'rpc_cms_sales_run_cleanup(uuid,integer)', grant: 'service_role' },
  { name: 'cms__lock_eval', sig: 'cms__lock_eval(uuid,uuid,integer,text,boolean)', grant: null },
  { name: 'cms__attest_eval', sig: 'cms__attest_eval(uuid,uuid)', grant: null },
  { name: 'rpc_cms_sales_run_seal_begin', sig: 'rpc_cms_sales_run_seal_begin(uuid,jsonb)', grant: 'service_role' },
  { name: 'rpc_cms_sales_run_seal_step', sig: 'rpc_cms_sales_run_seal_step(uuid,integer)', grant: 'service_role' },
  { name: 'cms__sales_snapshot', sig: 'cms__sales_snapshot(uuid)', grant: null },
  { name: 'rpc_cms_result_header', sig: 'rpc_cms_result_header(uuid)', grant: 'authenticated' },
  { name: 'rpc_cms_result_rows', sig: 'rpc_cms_result_rows(uuid,uuid)', grant: 'authenticated' },
  { name: 'rpc_cms_result_lines', sig: 'rpc_cms_result_lines(uuid,uuid,uuid,uuid,integer,integer)', grant: 'authenticated' },
  { name: 'rpc_cms_result_excluded', sig: 'rpc_cms_result_excluded(uuid,uuid,integer,integer)', grant: 'authenticated' },
  { name: 'rpc_cms_sales_run_publish', sig: 'rpc_cms_sales_run_publish(uuid)', grant: 'service_role' },
])
/** Ghim không thay: 7 hàm nền 130 dựa vào + 5 guard 127 (guard thứ 6 của 127 = cms__programs_lock_guard, đã trong 7). */
export const CMS_130_PINNED = Object.freeze([
  { name: 'rpc_cms_program_save', sig: 'rpc_cms_program_save(jsonb)' },
  { name: 'rpc_cms_import_commit', sig: 'rpc_cms_import_commit(uuid,text,text,jsonb,uuid)' },
  { name: 'rpc_cms_program_activate', sig: 'rpc_cms_program_activate(uuid,uuid)' },
  { name: 'cms__config_fp', sig: 'cms__config_fp(uuid)' },
  { name: 'cms__programs_lock_guard', sig: 'cms__programs_lock_guard()' },
  { name: 'rpc_cms_source_attest', sig: 'rpc_cms_source_attest(uuid,uuid,jsonb,uuid)' },
  { name: 'rpc_cms_sales_run_finish', sig: 'rpc_cms_sales_run_finish(uuid,text,jsonb)' },
  { name: 'cms__programs_result_guard', sig: 'cms__programs_result_guard()' },
  { name: 'cms__programs_guard', sig: 'cms__programs_guard()' },
  { name: 'cms__config_auth_guard', sig: 'cms__config_auth_guard()' },
  { name: 'cms__config_lock_guard', sig: 'cms__config_lock_guard()' },
  { name: 'cms__tiers_last_open_guard', sig: 'cms__tiers_last_open_guard()' },
])
/** Hàm mới — grant: [] = chỉ owner. `tpl` = template chứa CREATE FUNCTION. */
export const CMS_130_NEW = Object.freeze([
  { name: 'cms__src_clean', sig: 'cms__src_clean(text)', grant: [], tpl: 'b-helpers.sql' },
  { name: 'cms__unit_key', sig: 'cms__unit_key(text)', grant: [], tpl: 'b-helpers.sql' },
  { name: 'cms__qty_dec', sig: 'cms__qty_dec(text)', grant: [], tpl: 'b-helpers.sql' },
  { name: 'cms__return_status_effect', sig: 'cms__return_status_effect(text)', grant: [], tpl: 'b-helpers.sql' },
  { name: 'cms__return_fp', sig: 'cms__return_fp(text,uuid,text,text,text,text,text,numeric,numeric,timestamp with time zone)', grant: [], tpl: 'b-helpers.sql' },
  { name: 'cms__programs_basis_guard', sig: 'cms__programs_basis_guard()', grant: [], tpl: 'c-programs.sql' },
  { name: 'cms__products_basis_guard', sig: 'cms__products_basis_guard()', grant: [], tpl: 'c-programs.sql' },
  { name: 'rpc_cms_program_save_v2', sig: 'rpc_cms_program_save_v2(jsonb)', grant: ['service_role'], tpl: 'c-programs.sql' },
  { name: 'rpc_cms_program_set_returns_policy', sig: 'rpc_cms_program_set_returns_policy(uuid,text,integer,uuid)', grant: ['service_role'], tpl: 'c-programs.sql' },
  { name: 'rpc_cms_capabilities', sig: 'rpc_cms_capabilities()', grant: ['authenticated', 'service_role'], tpl: 'c-programs.sql' },
  { name: 'cms__stage_contract', sig: 'cms__stage_contract(uuid,text,integer,jsonb)', grant: [], tpl: 'e-stage.sql' },
  { name: 'cms__seal_begin_contract', sig: 'cms__seal_begin_contract(uuid,jsonb)', grant: [], tpl: 'e-stage.sql' },
  { name: 'cms__seal_contract_step', sig: 'cms__seal_contract_step(uuid,integer)', grant: [], tpl: 'f-seal.sql' },
  { name: 'cms__ledger_set_hash', sig: 'cms__ledger_set_hash(uuid)', grant: [], tpl: 'g-ledger.sql' },
  { name: 'cms__open_set_hash', sig: 'cms__open_set_hash(uuid)', grant: [], tpl: 'g-ledger.sql' },
  { name: 'cms__as_of_floor', sig: 'cms__as_of_floor(uuid)', grant: [], tpl: 'g-ledger.sql' },
  { name: 'cms__ledger_immutable', sig: 'cms__ledger_immutable()', grant: [], tpl: 'g-ledger.sql' },
  { name: 'cms__ledger_eval_guard', sig: 'cms__ledger_eval_guard()', grant: [], tpl: 'g-ledger.sql' },
  { name: 'cms__ledger_insert_guard', sig: 'cms__ledger_insert_guard()', grant: [], tpl: 'g-ledger.sql' },
  { name: 'cms__ledger_eval', sig: 'cms__ledger_eval(uuid,text,uuid,timestamp with time zone,text,jsonb)', grant: [], tpl: 'g-ledger.sql' },
  { name: 'cms__publish_contract', sig: 'cms__publish_contract(uuid)', grant: [], tpl: 'g-ledger.sql' },
  { name: 'rpc_cms_return_conflicts_confirm_restored', sig: 'rpc_cms_return_conflicts_confirm_restored(uuid,text,bigint,text,uuid)', grant: ['authenticated'], tpl: 'g-ledger.sql' },
  { name: 'cms__run_contract', sig: 'cms__run_contract(uuid)', grant: [], tpl: 'h-readers.sql' },
  { name: 'rpc_cms_result_header_v2', sig: 'rpc_cms_result_header_v2(uuid)', grant: ['authenticated'], tpl: 'h-readers.sql' },
  { name: 'rpc_cms_result_rows_v2', sig: 'rpc_cms_result_rows_v2(uuid,uuid)', grant: ['authenticated'], tpl: 'h-readers.sql' },
  { name: 'rpc_cms_result_events_v2', sig: 'rpc_cms_result_events_v2(uuid,uuid,uuid,uuid,integer,integer)', grant: ['authenticated'], tpl: 'h-readers.sql' },
  { name: 'rpc_cms_result_excluded_v2', sig: 'rpc_cms_result_excluded_v2(uuid,uuid,text,integer,integer)', grant: ['authenticated'], tpl: 'h-readers.sql' },
  { name: 'rpc_cms_result_returns_v2', sig: 'rpc_cms_result_returns_v2(uuid,uuid,integer,integer)', grant: ['authenticated'], tpl: 'h-readers.sql' },
  { name: 'rpc_cms_return_conflicts', sig: 'rpc_cms_return_conflicts(uuid)', grant: ['authenticated'], tpl: 'h-readers.sql' },
  { name: 'cms__report_rows', sig: 'cms__report_rows(jsonb)', grant: [], tpl: 'i-report.sql' },
  { name: 'rpc_cms_return_close_report_save', sig: 'rpc_cms_return_close_report_save(uuid,uuid,jsonb)', grant: ['service_role'], tpl: 'i-report.sql' },
  { name: 'rpc_cms_frozen_sales_lines', sig: 'rpc_cms_frozen_sales_lines(uuid,integer,integer)', grant: ['service_role'], tpl: 'i-report.sql' },
  { name: 'rpc_cms_return_close_reports', sig: 'rpc_cms_return_close_reports(uuid)', grant: ['authenticated'], tpl: 'i-report.sql' },
  { name: 'rpc_cms_return_close_report', sig: 'rpc_cms_return_close_report(uuid,integer,integer)', grant: ['authenticated'], tpl: 'i-report.sql' },
  { name: 'rpc_cms_return_close_report_events', sig: 'rpc_cms_return_close_report_events(uuid,text,integer)', grant: ['authenticated'], tpl: 'i-report.sql' },
])
/** Thứ tự template thân migration (sau a-head, trước thân thay + z-tail). */
const BODY_TEMPLATES = ['b-helpers.sql', 'c-programs.sql', 'd-runs.sql', 'e-stage.sql', 'f-seal.sql', 'g-ledger.sql', 'h-readers.sql', 'i-report.sql']
/** Đoạn vá thân hàm thay (định dạng mô tả đầu file). */
const PATCH_FILE = 'r-patches.sql'

/** Đọc r-patches.sql ⇒ Map<tên hàm, [{label, from, to}]> (thứ tự khai báo). */
function readPatches(text) {
  const out = new Map()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^-- @@PATCH ([a-z_]+) ([a-z0-9-]+)$/.exec(lines[i])
    if (!m) continue
    if (lines[i + 1] !== '-- @@FROM') throw new Error(`patch ${m[1]} ${m[2]}: thiếu @@FROM`)
    const iTo = lines.indexOf('-- @@TO', i + 2)
    const iEnd = lines.indexOf('-- @@END', i + 2)
    const iNext = lines.findIndex((l, k) => k > i && l.startsWith('-- @@PATCH '))
    if (iTo < 0 || iEnd < iTo || (iNext >= 0 && iNext < iEnd)) throw new Error(`patch ${m[1]} ${m[2]}: khối hỏng`)
    const from = lines.slice(i + 2, iTo).join('\n')
    const to = lines.slice(iTo + 1, iEnd).join('\n')
    if (!from.trim() || from === to) throw new Error(`patch ${m[1]} ${m[2]}: FROM rỗng hoặc trùng TO`)
    if (!out.has(m[1])) out.set(m[1], [])
    if (out.get(m[1]).some((p) => p.label === m[2])) throw new Error(`patch ${m[1]} ${m[2]}: trùng nhãn`)
    out.get(m[1]).push({ label: m[2], from, to })
    i = iEnd
  }
  if (/@@(FROM|TO|END)/.test(lines.filter((l, k) => !/^-- @@(PATCH|FROM|TO|END)/.test(l)).join('\n'))) {
    throw new Error('r-patches.sql: marker lệch dòng')
  }
  return out
}
const asReplace = (t) => {
  const r = t.replace(/^CREATE (OR REPLACE )?FUNCTION /, 'CREATE OR REPLACE FUNCTION ')
  if (r === t && !t.startsWith('CREATE OR REPLACE FUNCTION ')) throw new Error('thân không bắt đầu bằng CREATE FUNCTION')
  return r
}
/** Bảng mới (REVOKE đích danh + hậu kiểm has_table_privilege = false cho anon / authenticated / service_role). */
export const CMS_130_TABLES = Object.freeze(['cms_return_lines', 'cms_result_events', 'cms_return_close_reports', 'cms_return_close_report_lines',
  'cms_return_close_report_events', 'cms_return_ledger_evals',
  'cms_return_baselines', 'cms_return_conflicts', 'cms_return_restorations', 'cms_return_conflict_restorations', 'cms_return_conflict_observations'])
/** Sequence mới (identity) — cùng gate. */
export const CMS_130_SEQUENCES = Object.freeze(['cms_return_conflicts_id_seq'])

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
/** VERIFY sau COMMIT (db-reviewer 14/11 P1-3): SQL chỉ đọc + kỳ vọng sinh từ registry (không đếm tay). Phase 130 của cms-verify.mjs chưa có. */
function verifyBlock(aclRows) {
  const n = aclRows.length
  const auth = aclRows.filter((r) => r.grant.includes('authenticated')).length
  const svc = aclRows.filter((r) => r.grant.includes('service_role')).length
  const owner = aclRows.filter((r) => !r.grant.length).length
  const wrap = (items, pre) => { const out = []; let cur = pre; for (const it of items) { if ((cur + it).length > 132) { out.push(cur.trimEnd()); cur = '--       ' } cur += it } out.push(cur.replace(/, $/, '')); return out.join('\n') }
  const sigs = wrap(aclRows.map((r) => sqlLit(r.sig) + ', '), '--     FROM unnest(ARRAY[')
  const tabs = wrap(CMS_130_TABLES.map((t) => sqlLit(t) + ', '), '--     AND c.relname IN (')
  return [
    '-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — operator chạy từng khối trong Studio / pg-meta, bọc BEGIN READ ONLY; … COMMIT;) ──────────────────',
    '-- Kỳ vọng ghi ngay trên mỗi khối, sinh từ registry generator. Lệch ⇒ báo Dev, KHÔNG sửa tay. Phase 130 của scripts/cms-verify.mjs',
    '-- CHƯA có (Dev làm trước cửa sổ A) — khối dưới là bằng chứng sau COMMIT cho gate ACL (AGENTS §4.2).',
    "-- V1 marker — 2 dòng: 127 cms_t11_flat_amounts · 130 cms_calculation_modes_returns.",
    "--   SELECT version, name FROM public.app_migrations WHERE version IN ('127', '130') ORDER BY 1;",
    `-- V2 ACL — n = ${n} · anon_x = 0 · auth_x = ${auth} · svc_x = ${svc} · owner_only = ${owner} · secdef = ${n} · sp = ${n}.`,
    "--   SELECT count(*) n, count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE')) anon_x,",
    "--          count(*) FILTER (WHERE has_function_privilege('authenticated', p.oid, 'EXECUTE')) auth_x,",
    "--          count(*) FILTER (WHERE has_function_privilege('service_role', p.oid, 'EXECUTE')) svc_x,",
    "--          count(*) FILTER (WHERE NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')",
    "--                             AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')) owner_only,",
    "--          count(*) FILTER (WHERE p.prosecdef) secdef, count(*) FILTER (WHERE 'search_path=public' = ANY (p.proconfig)) sp",
    "--     FROM pg_proc p WHERE p.oid IN (SELECT to_regprocedure('public.' || s)",
    sigs + ']) s);',
    `-- V3 bảng mới — ${CMS_130_TABLES.length} dòng, mỗi dòng rls = true · pol = 0 · a = u = s = false; sequence: 3 false.`,
    "--   SELECT c.relname, c.relrowsecurity rls, (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) pol,",
    "--          has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') a,",
    "--          has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') u,",
    "--          has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') s",
    "--     FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'",
    tabs + ') ORDER BY 1;',
    `--   SELECT ${CMS_130_SEQUENCES.map((s) => ['anon', 'authenticated', 'service_role'].map((r) => `has_sequence_privilege('${r}', 'public.${s}', 'USAGE,SELECT,UPDATE')`).join(', ')).join(', ')};`,
    '-- V4 trigger ENABLE ALWAYS — cms_result_events 5/5 · cms_return_lines 5/5 · 9 bảng sổ mỗi bảng 3/3 (tổng 27) · 2 trigger basis.',
    '--   SELECT c.relname, count(*) total, count(*) FILTER (WHERE t.tgenabled = \'A\') always',
    '--     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid',
    "--    WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace",
    "--      AND (c.relname LIKE 'cms\\_return\\_%' OR c.relname = 'cms_result_events' OR t.tgname IN ('cms_programs_basis_guard', 'cms_products_basis_guard'))",
    '--    GROUP BY 1 ORDER BY 1;',
    '-- V5 sổ rỗng ngay sau migrate — mọi cột = 0.',
    '--   SELECT (SELECT count(*) FROM public.cms_return_ledger_evals) evals, (SELECT count(*) FROM public.cms_return_baselines) bl,',
    '--          (SELECT count(*) FROM public.cms_return_conflicts) cf, (SELECT count(*) FROM public.cms_return_close_reports) rp,',
    '--          (SELECT count(*) FROM public.cms_sync_runs WHERE calc_contract_version IS NOT NULL) runs_ct;',
    '-- V6 backfill — đúng một nhóm (pos_base, legacy_migration, sales_only_v1, n = số chương trình trước 130).',
    '--   SELECT quantity_basis, quantity_basis_source, returns_policy, count(*) FROM public.cms_programs GROUP BY 1, 2, 3;',
    `-- V7 tổng hàm CMS = ${CMS_130_FN_BEFORE + CMS_130_NEW.length} (${CMS_130_FN_BEFORE} + ${CMS_130_NEW.length} mới).`,
    "--   SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\\_%' OR proname LIKE 'rpc\\_cms\\_%');",
    '-- V8 policy chốt thật vẫn đóng — false.',
    "--   SELECT (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean;",
  ].join('\n') + '\n'
}
/** prosrc = chuỗi giữa `AS $$` và `$$;` cuối, BỎ \r (cùng công thức VERIFY md5(replace(prosrc, E'\r', ''))). */
export const cmsProsrc = (t) => t.slice(t.indexOf('AS $$') + 5, t.lastIndexOf('$$;')).split('\r').join('')
const sqlLit = (s) => `'${String(s).split("'").join("''")}'`
const uEsc = (cp) => (cp > 0xffff ? `\\U${cp.toString(16).toUpperCase().padStart(8, '0')}` : `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`)
function patch(text, from, to, label) {
  const n = text.split(from).length - 1
  if (n !== 1) throw new Error(`vá "${label}": khớp ${n} lần (cần đúng 1)`)
  return text.split(from).join(to)
}
/** Điền placeholder có mặt (số đếm dùng chung nhiều template). */
const fillSome = (text, pairs) => pairs.reduce((acc, [k, v]) => acc.split(k).join(String(v)), text)
const fillAll = (text, pairs) => pairs.reduce((acc, [k, v]) => {
  if (!acc.includes(k)) throw new Error(`template thiếu ${k}`)
  return acc.split(k).join(String(v))
}, text)

/** Định nghĩa CUỐI CÙNG của public.<name>( trong chuỗi 120–126 (CREATE [OR REPLACE] FUNCTION) — thân hiện hành sau 127. */
export function cmsLastDefinition(name) {
  const files = fs.readdirSync(MIG).filter((f) => /^12[0-6]_.*\.sql$/.test(f)).sort()
  let found = null
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIG, f), 'utf8')
    const re = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`, 'g')
    let m
    let n = 0
    while ((m = re.exec(sql))) {
      n++
      const j = sql.indexOf('$$;', sql.indexOf('AS $$', m.index) + 5)
      found = { file: f, text: sql.slice(m.index, j + 3) }
    }
    if (n > 1) throw new Error(`${name}: ${n} định nghĩa trong ${f}`)
  }
  if (!found) throw new Error(`không thấy định nghĩa ${name} trong 120–126`)
  return found
}
/** Lấy `CREATE FUNCTION public.<name>(` … `$$;` từ một template đã điền. */
function fnFrom(text, name) {
  const key = `CREATE FUNCTION public.${name}(`
  const i = text.indexOf(key)
  if (i < 0 || text.indexOf(key, i + 1) >= 0) throw new Error(`hàm ${name}: không thấy hoặc trùng trong template`)
  return text.slice(i, text.indexOf('$$;', text.indexOf('AS $$', i) + 5) + 3)
}
function invisClass(ranges) {
  const u = (n) => {
    if (!Number.isInteger(n) || n < 0xa0 || n > 0xffff) throw new Error(`CMS_UNIT_INVISIBLE: code point ${n} ngoài BMP / lớp điều khiển`)
    if ([...UK.CMS_UNIT_WS].some((c) => c.codePointAt(0) === n)) throw new Error(`CMS_UNIT_INVISIBLE: U+${n.toString(16)} trùng tập cắt`)
    return uEsc(n)
  }
  if (!Array.isArray(ranges) || ranges.length === 0) throw new Error('CMS_UNIT_INVISIBLE rỗng')
  return ranges.map(([a, b]) => { if (!(b >= a)) throw new Error('khoảng ngược'); for (let n = a; n <= b; n++) u(n); return a === b ? u(a) : `${u(a)}-${u(b)}` }).join('')
}

/** Khối ACL bảng / sequence mới (r2 P1-9): REVOKE đích danh, thu mọi grantee khác owner (default privileges kiểu Supabase), hậu kiểm
 *  has_table_privilege / has_sequence_privilege = false cho anon / authenticated / service_role; RLS bật, 0 policy. */
function tableAcl() {
  const tabs = CMS_130_TABLES.map((t) => `public.${t}`)
  const seqs = CMS_130_SEQUENCES.map((s) => `public.${s}`)
  const names = [...CMS_130_TABLES, ...CMS_130_SEQUENCES].map(sqlLit).join(', ')
  const privs = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
  return [
    `REVOKE ALL ON ${tabs.join(', ')} FROM PUBLIC, anon, authenticated, service_role;`,
    seqs.length ? `REVOKE ALL ON SEQUENCE ${seqs.join(', ')} FROM PUBLIC, anon, authenticated, service_role;` : '',
    `DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel, c.relkind, a.grantee
      FROM pg_catalog.pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${names}) AND a.grantee <> c.relowner
     GROUP BY c.oid, c.relkind, a.grantee
  LOOP
    EXECUTE format('REVOKE ALL ON %s %s FROM %s', CASE WHEN r.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, r.rel,
                   CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) END);
  END LOOP;
END $$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS ro(r)
              CROSS JOIN (VALUES ${privs.map((p) => `('${p}')`).join(', ')}) AS pv(p)
              WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${names}) AND c.relkind IN ('r', 'p')
                AND has_table_privilege(ro.r, c.oid, pv.p))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS ro(r)
              CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) AS pv(p)
              WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${names}) AND c.relkind = 'S'
                AND has_sequence_privilege(ro.r, c.oid, pv.p))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${names})
                 AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
                 WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${names}))
     OR (SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${names}))
        <> ${CMS_130_TABLES.length + CMS_130_SEQUENCES.length} THEN
    RAISE EXCEPTION '130 hậu kiểm: bảng / sequence mới phải RLS bật, 0 policy, không quyền cho anon / authenticated / service_role';
  END IF;
END $$;`,
  ].filter(Boolean).join('\n')
}

export function buildCms130() {
  const tpl = (f) => fs.readFileSync(path.join(TPL, f), 'utf8')
  // ── Hằng hợp đồng → literal SQL ─────────────────────────────────────────────────────────────────────────────────────────────
  const dict = [...RT.CMS_RETURN_STATUS_DICTIONARY.entries()]
  if (dict.length !== 2 || dict.some(([k, v]) => !/^[A-Z_]+$/.test(k) || !['EFFECTIVE', 'NOT_EFFECTIVE'].includes(v))) {
    throw new Error('từ điển trạng thái TS ngoài dạng hợp đồng v1')
  }
  if (CMS_130_SRC_TRIM.some((cp) => (cp >= 0x01 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f))) throw new Error('tập cắt chứa điều khiển')
  const literal = [
    ["'@@SRC_TRIM@@'", `E'${CMS_130_SRC_TRIM.map(uEsc).join('')}'`],
    ["'@@UNIT_KEY_INVIS@@'", `E'[${invisClass(UK.CMS_UNIT_INVISIBLE)}]'`],
    ["'@@UNIT_KEY_WS@@'", `E'${[...UK.CMS_UNIT_WS].map((c) => uEsc(c.codePointAt(0))).join('')}'`],
    ["'@@UNIT_KEY_UP@@'", sqlLit(UK.CMS_UNIT_CASE_UPPER)],
    ["'@@UNIT_KEY_LO@@'", sqlLit(UK.CMS_UNIT_CASE_LOWER)],
  ]
  const words = [
    ['@@UNIT_KEY_VERSION@@', UK.CMS_UNIT_KEY_VERSION], ['@@STATUS_VERSION@@', RT.CMS_RETURN_STATUS_DICTIONARY_VERSION],
    ['@@FP_VERSION@@', FP.CMS_RETURN_FP_VERSION], ['@@CALC_CONTRACT@@', CMS_130_CALC_CONTRACT], ['@@SOURCE_PIN@@', CMS_130_SOURCE_PIN], ['@@SRC_DIGEST@@', CMS_130_SRC_DIGEST],
    ['@@QPV_POS@@', PL.CMS_QUANTITY_POLICY_VERSION.pos_base], ['@@QPV_UNIT@@', PL.CMS_QUANTITY_POLICY_VERSION.cms_unit],
    ['@@SRC_MAX@@', FP.CMS_SRC_MAX],
    ['@@STATUS_CASE@@', `p_status ${dict.map(([k, v]) => `WHEN ${sqlLit(k)} THEN ${sqlLit(v)}`).join(' ')}`],
  ]
  const fillBody = (text) => {
    let t = text
    for (const [k, v] of literal) if (t.includes(k)) t = patch(t, k, v, k)
    for (const [k, v] of words) if (t.includes(k)) t = t.split(k).join(v)
    const left = t.match(/@@[A-Z0-9_]+@@/g)
    if (left) throw new Error(`template còn placeholder ${[...new Set(left)].join(' ')}`)
    return t
  }
  const bodies = BODY_TEMPLATES.map((f) => fillBody(tpl(f)))
  const bodyText = bodies.join('')
  const newDefs = Object.fromEntries(CMS_130_NEW.map((x) => [x.name, fnFrom(bodyText, x.name)]))

  // ── Thân nền (preflight) ────────────────────────────────────────────────────────────────────────────────────────────────────
  const base = Object.fromEntries([...CMS_130_REPLACED, ...CMS_130_PINNED].map((x) => [x.name, cmsLastDefinition(x.name)]))
  const md5Block = (pairs, msg) => `DO $$
BEGIN
  IF ${pairs.map(([sig, body]) => `(SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.${sig}')) IS DISTINCT FROM '${md5(cmsProsrc(body))}'`).join('\n     OR ')} THEN
    RAISE EXCEPTION '${msg}';
  END IF;
END $$;`
  const PREFLIGHT_MD5 = md5Block(CMS_130_REPLACED.map((x) => [x.sig, base[x.name].text]),
    `130 preflight: thân một trong ${CMS_130_REPLACED.length} hàm sắp thay KHÁC bản cuối 120–126 đã duyệt (md5) — dừng, đối chiếu tay`)
    + '\n' + md5Block(CMS_130_PINNED.map((x) => [x.sig, base[x.name].text]),
      `130 preflight: thân một trong ${CMS_130_PINNED.length} hàm ghim (nền 130 + guard 127) KHÁC bản đã duyệt (md5) — dừng, đối chiếu tay`)

  // ── Thân thay: định nghĩa cuối 120–126 + đoạn vá r-patches.sql ────────────────────────────────────────────────────────────────
  const patches = readPatches(tpl(PATCH_FILE))
  for (const n of patches.keys()) if (!CMS_130_REPLACED.some((x) => x.name === n)) throw new Error(`patch cho hàm ngoài registry: ${n}`)
  const replacedNow = CMS_130_REPLACED.filter((x) => patches.has(x.name))
  const repDefs = Object.fromEntries(replacedNow.map((x) => {
    let t = asReplace(base[x.name].text)
    for (const p of patches.get(x.name)) t = patch(t, p.from, fillBody(p.to), `${x.name} ${p.label}`)
    if (t.includes('\r')) throw new Error(`${x.name}: thân vá có CR`)
    return [x.name, t]
  }))
  const repSection = replacedNow.length
    ? `\n-- ── R. Thân thay (định nghĩa cuối 120–126 + đoạn vá r-patches.sql; rollback dựng lại nguyên văn) ──\n`
      + replacedNow.map((x) => `-- ${x.name}: nền ${base[x.name].file}; vá ${patches.get(x.name).map((p) => p.label).join(', ')}\n${repDefs[x.name]}\n`).join('')
    : ''
  const restoreSection = replacedNow.length
    ? `\n-- ── Dựng lại NGUYÊN VĂN thân 120–126 của ${replacedNow.length} hàm thay (trước khi gỡ cột / bảng / hàm mới) ──\n`
      + replacedNow.map((x) => `${asReplace(base[x.name].text)}\n`).join('')
    : ''

  // ── ACL (ma trận tường minh) ────────────────────────────────────────────────────────────────────────────────────────────────
  const aclRows = [
    ...CMS_130_NEW.map((x) => ({ sig: x.sig, grant: x.grant })),
    ...replacedNow.map((x) => ({ sig: x.sig, grant: x.grant ? [x.grant] : [] })),
  ]
  const aclString = (g) => (g.length ? g.slice().sort().map((r) => `${r}:EXECUTE`).join(',') : null)
  const aclValues = aclRows.map((r, i) => `(${sqlLit(r.sig)}, false, ${r.grant.includes('authenticated')}, ${r.grant.includes('service_role')}, ${aclString(r.grant) === null ? 'NULL' : sqlLit(aclString(r.grant))}${i === 0 ? '::text' : ''})`).join(',\n              ')
  const grants = aclRows.filter((r) => r.grant.length).map((r) => `GRANT EXECUTE ON FUNCTION public.${r.sig} TO ${r.grant.join(', ')};`).join('\n')
  const replacedAclValues = CMS_130_REPLACED.map((x, i) => `(${sqlLit(x.sig)}, ${x.grant ? sqlLit(`${x.grant}:EXECUTE`) : 'NULL'}${i === 0 ? '::text' : ''})`).join(', ')

  const genPairs = [...CMS_130_NEW.map((x) => [x.sig, newDefs[x.name]]), ...replacedNow.map((x) => [x.sig, repDefs[x.name]])]
  const POST_MD5 = md5Block(genPairs,
    `130 hậu kiểm: thân ${CMS_130_NEW.length} hàm mới + ${replacedNow.length} hàm thay lệch bản sinh (md5)`)
  const RB_PRE_MD5 = md5Block(genPairs,
    'rollback 130 preflight: thân hàm 130 hiện tại KHÁC bản đã sinh (md5) — có sửa tay? dừng, đối chiếu')
  const RB_POST_MD5 = replacedNow.length
    ? md5Block(replacedNow.map((x) => [x.sig, base[x.name].text]), 'rollback 130 hậu kiểm: thân hàm khôi phục lệch nguyên văn (md5)')
    : '-- (lát này chưa thay thân hàm nào — không có thân cần khôi phục)'

  const counts = [
    ['@@N_NEW@@', CMS_130_NEW.length], ['@@N_REP@@', replacedNow.length], ['@@N_ACL@@', aclRows.length],
    ['@@N_CMS_BEFORE@@', CMS_130_FN_BEFORE], ['@@N_CMS_AFTER@@', CMS_130_FN_BEFORE + CMS_130_NEW.length],
  ]
  const head = fillAll(patch(tpl('a-head.sql'), '-- @@PREFLIGHT_MD5@@', PREFLIGHT_MD5, 'preflight md5'), [
    ['@@NEW_NAMES@@', CMS_130_NEW.map((x) => sqlLit(x.name)).join(', ')],
    ['@@REPLACED_ACL_VALUES@@', replacedAclValues],
  ])
  const tail = fillAll(patch(patch(tpl('z-tail.sql'), '-- @@POST_MD5@@', POST_MD5, 'post md5'), '-- @@VERIFY_BLOCK@@', verifyBlock(aclRows), 'verify'), [
    ['@@REVOKE_LIST@@', aclRows.map((r) => `  public.${r.sig}`).join(',\n')],
    ['@@GRANT_STMTS@@', grants],
    ['@@ACL_EXPECT_VALUES@@', aclValues],
    ['@@TABLE_ACL@@', tableAcl()],
  ])
  const migration = fillSome([head, ...bodies, repSection, tail].join(''), counts).replace(/\n+$/, '\n')

  const rbHead = patch(tpl('rb-head.sql'), '-- @@RB_PRE_MD5@@', RB_PRE_MD5, 'rollback pre md5')
  const rbTail = fillAll(patch(patch(tpl('rb-tail.sql'), '-- @@RB_POST_MD5@@', RB_POST_MD5, 'rollback post md5'),
    '-- @@RESTORE_FUNCTIONS@@', restoreSection || '-- (không có thân thay)', 'rollback restore'), [
    ['@@DROP_FUNCTIONS@@', CMS_130_NEW.map((x) => `DROP FUNCTION public.${x.sig};`).join('\n')],
    ['@@RB_ACL_VALUES@@', replacedNow.map((x, i) => `(${sqlLit(x.sig)}${i === 0 ? '::text' : ''}, ${x.grant === 'authenticated'}, ${x.grant === 'service_role'})`).join(', ')],
  ])
  const rollback = fillSome([rbHead, rbTail].join(''), counts)

  for (const [n, x] of [['migration', migration], ['rollback', rollback]]) {
    const left = x.match(/@@[A-Z0-9_]+@@/g)
    if (left) throw new Error(`${n}: còn placeholder ${[...new Set(left)].join(' ')}`)
    if (x.includes('\r')) throw new Error(`${n}: có CR`)
  }
  const md5s = {
    base: Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { file: v.file, md5: md5(cmsProsrc(v.text)) }])),
    new: Object.fromEntries(CMS_130_NEW.map((x) => [x.name, md5(cmsProsrc(newDefs[x.name]))])),
    replaced: Object.fromEntries(replacedNow.map((x) => [x.name, md5(cmsProsrc(repDefs[x.name]))])),
  }
  return { migration, rollback, base, newDefs, repDefs, replacedNow: replacedNow.map((x) => x.name), md5s,
    sha: { migration: sha256(migration), rollback: sha256(rollback) } }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const { migration, rollback, md5s, sha } = buildCms130()
  if (process.argv.includes('--check')) {
    const same = (f, s) => fs.existsSync(f) && fs.readFileSync(f, 'utf8') === s
    const ok = same(CMS_130_FILE, migration) && same(CMS_130_ROLLBACK_FILE, rollback)
    console.log(ok ? 'gen-cms-130: file trên đĩa KHỚP bản sinh' : 'gen-cms-130: LỆCH bản sinh — chạy lại node scripts/gen-cms-130.mjs')
    process.exitCode = ok ? 0 : 1
  } else {
    fs.writeFileSync(CMS_130_FILE, migration)
    fs.writeFileSync(CMS_130_ROLLBACK_FILE, rollback)
    console.log(`130_cms_calculation_modes_returns.sql ${migration.split('\n').length - 1} dòng sha256 ${sha.migration}`)
    console.log(`rollback/130_cms_calculation_modes_returns_rollback.sql ${rollback.split('\n').length - 1} dòng sha256 ${sha.rollback}`)
    console.log(`md5: ${JSON.stringify(md5s)}`)
  }
}
