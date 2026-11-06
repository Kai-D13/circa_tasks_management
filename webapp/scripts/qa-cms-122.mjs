// QA migration 122 (CMS P2-b) trên PGlite (Postgres 16 WASM): nền 114–116 (lib-care-pglite) + 120 + 121 + 122.
// Đầu-cuối bằng engine THẬT (lib/cms/engine) + bộ dựng payload THẬT (lib/cms/resultStage.ts) nạp qua jiti:
// open → stage (khối nhỏ) → seal → publish → đọc theo vai. Gồm: ma trận ACL, open (nháp / chưa bắt đầu / bận / treo /
// đã chốt), stage idempotent / xung đột / sai dạng, seal bắt từng loại giả mạo (đủ khối, thứ tự, kỳ / phạm vi, mapping,
// liên kết, cấu hình, tổng nhóm, F(Q), gate SP / danh mục, phân bổ dòng, tổng tiền), publish (lỗi thời cấu hình / mapping,
// gọi lại, chưa seal, đã chốt), trigger pointer, đọc theo phạm vi HIỆN TẠI + marker QA, ghim run khi có run mới, dọn dữ
// liệu, rollback. KHÔNG chạm DB thật.
//   npm i --no-save @electric-sql/pglite@0.2.17     # một lần, trong webapp/
//   node scripts/qa-cms-122.mjs                     # kỳ vọng: N đạt · 0 lỗi
// GIỚI HẠN: PGlite một session ⇒ không tái lập race 2 kết nối; race chạy ở PG15 thật
// (planning/research/dev-tools/cms/122-realpg-race.mjs).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import * as L from './lib-care-pglite.mjs'
import { cmsLegacy } from './lib-cms-legacy.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const SQL_120 = fs.readFileSync(path.join(MIG, '120_cms_foundation.sql'), 'utf8')
const SQL_121 = fs.readFileSync(path.join(MIG, '121_cms_import_activation.sql'), 'utf8')
const SQL_122 = fs.readFileSync(path.join(MIG, '122_cms_results.sql'), 'utf8')
const RB_122 = fs.readFileSync(path.join(MIG, 'rollback', '122_cms_results_rollback.sql'), 'utf8')

let PGlite
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch {
  console.error('FAIL: thiếu @electric-sql/pglite — chạy: npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
  process.exit(2)
}
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@': path.join(HERE, '..') } })
const E = await jiti.import(path.join(HERE, '..', 'lib', 'cms', 'engine', 'compute.ts'))
const RS = await jiti.import(path.join(HERE, '..', 'lib', 'cms', 'resultStage.ts'))
const C = await jiti.import(path.join(HERE, '..', 'lib', 'cms', 'source', 'contract.ts'))
// CMS-UNCAPPED-1 (CMS-Q-220): engine hiện hành chỉ nhận bậc cuối không giới hạn. Ca LỊCH SỬ (seal SQL 122 vẫn nhận payload có trần
// của app trước CMS-Q-220 — run cũ) dựng bằng engine CŨ git 60a2231 (scripts/lib-cms-legacy.mjs), không bằng engine mới.
const LEG = cmsLegacy()
if (!LEG.isLegacy) { console.error('FAIL: app cũ không phải bản trước CMS-Q-220'); process.exit(2) }
const E_OLD = await LEG.load('lib/cms/engine/compute.ts')

const bail = (e) => {
  const where = e?.where ? `\n  where: ${String(e.where).split('\n').slice(-2).join(' | ')}` : ''
  console.error(`\nLỖI NGOÀI DỰ KIẾN: ${e?.message ?? e}${where}`)
  process.exit(1)
}
process.on('uncaughtException', bail)
process.on('unhandledRejection', bail)
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${extra}`) } }
const section = (s) => console.log(`\n${s}`)
const { U, uid, storeId, staffId, S_FS, STORES, one, count, as } = L
let lastErr = ''
async function raises(db, p, needle) {
  try { await p } catch (e) {
    lastErr = String(e?.message ?? e)
    await db.exec('ROLLBACK').catch(() => {})
    return needle ? lastErr.includes(needle) : true
  }
  lastErr = 'KHÔNG raise'
  return false
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

const FNS_SVC = ['rpc_cms_sales_snapshot(uuid)', 'rpc_cms_sales_run_open(uuid, jsonb)', 'rpc_cms_sales_run_stage(uuid, text, integer, jsonb)',
  'rpc_cms_sales_run_seal_begin(uuid, jsonb)', 'rpc_cms_sales_run_seal_step(uuid, integer)', 'rpc_cms_sales_run_publish(uuid)',
  'rpc_cms_sales_run_finish(uuid, text, jsonb)',
  'rpc_cms_sales_run_cleanup(uuid, integer)']
const FNS_READ = ['rpc_cms_result_header(uuid)', 'rpc_cms_result_rows(uuid, uuid)',
  'rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer)', 'rpc_cms_result_excluded(uuid, uuid, integer, integer)']
const FNS_HELP = ['cms__str(jsonb, text, text)', 'cms__str_or_null(jsonb, text, text)', 'cms__ts(timestamptz)', 'cms__norm_email(text)',
  'cms__mapping_fp()', 'cms__sales_snapshot(uuid)', 'cms__seal_fail(uuid, text, text)', 'cms__visible_result_users()',
  'cms__result_run(uuid, uuid)', 'cms__programs_result_guard()', 'cms__results_release_open()']

/** Seal tách bước (122 r2): begin rồi bước 1…10; dừng ở phản hồi thất bại đầu tiên (DB đã đóng run). */
async function sealAll(svcFn, runId, expect) {
  const b = (await svcFn(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb) r`, [runId, JSON.stringify(expect)])).rows[0].r
  if (!b.ok) return b
  for (let i = 1; i <= 10; i++) {
    const r = (await svcFn(`SELECT public.rpc_cms_sales_run_seal_step($1, $2) r`, [runId, i])).rows[0].r
    if (r.sealed || !r.ok) return r
  }
  return { sealed: false, code: 'SEAL_INCOMPLETE' }
}
/** Mô phỏng migration mở cổng Q-206 trong DB QA (prod: cổng đóng tới khi Q-206 chốt). */
const RELEASE_OPEN_SQL = `CREATE OR REPLACE FUNCTION public.cms__results_release_open() RETURNS boolean LANGUAGE sql IMMUTABLE
  SECURITY DEFINER SET search_path = public AS $$ SELECT true $$;
  REVOKE ALL ON FUNCTION public.cms__results_release_open() FROM PUBLIC, anon, authenticated, service_role;`

const PIDS = { none: '910001', prod: '910002', catA: '910003', catB: '910004', out: '910099' }
// CMS-Q-220: bậc cuối không giới hạn (trước đây 3–4 = trần 4 — ca có trần chuyển thành ca lịch sử §4c, engine cũ).
const T_NONE = [{ order: 1, from: 1, to: 2, amount: '15000' }, { order: 2, from: 3, to: null, amount: '20000' }]
const T_CAP_LEGACY = [{ order: 1, from: 1, to: 2, amount: '15000' }, { order: 2, from: 3, to: 4, amount: '20000' }]   // trần 4 (luật cũ)
const T_ONE = [{ order: 1, from: 1, to: null, amount: '10000' }]

