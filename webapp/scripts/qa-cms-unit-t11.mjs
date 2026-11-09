// QA DIỄN TẬP datafix T11 CMS-UNIT (UNIT-4 — PM spec 09/11 §5 / AC11 / AC07 race / AC12 tác động) trên chuỗi migration THẬT 120 → 126 +
// marker 127 mô phỏng + 128 THẬT + app mới (engine / salesSync / resultStage / reader CMS-UNIT). File datafix SINH bằng
// scripts/gen-cms-unit-t11.mjs với bản ghim dựng từ DB thử (chương trình THẬT giả lập T11: 17 SP × 1 mức cố định, đã công bố pos_base) —
// cùng template / generator với file phát hành; số migration là tham số (diễn tập dùng SỐ GIẢ LẬP 129, nền 128 — 129 CHƯA được dành; PM ghim số thật khi chốt release tổng). Hai backend: PGlite (mặc định) và
// PostgreSQL 15 embedded (`--pg15 <embedded-postgres-dir> <data-root>`).
//   §0 generator: bản ghim mặc định (T11 sau 127) hợp lệ, CHƯA ghim tại cửa sổ ⇒ chỉ diễn tập; số migration bắt buộc / ≥ 129; repo không có
//      file datafix mang số; LF; md5 9 hàm guard = định nghĩa cuối 120–128 = DB; 16 trigger hằng = DB
//   §1 DB 128 + T11 giả lập (thật, pos_base, run công bố) + chương trình thật khác + QA; tiền trước datafix = luật cũ
//   §2 preflight dừng, 0 delta: UUID lạ · version lệch · vân tay lệch · K lệch · mức lệch · không active · đã chốt · có payout · run
//      'running' (race sync ↔ datafix) · khoá đơn vị hỏng · thiếu nền · số > nền · trigger pointer ALWAYS · không READ COMMITTED · role không
//      phải owner · lỗi hậu kiểm SAU khi tắt trigger ⇒ rollback cả transaction, trigger về 'O'
//   §3 áp: cơ sở cms_unit + version + 1 + pointer NULL atomically; SP / mức / phạm vi / chương trình khác / QA / run / kết quả / hàm /
//      trigger không đổi; run cũ giữ nhãn pos_base; marker; reader ⇒ basis_pending (không 0₫ / không số luật cũ); chạy lại bị chặn
//   §4 tính lại toàn kỳ theo cms_unit: tiền = oracle độc lập từng cặp; ma trận tác động cũ ↔ mới (tăng / giảm / về 0 / không đổi)
//   §5 rollback bù: pos_base, version TĂNG tiếp, pointer NULL, marker xoá, run cms_unit GIỮ metadata; áp lại CÙNG file bị chặn; rollback
//      lệch version bị chặn; tính lại pos_base = run cũ từng cặp
//   §6 ghim mới sau rollback + dán CRLF (Studio): datafix + rollback CRLF áp được (md5 thân bỏ \r)
//   §7 (chỉ --pg15) race khoá thật: giao dịch giữ khoá dòng chương trình ⇒ datafix hết lock_timeout, 0 delta; datafix giữ khoá ⇒ mở run
//      chờ rồi lỗi, không run 'running' rơi vãi
// KHÔNG chạm DB thật / nguồn thật / mạng (PG15 chỉ 127.0.0.1).
//   npm i --no-save @electric-sql/pglite@0.2.17 ; node scripts/qa-cms-unit-t11.mjs
//   node scripts/qa-cms-unit-t11.mjs --pg15 <embedded-postgres-dir> <data-root>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import * as L from './lib-care-pglite.mjs'
import { createCmsEnv } from './lib-cms-128-env.mjs'
import { buildCms128 } from './gen-cms-128.mjs'
import {
  buildCmsUnitT11, CMS_UNIT_T11_GUARDS, CMS_UNIT_T11_ID, CMS_UNIT_T11_RATES_MD5, CMS_UNIT_T11_TRIGGERS, cmsUnitRatesMd5, loadCmsUnitT11Pin,
  validateCmsUnitT11Pin,
} from './gen-cms-unit-t11.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@': path.join(HERE, '..') } })
const lib = (p) => jiti.import(path.join(HERE, '..', p))
const T = await lib('e2e/cmsQaTooling.ts')
const C = await lib('lib/cms/source/contract.ts')
const SS = await lib('lib/cms/salesSync.ts')
const RS = await lib('lib/cms/resultStage.ts')
const EN = await lib('lib/cms/engine/compute.ts')
const QR = await lib('e2e/cmsQaResults.ts')
const FX = await lib('e2e/cmsFixtureRunner.ts')
const OR = await lib('e2e/cmsUnitOracle.ts')
const RV = await lib('lib/cms/resultView.ts')
const { U } = L

const argv = process.argv.slice(2)
const PG15 = argv[0] === '--pg15'
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) } }
const section = (s) => console.log(`\n${s}`)
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, err: String(e?.message ?? e), code: e?.code }))
const execFail = async (db, sql) => { const r = await settle(db.exec(sql)); if (!r.ok) await db.exec('ROLLBACK').catch(() => {}); return r }
const CRLF = (s) => s.split('\n').join('\r\n')
const ENV = createCmsEnv({ libs: { T, C, SS, RS, EN, QR, FX }, pg15: PG15 ? { modDir: argv[1], dataRoot: argv[2] } : null, port: 54359, dbPrefix: 'rpgcmsut11' })
const { env, ORACLE_SELLERS, SELLER_IDS } = ENV

