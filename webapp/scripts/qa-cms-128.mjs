// QA migration 128 (CMS-UNIT capability — PM spec 09/11 §3 / §7: cơ sở tính theo chương trình + metadata tính của run) trên chuỗi
// migration THẬT 120 → 126 + marker 127 (MÔ PHỎNG: 127 chỉ sửa dữ liệu MỘT chương trình thật — bất biến v127-* kiểm ở
// scripts/qa-cms-127.mjs, ở đây loại khỏi danh sách đỏ có chủ đích) + app MỚI (engine / salesSync / resultStage CMS-UNIT).
// Hai backend: PGlite (mặc định, Postgres 16 WASM) và PostgreSQL 15 thật (embedded: `--pg15 <embedded-postgres-dir> <data-root>`).
//   §0 generator ↔ file (byte, LF) · md5 thân NỀN 15 hàm = kỳ vọng VERIFY 127 · md5 SAU = CMS_FN_SRC_128 / ma trận 128
//   §1 DB 127 + app mới: chương trình pos_base (thật + QA) công bố theo đường legacy (không dấu writer); RPC lưu chương trình bỏ qua khoá
//      quantity_basis (lý do action phải probe capability); cột chưa có (42703)
//   §2 preflight 128 dừng, 0 delta: thiếu 127 · số > 127 · run running · thân nền lạ · role không phải owner · không READ COMMITTED ·
//      cột có sẵn không marker
//   §3 áp 128: marker · 74 hàm · ma trận ACL has_function_privilege 21 hàm × anon / authenticated / service_role / PUBLIC · run cũ nhãn
//      legacy · vân tay cấu hình pos_base KHÔNG đổi · dữ liệu run KHÔNG đổi · reader giữ giá trị cũ · chạy lại bị chặn · VERIFY 128 đạt ·
//      VERIFY 127 trên DB 128 đỏ
//   §4 parity pos_base sau 128: run v1 + snapshot; kết quả = run trước 128 từng cặp; writer cũ (không dấu) vẫn seal / công bố; dấu sai ⇒ held
//   §5 khoá đơn vị / lượng: SQL ↔ TS ↔ oracle độc lập (243 cặp hoa / thường, khoảng trắng, điều khiển, NFD, fuzz)
//   §6 rollback khi CHƯA có cms_unit: thân lạ ⇒ dừng · rollback ⇒ thân nền, 68 hàm, cột / trigger gỡ, app chạy lại legacy · áp lại 128
//   §7 cms_unit đầu-cuối (thật + QA): nguồn → engine → stage → seal → publish; kết quả = oracle TS độc lập VÀ fixture SQL độc lập (C / Q /
//      tiền nhóm + C trước / sau từng dòng); reader theo snapshot RUN; chứng nhận / chốt bị chặn; replay cùng tiền; cờ OFF ⇒ held
//   §8 đột biến seal / metadata: công thức B / K cũ · cms_quantity giả · per_unit 1 · phân bổ dòng · lẻ / thiếu / sai lượng · dấu writer
//      thiếu / sai · metadata bất biến / INSERT thiếu · đổi cấu hình (đơn vị / K) open ↔ seal ↔ publish · khoá dành riêng · lượng âm dòng
//      không INCLUDED (thật) · guard đổi cơ sở (form / datafix / nháp)
//   §9 rollback bị chặn khi đã có cms_unit (0 delta) · VERIFY 128 chứng minh đủ (unit) · đột biến VERIFY (grant / thân / trigger / pointer / nhãn)
//   §10 dán CRLF (Studio): 128 + rollback CRLF ≡ LF
//   §11 (chỉ --pg15) race lock_timeout · bench seal cms_unit ở TRẦN nguồn 200.000 dòng, statement_timeout 8 s GIỮ NGUYÊN (không nới)
// KHÔNG chạm DB thật / nguồn thật / mạng (PG15 chỉ 127.0.0.1).
//   npm i --no-save @electric-sql/pglite@0.2.17 ; node scripts/qa-cms-128.mjs
//   node scripts/qa-cms-128.mjs --pg15 <embedded-postgres-dir> <data-root> [--bench-rows=200000] [--bench-only]
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import * as L from './lib-care-pglite.mjs'
import { buildCms128, CMS_128_FILE, CMS_128_ROLLBACK_FILE, CMS_128_REPLACED, CMS_128_NEW, CMS_128_CODES } from './gen-cms-128.mjs'
import { createCmsEnv } from './lib-cms-128-env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const SQL = (f) => fs.readFileSync(path.join(MIG, f), 'utf8')
const SQL_128 = fs.readFileSync(CMS_128_FILE, 'utf8')
const RB_128 = fs.readFileSync(CMS_128_ROLLBACK_FILE, 'utf8')
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@': path.join(HERE, '..') } })
const lib = (p) => jiti.import(path.join(HERE, '..', p))
const T = await lib('e2e/cmsQaTooling.ts')
const C = await lib('lib/cms/source/contract.ts')
const SS = await lib('lib/cms/salesSync.ts')
const RS = await lib('lib/cms/resultStage.ts')
const EN = await lib('lib/cms/engine/compute.ts')
const UK = await lib('lib/cms/unitKey.ts')
const UB = await lib('lib/cms/unitBasis.ts')
const OR = await lib('e2e/cmsUnitOracle.ts')
const FX = await lib('e2e/cmsFixtureRunner.ts')
const QR = await lib('e2e/cmsQaResults.ts')
const { U, storeId, STORES, sha } = L

const argv = process.argv.slice(2)
const PG15 = argv[0] === '--pg15'
const BENCH_ROWS = Number((argv.find((a) => a.startsWith('--bench-rows=')) ?? '--bench-rows=200000').split('=')[1])
const BENCH_ONLY = argv.includes('--bench-only')
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) } }
const section = (s) => console.log(`\n${s}`)
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, err: String(e?.message ?? e), code: e?.code }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const execFail = async (db, sql) => { const r = await settle(db.exec(sql)); if (!r.ok) await db.exec('ROLLBACK').catch(() => {}); return r }
const lastRows = (results) => { for (let i = results.length - 1; i >= 0; i--) if (results[i].rows?.length) return results[i].rows; return [] }
const CRLF = (s) => s.split('\n').join('\r\n')
const orReplace = (t) => (t.startsWith('CREATE OR REPLACE FUNCTION public.') ? t : t.split('CREATE FUNCTION public.').join('CREATE OR REPLACE FUNCTION public.'))
const jeq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const NEW_KEYS = new Set(['quantity_basis', 'calculation_policy_version', 'units', 'unit_match', 'counted_quantity', 'attestation_supported'])
/** Bỏ khoá 128 thêm (mọi tầng) ⇒ so giá trị cũ của reader trước / sau 128. */
const stripNew = (o) => (Array.isArray(o) ? o.map(stripNew) : o && typeof o === 'object'
  ? Object.fromEntries(Object.entries(o).filter(([k]) => !NEW_KEYS.has(k)).map(([k, v]) => [k, stripNew(v)])) : o)

const T3 = [{ order: 1, from: 1, to: 9, amount: '15000' }, { order: 2, from: 10, to: 19, amount: '20000' }, { order: 3, from: 20, to: null, amount: '25000' }]
const T_FLAT = [{ order: 1, from: 1, to: null, amount: '20000' }]

// ── §0 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
section('0. Generator ↔ file · md5 nền / sau = VERIFY')
const GEN = buildCms128()
ok(GEN.migration === SQL_128 && GEN.rollback === RB_128, 'scripts/gen-cms-128.mjs sinh ĐÚNG byte 128 + rollback trên đĩa')
ok(!SQL_128.includes('\r') && !RB_128.includes('\r'), '128 + rollback giữ LF (md5 thân bỏ \\r như VERIFY)')
const want127 = (n) => T.CMS_FN_SRC_126[n] ?? T.CMS_FN_SRC_125[n] ?? T.CMS_FN_SRC_124[n] ?? T.CMS_FN_SRC_123[n] ?? T.CMS_FN_MATRIX[n]?.src
{
  const bad = CMS_128_REPLACED.filter((r) => GEN.md5s.base[r.name] !== want127(r.name)).map((r) => r.name)
  ok(bad.length === 0, 'md5 thân NỀN 15 hàm (bản cuối 121–126) = kỳ vọng VERIFY 127 (preflight đúng bản prod)', bad.join(', '))
  const bad2 = [...CMS_128_REPLACED.filter((r) => GEN.md5s.after[r.name] !== T.CMS_FN_SRC_128[r.name]).map((r) => r.name),
    ...CMS_128_NEW.filter((x) => GEN.md5s.after[x.name] !== T.CMS_FN_MATRIX[x.name]?.src || T.CMS_FN_MATRIX[x.name]?.phase !== '128').map((x) => x.name)]
  ok(bad2.length === 0, 'md5 thân SAU 21 hàm = CMS_FN_SRC_128 (15 thay) + CMS_FN_MATRIX phase 128 (6 mới)', bad2.join(', '))
  ok(jeq(Object.keys(T.CMS_FN_SRC_128).sort(), CMS_128_REPLACED.map((r) => r.name).sort()), 'tập thay của VERIFY = tập thay của generator')
}
ok(UK.CMS_UNIT_KEY_VERSION === T.CMS_128_UNIT_KEY_VERSION && SQL_128.includes(`'${UK.CMS_UNIT_KEY_VERSION}'`), `phiên bản khoá đơn vị ${UK.CMS_UNIT_KEY_VERSION} chung app / SQL / VERIFY`)
ok(UB.CMS_BASIS_POLICY.pos_base === 'pos_base_v1' && UB.CMS_BASIS_POLICY.cms_unit === 'cms_unit_v1' && SQL_128.includes("WHEN 'pos_base' THEN 'pos_base_v1' WHEN 'cms_unit' THEN 'cms_unit_v1'"),
  'chính sách theo cơ sở: app = cms__basis_policy')

// ── backend + môi trường (DB 127 → 128 + app mới): scripts/lib-cms-128-env.mjs — dùng chung với harness datafix T11 (UNIT-4) ──────────
const ENV = createCmsEnv({ libs: { T, C, SS, RS, EN, QR, FX }, pg15: PG15 ? { modDir: argv[1], dataRoot: argv[2] } : null })
const { env, SELLER_IDS, ORACLE_SELLERS } = ENV