async function baseDb() {
  const db = await L.freshDb(PGlite)
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t') ON CONFLICT DO NOTHING`)
  await db.exec(SQL_120)
  await db.exec(SQL_121)
  await db.exec(SQL_122)
  await db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at)
    SELECT g::text, 'SP giả ' || g, true, now() FROM generate_series(910001, 910120) g`)
  return db
}

const svcOf = (db) => (sql, params = []) => as(db, null, () => db.query(sql, params), 'service_role')
async function vnToday(db) { return (await one(db, `SELECT public.cms__vn_today()::text d`)).d }
const dayFrom = (today) => (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

/** Tạo + nạp + kích hoạt chương trình qua RPC 121 (start trong quá khứ ⇒ đã bắt đầu). */
async function makeProgram(db, { isTest = false, stores = [storeId(1), storeId(2)], start = -10, end = 20, products } = {}) {
  const svc = svcOf(db)
  const day = dayFrom(await vnToday(db))
  const id = (await svc(`SELECT public.rpc_cms_program_save($1::jsonb) id`, [JSON.stringify({
    actor: U.super, name: 'QA CMS 122', start_date: day(start), end_date: day(end), scope: 'stores', store_ids: stores, is_test: isTest })])).rows[0].id
  const prods = products ?? [
    { product_id: PIDS.none, gmv_basis: 'none', target_gmv: null, base_quantity_cms: '24', tiers: T_NONE },
    { product_id: PIDS.prod, gmv_basis: 'product', target_gmv: '100000', base_quantity_cms: '1', tiers: T_ONE },
    { product_id: PIDS.catA, gmv_basis: 'catalog', target_gmv: null, base_quantity_cms: '0.5', tiers: T_ONE },
    { product_id: PIDS.catB, gmv_basis: 'catalog', target_gmv: null, base_quantity_cms: '1', tiers: T_ONE },
  ]
  const payload = { mode: 'replace', catalog_target: prods.some((p) => p.gmv_basis === 'catalog') ? '150000' : null,
    products: prods.map((p) => ({ unit_cms: 'hộp', advice_text: 'Tư vấn QA', name_snapshot: 'SP giả', image_url_snapshot: null, price_snapshot: null, ...p })) }
  const fileSha = sha(`f-${id}`), digest = sha(`d-${id}`)
  const run = (await svc(`SELECT public.rpc_cms_import_preview_save($1::jsonb) id`, [JSON.stringify({ program_id: id, mode: 'replace',
    file_name: 'qa.xlsx', file_sha256: fileSha, file_bytes: 1000, actor: U.super, stats: { rowsTotal: 1, rowsOk: 1, rowsRejected: 0, warnings: 0, productsOk: 1, productsRejected: 0 },
    result: { digest } })])).rows[0].id
  await svc(`SELECT public.rpc_cms_import_commit($1, $2, $3, $4::jsonb, $5)`, [run, fileSha, digest, JSON.stringify(payload), U.super])
  await svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [id, U.super])
  return id
}

// ── Dòng bán giả (dạng nguồn chuẩn hoá) ──
const EA = STORES[0].assigneeEmails[0], EB = STORES[0].assigneeEmails[1], EC = STORES[1].assigneeEmails[0]
const E3 = STORES[2].assigneeEmails[0]                       // staff store 3: ngoài phạm vi chương trình (store 1, 2)
let lineSeq = 0
function rawLine(o) {
  lineSeq++
  return {
    order_line_id: o.id ?? String(700000 + lineSeq), order_id: o.order ?? `O${lineSeq}`, order_code: o.code ?? `QAOS-${lineSeq}`,
    product_id: o.pid, seller_email: o.email === undefined ? EA : o.email, pos_code: 'QAOS01', order_type: o.type ?? 'OFFLINE',
    order_status: o.status ?? 'COMPLETED', completed_at: o.at, quantity_raw: '1', uom_raw: 'Hộp', base_quantity: o.bq,
    gmv_amount: o.gmv, source_updated_at: o.at,
  }
}
function linesFor(today) {
  lineSeq = 0
  const d = (n, hh = '03') => `${dayFrom(today)(n)}T${hh}:00:00.000001Z`
  const raws = [
    // A: SP none — 30 + 30 + 60 viên / K 24 ⇒ Q 1 → 2 → 5 (bậc cuối không giới hạn — CMS-Q-220)
    rawLine({ pid: PIDS.none, bq: '30', gmv: '30000', at: d(-9) }),
    rawLine({ pid: PIDS.none, bq: '30', gmv: '30000', at: d(-8) }),
    rawLine({ pid: PIDS.none, bq: '60', gmv: '60000', at: d(-7) }),
    // A: SP product target 100.000 — 60.000 rồi 50.000 (đạt ở dòng 2), trả −20.000 (tụt), 30.000 (đạt lại)
    rawLine({ pid: PIDS.prod, bq: '2', gmv: '60000', at: d(-6) }),
    rawLine({ pid: PIDS.prod, bq: '1', gmv: '50000', at: d(-5) }),
    rawLine({ pid: PIDS.prod, bq: '-1', gmv: '-20000', at: d(-4) }),
    rawLine({ pid: PIDS.prod, bq: '1', gmv: '30000', at: d(-3) }),
    // A + B: danh mục target 150.000 (A đạt, B không)
    rawLine({ pid: PIDS.catA, bq: '3', gmv: '90000', at: d(-6, '05') }),
    rawLine({ pid: PIDS.catB, bq: '2', gmv: '70000', at: d(-5, '05') }),
    rawLine({ pid: PIDS.catA, email: EB, bq: '1.5', gmv: '40000', at: d(-6, '06') }),
    // C (store 2): SP none 48 viên ⇒ Q 2
    rawLine({ pid: PIDS.none, email: EC.toUpperCase(), bq: '48', gmv: '48000', at: d(-2) }),
    // Không ứng viên: ONLINE, chưa hoàn tất, ngoài kỳ, SP ngoài chương trình
    rawLine({ pid: PIDS.none, type: 'ONLINE', bq: '24', gmv: '24000', at: d(-2, '07') }),
    rawLine({ pid: PIDS.none, status: 'CANCELLED', bq: '24', gmv: '24000', at: d(-2, '08') }),
    rawLine({ pid: PIDS.none, bq: '24', gmv: '24000', at: d(-30) }),
    rawLine({ pid: PIDS.out, bq: '24', gmv: '24000', at: d(-2, '09') }),
    // Ứng viên bị loại: ngoài phạm vi (store 3), chưa gán (email lạ / QLCH / FS / không email)
    rawLine({ pid: PIDS.none, email: E3, bq: '24', gmv: '24000', at: d(-2, '10') }),
    rawLine({ pid: PIDS.none, email: 'ai.do@example.invalid', bq: '24', gmv: '24000', at: d(-2, '11') }),
    rawLine({ pid: PIDS.none, email: 'qa.qlch1@example.invalid', bq: '24', gmv: '24000', at: d(-2, '12') }),
    rawLine({ pid: PIDS.none, email: 'qa.stafffs@example.invalid', bq: '24', gmv: '24000', at: d(-2, '13') }),
    rawLine({ pid: PIDS.none, email: null, bq: '24', gmv: '24000', at: d(-2, '14') }),
  ]
  return raws.map((r) => { const n = C.normalizeSalesRow(r); if (!n.ok) throw new Error('fixture dòng lỗi ' + JSON.stringify(n.issues)); return n.value })
}

/** Một lượt đầy đủ: open → engine → payload → (tamper) → stage → seal → (publish). */
async function runOnce(db, programId, { lines, tamper, publish = true, chunkSize = 3, skipChunk = null, expectTamper, engine = E } = {}) {
  const svc = svcOf(db)
  const snapRaw = (await svc(`SELECT public.rpc_cms_sales_run_open($1, '{"source":"qa"}'::jsonb) s`, [programId])).rows[0].s
  const snap = RS.parseCmsSalesSnapshot(snapRaw)
  const input = RS.cmsSnapshotToEngineInput(snap)
  const ls = lines ?? linesFor(snap.todayVn)
  const out = engine.computeCmsProgram({ program: input.program, lines: ls, sellers: input.sellers })
  const payload = RS.buildCmsStagePayload(snap, ls, out, { rowsRead: ls.length, rowsRejected: 0, bytesProcessed: 1234, chunkSize })
  if (tamper) tamper(payload)
  if (expectTamper) expectTamper(payload.expect)
  for (const part of RS.CMS_STAGE_PARTS) {
    const chunks = RS.chunkCmsStageRows(payload.parts[part], chunkSize)
    for (let i = 0; i < chunks.length; i++) {
      if (skipChunk && skipChunk.part === part && skipChunk.no === i) continue
      const n = (await svc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb) n`, [snap.runId, part, i, JSON.stringify(chunks[i])])).rows[0].n
      if (n !== chunks[i].length) throw new Error('stage count')
    }
  }
  const seal = await sealAll(svc, snap.runId, payload.expect)
  let pub = null
  if (publish && seal.sealed) pub = (await svc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [snap.runId])).rows[0].r
  return { runId: snap.runId, snap, out, payload, seal, pub }
}
const runRow = (db, id) => one(db, `SELECT * FROM public.cms_sync_runs WHERE id = $1`, [id])
const pointer = async (db, pid) => (await one(db, `SELECT current_result_run_id p FROM public.cms_programs WHERE id = $1`, [pid])).p

// ════════════════════════════════════════════════════════════════════════════
section('1. Preflight / marker')
{
  const db = await L.freshDb(PGlite)
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t')`)
  await db.exec(SQL_120)
  ok(await raises(db, db.exec(SQL_122), 'thiếu migration nền 121'), 'chưa có 121 ⇒ dừng')
  await db.exec(SQL_121)
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('123', 't')`)
  ok(await raises(db, db.exec(SQL_122), 'migration số > 122'), 'đã có 123 ⇒ dừng')
  await db.query(`DELETE FROM public.app_migrations WHERE version = '123'`)
  await db.query(`INSERT INTO public.cms_sync_runs (kind, status, finished_at, error_code) VALUES ('products', 'error', now(), 'X')`)
  await db.exec(SQL_122)
  ok((await one(db, `SELECT name FROM public.app_migrations WHERE version = '122'`))?.name === 'cms_results', 'áp được trên DB có run products cũ; marker 122 = cms_results')
  ok(await raises(db, db.exec(SQL_122), 'đã có marker 122'), 'chạy lại ⇒ dừng')
}

const db = await baseDb()
const svc = svcOf(db)
const TODAY = await vnToday(db)
const day = dayFrom(TODAY)

section('2. Ma trận ACL (23 hàm)')
const fnAcl = async (f) => one(db, `SELECT has_function_privilege('anon', 'public.${f}', 'EXECUTE') a, has_function_privilege('authenticated', 'public.${f}', 'EXECUTE') u,
  has_function_privilege('service_role', 'public.${f}', 'EXECUTE') s, has_function_privilege('dashboard_qa', 'public.${f}', 'EXECUTE') d`)
for (const f of FNS_SVC) { const r = await fnAcl(f); ok(!r.a && !r.u && r.s && !r.d, `${f}: chỉ service_role`, JSON.stringify(r)) }
for (const f of FNS_READ) { const r = await fnAcl(f); ok(!r.a && r.u && !r.s && !r.d, `${f}: chỉ authenticated`, JSON.stringify(r)) }
for (const f of FNS_HELP) { const r = await fnAcl(f); ok(!r.a && !r.u && !r.s && !r.d, `${f}: không cấp ai`, JSON.stringify(r)) }
for (const t of ['cms_sync_run_chunks', 'cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_result_lines']) {
  const r = await one(db, `SELECT has_table_privilege('anon', 'public.${t}', 'SELECT') a, has_table_privilege('authenticated', 'public.${t}', 'SELECT') u,
    has_table_privilege('service_role', 'public.${t}', 'INSERT') s, (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.${t}'::regclass) rls`)
  ok(!r.a && !r.u && r.s && r.rls, `${t}: RLS bật, anon / authenticated không quyền`, JSON.stringify(r))
}
ok(await raises(db, as(db, U.super, () => db.query(`SELECT public.rpc_cms_sales_run_open($1, '{}'::jsonb)`, [uid(1)])), 'permission denied'), 'authenticated (super) gọi open ⇒ từ chối')
ok(await raises(db, as(db, null, () => db.query(`SELECT public.rpc_cms_result_header($1)`, [uid(1)]), 'anon'), 'permission denied'), 'anon gọi đọc ⇒ từ chối')
ok(await raises(db, as(db, U.A, () => db.query(`SELECT * FROM public.cms_results`)), 'permission denied'), 'staff SELECT bảng kết quả trực tiếp ⇒ từ chối')
ok(await raises(db, as(db, U.super, () => db.query(`SELECT * FROM public.cms_sync_runs`)), 'permission denied'), 'super SELECT cms_sync_runs trực tiếp ⇒ từ chối (như 120)')

section('3. Open — trạng thái / ngày / bận / treo')
const P = await makeProgram(db)
{
  const draft = (await svc(`SELECT public.rpc_cms_program_save($1::jsonb) id`, [JSON.stringify({ actor: U.super, name: 'nháp', start_date: day(-5), end_date: day(5), scope: 'all', is_test: false })])).rows[0].id
  ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_open($1)`, [draft]), 'CMS_SALES_PROGRAM_NOT_ACTIVE'), 'nháp ⇒ CMS_SALES_PROGRAM_NOT_ACTIVE', lastErr)
  const future = await makeProgram(db, { start: 3, end: 30, products: [{ product_id: '910050', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '1', tiers: T_ONE }] })
  ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_open($1)`, [future]), 'CMS_SALES_NOT_STARTED'), 'chưa bắt đầu (ngày VN) ⇒ CMS_SALES_NOT_STARTED', lastErr)
  ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_open($1)`, [uid(4242)]), 'CMS_PROGRAM_NOT_FOUND'), 'không tồn tại ⇒ NOT_FOUND')
  ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_open($1, '[]'::jsonb)`, [P]), 'CMS_SYNC_BAD_DETAIL'), 'detail không phải object ⇒ BAD_DETAIL')
  const s1 = (await svc(`SELECT public.rpc_cms_sales_run_open($1) s`, [P])).rows[0].s
  const cv = (await one(db, `SELECT config_version FROM public.cms_programs WHERE id = $1`, [P])).config_version
  ok(!!s1.run_id && s1.config_version === cv && s1.products.length === 4 && s1.sellers.length > 50 && /^[0-9a-f]{32}$/.test(s1.mapping_fp), 'open trả run_id + snapshot (config_version, 4 SP, sellers, vân tay)', JSON.stringify({ v: s1.config_version, n: s1.products?.length }))
  ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_open($1)`, [P]), 'CMS_SYNC_BUSY'), 'đang có run running ⇒ CMS_SYNC_BUSY')
  await db.query(`UPDATE public.cms_sync_runs SET started_at = now() - interval '31 minutes' WHERE id = $1`, [s1.run_id])
  ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_stage($1, 'results', 0, '[{}]'::jsonb)`, [s1.run_id]), 'CMS_SYNC_RUN_STALE'), 'stage vào run > 30′ ⇒ CMS_SYNC_RUN_STALE')
  const s2 = (await svc(`SELECT public.rpc_cms_sales_run_open($1) s`, [P])).rows[0].s
  const r1 = await runRow(db, s1.run_id)
  ok(r1.status === 'error' && r1.error_code === 'STALE' && !!s2.run_id, 'run treo > 30′ ⇒ error STALE, mở run mới được')
  await svc(`SELECT public.rpc_cms_sales_run_finish($1, 'error', '{"error_code":"QA_ABORT"}'::jsonb)`, [s2.run_id])
  ok((await runRow(db, s2.run_id)).error_code === 'QA_ABORT', 'finish error với mã')
  ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_finish($1, 'error', '{"error_code":"QA"}'::jsonb)`, [s2.run_id]), 'CMS_SYNC_RUN_NOT_RUNNING'), 'finish lần 2 ⇒ NOT_RUNNING')
  ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_finish($1, 'ok', '{"error_code":"X"}'::jsonb)`, [s2.run_id]), 'CMS_SYNC_BAD_STATUS'), "finish 'ok' ⇒ BAD_STATUS (chỉ publish mới ok)")
  const snap = (await svc(`SELECT public.rpc_cms_sales_snapshot($1) s`, [P])).rows[0].s
  ok(snap.run_id === undefined && snap.config_version === cv, 'rpc_cms_sales_snapshot: chỉ đọc, không mở run')
  ok(await count(db, `SELECT count(*) FROM public.cms_sync_runs WHERE program_id = '${P}' AND status = 'running'`) === 0, 'snapshot không tạo run running')
}