// ── §0 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
section('0. Generator · bản ghim mặc định · không file mang số')
{
  const pin = loadCmsUnitT11Pin()
  const v = settle(Promise.resolve().then(() => validateCmsUnitT11Pin(pin, { rehearsal: true })))
  ok((await v).ok && pin.program.id === CMS_UNIT_T11_ID && cmsUnitRatesMd5(pin.products) === CMS_UNIT_T11_RATES_MD5 && pin.program.config_version === 4,
    'bản ghim mặc định = T11 sau 127 (17 SP, 17 mức md5 PM, version 4, pos_base)')
  const np = await settle(Promise.resolve().then(() => buildCmsUnitT11({ pin, version: 129 })))
  ok(!np.ok && /CHƯA chụp tại cửa sổ/.test(np.err), 'bản ghim CHƯA chụp tại cửa sổ ⇒ không sinh file phát hành (chỉ --rehearsal)', np.ok ? 'KHÔNG chặn' : np.err)
  for (const [ver, after, label] of [[undefined, undefined, 'thiếu số'], [128, undefined, 'số 128'], [130, 130, 'nền ≥ số'], [130, 127, 'nền < 128']]) {
    const r = await settle(Promise.resolve().then(() => buildCmsUnitT11({ pin, version: ver, after, rehearsal: true })))
    ok(!r.ok, `số migration ${label} ⇒ từ chối`, r.ok ? 'KHÔNG chặn' : '')
  }
  const r = buildCmsUnitT11({ pin, version: 129, rehearsal: true })
  ok(r.migration.includes('BẢN DIỄN TẬP') && r.rollback.includes('BẢN DIỄN TẬP') && !r.migration.includes('\r') && !r.rollback.includes('\r'),
    'bản diễn tập ghi rõ "BẢN DIỄN TẬP", LF')
  const numbered = fs.readdirSync(MIG).concat(fs.readdirSync(path.join(MIG, 'rollback'))).filter((f) => /cms_unit_t11/.test(f))
  ok(numbered.length === 0, 'repo KHÔNG có file datafix mang số (PM ghim số khi chốt release tổng)', numbered.join(', '))
  ok(r.guards.length === CMS_UNIT_T11_GUARDS.length && r.guards.every((g) => /^[0-9a-f]{32}$/.test(g.md5)), `md5 ${r.guards.length} hàm guard / 128 lấy từ định nghĩa cuối 120–128`)
}

// ── Tiện ích ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const AMOUNTS = [25000, 24525, 24750, 25000, 42800, 29700, 58455, 16965, 24115, 25000, 31410, 33255, 18000, 39650, 18000, 30000, 30600]
const KS = ['10', '20', '30', '60', '1', '90', '120', '180', '10', '20', '30', '10', '20', '30', '60', '10', '20']
const flat = (a) => [{ order: 1, from: 1, to: null, amount: String(a) }]

/** Bản ghim = kết quả câu PRE chỉ đọc scripts/cms-unit-t11/pre-pin.sql (UUID T11 thay bằng chương trình thử) — diễn tập cả câu PRE. */
const PRE_PIN_SQL = fs.readFileSync(path.join(HERE, 'cms-unit-t11', 'pre-pin.sql'), 'utf8')
async function pinFromDb(E, id) {
  const sql = PRE_PIN_SQL.split(CMS_UNIT_T11_ID).join(id)
  if (sql === PRE_PIN_SQL) throw new Error('pre-pin.sql không chứa UUID T11')
  const pin = (await E.one(sql)).pin
  return typeof pin === 'string' ? JSON.parse(pin) : pin
}
/** Vân tay để chứng minh "0 delta": mọi chương trình, SP, bậc, phạm vi, run, kết quả, marker, chế độ trigger. */
async function state(E) {
  return JSON.stringify(await E.one(`SELECT
      (SELECT md5(string_agg(to_jsonb(p)::text, ',' ORDER BY p.id)) FROM public.cms_programs p) progs,
      (SELECT md5(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id)) FROM public.cms_program_products x) prods,
      (SELECT md5(string_agg(to_jsonb(x)::text, ',' ORDER BY x.program_product_id, x.tier_order)) FROM public.cms_program_tiers x) tiers,
      (SELECT md5(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id)) FROM public.cms_sync_runs x) runs,
      (SELECT count(*)::int FROM public.cms_results) results, (SELECT count(*)::int FROM public.cms_payouts) payouts,
      (SELECT string_agg(version || ':' || name, ',' ORDER BY version) FROM public.app_migrations) marks,
      (SELECT string_agg(c.relname || '.' || t.tgname || '=' || t.tgenabled::text, ',' ORDER BY c.relname, t.tgname)
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal) trig`))
}
/** Tắt tạm ĐÚNG các trigger tên, chạy fn, bật lại ĐÚNG chế độ cũ (A ⇒ ALWAYS, O ⇒ origin), kiểm chế độ trả về như trước. */
async function withTriggersOff(E, table, names, fn) {
  const before = await E.all(`SELECT tgname, tgenabled::text e FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = ANY($2) ORDER BY 1`, [`public.${table}`, names])
  if (before.length !== names.length) throw new Error(`thiếu trigger ${table}: ${names}`)
  for (const t of before) await E.db.exec(`ALTER TABLE public.${table} DISABLE TRIGGER ${t.tgname}`)
  try { return await fn() } finally {
    for (const t of before) await E.db.exec(`ALTER TABLE public.${table} ENABLE ${t.e === 'A' ? 'ALWAYS ' : t.e === 'R' ? 'REPLICA ' : ''}TRIGGER ${t.tgname}`)
    const after = await E.all(`SELECT tgname, tgenabled::text e FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = ANY($2) ORDER BY 1`, [`public.${table}`, names])
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`trigger ${table} không về chế độ cũ`)
  }
}