/** Đối chiếu kết quả run với oracle TS độc lập (e2e/cmsUnitOracle.ts — không import lib/cms). */
function oracleCompare(p, rws, res, runAmt) {
  const o = OR.cmsUnitOracle({ start: p.start, end: p.end, storeIds: p.storeIds, catalogTarget: p.catalogTarget,
    products: p.products.map((x) => ({ productId: x.pid, unitCms: x.unit ?? 'hộp', gmvBasis: x.basis ?? 'none', target: x.target ?? null,
      tiers: x.tiers.map((t) => ({ from: t.from, to: t.to, amount: t.amount })) })) }, rws, ORACLE_SELLERS)
  const diffs = []
  if (o.hold) diffs.push(`oracle HOLD ${JSON.stringify(o.hold)}`)
  if (o.pairs.size !== res.length) diffs.push(`số cặp oracle ${o.pairs.size} ≠ DB ${res.length}`)
  for (const r of res) {
    const x = o.pairs.get(`${r.u}|${r.pid}`)
    if (!x) { diffs.push(`thiếu oracle ${r.pid}`); continue }
    if (x.q !== BigInt(r.q) || x.potential !== BigInt(r.pot) || x.amount !== BigInt(r.amt) || x.gateMet !== r.g || x.b !== BigInt(r.b9) || x.gmv !== BigInt(r.gmv9)) {
      diffs.push(`${r.pid}/${r.u.slice(-4)}: DB q ${r.q} pot ${r.pot} amt ${r.amt} g ${r.g} · oracle q ${x.q} pot ${x.potential} amt ${x.amount} g ${x.gateMet}`)
    }
  }
  if (runAmt !== undefined && String(o.total) !== String(runAmt)) diffs.push(`tổng oracle ${o.total} ≠ run ${runAmt}`)
  return { diffs, oracle: o }
}

/** Fixture SQL ĐỘC LẬP: C = Σ quantity_raw::numeric của dòng KHAI BÁO đúng ĐV + được tính, Q = max(C, 0), F(Q) từ bảng bậc (SQL thuần), C
 *  trước / sau từng dòng theo seq — không gọi helper / seal / engine; cờ đúng ĐV + người nhận do người viết fixture khai báo. */
async function sqlFixture(E, runId, programId, lineIds) {
  const rowsFx = lineIds.map((id) => E.fx.get(id)).filter(Boolean)
  await E.db.exec(`DROP TABLE IF EXISTS pg_temp.qa128_fx; CREATE TEMP TABLE qa128_fx (order_line_id text PRIMARY KEY, user_id uuid, pid text, qty numeric, m boolean, inc boolean)`)
  await E.db.query(`INSERT INTO qa128_fx SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(order_line_id text, user_id uuid, pid text, qty numeric, m boolean, inc boolean)`, [JSON.stringify(rowsFx)])
  const g = await E.one(`WITH c AS (SELECT user_id, pid, GREATEST(COALESCE(sum(qty) FILTER (WHERE m), 0), 0) AS q FROM qa128_fx WHERE inc GROUP BY 1, 2),
    tr AS (SELECT pp.product_id AS pid, t.qty_from, t.qty_to, t.amount_per_unit AS a FROM public.cms_program_tiers t
             JOIN public.cms_program_products pp ON pp.id = t.program_product_id WHERE pp.program_id = $2),
    f AS (SELECT c.user_id, c.pid, c.q, COALESCE(sum(GREATEST(0, LEAST(c.q, COALESCE(tr.qty_to::numeric, c.q)) - tr.qty_from + 1) * tr.a), 0) AS pot
            FROM c LEFT JOIN tr ON tr.pid = c.pid GROUP BY 1, 2, 3),
    r AS (SELECT user_id, product_id AS pid, cms_quantity::numeric AS q, potential_amount AS pot, amount_vnd AS amt, gate_met FROM public.cms_results WHERE run_id = $1)
    SELECT count(*)::int n, count(*) FILTER (WHERE f.user_id IS NULL OR r.user_id IS NULL OR f.q <> r.q OR f.pot <> r.pot
             OR r.amt <> CASE WHEN r.gate_met THEN f.pot ELSE 0 END)::int bad, count(*) FILTER (WHERE f.q > 0)::int pos,
           count(*) FILTER (WHERE r.gate_met AND r.amt > 0)::int paid
      FROM f FULL JOIN r ON r.user_id = f.user_id AND r.pid = f.pid`, [runId, programId])
  const l = await E.one(`WITH s AS (SELECT sl.order_line_id, sl.seq, x.user_id, x.pid, CASE WHEN x.m THEN x.qty ELSE 0 END AS c
               FROM qa128_fx x JOIN public.cms_sales_lines sl ON sl.run_id = $1 AND sl.order_line_id = x.order_line_id WHERE x.inc),
    w AS (SELECT s.*, COALESCE(sum(c) OVER (PARTITION BY user_id, pid ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cb FROM s)
    SELECT count(*)::int n, count(*) FILTER (WHERE rl.order_line_id IS NULL OR rl.qty_before::numeric <> GREATEST(w.cb, 0)
             OR rl.qty_after::numeric <> GREATEST(w.cb + w.c, 0))::int bad,
           (SELECT count(*)::int FROM public.cms_result_lines WHERE run_id = $1) AS rl_n
      FROM w LEFT JOIN public.cms_result_lines rl ON rl.run_id = $1 AND rl.order_line_id = w.order_line_id`, [runId])
  return { g, l }
}