section('4. Lượt đầy đủ: stage → seal → publish (kết quả = engine)')
// Cổng Q-206 ở DB (cms__results_release_open = false): chương trình thật seal được nhưng KHÔNG công bố.
{
  const g = await runOnce(db, P)
  ok(g.seal.sealed === true && g.pub?.published === false && g.pub.code === 'RESULTS_RELEASE_GATE' && await pointer(db, P) === null
     && (await runRow(db, g.runId)).status === 'held',
     'Q-206 cổng DB đóng: chương trình thật ⇒ publish held RESULTS_RELEASE_GATE, pointer vẫn null', JSON.stringify(g.pub))
}
// Từ đây mô phỏng migration mở cổng (chỉ DB QA) để kiểm đường công bố / đọc của chương trình thật trong tương lai.
await db.exec(RELEASE_OPEN_SQL)
const R1 = await runOnce(db, P)
{
  ok(R1.seal.sealed === true, 'seal đạt', JSON.stringify(R1.seal))
  ok(R1.pub?.published === true && R1.pub.already === false, 'publish đạt', JSON.stringify(R1.pub))
  ok(await pointer(db, P) === R1.runId, 'pointer = run vừa công bố')
  const r = await runRow(db, R1.runId)
  ok(r.status === 'ok' && r.published_at && r.sealed_at && String(r.amount_vnd) === R1.out.totals.amountVnd.toString(), 'run ok, amount_vnd = tổng engine', `${r.amount_vnd} vs ${R1.out.totals.amountVnd}`)
  ok(await count(db, `SELECT count(*) FROM public.cms_sales_lines WHERE run_id = '${R1.runId}'`) === R1.payload.parts.sales_lines.length, 'số dòng ứng viên khớp payload')
  const t = R1.out.totals
  ok(t.included === 11 && t.unassigned === 4 && t.outOfScope === 1, 'engine: 11 INCLUDED · 4 chưa gán · 1 ngoài phạm vi', JSON.stringify({ i: t.included, u: t.unassigned, o: t.outOfScope }))
  ok(await count(db, `SELECT count(*) FROM public.cms_sales_lines WHERE run_id = '${R1.runId}' AND disposition = 'UNASSIGNED'`) === 4, 'DB: 4 dòng UNASSIGNED (NOT_FOUND / SHARED_ACCOUNT / STORE_NOT_ELIGIBLE / NO_EMAIL)')
  const exc = R1.payload.expect.totals.excluded_by_reason
  ok(exc.ORDER_NOT_ELIGIBLE === 2 && exc.OUT_OF_WINDOW === 1 && exc.PRODUCT_NOT_IN_PROGRAM === 1, 'dòng không ứng viên chỉ đếm theo lý do (không lưu)', JSON.stringify(exc))
  // A × SP none: 120 viên / 24 = 5 ⇒ bậc cuối không giới hạn (CMS-Q-220) ⇒ 15000·2 + 20000·3 = 90000 (không dừng ở mốc 4 cũ)
  const aNone = await one(db, `SELECT r.* FROM public.cms_results r JOIN public.cms_program_products pp ON pp.id = r.program_product_id WHERE r.run_id = $1 AND r.user_id = $2 AND pp.product_id = $3`, [R1.runId, U.A, PIDS.none])
  ok(aNone && aNone.cms_quantity === 5 && aNone.rewarded_quantity === 5 && aNone.cap_quantity === null && aNone.at_cap === false && Number(aNone.amount_vnd) === 90000,
    'A × SP none: Q 5, hưởng 5 (không trần), 90.000đ', JSON.stringify(aNone && { q: aNone.cms_quantity, rw: aNone.rewarded_quantity, cap: aNone.cap_quantity, a: aNone.amount_vnd }))
  const aProd = await one(db, `SELECT r.*, public.cms__ts(r.gate_met_at) mt FROM public.cms_results r JOIN public.cms_program_products pp ON pp.id = r.program_product_id WHERE r.run_id = $1 AND r.user_id = $2 AND pp.product_id = $3`, [R1.runId, U.A, PIDS.prod])
  ok(aProd && aProd.gate_met === true && aProd.mt === `${day(-3)}T03:00:00.000001Z`, 'A × SP product: tụt rồi đạt lại ⇒ "đạt từ" = lần chuyển gần nhất (Q-211)', JSON.stringify(aProd && { m: aProd.gate_met, t: aProd.mt }))
  const cat = (await db.query(`SELECT user_id, met FROM public.cms_result_catalog WHERE run_id = $1 ORDER BY user_id`, [R1.runId])).rows
  ok(cat.length === 2 && cat.find((c) => c.user_id === U.A)?.met === true && cat.find((c) => c.user_id === U.B)?.met === false, 'gate danh mục: A đạt, B chưa đạt')
  const lineSum = await one(db, `SELECT sum(amount_vnd)::text s FROM public.cms_result_lines WHERE run_id = $1`, [R1.runId])
  ok(lineSum.s === R1.out.totals.amountVnd.toString(), 'Σ tiền dòng = Σ kết quả = tổng run (lệch 0đ)')
  ok(await count(db, `SELECT count(*) FROM public.cms_result_lines WHERE run_id = '${R1.runId}' AND status = 'ADJUSTMENT'`) === 1, 'dòng âm ⇒ ADJUSTMENT (Q-206: sự kiện đã chuẩn hoá, không suy từ status)')
  const again = (await svc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [R1.runId])).rows[0].r
  ok(again.published && again.already === true && again.current === true, 'publish lại ⇒ already, không tạo snapshot thứ hai')
  ok(await count(db, `SELECT count(*) FROM public.cms_sync_runs WHERE program_id = '${P}' AND status = 'ok'`) === 1, 'vẫn đúng 1 run ok')
}

section('4b. Nhiều bậc (100 bậc / SP, bậc cuối không giới hạn — CMS-Q-220) — F(Q) tra theo cặp (SP, Q) khớp engine')
{
  const T100 = Array.from({ length: 100 }, (_, i) => ({ order: i + 1, from: i * 3 + 1, to: i === 99 ? null : i * 3 + 3, amount: String(1000 + i * 37) }))
  const PM = await makeProgram(db, { products: [
    { product_id: '910100', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '1', tiers: T100 },
    { product_id: '910101', gmv_basis: 'product', target_gmv: '50000', base_quantity_cms: '0.5', tiers: T100 },
  ] })
  const lm = []
  for (let i = 0; i < 160; i++) {
    const raw = rawLine({ pid: i % 2 ? '910101' : '910100', email: [EA, EB, EC][i % 3], bq: String(5 + (i % 7) * 4), gmv: String(3000 + i * 11),
      at: `${day(-9)}T0${i % 10}:${String(i % 60).padStart(2, '0')}:00.${String(i).padStart(6, '0')}Z` })
    lm.push(C.normalizeSalesRow(raw).value)
  }
  const r = await runOnce(db, PM, { lines: lm, chunkSize: 50 })
  // Có dược sĩ vượt mốc bắt đầu bậc 100 (Q ≥ 298) vẫn được cộng tiền bậc cuối — không trần, không AT_CAP.
  const beyond = r.out.results.some((x) => x.cmsQuantity >= BigInt(298) && x.amountVnd > BigInt(0))
  ok(r.seal.sealed === true && r.pub?.published === true && beyond && r.out.results.every((x) => x.capQuantity === null && !x.atCap),
    'seal 100 bậc đạt (có dược sĩ vào bậc cuối không giới hạn, không trần) — F theo cặp (SP, Q) = engine', JSON.stringify(r.seal))
  const t = await runOnce(db, PM, { lines: lm, chunkSize: 50, publish: false, tamper: (p) => {
    const rr = p.parts.results.find((x) => x.program_product_id && Number(x.cms_quantity) > 5 && x.gate_met)
    const ll = p.parts.result_lines.filter((x) => x.user_id === rr.user_id && x.program_product_id === rr.program_product_id && Number(x.amount_vnd) > 0)
    ll[0].amount_vnd = String(Number(ll[0].amount_vnd) + 37); ll[1].amount_vnd = String(Number(ll[1].amount_vnd) - 37)
  } })
  ok(t.seal.sealed === false && t.seal.code === 'SEAL_LINE_ALLOC', 'dồn tiền giữa hai dòng ở chương trình 100 bậc ⇒ SEAL_LINE_ALLOC', JSON.stringify(t.seal))
}

section('4c. LỊCH SỬ (trước CMS-Q-220): app cũ có trần — seal SQL 122 vẫn kiểm đúng payload có trần; engine mới từ chối cấu hình đó')
{
  // DB 122 chưa có guard 125 ⇒ còn nạp được bậc cuối hữu hạn (đúng thế giới trước 125). Run công bố bằng engine CŨ = run lịch sử.
  const PC = await makeProgram(db, { isTest: true, products: [{ product_id: '910110', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '24', tiers: T_CAP_LEGACY }] })
  const lc = ['30', '30', '60'].map((bq, i) => C.normalizeSalesRow(rawLine({ pid: '910110', bq, gmv: '1000', at: `${day(-9 + i)}T03:00:00.000001Z` })).value)
  const old = await runOnce(db, PC, { lines: lc, engine: E_OLD })
  const res = await one(db, `SELECT cms_quantity, rewarded_quantity, cap_quantity, at_cap, amount_vnd FROM public.cms_results WHERE run_id = $1`, [old.runId])
  ok(old.seal.sealed === true && old.pub?.published === true && res?.cms_quantity === 5 && res?.rewarded_quantity === 4 && res?.cap_quantity === 4 && res?.at_cap === true
    && Number(res?.amount_vnd) === 70000, 'engine cũ: Q 5 ⇒ hưởng 4 (trần), 70.000đ — seal S7 / S8 / S14 khớp cấu hình hữu hạn', JSON.stringify([old.seal, res]))
  const fake = await runOnce(db, PC, { lines: lc, engine: E_OLD, publish: false, tamper: (p) => { const x = p.parts.results[0]; x.cap_quantity = null; x.at_cap = false; x.rewarded_quantity = x.cms_quantity } })
  ok(fake.seal.sealed === false, 'payload bỏ trần trên cấu hình CÒN trần ⇒ seal 122 từ chối (cap phải theo cấu hình)', JSON.stringify(fake.seal))
  let threw = null
  try { await runOnce(db, PC, { lines: lc }) } catch (e) { threw = String(e?.message ?? e) }
  ok(/FINITE_LAST_TIER/.test(threw ?? ''), 'engine MỚI trên cấu hình bậc cuối hữu hạn (chưa chuyển đổi) ⇒ FINITE_LAST_TIER, không tính theo trần', threw ?? 'không ném')
  await svc(`SELECT public.rpc_cms_sales_run_finish(id, 'error', '{"error_code":"CONFIG_FINITE_LAST_TIER"}'::jsonb) FROM public.cms_sync_runs WHERE program_id = $1 AND status = 'running'`, [PC])
}