async function main() {
  // ── §1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const E = await env('t11')
  const { db } = E
  section(`1. DB 128 + T11 giả lập (${E.label})`)
  await db.exec(buildCms128().migration)
  ok((await E.one(`SELECT name FROM public.app_migrations WHERE version = '128'`))?.name === 'cms_unit_quantity_basis', '128 THẬT áp trên DB 127')
  const products = AMOUNTS.map((a, i) => ({ pid: E.pid(), k: KS[i], unit: 'hộp', tiers: flat(a) }))
  const P = await E.makeProgram({ name: 'THẬT giả lập T11 (17 SP mức cố định)', isTest: false, products })
  const P2 = await E.makeProgram({ name: 'THẬT khác (không được đổi)', isTest: false, products: [{ pid: E.pid(), k: '10', tiers: flat(20000) }] })
  const Q = await E.makeProgram({ name: 'QA (không được đổi)', isTest: true, products: [{ pid: E.pid(), k: '10', tiers: flat(15000) }] })
  const [p1, p2, p3, p4, p5] = products.map((x) => x.pid)
  // Dòng bán thiết kế cho ma trận tác động (K POS khác nhau): không đổi · về 0 · giảm · TĂNG (B POS lệch quy cách) · chưa gán.
  const ROWS = E.rows(P, [
    { pid: p1, s: 0, uom: 'Hộp', qty: '2', base: 20 },                                      // K 10: cũ 2 · mới 2
    { pid: p2, s: 0, uom: 'Viên', qty: '45', base: 45 },                                    // K 20: cũ 2 · mới 0
    { pid: p1, s: 1, uom: 'Hộp', qty: '1', base: 10 }, { pid: p1, s: 1, uom: 'Viên', qty: '15', base: 15 }, // K 10: cũ 2 · mới 1
    { pid: p3, s: 2, uom: 'hộp', qty: '3', base: 60 },                                      // K 30, B POS 20 / hộp: cũ 2 · mới 3
    { pid: p5, s: 3, uom: 'HỘP', qty: '4', base: 4 },                                       // K 1: cũ 4 · mới 4 (khoá đơn vị hoa / thường)
    { pid: p4, out: true, uom: 'Hộp', qty: '5', base: 300 },                                // ngoài phạm vi
  ])
  const r0 = await E.sync(P, ROWS)
  await E.sync(P2, E.rows(P2, [{ pid: P2.products[0].pid, s: 0, uom: 'Hộp', qty: '3', base: 30 }]))
  await E.sync(Q, E.rows(Q, [{ pid: Q.products[0].pid, s: 0, uom: 'Hộp', qty: '1', base: 10 }]), { source: 'qa' })
  const old = await E.results(r0.runId)
  ok(r0.status === 'published' && r0.quantityBasis === 'pos_base' && (await E.prog(P.id)).ptr === r0.runId, 'T11 giả lập công bố theo pos_base (pointer = run)', JSON.stringify([r0.status, r0.code]))
  const oldQ = Object.fromEntries(old.map((r) => [`${r.u}|${r.pid}`, r.q]))
  ok(oldQ[`${SELLER_IDS[0]}|${p1}`] === '2' && oldQ[`${SELLER_IDS[0]}|${p2}`] === '2' && oldQ[`${SELLER_IDS[1]}|${p1}`] === '2' && oldQ[`${SELLER_IDS[2]}|${p3}`] === '2',
    'tiền trước datafix theo luật cũ floor(ΣB / K)', JSON.stringify(oldQ))
  const PIN = await pinFromDb(E, P.id)
  const gen = (o = {}) => buildCmsUnitT11({ pin: o.pin ?? PIN, version: o.version ?? 129, after: o.after ?? 128 })
  const G = gen()
  ok(G.pinned && !G.migration.includes('DIỄN TẬP'), 'bản ghim dựng từ DB (window_pinned + config_fp) ⇒ file như bản phát hành')
  {
    const fns = await E.fnMd5(CMS_UNIT_T11_GUARDS)
    const bad = G.guards.filter((g) => fns[g.name] !== g.md5).map((g) => g.name)
    ok(bad.length === 0, `md5 ${G.guards.length} hàm guard / 128 của generator = DB 128`, bad.join(', '))
    const trig = (await E.one(`SELECT string_agg(c.relname || '.' || t.tgname || '=' || t.tgenabled::text || ':' || p.proname, ' | ' ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C") s
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND c.relname IN ('cms_programs', 'cms_program_products', 'cms_program_tiers', 'cms_program_stores')`)).s
    ok(trig === CMS_UNIT_T11_TRIGGERS.join(' | '), '16 trigger bảng cấu hình (hằng generator) = DB 128', trig)
  }

  // ── §2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('2. Preflight dừng, 0 delta')
  const stopCase = async (label, sql, re, around = {}) => {
    const s0 = await state(E)
    if (around.before) await around.before()
    const r = await execFail(db, sql)
    if (around.after) await around.after()
    const s1 = await state(E)
    ok(!r.ok && re.test(r.err) && s0 === s1, `${label} ⇒ dừng, 0 delta`, r.ok ? 'KHÔNG chặn' : s0 !== s1 ? `delta! ${r.err.slice(0, 100)}` : r.err.slice(0, 140))
  }
  const pinWith = (fp, fpr = (x) => x) => { const x = JSON.parse(JSON.stringify(PIN)); fp(x.program); x.products = x.products.map(fpr); return x }
  await stopCase('UUID không có trong DB', gen({ pin: pinWith((g) => { g.id = '00000000-0000-4000-8000-00000000dead' }) }).migration, /không thấy chương trình/)
  await stopCase('config_version lệch ghim', gen({ pin: pinWith((g) => { g.config_version += 1 }) }).migration, /config_version .* ≠ bản ghim/)
  await stopCase('vân tay cấu hình lệch ghim', gen({ pin: pinWith((g) => { g.config_fp = '0'.repeat(32) }) }).migration, /vân tay cấu hình/)
  await stopCase('K một SP lệch ghim', gen({ pin: pinWith(() => {}, (p, i) => (i === 0 ? { ...p, base_quantity_cms: '999' } : p)) }).migration, /17 SP .* khác bản ghim/)
  await stopCase('mức một SP lệch ghim', gen({ pin: pinWith(() => {}, (p, i) => (i === 0 ? { ...p, amount: p.amount + 1 } : p)) }).migration, /bậc hiện tại khác 17 mức ghim/)
  await stopCase('chương trình KHÁC (P2 — không active giống ghim / không 17 SP)', gen({ pin: pinWith((g) => { g.id = P2.id }) }).migration, /config_version|vân tay|khác bản ghim|17 SP/)
  await stopCase('chương trình đã chốt (status locked)', G.migration, /khác bản ghim/, {
    before: () => withTriggersOff(E, 'cms_programs', ['cms_programs_lock_guard', 'cms_programs_guard', 'cms_config_auth_guard'],
      () => db.query(`UPDATE public.cms_programs SET status = 'locked', locked_at = now(), locked_by = $2 WHERE id = $1`, [P.id, U.super])),
    after: () => withTriggersOff(E, 'cms_programs', ['cms_programs_lock_guard', 'cms_programs_guard', 'cms_config_auth_guard'],
      () => db.query(`UPDATE public.cms_programs SET status = 'active', locked_at = NULL, locked_by = NULL WHERE id = $1`, [P.id])),
  })
  await stopCase('đã có payout', G.migration, /payout/, {
    before: () => withTriggersOff(E, 'cms_payouts', ['cms_payout_insert_guard'], () => db.query(`INSERT INTO public.cms_payouts (program_id, run_id, config_version,
        config_fp, mapping_fp, is_test, amount_vnd, staff_rows, staff_paid, candidate_lines, candidate_gmv, unassigned_lines, unassigned_gmv, policy, policy_version,
        ack_reason, run_started_at, source_complete_basis, source_complete_through, locked_by)
      SELECT p.id, r.id, p.config_version, public.cms__config_fp(p.id), r.mapping_fp, false, 0, 0, 0, 0, 0, 0, 0, '{}'::jsonb, 1, NULL, r.started_at, 'bi_watermark', p.end_date, $2
        FROM public.cms_programs p JOIN public.cms_sync_runs r ON r.id = p.current_result_run_id WHERE p.id = $1`, [P.id, U.super])
      .then((x) => { const n = x.affectedRows ?? x.rowCount; if (n !== 1) throw new Error('ca payout: chèn ' + n + ' dòng (cần 1)') })),
    after: () => withTriggersOff(E, 'cms_payouts', ['cms_payout_immutable'], () => db.query(`DELETE FROM public.cms_payouts WHERE program_id = $1`, [P.id])),
  })
  {
    // Race sync ↔ datafix: lượt đồng bộ đã MỞ run (running) ⇒ datafix dừng; run đóng ⇒ hết chặn.
    const open = await E.rpc(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [P.id, JSON.stringify({ source: 'operator' })])
    const runId = RS.parseCmsSalesSnapshot(open).runId
    await stopCase('lượt đồng bộ đang chạy (run running) — race sync ↔ datafix', G.migration, /run bán đang chạy/)
    await E.rpc(`SELECT public.rpc_cms_sales_run_finish($1, $2, $3::jsonb) r`, [runId, 'error', JSON.stringify({ error_code: 'QA_ABORT' })])
  }
  {
    // Khoá đơn vị hỏng ở SP: ghim dựng LẠI từ DB (chỉ khoá đơn vị sai) ⇒ dừng ở kiểm khoá; khôi phục.
    const pp0 = products[16]
    await db.query(`UPDATE public.cms_program_products SET unit_cms = $2 WHERE program_id = $1 AND product_id = $3`, [P.id, 'hộp\u0007', pp0.pid])
    const pinBad = await pinFromDb(E, P.id)
    await stopCase('ĐV tính CMS có ký tự điều khiển (khoá đơn vị không hợp lệ)', gen({ pin: pinBad }).migration, /khoá đơn vị hợp lệ/)
    await db.query(`UPDATE public.cms_program_products SET unit_cms = 'hộp' WHERE program_id = $1 AND product_id = $2`, [P.id, pp0.pid])
  }
  await stopCase('thiếu nền (số 131, nền 130 chưa có)', gen({ version: 131, after: 130 }).migration, /thiếu migration nền 130/)
  await stopCase('DB có số > nền', G.migration, /số > 128/, {
    before: () => db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('200', 'qa-t11')`),
    after: () => db.query(`DELETE FROM public.app_migrations WHERE version = '200'`),
  })
  await stopCase('trigger pointer 122 ở ALWAYS (khác chế độ duyệt)', G.migration, /trigger pointer 122/, {
    before: () => db.exec(`ALTER TABLE public.cms_programs ENABLE ALWAYS TRIGGER cms_programs_result_guard`),
    after: () => db.exec(`ALTER TABLE public.cms_programs ENABLE TRIGGER cms_programs_result_guard`),
  })
  // Như qa-cms-128: đặt mặc định phiên bằng lệnh RIÊNG (SET SESSION CHARACTERISTICS ghép chung chuỗi với BEGIN của file không có hiệu lực
  // trên PGlite) rồi kiểm chính mức cô lập trước khi chạy file — ca không được "đạt" vì không thật sự ở REPEATABLE READ.
  await stopCase('không READ COMMITTED', G.migration, /READ COMMITTED/, {
    before: async () => {
      await db.exec(`SET default_transaction_isolation = 'repeatable read'`)
      const iso = (await E.one(`SELECT current_setting('default_transaction_isolation') v`)).v
      if (iso !== 'repeatable read') throw new Error('ca READ COMMITTED: không đặt được repeatable read (' + iso + ')')
    },
    after: () => db.exec(`RESET default_transaction_isolation`),
  })
  await db.exec(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qa_t11_other') THEN CREATE ROLE qa_t11_other SUPERUSER; END IF; END $$`)
  await stopCase('role chạy không phải owner bảng / hàm CMS', `SET ROLE qa_t11_other;\n${G.migration}`, /owner bảng \/ hàm CMS khác role/, {
    after: () => db.exec(`RESET ROLE`),
  })
  {
    // Lỗi hậu kiểm SAU khi đã tắt trigger pointer + ghi ⇒ cả transaction huỷ, trigger về 'O', 0 delta.
    const broken = G.migration.split(`jsonb_array_length(v_cs -> 'products') <> 17`).join(`jsonb_array_length(v_cs -> 'products') <> 18`)
    if (broken === G.migration) throw new Error('không chèn được lỗi hậu kiểm')
    await stopCase('hậu kiểm hỏng sau khi đã tắt trigger + UPDATE (transaction huỷ, trigger về O)', broken, /hậu kiểm: snapshot cấu hình tính/)
  }
  // DB review P2 (09/11): nhánh preflight chưa có ca âm — guard cơ sở khác 'A', md5 thân guard lệch, trigger thừa trên bảng cấu hình,
  // marker 128 sai tên. Mỗi ca dựng điều kiện riêng rồi khôi phục; state() gồm chế độ trigger + marker ⇒ 0 delta là thật.
  await stopCase('guard đổi cơ sở 128 ở origin (O, khác ALWAYS)', G.migration, /guard đổi cơ sở 128 \(A\)/, {
    before: async () => {
      await db.exec(`ALTER TABLE public.cms_programs ENABLE TRIGGER cms_programs_basis_guard`)
      const e = (await E.one(`SELECT tgenabled::text e FROM pg_trigger WHERE tgrelid = 'public.cms_programs'::regclass AND tgname = 'cms_programs_basis_guard'`)).e
      if (e !== 'O') throw new Error('ca guard cơ sở: không về O (' + e + ')')
    },
    after: () => db.exec(`ALTER TABLE public.cms_programs ENABLE ALWAYS TRIGGER cms_programs_basis_guard`),
  })
  {
    // Thân một guard lệch 1 khoảng trắng (CREATE OR REPLACE giữ owner / ACL) ⇒ md5 khác bản duyệt ⇒ dừng; khôi phục đúng định nghĩa cũ.
    const sig = 'public.cms__basis_policy(text)'
    const def = (await E.one(`SELECT pg_get_functiondef($1::regprocedure) d`, [sig])).d
    const md5Of = async () => (await E.one(`SELECT md5(prosrc) m FROM pg_proc WHERE oid = $1::regprocedure`, [sig])).m
    const m0 = await md5Of()
    const drift = def.replace('AS $function$', 'AS $function$ ')
    if (drift === def) throw new Error('không chèn được khoảng trắng vào thân guard')
    await stopCase('thân hàm guard lệch bản duyệt (thêm 1 khoảng trắng)', G.migration, /thân hàm guard \/ 128/, {
      before: async () => { await db.exec(drift); if ((await md5Of()) === m0) throw new Error('ca md5 guard: thân không đổi') },
      after: async () => { await db.exec(def); if ((await md5Of()) !== m0) throw new Error('ca md5 guard: không khôi phục được thân') },
    })
  }
  await stopCase('trigger thừa trên bảng cấu hình (cms_program_stores)', G.migration, /trigger bảng cấu hình/, {
    before: () => db.exec(`CREATE FUNCTION public.qa_t11_noop() RETURNS trigger LANGUAGE plpgsql AS $q$ BEGIN RETURN NEW; END $q$;
      CREATE TRIGGER qa_t11_extra BEFORE UPDATE ON public.cms_program_stores FOR EACH ROW EXECUTE FUNCTION public.qa_t11_noop()`),
    after: () => db.exec(`DROP TRIGGER qa_t11_extra ON public.cms_program_stores; DROP FUNCTION public.qa_t11_noop()`),
  })
  await stopCase('marker 128 sai tên (capability không đúng)', G.migration, /thiếu capability 128/, {
    before: () => db.query(`UPDATE public.app_migrations SET name = 'qa_khac' WHERE version = '128'`),
    after: () => db.query(`UPDATE public.app_migrations SET name = 'cms_unit_quantity_basis' WHERE version = '128'`),
  })

  // ── §3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('3. Áp datafix (SỐ GIẢ LẬP 129 — chưa dành; nền 128)')
  const pre = { prog: await E.prog(P.id), others: await E.one(`SELECT md5(string_agg(to_jsonb(p)::text, ',' ORDER BY p.id)) m FROM public.cms_programs p WHERE p.id <> $1`, [P.id]),
    cfg: await E.one(`SELECT md5(COALESCE(string_agg(x, ',' ORDER BY x), '')) m FROM (SELECT to_jsonb(pp)::text x FROM public.cms_program_products pp WHERE pp.program_id = $1
      UNION ALL SELECT to_jsonb(t)::text FROM public.cms_program_tiers t WHERE t.program_id = $1 UNION ALL SELECT to_jsonb(s)::text FROM public.cms_program_stores s WHERE s.program_id = $1) o`, [P.id]),
    runs: await E.one(`SELECT md5(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id)) m, count(*)::int n FROM public.cms_sync_runs r`),
    results: await E.one(`SELECT count(*)::int n FROM public.cms_results`), fn: await E.one(`SELECT md5(string_agg(md5(prosrc) || coalesce(proacl::text, ''), ',' ORDER BY oid::regprocedure::text)) m FROM pg_proc WHERE pronamespace = 'public'::regnamespace`) }
  const ap = await execFail(db, G.migration)
  ok(ap.ok, 'datafix áp được', ap.ok ? '' : ap.err.slice(0, 200))
  const after = await E.prog(P.id)
  ok(after.qb === 'cms_unit' && after.v === pre.prog.v + 1 && after.ptr === null && after.status === 'active', 'cơ sở cms_unit · version + 1 · pointer NULL · vẫn active (atomically)', JSON.stringify([pre.prog, after]))
  ok((await E.one(`SELECT md5(COALESCE(string_agg(x, ',' ORDER BY x), '')) m FROM (SELECT to_jsonb(pp)::text x FROM public.cms_program_products pp WHERE pp.program_id = $1
      UNION ALL SELECT to_jsonb(t)::text FROM public.cms_program_tiers t WHERE t.program_id = $1 UNION ALL SELECT to_jsonb(s)::text FROM public.cms_program_stores s WHERE s.program_id = $1) o`, [P.id])).m === pre.cfg.m,
    '17 SP / 17 mức / K / phạm vi KHÔNG đổi')
  ok((await E.one(`SELECT md5(string_agg(to_jsonb(p)::text, ',' ORDER BY p.id)) m FROM public.cms_programs p WHERE p.id <> $1`, [P.id])).m === pre.others.m,
    'chương trình thật khác + QA KHÔNG đổi')
  const runsAfter = await E.one(`SELECT md5(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id)) m, count(*)::int n FROM public.cms_sync_runs r`)
  ok(runsAfter.m === pre.runs.m && (await E.one(`SELECT count(*)::int n FROM public.cms_results`)).n === pre.results.n, 'run / kết quả KHÔNG đổi (không xoá run cũ, không sửa tiền đã công bố)')
  ok((await E.runMeta(r0.runId)).qb === 'pos_base', 'run cũ giữ nhãn pos_base (bất biến)')
  ok((await E.one(`SELECT md5(string_agg(md5(prosrc) || coalesce(proacl::text, ''), ',' ORDER BY oid::regprocedure::text)) m FROM pg_proc WHERE pronamespace = 'public'::regnamespace`)).m === pre.fn.m,
    'hàm / ACL KHÔNG đổi')
  ok((await E.all(`SELECT tgname || '=' || tgenabled::text s FROM pg_trigger WHERE tgrelid = 'public.cms_programs'::regclass AND tgname IN ('cms_programs_result_guard', 'cms_programs_basis_guard') ORDER BY 1`)).map((x) => x.s).join(',')
    === 'cms_programs_basis_guard=A,cms_programs_result_guard=O', 'trigger pointer về O, guard cơ sở vẫn A')
  const mk = await E.one(`SELECT name, notes FROM public.app_migrations WHERE version = '129'`)
  const notes = mk ? JSON.parse(mk.notes) : {}
  ok(mk?.name === 'cms_unit_t11_basis' && notes.quantity_basis?.to === 'cms_unit' && notes.config_version?.to === pre.prog.v + 1 && notes.old_pointer === r0.runId && notes.pointer_cleared === true,
    'marker 129 + notes (cơ sở / version / pointer cũ, không PII)', JSON.stringify(notes).slice(0, 160))
  {
    const h = RV.parseCmsResultHeader(await E.header(P.id))
    ok(h.run === null && h.programBasis === 'cms_unit' && RV.cmsResultState(h) === 'basis_pending' && RV.cmsNoRunText(h) === RV.CMS_BASIS_PENDING_TEXT,
      'reader: "Chưa có số liệu theo cách tính mới" — không 0₫, không số luật cũ', JSON.stringify([h.run, h.programBasis, RV.cmsResultState(h)]))
  }
  await stopCase('chạy lại CÙNG file', G.migration, /đã có marker 129/)
  await stopCase('file số khác (130) trên chương trình đã cms_unit', gen({ version: 130, after: 129 }).migration, /đã ở cơ sở cms_unit/)

  // ── §4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('4. Tính lại toàn kỳ theo cms_unit · oracle độc lập · ma trận tác động')
  const off = await E.sync(P, ROWS, { flag: false })
  ok(off.status === 'held' && off.code === 'UNIT_BASIS_DISABLED' && (await E.prog(P.id)).ptr === null, 'cờ OFF ⇒ held UNIT_BASIS_DISABLED, pointer vẫn NULL (không lùi luật cũ)', JSON.stringify([off.status, off.code]))
  const r1 = await E.sync(P, ROWS)
  ok(r1.status === 'published' && r1.quantityBasis === 'cms_unit' && (await E.prog(P.id)).ptr === r1.runId, 'lượt tính mới (toàn kỳ, cùng nguồn) công bố theo cms_unit', JSON.stringify([r1.status, r1.code]))
  const neu = await E.results(r1.runId)
  {
    const o = OR.cmsUnitOracle({ start: P.start, end: P.end, storeIds: P.storeIds, catalogTarget: null,
      products: products.map((x) => ({ productId: x.pid, unitCms: 'hộp', gmvBasis: 'none', target: null, tiers: x.tiers })) }, ROWS, ORACLE_SELLERS)
    const diffs = []
    if (o.hold) diffs.push(`oracle HOLD ${JSON.stringify(o.hold)}`)
    for (const r of neu) {
      const x = o.pairs.get(`${r.u}|${r.pid}`)
      if (!x || x.q !== BigInt(r.q) || x.amount !== BigInt(r.amt)) diffs.push(`${r.pid}/${r.u.slice(-4)} DB ${r.q}/${r.amt} oracle ${x?.q}/${x?.amount}`)
    }
    if (o.pairs.size !== neu.length) diffs.push(`số cặp ${o.pairs.size} ≠ ${neu.length}`)
    ok(diffs.length === 0, 'mỗi cặp Q / tiền = oracle TS độc lập (không dùng engine)', diffs.join(' | '))
  }
  {
    const before = new Map(old.map((r) => [`${r.u}|${r.pid}`, r])), now = new Map(neu.map((r) => [`${r.u}|${r.pid}`, r]))
    const keys = [...new Set([...before.keys(), ...now.keys()])].sort()
    const m = { tang: [], giam: [], ve0: [], khongdoi: [] }
    for (const k of keys) {
      const a = BigInt(before.get(k)?.amt ?? '0'), b = BigInt(now.get(k)?.amt ?? '0')
      const row = `${k.split('|')[1]}/${k.split('|')[0].slice(-4)} ${a}→${b}`
      if (b === a) m.khongdoi.push(row); else if (b === 0n) m.ve0.push(row); else if (b > a) m.tang.push(row); else m.giam.push(row)
    }
    console.log(`    ma trận tác động: tăng ${m.tang.length} [${m.tang.join(', ')}] · giảm ${m.giam.length} [${m.giam.join(', ')}] · về 0 ${m.ve0.length} [${m.ve0.join(', ')}] · không đổi ${m.khongdoi.length}`)
    ok(m.tang.length === 1 && m.giam.length === 1 && m.ve0.length === 1 && m.khongdoi.length === 2,
      'ma trận đủ nhóm: tăng (B POS lệch quy cách) · giảm (trộn hộp + viên) · về 0 (chỉ viên) · không đổi (đúng hộp)', JSON.stringify(m))
    const sumA = old.reduce((s, r) => s + BigInt(r.amt), 0n), sumB = neu.reduce((s, r) => s + BigInt(r.amt), 0n)
    console.log(`    tổng: luật cũ ${sumA} → luật mới ${sumB} (Δ ${sumB - sumA})`)
    ok(String(sumB) === String((await E.runRow(r1.runId)).amt), 'tổng run mới = Σ cặp (không áp lại bậc)')
  }
  {
    const rows = RV.parseCmsResultRows(await E.rowsR(P.id, r1.runId))
    const h = RV.parseCmsResultHeader(await E.header(P.id))
    ok(h.run?.basis.basis === 'cms_unit' && rows.basis?.basis === 'cms_unit' && rows.units?.length === 17 && rows.results.every((r) => r.quantityBasis === 'cms_unit'),
      'reader: header / rows theo cơ sở run mới, ĐV theo snapshot run (17 SP)')
  }

  // ── §5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('5. Rollback bù')
  await stopCase('rollback khi version đã lệch sau datafix (ghim sai)', gen({ pin: pinWith((g) => { g.config_version -= 1 }) }).rollback, /config_version .* ≠/)
  const rb = await execFail(db, G.rollback)
  ok(rb.ok, 'rollback bù áp được', rb.ok ? '' : rb.err.slice(0, 200))
  const g5 = await E.prog(P.id)
  ok(g5.qb === 'pos_base' && g5.v === pre.prog.v + 2 && g5.ptr === null, 'về pos_base · version TĂNG tiếp (không hạ) · pointer NULL (không trỏ lại run cũ)', JSON.stringify(g5))
  ok(!(await E.one(`SELECT 1 x FROM public.app_migrations WHERE version = '129'`)) && (await E.runMeta(r1.runId)).qb === 'cms_unit' && (await E.runRow(r1.runId)).status === 'ok',
    'marker 129 xoá; run cms_unit GIỮ (metadata cms_unit, lịch sử đọc đúng luật)')
  await stopCase('áp lại CÙNG file datafix sau rollback', G.migration, /config_version .* ≠ bản ghim/)
  await stopCase('rollback chạy lại (không còn marker)', G.rollback, /thiếu marker 129/)
  const r2 = await E.sync(P, ROWS)
  const back = await E.results(r2.runId)
  ok(r2.status === 'published' && r2.quantityBasis === 'pos_base' && JSON.stringify(back.map((r) => [r.u, r.pid, r.q, r.amt])) === JSON.stringify(old.map((r) => [r.u, r.pid, r.q, r.amt])),
    'tính lại sau rollback theo pos_base = run trước datafix từng cặp', JSON.stringify([r2.status, r2.quantityBasis]))

  // ── §6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('6. Ghim mới sau rollback + dán CRLF (Studio)')
  const PIN2 = await pinFromDb(E, P.id)
  const G2 = buildCmsUnitT11({ pin: PIN2, version: 129, after: 128 })
  // 128 dán qua Studio (CRLF): dựng lại 9 hàm guard với thân có \r (CREATE OR REPLACE giữ owner / ACL) — md5 ghim phải bỏ \r (DB review P2).
  for (const g of G2.guards) {
    const sig = `public.${g.name}${g.sig}`
    await db.exec(CRLF((await E.one(`SELECT pg_get_functiondef($1::regprocedure) d`, [sig])).d))
  }
  const cr = (await E.one(`SELECT count(*) FILTER (WHERE position(E'\\r' IN prosrc) > 0)::int n FROM pg_proc WHERE oid = ANY($1::regprocedure[])`,
    [G2.guards.map((g) => `public.${g.name}${g.sig}`)])).n
  const a2 = await execFail(db, CRLF(G2.migration))
  const g6 = await E.prog(P.id)
  ok(cr === G2.guards.length && a2.ok && g6.qb === 'cms_unit' && g6.v === pre.prog.v + 3 && g6.ptr === null,
    `ghim mới (version tăng tiếp) + ${cr}/${G2.guards.length} thân guard có \\r (128 dán CRLF) + datafix dán CRLF ⇒ áp được (md5 thân bỏ \\r)`, a2.ok ? JSON.stringify({ cr, ...g6 }) : a2.err.slice(0, 160))
  const b2 = await execFail(db, CRLF(G2.rollback))
  ok(b2.ok && (await E.prog(P.id)).qb === 'pos_base', 'rollback dán CRLF ⇒ áp được', b2.ok ? '' : b2.err.slice(0, 160))
  return E
}

async function pg15Race(E) {
  section('7. (PG15) race khoá thật')
  const { db } = E
  const P = (await E.one(`SELECT id::text FROM public.cms_programs WHERE name = 'THẬT giả lập T11 (17 SP mức cố định)'`)).id
  const PIN = await pinFromDb(E, P)
  const G = buildCmsUnitT11({ pin: PIN, version: 129, after: 128 })
  const c2 = await E.conn()
  const s0 = await state(E)
  await c2.query('BEGIN'); await c2.query(`SELECT 1 FROM public.cms_programs WHERE id = $1 FOR UPDATE`, [P])
  const t = Date.now()
  const r = await execFail(db, G.migration)
  await c2.query('ROLLBACK')
  ok(!r.ok && /lock timeout|canceling statement due to lock timeout/i.test(r.err) && (await state(E)) === s0 && Date.now() - t < 15000,
    'giao dịch khác giữ khoá dòng chương trình ⇒ datafix hết lock_timeout 5 s, 0 delta', r.ok ? 'KHÔNG chặn' : r.err.slice(0, 120))
  // Datafix (mô phỏng) đang giữ EXCLUSIVE ⇒ lượt đồng bộ mở run phải chờ rồi lỗi; không để lại run 'running'.
  await c2.query('BEGIN'); await c2.query(`LOCK TABLE public.cms_programs IN EXCLUSIVE MODE`)
  await db.query(`SET statement_timeout = '8s'`)
  const o = await settle(E.rpc(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [P, JSON.stringify({ source: 'operator' })]))
  await db.query(`SET statement_timeout = 0`)
  await c2.query('ROLLBACK')
  ok(!o.ok && !(await E.one(`SELECT 1 x FROM public.cms_sync_runs WHERE program_id = $1 AND status = 'running'`, [P])),
    'datafix giữ khoá ⇒ mở run chờ rồi lỗi, không run running rơi vãi', o.ok ? 'mở được' : o.err.slice(0, 120))
  const r2 = await execFail(db, G.migration)
  ok(r2.ok && (await E.prog(P)).qb === 'cms_unit', 'nhả khoá ⇒ datafix áp được')
}

let rc = 0
try {
  const E = await main()
  if (PG15) await pg15Race(E)
} catch (e) {
  fail++; console.log(`  ✗ LỖI KHÔNG BẮT: ${e?.stack ?? e}`)
} finally {
  await ENV.closeAll()
}
console.log(`\nQA datafix T11 CMS-UNIT: ${pass} đạt / ${fail} lỗi`)
rc = fail ? 1 : 0
process.exitCode = rc
if (PG15) process.exit(rc)