async function main() {
  const E = await env('main')
  console.log(`QA migration 128 — ${E.label}`)
  if (PG15) ok(E.label.startsWith('PostgreSQL 15.'), 'PostgreSQL 15')
  const { db, one } = E

  // ── §1 ──
  section('1. DB 127 + app mới: pos_base đi đường legacy (không dấu writer)')
  const a1 = E.pid(), a2 = E.pid(), a3 = E.pid()
  const R = await E.makeProgram({ name: 'THẬT CMS 128 pos_base', isTest: false, products: [{ pid: a1, tiers: T3 }, { pid: a2, k: '24', tiers: T3 }, { pid: a3, k: '10', tiers: T_FLAT }] })
  const POS = E.rows(R, [{ pid: a1, s: 0, base: 9 }, { pid: a1, s: 1, base: 4, n: 2, uom: 'Vỉ' }, { pid: a1, s: 1, base: 2 }, { pid: a1, s: 2, base: 19, qty: '19' },
    { pid: a2, s: 0, base: 50, uom: 'Viên' }, { pid: a2, s: 1, base: 23 }, { pid: a3, s: 0, base: 37, qty: '3.7', uom: 'hộp lẻ' }, { pid: a3, s: 3, base: 100, qty: '10' },
    { pid: a1, email: 'chua.gan@example.invalid', base: 3 }, { pid: a1, out: true, base: 5 }])
  const q1 = E.pid()
  const Q = await E.makeProgram({ name: 'QA CMS 128 pos_base', isTest: true, products: [{ pid: q1, k: '6', tiers: T3 }] })
  const QPOS = E.rows(Q, [{ pid: q1, s: 0, base: 18 }, { pid: q1, s: 0, base: -6, gmv: -10000 }, { pid: q1, s: 2, base: 7, uom: null }])
  const r0 = await E.sync(R, POS)
  const rq0 = await E.sync(Q, QPOS, { source: 'qa' })
  ok(r0.status === 'published' && r0.quantityBasis === 'pos_base' && r0.calculationPolicyVersion === 'pos_base_legacy', 'DB 127: chương trình thật pos_base công bố, app nhận legacy', JSON.stringify([r0.status, r0.code, r0.quantityBasis, r0.calculationPolicyVersion]))
  ok(rq0.status === 'published', 'DB 127: chương trình QA pos_base (điều chỉnh âm, đơn vị thiếu) công bố như cũ', JSON.stringify([rq0.status, rq0.code]))
  const se0 = (await E.runRow(r0.runId)).seal_expect
  ok(se0 && !('quantity_basis' in se0) && !('calculation_policy_version' in se0), 'writer trên DB 127: seal_expect KHÔNG mang dấu cơ sở (snapshot legacy)')
  const res0 = await E.results(r0.runId), resQ0 = await E.results(rq0.runId)
  const fpBefore = { r: await E.runFp(r0.runId), q: await E.runFp(rq0.runId) }
  const hdr0 = await E.header(R.id), rows0 = await E.rowsR(R.id), lines0 = await E.linesR(R.id, r0.runId)
  ok(hdr0?.current_run?.id === r0.runId || JSON.stringify(hdr0).includes(r0.runId), 'reader header trước 128 trả run hiện hành')
  const probe = await settle(db.query(`SELECT quantity_basis FROM public.cms_programs LIMIT 0`))
  ok(!probe.ok && /quantity_basis/.test(probe.err), 'probe capability trên DB 127: cột quantity_basis chưa có (lỗi cột — action từ chối tạo cms_unit)', probe.err)
  const ign = await E.saveProgram({ name: 'QA 127 khoá lạ', start_date: await E.day(5), end_date: await E.day(9), scope: 'stores', store_ids: [storeId(1)], is_test: true, quantity_basis: 'cms_unit' })
  ok(!!ign && (await E.prog127(ign)).status === 'draft', 'RPC lưu 121 trên DB 127 BỎ QUA khoá quantity_basis (âm thầm thành luật cũ) ⇒ app phải probe trước khi gửi')

  // ── §2 ──
  section('2. Preflight 128 dừng — 0 delta')
  const zero = async (what) => {
    ok(!(await one(`SELECT 1 x FROM public.app_migrations WHERE version = '128'`)) && !(await E.hasCol()) && (await E.fnCount()) === 68,
      `${what}: 0 delta (không marker / cột / hàm mới)`)
  }
  const failsWith = async (sql, re, what) => { const r = await execFail(db, sql); ok(!r.ok && re.test(r.err), what, r.ok ? 'KHÔNG dừng' : r.err.slice(0, 200)); await zero(what) }
  await db.query(`UPDATE public.app_migrations SET name = 'x' WHERE version = '127'`)
  await failsWith(SQL_128, /thiếu migration nền 127/, 'marker 127 sai tên ⇒ dừng')
  await db.query(`UPDATE public.app_migrations SET name = 'cms_t11_flat_amounts' WHERE version = '127'`)
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('129', 'x')`)
  await failsWith(SQL_128, /số > 127/, 'có migration số > 127 ⇒ dừng')
  await db.query(`DELETE FROM public.app_migrations WHERE version = '129'`)
  const openQ = await E.rpc(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [Q.id, JSON.stringify({ source: 'operator' })])
  await failsWith(SQL_128, /còn run bán running/, "run bán 'running' ⇒ dừng")
  await E.rpc(`SELECT public.rpc_cms_sales_run_finish($1, $2, $3::jsonb) r`, [openQ.run_id, 'error', JSON.stringify({ error_code: 'QA_ABORT' })]).catch(async () => {
    await db.query(`UPDATE public.cms_sync_runs SET status = 'error', error_code = 'QA_ABORT', finished_at = now() WHERE id = $1`, [openQ.run_id])
  })
  ok((await one(`SELECT status FROM public.cms_sync_runs WHERE id = $1`, [openQ.run_id])).status !== 'running', 'đóng run thử')
  const rFix = CMS_128_REPLACED.find((x) => x.name === 'rpc_cms_result_rows')
  await db.exec(orReplace(GEN.base[rFix.name]).split("'CMS_RESULT_TOO_LARGE'").join("'CMS_RESULT_TOO_LARGE' /* sửa tay */"))
  await failsWith(SQL_128, /128 preflight: thân một trong 15 hàm/, 'thân nền lạ (md5) ⇒ dừng')
  await db.exec(orReplace(GEN.base[rFix.name]))
  await db.exec(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qa128_su') THEN CREATE ROLE qa128_su SUPERUSER; END IF; END $$`)
  {
    const r = await settle(db.exec(`SET ROLE qa128_su; ${SQL_128}`))
    if (!r.ok) await db.exec('ROLLBACK').catch(() => {})
    await db.exec('RESET ROLE')
    ok(!r.ok && /owner bảng \/ hàm CMS khác role chạy/.test(r.err), 'role superuser KHÔNG phải owner ⇒ dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160))
    await zero('role không phải owner')
  }
  await db.exec(`SET default_transaction_isolation = 'serializable'`)
  { const r = await execFail(db, SQL_128); await db.exec(`RESET default_transaction_isolation`); ok(!r.ok && /READ COMMITTED/.test(r.err), 'không READ COMMITTED ⇒ dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160)); await zero('isolation') }
  await db.exec(`ALTER TABLE public.cms_programs ADD COLUMN quantity_basis text`)
  { const r = await execFail(db, SQL_128); ok(!r.ok && /đã có cột \/ helper cơ sở tính mà không có marker 128/.test(r.err), 'cột có sẵn không marker ⇒ dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160)) }
  await db.exec(`ALTER TABLE public.cms_programs DROP COLUMN quantity_basis`)
  await zero('cột có sẵn (đã gỡ)')

  // ── §3 ──
  section('3. Áp 128')
  const cfpBefore = await E.configFps()
  const t128 = Date.now()
  await db.exec(SQL_128); await sleep(20)
  console.log(`    áp 128: ${Date.now() - t128} ms`)
  const mk = await one(`SELECT name FROM public.app_migrations WHERE version = '128'`)
  ok(mk?.name === 'cms_unit_quantity_basis' && (await E.fnCount()) === 74, 'marker 128 + tổng hàm CMS 74 (68 + 6)')
  const names21 = [...CMS_128_NEW.map((x) => x.name), ...CMS_128_REPLACED.map((x) => x.name)]
  const acl = await E.all(`SELECT p.proname n, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
      has_function_privilege('service_role', p.oid, 'EXECUTE') s, p.proacl IS NULL dflt, p.prosecdef sd, p.proconfig cfg,
      (SELECT count(*) FROM aclexplode(p.proacl) x WHERE x.grantee = 0)::int pub, md5(replace(p.prosrc, E'\\r', '')) m
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1)`, [names21])
  const grantOf = Object.fromEntries([...CMS_128_NEW.map((x) => [x.name, null]), ...CMS_128_REPLACED.map((x) => [x.name, x.grant])])
  const aclBad = acl.filter((r) => r.a || r.dflt || r.pub > 0 || !r.sd || !(r.cfg ?? []).includes('search_path=public')
    || r.u !== (grantOf[r.n] === 'authenticated') || r.s !== (grantOf[r.n] === 'service_role') || r.m !== GEN.md5s.after[r.n])
  ok(acl.length === 21 && aclBad.length === 0, 'ma trận ACL 21 hàm: anon ∅ · PUBLIC ∅ · 6 mới chỉ owner · 6 RPC ghi chỉ service_role · 5 RPC đọc / chứng nhận chỉ authenticated · 4 helper chỉ owner · SECDEF + search_path · md5 = bản sinh',
    aclBad.map((r) => `${r.n} a${r.a} u${r.u} s${r.s} pub${r.pub}`).join(' | '))
  const lbl = await E.all(`SELECT kind, quantity_basis qb, calculation_policy_version pv, calculation_snapshot IS NULL nsnap, count(*)::int n FROM public.cms_sync_runs GROUP BY 1, 2, 3, 4 ORDER BY 1, 2`)
  ok(lbl.every((r) => (r.kind === 'sales' ? r.qb === 'pos_base' && r.pv === 'pos_base_legacy' : r.qb === null && r.pv === null) && r.nsnap),
    'run bán cũ: pos_base + pos_base_legacy + snapshot NULL (không bịa); run products: metadata NULL', JSON.stringify(lbl))
  ok((await E.all(`SELECT DISTINCT quantity_basis FROM public.cms_programs`)).map((r) => r.quantity_basis).join() === 'pos_base', 'mọi chương trình hiện có = pos_base')
  ok((await E.configFps()) === cfpBefore, 'vân tay cấu hình (cms__config_fp) của MỌI chương trình pos_base KHÔNG đổi (payout / VERIFY cũ giữ)')
  ok((await E.runFp(r0.runId)) === fpBefore.r && (await E.runFp(rq0.runId)) === fpBefore.q, 'dữ liệu run đã công bố KHÔNG đổi (4 bảng kết quả + lớp nguồn + dòng run trừ cột 128)')
  const hdr1 = await E.header(R.id), rows1 = await E.rowsR(R.id), lines1 = await E.linesR(R.id, r0.runId)
  ok(jeq(stripNew(hdr1), stripNew(hdr0)) && jeq(stripNew(rows1), stripNew(rows0)) && jeq(stripNew(lines1), stripNew(lines0)),
    'reader header / rows / lines: mọi giá trị cũ giữ nguyên (chỉ thêm khoá 128)')
  ok(hdr1.quantity_basis === 'pos_base' && rows1.quantity_basis === 'pos_base' && rows1.calculation_policy_version === 'pos_base_legacy' && rows1.units === null
    && lines1.calculation_policy_version === 'pos_base_legacy' && lines1.rows.every((x) => x.unit_match === null && x.counted_quantity === null),
  'reader run legacy: cơ sở pos_base / pos_base_legacy, units NULL, không unit_match / counted_quantity', JSON.stringify([hdr1.quantity_basis, rows1.calculation_policy_version, rows1.units]))
  { const again = await execFail(db, SQL_128); ok(!again.ok && /đã có marker 128/.test(again.err), 'chạy lại 128 ⇒ preflight dừng', again.err) }
  const v128 = await E.verify('128', E.pre128)
  ok(E.bad(v128).length === 0, `VERIFY phase 128 ĐẠT (${v128.length} mục; v127-* mô phỏng loại có chủ đích)`, E.show(v128))
  ok(v128.find((c) => c.id === 'v128-run-basis')?.proven === false, 'v128-run-basis CHƯA chứng minh (chưa có run bán sau 128)')
  ok(E.bad(await E.verify('127', E.pre127)).some((c) => c.id === 'phase-match'), 'VERIFY 127 trên DB 128 ⇒ ĐỎ phase-match')
  ok(v128.filter((c) => c.id.startsWith('v127-')).length === 3, 'phase 128 vẫn đánh giá bất biến 127 (3 mục v127-*)')

  // ── §4 ──
  section('4. Parity pos_base sau 128')
  const r1 = await E.sync(R, POS)
  const m1 = await E.runMeta(r1.runId)
  ok(r1.status === 'published' && m1.qb === 'pos_base' && m1.pv === 'pos_base_v1' && m1.cs?.schema === 'cms-calc-snapshot-v1' && Number(m1.cs.config_version) === Number(m1.cv)
    && m1.cs.unit_key_version === UK.CMS_UNIT_KEY_VERSION && m1.cs.products.length === 3 && m1.cs.products.every((x) => typeof x.unit_cms === 'string'),
  'run mới pos_base: pos_base_v1 + snapshot cms-calc-snapshot-v1 (version, khoá đơn vị, 3 SP + unit_cms)', JSON.stringify([r1.status, r1.code, m1.pv]))
  ok(jeq(await E.results(r1.runId), res0), 'AC06 parity: kết quả pos_base SAU 128 = TRƯỚC 128 từng cặp (Q / tiềm năng / tiền / gate / B / GMV / K)')
  const se1 = (await E.runRow(r1.runId)).seal_expect
  ok(se1.quantity_basis === 'pos_base' && se1.calculation_policy_version === 'pos_base_v1', 'writer mới: dấu pos_base / pos_base_v1 trong seal_expect')
  const strip = (e) => { delete e.quantity_basis; delete e.calculation_policy_version; return e }
  const sOld = await E.stageDirect(R, POS, { expect: strip })
  const pOld = sOld.sealed ? await E.publishRpc(sOld.runId) : null
  ok(sOld.sealed && pOld?.published === true && jeq(await E.results(sOld.runId), res0), 'writer CŨ (prod trước deploy, không dấu) + pos_base ⇒ seal / công bố như cũ, cùng kết quả', JSON.stringify([sOld.code, pOld]))
  const sWrong = await E.stageDirect(R, POS, { expect: (e) => ({ ...e, quantity_basis: 'cms_unit', calculation_policy_version: 'cms_unit_v1' }) })
  ok(!sWrong.sealed && sWrong.status === 'held' && sWrong.code === 'BASIS_WRITER_MISMATCH', 'dấu writer khai cms_unit cho run pos_base ⇒ held BASIS_WRITER_MISMATCH', JSON.stringify([sWrong.status, sWrong.code]))
  const rq1 = await E.sync(Q, QPOS, { source: 'qa' })
  ok(rq1.status === 'published' && jeq(await E.results(rq1.runId), resQ0), 'QA pos_base (điều chỉnh âm, đơn vị NULL) sau 128 = trước 128')

  // ── §5 ──
  section('5. Khoá đơn vị / lượng: SQL ↔ TS ↔ oracle độc lập')
  {
    const up = [...UK.CMS_UNIT_CASE_UPPER], lo = [...UK.CMS_UNIT_CASE_LOWER], ws = [...UK.CMS_UNIT_WS]
    const corpus = ['Hộp', ' HỘP ', 'hộp', 'Hộp', 'VỈ', 'Viên', 'Ống', 'chai', '', ' ', ' hộp　', '﻿Hộp', 'hộp\u0007', '\u0085hộp', 'h\u007fp',
      'Σ', 'İ', 'ß', 'ẞ', 'ǅ', 'Ω', 'K', 'Å', 'ﬃ', 'Hộp 10 vỉ', 'HỘP\tLỚN', 'ĐƠN VỊ', 'ƠƯ', 'ỸỶỴ', 'Ǆ', 'ı', 'ſ', 'Ⅻ', 'Ａ', 'Ꞵ', 'Ǳ', 'Ϊ́']
    for (const c of up) corpus.push(c, ` ${c}x `)
    for (const c of lo) corpus.push(c.toUpperCase(), c)
    for (const w of ws) corpus.push(`${w}Hộp${w}`, `Hộp${w}Hộp`)
    let seed = 128
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const alpha = [...up, ...lo, ...ws, 'a', 'Z', '0', '9', ' ', '́', '̣', 'Σ', 'İ', 'ß', '\u0007', '\u0085', 'Đ', 'đ', 'ǅ', 'ﬃ']
    for (let i = 0; i < 1500; i++) { let s = ''; const n = 1 + Math.floor(rnd() * 8); for (let j = 0; j < n; j++) s += alpha[Math.floor(rnd() * alpha.length)]; corpus.push(s) }
    const sqlKeys = (await E.all(`SELECT x.i::int i, public.cms__unit_key(x.s) k FROM jsonb_array_elements_text($1::jsonb) WITH ORDINALITY x(s, i)`, [JSON.stringify(corpus)]))
    const byI = new Map(sqlKeys.map((r) => [r.i - 1, r.k]))
    const diff = [], diffO = []
    corpus.forEach((s, i) => {
      const t = UK.cmsUnitKey(s), q = byI.get(i) ?? null, o = OR.oracleUnitKey(s)
      if (t !== q) diff.push(`${JSON.stringify(s)} TS ${JSON.stringify(t)} SQL ${JSON.stringify(q)}`)
      if (t !== o) diffO.push(`${JSON.stringify(s)} TS ${JSON.stringify(t)} oracle ${JSON.stringify(o)}`)
    })
    ok(diff.length === 0, `khoá đơn vị SQL cms__unit_key ≡ TS cmsUnitKey trên ${corpus.length} chuỗi (243 cặp, 20 khoảng trắng, điều khiển, NFD, fuzz)`, diff.slice(0, 4).join(' | '))
    ok(diffO.length === 0, `TS cmsUnitKey ≡ oracle độc lập (Unicode) trên ${corpus.length} chuỗi`, diffO.slice(0, 4).join(' | '))
    const qc = ['0', '1', '-1', '2.000', '2.5', '0.000000001', '1.0000000001', '00012', '-0', '-0.000', '1e3', ' 1', '1 ', '+1', '.5', '5.', '1,5', '٣',
      '9223372036854775807', '9223372036854775808', '-9223372036854775808', '1'.repeat(29), '1'.repeat(30), '0'.repeat(40) + '7', 'abc', '', '1.123456789', '1.1234567890']
    const sqlQ = await E.all(`SELECT x.i::int i, CASE WHEN public.cms__qty_dec(x.s) IS NULL THEN NULL ELSE (public.cms__qty_dec(x.s) * 1000000000)::numeric(80,0)::text END u
      FROM jsonb_array_elements_text($1::jsonb) WITH ORDINALITY x(s, i)`, [JSON.stringify(qc)])
    const qd = []
    qc.forEach((s, i) => {
      const t = UK.cmsUnitQuantity(s), q = sqlQ.find((r) => r.i - 1 === i)?.u ?? null, o = OR.oracleDec9(s)
      const tv = t.ok ? t.units.toString() : null
      if (tv !== q || (o === null ? null : o.toString()) !== tv) qd.push(`${JSON.stringify(s)} TS ${tv} SQL ${q} oracle ${o}`)
    })
    ok(qd.length === 0, `lượng: SQL cms__qty_dec ≡ TS cmsUnitQuantity ≡ oracle trên ${qc.length} chuỗi biên (scale 9, 29 chữ số, dấu, mũ, khoảng trắng)`, qd.slice(0, 4).join(' | '))
  }

  // ── §6 ──
  section('6. Rollback khi CHƯA có cms_unit · áp lại')
  const rbFn = CMS_128_REPLACED.find((x) => x.name === 'rpc_cms_sales_run_finish')
  await db.exec(GEN.replaced[rbFn.name].split("THEN  -- 128: metadata").join("THEN  -- 128 (sửa tay): metadata"))
  { const r = await execFail(db, RB_128); ok(!r.ok && /rollback 128 preflight/.test(r.err), 'rollback dừng khi thân hiện tại khác bản 128 đã sinh', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160)) }
  await db.exec(GEN.replaced[rbFn.name])
  const ptrRb = (await E.prog(R.id)).ptr
  await db.exec(RB_128); await sleep(20)
  const md5Rb = await E.fnMd5(CMS_128_REPLACED.map((x) => x.name))
  ok(CMS_128_REPLACED.every((x) => md5Rb[x.name] === GEN.md5s.base[x.name]) && (await E.fnCount()) === 68 && !(await E.hasCol())
    && !(await one(`SELECT 1 x FROM public.app_migrations WHERE version = '128'`))
    && Number((await one(`SELECT count(*)::int n FROM pg_trigger WHERE tgname IN ('cms_programs_basis_guard', 'cms_sync_runs_basis_guard')`)).n) === 0,
  'rollback: 15 thân NỀN nguyên văn, 68 hàm, cột / trigger / marker gỡ')
  ok((await E.prog127(R.id)).ptr === ptrRb && (await E.runRow(ptrRb)).status === 'ok', 'rollback GIỮ run đã công bố (pointer không đổi)')
  const v127rb = await E.verify('127', E.pre127)
  ok(E.bad(v127rb).length === 0, 'VERIFY 127 sau rollback ĐẠT (128 không để phần dư)', E.show(v127rb))
  const rRb = await E.sync(R, POS)
  ok(rRb.status === 'published' && rRb.calculationPolicyVersion === 'pos_base_legacy' && jeq(await E.results(rRb.runId), res0), 'sau rollback app mới chạy lại đường legacy, cùng kết quả')
  await db.exec(SQL_128); await sleep(20)
  const vRe = await E.verify('128', E.pre128)
  ok(E.bad(vRe).length === 0 && (await E.runMeta(rRb.runId)).pv === 'pos_base_legacy', 'áp lại 128 ⇒ VERIFY 128 đạt; run giữa rollback dán nhãn legacy', E.show(vRe))

  // ── §7 ──
  section('7. cms_unit đầu-cuối (thật + QA)')
  const u1 = E.pid(), u2 = E.pid(), u3 = E.pid()
  const UPROD = [{ pid: u1, unit: 'hộp', k: '10', tiers: T3 }, { pid: u2, unit: 'Vỉ', k: '24', basis: 'product', target: '100000', tiers: T3 },
    { pid: u3, unit: 'chai', k: '1', basis: 'catalog', tiers: T3 }]
  const UR = await E.makeProgram({ name: 'THẬT CMS 128 cms_unit', isTest: false, products: UPROD, basis: 'cms_unit', catalogTarget: '150000' })
  ok((await E.prog(UR.id)).qb === 'cms_unit', 'tạo chương trình cms_unit qua rpc_cms_program_save (khoá quantity_basis)')
  // m = KHAI BÁO TAY "đúng ĐV CMS" (fixture SQL độc lập); không suy từ khoá đơn vị.
  const USPEC = [
    { pid: u1, s: 0, uom: 'Hộp', qty: '3', base: 30, gmv: 30000, m: true }, { pid: u1, s: 0, uom: ' HỘP ', qty: '2', base: 20, gmv: 20000, m: true },
    { pid: u1, s: 0, uom: 'Vỉ', qty: '5', base: 5, gmv: 5000, m: false }, { pid: u1, s: 0, uom: 'Hộp', qty: '4.000', base: 40, gmv: 40000, m: true },
    { pid: u1, s: 1, uom: 'Viên', qty: '100', base: 10, gmv: 9000, m: false }, { pid: u1, s: 1, uom: 'hộp', qty: '19', base: 190, gmv: 90000, m: true },
    { pid: u1, s: 2, uom: 'HỘP', qty: '20', base: 1, gmv: 10000, m: true },
    { pid: u2, s: 0, uom: 'vỉ', qty: '12', base: 12, gmv: 60000, m: true }, { pid: u2, s: 0, uom: 'Hộp', qty: '1', base: 24, gmv: 50000, m: false },
    { pid: u2, s: 2, uom: 'VỈ', qty: '25', base: 25, gmv: 50000, m: true },
    { pid: u3, s: 3, uom: 'Chai', qty: '7', base: 7, gmv: 160000, m: true }, { pid: u3, s: 2, uom: 'chai', qty: '9', base: 9, gmv: 10000, m: true },
    { pid: u3, s: 1, uom: 'Lọ', qty: '30', base: 30, gmv: 200000, m: false },
    { pid: u1, email: 'chua.gan.unit@example.invalid', uom: 'Hộp', qty: '50', base: 500, m: true }, { pid: u1, out: true, uom: 'Hộp', qty: '6', base: 60, m: true },
    { pid: u1, s: 0, uom: 'Hộp', qty: '9', base: 90, type: 'ONLINE', m: true },
  ]
  const UROWS = E.rows(UR, USPEC)
  const ru = await E.sync(UR, UROWS)
  const mu = ru.runId ? await E.runMeta(ru.runId) : null
  ok(ru.status === 'published' && ru.quantityBasis === 'cms_unit' && ru.calculationPolicyVersion === 'cms_unit_v1' && mu?.qb === 'cms_unit' && mu.pv === 'cms_unit_v1'
    && mu.cs.quantity_basis === 'cms_unit' && mu.cs.products.every((x) => x.unit_key === UK.cmsUnitKey(x.unit_cms)),
  'AC01 chương trình thật cms_unit: nguồn → engine → stage → seal → publish; metadata run cms_unit_v1 + snapshot khoá đơn vị', JSON.stringify([ru.status, ru.code, ru.reasons]))
  const resU = ru.runId ? await E.results(ru.runId) : []
  const runU = ru.runId ? await E.runRow(ru.runId) : null
  const oc = oracleCompare(UR, UROWS, resU, runU?.amt)
  ok(oc.diffs.length === 0 && resU.length === 8, `AC12 kết quả = ORACLE TS độc lập từng cặp (Q / tiềm năng / tiền / gate / B / GMV) + tổng ${runU?.amt}`, oc.diffs.slice(0, 4).join(' | ') || `${resU.length} cặp`)
  const sf = ru.runId ? await sqlFixture(E, ru.runId, UR.id, UROWS.map((r) => r.order_line_id)) : null
  ok(sf && sf.g.bad === 0 && sf.g.n === 8 && sf.g.pos === 7 && sf.g.paid === 5 && sf.l.bad === 0 && sf.l.n === sf.l.rl_n && sf.l.n === 13,
    'fixture SQL ĐỘC LẬP: C / Q / F(Q) / tiền từng nhóm + C trước / sau từng dòng theo seq khớp DB', JSON.stringify(sf))
  const byPair = new Map(resU.map((r) => [`${r.u}|${r.pid}`, r]))
  const g = (s, p) => byPair.get(`${SELLER_IDS[s]}|${p}`)
  ok(g(0, u1)?.q === '9' && g(1, u1)?.q === '19' && g(2, u1)?.q === '20' && g(1, u1)?.b9 === String(200n * 1000000000n),
    'AC02 / AC03: đúng ĐV (trim / hoa-thường / NFD / "4.000") cộng quantity_raw; khác ĐV (Vỉ / Viên) đóng góp 0; B vẫn là lượng cơ sở THẬT (200)')
  ok(g(0, u2)?.g === true && g(0, u2)?.q === '12' && g(2, u2)?.g === false && g(2, u2)?.amt === '0' && BigInt(g(2, u2)?.pot ?? 0) > 0n,
    'AC04 (Q-224): dòng khác ĐV vẫn góp GMV target SP (60k + 50k ≥ 100k); nhóm không đạt target ⇒ tiền 0, tiềm năng giữ')
  ok(g(3, u3)?.g === true && g(2, u3)?.g === false && g(1, u3)?.q === '0' && g(1, u3)?.g === true,
    'gate danh mục: GMV dòng khác ĐV (Lọ) vẫn tính danh mục; Q = 0 khi chỉ có dòng khác ĐV')
  const pu = ru.runId ? (await E.one(`SELECT id::text FROM public.cms_program_products WHERE program_id = $1 AND product_id = $2`, [UR.id, u1])).id : null
  const hdrU = await E.header(UR.id), rowsU = await E.rowsR(UR.id), linesU = ru.runId ? await E.linesR(UR.id, ru.runId, pu, SELLER_IDS[0]) : null
  ok(hdrU.quantity_basis === 'cms_unit' && rowsU.quantity_basis === 'cms_unit' && rowsU.calculation_policy_version === 'cms_unit_v1'
    && rowsU.units?.length === 3 && rowsU.units.find((x) => x.product_id === u2)?.unit_cms === 'Vỉ',
  'reader header / rows: cơ sở + phiên bản + đơn vị theo SNAPSHOT run', JSON.stringify([hdrU.quantity_basis, rowsU.calculation_policy_version, rowsU.units?.length]))
  const lu = linesU?.rows ?? []
  ok(lu.length === 4 && lu.filter((x) => x.unit_match === true).length === 3 && lu.find((x) => x.unit_match === false)?.counted_quantity === '0'
    && lu.filter((x) => x.unit_match).map((x) => x.counted_quantity).sort().join() === '2,3,4',
  'reader lines: unit_match + counted_quantity từng dòng (khác ĐV ⇒ false / 0 — UI hiển thị "Đơn vị bán khác ĐV tính CMS — không tính CMS")', JSON.stringify(lu.map((x) => [x.unit_match, x.counted_quantity])))
  // Lịch sử theo luật của run: đổi đơn vị CMS của SP qua owner (cấu hình mới) — run cũ vẫn đọc đơn vị cũ.
  const ppU2 = (await E.one(`SELECT id::text FROM public.cms_program_products WHERE program_id = $1 AND product_id = $2`, [UR.id, u2])).id
  await db.query(`UPDATE public.cms_program_products SET unit_cms = 'Hộp' WHERE id = $1`, [ppU2])
  const rowsUh = await E.rowsR(UR.id, ru.runId)
  ok(rowsUh.units?.find((x) => x.product_id === u2)?.unit_cms === 'Vỉ', 'đọc run lịch sử SAU khi cấu hình đổi ⇒ vẫn đơn vị trong snapshot run (Vỉ), không lấy cấu hình hiện tại')
  await db.query(`UPDATE public.cms_program_products SET unit_cms = 'Vỉ' WHERE id = $1`, [ppU2])
  // Chứng nhận / chốt / xuất.
  const hex = 'a'.repeat(64), ts = '2026-11-09T01:00:00Z'
  const attPayload = { fp_version: 'cms-rows-fp-v1', field_set: 'decision10', scope_from: UR.start, scope_to: UR.end, scope_hash: hex, run_rows_fp: hex,
    run_file_sha256: hex, reference_rows_fp: hex, reference_file_sha256: hex, reference_label: 'QA ref 128', as_of: ts, reference_exported_at: ts,
    run_exported_at: ts, lines_compared: '1', missing_lines: '0', extra_lines: '0', changed_lines: '0', tool_version: 'cms-i4-compare-v1',
    ack_reason: 'QA kiểm chặn chứng nhận run cms_unit' }
  const att = await settle(E.asSuper(`SELECT public.rpc_cms_source_attest($1, $2, $3::jsonb, $4) r`, [UR.id, ru.runId, JSON.stringify(attPayload), L.uid(912801)]))
  ok(!att.ok && att.err.includes(CMS_128_CODES.attestNotSupported), `chứng nhận nguồn run cms_unit ⇒ ${CMS_128_CODES.attestNotSupported}`, att.ok ? JSON.stringify(att.v) : att.err.slice(0, 160))
  const attPos = await settle(E.asSuper(`SELECT public.rpc_cms_source_attest($1, $2, $3::jsonb, $4) r`, [R.id, rRb.runId, JSON.stringify({ ...attPayload, scope_from: R.start, scope_to: R.end }), L.uid(912802)]))
  ok(attPos.ok || !attPos.err.includes(CMS_128_CODES.attestNotSupported), 'đối chứng: run pos_base đi tiếp qua chặn 128 (lỗi khác nếu có — vân tay giả)', attPos.ok ? 'ok' : attPos.err.slice(0, 120))
  const leU = await E.lockEval(UR.id)
  ok(leU.blockers.includes(CMS_128_CODES.attestNotSupported), 'cms__lock_eval: run hiện hành cms_unit ⇒ blocker chốt', JSON.stringify(leU.blockers))
  const exU = await E.asSuper(`SELECT public.rpc_cms_run_source_export($1, $2, NULL, 10) r`, [UR.id, ru.runId])
  ok(exU.quantity_basis === 'cms_unit' && exU.attestation_supported === false && exU.calculation_policy_version === 'cms_unit_v1', 'xuất nguồn: kèm cơ sở + attestation_supported false (tra soát, không chứng nhận)')
  // Replay cùng tập ⇒ cùng tiền; cờ OFF ⇒ held, pointer giữ.
  const ru2 = await E.sync(UR, UROWS)
  ok(ru2.status === 'published' && jeq(await E.results(ru2.runId), resU) && (await E.runRow(ru2.runId)).amt === runU.amt, 'AC06 replay cùng tập nguồn ⇒ cùng kết quả / tiền (tính lại, không cộng dồn)')
  const ruOff = await E.sync(UR, UROWS, { flag: false })
  ok(ruOff.status === 'held' && ruOff.code === UB.CMS_UNIT_CODES.disabled && (await E.prog(UR.id)).ptr === ru2.runId, 'cờ CMS_UNIT_BASIS_ENABLED OFF ⇒ held UNIT_BASIS_DISABLED, pointer giữ (không lùi luật cũ)', JSON.stringify([ruOff.status, ruOff.code]))
  // HOLD nguồn ở app (UNIT-D01): lẻ / thiếu đơn vị ⇒ held trước stage.
  const holdRows = E.rows(UR, [{ pid: u1, s: 0, uom: 'Hộp', qty: '0.5' }, { pid: u1, s: 0, uom: 'Hộp', qty: '0.5' }])
  const rh = await E.sync(UR, [...UROWS, ...holdRows])
  const stagedH = rh.runId ? Number((await one(`SELECT count(*)::int n FROM public.cms_sales_lines WHERE run_id = $1`, [rh.runId])).n) : 0
  ok(rh.status === 'held' && rh.code === UB.CMS_UNIT_CODES.fraction && stagedH === 0 && (await E.prog(UR.id)).ptr === ru2.runId,
    'Q-223 app: 0,5 + 0,5 cùng ĐV ⇒ HOLD UNIT_QUANTITY_FRACTION, 0 dòng stage, pointer giữ', JSON.stringify([rh.status, rh.code, rh.unitInvalid]))
  // QA cms_unit: điều chỉnh (lượng âm mọi đơn vị) vẫn công bố trong namespace test; C âm ⇒ Q 0.
  const v1 = E.pid()
  const UQ = await E.makeProgram({ name: 'QA CMS 128 cms_unit', isTest: true, products: [{ pid: v1, unit: 'Hộp', k: '10', tiers: T3 }], basis: 'cms_unit' })
  const UQROWS = E.rows(UQ, [{ pid: v1, s: 0, uom: 'hộp', qty: '12', base: 120, m: true }, { pid: v1, s: 0, uom: 'hộp', qty: '-2', base: -20, gmv: -2000, m: true },
    { pid: v1, s: 0, uom: 'Vỉ', qty: '-1', base: -1, gmv: -1000, m: false }, { pid: v1, s: 1, uom: 'hộp', qty: '1', base: 10, m: true },
    { pid: v1, s: 1, uom: 'hộp', qty: '-3', base: -30, gmv: -3000, m: true }, { pid: v1, s: 2, uom: 'Viên', qty: '-4', base: 4, gmv: 4000, m: false }])
  const rqu = await E.sync(UQ, UQROWS, { source: 'qa' })
  const resQU = rqu.runId ? await E.results(rqu.runId) : []
  const adjN = rqu.runId ? Number((await one(`SELECT count(*)::int n FROM public.cms_result_lines WHERE run_id = $1 AND status = 'ADJUSTMENT'`, [rqu.runId])).n) : -1
  const ocQ = oracleCompare(UQ, UQROWS, resQU, rqu.runId ? (await E.runRow(rqu.runId)).amt : undefined)
  const sfQ = rqu.runId ? await sqlFixture(E, rqu.runId, UQ.id, UQROWS.map((r) => r.order_line_id)) : null
  ok(rqu.status === 'published' && adjN === 4 && ocQ.diffs.length === 0 && sfQ?.g.bad === 0 && sfQ?.l.bad === 0
    && resQU.find((r) => r.u === SELLER_IDS[0])?.q === '10' && resQU.find((r) => r.u === SELLER_IDS[1])?.q === '0',
  'QA cms_unit: lượng âm (cả dòng khác ĐV, cả lượng âm + B dương) ⇒ ADJUSTMENT (4); C = 12 − 2 = 10; C âm ⇒ Q 0; khớp oracle + fixture SQL',
  JSON.stringify([rqu.status, rqu.code, adjN, ocQ.diffs.slice(0, 2), sfQ?.g, sfQ?.l]))
  const v128u = await E.verify('128', E.pre128, ['unit'])
  ok(E.bad(v128u).length === 0, 'VERIFY 128 + --require-proven=unit ĐẠT (đã có run cms_unit công bố)', E.show(v128u))

  // ── §8 ──
  section('8. Đột biến seal / metadata / guard')
  const sealCase = async (label, o, want) => {
    const s = await settle(E.stageDirect(UR, UROWS, o))
    const got = s.ok ? `${s.v.sealed ? 'sealed' : `${s.v.status}:${s.v.code}`}` : `throw:${s.err}`
    ok(s.ok && !s.v.sealed && s.v.code === want, `${label} ⇒ ${want}`, got)
    return s.ok ? s.v : null
  }
  await sealCase('writer công thức B / K cũ (Q = floor(ΣB / K)) + dấu cms_unit', { engineBasis: 'pos_base' }, 'SEAL_TIER_AMOUNT')
  const firstQ = (pl) => pl.parts.results.find((r) => BigInt(r.cms_quantity) > 0n)
  await sealCase('cms_quantity giả (+1, rewarded theo)', { mutate: (pl) => { const r = firstQ(pl); r.cms_quantity = String(BigInt(r.cms_quantity) + 1n); r.rewarded_quantity = r.cms_quantity } }, 'SEAL_TIER_AMOUNT')
  await sealCase('per_unit = 1 (K giả)', { mutate: (pl) => { pl.parts.results.find((r) => r.product_id === u1).per_unit = '1' } }, 'SEAL_RESULT_CONFIG')
  await sealCase('phân bổ dòng: đổi tiền hai dòng cùng nhóm (tổng giữ)', { mutate: (pl) => {
    const grp = pl.parts.result_lines.filter((l) => l.user_id === SELLER_IDS[1] && l.program_product_id === pu)
    const [x, y] = [grp.find((l) => l.amount_vnd !== '0'), grp.find((l) => l.amount_vnd === '0')]
    const t = x.amount_vnd; x.amount_vnd = y.amount_vnd; y.amount_vnd = t
  } }, 'SEAL_LINE_ALLOC')
  const matchedLine = (pl) => pl.parts.sales_lines.find((l) => l.disposition === 'INCLUDED' && l.uom_raw === 'Hộp' && l.quantity_raw === '3')
  await sealCase('lượng lẻ ở dòng đúng ĐV (writer bỏ HOLD)', { mutate: (pl) => { matchedLine(pl).quantity_raw = '3.5' } }, 'SEAL_UNIT_SOURCE')
  await sealCase('đơn vị NULL ở dòng chưa gán', { mutate: (pl) => { pl.parts.sales_lines.find((l) => l.disposition === 'UNASSIGNED').uom_raw = null } }, 'SEAL_UNIT_SOURCE')
  await sealCase('lượng sai hình thức ở dòng khác ĐV', { mutate: (pl) => { pl.parts.sales_lines.find((l) => l.uom_raw === 'Viên').quantity_raw = '1e2' } }, 'SEAL_UNIT_SOURCE')
  await sealCase('lượng ngoài miền bigint ở dòng đúng ĐV', { mutate: (pl) => { matchedLine(pl).quantity_raw = '9223372036854775808' } }, 'SEAL_UNIT_SOURCE')
  await sealCase('writer CŨ không dấu (app trước deploy) trên run cms_unit', { expect: strip }, 'BASIS_WRITER_MISMATCH')
  await sealCase('dấu khai pos_base', { expect: (e) => ({ ...e, quantity_basis: 'pos_base', calculation_policy_version: 'pos_base_v1' }) }, 'BASIS_WRITER_MISMATCH')
  await sealCase('dấu phiên bản lạ cms_unit_v2', { expect: (e) => ({ ...e, calculation_policy_version: 'cms_unit_v2' }) }, 'BASIS_WRITER_MISMATCH')
  await sealCase('dấu kiểu số', { expect: (e) => ({ ...e, quantity_basis: 1 }) }, 'BASIS_WRITER_MISMATCH')
  await sealCase('đổi ĐV CMS (owner, không tăng version) giữa open và seal', {
    beforeSeal: () => db.query(`UPDATE public.cms_program_products SET unit_cms = 'Hộp' WHERE id = $1`, [ppU2]) }, 'CONFIG_CHANGED')
  await db.query(`UPDATE public.cms_program_products SET unit_cms = 'Vỉ' WHERE id = $1`, [ppU2])
  // P2-1: snapshot ghi ngoài RPC (owner tắt trigger bất biến — ENABLE ALWAYS nên session_replication_role không vượt) — config_fp giữ
  // đúng, chỉ khoá đơn vị / phiên bản khoá lệch ⇒ vẫn held. Bật lại ALWAYS ngay + kiểm tgenabled.
  const forged = []
  const forgeSnap = (patchSql) => async (runId) => {
    forged.push(runId)
    await db.query(`ALTER TABLE public.cms_sync_runs DISABLE TRIGGER cms_sync_runs_basis_guard`)
    try { await db.query(`UPDATE public.cms_sync_runs SET calculation_snapshot = ${patchSql} WHERE id = $1`, [runId]) }
    finally { await db.query(`ALTER TABLE public.cms_sync_runs ENABLE ALWAYS TRIGGER cms_sync_runs_basis_guard`) }
    const tg = await one(`SELECT tgenabled::text e FROM pg_trigger WHERE tgname = 'cms_sync_runs_basis_guard' AND tgrelid = 'public.cms_sync_runs'::regclass`)
    if (tg.e !== 'A') throw new Error('forgeSnap: trigger chưa bật lại ALWAYS')
    const fp = await one(`SELECT (calculation_snapshot ->> 'config_fp') = public.cms__config_fp(program_id) AS same FROM public.cms_sync_runs WHERE id = $1`, [runId])
    if (!fp.same) throw new Error('forgeSnap: config_fp phải giữ đúng để ca có nghĩa')
  }
  await sealCase('snapshot ghi ngoài RPC: unit_key SP đầu đổi thành "viên" (config_fp đúng)', {
    beforeSeal: forgeSnap(`jsonb_set(calculation_snapshot, '{products,0,unit_key}', '"viên"'::jsonb)`) }, 'CONFIG_CHANGED')
  await sealCase('snapshot ghi ngoài RPC: unit_key_version cms-unit-key-v0 (config_fp đúng)', {
    beforeSeal: forgeSnap(`jsonb_set(calculation_snapshot, '{unit_key_version}', '"cms-unit-key-v0"'::jsonb)`) }, 'CONFIG_CHANGED')
  {
    // Trả snapshot thật (cấu hình chương trình không đổi từ lúc open) cho run thử — VERIFY v128-run-basis bắt snapshot giả nếu để sót.
    await db.query(`ALTER TABLE public.cms_sync_runs DISABLE TRIGGER cms_sync_runs_basis_guard`)
    try { await db.query(`UPDATE public.cms_sync_runs SET calculation_snapshot = public.cms__calc_snapshot(program_id) WHERE id = ANY($1::uuid[])`, [forged]) }
    finally { await db.query(`ALTER TABLE public.cms_sync_runs ENABLE ALWAYS TRIGGER cms_sync_runs_basis_guard`) }
    const left = await one(`SELECT count(*)::int n FROM public.cms_sync_runs WHERE id = ANY($1::uuid[]) AND calculation_snapshot IS DISTINCT FROM public.cms__calc_snapshot(program_id)`, [forged])
    ok(forged.length === 2 && left.n === 0, 'ca snapshot giả: trả snapshot thật cho 2 run thử, trigger bất biến bật lại ALWAYS', JSON.stringify({ forged: forged.length, left: left.n }))
  }
  {
    const s = await E.stageDirect(UR, UROWS)
    await db.query(`UPDATE public.cms_program_products SET base_quantity_cms = 12 WHERE id = $1`, [ppU2])
    const p = s.sealed ? await E.publishRpc(s.runId) : null
    await db.query(`UPDATE public.cms_program_products SET base_quantity_cms = 24 WHERE id = $1`, [ppU2])
    ok(s.sealed && p?.published === false && p.code === 'CONFIG_CHANGED' && (await E.prog(UR.id)).ptr === ru2.runId, 'đổi K giữa seal và publish ⇒ held CONFIG_CHANGED, pointer giữ', JSON.stringify(p))
  }
  {
    const o = await settle(E.rpc(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [UR.id, JSON.stringify({ source: 'operator', quantity_basis: 'pos_base' })]))
    ok(!o.ok && o.err === 'CMS_SYNC_BAD_DETAIL', 'open: detail mang khoá dành riêng (quantity_basis) ⇒ CMS_SYNC_BAD_DETAIL', o.ok ? 'KHÔNG chặn' : o.err)
    const s = await E.stageDirect(UR, UROWS)
    const f = await settle(E.rpc(`SELECT public.rpc_cms_sales_run_finish($1, $2, $3::jsonb) r`, [s.runId, 'error', JSON.stringify({ calculation_snapshot: {} })]))
    ok(!f.ok && f.err === 'CMS_SYNC_BAD_DETAIL', 'finish: detail mang calculation_snapshot ⇒ CMS_SYNC_BAD_DETAIL', f.ok ? 'KHÔNG chặn' : f.err)
    const m = await settle(db.query(`UPDATE public.cms_sync_runs SET quantity_basis = 'pos_base', calculation_policy_version = 'pos_base_v1' WHERE id = $1`, [s.runId]))
    ok(!m.ok && /CMS_RUN_BASIS_IMMUTABLE/.test(m.err), 'owner UPDATE cơ sở / phiên bản run ⇒ CMS_RUN_BASIS_IMMUTABLE', m.ok ? 'KHÔNG chặn' : m.err.slice(0, 120))
    const m2 = await settle(db.query(`UPDATE public.cms_sync_runs SET calculation_snapshot = calculation_snapshot || '{"x":1}'::jsonb WHERE id = $1`, [s.runId]))
    ok(!m2.ok && /CMS_RUN_BASIS_IMMUTABLE/.test(m2.err), 'owner UPDATE snapshot run ⇒ CMS_RUN_BASIS_IMMUTABLE', m2.ok ? 'KHÔNG chặn' : m2.err.slice(0, 120))
    // Đóng run thử (đã seal, không công bố) — giữ pointer ở run trước.
    await db.query(`UPDATE public.cms_sync_runs SET status = 'error', error_code = 'QA_ABORT', finished_at = now() WHERE id = $1`, [s.runId])
    ok((await E.prog(UR.id)).ptr === ru2.runId, 'đóng run thử: pointer giữ run trước')
  }
  const insRun = (extra) => settle(db.query(`INSERT INTO public.cms_sync_runs (kind, program_id, config_version, is_test, mapping_fp${extra.cols})
    SELECT 'sales', p.id, p.config_version, p.is_test, public.cms__mapping_fp()${extra.vals} FROM public.cms_programs p WHERE p.id = $1`, [UR.id]))
  for (const [label, x] of [['thiếu metadata', { cols: '', vals: '' }],
    ['nhãn legacy cho run mới', { cols: ', quantity_basis, calculation_policy_version', vals: ", 'pos_base', 'pos_base_legacy'" }],
    ['cơ sở cms_unit + chính sách pos_base_v1', { cols: ', quantity_basis, calculation_policy_version, calculation_snapshot', vals: ", 'cms_unit', 'pos_base_v1', public.cms__calc_snapshot(p.id)" }]]) {
    const r = await insRun(x)
    ok(!r.ok && /CMS_RUN_BASIS_INVALID/.test(r.err), `INSERT run bán ${label} ⇒ CMS_RUN_BASIS_INVALID`, r.ok ? 'KHÔNG chặn' : r.err.slice(0, 120))
  }
  {
    const r = await insRun({ cols: ', quantity_basis, calculation_policy_version, calculation_snapshot', vals: ", 'cms_unit', 'cms_unit_v1', public.cms__calc_snapshot(p.id) || '{\"quantity_basis\":\"pos_base\"}'::jsonb" })
    ok(!r.ok && /cms_sync_runs_basis_shape/.test(r.err), 'INSERT run có snapshot khai cơ sở khác cột ⇒ CHECK cms_sync_runs_basis_shape', r.ok ? 'KHÔNG chặn' : r.err.slice(0, 120))
  }
  // Lượng âm ở dòng KHÔNG INCLUDED (chương trình thật) — chỉ mệnh đề 128 bắt (B / GMV dương).
  {
    const negRows = [...UROWS, ...E.rows(UR, [{ pid: u1, email: 'chua.gan.am@example.invalid', uom: 'Vỉ', qty: '-1', base: 1, gmv: 10000 }])]
    const s = await E.stageDirect(UR, negRows)
    const p = s.sealed ? await E.publishRpc(s.runId) : null
    ok(s.sealed && s.expect.totals.adjustment_lines === 0 && p?.published === false && p.code === 'RETURNS_NOT_SUPPORTED_THIS_PHASE' && (await E.prog(UR.id)).ptr === ru2.runId,
      'thật cms_unit: dòng chưa gán quantity_raw âm (B / GMV dương) ⇒ seal đạt nhưng publish held RETURNS_NOT_SUPPORTED_THIS_PHASE', JSON.stringify([s.code, p]))
    const zRows = [...UROWS, ...E.rows(UR, [{ pid: u1, email: 'chua.gan.khong@example.invalid', uom: 'Vỉ', qty: '-0.000', base: 1, gmv: 10000 }])]
    const z = await E.stageDirect(UR, zRows)
    const pz = z.sealed ? await E.publishRpc(z.runId) : null
    ok(z.sealed && pz?.published === true, 'đối chứng: "-0.000" không phải lượng âm ⇒ công bố', JSON.stringify([z.code, pz]))
  }
  // Guard đổi cơ sở.
  {
    const e1 = await settle(E.saveProgram({ id: UR.id, name: 'THẬT CMS 128 cms_unit', start_date: UR.start, end_date: UR.end, scope: 'stores', store_ids: UR.storeIds, quantity_basis: 'pos_base' }))
    ok(!e1.ok && /CMS_PROGRAM_NOT_EDITABLE|CMS_PROGRAM_BASIS_CHANGE_INVALID/.test(e1.err) && (await E.prog(UR.id)).qb === 'cms_unit',
      'form: đổi cơ sở chương trình đã bắt đầu / có run ⇒ chặn (121 NOT_EDITABLE trước; guard 128 là lớp 2 — thử thẳng ở dưới)', e1.ok ? 'KHÔNG chặn' : e1.err.slice(0, 120))
    const fp = E.pid()
    const fut = await E.saveProgram({ name: 'QA active tương lai 128', start_date: await E.day(10), end_date: await E.day(20), scope: 'stores', store_ids: [storeId(1)], is_test: true })
    await E.commit(await E.preview(fut), 'replace', [{ pid: fp, tiers: T3 }])
    await E.svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [fut, U.super])
    const f0 = await E.prog(fut)
    await E.saveProgram({ id: fut, name: 'QA active tương lai 128', start_date: await E.day(10), end_date: await E.day(20), scope: 'stores', store_ids: [storeId(1)], quantity_basis: 'cms_unit' })
    const f1 = await E.prog(fut)
    ok(f0.status === 'active' && f0.qb === 'pos_base' && f1.qb === 'cms_unit' && f1.v === f0.v + 1,
      'DB: active CHƯA bắt đầu, chưa có run ⇒ đổi cơ sở qua RPC được (version + 1); app không gửi khoá khi sửa (UNIT-D05)', JSON.stringify([f0, f1]))
    const e2 = await settle(E.saveProgram({ name: 'QA lạ', start_date: await E.day(3), end_date: await E.day(5), scope: 'stores', store_ids: [storeId(1)], is_test: true, quantity_basis: 'cms' }))
    ok(!e2.ok && /CMS_PROGRAM_BAD_INPUT/.test(e2.err), 'form: quantity_basis lạ ⇒ CMS_PROGRAM_BAD_INPUT', e2.ok ? 'KHÔNG chặn' : e2.err.slice(0, 120))
    const d = await E.saveProgram({ name: 'QA nháp 128', start_date: await E.day(3), end_date: await E.day(5), scope: 'stores', store_ids: [storeId(1)], is_test: true })
    await E.saveProgram({ id: d, name: 'QA nháp 128', start_date: await E.day(3), end_date: await E.day(5), scope: 'stores', store_ids: [storeId(1)], quantity_basis: 'cms_unit' })
    const d1 = await E.prog(d)
    await E.saveProgram({ id: d, name: 'QA nháp 128 b', start_date: await E.day(3), end_date: await E.day(5), scope: 'stores', store_ids: [storeId(1)] })
    ok(d1.qb === 'cms_unit' && (await E.prog(d)).qb === 'cms_unit', 'nháp: đổi cơ sở qua form được (version + 1); sửa KHÔNG gửi khoá ⇒ giữ nguyên cơ sở')
    const raw = await settle(db.query(`UPDATE public.cms_programs SET quantity_basis = 'pos_base' WHERE id = $1`, [UR.id]))
    ok(!raw.ok && /CMS_PROGRAM_BASIS_CHANGE_INVALID/.test(raw.err), 'owner đổi cơ sở thẳng (không tăng version) ⇒ chặn', raw.ok ? 'KHÔNG chặn' : raw.err.slice(0, 120))
    // Đường datafix (UNIT-4): phiên khai cms.basis_change_program = id + version + 1 + pointer NULL — chương trình QA pos_base có run.
    const df = (pid, setId) => `BEGIN;
      ${setId ? `SELECT set_config('cms.basis_change_program', '${setId}', true);` : ''}
      ALTER TABLE public.cms_programs DISABLE TRIGGER cms_programs_result_guard;
      UPDATE public.cms_programs SET quantity_basis = 'cms_unit', config_version = config_version + 1, current_result_run_id = NULL WHERE id = '${pid}';
      ALTER TABLE public.cms_programs ENABLE TRIGGER cms_programs_result_guard;
      COMMIT;`
    const n1 = await execFail(db, df(Q.id, null))
    ok(!n1.ok && /CMS_PROGRAM_BASIS_CHANGE_INVALID/.test(n1.err) && (await E.prog(Q.id)).qb === 'pos_base', 'datafix KHÔNG khai phiên ⇒ chặn (chương trình có run)', n1.ok ? 'KHÔNG chặn' : n1.err.slice(0, 120))
    const n2 = await execFail(db, df(Q.id, UR.id))
    ok(!n2.ok && /CMS_PROGRAM_BASIS_CHANGE_INVALID/.test(n2.err), 'datafix khai phiên cho chương trình KHÁC ⇒ chặn', n2.ok ? 'KHÔNG chặn' : n2.err.slice(0, 120))
    const n3 = await execFail(db, df(Q.id, Q.id))
    const gq = await E.prog(Q.id)
    ok(n3.ok && gq.qb === 'cms_unit' && gq.ptr === null && (await E.one(`SELECT tgenabled::text e FROM pg_trigger WHERE tgname = 'cms_programs_result_guard'`)).e === 'O',
      'datafix đúng phiên ⇒ đổi cơ sở + version + 1 + pointer NULL; trigger pointer trở lại O', n3.ok ? JSON.stringify(gq) : n3.err.slice(0, 120))
    const rqx = await E.sync(Q, E.rows(Q, [{ pid: q1, s: 0, uom: 'hộp', qty: '7', base: 7 }]), { source: 'qa' })
    ok(rqx.status === 'published' && rqx.quantityBasis === 'cms_unit' && (await E.results(rqx.runId))[0]?.q === '7', 'sau datafix: tính lại theo cms_unit (Q = 7, không floor(7 / 6))', JSON.stringify([rqx.status, rqx.code]))
  }

  // ── §9 ──
  section('9. Rollback bị chặn khi đã có cms_unit · VERIFY 128 + đột biến')
  {
    const r = await execFail(db, RB_128)
    ok(!r.ok && /đã có chương trình \/ run cơ sở cms_unit/.test(r.err) && (await E.fnCount()) === 74 && (await E.hasCol()), 'rollback 128 dừng khi đã có cms_unit (0 delta — xử lý tiến)', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160))
  }
  const vAll = await E.verify('128', E.pre128, ['unit'])
  ok(E.bad(vAll).length === 0 && vAll.find((c) => c.id === 'v128-run-basis')?.proven === true, 'VERIFY 128 ĐẠT, run-basis + unit ĐÃ chứng minh', E.show(vAll))
  const vMut = async (label, doIt, undo, wantId) => {
    await doIt()
    const cs = await E.verify('128', E.pre128)
    await undo()
    const hit = E.bad(cs).filter((c) => (wantId instanceof RegExp ? wantId.test(c.id) : c.id === wantId))
    ok(hit.length > 0, `đột biến ${label} ⇒ VERIFY 128 đỏ (${hit.map((c) => c.id).join(', ') || String(wantId)})`, E.show(cs))
  }
  await vMut('grant cms__unit_key cho service_role', () => db.exec('GRANT EXECUTE ON FUNCTION public.cms__unit_key(text) TO service_role'),
    () => db.exec('REVOKE ALL ON FUNCTION public.cms__unit_key(text) FROM service_role'), /fn-(acl|exec):cms__unit_key/)
  await vMut('thân seal_step về bản 122', () => db.exec(orReplace(GEN.base.rpc_cms_sales_run_seal_step)), () => db.exec(GEN.replaced.rpc_cms_sales_run_seal_step), 'fn-src:rpc_cms_sales_run_seal_step')
  await vMut('tắt trigger metadata run', () => db.exec('ALTER TABLE public.cms_sync_runs DISABLE TRIGGER cms_sync_runs_basis_guard'),
    () => db.exec('ALTER TABLE public.cms_sync_runs ENABLE ALWAYS TRIGGER cms_sync_runs_basis_guard'), 'triggers')
  {
    const old = (await E.one(`SELECT id::text FROM public.cms_sync_runs WHERE program_id = $1 AND kind = 'sales' AND quantity_basis = 'pos_base' AND status = 'ok' AND published_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`, [Q.id])).id
    const cur = (await E.prog(Q.id)).ptr
    const setPtr = (v) => db.exec(`ALTER TABLE public.cms_programs DISABLE TRIGGER cms_programs_result_guard; UPDATE public.cms_programs SET current_result_run_id = ${v ? `'${v}'` : 'NULL'} WHERE id = '${Q.id}'; ALTER TABLE public.cms_programs ENABLE TRIGGER cms_programs_result_guard;`)
    await vMut('pointer chương trình cms_unit trỏ run pos_base cũ', () => setPtr(old), () => setPtr(cur), 'v128-pointer-basis')
  }
  {
    const vr = ru2.runId
    const saved = await E.runMeta(vr)
    const setLegacy = () => db.exec(`ALTER TABLE public.cms_sync_runs DISABLE TRIGGER cms_sync_runs_basis_guard;
      UPDATE public.cms_sync_runs SET quantity_basis = 'pos_base', calculation_policy_version = 'pos_base_legacy', calculation_snapshot = NULL WHERE id = '${vr}';
      ALTER TABLE public.cms_sync_runs ENABLE ALWAYS TRIGGER cms_sync_runs_basis_guard;`)
    const restore = async () => {
      await db.exec('ALTER TABLE public.cms_sync_runs DISABLE TRIGGER cms_sync_runs_basis_guard')
      await db.query(`UPDATE public.cms_sync_runs SET quantity_basis = $2, calculation_policy_version = $3, calculation_snapshot = $4::jsonb WHERE id = $1`, [vr, saved.qb, saved.pv, JSON.stringify(saved.cs)])
      await db.exec('ALTER TABLE public.cms_sync_runs ENABLE ALWAYS TRIGGER cms_sync_runs_basis_guard')
    }
    await vMut('run sau 128 bị dán nhãn legacy', setLegacy, restore, /v128-(run-basis|pointer-basis)/)
  }
  ok(E.bad(await E.verify('128', E.pre128, ['unit'])).length === 0, 'khôi phục mọi đột biến ⇒ VERIFY 128 lại đạt')
}

async function crlfCase() {
  section('10. Dán CRLF (Studio): 128 + rollback CRLF ≡ LF')
  const X = await env('crlf')
  const ax = await settle(X.db.exec(CRLF(SQL_128)))
  const vx = ax.ok ? await X.verify('128', X.pre128) : []
  ok(ax.ok && X.bad(vx).length === 0, '128 dán CRLF ⇒ hậu kiểm md5 bỏ \\r đạt + VERIFY 128 đạt', ax.ok ? X.show(vx) : ax.err.slice(0, 160))
  const k = await X.one(`SELECT public.cms__unit_key(E' Ho\\u0323\\u0302p\\u00a0') k, public.cms__unit_key(E'h\\u0007p') bad, public.cms__qty_dec('2.000')::text q`)
  ok(k.k === 'hộp' && k.bad === null && k.q === '2.000', 'helper sau CRLF giữ hợp đồng (NFC / NBSP / điều khiển / lượng)', JSON.stringify(k))
  const rx = await settle(X.db.exec(CRLF(RB_128)))
  ok(rx.ok && (await X.fnCount()) === 68 && !(await X.hasCol()), 'rollback dán CRLF ⇒ 68 hàm, cột gỡ', rx.ok ? '' : rx.err.slice(0, 160))
}

async function pg15Extra() {
  section('11. PG15: race lock_timeout + bench seal cms_unit ở trần nguồn')
  const E = await env('race')
  const c2 = await E.conn()
  await c2.query('BEGIN')
  await c2.query(`LOCK TABLE public.cms_sync_runs IN ROW EXCLUSIVE MODE`)
  let t0 = Date.now()
  const b1 = await execFail(E.db, SQL_128)
  let waited = Date.now() - t0
  await c2.query('ROLLBACK')
  ok(!b1.ok && /lock timeout/i.test(b1.err) && waited >= 4500 && waited < 9000 && !(await E.hasCol()), `128 × giao dịch đang ghi bảng run ⇒ hết lock_timeout 5 s (${waited} ms), 0 delta`, b1.err)
  const zP = E.pid()
  const PZ = await E.makeProgram({ name: 'QA race', isTest: true, products: [{ pid: zP, tiers: T3 }] })
  await c2.query('BEGIN')
  await c2.query(`SELECT 1 FROM public.cms_programs WHERE id = $1 FOR UPDATE`, [PZ.id])
  t0 = Date.now()
  const b2 = await execFail(E.db, SQL_128)
  waited = Date.now() - t0
  await c2.query('ROLLBACK')
  ok(!b2.ok && /lock timeout/i.test(b2.err) && waited >= 4500 && !(await E.hasCol()), `128 × khoá dòng chương trình ⇒ hết lock_timeout (${waited} ms), 0 delta`, b2.err)
  await E.db.exec(SQL_128)
  ok(await E.hasCol(), 'nhả khoá ⇒ áp 128 được')

  // Bench: cms_unit, 2 SP, 19 % chưa gán, 30 % khác ĐV, lượng nguyên 1–3 — mỗi RPC < 8 s với statement_timeout 8 s như PostgREST (KHÔNG nới).
  const b1p = E.pid(), b2p = E.pid()
  const PB = await E.makeProgram({ name: 'THẬT bench cms_unit', isTest: false, basis: 'cms_unit', catalogTarget: null,
    products: [{ pid: b1p, unit: 'hộp', k: '10', tiers: T3 }, { pid: b2p, unit: 'Vỉ', k: '24', tiers: T3 }] })
  const una = Math.floor(BENCH_ROWS * 0.19), rest = BENCH_ROWS - una, quarter = Math.floor(rest / 4)
  const specs = [{ pid: b1p, s: 0, uom: 'Hộp', qty: '2', base: 20, n: quarter }, { pid: b2p, s: 1, uom: 'vỉ', qty: '3', base: 3, n: quarter },
    { pid: b1p, s: 2, uom: 'Vỉ', qty: '1', base: 1, n: quarter }, { pid: b2p, s: 3, uom: 'Hộp', qty: '1', base: 24, n: rest - 3 * quarter },
    { pid: b1p, email: 'chua.gan.bench@example.invalid', uom: 'Hộp', qty: '1', base: 10, n: una }]
  const rowsB = E.rows(PB, specs)
  await E.db.query(`SET statement_timeout = '8s'`)
  // db-reviewer P1: số lần gọi cms__unit_key / cms__qty_dec trong cả lượt (track_functions, reset trước) — phải ≈ số giá trị PHÂN BIỆT,
  // không tỷ lệ số dòng (CTE du / dq MATERIALIZED; PG15 không bọc PlaceHolderVar cho biểu thức strict phía nullable của LEFT JOIN).
  const FN_OIDS = `'public.cms__unit_key(text)'::regprocedure, 'public.cms__qty_dec(text)'::regprocedure`
  await E.db.query(`SET track_functions = 'all'`)
  await E.db.query(`SELECT pg_stat_reset_single_function_counters(p.oid) FROM pg_proc p WHERE p.oid IN (${FN_OIDS})`)
  E.timings.length = 0
  const tb = Date.now()
  const rB = await E.sync(PB, rowsB)
  const totalMs = Date.now() - tb
  await E.db.query(`SELECT pg_stat_force_next_flush()`)
  await E.db.query(`SELECT pg_stat_clear_snapshot()`)
  const calls = Object.fromEntries((await E.db.query(`SELECT p.proname, COALESCE(pg_stat_get_function_calls(p.oid), 0)::int AS n FROM pg_proc p WHERE p.oid IN (${FN_OIDS})`)).rows.map((x) => [x.proname, x.n]))
  await E.db.query(`SET track_functions = 'none'`)
  const mx = (l) => Math.max(0, ...E.timings.filter((t) => t.label === l).map((t) => t.ms))
  for (const l of ['seal_begin', 'seal_step', 'publish']) console.log(`    ${l}: max ${mx(l)} ms (${E.timings.filter((t) => t.label === l).length} lần)`)
  console.log(`    seal_step theo bước: ${E.timings.filter((t) => t.label === 'seal_step').map((t) => `${t.step}:${t.ms}`).join(' · ')} ms`)
  console.log(`    số lần gọi: cms__unit_key ${calls.cms__unit_key} · cms__qty_dec ${calls.cms__qty_dec} (${BENCH_ROWS} dòng)`)
  ok(calls.cms__unit_key > 0 && calls.cms__unit_key <= 64 && calls.cms__qty_dec > 0 && calls.cms__qty_dec <= 64,
    `seal chuẩn hoá theo giá trị PHÂN BIỆT, không theo dòng (cms__unit_key ${calls.cms__unit_key} · cms__qty_dec ${calls.cms__qty_dec} lần / ${BENCH_ROWS} dòng)`)
  const st = E.timings.filter((t) => t.label === 'stage').map((t) => t.ms).sort((a, b) => a - b)
  console.log(`    stage: ${st.length} khối · p50 ${st[Math.floor(st.length / 2)]} · max ${st.at(-1)} ms`)
  console.log(`    bench ${rowsB.length} dòng (${una} chưa gán): tổng ${totalMs} ms`)
  ok(rB.status === 'published' && rB.rowsRead === BENCH_ROWS && rB.quantityBasis === 'cms_unit', `bench: ${BENCH_ROWS} dòng nguồn cms_unit công bố được`, JSON.stringify([rB.status, rB.code, rB.rowsRead]))
  const sealMs = Math.max(mx('seal_begin'), mx('seal_step')), pubMs = mx('publish'), stageMs = st.at(-1) ?? 0
  ok(sealMs < 8000 && pubMs < 8000 && stageMs < 8000, `mỗi RPC < 8 s, statement_timeout 8 s giữ nguyên (seal ${sealMs} · publish ${pubMs} · stage ${stageMs} ms)`)
  const qs = await E.results(rB.runId)
  const want = new Map([[`${SELLER_IDS[0]}|${b1p}`, 2 * quarter], [`${SELLER_IDS[1]}|${b2p}`, 3 * quarter], [`${SELLER_IDS[2]}|${b1p}`, 0], [`${SELLER_IDS[3]}|${b2p}`, 0]])
  ok(qs.length === 4 && qs.every((r) => want.get(`${r.u}|${r.pid}`) === Number(r.q)), 'bench: Q đúng ĐV từng cặp (khác ĐV ⇒ 0)', JSON.stringify(qs.map((r) => [r.pid, r.q])))
  await E.db.query(`SET statement_timeout = 0`)
}

let rc = 0
try {
  if (BENCH_ONLY && PG15) await pg15Extra()
  else { await main(); await crlfCase(); if (PG15) await pg15Extra() }
} catch (e) {
  fail++; console.log(`  ✗ LỖI KHÔNG BẮT: ${e?.stack ?? e}`)
} finally {
  await ENV.closeAll()
}
console.log(`\nQA 128: ${pass} đạt / ${fail} lỗi`)
rc = fail ? 1 : 0
process.exitCode = rc
// async-exit-hook của embedded-postgres tự gọi process.exit() ⇒ mất exitCode; thoát tường minh để rc phản ánh đúng số lỗi.
if (PG15) process.exit(rc)