section('5. Stage — idempotent / xung đột / sai dạng / sau seal')
{
  const snap = (await svc(`SELECT public.rpc_cms_sales_run_open($1) s`, [P])).rows[0].s
  const run = snap.run_id
  const rows = R1.payload.parts.sales_lines.slice(0, 2)
  const st = async (part, no, r) => (await svc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb) n`, [run, part, no, JSON.stringify(r)])).rows[0].n
  ok(await st('sales_lines', 0, rows) === 2, 'khối 0 ghi 2 dòng')
  ok(await st('sales_lines', 0, rows) === 2 && await count(db, `SELECT count(*) FROM public.cms_sales_lines WHERE run_id = '${run}'`) === 2, 'gửi lại cùng khối ⇒ trả 2, KHÔNG nhân đôi')
  ok(await raises(db, st('sales_lines', 0, R1.payload.parts.sales_lines.slice(0, 1)), 'CMS_STAGE_CHUNK_CONFLICT'), 'cùng số khối khác nội dung ⇒ CHUNK_CONFLICT')
  ok(await raises(db, st('sales_lines', 1, rows), 'duplicate key'), 'cùng dòng ở khối khác ⇒ trùng khoá (không nhân đôi)')
  const bad = (patch) => [{ ...R1.payload.parts.sales_lines[2], ...patch }]
  for (const [patch, name] of [
    [{ base_quantity: 'NaN' }, 'base_quantity NaN'], [{ base_quantity: '1e5' }, 'base_quantity số mũ'],
    [{ gmv_amount: '1.0000000001' }, 'gmv 10 chữ số thập phân'], [{ completed_at: 'now' }, "completed_at 'now'"],
    [{ completed_at: '2026-11-01T00:00:00Z' }, 'completed_at thiếu micro giây'], [{ seller_email: 'A@X.VN' }, 'email chữ hoa'],
    [{ seq: 1 }, 'seq kiểu số'], [{ product_id: '0910001' }, 'ProductID số 0 đầu'], [{ disposition: 'OK' }, 'disposition lạ'],
    [{ program_product_id: 'x' }, 'program_product_id không phải uuid'],
    [{ order_code: 'QA\u0085X' }, 'ký tự điều khiển C1 (U+0085) trong mã đơn'],
    [{ completed_at: '2026-13-01T00:00:00.000000Z' }, 'tháng 13 (ra mã CMS, không lỗi ép kiểu thô)'],
    [{ seller_email: { a: 1 } }, 'email là object'],
    [{ pos_code: true }, 'boolean ở trường text'],
    [{ pos_code: ['x'] }, 'mảng chuỗi ở trường text (jsonpath strict)'],
    [{ order_code: [] }, 'mảng rỗng ở trường text'],
    [{ completed_at: '2026-02-30T00:00:00.000000Z' }, 'ngày 30/02 (qua regex) ⇒ mã CMS, không 22008 thô'],
    [{ source_updated_at: '0000-01-01T00:00:00.000000Z' }, 'năm 0000'],
  ]) ok(await raises(db, st('sales_lines', 7, bad(patch)), 'CMS_STAGE_BAD_ROW'), `${name} ⇒ CMS_STAGE_BAD_ROW`, lastErr)
  ok(await raises(db, st('results', 0, [{ ...R1.payload.parts.results[0], amount_vnd: '9223372036854775808' }]), 'CMS_STAGE_BAD_ROW'), 'tiền > bigint ⇒ BAD_ROW (không lỗi ép kiểu thô)', lastErr)
  ok(await raises(db, st('results', 0, [{ ...R1.payload.parts.results[0], at_cap: 'true' }]), 'CMS_STAGE_BAD_ROW'), "at_cap chuỗi 'true' ⇒ BAD_ROW (không lỗi ép kiểu thô)", lastErr)
  ok(await raises(db, st('results', 0, [{ ...R1.payload.parts.results[0], line_count: 1 }]), 'CMS_STAGE_BAD_ROW'), 'số JSON ở trường số-chuỗi ⇒ BAD_ROW', lastErr)
  ok(await raises(db, st('nope', 0, rows), 'CMS_STAGE_BAD_PART'), 'part lạ ⇒ BAD_PART')
  ok(await raises(db, st('sales_lines', 0, []), 'CMS_STAGE_BAD_CHUNK'), 'khối rỗng ⇒ BAD_CHUNK')
  ok(await raises(db, st('sales_lines', 9, Array.from({ length: 5001 }, () => rows[0])), 'CMS_STAGE_BAD_CHUNK'), 'khối > 5.000 ⇒ BAD_CHUNK')
  await svc(`SELECT public.rpc_cms_sales_run_finish($1, 'error', '{"error_code":"QA_ABORT"}'::jsonb)`, [run])
  ok(await raises(db, st('sales_lines', 3, rows), 'CMS_SYNC_RUN_NOT_RUNNING'), 'stage vào run đã đóng ⇒ NOT_RUNNING')
}

section('6. Seal bắt giả mạo (mỗi ca một run, pointer giữ nguyên)')
const sealCase = async (name, code, opts) => {
  const r = await runOnce(db, P, { publish: false, ...opts })
  if (r.seal.sealed) await svc(`SELECT public.rpc_cms_sales_run_finish($1, 'error', '{"error_code":"QA_ABORT"}'::jsonb)`, [r.runId])
  const row = await runRow(db, r.runId)
  ok(r.seal.sealed === false && r.seal.code === code && row.status === (r.seal.status) && row.error_code === code && await pointer(db, P) === R1.runId,
    `${name} ⇒ ${code}`, JSON.stringify(r.seal))
}
const findRes = (p, uidv, pid) => p.parts.results.find((x) => x.user_id === uidv && x.product_id === pid)
const linesOf = (p, uidv, ppid) => p.parts.result_lines.filter((x) => x.user_id === uidv && x.program_product_id === ppid)
await sealCase('thiếu một khối result_lines', 'SEAL_COUNT_MISMATCH', { skipChunk: { part: 'result_lines', no: 1 } })
await sealCase('khai báo số khối sai', 'SEAL_CHUNKS_MISMATCH', { expectTamper: (e) => { e.chunks.results += 1 } })
await sealCase('đảo seq hai dòng', 'SEAL_ORDER', { tamper: (p) => {
  const s = p.parts.sales_lines, l = p.parts.result_lines
  const [a, b] = [s[0], s[1]]; [a.seq, b.seq] = [b.seq, a.seq]
  for (const x of l) { if (x.order_line_id === a.order_line_id) x.seq = a.seq; else if (x.order_line_id === b.order_line_id) x.seq = b.seq }
} })
await sealCase('dòng ngoài phạm vi ghi thành INCLUDED', 'SEAL_SCOPE', { tamper: (p) => { const x = p.parts.sales_lines.find((s) => s.disposition === 'OUT_OF_SCOPE'); x.disposition = 'INCLUDED' } })
// Dòng seq 0 dời sớm hơn ⇒ vẫn đúng thứ tự, chỉ sai kỳ.
await sealCase('dòng ngoài kỳ', 'SEAL_SCOPE', { tamper: (p) => { p.parts.sales_lines[0].completed_at = `${day(-40)}T00:00:00.000000Z` } })
// Đổi sang staff khác CÙNG store ngoài phạm vi ⇒ phạm vi vẫn khớp, chỉ sai người (email không khớp).
await sealCase('gán dòng cho staff khác', 'SEAL_MAPPING', { tamper: (p) => {
  const x = p.parts.sales_lines.find((s) => s.disposition === 'OUT_OF_SCOPE'); x.user_id = staffId(3, 'b'); x.store_id = storeId(3)
} })
await sealCase('bỏ sót người hưởng hợp lệ (UNASSIGNED dù email khớp staff)', 'SEAL_MAPPING', { tamper: (p) => {
  const x = p.parts.sales_lines.find((s) => s.disposition === 'OUT_OF_SCOPE'); Object.assign(x, { disposition: 'UNASSIGNED', unassigned_reason: 'NOT_FOUND', user_id: null, store_id: null })
} })
await sealCase('NO_EMAIL nhưng có email', 'SEAL_MAPPING', { tamper: (p) => {
  const x = p.parts.sales_lines.find((s) => s.unassigned_reason === 'NOT_FOUND'); x.unassigned_reason = 'NO_EMAIL'
} })
await sealCase('dòng kết quả trỏ dòng chưa gán', 'SEAL_LINE_LINK', { tamper: (p) => {
  const u = p.parts.sales_lines.find((s) => s.disposition === 'UNASSIGNED'); const l = p.parts.result_lines[0]
  p.parts.sales_lines.find((s) => s.order_line_id === l.order_line_id).disposition = 'UNASSIGNED'
  Object.assign(p.parts.sales_lines.find((s) => s.order_line_id === l.order_line_id), { unassigned_reason: 'NOT_FOUND', user_id: null, store_id: null, seller_email: u.seller_email })
} })
await sealCase('K trong kết quả ≠ cấu hình', 'SEAL_RESULT_CONFIG', { tamper: (p) => { findRes(p, U.C, PIDS.none).per_unit = '12' } })
await sealCase('line_count sai', 'SEAL_RESULT_SUMS', { tamper: (p) => { const r = findRes(p, U.C, PIDS.none); r.line_count = '2' } })
await sealCase('tiền kết quả + tiền dòng cùng lệch (F(Q) sai)', 'SEAL_TIER_AMOUNT', { tamper: (p) => {
  const r = findRes(p, U.C, PIDS.none); r.potential_amount = String(Number(r.potential_amount) + 1); r.amount_vnd = r.potential_amount
  const l = linesOf(p, U.C, r.program_product_id); l[l.length - 1].amount_vnd = String(Number(l[l.length - 1].amount_vnd) + 1)
} })
await sealCase('"đạt từ" của gate SP sai', 'SEAL_GATE', { tamper: (p) => { findRes(p, U.A, PIDS.prod).gate_met_at = `${day(-5)}T03:00:00.000001Z` } })
await sealCase('gate danh mục sai (B ghi đạt)', 'SEAL_CATALOG', { tamper: (p) => {
  const k = p.parts.catalog.find((c) => c.user_id === U.B); k.met = true; k.met_at = `${day(-6)}T06:00:00.000001Z`
  const r = findRes(p, U.B, PIDS.catA); r.gate_met = true; r.gate_met_at = k.met_at; r.amount_vnd = r.potential_amount
  const l = linesOf(p, U.B, r.program_product_id); l[0].amount_vnd = r.potential_amount; l[0].status = Number(r.potential_amount) > 0 ? 'RECORDED' : 'ACCUMULATING'
} })
await sealCase('dồn tiền giữa hai dòng (tổng nhóm giữ nguyên)', 'SEAL_LINE_ALLOC', { tamper: (p) => {
  const r = findRes(p, U.A, PIDS.none); const l = linesOf(p, U.A, r.program_product_id)
  l[0].amount_vnd = String(Number(l[0].amount_vnd) + 15000); l[1].amount_vnd = String(Number(l[1].amount_vnd) - 15000)
} })
await sealCase('trạng thái dòng sai', 'SEAL_LINE_ALLOC', { tamper: (p) => { const l = linesOf(p, U.A, findRes(p, U.A, PIDS.none).program_product_id); l[l.length - 1].status = 'ACCUMULATING' } })
await sealCase('khai báo tổng tiền sai', 'SEAL_TOTAL', { expectTamper: (e) => { e.amount_vnd = String(BigInt(e.amount_vnd) + BigInt(1)) } })
await sealCase('totals hiển thị cho super sai (included)', 'SEAL_TOTALS', { expectTamper: (e) => { e.totals.included += 1 } })
await sealCase('totals GMV chưa gán sai', 'SEAL_TOTALS', { expectTamper: (e) => { e.totals.unassigned_gmv = '1' } })
await sealCase('rows_read < số ứng viên', 'SEAL_TOTALS', { expectTamper: (e) => { e.rows_read = 1 } })
await sealCase('totals số dòng điều chỉnh sai', 'SEAL_TOTALS', { expectTamper: (e) => { e.totals.adjustment_lines += 1 } })
await sealCase('totals chưa gán theo lý do sai', 'SEAL_TOTALS', { expectTamper: (e) => { e.totals.unassigned_by_reason = { NOT_FOUND: 4 } } })
await sealCase('totals không ứng viên theo lý do sai', 'SEAL_TOTALS', { expectTamper: (e) => { e.totals.excluded_by_reason.OUT_OF_WINDOW += 1 } })
await sealCase('totals tổng tiền khác amount_vnd', 'SEAL_TOTALS', { expectTamper: (e) => { e.totals.amount_vnd = '1' } })
for (const [tamper, name] of [
  [(e) => { e.totals.extra = 1 }, 'totals có khoá lạ'],
  [(e) => { e.totals.unassigned_by_reason = { HACK: 1 } }, 'lý do chưa gán ngoài enum'],
  [(e) => { e.source_max_updated_at = '2026-02-30T00:00:00.000000Z' }, 'source_max_updated_at 30/02'],
]) {
  const r = await runOnce(db, P, { publish: false, expectTamper: tamper }).catch((x) => ({ err: String(x.message) }))
  ok(String(r.err ?? '').includes('CMS_SEAL_BAD_EXPECT'), `${name} ⇒ CMS_SEAL_BAD_EXPECT`, r.err ?? JSON.stringify(r.seal))
  for (const x of (await db.query(`SELECT id FROM public.cms_sync_runs WHERE program_id = $1 AND status = 'running'`, [P])).rows) {
    await svc(`SELECT public.rpc_cms_sales_run_finish($1, 'error', '{"error_code":"QA_ABORT"}'::jsonb)`, [x.id])
  }
}
// Mapping đổi GIỮA các bước seal ⇒ held MAPPING_CHANGED (không error SEAL_MAPPING — db-reviewer r2 N2).
{
  const snap = (await svc(`SELECT public.rpc_cms_sales_run_open($1) s`, [P])).rows[0].s
  const sp = RS.parseCmsSalesSnapshot(snap)
  const ls = linesFor(sp.todayVn)
  const out = E.computeCmsProgram({ ...RS.cmsSnapshotToEngineInput(sp), lines: ls })
  const pl = RS.buildCmsStagePayload(sp, ls, out, { rowsRead: ls.length, rowsRejected: 0, bytesProcessed: null, chunkSize: 1000 })
  for (const part of RS.CMS_STAGE_PARTS) {
    const ch = RS.chunkCmsStageRows(pl.parts[part], 1000)
    for (let i = 0; i < ch.length; i++) await svc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb)`, [sp.runId, part, i, JSON.stringify(ch[i])])
  }
  const b = (await svc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb) r`, [sp.runId, JSON.stringify(pl.expect)])).rows[0].r
  await svc(`SELECT public.rpc_cms_sales_run_seal_step($1, 1)`, [sp.runId])
  await db.query(`UPDATE public.users SET store_id = $2 WHERE id = $1`, [U.D, storeId(3)])
  const s2 = (await svc(`SELECT public.rpc_cms_sales_run_seal_step($1, 2) r`, [sp.runId])).rows[0].r
  ok(b.ok && s2.sealed === false && s2.status === 'held' && s2.code === 'MAPPING_CHANGED', 'mapping đổi giữa bước 1 và 2 ⇒ held MAPPING_CHANGED', JSON.stringify(s2))
  await db.query(`UPDATE public.users SET store_id = $2 WHERE id = $1`, [U.D, storeId(2)])
}
// R3-5: gọi lại bước đã qua khi CHƯA sealed ⇒ already (không đổi gì); cấu hình đổi / chương trình chốt giữa bước ⇒ held đúng mã.
{
  const begin3 = async () => {
    const snap = (await svc(`SELECT public.rpc_cms_sales_run_open($1) s`, [P])).rows[0].s
    const sp = RS.parseCmsSalesSnapshot(snap)
    const ls = linesFor(sp.todayVn)
    const out = E.computeCmsProgram({ ...RS.cmsSnapshotToEngineInput(sp), lines: ls })
    const pl = RS.buildCmsStagePayload(sp, ls, out, { rowsRead: ls.length, rowsRejected: 0, bytesProcessed: null, chunkSize: 1000 })
    for (const part of RS.CMS_STAGE_PARTS) {
      const ch = RS.chunkCmsStageRows(pl.parts[part], 1000)
      for (let i = 0; i < ch.length; i++) await svc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb)`, [sp.runId, part, i, JSON.stringify(ch[i])])
    }
    await svc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb)`, [sp.runId, JSON.stringify(pl.expect)])
    for (let i = 1; i <= 3; i++) await svc(`SELECT public.rpc_cms_sales_run_seal_step($1, $2)`, [sp.runId, i])
    return sp.runId
  }
  const ra = await begin3()
  const again = (await svc(`SELECT public.rpc_cms_sales_run_seal_step($1, 2) r`, [ra])).rows[0].r
  ok(again.ok === true && again.already === true && (await runRow(db, ra)).seal_step === 3, 'gọi lại bước 2 khi đã qua bước 3 (chưa sealed) ⇒ already, seal_step giữ 3', JSON.stringify(again))
  const s4 = (await svc(`SELECT public.rpc_cms_sales_run_seal_step($1, 4) r`, [ra])).rows[0].r
  ok(s4.ok === true && s4.already !== true && (await runRow(db, ra)).seal_step === 4, 'sau already vẫn chạy tiếp đúng bước 4')
  await svc(`SELECT public.rpc_cms_sales_run_finish($1, 'error', '{"error_code":"QA_ABORT"}'::jsonb)`, [ra])
  const rb = await begin3()
  await db.query(`UPDATE public.cms_programs SET config_version = config_version + 1 WHERE id = $1`, [P])
  const sc = (await svc(`SELECT public.rpc_cms_sales_run_seal_step($1, 4) r`, [rb])).rows[0].r
  ok(sc.sealed === false && sc.status === 'held' && sc.code === 'CONFIG_CHANGED', 'cấu hình đổi giữa bước 3 và 4 ⇒ held CONFIG_CHANGED', JSON.stringify(sc))
  const P9 = await makeProgram(db, { products: [{ product_id: '910110', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '1', tiers: T_ONE }] })
  const snap9 = (await svc(`SELECT public.rpc_cms_sales_run_open($1) s`, [P9])).rows[0].s
  const sp9 = RS.parseCmsSalesSnapshot(snap9)
  const pl9 = RS.buildCmsStagePayload(sp9, [], E.computeCmsProgram({ ...RS.cmsSnapshotToEngineInput(sp9), lines: [] }), { rowsRead: 0, rowsRejected: 0, bytesProcessed: null })
  await svc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb)`, [sp9.runId, JSON.stringify(pl9.expect)])
  await svc(`SELECT public.rpc_cms_sales_run_seal_step($1, 1)`, [sp9.runId])
  await db.query(`UPDATE public.cms_programs SET status = 'locked', locked_at = now() WHERE id = $1`, [P9])
  const sl = (await svc(`SELECT public.rpc_cms_sales_run_seal_step($1, 2) r`, [sp9.runId])).rows[0].r
  ok(sl.sealed === false && sl.status === 'held' && sl.code === 'PROGRAM_LOCKED', 'chương trình bị chốt giữa bước 1 và 2 ⇒ held PROGRAM_LOCKED', JSON.stringify(sl))
}
// Thứ tự bước / đóng băng staging.
{
  const p = await runOnce(db, P, { publish: false, expectTamper: () => {} }).catch((e) => ({ err: e.message }))
  // run đã sealed (runOnce chạy đủ bước) ⇒ thử lại begin / step / stage đều bị từ chối
  ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb)`, [p.runId, JSON.stringify(p.payload.expect)]), 'CMS_SEAL_STARTED'), 'seal_begin lần 2 ⇒ CMS_SEAL_STARTED')
  const again3 = (await svc(`SELECT public.rpc_cms_sales_run_seal_step($1, 3) r`, [p.runId])).rows[0].r
  const again10 = (await svc(`SELECT public.rpc_cms_sales_run_seal_step($1, 10) r`, [p.runId])).rows[0].r
  ok(again3.ok === true && again3.already === true && again10.sealed === true && again10.already === true,
     'gọi lại bước khi đã sealed (mất phản hồi) ⇒ trả lại kết quả, không đổi gì (N8)', JSON.stringify({ again3, again10 }))
  ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_stage($1, 'results', 99, $2::jsonb)`, [p.runId, JSON.stringify([p.payload.parts.results[0]])]), 'CMS_STAGE_SEALED'), 'stage sau seal ⇒ CMS_STAGE_SEALED')
  await svc(`SELECT public.rpc_cms_sales_run_finish($1, 'error', '{"error_code":"QA_ABORT"}'::jsonb)`, [p.runId])
  // run mới: begin rồi nhảy bước ⇒ STEP_ORDER; stage sau begin ⇒ SEALED (đóng băng)
  const snap = (await svc(`SELECT public.rpc_cms_sales_run_open($1) s`, [P])).rows[0].s
  const q = RS.buildCmsStagePayload(RS.parseCmsSalesSnapshot(snap), [], E.computeCmsProgram({ ...RS.cmsSnapshotToEngineInput(RS.parseCmsSalesSnapshot(snap)), lines: [] }), { rowsRead: 0, rowsRejected: 0, bytesProcessed: null })
  const b = (await svc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb) r`, [snap.run_id, JSON.stringify(q.expect)])).rows[0].r
  ok(b.ok === true && b.steps === 10, 'seal_begin run rỗng đạt, 10 bước')
  ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_seal_step($1, 2)`, [snap.run_id]), 'CMS_SEAL_STEP_ORDER'), 'nhảy bước (2 trước 1) ⇒ CMS_SEAL_STEP_ORDER')
  ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_stage($1, 'sales_lines', 0, $2::jsonb)`, [snap.run_id, JSON.stringify(R1.payload.parts.sales_lines.slice(0, 1))]), 'CMS_STAGE_SEALED'), 'stage sau seal_begin (đang seal) ⇒ CMS_STAGE_SEALED')
  ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_seal_step($1, 11)`, [snap.run_id]), 'CMS_SEAL_BAD_STEP'), 'bước ngoài 1…10 ⇒ BAD_STEP')
  await svc(`SELECT public.rpc_cms_sales_run_finish($1, 'error', '{"error_code":"QA_ABORT"}'::jsonb)`, [snap.run_id])
}
{
  const r = await runOnce(db, P, { publish: false, expectTamper: (e) => { e.amount_vnd = 'abc' } }).catch((e) => ({ err: String(e.message) }))
  ok(String(r.err ?? '').includes('CMS_SEAL_BAD_EXPECT'), 'expect sai dạng ⇒ CMS_SEAL_BAD_EXPECT (raise, run còn running)')
  const running = (await db.query(`SELECT id FROM public.cms_sync_runs WHERE program_id = $1 AND status = 'running'`, [P])).rows
  for (const x of running) await svc(`SELECT public.rpc_cms_sales_run_finish($1, 'error', '{"error_code":"QA_ABORT"}'::jsonb)`, [x.id])
}

section('7. Lỗi thời: cấu hình / mapping đổi; chương trình đã chốt; chưa seal')
{
  // cấu hình đổi TRƯỚC seal ⇒ held CONFIG_CHANGED
  const r = await runOnce(db, P, { publish: false, tamper: () => {} , expectTamper: () => {} })
  ok(r.seal.sealed === true, 'run sạch seal đạt (để thử publish lỗi thời)')
  await db.query(`UPDATE public.cms_programs SET config_version = config_version + 1 WHERE id = $1`, [P])
  const pub = (await svc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [r.runId])).rows[0].r
  ok(pub.published === false && pub.code === 'CONFIG_CHANGED' && (await runRow(db, r.runId)).status === 'held' && await pointer(db, P) === R1.runId, 'config_version đổi sau seal ⇒ publish held CONFIG_CHANGED, giữ pointer cũ', JSON.stringify(pub))
  // mapping đổi sau open ⇒ seal held MAPPING_CHANGED
  const snap = (await svc(`SELECT public.rpc_cms_sales_run_open($1) s`, [P])).rows[0].s
  await db.query(`UPDATE public.users SET full_name = full_name WHERE id = $1`, [U.A])          // không đổi trường map ⇒ vân tay giữ
  await db.query(`UPDATE public.users SET store_id = $2 WHERE id = $1`, [U.D, storeId(3)])
  const seal = await sealAll(svc, snap.run_id, R1.payload.expect)
  ok(seal.sealed === false && seal.code === 'MAPPING_CHANGED' && seal.status === 'held', 'store của staff đổi sau open ⇒ seal held MAPPING_CHANGED', JSON.stringify(seal))
  await db.query(`UPDATE public.users SET store_id = $2 WHERE id = $1`, [U.D, storeId(2)])
  // mapping đổi giữa seal và publish ⇒ publish held MAPPING_CHANGED
  const r2 = await runOnce(db, P, { publish: false })
  await db.query(`UPDATE public.stores SET is_active = false WHERE id = $1`, [storeId(25)])
  const pub2 = (await svc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [r2.runId])).rows[0].r
  ok(pub2.published === false && pub2.code === 'MAPPING_CHANGED', 'store ngừng hoạt động sau seal ⇒ publish held MAPPING_CHANGED', JSON.stringify(pub2))
  await db.query(`UPDATE public.stores SET is_active = true WHERE id = $1`, [storeId(25)])
  // chưa seal ⇒ raise
  const s3 = (await svc(`SELECT public.rpc_cms_sales_run_open($1) s`, [P])).rows[0].s
  ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_publish($1)`, [s3.run_id]), 'CMS_RESULT_NOT_SEALED'), 'publish khi chưa seal ⇒ CMS_RESULT_NOT_SEALED')
  await svc(`SELECT public.rpc_cms_sales_run_finish($1, 'held', '{"error_code":"QA_ABORT","rows_read":"5"}'::jsonb)`, [s3.run_id])
  ok((await runRow(db, s3.run_id)).rows_read === 5, 'finish held ghi rows_read')
}

section('8. Pointer / ràng buộc run')
{
  const held = (await db.query(`SELECT id FROM public.cms_sync_runs WHERE program_id = $1 AND status = 'held' LIMIT 1`, [P])).rows[0].id
  ok(await raises(db, db.query(`UPDATE public.cms_programs SET current_result_run_id = $2 WHERE id = $1`, [P, held]), 'CMS_RESULT_POINTER_INVALID'), 'trỏ pointer vào run held ⇒ POINTER_INVALID')
  ok(await raises(db, db.query(`UPDATE public.cms_programs SET current_result_run_id = NULL WHERE id = $1`, [P]), 'CMS_RESULT_POINTER_INVALID'), 'xoá pointer ⇒ POINTER_INVALID')
  const P2 = await makeProgram(db, { products: [{ product_id: '910060', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '1', tiers: T_ONE }] })
  ok(await raises(db, db.query(`UPDATE public.cms_programs SET current_result_run_id = $2 WHERE id = $1`, [P2, R1.runId]), 'CMS_RESULT_POINTER_INVALID'), 'trỏ run của chương trình khác ⇒ trigger từ chối')
  await db.exec(`ALTER TABLE public.cms_programs DISABLE TRIGGER cms_programs_result_guard`)
  ok(await raises(db, db.query(`UPDATE public.cms_programs SET current_result_run_id = $2 WHERE id = $1`, [P2, R1.runId]), 'cms_programs_result_run_fk'), 'bỏ trigger vẫn bị FK kép (run, chương trình) chặn — lớp bảo vệ thứ hai')
  await db.exec(`ALTER TABLE public.cms_programs ENABLE TRIGGER cms_programs_result_guard`)
  const s = (await svc(`SELECT public.rpc_cms_sales_run_open($1) s`, [P2])).rows[0].s
  ok(await raises(db, svc(`SELECT public.rpc_cms_sync_run_close($1, 'ok', '{}'::jsonb)`, [s.run_id]), 'cms_sync_runs_sales_publish'), "rpc_cms_sync_run_close (120) không đóng được run sales thành 'ok'")
  await svc(`SELECT public.rpc_cms_sales_run_finish($1, 'error', '{"error_code":"QA_ABORT"}'::jsonb)`, [s.run_id])
  ok(await raises(db, db.query(`INSERT INTO public.cms_sync_runs (kind, program_id) VALUES ('sales', $1)`, [P2]), 'cms_sync_runs_kind_shape'), 'run sales thiếu config_version / vân tay ⇒ kind_shape')
  ok(await raises(db, db.query(`INSERT INTO public.cms_sync_runs (kind, program_id) VALUES ('products', $1)`, [P2]), 'cms_sync_runs_kind_shape'), 'run products có program_id ⇒ kind_shape')
}

section('9. Đọc theo vai — phạm vi hiện tại')
const read = (who, sql, params) => as(db, who, () => db.query(sql, params))
const rowsAs = async (who, pid = P, run = null) => (await read(who, `SELECT public.rpc_cms_result_rows($1, $2) r`, [pid, run])).rows[0].r
{
  const all = await rowsAs(U.super)
  ok(all.run_id === R1.runId && all.results.length === R1.payload.parts.results.length, 'super: mọi kết quả của run hiện hành', `${all.results.length}`)
  ok(all.results.every((r) => typeof r.amount_vnd === 'string' && typeof r.base_quantity === 'string'), 'số đi dạng chuỗi (không float)')
  const a = await rowsAs(U.A)
  ok(a.results.length > 0 && a.results.every((r) => r.user_id === U.A) && a.users.length === 1, 'staff A: chỉ kết quả của chính mình')
  const q = await rowsAs(U.qlch1)
  ok(q.results.length > 0 && q.results.every((r) => [U.A, U.B].includes(r.user_id)), 'QLCH store 1: chỉ staff hiện thuộc store 1')
  const sm = await rowsAs(U.sm)
  ok(new Set(sm.results.map((r) => r.user_id)).size === 3 && sm.results.some((r) => r.user_id === U.C), 'SM (store 1, 2): staff A, B, C')
  const sm2 = await rowsAs(U.sm2)
  ok(sm2.results.every((r) => [U.A, U.B].includes(r.user_id)), 'SM2 (store 1 + FS): chỉ staff store 1')
  for (const [who, name] of [[U.mkt, 'admin thường'], [U.staffFs, 'staff FS'], [staffId(3, 'a'), 'staff store ngoài chương trình'], [U.qlchFs, 'QLCH FS']]) {
    ok(await raises(db, read(who, `SELECT public.rpc_cms_result_rows($1, NULL)`, [P]), 'CMS_RESULT_FORBIDDEN'), `${name} ⇒ CMS_RESULT_FORBIDDEN`, lastErr)
  }
  ok(await raises(db, read(U.A, `SELECT public.rpc_cms_result_lines($1, $2, NULL, $3, NULL, 20)`, [P, R1.runId, U.B]), 'CMS_RESULT_FORBIDDEN'), 'staff A đòi dòng của B ⇒ FORBIDDEN')
  ok(await raises(db, read(U.qlch1, `SELECT public.rpc_cms_result_excluded($1, $2, NULL, 50)`, [P, R1.runId]), 'CMS_RESULT_FORBIDDEN'), 'QLCH đọc dòng loại (email nguồn) ⇒ FORBIDDEN')
  const ex = (await read(U.super, `SELECT public.rpc_cms_result_excluded($1, $2, NULL, 50) r`, [P, R1.runId])).rows[0].r
  ok(ex.rows.length === 5 && ex.rows.every((x) => x.disposition !== 'INCLUDED'), 'super: dòng loại (4 chưa gán + 1 ngoài phạm vi)')
  // Chuyển staff B sang store 3 (ngoài chương trình): QLCH store 1 không còn thấy B; B không còn đọc chương trình.
  await db.query(`UPDATE public.users SET store_id = $2 WHERE id = $1`, [U.B, storeId(3)])
  const q2 = await rowsAs(U.qlch1)
  ok(q2.results.every((r) => r.user_id === U.A), 'B chuyển store ⇒ QLCH store 1 không còn thấy số của B (phạm vi hiện tại)')
  ok(await raises(db, read(U.B, `SELECT public.rpc_cms_result_rows($1, NULL)`, [P]), 'CMS_RESULT_FORBIDDEN'), 'B ở store ngoài chương trình ⇒ FORBIDDEN')
  await db.query(`UPDATE public.users SET store_id = $2 WHERE id = $1`, [U.B, storeId(1)])
  const h = (await read(U.A, `SELECT public.rpc_cms_result_header($1) r`, [P])).rows[0].r
  ok(h.viewer === 'staff' && h.run?.id === R1.runId && h.run.amount_vnd === undefined && h.last_attempt?.error_code === undefined && h.recent_runs === null,
    'header staff: run + lần thử gần nhất, KHÔNG có tổng chương trình / mã lỗi / lịch sử run', JSON.stringify(h))
  const hs = (await read(U.super, `SELECT public.rpc_cms_result_header($1) r`, [P])).rows[0].r
  ok(hs.viewer === 'super' && typeof hs.run.amount_vnd === 'string' && Array.isArray(hs.recent_runs) && hs.last_attempt.status !== 'ok' && hs.last_attempt.is_current === false,
    'header super: tổng + lịch sử run; lần thử gần nhất không ok ⇒ "đang giữ bản cũ"', JSON.stringify(hs.last_attempt))
  // Phân trang ổn định: trang 3 dòng ⇒ đủ mọi dòng của A, đúng thứ tự seq.
  let after = null, seen = []
  for (let i = 0; i < 10; i++) {
    const pg = (await read(U.A, `SELECT public.rpc_cms_result_lines($1, $2, NULL, NULL, $3, 3) r`, [P, R1.runId, after])).rows[0].r
    seen.push(...pg.rows.map((x) => x.seq)); after = pg.next_after_seq
    if (after === null) break
  }
  const expA = R1.payload.parts.result_lines.filter((l) => l.user_id === U.A).map((l) => Number(l.seq))
  ok(JSON.stringify(seen) === JSON.stringify(expA), 'D3 staff A: phân trang 3 dòng/lần đủ & đúng thứ tự seq', `${seen} vs ${expA}`)
  ok(await raises(db, read(U.super, `SELECT public.rpc_cms_result_lines($1, NULL, NULL, NULL, NULL, 20)`, [P]), 'CMS_RESULT_BAD_INPUT'), 'lines thiếu run_id ⇒ BAD_INPUT')
  ok(await raises(db, read(U.super, `SELECT public.rpc_cms_result_lines($1, $2, NULL, NULL, NULL, 501)`, [P, R1.runId]), 'CMS_RESULT_BAD_INPUT'), 'limit > 500 ⇒ BAD_INPUT')
  const heldRun = (await db.query(`SELECT id FROM public.cms_sync_runs WHERE program_id = $1 AND status = 'held' LIMIT 1`, [P])).rows[0].id
  ok(await raises(db, read(U.super, `SELECT public.rpc_cms_result_rows($1, $2)`, [P, heldRun]), 'CMS_RESULT_RUN_GONE'), 'run held (chưa công bố) ⇒ RUN_GONE')
  const P3 = await makeProgram(db, { products: [{ product_id: '910070', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '1', tiers: T_ONE }] })
  ok(await raises(db, read(U.super, `SELECT public.rpc_cms_result_rows($1, $2)`, [P3, R1.runId]), 'CMS_RESULT_RUN_GONE'), 'run của chương trình khác ⇒ RUN_GONE')
  const empty = await rowsAs(U.super, P3)
  ok(empty.run_id === null && empty.results.length === 0, 'chưa có snapshot ⇒ run_id null (UI hiện —, không 0 giả)')
}

section('10. QA namespace (is_test) + marker, kể cả super (H9b)')
{
  const PT = await makeProgram(db, { isTest: true, products: [{ product_id: '910080', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '1', tiers: T_ONE }] })
  const lt = [C.normalizeSalesRow(rawLine({ pid: '910080', bq: '3', gmv: '3000', at: `${day(-1)}T01:00:00.000000Z` })).value]
  const r = await runOnce(db, PT, { lines: lt })
  ok(r.pub?.published === true, 'chương trình test publish được (QA)')
  ok(await raises(db, read(U.super, `SELECT public.rpc_cms_result_rows($1, NULL)`, [PT]), 'CMS_RESULT_FORBIDDEN'), 'super KHÔNG marker ⇒ FORBIDDEN chương trình test')
  ok(await raises(db, read(U.A, `SELECT public.rpc_cms_result_header($1)`, [PT]), 'CMS_RESULT_FORBIDDEN'), 'staff không marker ⇒ FORBIDDEN')
  await db.query(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ($1, 'qa-script', now() + interval '1 hour')`, [U.super])
  ok((await rowsAs(U.super, PT)).results.length === 1, 'super CÓ marker ⇒ đọc được')
  await db.query(`DELETE FROM public.cms_qa_access WHERE user_id = $1`, [U.super])
  ok(await raises(db, read(U.super, `SELECT public.rpc_cms_result_rows($1, NULL)`, [PT]), 'CMS_RESULT_FORBIDDEN'), 'thu marker ⇒ FORBIDDEN lại')
}

section('11. Run mới: ghim run cũ, dọn dữ liệu')
{
  const R2 = await runOnce(db, P)
  ok(R2.pub?.published && await pointer(db, P) === R2.runId && R2.pub.previous_run_id === R1.runId, 'run 2 công bố, pointer chuyển, previous = run 1')
  const old = await rowsAs(U.A, P, R1.runId)
  ok(old.run_id === R1.runId && old.results.length > 0, 'trang / export đang ghim run 1 vẫn đọc được run 1 (không nối sang run 2)')
  const R3 = await runOnce(db, P)
  ok(R3.pub?.published, 'run 3 công bố')
  // Retention (PM 03/11 §4): nhiều run held / error trong 24 h ⇒ chỉ 2 gần nhất giữ dữ liệu; run ok cũ (run 1) dọn.
  const heTotal = await count(db, `SELECT count(*) FROM public.cms_sync_runs WHERE program_id = '${P}' AND kind = 'sales' AND status IN ('held','error')`)
  // r2.3 (PM 03/11): trần lô 50.000 = lô app. 50.001 / 100.000 ⇒ CMS_SALES_BAD_INPUT TRƯỚC khi ghi (không đặt purged_at, không
  // xoá dòng); 50.000 và mặc định (không truyền) nhận.
  {
    const snapRuns = async () => JSON.stringify((await db.query(`SELECT id, purged_at, cleared_at FROM public.cms_sync_runs WHERE program_id = $1 ORDER BY id`, [P])).rows)
    const nRows = async () => count(db, `SELECT (SELECT count(*) FROM public.cms_sales_lines s JOIN public.cms_sync_runs r ON r.id = s.run_id WHERE r.program_id = '${P}')
      + (SELECT count(*) FROM public.cms_result_lines l JOIN public.cms_sync_runs r ON r.id = l.run_id WHERE r.program_id = '${P}')`)
    const before = await snapRuns(), rows0 = await nRows()
    for (const bad of [50001, 100000]) {
      ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_cleanup($1, ${bad})`, [P]), 'CMS_SALES_BAD_INPUT'), `cleanup p_max_rows = ${bad} ⇒ CMS_SALES_BAD_INPUT`)
    }
    ok((await snapRuns()) === before && (await nRows()) === rows0, 'đầu vào vượt trần bị từ chối trước khi ghi: purged_at / cleared_at / số dòng không đổi')
    const def = (await svc(`SELECT public.rpc_cms_sales_run_cleanup($1) r`, [P])).rows[0].r
    ok(def && typeof def.more === 'boolean', 'cleanup không truyền p_max_rows (mặc định 50.000) ⇒ nhận', JSON.stringify(def))
  }
  let c1 = { more: true }, g1 = 0
  while (c1.more && g1++ < 400) c1 = (await svc(`SELECT public.rpc_cms_sales_run_cleanup($1, 50000) r`, [P])).rows[0].r
  ok(!c1.more && (await runRow(db, R1.runId)).purged_at !== null && (await runRow(db, R1.runId)).cleared_at !== null, 'cleanup dọn run 1 (không phải hiện hành / liền trước)', JSON.stringify(c1))
  const keep2 = (await db.query(`SELECT id FROM public.cms_sync_runs WHERE program_id = $1 AND kind = 'sales' AND status IN ('held','error')
     ORDER BY finished_at DESC, id DESC LIMIT 2`, [P])).rows.map((x) => x.id)
  const heKept = (await db.query(`SELECT id FROM public.cms_sync_runs WHERE program_id = $1 AND kind = 'sales' AND status IN ('held','error')
     AND purged_at IS NULL`, [P])).rows.map((x) => x.id).sort()
  ok(heTotal > 2 && JSON.stringify(heKept) === JSON.stringify([...keep2].sort()),
     `retention: ${heTotal} run held / error trong 24 h ⇒ chỉ 2 gần nhất còn dữ liệu, còn lại đã dọn (metadata giữ)`, JSON.stringify({ heTotal, heKept, keep2 }))
  ok(await count(db, `SELECT count(*) FROM public.cms_sync_runs WHERE program_id = '${P}' AND kind = 'sales'`) >= heTotal + 3, 'metadata mọi run vẫn còn (không xoá dòng cms_sync_runs)')
  ok(await count(db, `SELECT count(*) FROM public.cms_result_lines WHERE run_id = '${R1.runId}'`) === 0 && await count(db, `SELECT count(*) FROM public.cms_sales_lines WHERE run_id = '${R1.runId}'`) === 0, 'dữ liệu run 1 đã xoá, metadata run giữ')
  ok(await raises(db, read(U.A, `SELECT public.rpc_cms_result_rows($1, $2)`, [P, R1.runId]), 'CMS_RESULT_RUN_GONE'), 'đọc run đã dọn ⇒ RUN_GONE (UI: dữ liệu đã thay đổi, tải lại)')
  // Run hiện hành bị dọn (race hiếm, mô phỏng bằng superuser) ⇒ RUN_GONE, không trả kết quả rỗng như 0 giả (db-reviewer P2-1).
  await db.query(`UPDATE public.cms_sync_runs SET purged_at = now() WHERE id = $1`, [R3.runId])
  ok(await raises(db, read(U.A, `SELECT public.rpc_cms_result_rows($1, NULL)`, [P]), 'CMS_RESULT_RUN_GONE'), 'run hiện hành đã dọn ⇒ rows(NULL) RUN_GONE')
  ok(await raises(db, read(U.super, `SELECT public.rpc_cms_result_header($1)`, [P]), 'CMS_RESULT_RUN_GONE'), 'run hiện hành đã dọn ⇒ header RUN_GONE')
  await db.query(`UPDATE public.cms_sync_runs SET purged_at = NULL WHERE id = $1`, [R3.runId])
  // Dọn theo lô: p_max_rows nhỏ ⇒ nhiều lần gọi, chỉ đánh dấu purged khi hết dữ liệu.
  const R5 = await runOnce(db, P)
  ok(R5.pub?.published, 'run 5 công bố (run 3 thành run cũ cần dọn)')
  let calls = 0, part = null
  for (; calls < 200; calls++) {
    part = (await svc(`SELECT public.rpc_cms_sales_run_cleanup($1, 3) r`, [P])).rows[0].r
    if (calls === 0) {
      ok(part.purged === 0 && part.deleted === 3 && part.more === true, 'lô 3 dòng: chưa xoá hết, còn more', JSON.stringify(part))
      const r2 = await runRow(db, R2.runId)
      ok(r2.purged_at !== null && r2.cleared_at === null, 'lô đầu: purged_at đặt NGAY, cleared_at chưa')
      ok(await raises(db, read(U.super, `SELECT public.rpc_cms_result_rows($1, $2)`, [P, R2.runId]), 'CMS_RESULT_RUN_GONE'), 'đang dọn dở ⇒ đọc run đó RUN_GONE (không thấy dữ liệu cụt)')
    }
    if (!part.more) break
  }
  ok(!part.more && (await runRow(db, R2.runId)).cleared_at !== null && (await runRow(db, R3.runId)).purged_at === null, `dọn theo lô xong sau ${calls + 1} lần (run 2 cleared; giữ run 3 liền trước + run 5 hiện hành)`)
  ok((await runRow(db, R5.runId)).purged_at === null && (await runRow(db, R3.runId)).purged_at === null, 'giữ run hiện hành + liền trước')
  // (Ca "tuổi > 24 h dù trong 2 gần nhất" tách thành khối riêng bên dưới — db-reviewer r2.2 P1: ở đây run đẩy lùi tuổi
  // đã rơi khỏi 2 gần nhất nên bị dọn theo luật đếm, không chứng minh luật 24 h.)
  await db.query(`UPDATE public.cms_sync_runs SET finished_at = now() - interval '25 hours' WHERE program_id = $1 AND status IN ('held','error')`, [P])
  let more = true, guard = 0
  while (more && guard++ < 200) more = (await svc(`SELECT public.rpc_cms_sales_run_cleanup($1, 50000) r`, [P])).rows[0].r.more
  ok(await count(db, `SELECT count(*) FROM public.cms_sync_runs WHERE program_id = '${P}' AND status IN ('held','error') AND purged_at IS NULL`) === 0, 'run held / error > 24 h được dọn')
  ok(await count(db, `SELECT count(*) FROM public.cms_sync_run_chunks c JOIN public.cms_sync_runs r ON r.id = c.run_id WHERE r.purged_at IS NOT NULL`) === 0, 'không còn khối của run đã dọn')
  // Đã chốt: pointer không đổi; publish ⇒ held PROGRAM_LOCKED; open ⇒ LOCKED.
  const R4 = await runOnce(db, P, { publish: false })
  await db.query(`UPDATE public.cms_programs SET status = 'locked', locked_at = now() WHERE id = $1`, [P])
  const pub = (await svc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [R4.runId])).rows[0].r
  ok(pub.published === false && pub.code === 'PROGRAM_LOCKED' && await pointer(db, P) === R5.runId, 'chương trình đã chốt ⇒ publish held PROGRAM_LOCKED, pointer giữ')
  ok(await raises(db, svc(`SELECT public.rpc_cms_sales_run_open($1)`, [P]), 'CMS_PROGRAM_LOCKED'), 'đã chốt ⇒ open CMS_PROGRAM_LOCKED')
  ok(await raises(db, db.query(`UPDATE public.cms_programs SET current_result_run_id = $2 WHERE id = $1`, [P, R3.runId]), 'CMS_RESULT_POINTER_INVALID'), 'đã chốt ⇒ không đổi pointer (bất biến)')
  ok((await rowsAs(U.A)).run_id === R5.runId, 'staff vẫn đọc snapshot hiện hành khi locked')
}
// Retention tie-break (PM 03/11 §4): 3 run error cùng finished_at ⇒ giữ 2 run id lớn nhất; gọi lại cleanup không đổi tập giữ.
{
  const P7 = await makeProgram(db, { products: [{ product_id: '910111', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '1', tiers: T_ONE }] })
  const ids = []
  for (let i = 0; i < 3; i++) {
    const sp = RS.parseCmsSalesSnapshot((await svc(`SELECT public.rpc_cms_sales_run_open($1) s`, [P7])).rows[0].s)
    await svc(`SELECT public.rpc_cms_sales_run_finish($1, 'error', '{"error_code":"QA_TIE"}'::jsonb)`, [sp.runId])
    ids.push(sp.runId)
  }
  await db.query(`UPDATE public.cms_sync_runs SET finished_at = date_trunc('second', now()) - interval '1 hour' WHERE id = ANY ($1::uuid[])`, [ids])
  const expectKeep = (await db.query(`SELECT id FROM public.cms_sync_runs WHERE id = ANY ($1::uuid[]) ORDER BY id DESC LIMIT 2`, [ids])).rows.map((x) => x.id).sort()
  const kept = async () => (await db.query(`SELECT id FROM public.cms_sync_runs WHERE id = ANY ($1::uuid[]) AND purged_at IS NULL`, [ids])).rows.map((x) => x.id).sort()
  let mt = true, gt = 0
  while (mt && gt++ < 20) mt = (await svc(`SELECT public.rpc_cms_sales_run_cleanup($1, 50000) r`, [P7])).rows[0].r.more
  const k1 = await kept()
  ok(JSON.stringify(k1) === JSON.stringify(expectKeep), 'tie-break: cùng finished_at ⇒ giữ 2 run id lớn nhất (finished_at DESC, id DESC)', JSON.stringify({ k1, expectKeep }))
  await svc(`SELECT public.rpc_cms_sales_run_cleanup($1, 50000)`, [P7])
  ok(JSON.stringify(await kept()) === JSON.stringify(k1), 'gọi lại cleanup ⇒ tập giữ không đổi (tất định)')
}
// Trần tuổi 24 h ĐỘC LẬP trần số lượng (db-reviewer r2.2 P1): chương trình chỉ có 2 run error — cả hai trong "2 gần nhất";
// A quá 24 h ⇒ dọn (chỉ luật tuổi), B < 24 h ⇒ giữ. Kèm một run running đang mở ⇒ cleanup không đụng, vẫn kết thúc more = false.
{
  const P8 = await makeProgram(db, { products: [{ product_id: '910112', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '1', tiers: T_ONE }] })
  const openErr = async () => {
    const sp = RS.parseCmsSalesSnapshot((await svc(`SELECT public.rpc_cms_sales_run_open($1) s`, [P8])).rows[0].s)
    await svc(`SELECT public.rpc_cms_sales_run_finish($1, 'error', '{"error_code":"QA_AGE"}'::jsonb)`, [sp.runId])
    return sp.runId
  }
  const A = await openErr(), B = await openErr()
  await db.query(`UPDATE public.cms_sync_runs SET finished_at = now() - interval '25 hours' WHERE id = $1`, [A])
  await db.query(`UPDATE public.cms_sync_runs SET finished_at = now() - interval '23 hours' WHERE id = $1`, [B])
  const Rr = RS.parseCmsSalesSnapshot((await svc(`SELECT public.rpc_cms_sales_run_open($1) s`, [P8])).rows[0].s).runId
  let ma = { more: true }, ga = 0
  while (ma.more && ga++ < 20) ma = (await svc(`SELECT public.rpc_cms_sales_run_cleanup($1, 50000) r`, [P8])).rows[0].r
  const ra = await runRow(db, A), rb = await runRow(db, B), rr = await runRow(db, Rr)
  ok(!ma.more && ra.purged_at !== null && ra.cleared_at !== null && rb.purged_at === null,
     'tuổi > 24 h dù nằm trong 2 run gần nhất ⇒ dọn; run < 24 h ⇒ giữ', JSON.stringify({ ma, ga, a: ra.purged_at, b: rb.purged_at }))
  ok(rr.status === 'running' && rr.purged_at === null && ga <= 2, 'có run running đang mở ⇒ cleanup không đụng run đó và vẫn kết thúc (more = false)', JSON.stringify({ ga }))
  await svc(`SELECT public.rpc_cms_sales_run_finish($1, 'error', '{"error_code":"QA_ABORT"}'::jsonb)`, [Rr])
}

section('12. Rollback')
{
  const d2 = await baseDb()
  const pt = await makeProgram(d2, { isTest: true, products: [{ product_id: '910090', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '1', tiers: T_ONE }] })
  await runOnce(d2, pt, { lines: [C.normalizeSalesRow(rawLine({ pid: '910090', bq: '2', gmv: '2000', at: `${dayFrom(await vnToday(d2))(-1)}T01:00:00.000000Z` })).value] })
  await d2.exec(RB_122)
  ok(!(await one(d2, `SELECT 1 x FROM public.app_migrations WHERE version = '122'`)), 'rollback (chỉ dữ liệu QA): xoá marker 122')
  ok(await count(d2, `SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\\_%' OR proname LIKE 'rpc\\_cms\\_%')`) === 14, 'còn đúng 14 hàm 120 + 121')
  ok(await count(d2, `SELECT count(*) FROM public.cms_sync_runs WHERE kind <> 'products'`) === 0
     && !(await one(d2, `SELECT 1 x FROM information_schema.columns WHERE table_name = 'cms_programs' AND column_name = 'current_result_run_id'`)),
     'run sales đã xoá, cột pointer đã gỡ')
  ok(!(await one(d2, `SELECT 1 x FROM pg_class WHERE relname = 'cms_program_tiers_product_from_idx'`)), 'rollback gỡ index UNIQUE tra bậc')
  // Preflight PM 03/11 §5: bậc trùng mốc (program_product_id, qty_from) ⇒ 122 dừng cả migration, không tự xoá / gộp.
  const t0 = await one(d2, `SELECT program_product_id::text pp, program_id::text pg FROM public.cms_program_tiers WHERE program_id = $1 LIMIT 1`, [pt])
  await d2.query(`INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, qty_to, amount_per_unit)
    VALUES ($1, $2, 2, 1, NULL, 5000)`, [t0.pp, t0.pg])
  ok(await raises(d2, d2.exec(SQL_122), '(program_product_id, qty_from) trùng'), 'bậc trùng mốc ⇒ preflight 122 dừng', lastErr)
  ok(!(await one(d2, `SELECT 1 x FROM public.app_migrations WHERE version = '122'`))
     && await count(d2, `SELECT count(*) FROM public.cms_program_tiers WHERE program_product_id = $1`, [t0.pp]) === 2,
     'preflight dừng: không marker, không đụng dữ liệu bậc (vẫn 2 dòng trùng)')
  await d2.query(`DELETE FROM public.cms_program_tiers WHERE program_product_id = $1 AND tier_order = 2`, [t0.pp])
  await d2.exec(SQL_122)
  ok((await one(d2, `SELECT name FROM public.app_migrations WHERE version = '122'`))?.name === 'cms_results', 'áp lại 122 sau rollback được (preflight kind_check về dạng 120)')
  const ix = await one(d2, `SELECT i.indisunique u, i.indisvalid v, i.indisready r, i.indpred IS NULL np, i.indexprs IS NULL ne,
      i.indnatts na, i.indnkeyatts nk, i.indrelid = 'public.cms_program_tiers'::regclass tb, pg_get_indexdef(i.indexrelid) d FROM pg_index i
    WHERE i.indexrelid = 'public.cms_program_tiers_product_from_idx'::regclass`)
  ok(ix?.u === true && ix?.v === true && ix?.r === true && ix?.np === true && ix?.ne === true && ix?.na === 2 && ix?.nk === 2 && ix?.tb === true
     && /UNIQUE INDEX \S+ ON \S*cms_program_tiers USING btree \(program_product_id, qty_from\)$/.test(ix?.d ?? ''),
     'index tra bậc: UNIQUE, hợp lệ, không partial / biểu thức / INCLUDE, đúng 2 cột (program_product_id, qty_from)', JSON.stringify(ix))
  ok(await raises(d2, d2.query(`INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, qty_to, amount_per_unit)
    VALUES ($1, $2, 2, 1, NULL, 5000)`, [t0.pp, t0.pg]), 'cms_program_tiers_product_from_idx'), 'sau 122: chèn bậc trùng mốc ⇒ vi phạm UNIQUE', lastErr)
  const real = await makeProgram(d2, { products: [{ product_id: '910091', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '1', tiers: T_ONE }] })
  await svcOf(d2)(`SELECT public.rpc_cms_sales_run_open($1)`, [real])
  ok(await raises(d2, d2.exec(RB_122), 'đã có run sales của chương trình thật'), 'có run sales của chương trình thật ⇒ rollback từ chối')
}

console.log(`\n${pass} đạt · ${fail} lỗi`)
process.exit(fail ? 1 : 0)
